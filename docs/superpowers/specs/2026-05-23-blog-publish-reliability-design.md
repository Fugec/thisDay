# Blog Publish Reliability Fix — Design Spec

**Date:** 2026-05-23  
**Status:** Approved  
**Scope:** `js/blog-ai-worker.js`, `wrangler-blog.jsonc`

---

## Problem

The May 23 2026 article was not published automatically. Root cause: two compounding failures.

### Root Cause 1 — Subrequest budget exhaustion

`ctx.waitUntil` does **not** provide a fresh subrequest budget. All promises registered with `ctx.waitUntil` share the same 50-subrequest pool as the main invocation. The AI content generation step consumes ~40+ subrequests over ~75 minutes. When `enrichPublishedPost` then tries to fetch entity data from Wikipedia and book covers from Open Library, there are no subrequests left. Both calls fail silently (`.catch(() => [])`) and return empty arrays.

### Root Cause 2 — Hard completeness check blocks publish

`assertPublishedArticleCompleteness` (added in the most recent deploy) treats missing entity strip images and missing Amazon cover images as hard errors that throw and prevent publication. Because the enrichment network calls failed silently, the generated article had no entity strip and only fallback Amazon cards — triggering the hard error on all 3 retry attempts.

**Pipeline state recorded:**
```
lastFailureMessage: "Draft enrichment failed: Article completeness check failed:
  missing people entity strip; Amazon recommendation cards have 0/3 real cover image(s)"
```

The draft `23-may-2026` (Battle of Inverurie) was successfully saved to KV at 01:19 UTC and remains intact.

---

## Solution — Approach B

Two changes applied together. One fixes the root cause; the other provides defense in depth.

---

## Section 1: Self-subrequest Enrichment

### Current (broken) flow

```
scheduled cron
  └─ ctx.waitUntil(maybeGenerateBlogPost)          ← same 50-subrequest budget
       └─ generateAndStore (~40+ subrequests used)
            └─ ctx.waitUntil(runPostPublishExtras)  ← budget exhausted
                 └─ enrichPublishedPost → silently fails
```

### Proposed flow

```
scheduled cron
  └─ ctx.waitUntil(maybeGenerateBlogPost)
       └─ generateAndStore
            ├─ saves draft to KV
            └─ ctx.waitUntil(
                 selfEnrichFetch(env, slug)
                 → fetch('https://thisday.info/blog/enrich?slug=<slug>',
                     { method: 'POST', headers: { Authorization: 'Bearer <PUBLISH_SECRET>' } })
               )
               ↑ 1 subrequest from the generator
               ↑ NEW Worker invocation with fresh 50-subrequest budget for enrichment
```

### Changes

**`js/blog-ai-worker.js` — `generateAndStore` (lightweight path only)**

- Add helper `async function selfEnrichFetch(env, slug)`:
  - Builds URL: `${env.WORKER_BASE_URL || 'https://thisday.info'}/blog/enrich?slug=${slug}`
  - Fires `POST` with `Authorization: Bearer ${env.PUBLISH_SECRET}`
  - Logs response status; does **not** throw on failure (best-effort)
- In the `if (lightweightPublish)` branch, after the KV draft write:
  - Replace `ctx.waitUntil(runPostPublishExtras(env, slug, content, { scheduleEnrichment: true }))` with `ctx.waitUntil(selfEnrichFetch(env, slug))`
  - Remove the now-unused `scheduleEnrichment` branch from `runPostPublishExtras`
- Fix the incorrect comment on line 4543 ("fresh subrequest budget") to describe the actual new behavior

**`wrangler-blog.jsonc` — vars**

- Add `"WORKER_BASE_URL": "https://thisday.info"` — configurable base URL for self-calls, no secret required

The `/blog/enrich` endpoint is unchanged — it already calls `enrichPublishedPost` directly with proper auth.

---

## Section 2: Soft-fail Completeness Checks

### Two-tier check system

