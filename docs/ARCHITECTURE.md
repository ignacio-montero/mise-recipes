# ARCHITECTURE — Mise

## 1. Shape

```
  iPhone share sheet
        │  (Instagram / TikTok "Share → Telegram")
        ▼
   Telegram servers ──long-poll(getUpdates)──▶  ┌──────────────┐
                                                │   mise-bot   │  no ports, outbound only
                                                └──────┬───────┘
                                    POST /api/imports  │  x-mise-token
                                    (Docker network)   ▼
   iPhone Safari (PWA) ──HTTPS(tailnet)──▶  ┌────────────────────────────┐
                                            │          mise-web          │
                                            │  Next.js 15 (App Router)   │
                                            │  ├─ API routes             │
                                            │  ├─ PWA UI                 │
                                            │  └─ import worker (in-proc)│
                                            └───────┬────────────────────┘
                                                    │
                          ┌─────────────────────────┼──────────────────────┐
                          ▼                         ▼                      ▼
                   SQLite (volume)          yt-dlp + ffmpeg         Gemini API
                   recipes, jobs,           (subprocess)            (structuring)
                   folders, grocery
```

Two containers. `mise-web` owns all state and all logic; `mise-bot` is a dumb
transport that turns Telegram messages into HTTP calls and reports back.

> **Concept spotlight — why the bot is "dumb".** Putting the extraction pipeline
> behind an HTTP API rather than inside the bot means there is exactly **one**
> implementation of "import this URL", used by both the bot and the web app's
> paste box. The alternative — bot does its own extraction — duplicates the
> hardest code in the project and guarantees the two paths drift. This is the
> **anti-corruption / single-entry-point** instinct: many front doors, one engine
> room.

## 2. Stack, and what was discarded

| Layer | Choice | Why | Discarded alternative |
|---|---|---|---|
| App | **Next.js 15 (App Router) + TypeScript** | Blue Plaque Hunter already runs this exact stack on this exact box; the Dockerfile, standalone-output trick and PWA manifest pattern are all proven here. Zero new operational surface. | **Python + FastAPI + HTMX** — closer to Tennis-Bot, and yt-dlp is Python-native so it would be an import not a subprocess. Rejected: this Mac currently has **no usable Python** (only the unlicensed Xcode stub), so local dev and tests would have to run in Docker for everything, not just the yt-dlp step. |
| DB | **SQLite + Prisma** | Single user, single writer, a few thousand rows at most. Backup = copy one file. Same as Blue Plaques. | **Postgres** — real migrations and concurrency, but it is a second always-on container and ~150 MB of RAM on an 8 GB box to serve one person. |
| Styling | **Plain CSS** in `app/globals.css` | Matches Blue Plaques; the whole UI is ~6 screens. | **Tailwind** — faster to write, but adds a build dependency for a UI this small. |
| LLM | **Gemini** (`gemini-2.5-flash` and up) | Already the house provider (Media Tracker). Generous free tier, native JSON-schema output, and it accepts **audio** natively, which removes the need to run Whisper on a GPU-less N95. | **Local Whisper + a rules parser** — free and private, but ASR on an N95 is minutes per reel, and a rules parser cannot handle "measure with your heart". |
| Queue | **SQLite-backed job table, in-process worker** | ~80 lines, no new container, no Redis. Survives restarts because the queue *is* the database. | **BullMQ + Redis** — correct at scale, absurd for ~5 imports a day. **Synchronous import** — simplest, but a 25 s HTTP request that the PWA holds open is bad UX and fragile. |

> **Concept spotlight — database-backed job queue.** The `ImportJob` table *is*
> the queue. Enqueue = `INSERT ... status='pending'`. The worker loop does
> `SELECT ... WHERE status='pending' ORDER BY createdAt LIMIT 1`, flips it to
> `running`, does the work, writes `done`/`failed`. Because the queue lives in
> the same transactional store as the results, a crash mid-import leaves a row
> in `running` that a startup sweep can requeue — no job is silently lost. This
> is the same idea as the **transactional outbox** pattern you will meet in
> bigger systems.

### Why the worker runs *inside* `mise-web`

Next.js `instrumentation.ts` `register()` runs once per server process. In
`output: "standalone"` mode that is a single long-lived Node process, so one
worker loop starts and one SQLite writer exists. A separate `mise-worker`
container was considered and rejected: it would make **two** processes write the
same SQLite file across containers, which works under WAL but introduces
`SQLITE_BUSY` handling for no benefit at this scale, and costs a third
`mem_limit` slice on a box already committing ~4.8 GB.

