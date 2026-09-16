// UNIT tests for lib/extract/heuristics.ts — the tier gate.
//
// This function is a CLASSIFIER, so the tests are framed as a confusion matrix
// rather than as exact-value assertions: does a real recipe land on the
// positive side of the threshold, and does noise land on the negative side?
// Asserting the exact score (e.g. `toBe(9.15)`) would be a **brittle test**:
// it would fail every time a weight is tuned, even when the behaviour the
// product depends on is unchanged. So the assertions are `>= 4` / `< 4` plus a
// margin check, which is the actual contract.
//
// Why this matters commercially: a false negative here means paying for a
// 20 MB download, an ffmpeg spawn and an audio-sized model call for a reel
// whose caption already had the recipe.

import { describe, expect, it } from "vitest";
import { isThin, looksLikeRecipe, normaliseText } from "@/lib/extract/heuristics";
import {
  LINK_IN_BIO_CAPTION,
  RESTAURANT_REVIEW_CAPTION,
  SHRIMP_TACO_CAPTION,
} from "./fixtures/captions";

describe("normalising the whitespace chaos a caption arrives in", () => {
  it("keeps the line breaks that make an ingredient list legible", () => {
    // The single most important property. Collapsing \n into spaces would turn
    // an ingredient list into a paragraph and cost the QUANTITY_LINE signal.
    const text = "INGREDIENTS\n- 1 lb shrimp\n- 2 tbsp mayo";
    expect(normaliseText(text).split("\n")).toEqual([
      "INGREDIENTS",
      "- 1 lb shrimp",
      "- 2 tbsp mayo",
    ]);
  });

  it("normalises Windows and old-Mac line endings", () => {
    expect(normaliseText("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("collapses runs of spaces and trailing space but not paragraph breaks", () => {
    expect(normaliseText("a    b  \n\n  c")).toBe("a b\n\n c");
  });

  it("caps a wall of blank lines at one blank line", () => {
    expect(normaliseText("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("replaces the non-breaking spaces Instagram inserts", () => {
    //   looks identical on screen but is not \s in some engines; leaving it
    // in makes "1 cup" invisible to the NUMBER_UNIT regex.
    expect(normaliseText("1 cup flour")).toBe("1 cup flour");
  });

  it("trims the outer edges", () => {
    expect(normaliseText("\n\n  hello  \n\n")).toBe("hello");
  });
});

describe("deciding whether a caption is worth structuring", () => {
  it("scores the real shrimp-taco reel well above the threshold", () => {
    const { ok, score } = looksLikeRecipe(SHRIMP_TACO_CAPTION);
    expect(ok).toBe(true);
    // Comfortably above 4, not marginally: this fixture is the yardstick the
    // threshold was set against, so a narrow pass would mean the gate is about
    // to start rejecting real recipes.
    expect(score).toBeGreaterThan(6);
  });

  it("rejects a hashtags-and-link-in-bio caption", () => {
    const { ok, score } = looksLikeRecipe(LINK_IN_BIO_CAPTION);
    expect(ok).toBe(false);
    expect(score).toBeLessThan(4);
  });

  it("rejects a restaurant review that merely talks about food", () => {
    // The hard negative: real words, real food nouns, no quantities or method.
    expect(looksLikeRecipe(RESTAURANT_REVIEW_CAPTION).ok).toBe(false);
  });

  it("scores empty and tiny inputs at zero without throwing", () => {
    for (const input of [null, undefined, "", "   ", "yum 🔥"]) {
      expect(looksLikeRecipe(input)).toEqual({ ok: false, score: 0 });
    }
  });

  it("does not let a hashtag wall alone push a caption over the line", () => {
    // HASHTAG_BLOCK is stripped before scoring, so length from hashtags must
    // not buy the >350-char length bonus.
    const hashtags = Array.from({ length: 60 }, (_, i) => `#tag${i}`).join(" ");
    expect(looksLikeRecipe(`Dinner tonight 🔥 ${hashtags}`).ok).toBe(false);
  });

  it("accepts a terse caption that still has quantities and method", () => {
    const terse = [
      "Garlic butter pasta",
      "200g spaghetti",
      "3 cloves garlic",
      "2 tbsp butter",
      "50g parmesan",
      "Boil the pasta, melt the butter, stir the garlic in, toss and serve.",
    ].join("\n");
    expect(looksLikeRecipe(terse).ok).toBe(true);
  });

  it("agrees with isThin, which is its inverse", () => {
    expect(isThin(SHRIMP_TACO_CAPTION)).toBe(false);
    expect(isThin(LINK_IN_BIO_CAPTION)).toBe(true);
    expect(isThin(null)).toBe(true);
  });

  it("reports a rounded, comparable score", () => {
    const { score } = looksLikeRecipe(SHRIMP_TACO_CAPTION);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBe(Math.round(score * 100) / 100);
  });
});
