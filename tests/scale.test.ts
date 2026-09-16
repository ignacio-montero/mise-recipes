// UNIT tests for lib/scale.ts.
//
// Why unit tests here and nothing heavier: every function in this module is
// PURE (same input → same output, no clock, no network, no database). Pure
// logic is the base of the **test pyramid** — cheap, fast, and where the
// highest density of real bugs lives. It is also the module with the widest
// blast radius: the cook view and POST /api/grocery/from-recipe/:id both call
// it, so one wrong rounding rule is two visible bugs.
//
// The technique running through most of this file is **boundary-value and
// equivalence-class analysis**: pick the representative of each *class* of
// input (integer / decimal / decimal-comma / fraction / mixed / vulgar /
// unparseable) plus the values right at the edges (0, the division-by-zero
// denominator, the empty string).

import { describe, expect, it } from "vitest";
import {
  formatIngredient,
  formatQuantity,
  groceryKey,
  parseQuantity,
  parseServingsCount,
  scaleIngredient,
  scaleIngredients,
} from "@/lib/scale";
import type { Ingredient } from "@/lib/types";

describe("reading a quantity out of caption text", () => {
  it("reads plain integers and decimals", () => {
    expect(parseQuantity("2")).toBe(2);
    expect(parseQuantity("0.5")).toBe(0.5);
    expect(parseQuantity("  3  ")).toBe(3);
    expect(parseQuantity("1.25")).toBe(1.25);
  });

  it("reads a European decimal comma the way a European wrote it", () => {
    // "1,5 kg" is how half of Europe writes 1.5 kg. Number("1,5") is NaN, so
    // this only works because the module special-cases it.
    expect(parseQuantity("1,5")).toBe(1.5);
  });

  it("reads simple fractions", () => {
    expect(parseQuantity("1/2")).toBe(0.5);
    expect(parseQuantity("3/4")).toBe(0.75);
    expect(parseQuantity("1 / 2")).toBe(0.5); // spaces around the slash
  });

  it("reads mixed numbers", () => {
    expect(parseQuantity("1 1/2")).toBe(1.5);
    expect(parseQuantity("2 3/4")).toBe(2.75);
  });

  it("reads the vulgar-fraction glyphs captions actually use", () => {
    expect(parseQuantity("½")).toBe(0.5);
    expect(parseQuantity("¼")).toBe(0.25);
    expect(parseQuantity("¾")).toBe(0.75);
    expect(parseQuantity("⅛")).toBe(0.125);
    expect(parseQuantity("⅓")).toBeCloseTo(1 / 3, 10);
    expect(parseQuantity("⅔")).toBeCloseTo(2 / 3, 10);
  });

  it("refuses to guess rather than inventing a number", () => {
    // D-006: a wrong quantity in a recipe is worse than no scaling at all.
    // Each of these is a distinct class of "not confidently numeric".
    expect(parseQuantity("2-3")).toBeNull(); // a range
    expect(parseQuantity("a splash")).toBeNull(); // words
    expect(parseQuantity("")).toBeNull(); // empty string
    expect(parseQuantity("   ")).toBeNull(); // whitespace only
    expect(parseQuantity(undefined)).toBeNull();
    expect(parseQuantity(null)).toBeNull();
    expect(parseQuantity("to taste")).toBeNull();
    expect(parseQuantity("1 lb")).toBeNull(); // a unit is not part of quantity
  });

  it("returns null for a zero denominator instead of Infinity", () => {
    // Boundary value. Without the explicit guard this returns Infinity, which
    // formatQuantity would then render as "" and silently blank the quantity.
    expect(parseQuantity("1/0")).toBeNull();
    expect(parseQuantity("1 1/0")).toBeNull();
  });
});

