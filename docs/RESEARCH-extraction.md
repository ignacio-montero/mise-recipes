# RESEARCH — how recipe-clipper apps get a recipe out of a Reel

**Date of measurement: 2026-09-15.** Every claim below was verified by a live
call from this machine on that date, not read off a blog. Social platforms change
their anti-scraping posture often, so **re-verify before trusting any of this**;
the reproduction command is given for each row.

## 1. What Osta actually does (competitive read)

Osta (General Digital Connoisseurs Ltd., iOS 1.4.5, 4.8★ / 6.8k ratings,
£7.99/mo or £49.99/yr) markets four things:

1. **Import from Instagram, TikTok or a website** — "in 2 seconds".
2. **A clean cook view** — no ads, no life story, just ingredients + steps.
3. **Folders + sharing.**
4. **Grocery lists** built from saved recipes.

Two details from reviews are load-bearing for the replica:

- Osta reads the **comments, not just the description** — reviewers call this
  "game changing". Creators routinely park the actual recipe in their own first
  comment to keep the caption short. Any clipper that reads only the caption
  will miss a large slice of Instagram.
- Competitors (FoodiePrep, ReciMe, Paprika) advertise reading the **audio and
  on-screen text** for reels with no usable caption.

So the extraction surface, in descending order of how often it pays off:
**caption → pinned/author comment → website JSON-LD → audio transcript →
on-screen text.**

## 2. Measured results per platform

| Platform | Route | Result 2026-09-15 | Reproduce |
|---|---|---|---|
| **TikTok** | public oEmbed `https://www.tiktok.com/oembed?url=…` | ✅ **Works, no auth.** Returns full caption as `title`, plus `author_name` and `thumbnail_url`. | `curl -s 'https://www.tiktok.com/oembed?url=https://www.tiktok.com/@butterworthdasyrup/video/7484033605795204394'` |
| **TikTok** | `yt-dlp --dump-json` | ✅ Works, no cookies. Richer (duration, formats) but spawns a process. | `yt-dlp --skip-download --print '%(title)s' <url>` |
| **Instagram** | `…/reel/<shortcode>/embed/captioned/` | ✅ **Works, no auth.** ~270 KB HTML containing a `class="Caption"` div with the full caption text. | `curl -A '<desktop UA>' 'https://www.instagram.com/reel/C9dO9AevUQx/embed/captioned/'` |
| **Instagram** | `yt-dlp --dump-json` | ✅ Works, no cookies, for **public** posts. Gives `description` + thumbnail + video URL. | `yt-dlp --skip-download --print '%(description)s' 'https://www.instagram.com/reel/C9dO9AevUQx/'` |
| **Instagram** | `i.instagram.com/api/v1/media/<id>/info/` | ❌ HTTP 403. | — |
| **Instagram** | `/graphql/query/?query_hash=…` | ❌ HTTP 401. | — |
| **Instagram** | `www.instagram.com/api/v1/media/<id>/info/` | ❌ 200 but returns the logged-out JS shell, no data. | — |

### ⚠️ The trap that cost an hour — read this before "fixing" Instagram

A **non-existent** Instagram shortcode does **not** 404. It returns:

- `HTTP 200` with a ~623 KB logged-out JS shell from every `www.instagram.com` route, and
- from yt-dlp, the message *"Instagram sent an empty media response. Check if this
  post is accessible in your browser without being logged-in… use
  --cookies-from-browser"*.

Both of those read exactly like a login wall. They are not. The first spike here
used three invented shortcodes, concluded "Instagram is fully login-walled in
2026", and was **wrong** — the same routes returned complete captions the moment
they were pointed at real, public reels. **Before concluding Instagram has closed
a route, confirm the shortcode is real** (open it in a logged-out browser).

Known-good public fixtures used for these measurements:
`C9dO9AevUQx` (shrimp tacos, full recipe in caption), `C41MJlUSKcU`,
`Cfd5_16IGL4`.

### Comments (Osta's differentiator) — NOT yet solved

`embed/captioned` renders the caption and a *"View all N comments"* link, but not
the comment bodies. No no-auth route to comment text was found in this pass. This
is the single biggest known gap versus Osta. See `docs/NEXT_STEPS.md` — the
current mitigation is the bot's **manual-caption fallback** (reply to the failed
import with pasted text).

## 3. Structuring: Gemini, measured

The house LLM across these projects is Gemini (same provider as Media Tracker).
Measured on the shrimp-taco caption above with a strict `responseSchema`:

```
[gemini-2.5-flash] 6688 ms   tokens in/out = 399/342   → correct recipe JSON
```

Nine ingredients with quantities/units/notes and nine steps, all faithful to the
source, no invented quantities. `temperature: 0` + `responseMimeType:
application/json` + `responseSchema` gives parseable output with no prompt
gymnastics.

**Availability caveat:** `gemini-3.8-flash` returned `503 "model is currently
experiencing high demand"` on first call. The client therefore walks a **model
fallback chain** rather than pinning one model — see `lib/gemini.ts`.

## 4. Sources

- [Osta on the App Store](https://apps.apple.com/us/app/osta-save-share-recipes/id6739286231)
- [Osta on Google Play](https://play.google.com/store/apps/details?id=com.saltrecipeapp)
- [FoodiePrep — how to save recipes from Instagram](https://www.foodieprep.ai/blog/how-to-save-recipes-from-instagram)
- [yt-dlp Instagram extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/instagram.py)
- [yt-dlp issue #17074 — "empty media response" without cookies](https://github.com/yt-dlp/yt-dlp/issues/17074)
- [Scrapfly — How to Scrape Instagram in 2026](https://scrapfly.io/blog/posts/how-to-scrape-instagram)
