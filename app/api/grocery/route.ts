// GET /api/grocery — the list. POST — add a free-text line.
// DELETE ?checked=true — clear what has been ticked off.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ApiError, handle, requireString } from "@/lib/http";
import { toGroceryDTO } from "@/lib/serialize";
import { assertAllowedKeys, readJson } from "../_lib/json";

export const dynamic = "force-dynamic";

const withRecipe = { recipe: { select: { title: true } } } as const;

export const GET = handle(async () => {
  // Unchecked first, then oldest first *within* each group: items added from a
  // recipe arrive in ingredient order, and preserving it keeps the list readable
  // as a shopping list rather than a stack.
  const items = await prisma.groceryItem.findMany({
    orderBy: [{ checked: "asc" }, { createdAt: "asc" }],
    include: withRecipe,
  });
  return NextResponse.json({ items: items.map(toGroceryDTO) });
});

export const POST = handle(async (req: Request) => {
  const body = await readJson(req);
  assertAllowedKeys(body, ["text"]);
  const text = requireString(body.text, "text");
  const item = await prisma.groceryItem.create({ data: { text }, include: withRecipe });
  return NextResponse.json({ item: toGroceryDTO(item) }, { status: 201 });
});

export const DELETE = handle(async (req: Request) => {
  // `?checked=true` is required, not defaulted. A bare `DELETE /api/grocery`
  // that wiped the whole list would be one mistyped fetch away from losing the
  // shopping list — destructive operations should be hard to trigger by accident.
  const checked = new URL(req.url).searchParams.get("checked");
  if (checked !== "true") {
    throw new ApiError("bad_request", "Pass `?checked=true` to clear checked items.");
  }
  const { count } = await prisma.groceryItem.deleteMany({ where: { checked: true } });
  return NextResponse.json({ deleted: count });
});
