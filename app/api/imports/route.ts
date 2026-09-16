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
const TRACKING_PARAM = /^(utm_|igsh|fbclid$|gclid$|mc_[ce]id$|si$|ref$|ref_src$|_branch|share_app_id$|is_from_webapp$|sender_device$|web_id$|feature$)/i;

/** Hosts where the content id lives in the path, so the whole query string is
 *  disposable — except YouTube, where `?v=` IS the identity. */
const PATH_IDENTIFIED = ["instagram.com", "tiktok.com", "facebook.com", "pinterest.com"];
const KEEP_PARAMS: Record<string, string[]> = { "youtube.com": ["v"] };

// NOT exported: Next type-checks route.ts and rejects any export that is not a
// route handler or a route segment config. Tested through POST /api/imports.
function normaliseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ApiError("bad_request", "`url` must be an absolute http(s) URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ApiError("bad_request", "`url` must be an http(s) URL.");
  }
  // `www.`/`m.` are the same site; folding them means the phone's mobile link and
  // the desktop link dedupe against each other. Both variants redirect in
  // practice, so the stored URL stays fetchable.
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");

  const params = new URLSearchParams();
  const keep = KEEP_PARAMS[host];
  if (keep) {
    for (const k of keep) {
      const v = u.searchParams.get(k);
      if (v) params.set(k, v);
    }
  } else if (!PATH_IDENTIFIED.some((h) => host === h || host.endsWith(`.${h}`))) {
    // Unknown host: a recipe site may genuinely need `?p=123`, so strip only the
    // known tracking params instead of the whole query.
    for (const [k, v] of [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (!TRACKING_PARAM.test(k)) params.append(k, v);
    }
  }

  const path = u.pathname.replace(/\/+$/, "");
  const qs = params.toString();
  return `${u.protocol}//${host}${path}${qs ? `?${qs}` : ""}`; // fragment always dropped
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

function assertTelegramAuthorised(req: Request): void {
  // Fail CLOSED: an unset OSTA_INGEST_TOKEN must mean "nobody may enqueue from
  // off-page", never "everybody may". A misconfigured deploy that silently
  // disables its own auth is how open relays happen.
  if (!config.ingestToken) {
    throw new ApiError("unauthorized", "Ingest token is not configured on the server.");
  }
  const presented = req.headers.get("x-mise-token") ?? "";
  if (!tokenMatches(presented, config.ingestToken)) {
    throw new ApiError("unauthorized", "Bad or missing x-mise-token.");
  }
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export const POST = handle(async (req: Request) => {
  const body = await readJson(req);
  assertAllowedKeys(body, ["url", "source", "chatId", "messageId", "text"]);

  const source = body.source === undefined ? "web" : requireString(body.source, "source");
  if (source !== "web" && source !== "telegram") {
    throw new ApiError("bad_request", "`source` must be \"web\" or \"telegram\".");
  }
  // The web app is same-origin behind Tailscale (docs/ARCHITECTURE.md §5); the
  // bot talks over the Docker network and must prove who it is.
  if (source === "telegram") assertTelegramAuthorised(req);

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
