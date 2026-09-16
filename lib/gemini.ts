// TIER 3 (and the audio half of Tier 2) — the only LLM in the system.
//
// Plain `fetch` against the REST endpoint, no SDK. The SDK would add a
// dependency, a version to keep current and a layer of abstraction over four
// fields we set by hand; the whole surface we use is one POST.
//
// Two measured facts shape this file (docs/RESEARCH-extraction.md §3):
//   • `responseMimeType: "application/json"` + a strict `responseSchema` +
//     `temperature: 0` gives parseable output with no prompt gymnastics and no
//     "```json" fencing to strip. This is **constrained decoding** — the model
//     is prevented from emitting tokens that would break the schema, rather
//     than being asked nicely to obey it.
//   • `gemini-3.8-flash` answered 503 "high demand" on the very first call, so
//     `config.gemini.models` is a FALLBACK CHAIN, not a preference. A busy
//     model must cost us a few hundred milliseconds, not an import.

import { promises as fs } from "node:fs";
import { config, geminiConfigured } from "./config";
import type { Ingredient, ParsedRecipe } from "./types";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const REQUEST_TIMEOUT_MS = 90_000;
/** Inline audio must fit in the request body; the documented ceiling is ~20 MB
 *  including base64 overhead, so we stop well short and skip the tier instead. */
const MAX_INLINE_AUDIO_BYTES = 14 * 1024 * 1024;

export class GeminiError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = "GeminiError";
  }
}

type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

type GenerateRequest = {
  contents: { role: "user"; parts: Part[] }[];
  systemInstruction?: { parts: { text: string }[] };
  generationConfig: Record<string, unknown>;
};

type GenerateResponse = {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
};

/** 503/429/500 mean "try again or try elsewhere"; 400/403 mean "you are wrong
 *  and repeating yourself will not help". Only the first class is worth a
 *  backoff, which is what keeps a bad API key from taking 30 s to fail. */
function isTransient(status: number): boolean {
  return status === 429 || status === 500 || status === 503 || status === 504;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callModel(model: string, body: GenerateRequest): Promise<GenerateResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      // The key goes in a header, not `?key=` — query strings end up in proxy
      // logs and error messages. Functionally identical to the documented form.
      headers: { "content-type": "application/json", "x-goog-api-key": config.gemini.apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new GeminiError(`${model} answered ${res.status}: ${detail}`, isTransient(res.status));
    }
    return (await res.json()) as GenerateResponse;
  } catch (e) {
    if (e instanceof GeminiError) throw e;
    const aborted = e instanceof Error && e.name === "AbortError";
    throw new GeminiError(aborted ? `${model} timed out.` : `${model} unreachable: ${e}`, true);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walk the model chain. Each model gets two shots (one short backoff) before we
 * move down the list, so a momentary 503 does not silently demote every import
 * to the weakest model in the chain.
 */
async function generate(body: GenerateRequest): Promise<{ text: string; model: string }> {
  if (!geminiConfigured()) {
    throw new GeminiError("GEMINI_API_KEY is not set, so nothing can be structured.", false);
  }
  const errors: string[] = [];

  for (const model of config.gemini.models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await callModel(model, body);
        const blocked = res.promptFeedback?.blockReason;
        if (blocked) throw new GeminiError(`${model} refused the content (${blocked}).`, false);

        const candidate = res.candidates?.[0];
        const text = (candidate?.content?.parts ?? [])
          .map((p) => p.text ?? "")
          .join("")
          .trim();
        if (!text) {
          // MAX_TOKENS with no text means the answer did not fit; another model
          // will not help, but it is worth saying so out loud.
          throw new GeminiError(
            `${model} returned nothing (finishReason=${candidate?.finishReason ?? "none"}).`,
            candidate?.finishReason !== "MAX_TOKENS",
          );
        }
        return { text, model };
      } catch (e) {
        const err = e instanceof GeminiError ? e : new GeminiError(String(e), false);
        errors.push(err.message);
        if (!err.retryable) break;          // next model, not the same one again
        await sleep(attempt === 0 ? 700 : 0);
      }
    }
  }
  throw new GeminiError(`Every model failed. ${errors.join(" | ")}`, false);
}

