# CLAUDE.md — Mise (read me first)

Orientation for any Claude Code session in this repo. Loaded automatically at
session start.

## What this is

**Mise** — a self-hosted replica of the iOS app **Osta**: share an Instagram
Reel or TikTok from the phone's share sheet and get a clean, searchable,
cookable recipe. Single user, runs on the homelab, no subscription, no ads.
(Repo is `Osta_replica`; the product is named `Mise` — see `docs/DECISIONS.md`
D-001.)

Two surfaces:
- **Telegram bot** (`mise-bot`) — the ingest path. iOS Safari has no Web Share
  Target API, so a PWA can never be in the native share sheet; Telegram already
  is. That is the entire reason a bot exists (D-002).
- **PWA** (`mise-web`) — browse, search, cook, grocery list. Installs to the iOS
  Home Screen from **Safari** (Chrome on iOS makes a non-standalone shortcut).

## Docs map

- `docs/NEXT_STEPS.md` — **current status + what to do next. Read first.**
- `docs/RESEARCH-extraction.md` — measured, dated facts about what actually
  works on Instagram/TikTok. Perishable; re-verify before trusting.
- `docs/PRD.md` — scope, acceptance criteria, what is deliberately out.
- `docs/ARCHITECTURE.md` — stack, the tiered extraction pipeline, data model.
- `docs/API_SPEC.md` — the settled frontend↔backend↔bot contract.
- `docs/DECISIONS.md` — decisions + rationale + rejected alternatives.
- `DEPLOY.md` — build, publish, deploy, roll back.

## How to run

```bash
npm install
cp .env.example .env          # fill in GEMINI_API_KEY at minimum
DATABASE_URL="file:./prisma/dev.db" npx prisma db push
npm run dev                   # http://localhost:3000
npm test                      # vitest
npx tsc --noEmit              # must be clean
npm run bot                   # Telegram bot — needs its OWN token, see D-003
make build-local              # build the container image for a smoke test
make publish VERSION=0.2.0    # typecheck + test + push linux/amd64 to GHCR
```

## Architecture in one breath

`URL → classify → Tier 0 JSON-LD (no LLM) → Tier 1 caption → Tier 2 audio →
Tier 3 Gemini structuring → Recipe row.` Imports are **asynchronous**: the API
inserts an `ImportJob` row and returns 202; an in-process worker in `mise-web`
polls that table. The job queue *is* the database table.

## Key gotchas

- **⚠️ Only ONE process may long-poll a Telegram bot token.** `tennisbot-prefs`
  already holds the Tennis bot's token 24/7. Pointing `mise-bot` at it starts an
  HTTP 409 war that silently breaks *both* bots. Mise needs its own token from
  BotFather. `mise-bot` therefore ships behind a compose `profiles: ["bot"]` key
  and does **not** start with a plain `docker compose up -d`. See D-003.
- **⚠️ A non-existent Instagram shortcode looks exactly like a login wall.** It
  returns HTTP 200 with a ~623 KB logged-out JS shell, and yt-dlp says "empty
  media response … use --cookies". Before concluding Instagram has closed a
  route, **check the shortcode is real.** This exact trap produced a confidently
  wrong research conclusion during the first spike (`docs/RESEARCH-extraction.md`
  §2).
- **`heroImagePath` is a URL** (`/api/images/<file>`), not a filesystem path —
  Next only serves static assets from `/public`, so stored images go through a
  route. Usable directly as `<img src>`. Same pattern as Blue Plaques.
- **Quantities are strings, on purpose** (`1/2`, `2-3`, "a splash"). `lib/scale.ts`
  scales what it can parse and leaves the rest verbatim. Do not "fix" this into
  a float column — see D-006.
- **Ingredients/steps/tags are JSON TEXT columns.** Always go through
  `toRecipeDTO`/`recipeInclude` in `lib/serialize.ts`; never hand a raw Prisma
  row to the client.
- **Next.js 15: route params are a Promise.** `const { id } = await params`.
- **Temp files.** Downloaded audio lives under `DATA_DIR/tmp` and must be deleted
  in a `finally`; the entrypoint also sweeps it on boot. The SSD is 232 GB and
  shared with every other homelab service.
- **URLs from Telegram are untrusted.** They are host-allowlisted before any
  fetch or subprocess, and passed to `execFile` as an argument array — never
  interpolated into a shell string.

## Deployment

Containerised, pinned GHCR image, deployed to the homelab over Tailscale
(tailnet-only, never `0.0.0.0` — Docker bypasses UFW). **One image serves both
services**; `mise-web` and `mise-bot` must always run the same tag. Control repo:
`~/Development/homelab` → `services/mise/`. Full runbook: `DEPLOY.md`.

## Conventions

Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`). New logic
ships with tests. After a meaningful change update `docs/DECISIONS.md` (what +
why) and `docs/NEXT_STEPS.md` (status + next) before ending the session.
