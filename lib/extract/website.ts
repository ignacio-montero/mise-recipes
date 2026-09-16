// TIER 0 — structured data, and the generic-website text fallback.
//
// Most recipe sites publish schema.org/Recipe as JSON-LD in a
// `<script type="application/ld+json">` tag: title, image, recipeIngredient[],
// recipeInstructions[], ISO-8601 durations. Parsing that is deterministic,
// instant, free, and CANNOT hallucinate. Sending the page to a model instead
// would be slower, costlier and less accurate — PRD S4 makes "zero LLM calls
// for a JSON-LD page" an acceptance criterion, not a nice-to-have.
//
// This file also owns the shared HTML plumbing (fetch-with-guard, entity
// decoding, tag stripping) because it is the module whose whole job is HTML;
// instagram.ts and tiktok.ts import it rather than each growing their own
// half-correct copy.
//
// No cheerio/jsdom: a DOM parser is ~2 MB of dependency to run a handful of
// regexes over markup we only ever read, never traverse. The tradeoff is that
// the readable-text fallback is approximate — which is fine, because its output
// goes to a model that tolerates noise.

import type { Gathered, Ingredient, ParsedRecipe } from "../types";
import { assertPublicUrl, ExtractionError } from "./classify";
import { normaliseText } from "./heuristics";

const MAX_HTML_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

export const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

export type FetchedPage = { html: string; finalUrl: string };
export type FetchedBytes = { bytes: Uint8Array; finalUrl: string; contentType: string };

export type FetchOptions = {
  userAgent?: string;
  accept?: string;
  maxBytes?: number;
  timeoutMs?: number;
  /** What the body must be. Guards against a "recipe URL" that 302s to a
   *  38 MB JPEG — recipetineats.com really does this to unknown clients. */
  expect?: "html" | "json" | "image" | "any";
};

/**
 * Fetch text with an SSRF guard on EVERY hop.
 *
 * `redirect: "manual"` is the point of this function. With the default
 * ("follow") we would validate `https://evil.example` as public and then let
 * the runtime quietly follow its 302 to `http://127.0.0.1:8080/` — the guard
 * would have checked the one URL that was never actually fetched.
 */
export async function fetchBytes(url: string, opts: FetchOptions = {}): Promise<FetchedBytes> {
  const maxBytes = opts.maxBytes ?? MAX_HTML_BYTES;
  let target = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const safe = await assertPublicUrl(target);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(safe, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          "user-agent": opts.userAgent ?? DESKTOP_UA,
          accept: opts.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-GB,en;q=0.9",
        },
      });
    } catch (e) {
      const aborted = e instanceof Error && e.name === "AbortError";
      throw new ExtractionError(
        aborted ? "The page took too long to respond." : "Could not reach that page.",
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new ExtractionError("That page redirected nowhere.");
      target = new URL(loc, safe).toString();
      continue;
    }
    if (!res.ok) throw new ExtractionError(`That page answered ${res.status}.`);

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    assertContentType(contentType, opts.expect ?? "html");
    return { bytes: await readCapped(res, maxBytes), finalUrl: safe.toString(), contentType };
  }
  throw new ExtractionError("That page redirected too many times.");
}

/** Text flavour of the same call. Everything HTML-shaped uses this. */
export async function fetchText(url: string, opts: FetchOptions = {}): Promise<FetchedPage> {
  const { bytes, finalUrl } = await fetchBytes(url, opts);
  return { html: new TextDecoder("utf-8").decode(bytes), finalUrl };
}

function assertContentType(ct: string, expect: NonNullable<FetchOptions["expect"]>): void {
  if (expect === "any" || ct === "") return; // no header is not evidence of the wrong type
  const ok =
    expect === "json" ? ct.includes("json")
    : expect === "image" ? ct.startsWith("image/")
    : ct.includes("html") || ct.includes("xml") || ct.startsWith("text/plain");
  if (!ok) {
    throw new ExtractionError(`That link is a ${ct.split(";")[0]}, not what we asked for.`, false);
  }
}

