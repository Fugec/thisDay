# thisDay.info Maintainer Guide

Compact maintainer guide for the `thisday.info` website and automation stack.

Goal: make future edits cheaper in time and token usage by keeping the feature map, ownership boundaries, and common change points in one place.

Related docs:

- `documentation/site-architecture.md`
  Full architecture map, worker responsibilities, routes, and operational notes.

## What This Project Includes

- Daily history website with dynamic pages for:
  events, births, deaths, quizzes, blog listing/pages, RSS, sitemaps, OG images, redirects, and search pinging.
- AI-assisted blog publishing pipeline on Cloudflare Workers.
- YouTube Shorts pipeline that turns the daily blog article into a narrated video.
- Social helpers for YouTube, Pinterest, Meta, and TikTok under `youtube-upload/`.

## Repo Map

- `js/seo-worker.js`
  Main site worker. Handles most public routes, dynamic HTML, image proxying, quizzes, daily pages, blog index passthrough, and scheduled cache warming.
- `js/blog-ai-worker.js`
  Blog publishing worker. Generates and stores blog posts in KV, serves blog article routes, and backfills old stored HTML.
- `js/shared/layout.js`
  Shared nav, footer, marquee markup, and shared UI snippets for workers.
- `js/shared/ai-call.js`
  Shared AI provider wrapper for Workers AI and Groq fallback.
- `js/shared/ai-model.js`
  Resolves and refreshes the preferred Cloudflare AI model.
- `js/shared/llms-content.js`
  Single source of truth for the `/llms.txt` content served by the worker and synced to the repo file.
- `js/rss-worker.js`
  Builds RSS feed from blog KV.
- `js/sitemap-worker.js`
  Builds sitemap output including blog entries from KV.
- `js/search-ping-worker.js`
  Manual/automated search engine ping endpoint.
- `js/og-image-worker.js`
  Dynamic OG image worker.
- `js/news-sitemap-worker.js`
  News sitemap for recently published blog posts.
- `js/redirect-worker.js`
  Route-level redirect logic that runs before the SEO worker on owned routes.
- `js/warmup-worker.js`
  Pre-warms daily data.
- `youtube-upload/`
  External automation for narration, video generation, upload, tracking, and social posting.

## Website Features

### 1. Core Daily Pages

- `/events/{month}/{day}/`
  Main “On This Day” page with featured event, commentary, related actions, quiz CTA, and a same-date discovery cluster linking events/born/died/quiz pages.
- `/born/{month}/{day}/`
  Famous births for the date, plus same-date navigation back to events, deaths, and quiz.
- `/died/{month}/{day}/`
  Notable deaths for the date, plus same-date navigation back to events, births, and quiz.
- `/quiz/{month}/{day}/`
  Full standalone daily quiz page with direct same-date links to events, births, and deaths.
- `/api/quiz/{month}/{day}`
  Raw quiz JSON endpoint.
- `/events/today/`, `/born/today/`, `/died/today/`, `/quiz/`
  Redirect to the current UTC date page with `Cache-Control: no-store`.
- `/generated/{month}/{day}/`
  Legacy route that permanently redirects to the canonical `/events/{month}/{day}/` page.

### 2. Blog

- `/blog/`
  Blog listing page built from `BLOG_AI_KV` index.
- `/blog/archive/`
  Legacy alias that permanently redirects to the canonical `/blog/` listing.
- `/blog/{slug}/`
  Full blog article page stored in KV.
- `/blog/{legacy-month}/{legacy-slug}`
  Older static blog route support with runtime patching/backfill.
- Blog pages include:
  hero image, inline figures, same-date “Explore this day” cluster, related posts, book/reading block, quiz popup, floating quiz CTA, and support popup.

### 3. Quiz Features

- Daily site quiz on main event pages.
- Standalone quiz pages.
- Blog-specific quiz generation and popup rendering.
- Auto-grading quiz UI.
- Quiz schema markup for SEO.
- Scheduled quiz pre-generation and cache busting.

