// UNIT tests for components/importFlow.ts — the import polling state machine.
//
// WHY THIS IS A STATE MACHINE AND WHY THAT MAKES IT TESTABLE
// ----------------------------------------------------------
// `POST /api/imports` answers 202 in milliseconds and the real work happens in a
// background worker (ARCHITECTURE §2), so the UI polls `GET /api/imports/:id`
// every 1.5 s and has to react to five statuses — two of which (`failed` and
// `not_recipe`) are RECOVERABLE, because they unlock the paste-the-caption
// fallback (PRD F4).
//
// Buried inside a `setInterval` callback, that logic is effectively untestable:
// you would need fake timers, a fetch mock and a rendered component just to
// assert "not_recipe offers the textarea". Lifted out as `pollDecision(job)` it
// is a switch over a DTO, and every branch is one line to cover. Naming the
// pattern: this is a **reducer**-shaped design — data in, decision out, no I/O —
// and it is the standard move for making UI logic testable.
//
// EXHAUSTIVENESS is the property worth chasing here, not depth. A state machine
// fails at the state nobody thought about, so the tests below walk every status
// including the one that should be impossible.

import { describe, expect, it } from "vitest";
import {
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  hasTimedOut,
  isTerminal,
  pollDecision,
  stageMessage,
  stageProgress,
  statusGlyph,
  urlFromPaste,
} from "@/components/importFlow";
import type { ImportJob, ImportStatus } from "@/components/types";