/** Read at most `maxBytes`. `res.text()` would happily buffer a 2 GB "page"
 *  into a 640 MB container; truncating loses nothing we needed. */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const body = res.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return concat(chunks, Math.min(total, maxBytes));
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, size - at);
    if (take <= 0) break;
    out.set(c.subarray(0, take), at);
    at += take;
  }
  return out;
}

// ── HTML utilities ───────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", eacute: "é", egrave: "è",
  agrave: "à", ccedil: "ç", ouml: "ö", uuml: "ü", auml: "ä", deg: "°", frac12: "½",
  frac14: "¼", frac34: "¾", middot: "·", bull: "•", copy: "©", reg: "®", trade: "™", times: "×",
};

/** Instagram encodes "@" as `&#064;` in embed markup, so numeric entities are
 *  not an edge case here — they are the common case. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return "";
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

const BLOCK_CLOSERS = /<\/(?:p|div|li|tr|h[1-6]|section|article|ul|ol|blockquote)\s*>/gi;

/** Elements whose CONTENT is not readable text and must be dropped wholesale. */
const DROPPED_TAGS = [
  "script", "style", "noscript", "svg", "iframe",
  "template", "form", "nav", "footer", "header", "aside",
];
const DROPPED_OPEN = new RegExp(`<(${DROPPED_TAGS.join("|")})\\b[^>]*>`, "gi");

/**
 * Only this much markup is ever scanned for readable text.
 *
 * The caller already truncates the extracted text to 20 000 chars, so scanning
 * a 3 MB page did ~93% of its work purely to throw the result away. Capping the
 * INPUT is also the cheap half of the ReDoS defence below.
 */
const MAX_TEXT_SCAN_BYTES = 300_000;

/**
 * Drop `<script>…</script>` and friends WITHOUT a backreference.
 *
 * ⚠️ The obvious regex — `/<(script|style|…)\b[^>]*>[\s\S]*?<\/\1\s*>/gi` — is a
 * **ReDoS**. The lazy `[\s\S]*?` combined with the `\1` backreference means every
 * UNCLOSED opening tag rescans to end-of-string hunting for its closer, which is
 * O(n²). Measured on a 3 MB input (the old ceiling): 8.4 s for 20k tags, **79 s**
 * for 375k unclosed `<script>`, **116 s** for unclosed `<aside>` — on a fast Mac.
 * The N95 is several times slower.
 *
 * That is not a slow function, it is an OUTAGE. `String.replace` is synchronous
 * on the only thread, so while it runs no request is served, `/api/health` cannot
 * answer (so the container is marked unhealthy), and the pipeline's own
 * AbortController timeouts cannot fire — timers need a free event loop.
 *
 * This version is a single linear scan: find each opening tag, then `indexOf` its
 * closer. No backtracking is possible. An unclosed tag drops the remainder of the
 * document, which is the right call for markup that is already broken.
 */
export function dropNonTextElements(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let cursor = 0;
  DROPPED_OPEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DROPPED_OPEN.exec(html)) !== null) {
    if (m.index < cursor) continue; // inside a region already dropped
    const tag = m[1].toLowerCase();
    const close = lower.indexOf(`</${tag}`, m.index + m[0].length);
    out += html.slice(cursor, m.index) + " ";
    if (close === -1) {
      cursor = html.length; // unclosed: treat the rest as inside it
      break;
    }
    const end = html.indexOf(">", close);
    cursor = end === -1 ? html.length : end + 1;
    DROPPED_OPEN.lastIndex = cursor;
  }
  return out + html.slice(cursor);
}

/** Markup → the text a human would read. Approximate by design (see header). */
export function htmlToText(html: string): string {
  const capped = html.length > MAX_TEXT_SCAN_BYTES ? html.slice(0, MAX_TEXT_SCAN_BYTES) : html;
  const text = dropNonTextElements(capped)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(BLOCK_CLOSERS, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ");
  return normaliseText(decodeEntities(text).replace(/[ \t]{2,}/g, " "));
}

function metaContent(html: string, prop: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)\\s*=\\s*["']${prop}["'][^>]*>`,
    "i",
  );
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  const content = tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
  return content ? decodeEntities(content).trim() : null;
}

