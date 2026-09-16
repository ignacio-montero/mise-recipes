// SECURITY tests for GET /api/images/:file — the path-traversal gate.
//
// Concept — **path traversal** (CWE-22). The route turns a user-supplied name
// into a filesystem path. If `..%2f..%2f.env` survives decoding, `path.join`
// walks straight out of the images directory and the route hands an attacker
// the server's secrets over HTTP.
//
// The important design choice in these tests: the files a traversal would
// reach ARE CREATED first. A test that asserts 400 while the target file does
// not exist proves nothing — it would pass just as happily against a broken
// guard that 404s. Make the attack *possible*, then prove it is refused.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mise-images-"));

vi.mock("@/lib/config", () => ({
  APP_NAME: "Mise",
  geminiConfigured: () => false,
  config: {
    dataDir: process.env.__MISE_TEST_DATA_DIR,
    ingestToken: "",
    gemini: { apiKey: "", models: [] },
    telegram: { botToken: "", chatId: "", apiBase: "" },
    apiBase: "", publicBase: "",
    extraction: { enableAudioTier: false, maxAudioSeconds: 300, cookiesFile: "" },
    worker: { enabled: false, pollMs: 2000, maxAttempts: 3 },
  },
}));

let route: typeof import("@/app/api/images/[file]/route");

beforeAll(async () => {
  process.env.__MISE_TEST_DATA_DIR = dataDir;
  fs.mkdirSync(path.join(dataDir, "images", "sub"), { recursive: true });
  // A real 1x1 PNG, so the happy path streams actual bytes.
  fs.writeFileSync(
    path.join(dataDir, "images", "hero.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
  );
  fs.writeFileSync(path.join(dataDir, "images", "sub", "x.png"), "nested");
  // The prizes a traversal would be aiming at. They exist on purpose.
  fs.writeFileSync(path.join(dataDir, "secret.txt"), "OSTA_INGEST_TOKEN=hunter2");
  fs.writeFileSync(path.join(dataDir, "secret.png"), "still not yours");

  route = await import("@/app/api/images/[file]/route");
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.__MISE_TEST_DATA_DIR;
});

const get = async (file: string) => {
  const res = await route.GET(new Request(`http://localhost/api/images/${file}`), {
    params: Promise.resolve({ file }),
  });
  return { status: res.status, res };
};

describe("serving a stored hero image", () => {
  it("returns the bytes with the right content type", async () => {
    const { status, res } = await get("hero.png");
    expect(status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(Number(res.headers.get("Content-Length"))).toBeGreaterThan(0);
  });

  it("marks the bytes immutable and forbids MIME sniffing", async () => {
    // Files are named by content hash, so the bytes behind a name never change
    // — `immutable` lets the phone cache them forever. `nosniff` stops a
    // browser deciding a "png" is really HTML and running it.
    const { res } = await get("hero.png");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("404s for a name that is fine but absent", async () => {
    expect((await get("nope.png")).status).toBe(404);
  });

  it("rejects a file type that is not an image", async () => {
    expect((await get("notes.txt")).status).toBe(400);
    expect((await get("archive.zip")).status).toBe(400);
    expect((await get("noextension")).status).toBe(400);
  });
});

describe("refusing to walk out of the images directory", () => {
  // Every one of these names, if it got through, would read a file that EXISTS
  // outside the images directory (created in beforeAll) — so a 400 here is a
  // genuine refusal, not an accidental 404.
  const attacks = [
    "..%2Fsecret.txt",       // encoded slash, the canonical form of this attack
    "..%2Fsecret.png",       // …with an allowed extension, to defeat a type-only check
    "%2e%2e%2fsecret.png",   // the dots encoded too
    "%2e%2e%2F%2e%2e%2Fetc%2Fpasswd",
    "../secret.png",         // already decoded by the framework
    "..\\secret.png",        // Windows separator
    "sub%2Fx.png",           // a *descent* is still not a plain filename
    "sub/x.png",
    "/etc/passwd",
    "%2Fetc%2Fpasswd",
    "....//secret.png",      // the "strip one .." naive-filter bypass
    "..%252Fsecret.png",     // double-encoded
    "hero.png%00.txt",       // null-byte truncation
    ".",
    "..",
    "",
  ];

  it.each(attacks)("rejects %j", async (file) => {
    const { status } = await get(file);
    expect(status).toBe(400);
  });

  it("really would have leaked, if the guard were removed", async () => {
    // Proves the premise of the whole block: the secret is genuinely readable
    // at the path the attack aims at.
    expect(fs.readFileSync(path.join(dataDir, "secret.txt"), "utf8")).toContain("hunter2");
    expect(path.resolve(path.join(dataDir, "images"), "../secret.txt"))
      .toBe(path.join(dataDir, "secret.txt"));
  });

  it("currently answers 500 to a malformed percent-escape", async () => {
    // ⚠️ KNOWN (minor) BUG — see the report. `decodeURIComponent("%")` throws
    // URIError, which escapes the handler as an unhandled error: the client
    // gets `500 internal` for what is plainly a bad request, and every probe
    // writes an "[api] unhandled" line into the logs. Not a leak — the guard
    // still refuses — but a client mistake reported as a server fault.
    // Characterisation test; replace with the `it.fails` below when fixed.
    const { status } = await get("%");
    expect(status).toBe(500);
  });

  it.fails("should answer 400 to a malformed percent-escape", async () => {
    expect((await get("%")).status).toBe(400);
    expect((await get("%zz")).status).toBe(400);
  });

  it("does not serve the nested file even though it exists", async () => {
    expect(fs.existsSync(path.join(dataDir, "images", "sub", "x.png"))).toBe(true);
    expect((await get("sub%2Fx.png")).status).toBe(400);
  });
});
