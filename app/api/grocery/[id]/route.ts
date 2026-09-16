// PATCH / DELETE one grocery item.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ApiError, handle, requireString } from "@/lib/http";
import { toGroceryDTO } from "@/lib/serialize";
import { asBoolean, assertAllowedKeys, readJson } from "../../_lib/json";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const withRecipe = { recipe: { select: { title: true } } } as const;

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await readJson(req);
  assertAllowedKeys(body, ["text", "checked"]);

  const data: { text?: string; checked?: boolean } = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  if (has("text")) data.text = requireString(body.text, "text");
  if (has("checked")) data.checked = asBoolean(body.checked, "checked");
  if (Object.keys(data).length === 0) throw new ApiError("bad_request", "Nothing to update.");

  const exists = await prisma.groceryItem.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw new ApiError("not_found", "No grocery item with that id.");

  const item = await prisma.groceryItem.update({ where: { id }, data, include: withRecipe });
  return NextResponse.json({ item: toGroceryDTO(item) });
});

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const exists = await prisma.groceryItem.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw new ApiError("not_found", "No grocery item with that id.");
  await prisma.groceryItem.delete({ where: { id } });
  return new NextResponse(null, { status: 204 });
});
