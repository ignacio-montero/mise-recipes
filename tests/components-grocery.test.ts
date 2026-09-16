// UNIT tests for components/grocery.ts — the grocery list's array arithmetic.
//
// WHY THESE ARE UNIT TESTS AND NOT RENDERED-COMPONENT TESTS
// ---------------------------------------------------------
// This is the **test pyramid** again, from the frontend side. The behaviour
// worth pinning here ("what does the list look like after ticking item X?") is
// a pure function of data. The frontend agent extracted it out of the component
// precisely so it could be tested without a DOM, a fetch mock, a React renderer
// or `@testing-library` — none of which this project has as a dependency.
// Testing the same thing through a rendered component would be slower, flakier,
// and would fail for a dozen reasons that have nothing to do with the logic.
//
// What that leaves untested, deliberately: that the component actually CALLS
// these functions, and that it calls them in the right order. That is a real
// gap and it is named in the report — it is the kind of thing an E2E test
// catches, and this project has no E2E harness yet.
//
// CONCEPT — OPTIMISTIC UPDATE. Each of these functions is half of one: the UI
// paints the result of a tap immediately, sends the request afterwards, and
// paints the PREVIOUS state again if the server disagrees. That is why every
// function must be pure and must return a new array — "recompute the state
// from scratch" is the only rollback strategy that is correct by construction.

import { describe, expect, it } from "vitest";
import {
  applyChecked,
  checkedCount,
  cleanNewItem,
  progressLine,
  removeById,
  sourceLabel,
  splitByChecked,
  upsert,
} from "@/components/grocery";
import type { GroceryItem } from "@/components/types";

