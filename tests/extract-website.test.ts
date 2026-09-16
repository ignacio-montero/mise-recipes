// UNIT tests for the JSON-LD parser in lib/extract/website.ts.
//
// PRD S4 makes "zero LLM calls for a page that carries JSON-LD" an acceptance
// criterion, so this parser is the difference between a free, instant,
// hallucination-proof import and a paid model call. It also faces a genuine
// shape zoo: schema.org lets almost every field be a string, a number, an
// object, or an array of any of those, and food blogs use all of it.
//
// Every fixture below is a small INLINE HTML string. No network, by rule — and
// also by design: a fixture is a *frozen* copy of a shape, which is what makes
// a failure mean "our parser changed" rather than "someone redesigned their
// blog last night". The tradeoff is that fixtures go stale, which is why
// docs/RESEARCH-extraction.md records how to re-measure the real pages.

import { describe, expect, it } from "vitest";
import {
  htmlToText,
  decodeEntities,
  jsonLdNodes,
  parseIngredientLine,
  parseInstructions,
  parseIsoDuration,
  parseJsonLdRecipe,
  pickImageUrl,
} from "@/lib/extract/website";

/** Wrap a JSON-LD payload in the smallest page that can carry it. */
const page = (jsonLd: unknown, attrs = 'type="application/ld+json"') =>
  `<!doctype html><html><head><title>Tacos</title><script ${attrs}>${
    typeof jsonLd === "string" ? jsonLd : JSON.stringify(jsonLd)
  }</script></head><body><h1>Tacos</h1></body></html>`;

const RECIPE = {
  "@context": "https://schema.org",
  "@type": "Recipe",
  name: "Crispy Shrimp Tacos",
  description: "The good ones.",
  recipeYield: "6-8 tacos",
  totalTime: "PT45M",
  recipeIngredient: ["1 lb shrimp, peeled", "2 tbsp mayo", "8 corn tortillas"],
  recipeInstructions: ["Pat the shrimp dry.", "Fry in batches.", "Serve."],
  image: "https://cdn.example.com/tacos.jpg",
  author: { "@type": "Person", name: "Chef Somebody" },
  recipeCategory: "Main",
  recipeCuisine: "Mexican",
  keywords: "shrimp, tacos, quick",
};

