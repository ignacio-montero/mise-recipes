// The import poll state machine, as pure data -> decision functions.
//
// WHY THIS ISN'T JUST AN `if` INSIDE THE POLLING EFFECT
// ----------------------------------------------------
// `POST /api/imports` returns 202 immediately and the real work happens in a
// worker (ARCHITECTURE §2), so the UI's job is to poll `GET /api/imports/:id`
// every 1.5 s and react to five possible statuses, two of which (`failed` and
// `not_recipe`) are RECOVERABLE — they unlock the manual-caption fallback
// (PRD F4). That is a state machine, and a state machine buried in a
// `setInterval` callback is untestable: you would have to mock timers, mock
// fetch and render a component to assert "not_recipe offers the textarea".
// Here it is a switch over a DTO, and the component only has to do what the
// decision says.
//
// CONCEPT — POLLING vs PUSH. Polling asks "done yet?" on a timer. It is
// stateless, survives a reconnect, and needs no server-side machinery — the
// right call for one user, one open job, and a job that finishes in ~10 s. The
// alternatives (Server-Sent Events, WebSockets) push instead of ask, which is
// cheaper at scale but means holding a connection open through iOS Safari
// backgrounding the tab. Not worth it for a 15-second wait.

import type { ImportJob, ImportStage, ImportStatus } from "./types";

export const POLL_INTERVAL_MS = 1500;
/** After this long with no terminal status, stop polling and say so. A hung
 *  yt-dlp would otherwise leave a spinner going forever. */
export const POLL_TIMEOUT_MS = 180_000;

export type PollDecision =
  | { kind: "keep-polling" }
  | { kind: "done"; recipeId: string }
  /** Recoverable: show the error AND the paste-the-caption textarea. */
  | { kind: "retry-with-text"; message: string }
  /** Terminal: show the error, offer a plain retry. */
  | { kind: "failed"; message: string };

const DEFAULT_ERROR = "That import didn't work.";

/** What the UI should do next, given the latest poll response. */
export function pollDecision(job: ImportJob): PollDecision {
  switch (job.status) {
    case "pending":
    case "running":
      return { kind: "keep-polling" };
    case "done":
      // `recipeId` is the contract's field; `recipe.id` is only present on
      // `done`. Prefer the former and fall back, because a `done` job with
      // neither is a backend bug we should surface rather than hang on.
      if (job.recipeId) return { kind: "done", recipeId: job.recipeId };
      if (job.recipe?.id) return { kind: "done", recipeId: job.recipe.id };
      return { kind: "failed", message: "The import finished but no recipe came back." };
    case "not_recipe":
      return {
        kind: "retry-with-text",
        message: job.error ?? "That didn't look like a recipe.",
      };
    case "failed":
      return job.canRetryWithText
        ? { kind: "retry-with-text", message: job.error ?? DEFAULT_ERROR }
        : { kind: "failed", message: job.error ?? DEFAULT_ERROR };
    default:
      return { kind: "failed", message: DEFAULT_ERROR };
  }
}

/**
 * The live progress line. Written as what the SERVER is doing in plain words,
 * not as the stage enum: "Listening to the audio…" tells you why it is taking
 * 20 seconds; "transcribing" makes you wonder whether it is stuck.
 */
export function stageMessage(status: ImportStatus, stage: ImportStage | null): string {
  if (status === "pending") return "Queued…";
  if (status === "done") return "Done.";
  if (status === "not_recipe") return "That didn't look like a recipe.";
  if (status === "failed") return "That import didn't work.";
  switch (stage) {
    case "fetching":
      return "Fetching the caption…";
    case "transcribing":
      return "Listening to the audio…";
    case "structuring":
      return "Writing it up…";
    default:
      return "Working on it…";
  }
}

/** Rough progress for the bar, 0..1. Deliberately coarse — it is a reassurance
 *  that something is happening, not a measurement. */
export function stageProgress(status: ImportStatus, stage: ImportStage | null): number {
  if (status === "done") return 1;
  if (status === "pending") return 0.08;
  switch (stage) {
    case "fetching": return 0.3;
    case "transcribing": return 0.6;
    case "structuring": return 0.85;
    default: return 0.18;
  }
}

export function isTerminal(status: ImportStatus): boolean {
  return status === "done" || status === "failed" || status === "not_recipe";
}

export function hasTimedOut(startedAt: number, now: number, timeoutMs = POLL_TIMEOUT_MS): boolean {
  return now - startedAt >= timeoutMs;
}

/** The glyph shown against each row of the "Recent imports" strip. */
export function statusGlyph(status: ImportStatus): string {
  switch (status) {
    case "done": return "✅";
    case "failed": return "⚠️";
    case "not_recipe": return "\u{1F914}";
    default: return "⏳";
  }
}

/**
 * Normalises what the user typed in the paste box into something worth POSTing.
 * A pasted Instagram link often arrives wrapped in a sentence, and TikTok's
 * share text always does ("Check out this video ... https://vm.tiktok.com/x/").
 * Returns null when there is no URL — the caller then shows the "that isn't a
 * link" hint instead of making the server say it.
 */
export function urlFromPaste(raw: string): string | null {
  const m = raw.match(/https?:\/\/[^\s<>"')]+/i);
  if (!m) return null;
  return m[0].replace(/[.,;)]+$/, "");
}
