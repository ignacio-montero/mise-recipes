# DEPLOY.md — Mise operator runbook

Target: the always-on homelab (Intel N95, 8 GB soldered, Ubuntu 26.04, Docker,
Tailscale), reached as `ssh homelab`. Control repo: `~/Development/homelab`.

**One image, two services.** `ghcr.io/ignacio-montero/mise:<tag>` runs the web
app by default and the Telegram bot with `command: ["bot"]`. They share
`lib/config.ts` and the API contract, so **always roll both to the same tag.**

## Conventions this obeys (from the homelab repo)

- Published port bound to the **tailnet IP `100.74.128.98`**, never `0.0.0.0` —
  Docker's iptables rules bypass UFW, so a `0.0.0.0` bind silently exposes the
  service to the whole LAN.
- Pinned, versioned GHCR image. **The box pulls; it never builds.**
- `mem_limit` on every service (8 GB soldered ceiling).
- Secrets in an **untracked `.env` on the server**, never in git.
- Persistent data in a named volume so it survives `up -d`.

## Ports

| Port | Service |
|---|---|
| 3000 | homepage |
| 3001 | plaque-hunter |
| 3002 | coach-view |
| **3003** | **mise-web** ← this service |
| 8080 | dozzle |

## First deploy

```bash
# 1. Publish a pinned image (runs typecheck + tests first, then builds amd64).
cd ~/Development/Osta_replica
make publish VERSION=0.1.0

# 2. Add the service to the homelab control repo.
mkdir -p ~/Development/homelab/services/mise
cp docker-compose.yml ~/Development/homelab/services/mise/docker-compose.yml
#    …then edit it: bind 100.74.128.98:3003:3000 (not 127.0.0.1).
#    Add this line to ~/Development/homelab/compose.yaml:
#      - services/mise/docker-compose.yml
cd ~/Development/homelab && git add -A && git commit -m "feat: add mise" && git push

# 3. Create the untracked .env ON THE SERVER (never in git).
ssh homelab 'cat > ~/homelab/services/mise/.env' <<'ENV'
GEMINI_API_KEY=...
OSTA_INGEST_TOKEN=...            # any long random string
MISE_PUBLIC_BASE=http://100.74.128.98:3003
# Bot only — needs its OWN token, see docs/DECISIONS.md D-003:
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=6519408112
ENV
ssh homelab 'chmod 600 ~/homelab/services/mise/.env'

# 4. Pull loop.
ssh homelab 'cd ~/homelab && git pull && docker compose up -d mise-web'

# 5. Verify.
ssh homelab 'docker ps --filter name=mise-web --format "{{.Names}} {{.Status}} {{.Ports}}"'
ssh homelab 'curl -s localhost:3003/api/health'    # expect {"ok":true,...}
#   Confirm it is NOT on the LAN (this must FAIL / time out):
curl -m 5 http://192.168.1.101:3003/api/health || echo "correctly not exposed on LAN"

# 6. Re-run the snapshot and log the change in the HOMELAB repo.
cd ~/Development/homelab && ./scripts/snapshot.sh
#   …then append a dated entry to docs/decisions.md with the rollback.
```

## Enabling the Telegram bot (blocked on a token)

`mise-bot` is behind a compose `profiles: ["bot"]` key, so `docker compose up -d`
deliberately does **not** start it.

> **⚠️ Why it cannot reuse the Tennis bot's token.** Only one process may
> long-poll a given bot token; a second gets HTTP 409. `tennisbot-prefs` already
> long-polls the Tennis token 24/7. Sharing it would silently break *both* bots.
> Same for the LEGO token. See `docs/DECISIONS.md` D-003.

```bash
# 1. @BotFather → /newbot → copy the token.
# 2. Put it in TELEGRAM_BOT_TOKEN in ~/homelab/services/mise/.env on the server.
# 3. Start it:
ssh homelab 'cd ~/homelab && docker compose --profile bot up -d mise-bot'
# 4. Message the bot /id to confirm the chat id, then check:
ssh homelab 'docker logs --tail 30 mise-bot'
#    A line containing "409" means another process holds the token — stop and
#    re-read D-003 rather than restarting the container in a loop.
```

## Optional: HTTPS on the tailnet

Needed for `navigator.clipboard.readText()` (the Paste button on `/add`) and any
future service worker — both require a secure context. **This is a networking
change: confirm before running, and it needs an interactive sudo password.**

```bash
ssh -t homelab 'sudo tailscale serve --bg --https=8443 http://100.74.128.98:3003'
# → https://homelab.tailf48262.ts.net:8443
# Rollback: ssh -t homelab 'sudo tailscale serve --https=8443 off'
```

Port 443 is already taken by plaque-hunter's proxy, hence 8443. Then set
`MISE_PUBLIC_BASE` to the HTTPS URL so the bot's "open recipe" links use it.

## Updating

```bash
make publish VERSION=0.2.0
# bump BOTH services' image tags in ~/Development/homelab/services/mise/docker-compose.yml
cd ~/Development/homelab && git commit -am "chore: mise 0.2.0" && git push
ssh homelab 'cd ~/homelab && git pull && docker compose pull mise-web && docker compose up -d mise-web'
# if the bot is enabled, roll it to the SAME tag in the same breath:
ssh homelab 'cd ~/homelab && docker compose --profile bot up -d mise-bot'
```

Config/env-only changes skip the rebuild: edit `.env` on the server, then
`docker compose up -d mise-web`.

## Rollback

Repoint the image tag to the previous version and redeploy. This is why tags are
pinned and `:latest` is never used.

⚠️ **Rollback is only safe if the newer version ran no schema migration.** The
image ships an empty, correctly-schema'd DB used on *first boot only*; an
existing volume is never re-initialised. If a future release changes
`prisma/schema.prisma`, migrating an existing volume is a deliberate step —
back up first:

```bash
ssh homelab 'docker run --rm -v homelab_mise-data:/d -v ~:/out alpine cp /d/mise.db /out/mise-backup.db'
```

## Data

The named volume `mise-data` holds the **SQLite DB and every hero image**.
`docker compose down -v` or `docker volume rm` destroys all saved recipes.
**Do not run those.** `up -d` and `pull` are safe.

`DATA_DIR/tmp` holds transient audio during an import; the worker deletes it in a
`finally` and the entrypoint sweeps it on boot. If it ever grows, an import is
crashing before cleanup — check `docker logs mise-web`.

## Resource budget

| Service | `mem_limit` | Why |
|---|---|---|
| `mise-web` | 640 MB | Next.js standalone (~150 MB idle) plus short yt-dlp/ffmpeg spikes during an import. |
| `mise-bot` | 128 MB | A `fetch` long-poll loop, nothing else. |

~768 MB on top of the ~4.8 GB already committed on the box.
