# PRD — Mise (an Osta replica)

> **Name.** The product is called **Mise** (from *mise en place*). The repo is
> `Osta_replica` and the target it replicates is the iOS app **Osta**; the clone
> gets its own name rather than the trademark. Renaming is a one-line change —
> `APP_NAME` in `lib/config.ts` plus the homelab service names. See
> `docs/DECISIONS.md` D-001.

## 1. The problem

Recipes arrive as **Instagram Reels and TikToks**. Instagram's own "Saved"
collection is a wall of muted video thumbnails: you cannot search it, you cannot
read the ingredients without scrubbing a 40-second video, and you certainly
cannot cook from it with wet hands. The recipe is usually sitting in the caption
as plain text — it is just trapped inside a video player.

Osta solves this and it is good, but it is a subscription (£49.99/yr), it shows
a minute of ads per import on the free tier, and the data lives on someone
else's server.

## 2. Goal

**Share a Reel or TikTok from the phone's share sheet and have a clean,
searchable, cookable recipe waiting in a personal app seconds later.** Self-hosted
on the homelab, single user, no subscription, no ads.

## 3. Who it's for

One user (Nacho), on an iPhone, standing in a kitchen. Everything is designed for
that: one hand, short sessions, possibly greasy fingers, always on the tailnet.

## 4. The core loop (v1 must-have)

1. In Instagram/TikTok, tap **Share → Telegram → Mise bot**.
2. The bot replies `⏳ Importing…` within a second.
3. Within ~10 s the message becomes `✅ Crispy Shrimp Tacos — 9 ingredients, 9 steps` with a link.
4. Open Mise on the Home Screen → the recipe is there, searchable, with a cook view.

**Why Telegram rather than a share-target PWA.** iOS Safari does not implement
the Web Share Target API, so an installed PWA cannot appear in the native share
sheet. Telegram already does. This is the whole reason the ingest surface is a
bot and not a web page — see `docs/DECISIONS.md` D-002.

## 5. Scope

### In scope (v1)

| # | Capability | Acceptance criterion |
|---|---|---|
| F1 | **Import from TikTok** | A public TikTok URL yields a recipe with ≥1 ingredient and ≥1 step, no auth. |
| F2 | **Import from Instagram** | A public Reel URL likewise. |
| F3 | **Import from a recipe website** | A URL with `schema.org/Recipe` JSON-LD is parsed **without** calling the LLM. |
| F4 | **Manual paste fallback** | If extraction finds no recipe, replying to the bot with pasted caption text produces one. |
| F5 | **Telegram ingest bot** | Any message containing a URL enqueues an import; the bot edits its own message with the outcome. Only the owner's chat id is honoured. |
| F6 | **Recipe list** | Phone-first list with free-text search across title, ingredients and tags. |
| F7 | **Cook view** | Hero image, servings, time, tappable ingredient checkboxes, numbered steps, screen stays awake. |
| F8 | **Servings scaler** | Changing servings rescales every numeric quantity, including fractions (`1/2` → `3/4`). |
| F9 | **Edit + delete** | Any field of an extracted recipe can be corrected by hand. Extraction is a draft, not gospel. |
| F10 | **Folders** | Recipes can be filed into named folders and filtered by one. |
| F11 | **Grocery list** | "Add ingredients to grocery list" from a recipe; check off; clear checked. |
| F12 | **Installable PWA** | Adds to the iOS Home Screen from **Safari** and opens standalone. |
| F13 | **Provenance** | Every recipe keeps its source URL, author, and which extraction tier produced it. |

### Explicitly out of scope (v1)

- **Multi-user / auth.** Single implicit user, tailnet-only — same posture as
  Blue Plaque Hunter. No login screen.
- **Sharing recipes with other people.** Osta has it; there is nobody to share with.
- **Nutrition information.** Osta gates this behind premium; it needs a food
  database and it would be invented numbers otherwise.
- **Meal planning / calendar.**
- **Native iOS app.** The PWA + Telegram combination is the deliberate substitute.
- **Reading Instagram comments.** Wanted (it is Osta's best trick) but no no-auth
  route was found — see `docs/RESEARCH-extraction.md` §2. Deferred, not forgotten.
- **Paying for extraction.** No Apify/Scrapfly; free public routes or nothing.

## 6. Success criteria

- **S1** — 8 of 10 real recipe Reels/TikToks from the user's own saved list import
  with a usable ingredient list and steps, with no hand-editing.
- **S2** — Median import latency, share-sheet tap to bot confirmation, **under 15 s**.
- **S3** — The cook view is usable one-handed: every tap target ≥44 px, no page
  scroll needed to see the ingredient list on an iPhone 11.
- **S4** — Zero LLM calls for website imports that carry JSON-LD.
- **S5** — The whole thing fits in **under 800 MB** of RAM limit on the N95 box.

## 7. Non-functional constraints

- Homelab: Intel N95, 8 GB **soldered**, 232 GB SSD. Tailnet-only binding, never `0.0.0.0`.
- Pinned GHCR images; the box pulls, never builds.
- Secrets in an untracked `.env` **on the server**.
- Temporary audio/video files must be deleted after each import and capped in
  total — a runaway cache would eat the SSD.

## 8. Open questions

- **OQ-1** Does the Telegram bot get its own token, or share the Tennis bot's?
  *Current answer: its own is required — only one process may long-poll a token,
  and `tennisbot-prefs` already holds the Tennis one. See D-003.*
- **OQ-2** Is the audio-transcription tier worth its latency, or is
  caption+comments enough in practice? Measure after ~20 real imports.
- **OQ-3** Should failed imports keep the raw gathered text forever? (Currently
  yes — it makes retry free. Revisit if the DB grows.)
