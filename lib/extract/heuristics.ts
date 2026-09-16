// The gate between tiers. `looksLikeRecipe()` answers one question cheaply:
// "is there enough recipe-shaped text here to be worth structuring?"
//
// WHY a hand-rolled scorer instead of asking the model: this runs BEFORE we
// decide to download audio, and the whole point is to avoid paying for a tier
// (a ~20 MB download, an ffmpeg spawn and an audio-sized prompt) when the
// caption already contains the recipe. Asking an LLM whether to ask an LLM is
// circular; a regex that costs microseconds is not.
//
// It is deliberately a SCORE, not a rule. Captions are chaotic — emoji bullets,
// no line breaks, "measure with your heart" — so no single signal is reliable,
// but three weak signals agreeing is.

const UNIT = String.raw`(?:g|kg|ml|l|oz|lb|lbs|cup|cups|tsp|tbsp|teaspoons?|tablespoons?|cloves?|pinch|handful|slices?|sticks?|cans?|tins?|pints?|quarts?|mins?|minutes?|hrs?|hours?|scoops?|sprigs?|bunch|dash|pkg|packets?)`;

/** "2 pints", "1/2 cup", "8 oz", "½ tsp" — a number bound to a measuring word.
 *  This is the single strongest signal that text is an ingredient list. */
const NUMBER_UNIT = new RegExp(
  String.raw`(?:^|[\s(\[])(?:\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?|\d+\s+\d+\s*\/\s*\d+|[½⅓⅔¼¾⅛⅜⅝⅞])\s*-?\s*${UNIT}\b`,
  "gi",
);

/** A line that opens with a quantity — "- 1 lb of shrimp", "2 eggs". */
const QUANTITY_LINE = /^\s*(?:[-*•–—·▪️>]|\d+[.)])?\s*(?:\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?|\d+\s+\d+\s*\/\s*\d+|[½⅓⅔¼¾⅛⅜⅝⅞])\s*\S/;

const VERBS = /\b(?:preheat|bake|baked|baking|mix|stir|whisk|fold|chop|dice|diced|mince|minced|saut[ée]|fry|air[- ]?fry|boil|simmer|roast|grill|blend|marinate|season|drain|knead|pour|combine|garnish|sprinkle|toss|serve|serves|cook|cooked|heat|melt|spread|layer|refrigerate|chill|rest|sear|steam|whip|coat|brush|skillet|oven|saucepan)\b/gi;

const HEADINGS = /\b(?:ingredients?|method|directions?|instructions?|steps?|you(?:'|’)?ll need|what you need|shopping list|recipe below|full recipe)\b/gi;

/** Junk that inflates length without adding recipe signal. */
const HASHTAG_BLOCK = /(?:^|\s)#[\p{L}\p{N}_]+/gu;

export type RecipeLikelihood = {
  ok: boolean;
  /** Unbounded-ish, but ~0 for noise and ~6+ for a real ingredient list. */
  score: number;
};

/** Collapse the whitespace chaos captions arrive in, without losing the line
 *  breaks that make an ingredient list an ingredient list. */
export function normaliseText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Score recipe-ness. The threshold (4) was set against the measured fixtures in
 * docs/RESEARCH-extraction.md: the shrimp-taco reel scores well above it, a
 * caption that is only hashtags and "link in bio" scores near zero.
 */
export function looksLikeRecipe(text: string | null | undefined): RecipeLikelihood {
  if (!text) return { ok: false, score: 0 };
  const clean = normaliseText(text).replace(HASHTAG_BLOCK, " ");
  if (clean.length < 40) return { ok: false, score: 0 };

  const lines = clean.split("\n").filter((l) => l.trim() !== "");
  const numberUnit = (clean.match(NUMBER_UNIT) ?? []).length;
  const quantityLines = lines.filter((l) => QUANTITY_LINE.test(l)).length;
  const verbs = new Set((clean.match(VERBS) ?? []).map((v) => v.toLowerCase())).size;
  const headings = (clean.match(HEADINGS) ?? []).length;

  // Caps stop one very long list from swamping the other signals — we want
  // agreement between signals, not a single loud one.
  const score =
    Math.min(numberUnit, 8) * 0.9 +
    Math.min(quantityLines, 8) * 0.6 +
    Math.min(verbs, 8) * 0.45 +
    Math.min(headings, 3) * 1.2 +
    (clean.length > 350 ? 0.8 : 0);

  return { ok: score >= 4, score: Math.round(score * 100) / 100 };
}

/** Sugar for the tier gate: thin text is what justifies paying for audio. */
export function isThin(text: string | null | undefined): boolean {
  return !looksLikeRecipe(text).ok;
}