### 4. Image Features

- `/image-proxy` and `/img`
  Wikimedia/Wikipedia-only proxy with resizing, caching, and responsive delivery.
- Blog cards and article images are normalized through the proxy for social/SEO sizing.
- YouTube pipeline reuses article images first, then falls back to Wikipedia/Wikimedia Commons.

### 5. SEO / Discovery Features

- Dynamic meta tags and JSON-LD.
- Consistent top-level page schema plus `BreadcrumbList` structured data on events, born, died, quiz, and blog listing pages.
- RSS feed.
- XML sitemap index generation.
- Core sitemap split into `/sitemap.xml` (index) and `/sitemap-main.xml` (static pages + blog URLs).
- Dedicated date-route and people sitemaps.
- News sitemap for recent articles.
- Search engine ping endpoint.
- OG image generation worker.
- Robots handling inside `seo-worker.js`.
- Public `llms.txt` guidance for AI platforms.
- Commentary and quiz-rich daily pages designed for indexing.
- Same-date internal linking between events, born, died, quiz, and the matching daily blog story when one exists.

### 6. Social / Media Features

- YouTube Shorts generation and upload.
- Narration via ElevenLabs.
- Video scenes now use images from the post's exact Wikipedia article URL, not generic same-date site images.
- Shorts no longer upload custom YouTube thumbnails; YouTube chooses the thumbnail automatically.
- Pinterest posting helper.
- Meta and TikTok posting helpers.
- Discord notifications for failures and publish events.

## Worker Ownership

### Main Site Worker

File: `js/seo-worker.js`

Owns:

- home and date-based site routes
- born/died pages
- canonical daily events pages and legacy `/generated/` redirects
- quiz pages and quiz API
- image proxy
- `robots.txt`
- `llms.txt`
- blog index passthrough logic
- scheduled daily cache warming
- scheduled quiz generation
- search ping trigger after refresh
- blog listing discovery metadata on `/blog/`

Important versioned cache keys:

- `born-v7-{host}-{month}-{day}`
- `died-v7-{host}-{month}-{day}`
- `gen-post-v29-{host}-{month}-{day}`
- `quiz-v15:{mm}-{dd}`
- `quiz-page-v29:{mm}-{dd}`

When to edit here:

- change page routing
- change redirects
- change daily page layout
- change quiz behavior
- change image proxy behavior
- change robots rules / AI crawler policy
- change structured data / meta / sitemap-discovery behavior
- change same-date discovery clusters and matching blog-story cards on events/born/died/quiz pages

### Blog Worker

File: `js/blog-ai-worker.js`

Owns:

- scheduled blog generation
- `POST /blog/publish`
- `GET /blog/`
- `GET /blog/{slug}/`
- blog quiz generation
- blog HTML assembly
- post-publish hooks
- old post HTML repair/backfill on request

Key behavior:

- Stores posts in `BLOG_AI_KV`.
- Uses `index` and `post:{slug}` keys.
- Accepts either `PUBLISH_SECRET` or `YOUTUBE_REGEN_SECRET` for `/blog/publish`.
- Prefers topics likely to have at least 3 usable Wikipedia images.
- Two-phase generation: `pickTopic()` runs first (~120 output tokens) and
  returns only `{ eventTitle, historicalDateISO }`. The date is validated
  against today's month/day before any full-article tokens are spent. The
  picker loops until a matching date is returned, adding each wrong-date
  title to the avoid list so it is never re-picked. `callWorkersAI()` only
  runs once a valid topic is confirmed.
- Article body: at most 1 inline floated figure. `injectEventImages` bails
  immediately if a person portrait already exists; never injects more than
  one event image regardless of how many are available.
- Can patch old stored posts to:
  fix stale “Explore {Month Day} in History” links,
  normalize quiz button colors,
  backfill inline event figures,
  patch older quiz API paths.

When to edit here:

