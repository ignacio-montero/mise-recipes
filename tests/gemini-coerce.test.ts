// UNIT tests for the model-output sanitiser in lib/gemini.ts (`coerceParsed`).
//
// THE IDEA BEING TESTED: A TRUST BOUNDARY
// ---------------------------------------
// It is tempting to think of Gemini's response as "our own data" because we
// made the request. It is not. It is UNTRUSTED INPUT that happens to arrive
// over a connection we opened, and it crosses into the system here — so this
// function is a **trust boundary**, the same category of thing as a request body
// parser. `responseSchema` constrains the SHAPE (constrained decoding), but it
// says nothing about LENGTH, about sane numbers, or about self-contradiction,
// and a model under load will cheerfully return `isRecipe: true` with nothing
// in it.
//
// The bug that motivated the length caps is a good illustration of why
// validating at the boundary beats validating at each point of use: with
// maxOutputTokens at 8192 a ~30 000-character title is reachable, and the
// failure showed up three systems away — Telegram caps a message at 4096
// characters, so `editMessageText` 400s, the `sendMessage` fallback 400s too,
// and the user's chat sits on "⏳ Importing…" forever even though the recipe
// saved perfectly. Nobody reading the Telegram code would ever have guessed.
//
// HOW IT IS REACHED
// -----------------
// `coerceParsed` is not exported, so these tests drive it through the only
// public door, `structureRecipe()`, with `globalThis.fetch` replaced by a stub.
// That is a **stub**, not a mock: it returns canned data and we assert nothing
// about how it was called. Testing through the public surface also means these
// tests keep working if the internal function is renamed — they are coupled to
// the contract, not to the implementation.
//
// NO NETWORK: the stub is installed before any test runs, so a regression that
// made a real call would fail rather than quietly phoning Google.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ParsedRecipe } from "@/lib/types";

// `lib/config.ts` reads process.env once, at import. Setting the key here —
// before the dynamic import in beforeAll — is what makes `geminiConfigured()`
// true without a real key ever existing.
process.env.GEMINI_API_KEY = "test-key-not-a-real-one";
process.env.GEMINI_MODELS = "stub-model";

let gemini: typeof import("@/lib/gemini");

/** The last body handed to the stubbed fetch, so one test can check we never
 *  send an unbounded prompt either. */
let lastRequestBody: string | null = null;

/** Reply as the API would, with `payload` as the model's JSON answer. */
function stubModelReply(payload: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { body?: string }) => {
      lastRequestBody = init?.body ?? null;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            candidates: [
              { content: { parts: [{ text: typeof payload === "string" ? payload : JSON.stringify(payload) }] } },
            ],
          };
        },
        async text() {
          return "";
        },
      };
    }),
  );
}

/** Round-trip a model answer through the sanitiser. */
async function coerce(payload: unknown): Promise<ParsedRecipe> {
  stubModelReply(payload);
  const { parsed } = await gemini.structureRecipe({ text: "1 lb shrimp\nFry it." });
  return parsed;
}

/** A well-formed answer; each test overrides only the field it is about.
 *  Keeping the happy path in one place is what stops these tests from
 *  accidentally asserting several things at once. */
const ok = (over: Record<string, unknown> = {}) => ({
  isRecipe: true,
  confidence: 0.9,
  title: "Crispy Shrimp Tacos",
  ingredients: [{ quantity: "1", unit: "lb", item: "shrimp" }],
  steps: ["Fry the shrimp."],
  ...over,
});

beforeAll(async () => {
  gemini = await import("@/lib/gemini");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODELS;
});

