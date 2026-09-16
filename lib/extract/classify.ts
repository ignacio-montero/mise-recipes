// URL → platform, canonical form, and the security gate the whole pipeline
// sits behind. Every fetch and every subprocess in `lib/extract/*` must get its
// URL from here first.
//
// Two separate jobs live in this file because they share the same parse:
//
//   1. CLASSIFY — which extractor handles this, and what is the ONE canonical
//      spelling of this URL? `Recipe.sourceUrl` is UNIQUE, so dedupe is only as
//      good as this normalisation: the share sheet emits
//      `…/reel/ABC/?igsh=Mz…` and a browser emits `…/reel/ABC/`, and those must
//      collapse to the same row.
//   2. GUARD — a URL that arrived over Telegram is attacker-controlled data.
//      This box sits on a tailnet next to other services, so a URL pointing at
//      `http://127.0.0.1:9000/` or `http://100.74.128.98:8080/` would turn our
//      fetcher into a confused deputy (SSRF). Hosts are allowlisted for the
//      social platforms; everything else must at least resolve to a public IP.

import { promises as dns } from "node:dns";
import net from "node:net";
import type { Platform } from "../types";

/** A failure with a message that is safe (and useful) to show the user.
 *  Lives here rather than in `lib/http.ts` because the extraction pipeline also
 *  runs inside the worker, which has no Request/Response to answer. */
export class ExtractionError extends Error {
  constructor(
    message: string,
    /** False for "this URL will never work" (unsupported host, private post);
     *  true when pasting the caption by hand is a sensible next move. */
    readonly canRetryWithText = true,
  ) {
    super(message);
    this.name = "ExtractionError";
  }
}

export type SourcePlatform = Exclude<Platform, "manual">;

export type Classification =
  | {
      ok: true;
      platform: SourcePlatform;
      /** The spelling stored in `Recipe.sourceUrl`. Query strings gone. */
      canonicalUrl: string;
      host: string;
      /** Instagram shortcode / TikTok video id / YouTube id. Null for `web`,
       *  and null for share links whose id is only known after a redirect. */
      id: string | null;
    }
  | { ok: false; reason: string };

const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]);
const TIKTOK_HOSTS = new Set([
  "tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com",
]);
const YOUTUBE_HOSTS = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be",
]);

/** Instagram/TikTok/YouTube ids are opaque base-ish tokens. Anchored, because a
 *  loose match here is what lets `/reel/..%2f..` through. */
const SHORTCODE = /^[A-Za-z0-9_-]{5,32}$/;

const TRACKING_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "fbclid", "gclid", "igshid", "igsh", "si", "ref", "ref_src", "spm",
  "mc_cid", "mc_eid", "_t", "_r", "is_from_webapp", "sender_device",
];

/** People paste "instagram.com/reel/x" without a scheme; Telegram even strips
 *  it in some clients. Adding https is a convenience, NOT a relaxation — the
 *  result still goes through the same allowlist. */
function withScheme(raw: string): string {
  const s = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  return `https://${s}`;
}

function parse(raw: string): URL | null {
  try {
    return new URL(withScheme(raw));
  } catch {
    return null;
  }
}

function segments(u: URL): string[] {
  return u.pathname.split("/").map((s) => decodeURIComponent(s)).filter(Boolean);
}

function stripTracking(u: URL): URL {
  const out = new URL(u.toString());
  for (const p of TRACKING_PARAMS) out.searchParams.delete(p);
  out.hash = "";
  return out;
}

export function classify(rawUrl: string): Classification {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    return { ok: false, reason: "No URL to import." };
  }
  const u = parse(rawUrl);
  if (!u) return { ok: false, reason: "That does not look like a URL." };

  // Scheme first: `file:`, `data:` and `javascript:` are not "unsupported
  // sites", they are attempts to read something that is not a website.
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { ok: false, reason: "Only http(s) links can be imported." };
  }
  if (u.username || u.password) {
    return { ok: false, reason: "Links with embedded credentials are not accepted." };
  }
  if (u.port && u.port !== "80" && u.port !== "443") {
    return { ok: false, reason: "Only standard web ports are accepted." };
  }

  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const seg = segments(u);

  if (INSTAGRAM_HOSTS.has(host)) return classifyInstagram(u, host, seg);
  if (TIKTOK_HOSTS.has(host)) return classifyTikTok(u, host, seg);
  if (YOUTUBE_HOSTS.has(host)) return classifyYouTube(u, host, seg);

  // Generic website. No host allowlist is possible (the whole point is "any
  // recipe blog"), so the SSRF guard below carries the weight instead.
  if (isBlockedHostname(host)) {
    return { ok: false, reason: "That host is not reachable from here." };
  }
  if (!host.includes(".")) {
    return { ok: false, reason: "That does not look like a public website." };
  }
  const web = stripTracking(u);
  web.protocol = "https:"; // upgrade: we never need cleartext for a recipe page
  return { ok: true, platform: "web", canonicalUrl: web.toString(), host, id: null };
}