function pageTitle(html: string): string | null {
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return t ? decodeEntities(t).replace(/\s+/g, " ").trim() : null;
}

// ── JSON-LD ──────────────────────────────────────────────────────────────────

type JsonValue = unknown;
type JsonObject = Record<string, JsonValue>;

function isObject(v: JsonValue): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every JSON-LD node on the page, flattened. Sites nest the Recipe inside
 *  `@graph` (Yoast does this on every WordPress food blog), inside arrays, or
 *  inside `mainEntity` — so we walk the lot rather than guess a shape. */
export function jsonLdNodes(html: string): JsonObject[] {
  const out: JsonObject[] = [];
  // The attribute value may be unquoted — `<script type=application/ld+json>`
  // is what Yoast emits on every WordPress food blog, and requiring quotes here
  // silently cost us Tier 0 on those sites.
  const re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const raw = m[1].replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "").trim();
    if (!raw) continue;
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // one malformed block must not lose the others
    }
    collect(parsed, out, 0);
  }
  return out;
}

function collect(v: JsonValue, out: JsonObject[], depth: number): void {
  if (depth > 8) return;
  if (Array.isArray(v)) {
    for (const item of v) collect(item, out, depth + 1);
    return;
  }
  if (!isObject(v)) return;
  out.push(v);
  for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "hasPart"]) {
    if (key in v) collect(v[key], out, depth + 1);
  }
}

/** `@type` is a string on some sites and an array on others; both are legal. */
function hasType(node: JsonObject, type: string): boolean {
  const t = node["@type"] ?? node.type;
  if (typeof t === "string") return t.toLowerCase() === type.toLowerCase();
  if (Array.isArray(t)) return t.some((x) => typeof x === "string" && x.toLowerCase() === type.toLowerCase());
  return false;
}

/** Unwrap the handful of ways schema.org lets a "string" not be a string. */
function asText(v: JsonValue): string | null {
  if (typeof v === "string") return decodeEntities(stripTags(v)).trim() || null;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    const parts = v.map(asText).filter((s): s is string => !!s);
    return parts.length ? parts.join(", ") : null;
  }
  if (isObject(v)) return asText(v["@value"] ?? v.name ?? v.text ?? v.url ?? null);
  return null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

/** "PT1H30M" → 90. Also survives "P0DT0H45M" and the bare "PT45M". */
export function parseIsoDuration(v: JsonValue): number | null {
  const s = typeof v === "string" ? v : typeof v === "number" ? `PT${v}M` : asText(v);
  if (!s) return null;
  const m = s.trim().match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!m) return null;
  const [, d, h, min, sec] = m;
  const total =
    (Number(d ?? 0) * 1440) + (Number(h ?? 0) * 60) + Number(min ?? 0) + (Number(sec ?? 0) / 60);
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.round(total);
}

/** `image` may be a URL, an array of URLs, an ImageObject, or an array of them. */
export function pickImageUrl(v: JsonValue): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (Array.isArray(v)) {
    for (const item of v) {
      const u = pickImageUrl(item);
      if (u) return u;
    }
    return null;
  }
  if (isObject(v)) return pickImageUrl(v.url ?? v.contentUrl ?? v["@id"] ?? null);
  return null;
}

/**
 * `recipeInstructions` is the messiest field in the whole spec. Seen in the
 * wild: one big string with newlines; an array of strings; an array of
 * HowToStep objects; and HowToSection objects whose real steps hide in a
 * nested `itemListElement`. All four appear below.
 */
