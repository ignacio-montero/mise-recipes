"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import Toast from "./Toast";
import { ApiClientError, apiGet, apiPost, errorMessage, isAbort, withQuery } from "./api";
import { countsLine, hostOf, relativeTime } from "./format";
import {
  POLL_INTERVAL_MS,
  hasTimedOut,
  pollDecision,
  stageMessage,
  stageProgress,
  statusGlyph,
  urlFromPaste,
} from "./importFlow";
import type {
  ImportEnqueueResponse,
  ImportJob,
  ImportListResponse,
  RecipeResponse,
} from "./types";

/**
 * `/add` — the in-app import screen.
 *
 * WHY THIS SCREEN EXISTS AT ALL, GIVEN THE BOT
 * --------------------------------------------
 * PRD §4 makes Telegram the primary ingest path, for a hard reason: iOS Safari
 * does not implement the Web Share Target API, so an installed PWA physically
 * cannot appear in Instagram's share sheet (DECISIONS D-002). What a PWA *can*
 * do is read the clipboard on a tap. That gives a three-tap path that needs no
 * bot at all: **Copy link → open Mise → Paste**. The "Paste" button below is
 * that whole feature; everything else on the screen is the fallbacks around it.
 *
 * THE ASYNC SEAM. `POST /api/imports` returns `202 Accepted` with a job id and
 * no recipe — extraction takes 5–40 s in a worker (ARCHITECTURE §2). So this
 * component's real job is not "submit a form", it is "poll `GET
 * /api/imports/:id` every 1.5 s and render five possible statuses". The
 * decisions themselves live in `components/importFlow.ts` as pure functions
 * over the DTO, so they can be tested without timers or a renderer; this file
 * holds only the effects.
 *
 * CONCEPT — POLLING WITH A setTimeout CHAIN, NOT setInterval. `setInterval`
 * fires on a fixed schedule regardless of whether the previous request came
 * back, so one slow response on a phone's flaky connection stacks requests on
 * top of each other. Scheduling the next poll only after the current one
 * resolves ("self-rescheduling timeout") makes overlap impossible and lets the
 * chain simply stop by not scheduling again.
 */

type Outcome = { recipeId: string; message: string } | null;

