// INTEGRATION tests for POST/GET /api/imports — the ingest surface.
//
// Two things are being proved here:
//   1. AUTHORISATION FAILS CLOSED. This is the only route reachable from
//      another container, and an unset token must mean "nobody", never
//      "everybody". That inversion is how open relays happen, and it is
//      invisible in normal use — the system looks perfectly healthy while
//      anyone on the network can enqueue work.
//   2. DEDUPE. `Recipe.sourceUrl` is UNIQUE, so the normaliser in this route is
//      the thing that decides whether re-sharing a reel is one recipe or two.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate, removeTempDatabase, useTempDatabase } from "./helpers/db";

const DB_FILE = useTempDatabase("imports");

// The route reads `config.ingestToken` at call time, but `lib/config.ts` reads
// process.env once at import. Mocking the module gives us a MUTABLE config, so
// one test file can cover both "token configured" and "token missing" without
// re-importing the whole module graph. (vi.mock is hoisted above the imports,
// which is why the shared object has to be created with vi.hoisted.)
const cfg = vi.hoisted(() => ({ ingestToken: "s3cret-ingest-token" }));
vi.mock("@/lib/config", () => ({
  APP_NAME: "Mise",
  geminiConfigured: () => false,
  config: {
    get ingestToken() { return cfg.ingestToken; },
    dataDir: "./data",
    gemini: { apiKey: "", models: [] },
    telegram: { botToken: "", chatId: "", apiBase: "" },
    apiBase: "http://localhost:3000",
    publicBase: "http://localhost:3000",
    extraction: { enableAudioTier: false, maxAudioSeconds: 300, cookiesFile: "" },
    worker: { enabled: false, pollMs: 2000, maxAttempts: 3 },
  },
}));

let prisma: typeof import("@/lib/prisma").prisma;
let route: typeof import("@/app/api/imports/route");
let jobRoute: typeof import("@/app/api/imports/[id]/route");

beforeAll(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  await migrate(prisma);
  route = await import("@/app/api/imports/route");
  jobRoute = await import("@/app/api/imports/[id]/route");
});

afterAll(async () => {
  await prisma.$disconnect();
  removeTempDatabase(DB_FILE);
});

beforeEach(async () => {
  cfg.ingestToken = "s3cret-ingest-token";
  await prisma.importJob.deleteMany();
  await prisma.recipe.deleteMany();
});