export function parseInstructions(v: JsonValue, depth = 0): string[] {
  if (depth > 4) return [];
  if (typeof v === "string") {
    const text = decodeEntities(v.replace(/<\/(?:li|p|br)\s*>/gi, "\n").replace(/<br\s*\/?>/gi, "\n"));
    return stripTags(text)
      .split(/\n+/)
      .map((s) => s.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim())
      .filter((s) => s.length > 2);
  }
  if (Array.isArray(v)) return v.flatMap((item) => parseInstructions(item, depth + 1));
  if (isObject(v)) {
    if (hasType(v, "HowToSection") || v.itemListElement) {
      return parseInstructions(v.itemListElement ?? null, depth + 1);
    }
    const text = asText(v.text ?? v.name ?? v.description ?? null);
    return text ? [text] : [];
  }
  return [];
}

const UNITS = [
  "g", "gram", "grams", "kg", "kilogram", "kilograms", "ml", "l", "litre", "litres", "liter", "liters",
  "oz", "ounce", "ounces", "lb", "lbs", "pound", "pounds", "cup", "cups", "tsp", "tsps", "teaspoon",
  "teaspoons", "tbsp", "tbsps", "tablespoon", "tablespoons", "clove", "cloves", "pinch", "pinches",
  "handful", "handfuls", "slice", "slices", "stick", "sticks", "can", "cans", "tin", "tins", "pint",
  "pints", "quart", "quarts", "gallon", "sprig", "sprigs", "bunch", "bunches", "dash", "packet",
  "packets", "package", "packages", "pkg", "jar", "jars", "bottle", "bottles", "piece", "pieces",
  "sheet", "sheets", "scoop", "scoops", "head", "heads", "stalk", "stalks", "knob", "knobs",
];
const UNIT_SET = new Set(UNITS);

const QUANTITY_HEAD =
  /^\s*(?:[-*•–—]\s*)?((?:\d+\s+\d+\s*\/\s*\d+)|(?:\d+\s*\/\s*\d+)|(?:\d+(?:[.,]\d+)?\s*(?:-|–|to)\s*\d+(?:[.,]\d+)?)|(?:\d+(?:[.,]\d+)?)|[½⅓⅔¼¾⅛⅜⅝⅞])\s*([½⅓⅔¼¾⅛⅜⅝⅞])?\s*/;

/**
 * "1 lb of shrimp, diced small" → { quantity: "1", unit: "lb", item: "shrimp",
 * note: "diced small" }.
 *
 * Only Tier 0 needs this — Gemini returns the fields already split. It is
 * deliberately conservative: anything it cannot confidently split stays whole
 * in `item`, because a wrong `quantity` silently corrupts the servings scaler,
 * whereas an unsplit line merely looks slightly untidy.
 */
export function parseIngredientLine(raw: string): Ingredient | null {
  const line = decodeEntities(stripTags(raw)).replace(/\s+/g, " ").trim();
  if (!line) return null;

  let rest = line;
  let quantity: string | undefined;
  const q = rest.match(QUANTITY_HEAD);
  if (q) {
    quantity = [q[1], q[2]].filter(Boolean).join(" ").replace(/\s*\/\s*/g, "/").replace(/\s*(?:-|–|to)\s*/, "-");
    rest = rest.slice(q[0].length);
  }

  let unit: string | undefined;
  const firstWord = rest.match(/^([A-Za-z.]+)\b\.?\s*/);
  if (firstWord) {
    const candidate = firstWord[1].replace(/\.$/, "").toLowerCase();
    if (UNIT_SET.has(candidate)) {
      unit = candidate;
      rest = rest.slice(firstWord[0].length).replace(/^of\s+/i, "");
    }
  }

  // A trailing "…, finely chopped" or "(optional)" is preparation, not identity.
  let note: string | undefined;
  const paren = rest.match(/\(([^)]*)\)\s*$/);
  if (paren) {
    note = paren[1].trim();
    rest = rest.slice(0, paren.index).trim();
  }
  const comma = rest.match(/^(.*?),\s*(.+)$/);
  if (comma && comma[2].length <= 60) {
    rest = comma[1].trim();
    note = note ? `${comma[2].trim()}, ${note}` : comma[2].trim();
  }

  const item = rest.replace(/^of\s+/i, "").trim();
  if (!item) return null;
  return {
    ...(quantity ? { quantity } : {}),
    ...(unit ? { unit } : {}),
    item,
    ...(note ? { note } : {}),
  };
}

