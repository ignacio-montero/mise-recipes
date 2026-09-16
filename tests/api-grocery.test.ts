// INTEGRATION tests for /api/grocery and /api/grocery/from-recipe/:id.
//
// The merge-and-sum logic is the reason this file exists. It is the one place
// where the app changes data the user already has on screen, so getting it
// wrong is worse than doing nothing: a shopper who ends up with "1 lb shrimp"
// when they needed 3 lb finds out in the shop.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, removeTempDatabase, useTempDatabase } from "./helpers/db";

const DB_FILE = useTempDatabase("grocery");

let prisma: typeof import("@/lib/prisma").prisma;
let listRoute: typeof import("@/app/api/grocery/route");
let itemRoute: typeof import("@/app/api/grocery/[id]/route");
let fromRecipe: typeof import("@/app/api/grocery/from-recipe/[id]/route");

beforeAll(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  await migrate(prisma);
  listRoute = await import("@/app/api/grocery/route");
  itemRoute = await import("@/app/api/grocery/[id]/route");
  fromRecipe = await import("@/app/api/grocery/from-recipe/[id]/route");
});

afterAll(async () => {
  await prisma.$disconnect();
  removeTempDatabase(DB_FILE);
});

beforeEach(async () => {
  await prisma.groceryItem.deleteMany();
  await prisma.recipe.deleteMany();
});

type Ing = { quantity?: string; unit?: string; item: string; note?: string };

async function recipeWith(ingredients: Ing[], title = "Crispy Shrimp Tacos") {
  return prisma.recipe.create({
    data: {
      title,
      ingredients: JSON.stringify(ingredients),
      steps: JSON.stringify(["Cook."]),
      tags: "[]",
    },
  });
}

