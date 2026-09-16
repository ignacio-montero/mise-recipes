// INTEGRATION tests for lib/worker.ts — the import queue.
//
// The worker is where "it worked on my machine" goes to die: it is a loop, it
// is stateful, it retries, and every interesting behaviour is a STATE
// TRANSITION over time (pending → running → done/failed). So the test strategy
// is:
//
//   • REAL database. The queue IS the ImportJob table; the transitions being
//     asserted are rows, and a mocked Prisma would assert nothing.
//   • STUBBED extraction. `gather()`/`structure()` mean the network, yt-dlp and
//     Gemini. Stubbing them is what makes this suite deterministic and offline
//     — and it lets us *inject failures on demand*, which is the only sane way
//     to test a retry policy.
//   • A CONTROLLED CLOCK. The retry backoff is 5 s; waiting 5 s per test is how
//     suites become unrunnable. `Date.now` is spied on so the test can jump the
//     clock forward instead of sleeping (the same idea as vi.useFakeTimers,
//     scoped to just the clock the cooldown reads).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate, removeTempDatabase, useTempDatabase } from "./helpers/db";
import { ExtractionError } from "@/lib/extract/classify";
import { canonicalUrl } from "@/lib/canonicalUrl";
import type { Gathered, ParsedRecipe } from "@/lib/types";

const DB_FILE = useTempDatabase("worker");

// ── Test doubles ─────────────────────────────────────────────────────────────

const cfg = vi.hoisted(() => ({ maxAttempts: 3, pollMs: 10 }));
vi.mock("@/lib/config", () => ({
  APP_NAME: "Mise",
  geminiConfigured: () => true,
  config: {
    dataDir: "./data", ingestToken: "",
    gemini: { apiKey: "k", models: ["stub"] },
    telegram: { botToken: "", chatId: "", apiBase: "" },
    apiBase: "", publicBase: "",
    extraction: { enableAudioTier: false, maxAudioSeconds: 300, cookiesFile: "" },
    worker: {
      enabled: true,
      get pollMs() { return cfg.pollMs; },
      get maxAttempts() { return cfg.maxAttempts; },
    },
  },
}));

