#!/bin/sh
# Mise container entrypoint. Idempotent and non-destructive to existing data.
#
#   ./docker-entrypoint.sh node server.js   → the web app (default CMD)
#   ./docker-entrypoint.sh bot              → the Telegram ingest bot
#
# The bot shares this image but must NOT touch the database or the volume — it
# talks to the web app over HTTP. So the DB bootstrap below is skipped for it.
set -e

if [ "$1" = "bot" ]; then
  echo "[entrypoint] Starting Telegram ingest bot."
  exec node /app/dist/bot.mjs
fi

DATA_DIR="${DATA_DIR:-/app/data}"
DB_FILE="${DB_FILE:-$DATA_DIR/mise.db}"
SEED_DB="/app/seed/mise.db"

# 1. Runtime-writable directories on the mounted volume.
mkdir -p "$DATA_DIR/images" "$DATA_DIR/tmp"

# 2. First boot only: copy the empty, correctly-schema'd DB into the volume.
#    Every later boot leaves the user's recipes alone.
if [ ! -f "$DB_FILE" ]; then
  if [ -f "$SEED_DB" ]; then
    echo "[entrypoint] First boot: creating volume DB from image schema snapshot."
    cp "$SEED_DB" "$DB_FILE"
  else
    echo "[entrypoint] First boot: no snapshot found, starting with empty DB."
  fi
else
  echo "[entrypoint] Existing volume DB found — leaving data intact."
fi

# 3. Clear any audio/video left behind by an import that died mid-flight. The
#    worker sweeps this too, but doing it here means a crash-loop can never
#    accumulate temp files across restarts.
if [ -d "$DATA_DIR/tmp" ]; then
  find "$DATA_DIR/tmp" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
fi

echo "[entrypoint] Starting Next.js server..."
exec "$@"
