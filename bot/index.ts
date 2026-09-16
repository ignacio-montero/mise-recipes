// mise-bot — the ingest transport (PRD F5, API_SPEC §7).
//
// A standalone Node process, NOT part of Next.js: it binds no port, serves no
// request, and holds no database handle. It long-polls Telegram and turns
// messages into calls against mise-web's HTTP API (ARCHITECTURE §1).
//
// Run: `npm run bot` (tsx bot/index.ts). Env must already be in the
// environment — tsx does not read `.env` by itself. Locally:
//     set -a; source .env; set +a; npm run bot
// In the container, compose supplies the variables.
//
// Layering, deliberately: this file is the ONLY one that reads configuration,
// opens the loop, and owns process lifetime. `telegram.ts` classifies HTTP
// outcomes but decides nothing; `handlers.ts` decides but knows nothing about
// retries or signals; `format.ts` is pure. Each layer is testable without the
// one above it.

import { config } from "../lib/config";
import { MiseApi } from "./api";
import { logLine, type LogFields } from "./format";
import { handleUpdate, PendingImports, type Deps } from "./handlers";
import { CONFLICT_BANNER, DEFAULT_API_BASE, TelegramClient, TelegramError } from "./telegram";

const log = (event: string, fields: LogFields = {}) => console.log(logLine(event, fields));
const logErr = (event: string, fields: LogFields = {}) => console.error(logLine(event, fields));

const POLL_TIMEOUT_SEC = 30;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
/** A 409 is a configuration error, not a blip: wait minutes, not seconds. */
const CONFLICT_BACKOFF_MS = 60_000;

/**
 * **Exponential backoff with equal jitter.** Doubling alone would have every
 * retry land at the same instant after a shared outage (the "thundering herd");
 * the jitter spreads them. Capped, because an unbounded backoff means a bot
 * that is technically alive but effectively deaf for an hour.
 */
