# DECISIONS — Mise

Running log of notable decisions and *why*. Newest last. Homelab-side changes
are logged separately in `~/Development/homelab/docs/decisions.md`.

---

### D-001 — The clone gets its own name: **Mise** (2026-09-15)
**What.** Product name `Mise` (from *mise en place*); repo stays `Osta_replica`;
homelab services are `mise-web` / `mise-bot`; image `ghcr.io/ignacio-montero/mise`.
**Why.** Osta is a live trademarked product. Shipping a private clone under the
same name is sloppy even when nobody else will see it, and it makes conversations
ambiguous ("is that Osta or our Osta?"). **Rejected:** naming everything `osta`
— simpler mapping, but conflates the target with the replica.
**Cost.** One mapping to remember: repo `Osta_replica` → product `Mise`.
Renaming is `APP_NAME` in `lib/config.ts` plus the compose service names.

---

### D-002 — Ingest is a Telegram bot, not a PWA share target (2026-09-15)
**What.** The "share a Reel" entry point is a Telegram bot; the PWA offers
paste-a-link as a secondary path.
**Why.** iOS Safari does **not** implement the Web Share Target API, so an
installed PWA can never appear in the native iOS share sheet. Telegram already
is in that sheet. This is a platform limitation, not a preference.
**Rejected:** (a) a share-target PWA — impossible on iOS; (b) an iOS Shortcut
wired to the share sheet — works, but is fiddly to install and to keep working
across iOS updates; kept as a possible addition, not the primary path;
(c) a native app — out of scope for a self-hosted personal project.

---

### D-003 — ⚠️ Mise needs its OWN Telegram bot token (2026-09-15)
**What.** `mise-bot` cannot share the Tennis bot's token, despite the original
request to "take the Tennis one for now".
**Why.** **Only one process may long-poll a given bot token** — Telegram returns
HTTP 409 to the second one. `tennisbot-prefs` already long-polls the Tennis
token 24/7 (it is how booking preferences are set from the phone). Pointing
`mise-bot` at that token starts a 409 war in which *both* bots intermittently
lose updates — it would silently degrade a working service the user depends on.
The same applies to the LEGO bot's token (`legobot` long-polls it, and
`coach-sync` sends through it).
**Consequence.** `mise-bot` is built and containerised but ships **disabled**
behind a compose `profiles:` key. Enabling it is: create a bot with BotFather →
put the token in the server's `.env` → one `docker compose --profile bot up -d`.
No code change.
**Rejected:** (a) sharing the token anyway — breaks tennisbot-prefs;
(b) a Telegram **webhook** instead of long-polling, which has no 409 problem —
but webhooks need a *publicly* reachable HTTPS URL, and the box is deliberately
tailnet-only. Using `tailscale funnel` to expose it publicly is a real security
downgrade for a convenience, and a networking change the user must approve.
**Meanwhile** the app is fully usable via the PWA's paste-a-link flow.

---

### D-004 — Extraction is tiered, and Tier 0 never calls the LLM (2026-09-15)
**What.** structured data → caption/metadata → audio → LLM structuring, in that
order, stopping as early as possible.
**Why.** Most recipe *websites* already publish `schema.org/Recipe` JSON-LD.
Parsing it is exact, instant, free and cannot hallucinate. Sending it to a model
instead would be slower, costlier and *less* accurate. Never use a model where
the data is already structured. The `looksLikeRecipe()` heuristic is the gate
that stops every import paying the audio-download tax.
**Rejected:** "just send everything to the LLM" — one code path, but it burns
quota on data that was already perfect, and introduces hallucination risk where
there was none.

---

### D-005 — Gemini, with a model **fallback chain** (2026-09-15)
**What.** `GEMINI_MODELS` is a comma-separated list walked in order on 503/429.
**Why.** Gemini is already the house LLM (Media Tracker). During the spike
`gemini-3.8-flash` answered `503 "model is currently experiencing high demand"`
on the very first call, while `gemini-2.5-flash` answered in 6.7 s. A single
pinned model name is a single point of failure for the app's core feature.
**Rejected:** running Whisper locally for transcription — free and private, but
ASR on a GPU-less N95 is minutes per reel, and Gemini accepts audio natively.

---

### D-006 — Quantities are stored as TEXT, not numbers (2026-09-15)
**What.** `Ingredient.quantity` is a string; scaling parses on demand.
**Why.** Real captions say `1/2`, `1 1/2`, `2-3`, "measure with your heart".
Coercing to a float at ingest destroys information you can never get back, and
renders `0.3333333 cup` in a kitchen. `lib/scale.ts` parses when it confidently
can and **leaves anything else exactly as written** — scaling a range or a
figure of speech is a guess, and a wrong guess in a recipe is worse than no
scaling. **Rejected:** a numeric column with a separate `qualifier` string —
more schema for a case that is better served by not guessing.

---

