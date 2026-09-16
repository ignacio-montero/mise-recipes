// The import worker. One loop, one job at a time, inside the `mise-web` process
// (docs/ARCHITECTURE.md §2). The queue IS the `ImportJob` table: no Redis, no
// BullMQ, no second container — and, because the queue is the database, a job
// cannot be "accepted" and then lost in a process that died, which is the whole
// failure mode a message broker is usually bought to avoid.
//
// Concept — **job queue / background worker.** `POST /api/imports` writes a row
// and returns 202 in milliseconds; this loop does the 5-40 s of work afterwards
// and the phone polls `GET /api/imports/:id`. An HTTP request held open for 40 s
// dies the moment the phone leaves wifi, which is why the seam exists at all.
//
// Invariants this file is responsible for:
//   • SERIAL. One import at a time. Two concurrent yt-dlp/ffmpeg spikes do not
//     fit in a 640 MB container, and SQLite has one writer anyway.
//   • THE LOOP NEVER DIES. Every tick is wrapped; a thrown anything schedules
//     the next tick instead of silently ending imports until the next deploy.
//   • NOTHING IS STUCK FOREVER. `running` rows are requeued at startup, because
//     a row in `running` with no process behind it is by definition orphaned.
//   • RETRIES ARE FREE. `rawText` is persisted the moment gathering succeeds, so
//     attempt 2 never touches Instagram again.

import { config } from "./config";
import { canonicalUrl } from "./canonicalUrl";
import { prisma } from "./prisma";
import { parseServingsCount } from "./scale";
import { ExtractionError } from "./extract/classify";
import { gather, structure, toExtraction } from "./extract";
import { saveHeroImage } from "./images";
import { sweepTempDir } from "./ytdlp";
import type { Gathered, ImportStage, ParsedRecipe } from "./types";

// Re-exported so "start the worker" and "clean the temp dir" are one import for
// callers; the implementation stays next to the code that creates those files.
export { sweepTempDir } from "./ytdlp";

/** Wait this long after a failed attempt before the same job is eligible again.
 *  Without it, `maxAttempts` retries burn through in ~4 s and a transient
 *  Instagram 429 or Gemini 503 is guaranteed to be transient in exactly the
 *  wrong way. Indexed by attempts already used; the last value repeats.
 *
 *  Held in memory rather than as a `nextAttemptAt` column because it is a
 *  scheduling hint, not data: losing it on restart just means we try sooner,
 *  which is the harmless direction. */
const RETRY_BACKOFF_MS = [5_000, 30_000, 120_000];

/** Errors are shown to the user (in the PWA and in Telegram), so they are
 *  sentences, not stack traces — but a runaway model message must not become a
 *  wall of text in a chat bubble. */
const MAX_ERROR_CHARS = 400;

/** Everything Gemini could have seen. Same cap as the provenance blob. */
const MAX_RAW_TEXT = 32_000;

type WorkerStatus = { alive: boolean; lastTickAt: string | null; pending: number };

// ── Loop state ───────────────────────────────────────────────────────────────
// Module-level singletons. Next's dev server re-evaluates modules on edit, so
// `startWorker()` is idempotent and `stopWorker()` exists to make that testable.

type LoopState = {
  started: boolean;
  timer: NodeJS.Timeout | null;
  ticking: boolean;
  lastTickAt: Date | null;
  /** Last observed pending count, refreshed every tick. `workerStatus()` is
   *  called from a route handler that must answer synchronously, so it reads
   *  this cache rather than querying the DB on every healthcheck. */
  pending: number;
  /** jobId → epoch ms before which this job must not be retried. */
  cooldowns: Map<string, number>;
};

// Pinned to globalThis for the reason lib/prisma.ts pins its client, plus one
// specific to this file: Next compiles `instrumentation.ts` and the API routes
// into SEPARATE bundles, each with its own instance of this module. Plain module
// scope would give `startWorker()` (instrumentation) and `workerStatus()`
// (/api/health) different variables — health would report `alive: false` while
// the loop was happily running. A global is the one thing both copies share, and
// it also makes the "exactly one loop" guarantee survive a dev hot reload.
const globalForWorker = globalThis as unknown as { __miseWorker?: LoopState };
const state: LoopState = (globalForWorker.__miseWorker ??= {
  started: false,
  timer: null,
  ticking: false,
  lastTickAt: null,
  pending: 0,
  cooldowns: new Map<string, number>(),
});

