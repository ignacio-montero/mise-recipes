// GET / PATCH / DELETE a single recipe.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ApiError, handle } from "@/lib/http";
import { recipeInclude, toRecipeDTO } from "@/lib/serialize";
import { readJson } from "../../_lib/json";
import { parseRecipeWrite } from "../../_lib/recipe-write";

export const dynamic = "force-dynamic";

// Next 15 made route params a Promise so the framework can stream the segment
// before the params are resolved. Forgetting the `await` yields `undefined` ids
// and a very confusing 404 — this is the classic App Router upgrade trap.
type Ctx = { params: Promise<{ id: string }> };

async function findOr404(id: string) {
  const recipe = await prisma.recipe.findUnique({ where: { id }, include: recipeInclude });
  if (!recipe) throw new ApiError("not_found", "No recipe with that id.");
  return recipe;
}

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  return NextResponse.json({ recipe: toRecipeDTO(await findOr404(id)) });
});

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await readJson(req);
  const data = parseRecipeWrite(body, { requireTitle: false });

  // Validate the payload BEFORE touching the DB, and read-then-write so a
  // missing recipe is a clean 404 rather than a Prisma P2025 leaking as a 500.
  await findOr404(id);
  if (Object.keys(data).length === 0) {
    throw new ApiError("bad_request", "Nothing to update.");
  }

  const recipe = await prisma.recipe.update({ where: { id }, data, include: recipeInclude });
  return NextResponse.json({ recipe: toRecipeDTO(recipe) });
});

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await findOr404(id);
  // Folder links cascade and grocery items are SET NULL — both declared on the
  // schema's foreign keys, so the database enforces it even if some future code
  // path deletes a recipe without going through this route.
  await prisma.recipe.delete({ where: { id } });
  return new NextResponse(null, { status: 204 });
});
