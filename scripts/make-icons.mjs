#!/usr/bin/env node
/**
 * Generates the Home Screen / favicon artwork into `public/icons/`.
 *
 * WHY THESE FILES EXIST AT ALL
 * ----------------------------
 * Without `apple-touch-icon.png`, iOS uses a *screenshot of the page* as the
 * Home Screen icon. For Mise that is a pale list of cards — unrecognisable at
 * 60px. That single failure is the whole reason this script exists; the
 * 192/512 manifest icons are for Android.
 *
 * WHY GENERATED, NOT HAND-DRAWN
 * -----------------------------
 * `sharp` is already a dependency (hero-image processing), so rendering SVG →
 * PNG costs nothing extra, and the artwork stays reviewable as CODE rather than
 * landing in git as four opaque binaries with no provenance. Change a hex here
 * and `npm run icons` re-renders every size consistently.
 *
 * THE MARK: three prep bowls — *mise en place* is literally "everything in its
 * place", the small bowls of prepped ingredients laid out before you cook.
 *
 * SIZE-AWARE, NOT SCALED: perceived stroke weight is absolute pixels, not a
 * proportion of the canvas. Three bowls tuned at 512px turn into a grey smudge
 * at 32px, so the favicon drops to a single bowl. This is why real icon sets
 * are redrawn per size rather than exported once and resampled.
 *
 * Regenerate:  npm run icons
 */
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

// Palette lifted from app/globals.css :root — keep the two in sync.
const PAPRIKA = "#c04f28";
const PAPRIKA_DARK = "#a33f1d";
const CREAM = "#faf6f1";

/**
 * One bowl: a half-disc with a foot, centred at (cx, cy) with radius r.
 * Drawn as an explicit path rather than a clipped <circle> so it renders
 * identically in sharp's resvg and in a browser preview.
 */
function bowl(cx, cy, r, fill) {
  const rim = r * 0.18;
  return [
    // the rim: a rounded bar across the top of the bowl
    `<rect x="${cx - r}" y="${cy - rim}" width="${r * 2}" height="${rim * 2}" rx="${rim}" fill="${fill}"/>`,
    // the body: a half-disc hanging from the rim
    `<path d="M ${cx - r * 0.92} ${cy} A ${r * 0.92} ${r * 0.92} 0 0 0 ${cx + r * 0.92} ${cy} Z" fill="${fill}"/>`,
  ].join("");
}

/** A chopped-ingredient dot, about to go in the bowl. */
function dot(cx, cy, r, fill) {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`;
}

function svg(size) {
  const c = size / 2;

  // Below ~64px the dots collapse into single grey pixel rows that read as dirt
  // on the screen, so small sizes keep only the bowl silhouette.
  if (size < 64) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${PAPRIKA}"/>
  ${bowl(c, size * 0.62, size * 0.33, CREAM)}
</svg>`;
  }

  // Everything stays inside r = 0.4 of the canvas from the centre: that is
  // Android's maskable safe zone (the inner 80% circle), which is what lets the
  // same PNG be declared `purpose: "maskable"` in app/manifest.ts.
  //
  // TWO DESIGNS WERE DISCARDED HERE, both for the same reason:
  //   - three bowls in a triangle read unmistakably as a SMILEY FACE (two eyes
  //     over a mouth). Pareidolia is a real icon-design hazard: the eye
  //     resolves any two-above-one arrangement as a face before it resolves it
  //     as anything else.
  //   - three bowls in a row merged into one continuous bar, because their
  //     rims touched at this scale.
  // A single bowl with three ingredient dots above it avoids both: an odd
  // number of small circles in a row does not read as eyes, and the dots are
  // far enough from the rim never to merge with it.
  const r = size * 0.26;
  const baseline = size * 0.6;
  const dotR = size * 0.045;
  const dotY = size * 0.34;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${PAPRIKA}"/>
  <!-- A soft darker ground so the mark still has depth after a launcher masks
       the corners away. -->
  <circle cx="${c}" cy="${c}" r="${size * 0.38}" fill="${PAPRIKA_DARK}" opacity="0.45"/>
  ${dot(c - size * 0.12, dotY, dotR, CREAM)}
  ${dot(c, dotY - size * 0.035, dotR, CREAM)}
  ${dot(c + size * 0.12, dotY, dotR, CREAM)}
  ${bowl(c, baseline, r, CREAM)}
</svg>`;
}

const TARGETS = [
  // iOS Home Screen. 180 is the modern @3x size; iOS applies its own rounded
  // mask, so the artwork is full-bleed with no corner radius of its own.
  ["apple-touch-icon.png", 180],
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["favicon.png", 32],
];

await mkdir(OUT, { recursive: true });
for (const [name, size] of TARGETS) {
  const png = await sharp(Buffer.from(svg(size))).png({ compressionLevel: 9 }).toBuffer();
  await writeFile(join(OUT, name), png);
  console.log(`wrote ${name} (${size}x${size}, ${png.length} bytes)`);
}
