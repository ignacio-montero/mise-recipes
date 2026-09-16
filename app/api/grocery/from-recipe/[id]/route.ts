// POST /api/grocery/from-recipe/:id — push a recipe's ingredients onto the list,
// scaled, merging instead of duplicating.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ApiError, handle } from "@/lib/http";
import { parseJson, toGroceryDTO } from "@/lib/serialize";
import { formatIngredient, formatQuantity, groceryKey, parseQuantity, scaleIngredients } from "@/lib/scale";
import type { Ingredient } from "@/lib/types";
import { assertAllowedKeys, readJson } from "../../../_lib/json";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const withRecipe = { recipe: { select: { title: true } } } as const;

/** Same normalisation as `groceryKey`, but for a whole rendered line, so
 *  "2 lb Shrimp" and the ingredient `{item: "shrimp"}` can be compared. */
function normaliseLine(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");
}

const LEADING_QUANTITY =
  /^((?:\d+\s+\d+\s*\/\s*\d+)|(?:\d+\s*\/\s*\d+)|(?:\d+(?:[.,]\d+)?)|[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])\s+(.+)$/;

/** Split "1 1/2 cups flour" into 1.5 + "cups flour". Existing list items are
 *  plain text — this is the only way back to a number once they are stored. */
function splitLeadingQuantity(text: string): { qty: number | null; rest: string } {
  const m = text.trim().match(LEADING_QUANTITY);
  if (!m) return { qty: null, rest: text.trim() };
  return { qty: parseQuantity(m[1]), rest: m[2].trim() };
}

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await readJson(req);
  assertAllowedKeys(body, ["scale"]);

  let scale = 1;
  if (body.scale !== undefined && body.scale !== null) {
    if (typeof body.scale !== "number" || !Number.isFinite(body.scale) || body.scale <= 0 || body.scale > 100) {
      throw new ApiError("bad_request", "`scale` must be a number greater than 0 and at most 100.");
    }
    scale = body.scale;
  }

  const recipe = await prisma.recipe.findUnique({
    where: { id },
    select: { id: true, ingredients: true },
  });
  if (!recipe) throw new ApiError("not_found", "No recipe with that id.");

  // `scaleIngredients` + `formatIngredient` come from lib/scale.ts on purpose:
  // the cook view renders the same functions, so the line on the shopping list
  // is character-for-character the line the screen showed.
  const ingredients = scaleIngredients(parseJson<Ingredient[]>(recipe.ingredients, []), scale);

  // Merge only against UNCHECKED items. A checked "butter" is already in the
  // basket; folding tonight's butter into it would hide it from the shopper.
  const openItems = await prisma.groceryItem.findMany({
    where: { checked: false },
    orderBy: { createdAt: "asc" },
    select: { id: true, text: true },
  });

  type Candidate = { id: string | null; text: string };
  // key -> the line that currently owns this ingredient. `id: null` means "a row
  // we are about to create in this same request", which is how two mentions of
  // butter inside one recipe also collapse into one line.
  const byKey = new Map<string, Candidate>();
  for (const item of openItems) {
    const norm = normaliseLine(item.text);
    // The ingredient name is the TAIL of a formatted line ("1 lb shrimp"), so a
    // suffix match is what connects an existing line back to an ingredient.
    for (const ing of ingredients) {
      const key = groceryKey(ing);
      if (!key || byKey.has(key)) continue;
      if (norm === key || norm.endsWith(` ${key}`)) byKey.set(key, { id: item.id, text: item.text });
    }
  }

  const creates: { text: string; recipeId: string }[] = [];
  const updates = new Map<string, string>(); // id -> new text

  for (const ing of ingredients) {
    const key = groceryKey(ing);
    const line = formatIngredient(ing);
    if (!line) continue;
    const existing = key ? byKey.get(key) : undefined;

    if (!existing) {
      creates.push({ text: line, recipeId: recipe.id });
      if (key) byKey.set(key, { id: null, text: line });
      continue;
    }

    // Both sides carry a parseable quantity and describe the same thing ("lb
    // shrimp"): add them up. Otherwise keep the existing line untouched — better
    // a slightly stale quantity than a bogus one invented by unit guessing.
    const a = splitLeadingQuantity(existing.text);
    const b = splitLeadingQuantity(line);
    if (a.qty !== null && b.qty !== null && a.rest.toLowerCase() === b.rest.toLowerCase()) {
      const merged = `${formatQuantity(a.qty + b.qty)} ${a.rest}`.trim();
      existing.text = merged;
      if (existing.id) updates.set(existing.id, merged);
      else {
        const pending = creates.find((c) => c.text === line || normaliseLine(c.text).endsWith(key));
        if (pending) pending.text = merged;
      }
    } else {
      // Same ITEM, different units ("2 cups flour" vs "300 g flour") or no
      // quantity at all. We will not invent a conversion — but the earlier
      // version simply did nothing here, which SILENTLY DROPPED the ingredient
      // while still reporting success. A duplicate line on a shopping list is a
      // cosmetic annoyance; a missing ingredient is a second trip to the shop.
      // So: add it as its own line and let the human reconcile.
      creates.push({ text: line, recipeId: recipe.id });
    }
  }

  // One transaction so a half-applied "add to list" can never happen: either the
  // whole recipe lands on the list or none of it does.
  if (creates.length > 0 || updates.size > 0) {
    await prisma.$transaction([
      ...(creates.length > 0 ? [prisma.groceryItem.createMany({ data: creates })] : []),
      ...[...updates].map(([itemId, text]) =>
        prisma.groceryItem.update({ where: { id: itemId }, data: { text } }),
      ),
    ]);
  }

  const items = await prisma.groceryItem.findMany({
    orderBy: [{ checked: "asc" }, { createdAt: "asc" }],
    include: withRecipe,
  });

  // `items` is the whole refreshed list, not just the new rows: merging mutates
  // existing lines too, so anything less would leave the client's copy stale.
  return NextResponse.json({ added: creates.length, items: items.map(toGroceryDTO) });
});