async function enqueue(body: unknown, headers: Record<string, string> = {}) {
  const res = await route.POST(
    new Request("http://localhost/api/imports", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

const withToken = { "x-mise-token": "s3cret-ingest-token" };

describe("who may enqueue an import", () => {
  it("accepts a telegram enqueue that presents the right token", async () => {
    const { status, body } = await enqueue(
      { url: "https://www.instagram.com/reel/C9dO9AevUQx/", source: "telegram", chatId: "651", messageId: 4471 },
      withToken,
    );
    expect(status).toBe(202);
    expect(body.status).toBe("pending");
  });

  it("rejects a telegram enqueue with a missing or wrong token", async () => {
    expect((await enqueue({ url: "https://x.example/1", source: "telegram" })).status).toBe(401);
    expect((await enqueue({ url: "https://x.example/1", source: "telegram" }, { "x-mise-token": "wrong" })).status).toBe(401);
    // A token with the right prefix must not be accepted either — the compare
    // is constant-time over the whole string, not a prefix match.
    expect((await enqueue({ url: "https://x.example/1", source: "telegram" }, { "x-mise-token": "s3cret-ingest-toke" })).status).toBe(401);
    expect((await enqueue({ url: "https://x.example/1", source: "telegram" }, { "x-mise-token": "s3cret-ingest-token-plus" })).status).toBe(401);
    expect(await prisma.importJob.count()).toBe(0);
  });

  it("FAILS CLOSED when the server has no ingest token configured", async () => {
    // The security-critical case. A misconfigured deploy (blank
    // OSTA_INGEST_TOKEN in .env) must refuse every off-page enqueue rather
    // than silently disabling its own auth. Note the empty presented token
    // would "match" the empty expected token under a naive `===`.
    cfg.ingestToken = "";
    expect((await enqueue({ url: "https://x.example/1", source: "telegram" })).status).toBe(401);
    expect((await enqueue({ url: "https://x.example/1", source: "telegram" }, { "x-mise-token": "" })).status).toBe(401);
    expect(await prisma.importJob.count()).toBe(0);
  });

  it("does not require a token for the same-origin web app", async () => {
    expect((await enqueue({ url: "https://x.example/1" })).status).toBe(202);
    expect((await enqueue({ url: "https://x.example/2", source: "web" })).status).toBe(202);
  });

  it("rejects an unknown source", async () => {
    expect((await enqueue({ url: "https://x.example/1", source: "curl" })).status).toBe(400);
  });
});

describe("the request body", () => {
  it("requires an absolute http(s) url", async () => {
    for (const url of ["", "   ", "not a url", "/relative", "file:///etc/passwd", "javascript:alert(1)", 42, null]) {
      expect((await enqueue({ url })).status, JSON.stringify(url)).toBe(400);
    }
  });

  it("rejects unknown fields", async () => {
    expect((await enqueue({ url: "https://x.example/1", sneaky: true })).status).toBe(400);
  });

  it("rejects a non-integer messageId", async () => {
    expect((await enqueue({ url: "https://x.example/1", messageId: "abc" })).status).toBe(400);
    expect((await enqueue({ url: "https://x.example/1", messageId: 1.5 })).status).toBe(400);
  });

  it("stores the pasted caption for the manual fallback", async () => {
    const { body } = await enqueue({ url: "https://x.example/1", text: "1 lb shrimp" });
    const job = await prisma.importJob.findUnique({ where: { id: body.id } });
    expect(job!.suppliedText).toBe("1 lb shrimp");
  });
});

describe("one reel, one job", () => {
  it("re-attaches to the open job when the same reel is shared twice", async () => {
    // Idempotent enqueue: the bot retries, and two jobs for one reel would burn
    // two Gemini calls to produce one recipe.
    const a = await enqueue({ url: "https://www.instagram.com/reel/C9dO9AevUQx/" });
    const b = await enqueue({ url: "https://www.instagram.com/reel/C9dO9AevUQx/?igsh=MzRlODBiNWFlZA==" });
    expect(b.body.id).toBe(a.body.id);
    expect(await prisma.importJob.count()).toBe(1);
  });

  it("folds www./m./trailing-slash/fragment spellings into one job", async () => {
    const first = await enqueue({ url: "https://www.instagram.com/reel/C9dO9AevUQx/" });
    for (const url of [
      "https://instagram.com/reel/C9dO9AevUQx",
      "https://m.instagram.com/reel/C9dO9AevUQx/",
      "https://www.instagram.com/reel/C9dO9AevUQx/#comments",
      "https://www.instagram.com/reel/C9dO9AevUQx/?utm_source=ig_web_copy_link",
    ]) {
      expect((await enqueue({ url })).body.id, url).toBe(first.body.id);
    }
    expect(await prisma.importJob.count()).toBe(1);
  });

  it("does NOT fold two different YouTube videos together", async () => {
    // REGRESSION TEST for a real bug: YouTube's identity lives in `?v=`, so the
    // "strip the whole query string" rule that is right for Instagram would
    // reduce every watch URL to the same string and make the second import a
    // 409 pointing at the wrong recipe.
    const a = await enqueue({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    const b = await enqueue({ url: "https://www.youtube.com/watch?v=9bZkp7q19f0" });
    expect(b.body.id).not.toBe(a.body.id);
    expect(await prisma.importJob.count()).toBe(2);
  });

  it("keeps a real query parameter on an unknown recipe site", async () => {
    // A food blog may genuinely need `?p=123`; only known tracking params go.
    const a = await enqueue({ url: "https://blog.example/recipe?p=123&utm_source=ig" });
    const b = await enqueue({ url: "https://blog.example/recipe?p=456" });
    expect(b.body.id).not.toBe(a.body.id);
    const urls = (await prisma.importJob.findMany()).map((j) => j.url).sort();
    expect(urls).toEqual(["https://blog.example/recipe?p=123", "https://blog.example/recipe?p=456"]);
  });

  it("answers 409 with the existing recipe id when that URL is already saved", async () => {
    const recipe = await prisma.recipe.create({
      data: { title: "Saved", sourceUrl: "https://instagram.com/reel/C9dO9AevUQx", steps: "[]", ingredients: "[]", tags: "[]" },
    });
    const { status, body } = await enqueue({ url: "https://www.instagram.com/reel/C9dO9AevUQx/?igsh=x" });
    expect(status).toBe(409);
    expect(body.error.code).toBe("conflict");
    expect(body.recipeId).toBe(recipe.id); // so the bot can link straight to it
  });

  it("starts a NEW job once the previous one finished", async () => {
    // Only `pending`/`running` jobs are re-used: a failed import must be
    // retryable by simply sharing the link again.
    const first = await enqueue({ url: "https://x.example/1" });
    await prisma.importJob.update({ where: { id: first.body.id }, data: { status: "failed" } });
    const second = await enqueue({ url: "https://x.example/1" });
    expect(second.body.id).not.toBe(first.body.id);
  });
});

describe("polling a job (API_SPEC §2)", () => {
  it("offers the manual-text retry only once the automatic path has given up", async () => {
    const job = await prisma.importJob.create({ data: { url: "https://x.example/1", status: "running", stage: "fetching" } });
    const get = async (id: string) => {
      const res = await jobRoute.GET(new Request(`http://localhost/api/imports/${id}`), { params: Promise.resolve({ id }) });
      return { status: res.status, body: await res.json() };
    };

    expect((await get(job.id)).body.canRetryWithText).toBe(false);
    await prisma.importJob.update({ where: { id: job.id }, data: { status: "failed", stage: null, error: "boom" } });
    expect((await get(job.id)).body.canRetryWithText).toBe(true);
    await prisma.importJob.update({ where: { id: job.id }, data: { status: "not_recipe" } });
    expect((await get(job.id)).body.canRetryWithText).toBe(true);
  });

  it("404s on an unknown job id", async () => {
    const res = await jobRoute.GET(new Request("http://localhost/api/imports/nope"), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("carries the finished recipe inline so the client needs no second call", async () => {
    const recipe = await prisma.recipe.create({
      data: { title: "Tacos", steps: "[]", ingredients: "[]", tags: "[]" },
    });
    await prisma.importJob.create({ data: { url: "https://x.example/9", status: "done", recipeId: recipe.id } });

    const res = await route.GET(new Request("http://localhost/api/imports?status=done"));
    const body = await res.json();
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].recipe.title).toBe("Tacos");
  });

  it("rejects an unknown status filter", async () => {
    const res = await route.GET(new Request("http://localhost/api/imports?status=exploded"));
    expect(res.status).toBe(400);
  });
});