describe("finding the Recipe node in the page's structured data", () => {
  it("parses the ordinary single-node case", () => {
    const out = parseJsonLdRecipe(page(RECIPE));
    expect(out).not.toBeNull();
    expect(out!.parsed.title).toBe("Crispy Shrimp Tacos");
    expect(out!.parsed.ingredients).toHaveLength(3);
    expect(out!.parsed.steps).toEqual(["Pat the shrimp dry.", "Fry in batches.", "Serve."]);
    expect(out!.parsed.servings).toBe("6-8 tacos");
    expect(out!.parsed.totalMinutes).toBe(45);
    expect(out!.author).toBe("Chef Somebody");
    expect(out!.imageUrl).toBe("https://cdn.example.com/tacos.jpg");
    expect(out!.parsed.isRecipe).toBe(true);
  });

  it("digs the Recipe out of a Yoast-style @graph", () => {
    // Every WordPress food blog running Yoast publishes this shape: one
    // top-level node whose @graph holds WebSite, WebPage, Person AND Recipe.
    const html = page({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: "A Food Blog" },
        { "@type": "WebPage", name: "Tacos — A Food Blog" },
        RECIPE,
      ],
    });
    expect(parseJsonLdRecipe(html)!.parsed.title).toBe("Crispy Shrimp Tacos");
  });

  it("finds the Recipe when the whole payload is a bare array", () => {
    expect(parseJsonLdRecipe(page([{ "@type": "Organization" }, RECIPE]))!.parsed.title)
      .toBe("Crispy Shrimp Tacos");
  });

  it("accepts @type as an array containing Recipe", () => {
    // `"@type": ["Recipe", "NewsArticle"]` is legal and common on magazine
    // sites. A `t === "Recipe"` check would silently drop Tier 0 for them.
    const html = page({ ...RECIPE, "@type": ["NewsArticle", "Recipe"] });
    expect(parseJsonLdRecipe(html)!.parsed.title).toBe("Crispy Shrimp Tacos");
  });

  it("matches @type case-insensitively", () => {
    expect(parseJsonLdRecipe(page({ ...RECIPE, "@type": "recipe" }))).not.toBeNull();
  });

  it("reads an unquoted type attribute on the script tag", () => {
    // Yoast emits `<script type=application/ld+json>`. Requiring quotes here
    // once silently cost Tier 0 on every WordPress food blog.
    const html = page(RECIPE, "type=application/ld+json");
    expect(parseJsonLdRecipe(html)!.parsed.title).toBe("Crispy Shrimp Tacos");
  });

  it("survives a CDATA wrapper", () => {
    const html = page(`//<![CDATA[\n${JSON.stringify(RECIPE)}\n//]]>`.replace(/\/\//g, ""));
    expect(parseJsonLdRecipe(html)).not.toBeNull();
  });

  it("does not throw on malformed JSON, and still finds a later valid block", () => {
    // **Fault isolation.** One broken analytics blob must not cost us the
    // recipe block three tags later — nor throw a 500 up the pipeline.
    const html =
      `<html><head>` +
      `<script type="application/ld+json">{ "broken": , }</script>` +
      `<script type="application/ld+json">not json at all</script>` +
      `<script type="application/ld+json">${JSON.stringify(RECIPE)}</script>` +
      `</head><body></body></html>`;
    expect(() => jsonLdNodes(html)).not.toThrow();
    expect(parseJsonLdRecipe(html)!.parsed.title).toBe("Crispy Shrimp Tacos");
  });

  it("falls back cleanly when the page has no JSON-LD at all", () => {
    // null means "fall through to the text tiers", NOT an error.
    expect(parseJsonLdRecipe("<html><body><p>Just a blog post.</p></body></html>")).toBeNull();
    expect(jsonLdNodes("<html></html>")).toEqual([]);
  });

  it("falls through when the node is a Recipe in name only", () => {
    // A listicle wearing the wrong @type: better to pay for the model than to
    // save an empty shell the user has to delete.
    expect(parseJsonLdRecipe(page({ "@type": "Recipe", name: "12 Taco Ideas" }))).toBeNull();
  });

  it("falls through when the Recipe has no title", () => {
    expect(parseJsonLdRecipe(page({ ...RECIPE, name: undefined }))).toBeNull();
  });

  it("ignores an empty script tag", () => {
    expect(jsonLdNodes('<script type="application/ld+json"></script>')).toEqual([]);
  });
});

