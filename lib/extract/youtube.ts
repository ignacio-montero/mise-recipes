// TIER 1 — YouTube. Description via yt-dlp, plus auto-captions when they are
// free to take.
//
// YouTube has no caption-shaped oEmbed worth having (it returns the title and
// nothing else), so this tier is yt-dlp only — which means it is the one
// platform that simply does not work on a machine without the binary. That is
// an accepted degradation, not a bug: the container has yt-dlp, and the two
// platforms this product actually exists for (Reels, TikToks) both have a
// no-subprocess primary route.
//
// The "auto-subs if trivially available" rule: `--dump-json` ALREADY returns
// caption track URLs, so fetching one is a plain HTTPS GET and no second
// subprocess. That is worth it. Running yt-dlp again with --write-auto-subs
// would not be — the audio tier exists for the hard cases.

import type { Gathered } from "../types";
import { ytdlpJson, type YtdlpInfo } from "../ytdlp";
import { ExtractionError } from "./classify";
import { fetchText } from "./website";
import { looksLikeRecipe, normaliseText } from "./heuristics";

/** WEBVTT → plain text. Auto-captions repeat each line as the rolling window
 *  scrolls, so consecutive duplicates are dropped; without that the transcript
 *  is roughly twice as long and says everything twice. */
export function vttToText(vtt: string): string {
  const out: string[] = [];
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "WEBVTT" || /^(?:NOTE|STYLE|REGION|Kind:|Language:)/.test(line)) continue;
    if (/^\d+$/.test(line)) continue;                       // cue number
    if (line.includes("-->")) continue;                     // timing
    const text = line.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (out[out.length - 1] === text) continue;             // rolling-window dupe
    out.push(text);
  }
  return normaliseText(out.join(" "));
}

function pickCaptionUrl(info: YtdlpInfo): string | null {
  const tracks = { ...(info.automatic_captions ?? {}), ...(info.subtitles ?? {}) };
  // Human-written subtitles beat machine ones; `subtitles` is spread last so it
  // wins the key collision on "en".
  const lang = Object.keys(tracks).find((k) => k === "en" || k.startsWith("en-"));
  if (!lang) return null;
  const vtt = tracks[lang]?.find((t) => t.ext === "vtt");
  return vtt?.url ?? null;
}

export async function gatherYouTube(input: { canonicalUrl: string }): Promise<Partial<Gathered>> {
  const info = await ytdlpJson(input.canonicalUrl);
  if (!info) {
    throw new ExtractionError(
      "Could not read that YouTube video. Reply with the recipe text and I'll try again.",
    );
  }

  const tiers = ["tier1:youtube-description"];
  const description = normaliseText(info.description ?? "");
  let text = description;

  // Only reach for captions when the description is not already a recipe —
  // a good description beats a transcript every time, and the fetch is not free.
  if (!looksLikeRecipe(description).ok) {
    const url = pickCaptionUrl(info);
    if (url) {
      try {
        const { html } = await fetchText(url, { maxBytes: 1024 * 1024, expect: "any" });
        const transcript = vttToText(html);
        if (transcript.length > 80) {
          tiers.push("tier1:youtube-captions");
          text = normaliseText(`${description}\n\n--- transcript ---\n${transcript.slice(0, 20_000)}`);
        }
      } catch (e) {
        console.warn("[youtube] caption fetch failed:", (e as Error).message);
      }
    }
  }

  if (text.trim().length < 40) {
    throw new ExtractionError(
      "That YouTube video had no description or captions to read. Reply with the recipe text and I'll try again.",
    );
  }

  return {
    tiers,
    text: normaliseText(`${info.title ?? ""}\n\n${text}`),
    author: info.uploader ?? info.channel ?? null,
    thumbnailUrl: info.thumbnail ?? null,
    durationSeconds: typeof info.duration === "number" ? Math.round(info.duration) : null,
    canonicalUrl: info.webpage_url ?? input.canonicalUrl,
    structured: null,
  };
}
