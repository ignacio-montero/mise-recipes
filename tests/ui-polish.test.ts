import { describe, expect, it } from "vitest";
import { describeExtraction, metaLine, relativeTime } from "@/components/format";
import { sourceLabelAt } from "@/components/grocery";

const base = {
  totalMinutes: 10,
  servings: "6-8 tacos",
  sourceAuthor: "real.life.with.lisa",
  sourcePlatform: "instagram" as const,
};

describe("metaLine compact mode", () => {
  it("keeps time and servings but drops the author on a card", () => {
    // The card is ~375px wide; all three parts ellipsised the author to "@…",
    // which told the reader nothing. The platform badge covers the source.
    const compact = metaLine(base, { compact: true });
    expect(compact).toContain("10 min");
    expect(compact).toContain("6-8 tacos");
    expect(compact).not.toContain("real.life.with.lisa");
  });

  it("still includes the author when not compact", () => {
    expect(metaLine(base)).toContain("@real.life.with.lisa");
  });

  it("omits parts that are absent rather than leaving empty separators", () => {
    const line = metaLine({ ...base, totalMinutes: null, servings: null }, { compact: true });
    expect(line).toBe("");
    expect(line).not.toContain("·");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-09-16T12:00:00Z");
  it("writes hours without a space", () => {
    expect(relativeTime("2026-09-16T06:00:00Z", now)).toBe("6h ago");
  });
  it("still reads naturally at the other scales", () => {
    expect(relativeTime("2026-09-16T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-09-16T11:30:00Z", now)).toBe("30 min ago");
    expect(relativeTime("2026-09-15T12:00:00Z", now)).toBe("yesterday");
  });
});

describe("describeExtraction", () => {
  it("says where a recipe came from in English, naming the model once", () => {
    const out = describeExtraction({
      tiers: ["tier1:instagram-embed", "tier3:gemini:gemini-2.5-flash"],
      model: "gemini-2.5-flash",
      confidence: 0.9,
    });
    expect(out).toBe("Read from the Instagram caption, structured by gemini-2.5-flash · 90% confident");
    // The old version printed the model twice and leaked raw tier ids.
    expect(out).not.toContain("tier1:");
    expect(out.match(/gemini-2\.5-flash/g)).toHaveLength(1);
  });

  it("mentions the audio tier when it ran", () => {
    expect(
      describeExtraction({
        tiers: ["tier1:instagram-embed", "tier2:audio", "tier3:gemini:x"],
        model: "x",
        confidence: 0.5,
      }),
    ).toContain("plus the spoken audio");
  });

  it("says the JSON-LD path used no model at all", () => {
    const out = describeExtraction({ tiers: ["tier0:json-ld"], model: null, confidence: 1 });
    expect(out).toBe("Read straight from the page's recipe data · 100% confident");
    expect(out).not.toContain("structured by");
  });

  it("returns nothing for a recipe with no provenance", () => {
    expect(describeExtraction(null)).toBe("");
  });
});

describe("sourceLabelAt — one 'from X' per run, not per row", () => {
  const items = [
    { recipeTitle: "Crispy Shrimp Tacos" },
    { recipeTitle: "Crispy Shrimp Tacos" },
    { recipeTitle: "Crispy Shrimp Tacos" },
    { recipeTitle: "TikTok Pasta" },
    { recipeTitle: null },
  ];

  it("labels the first of a run and suppresses the repeats", () => {
    expect(sourceLabelAt(items, 0)).toBe("from Crispy Shrimp Tacos");
    expect(sourceLabelAt(items, 1)).toBe("");
    expect(sourceLabelAt(items, 2)).toBe("");
  });

  it("labels again when the source changes", () => {
    expect(sourceLabelAt(items, 3)).toBe("from TikTok Pasta");
  });

  it("says nothing for a hand-typed item", () => {
    expect(sourceLabelAt(items, 4)).toBe("");
  });

  it("re-labels when the same recipe appears in a LATER run", () => {
    // Suppression is positional, not global: a second block from the same
    // recipe further down the list still needs its own heading.
    const mixed = [{ recipeTitle: "A" }, { recipeTitle: "B" }, { recipeTitle: "A" }];
    expect(sourceLabelAt(mixed, 2)).toBe("from A");
  });

  it("is safe on an out-of-range index", () => {
    expect(sourceLabelAt(items, 99)).toBe("");
  });
});