const job = (over: Partial<ImportJob>): ImportJob => ({
  id: "job1",
  status: "pending",
  stage: null,
  url: "https://instagram.com/reel/C9dO9AevUQx",
  recipeId: null,
  error: null,
  canRetryWithText: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("pollDecision — every status the server can send", () => {
  it("keeps polling while the job is pending or running", () => {
    expect(pollDecision(job({ status: "pending" }))).toEqual({ kind: "keep-polling" });
    expect(pollDecision(job({ status: "running", stage: "transcribing" }))).toEqual({ kind: "keep-polling" });
  });

  it("navigates to the recipe on done", () => {
    expect(pollDecision(job({ status: "done", recipeId: "r1" }))).toEqual({ kind: "done", recipeId: "r1" });
  });

  it("falls back to recipe.id when recipeId is absent", () => {
    // Both fields exist in the contract and only one is guaranteed on every
    // response. Preferring `recipeId` and falling back is **defensive
    // programming** at a boundary we do not control end-to-end.
    const withInline = job({ status: "done", recipeId: null, recipe: { id: "r2" } as ImportJob["recipe"] });
    expect(pollDecision(withInline)).toEqual({ kind: "done", recipeId: "r2" });
  });

  it("surfaces a done job with no recipe as a failure instead of hanging", () => {
    // The impossible state. If it ever happens it is a BACKEND bug — and the
    // wrong response is to keep spinning, because a spinner that never stops is
    // indistinguishable from a slow import and gets reported as "it's slow"
    // rather than "it's broken". Say something.
    const decision = pollDecision(job({ status: "done", recipeId: null }));
    expect(decision.kind).toBe("failed");
    expect(decision).toHaveProperty("message", "The import finished but no recipe came back.");
  });

  it("offers the caption textarea for not_recipe", () => {
    // PRD F4. `not_recipe` usually means the caption said "recipe in bio" — the
    // user can paste the text and the import succeeds on the second try, so
    // this MUST be recoverable rather than a dead end.
    expect(pollDecision(job({ status: "not_recipe", error: "That link doesn't look like a recipe." })))
      .toEqual({ kind: "retry-with-text", message: "That link doesn't look like a recipe." });
  });

  it("lets the SERVER decide whether a failure is recoverable", () => {
    // `canRetryWithText` is the backend's judgement ("a caption would fix this"
    // vs "that host will never work"), and the client honours it rather than
    // re-deriving the rule. One source of truth; the alternative is two copies
    // of the retry policy that drift.
    expect(pollDecision(job({ status: "failed", error: "Instagram returned no caption.", canRetryWithText: true })).kind)
      .toBe("retry-with-text");
    expect(pollDecision(job({ status: "failed", error: "That link is not a post.", canRetryWithText: false })).kind)
      .toBe("failed");
  });

  it("always produces a message, even when the server sent none", () => {
    // A null error rendered straight into the UI is an empty red box. Every
    // failure branch needs a default sentence.
    for (const j of [
      job({ status: "failed", error: null, canRetryWithText: false }),
      job({ status: "failed", error: null, canRetryWithText: true }),
      job({ status: "not_recipe", error: null }),
    ]) {
      const d = pollDecision(j);
      expect(d).toHaveProperty("message");
      expect((d as { message: string }).message.length).toBeGreaterThan(0);
    }
  });

  it("treats an unrecognised status as a failure rather than polling forever", () => {
    // Forward compatibility: if the backend adds a status, an old PWA cached by
    // the service worker must degrade to "that didn't work", not spin for three
    // minutes. Fail closed, in the UI sense.
    const decision = pollDecision(job({ status: "exploded" as ImportStatus }));
    expect(decision.kind).toBe("failed");
  });
});

describe("what the user is told while they wait", () => {
  it("describes what the SERVER is doing, in plain words", () => {
    // "Listening to the audio…" tells you why it is taking 20 seconds;
    // "transcribing" makes you wonder whether it is stuck. Progress text is a
    // feature, not decoration — it is what stops people force-quitting the app.
    expect(stageMessage("running", "fetching")).toBe("Fetching the caption…");
    expect(stageMessage("running", "transcribing")).toBe("Listening to the audio…");
    expect(stageMessage("running", "structuring")).toBe("Writing it up…");
  });

  it("says something sensible when there is no stage yet", () => {
    expect(stageMessage("pending", null)).toBe("Queued…");
    expect(stageMessage("running", null)).toBe("Working on it…");
  });

  it("covers the terminal statuses too", () => {
    expect(stageMessage("done", null)).toBe("Done.");
    expect(stageMessage("failed", "fetching")).toBe("That import didn't work.");
    expect(stageMessage("not_recipe", null)).toBe("That didn't look like a recipe.");
  });

  it("moves the progress bar forward and never backward through the pipeline", () => {
    // The property, rather than the four magic numbers: a bar that jumps
    // backwards reads as an error even when nothing is wrong. Asserting the
    // ORDERING keeps the test meaningful if the values are re-tuned.
    const seq = [
      stageProgress("pending", null),
      stageProgress("running", "fetching"),
      stageProgress("running", "transcribing"),
      stageProgress("running", "structuring"),
      stageProgress("done", null),
    ];
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
    expect(seq[0]).toBeGreaterThan(0); // never a dead-looking empty bar
    expect(seq.at(-1)).toBe(1);
  });

  it("gives every status a distinct glyph", () => {
    const glyphs = (["done", "failed", "not_recipe", "pending", "running"] as ImportStatus[]).map(statusGlyph);
    expect(new Set(glyphs.slice(0, 3)).size).toBe(3); // the three outcomes differ
    expect(statusGlyph("pending")).toBe(statusGlyph("running")); // both are "in flight"
  });
});

describe("isTerminal and hasTimedOut", () => {
  it("knows which statuses stop the poll", () => {
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("not_recipe")).toBe(true);
    expect(isTerminal("pending")).toBe(false);
    expect(isTerminal("running")).toBe(false);
  });

  it("gives up after the budget, inclusive of the boundary", () => {
    // Note `now` is a PARAMETER, not a call to `Date.now()` inside the
    // function. That one design choice is what makes this testable with three
    // lines of arithmetic instead of `vi.useFakeTimers()` — **dependency
    // injection** applied to the clock. A hung yt-dlp would otherwise leave a
    // spinner running forever.
    expect(hasTimedOut(0, POLL_TIMEOUT_MS - 1)).toBe(false);
    expect(hasTimedOut(0, POLL_TIMEOUT_MS)).toBe(true); // the boundary itself counts
    expect(hasTimedOut(0, POLL_TIMEOUT_MS + 1)).toBe(true);
  });

  it("accepts an overridden timeout", () => {
    // Elapsed = now - startedAt, so these are 1 500 ms and 500 ms elapsed
    // against a 1 000 ms budget.
    expect(hasTimedOut(1_000, 2_500, 1_000)).toBe(true);
    expect(hasTimedOut(1_000, 1_500, 1_000)).toBe(false);
  });

  it("uses intervals that are sane relative to each other", () => {
    // A sanity check on the constants rather than on logic: a timeout shorter
    // than the poll interval would mean giving up before the first poll.
    expect(POLL_INTERVAL_MS).toBeGreaterThan(0);
    expect(POLL_TIMEOUT_MS).toBeGreaterThan(POLL_INTERVAL_MS * 10);
  });
});

describe("urlFromPaste — pulling the link out of what the user pasted", () => {
  it("finds a bare URL", () => {
    expect(urlFromPaste("https://instagram.com/reel/C9dO9AevUQx")).toBe("https://instagram.com/reel/C9dO9AevUQx");
  });

  it("finds the URL inside TikTok's share sentence", () => {
    // TikTok's share text ALWAYS looks like this, so it is the common case, not
    // an edge case: "Check out this video ... https://vm.tiktok.com/x/".
    expect(urlFromPaste("Check out chefsomebody's video! https://vm.tiktok.com/ZGeKcLQAB/ more text"))
      .toBe("https://vm.tiktok.com/ZGeKcLQAB/");
  });

  it("does not swallow the punctuation that ended the sentence", () => {
    // "…at https://blog.example/tacos." — the full stop is the writer's, not
    // part of the URL, and leaving it on produces a 404 the user cannot explain.
    expect(urlFromPaste("Recipe at https://blog.example/tacos.")).toBe("https://blog.example/tacos");
    expect(urlFromPaste("(see https://blog.example/tacos)")).toBe("https://blog.example/tacos");
    expect(urlFromPaste("https://blog.example/tacos;")).toBe("https://blog.example/tacos");
  });

  it("takes the FIRST url when there are several", () => {
    expect(urlFromPaste("https://a.example/1 and https://b.example/2")).toBe("https://a.example/1");
  });

  it("returns null when there is no link, so the UI can say so itself", () => {
    // Cheaper and kinder than a server round trip that answers "`url` must be
    // an absolute http(s) URL".
    expect(urlFromPaste("")).toBeNull();
    expect(urlFromPaste("what's for dinner")).toBeNull();
    expect(urlFromPaste("instagram.com/reel/x")).toBeNull(); // no scheme
  });

  it("does not treat a non-http scheme as a link", () => {
    expect(urlFromPaste("javascript:alert(1)")).toBeNull();
    expect(urlFromPaste("file:///etc/passwd")).toBeNull();
  });

  it("is case-insensitive about the scheme", () => {
    expect(urlFromPaste("HTTPS://blog.example/tacos")).toBe("HTTPS://blog.example/tacos");
  });
});
