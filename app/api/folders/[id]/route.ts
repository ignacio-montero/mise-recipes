// PATCH / DELETE a folder.
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, handle, requireString } from "@/lib/http";
import { toFolderDTO } from "@/lib/serialize";
import { asNullableString, assertAllowedKeys, readJson } from "../../_lib/json";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await readJson(req);
  assertAllowedKeys(body, ["name", "emoji"]);

  const data: { name?: string; emoji?: string | null } = {};
  if (Object.prototype.hasOwnProperty.call(body, "name")) data.name = requireString(body.name, "name");
  if (Object.prototype.hasOwnProperty.call(body, "emoji")) data.emoji = asNullableString(body.emoji, "emoji");
  if (Object.keys(data).length === 0) throw new ApiError("bad_request", "Nothing to update.");

  const exists = await prisma.folder.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw new ApiError("not_found", "No folder with that id.");

  try {
    const folder = await prisma.folder.update({
      where: { id },
      data,
      include: { _count: { select: { recipes: true } } },
    });
    return NextResponse.json({ folder: toFolderDTO(folder) });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ApiError("conflict", "A folder with that name already exists.");
    }
    throw e;
  }
});

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const exists = await prisma.folder.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw new ApiError("not_found", "No folder with that id.");

  // Only the join rows go (ON DELETE CASCADE on FolderRecipe). Deleting a folder
  // must never delete recipes — a folder is a label, not a container.
  await prisma.folder.delete({ where: { id } });
  return new NextResponse(null, { status: 204 });
});