export function workerStatus(): WorkerStatus {
  return {
    alive: state.started,
    lastTickAt: state.lastTickAt ? state.lastTickAt.toISOString() : null,
    pending: state.pending,
  };
}

export function startWorker(): void {
  if (state.started) return; // idempotent: instrumentation.ts may register twice in dev
  state.started = true;
  console.log(`[worker] starting (poll ${config.worker.pollMs}ms, max ${config.worker.maxAttempts} attempts)`);
  void bootstrap().finally(() => schedule(0));
}

export function stopWorker(): void {
  state.started = false;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
}

/** Crash recovery, run once before the first tick. */
async function bootstrap(): Promise<void> {
  try {
    // Imports run one at a time in one process, so ANY row still marked
    // `running` at startup belongs to a process that no longer exists — a
    // container restart mid-import, an OOM kill, a deploy. Requeue, don't fail:
    // `attempts` was already incremented when it was claimed, so a job that
    // reliably kills the process still gives up eventually (poison-message
    // protection) instead of crash-looping forever.
    const { count } = await prisma.importJob.updateMany({
      where: { status: "running" },
      data: { status: "pending", stage: null },
    });
    if (count > 0) console.log(`[worker] requeued ${count} interrupted job(s)`);
  } catch (e) {
    console.error("[worker] startup requeue failed", e);
  }
  try {
    // Anything under DATA_DIR/tmp is orphaned for the same reason.
    await sweepTempDir();
  } catch (e) {
    console.error("[worker] temp sweep failed", e);
  }
}

function schedule(delayMs: number): void {
  if (!state.started) return;
  state.timer = setTimeout(() => {
    void tick();
  }, delayMs);
  // Do not hold the event loop open on our account. The Next server keeps the
  // process alive; a test or a script should be able to exit without stopWorker().
  state.timer.unref?.();
}

/**
 * One pass. Self-rescheduling `setTimeout` rather than `setInterval`: an import
 * can take 40 s, and `setInterval` would keep firing underneath it and pile up
 * overlapping ticks. This way the next tick is only ever scheduled once the
 * previous one has finished.
 */
/**
 * Claiming a job by flipping `status` to "running" is a LEASE — and a lease with
 * no expiry is a bug waiting to happen.
 *
 * `bootstrap()` requeues `running` rows at startup, which covers "the process
 * died". It does NOT cover "the process is alive and dropped the ball": if the
 * write inside `handleFailure` itself throws (SQLITE_BUSY, disk full), the
 * exception unwinds past it and the row stays "running" forever. That URL then
 * becomes permanently un-importable, because POST /api/imports treats a running
 * job as in-flight and hands back the dead id.
 *
 * Real queues solve this with a visibility timeout; this is the same idea. A job
 * that has not been touched in STALE_LEASE_MS is presumed abandoned and requeued
 * — safe because `attempts` was already incremented when it was claimed, so a
 * genuinely poisonous job still gives up after maxAttempts rather than looping.
 */
const STALE_LEASE_MS = 15 * 60 * 1000;

async function reclaimStaleLeases(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_LEASE_MS);
  const { count } = await prisma.importJob.updateMany({
    where: { status: "running", updatedAt: { lt: cutoff } },
    data: { status: "pending", stage: null },
  });
  if (count > 0) console.warn(`[worker] reclaimed ${count} stale running job(s)`);
}

async function tick(): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  let didWork = false;
  try {
    state.lastTickAt = new Date();
    await reclaimStaleLeases();
    state.pending = await prisma.importJob.count({ where: { status: "pending" } });

    // Take a few candidates, not one: the oldest pending job may be cooling off
    // after a failed attempt, and letting it block everything behind it is
    // classic head-of-line blocking.
    const candidates = await prisma.importJob.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
      take: 5,
    });
    const now = Date.now();
    const next = candidates.find((j) => (state.cooldowns.get(j.id) ?? 0) <= now);
    if (next) {
      didWork = true;
      await runJob(next.id);
    }
  } catch (e) {
    // The contract of this catch: the loop outlives every possible failure,
    // including the database being momentarily unreadable.
    console.error("[worker] tick failed", e);
  } finally {
    state.ticking = false;
    // Drain quickly when there is a queue; idle politely when there is not.
    schedule(didWork ? 50 : config.worker.pollMs);
  }
}