- change blog prompt/content rules
- change blog page structure
- change related posts, figures, support popup, or quiz popup
- change the same-date blog explore cluster linking to events/born/died/quiz pages
- change topic gating/image gating
- change post-publish side effects

### Shared Layout

File: `js/shared/layout.js`

Owns:

- nav HTML
- mobile nav HTML
- footer HTML
- shared site description
- nav/footer CSS fragments
- marquee HTML/script

Important note:

- If you render the marquee, include matching marquee CSS or it degrades into a large text block.

### Static Page Nav Bridge

File: `js/shared/static-layout.js`

Owns:

- shared-nav mounting for static root/about/contact/privacy/terms pages
- optional marquee initialization for static pages
- static-page mobile nav toggle wiring

Important note:

- If a static HTML page should match the live worker header, mount the shared nav here instead of copying nav markup into the page.

### Shared LLM Content

File: `js/shared/llms-content.js`

Owns:

- canonical `llms.txt` body used by the live worker
- single-source AI platform guidance text

Important note:

- The repo root `llms.txt` file is generated from this shared source with `npm run sync:llms`.
- If you update AI-facing guidance, edit this file first, then sync.

## Data / Storage

### KV Namespaces

From `wrangler.jsonc` and `wrangler-blog.jsonc`:

- `EVENTS_KV`
  Daily event data, commentary caches, canonical events-page caches, born/died page caches, and quiz caches.
- `BLOG_AI_KV`
  Blog post HTML, index, pipeline state, quiz payloads for blog posts, image/person caches.

### YouTube Upload Notes

- File ownership:
  `youtube-upload/index.js` orchestrates generation/upload/tracking.
  `youtube-upload/lib/kv.js` extracts the exact Wikipedia article URL from stored post HTML.
  `youtube-upload/lib/video.js` renders the narrated Shorts video.
- Exact article mode:
  the video pipeline now prefers the published post's dedicated source-box `Wikipedia` link, then `wikiUrl`, then `jsonLdUrl`, and only after that falls back to generic Wikipedia matches.
- URL normalization:
  non-article namespaces like `File:`, `Category:`, `Special:`, and similar wiki URLs are ignored so the renderer stays tied to a real article page.
- Image selection:
  multi-scene video generation uses only images from that exact Wikipedia article. If the article does not expose enough usable images, generation fails instead of mixing unrelated website images.
- Visual treatment:
  every static scene now gets the same layered treatment: blurred background, centered foreground card, visible shadow, border highlight, vignette, and Ken Burns motion.
- Thumbnail behavior:
  the uploader does not call YouTube thumbnail APIs anymore. Shorts rely on YouTube's automatic thumbnail/frame selection.
- YouTube description:
  `post.description` is stripped of its leading date phrase (e.g. `"On April 10, 1912, ..."` → `"..."`) before being written as the video description, so the copy reads naturally without duplicating the date already stated in the title.

### Blog KV Keys You Will See Often

- `index`
- `post:{slug}`
- `quiz-v3:blog:{slug}`
- `last_gen_date`
- `youtube:pipeline-state`

## Automation Flow

### Daily Site Flow

1. Warmup worker prepares daily data.
2. Main SEO worker scheduled task refreshes daily caches and quiz data.
3. Search ping is triggered for fresh dynamic pages.
4. Discovery surfaces stay public via `robots.txt`, sitemap endpoints, RSS, and `llms.txt`.

Discovery freshness notes:

1. `search-ping` defaults include `/sitemap.xml`, `/sitemap-main.xml`, `/sitemap-generated.xml`, `/sitemap-people.xml`, and `/news-sitemap.xml`.
2. Daily ping flows include `/events/`, `/born/`, `/died/`, and `/quiz/` for the current date.
3. `/sitemap.xml` is a sitemap index and points crawlers to `/sitemap-main.xml`, `/sitemap-generated.xml`, `/sitemap-people.xml`, and `/news-sitemap.xml`.
4. Sitemap responses use `X-Robots-Tag: noindex`.
5. `sitemap-main.xml` and dynamic blog-discovery URLs use the newer of latest post publish date or the latest site-structure SEO update.
6. Quiz page cache busting uses `quiz-page-v29`.