describe("the many shapes of recipeInstructions", () => {
  const steps = (v: unknown) => parseJsonLdRecipe(page({ ...RECIPE, recipeInstructions: v }))!.parsed.steps;

  // ⚠️ KNOWN BUG — see the report. `parseInstructions` converts `</p>`, `</li>`
  // and `<br>` into "\n" and then splits on /\n+/ … but in between it calls
  // `stripTags()`, whose second replace is `/\s+/g → " "`. That collapses the
  // newlines it just created, so the split can never fire and the whole
  // instruction block comes back as ONE step. The module header lists "one big
  // string with newlines" as a supported shape, so this is a real defect, not a
  // design choice. `it.fails` keeps the suite green while the bug is open and
  // turns red the moment it is fixed.
  it.fails("should split one big newline-separated string", () => {
    expect(steps("Pat dry.\nFry in batches.\nServe.")).toEqual([
      "Pat dry.", "Fry in batches.", "Serve.",
    ]);
  });

  it.fails("should strip the numbering a site baked into its own text", () => {
    expect(steps("1. Pat dry.\n2) Fry.\n- Serve.")).toEqual(["Pat dry.", "Fry.", "Serve."]);
  });

  it("currently collapses a newline-separated string into a single step", () => {
    // **Characterisation test**: it records what the code does TODAY, so the
    // blast radius of the bug above is visible and so that fixing it is a
    // deliberate, reviewed change rather than an accident. Delete this test in
    // the same commit that fixes parseInstructions.
    expect(steps("Pat dry.\nFry in batches.\nServe.")).toEqual([
      "Pat dry. Fry in batches. Serve.",
    ]);
    expect(steps("<p>Pat dry.</p><p>Fry.</p>")).toEqual(["Pat dry. Fry."]);
  });

  it("reads an array of plain strings", () => {
    expect(steps(["Pat dry.", "Fry.", "Serve."])).toEqual(["Pat dry.", "Fry.", "Serve."]);
  });

  it("reads an array of HowToStep objects", () => {
    expect(steps([
      { "@type": "HowToStep", text: "Pat dry." },
      { "@type": "HowToStep", text: "Fry." },
      { "@type": "HowToStep", name: "Serve.", url: "https://x/#step3" },
    ])).toEqual(["Pat dry.", "Fry.", "Serve."]);
  });

  it("flattens HowToSection groups into their nested steps", () => {
    // The shape that breaks naive parsers: the real steps are two levels down
    // in `itemListElement`, and the section's own `name` ("For the sauce") is
    // a heading, not an instruction.
    expect(steps([
      {
        "@type": "HowToSection",
        name: "For the shrimp",
        itemListElement: [
          { "@type": "HowToStep", text: "Pat dry." },
          { "@type": "HowToStep", text: "Fry." },
        ],
      },
      {
        "@type": "HowToSection",
        name: "For the sauce",
        itemListElement: [{ "@type": "HowToStep", text: "Whisk mayo and hot sauce." }],
      },
    ])).toEqual(["Pat dry.", "Fry.", "Whisk mayo and hot sauce."]);
  });

  it("strips the HTML sites embed inside a step", () => {
    expect(steps(["<p>Pat the shrimp <b>completely</b> dry.</p>"]))
      .toEqual(["Pat the shrimp completely dry."]);
  });

  it("drops empty and one-character noise steps", () => {
    expect(steps(["Pat dry.", "", "  ", ".", "Serve."])).toEqual(["Pat dry.", "Serve."]);
  });

  it("returns an empty list for shapes it cannot read, instead of throwing", () => {
    expect(parseInstructions(null)).toEqual([]);
    expect(parseInstructions(42)).toEqual([]);
    expect(parseInstructions({ "@type": "HowToStep" })).toEqual([]);
  });

  it("stops recursing on a self-referential structure", () => {
    // A depth cap is what stands between a hostile/cyclic payload and a stack
    // overflow in the worker.
    const deep = { itemListElement: { itemListElement: { itemListElement: { itemListElement: { itemListElement: ["x"] } } } } };
    expect(() => parseInstructions(deep)).not.toThrow();
  });
});

