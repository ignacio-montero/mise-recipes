// UNIT tests for components/cooked.ts — the cooked counter's arithmetic.
//
// WHY THIS FILE EXISTS AT ALL, given that tests/api-cooked.test.ts already
// tests the same rule against a real database: the rule is implemented TWICE on
// purpose. The server owns the truth; the client reproduces it so the number
// can move before the round trip finishes (optimistic UI). Two implementations
// of one rule is exactly the situation where a test suite earns its keep — the
// failure mode is not a crash, it is a count that flickers 3 → 4 → 3 because
// the client guessed differently from the server. These cases and the route's
// cases are deliberately the same cases.

import { describe, expect, it } from "vitest";
import {
  applyCookedDelta,
  canUndoCooked,
  cookedLine,
  cookedToastText,
  undoCookedLabel,
} from "@/components/cooked";

const NOW = new Date("2026-03-01T19:30:00.000Z");

describe("applyCookedDelta", () => {
  it("counts a cook and stamps the time", () => {
    const next = applyCookedDelta({ cookedCount: 2, lastCookedAt: null }, 1, NOW);
    expect(next).toEqual({ cookedCount: 3, lastCookedAt: "2026-03-01T19:30:00.000Z" });
  });

  it("undoes a cook and leaves the date alone above zero", () => {
    // There is no cook history, so the date of the cook before last is not
    // knowable. Leaving it is the honest answer; inventing one is not.
    const next = applyCookedDelta(
      { cookedCount: 3, lastCookedAt: "2026-02-20T10:00:00.000Z" },
      -1,
      NOW,
    );
    expect(next).toEqual({ cookedCount: 2, lastCookedAt: "2026-02-20T10:00:00.000Z" });
  });

  it("clears lastCookedAt when the count reaches zero", () => {
    const next = applyCookedDelta({ cookedCount: 1, lastCookedAt: "2026-02-20T10:00:00.000Z" }, -1);
    expect(next).toEqual({ cookedCount: 0, lastCookedAt: null });
  });

  it("never goes negative", () => {
    const next = applyCookedDelta({ cookedCount: 0, lastCookedAt: null }, -1);
    expect(next.cookedCount).toBe(0);
  });

  it("does not mutate its input — React compares by reference", () => {
    const before = { cookedCount: 1, lastCookedAt: "2026-02-20T10:00:00.000Z" };
    const after = applyCookedDelta(before, -1);
    expect(before).toEqual({ cookedCount: 1, lastCookedAt: "2026-02-20T10:00:00.000Z" });
    expect(after).not.toBe(before);
  });

  it("carries the rest of the recipe through untouched", () => {
    const recipe = { id: "r1", title: "Tacos", cookedCount: 0, lastCookedAt: null };
    expect(applyCookedDelta(recipe, 1, NOW)).toMatchObject({ id: "r1", title: "Tacos" });
  });

  it("round-trips: one cook then one undo is the starting state", () => {
    const start = { cookedCount: 0, lastCookedAt: null };
    expect(applyCookedDelta(applyCookedDelta(start, 1, NOW), -1)).toEqual(start);
  });
});

describe("canUndoCooked", () => {
  it("is false at zero, true above it", () => {
    expect(canUndoCooked({ cookedCount: 0 })).toBe(false);
    expect(canUndoCooked({ cookedCount: 1 })).toBe(true);
  });
});

describe("cookedToastText", () => {
  it("confirms a cook", () => {
    expect(cookedToastText(3, "cooked")).toBe("Cooked 3×. Nice.");
  });

  it("confirms an undo, and says so plainly at zero", () => {
    expect(cookedToastText(2, "undone")).toBe("Undone — cooked 2× now.");
    expect(cookedToastText(0, "undone")).toBe("Undone — not cooked yet.");
  });
});

describe("cookedLine", () => {
  it("reads as a sentence with a relative time", () => {
    expect(cookedLine(3, "yesterday")).toBe("Cooked 3× · last yesterday");
  });

  it("drops the trailing separator when there is no date", () => {
    // relativeTime() returns "" for a null timestamp — which is exactly the
    // state a recipe is in right after the count is undone down to 1 on a
    // record that never had a date.
    expect(cookedLine(1, "")).toBe("Cooked 1×");
  });

  it("has something to say at zero", () => {
    expect(cookedLine(0, "whenever")).toBe("Not cooked yet");
  });
});

describe("undoCookedLabel", () => {
  it("says what the button DOES, not what the row shows", () => {
    expect(undoCookedLabel(1)).toBe("Undo one cook — cooked 1 time");
    expect(undoCookedLabel(4)).toBe("Undo one cook — cooked 4 times");
  });
});