export default function AddView() {
  const router = useRouter();

  // What the user typed / pasted. A CONTROLLED COMPONENT: React state is the
  // single source of truth for the field's value, which is what lets the Paste
  // button write into it programmatically.
  const [paste, setPaste] = useState("");

  // The job currently being watched. `jobId` drives the polling effect; `job`
  // is the latest snapshot the poll returned and drives what is rendered.
  // They are separate because the effect must not re-subscribe on every poll.
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  /** 409: this URL is already a recipe. Not an error — an invitation. */
  const [conflict, setConflict] = useState<Outcome>(null);

  // The manual-caption fallback (PRD F4). Kept OUTSIDE `resetOutcome` on
  // purpose: if the retry also fails, re-typing a 400-word caption would be a
  // punishment for the app's own failure.
  const [fallbackText, setFallbackText] = useState("");

  const [recent, setRecent] = useState<ImportJob[]>([]);
  const [clipboardBlocked, setClipboardBlocked] = useState(false);

  const [manualOpen, setManualOpen] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [creating, setCreating] = useState(false);

  const [toast, setToast] = useState<{ text: string; tone: "ok" | "error" } | null>(null);

  const fallbackRef = useRef<HTMLTextAreaElement | null>(null);

  const loadRecent = useCallback(async () => {
    try {
      // The envelope is `{ jobs }` — verified against app/api/imports/route.ts,
      // not assumed. Done jobs carry the full recipe inline, so this one call
      // renders the whole strip with no N+1 fan-out.
      const { jobs } = await apiGet<ImportListResponse>(withQuery("/api/imports", { limit: 8 }));
      setRecent(jobs ?? []);
    } catch {
      // The strip is a nicety. A failure here must not take the paste box down
      // with it, so it is swallowed rather than surfaced.
    }
  }, []);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  /** Clear the previous attempt's outcome before starting a new one, so a stale
   *  "that didn't look like a recipe" can't sit under a fresh spinner. */
  function resetOutcome() {
    setSubmitError("");
    setConflict(null);
    setTimedOut(false);
    setJob(null);
    setJobId(null);
  }

  const startImport = useCallback(
    async (url: string, text?: string) => {
      setSubmitting(true);
      setSubmitError("");
      setConflict(null);
      setTimedOut(false);
      setJob(null);
      setJobId(null);
      try {
        const res = await apiPost<ImportEnqueueResponse>(
          "/api/imports",
          // `source` is omitted deliberately: it defaults to "web", and only
          // "telegram" requires the x-mise-token header. Sending a token from
          // the browser would mean shipping the shared secret to the client.
          text ? { url, text } : { url },
        );
        // Seed `job` from the 202 body rather than rendering nothing for the
        // first 1.5 s. Everything here is either returned by the POST or known
        // to be true of a job that has not started yet.
        setJob({
          id: res.id,
          status: res.status,
          stage: null,
          url,
          recipeId: null,
          error: null,
          canRetryWithText: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        setJobId(res.id);
      } catch (e) {
        // A 409 carries `recipeId` alongside the standard error envelope — the
        // one place the extra payload key on ApiClientError earns its keep.
        if (e instanceof ApiClientError && e.code === "conflict") {
          const recipeId = typeof e.payload.recipeId === "string" ? e.payload.recipeId : null;
          if (recipeId) {
            setConflict({ recipeId, message: e.message || "You've already saved that one." });
            return;
          }
        }
        setSubmitError(errorMessage(e, "Couldn't start that import."));
      } finally {
        setSubmitting(false);
      }
    },
    [],
  );

  // ── The poll loop ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!jobId) return;

    let alive = true;
    const ac = new AbortController();
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      try {
        const fresh = await apiGet<ImportJob>(`/api/imports/${jobId}`, ac.signal);
        if (!alive) return;
        setJob(fresh);

        const decision = pollDecision(fresh);
        if (decision.kind === "done") {
          // Straight to the recipe: the user's intent was never "watch a
          // progress bar", it was "have this recipe". `refresh()` too, so the
          // cached `/` segment doesn't show a list without the new recipe in it.
          router.refresh();
          router.push(`/recipe/${decision.recipeId}`);
          return;
        }
        if (decision.kind !== "keep-polling") {
          // Terminal. Stop the chain by simply not scheduling again; `job`
          // stays on screen so the render can offer the right recovery.
          void loadRecent();
          return;
        }
        if (hasTimedOut(startedAt, Date.now())) {
          setTimedOut(true);
          return;
        }
        timer = setTimeout(tick, POLL_INTERVAL_MS);
      } catch (e) {
        if (!alive || isAbort(e)) return;
        // A single failed poll is usually a phone changing cell — not a failed
        // import. Keep asking until the overall timeout says otherwise, rather
        // than throwing away a job that is very likely still running.
        if (hasTimedOut(startedAt, Date.now())) {
          setTimedOut(true);
          return;
        }
        timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }

    timer = setTimeout(tick, POLL_INTERVAL_MS);

    // CLEANUP is not optional here. Without it, navigating away mid-import
    // leaves a timer holding a closure over `setJob` forever — React's
    // "state update on an unmounted component" leak, and a request every 1.5 s
    // from a screen nobody is looking at.
    return () => {
      alive = false;
      ac.abort();
      if (timer) clearTimeout(timer);
    };
  }, [jobId, router, loadRecent]);

  // ── Actions ───────────────────────────────────────────────────────────────

  /** The three-tap path. `readText()` is called FIRST inside the click handler
   *  because the Clipboard API only resolves while the browser still considers
   *  a user gesture "in progress" (transient activation); awaiting anything
   *  before it — a fetch, a confirm — silently rejects on iOS. */
  async function pasteAndImport() {
    setSubmitError("");
    let clip = "";
    try {
      clip = (await navigator.clipboard?.readText()) ?? "";
    } catch {
      // Denied, or not a secure context. `navigator.clipboard` is undefined on
      // plain http, which is exactly how this app is reached over the tailnet
      // (http://mise.<tailnet>) — so this is a normal path, not an edge case.
      setClipboardBlocked(true);
      return;
    }
    if (!clip.trim()) {
      setClipboardBlocked(true);
      return;
    }
    setPaste(clip);
    const url = urlFromPaste(clip);
    if (!url) {
      setSubmitError("There's no link in what you copied. Use the post's “Copy link” and try again.");
      return;
    }
    await startImport(url);
  }

  function submitPaste(e: React.FormEvent) {
    e.preventDefault();
    const url = urlFromPaste(paste);
    if (!url) {
      setSubmitError("Paste a link to a Reel, a TikTok, a YouTube video or a recipe page.");
      return;
    }
    void startImport(url);
  }

  function retryWithText() {
    const url = job?.url;
    if (!url) return;
    const text = fallbackText.trim();
    if (text.length < 20) {
      setSubmitError("Paste the whole caption — a few words isn't enough to work from.");
      fallbackRef.current?.focus();
      return;
    }
    void startImport(url, text);
  }

  async function createManual(e: React.FormEvent) {
    e.preventDefault();
    const title = manualTitle.trim();
    if (!title) return;
    setCreating(true);
    try {
      // `title` only. API_SPEC §3: POST /api/recipes takes the writable fields
      // and FORCES `sourcePlatform: "manual"` — sending `sourceUrl` or
      // `sourcePlatform` is a `bad_request`, not a silently ignored key.
      const { recipe } = await apiPost<RecipeResponse>("/api/recipes", { title });
      // Hand straight off to the real editor via `?edit=1`, rather than growing
      // a second ingredients-and-steps form here. RecipeEditor is PATCH-only by
      // design (it edits a saved draft), so "create the shell, then edit it" is
      // what lets one editor serve both paths.
      router.refresh();
      router.push(`/recipe/${recipe.id}?edit=1`);
    } catch (err) {
      setToast({ text: errorMessage(err, "Couldn't create that recipe."), tone: "error" });
      setCreating(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const decision = job ? pollDecision(job) : null;
  const working = decision?.kind === "keep-polling" && !timedOut;
  const busy = submitting || working;

  return (
    <>
      <div className="page stack">
        <h1 style={{ fontSize: 22 }}>Add a recipe</h1>

        <form className="card stack" onSubmit={submitPaste}>
          <div className="paste-area">
            <label className="field__label" htmlFor="paste-url">
              Link to a Reel, TikTok, YouTube video or recipe page
            </label>
            <textarea
              id="paste-url"
              className="textarea"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder="https://www.instagram.com/reel/…"
              rows={3}
              /* iOS keyboard hints: a URL keyboard, and none of the four
                 "helpful" corrections that mangle a pasted link. */
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={busy}
            />
          </div>

          <div className="paste-actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={pasteAndImport}
              disabled={busy}
            >
              {submitting ? <span className="spinner" /> : "📋"} Paste
            </button>
            <button type="submit" className="btn" disabled={busy || paste.trim() === ""}>
              Import
            </button>
          </div>

          <p className="muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5 }}>
            {clipboardBlocked
              ? "Your browser wouldn't hand over the clipboard (it only allows that over HTTPS). Long-press the box above and paste there instead."
              : "In Instagram or TikTok: Share → Copy link, then come back and tap Paste."}
          </p>
        </form>

        {/* ── Live progress ─────────────────────────────────────────────── */}
        {job && working && (
          <div className="card stack-sm">
            <div className="row" style={{ alignItems: "center", gap: 10 }}>
              <span className="spinner" />
              {/* aria-live="polite" so the stage changes are announced as they
                  happen. Without it a screen-reader user gets silence for 30 s
                  and no reason to believe anything is happening. */}
              <strong aria-live="polite" style={{ fontSize: 15 }}>
                {stageMessage(job.status, job.stage)}
              </strong>
            </div>
            <div
              className="progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(stageProgress(job.status, job.stage) * 100)}
              aria-label="Import progress"
            >
              <div
                className="progress-bar"
                style={{ width: `${Math.round(stageProgress(job.status, job.stage) * 100)}%` }}
              />
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {hostOf(job.url) || job.url} · this usually takes about 10 seconds. You can leave this
              screen — the import keeps going.
            </p>
          </div>
        )}

        {/* ── 409: already saved ────────────────────────────────────────── */}
        {conflict && (
          <div className="notice notice--info stack-sm" role="status">
            <div>📖 {conflict.message}</div>
            <Link className="btn btn--block" href={`/recipe/${conflict.recipeId}`}>
              Open the saved recipe
            </Link>
          </div>
        )}

        {/* ── Pre-flight / submit errors ────────────────────────────────── */}
        {submitError && (
          <div className="notice notice--error" role="alert">
            {submitError}
          </div>
        )}

        {timedOut && (
          <div className="notice notice--warn stack-sm" role="alert">
            <div>
              This is taking unusually long. The import is still running on the server — check back
              in a minute.
            </div>
            <button type="button" className="btn btn--sm" onClick={() => void loadRecent()}>
              Refresh recent imports
            </button>
          </div>
        )}

        {/* ── Recoverable failure: the manual-caption fallback (PRD F4) ──── */}
        {decision?.kind === "retry-with-text" && !timedOut && (
          <div className="notice notice--warn stack" role="alert">
            <div>
              {statusGlyph(job!.status)} {decision.message}
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5 }}>
              Open the post, copy its caption, and paste it here — Mise will structure that text
              instead of trying to fetch it again.
            </p>
            <textarea
              ref={fallbackRef}
              className="textarea"
              value={fallbackText}
              onChange={(e) => setFallbackText(e.target.value)}
              placeholder="Paste the caption…"
              rows={6}
              aria-label="Caption text"
              disabled={submitting}
            />
            <div className="paste-actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={retryWithText}
                disabled={submitting}
              >
                {submitting ? <span className="spinner" /> : null} Try with this text
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => void startImport(job!.url)}
                disabled={submitting}
              >
                Just retry
              </button>
            </div>
          </div>
        )}

        {/* ── Unrecoverable failure ─────────────────────────────────────── */}
        {decision?.kind === "failed" && !timedOut && (
          <div className="notice notice--error stack-sm" role="alert">
            <div>⚠️ {decision.message}</div>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void startImport(job!.url)}
              disabled={submitting}
            >
              Try again
            </button>
          </div>
        )}

        {/* ── Write it myself ───────────────────────────────────────────── */}
        <div className="card stack-sm">
          {manualOpen ? (
            <form className="stack-sm" onSubmit={createManual}>
              <label className="field__label" htmlFor="manual-title">
                Recipe name
              </label>
              <input
                id="manual-title"
                className="input"
                value={manualTitle}
                onChange={(e) => setManualTitle(e.target.value)}
                placeholder="Sunday ragù"
                autoFocus
                disabled={creating}
              />
              <div className="paste-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setManualOpen(false)}
                  disabled={creating}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={creating || manualTitle.trim() === ""}
                >
                  {creating ? <span className="spinner" /> : null} Create &amp; edit
                </button>
              </div>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                Creates an empty recipe and opens the editor, where you can add ingredients and
                steps.
              </p>
            </form>
          ) : (
            <button type="button" className="link-btn" onClick={() => setManualOpen(true)}>
              ✍️ …or write one myself
            </button>
          )}
        </div>

        {/* ── Recent imports ────────────────────────────────────────────── */}
        {recent.length > 0 && (
          <div>
            <span className="section-title">Recent imports</span>
            <div>
              {recent.map((r) => (
                <RecentRow key={r.id} job={r} />
              ))}
            </div>
          </div>
        )}
      </div>

      <Toast message={toast?.text ?? null} tone={toast?.tone} onDismiss={() => setToast(null)} />
    </>
  );
}

