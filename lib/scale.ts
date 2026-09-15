// Servings scaler + ingredient formatting. Pure, dependency-free, and shared by
// the cook view (frontend) and `POST /api/grocery/from-recipe/:id` (backend) so
// a scaled shopping list always matches what the screen showed.
//
// Quantities are TEXT because captions are text ("1/2", "1 1/2", "2-3", "a
// splash"). The rule is: scale what is confidently numeric, and leave anything
// else exactly as written rather than guessing.

import type { Ingredient } from "./types";

const VULGAR: Record<string, number> = {
  "½": 0.5, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 0.25, "¾": 0.75,
  "⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8, "⅙": 1 / 6, "⅚": 5 / 6,
  "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875,
};

/** "1 1/2" → 1.5, "½" → 0.5, "2" → 2, "a splash" → null. */
export function parseQuantity(raw: string | undefined | null): number | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;
  for (const [g, v] of Object.entries(VULGAR)) {
    if (s.includes(g)) s = s.replace(g, ` ${v} `);
  }
  s = s.replace(/\s+/g, " ").trim();

  // Mixed number: "1 1/2"
  const mixed = s.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixed) {
    const d = Number(mixed[3]);
    return d === 0 ? null : Number(mixed[1]) + Number(mixed[2]) / d;
  }
  // Plain fraction: "1/2"
  const frac = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (frac) {
    const d = Number(frac[2]);
    return d === 0 ? null : Number(frac[1]) / d;
  }
  // Decimal or integer, possibly with a decimal comma.
  const num = s.match(/^(\d+(?:[.,]\d+)?)$/);
  if (num) return Number(num[1].replace(",", "."));

  // Ranges ("2-3") and anything wordy are deliberately NOT scaled.
  return null;
}

const DENOMS = [2, 3, 4, 6, 8];

/** 0.75 → "3/4", 1.5 → "1 1/2", 2 → "2", 0.333 → "1/3". */
export function formatQuantity(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  const rounded = Math.round(n * 1000) / 1000;
  if (Number.isInteger(rounded)) return String(rounded);

  const whole = Math.floor(rounded);
  const frac = rounded - whole;
  for (const d of DENOMS) {
    const num = Math.round(frac * d);
    if (num > 0 && num < d && Math.abs(frac - num / d) < 0.02) {
      const f = `${num}/${d}`;
      return whole > 0 ? `${whole} ${f}` : f;
    }
  }
  // No clean fraction — one decimal reads better than 0.8333333 in a kitchen.
  return String(Math.round(rounded * 10) / 10);
}

/** Multiply an ingredient's quantity, leaving unparseable text untouched. */
export function scaleIngredient(ing: Ingredient, factor: number): Ingredient {
  if (factor === 1) return ing;
  const n = parseQuantity(ing.quantity);
  if (n === null) return ing;
  return { ...ing, quantity: formatQuantity(n * factor) };
}

export function scaleIngredients(list: Ingredient[], factor: number): Ingredient[] {
  return list.map((i) => scaleIngredient(i, factor));
}

/** "1 lb shrimp (diced)" — the one canonical rendering, used on screen and in
 *  the grocery list so the two never disagree. */
export function formatIngredient(ing: Ingredient, opts: { withNote?: boolean } = {}): string {
  const parts = [ing.quantity?.trim(), ing.unit?.trim(), ing.item.trim()].filter(Boolean);
  let s = parts.join(" ").replace(/\s+/g, " ").trim();
  if (opts.withNote && ing.note?.trim()) s += ` (${ing.note.trim()})`;
  return s;
}

/** Key used to merge duplicate grocery lines ("Shrimp" and "shrimp" are one). */
export function groceryKey(ing: Ingredient): string {
  return ing.item.trim().toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");
}

/** "6-8 tacos" → 6; "Serves 4" → 4; "a crowd" → null. Drives the scaler's base. */
export function parseServingsCount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n < 1000 ? Math.round(n) : null;
}
