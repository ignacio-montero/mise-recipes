# Mise — release helpers. An update should be one line: `make publish VERSION=0.2.0`.
IMAGE := ghcr.io/ignacio-montero/mise

.PHONY: help publish build-local check dev bot

help:
	@echo "make check                   # typecheck + tests"
	@echo "make dev                     # next dev on :3000"
	@echo "make bot                     # run the Telegram bot locally (needs its own token)"
	@echo "make build-local             # build the image locally for a smoke test"
	@echo "make publish VERSION=0.2.0   # typecheck, test, build linux/amd64, push to GHCR"

check:
	npx tsc --noEmit && npm test

dev:
	npm run dev

bot:
	npm run bot

build-local:
	docker build -t $(IMAGE):local .

publish:
	@test -n "$(VERSION)" || (echo "VERSION is required, e.g. make publish VERSION=0.2.0" && exit 1)
	./scripts/publish.sh $(VERSION)
