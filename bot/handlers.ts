// Message → action routing. Everything here takes its collaborators as
// arguments (`Deps`) rather than importing a singleton client: that is
// **dependency injection**, and it is what lets the whole routing table be
// exercised against a local stub server with no Telegram token and no
// database — the same seam Tennis-Bot's `poll_once(fetch, send, …)` uses.

import { MiseApi, MiseApiError } from "./api";
import * as F from "./format";
import type { LogFields } from "./format";
import { TelegramClient, TelegramError, type TgMessage, type TgUpdate } from "./telegram";

// ─────────────────────────────────────────────────────────────────────────────
// The message → job map (PRD F4, the manual-caption fallback)
// ─────────────────────────────────────────────────────────────────────────────

export type PendingImport = { jobId: string; url: string; failedAt: number };

/**
 * Bounded LRU of `telegram message_id → the import that failed in it`.
 *
 * **This is in memory on purpose, and a restart loses it.** The alternative is
 * a `BotMessage` table in SQLite, which would survive restarts — but it adds a
 * migration, a second writer path into the database from a container that is
 * meant to hold no state (ARCHITECTURE §1: "mise-bot is a dumb transport"), and
 * cleanup logic. The cost of losing it is one reply of "I've lost track of that
 * import, send the link again" after a redeploy, for a single user who imports
 * a few times a day. That trade is deliberate, not an oversight — if it starts
 * to bite, the fix is to look the mapping up server-side by `messageId`, which
 * `POST /api/imports` already stores.
 *
 * LRU because a `Map` in JS iterates in insertion order: re-inserting on read
 * moves an entry to the back, so the *least recently used* is always first.
 */
export class PendingImports {
  private readonly map = new Map<number, PendingImport>();

  constructor(private readonly max = 200) {}

