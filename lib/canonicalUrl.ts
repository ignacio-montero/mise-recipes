// THE canonicaliser. There must be exactly one.
//
// ⚠️ `Recipe.sourceUrl` is UNIQUE, and a UNIQUE constraint on a *derived* value
// only enforces anything if every writer derives it with the SAME function.
// This app briefly had two — the API route stripped `www.` and the trailing
// slash, while `lib/extract/classify.ts` ADDED both back — so the route's
// "already saved?" lookup could never match what the worker had stored, and the
// constraint silently enforced nothing. Duplicate recipes on the primary ingest
// path. (Same family as Unicode-normalisation bugs in username uniqueness.)
//
// So: this function, and only this function, decides the dedupe key.

/** Hosts where the content id lives in the path, so the whole query string is
 *  disposable — except YouTube, where `?v=` IS the identity. Blanket-stripping
 *  queries would collapse every YouTube video to `youtube.com/watch`, i.e. every
 *  video after the first would be "already saved" as the first one. */
const PATH_IDENTIFIED = ["instagram.com", "tiktok.com", "facebook.com", "pinterest.com"];
const KEEP_PARAMS: Record<string, string[]> = { "youtube.com": ["v"] };
const TRACKING_PARAM =
  /^(utm_|fbclid|gclid|igshid|igsh|si$|ref$|ref_src|spm|mc_cid|mc_eid|_t$|_r$|is_from_webapp|sender_device)/i;

/** Returns null for anything that is not an absolute http(s) URL. */
export function canonicalUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  // `www.`/`m.` are the same site; folding them means the phone's mobile link and
  // the desktop link dedupe against each other. Both variants redirect in
  // practice, so the stored URL stays fetchable.
  // `host`, not `hostname`: hostname drops the port, so a self-hosted recipe
  // blog on :8443 would share a dedupe key with the same host on :443.
  const host = u.host.toLowerCase().replace(/^(www|m|mobile)\./, "");

  const params = new URLSearchParams();
  const keep = KEEP_PARAMS[host];
  if (keep) {
    for (const k of keep) {
      const v = u.searchParams.get(k);
      if (v) params.set(k, v);
    }
  } else if (!PATH_IDENTIFIED.some((h) => host === h || host.endsWith(`.${h}`))) {
    // Unknown host: a recipe site may genuinely need `?p=123`, so strip only the
    // known tracking params rather than the whole query.
    for (const [k, v] of [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (!TRACKING_PARAM.test(k)) params.append(k, v);
    }
  }

  const path = u.pathname.replace(/\/+$/, "");
  const qs = params.toString();
  return `${u.protocol}//${host}${path}${qs ? `?${qs}` : ""}`; // fragment always dropped
}