## 3. The extraction pipeline

The heart of the app. Tiered, cheapest and most deterministic first.

```
URL
 │
 ├─ classify → tiktok | instagram | youtube | web | unknown
 │
 ├─ TIER 0  structured data (web only)          ← no LLM, no cost, exact
 │     fetch HTML → JSON-LD  @type: Recipe  → map straight to our schema. DONE.
 │
 ├─ TIER 1  caption / metadata                  ← no LLM yet, just text gathering
 │     tiktok    → oEmbed .title           (fallback: yt-dlp --dump-json)
 │     instagram → /embed/captioned scrape (fallback: yt-dlp --dump-json)
 │     youtube   → yt-dlp --dump-json .description
 │     web       → readable text from the HTML
 │
 ├─ TIER 2  audio  (only if Tier 1 text looks thin — see `looksLikeRecipe()`)
 │     yt-dlp -x --audio-format mp3 (capped duration) → Gemini audio → transcript
 │
 └─ TIER 3  structuring
       all gathered text → Gemini with a strict responseSchema → Recipe JSON
```

**Tier 0 is the one to be proud of.** Most recipe websites publish
`schema.org/Recipe` as JSON-LD in a `<script type="application/ld+json">` tag —
title, image, `recipeIngredient[]`, `recipeInstructions[]`, `totalTime` as an
ISO-8601 duration. Parsing it is deterministic, instant, free, and cannot
hallucinate. Reaching for an LLM first would be slower, costlier and *less*
accurate. **Never use a model where the data is already structured.**

`looksLikeRecipe(text)` is the gate between tiers: it scores text on
ingredient-ish lines (leading quantities, units), imperative cooking verbs, and
length. Cheap heuristic, fully unit-tested, and it is what stops every import
from paying the audio-download tax.

### Provenance

Every recipe stores `extraction: { tiers: string[], model: string|null,
confidence: number, rawText: string }`. When a recipe looks wrong you can see
whether it came from clean JSON-LD or a guess off a noisy transcript — and
`rawText` makes a re-run free without re-hitting the platform.

## 4. Data model

```
Recipe ──< FolderRecipe >── Folder
Recipe ──< GroceryItem (optional link)
ImportJob ──? Recipe
```

`ingredients` and `steps` are **JSON columns**, not child tables.

> **Concept spotlight — when to denormalise.** A relational `Ingredient` table
> would be correct if ingredients had independent identity or were queried on
> their own ("every recipe containing miso"). They are not: they are always read
> and written as a whole with their parent recipe, and order matters. A JSON
> column keeps that a single row read. The cost is that search over ingredients
> is a `LIKE` over serialised JSON — acceptable at a few thousand recipes, and
> the thing to revisit first if search gets slow.

Full field list: `prisma/schema.prisma`.

## 5. Security posture

- Tailnet-only binding (`100.74.128.98`), never `0.0.0.0` — Docker bypasses UFW.
- No auth on the web app (single implicit user behind Tailscale), exactly as
  Blue Plaque Hunter.
- `POST /api/imports` requires `x-mise-token` — defence in depth so the bot is
  the only thing that can enqueue from off-page, and a stray request on the
  Docker network cannot.
- The Telegram bot honours **only** `TELEGRAM_CHAT_ID`; every other chat is
  ignored. Same rule as `tennisbot-prefs`.
- **URLs from Telegram are untrusted input.** They are validated against an
  allowlist of hosts before ever reaching `yt-dlp`, and passed as an `execFile`
  argument array — never interpolated into a shell string. A URL is attacker-
  controlled data; a shell string is code.
- `GEMINI_API_KEY` and `TELEGRAM_BOT_TOKEN` live only in the server's untracked
  `.env`.

## 6. Resource budget (8 GB ceiling)

| Container | `mem_limit` | Notes |
|---|---|---|
| `mise-web` | 640 MB | Next.js standalone (~150 MB idle) + short yt-dlp/ffmpeg spikes. |
| `mise-bot` | 128 MB | A `fetch` long-poll loop. Nothing else. |

~768 MB added to the ~4.8 GB already committed. Disk: hero images only
(~200 KB each); audio/video temp files are deleted in a `finally` and the temp
dir is swept on boot.
