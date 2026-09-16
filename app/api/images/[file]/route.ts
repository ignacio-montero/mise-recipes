// GET /api/images/:file — serve a stored hero image off the Docker volume.
// Next only serves static files from /public, which is baked into the image at
// build time; anything written at runtime has to come through a route handler.
import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { ApiError, handle } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // needs the filesystem; the edge runtime has none

type Ctx = { params: Promise<{ file: string }> };

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif",
};

/** Only a plain filename is ever valid here.
 *
 *  Concept: **path traversal**. `GET /api/images/..%2f..%2f.env` decodes to
 *  `../../.env`, and a naive `path.join(dir, file)` would happily walk out of
 *  the images directory and serve secrets. The defence is two-layered on
 *  purpose: an allowlist regex on the shape of the name, then a `resolve()` +
 *  prefix check on the final absolute path so that even a name this regex let
 *  through cannot escape the directory. Never sanitise by blocklisting "..".
 */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { file } = await ctx.params;
  const name = decodeURIComponent(file ?? "");

  if (!name || !SAFE_NAME.test(name) || name.includes("..") || path.basename(name) !== name) {
    throw new ApiError("bad_request", "Invalid image name.");
  }

  const dir = path.resolve(config.dataDir, "images");
  const full = path.resolve(dir, name);
  if (full !== path.join(dir, name) || !full.startsWith(dir + path.sep)) {
    throw new ApiError("bad_request", "Invalid image name.");
  }

  const type = CONTENT_TYPES[path.extname(name).toLowerCase()];
  if (!type) throw new ApiError("bad_request", "Unsupported image type.");

  let data: Buffer;
  try {
    data = await fs.readFile(full);
  } catch {
    throw new ApiError("not_found", "No such image.");
  }

  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(data.byteLength),
      // The writer names these files by content hash, so a given name's bytes
      // never change — `immutable` lets the phone cache them forever and makes
      // the recipe list feel instant offline.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
