# API_SPEC — Mise

The contract between `mise-web`'s frontend, its API routes, and `mise-bot`.
**This is the settled contract**: backend and frontend were built in parallel
against it. Change it here first, then on both sides.

Base: `/api`. All bodies JSON. Times ISO-8601 UTC. Ids are `cuid()`.

## 0. Shared types (`components/types.ts` + `lib/types.ts` must agree)

```ts
type Ingredient = {
  quantity?: string;   // "1", "1/2", "1 1/2", "2-3" — kept as TEXT, never a float
  unit?: string;       // "lb", "tbsp", "cup"
  item: string;        // "shrimp"                      (required)
  note?: string;       // "diced into small pieces"
};

type Platform = 'instagram' | 'tiktok' | 'youtube' | 'web' | 'manual';

type Extraction = {
  tiers: string[];          // e.g. ["tier1:instagram-embed","tier3:gemini"]
  model: string | null;     // "gemini-2.5-flash" | null when no LLM was used
  confidence: number;       // 0..1
  rawText: string;          // everything gathered, for retry/debug
};

type Recipe = {
  id: string;
  title: string;
  description: string | null;
  sourceUrl: string | null;
  sourcePlatform: Platform;
  sourceAuthor: string | null;
  heroImagePath: string | null;   // "/api/images/<file>" — a URL, NOT a disk path
  servings: string | null;        // "6-8 tacos"
  servingsCount: number | null;   // 6  — parsed, drives the scaler; null if unparseable
  totalMinutes: number | null;
  ingredients: Ingredient[];
  steps: string[];
  notes: string | null;
  tags: string[];
  folderIds: string[];
  favorite: boolean;
  cookedCount: number;
  lastCookedAt: string | null;
  extraction: Extraction | null;
  createdAt: string;
  updatedAt: string;
};
```

> **`quantity` is a string, deliberately.** Real captions say `1/2`, `1 1/2`,
> `2-3`, "a splash". Parsing those to a float at ingest loses information and
> rounds badly when scaled. The scaler parses on demand and falls back to
> leaving the text alone. See `lib/scale.ts`.

## 1. Errors

Every non-2xx returns:

```json
{ "error": { "code": "not_found", "message": "No recipe with that id." } }
```

Codes: `bad_request`, `unauthorized`, `not_found`, `conflict`,
`unsupported_source`, `extraction_failed`, `not_a_recipe`, `rate_limited`,
`internal`.

## 2. Imports

### `POST /api/imports`
Enqueue an import. **Returns immediately — this does not wait for extraction.**

Header `x-mise-token: <OSTA_INGEST_TOKEN>` is **required when `source` is
`telegram`**, optional for `web` (same-origin).

```jsonc
// request
{ "url": "https://www.instagram.com/reel/C9dO9AevUQx/",
  "source": "telegram" | "web",
  "chatId": "6519408112",   // telegram only — where to report back
  "messageId": 4471,        // telegram only — the message to EDIT with the result
  "text": "…pasted caption…" // optional: skip fetching, structure this text
}
```

`202 Accepted`
```json
{ "id": "clx…", "status": "pending" }
```

`409 conflict` when that `sourceUrl` already has a recipe:
```json
{ "error": { "code": "conflict", "message": "Already saved." },
  "recipeId": "clx…" }
```

### `GET /api/imports/:id`
Poll for progress. The PWA polls this every 1.5 s while a job is open.

```json
{ "id": "clx…",
  "status": "pending" | "running" | "done" | "failed" | "not_recipe",
  "stage": "fetching" | "transcribing" | "structuring" | null,
  "url": "https://…",
  "recipeId": "clx…" | null,
  "recipe": { /* full Recipe, only when status === "done" */ } ,
  "error": "Instagram returned no caption." | null,
  "canRetryWithText": true,
  "createdAt": "…", "updatedAt": "…" }
```

### `GET /api/imports?status=&limit=20`
Recent jobs, newest first. Powers the "Recent imports" strip on `/add`.

