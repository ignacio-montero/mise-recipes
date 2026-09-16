// UNIT tests for lib/canonicalUrl.ts — the dedupe key.
//
// WHY THIS FILE EXISTS AS A UNIT TEST
// -----------------------------------
// This is the **test pyramid** doing its job. Until recently this logic was
// reachable only through `POST /api/imports`, so every case cost a database, a
// migration and an HTTP round trip — which meant, in practice, that only four
// or five cases were ever covered. The function is pure (string in, string out),
// so pulling it into `lib/` made exhaustive coverage cheap: the 30-odd cases
// below run in under a millisecond, with no fixture and nothing to clean up.
// The integration tests in `api-imports.test.ts` still exist, but they now only
// have to prove the route CALLS this thing, not that the rules are right.
//
// WHY THE RULES MATTER MORE THAN THEY LOOK
// ----------------------------------------
// `Recipe.sourceUrl` is UNIQUE, and a UNIQUE constraint on a DERIVED value only
// enforces anything if every writer derives it the same way. The app briefly had
// two normalisers that disagreed (one stripped `www.`, the other added it back),
// so the "already saved?" lookup could never match what was stored and the index
// silently enforced nothing. Both directions of error are expensive and they are
// NOT symmetrical:
//
//   • too LOOSE → the same reel saves twice. Annoying, visible, self-correcting.
//   • too TIGHT → two different recipes collapse into one, and the second import
//     answers "already saved" pointing at someone else's dish. The user loses a
//     recipe and is told everything worked.
//
// So roughly half the tests below are NEGATIVE — "these two must NOT collapse".
// That half is the one people forget to write.

import { describe, expect, it } from "vitest";
import { canonicalUrl } from "@/lib/canonicalUrl";

/** Reads better than `expect(canonicalUrl(a)).toBe(canonicalUrl(b))` at the
 *  call site, and puts both URLs in the failure message. */
const same = (a: string, b: string) =>
  expect([a, canonicalUrl(a)]).toEqual([a, canonicalUrl(b)]);
const different = (a: string, b: string) =>
  expect(canonicalUrl(a)).not.toBe(canonicalUrl(b));

