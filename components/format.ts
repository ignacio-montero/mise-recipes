// Pure display formatting. No React, no DOM, no imports from the app — which
// is the point: everything here is a plain function over data, so a test can
// call `metaLine(recipe)` directly instead of rendering a component and
// grepping the HTML for "25 min".
//
// This is the "extract the logic, leave the component holding only effects"
// move that `components/confirmOutcome.ts` makes in Blue Plaques.

import type { Platform, Recipe } from "./types";

/** 25 -> "25 min"; 90 -> "1 h 30"; 120 -> "2 h"; null -> null. */
export function formatMinutes(total: number | null | undefined): string | null {
  if (total === null || total === undefined || !Number.isFinite(total) || total <= 0) return null;
  const mins = Math.round(total);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h} h ${m}`;
}

export const PLATFORM_LABEL: Record<Platform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  web: "Web",
  manual: "By hand",
};

/** A single glyph per platform. Emoji rather than an icon set: five glyphs do
 *  not justify a dependency, and iOS renders them in colour for free. */
export const PLATFORM_GLYPH: Record<Platform, string> = {
  instagram: "\u{1F4F7}", // camera
  tiktok: "\u{1F3B5}",    // musical note
  youtube: "\u{25B6}\u{FE0F}",
  web: "\u{1F310}",
  manual: "\u{270D}\u{FE0F}",
};

/**
 * The one-line summary under a recipe title:
 *   "⏱ 25 min · 🍽 6-8 tacos · 📷 @author"
 * Every part is optional — a caption-scraped Reel often has none of them — and
 * empty parts are dropped rather than rendered as "· ·".
 */
export function metaLine(
  r: Pick<Recipe, "totalMinutes" | "servings" | "sourceAuthor" | "sourcePlatform">,
): string {
  const parts: string[] = [];
  const time = formatMinutes(r.totalMinutes);
  if (time) parts.push(`⏱ ${time}`);
  if (r.servings?.trim()) parts.push(`\u{1F37D} ${r.servings.trim()}`);
  if (r.sourceAuthor?.trim()) {
    const a = r.sourceAuthor.trim();
    parts.push(`${PLATFORM_GLYPH[r.sourcePlatform] ?? ""} ${a.startsWith("@") ? a : `@${a}`}`.trim());
  }
  return parts.join(" · ");
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "just now" / "12 min ago" / "3 h ago" / "yesterday" / "4 days ago" / a date.
 *
 * `now` is an argument with a default rather than a hidden `Date.now()` call so
 * the function is deterministic and testable. Relative time is also why the
 * components that use it render it in an effect-free way: see the note on
 * hydration in components/RecipeCard.tsx.
 */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = now - t;
  if (diff < 0) return "just now";
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR);
    return `${h} h ago`;
  }
  const days = Math.floor(diff / DAY);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** "instagram.com" from a URL; "" when it isn't one. Used for the source link. */
export function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Accepts a whole pasted message and finds the first URL in it — Instagram's
 *  "Copy link" sometimes pastes a sentence, and TikTok always does. */
export function extractUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>"')]+/i);
  return m ? m[0].replace(/[.,]$/, "") : null;
}

/** "3 ingredients · 2 steps" for the import result + list card counts. */
export function countsLine(r: Pick<Recipe, "ingredients" | "steps">): string {
  const i = r.ingredients.length;
  const s = r.steps.length;
  return `${i} ingredient${i === 1 ? "" : "s"} · ${s} step${s === 1 ? "" : "s"}`;
}
