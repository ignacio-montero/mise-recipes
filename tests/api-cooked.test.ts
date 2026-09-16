// INTEGRATION tests for /api/recipes/:id/cooked — "I cooked it" and its undo.
//
// Against a REAL (disposable) SQLite file, like the other api-*.test.ts files,
// and for the same reason: the behaviour under test is not in a JS function, it
// is in what the DATABASE does with
//   UPDATE … SET cookedCount = cookedCount - 1 WHERE id = ? AND cookedCount > 0
// A mocked Prisma would happily "decrement" past zero and the suite would stay
// green while the real column went negative. The floor is a SQL WHERE clause,
// so the test has to reach SQL to see it.
//
// CONCEPT — IDEMPOTENCE. An operation is idempotent when doing it twice leaves
// the same state as doing it once. DELETE is expected to be: "make sure that
// cook is not counted". POST is not — each one adds a cook. The tests below pin
// both halves of that, because a phone in a kitchen produces double taps and
// retries on a flaky tailnet, and this is the difference between "harmless" and
// "the count drifts".

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, removeTempDatabase, useTempDatabase } from "./helpers/db";

// MUST run before any import of @/lib/prisma — hence the dynamic imports below.
const DB_FILE = useTempDatabase("cooked");

let prisma: typeof import("@/lib/prisma").prisma;
let cooked: typeof import("@/app/api/recipes/[id]/cooked/route");

beforeAll(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  await migrate(prisma);
  cooked = await import("@/app/api/recipes/[id]/cooked/route");
});

afterAll(async () => {
  await prisma.$disconnect();
  removeTempDatabase(DB_FILE);
});

beforeEach(async () => {
  await prisma.folderRecipe.deleteMany();
  await prisma.recipe.deleteMany();
  await prisma.folder.deleteMany();
});

async function seed(over: { cookedCount?: number; lastCookedAt?: Date | null } = {}) {
  return prisma.recipe.create({
    data: {
      title: "Crispy Shrimp Tacos",
      ingredients: JSON.stringify([{ item: "shrimp" }]),
      steps: JSON.stringify(["Cook it."]),
      tags: JSON.stringify([]),
      cookedCount: over.cookedCount ?? 0,
      lastCookedAt: over.lastCookedAt ?? null,
    },
  });
}

const markCooked = async (id: string) => {
  const res = await cooked.POST(
    new Request(`http://localhost/api/recipes/${id}/cooked`, { method: "POST" }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: await res.json() };
};

const undoCooked = async (id: string) => {
  const res = await cooked.DELETE(
    new Request(`http://localhost/api/recipes/${id}/cooked`, { method: "DELETE" }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: await res.json() };
};

describe("POST /api/recipes/:id/cooked", () => {
  it("increments and stamps the time", async () => {
    const r = await seed();
    const { status, body } = await markCooked(r.id);
    expect(status).toBe(200);
    expect(body.recipe.cookedCount).toBe(1);
    expect(body.recipe.lastCookedAt).not.toBeNull();
  });

  it("is NOT idempotent — each tap is another cook", async () => {
    const r = await seed();
    await markCooked(r.id);
    const { body } = await markCooked(r.id);
    expect(body.recipe.cookedCount).toBe(2);
  });

  it("404s on an unknown id", async () => {
    const { status, body } = await markCooked("nope");
    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });
});

describe("DELETE /api/recipes/:id/cooked (undo)", () => {
  it("decrements and returns the updated recipe, not 204", async () => {
    const r = await seed({ cookedCount: 3, lastCookedAt: new Date("2026-02-01T18:00:00Z") });
    const { status, body } = await undoCooked(r.id);
    expect(status).toBe(200);
    expect(body.recipe.cookedCount).toBe(2);
  });

  it("leaves lastCookedAt alone above zero — there is no cook history", async () => {
    const stamp = new Date("2026-02-01T18:00:00.000Z");
    const r = await seed({ cookedCount: 2, lastCookedAt: stamp });
    const { body } = await undoCooked(r.id);
    expect(body.recipe.lastCookedAt).toBe(stamp.toISOString());
  });

  it("clears lastCookedAt when the count reaches zero", async () => {
    const r = await seed({ cookedCount: 1, lastCookedAt: new Date() });
    const { body } = await undoCooked(r.id);
    expect(body.recipe.cookedCount).toBe(0);
    expect(body.recipe.lastCookedAt).toBeNull();
  });

  it("never goes negative, and stays 200 — idempotent at zero", async () => {
    const r = await seed({ cookedCount: 0 });
    const first = await undoCooked(r.id);
    const second = await undoCooked(r.id);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.recipe.cookedCount).toBe(0);

    // …and the column itself, not just the DTO: the floor is a WHERE clause, so
    // this is the assertion that would catch a read-modify-write regression.
    const row = await prisma.recipe.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.cookedCount).toBe(0);
  });

  it("self-heals a row that is at zero but still carries a date", async () => {
    const r = await seed({ cookedCount: 0, lastCookedAt: new Date() });
    const { body } = await undoCooked(r.id);
    expect(body.recipe.lastCookedAt).toBeNull();
  });

  it("404s on an unknown id — a missing recipe is not the same as nothing to undo", async () => {
    const { status, body } = await undoCooked("nope");
    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  it("cancels a cook exactly: POST then DELETE is where it started", async () => {
    const r = await seed({ cookedCount: 0 });
    await markCooked(r.id);
    const { body } = await undoCooked(r.id);
    expect(body.recipe.cookedCount).toBe(0);
    expect(body.recipe.lastCookedAt).toBeNull();
  });

  it("two concurrent undos at count 1 can only take one off", async () => {
    // The lost-update race the guarded UPDATE exists to prevent: read-modify-
    // write would let both calls read 1 and both write 0 (or -1). With the
    // floor in the WHERE clause, the loser matches zero rows and changes
    // nothing. SQLite serialises writes, so this asserts the guard, not the
    // isolation level — which is the part that could actually be got wrong.
    const r = await seed({ cookedCount: 1, lastCookedAt: new Date() });
    await Promise.all([undoCooked(r.id), undoCooked(r.id)]);
    const row = await prisma.recipe.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.cookedCount).toBe(0);
    expect(row.lastCookedAt).toBeNull();
  });

  it("keeps the recipe's folder links — undoing a cook is not an edit", async () => {
    const f = await prisma.folder.create({ data: { name: "desserts" } });
    const r = await seed({ cookedCount: 1, lastCookedAt: new Date() });
    await prisma.folderRecipe.create({ data: { folderId: f.id, recipeId: r.id } });
    const { body } = await undoCooked(r.id);
    expect(body.recipe.folderIds).toEqual([f.id]);
  });
});
