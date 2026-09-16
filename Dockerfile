# Mise — production image (multi-stage, Next.js standalone).
#
# ONE image, TWO commands — the same convention the tennisbot services use:
#   docker run … mise            → web app   (default CMD: node server.js)
#   docker run … mise bot        → Telegram ingest bot
# Shipping both from one tag guarantees mise-web and mise-bot can never drift
# apart on a deploy: they share lib/config.ts and the API contract, so they must
# roll together.
#
# Design notes:
#  - Built on linux/amd64 so Prisma generates the correct engine for the N95 box
#    (building on the developer's arm64 Mac would bake the wrong binary).
#  - `output: "standalone"` traces only the files the server needs.
#  - The SQLite DB and hero images live on a mounted volume at /app/data, never
#    inside the image — see docker-entrypoint.sh + docker-compose.yml.
#  - yt-dlp + ffmpeg are runtime dependencies of the extraction pipeline
#    (docs/ARCHITECTURE.md §3), which is why the runner is not a bare node image.

# ---- deps ----------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# ---- builder -------------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV DATABASE_URL="file:/tmp/build.db"
# ⚠️ Build-time memory ceiling, not a performance tweak. Cross-building amd64 on
# an arm64 Mac runs under QEMU inside a small Colima VM (2 GB by default), and
# Next's build worker happily grows past that and is OOM-killed — surfacing as a
# baffling `build worker exited with code: null and signal: SIGSEGV` rather than
# anything mentioning memory. Capping the heap and pinning the build to a single
# worker keeps it inside the VM, at the cost of a slower build. Native amd64
# hosts are unaffected.
ENV NODE_OPTIONS="--max-old-space-size=1536"
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate
RUN npm run build

# The bot is a plain Node process, not part of the Next build, so bundle it to
# one self-contained file. esbuild already ships inside tsx — no extra dep. This
# also means the runtime image needs neither tsx nor a TypeScript toolchain.
RUN npx esbuild bot/index.ts --bundle --platform=node --target=node22 \
      --format=esm --outfile=dist/bot.mjs \
      --external:@prisma/client --external:sharp

# An EMPTY database carrying the current schema, copied into the volume on first
# boot. Unlike Blue Plaques there is no seed data — a new install starts with no
# recipes — but shipping the schema means the runtime never needs the Prisma CLI.
RUN mkdir -p /app/seed \
    && DATABASE_URL="file:/app/seed/mise.db" npx prisma db push --skip-generate --accept-data-loss

# ---- runner --------------------------------------------------------------
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# openssl: Prisma query engine. ffmpeg: audio extraction for the Tier 2
# transcription path. python3 + yt-dlp: the metadata/audio fetcher.
# yt-dlp is pinned so a surprise upstream change can't silently alter extraction
# behaviour on a redeploy; bump it deliberately (see DEPLOY.md).
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ffmpeg python3 python3-pip ca-certificates \
    && pip3 install --no-cache-dir --break-system-packages "yt-dlp==2026.8.19" \
    && apt-get purge -y python3-pip && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Prisma client + linux engine. The standalone tracer usually catches these, but
# Blue Plaques was bitten by the tracer dropping runtime-loaded binaries, so copy
# them explicitly. The Prisma CLI is deliberately NOT shipped — the schema is
# already applied in the baked snapshot.
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# sharp: native .node binaries live in platform packages under @img/ that the
# standalone tracer can drop. Copy both wholesale — same trap as above.
COPY --from=builder /app/node_modules/sharp ./node_modules/sharp
COPY --from=builder /app/node_modules/@img ./node_modules/@img

COPY --from=builder /app/dist/bot.mjs ./dist/bot.mjs
COPY --from=builder /app/seed ./seed

COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Volume layout: SQLite DB + hero images + the temp dir the extractor sweeps.
RUN mkdir -p /app/data/images /app/data/tmp \
    && chown -R node:node /app/data /app/seed /app/prisma
USER node

EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0 DATA_DIR=/app/data

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