const stubs = vi.hoisted(() => ({
  gather: null as unknown as ReturnType<typeof vi.fn>,
  structure: null as unknown as ReturnType<typeof vi.fn>,
  sweepTempDir: null as unknown as ReturnType<typeof vi.fn>,
  saveHeroImage: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("@/lib/extract", () => ({
  gather: (...args: unknown[]) => stubs.gather(...args),
  structure: (...args: unknown[]) => stubs.structure(...args),
  toExtraction: (g: Gathered, p: ParsedRecipe) => ({
    tiers: g.tiers, model: null, confidence: p.confidence, rawText: g.text,
  }),
}));
vi.mock("@/lib/images", () => ({ saveHeroImage: (...a: unknown[]) => stubs.saveHeroImage(...a) }));
vi.mock("@/lib/ytdlp", () => ({
  sweepTempDir: (...a: unknown[]) => stubs.sweepTempDir(...a),
  makeTempDir: vi.fn(), removeTempDir: vi.fn(), ytdlpAudio: vi.fn(), ytdlpJson: vi.fn(),
}));

let prisma: typeof import("@/lib/prisma").prisma;
let worker: typeof import("@/lib/worker");

// ── Clock control ────────────────────────────────────────────────────────────

const realNow = Date.now.bind(Date);
let clockOffset = 0;
/** Jump the clock the retry cooldown reads, instead of sleeping through it. */
const advanceClock = (ms: number) => { clockOffset += ms; };

// ── Fixtures ─────────────────────────────────────────────────────────────────

const gathered = (over: Partial<Gathered> = {}): Gathered => ({
  platform: "instagram",
  text: "1 lb shrimp\n2 tbsp mayo\nFry the shrimp.",
  author: "chefsomebody",
  thumbnailUrl: null,
  durationSeconds: null,
  canonicalUrl: "https://www.instagram.com/reel/C9dO9AevUQx/",
  tiers: ["tier1:instagram-embed"],
  structured: null,
  ...over,
});

const parsed = (over: Partial<ParsedRecipe> = {}): ParsedRecipe => ({
  isRecipe: true,
  confidence: 0.9,
  title: "Crispy Shrimp Tacos",
  servings: "6-8 tacos",
  totalMinutes: 25,
  ingredients: [{ quantity: "1", unit: "lb", item: "shrimp" }],
  steps: ["Fry the shrimp."],
  tags: ["mexican"],
  notes: null,
  ...over,
});

/** The spelling a human shares. */
const URL_A = "https://www.instagram.com/reel/C9dO9AevUQx/";

/**
 * The spelling that ends up in `Recipe.sourceUrl`.
 *
 * INVARIANT worth stating out loud, because two tests in this file used to
 * quietly violate it: `lib/worker.ts` `saveRecipe()` is the ONLY writer of
 * `sourceUrl` in the whole app (`sourceUrl` is not in `WRITABLE_RECIPE_FIELDS`,
 * so `POST /api/recipes` cannot set it), and it always writes
 * `canonicalUrl(...)` output. So every row in the table holds the canonical
 * form, and a test that seeds a recipe with a raw share URL is testing a state
 * the system cannot reach.
 *
 * Derived here rather than hard-coded so this file cannot drift from the
 * canonicaliser — but asserted against the literal below, so a silent change to
 * the dedupe key still fails a test.
 */
const CANON_A = canonicalUrl(URL_A)!;

beforeAll(async () => {
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
  ({ prisma } = await import("@/lib/prisma"));
  await migrate(prisma);
  worker = await import("@/lib/worker");
});

afterAll(async () => {
  worker.stopWorker();
  vi.restoreAllMocks();
  await prisma.$disconnect();
  removeTempDatabase(DB_FILE);
});

beforeEach(async () => {
  cfg.maxAttempts = 3;
  clockOffset = 0;
  stubs.gather = vi.fn(async () => gathered());
  stubs.structure = vi.fn(async () => parsed());
  stubs.sweepTempDir = vi.fn(async () => {});
  stubs.saveHeroImage = vi.fn(async () => null);
  await prisma.importJob.deleteMany();
  await prisma.recipe.deleteMany();
});

afterEach(async () => {
  worker.stopWorker();
  await settle();
});

/** Let any in-flight tick finish before the next test clears the tables. */
const settle = () => new Promise((r) => setTimeout(r, 30));

/** Poll the row until `predicate` holds. Iteration-capped rather than
 *  clock-capped, because this file owns a fake clock. */
async function waitForJob(id: string, predicate: (j: { status: string; attempts: number }) => boolean) {
  for (let i = 0; i < 300; i++) {
    const job = await prisma.importJob.findUnique({ where: { id } });
    if (job && predicate(job)) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  const job = await prisma.importJob.findUnique({ where: { id } });
  throw new Error(`job never reached the expected state; last seen: ${JSON.stringify(job)}`);
}

const terminal = (j: { status: string }) => ["done", "failed", "not_recipe"].includes(j.status);

async function enqueue(url = URL_A, data: Record<string, unknown> = {}) {
  return prisma.importJob.create({ data: { url, status: "pending", ...data } });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("the happy path", () => {
  it("takes a pending job through to done and creates the recipe", async () => {
    const job = await enqueue();
    worker.startWorker();

    const finished = await waitForJob(job.id, terminal);
    expect(finished.status).toBe("done");
    expect(finished.stage).toBeNull(); // the UI must stop showing a phase
    expect(finished.attempts).toBe(1);
    expect(finished.error).toBeNull();

    const recipe = await prisma.recipe.findUnique({ where: { id: finished.recipeId! } });
    expect(recipe!.title).toBe("Crispy Shrimp Tacos");
    // `sourceUrl` is IDENTITY, not provenance: the worker stores the canonical
    // form of the URL it actually resolved, not the spelling the user shared.
    // It has to, because `sourceUrl` is UNIQUE and the share sheet emits a
    // different spelling every time. Asserted against the literal so that a
    // change to the canonicaliser breaks this test loudly.
    expect(recipe!.sourceUrl).toBe("https://instagram.com/reel/C9dO9AevUQx");
    expect(recipe!.sourceUrl).toBe(CANON_A);
    expect(recipe!.sourcePlatform).toBe("instagram");
    expect(recipe!.sourceAuthor).toBe("chefsomebody");
    // servingsCount is derived at write time from "6-8 tacos" because the cook
    // view's scaler needs a number (lib/scale.ts).
    expect(recipe!.servingsCount).toBe(6);
    expect(JSON.parse(recipe!.ingredients)).toEqual([{ quantity: "1", unit: "lb", item: "shrimp" }]);
    // Provenance (PRD F13): which tier produced this.
    expect(JSON.parse(recipe!.extraction!).tiers).toEqual(["tier1:instagram-embed"]);
  });

  it("claims the job exactly once, incrementing attempts", async () => {
    // The claim is a compare-and-set (`updateMany ... where status = 'pending'`)
    // — **optimistic concurrency control**, with the status column as the
    // version token. Two loops can never both own one job.
    const job = await enqueue();
    worker.startWorker();
    const finished = await waitForJob(job.id, terminal);
    expect(finished.attempts).toBe(1);
    expect(stubs.gather).toHaveBeenCalledTimes(1);
  });

  it("persists rawText before structuring, so a retry is free", async () => {
    const job = await enqueue();
    worker.startWorker();
    const finished = await waitForJob(job.id, terminal);
    expect(finished.rawText).toContain("1 lb shrimp");
  });

  it("prefers the user's pasted caption over the network (PRD F4)", async () => {
    const job = await enqueue(URL_A, { suppliedText: "1 lb shrimp\nFry it." });
    worker.startWorker();
    await waitForJob(job.id, terminal);
    expect(stubs.gather).toHaveBeenCalledWith(URL_A, "1 lb shrimp\nFry it.", expect.any(Function));
  });

  it("marks a non-recipe as not_recipe instead of saving an empty shell", async () => {
    stubs.structure = vi.fn(async () => parsed({ isRecipe: false, confidence: 0.1, ingredients: [], steps: [] }));
    const job = await enqueue();
    worker.startWorker();

    const finished = await waitForJob(job.id, terminal);
    expect(finished.status).toBe("not_recipe");
    expect(finished.error).toMatch(/doesn't look like a recipe/);
    expect(await prisma.recipe.count()).toBe(0);
  });
});

describe("a URL we already have", () => {
  it("finishes the job against the EXISTING recipe instead of re-importing", async () => {
    // A job enqueued before the recipe existed (two shares racing, or a queue
    // that built up while the worker was down) must not pay for a second model
    // call to rediscover a row we already have — and must not throw on the
    // UNIQUE constraint either.
    const existing = await prisma.recipe.create({
      data: { title: "Already here", sourceUrl: CANON_A, ingredients: "[]", steps: "[]", tags: "[]" },
    });
    // `POST /api/imports` canonicalises before it writes the row, so a job url
    // is always already canonical. Seeding the raw spelling here would test a
    // state the queue cannot contain.
    const job = await enqueue(CANON_A);
    worker.startWorker();

    const finished = await waitForJob(job.id, terminal);
    expect(finished.status).toBe("done");
    expect(finished.recipeId).toBe(existing.id);
    expect(finished.error).toBeNull();
    expect(stubs.gather).not.toHaveBeenCalled(); // the cheap check ran first
    expect(await prisma.recipe.count()).toBe(1);
  });

  it("collapses a share link onto the recipe its RESOLVED canonical URL created", async () => {
    // The C1 case. The iOS share sheet emits `instagram.com/share/<token>` with
    // a FRESH token every time, so two shares of one reel are two different
    // URLs at enqueue time and the route's dedupe cannot possibly catch them.
    // The worker is the first place the real identity is known — it resolved the
    // redirect — so the authoritative check is `canonicalUrl(gathered.canonicalUrl)`
    // against what is already stored.
    //
    // ⚠️ This test previously seeded `sourceUrl: URL_A` (the raw, non-canonical
    // spelling) and failed. That was the FIXTURE being wrong, not the fix: see
    // the note on CANON_A — `saveRecipe()` is the only writer of `sourceUrl` and
    // it always canonicalises, so a stored non-canonical URL is unreachable.
    const existing = await prisma.recipe.create({
      data: { title: "Already here", sourceUrl: CANON_A, ingredients: "[]", steps: "[]", tags: "[]" },
    });
    const job = await enqueue("https://instagram.com/share/BAF6qMfDnE");
    worker.startWorker();

    const finished = await waitForJob(job.id, terminal);
    expect(finished.status).toBe("done");
    expect(finished.recipeId).toBe(existing.id);
    expect(await prisma.recipe.count()).toBe(1);
    // The cheap pre-check could NOT have caught this one — the share token is
    // not the reel's id — so this proves the post-resolution check, not the
    // early return.
    expect(stubs.gather).toHaveBeenCalledTimes(1);
  });

  it("saves ONE recipe when the same reel is shared twice under two share tokens", async () => {
    // The end-to-end version of the same property, with nothing pre-seeded:
    // two share URLs that share no substring, both resolving to one reel. This
    // is the shape the bug actually took in the wild ("every reel saved twice").
    const first = await enqueue("https://instagram.com/share/AAAAAAAAAA");
    worker.startWorker();
    const one = await waitForJob(first.id, terminal);
    expect(one.status).toBe("done");

    const second = await enqueue("https://instagram.com/share/BBBBBBBBBB");
    const two = await waitForJob(second.id, terminal);
    expect(two.status).toBe("done");

    expect(two.recipeId).toBe(one.recipeId);
    expect(await prisma.recipe.count()).toBe(1);
    const saved = await prisma.recipe.findFirstOrThrow();
    // …and the row holds the reel's identity, not either share token.
    expect(saved.sourceUrl).toBe(CANON_A);
  });

  it("does NOT collapse two different reels that happen to arrive as short links", async () => {
    // The **negative** half of a dedupe test, and the one people forget. A
    // canonicaliser that is too aggressive (e.g. "strip the whole query string"
    // applied to youtube.com/watch?v=) makes every second import a false
    // duplicate pointing at someone else's recipe — a far worse bug than a
    // duplicate row, because the user silently loses the recipe they saved.
    stubs.gather = vi.fn(async (url: string) =>
      gathered({
        canonicalUrl: url.endsWith("AAAA")
          ? "https://www.instagram.com/reel/C9dO9AevUQx/"
          : "https://www.instagram.com/reel/C41MJlUSKcU/",
      }),
    );

    const a = await enqueue("https://instagram.com/share/AAAA");
    worker.startWorker();
    await waitForJob(a.id, terminal);
    const b = await enqueue("https://instagram.com/share/ZZZZ");
    await waitForJob(b.id, terminal);

    expect(await prisma.recipe.count()).toBe(2);
  });
});

describe("failure, retry and giving up", () => {
  it("gives up immediately on an error that says 'this will never work'", async () => {
    // `canRetryWithText: false` means unsupported host / not a post. Retrying
    // twice more only delays telling the user something we already know.
    stubs.gather = vi.fn(async () => {
      throw new ExtractionError("That Instagram link is not a post or reel.", false);
    });
    const job = await enqueue();
    worker.startWorker();

    const finished = await waitForJob(job.id, terminal);
    expect(finished.status).toBe("failed");
    expect(finished.attempts).toBe(1); // NOT 3
    expect(finished.error).toBe("That Instagram link is not a post or reel.");
  });

  it("lands on failed once attempts reach maxAttempts", async () => {
    cfg.maxAttempts = 1;
    stubs.gather = vi.fn(async () => { throw new ExtractionError("Instagram returned no caption."); });
    const job = await enqueue();
    worker.startWorker();

    const finished = await waitForJob(job.id, terminal);
    expect(finished.status).toBe("failed");
    expect(finished.attempts).toBe(1);
    expect(finished.error).toBe("Instagram returned no caption.");
  });

  it("requeues a transient failure, keeps the reason visible, and retries after the cooldown", async () => {
    // Two behaviours in one test because they are one behaviour: the row IS
    // the retry queue. Between attempts the job is `pending` again *with the
    // error still set*, because "Instagram returned no caption (retrying)" is
    // more honest to show than a silent spinner.
    let calls = 0;
    stubs.structure = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new ExtractionError("Gemini is busy.");
      return parsed();
    });

    const job = await enqueue();
    worker.startWorker();

    const requeued = await waitForJob(job.id, (j) => j.status === "pending" && j.attempts === 1);
    expect(requeued.error).toBe("Gemini is busy.");
    expect(requeued.stage).toBeNull();
    // rawText survived the failure — this is what makes attempt 2 free.
    expect(requeued.rawText).toContain("1 lb shrimp");

    advanceClock(6_000); // past the first 5 s backoff, without waiting for it

    const finished = await waitForJob(job.id, terminal);
    expect(finished.status).toBe("done");
    expect(finished.attempts).toBe(2);
    expect(finished.error).toBeNull();
    // Attempt 2 re-used the stored text instead of hitting Instagram again.
    expect(stubs.gather).toHaveBeenLastCalledWith(URL_A, expect.stringContaining("1 lb shrimp"), expect.any(Function));
  });

  it("does not let a cooling-off job block the queue behind it", async () => {
    // **Head-of-line blocking**: the oldest pending job is in its backoff, so a
    // naive "take the oldest" worker would idle while a perfectly good job
    // waits behind it. The loop takes several candidates and skips the ones
    // that are cooling off.
    stubs.gather = vi.fn(async (url: string) => {
      if (url === URL_A) throw new ExtractionError("Instagram returned no caption.");
      return gathered({ canonicalUrl: url });
    });

    const stuck = await enqueue(URL_A, { createdAt: new Date(2026, 0, 1) });
    const good = await enqueue("https://www.instagram.com/reel/C41MJlUSKcU/", { createdAt: new Date(2026, 0, 2) });
    worker.startWorker();

    const finished = await waitForJob(good.id, terminal);
    expect(finished.status).toBe("done");
    expect((await prisma.importJob.findUnique({ where: { id: stuck.id } }))!.status).toBe("pending");
  });

  it("turns an unexpected (non-extraction) error into a generic message", async () => {
    // A bug's message is for the log, not for a chat bubble: internals must not
    // leak into a user-facing string.
    cfg.maxAttempts = 1;
    stubs.gather = vi.fn(async () => { throw new TypeError("Cannot read properties of undefined (reading 'x')"); });
    const job = await enqueue();
    worker.startWorker();

    const finished = await waitForJob(job.id, terminal);
    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("Something went wrong while importing that link.");
    expect(finished.error).not.toContain("undefined");
  });

  it("truncates a runaway error message", async () => {
    cfg.maxAttempts = 1;
    stubs.gather = vi.fn(async () => { throw new ExtractionError("x".repeat(5_000)); });
    const job = await enqueue();
    worker.startWorker();

    const finished = await waitForJob(job.id, terminal);
    expect(finished.error!.length).toBeLessThanOrEqual(400);
  });
});

describe("crash recovery at startup", () => {
  it("requeues a row left in 'running' by a process that no longer exists", async () => {
    // A row in `running` with no process behind it is orphaned by definition
    // (imports are serial, in one process). Requeue rather than fail — but note
    // `attempts` was already incremented when it was claimed, so a job that
    // reliably kills the process still gives up eventually. That is
    // **poison-message protection**: crash-looping forever is the alternative.
    const job = await prisma.importJob.create({
      data: { url: URL_A, status: "running", stage: "transcribing", attempts: 1 },
    });

    worker.startWorker();

    const finished = await waitForJob(job.id, terminal);
    expect(finished.status).toBe("done");
    expect(finished.attempts).toBe(2); // 1 from the interrupted run + 1 now
  });

  // ── Lease expiry ───────────────────────────────────────────────────────────
  // `bootstrap()` above covers "the process died". These two cover "the process
  // is alive and dropped the ball": if the write inside `handleFailure` itself
  // throws (SQLITE_BUSY, disk full), the row stays `running` forever and that
  // URL becomes permanently un-importable, because POST /api/imports treats a
  // running job as in-flight and hands back the dead id.
  //
  // CONCEPT — **visibility timeout**. Every real queue (SQS, Redis streams) has
  // one: claiming a job is a LEASE, and a lease must expire, because the holder
  // cannot be trusted to give it back. `reclaimStaleLeases()` is that idea in
  // fifteen lines of SQL.
  //
  // Note how the clock is handled: the fake `Date.now` this file already owns is
  // moved FORWARD past the 15-minute timeout, rather than back-dating the row.
  // Same trick as the retry-cooldown tests — the alternative is a test that
  // sleeps for fifteen minutes.
  describe("expired leases", () => {
    it("requeues a 'running' row that has not been touched in 15 minutes", async () => {
      worker.startWorker();
      await settle(); // let bootstrap() finish, so this is NOT the startup sweep

      const job = await prisma.importJob.create({
        data: { url: URL_A, status: "running", stage: "transcribing", attempts: 1 },
      });
      advanceClock(16 * 60 * 1000);

      const finished = await waitForJob(job.id, terminal);
      expect(finished.status).toBe("done");
      // 1 from the abandoned attempt + 1 for this one. `attempts` is NOT reset,
      // which is what stops a genuinely poisonous job looping forever.
      expect(finished.attempts).toBe(2);
    });

    it("leaves a lease that is still fresh alone", async () => {
      // The other half of the boundary: reclaiming eagerly would mean two
      // workers running the same 40-second import, which is exactly what the
      // serial-by-design worker exists to prevent.
      worker.startWorker();
      await settle();

      const job = await prisma.importJob.create({
        data: { url: URL_A, status: "running", stage: "transcribing", attempts: 1 },
      });
      advanceClock(60 * 1000); // one minute in: well inside the timeout

      await settle();
      await settle();
      const still = await prisma.importJob.findUnique({ where: { id: job.id } });
      expect(still!.status).toBe("running");
      expect(still!.attempts).toBe(1);
      expect(stubs.gather).not.toHaveBeenCalled();
    });
  });

  it("sweeps the temp directory at startup", async () => {
    // Orphaned yt-dlp/ffmpeg files would otherwise accumulate on a 232 GB SSD
    // (PRD §7).
    worker.startWorker();
    await settle();
    expect(stubs.sweepTempDir).toHaveBeenCalled();
  });
});

describe("the loop itself", () => {
  it("is idempotent to start and reports its own status", async () => {
    // instrumentation.ts can register twice in dev; two loops would mean two
    // concurrent imports in a 640 MB container.
    worker.startWorker();
    worker.startWorker();
    expect(worker.workerStatus().alive).toBe(true);

    const job = await enqueue();
    await waitForJob(job.id, terminal);
    expect(stubs.gather).toHaveBeenCalledTimes(1);

    worker.stopWorker();
    expect(worker.workerStatus().alive).toBe(false);
  });

  it("survives an extraction that throws synchronously and keeps serving later jobs", async () => {
    // THE LOOP NEVER DIES. If one poisonous job could end the loop, every
    // import after it would hang silently until the next deploy.
    cfg.maxAttempts = 1;
    let first = true;
    stubs.gather = vi.fn(async () => {
      if (first) { first = false; throw new Error("boom"); }
      return gathered();
    });

    const bad = await enqueue(URL_A, { createdAt: new Date(2026, 0, 1) });
    const good = await enqueue("https://www.instagram.com/reel/C41MJlUSKcU/", { createdAt: new Date(2026, 0, 2) });
    worker.startWorker();

    expect((await waitForJob(bad.id, terminal)).status).toBe("failed");
    expect((await waitForJob(good.id, terminal)).status).toBe("done");
  });
});