async function addToList(id: string, body: Record<string, unknown> = {}) {
  const res = await fromRecipe.POST(
    new Request(`http://localhost/api/grocery/from-recipe/${id}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: await res.json() };
}

const texts = async () =>
  (await prisma.groceryItem.findMany({ orderBy: { createdAt: "asc" } })).map((i) => i.text);

describe("pushing a recipe onto the grocery list (PRD F11)", () => {
  it("adds one line per ingredient, rendered exactly as the cook view shows it", async () => {
    const r = await recipeWith([
      { quantity: "1", unit: "lb", item: "shrimp", note: "peeled" },
      { item: "Salt" },
    ]);
    const { status, body } = await addToList(r.id);
    expect(status).toBe(200);
    expect(body.added).toBe(2);
    // The note is deliberately NOT on the shopping line: "(peeled)" is a
    // preparation instruction, not something you buy.
    expect(await texts()).toEqual(["1 lb shrimp", "Salt"]);
  });

  it("scales the quantities on the way in", async () => {
    const r = await recipeWith([{ quantity: "1/2", unit: "cup", item: "cornstarch" }]);
    await addToList(r.id, { scale: 3 });
    expect(await texts()).toEqual(["1 1/2 cup cornstarch"]);
  });

  it("leaves an unscalable quantity exactly as written", async () => {
    const r = await recipeWith([{ quantity: "2-3", unit: "cloves", item: "garlic" }]);
    await addToList(r.id, { scale: 2 });
    expect(await texts()).toEqual(["2-3 cloves garlic"]);
  });

  it("rejects a nonsensical scale", async () => {
    const r = await recipeWith([{ item: "Salt" }]);
    for (const scale of [0, -1, 101, "2", true, [2], { n: 2 }]) {
      expect((await addToList(r.id, { scale })).status, String(scale)).toBe(400);
    }
    // Note for the reader: NaN and Infinity are NOT testable through this
    // route, because JSON has no way to encode them — `JSON.stringify({scale:
    // NaN})` emits `{"scale":null}`, which the route correctly reads as "not
    // supplied". The `Number.isFinite` check in the handler still earns its
    // keep for any non-HTTP caller, but asserting it here would be testing
    // JSON.stringify, not the route.
    expect((await addToList(r.id, { scale: null })).status).toBe(200); // null = "no scaling"
    expect((await addToList(r.id, { scale: 100 })).status).toBe(200); // the boundary itself is fine
  });

  it("rejects unknown body fields", async () => {
    const r = await recipeWith([{ item: "Salt" }]);
    expect((await addToList(r.id, { scale: 2, sneaky: true })).status).toBe(400);
  });

  it("404s for a recipe that does not exist", async () => {
    expect((await addToList("nope")).status).toBe(404);
  });

  it("returns the whole refreshed list, not just the new rows", async () => {
    await prisma.groceryItem.create({ data: { text: "Kitchen roll" } });
    const r = await recipeWith([{ item: "Salt" }]);
    const { body } = await addToList(r.id);
    expect(body.items.map((i: { text: string }) => i.text)).toEqual(["Kitchen roll", "Salt"]);
  });
});

describe("merging instead of duplicating", () => {
  it("sums two quantities of the same thing: 1 lb + 2 lb = 3 lb", async () => {
    await prisma.groceryItem.create({ data: { text: "1 lb shrimp" } });
    const r = await recipeWith([{ quantity: "2", unit: "lb", item: "shrimp" }]);

    const { body } = await addToList(r.id);
    expect(body.added).toBe(0); // merged, not added
    expect(await texts()).toEqual(["3 lb shrimp"]);
  });

  it("matches the ingredient name case-insensitively", async () => {
    await prisma.groceryItem.create({ data: { text: "1 lb shrimp" } });
    const r = await recipeWith([{ quantity: "2", unit: "lb", item: "Shrimp" }]);
    await addToList(r.id);
    expect(await texts()).toEqual(["3 lb shrimp"]);
  });

  it("KNOWN GAP: punctuation on the existing line defeats the merge (duplicate, never a lost item)", async () => {
    // ⚠️ This is a **characterisation test**: it pins behaviour that is not
    // what anyone wants, so that fixing it is a deliberate act rather than an
    // accident. Reported to the backend; see the report for the file/line.
    //
    // The route matches an ingredient to an existing line with `normaliseLine`
    // (strips punctuation) but then decides whether to SUM by comparing the
    // raw remainders — `"lb shrimp," !== "lb shrimp"`. Two layers, two
    // different notions of "same string": the classic cause of a
    // normalisation bug (same family as the canonical-URL mismatch in
    // lib/canonicalUrl.ts).
    //
    // The consequence is a cosmetic duplicate, NOT a lost ingredient, which is
    // why it is a warning and not a stop-ship. The assertions below are
    // written to say exactly that.
    await prisma.groceryItem.create({ data: { text: "1 lb Shrimp," } });
    const r = await recipeWith([{ quantity: "2", unit: "lb", item: "shrimp" }]);
    await addToList(r.id);

    const lines = await texts();
    expect(lines).toEqual(["1 lb Shrimp,", "2 lb shrimp"]); // ideally ["3 lb shrimp,"]
    // The invariant that actually matters, and which must hold either way:
    // nothing was invented and nothing was dropped.
    expect(lines.some((t) => /shrimp/i.test(t))).toBe(true);
    expect(lines).not.toContain("3 lb shrimp");
  });

  it("does NOT merge into an item that is already checked off", async () => {
    // A checked "butter" is already in the basket. Folding tonight's butter
    // into it would hide it from the shopper — the list would be silently
    // wrong in the one direction that costs a second trip.
    await prisma.groceryItem.create({ data: { text: "1 lb shrimp", checked: true } });
    const r = await recipeWith([{ quantity: "2", unit: "lb", item: "shrimp" }]);

    const { body } = await addToList(r.id);
    expect(body.added).toBe(1);
    expect(await texts()).toEqual(["1 lb shrimp", "2 lb shrimp"]);
  });

  it("collapses two mentions of the same ingredient inside ONE recipe", async () => {
    const r = await recipeWith([
      { quantity: "2", unit: "tbsp", item: "butter" },
      { quantity: "1", unit: "tbsp", item: "butter" },
    ]);
    await addToList(r.id);
    expect(await texts()).toEqual(["3 tbsp butter"]);
  });

  it("refuses to add up different units, and adds a second line rather than dropping it", async () => {
    // REGRESSION TEST. "1 cup shrimp" + "2 lb shrimp" have no honest sum — we
    // will not invent a conversion. But the first version of this route did
    // NOTHING in that branch: no merge and no create, while still answering 200
    // with `added: 0`. The ingredient vanished and the API said it had worked.
    //
    // That is a **silent failure**, the most expensive kind: a duplicate line
    // is noticed and ignored in two seconds, a missing line is noticed in the
    // shop. The two assertions encode that ranking — quantities are never
    // summed across units, AND the ingredient always reaches the list.
    await prisma.groceryItem.create({ data: { text: "1 cup shrimp" } });
    const r = await recipeWith([{ quantity: "2", unit: "lb", item: "shrimp" }]);
    const { body } = await addToList(r.id);

    expect(await texts()).toEqual(["1 cup shrimp", "2 lb shrimp"]);
    expect(body.added).toBe(1); // and the count it reports is the truth
    // No cross-unit arithmetic happened: "3" appears nowhere.
    expect((await texts()).join(" ")).not.toMatch(/\b3\b/);
  });

  it("refuses to add up when either side has no parseable quantity, and still lists it", async () => {
    // Same branch, other trigger: "Salt" has no leading number, so there is
    // nothing to add 1 tsp to. Same rule — keep both lines.
    await prisma.groceryItem.create({ data: { text: "Salt" } });
    const r = await recipeWith([{ quantity: "1", unit: "tsp", item: "salt" }]);
    const { body } = await addToList(r.id);

    expect(await texts()).toEqual(["Salt", "1 tsp salt"]);
    expect(body.added).toBe(1);
  });

  it("keeps different ingredients apart", async () => {
    await prisma.groceryItem.create({ data: { text: "1 lb shrimp" } });
    const r = await recipeWith([{ quantity: "1", unit: "lb", item: "shrimp paste" }]);
    await addToList(r.id);
    expect((await texts()).sort()).toEqual(["1 lb shrimp", "1 lb shrimp paste"]);
  });

  it("sums fractions the way a cook would write them", async () => {
    await prisma.groceryItem.create({ data: { text: "1/2 cup cornstarch" } });
    const r = await recipeWith([{ quantity: "1/4", unit: "cup", item: "cornstarch" }]);
    await addToList(r.id);
    expect(await texts()).toEqual(["3/4 cup cornstarch"]);
  });

  it("is idempotent in the sense that a second add keeps adding up, not duplicating", async () => {
    const r = await recipeWith([{ quantity: "1", unit: "lb", item: "shrimp" }]);
    await addToList(r.id);
    await addToList(r.id);
    expect(await texts()).toEqual(["2 lb shrimp"]);
  });
});

describe("the list itself", () => {
  it("puts unchecked items first, oldest first within each group", async () => {
    // Ingredient order is the order you cook in, and preserving it keeps the
    // list readable as a shopping list rather than a stack.
    const a = await prisma.groceryItem.create({ data: { text: "first", createdAt: new Date(2026, 0, 1) } });
    await prisma.groceryItem.create({ data: { text: "second", createdAt: new Date(2026, 0, 2) } });
    await prisma.groceryItem.update({ where: { id: a.id }, data: { checked: true } });
    await prisma.groceryItem.create({ data: { text: "third", createdAt: new Date(2026, 0, 3) } });

    const res = await listRoute.GET();
    const body = await res.json();
    expect(body.items.map((i: { text: string }) => i.text)).toEqual(["second", "third", "first"]);
  });

  it("adds a free-text line", async () => {
    const res = await listRoute.POST(
      new Request("http://localhost/api/grocery", { method: "POST", body: JSON.stringify({ text: "Kitchen roll" }) }),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).item.text).toBe("Kitchen roll");
  });

  it("rejects an empty line and unknown fields", async () => {
    const bad = async (body: unknown) =>
      (await listRoute.POST(new Request("http://localhost/api/grocery", { method: "POST", body: JSON.stringify(body) }))).status;
    expect(await bad({ text: "" })).toBe(400);
    expect(await bad({ text: "   " })).toBe(400);
    expect(await bad({ text: "ok", checked: true })).toBe(400);
    expect(await bad({})).toBe(400);
  });

  it("ticks an item off and renames it", async () => {
    const item = await prisma.groceryItem.create({ data: { text: "shrimp" } });
    const res = await itemRoute.PATCH(
      new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify({ checked: true, text: "big shrimp" }) }),
      { params: Promise.resolve({ id: item.id }) },
    );
    const body = await res.json();
    expect(body.item.checked).toBe(true);
    expect(body.item.text).toBe("big shrimp");
  });

  it("rejects a non-boolean checked and an empty patch", async () => {
    const item = await prisma.groceryItem.create({ data: { text: "shrimp" } });
    const patch = async (body: unknown) =>
      (await itemRoute.PATCH(new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify(body) }),
        { params: Promise.resolve({ id: item.id }) })).status;
    expect(await patch({ checked: "true" })).toBe(400);
    expect(await patch({})).toBe(400);
  });

  it("404s on an unknown item", async () => {
    const res = await itemRoute.DELETE(new Request("http://localhost/x", { method: "DELETE" }), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("clears ONLY checked items, and only when explicitly asked", async () => {
    // A bare `DELETE /api/grocery` that wiped the list would be one mistyped
    // fetch away from losing the shopping list mid-shop. Destructive operations
    // should be hard to trigger by accident.
    await prisma.groceryItem.create({ data: { text: "keep" } });
    await prisma.groceryItem.create({ data: { text: "drop", checked: true } });

    const refused = await listRoute.DELETE(new Request("http://localhost/api/grocery", { method: "DELETE" }));
    expect(refused.status).toBe(400);
    const alsoRefused = await listRoute.DELETE(new Request("http://localhost/api/grocery?checked=1", { method: "DELETE" }));
    expect(alsoRefused.status).toBe(400);

    const done = await listRoute.DELETE(new Request("http://localhost/api/grocery?checked=true", { method: "DELETE" }));
    expect(done.status).toBe(200);
    expect((await done.json()).deleted).toBe(1);
    expect(await texts()).toEqual(["keep"]);
  });
});
