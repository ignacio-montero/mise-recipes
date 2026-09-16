// SECURITY + canonicalisation tests for lib/extract/classify.ts.
//
// Two contracts live in this file and they fail in opposite directions:
//
//   1. The SSRF guard is a **security boundary**. A URL that arrived over
//      Telegram is attacker-controlled data, and this box sits on a tailnet
//      next to other services. A miss here turns the importer into a confused
//      deputy that will fetch anything on the private network and paste the
//      response into a recipe. Security tests are written as "must REJECT"
//      assertions because the dangerous direction is the permissive one.
//   2. Canonicalisation is a **correctness boundary**. `Recipe.sourceUrl` is
//      UNIQUE, so dedupe is exactly as good as this function: too loose and two
//      different videos collapse into one recipe (real bug, caught in review,
//      regression-tested below); too strict and the same reel saves twice.
//
// No network: assertPublicUrl is exercised with literal IPs (which skip DNS
// entirely) and with a STUBBED `node:dns` for the hostname path.

import { beforeEach, describe, expect, it, vi } from "vitest";

// A **stub**: a stand-in that returns canned answers, with no assertions of its
// own (that would make it a *mock*). We stub DNS because the behaviour under
// test is "what do we do with the answer", not "can we resolve names" — and
// because a test that asks a real resolver is a test that fails offline.
const dnsAnswers = vi.hoisted(() => ({ value: [{ address: "93.184.216.34" }] as { address: string }[] }));
vi.mock("node:dns", () => ({
  promises: { lookup: vi.fn(async () => dnsAnswers.value) },
  default: { promises: { lookup: vi.fn(async () => dnsAnswers.value) } },
}));

import { assertPublicUrl, classify, classifyOrThrow, ExtractionError, isPrivateIp } from "@/lib/extract/classify";

const ok = (raw: string) => {
  const c = classify(raw);
  if (!c.ok) throw new Error(`expected ${raw} to classify, got: ${c.reason}`);
  return c;
};

describe("refusing addresses inside the network", () => {
  it("rejects loopback, private and link-local IPv4", () => {
    for (const ip of [
      "127.0.0.1", "127.255.255.254",
      "10.0.0.1", "10.255.255.255",
      "192.168.0.1", "192.168.1.254",
      "169.254.169.254", // the cloud metadata endpoint — the classic SSRF prize
      "0.0.0.0",
      "224.0.0.1", "255.255.255.255",
      "198.18.0.1",
    ]) {
      expect(isPrivateIp(ip), `${ip} must be rejected`).toBe(true);
    }
  });

  it("rejects the whole 172.16–31 block and nothing either side of it", () => {
    // Boundary-value analysis on a range that is famously got wrong by one:
    // 172.16.0.0/12 is private, but 172.15.x and 172.32.x are ordinary public
    // internet. A naive `startsWith("172.")` would blackhole both.
    expect(isPrivateIp("172.15.255.255")).toBe(false);
    expect(isPrivateIp("172.16.0.0")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
    expect(isPrivateIp("172.32.0.0")).toBe(false);
  });

  it("rejects 100.64.0.0/10 — the tailnet this box lives on", () => {
    // The highest-stakes range here: every other service on the homelab is
    // reachable at a 100.x address, so this is the range an attacker would aim
    // at, and it is NOT in most people's mental list of private ranges.
    expect(isPrivateIp("100.64.0.0")).toBe(true);
    expect(isPrivateIp("100.74.128.98")).toBe(true); // CGNAT = the tailnet this app runs on
    expect(isPrivateIp("100.127.255.255")).toBe(true);
    // ...and the addresses immediately outside it are still public.
    expect(isPrivateIp("100.63.255.255")).toBe(false);
    expect(isPrivateIp("100.128.0.0")).toBe(false);
  });

  it("rejects private IPv6, including an IPv4 address in an IPv6 costume", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("::")).toBe(true);
    expect(isPrivateIp("fc00::1")).toBe(true); // unique local
    expect(isPrivateIp("fd12:3456::1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true); // link-local
    expect(isPrivateIp("ff02::1")).toBe(true); // multicast
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true); // IPv4-mapped
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("::FFFF:192.168.1.1")).toBe(true); // case must not matter
  });

  it("allows ordinary public addresses", () => {
    expect(isPrivateIp("93.184.216.34")).toBe(false);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false);
  });

  it("treats anything that is not an IP as unsafe", () => {
    // Fail-closed default: if the caller hands this something it cannot
    // reason about, the answer is "private", never "public".
    for (const junk of ["", "not-an-ip", "999.999.999.999", "10.0.0"]) {
      expect(isPrivateIp(junk)).toBe(true);
    }
  });
});

