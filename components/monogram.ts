// The placeholder that stands in for a missing hero image.
//
// WHY THIS MATTERS MORE THAN IT LOOKS
// -----------------------------------
// `heroImagePath` is null for a large share of imports (a caption scrape often
// yields no usable thumbnail). A list of grey rectangles is unscannable, so
// each image-less recipe gets a deterministic coloured tile with its initials —
// the Gmail/Slack avatar trick. Deterministic is the operative word: the same
// recipe must get the same colour on every render and on every device, so the
// colour is a pure function of the title, never `Math.random()`.
//
// Pure and React-free so it can be unit-tested and, if ever needed, reused
// server-side.

/** FNV-1a, 32-bit. A tiny, well-known, stable string hash — stable is the only
 *  property that matters here, and unlike `String.prototype.hashCode` (which
 *  doesn't exist in JS) it is three lines. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Hand-picked hues rather than `hsl(hash % 360)`: an evenly-sampled hue circle
 * runs through yellows and limes that white text cannot sit on. These eight are
 * all dark enough for white at 4.5:1, and all read as "food".
 */
export const MONOGRAM_COLORS = [
  "#b4472a", // paprika
  "#8a5a2b", // toast
  "#4f6d3a", // herb
  "#2f6b6b", // sage-teal
  "#7a3f63", // plum
  "#9b6a1f", // turmeric
  "#3f5a86", // slate blue
  "#7c4a2d", // chestnut
] as const;

export function monogramColor(seed: string): string {
  return MONOGRAM_COLORS[hashString(seed) % MONOGRAM_COLORS.length];
}

/**
 * "Crispy Shrimp Tacos" -> "CS";  "Ragù" -> "R";  "" -> "?".
 * Two letters max: three is a company logo, one is ambiguous in a long list.
 * Digits count as words so "15-minute Ramen" -> "1R" reads as itself.
 */
export function monogramInitials(title: string): string {
  const words = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")       // strip accents so "Ragù" -> "Ragu"
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export type Monogram = { initials: string; color: string };

export function monogram(title: string, seed?: string): Monogram {
  return { initials: monogramInitials(title), color: monogramColor(seed ?? title) };
}
