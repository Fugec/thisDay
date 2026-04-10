# thisday.info Site Architecture

_Last updated: April 10, 2026 (two-phase topic pick + generate; 1-figure limit in article body; exact-Wikipedia layered Shorts scenes; fixed 15% background music)._

## What Is Thisday.info

A history-focused website that presents "On This Day" events for every calendar date. The site is fully static HTML with Cloudflare Workers providing all dynamic functionality such as blog generation, SEO metadata, RSS, and sitemaps.

There is no traditional backend server. Everything runs on the Cloudflare edge.

- Domain: `https://thisday.info`
- Stack: static HTML/CSS/JS + Cloudflare Workers + Cloudflare KV

## Architecture Overview

```text
┌──────────────────────────────────────────────────────────────────────────┐
│                         thisday.info                                     │
│                                                                          │
│  Static Pages          Cloudflare Workers              External APIs     │
│  ─────────────         ──────────────────              ─────────────     │
│  index.html     ←──── seo-worker.js          ←──────  Wikipedia API     │
│  blog/          ←──── blog-ai-worker.js       ←──────  CF Workers AI    │
│  about/                rss-worker.js          ←──────  ElevenLabs TTS   │
│  about/editorial/      sitemap-worker.js       ←──────  YouTube API      │
│  contact/              og-image-worker.js      ←──────  Pollinations AI  │
│  privacy-policy/       redirect-worker.js              HuggingFace AI    │
│  terms/                search-ping-worker.js           Groq LLM API      │
│                         warmup-worker.js                                 │
│                                                                          │
│  Client-Side           Shared Modules                                    │
│  ─────────────         ──────────────────                                │
│  js/script.js          js/shared/ai-call.js   ← AI text generation      │
│  js/chatbot.js         js/shared/ai-model.js  ← model auto-update       │
│                         js/shared/layout.js    ← navbar/footer/CSS       │
│                         js/shared/static-layout.js ← static nav bridge   │
│                                                                          │
│  Automation            Scripts (local tools)                             │
│  ─────────────         ──────────────────                                │
│  GitHub Actions  →  youtube-upload pipeline  →  YouTube Shorts          │
│  Mac social-cron →  lib/meta.js (OpenClaw)   →  Facebook/Instagram      │
│                  →  lib/tiktok.js (OpenClaw)  →  TikTok                  │
│                     scripts/wikipedia-links.js → Wikipedia ext. links    │
│                     scripts/check-blog-images.js → image audit           │
└──────────────────────────────────────────────────────────────────────────┘
```

Data storage: Cloudflare KV, globally edge-cached.

- `EVENTS_KV` → Wikipedia daily events cache + quiz cache (`quiz:MM-DD`)
- `BLOG_AI_KV` → AI blog posts, index entries, and blog quizzes

YouTube pipeline notes:

- `youtube-upload/lib/kv.js` resolves the exact Wikipedia article URL from stored post HTML.
- `youtube-upload/lib/video.js` now applies the same layered visual treatment to all static scenes:
  blurred background, centered foreground card, visible shadow/border, vignette, and Ken Burns motion.
- `youtube-upload/index.js` no longer uploads custom YouTube thumbnails; Shorts rely on YouTube's automatic thumbnail/frame selection.

Related docs:

- `documentation/README.md` → compact maintainer guide
- `documentation/test-suite-guide.txt` → test coverage and feature-flow map
- `documentation/youtube-upload-architecture.txt` → YouTube pipeline architecture
- `documentation/youtube-upload-runbook.txt` → step-by-step pipeline runbook

Working rule:

- Read the relevant docs first to get the full structure and flow.
- Then open only the specific file(s) that need editing.
- Keep the change narrow so the edit stays easy to review.

## CLOUDFLARE WORKERS — FULL LIST