function parseIngredients(v: JsonValue): Ingredient[] {
  const lines = Array.isArray(v)
    ? v.map(asText)
    : typeof v === "string"
      ? v.split(/\n+/)
      : [];
  return lines
    .filter((l): l is string => typeof l === "string" && l.trim() !== "")
    .map(parseIngredientLine)
    .filter((i): i is Ingredient => i !== null);
}

function parseTags(node: JsonObject): string[] {
  const raw = [node.recipeCategory, node.recipeCuisine, node.keywords]
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .map(asText)
    .filter((s): s is string => !!s)
    .flatMap((s) => s.split(","))
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 1 && s.length < 30);
  return Array.from(new Set(raw)).slice(0, 8);
}

export type JsonLdRecipe = {
  parsed: ParsedRecipe;
  imageUrl: string | null;
  author: string | null;
};

/** Tier 0 proper: page HTML → a complete recipe, or null if the page has no
 *  usable schema.org/Recipe. Null means "fall through to the text tiers". */
export function parseJsonLdRecipe(html: string): JsonLdRecipe | null {
  const node = jsonLdNodes(html).find((n) => hasType(n, "Recipe"));
  if (!node) return null;

  const title = asText(node.name ?? node.headline ?? null);
  const ingredients = parseIngredients(node.recipeIngredient ?? node.ingredients ?? null);
  const steps = parseInstructions(node.recipeInstructions ?? null);

  // A "Recipe" with no ingredients and no steps is a listicle wearing the
  // wrong @type. Better to fall through to the model than save an empty shell.
  if (!title || (ingredients.length === 0 && steps.length === 0)) return null;

  const totalMinutes =
    parseIsoDuration(node.totalTime) ??
    sumOrNull(parseIsoDuration(node.prepTime), parseIsoDuration(node.cookTime));

  return {
    parsed: {
      isRecipe: true,
      // Not 1.0: the mapping is exact, but plenty of sites publish JSON-LD that
      // disagrees with their own page. This is "trust, but recorded".
      confidence: 0.95,
      title,
      description: asText(node.description ?? null),
      servings: asText(node.recipeYield ?? node.yield ?? null),
      totalMinutes,
      ingredients,
      steps,
      tags: parseTags(node),
      notes: null,
    },
    imageUrl: pickImageUrl(node.image ?? null),
    author: asText(node.author ?? null),
  };
}

function sumOrNull(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

// ── Gather ───────────────────────────────────────────────────────────────────

export async function gatherWebsite(canonicalUrl: string): Promise<Partial<Gathered>> {
  const { html, finalUrl } = await fetchText(canonicalUrl);

  const tier0 = parseJsonLdRecipe(html);
  if (tier0) {
    return {
      tiers: ["tier0:json-ld"],
      structured: tier0.parsed,
      author: tier0.author,
      thumbnailUrl: tier0.imageUrl ?? metaContent(html, "og:image"),
      canonicalUrl: finalUrl,
      // rawText still gets the structured payload so a retry can re-run the
      // mapping (or hand it to the model) without re-fetching the site.
      text: JSON.stringify(tier0.parsed, null, 2),
    };
  }

  // No JSON-LD: hand the readable text to the model instead. Truncated because
  // a food blog is 80% life story and the recipe is near the end — 20k chars
  // covers both without paying for the comment section.
  const body = htmlToText(html).slice(0, 20_000);
  const heading = [pageTitle(html), metaContent(html, "og:description")].filter(Boolean).join("\n");
  const text = normaliseText(`${heading}\n\n${body}`);

  if (text.length < 80) {
    throw new ExtractionError("That page had no readable text — it may need JavaScript to load.");
  }
  return {
    tiers: ["tier1:web-text"],
    text,
    author: metaContent(html, "og:site_name"),
    thumbnailUrl: metaContent(html, "og:image"),
    canonicalUrl: finalUrl,
    structured: null,
  };
}
