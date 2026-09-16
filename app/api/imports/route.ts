// POST /api/imports — enqueue. GET /api/imports — recent jobs.
//
// This route does NOT extract anything. It writes one `pending` row and returns
// 202; the in-process worker (lib/worker.ts) picks it up. That async seam is the
// point (docs/ARCHITECTURE.md §2): extraction takes 5-40 s, and an HTTP request
// held open that long dies to a phone leaving wifi.
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { config } from "@/lib/config";
import { canonicalUrl } from "@/lib/canonicalUrl";
import { ApiError, handle, requireString } from "@/lib/http";
import { recipeInclude, toRecipeDTO } from "@/lib/serialize";
import { assertAllowedKeys, readJson } from "../_lib/json";
import { parseLimit } from "../_lib/query";
import { toImportJobDTO } from "../_lib/import-dto";

export const dynamic = "force-dynamic";

const VALID_STATUSES = ["pending", "running", "done", "failed", "not_recipe"];

// ── URL normalisation ────────────────────────────────────────────────────────
// Lives here rather than in lib/ because it exists to serve exactly one rule:
// "the same reel shared twice is one recipe". It is a dedupe key, not a URL
// library.

/** Query junk that never identifies content. `igshid` is the one that actually
 *  bites: Instagram's share sheet stamps a fresh one on every share, so the same
 *  reel arrives with a different URL each time. */

// Canonicalisation lives in lib/canonicalUrl.ts because the WORKER must derive
// the same key when it stores the recipe — see the warning at the top of that
// file. Do not reintroduce a second normaliser here.
function normaliseUrl(raw: string): string {
  const u = canonicalUrl(raw);
  if (!u) throw new ApiError("bad_request", "`url` must be an absolute http(s) URL.");
  return u;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

/** Constant-time compare. `===` on secrets returns as soon as two bytes differ,
 *  which leaks the shared prefix to anyone who can time the response — the
 *  textbook way a token gets guessed one character at a time. The length check
 *  in front is unavoidable (timingSafeEqual throws on unequal lengths) and only
 *  leaks the length, which is not the secret. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * May this caller enqueue an import?
 *
 * Fails CLOSED: a request that proves nothing is refused. Note the token branch
 * is checked first and independently of `source`, so a caller cannot dodge it by
 * relabelling itself.
 */
function assertMayEnqueue(req: Request, source: string): void {
  // An unset OSTA_INGEST_TOKEN must never mean "everyone is authorised" — that
  // is how open relays are born — so an empty expected value matches nothing.
  const expected = config.ingestToken;
  const presented = req.headers.get("x-mise-token");
  if (expected && presented && tokenMatches(presented, expected)) return;

  // A browser sets these; page JavaScript cannot forge them. Every browser of
  // the last several years sends `Origin` on a same-origin POST, and modern ones
  // also send `Sec-Fetch-Site` — so requiring ONE of them costs real clients
  // nothing.
  //
  // ⚠️ Do NOT add a "neither header present, so assume an old browser" branch.
  // That was tried, and it reopened the hole it was meant to close: a bare
  // `curl` sends neither, so the fallback authorised exactly the caller the
  // check exists to stop. Absence of evidence is not evidence of a browser.
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite === "same-origin" || fetchSite === "none") return;

  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host === req.headers.get("host")) return;
    } catch {
      /* malformed Origin — fall through to the refusal */
    }
  }

  throw new ApiError(
    "unauthorized",
    source === "telegram"
      ? "Missing or invalid x-mise-token."
      : "Imports must come from the Mise app or carry a valid x-mise-token.",
  );
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export const POST = handle(async (req: Request) => {
  const body = await readJson(req);
  assertAllowedKeys(body, ["url", "source", "chatId", "messageId", "text"]);

  const source = body.source === undefined ? "web" : requireString(body.source, "source");
  if (source !== "web" && source !== "telegram") {
    throw new ApiError("bad_request", "`source` must be \"web\" or \"telegram\".");
  }
  // ⚠️ `source` is a LABEL THE CALLER CHOSE, never a credential. An earlier
  // version only checked the token when source==="telegram", which meant
  // omitting the field skipped the check entirely — authorisation decided by the
  // request's own say-so. Authenticate FIRST, then derive what the caller may do.
  //
  // Two ways in, both proved rather than asserted:
  //   • the ingest token  — how the bot (and any script) identifies itself;
  //   • a same-origin request — how the PWA identifies itself, since a browser
  //     sets Sec-Fetch-Site/Origin itself and page JS cannot forge them.
  // Everything else is refused, so a stray request on the Docker network or a
  // link someone opens on the tailnet cannot enqueue work.
  assertMayEnqueue(req, source);

  const rawUrl = requireString(body.url, "url");
  const url = normaliseUrl(rawUrl);

  const chatId = body.chatId === undefined || body.chatId === null
    ? null
    : String(body.chatId).trim() || null;
  let messageId: number | null = null;
  if (body.messageId !== undefined && body.messageId !== null) {
    const n = typeof body.messageId === "number" ? body.messageId : Number(body.messageId);
    if (!Number.isInteger(n)) throw new ApiError("bad_request", "`messageId` must be an integer.");
    messageId = n;
  }
  const suppliedText = body.text === undefined || body.text === null
    ? null
    : requireString(body.text, "text");

  // Dedupe against both the normalised form and whatever the caller sent, since
  // older rows may have been written before this normaliser existed.
  const existing = await prisma.recipe.findFirst({
    where: { OR: [{ sourceUrl: url }, { sourceUrl: rawUrl }] },
    select: { id: true },
  });
  if (existing) {
    throw new ApiError("conflict", "Already saved.", { recipeId: existing.id });
  }

  // Idempotent enqueue: the bot retries, and two workers racing the same reel
  // would burn two Gemini calls to produce one recipe. Re-using the open job
  // means a retried share re-attaches to the work already in flight.
  const open = await prisma.importJob.findFirst({
    where: { url, status: { in: ["pending", "running"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true },
  });
  if (open) {
    return NextResponse.json({ id: open.id, status: open.status }, { status: 202 });
  }

  const job = await prisma.importJob.create({
    data: { url, source, chatId, messageId, suppliedText, status: "pending" },
    select: { id: true, status: true },
  });
  return NextResponse.json({ id: job.id, status: job.status }, { status: 202 });
});

export const GET = handle(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const status = sp.get("status")?.trim() ?? "";
  if (status && !VALID_STATUSES.includes(status)) {
    throw new ApiError("bad_request", `\`status\` must be one of: ${VALID_STATUSES.join(", ")}.`);
  }
  const limit = parseLimit(sp.get("limit"), 20, 100);

  const jobs = await prisma.importJob.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { recipe: { include: recipeInclude } },
  });

  // The finished recipe rides along so the "Recent imports" strip can render a
  // title and thumbnail without an N+1 fan-out of /api/recipes/:id calls.
  return NextResponse.json({
    jobs: jobs.map((j) => toImportJobDTO(j, j.recipe ? toRecipeDTO(j.recipe) : null)),
  });
});
