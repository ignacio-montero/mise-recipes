// The orchestrator. Every other file in lib/extract/* is a leaf that knows ONE
// source; this file is the only place that knows the ORDER, and therefore the
// only place that decides what an import is allowed to cost
// (docs/ARCHITECTURE.md §3):
//
//   Tier 0  website JSON-LD     exact, instant, free — zero model calls
//   Tier 1  caption / metadata  one HTTP call, still no model
//   Tier 2  audio → transcript  a download + a model call, so it is GATED
//   Tier 3  Gemini structuring  the one model call we cannot avoid
//
// Three exports on purpose, not two:
//   • `gather()`    stops once the text exists (tiers 0-2).
//   • `structure()` turns gathered text into a recipe (tier 3).
//   • `extractRecipe()` is exactly those two composed, for callers that just
//     want a recipe out of a URL.
// The worker deliberately uses the two halves separately so it can persist
// `rawText` the instant gathering succeeds: a Tier 3 failure then retries off
// the stored text instead of hitting Instagram again.

import { config, geminiConfigured } from "../config";
import { GeminiError, structureRecipe, transcribeAudio } from "../gemini";
import type { Extraction, Gathered, ImportStage, ParsedRecipe } from "../types";
import { makeTempDir, removeTempDir, ytdlpAudio, ytdlpJson } from "../ytdlp";
import { classify, classifyOrThrow, ExtractionError } from "./classify";
import { looksLikeRecipe, normaliseText } from "./heuristics";
import { gatherInstagram } from "./instagram";
import { gatherTikTok } from "./tiktok";
import { gatherWebsite } from "./website";
import { gatherYouTube } from "./youtube";

/** Tier 2/3 record the model that answered inside the trace, e.g.
 *  "tier3:gemini:gemini-2.5-flash". `toExtraction()` reads it back out; the
 *  label is written and parsed in this file alone, so the two cannot drift.
 *  (`Gathered` has no `model` field, and it is a settled type — encoding it in
 *  the trace beats widening a type four other files depend on.) */
const TIER3_PREFIX = "tier3:gemini:";
const TIER2_PREFIX = "tier2:gemini-audio:";

/** How much gathered text we keep as provenance. Gemini only ever sees 24k of
 *  it; a 200k-character food blog copied into every recipe row would bloat the
 *  SQLite file for no diagnostic value. */
const MAX_RAW_TEXT = 32_000;

/** Only these have an audio track worth downloading. A web page does not, and
 *  "manual" means the user already handed us the words. */
const VIDEO_PLATFORMS = new Set(["instagram", "tiktok", "youtube"]);

/** The worker uses this to move the job's `stage` column while it works, so the
 *  phone's poll loop can say "transcribing…" instead of a 40-second spinner. */
export type StageListener = (stage: ImportStage) => void;

function emptyGathered(platform: Gathered["platform"], canonicalUrl: string): Gathered {
  return {
    platform,
    text: "",
    author: null,
    thumbnailUrl: null,
    durationSeconds: null,
    canonicalUrl,
    tiers: [],
    structured: null,
  };
}

/** Fold a gatherer's `Partial<Gathered>` onto the running value.
 *  Explicitly skips `undefined` — a plain spread would let a gatherer that
 *  omits `canonicalUrl` blank out the one we already resolved. `tiers` is
 *  appended rather than replaced, because the trace is the whole point. */
function mergeGathered(base: Gathered, part: Partial<Gathered>): Gathered {
  const out = { ...base } as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(part)) {
    if (value === undefined || key === "tiers") continue;
    out[key] = value;
  }
  const merged = out as unknown as Gathered;
  merged.tiers = [...base.tiers, ...(part.tiers ?? [])];
  return merged;
}

/**
 * Download the audio, transcribe it, delete the file. The `finally` is the
 * load-bearing line: a thrown GeminiError or a SIGKILLed yt-dlp must not leave
 * an mp3 behind on a 232 GB SSD shared with every other homelab service.
 */
async function audioTranscript(
  canonicalUrl: string,
  maxSeconds: number,
): Promise<{ text: string; model: string } | null> {
  const dir = await makeTempDir("audio");
  try {
    const audio = await ytdlpAudio(canonicalUrl, dir, maxSeconds);
    if (!audio) return null;
    return await transcribeAudio(audio.filePath, audio.mimeType);
  } finally {
    await removeTempDir(dir);
  }
}

/**
 * TIER 2, and the gate in front of it. Best-effort by construction: anything
 * that goes wrong here leaves the Tier 1 text untouched and lets Tier 3 run.
 * Paying for audio is a bet that the caption was thin; losing the bet must cost
 * nothing.
 */
