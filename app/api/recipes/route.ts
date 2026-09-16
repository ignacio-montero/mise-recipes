// GET /api/recipes — list, search, filter, sort, paginate.
// POST /api/recipes — manual create.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ApiError, handle } from "@/lib/http";
import { parseJson, recipeInclude, toRecipeDTO } from "@/lib/serialize";
import { parseServingsCount } from "@/lib/scale";
import type { Ingredient } from "@/lib/types";
import { readJson } from "../_lib/json";
import { parseRecipeWrite } from "../_lib/recipe-write";
import { parseCursor, parseLimit } from "../_lib/query";

export const dynamic = "force-dynamic";

type Sort = "recent" | "title" | "cooked";

/** Every sort ends with `id` as a tiebreaker: cursor pagination needs a total
 *  order, and `title`/`cookedCount` are not unique — without it two recipes
 *  called "Pesto" could straddle a page boundary and one would be lost. */
const MAX_BATCH = 200;
const MAX_ROUNDS = 5;

const ORDER_BY: Record<Sort, Array<Record<string, "asc" | "desc">>> = {
  recent: [{ createdAt: "desc" }, { id: "desc" }],
  title: [{ title: "asc" }, { id: "asc" }],
  cooked: [{ cookedCount: "desc" }, { lastCookedAt: "desc" }, { id: "desc" }],
};

/**
 * Refine the coarse SQL match in JS.
 *
 * Why two passes: `ingredients` and `tags` are serialised JSON TEXT columns, so
 * SQL can only do `LIKE '%shrimp%'` over the whole blob — which also matches a
 * `note` ("serve with shrimp crackers"), a `unit`, or a stray key name. And
 * Prisma's `mode: "insensitive"` is a no-op on SQLite (the connector does not
 * support it), so we cannot lean on it either; SQLite's LIKE is already
 * case-insensitive for ASCII, which is what makes the coarse pass work at all.
 * The tradeoff is deliberate: SQL narrows thousands of rows to a handful, JS
 * applies the real contract (title, description, ingredient.item, tags). At a
 * few thousand recipes this is free; the day it is not, the fix is FTS5.
 */
function matchesQuery(
  row: { title: string; description: string | null; ingredients: string; tags: string },
  needle: string,
): boolean {
  const q = needle.toLowerCase();
  if (row.title.toLowerCase().includes(q)) return true;
  if ((row.description ?? "").toLowerCase().includes(q)) return true;
  if (parseJson<string[]>(row.tags, []).some((t) => t.toLowerCase().includes(q))) return true;
  return parseJson<Ingredient[]>(row.ingredients, []).some((i) =>
    (i?.item ?? "").toLowerCase().includes(q),
  );
}

export const GET = handle(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const q = sp.get("q")?.trim() ?? "";
  const folder = sp.get("folder")?.trim() ?? "";
  const tag = sp.get("tag")?.trim() ?? "";
  const favoriteParam = sp.get("favorite");
  const sortParam = (sp.get("sort")?.trim() || "recent") as Sort;
  if (!(sortParam in ORDER_BY)) {
    throw new ApiError("bad_request", "`sort` must be one of: recent, title, cooked.");
  }
  const limit = parseLimit(sp.get("limit"));
  const cursor = parseCursor(sp.get("cursor"));

  const where: Record<string, unknown> = {};
  // `?folder=none` is a reserved value meaning "filed nowhere". Without it the
  // UI's "Unfiled" chip has to filter client-side over whatever page it already
  // loaded — correct today, quietly wrong the moment the list paginates past a
  // page. "none" is safe as a sentinel because folder ids are cuids, which
  // always start with "c" and are far longer.
  if (folder === "none") where.folders = { none: {} };
  else if (folder) where.folders = { some: { folderId: folder } };
  if (favoriteParam !== null) where.favorite = favoriteParam !== "false" && favoriteParam !== "0";
  // Tags live inside the JSON array, so match the quoted form to avoid "veg"
  // hitting "vegetarian" at the SQL level; the JS pass below is exact anyway.
  if (tag) where.tags = { contains: JSON.stringify(tag) };
  if (q) {
    where.OR = [
      { title: { contains: q } },
      { description: { contains: q } },
      { ingredients: { contains: q } },
      { tags: { contains: q } },
    ];
  }

  // A cursor that no longer exists (deleted recipe) makes Prisma throw an opaque
  // error; failing it as bad_request tells the client to restart pagination.
  if (cursor) {
    const exists = await prisma.recipe.findUnique({ where: { id: cursor }, select: { id: true } });
    if (!exists) throw new ApiError("bad_request", "Unknown `cursor`.");
  }

  const refining = Boolean(q || tag);
  // Over-fetch when a JS refinement pass can throw rows away, then loop until we
  // have a full page. Without the loop a page could come back half empty while
  // plenty of matches were still waiting behind the cursor.
  const batchSize = refining ? Math.min(MAX_BATCH, limit * 3) : limit + 1;
  const kept: Array<Awaited<ReturnType<typeof fetchBatch>>[number]> = [];
  let scanCursor = cursor;
  let exhausted = false;

  async function fetchBatch(after: string | undefined) {
    return prisma.recipe.findMany({
      where,
      orderBy: ORDER_BY[sortParam],
      include: recipeInclude,
      take: batchSize,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    });
  }

  for (let round = 0; round < MAX_ROUNDS && kept.length <= limit && !exhausted; round++) {
    const batch = await fetchBatch(scanCursor);
    if (batch.length < batchSize) exhausted = true;
    if (batch.length > 0) scanCursor = batch[batch.length - 1].id;
    for (const row of batch) {
      if (q && !matchesQuery(row, q)) continue;
      if (tag && !parseJson<string[]>(row.tags, []).some((t) => t.toLowerCase() === tag.toLowerCase())) continue;
      kept.push(row);
    }
  }

  const page = kept.slice(0, limit);
  const nextCursor = kept.length > limit
    ? page[page.length - 1].id
    : exhausted
      ? null
      : (scanCursor ?? null); // more rows exist, none matched this sweep

  return NextResponse.json({ recipes: page.map(toRecipeDTO), nextCursor });
});

export const POST = handle(async (req: Request) => {
  const body = await readJson(req);
  const data = parseRecipeWrite(body, { requireTitle: true });

  const recipe = await prisma.recipe.create({
    data: {
      ...data,
      title: data.title!,
      // Forced, not taken from the body: a hand-entered recipe has no source to
      // re-extract from, and letting a client claim "instagram" would poison the
      // provenance that docs/ARCHITECTURE.md §3 relies on.
      sourcePlatform: "manual",
      servingsCount: data.servingsCount ?? parseServingsCount(data.servings ?? null),
      ingredients: data.ingredients ?? "[]",
      steps: data.steps ?? "[]",
      tags: data.tags ?? "[]",
    },
    include: recipeInclude,
  });

  return NextResponse.json({ recipe: toRecipeDTO(recipe) }, { status: 201 });
});