describe("length caps at the trust boundary", () => {
  it("truncates a 30 000-character title to 200 and marks it with an ellipsis", async () => {
    // The exact bug. Note the assertion is on the OUTPUT LENGTH, not on the
    // input: the useful property is "nothing downstream ever sees more than
    // 200 characters", regardless of what the model did.
    const parsed = await coerce(ok({ title: "T".repeat(30_000) }));
    expect(parsed.title).toHaveLength(200);
    expect(parsed.title.endsWith("…")).toBe(true);
  });

  it("caps description, steps, notes, servings and every ingredient field", async () => {
    // **Boundary-value analysis** across the whole field table in one test,
    // because the risk is a field someone forgot to cap, not a subtle off-by-one
    // in any single one of them.
    const parsed = await coerce(
      ok({
        description: "D".repeat(9_000),
        servings: "S".repeat(9_000),
        notes: "N".repeat(9_000),
        steps: ["Step ".repeat(5_000)],
        ingredients: [
          { quantity: "Q".repeat(500), unit: "U".repeat(500), item: "I".repeat(5_000), note: "N".repeat(5_000) },
        ],
      }),
    );
    expect(parsed.description!.length).toBeLessThanOrEqual(2_000);
    expect(parsed.servings!.length).toBeLessThanOrEqual(100);
    expect(parsed.notes!.length).toBeLessThanOrEqual(4_000);
    expect(parsed.steps[0]!.length).toBeLessThanOrEqual(1_000);
    const ing = parsed.ingredients[0]!;
    expect(ing.quantity!.length).toBeLessThanOrEqual(40);
    expect(ing.unit!.length).toBeLessThanOrEqual(40);
    expect(ing.item.length).toBeLessThanOrEqual(200);
    expect(ing.note!.length).toBeLessThanOrEqual(300);
  });

  it("leaves a normal recipe completely untouched", async () => {
    // The cap must be invisible in ordinary use, or it is a feature regression
    // dressed as a security fix. Ceilings are chosen to be far above any real
    // recipe for exactly this reason.
    const parsed = await coerce(ok({ description: "The good ones.", servings: "6-8 tacos" }));
    expect(parsed.title).toBe("Crispy Shrimp Tacos");
    expect(parsed.description).toBe("The good ones.");
    expect(parsed.servings).toBe("6-8 tacos");
    expect(parsed.ingredients).toEqual([{ quantity: "1", unit: "lb", item: "shrimp" }]);
  });

  it("bounds the number of ingredients, steps and tags, not just their size", async () => {
    // A cap on each string with no cap on the array length is only half a
    // defence: 10 000 ingredients of 200 characters is still 2 MB.
    const parsed = await coerce(
      ok({
        ingredients: Array.from({ length: 500 }, (_, i) => ({ item: `item ${i}` })),
        steps: Array.from({ length: 500 }, (_, i) => `Do thing ${i}.`),
        tags: ["a1", "b2", "c3", "d4", "e5", "f6", "g7"],
      }),
    );
    expect(parsed.ingredients).toHaveLength(100);
    expect(parsed.steps).toHaveLength(60);
    expect(parsed.tags).toHaveLength(5);
  });

  it("caps the prompt it SENDS as well as the answer it receives", async () => {
    stubModelReply(ok());
    await gemini.structureRecipe({ text: "x".repeat(100_000) });
    // 24 000 chars of source text plus the small context preamble. The cap is
    // what stops a pathological web page costing real money per import.
    expect(lastRequestBody!.length).toBeLessThan(30_000);
  });
});

describe("output that contradicts itself", () => {
  it("downgrades isRecipe:true with nothing to cook", async () => {
    // A model that says "yes, a recipe" and hands back no ingredients and no
    // steps is reporting a FAILURE in an optimistic voice. Believing it would
    // save an empty shell the user has to find and delete — worse than an
    // honest "that didn't look like a recipe", which at least offers the
    // paste-the-caption fallback (PRD F4).
    const parsed = await coerce(ok({ isRecipe: true, ingredients: [], steps: [] }));
    expect(parsed.isRecipe).toBe(false);
  });

  it("accepts isRecipe:true when EITHER ingredients or steps survive", async () => {
    // The negative control for the test above. A caption that lists ingredients
    // without a method is still worth saving, so the rule must be "has content",
    // not "has both".
    expect((await coerce(ok({ ingredients: [{ item: "shrimp" }], steps: [] }))).isRecipe).toBe(true);
    expect((await coerce(ok({ ingredients: [], steps: ["Fry it."] }))).isRecipe).toBe(true);
  });

  it("does not resurrect isRecipe when the model said false", async () => {
    expect((await coerce(ok({ isRecipe: false }))).isRecipe).toBe(false);
    expect((await coerce(ok({ isRecipe: "true" }))).isRecipe).toBe(false); // strict === true
  });

  it("counts an ingredient with no item as no ingredient at all", async () => {
    // `item` is the only required field, so an entry without one is noise. If
    // it were kept, the cook view would render a blank line and the grocery
    // list would gain an empty row.
    const parsed = await coerce(ok({ isRecipe: true, ingredients: [{ quantity: "2", unit: "cups" }], steps: [] }));
    expect(parsed.ingredients).toEqual([]);
    expect(parsed.isRecipe).toBe(false);
  });
});

