// POST /api/recipes/:id/cooked — "I made this tonight".
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
