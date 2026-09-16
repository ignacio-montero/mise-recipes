# Mise

Save a recipe from an **Instagram Reel or TikTok** by sharing it, and get a clean,
searchable, cookable recipe seconds later. Self-hosted, single user, no
subscription, no ads.

> **Status:** v0.1.2, running daily on a private home server. Core loop verified
> end to end on real posts. 430 tests, `tsc` clean. See
> [`docs/NEXT_STEPS.md`](docs/NEXT_STEPS.md).

A replica of the iOS app **Osta**, built to understand how that category of app
actually works — and because the data is worth owning.

---

## The problem

Recipes arrive as short video. Instagram's own *Saved* collection is a wall of
muted thumbnails: you cannot search it, you cannot read the ingredients without
scrubbing a 40-second video, and you certainly cannot cook from it with wet
hands. The recipe is usually sitting right there in the caption as plain text —
it is just trapped inside a video player.

## The core loop

```
Instagram/TikTok  →  Share → Telegram → bot
      →  caption scraped  →  structured into a recipe  →  saved
      →  open on the phone: search, scale servings, cook
```

The bot replies `⏳ Importing…` immediately and then **edits that same message**
with the result, so saving ten reels leaves ten messages, not thirty.

> **Why a Telegram bot and not a share-target web app?** iOS Safari does not
> implement the Web Share Target API, so an installed PWA can never appear in the
> native iOS share sheet. Telegram already does. The bot is a workaround for a
> platform limitation, not a feature — see
> [`docs/DECISIONS.md`](docs/DECISIONS.md) D-002.

## Extraction: four tiers, cheapest first

```
Tier 0   schema.org/Recipe JSON-LD     exact, instant, free — NO model call
Tier 1   caption / post metadata       one HTTP request
Tier 2   audio → transcription         only when the caption is thin
Tier 3   LLM structuring               messy text → a strict schema
```

**Tier 0 is the one worth reading.** Most recipe *websites* already publish their
recipe as machine-readable JSON-LD, because search engines reward it. So for a
website import this "AI recipe extractor" does something better than AI: it reads
the answer the site already published. That is faster, free, and cannot
hallucinate. The test that proves it deletes the API key and imports anyway.

*Never use a model where the data is already structured.*

`looksLikeRecipe()` is the gate between tiers — a cheap, pure, unit-tested scorer
that decides whether a caption is already a recipe. It is what stops every import
paying the audio-download tax.

## Features

- Import from **Instagram Reels, TikTok, YouTube and recipe websites**
- **Telegram ingest bot** — share from the phone's native share sheet
- **Manual-caption fallback** — reply to a failed import with pasted text
- **Cook view** — servings scaler, tap-to-tick ingredients and steps, screen stays awake
- **Folders**, free-text search, favourites, cooked count
- **Grocery list** built from a recipe at whatever scale you are viewing, merging duplicates
- **Installable PWA** — adds to the iOS Home Screen, works standalone
- **Provenance on every recipe** — which tiers ran, which model, what raw text

## Decisions worth reading

Full log in [`docs/DECISIONS.md`](docs/DECISIONS.md). The ones that shaped the build:

- **Quantities are stored as text, not numbers.** Real captions say `2-3 cloves`
  and *"measure with your heart"*. A `Float` column asserts every quantity is a
  number; when that is false the type system enforces a fiction. The scaler
  rescales what it can parse confidently and leaves the rest exactly as written —
  a wrong quantity in a recipe is worse than an unscaled one.
- **The job queue is a database table.** `POST /api/imports` inserts a row and
  returns `202 Accepted`; an in-process worker drains it. Because the queue lives
  in the same transactional store as the results, a crash mid-import leaves a row
  a startup sweep can requeue — no job is silently lost, and there is no Redis.
- **The dedupe key is the resolved URL, not the shared one.** iOS share links
  carry a *per-share token* — a different one every time you share the same reel.
  That is provenance; the post's shortcode is identity. A `UNIQUE` constraint on a
  derived value only enforces anything if every writer derives it identically.
- **The bot is deliberately stupid.** It turns a Telegram message into an HTTP
  call and reports back. All extraction lives once, behind the API, shared with
  the web app's paste flow. Many front doors, one engine room.

## Stack

Next.js 15 (App Router) · TypeScript · SQLite + Prisma · plain CSS · Gemini for
structuring and transcription · `yt-dlp` + `ffmpeg` for audio · Vitest.

Deployed as a **single pinned image running two services** (web and bot) to a
private Docker host reached over a Tailscale tailnet — never bound to `0.0.0.0`,
never exposed to the internet. One image means the two can't drift apart on a
deploy.

> The operator runbook (host specifics, update loop, rollback) lives in a private
> infrastructure repo — deliberately not published here.

## Security notes, sized to the threat model

Single user behind a private network, so there are no accounts. What that
*doesn't* excuse:

- **URLs are untrusted input reaching a subprocess.** `execFile` with an argument
  array, never a shell string; a host allowlist plus private/loopback/link-local
  and **CGNAT** rejection before any fetch, re-checked on every redirect hop
  (SSRF matters most when the server sits inside a private network).
- **Enqueue is authenticated, not self-declared** — an earlier version checked a
  token only when the request *said* it came from the bot, which meant omitting
  the field skipped the check.
- **Model output is untrusted too** — every string is length-capped where it
  enters the system, not at each place that later renders it.
- Path-traversal defence on served images is allowlist + resolve-and-assert, not
  character filtering.

## Docs

| | |
|---|---|
| [`docs/PRD.md`](docs/PRD.md) | Scope, acceptance criteria, and what is deliberately out |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Stack, the tiered pipeline, data model |
| [`docs/API_SPEC.md`](docs/API_SPEC.md) | The frontend ↔ backend ↔ bot contract |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Decisions, rationale, rejected alternatives |
| [`docs/RESEARCH-extraction.md`](docs/RESEARCH-extraction.md) | **Dated, measured** facts about what actually works on each platform |
| [`docs/NEXT_STEPS.md`](docs/NEXT_STEPS.md) | Current status and what is next |

`RESEARCH-extraction.md` is worth a look for one reason: it opens with a mistake.
The first spike tried six no-login routes to Instagram, all six failed
identically, and it concluded the platform was fully login-walled. That was wrong
— the test shortcodes had been invented, and a non-existent post returns exactly
the same page as a gated one. Six agreeing tests that share one broken assumption
are one test. The warning is at the top of the file so the next person doesn't
re-derive it.

## Running it

```bash
npm install
cp .env.example .env          # GEMINI_API_KEY at minimum
DATABASE_URL="file:./dev.db" npx prisma db push
npm run dev                   # http://localhost:3000
npm test                      # 430 tests
```

The Telegram bot needs its **own** token from BotFather — only one process may
long-poll a given token, so it cannot share one with another bot
([`docs/DECISIONS.md`](docs/DECISIONS.md) D-003).

## Licence

MIT. Not affiliated with Osta or its developers.