// ── Structuring ──────────────────────────────────────────────────────────────

const INGREDIENT_SCHEMA = {
  type: "OBJECT",
  properties: {
    quantity: { type: "STRING" },
    unit: { type: "STRING" },
    item: { type: "STRING" },
    note: { type: "STRING" },
  },
  required: ["item"],
};

const RECIPE_SCHEMA = {
  type: "OBJECT",
  properties: {
    isRecipe: { type: "BOOLEAN" },
    confidence: { type: "NUMBER" },
    title: { type: "STRING" },
    description: { type: "STRING" },
    servings: { type: "STRING" },
    totalMinutes: { type: "INTEGER" },
    ingredients: { type: "ARRAY", items: INGREDIENT_SCHEMA },
    steps: { type: "ARRAY", items: { type: "STRING" } },
    tags: { type: "ARRAY", items: { type: "STRING" } },
    notes: { type: "STRING" },
  },
  required: ["isRecipe", "confidence", "title", "ingredients", "steps"],
};

/** The anti-hallucination contract. Every "do not invent" line here exists
 *  because the alternative — a plausible-looking quantity nobody wrote — is
 *  worse than a missing one: you cannot spot it while cooking. */
const SYSTEM_INSTRUCTION = `You convert social-media captions and web pages into structured recipes.

RULES:
1. Use ONLY what the source text says. NEVER invent a quantity, a unit, a temperature, a time or an ingredient that is not written or clearly spoken there. If a quantity is missing, omit the field — do not estimate it.
2. Keep quantities exactly as written: "1/2" stays "1/2", "2-3" stays "2-3", "a splash" goes in \`quantity\` as written or in \`note\`. Never convert units.
3. \`item\` is the ingredient itself ("shrimp"); preparation ("diced small") goes in \`note\`.
4. Steps are the instructions in order, one action per step, imperative, no leading numbers. Do not merge or pad them.
5. If the text is not a recipe — a promo, a restaurant review, "link in bio", a list of meal ideas with no ingredients or method — set "isRecipe": false, "confidence" low, and leave ingredients and steps empty. Do NOT reconstruct a recipe from general knowledge.
6. \`title\` is the dish name, cleaned of emoji and hashtags. \`servings\` is the yield as written ("6-8 tacos"). \`totalMinutes\` only if a time is stated.
7. \`tags\` are at most 5 short lowercase labels drawn from the text (cuisine, meal, diet). No hashtag symbols.
8. \`notes\` is for genuinely useful extra context stated in the source (substitutions, storage). Otherwise omit.
9. \`confidence\` is 0..1: how completely the SOURCE specified this recipe, not how fluent your answer is.`;

/** Never trust the model's shape, even with a schema: a wrong type here becomes
 *  a runtime crash three layers away in the cook view. */
