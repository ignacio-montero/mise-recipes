// TIER 1 — Instagram. Caption first, yt-dlp second.
//
// The primary route is the public embed: `/reel/<shortcode>/embed/captioned/`
// returns ~270 KB of server-rendered HTML with the full caption inside a
// `class="Caption"` div. No auth, no cookies, no API key
// (docs/RESEARCH-extraction.md §2).
//
// ⚠️ THE TRAP, re-verified 2026-09-15: a post that is missing, private, OR a
// request Instagram simply decides not to serve returns **HTTP 200 with a
// ~623 KB logged-out JS shell** — not a 404. yt-dlp's matching failure says
// "…use --cookies-from-browser", which reads like a login wall and is not one.
// So: we detect the shell by the ABSENCE of the caption markup, never by the
// status code, and the user-facing message never suggests cookies.
//
// NEW measurement (2026-09-15, this machine): the User-Agent decides which of
// the two responses you get. Safari-family UAs get the real captioned HTML;
// Chrome and Firefox UAs get the shell, deterministically, for the same
// known-good shortcode. Hence the UA ladder below — it is not superstition,
// it is the difference between a working import and a failed one.

import type { Gathered } from "../types";
import { ytdlpJson } from "../ytdlp";
import { classify, ExtractionError } from "./classify";
import { decodeEntities, fetchText } from "./website";
import { normaliseText } from "./heuristics";

const UA_LADDER = [
  // Desktop Safari — the UA that returned the caption on every fixture.
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  // iOS Safari — also worked, and a plausible second opinion if the first is
  // being rate-limited rather than UA-filtered.
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
];

export type InstagramScrape = {
  caption: string | null;
  author: string | null;
  thumbnailUrl: string | null;
};

/** Pull the caption out of the embed markup.
 *
 *  Exported (and pure) so it can be unit-tested against a saved fixture — the
 *  live page is the one part of this pipeline most likely to change shape, and
 *  a test that needs the network is a test nobody runs. */
export function parseEmbedHtml(html: string): InstagramScrape {
  const start = html.search(/<div class="Caption"[\s>]/);
  let caption: string | null = null;

  if (start !== -1) {
    // The div contains a nested `CaptionComments` div holding the "View all N
    // comments" link. Cutting at that marker is more reliable than trying to
    // balance nested tags with a regex.
    const after = html.slice(start);
    const commentsAt = after.search(/<div class="CaptionComments"/);
    let inner = commentsAt === -1 ? after.slice(0, 20_000) : after.slice(0, commentsAt);

    // Drop the leading username anchor — it is markup furniture, not caption.
    inner = inner.replace(/<a class="CaptionUsername"[\s\S]*?<\/a>/i, "");

    caption = normaliseText(
      decodeEntities(
        inner
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/(?:p|div)\s*>/gi, "\n")
          .replace(/<[^>]+>/g, ""),
      ),
    )
      // Belt and braces: if the markup ever inlines the comments link.
      .replace(/^\s*View all \d+ comments\s*$/gim, "")
      .trim();

    if (caption.length === 0) caption = null;
  }

  const author =
    matchGroup(html, /<span class="UsernameText">([^<]+)<\/span>/i) ??
    matchGroup(html, /<a class="CaptionUsername"[^>]*>([^<]+)<\/a>/i);

  const thumb = matchGroup(html, /<img[^>]+class="EmbeddedMediaImage"[^>]+src="([^"]+)"/i);

  return {
    caption,
    author: author ? decodeEntities(author).trim() : null,
    thumbnailUrl: thumb ? decodeEntities(thumb) : null,
  };
}

function matchGroup(html: string, re: RegExp): string | null {
  const m = html.match(re);
  return m ? m[1] : null;
}

/** `/share/...` links from the iOS share sheet carry no shortcode until you
 *  follow them, so resolve first and re-classify the destination. */
async function resolveShareLink(url: string): Promise<string> {
  const { finalUrl } = await fetchText(url, { userAgent: UA_LADDER[0], maxBytes: 64 * 1024 });
  const c = classify(finalUrl);
  if (!c.ok || c.platform !== "instagram" || !c.id) {
    throw new ExtractionError("That Instagram link did not resolve to a post.", false);
  }
  return c.canonicalUrl;
}

export async function gatherInstagram(input: {
  canonicalUrl: string;
  id: string | null;
}): Promise<Partial<Gathered>> {
  const canonicalUrl = input.id ? input.canonicalUrl : await resolveShareLink(input.canonicalUrl);
  const embedUrl = `${canonicalUrl.replace(/\/+$/, "")}/embed/captioned/`;

  let scrape: InstagramScrape = { caption: null, author: null, thumbnailUrl: null };
  for (const ua of UA_LADDER) {
    try {
      const { html } = await fetchText(embedUrl, { userAgent: ua });
      scrape = parseEmbedHtml(html);
      if (scrape.caption) {
        return {
          tiers: ["tier1:instagram-embed"],
          text: scrape.caption,
          author: scrape.author,
          thumbnailUrl: scrape.thumbnailUrl,
          canonicalUrl,
          structured: null,
        };
      }
    } catch (e) {
      // A transport failure on one UA is worth retrying on the next; only the
      // last one's silence is final.
      console.warn(`[instagram] embed fetch failed (${ua.slice(0, 24)}…):`, (e as Error).message);
    }
  }

  // Fallback: yt-dlp's `description`. Works without cookies on public posts and
  // is a genuinely different code path, so it sometimes wins when the embed
  // route is being throttled.
  const info = await ytdlpJson(canonicalUrl);
  const description = info?.description?.trim();
  if (description) {
    return {
      tiers: ["tier1:instagram-ytdlp"],
      text: normaliseText(description),
      author: info?.uploader ?? info?.channel ?? scrape.author ?? null,
      thumbnailUrl: info?.thumbnail ?? scrape.thumbnailUrl ?? null,
      durationSeconds: typeof info?.duration === "number" ? Math.round(info.duration) : null,
      canonicalUrl,
      structured: null,
    };
  }

  // Deliberately NOT "log in" or "supply cookies" — see the trap note above.
  throw new ExtractionError(
    "Instagram returned no caption. The post may be private or deleted. Reply with the caption text and I'll try again.",
  );
}