describe("wrong types, which a schema does not actually prevent", () => {
  it("survives a response that is not an object at all", async () => {
    for (const payload of ["null", '"a string"', "42", "[]"]) {
      const parsed = await coerce(payload);
      expect(parsed.isRecipe).toBe(false);
      expect(parsed.title).toBe("Untitled recipe");
      expect(parsed.ingredients).toEqual([]);
      expect(parsed.steps).toEqual([]);
      expect(parsed.confidence).toBe(0.5);
    }
  });

  it("drops non-string steps and non-object ingredients instead of crashing", async () => {
    // Without this, a `null` in the steps array becomes a `.trim() of null`
    // three layers away in the cook view — a runtime crash in the UI caused by
    // a bad byte from an API, which is the hardest kind of bug to trace back.
    const parsed = await coerce(
      ok({
        steps: ["Fry it.", null, 42, "", "   ", { text: "nope" }],
        ingredients: ["a string", null, 7, { item: "shrimp" }],
      }),
    );
    expect(parsed.steps).toEqual(["Fry it."]);
    expect(parsed.ingredients).toEqual([{ item: "shrimp" }]);
  });

  it("clamps confidence into 0..1 and defaults it when it is not a number", async () => {
    expect((await coerce(ok({ confidence: 7 }))).confidence).toBe(1);
    expect((await coerce(ok({ confidence: -3 }))).confidence).toBe(0);
    expect((await coerce(ok({ confidence: "high" }))).confidence).toBe(0.5);
    expect((await coerce(ok({ confidence: Number.NaN }))).confidence).toBe(0.5);
  });

  it("normalises totalMinutes, and treats a nonsensical one as unknown", async () => {
    expect((await coerce(ok({ totalMinutes: 44.6 }))).totalMinutes).toBe(45);
    expect((await coerce(ok({ totalMinutes: -10 }))).totalMinutes).toBeNull();
    expect((await coerce(ok({ totalMinutes: "45 minutes" }))).totalMinutes).toBeNull();
    expect((await coerce(ok({ totalMinutes: 0 }))).totalMinutes).toBeNull(); // 0 means "not stated"
  });

  it("cleans tags: lower-cased, de-duplicated, '#' stripped, junk dropped", async () => {
    const parsed = await coerce(
      ok({ tags: ["#Mexican", "mexican", "MEXICAN", "a", "T".repeat(80), "quick", 42, null] }),
    );
    expect(parsed.tags).toEqual(["mexican", "quick"]);
  });

  it("falls back to a usable title rather than an empty string", async () => {
    // An empty title would render as a blank card in the recipe list — present,
    // unreadable, and hard to find in order to fix.
    for (const title of [undefined, "", "   ", 42, null]) {
      expect((await coerce(ok({ title }))).title).toBe("Untitled recipe");
    }
  });

  it("strips the numbering a model adds back despite being told not to", async () => {
    const parsed = await coerce(ok({ steps: ["1. Pat dry.", "2) Fry.", "3.  Serve."] }));
    expect(parsed.steps).toEqual(["Pat dry.", "Fry.", "Serve."]);
  });
});

describe("responses that are not JSON at all", () => {
  it("raises a GeminiError rather than letting JSON.parse throw", async () => {
    // The distinction matters upstream: `lib/worker.ts` shows an ExtractionError
    // or GeminiError to the user as a sentence and retries it, but treats an
    // unexpected exception as a bug and hides the message. Typed errors are how
    // "the model hiccuped" stays distinguishable from "we have a bug".
    stubModelReply("this is not json {");
    await expect(gemini.structureRecipe({ text: "x" })).rejects.toThrow(/not JSON/i);
  });
});