describe("ingredients from a JSON-LD list", () => {
  const ings = (v: unknown) => parseJsonLdRecipe(page({ ...RECIPE, recipeIngredient: v }))!.parsed.ingredients;

  it("splits quantity, unit, item and note", () => {
    expect(ings(["1 lb shrimp, peeled and deveined"])).toEqual([
      { quantity: "1", unit: "lb", item: "shrimp", note: "peeled and deveined" },
    ]);
  });

  it("handles fractions, mixed numbers and vulgar glyphs", () => {
    expect(parseIngredientLine("1/2 cup cornstarch")).toEqual({ quantity: "1/2", unit: "cup", item: "cornstarch" });
    expect(parseIngredientLine("1 1/2 cups flour")).toEqual({ quantity: "1 1/2", unit: "cups", item: "flour" });
    expect(parseIngredientLine("½ tsp cayenne")).toEqual({ quantity: "½", unit: "tsp", item: "cayenne" });
  });

  it("keeps a range as a range rather than picking a number", () => {
    expect(parseIngredientLine("2-3 cloves garlic")).toEqual({ quantity: "2-3", unit: "cloves", item: "garlic" });
  });

  it("drops the connective 'of'", () => {
    expect(parseIngredientLine("2 cups of vegetable oil"))
      .toEqual({ quantity: "2", unit: "cups", item: "vegetable oil" });
  });

  it("treats a trailing parenthetical as a note", () => {
    expect(parseIngredientLine("1 tsp smoked paprika (optional)"))
      .toEqual({ quantity: "1", unit: "tsp", item: "smoked paprika", note: "optional" });
  });

  it("leaves a line it cannot confidently split whole in `item`", () => {
    // Conservative by design: a wrong `quantity` silently corrupts the servings
    // scaler, while an unsplit line merely looks untidy.
    expect(parseIngredientLine("Salt and pepper to taste")).toEqual({ item: "Salt and pepper to taste" });
    expect(parseIngredientLine("A handful of coriander")).toEqual({ item: "A handful of coriander" });
  });

  it("does not mistake a non-unit first word for a unit", () => {
    expect(parseIngredientLine("2 large eggs")).toEqual({ quantity: "2", item: "large eggs" });
  });

  it("returns null for an empty or markup-only line", () => {
    expect(parseIngredientLine("")).toBeNull();
    expect(parseIngredientLine("   ")).toBeNull();
    expect(parseIngredientLine("<span></span>")).toBeNull();
  });

  it("skips blank entries in the array instead of emitting empty ingredients", () => {
    expect(ings(["1 lb shrimp", "", "   ", "2 tbsp mayo"])).toHaveLength(2);
  });

  it("reads a single newline-separated string as a list", () => {
    expect(ings("1 lb shrimp\n2 tbsp mayo")).toHaveLength(2);
  });

  it("decodes the HTML entities sites leave in their own JSON", () => {
    expect(parseIngredientLine("1 tbsp cr&egrave;me fra&icirc;che").item).toContain("crème");
  });
});

describe("ISO-8601 durations", () => {
  it("reads the common shapes", () => {
    expect(parseIsoDuration("PT1H30M")).toBe(90);
    expect(parseIsoDuration("PT45M")).toBe(45);
    expect(parseIsoDuration("PT2H")).toBe(120);
    expect(parseIsoDuration("P0DT0H45M")).toBe(45);
    expect(parseIsoDuration("P1D")).toBe(1440);
    expect(parseIsoDuration("pt45m")).toBe(45); // lower case happens
  });

  it("rounds seconds into whole minutes", () => {
    expect(parseIsoDuration("PT1M30S")).toBe(2);
  });

  it("treats a bare number as minutes", () => {
    expect(parseIsoDuration(30)).toBe(30);
  });

  it("returns null for junk and for zero, rather than 0 minutes", () => {
    // `0` and `null` mean different things in the UI: "0 min" is a lie,
    // "no time given" is honest.
    for (const v of ["", "soon", "PT", "PT0M", "1 hour", null, undefined, {}]) {
      expect(parseIsoDuration(v), JSON.stringify(v)).toBeNull();
    }
  });

  it("adds prep + cook when there is no totalTime", () => {
    const html = page({ ...RECIPE, totalTime: undefined, prepTime: "PT15M", cookTime: "PT30M" });
    expect(parseJsonLdRecipe(html)!.parsed.totalMinutes).toBe(45);
  });

  it("prefers totalTime when the site publishes all three", () => {
    const html = page({ ...RECIPE, totalTime: "PT50M", prepTime: "PT15M", cookTime: "PT30M" });
    expect(parseJsonLdRecipe(html)!.parsed.totalMinutes).toBe(50);
  });

  it("leaves totalMinutes null when no time is published", () => {
    const html = page({ ...RECIPE, totalTime: undefined });
    expect(parseJsonLdRecipe(html)!.parsed.totalMinutes).toBeNull();
  });
});