1. ## SEO WORKER (wrangler.jsonc → js/seo-worker.js)

   The main entry point for all traffic to thisday.info.
   Acts as a reverse proxy / middleware layer:
   - Injects SEO meta tags (title, description, og:image, canonical)
   - Adds Schema.org JSON-LD structured data (WebPage/CollectionPage, Article, FAQ, Quiz, Person)
   - Fetches Wikipedia "On This Day" events and serves them as JSON
   - Adds security headers (CSP, X-Frame-Options, etc.)
   - Serves the static HTML pages from the origin (GitHub Pages / CF Pages)
   - Generates /born/{month}/{day}/ pages (famous birthdays, Person schema)
   - Generates /died/{month}/{day}/ pages (notable deaths, Person schema)
   - Generates /quiz/{month}/{day}/ pages (daily history quiz, Quiz schema)
   - Generates /events/{month}/{day}/ pages with embedded quiz widget
   - Serves /image-proxy endpoint for optimized Wikipedia image delivery
   - Serves people and generated sitemaps (born/died/events/quiz URLs)
   - Adds same-date discovery clusters across events/born/died/quiz pages
   - Links canonical date pages to the matching daily blog story when one exists
   - Emits top-level page schema plus BreadcrumbList JSON-LD across events, born, died, and quiz pages
   - Renders stronger collection metadata on the main /blog/ listing page
   - Keeps legacy `/generated/` URLs redirected permanently to canonical `/events/` pages
   - Editorial commentary (era-aware: ancient/medieval/modern/contemporary)
     Bindings: EVENTS_KV, BLOG_AI_KV, AI

   Key routes:
   GET /events/{month}/{day}/ → daily events page with quiz widget
   GET /born/{month}/{day}/ → famous birthdays for that date
   GET /died/{month}/{day}/ → notable deaths for that date
   GET /quiz/{month}/{day}/ → standalone quiz page
   GET /quiz/ or /quiz → 302 redirect to today's quiz
   GET /api/events/{MM}/{DD} → JSON API for events
   GET /api/quiz/{month}/{day} → JSON API for quiz data
   GET /image-proxy?url=... → resized/cached Wikipedia images
   GET /sitemap-people.xml → sitemap for born/died pages
   GET /sitemap-generated.xml → sitemap for canonical events and quiz date pages
   GET /blog/ → blog listing with collection metadata
   GET /generated/{month}/{day}/ → legacy 301 redirect to /events/{month}/{day}/