// ── One job ──────────────────────────────────────────────────────────────────

type ClaimedJob = {
  id: string;
  url: string;
  attempts: number;
  rawText: string | null;
  suppliedText: string | null;
};

/**
 * Compare-and-set claim: flip `pending` → `running` only if it is still
 * `pending`. `updateMany` with the old status in the WHERE clause makes that a
 * single atomic statement, so two processes (a stray `next dev` alongside the
 * container, say) can never both own the same job. This is **optimistic
 * concurrency control**; the row's own status column is the version token.
 */
async function claim(id: string): Promise<ClaimedJob | null> {
  const { count } = await prisma.importJob.updateMany({
    where: { id, status: "pending" },
    data: { status: "running", stage: "fetching", error: null, attempts: { increment: 1 } },
  });
  if (count === 0) return null;
  return prisma.importJob.findUnique({
    where: { id },
    select: { id: true, url: true, attempts: true, rawText: true, suppliedText: true },
  });
}

async function runJob(id: string): Promise<void> {
  const job = await claim(id);
  if (!job) return; // someone else took it, or it was cancelled between queries

  // Stage writes are fire-and-forget so the pipeline never waits on the UI, but
  // the handle is kept so the terminal write cannot be overtaken by a late
  // "structuring" update landing on an already-`done` row.
  let stageWrite: Promise<unknown> = Promise.resolve();
  const setStage = (stage: ImportStage): void => {
    stageWrite = prisma.importJob
      .update({ where: { id: job.id }, data: { stage } })
      .catch((e: unknown) => console.warn("[worker] stage update failed", e));
  };

  try {
    // Cheapest possible outcome first. `POST /api/imports` already refuses a URL
    // we have saved, but a job enqueued BEFORE that recipe existed (two shares
    // racing, or a queue that built up while the worker was down) would
    // otherwise re-run the whole pipeline and pay for a model call to rediscover
    // a row we already have.
    const already = await prisma.recipe.findFirst({
      where: { sourceUrl: job.url },
      select: { id: true },
    });
    if (already) {
      await finish(job.id, { status: "done", recipeId: already.id, error: null });
      console.log(`[worker] ${job.id} already imported → recipe ${already.id}`);
      return;
    }

    // Priority: what the user pasted, then what we already gathered, then the
    // network. The second case is why a retry is free — attempt 2 of a Gemini
    // outage must not re-scrape Instagram (and risk a rate limit) to re-learn
    // text we already have.
    const sourceText = job.suppliedText?.trim() || job.rawText?.trim() || null;

    const gathered = await gather(job.url, sourceText, setStage);

    // Persist the gathered text BEFORE structuring, not after: Tier 3 is the
    // most likely step to fail, and it is the step whose retry we most want to
    // be free.
    await stageWrite;
    await prisma.importJob.update({
      where: { id: job.id },
      data: { rawText: gathered.text.slice(0, MAX_RAW_TEXT), stage: "structuring" },
    });

    const parsed = await structure(gathered);

    if (!parsed.isRecipe) {
      await finish(job.id, {
        status: "not_recipe",
        error: "That link doesn't look like a recipe — no ingredients or method in it.",
      });
      console.log(`[worker] ${job.id} not_recipe (confidence ${parsed.confidence})`);
      return;
    }

    const recipeId = await saveRecipe(job.url, gathered, parsed);
    await finish(job.id, { status: "done", recipeId, error: null });
    console.log(`[worker] ${job.id} done → recipe ${recipeId} [${gathered.tiers.join(" → ")}]`);
  } catch (e) {
    await stageWrite.catch(() => {});
    await handleFailure(job, e);
  }
}

/** Terminal write. Clears the stage so the UI stops showing a phase. */
async function finish(
  id: string,
  data: { status: string; recipeId?: string | null; error: string | null },
): Promise<void> {
  state.cooldowns.delete(id);
  await prisma.importJob.update({ where: { id }, data: { ...data, stage: null } });
}