### Daily Blog Flow

1. Blog worker cron runs at `00:05 UTC`.
2. It chooses an event, generates article content, validates content, checks image viability, and stores the final article in `BLOG_AI_KV`.
   - Before generation, `pickTopic()` selects an event and validates its `historicalDateISO` against today's date. If the date is wrong, it loops and picks again — no full-article tokens are spent on a wrong-date topic.
3. Post-publish work runs in background:
   quiz generation, cache busting, notifications, search ping.

## Version Coupling Guide

This project has two kinds of cache/version relationships:

1. Directly shared version families inside `EVENTS_KV`
2. Cross-worker integration points where one worker does not own the cache key, but must still know which versioned key to invalidate

The important rule is:

- bump the version where the HTML or JSON shape changes
- then update every reader, writer, and deleter for that exact key family
- if another worker invalidates that cache family, update that worker too

### SEO Worker-Owned Versioned Keys

These keys are owned by `js/seo-worker.js` and stored in `EVENTS_KV`:

- `born-v7-{host}-{month}-{day}`
  Used for born-page HTML caching.
- `died-v7-{host}-{month}-{day}`
  Used for died-page HTML caching.
- `gen-post-v29-{host}-{month}-{day}`
  Used for canonical events-page HTML caching.
- `quiz-v15:{mm}-{dd}`
  Used for daily quiz JSON payload caching.
- `quiz-page-v29:{mm}-{dd}`
  Used for standalone quiz-page full HTML caching.

If any of those page structures or payload shapes change, the family should be bumped in `js/seo-worker.js`.

### Blog Worker Coupling

`js/blog-ai-worker.js` does not own the date-page cache families above, but it is coupled to one of them:

- blog post publish generates `quiz-v3:blog:{slug}` in `BLOG_AI_KV`
- `js/seo-worker.js` reads that blog quiz payload when building `/quiz/{month}/{day}/`
- because of that, `js/blog-ai-worker.js` must invalidate the current `quiz-page-v29:{mm}-{dd}` HTML cache in `EVENTS_KV` after publish

That means:

- `quiz-page-v29` is SEO-worker-owned
- but the blog worker must always delete the current version of that key family
- if `quiz-page-v29` changes again, both workers must be updated together

### Not Directly Shared, But Still Connected

These are not the same version family, but they are operationally connected:

- `index` in `BLOG_AI_KV`
  Read by blog worker routes, homepage JSON endpoints, sitemap worker, and SEO worker blog/date-link helpers.
- `quiz-v3:blog:{slug}` in `BLOG_AI_KV`
  Written by the blog worker, read by the SEO worker quiz page builder.
- `/search-ping`
  Triggered by both SEO scheduled refresh logic and blog post publish logic.
- `/sitemap.xml`, `/rss.xml`, `/news-sitemap.xml`
  Explicitly purged by blog post publish so discovery surfaces refresh immediately.

### Safe Bump Procedure

When bumping a version family:

1. Find the current key in `js/seo-worker.js`.
2. Update all matching read/write/delete references for that family.
3. Search the repo for the old version string.
4. Check whether `js/blog-ai-worker.js` invalidates that family.
5. Update `documentation/README.md` so the maintainer guide stays accurate.
6. Deploy every worker that touches the changed family.

### Current Cross-Worker Dependency To Remember

Right now the most important cross-worker dependency is:

- `js/seo-worker.js` serves and caches `/quiz/{month}/{day}/` as `quiz-page-v29:{mm}-{dd}`
- `js/blog-ai-worker.js` must delete that exact `quiz-page-v29` key after publishing a same-date blog post

If those drift apart, the quiz page can keep serving stale HTML even after a new blog quiz is generated.

### YouTube Flow