**Tier 1 — Hard (structural, always throw):**

These are generated entirely from local draft content. If missing, `buildPostHTML` has fundamentally broken.

| Label | Pattern |
|---|---|
| article shell | `/<article\b/i` |
| hero image area | `/article-hero-wrap/i` |
| short answer card | `/ai-answer-card/i` |
| related Amazon block | `/class="amazon-related/i` |
| Amazon recommendation cards | `/amazon-product-card/i` |

**Tier 2 — Soft (asset-quality, warn + mark instead of throw):**

These depend on external network calls that can legitimately fail.

| Condition | Action |
|---|---|
| Person keyTerms exist but `data-entity-strip="1"` absent | Add `ENTITY_STRIP_BACKFILL_MARKER` to HTML; `console.warn` |
| Amazon cards present but fewer than `min(3, cardCount)` real `<img>` covers | Add `AMAZON_COVERS_BACKFILL_MARKER` to HTML; `console.warn` |

**Pipeline state**: soft issues do **not** advance `lastFailureDate` or set `lastFailureMessage`. Only hard failures do. `lastSuccessDate` advances normally when hard checks pass.

Both backfill marker constants are already defined:
- `ENTITY_STRIP_BACKFILL_MARKER = "<!-- entity-strip-backfill-v1 -->"`
- `AMAZON_COVERS_BACKFILL_MARKER = "<!-- amazon-covers-backfill-v1 -->"`

The per-request `canRunRepairAttempt("amazon-covers")` repair is already wired in the page-serve path (line 3132) — the marker signals it to run on first page view.

### Refactor

Split the current `assertPublishedArticleCompleteness(html, content)` into:
- `assertArticleStructure(html)` — throws on Tier 1 failures (no content arg needed)
- `softCheckArticleAssets(html, content)` — returns `{ html: string, issues: string[] }`: the `html` field is the input HTML with any needed backfill markers appended; `issues` is the list of human-readable warnings. Does not throw.

`savePublishedPost` calls `assertArticleStructure(html)` first (throws if broken), then `softCheckArticleAssets(html, content)` — uses the returned `html` for the KV write, logs each issue as `console.warn`. Only `assertArticleStructure` can block the write.

---

## Section 3: Publishing Today's Article + Verification

### Immediate publish (after deploy)

```bash
curl -X POST "https://thisday.info/blog/enrich?slug=23-may-2026" \
  -H "Authorization: Bearer <PUBLISH_SECRET>"
```

Draft is intact. Expected result: HTTP 200 `{"status":"ok"}`, article live at `/blog/23-may-2026/`.

### Verification checklist

1. `GET https://thisday.info/blog/23-may-2026/` → HTTP 200 with article content
2. KV key `post:23-may-2026` contains `data-entity-strip="1"` and real `<img>` in Amazon slider
3. KV key `youtube:pipeline-state` → `lastSuccessDate: "2026-05-23"`, `lastFailureDate` not `2026-05-23`
4. KV key `last_gen_date` stays `2026-05-23` (no re-generation needed)

### Tomorrow's cron (May 24 00:05 UTC) — expected behavior

1. `maybeGenerateBlogPost` → draft loop finds no unresolved drafts → generates May 24 content
2. Saves draft to KV
3. `ctx.waitUntil(selfEnrichFetch(env, '24-may-2026'))` → new invocation, fresh 50-subrequest budget
4. Enrichment succeeds → entity strip injected, real book covers loaded → article live

---

## Files Changed

| File | Change |
|---|---|
| `js/blog-ai-worker.js` | Add `selfEnrichFetch`; update `generateAndStore` lightweight path; split `assertPublishedArticleCompleteness` into hard + soft tiers; fix incorrect comment |
| `wrangler-blog.jsonc` | Add `WORKER_BASE_URL` var |

## Files Unchanged

- `/blog/enrich` endpoint — already correct
- `canRunRepairAttempt` system — already wired
- Draft TTL — already 3 days
- All other workers
