// Every string the bot produces — user-facing replies AND log lines — lives
// here as a PURE function. Nothing in this file opens a socket, reads the clock
// or touches process.env, so all of it is unit-testable with `node`/`tsx` and
// no Telegram token. Same split as Tennis-Bot's `telegram_commands.py` (pure
// render) vs `telegram_poll.py` (the I/O shell).
//
// Parse mode: **HTML**, everywhere, deliberately. API_SPEC §7 writes the
// outcome strings in Markdown (`*Title*`), but Telegram's legacy Markdown has
// no escape mechanism you can rely on: a recipe titled "Mum's *secret* pasta"
// or "Chicken_Tikka" makes the API return 400 and the message is silently LOST.
// HTML has exactly three characters to escape and Telegram documents them. The
// rendering is identical (bold title); only the markup differs. See the
// deviation note in the handover.

import type { ImportJobDTO, RecipeDTO } from "../lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// Escaping — the boundary where user/LLM text becomes markup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Escape text before it is interpolated into an HTML-parse-mode message.
 *
 * Telegram's HTML mode only defines `&`, `<` and `>` as needing escapes in
 * text nodes. `&` MUST go first, otherwise we would double-escape the `&` we
 * just emitted for `<`.
 *
 * This is an *encoding* step at the render boundary, not validation upstream:
 * the title comes out of an LLM reading an Instagram caption, so there is no
 * upstream that can be trusted to have sanitised it.
 */
export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Escape text going into an `href="…"` attribute (adds the quote char). */
export function escapeAttr(s: string): string {
  return escapeHtml(s).replaceAll('"', "&quot;");
}

