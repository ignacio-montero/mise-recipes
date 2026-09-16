// A paper-thin Telegram Bot API client: three methods, plain `fetch`, no deps.
// The Bot API is just HTTP POST + JSON, so a library would buy us nothing but a
// supply-chain surface (ARCHITECTURE §2's instinct: don't add a container/dep
// for something that is 80 lines).
//
// This module owns exactly ONE concern: turning HTTP outcomes into typed
// errors. It makes no decisions about what to do with them — the loop in
// index.ts does. That split is what makes "409 means another poller" a single
// obvious branch instead of a string match buried in the loop.

import { redact, type TgEntity } from "./format";

export const DEFAULT_API_BASE = "https://api.telegram.org";

// ─────────────────────────────────────────────────────────────────────────────
// Wire types — only the fields we actually read
// ─────────────────────────────────────────────────────────────────────────────

export type TgChat = { id: number; type: string; username?: string };

export type TgMessage = {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: { id: number; is_bot: boolean; username?: string };
  text?: string;
  caption?: string;
  entities?: TgEntity[];
  caption_entities?: TgEntity[];
  reply_to_message?: TgMessage;
};

export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
};

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `kind` is the whole point of this class — it is the loop's decision table:
 *
 * - `conflict`   HTTP 409. Another process is long-polling this token. LOUD log,
 *                hard back-off; retrying fast makes it worse for both bots.
 * - `fatal`      401/404. A bad/revoked token never becomes good by retrying;
 *                the process should die loudly rather than look healthy.
 * - `rate_limited` 429, carries `retryAfterSec` from Telegram's own hint.
 * - `transient`  5xx, timeouts, DNS, connection resets — back off and continue.
 */
export type TelegramErrorKind = "conflict" | "fatal" | "rate_limited" | "transient";

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly kind: TelegramErrorKind,
    readonly status: number | null = null,
    readonly retryAfterSec: number | null = null,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

type ApiEnvelope<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
};

export type TelegramClientOptions = {
  token: string;
  /** Overridable so tests can point at a local stub — see DEPLOY/handover note. */
  apiBase?: string;
  /** Seconds Telegram holds the getUpdates connection open. */
  pollTimeoutSec?: number;
};

export class TelegramClient {
  private readonly token: string;
  private readonly base: string;
  readonly pollTimeoutSec: number;

  constructor(opts: TelegramClientOptions) {
    this.token = opts.token;
    this.base = `${(opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "")}/bot${opts.token}`;
    this.pollTimeoutSec = opts.pollTimeoutSec ?? 30;
  }

  /** Strip the token out of anything before it can reach a log line. */
  private safe(text: string): string {
    return redact(text, [this.token]);
  }

