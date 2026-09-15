#!/usr/bin/env bash
# Build and publish the Mise image to GHCR with a pinned version.
#
# Usage:  scripts/publish.sh 0.1.0
#
# Prereqs (one-time):
#   - A GitHub PAT with `write:packages` in $CR_PAT, then:
#       echo "$CR_PAT" | docker login ghcr.io -u ignacio-montero --password-stdin
#
# ONE image serves BOTH homelab services (mise-web and mise-bot select with the
# container command), so they always deploy from the same tag and cannot drift.
# Built for linux/amd64 because the N95 is x86_64 and this Mac is arm64.
set -euo pipefail

VERSION="${1:?Usage: scripts/publish.sh <version>  e.g. 0.1.0}"
IMAGE="ghcr.io/ignacio-montero/mise"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo ">> Pre-flight: typecheck + tests (never publish a red build)"
( cd "$ROOT" && npx tsc --noEmit && npm test )

echo ">> Building ${IMAGE}:${VERSION} (linux/amd64)"
docker buildx build --platform linux/amd64 -t "${IMAGE}:${VERSION}" --push "${ROOT}"

echo ">> Published ${IMAGE}:${VERSION}"
echo ">> Next: bump the tag in ~/Development/homelab/services/mise/docker-compose.yml, then:"
echo "   ssh homelab 'cd ~/homelab && git pull && docker compose pull mise-web && docker compose up -d mise-web'"