describe("the fetch-time guard", () => {
  beforeEach(() => {
    dnsAnswers.value = [{ address: "93.184.216.34" }];
  });

  it("refuses a literal private IP without even asking DNS", async () => {
    for (const url of [
      "http://127.0.0.1:80/",
      "http://10.0.0.5/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
    ]) {
      await expect(assertPublicUrl(url)).rejects.toThrow(ExtractionError);
    }
  });

  it("refuses hostnames that name the inside of a network", async () => {
    for (const url of [
      "http://localhost/",
      "http://metadata.google.internal/",
      "http://nas.local/",
      "http://printer.lan/",
      "http://box.home.arpa/",
    ]) {
      await expect(assertPublicUrl(url)).rejects.toThrow(/not reachable/);
    }
  });

  it("refuses a public-looking hostname that RESOLVES to a private address", async () => {
    // This is the DNS-level attack: evil.example is a name you cannot
    // blocklist, whose A record points at 127.0.0.1. Only resolving it and
    // checking the ANSWER catches this.
    dnsAnswers.value = [{ address: "127.0.0.1" }];
    await expect(assertPublicUrl("https://evil.example/recipe")).rejects.toThrow(/not public/);
  });

  it("refuses a name with one public and one private answer", async () => {
    // A multi-homed name must be judged by its worst answer, not its first:
    // the runtime may pick either when it actually connects.
    dnsAnswers.value = [{ address: "93.184.216.34" }, { address: "10.1.2.3" }];
    await expect(assertPublicUrl("https://evil.example/")).rejects.toThrow(/not public/);
  });

  it("refuses a name that resolves to nothing", async () => {
    dnsAnswers.value = [];
    await expect(assertPublicUrl("https://void.example/")).rejects.toThrow(/not public/);
  });

  it("refuses non-http schemes", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/http/);
  });

  it("allows an ordinary public page through", async () => {
    const u = await assertPublicUrl("https://example.com/recipes/tacos");
    expect(u.hostname).toBe("example.com");
  });
});

describe("refusing URLs that are not websites at all", () => {
  it("rejects schemes that read something local", () => {
    for (const raw of [
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
      "javascript:alert(document.cookie)",
      "ftp://example.com/x",
    ]) {
      const c = classify(raw);
      expect(c.ok, raw).toBe(false);
      if (!c.ok) expect(c.reason).toMatch(/http/i);
    }
  });

  it("rejects embedded credentials", () => {
    // `https://www.instagram.com@evil.example/` reads as Instagram to a human
    // and resolves to evil.example in a parser — the classic phishing shape.
    const c = classify("https://www.instagram.com@evil.example/reel/C9dO9AevUQx/");
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toMatch(/credentials/i);
  });

  it("rejects non-standard ports", () => {
    // Ports are how you reach the *other* services on this box; a recipe never
    // lives on :8080.
    for (const raw of ["http://example.com:8080/r", "https://example.com:9000/r", "http://100.74.128.98:8081/"]) {
      const c = classify(raw);
      expect(c.ok, raw).toBe(false);
      if (!c.ok) expect(c.reason).toMatch(/ports/i);
    }
    expect(classify("https://example.com:443/r").ok).toBe(true);
  });

  it("rejects empty, blank and unparseable input", () => {
    for (const raw of ["", "   ", "this is not a url"]) {
      expect(classify(raw).ok, JSON.stringify(raw)).toBe(false);
    }
    expect(classify(undefined as unknown as string).ok).toBe(false);
  });

  it("rejects hostnames that name something inside the network", () => {
    for (const raw of ["http://localhost/x", "http://nas.local/x", "http://intranet/x"]) {
      expect(classify(raw).ok, raw).toBe(false);
    }
  });

  it("throws a non-retryable ExtractionError from classifyOrThrow", () => {
    // `canRetryWithText: false` is the pipeline's "this will never work", which
    // the worker reads to stop burning retries.
    try {
      classifyOrThrow("file:///etc/passwd");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExtractionError);
      expect((e as ExtractionError).canRetryWithText).toBe(false);
    }
  });
});