export function backoffMs(attempt: number, baseMs = BACKOFF_BASE_MS, capMs = BACKOFF_CAP_MS): number {
  const window = Math.min(capMs, baseMs * 2 ** Math.min(attempt, 20));
  return Math.round(window / 2 + Math.random() * (window / 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fail CLOSED on configuration.
 *
 * A bot missing `TELEGRAM_CHAT_ID` would authorise nobody and silently do
 * nothing while looking perfectly healthy in `docker ps` — the worst failure
 * mode there is, because nothing ever alerts. Refusing to start turns it into a
 * restart loop with an obvious log line. (Same reasoning as Tennis-Bot's
 * `resolve_credentials()`.)
 */
export function missingConfig(): string[] {
  const missing: string[] = [];
  if (!config.telegram.botToken) missing.push("TELEGRAM_BOT_TOKEN");
  if (!config.telegram.chatId) missing.push("TELEGRAM_CHAT_ID");
  if (!config.ingestToken) missing.push("OSTA_INGEST_TOKEN");
  return missing;
}

async function main(): Promise<void> {
  const missing = missingConfig();
  if (missing.length > 0) {
    logErr("config.invalid", { missing: missing.join(",") });
    console.error(
      `\n[bot] Refusing to start: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set.\n` +
        `      A half-configured bot looks healthy and does nothing. Set them in the\n` +
        `      environment (.env on the server) and restart. See .env.example.\n`,
    );
    process.exit(1);
  }

  // A test seam: pointing the Bot API at a local stub is the only way to
  // exercise the polling loop without a real token (borrowing another bot's
  // token would start exactly the 409 war this file warns about). Read via
  // lib/config.ts (`TELEGRAM_API_BASE`) so nothing here touches process.env.
  const apiBase = config.telegram.apiBase || DEFAULT_API_BASE;

  const tg = new TelegramClient({
    token: config.telegram.botToken,
    apiBase,
    pollTimeoutSec: POLL_TIMEOUT_SEC,
  });
  const api = new MiseApi({
    baseUrl: config.apiBase,
    ingestToken: config.ingestToken,
  });

  const abort = new AbortController();
  const deps: Deps = {
    tg,
    api,
    chatId: config.telegram.chatId,
    publicBase: config.publicBase,
    pending: new PendingImports(),
    log,
    signal: abort.signal,
  };

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) {
      logErr("shutdown.forced", { signal });
      process.exit(1); // second signal: the operator is impatient, oblige.
    }
    stopping = true;
    log("shutdown.requested", { signal });
    // Aborts the idle long-poll immediately (no update is lost: we simply never
    // ack it, so Telegram redelivers on the next boot) and tells any in-flight
    // import poll to stop waiting.
    abort.abort();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log("starting", {
    chat: config.telegram.chatId,
    api: config.apiBase,
    public: config.publicBase,
    telegram: apiBase,
    pollTimeout: POLL_TIMEOUT_SEC,
  });

  try {
    const me = await tg.getMe();
    log("identity", { bot: me.username ?? me.first_name ?? String(me.id), id: me.id });
  } catch (e) {
    if (e instanceof TelegramError && e.kind === "fatal") {
      logErr("identity.rejected", { error: e.message });
      console.error(
        "\n[bot] Telegram rejected TELEGRAM_BOT_TOKEN (401/404). Check the value\n" +
          "      against @BotFather. Refusing to spin uselessly.\n",
      );
      process.exit(1);
    }
    // Anything else (DNS not up yet on a cold boot, transient 5xx) is not worth
    // refusing to start over — the poll loop retries with backoff anyway.
    log("identity.unknown", { error: e instanceof Error ? e.message : String(e) });
  }

  let offset: number | null = null;
  let failures = 0;
  let conflicts = 0;

  while (!stopping) {
    let updates;
    try {
      updates = await tg.getUpdates(offset, abort.signal);
      failures = 0;
      conflicts = 0;
    } catch (e) {
      if (stopping) break; // the abort above, not a real failure

      if (e instanceof TelegramError && e.kind === "conflict") {
        conflicts += 1;
        console.error(CONFLICT_BANNER);
        logErr("telegram.conflict", { occurrences: conflicts, backoffMs: CONFLICT_BACKOFF_MS });
        await sleep(CONFLICT_BACKOFF_MS);
        continue;
      }

      if (e instanceof TelegramError && e.kind === "fatal") {
        // A bad token cannot become good by retrying; stop loudly so the
        // container's restart policy surfaces it instead of a healthy-looking
        // process that receives nothing forever.
        logErr("telegram.fatal", { error: e.message });
        process.exitCode = 1;
        break;
      }

      if (e instanceof TelegramError && e.kind === "rate_limited") {
        const wait = ((e.retryAfterSec ?? 5) + 1) * 1000;
        logErr("telegram.rate_limited", { retryAfterMs: wait });
        await sleep(wait);
        continue;
      }

      failures += 1;
      const wait = backoffMs(failures);
      logErr("telegram.poll_failed", {
        attempt: failures,
        backoffMs: wait,
        error: e instanceof Error ? e.message : String(e),
      });
      await sleep(wait);
      continue;
    }

    if (updates.length > 0) log("poll.batch", { updates: updates.length });

    for (const update of updates) {
      await handleUpdate(update, deps);
      // Ack ONLY after the update has been handled. `max` rather than
      // last-wins so a malformed update can't drag the offset backwards and
      // cause redelivery of work already done. handleUpdate never throws, so a
      // handled *failure* still advances (no poison-message loop) while a real
      // crash replays the update on the next boot — at-least-once delivery.
      offset = Math.max(offset ?? 0, update.update_id + 1);
      if (stopping) break; // finish the current update, then stop
    }
  }

  log("stopped", { offset: offset ?? 0, pending: deps.pending.size });
}

main().catch((e) => {
  logErr("crashed", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
