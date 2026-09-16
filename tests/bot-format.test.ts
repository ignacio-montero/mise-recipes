// UNIT tests for bot/format.ts — every string the bot renders.
//
// This module was deliberately written as pure functions so it could be tested
// with no Telegram token and no socket (the "pure render / IO shell" split).
// These tests are the payoff: they run in milliseconds and cover the two places
// a bot silently breaks in production — ESCAPING (a message Telegram rejects
// with 400 is a message the user never sees) and URL EXTRACTION (get the
// offsets wrong and the import starts on a truncated link).

import { describe, expect, it } from "vitest";
import {
  chatIdText,
  doneText,
  duplicateText,
  escapeAttr,
  escapeHtml,
  extractUrls,
  failedText,
  findText,
  link,
  listText,
  logLine,
  parseCommand,
  progressText,
  recipeUrl,
  redact,
} from "@/bot/format";
import type { RecipeDTO } from "@/lib/types";

describe("escaping text on its way into a Telegram message", () => {
  it("escapes the three characters HTML parse mode defines", () => {
    expect(escapeHtml("<b>")).toBe("&lt;b&gt;");
    expect(escapeHtml("Ben & Jerry")).toBe("Ben &amp; Jerry");
  });

  it("escapes the ampersand first so nothing is double-escaped", () => {
    // Order matters: escaping "<" first would produce "&lt;", and a later
    // "&" → "&amp;" pass would turn that into "&amp;lt;" — the user sees the
    // raw markup instead of a "<".
    expect(escapeHtml("<&>")).toBe("&lt;&amp;&gt;");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("leaves the titles that broke Markdown mode completely alone", () => {
    // This is the whole reason the bot renders HTML rather than Telegram's
    // legacy Markdown: `*` and `_` have no meaning in HTML text nodes, so a
    // recipe called "Chicken_Tikka" renders instead of 400-ing and vanishing.
    expect(escapeHtml("Chicken_Tikka")).toBe("Chicken_Tikka");
    expect(escapeHtml("Mum's *secret* pasta")).toBe("Mum's *secret* pasta");
    expect(escapeHtml("[brackets] and `backticks`")).toBe("[brackets] and `backticks`");
  });

  it("survives emoji and accents untouched", () => {
    expect(escapeHtml("Crème brûlée 🔥")).toBe("Crème brûlée 🔥");
  });

  it("adds the quote character when the text goes into an attribute", () => {
    // An unescaped `"` in href="…" ends the attribute early and lets the rest
    // of the URL become new markup — the same injection class as XSS.
    expect(escapeAttr('https://x/?a="b"')).toBe("https://x/?a=&quot;b&quot;");
    expect(escapeHtml('"')).toBe('"'); // …but only in attributes
  });

  it("escapes both halves of a link", () => {
    expect(link('https://x/?a="b"&c=1', "Fish & <chips>"))
      .toBe('<a href="https://x/?a=&quot;b&quot;&amp;c=1">Fish &amp; &lt;chips&gt;</a>');
  });

  it("escapes an injected title inside the success message", () => {
    const recipe = {
      title: "<script>alert(1)</script> & chips",
      ingredients: [{ item: "a" }, { item: "b" }],
      steps: ["one"],
      servings: "6-8 tacos",
    } as RecipeDTO;
    const out = doneText(recipe, "https://mise.example/recipe/abc");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    // Sanity on the rendering itself (API_SPEC §7): counts are pluralised.
    expect(out).toContain("2 ingredients · 1 step · 6-8 tacos");
  });
});

describe("pulling the URL out of a Telegram message", () => {
  it("prefers Telegram's own entity spans over a regex", () => {
    const text = "check this https://www.instagram.com/reel/C9dO9AevUQx/ out";
    const offset = text.indexOf("https://");
    const url = "https://www.instagram.com/reel/C9dO9AevUQx/";
    expect(extractUrls(text, [{ type: "url", offset, length: url.length }])).toEqual([url]);
  });

  it("counts entity offsets in UTF-16 units, so an emoji before the link is 2", () => {
    // THE classic bug in this area. Telegram counts offsets in UTF-16 code
    // units; "🍤" is a surrogate pair (2 units) while `[..."🍤"].length` is 1.
    // JavaScript string indices are also UTF-16, so slice() is correct as-is —
    // this test is what proves the code did not "helpfully" convert.
    const url = "https://www.tiktok.com/@chef/video/7484033605795204394";
    const text = `🍤 ${url}`;
    expect(text.indexOf("https://")).toBe(3); // 2 for the emoji + 1 for the space
    expect(extractUrls(text, [{ type: "url", offset: 3, length: url.length }])).toEqual([url]);
  });

  it("handles several emoji and an astral-plane character before the link", () => {
    const url = "https://example.com/r";
    const text = `🔥🌮👨‍🍳 ${url}`;
    const offset = text.indexOf("https://");
    expect(extractUrls(text, [{ type: "url", offset, length: url.length }])).toEqual([url]);
  });

  it("reads a text_link, whose visible text is not a URL at all", () => {
    // No regex could ever find this one: the message body says "this recipe"
    // and the URL lives only in the entity.
    const urls = extractUrls("look at this recipe", [
      { type: "text_link", offset: 12, length: 6, url: "https://example.com/tacos" },
    ]);
    expect(urls).toEqual(["https://example.com/tacos"]);
  });

  it("falls back to a regex when the update carries no entities", () => {
    expect(extractUrls("https://example.com/tacos please")).toEqual(["https://example.com/tacos"]);
    expect(extractUrls("https://example.com/tacos", [])).toEqual(["https://example.com/tacos"]);
  });

  it("drops the punctuation a human types after a link", () => {
    expect(extractUrls("here: https://example.com/tacos.")).toEqual(["https://example.com/tacos"]);
    expect(extractUrls("(https://example.com/tacos)")).toEqual(["https://example.com/tacos"]);
    expect(extractUrls("https://example.com/tacos!?")).toEqual(["https://example.com/tacos"]);
  });

  it("keeps order and de-duplicates repeats", () => {
    expect(extractUrls("https://a.example/1 https://b.example/2 https://a.example/1"))
      .toEqual(["https://a.example/1", "https://b.example/2"]);
  });

  it("finds nothing in a message with no link", () => {
    expect(extractUrls("")).toEqual([]);
    expect(extractUrls("just some words")).toEqual([]);
    expect(extractUrls("ftp://example.com/x")).toEqual([]); // not http(s)
  });

  it("ignores entity types that are not links", () => {
    expect(extractUrls("bold text", [{ type: "bold", offset: 0, length: 4 }])).toEqual([]);
  });

  it("does not produce a URL with a space in it from a malformed entity", () => {
    // Defensive: a well-formed span never spans whitespace, but a hostile or
    // buggy update must not turn into a fetch of "https://a b".
    const urls = extractUrls("https://example.com/a and more", [
      { type: "url", offset: 0, length: 29 },
    ]);
    expect(urls).toEqual(["https://example.com/a"]);
  });

  it("ignores a text_link with no url field", () => {
    expect(extractUrls("hi", [{ type: "text_link", offset: 0, length: 2 }])).toEqual([]);
  });
});

describe("parsing a slash command", () => {
  it("splits the command from its arguments", () => {
    expect(parseCommand("/find shrimp tacos")).toEqual({ command: "/find", args: "shrimp tacos" });
  });

  it("strips the @botname Telegram appends in groups", () => {
    expect(parseCommand("/find@mise_bot spicy")).toEqual({ command: "/find", args: "spicy" });
    expect(parseCommand("/list@Mise_Bot")).toEqual({ command: "/list", args: "" });
  });

  it("lower-cases the command so /Help works", () => {
    expect(parseCommand("/HELP")).toEqual({ command: "/help", args: "" });
  });

  it("normalises the whitespace inside the arguments", () => {
    expect(parseCommand("  /find   shrimp   tacos  "))
      .toEqual({ command: "/find", args: "shrimp tacos" });
  });

  it("returns null for anything that is not a command", () => {
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("https://example.com/x")).toBeNull();
    expect(parseCommand("  not /a command")).toBeNull();
  });
});

describe("log lines", () => {
  it("renders logfmt key=value pairs", () => {
    expect(logLine("import.enqueued", { job: "abc", attempts: 2, ok: true }))
      .toBe("[bot] import.enqueued job=abc attempts=2 ok=true");
  });

  it("quotes values containing spaces, quotes or equals signs", () => {
    // Without quoting, `error=could not reach` parses as three fields and the
    // message is mangled by any log collector.
    expect(logLine("import.failed", { error: "could not reach" }))
      .toBe('[bot] import.failed error="could not reach"');
    expect(logLine("x", { url: "https://a.example/?a=1" }))
      .toBe('[bot] x url="https://a.example/?a=1"');
  });

  it("omits null and undefined fields rather than printing 'undefined'", () => {
    expect(logLine("x", { a: null, b: undefined, c: 1 })).toBe("[bot] x c=1");
  });

  it("renders a bare event with no fields", () => {
    expect(logLine("starting")).toBe("[bot] starting");
  });
});

describe("keeping the bot token out of the logs", () => {
  const TOKEN = "7712345678:AAF-abcdefghijklmnopqrstuvwxyz012345";

  it("replaces the token wherever it appears", () => {
    // CWE-532, "insertion of sensitive information into a log file". The Bot
    // API puts the token in the request PATH, so a naive console.error(err) on
    // a fetch failure prints it straight into `docker logs`.
    const raw = `getUpdates failed: request to https://api.telegram.org/bot${TOKEN}/getUpdates failed`;
    const safe = redact(raw, [TOKEN]);
    expect(safe).not.toContain(TOKEN);
    expect(safe).not.toContain("AAF-abcdefghijklmnopqrstuvwxyz012345");
    expect(safe).toContain("***");
  });

  it("replaces every occurrence, not just the first", () => {
    expect(redact(`${TOKEN} and ${TOKEN}`, [TOKEN])).toBe("*** and ***");
  });

  it("survives a rendered log line end to end", () => {
    const line = logLine("telegram.error", { error: redact(`bot${TOKEN} rejected`, [TOKEN]) });
    expect(line).not.toContain(TOKEN);
  });

  it("ignores empty and implausibly short secrets", () => {
    // A 3-character "secret" would redact half of every log line into noise —
    // the guard is what keeps this safe to call on every string.
    expect(redact("a is a letter", ["a"])).toBe("a is a letter");
    expect(redact("unchanged", [""])).toBe("unchanged");
  });

  it("redacts several secrets at once", () => {
    expect(redact("token=ABCDEFGHIJ ingest=KLMNOPQRST", ["ABCDEFGHIJ", "KLMNOPQRST"]))
      .toBe("token=*** ingest=***");
  });
});

describe("the user-facing message catalogue (API_SPEC §7)", () => {
  const recipe = {
    id: "r1",
    title: "Crispy Shrimp Tacos",
    ingredients: Array.from({ length: 9 }, (_, i) => ({ item: `i${i}` })),
    steps: Array.from({ length: 9 }, (_, i) => `s${i}`),
    servings: "6-8 tacos",
  } as RecipeDTO;

  it("renders the success message the PRD's core loop promises", () => {
    // PRD §4 step 3: "✅ Crispy Shrimp Tacos — 9 ingredients, 9 steps" + link.
    const out = doneText(recipe, "https://mise.example/recipe/r1");
    expect(out).toContain("✅ <b>Crispy Shrimp Tacos</b>");
    expect(out).toContain("9 ingredients · 9 steps · 6-8 tacos");
    expect(out).toContain('<a href="https://mise.example/recipe/r1">Open in Mise</a>');
  });

  it("pluralises correctly at the boundary of one", () => {
    const single = { ...recipe, ingredients: [{ item: "x" }], steps: ["y"], servings: null } as RecipeDTO;
    expect(doneText(single, "https://x/1")).toContain("1 ingredient · 1 step");
  });

  it("renders a failure with and without the retry offer", () => {
    expect(failedText("Instagram returned no caption", true))
      .toBe("⚠️ Instagram returned no caption. Reply with the caption text and I'll try again.");
    expect(failedText("That link is not supported.", false))
      .toBe("⚠️ That link is not supported.");
  });

  it("falls back to a sentence when the error is missing", () => {
    expect(failedText(null, false)).toBe("⚠️ Import failed.");
    expect(failedText("   ", false)).toBe("⚠️ Import failed.");
  });

  it("escapes an error message that came from a model", () => {
    expect(failedText("<b>boom</b>", false)).toContain("&lt;b&gt;boom&lt;/b&gt;");
  });

  it("renders the duplicate message with and without a title", () => {
    expect(duplicateText("Tacos", "https://x/1")).toContain("📖 Already saved: <b>Tacos</b>");
    expect(duplicateText(null, "https://x/1")).toContain("📖 Already saved:");
  });

  it("renders list and find results, and their empty states", () => {
    const url = (id: string) => `https://mise.example/recipe/${id}`;
    expect(listText([recipe], url)).toContain("1. <a href=\"https://mise.example/recipe/r1\">");
    expect(listText([], url)).toContain("📭");
    expect(findText("tacos", [recipe], url)).toContain("🔍 <b>tacos</b>");
    expect(findText("<tacos>", [], url)).toContain("&lt;tacos&gt;"); // query is escaped too
  });

  it("names each import stage", () => {
    expect(progressText("fetching")).toContain("Fetching");
    expect(progressText("transcribing")).toContain("Listening");
    expect(progressText("structuring")).toContain("Writing");
    expect(progressText(null)).toBe("⏳ Importing…");
  });

  it("renders the chat id as code so it can be copied", () => {
    expect(chatIdText(1234567890)).toContain("<code>1234567890</code>");
  });

  it("builds a deep link without a double slash", () => {
    expect(recipeUrl("https://mise.example", "abc")).toBe("https://mise.example/recipe/abc");
    expect(recipeUrl("https://mise.example/", "abc")).toBe("https://mise.example/recipe/abc");
    expect(recipeUrl("https://mise.example///", "abc")).toBe("https://mise.example/recipe/abc");
  });
});
