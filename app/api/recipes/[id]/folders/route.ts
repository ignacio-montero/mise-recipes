// PUT /api/recipes/:id/folders — replace the recipe's folder set.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ApiError, handle } from "@/lib/http";
import { recipeInclude, toRecipeDTO } from "@/lib/serialize";
import { asStringArray, assertAllowedKeys, readJson } from "../../../_lib/json";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// PUT, not PATCH, and deliberately: the body is the complete desired set, so the
// call is idempotent — sending it twice leaves the same state, which is what the
// folder-picker sheet needs when a tap is retried on a flaky tailnet.
export const PUT = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await readJson(req);
  assertAllowedKeys(body, ["folderIds"]);
  if (!Array.isArray(body.folderIds)) {
    throw new ApiError("bad_request", "`folderIds` must be an array of strings.");
  }
  const folderIds = Array.from(new Set(asStringArray(body.folderIds, "folderIds")));

  const recipe = await prisma.recipe.findUnique({ where: { id }, select: { id: true } });
  if (!recipe) throw new ApiError("not_found", "No recipe with that id.");

  if (folderIds.length > 0) {
    const found = await prisma.folder.findMany({
      where: { id: { in: folderIds } },
      select: { id: true },
    });
    if (found.length !== folderIds.length) {
      const missing = folderIds.filter((f) => !found.some((x) => x.id === f));
      throw new ApiError("bad_request", `Unknown folder id(s): ${missing.join(", ")}.`);
    }
  }

  // Delete-then-insert inside a transaction: a "replace the set" operation must
  // not be observable half-applied, and on SQLite the alternative (diffing adds
  // and removes) is more code for no gain at this row count.
  const updated = await prisma.$transaction(async (tx) => {
    await tx.folderRecipe.deleteMany({ where: { recipeId: id } });
    if (folderIds.length > 0) {
      await tx.folderRecipe.createMany({
        data: folderIds.map((folderId) => ({ folderId, recipeId: id })),
      });
    }
    return tx.recipe.findUniqueOrThrow({ where: { id }, include: recipeInclude });
  });

  return NextResponse.json({ recipe: toRecipeDTO(updated) });
});