function coerceParsed(raw: unknown): ParsedRecipe {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => {
    const s = typeof v === "string" ? v.trim() : "";
    return s === "" ? undefined : s;
  };

  const ingredients: Ingredient[] = Array.isArray(o.ingredients)
    ? o.ingredients
        .map((v): Ingredient | null => {
          const i = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
          const item = str(i.item);
          if (!item) return null;
          return {
            ...(str(i.quantity) ? { quantity: str(i.quantity) } : {}),
            ...(str(i.unit) ? { unit: str(i.unit) } : {}),
            item,
            ...(str(i.note) ? { note: str(i.note) } : {}),
          };
        })
        .filter((i): i is Ingredient => i !== null)
        .slice(0, 100)
    : [];

  const steps = Array.isArray(o.steps)
    ? o.steps
        .map((s) => (typeof s === "string" ? s.replace(/^\s*\d+[.)]\s*/, "").trim() : ""))
        .filter((s) => s.length > 0)
        .slice(0, 60)
    : [];

  const tags = Array.isArray(o.tags)
    ? Array.from(
        new Set(
          o.tags
            .map((t) => (typeof t === "string" ? t.trim().toLowerCase().replace(/^#/, "") : ""))
            .filter((t) => t.length > 1 && t.length < 30),
        ),
      ).slice(0, 5)
    : [];

  const minutes = typeof o.totalMinutes === "number" && Number.isFinite(o.totalMinutes)
    ? Math.max(0, Math.round(o.totalMinutes)) || null
    : null;

  const confidence = typeof o.confidence === "number" && Number.isFinite(o.confidence)
    ? Math.min(1, Math.max(0, o.confidence))
    : 0.5;

  // A model that says "isRecipe: true" but hands back nothing to cook is
  // reporting a failure in an optimistic voice. Treat it as the failure.
  const hasContent = ingredients.length > 0 || steps.length > 0;
  const isRecipe = o.isRecipe === true && hasContent;

  return {
    isRecipe,
    confidence,
    title: str(o.title) ?? "Untitled recipe",
    description: str(o.description) ?? null,
    servings: str(o.servings) ?? null,
    totalMinutes: minutes,
    ingredients,
    steps,
    tags,
    notes: str(o.notes) ?? null,
  };
}

export type StructureInput = {
  text: string;
  platform?: string;
  author?: string | null;
  sourceUrl?: string | null;
};

export async function structureRecipe(
  input: StructureInput,
): Promise<{ parsed: ParsedRecipe; model: string }> {
  // 24k chars is far more than any caption and enough of a web page to include
  // the recipe; the cap is what stops a pathological page costing real money.
  const text = input.text.slice(0, 24_000);
  const context = [
    input.platform ? `Source platform: ${input.platform}` : null,
    input.author ? `Author: ${input.author}` : null,
    input.sourceUrl ? `Source URL: ${input.sourceUrl}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const { text: json, model } = await generate({
    contents: [{ role: "user", parts: [{ text: `${context}\n\nSOURCE TEXT:\n"""\n${text}\n"""` }] }],
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: RECIPE_SCHEMA,
      maxOutputTokens: 8192,
    },
  });

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new GeminiError("The model returned something that was not JSON.", false);
  }
  return { parsed: coerceParsed(raw), model };
}

// ── Audio transcription (Tier 2) ─────────────────────────────────────────────

const TRANSCRIBE_PROMPT = `Transcribe the spoken audio of this cooking video verbatim in its original language.
Write quantities as spoken ("half a cup", "two hundred grams").
Do not summarise, do not add a recipe, do not add commentary. If there is no speech, answer exactly: NO_SPEECH`;

/**
 * Gemini takes audio natively, which is why this project has no Whisper and no
 * GPU. The file is inlined as base64 rather than uploaded via the Files API:
 * one request instead of three, and nothing is left sitting on Google's side
 * needing deletion.
 */
export async function transcribeAudio(
  filePath: string,
  mimeType: string,
): Promise<{ text: string; model: string } | null> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || stat.size === 0) return null;
  if (stat.size > MAX_INLINE_AUDIO_BYTES) {
    console.warn(`[gemini] audio too large to inline (${stat.size} bytes) — skipping audio tier`);
    return null;
  }

  const data = (await fs.readFile(filePath)).toString("base64");
  const { text, model } = await generate({
    contents: [
      { role: "user", parts: [{ inlineData: { mimeType, data } }, { text: TRANSCRIBE_PROMPT }] },
    ],
    generationConfig: { temperature: 0, maxOutputTokens: 8192 },
  });

  const clean = text.trim();
  if (!clean || clean === "NO_SPEECH") return null;
  return { text: clean, model };
}