async function handleFailure(job: ClaimedJob, e: unknown): Promise<void> {
  // `canRetryWithText === false` is this pipeline's way of saying "this URL will
  // never work" (unsupported host, a link that is not a post). Retrying that
  // twice more only delays telling the user something we already know.
  const permanent = e instanceof ExtractionError && !e.canRetryWithText;
  const message = userMessage(e);
  const exhausted = job.attempts >= config.worker.maxAttempts;

  console.error(`[worker] ${job.id} attempt ${job.attempts} failed: ${message}`);

  if (permanent || exhausted) {
    await finish(job.id, { status: "failed", error: message });
    return;
  }

  // Back to `pending` — the row is the retry queue. The cooldown lives in
  // memory; the durable part (status, attempts, rawText) is in the row.
  const backoff = RETRY_BACKOFF_MS[Math.min(job.attempts - 1, RETRY_BACKOFF_MS.length - 1)];
  state.cooldowns.set(job.id, Date.now() + backoff);
  await prisma.importJob.update({
    where: { id: job.id },
    // The error is kept visible while it retries: "Instagram returned no
    // caption (retrying)" is more honest than a silent spinner.
    data: { status: "pending", stage: null, error: message },
  });
}

/** Extraction failures already carry a sentence written for a human. Anything
 *  else is a bug, and a bug's message is for the log, not for the user. */
function userMessage(e: unknown): string {
  if (e instanceof ExtractionError) return e.message.slice(0, MAX_ERROR_CHARS);
  console.error("[worker] unexpected error", e);
  return "Something went wrong while importing that link.";
}

// ── Recipe creation ──────────────────────────────────────────────────────────

async function saveRecipe(
  jobUrl: string,
  gathered: Gathered,
  parsed: ParsedRecipe,
): Promise<string> {
  // `sourceUrl` is the dedupe key and it is UNIQUE, so it must be the post's
  // IDENTITY, not whatever spelling the user happened to share. Those differ:
  // the iOS share sheet emits `instagram.com/share/<per-share-token>` and
  // `vm.tiktok.com/<short>`, which are PROVENANCE — a different token every
  // time, so storing them means the same reel saves twice.
  //
  // The worker is the first place the real identity is known (it resolved the
  // redirect), so it is the right place to decide the key. Enqueue-time dedupe
  // in the route stays best-effort; THIS is the authoritative check, backed by
  // the UNIQUE index and the P2002 catch below.
  const identity = canonicalUrl(gathered.canonicalUrl) ?? canonicalUrl(jobUrl) ?? jobUrl;
  const existing = await prisma.recipe.findFirst({
    where: { OR: [{ sourceUrl: identity }, { sourceUrl: jobUrl }] },
    select: { id: true },
  });
  if (existing) {
    console.log(`[worker] ${jobUrl} already saved as ${existing.id}`);
    return existing.id;
  }

  const heroImagePath = await saveHeroImage(gathered.thumbnailUrl);
  const servings = parsed.servings ?? null;

  try {
    const created = await prisma.recipe.create({
      data: {
        title: parsed.title.trim() || "Untitled recipe",
        description: parsed.description ?? null,
        sourceUrl: identity,
        sourcePlatform: gathered.platform,
        sourceAuthor: gathered.author,
        heroImagePath,
        servings,
        // Parsed once, at write time, because the cook view's scaler needs a
        // number and "6-8 tacos" is not one. See lib/scale.ts.
        servingsCount: parseServingsCount(servings),
        totalMinutes: parsed.totalMinutes ?? null,
        // JSON TEXT columns (docs/ARCHITECTURE.md §4). Reads go back through
        // toRecipeDTO; this is the only place that writes them.
        ingredients: JSON.stringify(parsed.ingredients ?? []),
        steps: JSON.stringify(parsed.steps ?? []),
        notes: parsed.notes ?? null,
        tags: JSON.stringify(parsed.tags ?? []),
        extraction: JSON.stringify(toExtraction(gathered, parsed)),
      },
      select: { id: true },
    });
    return created.id;
  } catch (e) {
    // Check-then-act above is a race by construction (two jobs for the same URL
    // finishing together). The unique index is the real referee, so honour its
    // verdict instead of failing the import.
    if (isUniqueViolation(e)) {
      const row = await prisma.recipe.findFirst({
        where: { sourceUrl: jobUrl },
        select: { id: true },
      });
      if (row) return row.id;
    }
    throw e;
  }
}

/** Prisma's "unique constraint failed" code. Matched structurally rather than
 *  with `instanceof PrismaClientKnownRequestError` to avoid importing Prisma's
 *  runtime error classes into a hot path. */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}