/**
 * One line of the "Recent imports" strip.
 *
 * NOTE ON HYDRATION: `relativeTime` is clock-dependent, and rendering a
 * clock-dependent string on the server and again in the browser produces two
 * different strings and a hydration mismatch. It is safe here only because this
 * list is fetched in an effect, so it never exists during server rendering —
 * the first time it is drawn, it is drawn in the browser.
 */
function RecentRow({ job }: { job: ImportJob }) {
  const label = job.recipe?.title ?? hostOf(job.url) ?? job.url;

  const body = (
    <>
      <span aria-hidden>{statusGlyph(job.status)}</span>
      <span className="recent-row__url">
        {job.recipe ? (
          <>
            <strong style={{ color: "var(--text)" }}>{label}</strong>{" "}
            <span>· {countsLine(job.recipe)}</span>
          </>
        ) : (
          label
        )}
      </span>
      <span className="muted" style={{ fontSize: 12.5, flex: "none" }}>
        {relativeTime(job.createdAt)}
      </span>
    </>
  );

  // Only a finished import is a link — there is nowhere to send a failed one.
  return job.status === "done" && job.recipeId ? (
    <Link className="recent-row" href={`/recipe/${job.recipeId}`}>
      {body}
    </Link>
  ) : (
    <div className="recent-row">{body}</div>
  );
}
