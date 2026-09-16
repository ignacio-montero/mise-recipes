// UNIT tests for components/folders.ts — the folder UI's decisions.
//
// The same split as components-grocery.test.ts: the sheets keep the effects
// (fetch, focus, sheets opening), everything that decides something lives in a
// pure module and is tested here without a DOM or a React renderer. What that
// deliberately leaves untested is that the components CALL these functions —
// the gap an E2E harness would close, which this project doesn't have yet.

import { describe, expect, it } from "vitest";
import {
  ALL,
  UNFILED,
  applyFolderCountDelta,
  cleanEmoji,
  cleanFolderName,
  deleteFolderWarning,
  filterByFolder,
  folderLabel,
  folderQueryParam,
  folderSummary,
  knownIds,
  nameTaken,
  needsClientFilter,
  removeFolderById,
  sameFilter,
  sameIdSet,
  sortFolders,
  toggleFilter,
  toggleFolderId,
  upsertFolder,
  type FolderFilter,
} from "@/components/folders";
import type { Folder } from "@/components/types";

const folder = (over: Partial<Folder> & { id: string; name: string }): Folder => ({
  emoji: null,
  recipeCount: 0,
  ...over,
});

const DESSERTS = folder({ id: "f1", name: "desserts", emoji: "🍰", recipeCount: 3 });
const BATCH = folder({ id: "f2", name: "batch-cooking", recipeCount: 5 });

// ── The filter selection ────────────────────────────────────────────────────

describe("FolderFilter", () => {
  it("compares by kind and id", () => {
    expect(sameFilter(ALL, { kind: "all" })).toBe(true);
    expect(sameFilter(ALL, UNFILED)).toBe(false);
    expect(sameFilter({ kind: "folder", id: "f1" }, { kind: "folder", id: "f1" })).toBe(true);
    expect(sameFilter({ kind: "folder", id: "f1" }, { kind: "folder", id: "f2" })).toBe(false);
  });

  it("tapping the active chip returns to All — a filter must be escapable", () => {
    const desserts: FolderFilter = { kind: "folder", id: "f1" };
    expect(toggleFilter(desserts, desserts)).toEqual(ALL);
    expect(toggleFilter(ALL, desserts)).toEqual(desserts);
    expect(toggleFilter(UNFILED, UNFILED)).toEqual(ALL);
  });

  it("maps Unfiled to the reserved ?folder=none, and a folder to its id", () => {
    expect(folderQueryParam(ALL)).toBeNull();
    // Unfiled is now the SERVER's job: `?folder=none` is a reserved value that
    // app/api/recipes/route.ts turns into `where.folders = { none: {} }`. It
    // used to send nothing and let the client filter, which could only ever see
    // the page already loaded — correct until the list paginated.
    expect(folderQueryParam(UNFILED)).toBe("none");
    expect(folderQueryParam({ kind: "folder", id: "f1" })).toBe("f1");
  });

  it("no filter needs the client to finish the job any more", () => {
    expect(needsClientFilter(ALL)).toBe(false);
    expect(needsClientFilter({ kind: "folder", id: "f1" })).toBe(false);
    expect(needsClientFilter(UNFILED)).toBe(false);
  });
});

