// GET /api/folders — with recipe counts. POST /api/folders — create.
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, handle, requireString } from "@/lib/http";
import { toFolderDTO } from "@/lib/serialize";
import { asNullableString, assertAllowedKeys, readJson } from "../_lib/json";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  // `_count` becomes a single correlated subquery. Fetching folders and then
  // counting recipes per folder in a loop is the classic N+1 query — one request
  // turning into 1 + N round trips.
  const folders = await prisma.folder.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { recipes: true } } },
  });
  return NextResponse.json({ folders: folders.map(toFolderDTO) });
});

export const POST = handle(async (req: Request) => {
  const body = await readJson(req);
  assertAllowedKeys(body, ["name", "emoji"]);
  const name = requireString(body.name, "name");
  const emoji = body.emoji === undefined ? null : asNullableString(body.emoji, "emoji");

  try {
    const folder = await prisma.folder.create({
      data: { name, emoji },
      include: { _count: { select: { recipes: true } } },
    });
    return NextResponse.json({ folder: toFolderDTO(folder) }, { status: 201 });
  } catch (e) {
    // Catch the unique-constraint violation instead of SELECTing first: a
    // check-then-insert has a race window between the two statements, and the
    // database is the only thing that can decide uniqueness atomically.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ApiError("conflict", "A folder with that name already exists.");
    }
    throw e;
  }
});