describe("what is not a URL at all", () => {
  it("returns null rather than throwing, for every shape of non-URL", () => {
    // Returning null instead of throwing is the contract that lets the caller
    // decide the status code; the route turns it into a 400.
    for (const raw of ["", "   ", "not a url", "/relative", "example.com/no-scheme", "//protocol-relative"]) {
      expect(canonicalUrl(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it("refuses non-http(s) schemes", () => {
    // These are the ones that matter: the URL is later FETCHED by the server, so
    // a `file:` that survived canonicalisation is a local-file-read primitive
    // and `javascript:` is a stored-XSS vector if it is ever rendered as a link.
    // Allow-list, never deny-list.
    for (const raw of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,<h1>x", "ftp://example.com/x"]) {
      expect(canonicalUrl(raw), raw).toBeNull();
    }
  });

  it("tolerates surrounding whitespace, because share sheets add it", () => {
    expect(canonicalUrl("  https://instagram.com/reel/X  ")).toBe("https://instagram.com/reel/X");
  });
});

describe("spellings that mean the same post", () => {
  const REEL = "https://instagram.com/reel/C9dO9AevUQx";

  it("folds www., m. and mobile. onto the bare host", () => {
    expect(canonicalUrl("https://www.instagram.com/reel/C9dO9AevUQx")).toBe(REEL);
    expect(canonicalUrl("https://m.instagram.com/reel/C9dO9AevUQx")).toBe(REEL);
    expect(canonicalUrl("https://mobile.instagram.com/reel/C9dO9AevUQx")).toBe(REEL);
  });

  it("folds the trailing slash, including a silly number of them", () => {
    expect(canonicalUrl("https://instagram.com/reel/C9dO9AevUQx/")).toBe(REEL);
    expect(canonicalUrl("https://instagram.com/reel/C9dO9AevUQx///")).toBe(REEL);
  });

  it("drops the fragment, which is never part of what the server sees", () => {
    expect(canonicalUrl("https://instagram.com/reel/C9dO9AevUQx#comments")).toBe(REEL);
    expect(canonicalUrl("https://instagram.com/reel/C9dO9AevUQx/#")).toBe(REEL);
  });

  it("lower-cases the host but NOT the path", () => {
    // Hostnames are case-insensitive by RFC; paths are not. `/reel/C9dO9AevUQx`
    // and `/reel/c9do9aevuqx` are two different posts as far as Instagram is
    // concerned, so lower-casing the whole URL would be the "too tight" error.
    expect(canonicalUrl("https://WWW.Instagram.COM/reel/C9dO9AevUQx")).toBe(REEL);
    different("https://instagram.com/reel/C9dO9AevUQx", "https://instagram.com/reel/c9do9aevuqx");
  });

  it("folds all of them at once, which is what a real share link looks like", () => {
    same(
      "https://www.instagram.com/reel/C9dO9AevUQx/?igshid=MzRlODBiNWFlZA%3D%3D&utm_source=ig_web_copy_link#comments",
      "https://m.instagram.com/reel/C9dO9AevUQx",
    );
  });
});

describe("tracking parameters", () => {
  // `igshid` is the one that actually bit: Instagram's share sheet stamps a
  // FRESH one on every share, so without stripping it the same reel arrives as
  // a different URL every single time and dedupe can never fire.
  it("strips the share-sheet and analytics junk", () => {
    const clean = "https://blog.example/tacos";
    for (const param of [
      "igshid=abc", "igsh=abc", "utm_source=ig", "utm_medium=social", "utm_campaign=x",
      "fbclid=abc", "gclid=abc", "si=abc", "ref=share", "ref_src=twsrc",
      "spm=a1b2", "mc_cid=1", "mc_eid=2", "_t=xyz", "_r=1",
      "is_from_webapp=1", "sender_device=pc",
    ]) {
      expect(canonicalUrl(`${clean}?${param}`), param).toBe(clean);
    }
  });

  it("keeps a real query parameter on a site we know nothing about", () => {
    // The asymmetry from the header: a food blog may genuinely serve the recipe
    // at `?p=123`, and stripping it would collapse every post on that blog into
    // one. On an unknown host we strip only what we RECOGNISE as tracking.
    expect(canonicalUrl("https://blog.example/recipe?p=123&utm_source=ig")).toBe(
      "https://blog.example/recipe?p=123",
    );
    different("https://blog.example/recipe?p=123", "https://blog.example/recipe?p=456");
  });

  it("does not strip a parameter that merely starts like a tracking one", () => {
    // The pattern anchors `si`, `ref`, `_t` and `_r` with `$` precisely so that
    // `site`, `refrigerate` and `_time` survive. A prefix match here would
    // silently mangle real URLs.
    expect(canonicalUrl("https://blog.example/r?site=uk")).toBe("https://blog.example/r?site=uk");
    expect(canonicalUrl("https://blog.example/r?reference=7")).toBe("https://blog.example/r?reference=7");
  });

  it("sorts the surviving parameters, so param ORDER cannot fork the key", () => {
    // A dedupe key must be canonical, not merely cleaned: `?a=1&b=2` and
    // `?b=2&a=1` are the same request and must produce the same string.
    same("https://blog.example/r?b=2&a=1", "https://blog.example/r?a=1&b=2");
  });
});

describe("hosts where the path is the identity", () => {
  it("throws away the whole query string on Instagram, TikTok, Facebook, Pinterest", () => {
    // On these, the content id lives in the path, so every query parameter is
    // disposable — which is stronger (and safer) than trying to keep the
    // tracking list exhaustive for platforms that invent new params constantly.
    expect(canonicalUrl("https://www.tiktok.com/@chef/video/7218?is_from_webapp=1&sender_device=pc&web_id=99"))
      .toBe("https://tiktok.com/@chef/video/7218");
    expect(canonicalUrl("https://www.facebook.com/reel/123?mibextid=abc")).toBe("https://facebook.com/reel/123");
    expect(canonicalUrl("https://www.pinterest.com/pin/123/?invite_code=xyz")).toBe("https://pinterest.com/pin/123");
  });

  it("applies the same rule to their subdomains, e.g. the vm.tiktok.com short link", () => {
    expect(canonicalUrl("https://vm.tiktok.com/ZGeKcLQAB/?k=1")).toBe("https://vm.tiktok.com/ZGeKcLQAB");
  });

  it("still keeps two different posts on the same platform apart", () => {
    different(
      "https://www.tiktok.com/@chef/video/7218",
      "https://www.tiktok.com/@chef/video/7219",
    );
  });
});

describe("YouTube, where the query string IS the identity", () => {
  it("keeps ?v= and drops everything else", () => {
    expect(canonicalUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL123&si=abc"))
      .toBe("https://youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("does NOT collapse two different videos — the bug this rule exists to prevent", () => {
    // REGRESSION TEST. The blanket "strip the query string" rule that is right
    // for Instagram reduces every watch URL to `youtube.com/watch`, so the
    // second video imported would answer "already saved" and hand back the
    // FIRST video's recipe. Silent data loss dressed up as a successful import.
    different(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=9bZkp7q19f0",
    );
    expect(canonicalUrl("https://www.youtube.com/watch?v=9bZkp7q19f0")).toBe(
      "https://youtube.com/watch?v=9bZkp7q19f0",
    );
  });

  it("folds the m. and www. spellings of the same video together", () => {
    same("https://m.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=9");
  });

  it("handles a YouTube URL with no ?v= at all without producing a stray '?'", () => {
    expect(canonicalUrl("https://www.youtube.com/@chefsomebody")).toBe("https://youtube.com/@chefsomebody");
    expect(canonicalUrl("https://www.youtube.com/watch")).toBe("https://youtube.com/watch");
  });
});

describe("properties that make this usable as a UNIQUE key", () => {
  it("is IDEMPOTENT: canonicalising a canonical URL changes nothing", () => {
    // The single most important property in the file, and the one that makes
    // the worker's "every stored sourceUrl is already canonical" invariant safe.
    // Without it, re-deriving a key from a stored value would drift, and the
    // UNIQUE index would stop meaning anything. This is **property-based
    // thinking** applied by hand: f(f(x)) === f(x) for all x.
    for (const raw of [
      "https://www.instagram.com/reel/C9dO9AevUQx/?igshid=x#c",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=9",
      "https://blog.example/recipe?b=2&a=1&utm_source=ig",
      "https://vm.tiktok.com/ZGeKcLQAB/",
      "http://m.example.co.uk/a/b/c///",
    ]) {
      const once = canonicalUrl(raw)!;
      expect(canonicalUrl(once), raw).toBe(once);
    }
  });

  it("never returns a string with a fragment, a trailing slash or a leading 'www.'", () => {
    for (const raw of [
      "https://www.a.example/x/#frag",
      "https://m.b.example/y/",
      "https://c.example/z?utm_source=q#frag",
    ]) {
      const out = canonicalUrl(raw)!;
      expect(out).not.toContain("#");
      expect(out.endsWith("/")).toBe(false);
      expect(out).not.toContain("//www.");
    }
  });
});

describe("edges worth knowing about (documented limitations, not aspirations)", () => {
  // These tests exist so the limits are WRITTEN DOWN and a change to any of them
  // is a deliberate one. None is a stop-ship: each needs an input the app does
  // not realistically receive.

  it("treats http:// and https:// as different recipes", () => {
    // Defensible — they really are different resources — but it does mean a
    // recipe shared once over http and once over https saves twice. Share
    // sheets emit https, so this has no practical reach today.
    different("http://blog.example/tacos", "https://blog.example/tacos");
  });

  it("keeps a non-default port, so two hosts on different ports stay distinct", () => {
    // Was a characterisation test recording a bug: canonicalUrl normalised
    // `hostname` (which drops the port) rather than `host`, so
    // `a.example:8443/x` and `a.example/x` collapsed to one dedupe key. Fixed
    // 2026-09-16 — harmless on the public web, but wrong the moment anyone
    // imports from a self-hosted blog on a port.
    expect(canonicalUrl("https://blog.example:8443/tacos")).toBe("https://blog.example:8443/tacos");
    different("https://blog.example:8443/tacos", "https://blog.example/tacos");
  });

  it("does not know that youtu.be/X and youtube.com/watch?v=X are one video", () => {
    // By design: resolving a short link needs a network round trip, which does
    // not belong in a pure function. The WORKER closes this gap — it dedupes
    // again after following the redirect (lib/worker.ts `saveRecipe`), which is
    // the only place the resolved URL is known.
    different("https://youtu.be/dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("keeps an empty path as no path at all", () => {
    expect(canonicalUrl("https://blog.example/")).toBe("https://blog.example");
    expect(canonicalUrl("https://blog.example")).toBe("https://blog.example");
  });

  it("preserves a duplicated query parameter rather than silently picking one", () => {
    expect(canonicalUrl("https://blog.example/r?a=1&a=2")).toBe("https://blog.example/r?a=1&a=2");
  });
});