describe("rendering a quantity back for a kitchen", () => {
  it("renders whole numbers without decoration", () => {
    expect(formatQuantity(2)).toBe("2");
    expect(formatQuantity(1)).toBe("1");
    expect(formatQuantity(12)).toBe("12");
  });

  it("renders the common kitchen fractions", () => {
    expect(formatQuantity(0.75)).toBe("3/4");
    expect(formatQuantity(0.5)).toBe("1/2");
    expect(formatQuantity(0.25)).toBe("1/4");
    expect(formatQuantity(1.5)).toBe("1 1/2");
    expect(formatQuantity(2.25)).toBe("2 1/4");
  });

  it("renders thirds as thirds, not as 0.333", () => {
    expect(formatQuantity(1 / 3)).toBe("1/3");
    expect(formatQuantity(2 / 3)).toBe("2/3");
    expect(formatQuantity(4 / 3)).toBe("1 1/3");
  });

  it("never emits a long decimal tail", () => {
    // The regression this guards: 5/6 has no representation in DENOMS with a
    // small enough error, so the fallback must round to one decimal rather
    // than printing "0.8333333333333334" on a phone screen.
    for (const n of [0.8333333333333334, 1 / 7, 2 / 7, 0.123456789, 7.7777]) {
      expect(formatQuantity(n)).toMatch(/^\d+(\.\d)?(?: \d+\/\d+)?$|^\d+\/\d+$/);
      expect(formatQuantity(n)).not.toMatch(/\.\d\d/);
    }
  });

  it("renders nothing for a quantity that is not a usable number", () => {
    expect(formatQuantity(0)).toBe("");
    expect(formatQuantity(-1)).toBe("");
    expect(formatQuantity(Number.NaN)).toBe("");
    expect(formatQuantity(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("quantity round-trip", () => {
  // Concept — **property-based thinking**. Rather than asserting a table of
  // specific pairs, assert the INVARIANT that must hold across a spread of
  // inputs: formatting then re-parsing must land back where we started. This
  // catches asymmetries between the two functions that no single example
  // would, e.g. a format the parser cannot read back.
  it("survives format → parse for the quantities a recipe actually contains", () => {
    const values = [
      0.125, 0.25, 1 / 3, 0.375, 0.5, 0.625, 2 / 3, 0.75, 0.875,
      1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 6, 8, 12, 0.2, 1.1, 2.4,
    ];
    for (const n of values) {
      const rendered = formatQuantity(n);
      const back = parseQuantity(rendered);
      expect(back, `formatQuantity(${n}) = "${rendered}" did not parse back`).not.toBeNull();
      // 0.05 tolerance: the renderer deliberately rounds to kitchen precision.
      expect(Math.abs((back as number) - n), `round-trip drift for ${n}`).toBeLessThan(0.06);
    }
  });
});

const ing = (over: Partial<Ingredient> = {}): Ingredient => ({
  quantity: "1",
  unit: "lb",
  item: "shrimp",
  ...over,
});

describe("scaling an ingredient", () => {
  it("is a no-op at 1x", () => {
    const source = ing({ quantity: "1 1/2" });
    // Identity, and the same object reference — scaling by 1 should not even
    // re-render "1 1/2" into "1 1/2" via a lossy round-trip.
    expect(scaleIngredient(source, 1)).toBe(source);
  });

  it("doubles, halves and 1.5x a numeric quantity", () => {
    expect(scaleIngredient(ing({ quantity: "1" }), 2).quantity).toBe("2");
    expect(scaleIngredient(ing({ quantity: "1/2" }), 2).quantity).toBe("1");
    expect(scaleIngredient(ing({ quantity: "1/2" }), 1.5).quantity).toBe("3/4"); // PRD F8
    expect(scaleIngredient(ing({ quantity: "2" }), 0.5).quantity).toBe("1");
    expect(scaleIngredient(ing({ quantity: "1 1/2" }), 2).quantity).toBe("3");
    expect(scaleIngredient(ing({ quantity: "½" }), 3).quantity).toBe("1 1/2");
  });

  it("passes unparseable quantities through byte-identical", () => {
    // The core promise of D-006. Not "approximately preserved" — identical,
    // including the surrounding fields, so "2-3 cloves garlic" is never
    // silently rewritten into "4-6" or, worse, "5".
    for (const quantity of ["2-3", "a splash", "to taste", "a few"]) {
      const source = ing({ quantity });
      const scaled = scaleIngredient(source, 2);
      expect(scaled.quantity).toBe(quantity);
      expect(scaled).toEqual(source);
    }
  });

  it("leaves an ingredient with no quantity alone", () => {
    const source: Ingredient = { item: "Salt", note: "to taste" };
    expect(scaleIngredient(source, 3)).toEqual(source);
  });

  it("keeps unit, item and note untouched while scaling", () => {
    const scaled = scaleIngredient(ing({ quantity: "1", note: "peeled" }), 2);
    expect(scaled).toEqual({ quantity: "2", unit: "lb", item: "shrimp", note: "peeled" });
  });

  it("scales a whole list, mixing parseable and unparseable lines", () => {
    const list: Ingredient[] = [
      { quantity: "1", unit: "lb", item: "shrimp" },
      { quantity: "2-3", unit: "cloves", item: "garlic" },
      { item: "Salt" },
    ];
    expect(scaleIngredients(list, 2)).toEqual([
      { quantity: "2", unit: "lb", item: "shrimp" },
      { quantity: "2-3", unit: "cloves", item: "garlic" },
      { item: "Salt" },
    ]);
  });

  it("does not mutate the list it was given", () => {
    // Shared module: the cook view scales the same array on every tap of the
    // servings stepper. In-place mutation would compound (2x then 2x = 4x).
    const list: Ingredient[] = [{ quantity: "1", unit: "cup", item: "rice" }];
    scaleIngredients(list, 4);
    expect(list[0].quantity).toBe("1");
  });
});

describe("rendering an ingredient as one line", () => {
  it("joins quantity, unit and item", () => {
    expect(formatIngredient(ing())).toBe("1 lb shrimp");
  });

  it("omits the parts that are missing without leaving double spaces", () => {
    expect(formatIngredient({ item: "Salt" })).toBe("Salt");
    expect(formatIngredient({ quantity: "2", item: "eggs" })).toBe("2 eggs");
    expect(formatIngredient({ unit: "pinch", item: "saffron" })).toBe("pinch saffron");
    expect(formatIngredient({ quantity: "  1  ", unit: " lb ", item: " shrimp " })).toBe("1 lb shrimp");
  });

  it("appends the note only when asked", () => {
    const withNote = ing({ note: "diced" });
    expect(formatIngredient(withNote)).toBe("1 lb shrimp");
    expect(formatIngredient(withNote, { withNote: true })).toBe("1 lb shrimp (diced)");
    expect(formatIngredient(ing({ note: "  " }), { withNote: true })).toBe("1 lb shrimp");
  });
});

describe("the key that merges two grocery lines into one", () => {
  it("treats case and punctuation as noise", () => {
    expect(groceryKey({ item: "Shrimp" })).toBe(groceryKey({ item: "shrimp" }));
    expect(groceryKey({ item: "Shrimp," })).toBe("shrimp");
    expect(groceryKey({ item: "  Olive   Oil  " })).toBe("olive oil");
    expect(groceryKey({ item: "Crème fraîche" })).toBe("crme frache"); // accents stripped
  });

  it("keeps genuinely different items apart", () => {
    expect(groceryKey({ item: "shrimp" })).not.toBe(groceryKey({ item: "shrimp paste" }));
  });

  it("returns an empty key for an item that is pure punctuation", () => {
    // The grocery route checks `if (!key)` before merging, so this empty-string
    // case is load-bearing: without it every punctuation-only item would merge
    // into a single line.
    expect(groceryKey({ item: "---" })).toBe("");
  });
});

describe("deriving the servings number the scaler counts from", () => {
  it("takes the first number out of a human phrase", () => {
    expect(parseServingsCount("6-8 tacos")).toBe(6);
    expect(parseServingsCount("Serves 4")).toBe(4);
    expect(parseServingsCount("4")).toBe(4);
    expect(parseServingsCount("makes 12 cookies")).toBe(12);
    expect(parseServingsCount("2 servings")).toBe(2);
  });

  it("rounds a fractional yield to a whole number of servings", () => {
    expect(parseServingsCount("3.5 portions")).toBe(4);
  });

  it("gives up rather than guessing", () => {
    expect(parseServingsCount("a crowd")).toBeNull();
    expect(parseServingsCount("")).toBeNull();
    expect(parseServingsCount(null)).toBeNull();
    expect(parseServingsCount(undefined)).toBeNull();
  });

  it("rejects out-of-range values at the boundaries", () => {
    expect(parseServingsCount("0 servings")).toBeNull(); // 0 would divide by zero
    expect(parseServingsCount("999 servings")).toBe(999); // last accepted value
    expect(parseServingsCount("1000 servings")).toBeNull(); // first rejected value
    expect(parseServingsCount("serves 1000000")).toBeNull();
  });
});
