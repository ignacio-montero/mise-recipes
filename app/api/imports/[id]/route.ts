// GET /api/imports/:id — the poll endpoint. The PWA hits this every 1.5 s while
// a job is open, so it stays a single indexed lookup plus one join.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ApiError, handle } from "@/lib/http";
import { recipeInclude, toRecipeDTO } from "@/lib/serialize";
import { toImportJobDTO } from "../../_lib/import-dto";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const job = await prisma.importJob.findUnique({
    where: { id },
    include: { recipe: { include: recipeInclude } },
  });
  if (!job) throw new ApiError("not_found", "No import job with that id.");

  // The contract says `recipe` appears only when the job is done — a half-written
  // recipe attached to a running job would let the UI navigate to it too early.
  const recipe = job.status === "done" && job.recipe ? toRecipeDTO(job.recipe) : null;
  return NextResponse.json(toImportJobDTO(job, recipe));
});
