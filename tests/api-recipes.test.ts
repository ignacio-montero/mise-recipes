// INTEGRATION tests for /api/recipes.
//
// Why integration rather than unit: the interesting behaviour of these routes
// is not in any one function, it is in the SEAM between the JS refinement pass
// and SQLite — `contains` over a JSON TEXT column, cursor pagination over a
// non-unique sort key, a UNIQUE constraint. Mocking Prisma here would mock out
// precisely the thing that can be wrong, and would happily pass while the real
// query returned nothing.
//
// So each of these API test files owns a REAL, disposable SQLite file
// (tests/.tmp-*.db), created from prisma/schema.prisma and deleted afterwards.
// That is the classic "test against a real database, but a throwaway one"
// tradeoff: a little slower than a mock, immeasurably more truthful.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, removeTempDatabase, useTempDatabase } from "./helpers/db";

// MUST run before any import of @/lib/prisma — hence the dynamic imports below.
const DB_FILE = useTempDatabase("recipes");

let prisma: typeof import("@/lib/prisma").prisma;
let list: typeof import("@/app/api/recipes/route");
let one: typeof import("@/app/api/recipes/[id]/route");

beforeAll(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  await migrate(prisma);
  list = await import("@/app/api/recipes/route");
  one = await import("@/app/api/recipes/[id]/route");
});

afterAll(async () => {
  await prisma.$disconnect();
  removeTempDatabase(DB_FILE);
});

beforeEach(async () => {
  // Fresh state per test. Deleting rows is faster than recreating the file and
  // keeps each test **independent** — a suite whose tests must run in a
  // particular order is a suite that will fail mysteriously in parallel.
  await prisma.groceryItem.deleteMany();
  await prisma.folderRecipe.deleteMany();
  await prisma.importJob.deleteMany();
  await prisma.recipe.deleteMany();
  await prisma.folder.deleteMany();
});

// ── helpers ──────────────────────────────────────────────────────────────────

type Seed = {
  title: string;
  description?: string | null;
  ingredients?: unknown[];
  tags?: string[];
  servings?: string | null;
  servingsCount?: number | null;
  favorite?: boolean;
  createdAt?: Date;
};

async function seed(r: Seed) {
  return prisma.recipe.create({
    data: {
      title: r.title,
      description: r.description ?? null,
      ingredients: JSON.stringify(r.ingredients ?? []),
      steps: JSON.stringify(["Cook it."]),
      tags: JSON.stringify(r.tags ?? []),
      servings: r.servings ?? null,
      servingsCount: r.servingsCount ?? null,
      favorite: r.favorite ?? false,
      ...(r.createdAt ? { createdAt: r.createdAt } : {}),
    },
  });
}

const getList = async (qs = "") => {
  const res = await list.GET(new Request(`http://localhost/api/recipes${qs}`));
  return { status: res.status, body: await res.json() };
};