const item = (over: Partial<GroceryItem> & { id: string }): GroceryItem => ({
  text: "1 lb shrimp",
  checked: false,
  recipeId: null,
  recipeTitle: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const LIST: GroceryItem[] = [
  item({ id: "a", text: "shrimp" }),
  item({ id: "b", text: "mayo", checked: true }),
  item({ id: "c", text: "tortillas" }),
];

describe("splitByChecked", () => {
  it("puts unchecked first, preserving the order within each group", () => {
    // Order is meaningful: ingredient order is the order you cook in, and the
    // server sorts the same way. The client re-derives it after an optimistic
    // tick so the item moves immediately rather than on the next load.
    const { open, done } = splitByChecked(LIST);
    expect(open.map((i) => i.id)).toEqual(["a", "c"]);
    expect(done.map((i) => i.id)).toEqual(["b"]);
  });

  it("handles the empty list and an all-checked list", () => {
    expect(splitByChecked([])).toEqual({ open: [], done: [] });
    const allDone = LIST.map((i) => ({ ...i, checked: true }));
    expect(splitByChecked(allDone).open).toEqual([]);
    expect(splitByChecked(allDone).done).toHaveLength(3);
  });
});

describe("applyChecked", () => {
  it("flips exactly one item", () => {
    const next = applyChecked(LIST, "a", true);
    expect(next.find((i) => i.id === "a")!.checked).toBe(true);
    expect(next.find((i) => i.id === "c")!.checked).toBe(false);
  });

  it("returns NEW objects for the changed item, not a mutated one", () => {
    // ⚠️ The single most common "my state update did nothing" bug in React.
    // React decides whether to re-render by comparing references (`Object.is`),
    // so mutating `item.checked` in place and calling `setItems(items)` changes
    // the data and changes NOTHING on screen. Asserting on identity, not on
    // value, is the only way a test can tell the difference — a value assertion
    // passes happily for the broken version.
    const before = LIST[0]!;
    const next = applyChecked(LIST, "a", true);
    expect(next).not.toBe(LIST);
    expect(next[0]).not.toBe(before);
    expect(before.checked).toBe(false); // the input was not touched
    // Untouched items may be shared by reference — that is the point of an
    // immutable update, and it is what keeps re-renders cheap.
    expect(next[1]).toBe(LIST[1]);
  });

  it("is a no-op for an id that is not in the list", () => {
    // Reachable in practice: a delete can land between the render and the tap.
    expect(applyChecked(LIST, "ghost", true)).toEqual(LIST);
  });
});

describe("removeById", () => {
  it("removes the matching item and leaves the rest alone", () => {
    expect(removeById(LIST, "b").map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("is a no-op for an unknown id, and safe on an empty list", () => {
    expect(removeById(LIST, "ghost")).toHaveLength(3);
    expect(removeById([], "a")).toEqual([]);
  });
});

describe("upsert", () => {
  it("appends an item that is not there yet", () => {
    expect(upsert(LIST, item({ id: "d", text: "limes" })).map((i) => i.id))
      .toEqual(["a", "b", "c", "d"]);
  });

  it("REPLACES in place when the id is already present, keeping the position", () => {
    // This branch is the one that matters: `POST /api/grocery/from-recipe/:id`
    // returns the whole refreshed list, including rows already on screen whose
    // TEXT changed because a merge rewrote them ("1 lb shrimp" → "3 lb shrimp").
    // Appending instead of replacing would show the same line twice with two
    // different quantities.
    const next = upsert(LIST, item({ id: "b", text: "2 tbsp mayo", checked: true }));
    expect(next).toHaveLength(3);
    expect(next[1]!.text).toBe("2 tbsp mayo");
    expect(next.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the array it was given", () => {
    const copy = [...LIST];
    upsert(LIST, item({ id: "b", text: "changed" }));
    expect(LIST).toEqual(copy);
  });
});

describe("checkedCount and progressLine", () => {
  it("counts what is in the basket", () => {
    expect(checkedCount(LIST)).toBe(1);
    expect(checkedCount([])).toBe(0);
  });

  it("renders a whole sentence, because VoiceOver reads it aloud", () => {
    expect(progressLine(LIST)).toBe("1 of 3 in the basket");
  });

  it("says nothing at all for an empty list", () => {
    // "0 of 0 in the basket" under an empty-state illustration is the kind of
    // detail that makes an app feel unfinished. The empty string is the signal
    // to render nothing.
    expect(progressLine([])).toBe("");
  });

  it("handles the all-done boundary", () => {
    expect(progressLine(LIST.map((i) => ({ ...i, checked: true })))).toBe("3 of 3 in the basket");
  });
});

describe("sourceLabel", () => {
  it("names the recipe a line came from", () => {
    expect(sourceLabel({ recipeTitle: "Crispy Shrimp Tacos" })).toBe("from Crispy Shrimp Tacos");
  });

  it("says nothing for a free-text line or an orphaned one", () => {
    // API_SPEC §3: deleting a recipe KEEPS its grocery lines but unlinks them,
    // so `recipeTitle: null` on a real row is normal, not a bug. Rendering
    // "from null" in the shop is the failure this guards against.
    expect(sourceLabel({ recipeTitle: null })).toBe("");
    expect(sourceLabel({ recipeTitle: "   " })).toBe("");
  });
});

describe("cleanNewItem", () => {
  it("trims and collapses internal whitespace", () => {
    expect(cleanNewItem("  2   tbsp   mayo  ")).toBe("2 tbsp mayo");
  });

  it("returns null for anything not worth POSTing", () => {
    // Returning null rather than "" lets the caller no-op SILENTLY instead of
    // round-tripping to the server just to be told "`text` is required". Client
    // validation as a courtesy; the server still validates, because a client
    // check is never a security boundary.
    expect(cleanNewItem("")).toBeNull();
    expect(cleanNewItem("   ")).toBeNull();
    expect(cleanNewItem("\n\t ")).toBeNull();
  });

  it("keeps a single character, because 'ice' and 'x' are both valid lines", () => {
    expect(cleanNewItem("x")).toBe("x");
  });
});