function classifyInstagram(u: URL, host: string, seg: string[]): Classification {
  // Accepted shapes: /reel/<code>/, /reels/<code>/, /p/<code>/, /tv/<code>/,
  // /<user>/reel/<code>/, and the /share/... links the iOS share sheet produces
  // (whose real shortcode only appears after a redirect).
  //
  // ⚠️ /share/ IS CHECKED FIRST, and the order is load-bearing. iOS emits BOTH
  // `/share/<token>/` and `/share/reel/<token>/`. In the second shape the token
  // is an opaque per-share id, NOT the post's shortcode — but it is spelled
  // exactly like `reel/<code>`, so a kinds-loop that runs first happily matches
  // it and reports a shortcode that does not exist. Two consequences, both bad:
  //   • gatherInstagram only resolves the redirect when `id === null`, so it
  //     would fetch /reel/<shareToken>/embed/captioned/ and get the logged-out
  //     shell back — i.e. "no caption" on the app's PRIMARY ingest path;
  //   • every re-share mints a fresh token, so `sourceUrl` dedupe never hits and
  //     the same reel saves again every time it is shared.
  // Deferring to the redirect is the only way to learn the real identity.
  if (seg[0] === "share") {
    return {
      ok: true, platform: "instagram", canonicalUrl: stripTracking(u).toString(), host, id: null,
    };
  }

  const kinds = new Set(["reel", "reels", "p", "tv"]);
  for (let i = 0; i < seg.length - 1; i++) {
    if (kinds.has(seg[i]) && SHORTCODE.test(seg[i + 1])) {
      const kind = seg[i] === "p" ? "p" : "reel";
      return {
        ok: true,
        platform: "instagram",
        canonicalUrl: `https://www.instagram.com/${kind}/${seg[i + 1]}/`,
        host,
        id: seg[i + 1],
      };
    }
  }
  return { ok: false, reason: "That Instagram link is not a post or reel." };
}

function classifyTikTok(u: URL, host: string, seg: string[]): Classification {
  const videoAt = seg.indexOf("video");
  if (videoAt > 0 && /^\d{6,25}$/.test(seg[videoAt + 1] ?? "")) {
    const user = seg[0].startsWith("@") ? seg[0] : `@${seg[0]}`;
    return {
      ok: true,
      platform: "tiktok",
      canonicalUrl: `https://www.tiktok.com/${user}/video/${seg[videoAt + 1]}`,
      host,
      id: seg[videoAt + 1],
    };
  }
  // vm./vt. short links and /t/<code>/ — a redirect we resolve later.
  if (host === "vm.tiktok.com" || host === "vt.tiktok.com" || seg[0] === "t") {
    const short = new URL(`https://${host}${u.pathname}`);
    return { ok: true, platform: "tiktok", canonicalUrl: short.toString(), host, id: null };
  }
  return { ok: false, reason: "That TikTok link is not a video." };
}

function classifyYouTube(u: URL, host: string, seg: string[]): Classification {
  const idOk = (v: string | null | undefined): v is string => !!v && SHORTCODE.test(v);
  let id: string | null = null;
  if (host === "youtu.be") id = seg[0] ?? null;
  else if (seg[0] === "watch") id = u.searchParams.get("v");
  else if (seg[0] === "shorts" || seg[0] === "embed" || seg[0] === "live") id = seg[1] ?? null;

  if (!idOk(id)) return { ok: false, reason: "That YouTube link is not a single video." };
  return {
    ok: true,
    platform: "youtube",
    canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    host,
    id,
  };
}

/** Throwing wrapper for call sites that treat an unsupported URL as fatal. */
export function classifyOrThrow(rawUrl: string): Extract<Classification, { ok: true }> {
  const c = classify(rawUrl);
  if (!c.ok) throw new ExtractionError(c.reason, false);
  return c;
}

// ── SSRF guard ───────────────────────────────────────────────────────────────

const BLOCKED_SUFFIXES = [".local", ".internal", ".localdomain", ".home.arpa", ".lan"];
const BLOCKED_NAMES = new Set(["localhost", "metadata.google.internal", "instance-data"]);

function isBlockedHostname(host: string): boolean {
  if (BLOCKED_NAMES.has(host)) return true;
  return BLOCKED_SUFFIXES.some((s) => host.endsWith(s));
}

/** True for anything that is not a globally routable unicast address.
 *  100.64.0.0/10 is in here deliberately: that is the tailnet this box lives
 *  on, i.e. exactly the range an attacker would aim at. */
export function isPrivateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;            // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;              // 192.0.0.0/24, 192.0.2.0/24
    if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT = the tailnet
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;                          // multicast + reserved
    return false;
  }
  if (v === 6) {
    const s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
    if (s === "::" || s === "::1") return true;
    // ::ffff:10.0.0.1 — an IPv4 address wearing an IPv6 costume.
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    if (/^f[cd]/.test(s)) return true;                  // unique local
    if (/^fe[89ab]/.test(s)) return true;               // link-local
    if (/^ff/.test(s)) return true;                     // multicast
    return false;
  }
  return true; // not an IP at all — caller should not have asked
}

/**
 * Resolve `rawUrl` and refuse anything that points inside the network.
 * Every outbound fetch in the pipeline goes through this, including image
 * downloads (a CDN URL is still data we were handed, not data we chose).
 *
 * This is best-effort, not airtight: between our DNS lookup and the runtime's
 * own, a hostile resolver could flip the answer (DNS rebinding). Closing that
 * properly means pinning the resolved IP into the socket, which `fetch` does
 * not expose. Given the threat model here — one trusted user, tailnet-only —
 * the check is deterrent enough; the note is here so nobody assumes otherwise.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new ExtractionError("That does not look like a URL.", false);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new ExtractionError("Only http(s) links can be fetched.", false);
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isBlockedHostname(host)) {
    throw new ExtractionError("That host is not reachable from here.", false);
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new ExtractionError("That address is not public.", false);
    return u;
  }
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new ExtractionError(`Could not resolve ${host}.`, false);
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
    throw new ExtractionError("That address is not public.", false);
  }
  return u;
}