1. `youtube-upload/index.js` fetches the latest post index from KV.
2. Ensures today’s post exists, optionally triggering `/blog/publish`.
3. Builds narration from article-derived facts.
4. Generates a video from the exact Wikipedia article linked from the published post, using layered static scenes with a blurred background, fixed foreground card, timed crossfades, animated captions, and background music mixed at a constant 15%.
5. Uploads to YouTube.
6. Can continue to social platforms and tracking.

## YouTube Pipeline Notes

Directory: `youtube-upload/`

Main entry:

- `youtube-upload/index.js`

Important modules:

- `lib/video.js`
  Video generation and wiki-image selection.
- `lib/kv.js`
  Cloudflare KV REST access and blog content extraction helpers.
- `lib/elevenlabs.js`
  Narration generation.
- `lib/narration-expert.js`
  Optional text polishing helper.
- `lib/history-expert.js`
  Optional historical prompt-review helper.
- `lib/tracker.js`
  Upload tracking, quota signals, pipeline failure/success history.
- `lib/youtube.js`
  YouTube upload/auth code.
- `lib/pinterest.js`, `lib/meta.js`, `lib/tiktok.js`
  Social posting helpers.

Current media strategy:

- Multi-scene mode is wiki-first.
- It prefers images already embedded in the blog article HTML.
- It falls back to Wikipedia/Wikimedia Commons image search when needed.
- Minimum required image count comes from `WIKI_IMAGE_MIN_COUNT`, default `3`.
- The option name `USE_AI_IMAGE` is legacy naming. In current code, `USE_AI_IMAGE !== "false"` means the multi-scene wiki-image path is used.

## Environment / Secrets

### Cloudflare Workers

Common bindings:

- `EVENTS_KV`
- `BLOG_AI_KV`
- `AI`

Blog worker secrets:

- `PUBLISH_SECRET`
- `YOUTUBE_REGEN_SECRET`
- `SEARCH_PING_SECRET`
- `DISCORD_WEBHOOK_URL`
- optional Groq fallback keys for AI helper calls

SEO worker secrets/features:

- optional Groq fallback keys
- optional `SEARCH_PING_SECRET`
- optional `CF_API_TOKEN` for AI model refresh logic

Discovery behavior:

- `/robots.txt` is served by `js/seo-worker.js`
- `/llms.txt` is served by `js/seo-worker.js` from `js/shared/llms-content.js`
- AI crawler blocks in `robots.txt` still allow access to `/llms.txt`
- `/sitemap.xml` is served by `js/sitemap-worker.js` as the sitemap index
- `/sitemap-main.xml` is served by `js/sitemap-worker.js` as the core static/blog sitemap
- `/sitemap-generated.xml` and `/sitemap-people.xml` are served by `js/seo-worker.js`
- `/news-sitemap.xml` is served by `js/news-sitemap-worker.js`
- `/rss.xml` and `/feed.xml` are served by `js/rss-worker.js`

### YouTube Upload Env

Required for KV access:

- `CF_ACCOUNT_ID`
- `CF_API_TOKEN`
- `CF_KV_NAMESPACE_ID`

Required for YouTube:

- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`
- `YOUTUBE_REFRESH_TOKEN`

Required for narration:

- `ELEVENLABS_API_KEY`

Required for blog regeneration from uploader:

- `BLOG_WORKER_URL`
- `YOUTUBE_REGEN_SECRET`

Common optional vars:

- `YOUTUBE_PRIVACY`
- `WIKI_IMAGE_MIN_COUNT`
- `USE_AI_IMAGE`
- `REUPLOAD_SLUGS`
- `DISCORD_WEBHOOK_URL`

Optional expert-provider vars:

- `GROQ_API_KEY`
- `GROQ_API_KEY_2`
- `GROQ_API_KEY_3`
- `GROQ_API_KEY_4`
- `HF_TOKEN`
- `HF_TOKEN_2`
- `HF_TOKEN_3`
- `HF_TOKEN_4`

## Common Change Guide

### Change Site Navigation / Footer

- edit `js/shared/layout.js`

### Change Homepage / Daily Events Page Layout

- edit `js/seo-worker.js`

### Change Quiz Generation or Quiz UI

- daily quiz: `js/seo-worker.js`
- blog quiz: `js/blog-ai-worker.js`

### Change Blog Prompting / Topic Selection / Article HTML

- edit `js/blog-ai-worker.js`

### Change Blog Image Rules

- article generation gate: `js/blog-ai-worker.js`
- downstream video image use: `youtube-upload/lib/video.js`
- keep both aligned

### Change Video Look / Scene Selection / Captions

- edit `youtube-upload/lib/video.js`

### Change Narration Logic

- script assembly: `youtube-upload/index.js`
- provider logic: `youtube-upload/lib/elevenlabs.js`
- polishing: `youtube-upload/lib/narration-expert.js`

### Change Search Discovery / RSS / Sitemap / OG

- RSS: `js/rss-worker.js`
- sitemap: `js/sitemap-worker.js`
- search ping: `js/search-ping-worker.js`
- OG images: `js/og-image-worker.js`

## Tests / Validation

Useful commands:

```bash
npm run sync:llms
npm run check:llms

cd youtube-upload
npm run test:unit
npm run generate
npm run diagnose
```

Notes:

- `sync:llms` rewrites the repo root `llms.txt` from `js/shared/llms-content.js`.
- `check:llms` fails if `llms.txt` has drifted from the shared source.
- `test:unit` includes live-provider quiz expert tests, so failures can be caused by missing keys or blocked network, not only code regressions.
- `npm run generate` is the safest local end-to-end video test. It generates a Shorts MP4 under `youtube-upload/tmp/` and does not publish anything.
- `node --check <file>` is useful for fast syntax validation on worker and upload files.
- `npx wrangler deploy --config <file>` is the direct deploy path for each worker config in the repo root.

## Current Maintenance Notes

- Redirects to “today” pages are intentionally `no-store`.
- `/born`, `/died`, `/births`, and `/deaths` should continue redirecting to the canonical people-date routes instead of serving standalone hubs.
- Static non-blog HTML pages use `js/shared/static-layout.js` to stay aligned with the shared worker nav.
- Canonical events page cache version is currently `v29`.
- Quiz JSON cache version is currently `v15`.
- Quiz page cache version is currently `v29`.
- Born and died page caches are currently `v7`.
- Blog article generation and video generation are intentionally aligned around “image-rich Wikipedia topics”.
- `llms.txt` is intentionally public and should stay aligned with the worker-served version through `js/shared/llms-content.js`.
- Search discovery now includes the people sitemap and daily born/died URLs in ping flows.
- Date pages now include an explicit same-date discovery cluster linking events, born, died, and quiz routes.
- Canonical date pages now also link to the matching daily blog post when a same-date story exists in the blog index.
- The `/blog/` listing now exposes stronger `CollectionPage`/`ItemList` discovery metadata and a latest-publish freshness signal.
- Events, born, died, and quiz pages now expose consistent top-level page schema and `BreadcrumbList` JSON-LD alongside their route-specific schema.
- `sitemap-main.xml` freshness now follows both blog publish activity and the latest structural SEO/discovery update, not just older hard-coded dates.
- `/sitemap.xml` is now the sitemap index, with `/sitemap-main.xml` as the core child sitemap.
- `youtube-upload/test-history-expert.js` and `youtube-upload/test-narration-expert.js` are treated as local-only helper files and are ignored in git for future maintenance.

## Low-Token Editing Strategy

When asking for future changes, reference the smallest owning file and feature block possible. Good examples:

- “Update daily quiz generation in `js/seo-worker.js` only.”
- “Change blog post image gating in `js/blog-ai-worker.js` and sync `youtube-upload/lib/video.js`.”
- “Only adjust shared nav/footer in `js/shared/layout.js`.”
- “Only document env/setup changes in `documentation/README.md`.”

That keeps edits faster, safer, and cheaper.