describe("collapsing the many spellings of one Instagram reel", () => {
  const CANON = "https://www.instagram.com/reel/C9dO9AevUQx/";

  it("gives every share-sheet variant the same canonical URL", () => {
    // If this ever regresses, every re-share of a saved reel creates a
    // duplicate recipe — the UNIQUE index cannot help, because the strings
    // genuinely differ.
    const variants = [
      "https://www.instagram.com/reel/C9dO9AevUQx/?igsh=MzRlODBiNWFlZA==",
      "https://www.instagram.com/reel/C9dO9AevUQx/",
      "https://m.instagram.com/reel/C9dO9AevUQx/",
      "https://instagram.com/reel/C9dO9AevUQx/",
      "https://www.instagram.com/reels/C9dO9AevUQx/",
      "https://www.instagram.com/reel/C9dO9AevUQx/?utm_source=ig_web_copy_link",
      "https://www.instagram.com/reel/C9dO9AevUQx/#comments",
      "instagram.com/reel/C9dO9AevUQx/", // Telegram strips the scheme on some clients
      "https://www.instagram.com/chefsomebody/reel/C9dO9AevUQx/",
    ];
    for (const v of variants) {
      const c = ok(v);
      expect(c.platform).toBe("instagram");
      expect(c.canonicalUrl, v).toBe(CANON);
      expect(c.id).toBe("C9dO9AevUQx");
    }
  });

  it("keeps a /p/ post distinct from a /reel/", () => {
    expect(ok("https://www.instagram.com/p/C9dO9AevUQx/").canonicalUrl)
      .toBe("https://www.instagram.com/p/C9dO9AevUQx/");
  });

  it("keeps two different reels apart", () => {
    expect(ok("https://www.instagram.com/reel/C9dO9AevUQx/").canonicalUrl)
      .not.toBe(ok("https://www.instagram.com/reel/C41MJlUSKcU/").canonicalUrl);
  });

  it("passes a bare /share/<token>/ link through for the redirect to resolve", () => {
    const c = ok("https://www.instagram.com/share/BAF6qMfDnE/");
    expect(c.platform).toBe("instagram");
    expect(c.id).toBeNull(); // the real shortcode is only known after a redirect
    expect(c.canonicalUrl).toBe("https://www.instagram.com/share/BAF6qMfDnE/");
  });

  // FIXED 2026-09-16 (was an `it.fails`): classifyInstagram now checks the
  // /share/ prefix BEFORE the reel/p/tv loop, so the share token can no longer
  // masquerade as a shortcode. Promoted back to a normal test.
  it("defers /share/reel/<token>/ links to the redirect", () => {
    // Instagram's iOS share sheet emits BOTH `/share/<token>/` and
    // `/share/reel/<token>/`. In the second shape the token is an opaque share
    // id, NOT the post's shortcode — but classifyInstagram's `kinds` loop runs
    // before the `seg[0] === "share"` branch and matches `reel/<token>`, so the
    // token is treated as a real shortcode. Consequences:
    //   • gatherInstagram skips resolveShareLink (it only resolves when
    //     `id === null`) and fetches /reel/<shareToken>/embed/captioned/, which
    //     Instagram answers with the logged-out shell → "no caption" failure;
    //   • every re-share mints a fresh token, so sourceUrl dedupe never hits.
    const c = ok("https://www.instagram.com/share/reel/_abc123XYZ/");
    expect(c.id).toBeNull();
  });

  it("rejects an Instagram profile or a traversal attempt dressed as a reel", () => {
    expect(classify("https://www.instagram.com/chefsomebody/").ok).toBe(false);
    // `..%2Fsecret` decodes to `../secret`, which the anchored SHORTCODE regex
    // refuses — this is why the id pattern is anchored rather than a loose scan.
    expect(classify("https://www.instagram.com/reel/..%2Fsecret/").ok).toBe(false);
    expect(classify("https://www.instagram.com/reel/ab/").ok).toBe(false); // too short to be an id
  });
});