### D-007 — The job queue is a database table (2026-09-15)
**What.** `ImportJob` rows are the queue; an in-process worker in `mise-web`
polls it. See `docs/ARCHITECTURE.md` §2.
**Why.** ~5 imports a day by one person. A table plus a poll loop is ~80 lines,
needs no new container, and survives restarts because the queue *is* the
database — a crash leaves a `running` row that startup requeues.
**Rejected:** (a) BullMQ + Redis — correct at scale, absurd here, and a second
always-on container on an 8 GB box; (b) doing the import synchronously in the
HTTP request — simplest, but a 25 s request held open by the PWA is bad UX and
fragile; (c) a separate `mise-worker` container — cleaner isolation, but makes
two processes write one SQLite file across containers, buying `SQLITE_BUSY`
handling for no benefit at this scale.

---

### D-008 — Tailnet-only over plain HTTP first; HTTPS is a follow-up (2026-09-15)
**What.** `mise-web` publishes `100.74.128.98:3003` (HTTP). The Tailscale HTTPS
name is **not** wired up in this pass.
**Why.** `tailscale serve --https=443` on the box already proxies its root path
to plaque-hunter, so Mise needs either a sub-path (which forces a Next.js
`basePath` and complicates the PWA scope) or a second HTTPS port. Either is a
**networking change on the server**, which the homelab standing orders say
requires explicit confirmation — and it needs interactive sudo, which `nacho`
does not have passwordless. So it cannot be done unattended.
**Consequence.** Two things need HTTPS and are degraded until it is done:
`navigator.clipboard.readText()` (the Paste button on `/add`) and any future
service worker. Everything else works over HTTP on the tailnet.
**The follow-up (needs the user's password + a yes):**
`ssh -t homelab 'sudo tailscale serve --bg --https=8443 http://100.74.128.98:3003'`
→ `https://homelab.tailf48262.ts.net:8443`. Rollback:
`sudo tailscale serve --https=8443 off`.

---

### D-009 — Enqueue is authenticated, not self-declared (2026-09-16)
**What.** `POST /api/imports` requires either a valid `x-mise-token` OR a
same-origin browser request. It previously checked the token only when the body
said `"source": "telegram"`.
**Why.** `source` is a label the caller chooses, so omitting it skipped the check
entirely — authorisation decided by the request's own say-so. Authenticate first,
then derive what the caller may do.
**Also learned the hard way:** the first fix added a "no `Origin` header at all →
assume an old browser, allow" fallback. A bare `curl` sends no Origin, so that
fallback re-opened the exact hole it was closing. **Absence of evidence is not
evidence of a browser.** Verified 401/401/401/202/202 across no-creds, bad token,
cross-origin, valid token, same-origin.

---

### D-010 — One canonicaliser owns the dedupe key (2026-09-16)
**What.** `lib/canonicalUrl.ts` is the single deriver of `Recipe.sourceUrl`, and
the **worker** stores the RESOLVED identity, not the URL the user shared.
**Why.** Two normalisers existed and disagreed — the API route stripped `www.`
and the trailing slash, the extractor added both back — so the route's "already
saved?" lookup could never match a stored row and the UNIQUE index enforced
nothing. **A UNIQUE constraint on a *derived* value only enforces anything if
every writer derives it identically.**
The design question underneath: the iOS share sheet emits
`instagram.com/share/<token>` with a **different token every share**. That is
*provenance*; the reel's shortcode is *identity*. Dedupe must key on identity, so
the worker — the first place the redirect has been resolved — decides the key.
Enqueue-time dedupe stays best-effort; the save-time check is authoritative.
**Sequel (same day):** `/share/reel/<token>/` is spelled exactly like
`reel/<code>`, so classify's kinds-loop matched the share token as a shortcode
and re-created the symptom through a different door. `/share/` is now checked
**first**, and the ordering is load-bearing.

---

### D-011 — Bounded everything that crosses a trust boundary (2026-09-16)
**What.** Model output strings are capped in `coerceParsed`; `htmlToText` scans at
most 300 KB and no longer uses a backreferenced regex; import leases expire.
**Why.** Three findings with one shape — *unbounded work on untrusted input*:
- A `\1` backreference plus a lazy quantifier made every unclosed tag rescan to
  end-of-string: **116 s** on a 3 MB page, measured. Synchronous on the only
  thread, so health checks and the pipeline's own abort timers could not fire
  either — a service outage, not a slow function. Linear scan now: **1 ms**.
- An unbounded LLM title 400s Telegram twice (edit, then the send fallback), so
  the chat sits on "⏳ Importing…" forever while the recipe saved fine.
- Claiming a job by flipping `status` is a **lease with no expiry**; a failed
  failure-write stranded a row in `running` forever and made that URL
  permanently un-importable. Startup-only reaping covers "the process died", not
  "the process is alive and dropped the ball". Now reclaimed per tick.