## 3. Recipes

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/recipes?q=&folder=&tag=&favorite=&sort=&limit=&cursor=` | `q` matches title, description, ingredient `item`, tags (case-insensitive). `sort` = `recent` (default) \| `title` \| `cooked`. Returns `{ recipes: Recipe[], nextCursor: string \| null }`. |
| `GET` | `/api/recipes/:id` | `{ recipe }`. 404 → `not_found`. |
| `PATCH` | `/api/recipes/:id` | Partial. Accepts `title, description, servings, servingsCount, totalMinutes, ingredients, steps, notes, tags, favorite, heroImagePath`. Rejects unknown keys with `bad_request`. Returns `{ recipe }`. |
| `DELETE` | `/api/recipes/:id` | `204`. Cascades folder links; grocery items are kept but unlinked. |
| `POST` | `/api/recipes/:id/cooked` | Increments `cookedCount`, stamps `lastCookedAt`. Returns `{ recipe }`. |
| `PUT` | `/api/recipes/:id/folders` | Body `{ folderIds: string[] }` — replaces the set. Returns `{ recipe }`. |
| `POST` | `/api/recipes` | Manual create. Body = any subset of the writable fields plus required `title`. `sourcePlatform` forced to `manual`. |

## 4. Folders

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/folders` | `{ folders: [{ id, name, emoji, recipeCount }] }` |
| `POST` | `/api/folders` | `{ name, emoji? }` → `201 { folder }`. Duplicate name → `409 conflict`. |
| `PATCH` | `/api/folders/:id` | `{ name?, emoji? }` |
| `DELETE` | `/api/folders/:id` | `204`. Deletes links, never recipes. |

## 5. Grocery list

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/grocery` | `{ items: [{ id, text, checked, recipeId, recipeTitle, createdAt }] }`, unchecked first. |
| `POST` | `/api/grocery` | `{ text }` → `201 { item }` |
| `POST` | `/api/grocery/from-recipe/:id` | Body `{ scale?: number }`. Appends every ingredient as an item, formatted `"1 lb shrimp"`, scaled if `scale` given. Returns `{ added: number, items }`. **Merges duplicates** by normalised `item` text rather than adding a second line. |
| `PATCH` | `/api/grocery/:id` | `{ text?, checked? }` |
| `DELETE` | `/api/grocery/:id` | `204` |
| `DELETE` | `/api/grocery?checked=true` | Clears all checked items. `{ deleted: n }` |

## 6. Misc

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/images/:file` | Serves a stored hero image from the volume. Next only serves static from `/public`, so images go through a route — same trick as Blue Plaques' `/api/uploads/[file]`. |
| `GET` | `/api/health` | `{ ok: true, db: true, worker: { alive, lastTickAt, pending } }`. Used by the compose healthcheck. |

## 7. Telegram command surface (`mise-bot`)

Only messages from `TELEGRAM_CHAT_ID` are processed; everything else is dropped
silently. **Only one process may long-poll a bot token** (a second gets HTTP 409)
— see `docs/DECISIONS.md` D-003.

| Input | Behaviour |
|---|---|
| any message containing a URL | Reply `⏳ Importing…`, `POST /api/imports`, poll, then **edit that same message** to the outcome. |
| `/start`, `/help` | Short usage text. |
| `/list` | Last 5 recipes with links. |
| `/find <query>` | Top 5 matches. |
| a plain-text **reply** to a failed import message | Re-runs structuring with that text as the source (the manual-caption fallback, PRD F4). |
| `/id` | Replies with the chat id (setup aid). |

Outcome messages:
- `✅ *Crispy Shrimp Tacos*\n9 ingredients · 9 steps · 6-8 tacos\n<open link>`
- `🤔 That didn't look like a recipe. Reply with the caption text and I'll try again.`
- `⚠️ Instagram returned no caption. Reply with the caption text and I'll try again.`
- `📖 Already saved: *Crispy Shrimp Tacos* <link>`