  set(messageId: number, value: PendingImport): void {
    this.map.delete(messageId);
    this.map.set(messageId, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  get(messageId: number): PendingImport | undefined {
    const hit = this.map.get(messageId);
    if (hit) {
      this.map.delete(messageId);
      this.map.set(messageId, hit);
    }
    return hit;
  }

  delete(messageId: number): void {
    this.map.delete(messageId);
  }

  get size(): number {
    return this.map.size;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export type Deps = {
  tg: TelegramClient;
  api: MiseApi;
  /** The ONLY chat whose messages are acted on. */
  chatId: string;
  /** Base URL the phone can reach, for "open in Mise" links. */
  publicBase: string;
  pending: PendingImports;
  log: (event: string, fields?: LogFields) => void;
  /** How often to poll `GET /api/imports/:id` (API_SPEC §2 uses 1.5 s). */
  pollIntervalMs?: number;
  /** Give up waiting for an import after this long. */
  pollBudgetMs?: number;
  /** Aborted on SIGTERM so a long import doesn't hold up shutdown. */
  signal?: AbortSignal;
};

const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_POLL_BUDGET_MS = 180_000;
/** Consecutive failed polls before we stop and tell the user. */
const MAX_POLL_ERRORS = 5;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point — one update
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle exactly one update. **Never throws**: the caller advances the polling
 * offset once this returns, so an exception escaping here would make Telegram
 * redeliver the same bad update forever — a poison message, which under
 * `restart: unless-stopped` is an infinite loop. Same guard as Tennis-Bot's
 * `process_update()`.
 */
export async function handleUpdate(update: TgUpdate, deps: Deps): Promise<void> {
  try {
    await route(update, deps);
  } catch (e) {
    deps.log("update.failed", {
      update: update.update_id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

async function route(update: TgUpdate, deps: Deps): Promise<void> {
  // Act on plain `message` only. An `edited_message` re-imports nothing (the
  // original already ran) and a `channel_post` is not a conversation — both are
  // dropped without a reply, and neither can authorise anything.
  const msg = update.message;
  if (!msg) {
    deps.log("update.ignored", { update: update.update_id, reason: "not_a_message" });
    return;
  }

  const text = (msg.text ?? msg.caption ?? "").trim();
  const entities = msg.text ? msg.entities : msg.caption_entities;
  const chatId = msg.chat.id;
  const cmd = F.parseCommand(text);

  // `/id` is the SOLE exception to the allowlist: without it there is no way to
  // discover the chat id needed to fill TELEGRAM_CHAT_ID in the first place.
  // It leaks nothing the caller doesn't already know (their own chat id).
  if (cmd?.command === "/id") {
    deps.log("cmd.id", { chat: chatId });
    await deps.tg.sendMessage(chatId, F.chatIdText(chatId));
    return;
  }

  // Everything else from a non-allowlisted chat is dropped in SILENCE — not
  // refused. A "you're not allowed" reply confirms to a stranger probing the
  // token that a live bot is here; silence is indistinguishable from a dead
  // token. (Tennis-Bot makes the same call in `telegram_commands.py`.)
  if (String(chatId) !== String(deps.chatId)) {
    deps.log("update.dropped", {
      update: update.update_id,
      chat: chatId,
      reason: "chat_not_allowed",
    });
    return;
  }

  if (cmd) {
    await handleCommand(cmd.command, cmd.args, msg, deps);
    return;
  }

  if (!text) {
    deps.log("update.ignored", { update: update.update_id, reason: "no_text" });
    return;
  }

  // PRD F4 — a plain-text reply to a failed import message re-runs it with that
  // text as the source. Checked BEFORE URL extraction, because a pasted caption
  // very often contains links of its own and those must not start a new import.
  const repliedTo = msg.reply_to_message;
  if (repliedTo?.from?.is_bot) {
    const prior = deps.pending.get(repliedTo.message_id);
    if (prior) {
      deps.log("retry.with_text", {
        job: prior.jobId,
        url: prior.url,
        chars: text.length,
      });
      deps.pending.delete(repliedTo.message_id);
      await runImport(deps, { url: prior.url, text, replyTo: msg.message_id });
      return;
    }
  }

  const urls = F.extractUrls(text, entities);
  if (urls.length > 0) {
    if (urls.length > 1) {
      deps.log("url.extra_ignored", { count: urls.length - 1, using: urls[0] });
    }
    await runImport(deps, { url: urls[0], replyTo: msg.message_id });
    return;
  }

  if (repliedTo?.from?.is_bot) {
    await deps.tg.sendMessage(chatId, F.LOST_CONTEXT);
    return;
  }

  deps.log("update.no_action", { update: update.update_id });
  await deps.tg.sendMessage(chatId, F.NUDGE);
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands (API_SPEC §7)
// ─────────────────────────────────────────────────────────────────────────────

async function handleCommand(
  command: string,
  args: string,
  msg: TgMessage,
  deps: Deps,
): Promise<void> {
  const chatId = msg.chat.id;
  const url = (id: string) => F.recipeUrl(deps.publicBase, id);

  switch (command) {
    case "/start":
      deps.log("cmd.start");
      await deps.tg.sendMessage(chatId, F.START);
      return;

    case "/help":
      deps.log("cmd.help");
      await deps.tg.sendMessage(chatId, F.HELP);
      return;

    case "/list": {
      deps.log("cmd.list");
      try {
        const recipes = await deps.api.listRecipes(5);
        await deps.tg.sendMessage(chatId, F.listText(recipes, url));
      } catch (e) {
        deps.log("cmd.list.failed", { error: errText(e) });
        await deps.tg.sendMessage(chatId, F.API_DOWN);
      }
      return;
    }

    case "/find": {
      if (!args) {
        await deps.tg.sendMessage(chatId, F.FIND_USAGE);
        return;
      }
      deps.log("cmd.find", { q: args });
      try {
        const recipes = await deps.api.searchRecipes(args, 5);
        deps.log("cmd.find.done", { q: args, hits: recipes.length });
        await deps.tg.sendMessage(chatId, F.findText(args, recipes, url));
      } catch (e) {
        deps.log("cmd.find.failed", { error: errText(e) });
        await deps.tg.sendMessage(chatId, F.API_DOWN);
      }
      return;
    }

    default:
      deps.log("cmd.unknown", { command });
      await deps.tg.sendMessage(chatId, `🤷 I don't know <code>${F.escapeHtml(command)}</code>. Try /help.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The import flow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send `⏳ Importing…`, enqueue, then EDIT that same message with the outcome.
 *
 * Editing rather than sending a follow-up is the difference between 10 messages
 * and 30 for a batch of 10 imports, and it keeps the outcome anchored to the
 * link the user sent. It is also why the progress message must be sent *before*
 * the POST: its `message_id` is what the job is told to report back to, and
 * what we hold on to for the retry mapping.
 */
async function runImport(
  deps: Deps,
  input: { url: string; text?: string; replyTo?: number },
): Promise<void> {
  const progressId = await deps.tg.sendMessage(deps.chatId, F.IMPORTING, {
    replyToMessageId: input.replyTo,
  });

  let result;
  try {
    result = await deps.api.createImport({
      url: input.url,
      chatId: deps.chatId,
      messageId: progressId,
      text: input.text,
    });
  } catch (e) {
    deps.log("import.enqueue_failed", { url: input.url, error: errText(e) });
    const msg =
      e instanceof MiseApiError && e.status !== null && e.code
        ? F.failedText(e.message, false)
        : F.API_DOWN;
    await settle(deps, progressId, msg, null);
    return;
  }

  if (result.kind === "duplicate") {
    deps.log("import.duplicate", { url: input.url, recipe: result.recipeId ?? "unknown" });
    let title: string | null = null;
    if (result.recipeId) {
      // Best effort: the 409 envelope carries only the id, and a title-less
      // "Already saved" is still a correct answer if this lookup fails.
      try {
        title = (await deps.api.getRecipe(result.recipeId)).title;
      } catch (e) {
        deps.log("import.duplicate.title_failed", { error: errText(e) });
      }
    }
    const href = result.recipeId
      ? F.recipeUrl(deps.publicBase, result.recipeId)
      : deps.publicBase;
    await settle(deps, progressId, F.duplicateText(title, href), null);
    return;
  }

  deps.log("import.enqueued", { job: result.id, url: input.url, msg: progressId });
  await pollJob(deps, result.id, progressId, input.url);
}

/** Poll `GET /api/imports/:id` until it reaches a terminal state. */
async function pollJob(
  deps: Deps,
  jobId: string,
  progressId: number,
  url: string,
): Promise<void> {
  const interval = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const budget = deps.pollBudgetMs ?? DEFAULT_POLL_BUDGET_MS;
  const startedAt = Date.now();
  let lastStage: string | null = null;
  let errors = 0;

  while (Date.now() - startedAt < budget) {
    if (deps.signal?.aborted) {
      // Shutting down. The job itself keeps running server-side — the web app
      // will have the recipe — so say so and let the process exit promptly
      // instead of holding SIGTERM open for minutes.
      deps.log("import.abandoned", { job: jobId, reason: "shutdown" });
      await settle(deps, progressId, F.TIMED_OUT, null);
      return;
    }

    await sleep(interval, deps.signal);

    let job;
    try {
      job = await deps.api.getImport(jobId);
      errors = 0;
    } catch (e) {
      errors += 1;
      deps.log("import.poll_failed", { job: jobId, attempt: errors, error: errText(e) });
      if (errors >= MAX_POLL_ERRORS) {
        await settle(deps, progressId, F.API_DOWN, null);
        return;
      }
      continue;
    }

    if (job.status === "pending" || job.status === "running") {
      // Only edit when the stage actually changes: an unchanged edit is a 400
      // from Telegram and, at 1.5 s intervals, would be ~120 pointless API
      // calls per import.
      if (job.stage && job.stage !== lastStage) {
        lastStage = job.stage;
        deps.log("import.stage", { job: jobId, stage: job.stage });
        try {
          await deps.tg.editMessageText(deps.chatId, progressId, F.progressText(job.stage));
        } catch (e) {
          deps.log("import.stage_edit_failed", { job: jobId, error: errText(e) });
        }
      }
      continue;
    }

    if (job.status === "done") {
      let recipe = job.recipe ?? null;
      if (!recipe && job.recipeId) {
        try {
          recipe = await deps.api.getRecipe(job.recipeId);
        } catch (e) {
          deps.log("import.recipe_fetch_failed", { job: jobId, error: errText(e) });
        }
      }
      if (!recipe) {
        deps.log("import.done_without_recipe", { job: jobId });
        await settle(deps, progressId, F.API_DOWN, null);
        return;
      }
      deps.log("import.done", {
        job: jobId,
        recipe: recipe.id,
        title: recipe.title,
        ingredients: recipe.ingredients.length,
        steps: recipe.steps.length,
        ms: Date.now() - startedAt,
      });
      await settle(
        deps,
        progressId,
        F.doneText(recipe, F.recipeUrl(deps.publicBase, recipe.id)),
        null,
      );
      return;
    }

    if (job.status === "not_recipe") {
      deps.log("import.not_recipe", { job: jobId, url });
      await settle(deps, progressId, F.NOT_RECIPE, { jobId, url, failedAt: Date.now() });
      return;
    }

    if (job.status === "failed") {
      deps.log("import.failed", { job: jobId, url, error: job.error ?? "unknown" });
      await settle(
        deps,
        progressId,
        F.failedText(job.error, job.canRetryWithText),
        job.canRetryWithText ? { jobId, url, failedAt: Date.now() } : null,
      );
      return;
    }

    deps.log("import.unknown_status", { job: jobId, status: String(job.status) });
    return;
  }

  deps.log("import.timeout", { job: jobId, url, budgetMs: budget });
  await settle(deps, progressId, F.TIMED_OUT, null);
}

/**
 * Write the final text into the progress message and, if the outcome is
 * retryable, remember which message maps to which job.
 *
 * Falls back to a NEW message if the edit fails — Telegram refuses edits to
 * messages older than 48 h and to messages it thinks are unchanged, and losing
 * the outcome entirely would be worse than an extra message in the chat.
 */
async function settle(
  deps: Deps,
  messageId: number,
  text: string,
  retry: PendingImport | null,
): Promise<void> {
  try {
    await deps.tg.editMessageText(deps.chatId, messageId, text);
    if (retry) deps.pending.set(messageId, retry);
    return;
  } catch (e) {
    deps.log("outcome.edit_failed", {
      msg: messageId,
      error: e instanceof TelegramError ? e.message : errText(e),
    });
  }
  try {
    const sent = await deps.tg.sendMessage(deps.chatId, text);
    if (retry) deps.pending.set(sent, retry);
  } catch (e) {
    deps.log("outcome.send_failed", { msg: messageId, error: errText(e) });
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
