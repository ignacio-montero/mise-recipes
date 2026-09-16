// Hero images: fetch the platform's thumbnail once, at import time, and serve it
// off our own volume forever after.
//
// Why copy it at all instead of storing the CDN URL? Instagram and TikTok
// thumbnail URLs are signed and expire within days, so a saved recipe would go
// blank; and rendering them directly would leak a request to Meta every time the
// list scrolls. One 100 KB copy buys a permanently working, offline-capable card.
//
// Three rules hold this file together:
//   1. The URL came from a third party, so it goes through the SAME SSRF guard
//      as everything else (`fetchBytes` → `assertPublicUrl` on every redirect
//      hop). A CDN URL is still data we were handed, not data we chose.
//   2. Bytes are capped, then re-encoded by sharp. We never serve the original
//      file — re-encoding is what turns "some bytes with an image/jpeg header"
//      into an actual image, and strips EXIF/geotags on the way.
//   3. The filename is the hash of the FINAL bytes (content addressing), so a
//      given name's contents can never change. That is precisely what makes the
//      `immutable` cache header on /api/images/:file honest.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { config } from "./config";
import { fetchBytes } from "./extract/website";

/** Generous for a thumbnail, small enough that a hostile 38 MB "JPEG" is
 *  refused mid-stream rather than after it lands on the SSD. */
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

/** Portrait reels are 1080 wide at most; anything larger is wasted bytes on a
 *  phone screen. `fit: "inside"` never crops — a cropped hero image of a dish
 *  is worse than a letterboxed one. */
const MAX_EDGE = 1080;

/** Decompression-bomb guard: a 200 KB PNG can declare 30000x30000 pixels and
 *  ask sharp for ~3.6 GB of RAM on a box with an 8 GB ceiling. sharp's own
 *  default limit is far higher than anything a recipe thumbnail needs. */
const MAX_PIXELS = 40_000_000;

/** What sharp must recognise the bytes as. An SVG is a script container, not a
 *  picture, and is excluded deliberately. */
const ALLOWED_FORMATS = new Set(["jpeg", "jpg", "png", "webp", "gif", "avif", "tiff"]);

export function imagesDir(): string {
  return path.resolve(config.dataDir, "images");
}

/**
 * Download, validate, normalise and store one image.
 *
 * Returns the URL the API contract wants — `"/api/images/<file>"`, NOT a disk
 * path — or `null` if anything at all went wrong. Never throws: a hero image is
 * decorative, and an import that succeeded at the hard part (the recipe) must
 * not fail at the easy part.
 */
export async function saveHeroImage(url: string | null | undefined): Promise<string | null> {
  const source = url?.trim();
  if (!source) return null;

  try {
    const { bytes } = await fetchBytes(source, {
      maxBytes: MAX_DOWNLOAD_BYTES,
      timeoutMs: FETCH_TIMEOUT_MS,
      accept: "image/avif,image/webp,image/jpeg,image/png,*/*;q=0.8",
      // The content-type header is checked here; the real proof is sharp
      // decoding it below. Headers are a claim, pixels are evidence.
      expect: "image",
    });

    const input = sharp(Buffer.from(bytes), { limitInputPixels: MAX_PIXELS, failOn: "error" });
    const meta = await input.metadata();
    if (!meta.format || !ALLOWED_FORMATS.has(meta.format) || !meta.width || !meta.height) {
      console.warn(`[images] not a usable image (${meta.format ?? "unknown"}): ${source}`);
      return null;
    }

    const out = await input
      // `rotate()` with no argument applies the EXIF orientation and then drops
      // it — otherwise a phone-shot thumbnail renders sideways in <img>.
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      // WebP over JPEG: ~30% smaller at the same quality, supported by every
      // browser this PWA can run in (iOS Safari 14+), and already in the
      // /api/images content-type table.
      .webp({ quality: 80 })
      .toBuffer();

    return await writeContentAddressed(out, ".webp");
  } catch (e) {
    // Includes the SSRF guard's refusals — they belong in the log, not in the
    // user's import error.
    console.warn(`[images] could not store ${source}:`, (e as Error).message);
    return null;
  }
}

/** Write bytes under their own hash, skipping the write if that content is
 *  already on disk (two recipes sharing a thumbnail cost one file). */
async function writeContentAddressed(data: Buffer, ext: string): Promise<string> {
  // 20 hex chars ≈ 80 bits: collision-proof for a personal recipe box, and
  // short enough to read in a URL. Full SHA-256 would be 64 characters of noise.
  const name = crypto.createHash("sha256").update(data).digest("hex").slice(0, 20) + ext;
  const dir = imagesDir();
  await fs.mkdir(dir, { recursive: true });
  const full = path.join(dir, name);

  if (await exists(full)) return `/api/images/${name}`;

  // Write-then-rename, not write-in-place: `rename` is atomic within a
  // filesystem, so a reader can only ever see the complete file. Writing
  // directly would let /api/images serve a half-written image if the phone
  // requested it mid-write.
  const tmp = path.join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, full);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  return `/api/images/${name}`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