2. ## BLOG AI WORKER (wrangler-blog.jsonc → js/blog-ai-worker.js)

   Generates AI-written blog posts on a daily cron schedule (00:05 UTC).
   Uses Groq (Llama 3.3-70b, primary) → CF Workers AI (fallback) to write
   a 1,500+ word article about a historical event relevant to today's date.
   Each post includes: title, description, body HTML, "Did You Know?" bullets,
   "Quick Facts" table, Wikipedia-sourced image, quiz, editorial note, and a
   same-date explore cluster linking back to the date routes.

   GENERATION PIPELINE (in order):
   1. fetchContextHook() — short AI call (~120 tokens): returns one
      sentence grounding the article in the
      current year (anniversary, modern parallel).
      Injected into main prompt as mandatory context.
   2. pickTopic() — cheap pre-generation call (~120 output tokens):
      asks AI for just { eventTitle, historicalDateISO }.
      Validates that historicalDateISO month/day matches the
      target date before any generation tokens are spent.
      Loops indefinitely on wrong-date picks, adding each
      rejected title to extraAvoid so it is never re-picked.
      When forcedEvent is set, skips the picker entirely.
   3. callWorkersAI() — main generation: 1,500+ word article in
      structured JSON (title, paragraphs, quotes,
      analysis, editorialNote, contentRationale).
      Receives the pre-validated topic as forcedEvent so
      the AI writes about the confirmed date-correct event.
      Pillar depth rotation: tracks underrepresented
      pillars in last 30 posts; passes 3 preferred
      pillars to topic selection prompt.
   4. reviewContentWithSEOExpert() — SEO review pass: improves meta fields,
      descriptions, keywords, sentence structure.
   5. factCheckContent() — verifies event date/year/location; applies
      confident corrections in-place.
   6. validateEyewitnessQuote() — AI-confirms quote against documented source;
      clears both fields if unverified (prevents
      fabricated quotes attributed to real people).
   7. classifyPillars() — assigns 1–3 content pillars from BLOG_PILLARS
      (12 pillars); stored in KV index metadata.
   8. Image resolution loop — validates Wikipedia image URL; on failure
      adds topic to extraAvoid and continues (re-picks topic from step 2).
   9. generateEditorialNote() — separate isolated AI call (~300 tokens):
      reads the finished article, writes a 100–150
      word opinion note that MUST reference something
      from the current year. Replaces the same-pass
      editorialNote from step 3.
   10. buildPostHTML() — renders full article HTML with pillar-filtered
      "You Might Also Like", BreadcrumbList JSON-LD,
      AI disclosure block, and VideoObject schema
      (injected at serve time when YouTube ID exists).

   CONTENT PILLARS (BLOG_PILLARS — 12 categories):
   War & Conflict, Politics & Government, Science & Technology,
   Arts & Culture, Disasters & Accidents, Social & Human Rights,
   Economy & Business, Health & Medicine, Exploration & Discovery,
   Famous Persons, Born on This Day, Died on This Day.
   Mirror the 10 modal filter categories in script.js + Born/Died.

   PUBLISH PATTERN (P2c — anti-spam-signal):
   Day-of-week aware skip. YouTube days (Mon/Tue/Thu/Fri) always generate
   because the 01:00 UTC upload pipeline depends on the post existing.
   Non-YouTube days (Wed/Sat/Sun) skip with 35% probability (SKIP_PROBABILITY).
   Cron schedule (5 0 \* \* \*) is unchanged. YouTube YOUTUBE_REGEN_SECRET
   fallback still fires if a post is missing on a YouTube day.

   TRUST & COMPLIANCE (P1):
   Every article includes an AI disclosure block linking to /about/editorial/.
   Byline links to /about/editorial/ (not /about/).
   Eyewitness quotes are AI-verified before publish; cleared if unconfirmed.

   TOPICAL AUTHORITY (P2):
   contentRationale field (min 40 words) stored in KV index metadata.
   Pillar depth rotation prevents War & Conflict / Politics dominance.

  INTERNAL LINKING (P3):
     "You Might Also Like" sorted by pillar overlap (not publish date).
     BreadcrumbList JSON-LD: thisDay. > Historical Blog > [Pillar] > [Article].
     Author JSON-LD: Organization type, URL /about/editorial/.
     Same-date blog explore cluster links each post back to /events/, /born/,
     /died/, and /quiz/ for that article's date.

   HUB PAGES (P3b):
   GET /blog/topic/:pillar-slug/ — 12 pillar hub pages served by this worker.
   Reads KV index, filters by pillar, renders article list + pillar description.
   CollectionPage + BreadcrumbList JSON-LD. Invalid slug → 404.

   Quiz generation: generateBlogQuiz() produces a 5-question multiple-choice
   quiz from the post content, stored in KV as quiz:blog:{slug}. Appears as a
   scroll-to-bottom popup (IntersectionObserver on #tdq-sentinel).

   Duplicate topic prevention: all-time published titles passed to AI prompt
   as a "do NOT repeat" list with semantic avoidance rules (person, war, event
   type, region/era constraints).

   Pipeline failure tracking:
   If all generation attempts fail, records failure in youtube:pipeline-state
   KV key (shared with YouTube uploader) so Discord alerts stay in sync.

   Post storage in KV:
   - "index" → JSON array of all post metadata
     Each entry: slug, title, description, imageUrl,
     publishedAt, pillars[], contentRationale
   - "post:{slug}" → full post HTML body
   - "dyk:{slug}" → Did You Know bullet items (array)
   - "qf:{slug}" → Quick Facts rows (array)
   - "quiz:blog:{slug}" → blog post quiz (5 questions, JSON)
   - "youtube:pipeline-state" → shared failure/quota state with YouTube uploader

   Cross-worker cache coupling:
   The blog worker writes same-date blog quiz payloads into `BLOG_AI_KV`, while
   the SEO worker reads those payloads when rendering `/quiz/{month}/{day}/`.
   Because of that, blog publish hooks must invalidate the SEO worker's current
   quiz-page HTML cache version in `EVENTS_KV` whenever a new same-date post is
   published.

   YouTube/video source coupling:
   published posts carry the canonical article source URL used by the external
   `youtube-upload` pipeline. The uploader now prefers the explicit source-box
   Wikipedia link, then `wikiUrl`, then `jsonLdUrl`, and generates scenes only
   from that exact Wikipedia article instead of reusing mixed website images.

   Routes:
   GET /blog/ → listing page (all published posts)
   GET /blog/index.json → canonical JSON index for homepage/blog UI consumers
   GET /blog/archive.json → legacy alias for the same JSON index
   GET /blog/{slug}/ → individual post page (served from KV)
   GET /blog/topic/:pillar-slug/ → pillar hub page (12 hubs, P3b)
   GET /blog/quiz/{slug} → quiz JSON for a blog post
   GET /blog/quiz-debug/{slug} → debug facts sent to quiz AI
   POST /blog/publish → manual trigger (Bearer: PUBLISH_SECRET)
   POST /blog/backfill-pillars → classify all existing posts (Bearer auth)
   POST /blog/preload-quizzes → batch quiz generation for existing posts
   POST /blog/purge-cache → purge CF cache for all post URLs
   POST /blog/regen-seo → re-run SEO review on a post
   POST /blog/regen-humanize → re-run humanization on a post

   Manual publish:
   curl -X POST https://thisday.info/blog/publish \
    -H "Authorization: Bearer {PUBLISH_SECRET}"

   Backfill pillar classification (run once after adding BLOG_PILLARS):
   curl -X POST https://thisday.info/blog/backfill-pillars \
    -H "Authorization: Bearer {PUBLISH_SECRET}"
   Add ?all=true to reclassify posts that already have pillars.

3. ## RSS WORKER (wrangler-rss.jsonc → js/rss-worker.js)

   Serves /rss.xml — a valid RSS 2.0 feed of recent blog posts.
   Reads from BLOG_AI_KV index. Useful for RSS readers and Google Discover.

4. ## SITEMAP WORKER (wrangler-sitemap.jsonc → js/sitemap-worker.js)

   Serves:
   - /sitemap.xml → sitemap index
   - /sitemap-main.xml → core sitemap (static pages + published blog posts)
     Reads post slugs from BLOG_AI_KV index.
     Static pages include: core pages, /about/editorial/, 12 pillar hub URLs
     (/blog/topic/:slug/ — priority 0.7/0.6, changefreq weekly).
     Public archive-style references now point to canonical `/blog/`; legacy
     `/blog/archive/` remains only as a redirect alias handled by the blog worker.
     Blog-related hub URLs now inherit dynamic freshness from the latest publish
     date, and core discovery URLs use the newer of latest publish date or the
     latest site-structure SEO update instead of relying only on older hard-coded
     lastmod values.

5. ## NEWS SITEMAP WORKER (wrangler-news-sitemap.jsonc → js/news-sitemap-worker.js)

   Serves /sitemap-news.xml — Google News sitemap format.
   Only includes posts published within the last 2 days (News sitemap requirement).

6. ## OG IMAGE WORKER (wrangler-og.jsonc → js/og-image-worker.js)

   Serves /og/{slug}.png — dynamically generated Open Graph images.
   Used in social media share previews for blog posts.
   Rendered via Cloudflare Workers (canvas-like generation).

7. ## REDIRECT WORKER (wrangler-redirect.jsonc → js/redirect-worker.js)

   Handles legacy URL redirects and canonical URL enforcement.
   E.g. www → non-www, HTTP → HTTPS, trailing slash normalization.

8. ## SEARCH PING WORKER (wrangler-search-ping.jsonc → js/search-ping-worker.js)

   Records sitemap submission intent and can send IndexNow URL batches when a
   new post is published.
   Triggered after blog-ai-worker successfully creates a new post.
   Default sitemap submissions include:
   - /sitemap.xml
   - /sitemap-main.xml
   - /sitemap-generated.xml
   - /sitemap-people.xml
   - /news-sitemap.xml
     Daily ping flows also include the current /events/, /born/, /died/, and
     /quiz/ routes so fresh date pages are rediscovered quickly.

9. ## WARMUP WORKER (wrangler-warmup.jsonc → js/warmup-worker.js)

   Warms up CF cache by pre-fetching key pages on a cron schedule.
   Prevents cold starts / cache misses for the first visitor of the day.

10. ## YOUTUBE UPLOAD PIPELINE (youtube-upload/)
    Runs from GitHub Actions and uploads exactly one Shorts video per day.
    The pipeline is intentionally narrow now:
    - Only the current UTC day’s slug is eligible for upload
    - If today’s post is missing, the job triggers /blog/publish once
    - If today’s post is still missing after regeneration, the job stops
    - No fallback upload of older posts or “next available” content
    - A KV-backed lease (`youtube:upload-lock`) prevents overlapping runs
    - Preflight checks verify KV read/write access and YouTube auth before work starts
    - Failure state is recorded in shared pipeline KV so repeated-day failures can alert
    - Quota/rate-limit signals are tracked for Groq, Hugging Face, ElevenLabs, and YouTube
    - The YouTube tracker is updated only after a successful upload

Key files:
index.js → main coordinator for today-only selection
lib/tracker.js → youtube:uploaded state + upload lock helpers
→ shared pipeline-state + failure/quota tracking
lib/youtube.js → YouTube Data API v3 upload helper
→ title format: "<Event> | On This Day: <Month Day, Year>"
→ description: post.description with leading date phrase stripped
   (e.g. "On April 10, 1912, ..." → "...") so copy reads naturally
lib/music.js → background music helper (assets/background.mp3 at 15% vol)
→ video generates silently if file is absent
lib/notify.js → Discord webhook notifications: upload success + pipeline alerts
lib/elevenlabs.js → ElevenLabs TTS narration (key 1 → key 2 → silent fallback)
→ uses the with-timestamps endpoint so video captions can sync to word timings
lib/narration-expert.js → Groq/HF rewrite of DYK items for engaging TTS
→ Groq fallback: GROQ_API_KEY 1→2→3→4; model auto-resolved via model-resolver.js
→ HF fallback: HF_TOKEN 1→2→3; model auto-resolved via model-resolver.js
lib/history-expert.js → Groq/HF review of AI image prompts for historical accuracy
→ same provider/model resolution chain as narration-expert.js
lib/model-resolver.js → auto-resolves best available free model for Groq and HuggingFace
→ Groq: queries /v1/models, picks free tier first (llama-3.3-70b-versatile default)
→ HF: queries api/models?inference=warm, picks free instruct model first
→ both fall back to scoring if no known-free model is available
→ cached in memory for the full pipeline run (one API call per provider)
lib/video.js → MP4 assembly for exact-Wikipedia Shorts
→ resolves the canonical article URL from stored post HTML
→ uses only images from that exact article; fails fast if too few usable images exist
→ each scene renders as a layered composition: blurred zooming background + fixed foreground card
→ scene changes follow narration boundaries and use gentle fade transitions only
→ caption PNGs are overlaid with a short slide-up entry motion
→ quality-check retries now change render tuning instead of repeating the same output
lib/video-quality.js → ffprobe technical gate + Claude Haiku visual quality gate (score/retry)
→ Claude Haiku check requires ANTHROPIC_API_KEY (not in GH Actions workflow
as of April 2026 — technical ffprobe checks still run)
lib/meta.js → OpenClaw automation for Meta (Facebook/Instagram)
lib/tiktok.js → OpenClaw automation for TikTok
lib/kv.js → Cloudflare KV REST client + health probe
lib/social-login.js → one-time browser session login helper
scripts/social-cron.js → posts to Meta/TikTok after YouTube is public

GitHub Actions:
.github/workflows/youtube-upload.yml - schedule: Mon/Tue/Thu/Fri at 01:00 UTC only - concurrency group: youtube-upload - manual workflow_dispatch supported

Operational rules: - The job will never upload more than one video in a run - Re-uploading is only for explicit manual/recovery use via REUPLOAD_SLUGS - If the tracker already contains today’s slug, the run exits cleanly - The job uses UTC day boundaries; local time is never used for selection - If KV or YouTube auth is broken, the run fails fast before generating video output - Consecutive blog/upload failures send a Discord alert when configured - Quota warnings are logged instead of silently swallowing provider limits

Shared pipeline state: - youtube:pipeline-state → failure streaks, alert timestamps, and quota counters - Used by both blog-ai-worker.js and the YouTube uploader so alerts stay in sync

Future-proofing principles: - Keep selection, retry, and recovery rules owned by our code, not the provider. - Update docs and tests before widening behavior or adding new branches. - Prefer explicit config, versioned keys, and narrow edits over implicit coupling. - Keep third-party service limits in mind, but make our own flow deterministic.

Quick checklist: - Read the docs first, then edit only the needed file(s). - Keep UTC/today-only selection rules unchanged unless deliberately redesigned. - Preserve the lock, preflight, and recovery flow when changing the pipeline. - Add or update tests when behavior changes, even if the change is small.

Local video smoke test:
- `cd youtube-upload && npm run generate`
- Saves a local MP4 into `youtube-upload/tmp/` for inspection
- Does not publish to YouTube or socials

## DEPLOYING A WORKER

Each worker has its own wrangler-\*.jsonc config file.

Deploy a specific worker:
npx wrangler deploy --config wrangler-blog.jsonc
npx wrangler deploy --config wrangler.jsonc (SEO worker)
npx wrangler deploy --config wrangler-rss.jsonc
npx wrangler deploy --config wrangler-sitemap.jsonc
(etc.)

Dev mode (local tunnel):
npx wrangler dev --config wrangler-blog.jsonc

View live logs:
npx wrangler tail --config wrangler-blog.jsonc

KV operations:
npx wrangler kv:key list --binding BLOG_AI_KV --config wrangler-blog.jsonc
npx wrangler kv:key get "index" --binding BLOG_AI_KV --config wrangler-blog.jsonc

## STATIC SITE STRUCTURE

Root (htdocs/):
index.html Main page — daily events for today's date
about/index.html About page
about/editorial/index.html Editorial standards + AI methodology page (P1b)
→ byline on every blog article links here
→ satisfies Google E-E-A-T "Who/How/Why" framework
contact/index.html Contact page
blog/index.html Legacy static blog listing shell
privacy-policy/ Privacy policy
terms/ Terms of service
css/style.css Global stylesheet
js/script.js Client-side JavaScript (calendar, modals, theme)
js/chatbot.js AI chatbot for historical event exploration
js/shared/ Shared modules used by all workers:
ai-call.js AI text generation (Groq → CF Workers AI fallback)
ai-model.js Model auto-update (checks latest CF AI model)
layout.js Shared navbar, footer, CSS, site description
manifest.json PWA manifest
sw.js Service Worker (offline support)
robots.txt Search engine directives
sitemap.xml Sitemap index (worker-generated)
sitemap-main.xml Main content sitemap (worker-generated)
ads.txt AdSense publishers file
llms.txt LLM guidance file (attribution, content structure)
CNAME GitHub Pages custom domain (thisday.info)

Scripts (local tools — not deployed):
scripts/wikipedia-links.js Wikipedia external link bot
scripts/check-blog-images.js Blog image audit/fix tool

Tests (local only — in .gitignore):
tests/routes.test.js Route regex + validation tests
tests/modal-links.test.js Client-side URL + data processing tests
tests/schema.test.js JSON-LD schema generation tests
tests/sitemap.test.js Sitemap XML generation tests
tests/deploy-checklist.test.js Pre-deployment verification checklist

Blog posts:
blog/{month}/{day}-{year}/index.html
e.g. blog/march/19-2026/index.html
Generated by blog-ai-worker, served as static HTML from CF Pages/GitHub.

## QUIZ SYSTEM

Two independent quiz systems serve different content areas:

1. EVENTS PAGE QUIZZES (seo-worker.js)
   Generated during the daily cron (handleScheduledEvent) for each date.
   Stored in EVENTS_KV as "quiz:MM-DD" (permanent TTL — history doesn't change).
   5 multiple-choice questions about a featured historical event.
   Embedded inline on /events/{month}/{day}/ pages after the featured card.
   Also served as a standalone page at /quiz/{month}/{day}/.
   JSON API: GET /api/quiz/{month}/{day}
   Schema: @type Quiz injected on both events and standalone quiz pages.
   Fallback: buildFallbackQuiz() generates year-based questions when AI fails.

2. BLOG POST QUIZZES (blog-ai-worker.js)
   Generated after each blog post is created (generateBlogQuiz).
   Stored in BLOG_AI_KV as "quiz:blog:{slug}".
   Delivered as a scroll-to-bottom popup (IntersectionObserver on #tdq-sentinel).
   JSON API: GET /api/blog-quiz/{slug}
   Admin: POST /blog/preload-quizzes to batch-generate for existing posts.
   Debug: GET /blog/quiz-debug/{slug} to inspect facts sent to AI.

Quiz KV schema:
{ version, date, topic, sourceEvent, generatedAt, difficulty,
questions: [{ id, question, options[], correctIndex, explanation }] }

AI prompt produces exactly 5 questions, each with 4 options (A/B/C/D),
0-based correctIndex, and a 1-2 sentence explanation.

## CHATBOT

js/chatbot.js — AI chatbot for historical event exploration.
Client-side only — no server-side AI calls.

Features: - Modal UI with message history and typing indicator - Robust date parsing from natural language queries - Contextual responses based on user input - Calendar integration: navigates or redirects to the relevant date page - Exported as initChatBot() for use from script.js

## SHARED MODULES (js/shared/)

Four shared modules support shared rendering and static-page consistency:

1. ai-call.js — callAI(env, prompt, options)
   Universal AI text generation helper.
   Provider fallback: Groq (Llama 3.3-70b) → CF Workers AI.
   Used by blog-ai-worker and seo-worker for all AI text generation.

2. ai-model.js — getModelName(env), refreshModel(env)
   Auto-detects and caches the latest available CF Workers AI model.
   Model name stored in KV + in-memory cache.
   Ensures workers always use the newest model without manual updates.

3. layout.js — getSharedPageStyles(), getSharedPageScripts(), siteNavbar(),
   siteFooter(), siteDescription
   Shared HTML layout components for all worker-generated pages.
   Ensures consistent navbar, footer, CSS, and branding across:

4. static-layout.js — mountStaticNav()
   Shared static-page nav bridge used by index/about/contact/privacy/terms.
   Initializes the same shared nav on static HTML pages and can optionally
   initialize the marquee there too. Static pages should not also re-run a
   second marquee bootstrap after this module has already initialized it.
   - Events pages, Born/Died pages, Quiz pages, Blog posts

## BORN / DIED PAGES

Dedicated pages for famous birthdays and notable deaths on each date.
Generated by seo-worker.js (handleBornPage / handleDiedPage).

Routes:
/born/{month}/{day}/ → e.g. /born/march/21/
/died/{month}/{day}/ → e.g. /died/march/21/

Features: - Person schema (JSON-LD) for each individual - ItemList schema with up to 10 displayed items - FAQPage schema with curated questions - Wikipedia image proxy integration - Prev/next day navigation - KV caching for performance - Sitemap coverage: 732 born + 732 died URLs in sitemap-people.xml

## SOCIAL POSTING PIPELINE (youtube-upload/)

After each YouTube Short goes public, the same video is auto-posted to
Facebook, Instagram, and TikTok via OpenClaw browser automation.
Runs on the local Mac (not Cloudflare) because social platforms block
programmatic/API posting without a verified business account.

Components:
lib/meta.js OpenClaw automation for Meta Business Suite
→ Uploads Reel (Facebook + Instagram)
→ Uploads Story (Facebook + Instagram)
→ Human-like jittered delays throughout
→ Env flags: META_SKIP_FACEBOOK, META_SKIP_STORY,
META_STORY_ONLY, META_DRAFT, META_DEBUG
lib/tiktok.js OpenClaw automation for TikTok Creator Portal
→ Uploads video, fills caption, clicks Post
→ Env flag: TIKTOK_SKIP
lib/tracker.js KV tracker for upload + social post state
→ markSocialPosted() writes metaPostedAt/tiktokPostedAt
scripts/social-cron.js Mac cron script (runs Mon/Tue/Thu/Fri 14:05 + 16:05 UTC)
→ Checks YouTube Data API for real publishedAt
→ Posts only after video confirmed public 5+ min
→ Never retries already-posted slugs
→ Re-schedules Mac wake events after each run
→ Sleeps Mac if it was woken by pmset alarm
scripts/schedule-wake.sh Sets pmset RTC wake events for upcoming cron days
→ Days: Mon/Tue/Thu/Fri
→ Wake times: 13:58 + 15:58 UTC (2 min before cron)
lib/social-login.js One-time login helper — saves browser session
→ npm run login facebook (or tiktok)

Mac prerequisites:
sudo pmset -c sleep 0 Disable system sleep on AC power (display can sleep)
sudo bash scripts/schedule-wake.sh Bootstrap pmset wake schedule
crontab entry:
5 14 \* _ 1,2,4,5 node scripts/social-cron.js >> /tmp/social-cron.log 2>&1
5 16 _ \* 1,2,4,5 node scripts/social-cron.js >> /tmp/social-cron.log 2>&1

Bot detection mitigation: - jitter(base, ±25%) on all sleep durations - humanPause() 400–900ms random pause before each UI interaction - Randomised AppleScript delays in file picker automation - OpenClaw browser profiles persist cookies/sessions across runs

## UTILITY SCRIPTS (scripts/)

Local command-line tools — not deployed, not committed to repo.

1. scripts/wikipedia-links.js
   Adds thisday.info external links to Wikipedia date articles.
   Uses Wikipedia API with bot credentials (account: Fugec).
   Supports --live (edits) and dry-run modes.
   Can target specific months/days via CLI flags.
   Rate-limited per Wikipedia guidelines.

2. scripts/check-blog-images.js
   Audits all blog HTML files for valid/reachable images.
   Recursively finds blog index.html files.
   Supports --fix flag to auto-correct missing images.
   Checks URL reachability via HTTP fetch.

## CONTENT GENERATION FLOW

    Daily automated content cycle (all times UTC, Mon/Tue/Thu/Fri):

    T=00:05 — blog-ai-worker cron fires (Cloudflare Worker)
       → Day-of-week check: Wed/Sat/Sun skip with 35% probability (P2c)
          Mon/Tue/Thu/Fri always generate (YouTube pipeline dependency)
       → Pillar depth rotation: tallies pillars in last 30 posts,
          passes 3 underrepresented pillars as preferred topics to AI
       → fetchContextHook(): 1 AI call — "why is this event relevant in 2026?"
       → callWorkersAI(): main article generation (1,500+ words, JSON output)
       → reviewContentWithSEOExpert(): meta/keyword/sentence improvements
       → pickTopic(): cheap call — picks event + ISO date, loops until date matches today
       → callWorkersAI(): full article generation with pre-validated topic
       → factCheckContent(): verifies date/year/location; corrects in-place
       → validateEyewitnessQuote(): clears fabricated quotes before publish
       → classifyPillars(): assigns 1–3 pillars; stored in KV index
       → Image resolution: validates Wikipedia image URL; retries if broken
       → generateEditorialNote(): 2nd isolated AI call — year-anchored opinion
       → buildPostHTML(): renders full HTML with disclosure block, breadcrumbs,
          pillar-filtered related posts, CollectionPage + BreadcrumbList JSON-LD
       → Stores post in KV (index + dyk + qf + post body)
       → Generates blog quiz (5 questions) → stores as quiz:blog:{slug}
       → Pings search engines via search-ping-worker

     seo-worker cron also fires (handleScheduledEvent):
       → Fetches Wikipedia events for today's date
       → Generates events page quiz → stores as quiz:MM-DD in EVENTS_KV
       → KV version-gated cache invalidation ensures fresh content

    T=00:35 — blog-failsafe GitHub Action fires
       → Checks if today's post exists in KV
       → If missing: triggers POST /blog/publish as a last-resort retry

    T=00:58 — Mac auto-wakes (pmset scheduled RTC alarm)

T=01:00 — GitHub Actions youtube-upload cron fires (single run)
→ Ensures today's post exists in KV; generates it once if missing
→ Claims youtube:upload-lock before generating video
→ Uploads only today's slug, never older backlog items
→ Stores video ID back in KV (key: youtube:uploaded)
→ Blog post page now embeds the YouTube Short + VideoObject JSON-LD
→ Posts Discord notification: title, YouTube link, article link

    T=14:05 — Mac social-cron fires (scripts/social-cron.js)
       → Reads KV tracker for videos not yet posted to socials
       → Calls YouTube Data API to verify video is public + get publishedAt
       → Waits for 5+ min after YouTube confirms public status
       → Downloads video from YouTube via yt-dlp
       → Posts to Facebook Reels + Story via OpenClaw browser automation
       → Posts to Instagram Reels + Story via OpenClaw browser automation
       → Posts to TikTok via OpenClaw browser automation
       → Marks metaPostedAt / tiktokPostedAt in KV (no retries after)
       → Re-schedules next pmset wake events (schedule-wake.sh)
       → Returns to sleep if Mac was woken by pmset alarm (not user)

    T=15:58 — Mac auto-wakes (fallback pmset alarm, in case social posting needs a second pass)

    T=16:05 — Mac social-cron fallback fires
       → Same flow as T=14:05; skips slugs already posted

On-demand — warmup-worker cron fires
→ Pre-fetches homepage and recent blog posts
→ Warms CF cache so visitors get fast responses

## SECRETS & CREDENTIALS

Local: youtube-upload/.env (never committed — in .gitignore)
CI: GitHub Actions Secrets (Settings → Secrets and variables → Actions)

See documentation/youtube-upload-architecture.txt and documentation/youtube-upload-runbook.txt for the current YouTube pipeline details.

Cloudflare credentials are also stored in wrangler.toml / wrangler-\*.jsonc
(KV namespace IDs are not secret, just configuration).

## THIRD-PARTY SERVICES USED

Service Plan Purpose
─────────────────────────────────────────────────────────────────────────────
Cloudflare Workers Free All server-side logic
Cloudflare KV Free Data storage (posts, events, quizzes)
Cloudflare Workers AI Free Blog/quiz text generation (fallback)
Groq Free Primary LLM for text generation (Llama 3.3-70b)
GitHub Actions Free CI/CD + YouTube upload automation
GitHub Pages Free Static file hosting (optional fallback)
ElevenLabs Free (10k) TTS voiceover for YouTube videos
Pollinations.AI Free Primary AI image generation (flux→flux-2-dev→z-image-turbo)
HuggingFace Free (1k/d) AI image fallback (FLUX.1-schnell, needs HF_TOKEN)
YouTube Data API v3 Free Video upload + channel management
Wikipedia API Free Historical event data + images
Google AdSense Revenue Display advertising
Discord Webhooks Free Upload notifications (DISCORD_WEBHOOK_URL)

## MONITORING & DEBUGGING

Check if blog worker is generating posts:
curl https://thisday.info/blog/ | grep "article-title"

Force a new post right now:
curl -X POST https://thisday.info/blog/publish \
 -H "Authorization: Bearer {YOUTUBE_REGEN_SECRET}"

Check KV index:
npx wrangler kv:key get "index" --binding BLOG_AI_KV --config wrangler-blog.jsonc

Check YouTube upload history:
cat youtube-upload/assets/social-posted.json

View GitHub Actions runs:
https://github.com/{owner}/{repo}/actions/workflows/youtube-upload.yml

Worker logs (last 30 mins):
npx wrangler tail --config wrangler-blog.jsonc