describe("recipeYield", () => {
  const yieldOf = (v: unknown) => parseJsonLdRecipe(page({ ...RECIPE, recipeYield: v }))!.parsed.servings;

  it("keeps the yield as the site wrote it", () => {
    expect(yieldOf("6-8 tacos")).toBe("6-8 tacos");
  });

  it("accepts a plain number", () => {
    // Allrecipes publishes `"recipeYield": 4`. Stored as text per API_SPEC §0.
    expect(yieldOf(4)).toBe("4");
  });

  it("joins an array yield", () => {
    expect(yieldOf(["4", "4 servings"])).toBe("4, 4 servings");
  });

  it("is null when absent", () => {
    expect(yieldOf(undefined)).toBeNull();
  });
});

describe("picking a hero image", () => {
  it("accepts a plain URL string", () => {
    expect(pickImageUrl("https://cdn.example.com/a.jpg")).toBe("https://cdn.example.com/a.jpg");
  });

  it("takes the first usable entry of an array", () => {
    expect(pickImageUrl(["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"]))
      .toBe("https://cdn.example.com/a.jpg");
  });

  it("unwraps an ImageObject", () => {
    expect(pickImageUrl({ "@type": "ImageObject", url: "https://cdn.example.com/c.jpg", width: 1200 }))
      .toBe("https://cdn.example.com/c.jpg");
  });

  it("unwraps an array of ImageObjects and skips the useless ones", () => {
    expect(pickImageUrl([
      { "@type": "ImageObject", width: 1200 },
      { "@type": "ImageObject", contentUrl: "https://cdn.example.com/d.jpg" },
    ])).toBe("https://cdn.example.com/d.jpg");
  });

  it("is null for nothing usable", () => {
    expect(pickImageUrl(null)).toBeNull();
    expect(pickImageUrl([])).toBeNull();
    expect(pickImageUrl({})).toBeNull();
    expect(pickImageUrl("   ")).toBeNull();
  });
});

describe("tags", () => {
  it("merges category, cuisine and keywords into deduped lowercase tags", () => {
    const tags = parseJsonLdRecipe(page(RECIPE))!.parsed.tags!;
    expect(tags).toContain("main");
    expect(tags).toContain("mexican");
    expect(tags).toContain("shrimp");
    expect(new Set(tags).size).toBe(tags.length);
  });

  it("caps the list so a keyword-stuffed blog cannot fill the UI", () => {
    const keywords = Array.from({ length: 40 }, (_, i) => `tag${i}`).join(",");
    expect(parseJsonLdRecipe(page({ ...RECIPE, keywords }))!.parsed.tags!.length)
      .toBeLessThanOrEqual(8);
  });
});

describe("the HTML utilities the other extractors share", () => {
  it("decodes named, decimal and hex entities", () => {
    expect(decodeEntities("Ben &amp; Jerry&#039;s caf&eacute; &#x2014; 1&frac12; cups"))
      .toBe("Ben & Jerry's café — 1½ cups");
  });

  it("leaves an unknown entity alone rather than mangling the text", () => {
    expect(decodeEntities("&notanentity;")).toBe("&notanentity;");
  });

  it("does not blow up on an out-of-range code point", () => {
    expect(() => decodeEntities("&#x110000;")).not.toThrow();
  });

  it("turns markup into the text a human would read", () => {
    const text = htmlToText(
      `<html><head><style>p{color:red}</style></head><body>` +
      `<h1>Tacos</h1><p>Best ever.</p><ul><li>1 lb shrimp</li><li>2 tbsp mayo</li></ul>` +
      `<script>track()</script></body></html>`,
    );
    expect(text).toContain("Tacos");
    expect(text).toContain("- 1 lb shrimp");
    expect(text).not.toContain("color:red"); // <style> dropped
    expect(text).not.toContain("track()"); // <script> dropped
  });

  it("keeps <br> as a line break, because captions-in-HTML depend on it", () => {
    expect(htmlToText("<p>1 lb shrimp<br>2 tbsp mayo</p>")).toBe("1 lb shrimp\n2 tbsp mayo");
  });
});
