# NEXT_STEPS — Mise

**Read this first when picking the project back up.** Status: **2026-09-16**.

## Status: v0.1.2 is BUILT, TESTED and LIVE on the homelab ✅

| Area | State |
|---|---|
| Research (what actually works) | ✅ Measured live — `docs/RESEARCH-extraction.md` |
| PRD / Architecture / API contract | ✅ `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/API_SPEC.md` |
| Extraction pipeline (4 tiers) | ✅ TikTok, Instagram, JSON-LD, audio gate |
| HTTP API (13 routes) + import worker | ✅ |
| PWA frontend (list, cook view, add, grocery) | ✅ |
| Telegram bot | ✅ Built + containerised — **not running, needs a token** |
| Tests | ✅ **430 passing, 0 failing**; `npx tsc --noEmit` clean |
| Red-team review | ✅ 3 critical + 5 warnings, all fixed and re-verified |
| Deployed | ✅ `http://100.74.128.98:3003` — tailnet only, healthy |

**How to use it right now (no bot needed):** on the phone, with Tailscale up,
open **<http://100.74.128.98:3003>** → **Add** → paste an Instagram/TikTok/recipe
link → it imports in ~10 s. Add to the Home Screen from **Safari**
(Share → Add to Home Screen); Chrome on iOS silently makes a non-standalone
shortcut instead.

## Proven end to end, on the box

| Source | Tier | Model | Result |
|---|---|---|---|
| TikTok | `tier1:tiktok-oembed` | gemini-2.5-flash | 7 ingredients, 2 steps, hero image |
| Instagram Reel | `tier1:instagram-embed` | gemini-2.5-flash | 8 ingredients, 11 steps, servings 6 |
| BBC Good Food | `tier0:json-ld` | **null** | 15 ingredients — imported with `GEMINI_API_KEY` **empty**, which is what proves PRD S4 |

## 🔴 The one thing blocked on you — ~3 minutes

**A Telegram bot token.** `mise-bot` is written, tested, containerised and
deployed-but-not-started (compose `profiles: ["bot"]`).

> It **cannot** borrow the Tennis bot's token, despite that being the original
> plan. Only one process may long-poll a token; `tennisbot-prefs` holds the
> Tennis one 24/7 and `legobot` holds the LEGO one. A second poller gets HTTP
> 409 and then *both* bots drop updates intermittently — it would silently break
> court booking. See `docs/DECISIONS.md` **D-003**.

1. Telegram → **@BotFather** → `/newbot` (e.g. `Mise Recipe Bot`).
2. Paste the token into `TELEGRAM_BOT_TOKEN` in `~/homelab/services/mise/.env`
   on the server — the file already exists, mode 600, with the field blank.
3. `ssh homelab 'cd ~/homelab && docker compose --profile bot up -d mise-bot'`
4. Message the bot `/id` to confirm the chat id, then `docker logs mise-bot`.
   **A line mentioning 409 means another process holds that token** — stop and
   re-read D-003 rather than restarting in a loop.

No code change is needed. Then: Share a Reel → Telegram → Mise bot → done.

## 🟠 Worth doing next, in order

1. **Field-test against ~10 of your own saved Reels** (PRD S1: 8/10 usable with
   no hand-editing). This is the only remaining unknown, and it is the one that
   decides whether the thing is actually good. Every recipe stores
   `extraction.tiers`, so the data to answer OQ-2 accumulates for free.
2. **HTTPS** (`docs/DECISIONS.md` D-008). Needs your sudo password, so it could
   not be done unattended. Until then the Paste button on `/add` is degraded —
   `navigator.clipboard` requires a secure context.
   `ssh -t homelab 'sudo tailscale serve --bg --https=8443 http://100.74.128.98:3003'`
   → `https://homelab.tailf48262.ts.net:8443`, then set `MISE_PUBLIC_BASE` to match.
   Rollback: `sudo tailscale serve --https=8443 off`.
3. **Give Mise its own `GEMINI_API_KEY`** — it currently shares Media Tracker's,
   so quota and revocation are entangled. <https://aistudio.google.com/apikey>.
4. **`RecipeList.tsx` hard-codes `limit: 100`** and ignores `nextCursor`, so
   recipe 101 is invisible. The pagination is fully built on the API side and
   simply unused.

## Known open items (none blocking)

- **Instagram comments are not read** — Osta's best trick, since creators often
  park the recipe in their first comment. No no-auth route to comment bodies was
  found (`docs/RESEARCH-extraction.md` §2). Mitigation today: the bot's
  manual-caption fallback. Worth another research pass.
- **Grocery merge normalisation mismatch** — the candidate line is found with
  punctuation-stripped matching but the sum is decided on raw remainders, so
  `"lb Shrimp,"` vs `"lb shrimp"` does not merge. Consequence is a cosmetic
  duplicate line, never a lost item. Pinned by a characterisation test.
- `parseInstructions` collapses newline-separated steps into one for some
  JSON-LD shapes; `/api/images` returns 500 (not 400) on a malformed
  percent-escape. Both pinned with tests.
- **No end-to-end UI tests.** The pure helpers in `components/` are well covered,
  but nothing proves the components call them in the right order with a working
  optimistic rollback. Highest-risk untested area.
- `ImportJob.chatId`/`messageId` are written and never read — the bot polls and
  edits on its own. Either delete the columns or use them to make the bot's
  in-memory pending-map durable across restarts.

## Operational quick reference

```bash
# Health + worker liveness
ssh homelab 'curl -s http://100.74.128.98:3003/api/health'
ssh homelab 'docker logs --tail 40 mise-web'

# Ship a change
cd ~/Development/Osta_replica && make check      # tsc + 430 tests
make publish VERSION=0.1.3
# bump BOTH image tags in ~/Development/homelab/services/mise/docker-compose.yml
ssh homelab 'cd ~/homelab && git pull && docker compose pull mise-web && docker compose up -d mise-web'

# Back up every recipe (the mise-data volume is the only copy)
ssh homelab 'docker run --rm -v homelab_mise-data:/d -v ~:/out alpine cp /d/mise.db /out/mise-backup.db'
```

⚠️ **Never `docker compose down -v`** — `mise-data` holds every saved recipe and
hero image.