const patch = async (id: string, body: unknown) => {
  const res = await one.PATCH(
    new Request(`http://localhost/api/recipes/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: await res.json() };
};

const post = async (body: unknown) => {
  const res = await list.POST(
    new Request("http://localhost/api/recipes", { method: "POST", body: JSON.stringify(body) }),
  );
  return { status: res.status, body: await res.json() };
};

// ── search ───────────────────────────────────────────────────────────────────

describe("free-text search (PRD F6)", () => {
  beforeEach(async () => {
    await seed({
      title: "Crispy Shrimp Tacos",
      ingredients: [{ quantity: "1", unit: "lb", item: "shrimp", note: "peeled" }],
      tags: ["mexican", "seafood"],
    });
    await seed({
      title: "Pesto Pasta",
      description: "A weeknight standby.",
      ingredients: [{ item: "basil", note: "serve with shrimp crackers on the side" }],
      tags: ["italian", "vegetarian"],
    });
    await seed({
      title: "Chicken Tikka",
      ingredients: [{ quantity: "500", unit: "g", item: "chicken thighs" }],
      tags: ["indian"],
    });
  });

  it("matches a word in the title", async () => {
    const { body } = await getList("?q=tikka");
    expect(body.recipes.map((r: { title: string }) => r.title)).toEqual(["Chicken Tikka"]);
  });

  it("matches case-insensitively", async () => {
    expect((await getList("?q=TIKKA")).body.recipes).toHaveLength(1);
    expect((await getList("?q=tIkKa")).body.recipes).toHaveLength(1);
  });

  it("matches an ingredient's item", async () => {
    const { body } = await getList("?q=shrimp");
    expect(body.recipes.map((r: { title: string }) => r.title)).toEqual(["Crispy Shrimp Tacos"]);
  });

  it("does NOT match text that only appears in an ingredient note", async () => {
    // The whole reason for the two-pass design. `ingredients` is a JSON TEXT
    // column, so the SQL pass can only LIKE over the blob and WILL match the
    // note "serve with shrimp crackers"; the JS pass is what applies the real
    // contract. If this test ever fails, searching "shrimp" starts returning
    // pesto pasta.
    const { body } = await getList("?q=crackers");
    expect(body.recipes).toHaveLength(0);
  });

  it("does not match a unit or a JSON key name", async () => {
    expect((await getList("?q=quantity")).body.recipes).toHaveLength(0);
    expect((await getList("?q=lb")).body.recipes).toHaveLength(0);
  });

  it("matches a tag and a description", async () => {
    expect((await getList("?q=italian")).body.recipes).toHaveLength(1);
    expect((await getList("?q=weeknight")).body.recipes).toHaveLength(1);
  });

  it("returns everything for an empty query and nothing for a miss", async () => {
    expect((await getList("")).body.recipes).toHaveLength(3);
    expect((await getList("?q=")).body.recipes).toHaveLength(3);
    expect((await getList("?q=zzzznope")).body.recipes).toHaveLength(0);
  });

  it("does not let a SQL metacharacter change the query", async () => {
    // Prisma parameterises, so `%` is a literal percent rather than a wildcard.
    // Worth pinning: a hand-rolled `LIKE '%' || q || '%'` would make this
    // return everything.
    expect((await getList("?q=%")).body.recipes).toHaveLength(0);
    expect((await getList("?q='")).body.recipes).toHaveLength(0);
  });
});

describe("filtering by tag", () => {
  beforeEach(async () => {
    await seed({ title: "Pesto Pasta", tags: ["vegetarian", "italian"] });
    await seed({ title: "Veg Box Curry", tags: ["veg"] });
  });

  it("matches a tag exactly, never as a substring", async () => {
    // `tag=veg` must NOT return the "vegetarian" recipe. The SQL pass searches
    // for the quoted form `"veg"` inside the JSON array and the JS pass then
    // compares whole strings — belt and braces, because `contains` alone would
    // still match `"vegetarian"` if the quoting changed.
    const { body } = await getList("?tag=veg");
    expect(body.recipes.map((r: { title: string }) => r.title)).toEqual(["Veg Box Curry"]);
  });

  it("matches the longer tag when that is what was asked for", async () => {
    const { body } = await getList("?tag=vegetarian");
    expect(body.recipes.map((r: { title: string }) => r.title)).toEqual(["Pesto Pasta"]);
  });

  it("is case-insensitive on the tag", async () => {
    expect((await getList("?tag=Vegetarian")).body.recipes).toHaveLength(1);
  });

  it("returns nothing for an unknown tag", async () => {
    expect((await getList("?tag=nope")).body.recipes).toHaveLength(0);
  });
});

describe("sorting, favourites and input validation", () => {
  it("rejects an unknown sort with a 400, not a 500", async () => {
    const { status, body } = await getList("?sort=magic");
    expect(status).toBe(400);
    expect(body.error.code).toBe("bad_request");
  });

  it("accepts the three documented sorts", async () => {
    for (const sort of ["recent", "title", "cooked"]) {
      expect((await getList(`?sort=${sort}`)).status).toBe(200);
    }
  });

  it("sorts by title when asked", async () => {
    await seed({ title: "Zucchini Fritters" });
    await seed({ title: "Apple Cake" });
    const { body } = await getList("?sort=title");
    expect(body.recipes.map((r: { title: string }) => r.title)).toEqual(["Apple Cake", "Zucchini Fritters"]);
  });

  it("filters favourites, treating false and 0 as 'not favourite'", async () => {
    await seed({ title: "Loved", favorite: true });
    await seed({ title: "Meh" });
    expect((await getList("?favorite=true")).body.recipes.map((r: { title: string }) => r.title)).toEqual(["Loved"]);
    expect((await getList("?favorite=false")).body.recipes.map((r: { title: string }) => r.title)).toEqual(["Meh"]);
    expect((await getList("?favorite=0")).body.recipes.map((r: { title: string }) => r.title)).toEqual(["Meh"]);
  });

  it("rejects a non-positive limit", async () => {
    expect((await getList("?limit=0")).status).toBe(400);
    expect((await getList("?limit=-5")).status).toBe(400);
    expect((await getList("?limit=abc")).status).toBe(400);
  });

  it("caps limit rather than serialising the whole table", async () => {
    // Denial-of-service guard: one request must not be able to ask a 640 MB
    // container to render every row it owns.
    expect((await getList("?limit=100000")).status).toBe(200);
  });

  it("rejects a cursor that no longer exists", async () => {
    // A deleted recipe used as a cursor makes Prisma throw something opaque;
    // turning it into a 400 tells the client to restart pagination.
    const { status, body } = await getList("?cursor=does-not-exist");
    expect(status).toBe(400);
    expect(body.error.message).toMatch(/cursor/i);
  });
});

describe("cursor pagination", () => {
  beforeEach(async () => {
    // Distinct createdAt values so the `recent` sort is deterministic.
    for (let i = 0; i < 5; i++) {
      await seed({ title: `Recipe ${i}`, createdAt: new Date(2026, 0, 1 + i) });
    }
  });

  it("returns a full page and walks to a null cursor at the end", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const { body } = await getList(`?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(body.recipes.length).toBeGreaterThan(0);
      expect(body.recipes.length).toBeLessThanOrEqual(2);
      seen.push(...body.recipes.map((r: { id: string }) => r.id));
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10); // a runaway loop is a failure, not a hang
    } while (cursor);

    // Every row exactly once, in newest-first order, and a null final cursor.
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(cursor).toBeNull();
  });

  it("never repeats a row across pages when the sort key is not unique", async () => {
    // `title` is not unique, which is why ORDER_BY appends `id` as a tiebreaker.
    // Without it, two recipes with the same title straddling a page boundary
    // can be served twice or skipped entirely.
    await prisma.recipe.deleteMany();
    for (let i = 0; i < 4; i++) await seed({ title: "Pesto" });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const { body } = await getList(`?sort=title&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...body.recipes.map((r: { id: string }) => r.id));
      cursor = body.nextCursor;
    } while (cursor);

    expect(new Set(seen).size).toBe(4);
  });
});

describe("creating a recipe by hand (PRD F9)", () => {
  it("creates one and forces the provenance to manual", async () => {
    const { status, body } = await post({ title: "Hand-typed", servings: "6-8 tacos" });
    expect(status).toBe(201);
    expect(body.recipe.sourcePlatform).toBe("manual");
    // servingsCount is derived at write time because the cook view's scaler
    // needs a number and "6-8 tacos" is not one.
    expect(body.recipe.servingsCount).toBe(6);
    expect(body.recipe.ingredients).toEqual([]);
  });

  it("requires a title", async () => {
    expect((await post({ description: "no title" })).status).toBe(400);
    expect((await post({ title: "   " })).status).toBe(400);
  });

  it("refuses to let a client claim a source platform", async () => {
    // Provenance (PRD F13) is only trustworthy if it cannot be asserted by the
    // caller — so `sourcePlatform` is not in the writable allowlist at all.
    const { status, body } = await post({ title: "Fake", sourcePlatform: "instagram" });
    expect(status).toBe(400);
    expect(body.error.message).toMatch(/sourcePlatform/);
  });

  it("rejects a body that is not a JSON object", async () => {
    const res = await list.POST(new Request("http://localhost/api/recipes", { method: "POST", body: "[]" }));
    expect(res.status).toBe(400);
    const res2 = await list.POST(new Request("http://localhost/api/recipes", { method: "POST", body: "{oops" }));
    expect(res2.status).toBe(400);
  });
});

describe("editing a recipe", () => {
  let id: string;
  beforeEach(async () => {
    id = (await seed({ title: "Original", servings: "4 servings", servingsCount: 4 })).id;
  });

  it("updates only the fields that were sent", async () => {
    const { status, body } = await patch(id, { title: "Corrected" });
    expect(status).toBe(200);
    expect(body.recipe.title).toBe("Corrected");
    expect(body.recipe.servings).toBe("4 servings"); // untouched
  });

  it("rejects an unknown field instead of silently ignoring it", async () => {
    // An allowlist, not a blocklist: a typo like `favourite` (British spelling)
    // must tell the caller it did nothing, rather than vanishing into the void.
    const { status, body } = await patch(id, { favourite: true });
    expect(status).toBe(400);
    expect(body.error.message).toMatch(/favourite/);
  });

  it("rejects ingredient payloads that are structurally wrong", async () => {
    // These are the shapes an LLM or a hand-written client actually produces.
    // A row with `item: null` would crash every later read of the recipe, so
    // the validation is field by field rather than "it's an array, ship it".
    const bad: unknown[] = [
      "not an array",
      [["nested array"]],
      [null],
      [{ quantity: "1" }], // no item
      [{ item: "" }], // empty item
      [{ item: "   " }], // whitespace item
      [{ item: "shrimp", quantity: 1 }], // quantity must be a string, not a number
      [{ item: "shrimp", note: { text: "x" } }],
    ];
    for (const ingredients of bad) {
      const { status } = await patch(id, { ingredients });
      expect(status, JSON.stringify(ingredients)).toBe(400);
    }
  });

  it("accepts a well-formed ingredient list and trims it", async () => {
    const { body } = await patch(id, {
      ingredients: [{ item: "  shrimp  ", quantity: " 1 ", unit: "lb", note: "" }],
    });
    // Empty optional fields are dropped rather than stored as "" — the DTO says
    // they are optional, and "" would render as a stray space in the cook view.
    expect(body.recipe.ingredients).toEqual([{ item: "shrimp", quantity: "1", unit: "lb" }]);
  });

  it("re-derives servingsCount whenever servings changes", async () => {
    // The bug this guards: change "4 servings" to "8 servings" and, without
    // re-derivation, the scaler keeps dividing by the stale 4 — every quantity
    // on the cook view silently doubles.
    const { body } = await patch(id, { servings: "8 tacos" });
    expect(body.recipe.servingsCount).toBe(8);
  });

  it("nulls servingsCount when the new servings has no number in it", async () => {
    const { body } = await patch(id, { servings: "a crowd" });
    expect(body.recipe.servingsCount).toBeNull();
  });

  it("lets an explicit servingsCount win over the derived one", async () => {
    // The human correcting a bad parse outranks the parser.
    const { body } = await patch(id, { servings: "6-8 tacos", servingsCount: 8 });
    expect(body.recipe.servingsCount).toBe(8);
  });

  it("validates servingsCount and totalMinutes at their boundaries", async () => {
    expect((await patch(id, { servingsCount: 0 })).status).toBe(400);
    expect((await patch(id, { servingsCount: 1 })).status).toBe(200);
    expect((await patch(id, { servingsCount: 999 })).status).toBe(200);
    expect((await patch(id, { servingsCount: 1000 })).status).toBe(400);
    expect((await patch(id, { servingsCount: 1.5 })).status).toBe(400);
    expect((await patch(id, { totalMinutes: -1 })).status).toBe(400);
    expect((await patch(id, { totalMinutes: 0 })).status).toBe(200);
    expect((await patch(id, { servingsCount: null })).status).toBe(200);
  });

  it("rejects an empty patch", async () => {
    expect((await patch(id, {})).status).toBe(400);
  });

  it("404s on an unknown id, for every verb", async () => {
    expect((await patch("nope", { title: "x" })).status).toBe(404);
    const got = await one.GET(new Request("http://localhost/api/recipes/nope"), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(got.status).toBe(404);
    const del = await one.DELETE(new Request("http://localhost/api/recipes/nope", { method: "DELETE" }), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(del.status).toBe(404);
  });

  it("validates the payload before it touches the database", async () => {
    // Ordering matters: a bad field on a missing recipe should still be a 400
    // about the field, and a valid-but-missing recipe a 404 — neither may be a
    // half-applied write.
    const before = await prisma.recipe.findUnique({ where: { id } });
    await patch(id, { title: "ok", ingredients: "nope" });
    const after = await prisma.recipe.findUnique({ where: { id } });
    expect(after!.title).toBe(before!.title);
  });
});

describe("deleting a recipe", () => {
  it("returns 204 and takes the recipe with it", async () => {
    const { id } = await seed({ title: "Doomed" });
    const res = await one.DELETE(new Request("http://localhost/api/recipes/x", { method: "DELETE" }), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(204);
    expect(await prisma.recipe.findUnique({ where: { id } })).toBeNull();
  });

  it("cascades folder links but keeps grocery items (the list outlives the recipe)", async () => {
    const { id } = await seed({ title: "Doomed" });
    const folder = await prisma.folder.create({ data: { name: "Weeknights" } });
    await prisma.folderRecipe.create({ data: { folderId: folder.id, recipeId: id } });
    await prisma.groceryItem.create({ data: { text: "1 lb shrimp", recipeId: id } });

    await one.DELETE(new Request("http://localhost/api/recipes/x", { method: "DELETE" }), {
      params: Promise.resolve({ id }),
    });

    expect(await prisma.folderRecipe.count()).toBe(0); // ON DELETE CASCADE
    const item = await prisma.groceryItem.findFirst();
    expect(item).not.toBeNull(); // ON DELETE SET NULL
    expect(item!.recipeId).toBeNull();
  });
});
