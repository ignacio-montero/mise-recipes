// TIER 1 — TikTok. oEmbed first, yt-dlp second.
//
// TikTok publishes a real, documented, unauthenticated oEmbed endpoint, and its
// `title` field is the FULL caption — which for food creators is usually the
// entire recipe (docs/RESEARCH-extraction.md §2). One HTTPS GET, no process
// spawn, no cookies, ~200 ms. yt-dlp also works here, but it costs a subprocess
// and is the thing most likely to break when TikTok changes something, so it is
// the fallback rather than the default.

import type { Gathered } from "../types";
import { ytdlpJson } from "../ytdlp";
import { classify, ExtractionError } from "./classify";
import { fetchText } from "./website";
import { normaliseText } from "./heuristics";

type OEmbed = {
  title?: string;
  author_name?: string;
  author_url?: string;
  thumbnail_url?: string;
};

/** vm./vt. short links carry no video id. Follow the redirect and re-classify
 *  so `sourceUrl` is the same string a browser would have produced — otherwise
 *  the same video imported from a share link and from a browser would create
 *  two rows despite the UNIQUE constraint. */
async function resolveShortLink(url: string): Promise<string> {
  const { finalUrl } = await fetchText(url, { maxBytes: 64 * 1024, expect: "any" });
  const c = classify(finalUrl);
  if (!c.ok || c.platform !== "tiktok" || !c.id) {
    throw new ExtractionError("That TikTok link did not resolve to a video.", false);
  }
  return c.canonicalUrl;
}

async function oembed(url: string): Promise<OEmbed | null> {
  try {
    const { html } = await fetchText(
      `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`,
      { maxBytes: 512 * 1024, expect: "json" },
    );
    return JSON.parse(html) as OEmbed;
  } catch (e) {
    console.warn("[tiktok] oembed failed:", (e as Error).message);
    return null;
  }
}

export async function gatherTikTok(input: {
  canonicalUrl: string;
  id: string | null;
}): Promise<Partial<Gathered>> {
  const canonicalUrl = input.id ? input.canonicalUrl : await resolveShortLink(input.canonicalUrl);

  const data = await oembed(canonicalUrl);
  const caption = data?.title?.trim();
  if (caption) {
    return {
      tiers: ["tier1:tiktok-oembed"],
      text: normaliseText(caption),
      author: data?.author_name?.trim() || null,
      thumbnailUrl: data?.thumbnail_url ?? null,
      canonicalUrl,
      structured: null,
    };
  }

  const info = await ytdlpJson(canonicalUrl);
  const description = (info?.description ?? info?.title)?.trim();
  if (description) {
    return {
      tiers: ["tier1:tiktok-ytdlp"],
      text: normaliseText(description),
      author: info?.uploader ?? info?.channel ?? null,
      thumbnailUrl: info?.thumbnail ?? null,
      durationSeconds: typeof info?.duration === "number" ? Math.round(info.duration) : null,
      canonicalUrl,
      structured: null,
    };
  }

  // An empty caption is not the same failure as a dead link, but from here they
  // are indistinguishable, so the message covers both and offers the way out.
  throw new ExtractionError(
    "TikTok returned no caption. The video may be private or deleted. Reply with the caption text and I'll try again.",
  );
}