describe("collapsing TikTok links", () => {
  it("canonicalises a full video URL and drops the tracking tail", () => {
    const c = ok("https://www.tiktok.com/@butterworthdasyrup/video/7484033605795204394?is_from_webapp=1&sender_device=pc");
    expect(c.platform).toBe("tiktok");
    expect(c.canonicalUrl).toBe("https://www.tiktok.com/@butterworthdasyrup/video/7484033605795204394");
    expect(c.id).toBe("7484033605795204394");
  });

  it("agrees between the m. and www. spellings", () => {
    expect(ok("https://m.tiktok.com/@chef/video/7484033605795204394").canonicalUrl)
      .toBe(ok("https://www.tiktok.com/@chef/video/7484033605795204394").canonicalUrl);
  });

  it("keeps a vm. short link verbatim for the redirect to resolve", () => {
    const c = ok("https://vm.tiktok.com/ZGdfXcVbN/");
    expect(c.platform).toBe("tiktok");
    expect(c.id).toBeNull();
  });

  it("keeps two different videos apart", () => {
    expect(ok("https://www.tiktok.com/@chef/video/7484033605795204394").canonicalUrl)
      .not.toBe(ok("https://www.tiktok.com/@chef/video/7484033605795204395").canonicalUrl);
  });

  it("rejects a TikTok profile link", () => {
    expect(classify("https://www.tiktok.com/@chef").ok).toBe(false);
  });
});

describe("collapsing YouTube links", () => {
  it("canonicalises watch, youtu.be, shorts and m. to one URL", () => {
    const canon = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    for (const v of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ?si=abcdef",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
    ]) {
      expect(ok(v).canonicalUrl, v).toBe(canon);
    }
  });

  it("does NOT collapse two different videos into one recipe", () => {
    // REGRESSION TEST. A real bug found in review: stripping the whole query
    // string on YouTube (correct for Instagram, where the id is in the path)
    // reduced every watch URL to `https://www.youtube.com/watch`, so the second
    // video imported would 409 against the first as "already saved".
    const a = ok("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    const b = ok("https://www.youtube.com/watch?v=9bZkp7q19f0");
    expect(a.canonicalUrl).not.toBe(b.canonicalUrl);
    expect(a.canonicalUrl).toContain("v=dQw4w9WgXcQ");
    expect(b.canonicalUrl).toContain("v=9bZkp7q19f0");
  });

  it("rejects a YouTube link that is not a single video", () => {
    for (const raw of [
      "https://www.youtube.com/",
      "https://www.youtube.com/watch",
      "https://www.youtube.com/@chef",
      "https://www.youtube.com/playlist?list=PL123",
    ]) {
      expect(classify(raw).ok, raw).toBe(false);
    }
  });
});

describe("ordinary recipe websites", () => {
  it("upgrades to https and strips tracking while keeping real query params", () => {
    const c = ok("http://example.com/recipes/tacos?utm_source=ig&utm_medium=social&p=123");
    expect(c.platform).toBe("web");
    expect(c.canonicalUrl).toBe("https://example.com/recipes/tacos?p=123");
  });

  it("drops the fragment so #recipe-card does not create a second row", () => {
    expect(ok("https://example.com/tacos#recipe-card").canonicalUrl)
      .toBe("https://example.com/tacos");
  });

  it("carries no platform id, because a web page has none", () => {
    expect(ok("https://example.com/tacos").id).toBeNull();
  });
});