  private async call<T>(
    method: string,
    body: Record<string, unknown>,
    { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<T> {
    // Two independent reasons to abort — our own deadline and the shutdown
    // signal — combined into one. `AbortSignal.any` is the native way to do
    // this (Node 20+); the alternative is hand-rolled listener bookkeeping.
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([deadline, signal]) : deadline;

    let res: Response;
    try {
      res = await fetch(`${this.base}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (e) {
      // A caller-requested abort is not an error condition; re-throw it raw so
      // the loop can tell "we are shutting down" from "the network broke".
      if (signal?.aborted) throw e;
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      throw new TelegramError(`${method} network failure — ${this.safe(msg)}`, "transient");
    }

    let payload: ApiEnvelope<T> | null = null;
    try {
      payload = (await res.json()) as ApiEnvelope<T>;
    } catch {
      payload = null; // Cloudflare/proxy HTML error pages are not JSON.
    }

    if (!res.ok || !payload?.ok) {
      const description = this.safe(payload?.description ?? `HTTP ${res.status}`);
      const retryAfter = payload?.parameters?.retry_after ?? null;
      throw new TelegramError(
        `${method} failed (HTTP ${res.status}): ${description}`,
        classify(res.status),
        res.status,
        retryAfter,
      );
    }

    return payload.result as T;
  }

  /**
   * `getMe` — a cheap startup probe. It costs one request and answers two
   * questions that otherwise only surface as confusing runtime behaviour: is
   * this token valid at all, and *which bot* is it? Logging the username at
   * boot is the fastest way to catch "I pasted the wrong bot's token", which is
   * the precondition for the 409 war below.
   */
  async getMe(): Promise<{ id: number; username?: string; first_name?: string }> {
    return this.call<{ id: number; username?: string; first_name?: string }>(
      "getMe",
      {},
      { timeoutMs: 10_000 },
    );
  }

  /**
   * Long-poll for updates.
   *
   * `timeout=30` asks Telegram to HOLD the connection open until an update
   * arrives (or 30 s pass) — one round-trip instead of a busy-poll, which is
   * why the HTTP deadline must be comfortably *above* the poll timeout or we
   * would abort our own healthy connection every cycle.
   *
   * `offset` acknowledges every update below it; `allowed_updates` keeps
   * Telegram from sending us edits/reactions we would only drop anyway.
   */
  async getUpdates(offset: number | null, signal?: AbortSignal): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>(
      "getUpdates",
      {
        timeout: this.pollTimeoutSec,
        ...(offset === null ? {} : { offset }),
        allowed_updates: ["message"],
      },
      { timeoutMs: (this.pollTimeoutSec + 15) * 1000, signal },
    );
  }

  /** Returns the new message's `message_id` — the handle we later edit. */
  async sendMessage(
    chatId: number | string,
    text: string,
    opts: { replyToMessageId?: number } = {},
  ): Promise<number> {
    const msg = await this.call<TgMessage>(
      "sendMessage",
      {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(opts.replyToMessageId
          ? { reply_parameters: { message_id: opts.replyToMessageId, allow_sending_without_reply: true } }
          : {}),
      },
      { timeoutMs: 15_000 },
    );
    return msg.message_id;
  }

  /**
   * Edit a message we sent earlier. `false` means Telegram considered the text
   * unchanged — that is a 400 in the API but a no-op for us, and treating it as
   * an error would turn "nothing to update" into a spurious log every poll.
   */
  async editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
  ): Promise<boolean> {
    try {
      await this.call<TgMessage | boolean>(
        "editMessageText",
        {
          chat_id: chatId,
          message_id: messageId,
          text,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        },
        { timeoutMs: 15_000 },
      );
      return true;
    } catch (e) {
      if (e instanceof TelegramError && /message is not modified/i.test(e.message)) {
        return false;
      }
      throw e;
    }
  }
}

function classify(status: number): TelegramErrorKind {
  if (status === 409) return "conflict";
  if (status === 401 || status === 404) return "fatal";
  if (status === 429) return "rate_limited";
  return "transient";
}

/** The message that has to survive a 3 a.m. debugging session. */
export const CONFLICT_BANNER = [
  "",
  "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
  "  TELEGRAM 409 CONFLICT — ANOTHER PROCESS IS ALREADY POLLING THIS BOT TOKEN.",
  "",
  "  Only ONE process may call getUpdates for a given token. Two pollers steal",
  "  each other's updates, so BOTH bots break intermittently and neither logs",
  "  anything obviously wrong.",
  "",
  "  Almost certainly: TELEGRAM_BOT_TOKEN here is the TENNIS BOT's token, which",
  "  `tennisbot-prefs` already long-polls on this box. Mise needs its OWN token",
  "  from @BotFather (/newbot). See docs/PRD.md OQ-1 and DECISIONS D-003.",
  "",
  "  Other causes: a second mise-bot container, a stale local `npm run bot`,",
  "  or a webhook registered on this token (call deleteWebhook).",
  "",
  "  Backing off hard. Fix the token; nothing will work until you do.",
  "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
  "",
].join("\n");