/** `<a href="…">…</a>` with both halves escaped. */
export function link(url: string, label: string): string {
  return `<a href="${escapeAttr(url)}">${escapeHtml(label)}</a>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// URL extraction
// ─────────────────────────────────────────────────────────────────────────────

export type TgEntity = {
  type: string;
  offset: number;
  length: number;
  url?: string;
};

// Trailing punctuation a human types after a link ("…C9dO9AevUQx/." or
// "(https://x/)") that is never part of the URL.
const TRAILING_JUNK = /[),.;:!?'"»”]+$/;
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

/**
 * URLs in a message, in order, de-duplicated.
 *
 * Prefers Telegram's own `entities` — Telegram already parsed the message and
 * tells us exactly which spans are links, including `text_link` (a hyperlink
 * whose visible text is not a URL at all, which no regex could ever find).
 * The regex is only the fallback for the rare update that arrives without
 * entities.
 *
 * Note on offsets: Telegram entity `offset`/`length` are counted in **UTF-16
 * code units**, which is exactly what a JavaScript string index is — so
 * `slice()` is correct as-is. (Python has to convert; we get it for free. An
 * emoji before the link is 2 units in both systems.)
 */
export function extractUrls(text: string, entities?: TgEntity[]): string[] {
  const out: string[] = [];
  const push = (raw: string | undefined) => {
    if (!raw) return;
    // `split(/\s/)[0]` is belt-and-braces: a well-formed entity span never
    // contains whitespace, but a malformed update must not turn into a URL
    // with a space in it.
    const u = raw.trim().split(/\s/)[0].replace(TRAILING_JUNK, "");
    if (!/^https?:\/\//i.test(u)) return;
    if (!out.includes(u)) out.push(u);
  };

  const linkish = (entities ?? []).filter(
    (e) => e.type === "url" || e.type === "text_link",
  );
  if (linkish.length > 0) {
    for (const e of linkish) {
      if (e.type === "text_link") push(e.url);
      else push(text.slice(e.offset, e.offset + e.length));
    }
    if (out.length > 0) return out;
  }

  for (const m of text.matchAll(URL_RE)) push(m[0]);
  return out;
}

/** `/find@mise_bot spicy` → `{ command: "/find", args: "spicy" }`. */
export function parseCommand(
  text: string,
): { command: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [head, ...rest] = trimmed.split(/\s+/);
  // Telegram appends `@botname` to commands in groups; strip it.
  const command = head.split("@", 1)[0].toLowerCase();
  return { command, args: rest.join(" ").trim() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Structured logging (logfmt) — pure renderer + thin console sink
// ─────────────────────────────────────────────────────────────────────────────

export type LogFields = Record<string, string | number | boolean | null | undefined>;

/**
 * `logLine("import.enqueued", { job: "abc", url: "…" })`
 *   → `[bot] import.enqueued job=abc url=…`
 *
 * This is **logfmt**: one line, one event, `key=value` pairs. It greps
 * trivially (`docker logs mise-bot | grep import.failed`) and still parses
 * into fields if the logs ever reach a collector. Same shape as Tennis-Bot's
 * structlog output, deliberately — one mental model for both bots on the box.
 */
export function logLine(event: string, fields: LogFields = {}): string {
  const parts = [`[bot]`, event];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    const s = String(v);
    parts.push(`${k}=${/[\s"=]/.test(s) ? JSON.stringify(s) : s}`);
  }
  return parts.join(" ");
}

/**
 * Remove secrets from a string before it is logged.
 *
 * The Bot API puts the token in the request *path* (`…/bot<TOKEN>/getUpdates`),
 * so a naive `console.error(err)` on a fetch failure prints the token straight
 * into `docker logs` (CWE-532). Tennis-Bot rotated a token once for exactly
 * this. Everything logged by this bot goes through here.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.replaceAll(s, "***");
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// User-facing messages (API_SPEC §7)
// ─────────────────────────────────────────────────────────────────────────────

export const IMPORTING = "⏳ Importing…";

/** Live progress while the job runs. Only ever sent as an *edit*. */
export function progressText(stage: ImportJobDTO["stage"]): string {
  switch (stage) {
    case "fetching":
      return "⏳ Fetching the post…";
    case "transcribing":
      return "🎧 Listening to the audio…";
    case "structuring":
      return "🧠 Writing the recipe…";
    default:
      return IMPORTING;
  }
}

export const START = [
  "👋 <b>Mise</b> — send me a Reel, TikTok or recipe link and I'll save it.",
  "",
  "Share a post from Instagram or TikTok straight into this chat. I'll reply",
  "with the recipe as soon as it's extracted.",
  "",
  "/help for everything I can do.",
].join("\n");

export const HELP = [
  "🍳 <b>Mise</b> — command reference",
  "",
  "<b>Saving</b>",
  "Send any link (Instagram, TikTok, YouTube, a recipe site) — I import it and",
  "edit my own reply with the result.",
  "Reply to a failed import with the caption text and I'll try again with that.",
  "",
  "<b>Finding</b>",
  "/list — the last 5 recipes",
  "/find shrimp tacos — top 5 matches",
  "",
  "<b>Setup</b>",
  "/id — this chat's id",
  "/help — this reference",
].join("\n");

export function chatIdText(chatId: number | string): string {
  return [
    `🪪 This chat id is <code>${escapeHtml(String(chatId))}</code>`,
    "Put it in <code>TELEGRAM_CHAT_ID</code> to let this chat use the bot.",
  ].join("\n");
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `✅ <b>Crispy Shrimp Tacos</b>\n9 ingredients · 9 steps · 6-8 tacos\n<link>` */
export function doneText(recipe: RecipeDTO, recipeUrl: string): string {
  const facts = [
    plural(recipe.ingredients.length, "ingredient"),
    plural(recipe.steps.length, "step"),
  ];
  if (recipe.servings) facts.push(recipe.servings);
  return [
    `✅ <b>${escapeHtml(recipe.title)}</b>`,
    escapeHtml(facts.join(" · ")),
    link(recipeUrl, "Open in Mise"),
  ].join("\n");
}

export const NOT_RECIPE =
  "🤔 That didn't look like a recipe. Reply with the caption text and I'll try again.";

/** `⚠️ <reason> Reply with the caption text and I'll try again.` */
export function failedText(error: string | null, canRetryWithText: boolean): string {
  const reason = (error ?? "").trim() || "Import failed.";
  const head = `⚠️ ${escapeHtml(reason.endsWith(".") ? reason : `${reason}.`)}`;
  return canRetryWithText
    ? `${head} Reply with the caption text and I'll try again.`
    : head;
}

/** `📖 Already saved: <b>Crispy Shrimp Tacos</b> <link>` */
export function duplicateText(title: string | null, recipeUrl: string): string {
  const name = title ? ` <b>${escapeHtml(title)}</b>` : "";
  return `📖 Already saved:${name} ${link(recipeUrl, "Open in Mise")}`;
}

export function listText(recipes: RecipeDTO[], recipeUrl: (id: string) => string): string {
  if (recipes.length === 0) return "📭 Nothing saved yet — send me a link.";
  const lines = recipes.map((r, i) => `${i + 1}. ${link(recipeUrl(r.id), r.title)}`);
  return [`🗂 <b>Last ${recipes.length}</b>`, ...lines].join("\n");
}

export function findText(
  query: string,
  recipes: RecipeDTO[],
  recipeUrl: (id: string) => string,
): string {
  if (recipes.length === 0) {
    return `🔍 Nothing matched <b>${escapeHtml(query)}</b>.`;
  }
  const lines = recipes.map((r, i) => `${i + 1}. ${link(recipeUrl(r.id), r.title)}`);
  return [`🔍 <b>${escapeHtml(query)}</b>`, ...lines].join("\n");
}

export const FIND_USAGE = "🔍 Try <code>/find shrimp tacos</code>.";

export const NUDGE =
  "🤔 Send me a Reel, TikTok or recipe link and I'll save it. /help for more.";

/**
 * The reply-to-a-bot-message case where we no longer know which import it was.
 * Honest about the cause: the message→job map is in memory (see handlers.ts).
 */
export const LOST_CONTEXT =
  "🤷 I've lost track of that import (I restarted). Send the link again and I'll retry.";

export const API_DOWN =
  "⚠️ Mise isn't answering right now. Try again in a minute.";

export const TIMED_OUT =
  "⏱ Still working on this one — check Mise in a moment.";

/** The single place the web deep-link shape is defined. */
export function recipeUrl(publicBase: string, id: string): string {
  return `${publicBase.replace(/\/+$/, "")}/recipe/${id}`;
}
