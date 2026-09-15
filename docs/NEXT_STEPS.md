# NEXT_STEPS — Mise

**Read this first when picking the project back up.** Status as of
**2026-09-15**.

## Where the project is

Design is complete and verified; implementation is in flight.

| Area | State |
|---|---|
| Research (what actually works) | ✅ **Done and measured live.** `docs/RESEARCH-extraction.md` |
| PRD / Architecture / API contract | ✅ Done. `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/API_SPEC.md` |
| Schema + shared seams | ✅ Done. `prisma/schema.prisma`, `lib/{types,config,prisma,serialize,http,scale}.ts` |
| Extraction engine + worker | 🔨 In progress — `lib/extract/**`, `lib/worker.ts`, `lib/gemini.ts` |
| HTTP API | 🔨 In progress — `app/api/**` |
| PWA frontend | 🔨 In progress — `app/`, `components/**` |
| Telegram bot | 🔨 In progress — `bot/**` |
| Deploy bundle | ✅ Done. `Dockerfile`, `docker-entrypoint.sh`, `docker-compose.yml`, `scripts/publish.sh` |
| Tests | ⬜ Not started |
| Deployed to homelab | ⬜ Not yet |

## The one thing that is verified end-to-end

The core technical risk — *can we actually get a recipe out of a Reel?* — is
**answered yes**, measured on 2026-09-15:

- TikTok caption via public oEmbed: works, no auth.
- Instagram caption via `/embed/captioned`: works, no auth, on public reels.
- Gemini turning that caption into correct structured JSON: 6.7 s, ~400 tokens.

Everything else is ordinary application code around that spine. Re-verify with
the commands in `docs/RESEARCH-extraction.md` before assuming it still holds.

## Ordered next steps

1. **Integrate + typecheck.** `npx tsc --noEmit && npm run build`. The four
   workstreams were built in parallel against `docs/API_SPEC.md`; expect the
   seams (`workerStatus()`, DTO shapes) to need a pass.
2. **Tests.** Priority order — they map to where the bugs will be:
   `lib/scale.ts` (fractions, ranges, unparseable quantities),
   `lib/extract/website.ts` (JSON-LD shape zoo), `lib/extract/heuristics.ts`
   (the tier gate), `bot/format.ts` (Markdown escaping), then the API routes.
3. **Local end-to-end.** `make build-local`, run the container, import the three
   known-good fixtures in `docs/RESEARCH-extraction.md`, confirm recipes appear.
4. **Publish + deploy** `mise-web` — see `DEPLOY.md`.
5. **Field-test** against ~10 real saved Reels (PRD success criterion S1: 8/10
   usable with no hand-editing). Fix what that exposes; it always exposes something.

## Blocked / needs the user

- **🔴 A Telegram bot token.** `mise-bot` is written and containerised but cannot
  start without its own token — see `docs/DECISIONS.md` **D-003** for why it
  cannot borrow the Tennis bot's. To unblock:
  1. Telegram → **@BotFather** → `/newbot` → name it (e.g. `Mise Recipe Bot`,
     username `@nacho_mise_bot`).
  2. Put the token in `TELEGRAM_BOT_TOKEN` in the server's untracked
     `~/homelab/services/mise/.env`.
  3. Message the bot once, then `/id` gives the chat id for `TELEGRAM_CHAT_ID`.
  4. `ssh homelab 'cd ~/homelab && docker compose --profile bot up -d mise-bot'`
  No code change is needed — only the env var and that one command.
- **🟠 HTTPS on the tailnet** (`docs/DECISIONS.md` **D-008**). Needs a `sudo`
  password and a yes, because it is a networking change on the box:
  `ssh -t homelab 'sudo tailscale serve --bg --https=8443 http://100.74.128.98:3003'`
  Until then the Paste button on `/add` is degraded — `navigator.clipboard`
  needs a secure context.
- **🟡 `GEMINI_API_KEY`.** Currently the only key on this machine belongs to
  Media Tracker. Mise should get its own from
  <https://aistudio.google.com/apikey> so quota and revocation are independent.

## Known gaps versus Osta

- **Instagram comments are not read.** Osta's best trick — creators often park
  the recipe in their own first comment. No no-auth route to comment bodies was
  found (`docs/RESEARCH-extraction.md` §2). Mitigation today is the bot's
  manual-caption fallback. Worth another research pass.
- No nutrition info, no sharing, no meal planner — all deliberate (PRD §5).

## Open questions

- **OQ-2** Is the audio-transcription tier worth its latency in practice, or is
  caption-only enough? Measure after ~20 real imports — the provenance stored on
  every recipe (`extraction.tiers`) is exactly the data that answers this.
- **OQ-3** Keep `rawText` on failed jobs forever? Currently yes (retry is free).