async function maybeAddAudio(g: Gathered, onStage?: StageListener): Promise<Gathered> {
  if (!config.extraction.enableAudioTier) return g;
  if (!VIDEO_PLATFORMS.has(g.platform)) return g;
  // The gate. `looksLikeRecipe()` already said the caption is a real recipe →
  // a transcript can only add noise, and would cost a download plus a model call.
  if (looksLikeRecipe(g.text).ok) return g;
  if (!geminiConfigured()) return g; // transcription IS a Gemini call

  // The embed/oEmbed routes never report a duration, so ask yt-dlp before
  // committing to a download. If yt-dlp cannot read the post at all, the audio
  // download would fail the same way — skip rather than burn a 180 s timeout.
  let g2 = g;
  if (g2.durationSeconds === null) {
    const info = await ytdlpJson(g2.canonicalUrl);
    if (!info) {
      console.warn("[extract] audio tier skipped: no metadata for", g2.canonicalUrl);
      return g2;
    }
    g2 = mergeGathered(g2, {
      durationSeconds: typeof info.duration === "number" ? Math.round(info.duration) : null,
      author: g2.author ?? info.uploader ?? info.channel ?? null,
      thumbnailUrl: g2.thumbnailUrl ?? info.thumbnail ?? null,
    });
  }

  const seconds = g2.durationSeconds;
  if (seconds === null || seconds > config.extraction.maxAudioSeconds) {
    console.warn(`[extract] audio tier skipped: duration ${seconds ?? "unknown"}s`);
    return g2;
  }

  onStage?.("transcribing");
  try {
    const t = await audioTranscript(g2.canonicalUrl, config.extraction.maxAudioSeconds);
    if (!t) return g2;
    return mergeGathered(g2, {
      tiers: [TIER2_PREFIX + t.model],
      // Appended, never substituted: the caption usually holds the quantities
      // and the speech holds the method. The model gets both, labelled.
      text: normaliseText(`${g2.text}\n\n--- spoken transcript ---\n${t.text}`),
    });
  } catch (e) {
    console.warn("[extract] audio tier failed:", (e as Error).message);
    return g2;
  }
}

/**
 * URL → everything worth feeding a model, and nothing more.
 *
 * `suppliedText` short-circuits ALL fetching. It carries two cases that are the
 * same operation: the user pasting a caption after an automatic import failed
 * (PRD F4), and the worker re-running a job off its stored `rawText`.
 */
export async function gather(
  url: string,
  suppliedText?: string | null,
  onStage?: StageListener,
): Promise<Gathered> {
  const supplied = suppliedText?.trim() ? normaliseText(suppliedText) : null;
  const c = classify(url);

  if (supplied) {
    // No network at all. An unsupported host is not fatal here — the user gave
    // us the words, so where the link points stops mattering.
    const base = emptyGathered(c.ok ? c.platform : "manual", c.ok ? c.canonicalUrl : url.trim());
    return { ...base, text: supplied, tiers: ["tier1:supplied-text"] };
  }

  const cls = classifyOrThrow(url);
  onStage?.("fetching");
  let g = emptyGathered(cls.platform, cls.canonicalUrl);

  switch (cls.platform) {
    case "instagram":
      g = mergeGathered(g, await gatherInstagram({ canonicalUrl: cls.canonicalUrl, id: cls.id }));
      break;
    case "tiktok":
      g = mergeGathered(g, await gatherTikTok({ canonicalUrl: cls.canonicalUrl, id: cls.id }));
      break;
    case "youtube":
      g = mergeGathered(g, await gatherYouTube({ canonicalUrl: cls.canonicalUrl }));
      break;
    case "web":
      g = mergeGathered(g, await gatherWebsite(cls.canonicalUrl));
      break;
  }

  // TIER 0 short-circuit. A complete schema.org/Recipe is already the answer;
  // sending it to a model could only make it worse, slower and more expensive.
  if (g.structured) return g;

  g = mergeGathered(g, { text: normaliseText(g.text) });
  return maybeAddAudio(g, onStage);
}

/** yt-dlp and Gemini are both chatty on failure; the user sees one line. */
function firstLine(message: string): string {
  return (message.split("\n")[0] ?? message).trim().slice(0, 160);
}

/**
 * TIER 3. Gathered text → a recipe.
 *
 * Mutates `gathered.tiers` to append the model that answered. That mutation is
 * deliberate: the caller's `Gathered` IS the provenance record it will later
 * hand to `toExtraction()`, and a silently-forked copy is how provenance ends
 * up lying about which tier produced the row.
 */
export async function structure(gathered: Gathered): Promise<ParsedRecipe> {
  if (gathered.structured) return gathered.structured; // Tier 0 — no model, ever

  const text = gathered.text.trim();
  if (!text) {
    throw new ExtractionError(
      "There was no text to read at that link. Reply with the recipe text and I'll try again.",
    );
  }

  try {
    const { parsed, model } = await structureRecipe({
      text,
      platform: gathered.platform,
      author: gathered.author,
      sourceUrl: gathered.canonicalUrl,
    });
    gathered.tiers.push(TIER3_PREFIX + model);
    return parsed;
  } catch (e) {
    // GeminiError messages name models and HTTP bodies — useful in the log,
    // meaningless in a Telegram reply. Translate once, here.
    if (e instanceof GeminiError) {
      console.error("[extract] structuring failed:", e.message);
      throw new ExtractionError(`Could not read that into a recipe (${firstLine(e.message)}).`);
    }
    throw e;
  }
}

/** The whole pipeline, for callers that just want a recipe out of a URL. */
export async function extractRecipe(
  url: string,
  suppliedText?: string | null,
  onStage?: StageListener,
): Promise<{ parsed: ParsedRecipe; gathered: Gathered }> {
  const gathered = await gather(url, suppliedText, onStage);
  if (!gathered.structured) onStage?.("structuring");
  const parsed = await structure(gathered);
  return { parsed, gathered };
}

/** Provenance, built from the trace the tiers left behind. Stored on the recipe
 *  so that six months from now "why does this say 3 tbsp?" has an answer. */
export function toExtraction(gathered: Gathered, parsed: ParsedRecipe): Extraction {
  const tier3 = [...gathered.tiers].reverse().find((t) => t.startsWith(TIER3_PREFIX));
  return {
    tiers: [...gathered.tiers],
    // Null is the honest answer for Tier 0: no model was involved at all.
    model: tier3 ? tier3.slice(TIER3_PREFIX.length) : null,
    confidence: parsed.confidence,
    rawText: gathered.text.slice(0, MAX_RAW_TEXT),
  };
}