describe("filterByFolder", () => {
  const recipes = [
    { id: "r1", folderIds: [] },
    { id: "r2", folderIds: ["f1"] },
    { id: "r3", folderIds: ["f1", "f2"] },
  ];

  it("passes everything through when the server already filtered", () => {
    expect(filterByFolder(recipes, ALL).map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
    expect(filterByFolder(recipes, { kind: "folder", id: "f1" }).map((r) => r.id)).toEqual([
      "r1",
      "r2",
      "r3",
    ]);
  });

  it("passes every recipe through, because the server already filtered", () => {
    // The server now answers `?folder=none` itself, so this helper is a
    // pass-through. Kept as the seam for any future filter the API cannot do.
    expect(filterByFolder(recipes, UNFILED).map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("returns a new array, never the same reference", () => {
    expect(filterByFolder(recipes, ALL)).not.toBe(recipes);
  });
});

// ── Names and emoji ─────────────────────────────────────────────────────────

describe("cleanFolderName", () => {
  it("trims and collapses whitespace", () => {
    expect(cleanFolderName("  batch   cooking ")).toBe("batch cooking");
  });

  it("returns null for nothing worth sending", () => {
    expect(cleanFolderName("")).toBeNull();
    expect(cleanFolderName("   ")).toBeNull();
    expect(cleanFolderName("\n\t")).toBeNull();
  });

  it("caps the length so a paste can't blow out the chip row", () => {
    expect(cleanFolderName("x".repeat(200))).toHaveLength(40);
  });
});

describe("cleanEmoji", () => {
  it("keeps one glyph, not one UTF-16 code unit", () => {
    // "🍰".length === 2 in JS — it is a surrogate PAIR. Taking raw[0] would
    // return half a character and render as a replacement box.
    expect(cleanEmoji("🍰")).toBe("🍰");
    expect(cleanEmoji("🍰🍪")).toBe("🍰");
  });

  it("keeps a variation selector and a skin-tone modifier with its glyph", () => {
    expect(cleanEmoji("▶️")).toBe("▶️");
    expect(cleanEmoji("👍🏽")).toBe("👍🏽");
  });

  it("keeps a ZWJ sequence together", () => {
    expect(cleanEmoji("👩‍🍳")).toBe("👩‍🍳");
  });

  it("is null when nothing was typed", () => {
    expect(cleanEmoji("")).toBeNull();
    expect(cleanEmoji("   ")).toBeNull();
  });
});

describe("folderLabel", () => {
  it("joins an emoji to the name, and copes without one", () => {
    expect(folderLabel(DESSERTS)).toBe("🍰 desserts");
    expect(folderLabel(BATCH)).toBe("batch-cooking");
  });
});

describe("sortFolders", () => {
  it("sorts case-insensitively, unlike SQLite's byte order", () => {
    const list = [folder({ id: "a", name: "Desserts" }), folder({ id: "b", name: "batch" })];
    expect(sortFolders(list).map((f) => f.name)).toEqual(["batch", "Desserts"]);
  });

  it("does not mutate the input", () => {
    const list = [DESSERTS, BATCH];
    sortFolders(list);
    expect(list.map((f) => f.id)).toEqual(["f1", "f2"]);
  });
});

describe("nameTaken", () => {
  const list = [DESSERTS, BATCH];

  it("matches case-insensitively and ignoring surrounding space", () => {
    expect(nameTaken(list, " Desserts ")).toBe(true);
    expect(nameTaken(list, "puddings")).toBe(false);
  });

  it("ignores the folder being renamed, so a no-op rename is allowed", () => {
    expect(nameTaken(list, "desserts", "f1")).toBe(false);
    expect(nameTaken(list, "desserts", "f2")).toBe(true);
  });
});

// ── Selection ───────────────────────────────────────────────────────────────

describe("toggleFolderId", () => {
  it("adds and removes, returning new arrays", () => {
    expect(toggleFolderId([], "f1")).toEqual(["f1"]);
    expect(toggleFolderId(["f1", "f2"], "f1")).toEqual(["f2"]);
  });
});

describe("sameIdSet", () => {
  it("ignores order — the PUT replaces a SET", () => {
    expect(sameIdSet(["f1", "f2"], ["f2", "f1"])).toBe(true);
    expect(sameIdSet(["f1"], ["f1", "f2"])).toBe(false);
    expect(sameIdSet([], [])).toBe(true);
  });
});

describe("knownIds", () => {
  it("drops ids whose folder is gone, which would 400 the PUT", () => {
    expect(knownIds(["f1", "ghost"], [DESSERTS, BATCH])).toEqual(["f1"]);
  });
});

describe("folderSummary", () => {
  it("names the folders a recipe is in, sorted", () => {
    expect(folderSummary([DESSERTS, BATCH], ["f1", "f2"])).toBe("batch-cooking · 🍰 desserts");
  });

  it("is empty when the recipe is in none", () => {
    expect(folderSummary([DESSERTS], [])).toBe("");
  });

  it("ignores ids it has no folder for rather than rendering undefined", () => {
    expect(folderSummary([DESSERTS], ["f1", "ghost"])).toBe("🍰 desserts");
  });
});

// ── Keeping the local list in step ──────────────────────────────────────────

describe("upsertFolder / removeFolderById", () => {
  it("inserts a new folder in sorted position", () => {
    const next = upsertFolder([DESSERTS], folder({ id: "f3", name: "apéro" }));
    expect(next.map((f) => f.name)).toEqual(["apéro", "desserts"]);
  });

  it("replaces by id on rename and re-sorts", () => {
    const next = upsertFolder([DESSERTS, BATCH], { ...DESSERTS, name: "zabaglione" });
    expect(next.map((f) => f.name)).toEqual(["batch-cooking", "zabaglione"]);
    expect(next).toHaveLength(2);
  });

  it("removes by id", () => {
    expect(removeFolderById([DESSERTS, BATCH], "f1").map((f) => f.id)).toEqual(["f2"]);
  });
});

describe("applyFolderCountDelta", () => {
  it("increments the folders added to and decrements the ones left", () => {
    const next = applyFolderCountDelta([DESSERTS, BATCH], ["f1"], ["f2"]);
    expect(next.find((f) => f.id === "f1")?.recipeCount).toBe(2);
    expect(next.find((f) => f.id === "f2")?.recipeCount).toBe(6);
  });

  it("leaves untouched folders alone — same object, so no re-render", () => {
    const next = applyFolderCountDelta([DESSERTS, BATCH], [], []);
    expect(next[0]).toBe(DESSERTS);
    expect(next[1]).toBe(BATCH);
  });

  it("never shows a negative count when the local copy has drifted", () => {
    const empty = folder({ id: "f9", name: "ghosts", recipeCount: 0 });
    expect(applyFolderCountDelta([empty], ["f9"], [])[0].recipeCount).toBe(0);
  });
});

describe("deleteFolderWarning", () => {
  it("says the recipes survive — the whole point of the copy", () => {
    expect(deleteFolderWarning(DESSERTS)).toContain("stay");
    expect(deleteFolderWarning(DESSERTS)).toContain("3 recipes");
    expect(deleteFolderWarning({ name: "one", recipeCount: 1 })).toContain("The recipe in it stays");
  });

  it("does not talk about recipes that aren't there", () => {
    expect(deleteFolderWarning({ name: "empty", recipeCount: 0 })).toBe(
      "Delete “empty”? It's empty.",
    );
  });
});
