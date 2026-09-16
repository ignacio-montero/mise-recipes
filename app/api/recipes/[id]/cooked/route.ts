// POST /api/recipes/:id/cooked — "I made this tonight".
// DELETE /api/recipes/:id/cooked — "no I didn't, that was a mis-tap".
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ApiError, handle } from "@/lib/http";
import { recipeInclude, toRecipeDTO } from "@/lib/serialize";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const exists = await prisma.recipe.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw new ApiError("not_found", "No recipe with that id.");

  // `increment` is an atomic UPDATE ... SET cookedCount = cookedCount + 1 in the
  // database. Reading the count into JS, adding one and writing it back would be
  // a lost-update race if two taps arrive at once.
  const recipe = await prisma.recipe.update({
    where: { id },
    data: { cookedCount: { increment: 1 }, lastCookedAt: new Date() },
    include: recipeInclude,
  });
  return NextResponse.json({ recipe: toRecipeDTO(recipe) });
});

/**
 * Undo one cook. Returns `{ recipe }` (200), not 204 — the client needs the new
 * count to repaint "Cooked 2×" and to reconcile its optimistic guess.
 *
 * IDEMPOTENT AT ZERO, ON PURPOSE. Undoing when the count is already 0 is a
 * no-op that still answers 200 with the recipe, the way DELETE is supposed to
 * behave: the caller's *intent* ("this recipe should not be counted from that
 * tap") is already satisfied, so a 409 would be noise on a phone where a double
 * tap is normal. 404 is still 404 — a missing recipe is a different failure.
 *
 * WHY TWO GUARDED UPDATES IN A TRANSACTION, RATHER THAN READ-MODIFY-WRITE:
 *   1. `updateMany({ where: { id, cookedCount: { gt: 0 } }, decrement: 1 })`
 *      compiles to ONE `UPDATE … SET cookedCount = cookedCount - 1
 *      WHERE id = ? AND cookedCount > 0`. The floor lives in the WHERE clause,
 *      so the database — not JS — decides whether the row is eligible. Two
 *      simultaneous undos at count 1 can only succeed once; the loser matches 0
 *      rows and changes nothing. Fetching the count, subtracting in JS and
 *      writing it back would let both taps read 1 and both write 0 (a
 *      lost update), or worse, -1.
 *   2. `lastCookedAt` cannot be expressed in the same Prisma `data` block,
 *      because "null if the new count is 0, otherwise leave it" is a conditional
 *      on the value being written. So it is a SECOND guarded update —
 *      `where: { id, cookedCount: 0 }` — which is again a condition the DB
 *      evaluates, not a value JS computed. Raw SQL with a CASE would do it in
 *      one statement; it was rejected because it hard-codes column names and
 *      bypasses Prisma's field mapping for no benefit at this row count.
 * Both statements plus the final read run inside `$transaction`, so no request
 * can observe the half-applied state where the count is 0 but the date is not.
 *
 * NOTE ON THE MODEL: there is no cook *history* table, only a counter and the
 * last date. Undoing from 3 to 2 therefore cannot restore the previous cook's
 * timestamp, so `lastCookedAt` is left alone above zero and only cleared at
 * zero, which is the one case where the date is provably wrong. Storing a
 * `CookEvent` row per cook would make undo exact; that is a schema change and a
 * bigger feature ("cooked 4 times, last three in January") than this fix.
 */
export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const exists = await prisma.recipe.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw new ApiError("not_found", "No recipe with that id.");

  const recipe = await prisma.$transaction(async (tx) => {
    await tx.recipe.updateMany({
      where: { id, cookedCount: { gt: 0 } },
      data: { cookedCount: { decrement: 1 } },
    });
    await tx.recipe.updateMany({
      where: { id, cookedCount: 0 },
      data: { lastCookedAt: null },
    });
    return tx.recipe.findUniqueOrThrow({ where: { id }, include: recipeInclude });
  });

  return NextResponse.json({ recipe: toRecipeDTO(recipe) });
});
