/**
 * Cloudflare Worker — Blog Post Generator
 *
 * Runs on a cron trigger (daily at 00:05 UTC) and publishes a new blog post
 * every day using Cloudflare Workers AI (free, no external API key).
 * Posts are stored in Cloudflare KV and served at:
 *   /blog/                → listing of all published posts
 *   /blog/[slug]/         → individual post page
 *
 * Manual trigger (for testing):
 *   POST /blog/publish     → immediately publishes today's post
 *
 * Required bindings: BLOG_AI_KV (KV namespace), AI (Workers AI)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

import {
  siteNav,
  siteFooter,
  footerYearScript,
  NAV_CSS,
  FOOTER_CSS,
  marqueeScript,
  navToggleScript,
} from "./shared/layout.js";
import {
  resolveAiModel,
  checkAndUpdateAiModel,
  CF_AI_MODEL,
} from "./shared/ai-model.js";
import {
  callAI,
  callWorkersAIDirect,
  hasAnyTextAIProvider,
  aiUsageSummary,
} from "./shared/ai-call.js";
import { extractFirstSentence, truncateForMeta, splitSentences, normalizeForCompare } from "./shared/seo-text.js";
import {
  getEvidenceBasedTopicHubMatches,
  selectTopicallyRelatedPosts,
} from "./shared/topic-relevance.js";
import {
  ARCHIVE_MIN_INDEXABLE_ARTICLES,
  archiveCollectionIsIndexable,
  archiveEditorialContext,
  archiveRobotsDirective,
  archiveUsablePosts,
  getArchivePostsForPillar,
} from "./shared/archive-indexability.js";
import {
  getKvWriteBudget,
  kvOptionalWritesAllowed,
  publicKvWriteBudget,
  withKvWriteBudget,
} from "./shared/kv-write-budget.js";

const PIPELINE_STATE_KEY = "youtube:pipeline-state";
const DEBUG_BUILD = "2026-04-28-ai-debug-1";
const KV_DRAFT_SOURCE_PREFIX = "draft-source-v1:";
const DRAFT_SOURCE_VERSION = 1;
const DRAFT_SOURCE_TTL = 3 * 86_400;
const FEATURED_IMAGE_CHECK_MARKER = "<!-- featured-image-check-v1 -->";
const EVENT_FIGURES_BACKFILL_MARKER = "<!-- event-figures-backfill-v1 -->";
const ENTITY_STRIP_BACKFILL_MARKER = "<!-- entity-strip-backfill-v1 -->";
const AMAZON_COVERS_BACKFILL_MARKER = "<!-- amazon-covers-backfill-v1 -->";
const KV_REPAIR_ATTEMPT_PREFIX = "repair-attempt-v1:";
const REPAIR_ATTEMPT_TTL = 60 * 60 * 24; // 1 day (featured-image, amazon-covers)
// Entity-strip heal backs off WEEKLY rather than daily. For a permanently-unlinkable
// person (a title/disambiguation page, a photo-less bio) the link never appears, so
// retrying daily is pure write churn with no different outcome. Recovery paths
// (manual backfill + the nightly cron) clear this counter, so a post that BECOMES
// healable still re-links on the very next view. (2026-06-26)
const ENTITY_STRIP_REPAIR_TTL = 60 * 60 * 24 * 7; // 7 days
const REPAIR_ATTEMPT_LIMIT = 2; // per slug, per repair type, per TTL window
const WIKIDATA_HUMAN_ENTITY_ID = "Q5";

async function callPublicationGateAI(env, messages, options = {}) {
  // Local-test guard: the Workers AI 10k-neurons/day pool is ACCOUNT-wide,
  // shared with production. AI_GATE_PREFER_EXTERNAL=1 (dev var only, never a
  // deployed secret) routes gates through the external chain first so local
  // E2E runs don't drain the pool the nightly cron needs; Workers AI remains
  // the chain's own last resort.
  if (env.AI_GATE_PREFER_EXTERNAL) {
    return callAI(env, messages, {
      ...options,
      providerAttemptLimit: 8,
      groqSectionAttemptLimit: 2,
    });
  }
  try {
    return await callWorkersAIDirect(env, messages, options);
  } catch (workersError) {
    console.warn(
      `Publication gate: Workers AI unavailable (${workersError.message}); trying bounded external fallback.`,
    );
    return callAI(env, messages, {
      ...options,
      skipWorkersAI: true,
      providerAttemptLimit: 8,
      groqSectionAttemptLimit: 2,
    });
  }
}

function utcDateString(value = new Date()) {
  return value.toISOString().slice(0, 10);
}

function addHtmlMarker(html, marker) {
  const source = String(html || "");
  if (!marker || source.includes(marker)) return source;
  const target = source.includes("</head>")
    ? "</head>"
    : source.includes("</body>")
      ? "</body>"
      : source.includes("</html>")
        ? "</html>"
        : "";
  return target
    ? source.replace(target, `${marker}\n${target}`)
    : `${source}\n${marker}`;
}

function blogKvBackgroundWritesPaused(env) {
  if (!kvOptionalWritesAllowed(env)) return true;
  const raw = String(env?.BLOG_KV_BACKGROUND_WRITES_PAUSED_UNTIL || "").trim();
  if (!raw) return false;
  const until = Date.parse(raw);
  return Number.isFinite(until) && Date.now() < until;
}

async function optionalBlogKvPut(env, key, value, options) {
  if (blogKvBackgroundWritesPaused(env) || !env?.BLOG_AI_KV) return false;
  try {
    await env.BLOG_AI_KV.put(key, value, options);
    return true;
  } catch (err) {
    console.warn(`Blog: optional KV write skipped for ${key} — ${err.message}`);
    return false;
  }
}

async function prepareBlogKvBudget(env, phase) {
  const budget = await getKvWriteBudget(env, phase);
  if (budget.allowPhase && budget.allowOptionalWrites) {
    console.log(`Blog KV budget: ${budget.reason}`);
  } else {
    console.warn(`Blog KV budget: ${budget.reason}`);
  }
  return {
    budget,
    env: withKvWriteBudget(env, budget),
  };
}

function kvBudgetBlockedResponse(budget) {
  return jsonResponse(
    {
      status: "quota-blocked",
      message: budget.reason,
      kvBudget: publicKvWriteBudget(budget),
    },
    429,
    {
      "Retry-After": String(
        Math.max(
          1,
          Math.ceil((Date.parse(budget.resetAt) - Date.now()) / 1_000),
        ),
      ),
    },
  );
}

function repairAttemptKey(slug, type) {
  return `${KV_REPAIR_ATTEMPT_PREFIX}${type}:${slug}`;
}

async function canRunRepairAttempt(env, slug, type, limit = REPAIR_ATTEMPT_LIMIT, ttl = REPAIR_ATTEMPT_TTL) {
  if (!env?.BLOG_AI_KV || !slug || !type) return false;
  if (blogKvBackgroundWritesPaused(env)) return false;
  try {
    const key = repairAttemptKey(slug, type);
    const raw = await env.BLOG_AI_KV.get(key);
    const current = Math.max(0, Number.parseInt(raw || "0", 10) || 0);
    if (current >= limit) return false;
    await env.BLOG_AI_KV.put(key, String(current + 1), {
      expirationTtl: ttl,
    });
    return true;
  } catch {
    return false;
  }
}

async function clearRepairAttempt(env, slug, type) {
  if (!env?.BLOG_AI_KV || !slug || !type) return;
  await env.BLOG_AI_KV.delete(repairAttemptKey(slug, type)).catch(() => {});
}


async function getPipelineState(env) {
  const raw = await env.BLOG_AI_KV.get(PIPELINE_STATE_KEY);
  const parsed = raw ? JSON.parse(raw) : {};
  return {
    ...parsed,
    steps: parsed.steps ?? {},
    quota: parsed.quota ?? {},
  };
}

async function savePipelineState(env, state) {
  await env.BLOG_AI_KV.put(PIPELINE_STATE_KEY, JSON.stringify(state));
}

async function notifyPipelineIssue(env, issue) {
  if (!env.DISCORD_WEBHOOK_URL) return;
  const streakLine = issue.streak
    ? `\n📈 Consecutive days: ${issue.streak}`
    : "";
  const content =
    `⚠️ **Pipeline issue detected**\n` +
    `Step: ${issue.step}\n` +
    `Slug: ${issue.slug}\n` +
    `Date: ${issue.date}\n` +
    `Details: ${issue.message}${streakLine}`;
  await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  }).catch((e) =>
    console.warn("Blog: Discord pipeline alert failed:", e.message),
  );
}

async function recordPipelineFailure(
  env,
  { step, slug, message, date = new Date() },
) {
  const today = utcDateString(date);
  const yesterday = utcDateString(new Date(date.getTime() - 86_400_000));
  const state = await getPipelineState(env);
  const stepState = state.steps[step] ?? {};

  if (stepState.lastFailureDate === today) {
    stepState.lastFailureSlug = slug;
    stepState.lastFailureMessage = message;
    state.steps[step] = stepState;
    await savePipelineState(env, state);
    return;
  }

  const streak =
    stepState.lastFailureDate === yesterday ? (stepState.streak ?? 1) + 1 : 1;
  stepState.lastFailureDate = today;
  stepState.lastFailureSlug = slug;
  stepState.lastFailureMessage = message;
  stepState.streak = streak;
  state.steps[step] = stepState;

  if (streak >= 2) {
    stepState.lastAlertDate = today;
    state.steps[step] = stepState;
  }
  await savePipelineState(env, state);

  if (streak >= 2) {
    await notifyPipelineIssue(env, {
      step,
      slug,
      date: today,
      message,
      streak,
    });
  }
}

async function recordPipelineSuccess(
  env,
  { step, slug, date = new Date() },
) {
  const state = await getPipelineState(env);
  const stepState = state.steps[step] ?? {};
  stepState.lastSuccessDate = utcDateString(date);
  stepState.lastFailureDate = null;
  stepState.lastFailureSlug = null;
  stepState.lastFailureMessage = null;
  stepState.streak = 0;
  stepState.lastSuccessSlug = slug;
  state.steps[step] = stepState;
  await savePipelineState(env, state);
}

const WIKIPEDIA_USER_AGENT = "thisDay.info (kapetanovic.armin@gmail.com)";
const KV_POST_PREFIX = "post:";
const KV_INDEX_KEY = "index";
const KV_LAST_GEN_KEY = "last_gen_date";
const KV_DRAFT_PREFIX = "draft:";
const KV_ENTITY_PREFIX = "entity-v1:";
const KV_ENTITY_INDEX_KEY = "entity-index-v1";
const KV_PERSON_IMAGE_PREFIX = "person-image:";
const KV_PERSON_IMAGE_TTL = 60 * 60 * 24 * 30; // 30 days
const PERSON_ENTITY_MIN_SOURCE_WORDS = 45;
const PERSON_ENTITY_MIN_SOURCE_SENTENCES = 2;
// Leading honorific/title tokens dropped before matching a person's name against the
// resolved Wikipedia page title. Regnal/titled names ("Queen Elizabeth II") resolve to
// a page that omits the honorific ("Elizabeth II"), so the raw name would never match.
const PERSON_NAME_HONORIFIC_TOKENS = new Set([
  "sir", "dame", "lord", "lady", "dr", "doctor", "prof", "professor", "rev", "reverend",
  "st", "saint", "queen", "king", "prince", "princess", "emperor", "empress", "tsar",
  "czar", "kaiser", "sultan", "pope", "president", "chancellor", "premier", "captain",
  "colonel", "general", "admiral", "major", "sergeant", "mahatma", "sheikh", "imam",
  "rabbi", "baron", "baroness", "count", "countess", "duke", "duchess", "earl", "viscount",
]);
const SOURCE_EVENT_PERSON_PAGE_RE =
  /\b(murder|assassination|killing|death|execution|shooting|kidnapping|abduction|attack|bombing|massacre|trial|case|incident|affair|crash|disaster)\b/i;
const SOURCE_EVENT_TITLE_STOPWORDS = new Set([
  "the", "of", "and", "in", "on", "at", "to", "for", "a", "an", "de", "la", "el",
]);
const SOURCE_PAGE_RELEVANCE_STOPWORDS = new Set([
  ...SOURCE_EVENT_TITLE_STOPWORDS,
  "was", "were", "is", "are", "be", "been", "by", "from", "with", "during", "after",
  "before", "into", "its", "their", "his", "her", "this", "that", "united", "states",
]);
const EVENT_FAMILY_REPEAT_WINDOW_DAYS = 7;
// Royal/papal succession detection, shared by the scorer and the event-family
// cooldown. Runs against normalizeTopicMatchText output (lowercased, no
// punctuation). July 11 2026 incident: "Election of pope Adrian V" stacked
// election +22, pope +20, death +10 and beat every famous event of the date,
// and no cooldown family stopped five medieval successions in eight days.
// Modern presidential/parliamentary elections are deliberately not matched.
const ROYAL_SUCCESSION_PATTERN =
  /\b(coronation|crowned|enthroned|papal election|papal conclave|antipope)\b|\b(elected|election of|becomes|proclaimed|acclaimed)\b[a-z0-9\s]{0,40}\b(pope|king|queen|emperor|tsar|sultan|caliph)\b|\b(pope|king|queen|emperor)\b[a-z0-9\s]{0,30}\b(is elected|is crowned)\b/;
// Minimum feed-extract length for a candidate to qualify. The old 300-char
// floor silently dropped major events whose feed extract happened to be short
// (Skylab reentry 217, Branson spaceflight 199, 1982 World Cup final 268);
// fuller source pages are fetched after selection anyway.
const MIN_CANDIDATE_EXTRACT_CHARS = 150;
const EVENT_FAMILY_RULES = [
  {
    name: "shooting",
    pattern: /\b(shooting|shootings|shootout|gunman|gunmen|opened fire)\b/,
  },
  {
    name: "bombing",
    pattern: /\b(bombing|bombings|bomb attack|bomb blast|suicide bomb(?:er|ing)?|car bomb)\b/,
  },
  {
    name: "aviation crash",
    pattern:
      /\b(aircraft|airliner|airplane|aeroplane|helicopter|flight|plane)\b.{0,48}\b(crash|crashes|crashed|breaks apart)\b|\b(crash|crashes|crashed|breaks apart)\b.{0,48}\b(aircraft|airliner|airplane|aeroplane|helicopter|flight|plane)\b/,
  },
  {
    name: "earthquake or tsunami",
    pattern: /\b(earthquake|tsunami|seismic)\b/,
  },
  {
    name: "flood",
    pattern: /\b(flood|floods|flooding)\b/,
  },
  {
    name: "assassination",
    pattern: /\b(assassination|assassinated)\b/,
  },
  {
    name: "battle or siege",
    pattern: /\b(battle|siege)\b/,
  },
  {
    name: "coup",
    pattern: /\b(coup|military takeover)\b/,
  },
  {
    name: "treaty",
    pattern: /\btreaty\b/,
  },
  {
    name: "independence",
    pattern: /\bindependence\b/,
  },
  {
    name: "royal or papal succession",
    pattern: ROYAL_SUCCESSION_PATTERN,
  },
];
const EVERY_OTHER_DAYS = 1; // Generate every N days
// Source preparation, article generation, and enrichment intentionally use
// separate cron invocations. Source vetting can consume most of the Free-plan
// limit of 50 external subrequests before provider fallback even starts (July
// 18, 2026 incident); enrichment has its own similarly large budget (June 22).
// A comma-list is one Cloudflare cron trigger but produces independent
// scheduled invocations. This preserves the account's five-trigger allowance.
const DAILY_PUBLICATION_CRON = "5,10,12,15 0 * * *";
const DRAFT_PREPARATION_MINUTE = 5;
const DRAFT_GENERATION_MINUTES = new Set([10, 12]);
const DRAFT_ENRICHMENT_MINUTE = 15;
// Cron string (must match a trigger in wrangler-blog.jsonc) for the dedicated
// entity-recovery pass that re-links people strips with a fresh subrequest budget.
const ENTITY_RECOVERY_CRON = "50 0 * * *";
// Evergreen history generation is isolated from both publication and person
// recovery. A source-rich candidate can require a long structured AI response,
// so it receives its own scheduled invocation and external-subrequest budget.
const EVERGREEN_HISTORY_RECOVERY_CRON = "55 0 * * *";
const AMAZON_ASSOCIATE_TAG = "thisday0c-20";
const MIN_RELEVANT_COMMERCIAL_BOOKS = 2;
const COMMERCIAL_RELEVANCE_STOPWORDS = new Set([
  "about", "after", "against", "also", "among", "before", "began", "begin",
  "begins", "book", "books", "cause", "caused", "civil", "companion",
  "documentary", "during", "event", "events", "first", "from", "historical",
  "history", "into", "later", "memoir", "more", "most", "over", "reading",
  "related", "second", "story", "than", "that", "their", "these", "this",
  "through", "today", "under", "were", "what", "when", "where", "which",
  "while", "with", "world", "would", "battle", "conflict", "incident", "war",
]);
const BLOG_NAV_WIDTH_FIX_CSS =
  `.nav-inner{max-width:1920px!important;margin:0 auto!important}`;
const SOCIAL_PREVIEW_IMAGE_PARAMS = "w=1200&h=630&fit=cover&q=85";
const BLOG_ENTITY_QUALITY_GATE_VERSION = 1;
const BLOG_HISTORY_QUALITY_GATE_VERSION = 2;
const EVERGREEN_HISTORY_EDITION_VERSION = 1;
const ARTICLE_ORIGINAL_VALUE_GATE_VERSION = 1;
const MIN_EVERGREEN_HISTORY_BODY_WORDS = 650;
const ARTICLE_HERO_CSS =
  `.article-hero-wrap{position:relative;isolation:isolate;margin:-1.5rem -1.5rem 1.5rem;border-radius:.375rem .375rem 0 0;overflow:hidden;height:460px;display:flex;flex-direction:column;justify-content:flex-end}.article-hero-wrap.article-hero-standalone{margin:0 0 1.5rem}.article-hero-fig{position:absolute!important;inset:0;margin:0!important;z-index:0;pointer-events:none}.article-hero-fig img{width:100%;height:100%;max-height:none!important;object-fit:cover;object-position:center;border-radius:0!important}.article-hero-fig figcaption{display:none}.article-hero-overlay{position:absolute;inset:0;background:linear-gradient(to top,rgba(27,58,45,.95) 0%,rgba(27,58,45,.6) 50%,rgba(27,58,45,.15) 100%);z-index:1;pointer-events:none}.article-hero-header{position:relative;z-index:3;width:100%;padding:2rem 1.5rem 2.5rem;margin-bottom:0!important;text-align:center!important}.article-body-layer{position:relative;z-index:1;clear:both}.article-hero-header h1{color:#fff!important}.article-hero-header a[rel="author"]{color:rgba(255,255,255,.7)!important}.article-hero-header .article-meta{color:rgba(255,255,255,.75)!important}.article-hero-header .pillar-pill-row{justify-content:center}.article-hero-header .pillar-pill{background:rgba(255,255,255,.12)!important;border-color:rgba(255,255,255,.3)!important;color:#fff!important}.article-hero-header .pillar-pill-featured{background:rgba(27,58,45,.85)!important;border-color:rgba(255,255,255,.35)!important;color:#fff!important}@media(max-width:767px){.article-hero-wrap{left:50%;transform:translateX(-50%);width:100vw;height:100svh;border-radius:0;margin:-1.5rem 0 1.5rem;justify-content:center}}`;
const ARTICLE_ENTITY_STRIP_STYLE =
  `<style>.entity-strip{margin:0 0 2rem}.entity-strip .h3,.entity-strip .h4{margin:0 0 1rem}.story-topic-section{margin-top:1.5rem;padding-top:1.35rem;border-top:1px solid var(--border,#cfe0cf)}.story-topic-section .story-topic-heading{font-size:clamp(1.3rem,2vw,1.65rem);margin:0 0 1rem}.story-topic-card{display:grid;grid-template-columns:minmax(210px,34%) minmax(0,1fr);overflow:hidden;border:1px solid var(--border,#cfe0cf);border-radius:14px;background:var(--bg-alt,#f2f7f2);color:var(--text,#1a2e20)!important;text-decoration:none!important;box-shadow:0 12px 30px rgba(27,58,45,.08);transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease}.story-topic-card-no-image{grid-template-columns:1fr}.story-topic-card:hover{transform:translateY(-2px);border-color:var(--btn-bg,#1b3a2d);box-shadow:0 16px 34px rgba(27,58,45,.14);color:var(--text,#1a2e20)!important}.story-topic-card:focus-visible{outline:3px solid var(--accent,#9dc43a);outline-offset:3px}.story-topic-card-image{position:relative;min-height:220px;background:var(--btn-bg,#1b3a2d);overflow:hidden}.story-topic-card-image img{display:block;width:100%;height:100%;position:absolute;inset:0;object-fit:cover;object-position:center}.story-topic-card-copy{display:flex;min-width:0;flex-direction:column;align-items:flex-start;justify-content:center;padding:1.5rem}.story-topic-kicker{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--text-muted,#5c7a65);margin-bottom:.55rem}.story-topic-title{font-size:clamp(1.15rem,2vw,1.45rem);line-height:1.3;margin:0 0 .7rem;color:var(--text,#1a2e20)}.story-topic-description{font-size:14px;line-height:1.65;margin:0 0 1rem;color:var(--text-muted,#5c7a65)}.story-topic-cta{display:inline-flex;align-items:center;gap:.45rem;margin-top:auto;font-size:14px;font-weight:700;color:var(--btn-bg,#1b3a2d)}@media(max-width:680px){.story-topic-card{grid-template-columns:1fr}.story-topic-card-image{min-height:210px}.story-topic-card-copy{padding:1.2rem}}</style>`;
const VIDEO_THUMBNAIL_OVERRIDES = {
  "13-may-2026":
    "https://thisday.info/image-proxy?src=https%3A%2F%2Fupload.wikimedia.org%2Fwikipedia%2Fcommons%2Ff%2Ffb%2FGIRO8076_Pogacar_%252853750349243%2529.jpg",
};

function isProxyableArticleImageUrl(imageUrl) {
  try {
    const parsed = new URL(String(imageUrl || ""));
    const hostname = parsed.hostname.toLowerCase();
    return (
      parsed.protocol === "https:" &&
      (hostname === "wikimedia.org" || hostname.endsWith(".wikimedia.org"))
    );
  } catch {
    return false;
  }
}

function wikimediaImageFileName(imageUrl) {
  try {
    const parsed = new URL(String(imageUrl || ""), "https://thisday.info");
    const source = parsed.pathname === "/image-proxy"
      ? parsed.searchParams.get("src") || ""
      : String(imageUrl || "");
    const sourceUrl = new URL(source);
    return decodeURIComponent(sourceUrl.pathname.split("/").pop() || "")
      .replace(/^\d+px-/i, "");
  } catch {
    return "";
  }
}

function wikimediaImageFileKey(imageUrl) {
  return wikimediaImageFileName(imageUrl).toLowerCase();
}

function buildSocialPreviewImageUrl(imageUrl) {
  return isProxyableArticleImageUrl(imageUrl)
    ? `https://thisday.info/image-proxy?src=${encodeURIComponent(imageUrl)}&${SOCIAL_PREVIEW_IMAGE_PARAMS}`
    : "https://thisday.info/images/logo.png";
}

function findArticleHeroWrapEnd(html, heroStart) {
  if (heroStart < 0) return -1;
  const divRe = /<\/?div\b[^>]*>/gi;
  divRe.lastIndex = heroStart;
  let depth = 0;
  let match;
  while ((match = divRe.exec(html))) {
    if (/^<div\b/i.test(match[0])) {
      depth += 1;
    } else {
      depth -= 1;
      if (depth === 0) return match.index + match[0].length;
    }
  }
  return -1;
}

function findArticleEntityStripRange(html) {
  const source = String(html || "");
  const stripMatch = source.match(
    /<div class="[^"]*\bentity-strip\b[^"]*" data-entity-strip="1">/i,
  );
  if (!stripMatch || typeof stripMatch.index !== "number") return null;
  const divStart = stripMatch.index;
  const divEnd = findArticleHeroWrapEnd(source, divStart);
  if (divEnd === -1) return null;

  let start = divStart;
  const prefix = source.slice(0, divStart);
  const styleMatch = prefix.match(/<style>\.entity-strip\{[\s\S]*?<\/style>\s*$/i);
  if (styleMatch && typeof styleMatch.index === "number") {
    start = styleMatch.index;
  }
  return { start, end: divEnd };
}

function replaceArticleEntityStripHtml(html, replacement) {
  const source = String(html || "");
  const range = findArticleEntityStripRange(source);
  if (!range) return source;
  return source.slice(0, range.start) + replacement + source.slice(range.end);
}

function removeArticleEntityStripHtml(html) {
  return replaceArticleEntityStripHtml(html, "");
}

function moveEntityStripOutOfArticleHero(html) {
  const heroStart = html.indexOf('<div class="article-hero-wrap">');
  if (heroStart === -1 || !html.includes('data-entity-strip="1"')) return html;
  const heroEnd = findArticleHeroWrapEnd(html, heroStart);
  if (heroEnd === -1) return html;

  const stripRange = findArticleEntityStripRange(html);
  if (!stripRange || stripRange.start < heroStart || stripRange.start >= heroEnd) {
    return html;
  }

  const strip = html.slice(stripRange.start, stripRange.end);
  const withoutStrip =
    html.slice(0, stripRange.start) + html.slice(stripRange.end);
  const newHeroEnd = heroEnd - (stripRange.end - stripRange.start);
  return withoutStrip.slice(0, newHeroEnd) + "\n" + strip + withoutStrip.slice(newHeroEnd);
}

function buildTimelineBlock(content) {
  const items = Array.isArray(content.timeline) ? content.timeline : [];
  if (!items.length) return "";
  const originalValueMarker = validateSourcedTimelineForPublish(content).ok
    ? ' data-original-value-module="sourced-timeline"'
    : "";
  const rows = items
    .map(
      (e) => `        <li class="tl-entry tl-${esc(e.kind || "leadup")}">
          <span class="tl-date">${esc(e.date || e.year || "")}</span>
          <span class="tl-label">${esc(e.label || "")}</span>
        </li>`,
    )
    .join("\n");
  const label = eventNounLabel(content);
  return `<section class="article-timeline mb-4"${originalValueMarker} aria-label="Timeline">
      <h2 class="h3">Timeline: the road to ${esc(label)} and its aftermath</h2>
      <ol class="tl-list">
${rows}
      </ol>
    </section>`;
}

function validateSourcedTimelineForPublish(content, { minimumEntries = 3 } = {}) {
  const input = Array.isArray(content?.timeline) ? content.timeline : [];
  const entries = input.filter(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      String(entry.date || entry.year || "").trim() &&
      String(entry.label || "").trim() &&
      ["leadup", "event", "aftermath"].includes(String(entry.kind || "")),
  );
  const reasons = [];
  if (entries.length < minimumEntries) {
    reasons.push(
      `only ${entries.length} complete timeline entr${entries.length === 1 ? "y" : "ies"}; needs ${minimumEntries}`,
    );
  }
  if (entries.length !== input.length) {
    reasons.push("timeline contains an incomplete entry or unsupported kind");
  }

  const eventEntries = entries.filter((entry) => entry.kind === "event");
  if (eventEntries.length !== 1) {
    reasons.push(`timeline has ${eventEntries.length} event entries; needs exactly one`);
  }
  if (!entries.some((entry) => entry.kind === "leadup" || entry.kind === "aftermath")) {
    reasons.push("timeline needs sourced lead-up or aftermath context");
  }

  const identities = entries.map(
    (entry) =>
      `${normalizeTopicMatchText(entry.date || entry.year)}|${normalizeTopicMatchText(entry.label)}`,
  );
  if (new Set(identities).size !== identities.length) {
    reasons.push("timeline contains duplicate dated entries");
  }

  const visibleValidation = validateVisibleProseForPublish({ timeline: entries });
  if (!visibleValidation.ok) reasons.push(...visibleValidation.reasons);

  return { ok: reasons.length === 0, reasons, entries };
}

function articleAnswerFacts(content) {
  const usableFacts = (Array.isArray(content.quickFacts) ? content.quickFacts : []).filter(
    (fact) =>
      fact &&
      typeof fact === "object" &&
      String(fact.label || "").trim() &&
      String(fact.value || "").trim(),
  );
  return usableFacts.length
    ? usableFacts
    : [
        { label: "Event", value: content.eventTitle },
        { label: "Date", value: content.historicalDate },
        { label: "Location", value: content.location || content.country || "" },
        { label: "Significance", value: content.description },
      ].filter((fact) => String(fact.value || "").trim());
}

function buildArticleAnswerBlock(content) {
  const facts = articleAnswerFacts(content);
  if (!facts.length) return "";
  const gridItems = facts
    .map((f) => `      <div class="ai-answer-item"><strong>${esc(f.label)}</strong><span>${esc(f.value)}</span></div>`)
    .join("\n");

  // The "The provision that mattered" key-provision row was removed on
  // 2026-06-20 (redundant with the FAQ). The timeline learning block stays.
  return `<section class="ai-answer-card article-body-layer mb-4" aria-label="Short answer">
    <div class="ai-answer-kicker">Short answer</div>
    <div class="ai-answer-grid" aria-label="Key facts">
${gridItems}
    </div>
  </section>`;
}

const REQUIRED_DID_YOU_KNOW_FACTS = 5;

function normalizeArticleDidYouKnowFact(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-•]\s*/, "")
    .replace(/^did you know that\s*/i, "")
    .replace(/^did you know[,:]?\s*/i, "")
    .trim();
}

function didYouKnowIgnoredTokens(content = {}) {
  return semanticDuplicateTokens(
    [
      content?.title,
      content?.eventTitle,
      content?.historicalDate,
      content?.location,
      content?.country,
      content?.sourcePageTitle,
    ].filter(Boolean).join(" "),
  );
}

function didYouKnowFactsAreNearDuplicates(left, right, content = {}) {
  const ignoredTokens = didYouKnowIgnoredTokens(content);
  const leftTokens = semanticDuplicateTokens(left, ignoredTokens);
  const rightTokens = semanticDuplicateTokens(right, ignoredTokens);
  const { shared, ratio } = semanticDuplicateScore(leftTokens, rightTokens);
  return shared >= 6 && ratio >= 0.55;
}

function auditDidYouKnowFacts(
  content,
  { requireGrounding = false, groundingVerified = false } = {},
) {
  const rawFacts = Array.isArray(content?.didYouKnowFacts)
    ? content.didYouKnowFacts
    : [];
  const facts = rawFacts
    .filter((fact) => typeof fact === "string")
    .map(normalizeArticleDidYouKnowFact)
    .filter(Boolean);
  const reasons = [];

  if (rawFacts.length !== REQUIRED_DID_YOU_KNOW_FACTS || facts.length !== REQUIRED_DID_YOU_KNOW_FACTS) {
    reasons.push(
      `didYouKnowFacts must contain exactly ${REQUIRED_DID_YOU_KNOW_FACTS} populated facts (got ${facts.length})`,
    );
  }

  for (let i = 0; i < facts.length; i += 1) {
    if (!hasHardFact(facts[i])) {
      reasons.push(`didYouKnowFacts[${i}] lacks a concrete name, date, number, place, or institution`);
    }
    for (let j = i + 1; j < facts.length; j += 1) {
      const exact = normalizeForCompare(facts[i]) === normalizeForCompare(facts[j]);
      if (exact) {
        reasons.push(`didYouKnowFacts[${i}] and didYouKnowFacts[${j}] are exact duplicates`);
      } else if (didYouKnowFactsAreNearDuplicates(facts[i], facts[j], content)) {
        reasons.push(`didYouKnowFacts[${i}] and didYouKnowFacts[${j}] repeat the same claim`);
      }
    }
  }

  if (requireGrounding && groundingVerified !== true) {
    reasons.push("didYouKnowFacts did not pass the final source-grounding verifier");
  }

  return { ok: reasons.length === 0, reasons, facts };
}

function distinctDidYouKnowFacts(facts, content = null) {
  const selected = [];
  const seen = new Set();
  for (const value of Array.isArray(facts) ? facts : []) {
    if (typeof value !== "string") continue;
    const fact = normalizeArticleDidYouKnowFact(value);
    const key = normalizeForCompare(fact);
    if (!key || seen.has(key)) continue;
    if (
      content &&
      selected.some((existing) => didYouKnowFactsAreNearDuplicates(existing, fact, content))
    ) {
      continue;
    }
    seen.add(key);
    selected.push(fact);
  }
  return selected;
}

function buildDidYouKnowSlider(facts, content = null) {
  const cleanedFacts = distinctDidYouKnowFacts(facts, content);
  if (!cleanedFacts.length) return "";

  // Never manufacture a complete slider by cycling a short fact list. New
  // publication fails closed before rendering unless five distinct facts pass
  // source grounding; legacy repairs may render fewer cards rather than repeat.
  const sliderFacts = cleanedFacts.slice(0, REQUIRED_DID_YOU_KNOW_FACTS).map((fact, index) => {
    return `            <article class="blog-cta-col dyn-slide" aria-label="Did you know fact ${index + 1}">
              <p>Did you know</p>
              <p class="dyn-fact">${esc(fact)}</p>
            </article>`;
  }).join("\n");

  return `<h2 class="h3">Did You Know?</h2>
          <section class="dyn-slider-shell mb-4" aria-label="Did you know">
            <button type="button" class="dyn-slider-btn dyn-slider-btn-prev" aria-label="Previous" onclick="this.parentElement.querySelector('.dyn-slider-wrap').scrollBy({left:-280,behavior:'smooth'})">&#8249;</button>
            <div class="dyn-slider-wrap">
              <div class="dyn-slider-track">
${sliderFacts}
              </div>
            </div>
            <button type="button" class="dyn-slider-btn dyn-slider-btn-next" aria-label="Next" onclick="this.parentElement.querySelector('.dyn-slider-wrap').scrollBy({left:280,behavior:'smooth'})">&#8250;</button>
          </section>`;
}

function replaceLegacyDidYouKnowBlocks(html) {
  return String(html || "").replace(
    /<div class="did-you-know[^"]*"[^>]*>[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>[\s\S]*?<\/div>/gi,
    (_match, listHtml) => {
      const facts = Array.from(
        String(listHtml || "").matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi),
      )
        .map((item) =>
          unesc(
            String(item[1] || "")
              .replace(/<[^>]+>/g, " ")
              .replace(/\s+/g, " ")
              .trim(),
          ),
        )
        .filter(Boolean);
      return buildDidYouKnowSlider(facts);
    },
  );
}

const AI_REFERRER_SOURCES = [
  { label: "chatgpt", hosts: ["chatgpt.com", "chat.openai.com"] },
  { label: "claude", hosts: ["claude.ai"] },
  { label: "perplexity", hosts: ["perplexity.ai"] },
  { label: "gemini", hosts: ["gemini.google.com", "bard.google.com"] },
  {
    label: "copilot",
    hosts: ["copilot.microsoft.com", "copilot.cloud.microsoft"],
  },
];

// Per-pillar question heading sets. Each entry is [overview, eyewitness, aftermath, legacy].
// Falls back to the "default" set for pillars not listed here.
const PILLAR_QUESTION_HEADINGS = {
  "War & Conflict": [
    (t) => `What triggered ${t}?`,
    (t) => `Which forces were involved in ${t}?`,
    ()  => `What was the immediate outcome?`,
    (t) => `Why is ${t} still studied today?`,
  ],
  "Politics & Government": [
    (t) => `What led to ${t}?`,
    (t) => `Who held power during ${t}?`,
    ()  => `What changed in its aftermath?`,
    (t) => `Why does ${t} still matter?`,
  ],
  "Science & Technology": [
    (t) => `What made ${t} possible?`,
    (t) => `Who drove the work behind ${t}?`,
    ()  => `What changed as a result?`,
    (t) => `Why is ${t} still significant?`,
  ],
  "Health & Medicine": [
    (t) => `What caused ${t}?`,
    (t) => `Who was behind the breakthrough in ${t}?`,
    ()  => `How did medicine change afterward?`,
    (t) => `Why is ${t} still remembered?`,
  ],
  "Disasters & Accidents": [
    (t) => `What caused ${t}?`,
    ()  => `Who was most affected?`,
    ()  => `How did authorities respond?`,
    (t) => `What changed after ${t}?`,
  ],
  "Exploration & Discovery": [
    (t) => `What drove ${t}?`,
    ()  => `Who made it possible?`,
    ()  => `What did the world learn from it?`,
    (t) => `Why is ${t} still remembered?`,
  ],
  "Social & Human Rights": [
    (t) => `What conditions led to ${t}?`,
    (t) => `Who were the key figures in ${t}?`,
    ()  => `What rights or changes resulted?`,
    (t) => `Why does ${t} still resonate?`,
  ],
  "Arts & Culture": [
    (t) => `What inspired ${t}?`,
    (t) => `Who shaped ${t}?`,
    ()  => `How did it influence what came after?`,
    (t) => `Why is ${t} still remembered?`,
  ],
  "Sports": [
    (t) => `What made ${t} significant?`,
    ()  => `Who shaped the competition?`,
    ()  => `What record or achievement mattered most?`,
    (t) => `Why does ${t} still matter in sport?`,
  ],
  "Economy & Business": [
    (t) => `What caused ${t}?`,
    (t) => `Who were the key players in ${t}?`,
    ()  => `What were the economic consequences?`,
    (t) => `Why does ${t} still matter?`,
  ],
  "Famous Persons": [
    (t) => `Who was behind ${t}?`,
    ()  => `What are they best known for?`,
    ()  => `What came later?`,
    (t) => `Why is ${t} remembered today?`,
  ],
  "Born on This Day": [
    (t) => `Who was ${t}?`,
    ()  => `What are they best known for?`,
    ()  => `What did they go on to achieve?`,
    ()  => `Why are they still remembered?`,
  ],
  "Died on This Day": [
    (t) => `Who was ${t}?`,
    ()  => `What was their greatest achievement?`,
    ()  => `What happened in their final years?`,
    ()  => `What is their lasting legacy?`,
  ],
  default: [
    (t) => `What caused ${t}?`,
    (t) => `Who was involved in ${t}?`,
    ()  => `What happened next?`,
    ()  => `Why is it remembered today?`,
  ],
};

function normalizeTopicMatchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns only narrow hubs supported by explicit phrases, named entities, or
// a matching historical period plus multiple topic terms. Broad pillars are
// deliberately ignored because "War & Conflict" is not evidence of WWII.
function getArticleTopicHubMatches(content, limit = 3, _pillars = []) {
  return getEvidenceBasedTopicHubMatches(content, limit);
}

// Returns 4 question heading strings tuned to the article's dominant pillar.
function getQuestionHeadings(eventTitle, pillars = []) {
  const dominantPillar = pillars[0] || "default";
  const set = PILLAR_QUESTION_HEADINGS[dominantPillar] || PILLAR_QUESTION_HEADINGS.default;
  return set.map((fn) => fn(eventTitle));
}

function extractPlainSentence(text, maxLength = 220) {
  // maskAbbreviationPeriods (via extractFirstSentence) keeps "U.S.", "Dr.",
  // and single-letter initials from triggering a premature sentence split.
  const sentence = extractFirstSentence(String(text || "").replace(/<[^>]*>/g, " "));

  // Reject AI-truncated text — ends with ellipsis, sentence is incomplete
  if (sentence.endsWith("…") || sentence.endsWith("...")) return "";

  return sentence;
}

function ensureFactDenseOpening(paragraphs, leadSentence, requiredTerms = []) {
  if (!Array.isArray(paragraphs) || paragraphs.length === 0 || !leadSentence) return paragraphs;

  const first = String(paragraphs[0] || "").trim();
  const haystack = normalizeTopicMatchText(first);
  const hasRequiredTerm = requiredTerms.some((term) =>
    haystack.includes(normalizeTopicMatchText(term)),
  );
  const startsFactFirst =
    hasRequiredTerm ||
    /^(in|by|after|during|when)\b/i.test(first) ||
    /\b\d{3,4}\b/.test(first);

  if (startsFactFirst) return paragraphs;

  const cleanLead = leadSentence.replace(/\s+/g, " ").trim();
  paragraphs[0] = `${cleanLead} ${first}`.trim();
  return paragraphs;
}

function enforceAnswerFirstSections(content) {
  const locationPart = content.location ? ` in ${content.location}` : "";
  const nounLabel = eventNounLabel(content);
  ensureFactDenseOpening(
    content.overviewParagraphs,
    `${nounLabel} happened on ${content.historicalDate}${locationPart}.`,
    [content.eventTitle, content.historicalDate, content.location],
  );
  ensureFactDenseOpening(
    content.eyewitnessParagraphs,
    `Contemporary accounts described ${nounLabel} as it unfolded on ${content.historicalDate}${locationPart}.`,
    [content.eventTitle, "witness", "account", content.historicalDate],
  );
  ensureFactDenseOpening(
    content.aftermathParagraphs,
    `The immediate aftermath of ${nounLabel} began as soon as events on ${content.historicalDate} were over.`,
    [content.eventTitle, "aftermath", "response", content.historicalDate],
  );
  ensureFactDenseOpening(
    content.conclusionParagraphs,
    `The lasting importance of ${nounLabel} lies in what changed after ${content.historicalDate}.`,
    [content.eventTitle, "legacy", "importance", content.historicalDate],
  );
}

function buildArticleRelatedQuestionsBlock(content, pillars = []) {
  const nounLabel = eventNounLabel(content);
  const date = content.historicalDate || "the date";
  const loc = content.location ? ` in ${content.location}` : "";
  const persons = (content.keyTerms || [])
    .filter((t) => t && t.type === "person" && t.term)
    .map((t) => t.term);
  const leadup = (content.timeline || []).filter((e) => e?.kind === "leadup").map((e) => e.label);
  const aftermathEntries = (content.timeline || []).filter((e) => e?.kind === "aftermath").map((e) => e.label);
  const sigFact =
    (content.quickFacts || []).find((f) => /significance|legacy|impact/i.test(f?.label || ""))?.value || "";
  const firstOf = (arr) => extractFirstSentence((arr || [])[0] || "").trim();

  // Each question gets a SUBSTANTIVE answer: prefer compact structured data
  // (timeline lead-up/aftermath, key people, the Significance fact); otherwise
  // summarize the relevant body section. We no longer emit "see the section
  // above" pointer text — every question must actually be answered.
  const overviewAnswer =
    (leadup.length ? `The lead-up included ${leadup.slice(0, 3).join("; ")}.` : "") ||
    firstOf(content.overviewParagraphs) ||
    `${nounLabel} unfolded on ${date}${loc}.`;
  const eyewitnessAnswer =
    (persons.length ? `Key figures included ${persons.slice(0, 3).join(", ")}.` : "") ||
    firstOf(content.eyewitnessOrChronicle) ||
    firstOf(content.overviewParagraphs) ||
    `The principal figures in ${nounLabel} are profiled above.`;
  const aftermathAnswer =
    (aftermathEntries.length ? `In the aftermath: ${aftermathEntries.slice(0, 3).join("; ")}.` : "") ||
    firstOf(content.aftermathParagraphs) ||
    `${nounLabel} reshaped what followed on and after ${date}.`;
  const legacyAnswer =
    sigFact ||
    firstOf(content.conclusionParagraphs) ||
    `${nounLabel} remains significant for how it shaped later events.`;
  const topicLinks = getArticleTopicHubMatches(content, 3, pillars);
  const [q1, q2, q3, q4] = getQuestionHeadings(nounLabel, pillars);

  const faqPairs = [
    [q1, overviewAnswer],
    [q2, eyewitnessAnswer],
    [q3, aftermathAnswer],
    [q4, legacyAnswer],
  ];
  const faqItems = faqPairs
    .map(
      ([q, a], i) => `        <div class="faq-item">
          <button class="faq-q" aria-expanded="false" aria-controls="rq-a${i + 1}">
            <span>${esc(q)}</span><span class="faq-icon">+</span>
          </button>
          <div class="faq-a" id="rq-a${i + 1}" hidden>
            <p>${esc(a)}</p>
          </div>
        </div>`,
    )
    .join("\n");

  return `<section class="faq-section mt-5" aria-label="Related questions">
    <h2 class="h3 mb-3">Questions readers ask about ${esc(nounLabel)}</h2>
    <div class="faq-list">
${faqItems}
    </div>
    ${
      topicLinks.length > 0
        ? `<div class="topic-hub-links mt-3">
      <strong class="topic-hub-label">Explore connected topic hubs</strong>
      <div class="topic-hub-chip-row">
        ${topicLinks
          .map(
            (hub) =>
              `<a href="/topics/${hub.slug}/" class="topic-hub-chip">${esc(hub.title)}</a>`,
          )
          .join("")}
      </div>
    </div>`
        : ""
    }
    <script>
      document.querySelectorAll('.faq-q').forEach(function(btn){
        btn.addEventListener('click', function(){
          var open = this.getAttribute('aria-expanded') === 'true';
          var ans = document.getElementById(this.getAttribute('aria-controls'));
          this.setAttribute('aria-expanded', open ? 'false' : 'true');
          ans.hidden = open;
        });
      });
    </script>
  </section>`;
}

const SOURCE_SEARCH_HOSTS = new Set([
  "google.com",
  "www.google.com",
  "bing.com",
  "www.bing.com",
  "duckduckgo.com",
  "search.yahoo.com",
]);
const SOURCE_SEARCH_PARAM_NAMES = new Set([
  "q",
  "query",
  "search",
  "search_query",
  "page_search_query",
  "keyword",
  "keywords",
]);

function isPublicCitationHostname(value) {
  const hostname = String(value || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.includes(":")
  ) {
    return false;
  }
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return true;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return false;
  return !(
    octets[0] === 0 ||
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    octets[0] >= 224
  );
}

function isDirectCitationUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.port) {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    !isPublicCitationHostname(hostname) ||
    SOURCE_SEARCH_HOSTS.has(hostname) ||
    hostname === "example.com"
  ) {
    return false;
  }
  const path = parsed.pathname.toLowerCase().replace(/\/+$/, "") || "/";
  if (path === "/" || /(?:^|\/)search(?:\/|$|\.)/.test(path)) return false;
  if (hostname.endsWith("wikipedia.org") && !/^\/wiki\/[^/]+/.test(path)) {
    return false;
  }
  for (const key of parsed.searchParams.keys()) {
    if (SOURCE_SEARCH_PARAM_NAMES.has(key.toLowerCase())) return false;
  }
  if (/^#(?:q|query|search)=/i.test(parsed.hash)) return false;
  return true;
}

function sourcePublisherName(value) {
  let hostname = "";
  try {
    hostname = new URL(String(value || "")).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "Source";
  }
  if (hostname.endsWith("wikipedia.org")) return "Wikipedia";
  if (hostname === "britannica.com") return "Encyclopædia Britannica";
  if (hostname === "history.com") return "History.com";
  if (hostname === "si.edu") return "Smithsonian Institution";
  if (hostname === "nasa.gov") return "NASA";
  return hostname || "Source";
}

function directCitationPagesFromContent(content, limit = 6) {
  return sourcePagesFromContent(content)
    .filter((page) => isDirectCitationUrl(page.pageUrl))
    .slice(0, limit);
}

function validateDirectCitationsForPublish(
  content,
  { minimumSources = 2, minimumIndependentPublishers = 2 } = {},
) {
  const allSources = sourcePagesFromContent(content);
  const invalidSources = allSources.filter(
    (page) => page.pageUrl && !isDirectCitationUrl(page.pageUrl),
  );
  const directSources = allSources.filter((page) => isDirectCitationUrl(page.pageUrl));
  const verifiedSources = directSources.filter((page) => {
    try {
      const hostname = new URL(page.pageUrl).hostname.toLowerCase();
      return hostname.endsWith("wikipedia.org") || page.verifiedIndependent === true;
    } catch {
      return false;
    }
  });
  const publishers = new Set(
    verifiedSources.map((page) => {
      try {
        return new URL(page.pageUrl).hostname.toLowerCase().replace(/^www\./, "");
      } catch {
        return "";
      }
    }).filter(Boolean),
  );
  const reasons = [];
  if (invalidSources.length > 0) {
    reasons.push(
      `source list contains search, homepage, placeholder, or invalid URLs: ${invalidSources.map((page) => page.pageUrl).join(" | ")}`,
    );
  }
  if (verifiedSources.length < minimumSources) {
    reasons.push(
      `only ${verifiedSources.length} verified direct source page(s); needs ${minimumSources}`,
    );
  }
  if (publishers.size < minimumIndependentPublishers) {
    reasons.push(
      `only ${publishers.size} independent source publisher(s); needs ${minimumIndependentPublishers}`,
    );
  }
  return { ok: reasons.length === 0, reasons, sources: verifiedSources };
}

function evidenceMapRowsFromContent(content, limit = 4) {
  return sourcePagesFromContent(content)
    .filter((page) => {
      if (!isDirectCitationUrl(page.pageUrl)) return false;
      let isWikipedia = false;
      try {
        isWikipedia = new URL(page.pageUrl).hostname.toLowerCase().endsWith("wikipedia.org");
      } catch {
        return false;
      }
      return (
        (isWikipedia || page.verifiedIndependent === true) &&
        Array.isArray(page.supportedClaims) &&
        page.supportedClaims.some((claim) => String(claim || "").trim())
      );
    })
    .slice(0, limit)
    .map((page) => {
      let isWikipedia = false;
      try {
        isWikipedia = new URL(page.pageUrl).hostname.toLowerCase().endsWith("wikipedia.org");
      } catch {}
      return {
        page,
        role: isWikipedia ? "event-record" : "independent",
        roleLabel: isWikipedia
          ? "Selected event record"
          : "Independent corroboration",
        claims: page.supportedClaims
          .map((claim) => String(claim || "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .slice(0, 2),
      };
    });
}

function validateEvidenceMapForPublish(content, { minimumRows = 2 } = {}) {
  const rows = evidenceMapRowsFromContent(content);
  const reasons = [];
  if (rows.length < minimumRows) {
    reasons.push(`only ${rows.length} source-backed evidence row(s); needs ${minimumRows}`);
  }
  if (!rows.some((row) => row.role === "event-record")) {
    reasons.push("missing the selected event-record source");
  }
  if (!rows.some((row) => row.role === "independent")) {
    reasons.push("missing an independently verified corroborating source");
  }
  if (!rows[0]?.claims?.[0]) {
    reasons.push("missing the central supported claim");
  }
  return { ok: reasons.length === 0, reasons, rows };
}

function validateOriginalValueForPublish(content) {
  const modules = [];
  const timeline = validateSourcedTimelineForPublish(content);
  if (timeline.ok) {
    modules.push({
      type: "sourced-timeline",
      entryCount: timeline.entries.length,
    });
  }

  const comparison = validateEvidenceMapForPublish(content);
  if (comparison.ok) {
    modules.push({
      type: "source-comparison",
      rowCount: comparison.rows.length,
    });
  }

  const reasons = [];
  if (modules.length === 0) {
    reasons.push(
      "no qualifying original-value module; needs a sourced timeline or verified source comparison",
    );
    reasons.push(
      ...timeline.reasons.map((reason) => `sourced timeline: ${reason}`),
      ...comparison.reasons.map((reason) => `source comparison: ${reason}`),
    );
  }
  return {
    ok: reasons.length === 0,
    reasons,
    modules,
    gateVersion: ARTICLE_ORIGINAL_VALUE_GATE_VERSION,
  };
}

function buildEvidenceMapBlock(content) {
  const validation = validateEvidenceMapForPublish(content);
  if (!validation.ok) return "";

  const centralClaim = validation.rows[0].claims[0];
  const normalizedCentralClaim = normalizeTopicMatchText(centralClaim);
  const rows = validation.rows
    .map(({ page, role, roleLabel, claims }) => {
      const publisher = page.publisher || sourcePublisherName(page.pageUrl);
      const title = page.pageTitle || publisher;
      const sourceLabel = title === publisher ? title : `${title} · ${publisher}`;
      const distinctClaims = claims.filter(
        (claim) => normalizeTopicMatchText(claim) !== normalizedCentralClaim,
      );
      const coverage = distinctClaims.length > 0
        ? distinctClaims.join(" ")
        : "Supports the central claim shown above.";
      const accessed = page.accessedAt
        ? `<span class="evidence-map-accessed">Accessed ${esc(page.accessedAt)}</span>`
        : "";
      return `<tr class="evidence-map-row" data-evidence-role="${role}">
                  <th scope="row">
                    <a href="${esc(page.pageUrl)}" target="_blank" rel="noopener noreferrer">${esc(sourceLabel)}</a>
                    ${accessed}
                  </th>
                  <td><span class="evidence-map-role evidence-map-role-${role}">${esc(roleLabel)}</span></td>
                  <td>${esc(coverage)}</td>
                </tr>`;
    })
    .join("\n");

  return `<section class="article-evidence-map mt-5" data-original-value-module="source-comparison" aria-labelledby="evidence-map-heading">
            <h2 class="h3" id="evidence-map-heading">Evidence Map: How We Checked the Central Claim</h2>
            <p class="evidence-map-intro">This comparison separates the event page selected for the account from the independently verified page used to corroborate it.</p>
            <p class="evidence-map-claim"><strong>Central claim checked:</strong> ${esc(centralClaim)}</p>
            <div class="evidence-map-table-wrap">
              <table class="evidence-map-table">
                <thead>
                  <tr>
                    <th scope="col">Direct source</th>
                    <th scope="col">Verification role</th>
                    <th scope="col">Coverage</th>
                  </tr>
                </thead>
                <tbody>
${rows}
                </tbody>
              </table>
            </div>
            <p class="article-meta evidence-map-note">Claims are paraphrased for comparison; use the direct source links for the full record.</p>
          </section>`;
}

function buildAuthorityLinksBlock(content, _pillars = []) {
  const links = directCitationPagesFromContent(content);
  if (links.length === 0) return "";

  const chips = links
    .map((source) => {
      const publisher = source.publisher || sourcePublisherName(source.pageUrl);
      const title = source.pageTitle || publisher;
      const label = title === publisher ? title : `${title} · ${publisher}`;
      return `<a href="${esc(source.pageUrl)}" target="_blank" rel="noopener noreferrer" class="authority-link">${esc(label)}</a>`;
    })
    .join("");
  const wikipediaLicense = links.some((source) => {
    try {
      return new URL(source.pageUrl).hostname.toLowerCase().endsWith("wikipedia.org");
    } catch {
      return false;
    }
  })
    ? `<small class="article-meta" style="display:block;margin-top:10px">Wikipedia text is available under <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a>.</small>`
    : "";

  return `<div class="authority-links mt-3 mb-4">
    <span class="authority-links-label">Sources used for this article</span>
    <div class="authority-links-row">${chips}</div>
    ${wikipediaLicense}
  </div>`;
}

// Content pillars — mirrors the 10 event filter categories in script.js,
// plus "Born on This Day" and "Died on This Day" matching the site's nav sections.
// Used to classify blog posts for topical authority tracking and depth rotation.
// DO NOT change these names without also updating the backfill logic below.
const BLOG_PILLARS = [
  "War & Conflict",
  "Politics & Government",
  "Science & Technology",
  "Arts & Culture",
  "Sports",
  "Disasters & Accidents",
  "Social & Human Rights",
  "Economy & Business",
  "Health & Medicine",
  "Exploration & Discovery",
  "Famous Persons",
  "Born on This Day",
  "Died on This Day",
];

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const MONTH_SLUGS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function extractMonthDayCandidate(value) {
  const str = String(value || "").trim();
  if (!str) return null;

  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return {
      source: "iso",
      month: Number.parseInt(isoMatch[2], 10),
      day: Number.parseInt(isoMatch[3], 10),
      raw: str,
    };
  }

  const monthMatch = str.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\b/i,
  );
  if (monthMatch) {
    const monthIndex = MONTH_NAMES.findIndex(
      (month) => month.toLowerCase() === monthMatch[1].toLowerCase(),
    );
    if (monthIndex >= 0) {
      return {
        source: "text",
        month: monthIndex + 1,
        day: Number.parseInt(monthMatch[2], 10),
        raw: str,
      };
    }
  }

  return null;
}

function validateContentDateForPublish(content, targetDate) {
  const expectedMonth = targetDate.getUTCMonth() + 1;
  const expectedDay = targetDate.getUTCDate();
  const candidates = [
    { label: "historicalDateISO", candidate: extractMonthDayCandidate(content?.historicalDateISO) },
    { label: "historicalDate", candidate: extractMonthDayCandidate(content?.historicalDate) },
    { label: "title", candidate: extractMonthDayCandidate(content?.title) },
  ].filter((entry) => entry.candidate);

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "No parseable publish date in generated content.",
    };
  }

  const mismatches = candidates.filter(
    ({ candidate }) =>
      candidate.month !== expectedMonth || candidate.day !== expectedDay,
  );
  if (mismatches.length === 0) {
    return { ok: true };
  }

  return {
    ok: false,
    reason:
      `Generated content date mismatch. Expected ${MONTH_NAMES[expectedMonth - 1]} ${expectedDay}, got ` +
      mismatches.map(({ label, candidate }) => `${label}=${candidate.raw}`).join(" | "),
  };
}

// A headline that opens with a bare action verb is normally an instruction,
// not a historical subject-verb clause ("Execute Chancellor Yang Guozhong").
// Keep ambiguous event nouns out of this list where practical. When an action
// word can also be a noun (for example "Bomb"), a second finite verb in the
// remainder proves that the first word is acting as the subject ("Bomb
// Explodes...") and the headline is allowed.
const HEADLINE_IMPERATIVE_START_RE =
  /^(?:accept|adopt|appoint|approve|arrest|assassinate|bomb|capture|convict|create|declare|defeat|deport|destroy|detain|discover|elect|establish|execute|free|found|honou?r|imprison|invade|invent|join|kill|launch|liberate|meet|negotiate|open|order|publish|ratify|reject|rescue|sign|surrender|visit|withdraw)\b/i;

function headlineStartsWithUnsupportedImperative(value) {
  const lead = getTitleLead(value).replace(/^["'“‘]+/, "").trim();
  const match = lead.match(HEADLINE_IMPERATIVE_START_RE);
  if (!match) return false;
  const remainder = lead.slice(match[0].length).trim();
  return !hasFiniteHeadlineVerb(remainder);
}

function analysisLooksLikeArticleSelfReview(value) {
  return /\b(?:the|this)\s+(?:article|piece|post|write[- ]?up)\b|\b(?:article|piece|post|write[- ]?up)\s+(?:accurately|correctly|records?|identifies?|states?|notes?|omits?|fails?|provides?|describes?|discusses?|explains?|covers?|mentions?)\b/i.test(
    plainText(value),
  );
}

const CURIOSITY_TITLE_MIN_LENGTH = 35;
const CURIOSITY_TITLE_MAX_LENGTH = 65;
const CURIOSITY_TITLE_START_RE = /^(?:How|Why|What|Who|Which|Where)\b/;
const CURIOSITY_TITLE_GENERIC_RE =
  /^(?:What Happened|What Was|Who Was|Why Did It Matter|Why Does It Matter|What Is the Story|How Did .{1,80} Change History)\b|\b(?:you won(?:'|’)t believe|shocking truth|untold secret|what really happened|mystery behind)\b/i;
const CURIOSITY_TITLE_FULL_DATE_SUFFIX_RE = new RegExp(
  String.raw`(?:\s+(?:on|in)|\s+[—-])\s+(?:${MONTH_NAMES.join("|")})\s+\d{1,2},\s+\d{3,4}\?\s*$`,
  "i",
);
const CURIOSITY_TITLE_ANGLE_STOPWORDS = new Set([
  "are", "became", "become", "been", "being", "could", "did", "does", "had",
  "has", "have", "how", "into", "was", "were", "what", "when", "where", "which",
  "who", "why", "would",
]);

function publicArticleTitle(content) {
  return String(content?.curiosityTitle || content?.title || content?.eventTitle || "Historical Event")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCuriosityTitleText(value) {
  let question = String(value || "").replace(/\s+/g, " ").trim();
  if (!question) return "";
  question = question.replace(
    /^(how|why|what|who|which|where)\b/i,
    (word) => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`,
  );
  // The date is already rendered under the H1. Models sometimes append the
  // complete date anyway, wasting the search-result title budget. Removing
  // only that exact trailing date is source-neutral and often turns an
  // otherwise valid question into the required 35–65 character range.
  return question.replace(CURIOSITY_TITLE_FULL_DATE_SUFFIX_RE, "?");
}

function curiosityTitleSourceText(content) {
  return [
    content?.sourceText,
    content?.sourceExtract,
    ...sourcePagesFromContent(content).flatMap((page) => [
      page.pageTitle,
      page.text,
      page.extract,
      ...(page.supportedClaims || []),
    ]),
  ]
    .filter(Boolean)
    .join(" ");
}

function validateCuriosityTitleForPublish(content) {
  const question = String(content?.curiosityTitle || "").replace(/\s+/g, " ").trim();
  const reasons = [];
  if (!question) {
    return { ok: false, reasons: ["missing the source-grounded public question title"] };
  }
  if (
    question.length < CURIOSITY_TITLE_MIN_LENGTH ||
    question.length > CURIOSITY_TITLE_MAX_LENGTH
  ) {
    reasons.push(
      `public question title must be ${CURIOSITY_TITLE_MIN_LENGTH}-${CURIOSITY_TITLE_MAX_LENGTH} characters (got ${question.length})`,
    );
  }
  if (!CURIOSITY_TITLE_START_RE.test(question)) {
    reasons.push("public question title must begin with How, Why, What, Who, Which, or Where");
  }
  if (!question.endsWith("?") || (question.match(/\?/g) || []).length !== 1) {
    reasons.push("public question title must contain exactly one question mark at the end");
  }
  if (/[!]|(?:\s+[-—]\s+)[A-Z][a-z]+\s+\d{1,2},/i.test(question)) {
    reasons.push("public question title must not contain hype punctuation or a date suffix");
  }
  if (CURIOSITY_TITLE_GENERIC_RE.test(question)) {
    reasons.push("public question title uses a generic or sensational clickbait formula");
  }

  const topicText = [
    content?.eventTitle,
    content?.sourceEventHeadline,
    content?.sourcePageTitle,
    ...sourcePagesFromContent(content).map((page) => page.pageTitle),
  ].filter(Boolean).join(" ");
  const questionTokens = [...new Set(sourcePageRelevanceTokens(question))];
  const topicTokens = new Set(sourcePageRelevanceTokens(topicText));
  const topicOverlap = questionTokens.filter((token) => topicTokens.has(token));
  const requiredTopicOverlap = Math.min(2, topicTokens.size);
  if (requiredTopicOverlap > 0 && topicOverlap.length < requiredTopicOverlap) {
    reasons.push("public question title does not retain a recognizable event subject");
  }

  const sourceTokens = new Set(sourcePageRelevanceTokens(curiosityTitleSourceText(content)));
  const angleTokens = questionTokens.filter(
    (token) =>
      !topicTokens.has(token) &&
      !CURIOSITY_TITLE_ANGLE_STOPWORDS.has(token),
  );
  const neutralChronologyFallback =
    /^How Did (?:the )?.+ Unfold\?$/i.test(question) &&
    topicOverlap.length >= requiredTopicOverlap &&
    sourceTokens.size > 0;
  if (
    !neutralChronologyFallback &&
    !angleTokens.some((token) => sourceTokens.has(token))
  ) {
    reasons.push("public question title lacks a distinct niche angle supported by the source text");
  }

  return { ok: reasons.length === 0, reasons, title: question };
}

function repairCuriosityTitleFromSource(content) {
  const sourceSubjects = [
    content?.sourcePageTitle,
    ...sourcePagesFromContent(content).map((page) => page.pageTitle),
  ]
    .map((value) =>
      String(value || "")
        .replace(/_/g, " ")
        .replace(/\s*\([^)]*\)\s*$/, "")
        .replace(/\s+[-—]\s+.*$/, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);

  for (const rawSubject of [...new Set(sourceSubjects)]) {
    const subject = rawSubject.replace(
      /\b[a-z][a-z']*/g,
      (word) => word.charAt(0).toUpperCase() + word.slice(1),
    );
    const article = /^(?:a|an|the)\b/i.test(subject) ? "" : "the ";
    const candidate = `How Did ${article}${subject} Unfold?`;
    if (
      candidate.length < CURIOSITY_TITLE_MIN_LENGTH ||
      candidate.length > CURIOSITY_TITLE_MAX_LENGTH
    ) {
      continue;
    }
    const validation = validateCuriosityTitleForPublish({
      ...content,
      curiosityTitle: candidate,
    });
    if (validation.ok) {
      content.curiosityTitle = candidate;
      return candidate;
    }
  }
  return "";
}

function historicalYearFields(content) {
  const found = [];
  const add = (field, value) => {
    const year = Number.parseInt(value, 10);
    if (Number.isInteger(year) && year > 0) found.push({ field, year });
  };

  add("historicalYear", content?.historicalYear);
  add(
    "historicalDateISO",
    String(content?.historicalDateISO || "").match(/^(\d{3,4})-\d{2}-\d{2}$/)?.[1],
  );
  add(
    "historicalDate",
    String(content?.historicalDate || "").match(/\b(\d{3,4})\s*$/)?.[1],
  );
  add(
    "title",
    String(content?.title || "").match(
      /\s+[-—]\s+[A-Z][a-z]+\s+\d{1,2},\s*(\d{3,4})\s*$/,
    )?.[1],
  );
  return found;
}

/**
 * Deterministic semantic publication contract for fields where a confident
 * local decision is possible. Deeper actor/action and relationship checks stay
 * in the source-grounding AI gate, but this function ensures malformed titles
 * and conflicting historical years can never reach public KV even if an
 * enrichment pass rewrites them after generation.
 */
function validateContentSemanticsForPublish(content) {
  const reasons = [];
  const titleLead = getTitleLead(content?.title);
  const eventLead = getTitleLead(content?.eventTitle);
  const leads = [...new Set([titleLead, eventLead].filter(Boolean))];

  if (leads.length === 0) {
    reasons.push("headline is missing");
  }

  for (const lead of leads) {
    if (isWeakCtaTitleLead(lead)) {
      reasons.push(`headline is a call to action rather than an event clause: "${lead}"`);
    }
    if (headlineStartsWithUnsupportedImperative(lead)) {
      reasons.push(`headline starts with an unsupported imperative and has no actor: "${lead}"`);
    }
    const repaired = repairStackedTitleLead(lead);
    if (repaired && repaired !== lead) {
      reasons.push(`headline contains a stacked trailing action: "${lead}"`);
    }
  }

  // Once the selected Wikipedia event sentence has been locked, later SEO or
  // enrichment passes must not replace it with a different central claim.
  const sourceLead = getTitleLead(content?.sourceEventHeadline);
  if (sourceLead) {
    for (const [field, lead] of [["title", titleLead], ["eventTitle", eventLead]]) {
      if (lead && normalizeForCompare(lead) !== normalizeForCompare(sourceLead)) {
        reasons.push(`${field} no longer matches the locked source event headline`);
      }
    }
  }

  const years = historicalYearFields(content);
  const distinctYears = [...new Set(years.map(({ year }) => year))];
  if (distinctYears.length > 1) {
    reasons.push(
      `historical year conflict: ${years.map(({ field, year }) => `${field}=${year}`).join(" | ")}`,
    );
  }

  const visibleUrlValidation = validateVisibleProseForPublish(content);
  reasons.push(...visibleUrlValidation.reasons);

  for (const field of ["analysisGood", "analysisBad"]) {
    (Array.isArray(content?.[field]) ? content[field] : []).forEach((item, index) => {
      if (analysisLooksLikeArticleSelfReview(item?.detail)) {
        reasons.push(
          `${field}[${index}].detail reviews the article instead of analyzing the historical event`,
        );
      }
    });
  }

  return { ok: reasons.length === 0, reasons };
}

function visibleArticleProseEntries(content = {}) {
  const entries = [];
  const add = (field, value) => {
    if (typeof value === "string" && value.trim()) entries.push({ field, value });
  };
  for (const field of [
    "title",
    "curiosityTitle",
    "eventTitle",
    "description",
    "ogDescription",
    "twitterDescription",
    "imageAlt",
    "jsonLdName",
    "jsonLdDescription",
    "editorialNote",
    "eyewitnessQuote",
    "eyewitnessQuoteSource",
  ]) {
    add(field, content?.[field]);
  }
  for (const field of [
    "didYouKnowFacts",
    "overviewParagraphs",
    "eyewitnessOrChronicle",
    "aftermathParagraphs",
    "conclusionParagraphs",
  ]) {
    (Array.isArray(content?.[field]) ? content[field] : []).forEach((value, index) =>
      add(`${field}[${index}]`, value),
    );
  }
  (Array.isArray(content?.quickFacts) ? content.quickFacts : []).forEach((fact, index) => {
    add(`quickFacts[${index}].label`, fact?.label);
    add(`quickFacts[${index}].value`, fact?.value);
  });
  for (const field of ["analysisGood", "analysisBad"]) {
    (Array.isArray(content?.[field]) ? content[field] : []).forEach((item, index) => {
      add(`${field}[${index}].title`, item?.title);
      add(`${field}[${index}].detail`, item?.detail);
    });
  }
  (Array.isArray(content?.timeline) ? content.timeline : []).forEach((item, index) => {
    add(`timeline[${index}].date`, item?.date);
    add(`timeline[${index}].label`, item?.label);
  });
  return entries;
}

function rawUrlsInVisibleText(value) {
  const text = plainText(value);
  return [...text.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"']+/gi)]
    .map((match) => match[0].replace(/[),.;!?]+$/, ""))
    .filter(Boolean);
}

function validateVisibleProseForPublish(content) {
  const reasons = [];
  for (const { field, value } of visibleArticleProseEntries(content)) {
    const urls = rawUrlsInVisibleText(value);
    if (urls.length > 0) {
      reasons.push(`${field} contains a raw visible URL: ${urls[0]}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

function deriveHistoricalYear(content) {
  const explicitYear = Number.parseInt(content?.historicalYear, 10);
  if (Number.isInteger(explicitYear) && explicitYear > 0) return explicitYear;

  const isoYear = String(content?.historicalDateISO || "").match(/^(\d{4})-\d{2}-\d{2}$/);
  if (isoYear) return Number.parseInt(isoYear[1], 10);

  const textYear = String(content?.historicalDate || "").match(/\b(\d{4})\b/);
  if (textYear) return Number.parseInt(textYear[1], 10);

  const titleYear = String(content?.title || "").match(/\b(\d{4})\b/);
  if (titleYear) return Number.parseInt(titleYear[1], 10);

  return null;
}

function formatHistoricalDate(month, day, year) {
  if (!Number.isInteger(month) || !Number.isInteger(day) || !Number.isInteger(year)) {
    return "";
  }
  return `${MONTH_NAMES[month - 1]} ${day}, ${year}`;
}

function buildCanonicalTitle(eventTitle, historicalDate) {
  const baseTitle =
    String(eventTitle || "")
      .replace(/\s+[-—]\s+.*$/, "")
      .trim() || "Historical Event";
  return historicalDate ? `${baseTitle} — ${historicalDate}` : baseTitle;
}

// SEO budget for the headline portion of a title (everything before " — Month
// Day, Year"). The full <title> shown in search results should stay near ~60
// chars; the date suffix is ~14-21 chars, so the headline itself targets ~50.
// A Wikipedia event sentence whose shortest complete clause exceeds this is
// NOT truncated into a fragment — sourceEventHeadline returns "" and the caller
// falls back to the AI's purpose-written concise headline instead.
const HEADLINE_SEO_MAX = 50;

// Upper bound for a complete DESCRIPTIVE source clause kept when nothing shorter
// works. A complete, information-rich sentence (e.g. "Ten people are killed in a
// shooting at a VTA rail yard in San Jose") is always preferred over a shorter
// but abbreviated/incomplete label ("VTA Rail Yard Shooting Kills") — the
// May 26, 2026 incident. We shorten only when it does not cost information.
const HEADLINE_SOURCE_MAX = 75;

const HEADLINE_ACTION_VERB_PATTERN =
  "founds?|founded|forms?|formed|creates?|created|establishes?|established|" +
  "launches?|launched|opens?|opened|holds?|held|honors?|honored|honours?|honoured|" +
  "signs?|signed|adopts?|adopted|ratifies|ratified|declares?|declared|" +
  "begins?|began|ends?|ended|falls?|fell|rises?|rose|kills?|killed|dies?|died|" +
  "assassinates?|assassinated|elects?|elected|discovers?|discovered|invents?|invented|" +
  "publishes?|published|lands?|landed|strikes?|struck|meets?|met|negotiates?|negotiated|" +
  "agrees?|agreed|accepts?|accepted|announces?|announced|passes?|passed|approves?|approved|" +
  "rejects?|rejected|orders?|ordered|visits?|visited|rules?|ruled|crashes?|crashed|" +
  "explodes?|exploded|sinks?|sank|sunk|shoots?|shot|surrenders?|surrendered|defeats?|defeated|" +
  "deports?|deported|fires?|fired|collapses?|collapsed|destroys?|destroyed|" +
  "bombs?|bombed|" +
  "burns?|burned|vanishes?|vanished|disappears?|disappeared|ignites?|ignited|" +
  "erupts?|erupted|plunges?|plunged|escapes?|escaped|acquits?|acquitted|" +
  "convicts?|convicted|executes?|executed|rescues?|rescued|detains?|detained|" +
  "arrests?|arrested|resigns?|resigned|appoints?|appointed|invades?|invaded|" +
  "withdraws?|withdrew|survives?|survived|captures?|captured|liberates?|liberated|" +
  "frees?|freed|imprisons?|imprisoned|flees?|fled|disintegrates?|disintegrated";
const HEADLINE_ACTION_VERB_RE = new RegExp(`\\b(?:${HEADLINE_ACTION_VERB_PATTERN})\\b`, "i");
const HEADLINE_ACTION_VERB_ONLY_RE = new RegExp(`^(?:${HEADLINE_ACTION_VERB_PATTERN})$`, "i");
const HEADLINE_STRUCTURAL_PRESENT_RE =
  /\b\w{6,}(?:ates|ites|etes|odes|ides|ades|izes|ises|aves|ives|oves|apes|anes|ines|ones|enes)\b/i;
const HEADLINE_STRUCTURAL_ES_RE =
  /\b\w{5,}(?:ashes|ishes|ushes|aches|arches|atches|etches|itches|ches|shes)\b/i;
const HEADLINE_STRUCTURAL_PAST_RE =
  /\b\w{7,}(?:ated|ited|eted|oded|ided|aded|ized|ised|aved|ived|oved|aped)\b/i;

function hasFiniteHeadlineVerb(value) {
  const s = String(value || "");
  return HEADLINE_ACTION_VERB_RE.test(s) ||
    HEADLINE_STRUCTURAL_PRESENT_RE.test(s) ||
    HEADLINE_STRUCTURAL_ES_RE.test(s) ||
    HEADLINE_STRUCTURAL_PAST_RE.test(s);
}

// Like hasFiniteHeadlineVerb but strips participial modifier clauses first.
// A participial adjective (", killed in action", ", born in London") modifies
// the preceding noun and is not the sentence's finite predicate. Accepting it
// produces headless noun phrases like "servicemen, killed in action" as titles.
function hasMainClauseVerb(s) {
  const stripped = String(s || "").replace(/,\s+\w+(?:ed|en)\b.*/i, "").trim();
  return hasFiniteHeadlineVerb(stripped);
}

function compactPersonNameForHeadline(value) {
  const words = String(value || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^\w\s'.-]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.']+$/g, ""))
    .filter(Boolean)
    .filter((word) => !/^[A-Z]\.?$/i.test(word))
    .filter((word) => !/^(the|of|de|da|del|der|van|von|bin|al)$/i.test(word));
  return words[words.length - 1] || "";
}

function compactNamedMeetingHeadline(firstSentence, maxLength = HEADLINE_SEO_MAX) {
  const sentence = String(firstSentence || "").replace(/\s+/g, " ").trim();
  const role =
    "(?:President|Premier|Prime Minister|Chancellor|Secretary|General|King|Queen|Pope|Emperor|Chairman|Chairwoman|Minister)";
  const honorificPrefix = "(?:(?:U\\.S\\.|US|United States|Soviet|Russian|British|French|German|Chinese|Japanese|Indian|Israeli|Egyptian|American)\\s+)*";
  const meetingRe = new RegExp(
    `^${honorificPrefix}${role}\\s+(.+?)\\s+(meets?|met)\\s+with\\s+${honorificPrefix}${role}\\s+(.+?)(?:\\s+(?:in|at|near|during|amid|for|to)\\b|$)`,
    "i",
  );
  const match = sentence.match(meetingRe);
  if (!match) return "";

  const subject = compactPersonNameForHeadline(match[1]);
  const object = compactPersonNameForHeadline(match[3]);
  if (!subject || !object) return "";

  const verb = /^met$/i.test(match[2]) ? "Met" : "Meets";
  let headline = `${subject} ${verb} ${object}`;

  const summitMatch = sentence.match(
    /\b([A-Z][A-Za-z0-9'.-]+(?:\s+[A-Z][A-Za-z0-9'.-]+){0,3}\s+(?:Summit|Conference|Talks|Accords|Treaty|Council))\b/,
  );
  if (summitMatch) {
    const eventLabel = summitMatch[1]
      .replace(/\bConference Conference\b/i, "Conference")
      .replace(/\bSummit Conference\b/i, "Summit")
      .trim();
    const withEvent = `${headline} at ${eventLabel}`;
    if (withEvent.length <= maxLength) headline = withEvent;
  }

  return headline.length <= maxLength && hasMainClauseVerb(headline) ? headline : "";
}

function getTitleLead(title) {
  return String(title || "")
    .replace(/\s+[-—]\s+.*$/, "")
    .trim();
}

function repairPromotionalTitleLead(value) {
  const lead = String(value || "").replace(/\s+/g, " ").trim();
  const match = lead.match(/^([^:]{1,40}):\s*(.+)$/);
  if (!match || !isWeakCtaTitleLead(match[1])) return lead;
  const factualLead = match[2].trim();
  const hasSelfContainedFinalVerb =
    /\b(?:begins?|ends?|erupts?|falls?|rises?|dies?|crashes?|explodes?|sinks?|sank|disintegrates?|collapses?|vanishes?|disappears?|resigns?|survives?|opens?|launches?)$/i.test(
      factualLead,
    );
  return factualLead &&
    !isWeakCtaTitleLead(factualLead) &&
    hasFiniteHeadlineVerb(factualLead) &&
    (!titleEndsWithVerb(factualLead) || hasSelfContainedFinalVerb)
    ? factualLead
    : lead;
}

// Derives a short NOUN-PHRASE label from a (possibly clause-style) event title for use
// in "What led to {X}?" / answer-first sentence slots. The display <title>/<h1> are NOT
// changed. Verb-pattern-independent (the title's verb may not be a recognized headline
// verb, e.g. "puts"): a short title is already a noun phrase; otherwise prefer the
// proper-noun object after a trailing preposition ("...to Magna Carta"), then the
// trailing run of capitalized words, else a safe generic fallback.
function eventNounLabel(content) {
  const raw = getTitleLead(content?.eventTitle || content?.title || "").trim();
  if (!raw) return "this event";
  const words = raw.split(/\s+/);
  let label = "";
  // Already a short noun phrase (e.g. "Battle of Hastings", "Magna Carta").
  if (words.length <= 4 && /^[A-Z]/.test(raw)) {
    label = raw;
  } else {
    // Proper-noun object after a trailing preposition ("...to Magna Carta",
    // "...of Waterloo"). A genuine object reached through a real preposition.
    const tail = raw.match(/\b(?:to|of|at|in|on|over|for|against)\s+([A-Z][\w''.-]*(?:\s+(?:of|the|and|de|la)?\s*[A-Z][\w''.-]*)*)\s*$/);
    if (tail && tail[1]) {
      label = tail[1].trim();
    } else {
      // Clause-style sentence-cased title ("Pan Am Flight 121 crashes in the
      // Syrian Desert near Mayadin, Syria"): the SUBJECT is the topic, not a
      // trailing location. Take the leading proper-noun run up to the first
      // lowercase word (the verb). The old code grabbed the trailing capitalized
      // run instead and produced "Syria" (June 19, 2026 "What caused Syria?").
      const subject = raw.match(
        /^([A-Z][\w''.-]*(?:\s+(?:[A-Z][\w''.-]*|\d{1,4}|of|the|and|de|la))*?)\s+[a-z]/,
      );
      label = subject && subject[1] ? subject[1].trim() : "";
    }
  }
  // Sanity guard: a usable label is a NOUN phrase, not a clause. A Title-Cased
  // clause has no lowercase verb boundary, so the extraction above can return the
  // whole thing or a long fragment that still carries a finite verb — yielding
  // broken questions like "What caused ABC News Abruptly Cuts Broadcast Kills?"
  // (June 20, 2026). Reject any label that is empty, runs long, or still ends on
  // / contains an action verb, and fall back to the generic label.
  if (
    !label ||
    label.split(/\s+/).length > 6 ||
    titleEndsWithVerb(label) ||
    hasFiniteHeadlineVerb(label)
  ) {
    return "this event";
  }
  return label;
}

function sourcePageRelevanceTokens(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !SOURCE_PAGE_RELEVANCE_STOPWORDS.has(word));
}

function selectPrimarySourcePage(eventText, pages) {
  const normalizedPages = normalizeSourcePages(pages);
  if (normalizedPages.length <= 1) return normalizedPages[0] || null;
  const eventTokens = new Set(sourcePageRelevanceTokens(eventText));
  const eventNormalized = normalizeForCompare(eventText);
  let best = normalizedPages[0];
  let bestScore = -1;
  for (const page of normalizedPages) {
    const titleTokens = sourcePageRelevanceTokens(page.pageTitle);
    const extractTokens = new Set(sourcePageRelevanceTokens(page.extract));
    const titleOverlap = titleTokens.filter((word) => eventTokens.has(word)).length;
    let extractOverlap = 0;
    for (const word of eventTokens) if (extractTokens.has(word)) extractOverlap++;
    const extractCoverage = eventTokens.size > 0 ? extractOverlap / eventTokens.size : 0;
    const normalizedTitle = normalizeForCompare(page.pageTitle);
    const exactTitleBonus = normalizedTitle && eventNormalized.includes(normalizedTitle) ? 12 : 0;
    const eventPageBonus = SOURCE_EVENT_PERSON_PAGE_RE.test(page.pageTitle) ? 8 : 0;
    const score = titleOverlap * 18 + extractCoverage * 100 + exactTitleBonus + eventPageBonus;
    if (score > bestScore) {
      best = page;
      bestScore = score;
    }
  }
  return best;
}

function repairStackedTitleLead(value) {
  const lead = String(value || "").replace(/\s+/g, " ").trim();
  const match = lead.match(/\s+(Kills|Crashes|Dies|Declares Independence|Rules Unconstitutional|Ratified|Signed|Opens|Launches|Founded|Established)$/i);
  if (!match) return lead;
  const before = lead.slice(0, -match[0].length).trim();
  return before && hasFiniteHeadlineVerb(before) ? before : lead;
}

function buildDisplayTitle(currentTitle, eventTitle, historicalDate) {
  const currentLead = repairStackedTitleLead(
    repairPromotionalTitleLead(getTitleLead(currentTitle)),
  );
  const eventLead = repairStackedTitleLead(
    repairPromotionalTitleLead(getTitleLead(eventTitle)),
  );
  const lead =
    (currentLead && hasFiniteHeadlineVerb(currentLead) && !isWeakCtaTitleLead(currentLead) ? currentLead : "") ||
    (eventLead && !isWeakCtaTitleLead(eventLead) ? eventLead : "") ||
    "Historical Event";
  return historicalDate ? `${lead} — ${historicalDate}` : lead;
}

function isWeakCtaTitleLead(value) {
  const lead = String(value || "").trim();
  if (!lead) return true;
  return /^(discover|uncover|explore|join|learn|read|meet|watch|see|inside|remembering|a look at|the story of|what happened|why it matters)\b/i.test(lead) ||
    /\b(details of|story behind|history of|what happened)\b/i.test(lead);
}

// maskAbbreviationPeriods + extractFirstSentence are imported from
// ./shared/seo-text.js (single source of truth, also used by seo-worker).
// They mask periods inside abbreviations ("U.S.", "Dr.") and single-letter
// initials so a sentence split does not collapse "U.S. Congress passes…" to
// "U.S" (the June 9, 2026 "U.S — June 9, 1938" incident).

// Wikipedia "On This Day" entries often prepend a topic tag like
// "Napoleonic Wars:", "World War II:", "Cold War:", "American Civil War:"
// before the real event clause. The tag is not part of the headline and only
// inflates its length (the June 18, 2026 "Napoleonic Wars: …by the Duke"
// incident). Strip a leading run of 2-4 capitalized words (with small
// connectors) ending in a colon. A single capitalized word before the colon is
// left alone so a real subject ("Lincoln: …") is never eaten.
function stripLeadingTopicPrefix(text) {
  const out = String(text || "").replace(
    /^[A-Z][\w&.'-]*(?:\s+(?:of|the|and|&|[A-Z0-9][\w&.'-]*)){1,3}\s*:\s+/,
    "",
  );
  // Only accept the stripped form when a substantial clause remains.
  return out.length >= 15 ? out : String(text || "");
}

function sourceEventHeadline(eventText, maxLength = HEADLINE_SEO_MAX) {
  const firstSentence = stripLeadingTopicPrefix(
    extractFirstSentence(eventText).replace(/\s*\([^)]*\)\s*/g, " "),
  )
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!firstSentence) return "";
  if (firstSentence.length <= maxLength) return firstSentence;

  const compactMeetingHeadline = compactNamedMeetingHeadline(firstSentence, maxLength);
  if (compactMeetingHeadline) return compactMeetingHeadline;

  // Strategy 1: split on coordinating conjunction (and/but/while/after/before)
  const firstClause = firstSentence
    .split(/\s+(?:and|but|while|after|before)\s+/i)[0]
    .replace(/[,;:]$/, "")
    .trim();
  if (
    firstClause.length >= 35 &&
    firstClause.length <= maxLength &&
    hasMainClauseVerb(firstClause)
  ) {
    return firstClause;
  }

  // Strategy 2: accumulate comma-separated parts until we exceed maxLength,
  // keeping the longest prefix that has a verb and meets the minimum length.
  // Handles "Subject verb object, location, additional context..." — the
  // longest valid prefix is usually the most descriptive headline.
  const commaParts = firstSentence.split(/,\s+/);
  let commaBuilder = "";
  let bestCommaClause = "";
  for (const part of commaParts) {
    const candidate = commaBuilder ? `${commaBuilder}, ${part}` : part;
    if (candidate.length > maxLength) break;
    if (candidate.length >= 35 && hasMainClauseVerb(candidate)) {
      bestCommaClause = candidate;
    }
    commaBuilder = candidate;
  }
  if (bestCommaClause) return bestCommaClause;

  // Strategy 3: word-boundary truncation — but ONLY when the cut lands on a
  // natural clause boundary (sentence end, comma/semicolon/colon, or a
  // coordinating conjunction). Truncating in the MIDDLE of a phrase silently
  // drops the key object and produces a fragment ("…by the Duke" — Duke of
  // whom?; "…results in the defeat" — of whom?). Rather than emit that, we
  // return "" so the caller uses the AI's concise headline. We still strip a
  // trailing function word first so the boundary check sees a clean prefix.
  const TRAILING_FUNCTION_WORD_RE = /\s+(?:by|of|in|to|for|from|with|on|at|about|as|into|over|after|before|against|between|during|under|within|without|upon|onto|the|a|an|and|but|or|nor)$/i;
  let truncated = firstSentence.slice(0, maxLength).replace(/\s+\S*$/, "").trim();
  while (TRAILING_FUNCTION_WORD_RE.test(truncated)) {
    truncated = truncated.replace(TRAILING_FUNCTION_WORD_RE, "").trim();
  }
  const remainder = firstSentence.slice(truncated.length);
  const cutIsClean = /^\s*(?:$|[,;:]|\s(?:and|but|or|nor|while|after|before)\b)/i.test(
    remainder,
  );
  if (cutIsClean && truncated.length >= 35 && hasMainClauseVerb(truncated)) {
    return truncated;
  }

  return "";
}

// truncateForMeta is imported from ./shared/seo-text.js (single source of
// truth, also used by seo-worker for date-page meta descriptions).

function eventTitleFromCandidate(parsedTitle, candidate) {
  const aiTitle = repairPromotionalTitleLead(
    String(parsedTitle || "").replace(/\s+[-—]\s+.*$/, "").trim(),
  );
  const pageTitle = String(candidate?.pageTitle || "").trim();
  const eventText = String(candidate?.text || "").replace(/\s+/g, " ").trim();
  // Tier 1 — a complete source clause within the tight SEO budget (best case:
  // short AND complete).
  const sourceHeadline = sourceEventHeadline(eventText);
  if (sourceHeadline) return sourceHeadline;

  // Tier 2 — the AI's purpose-written concise headline, but only when it is a
  // genuinely complete clause: a strong action verb that is NOT the last word
  // (so it has an object). This rejects the May 26 stacked-label anti-pattern
  // "VTA Rail Yard Shooting Kills" (ends on a bare verb, no object) while
  // accepting "Battle of Waterloo Ends Napoleon's Reign".
  const aiIsCompleteHeadline =
    aiTitle &&
    aiTitle.length <= HEADLINE_SEO_MAX &&
    aiTitle.toLowerCase() !== pageTitle.toLowerCase() &&
    !isWeakCtaTitleLead(aiTitle) &&
    hasStrongTitleAction(aiTitle) &&
    !titleEndsWithVerb(aiTitle) &&
    !/\b(Founding|Creation|Launch|Opening|Completion|Presentation)\b$/i.test(aiTitle);
  if (aiIsCompleteHeadline) return aiTitle;

  // Tier 3 — a longer COMPLETE descriptive source clause. A complete sentence
  // that carries the facts beats an abbreviated label, even when it runs past
  // the tight budget (the May 26 descriptive-over-abbreviated principle).
  const descriptiveHeadline = sourceEventHeadline(eventText, HEADLINE_SOURCE_MAX);
  if (descriptiveHeadline) return descriptiveHeadline;

  // Tier 4 — curated/derived event title, then the AI title, then the page
  // title. Never a "…"-truncated fragment.
  const evidenceTitle = deriveCtaEventTitle(pageTitle || aiTitle, eventText);
  if (evidenceTitle && evidenceTitle !== pageTitle) return evidenceTitle;
  if (
    aiTitle &&
    aiTitle.toLowerCase() !== pageTitle.toLowerCase() &&
    !isWeakCtaTitleLead(aiTitle) &&
    hasStrongTitleAction(aiTitle)
  ) {
    return aiTitle;
  }
  return aiTitle && !isWeakCtaTitleLead(aiTitle) ? aiTitle : pageTitle;
}

function restoreSourceEventHeadline(content) {
  const sourceHeadline = getTitleLead(content?.sourceEventHeadline);
  if (!sourceHeadline) return false;

  content.eventTitle = sourceHeadline;
  content.title = buildCanonicalTitle(sourceHeadline, content.historicalDate);
  content.jsonLdName = sourceHeadline;
  if (Array.isArray(content.quickFacts)) {
    content.quickFacts = content.quickFacts.map((fact) =>
      fact && /^Event$/i.test(fact.label || "")
        ? { ...fact, value: sourceHeadline }
        : fact,
    );
  }
  return true;
}

function alignContentDateFields(content, canonical = {}) {
  const safeContent = content || {};
  const targetMonthDay =
    extractMonthDayCandidate(canonical?.historicalDateISO) ||
    extractMonthDayCandidate(canonical?.historicalDate) ||
    extractMonthDayCandidate(safeContent?.historicalDateISO) ||
    extractMonthDayCandidate(safeContent?.historicalDate) ||
    extractMonthDayCandidate(safeContent?.title);

  // The canonical argument carries the publication/feed date solely to pin the
  // month/day (dual-calendar events, AI date drift). Its YEAR is the current
  // publication year, which is NEVER a valid historical year for an "On This
  // Day" article — the event always happened in an earlier year. We therefore
  // derive the historical year only from the content (or an explicit
  // canonical.historicalYear override that callers may set). We deliberately do
  // NOT fall back to deriveHistoricalYear(canonical): doing so would stamp the
  // publication year (2026, 2027, …) onto the article every year. If the
  // content has no derivable year, the date fields are left untouched and the
  // downstream date validation rejects the post rather than publishing a
  // future-dated "historical" event.
  const year =
    Number.parseInt(canonical?.historicalYear, 10) ||
    deriveHistoricalYear(safeContent);

  if (targetMonthDay && Number.isInteger(year) && year > 0) {
    safeContent.historicalDateISO = `${String(year).padStart(4, "0")}-${String(targetMonthDay.month).padStart(2, "0")}-${String(targetMonthDay.day).padStart(2, "0")}`;
    safeContent.historicalDate = formatHistoricalDate(
      targetMonthDay.month,
      targetMonthDay.day,
      year,
    );
    safeContent.historicalYear = year;
  }

  const canonicalEventTitle =
    String(canonical?.eventTitle || safeContent?.eventTitle || "")
      .replace(/\s+[-—]\s+.*$/, "")
      .trim();
  if (canonicalEventTitle) {
    safeContent.eventTitle = canonicalEventTitle;
  }
  if (safeContent.eventTitle && safeContent.historicalDate) {
    safeContent.title = buildDisplayTitle(
      safeContent.title,
      safeContent.eventTitle,
      safeContent.historicalDate,
    );
  }

  if (Array.isArray(safeContent.quickFacts)) {
    safeContent.quickFacts = safeContent.quickFacts.map((fact) => {
      if (!fact || typeof fact !== "object") return fact;
      if (/^Event$/i.test(fact.label || "")) {
        return { ...fact, value: safeContent.eventTitle || fact.value };
      }
      if (/^Date$/i.test(fact.label || "")) {
        return { ...fact, value: safeContent.historicalDate || fact.value };
      }
      return fact;
    });
  }

  if (safeContent.jsonLdName && safeContent.eventTitle) {
    safeContent.jsonLdName = safeContent.eventTitle;
  }

  return safeContent;
}

function enforceSelectedEventDate(content, selectedEvent) {
  if (!content || !selectedEvent) return content;
  const monthDay =
    extractMonthDayCandidate(selectedEvent.historicalDateISO) ||
    extractMonthDayCandidate(selectedEvent.historicalDate);
  const year =
    Number.parseInt(selectedEvent.historicalYear, 10) ||
    deriveHistoricalYear(selectedEvent);
  if (!monthDay || !Number.isInteger(year) || year <= 0) return content;

  const dateText = formatHistoricalDate(monthDay.month, monthDay.day, year);
  const isoText = `${String(year).padStart(4, "0")}-${String(monthDay.month).padStart(2, "0")}-${String(monthDay.day).padStart(2, "0")}`;
  const previous = {
    historicalDate: content.historicalDate,
    historicalYear: content.historicalYear,
    historicalDateISO: content.historicalDateISO,
    title: content.title,
  };

  if (selectedEvent.sourceEventHeadline) {
    content.sourceEventHeadline = selectedEvent.sourceEventHeadline;
  }
  content.eventTitle = String(
    content.sourceEventHeadline ||
    content.eventTitle ||
    selectedEvent.eventTitle ||
    "",
  ).replace(/\s+[-—]\s+.*$/, "").trim();
  content.historicalDate = dateText;
  content.historicalYear = year;
  content.historicalDateISO = isoText;
  content.title = content.sourceEventHeadline
    ? buildCanonicalTitle(content.eventTitle, dateText)
    : buildDisplayTitle(content.title, content.eventTitle || selectedEvent.eventTitle, dateText);
  if (content.eventTitle) content.jsonLdName = content.eventTitle;

  if (Array.isArray(content.quickFacts)) {
    content.quickFacts = content.quickFacts.map((fact) => {
      if (!fact) return fact;
      if (/^Event$/i.test(fact.label || "") && content.sourceEventHeadline) {
        return { ...fact, value: content.eventTitle };
      }
      return /^Date$/i.test(fact.label || "")
        ? { ...fact, value: dateText }
        : fact;
    });
  }

  const changed = JSON.stringify(previous) !== JSON.stringify({
    historicalDate: content.historicalDate,
    historicalYear: content.historicalYear,
    historicalDateISO: content.historicalDateISO,
    title: content.title,
  });
  if (changed) {
    console.warn(
      `Date guard: enforced selected-event date for ${content.eventTitle || selectedEvent.eventTitle}: ${previous.historicalDate || previous.historicalYear || "unknown"} -> ${dateText}`,
    );
  }
  return content;
}

function isGenericEventPageTitle(pageTitle) {
  const normalized = normalizeTopicMatchText(pageTitle);
  if (!normalized) return true;
  const genericTitles = new Set([
    "egypt",
    "pakistan",
    "croatia",
    "great britain",
    "world war ii",
    "american revolutionary war",
    "byzantine empire",
    "president of romania",
    "royal thai armed forces",
    "united states congress",
    "act of parliament",
    "soviet mars program",
    "venera program",
    "space shuttle program",
  ]);
  return genericTitles.has(normalized);
}

function eventFamiliesFromText(...values) {
  const haystack = normalizeTopicMatchText(values.filter(Boolean).join(" "));
  if (!haystack) return [];
  return EVENT_FAMILY_RULES
    .filter((rule) => rule.pattern.test(haystack))
    .map((rule) => rule.name);
}

function eventFamiliesForCandidate(event) {
  return eventFamiliesFromText(event?.pageTitle, event?.text);
}

function collectRecentEventFamilies(index, targetDate, days = EVENT_FAMILY_REPEAT_WINDOW_DAYS) {
  const targetMs =
    targetDate && typeof targetDate.getTime === "function"
      ? targetDate.getTime()
      : Date.parse(String(targetDate || ""));
  if (!Array.isArray(index) || !Number.isFinite(targetMs)) return [];
  const cutoffMs = targetMs - days * 24 * 60 * 60 * 1000;
  return [
    ...new Set(
      index
        .filter((entry) => {
          const publishedMs = Date.parse(entry?.publishedAt || "");
          return Number.isFinite(publishedMs) && publishedMs < targetMs && publishedMs >= cutoffMs;
        })
        .flatMap((entry) => eventFamiliesFromText(entry.eventTitle, entry.title)),
    ),
  ];
}

function filterRecentEventFamilyRepeats(events, recentFamilies) {
  if (!Array.isArray(events) || events.length === 0) {
    return { candidates: [], suppressed: [], fallbackUsed: false };
  }
  const recent = new Set(Array.isArray(recentFamilies) ? recentFamilies : []);
  if (recent.size === 0) {
    return { candidates: events, suppressed: [], fallbackUsed: false };
  }

  const annotated = events.map((event) => ({
    ...event,
    eventFamilies: eventFamiliesForCandidate(event),
  }));
  const suppressed = annotated.filter((event) =>
    event.eventFamilies.some((family) => recent.has(family)),
  );
  const candidates = annotated.filter((event) =>
    event.eventFamilies.every((family) => !recent.has(family)),
  );

  // Keep publication possible on unusually narrow dates where every usable
  // event repeats a recent family; otherwise the cooldown is a hard filter.
  return candidates.length > 0
    ? { candidates, suppressed, fallbackUsed: false }
    : { candidates: annotated, suppressed, fallbackUsed: suppressed.length > 0 };
}

function scoreBlogEventCandidate(event) {
  const haystack = normalizeTopicMatchText(
    `${event?.pageTitle || ""} ${event?.text || ""}`,
  );
  const title = normalizeTopicMatchText(event?.pageTitle || "");
  let score = 0;

  // Dedicated event pages are usually a better article seed than broad country
  // or institution pages attached to an event blurb.
  if (/^\d{4}\b/.test(title)) score += 10;

  // --- Editorial tone balance (2026-06-26) ----------------------------------
  // The daily feed used to read as a relentless catalogue of tragedies: disaster
  // and violence keywords were worth +28 with another +24 for death verbs, while
  // discoveries, inventions, and cultural milestones were worth nothing (and
  // foundings were actively penalised). The weights below give constructive,
  // world-shaping events equal footing with catastrophe so the most significant
  // event of a date wins on merit rather than on body count.

  // Tragedy / violence / disaster — significant, but no longer auto-dominant.
  if (
    /\b(crash|flight|helicopter|disaster|bomb\w*|shooting|massacre|assassinat\w*|deport\w*|wildfire|fire|explo\w*|earthquake|tsunami|famine|epidemic|pandemic|hijack\w*|genocide)\b/.test(
      haystack,
    )
  ) {
    score += 14;
  }
  // Armed conflict / political upheaval (tragedy-adjacent, kept moderate).
  if (
    /\b(battle|war|warfare|invasion|invades|coup|revolution|crisis|siege|uprising|rebellion|insurgency)\b/.test(
      haystack,
    )
  ) {
    score += 14;
  }
  // Royal/papal successions used to triple-dip: the election/coronation token
  // earned the +22 milestone bonus, the pope/king/emperor token earned the +20
  // figure bonus, and a "death of ..." predecessor added +10 — so any obscure
  // medieval succession out-scored genuinely famous events (July 11 2026:
  // Pope Adrian V at 60 beat To Kill a Mockingbird at 44 and Srebrenica at 26).
  // A succession now earns one modest bonus and must prove real-world fame
  // through the pageview notability re-rank instead.
  if (ROYAL_SUCCESSION_PATTERN.test(haystack)) {
    score += 12;
  } else {
    // Constructive / world-shaping milestones — discoveries, inventions, science,
    // medicine, culture, civil rights, exploration, independence, and peace. Given
    // equal footing with catastrophe so triumphs surface as often as tragedies.
    if (
      /\b(discover\w*|invent\w*|breakthrough|premiere|publish\w*|founded|founding|establish\w*|independence|treaty|peace|elect(?:ed|ion|oral|s)|coronation|crown\w*|expedition|spaceflight|orbit\w*|vaccine|nobel|unveil\w*|inaugurat\w*|charter\w*|abolish\w*|suffrage)\b/.test(
        haystack,
      )
    ) {
      score += 22;
    }
    // Globally recognised figures — a significance and person-richness signal.
    if (
      /\b(president|prime minister|foreign minister|king|queen|emperor|pope|monarch|supreme leader|head of state|john f kennedy|martin luther king|winston churchill|napoleon|atat rk|ataturk|anne boleyn)\b/.test(
        haystack,
      )
    ) {
      score += 20;
    }
  }
  // Human-loss outcomes — kept low so loss does not dominate selection by itself.
  if (
    /\b(kill\w*|dead|dies|death|beheaded|surrenders|defeat|defeats)\b/.test(
      haystack,
    )
  ) {
    score += 10;
  }
  // Neutral state-action verbs.
  if (/\b(ratifies|cedes|annexes)\b/.test(haystack)) {
    score += 8;
  }
  if (
    /\b(global audience|billion|world s first|first man made|first national|all on board|foreign minister|president of iran|treaty of guadalupe hidalgo|turkish war of independence|nullification crisis|battle of rocroi)\b/.test(
      haystack,
    )
  ) {
    score += 22;
  }
  if (Number.parseInt(event?.year, 10) >= 1900) score += 4;
  if (event?.hasThumbnail) score += 4;
  if (Number.parseInt(event?.extractLength, 10) >= 450) score += 4;

  if (isGenericEventPageTitle(event?.pageTitle)) score -= 22;
  if (
    /\b(sports?|football club|club|team|league|match|cycling|race|birthday salute|commemoration day|awareness day|testing day|mother s day)\b/.test(
      haystack,
    )
  ) {
    score -= 32;
  }
  // Founded / established / opened are no longer penalised — they are now positive
  // signals above (a nation founded, a landmark opened). Only genuinely low-value
  // personal/administrative items stay suppressed.
  if (/\b(birthday|appointed)\b/.test(haystack)) {
    score -= 8;
  }
  if (/\b(local|regional|vocational school|municipal)\b/.test(haystack)) {
    score -= 10;
  }
  // Natural/astronomical phenomena are not human-history events; penalise heavily so
  // they never out-score major historical events that share a date.
  if (/\b(asteroid|meteorite|comet|near-earth|meteor shower)\b/.test(haystack)) score -= 30;

  return score;
}

function rankBlogEventCandidates(events) {
  return events
    .map((event) => ({
      ...event,
      editorialScore: scoreBlogEventCandidate(event),
    }))
    .sort((a, b) => {
      if (b.editorialScore !== a.editorialScore) {
        return b.editorialScore - a.editorialScore;
      }
      return Number.parseInt(b.year, 10) - Number.parseInt(a.year, 10);
    });
}

// ---------------------------------------------------------------------------
// Pageview notability re-rank (2026-07-11). Keyword scores cannot tell a
// world-famous event from an obscure one that happens to share vocabulary, so
// the top-ranked candidates are re-ordered by editorial score PLUS a bonus
// derived from their Wikipedia page's monthly pageviews. Every failure path
// fails open (bonus 0, editorial order preserved).
// ---------------------------------------------------------------------------
const PAGEVIEW_RERANK_TOP_N = 8;
const PAGEVIEW_NOTABILITY_MAX_BONUS = 55;

function pageviewNotabilityBonus(monthlyViews) {
  const views = Number(monthlyViews);
  if (!Number.isFinite(views) || views <= 1000) return 0;
  // log scale: 10k/month → +20, 100k → +40, capped at +55 (~1M+).
  return Math.min(
    PAGEVIEW_NOTABILITY_MAX_BONUS,
    Math.round((Math.log10(views) - 3) * 20),
  );
}

async function fetchMonthlyPageviews(pageTitle, fetchImpl = fetch) {
  const title = String(pageTitle || "").trim();
  if (!title) return 0;
  // Previous full calendar month (the monthly granularity needs whole months).
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  const fmt = (d) => `${d.toISOString().slice(0, 10).replace(/-/g, "")}00`;
  const article = encodeURIComponent(title.replace(/\s+/g, "_"));
  const url =
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/` +
    `all-access/user/${article}/monthly/${fmt(start)}/${fmt(end)}`;
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "thisday.info-blog/1.0 (https://thisday.info)" },
  });
  if (!response?.ok) return 0;
  const data = await response.json();
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.reduce((sum, item) => sum + (Number(item?.views) || 0), 0);
}

async function applyPageviewNotabilityRerank(candidates, fetchImpl = fetch) {
  if (!Array.isArray(candidates) || candidates.length < 2) return candidates;
  const head = candidates.slice(0, PAGEVIEW_RERANK_TOP_N);
  const tail = candidates.slice(PAGEVIEW_RERANK_TOP_N);
  const views = await Promise.all(
    head.map((candidate) =>
      fetchMonthlyPageviews(candidate.pageTitle, fetchImpl).catch(() => 0),
    ),
  );
  const boosted = head.map((candidate, i) => ({
    ...candidate,
    monthlyPageviews: views[i],
    notabilityScore: pageviewNotabilityBonus(views[i]),
    combinedScore:
      (Number.parseInt(candidate.editorialScore, 10) || 0) +
      pageviewNotabilityBonus(views[i]),
  }));
  boosted.sort((a, b) => {
    if (b.combinedScore !== a.combinedScore) {
      return b.combinedScore - a.combinedScore;
    }
    return Number.parseInt(b.year, 10) - Number.parseInt(a.year, 10);
  });
  return [...boosted, ...tail];
}

function truncateSelectorText(value, maxLength = 210) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function formatSelectorEventLine(event, index, { includeScore = false } = {}) {
  const parts = [
    `${index + 1}. ${event.year || "Unknown"}`,
    event.pageTitle ? `${event.pageTitle}` : "Untitled page",
  ];
  const media = event.hasThumbnail ? "image" : "no image";
  const extract = Number.parseInt(event.extractLength, 10) || 0;
  const score = includeScore ? `, editorial priority: ${event.editorialScore}` : "";
  return `${parts.join(": ")} — ${truncateSelectorText(event.text)} (${media}, extract: ${extract}${score})${event.pageUrl ? ` [${event.pageUrl}]` : ""}`;
}

function applyMajorEventGuard(matchedCandidate, candidateEvents) {
  const topCandidate = candidateEvents?.[0] || null;
  if (!matchedCandidate || !topCandidate || matchedCandidate === topCandidate) {
    return matchedCandidate;
  }

  const matchedScore = Number.parseInt(matchedCandidate.editorialScore, 10) || 0;
  const topScore = Number.parseInt(topCandidate.editorialScore, 10) || 0;
  if (topScore >= 60 && topScore >= matchedScore + 30) {
    console.warn(
      `Event selector override: "${matchedCandidate.pageTitle}" scored ${matchedScore}, using higher-priority "${topCandidate.pageTitle}" scored ${topScore}.`,
    );
    return topCandidate;
  }

  return matchedCandidate;
}

async function chooseEventForDate(
  env,
  date,
  takenAllTime = [],
  preferredPillars = [],
  recentPillars = [],
  recentEventFamilies = [],
) {
  const monthName = MONTH_NAMES[date.getUTCMonth()];
  const day = date.getUTCDate();
  const mPad = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dPad = String(day).padStart(2, "0");

  const avoidTitles =
    takenAllTime.length > 0
      ? `Avoid these already-covered topics or anything too closely related:\n${takenAllTime.map((t) => `- ${t}`).join("\n")}\n`
      : "";
  const avoidPillars =
    recentPillars.length > 0
      ? `Avoid these pillar categories — they were used in recent posts and must not repeat back-to-back: ${recentPillars.join(", ")}.\n`
      : "";
  const preferPillars =
    preferredPillars.length > 0
      ? `Prefer one of these underrepresented categories if a strong event exists: ${preferredPillars.join(", ")}.\n`
      : "";

  let candidateEvents = [];
  let allEvents = [];
  try {
    let eventsData =
      (env.EVENTS_KV &&
        (await env.EVENTS_KV.get(`events-data:${mPad}-${dPad}`, {
          type: "json",
        }))) ||
      null;

    if (!eventsData?.events?.length) {
      const apiUrl = `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/all/${mPad}/${dPad}`;
      const response = await fetch(apiUrl, {
        headers: { "User-Agent": "thisday.info-blog/1.0 (https://thisday.info)" },
      });
      if (response.ok) {
        eventsData = await response.json();
        if (env.EVENTS_KV && eventsData?.events?.length) {
          env.EVENTS_KV.put(
            `events-data:${mPad}-${dPad}`,
            JSON.stringify(eventsData),
            { expirationTtl: 7 * 24 * 60 * 60 },
          ).catch(() => {});
        }
      }
    }

    allEvents = (eventsData?.events || [])
      .map((event) => {
        const sourcePages = normalizeSourcePages(event?.pages || []);
        const firstPage = selectPrimarySourcePage(event?.text, sourcePages) || {};
        return {
          year: event?.year,
          text: String(event?.text || "").replace(/\s+/g, " ").trim(),
          pageTitle: String(firstPage.pageTitle || "").trim(),
          pageUrl: String(firstPage.pageUrl || "").trim(),
          hasThumbnail: !!firstPage.imageUrl,
          // Keep the Wikipedia intro extract (not just its length): it grounds the
          // body generation and the credibility gate (2026-06-20). The feed
          // already provides this; no extra fetch needed.
          extract: String(firstPage.extract || "").replace(/\s+/g, " ").trim(),
          extractLength: String(firstPage.extract || "").length,
          sourcePages,
        };
      })
      .filter((event) => event.year && event.text && event.pageTitle);

    candidateEvents = allEvents
      .filter((event) => event.hasThumbnail && event.extractLength >= MIN_CANDIDATE_EXTRACT_CHARS)
      .filter((event) => {
        const haystack = `${event.pageTitle} ${event.text}`.toLowerCase();
        return !takenAllTime.some((taken) =>
          haystack.includes(String(taken || "").toLowerCase()),
        );
      });
    const familyGuard = filterRecentEventFamilyRepeats(candidateEvents, recentEventFamilies);
    if (familyGuard.suppressed.length > 0 && !familyGuard.fallbackUsed) {
      console.log(
        `Event selector: removed ${familyGuard.suppressed.length} candidate(s) repeating recent event families: ${recentEventFamilies.join(", ")}.`,
      );
    } else if (familyGuard.fallbackUsed) {
      console.warn(
        `Event selector: every qualified candidate repeats a recent event family; allowing fallback selection from ${recentEventFamilies.join(", ")}.`,
      );
    }
    candidateEvents = familyGuard.candidates;
    candidateEvents = rankBlogEventCandidates(candidateEvents);
    try {
      candidateEvents = await applyPageviewNotabilityRerank(candidateEvents);
      const preview = candidateEvents
        .slice(0, 3)
        .map(
          (event) =>
            `"${event.pageTitle}" editorial=${event.editorialScore}` +
            (event.monthlyPageviews !== undefined
              ? ` views/mo=${event.monthlyPageviews} combined=${event.combinedScore}`
              : ""),
        )
        .join(" | ");
      console.log(`Event selector: pageview notability re-rank top: ${preview}`);
    } catch (err) {
      console.warn(`Event selector pageview re-rank failed (keeping editorial order): ${err.message}`);
    }
    if (candidateEvents.length > 0) {
      const originalFirst = candidateEvents[0];
      const sourceReady = await selectSourceReadyCandidate(candidateEvents);
      if (sourceReady) {
        candidateEvents = [
          sourceReady,
          ...candidateEvents.filter((candidate) => candidate.pageUrl !== sourceReady.pageUrl),
        ];
        if (sourceReady.pageUrl !== originalFirst?.pageUrl) {
          console.warn(
            `Event selector: skipped "${originalFirst?.pageTitle}" because no independently verified source was found; using "${sourceReady.pageTitle}".`,
          );
        }
      } else {
        console.warn(
          `Event selector: none of the top ${Math.min(candidateEvents.length, SOURCE_READY_EVENT_CANDIDATE_LIMIT)} candidates had a reachable, relevant independent source.`,
        );
        candidateEvents = [];
      }
    }
  } catch (err) {
    console.warn(`Event selector candidate load failed: ${err.message}`);
  }

  if (candidateEvents.length === 0) {
    throw new Error(
      `No source-ready event with two independent publishers was available for ${monthName} ${day}.`,
    );
  }

  const allEventsSection =
    allEvents.length > 0
      ? `First, review the full event inventory for ${monthName} ${day}. Do not choose yet; compare the whole date before using the ranked shortlist.\n` +
        allEvents
          .map((event, index) => formatSelectorEventLine(event, index))
          .join("\n") +
        `\nOnly after reviewing all ${allEvents.length} entries should you choose the article topic.\n`
      : "";

  const candidateSection =
    candidateEvents.length > 0
      ? `Then choose ONLY from this ranked, vetted list of article-ready events for ${monthName} ${day}:\n` +
        candidateEvents
          .map(
            (event, index) =>
              formatSelectorEventLine(event, index, { includeScore: true }),
          )
          .join("\n") +
        `\nThe list is sorted by editorial priority. Prefer the highest-ranked candidate unless it is already covered or clearly unsuitable. Do not invent a different event, year, or title.`
      : `No vetted event list is available, so be extremely conservative and choose only an event you are certain happened on ${monthName} ${day}.`;

  if (candidateEvents.length > 0) {
    const selected = applyMajorEventGuard(candidateEvents[0], candidateEvents);
    const selectedIndex = Math.max(1, candidateEvents.indexOf(selected) + 1);
    const eventTitle = eventTitleFromCandidate(selected.pageTitle, selected);
    const parsed = {
      candidateIndex: selectedIndex,
      reviewedEventCount: allEvents.length,
      eventTitle,
      historicalYear: Number.parseInt(selected.year, 10),
      historicalDate: `${monthName} ${day}, ${selected.year}`,
      historicalDateISO: `${String(selected.year).padStart(4, "0")}-${mPad}-${dPad}`,
      wikiUrl: selected.pageUrl || "",
      strongestRejected: candidateEvents.find((event) => event !== selected)?.pageTitle || "",
      why: "Deterministic top-ranked vetted candidate.",
      sourcePageTitle: selected.pageTitle,
      sourceText: selected.text,
      sourceExtract: selected.extract || "",
      sourcePages: selected.sourcePages || [],
    };
    const canonicalSourceHeadline = sourceEventHeadline(
      selected.text,
      HEADLINE_SOURCE_MAX,
    );
    if (canonicalSourceHeadline && parsed.eventTitle === canonicalSourceHeadline) {
      parsed.sourceEventHeadline = canonicalSourceHeadline;
    }
    const validation = validateContentDateForPublish(parsed, date);
    if (!validation.ok) {
      throw new Error(`Event selector date mismatch. ${validation.reason}`);
    }
    console.log(
      `Event selector: using deterministic vetted candidate #${selectedIndex} "${parsed.eventTitle}".`,
    );
    return parsed;
  }

  const prompt =
    `Select a single real historical event that happened on ${monthName} ${day} in any year.\n` +
    `${avoidTitles}${avoidPillars}${preferPillars}${allEventsSection}${candidateSection}\n` +
    `Requirements:\n` +
    `- The event must actually have happened on ${monthName} ${day}\n` +
    `- Review the full event inventory first, then make the final selection from the ranked vetted list. Do not stop at the first familiar or underrepresented category.\n` +
    `- VARIETY MANDATE: the blog must not read as a daily catalogue of tragedies. Do NOT default to a disaster, crash, shooting, bombing, or battle. When a date also offers a globally significant constructive event — a scientific or medical breakthrough, a world-changing invention or discovery, a landmark cultural moment, a civil-rights or independence milestone, an exploration or space first, a peace treaty — prefer that event, UNLESS the tragedy is genuinely the single most globally recognised thing that happened on this date (e.g. D-Day, 9/11).\n` +
    `- Never choose a niche sports, club, observance, or local item ahead of a globally significant event of ANY kind (constructive or tragic).\n` +
    `- Strongly prefer events with global significance across the full range of human history: scientific and medical breakthroughs, world-changing inventions and discoveries, landmark cultural and artistic moments, civil-rights and independence milestones, exploration and space firsts, and peace treaties — as well as major wars, disasters, and political turning points. A discovery, a first, or a cultural landmark is often the better story than another catastrophe.\n` +
    `- Avoid local or regional sports disasters, niche criminal incidents, or events significant only to a single country\n` +
    `- Avoid events where the Wikipedia page title is just a country name (e.g. "Ghana", "Armenia", "Florida") — those usually mean the article is a generic country page, not a dedicated event article\n` +
    `- Do not choose an event from any other calendar day\n` +
    `- If a vetted event list is provided above, your answer must match one entry from that list\n` +
    `- If a vetted list is provided, include "candidateIndex": N where N is the number (1, 2, 3...) from the ranked vetted list\n` +
    `- Include "reviewedEventCount" with the number of full-inventory entries you reviewed, and "strongestRejected" naming the strongest alternative you rejected\n` +
    `- Respond with JSON only\n` +
    `{"candidateIndex":1,"reviewedEventCount":${allEvents.length},"eventTitle":"Exact title from ranked vetted list","historicalDate":"Month Day, Year","historicalDateISO":"YYYY-MM-DD","wikiUrl":"https://en.wikipedia.org/wiki/Article","strongestRejected":"Candidate title","why":"short reason under 25 words"}`;

  const raw = await callAI(
    env,
    [
      {
        role: "system",
        content:
          "You are a strict historical date selector. Return one candidate event as valid JSON only.",
      },
      { role: "user", content: prompt },
    ],
    { maxTokens: 260, timeoutMs: 15_000, temperature: 0.2 },
  );

  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  const fallbackSelectorResult = (reason) => {
    if (candidateEvents.length === 0) {
      throw new Error(`${reason}: ${raw.slice(0, 160)}`);
    }
    const fallback = candidateEvents[0];
    console.warn(
      `Event selector ${reason}; using top vetted candidate "${fallback.pageTitle}".`,
    );
    return {
      candidateIndex: 1,
      reviewedEventCount: allEvents.length,
      eventTitle: fallback.pageTitle,
      historicalDate: `${monthName} ${day}, ${fallback.year}`,
      historicalDateISO: `${String(fallback.year).padStart(4, "0")}-${mPad}-${dPad}`,
      wikiUrl: fallback.pageUrl,
      strongestRejected: candidateEvents[1]?.pageTitle || "",
      why: "Fallback to highest ranked vetted candidate.",
    };
  };
  let parsed;
  if (!match) {
    parsed = fallbackSelectorResult("returned no JSON");
  } else {
    try {
      parsed = JSON.parse(match[0]);
    } catch (err) {
      parsed = fallbackSelectorResult(`returned malformed JSON (${err.message})`);
    }
  }
  if (!parsed?.eventTitle) {
    throw new Error("Event selector returned no eventTitle");
  }

  if (candidateEvents.length > 0) {
    // Primary: index-based lookup — AI returns the number from the numbered list
    let matchedCandidate = null;
    const idx = Number.parseInt(parsed.candidateIndex, 10);
    if (!Number.isNaN(idx) && idx >= 1 && idx <= candidateEvents.length) {
      matchedCandidate = candidateEvents[idx - 1];
    }

    // Fallback: exact / substring string matching
    if (!matchedCandidate) {
      const normalizedTitle = String(parsed.eventTitle || "").toLowerCase();
      matchedCandidate = candidateEvents.find((event) => {
        return (
          normalizedTitle === event.pageTitle.toLowerCase() ||
          event.pageTitle.toLowerCase().includes(normalizedTitle) ||
          normalizedTitle.includes(event.pageTitle.toLowerCase())
        );
      });
    }

    // Final fallback: word-overlap (handles synonym variants like "shootings" vs "massacre")
    if (!matchedCandidate) {
      const normalizedTitle = String(parsed.eventTitle || "").toLowerCase();
      const stopWords = new Set(["the", "a", "an", "of", "in", "at", "on", "and", "or", "to", "is", "was"]);
      const titleWords = new Set(normalizedTitle.split(/\W+/).filter((w) => w.length > 2 && !stopWords.has(w)));
      if (titleWords.size > 0) {
        matchedCandidate = candidateEvents.find((event) => {
          const candidateWords = new Set(event.pageTitle.toLowerCase().split(/\W+/).filter((w) => w.length > 2 && !stopWords.has(w)));
          let overlap = 0;
          for (const w of titleWords) if (candidateWords.has(w)) overlap++;
          return candidateWords.size > 0 && overlap / Math.min(titleWords.size, candidateWords.size) >= 0.6;
        });
      }
    }

    if (!matchedCandidate) {
      throw new Error(`Event selector chose an event outside the vetted list: ${parsed.eventTitle}`);
    }
    matchedCandidate = applyMajorEventGuard(matchedCandidate, candidateEvents);
    parsed.eventTitle = eventTitleFromCandidate(parsed.eventTitle, matchedCandidate);
    // Lock the title against later SEO rewrites only when it is a source-derived
    // clause (tier 1 or tier 3 of eventTitleFromCandidate). AI-derived headlines
    // are intentionally left unlocked so the SEO pass may still refine them.
    const canonicalSourceHeadline = sourceEventHeadline(
      matchedCandidate.text,
      HEADLINE_SOURCE_MAX,
    );
    if (canonicalSourceHeadline && parsed.eventTitle === canonicalSourceHeadline) {
      parsed.sourceEventHeadline = canonicalSourceHeadline;
    }
    parsed.historicalYear = Number.parseInt(matchedCandidate.year, 10);
    parsed.historicalDate = `${monthName} ${day}, ${matchedCandidate.year}`;
    parsed.historicalDateISO = `${String(matchedCandidate.year).padStart(4, "0")}-${mPad}-${dPad}`;
    if (matchedCandidate.pageUrl) parsed.wikiUrl = matchedCandidate.pageUrl;
    // Authoritative source for grounded generation + the credibility gate.
    parsed.sourcePageTitle = matchedCandidate.pageTitle;
    parsed.sourceText = matchedCandidate.text;
    parsed.sourceExtract = matchedCandidate.extract || "";
    parsed.sourcePages = matchedCandidate.sourcePages || [];
  }

  const validation = validateContentDateForPublish(parsed, date);
  if (!validation.ok) {
    throw new Error(`Event selector date mismatch. ${validation.reason}`);
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Shared support popup (Buy Me a Coffee) — injected before </body> on all pages
// ---------------------------------------------------------------------------
function supportPopupSnippet() {
  return `<style>#supportPopup{position:fixed;inset:0;background:rgba(0,0,0,.35);display:none;justify-content:center;align-items:center;backdrop-filter:blur(2px);z-index:9998;opacity:0;transition:opacity .4s ease}#supportPopup.show{display:flex;opacity:1}.support-popup-content{background:#fff;color:#174832;padding:25px 28px;border-radius:12px;max-width:300px;width:90%;text-align:center;border:1px solid rgba(0,0,0,.12);box-shadow:0 16px 32px -8px rgba(0,0,0,.18);position:relative;animation:popupFadeIn .35s ease}@keyframes popupFadeIn{from{transform:scale(.92);opacity:0}to{transform:scale(1);opacity:1}}.support-close-btn{position:absolute;top:8px;right:10px;border:none;background:transparent;font-size:1.4rem;cursor:pointer;color:#7a8a80;line-height:1;padding:0}.support-close-btn:hover{color:#174832}</style>
<div id="supportPopup"><div class="support-popup-content"><button class="support-close-btn">&times;</button><h4 style="font-size:1rem;margin-bottom:8px">History runs on facts, and this project runs on coffee!</h4><p style="font-size:.9rem;margin-bottom:14px;color:#3a5a48">Your support is incredibly helpful and genuinely appreciated.</p><a href="https://buymeacoffee.com/fugec?new=1" target="_blank" rel="noopener" style="display:inline-block;padding:8px 18px;background:#174832;color:#fff;border:1.5px solid #174832;border-radius:8px;text-decoration:none;font-weight:600;font-size:.9rem">Support with a coffee ☕</a></div></div>
<script>(function(){var p=document.getElementById('supportPopup');var c=p&&p.querySelector('.support-close-btn');if(!p||!c)return;try{var _t=localStorage.getItem('supportPopupClosed');if(_t&&Date.now()-Number(_t)<86400000)return;}catch(e){}var shown=false;var ready=false;var past70=false;function show(){if(shown)return;shown=true;p.classList.add('show');}setTimeout(function(){ready=true;if(past70)show();},60000);setTimeout(function(){show();},90000);window.addEventListener('scroll',function(){var s=window.scrollY+window.innerHeight;var t=document.documentElement.scrollHeight;if(s/t>=0.7){past70=true;if(ready)show();}},{passive:true});c.addEventListener('click',function(){p.classList.remove('show');try{localStorage.setItem('supportPopupClosed',String(Date.now()));}catch(e){}});})();<\/script>`;
}

function staticNavMountMarkup({
  includeMarquee = false,
  supportPopup = false,
} = {}) {
  const opts = [];
  if (includeMarquee) opts.push("includeMarquee: true");
  if (supportPopup) opts.push("supportPopup: true");
  const arg = opts.length ? `{ ${opts.join(", ")} }` : "";
  return `<div data-site-nav></div>
  <script type="module">
    import { mountStaticNav } from "/js/shared/static-layout.js";
    mountStaticNav(${arg});
  </script>`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  /**
   * Cron trigger — runs daily and publishes the current UTC day's post.
   */
  async scheduled(event, env, ctx) {
    const cron = event?.cron || "";
    const scheduledMinute = Number.isFinite(Number(event?.scheduledTime))
      ? new Date(Number(event.scheduledTime)).getUTCMinutes()
      : new Date().getUTCMinutes();
    ctx.waitUntil(
      (async () => {
        // Vet and cache today's source package without starting article AI.
        // The 00:10 generation invocation then begins with a fresh external
        // subrequest budget instead of inheriting source-discovery fetches.
        if (
          cron === DAILY_PUBLICATION_CRON &&
          scheduledMinute === DRAFT_PREPARATION_MINUTE
        ) {
          const guarded = await prepareBlogKvBudget(env, "prepare");
          if (!guarded.budget.allowPhase) return;
          if (guarded.budget.allowOptionalWrites) {
            await checkAndUpdateAiModel(guarded.env, guarded.env.BLOG_AI_KV);
          }
          await maybePrepareBlogDraftSource(guarded.env);
          return;
        }
        // Promote the 00:10 draft in a fresh invocation with its own external
        // subrequest budget. Do not combine generation and enrichment here.
        if (
          cron === DAILY_PUBLICATION_CRON &&
          scheduledMinute === DRAFT_ENRICHMENT_MINUTE
        ) {
          const guarded = await prepareBlogKvBudget(env, "enrich");
          if (!guarded.budget.allowPhase) return;
          await recoverPendingBlogDraft(guarded.env);
          return;
        }
        // Dedicated entity-recovery cron: its own invocation has a fresh subrequest
        // budget, so it can re-resolve people strips that the budget-starved generation
        // cron left unlinked. Runs after the 00:05 generation and 00:35 failsafe.
        if (cron === ENTITY_RECOVERY_CRON) {
          const guarded = await prepareBlogKvBudget(env, "maintenance");
          if (!guarded.budget.allowPhase) return;
          await recoverRecentEntityStrips(guarded.env).catch((err) =>
            console.warn(`Blog AI: entity recovery pass failed — ${err.message}`),
          );
          return;
        }
        if (cron === EVERGREEN_HISTORY_RECOVERY_CRON) {
          const guarded = await prepareBlogKvBudget(env, "maintenance");
          if (!guarded.budget.allowPhase) return;
          await recoverPendingEvergreenHistory(guarded.env).catch((err) =>
            console.warn(`Blog AI: evergreen history pass failed — ${err.message}`),
          );
          return;
        }
        // The 00:10 generation and 00:12 missing-draft retry invocations
        // deliberately fall through here. Keeping the default path also
        // preserves manual scheduled-event compatibility.
        if (
          cron === DAILY_PUBLICATION_CRON &&
          !DRAFT_GENERATION_MINUTES.has(scheduledMinute)
        ) {
          console.warn(
            `Blog AI: unexpected publication minute ${scheduledMinute}; using draft generation path.`,
          );
        } else if (cron && cron !== DAILY_PUBLICATION_CRON) {
          console.warn(`Blog AI: unrecognized cron "${cron}" using draft generation path.`);
        }
        const guarded = await prepareBlogKvBudget(env, "generate");
        if (!guarded.budget.allowPhase) return;
        if (guarded.budget.allowOptionalWrites) {
          await checkAndUpdateAiModel(guarded.env, guarded.env.BLOG_AI_KV);
        }
        await maybeGenerateBlogPost(guarded.env, ctx, {
          preferWorkersAIForArticle:
            cron === DAILY_PUBLICATION_CRON && scheduledMinute === 12,
        });
      })(),
    );
  },

  /**
   * HTTP fetch handler — serves blog pages and the manual trigger endpoint.
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    if (path === "/blog/debug-backfill" && request.method === "GET") {
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.PUBLISH_SECRET || auth !== `Bearer ${env.PUBLISH_SECRET}`) {
        return jsonResponse({ status: "unauthorized" }, 401);
      }
      const testSlug = new URL(request.url).searchParams.get("slug") || "1-may-2026";
      const html = await env.BLOG_AI_KV.get(`${KV_POST_PREFIX}${testSlug}`);
      if (!html) return jsonResponse({ error: "slug not found" }, 404);
      const extractWikiUrl = (doc) => {
        const s = String(doc || "");
        const m = s.match(/href="(https:\/\/en\.wikipedia\.org\/wiki\/[^"]+)"[^>]*>Wikipedia<\/a>/i)
          || s.match(/"url"\s*:\s*"(https:\\\/\\\/en\.wikipedia\.org\\\/wiki\\\/[^"]+)"/i);
        return m ? String(m[1]).replace(/\\\//g, "/") : "";
      };
      const wikiUrl = extractWikiUrl(html);
      const hasFloats = /<figure style="float:(?:right|left);/i.test(html);
      let fetchResult = { tried: false, imgCount: 0, error: null };
      if (wikiUrl && !hasFloats) {
        try {
          const imgs = await fetchEventImages(wikiUrl, "", 2);
          fetchResult = { tried: true, imgCount: imgs.length, error: null, firstUrl: imgs[0]?.imageUrl?.slice(0, 60) };
        } catch (e) {
          fetchResult = { tried: true, imgCount: 0, error: e.message };
        }
      }
      return jsonResponse({ slug: testSlug, wikiUrl, hasFloats, fetchResult });
    }

    if (path === "/blog/debug-ai" && request.method === "GET") {
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.PUBLISH_SECRET || auth !== `Bearer ${env.PUBLISH_SECRET}`) {
        return jsonResponse({ status: "unauthorized" }, 401);
      }
      return jsonResponse({
        status: "ok",
        build: DEBUG_BUILD,
        hasAI: Boolean(env.AI),
        hasGroq: Boolean(env.GROQ_API_KEY),
        hasGroq2: Boolean(env.GROQ_API_KEY_2),
        hasGroq3: Boolean(env.GROQ_API_KEY_3),
        hasGroq4: Boolean(env.GROQ_API_KEY_4),
        hasGroq5: Boolean(env.GROQ_API_KEY_5),
        hasOpenRouter: Boolean(env.OPENROUTER_API_KEY || env.OPENRUITER_API_KEY || env.OPENNRUITER_API_KEY),
        hasOpenRouter2: Boolean(env.OPENROUTER_API_KEY_2 || env.OPENRUITER_API_KEY_2 || env.OPENNRUITER_API_KEY_2),
        hasOpenRouter3: Boolean(env.OPENROUTER_API_KEY_3 || env.OPENRUITER_API_KEY_3 || env.OPENNRUITER_API_KEY_3),
        hasNvidia: Boolean(env.NVIDIA_API_KEY),
      });
    }

    // Failsafe phase 1: vet and cache today's source package in its own Worker
    // invocation. The GitHub workflow follows this with /blog/generate-draft
    // and /blog/enrich, each of which receives a fresh subrequest budget.
    if (path === "/blog/prepare-draft" && request.method === "POST") {
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.PUBLISH_SECRET || auth !== `Bearer ${env.PUBLISH_SECRET}`) {
        return jsonResponse({ status: "unauthorized" }, 401);
      }
      const guarded = await prepareBlogKvBudget(env, "prepare");
      if (!guarded.budget.allowPhase) {
        return kvBudgetBlockedResponse(guarded.budget);
      }
      const budgetEnv = guarded.env;
      try {
        const result = await maybePrepareBlogDraftSource(budgetEnv);
        return jsonResponse({
          status: "ok",
          slug: buildSlug(new Date()),
          message: "Blog draft source prepared.",
          result,
          kvBudget: publicKvWriteBudget(guarded.budget),
        });
      } catch (err) {
        const today = todayDateString();
        console.error(`Blog AI: /blog/prepare-draft failed — ${err.message}`);
        await recordPipelineFailure(budgetEnv, {
          step: "blog",
          slug: today,
          message: err.message,
          date: new Date(),
        });
        await optionalBlogKvPut(
          budgetEnv,
          `error:${today}`,
          `Draft preparation endpoint failed: ${err.message}`,
          { expirationTtl: 7 * 86_400 },
        );
        return jsonResponse({ status: "error", message: err.message }, 500);
      }
    }

    // Failsafe phase 2: generate a lightweight draft from the cached source
    // package without consuming the enrichment invocation's request budget.
    if (path === "/blog/generate-draft" && request.method === "POST") {
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.PUBLISH_SECRET || auth !== `Bearer ${env.PUBLISH_SECRET}`) {
        return jsonResponse({ status: "unauthorized" }, 401);
      }
      const guarded = await prepareBlogKvBudget(env, "generate");
      if (!guarded.budget.allowPhase) {
        return kvBudgetBlockedResponse(guarded.budget);
      }
      const budgetEnv = guarded.env;
      try {
        const preferWorkersAIForArticle =
          url.searchParams.get("prefer-workers-ai") === "true";
        await generateAndStore(budgetEnv, null, null, null, null, {
          lightweightPublish: true,
          enrichDraft: false,
          preferWorkersAIForArticle,
        });
        return jsonResponse({
          status: "ok",
          slug: buildSlug(new Date()),
          message: "Blog draft generated.",
          kvBudget: publicKvWriteBudget(guarded.budget),
        });
      } catch (err) {
        const today = todayDateString();
        console.error(`Blog AI: /blog/generate-draft failed — ${err.message}`);
        await recordPipelineFailure(budgetEnv, {
          step: "blog",
          slug: today,
          message: err.message,
          date: new Date(),
        });
        await optionalBlogKvPut(
          budgetEnv,
          `error:${today}`,
          `Draft endpoint failed: ${err.message}`,
          { expirationTtl: 7 * 86_400 },
        );
        return jsonResponse({ status: "error", message: err.message }, 500);
      }
    }

    // Manual trigger (POST /blog/publish)
    // Requires:  Authorization: Bearer <PUBLISH_SECRET>  (blog failsafe)
    //        or  Authorization: Bearer <YOUTUBE_REGEN_SECRET>  (YouTube regen)
    if (path === "/blog/publish" && request.method === "POST") {
      const auth = request.headers.get("Authorization") ?? "";
      const validPublish =
        env.PUBLISH_SECRET && auth === `Bearer ${env.PUBLISH_SECRET}`;
      const validYtRegen =
        env.YOUTUBE_REGEN_SECRET &&
        auth === `Bearer ${env.YOUTUBE_REGEN_SECRET}`;
      if (!validPublish && !validYtRegen) {
        return jsonResponse({ status: "unauthorized" }, 401);
      }
      const guarded = await prepareBlogKvBudget(env, "publish");
      if (!guarded.budget.allowPhase) {
        return kvBudgetBlockedResponse(guarded.budget);
      }
      const budgetEnv = guarded.env;
      try {
        const publishUrl = new URL(request.url);
        const forcedEvent = publishUrl.searchParams.get("force-event") || null;
        const forceDate = publishUrl.searchParams.get("force-date") || null;
        const forceImage = publishUrl.searchParams.get("force-image") || null;
        // Pass null ctx so enrichPublishedPost runs synchronously in the HTTP
        // response path (up to ~100s Cloudflare edge timeout) rather than in
        // ctx.waitUntil which is capped at 30s for HTTP handlers on the free
        // plan. The cron handler passes its own ctx for the normal daily path.
        await generateAndStore(budgetEnv, null, forcedEvent, forceDate, forceImage, {
          lightweightPublish: true,
        });
        console.log(`Blog AI: /blog/publish complete. ${aiUsageSummary()}`);
        return jsonResponse({
          status: "ok",
          message: "Blog post published.",
          kvBudget: publicKvWriteBudget(guarded.budget),
        });
      } catch (err) {
        console.error(
          `Blog AI: /blog/publish generation failed — ${err.message}`,
        );
        console.log(`Blog AI: /blog/publish failed. ${aiUsageSummary()}`);
        const today = todayDateString();
        await recordPipelineFailure(budgetEnv, {
          step: "blog",
          slug: today,
          message: err.message,
          date: new Date(),
        });
        await optionalBlogKvPut(
          budgetEnv,
          `error:${today}`,
          `Publish endpoint failed: ${err.message}`,
          { expirationTtl: 7 * 86_400 },
        );
        return jsonResponse({ status: "error", message: err.message }, 500);
      }
    }

    if (path === "/blog/enrich" && request.method === "POST") {
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.PUBLISH_SECRET || auth !== `Bearer ${env.PUBLISH_SECRET}`) {
        return jsonResponse({ status: "unauthorized" }, 401);
      }
      const enrichUrl = new URL(request.url);
      const slug = enrichUrl.searchParams.get("slug") || "";
      if (!slug) {
        return jsonResponse({ status: "error", message: "Provide ?slug=X" }, 400);
      }
      const guarded = await prepareBlogKvBudget(env, "enrich");
      if (!guarded.budget.allowPhase) {
        return kvBudgetBlockedResponse(guarded.budget);
      }
      const budgetEnv = guarded.env;
      // Default requests return immediately and run enrichment in ctx.waitUntil.
      // Manual recovery can request ?sync=true to keep the work in the response
      // path when background lifetime is too short to promote an existing draft.
      // Diagnostic: confirm this handler was reached (not inside ctx.waitUntil)
      await optionalBlogKvPut(
        budgetEnv,
        `debug:enrich-handler:${slug}`,
        JSON.stringify({ ts: new Date().toISOString(), slug }),
        { expirationTtl: 7 * 86_400 },
      );
      const recordEnrichError = async (err) => {
        console.error(`Blog AI: enrichment failed for ${slug} — ${err.message}`);
        await recordPipelineFailure(budgetEnv, {
          step: "blog",
          slug,
          message: err.message,
          date: new Date(),
        });
        await optionalBlogKvPut(
          budgetEnv,
          `debug:enrich-error:${slug}`,
          JSON.stringify({ error: err.message, stack: err.stack?.slice(0, 500), ts: new Date().toISOString() }),
          { expirationTtl: 7 * 86_400 },
        );
      };
      const boundedRecovery =
        enrichUrl.searchParams.get("bounded") === "true";
      if (enrichUrl.searchParams.get("sync") === "true") {
        try {
          await enrichPublishedPost(budgetEnv, slug, { boundedRecovery });
          return jsonResponse({
            status: "ok",
            slug,
            message: "Enrichment completed.",
            kvBudget: publicKvWriteBudget(guarded.budget),
          });
        } catch (err) {
          await recordEnrichError(err);
          return jsonResponse({ status: "error", slug, message: err.message }, 500);
        }
      }
      ctx.waitUntil(
        enrichPublishedPost(budgetEnv, slug, { boundedRecovery }).catch(recordEnrichError),
      );
      return jsonResponse({
        status: "ok",
        slug,
        message: "Enrichment started.",
        kvBudget: publicKvWriteBudget(guarded.budget),
      });
    }

    if (path === "/blog/backfill-entities" && request.method === "POST") {
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.PUBLISH_SECRET || auth !== `Bearer ${env.PUBLISH_SECRET}`) {
        return jsonResponse({ status: "unauthorized" }, 401);
      }
      const params = new URL(request.url).searchParams;
      const targetSlug = params.get("slug");
      const bfLimit = Math.min(parseInt(params.get("limit") || "5", 10), 20);
      const bfOffset = parseInt(params.get("offset") || "0", 10);
      const since = params.get("since") || null; // e.g. "2026-03-01"
      const skipExisting = params.get("skip_existing") !== "false";
      const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
      const index = indexRaw ? JSON.parse(indexRaw) : [];
      const sorted = [...index].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
      let pool = targetSlug
        ? sorted.filter((e) => e.slug === targetSlug)
        : since
          ? sorted.filter((e) => e.publishedAt && e.publishedAt.slice(0, 10) >= since)
          : sorted.slice(0, 1);
      if (!pool.length) {
        return jsonResponse({ status: "error", message: "No matching posts found." }, 404);
      }
      if (skipExisting && !targetSlug) {
        const checks = await Promise.all(
          pool.map((e) =>
            env.BLOG_AI_KV.get(`post-entities:${e.slug}`, { type: "text" })
              .then((v) => ({ slug: e.slug, exists: v !== null }))
              .catch(() => ({ slug: e.slug, exists: false })),
          ),
        );
        const enriched = new Set(checks.filter((c) => c.exists).map((c) => c.slug));
        pool = pool.filter((e) => !enriched.has(e.slug));
      }
      const total = pool.length;
      const targets = pool.slice(bfOffset, bfOffset + bfLimit);
      if (!targets.length) {
        return jsonResponse({ status: "ok", message: "All posts in range already enriched.", total: 0, results: [], nextOffset: null });
      }
      const results = [];
      for (const entry of targets) {
        try {
          const entities = await backfillEntitiesForEntry(env, entry);
          results.push({ slug: entry.slug, status: "ok", entities: entities.length });
        } catch (err) {
          results.push({ slug: entry.slug, status: "error", error: err.message });
        }
      }
      return jsonResponse({
        status: "ok",
        results,
        total,
        offset: bfOffset,
        limit: bfLimit,
        nextOffset: bfOffset + bfLimit < total ? bfOffset + bfLimit : null,
      });
    }

    // Admin: re-generate body sections for existing entity records using the improved prompt.
    // Does NOT re-fetch Wikipedia — uses already-stored intro/summary data.
    // POST /blog/reenrich-entity-sections?type=person&limit=10&offset=0
    if (path === "/blog/reenrich-entity-sections" && request.method === "POST") {
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.PUBLISH_SECRET || auth !== `Bearer ${env.PUBLISH_SECRET}`) {
        return jsonResponse({ status: "unauthorized" }, 401);
      }
      const reenrichParams = new URL(request.url).searchParams;
      const typeFilter = reenrichParams.get("type") || "person";
      const reenrichLimit = Math.min(parseInt(reenrichParams.get("limit") || "10", 10), 30);
      const reenrichOffset = parseInt(reenrichParams.get("offset") || "0", 10);

      const entityIndexRaw = await env.BLOG_AI_KV?.get(KV_ENTITY_INDEX_KEY).catch(() => null);
      if (!entityIndexRaw) return jsonResponse({ status: "error", message: "Entity index not found" }, 404);
      const entityIndex = JSON.parse(entityIndexRaw);
      const reenrichFiltered = typeFilter === "all" ? entityIndex : entityIndex.filter((e) => e.type === typeFilter);
      const reenrichBatch = reenrichFiltered.slice(reenrichOffset, reenrichOffset + reenrichLimit);

      const reenrichResults = [];
      for (const entry of reenrichBatch) {
        try {
          const entityKey = `${KV_ENTITY_PREFIX}${entry.type}:${entry.slug}`;
          const entityRaw = await env.BLOG_AI_KV.get(entityKey);
          if (!entityRaw) { reenrichResults.push({ slug: entry.slug, status: "not_found" }); continue; }
          const entity = JSON.parse(entityRaw);
          const contentProxy = {
            title: entity.sourcePostTitle || entity.name,
            eventTitle: entity.sourcePostTitle || entity.name,
            historicalDate: null,
            location: null,
            description: entity.description || entity.summary || "",
            contentRationale: null,
            keyTerms: [],
          };
          const fallback = buildFallbackEntityBodySections(entity, contentProxy);
          entity.bodySections = await generateEntityBodySections(env, entity, contentProxy, fallback);
          entity.updatedAt = new Date().toISOString();
          const wordCount = (entity.bodySections || [])
            .flatMap((s) => (Array.isArray(s.paragraphs) ? s.paragraphs : []))
            .join(" ").split(/\s+/).filter(Boolean).length;
          await env.BLOG_AI_KV.put(entityKey, JSON.stringify(entity));
          reenrichResults.push({ slug: entry.slug, type: entry.type, status: "ok", sections: entity.bodySections.length, wordCount });
        } catch (err) {
          reenrichResults.push({ slug: entry.slug, type: entry.type, status: "error", error: err.message });
        }
      }
      // Bulk-update indexable flags in the entity index for the processed batch
      const updatedIndexable = new Map(
        reenrichResults
          .filter((r) => r.status === "ok")
          .map((r) => [`${r.type}:${r.slug}`, r.wordCount >= 150]),
      );
      if (updatedIndexable.size > 0) {
        const idxRaw = await env.BLOG_AI_KV?.get(KV_ENTITY_INDEX_KEY).catch(() => null);
        if (idxRaw) {
          const idx = JSON.parse(idxRaw);
          for (const entry of idx) {
            const key = `${entry.type}:${entry.slug}`;
            if (updatedIndexable.has(key)) entry.indexable = updatedIndexable.get(key);
          }
          await env.BLOG_AI_KV.put(KV_ENTITY_INDEX_KEY, JSON.stringify(idx));
        }
      }
      return jsonResponse({
        status: "ok",
        results: reenrichResults,
        total: reenrichFiltered.length,
        offset: reenrichOffset,
        limit: reenrichLimit,
        nextOffset: reenrichOffset + reenrichLimit < reenrichFiltered.length ? reenrichOffset + reenrichLimit : null,
      });
    }

    // Admin: patch SEO meta tags on existing posts without full regeneration
    // POST /blog/regen-seo?slug=22-march-2026   — single post
    // POST /blog/regen-seo?all=true             — all posts in index (sequential)
    if (path === "/blog/regen-seo" && request.method === "POST") {
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.PUBLISH_SECRET || auth !== `Bearer ${env.PUBLISH_SECRET}`) {
        return jsonResponse({ status: "unauthorized" }, 401);
      }
      const regenParams = new URL(request.url).searchParams;
      const targetSlug = regenParams.get("slug");
      const regenAll = regenParams.get("all") === "true";
      const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
      const index = indexRaw ? JSON.parse(indexRaw) : [];
      const slugs = targetSlug
        ? [targetSlug]
        : regenAll
          ? index.map((e) => e.slug)
          : [];
      if (slugs.length === 0) {
        return jsonResponse(
          { status: "error", message: "Provide ?slug=X or ?all=true" },
          400,
        );
      }
      const results = [];
      for (const slug of slugs) {
        try {
          const html = await env.BLOG_AI_KV.get(`${KV_POST_PREFIX}${slug}`);
          if (!html) {
            results.push({ slug, status: "not_found" });
            continue;
          }
          const { updatedHtml, changed, newDescription } = await patchSEOMeta(
            html,
            slug,
            env,
          );
          await env.BLOG_AI_KV.put(`${KV_POST_PREFIX}${slug}`, updatedHtml);
          // Sync description in the index if it changed
          if (newDescription) {
            const idx = index.findIndex((e) => e.slug === slug);
            if (idx !== -1) index[idx].description = newDescription;
          }
          results.push({ slug, status: "updated", changed });
        } catch (err) {
          results.push({ slug, status: "error", error: err.message });
        }
      }
      // Persist updated index (descriptions may have changed)
      await env.BLOG_AI_KV.put(KV_INDEX_KEY, JSON.stringify(index));
      return jsonResponse({ status: "ok", results });
    }

    // Admin: humanize body paragraphs on existing posts to reduce AI detection score
    // POST /blog/regen-humanize?slug=22-march-2026
    if (path === "/blog/regen-humanize" && request.method === "POST") {
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.PUBLISH_SECRET || auth !== `Bearer ${env.PUBLISH_SECRET}`) {
        return jsonResponse({ status: "unauthorized" }, 401);
      }
      const humanizeParams = new URL(request.url).searchParams;
      const targetSlug = humanizeParams.get("slug");
      if (!targetSlug) {
        return jsonResponse(
          { status: "error", message: "Provide ?slug=X" },
          400,
        );
      }
      const html = await env.BLOG_AI_KV.get(`${KV_POST_PREFIX}${targetSlug}`);
      if (!html)
        return jsonResponse(
          { status: "error", message: "Post not found" },
          404,
        );
      const { updatedHtml, changed } = await patchBodyParagraphs(html, env);
      await env.BLOG_AI_KV.put(`${KV_POST_PREFIX}${targetSlug}`, updatedHtml);
      return jsonResponse({ status: "ok", slug: targetSlug, changed });
    }

    // Admin: rewrite stored HTML with response-time page quality normalizations.
    // POST /blog/backfill-page-quality?latest=true
    // POST /blog/backfill-page-quality?all=true
    // POST /blog/backfill-page-quality?slug=22-march-2026
    if (path === "/blog/backfill-page-quality" && request.method === "POST") {
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.PUBLISH_SECRET || auth !== `Bearer ${env.PUBLISH_SECRET}`) {
        return jsonResponse({ status: "unauthorized" }, 401);
      }
      const params = new URL(request.url).searchParams;
      const targetSlug = params.get("slug");
      const backfillLatest = params.get("latest") === "true";
      const backfillAll = params.get("all") === "true";
      const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
      const index = indexRaw ? JSON.parse(indexRaw) : [];
      const latestSlug = [...index]
        .filter((entry) => entry?.slug)
        .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))[0]?.slug;
      const slugs = targetSlug
        ? [targetSlug]
        : backfillLatest
          ? latestSlug
            ? [latestSlug]
            : []
          : backfillAll
            ? index.map((entry) => entry.slug).filter(Boolean)
            : [];
      if (slugs.length === 0) {
        return jsonResponse(
          { status: "error", message: "Provide ?slug=X, ?latest=true, or ?all=true" },
          400,
        );
      }

      const results = [];
      for (const slug of slugs) {
        try {
          const key = `${KV_POST_PREFIX}${slug}`;
          const html = await env.BLOG_AI_KV.get(key);
          if (!html) {
            results.push({ slug, status: "not_found" });
            continue;
          }
          const updatedHtml = prepareHtmlResponse(html);
          if (updatedHtml === html) {
            results.push({ slug, status: "unchanged" });
            continue;
          }
          await env.BLOG_AI_KV.put(key, updatedHtml);
          results.push({
            slug,
            status: "updated",
            bytesBefore: html.length,
            bytesAfter: updatedHtml.length,
          });
        } catch (err) {
          results.push({ slug, status: "error", error: err.message });
        }
      }
      const updated = results.filter((item) => item.status === "updated").length;
      const unchanged = results.filter((item) => item.status === "unchanged").length;
      const errors = results.filter((item) => item.status === "error").length;
      return jsonResponse({
        status: "ok",
        total: results.length,
        updated,
        unchanged,
        errors,
        results,
      });
    }

    // Admin: purge Cloudflare edge cache for all blog post pages
    // POST /blog/purge-cache
    if (path === "/blog/purge-cache" && request.method === "POST") {
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.PUBLISH_SECRET || auth !== `Bearer ${env.PUBLISH_SECRET}`) {
        return jsonResponse({ status: "unauthorized" }, 401);
      }
      const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
      const index = indexRaw ? JSON.parse(indexRaw) : [];
      const cache = caches.default;
      const results = await Promise.allSettled(
        index.map((e) =>
          cache.delete(new Request(`https://thisday.info/blog/${e.slug}/`)),
        ),
      );
      const purged = results.filter((r) => r.status === "fulfilled").length;
      return jsonResponse({ status: "ok", purged, total: index.length });
    }

    // Admin: classify all existing posts into pillars and persist in KV index
    // POST /blog/backfill-pillars           — all unclassified posts
    // POST /blog/backfill-pillars?all=true  — reclassify every post (overwrite)
    if (path === "/blog/backfill-pillars" && request.method === "POST") {
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.PUBLISH_SECRET || auth !== `Bearer ${env.PUBLISH_SECRET}`) {
        return jsonResponse({ status: "unauthorized" }, 401);
      }
      const backfillAll =
        new URL(request.url).searchParams.get("all") === "true";
      const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
      const index = indexRaw ? JSON.parse(indexRaw) : [];

      const targets = backfillAll
        ? index
        : index.filter((e) => !e.pillars || e.pillars.length === 0);

      const results = [];
      for (const e of targets) {
        try {
          const fakeContent = {
            title: e.title,
            eventTitle: e.title,
            keywords: "",
            description: e.description || "",
          };
          const classified = await classifyPillars(env, fakeContent);
          if (classified && classified.length > 0) {
            e.pillars = classified;
            results.push({
              slug: e.slug,
              pillars: classified,
              status: "classified",
            });
          } else {
            results.push({ slug: e.slug, status: "skipped" });
          }
        } catch (err) {
          results.push({ slug: e.slug, status: "error", error: err.message });
        }
      }

      await env.BLOG_AI_KV.put(KV_INDEX_KEY, JSON.stringify(index));
      return jsonResponse({ status: "ok", processed: targets.length, results });
    }

    // POST /blog/backfill-pillar-pills — inject pillar pill HTML into stored posts that lack it
    if (path === "/blog/backfill-pillar-pills" && request.method === "POST") {
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.PUBLISH_SECRET || auth !== `Bearer ${env.PUBLISH_SECRET}`) {
        return jsonResponse({ status: "unauthorized" }, 401);
      }
      const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
      const index = indexRaw ? JSON.parse(indexRaw) : [];
      const targets = index.filter(
        (e) => Array.isArray(e.pillars) && e.pillars.length > 0,
      );
      const results = [];
      for (const entry of targets) {
        try {
          const html = await env.BLOG_AI_KV.get(`${KV_POST_PREFIX}${entry.slug}`);
          if (!html || html.includes("pillar-pill-row")) {
            results.push({ slug: entry.slug, status: "skipped" });
            continue;
          }
          const ps = (str) =>
            str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
          const pillsHtml =
            `<div class="pillar-pill-row justify-content-center mt-3">` +
            entry.pillars
              .slice(0, 3)
              .map((pillar, idx) => {
                const featuredClass = idx === 0 ? " pillar-pill-featured" : "";
                return `<a href="/blog/topic/${ps(pillar)}/" class="pillar-pill${featuredClass}">${pillar}</a>`;
              })
              .join("") +
            `</div>`;
          // Inject just before </header> (new posts) or after article-meta (older posts)
          let patched = html.includes("</header>")
            ? html.replace("</header>", `${pillsHtml}\n          </header>`)
            : html.replace(
                /(<\/p>\s*<\/div>\s*(?=.*?<article))/,
                `$1${pillsHtml}`,
              );
          if (patched === html) {
            results.push({ slug: entry.slug, status: "no-anchor" });
            continue;
          }
          await env.BLOG_AI_KV.put(`${KV_POST_PREFIX}${entry.slug}`, patched);
          results.push({ slug: entry.slug, status: "injected", pillars: entry.pillars });
        } catch (err) {
          results.push({ slug: entry.slug, status: "error", error: err.message });
        }
      }
      return jsonResponse({ status: "ok", processed: targets.length, results });
    }

    if (path === "/blog/archive" || path === "/blog/archive/") {
      return Response.redirect(`${url.origin}/blog/`, 301);
    }

    if (path === "/blog") {
      return serveListing(env);
    }

    const legacyArchivePostMatch = path.match(/^\/blog\/archive\/([^/]+)\/?$/);
    if (legacyArchivePostMatch) {
      return Response.redirect(`${url.origin}/blog/${legacyArchivePostMatch[1]}/`, 301);
    }

    // Pillar hub pages: /blog/topic/:pillar-slug/
    const topicMatch = path.match(/^\/blog\/topic\/([a-z0-9-]+)$/);
    if (topicMatch) {
      return servePillarHub(env, topicMatch[1], url);
    }

    // JSON feed of latest public YouTube videos, merged with blog index for titles/thumbnails
    if (path === "/blog/videos.json") {
      const [indexRaw, ytRaw] = await Promise.all([
        env.BLOG_AI_KV.get(KV_INDEX_KEY),
        env.BLOG_AI_KV.get("youtube:uploaded"),
      ]);
      let index = [];
      if (indexRaw) { try { const t = indexRaw.trimStart(); const s = t.indexOf("["); index = JSON.parse(s > 0 ? t.slice(s) : t); } catch { index = []; } }
      let yt = {};
      if (ytRaw) { try { yt = JSON.parse(ytRaw); } catch { yt = {}; } }
      const indexBySlug = Object.fromEntries(index.map((p) => [p.slug, p]));
      const videos = Object.entries(yt)
        .filter(([, v]) => v.youtubeId && v.privacy !== "private")
        .sort(([, a], [, b]) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
        .slice(0, 6)
        .map(([slug, v]) => {
          const post = indexBySlug[slug] ?? {};
          return {
            slug,
            youtubeId: v.youtubeId,
            title: post.title ?? slug,
            description: post.description ?? "",
            uploadedAt: v.uploadedAt,
            thumbnail:
              VIDEO_THUMBNAIL_OVERRIDES[slug] ??
              `https://img.youtube.com/vi/${v.youtubeId}/hqdefault.jpg`,
          };
        });
      return new Response(JSON.stringify(videos), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    // JSON index used by homepage/blog UI components.
    // Canonical route: /blog/index.json
    // Legacy alias: /blog/archive.json
    if (path === "/blog/index.json" || path === "/blog/archive.json") {
      const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
      let index = [];
      if (indexRaw) {
        try {
          const trimmed = indexRaw.trimStart();
          const jsonStart = trimmed.indexOf("[");
          index = JSON.parse(jsonStart > 0 ? trimmed.slice(jsonStart) : trimmed);
        } catch { index = []; }
      }
      return new Response(JSON.stringify(index), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    // Debug: show what facts would be sent to AI for a slug — GET /blog/quiz-debug/{slug}
    const quizDebugMatch = path.match(/^\/blog\/quiz-debug\/([^/]+)$/);
    if (quizDebugMatch) {
      const slug = quizDebugMatch[1];
      const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
      const index = indexRaw ? JSON.parse(indexRaw) : [];
      const entry = index.find((p) => p.slug === slug);
      if (!entry) return new Response("not found", { status: 404 });
      const content = await buildRichContent(entry, slug);
      const keyFacts = (content.keyFacts || []).slice(0, 5);
      return new Response(
        JSON.stringify(
          {
            keyFactsCount: content.keyFacts?.length,
            keyFacts,
            description: content.description?.substring(0, 200),
          },
          null,
          2,
        ),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // Admin: regenerate quizzes in parallel — POST /blog/preload-quizzes?offset=0&limit=8&force=false
    if (path === "/blog/preload-quizzes" && request.method === "POST") {
      const params = new URL(request.url).searchParams;
      const offset = parseInt(params.get("offset") || "0", 10);
      const limit = Math.min(parseInt(params.get("limit") || "8", 10), 15);
      const force = params.get("force") === "true";
      const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
      const index = indexRaw ? JSON.parse(indexRaw) : [];
      const batch = index.slice(offset, offset + limit);
      const results = await Promise.allSettled(
        batch.map(async (entry) => {
          const kvKey = `quiz-v3:blog:${entry.slug}`;
          if (!force) {
            const existing = await env.BLOG_AI_KV.get(kvKey);
            if (parseValidBlogQuiz(existing)) return { slug: entry.slug, status: "skipped" };
            if (existing) await env.BLOG_AI_KV.delete(kvKey).catch(() => {});
          }
          const content = await buildRichContent(entry, entry.slug);
          const quiz = await generateBlogQuiz(env, content, entry.slug);
          if (quiz) {
            await env.BLOG_AI_KV.put(kvKey, JSON.stringify(quiz), {
              expirationTtl: 90 * 86_400,
            });
            return {
              slug: entry.slug,
              status: "generated",
              questions: quiz.questions.length,
            };
          }
          return { slug: entry.slug, status: "ai_failed" };
        }),
      );
      const out = results.map((r) =>
        r.status === "fulfilled"
          ? r.value
          : { slug: "?", status: "error", msg: r.reason?.message },
      );
      return new Response(
        JSON.stringify(
          { total: index.length, offset, batch: batch.length, results: out },
          null,
          2,
        ),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Blog quiz API: /blog/quiz/{slug}
    const blogQuizMatch = path.match(/^\/blog\/quiz\/(.+)$/);
    if (blogQuizMatch) {
      const slug = blogQuizMatch[1];
      const quizRaw = await env.BLOG_AI_KV.get(`quiz-v3:blog:${slug}`);
      const cachedQuiz = parseValidBlogQuiz(quizRaw);
      if (cachedQuiz) {
        return new Response(JSON.stringify(cachedQuiz), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=86400, s-maxage=0",
          },
        });
      }
      if (quizRaw) {
        await env.BLOG_AI_KV.delete(`quiz-v3:blog:${slug}`).catch(() => {});
      }
      if (blogKvBackgroundWritesPaused(env)) {
        return new Response(JSON.stringify({ error: "Quiz not found" }), {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
      // Quiz not in KV — generate on-demand using rich content from the post HTML
      try {
        const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
        const index = indexRaw ? JSON.parse(indexRaw) : [];
        const entry = index.find((p) => p.slug === slug);
        // Fall back to slug-only when entry not in index (covers old static posts)
        const entryOrFallback = entry || {
          title: slug.replace(/[-/]/g, " "),
          description: "",
        };
        if (hasAnyTextAIProvider(env)) {
          const content = await buildRichContent(entryOrFallback, slug);
          const quiz = await generateBlogQuiz(env, content, slug);
          if (quiz) {
            await env.BLOG_AI_KV.put(
              `quiz-v3:blog:${slug}`,
              JSON.stringify(quiz),
              { expirationTtl: 90 * 86_400 },
            );
            return new Response(JSON.stringify(quiz), {
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "public, max-age=3600",
              },
            });
          }
        }
      } catch (e) {
        console.error("On-demand quiz generation failed:", e);
      }
      return new Response(JSON.stringify({ error: "Quiz not found" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Individual post: /blog/[slug]  (single-segment slugs only — e.g. /blog/20-february-2026)
    // Two-segment paths like /blog/august/1-2025/ are existing static posts — pass them through.
    const postMatch = path.match(/^\/blog\/([^/]+)$/);
    if (postMatch) {
      const slug = postMatch[1];
      const slugParsedForThumb = parseSlugDate(slug);
      const eventsThumbPromise =
        slugParsedForThumb && env.EVENTS_KV
          ? env.EVENTS_KV.get(
              `events-data:${String(slugParsedForThumb.monthIndex + 1).padStart(2, "0")}-${String(slugParsedForThumb.day).padStart(2, "0")}`,
              { type: "json" },
            )
              .then(
                (d) =>
                  d?.events?.find((e) => e.pages?.[0]?.thumbnail?.source)
                    ?.pages?.[0]?.thumbnail?.source || "",
              )
              .catch(() => "")
          : Promise.resolve("");
      const [html, ytRaw, eventsThumb, articleEntitiesRaw] = await Promise.all([
        env.BLOG_AI_KV.get(`${KV_POST_PREFIX}${slug}`),
        env.BLOG_AI_KV.get("youtube:uploaded"),
        eventsThumbPromise,
        env.BLOG_AI_KV.get(`post-entities:${slug}`).catch(() => null),
      ]);
      if (html) {
        const allowArticleKvBackgroundWrites = !blogKvBackgroundWritesPaused(env);
        const extractWikiUrl = (doc) => {
          const s = String(doc || "");
          const m =
            s.match(
              /href="(https:\/\/en\.wikipedia\.org\/wiki\/[^"]+)"[^>]*>Wikipedia<\/a>/i,
            ) ||
            s.match(
              /"url"\s*:\s*"(https:\\\/\\\/en\.wikipedia\.org\\\/wiki\\\/[^"]+)"/i,
            );
          return m ? String(m[1]).replace(/\\\//g, "/") : "";
        };
        const extractCoverSrc = (doc) => {
          const m = String(doc || "").match(
            /<img[^>]+src="\/image-proxy\?src=([^"&]+)[^"]*"/i,
          );
          if (!m) return "";
          try {
            return decodeURIComponent(m[1]);
          } catch {
            return m[1];
          }
        };
        // Patch old quiz API path in already-stored HTML
        let patchedHtml = html.replaceAll("/api/blog-quiz/", "/blog/quiz/");
        patchedHtml = normalizeArticleHistoryDiscoveryCardHtml(
          patchedHtml,
          articleEntitiesRaw,
        );
        // Ensure the "Explore [Month Day] in History" card matches the post slug,
        // not a potentially-wrong AI-provided historicalDateISO.
        if (slugParsedForThumb) {
          const md = `${slugParsedForThumb.monthDisplay} ${slugParsedForThumb.day}`;
          patchedHtml = patchedHtml.replace(
            /<strong>Explore\s+[^<]+?\s+in History<\/strong>/,
            `<strong>Explore ${md} in History</strong>`,
          );
          patchedHtml = patchedHtml.replace(
            /<a href="\/events\/[a-z]+\/\d+\/" class="btn mt-2">View\s+[^<]+?<i /,
            `<a href="/events/${slugParsedForThumb.monthSlug}/${slugParsedForThumb.day}/" class="btn mt-2">View ${md} <i `,
          );
        }
        // Patch raw/relative og:image / twitter:image URLs → absolute 1200x630 image-proxy.
        // Search and social preview parsers are more reliable with absolute image URLs.
        if (!patchedHtml.includes('og:image" content="https://thisday.info/image-proxy')) {
          patchedHtml = patchedHtml.replace(
            /(<meta property="og:image" content=")(https?:\/\/[^"]+)(")/,
            (_, pre, url, post) =>
              `${pre}${buildSocialPreviewImageUrl(url)}${post}`,
          );
          patchedHtml = patchedHtml.replace(
            /(<meta property="og:image" content=")\/image-proxy\?src=([^"]+)(")/,
            "$1https://thisday.info/image-proxy?src=$2$3",
          );
        }
        if (!patchedHtml.includes('twitter:image" content="https://thisday.info/image-proxy')) {
          patchedHtml = patchedHtml.replace(
            /(<meta name="twitter:image" content=")(https?:\/\/[^"]+)(")/,
            (_, pre, url, post) =>
              `${pre}${buildSocialPreviewImageUrl(url)}${post}`,
          );
          patchedHtml = patchedHtml.replace(
            /(<meta name="twitter:image" content=")\/image-proxy\?src=([^"]+)(")/,
            "$1https://thisday.info/image-proxy?src=$2$3",
          );
        }
        patchedHtml = patchedHtml.replace(
          /<meta name="robots" content="index, follow"\s*\/?>/i,
          '<meta name="robots" content="index, follow, max-image-preview:large" />',
        );
        // Patch broken JS apostrophe — \'s inside template literal got unescaped to 's,
        // breaking the JS string literal in showResults()
        patchedHtml = patchedHtml.replace(
          "Previous Day's Story</a>'",
          "Previous Day&#39;s Story</a>'",
        );
        // Patch old quick facts table style → site-table
        if (patchedHtml.includes('class="table table-bordered"')) {
          patchedHtml = patchedHtml
            .replaceAll('class="table table-bordered"', 'class="site-table"')
            .replaceAll('<th scope="row">', "<th>");
          if (!patchedHtml.includes(".site-table{")) {
            const siteTableCss = `<style>.site-table{width:100%;max-width:480px;border-collapse:collapse;border:1.5px solid var(--border,#cfe0cf);border-radius:10px;overflow:hidden;margin-top:1rem;margin-bottom:1.5rem;font-size:.9rem}.site-table th,.site-table td{padding:8px 14px;border-bottom:1px solid var(--border,#cfe0cf);text-align:left;color:var(--text,#1a2e20)}.site-table tr:last-child th,.site-table tr:last-child td{border-bottom:none}.site-table th{background:var(--bg-alt,#f2f7f2);font-weight:600;white-space:nowrap;width:40%}</style>`;
            patchedHtml = patchedHtml.replace(
              "</head>",
              siteTableCss + "</head>",
            );
          }
        }
        // Patch old footer — replace any footer that lacks footer-inner
        if (
          patchedHtml.includes('class="footer"') &&
          !patchedHtml.includes("footer-inner")
        ) {
          patchedHtml = patchedHtml.replace(
            /<footer class="footer">[\s\S]*?<\/footer>\s*(?=<\/body>|<\/html>|$)/,
            siteFooter(),
          );
        }
        // Patch old or partial nav chrome → canonical site nav
        if (!patchedHtml.includes("data-site-nav")) {
          if (patchedHtml.includes('class="navbar')) {
            patchedHtml = patchedHtml.replace(
              /<nav class="navbar[\s\S]*?<\/nav>\s*(?:<div class="marquee-bar"[\s\S]*?<\/div>)?/,
              staticNavMountMarkup({ includeMarquee: true, supportPopup: true }),
            );
          } else if (patchedHtml.includes('class="nav"')) {
            patchedHtml = patchedHtml.replace(
              /<nav class="nav"[\s\S]*?<\/nav>\s*(?:<div class="marquee-bar"[\s\S]*?<\/div>)?/,
              staticNavMountMarkup({ includeMarquee: true, supportPopup: true }),
            );
          }
        }
        patchedHtml = ensureBlogChromeAssets(patchedHtml);
        patchedHtml = injectBlogNavWidthFix(patchedHtml);
        // Always inject correct green palette + Bootstrap overrides — covers old blue-palette posts
        patchedHtml = patchedHtml.replace(
          "</head>",
          `<style>:root{--bg:#ffffff;--bg-alt:#f2f7f2;--text:#1a2e20;--text-muted:#5c7a65;--border:#cfe0cf;--btn-bg:#1b3a2d;--btn-text:#fff;--btn-hover:#2a4d3a;--accent:#9dc43a;--radius:4px;--shadow:0 16px 32px -8px rgba(27,58,45,.08)}body{color:var(--text)!important;background:#fff!important;font-family:Lora,serif!important}.btn-primary,.btn-primary:focus{background:var(--btn-bg)!important;border-color:var(--btn-bg)!important;color:#fff!important}.btn-primary:hover{background:var(--btn-hover)!important;border-color:var(--btn-hover)!important}.btn-outline-primary{color:var(--btn-bg)!important;border-color:var(--btn-bg)!important}.btn-outline-primary:hover{background:var(--btn-bg)!important;color:#fff!important}.text-primary{color:var(--btn-bg)!important}a:not(.btn):not([class*="nav"]):not(.brand):not(.list-group-item):not(.mobile-menu-link){color:var(--btn-bg)}.pillar-pill-row{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-top:.75rem}.pillar-pill{display:inline-flex;align-items:center;justify-content:center;padding:7px 14px;border:1px solid var(--border);border-radius:999px;background:var(--bg-alt);color:var(--btn-bg)!important;font-size:13px;font-weight:400;letter-spacing:.01em;text-decoration:none!important;transition:background .15s ease,border-color .15s ease,color .15s ease}.pillar-pill:hover{background:#e7f0e7;border-color:var(--btn-bg)}.pillar-pill-featured{background:var(--btn-bg)!important;border-color:var(--btn-bg)!important;color:#fff!important}.pillar-pill-featured:hover{background:var(--btn-hover)!important;border-color:var(--btn-hover)!important}.dyn-slider-shell{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center;margin:18px 0}.dyn-slider-btn{display:none;align-items:center;justify-content:center;width:42px;height:42px;border:1.5px solid var(--border);border-radius:999px;background:var(--bg);color:var(--text);font-size:20px;font-weight:400;cursor:pointer;transition:background .15s,border-color .15s,color .15s;flex-shrink:0;line-height:1}.dyn-slider-btn:hover{background:var(--bg-alt);border-color:var(--btn-bg);color:var(--btn-bg)}.dyn-slider-wrap{overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none}.dyn-slider-wrap::-webkit-scrollbar{display:none}.dyn-slider-track{display:flex;gap:14px;padding-bottom:4px}.dyn-slide{flex:0 0 240px;max-width:240px;min-height:220px;scroll-snap-align:start;background:var(--btn-bg);color:#fff;padding:2rem 1.75rem;display:flex;flex-direction:column;justify-content:center;gap:1rem;border-radius:10px}.dyn-slide img,.dyn-slide figure,.dyn-slider-wrap figure{display:none!important}.dyn-slide p{font-size:15px;font-weight:400;text-transform:none;letter-spacing:normal;color:var(--accent);margin:0;line-height:1.6}.dyn-slide .dyn-fact{font-size:15px;font-weight:400;color:#fff;margin:0;line-height:1.6}.dyn-slide .dyn-fact a,.dyn-slide .dyn-fact a:visited,.dyn-slide .dyn-fact a:hover,.dyn-slide .dyn-fact a:focus{color:#fff!important;text-decoration:underline;text-underline-offset:2px}@media(min-width:768px){.dyn-slider-btn{display:inline-flex}}@media(max-width:767px){.dyn-slider-shell{grid-template-columns:minmax(0,1fr)}}</style></head>`,
        );
        // Patch old CSS variable aliases used in early posts
        patchedHtml = patchedHtml
          .replaceAll("var(--card-bg)", "var(--bg)")
          .replaceAll("var(--text-color)", "var(--text)")
          .replaceAll("var(--primary-bg)", "var(--btn-bg)")
          .replaceAll("var(--footer-bg)", "var(--bg-alt)")
          .replaceAll("var(--link-color)", "var(--btn-bg)")
          .replaceAll("var(--secondary-bg)", "var(--bg)");
        // Patch Bootstrap primary button classes → site btn
        patchedHtml = patchedHtml
          .replaceAll('class="btn btn-primary', 'class="btn')
          .replaceAll("class='btn btn-primary", "class='btn")
          .replaceAll('class="btn btn-outline-secondary', 'class="btn')
          .replaceAll("class='btn btn-outline-secondary", "class='btn");
        // Inject NAV_CSS + FOOTER_CSS if missing
        if (!patchedHtml.includes(".nav-inner")) {
          patchedHtml = patchedHtml.replace(
            "</head>",
            `<style>${NAV_CSS}\n${FOOTER_CSS}</style></head>`,
          );
        }
        // Remove old dark theme JS and CSS
        patchedHtml = patchedHtml.replace(
          /<script\b[^>]*>(?:(?!<\/script>)[\s\S])*(?:setTheme|darkTheme|dark-theme|DARK_THEME)(?:(?!<\/script>)[\s\S])*<\/script>/g,
          "",
        );
        patchedHtml = patchedHtml.replace(/body\.dark-theme\s*\{[^}]*\}/g, "");
        patchedHtml = patchedHtml.replace(
          /body\.dark-theme[^{]*\{[^}]*\}/g,
          "",
        );
        // Add navToggle script if missing
        patchedHtml = patchedHtml.replace(
          /<script>\s*\(function\(\)\{var t=document.getElementById\("navToggle"\),m=document.getElementById\("navMobile"\)[\s\S]*?<\/script>/g,
          "",
        );
        patchedHtml = patchedHtml.replace(
          /<script>\s*\(function\(\)\{var bar=document.getElementById\('marqueeBar'\),track=document.getElementById\('marqueeTrack'\)[\s\S]*?<\/script>/g,
          "",
        );
        // Patch legacy H2 headings — old posts used "Overview: EventTitle", "Eyewitness Accounts of EventTitle",
        // "Aftermath of EventTitle", "Legacy of EventTitle". Strip the suffix so headings are clean and short.
        patchedHtml = patchedHtml
          .replace(/(<h2[^>]*>)Overview:\s[^<]+(<\/h2>)/g, "$1Overview$2")
          .replace(
            /(<h2[^>]*>)Eyewitness Accounts of\s[^<]+(<\/h2>)/g,
            "$1Eyewitness Accounts$2",
          )
          .replace(/(<h2[^>]*>)Aftermath of\s[^<]+(<\/h2>)/g, "$1Aftermath$2")
          .replace(/(<h2[^>]*>)Legacy of\s[^<]+(<\/h2>)/g, "$1Legacy$2");
        // Patch image caption — replace any AI-generated caption with correct Wikimedia attribution
        patchedHtml = patchedHtml.replace(
          /<figcaption class="article-meta mt-2">\s*<small>(?!Image courtesy of)[\s\S]*?<\/small>\s*<\/figcaption>/,
          '<figcaption class="article-meta mt-2"><small>Image courtesy of <a href="https://commons.wikimedia.org/" target="_blank" rel="noopener noreferrer">Wikimedia Commons</a>.</small></figcaption>',
        );
        // Patch legacy Did You Know bullet boxes into the card slider used by newer posts.
        patchedHtml = replaceLegacyDidYouKnowBlocks(patchedHtml);
        // Wrap header + figure in article-hero-wrap for mobile full-bleed hero.
        // Only applies to old posts that don't have the wrapper yet.
        let _heroPatched = false;
        if (!patchedHtml.includes('article-hero-wrap') && patchedHtml.includes('<header class="mb-4 text-center">')) {
          _heroPatched = true;
          patchedHtml = patchedHtml.replace(
            /(<header class="mb-4 text-center">[\s\S]*?<\/header>)([\s\S]*?)(<figure class="text-center mb-4">[\s\S]*?<\/figure>)/,
            (_, hdr, middle, fig) => {
              const hdrPatched = hdr.replace('class="mb-4 text-center"', 'class="mb-4 text-center article-hero-header"');
              const figPatched = fig.replace('class="text-center mb-4"', 'class="text-center mb-4 article-hero-fig"');
              return `<div class="article-hero-wrap">\n${hdrPatched}\n${figPatched}\n<div class="article-hero-overlay" aria-hidden="true"></div>\n</div>${middle}`;
            },
          );
        }
        // Inject hero CSS for old posts that predate the article-hero-wrap feature.
        const oldHeroCssPattern = /\.article-hero-wrap\{position:relative;margin:-1\.5rem -1\.5rem 1\.5rem;[\s\S]*?@media\(max-width:767px\)\{\.article-hero-wrap\{left:50%;transform:translateX\(-50%\);width:100vw;height:100svh;border-radius:0;margin:-1\.5rem 0 1\.5rem;justify-content:center\}\}/g;
        if (oldHeroCssPattern.test(patchedHtml)) {
          _heroPatched = true;
          patchedHtml = patchedHtml.replace(oldHeroCssPattern, ARTICLE_HERO_CSS);
        }
        if (!patchedHtml.includes('.article-hero-wrap') && patchedHtml.includes('</head>')) {
          _heroPatched = true;
          patchedHtml = patchedHtml.replace(
            '</head>',
            `<style>${ARTICLE_HERO_CSS}</style></head>`,
          );
        }
        // Persist hero-patched HTML back to KV so the next request loads pre-patched HTML
        // and skips the expensive hero-wrap regex entirely — prevents recurring Error 1102.
        if (_heroPatched && allowArticleKvBackgroundWrites && ctx?.waitUntil) {
          const _heroHtml = patchedHtml;
          ctx.waitUntil(env.BLOG_AI_KV.put(`${KV_POST_PREFIX}${slug}`, _heroHtml).catch(() => {}));
        }
        // Patch old byline link /about/ → /about/editorial/ (E-E-A-T signal)
        if (patchedHtml.includes('href="/about/" rel="author"')) {
          patchedHtml = patchedHtml.replaceAll(
            'href="/about/" rel="author"',
            'href="/about/editorial/" rel="author"',
          );
        }
        // Inject AI disclosure block into old posts that predate P1a.
        // New posts have it baked in via buildPostHTML; old KV posts don't.
        // Detect by absence of the sentinel string and inject before </article>.
        if (
          !patchedHtml.includes("About this article") &&
          patchedHtml.includes("</article>")
        ) {
          const disclosureBlock = buildArticleProcessDisclosure({
            legacyWikipediaAttribution: true,
          });
          patchedHtml = patchedHtml.replace(
            "</article>",
            disclosureBlock + "\n</article>",
          );
        }
        patchedHtml = normalizeArticleProcessDisclosureHtml(patchedHtml);
        // Patch old quiz popup to flex-column sticky-header layout
        if (
          patchedHtml.includes('id="tdq-popup"') &&
          !patchedHtml.includes('id="tdq-header"')
        ) {
          patchedHtml = patchedHtml
            // Popup div: drop overflow-y:auto and old padding, add flex-direction:column
            .replace(
              /(<div id="tdq-popup"[^>]*?)overflow-y:auto;([^>]*?)padding:24px 20px 32px;/,
              "$1flex-direction:column;$2padding:0 0 32px;",
            )
            // Remove position:absolute from close button, add min touch target
            .replace(
              /(<button id="tdq-close"[^>]*?)position:absolute;top:12px;right:16px;([^>]*?line-height:1)(")/,
              "$1$2;flex-shrink:0;min-width:44px;min-height:44px$3",
            )
            // Wrap tdq-close + tdq-topic in sticky header div
            .replace(
              /(<button id="tdq-close"[\s\S]*?<\/button>)\s*(<div id="tdq-topic"[^>]*?><\/div>)/,
              '<div id="tdq-header" style="flex-shrink:0;border-bottom:1px solid var(--border,#cfe0cf);padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px">$2$1</div>',
            )
            // Wrap body content in scrollable inner div
            .replace(
              /(<\/div>)\s*(<h3 style="font-size:1\.1rem)/,
              '$1<div style="overflow-y:auto;padding:16px 20px 32px">$2',
            )
            .replace(
              /(<div id="tdq-score"[^>]*?hidden><\/div>)\s*(<\/div>)/,
              "$1</div>$2",
            )
            // Patch CSS: .tdq-popup-open needs display:flex!important
            .replace(
              ".tdq-popup-open{transform:translateY(0)!important}",
              ".tdq-popup-open{transform:translateY(0)!important;display:flex!important}",
            );
        }
        // Strip the old "Check Answers" submit button from legacy quiz popups.
        // The current flow uses per-question Next buttons and a final See Results button.
        if (patchedHtml.includes("tdq-submit-btn")) {
          patchedHtml = patchedHtml
            .replace(
              /<button[^>]*id="tdq-submit-btn"[\s\S]*?<\/button>/g,
              "",
            )
            .replaceAll("getElementById('tdq-submit-btn')", "null")
            .replaceAll('getElementById("tdq-submit-btn")', "null");
        }
        // Patch old show-all quiz JS → step-by-step (posts with quiz already baked in but old JS)
        // Only apply if post has quiz popup, uses legacy submit flow or no finish-btn,
        // and doesn't already have step CSS (tdq-q-active)
        if (
          patchedHtml.includes('id="tdq-popup"') &&
          (!patchedHtml.includes("tdq-finish-btn") ||
            patchedHtml.includes("tdq-submit-btn")) &&
          !patchedHtml.includes("tdq-q-active")
        ) {
          const stepOverride = `<script>
(function(){
  var sm=[].slice.call(document.scripts).find(function(s){return s.textContent.indexOf('var slug =')!==-1});
  var m=sm&&sm.textContent.match(/var slug = "([^"]+)"/);
  if(!m)return;
  var slug=m[1],selected={},answers=[],quizLoaded=false,total=0;
  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
  function openPopup(){var ol=document.getElementById('tdq-overlay'),pp=document.getElementById('tdq-popup');if(ol)ol.style.display='block';if(pp){pp.style.display='block';requestAnimationFrame(function(){pp.classList.add('tdq-popup-open')});}document.body.style.overflow='hidden';}
  function closePopup(){var pp=document.getElementById('tdq-popup');pp.classList.remove('tdq-popup-open');setTimeout(function(){pp.style.display='none';var ol=document.getElementById('tdq-overlay');if(ol)ol.style.display='none';document.body.style.overflow='';},300);}
  function renderQuiz(quiz){
    answers=quiz.questions.map(function(q){return Number(q.answer)});
    total=Math.min(quiz.questions.length,5);
    var topicEl=document.getElementById('tdq-topic');
    if(topicEl){var h1=document.querySelector('h1');if(h1)topicEl.textContent='Quiz: '+h1.textContent.trim();}
    var container=document.getElementById('tdq-questions');
    container.innerHTML=quiz.questions.slice(0,total).map(function(q,qi){
      var optsHtml=(q.options||[]).map(function(opt,oi){return '<div class="tdq-opt" data-qi="'+qi+'" data-oi="'+oi+'"><span class="tdq-opt-key">'+String.fromCharCode(65+oi)+'</span>'+esc(String(opt))+'</div>';}).join('');
      var expHtml=q.explanation?'<div class="tdq-explanation" id="tdq-e-'+qi+'" hidden style="font-size:.82rem;margin-top:6px;padding:7px 11px;background:rgba(0,0,0,.035);border-left:3px solid var(--btn-bg,#1b3a2d);border-radius:0 6px 6px 0">'+esc(String(q.explanation))+'</div>':'';
      var actionBtn=qi<total-1?'<button class="tdq-next-btn" id="tdq-next-'+qi+'" data-qi="'+qi+'" style="display:none;width:100%;margin-top:18px;padding:12px;background:var(--btn-bg,#1b3a2d);color:var(--accent,#9dc43a);border:none;border-radius:10px;font-size:.95rem;font-weight:600;cursor:pointer;gap:8px;align-items:center;justify-content:center">Next Question <i class="bi bi-arrow-right"></i></button>':'<button id="tdq-finish-btn" style="display:none;width:100%;margin-top:18px;padding:12px;background:var(--btn-bg,#1b3a2d);color:var(--accent,#9dc43a);border:none;border-radius:10px;font-size:.95rem;font-weight:600;cursor:pointer"><i class="bi bi-check2-circle me-1"></i>See Results</button>';
      return '<div class="tdq-question" id="tdq-q-'+qi+'" style="display:'+(qi===0?'block':'none')+'"><p class="tdq-q-text"><strong>'+(qi+1)+'.</strong> '+esc(String(q.q))+'</p><div class="tdq-options">'+optsHtml+'</div><div class="tdq-feedback" id="tdq-f-'+qi+'" hidden></div>'+expHtml+actionBtn+'</div>';
    }).join('');
    container.querySelectorAll('.tdq-opt').forEach(function(opt){
      opt.addEventListener('click',function(){
        var qi=parseInt(this.dataset.qi),oi=parseInt(this.dataset.oi);
        if(selected[qi]!==undefined)return;
        selected[qi]=oi;
        var correct=answers[qi];
        var opts=container.querySelectorAll('.tdq-opt[data-qi="'+qi+'"]');
        opts.forEach(function(o){o.style.pointerEvents='none';});
        opts[correct].classList.add('tdq-opt-correct');
        var fb=document.getElementById('tdq-f-'+qi);fb.hidden=false;
        if(oi===correct){this.classList.add('tdq-opt-correct');fb.innerHTML='<span class="tdq-correct">✓ Correct!</span>';}
        else{this.classList.add('tdq-opt-wrong');fb.innerHTML='<span class="tdq-wrong">✗ Incorrect.</span> Correct: <strong>'+String.fromCharCode(65+correct)+'</strong>';}
        var exp=document.getElementById('tdq-e-'+qi);if(exp)exp.hidden=false;
        var progEl=document.getElementById('tdq-progress');if(progEl)progEl.textContent=Object.keys(selected).length+' of '+total+' answered';
        var nb=document.getElementById('tdq-next-'+qi);if(nb)nb.style.display='';
        var fb2=document.getElementById('tdq-finish-btn');if(fb2&&qi===total-1)fb2.style.display='';
      });
    });
    container.addEventListener('click',function(e){
      var btn=e.target.closest('.tdq-next-btn');if(!btn)return;
      var qi=parseInt(btn.dataset.qi);
      var inner=document.querySelector('#tdq-popup [style*="overflow-y:auto"]')||document.getElementById('tdq-popup');
      if(inner)inner.scrollTop=0;
      document.getElementById('tdq-q-'+qi).style.display='none';
      document.getElementById('tdq-q-'+(qi+1)).style.display='block';
    });
    var finBtn=document.getElementById('tdq-finish-btn');
    if(finBtn)finBtn.addEventListener('click',function(){
      var score=0;answers.forEach(function(c,qi){if(selected[qi]===c)score++;});
      this.hidden=true;
      document.getElementById('tdq-q-'+(total-1)).style.display='none';
      var pct=Math.round(score/answers.length*100);
      var msg=pct===100?'Perfect score!':pct>=80?'Excellent!':pct>=60?'Good job!':'Keep learning!';
      var el=document.getElementById('tdq-score');el.hidden=false;
      el.innerHTML='<div class="tdq-score-box">You scored <span class="tdq-score-num">'+score+'/'+answers.length+'</span> ('+pct+'%) — '+msg+'</div>';
      var inner=document.querySelector('#tdq-popup [style*="overflow-y:auto"]')||document.getElementById('tdq-popup');
      if(inner)inner.scrollTop=0;
    });
  }
  window.maybeLoadAndShowQuiz=function(){
    if(quizLoaded){openPopup();return;}
    quizLoaded=true;
    if(window.__tdqQuiz){var q=window.__tdqQuiz;window.__tdqQuiz=null;renderQuiz(q);openPopup();return;}
    fetch('/blog/quiz/'+slug).then(function(r){return r.ok?r.json():null;}).then(function(quiz){if(!quiz||!quiz.questions||quiz.questions.length<3)return;renderQuiz(quiz);openPopup();}).catch(function(){});
  };
  var closeBtn=document.getElementById('tdq-close');if(closeBtn){closeBtn.replaceWith(closeBtn.cloneNode(true));document.getElementById('tdq-close').addEventListener('click',closePopup);}
  var ol=document.getElementById('tdq-overlay');if(ol){ol.replaceWith(ol.cloneNode(true));document.getElementById('tdq-overlay').addEventListener('click',closePopup);}
})();
<\/script>`;
          // Disable old baked-in auto-triggers (IntersectionObserver + #quiz hash)
          // so the old private renderQuiz never fires and overwrites our step HTML
          patchedHtml = patchedHtml
            .replace(
              /setTimeout\(maybeLoadAndShow,\s*800\)/g,
              "setTimeout(function(){}/*tdq-disabled*/,800)",
            )
            .replace(
              /if\s*\(window\.location\.hash\s*===\s*"#quiz"\)\s*\{[^}]*\}/,
              "/* #quiz auto-open disabled */",
            );
          const bodyClose = patchedHtml.includes("</body>")
            ? "</body>"
            : "</html>";
          patchedHtml = patchedHtml.replace(
            bodyClose,
            stepOverride + "\n" + bodyClose,
          );
        }
        // Fix related-question-card paragraphs that end with … (AI-truncated in stored HTML)
        if (patchedHtml.includes('related-question-card') && patchedHtml.includes('…</p>')) {
          patchedHtml = patchedHtml.replace(
            /(<article class="related-question-card">[\s\S]*?<p>)([^<]*…)(<\/p>)/g,
            (_, open, text, close) => {
              const lastEnd = text.search(/[.!?][^.!?]*$/);
              if (lastEnd !== -1) return open + text.slice(0, lastEnd + 1) + close;
              return open + text.replace(/\s+\S*…$/, '.') + close;
            },
          );
        }
        // Upgrade old amber-style Quiz CTA to authority-links style
        if (!patchedHtml.includes('quiz-cta-patch-v1') && patchedHtml.includes('rgba(245,158,11,.08)')) {
          patchedHtml = patchedHtml.replace(
            /<div[^>]*rgba\(245,158,11[^>]*>[\s\S]*?<\/div>\s*<\/div>/,
            `<div class="authority-links mt-4"><!-- quiz-cta-patch-v1 -->
            <span class="authority-links-label">Test Your Knowledge</span>
            <p style="font-size:15px;margin:0 0 10px">Can you answer 5 questions about this event?</p>
            <div class="authority-links-row">
              <a class="authority-link" id="tdq-cta-btn" href="/quiz/" onclick="event.preventDefault();document.getElementById('tdq-overlay').style.display='block';document.getElementById('tdq-popup').style.display='block';requestAnimationFrame(function(){document.getElementById('tdq-popup').classList.add('tdq-popup-open');});document.body.style.overflow='hidden';if(typeof maybeLoadAndShowQuiz==='function')maybeLoadAndShowQuiz();">Take the Quiz <i class="bi bi-arrow-right ms-1"></i></a>
            </div>
          </div>`,
          );
        }
        // Inject quiz CTA + popup for old posts that don't have it
        if (!patchedHtml.includes("tdq-cta-btn")) {
          const quizCta = `
          <!-- Quiz CTA -->
          <div class="authority-links mt-4">
            <span class="authority-links-label">Test Your Knowledge</span>
            <p style="font-size:15px;margin:0 0 10px">Can you answer 5 questions about this event?</p>
            <div class="authority-links-row">
              <a class="authority-link" id="tdq-cta-btn" href="/quiz/" onclick="event.preventDefault();document.getElementById('tdq-overlay').style.display='block';document.getElementById('tdq-popup').style.display='block';requestAnimationFrame(function(){document.getElementById('tdq-popup').classList.add('tdq-popup-open');});document.body.style.overflow='hidden';if(typeof maybeLoadAndShowQuiz==='function')maybeLoadAndShowQuiz();">Take the Quiz <i class="bi bi-arrow-right ms-1"></i></a>
            </div>
          </div>`;
          const quizBlock = `
  <!-- Quiz popup -->
  <div id="tdq-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9998" aria-hidden="true"></div>
  <div id="tdq-popup" role="dialog" aria-modal="true" aria-label="History Quiz" style="display:none;flex-direction:column;position:fixed;bottom:0;left:0;right:0;z-index:9999;max-height:90dvh;background:var(--bg,#fff);border-radius:16px 16px 0 0;box-shadow:0 -4px 32px rgba(0,0,0,.18);font-family:Lora,serif">
    <div id="tdq-header" style="flex-shrink:0;border-bottom:1px solid var(--border,#cfe0cf);padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px">
      <div id="tdq-topic" style="font-size:.72rem;font-weight:700;color:var(--accent,#9dc43a);text-transform:uppercase;letter-spacing:.06em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>
      <button id="tdq-close" aria-label="Close quiz" style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:var(--text-muted,#5c7a65);line-height:1;flex-shrink:0;min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:flex-end">&times;</button>
    </div>
    <div id="tdq-scroll-body" style="overflow-y:auto;padding:16px 20px 32px">
      <h3 style="font-size:1.1rem;font-weight:700;margin-bottom:3px;color:var(--text,#1a2e20)"><i class="bi bi-patch-question-fill me-2" style="color:var(--accent,#9dc43a)"></i>Test Your Knowledge</h3>
      <p style="font-size:.85rem;color:var(--text-muted,#5c7a65);margin-bottom:6px;opacity:.8">Based on the article you just read — 5 questions, under a minute.</p>
      <div id="tdq-progress" style="font-size:.78rem;font-weight:600;color:var(--accent,#9dc43a);margin-bottom:16px">0 of 5 answered</div>
      <div id="tdq-questions"></div>
      <div id="tdq-score" class="mt-3" hidden></div>
    </div>
  </div>
  <div id="tdq-sentinel" style="height:1px"></div>
  <style>
    .tdq-question{margin-bottom:16px}.tdq-q-text{font-weight:600;margin-bottom:8px;font-size:.9rem;color:var(--text,#1a2e20)}.tdq-options{display:flex;flex-direction:column;gap:7px}
    .tdq-opt{display:flex;align-items:center;gap:9px;padding:8px 12px;border:1.5px solid var(--border,#cfe0cf);border-radius:8px;cursor:pointer;font-size:.88rem;transition:background .15s,border-color .15s;user-select:none;color:var(--text,#1a2e20)}
    .tdq-opt:hover{border-color:var(--accent,#9dc43a);background:rgba(157,196,58,.07)}.tdq-opt-selected{border-color:var(--accent,#9dc43a)!important;background:rgba(157,196,58,.15)!important;font-weight:500}
    .tdq-opt-correct{border-color:#10b981!important;background:#d1fae5!important;color:#0f172a!important}.tdq-opt-wrong{border-color:#ef4444!important;background:#fee2e2!important;color:#0f172a!important}
    .tdq-opt-key{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:var(--border,#cfe0cf);font-size:.72rem;font-weight:700;flex-shrink:0}
    .tdq-opt-selected .tdq-opt-key{background:var(--btn-bg,#1b3a2d);color:#fff}.tdq-opt-correct .tdq-opt-key{background:#10b981;color:#fff}.tdq-opt-wrong .tdq-opt-key{background:#ef4444;color:#fff}
    .tdq-feedback{font-size:.82rem;margin-top:4px}.tdq-correct{color:#10b981;font-weight:600}.tdq-wrong{color:#ef4444;font-weight:600}
    .tdq-score-box{font-size:1rem;font-weight:600;padding:12px 14px;background:rgba(157,196,58,.1);border-radius:8px;border-left:4px solid var(--accent,#9dc43a)}.tdq-score-num{color:var(--accent,#9dc43a);font-size:1.15rem}
    #tdq-popup{transition:transform .3s ease;transform:translateY(100%)}.tdq-popup-open{transform:translateY(0)!important;display:flex!important}
    #tdq-scroll-body{scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.2) transparent}#tdq-scroll-body::-webkit-scrollbar{width:4px}#tdq-scroll-body::-webkit-scrollbar-thumb{background:rgba(0,0,0,.2);border-radius:4px}
    .tdq-cta-sub{color:var(--text-muted,#5c7a65)}
  </style>
  <script>
  (function () {
    var slug = "${slug}";
    var quizLoaded = false;
    var selected = {};
    var answers = [];
    function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
    function openPopup() {
      document.getElementById("tdq-overlay").style.display = "block";
      document.getElementById("tdq-popup").style.display = "block";
      requestAnimationFrame(function() { document.getElementById("tdq-popup").classList.add("tdq-popup-open"); });
      document.body.style.overflow = "hidden";
    }
    function closePopup() {
      var popup = document.getElementById("tdq-popup");
      popup.classList.remove("tdq-popup-open");
      setTimeout(function() { popup.style.display = "none"; document.getElementById("tdq-overlay").style.display = "none"; document.body.style.overflow = ""; }, 300);
    }
    document.getElementById("tdq-close").addEventListener("click", closePopup);
    document.getElementById("tdq-overlay").addEventListener("click", closePopup);
    function renderQuiz(quiz) {
      answers = quiz.questions.map(function(q) { return Number(q.answer); });
      var total = quiz.questions.length;
      var topicEl = document.getElementById("tdq-topic");
      if (topicEl) { var h1 = document.querySelector("h1"); if (h1) topicEl.textContent = "Quiz: " + h1.textContent.trim(); }
      var container = document.getElementById("tdq-questions");
      container.innerHTML = quiz.questions.map(function(q, qi) {
        var optsHtml = (q.options || []).map(function(opt, oi) {
          return '<div class="tdq-opt" data-qi="' + qi + '" data-oi="' + oi + '"><span class="tdq-opt-key">' + String.fromCharCode(65 + oi) + '</span>' + esc(String(opt)) + '</div>';
        }).join("");
        var expHtml = q.explanation ? '<div class="tdq-explanation" id="tdq-e-' + qi + '" hidden style="font-size:.82rem;margin-top:6px;padding:7px 11px;background:rgba(0,0,0,.035);border-left:3px solid var(--btn-bg,#1b3a2d);border-radius:0 6px 6px 0">' + esc(String(q.explanation)) + '</div>' : '';
        var actionBtn = qi < total - 1
          ? '<button class="tdq-next-btn" id="tdq-next-' + qi + '" data-qi="' + qi + '" style="display:none;width:100%;margin-top:18px;padding:12px;background:var(--btn-bg,#1b3a2d);color:var(--accent,#9dc43a);border:none;border-radius:10px;font-size:.95rem;font-weight:600;cursor:pointer">Next Question <i class="bi bi-arrow-right ms-1"></i></button>'
          : '<button id="tdq-finish-btn" style="display:none;width:100%;margin-top:18px;padding:12px;background:var(--btn-bg,#1b3a2d);color:var(--accent,#9dc43a);border:none;border-radius:10px;font-size:.95rem;font-weight:600;cursor:pointer"><i class="bi bi-check2-circle me-1"></i>See Results</button>';
        return '<div class="tdq-question" id="tdq-q-' + qi + '" style="display:' + (qi === 0 ? 'block' : 'none') + '"><p class="tdq-q-text"><strong>' + (qi + 1) + '.</strong> ' + esc(String(q.q)) + '</p><div class="tdq-options">' + optsHtml + '</div><div class="tdq-feedback" id="tdq-f-' + qi + '" hidden></div>' + expHtml + actionBtn + '</div>';
      }).join("");
      container.querySelectorAll(".tdq-opt").forEach(function(opt) {
        opt.addEventListener("click", function() {
          var qi = parseInt(this.dataset.qi), oi = parseInt(this.dataset.oi);
          if (selected[qi] !== undefined) return;
          selected[qi] = oi;
          var correct = answers[qi];
          var opts = container.querySelectorAll('[data-qi="' + qi + '"]');
          opts.forEach(function(o) { o.style.pointerEvents = "none"; });
          opts[correct].classList.add("tdq-opt-correct");
          var fb = document.getElementById("tdq-f-" + qi);
          fb.hidden = false;
          if (oi === correct) {
            this.classList.add("tdq-opt-correct");
            fb.innerHTML = '<span class="tdq-correct">✓ Correct!</span>';
          } else {
            this.classList.add("tdq-opt-wrong");
            fb.innerHTML = '<span class="tdq-wrong">✗ Incorrect.</span> Correct: <strong>' + String.fromCharCode(65 + correct) + '</strong>';
          }
          var exp = document.getElementById("tdq-e-" + qi); if (exp) exp.hidden = false;
          var progEl = document.getElementById("tdq-progress");
          if (progEl) progEl.textContent = Object.keys(selected).length + " of " + total + " answered";
          var nextBtn = document.getElementById("tdq-next-" + qi);
          if (nextBtn) nextBtn.style.display = "";
          var finishBtn = document.getElementById("tdq-finish-btn");
          if (finishBtn && qi === total - 1) finishBtn.style.display = "";
        });
      });
      container.addEventListener("click", function(e) {
        var btn = e.target.closest(".tdq-next-btn");
        if (!btn) return;
        var qi = parseInt(btn.dataset.qi);
        var inner = document.querySelector("#tdq-popup [style*='overflow-y:auto']") || document.getElementById("tdq-popup");
        if (inner) inner.scrollTop = 0;
        document.getElementById("tdq-q-" + qi).style.display = "none";
        document.getElementById("tdq-q-" + (qi + 1)).style.display = "block";
      });
      var finishBtn = document.getElementById("tdq-finish-btn");
      if (finishBtn) finishBtn.addEventListener("click", function() {
        var score = 0;
        answers.forEach(function(correct, qi) { if (selected[qi] === correct) score++; });
        this.hidden = true;
        document.getElementById("tdq-q-" + (total - 1)).style.display = "none";
        var pct = Math.round(score / answers.length * 100);
        var msg = pct === 100 ? "Perfect score!" : pct >= 80 ? "Excellent!" : pct >= 60 ? "Good job!" : "Keep learning!";
        var el = document.getElementById("tdq-score");
        el.hidden = false;
        el.innerHTML = '<div class="tdq-score-box">You scored <span class="tdq-score-num">' + score + '/' + answers.length + '</span> (' + pct + '%) — ' + msg + '</div>';
        var inner = document.querySelector("#tdq-popup [style*='overflow-y:auto']") || document.getElementById("tdq-popup");
        if (inner) inner.scrollTop = 0;
      });
    }
    function maybeLoadAndShow() {
      if (quizLoaded) return; quizLoaded = true;
      if (window.__tdqQuiz) { var q=window.__tdqQuiz; window.__tdqQuiz=null; renderQuiz(q); openPopup(); return; }
      fetch("/blog/quiz/" + slug)
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(quiz) { if (!quiz || !quiz.questions || quiz.questions.length < 3) return; renderQuiz(quiz); openPopup(); })
        .catch(function() {});
    }
    window.maybeLoadAndShowQuiz = function(){if(quizLoaded){openPopup();}else{maybeLoadAndShow();}};
    if (window.location.hash === "#quiz") { setTimeout(maybeLoadAndShow, 600); }
    if ("IntersectionObserver" in window) {
      var sentinel = document.getElementById("tdq-sentinel");
      var obs = new IntersectionObserver(function(entries) { if (entries[0].isIntersecting) { obs.disconnect(); setTimeout(maybeLoadAndShow, 800); } }, { threshold: 1.0 });
      obs.observe(sentinel);
    }
  })();
  <\/script>`;
          // Strip any old icon-based Explore card before injecting the new thumbnail version
          patchedHtml = patchedHtml.replace(
            /<div class="mt-4 p-3 rounded d-flex align-items-center gap-3"[^>]*>\s*<i class="bi bi-calendar3[\s\S]*?<\/div>\s*<\/div>/,
            "",
          );
          // Upgrade old explore cards (inline styles / Bootstrap flex) to authority-links class
          patchedHtml = patchedHtml.replace(
            /<div data-explore-injected="1" class="mt-4[^"]*"[^>]*>/g,
            '<div data-explore-injected="1" class="authority-links mt-4">',
          );
          // Build "Explore in History" section
          const _sp = slugParsedForThumb;
          let exploreHtml = "";
          if (_sp) {
            const _thumb = eventsThumb
              ? `<img src="/image-proxy?src=${encodeURIComponent(eventsThumb)}&w=80&q=75" alt="Explore ${esc(_sp.monthDisplay)} ${esc(_sp.day)} in history" width="64" height="64" style="width:64px;height:64px;min-width:64px;object-fit:cover;border-radius:8px;flex-shrink:0;display:block" loading="lazy"/>`
              : "";
            exploreHtml = "\n          " + buildDateExploreCard(_sp, _thumb);
          }
          // Inject quiz before Wikipedia source box (matching March 14 template order)
          const wikiAnchor =
            '<div class="mt-4 p-3 rounded" style="background-color: rgba(0,0,0,0.04)';
          if (patchedHtml.includes(wikiAnchor)) {
            patchedHtml = patchedHtml.replace(
              wikiAnchor,
              quizCta + "\n          " + wikiAnchor,
            );
            if (
              exploreHtml &&
              !patchedHtml.includes('data-explore-injected="1"')
            ) {
              const afterWikiAnchor = patchedHtml.includes('<div class="authority-links mt-3 mb-4">')
                ? '<div class="authority-links mt-3 mb-4">'
                : patchedHtml.includes('<section class="amazon-related')
                  ? '<section class="amazon-related'
                  : patchedHtml.includes("<!-- Quiz CTA -->")
                    ? "<!-- Quiz CTA -->"
                    : patchedHtml.includes("You Might Also Like")
                      ? '<h2 class="h5 mb-3">You Might Also Like</h2>'
                      : "</article>";
              patchedHtml = patchedHtml.replace(
                afterWikiAnchor,
                exploreHtml + "\n          " + afterWikiAnchor,
              );
            }
          } else {
            const quizAnchor = patchedHtml.includes("You Might Also Like")
              ? '<h2 class="h5 mb-3">You Might Also Like</h2>'
              : "</article>";
            patchedHtml = patchedHtml.replace(
              quizAnchor,
              quizCta + "\n          " + quizAnchor,
            );
          }
          const bodyClose = patchedHtml.includes("</body>")
            ? "</body>"
            : "</html>";
          patchedHtml = patchedHtml.replace(
            bodyClose,
            quizBlock + "\n" + bodyClose,
          );
        }
        // Strip chatbot from old KV posts (now removed from template)
        if (patchedHtml.includes("chatbot")) {
          patchedHtml = patchedHtml.replace(
            /<script\s+src="\/js\/chatbot\.js"><\/script>/g,
            "",
          );
          patchedHtml = patchedHtml.replace(
            /<button[^>]+id="chatbotToggle"[^>]*>[\s\S]*?<\/button>/g,
            "",
          );
          const chatbotCss =
            "<style>#chatbotToggle,#chatbotWindow,.chatbot-toggle,.chatbot-window{display:none!important}</style>";
          if (patchedHtml.includes("</head>")) {
            patchedHtml = patchedHtml.replace(
              "</head>",
              chatbotCss + "</head>",
            );
          } else {
            patchedHtml = patchedHtml.replace(
              /(<body[^>]*>)/,
              "$1" + chatbotCss,
            );
          }
        }
        // Always strip old icon-based Explore card (covers KV that has both old + new)
        if (patchedHtml.includes("bi-calendar3")) {
          patchedHtml = patchedHtml.replace(
            /<div class="mt-4 p-3 rounded d-flex align-items-center gap-3"[^>]*>\s*<i class="bi bi-calendar3[\s\S]*?<\/div>\s*<\/div>/,
            "",
          );
        }
        // Inject "Explore [Date] in History" card for any post missing it (covers posts with quiz already baked in)
        if (
          !patchedHtml.includes('data-explore-injected="1"') &&
          slugParsedForThumb
        ) {
          const sp = slugParsedForThumb;
          const thumb = eventsThumb
            ? `<img src="/image-proxy?src=${encodeURIComponent(eventsThumb)}&w=80&q=75" alt="Explore ${esc(sp.monthDisplay)} ${esc(sp.day)} in history" width="64" height="64" style="width:64px;height:64px;min-width:64px;object-fit:cover;border-radius:8px;flex-shrink:0;display:block" loading="lazy"/>`
            : "";
          const exploreCard = buildDateExploreCard(sp, thumb);
          const anchor = patchedHtml.includes('<div class="authority-links mt-3 mb-4">')
            ? '<div class="authority-links mt-3 mb-4">'
            : patchedHtml.includes('<section class="amazon-related')
              ? '<section class="amazon-related'
              : patchedHtml.includes("<!-- Quiz CTA -->")
                ? "<!-- Quiz CTA -->"
                : patchedHtml.includes("You Might Also Like")
                  ? '<h2 class="h5 mb-3">You Might Also Like</h2>'
                  : "</article>";
          patchedHtml = patchedHtml.replace(
            anchor,
            exploreCard + "\n          " + anchor,
          );
        }
        // Inject scroll progress bar into older posts that were stored without it
        if (!patchedHtml.includes("read-progress")) {
          const progressCss = `<style>#read-progress{position:fixed;top:0;left:0;height:3px;width:0%;background:var(--btn-bg,#1b3a2d);z-index:9999;transition:width .1s linear;pointer-events:none}.site-btn{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border:1.5px solid var(--border,#cfe0cf);border-radius:8px;font-size:.875rem;font-weight:500;text-decoration:none;color:var(--text,#1a2e20);background:transparent;cursor:pointer;transition:background .15s,border-color .15s,color .15s;user-select:none}.site-btn:hover{border-color:var(--btn-bg,#1b3a2d);background:var(--bg-alt,#f2f7f2)}.site-btn-primary{border-color:var(--btn-bg,#1b3a2d);color:var(--btn-bg,#1b3a2d)}.site-btn-primary:hover{background:var(--bg-alt,#f2f7f2);border-color:var(--btn-hover,#2a4d3a);color:var(--btn-hover,#2a4d3a)}.tdq-cta-sub{color:var(--text-muted,#5c7a65)}</style>`;
          const progressHtml = `<div id="read-progress" role="progressbar" aria-label="Reading progress" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"></div>`;
          const progressJs = `<script>(function(){var bar=document.getElementById('read-progress');if(!bar)return;document.addEventListener('scroll',function(){var doc=document.documentElement;var total=doc.scrollHeight-doc.clientHeight;var pct=total>0?Math.round((doc.scrollTop/total)*100):0;bar.style.width=pct+'%';bar.setAttribute('aria-valuenow',pct);},{passive:true});})();<\/script>`;
          patchedHtml = patchedHtml
            .replace("</head>", progressCss + "</head>")
            .replace("<nav ", progressHtml + "\n  <nav ")
            .replace("</body>", progressJs + "</body>");
          // If no </body>, append before </html>
          if (!patchedHtml.includes(progressJs)) {
            patchedHtml = patchedHtml.replace(
              "</html>",
              progressJs + "</html>",
            );
          }
        }
        // Patch old blue quiz option selection → amber (matches btn-warning on homepage)
        if (patchedHtml.includes("tdq-opt-selected{border-color:#1f1f1f")) {
          patchedHtml = patchedHtml.replace(
            "</head>",
            "<style>.tdq-opt:hover{border-color:var(--accent,#9dc43a)!important;background:rgba(157,196,58,.07)!important}.tdq-opt-selected{border-color:var(--accent,#9dc43a)!important;background:rgba(157,196,58,.15)!important}.tdq-opt-selected .tdq-opt-key{background:var(--btn-bg,#1b3a2d)!important}</style></head>",
          );
        }
        // Patch float bar background to white on already-stored posts
        patchedHtml = patchedHtml.replaceAll(
          "background:rgba(27,58,45,.96);backdrop-filter:blur(4px);box-shadow:0 -2px 16px rgba(27,58,45,.3)",
          "background:#fff;backdrop-filter:blur(4px);box-shadow:0 -2px 16px rgba(27,58,45,.15)",
        );
        // Inject floating quiz bar into stored posts that don't have it yet
        if (!patchedHtml.includes("tdq-float-bar")) {
          const floatCss = `<style>#tdq-float-bar{position:fixed;bottom:0;left:0;right:0;z-index:1020;background:#fff;backdrop-filter:blur(4px);box-shadow:0 -2px 16px rgba(27,58,45,.15);transform:translateY(100%);transition:transform .35s cubic-bezier(.22,.61,.36,1);padding:10px 16px;padding-bottom:max(10px,env(safe-area-inset-bottom));display:flex;align-items:center;justify-content:center}#tdq-float-bar.tdq-float-visible{transform:translateY(0)}#tdq-float-btn{background:#1a3a2d;border:none;border-radius:100px;color:#fff;font-weight:700;font-size:.95rem;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;padding:11px 28px;box-shadow:0 2px 12px rgba(26,58,45,.25);max-width:320px;width:100%}#tdq-float-btn:hover{background:#1a3a2d;box-shadow:0 2px 16px rgba(26,58,45,.35)}</style>`;
          const floatHtml = `<div id="tdq-float-bar"><button id="tdq-float-btn"><i class="bi bi-patch-question-fill"></i> Quiz This Day</button></div>`;
          const floatJs = `<script>(function(){var bar=document.getElementById('tdq-float-bar');var btn=document.getElementById('tdq-float-btn');var closeBtn=document.getElementById('tdq-close');if(!bar||!btn)return;function showBar(){bar.classList.add('tdq-float-visible');}function hideBar(){bar.classList.remove('tdq-float-visible');}btn.addEventListener('click',function(){hideBar();var overlay=document.getElementById('tdq-overlay');var popup=document.getElementById('tdq-popup');if(overlay)overlay.style.display='block';if(popup){popup.style.display='block';requestAnimationFrame(function(){popup.classList.add('tdq-popup-open');});}document.body.style.overflow='hidden';if(typeof maybeLoadAndShowQuiz==='function')maybeLoadAndShowQuiz();});if(closeBtn)closeBtn.addEventListener('click',function(){setTimeout(showBar,300);});var h2s=document.querySelectorAll('h2');var trigger=null;for(var i=0;i<h2s.length;i++){if(h2s[i].textContent.indexOf('Eyewitness')!==-1){trigger=h2s[i];break;}}if(trigger){function updateBar(){var rect=trigger.getBoundingClientRect();if(rect.top<window.innerHeight){showBar();}else{hideBar();}}window.addEventListener('scroll',updateBar,{passive:true});}else{document.addEventListener('scroll',function onScroll(){var d=document.documentElement;var total=d.scrollHeight-d.clientHeight;if(total>0&&d.scrollTop/total>0.35){showBar();document.removeEventListener('scroll',onScroll);}},{passive:true});}})();<\/script>`;
          const bodyClose = patchedHtml.includes("</body>")
            ? "</body>"
            : "</html>";
          patchedHtml = patchedHtml
            .replace("</head>", floatCss + "</head>")
            .replace(bodyClose, floatHtml + "\n" + floatJs + "\n" + bodyClose);
        }
        // Normalize float bar button colors on already-stored posts.
        // Some historic posts shipped with a light-green float button; keep it consistent with the site's primary button color.
        patchedHtml = patchedHtml
          .replace(
            /#tdq-float-btn\{background:(?:var\(--accent,#9dc43a\)|#9dc43a);border:none;border-radius:100px;color:[^;]+;/g,
            "#tdq-float-btn{background:#1a3a2d;border:none;border-radius:100px;color:#fff;",
          )
          .replace(
            /#tdq-float-btn:hover\{background:[^;]+;/g,
            "#tdq-float-btn:hover{background:#1a3a2d;",
          );


        // Patch old amber/orange quiz colors → green palette
        if (
          patchedHtml.includes("linear-gradient(90deg,#f59e0b") ||
          patchedHtml.includes("rgba(15,23,42,.96)") ||
          patchedHtml.includes("background:#f59e0b")
        ) {
          patchedHtml = patchedHtml
            .replaceAll("rgba(15,23,42,.96)", "rgba(27,58,45,.96)")
            .replaceAll("linear-gradient(90deg,#f59e0b,#d97706)", "#9dc43a")
            .replaceAll("linear-gradient(90deg,#d97706,#b45309)", "#8ab532")
            .replaceAll("rgba(245,158,11,.35)", "rgba(157,196,58,.35)")
            .replaceAll("rgba(245,158,11,.5)", "rgba(157,196,58,.5)")
            .replaceAll(
              "background:#f59e0b",
              "background:var(--btn-bg,#1b3a2d)",
            )
            .replaceAll(
              "background:#d97706",
              "background:var(--btn-hover,#2a4d3a)",
            )
            .replaceAll("color:#f59e0b", "color:var(--accent,#9dc43a)")
            .replaceAll(
              "border-color:#f59e0b",
              "border-color:var(--btn-bg,#1b3a2d)",
            )
            .replaceAll("rgba(245,158,11,.07)", "rgba(157,196,58,.07)")
            .replaceAll("rgba(245,158,11,.12)", "rgba(157,196,58,.15)")
            .replaceAll("rgba(245,158,11,.1)", "rgba(157,196,58,.1)")
            .replaceAll(
              "border-left:4px solid #f59e0b",
              "border-left:4px solid var(--accent,#9dc43a)",
            );
        }
        // Patch old btn-warning quiz buttons → green
        if (patchedHtml.includes("btn-warning")) {
          patchedHtml = patchedHtml
            .replaceAll(
              'class="btn btn-warning fw-semibold w-100 mt-2"',
              'class="btn"',
            )
            .replaceAll('class="btn btn-warning mt-3"', 'class="btn mt-3"');
        }
        // Patch old box-shadow on article border
        if (patchedHtml.includes("box-shadow:0 2px 4px rgba(0,0,0,.1)")) {
          patchedHtml = patchedHtml.replaceAll(
            "box-shadow:0 2px 4px rgba(0,0,0,.1)",
            "box-shadow:none",
          );
        }
        // Inject updated ai-answer-card styles into older stored posts (removes green gradient,
        // hides kicker, h2 title, and injected figure/p to match the current clean card design).
        patchedHtml = normalizeAiAnswerCardHtml(patchedHtml);
        // Font-size consistency patch: 15px on .mb-2 and .ai-answer-item value text.
        if (!patchedHtml.includes('font-patch-v1')) {
          patchedHtml = patchedHtml.replace(
            '</head>',
            '<style>/*font-patch-v1*/li.mb-2{font-size:15px}.ai-answer-item{font-size:15px}</style></head>',
          );
        }
        // Patch stored <ins class="adsbygoogle"> elements missing style="display:block".
        // The pushIns function bails on offsetWidth===0, so inline <ins> elements are never
        // pushed to adsbygoogle. This fixes articles stored before the style was added.
        patchedHtml = patchedHtml.replace(
          /<ins([^>]*class="adsbygoogle"[^>]*)>/g,
          (match, attrs) =>
            attrs.includes("display:block") ? match : `<ins${attrs} style="display:block">`,
        );
        // Inject AdSense ad unit into stored posts that don't have one yet
        // Only inject for posts from March 2026 onwards — leave older posts alone
        const _adParts = slug.match(/^(\d+)-([a-z]+)-(\d{4})$/i);
        const _adYear = _adParts ? parseInt(_adParts[3], 10) : 0;
        const _adMonthIdx = _adParts
          ? MONTH_SLUGS.indexOf(_adParts[2].toLowerCase())
          : -1;
        const _isRecentPost =
          _adYear > 2026 || (_adYear === 2026 && _adMonthIdx >= 2);
        if (
          _isRecentPost &&
          !patchedHtml.includes('<ins class="adsbygoogle"') &&
          patchedHtml.includes("</article>")
        ) {
          const adUnit = `<div class="ad-unit-container"><span class="ad-unit-label">Advertisement</span><ins id="ad-post-end" class="adsbygoogle" style="display:block" data-ad-client="ca-pub-8565025017387209" data-ad-slot="9477779891" data-ad-format="auto" data-full-width-responsive="true"></ins></div><div class="ad-unit-container mt-4"><span class="ad-unit-label">Advertisement</span><ins class="adsbygoogle" style="display:block" data-ad-format="autorelaxed" data-ad-client="ca-pub-8565025017387209" data-ad-slot="9183511632"></ins></div>`;
          const adInitJs = `<script>(function(){if(location.hostname!=='thisday.info'&&location.hostname!=='www.thisday.info')return;function pushIns(el){if(!el.getAttribute('data-adsbygoogle-status')&&!el.getAttribute('data-ad-pushed')){el.setAttribute('data-ad-pushed','1');try{(adsbygoogle=window.adsbygoogle||[]).push({});}catch(e){}}}var units=document.querySelectorAll('ins.adsbygoogle');if('IntersectionObserver' in window){var io=new IntersectionObserver(function(e,o){e.forEach(function(en){if(en.isIntersecting){pushIns(en.target);o.unobserve(en.target);}});},{threshold:0.1});units.forEach(function(el){io.observe(el);});}else{units.forEach(pushIns);}})();<\/script>`;
          const bodyClose2 = patchedHtml.includes("</body>")
            ? "</body>"
            : "</html>";
          const lastArticleIdx = patchedHtml.lastIndexOf("</article>");
          patchedHtml =
            patchedHtml.slice(0, lastArticleIdx + "</article>".length) +
            "\n" +
            adUnit +
            patchedHtml.slice(lastArticleIdx + "</article>".length);
          patchedHtml = patchedHtml.replace(
            bodyClose2,
            adInitJs + "\n" + bodyClose2,
          );
        }
        // Repair stored posts whose featured image is broken or a logo, seal,
        // flag, or similar low-value asset. Fully non-blocking — network calls
        // (isWorkingImageUrl + fetchWikipediaImage) moved to waitUntil so they
        // never block the response and can't trigger 1102.
        if (
          allowArticleKvBackgroundWrites &&
          ctx?.waitUntil &&
          !patchedHtml.includes(FEATURED_IMAGE_CHECK_MARKER)
        ) {
          const wikiUrlForRepair = extractWikiUrl(patchedHtml);
          const coverUrlForRepair = extractCoverSrc(patchedHtml);
          if (wikiUrlForRepair && coverUrlForRepair) {
            const htmlForRepair = patchedHtml;
            ctx.waitUntil((async () => {
              try {
                if (!(await canRunRepairAttempt(env, slug, "featured-image"))) return;
                const needsRepair =
                  isLowValueFeaturedImage(coverUrlForRepair) ||
                  !(await isWorkingImageUrl(coverUrlForRepair));
                if (!needsRepair) {
                  await env.BLOG_AI_KV.put(
                    `${KV_POST_PREFIX}${slug}`,
                    addHtmlMarker(htmlForRepair, FEATURED_IMAGE_CHECK_MARKER),
                  );
                  await clearRepairAttempt(env, slug, "featured-image");
                  return;
                }
                const replacement = await fetchWikipediaImage("", wikiUrlForRepair);
                if (!replacement || replacement === coverUrlForRepair) {
                  await env.BLOG_AI_KV.put(
                    `${KV_POST_PREFIX}${slug}`,
                    addHtmlMarker(htmlForRepair, FEATURED_IMAGE_CHECK_MARKER),
                  );
                  await clearRepairAttempt(env, slug, "featured-image");
                  return;
                }
                const repaired = addHtmlMarker(
                  htmlForRepair
                    .replaceAll(encodeURIComponent(coverUrlForRepair), encodeURIComponent(replacement))
                    .replaceAll(coverUrlForRepair, replacement),
                  FEATURED_IMAGE_CHECK_MARKER,
                );
                await env.BLOG_AI_KV.put(`${KV_POST_PREFIX}${slug}`, repaired);
                const indexRaw2 = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
                const index2 = indexRaw2 ? JSON.parse(indexRaw2) : [];
                const found = index2.find((entry) => entry?.slug === slug);
                if (found) {
                  found.imageUrl = replacement;
                  await env.BLOG_AI_KV.put(KV_INDEX_KEY, JSON.stringify(index2));
                }
                await clearRepairAttempt(env, slug, "featured-image");
              } catch {
                // best-effort repair
              }
            })());
          }
        }
        // Entity strip — fully non-blocking. Serve the cached HTML immediately;
        // hydrate + inject only when the stored article is missing cached data.
        const entityStripKnownEmpty = String(articleEntitiesRaw || "").trim() === "[]";
        const entityStripNeedsImageRepair = articleEntityStripNeedsImageRepair(patchedHtml);
        const entityStripNeedsProfileValidation =
          articleEntityStripNeedsProfileValidation(patchedHtml, articleEntitiesRaw);
        if (
          ctx?.waitUntil &&
          allowArticleKvBackgroundWrites &&
          !entityStripKnownEmpty &&
          (!patchedHtml.includes(ENTITY_STRIP_BACKFILL_MARKER) || entityStripNeedsImageRepair || entityStripNeedsProfileValidation) &&
          (!patchedHtml.includes('data-entity-strip="1"') || !articleEntitiesRaw || entityStripNeedsImageRepair || entityStripNeedsProfileValidation)
        ) {
          const htmlSnapshot = patchedHtml;
          ctx.waitUntil((async () => {
            try {
              if (!(await canRunRepairAttempt(env, slug, "entity-strip", REPAIR_ATTEMPT_LIMIT, ENTITY_STRIP_REPAIR_TTL))) return;
              const parsedEntityMeta = articleEntitiesRaw
                ? JSON.parse(articleEntitiesRaw)
                : extractArticlePeopleMetaFromHtml(htmlSnapshot);
              if (!Array.isArray(parsedEntityMeta) || parsedEntityMeta.length === 0) {
                if (!articleEntitiesRaw) {
                  await env.BLOG_AI_KV.put(`post-entities:${slug}`, "[]");
                }
                await clearRepairAttempt(env, slug, "entity-strip");
                return;
              }
              const entityMeta = await hydrateArticleEntityImages(env, parsedEntityMeta);
              const strip = buildArticleEntityStrip(entityMeta);
              const entityMetaRaw = JSON.stringify(entityMeta);
              if (!strip) {
                const strippedHtml = removeArticleEntityStripHtml(htmlSnapshot);
                const writes = [
                  env.BLOG_AI_KV.put(
                    `${KV_POST_PREFIX}${slug}`,
                    addHtmlMarker(strippedHtml, ENTITY_STRIP_BACKFILL_MARKER),
                  ),
                ];
                if (!articleEntitiesRaw || entityMetaRaw !== articleEntitiesRaw) {
                  writes.push(env.BLOG_AI_KV.put(`post-entities:${slug}`, entityMetaRaw));
                }
                await Promise.all(writes);
                await clearRepairAttempt(env, slug, "entity-strip");
                return;
              }
              let updated = htmlSnapshot;
              if (updated.includes("data-entity-strip")) {
                updated = replaceArticleEntityStripHtml(updated, strip);
              } else {
                const heroWrapIdx = updated.indexOf('<div class="article-hero-wrap">');
                const heroWrapEnd = findArticleHeroWrapEnd(updated, heroWrapIdx);
                if (heroWrapEnd !== -1) {
                  updated = updated.slice(0, heroWrapEnd) + "\n" + strip + updated.slice(heroWrapEnd);
                } else {
                  const heroAnchor = updated.includes('<figure class="text-center mb-4 article-hero-fig">')
                    ? '<figure class="text-center mb-4 article-hero-fig">'
                    : '<figure class="text-center mb-4">';
                  const heroIdx = updated.indexOf(heroAnchor);
                  const figureEnd = heroIdx !== -1 ? updated.indexOf("</figure>", heroIdx) : -1;
                  if (figureEnd !== -1) {
                    const insertAfter = figureEnd + "</figure>".length;
                    updated = updated.slice(0, insertAfter) + "\n" + strip + updated.slice(insertAfter);
                  }
                }
              }
              updated = moveEntityStripOutOfArticleHero(updated);
              const writes = [];
              if (updated !== htmlSnapshot) {
                updated = addHtmlMarker(updated, ENTITY_STRIP_BACKFILL_MARKER);
                writes.push(env.BLOG_AI_KV.put(`${KV_POST_PREFIX}${slug}`, updated));
              }
              if (!articleEntitiesRaw || entityMetaRaw !== articleEntitiesRaw) {
                writes.push(env.BLOG_AI_KV.put(`post-entities:${slug}`, entityMetaRaw));
              }
              await Promise.all(writes);
              // Only reset the per-day attempt counter when the strip is fully
              // resolved — no missing portrait AND no person still pending profile
              // validation. A permanently-unlinkable person (a title/disambiguation
              // page, or a too-thin bio) leaves needsProfileValidation true forever;
              // without this guard the counter reset every serve and re-ran hydration
              // (Wikipedia fetches) in an unbounded loop. Leaving the counter intact
              // lets REPAIR_ATTEMPT_LIMIT (2/day) cap the retries. (2026-06-26)
              if (
                !articleEntityStripNeedsImageRepair(updated) &&
                !articleEntityStripNeedsProfileValidation(updated, entityMetaRaw)
              ) {
                await clearRepairAttempt(env, slug, "entity-strip");
              }
            } catch {
              // best-effort
            }
          })());
        }
        if (
          ctx?.waitUntil &&
          allowArticleKvBackgroundWrites &&
          amazonTracksNeedCoverBackfill(patchedHtml) &&
          !patchedHtml.includes(AMAZON_COVERS_BACKFILL_MARKER)
        ) {
          const htmlSnapshot = patchedHtml;
          ctx.waitUntil((async () => {
            try {
              if (!(await canRunRepairAttempt(env, slug, "amazon-covers"))) return;
              const key = `${KV_POST_PREFIX}${slug}`;
              const latestHtml = await env.BLOG_AI_KV.get(key).catch(() => null) || htmlSnapshot;
              const updated = await hydrateAmazonBlocksInHtml(latestHtml);
              if (updated !== latestHtml) {
                await env.BLOG_AI_KV.put(
                  key,
                  addHtmlMarker(updated, AMAZON_COVERS_BACKFILL_MARKER),
                );
                await clearRepairAttempt(env, slug, "amazon-covers");
              }
            } catch {
              // best-effort
            }
          })());
        }
        const ytEntry = ytRaw ? (JSON.parse(ytRaw)[slug] ?? null) : null;
        if (ytEntry?.youtubeId && ytEntry.privacy !== "private") {
          const ytIframe = `<!-- YouTube -->
          <div class="my-4">
            <iframe
              width="100%"
              style="aspect-ratio:9/16;border:none;border-radius:8px"
              src="https://www.youtube.com/embed/${ytEntry.youtubeId}"
              title="Watch on YouTube"
              allowfullscreen
              loading="lazy"
            ></iframe>
          </div>

          <!-- Aftermath -->`;
          let ytHtml = patchedHtml.replace(
            /<!-- YouTube -->[\s\S]*?<!-- Aftermath -->/,
            ytIframe,
          );
          // Normalize older non-www Shorts links in stored HTML/JSON-LD.
          ytHtml = ytHtml.replace(
            /https:\/\/youtube\.com\/shorts\//g,
            "https://www.youtube.com/shorts/",
          );
          // Inject VideoObject JSON-LD schema for SEO
          if (!ytHtml.includes('"@type":"VideoObject"')) {
            // Extract title and description from the existing article schema or meta tags
            const titleMatch = ytHtml.match(
              /<meta property="og:title" content="([^"]+)"/,
            );
            const descMatch = ytHtml.match(
              /<meta(?:\s+(?:name="description"|property="og:description"))\s+content="([^"]+)"/,
            );
            const postTitle = titleMatch ? titleMatch[1] : slug;
            const postDesc = descMatch ? descMatch[1] : "";
            const videoSchema = {
              "@context": "https://schema.org",
              "@type": "VideoObject",
              name: postTitle,
              description: postDesc,
              thumbnailUrl:
                VIDEO_THUMBNAIL_OVERRIDES[slug] ??
                `https://img.youtube.com/vi/${ytEntry.youtubeId}/maxresdefault.jpg`,
              uploadDate: ytEntry.uploadedAt ?? new Date().toISOString(),
              duration: "PT45S",
              embedUrl: `https://www.youtube.com/embed/${ytEntry.youtubeId}`,
              contentUrl: `https://www.youtube.com/shorts/${ytEntry.youtubeId}`,
              publisher: {
                "@type": "Organization",
                name: "thisDay.info",
                url: "https://thisday.info",
                logo: {
                  "@type": "ImageObject",
                  url: "https://thisday.info/icons/android-chrome-192x192.png",
                },
              },
            };
            ytHtml = ytHtml.replace(
              "</head>",
              `<script type="application/ld+json">${JSON.stringify(videoSchema)}<\/script></head>`,
            );
          }
          return htmlResponse(moveEntityStripOutOfArticleHero(ytHtml));
        }
        // Inline quiz JSON so popup opens instantly (no fetch round-trip)
        const inlineQuizRaw = await env.BLOG_AI_KV.get(`quiz-v3:blog:${slug}`);
        const inlineQuiz = parseValidBlogQuiz(inlineQuizRaw);
        if (inlineQuiz) {
          const bodyCloseInline = patchedHtml.includes("</body>")
            ? "</body>"
            : "</html>";
          patchedHtml = patchedHtml.replace(
            bodyCloseInline,
            `<script>window.__tdqQuiz=${JSON.stringify(inlineQuiz)};<\/script>\n${bodyCloseInline}`,
          );
        } else if (inlineQuizRaw && allowArticleKvBackgroundWrites) {
          ctx.waitUntil(env.BLOG_AI_KV.delete(`quiz-v3:blog:${slug}`).catch(() => {}));
        }
        // Pre-warm quiz in background so it's ready before the user clicks "Take the Quiz"
        if (allowArticleKvBackgroundWrites) ctx.waitUntil(
          (async () => {
            const cachedRaw =
              inlineQuizRaw ||
              (await env.BLOG_AI_KV.get(`quiz-v3:blog:${slug}`));
            if (!parseValidBlogQuiz(cachedRaw) && hasAnyTextAIProvider(env)) {
              try {
                const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
                const index = indexRaw ? JSON.parse(indexRaw) : [];
                const entry = index.find((p) => p.slug === slug);
                if (entry) {
                  const richContent = await buildRichContent(entry, slug);
                  const quiz = await generateBlogQuiz(env, richContent, slug);
                  if (quiz)
                    await env.BLOG_AI_KV.put(
                      `quiz-v3:blog:${slug}`,
                      JSON.stringify(quiz),
                      { expirationTtl: 90 * 86_400 },
                    );
                }
              } catch (e) {
                console.error("Quiz pre-warm failed:", e);
              }
            }
          })(),
        );
        const entityStripFixedHtml = moveEntityStripOutOfArticleHero(patchedHtml);
        if (
          entityStripFixedHtml !== patchedHtml &&
          allowArticleKvBackgroundWrites &&
          ctx?.waitUntil
        ) {
          ctx.waitUntil(
            env.BLOG_AI_KV.put(`${KV_POST_PREFIX}${slug}`, entityStripFixedHtml).catch(() => {}),
          );
        }
        return htmlResponse(entityStripFixedHtml);
      }
    }

    // Intercept old-format static blog posts (/blog/month/day-year) and inject quiz + patches
    const staticBlogMatch = path.match(/^\/blog\/([a-z]+\/\d+-\d{4})\/?$/);
    if (staticBlogMatch) {
      const slug = staticBlogMatch[1]; // e.g., "august/1-2025"
      const originResp = await fetch(request);
      if (
        !originResp.ok ||
        !originResp.headers.get("Content-Type")?.includes("text/html")
      ) {
        return originResp;
      }
      let html = await originResp.text();
      // Patch old or partial nav chrome → canonical site nav
      if (!html.includes("data-site-nav")) {
        if (html.includes('class="navbar')) {
          html = html.replace(
            /<nav class="navbar[\s\S]*?<\/nav>\s*(?:<div class="marquee-bar"[\s\S]*?<\/div>)?/,
            staticNavMountMarkup({ includeMarquee: true, supportPopup: true }),
          );
        } else if (html.includes('class="nav"')) {
          html = html.replace(
            /<nav class="nav"[\s\S]*?<\/nav>\s*(?:<div class="marquee-bar"[\s\S]*?<\/div>)?/,
            staticNavMountMarkup({ includeMarquee: true, supportPopup: true }),
          );
        }
      }
      html = ensureBlogChromeAssets(html);
      html = injectBlogNavWidthFix(html);
      // Patch old footer
      if (html.includes('class="footer"') && !html.includes("footer-inner")) {
        html = html.replace(
          /<footer class="footer">[\s\S]*?<\/footer>\s*(?=<\/body>|<\/html>|$)/,
          siteFooter(),
        );
      }
      // Patch old CSS vars (blue palette) → green
      if (html.includes("--primary-bg") || html.includes("--card-bg")) {
        html = html.replace(
          /:root\s*\{[^}]*--primary-bg[^}]*\}/,
          `:root{--bg:#ffffff;--bg-alt:#f2f7f2;--text:#1a2e20;--text-muted:#5c7a65;--border:#cfe0cf;--btn-bg:#1b3a2d;--btn-text:#fff;--btn-hover:#2a4d3a;--accent:#9dc43a;--radius:4px;--shadow:0 16px 32px -8px rgba(27,58,45,.08)}`,
        );
        html = html.replace(/body\.dark-theme\s*\{[^}]*\}/g, "");
        html = html
          .replaceAll("var(--card-bg)", "var(--bg)")
          .replaceAll("var(--text-color)", "var(--text)")
          .replaceAll("var(--primary-bg)", "var(--btn-bg)")
          .replaceAll("var(--footer-bg)", "var(--bg-alt)")
          .replaceAll("var(--link-color)", "var(--btn-bg)");
        html = html.replace(
          /body\s*\{[^}]*font-family:\s*Inter[^}]*\}/,
          "body{font-family:Lora,serif;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--text)}",
        );
      }
      // Patch Inter → Lora font
      if (
        html.includes("font-family:Inter") ||
        html.includes("font-family: Inter")
      ) {
        html = html.replace(
          /font-family:\s*['"]?Inter[^;]*/g,
          "font-family:Lora,serif",
        );
      }
      // Inject NAV_CSS + FOOTER_CSS if missing
      if (!html.includes(".nav-inner")) {
        html = html.replace(
          "</head>",
          `<style>${NAV_CSS}\n${FOOTER_CSS}</style></head>`,
        );
      }
      // Add navToggle script if missing
      html = html.replace(
        /<script>\s*\(function\(\)\{var t=document.getElementById\("navToggle"\),m=document.getElementById\("navMobile"\)[\s\S]*?<\/script>/g,
        "",
      );
      html = html.replace(
        /<script>\s*\(function\(\)\{var bar=document.getElementById\('marqueeBar'\),track=document.getElementById\('marqueeTrack'\)[\s\S]*?<\/script>/g,
        "",
      );
      // Fix related-question-card paragraphs that end with … (AI-truncated in stored HTML)
      if (html.includes('related-question-card') && html.includes('…</p>')) {
        html = html.replace(
          /(<article class="related-question-card">[\s\S]*?<p>)([^<]*…)(<\/p>)/g,
          (_, open, text, close) => {
            const lastEnd = text.search(/[.!?][^.!?]*$/);
            if (lastEnd !== -1) return open + text.slice(0, lastEnd + 1) + close;
            return open + text.replace(/\s+\S*…$/, '.') + close;
          },
        );
      }
      // Upgrade old amber-style Quiz CTA to authority-links style
      if (!html.includes('quiz-cta-patch-v1') && html.includes('rgba(245,158,11,.08)')) {
        html = html.replace(
          /<div[^>]*rgba\(245,158,11[^>]*>[\s\S]*?<\/div>\s*<\/div>/,
          `<div class="authority-links mt-4"><!-- quiz-cta-patch-v1 -->
          <span class="authority-links-label">Test Your Knowledge</span>
          <p style="font-size:15px;margin:0 0 10px">Can you answer 5 questions about this event?</p>
          <div class="authority-links-row">
            <a class="authority-link" id="tdq-cta-btn" href="/quiz/" onclick="event.preventDefault();if(typeof maybeLoadAndShowQuiz==='function')maybeLoadAndShowQuiz();">Take the Quiz <i class="bi bi-arrow-right ms-1"></i></a>
          </div>
        </div>`,
        );
      }
      // Inject quiz CTA + popup if no quiz present
      if (!html.includes("tdq-cta-btn")) {
        const quizCta = `
          <div class="authority-links mt-4">
            <span class="authority-links-label">Test Your Knowledge</span>
            <p style="font-size:15px;margin:0 0 10px">Can you answer 5 questions about this event?</p>
            <div class="authority-links-row">
              <a class="authority-link" id="tdq-cta-btn" href="/quiz/" onclick="event.preventDefault();if(typeof maybeLoadAndShowQuiz==='function')maybeLoadAndShowQuiz();">Take the Quiz <i class="bi bi-arrow-right ms-1"></i></a>
            </div>
          </div>`;
        const quizBlock = `
  <div id="tdq-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9998" aria-hidden="true"></div>
  <div id="tdq-popup" role="dialog" aria-modal="true" aria-label="History Quiz" style="display:none;flex-direction:column;position:fixed;bottom:0;left:0;right:0;z-index:9999;max-height:90dvh;background:var(--bg,#fff);border-radius:16px 16px 0 0;box-shadow:0 -4px 32px rgba(0,0,0,.18);font-family:Lora,serif">
    <div id="tdq-header" style="flex-shrink:0;border-bottom:1px solid var(--border,#cfe0cf);padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px">
      <div id="tdq-topic" style="font-size:.72rem;font-weight:700;color:var(--accent,#9dc43a);text-transform:uppercase;letter-spacing:.06em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>
      <button id="tdq-close" aria-label="Close quiz" style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:var(--text-muted,#5c7a65);line-height:1;flex-shrink:0;min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:flex-end">&times;</button>
    </div>
    <div id="tdq-scroll-body" style="overflow-y:auto;padding:16px 20px 32px">
      <h3 style="font-size:1.1rem;font-weight:700;margin-bottom:3px;color:var(--text,#1a2e20)"><i class="bi bi-patch-question-fill me-2" style="color:var(--accent,#9dc43a)"></i>Test Your Knowledge</h3>
      <p style="font-size:.85rem;color:var(--text-muted,#5c7a65);margin-bottom:6px">Based on the article you just read — 5 questions, under a minute.</p>
      <div id="tdq-progress" style="font-size:.78rem;font-weight:600;color:var(--accent,#9dc43a);margin-bottom:16px">0 of 5 answered</div>
      <div id="tdq-questions"></div>
      <div id="tdq-score" class="mt-3" hidden></div>
    </div>
  </div>
  <style>
    .tdq-question{margin-bottom:16px}.tdq-q-text{font-weight:600;margin-bottom:8px;font-size:.9rem;color:var(--text,#1a2e20)}.tdq-options{display:flex;flex-direction:column;gap:7px}
    .tdq-opt{display:flex;align-items:center;gap:9px;padding:8px 12px;border:1.5px solid var(--border,#cfe0cf);border-radius:8px;cursor:pointer;font-size:.88rem;transition:background .15s,border-color .15s;color:var(--text,#1a2e20)}
    .tdq-opt:hover{border-color:var(--accent,#9dc43a);background:rgba(157,196,58,.07)}.tdq-opt-key{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:var(--border,#cfe0cf);font-size:.72rem;font-weight:700;flex-shrink:0}
    .tdq-opt-correct{border-color:#10b981!important;background:#d1fae5!important;color:#0f172a!important}.tdq-opt-wrong{border-color:#ef4444!important;background:#fee2e2!important;color:#0f172a!important}
    .tdq-opt-correct .tdq-opt-key{background:#10b981;color:#fff}.tdq-opt-wrong .tdq-opt-key{background:#ef4444;color:#fff}
    .tdq-feedback{font-size:.82rem;margin-top:4px}.tdq-correct{color:#10b981;font-weight:600}.tdq-wrong{color:#ef4444;font-weight:600}
    .tdq-score-box{font-size:1rem;font-weight:600;padding:12px 14px;background:rgba(157,196,58,.1);border-radius:8px;border-left:4px solid var(--accent,#9dc43a)}.tdq-score-num{color:var(--accent,#9dc43a);font-size:1.15rem}
    #tdq-popup{transition:transform .3s ease;transform:translateY(100%)}.tdq-popup-open{transform:translateY(0)!important;display:flex!important}
  </style>
  <script>
  (function(){
    var slug="${slug}";
    var quizLoaded=false,selected={},answers=[],total=0;
    function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
    function openPopup(){var ol=document.getElementById("tdq-overlay"),pp=document.getElementById("tdq-popup");if(ol)ol.style.display="block";if(pp){pp.style.display="block";requestAnimationFrame(function(){pp.classList.add("tdq-popup-open");});}document.body.style.overflow="hidden";}
    function closePopup(){var pp=document.getElementById("tdq-popup");pp.classList.remove("tdq-popup-open");setTimeout(function(){pp.style.display="none";var ol=document.getElementById("tdq-overlay");if(ol)ol.style.display="none";document.body.style.overflow="";},300);}
    document.getElementById("tdq-close").addEventListener("click",closePopup);
    document.getElementById("tdq-overlay").addEventListener("click",closePopup);
    function renderQuiz(quiz){
      answers=quiz.questions.map(function(q){return Number(q.answer);});
      total=Math.min(quiz.questions.length,5);
      var topicEl=document.getElementById("tdq-topic");
      if(topicEl){var h1=document.querySelector("h1");if(h1)topicEl.textContent="Quiz: "+h1.textContent.trim();}
      var container=document.getElementById("tdq-questions");
      container.innerHTML=quiz.questions.slice(0,total).map(function(q,qi){
        var optsHtml=(q.options||[]).map(function(opt,oi){return '<div class="tdq-opt" data-qi="'+qi+'" data-oi="'+oi+'"><span class="tdq-opt-key">'+String.fromCharCode(65+oi)+"</span>"+esc(String(opt))+"</div>";}).join("");
        var expHtml=q.explanation?'<div id="tdq-e-'+qi+'" hidden style="font-size:.82rem;margin-top:6px;padding:7px 11px;background:rgba(0,0,0,.035);border-left:3px solid var(--btn-bg,#1b3a2d);border-radius:0 6px 6px 0">'+esc(String(q.explanation))+"</div>":"";
        var actionBtn=qi<total-1?'<button class="tdq-next-btn" data-qi="'+qi+'" style="display:none;width:100%;margin-top:18px;padding:12px;background:var(--btn-bg,#1b3a2d);color:var(--accent,#9dc43a);border:none;border-radius:10px;font-size:.95rem;font-weight:600;cursor:pointer">Next Question <i class="bi bi-arrow-right"></i></button>':'<button id="tdq-finish-btn" style="display:none;width:100%;margin-top:18px;padding:12px;background:var(--btn-bg,#1b3a2d);color:var(--accent,#9dc43a);border:none;border-radius:10px;font-size:.95rem;font-weight:600;cursor:pointer"><i class="bi bi-check2-circle me-1"></i>See Results</button>';
        return '<div class="tdq-question" id="tdq-q-'+qi+'" style="display:'+(qi===0?"block":"none")+'"><p class="tdq-q-text"><strong>'+(qi+1)+".</strong> "+esc(String(q.q))+"</p><div class=\"tdq-options\">"+optsHtml+"</div><div class=\"tdq-feedback\" id=\"tdq-f-"+qi+'" hidden></div>'+expHtml+actionBtn+"</div>";
      }).join("");
      container.querySelectorAll(".tdq-opt").forEach(function(opt){
        opt.addEventListener("click",function(){
          var qi=parseInt(this.dataset.qi),oi=parseInt(this.dataset.oi);
          if(selected[qi]!==undefined)return;
          selected[qi]=oi;
          var correct=answers[qi];
          container.querySelectorAll('[data-qi="'+qi+'"]').forEach(function(o){o.style.pointerEvents="none";});
          container.querySelectorAll('[data-qi="'+qi+'"]')[correct].classList.add("tdq-opt-correct");
          var fb=document.getElementById("tdq-f-"+qi);fb.hidden=false;
          if(oi===correct){this.classList.add("tdq-opt-correct");fb.innerHTML='<span class="tdq-correct">✓ Correct!</span>';}
          else{this.classList.add("tdq-opt-wrong");fb.innerHTML='<span class="tdq-wrong">✗ Incorrect.</span> Correct: <strong>'+String.fromCharCode(65+correct)+"</strong>";}
          var exp=document.getElementById("tdq-e-"+qi);if(exp)exp.hidden=false;
          var progEl=document.getElementById("tdq-progress");if(progEl)progEl.textContent=Object.keys(selected).length+" of "+total+" answered";
          var nb=container.querySelector('[data-qi="'+qi+'"].tdq-next-btn');if(nb)nb.style.display="";
          var fb2=document.getElementById("tdq-finish-btn");if(fb2&&qi===total-1)fb2.style.display="";
        });
      });
      container.addEventListener("click",function(e){
        var btn=e.target.closest(".tdq-next-btn");if(!btn)return;
        var qi=parseInt(btn.dataset.qi);
        var inner=document.getElementById("tdq-scroll-body");if(inner)inner.scrollTop=0;
        document.getElementById("tdq-q-"+qi).style.display="none";
        document.getElementById("tdq-q-"+(qi+1)).style.display="block";
      });
      var finBtn=document.getElementById("tdq-finish-btn");
      if(finBtn)finBtn.addEventListener("click",function(){
        var score=0;answers.forEach(function(c,qi){if(selected[qi]===c)score++;});
        this.hidden=true;
        document.getElementById("tdq-q-"+(total-1)).style.display="none";
        var pct=Math.round(score/answers.length*100);
        var msg=pct===100?"Perfect score!":pct>=80?"Excellent!":pct>=60?"Good job!":"Keep learning!";
        var el=document.getElementById("tdq-score");el.hidden=false;
        el.innerHTML='<div class="tdq-score-box">You scored <span class="tdq-score-num">'+score+"/"+answers.length+"</span> ("+pct+"%) — "+msg+"</div>";
        var inner=document.getElementById("tdq-scroll-body");if(inner)inner.scrollTop=0;
      });
    }
    window.maybeLoadAndShowQuiz=function(){
      if(quizLoaded){openPopup();return;}
      quizLoaded=true;
      fetch("/blog/quiz/"+slug).then(function(r){return r.ok?r.json():null;}).then(function(quiz){if(!quiz||!quiz.questions||quiz.questions.length<3)return;renderQuiz(quiz);openPopup();}).catch(function(){});
    };
  })();
  <\/script>`;
        // Inject quiz CTA before </article> or </body>
        const insertBefore = html.includes("</article>")
          ? "</article>"
          : html.includes("</body>")
            ? "</body>"
            : "</html>";
        html = html.replace(insertBefore, quizCta + "\n" + insertBefore);
        const bodyClose = html.includes("</body>") ? "</body>" : "</html>";
        html = html.replace(bodyClose, quizBlock + "\n" + bodyClose);
      }
      // Inject support popup if not present
      if (!html.includes("supportPopup")) {
        const bodyClose = html.includes("</body>") ? "</body>" : "</html>";
        html = html.replace(
          bodyClose,
          supportPopupSnippet() + "\n" + bodyClose,
        );
      }
      return new Response(html, {
        headers: {
          "Content-Type": "text/html;charset=UTF-8",
          "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
          "X-Patched": "static-blog",
        },
      });
    }

    // Pass through to origin; intercept 404 HTML responses with a helpful page.
    const originResponse = await fetch(request);
    if (
      originResponse.status === 404 &&
      (request.headers.get("Accept") ?? "").includes("text/html")
    ) {
      return serve404(env);
    }
    return originResponse;
  },
};

// ---------------------------------------------------------------------------
// Generation logic
// ---------------------------------------------------------------------------

/**
 * Checks the last generation date and generates a new post if enough days
 * have passed (every EVERY_OTHER_DAYS days).
 *
 * Daily source preparation and draft generation are deliberately separate.
 * Provider fallback already handles transient model failures inside one draft
 * attempt; retrying the whole pipeline in one invocation can only spend the
 * same finite subrequest budget again. The GitHub failsafe is the next
 * independent retry.
 */
function draftSourceKey(date) {
  return `${KV_DRAFT_SOURCE_PREFIX}${buildSlug(date)}`;
}

function preparedDraftSourceEvent(payload, date) {
  if (
    !payload ||
    payload.version !== DRAFT_SOURCE_VERSION ||
    payload.slug !== buildSlug(date) ||
    !payload.selectedEvent
  ) {
    return null;
  }
  const selectedEvent = payload.selectedEvent;
  if (
    !selectedEvent.eventTitle ||
    !selectedEvent.sourcePageTitle ||
    !selectedEvent.sourceText ||
    !selectedEvent.sourceExtract ||
    !selectedEvent.wikiUrl
  ) {
    return null;
  }
  const dateValidation = validateContentDateForPublish(selectedEvent, date);
  if (!dateValidation.ok) return null;
  const sourcePages = normalizeSourcePages(selectedEvent.sourcePages || []);
  if (
    sourcePages.length < 2 ||
    !sourcePages.some((page) => page.verifiedIndependent === true)
  ) {
    return null;
  }
  return { ...selectedEvent, sourcePages };
}

async function loadPreparedDraftSource(env, date) {
  try {
    const payload = await env.BLOG_AI_KV.get(draftSourceKey(date), {
      type: "json",
    });
    const selectedEvent = preparedDraftSourceEvent(payload, date);
    if (!selectedEvent && payload) {
      await env.BLOG_AI_KV.delete(draftSourceKey(date)).catch(() => {});
    }
    return selectedEvent;
  } catch (err) {
    console.warn(`Blog AI: prepared draft source lookup failed — ${err.message}`);
    return null;
  }
}

async function storePreparedDraftSource(env, date, selectedEvent) {
  const payload = {
    version: DRAFT_SOURCE_VERSION,
    slug: buildSlug(date),
    preparedAt: new Date().toISOString(),
    selectedEvent,
  };
  if (!preparedDraftSourceEvent(payload, date)) {
    throw new Error(`Refusing to cache an incomplete source package for ${buildSlug(date)}`);
  }
  await env.BLOG_AI_KV.put(
    draftSourceKey(date),
    JSON.stringify(payload),
    { expirationTtl: DRAFT_SOURCE_TTL },
  );
}

async function maybePrepareBlogDraftSource(env) {
  const now = new Date();
  const slug = buildSlug(now);
  const draft = await env.BLOG_AI_KV.get(`${KV_DRAFT_PREFIX}${slug}`);
  if (draft) {
    console.log(`Blog AI: draft:${slug} already exists — source preparation skipped.`);
    return { status: "draft-exists", slug };
  }

  const post = await env.BLOG_AI_KV.get(`${KV_POST_PREFIX}${slug}`);
  if (post) {
    const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
    const index = indexRaw ? JSON.parse(indexRaw) : [];
    if (index.some((entry) => entry?.slug === slug)) {
      console.log(`Blog AI: post:${slug} is already public — source preparation skipped.`);
      return { status: "published", slug };
    }
  }

  const prepared = await loadPreparedDraftSource(env, now);
  if (prepared) {
    console.log(`Blog AI: source package for ${slug} is already prepared.`);
    return { status: "prepared", slug, eventTitle: prepared.eventTitle };
  }

  return generateAndStore(env, null, null, null, null, {
    lightweightPublish: true,
    enrichDraft: false,
    prepareOnly: true,
  });
}

async function recoverPendingBlogDraft(env) {
  for (let daysBack = 0; daysBack <= 3; daysBack++) {
    const draftDate = new Date();
    draftDate.setDate(draftDate.getDate() - daysBack);
    const draftSlug = buildSlug(draftDate);
    const draftRaw = await env.BLOG_AI_KV.get(`${KV_DRAFT_PREFIX}${draftSlug}`);
    if (!draftRaw) continue;

    const postRaw = await env.BLOG_AI_KV.get(`${KV_POST_PREFIX}${draftSlug}`);
    let inIndex = false;
    if (postRaw) {
      const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
      const index = indexRaw ? JSON.parse(indexRaw) : [];
      inIndex = index.some((entry) => entry?.slug === draftSlug);
    }
    if (postRaw && inIndex) continue;

    console.log(`Blog AI: recovering draft for /blog/${draftSlug}/...`);
    try {
      await enrichPublishedPost(env, draftSlug);
      console.log(`Blog AI: recovered draft and published /blog/${draftSlug}/.`);
      return { status: "published", slug: draftSlug };
    } catch (err) {
      console.error(`Blog AI: draft recovery failed for ${draftSlug} — ${err.message}`);
      await recordPipelineFailure(env, {
        step: "blog",
        slug: draftSlug,
        message: err.message,
        date: new Date(),
      });
      await optionalBlogKvPut(
        env,
        `debug:enrich-error:${draftSlug}`,
        JSON.stringify({
          error: err.message,
          stack: err.stack?.slice(0, 500),
          ts: new Date().toISOString(),
          source: "draftRecovery",
        }),
        { expirationTtl: 7 * 86_400 },
      );
      throw err;
    }
  }
  console.log("Blog AI: no pending draft found for enrichment.");
  return { status: "no-draft", slug: null };
}

async function maybeGenerateBlogPost(
  env,
  ctx,
  { preferWorkersAIForArticle = false } = {},
) {
  const today = todayDateString(); // "YYYY-MM-DD"
  const todaySlug = buildSlug(new Date());
  const lastGen = await env.BLOG_AI_KV.get(KV_LAST_GEN_KEY);

  const todayPost = await env.BLOG_AI_KV.get(`${KV_POST_PREFIX}${todaySlug}`);
  const todayDraft = await env.BLOG_AI_KV.get(`${KV_DRAFT_PREFIX}${todaySlug}`);
  let todayInIndex = false;
  if (todayPost) {
    const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
    const index = indexRaw ? JSON.parse(indexRaw) : [];
    todayInIndex = index.some((entry) => entry?.slug === todaySlug);
  }
  if (todayDraft && (!todayPost || !todayInIndex)) {
    console.log(
      `Blog AI: draft:${todaySlug} already exists — awaiting the ${DRAFT_ENRICHMENT_MINUTE}-minute enrichment phase.`,
    );
    return;
  }
  // Skip check comes BEFORE entity refresh so generation subrequests are never
  // consumed by the refresh when a new post still needs to be written today.
  if (lastGen) {
    const diffDays = Math.round(
      (new Date(today) - new Date(lastGen)) / 86_400_000,
    );
    if (diffDays < EVERY_OTHER_DAYS && todayPost && todayInIndex) {
      console.log(
        `Blog AI: last post was ${diffDays} day(s) ago — skipping (need ${EVERY_OTHER_DAYS}).`,
      );
      if (blogKvBackgroundWritesPaused(env)) {
        console.warn(
          "Blog AI: entity refresh skipped because optional KV writes are paused.",
        );
        return;
      }
      // Post is already published — safe to spend subrequests on entity refresh.
      try {
        const entityIdxRaw = await env.BLOG_AI_KV.get(KV_ENTITY_INDEX_KEY);
        const entityIdx = entityIdxRaw ? JSON.parse(entityIdxRaw) : [];
        const stale = entityIdx.filter((e) =>
          e.wikiUrl &&
          (
            e.needsWikiRefresh ||
            e.needsEvergreenRefresh ||
            (
              e.historyQualityGateVersion !== BLOG_HISTORY_QUALITY_GATE_VERSION &&
              (!e.indexable || !e.summary || !e.imageUrl)
            )
          )
        );
        const toRefresh = stale.slice(0, 3);
        const postIndexRaw = toRefresh.length ? await env.BLOG_AI_KV.get(KV_INDEX_KEY) : null;
        const postIndex = postIndexRaw ? JSON.parse(postIndexRaw) : [];
        for (const entry of toRefresh) {
          try {
            const kvKey =
              `entity-v1:${entry.type}:${entry.storageSlug || entry.slug}`;
            const entityRaw = await env.BLOG_AI_KV.get(kvKey);
            if (!entityRaw) continue;
            const entity = JSON.parse(entityRaw);
            const freshWiki = await fetchWikipediaEntityData({ wikiUrl: entity.wikiUrl, term: entity.name, type: entity.type }).catch(() => ({}));
            if (!freshWiki.intro && !freshWiki.summary) continue;
            if (freshWiki.wikidataEntityId) {
              entity.wikidataEntityId = freshWiki.wikidataEntityId;
            }
            if (typeof freshWiki.wikidataInstanceOfHuman === "boolean") {
              entity.wikidataInstanceOfHuman =
                freshWiki.wikidataInstanceOfHuman;
            }
            if (
              entity.type === "person" &&
              !hasRichWikipediaPersonProfile({ ...entity, ...freshWiki })
            ) {
              entity.profileLinkEligible = false;
              entity.profileSubjectVerified = false;
              entity.needsWikiRefresh = true;
              entity.updatedAt = new Date().toISOString();
              await env.BLOG_AI_KV.put(kvKey, JSON.stringify(entity));
              console.warn(`Blog AI: kept entity ${kvKey} unlinked because Wikipedia lacks a substantive biography page.`);
              continue;
            }
            entity.summary = freshWiki.summary || "";
            entity.intro = freshWiki.intro || freshWiki.summary || "";
            entity.description = freshWiki.description || entity.description || "";
            entity.imageUrl = freshWiki.imageUrl || entity.imageUrl || "";
            entity.resolvedPageTitle = freshWiki.resolvedPageTitle || entity.resolvedPageTitle || "";
            if (freshWiki.birthDate) entity.birthDate = freshWiki.birthDate;
            if (freshWiki.deathDate) entity.deathDate = freshWiki.deathDate;
            if (entity.type === "person") {
              entity.profileLinkEligible = true;
              entity.profileSubjectVerified = true;
            }
            delete entity.needsWikiRefresh;
            entity.updatedAt = new Date().toISOString();
            const sourceIdx = postIndex.find((e) => e.slug === entity.sourcePostSlug) || {};
            const sourceContent = { ...sourceIdx, historicalDate: inferHistoricalDateFromEntry(sourceIdx) };
            const fallbackCards = entity.type === "person"
              ? buildPersonOverviewCards(entity)
              : buildEventOverviewCards(entity, sourceContent);
            const fallbackSections = buildFallbackEntityBodySections(
              entity,
              sourceContent,
            );
            if (
              entity.type === "event" &&
              entity.historyQualityGateVersion ===
                BLOG_HISTORY_QUALITY_GATE_VERSION
            ) {
              if (!Array.isArray(entity.overviewCards)) {
                entity.overviewCards = fallbackCards;
              }
              if (!Array.isArray(entity.bodySections)) {
                entity.bodySections = fallbackSections;
              }
              if (entity.needsEvergreenRefresh) {
                const edition = await generateEvergreenHistoryEdition(env, entity);
                if (edition) {
                  Object.assign(entity, edition, {
                    historyLinkEligible: true,
                    evergreenReadyAt: new Date().toISOString(),
                  });
                  delete entity.needsEvergreenRefresh;
                } else {
                  entity.historyLinkEligible = false;
                }
              }
            } else {
              entity.overviewCards = await generateEntityOverviewCards(
                env,
                entity,
                sourceContent,
                fallbackCards,
              );
              entity.bodySections = await generateEntityBodySections(
                env,
                entity,
                sourceContent,
                fallbackSections,
              );
            }
            if (entity.type === "person") {
              const timeline = await generateEntityTimeline(env, entity).catch(() => []);
              if (timeline.length) entity.timeline = timeline;
              else delete entity.timeline;
            }
            await env.BLOG_AI_KV.put(kvKey, JSON.stringify(entity));
            await upsertEntityIndex(env, [entity]);
            if (isHistoryEntityDiscoveryLinkEligible(entity)) {
              await syncEvergreenHistoryDiscoveryForEntity(env, entity)
                .catch((syncErr) => {
                  console.warn(
                    `Blog AI: evergreen article-card sync failed for ${entry.slug} — ${syncErr.message}`,
                  );
                });
            }
            console.log(`Blog AI: refreshed wiki data for entity ${kvKey}`);
          } catch (refreshErr) {
            console.warn(`Blog AI: wiki refresh failed for ${entry.slug} — ${refreshErr.message}`);
          }
        }
      } catch (idxErr) {
        console.warn(`Blog AI: entity refresh scan failed — ${idxErr.message}`);
      }
      return;
    }
  }

  // Mark today as attempted before generating so tomorrow's cron always starts
  // from today's date regardless of whether generation succeeds or fails.
  await env.BLOG_AI_KV.put(KV_LAST_GEN_KEY, today);

  try {
    await generateAndStore(env, ctx, null, null, null, {
      lightweightPublish: true,
      enrichDraft: false,
      preferWorkersAIForArticle,
    });
    console.log(
      `Blog AI: draft generated successfully; the ${DRAFT_ENRICHMENT_MINUTE}-minute cron phase will enrich it.`,
    );
    await env.BLOG_AI_KV.delete(`error:${today}`).catch(() => {});
  } catch (err) {
    // Persist the failure and stop. A complete pipeline retry inside this same
    // invocation would inherit the already-spent subrequest allowance. The
    // authenticated 00:35 failsafe provides the clean retry boundary.
    const errMsg = err?.message ?? String(err);
    await recordPipelineFailure(env, {
      step: "blog",
      slug: today,
      message: errMsg,
      date: new Date(),
    });
    await optionalBlogKvPut(
      env,
      `error:${today}`,
      `Generation failed: ${errMsg}`,
      { expirationTtl: 7 * 86_400 },
    );
    console.error(`Blog AI: draft generation failed for ${today}. Error stored in KV.`);
  }
}

/**
 * Fetches a real image URL from the Wikipedia REST API for the given event title.
 * Falls back to null if the request fails or no image is found.
 */
// Generic tokens that do not establish topical relevance for a Commons file
// name match. Pure-digit tokens (years like "1955") are dropped separately: a
// shared year alone must not make an unrelated photo "relevant".
const COMMONS_MATCH_STOPWORDS = new Set([
  "the", "a", "an", "of", "in", "on", "at", "and", "or", "to", "for", "from",
  "by", "with", "de", "la", "el", "los", "las", "von", "der", "di", "du",
  "file", "jpg", "jpeg", "png", "webp", "gif", "svg", "image", "photo",
  "portrait", "wikipedia", "commons",
]);
const FEATURED_IMAGE_SUBJECT_STOPWORDS = new Set([
  "air", "armed", "army", "force", "forces", "historic", "historical",
  "history", "military", "national", "official", "state",
]);

function commonsMatchTokens(text) {
  return String(text || "")
    .replace(/^File:/i, "")
    .replace(/\.[a-z0-9]+$/i, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !COMMONS_MATCH_STOPWORDS.has(w));
}

// A Commons full-text search hit is only trusted as a featured image when its
// file name shares a substantive token with the event topic. Without this a
// search for a dead Wikipedia title ("1955 coup attempt in Argentina") returns
// an unrelated file ("…1955 Military Wedding.jpg") as the hero (June 16, 2026).
function commonsResultIsRelevant(fileTitle, ...topics) {
  const fileTokens = new Set(commonsMatchTokens(fileTitle));
  if (fileTokens.size === 0) return false;
  const topicTokens = topics.flatMap(commonsMatchTokens);
  if (topicTokens.length === 0) return false;
  return topicTokens.some((t) => fileTokens.has(t));
}

function tokenMatches(left, right) {
  const rightSet = right instanceof Set ? right : new Set(right);
  return [...left].filter((token) => rightSet.has(token));
}

function featuredImageMatchTokens(value) {
  return commonsMatchTokens(value).filter(
    (token) => !FEATURED_IMAGE_SUBJECT_STOPWORDS.has(token),
  );
}

function featuredImageContentText(content) {
  const keyTerms = Array.isArray(content?.keyTerms)
    ? content.keyTerms.map((term) => term?.term || "")
    : [];
  const sourcePageTitles = sourcePagesFromContent(content).map((page) => page.pageTitle || "");
  return [
    content?.title,
    content?.eventTitle,
    content?.sourceEventHeadline,
    content?.sourcePageTitle,
    content?.description,
    content?.keywords,
    ...keyTerms,
    ...sourcePageTitles,
  ]
    .filter(Boolean)
    .join(" ");
}

function featuredImageSourcePage(content, imageUrl) {
  const imageKey = wikimediaImageFileKey(imageUrl);
  if (!imageKey) return null;
  return sourcePagesFromContent(content).find(
    (page) => wikimediaImageFileKey(page.imageUrl) === imageKey,
  ) || null;
}

function featuredImageSubjectEvidence(
  content,
  imageUrl,
  { trustedPageTitle = "" } = {},
) {
  const fileName = wikimediaImageFileName(imageUrl);
  const fileTokens = new Set(featuredImageMatchTokens(fileName));
  const contentTokens = new Set(featuredImageMatchTokens(featuredImageContentText(content)));
  const directMatches = tokenMatches(fileTokens, contentTokens);
  const sourcePage = featuredImageSourcePage(content, imageUrl);
  const pageTitle = String(trustedPageTitle || sourcePage?.pageTitle || "").trim();
  const pageTokens = new Set(featuredImageMatchTokens(pageTitle));
  const pageMatches = tokenMatches(pageTokens, contentTokens);
  const sourcePageMatches =
    Boolean(pageTitle) &&
    pageTokens.size > 0 &&
    pageMatches.length > 0 &&
    (Boolean(trustedPageTitle) || Boolean(sourcePage));

  return {
    eligible: directMatches.length > 0 || sourcePageMatches,
    fileName,
    fileTokens: [...fileTokens],
    directMatches,
    pageTitle,
    pageMatches,
    sourcePageMatches,
  };
}

function featuredImageAltEvidence(imageAlt, subjectEvidence) {
  const value = String(imageAlt || "").replace(/\s+/g, " ").trim();
  const altTokens = new Set(featuredImageMatchTokens(value));
  const fileMatches = tokenMatches(altTokens, subjectEvidence?.fileTokens || []);
  const pageMatches = tokenMatches(
    altTokens,
    new Set(featuredImageMatchTokens(subjectEvidence?.pageTitle || "")),
  );
  return {
    eligible:
      value.length >= 5 &&
      altTokens.size >= 1 &&
      (fileMatches.length > 0 || pageMatches.length > 0),
    value,
    fileMatches,
    pageMatches,
  };
}

function groundedFeaturedImageAlt(imageUrl, subjectEvidence) {
  let label = wikimediaImageFileName(imageUrl)
    .replace(/(?:\.(?:jpe?g|png|webp|gif|svg|tiff?|webm))+$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b(?:cropped?|edited?|edit|restored|original|hq|high resolution)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (commonsMatchTokens(label).length === 0) {
    label = String(subjectEvidence?.pageTitle || "").replace(/\s+/g, " ").trim();
  }
  if (!label) return "";
  if (label.length > 125) {
    const shortened = label.slice(0, 125);
    label = shortened.slice(0, shortened.lastIndexOf(" ")).trim() || shortened.trim();
  }
  return label;
}

function prepareFeaturedImageForPublish(
  content,
  imageUrl,
  { trustedPageTitle = "" } = {},
) {
  const reasons = [];
  if (!isProxyableArticleImageUrl(imageUrl)) {
    reasons.push("featured image is not a supported Wikimedia asset");
  }
  if (isLowValueFeaturedImage(imageUrl)) {
    reasons.push("featured image is a logo, flag, seal, map, coat of arms, or other low-value asset");
  }
  const subjectEvidence = featuredImageSubjectEvidence(content, imageUrl, {
    trustedPageTitle,
  });
  if (!subjectEvidence.eligible) {
    reasons.push("featured image filename/source page does not match the article subject");
  }
  if (reasons.length > 0) {
    return { ok: false, reasons, repairedAlt: false, subjectEvidence };
  }

  const currentAlt = featuredImageAltEvidence(content?.imageAlt, subjectEvidence);
  if (currentAlt.eligible) {
    content.imageAlt = currentAlt.value;
    return { ok: true, reasons: [], repairedAlt: false, subjectEvidence };
  }

  const groundedAlt = groundedFeaturedImageAlt(imageUrl, subjectEvidence);
  const repairedAlt = featuredImageAltEvidence(groundedAlt, subjectEvidence);
  if (!repairedAlt.eligible) {
    return {
      ok: false,
      reasons: ["featured image alt text cannot be grounded in the selected Wikimedia file"],
      repairedAlt: false,
      subjectEvidence,
    };
  }
  content.imageAlt = repairedAlt.value;
  return { ok: true, reasons: [], repairedAlt: true, subjectEvidence };
}

async function fetchWikipediaImage(
  eventTitle,
  wikiUrl,
  { skipCommonsSearch = false, skipArticleSearch = false } = {},
) {
  try {
    // Prefer the article slug from the wikiUrl so we hit the right page
    let title = eventTitle;
    if (wikiUrl) {
      const m = wikiUrl.match(/wikipedia\.org\/wiki\/(.+?)(?:\s|$)/);
      if (m) title = decodeURIComponent(m[1].split("#")[0]);
    }

    const ua = { "User-Agent": "thisday.info-blog/1.0 (https://thisday.info)" };

    // 1. REST summary — Wikipedia's explicit lead/featured image for the page.
    //    Trusted unconditionally: if Wikipedia chose it as the lead, we use it.
    const summaryRes = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      { headers: ua },
    );
    if (summaryRes.ok) {
      const d = await summaryRes.json();
      const img = d.originalimage?.source ?? d.thumbnail?.source ?? null;
      if (img) return img;
    }

    // 2. MediaWiki images list + imageinfo — catches infobox images not exposed
    //    by the REST summary (e.g. non-free images under /wikipedia/en/)
    const listRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=images&imlimit=10&format=json`,
      { headers: ua },
    );
    if (!listRes.ok) return null;
    const listData = await listRes.json();
    const page = Object.values(listData?.query?.pages ?? {})[0];
    const imageFiles = (page?.images ?? [])
      .map((i) => i.title)
      .filter(
        (t) =>
          /\.(jpe?g|png|webp|gif)$/i.test(t) &&
          !/icon|logo|wordmark|symbol|emblem|flag|map|seal|coa/i.test(t),
      );

    if (imageFiles.length > 0) {
      const infoRes = await fetch(
        `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(imageFiles[0])}&prop=imageinfo&iiprop=url&format=json`,
        { headers: ua },
      );
      if (infoRes.ok) {
        const infoData = await infoRes.json();
        const infoPage = Object.values(infoData?.query?.pages ?? {})[0];
        const infoUrl = infoPage?.imageinfo?.[0]?.url ?? null;
        if (infoUrl && !isLowValueFeaturedImage(infoUrl)) return infoUrl;
      }
    }

    // Drafts occasionally carry a plausible but nonexistent Wikipedia URL (its
    // REST summary 404s). Search by the human-readable event title — whether no
    // wikiUrl was given OR the supplied one did not resolve — before falling
    // back to Commons. (June 16, 2026: a dead wikiUrl skipped this search and
    // dropped straight to an unrelated Commons hit.)
    if (eventTitle && !skipArticleSearch && (!wikiUrl || !summaryRes.ok)) {
      const searchRes = await fetch(
        `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(eventTitle)}&srnamespace=0&srlimit=1&format=json`,
        { headers: ua },
      );
      if (searchRes.ok) {
        const searchData = await searchRes.json();
        const resultTitle = searchData?.query?.search?.[0]?.title || "";
        if (resultTitle && resultTitle.toLowerCase() !== String(title).toLowerCase()) {
          const searchedImage = await fetchWikipediaImage(resultTitle, "", {
            skipCommonsSearch: true,
            skipArticleSearch: true,
          });
          if (searchedImage) return searchedImage;
        }
      }
    }

    // 3. Wikimedia Commons search — fallback for articles that use only fair-use
    //    images not hosted on Commons, which are invisible to the REST summary API.
    //    Skipped for person entities: text search returns unrelated images too often.
    if (skipCommonsSearch) return null;
    const commonsRes = await fetch(
      `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(title)}&srnamespace=6&srlimit=5&format=json`,
      { headers: ua },
    );
    if (commonsRes.ok) {
      const commonsData = await commonsRes.json();
      const hits = (commonsData?.query?.search ?? [])
        .map((h) => h.title)
        .filter((t) => /\.(jpe?g|png|webp)$/i.test(t) && !/icon|logo|wordmark|symbol|emblem|flag|map|seal|coa/i.test(t));
      // Only trust a hit whose file name is topically relevant to the event.
      // Guards against an unrelated full-text match becoming the hero image.
      const relevantHit = hits.find((t) => commonsResultIsRelevant(t, eventTitle, title));
      if (relevantHit) {
        const commonsInfoRes = await fetch(
          `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(relevantHit)}&prop=imageinfo&iiprop=url&format=json`,
          { headers: ua },
        );
        if (commonsInfoRes.ok) {
          const commonsInfoData = await commonsInfoRes.json();
          const commonsPage = Object.values(commonsInfoData?.query?.pages ?? {})[0];
          const commonsUrl = commonsPage?.imageinfo?.[0]?.url ?? null;
          if (commonsUrl && !isLowValueFeaturedImage(commonsUrl)) return commonsUrl;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

function isLowValueFeaturedImage(url) {
  const value = String(url || "").toLowerCase();
  if (!value) return true;
  if (!isProxyableArticleImageUrl(value)) return true;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // The raw URL still provides enough evidence for the low-value check.
  }
  return (
    /(?:^|[\/_.%-])(logo|wordmark|icon|symbol|emblem|seal|flag|map|coa|crest|insignia)(?:[\/_.%-]|$)/i.test(decoded) ||
    /(?:^|[\/_.%-])coat[_.%-]+of[_.%-]+arms(?:[\/_.%-]|$)/i.test(decoded)
  );
}

async function isWorkingImageUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return false;

    const headers = {
      "User-Agent": "thisday.info-blog/1.0 (https://thisday.info)",
    };

    // HEAD is cheap when supported.
    let res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers,
    });

    // Some CDNs disallow HEAD. Fallback to GET in that case.
    if (res.status === 405 || res.status === 403 || res.status === 501) {
      res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers,
      });
    }

    if (!res.ok) return false;
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    return contentType.startsWith("image/");
  } catch {
    return false;
  }
}

async function resolveWorkingImageForContent(content) {
  const checked = new Set();
  const firstWorking = async (candidates) => {
    for (const candidate of candidates) {
      const imageUrl = typeof candidate === "string" ? candidate : candidate?.imageUrl;
      const trustedPageTitle =
        typeof candidate === "object" ? candidate?.trustedPageTitle || "" : "";
      if (!imageUrl || checked.has(imageUrl)) continue;
      checked.add(imageUrl);
      const subjectEvidence = featuredImageSubjectEvidence(content, imageUrl, {
        trustedPageTitle,
      });
      if (
        subjectEvidence.eligible &&
        !isLowValueFeaturedImage(imageUrl) &&
        isProxyableArticleImageUrl(imageUrl) &&
        await isWorkingImageUrl(imageUrl)
      ) {
        return imageUrl;
      }
    }
    return null;
  };

  // Prefer already-selected assets. Source-page thumbnails come from the
  // authoritative Wikipedia event feed and give enrichment a network-light
  // fallback when the model omits imageUrl or a later Wikipedia API call fails.
  const storedImage = await firstWorking([
    content?.imageUrl,
    ...sourcePagesFromContent(content).map((page) => ({
      imageUrl: page.imageUrl,
      trustedPageTitle: page.pageTitle,
    })),
  ]);
  if (storedImage) return storedImage;

  const wikiImage = await fetchWikipediaImage(content?.eventTitle, content?.wikiUrl);
  const workingWikiImage = await firstWorking([{
    imageUrl: wikiImage,
    trustedPageTitle: wikiTitleFromUrl(content?.wikiUrl) || content?.eventTitle,
  }]);
  if (workingWikiImage) return workingWikiImage;

  // Try wikipedia URL title variant as a backup (decoded slug can differ from eventTitle).
  if (content?.wikiUrl) {
    try {
      const parsed = new URL(content.wikiUrl);
      const slug = parsed.pathname.split("/wiki/")[1];
      if (slug) {
        const slugTitle = decodeURIComponent(slug.split("#")[0]).replace(
          /_/g,
          " ",
        );
        const slugImage = await fetchWikipediaImage(slugTitle, null);
        const workingSlugImage = await firstWorking([{
          imageUrl: slugImage,
          trustedPageTitle: slugTitle,
        }]);
        if (workingSlugImage) return workingSlugImage;
      }
    } catch {
      // ignore malformed URL
    }
  }

  return null;
}

// Phrases the prompt explicitly forbids. Any match is logged as a violation
// so prompt quality can be monitored without blocking generation.
const BANNED_PHRASE_LIST = [
  // Generic importance/impact filler
  "significant event", "pivotal moment", "changed history", "shaped the course of",
  "left a lasting impact", "cannot be overstated", "one of the most important",
  "it is worth noting", "it is important to remember", "this was a time of great change",
  "it is important to note", "conventionally called",
  "the importance of this", "a reminder of", "shows the importance of",
  "demonstrated the power of", "played a crucial role", "played a key role",
  "played a significant role", "played a vital role", "had a profound impact",
  "had a lasting impact", "had a significant impact", "indelible mark",
  "far-reaching consequences", "world was forever changed", "world would never be the same",
  "made history", "turning point", "watershed moment", "stands as a", "serves as a",
  "testament to", "in the annals of history", "throughout history",
  "stood the test of time", "chapter in history", "significant turning point",
  "dramatic and unexpected turn of events", "dramatic and unexpected",
  "remarkable event", "marked the end of a dark period", "brighter future",
  // Mood labels without evidence
  "it was a dark time", "it was a bleak time", "it was a difficult period",
  "it was chaos", "it was a complex time", "dark chapter", "in the face of adversity",
  // Vague connectors and filler
  "at its core", "in many ways", "at the heart of", "in no small part",
  "plays a role", "play a role",
  "it goes without saying", "needless to say", "the fact remains",
  "at the end of the day", "in essence", "in the grand scheme",
  "time and again", "when all is said and done",
  // Casual speech patterns
  "that's the thing", "it's a shame", "he saw it all", "she saw it all",
  "they saw it all", "it's like they", "you have to understand",
  "it's a lesson", "we must not forget", "mustn't forget", "we can't forget",
  "as the world grapples", "it's a reminder", "still resonates today",
  "cannot be forgotten", "reminder of the past", "to this day",
  // AI-giveaway and marketing-hype phrases (Writing Humanizer, 2026-07-03).
  // Deliberately NOT banned: "revolutionary" / "groundbreaking" — legitimate
  // words in historical prose (Revolutionary War, groundbreaking ceremony).
  "dive into", "delve into", "deep dive", "unleash", "game-changing",
  "game changer", "in today's fast-paced world", "fast-paced world",
  "it's worth noting", "it's important to note",
];

const PARA_FIELDS = [
  "overviewParagraphs", "eyewitnessOrChronicle",
  "aftermathParagraphs", "conclusionParagraphs",
];

// Adapted from Anbeeld/WRITING.md compact guidance for rewrite passes.
// Kept short because enrichment runs multiple AI calls under Worker limits.
const WRITING_REWRITE_RULES =
  "WRITING.md rewrite discipline:\n" +
  "- Fit the medium: this is long-form historical web writing for curious general readers, not a chatbot answer or textbook entry.\n" +
  "- Put the answer, consequence, or strongest concrete fact early. Do not warm up with generic setup.\n" +
  "- Every substantial paragraph needs a concrete anchor: a proper noun, number, place, named document, quoted source, decision, or checkable consequence.\n" +
  "- Prefer plain verbs and specific nouns over polished abstraction. Replace vague authority with source-supported anchors or cut the claim.\n" +
  "- Develop one through-line. Do not make sections feel like interchangeable buckets or a chronological list with prettier prose.\n" +
  "- Watch regularity: repeated paragraph arcs, hidden three-part lists, identical openers, tidy concession rhythms, and ceremonial closing sentences.\n" +
  "- Create controlled burstiness: place an occasional short declarative sentence beside a longer layered one, and never write three sentences of similar length or shape in a row. Do not use fragments as decoration.\n" +
  "- Vary sentence openings. Do not march through a paragraph with repeated 'The...' openings, identical subjects, or the same grammatical pattern.\n" +
  "- Reject neat balanced triads, mirrored sentence pairs, symmetrical both-sides hedging, and formulaic transition phrases. Let the evidence determine the shape of the paragraph.\n" +
  "- Keep a serious feature-magazine register: vivid and readable, never chatty, breezy, promotional, second-person, or theatrically over-written.\n" +
  "- Preserve paragraph-local facts. Keep every supported clause, qualifier, example, name, place, date, and number. During a rewrite, introduce no new entity, characterization, comparison, source, or cross-reference.\n" +
  "- Prefer concrete, slightly less predictable verbs when they are exact. Do not reach for a thesaurus, purple prose, or an image the source does not support.\n" +
  "- Cut generic clauses, restatements, announcement sentences, and any phrase that could be pasted into an article about a different event.\n" +
  "- Never place a raw URL in visible prose. Keep source URLs only in structured source fields; refer to a source by its descriptive name in sentences.\n" +
  "- Do not invent quotes, numbers, motives, causal links, or suspiciously exact claims. If a claim is not supported, attribute it, soften it, or remove it.\n";

const SOURCE_BOUND_REPAIR_RULES =
  "SOURCE-BOUND REPAIR RULES:\n" +
  "- When authoritative source material is supplied, every new proper noun, named institution, named document, report, quote, victim name, expert name, publication year, and exact statistic must already appear in the article fields or source material.\n" +
  "- If a weak sentence needs an anchor but the source does not provide one, make the sentence more modest, use an existing date, place, or number, or cut the claim. Never invent a report, institution, expert, victim, study, legal filing, or source.\n" +
  "- Never copy a URL into article prose. URLs belong only in source metadata and rendered descriptive links.\n" +
  "- Never introduce, raise, or change a casualty, death, injury, or fatality count. Keep the article's existing casualty figures exactly as written. A person's age, a year, a street number, a distance, or a count of buildings is never a casualty figure. Do not convert any such number into a death or injury toll.\n";

// Source-grounding context for repair/enrichment prompts. Capped well below the
// full 16k grounding budget so the added material does not push repair requests
// over Groq's per-request size limit (observed 413s on 2026-06-25), which forced
// extra provider fallbacks. ~6000 chars is enough context to keep claims grounded.
function sourceBoundRepairContext(source, maxLength = 6000) {
  const material = sourceMaterialForGrounding(source);
  return material ? material.slice(0, maxLength) : "";
}

/**
 * Scans generated content for banned phrases.
 * Returns a list of violation strings. Empty array = clean.
 */
function scanBannedPhrases(content) {
  const violations = [];
  for (const field of PARA_FIELDS) {
    const paras = content[field];
    if (!Array.isArray(paras)) continue;
    paras.forEach((p, i) => {
      const lower = p.toLowerCase();
      for (const phrase of BANNED_PHRASE_LIST) {
        if (lower.includes(phrase)) {
          violations.push(`${field}[${i}]: "${phrase}"`);
        }
      }
    });
  }
  if (violations.length > 0) {
    console.warn(
      `scanBannedPhrases: ${violations.length} violation(s):\n` +
      violations.map((v) => `  ${v}`).join("\n"),
    );
  } else {
    console.log("scanBannedPhrases: clean");
  }
  return violations;
}

function plainText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(value) {
  const words = plainText(value).match(/\b[\w'’]+\b/g);
  return words ? words.length : 0;
}

const ARTICLE_BODY_FIELDS = [
  "overviewParagraphs",
  "eyewitnessOrChronicle",
  "aftermathParagraphs",
  "conclusionParagraphs",
];

const MIN_REAL_ARTICLE_BODY_WORDS = 850;

// The chunked fallback writes exactly 8 body paragraphs (2 each across the four
// ARTICLE_BODY_FIELDS). This per-paragraph floor must be high enough that a
// fully valid chunked body clears MIN_REAL_ARTICLE_BODY_WORDS: 8 x 110 = 880.
// A lower floor (it was 70 → 560) let the chunked "success" still fail the
// publish gate it exists to satisfy (2026-07-05 incident).
const CHUNKED_BODY_PARAGRAPH_MIN_WORDS = 110;

function articleBodyWordCount(content) {
  return ARTICLE_BODY_FIELDS.reduce((total, field) => {
    const paragraphs = Array.isArray(content?.[field]) ? content[field] : [];
    return total + paragraphs.reduce((sum, paragraph) => sum + wordCount(paragraph), 0);
  }, 0);
}

function hasHardFact(value) {
  const text = plainText(value);
  return (
    /\b\d{3,4}\b/.test(text) ||
    /\b\d{1,3}(?:,\d{3})+\b/.test(text) ||
    /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,}\b/.test(text)
  );
}

function hasSourceAnchor(value) {
  return /\b(letter|diary|memoir|newspaper|trial|testimony|record|report|dispatch|chronicle|historian|archive|decree|proclamation|treaty|census|journal|interview|speech|minutes|source)\b/i.test(
    plainText(value),
  );
}

const EDITORIAL_OVERHEATED_RE =
  /\b(chaotic scenes|harsh realities|fa[cç]ade|illusion|escapism|spectacle|manipulation|fantasy and nostalgia|masterfully crafted|calculated nature of power|polarization of global politics|major world powers|world grapples|enduring impact|lasting legacy|testaments? to|pomp and circumstance)\b/i;

function scanEditorialNoteQuality(content) {
  const issues = [];
  const editorial = plainText(content.editorialNote);
  if (wordCount(editorial) < 70) {
    issues.push("editorialNote is too short.");
  }
  if (!hasHardFact(editorial)) {
    issues.push("editorialNote lacks a concrete article-specific detail.");
  }
  if (EDITORIAL_OVERHEATED_RE.test(editorial)) {
    issues.push("editorialNote uses overheated abstraction or cynical editorial language.");
  }
  if (
    /\b(Ukraine|major world powers|global politics|geopolitical|war|conflict)\b/i.test(editorial) &&
    /\b(wedding|royal|monarchy|ceremony|celebrity|culture|book|music|film|art)\b/i.test(
      `${content.title || ""} ${content.eventTitle || ""} ${content.keywords || ""}`,
    )
  ) {
    issues.push("editorialNote makes a forced current-war or geopolitics comparison for a non-war event.");
  }
  return issues;
}

function buildFallbackEditorialNote(content) {
  const event = content.eventTitle || content.title || "this event";
  const date = content.historicalDate || "its day";
  const location = content.location ? ` at ${content.location}` : "";
  const fact = (content.quickFacts || [])
    .map((item) => item?.value)
    .find((value) => typeof value === "string" && value.trim().length > 20);
  const factSentence = fact
    ? `The detail that stays with us is this: ${fact.replace(/\s+/g, " ").trim()}`
    : `The detail that stays with us is how much public meaning gathered around one recorded event.`;

  return (
    `We keep coming back to one thing: ${event} on ${date}${location} was not just a date on a timeline. ` +
    `${factSentence} ` +
    `That is where the story becomes useful. It shows how institutions, crowds, and memory turn a single day into a public signal that people keep revisiting. ` +
    `The image matters, but the choices behind it matter more.`
  );
}

function enforceEditorialNoteQuality(content) {
  const issues = scanEditorialNoteQuality(content);
  if (issues.length === 0) return content;
  console.warn(
    `enforceEditorialNoteQuality: using fallback note (${issues.join("; ")})`,
  );
  return { ...content, editorialNote: buildFallbackEditorialNote(content) };
}

function scanArticleQuality(content) {
  const issues = [];
  const bodyWords = articleBodyWordCount(content);
  if (bodyWords < MIN_REAL_ARTICLE_BODY_WORDS) {
    issues.push(`article body is too short (${bodyWords} words, needs ${MIN_REAL_ARTICLE_BODY_WORDS}+).`);
  }

  const paraMinimums = {
    overviewParagraphs: 95,
    eyewitnessOrChronicle: 90,
    aftermathParagraphs: 95,
    conclusionParagraphs: 75,
  };

  for (const [field, minWords] of Object.entries(paraMinimums)) {
    const paras = Array.isArray(content[field]) ? content[field] : [];
    paras.forEach((paragraph, index) => {
      const words = wordCount(paragraph);
      if (words < minWords) {
        issues.push(`${field}[${index}] is thin (${words} words, needs ${minWords}+).`);
      }
      if (!hasHardFact(paragraph)) {
        issues.push(`${field}[${index}] lacks a hard fact such as a name, year, number, or place.`);
      }
    });
    if (paras.length > 0 && !paras.some(hasSourceAnchor)) {
      issues.push(`${field} needs at least one source anchor or named record.`);
    }
  }

  const analysisItems = [
    ...(Array.isArray(content.analysisGood) ? content.analysisGood.map((item, i) => ["analysisGood", item, i]) : []),
    ...(Array.isArray(content.analysisBad) ? content.analysisBad.map((item, i) => ["analysisBad", item, i]) : []),
  ];
  for (const [field, item, index] of analysisItems) {
    const detail = item?.detail || "";
    if (wordCount(detail) < 55) {
      issues.push(`${field}[${index}].detail is too short for real analysis.`);
    }
    if (!hasHardFact(detail)) {
      issues.push(`${field}[${index}].detail lacks a concrete name, date, number, or institution.`);
    }
  }

  if (Array.isArray(content.didYouKnowFacts)) {
    content.didYouKnowFacts.forEach((fact, index) => {
      if (wordCount(fact) < 35) {
        issues.push(`didYouKnowFacts[${index}] is too short.`);
      }
      if (!hasHardFact(fact)) {
        issues.push(`didYouKnowFacts[${index}] lacks a concrete detail.`);
      }
    });
  }

  const didYouKnowAudit = auditDidYouKnowFacts(content);
  issues.push(...didYouKnowAudit.reasons);
  issues.push(...scanEditorialNoteQuality(content));
  if (!plainText(content.contentRationale).match(/\bWikipedia\b/i) || wordCount(content.contentRationale) < 35) {
    issues.push("contentRationale must explain the article's specific value beyond Wikipedia.");
  }

  if (issues.length > 0) {
    console.warn(
      `scanArticleQuality: ${issues.length} issue(s):\n` +
        issues.map((issue) => `  - ${issue}`).join("\n"),
    );
  } else {
    console.log("scanArticleQuality: clean");
  }
  return issues;
}

// Detects sentences (>= 45 chars) that appear in 2+ visible-text fields, the source of
// the on-page duplicate-content audit finding. Returns human-readable issue strings that
// improveArticleQuality can act on.
const SEMANTIC_DUPLICATE_STOPWORDS = new Set([
  "about", "above", "after", "again", "against", "along", "also", "although",
  "among", "another", "around", "because", "before", "being", "between",
  "both", "could", "described", "detail", "during", "event", "every", "facts",
  "first", "from", "general", "history", "historical", "into", "itself",
  "later", "main", "major", "more", "most", "much", "name", "named", "only",
  "other", "people", "place", "point", "public", "record", "same", "section",
  "source", "specific", "still", "story", "than", "that", "their", "there",
  "these", "thing", "this", "those", "through", "under", "until", "what",
  "when", "where", "which", "while", "with", "within", "without", "would",
]);

function semanticDuplicateTokens(value, ignoredTokens = new Set()) {
  const text = plainText(value)
    .toLowerCase()
    .replace(/[’']s\b/g, "")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]/g, " ");
  return new Set(
    text
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) =>
        token.length >= 4 &&
        !SEMANTIC_DUPLICATE_STOPWORDS.has(token) &&
        !ignoredTokens.has(token),
      ),
  );
}

function semanticDuplicateScore(tokensA, tokensB) {
  if (!tokensA.size || !tokensB.size) return { shared: 0, ratio: 0 };
  let shared = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) shared += 1;
  }
  return { shared, ratio: shared / Math.min(tokensA.size, tokensB.size) };
}

function scanIntraPageDuplication(content) {
  const entries = [];
  for (const f of ARTICLE_BODY_FIELDS) {
    (Array.isArray(content[f]) ? content[f] : []).forEach((p) => entries.push([f, p]));
  }
  (Array.isArray(content.didYouKnowFacts) ? content.didYouKnowFacts : []).forEach((p) => entries.push(["didYouKnowFacts", p]));
  for (const f of ["analysisGood", "analysisBad"]) {
    (Array.isArray(content[f]) ? content[f] : []).forEach((item) => entries.push([f, item?.detail || ""]));
  }
  const map = new Map();
  for (const [field, text] of entries) {
    for (const sentence of splitSentences(text, 45)) {
      const key = normalizeForCompare(sentence);
      if (!key) continue;
      if (!map.has(key)) map.set(key, { sentence, fields: [] });
      map.get(key).fields.push(field);
    }
  }
  const issues = [];
  for (const { sentence, fields } of map.values()) {
    if (fields.length > 1) {
      const distinct = [...new Set(fields)];
      issues.push(`Duplicate sentence across ${distinct.join(", ")}: "${sentence.slice(0, 80)}".`);
    }
  }

  const ignoredTokens = semanticDuplicateTokens(
    [
      content?.title,
      content?.eventTitle,
      content?.historicalDate,
      content?.location,
      content?.country,
    ].filter(Boolean).join(" "),
  );
  const tokenized = entries
    .map(([field, text], index) => ({
      field,
      text: plainText(text),
      index,
      tokens: semanticDuplicateTokens(text, ignoredTokens),
    }))
    .filter((entry) => entry.text.length >= 90 && entry.tokens.size >= 8);

  for (let i = 0; i < tokenized.length; i += 1) {
    for (let j = i + 1; j < tokenized.length; j += 1) {
      const a = tokenized[i];
      const b = tokenized[j];
      const { shared, ratio } = semanticDuplicateScore(a.tokens, b.tokens);
      if (shared >= 10 && ratio >= 0.62) {
        issues.push(
          `Semantic repetition across ${a.field} and ${b.field}: ${shared} shared detail terms; rewrite one to add new information.`,
        );
      }
    }
  }
  return issues;
}

function extractFirstJsonObject(value) {
  const cleaned = String(value || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  if (start === -1) return "";

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return cleaned.slice(start);
}

/**
 * AI models routinely emit raw newlines, tabs, or other control characters
 * INSIDE JSON string values instead of the escaped \n / \t sequences JSON
 * requires. JSON.parse rejects those with "Bad control character in string
 * literal", which on 2026-07-05 aborted the chunked "facts" sub-call and took
 * down the whole chunked article fallback. This walks the JSON and escapes any
 * unescaped control character (U+0000–U+001F) that appears inside a string
 * literal, leaving structure and already-escaped sequences untouched.
 */
function sanitizeJsonControlChars(json) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    const code = json.charCodeAt(i);
    if (inString && code <= 0x1f) {
      if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (ch === "\b") out += "\\b";
      else if (ch === "\f") out += "\\f";
      else out += "\\u" + code.toString(16).padStart(4, "0");
      continue;
    }
    out += ch;
  }
  return out;
}

function parseJsonObjectFromAI(value, label) {
  const json = extractFirstJsonObject(value);
  if (!json) throw new Error(`${label}: no JSON object returned`);
  try {
    return JSON.parse(json);
  } catch (err) {
    // Retry once after escaping raw control characters inside string literals,
    // the single most common reason a well-formed AI JSON object fails to parse.
    try {
      return JSON.parse(sanitizeJsonControlChars(json));
    } catch {
      throw new Error(`${label}: JSON parse failed (${err.message})`);
    }
  }
}

/**
 * Quality fix pass: rewrites paragraphs that contain banned phrases AND
 * removes cross-section repetition (same facts restated in a later section).
 * Sends all four sections together so the AI can see the full picture.
 * Called once after scanBannedPhrases finds violations.
 * Returns updated content — falls back to original on any error.
 */
async function fixBannedPhrases(env, content, violations, source = null) {
  const sourceMaterial = sourceBoundRepairContext(source);
  const allSections = {
    overviewParagraphs: content.overviewParagraphs || [],
    eyewitnessOrChronicle: content.eyewitnessOrChronicle || [],
    aftermathParagraphs: content.aftermathParagraphs || [],
    conclusionParagraphs: content.conclusionParagraphs || [],
  };

  const foundPhrases = [...new Set(violations.map((v) => {
    const m = v.match(/"([^"]+)"$/);
    return m ? m[1] : null;
  }).filter(Boolean))];

  const systemPrompt =
    "You are a strict copy editor fixing a historical blog article. You have two tasks:\n\n" +
    "TASK 1 — BANNED PHRASES: Remove every banned phrase listed below. " +
    "Replace it with the specific concrete detail it was avoiding. " +
    "Do not use vague substitutes. If the paragraph has nothing concrete to say, cut the vague sentence entirely.\n\n" +
    "TASK 2 — CROSS-SECTION REPETITION: Check whether any paragraph in aftermathParagraphs or conclusionParagraphs " +
    "restates facts already stated in overviewParagraphs or eyewitnessOrChronicle. " +
    "If a later paragraph says the same thing as an earlier one, rewrite it to add new information not yet covered, " +
    "or advance the story to a later point in time. Each section must earn its place with information the reader has not seen yet.\n\n" +
    WRITING_REWRITE_RULES + "\n" +
    SOURCE_BOUND_REPAIR_RULES +
    "Rules: Preserve paragraph count exactly in every array. Never use dashes (-) or em dashes. " +
    "Keep all facts accurate. Return ONLY a JSON object with the arrays that changed. Omit unchanged arrays.";

  const userMessage =
    (sourceMaterial ? `AUTHORITATIVE SOURCE MATERIAL:\n${sourceMaterial}\n\n` : "") +
    `Banned phrases to remove: ${foundPhrases.map((p) => `"${p}"`).join(", ")}\n\n` +
    `Full article sections:\n${JSON.stringify(allSections, null, 2)}\n\n` +
    `Return ONLY JSON: {"overviewParagraphs":[...],"conclusionParagraphs":[...]} — only include arrays that changed.`;

  let raw;
  try {
    raw = await callAI(
      env,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      { maxTokens: 3000, timeoutMs: 40_000 },
    );
  } catch (err) {
    console.warn(`fixBannedPhrases: AI call failed (${err.message}) — keeping original`);
    return content;
  }

  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    console.warn("fixBannedPhrases: no JSON in response — keeping original");
    return content;
  }

  let fixes;
  try {
    fixes = JSON.parse(match[0]);
  } catch {
    console.warn("fixBannedPhrases: JSON parse error — keeping original");
    return content;
  }

  const updated = { ...content };
  for (const field of Object.keys(allSections)) {
    if (!Array.isArray(fixes[field])) continue;
    if (fixes[field].length !== (content[field] || []).length) continue;
    if (!fixes[field].every((p) => typeof p === "string" && p.trim().length > 20)) continue;
    updated[field] = fixes[field];
  }

  const remaining = scanBannedPhrases(updated);
  console.log(`fixBannedPhrases: done — ${remaining.length} phrase(s) still present after fix`);
  return updated;
}

async function improveArticleQuality(env, content, issues, source = null) {
  if (!issues.length) return content;
  const sourceMaterial = sourceBoundRepairContext(source);

  const repairPayload = {
    title: content.title,
    eventTitle: content.eventTitle,
    historicalDate: content.historicalDate,
    location: content.location,
    overviewParagraphs: content.overviewParagraphs || [],
    eyewitnessOrChronicle: content.eyewitnessOrChronicle || [],
    aftermathParagraphs: content.aftermathParagraphs || [],
    conclusionParagraphs: content.conclusionParagraphs || [],
    didYouKnowFacts: content.didYouKnowFacts || [],
    analysisGood: content.analysisGood || [],
    analysisBad: content.analysisBad || [],
    editorialNote: content.editorialNote || "",
    contentRationale: content.contentRationale || "",
  };

  const systemPrompt =
    "You are a senior history editor doing a final quality repair before publication. " +
    "Fix only the fields named by the audit issues. Keep facts accurate and do not invent quotations. " +
    "Strengthen weak writing with concrete names, dates, institutions, source-supported anchors, and consequences. " +
    "Preserve array lengths exactly. Preserve the same JSON shape for analysisGood and analysisBad items. " +
    `The article body can be concise, but overviewParagraphs, eyewitnessOrChronicle, aftermathParagraphs, and conclusionParagraphs must total at least ${MIN_REAL_ARTICLE_BODY_WORDS} words. ` +
    "Do not pad. If the body is too short, add source-supported facts that have not appeared elsewhere. If an issue says semantic repetition, rewrite the repeated field so it contributes a new detail rather than the same fact in different words. " +
    "Never use hyphens or em dashes in article body fields. Avoid generic phrases such as 'changed history', " +
    "'turning point', 'lasting impact', 'important moment', 'remarkable event', and 'still resonates today'. " +
    "For editorialNote, keep the voice measured, specific, and grounded in the article. Do not make forced comparisons " +
    "to Ukraine, war, major world powers, global polarization, or modern crises unless the historical event is directly " +
    "about war or diplomacy. Do not use cynical abstraction such as 'manipulation', 'facade', 'illusion', 'escapism', " +
    "'spectacle', 'fantasy', 'testament to', 'lasting legacy', 'enduring impact', or 'calculated nature of power'. " +
    SOURCE_BOUND_REPAIR_RULES +
    WRITING_REWRITE_RULES +
    "Return ONLY a JSON object containing changed fields.";

  const userMessage =
    (sourceMaterial ? `AUTHORITATIVE SOURCE MATERIAL:\n${sourceMaterial}\n\n` : "") +
    `Audit issues:\n${issues.map((issue) => `- ${issue}`).join("\n")}\n\n` +
    `Article fields to repair:\n${JSON.stringify(repairPayload, null, 2)}\n\n` +
    "Return only changed fields. If repairing analysisGood or analysisBad, return the full corrected array for that field.";

  let raw;
  try {
    raw = await callAI(
      env,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      { maxTokens: 4000, timeoutMs: 50_000 },
    );
  } catch (err) {
    console.warn(`improveArticleQuality: AI call failed (${err.message}) — keeping original`);
    return content;
  }

  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    console.warn("improveArticleQuality: no JSON in response — keeping original");
    return content;
  }

  let fixes;
  try {
    fixes = JSON.parse(match[0]);
  } catch {
    console.warn("improveArticleQuality: JSON parse error — keeping original");
    return content;
  }

  const updated = { ...content };
  const paragraphFields = [
    "overviewParagraphs",
    "eyewitnessOrChronicle",
    "aftermathParagraphs",
    "conclusionParagraphs",
    "didYouKnowFacts",
  ];
  for (const field of paragraphFields) {
    if (!Array.isArray(fixes[field])) continue;
    if (fixes[field].length !== (content[field] || []).length) continue;
    if (!fixes[field].every((item) => typeof item === "string" && item.trim().length > 20)) continue;
    updated[field] = fixes[field];
  }

  for (const field of ["analysisGood", "analysisBad"]) {
    if (!Array.isArray(fixes[field])) continue;
    if (fixes[field].length !== (content[field] || []).length) continue;
    if (
      !fixes[field].every(
        (item) =>
          item &&
          typeof item.title === "string" &&
          typeof item.detail === "string" &&
          item.detail.trim().length > 80,
      )
    ) {
      continue;
    }
    updated[field] = fixes[field];
  }

  for (const field of ["editorialNote", "contentRationale"]) {
    if (typeof fixes[field] === "string" && fixes[field].trim().length > 80) {
      updated[field] = fixes[field].trim();
    }
  }

  const remaining = scanArticleQuality(updated);
  console.log(`improveArticleQuality: done — ${remaining.length} issue(s) still present after repair`);
  return updated;
}

async function generateLearningBlocks(env, content) {
  const body = [
    ...(content.overviewParagraphs || []),
    ...(content.eyewitnessOrChronicle || []),
    ...(content.aftermathParagraphs || []),
    ...(content.conclusionParagraphs || []),
  ].join("\n\n").replace(/<[^>]+>/g, " ").slice(0, 6000);
  const extract = String(content.wikiExtract || content.sourceExtract || "").slice(0, 2000);
  const sourceMaterial = sourceBoundRepairContext(groundingSourceFromContent(content), 4000);
  if (!body.trim()) return;

  const systemPrompt =
    "You add a factual timeline to a finished history article. Output STRICT JSON only.\n" +
    "timeline: 4-7 dated entries showing lead-up, the event, and aftermath. " +
    "Use ONLY dates that appear in the supplied article body or source material; never invent a date. " +
    "Each label must describe only people, places, institutions, and events named in the article body or source material; never invent a name, institution, report, study, victim, or source. " +
    "Each entry: {\"year\":\"1215\",\"date\":\"June 15, 1215\",\"label\":\"...\",\"kind\":\"leadup|event|aftermath\"}. " +
    "Exactly one entry has kind \"event\" and matches the event date. No dashes or em-dashes in any text.";
  const userMessage =
    `Event: ${content.eventTitle}\nEvent date: ${content.historicalDate}\n\n` +
    `ARTICLE BODY:\n${body}\n\n` +
    `${sourceMaterial ? `AUTHORITATIVE SOURCE MATERIAL:\n${sourceMaterial}\n\n` : (extract ? `SOURCE EXTRACT:\n${extract}\n\n` : "")}` +
    `Return ONLY JSON: {"timeline":[]}`;

  let raw;
  try {
    raw = await callAI(env, [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ], { maxTokens: 1500, timeoutMs: 40_000 });
  } catch (err) {
    console.warn(`generateLearningBlocks: AI call failed (${err.message}) — skipping`);
    return;
  }
  const cleaned = String(raw || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) { console.warn("generateLearningBlocks: no JSON — skipping"); return; }
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { console.warn("generateLearningBlocks: parse error — skipping"); return; }

  if (Array.isArray(parsed.timeline)) {
    content.timeline = parsed.timeline
      .filter((e) => e && typeof e === "object")
      .map((e) => ({
        year: String(e.year || "").trim(),
        date: String(e.date || e.year || "").trim(),
        label: String(e.label || "").trim(),
        kind: ["leadup", "event", "aftermath"].includes(e.kind) ? e.kind : "leadup",
      }))
      .filter((e) => e.label && (e.year || e.date));
  }
}

function groundLearningBlocks(content) {
  const corpus = normalizeForCompare([
    ...(content.overviewParagraphs || []),
    ...(content.eyewitnessOrChronicle || []),
    ...(content.aftermathParagraphs || []),
    ...(content.conclusionParagraphs || []),
    String(content.wikiExtract || content.sourceExtract || ""),
  ].join(" "));
  // Year = the LAST 1-4 digit run, so "June 15, 1215" yields 1215 (not the day "15").
  const yearOf = (e) => {
    const m = String(e.year || e.date || "").match(/(\d{1,4})\D*$/);
    return m ? m[1] : "";
  };
  const yearNum = (e) => {
    const y = yearOf(e);
    if (!y) return 0;
    return /\bbce?\b/i.test(`${e.year} ${e.date}`) ? -parseInt(y, 10) : parseInt(y, 10);
  };

  if (Array.isArray(content.timeline)) {
    const em = String(content.historicalDate || "").match(/(\d{1,4})\D*$/);
    const eventYear = em ? em[1] : "";
    let kept = content.timeline.filter((e) => {
      const y = yearOf(e);
      return y && corpus.includes(y);
    });
    if (!kept.some((e) => e.kind === "event") && eventYear) {
      kept.push({ year: eventYear, date: content.historicalDate, label: content.eventTitle, kind: "event" });
    }
    const seen = new Set();
    kept = kept
      .filter((e) => {
        const k = `${yearOf(e)}|${normalizeForCompare(e.label)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => yearNum(a) - yearNum(b));
    if (kept.length >= 3) content.timeline = kept;
    else delete content.timeline;
  }
}

// Person life-and-career timeline for /people/{slug}/ pages. Same
// generate-then-ground mechanism as the article learning-blocks timeline
// (generateLearningBlocks + groundLearningBlocks) but sourced from the person's
// own biography and grounded against it. Returns [] on any failure or when fewer
// than three entries survive grounding; the seo-worker renders entity.timeline
// deterministically (buildEntityTimelineBlock).
async function generateEntityTimeline(env, entity) {
  if (entity?.type !== "person") return [];
  const bodyText = [
    entity.intro || "",
    entity.summary || "",
    ...(Array.isArray(entity.bodySections)
      ? entity.bodySections.flatMap((s) => (Array.isArray(s.paragraphs) ? s.paragraphs : []))
      : []),
  ]
    .join("\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 6000);
  if (bodyText.length < 120) return [];

  const name = entity.name || "this person";
  const lifeLine = [
    entity.birthDate ? `Born: ${entity.birthDate}` : "",
    entity.deathDate ? `Died: ${entity.deathDate}` : "",
  ]
    .filter(Boolean)
    .join("  ");

  const systemPrompt =
    "You add a factual life-and-career timeline to a biography. Output STRICT JSON only.\n" +
    "timeline: 4-7 dated milestones in the person's life and career, in chronological order. " +
    "Use ONLY years that appear in the supplied biography text or life dates; never invent a date. " +
    "Each label describes only real events, works, roles, awards, places, and institutions named in the biography; never invent anything. " +
    'Each entry: {"year":"1971","date":"1971","label":"...","kind":"birth|milestone|death"}. ' +
    'Use kind "birth" for the birth year, "death" for the death year when present, otherwise "milestone". ' +
    "No dashes, em-dashes, semicolons, or colons in any label.";
  const userMessage =
    `Person: ${name}\n${lifeLine ? `${lifeLine}\n` : ""}\nBIOGRAPHY:\n${bodyText}\n\nReturn ONLY JSON: {"timeline":[]}`;

  let raw;
  try {
    raw = await callAI(
      env,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      { maxTokens: 1200, timeoutMs: 40_000 },
    );
  } catch (err) {
    console.warn(`generateEntityTimeline: AI call failed (${err.message}) — skipping`);
    return [];
  }
  const cleaned = String(raw || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  const rawTimeline = Array.isArray(parsed.timeline) ? parsed.timeline : [];

  // Ground: keep only entries whose year appears in the biography corpus (or the
  // known life dates), dedupe by year+label, sort chronologically.
  const corpus = normalizeForCompare(`${bodyText} ${entity.birthDate || ""} ${entity.deathDate || ""}`);
  const yearOf = (e) => {
    // Require a real 3-4 digit year (the last one in the string). Rejects
    // century references like "16th century" that would otherwise yield "16".
    const matches = String(e.year || e.date || "").match(/\b\d{3,4}\b/g);
    return matches ? matches[matches.length - 1] : "";
  };
  const yearNum = (e) => {
    const y = yearOf(e);
    if (!y) return 0;
    return /\bbce?\b/i.test(`${e.year} ${e.date}`) ? -parseInt(y, 10) : parseInt(y, 10);
  };
  const seen = new Set();
  const grounded = rawTimeline
    .map((e) => ({
      year: String(e.year || "").trim(),
      date: String(e.date || e.year || "").trim(),
      label: String(e.label || "").trim(),
      kind: ["birth", "milestone", "death"].includes(e.kind) ? e.kind : "milestone",
    }))
    .filter((e) => e.label && (e.year || e.date))
    .filter((e) => {
      const y = yearOf(e);
      return y && corpus.includes(y);
    })
    .filter((e) => {
      const k = `${yearOf(e)}|${normalizeForCompare(e.label)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => yearNum(a) - yearNum(b));

  return grounded.length >= 3 ? grounded : [];
}

/**
 * Calls the Claude API, builds the HTML page, and persists everything to KV.
 */
async function generateAndStore(
  env,
  ctx,
  forcedEvent = null,
  forceDate = null,
  forceImage = null,
  {
    lightweightPublish = false,
    enrichDraft = true,
    prepareOnly = false,
    preferWorkersAIForArticle = false,
  } = {},
) {
  // Accept both ISO format ("2026-05-25") and slug format ("25-may-2026").
  // The slug format is what buildSlug() produces, but "new Date('25-may-2026T12:00:00Z')"
  // is invalid JS — normalise it to ISO before parsing.
  const normaliseForceDate = (s) => {
    if (!s) return null;
    // Already ISO: "2026-05-25"
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // Slug form: "25-may-2026"
    const m = s.match(/^(\d{1,2})-([a-z]+)-(\d{4})$/i);
    if (m) {
      const monthIdx = MONTH_NAMES.findIndex(
        (name) => name.toLowerCase() === m[2].toLowerCase(),
      );
      if (monthIdx >= 0) {
        return `${m[3]}-${String(monthIdx + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
      }
    }
    return s; // pass through, let Date() deal with it
  };
  const parsedForceDate = forceDate ? new Date(normaliseForceDate(forceDate) + "T12:00:00Z") : null;
  const now = parsedForceDate && !isNaN(parsedForceDate) ? parsedForceDate : new Date();
  const activeModel = await resolveAiModel(env.BLOG_AI_KV);

  // Collect titles already published (all-time, capped at 50) so the AI avoids duplicates
  const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
  const existingIndex = indexRaw ? JSON.parse(indexRaw) : [];
  // Full dedup list: most recent 50 posts across all time
  // When a forced event is provided, exclude it from the avoid list so the AI can write about it
  const takenAllTime = existingIndex
    .slice()
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, 50)
    .flatMap((entry) => [
      entry.eventTitle,
      entry.factualTitle,
      entry.title,
    ])
    .filter(Boolean)
    .filter((title, index, list) => list.indexOf(title) === index)
    .slice(0, 50)
    .filter(
      (t) =>
        !forcedEvent ||
        !t
          .toLowerCase()
          .startsWith(
            forcedEvent.toLowerCase().split(" — ")[0].trim().toLowerCase(),
          ),
    );

  // A previous enrichment for this date refused its event on a source-grounding
  // contradiction and deleted the draft (see markGroundingBlockedEvent). Exclude
  // that event so regeneration picks a different topic instead of failing the
  // same deterministic way for the rest of the day.
  if (!forcedEvent) {
    try {
      const blocked = await env.BLOG_AI_KV.get(
        `${KV_BLOCKED_EVENT_PREFIX}${buildSlug(now)}`,
        { type: "json" },
      );
      if (blocked) {
        for (const title of [blocked.pageTitle, blocked.eventTitle]) {
          if (title) takenAllTime.push(title);
        }
        console.warn(
          `Blog AI: excluding grounding-blocked event "${blocked.pageTitle || blocked.eventTitle}" for ${buildSlug(now)}.`,
        );
      }
    } catch (err) {
      console.warn(`Blog AI: blocked-event lookup failed: ${err.message}`);
    }
  }

  // Rotation signals: topic-family repeats are enforced before candidate
  // ranking; pillar preferences remain editorial guidance.
  // - recentPillars: primary pillars of the last 7 published posts (explicit avoid list)
  // - preferredPillars: least-covered pillars from last 30 posts (positive signal)
  let preferredPillars = [];
  let recentPillars = [];
  let recentEventFamilies = [];
  if (!forcedEvent) {
    const sorted = existingIndex
      .slice()
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    recentEventFamilies = collectRecentEventFamilies(existingIndex, now);

    // Last 7 posts → pillars to avoid repeating this week
    recentPillars = [
      ...new Set(
        sorted
          .slice(0, 7)
          .filter((e) => Array.isArray(e.pillars) && e.pillars.length > 0)
          .map((e) => e.pillars[0]),
      ),
    ]; // primary pillar only
    const recentPillarSet = new Set(recentPillars);

    const recentClassified = sorted
      .slice(0, 30)
      .filter((e) => Array.isArray(e.pillars) && e.pillars.length > 0);

    if (recentClassified.length >= 5) {
      const counts = {};
      for (const pillar of BLOG_PILLARS) counts[pillar] = 0;
      for (const e of recentClassified) {
        for (const p of e.pillars) {
          if (counts[p] !== undefined) counts[p]++;
        }
      }
      // Prefer the 3 least-covered pillars (excluding Born/Died which are niche)
      preferredPillars = Object.entries(counts)
        .filter(
          ([p]) =>
            p !== "Born on This Day" &&
            p !== "Died on This Day" &&
            !recentPillarSet.has(p),
        )
        .sort((a, b) => a[1] - b[1])
        .slice(0, 3)
        .map(([p]) => p);
      console.log(
        `Blog AI: depth rotation — preferred pillars: [${preferredPillars.join(", ")}], avoid: [${recentPillars.join(", ")}]`,
      );
    }
    if (recentEventFamilies.length > 0) {
      console.log(
        `Blog AI: seven-day event-family cooldown — suppressing repeats of [${recentEventFamilies.join(", ")}] when alternatives exist.`,
      );
    }
  }

  let selectedForcedEvent = forcedEvent;
  let selectedEvent = null;
  if (!selectedForcedEvent) {
    selectedEvent = await loadPreparedDraftSource(env, now);
    if (selectedEvent) {
      selectedForcedEvent = selectedEvent.eventTitle;
      console.log(
        `Blog AI: reusing prepared source package for "${selectedForcedEvent}" (${buildSlug(now)}).`,
      );
    } else {
      selectedEvent = await chooseEventForDate(
        env,
        now,
        takenAllTime,
        preferredPillars,
        recentPillars,
        recentEventFamilies,
      );
      selectedForcedEvent = selectedEvent.eventTitle;
      console.log(
        `Blog AI: selected event "${selectedForcedEvent}" for ${selectedEvent.historicalDate || now.toISOString().slice(0, 10)}`,
      );
      selectedEvent = await expandSelectedEventSourcePages(selectedEvent);
      await storePreparedDraftSource(env, now, selectedEvent);
      console.log(
        `Blog AI: cached vetted source package at ${draftSourceKey(now)}.`,
      );
    }
  }

  if (prepareOnly) {
    if (!selectedEvent) {
      throw new Error("Draft source preparation requires a vetted selected event");
    }
    return {
      status: "prepared",
      slug: buildSlug(now),
      eventTitle: selectedEvent.eventTitle,
    };
  }

  // P4a — "why now" context hook: one short AI call that grounds the article
  // in the publish date's current world. The hook is injected into the main
  // generation prompt so at least one sentence exists that could not have been
  // written six months ago. Non-blocking — falls back to null on any error.
  const contextHook = lightweightPublish
    ? null
    : await fetchContextHook(env, now, selectedForcedEvent);

  // Authoritative source for grounded generation + the credibility gate
  // (2026-06-20). Only available when an event was selected from the vetted
  // Wikipedia candidate list; a manually forced event has no source → the gate
  // no-ops and generation falls back to the prior from-knowledge behavior.
  const groundingSource = selectedEvent
    ? {
        pageTitle: selectedEvent.sourcePageTitle || "",
        text: selectedEvent.sourceText || "",
        sourceExtract: selectedEvent.sourceExtract || "",
        sourcePages: selectedEvent.sourcePages || [],
      }
    : null;
  const sourceMaterial = sourceMaterialForGrounding(groundingSource) || null;
  const articleGenerationEnv = preferWorkersAIForArticle
    ? { ...env, ARTICLE_GENERATION_PREFER_WORKERS_AI: "1" }
    : env;

  let content = null;
  let pillars = [];
  let personImages = [];
  let eventImages = [];
  const MAX_CONTENT_ATTEMPTS = 3;
  const MAX_MALFORMED_RESPONSE_ATTEMPTS = 2;
  const generateArticleContent = async (
    avoidTitles,
    stricterGrounding = false,
    groundingFeedback = [],
  ) => {
    let lastError;
    for (let responseAttempt = 1; responseAttempt <= MAX_MALFORMED_RESPONSE_ATTEMPTS; responseAttempt++) {
      try {
        return await callWorkersAI(
          articleGenerationEnv,
          now,
          avoidTitles,
          activeModel,
          selectedForcedEvent,
          preferredPillars,
          contextHook,
          recentPillars,
          sourceMaterial,
          stricterGrounding,
          groundingFeedback,
        );
      } catch (err) {
        lastError = err;
        const retryableOutputFailure =
          /JSON parse failed|No JSON found|response too short|returned empty/i.test(err?.message || "");
        const chunkableFailure = shouldTryChunkedArticleFallback(err);
        if (retryableOutputFailure && responseAttempt < MAX_MALFORMED_RESPONSE_ATTEMPTS) {
          console.warn(
            `Blog AI: malformed article response — ${err.message}. Retrying generation response (${responseAttempt + 1}/${MAX_MALFORMED_RESPONSE_ATTEMPTS}).`,
          );
          continue;
        }
        if (chunkableFailure && chunkedArticleFallbackEnabled(env)) {
          try {
            return await generateArticleContentChunkedFallback(
              articleGenerationEnv,
              now,
              avoidTitles,
              activeModel,
              selectedForcedEvent,
              preferredPillars,
              contextHook,
              recentPillars,
              sourceMaterial,
              stricterGrounding,
              groundingFeedback,
            );
          } catch (fallbackErr) {
            console.warn(
              `Blog AI: chunked article fallback failed after one-shot error "${err.message}" — ${fallbackErr.message}`,
            );
            throw new Error(`${err.message}; chunked article fallback failed: ${fallbackErr.message}`);
          }
        }
        throw err;
      }
    }
    throw lastError;
  };
  // Per-attempt failure trail. recordPipelineFailure only keeps the single last
  // message, so terminal throws carry the whole sequence — the 2026-07-05 post
  // mortem could not tell which gate failed on each attempt without wrangler tail.
  const attemptFailures = [];
  let currentGroundingFeedback = [];
  let generationGroundingRepairUsed = false;
  for (let attempt = 1; attempt <= MAX_CONTENT_ATTEMPTS; attempt++) {
    content =
      attempt === 1
        ? await generateArticleContent(takenAllTime)
        : content;

    if (selectedEvent) {
      attachSelectedEventSourcePages(content, selectedEvent);
      enforceSelectedEventDate(content, selectedEvent);
    }

    const dateValidation = validateContentDateForPublish(content, now);
    if (!dateValidation.ok) {
      attemptFailures.push(`attempt ${attempt} date: ${dateValidation.reason}`);
      if (attempt < MAX_CONTENT_ATTEMPTS) {
        const avoid = [...takenAllTime, content?.title].filter(Boolean);
        console.warn(
          `Blog AI: date validation failed for "${content?.title || "untitled"}" — ${dateValidation.reason}. Regenerating content (${attempt + 1}/${MAX_CONTENT_ATTEMPTS}).`,
        );
        content = await generateArticleContent(
          avoid,
          currentGroundingFeedback.length > 0,
          currentGroundingFeedback,
        );
        continue;
      }

      throw new Error(`${dateValidation.reason} [attempts: ${attemptFailures.join(" | ")}]`);
    }

    const semanticValidation = validateContentSemanticsForPublish(content);
    if (!semanticValidation.ok) {
      const reason = semanticValidation.reasons.join("; ");
      attemptFailures.push(`attempt ${attempt} semantics: ${reason}`);
      if (attempt < MAX_CONTENT_ATTEMPTS) {
        const avoid = [...takenAllTime, content?.title].filter(Boolean);
        console.warn(
          `Blog AI: semantic publication contract failed for "${content?.title || "untitled"}" — ${reason}. Regenerating content (${attempt + 1}/${MAX_CONTENT_ATTEMPTS}).`,
        );
        content = await generateArticleContent(avoid, true, currentGroundingFeedback);
        continue;
      }
      throw new Error(
        `Article failed semantic publication contract: ${reason} [attempts: ${attemptFailures.join(" | ")}]`,
      );
    }

    const citationValidation = validateDirectCitationsForPublish(content);
    if (!citationValidation.ok) {
      const reason = citationValidation.reasons.join("; ");
      attemptFailures.push(`attempt ${attempt} citations: ${reason}`);
      if (attempt < MAX_CONTENT_ATTEMPTS) {
        const avoid = [...takenAllTime, content?.title].filter(Boolean);
        console.warn(
          `Blog AI: direct-citation contract failed for "${content?.title || "untitled"}" — ${reason}. Regenerating content (${attempt + 1}/${MAX_CONTENT_ATTEMPTS}).`,
        );
        content = await generateArticleContent(avoid, true, currentGroundingFeedback);
        continue;
      }
      throw new Error(
        `Article failed direct-citation contract: ${reason} [attempts: ${attemptFailures.join(" | ")}]`,
      );
    }

    let curiosityTitleValidation = validateCuriosityTitleForPublish(content);
    if (!curiosityTitleValidation.ok) {
      const repairedCuriosityTitle = repairCuriosityTitleFromSource(content);
      if (repairedCuriosityTitle) {
        curiosityTitleValidation = validateCuriosityTitleForPublish(content);
        console.warn(
          `Blog AI: replaced an invalid public question title with source-page chronology: "${repairedCuriosityTitle}".`,
        );
      }
    }
    if (!curiosityTitleValidation.ok) {
      const reason = curiosityTitleValidation.reasons.join("; ");
      attemptFailures.push(`attempt ${attempt} public title: ${reason}`);
      if (attempt < MAX_CONTENT_ATTEMPTS) {
        const avoid = [...takenAllTime, content?.title].filter(Boolean);
        console.warn(
          `Blog AI: public question-title contract failed for "${content?.title || "untitled"}" — ${reason}. Regenerating content (${attempt + 1}/${MAX_CONTENT_ATTEMPTS}).`,
        );
        content = await generateArticleContent(avoid, true, currentGroundingFeedback);
        continue;
      }
      throw new Error(
        `Article failed public question-title contract: ${reason} [attempts: ${attemptFailures.join(" | ")}]`,
      );
    }

    const evidenceMapValidation = validateEvidenceMapForPublish(content);
    if (!evidenceMapValidation.ok) {
      const reason = evidenceMapValidation.reasons.join("; ");
      attemptFailures.push(`attempt ${attempt} evidence map: ${reason}`);
      if (attempt < MAX_CONTENT_ATTEMPTS) {
        const avoid = [...takenAllTime, content?.title].filter(Boolean);
        console.warn(
          `Blog AI: evidence-map contract failed for "${content?.title || "untitled"}" — ${reason}. Regenerating content (${attempt + 1}/${MAX_CONTENT_ATTEMPTS}).`,
        );
        content = await generateArticleContent(avoid, true, currentGroundingFeedback);
        continue;
      }
      throw new Error(
        `Article failed evidence-map contract: ${reason} [attempts: ${attemptFailures.join(" | ")}]`,
      );
    }

    try {
      assertRequiredContentBlocks(content);
    } catch (err) {
      attemptFailures.push(`attempt ${attempt} blocks: ${err.message}`);
      const avoid = [...takenAllTime, content?.title].filter(Boolean);

      // Short body → chunked fallback. The chunked path writes body paragraphs in
      // dedicated calls with a firm per-paragraph floor, so it reliably clears the
      // 850-word gate the one-shot chronically undershoots. This runs on EVERY
      // attempt, including the last: on 2026-07-05 the fallback was gated behind
      // `attempt < MAX_CONTENT_ATTEMPTS`, so the final attempt had no escape hatch
      // and the post failed to publish.
      if (isShortArticleBodyFailure(err) && chunkedArticleFallbackEnabled(env)) {
        console.warn(
          `Blog AI: one-shot article body too short for "${content?.title || "untitled"}" — ${err.message}. Trying chunked article fallback (attempt ${attempt}/${MAX_CONTENT_ATTEMPTS}).`,
        );
        try {
          const chunked = await generateArticleContentChunkedFallback(
            articleGenerationEnv,
            now,
            avoid,
            activeModel,
            selectedForcedEvent,
            preferredPillars,
            contextHook,
            recentPillars,
            sourceMaterial,
            Boolean(sourceMaterial) || currentGroundingFeedback.length > 0,
            currentGroundingFeedback,
          );
          // Re-run the same per-iteration gates on the chunked result so a
          // recovered body is still date-validated and structurally complete
          // before it falls through to the grounding gate below.
          if (selectedEvent) {
            attachSelectedEventSourcePages(chunked, selectedEvent);
            enforceSelectedEventDate(chunked, selectedEvent);
          }
          const chunkedDate = validateContentDateForPublish(chunked, now);
          if (!chunkedDate.ok) throw new Error(chunkedDate.reason);
          const chunkedSemantics = validateContentSemanticsForPublish(chunked);
          if (!chunkedSemantics.ok) {
            throw new Error(
              `semantic publication contract failed: ${chunkedSemantics.reasons.join("; ")}`,
            );
          }
          const chunkedCitations = validateDirectCitationsForPublish(chunked);
          if (!chunkedCitations.ok) {
            throw new Error(
              `direct-citation contract failed: ${chunkedCitations.reasons.join("; ")}`,
            );
          }
          const chunkedCuriosityTitle = validateCuriosityTitleForPublish(chunked);
          if (!chunkedCuriosityTitle.ok) {
            throw new Error(
              `public question-title contract failed: ${chunkedCuriosityTitle.reasons.join("; ")}`,
            );
          }
          const chunkedEvidenceMap = validateEvidenceMapForPublish(chunked);
          if (!chunkedEvidenceMap.ok) {
            throw new Error(
              `evidence-map contract failed: ${chunkedEvidenceMap.reasons.join("; ")}`,
            );
          }
          assertRequiredContentBlocks(chunked);
          content = chunked;
          // Recovered — annotate the 'blocks' entry pushed above so a later
          // terminal failure's trail does not read as an unrescued block failure.
          attemptFailures[attemptFailures.length - 1] += " (recovered via chunked fallback)";
          // Do not continue/throw; fall through to the grounding gate.
        } catch (fallbackErr) {
          attemptFailures.push(`attempt ${attempt} chunked: ${fallbackErr.message}`);
          console.warn(
            `Blog AI: chunked article fallback failed — ${fallbackErr.message}.`,
          );
          if (attempt < MAX_CONTENT_ATTEMPTS) {
            content = await generateArticleContent(
              avoid,
              currentGroundingFeedback.length > 0,
              currentGroundingFeedback,
            );
            continue;
          }
          throw new Error(`${err.message} [attempts: ${attemptFailures.join(" | ")}]`);
        }
      } else if (attempt < MAX_CONTENT_ATTEMPTS) {
        console.warn(
          `Blog AI: incomplete generated content for "${content?.title || "untitled"}" - ${err.message}. Regenerating content (${attempt + 1}/${MAX_CONTENT_ATTEMPTS}).`,
        );
        content = await generateArticleContent(
          avoid,
          currentGroundingFeedback.length > 0,
          currentGroundingFeedback,
        );
        continue;
      } else {
        throw new Error(`${err.message} [attempts: ${attemptFailures.join(" | ")}]`);
      }
    }

    // Credibility gate (2026-06-20): the article must be grounded in the selected
    // event's authoritative Wikipedia source — no fabricated event, no casualty
    // numbers that contradict the source. Runs before the expensive humanize/SEO
    // passes so a fabricated draft fails fast. On failure: regenerate with
    // stricter grounding; if the final attempt still fails, throw so the
    // fabricated article is NEVER published (cron/failsafe logs the failure).
    if (groundingSource) {
      let grounding = verifyArticleGrounding(content, groundingSource);
      if (!grounding.ok && !generationGroundingRepairUsed) {
        generationGroundingRepairUsed = true;
        try {
          const repaired = await repairGroundingContradictions(
            env,
            content,
            grounding.reasons,
            groundingSource,
          );
          if (repaired && repaired !== content) {
            if (selectedEvent) {
              attachSelectedEventSourcePages(repaired, selectedEvent);
              enforceSelectedEventDate(repaired, selectedEvent);
            }
            const repairedSemantics = validateContentSemanticsForPublish(repaired);
            const repairedCitations = validateDirectCitationsForPublish(repaired);
            const repairedCuriosityTitle = validateCuriosityTitleForPublish(repaired);
            const repairedEvidenceMap = validateEvidenceMapForPublish(repaired);
            assertRequiredContentBlocks(repaired);
            const repairedGrounding = verifyArticleGrounding(repaired, groundingSource);
            if (
              repairedSemantics.ok &&
              repairedCitations.ok &&
              repairedCuriosityTitle.ok &&
              repairedEvidenceMap.ok &&
              repairedGrounding.ok
            ) {
              content = repaired;
              grounding = repairedGrounding;
              console.log(
                `Blog AI: source-bound generation repair passed for "${content?.title || "untitled"}".`,
              );
            } else {
              const repairReasons = [
                ...(!repairedSemantics.ok ? repairedSemantics.reasons : []),
                ...(!repairedCitations.ok ? repairedCitations.reasons : []),
                ...(!repairedCuriosityTitle.ok ? repairedCuriosityTitle.reasons : []),
                ...(!repairedEvidenceMap.ok ? repairedEvidenceMap.reasons : []),
                ...(!repairedGrounding.ok ? repairedGrounding.reasons : []),
              ];
              console.warn(
                `Blog AI: source-bound generation repair did not pass revalidation — ${repairReasons.join("; ").slice(0, 500)}`,
              );
              grounding = repairedGrounding.ok ? grounding : repairedGrounding;
            }
          }
        } catch (err) {
          console.warn(
            `Blog AI: source-bound generation repair failed — ${err.message}`,
          );
        }
      }
      if (!grounding.ok) {
        attemptFailures.push(`attempt ${attempt} grounding: ${grounding.reasons.join("; ")}`);
        if (attempt < MAX_CONTENT_ATTEMPTS) {
          const avoid = [...takenAllTime, content?.title].filter(Boolean);
          currentGroundingFeedback = grounding.reasons;
          console.warn(
            `Blog AI: grounding gate failed for "${content?.title || "untitled"}" — ${grounding.reasons.join("; ")}. Regenerating with stricter grounding (${attempt + 1}/${MAX_CONTENT_ATTEMPTS}).`,
          );
          content = await generateArticleContent(avoid, true, currentGroundingFeedback);
          continue;
        }
        throw new Error(
          `Article failed source-grounding credibility check: ${grounding.reasons.join("; ")} [attempts: ${attemptFailures.join(" | ")}]`,
        );
      }
    }

    // Post-generation banned phrase scan + targeted fix pass.
    // If violations are found, one focused AI call patches only the offending paragraphs.
    // Falls back to original paragraphs if the fix call fails or produces worse output.
    if (!lightweightPublish) {
      const violations = scanBannedPhrases(content);
      if (violations.length > 0) {
        content = await fixBannedPhrases(env, content, violations, groundingSource);
      }
      const qualityIssues = scanArticleQuality(content);
      if (qualityIssues.length > 0) {
        content = await improveArticleQuality(env, content, qualityIssues, groundingSource);
      }

      content = await reviewContentWithSEOExpert(content, env, groundingSource);
      if (selectedEvent) enforceSelectedEventDate(content, selectedEvent);
      const postReviewViolations = scanBannedPhrases(content);
      if (postReviewViolations.length > 0) {
        content = await fixBannedPhrases(env, content, postReviewViolations, groundingSource);
      }
      const postReviewQualityIssues = scanArticleQuality(content);
      if (postReviewQualityIssues.length > 0) {
        content = await improveArticleQuality(env, content, postReviewQualityIssues, groundingSource);
      }

      await factCheckContent(env, content, groundingSource);
      if (selectedEvent) enforceSelectedEventDate(content, selectedEvent);
      await validateEyewitnessQuote(env, content);
      pillars = await classifyPillars(env, content);

      const workingImage = forceImage || await resolveWorkingImageForContent(content);
      if (!workingImage) {
        if (attempt < MAX_CONTENT_ATTEMPTS) {
          const avoid = [...takenAllTime, content.title].filter(Boolean);
          console.warn(
            `Blog AI: no valid image for "${content.title}". Regenerating content (${attempt + 1}/${MAX_CONTENT_ATTEMPTS}).`,
          );
          content = await generateArticleContent(
            avoid,
            currentGroundingFeedback.length > 0,
            currentGroundingFeedback,
          );
          continue;
        }

        throw new Error(
          `No working image for "${content.title}" after ${MAX_CONTENT_ATTEMPTS} attempts.`,
        );
      }
      content.imageUrl = workingImage;

      [personImages, eventImages] = await Promise.all([
        fetchKeyPersonImages(env, content.keyTerms).catch(() => []),
        content.wikiUrl
          ? fetchEventImages(content.wikiUrl, content.imageUrl, 3, content.eventTitle).catch(() => [])
          : Promise.resolve([]),
      ]);
      const wikiImageTotal = personImages.length + eventImages.length;
      if (wikiImageTotal < 3) {
        if (attempt < MAX_CONTENT_ATTEMPTS) {
          const avoid = [...takenAllTime, content.title].filter(Boolean);
          console.warn(
            `Blog AI: wiki image precheck failed for "${content.title}" (${wikiImageTotal}/3). Regenerating content (${attempt + 1}/${MAX_CONTENT_ATTEMPTS}).`,
          );
          content = await generateArticleContent(
            avoid,
            currentGroundingFeedback.length > 0,
            currentGroundingFeedback,
          );
          continue;
        }

        throw new Error(
          `IMAGE_UNAVAILABLE: wiki-only topic gate requires 3 usable Wikipedia images, got ${wikiImageTotal} for "${content.title}"`,
        );
      }

      await generateEditorialNote(env, content, now);
      const editorialQualityIssues = scanArticleQuality(content);
      if (editorialQualityIssues.length > 0) {
        content = await improveArticleQuality(env, content, editorialQualityIssues, groundingSource);
      }
      content = enforceEditorialNoteQuality(content);
    }
    if (selectedEvent) {
      enforceSelectedEventDate(content, selectedEvent);
    }
    break;
  }

  if (selectedEvent) {
    enforceSelectedEventDate(content, selectedEvent);
  }

  const finalDateValidation = validateContentDateForPublish(content, now);
  if (!finalDateValidation.ok) {
    throw new Error(finalDateValidation.reason);
  }

  // Persist canonical date fields in lightweight drafts even when the AI
  // supplied the date only in its title; later SEO edits may rewrite titles.
  // Pass the publication date as canonical month/day so dual-calendar events
  // (e.g. Julian May 29 = Gregorian June 11) are always pinned to the feed date.
  alignContentDateFields(content, { historicalDateISO: now.toISOString().slice(0, 10) });
  normalizeContentMetadata(content);
  if (selectedEvent) {
    attachSelectedEventSourcePages(content, selectedEvent);
  }

  const slug = buildSlug(now);
  if (lightweightPublish) {
    await env.BLOG_AI_KV.put(
      `${KV_DRAFT_PREFIX}${slug}`,
      JSON.stringify({
        content,
        publishedAt: now.toISOString(),
      }),
      { expirationTtl: 3 * 86_400 },
    );
  } else if (!lightweightPublish) {
    let didYouKnowGroundingVerified = false;
    if (groundingSource) {
      const finalGrounding = await verifyFinalGroundingWithRepair(env, content, groundingSource, slug);
      if (!finalGrounding.ok) {
        await markGroundingBlockedEvent(env, slug, content, finalGrounding.reasons);
        throw new Error(
          `Refusing to publish ${slug}: final source-grounding check failed — ${finalGrounding.reasons.join("; ")}`,
        );
      }
      content = finalGrounding.content;
      didYouKnowGroundingVerified = true;
    }
    const quizParagraphs = [
      ...(content.overviewParagraphs || []),
      ...(content.eyewitnessOrChronicle || []),
      ...(content.aftermathParagraphs || []),
      ...(content.conclusionParagraphs || []),
    ];
    const quiz = await generateBlogQuiz(env, {
      ...content,
      keyFacts: quizParagraphs
        .filter((paragraph) => paragraph && paragraph.length > 40 && paragraph.length < 750)
        .slice(0, 15),
    }, slug);
    if (!quiz || !validateQuizQuestions(quiz.questions)) {
      throw new Error(`Refusing to publish ${slug}: grounded five-question quiz generation failed`);
    }
    await env.BLOG_AI_KV.put(`quiz-v3:blog:${slug}`, JSON.stringify(quiz), {
      expirationTtl: 90 * 86_400,
    });
    const bookCoverUrl = await fetchBookCover(content.bookSearchQuery).catch(() => null);
    const entityMeta = blogKvBackgroundWritesPaused(env)
      ? publicationReserveArticlePeople(content, slug)
      : await upsertEntitiesForContent(env, content, slug, now, pillars).catch((err) => {
        console.warn(`Entity graph update failed for ${slug}: ${err.message}`);
        suppressPersonProfileLink(content);
        return unlinkedArticlePeople(content);
      });

    await savePublishedPost(env, {
      slug,
      date: now,
      content,
      existingIndex,
      pillars,
      bookCoverUrl,
      personImages,
      eventImages,
      entityMeta,
      verifiedFeaturedImage: content.imageUrl,
      didYouKnowGroundingVerified,
    });
  }

  if (lightweightPublish && enrichDraft) {
    // Manual/default lightweight publication remains synchronous when ctx is
    // absent. The daily cron passes enrichDraft:false and lets the dedicated
    // 00:15 invocation promote the stored draft with a fresh request budget.
    const enrichErr = async (err) => {
      console.error(`Blog: enrichment failed for ${slug} — ${err.message}`);
      await recordPipelineFailure(env, {
        step: "blog",
        slug,
        message: err.message,
        date: new Date(),
      });
      return optionalBlogKvPut(
        env,
        `debug:enrich-error:${slug}`,
        JSON.stringify({ error: err.message, stack: err.stack?.slice(0, 500), ts: new Date().toISOString() }),
        { expirationTtl: 7 * 86_400 },
      );
    };
    if (ctx?.waitUntil) {
      ctx.waitUntil(enrichPublishedPost(env, slug).catch(enrichErr));
    } else {
      try {
        await enrichPublishedPost(env, slug);
      } catch (err) {
        await enrichErr(err);
        throw err;
      }
    }
  } else if (!lightweightPublish) {
    if (ctx?.waitUntil) {
      ctx.waitUntil(runPostPublishExtras(env, slug, content, { scheduleEnrichment: false }));
    } else {
      await runPostPublishExtras(env, slug, content, { scheduleEnrichment: false });
    }
  }

  console.log(
    lightweightPublish
      ? `Blog: drafted post "${content.title}" → ${KV_DRAFT_PREFIX}${slug}${enrichDraft ? " (enrichment started)" : " (awaiting dedicated enrichment)"}`
      : `Blog: published post "${content.title}" → /blog/${slug}/`,
  );
}

/**
 * Completes post-publish work. For lightweight publishes this promotes the
 * draft into the public post/index. For full publishes it handles cache purges,
 * quiz generation, quiz page cache bust, WebSub ping, and Discord notify.
 */
async function runPostPublishExtras(env, slug, content, { scheduleEnrichment = false } = {}) {
  if (scheduleEnrichment) {
    try {
      await enrichPublishedPost(env, slug);
    } catch (err) {
      const message = `Draft enrichment failed: ${err.message}`;
      console.error(`Blog: enrich failed for ${slug}: ${message}`);
      await recordPipelineFailure(env, {
        step: "blog",
        slug,
        message,
        date: new Date(),
      });
      throw err;
    }
    return;
  }

  // T8: Collect URLs for IndexNow submission — blog post + entity pages + year hub.
  // post-entities:{slug} is written by upsertEntitiesForContent before this runs.
  const indexNowUrls = [`https://thisday.info/blog/${slug}/`];
  try {
    const entitiesRaw = env.BLOG_AI_KV
      ? await env.BLOG_AI_KV.get(`post-entities:${slug}`)
      : null;
    if (entitiesRaw) {
      for (const e of JSON.parse(entitiesRaw)) {
        // Skip unlinked persons (profileLinkEligible false means no public /people/ page).
        const eligibleHistoryEntity =
          e?.type !== "event" || e.historyLinkEligible === true;
        if (
          e?.url &&
          eligibleHistoryEntity &&
          !(e.type === "person" && e.profileLinkEligible === false)
        ) {
          indexNowUrls.push(`https://thisday.info${e.url}`);
        }
      }
    }
  } catch (_) {}
  const histYear = String(content?.historicalYear || "").trim()
    || (content?.historicalDateISO || "").slice(0, 4);
  if (/^\d{3,4}$/.test(histYear)) indexNowUrls.push(`https://thisday.info/years/${histYear}/`);
  const suppressExternalNotifications = Boolean(
    env.SUPPRESS_POST_PUBLISH_NOTIFICATIONS || env.AI_CASSETTE,
  );

  // Purge the cached sitemap and RSS feed so they reflect the new post immediately
  // (both workers cache for 1 h — without this, the new post would be invisible
  //  to crawlers until the next cache expiry).
  const cache = caches.default;
  const cacheAndNotifyTasks = [
    cache.delete(new Request("https://thisday.info/sitemap.xml")),
    cache.delete(new Request("https://thisday.info/rss.xml")),
    cache.delete(new Request("https://thisday.info/news-sitemap.xml")),
  ];
  if (suppressExternalNotifications) {
    console.log(`Blog: post-publish notifications suppressed for ${slug}`);
  } else {
    // T8: Ping search engines with post + entity + hub URLs for fast Bing/Copilot discovery.
    cacheAndNotifyTasks.push(fetch("https://thisday.info/search-ping", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.SEARCH_PING_SECRET ? { Authorization: `Bearer ${env.SEARCH_PING_SECRET}` } : {}),
      },
      body: JSON.stringify({ urls: indexNowUrls }),
    }));
  }
  await Promise.allSettled(cacheAndNotifyTasks);

  // Generate and store a quiz using the already-available content.
  // Skip this in lightweight publish mode — the enrichment pass will get a fresh request budget.
  if (scheduleEnrichment) {
    return;
  }

  try {
    const quizKey = `quiz-v3:blog:${slug}`;
    const existingQuiz = await env.BLOG_AI_KV.get(quizKey);
    if (existingQuiz && !parseValidBlogQuiz(existingQuiz)) {
      await env.BLOG_AI_KV.delete(quizKey).catch(() => {});
    }
    if (!parseValidBlogQuiz(existingQuiz)) {
      const allParas = [
        ...(content.overviewParagraphs || []),
        ...(content.eyewitnessOrChronicle || []),
        ...(content.aftermathParagraphs || []),
        ...(content.conclusionParagraphs || []),
      ];
      const enrichedContent = {
        ...content,
        keyFacts: allParas
          .filter((p) => p && p.length > 40 && p.length < 750)
          .slice(0, 15),
        description:
          content.description || allParas.slice(0, 3).join(" ").substring(0, 800),
      };
      const quiz = await generateBlogQuiz(env, enrichedContent, slug);
      if (quiz) {
        await env.BLOG_AI_KV.put(quizKey, JSON.stringify(quiz), {
          expirationTtl: 90 * 86_400,
        });
      }
    }
  } catch (e) {
    console.error("Blog quiz generation failed:", e);
  }

  // Bust the quiz page HTML cache so /quiz/{month}/{day}/ rebuilds with the new blog quiz
  if (env.EVENTS_KV) {
    try {
      const sp = parseSlugDate(slug);
      if (sp) {
        const mPad = String(sp.monthIndex + 1).padStart(2, "0");
        const dPad = String(sp.day).padStart(2, "0");
        await env.EVENTS_KV.delete(`quiz-page-v31:${mPad}-${dPad}`);
        console.log(`Blog: busted quiz-page-v31:${mPad}-${dPad} cache`);
      }
    } catch (e) {
      console.error("Blog: quiz page cache bust failed:", e);
    }
  }

  // Ping WebSub hub so Flipboard (and other subscribers) get notified immediately
  if (!suppressExternalNotifications) {
    try {
      const hubBody = new URLSearchParams({
        "hub.mode": "publish",
        "hub.url": "https://thisday.info/rss.xml",
      });
      await fetch("https://pubsubhubbub.appspot.com/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: hubBody,
      });
      console.log("Blog: WebSub hub pinged");
    } catch (e) {
      console.error("Blog: WebSub ping failed:", e);
    }
  }

  // Notify Discord that a new post has been published (silent no-op if not configured).
  // Set DISCORD_WEBHOOK_URL via:  npx wrangler secret put DISCORD_WEBHOOK_URL --config wrangler-blog.jsonc
  if (env.DISCORD_WEBHOOK_URL && !suppressExternalNotifications) {
    try {
      const postUrl = `https://thisday.info/blog/${slug}/`;
  const message =
        `📰 **New blog post published**\n` +
        `📖 ${publicArticleTitle(content)}\n` +
        `🌐 ${postUrl}`;
      await fetch(env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message }),
      });
      console.log("Blog: Discord notified");
    } catch (e) {
      console.warn("Blog: Discord notify failed:", e.message);
    }
  }
}

function normalizeContentMetadata(content) {
  const originalEventTitle = content.eventTitle;
  const repairedEventTitle = repairStackedTitleLead(
    repairPromotionalTitleLead(content.eventTitle),
  );
  if (repairedEventTitle && repairedEventTitle !== content.eventTitle) {
    content.eventTitle = repairedEventTitle;
    content.jsonLdName = repairedEventTitle;
    if (Array.isArray(content.quickFacts)) {
      content.quickFacts = content.quickFacts.map((fact) =>
        String(fact?.label || "").toLowerCase() === "event" &&
        (!fact.value || fact.value === originalEventTitle)
          ? { ...fact, value: repairedEventTitle }
          : fact,
      );
    }
  }
  const repairedTitleLead = repairStackedTitleLead(
    repairPromotionalTitleLead(getTitleLead(content.title)),
  );
  if (repairedTitleLead && repairedTitleLead !== getTitleLead(content.title)) {
    content.title = buildDisplayTitle(
      repairedTitleLead,
      repairedEventTitle || content.eventTitle,
      content.historicalDate,
    );
  }
  normalizeEventTitleAction(content);
  restoreSourceEventHeadline(content);
  if (isWeakCtaTitleLead(getTitleLead(content.title))) {
    content.title = buildDisplayTitle(
      content.eventTitle,
      content.eventTitle,
      content.historicalDate,
    );
  }
  const titleLead = getTitleLead(content.title);
  const eventLead = getTitleLead(content.eventTitle);
  if (
    titleLead &&
    eventLead &&
    titleLead.length > eventLead.length &&
    titleLead.length <= HEADLINE_SEO_MAX &&
    hasStrongTitleAction(titleLead) &&
    normalizeTopicMatchText(titleLead).startsWith(normalizeTopicMatchText(eventLead))
  ) {
    content.eventTitle = titleLead;
    content.jsonLdName = titleLead;
  }
  alignJsonLdMetadata(content);

  if (!content.description || content.description.length < 120 || /^Discover the story of /i.test(content.description)) {
    const overviewLead = String(content.overviewParagraphs?.[0] || "").replace(/<[^>]+>/g, " ");
    const firstSentence = extractFirstSentence(overviewLead);
    if (firstSentence.length >= 60) {
      content.description = truncateForMeta(firstSentence, 155);
    } else {
      const sig = (content.quickFacts || []).find((f) => /significance|legacy|impact/i.test(f.label))?.value || "";
      const loc = content.location ? `, ${content.location}` : "";
      content.description = truncateForMeta(`${content.eventTitle} (${content.historicalDate}${loc})${sig ? `: ${sig}.` : "."}`, 155);
    }
  }
  if (content.description.length > 155) {
    content.description = truncateForMeta(content.description, 155);
  }
  if (!content.ogDescription || content.ogDescription.length < 80) {
    content.ogDescription = truncateForMeta(content.description, 130);
  } else if (content.ogDescription.length > 130) {
    content.ogDescription = truncateForMeta(content.ogDescription, 130);
  }
  if (!content.twitterDescription || content.twitterDescription.length < 60) {
    content.twitterDescription = truncateForMeta(content.description, 120);
  } else if (content.twitterDescription.length > 120) {
    content.twitterDescription = truncateForMeta(content.twitterDescription, 120);
  }
}

function alignJsonLdMetadata(content) {
  if (!content) return;
  if (content.eventTitle) content.jsonLdName = content.eventTitle;
  if (!content.jsonLdUrl && content.wikiUrl) content.jsonLdUrl = content.wikiUrl;
  if (!content.jsonLdDescription && content.description) content.jsonLdDescription = content.description;
}

/**
 * Returns true if the title already contains a recognisable action verb or event noun.
 *
 * Three-layer approach to avoid the "endless growing list" problem:
 *   1. Event nouns that inherently imply a historical action (battle, crash, etc.)
 *   2. Known-verb fast path for the most frequent headline verbs
 *   3. Structural suffix detection — catches virtually all regular English present-tense
 *      verbs (disintegrates, explodes, collapses, launches, vanishes, …) and past-tense
 *      forms without enumerating every word.
 */
function hasStrongTitleAction(value) {
  const s = String(value || "");

  // 1. Event nouns that already describe an action without needing a separate verb
  if (/\b(battle|siege|revolt|revolution|war|attack|bombing|raid|massacre|trial|coronation|independence|crash|assassination|execution)\b/i.test(s)) return true;

  return hasFiniteHeadlineVerb(s);
}

function stripLazyTitleSuffix(value) {
  return String(value || "")
    .replace(/\s+\b(Founding|Creation|Launch|Opening|Completion|Presentation)\b$/i, "")
    .trim();
}

function evidenceForTitle(content) {
  return plainText(
    [
      content.title,
      content.eventTitle,
      content.description,
      content.jsonLdDescription,
      content.contentRationale,
      ...(content.overviewParagraphs || []),
      ...(content.quickFacts || []).map((fact) => `${fact?.label || ""}: ${fact?.value || ""}`),
    ].join(" "),
  );
}

/**
 * Structural guard: returns true if the last word of the title looks like
 * a present-tense or past-tense verb. Prevents double-verb stacking
 * (e.g. "Disintegrates Crashes", "Vanishes Kills").
 *
 * Strategy: check the last word of the title against hasStrongTitleAction (which
 * already handles all known cases correctly) PLUS a suffix-based catch-all for
 * words not in the known list.
 */
function titleEndsWithVerb(s) {
  const lastWord = (String(s || "").trim().match(/\S+$/) || [""])[0];
  if (!lastWord || lastWord.length < 4) return false;
  // Layer A: known verb forms only (intentionally excludes event nouns like "crash",
  // "independence", "battle" from hasStrongTitleAction layer 1 — those are nouns,
  // not evidence that the title has a verb).
  if (HEADLINE_ACTION_VERB_ONLY_RE.test(lastWord)) return true;
  // Layer B: structural suffix catch-all — virtually all regular English present-tense
  // verbs ending in a vowel+consonant+e pattern (≥5 chars to avoid short nouns).
  return lastWord.length >= 5 &&
    /(?:ates|ites|etes|odes|ides|ades|izes|ises|aves|ives|oves|apes|anes|ines|ones|enes|ashes|ishes|ushes|arches|atches|etches|itches|ches|shes)$/i.test(lastWord);
}

function deriveCtaEventTitle(currentEvent, evidence) {
  const base = stripLazyTitleSuffix(currentEvent);
  const text = String(evidence || "").replace(/\s+/g, " ").trim();

  // Structural guard: if the title already ends with a word that looks like a verb,
  // leave it alone — don't try to append another verb. This is the reliable,
  // list-free check that prevents "X Disintegrates Crashes"-style stacking.
  if (titleEndsWithVerb(base)) return currentEvent;

  const baseHasFiniteVerb = hasFiniteHeadlineVerb(base);

  if (/helicopter crash in iran|president ebrahim raisi|varzaqan helicopter/i.test(text)) {
    return "Iran Helicopter Crash Kills President Raisi";
  }
  if (/china airlines.*flight 611|flight 611.*china airlines|china airlines 611/i.test(text)) {
    return "China Airlines Flight 611 Disintegrates in Mid-Air";
  }
  if (/egyptair flight 804/i.test(text)) {
    return "EgyptAir Flight 804 Crashes in the Mediterranean";
  }
  if (/brown v\.?\s*board|segregation unconstitutional|school segregation/i.test(text)) {
    return "Brown v. Board Strikes Down School Segregation";
  }
  if (/first academy awards|first oscars|wings/i.test(text)) {
    return "First Oscars Honor Wings in Hollywood";
  }
  if (/las vegas/i.test(text) && /land auction|railroad|san pedro|salt lake railroad|founded/i.test(text)) {
    return "Las Vegas Begins as Railroad Land Auction";
  }
  if (/israeli independence|state of israel|david ben-gurion|declared the establishment/i.test(text)) {
    return "Israel Declares Independence";
  }
  if (/prince harry|meghan markle|st george/i.test(text) && /wedding|married|chapel/i.test(text)) {
    return "Prince Harry and Meghan Markle Marry at Windsor";
  }

  // DELIBERATELY no generic "append a bare verb to the noun phrase" fallbacks
  // here. Appending a lone verb to whatever string is in `base` produces
  // ungrammatical stacked titles whenever `base` is not a clean subject — e.g.
  // an AI noun phrase that already contains an (unrecognized) verb. On
  // 2026-06-20 this path turned "ABC News Abruptly Cuts Broadcast" into
  // "ABC News Abruptly Cuts Broadcast Kills" (evidence mentioned a death). The
  // title contract is explicit: never take a noun phrase and just append a bare
  // verb — always build a proper subject-verb clause. When no curated complete
  // clause matches, leave the title unchanged rather than fabricate one.
  return currentEvent;
}

function normalizeEventTitleAction(content) {
  if (!content) return;
  const currentEvent = String(content.eventTitle || "").trim();
  const currentTitle = String(content.title || "").trim();
  if (!currentEvent) return;

  const evidence = evidenceForTitle(content);
  const titleLead = getTitleLead(currentTitle);
  const lazySuffix = /\b(Founding|Creation|Launch|Opening|Completion|Presentation)\b$/i;
  const genericNounTitle = /\b(Independence|Ruling|Decision|Ceremony)\b$/i;
  const needsRepair =
    !hasFiniteHeadlineVerb(currentEvent) ||
    (titleLead && !hasFiniteHeadlineVerb(titleLead)) ||
    lazySuffix.test(currentEvent) ||
    lazySuffix.test(titleLead) ||
    genericNounTitle.test(currentEvent) ||
    genericNounTitle.test(titleLead);

  if (!needsRepair) return;

  const improvedEvent = deriveCtaEventTitle(currentEvent, evidence);
  if (!improvedEvent || improvedEvent === currentEvent) return;

  content.eventTitle = improvedEvent;
  content.jsonLdName = improvedEvent;
  if (currentTitle) {
    content.title = buildDisplayTitle(improvedEvent, improvedEvent, content.historicalDate);
  }
  if (Array.isArray(content.quickFacts)) {
    content.quickFacts = content.quickFacts.map((fact) =>
      String(fact?.label || "").toLowerCase() === "event" && fact.value === currentEvent
        ? { ...fact, value: improvedEvent }
        : fact,
    );
  }
}

async function savePublishedPost(
  env,
  {
    slug,
    date,
    content,
    existingIndex,
    pillars = [],
    bookCoverUrl = null,
    personImages = [],
    eventImages = [],
    entityMeta = [],
    verifiedFeaturedImage = null,
    didYouKnowGroundingVerified = false,
  },
) {
  const safePillars = Array.isArray(pillars) ? pillars : [];
  let safePersonImages = Array.isArray(personImages) ? personImages : [];
  const safeEventImages = Array.isArray(eventImages) ? eventImages : [];
  let safeEntityMeta = Array.isArray(entityMeta) ? entityMeta : [];

  alignContentDateFields(content, { historicalDateISO: date.toISOString().slice(0, 10) });
  const dateValidation = validateContentDateForPublish(content, date);
  if (!dateValidation.ok) {
    throw new Error(`Refusing to publish ${slug}: ${dateValidation.reason}`);
  }
  const semanticValidation = validateContentSemanticsForPublish(content);
  if (!semanticValidation.ok) {
    throw new Error(
      `Refusing to publish ${slug}: semantic publication contract failed — ${semanticValidation.reasons.join("; ")}`,
    );
  }
  const citationValidation = validateDirectCitationsForPublish(content);
  if (!citationValidation.ok) {
    throw new Error(
      `Refusing to publish ${slug}: direct-citation contract failed — ${citationValidation.reasons.join("; ")}`,
    );
  }
  const curiosityTitleValidation = validateCuriosityTitleForPublish(content);
  if (!curiosityTitleValidation.ok) {
    throw new Error(
      `Refusing to publish ${slug}: public question-title contract failed — ${curiosityTitleValidation.reasons.join("; ")}`,
    );
  }
  const evidenceMapValidation = validateEvidenceMapForPublish(content);
  if (!evidenceMapValidation.ok) {
    throw new Error(
      `Refusing to publish ${slug}: evidence-map contract failed — ${evidenceMapValidation.reasons.join("; ")}`,
    );
  }
  const originalValueValidation = validateOriginalValueForPublish(content);
  if (!originalValueValidation.ok) {
    throw new Error(
      `Refusing to publish ${slug}: original-value contract failed — ${originalValueValidation.reasons.join("; ")}`,
    );
  }
  content.originalValueGateVersion = originalValueValidation.gateVersion;
  content.originalValueModules = originalValueValidation.modules.map(
    (module) => module.type,
  );
  const didYouKnowValidation = auditDidYouKnowFacts(content, {
    requireGrounding: true,
    groundingVerified: didYouKnowGroundingVerified,
  });
  if (!didYouKnowValidation.ok) {
    throw new Error(
      `Refusing to publish ${slug}: Did You Know contract failed — ${didYouKnowValidation.reasons.join("; ")}`,
    );
  }
  // Final publication gate: enrichment is allowed to retry transient image
  // failures, but public HTML must never be written without a working Wikimedia
  // hero. This also protects callers that bypass the normal generation path.
  const canReuseVerifiedFeaturedImage =
    verifiedFeaturedImage === content.imageUrl &&
    isProxyableArticleImageUrl(verifiedFeaturedImage) &&
    !isLowValueFeaturedImage(verifiedFeaturedImage);
  const finalFeaturedImage = canReuseVerifiedFeaturedImage
    ? verifiedFeaturedImage
    : await resolveWorkingImageForContent(content);
  if (!finalFeaturedImage) {
    throw new Error(`Refusing to publish ${slug}: no working featured image`);
  }
  content.imageUrl = finalFeaturedImage;
  const featuredImageValidation = prepareFeaturedImageForPublish(
    content,
    finalFeaturedImage,
    {
      trustedPageTitle:
        wikiTitleFromUrl(content.wikiUrl) ||
        content.sourcePageTitle ||
        content.eventTitle,
    },
  );
  if (!featuredImageValidation.ok) {
    throw new Error(
      `Refusing to publish ${slug}: featured-image subject/alt contract failed — ${featuredImageValidation.reasons.join("; ")}`,
    );
  }
  if (featuredImageValidation.repairedAlt) {
    console.log(
      `Blog: grounded featured-image alt text from Wikimedia filename for ${slug}`,
    );
  }
  await hydrateContentAssetsForPublish(content, safePillars).catch((err) => {
    console.warn(`Article asset hydration failed for ${slug}: ${err.message}`);
  });
  safeEntityMeta = await hydrateArticleEntityImages(env, safeEntityMeta).catch((err) => {
    console.warn(`Article entity image hydration failed for ${slug}: ${err.message}`);
    return safeEntityMeta;
  });
  const linkedPeople = new Set(
    safeEntityMeta
      .filter((entity) =>
        entity?.type === "person" &&
        hasVerifiedPersonProfileIdentity(entity),
      )
      .map((entity) => normalizeTopicMatchText(entity.name)),
  );
  safePersonImages = safePersonImages.filter((image) =>
    linkedPeople.has(normalizeTopicMatchText(image?.name)),
  );

  assertRequiredContentBlocks(content);
  const rawHtml = buildPostHTML(
    content,
    date,
    slug,
    existingIndex,
    safePillars,
    bookCoverUrl,
    safeEntityMeta,
  );
  let html = injectLinks(rawHtml, content.keyTerms, existingIndex, content.eventTitle);
  if (safePersonImages.length > 0) html = injectPersonImages(html, safePersonImages);
  if (safeEventImages.length > 0) html = injectEventImages(html, safeEventImages);
  if (safeEntityMeta.length > 0) {
    html = injectArticleEntityStrip(html, safeEntityMeta);
    html = addHtmlMarker(html, ENTITY_STRIP_BACKFILL_MARKER);
  }
  html = addHtmlMarker(html, FEATURED_IMAGE_CHECK_MARKER);
  if (/<figure style="float:(?:right|left);/i.test(html)) {
    html = addHtmlMarker(html, EVENT_FIGURES_BACKFILL_MARKER);
  }
  const structuredDataValidation = validateArticleStructuredDataForPublish(
    html,
    content,
    safeEntityMeta,
  );
  if (!structuredDataValidation.ok) {
    throw new Error(
      `Refusing to publish ${slug}: structured-data contract failed — ${structuredDataValidation.reasons.join("; ")}`,
    );
  }
  // Tier 1: hard structural check — throws if buildPostHTML produced a broken article.
  assertArticleStructure(html);
  // Tier 2: soft asset-quality check — adds backfill markers, logs warnings, never throws.
  const { html: checkedHtml, issues: assetIssues } = softCheckArticleAssets(html, content);
  if (assetIssues.length > 0) {
    console.warn(`Blog: asset quality warnings for ${slug}: ${assetIssues.join("; ")}`);
  }
  await env.BLOG_AI_KV.put(`${KV_POST_PREFIX}${slug}`, checkedHtml);
  if (safeEntityMeta.length > 0) {
    const lightweightEntities = compactArticleEntityMeta(safeEntityMeta);
    await optionalBlogKvPut(
      env,
      `post-entities:${slug}`,
      JSON.stringify(lightweightEntities),
    );
  }

  const deduped = [...existingIndex].filter((e) => e.slug !== slug);
  const topicHubs = getArticleTopicHubMatches(content, 3).map((hub) => hub.slug);
  const entry = {
    slug,
    title: publicArticleTitle(content),
    factualTitle: content.title,
    description: content.description,
    imageUrl: content.imageUrl,
    publishedAt: date.toISOString(),
    ...(content.wikiUrl ? { wikiUrl: content.wikiUrl } : {}),
    ...(content.jsonLdUrl ? { jsonLdUrl: content.jsonLdUrl } : {}),
    ...(content.keywords ? { keywords: content.keywords } : {}),
    ...(content.eventTitle ? { eventTitle: content.eventTitle } : {}),
    ...(Number.isInteger(content.historicalYear) ? { historicalYear: content.historicalYear } : {}),
    ...(Array.isArray(content.keyTerms) && content.keyTerms.length > 0 ? { keyTerms: content.keyTerms } : {}),
    ...(compactSourcePagesForIndex(content).length > 0 ? { sourcePages: compactSourcePagesForIndex(content) } : {}),
    ...(content.sourcePageTitle ? { sourcePageTitle: content.sourcePageTitle } : {}),
    ...(safePillars.length > 0 ? { pillars: safePillars } : {}),
    ...(topicHubs.length > 0 ? { topicHubs } : {}),
    ...(content.contentRationale ? { contentRationale: content.contentRationale } : {}),
    originalValueGateVersion: content.originalValueGateVersion,
    originalValueModules: content.originalValueModules,
  };
  deduped.unshift(entry);
  if (deduped.length > 200) deduped.splice(200);
  await env.BLOG_AI_KV.put(KV_INDEX_KEY, JSON.stringify(deduped));
  await recordPipelineSuccess(env, {
    step: "blog",
    slug,
    date,
  }).catch((err) => {
    console.warn(`Blog: failed to record pipeline success for ${slug}: ${err.message}`);
  });
}

async function enrichPublishedPost(
  env,
  slug,
  { boundedRecovery = false } = {},
) {
  // Persist only milestone checkpoints. Earlier code rewrote this one debug
  // key at every enrichment step, spending 14+ puts on a successful article.
  const persistedCheckpoints = new Set([
    "started",
    "pre-final-grounding",
    "pre-save",
    "done",
  ]);
  const chk = (step) => {
    console.log(`Blog AI: enrich ${slug} checkpoint ${step}`);
    if (!persistedCheckpoints.has(step)) return Promise.resolve(false);
    return optionalBlogKvPut(
      env,
      `debug:enrich-step:${slug}`,
      JSON.stringify({ step, ts: new Date().toISOString() }),
      { expirationTtl: 7 * 86_400 },
    );
  };

  await chk("started");

  const draftRaw = await env.BLOG_AI_KV.get(`${KV_DRAFT_PREFIX}${slug}`);
  if (!draftRaw) throw new Error(`No draft found for ${slug}`);

  const draft = JSON.parse(draftRaw);
  const content = draft?.content;
  const publishedAt = draft?.publishedAt;
  if (!content || !publishedAt) throw new Error(`Draft payload invalid for ${slug}`);
  const groundingSource = groundingSourceFromContent(content);

  // Validate the hero while the request still has a fresh external-subrequest
  // budget. Enrichment can exhaust that budget during later provider fallbacks;
  // repeating the same Wikimedia HEAD check at save time then creates a false
  // "no working featured image" failure even though the proxy serves it.
  const verifiedFeaturedImage = await resolveWorkingImageForContent(content);
  if (!verifiedFeaturedImage) {
    throw new Error(`Refusing to publish ${slug}: no working featured image`);
  }
  content.imageUrl = verifiedFeaturedImage;

  // Recover older drafts that used a dated title as their only date source
  // before any enrichment rewrite can remove that title suffix. Pass the
  // publication date as canonical month/day to pin dual-calendar events.
  const date = new Date(publishedAt);
  alignContentDateFields(content, { historicalDateISO: date.toISOString().slice(0, 10) });
  const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
  const existingIndex = indexRaw ? JSON.parse(indexRaw) : [];

  let enriched;
  let pillars;
  if (boundedRecovery) {
    await chk("bounded-preflight");
    const boundedIssues = [
      ...scanBannedPhrases(content),
      ...scanArticleQuality(content),
      ...scanIntraPageDuplication(content),
    ];
    if (boundedIssues.length > 0) {
      throw new Error(
        `Bounded recovery rejected the draft before publication: ${boundedIssues.join("; ")}`,
      );
    }
    enriched = content;
    pillars = classifyPillarsDeterministically(enriched);
    await chk("bounded-preflight-passed");
  } else {
    await chk("pre-banned-phrases");
    const violations = scanBannedPhrases(content);
    const fixed = violations.length > 0
      ? await fixBannedPhrases(env, content, violations, groundingSource)
      : content;
    const qualityIssues = [...scanArticleQuality(fixed), ...scanIntraPageDuplication(fixed)];
    const qualityRepaired = qualityIssues.length > 0
      ? await improveArticleQuality(env, fixed, qualityIssues, groundingSource)
      : fixed;

    await chk("pre-seo-review");
    enriched = await reviewContentWithSEOExpert(qualityRepaired, env, groundingSource);
    await chk("post-seo-review");

    const postReviewViolations = scanBannedPhrases(enriched);
    if (postReviewViolations.length > 0) {
      enriched = await fixBannedPhrases(env, enriched, postReviewViolations, groundingSource);
    }
    const postReviewQualityIssues = [...scanArticleQuality(enriched), ...scanIntraPageDuplication(enriched)];
    if (postReviewQualityIssues.length > 0) {
      enriched = await improveArticleQuality(env, enriched, postReviewQualityIssues, groundingSource);
    }

    await chk("pre-factcheck");
    await factCheckContent(env, enriched, groundingSource);
    await validateEyewitnessQuote(env, enriched);
    pillars = await classifyPillars(env, enriched);
    await chk("post-factcheck");
  }

  const workingImage = verifiedFeaturedImage;
  enriched.imageUrl = verifiedFeaturedImage;

  const [personImages, eventImages, bookCoverUrl] = await Promise.all([
    fetchKeyPersonImages(env, enriched.keyTerms).catch(() => []),
    enriched.wikiUrl
      ? fetchEventImages(enriched.wikiUrl, enriched.imageUrl, 3, enriched.eventTitle).catch(() => [])
      : Promise.resolve([]),
    fetchBookCover(enriched.bookSearchQuery).catch(() => null),
  ]);
  await chk("post-images");

  // If the primary image check failed, fall back to the first event figure already
  // embedded in the article rather than publishing with a broken featured image.
  if (
    !workingImage &&
    eventImages?.length > 0 &&
    isProxyableArticleImageUrl(eventImages[0].imageUrl)
  ) {
    enriched.imageUrl = eventImages[0].imageUrl;
    console.log(`Blog: featured image fallback → event figure "${eventImages[0].imageUrl}" for ${slug}`);
  }

  if (!boundedRecovery) {
    await generateEditorialNote(env, enriched, date);
    await chk("post-editorial-note");

    const editorialQualityIssues = [...scanArticleQuality(enriched), ...scanIntraPageDuplication(enriched)];
    if (editorialQualityIssues.length > 0) {
      enriched = await improveArticleQuality(env, enriched, editorialQualityIssues, groundingSource);
    }
  }
  enriched = enforceEditorialNoteQuality(enriched);
  alignContentDateFields(enriched, { historicalDateISO: date.toISOString().slice(0, 10) });
  const dateValidation = validateContentDateForPublish(enriched, date);
  if (!dateValidation.ok) {
    throw new Error(`Refusing to enrich ${slug}: ${dateValidation.reason}`);
  }

  await chk("pre-learning-blocks");
  try {
    if (!boundedRecovery || !validateSourcedTimelineForPublish(enriched).ok) {
      await generateLearningBlocks(env, enriched);
    }
    groundLearningBlocks(enriched);
  } catch (err) {
    console.warn(`Blog: learning-blocks pass failed for ${slug}: ${err.message}`);
    delete enriched.timeline;
  }

  normalizeContentMetadata(enriched);
  const semanticValidation = validateContentSemanticsForPublish(enriched);
  if (!semanticValidation.ok) {
    throw new Error(
      `Refusing to publish ${slug}: semantic publication contract failed — ${semanticValidation.reasons.join("; ")}`,
    );
  }
  const citationValidation = validateDirectCitationsForPublish(enriched);
  if (!citationValidation.ok) {
    throw new Error(
      `Refusing to publish ${slug}: direct-citation contract failed — ${citationValidation.reasons.join("; ")}`,
    );
  }
  const curiosityTitleValidation = validateCuriosityTitleForPublish(enriched);
  if (!curiosityTitleValidation.ok) {
    throw new Error(
      `Refusing to publish ${slug}: public question-title contract failed — ${curiosityTitleValidation.reasons.join("; ")}`,
    );
  }
  const evidenceMapValidation = validateEvidenceMapForPublish(enriched);
  if (!evidenceMapValidation.ok) {
    throw new Error(
      `Refusing to publish ${slug}: evidence-map contract failed — ${evidenceMapValidation.reasons.join("; ")}`,
    );
  }
  const originalValueValidation = validateOriginalValueForPublish(enriched);
  if (!originalValueValidation.ok) {
    throw new Error(
      `Refusing to publish ${slug}: original-value contract failed — ${originalValueValidation.reasons.join("; ")}`,
    );
  }

  let didYouKnowGroundingVerified = false;
  if (groundingSource) {
    await chk("pre-final-grounding");
    const finalGrounding = await verifyFinalGroundingWithRepair(env, enriched, groundingSource, slug);
    if (!finalGrounding.ok) {
      await markGroundingBlockedEvent(env, slug, enriched, finalGrounding.reasons);
      throw new Error(
        `Refusing to publish ${slug}: final source-grounding check failed — ${finalGrounding.reasons.join("; ")}`,
      );
    }
    enriched = finalGrounding.content;
    didYouKnowGroundingVerified = true;
    await chk("post-final-grounding");
  }

  const quizParagraphs = [
    ...(enriched.overviewParagraphs || []),
    ...(enriched.eyewitnessOrChronicle || []),
    ...(enriched.aftermathParagraphs || []),
    ...(enriched.conclusionParagraphs || []),
  ];
  const quizContent = {
    ...enriched,
    keyFacts: quizParagraphs
      .filter((paragraph) => paragraph && paragraph.length > 40 && paragraph.length < 750)
      .slice(0, 15),
  };
  const quiz = await generateBlogQuiz(env, quizContent, slug);
  if (!quiz || !Array.isArray(quiz.questions) || quiz.questions.length !== 5) {
    throw new Error(`Refusing to publish ${slug}: grounded five-question quiz generation failed`);
  }
  await env.BLOG_AI_KV.put(`quiz-v3:blog:${slug}`, JSON.stringify(quiz), {
    expirationTtl: 90 * 86_400,
  });

  await chk("pre-entities");
  // Skip AI card generation here — saves ~2 subrequests per entity (up to ~18 total)
  // and keeps the enrichment invocation well under the 50-subrequest budget.
  // Entities are flagged needsWikiRefresh so the cron entity-refresh loop
  // generates their AI overview cards within 1–3 days.
  const entityMeta = blogKvBackgroundWritesPaused(env)
    ? publicationReserveArticlePeople(enriched, slug)
    : await upsertEntitiesForContent(
      env,
      enriched,
      slug,
      date,
      pillars,
      { skipAiGeneration: true },
    ).catch((err) => {
      console.warn(`Entity graph update failed for ${slug}: ${err.message}`);
      suppressPersonProfileLink(enriched);
      return unlinkedArticlePeople(enriched);
    });

  await chk("pre-save");
  await savePublishedPost(env, {
    slug,
    date,
    content: enriched,
    existingIndex,
    pillars,
    bookCoverUrl,
    personImages,
    eventImages,
    entityMeta,
    verifiedFeaturedImage,
    didYouKnowGroundingVerified,
  });
  await chk("saved");

  await env.BLOG_AI_KV.delete(`${KV_DRAFT_PREFIX}${slug}`).catch(() => {});
  await runPostPublishExtras(env, slug, enriched, { scheduleEnrichment: false });
  await chk("done");
  console.log(`Blog AI: ${slug} enrichment complete. ${aiUsageSummary()}`);
}

function entitySlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function normalizeEntityType(type) {
  const value = String(type || "").toLowerCase();
  if (value === "person") return "person";
  if (value === "event") return "event";
  return null;
}

function entityContentWordCount(entity) {
  return (Array.isArray(entity?.bodySections) ? entity.bodySections : [])
    .flatMap((section) =>
      Array.isArray(section?.paragraphs) ? section.paragraphs : [],
    )
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;
}

function normalizedWikipediaEntityIdentity(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (!["en.wikipedia.org", "www.en.wikipedia.org"].includes(parsed.hostname.toLowerCase())) {
      return "";
    }
    const title = decodeURIComponent(
      parsed.pathname.match(/^\/wiki\/([^/]+)/)?.[1] || "",
    )
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    return title && !title.includes(":") ? `enwiki:${title}` : "";
  } catch {
    return "";
  }
}

function evergreenHistoryYearLabel(content) {
  const year = deriveHistoricalYear(content);
  return Number.isInteger(year) && year > 0 ? String(year) : "";
}

function evergreenHistorySubjectSlug(entity) {
  const sourceTitle =
    String(entity?.resolvedPageTitle || "").trim() ||
    wikiTitleFromUrl(entity?.wikiUrl) ||
    String(entity?.name || "").trim();
  return entitySlug(
    sourceTitle
      .replace(/\s*\([^)]*\)\s*$/g, "")
      .replace(/\b(?:begins?|erupts?|starts?|occurs?|takes place)\b$/i, "")
      .trim(),
  );
}

function buildEvergreenHistorySlug(entity, content) {
  const titleYear = String(
    entity?.resolvedPageTitle || wikiTitleFromUrl(entity?.wikiUrl) || "",
  ).match(/\b(\d{3,4})\b/)?.[1] || "";
  const year = titleYear || evergreenHistoryYearLabel(content);
  const subject = evergreenHistorySubjectSlug(entity);
  if (!subject || !year) return "";
  return subject.endsWith(`-${year}`) ? subject : `${subject}-${year}`;
}

function verifiedEvergreenHistorySources(content) {
  return sourcePagesFromContent(content)
    .filter((page) => {
      if (!isDirectCitationUrl(page.pageUrl)) return false;
      try {
        return (
          new URL(page.pageUrl).hostname.toLowerCase().endsWith("wikipedia.org") ||
          page.verifiedIndependent === true
        );
      } catch {
        return false;
      }
    })
    .slice(0, 6);
}

function evergreenHistorySourceLinks(content) {
  return verifiedEvergreenHistorySources(content).map((page) => ({
    label:
      String(page.pageTitle || "").replace(/\s+/g, " ").trim() ||
      page.publisher ||
      sourcePublisherName(page.pageUrl),
    url: page.pageUrl,
    publisher: page.publisher || sourcePublisherName(page.pageUrl),
    ...(page.verifiedIndependent === true
      ? { verifiedIndependent: true }
      : {}),
  }));
}

function evergreenHistoryEvidenceParagraphs(content) {
  const paragraphs = [
    ...(Array.isArray(content?.overviewParagraphs)
      ? content.overviewParagraphs
      : []),
    ...(Array.isArray(content?.eyewitnessOrChronicle)
      ? content.eyewitnessOrChronicle
      : []),
    ...(Array.isArray(content?.aftermathParagraphs)
      ? content.aftermathParagraphs
      : []),
    ...(Array.isArray(content?.conclusionParagraphs)
      ? content.conclusionParagraphs
      : []),
    ...(Array.isArray(content?.analysisGood)
      ? content.analysisGood.map((item) => item?.detail)
      : []),
    ...(Array.isArray(content?.analysisBad)
      ? content.analysisBad.map((item) => item?.detail)
      : []),
  ]
    .map((paragraph) =>
      String(paragraph || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    )
    .filter((paragraph) => paragraph.length >= 80);
  return [...new Set(paragraphs)].slice(0, 18);
}

function buildEvergreenHistoryEvidence(entity, content) {
  const articleParagraphs = evergreenHistoryEvidenceParagraphs(content);
  const sourcePages = verifiedEvergreenHistorySources(content).map((page) => ({
    pageTitle: page.pageTitle,
    pageUrl: page.pageUrl,
    publisher: page.publisher || sourcePublisherName(page.pageUrl),
    ...(page.verifiedIndependent === true
      ? { verifiedIndependent: true }
      : {}),
    ...(Array.isArray(page.supportedClaims) && page.supportedClaims.length > 0
      ? { supportedClaims: page.supportedClaims.slice(0, 3) }
      : {}),
    ...((page.extract || page.text)
      ? { extract: truncateSourceExtract(page.extract || page.text, 3200) }
      : {}),
  }));
  return {
    articleTitle: publicArticleTitle(content),
    factualTitle: content.title || "",
    eventTitle: content.eventTitle || entity.name || "",
    historicalDate: content.historicalDate || "",
    historicalYear: deriveHistoricalYear(content),
    location: content.location || "",
    articleDescription: content.description || "",
    articleRationale: content.contentRationale || "",
    articleParagraphs,
    sourcePages,
  };
}

function evergreenHistoryEvidenceWordCount(evidence) {
  return [
    ...(Array.isArray(evidence?.articleParagraphs)
      ? evidence.articleParagraphs
      : []),
    ...(Array.isArray(evidence?.sourcePages)
      ? evidence.sourcePages.flatMap((page) => [
          page?.extract || "",
          ...(Array.isArray(page?.supportedClaims) ? page.supportedClaims : []),
        ])
      : []),
  ]
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;
}

function evergreenHistoryCandidateEligibility(entity, content, { primaryEvent = false } = {}) {
  const sources = verifiedEvergreenHistorySources(content);
  const hasIndependentSource = sources.some((page) => {
    try {
      return (
        page.verifiedIndependent === true &&
        !new URL(page.pageUrl).hostname.toLowerCase().endsWith("wikipedia.org")
      );
    } catch {
      return false;
    }
  });
  const evidence = buildEvergreenHistoryEvidence(entity, content);
  const slug = buildEvergreenHistorySlug(entity, content);
  const reasons = [];
  if (!primaryEvent) reasons.push("not the daily article's primary event");
  if (!hasDirectWikipediaEntitySource(entity?.wikiUrl)) {
    reasons.push("missing a direct Wikipedia identity");
  }
  if (!normalizedWikipediaEntityIdentity(entity?.wikiUrl)) {
    reasons.push("Wikipedia identity could not be normalized");
  }
  if (!slug || !/-\d{1,4}$/.test(slug)) {
    reasons.push("missing a stable subject-and-year slug");
  }
  if (sources.length < 2) reasons.push("fewer than two verified direct sources");
  if (!hasIndependentSource) reasons.push("missing an independently verified source");
  if (evergreenHistoryEvidenceWordCount(evidence) < 700) {
    reasons.push("source and article evidence is too thin");
  }
  return {
    ok: reasons.length === 0,
    reasons,
    slug,
    evidence,
    sourceLinks: evergreenHistorySourceLinks(content),
    canonicalIdentity: normalizedWikipediaEntityIdentity(entity?.wikiUrl),
  };
}

function evergreenHistoryVisibleValues(entity) {
  return [
    entity?.pageHeading,
    entity?.seoTitle,
    entity?.description,
    entity?.summary,
    ...(Array.isArray(entity?.overviewCards)
      ? entity.overviewCards.flatMap((card) => [card?.label, card?.value])
      : []),
    ...(Array.isArray(entity?.bodySections)
      ? entity.bodySections.flatMap((section) => [
          section?.heading,
          ...(Array.isArray(section?.paragraphs) ? section.paragraphs : []),
        ])
      : []),
    ...(Array.isArray(entity?.timeline)
      ? entity.timeline.flatMap((item) => [item?.date, item?.label])
      : []),
  ]
    .map((value) => String(value || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function hasCopiedEvergreenHistoryPhrase(entity, phraseWords = 12) {
  const normalizeWords = (value) =>
    normalizeTopicMatchText(value).split(/\s+/).filter(Boolean);
  const evidenceParagraphs =
    Array.isArray(entity?.evergreenEvidence?.articleParagraphs)
      ? entity.evergreenEvidence.articleParagraphs
      : [];
  const evidencePhrases = new Set();
  for (const paragraph of evidenceParagraphs) {
    const tokens = normalizeWords(paragraph);
    for (let index = 0; index <= tokens.length - phraseWords; index += 1) {
      evidencePhrases.add(tokens.slice(index, index + phraseWords).join(" "));
    }
  }
  if (!evidencePhrases.size) return false;
  return (Array.isArray(entity?.bodySections)
    ? entity.bodySections
    : [])
    .flatMap((section) =>
      Array.isArray(section?.paragraphs) ? section.paragraphs : [],
    )
    .some((paragraph) => {
      const tokens = normalizeWords(paragraph);
      for (let index = 0; index <= tokens.length - phraseWords; index += 1) {
        if (
          evidencePhrases.has(
            tokens.slice(index, index + phraseWords).join(" "),
          )
        ) {
          return true;
        }
      }
      return false;
    });
}

function evergreenHistoryEditionQuality(entity) {
  const reasons = [];
  const sections = Array.isArray(entity?.bodySections)
    ? entity.bodySections
    : [];
  const cards = Array.isArray(entity?.overviewCards)
    ? entity.overviewCards.filter((card) => card?.label && card?.value)
    : [];
  const timeline = Array.isArray(entity?.timeline)
    ? entity.timeline.filter((item) => item?.date && item?.label)
    : [];
  const sources = Array.isArray(entity?.sourceLinks)
    ? entity.sourceLinks.filter((source) =>
        source?.label && isDirectCitationUrl(source?.url),
      )
    : [];
  const independentSources = sources.filter((source) => {
    try {
      return (
        source.verifiedIndependent === true &&
        !new URL(source.url).hostname.toLowerCase().endsWith("wikipedia.org")
      );
    } catch {
      return false;
    }
  });
  const bodyWords = entityContentWordCount(entity);
  const copiedPhrase = hasCopiedEvergreenHistoryPhrase(entity);

  if (entity?.evergreenHistoryVersion !== EVERGREEN_HISTORY_EDITION_VERSION) {
    reasons.push("missing the current evergreen edition marker");
  }
  if (!/-\d{1,4}$/.test(String(entity?.slug || ""))) {
    reasons.push("URL slug does not end in a historical year");
  }
  if (!normalizedWikipediaEntityIdentity(entity?.wikiUrl)) {
    reasons.push("missing a normalized Wikipedia identity");
  }
  if (!/^(?:how|why|what|who|which|where)\b.*\?$/i.test(String(entity?.pageHeading || "").trim())) {
    reasons.push("page heading is not a focused reader question");
  }
  if (
    normalizeTopicMatchText(entity?.pageHeading) ===
    normalizeTopicMatchText(entity?.evergreenEvidence?.articleTitle)
  ) {
    reasons.push("evergreen heading duplicates the daily article title");
  }
  if (String(entity?.description || "").trim().length < 90) {
    reasons.push("preview description is too thin");
  }
  if (cards.length < 5) reasons.push("fewer than five overview cards");
  if (
    sections.length < 4 ||
    sections.some((section) =>
      !section?.heading ||
      !Array.isArray(section.paragraphs) ||
      section.paragraphs.length < 2 ||
      section.paragraphs.some((paragraph) =>
        String(paragraph || "").split(/\s+/).filter(Boolean).length < 55,
      ),
    )
  ) {
    reasons.push("needs four substantive multi-paragraph sections");
  }
  if (bodyWords < MIN_EVERGREEN_HISTORY_BODY_WORDS) {
    reasons.push(`body has ${bodyWords} words; needs ${MIN_EVERGREEN_HISTORY_BODY_WORDS}`);
  }
  if (timeline.length < 5) reasons.push("fewer than five grounded timeline entries");
  if (sources.length < 2) reasons.push("fewer than two direct sources");
  if (independentSources.length < 1) reasons.push("missing an independent source");
  if (copiedPhrase) {
    reasons.push("copies a long phrase from the daily article");
  }
  if (evergreenHistoryVisibleValues(entity).some((value) => rawUrlsInVisibleText(value).length > 0)) {
    reasons.push("contains a raw URL in visible prose");
  }
  return { ok: reasons.length === 0, reasons, bodyWords };
}

function hasDirectWikipediaEntitySource(value) {
  try {
    const url = new URL(String(value || ""));
    return (
      ["en.wikipedia.org", "www.en.wikipedia.org"].includes(url.hostname.toLowerCase()) &&
      /^\/wiki\/[^/]+/.test(url.pathname) &&
      !/:/.test(decodeURIComponent(url.pathname.slice("/wiki/".length)))
    );
  } catch {
    return false;
  }
}

function isHistoryEntityDiscoveryLinkEligible(entity) {
  if (!entity || entity.type !== "event") return false;
  const name = String(entity.name || "").replace(/\s+/g, " ").trim();
  const slug = String(entity.slug || "").trim();
  if (
    !entity.url ||
    !String(entity.url).startsWith("/history/") ||
    !hasDirectWikipediaEntitySource(entity.wikiUrl) ||
    !name ||
    name.length > 96 ||
    /^article-\d+$/i.test(slug) ||
    /(?:^|-)(?:launch-?){2,}(?:-|$)/i.test(slug)
  ) {
    return false;
  }
  if (
    entity.historyQualityGateVersion === BLOG_HISTORY_QUALITY_GATE_VERSION
  ) {
    if (
      entity.historyCardQualified === true &&
      entity.historyLinkEligible === true &&
      entity.evergreenHistoryVersion === EVERGREEN_HISTORY_EDITION_VERSION
    ) {
      return true;
    }
    return evergreenHistoryEditionQuality(entity).ok;
  }
  if (entity.historyLinkEligible === true) return true;
  if (entity.historyLinkEligible === false) return false;
  return entityContentWordCount(entity) >= 300;
}

function blogEntityQualityEligible(entity) {
  if (!entity || entity.needsWikiRefresh) return false;
  if (entity.type === "person") {
    return (
      entityContentWordCount(entity) >= 150 &&
      hasDirectWikipediaEntitySource(entity.wikiUrl) &&
      hasVerifiedPersonProfileIdentity(entity)
    );
  }
  return isHistoryEntityDiscoveryLinkEligible(entity);
}

function wikiTitleFromUrl(wikiUrl) {
  try {
    const parsed = new URL(wikiUrl);
    const title = parsed.pathname.split("/wiki/")[1];
    return title ? decodeURIComponent(title.split("#")[0]).replace(/_/g, " ") : "";
  } catch {
    return "";
  }
}

function wikiUrlFromTitle(pageTitle) {
  const title = String(pageTitle || "").replace(/\s+/g, " ").trim();
  return title
    ? `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`
    : "";
}

function normalizeSourcePage(page) {
  if (!page || typeof page !== "object") return null;
  const rawUrl =
    page.pageUrl ||
    page.url ||
    page.wikiUrl ||
    page.content_urls?.desktop?.page ||
    page.content_urls?.mobile?.page ||
    "";
  const rawTitle =
    page.pageTitle ||
    page.titles?.normalized ||
    page.normalizedtitle ||
    page.title ||
    page.titles?.canonical ||
    wikiTitleFromUrl(rawUrl) ||
    "";
  const pageTitle = String(rawTitle || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const pageUrl = String(rawUrl || wikiUrlFromTitle(pageTitle)).trim();
  if (!pageTitle && !pageUrl) return null;
  const extract = String(page.extract || page.sourceExtract || page.summary || "")
    .replace(/\s+/g, " ")
    .trim();
  const text = String(page.text || page.sourceText || "")
    .replace(/\s+/g, " ")
    .trim();
  const description = String(page.description || "").replace(/\s+/g, " ").trim();
  const imageUrl = String(
    page.imageUrl ||
    page.originalimage?.source ||
    page.thumbnail?.source ||
    "",
  ).trim();
  const publisher = String(
    page.publisher || page.siteName || sourcePublisherName(pageUrl),
  ).replace(/\s+/g, " ").trim();
  const accessedAt = String(
    page.accessedAt || page.accessDate || page.dateAccessed || "",
  ).trim();
  const supportedClaims = (Array.isArray(page.supportedClaims)
    ? page.supportedClaims
    : [page.supportedClaim || page.claim || ""]
  )
    .map((claim) => String(claim || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 6);
  const verifiedIndependent = page.verifiedIndependent === true;
  const verificationMethod = String(page.verificationMethod || "")
    .replace(/\s+/g, " ")
    .trim();
  return {
    pageTitle: pageTitle || wikiTitleFromUrl(pageUrl),
    pageUrl,
    ...(publisher ? { publisher } : {}),
    ...(accessedAt ? { accessedAt } : {}),
    ...(supportedClaims.length > 0 ? { supportedClaims } : {}),
    ...(verifiedIndependent ? { verifiedIndependent: true } : {}),
    ...(verificationMethod ? { verificationMethod } : {}),
    ...(extract ? { extract } : {}),
    ...(text ? { text } : {}),
    ...(description ? { description } : {}),
    ...(imageUrl ? { imageUrl } : {}),
  };
}

function normalizeSourcePages(pages) {
  const normalized = [];
  const seen = new Set();
  for (const page of Array.isArray(pages) ? pages : []) {
    const sourcePage = normalizeSourcePage(page);
    if (!sourcePage) continue;
    const key = normalizeTopicMatchText(sourcePage.pageUrl || sourcePage.pageTitle);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(sourcePage);
  }
  return normalized;
}

function truncateSourceExtract(value, maxChars = 9000) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  const prefix = text.slice(0, maxChars);
  const sentenceEnd = Math.max(
    prefix.lastIndexOf(". "),
    prefix.lastIndexOf("? "),
    prefix.lastIndexOf("! "),
  );
  return sentenceEnd >= Math.floor(maxChars * 0.65)
    ? prefix.slice(0, sentenceEnd + 1).trim()
    : prefix.replace(/\s+\S*$/, "").trim();
}

const WIKIPEDIA_REFERENCE_DISCOVERY_TIMEOUT_MS = 5_000;
const INDEPENDENT_REFERENCE_DOCUMENT_TIMEOUT_MS = 5_000;
const INDEPENDENT_SOURCE_CANDIDATE_BUDGET_MS = 12_000;
const WIKIPEDIA_SOURCE_EXPANSION_TIMEOUT_MS = 6_000;

function sourceFetchTimeoutMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(1, Math.floor(parsed))
    : fallback;
}

async function withSourceFetchTimeout(task, timeoutMs, label = "Source fetch") {
  const durationMs = sourceFetchTimeoutMs(timeoutMs, 5_000);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`${label} timed out after ${durationMs}ms`));
  }, durationMs);
  try {
    return await task(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(`${label} timed out after ${durationMs}ms`);
      timeoutError.name = "TimeoutError";
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchExpandedWikipediaSourcePage(
  page,
  maxChars = 9000,
  fetchImpl = fetch,
  options = {},
) {
  const normalized = normalizeSourcePage(page);
  if (!normalized) return null;
  const pageTitle = wikiTitleFromUrl(normalized.pageUrl) || normalized.pageTitle;
  if (!pageTitle) return normalized;
  const url =
    "https://en.wikipedia.org/w/api.php?action=query&redirects=1&prop=extracts&explaintext=1&exsectionformat=plain&format=json&origin=*&titles=" +
    encodeURIComponent(pageTitle);
  try {
    const timeoutMs = sourceFetchTimeoutMs(
      options?.timeoutMs,
      WIKIPEDIA_SOURCE_EXPANSION_TIMEOUT_MS,
    );
    return await withSourceFetchTimeout(async (signal) => {
      const response = await fetchImpl(url, {
        headers: { "User-Agent": WIKIPEDIA_USER_AGENT },
        signal,
      });
      if (!response.ok) return normalized;
      const data = await response.json();
      const resultPage = Object.values(data?.query?.pages || {})[0];
      if (!resultPage || resultPage.missing !== undefined) return normalized;
      const expandedExtract = truncateSourceExtract(resultPage.extract, maxChars);
      const currentWords = String(normalized.extract || "").split(/\s+/).filter(Boolean).length;
      const expandedWords = expandedExtract.split(/\s+/).filter(Boolean).length;
      if (expandedWords <= currentWords) return normalized;
      const resolvedTitle = String(resultPage.title || normalized.pageTitle).trim();
      return {
        ...normalized,
        pageTitle: resolvedTitle,
        pageUrl: wikiUrlFromTitle(resolvedTitle) || normalized.pageUrl,
        extract: expandedExtract,
      };
    }, timeoutMs, `Wikipedia source expansion for ${pageTitle}`);
  } catch (err) {
    console.warn(`Wikipedia source expansion failed for ${pageTitle}: ${err.message}`);
    return normalized;
  }
}

const INDEPENDENT_REFERENCE_FETCH_LIMIT = 4;
const SOURCE_READY_EVENT_CANDIDATE_LIMIT = 3;
const BLOCKED_REFERENCE_HOSTS = new Set([
  "amazon.com",
  "books.google.com",
  "creativecommons.org",
  "facebook.com",
  "goodreads.com",
  "imdb.com",
  "instagram.com",
  "linkedin.com",
  "pinterest.com",
  "tiktok.com",
  "twitter.com",
  "web.archive.org",
  "x.com",
  "youtube.com",
]);

function canonicalIndependentReferenceUrl(value) {
  let raw = String(value || "").replace(/&amp;/g, "&").trim();
  try {
    const archive = new URL(raw);
    if (archive.hostname.toLowerCase() === "web.archive.org") {
      const archivedTarget = archive.pathname.match(/^\/web\/[^/]+\/(https?:\/\/.*)$/i)?.[1];
      if (archivedTarget) raw = decodeURIComponent(archivedTarget);
    }
  } catch {
    return "";
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  if (parsed.protocol === "http:") parsed.protocol = "https:";
  if (parsed.protocol !== "https:") return "";
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(?:utm_|fbclid$|gclid$|mc_)/i.test(key)) parsed.searchParams.delete(key);
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (
    !isPublicCitationHostname(hostname) ||
    [...BLOCKED_REFERENCE_HOSTS].some(
      (blockedHost) => hostname === blockedHost || hostname.endsWith(`.${blockedHost}`),
    ) ||
    hostname.endsWith("wikipedia.org") ||
    hostname.endsWith("wikimedia.org") ||
    hostname.endsWith("wikidata.org") ||
    hostname === "thisday.info" ||
    hostname.endsWith(".thisday.info")
  ) {
    return "";
  }
  if (/\.(?:avif|css|csv|docx?|gif|jpe?g|js|json|mp3|mp4|pdf|png|pptx?|svg|webp|xlsx?|xml|zip)$/i.test(parsed.pathname)) {
    return "";
  }
  return isDirectCitationUrl(parsed.toString()) ? parsed.toString() : "";
}

function independentReferenceAuthorityScore(value) {
  let hostname = "";
  try {
    hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return 0;
  }
  if (/\.gov(?:\.[a-z]{2})?$/.test(hostname) || hostname === "europa.eu") return 90;
  if (/\.(?:edu|ac)(?:\.[a-z]{2})?$/.test(hostname)) return 85;
  if (/(?:archives?|museum|library|history)\./.test(hostname)) return 75;
  if (/\.(?:museum)$/.test(hostname)) return 75;
  if (/^(?:si\.edu|loc\.gov|archives\.gov|nationalarchives\.gov\.uk|iwm\.org\.uk|ushmm\.org|nasa\.gov)$/.test(hostname)) return 80;
  if (/(?:jstor\.org|cambridge\.org|oup\.com|springer\.com|nature\.com|science\.org)$/.test(hostname)) return 70;
  if (/(?:reuters\.com|apnews\.com|bbc\.(?:com|co\.uk)|nytimes\.com|washingtonpost\.com|time\.com|britannica\.com)$/.test(hostname)) return 60;
  if (hostname.endsWith(".org")) return 35;
  return 20;
}

function citationLabelFromWikitext(wikitext, url) {
  const source = String(wikitext || "");
  const variants = [url, url.replace(/^https:/, "http:"), url.replace(/&/g, "&amp;")];
  let index = -1;
  for (const variant of variants) {
    index = source.indexOf(variant);
    if (index !== -1) break;
  }
  if (index === -1) return "";
  const start = Math.max(0, source.lastIndexOf("{{", index));
  const end = source.indexOf("}}", index);
  const citation = source.slice(start, end !== -1 && end - start < 1800 ? end : index + 900);
  const templateTitle = citation.match(/\|\s*title\s*=\s*([^|}\n]+)/i)?.[1];
  if (templateTitle) {
    return String(templateTitle)
      .replace(/\[\[|\]\]/g, "")
      .replace(/''+/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  const bracketStart = source.lastIndexOf("[", index);
  const bracketEnd = source.indexOf("]", index);
  if (bracketStart !== -1 && bracketEnd !== -1 && bracketEnd - bracketStart < 900) {
    const bracket = source.slice(bracketStart + 1, bracketEnd);
    const label = bracket.slice(bracket.indexOf(" ") + 1).trim();
    if (label && label !== bracket) return label.replace(/\s+/g, " ").trim();
  }
  return "";
}

async function fetchWikipediaExternalReferenceCandidates(
  selectedEvent,
  fetchImpl = fetch,
  options = {},
) {
  const pageTitle =
    wikiTitleFromUrl(selectedEvent?.wikiUrl) ||
    selectedEvent?.sourcePageTitle ||
    selectedEvent?.pageTitle ||
    "";
  if (!pageTitle) return [];
  const apiUrl =
    "https://en.wikipedia.org/w/api.php?action=parse&redirects=1&prop=externallinks%7Cwikitext&format=json&formatversion=2&origin=*&page=" +
    encodeURIComponent(pageTitle);
  let data;
  try {
    const timeoutMs = sourceFetchTimeoutMs(
      options?.timeoutMs,
      WIKIPEDIA_REFERENCE_DISCOVERY_TIMEOUT_MS,
    );
    data = await withSourceFetchTimeout(async (signal) => {
      const response = await fetchImpl(apiUrl, {
        headers: { "User-Agent": WIKIPEDIA_USER_AGENT },
        signal,
      });
      if (!response?.ok) return null;
      return response.json().catch(() => null);
    }, timeoutMs, `Wikipedia reference discovery for ${pageTitle}`);
  } catch (err) {
    console.warn(`Independent citation discovery failed for ${pageTitle}: ${err.message}`);
    return [];
  }
  const links = Array.isArray(data?.parse?.externallinks) ? data.parse.externallinks : [];
  const wikitext = String(data?.parse?.wikitext || "");
  const evidence = [
    selectedEvent?.eventTitle,
    selectedEvent?.sourcePageTitle,
    selectedEvent?.sourceText,
  ].join(" ");
  const evidenceTokens = new Set(sourcePageRelevanceTokens(evidence));
  const seenUrls = new Set();
  const perHost = new Map();
  const candidates = [];
  for (const link of links) {
    const pageUrl = canonicalIndependentReferenceUrl(link);
    if (!pageUrl || seenUrls.has(pageUrl)) continue;
    const hostname = new URL(pageUrl).hostname.toLowerCase().replace(/^www\./, "");
    const hostCount = perHost.get(hostname) || 0;
    if (hostCount >= 2) continue;
    const citationTitle = citationLabelFromWikitext(wikitext, pageUrl);
    const referenceTokens = sourcePageRelevanceTokens(`${pageUrl} ${citationTitle}`);
    const overlap = referenceTokens.filter((token) => evidenceTokens.has(token));
    candidates.push({
      pageUrl,
      citationTitle,
      score: independentReferenceAuthorityScore(pageUrl) + overlap.length * 12,
    });
    seenUrls.add(pageUrl);
    perHost.set(hostname, hostCount + 1);
  }
  return candidates.sort((a, b) => b.score - a.score);
}

function decodeSourceDocumentText(value) {
  return String(value || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function verifyIndependentSourceDocument(selectedEvent, candidate, html, finalUrl) {
  const pageUrl = canonicalIndependentReferenceUrl(finalUrl || candidate?.pageUrl);
  if (!pageUrl) return null;
  const titleHtml =
    String(html || "").match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)/i)?.[1] ||
    String(html || "").match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ||
    candidate?.citationTitle ||
    "";
  const pageTitle = decodeSourceDocumentText(titleHtml).replace(/\s+[|–—-]\s+[^|–—-]{1,50}$/, "").trim();
  const documentText = decodeSourceDocumentText(html).slice(0, 120000);
  if (documentText.length < 300) return null;

  const eventEvidence = [
    selectedEvent?.eventTitle,
    selectedEvent?.sourcePageTitle,
    selectedEvent?.sourceText,
    String(selectedEvent?.sourceExtract || "").slice(0, 1800),
  ].join(" ");
  const eventTokens = new Set(sourcePageRelevanceTokens(eventEvidence));
  const documentTokens = new Set(sourcePageRelevanceTokens(`${pageTitle} ${documentText}`));
  const overlapTokens = [...eventTokens].filter((token) => documentTokens.has(token));
  const minimumOverlap = eventTokens.size >= 8 ? 3 : 2;
  if (overlapTokens.length < minimumOverlap) return null;

  const subjectTokens = sourceSubjectTokens({
    pageTitle: selectedEvent?.sourcePageTitle || selectedEvent?.pageTitle || "",
    text: selectedEvent?.sourceText || "",
    sourceExtract: selectedEvent?.sourceExtract || "",
  });
  if (
    subjectTokens.length > 0 &&
    !subjectTokens.some((token) => documentText.toLowerCase().includes(token.toLowerCase()))
  ) {
    return null;
  }

  const historicalYear =
    Number.parseInt(selectedEvent?.historicalYear || selectedEvent?.year, 10) ||
    deriveHistoricalYear(selectedEvent);
  if (
    Number.isInteger(historicalYear) &&
    historicalYear >= 100 &&
    !new RegExp(`\\b0*${historicalYear}\\b`).test(documentText)
  ) {
    return null;
  }

  return normalizeSourcePage({
    pageTitle: pageTitle || candidate?.citationTitle || sourcePublisherName(pageUrl),
    pageUrl,
    publisher: sourcePublisherName(pageUrl),
    accessedAt: utcDateString(),
    supportedClaims: [String(selectedEvent?.sourceText || selectedEvent?.eventTitle || "").trim()],
    extract: truncateSourceExtract(documentText, 6000),
    verifiedIndependent: true,
    verificationMethod: "wikipedia-reference-http-subject-year-token-match-v1",
  });
}

async function discoverIndependentCitation(selectedEvent, fetchImpl = fetch, options = {}) {
  const existing = normalizeSourcePages(selectedEvent?.sourcePages || []).find(
    (page) => page.verifiedIndependent === true && isDirectCitationUrl(page.pageUrl),
  );
  if (existing) return existing;
  const candidateBudgetMs = sourceFetchTimeoutMs(
    options?.candidateBudgetMs,
    INDEPENDENT_SOURCE_CANDIDATE_BUDGET_MS,
  );
  const deadline = Date.now() + candidateBudgetMs;
  const referenceListTimeoutMs = Math.min(
    sourceFetchTimeoutMs(
      options?.referenceListTimeoutMs,
      WIKIPEDIA_REFERENCE_DISCOVERY_TIMEOUT_MS,
    ),
    candidateBudgetMs,
  );
  const candidates = await fetchWikipediaExternalReferenceCandidates(
    selectedEvent,
    fetchImpl,
    { timeoutMs: referenceListTimeoutMs },
  );
  for (const candidate of candidates.slice(0, INDEPENDENT_REFERENCE_FETCH_LIMIT)) {
    const remainingBudgetMs = deadline - Date.now();
    if (remainingBudgetMs <= 0) {
      console.warn(
        `Independent citation discovery budget exhausted for ${selectedEvent?.sourcePageTitle || selectedEvent?.eventTitle || "event"}`,
      );
      break;
    }
    try {
      const timeoutMs = Math.min(
        sourceFetchTimeoutMs(
          options?.documentTimeoutMs,
          INDEPENDENT_REFERENCE_DOCUMENT_TIMEOUT_MS,
        ),
        remainingBudgetMs,
      );
      const verified = await withSourceFetchTimeout(async (signal) => {
        const response = await fetchImpl(candidate.pageUrl, {
          redirect: "follow",
          headers: {
            "User-Agent": WIKIPEDIA_USER_AGENT,
            Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
            Range: "bytes=0-131071",
          },
          signal,
        });
        if (!response?.ok) return null;
        const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
        if (contentType && !/(?:text\/html|application\/xhtml\+xml|text\/plain)/.test(contentType)) {
          return null;
        }
        const contentLength = Number.parseInt(response.headers?.get?.("content-length"), 10);
        if (Number.isFinite(contentLength) && contentLength > 3_000_000) return null;
        const html = String(await response.text()).slice(0, 140000);
        return verifyIndependentSourceDocument(
          selectedEvent,
          candidate,
          html,
          response.url || candidate.pageUrl,
        );
      }, timeoutMs, `Independent citation candidate ${candidate.pageUrl}`);
      if (verified) return verified;
    } catch (err) {
      console.warn(`Independent citation candidate failed (${candidate.pageUrl}): ${err.message}`);
    }
  }
  return null;
}

async function selectSourceReadyCandidate(candidates, fetchImpl = fetch, options = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  for (const candidate of list.slice(0, SOURCE_READY_EVENT_CANDIDATE_LIMIT)) {
    const selectedEvent = {
      ...candidate,
      eventTitle: eventTitleFromCandidate(candidate.pageTitle, candidate),
      historicalYear: Number.parseInt(candidate.year, 10),
      sourcePageTitle: candidate.pageTitle,
      sourceText: candidate.text,
      sourceExtract: candidate.extract,
      wikiUrl: candidate.pageUrl,
      sourcePages: candidate.sourcePages || [],
    };
    const citation = await discoverIndependentCitation(selectedEvent, fetchImpl, options);
    if (!citation) continue;
    return {
      ...candidate,
      sourcePages: normalizeSourcePages([...(candidate.sourcePages || []), citation]),
    };
  }
  return null;
}

async function expandSelectedEventSourcePages(selectedEvent, fetchImpl = fetch, options = {}) {
  if (!selectedEvent) return selectedEvent;
  const sourcePages = normalizeSourcePages(selectedEvent.sourcePages || []);
  if (!sourcePages.length) return selectedEvent;
  const wikipediaPages = sourcePages.filter((page) => {
    try {
      return new URL(page.pageUrl).hostname.toLowerCase().endsWith("wikipedia.org");
    } catch {
      return false;
    }
  });
  const expanded = await Promise.all(
    wikipediaPages.slice(0, 2).map((page) =>
      fetchExpandedWikipediaSourcePage(page, 9000, fetchImpl, {
        timeoutMs: options?.wikipediaExpansionTimeoutMs,
      }),
    ),
  );
  const merged = normalizeSourcePages([
    ...expanded.filter(Boolean),
    ...sourcePages,
  ]);
  selectedEvent.sourcePages = merged;
  const primary =
    selectPrimarySourcePage(selectedEvent.sourceText || selectedEvent.text, wikipediaPages) ||
    wikipediaPages[0];
  if (primary) {
    selectedEvent.sourcePageTitle = primary.pageTitle || selectedEvent.sourcePageTitle;
    selectedEvent.sourceExtract = primary.extract || selectedEvent.sourceExtract;
    selectedEvent.wikiUrl = primary.pageUrl || selectedEvent.wikiUrl;
  }
  return selectedEvent;
}

function sourcePagesFromContent(content) {
  const pages = [];
  if (Array.isArray(content?.citations)) pages.push(...content.citations);
  if (Array.isArray(content?.sources)) pages.push(...content.sources);
  if (Array.isArray(content?.sourcePages)) pages.push(...content.sourcePages);
  if (content?.sourcePageTitle || content?.sourceText || content?.sourceExtract) {
    pages.push({
      pageTitle: content.sourcePageTitle,
      pageUrl: content.wikiUrl || content.jsonLdUrl || "",
      text: content.sourceText || "",
      extract: content.sourceExtract || content.wikiExtract || "",
    });
  }
  if (content?.wikiUrl || content?.jsonLdUrl) {
    pages.push({
      pageTitle: wikiTitleFromUrl(content.wikiUrl || content.jsonLdUrl),
      pageUrl: content.wikiUrl || content.jsonLdUrl,
    });
  }
  return normalizeSourcePages(pages);
}

function attachSelectedEventSourcePages(content, selectedEvent) {
  if (!content || !selectedEvent) return content;
  const accessedAt = utcDateString();
  const sourcePages = normalizeSourcePages(
    selectedEvent.sourcePages?.length
      ? selectedEvent.sourcePages
      : [{
          pageTitle: selectedEvent.sourcePageTitle,
          pageUrl: selectedEvent.wikiUrl,
          text: selectedEvent.sourceText,
          extract: selectedEvent.sourceExtract,
        }],
  ).map((page, index) => ({
    ...page,
    publisher: page.publisher || sourcePublisherName(page.pageUrl),
    accessedAt: page.accessedAt || accessedAt,
    ...(index === 0 && selectedEvent.sourceText
      ? { supportedClaims: [String(selectedEvent.sourceText).replace(/\s+/g, " ").trim().slice(0, 500)] }
      : {}),
  }));
  if (sourcePages.length > 0) content.sourcePages = sourcePages;
  if (selectedEvent.sourcePageTitle) content.sourcePageTitle = selectedEvent.sourcePageTitle;
  if (selectedEvent.sourceText) content.sourceText = selectedEvent.sourceText;
  if (selectedEvent.sourceExtract) content.sourceExtract = selectedEvent.sourceExtract;
  if (selectedEvent.wikiUrl) {
    // The selected feed page is authoritative. Never preserve an AI-supplied
    // placeholder, search URL, or different page over this exact source URL.
    content.wikiUrl = selectedEvent.wikiUrl;
    content.jsonLdUrl = selectedEvent.wikiUrl;
  }
  return content;
}

function compactSourcePagesForIndex(content) {
  return sourcePagesFromContent(content)
    .slice(0, 6)
    .map((page) => ({
      pageTitle: page.pageTitle,
      pageUrl: page.pageUrl,
      ...(page.publisher ? { publisher: page.publisher } : {}),
      ...(page.accessedAt ? { accessedAt: page.accessedAt } : {}),
      ...(Array.isArray(page.supportedClaims) && page.supportedClaims.length > 0
        ? { supportedClaims: page.supportedClaims.slice(0, 3) }
        : {}),
      ...(page.verifiedIndependent === true ? { verifiedIndependent: true } : {}),
      ...(page.verificationMethod ? { verificationMethod: page.verificationMethod } : {}),
    }))
    .filter((page) => page.pageTitle || page.pageUrl);
}

function extractSourcePagesFromHtml(html) {
  const source = String(html || "");
  const pages = [];
  const urlRe = /https:(?:\\\/\\\/|\/\/)en\.wikipedia\.org(?:\\\/|\/)wiki(?:\\\/|\/)[^"'<>\s)]+/g;
  let match;
  while ((match = urlRe.exec(source)) !== null) {
    const pageUrl = String(match[0] || "")
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&");
    pages.push({ pageUrl, pageTitle: wikiTitleFromUrl(pageUrl) });
  }
  return normalizeSourcePages(pages);
}

function sourceEventPageMatchesPerson(term, page) {
  const personName = stripPersonHonorifics(term?.term || term?.name || "");
  const nameTokens = normalizeTopicMatchText(personName)
    .split(" ")
    .filter((token) => token.length > 1 && !PERSON_NAME_HONORIFIC_TOKENS.has(token));
  if (nameTokens.length < 2) return false;

  const pageTitle = String(page?.pageTitle || wikiTitleFromUrl(page?.pageUrl) || "")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedTitle = normalizeTopicMatchText(pageTitle);
  if (!normalizedTitle) return false;
  const titleTokens = normalizedTitle.split(" ").filter(Boolean);
  if (!nameTokens.every((token) => titleTokens.includes(token))) return false;

  // A plain page titled exactly "Bill Stewart" is the disambiguation problem, not
  // the fallback. The fallback must be a real source-event page such as
  // "Murder of Bill Stewart" with an event noun around the person's full name.
  const extraTokens = titleTokens.filter(
    (token) => !nameTokens.includes(token) && !SOURCE_EVENT_TITLE_STOPWORDS.has(token),
  );
  if (extraTokens.length === 0) return false;
  if (!SOURCE_EVENT_PERSON_PAGE_RE.test(pageTitle)) return false;

  const corpus = normalizeTopicMatchText(
    `${pageTitle} ${page?.text || ""} ${page?.extract || ""}`,
  );
  return nameTokens.every((token) => corpus.includes(token));
}

async function fetchSourceEventPageEntityFallback(term, sourcePages) {
  if (normalizeEntityType(term?.type) !== "person") return null;
  const pages = normalizeSourcePages(sourcePages);
  for (const page of pages) {
    if (!sourceEventPageMatchesPerson(term, page)) continue;
    const pageUrl = page.pageUrl || wikiUrlFromTitle(page.pageTitle);
    const wikiData = await fetchWikipediaEntityData(
      { ...term, term: page.pageTitle || term.term, wikiUrl: pageUrl },
      { retryOnEmpty: false, sourcePages: [] },
    ).catch(() => ({}));
    if (wikiData.isDisambiguation) continue;
    const intro = wikiData.intro || wikiData.summary || page.extract || page.text || "";
    const summary = wikiData.summary || page.extract || page.text || "";
    if (!intro && !summary && !wikiData.imageUrl && !page.imageUrl) continue;
    return {
      ...wikiData,
      intro,
      summary,
      description: wikiData.description || page.description || "",
      imageUrl: wikiData.imageUrl || page.imageUrl || "",
      pageTitle: wikiData.pageTitle || page.pageTitle,
      resolvedPageTitle: wikiData.resolvedPageTitle || page.pageTitle || wikiTitleFromUrl(pageUrl),
      wikiUrl: wikiData.wikiUrl || pageUrl,
      isDisambiguation: false,
      sourceEventPageFallback: true,
    };
  }
  return null;
}

function formatWikiDate(claim) {
  const raw = claim?.mainsnak?.datavalue?.value?.time;
  if (!raw) return "";
  const match = raw.match(/^[+-](\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "";
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

async function fetchWikidataPersonFacts(pageTitle) {
  if (!pageTitle) return {};
  const url =
    "https://en.wikipedia.org/w/api.php?action=query&redirects=1&prop=pageprops&ppprop=wikibase_item&format=json&origin=*&titles=" +
    encodeURIComponent(pageTitle);
  const res = await fetch(url, { headers: { "User-Agent": WIKIPEDIA_USER_AGENT } });
  if (!res.ok) return {};
  const data = await res.json();
  const page = Object.values(data?.query?.pages || {})[0];
  const qid = page?.pageprops?.wikibase_item;
  if (!qid) return {};

  const entityUrl =
    "https://www.wikidata.org/wiki/Special:EntityData/" +
    encodeURIComponent(qid) +
    ".json";
  const entityRes = await fetch(entityUrl, {
    headers: { "User-Agent": WIKIPEDIA_USER_AGENT },
  });
  if (!entityRes.ok) return {};
  const entityData = await entityRes.json();
  const claims = entityData?.entities?.[qid]?.claims || {};
  const instanceOfHuman = (Array.isArray(claims.P31) ? claims.P31 : [])
    .some(
      (claim) =>
        claim?.mainsnak?.datavalue?.value?.id ===
        WIKIDATA_HUMAN_ENTITY_ID,
    );
  return {
    birthDate: formatWikiDate(claims.P569?.[0]),
    deathDate: formatWikiDate(claims.P570?.[0]),
    wikidataEntityId: qid,
    wikidataInstanceOfHuman: instanceOfHuman,
  };
}

async function fetchWikipediaEntityData(term, { retryOnEmpty = true, sourcePages = [] } = {}) {
  const pageTitle = wikiTitleFromUrl(term.wikiUrl) || term.term;
  if (!pageTitle) return {};
  const summaryUrl =
    "https://en.wikipedia.org/api/rest_v1/page/summary/" +
    encodeURIComponent(pageTitle);
  const introUrl =
    "https://en.wikipedia.org/w/api.php?action=query&redirects=1&prop=extracts|pageprops&ppprop=disambiguation&exintro=1&explaintext=1&format=json&origin=*&titles=" +
    encodeURIComponent(pageTitle);
  const [summaryRes, introRes, personFacts] = await Promise.all([
    fetch(summaryUrl, { headers: { "User-Agent": WIKIPEDIA_USER_AGENT } }).catch(() => null),
    fetch(introUrl, { headers: { "User-Agent": WIKIPEDIA_USER_AGENT } }).catch(() => null),
    normalizeEntityType(term.type) === "person"
      ? fetchWikidataPersonFacts(pageTitle).catch(() => ({}))
      : Promise.resolve({}),
  ]);
  let summary = {};
  if (summaryRes?.ok) summary = await summaryRes.json();
  let intro = "";
  let resolvedPageTitle = String(summary.title || "").trim();
  let isDisambiguation = summary.type === "disambiguation";
  if (introRes?.ok) {
    const introData = await introRes.json();
    const introPage = Object.values(introData?.query?.pages || {})[0];
    intro = introPage?.extract || "";
    resolvedPageTitle = resolvedPageTitle || String(introPage?.title || "").trim();
    isDisambiguation =
      isDisambiguation ||
      Object.prototype.hasOwnProperty.call(introPage?.pageprops || {}, "disambiguation");
  }
  const result = {
    summary: summary.extract || "",
    intro: intro || summary.extract || "",
    description: summary.description || "",
    imageUrl: summary.originalimage?.source || summary.thumbnail?.source || "",
    wikiUrl: summary.content_urls?.desktop?.page || summary.content_urls?.mobile?.page || "",
    pageTitle,
    resolvedPageTitle: resolvedPageTitle || pageTitle,
    isDisambiguation,
    ...personFacts,
  };
  if (normalizeEntityType(term.type) === "person" && result.isDisambiguation) {
    const sourceFallback = await fetchSourceEventPageEntityFallback(term, sourcePages);
    if (sourceFallback) return sourceFallback;
  }
  // Retry once when both summary and intro came back empty — transient Wikipedia timeout
  if (retryOnEmpty && !result.intro && !result.summary) {
    await new Promise((r) => setTimeout(r, 1500));
    return fetchWikipediaEntityData(term, { retryOnEmpty: false, sourcePages });
  }
  return result;
}

function compactEntityText(value, maxLength = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  const sentence = text.split(/(?<=[.!?])\s+/)[0];
  if (sentence && sentence.length <= maxLength) return sentence;
  return text.slice(0, maxLength - 3).trimEnd() + "...";
}

function entityFactSentences(...values) {
  const seen = new Set();
  return values
    .join(" ")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 30)
    .filter((sentence) => {
      const key = normalizeTopicMatchText(sentence);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function hasRichWikipediaPersonProfile(entity) {
  if (normalizeEntityType(entity?.type) !== "person" || !entity?.wikiUrl || entity?.isDisambiguation) {
    return false;
  }
  if (
    entity.sourceEventPageFallback !== true &&
    entity.wikidataInstanceOfHuman !== true
  ) {
    return false;
  }
  // Keep single-letter initials (e.g. "J.K. Rowling" → j, k, rowling) so that an
  // initialed author/person name still clears the >=2-token gate and matches the
  // canonical page "J. K. Rowling". Dropping them collapsed the name to one token
  // and rejected the subject outright (2026-06-26: Rowling rendered unlinked).
  const personTokens = normalizeTopicMatchText(entity.name || entity.term)
    .split(" ")
    .filter(Boolean);
  // Strip leading honorific/title tokens so a regnal or titled name still matches the
  // canonical biography page that omits the honorific (e.g. "Queen Elizabeth II" → the
  // Wikipedia page "Elizabeth II"). Keep at least one distinctive token.
  const coreTokens = [...personTokens];
  while (coreTokens.length > 1 && PERSON_NAME_HONORIFIC_TOKENS.has(coreTokens[0])) {
    coreTokens.shift();
  }
  const resolvedTokens = new Set(
    normalizeTopicMatchText(entity.resolvedPageTitle)
      .split(" ")
      .filter(Boolean),
  );
  const coreSet = new Set(coreTokens);
  const nameMatchesResolved =
    // Standard case: every name token appears in the resolved page title.
    coreTokens.every((token) => resolvedTokens.has(token)) ||
    // Mononym canonical titles: Wikipedia stores some figures under a single
    // distinctive name ("Napoleon" for "Napoleon Bonaparte", "Cleopatra",
    // "Voltaire", "Galileo"). Accept when every resolved token belongs to the
    // person's name AND the resolved title carries the person's primary token.
    (resolvedTokens.size >= 1 &&
      [...resolvedTokens].every((token) => coreSet.has(token)) &&
      resolvedTokens.has(coreTokens[0]));
  if (personTokens.length < 2 || !nameMatchesResolved) {
    return false;
  }
  const sourceText = String(entity.intro || entity.summary || "")
    .replace(/\s+/g, " ")
    .trim();
  const wordCount = sourceText.split(/\s+/).filter(Boolean).length;
  const sentenceCount = entityFactSentences(sourceText).length;
  return (
    wordCount >= PERSON_ENTITY_MIN_SOURCE_WORDS &&
    sentenceCount >= PERSON_ENTITY_MIN_SOURCE_SENTENCES
  );
}

function hasVerifiedPersonProfileIdentity(entity) {
  return Boolean(
    entity?.profileLinkEligible === true &&
    entity?.profileSubjectVerified === true &&
    (
      entity?.sourceEventPageFallback === true ||
      entity?.wikidataInstanceOfHuman === true
    ),
  );
}

// Strip leading military/royal/academic honorific tokens from a person name so that
// "General Dwight D. Eisenhower" becomes "Dwight D. Eisenhower" for slug/lookup purposes.
function stripPersonHonorifics(name) {
  const tokens = String(name || "").trim().split(/\s+/);
  while (
    tokens.length > 1 &&
    PERSON_NAME_HONORIFIC_TOKENS.has(tokens[0].toLowerCase().replace(/[^a-z]/g, ""))
  ) {
    tokens.shift();
  }
  return tokens.join(" ");
}

function unlinkedArticlePerson(term) {
  const name = String(term?.term || term?.name || "").trim();
  const slug = entitySlug(name);
  return {
    type: "person",
    slug,
    name,
    imageUrl: "",
    url: "",
    wikiUrl: "",
    profileLinkEligible: false,
    profileSubjectVerified: false,
    ...(term?.wikidataEntityId ? { wikidataEntityId: term.wikidataEntityId } : {}),
    ...(typeof term?.wikidataInstanceOfHuman === "boolean"
      ? { wikidataInstanceOfHuman: term.wikidataInstanceOfHuman }
      : {}),
    ...(term?.isDisambiguation === true ? { isDisambiguation: true } : {}),
    skipImageRepair: true,
  };
}

function suppressPersonProfileLink(content, personName = "") {
  const target = normalizeTopicMatchText(personName);
  if (!Array.isArray(content?.keyTerms)) return;
  content.keyTerms = content.keyTerms.map((term) => {
    if (normalizeEntityType(term?.type) !== "person") return term;
    if (target && normalizeTopicMatchText(term.term) !== target) return term;
    return {
      ...term,
      wikiUrl: "",
      profileLinkEligible: false,
      profileSubjectVerified: false,
    };
  });
}

function unlinkedArticlePeople(content) {
  return (Array.isArray(content?.keyTerms) ? content.keyTerms : [])
    .filter((term) => normalizeEntityType(term?.type) === "person" && term?.term)
    .map(unlinkedArticlePerson)
    .filter((person) => person.slug && person.name);
}

function publicationReserveArticlePeople(content, slug) {
  console.warn(
    `Entity graph writes skipped for ${slug} to preserve the KV publication reserve.`,
  );
  suppressPersonProfileLink(content);
  return unlinkedArticlePeople(content);
}

function findEntityFact(sentences, patterns, fallback = "") {
  const found = sentences.find((sentence) =>
    patterns.some((pattern) => pattern.test(sentence)),
  );
  return compactEntityText(found || fallback, 220);
}

function findDistinctEntityFact(sentences, patterns, usedValues, fallback = "") {
  const found = sentences.find((sentence) => {
    const normalized = normalizeTopicMatchText(sentence);
    return !usedValues.has(normalized) && patterns.some((pattern) => pattern.test(sentence));
  });
  const value = compactEntityText(found || fallback, 220);
  if (value) usedValues.add(normalizeTopicMatchText(value));
  return value;
}

function inferHistoricalDateFromEntry(entry) {
  if (entry?.historicalDate) return entry.historicalDate;
  const title = String(entry?.title || "");
  const dashDate = title.match(/[—-]\s*([A-Z][a-z]+ \d{1,2}, \d{3,4})\s*$/);
  if (dashDate) return dashDate[1];
  const inlineDate = title.match(/\b([A-Z][a-z]+ \d{1,2}, \d{3,4})\b/);
  if (inlineDate) return inlineDate[1];
  if (Number.isInteger(entry?.historicalYear)) return String(entry.historicalYear);
  return "";
}

function buildPersonOverviewCards(entity) {
  const lifeDates = entity.birthDate && entity.deathDate
    ? `${entity.birthDate} – ${entity.deathDate}`
    : entity.birthDate
      ? `b. ${entity.birthDate}`
      : "";
  const factSentences = entityFactSentences(entity.intro, entity.summary);
  const summary = compactEntityText(entity.summary || entity.intro, 185);
  const description = compactEntityText(entity.description, 150);
  const usedFacts = new Set();
  const knownFor = findDistinctEntityFact(
    factSentences,
    [/primary author/i, /principal author/i, /founded/i, /invented/i, /discovered/i, /pioneered/i, /led\b/i, /proponent/i, /champion/i, /known for/i, /best known/i],
    usedFacts,
    description || summary,
  );
  const majorWork = findDistinctEntityFact(
    factSentences,
    [/served as/i, /wrote\b/i, /authored/i, /composed/i, /established/i, /military/i, /campaign/i, /founded/i, /created/i],
    usedFacts,
    summary || description,
  );
  const significance = findDistinctEntityFact(
    factSentences,
    [/proponent/i, /democracy/i, /rights/i, /philosophy/i, /legacy/i, /impact/i, /formative/i],
    usedFacts,
    summary || description,
  );
  const cards = [
    { label: "Known for", value: knownFor },
    { label: "Major work", value: majorWork },
    { label: "Significance", value: significance },
  ].filter((c) => c.value);
  if (description) cards.unshift({ label: "Main role", value: description });
  if (lifeDates) cards.unshift({ label: "Life and death", value: lifeDates });
  return cards;
}

function normalizeEntityCards(cards, fallbackCards, type) {
  const wantedLabels = type === "person"
    ? ["Life and death", "Main role", "Known for", "Major work", "Significance", "Context"]
    : ["What happened", "Date", "Location", "Key people", "Outcome", "Why it matters"];
  const source = Array.isArray(cards) ? cards : [];
  const normalized = [];
  const seenValues = new Set();

  for (const label of wantedLabels) {
    const candidate = source.find((card) => String(card?.label || "").trim().toLowerCase() === label.toLowerCase());
    const fallback = fallbackCards.find((card) => card.label === label);
    const rawValue = candidate?.value || fallback?.value || "";
    const value = compactEntityText(rawValue, 240);
    const duplicateKey = normalizeTopicMatchText(value);
    if (!value || seenValues.has(duplicateKey)) {
      normalized.push(fallback);
      if (fallback?.value) seenValues.add(normalizeTopicMatchText(fallback.value));
      continue;
    }
    normalized.push({ label, value });
    seenValues.add(duplicateKey);
  }

  return normalized.filter((card) => card?.label && card?.value);
}

function entityCardsAreFilled(cards, type) {
  if (!Array.isArray(cards) || cards.length < 6) return false;
  const compactLabels = type === "event"
    ? new Set(["Date", "Location", "Key people"])
    : new Set(["Life and death"]);
  return cards.every((card) => {
    const value = String(card?.value || "").trim();
    if (!value) return false;
    if (compactLabels.has(card.label)) return value.split(/\s+/).length >= 6;
    return value.split(/\s+/).length >= 18;
  });
}

function expandedEntityCardValue(label, currentValue, entity, content, fallbackValue) {
  const current = String(currentValue || "").trim();
  const fallback = String(fallbackValue || "").trim();
  const summary = compactEntityText(entity.summary, 220);
  const description = String(entity.description || "").replace(/\s+/g, " ").trim();
  const facts = entityFactSentences(entity.intro, entity.summary);
  const people = (content.keyTerms || [])
    .filter((term) => term.type === "person")
    .map((term) => term.term)
    .slice(0, 4)
    .join(", ");

  if (entity.type === "person") {
    if (label === "Life and death") {
      const dates = entity.birthDate && entity.deathDate
        ? `${entity.birthDate} – ${entity.deathDate}`
        : entity.birthDate ? `b. ${entity.birthDate}` : "";
      return dates || fallback || current;
    }
    if (label === "Main role") {
      return description || fallback || current || summary;
    }
    if (label === "Context") {
      return content.contentRationale || findEntityFact(facts, [/legacy/i, /impact/i, /influenced/i, /remembered/i, /shaped/i], fallback || current || summary);
    }
    if (label === "Known for") {
      return findEntityFact(facts, [/primary author/i, /founded/i, /invented/i, /discovered/i, /pioneered/i, /proponent/i, /known for/i, /best known/i], description || summary || current || fallback);
    }
    if (label === "Major work") {
      return findEntityFact(facts, [/served as/i, /wrote\b/i, /authored/i, /composed/i, /established/i, /military/i, /founded/i, /created/i], current || fallback || summary);
    }
    if (label === "Significance") {
      return findEntityFact(facts, [/proponent/i, /democracy/i, /rights/i, /philosophy/i, /legacy/i, /formative/i], fallback || current || summary);
    }
  }

  if (label === "What happened") {
    return summary || content.description || `${entity.name} is treated as the central event for this entity page, with the related article providing the narrative and source-backed context.`;
  }
  if (label === "Date") {
    return content.historicalDate || fallback || current || "Date details are sourced from the related thisDay article.";
  }
  if (label === "Location") {
    return content.location || fallback || current || "Location details are sourced from the related thisDay article when available.";
  }
  if (label === "Key people") {
    return people || fallback || current || "Key people are drawn from the related article and linked entity records when available.";
  }
  if (label === "Outcome") {
    return `${content.description || summary || `${entity.name} changed the public story around the people and institutions involved.`} The outcome card keeps the immediate result separate from the broader legacy.`;
  }
  if (label === "Why it matters") {
    return content.contentRationale || `This event matters because it links a specific date to people, institutions, media attention, and later memory. The entity page gives readers a place to move beyond one article.`;
  }
  return current || fallback;
}

function ensureFilledEntityCards(cards, fallbackCards, entity, content) {
  const used = new Set();
  return cards.map((card) => {
    const fallback = fallbackCards.find((item) => item.label === card.label);
    const minWords = entity.type === "event" && ["Date", "Location", "Key people"].includes(card.label)
      ? 4
      : entity.type === "person" && card.label === "Life and death"
        ? 7
        : 18;
    const words = String(card.value || "").trim().split(/\s+/).filter(Boolean).length;
    const currentKey = normalizeTopicMatchText(card.value || "");
    if (currentKey && used.has(currentKey)) {
      const value = expandedEntityCardValue(card.label, "", entity, content, fallback?.value);
      used.add(normalizeTopicMatchText(value));
      return { label: card.label, value };
    }
    if (entity.type === "person" && card.label === "Life and death" && !/\b(death|died)\b/i.test(card.value || "")) {
      const value = expandedEntityCardValue(card.label, card.value, entity, content, fallback?.value);
      used.add(normalizeTopicMatchText(value));
      return {
        label: card.label,
        value,
      };
    }
    if (words >= minWords) {
      used.add(currentKey);
      return card;
    }
    const value = expandedEntityCardValue(card.label, card.value, entity, content, fallback?.value);
    used.add(normalizeTopicMatchText(value));
    return {
      label: card.label,
      value,
    };
  });
}

async function generateEntityOverviewCards(env, entity, content, fallbackCards) {
  if (!hasAnyTextAIProvider(env)) return fallbackCards;
  const typeGuide = entity.type === "person"
    ? `Write exactly 6 cards with these labels in this order: Life and death, Known for, Main role, Major work, Significance, Context.
Life and death must be factual and first. If the person is alive, say "No death date is listed." Do not make one up.`
    : `Write exactly 6 cards with these labels in this order: What happened, Date, Location, Key people, Outcome, Why it matters.`;
  const prompt =
    `Create compact, information-rich overview slider cards for a thisDay entity page.\n\n` +
    `${typeGuide}\n\n` +
    `Rules:\n` +
    `- Each non-date value must be 25 to 45 words.\n` +
    `- Full cards are better than tiny labels. Avoid sentence fragments.\n` +
    `- Do not repeat the same phrase or idea across cards.\n` +
    `- Do not repeat the exact Wikipedia short description.\n` +
    `- Use plain factual language, no hype.\n` +
    `- Prefer concrete facts over generic website text.\n` +
    `- Do not invent facts beyond the supplied data.\n` +
    `- Return JSON only: {"cards":[{"label":"...","value":"..."}]}\n\n` +
    `Entity data:\n${JSON.stringify(
      {
        type: entity.type,
        name: entity.name,
        description: entity.description,
        summary: entity.summary,
        intro: entity.intro,
        birthDate: entity.birthDate,
        deathDate: entity.deathDate,
        wikiUrl: entity.wikiUrl,
        sourcePostTitle: entity.sourcePostTitle,
        sourcePublishedAt: entity.sourcePublishedAt,
      },
      null,
      2,
    )}\n\n` +
    `Related article data:\n${JSON.stringify(
      {
        title: content.title,
        eventTitle: content.eventTitle,
        historicalDate: content.historicalDate,
        location: content.location,
        description: content.description,
        contentRationale: content.contentRationale,
        keyPeople: (content.keyTerms || []).filter((term) => term.type === "person").map((term) => term.term).slice(0, 6),
      },
      null,
      2,
    )}`;

  try {
    const raw = await callAI(
      env,
      [
        {
          role: "system",
          content: "You write concise historical knowledge cards. Return valid JSON only.",
        },
        { role: "user", content: prompt },
      ],
      { maxTokens: 1300, timeoutMs: 25_000, temperature: 0.35 },
    );
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return fallbackCards;
    const parsed = JSON.parse(match[0]);
    let normalized = normalizeEntityCards(parsed.cards, fallbackCards, entity.type);
    if (entityCardsAreFilled(normalized, entity.type)) return normalized;

    const rewritePrompt =
      `The cards below are too thin. Rewrite them as full slider cards.\n` +
      `Keep the same labels and order. Each non-date card must be 25 to 45 words, specific, and non-repetitive.\n` +
      `Return JSON only: {"cards":[{"label":"...","value":"..."}]}\n\n` +
      JSON.stringify({ entity: entity.name, type: entity.type, cards: normalized }, null, 2);
    const expandedRaw = await callAI(
      env,
      [
        {
          role: "system",
          content: "You expand short historical entity cards into complete, non-repetitive JSON cards.",
        },
        { role: "user", content: rewritePrompt },
      ],
      { maxTokens: 1500, timeoutMs: 25_000, temperature: 0.45 },
    );
    const expandedCleaned = expandedRaw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    const expandedMatch = expandedCleaned.match(/\{[\s\S]*\}/);
    if (expandedMatch) {
      const expanded = JSON.parse(expandedMatch[0]);
      normalized = normalizeEntityCards(expanded.cards, fallbackCards, entity.type);
    }
    return ensureFilledEntityCards(normalized, fallbackCards, entity, content);
  } catch (err) {
    console.warn(`Entity overview AI failed for ${entity.name}: ${err.message}`);
    return ensureFilledEntityCards(fallbackCards, fallbackCards, entity, content);
  }
}

function splitIntroParagraphs(text, targetWords = 100) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?]+[.!?]+(?:\s|$)/g) || [clean];
  const paras = [];
  let current = [];
  let wordCount = 0;
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/).length;
    if (wordCount + words > targetWords && current.length > 0) {
      paras.push(current.join(" ").trim());
      current = [sentence.trim()];
      wordCount = words;
    } else {
      current.push(sentence.trim());
      wordCount += words;
    }
  }
  if (current.length > 0) paras.push(current.join(" ").trim());
  return paras.filter((p) => p.length > 40);
}

function buildFallbackEntityBodySections(entity, content) {
  const sourceTitle = entity.sourcePostTitle || content.title || "the related thisDay article";
  const factSentences = entityFactSentences(entity.intro, entity.summary);
  const summary = String(entity.summary || entity.intro || "").replace(/\s+/g, " ").trim();
  const description = String(entity.description || "").replace(/\s+/g, " ").trim();
  const articleDescription = /\.\.\.$|…$/.test(String(content.description || "").trim())
    ? ""
    : String(content.description || "").trim();
  const people = (content.keyTerms || [])
    .filter((term) => term.type === "person")
    .map((term) => term.term)
    .slice(0, 5)
    .join(", ");

  if (entity.type === "person") {
    const introParagraphs = splitIntroParagraphs(entity.intro || entity.summary, 110);
    const sections = [];

    if (introParagraphs.length >= 2) {
      sections.push({
        heading: `Who is ${entity.name}?`,
        paragraphs: introParagraphs.slice(0, 2),
      });
    } else {
      const lifeLine = entity.deathDate
        ? `${entity.name} was born on ${entity.birthDate || "an unlisted date"} and died on ${entity.deathDate}.`
        : entity.birthDate
          ? `${entity.name} was born on ${entity.birthDate}.`
          : "";
      const educationFact = findEntityFact(factSentences, [/educated/i, /university/i, /college/i, /academy/i], "");
      const serviceFact = findEntityFact(factSentences, [/served/i, /military/i, /air force/i, /air ambulance/i, /army/i], "");
      sections.push({
        heading: `Who is ${entity.name}?`,
        paragraphs: [
          `${lifeLine} ${summary}`.trim(),
          [educationFact, serviceFact].filter(Boolean).join(" ") || (description ? `${entity.name} is described as ${description}.` : summary),
        ].filter(Boolean),
      });
    }

    if (introParagraphs.length >= 4) {
      sections.push({
        heading: `Career and legacy`,
        paragraphs: introParagraphs.slice(2, 4),
      });
    } else if (introParagraphs.length === 3) {
      sections[0].paragraphs.push(introParagraphs[2]);
    }

    if (introParagraphs.length >= 5) {
      sections.push({
        heading: `Historical significance`,
        paragraphs: introParagraphs.slice(4, 6),
      });
    }

    return sections.filter((s) => s.paragraphs.filter(Boolean).length > 0);
  }

  return [
    {
      heading: `What was ${entity.name}?`,
      paragraphs: [
        `${summary || content.description || `${entity.name} is the event connected to this thisDay article.`}`,
        `${content.historicalDate ? `${entity.name} is tied to ${content.historicalDate}.` : `The related article supplies the date context for ${entity.name}.`} ${people ? `Key people connected to the event include ${people}.` : `Key people are drawn from the related article when available.`}`,
      ],
    },
    {
      heading: `Why ${entity.name} still matters`,
      paragraphs: [
        `${content.contentRationale || `${entity.name} matters because it connects a specific date to people, institutions, public memory, and later interpretation.`}`,
        `${sourceTitle} connects ${entity.name} to a specific historical date. ${articleDescription || "The related article explains the event, the people involved, and why the moment is still remembered."}`,
      ],
    },
  ];
}

function normalizeEntityBodySections(sections, fallbackSections) {
  const source = Array.isArray(sections) ? sections : [];
  const normalized = source
    .map((section) => ({
      heading: String(section?.heading || "").trim(),
      paragraphs: Array.isArray(section?.paragraphs)
        ? section.paragraphs.map((p) => String(p || "").replace(/\s+/g, " ").trim()).filter(Boolean)
        : [],
    }))
    .filter((section) => section.heading && section.paragraphs.length > 0)
    .slice(0, 5);
  const enough = normalized.length >= 2 && normalized.every((section) =>
    section.paragraphs.join(" ").split(/\s+/).filter(Boolean).length >= 40,
  );
  return enough ? normalized : fallbackSections;
}

async function generateEntityBodySections(env, entity, content, fallbackSections) {
  if (!hasAnyTextAIProvider(env)) return fallbackSections;
  const isperson = entity.type === "person";
  const prompt =
    `Write the main body text for a thisDay ${isperson ? "person" : "event"} page. It appears directly under an overview slider.\n\n` +
    `Requirements:\n` +
    `- Return JSON only: {"sections":[{"heading":"...","paragraphs":["...","...","..."]}]}\n` +
    `- Create 3 to 4 sections.\n` +
    `- Each section should have 2 to 3 paragraphs.\n` +
    `- Each paragraph should be 100 to 140 words — write full, informative prose, not short summaries.\n` +
    `- Use clear, searchable headings that describe the section topic (e.g. "Early life and career", "Role in the Vietnam War", "Nobel Prize refusal", "Legacy").\n` +
    `- Cover: early life/background, main career/achievement, historical significance, legacy or later life.\n` +
    `- Include all available facts from the supplied intro text — do not omit names, dates, offices, or events.\n` +
    `- Use only supplied facts. Do not invent dates, places, offices, or achievements.\n` +
    `- Avoid filler phrases like "rich tapestry", "delve", "captivating", "important to remember", "testament to".\n` +
    `- Do not explain what the page is for. Write about the ${isperson ? "person" : "event"} itself.\n` +
    `- Avoid repeating the same sentence or title wording from the overview cards.\n\n` +
    `Entity:\n${JSON.stringify(
      {
        type: entity.type,
        name: entity.name,
        description: entity.description,
        summary: entity.summary,
        intro: entity.intro,
        birthDate: entity.birthDate,
        deathDate: entity.deathDate,
        wikiUrl: entity.wikiUrl,
        sourcePostTitle: entity.sourcePostTitle,
      },
      null,
      2,
    )}\n\n` +
    `Related thisDay article:\n${JSON.stringify(
      {
        title: content.title,
        eventTitle: content.eventTitle,
        historicalDate: content.historicalDate,
        location: content.location,
        description: content.description,
        contentRationale: content.contentRationale,
        pillars: entity.relatedTopics,
        keyPeople: (content.keyTerms || []).filter((term) => term.type === "person").map((term) => term.term).slice(0, 6),
      },
      null,
      2,
    )}`;

  try {
    const raw = await callAI(
      env,
      [
        {
          role: "system",
          content:
            "You write detailed, factual, long-form historical entity page copy for thisDay.info. Return valid JSON only.\n\n" +
            WRITING_REWRITE_RULES,
        },
        { role: "user", content: prompt },
      ],
      { maxTokens: 3200, timeoutMs: 40_000, temperature: 0.35 },
    );
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return fallbackSections;
    const parsed = JSON.parse(match[0]);
    return normalizeEntityBodySections(parsed.sections, fallbackSections);
  } catch (err) {
    console.warn(`Entity body AI failed for ${entity.name}: ${err.message}`);
    return fallbackSections;
  }
}

function evergreenHistoryEvidenceCorpus(entity) {
  const evidence = entity?.evergreenEvidence || {};
  return [
    entity?.name,
    entity?.description,
    entity?.summary,
    entity?.intro,
    evidence.articleTitle,
    evidence.factualTitle,
    evidence.eventTitle,
    evidence.historicalDate,
    evidence.location,
    evidence.articleDescription,
    evidence.articleRationale,
    ...(Array.isArray(evidence.articleParagraphs)
      ? evidence.articleParagraphs
      : []),
    ...(Array.isArray(evidence.sourcePages)
      ? evidence.sourcePages.flatMap((page) => [
          page?.pageTitle,
          page?.extract,
          ...(Array.isArray(page?.supportedClaims)
            ? page.supportedClaims
            : []),
        ])
      : []),
  ]
    .filter(Boolean)
    .join("\n\n")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 22_000);
}

function timelineDateIsGrounded(date, corpus) {
  const value = String(date || "").replace(/\s+/g, " ").trim();
  const years = value.match(/\b\d{3,4}\b/g) || [];
  const monthDay = value.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i,
  );
  const dayMonth = value.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\b/i,
  );
  const normalizedCorpus = String(corpus || "").replace(/\s+/g, " ");
  const monthDayGrounded = !monthDay || new RegExp(
    `\\b${monthDay[1]}\\s+${Number(monthDay[2])}(?:st|nd|rd|th)?\\b`,
    "i",
  ).test(normalizedCorpus) || new RegExp(
    `\\b${Number(monthDay[2])}(?:st|nd|rd|th)?\\s+${monthDay[1]}\\b`,
    "i",
  ).test(normalizedCorpus);
  const dayMonthGrounded = !dayMonth || new RegExp(
    `\\b${Number(dayMonth[1])}(?:st|nd|rd|th)?\\s+${dayMonth[2]}\\b`,
    "i",
  ).test(normalizedCorpus) || new RegExp(
    `\\b${dayMonth[2]}\\s+${Number(dayMonth[1])}(?:st|nd|rd|th)?\\b`,
    "i",
  ).test(normalizedCorpus);
  return (
    /\d/.test(value) &&
    years.every((year) =>
      new RegExp(`\\b${year}\\b`).test(normalizedCorpus),
    ) &&
    monthDayGrounded &&
    dayMonthGrounded
  );
}

function normalizeEvergreenHistoryEdition(entity, value) {
  const parsed = value && typeof value === "object" ? value : {};
  const clean = (text, max = 0) => {
    const normalized = String(text || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return max && normalized.length > max
      ? truncateForMeta(normalized, max)
      : normalized;
  };
  const bodySections = (Array.isArray(parsed.bodySections)
    ? parsed.bodySections
    : Array.isArray(parsed.sections)
      ? parsed.sections
      : [])
    .map((section) => ({
      heading: clean(section?.heading, 100),
      paragraphs: (Array.isArray(section?.paragraphs)
        ? section.paragraphs
        : [])
        .map((paragraph) => clean(paragraph))
        .filter(Boolean)
        .slice(0, 3),
    }))
    .filter((section) => section.heading && section.paragraphs.length > 0)
    .slice(0, 5);
  const overviewCards = (Array.isArray(parsed.overviewCards)
    ? parsed.overviewCards
    : [])
    .map((card) => ({
      label: clean(card?.label, 40),
      value: clean(card?.value, 260),
    }))
    .filter((card) => card.label && card.value)
    .slice(0, 6);
  const corpus = evergreenHistoryEvidenceCorpus(entity);
  const timeline = (Array.isArray(parsed.timeline) ? parsed.timeline : [])
    .map((item) => ({
      date: clean(item?.date || item?.year, 50),
      label: clean(item?.label, 260),
      kind: ["birth", "death", "milestone"].includes(item?.kind)
        ? item.kind
        : "milestone",
    }))
    .filter((item) =>
      item.date &&
      item.label &&
      timelineDateIsGrounded(item.date, corpus),
    )
    .slice(0, 9);
  const comparisonRows = (Array.isArray(parsed.comparisonRows)
    ? parsed.comparisonRows
    : [])
    .map((row) => ({
      expected: clean(row?.expected, 180),
      happened: clean(row?.happened, 240),
      mattered: clean(row?.mattered, 240),
    }))
    .filter((row) => row.expected && row.happened && row.mattered)
    .slice(0, 4);
  const pageHeading = clean(parsed.pageHeading, 96);
  const description = clean(parsed.description, 220);
  const edition = {
    ...entity,
    pageHeading,
    seoTitle: clean(parsed.seoTitle || pageHeading, 70),
    seoDescription: clean(parsed.seoDescription || description, 155),
    description,
    summary: clean(parsed.summary || entity.summary, 420),
    overviewCards,
    bodySections,
    timeline,
    sourceLinks: Array.isArray(entity.sourceLinks)
      ? entity.sourceLinks
      : [],
    evergreenHistoryVersion: EVERGREEN_HISTORY_EDITION_VERSION,
    ...(comparisonRows.length >= 3
      ? {
          comparisonHeading: clean(parsed.comparisonHeading, 100),
          comparisonIntro: clean(parsed.comparisonIntro, 360),
          comparisonRows,
        }
      : {}),
  };
  const quality = evergreenHistoryEditionQuality(edition);
  return quality.ok ? edition : null;
}

async function generateEvergreenHistoryEdition(env, entity) {
  if (
    entity?.type !== "event" ||
    entity.historyQualityGateVersion !== BLOG_HISTORY_QUALITY_GATE_VERSION ||
    !entity.needsEvergreenRefresh ||
    !hasAnyTextAIProvider(env)
  ) {
    return null;
  }
  const corpus = evergreenHistoryEvidenceCorpus(entity);
  if (corpus.split(/\s+/).filter(Boolean).length < 700) return null;
  const sourceList = (Array.isArray(entity.sourceLinks)
    ? entity.sourceLinks
    : [])
    .map((source) => ({
      label: source.label,
      publisher: source.publisher,
      verifiedIndependent: source.verifiedIndependent === true,
    }));
  const prompt =
    `Create a distinct evergreen history edition for thisDay.info. The related daily article is a date-based narrative; this page must answer a different, focused reader question using only the supplied evidence.\n\n` +
    `Return JSON only with this exact top-level shape:\n` +
    `{"pageHeading":"Why/How/What question?","seoTitle":"...","seoDescription":"...","description":"...","summary":"...","overviewCards":[{"label":"...","value":"..."}],"comparisonHeading":"...","comparisonIntro":"...","comparisonRows":[{"expected":"...","happened":"...","mattered":"..."}],"bodySections":[{"heading":"...","paragraphs":["...","..."]}],"timeline":[{"date":"...","label":"...","kind":"milestone"}]}\n\n` +
    `Quality requirements:\n` +
    `- Choose one source-supported niche question that is recognizably about the event but does not duplicate the daily article title.\n` +
    `- Write exactly 5 concise overview cards.\n` +
    `- Write exactly 4 body sections with 2 paragraphs each. Each paragraph must contain 90 to 125 words.\n` +
    `- Organize the sections around: origins or enabling conditions; the actors, choices, or mechanism; the decisive sequence; consequences and longer significance. Use specific natural headings instead of those generic labels.\n` +
    `- Write 5 to 8 chronological timeline entries. Every date and year must occur in the evidence.\n` +
    `- Add 3 comparison rows only when the evidence supports a useful expectation-versus-outcome or constraint-versus-result comparison; otherwise return an empty comparisonRows array.\n` +
    `- Paraphrase and synthesize. Do not copy a daily article paragraph verbatim.\n` +
    `- Use only supplied facts. Do not infer a cause, motive, consequence, quotation, number, place, or relationship that the evidence does not explicitly support.\n` +
    `- Do not put URLs, citations, source labels, website instructions, or filler in visible prose.\n` +
    `- Avoid hype and generic phrases such as "rich tapestry", "delve", "testament to", "pivotal moment", or "important to remember".\n\n` +
    `Canonical event metadata:\n${JSON.stringify({
      name: entity.name,
      slug: entity.slug,
      wikiUrl: entity.wikiUrl,
      historicalDate: entity.evergreenEvidence?.historicalDate,
      location: entity.evergreenEvidence?.location,
      dailyArticleTitle: entity.evergreenEvidence?.articleTitle,
      sources: sourceList,
    }, null, 2)}\n\n` +
    `GROUNDED EVIDENCE:\n"""\n${corpus}\n"""`;
  try {
    const raw = await callAI(
      env,
      [
        {
          role: "system",
          content:
            "You write source-bounded evergreen history explainers. Return valid JSON only and never add an unsupported fact.\n\n" +
            WRITING_REWRITE_RULES,
        },
        { role: "user", content: prompt },
      ],
      { maxTokens: 3600, timeoutMs: 45_000, temperature: 0.3 },
    );
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const edition = normalizeEvergreenHistoryEdition(
      entity,
      JSON.parse(match[0]),
    );
    if (!edition) {
      console.warn(
        `Evergreen history edition rejected by quality gate for ${entity.name}`,
      );
    }
    return edition;
  } catch (err) {
    console.warn(
      `Evergreen history generation failed for ${entity?.name || "event"}: ${err.message}`,
    );
    return null;
  }
}

function buildEventOverviewCards(entity, content) {
  const summary = compactEntityText(entity.summary, 185);
  const description = compactEntityText(content.description, 185);
  const rationale = compactEntityText(content.contentRationale, 185);
  return [
    { label: "What happened", value: summary || description || `${entity.name} is the event covered by this thisDay article.` },
    { label: "Date", value: content.historicalDate || "Date details are sourced from the related article." },
    { label: "Location", value: content.location || "Location details are sourced from the related article." },
    { label: "Key people", value: (content.keyTerms || []).filter((t) => t.type === "person").map((t) => t.term).slice(0, 4).join(", ") || "Key people are listed in the related article." },
    { label: "Outcome", value: description || summary || "The related article explains the outcome and immediate consequences." },
    { label: "Why it matters", value: rationale || summary || "This page collects thisDay coverage and source links for the event." },
  ];
}

async function upsertEntityRecord(env, draftEntity) {
  const storageSlug = draftEntity.storageSlug || draftEntity.slug;
  const key = `${KV_ENTITY_PREFIX}${draftEntity.type}:${storageSlug}`;
  const existingRaw = await env.BLOG_AI_KV.get(key);
  const existing = existingRaw ? JSON.parse(existingRaw) : null;
  const relatedPosts = [
    ...new Set([
      ...(Array.isArray(existing?.relatedPosts) ? existing.relatedPosts : []),
      ...(Array.isArray(draftEntity.relatedPosts) ? draftEntity.relatedPosts : []),
    ]),
  ];

  // Prefer non-empty values: never overwrite good existing data with empty new data.
  // Wikipedia fetch failures during re-enrichment must not erase previously stored content.
  const hasSections = (sections) =>
    Array.isArray(sections) && sections.length > 0 &&
    sections.some((s) => (s.paragraphs || []).join(" ").split(/\s+/).length > 20);

  const mergedIntro = draftEntity.intro || existing?.intro || "";
  const mergedSummary = draftEntity.summary || existing?.summary || "";
  const entity = {
    ...(existing || {}),
    ...draftEntity,
    intro: mergedIntro,
    summary: mergedSummary,
    description: draftEntity.description || existing?.description || "",
    imageUrl: draftEntity.imageUrl || existing?.imageUrl || "",
    birthDate: draftEntity.birthDate || existing?.birthDate || "",
    deathDate: draftEntity.deathDate || existing?.deathDate || "",
    overviewCards: (draftEntity.overviewCards?.length > 0) ? draftEntity.overviewCards : (existing?.overviewCards || []),
    bodySections: hasSections(draftEntity.bodySections) ? draftEntity.bodySections : (existing?.bodySections || []),
    relatedPosts,
    firstSeenAt: existing?.firstSeenAt || draftEntity.firstSeenAt,
    updatedAt: new Date().toISOString(),
  };
  const existingEvergreenReady =
    existing?.type === "event" &&
    evergreenHistoryEditionQuality(existing).ok;
  const draftEvergreenReady =
    draftEntity?.type === "event" &&
    evergreenHistoryEditionQuality(draftEntity).ok;
  if (existingEvergreenReady && !draftEvergreenReady) {
    for (const field of [
      "pageHeading",
      "seoTitle",
      "seoDescription",
      "description",
      "summary",
      "overviewCards",
      "bodySections",
      "timeline",
      "comparisonHeading",
      "comparisonIntro",
      "comparisonRows",
      "sourceLinks",
      "evergreenHistoryVersion",
      "evergreenReadyAt",
      "evergreenEvidence",
    ]) {
      if (existing[field] !== undefined) entity[field] = existing[field];
    }
    entity.historyLinkEligible = true;
    delete entity.needsEvergreenRefresh;
    delete entity.needsWikiRefresh;
  }
  if (!existing) entity.qualityGateVersion = BLOG_ENTITY_QUALITY_GATE_VERSION;
  // Clear stale refresh flag whenever we now have real data; set it only when still empty
  if (mergedIntro || mergedSummary) {
    delete entity.needsWikiRefresh;
  } else if (draftEntity.needsWikiRefresh) {
    entity.needsWikiRefresh = true;
  }
  await env.BLOG_AI_KV.put(key, JSON.stringify(entity));
  return entity;
}

async function upsertEntityIndex(env, entities) {
  if (!entities.length) return;
  const raw = await env.BLOG_AI_KV.get(KV_ENTITY_INDEX_KEY);
  const index = raw ? JSON.parse(raw) : [];
  const byId = new Map(index.map((entry) => [`${entry.type}:${entry.slug}`, entry]));
  for (const entity of entities) {
    const prev = byId.get(`${entity.type}:${entity.slug}`) || {};
    const usesQualityGate =
      entity.qualityGateVersion === BLOG_ENTITY_QUALITY_GATE_VERSION;
    const historyLinkEligible =
      entity.type === "event" &&
      isHistoryEntityDiscoveryLinkEligible(entity);
    byId.set(`${entity.type}:${entity.slug}`, {
      type: entity.type,
      slug: entity.slug,
      name: entity.name,
      url: entity.url,
      ...(entity.storageSlug ? { storageSlug: entity.storageSlug } : {}),
      wikiUrl: entity.wikiUrl || prev.wikiUrl || "",
      imageUrl: entity.imageUrl || "",
      summary: entity.summary || entity.description || "",
      relatedPosts: entity.relatedPosts || [],
      updatedAt: entity.updatedAt,
      indexable: usesQualityGate
        ? blogEntityQualityEligible(entity)
        : entityContentWordCount(entity) >= 150,
      ...(usesQualityGate
        ? { qualityGateVersion: BLOG_ENTITY_QUALITY_GATE_VERSION }
        : {}),
      ...(entity.type === "event" ? { historyLinkEligible } : {}),
      ...(entity.type === "event" && entity.historyQualityGateVersion
        ? {
            historyQualityGateVersion: entity.historyQualityGateVersion,
            ...(entity.canonicalIdentity
              ? { canonicalIdentity: entity.canonicalIdentity }
              : {}),
          }
        : {}),
      ...(entity.needsWikiRefresh ? { needsWikiRefresh: true } : {}),
      ...(entity.needsEvergreenRefresh
        ? { needsEvergreenRefresh: true }
        : {}),
    });
  }
  await env.BLOG_AI_KV.put(
    KV_ENTITY_INDEX_KEY,
    JSON.stringify([...byId.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)))),
  );
}

async function upsertEntitiesForContent(env, content, slug, date, pillars, { skipAiGeneration = false } = {}) {
  const rawTerms = Array.isArray(content.keyTerms) ? content.keyTerms : [];
  const sourcePages = sourcePagesFromContent(content);
  const mainEvent = {
    term: content.eventTitle || content.title,
    wikiUrl: content.wikiUrl || content.jsonLdUrl || "",
    type: "event",
    isPrimaryEvent: true,
  };
  const termsById = new Map();
  for (const term of [mainEvent, ...rawTerms]) {
    const type = normalizeEntityType(term?.type);
    const slugPart = entitySlug(term?.term);
    if (!term?.term || !type || !slugPart) continue;
    const id = `${type}:${slugPart}`;
    const existing = termsById.get(id);
    if (!existing || (!existing.wikiUrl && term.wikiUrl)) {
      termsById.set(id, { ...existing, ...term, type });
    }
  }
  const terms = [...termsById.values()];
  const existingEntityIndexRaw = await env.BLOG_AI_KV
    .get(KV_ENTITY_INDEX_KEY)
    .catch(() => null);
  const existingEntityIndex = existingEntityIndexRaw
    ? JSON.parse(existingEntityIndexRaw)
    : [];
  const historyByIdentity = new Map();
  for (const entry of Array.isArray(existingEntityIndex)
    ? existingEntityIndex
    : []) {
    if (entry?.type !== "event") continue;
    const identity =
      entry.canonicalIdentity ||
      normalizedWikipediaEntityIdentity(entry.wikiUrl);
    if (!identity) continue;
    const current = historyByIdentity.get(identity);
    if (
      !current ||
      (
        entry.historyLinkEligible === true &&
        current.historyLinkEligible !== true
      )
    ) {
      historyByIdentity.set(identity, entry);
    }
  }

  const saved = [];
  const articleEntities = [];
  const seenEventIdentities = new Set();
  for (const term of terms) {
    const type = normalizeEntityType(term.type);
    // For persons, strip leading honorifics ("General", "President", "Dr.", etc.) before
    // computing the slug and performing the Wikipedia lookup. "General Dwight D. Eisenhower"
    // resolves to slug "dwight-d-eisenhower" and Wikipedia finds the biography on the first
    // try. Without stripping, the raw name fails with a 404 and the person is left unlinked.
    const canonicalName = type === "person" ? stripPersonHonorifics(term.term) : term.term;
    const canonicalTerm = canonicalName !== term.term ? { ...term, term: canonicalName } : term;
    const initialSlugPart = entitySlug(canonicalTerm.term);
    if (!type || !initialSlugPart) continue;
    // For persons: always attempt a Wikipedia fetch even when the AI omitted the URL —
    // fetchWikipediaEntityData already falls back to term.term for the name lookup.
    // For non-person entities without a URL, skip the fetch to avoid unnecessary calls.
    const wikiData = (canonicalTerm.wikiUrl || type === "person")
      ? await fetchWikipediaEntityData(canonicalTerm, { sourcePages }).catch(() => ({}))
      : {};
    // When the AI omitted the wikiUrl for a person but the name-based lookup returned a
    // non-disambiguation standard biography, derive the canonical URL from the resolved
    // page title so the profile check and all downstream steps (image, person page) work.
    const resolvedWikiUrl =
      type === "person" && wikiData.sourceEventPageFallback && (wikiData.wikiUrl || wikiData.resolvedPageTitle)
        ? wikiData.wikiUrl || wikiUrlFromTitle(wikiData.resolvedPageTitle)
        : type === "person" && !canonicalTerm.wikiUrl && wikiData.resolvedPageTitle && !wikiData.isDisambiguation
          ? wikiData.wikiUrl || wikiUrlFromTitle(wikiData.resolvedPageTitle)
          : canonicalTerm.wikiUrl;
    const resolvedTerm = resolvedWikiUrl !== canonicalTerm.wikiUrl ? { ...canonicalTerm, wikiUrl: resolvedWikiUrl } : canonicalTerm;
    const eventIdentity = type === "event"
      ? normalizedWikipediaEntityIdentity(resolvedTerm.wikiUrl)
      : "";
    const existingHistoryIdentity = eventIdentity
      ? historyByIdentity.get(eventIdentity)
      : null;
    const usesEvergreenHistoryGate =
      type === "event" &&
      (
        !existingHistoryIdentity ||
        existingHistoryIdentity.historyQualityGateVersion ===
          BLOG_HISTORY_QUALITY_GATE_VERSION
      );
    if (eventIdentity && seenEventIdentities.has(eventIdentity)) continue;
    if (eventIdentity) seenEventIdentities.add(eventIdentity);
    if (type === "person" && !hasRichWikipediaPersonProfile({ ...resolvedTerm, ...wikiData, type })) {
      suppressPersonProfileLink(content, term.term);
      articleEntities.push(unlinkedArticlePerson(term));
      console.warn(`Entity graph: showing "${term.term}" without a profile link because its Wikipedia source is missing, thin, disambiguated, or not a biography of that person.`);
      continue;
    }
    const wikiEmpty = !wikiData.intro && !wikiData.summary;
    const entityImageUrl = wikiData.imageUrl || (
      type === "person" && resolvedTerm.wikiUrl
        ? await fetchWikipediaImage(resolvedTerm.term, resolvedTerm.wikiUrl, { skipCommonsSearch: true }).catch(() => "")
        : ""
    );
    const historySeed = type === "event"
      ? {
          type,
          slug: initialSlugPart,
          name: resolvedTerm.term,
          wikiUrl: resolvedTerm.wikiUrl || "",
          resolvedPageTitle: wikiData.resolvedPageTitle || "",
        }
      : null;
    const historyCandidate = type === "event"
      ? evergreenHistoryCandidateEligibility(historySeed, content, {
          primaryEvent: resolvedTerm.isPrimaryEvent === true,
        })
      : null;
    let slugPart =
      type === "event" && existingHistoryIdentity?.slug
        ? existingHistoryIdentity.slug
        : type === "event" && resolvedTerm.isPrimaryEvent === true
          ? buildEvergreenHistorySlug(historySeed, content) || initialSlugPart
        : initialSlugPart;
    let url = type === "person"
      ? `/people/${slugPart}/`
      : existingHistoryIdentity?.url || `/history/${slugPart}/`;
    let storageSlug =
      type === "event" && existingHistoryIdentity?.storageSlug
        ? existingHistoryIdentity.storageSlug
        : slugPart;
    if (type === "event") {
      const normalizedHistory = normalizeArticleHistoryEntityMeta({
        ...historySeed,
        slug: slugPart,
        url,
      });
      slugPart = normalizedHistory.slug;
      url = normalizedHistory.url;
      storageSlug = isSpanishCivilWarHistoryEntity(normalizedHistory)
        ? "spanish-civil-war-erupts"
        : storageSlug;
    }
    let entity = {
      type,
      slug: slugPart,
      name: resolvedTerm.term,
      url,
      ...(storageSlug !== slugPart ? { storageSlug } : {}),
      wikiUrl: resolvedTerm.wikiUrl || "",
      sourcePostSlug: slug,
      sourcePostTitle: content.title || "",
      sourcePostUrl: `/blog/${slug}/`,
      sourcePublishedAt: date.toISOString(),
      imageUrl: entityImageUrl || (type === "event" ? content.imageUrl : ""),
      summary: wikiData.summary || "",
      intro: wikiData.intro || wikiData.summary || "",
      description: wikiData.description || "",
      resolvedPageTitle: wikiData.resolvedPageTitle || "",
      birthDate: wikiData.birthDate || "",
      deathDate: wikiData.deathDate || "",
      ...(wikiData.wikidataEntityId
        ? { wikidataEntityId: wikiData.wikidataEntityId }
        : {}),
      ...(typeof wikiData.wikidataInstanceOfHuman === "boolean"
        ? { wikidataInstanceOfHuman: wikiData.wikidataInstanceOfHuman }
        : {}),
      relatedTopics: Array.isArray(pillars) ? pillars : [],
      relatedPosts: [slug],
      firstSeenAt: new Date().toISOString(),
      ...(type === "person"
        ? { profileLinkEligible: true, profileSubjectVerified: true }
        : {}),
      ...(usesEvergreenHistoryGate
        ? {
            historyQualityGateVersion: BLOG_HISTORY_QUALITY_GATE_VERSION,
            historyLinkEligible: false,
            ...(historyCandidate?.canonicalIdentity
              ? { canonicalIdentity: historyCandidate.canonicalIdentity }
              : {}),
            ...(resolvedTerm.isPrimaryEvent === true
              ? { primaryHistoryEntity: true }
              : {}),
            ...(resolvedTerm.isPrimaryEvent === true &&
            historyCandidate?.sourceLinks?.length
              ? { sourceLinks: historyCandidate.sourceLinks }
              : {}),
            ...(resolvedTerm.isPrimaryEvent === true &&
            historyCandidate?.evidence
              ? { evergreenEvidence: historyCandidate.evidence }
              : {}),
            ...(historyCandidate?.ok
              ? { needsEvergreenRefresh: true }
              : {}),
          }
        : {}),
      ...(wikiData.sourceEventPageFallback ? { sourceEventPageFallback: true } : {}),
      ...(wikiEmpty && resolvedTerm.wikiUrl ? { needsWikiRefresh: true } : {}),
      // Mark new entities for AI card generation on next cron refresh when
      // skipping inline AI calls (subrequest budget preservation).
      ...(skipAiGeneration ? { needsWikiRefresh: true } : {}),
    };
    const fallbackCards = type === "person"
      ? buildPersonOverviewCards(entity)
      : buildEventOverviewCards(entity, content);
    const fallbackSections = buildFallbackEntityBodySections(entity, content);
    if (
      type === "event" &&
      entity.historyQualityGateVersion === BLOG_HISTORY_QUALITY_GATE_VERSION
    ) {
      entity.overviewCards = fallbackCards;
      entity.bodySections = fallbackSections;
      if (!skipAiGeneration && entity.needsEvergreenRefresh) {
        const edition = await generateEvergreenHistoryEdition(env, entity);
        if (edition) {
          entity = {
            ...edition,
            historyLinkEligible: true,
            evergreenReadyAt: new Date().toISOString(),
          };
          delete entity.needsEvergreenRefresh;
          delete entity.needsWikiRefresh;
        }
      }
    } else {
      // Skip AI-generated cards when caller opts out (saves ~2
      // subrequests/entity). Entities are refreshed by the cron's entity
      // refresh loop within 1–3 days.
      entity.overviewCards = skipAiGeneration
        ? fallbackCards
        : await generateEntityOverviewCards(env, entity, content, fallbackCards);
      entity.bodySections = skipAiGeneration
        ? fallbackSections
        : await generateEntityBodySections(env, entity, content, fallbackSections);
    }
    if (type === "person" && !skipAiGeneration) {
      const timeline = await generateEntityTimeline(env, entity).catch(() => []);
      if (timeline.length) entity.timeline = timeline;
    }
    const savedEntity = await upsertEntityRecord(env, entity);
    saved.push(savedEntity);
    articleEntities.push(savedEntity);
  }
  await upsertEntityIndex(env, saved);
  if (articleEntities.length > 0) {
    const lightweight = compactArticleEntityMeta(articleEntities);
    await env.BLOG_AI_KV.put(
      `post-entities:${slug}`,
      JSON.stringify(lightweight),
    ).catch(() => {});
  }
  return articleEntities;
}

// Re-run entity resolution for one published post (from its index entry) and patch the
// rebuilt people strip into the stored article HTML. This is the proven path used by both
// the /blog/backfill-entities admin route and the nightly entity-recovery cron.
async function backfillEntitiesForEntry(env, entry) {
  const date = new Date(entry.publishedAt || Date.now());
  const postHtml = await env.BLOG_AI_KV.get(`${KV_POST_PREFIX}${entry.slug}`).catch(() => null);
  const htmlSourcePages = extractSourcePagesFromHtml(postHtml);
  const sourcePages = normalizeSourcePages([
    ...(Array.isArray(entry.sourcePages) ? entry.sourcePages : []),
    ...htmlSourcePages,
    {
      pageTitle: entry.sourcePageTitle,
      pageUrl: entry.wikiUrl || entry.jsonLdUrl || "",
    },
  ]);
  const content = {
    ...entry,
    historicalDate: inferHistoricalDateFromEntry(entry),
    ...(sourcePages.length > 0 ? { sourcePages } : {}),
    ...(!entry.wikiUrl && sourcePages[0]?.pageUrl ? { wikiUrl: sourcePages[0].pageUrl } : {}),
  };
  const entities = await upsertEntitiesForContent(env, content, entry.slug, date, entry.pillars || []);
  if (postHtml && entities.length > 0) {
    const updatedHtml = injectArticleEntityStrip(postHtml, entities);
    if (updatedHtml !== postHtml) {
      await env.BLOG_AI_KV.put(`${KV_POST_PREFIX}${entry.slug}`, updatedHtml).catch(() => {});
    }
  }
  // This recovery just re-resolved the entities and rebuilt the strip. Reset the
  // serve-time heal back-off counter so a post that only NOW became healable re-links
  // on its next view instead of waiting out the 7-day ENTITY_STRIP_REPAIR_TTL window.
  await clearRepairAttempt(env, entry.slug, "entity-strip").catch(() => {});
  return entities;
}

// Daily self-healing pass (own cron invocation = fresh subrequest budget). The 00:05
// generation cron exhausts its subrequest budget on the AI/enrichment pipeline before
// upsertEntitiesForContent runs, so person Wikipedia fetches come back empty and people
// render as unlinked, portrait-less labels. A separate later invocation has full budget,
// so it re-resolves recent posts whose stored people strip still has an unlinked or
// portrait-less person, exactly like a manual backfill.
async function recoverRecentEntityStrips(env, { maxPosts = 3, lookbackDays = 3 } = {}) {
  const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  const cutoff = Date.now() - lookbackDays * 86_400_000;
  const recent = [...index]
    .filter((e) => e.slug && e.publishedAt && new Date(e.publishedAt).getTime() >= cutoff)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  let repaired = 0;
  for (const entry of recent) {
    if (repaired >= maxPosts) break;
    const peRaw = await env.BLOG_AI_KV.get(`post-entities:${entry.slug}`).catch(() => null);
    if (!peRaw) continue;
    let people;
    try {
      people = JSON.parse(peRaw).filter((e) => e && e.type === "person");
    } catch {
      continue;
    }
    if (people.length === 0) continue;
    const needsRepair = people.some((p) =>
      !hasVerifiedPersonProfileIdentity(p) ||
      !p.imageUrl,
    );
    if (!needsRepair) continue;
    try {
      await backfillEntitiesForEntry(env, entry);
      repaired += 1;
      console.log(`Blog AI: entity recovery re-resolved people strip for /blog/${entry.slug}/`);
    } catch (err) {
      console.warn(`Blog AI: entity recovery failed for ${entry.slug} — ${err.message}`);
    }
  }
  return repaired;
}

async function recoverPendingEvergreenHistory(env, { limit = 1 } = {}) {
  const indexRaw = await env.BLOG_AI_KV.get(KV_ENTITY_INDEX_KEY);
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  const candidates = index
    .filter((entry) =>
      entry?.type === "event" &&
      entry.historyQualityGateVersion === BLOG_HISTORY_QUALITY_GATE_VERSION &&
      entry.needsEvergreenRefresh === true &&
      entry.slug &&
      entry.wikiUrl,
    )
    .sort((a, b) =>
      new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0),
    )
    .slice(0, Math.max(1, Math.min(Number(limit) || 1, 2)));
  const result = {
    selected: candidates.length,
    promoted: 0,
    deferred: 0,
  };
  for (const entry of candidates) {
    const storageSlug = entry.storageSlug || entry.slug;
    const key = `${KV_ENTITY_PREFIX}event:${storageSlug}`;
    const raw = await env.BLOG_AI_KV.get(key).catch(() => null);
    if (!raw) {
      result.deferred += 1;
      continue;
    }
    let entity;
    try {
      entity = JSON.parse(raw);
    } catch {
      result.deferred += 1;
      continue;
    }
    if (
      !entity.intro ||
      !entity.summary ||
      !entity.imageUrl
    ) {
      const wiki = await fetchWikipediaEntityData({
        wikiUrl: entity.wikiUrl,
        term: entity.name,
        type: "event",
      }).catch(() => ({}));
      entity.intro = entity.intro || wiki.intro || wiki.summary || "";
      entity.summary = entity.summary || wiki.summary || wiki.intro || "";
      entity.description = entity.description || wiki.description || "";
      entity.imageUrl = entity.imageUrl || wiki.imageUrl || "";
      entity.resolvedPageTitle =
        entity.resolvedPageTitle || wiki.resolvedPageTitle || "";
    }
    if (entity.intro || entity.summary) delete entity.needsWikiRefresh;
    const edition = await generateEvergreenHistoryEdition(env, entity);
    if (!edition) {
      entity.historyLinkEligible = false;
      entity.updatedAt = new Date().toISOString();
      await env.BLOG_AI_KV.put(key, JSON.stringify(entity));
      await upsertEntityIndex(env, [entity]);
      result.deferred += 1;
      continue;
    }
    entity = {
      ...edition,
      historyLinkEligible: true,
      evergreenReadyAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    delete entity.needsEvergreenRefresh;
    delete entity.needsWikiRefresh;
    await env.BLOG_AI_KV.put(key, JSON.stringify(entity));
    await upsertEntityIndex(env, [entity]);
    await syncEvergreenHistoryDiscoveryForEntity(env, entity);
    const discoveryTasks = [];
    try {
      if (globalThis.caches?.default) {
        discoveryTasks.push(
          globalThis.caches.default.delete(
            new Request(`https://thisday.info${entity.url}`),
          ),
          globalThis.caches.default.delete(
            new Request("https://thisday.info/sitemap-entities.xml"),
          ),
        );
      }
    } catch {}
    if (
      !env.SUPPRESS_POST_PUBLISH_NOTIFICATIONS &&
      !env.AI_CASSETTE
    ) {
      discoveryTasks.push(fetch("https://thisday.info/search-ping", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(env.SEARCH_PING_SECRET
            ? { Authorization: `Bearer ${env.SEARCH_PING_SECRET}` }
            : {}),
        },
        body: JSON.stringify({
          urls: [
            `https://thisday.info${entity.url}`,
            ...(entity.relatedPosts || []).map(
              (postSlug) => `https://thisday.info/blog/${postSlug}/`,
            ),
          ],
        }),
      }));
    }
    await Promise.allSettled(discoveryTasks);
    result.promoted += 1;
    console.log(
      `Blog AI: promoted evergreen history page ${entity.url} and synced ${entity.relatedPosts?.length || 0} related article(s).`,
    );
  }
  return result;
}

function buildArticleEntityStrip(entityMeta) {
  if (!Array.isArray(entityMeta) || entityMeta.length === 0) return "";
  const normalizedEntityMeta = entityMeta.map(
    normalizeArticleHistoryEntityMeta,
  );
  const people = normalizedEntityMeta.filter((e) => e.type === "person" && e.slug && e.name && !e.skipStrip);
  if (people.length === 0) return "";
  const historyEntity = normalizedEntityMeta.find((entity) =>
    isHistoryEntityDiscoveryLinkEligible(entity),
  );

  const personChips = people.map((e) => {
    // A name can be shown for context, but links require a verified substantive profile.
    const inner =
      `<span class="person-circle">${e.imageUrl
        ? `<img src="/image-proxy?src=${encodeURIComponent(e.imageUrl)}&w=160&h=160&fit=cover&q=80" alt="${esc(e.name)}" loading="lazy" width="80" height="80">`
        : `<span class="person-circle-fallback" aria-hidden="true">${esc(String(e.name).slice(0, 1).toUpperCase())}</span>`
      }</span>` +
      `<span class="person-pill-name">${esc(e.name)}</span>`;
    return hasVerifiedPersonProfileIdentity(e) && e.url
      ? `<a href="${esc(e.url)}" class="person-pill">${inner}</a>`
      : `<span class="person-pill">${inner}</span>`;
  }).join("");
  const historySection = buildArticleHistoryDiscoveryCard(historyEntity);

  return `${ARTICLE_ENTITY_STRIP_STYLE}<div class="entity-strip people-strip" data-entity-strip="1"><div class="entity-strip-content people-track-wrap"><h2 class="h3">People in this story</h2><div class="entity-person-chips people-track">${personChips}</div>${historySection}</div></div>`;
}

function buildArticleHistoryDiscoveryCard(historyEntity) {
  if (!historyEntity?.url || !historyEntity?.name) return "";
  const title =
    String(
      historyEntity.pageHeading ||
      historyEntity.seoTitle ||
      historyEntity.name,
    )
      .replace(/\s+\|\s+thisDay\.\s*$/i, "")
      .trim();
  const description =
    String(
      historyEntity.description ||
      historyEntity.summary ||
      `Read the wider historical context, causes, and consequences of ${historyEntity.name}.`,
    )
      .replace(/\s+/g, " ")
      .trim();
  const image = isProxyableArticleImageUrl(historyEntity.imageUrl)
    ? `<span class="story-topic-card-image"><img src="/image-proxy?src=${encodeURIComponent(historyEntity.imageUrl)}&w=720&h=405&fit=cover&q=82" alt="${esc(historyEntity.name)}" loading="lazy" width="720" height="405"></span>`
    : "";
  return `<section class="story-topic-section" aria-labelledby="story-topic-heading"><h2 class="story-topic-heading" id="story-topic-heading">Explore this event</h2><a href="${esc(historyEntity.url)}" class="story-topic-card${image ? "" : " story-topic-card-no-image"}" data-history-entity-link="1" aria-label="Read the full history: ${esc(title)}">${image}<span class="story-topic-card-copy"><span class="story-topic-kicker">The wider story</span><strong class="story-topic-title">${esc(title)}</strong><span class="story-topic-description">${esc(description)}</span><span class="story-topic-cta">Read the full history <span aria-hidden="true">→</span></span></span></a></section>`;
}

function isSpanishCivilWarHistoryEntity(entity) {
  if (entity?.type !== "event") return false;
  if (
    ["spanish-civil-war-erupts", "spanish-civil-war-1936"].includes(
      String(entity.slug || "").toLowerCase(),
    )
  ) {
    return true;
  }
  try {
    const wikiUrl = new URL(String(entity.wikiUrl || ""));
    const title = decodeURIComponent(
      wikiUrl.pathname.split("/wiki/")[1] || "",
    )
      .replace(/_/g, " ")
      .toLowerCase();
    return [
      "spanish civil war",
      "spanish coup of july 1936",
    ].includes(title);
  } catch {
    return false;
  }
}

function normalizeArticleHistoryEntityMeta(entity) {
  if (!isSpanishCivilWarHistoryEntity(entity)) return entity;
  return {
    ...entity,
    slug: "spanish-civil-war-1936",
    name: "Spanish Civil War, 1936",
    pageHeading:
      "Why Did Spain's July 1936 Coup Fail—and Start a Civil War?",
    description:
      "The coup was designed to replace Spain's government quickly. Its partial failure created rival zones—and a war that lasted until 1939.",
    url: "/history/spanish-civil-war-1936/",
  };
}

function normalizeArticleHistoryDiscoveryCardHtml(body, entityMetaRaw) {
  const html = String(body || "");
  if (!String(entityMetaRaw || "").trim()) {
    return html;
  }
  let entityMeta;
  try {
    entityMeta = JSON.parse(entityMetaRaw);
  } catch {
    return html;
  }
  const historyEntity = (Array.isArray(entityMeta) ? entityMeta : [])
    .map(normalizeArticleHistoryEntityMeta)
    .find((entity) => isHistoryEntityDiscoveryLinkEligible(entity));
  const section = buildArticleHistoryDiscoveryCard(historyEntity);
  if (!section) return html;
  if (html.includes("story-topic-section")) {
    return html.replace(
      /<section class="story-topic-section"[\s\S]*?<\/section>/i,
      section,
    );
  }
  return injectArticleEntityStrip(html, entityMeta);
}

function normalizeHistoryEntityCanonicalLinksHtml(body) {
  return String(body || "")
    .replaceAll(
      'href="/history/spanish-civil-war-erupts/"',
      'href="/history/spanish-civil-war-1936/"',
    )
    .replaceAll(
      "href='/history/spanish-civil-war-erupts/'",
      "href='/history/spanish-civil-war-1936/'",
    );
}

function compactArticleEntityMeta(entityMeta) {
  return (Array.isArray(entityMeta) ? entityMeta : []).map((rawEntity) => {
    const entity = normalizeArticleHistoryEntityMeta(rawEntity);
    return {
      type: entity.type,
      slug: entity.slug,
      name: entity.name,
      imageUrl: entity.imageUrl || "",
      url: entity.url,
      wikiUrl: entity.wikiUrl || "",
      ...(entity.type === "event"
        ? {
            historyLinkEligible: isHistoryEntityDiscoveryLinkEligible(entity),
            ...(isHistoryEntityDiscoveryLinkEligible(entity)
              ? { historyCardQualified: true }
              : {}),
            ...(entity.historyQualityGateVersion
              ? { historyQualityGateVersion: entity.historyQualityGateVersion }
              : {}),
            ...(entity.evergreenHistoryVersion
              ? { evergreenHistoryVersion: entity.evergreenHistoryVersion }
              : {}),
            ...(entity.canonicalIdentity
              ? { canonicalIdentity: entity.canonicalIdentity }
              : {}),
            ...(entity.pageHeading ? { pageHeading: entity.pageHeading } : {}),
            ...(entity.seoTitle ? { seoTitle: entity.seoTitle } : {}),
            ...(entity.description ? { description: entity.description } : {}),
            ...(!entity.description && entity.summary
              ? { summary: entity.summary }
              : {}),
          }
        : {}),
      ...(entity.profileLinkEligible === true ? { profileLinkEligible: true } : {}),
      ...(entity.profileLinkEligible === false ? { profileLinkEligible: false } : {}),
      ...(entity.profileSubjectVerified === true ? { profileSubjectVerified: true } : {}),
      ...(entity.profileSubjectVerified === false ? { profileSubjectVerified: false } : {}),
      ...(entity.wikidataEntityId ? { wikidataEntityId: entity.wikidataEntityId } : {}),
      ...(typeof entity.wikidataInstanceOfHuman === "boolean"
        ? { wikidataInstanceOfHuman: entity.wikidataInstanceOfHuman }
        : {}),
      ...(entity.sourceEventPageFallback === true ? { sourceEventPageFallback: true } : {}),
      ...(entity.isDisambiguation === true ? { isDisambiguation: true } : {}),
      ...(entity.skipImageRepair ? { skipImageRepair: true } : {}),
      ...(entity.skipStrip ? { skipStrip: true } : {}),
    };
  });
}

async function syncEvergreenHistoryDiscoveryForEntity(env, entity) {
  if (
    !env?.BLOG_AI_KV ||
    !isHistoryEntityDiscoveryLinkEligible(entity)
  ) {
    return 0;
  }
  const targetIdentity =
    entity.canonicalIdentity ||
    normalizedWikipediaEntityIdentity(entity.wikiUrl);
  const relatedPosts = [...new Set(
    Array.isArray(entity.relatedPosts)
      ? entity.relatedPosts.filter(Boolean)
      : [],
  )];
  let updatedPosts = 0;
  for (const postSlug of relatedPosts) {
    const metadataKey = `post-entities:${postSlug}`;
    const raw = await env.BLOG_AI_KV.get(metadataKey).catch(() => null);
    if (!raw) continue;
    let metadata;
    try {
      metadata = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(metadata)) continue;
    const matchIndex = metadata.findIndex((candidate) => {
      if (candidate?.type !== "event") return false;
      const candidateIdentity =
        candidate.canonicalIdentity ||
        normalizedWikipediaEntityIdentity(candidate.wikiUrl);
      return Boolean(
        targetIdentity &&
        candidateIdentity &&
        candidateIdentity === targetIdentity,
      );
    });
    if (matchIndex === -1) continue;
    const nextMetadata = metadata.slice();
    nextMetadata[matchIndex] = compactArticleEntityMeta([entity])[0];
    const compact = compactArticleEntityMeta(nextMetadata);
    const compactRaw = JSON.stringify(compact);
    if (compactRaw !== raw) {
      await env.BLOG_AI_KV.put(metadataKey, compactRaw);
    }

    const postKey = `${KV_POST_PREFIX}${postSlug}`;
    const postHtml = await env.BLOG_AI_KV.get(postKey).catch(() => null);
    if (postHtml) {
      const nextHtml = injectArticleEntityStrip(postHtml, compact);
      if (nextHtml !== postHtml) {
        await env.BLOG_AI_KV.put(postKey, nextHtml);
      }
    }
    updatedPosts += 1;
    try {
      if (globalThis.caches?.default) {
        await globalThis.caches.default.delete(
          new Request(`https://thisday.info/blog/${postSlug}/`),
        );
      }
    } catch {}
  }
  return updatedPosts;
}

function injectArticleEntityStrip(html, entityMeta) {
  const strip = buildArticleEntityStrip(entityMeta);
  if (!strip) return html;
  let updated = String(html || "");
  if (updated.includes('data-entity-strip="1"')) {
    return replaceArticleEntityStripHtml(updated, strip);
  }
  const heroWrapIdx = updated.indexOf('<div class="article-hero-wrap">');
  const heroWrapEnd = findArticleHeroWrapEnd(updated, heroWrapIdx);
  if (heroWrapEnd !== -1) {
    return updated.slice(0, heroWrapEnd) + "\n" + strip + updated.slice(heroWrapEnd);
  }
  const answerIdx = updated.indexOf('<section class="ai-answer-card');
  if (answerIdx !== -1) {
    return updated.slice(0, answerIdx) + strip + "\n" + updated.slice(answerIdx);
  }
  return updated;
}

function countHtmlMatches(source, pattern) {
  return (String(source || "").match(pattern) || []).length;
}

function extractArticleEntityStripHtml(html) {
  const source = String(html || "");
  const range = findArticleEntityStripRange(source);
  return range ? source.slice(range.start, range.end) : "";
}

function addHtmlClassToken(classNames, token) {
  const values = String(classNames || "")
    .split(/\s+/)
    .filter(Boolean);
  if (!values.includes(token)) values.push(token);
  return values.join(" ");
}

function normalizeArticleEntityStripPresentationHtml(body) {
  const html = String(body || "");
  const range = findArticleEntityStripRange(html);
  if (!range) return html;

  let strip = html.slice(range.start, range.end);
  if (/^<style>\.entity-strip\{/i.test(strip)) {
    strip = strip.replace(
      /^<style>\.entity-strip\{[\s\S]*?<\/style>/i,
      ARTICLE_ENTITY_STRIP_STYLE,
    );
  } else {
    strip = ARTICLE_ENTITY_STRIP_STYLE + strip;
  }
  strip = strip.replace(
    /<div class="([^"]*\bentity-strip\b[^"]*)" data-entity-strip="1">/i,
    (_match, classes) =>
      `<div class="${addHtmlClassToken(classes, "people-strip")}" data-entity-strip="1">`,
  );
  strip = strip.replace(
    /class="([^"]*\bentity-strip-content\b[^"]*)"/i,
    (_match, classes) =>
      `class="${addHtmlClassToken(classes, "people-track-wrap")}"`,
  );
  strip = strip.replace(
    /class="([^"]*\bentity-person-chips\b[^"]*)"/i,
    (_match, classes) =>
      `class="${addHtmlClassToken(classes, "people-track")}"`,
  );
  strip = strip
    .replaceAll(
      "w=120&h=120&fit=cover&q=80",
      "w=160&h=160&fit=cover&q=80",
    )
    .replaceAll(
      "w=120&amp;h=120&amp;fit=cover&amp;q=80",
      "w=160&amp;h=160&amp;fit=cover&amp;q=80",
    )
    .replace(
      /(<span class="person-circle"><img\b)([^>]*)(>)/gi,
      (_match, start, attributes, end) => {
        let normalized = attributes;
        if (!/\bwidth="/i.test(normalized)) normalized += ' width="80"';
        if (!/\bheight="/i.test(normalized)) normalized += ' height="80"';
        return start + normalized + end;
      },
    );

  return html.slice(0, range.start) + strip + html.slice(range.end);
}

function articleEntityStripNeedsImageRepair(html) {
  const strip = extractArticleEntityStripHtml(html);
  if (!strip) return false;
  const linkedCards = [...strip.matchAll(/<a\b[^>]*class="person-pill"[\s\S]*?<\/a>/gi)]
    .map((match) => match[0]);
  return linkedCards.some((card) =>
    /person-circle-fallback/i.test(card) || !/class="person-circle"><img\b/i.test(card),
  );
}

function articleEntityStripNeedsProfileValidation(html, entityMetaRaw) {
  const strip = extractArticleEntityStripHtml(html);
  // Trigger on ANY person pill — linked OR unlinked. A budget-starved generation
  // often stores every person unlinked (a plain <span class="person-pill">), but a
  // canonical entity-v1 record created later by backfill/recovery can make them
  // eligible. Serve-time hydration reads those records and relinks + adds the
  // portrait. The old `<a class="person-pill">`-only test froze all-unlinked strips
  // forever (2026-06-26: Napoleon et al. stayed unlinked despite a complete record).
  if (!/class="person-pill"/i.test(strip)) return false;
  if (!entityMetaRaw) return true;
  try {
    return JSON.parse(entityMetaRaw).some((entity) =>
      entity?.type === "person" &&
      !hasVerifiedPersonProfileIdentity(entity) &&
      entity?.wikidataInstanceOfHuman !== false &&
      entity?.isDisambiguation !== true,
    );
  } catch {
    return true;
  }
}

function amazonTracksNeedCoverBackfill(html) {
  const tracks = [...String(html || "").matchAll(/<div class="amazon-slider-track"[^>]*>([\s\S]*?)<\/div>/gi)];
  if (tracks.length === 0) return false;
  return tracks.some(([, track]) => {
    const cardCount = countHtmlMatches(track, /class="amazon-product-card"/gi);
    if (cardCount === 0) return false;
    const coverCount = countHtmlMatches(track, /class="amazon-card-cover"><img\b/gi);
    return /data-amazon-fallback="1"/i.test(track) || coverCount < Math.min(3, cardCount);
  });
}

function assertRequiredContentBlocks(content) {
  const quickFacts = (Array.isArray(content.quickFacts) ? content.quickFacts : []).filter(
    (fact) =>
      fact &&
      typeof fact === "object" &&
      String(fact.label || "").trim() &&
      String(fact.value || "").trim(),
  );
  const namedPeople = (Array.isArray(content.keyTerms) ? content.keyTerms : []).filter(
    (term) =>
      term &&
      String(term.type || "").toLowerCase() === "person" &&
      String(term.term || "").trim(),
  );
  const analysisCount = (items) =>
    (Array.isArray(items) ? items : []).filter(
      (item) =>
        item &&
        typeof item === "object" &&
        String(item.title || "").trim() &&
        String(item.detail || "").trim(),
    ).length;
  const missing = [];
  if (quickFacts.length < 6) missing.push("six populated quick facts");
  const didYouKnowAudit = auditDidYouKnowFacts(content);
  if (!didYouKnowAudit.ok) {
    missing.push(`five distinct did-you-know facts (${didYouKnowAudit.reasons.join("; ")})`);
  }
  if (namedPeople.length < 1) missing.push("one named person for the people strip");
  if (analysisCount(content.analysisGood) < 3) missing.push("three positive analysis items");
  if (analysisCount(content.analysisBad) < 3) missing.push("three critical analysis items");
  const bodyWords = articleBodyWordCount(content);
  if (bodyWords < MIN_REAL_ARTICLE_BODY_WORDS) {
    missing.push(`${MIN_REAL_ARTICLE_BODY_WORDS}+ words of article body (got ${bodyWords})`);
  }
  if (missing.length > 0) {
    throw new Error(`Article content check failed: missing ${missing.join(", ")}`);
  }
}

function visibleRawUrlsInRenderedHtml(html) {
  const body = String(html || "").match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1] || "";
  const visibleText = body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<[^>]+>/g, " ");
  return rawUrlsInVisibleText(visibleText);
}

/**
 * Tier 1 — hard structural check. Throws if any required element generated
 * entirely from local draft content is missing. These never depend on external
 * network calls so a failure means buildPostHTML broke, not a transient error.
 */
function assertArticleStructure(html) {
  const source = String(html || "");
  const quickFactCount = countHtmlMatches(source, /<div class="ai-answer-item"><strong>[^<\s][^<]*<\/strong><span>[^<\s][^<]*<\/span><\/div>/gi);
  const didYouKnowCount = countHtmlMatches(source, /class="dyn-fact">[^<\s][^<]*<\/p>/gi);
  const analysisItemCount = countHtmlMatches(source, /<li class="mb-2"><strong>[^<:\s][^<]*:<\/strong>\s*[^<\s]/gi);
  const evidenceMapRowCount = countHtmlMatches(source, /class="evidence-map-row"/gi);
  const checks = [
    ["article shell", /<article\b/i],
    ["hero image area", /article-hero-wrap/i],
    ["featured hero image", /<figure\b[^>]*class="[^"]*\barticle-hero-fig\b[^"]*"[\s\S]*?<img\b[^>]*\bsrc="\/image-proxy\?src=/i],
    ["featured image alt text", /<figure\b[^>]*class="[^"]*\barticle-hero-fig\b[^"]*"[\s\S]*?<img\b[^>]*\balt="[^"]{5,}"/i],
    ["short answer card", /ai-answer-card/i],
    ["did you know section", /<h2 class="h3">Did You Know\?<\/h2>/i],
    ["source-backed evidence map", /<section class="article-evidence-map\b/i],
    ["original-value module", /data-original-value-module="(?:sourced-timeline|source-comparison)"/i],
    ["evidence-map central claim", /class="evidence-map-claim"[\s\S]*?<strong>Central claim checked:<\/strong>\s*[^<\s]/i],
    ["independent evidence-map source", /data-evidence-role="independent"/i],
    ["analysis section", /<h2 class="h3">Analysis:/i],
    ["collapsed analysis disclosure", /<details class="analysis-disclosure\b/i],
    ["people entity strip", /data-entity-strip="1"/i],
    ["people entity card", /class="person-pill"/i],
  ];
  const missing = checks
    .filter(([, pattern]) => !pattern.test(source))
    .map(([label]) => label);
  if (quickFactCount < 6) missing.push("six rendered key facts");
  if (didYouKnowCount < 5) missing.push("five rendered did-you-know cards");
  if (evidenceMapRowCount < 2) missing.push("two rendered evidence-map source rows");
  if (analysisItemCount < 6) missing.push("six rendered analysis items");
  const visibleRawUrls = visibleRawUrlsInRenderedHtml(source);
  if (visibleRawUrls.length > 0) {
    missing.push(`no raw URLs in visible article text (found ${visibleRawUrls[0]})`);
  }
  if (missing.length > 0) {
    throw new Error(`Article structure check failed: missing ${missing.join(", ")}`);
  }
}

/**
 * Tier 2 — soft asset-quality check. Returns a list of human-readable
 * warnings and the original html unchanged. Never throws and never adds
 * backfill markers — the repair triggers on the page-serve path check for
 * the ABSENCE of those markers to know whether to run. Adding them here
 * would tell the repair system "already done" and suppress the backfill.
 */
function softCheckArticleAssets(html, content) {
  const source = String(html || "");
  const issues = [];

  const hasPersonTerms = (content.keyTerms || []).some(
    (term) => String(term?.type || "").toLowerCase() === "person" && term?.term,
  );

  // Entity strip — repair trigger fires on page view when marker is absent
  if (hasPersonTerms && !/data-entity-strip="1"/i.test(source)) {
    issues.push("missing people entity strip (will backfill on page view)");
  } else if (hasPersonTerms) {
    const strip = extractArticleEntityStripHtml(source);
    if (strip) {
      const linkedCards = [...strip.matchAll(/<a\b[^>]*class="person-pill"[\s\S]*?<\/a>/gi)]
        .map((match) => match[0]);
      const fallbackCount = linkedCards.filter((card) => /person-circle-fallback/i.test(card)).length;
      const imageCount = linkedCards.filter((card) => /class="person-circle"><img\b/i.test(card)).length;
      if (linkedCards.length > 0 && fallbackCount > 0) {
        issues.push(`linked people entity strip has ${fallbackCount} fallback avatar(s) (will repair)`);
      } else if (linkedCards.length > 0 && imageCount < linkedCards.length) {
        issues.push(`linked people entity strip has ${imageCount}/${linkedCards.length} real image(s) (will repair)`);
      }
    }
  }

  // Amazon covers — repair trigger fires on page view when marker is absent + fallbacks present
  const amazonTrack = source.match(/<div class="amazon-slider-track"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || "";
  if (amazonTrack) {
    const amazonCards = countHtmlMatches(amazonTrack, /class="amazon-product-card"/gi);
    const amazonCovers = countHtmlMatches(amazonTrack, /class="amazon-card-cover"><img\b/gi);
    if (amazonCards > 0 && amazonCovers < Math.min(3, amazonCards)) {
      issues.push(`Amazon covers ${amazonCovers}/${amazonCards} (will backfill on page view)`);
    }
  }

  return { html: source, issues };
}

function extractArticlePeopleMetaFromHtml(html) {
  const source = String(html || "");
  const people = [];
  const seen = new Set();
  const personRe = /\{\s*"@type"\s*:\s*"Person"[\s\S]*?\}/g;
  let match;

  while ((match = personRe.exec(source)) && people.length < 6) {
    const block = match[0] || "";
    const nameMatch = block.match(/"name"\s*:\s*"([^"]+)"/);
    const sameAsMatch = block.match(/"sameAs"\s*:\s*"(https:?\\?\/\\?\/en\.wikipedia\.org\\?\/wiki\\?\/[^"]+)"/);
    const name = unesc(String(nameMatch?.[1] || "").replace(/\\"/g, '"')).trim();
    const wikiUrl = String(sameAsMatch?.[1] || "").replace(/\\\//g, "/");
    const slug = entitySlug(name);
    if (!name || !slug || seen.has(slug)) continue;
    seen.add(slug);
    people.push({
      type: "person",
      slug,
      name,
      imageUrl: "",
      wikiUrl,
      url: `/people/${slug}/`,
    });
  }

  return people;
}

async function hydrateArticleEntityImages(env, entityMeta) {
  if (!Array.isArray(entityMeta) || !env?.BLOG_AI_KV) return entityMeta;
  let changed = false;
  const hydrated = [];

  for (const item of entityMeta) {
    const next = { ...item };
    if (next.type === "person" && next.slug && next.name) {
      const key = `${KV_ENTITY_PREFIX}person:${next.slug}`;
      const record = await env.BLOG_AI_KV.get(key, { type: "json" }).catch(() => null);
      const anchoredWikiUrl = record?.wikiUrl || next.wikiUrl || "";
      let identityRecord = record;
      let profile = (
        record?.profileLinkEligible === true &&
        record?.profileSubjectVerified === true &&
        hasRichWikipediaPersonProfile(record)
      ) ? record : null;

      // Legacy records did not store Wikidata identity evidence, so revalidate
      // their source once. A stored false result prevents repeated subrequests.
      if (
        !profile &&
        anchoredWikiUrl &&
        record?.wikidataInstanceOfHuman !== false
      ) {
        const freshWiki = await fetchWikipediaEntityData({
          wikiUrl: anchoredWikiUrl,
          term: next.name,
          type: "person",
        }).catch(() => ({}));
        const candidate = {
          ...(record || {}),
          ...next,
          ...freshWiki,
          type: "person",
          wikiUrl: anchoredWikiUrl,
        };
        if (hasRichWikipediaPersonProfile(candidate)) {
          profile = {
            ...candidate,
            profileLinkEligible: true,
            profileSubjectVerified: true,
          };
          void optionalBlogKvPut(env, key, JSON.stringify(profile));
        } else if (
          record &&
          (
            typeof candidate.wikidataInstanceOfHuman === "boolean" ||
            candidate.isDisambiguation === true
          )
        ) {
          const rejectedProfile = {
            ...candidate,
            profileLinkEligible: false,
            profileSubjectVerified: false,
            updatedAt: new Date().toISOString(),
          };
          identityRecord = rejectedProfile;
          void optionalBlogKvPut(
            env,
            key,
            JSON.stringify(rejectedProfile),
          );
        }
      }

      if (!profile) {
        const displayOnly = unlinkedArticlePerson({
          ...next,
          ...(identityRecord?.wikidataEntityId
            ? { wikidataEntityId: identityRecord.wikidataEntityId }
            : {}),
          ...(typeof identityRecord?.wikidataInstanceOfHuman === "boolean"
            ? {
                wikidataInstanceOfHuman:
                  identityRecord.wikidataInstanceOfHuman,
              }
            : {}),
          ...(identityRecord?.isDisambiguation === true
            ? { isDisambiguation: true }
            : {}),
        });
        if (JSON.stringify(next) !== JSON.stringify(displayOnly)) changed = true;
        hydrated.push(displayOnly);
        continue;
      }

      if (
        next.profileLinkEligible !== true ||
        next.profileSubjectVerified !== true ||
        next.wikiUrl !== profile.wikiUrl ||
        !next.url
      ) {
        next.profileLinkEligible = true;
        next.profileSubjectVerified = true;
        next.wikiUrl = profile.wikiUrl;
        next.url = profile.url || `/people/${next.slug}/`;
        delete next.skipImageRepair;
        delete next.skipStrip;
        changed = true;
      }
      if (
        profile.wikidataEntityId &&
        next.wikidataEntityId !== profile.wikidataEntityId
      ) {
        next.wikidataEntityId = profile.wikidataEntityId;
        changed = true;
      }
      if (
        typeof profile.wikidataInstanceOfHuman === "boolean" &&
        next.wikidataInstanceOfHuman !== profile.wikidataInstanceOfHuman
      ) {
        next.wikidataInstanceOfHuman = profile.wikidataInstanceOfHuman;
        changed = true;
      }
      if (
        profile.sourceEventPageFallback === true &&
        next.sourceEventPageFallback !== true
      ) {
        next.sourceEventPageFallback = true;
        changed = true;
      }
      if (profile.imageUrl && next.imageUrl !== profile.imageUrl) {
        next.imageUrl = profile.imageUrl;
        changed = true;
      }
      if (!next.imageUrl && next.wikiUrl) {
        const imageUrl = await fetchWikipediaImage(next.name, next.wikiUrl, { skipCommonsSearch: true });
        if (imageUrl) {
          next.imageUrl = imageUrl;
          changed = true;
          profile.imageUrl = imageUrl;
          void optionalBlogKvPut(env, key, JSON.stringify(profile));
        }
      }
    }
    hydrated.push(next);
  }

  return changed ? hydrated : entityMeta;
}

// ---------------------------------------------------------------------------
// Blog quiz generation
// ---------------------------------------------------------------------------

function buildDeterministicBlogQuiz(content) {
  const facts = (Array.isArray(content?.quickFacts) ? content.quickFacts : [])
    .map((fact) => ({
      label: String(fact?.label || "").trim(),
      value: String(fact?.value || "").replace(/\s+/g, " ").trim(),
    }))
    .filter((fact) => fact.label && fact.value);
  const uniqueValues = [...new Set(facts.map((fact) => fact.value))];
  if (facts.length < 5 || uniqueValues.length < 4) return null;

  const preferredLabels = ["Event", "Date", "Location", "Key Figure", "Significance", "Legacy"];
  const selected = preferredLabels
    .map((label) => facts.find((fact) => fact.label.toLowerCase() === label.toLowerCase()))
    .filter(Boolean)
    .slice(0, 5);
  for (const fact of facts) {
    if (selected.length >= 5) break;
    if (!selected.includes(fact)) selected.push(fact);
  }
  if (selected.length !== 5) return null;

  const questionFor = (fact) => {
    const label = fact.label.toLowerCase();
    if (label === "event") return "Which event is the article about?";
    if (label === "date") return "On what date did the article's central event occur?";
    if (label === "location") return "Which location does the article identify for the event?";
    if (label === "key figure") return "Who does the article identify as the key figure?";
    if (label === "significance") return "Which significance does the article assign to the event?";
    if (label === "legacy") return "Which legacy does the article associate with the event?";
    return `Which value does the article give for ${fact.label}?`;
  };

  const questions = selected.map((fact, index) => {
    const distractors = uniqueValues
      .filter((value) => value !== fact.value)
      .slice(index % uniqueValues.length)
      .concat(uniqueValues.filter((value) => value !== fact.value))
      .filter((value, valueIndex, values) => values.indexOf(value) === valueIndex)
      .slice(0, 3);
    if (distractors.length !== 3) return null;
    const answer = index % 4;
    const options = [...distractors];
    options.splice(answer, 0, fact.value);
    return {
      q: questionFor(fact),
      options,
      answer,
      explanation: `The article's ${fact.label} Quick Fact gives ${fact.value}.`,
    };
  });
  if (questions.some((question) => !question) || !validateQuizQuestions(questions)) {
    return null;
  }
  return { questions, groundedDeterministically: true };
}

function isLowQualityBlogQuizQuestion(questionText) {
  const text = String(questionText || "").replace(/\s+/g, " ").trim().toLowerCase();
  return [
    /^which event is the article about\??$/,
    /^on what date did the article'?s central event occur\??$/,
    /^which location does the article identify for the event\??$/,
    /^who does the article identify as the key figure\??$/,
    /^which significance does the article assign to the event\??$/,
    /^which legacy does the article associate with the event\??$/,
    /^which value does the article give for\b/,
  ].some((pattern) => pattern.test(text));
}

/**
 * Quiz Expert — uses Cloudflare Workers AI (same free binding as quiz generation)
 * to review and sharpen quiz questions after the initial generation pass.
 *
 * Goals:
 *   - Replace trivially easy recall questions with analytical or synthesis ones
 *   - Make wrong options plausible (same era, same field, genuinely confusable)
 *   - Ensure at least 3 of 5 questions require knowing a non-obvious fact
 *   - Preserve question variety (Who / What / Why+How / When+Where)
 *   - Keep the exact JSON schema unchanged so the frontend works without changes
 *
 * Falls back silently to original questions if the AI binding is absent,
 * the response is malformed, or validation fails.
 *
 * @param {Array}  questions  Validated questions from generateBlogQuiz()
 * @param {object} content    Rich content object (title, keyFacts, etc.)
 * @param {object} env        Worker environment bindings
 * @returns {Promise<Array>}  Improved questions, or originals on any failure
 */
async function reviewQuizWithExpert(questions, content, env) {
  if (!hasAnyTextAIProvider(env)) return questions;

  const sourceMaterial = sourceMaterialForGrounding(groundingSourceFromContent(content));
  const contextLines = [
    `Title: ${content.title}`,
    content.historicalDate ? `Date: ${content.historicalDate}` : "",
    sourceMaterial ? `Authoritative source material:\n${sourceMaterial}` : "",
    ...(content.keyFacts || []).slice(0, 12).map((f) => `Fact: ${f}`),
  ]
    .filter(Boolean)
    .join("\n");

  let systemPrompt =
    "You are a rigorous history quiz editor. You receive a 5-question multiple-choice quiz " +
    "and a set of historical facts. Your job is to make the quiz harder and more educational " +
    "without changing its structure.\n\n" +
    "Rules:\n" +
    "- Keep all 5 questions, same order\n" +
    "- Keep the same JSON schema: {q, options, answer, explanation}\n" +
    "- answer is still a 0-based index (0-3) into options\n" +
    "- Make trivially easy questions harder by asking for a less obvious detail\n" +
    "- Wrong options must be plausible: same era, same country, same field — not obviously wrong\n" +
    "- At least 3 questions should require knowing a non-obvious fact, not just re-reading the title\n" +
    "- Never trick or mislead — every correct answer must be clearly supported by the facts provided\n" +
    "- Never merge distinct actions, dates, or places. Recognition in one town and arrest in another must remain separate\n" +
    "- The authoritative source material wins over article prose when they conflict\n" +
    "- Update the explanation to match any changes\n" +
    '- Output ONLY valid JSON, no markdown: {"questions":[...]}';

  // Punctuation guidance: ensure quiz text uses commas/semicolons rather than
  // in-sentence hyphens or em dashes. If you find '-' or '—' inside a sentence,
  // replace with a comma or rewrite for clarity.
  systemPrompt +=
    "\n\nPUNCTUATION NOTE: Never use hyphens (-) or em dashes (—) anywhere in the text. Zero dashes. Use a comma or split into two sentences.";

  const userMessage =
    `Historical context:\n${contextLines}\n\n` +
    `Current quiz (JSON):\n${JSON.stringify({ questions }, null, 2)}\n\n` +
    `Return the improved quiz as JSON: {"questions":[{"q":"...","options":["A","B","C","D"],"answer":0,"explanation":"..."}]}`;

  let raw;
  try {
    raw = await callPublicationGateAI(
      env,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      { maxTokens: 2000, timeoutMs: 25_000 },
    );
  } catch (err) {
    console.warn(
      `Quiz expert: AI call failed (${err.message}) — using original questions`,
    );
    return questions;
  }
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    console.warn(
      "Quiz expert: no JSON object in response — using original questions",
    );
    return questions;
  }

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    console.warn("Quiz expert: JSON parse error — using original questions");
    return questions;
  }

  const improved = parsed?.questions;
  if (!validateQuizQuestions(improved, questions.length)) {
    console.warn("Quiz expert: validation failed — using original questions");
    return questions;
  }

  console.log("Quiz expert: questions reviewed and sharpened");
  return improved;
}

function validateQuizQuestions(questions, expectedLength = 5) {
  return Array.isArray(questions) &&
    questions.length === expectedLength &&
    questions.every(
      (q) =>
        typeof q?.q === "string" &&
        q.q.trim().length > 10 &&
        Array.isArray(q.options) &&
        q.options.length === 4 &&
        q.options.every((option) => typeof option === "string" && option.trim().length > 2) &&
        Number.isInteger(q.answer) &&
        q.answer >= 0 &&
        q.answer <= 3 &&
        typeof q.explanation === "string" &&
        q.explanation.trim().length > 8 &&
        !isLowQualityBlogQuizQuestion(q.q),
    );
}

function parseValidBlogQuiz(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return validateQuizQuestions(parsed?.questions) ? parsed : null;
  } catch {
    return null;
  }
}

async function verifyQuizGrounding(env, questions, content) {
  const sourceMaterial = sourceMaterialForGrounding(groundingSourceFromContent(content));
  if (!sourceMaterial) return { ok: true, reasons: [] };
  const articleFacts = [
    content?.description,
    ...(content?.keyFacts || []),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 9000);
  try {
    const raw = await callPublicationGateAI(
      env,
      [
        {
          role: "system",
          content:
            "You are a fail-closed history quiz fact checker. Check every correct answer and explanation against the source and article facts. Reply with JSON only.",
        },
        {
          role: "user",
          content:
            `AUTHORITATIVE SOURCE MATERIAL:\n${sourceMaterial}\n\n` +
            `ARTICLE FACTS:\n${articleFacts}\n\n` +
            `QUIZ:\n${JSON.stringify({ questions })}\n\n` +
            "Reject any wrong answer index, factual contradiction, unsupported precise claim, or conflation of distinct people, dates, or places. " +
            "Pay special attention to recognition versus arrest locations. Return exactly " +
            '{"passed":true,"issues":[]} or {"passed":false,"issues":["question 4: specific issue"]}.',
        },
      ],
      { maxTokens: 600, timeoutMs: 20_000 },
    );
    const match = raw?.match(/\{[\s\S]*\}/);
    if (!match) return { ok: false, reasons: ["quiz grounding verifier returned no JSON"] };
    const result = JSON.parse(match[0]);
    const issues = Array.isArray(result.issues)
      ? result.issues.map((issue) => String(issue).trim()).filter(Boolean)
      : [];
    return result.passed === true && issues.length === 0
      ? { ok: true, reasons: [] }
      : { ok: false, reasons: issues.length ? issues : ["quiz grounding verifier rejected the quiz"] };
  } catch (err) {
    return { ok: false, reasons: [`quiz grounding verifier unavailable: ${err.message}`] };
  }
}

async function repairQuizGrounding(env, questions, content, reasons) {
  const sourceMaterial = sourceMaterialForGrounding(groundingSourceFromContent(content));
  if (!sourceMaterial) return null;
  try {
    const raw = await callPublicationGateAI(
      env,
      [
        {
          role: "system",
          content:
            "You repair factual errors in history quizzes. Preserve exactly five questions and the {q,options,answer,explanation} schema. Reply with JSON only.",
        },
        {
          role: "user",
          content:
            `AUTHORITATIVE SOURCE MATERIAL:\n${sourceMaterial}\n\n` +
            `FACT-CHECK ISSUES:\n${reasons.join("\n")}\n\n` +
            `QUIZ TO REPAIR:\n${JSON.stringify({ questions })}\n\n` +
            "Correct every issue. Each question must have four options and one 0-based answer index. Do not introduce facts absent from the source material. Return {\"questions\":[...] }.",
        },
      ],
      { maxTokens: 1800, timeoutMs: 25_000 },
    );
    const match = raw?.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    return validateQuizQuestions(parsed?.questions) ? parsed.questions : null;
  } catch (err) {
    console.warn(`Quiz grounding repair failed: ${err.message}`);
    return null;
  }
}

// Fetch a blog post's HTML and extract rich context for quiz generation
async function extractRichContext(slug) {
  try {
    const res = await fetch(`https://thisday.info/blog/${slug}`, {
      headers: { "User-Agent": "thisday-quiz-bot/1.0" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const ctx = {};
    // Quick facts table: <th>…</th> … <td>…</td>
    const factRows = [
      ...html.matchAll(
        /<th[^>]*>([\s\S]*?)<\/th>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/gi,
      ),
    ];
    ctx.quickFacts = factRows
      .map(
        ([, k, v]) =>
          `${k.replace(/<[^>]+>/g, "").trim()}: ${v.replace(/<[^>]+>/g, "").trim()}`,
      )
      .filter(Boolean);
    // Did You Know + analysis list items — grab informative <li> items (>40 chars)
    const liItems = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
      .map(([, v]) =>
        v
          .replace(/<[^>]+>/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter((s) => s.length > 40 && s.length < 400);
    ctx.facts = liItems.slice(0, 12);
    // Article paragraphs from <p> tags inside the article (skip very short ones)
    const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map(([, v]) =>
        v
          .replace(/<[^>]+>/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter((s) => s.length > 80 && s.length < 750);
    ctx.paragraphs = paras.slice(0, 6);
    return ctx;
  } catch (e) {
    return null;
  }
}

// Build a rich content object for quiz generation from index entry + parsed HTML
async function buildRichContent(entry, slug) {
  const titleParts = (entry.title || slug).split(" - ");
  const base = {
    title: entry.title || slug,
    eventTitle: titleParts[0] || entry.title || slug,
    historicalDate: titleParts[1] || "",
    location: "",
    country: "",
    description: entry.description || entry.title || "",
    keyFacts: [],
  };
  const rich = await extractRichContext(slug);
  if (rich) {
    if (rich.quickFacts?.length) {
      const locFact = rich.quickFacts.find((f) => /^Location:/i.test(f));
      if (locFact) {
        const parts = locFact
          .replace(/^Location:\s*/i, "")
          .split(",")
          .map((s) => s.trim());
        base.location = parts[0] || "";
        base.country = parts[1] || "";
      }
      // Put rich Did You Know / analysis facts FIRST — they produce better questions
      // Quick facts (date, name) go last so the AI focuses on the interesting content
      base.keyFacts = [...(rich.facts || []), ...rich.quickFacts].slice(0, 15);
    } else if (rich.facts?.length) {
      base.keyFacts = rich.facts.slice(0, 15);
    }
    if (rich.paragraphs?.length)
      base.description = rich.paragraphs
        .slice(0, 3)
        .join(" ")
        .substring(0, 800);
  }
  return base;
}

async function generateBlogQuiz(env, content, _slug) {
  if (!hasAnyTextAIProvider(env)) return null;

  const quizSourceMaterial = sourceMaterialForGrounding(groundingSourceFromContent(content));
  const contextLines = [
    `Title: ${content.title}`,
    `Event: ${content.eventTitle} on ${content.historicalDate}`,
    quizSourceMaterial ? `Authoritative source material: ${quizSourceMaterial}` : "",
    content.location || content.country
      ? `Location: ${[content.location, content.country].filter(Boolean).join(", ")}`
      : "",
    content.description
      ? `Summary: ${content.description.replace(/Published:.*?min read\s*/s, "").substring(0, 400)}`
      : "",
    ...(content.keyFacts || []).slice(0, 15).map((f) => `Fact: ${f}`),
  ].filter(Boolean);

  // Skip AI only if we have truly nothing beyond title/event line
  const factLines = contextLines.filter(
    (l) => l.startsWith("Fact:") || l.startsWith("Summary:"),
  );
  if (factLines.length < 1) {
    console.error(
      `Blog quiz: no context for "${content.title}" — skipping AI call`,
    );
    return null;
  }

  let raw;
  try {
    raw = await callPublicationGateAI(
      env,
      [
        {
          role: "system",
          content:
            "You are a history quiz creator. Always respond with valid JSON only, no markdown, no extra text.",
        },
        {
          role: "user",
          content: `Generate a 5-question multiple choice quiz based on this historical blog post.\n\nContext:\n${contextLines.join("\n")}\n\nRules:\n- Exactly 5 questions, no more no less\n- Each question has exactly 4 options (never fewer, never more)\n- Exactly one correct answer per question (0-based index in "answer", must be 0, 1, 2, or 3)\n- Question types must vary: include at least one each of Who, What, Why/How, When/Where\n- Questions must progress: 1 easy recall, 2 medium analysis, 2 challenging synthesis\n- Draw from ALL Fact lines — do not repeat the same topic twice\n- The authoritative source material wins over the article summary or facts if they conflict\n- Keep recognition, arrest, capture, departure, arrival, and death locations and dates distinct\n- Wrong options must be plausible but clearly incorrect; no trick questions\n- Each question must include a short "explanation" field (1-2 sentences) explaining why the answer is correct\n- All strings must be non-empty and longer than 5 characters\n- Output ONLY valid JSON, no markdown:\n{"questions":[{"q":"Question?","options":["A","B","C","D"],"answer":0,"explanation":"Why this answer is correct."}]}`,
        },
      ],
      { maxTokens: 2200, timeoutMs: 25_000 },
    );
  } catch (err) {
    console.error("Blog quiz: AI call failed —", err.message);
    return null;
  }
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!objMatch) return null;
  let parsed;
  try {
    parsed = JSON.parse(objMatch[0]);
  } catch (parseErr) {
    console.error("Blog quiz JSON.parse failed:", parseErr);
    return null;
  }
  if (!Array.isArray(parsed?.questions) || parsed.questions.length !== 5)
    return null;
  if (!validateQuizQuestions(parsed.questions)) return null;
  const sharpened = await reviewQuizWithExpert(parsed.questions, content, env);
  let grounding = await verifyQuizGrounding(env, sharpened, content);
  if (grounding.ok) return { ...parsed, questions: sharpened };
  console.warn(`Quiz grounding check failed: ${grounding.reasons.join("; ")}`);
  const repaired = await repairQuizGrounding(env, sharpened, content, grounding.reasons);
  if (!repaired) return null;
  grounding = await verifyQuizGrounding(env, repaired, content);
  if (!grounding.ok) {
    console.warn(`Quiz grounding recheck failed: ${grounding.reasons.join("; ")}`);
    return null;
  }
  return { ...parsed, questions: repaired };
}

// ---------------------------------------------------------------------------
// Claude API call
// ---------------------------------------------------------------------------

function normalizeGeneratedArticleContent(parsed, date) {
  const monthName = MONTH_NAMES[date.getMonth()];
  const day = date.getDate();

  // Enforce that the title always follows the format "Event Name — Month Day, Year".
  // The AI sometimes omits the date, uses wrong format, or uses colloquial date names.
  // Derive the historical year from the content (historicalYear → ISO → date →
  // title). Never silently default to date.getFullYear(): the publication year is
  // not the event's year, and doing so re-stamps the current year every year. Only
  // fall back when the model returned no year anywhere, and warn loudly so the
  // degenerate output is visible.
  let year = deriveHistoricalYear(parsed);
  if (!Number.isInteger(year)) {
    year = date.getFullYear();
    console.warn(
      `Blog: no historical year in AI output for ${date.toISOString().slice(0, 10)} — falling back to publication year ${year}`,
    );
  }
  const expectedDateSuffix = `${monthName} ${day}, ${year}`;
  const hasSeparator = parsed.title && parsed.title.includes(" — ");
  if (
    !parsed.title ||
    !parsed.title.includes(expectedDateSuffix) ||
    !hasSeparator
  ) {
    parsed.title = buildDisplayTitle(
      parsed.title,
      parsed.eventTitle ?? "Untitled",
      expectedDateSuffix,
    );
  }

  // Normalise fields that must be strings — the model occasionally returns arrays.
  if (Array.isArray(parsed.keywords)) parsed.keywords = parsed.keywords.join(", ");
  if (typeof parsed.keywords !== "string") parsed.keywords = String(parsed.keywords || "");
  if (typeof parsed.curiosityTitle === "string") {
    parsed.curiosityTitle = normalizeCuriosityTitleText(parsed.curiosityTitle);
  }

  enforceAnswerFirstSections(parsed);

  // Truncation audit: chunked or one-shot, generated paragraph arrays must end
  // cleanly. Validation later decides whether the article can be stored.
  for (const field of ARTICLE_BODY_FIELDS) {
    const arr = parsed[field];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const last = String(arr[arr.length - 1] || "").trimEnd();
    if (last && !/[.!?'"»]$/.test(last)) {
      console.warn(`Blog: paragraph truncation detected in ${field} for ${date.toISOString().slice(0, 10)} — last char: "${last.slice(-20)}"`);
    }
  }

  return parsed;
}

function shouldTryChunkedArticleFallback(err) {
  return /413|request too large|too large for model|context length|context window|JSON parse failed|No JSON found|response too short|returned empty|AI response too short/i.test(
    err?.message || String(err || ""),
  );
}

// One-shot generation at temperature/instruction level chronically undershoots
// the 900-1250 word target (llama-3.3 observed 546-841 words across repeated
// attempts). assertRequiredContentBlocks throws AFTER a well-formed response
// already came back, so shouldTryChunkedArticleFallback's malformed-response
// patterns never match this case — a plain regenerate just reruns the same
// one-shot path and fails the same way. The chunked fallback writes body
// paragraphs in two dedicated calls with a 105-145-word-per-paragraph floor,
// which reliably clears the gate.
function isShortArticleBodyFailure(err) {
  return /\d+\+ words of article body/i.test(err?.message || String(err || ""));
}

function chunkedArticleFallbackEnabled(env) {
  const raw = env?.BLOG_CHUNKED_ARTICLE_FALLBACK ?? env?.AI_CHUNKED_ARTICLE_FALLBACK;
  return raw == null || !/^(0|false|off)$/i.test(String(raw).trim());
}

function groundingRetryFeedbackSection(reasons, maxChars = 2200) {
  const list = (Array.isArray(reasons) ? reasons : [])
    .map((reason) => String(reason || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 8);
  if (!list.length) return "";
  const details = list.map((reason) => `- ${reason}`).join("\n").slice(0, maxChars);
  return `A previous draft was rejected for these exact unsupported claims:
${details}
Do not repeat, soften, hedge, or paraphrase those claims. Replace each one with a directly supported source fact, or omit that point entirely.`;
}

function compactChunkedArticleBrief(brief) {
  return {
    title: brief?.title || "",
    curiosityTitle: brief?.curiosityTitle || "",
    eventTitle: brief?.eventTitle || "",
    historicalDate: brief?.historicalDate || "",
    historicalYear: brief?.historicalYear || "",
    historicalDateISO: brief?.historicalDateISO || "",
    location: brief?.location || "",
    country: brief?.country || "",
    organizerName: brief?.organizerName || "",
    wikiUrl: brief?.wikiUrl || brief?.jsonLdUrl || "",
    keyTerms: Array.isArray(brief?.keyTerms) ? brief.keyTerms.slice(0, 8) : [],
    sourceFacts: Array.isArray(brief?.sourceFacts) ? brief.sourceFacts.slice(0, 12) : [],
  };
}

function requireChunkArray(chunk, field, { min = 1, exact = null, label = "chunk" } = {}) {
  const value = chunk?.[field];
  if (!Array.isArray(value)) throw new Error(`${label}: missing ${field} array`);
  if (exact != null && value.length !== exact) {
    throw new Error(`${label}: ${field} must contain exactly ${exact} item(s), got ${value.length}`);
  }
  if (value.length < min) {
    throw new Error(`${label}: ${field} must contain at least ${min} item(s), got ${value.length}`);
  }
  return value;
}

function validateChunkedArticleBodyChunk(chunk, fields, label) {
  for (const field of fields) {
    const paragraphs = requireChunkArray(chunk, field, { exact: 2, label });
    if (!paragraphs.every((paragraph) => typeof paragraph === "string" && wordCount(paragraph) >= CHUNKED_BODY_PARAGRAPH_MIN_WORDS)) {
      throw new Error(`${label}: ${field} contains a thin paragraph`);
    }
  }
}

function chunkedArticleBodyFieldGuidance(field) {
  switch (field) {
    case "overviewParagraphs":
      return "Open with the strongest concrete fact and establish the event, stakes, people, place, and date without drifting into generic background.";
    case "eyewitnessOrChronicle":
      return "Analyze what the supplied record confirms and what it leaves unresolved. Do not invent a witness, memoir, newspaper, decree, archive, or quote.";
    case "aftermathParagraphs":
      return "Name only actions, dates, people, institutions, responses, or limits explicitly confirmed by the source after the event. Do not infer reforms, debates, effects, or policy changes.";
    case "conclusionParagraphs":
      return "Reframe the event with concrete source facts already established by the article, not a preventive lesson, modern policy recommendation, generic reflection, or new unsupported material.";
    default:
      return "Keep the section source-grounded, specific, and non-repetitive.";
  }
}

async function generateChunkedArticleBodyField(
  env,
  model,
  field,
  sharedContext,
  compactBrief,
  alreadyWritten = null,
) {
  const label = `chunked article ${field}`;
  const existingSection = alreadyWritten
    ? `Already written body fields, for continuity and non-repetition:\n${JSON.stringify(alreadyWritten, null, 2)}\n\n`
    : "";

  return callChunkedArticleAI(
    env,
    model,
    label,
    `CHUNKED ARTICLE FALLBACK - ${field}
${sharedContext}

Canonical brief:
${JSON.stringify(compactBrief, null, 2)}

${existingSection}Write only this JSON:
{
  "${field}":["paragraph 1","paragraph 2"]
}

Requirements:
- Return exactly one top-level key: "${field}".
- ${chunkedArticleBodyFieldGuidance(field)}
- The array must contain exactly 2 paragraphs.
- Each paragraph should be 145-175 words, source-grounded, and non-repetitive.
- Absolute minimum is ${CHUNKED_BODY_PARAGRAPH_MIN_WORDS} words, but aim for at least ${CHUNKED_BODY_PARAGRAPH_MIN_WORDS + 25} words to leave margin.
- Count both paragraphs before responding. If either paragraph is below ${CHUNKED_BODY_PARAGRAPH_MIN_WORDS + 15} words, add source-grounded detail before returning.
- Every paragraph must end with terminal punctuation.
- Never place a raw URL in paragraph text. Refer to a source by name; URLs belong only in source metadata.
- Do not convert chronology into causality. Never invent what the event led to, prevented, enabled, changed, created, ended, or made effective.
- Do not use hyphens or em dashes in article body prose.`,
    1700,
    (parsed) => validateChunkedArticleBodyChunk(parsed, [field], label),
  );
}

function validateChunkedArticleSupport(merged) {
  requireChunkArray(merged, "quickFacts", { exact: 6, label: "chunked article fallback" });
  requireChunkArray(merged, "didYouKnowFacts", { exact: 5, label: "chunked article fallback" });
  requireChunkArray(merged, "analysisGood", { min: 3, label: "chunked article fallback" });
  requireChunkArray(merged, "analysisBad", { min: 3, label: "chunked article fallback" });
  assertRequiredContentBlocks(merged);
}

function continuityTokenList(value, ignoredTokens = new Set()) {
  return plainText(value)
    .toLowerCase()
    .replace(/[’']s\b/g, "")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) =>
      token.length >= 4 &&
      !SEMANTIC_DUPLICATE_STOPWORDS.has(token) &&
      !ignoredTokens.has(token),
    );
}

function continuityTokenSet(value, ignoredTokens = new Set()) {
  return new Set(continuityTokenList(value, ignoredTokens));
}

function sharedTokenCount(left, right) {
  let count = 0;
  for (const token of left) {
    if (right.has(token)) count++;
  }
  return count;
}

function chunkedArticleAnchorTokens(content) {
  const values = [
    String(content?.title || "").replace(/\s+—\s+.*$/, ""),
    content?.eventTitle,
    content?.historicalDate,
    content?.location,
    content?.country,
    content?.organizerName,
    ...(Array.isArray(content?.keyTerms) ? content.keyTerms.map((term) => term?.term) : []),
    ...(Array.isArray(content?.sourceFacts) ? content.sourceFacts : []),
  ].filter(Boolean);
  if (Number.isInteger(content?.historicalYear)) values.push(String(content.historicalYear));
  return continuityTokenSet(values.join(" "));
}

function firstParagraphSentence(content, field) {
  const paragraphs = Array.isArray(content?.[field]) ? content[field] : [];
  const first = plainText(paragraphs[0] || "");
  return splitSentences(first, 12)[0] || first;
}

function repeatedOpeningSignature(sentence) {
  const tokens = continuityTokenList(sentence).slice(0, 4);
  return tokens.length >= 3 ? tokens.join(" ") : "";
}

function startsLikeArticleReintroduction(sentence, content) {
  const text = plainText(sentence).toLowerCase();
  const year = Number.isInteger(content?.historicalYear) ? String(content.historicalYear) : "";
  const monthDay = String(content?.historicalDate || "")
    .replace(/,\s*\d{3,4}\b/, "")
    .toLowerCase();
  const startsWithEventDate =
    (monthDay && text.startsWith(`on ${monthDay}`)) ||
    (year && text.startsWith(`in ${year}`));
  if (!startsWithEventDate) return false;
  return /\b(event|story|began|happened|occurred|took place|was|were)\b/.test(text);
}

function auditChunkedArticleContinuity(content) {
  const issues = [];
  const anchors = chunkedArticleAnchorTokens(content);
  if (anchors.size < 4) {
    issues.push("canonical brief does not provide enough shared anchor terms");
  }

  const openingSignatures = new Map();
  for (const field of ARTICLE_BODY_FIELDS) {
    const sectionText = (Array.isArray(content?.[field]) ? content[field] : []).join(" ");
    const sectionTokens = continuityTokenSet(sectionText);
    const sharedAnchors = sharedTokenCount(anchors, sectionTokens);
    if (sharedAnchors < 2) {
      issues.push(`${field} is not clearly anchored to the canonical event brief`);
    }

    const firstSentence = firstParagraphSentence(content, field);
    if (field !== "overviewParagraphs" && startsLikeArticleReintroduction(firstSentence, content)) {
      issues.push(`${field} reintroduces the event instead of continuing the article`);
    }

    const signature = repeatedOpeningSignature(firstSentence);
    if (signature) {
      const previous = openingSignatures.get(signature);
      if (previous) {
        issues.push(`${field} repeats the opening pattern used by ${previous}`);
      } else {
        openingSignatures.set(signature, field);
      }
    }
  }

  const earlierBody = [
    ...(content?.overviewParagraphs || []),
    ...(content?.eyewitnessOrChronicle || []),
    ...(content?.aftermathParagraphs || []),
  ].join(" ");
  const conclusionBody = (content?.conclusionParagraphs || []).join(" ");
  const earlierDetailTokens = continuityTokenSet(earlierBody, anchors);
  const conclusionDetailTokens = continuityTokenSet(conclusionBody, anchors);
  if (sharedTokenCount(earlierDetailTokens, conclusionDetailTokens) < 3) {
    issues.push("conclusion does not clearly pick up enough earlier body detail");
  }

  return { ok: issues.length === 0, issues };
}

async function callChunkedArticleAI(env, model, label, userPrompt, maxTokens, validate = null) {
  // Retry a failed sub-call once before letting it abort the whole chunked
  // fallback. A single transient parse error or short-count response (the
  // 2026-07-05 "facts" sub-call) previously dropped the pipeline back to the
  // undershooting one-shot; one retry makes the chunked path resilient to it.
  let lastError;
  let retryFeedback = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const callArticleAI = env.ARTICLE_GENERATION_PREFER_WORKERS_AI
        ? callPublicationGateAI
        : callAI;
      const raw = await callArticleAI(
        env,
        [
          {
            role: "system",
            content:
              "You are a source-grounded history article component writer. Return one valid JSON object only. No markdown, no prose outside JSON.",
          },
          { role: "user", content: `${userPrompt}${retryFeedback}` },
        ],
        {
          maxTokens,
          timeoutMs: 60_000,
          cfModel: model,
          temperature: 0.15,
          providerAttemptLimit: 8,
        },
      );
      const parsed = parseJsonObjectFromAI(raw, label);
      if (typeof validate === "function") validate(parsed);
      return parsed;
    } catch (err) {
      lastError = err;
      if (attempt < 2) {
        retryFeedback =
          `\n\nPREVIOUS RESPONSE REJECTED: ${String(err.message || err).slice(0, 900)}\n` +
          "Correct that exact failure in the next JSON response. Do not repeat or paraphrase a rejected unsupported claim.";
        console.warn(`Blog: ${label} attempt ${attempt} failed (${err.message}) — retrying once.`);
      }
    }
  }
  throw lastError;
}

async function generateArticleContentChunkedFallback(
  env,
  date,
  takenThisMonth = [],
  model = CF_AI_MODEL,
  forcedEvent = null,
  preferredPillars = [],
  contextHook = null,
  recentPillars = [],
  sourceMaterial = null,
  stricterGrounding = false,
  groundingFeedback = [],
) {
  const monthName = MONTH_NAMES[date.getMonth()];
  const day = date.getDate();
  const sourceSection = sourceMaterial
    ? `AUTHORITATIVE SOURCE MATERIAL, the single source of truth:\n"""\n${String(sourceMaterial).slice(0, 5500)}\n"""\n`
    : "";
  const avoidSection = takenThisMonth.length > 0
    ? `Avoid already-covered topics and close variants:\n${takenThisMonth.slice(0, 12).map((title) => `- ${title}`).join("\n")}\n`
    : "";
  const pillarSection = preferredPillars.length > 0
    ? `Prefer one of these underrepresented categories when consistent with the selected event: ${preferredPillars.join(", ")}.\n`
    : "";
  const recentPillarSection = recentPillars.length > 0
    ? `Avoid making these recent categories the primary angle when possible: ${recentPillars.join(", ")}.\n`
    : "";
  const contextHookSection = contextHook && !sourceMaterial
    ? `Current-world hook to weave into conclusion or editorial note, not verbatim: ${contextHook}\n`
    : "";
  const retryFeedback = groundingRetryFeedbackSection(groundingFeedback);
  const strictLine = stricterGrounding
    ? "A previous draft failed grounding. Use only relationships, outcomes, and consequences explicitly stated by the source.\n"
    : "";
  const sharedContext = `Required event: ${forcedEvent ? `"${forcedEvent}"` : `a significant event from ${monthName} ${day}`}.
Required date: ${monthName} ${day}. historicalDateISO month/day must match this date.
${contextHookSection}${sourceSection}${avoidSection}${pillarSection}${recentPillarSection}${strictLine}
Grounding rules:
- Use only the source material for factual claims when it is supplied.
- Do not invent a named person, quote, document, number, location, motive, casualty count, or consequence.
- Do not write that one event led to, caused, triggered, prompted, prevented, enabled, ended, established, abolished, or changed another result unless the source explicitly states that relationship.
- Chronology is not causality. If the source only says one thing happened and another happened later, describe them separately with neutral time words.
- Do not invent gun-law changes, security reforms, mental-health effects, policy debates, institutional responses, public lessons, or better alternatives.
- Quick Facts, analysis, aftermath, and conclusions must use source-supported facts instead of filling required space with inferred significance or legacy.
- Keep recognition, arrest, death, departure, arrival, and capture dates and places distinct.
- Do not use hyphens or em dashes in article body prose.
- Every paragraph must end with normal terminal punctuation.
${retryFeedback}`;

  console.warn(`Blog: trying chunked article fallback for ${monthName} ${day}.`);

  const brief = await callChunkedArticleAI(
    env,
    model,
    "chunked article brief",
    `CHUNKED ARTICLE FALLBACK - BRIEF
${sharedContext}

Return JSON only with this shape:
{
  "title":"... — ${monthName} ${day}, Year",
  "curiosityTitle":"How or Why question using a source-supported niche angle?",
  "eventTitle":"short subject-plus-finite-verb clause",
  "historicalDate":"${monthName} ${day}, Year",
  "historicalYear":1234,
  "historicalDateISO":"YYYY-MM-DD",
  "location":"City, Country",
  "country":"Country",
  "description":"120-155 chars",
  "ogDescription":"100-130 chars",
  "twitterDescription":"90-120 chars",
  "keywords":"comma separated keywords",
  "imageUrl":"",
  "imageAlt":"specific alt text",
  "jsonLdName":"event name",
  "jsonLdDescription":"schema description",
  "jsonLdUrl":"source URL",
  "organizerName":"key person or organization",
  "readingTimeMinutes":8,
  "keyTerms":[{"term":"exact article phrase","wikiUrl":"https://en.wikipedia.org/wiki/...","type":"person"}],
  "wikiUrl":"source URL",
  "youtubeSearchQuery":"specific event year history documentary",
  "bookSearchQuery":"3-5 word book search",
  "amazonBookTopic":"3-7 word book topic",
  "amazonProductIdeas":[{"label":"3-6 words","searchQuery":"specific book or item search","type":"book"}],
  "contentRationale":"40+ words explaining specific value beyond Wikipedia",
  "sourceFacts":["8-12 atomic facts copied or closely paraphrased from the source without adding an inference"]
}

Requirements:
- curiosityTitle is the public headline. It must be a 35-65 character How, Why, What, Who, Which, or Where question with exactly one final question mark.
- Build curiosityTitle around a surprising transformation, contradiction, overlooked place, hidden decision, or consequence explicitly present in the source. Retain the recognizable event name and never use generic clickbait.
- title and eventTitle remain factual internal labels used to protect the event identity and date. Do not turn either one into a question.
- keyTerms must include at least one real named person connected to the event.
- sourceFacts must preserve the source's actors, numbers, chronology, and relationship verbs exactly. A source fact may say "later" when the source says "later", but may not change that into "led to".
- Do not put inferred significance, legacy, policy effects, security changes, mental-health effects, or moral lessons in sourceFacts.
- imageUrl may be empty or a supported Wikimedia URL, never a placeholder.
- Never place a raw URL in quickFacts or any other visible prose field; URLs belong only in URL/source metadata fields.`,
    1500,
    (parsed) => {
      parsed.curiosityTitle = normalizeCuriosityTitleText(parsed.curiosityTitle);
      const briefTitleContext = {
        ...parsed,
        sourcePageTitle:
          wikiTitleFromUrl(parsed.wikiUrl) ||
          forcedEvent ||
          parsed.eventTitle,
        sourceText: sourceMaterial || (parsed.sourceFacts || []).join(" "),
      };
      let curiosityTitleValidation =
        validateCuriosityTitleForPublish(briefTitleContext);
      if (!curiosityTitleValidation.ok) {
        const repaired = repairCuriosityTitleFromSource(briefTitleContext);
        if (repaired) {
          parsed.curiosityTitle = repaired;
          curiosityTitleValidation =
            validateCuriosityTitleForPublish(briefTitleContext);
        }
      }
      if (!curiosityTitleValidation.ok) {
        throw new Error(
          `chunked article brief: public question-title contract failed — ${curiosityTitleValidation.reasons.join("; ")}`,
        );
      }
      requireChunkArray(parsed, "keyTerms", { min: 1, label: "chunked article brief" });
      // Validate the person against the SAME first-8 slice that
      // compactChunkedArticleBrief forwards as grounding context to every body,
      // facts, and analysis sub-prompt. A person beyond index 8 would pass a
      // whole-array check but be dropped before it could ground the body prose.
      const forwardedTerms = parsed.keyTerms.slice(0, 8);
      if (!forwardedTerms.some((term) => String(term?.type || "").toLowerCase() === "person" && String(term?.term || "").trim())) {
        throw new Error("chunked article brief: keyTerms must include one named person");
      }
    },
  );

  const compactBrief = compactChunkedArticleBrief(brief);

  const generateSplitBodyFields = async (fields, alreadyWritten = null) => {
    const merged = {};
    for (const field of fields) {
      const continuityContext =
        alreadyWritten || Object.keys(merged).length > 0
          ? { ...(alreadyWritten || {}), ...merged }
          : null;
      const chunk = await generateChunkedArticleBodyField(
        env,
        model,
        field,
        sharedContext,
        compactBrief,
        continuityContext,
      );
      Object.assign(merged, chunk);
    }
    return merged;
  };

  let bodyA;
  try {
    bodyA = await callChunkedArticleAI(
      env,
      model,
      "chunked article body A",
      `CHUNKED ARTICLE FALLBACK - BODY A
${sharedContext}

Canonical brief:
${JSON.stringify(compactBrief, null, 2)}

Write only these body fields as JSON:
{
  "overviewParagraphs":["paragraph 1","paragraph 2"],
  "eyewitnessOrChronicle":["paragraph 1","paragraph 2"]
}

Requirements:
- Each array must contain exactly 2 paragraphs.
- Each paragraph should be 120-160 words, source-grounded, and non-repetitive. Never fewer than 115 words.
- overviewParagraphs open with the strongest concrete fact.
- Never place a raw URL in paragraph text. Refer to a source by name instead.
- Do not convert chronology into causality or infer a motive, policy effect, institutional response, or preventive lesson.
- eyewitnessOrChronicle must not invent a witness, memoir, newspaper, decree, archive, or quote. If the source names no account, analyze what the record confirms and leaves unresolved.`,
      2300,
      (parsed) => validateChunkedArticleBodyChunk(parsed, ["overviewParagraphs", "eyewitnessOrChronicle"], "chunked article body A"),
    );
  } catch (err) {
    console.warn(
      `Blog: combined chunked article body A failed (${err.message}); splitting into single-section calls.`,
    );
    bodyA = await generateSplitBodyFields(["overviewParagraphs", "eyewitnessOrChronicle"]);
  }

  let bodyB;
  try {
    bodyB = await callChunkedArticleAI(
      env,
      model,
      "chunked article body B",
      `CHUNKED ARTICLE FALLBACK - BODY B
${sharedContext}

Canonical brief:
${JSON.stringify(compactBrief, null, 2)}

Already written body fields:
${JSON.stringify(bodyA, null, 2)}

Write only these body fields as JSON:
{
  "aftermathParagraphs":["paragraph 1","paragraph 2"],
  "conclusionParagraphs":["paragraph 1","paragraph 2"]
}

Requirements:
- Each array must contain exactly 2 paragraphs.
- Each paragraph should be 120-160 words, source-grounded, and non-repetitive. Never fewer than 115 words.
- Aftermath must name only actions, dates, people, institutions, or limits explicitly confirmed by the source.
- If the source does not state a broader consequence, do not claim one. Continue with documented chronology, legal proceedings, named responses, or limits in the record.
- Never place a raw URL in paragraph text. Refer to a source by name instead.
- Conclusion must reframe the event with a concrete source fact, not a modern policy lesson, preventive recommendation, or generic reflection.`,
      2300,
      (parsed) => validateChunkedArticleBodyChunk(parsed, ["aftermathParagraphs", "conclusionParagraphs"], "chunked article body B"),
    );
  } catch (err) {
    console.warn(
      `Blog: combined chunked article body B failed (${err.message}); splitting into single-section calls.`,
    );
    bodyB = await generateSplitBodyFields(["aftermathParagraphs", "conclusionParagraphs"], bodyA);
  }

  const facts = await callChunkedArticleAI(
    env,
    model,
    "chunked article facts",
    `CHUNKED ARTICLE FALLBACK - FACTS
${sharedContext}

Canonical brief:
${JSON.stringify(compactBrief, null, 2)}

Write only this JSON:
{
  "quickFacts":[{"label":"Event","value":"..."},{"label":"Date","value":"..."},{"label":"Location","value":"..."},{"label":"Key Figure","value":"..."},{"label":"Source Detail","value":"..."},{"label":"Confirmed Outcome","value":"..."}],
  "didYouKnowFacts":["five distinct facts, 35-55 words each"]
}

Requirements:
- quickFacts must contain exactly 6 populated label/value objects.
- Every quick-fact value must be directly supported by the source. Do not use Significance, Legacy, Impact, or Lessons labels unless the source explicitly states the claimed consequence.
- Prefer neutral labels such as Source Detail, Investigation, Trial, Decision, Record, or Confirmed Outcome, choosing only labels supported by this event's source.
- didYouKnowFacts must contain exactly 5 distinct source-grounded facts.
- Did You Know facts may be surprising, but surprise must come from a source fact, not an inferred consequence, motive, coincidence, fate, or policy effect.
- Never place a raw URL in a fact. Refer to a source by name instead.
- Every didYouKnow fact needs a concrete name, date, number, place, institution, or source.`,
    1600,
    (parsed) => {
      requireChunkArray(parsed, "quickFacts", { exact: 6, label: "chunked article facts" });
      requireChunkArray(parsed, "didYouKnowFacts", { exact: 5, label: "chunked article facts" });
      const didYouKnowAudit = auditDidYouKnowFacts({
        ...compactBrief,
        didYouKnowFacts: parsed.didYouKnowFacts,
      });
      if (!didYouKnowAudit.ok) {
        throw new Error(`chunked article facts: ${didYouKnowAudit.reasons.join("; ")}`);
      }
    },
  );

  const analysis = await callChunkedArticleAI(
    env,
    model,
    "chunked article analysis",
    `CHUNKED ARTICLE FALLBACK - ANALYSIS
${sharedContext}

Canonical brief:
${JSON.stringify(compactBrief, null, 2)}

Body fields:
${JSON.stringify({ ...bodyA, ...bodyB }, null, 2)}

Write only this JSON:
{
  "analysisGood":[{"title":"3-5 words","detail":"60+ words evaluating a source-documented action, response, or strength of the record"}],
  "analysisBad":[{"title":"3-5 words","detail":"60+ words evaluating a source-documented failure, limitation, or unresolved question"}],
  "editorialNote":"80+ words from the thisDay. team"
}

Requirements:
- analysisGood must contain exactly 3 items.
- analysisBad must contain exactly 3 items.
- Analysis may interpret facts, but it must not invent causality, effectiveness, responsibility, policy change, prevention, or a better alternative.
- Each analysis item must anchor every judgment in actions or limits explicitly present in the source. If the source cannot support "why it worked" or "what should have happened", do not make that claim.
- Analyze the historical event and record, never the generated article. Do not write "the article", "this piece", "the post", "accurately records", "correctly identifies", "omits", or any critique of the writing, sourcing process, repetition, coverage, or credibility.
- Never place a raw URL in analysis or editorial text. Refer to a source by name instead.
- Every detail must include a concrete name, date, number, institution, place, or source.
- editorialNote must be specific to this article, stay with source-supported details, and avoid preventive lessons or modern policy prescriptions.`,
    2200,
    (parsed) => {
      requireChunkArray(parsed, "analysisGood", { exact: 3, label: "chunked article analysis" });
      requireChunkArray(parsed, "analysisBad", { exact: 3, label: "chunked article analysis" });
    },
  );

  const merged = normalizeGeneratedArticleContent({
    ...brief,
    ...bodyA,
    ...bodyB,
    ...facts,
    ...analysis,
  }, date);
  const continuity = auditChunkedArticleContinuity(merged);
  if (!continuity.ok) {
    throw new Error(`chunked article fallback continuity failed: ${continuity.issues.join("; ")}`);
  }
  delete merged.sourceFacts;
  validateChunkedArticleSupport(merged);
  console.warn(`Blog: chunked article fallback produced ${articleBodyWordCount(merged)} body words for ${monthName} ${day}.`);
  return merged;
}

async function callWorkersAI(
  env,
  date,
  takenThisMonth = [],
  model = CF_AI_MODEL,
  forcedEvent = null,
  preferredPillars = [],
  contextHook = null,
  recentPillars = [],
  sourceMaterial = null,
  stricterGrounding = false,
  groundingFeedback = [],
) {
  const monthName = MONTH_NAMES[date.getMonth()];
  const day = date.getDate();

  const avoidSection =
    takenThisMonth.length > 0
      ? `\nThese topics have already been covered — do NOT write about any of them or anything closely related:\n${takenThisMonth.map((t) => `- ${t}`).join("\n")}\nSemantic avoidance rules: (1) If a listed title names a person, do not pick any event involving that person, their family, or their dynasty. (2) If a listed title names a battle or war, do not pick another engagement from the same conflict. (3) Do not pick a different year of the same recurring event type (e.g. if "Treaty of Paris 1856" is listed, avoid "Treaty of Paris 1783"). (4) If two events share the same country and the same event type within 50 years of each other, they are too similar — pick something from a different region or era entirely.\n`
      : "";

  const avoidPillarLine =
    recentPillars.length > 0
      ? `AVOID these topic categories — they have been published in the last 7 days and must not repeat: ${recentPillars.map((p) => `"${p}"`).join(", ")}. Do not pick an event whose primary theme falls into any of these categories.`
      : "";
  const preferPillarLine =
    preferredPillars.length > 0
      ? `REQUIRED CATEGORY: You MUST choose an event that falls into one of these underrepresented categories: ${preferredPillars.map((p) => `"${p}"`).join(", ")}. Only ignore this if there is genuinely no significant event from those categories on this date.`
      : "";
  const pillarHint =
    avoidPillarLine || preferPillarLine
      ? `\n${avoidPillarLine}${avoidPillarLine && preferPillarLine ? "\n" : ""}${preferPillarLine}\n`
      : "";

  const contextHookSection = contextHook && !sourceMaterial
    ? `\nCURRENT-WORLD CONTEXT (mandatory): The following hook connects this historical event to today's world as of the publish date. You MUST weave at least one sentence from this angle into the article — specifically into the conclusionParagraphs or editorialNote. The sentence must feel grounded in the present, not generic. Do not quote the hook verbatim; use it as a lens:\n"${contextHook}"\n`
    : "";
  const groundingFeedbackSection = groundingRetryFeedbackSection(groundingFeedback);

  const eventSelection = forcedEvent
    ? `You MUST write about this specific event: "${forcedEvent}". Do not choose a different event.`
    : `Write a detailed, engaging blog post about a significant historical event that occurred on ${monthName} ${day} (any year).
${pillarHint}
GLOBAL RECOGNITION RULE (highest priority): First, ask yourself — does this date have an event that billions of people worldwide have heard of, that dominates Google search results for this date, and that anyone would instantly recognise from a headline? Examples of this tier: a presidential assassination, the sinking of a famous ship, a world war turning point, a major terrorist attack, a civil rights milestone. If yes, that event MUST be chosen. Do not pick a lesser-known event when a globally famous one exists on the same date — even if the famous event seems "obvious" or already widely covered online. Obvious famous events are chosen because they have the highest search traffic and audience interest.

When no single globally dominant event exists, rank candidates by click and share potential on YouTube Shorts and social media. Prioritise in this order:
1. Events involving globally recognised figures (presidents, kings, scientists, cultural icons) in dramatic or unexpected situations
2. Events with a shocking twist, a near-miss, a dramatic reversal, or a surprising outcome that most people do not know
3. Discoveries, inventions, or "firsts" that changed everyday life in ways still felt today
4. Political turning points or military events whose consequences are still visible in the modern world
5. Avoid obscure regional events, minor treaties, incremental legislative steps, and niche court cases unless they have a genuinely viral story attached

Prefer events that are likely to be image-rich on Wikipedia, meaning a real article page plus multiple usable related images. Good fits are named people, major battles, disasters, inventions, launches, assassinations, coups, and widely documented public incidents. Avoid generic labels like "strike", "meeting", or "conference" unless the event is tied to a very specific named subject and is clearly documented with multiple images.

Choose the single event from this date that a curious 25-year-old would most likely stop scrolling to watch a 45-second video about, and that is most likely to pass a 3-image Wikipedia coverage check.`;

  // Authoritative source material for the selected event. When present, the body
  // MUST be grounded in it — this is the cure for from-memory fabrication (the
  // 2026-06-20 incidents: a fabricated June 20 event and an invented June 19
  // death toll). See architecture/2026-06-20-source-grounded-generation-design.md.
  const sourceMaterialSection = sourceMaterial
    ? `\nSOURCE MATERIAL (authoritative — your single source of truth for this event):\n"""\n${String(sourceMaterial).slice(0, 16000)}\n"""\n` +
      `GROUNDING RULES (mandatory):\n` +
      `- Write ONLY about the exact event described in the SOURCE MATERIAL above. Do not substitute a different event, even one with a similar name.\n` +
      `- Base every factual claim on the SOURCE MATERIAL. Do not add a person, document, quotation, number, location, motive, or consequence merely because it appears in your general knowledge.\n` +
      `- NEVER invent specifics. Do not state a casualty count, death toll, number of survivors, named person, exact date, or place unless it is supported by the source. If the source does not give a number, do not give one; describe it qualitatively instead.\n` +
      `- NEVER invent a named memoir, newspaper report, government record, decree, quotation, archival reference, publication date, or historian. Name a source only when that exact source appears in the SOURCE MATERIAL. Otherwise attribute the point generally to the supplied Wikipedia sources or omit the attribution.\n` +
      `- Keep distinct actions distinct. Do not merge recognition, arrest, death, departure, arrival, or capture into one place or date when the source assigns them to different places or dates.\n` +
      `- If the source and your own memory disagree, the source wins.\n` +
      (stricterGrounding
        ? `- A previous draft was REJECTED for containing claims not supported by the source (a wrong event or an invented number). Be conservative: omit any specific you cannot tie to the source above.\n`
        : "")
    : "";

  const prompt = `You are a historical content writer for "thisDay.info", a website about historical events.
${contextHookSection}${sourceMaterialSection}
STRICT DATE REQUIREMENT: You MUST write about an event that occurred on ${monthName} ${day} ONLY. The event must have taken place in the month of ${monthName} on day ${day}. Events from ANY other month or day are strictly forbidden. Before choosing an event, verify it happened on ${monthName} ${day}. If you are not certain an event occurred on ${monthName} ${day}, choose a different event you are confident about.

${eventSelection}
${avoidSection}
The article must be substantial without being padded. Target 1,050 to 1,250 words of body content across overviewParagraphs, eyewitnessOrChronicle, aftermathParagraphs, and conclusionParagraphs combined. The absolute floor is ${MIN_REAL_ARTICLE_BODY_WORDS} body words. A precise, complete ${MIN_REAL_ARTICLE_BODY_WORDS} word article is better than a repetitive 1,500 word article. Every paragraph must earn its place with new historical depth, not filler.

HARD RULE — COMPLETE EVERY FIELD: You have enough token budget to finish the entire response. Every paragraph must be a complete thought ending with terminal punctuation (period, exclamation mark, or question mark). Never end a paragraph or field mid-sentence. If you are running out of content ideas, write a shorter but fully complete paragraph rather than cutting off mid-sentence. An incomplete sentence anywhere in the JSON is a critical error.

HARD RULE — NO RAW URLS IN VISIBLE PROSE: Never put http://, https://, or www. text in quickFacts, didYouKnowFacts, body paragraphs, analysis, timeline labels, quotes, or editorial notes. URL values belong only in dedicated URL and source metadata fields. In prose, refer to a source by its descriptive name without printing its address.

VOICE AND PERSONALITY — this is the most important instruction:
Write like a passionate history obsessive who has spent weeks researching this event and genuinely cannot believe more people do not know about it. You have opinions. You find things surprising, tragic, infuriating, or inspiring, and you say so. You are not a textbook. You are not a Wikipedia summary. You are a storyteller who happens to know an enormous amount of history.
Write as a passionate, opinionated history narrator — serious and authoritative, never casual or colloquial. Do not write like you are texting or chatting. Assume the reader is intelligent but has never heard of this event. Explain every proper noun on its first mention with one short inline phrase — enough to orient the reader without a digression.

Specific voice qualities:
- PLAY YOUR ACE CARD FIRST: The single most surprising, counterintuitive, or little-known fact in the entire article belongs in the first two sentences. Do not save the best for the end. Most readers will not reach it.
- FOCUS ON ONE THREAD: Do not try to cover everything about the event. Find the sharpest angle — one person, one decision, one consequence — and pull that thread through the whole article. Breadth kills impact.
- QUALITY OVER QUANTITY: Once the source-supported facts are exhausted, stop expanding. Do not repeat a person, number, technical detail, or institutional fact just to make the article longer. Shorter is acceptable only when it is complete, specific, and above the body-word floor.
- FACTS BEFORE FEELINGS: The first paragraph must contain at least three hard facts, drawn from different categories such as one named person, one exact place, one number, one document, or one precise date. Do not open with mood words like "dramatic", "remarkable", "significant", or "unexpected" unless the very same sentence also supplies the concrete fact that earns that description.
- SOURCE-BOUND SENSORY writing: Use sound, smell, weather, texture, or physical sensation only when the SOURCE MATERIAL or a named account supports it. Never manufacture atmosphere merely to make a scene vivid.
- NEVER make a summary mood judgment. Do not write "it was a dark time", "it was a difficult period", "it was chaotic", "it was a bleak time", or any sentence that labels a mood without evidence. Describe the specific thing that is dark, difficult, or chaotic — what someone would see, hear, smell, or feel on the ground — and let the reader draw the conclusion themselves. The writer plants the evidence; the reader forms the judgment.
- COMPARISONS ARE OPTIONAL: Prefer the source's concrete detail over a metaphor. If a comparison genuinely clarifies the event, root it in supplied evidence and do not introduce a new factual scenario, measurement, person, place, or modern parallel.
- Have a point of view, but earn every characterization with named conduct or evidence. Do not label someone cowardly, heroic, cynical, or visionary without first showing the decision that supports the judgment.
- Let transitions emerge from cause, contrast, chronology, or evidence. Do not recycle stock signposts such as "What makes this stranger still", "Here is what the textbooks skip", or "Most people assume" across sections.
- Connect the past to something the reader recognizes. A parallel to a modern situation, a personality trait that feels familiar, a consequence we still live with today.
- You are a guide traveling alongside the reader, not a sage on a podium dispensing wisdom. Share in the discovery.

Sentence and paragraph rules:
- Mix sentence lengths deliberately for rhythm. Some sentences can be 30+ words when building a complex, layered point. Use occasional short declarative sentences under 10 words for emphasis. Never write three consecutive sentences of similar length.
- VARY SENTENCE FORMS, not just lengths. If one sentence is conditional ("If X, then Y"), the next should be a short declarative. Follow that with a cause-and-effect. Never write three consecutive sentences with the same grammatical structure — structural repetition kills energy even when length varies.
- VARY SENTENCE OPENINGS: Do not begin sentence after sentence with "The", the same proper noun, or the same time marker. Change the entry point only when the paragraph's logic permits it.
- NO TIDY AI SYMMETRY: Avoid neat three-part lists, mirrored "not only/but also" constructions, evenly balanced concessions, and a concluding sentence that merely restates the paragraph in ceremonial language.
- Target an average of 18-22 words per sentence across each paragraph. This creates readable depth without choppiness.
- Every paragraph must contain at least one specific, verifiable fact: a real name, an exact year or number, a specific place, or a direct quote. No paragraph may consist entirely of vague generalizations.
- SOURCE ANCHOR RULE: In every major section, attribute at least one claim. ${sourceMaterial ? "Use only a source explicitly named in SOURCE MATERIAL; if none is named, attribute the claim generally to the supplied Wikipedia source. Never invent a memoir, trial record, newspaper, historian, decree, archive, or witness." : "Use a real memoir, trial record, newspaper, historian, government decree, or specific witness, and omit the attribution if you cannot verify it."}
- SOURCE-BOUND ACCOUNT SECTION: If SOURCE MATERIAL names a real witness, chronicler, historian, or document, the eyewitnessOrChronicle section may analyze that account. If it names none, do not invent one. Use those two paragraphs to analyze what the supplied Wikipedia record establishes and what it does not establish, and leave eyewitnessQuote and eyewitnessQuoteSource empty.
- FACT FIRST IN EVERY SECTION: The first sentence of Overview, Eyewitness Accounts, Aftermath, and Legacy must state the key fact before any scene-setting. Answer the implied reader question immediately, then expand.
- AFTERMATH MUST CASH OUT: The aftermath paragraphs must name specific actions taken in the days, weeks, or years after the event, including who acted, where, and what changed. Do not hide behind phrases like "it reshaped politics" unless you name the office, law, institution, or military result that changed.
- NO REPETITION ACROSS SECTIONS: Each paragraph must introduce new information. Never restate a point, conclusion, or fact already made in a previous section. Do not name the same person, institution, or concept more than three times in the full article — use pronouns or contextual references after the first mention.
- NO SEMANTIC DUPLICATION: A repeated fact with different wording is still repetition. If Did You Know already uses the gas flame, the crowd count, the bill, or the named designer, the body may mention it once for context but must spend its next sentence on a different consequence, limitation, action, or source-supported detail.
- Include at least one clear "what would need to be true for this to be wrong" check somewhere in the article when you make a strong claim.
- Start with the takeaway, then walk backward to the evidence. Avoid "Picture..." and "This was not some minor accident." Write like a human: a little uneven, a little opinionated, and not overly polished.
- Avoid semicolons. If absolutely necessary, use at most one semicolon in a paragraph.
- ABSOLUTE BAN ON DASHES: Never use "-" or "—" anywhere in the article body. Not mid-sentence, not at the end of a clause, not anywhere. Zero dashes in the entire text. Use a comma, or split into two sentences.
- Use active voice. Say who did what.
- Start each paragraph with a sentence that makes the reader want to keep reading.
- Connect paragraphs through chronology, cause, contrast, or evidence. Do not paste in reusable transition slogans.
- When nuance or complication enters a paragraph, represent it at its strongest — give the best version of the opposing case, not the weakest. Do not signal you are doing this with phrases like "critics argue" or "some would say." Just write it directly as part of the narrative flow: "Nehru rejected the resolution not because he dismissed Muslim concerns, but because he believed division would harden them into interstate conflict." Strong nuance woven naturally is far more persuasive than a weak position you announce and dismiss.

BANNED PHRASES — never write any of these:
"I was", "I witnessed", "I saw", "I recall", "I remember", "I stood", "I heard", "I watched" (first-person singular narration is forbidden everywhere),
"significant event", "pivotal moment", "changed history", "shaped the course of", "left a lasting impact", "cannot be overstated", "one of the most important", "it is worth noting", "it is important to remember", "this was a time of great change", "the importance of this", "a reminder of", "shows the importance of", "demonstrated the power of", "it was a dark time", "it was a bleak time", "it was a difficult period", "it was chaos", "it was a complex time", "dark chapter". These are filler. Replace them with the specific fact or analysis that the phrase was trying to avoid writing.
"dramatic and unexpected", "dramatic and unexpected turn of events", "significant turning point", "brighter future", and "marked the end of a dark period" are also banned unless rewritten into concrete, evidenced statements.

HARD RULE — NO RHETORICAL QUESTIONS IN ARTICLE PROSE: Do not write a question directed at the reader in any body, fact, analysis, quote, or editorial field. The one required exception is curiosityTitle, which is the public headline and must be a source-grounded question. Every other question must be rewritten as a declarative statement that answers itself. Example: instead of "What were the consequences?" write "The consequences were immediate and lasting." Before submitting your response, scan every field except curiosityTitle and rewrite any sentence ending in a question mark.

HARD RULE — NO FIRST-PERSON SINGULAR: The narrator is ALWAYS third person. Never write "I", "I was", "I witnessed", "I saw", "I recall", "I remember", or any sentence where the narrator uses "I" as a subject. This applies everywhere in the article — overview, eyewitness, aftermath, conclusion, everywhere. The Eyewitness section reports WHAT witnesses said and experienced; it does not pretend the narrator was present. Write "Student Alan Canfora later recalled that..." not "I was on the campus and I witnessed...". If a real quote is included, attribute it with a signal phrase in third person ("as Canfora wrote", "Smith testified that", "the correspondent reported"). Zero first-person singular in the entire response.

HARD RULE — NO FAKE SUSPENSE OPENERS: Do not start any sentence with: "So,", "Picture this", "Picture the scene", "And then,", "But what", "But why", "You have to understand", "Nobody expected", "Frankly", "Which, frankly". These are conversational filler. State the fact directly.

DO NOT open consecutive paragraphs with the same word or conjunction. Each paragraph must begin with a structurally different sentence.

Title rules:
- The "curiosityTitle" field is the public search/card/H1 headline. It MUST be a 35-65 character question beginning with How, Why, What, Who, Which, or Where and ending with exactly one question mark.
- Find one relevant, interesting niche in the supplied source text: a surprising transformation, contradiction, overlooked location, hidden decision, misunderstood cause, or concrete consequence. Build curiosityTitle around that niche while retaining the recognizable event name.
- curiosityTitle must be directly answerable from the article and authoritative source material. It must contain at least one angle beyond merely restating eventTitle. Never invent a mystery, motive, cause, failure, secret, or consequence.
- CORRECT: "How Did a Partly Failed Coup Become the Spanish Civil War?" WRONG: "Spanish Civil War Begins", "What Happened in the Spanish Civil War?", "Discover the Spanish Civil War", "The Untold Secret of the Spanish Civil War".
- Do not put the date suffix in curiosityTitle. The historical date is displayed separately beneath the H1.
- The "title" field is the locked factual reference title and MUST follow exactly this format: "[factual event headline with a strong verb] — ${monthName} ${day}, Year". It is used for factual/date validation, not as the public H1.
- LENGTH — keep it SHORT for search results: the headline part (everything before " — ") MUST be about 50 characters or fewer (roughly 6-9 words) while still naming who + what. Drop secondary actors, lists of names, and any "Topic War:" prefix copied from the source. CORRECT (concise AND complete): "Napoleon Defeated at the Battle of Waterloo", "Royal Navy Sinks German Battleship Bismarck", "U.S. Senate Passes the Fair Labor Standards Act". WRONG (too long, lists every actor, keeps the topic tag): "Napoleonic Wars: The Battle of Waterloo results in the defeat of Napoleon Bonaparte by the Duke of Wellington and Field Marshal Blücher". Start with the real subject, not the topic tag.
- HARD RULE — TITLE MUST CONTAIN A FINITE VERB: Both "title" and "eventTitle" MUST include at least one finite verb that describes the action — not a gerund, not a noun, a conjugated verb. "China Airlines Flight 611 Disintegrates" is correct (finite verb: disintegrates). "China Airlines Flight 611 Crash" is wrong (noun only). "China Airlines Flight 611 Crashing" is wrong (gerund). There must be a clear subject + verb structure.
- The first part must be specific and interesting while staying factual. Never address or command the reader, and never prepend a promotional hook such as "Join the Fight:", "Discover:", "Explore:", or "Read This:". The headline MUST be a complete grammatical clause: a real subject PLUS a finite verb. For transitive actions, include the object too. CORRECT (concise — about 50 chars or fewer): "Napoleon Defeated at the Battle of Waterloo", "Royal Navy Sinks German Battleship Bismarck", "Parliament Ratifies Treaty of Versailles", "China Airlines Flight 611 Disintegrates". WRONG: "Join the Fight: Spanish Civil War Begins", "VTA Rail Yard Shooting Kills" (no subject for "Kills" — who kills?), "Bismarck Sinking Sinks" (redundant verb appended to noun phrase), "Flight 611 Crash" (noun only). Never take a Wikipedia event page title (which is a noun phrase) and just append a bare verb — always build a proper subject-verb clause from the event description.
- Use the most specific named subject available: prefer a person's title and name ("President Eisenhower", "General MacArthur", "Prime Minister Churchill") or a specific named entity ("Royal Navy", "U.S. Congress", "Apollo 11 Crew") over generic terms ("A leader", "Officials", "The government", "Gunman"). If no named actor is known, name the event's primary subject instead ("Two Unidentified Servicemen", "Ten Workers").
- Embed the historical year inside the headline when the event is tied to a recurring occasion (Memorial Day, the Olympics, an annual treaty deadline, etc.) so the reader knows which one: "President Eisenhower Honors Two Unknown Soldiers at Arlington on Memorial Day 1958" not "…on Memorial Day". Omit the year when the headline is already unambiguous without it.
- Avoid lazy suffix titles. Do NOT append "Founding", "Creation", "Launch", "Opening", "Completion", or "Presentation" just to make a noun sound like an event. Use them only if the source event is literally a founding/opening/launch and no more specific verb is available. Prefer "Rosenborg BK Founded" over "Rosenborg BK Founding"; prefer "First Oscars Honor Wings" over "The First Oscars Founding"; prefer "Brown v. Board Strikes Down School Segregation" over "Brown v. Board of Education Founding"; prefer "Israel Declares Independence" over "Israeli Independence".
- The "eventTitle" field should be a descriptive canonical event name with a clear action — include what happened AND a key detail (who, where, or result). It MUST contain a verb. Good: "Iran Helicopter Crash Kills President Raisi" or "China Airlines Flight 611 Disintegrates Over Taiwan Strait". Bad: "Ebrahim Raisi" or "Flight 611 Disintegrates" (too short, missing context) or "Flight 611 Crash" (noun only).
- Do NOT use colloquial date names or phrases like "Ides of March", "D-Day", or "Black Tuesday" as the title — use the actual event name instead.
- The separator between event name and date MUST be " — " (space, em dash, space).

Reply with ONLY a raw JSON object. No markdown, no code fences, no explanation — just the JSON.

{
  "title": "Factual event headline with a strong verb — ${monthName} ${day}, Year",
  "curiosityTitle": "How or Why question using a distinct source-supported niche angle?",
  "eventTitle": "Concise event name with a finite verb (e.g. 'Flight 611 Disintegrates', not 'Flight 611 Crash')",
  "historicalDate": "Month Day, Year",
  "historicalYear": 1234,
  "historicalDateISO": "YYYY-MM-DD",
  "location": "City, Country",
  "country": "Country",
  "description": "Meta description between 120-155 characters. Must be specific, keyword-rich, and describe the event, its date, and significance.",
  "ogDescription": "Open Graph description between 100-130 characters, engaging and specific.",
  "twitterDescription": "Twitter description between 90-120 characters, punchy and specific.",
  "keywords": "keyword1, keyword2, keyword3, keyword4, keyword5",
  "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/thumb/example.jpg",
  "imageAlt": "Alt text for the image",
  "jsonLdName": "Event name",
  "jsonLdDescription": "Schema.org description one or two sentences",
  "jsonLdUrl": "https://en.wikipedia.org/wiki/Article",
  "organizerName": "Key figure or organization",
  "readingTimeMinutes": 8,
  "quickFacts": [
    { "label": "Event", "value": "Full event name" },
    { "label": "Date", "value": "Month Day, Year" },
    { "label": "Location", "value": "Place" },
    { "label": "Key Figure", "value": "Name" },
    { "label": "Source Detail", "value": "Concrete fact stated by the source" },
    { "label": "Confirmed Outcome", "value": "Outcome explicitly stated by the source" }
  ],
  "didYouKnowFacts": [
    "A genuinely surprising lesser-known fact — something most people would not expect, 1 to 2 sentences, minimum 35 words. Must include a specific name, number, or place. Use one vivid claim plus one supporting detail.",
    "A detail that reframes the main story or reveals a hidden layer of complexity, 1 to 2 sentences, minimum 35 words. Do not recycle a detail from the first fact.",
    "A second concrete source fact about a named action, place, date, institution, or record, 1 to 2 sentences, minimum 35 words. Do not infer a consequence or coincidence.",
    "A fact about a specific person involved that the source explicitly states, 1 to 2 sentences, minimum 35 words. Do not infer motive or fate.",
    "A concrete number, statistic, or measurable detail that conveys the scale or stakes, 1 to 2 sentences, minimum 35 words. Provide exactly FIVE facts in total and make every one distinct — never restate or paraphrase another fact."
  ],
  "overviewParagraphs": [
    "Paragraph 1 (claim + strongest evidence; ~105 to 125 words): Open with a striking concrete detail or blunt declarative statement — never with a rhetorical question. State the core claim directly. Include the single strongest, attributable piece of evidence (name, year, number, or place) that supports it. No chatty openers like 'So, what happened' or 'For starters'. Start with the most important thing.",
    "Paragraph 2 (nuance + synthesis; ~90 to 115 words): Introduce the strongest complication or contrary reality as part of the narrative — not as a rhetorical question or a 'But why?' setup. State the complication directly as a fact or claim, then synthesize. Do NOT begin with 'But the [topic] wasn't without...' or 'But why was it...'. End with a precise assessment that links back to the opening claim."
  ],
  "eyewitnessOrChronicle": [
    "Paragraph 1 (~90 to 115 words): If SOURCE MATERIAL names a witness, chronicler, historian, or document, describe and assess that account in THIRD PERSON. Otherwise explain exactly what the supplied Wikipedia record establishes about the event and identify a limitation in that record without inventing a missing witness or document.",
    "Paragraph 2 (~90 to 115 words): Contrast only accounts or facts actually present in SOURCE MATERIAL. If no contrasting named account is supplied, analyze the gap between what the record confirms and what it leaves unresolved. Do not add a historian, memoir, newspaper, decree, archive, quotation, or motive from general knowledge."
  ],
  "eyewitnessQuote": "Use a direct or closely paraphrased quote only when that quote appears in SOURCE MATERIAL; otherwise use an empty string.",
  "eyewitnessQuoteSource": "Use the exact attribution from SOURCE MATERIAL for eyewitnessQuote; otherwise use an empty string.",
  "aftermathParagraphs": [
    "Paragraph 1 (immediate aftermath; ~100 to 120 words): Describe only the actions, dates, people, proceedings, and institutional responses explicitly stated by SOURCE MATERIAL.",
    "Paragraph 2 (medium-term record; ~100 to 120 words): Continue with documented chronology or confirmed limits in the record. Do not infer reforms, debates, policy changes, or effects."
  ],
  "conclusionParagraphs": [
    "Paragraph 1 (honest assessment; ~90 to 110 words): Synthesize only changes or limits explicitly stated by SOURCE MATERIAL. Do not add a preventive lesson, public-policy claim, or modern recommendation.",
    "Paragraph 2 (reframing close; ~80 to 100 words): End with a specific source fact, contradiction, or documented detail. The final sentence must be short, direct, self-contained, and source-supported."
  ],
  "analysisGood": [
    { "title": "Concise label (3-5 words)", "detail": "Minimum 60 words. Analyze a source-documented historical action, response, or strength of the record without inventing effectiveness, credit, causality, or alternatives. Analyze the event itself, never the article, post, piece, writing, or coverage." },
    { "title": "Concise label (3-5 words)", "detail": "Minimum 60 words. Same source-bound standard." },
    { "title": "Concise label (3-5 words)", "detail": "Minimum 60 words. Same source-bound standard." }
  ],
  "analysisBad": [
    { "title": "Concise label (3-5 words)", "detail": "Minimum 60 words. Analyze a source-documented historical failure, limitation, or unresolved question without inventing responsibility, prevention, or a better alternative. Analyze the event itself, never what the article omits, states, explains, or covers." },
    { "title": "Concise label (3-5 words)", "detail": "Minimum 60 words. Same source-bound standard." },
    { "title": "Concise label (3-5 words)", "detail": "Minimum 60 words. Same source-bound standard." }
  ],
  "editorialNote": "Minimum 80 words. A frank, first-person-plural editorial reflection from the thisDay. team. Start with 'What strikes us about this is...' or 'We keep coming back to one thing:' or a similarly direct opening. Say something that the body of the article could not quite say — an honest opinion about what this event reveals about power, human nature, or the gap between how history is remembered and what actually happened. No hedging. No 'it is important to remember'. Say the thing.",
  "keyTerms": [
    { "term": "Exact phrase as it appears in the article text", "wikiUrl": "https://en.wikipedia.org/wiki/Exact_Article", "type": "person" },
    { "term": "Another key person, place, or event named in the article", "wikiUrl": "https://en.wikipedia.org/wiki/Another_Article", "type": "event" },
    "provide 5 to 8 entries total — key people, battles, organizations, treaties, or places that appear verbatim in the article body; type must be one of: person, place, event, organization",
    "MANDATORY: at least one entry MUST have type 'person' naming a real, specific individual connected to this event — for example the leader, founder, scientist, author, inventor, official, commander, pilot, investigator, survivor, victim, or eyewitness named in the source. Every historical event involves named people; if no obvious protagonist exists, name the person most directly responsible for, affected by, or associated with the event. Never return zero people.",
    "include every named person who appears at least twice in the article body, plus any person in quickFacts Key Figure or organizerName; do not omit living officials, historians, witnesses, founders, directors, or authors if their full name appears in the prose"
  ],
  "wikiUrl": "https://en.wikipedia.org/wiki/Article",
  "youtubeSearchQuery": "specific event name year history documentary",
  "bookSearchQuery": "3-5 word search query optimised for finding books about this specific event on Amazon, eBay, and Open Library. Pick the most useful book topic for a reader: the exact event, the main person, the war/movement, the artist, or the scientific discovery. Example: 'italian invasion ethiopia 1935'.",
  "amazonBookTopic": "Short human-readable topic for Amazon book recommendations, 3-7 words. Example: 'Books on the Italo-Ethiopian War'.",
  "amazonProductIdeas": [
    { "label": "Short card title, 3-6 words", "searchQuery": "Amazon search query for a book or item directly connected to this article", "type": "book" },
    { "label": "Second card title", "searchQuery": "Amazon search query for a biography, art print, map, documentary, educational kit, or topic-related item", "type": "book|biography|art|map|documentary|education" },
    { "label": "Third card title", "searchQuery": "Amazon search query for another relevant product angle, never generic", "type": "book|biography|art|map|documentary|education" }
  ],
  "contentRationale": "Minimum 40 words. Answer this specific question: what does a reader find in this article that Wikipedia's entry on the same event does not already give them? Name the specific angle, the particular framing, the overlooked detail, or the editorial judgement that makes this article worth reading over the Wikipedia source. Do not be vague. Do not say 'deeper context' or 'engaging narrative'."
}`;

  // Provider-size contract: the full style guide above is useful as a writing
  // reference, but it pushes free external providers over their per-request
  // token limits once source material and a 4k completion budget are included.
  // Send a compact contract and let the structural/quality gates below enforce
  // the same requirements before any draft can be stored.
  const compactSourceSection = sourceMaterial
    ? `SOURCE MATERIAL, the single source of truth:\n"""\n${String(sourceMaterial).slice(0, 5500)}\n"""\n`
    : "";
  const compactContextHook = contextHook
    && !sourceMaterial
    ? `Current-world hook to weave into conclusion or editorial note, not verbatim: ${contextHook}\n`
    : "";
  const compactAvoidSection = takenThisMonth.length > 0
    ? `Avoid these already covered or closely related topics:\n${takenThisMonth.slice(0, 18).map((title) => `- ${title}`).join("\n")}\n`
    : "";
  const compactPrompt = `Write a source-grounded thisDay.info history article as raw JSON only.

Event: ${forcedEvent ? `"${forcedEvent}"` : `a significant event from ${monthName} ${day}`}
Required date: ${monthName} ${day}. The historicalDate and historicalDateISO month/day must match this date.
${compactContextHook}${compactSourceSection}${compactAvoidSection}${stricterGrounding ? "Previous draft failed grounding. Use only relationships, outcomes, and consequences explicitly stated by the source.\n" : ""}
Grounding rules:
- Use only SOURCE MATERIAL for factual claims when it is supplied. If a number, quote, person, document, place, motive, or consequence is not there, do not invent it.
- Never copy http://, https://, or www. text into any visible prose field. URLs belong only in URL and source metadata fields.
- Do not include any proper noun, year, treaty, law, massacre, conference, battle, aviation protocol, or named policy unless it appears in SOURCE MATERIAL.
- If SOURCE MATERIAL is thin on aftermath, say what the record confirms and what remains unresolved. Never fill the gap with general knowledge.
- Do not write that one event led to, caused, triggered, prompted, prevented, enabled, ended, established, abolished, or changed another result unless SOURCE MATERIAL explicitly states that relationship.
- Chronology is not causality. When SOURCE MATERIAL only records that B happened after A, describe A and B separately and never claim A caused B.
- Never invent gun-law changes, security reforms, mental-health effects, policy debates, institutional responses, public lessons, effectiveness claims, or better alternatives.
- Quick Facts, Did You Know, analysis, aftermath, conclusions, and the editorial note must stay source-bound. Do not fill required space with inferred significance, legacy, prevention, or moral instruction.
- Keep recognition, arrest, death, departure, arrival, and capture dates and places distinct.
- If no named witness or document appears in SOURCE MATERIAL, leave eyewitnessQuote and eyewitnessQuoteSource empty and use eyewitnessOrChronicle to explain what the record confirms and what it leaves unresolved.
${groundingFeedbackSection}

Output exactly this JSON shape and no extra text:
{
  "title": "... — ${monthName} ${day}, Year",
  "curiosityTitle": "How or Why question using a distinct source-supported niche angle?",
  "eventTitle": "...",
  "historicalDate": "Month Day, Year",
  "historicalYear": 1234,
  "historicalDateISO": "YYYY-MM-DD",
  "location": "City, Country",
  "country": "Country",
  "description": "120-155 chars",
  "ogDescription": "100-130 chars",
  "twitterDescription": "90-120 chars",
  "keywords": "comma separated keywords",
  "imageUrl": "",
  "imageAlt": "specific alt text",
  "jsonLdName": "event name",
  "jsonLdDescription": "schema description",
  "jsonLdUrl": "source URL",
  "organizerName": "key person or organization",
  "readingTimeMinutes": 8,
  "quickFacts": [{"label":"Event","value":"..."},{"label":"Date","value":"..."},{"label":"Location","value":"..."},{"label":"Key Figure","value":"..."},{"label":"Source Detail","value":"..."},{"label":"Confirmed Outcome","value":"..."}],
  "didYouKnowFacts": ["five distinct facts, 35-55 words each"],
  "overviewParagraphs": ["two paragraphs, 125-145 words each"],
  "eyewitnessOrChronicle": ["two paragraphs, 115-135 words each"],
  "eyewitnessQuote": "",
  "eyewitnessQuoteSource": "",
  "aftermathParagraphs": ["two paragraphs, 120-145 words each"],
  "conclusionParagraphs": ["two paragraphs, 105-125 words each"],
  "analysisGood": [{"title":"3-5 words","detail":"60+ words evaluating a source-documented action, response, or strength of the record"}],
  "analysisBad": [{"title":"3-5 words","detail":"60+ words evaluating a source-documented failure, limitation, or unresolved question"}],
  "editorialNote": "80+ words from the thisDay. team",
  "keyTerms": [{"term":"exact article phrase","wikiUrl":"https://en.wikipedia.org/wiki/...","type":"person"}],
  "wikiUrl": "source URL",
  "youtubeSearchQuery": "specific event year history documentary",
  "bookSearchQuery": "3-5 word book search",
  "amazonBookTopic": "3-7 word book topic",
  "amazonProductIdeas": [{"label":"3-6 words","searchQuery":"specific book or item search","type":"book"}],
  "contentRationale": "40+ words"
}

Field requirements:
- curiosityTitle is the public search/card/H1 headline. It must be a 35-65 character How, Why, What, Who, Which, or Where question with exactly one final question mark and no date suffix.
- Find one source-supported niche beyond the event label: a surprising transformation, contradiction, overlooked location, hidden decision, misunderstood cause, or concrete consequence. Keep the recognizable event name in the question.
- curiosityTitle must be fully answered by SOURCE MATERIAL and the article. Never use generic "What happened?", hype, a secret/mystery formula, or an invented premise.
- title and eventTitle remain locked factual/date labels. They are not questions and must keep the selected event identity unchanged.
- quickFacts must contain exactly 6 populated facts. didYouKnowFacts must contain exactly 5 distinct facts.
- Every Quick Fact must be directly supported. Do not use Significance, Legacy, Impact, or Lessons labels unless SOURCE MATERIAL explicitly states the claimed consequence. Prefer Source Detail, Investigation, Trial, Decision, Record, or Confirmed Outcome.
- Every Did You Know fact must come from SOURCE MATERIAL. Do not invent a surprising consequence, coincidence, motive, fate, or policy effect.
- analysisGood must contain at least 3 items. analysisBad must contain at least 3 items. Each detail must be 60+ words.
- Analysis must evaluate only source-documented actions or limitations. Do not invent why something worked, what it prevented, what changed because of it, who deserves credit beyond the source, or what a better alternative would have been.
- Do not critique the article's writing, sourcing, repetition, or credibility inside analysisGood or analysisBad.
- keyTerms must contain 5-8 entries and at least one real named person connected to the event.
- imageUrl may be empty or a supported Wikimedia URL, never a placeholder.
- Body fields overviewParagraphs, eyewitnessOrChronicle, aftermathParagraphs, and conclusionParagraphs must total 900-1250 words. This is a hard publication gate.
- overviewParagraphs, eyewitnessOrChronicle, aftermathParagraphs, and conclusionParagraphs must each be arrays of exactly 2 paragraph strings, exactly 8 body paragraphs total.
- Every body paragraph must be at least 105 words. Count silently before responding. If any body paragraph is under 105 words, the article is rejected.

Writing rules:
- Lead with the strongest concrete fact in the first two sentences. Facts before mood.
- Every paragraph needs a specific name, date, number, place, institution, source, or quote.
- No rhetorical questions outside curiosityTitle, no first-person singular narrator, no fake witness voice.
- No raw URLs in quick facts, Did You Know facts, body paragraphs, analysis, timeline labels, quotes, or editorial notes.
- No hyphens or em dashes inside article body fields. Use commas or periods.
- No filler phrases: significant event, pivotal moment, changed history, lasting impact, cannot be overstated, it is important to remember, dark chapter.
- Do not repeat the same fact across sections. Repeated facts with different wording are still repetition.
- Title and eventTitle must be short subject-plus-finite-verb clauses, not noun phrases with a bare verb appended.
- End every string as a complete sentence where prose is expected.`;

  // 4096 matches the documented article-generation budget (1050-1250 word
  // body + the full JSON structure needs real headroom). Per-model defensive
  // capping now lives in callAI()'s Groq path (capGroqMaxTokens in
  // js/shared/ai-call.js) — it trims the request down for any fallback model
  // with a tighter TPM ceiling than the primary, so this base value doesn't
  // need to be conservative for the worst-case model anymore. Truncation is
  // still handled by the malformed-output retry loop and quality gates.
  const callArticleAI = env.ARTICLE_GENERATION_PREFER_WORKERS_AI
    ? callPublicationGateAI
    : callAI;
  const rawValue = await callArticleAI(
    env,
    [
      {
        role: "system",
        content:
          "You are a historical content writer. Always respond with valid JSON only, no markdown, no extra text. You MUST complete every field fully — every paragraph must end with a complete sentence and a closing punctuation mark. Never truncate mid-sentence.",
      },
      { role: "user", content: compactPrompt },
    ],
    {
      maxTokens: 4096,
      timeoutMs: 90_000,
      cfModel: model,
      temperature: 0.15,
      // 10 Groq attempts + 3 OpenRouter keys + NVIDIA still leaves one
      // internal Workers AI fallback while bounding the external chain.
      providerAttemptLimit: 15,
    },
  );

  if (!rawValue || rawValue.trim().length < 100) {
    throw new Error(
      `AI response too short or empty (${rawValue.length} chars)`,
    );
  }

  // Strip any accidental markdown code fences the model may add
  const cleaned = rawValue
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  // Extract the first complete {...} block. If the model returned prose (no {),
  // retry once with an ultra-explicit JSON-only prompt before giving up.
  let jsonStart = cleaned.indexOf("{");
  let jsonCandidate;
  if (jsonStart === -1) {
    console.warn(`Blog: AI returned prose instead of JSON (${rawValue.length} chars). Retrying with explicit JSON instruction...`);
    const retryRaw = await callArticleAI(
      env,
      [
        {
          role: "system",
          content:
            "You are a JSON API. Your response MUST start with '{' and end with '}'. Output ONLY valid JSON, absolutely nothing else.",
        },
        {
          role: "user",
          content:
            `${compactPrompt}\n\nIMPORTANT: Start your response immediately with the character { and end with }. Do not write any prose or explanation. Begin with { right now.`,
        },
      ],
      {
        maxTokens: 4096,
        timeoutMs: 90_000,
        cfModel: model,
        temperature: 0.15,
        providerAttemptLimit: 15,
      },
    );
    const retryStart = String(retryRaw || "").trim().indexOf("{");
    if (retryStart === -1)
      throw new Error(`No JSON found in model output after retry: ${rawValue.slice(0, 200)}`);
    jsonCandidate = String(retryRaw).trim().slice(retryStart);
  } else {
    jsonCandidate = cleaned.slice(jsonStart);
  }

  // Try clean parse first
  let parsed;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch (_firstErr) {
    // First try escaping raw control characters inside string literals — AI
    // models frequently emit literal newlines/tabs inside string values, which
    // is a formatting slip, not a truncation. Sanitizing recovers the full
    // article instead of falling into the lossy truncation-repair path below.
    try {
      parsed = JSON.parse(sanitizeJsonControlChars(jsonCandidate));
      return normalizeGeneratedArticleContent(parsed, date);
    } catch (_sanitizeErr) {
      // fall through to truncation repair
    }
    // Attempt basic truncation repair: close any open string and unclosed brackets.
    // This recovers articles where the last field was cut mid-value.
    let repaired = jsonCandidate;
    // Count unclosed braces/brackets
    let braces = 0, brackets = 0, inString = false, escaped = false;
    for (let i = 0; i < repaired.length; i++) {
      const ch = repaired[i];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") braces++;
      else if (ch === "}") braces--;
      else if (ch === "[") brackets++;
      else if (ch === "]") brackets--;
    }
    // Close open string if needed
    if (inString) repaired += '"';
    // Close open arrays/objects
    while (brackets-- > 0) repaired += "]";
    while (braces-- > 0) repaired += "}";
    try {
      parsed = JSON.parse(repaired);
      console.warn(`Blog: article JSON was truncated and repaired for ${date.toISOString().slice(0, 10)}`);
    } catch (e) {
      throw new Error(
        `JSON parse failed (even after repair): ${e.message} — Raw: ${rawValue.slice(0, 300)}`,
      );
    }
  }

  return normalizeGeneratedArticleContent(parsed, date);
}

// ---------------------------------------------------------------------------
// P4a — Context hook: "why now" grounding sentence
// ---------------------------------------------------------------------------

/**
 * Fetches a short current-world hook for the publish date.
 * Returns a single sentence (or null on any failure) that connects today's
 * world to the historical event being covered, giving the main generation
 * prompt a temporal anchor it could not have had six months ago.
 *
 * @param {object} env
 * @param {Date}   date        The publish date (today)
 * @param {string|null} forcedEvent  Event name if forced, otherwise null
 * @returns {Promise<string|null>}
 */
async function fetchContextHook(env, date, forcedEvent = null) {
  // NOTE: The AI may hallucinate current-world parallels if the event is outside
  // its training data. This is acceptable because the hook is injected only into
  // the editorial/conclusion layer (opinion framing), never into the factual
  // article body which is separately fact-checked by factCheckContent().
  try {
    const monthName = MONTH_NAMES[date.getMonth()];
    const day = date.getDate();
    const year = date.getFullYear();
    const eventHint = forcedEvent
      ? ` The article will cover: "${forcedEvent}".`
      : "";

    const prompt =
      `Today is ${monthName} ${day}, ${year}.${eventHint}\n` +
      `In one sentence (max 60 words), identify a current-world parallel, anniversary resonance, or modern echo that makes a historical event from ${monthName} ${day} feel especially relevant *right now* in ${year}.\n` +
      `Requirements:\n` +
      `- Must reference something real happening in ${year} or a round-number anniversary (e.g. 80th, 100th)\n` +
      `- Must be specific — name a country, conflict, technology, or cultural moment\n` +
      `- Must not be generic ("history repeats itself", "lessons of the past")\n` +
      `- Respond with the single sentence only. No preamble, no explanation.`;

    const result = await callAI(
      env,
      [
        {
          role: "system",
          content:
            "You provide concise, specific current-affairs context for historical articles. Respond with one sentence only.",
        },
        { role: "user", content: prompt },
      ],
      { maxTokens: 120, timeoutMs: 15_000 },
    );

    const hook = result?.trim().replace(/^["']|["']$/g, "");
    if (!hook || hook.length < 20) return null;
    console.log(`contextHook: "${hook}"`);
    return hook;
  } catch (err) {
    console.warn(`contextHook: skipped — ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// P4b — Separate editorial note pass
// ---------------------------------------------------------------------------

/**
 * Generates the editorial note in an isolated second AI call, after the full
 * article body is written. Passes the complete article as context so the note
 * can respond to specific things in the article — not just the topic.
 *
 * Constraints enforced in the prompt:
 *   - Must reference something from the publish year (${year}) or a current parallel
 *   - Must make a connection the article body did not explicitly make
 *   - Must be 100+ words, first-person plural, no hedging
 *
 * Mutates content.editorialNote in-place. Keeps existing value on any error.
 *
 * @param {object} env
 * @param {object} content  Article content object — mutated directly
 * @param {Date}   date     Publish date
 */
async function generateEditorialNote(env, content, date) {
  try {
    const year = date.getFullYear();
    const articleSummary =
      `Title: ${content.title}\n` +
      `Event: ${content.eventTitle} (${content.historicalDate})\n` +
      `Location: ${content.location || "unknown"}\n\n` +
      `Overview:\n${(content.overviewParagraphs || []).join("\n\n")}\n\n` +
      `Aftermath:\n${(content.aftermathParagraphs || []).join("\n\n")}\n\n` +
      `Conclusion:\n${(content.conclusionParagraphs || []).join("\n\n")}`;
    const sourceMaterial = sourceBoundRepairContext(groundingSourceFromContent(content), 4000);

    const prompt =
      `You are the thisDay. editorial team writing a short opinion note to appear at the end of the article below.\n\n` +
      `ARTICLE:\n${articleSummary}\n\n` +
      (sourceMaterial ? `AUTHORITATIVE SOURCE MATERIAL:\n${sourceMaterial}\n\n` : "") +
      `YOUR TASK:\n` +
      `Write a first-person-plural editorial note (100–150 words) that:\n` +
      `1. Opens with "What strikes us about this is..." or "We keep coming back to one thing:" or a similarly direct opener\n` +
      `2. Uses at least two concrete details from the article, such as names, dates, places, institutions, numbers, or decisions\n` +
      `3. If you connect it to ${year}, make the connection direct and modest. Do not force a current crisis into an event that does not directly involve war, diplomacy, public safety, science, or politics\n` +
      `4. Says something the article body could not quite say — an honest opinion about what this event reveals about power, human nature, memory, media, institutions, or public ceremony\n` +
      `5. Ends with one precise, memorable sentence\n\n` +
      `ABSOLUTE RULES:\n` +
      `- Every concrete detail you cite (name, institution, document, report, number, victim, expert, or source) must already appear in the article or source material above. Never invent one. If you need an anchor the source does not provide, stay with what is given or make the point more modestly.\n` +
      `- No hedging. No "it is important to remember". No "this serves as a reminder".\n` +
      `- No Ukraine, war, major world powers, global polarization, or modern-conflict comparisons unless the article itself is directly about war or diplomacy\n` +
      `- No cynical abstractions or generic legacy phrases: "manipulation", "facade", "façade", "illusion", "escapism", "spectacle", "fantasy", "testament to", "lasting legacy", "enduring impact", "calculated nature of power", or "harsh realities"\n` +
      `- Do not summarize the article — respond to it\n` +
      `- Do not mention Wikipedia or sources\n` +
      `- Respond with the note text only. No preamble, no label, no quotes around it.`;

    const result = await callAI(
      env,
      [
        {
          role: "system",
          content:
            "You are a sharp editorial voice. Write the note only — no preamble, no labels.",
        },
        { role: "user", content: prompt },
      ],
      { maxTokens: 300, timeoutMs: 20_000 },
    );

    const note = result?.trim().replace(/^["']|["']$/g, "");
    if (!note || note.length < 80) {
      console.warn(
        "generateEditorialNote: response too short, keeping original",
      );
      return;
    }
    content.editorialNote = note;
    console.log(`generateEditorialNote: replaced (${note.length} chars)`);
  } catch (err) {
    console.warn(`generateEditorialNote: skipped — ${err.message}`);
    // Keep existing content.editorialNote unchanged
  }
}

// ---------------------------------------------------------------------------
// Fact-check pass — lightweight verification of core fields after generation
// ---------------------------------------------------------------------------

/**
 * Asks the AI to verify the core factual fields of a generated article
 * (event date, year, location) and applies any confident corrections in-place.
 * Designed to be adversarial — "find errors", not "confirm correctness".
 * Never throws; logs and returns silently on any failure.
 *
 * @param {object} env
 * @param {object} content  Parsed content object — mutated directly on correction.
 */
// ---------------------------------------------------------------------------
// Source grounding — credibility gate (2026-06-20)
// The body generator is grounded in the selected event's Wikipedia source (see
// callWorkersAI `sourceMaterial`). These deterministic checks are the hard gate
// that stops a fabricated or contradicted draft from being published:
//   - wrong-event fabrication  (June 20, 2026: invented "ABC News broadcast
//     glitch" instead of the real Bill Stewart murder)
//   - wrong-fact fabrication   (June 19, 2026: invented "46 deaths"; real 15)
// ---------------------------------------------------------------------------

// Casualty/death-toll numbers stated in a piece of text. Only numbers adjacent
// to a death word are captured, so "46 families" / "7 crew" are ignored while
// "loss of all 46 lives" / "killing 15" are caught.
const DEATH_TOLL_PATTERNS = [
  /\bloss of (?:all |about |around |over |nearly )?(\d[\d,]*)\s+(?:lives|people|souls)\b/gi,
  /\b(\d[\d,]*)\s+(?:lives|people|passengers|crew|soldiers|civilians|victims)?\s*(?:were|was|are|is)?\s*(?:killed|died|dead|perished|massacred|murdered|executed|slain)\b/gi,
  /\bkill(?:ed|ing|s)?\s+(?:about |around |over |nearly |at least )?(\d[\d,]*)\b/gi,
  /\b(\d[\d,]*)\s+(?:deaths|fatalities|casualties)\b/gi,
  /\b(\d[\d,]*)\s+lives?\s+(?:were\s+)?lost\b/gi,
];

function extractDeathTolls(text) {
  const s = String(text || "");
  const found = new Set();
  for (const re of DEATH_TOLL_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      const n = parseInt(String(m[1]).replace(/,/g, ""), 10);
      if (Number.isFinite(n) && n > 0) found.add(n);
    }
  }
  return [...found];
}

// Significant subject tokens of the canonical source page (its Wikipedia title).
// Parentheticals/disambiguators are dropped. The article must name at least one
// of these. We use ONLY the canonical page title — not the one-line feed text —
// so words the fabricated and real stories happen to share ("ABC News") do not
// mask a wrong-event article.
const SUBJECT_STOPWORDS = new Set([
  "the", "of", "and", "in", "on", "at", "to", "for", "a", "an", "de", "la", "el",
  "battle", "war", "flight", "event", "crash", "incident", "attack", "disaster",
]);

function sourceSubjectTokens(source) {
  const tokens = new Set();
  // From the canonical page title: proper nouns / years (len >= 3).
  const title = String(source?.pageTitle || "").replace(/\([^)]*\)/g, " ");
  for (const raw of title.split(/[\s,]+/)) {
    const w = raw.trim();
    if (!w) continue;
    const isProper = /^[A-Z]/.test(w) && w.length >= 3;
    const isNumber = /^\d{2,4}$/.test(w);
    if ((isProper || isNumber) && !SUBJECT_STOPWORDS.has(w.toLowerCase())) {
      tokens.add(w);
    }
  }
  // From the feed text + extract: add only DISTINCTIVE proper-case nouns
  // (len >= 5, "Capital + lowercase"). This lets a synonym of the page title
  // (e.g. "Normandy"/"Overlord") satisfy the check, while short or all-caps
  // shared words ("ABC", "News") can never mask a wrong-event article.
  const corpus = `${source?.text || ""} ${source?.sourceExtract || ""}`;
  for (const raw of corpus.split(/[\s,.;:"'()]+/)) {
    const w = raw.trim();
    if (w.length >= 5 && /^[A-Z][a-z]+$/.test(w) && !SUBJECT_STOPWORDS.has(w.toLowerCase())) {
      tokens.add(w);
    }
  }
  return [...tokens];
}

function groundingSourceFromContent(content) {
  if (!content) return null;
  const sourcePages = sourcePagesFromContent(content);
  const source = {
    pageTitle: content.sourcePageTitle || sourcePages[0]?.pageTitle || "",
    text: content.sourceText || "",
    sourceExtract: content.sourceExtract || sourcePages[0]?.extract || "",
    sourcePages,
  };
  return source.pageTitle || source.text || source.sourceExtract || sourcePages.length > 0
    ? source
    : null;
}

function sourceMaterialForGrounding(source) {
  if (!source) return "";
  const sections = [];
  if (source.text) sections.push(`Event listing: ${String(source.text).trim()}`);
  if (source.sourceExtract) {
    sections.push(`Primary source extract: ${String(source.sourceExtract).trim()}`);
  }
  for (const page of normalizeSourcePages(source.sourcePages || []).slice(0, 4)) {
    if (!page.extract) continue;
    sections.push(`${page.pageTitle || "Wikipedia source"}: ${page.extract}`);
  }
  const seen = new Set();
  return sections
    .map((section) => section.replace(/\s+/g, " ").trim())
    .filter((section) => {
      const key = normalizeForCompare(section);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join("\n\n")
    .slice(0, 16000);
}

function collectGroundingStrings(value, out = []) {
  if (typeof value === "string") {
    const text = value.replace(/\s+/g, " ").trim();
    if (text) out.push(text);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectGroundingStrings(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/url|image|searchquery|type/i.test(key)) continue;
      collectGroundingStrings(item, out);
    }
  }
  return out;
}

function articleGroundingText(content) {
  const groundedFields = {
    title: content?.title,
    curiosityTitle: content?.curiosityTitle,
    eventTitle: content?.eventTitle,
    description: content?.description,
    quickFacts: content?.quickFacts,
    didYouKnowFacts: content?.didYouKnowFacts,
    overviewParagraphs: content?.overviewParagraphs,
    eyewitnessOrChronicle: content?.eyewitnessOrChronicle,
    eyewitnessQuote: content?.eyewitnessQuote,
    eyewitnessQuoteSource: content?.eyewitnessQuoteSource,
    aftermathParagraphs: content?.aftermathParagraphs,
    conclusionParagraphs: content?.conclusionParagraphs,
    analysisGood: content?.analysisGood,
    analysisBad: content?.analysisBad,
    editorialNote: content?.editorialNote,
    timeline: content?.timeline,
  };
  return collectGroundingStrings(groundedFields).join("\n");
}

const GROUNDING_CLAIM_HEDGE_PATTERN =
  /\b(?:apparently|arguably|could|likely|may|might|perhaps|possibly|probably|seems?|suggests?)\b/i;
const GROUNDING_SUPPORT_STOPWORDS = new Set([
  "about", "after", "again", "against", "also", "among", "another", "around",
  "article", "because", "before", "being", "between", "both", "caused", "causes",
  "causing", "could", "during", "event", "first", "from", "government", "historic",
  "historical", "history", "into", "later", "more", "most", "other", "resulted",
  "resulting", "same", "such", "than", "that", "their", "them", "then", "there",
  "these", "they", "this", "through", "under", "upon", "were", "when", "where",
  "which", "while", "with", "would", "year", "years",
]);

const GROUNDING_CLAIM_RISK_RULES = [
  {
    label: "order attribution",
    claim:
      /\b(?:authori[sz](?:e[ds]?|ing)|command(?:ed|s|ing)?|direct(?:ed|s|ing)?|order(?:ed|s|ing)?)\b/i,
    support:
      /\b(?:authori[sz](?:e[ds]?|ing)|command(?:ed|s|ing)?|direct(?:ed|s|ing)?|order(?:ed|s|ing)?)\b/i,
  },
  {
    label: "perpetrator attribution",
    claim:
      /\b(?:assassinat(?:e[ds]?|ing)|carried out (?:the )?(?:assassination|attack|bombing|execution|killing|massacre|murder|raid|shooting)|execut(?:e[ds]?|ing)|kill(?:ed|s|ing)?|murder(?:ed|s|ing)?)\b/i,
    support:
      /\b(?:assassinat(?:e[ds]?|ing)|carried out (?:the )?(?:assassination|attack|bombing|execution|killing|massacre|murder|raid|shooting)|execut(?:e[ds]?|ing)|kill(?:ed|s|ing)?|murder(?:ed|s|ing)?)\b/i,
  },
  {
    label: "parent relationship",
    claim: /\b(?:child|daughter|father|mother|parent|son)\b/i,
    support: /\b(?:child|daughter|father|mother|parent|son)\b/i,
  },
  {
    label: "sibling relationship",
    claim: /\b(?:brother|sibling|sister)\b/i,
    support: /\b(?:brother|sibling|sister)\b/i,
  },
  {
    label: "extended-family relationship",
    claim: /\b(?:aunt|cousin|nephew|niece|uncle)\b/i,
    support: /\b(?:aunt|cousin|nephew|niece|uncle)\b/i,
  },
  {
    label: "marital relationship",
    claim: /\b(?:husband|marri(?:age|ed)|spouse|wife)\b/i,
    support: /\b(?:husband|marri(?:age|ed)|spouse|wife)\b/i,
  },
  {
    label: "succession relationship",
    claim: /\b(?:predecessor|replac(?:e[ds]?|ing)|succeeded (?:as|by)|successor)\b/i,
    support: /\b(?:predecessor|replac(?:e[ds]?|ing)|succeeded (?:as|by)|successor)\b/i,
  },
  {
    label: "causal claim",
    claim:
      /\b(?:because(?:\s+of)?|brought about|caus(?:e[ds]?|ing)|due to|gave rise to|leads? to|led to|prompt(?:ed|s|ing)?|result(?:ed|s|ing)? in|spark(?:ed|s|ing)?|trigger(?:ed|s|ing)?)\b/i,
    support:
      /\b(?:because(?:\s+of)?|brought about|caus(?:e[ds]?|ing)|due to|gave rise to|leads? to|led to|prompt(?:ed|s|ing)?|result(?:ed|s|ing)? in|spark(?:ed|s|ing)?|trigger(?:ed|s|ing)?)\b/i,
  },
  {
    label: "coercive outcome",
    claim: /\b(?:compel(?:led|s|ling)?|forc(?:e[ds]?|ing))\b/i,
    support: /\b(?:compel(?:led|s|ling)?|forc(?:e[ds]?|ing))\b/i,
  },
  {
    label: "enabling outcome",
    claim: /\b(?:allow(?:ed|s|ing)?|enabl(?:e[ds]?|ing))\b/i,
    support: /\b(?:allow(?:ed|s|ing)?|enabl(?:e[ds]?|ing))\b/i,
  },
  {
    label: "preventive outcome",
    claim: /\b(?:block(?:ed|s|ing)?|prevent(?:ed|s|ing)?)\b/i,
    support: /\b(?:block(?:ed|s|ing)?|prevent(?:ed|s|ing)?)\b/i,
  },
  {
    label: "institutional outcome",
    claim:
      /\b(?:abolish(?:ed|es|ing)?|creat(?:e[ds]?|ing)|dissolv(?:e[ds]?|ing)|establish(?:ed|es|ing)?|found(?:ed|ing))\b/i,
    support:
      /\b(?:abolish(?:ed|es|ing)?|creat(?:e[ds]?|ing)|dissolv(?:e[ds]?|ing)|establish(?:ed|es|ing)?|found(?:ed|ing))\b/i,
  },
  {
    label: "ending outcome",
    claim: /\b(?:conclud(?:e[ds]?|ing)|end(?:ed|s|ing)|terminat(?:e[ds]?|ing))\b/i,
    support: /\b(?:conclud(?:e[ds]?|ing)|end(?:ed|s|ing)|terminat(?:e[ds]?|ing))\b/i,
  },
];

// A source can state a direct casualty outcome with a plain predicate while an
// article uses equivalent causal syntax: "the arson killed 36 people" supports
// "the attack resulted in 36 deaths." Keep this equivalence deliberately
// narrow. It does not apply to policy, motive, prevention, security changes, or
// other downstream consequences.
const GROUNDING_DIRECT_CASUALTY_OUTCOME_RULES = [
  {
    claim: /\b(?:death|deaths|died|fatalit(?:y|ies)|kill(?:ed|s|ing)?)\b/i,
    support: /\b(?:death|deaths|died|fatalit(?:y|ies)|kill(?:ed|s|ing)?)\b/i,
  },
  {
    claim: /\b(?:injur(?:ed|ies|ing|y)?|wound(?:ed|s|ing)?)\b/i,
    support: /\b(?:injur(?:ed|ies|ing|y)?|wound(?:ed|s|ing)?)\b/i,
  },
];

function collectGroundingClaimEntries(value, path = "", out = []) {
  if (typeof value === "string") {
    const text = value.replace(/\s+/g, " ").trim();
    if (text) out.push({ field: path, text });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectGroundingClaimEntries(item, `${path}[${index}]`, out),
    );
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/url|image|searchquery|type/i.test(key)) continue;
      collectGroundingClaimEntries(item, path ? `${path}.${key}` : key, out);
    }
  }
  return out;
}

function groundingClaimEntries(content) {
  return collectGroundingClaimEntries({
    title: content?.title,
    eventTitle: content?.eventTitle,
    description: content?.description,
    quickFacts: content?.quickFacts,
    didYouKnowFacts: content?.didYouKnowFacts,
    overviewParagraphs: content?.overviewParagraphs,
    eyewitnessOrChronicle: content?.eyewitnessOrChronicle,
    eyewitnessQuote: content?.eyewitnessQuote,
    eyewitnessQuoteSource: content?.eyewitnessQuoteSource,
    aftermathParagraphs: content?.aftermathParagraphs,
    conclusionParagraphs: content?.conclusionParagraphs,
    analysisGood: content?.analysisGood,
    analysisBad: content?.analysisBad,
    editorialNote: content?.editorialNote,
    timeline: content?.timeline,
  });
}

function groundingSupportStem(token) {
  const value = String(token || "");
  if (value.length >= 7 && /(?:ing|ers|ies)$/.test(value)) {
    return value.replace(/(?:ing|ers|ies)$/, "");
  }
  if (value.length >= 6 && /(?:ed|es)$/.test(value)) {
    return value.replace(/(?:ed|es)$/, "");
  }
  if (value.length >= 5 && /s$/.test(value)) return value.slice(0, -1);
  return value;
}

function groundingSupportTokens(value) {
  return new Set(
    normalizeForCompare(value)
      .split(/\s+/)
      .map((token) => token.replace(/[^a-z0-9]/g, ""))
      .filter((token) =>
        token.length >= 4 &&
        !/^\d+$/.test(token) &&
        !GROUNDING_SUPPORT_STOPWORDS.has(token),
      )
      .map(groundingSupportStem)
      .filter((token) => token.length >= 3),
  );
}

function groundingProperAnchors(value) {
  const anchors = new Set();
  for (const match of String(value || "").matchAll(/\b[A-Z][A-Za-z'’.-]{2,}\b/g)) {
    const token = normalizeForCompare(match[0]).replace(/[^a-z0-9]/g, "");
    if (
      token.length >= 3 &&
      !GROUNDING_SUPPORT_STOPWORDS.has(token) &&
      !SUBJECT_STOPWORDS.has(token)
    ) {
      anchors.add(groundingSupportStem(token));
    }
  }
  return anchors;
}

function groundingClaimHasSourceSupport(claim, sourceSentence) {
  const claimTokens = groundingSupportTokens(claim);
  const sourceTokens = groundingSupportTokens(sourceSentence);
  const shared = tokenMatches(claimTokens, sourceTokens);
  const anchors = groundingProperAnchors(claim);
  const sharedAnchors = tokenMatches(anchors, sourceTokens);
  const minimumShared = claimTokens.size >= 5 ? 2 : 1;
  return (
    shared.length >= minimumShared &&
    (anchors.size === 0 || sharedAnchors.length > 0)
  );
}

function groundingClaimNumbers(value) {
  return Array.from(
    String(value || "").matchAll(/\b\d[\d,]*(?:\.\d+)?\b/g),
    (match) => match[0].replace(/,/g, ""),
  );
}

function groundingDirectCasualtyOutcomeHasSupport(claim, sourceEvidence) {
  const matchedOutcomeRules = GROUNDING_DIRECT_CASUALTY_OUTCOME_RULES.filter(
    (rule) => rule.claim.test(claim),
  );
  if (matchedOutcomeRules.length === 0) return false;
  if (
    !matchedOutcomeRules.every((rule) => {
      rule.support.lastIndex = 0;
      return rule.support.test(sourceEvidence);
    })
  ) {
    return false;
  }

  // Exact numbers are part of a casualty claim's identity. Do not let a
  // semantically similar sentence support different dates or tolls.
  const sourceNumbers = new Set(groundingClaimNumbers(sourceEvidence));
  if (
    groundingClaimNumbers(claim).some((number) => !sourceNumbers.has(number))
  ) {
    return false;
  }
  return groundingClaimHasSourceSupport(claim, sourceEvidence);
}

function unsupportedGroundingClaims(content, sourceMaterial) {
  const sourceSentences = splitSentences(sourceMaterial).filter(Boolean);
  if (sourceSentences.length === 0) return [];
  const adjacentSourceWindows = sourceSentences.map((sentence, index) =>
    index + 1 < sourceSentences.length
      ? `${sentence} ${sourceSentences[index + 1]}`
      : sentence,
  );
  const findings = [];
  const seen = new Set();

  for (const entry of groundingClaimEntries(content)) {
    for (const sentence of splitSentences(entry.text)) {
      if (!sentence || GROUNDING_CLAIM_HEDGE_PATTERN.test(sentence)) continue;
      for (const rule of GROUNDING_CLAIM_RISK_RULES) {
        if (!rule.claim.test(sentence)) continue;
        rule.claim.lastIndex = 0;
        const key = `${rule.label}|${normalizeForCompare(sentence)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const supported = sourceSentences.some((sourceSentence) => {
          rule.support.lastIndex = 0;
          return (
            rule.support.test(sourceSentence) &&
            groundingClaimHasSourceSupport(sentence, sourceSentence)
          );
        }) || (
          rule.label === "causal claim" &&
          adjacentSourceWindows.some((sourceEvidence) =>
            groundingDirectCasualtyOutcomeHasSupport(sentence, sourceEvidence),
          )
        );
        if (!supported) {
          findings.push({
            field: entry.field,
            label: rule.label,
            sentence: sentence.slice(0, 240),
          });
        }
      }
    }
  }
  return findings.slice(0, 8);
}

/**
 * Deterministic grounding gate. Returns { ok, reasons[] }. A no-op (ok:true)
 * when no source is available (e.g. a manually forced event), so admin force
 * paths are never blocked.
 */
function verifyArticleGrounding(content, source) {
  const reasons = [];
  if (!source || (!source.pageTitle && !source.text && !source.sourceExtract)) {
    return { ok: true, reasons };
  }
  const articleText = articleGroundingText(content);
  const articleLower = articleText.toLowerCase();
  const sourceMaterial = sourceMaterialForGrounding(source);

  // 1) Subject match — the article must name the source's canonical subject.
  const subjectTokens = sourceSubjectTokens(source);
  if (
    subjectTokens.length > 0 &&
    !subjectTokens.some((t) => articleLower.includes(t.toLowerCase()))
  ) {
    reasons.push(
      `subject mismatch: article never names the source subject (${subjectTokens.join(", ")})`,
    );
  }

  // 2) Numeric contradiction — only when BOTH sides state a death toll and they
  // are disjoint. Absence is never a contradiction (keeps false positives low).
  const articleTolls = extractDeathTolls(articleText);
  const sourceTolls = extractDeathTolls(
    sourceMaterial,
  );
  if (
    articleTolls.length > 0 &&
    sourceTolls.length > 0 &&
    !articleTolls.some((n) => sourceTolls.includes(n))
  ) {
    reasons.push(
      `casualty number contradiction: article says ${articleTolls.join("/")} but source says ${sourceTolls.join("/")}`,
    );
  }

  // 3) High-risk relationship, responsibility, causality, and outcome claims
  // must have a source sentence using the same claim family plus overlapping
  // named subjects/objects. This is intentionally narrower than semantic AI
  // review: it catches unsupported hard assertions without treating omissions
  // or clearly hedged interpretation as factual contradictions.
  for (const finding of unsupportedGroundingClaims(content, sourceMaterial)) {
    reasons.push(
      `unsupported ${finding.label} in ${finding.field}: "${finding.sentence}"`,
    );
  }

  return { ok: reasons.length === 0, reasons };
}

// The LLM final-grounding grader frequently faults an article for OMITTING
// background facts from the source ("does not mention the Sirte Declaration",
// "does not mention the 55 member states") even when everything the article
// actually states is correct. Omissions are not grounding failures: an article
// need not restate every fact in its source, and the deterministic
// verifyArticleGrounding pass above already fails closed on the dangerous cases
// (subject mismatch, casualty-number contradictions) before we ever reach the
// LLM. Dropping omission-only issues stops correct articles (e.g. the
// 9-july-2026 African Union post) from being blocked. Only issues that assert
// the article STATES something contradicting the source survive to block it.
const GROUNDING_OMISSION_ISSUE_PATTERN =
  /(?:does|did|do)\s?n['’o]?t\s+(?:mention|include|state|specify|note|cover|address|elaborate|discuss|reference|list|acknowledge)|fail(?:s|ed)?\s+to\s+(?:mention|include|state|specify|note|list|acknowledge)|neglect(?:s|ed)?\s+to\s+(?:mention|include|note)|omit(?:s|ted|ting)?\b|no\s+mention\s+of|without\s+mention(?:ing)?|lack(?:s|ing)?\s+(?:a\s+)?mention|missing\s+(?:the\s+|any\s+)?(?:mention|context|reference|detail)|(?:could|should)\s+(?:also\s+)?(?:have\s+)?(?:mention(?:ed)?|included?|noted?)/i;

function filterGroundingIssues(issues) {
  const list = Array.isArray(issues)
    ? issues.map((issue) => String(issue).trim()).filter(Boolean)
    : [];
  const real = [];
  const dropped = [];
  for (const issue of list) {
    if (GROUNDING_OMISSION_ISSUE_PATTERN.test(issue)) dropped.push(issue);
    else real.push(issue);
  }
  return { real, dropped };
}

async function verifyFinalArticleGrounding(env, content, source) {
  const deterministic = verifyArticleGrounding(content, source);
  if (!deterministic.ok) return deterministic;
  const sourceMaterial = sourceMaterialForGrounding(source);
  if (!sourceMaterial) return deterministic;
  const articleText = articleGroundingText(content).slice(0, 14000);

  // Retry only on transport/parse failure. A clean parse is trusted: it either
  // passes (no real issues after omission filtering) or fails closed on the
  // remaining genuine contradictions. The grader is stochastic, so a dropped
  // request or garbled response is worth one more attempt before we hard-fail.
  let lastReason = "final grounding verifier rejected the article";
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw;
    try {
      raw = await callPublicationGateAI(
        env,
        [
          {
            role: "system",
            content:
              "You are a fail-closed historical fact checker. Compare the article with the supplied authoritative source material. Reply with JSON only.",
          },
          {
            role: "user",
            content:
              `AUTHORITATIVE SOURCE MATERIAL:\n${sourceMaterial}\n\n` +
              `FINAL ARTICLE:\n${articleText}\n\n` +
              "Start with the headline and central event claim. Reject a command-style or imperative headline with no historical actor. Reject any headline or body claim that assigns an action, order, execution, killing, relationship, title, or identity to a person when the source assigns it to someone else or does not support that attribution. Distinguish who ordered an act, who carried it out, and who was its target. " +
              "Reject an asserted cause, motive, forced response, enabled result, prevented result, institutional creation or abolition, or other concrete outcome unless the source explicitly supports that connection. Chronology alone is not causality: 'B happened after A' does not prove that A caused B. Verify family, marital, and succession relationships exactly rather than accepting that both names merely appear in the source. " +
              "Reject ONLY clear factual contradictions: conflated people/places/dates, invented casualty numbers, or named documents/quotes/reports presented as sources without support in the source material or established history. " +
              "Audit each of the exactly five Did You Know facts separately. Reject any Did You Know fact whose central claim is not directly supported by the authoritative source material, even when the source does not explicitly contradict it. Identify a rejected fact by its array index. " +
              "Pay special attention to whether recognition and arrest happened in different places and whether a cited publication existed in the stated year. " +
              "OMISSIONS ARE NOT FAILURES. The article does not need to mention, include, or elaborate on every fact in the source. Never raise an issue that the article 'does not mention', 'does not include', or 'fails to mention' something, and never fault it for leaving out background context. Only flag a fact the article actively STATES that contradicts the source. " +
              "Do not reject ordinary interpretation or clearly labeled opinion. Return exactly one JSON object: " +
              '{"passed":true,"issues":[]} or {"passed":false,"issues":["specific contradiction the article states"]}.',
          },
        ],
        { maxTokens: 700, timeoutMs: 25_000 },
      );
    } catch (err) {
      lastReason = `final grounding verifier unavailable: ${err.message}`;
      continue;
    }
    const match = raw?.match(/\{[\s\S]*\}/);
    if (!match) {
      lastReason = "final grounding verifier returned no JSON";
      continue;
    }
    let result;
    try {
      result = JSON.parse(match[0]);
    } catch {
      lastReason = "final grounding verifier returned invalid JSON";
      continue;
    }
    const { real, dropped } = filterGroundingIssues(result.issues);
    if (dropped.length > 0) {
      console.warn(
        `Final grounding: ignored ${dropped.length} omission-only issue(s): ${dropped.join(" | ").slice(0, 300)}`,
      );
    }
    if (real.length === 0) return { ok: true, reasons: [] };
    return { ok: false, reasons: real };
  }
  return { ok: false, reasons: [lastReason] };
}

// ---------------------------------------------------------------------------
// Final-grounding repair + self-heal (2026-07-11 incident). The Wikipedia feed
// blurb for Pope Adrian V asserted the wrong predecessor; the article echoed
// it, the grounding gate correctly refused, and — because the claim was baked
// into the stored draft — every retry failed identically and the day was lost.
// Now a flagged contradiction gets exactly one surgical source-bound repair
// pass and a re-verification; if that still fails, the event is recorded as
// blocked for the date and the draft is deleted so the next generation run
// picks a different topic.
// ---------------------------------------------------------------------------

const KV_BLOCKED_EVENT_PREFIX = "blocked-event:";
// Transport-level verifier failures (provider down, garbled JSON) are not
// article defects; a content repair would be pointless churn.
const GROUNDING_VERIFIER_TRANSPORT_PATTERN = /final grounding verifier/;

const GROUNDING_REPAIRABLE_STRING_FIELDS = [
  "curiosityTitle",
  "description",
  "ogDescription",
  "twitterDescription",
  "jsonLdDescription",
  "editorialNote",
];
// The factual title and eventTitle are deliberately NOT repairable: they are
// locked to the source event headline. The separate public curiosityTitle can
// be surgically repaired when its premise is not supported.
const GROUNDING_REPAIRABLE_ARRAY_FIELDS = [
  "overviewParagraphs",
  "eyewitnessOrChronicle",
  "aftermathParagraphs",
  "conclusionParagraphs",
  "didYouKnowFacts",
  "quickFacts",
  "analysisGood",
  "analysisBad",
];

async function repairGroundingContradictions(env, content, reasons, source, callAIImpl = callAI) {
  if (!Array.isArray(reasons) || reasons.length === 0) return content;
  const sourceMaterial = sourceBoundRepairContext(source);
  const repairPayload = {};
  for (const field of [...GROUNDING_REPAIRABLE_STRING_FIELDS, ...GROUNDING_REPAIRABLE_ARRAY_FIELDS]) {
    if (content[field] !== undefined) repairPayload[field] = content[field];
  }

  const systemPrompt =
    "You are a surgical fact-repair editor. The article failed a fail-closed source-grounding check. " +
    "Correct ONLY the contradicted facts listed in the audit, changing as few words as possible. " +
    "The supplied source material is authoritative; when the article and the source disagree, the source wins. " +
    "Do not rephrase, expand, or polish anything that is not contradicted. Preserve array lengths exactly. " +
    "For an unsupported cause, outcome, prevention, effectiveness, responsibility, or institutional-change claim, do not evade the audit by adding may, might, could, likely, or apparently. Replace it with neutral chronology or another concrete fact explicitly stated by the source. " +
    "Do not invent a policy lesson, security reform, mental-health effect, public debate, better alternative, or recommendation. " +
    "Never use hyphens or em dashes in article body fields. " +
    SOURCE_BOUND_REPAIR_RULES +
    "Return ONLY a JSON object containing the corrected fields.";

  const userMessage =
    (sourceMaterial ? `AUTHORITATIVE SOURCE MATERIAL:\n${sourceMaterial}\n\n` : "") +
    `Contradictions that must be corrected:\n${reasons.map((reason) => `- ${reason}`).join("\n")}\n\n` +
    `Article fields:\n${JSON.stringify(repairPayload, null, 2)}\n\n` +
    "Return only the fields you corrected.";

  let raw;
  try {
    raw = await callAIImpl(
      env,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      { maxTokens: 4000, timeoutMs: 50_000 },
    );
  } catch (err) {
    console.warn(`repairGroundingContradictions: AI call failed (${err.message}) — keeping original`);
    return content;
  }

  const cleaned = String(raw || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    console.warn("repairGroundingContradictions: no JSON in response — keeping original");
    return content;
  }
  let fixes;
  try {
    fixes = JSON.parse(match[0]);
  } catch {
    console.warn("repairGroundingContradictions: JSON parse error — keeping original");
    return content;
  }

  const updated = { ...content };
  let applied = 0;
  for (const field of GROUNDING_REPAIRABLE_STRING_FIELDS) {
    if (
      typeof fixes[field] === "string" &&
      fixes[field].trim() &&
      typeof content[field] === "string"
    ) {
      updated[field] = fixes[field].trim();
      applied += 1;
    }
  }
  for (const field of GROUNDING_REPAIRABLE_ARRAY_FIELDS) {
    const fix = fixes[field];
    const original = content[field];
    if (!Array.isArray(fix) || !Array.isArray(original) || fix.length !== original.length) continue;
    const shapeMatches = fix.every(
      (item, i) =>
        typeof item === typeof original[i] &&
        (typeof item !== "string" || item.trim().length > 0),
    );
    if (!shapeMatches) continue;
    updated[field] = fix;
    applied += 1;
  }
  return applied > 0 ? updated : content;
}

async function verifyFinalGroundingWithRepair(env, content, source, slug, deps = {}) {
  const verify = deps.verify || verifyFinalArticleGrounding;
  const repair = deps.repair || repairGroundingContradictions;

  const first = await verify(env, content, source);
  if (first.ok) return { ok: true, reasons: [], content };

  const contradictions = (first.reasons || []).filter(
    (reason) => !GROUNDING_VERIFIER_TRANSPORT_PATTERN.test(String(reason)),
  );
  if (contradictions.length === 0) return { ...first, content };

  console.warn(
    `Final grounding failed for ${slug}; attempting one source-bound repair pass: ${contradictions.join("; ").slice(0, 400)}`,
  );
  let repaired;
  try {
    repaired = await repair(env, content, contradictions, source);
  } catch (err) {
    console.warn(`Final-grounding repair pass failed for ${slug}: ${err.message}`);
    return { ...first, content };
  }
  if (!repaired || repaired === content) return { ...first, content };

  const second = await verify(env, repaired, source);
  if (second.ok) {
    console.log(`Final grounding repair succeeded for ${slug}.`);
    return { ok: true, reasons: [], content: repaired };
  }
  return { ...second, content };
}

async function markGroundingBlockedEvent(env, slug, content, reasons) {
  try {
    await env.BLOG_AI_KV.put(
      `${KV_BLOCKED_EVENT_PREFIX}${slug}`,
      JSON.stringify({
        pageTitle: content?.sourcePageTitle || "",
        eventTitle: content?.eventTitle || "",
        reasons: (Array.isArray(reasons) ? reasons : []).slice(0, 5),
        ts: new Date().toISOString(),
      }),
      { expirationTtl: 3 * 86_400 },
    );
    await env.BLOG_AI_KV.delete(`${KV_DRAFT_PREFIX}${slug}`);
    await env.BLOG_AI_KV.delete(`${KV_DRAFT_SOURCE_PREFIX}${slug}`);
    console.warn(
      `Grounding self-heal: blocked event "${content?.sourcePageTitle || content?.eventTitle}" for ${slug} and deleted the draft/source package so regeneration picks a different topic.`,
    );
  } catch (err) {
    console.warn(`Grounding self-heal marking failed for ${slug}: ${err.message}`);
  }
}

async function factCheckContent(env, content, source = null) {
  const sourceBlock =
    source && (source.sourceExtract || source.text)
      ? `AUTHORITATIVE SOURCE (verify against this, not only your memory):\n"""\n${String(source.sourceExtract || source.text).slice(0, 1200)}\n"""\n\n`
      : "";
  const prompt =
    `You are a strict historical fact-checker. Given the article data below, identify any clear factual errors.\n` +
    `Focus ONLY on: whether the event date/year matches the event name, and whether the location is correct.\n` +
    `Do NOT invent errors. Only flag what you are confident is wrong based on well-established historical fact${source ? " and the AUTHORITATIVE SOURCE above" : ""}.\n\n` +
    sourceBlock +
    `Event: ${content.eventTitle}\n` +
    `Historical date: ${content.historicalDate}\n` +
    `Year: ${content.historicalYear}\n` +
    `Location: ${content.location}\n` +
    `ISO date: ${content.historicalDateISO}\n\n` +
    `Reply with ONLY a JSON object — nothing else:\n` +
    `{ "passed": true }\n` +
    `OR\n` +
    `{ "passed": false, "corrections": { "historicalDate": "corrected", "historicalYear": 1234, "historicalDateISO": "YYYY-MM-DD", "location": "corrected" } }\n` +
    `Include in corrections ONLY fields you are certain are wrong. Omit any field you are uncertain about.`;

  try {
    const raw = await callAI(
      env,
      [
        {
          role: "system",
          content:
            "You are a historical fact-checker. Reply with JSON only, no markdown.",
        },
        { role: "user", content: prompt },
      ],
      { maxTokens: 256, timeoutMs: 15_000 },
    );

    const match = raw?.match(/\{[\s\S]*\}/);
    if (!match) return;

    const result = JSON.parse(match[0]);
    if (result.passed === false && result.corrections) {
      const cor = result.corrections;

      const before = {
        historicalDate: content.historicalDate,
        historicalYear: content.historicalYear,
        historicalDateISO: content.historicalDateISO,
        location: content.location,
      };

      if (cor.historicalDate) content.historicalDate = cor.historicalDate;
      if (typeof cor.historicalYear === "number")
        content.historicalYear = cor.historicalYear;
      if (cor.historicalDateISO)
        content.historicalDateISO = cor.historicalDateISO;
      if (cor.location) content.location = cor.location;

      console.log(
        `factCheck: corrections applied — before: ${JSON.stringify(before)} after: ${JSON.stringify(cor)}`,
      );
    } else {
      console.log("factCheck: passed");
    }
  } catch (err) {
    console.warn(`factCheck: skipped — ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Pillar classification — assigns article to one or more content pillars
// ---------------------------------------------------------------------------

function normalizePillarsForContent(pillars, content) {
  const haystack = normalizeTopicMatchText(
    [
      content?.title,
      content?.eventTitle,
      content?.keywords,
      content?.description,
      content?.contentRationale,
      ...(Array.isArray(content?.keyTerms) ? content.keyTerms.map((term) => term?.term || "") : []),
    ].join(" "),
  );
  const isSports = /\b(sport|sports|athlete|athletics|football|soccer|basketball|baseball|tennis|golf|boxing|wrestling|cricket|rugby|hockey|olympic|paralympic|champion|championship|tournament|match|race|racing driver|motorsport|motor racing|formula|formula one|formula 1|grand prix|w series|indy|indy nxt|nascar|karting)\b/i.test(haystack);
  let next = Array.isArray(pillars) ? pillars.filter((pillar) => BLOG_PILLARS.includes(pillar)) : [];
  if (isSports) {
    next = next.filter((pillar) => pillar !== "Arts & Culture");
    next.unshift("Sports");
  }
  return [...new Set(next)].slice(0, 3);
}

function classifyPillarsDeterministically(content) {
  const haystack = normalizeTopicMatchText(
    [
      content?.title,
      content?.eventTitle,
      content?.keywords,
      content?.description,
      content?.contentRationale,
      ...(Array.isArray(content?.keyTerms)
        ? content.keyTerms.map((term) => term?.term || "")
        : []),
    ].join(" "),
  );
  const rules = [
    ["Disasters & Accidents", /\b(?:accident|arson|attack|avalanche|crash|disaster|earthquake|explosion|fire|flood|hurricane|shipwreck|storm|tsunami)\b/i],
    ["Arts & Culture", /\b(?:anime|animation|art|artist|book|cinema|culture|film|literature|music|studio|theatre)\b/i],
    ["Science & Technology", /\b(?:computer|discovery|engineer|invention|laboratory|science|scientist|space|technology)\b/i],
    ["Politics & Government", /\b(?:congress|government|king|parliament|president|prime minister|senate)\b/i],
    ["War & Conflict", /\b(?:army|battle|bombing|invasion|military|siege|war)\b/i],
    ["Social & Human Rights", /\b(?:civil rights|human rights|protest|racial|slavery|suffrage)\b/i],
    ["Economy & Business", /\b(?:bank|business|company|economy|finance|market|trade)\b/i],
    ["Health & Medicine", /\b(?:disease|doctor|health|hospital|medicine|pandemic|vaccine)\b/i],
    ["Exploration & Discovery", /\b(?:expedition|exploration|explorer|voyage)\b/i],
  ];
  const matches = rules
    .filter(([, pattern]) => pattern.test(haystack))
    .map(([pillar]) => pillar);
  return normalizePillarsForContent(matches, content);
}

/**
 * Classifies an article into 1–3 of the BLOG_PILLARS categories.
 * Returns an array of pillar name strings, or null if classification fails.
 * Multiple pillars are valid — e.g. an assassination article can be both
 * "War & Conflict" and "Politics & Government".
 */
async function classifyPillars(env, content) {
  const pillarsStr = BLOG_PILLARS.map((p, i) => `${i + 1}. ${p}`).join("\n");
  const prompt =
    `You are a content classifier. Assign the following historical article to 1–3 of the categories below.\n\n` +
    `Categories:\n${pillarsStr}\n\n` +
    `Article title: ${content.title}\n` +
    `Event: ${content.eventTitle}\n` +
    `Keywords: ${content.keywords}\n` +
    `Description: ${content.description}\n\n` +
    `Rules:\n` +
    `- Assign 1 category if the article clearly belongs to one topic.\n` +
    `- Assign 2–3 only when genuinely relevant (e.g. an assassination fits both "War & Conflict" and "Politics & Government").\n` +
    `- Do NOT pad with loosely related categories.\n` +
    `- Use "Born on This Day" only if the article's primary focus is a person's birth.\n` +
    `- Use "Died on This Day" only if the article's primary focus is a person's death.\n` +
    `- Use "Famous Persons" for general biographical articles not specifically about birth or death.\n` +
    `- Use "Sports" for athletes, motorsport, Formula racing, championships, records, matches, tournaments, or other competitive sport stories.\n` +
    `- Reply with ONLY a JSON object: { "pillars": ["exact category name", ...] }`;

  try {
    const raw = await callAI(
      env,
      [
        {
          role: "system",
          content: "You are a content classifier. Reply with JSON only.",
        },
        { role: "user", content: prompt },
      ],
      { maxTokens: 128, timeoutMs: 10_000 },
    );

    const match = raw?.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const result = JSON.parse(match[0]);
    const pillars = result?.pillars;
    if (!Array.isArray(pillars) || pillars.length === 0) return null;

    const valid = pillars.filter(
      (p) => typeof p === "string" && BLOG_PILLARS.includes(p),
    );
    if (valid.length === 0) {
      console.warn(
        `classifyPillars: no valid pillars in response ${JSON.stringify(pillars)}`,
      );
      const fallback = normalizePillarsForContent([], content);
      return fallback.length ? fallback : null;
    }
    const normalized = normalizePillarsForContent(valid, content);
    console.log(`classifyPillars: assigned [${normalized.join(", ")}]`);
    return normalized;
  } catch (err) {
    console.warn(`classifyPillars: skipped — ${err.message}`);
    const fallback = normalizePillarsForContent([], content);
    return fallback.length ? fallback : null;
  }
}

// ---------------------------------------------------------------------------
// Eyewitness quote validation — clears unverifiable quotes before publish
// ---------------------------------------------------------------------------

/**
 * Asks the AI to confirm whether eyewitnessQuote can be traced to a real,
 * documented source. If the quote cannot be verified, clears both
 * eyewitnessQuote and eyewitnessQuoteSource on the content object so the
 * quote block is omitted from the rendered HTML.
 *
 * This prevents fabricated or hallucinated quotes from being published
 * under real historical names — the highest trust-destruction risk in the
 * generation pipeline.
 */
async function validateEyewitnessQuote(env, content) {
  if (!content.eyewitnessQuote || !content.eyewitnessQuoteSource) return;

  const prompt =
    `You are a strict historical source verifier. Your only job is to assess whether the following quote can be traced to a real, documented historical source.\n\n` +
    `Quote: "${content.eyewitnessQuote}"\n` +
    `Attributed to: ${content.eyewitnessQuoteSource}\n` +
    `Event context: ${content.eventTitle} (${content.historicalDate})\n\n` +
    `Answer only: can this specific quote be confirmed as appearing in a real, verifiable document (letter, diary, newspaper, official record, published memoir)?\n` +
    `Do NOT verify paraphrases as if they were direct quotes.\n` +
    `Do NOT confirm a quote just because the person existed and the event happened.\n\n` +
    `Reply with ONLY a JSON object:\n` +
    `{ "verified": true, "source": "document name and year" }\n` +
    `OR\n` +
    `{ "verified": false, "reason": "brief explanation" }`;

  try {
    const raw = await callAI(
      env,
      [
        {
          role: "system",
          content:
            "You are a historical source verifier. Reply with JSON only, no markdown.",
        },
        { role: "user", content: prompt },
      ],
      { maxTokens: 256, timeoutMs: 15_000 },
    );

    const match = raw?.match(/\{[\s\S]*\}/);
    if (!match) {
      console.warn(
        "eyewitnessQuoteValidation: no JSON returned — quote cleared as precaution",
      );
      content.eyewitnessQuote = null;
      content.eyewitnessQuoteSource = null;
      return;
    }

    const result = JSON.parse(match[0]);
    if (result.verified === true) {
      console.log(
        `eyewitnessQuoteValidation: verified — ${result.source || "source confirmed"}`,
      );
    } else {
      console.warn(
        `eyewitnessQuoteValidation: unverified — ${result.reason || "unknown reason"} — quote cleared`,
      );
      content.eyewitnessQuote = null;
      content.eyewitnessQuoteSource = null;
    }
  } catch (err) {
    // On error, clear the quote as a safety measure rather than publish unverified
    console.warn(
      `eyewitnessQuoteValidation: skipped (error) — ${err.message} — quote cleared`,
    );
    content.eyewitnessQuote = null;
    content.eyewitnessQuoteSource = null;
  }
}

// ---------------------------------------------------------------------------
// SEO meta patcher — updates meta tags in existing KV HTML without regenerating
// ---------------------------------------------------------------------------

/**
 * Extracts current SEO meta values from stored HTML, calls AI to improve only
 * description / ogDescription / twitterDescription / keywords,
 * then does targeted string replacements on the HTML.
 * Returns { updatedHtml, changed: string[], newDescription: string|null }.
 */
async function patchSEOMeta(html, _slug, env) {
  const getMeta = (re) => (html.match(re) || [])[1] || "";

  const currentTitle = getMeta(/<title>([^<]+?)(?: \| thisDay\.)?<\/title>/);
  const currentDesc = getMeta(
    /<meta name="description" content="([^"]*?)"\s*\/>/,
  );
  const currentOgDesc = getMeta(
    /<meta property="og:description" content="([^"]*?)"\s*\/>/,
  );
  const currentTwitterDesc = getMeta(
    /<meta name="twitter:description" content="([^"]*?)"\s*\/>/,
  );
  const currentKeywords = getMeta(
    /<meta name="keywords" content="([^"]*?)"\s*\/>/,
  );
  // Pull event context from first JSON-LD block
  let eventName = "",
    eventDate = "",
    eventLocation = "";
  const jldMatch = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
  );
  if (jldMatch) {
    try {
      const jld = JSON.parse(jldMatch[1]);
      eventName = jld.about?.name || jld.headline || "";
      eventDate = jld.about?.startDate || "";
      eventLocation = jld.about?.location?.name || "";
    } catch {
      /* ignore */
    }
  }

  const minContent = {
    title: currentTitle,
    eventTitle: eventName,
    historicalDate: eventDate,
    location: eventLocation,
    description: currentDesc,
    ogDescription: currentOgDesc,
    twitterDescription: currentTwitterDesc,
    keywords: currentKeywords,
  };

  const improved = await reviewSEOMetaOnly(minContent, env);

  // Enforce hard length caps regardless of what the AI returned.
  if (improved.description)
    improved.description = truncateForMeta(improved.description, 155);
  if (improved.ogDescription)
    improved.ogDescription = truncateForMeta(improved.ogDescription, 130);
  if (improved.twitterDescription)
    improved.twitterDescription = truncateForMeta(improved.twitterDescription, 120);

  let updatedHtml = html;
  const changed = [];

  const patch = (oldVal, newVal, pattern, replacement) => {
    if (newVal && newVal !== oldVal) {
      updatedHtml = updatedHtml.replace(pattern, replacement);
      changed.push(pattern.source?.split("content")[0]?.trim() || "field");
    }
  };

  patch(
    currentDesc,
    improved.description,
    /<meta name="description" content="[^"]*?"\s*\/>/,
    `<meta name="description" content="${esc(improved.description)}" />`,
  );

  patch(
    currentOgDesc,
    improved.ogDescription,
    /<meta property="og:description" content="[^"]*?"\s*\/>/,
    `<meta property="og:description" content="${esc(improved.ogDescription)}" />`,
  );

  patch(
    currentTwitterDesc,
    improved.twitterDescription,
    /<meta name="twitter:description" content="[^"]*?"\s*\/>/,
    `<meta name="twitter:description" content="${esc(improved.twitterDescription)}" />`,
  );

  // keywords + article:tag block
  if (improved.keywords && improved.keywords !== currentKeywords) {
    updatedHtml = updatedHtml.replace(
      /<meta name="keywords" content="[^"]*?"\s*\/>/,
      `<meta name="keywords" content="${esc(improved.keywords)}" />`,
    );
    // Replace all article:tag lines with freshly generated ones
    const newTags = improved.keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
      .slice(0, 6)
      .map((k) => `<meta property="article:tag" content="${esc(k)}" />`)
      .join("\n    ");
    updatedHtml = updatedHtml.replace(
      /(<meta property="article:tag" content="[^"]*?"\s*\/>\n?\s*)+/,
      newTags + "\n    ",
    );
    changed.push("keywords");
  }

  return {
    updatedHtml,
    changed,
    newDescription:
      improved.description !== currentDesc ? improved.description : null,
  };
}

/** Reverse of esc() — decode HTML entities back to plain text. */
function unesc(str) {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Humanizes a single section's paragraphs to beat AI detection.
 * Focused JOB 3 only — one section at a time to stay within token limits.
 * Returns the rewritten array, or the original on any failure.
 */
async function humanizeSection(
  paragraphs,
  sectionName,
  eventTitle,
  env,
  usedOpeners = [],
) {
  if (!paragraphs.length) return paragraphs;

  let systemPrompt =
    "You are a senior writer for serious history documentaries — think BBC, PBS, Ken Burns. " +
    "Your draft is then reviewed by two specialists. Apply all three perspectives before output.\n" +
    "Write like you are explaining it to a smart 16 year old who has never heard of this topic.\n\n" +
    "LEAD WRITER — BBC/PBS DOCUMENTARY VOICE:\n" +
    "Authoritative narrator. Weighty subject, weighty prose. " +
    "Never open a paragraph with 'On [date],' or '[Place] was...' — start with the person, action, or consequence.\n\n" +
    "REVIEWER 1 — LINGUISTICS PROFESSOR (syntactic humanization):\n" +
    "These techniques make text pass AI detectors at the sentence level. Apply them with restraint — " +
    "overusing any single technique creates gibberish. Vary across sentences.\n" +
    "- RELATIVE CLAUSES: at most 2 per sentence, and each must logically follow the previous. " +
    "'Jinnah read a statement, which became known as the Pakistan Resolution.' — two clauses, coherent. " +
    "Never chain 4+ clauses into a run-on. Each sentence must still make sense on its own.\n" +
    "- SWAP FORMAL VERBS for simpler colloquial ones: 'presented' → 'read', 'advocated' → 'fought for', " +
    "'electrified' → 'moved', 'deemed' → 'considered to be', 'recalled' → 'remembered'\n" +
    "- BREAK NOMINALIZATIONS: 'a carefully crafted document reflecting years of struggle' → " +
    "'a product of years of struggle'\n" +
    "- PARTICIPIAL OPENERS: 'being the leader of' instead of 'as the leader of'\n" +
    "- CLOSE SENTENCES with short participial phrases: '...which was hard to miss, given the circumstances'\n" +
    "- USE 'and' sparingly as a mid-flow connector: 'and this had consequences', 'and they knew it'\n" +
    "- SHIFT TO PRONOUNS once established: 'Jinnah's words' → 'his words'\n" +
    "- ADVERB INTENSIFIERS used lightly: 'quite vehemently', 'rather quickly', 'fairly certain'\n" +
    "- Avoid semicolons; prefer commas or rewrite\n" +
    "- NEVER start two paragraphs in the same section with the same subject or the same grammatical pattern\n" +
    "- Remove AI connectors: 'Furthermore', 'Moreover', 'Additionally', 'In conclusion', " +
    "'It is worth noting', 'Notably', 'Importantly', 'Significantly'\n\n" +
    "REVIEWER 2 — COGNITIVE PSYCHOLOGIST (reasoning and voice texture):\n" +
    "- SELF-AFFIRMING VALIDATION: 'And that is exactly what it was' — humans confirm their own points, AI never does\n" +
    "- VAGUE TEMPORAL MARKERS: 'for quite some time', 'over the years', 'for a while' — AI uses precise dates\n" +
    "- EPISTEMIC HEDGES: 'It seemed that', 'It appeared that', 'apparently' — AI states facts directly\n" +
    "- REFLEXIVE PRONOUNS for emphasis: 'Jinnah himself remembered', 'they themselves had little choice'\n" +
    "- VAGUE QUANTIFIERS: 'many to wonder', 'few anticipated', 'almost instantly', 'finally realized'\n" +
    "- Leave some tension unresolved: 'Whether this was miscalculation or strategy is still debated.'\n" +
    "- One measured judgment per section, not per paragraph: 'The British response was, at best, halfhearted.'\n" +
    "- Use each rhetorical device ONCE across the whole section — vary: understatement, question, implication\n" +
    "- Replace hollow phrases with actual consequences: never 'cannot be overstated', 'pivotal moment', " +
    "'shaped the course of', 'left a lasting impact', 'significant event', 'changed history', " +
    "'shows the importance of', 'reminder of', 'throughout history'\n\n" +
    "SHARED RULES:\n" +
    "- Return ONLY a JSON array with exactly the same number of strings as the input\n" +
    "- Preserve every fact. Do not invent, merge, or split paragraphs.\n" +
    "- No casual fillers: 'So,', 'Done.', 'It's crazy, really.', 'Nobody expected that.'\n" +
    "- Do NOT use phrases like 'surprised no one', 'surprising to no one', or similar.\n" +
    "- Do NOT write summary mood judgments: 'it was a dark time', 'it was chaos', 'it was a bleak time', 'dark chapter'. Replace them with the concrete observable detail that makes the mood real.\n" +
    "- If a paragraph describes only what something looked like, add one non-visual sensory detail (sound, smell, physical sensation) where it fits naturally.";

  // Explicit punctuation guidance: prefer commas over hyphens inside sentences
  systemPrompt +=
    "\n\nPUNCTUATION NOTE: Never use hyphens (-) or em dashes (—) anywhere in the text. Zero dashes. Use a comma or split into two sentences.";

  // Append concise essay-writing guidance from Oxford's "Tips from my first year - essay writing".
  // Keep all previous humanization rules intact; add planning/PEE/evidence-first reminders.
  systemPrompt +=
    "\n\nOXFORD ESSAY GUIDANCE (append):\n" +
    "- Before rewriting, sketch a brief plan: claim, evidence, explanation.\n" +
    "- Follow PEE at the paragraph level: state the claim, present one strongest piece of evidence, then explain why it matters.\n" +
    "- Lead paragraphs with the clearest fact when possible (evidence-first).\n" +
    "- Keep introductions and conclusions concise; define any technical term once and briefly.\n" +
    "- When combining or trimming paragraphs, preserve the claim+evidence then the nuance/synthesis.\n" +
    "- When a paragraph contains nuance or complication, give the strongest version of it, not the weakest. Write it naturally into the flow — never signal it with 'critics argue' or 'some would say'. Just state it as fact.\n" +
    "- Each paragraph can work as: position, complication woven in, then synthesis.\n" +
    "- Apply a 'why' test to every statement: if you cannot answer 'why does this matter?', cut or sharpen the sentence.";

  const avoidLine = usedOpeners.length
    ? `\nDo NOT start any paragraph with these already-used openers: ${usedOpeners.map((s) => `"${s}"`).join(", ")}\n`
    : "";

  const userMessage =
    `Event: ${eventTitle}\nSection: ${sectionName}\n${avoidLine}\n` +
    `Rewrite these ${paragraphs.length} paragraphs to beat AI detection:\n` +
    `${JSON.stringify(paragraphs, null, 2)}\n\n` +
    `Return ONLY a JSON array of ${paragraphs.length} strings.`;

  let raw;
  try {
    raw = await callAI(
      env,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      { maxTokens: 2500, timeoutMs: 45_000, temperature: 0.75 },
    );
  } catch (err) {
    console.warn(
      `humanizeSection [${sectionName}]: AI call failed — ${err.message}`,
    );
    return paragraphs;
  }

  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!arrMatch) {
    console.warn(`humanizeSection [${sectionName}]: no JSON array in response`);
    return paragraphs;
  }

  let result;
  try {
    result = JSON.parse(arrMatch[0]);
  } catch {
    console.warn(`humanizeSection [${sectionName}]: JSON parse error`);
    return paragraphs;
  }

  if (!Array.isArray(result) || result.length !== paragraphs.length) {
    console.warn(
      `humanizeSection [${sectionName}]: array length mismatch (got ${result?.length}, expected ${paragraphs.length})`,
    );
    return paragraphs;
  }

  if (!result.every((p) => typeof p === "string" && p.trim().length > 20)) {
    console.warn(
      `humanizeSection [${sectionName}]: invalid paragraph strings in response`,
    );
    return paragraphs;
  }

  return result;
}

/**
 * Extracts body paragraphs from stored HTML, humanizes each section with a focused
 * per-section AI call (JOB 3 — AI detection reduction), then patches the <p> tags
 * back in place. Returns { updatedHtml, changed: string[] }.
 */
async function patchBodyParagraphs(html, env) {
  // Extract eventTitle from h1 ("Event Name — Month Day, Year") — works for both
  // old posts (h2: "Overview: EventTitle") and new posts (h2: "Overview").
  let eventTitle = "";
  const h1Match = html.match(/<h1[^>]*>([^<]+?) —/);
  if (h1Match) eventTitle = unesc(h1Match[1].trim());

  // Fallback: extract from JSON-LD about.name
  if (!eventTitle) {
    const jldMatch = html.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
    );
    if (jldMatch) {
      try {
        const jld = JSON.parse(jldMatch[1]);
        eventTitle = jld.about?.name || jld.headline?.split(" — ")[0] || "";
      } catch {
        /* ignore */
      }
    }
  }

  // Extract <p> text from a named section (by its exact <h2> text)
  const extractSectionParas = (h2Text) => {
    const escaped = h2Text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      '<h2 class="h3">' +
        escaped +
        "<\\/h2>([\\s\\S]*?)(?:<\\/section>|<blockquote)",
    );
    const match = html.match(re);
    if (!match) return [];
    return [...match[1].matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) =>
      unesc(m[1]),
    );
  };

  const normalizeParas = (paras) => {
    if (paras.length <= 2) return paras;
    const mid = Math.ceil(paras.length / 2);
    const first = paras.slice(0, mid).join(" ");
    const second = paras.slice(mid).join(" ");
    return [first, second];
  };

  // Each section tries the new short h2 first, then the old "Verb of EventTitle" form
  // so humanization still works on posts stored before the h2 change.
  const sections = [
    {
      name: "overviewParagraphs",
      h2: "Overview",
      h2Legacy: `Overview: ${eventTitle}`,
    },
    {
      name: "eyewitnessOrChronicle",
      h2: "Eyewitness Accounts",
      h2Legacy: `Eyewitness Accounts of ${eventTitle}`,
    },
    {
      name: "aftermathParagraphs",
      h2: "Aftermath",
      h2Legacy: `Aftermath of ${eventTitle}`,
    },
    {
      name: "conclusionParagraphs",
      h2: "Legacy",
      h2Legacy: `Legacy of ${eventTitle}`,
    },
  ].map((s) => {
    const paras = normalizeParas(extractSectionParas(s.h2));
    return {
      ...s,
      paras: paras.length
        ? paras
        : normalizeParas(extractSectionParas(s.h2Legacy)),
    };
  });

  if (!sections[0].paras.length) {
    console.warn(
      `patchBodyParagraphs: no overview paragraphs found (eventTitle="${eventTitle}") — skipping`,
    );
    return { updatedHtml: html, changed: [] };
  }

  // Humanize each section sequentially — one focused AI call per section
  // Track first-word openers of each paragraph so later sections don't repeat them
  let updatedHtml = html;
  const changed = [];
  const usedOpeners = [];

  for (const section of sections) {
    if (!section.paras.length) continue;

    const humanized = await humanizeSection(
      section.paras,
      section.name,
      eventTitle,
      env,
      usedOpeners,
    );

    // Collect the first ~6 words of each humanized paragraph as an opener
    for (const p of humanized) {
      const opener = p.split(/\s+/).slice(0, 6).join(" ");
      if (opener) usedOpeners.push(opener);
    }

    const oldBlock = section.paras
      .map((p) => `            <p>${esc(p)}</p>`)
      .join("\n");
    const newBlock = humanized
      .map((p) => `            <p>${esc(p)}</p>`)
      .join("\n");

    if (oldBlock === newBlock) {
      console.log(`patchBodyParagraphs [${section.name}]: unchanged`);
      continue;
    }
    if (!updatedHtml.includes(oldBlock)) {
      console.warn(
        `patchBodyParagraphs [${section.name}]: block not found in HTML — skipping`,
      );
      continue;
    }
    updatedHtml = updatedHtml.replace(oldBlock, newBlock);
    changed.push(section.name);
  }

  console.log(
    `patchBodyParagraphs: ${changed.length} section(s) humanized — ${changed.join(", ") || "none"}`,
  );
  return { updatedHtml, changed };
}

/**
 * Focused SEO-only AI call — improves only the 4 text meta fields.
 * No paragraph rewriting. Falls back to original on any error.
 */
async function reviewSEOMetaOnly(content, env) {
  if (!hasAnyTextAIProvider(env)) return content;

  const systemPrompt =
    "You are a senior SEO editor. Improve only these 4 fields for a historical blog post:\n" +
    "- description: 120–155 chars, open with a specific, curiosity-driven hook (a striking number, named figure, or consequence) — do NOT start with a bare year; weave the year and location in naturally; end on a complete clause, never a dangling preposition or mid-phrase '...'\n" +
    "- ogDescription: 100–130 chars, curiosity-driven, makes people click\n" +
    "- twitterDescription: 90–120 chars, punchy, present-tense energy\n" +
    "- keywords: 5–8 comma-separated, specific — year, location, person names, historical context\n\n" +
    "Rules: output ONLY valid JSON with the fields that need improvement. Omit unchanged fields. " +
    "Never use generic filler such as 'dramatic and unexpected', 'remarkable event', 'turning point', 'important moment', or 'history of [country]'. " +
    "Do not change title, content, or any other field.";

  const userMessage =
    `Title: ${content.title}\n` +
    `Event: ${content.eventTitle} on ${content.historicalDate} in ${content.location || "unknown"}\n` +
    `description: ${content.description}\n` +
    `ogDescription: ${content.ogDescription || ""}\n` +
    `twitterDescription: ${content.twitterDescription || ""}\n` +
    `keywords: ${content.keywords || ""}\n\n` +
    `Return ONLY JSON with improved fields, e.g. {"description":"...","keywords":"..."}`;

  let raw;
  try {
    raw = await callAI(
      env,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      { maxTokens: 800, timeoutMs: 25_000 },
    );
  } catch (err) {
    console.warn(
      `SEO meta patcher [${content.title}]: AI call failed — ${err.message}`,
    );
    return content;
  }

  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return content;

  let improvements;
  try {
    improvements = JSON.parse(match[0]);
  } catch {
    return content;
  }

  const ALLOWED = [
    "description",
    "ogDescription",
    "twitterDescription",
    "keywords",
  ];
  const improved = { ...content };
  for (const f of ALLOWED) {
    if (
      typeof improvements[f] === "string" &&
      improvements[f].trim().length > 5
    ) {
      improved[f] = improvements[f];
    }
  }
  return improved;
}

// ---------------------------------------------------------------------------
// SEO expert content review
// ---------------------------------------------------------------------------

/**
 * Reviews and improves generated blog post content for SEO quality before publishing.
 *
 * Checks and fixes:
 *   - Meta description length and keyword richness (120–155 chars)
 *   - OG / Twitter description quality
 *   - keywords relevance and specificity
 *   - Sentence length across all paragraph arrays (flags if avg > 20 words)
 *   - Content clarity, active voice, and readability signals
 *   - Title format and keyword alignment
 *
 * Returns the improved content object. Falls back to original on any error.
 */
async function reviewContentWithSEOExpert(content, env, source = null) {
  if (!hasAnyTextAIProvider(env)) return content;
  const sourceMaterial = sourceBoundRepairContext(source, 6000);

  // --- PASS 1: Paragraph quality + humanization (no meta fields) ---
  const allParagraphs = {
    overviewParagraphs: content.overviewParagraphs || [],
    eyewitnessOrChronicle: content.eyewitnessOrChronicle || [],
    aftermathParagraphs: content.aftermathParagraphs || [],
    conclusionParagraphs: content.conclusionParagraphs || [],
  };

  const paraSystemPrompt =
    "You are a passionate, opinionated history writer and human-voice editor. " +
    "You receive paragraph arrays for a historical blog post. Your two jobs:\n\n" +
    "JOB 1 — CONTENT QUALITY:\n" +
    "Rewrite any paragraph that fails these standards:\n" +
    "- Contains no specific names, numbers, dates, or places\n" +
    "- Uses banned phrases: 'significant event', 'pivotal moment', 'changed history', 'shaped the course of', " +
    "'left a lasting impact', 'cannot be overstated', 'shows the importance of', 'reminder of', " +
    "'it was a dark time', 'it was a bleak time', 'it was a difficult period', 'dark chapter', " +
    "'that's the thing', 'it's a shame', 'still resonates today', 'testament to', 'played a crucial role', " +
    "'had a profound impact', 'turning point', 'watershed moment', 'throughout history', " +
    "'dive into', 'delve into', 'unleash', 'game-changing', 'in today's fast-paced world', 'it's worth noting'\n" +
    "- Makes a mood judgment without observable evidence ('it was brutal' with no detail of what the brutality was)\n" +
    "- Restates a point already made in a previous paragraph\n" +
    "When rewriting: add the specific fact being avoided, replace mood labels with concrete observable detail, " +
    "open with a striking fact or consequence. Preserve paragraph count exactly.\n\n" +
    "JOB 2 — HUMAN VOICE (model: a curious, guiding narrator, not an AI assistant):\n" +
    "- Default to long, winding sentences built from stacked clauses and parentheticals joined by commas. Drop in a short declarative only to mark a turn or land a point. Never write a run of clipped declaratives.\n" +
    "- A guiding first-person-plural narrator is welcome: 'we have come to call', 'what we really wonder about', 'what catches our eye'. Never address the reader as 'you'.\n" +
    "- Hedge where the evidence is genuinely uncertain: 'may well', 'would have', 'could have been', 'seems', 'appears', 'is generally assumed', 'has been suggested'. When scholars disagree, name who argues what instead of flattening it into one tidy consensus.\n" +
    "- Use contractions where they fit ('didn't', 'wasn't', 'it's').\n" +
    "- Open sentences different ways: a fronted prepositional or subordinate clause, a consequence, occasionally a sentence-initial 'And', 'But', 'Yet', or 'Except that'. Do not march three sentences from the same subject or pattern.\n" +
    "- Replace AI connectors ('Furthermore', 'Moreover', 'Additionally', 'In conclusion', 'Notably', 'Significantly') with conversational ones ('And yet', 'In other words', 'That is to say', 'After all', 'Even so', 'What matters is').\n" +
    "- Vary paragraph length too. An occasional one-sentence paragraph can carry a turn in the argument.\n" +
    "- Clarity first. Every sentence must land on first read. Prefer plain words and concrete verbs; reach for a complex word only when the idea itself is complex.\n" +
    "- Cut words that don't earn their place. An adjective or adverb must add information, not enthusiasm. Strip filler frames ('It's important to note that the treaty failed' becomes 'The treaty failed') and say each idea once, well.\n" +
    "- Quality beats length. Keep the article above the real-article floor, but never add padding or repeat a source fact just to sound substantial. If a paragraph repeats an earlier detail, replace it with a new source-supported consequence, limitation, action, or uncertainty.\n" +
    "- No marketing hype, buzzwords, or forced warmth. Honest and specific beats impressive-sounding: write what the evidence supports, plainly.\n" +
    "- Prefer active voice. Use passive only when the actor is genuinely unknown or beside the point.\n" +
    "PROHIBITIONS: No rhetorical questions to the reader. No 'Picture this', 'So,', 'You have to understand'. " +
    "No sentence fragments as decoration. No chatty filler: 'That's the thing', 'It's a shame, really', 'He saw it all'.\n" +
    "DISCIPLINE: Meaning is invariant. A trim that changes what a sentence claims is a bug, so keep the fact. " +
    "And never flatten a quirky, specific sentence into smooth generic prose. These rules serve the voice, they do not replace it.\n\n" +
    SOURCE_BOUND_REPAIR_RULES + "\n" +
    WRITING_REWRITE_RULES + "\n" +
    "PUNCTUATION: Use only periods, commas, and question marks. Never use em dashes (—), en dashes (–), semicolons (;), colons (:), or a hyphen between words (write 'best known', not 'best-known'). Convert any such break to a period or comma with correct grammar.\n\n" +
    "Return ONLY a JSON object with the paragraph arrays that needed improvement. " +
    "Omit arrays that are already good. Preserve array lengths exactly.\n" +
    "Example: {\"overviewParagraphs\":[\"para1\",\"para2\"]}";

  const paraUserMessage =
    (sourceMaterial ? `AUTHORITATIVE SOURCE MATERIAL:\n${sourceMaterial}\n\n` : "") +
    `Event: ${content.eventTitle} on ${content.historicalDate}\n\n` +
    `${JSON.stringify(allParagraphs, null, 2)}\n\n` +
    `Return ONLY JSON with improved paragraph arrays.`;

  let paraRaw;
  try {
    paraRaw = await callAI(
      env,
      [
        { role: "system", content: paraSystemPrompt },
        { role: "user", content: paraUserMessage },
      ],
      { maxTokens: 4000, timeoutMs: 50_000 },
    );
  } catch (err) {
    console.warn(`Paragraph expert: AI call failed (${err.message}) — skipping pass`);
    paraRaw = null;
  }

  if (paraRaw) {
    const paraCleaned = paraRaw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const paraMatch = paraCleaned.match(/\{[\s\S]*\}/);
    if (paraMatch) {
      let paraImprovements;
      try { paraImprovements = JSON.parse(paraMatch[0]); } catch { paraImprovements = null; }
      if (paraImprovements) {
        const PARA_ALLOWED = ["overviewParagraphs", "eyewitnessOrChronicle", "aftermathParagraphs", "conclusionParagraphs"];
        for (const field of PARA_ALLOWED) {
          if (!Array.isArray(paraImprovements[field])) continue;
          if (paraImprovements[field].length !== (content[field] || []).length) continue;
          if (!paraImprovements[field].every((p) => typeof p === "string" && p.trim().length > 20)) continue;
          content = { ...content, [field]: paraImprovements[field] };
        }
        console.log("Paragraph expert: applied improvements");
      }
    }
  }

  // --- PASS 2: SEO meta fields only (no paragraphs) ---
  const seoSystemPrompt =
    "You are a senior SEO editor for a historical blog. Improve only these meta fields:\n" +
    "- curiosityTitle: 35–65 chars; a How/Why/What/Who/Which/Where question built around a surprising, relevant niche explicitly present in the supplied source; retain the recognizable event name; exactly one final question mark; no date suffix, generic 'What happened?', hype, or invented premise\n" +
    "- description: 120–155 chars, lead with a concrete hook (death toll, office, ship name, law, military result, or named figure) — do NOT start with a bare year; include location and weave the year in naturally; end on a complete clause, never a dangling preposition or mid-phrase '...'\n" +
    "- ogDescription: 100–130 chars, curiosity-driven, give readers a reason to click\n" +
    "- twitterDescription: 90–120 chars, punchy, present-tense energy\n" +
    "- keywords: 5–8 specific terms including year, location, key people, historical context\n\n" +
    SOURCE_BOUND_REPAIR_RULES +
    "Do not change title or eventTitle; they are locked factual/date labels. Return ONLY a JSON object with fields that need improvement. Omit fields that are already good.\n" +
    "Ban vague copy such as 'dramatic and unexpected', 'significant turning point', 'remarkable', 'important moment', 'in the history of', or 'changed everything' unless a concrete fact immediately follows. " +
    "Do not use lazy suffix headlines like 'Founding', 'Creation', 'Launch', 'Opening', 'Completion', or 'Presentation' unless the event text literally says that happened.";

  const seoUserMessage =
    (sourceMaterial ? `AUTHORITATIVE SOURCE MATERIAL:\n${sourceMaterial}\n\n` : "") +
    `Locked factual title: ${content.title}\n` +
    `Current public question title: ${content.curiosityTitle || ""}\n` +
    `Event: ${content.eventTitle} on ${content.historicalDate} in ${content.location || "unknown"}\n` +
    `description: ${content.description || ""}\n` +
    `ogDescription: ${content.ogDescription || ""}\n` +
    `twitterDescription: ${content.twitterDescription || ""}\n` +
    `keywords: ${content.keywords || ""}`;

  let seoRaw;
  try {
    seoRaw = await callAI(
      env,
      [
        { role: "system", content: seoSystemPrompt },
        { role: "user", content: seoUserMessage },
      ],
      { maxTokens: 600, timeoutMs: 20_000 },
    );
  } catch (err) {
    console.warn(`SEO expert: AI call failed (${err.message}) — skipping pass`);
    seoRaw = null;
  }

  // Parse SEO meta improvements from Pass 2
  if (!seoRaw) return content;
  const raw = seoRaw;

  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    console.warn("SEO expert: no JSON in response — using original content");
    return content;
  }

  let improvements;
  try {
    improvements = JSON.parse(match[0]);
  } catch {
    console.warn("SEO expert: JSON parse error — using original content");
    return content;
  }

  // SEO pass only touches meta fields — paragraphs were handled in Pass 1
  const ALLOWED_FIELDS = [
    "curiosityTitle",
    "description",
    "ogDescription",
    "twitterDescription",
    "keywords",
  ];

  let changed = 0;
  const improved = { ...content };
  for (const field of ALLOWED_FIELDS) {
    if (improvements[field] == null) continue;
    // Validate paragraph arrays: must stay the same length
    if (Array.isArray(improved[field])) {
      if (!Array.isArray(improvements[field])) continue;
      if (improvements[field].length !== improved[field].length) continue;
      if (
        !improvements[field].every(
          (p) => typeof p === "string" && p.trim().length > 20,
        )
      )
        continue;
    } else {
      if (
        typeof improvements[field] !== "string" ||
        improvements[field].trim().length < 5
      )
        continue;
    }
    improved[field] = improvements[field];
    changed++;
  }

  if (improved.curiosityTitle !== content.curiosityTitle) {
    const validation = validateCuriosityTitleForPublish(improved);
    if (!validation.ok) {
      improved.curiosityTitle = content.curiosityTitle;
    }
  }

  console.log(`SEO expert: reviewed content — ${changed} field(s) improved`);
  return improved;
}

// ---------------------------------------------------------------------------
// Person image injection — Wikipedia portraits near first mention per section
// ---------------------------------------------------------------------------

/**
 * Fetches Wikipedia thumbnails for all person-type keyTerms (up to 4).
 * Returns array of { name, imageUrl, wikiUrl }.
 */
async function fetchKeyPersonImages(env, keyTerms) {
  const people = (keyTerms || [])
    .filter((kt) => {
      const type = String(kt?.type || "").toLowerCase();
      return type === "person" && kt?.term && kt?.wikiUrl;
    })
    .slice(0, 4);

  // Sequential: KV cache first (fast), Wikipedia only on miss (1 fetch per person max)
  // Keeps total subrequest count predictable alongside the AI pipeline calls.
  const results = [];
  for (const kt of people) {
    try {
      const cacheKey = KV_PERSON_IMAGE_PREFIX + kt.term.toLowerCase().replace(/\s+/g, "_");
      const cached = await env.BLOG_AI_KV.get(cacheKey, { type: "json" }).catch(() => null);
      if (cached?.imageUrl) {
        results.push({ name: kt.term, imageUrl: cached.imageUrl, wikiUrl: kt.wikiUrl });
        continue;
      }
      // Cache miss — fetch from Wikipedia (steps 1+2 only, no Commons text search for persons).
      const imageUrl = await fetchWikipediaImage(kt.term, kt.wikiUrl, { skipCommonsSearch: true });
      if (!imageUrl) continue;
      void optionalBlogKvPut(
        env,
        cacheKey,
        JSON.stringify({ imageUrl }),
        { expirationTtl: KV_PERSON_IMAGE_TTL },
      );
      results.push({ name: kt.term, imageUrl, wikiUrl: kt.wikiUrl });
    } catch {
      // skip this person
    }
  }
  return results;
}

/**
 * Fetches an Open Library book cover URL for the given search query.
 * Returns a cover URL string or null.
 */
async function fetchBookCover(bookSearchQuery) {
  if (!bookSearchQuery) return null;
  try {
    const ua = { "User-Agent": "thisday.info-blog/1.0 (https://thisday.info)" };
    const searchRes = await fetch(
      `https://openlibrary.org/search.json?q=${encodeURIComponent(bookSearchQuery)}&mode=books&limit=3&fields=cover_i,title`,
      { headers: ua },
    );
    if (!searchRes.ok) return null;
    const data = await searchRes.json();
    const docs = data?.docs || [];
    for (const doc of docs) {
      if (doc.cover_i) {
        return `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function amazonSearchUrl(query) {
  const cleaned = String(query || "")
    .replace(/[^\p{L}\p{N}\s'".,:]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const safeQuery = cleaned || "history books";
  return `https://www.amazon.com/s?k=${encodeURIComponent(safeQuery)}&tag=${encodeURIComponent(AMAZON_ASSOCIATE_TAG)}`;
}

function buildAmazonRelatedData(c, currentPillars = []) {
  const topic = String(c.amazonBookTopic || c.bookSearchQuery || c.eventTitle || c.title || "")
    .replace(/^books?\s+(about|on)\s+/i, "")
    .replace(/\s+[-—]\s+.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!topic) return null;

  const eventText = `${c.eventTitle || ""} ${c.keywords || ""} ${(currentPillars || []).join(" ")}`.toLowerCase();
  const secondary =
    /art|artist|painting|culture|literature|music|theatre|film/.test(eventText)
      ? { label: "Art, prints, and visual references", query: `${topic} art prints books` }
      : /science|technology|space|medicine|discovery|invention/.test(eventText)
        ? { label: "Science and discovery books", query: `${topic} science history books` }
        : /person|born|died|king|queen|president|leader|scientist|writer|artist/.test(eventText)
          ? { label: "Biographies and memoirs", query: `${topic} biography book` }
          : { label: "Maps, posters, and reference material", query: `${topic} historical map poster` };

  const links = [
    { label: `Books about ${topic}`, query: `${topic} history book` },
    secondary,
    { label: "Documentaries and companion reading", query: `${topic} documentary book` },
  ];
  const aiIdeas = Array.isArray(c.amazonProductIdeas)
    ? c.amazonProductIdeas
        .map((item) => ({
          label: String(item?.label || "").trim(),
          query: String(item?.searchQuery || "").trim(),
          type: String(item?.type || "book").trim().toLowerCase(),
        }))
        .filter((item) => item.label && item.query)
        .slice(0, 6)
    : [];
  const sliderItems = (aiIdeas.length ? aiIdeas : links).map((item) => ({
    label: item.label,
    query: item.query,
    type: item.type || "book",
  }));
  const openLibraryQuery = String(c.bookSearchQuery || sliderItems[0]?.query || `${topic} history book`)
    .replace(/\s+/g, " ")
    .trim();
  const bookKeywords = [
    topic,
    c.eventTitle,
    c.keywords,
    ...(Array.isArray(c.keyTerms) ? c.keyTerms.map((term) => term?.term || "") : []),
  ]
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !["history", "world", "first", "second", "battle", "revolution", "founded", "founding"].includes(word))
    .slice(0, 14)
    .join(" ");

  return { topic, sliderItems, openLibraryQuery, bookKeywords };
}

function commercialRelevanceTokens(value) {
  return normalizeTopicMatchText(value)
    .split(/\s+/)
    .filter((token) =>
      token.length >= 3 &&
      !/^\d+$/.test(token) &&
      !COMMERCIAL_RELEVANCE_STOPWORDS.has(token),
    );
}

function articleCommercialTopicTokens(content) {
  const keyTerms = Array.isArray(content?.keyTerms)
    ? content.keyTerms.map((term) => term?.term || "")
    : [];
  const sourcePageTitles = Array.isArray(content?.sourcePages)
    ? content.sourcePages.map((page) => page?.pageTitle || "")
    : [];
  return new Set(commercialRelevanceTokens([
    content?.eventTitle,
    content?.sourceEventHeadline,
    content?.sourcePageTitle,
    content?.keywords,
    ...keyTerms,
    ...sourcePageTitles,
  ].filter(Boolean).join(" ")));
}

function openLibraryBookMatchesArticle(book, content) {
  if (!book?.title || !book?.coverUrl) return false;
  const articleTokens = articleCommercialTopicTokens(content);
  if (articleTokens.size === 0) return false;

  const titleAuthorTokens = new Set(commercialRelevanceTokens(
    `${book.title || ""} ${book.author || ""}`,
  ));
  const subjectTokens = new Set(commercialRelevanceTokens(
    Array.isArray(book.subjects) ? book.subjects.join(" ") : "",
  ));
  const primaryMatches = [...titleAuthorTokens].filter((token) =>
    articleTokens.has(token),
  );
  const subjectMatches = [...subjectTokens].filter((token) =>
    articleTokens.has(token),
  );
  const allMatches = new Set([...primaryMatches, ...subjectMatches]);

  return (
    primaryMatches.length >= 2 ||
    primaryMatches.some((token) => token.length >= 6) ||
    allMatches.size >= 2
  );
}

function relevantOpenLibraryBooks(content) {
  const seen = new Set();
  return (Array.isArray(content?.openLibraryBooks) ? content.openLibraryBooks : [])
    .filter((book) => openLibraryBookMatchesArticle(book, content))
    .filter((book) => {
      const key = normalizeTopicMatchText(`${book.title || ""} ${book.author || ""}`);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

function commercialRecommendationsAreRelevant(content) {
  return relevantOpenLibraryBooks(content).length >= MIN_RELEVANT_COMMERCIAL_BOOKS;
}

function buildOpenLibraryAmazonCards(books) {
  return (books || [])
    .filter((book) => book?.title && book?.coverUrl)
    .slice(0, 5)
    .map((book) => {
      const author = String(book.author || "").trim();
      const searchQuery = [book.title, author].filter(Boolean).join(" ");
      return `<a class="amazon-product-card" href="${esc(amazonSearchUrl(searchQuery))}" target="_blank" rel="sponsored noopener noreferrer">` +
        `<span class="amazon-card-cover"><img src="${esc(book.coverUrl)}" alt="${esc(book.title)} cover" loading="lazy"></span>` +
        `<strong>${esc(book.title)}</strong>` +
        (author ? `<small>${esc(author)}</small>` : `<small>View on Amazon</small>`) +
        `</a>`;
    })
    .join("");
}

function normalizeOpenLibraryBook(doc) {
  const title = String(doc?.title || "").trim();
  const author = Array.isArray(doc?.author_name)
    ? String(doc.author_name[0] || "").trim()
    : "";
  const coverId = doc?.cover_i;
  if (!title || !coverId) return null;
  return {
    title,
    author,
    coverUrl: `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`,
    firstPublishYear: doc?.first_publish_year || null,
    subjects: Array.isArray(doc?.subject) ? doc.subject.slice(0, 8) : [],
  };
}

function splitBookKeywords(keywords) {
  return String(keywords || "")
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 4);
}

async function fetchOpenLibraryBooks(query, keywords = "", limit = 5) {
  const cleanQuery = String(query || "").replace(/\s+/g, " ").trim();
  if (!cleanQuery) return [];
  try {
    const ua = { "User-Agent": "thisday.info-blog/1.0 (https://thisday.info)" };
    const res = await fetch(
      `https://openlibrary.org/search.json?q=${encodeURIComponent(cleanQuery)}&mode=books&limit=12&fields=title,author_name,cover_i,first_publish_year,subject`,
      { headers: ua },
    );
    if (!res.ok) return [];
    const data = await res.json();
    const docs = (data?.docs || [])
      .map(normalizeOpenLibraryBook)
      .filter(Boolean);
    if (!docs.length) return [];

    const words = splitBookKeywords(keywords);
    const seen = new Set();
    const dedupe = (book) => {
      const key = normalizeTopicMatchText(`${book.title} ${book.author}`);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    };
    const matching = words.length
      ? docs.filter((book) => {
          const hay = `${book.title} ${book.author} ${(book.subjects || []).join(" ")}`.toLowerCase();
          return words.some((word) => hay.includes(word));
        })
      : docs;
    const ordered = matching.length
      ? [...matching, ...docs.filter((book) => !matching.includes(book))]
      : docs;
    return ordered.filter(dedupe).slice(0, limit);
  } catch {
    return [];
  }
}

async function hydrateContentAssetsForPublish(content, currentPillars = []) {
  const related = buildAmazonRelatedData(content, currentPillars);
  if (!related) return content;
  const existingBooks = relevantOpenLibraryBooks(content);
  if (existingBooks.length >= MIN_RELEVANT_COMMERCIAL_BOOKS) {
    content.openLibraryBooks = existingBooks;
    return content;
  }

  const queries = [
    related.openLibraryQuery,
    `${related.topic} history`,
    content.eventTitle,
    ...(Array.isArray(content.keyTerms)
      ? content.keyTerms
          .filter((term) => String(term?.type || "").toLowerCase() === "person")
          .map((term) => `${term.term} biography`)
      : []),
  ]
    .map((query) => String(query || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const books = [...existingBooks];
  const seen = new Set(
    existingBooks.map((book) =>
      normalizeTopicMatchText(`${book.title || ""} ${book.author || ""}`),
    ),
  );
  for (const query of queries) {
    if (books.length >= 5) break;
    const found = await fetchOpenLibraryBooks(query, related.bookKeywords, 5).catch(() => []);
    for (const book of found) {
      const key = normalizeTopicMatchText(`${book.title} ${book.author}`);
      if (!key || seen.has(key) || !openLibraryBookMatchesArticle(book, content)) {
        continue;
      }
      seen.add(key);
      books.push(book);
      if (books.length >= 5) break;
    }
  }
  if (books.length >= MIN_RELEVANT_COMMERCIAL_BOOKS) {
    content.openLibraryBooks = books;
  } else {
    delete content.openLibraryBooks;
  }
  return content;
}

function buildAmazonRelatedBlock(c, currentPillars = []) {
  const relevantBooks = relevantOpenLibraryBooks(c);
  if (relevantBooks.length < MIN_RELEVANT_COMMERCIAL_BOOKS) return "";

  const related = buildAmazonRelatedData(c, currentPillars);
  if (!related) return "";

  const cards = buildOpenLibraryAmazonCards(relevantBooks);

  return `<section class="amazon-related mt-4 p-3 rounded" aria-label="Related book recommendations">
            <div class="amazon-related-head">
              <span class="amazon-kicker">Related books</span>
            </div>
            <div class="amazon-slider-shell" data-open-library-books data-query="${esc(related.openLibraryQuery)}" data-keywords="${esc(related.bookKeywords)}" data-amazon-tag="${esc(AMAZON_ASSOCIATE_TAG)}">
              <button type="button" class="amazon-slider-btn" aria-label="Previous Amazon recommendations" onclick="this.parentElement.querySelector('.amazon-slider-wrap').scrollBy({left:-260,behavior:'smooth'})">&#8249;</button>
              <div class="amazon-slider-wrap">
                <div class="amazon-slider-track" aria-live="polite">${cards}</div>
              </div>
              <button type="button" class="amazon-slider-btn" aria-label="Next Amazon recommendations" onclick="this.parentElement.querySelector('.amazon-slider-wrap').scrollBy({left:260,behavior:'smooth'})">&#8250;</button>
            </div>
            <small class="article-meta d-block mt-2">Book covers from Open Library. As an Amazon Associate I earn from qualifying purchases.</small>
          </section>`;
}

function buildArticleBodyAdBlock() {
  return `<div class="ad-unit-container article-body-ad article-body-ad-v1 mt-4 mb-4">
            <span class="ad-unit-label">Advertisement</span>
            <ins class="adsbygoogle"
                 style="display:block"
                 data-ad-client="ca-pub-8565025017387209"
                 data-ad-slot="9477779891"
                 data-ad-format="auto"
                 data-full-width-responsive="true"></ins>
          </div>`;
}

function readHtmlAttr(tag, name) {
  const escapedName = String(name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(tag || "").match(new RegExp(`${escapedName}="([^"]*)"`, "i"));
  return match ? unesc(match[1]) : "";
}

async function hydrateAmazonBlocksInHtml(html) {
  const source = String(html || "");
  const trackRe = /(<div class="amazon-slider-shell"[^>]*data-open-library-books[^>]*>[\s\S]*?<div class="amazon-slider-track"[^>]*>)([\s\S]*?)(<\/div>)/gi;
  let result = "";
  let lastIndex = 0;
  let changed = false;
  let match;

  while ((match = trackRe.exec(source))) {
    const [full, prefix, trackHtml, suffix] = match;
    result += source.slice(lastIndex, match.index);
    lastIndex = match.index + full.length;

    if (!amazonTracksNeedCoverBackfill(`<div class="amazon-slider-track">${trackHtml}</div>`)) {
      result += full;
      continue;
    }

    const shellTag = prefix.match(/<div class="amazon-slider-shell"[^>]*>/i)?.[0] || "";
    const query = readHtmlAttr(shellTag, "data-query") || "history books";
    const keywords = readHtmlAttr(shellTag, "data-keywords");
    const books = await fetchOpenLibraryBooks(query, keywords, 5).catch(() => []);
    const cards = buildOpenLibraryAmazonCards(books);
    if (!cards) {
      result += full;
      continue;
    }

    result += prefix + cards + suffix;
    changed = true;
  }

  if (!changed) return source;
  return result + source.slice(lastIndex);
}

/**
 * Fetches up to `limit` images from the article's own Wikipedia page.
 * Used as a fallback when no person portraits are available (event/battle articles).
 * Skips the cover image, icons, maps, flags, and tiny images.
 *
 * @param {string} wikiUrl   Article Wikipedia URL
 * @param {string} coverUrl  Already-used cover image URL (excluded to avoid duplicates)
 * @param {number} limit
 * @returns {Promise<{name:string,imageUrl:string,wikiUrl:string}[]>}
 */
async function fetchEventImages(wikiUrl, coverUrl, limit = 2, fallbackTitle = "") {
  if (!wikiUrl) return [];
  const ua = { "User-Agent": "thisday.info-blog/1.0 (https://thisday.info)" };
  // Skip icons, diagrams, and non-photographic images that look bad when floated inline.
  const BAD = /\b(icon|logo|flag|map|seal|stub|arrow|bullet|blank|placeholder|seating|seat|chart|diagram|schematic|layout|floor.?plan|plan|technical|drawing|cross.?section|cross.section|infographic)\b/i;
  try {
    let title = decodeURIComponent((wikiUrl.split("/wiki/")[1] ?? "").split("#")[0]);
    if (!title) return [];
    let resolvedWikiUrl = wikiUrl;

    const getCandidates = async (pageTitle) => {
      const listRes = await fetch(
        `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(pageTitle)}&prop=images&imlimit=30&format=json`,
        { headers: ua },
      );
      if (!listRes.ok) return [];
      const listData = await listRes.json();
      const page = Object.values(listData?.query?.pages ?? {})[0];
      return (page?.images ?? [])
        .map((i) => i.title)
        .filter((candidate) => /\.(jpe?g|png|webp)$/i.test(candidate) && !BAD.test(candidate));
    };

    let candidates = await getCandidates(title);
    if (!candidates.length && fallbackTitle) {
      const searchRes = await fetch(
        `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(fallbackTitle)}&srnamespace=0&srlimit=1&format=json`,
        { headers: ua },
      );
      const searchData = searchRes.ok ? await searchRes.json() : null;
      const matchedTitle = searchData?.query?.search?.[0]?.title || "";
      if (matchedTitle && matchedTitle.toLowerCase() !== title.toLowerCase()) {
        title = matchedTitle;
        resolvedWikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(matchedTitle.replace(/\s+/g, "_"))}`;
        candidates = await getCandidates(title);
      }
    }

    if (!candidates.length) return [];

    const piped = candidates.slice(0, 15).join("|");
    const infoRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(piped)}&prop=imageinfo&iiprop=url|size&format=json`,
      { headers: ua },
    );
    if (!infoRes.ok) return [];
    const infoData = await infoRes.json();

    const coverFile = wikimediaImageFileKey(coverUrl);
    const eligible = Object.values(infoData?.query?.pages ?? {})
      .map((p) => ({
        url: p?.imageinfo?.[0]?.url ?? null,
        px: (p?.imageinfo?.[0]?.width ?? 0) * (p?.imageinfo?.[0]?.height ?? 0),
        w: p?.imageinfo?.[0]?.width ?? 0,
        h: p?.imageinfo?.[0]?.height ?? 0,
      }))
      .filter(({ url, w, h }) => {
        if (!url || w < 300 || h < 200) return false;
        // Skip images with extreme aspect ratios — very tall (seating charts, diagrams)
        // or very wide (panoramas) both break inline float layouts.
        if (w > 0 && h / w > 2.0) return false;   // taller than 2:1 → skip
        if (h > 0 && w / h > 4.0) return false;   // wider than 4:1 → skip
        return wikimediaImageFileKey(url) !== coverFile;
      });
    const photographic = eligible.filter(({ url }) => /\.(?:jpe?g|webp)(?:$|[?#])/i.test(url));
    return (photographic.length > 0 ? photographic : eligible)
      .sort((a, b) => b.px - a.px)
      .slice(0, limit)
      .map(({ url }) => ({ name: "via Wikimedia", imageUrl: url, wikiUrl: resolvedWikiUrl }));
  } catch {
    return [];
  }
}

/**
 * Injects event images (non-portrait) at section boundaries in the article HTML.
 * Targets Aftermath then Eyewitness/Chronicle sections; falls back to fixed
 * paragraph offsets. Uses alternating left/right floats. Min 1500-char gap enforced.
 *
 * @param {string} html
 * @param {{name:string,imageUrl:string,wikiUrl:string}[]} eventImages
 * @returns {string}
 */
function injectEventImages(html, eventImages) {
  if (!eventImages || eventImages.length === 0) return html;

  const figHtml = ({ imageUrl, name, wikiUrl }, float) => {
    const margin = float === "right"
      ? "0 0 1.2rem 1.5rem"
      : "0 1.5rem 1.2rem 0";
    return `<figure style="float:${float};margin:${margin};max-width:min(200px,40%);clear:${float};overflow:hidden;">` +
      `<a href="${esc(wikiUrl)}" target="_blank" rel="noopener noreferrer">` +
      `<img src="/image-proxy?src=${encodeURIComponent(imageUrl)}&w=200&q=80"` +
      ` alt="${esc(name)}" loading="lazy" class="img-fluid rounded"` +
      ` style="display:block;width:100%;height:auto;max-height:180px;object-fit:cover;">` +
      `</a>` +
      `<figcaption class="article-meta mt-1" style="font-size:0.72rem;text-align:center;">` +
      `<a href="${esc(wikiUrl)}" target="_blank" rel="noopener noreferrer">via Wikimedia</a>` +
      `</figcaption></figure>`;
  };

  // Section anchors tried in priority order — one image per section, alternating float
  const SECTION_ANCHORS = [
    "<!-- Overview -->",
    "<!-- Eyewitness / Chronicle Accounts -->",
    "<!-- Aftermath -->",
    "<!-- Conclusion -->",
  ];

  const MIN_GAP = 1500;
  let lastInjectedAt = -MIN_GAP;
  let floats = ["right", "left"];
  let floatIdx = 0;
  let imageIdx = 0;

  for (let si = 0; si < SECTION_ANCHORS.length; si++) {
    if (imageIdx >= eventImages.length) break;
    const anchor = SECTION_ANCHORS[si];
    const anchorPos = html.indexOf(anchor);
    if (anchorPos === -1) continue;
    if (anchorPos - lastInjectedAt < MIN_GAP) continue;

    // Find the first <p> after this anchor
    const pPos = html.indexOf("<p", anchorPos);
    if (pPos === -1) continue;

    // Skip this section if a <figure already exists anywhere between this anchor
    // and the next section anchor (covers person images injected anywhere in the section)
    const nextAnchorPos = (() => {
      for (let j = si + 1; j < SECTION_ANCHORS.length; j++) {
        const pos = html.indexOf(SECTION_ANCHORS[j]);
        if (pos !== -1) return pos;
      }
      return html.length;
    })();
    if (html.slice(anchorPos, nextAnchorPos).includes("<figure")) continue;

    const fig = figHtml(eventImages[imageIdx], floats[floatIdx % 2]);
    html = html.slice(0, pPos) + fig + html.slice(pPos);
    lastInjectedAt = pPos;
    floatIdx++;
    imageIdx++;
  }

  return html;
}

/**
 * Injects a floated Wikipedia portrait figure before the first <p> that mentions
 * each person. Enforces a minimum 1500-char gap between injected images so they
 * don't stack near ads. Each person is only injected once.
 */
function injectPersonImages(html, personImages) {
  if (!personImages || personImages.length === 0) return html;

  const isWordChar = (ch) => /[a-z0-9]/i.test(ch || "");
  const cleanNameToken = (token) =>
    String(token || "")
      .replace(/^[^a-z0-9]+/i, "")
      .replace(/[^a-z0-9]+$/i, "");

  function findMentionIndex(lowerHtml, lowerNeedle, fromIdx) {
    let idx = fromIdx;
    while (true) {
      idx = lowerHtml.indexOf(lowerNeedle, idx);
      if (idx === -1) return -1;
      const before = lowerHtml[idx - 1];
      const after = lowerHtml[idx + lowerNeedle.length];
      if (!isWordChar(before) && !isWordChar(after)) return idx;
      idx = idx + 1;
    }
  }

  // Find the opening <p ...> tag that contains a mention at `nameIdx`.
  // Works for both "<p>" and "<p class='...'>".
  function findParagraphStart(fullHtml, nameIdx) {
    const lower = fullHtml.toLowerCase();
    let searchFrom = nameIdx;
    while (true) {
      const pIdx = lower.lastIndexOf("<p", searchFrom);
      if (pIdx === -1) return -1;
      const next = lower[pIdx + 2] || "";
      // Avoid false-positives like <picture>
      if (next !== ">" && !/\s/.test(next)) {
        searchFrom = pIdx - 1;
        continue;
      }
      const tagEnd = lower.indexOf(">", pIdx);
      if (tagEnd === -1 || tagEnd > nameIdx) {
        searchFrom = pIdx - 1;
        continue;
      }
      const between = lower.slice(tagEnd + 1, nameIdx);
      if (between.includes("</p>")) {
        searchFrom = pIdx - 1;
        continue;
      }
      return pIdx;
    }
  }

  // Build portrait HTML for a given person
  const figHtml = ({ name, imageUrl, wikiUrl }) =>
    `<figure style="float:right;margin:0 0 1.2rem 1.5rem;max-width:min(150px,35%);clear:right;overflow:hidden;">` +
    `<a href="${esc(wikiUrl)}" target="_blank" rel="noopener noreferrer">` +
    `<img src="/image-proxy?src=${encodeURIComponent(imageUrl)}&w=200&q=80"` +
    ` alt="${esc(name)}" loading="lazy" class="img-fluid rounded"` +
    ` style="display:block;width:100%;height:auto;max-height:160px;object-fit:cover;object-position:top;">` +
    `</a>` +
    `<figcaption class="article-meta mt-1" style="font-size:0.72rem;text-align:center;">` +
    `${esc(name)}<br><a href="${esc(wikiUrl)}" target="_blank" rel="noopener noreferrer">via Wikimedia</a>` +
    `</figcaption>` +
    `</figure>`;

  // Minimum character distance between two injected images
  const MIN_GAP = 1500;
  let lastInjectedAt = -MIN_GAP;

  for (const person of personImages) {
    const lowerHtml = html.toLowerCase();
    const fullName = String(person?.name || "").trim();
    const tokens = fullName.split(/\s+/).filter(Boolean).map(cleanNameToken);
    const lastName = tokens.length ? tokens[tokens.length - 1] : "";
    const candidates = [fullName]
      .filter(Boolean)
      .concat(
        lastName && lastName.length >= 4 && lastName.toLowerCase() !== fullName.toLowerCase()
          ? [lastName]
          : [],
      );
    let searchFrom = 0;

    while (true) {
      let nameIdx = -1;
      for (const c of candidates) {
        const idx = findMentionIndex(lowerHtml, c.toLowerCase(), searchFrom);
        if (idx !== -1) {
          nameIdx = idx;
          break;
        }
      }
      if (nameIdx === -1) break;

      // Find the opening <p> that contains this mention
      const pStart = findParagraphStart(html, nameIdx);
      if (pStart === -1) { searchFrom = nameIdx + 1; continue; }

      // Confirm no </p> closes the tag between pStart and the name (i.e. still in same <p>)
      // (findParagraphStart already enforces this; keep as a belt-and-suspenders check)
      const afterOpen = html.indexOf(">", pStart);
      if (afterOpen !== -1) {
        const between = html.slice(afterOpen + 1, nameIdx);
        if (between.includes("</p>")) { searchFrom = nameIdx + 1; continue; }
      }

      // Enforce minimum distance from last injected image
      if (pStart - lastInjectedAt < MIN_GAP) { searchFrom = nameIdx + 1; continue; }

      // Skip if this <p> is inside a dyn-slide article — figures there are stripped on serve.
      // Check: if the last <article ... dyn-slide ...> before pStart is more recent than the
      // last </article> before pStart, we are inside an open dyn-slide element.
      {
        const before = html.slice(0, pStart);
        const dynSlideRe = /<article\b[^>]*\bdyn-slide\b[^>]*>/gi;
        let lastDynOpen = -1;
        let dm;
        while ((dm = dynSlideRe.exec(before))) lastDynOpen = dm.index;
        if (lastDynOpen !== -1) {
          const articleCloseRe = /<\/article>/gi;
          let lastClose = -1;
          let cm;
          while ((cm = articleCloseRe.exec(before))) lastClose = cm.index;
          if (lastDynOpen > lastClose) { searchFrom = nameIdx + 1; continue; }
        }
      }

      // Inject figure as a sibling immediately before <p> — valid HTML5, float aligns with paragraph text
      const figure = figHtml(person);
      html = html.slice(0, pStart) + figure + html.slice(pStart);
      lastInjectedAt = pStart;
      break;
    }
  }

  return html;
}

// ---------------------------------------------------------------------------
// Link injection — Wikipedia + internal blog post cross-links
// ---------------------------------------------------------------------------

/**
 * Injects hyperlinks into rendered article HTML.
 *
 * Two link types:
 *   1. Wikipedia links — from keyTerms provided by the AI ({term, wikiUrl} pairs).
 *      Only the first occurrence of each term in <p> tags is linked.
 *   2. Internal blog links — scans existingIndex for post titles whose event name
 *      appears verbatim in the new article. Links first occurrence to /blog/SLUG/.
 *
 * Never links inside an existing <a>...</a> block.
 * Never links the article's own event title.
 */
function injectLinks(html, keyTerms = [], existingIndex = [], ownEventTitle = "") {
  // Build list of {term, url, isExternal} sorted longest-first to avoid
  // partial matches (e.g. "Battle of Waterloo" before "Waterloo")
  const links = [];

  for (const kt of keyTerms) {
    if (!kt.term || !kt.wikiUrl || kt.term.length < 3) continue;
    if (ownEventTitle && kt.term.toLowerCase().includes(ownEventTitle.toLowerCase().slice(0, 15))) continue;
    links.push({ term: kt.term, url: kt.wikiUrl, isExternal: true });
  }

  for (const post of existingIndex) {
    const eventName = post.title ? post.title.split(" — ")[0].trim() : "";
    if (!eventName || eventName.length < 5) continue;
    if (ownEventTitle && eventName.toLowerCase() === ownEventTitle.toLowerCase()) continue;
    links.push({ term: eventName, url: `/blog/${post.slug}/`, isExternal: false });
  }

  // Longest term first to avoid partial-match collisions
  links.sort((a, b) => b.term.length - a.term.length);

  // Track which terms have already been linked (first-occurrence only)
  const linked = new Set();

  // Only process content inside <p>...</p> blocks, skipping anything already in <a>
  html = html.replace(/(<p>)([\s\S]*?)(<\/p>)/g, (_match, open, body, close) => {
    for (const { term, url, isExternal } of links) {
      if (linked.has(term)) continue;
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?<!<[^>]*)\\b(${escaped})\\b`, "i");
      if (!re.test(body)) continue;
      // Skip if already inside an anchor in this paragraph
      if (/<a\b/.test(body)) {
        const inAnchor = new RegExp(`<a\\b[^>]*>[^<]*${escaped}[^<]*<\\/a>`, "i");
        if (inAnchor.test(body)) continue;
      }
      const attrs = isExternal
        ? `href="${url}" target="_blank" rel="noopener noreferrer"`
        : `href="${url}"`;
      body = body.replace(re, `<a ${attrs}>$1</a>`);
      linked.add(term);
    }
    return open + body + close;
  });

  return html;
}

// ---------------------------------------------------------------------------
// HTML builders
// ---------------------------------------------------------------------------

function compactHeadingSubject(content) {
  return getTitleLead(content?.eventTitle || content?.title || "the Event")
    .replace(/\b(Founding|Creation|Launch|Opening|Completion|Presentation)\b$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 70);
}

function compactAnalysisSubject(content) {
  const sourceSubject =
    String(content?.sourcePageTitle || "").trim() ||
    wikiTitleFromUrl(content?.wikiUrl || content?.jsonLdUrl);
  const subject = String(sourceSubject || compactHeadingSubject(content))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 70);
  return subject || "the historical event";
}

function buildArticleSectionHeadings(content, pillars = []) {
  const subject = compactHeadingSubject(content);
  const haystack = normalizeTopicMatchText(
    [
      content?.title,
      content?.eventTitle,
      content?.description,
      content?.keywords,
      ...(pillars || []),
    ].join(" "),
  );

  const headings = {
    overview: `Inside ${subject}`,
    eyewitness: "What People Saw and Reported",
    aftermath: "What Changed Next",
    legacy: "Why It Still Matters",
    analysis: "Our Take: Choices, Consequences, and Blind Spots",
    good: "What Worked",
    bad: "What Failed",
  };

  const safePillars = Array.isArray(pillars) ? pillars : [];
  const primaryPillar = safePillars[0] || "";
  const hasPillar = (pillar) => safePillars.includes(pillar);
  const sportsSignal =
    hasPillar("Sports") ||
    /\b(sports?|athlete|football|soccer|basketball|baseball|tennis|golf|boxing|wrestling|cricket|rugby|hockey|olympic|paralympic|champion|championship|tournament|match|grand prix|formula one|formula 1|motorsport|motor racing|nascar|indy)\b/.test(haystack);
  const healthSignal =
    hasPillar("Health & Medicine") ||
    /\b(health|medicine|medical|vaccine|vaccination|pandemic|epidemic|disease|hospital|surgery|doctor|physician|public health|virus|plague|treatment|diagnosis|patient)\b/.test(haystack);
  const economySignal =
    hasPillar("Economy & Business") ||
    /\b(economy|economic|business|market|stock exchange|stock market|wall street|bank|banking|company|corporation|trade|tariff|currency|inflation|financial|finance|industry|industrial|railroad land auction)\b/.test(haystack);
  const explicitDisaster =
    /\b(crash(?:es|ed)?|collision|accident|disaster|catastrophe|explosion|fires?|oil spill|bombing|shooting|massacre|earthquake|flood|eruption|hurricane|tornado|sinking|sank|shipwreck)\b/.test(haystack);

  if (primaryPillar === "Born on This Day") {
    return {
      ...headings,
      overview: "The Life That Began Here",
      eyewitness: "The World Around the Birth",
      aftermath: "The Work That Followed",
      legacy: "Why This Life Still Matters",
      analysis: "Our Take: Talent, Timing, and Legacy",
      good: "What the Life Gave the World",
      bad: "What the Story Often Leaves Out",
    };
  }

  if (primaryPillar === "Died on This Day") {
    return {
      ...headings,
      overview: "The Final Days and the Loss",
      eyewitness: "How the Death Was Reported",
      aftermath: "Mourning, Succession, and Immediate Consequences",
      legacy: "The Legacy That Outlived Them",
      analysis: "Our Take: Reputation, Memory, and Myth",
      good: "What Endured Afterward",
      bad: "What the Legacy Could Not Fix",
    };
  }

  if (primaryPillar === "Famous Persons") {
    return {
      ...headings,
      overview: "The Life and the Turning Point",
      eyewitness: "How Contemporaries Saw Them",
      aftermath: "Work, Reputation, and Later Years",
      legacy: "The Legacy They Left",
      analysis: "Our Take: Character, Choices, and Memory",
      good: "What They Gave Their Era",
      bad: "What the Reputation Hides",
    };
  }

  if (primaryPillar === "Disasters & Accidents" || (explicitDisaster && !economySignal && !healthSignal)) {
    return {
      ...headings,
      overview: "The Disaster and Its Immediate Cause",
      eyewitness: "First Reports From the Scene",
      aftermath: "Rescue, Response, and Fallout",
      legacy: "The Questions the Disaster Left Behind",
      analysis: "Our Take: Risk, Response, and Accountability",
      good: "What Worked Under Pressure",
      bad: "What Failed Before Impact",
    };
  }

  if (sportsSignal) {
    return {
      ...headings,
      overview: "The Contest and the Stakes",
      eyewitness: "How the Crowd Saw It",
      aftermath: "Records, Reactions, and Consequences",
      legacy: "The Standard It Set",
      analysis: "Our Take: Pressure, Skill, and Legacy",
      good: "What the Competitors Got Right",
      bad: "What the Result Exposed",
    };
  }

  if (healthSignal) {
    return {
      ...headings,
      overview: "The Medical Problem and the Breakthrough",
      eyewitness: "What Doctors and Patients Saw",
      aftermath: "Treatment, Policy, and Public Response",
      legacy: "The Practice It Changed",
      analysis: "Our Take: Evidence, Ethics, and Access",
      good: "What the Researchers Got Right",
      bad: "What Care Still Missed",
    };
  }

  if (economySignal) {
    return {
      ...headings,
      overview: "The Money, Market, and Stakes",
      eyewitness: "Reports From the Economic Front",
      aftermath: "Losses, Laws, and Institutional Fallout",
      legacy: "The System It Changed",
      analysis: "Our Take: Incentives, Risk, and Consequences",
      good: "What the Decision Got Right",
      bad: "What the System Missed",
    };
  }

  if (/\b(exploration|discovery|expedition|voyage|flight|landing|aviation|aircraft|airplane|plane|transatlantic|space|mission|journey|route|pilot|aviator)\b/.test(haystack)) {
    return {
      ...headings,
      overview: "The Journey and the Stakes",
      eyewitness: "Reports From the Route",
      aftermath: "Recognition, Imitation, and First Consequences",
      legacy: "The Boundary It Moved",
      analysis: "Our Take: Risk, Skill, and Public Myth",
      good: "What the Explorer Got Right",
      bad: "What the Legend Left Out",
    };
  }

  if (/\b(court|supreme court|ruling|decision|verdict|trial|constitutional|unconstitutional|lawsuit|legal case)\b/.test(haystack)) {
    return {
      ...headings,
      overview: "The Case and the Stakes",
      eyewitness: "The Record Behind the Ruling",
      aftermath: "The Ruling Meets Reality",
      legacy: "The Fight the Decision Did Not Finish",
      analysis: "Our Take: Legal Strategy and Its Limits",
      good: "What the Strategy Got Right",
      bad: "Where the System Resisted",
    };
  }

  if (hasPillar("Social & Human Rights") || /\b(civil rights|human rights|voting rights|suffrage|apartheid|protest|march|boycott|strike|equality|segregation|abolition|emancipation|labor rights|workers rights)\b/.test(haystack)) {
    return {
      ...headings,
      overview: "The Injustice and the Demand for Change",
      eyewitness: "Voices From the Movement",
      aftermath: "Rights Won, Resisted, and Enforced",
      legacy: "The Fight That Continued",
      analysis: "Our Take: Courage, Strategy, and Backlash",
      good: "What the Movement Got Right",
      bad: "What Justice Still Left Unfinished",
    };
  }

  if (/\b(independence|declares|declaration|referendum|statehood|revolution|uprising|revolt)\b/.test(haystack)) {
    return {
      ...headings,
      overview: "The Break With the Old Order",
      eyewitness: "Voices From the Moment",
      aftermath: "Recognition, Resistance, and First Consequences",
      legacy: "The Nation That Emerged Afterward",
      analysis: "Our Take: Courage, Timing, and Cost",
      good: "What the Leaders Got Right",
      bad: "What the Break Could Not Solve",
    };
  }

  if (hasPillar("War & Conflict") || /\b(war|battle|siege|invasion|army|military|troops|forces|surrender|defeat|treaty|campaign)\b/.test(haystack)) {
    return {
      ...headings,
      overview: "The Clash and the Stakes",
      eyewitness: "Reports From the Front",
      aftermath: "The Military and Political Fallout",
      legacy: "How the Balance of Power Shifted",
      analysis: "Our Take: Strategy, Mistakes, and Momentum",
      good: "What Worked on the Ground",
      bad: "Where Command Failed",
    };
  }

  if (hasPillar("Arts & Culture") || /\b(academy awards|oscars|wedding|film|music|art|culture|ceremony|prince|meghan|harry|literature|book|novel|poem|painting|artist|museum|theatre|theater|opera|festival)\b/.test(haystack)) {
    return {
      ...headings,
      overview: "The Ceremony and the Signal",
      eyewitness: "How the Moment Looked in Public",
      aftermath: "Public Reaction and Institutional Fallout",
      legacy: "The Image That Outlived the Day",
      analysis: "Our Take: Image, Power, and Public Memory",
      good: "What the Moment Achieved",
      bad: "What the Pageantry Hid",
    };
  }

  if (hasPillar("Science & Technology") || /\b(science|technology|computer|shuttle|probe|invented|invention|discovered|first|research|laboratory|engineer|machine|satellite|rocket)\b/.test(haystack)) {
    return {
      ...headings,
      overview: "The Breakthrough and the Problem It Solved",
      eyewitness: "How Observers Understood It",
      aftermath: "Testing, Adoption, and Pushback",
      legacy: "The Future It Made Possible",
      analysis: "Our Take: Ingenuity, Limits, and Timing",
      good: "What the Innovators Got Right",
      bad: "What Slowed the Breakthrough",
    };
  }

  if (hasPillar("Politics & Government") || /\b(politics|government|election|president|prime minister|parliament|congress|senate|minister|cabinet|coup|constitution|diplomacy|administration|policy|office|king|queen|monarch|empire|republic)\b/.test(haystack)) {
    return {
      ...headings,
      overview: "The Power Struggle and the Stakes",
      eyewitness: "Voices From the Political Moment",
      aftermath: "Law, Office, and Public Reaction",
      legacy: "The Order It Left Behind",
      analysis: "Our Take: Power, Principle, and Cost",
      good: "What the Leaders Got Right",
      bad: "Where Power Overreached",
    };
  }

  return headings;
}

/**
 * Builds the full blog post HTML page, matching the structure of existing
 * hand-written posts on thisday.info.
 */
function visibleArticleCorpus(content) {
  return normalizeTopicMatchText(
    [
      content?.title,
      content?.curiosityTitle,
      content?.eventTitle,
      content?.description,
      content?.historicalDate,
      content?.location,
      content?.country,
      ...(content?.overviewParagraphs || []),
      ...(content?.eyewitnessOrChronicle || []),
      ...(content?.aftermathParagraphs || []),
      ...(content?.conclusionParagraphs || []),
      ...(content?.quickFacts || []).map((fact) => `${fact?.label || ""} ${fact?.value || ""}`),
      ...(content?.didYouKnowFacts || []),
    ].join(" "),
  );
}

function schemaTypeForEntity(type) {
  if (type === "person") return "Person";
  if (type === "place") return "Place";
  if (type === "organization") return "Organization";
  if (type === "event") return "Event";
  return "Thing";
}

function buildVerifiedArticleMentions(content, entityMeta = []) {
  const mentions = [];
  const seen = new Set();
  const push = (mention) => {
    const name = String(mention?.name || "").replace(/\s+/g, " ").trim();
    const type = String(mention?.["@type"] || "Thing");
    const key = `${type}:${normalizeTopicMatchText(name)}`;
    if (!name || seen.has(key)) return;
    seen.add(key);
    mentions.push({ ...mention, name });
  };

  // The people strip is the visible source of truth for Person mentions. A
  // Wikipedia identity is emitted only after the substantive-profile verifier
  // approved that exact person.
  for (const entity of Array.isArray(entityMeta) ? entityMeta : []) {
    if (entity?.type !== "person" || entity.skipStrip || !entity.name) continue;
    push({
      "@type": "Person",
      name: entity.name,
      ...(entity.profileLinkEligible === true &&
      entity.profileSubjectVerified === true &&
      entity.wikidataInstanceOfHuman === true &&
      /^https:\/\/en\.wikipedia\.org\/wiki\/[^?#]+$/i.test(String(entity.wikiUrl || ""))
        ? { sameAs: entity.wikiUrl }
        : {}),
    });
  }

  // Non-person key terms are included only when their label actually appears
  // in visible article copy. AI-provided identity URLs are intentionally not
  // copied into schema without an equivalent subject-verification contract.
  const visibleCorpus = visibleArticleCorpus(content);
  for (const term of Array.isArray(content?.keyTerms) ? content.keyTerms : []) {
    if (!term?.term || term.type === "person") continue;
    const normalizedTerm = normalizeTopicMatchText(term.term);
    if (!normalizedTerm || !` ${visibleCorpus} `.includes(` ${normalizedTerm} `)) continue;
    push({ "@type": schemaTypeForEntity(term.type), name: term.term });
  }

  return mentions;
}

function buildBlogPostStructuredData(
  content,
  date,
  canonicalUrl,
  previewImageUrl,
  featuredImageUrl,
  entityMeta = [],
) {
  const publishedAt = date.toISOString();
  const description = content.jsonLdDescription || content.description;
  const eventName = content.eventTitle || content.jsonLdName || content.title;
  const event = {
    "@type": "Event",
    name: eventName,
    ...(content.historicalDateISO || content.historicalYear
      ? { startDate: content.historicalDateISO || String(content.historicalYear) }
      : {}),
    ...(description ? { description } : {}),
    ...(content.location || content.country
      ? {
          location: {
            "@type": "Place",
            ...(content.location ? { name: content.location } : {}),
            ...(content.country
              ? { address: { "@type": "PostalAddress", addressCountry: content.country } }
              : {}),
          },
        }
      : {}),
    ...(content.wikiUrl || content.jsonLdUrl ? { url: content.wikiUrl || content.jsonLdUrl } : {}),
    eventStatus: "https://schema.org/EventCompleted",
    ...(content.organizerName &&
    ` ${visibleArticleCorpus(content)} `.includes(` ${normalizeTopicMatchText(content.organizerName)} `)
      ? { organizer: { "@type": "Organization", name: content.organizerName } }
      : {}),
  };
  const mentions = buildVerifiedArticleMentions(content, entityMeta);

  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    mainEntityOfPage: { "@type": "WebPage", "@id": canonicalUrl },
    headline: publicArticleTitle(content),
    datePublished: publishedAt,
    inLanguage: "en",
    articleSection: "History",
    author: {
      "@type": "Organization",
      name: "thisDay.info Editorial Team",
      url: "https://thisday.info/about/editorial/",
    },
    publisher: {
      "@type": "Organization",
      name: "thisDay.info",
      url: "https://thisday.info/",
      logo: {
        "@type": "ImageObject",
        url: "https://thisday.info/images/logo.png",
      },
    },
    ...(description ? { description } : {}),
    ...(previewImageUrl
      ? {
          image: {
            "@type": "ImageObject",
            url: previewImageUrl,
            ...(featuredImageUrl ? { contentUrl: featuredImageUrl } : {}),
            ...(content.imageAlt ? { caption: content.imageAlt } : {}),
          },
        }
      : {}),
    url: canonicalUrl,
    about: event,
    ...(mentions.length > 0 ? { mentions } : {}),
  };
}

function buildArticleBreadcrumbStructuredData(content, canonicalUrl, currentPillars = []) {
  const pillarSlug = (str) =>
    str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  const itemListElement = [
    {
      "@type": "ListItem",
      position: 1,
      name: "thisDay.",
      item: "https://thisday.info/",
    },
    {
      "@type": "ListItem",
      position: 2,
      name: "Historical Blog",
      item: "https://thisday.info/blog/",
    },
  ];
  if (currentPillars.length > 0) {
    itemListElement.push({
      "@type": "ListItem",
      position: 3,
      name: currentPillars[0],
      item: `https://thisday.info/blog/topic/${pillarSlug(currentPillars[0])}/`,
    });
  }
  itemListElement.push({
    "@type": "ListItem",
    position: itemListElement.length + 1,
    name: content.eventTitle || content.title,
    item: canonicalUrl,
  });
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement,
  };
}

function extractJsonLdObjects(html) {
  const objects = [];
  const invalidBlocks = [];
  const pattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(String(html || ""))) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed?.["@graph"])) objects.push(...parsed["@graph"]);
      else objects.push(parsed);
    } catch (error) {
      invalidBlocks.push(error.message);
    }
  }
  return { objects, invalidBlocks };
}

function schemaObjectHasType(object, type) {
  const schemaType = object?.["@type"];
  return Array.isArray(schemaType) ? schemaType.includes(type) : schemaType === type;
}

function validateArticleStructuredDataForPublish(html, content, entityMeta = []) {
  const reasons = [];
  const { objects, invalidBlocks } = extractJsonLdObjects(html);
  if (invalidBlocks.length > 0) reasons.push(`invalid JSON-LD: ${invalidBlocks.join("; ")}`);

  const articles = objects.filter((object) =>
    ["Article", "BlogPosting", "NewsArticle"].some((type) => schemaObjectHasType(object, type)),
  );
  const breadcrumbs = objects.filter((object) => schemaObjectHasType(object, "BreadcrumbList"));
  const faqPages = objects.filter((object) => schemaObjectHasType(object, "FAQPage"));
  if (articles.length !== 1) reasons.push(`expected one article schema, found ${articles.length}`);
  if (articles.some((article) => schemaObjectHasType(article, "NewsArticle"))) {
    reasons.push("historical feature must not use NewsArticle schema");
  }
  if (articles.length === 1 && !schemaObjectHasType(articles[0], "BlogPosting")) {
    reasons.push("historical blog feature must use BlogPosting schema");
  }
  if (breadcrumbs.length !== 1) reasons.push(`expected one BreadcrumbList, found ${breadcrumbs.length}`);
  if (faqPages.length > 0) reasons.push("FAQPage schema is not eligible for this historical feature");

  const article = articles[0];
  if (article) {
    if (article.headline !== publicArticleTitle(content)) {
      reasons.push("schema headline does not match the visible title");
    }
    const about = article.about;
    if (!schemaObjectHasType(about, "Event")) reasons.push("article about schema must describe an Event");
    const expectedEventName = content?.eventTitle || content?.jsonLdName || content?.title;
    if (about?.name !== expectedEventName) reasons.push("schema event name does not match visible content");
    const expectedStartDate = content?.historicalDateISO ||
      (content?.historicalYear ? String(content.historicalYear) : "");
    if (expectedStartDate && about?.startDate !== expectedStartDate) {
      reasons.push("schema event date does not match the historical date");
    }
    if (content?.location && about?.location?.name !== content.location) {
      reasons.push("schema location does not match visible content");
    }
    if (content?.country && about?.location?.address?.addressCountry !== content.country) {
      reasons.push("schema country does not match visible content");
    }
  }

  const visiblePeople = new Map(
    (Array.isArray(entityMeta) ? entityMeta : [])
      .filter((entity) => entity?.type === "person" && entity.name && !entity.skipStrip)
      .map((entity) => [normalizeTopicMatchText(entity.name), entity]),
  );
  const personMentions = (Array.isArray(article?.mentions) ? article.mentions : [])
    .filter((mention) => schemaObjectHasType(mention, "Person"));
  for (const mention of personMentions) {
    const key = normalizeTopicMatchText(mention.name);
    const entity = visiblePeople.get(key);
    if (!entity || !String(html || "").includes(esc(mention.name))) {
      reasons.push(`schema person is not visible: ${mention.name || "unnamed person"}`);
      continue;
    }
    if (mention.sameAs && !(
      entity.profileLinkEligible === true &&
      entity.profileSubjectVerified === true &&
      entity.wikidataInstanceOfHuman === true &&
      mention.sameAs === entity.wikiUrl
    )) {
      reasons.push(`schema person identity is not verified: ${mention.name}`);
    }
  }
  for (const [key, entity] of visiblePeople) {
    if (!personMentions.some((mention) => normalizeTopicMatchText(mention.name) === key)) {
      reasons.push(`visible person missing from schema: ${entity.name}`);
    }
  }

  return { ok: reasons.length === 0, reasons, objects };
}

function articleProcessReviewMarkup({ legacy = false } = {}) {
  if (legacy) {
    return (
      `AI assisted with research and drafting. Automated safeguards vary by publication date, and this stored article ` +
      `may predate the current citation, corroboration, grounding, and structure checks. A human editor did not necessarily ` +
      `review it before publication, so errors may remain. <a href="/about/editorial/">Read our current editorial process</a>.`
    );
  }
  return (
    `AI assisted with source research and drafting. Before publication, automated safeguards checked direct citations, ` +
    `independent corroboration of the central claim, factual consistency, and required article structure. ` +
    `A human editor does not necessarily review every article before publication, so errors may remain. ` +
    `<a href="/about/editorial/">Read our editorial process</a>.`
  );
}

function buildArticleProcessDisclosure({
  legacyWikipediaAttribution = false,
} = {}) {
  const sourceNote = legacyWikipediaAttribution
    ? `Historical source: <a href="https://en.wikipedia.org/" target="_blank" rel="noopener noreferrer">Wikipedia</a> ` +
      `(licensed under <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a>).`
    : "The direct historical sources used for the central event are listed above.";
  return `<!-- AI & Editorial Disclosure -->
          <div class="mt-5 p-3 rounded" style="background:rgba(0,0,0,0.03);border:1px solid rgba(0,0,0,0.08);font-size:.82rem;line-height:1.6">
            <strong style="display:block;margin-bottom:4px">About this article</strong>
            <span class="article-meta">
              ${articleProcessReviewMarkup({
                legacy: legacyWikipediaAttribution,
              })}
              ${sourceNote}
              Images via <a href="https://commons.wikimedia.org/" target="_blank" rel="noopener noreferrer">Wikimedia Commons</a>.
              Found an error? <a href="/contact/">Let us know</a>.
            </span>
          </div>`;
}

function normalizeArticleProcessDisclosureHtml(body) {
  return String(body || "").replace(
    /This article was researched and drafted with AI assistance,\s*then reviewed for factual accuracy by the\s*<a href="\/about\/(?:editorial\/)?" rel="author">thisDay\. editorial team<\/a>\./gi,
    articleProcessReviewMarkup({ legacy: true }),
  );
}

function buildPostHTML(
  c,
  date,
  slug,
  allPosts = [],
  currentPillars = [],
  bookCoverUrl = null,
  entityMeta = [],
) {
  const monthName = MONTH_NAMES[date.getMonth()];
  const day = date.getDate();
  const publishYear = date.getFullYear();
  const canonicalUrl = `https://thisday.info/blog/${slug}/`;
  const publishedStr = `${monthName} ${day}, ${publishYear}`;
  const publicTitle = publicArticleTitle(c);
  const keywords = Array.isArray(c.keywords)
    ? c.keywords.map((keyword) => String(keyword).trim()).filter(Boolean).join(", ")
    : String(c.keywords || "");

  const didYouKnowSlider = buildDidYouKnowSlider(c.didYouKnowFacts || [], c);
  const sectionHeadings = buildArticleSectionHeadings(c, currentPillars);
  const analysisHeading = `Analysis: ${compactAnalysisSubject(c)}`;
  const evidenceMapBlock = buildEvidenceMapBlock(c);
  const amazonRelatedBlock = buildAmazonRelatedBlock(c, currentPillars);
  const articleBodyAdBlock = amazonRelatedBlock ? buildArticleBodyAdBlock() : "";

  const overviewParas = (c.overviewParagraphs || [])
    .map((p) => `            <p>${esc(p)}</p>`)
    .join("\n");

  const eyewitnessParas = (c.eyewitnessOrChronicle || [])
    .map((p) => `            <p>${esc(p)}</p>`)
    .join("\n");

  // Only render the blockquote when the source attribution contains a year and
  // a real document/letter reference — filters out vague AI-generated attributions
  // like "Contemporary account" or "Historical record, unknown date".
  const hasVerifiableSource =
    c.eyewitnessQuoteSource &&
    /\d{4}/.test(c.eyewitnessQuoteSource) &&
    c.eyewitnessQuoteSource.length > 20;
  const eyewitnessQuoteBlock =
    c.eyewitnessQuote && hasVerifiableSource
      ? `          <blockquote class="historical-quote mt-3">
            <p>"${esc(c.eyewitnessQuote)}"</p>
            <footer class="article-meta">${esc(c.eyewitnessQuoteSource)}</footer>
          </blockquote>`
      : "";

  const aftermathParas = (c.aftermathParagraphs || [])
    .map((p) => `            <p>${esc(p)}</p>`)
    .join("\n");

  const conclusionParas = (c.conclusionParagraphs || [])
    .map((p) => `            <p>${esc(p)}</p>`)
    .join("\n");

  const renderableAnalysisItems = (items) =>
    (Array.isArray(items) ? items : []).filter(
      (item) =>
        item &&
        typeof item === "object" &&
        String(item.title || "").trim() &&
        String(item.detail || "").trim(),
    );
  const analysisGoodItems = renderableAnalysisItems(c.analysisGood)
    .map(
      (item) =>
        `                    <li class="mb-2"><strong>${esc(item.title)}:</strong> ${esc(item.detail)}</li>`,
    )
    .join("\n");

  const analysisBadItems = renderableAnalysisItems(c.analysisBad)
    .map(
      (item) =>
        `                    <li class="mb-2"><strong>${esc(item.title)}:</strong> ${esc(item.detail)}</li>`,
    )
    .join("\n");

  const editorialNote = c.editorialNote
    ? `          <p class="mt-4 fst-italic" style="font-size: 0.93rem; opacity: 0.85; border-left: 3px solid var(--btn-bg,#1b3a2d); padding-left: 1rem;">
            ${esc(c.editorialNote)}
          </p>`
    : "";

  const readingTime = c.readingTimeMinutes
    ? `&nbsp;|&nbsp;${esc(String(c.readingTimeMinutes))} min read`
    : "";

  const featuredImageUrl = isProxyableArticleImageUrl(c.imageUrl) ? c.imageUrl : "";
  const previewImageUrl = buildSocialPreviewImageUrl(featuredImageUrl);
  const jsonLd = JSON.stringify(
    buildBlogPostStructuredData(c, date, canonicalUrl, previewImageUrl, featuredImageUrl, entityMeta),
    null,
    2,
  );

  const pillarSlug = (str) =>
    str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  const breadcrumbJsonLd = JSON.stringify(
    buildArticleBreadcrumbStructuredData(c, canonicalUrl, currentPillars),
    null,
    2,
  );
  const pillarPills =
    currentPillars.length > 0
      ? `<div class="pillar-pill-row justify-content-center mt-3">
${currentPillars
  .slice(0, 3)
  .map((pillar, idx) => {
    const ps = pillarSlug(pillar);
    const featuredClass = idx === 0 ? " pillar-pill-featured" : "";
    return `              <a href="/blog/topic/${ps}/" class="pillar-pill${featuredClass}">${esc(pillar)}</a>`;
  })
  .join("\n")}
            </div>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="X-UA-Compatible" content="ie=edge" />
    <title>${esc(publicTitle)}</title>
    <link rel="canonical" href="${canonicalUrl}" />
    <meta name="robots" content="index, follow, max-image-preview:large" />
    <meta name="author" content="thisDay. Editorial" />
    <meta name="description" content="${esc(c.description)}" />
    <meta name="keywords" content="${esc(keywords)}" />

    <!-- Open Graph -->
    <meta property="og:title" content="${esc(publicTitle)}" />
    <meta property="og:description" content="${esc(c.ogDescription || c.description)}" />
    <meta property="og:type" content="article" />
    <meta property="og:url" content="${canonicalUrl}" />
    <meta property="og:image" content="${esc(previewImageUrl)}" />
    <meta property="og:image:alt" content="${esc(c.imageAlt || c.title)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:locale" content="en_US" />
    <meta property="og:site_name" content="thisDay." />
    <meta property="article:published_time" content="${date.toISOString()}" />
    <meta property="article:modified_time" content="${date.toISOString()}" />
    <meta property="article:section" content="History" />
    <meta property="article:author" content="https://thisday.info/" />
    ${keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
      .slice(0, 6)
      .map((k) => `<meta property="article:tag" content="${esc(k)}" />`)
      .join("\n    ")}

    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(publicTitle)}" />
    <meta name="twitter:description" content="${esc(c.twitterDescription || c.description)}" />
    <meta name="twitter:image" content="${esc(previewImageUrl)}" />
    <meta name="twitter:image:alt" content="${esc(c.imageAlt || c.title)}" />

    <!-- JSON-LD Schema -->
    <script type="application/ld+json">
${jsonLd}
    </script>
    <script type="application/ld+json">
${breadcrumbJsonLd}
    </script>

    <link rel="icon" href="/images/favicon.ico" />
    <link rel="apple-touch-icon" href="/images/apple-touch-icon.png" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" />
    <link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/css/style.css?v=8" />
    <link rel="stylesheet" href="/css/custom.css?v=33" />

    <script async src="https://www.googletagmanager.com/gtag/js?id=G-WXEZ3868VN"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag() { dataLayer.push(arguments); }
      gtag("js", new Date());
      gtag("config", "G-WXEZ3868VN");
      gtag("config", "AW-17262488503");
    </script>
    <script>
      (function(){
        var ref=document.referrer||"";
        if(!ref) return;
        var slug=${JSON.stringify(slug)};
        var sources=${JSON.stringify(AI_REFERRER_SOURCES)};
        var host="";
        try{host=new URL(ref).hostname.toLowerCase();}catch(_){return;}
        var match=sources.find(function(source){
          return (source.hosts||[]).some(function(candidate){
            candidate=String(candidate||"").toLowerCase();
            return host===candidate || host.endsWith("."+candidate);
          });
        });
        if(!match || typeof gtag!=="function") return;
        try{
          sessionStorage.setItem("td_ai_referrer_source", match.label);
          sessionStorage.setItem("td_ai_referrer_host", host);
        }catch(_){}
        gtag("event","ai_referrer_visit",{
          ai_source: match.label,
          ai_referrer_host: host,
          page_type: "blog-article",
          page_slug: slug,
          page_location: location.pathname
        });
        gtag("event","citation_target_visit",{
          ai_source: match.label,
          page_type: "blog-article",
          page_slug: slug
        });
      })();
    </script>
    <script>
      function gtag_report_conversion(url) {
        var callback = function () { if (typeof url != "undefined") { window.location = url; } };
        gtag("event", "conversion", { send_to: "AW-17262488503/WsLuCMLVweEaELfXsqdA", event_callback: callback });
        return false;
      }
    </script>
    <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8565025017387209" crossorigin="anonymous"></script>

    <style>
      :root{--bg:#ffffff;--bg-alt:#f2f7f2;--text:#1a2e20;--text-muted:#5c7a65;--border:#cfe0cf;--btn-bg:#1b3a2d;--btn-text:#fff;--btn-hover:#2a4d3a;--accent:#9dc43a;--radius:4px;--shadow:0 16px 32px -8px rgba(27,58,45,.08)}
      body{font-family:Lora,serif;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--text)}
      main{flex:1;margin-top:20px}
      p{font-size:15px;line-height:1.6}
      a{color:var(--btn-bg)}a:hover{color:var(--accent);text-decoration:underline}
      h1,h2,h3{color:var(--text)}
      /* Consistent article rhythm: even gaps between top-level blocks, roomy
         and uniform spacing between a heading and the content it introduces. */
      .h3{margin-top:0;margin-bottom:1rem}
      article.p-4 > * + *{margin-top:2rem!important}
      article.p-4 > .h3 + *{margin-top:1rem!important}
      .article-meta{color:var(--text-muted);font-size:13px}
      .pillar-pill-row{display:flex;flex-wrap:wrap;gap:10px}
      .pillar-pill{display:inline-flex;align-items:center;justify-content:center;padding:7px 14px;border:1px solid var(--border);border-radius:999px;background:var(--bg-alt);color:var(--btn-bg);font-size:13px;font-weight:400;letter-spacing:.01em;text-decoration:none;transition:background .15s ease,border-color .15s ease,color .15s ease}
      .pillar-pill:hover{background:#e7f0e7;border-color:var(--btn-bg);color:var(--btn-bg);text-decoration:none}
      .pillar-pill-featured{background:var(--btn-bg);border-color:var(--btn-bg);color:#fff}
      .pillar-pill-featured:hover{background:var(--btn-hover);border-color:var(--btn-hover);color:#fff}
      .breadcrumb{background:transparent;padding:0;margin-bottom:1rem}
      .breadcrumb-item a{color:var(--btn-bg)}.breadcrumb-item.active{color:var(--text-muted)}
      .seo-only-title{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
      .dyn-slider-shell{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center;margin:18px 0}
      .dyn-slider-btn{display:none;align-items:center;justify-content:center;width:42px;height:42px;border:1.5px solid var(--border);border-radius:999px;background:var(--bg);color:var(--text);font-size:20px;font-weight:400;cursor:pointer;transition:background .15s,border-color .15s,color .15s;flex-shrink:0;line-height:1}
      .dyn-slider-btn:hover{background:var(--bg-alt);border-color:var(--btn-bg);color:var(--btn-bg)}
      .dyn-slider-wrap{overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none}
      .dyn-slider-wrap::-webkit-scrollbar{display:none}
      .dyn-slider-track{display:flex;gap:14px;padding-bottom:4px}
      .dyn-slide{flex:0 0 240px;max-width:240px;min-height:220px;scroll-snap-align:start;background:var(--btn-bg);color:#fff;padding:2rem 1.75rem;display:flex;flex-direction:column;justify-content:center;gap:1rem;border-radius:10px}
      .dyn-slide img,.dyn-slide figure,.dyn-slider-wrap figure{display:none!important}
      .dyn-slide .dyn-fact{font-size:15px;color:#fff;margin:0;line-height:1.6}
      .dyn-slide .dyn-fact a,.dyn-slide .dyn-fact a:visited,.dyn-slide .dyn-fact a:hover,.dyn-slide .dyn-fact a:focus{color:#fff!important;text-decoration:underline;text-underline-offset:2px}
      .dyn-slide p{font-size:15px;line-height:1.6;color:var(--accent);margin:0}
      @media(min-width:768px){.dyn-slider-btn{display:inline-flex}}
      @media(max-width:767px){.dyn-slider-shell{grid-template-columns:minmax(0,1fr)}}
      .analysis-good{background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.3)}
      .analysis-bad{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.3)}
      .analysis-disclosure{border:1px solid var(--border);border-radius:10px;background:var(--bg);overflow:hidden}
      .analysis-disclosure-summary{cursor:pointer;padding:1rem 1.1rem;font-weight:700;color:var(--btn-bg);background:var(--bg-alt);list-style-position:inside}
      .analysis-disclosure-summary:hover{background:#e7f0e7}
      .analysis-disclosure[open] .analysis-disclosure-summary{border-bottom:1px solid var(--border)}
      .analysis-disclosure-body{padding:1rem}
      li.mb-2{font-size:15px}
      .related-card{border:1px solid var(--border);background:var(--bg);transition:transform .15s ease,box-shadow .15s ease}
      .related-card:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,.1);text-decoration:none}
      .related-question-grid{display:grid;grid-template-columns:1fr;gap:14px}
      @media(min-width:640px){.related-question-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
      .related-question-card{padding:16px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.72)}
      .related-question-title{font-size:1rem;margin-bottom:8px;font-weight:600;color:var(--text)}
      .related-question-card p{margin-bottom:0;font-size:15px;line-height:1.6}
      .topic-hub-links{border-top:1px solid var(--border);padding-top:14px}
      .topic-hub-label{display:block;font-size:.9rem;margin-bottom:8px;color:var(--text)}
      .topic-hub-chip-row{display:flex;flex-wrap:wrap;gap:8px}
      .topic-hub-chip{display:inline-flex;align-items:center;justify-content:center;padding:7px 12px;border:1px solid var(--border);border-radius:999px;background:var(--bg-alt);color:var(--btn-bg);font-size:13px;font-weight:400;text-decoration:none}
      .topic-hub-chip:hover{background:#e7f0e7;border-color:var(--btn-bg);color:var(--btn-bg);text-decoration:none}
      .authority-links{background:var(--bg-alt);border:1px solid var(--border);border-radius:10px;padding:14px 16px}
      .authority-links-label{font-size:13px;font-weight:400;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted);display:block;margin-bottom:10px}
      .authority-links-row{display:flex;flex-wrap:wrap;gap:8px}
      .authority-link{display:inline-flex;align-items:center;padding:6px 12px;border:1px solid var(--border);border-radius:999px;font-size:13px;font-weight:400;color:var(--btn-bg);background:#fff;text-decoration:none}
      .authority-link:hover{background:var(--bg-alt);border-color:var(--btn-bg);text-decoration:none}
      .article-evidence-map{border:1px solid var(--border);border-radius:10px;background:var(--bg-alt);padding:1.25rem}
      .evidence-map-intro{margin:0 0 .85rem;color:var(--text-muted)}
      .evidence-map-claim{margin:0 0 1rem;padding:.9rem 1rem;border-left:3px solid var(--btn-bg);background:#fff}
      .evidence-map-table-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:8px;background:#fff}
      .evidence-map-table{width:100%;min-width:640px;border-collapse:collapse;font-size:.9rem}
      .evidence-map-table th,.evidence-map-table td{padding:.85rem;vertical-align:top;text-align:left;border-bottom:1px solid var(--border)}
      .evidence-map-table thead th{background:#e7f0e7;color:var(--text);font-weight:600}
      .evidence-map-table tbody tr:last-child th,.evidence-map-table tbody tr:last-child td{border-bottom:0}
      .evidence-map-table tbody th{width:30%;font-weight:600}
      .evidence-map-accessed{display:block;margin-top:.3rem;color:var(--text-muted);font-size:.75rem;font-weight:400}
      .evidence-map-role{display:inline-flex;padding:.3rem .55rem;border:1px solid var(--border);border-radius:999px;background:var(--bg-alt);color:var(--text);font-size:.78rem;line-height:1.25}
      .evidence-map-role-independent{border-color:#9dc43a;background:#f4f8e9}
      .evidence-map-note{margin:.75rem 0 0}
      .amazon-related{background:var(--bg-alt);border:1px solid var(--border)}
      .amazon-related-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px}
      .amazon-kicker{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted)}
      .amazon-slider-shell{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:center}
      .amazon-slider-btn{display:none;align-items:center;justify-content:center;width:34px;height:34px;border:1px solid var(--border);border-radius:999px;background:#fff;color:var(--btn-bg);font-size:18px;line-height:1;cursor:pointer}
      .amazon-slider-btn:hover{border-color:var(--btn-bg);background:#f9fbf7}
      .amazon-slider-wrap{overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none}
      .amazon-slider-wrap::-webkit-scrollbar{display:none}
      .amazon-slider-track{display:flex;gap:10px;padding:2px 0 4px}
      .amazon-product-card{flex:0 0 170px;min-height:240px;display:flex;flex-direction:column;justify-content:space-between;gap:8px;padding:10px;border:1px solid var(--border);border-radius:8px;background:#fff;color:var(--btn-bg);font-size:14px;line-height:1.35;text-decoration:none;scroll-snap-align:start}
      .amazon-product-card:hover{border-color:var(--btn-bg);background:#f9fbf7;text-decoration:none}
      .amazon-product-card strong{font-size:14px;color:var(--text);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
      .amazon-product-card small{color:var(--text-muted)}
      .amazon-card-cover{height:150px;border:1px solid var(--border);border-radius:7px;background:#f9fbf7;display:flex;align-items:center;justify-content:center;overflow:hidden;color:var(--btn-bg);font-size:28px}
      .amazon-card-cover img{width:100%;height:100%;object-fit:cover;display:block}
      .amazon-card-cover-fallback{background:linear-gradient(135deg,#f9fbf7,#e7f0e7)}
      @media(min-width:768px){.amazon-slider-btn{display:inline-flex}}
      @media(max-width:767px){.amazon-slider-shell{grid-template-columns:minmax(0,1fr)}}
      .article-body-ad{margin:1.5rem 0 2rem!important}
      .article-body-ad ins.adsbygoogle{min-height:90px}
      blockquote.historical-quote{border-left:3px solid var(--btn-bg);padding-left:1rem;margin-left:.5rem;font-style:italic}
      .border{border:1px solid var(--border)!important;box-shadow:none}
      .shadow-sm{box-shadow:none!important}
      .btn-outline-primary{color:var(--text-muted);border-color:var(--border);background:var(--bg)}
      .btn-outline-primary:hover{border-color:var(--btn-bg);color:var(--text);background:var(--bg-alt)}
      #read-progress{position:fixed;top:0;left:0;height:3px;width:0%;background:var(--btn-bg);z-index:9999;transition:width .1s linear;pointer-events:none}
      button#chatbotToggle,#chatbotWindow{display:none!important}
      .site-btn{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border:1.5px solid var(--border);border-radius:8px;font-size:15px;font-weight:400;text-decoration:none;color:var(--text);background:transparent;cursor:pointer;transition:background .15s,border-color .15s,color .15s;user-select:none}
      .site-btn:hover{border-color:var(--btn-bg);background:var(--bg-alt)}
      .site-btn-primary{border-color:var(--btn-bg);color:var(--text)}
      .site-btn-primary:hover{background:var(--bg-alt);border-color:var(--btn-hover);color:var(--text)}
      .site-table{width:100%;max-width:480px;border-collapse:collapse;border:1.5px solid var(--border);border-radius:10px;overflow:hidden;margin-top:1rem;margin-bottom:1.5rem;font-size:.9rem}
      .site-table th,.site-table td{padding:8px 14px;border-bottom:1px solid var(--border);text-align:left;color:var(--text)}
      .site-table tr:last-child th,.site-table tr:last-child td{border-bottom:none}
      .site-table th{background:var(--bg-alt);font-weight:600;white-space:nowrap;width:40%}
      .ai-answer-card{position:relative;z-index:1;clear:both;background:#fff;border:0;padding:0;font-size:15px}
      .ai-answer-card p{margin-bottom:.75rem;font-size:15px}
      .ai-answer-kicker{display:none!important}
      .ai-answer-grid{display:grid;grid-template-columns:1fr;gap:10px;margin-top:14px}
      @media(min-width:640px){.ai-answer-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
      .ai-answer-item{display:flex;flex-direction:column;gap:3px;padding:10px 12px;background:rgba(255,255,255,.65);border:1px solid rgba(27,58,45,.08);border-radius:10px;font-size:15px}
      .ai-answer-item strong{font-size:.74rem;letter-spacing:.03em;text-transform:uppercase;color:var(--text-muted)}
      .tdq-cta-sub{color:var(--text-muted)}
      ${ARTICLE_HERO_CSS}
      ${BLOG_NAV_WIDTH_FIX_CSS}
      ${NAV_CSS}
      ${FOOTER_CSS}
    </style>
  </head>
  <body>

  <div id="read-progress" role="progressbar" aria-label="Reading progress" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"></div>
  ${staticNavMountMarkup({ includeMarquee: true, supportPopup: true })}

  <main class="container my-5">
    <div class="row justify-content-center">
      <div class="col-lg-10 col-xl-8">
        <!-- Breadcrumb -->
        <nav aria-label="breadcrumb" class="mb-3">
          <ol class="breadcrumb">
            <li class="breadcrumb-item"><a href="/">Home</a></li>
            <li class="breadcrumb-item"><a href="/blog/">Blog</a></li>
            <li class="breadcrumb-item active" aria-current="page">${esc(c.eventTitle)}</li>
          </ol>
        </nav>

        <div class="article-hero-wrap article-hero-standalone">
          <header class="mb-4 text-center article-hero-header">
            <h1 class="mb-2 fw-bold">${esc(publicTitle)}</h1>
            <p class="article-meta mb-0">
              <small>
                Published: ${esc(publishedStr)} &nbsp;|&nbsp;
                Event Date: ${esc(c.historicalDate)} &nbsp;|&nbsp;
                By <a href="/about/editorial/" rel="author" style="color:inherit">thisDay. Editorial Team</a>${readingTime}
              </small>
            </p>
            ${pillarPills}
          </header>
          ${featuredImageUrl ? `<figure class="text-center mb-4 article-hero-fig">
            <img
              src="/image-proxy?src=${encodeURIComponent(featuredImageUrl)}&w=800&q=85"
              srcset="/image-proxy?src=${encodeURIComponent(featuredImageUrl)}&w=400 400w, /image-proxy?src=${encodeURIComponent(featuredImageUrl)}&w=800 800w"
              sizes="(max-width:640px) 100vw, 800px"
              class="img-fluid rounded"
              alt="${esc(c.imageAlt)}"
              style="max-height: 400px; object-fit: cover; object-position: center; width: 100%"
              loading="eager"
              onerror="this.onerror=null;this.removeAttribute('srcset');this.src='${esc(featuredImageUrl)}';"
            />
            <figcaption class="article-meta mt-2">
              <small>Image courtesy of <a href="https://commons.wikimedia.org/" target="_blank" rel="noopener noreferrer">Wikimedia Commons</a>.</small>
            </figcaption>
          </figure>
          <div class="article-hero-overlay" aria-hidden="true"></div>` : ""}
        </div>

        <article class="p-4 rounded border" style="background-color: var(--bg); color: var(--text)">

          ${buildArticleAnswerBlock(c)}

          <!-- Did You Know -->
          ${didYouKnowSlider}

          <!-- Overview -->
          ${
            overviewParas
              ? `<section class="mt-4" style="overflow:hidden;">
            <h2 class="h3">${esc(sectionHeadings.overview)}</h2>
${overviewParas}
          </section>`
              : ""
          }

          ${evidenceMapBlock}

          ${amazonRelatedBlock}
          ${articleBodyAdBlock}

          <!-- Eyewitness / Chronicle Accounts -->
          ${
            eyewitnessParas
              ? `<section class="mt-5">
            <h2 class="h3">${esc(sectionHeadings.eyewitness)}</h2>
${eyewitnessParas}
${eyewitnessQuoteBlock}
          </section>`
              : ""
          }

          <!-- YouTube -->
          <div class="my-4 p-4 rounded" style="background:#ff0000;color:#fff;">
            <div style="font-weight:700;font-size:1.05rem;margin-bottom:4px">Watch on YouTube</div>
            <div style="font-size:0.88rem;opacity:0.9;margin-bottom:10px">
              Find documentaries and videos about: ${esc(c.eventTitle)}
            </div>
            <a
              href="https://www.youtube.com/results?search_query=${encodeURIComponent(c.youtubeSearchQuery || c.eventTitle)}"
              target="_blank"
              rel="noopener noreferrer"
              style="display:inline-block;background:#fff;color:#ff0000;font-weight:700;padding:6px 16px;border-radius:4px;text-decoration:none;font-size:0.9rem;"
            >Search Videos</a>
          </div>

          ${buildTimelineBlock(c)}

          <!-- Aftermath -->
          ${
            aftermathParas
              ? `<section class="mt-5">
            <h2 class="h3">${esc(sectionHeadings.aftermath)}</h2>
${aftermathParas}
          </section>`
              : ""
          }

          <!-- Conclusion -->
          ${
            conclusionParas
              ? `<section class="mt-5">
            <h2 class="h3">${esc(sectionHeadings.legacy)}</h2>
${conclusionParas}
          </section>`
              : ""
          }

          <!-- Personal Analysis -->
          ${bookCoverUrl && c.bookSearchQuery ? `<!-- Free Library Reading -->
          <div class="mt-3 p-3 rounded" style="background-color: rgba(0,0,0,0.04); border: 1px solid rgba(0,0,0,0.08); display:flex; align-items:flex-start; gap:14px;">
            <a href="https://openlibrary.org/search?q=${encodeURIComponent(c.bookSearchQuery)}&mode=books" target="_blank" rel="noopener noreferrer" style="flex-shrink:0;">
              <img src="${esc(bookCoverUrl)}" alt="Book cover" loading="lazy" style="width:60px;height:auto;border-radius:4px;display:block;">
            </a>
            <div>
              <strong style="font-size:0.9rem;">Free library reading</strong><br>
              <small class="article-meta">You can also browse free digital editions and catalog records at
                <a href="https://openlibrary.org/search?q=${encodeURIComponent(c.bookSearchQuery)}&mode=books" target="_blank" rel="noopener noreferrer">Open Library</a>.
              </small>
            </div>
          </div>` : ""}
          ${
            analysisGoodItems || analysisBadItems
              ? `<section class="article-analysis mt-5" style="margin-top:2rem!important">
            <h2 class="h3">${esc(analysisHeading)}</h2>
            <details class="analysis-disclosure mt-2">
              <summary class="analysis-disclosure-summary">What the evidence supports and leaves unresolved</summary>
              <div class="analysis-disclosure-body">
                <p class="article-meta mb-3">The overview above gives the factual narrative. This optional section separates interpretation from the documented record.</p>
                <div class="row g-3 mt-1">
              <div class="col-md-6">
                <div class="analysis-good p-3 rounded h-100">
                  <h3 style="color:#16a34a">What the record supports</h3>
                  <ul class="mb-0">
${analysisGoodItems}
                  </ul>
                </div>
              </div>
              <div class="col-md-6">
                <div class="analysis-bad p-3 rounded h-100">
                  <h3 style="color:#b45309">Limits and unresolved questions</h3>
                  <ul class="mb-0">
${analysisBadItems}
                  </ul>
                </div>
              </div>
                </div>
                ${editorialNote}
              </div>
            </details>
          </section>`
              : ""
          }

          ${(() => {
            // A shared broad pillar is only a tie-breaker. A card is eligible
            // only when hubs, named terms, or at least two topical terms overlap.
            // Empty slots remain empty instead of being padded with recent posts.
            const related = selectTopicallyRelatedPosts(
              c,
              allPosts,
              slug,
              currentPillars,
              3,
            );
            const cards = related
              .map((p) => {
                const relatedImageUrl = isProxyableArticleImageUrl(p.imageUrl) ? p.imageUrl : "";
                const thumb = relatedImageUrl
                  ? `<img src="/image-proxy?src=${encodeURIComponent(relatedImageUrl)}&w=80&q=75" alt="${esc(p.title)}" width="56" height="56" style="width:56px;height:56px;object-fit:cover;border-radius:8px;flex-shrink:0" loading="lazy"/>`
                  : `<div style="width:56px;height:56px;border-radius:8px;flex-shrink:0;background:var(--border,#cfe0cf);display:flex;align-items:center;justify-content:center"><i class="bi bi-clock-history" style="color:var(--text-muted,#5c7a65);font-size:1.2rem"></i></div>`;
                return `
              <div class="col-12 col-md-4">
                <a href="/blog/${esc(p.slug)}/" class="related-card d-flex align-items-center gap-2 p-3 rounded text-decoration-none h-100">
                  ${thumb}
                  <div style="min-width:0">
                    <p class="mb-0 fw-semibold" style="color:var(--text,#1a2e20);font-size:.88rem;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${esc(p.title)}</p>
                    <small class="article-meta">${new Date(p.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</small>
                  </div>
                </a>
              </div>`;
              })
              .join("");
            const relatedSection = related.length > 0
              ? `<section class="mt-5">
            <h2 class="h5 mb-3">You Might Also Like</h2>
            <div class="row g-3">${cards}
            </div>
          </section>`
              : "";
            return `<!-- Quiz CTA -->
          <div class="authority-links mt-4">
            <span class="authority-links-label">Test Your Knowledge</span>
            <p style="font-size:15px;margin:0 0 10px">Can you answer 5 questions about this event?</p>
            <div class="authority-links-row">
              <a class="authority-link" id="tdq-cta-btn" href="/quiz/" onclick="event.preventDefault();document.getElementById('tdq-overlay').style.display='block';document.getElementById('tdq-popup').style.display='block';requestAnimationFrame(function(){document.getElementById('tdq-popup').classList.add('tdq-popup-open');});document.body.style.overflow='hidden';if(typeof maybeLoadAndShowQuiz==='function')maybeLoadAndShowQuiz();">Take the Quiz <i class="bi bi-arrow-right ms-1"></i></a>
            </div>
          </div>
          ${buildAuthorityLinksBlock(c, currentPillars)}
          ${relatedSection}`;
          })()}

          ${buildArticleRelatedQuestionsBlock(c, currentPillars)}

          ${buildArticleProcessDisclosure()}

          <footer class="text-center mt-4 pt-3 border-top">
            <small class="article-meta">
              Part of the <strong>thisDay.</strong> historical blog archive &mdash;
              <a href="/blog/">Browse more posts</a> &bull;
              <a href="/blog/">All posts</a>
            </small>
          </footer>

        </article>

        <div class="ad-unit-container">
          <span class="ad-unit-label">Advertisement</span>
          <ins class="adsbygoogle"
               style="display:block"
               data-ad-client="ca-pub-8565025017387209"
               data-ad-slot="9477779891"
               data-ad-format="auto"
               data-full-width-responsive="true"></ins>
        </div>
        <div class="ad-unit-container mt-4">
          <span class="ad-unit-label">Advertisement</span>
          <ins class="adsbygoogle"
               style="display:block"
               data-ad-format="autorelaxed"
               data-ad-client="ca-pub-8565025017387209"
               data-ad-slot="9183511632"></ins>
        </div>
      </div>
    </div>
  </main>


  ${siteFooter()}

  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
  <script src="/js/script.js"></script>
  <script>
    ${footerYearScript()}
  </script>

  <!-- Google Ads: 60 Seconds on Site -->
  <script>
    (function () {
      var fired = false, timer = null;
      function fireConversion() {
        if (fired) return; fired = true;
        gtag("event", "conversion", { send_to: "AW-17262488503/pnJhCPrptfsbELfXsqdA" });
      }
      function startTimer() { if (!timer) timer = setTimeout(fireConversion, 60000); }
      function stopTimer()  { if (timer) { clearTimeout(timer); timer = null; } }
      document.addEventListener("visibilitychange", () => document.hidden ? stopTimer() : (!fired && startTimer()));
      if (!document.hidden) startTimer();
    })();
  </script>

  <!-- Quiz popup: load quiz data and show after scroll to bottom -->
  <div id="tdq-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9998" aria-hidden="true"></div>
  <div id="tdq-popup" role="dialog" aria-modal="true" aria-label="History Quiz" style="display:none;position:fixed;bottom:0;left:0;right:0;z-index:9999;max-height:90dvh;overflow-y:auto;background:var(--bg,#fff);border-radius:16px 16px 0 0;padding:0 0 32px;box-shadow:0 -4px 32px rgba(0,0,0,.18);font-family:Lora,serif">
    <div id="tdq-header" style="position:sticky;top:0;z-index:1;background:var(--bg,#fff);border-radius:16px 16px 0 0;border-bottom:1px solid var(--border,#cfe0cf);padding:12px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px">
      <div id="tdq-topic" style="font-size:.72rem;font-weight:700;color:var(--accent,#9dc43a);text-transform:uppercase;letter-spacing:.06em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>
      <button id="tdq-close" aria-label="Close quiz" style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:var(--text-muted,#5c7a65);line-height:1;flex-shrink:0">&times;</button>
    </div>
    <div style="padding:16px 20px 0">
      <h3 style="font-size:1.1rem;font-weight:700;margin-bottom:3px;color:var(--text,#1a2e20)"><i class="bi bi-patch-question-fill me-2" style="color:var(--accent,#9dc43a)"></i>Test Your Knowledge</h3>
      <p style="font-size:.85rem;color:var(--text-muted,#5c7a65);margin-bottom:6px;opacity:.8">Based on the article you just read — 5 questions, under a minute.</p>
      <div id="tdq-progress" style="font-size:.78rem;font-weight:600;color:var(--accent,#9dc43a);margin-bottom:16px">0 of 5 answered</div>
      <div id="tdq-questions"></div>
      <div id="tdq-score" class="mt-3" hidden></div>
    </div>
  </div>

  <div id="tdq-sentinel" style="height:1px"></div>

  <!-- Floating quiz bar — slides up when user reaches Eyewitness section -->
  <style>
    #tdq-float-bar{position:fixed;bottom:0;left:0;right:0;z-index:1020;background:#fff;backdrop-filter:blur(4px);box-shadow:0 -2px 16px rgba(27,58,45,.15);transform:translateY(100%);transition:transform .35s cubic-bezier(.22,.61,.36,1);padding:10px 16px;padding-bottom:max(10px,env(safe-area-inset-bottom));display:flex;align-items:center;justify-content:center}
    #tdq-float-bar.tdq-float-visible{transform:translateY(0)}
    #tdq-float-btn{background:#1a3a2d;border:none;border-radius:100px;color:#fff;font-weight:700;font-size:.95rem;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;padding:11px 28px;box-shadow:0 2px 12px rgba(26,58,45,.25);max-width:320px;width:100%}
    #tdq-float-btn:hover{background:#1a3a2d;box-shadow:0 2px 16px rgba(26,58,45,.35)}
  </style>
  <div id="tdq-float-bar">
    <button id="tdq-float-btn">
      <i class="bi bi-patch-question-fill"></i> Quiz This Day
    </button>
  </div>
  <script>
  (function(){
    var bar=document.getElementById('tdq-float-bar');
    var btn=document.getElementById('tdq-float-btn');
    var closeBtn=document.getElementById('tdq-close');
    if(!bar||!btn)return;
    function showBar(){bar.classList.add('tdq-float-visible');}
    function hideBar(){bar.classList.remove('tdq-float-visible');}
    btn.addEventListener('click',function(){
      hideBar();
      var overlay=document.getElementById('tdq-overlay');
      var popup=document.getElementById('tdq-popup');
      if(overlay)overlay.style.display='block';
      if(popup){popup.style.display='block';requestAnimationFrame(function(){popup.classList.add('tdq-popup-open');});}
      document.body.style.overflow='hidden';
      if(typeof maybeLoadAndShowQuiz==='function')maybeLoadAndShowQuiz();
    });
    if(closeBtn)closeBtn.addEventListener('click',function(){setTimeout(showBar,300);});
    // Trigger: show/hide bar based on Eyewitness heading scroll position
    var h2s=document.querySelectorAll('h2');
    var trigger=null;
    for(var i=0;i<h2s.length;i++){if(h2s[i].textContent.indexOf('Eyewitness')!==-1){trigger=h2s[i];break;}}
    if(trigger){
      function updateBar(){var rect=trigger.getBoundingClientRect();if(rect.top<window.innerHeight){showBar();}else{hideBar();}}
      window.addEventListener('scroll',updateBar,{passive:true});
    } else {
      document.addEventListener('scroll',function onScroll(){
        var d=document.documentElement;
        var total=d.scrollHeight-d.clientHeight;
        if(total>0&&d.scrollTop/total>0.35){showBar();document.removeEventListener('scroll',onScroll);}
      },{passive:true});
    }
  })();
  </script>

  <style>
    .tdq-question{margin-bottom:16px;display:none}.tdq-question.tdq-q-active{display:block}
    @keyframes tdq-slide-in{from{opacity:0;transform:translateX(28px)}to{opacity:1;transform:translateX(0)}}
    .tdq-q-enter{animation:tdq-slide-in .22s ease forwards}
    @keyframes tdq-pulse-in{0%{background:rgba(0,0,0,.05)}60%{background:rgba(0,0,0,.03)}100%{background:transparent}}
    .tdq-q-pulse{animation:tdq-pulse-in .6s ease forwards}
    @media(prefers-reduced-motion:reduce){.tdq-q-pulse,.tdq-q-enter{animation:none;transition:none}}
    .tdq-q-text{font-weight:600;margin-bottom:8px;font-size:.9rem;color:var(--text,#1a2e20)}.tdq-options{display:flex;flex-direction:column;gap:7px}
    .tdq-opt{display:flex;align-items:center;gap:9px;padding:8px 12px;border:1.5px solid var(--border,#cfe0cf);border-radius:8px;cursor:pointer;font-size:.88rem;transition:background .15s,border-color .15s;user-select:none;color:var(--text,#1a2e20)}
    .tdq-opt:hover{border-color:var(--accent,#9dc43a);background:rgba(157,196,58,.07)}.tdq-opt-selected{border-color:var(--accent,#9dc43a)!important;background:rgba(157,196,58,.15)!important;font-weight:500}
    .tdq-opt-correct{border-color:#10b981!important;background:#d1fae5!important;color:#0f172a!important}.tdq-opt-wrong{border-color:#ef4444!important;background:#fee2e2!important;color:#0f172a!important}
    .tdq-opt-key{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:var(--border,#cfe0cf);font-size:.72rem;font-weight:700;flex-shrink:0}
    .tdq-opt-selected .tdq-opt-key{background:var(--btn-bg,#1b3a2d);color:#fff}.tdq-opt-correct .tdq-opt-key{background:#10b981;color:#fff}.tdq-opt-wrong .tdq-opt-key{background:#ef4444;color:#fff}
    .tdq-feedback{font-size:.82rem;margin-top:4px}.tdq-correct{color:#10b981;font-weight:600}.tdq-wrong{color:#ef4444;font-weight:600}
    .tdq-next-btn{width:100%;margin-top:14px;padding:11px;border:none;border-radius:8px;background:var(--btn-bg,#1b3a2d);color:var(--btn-text,#fff);font-weight:700;font-size:.95rem;cursor:pointer;display:none;transition:background .15s}
    .tdq-next-btn:hover{background:var(--btn-hover,#2a4d3a)}
    .tdq-score-box{font-size:1rem;font-weight:600;padding:12px 14px;background:rgba(157,196,58,.1);border-radius:8px;border-left:4px solid var(--accent,#9dc43a)}.tdq-score-num{color:var(--accent,#9dc43a);font-size:1.15rem}
    #tdq-popup{transition:transform .3s ease;transform:translateY(100%);scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.2) transparent}.tdq-popup-open{transform:translateY(0)!important}
    #tdq-popup::-webkit-scrollbar{width:4px}#tdq-popup::-webkit-scrollbar-thumb{background:rgba(0,0,0,.2);border-radius:4px}
  </style>

  <script>
  (function () {
    var slug = "${esc(slug)}";
    var quizLoaded = false;
    var selected = {};
    var answers = [];

    function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

    function openPopup() {
      var popup = document.getElementById("tdq-popup");
      document.getElementById("tdq-overlay").style.display = "block";
      popup.scrollTop = 0;
      popup.style.display = "block";
      requestAnimationFrame(function() { popup.classList.add("tdq-popup-open"); });
      document.body.style.overflow = "hidden";
      // After slide-up animation: ensure scroll at top and pulse active question for attention
      setTimeout(function() {
        popup.scrollTop = 0;
        var activeQ = popup.querySelector(".tdq-q-active") || popup.querySelector(".tdq-question");
        if (activeQ) { activeQ.classList.add("tdq-q-pulse"); setTimeout(function(){ activeQ.classList.remove("tdq-q-pulse"); }, 650); }
      }, 380);
    }

    function closePopup() {
      var popup = document.getElementById("tdq-popup");
      popup.classList.remove("tdq-popup-open");
      setTimeout(function() {
        popup.style.display = "none";
        document.getElementById("tdq-overlay").style.display = "none";
        document.body.style.overflow = "";
      }, 300);
    }

    document.getElementById("tdq-close").addEventListener("click", closePopup);
    document.getElementById("tdq-overlay").addEventListener("click", closePopup);

    var currentQ = 0;

    function showQuestion(qi, animate) {
      var popup = document.getElementById("tdq-popup");
      var container = document.getElementById("tdq-questions");
      container.querySelectorAll(".tdq-question").forEach(function(el) { el.classList.remove("tdq-q-active", "tdq-q-enter"); });
      var qEl = document.getElementById("tdq-q-" + qi);
      if (!qEl) return;
      qEl.classList.add("tdq-q-active");
      if (animate) { void qEl.offsetWidth; qEl.classList.add("tdq-q-enter"); }
      if (popup) { setTimeout(function(){ popup.scrollTop = 0; }, 30); }
    }

    function prevDayUrl() {
      var m = slug.match(/^(\d+)-([a-z]+)-(\d+)$/i);
      if (!m) return "/blog/";
      var months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
      var idx = months.indexOf(m[2].toLowerCase());
      if (idx < 0) return "/blog/";
      var d = new Date(parseInt(m[3]), idx, parseInt(m[1]));
      d.setDate(d.getDate() - 1);
      return "/blog/" + d.getDate() + "-" + months[d.getMonth()] + "-" + d.getFullYear() + "/";
    }

    function renderQuiz(quiz) {
      answers = quiz.questions.map(function(q) { return Number(q.answer); });
      var total = quiz.questions.length;
      var topicEl = document.getElementById("tdq-topic");
      if (topicEl) { var h1 = document.querySelector("h1"); if (h1) topicEl.textContent = "Quiz: " + h1.textContent.trim(); }
      var container = document.getElementById("tdq-questions");
      container.innerHTML = quiz.questions.map(function(q, qi) {
        var optsHtml = (q.options || []).map(function(opt, oi) {
          return '<div class="tdq-opt" data-qi="' + qi + '" data-oi="' + oi + '">' +
            '<span class="tdq-opt-key">' + String.fromCharCode(65 + oi) + '</span>' + esc(String(opt)) + '</div>';
        }).join("");
        var isLast = qi === total - 1;
        var nextLabel = isLast ? '<i class="bi bi-check2-circle me-1"></i>See Results' : 'Next Question <i class="bi bi-arrow-right ms-1"></i>';
        var expHtml = q.explanation
          ? '<div class="tdq-explanation" id="tdq-e-' + qi + '" hidden style="font-size:.82rem;margin-top:6px;padding:7px 11px;background:rgba(0,0,0,.035);border-left:3px solid var(--btn-bg,#1b3a2d);border-radius:0 6px 6px 0">' + esc(String(q.explanation)) + '</div>'
          : '';
        return '<div class="tdq-question" id="tdq-q-' + qi + '">' +
          '<p class="tdq-q-text"><strong>' + (qi + 1) + ' / ' + total + '.</strong> ' + esc(String(q.q)) + '</p>' +
          '<div class="tdq-options">' + optsHtml + '</div>' +
          '<div class="tdq-feedback" id="tdq-f-' + qi + '" hidden></div>' +
          expHtml +
          '<button class="tdq-next-btn" id="tdq-next-' + qi + '">' + nextLabel + '</button>' +
          '</div>';
      }).join("");

      // Show first question
      currentQ = 0;
      showQuestion(0, false);
      var progEl = document.getElementById("tdq-progress");
      if (progEl) progEl.textContent = "1 of " + total;

      container.querySelectorAll(".tdq-opt").forEach(function(opt) {
        opt.addEventListener("click", function() {
          var qi = parseInt(this.dataset.qi), oi = parseInt(this.dataset.oi);
          if (qi !== currentQ) return; // only active question
          selected[qi] = oi;
          container.querySelectorAll('[data-qi="' + qi + '"]').forEach(function(o) { o.classList.remove("tdq-opt-selected"); });
          this.classList.add("tdq-opt-selected");
          // Show next button and scroll to it
          var nextBtn = document.getElementById("tdq-next-" + qi);
          if (nextBtn) {
            nextBtn.style.display = "block";
            var popup = document.getElementById("tdq-popup");
            setTimeout(function() {
              if (nextBtn) {
                nextBtn.scrollIntoView({ behavior: "smooth", block: "nearest" });
              }
            }, 160);
          }
        });
      });

      // Next button handlers
      for (var qi = 0; qi < total; qi++) {
        (function(qi) {
          var nextBtn = document.getElementById("tdq-next-" + qi);
          if (!nextBtn) return;
          nextBtn.addEventListener("click", function() {
            var isLast = qi === total - 1;
            if (isLast) {
              showResults(total);
            } else {
              currentQ = qi + 1;
              var progEl = document.getElementById("tdq-progress");
              if (progEl) progEl.textContent = (currentQ + 1) + " of " + total;
              showQuestion(currentQ, true);
            }
          });
        })(qi);
      }
    }

    function showResults(total) {
      var score = 0;
      answers.forEach(function(correct, qi) {
        var chosen = selected[qi] !== undefined ? selected[qi] : -1;
        var fb = document.getElementById("tdq-f-" + qi);
        var opts = document.querySelectorAll('[data-qi="' + qi + '"]');
        if (fb) fb.hidden = false;
        opts.forEach(function(o) { o.style.pointerEvents = "none"; });
        if (opts[correct]) opts[correct].classList.add("tdq-opt-correct");
        if (chosen === correct) {
          score++;
          if (fb) fb.innerHTML = '<span class="tdq-correct">✓ Correct!</span>';
        } else {
          if (chosen >= 0 && opts[chosen]) opts[chosen].classList.add("tdq-opt-wrong");
          if (fb) fb.innerHTML = '<span class="tdq-wrong">✗ Incorrect.</span> Correct: <strong>' + String.fromCharCode(65 + correct) + '</strong>';
        }
        var exp = document.getElementById("tdq-e-" + qi);
        if (exp) exp.hidden = false;
        // Show all questions for results view
        var qEl = document.getElementById("tdq-q-" + qi);
        if (qEl) { qEl.classList.add("tdq-q-active"); var nb = document.getElementById("tdq-next-" + qi); if (nb) nb.style.display = "none"; }
      });
      var pct = Math.round(score / total * 100);
      var msg = pct === 100 ? "Perfect score!" : pct >= 80 ? "Excellent!" : pct >= 60 ? "Good job!" : "Keep learning!";
      var el = document.getElementById("tdq-score");
      el.hidden = false;
      el.innerHTML = '<div class="tdq-score-box">You scored <span class="tdq-score-num">' + score + "/" + total + '</span> (' + pct + '%) — ' + msg + '</div>' +
        '<a href="' + prevDayUrl() + '" class="btn btn-outline-primary w-100 mt-3"><i class="bi bi-arrow-left me-1"></i>Previous Day&#39;s Story</a>';
      var popup = document.getElementById("tdq-popup");
      if (popup) { setTimeout(function(){ popup.scrollTop = 0; }, 30); }
      var progEl = document.getElementById("tdq-progress");
      if (progEl) progEl.textContent = "Results — " + score + "/" + total + " correct";
    }

    function maybeLoadAndShow() {
      if (quizLoaded) return;
      quizLoaded = true;
      if (window.__tdqQuiz) { var q = window.__tdqQuiz; window.__tdqQuiz = null; renderQuiz(q); openPopup(); return; }
      fetch("/blog/quiz/" + slug)
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(quiz) {
          if (!quiz || !quiz.questions || quiz.questions.length < 3) return;
          renderQuiz(quiz);
          openPopup();
        })
        .catch(function() { /* quiz unavailable, silently skip */ });
    }
    // Expose so the CTA button / floating bar can trigger it; re-opens if already loaded
    window.maybeLoadAndShowQuiz = function(){if(quizLoaded){openPopup();}else{maybeLoadAndShow();}};

    // Auto-open if deep-linked with #quiz hash
    if (window.location.hash === "#quiz") {
      setTimeout(maybeLoadAndShow, 600);
    }

    if ("IntersectionObserver" in window) {
      var sentinel = document.getElementById("tdq-sentinel");
      var obs = new IntersectionObserver(function(entries) {
        if (entries[0].isIntersecting) { obs.disconnect(); setTimeout(maybeLoadAndShow, 800); }
      }, { threshold: 1.0 });
      obs.observe(sentinel);
    }
  })();
  </script>
  <script>
  (function(){
    var bar=document.getElementById('read-progress');
    if(!bar)return;
    document.addEventListener('scroll',function(){
      var doc=document.documentElement;
      var total=doc.scrollHeight-doc.clientHeight;
      var pct=total>0?Math.round((doc.scrollTop/total)*100):0;
      bar.style.width=pct+'%';
      bar.setAttribute('aria-valuenow',pct);
    },{passive:true});
  })();
  </script>
  <script>
  (function(){
    if(location.hostname!=='thisday.info'&&location.hostname!=='www.thisday.info')return;
    var units=document.querySelectorAll('ins.adsbygoogle');
    if(!units.length)return;
    function pushIns(ins){if(ins.getAttribute('data-adsbygoogle-status')||ins.getAttribute('data-ad-pushed'))return;if(ins.offsetWidth===0)return;ins.setAttribute('data-ad-pushed','1');try{(adsbygoogle=window.adsbygoogle||[]).push({});}catch(e){}}
    if('IntersectionObserver' in window){
      var io=new IntersectionObserver(function(entries,obs){entries.forEach(function(e){if(e.isIntersecting){pushIns(e.target);obs.unobserve(e.target);}});},{threshold:0.1});
      units.forEach(function(ins){io.observe(ins);});
    } else { units.forEach(pushIns); }
  })();
  </script>
${supportPopupSnippet()}
</body>
</html>`;
}

/**
 * Builds the canonical /blog/ listing page.
 */
async function buildListingHTML(index) {
  const postItems = index.length
    ? index
        .map((entry) => renderBlogPostListItem(entry))
        .join("\n")
    : '<p class="text-muted">No AI-generated posts yet. Check back soon!</p>';

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>History Blog | thisDay. — Articles on Historical Events</title>
    <link rel="canonical" href="https://thisday.info/blog/" />
    <meta name="robots" content="index, follow" />
    <meta name="author" content="thisDay. Editorial" />
    <meta name="description" content="Original articles about historical events published regularly by thisDay.info." />
    <meta property="og:title" content="History Blog | thisDay." />
    <meta property="og:description" content="In-depth articles about the events, people, and moments that shaped world history." />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="https://thisday.info/blog/" />
    <meta property="og:image" content="https://thisday.info/images/logo.png" />
    <meta property="og:locale" content="en_US" />
    <meta property="og:site_name" content="thisDay." />
    <meta name="twitter:card" content="summary_large_image"/>
    <meta name="twitter:title" content="History Blog | thisDay."/>
    <meta name="twitter:description" content="In-depth articles covering historical events published regularly by thisDay.info."/>
    <meta name="twitter:image" content="https://thisday.info/images/logo.png"/>

    <!-- JSON-LD -->
    <script type="application/ld+json">
${JSON.stringify(
  {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "History Blog | thisDay.",
    url: "https://thisday.info/blog/",
    description:
      "Original articles about historical events published regularly by thisDay.info.",
    publisher: {
      "@type": "Organization",
      name: "thisDay.info",
      logo: {
        "@type": "ImageObject",
        url: "https://thisday.info/images/logo.png",
      },
    },
    hasPart: index.slice(0, 20).map((p) => ({
      "@type": "BlogPosting",
      name: p.title,
      url: `https://thisday.info/blog/${p.slug}/`,
      datePublished: p.publishedAt
        ? new Date(p.publishedAt).toISOString().split("T")[0]
        : undefined,
      description: p.description,
    })),
  },
  null,
  2,
)}
    </script>

    <link rel="icon" href="/images/favicon.ico" />
    <link rel="apple-touch-icon" href="/images/apple-touch-icon.png" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" />
    <link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/css/style.css?v=8" />
    <link rel="stylesheet" href="/css/custom.css?v=33" />
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-WXEZ3868VN"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag() { dataLayer.push(arguments); }
      gtag("js", new Date()); gtag("config", "G-WXEZ3868VN");
    </script>
    <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8565025017387209" crossorigin="anonymous"></script>
    <style>
      :root{--bg:#ffffff;--bg-alt:#f2f7f2;--text:#1a2e20;--text-muted:#5c7a65;--border:#cfe0cf;--btn-bg:#1b3a2d;--btn-text:#fff;--btn-hover:#2a4d3a;--accent:#9dc43a;--radius:4px;--shadow:0 16px 32px -8px rgba(27,58,45,.08)}
      body{font-family:Lora,serif;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--text)}
      main{flex:1;padding:20px 0}
      h1,h2,h3{color:var(--text)}
      a{color:var(--btn-bg);text-decoration:none}a:hover{text-decoration:underline}
      .blog-post-link{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border:1px solid var(--border);border-radius:8px;background-color:var(--bg);text-decoration:none;color:var(--text);transition:transform .15s ease,box-shadow .15s ease;margin-bottom:10px}
      .blog-post-link:hover{transform:translateX(4px);box-shadow:0 3px 12px rgba(0,0,0,.08);text-decoration:none;color:var(--text)}
      .post-thumb{width:108px;height:78px;object-fit:cover;object-position:top;border-radius:8px;flex-shrink:0;background:rgba(0,0,0,.06)}
      .post-thumb-placeholder{width:108px;height:78px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:rgba(0,0,0,.06);color:var(--btn-bg);font-size:1.15rem}
      .post-copy{min-width:0}
      .post-title{font-weight:600;font-size:.95rem;line-height:1.4;color:var(--btn-bg)}
      .post-pillars{margin:.35rem 0 .2rem}
      .post-pillar-badge{display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;background:var(--bg-alt);border:1px solid var(--border);color:var(--btn-bg);font-size:.72rem;font-weight:700;line-height:1}
      .month-header{font-size:1.3rem;font-weight:700;color:var(--btn-bg)!important;border-bottom:2px solid var(--border);padding-bottom:6px;margin-bottom:14px}
      .ad-unit{text-align:center}
      .ad-unit-label{font-size:.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}
      ${BLOG_NAV_WIDTH_FIX_CSS}
      ${NAV_CSS}
      ${FOOTER_CSS}
    </style>
  </head>
  <body>

  ${siteNav()}

  <main class="container">
    <div class="row justify-content-center">
      <div class="col-lg-9 col-xl-7">
        <h1 class="fw-bold mb-1" style="font-size:1.8rem">History Blog</h1>
        <p class="mb-4" style="color: var(--text-muted,#5c7a65); opacity: 0.8">
          In-depth articles covering fascinating historical events published regularly by thisDay.info.
          <a href="/blog/">View all posts</a>
        </p>
        <div class="ad-unit-container">
          <span class="ad-unit-label">Advertisement</span>
          <ins class="adsbygoogle"
               style="display:block"
               data-ad-client="ca-pub-8565025017387209"
               data-ad-slot="9477779891"
               data-ad-format="auto"
               data-full-width-responsive="true"></ins>
        </div>
        <div class="month-section">
          <h2 class="month-header"><i class="bi bi-book me-2"></i>All Articles (${index.length})</h2>
          ${postItems}
        </div>

        <div class="ad-unit-container mt-4 mb-4">
          <span class="ad-unit-label">Advertisement</span>
          <ins class="adsbygoogle"
               style="display:block"
               data-ad-client="ca-pub-8565025017387209"
               data-ad-slot="9183511632"
               data-ad-format="autorelaxed"></ins>
        </div>
      </div>
    </div>
  </main>

  ${siteFooter()}

  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
  <script>
    ${footerYearScript()}
    ${navToggleScript()}
    if (location.hostname === 'thisday.info' || location.hostname === 'www.thisday.info') {
      document.querySelectorAll('ins.adsbygoogle').forEach((ins) => {
        if (!ins.getAttribute('data-adsbygoogle-status') && !ins.getAttribute('data-ad-pushed') && ins.offsetWidth > 0) {
          ins.setAttribute('data-ad-pushed', '1');
          try { (adsbygoogle = window.adsbygoogle || []).push({}); } catch {}
        }
      });
    }
  </script>
${supportPopupSnippet()}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

async function serveListing(env) {
  const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  const html = await buildListingHTML(index);
  return htmlResponse(html);
}

// ---------------------------------------------------------------------------
// Pillar hub pages — /blog/topic/:pillar-slug/
// ---------------------------------------------------------------------------

const PILLAR_DESCRIPTIONS = {
  "War & Conflict":
    "Battles, wars, sieges, and the military events that redrew maps and reshaped civilisations.",
  "Politics & Government":
    "Elections, treaties, coups, revolutions, and the political decisions that defined nations.",
  "Science & Technology":
    "Discoveries, inventions, missions, and the breakthroughs that changed how we understand the world.",
  "Arts & Culture":
    "Literature, music, art, film, and the cultural moments that left a lasting mark on society.",
  "Sports":
    "Athletes, races, records, championships, and sporting moments that shaped competition and public memory.",
  "Disasters & Accidents":
    "Natural disasters, industrial accidents, and catastrophes and the human stories behind them.",
  "Social & Human Rights":
    "Civil rights movements, protests, landmark legislation, and milestones in the fight for equality.",
  "Economy & Business":
    "Market crashes, trade revolutions, corporate milestones, and the economic forces that shaped modern life.",
  "Health & Medicine":
    "Epidemics, medical breakthroughs, public health crises, and the science that saved lives.",
  "Exploration & Discovery":
    "Expeditions, voyages, space missions, and the adventures that expanded the boundaries of the known world.",
  "Famous Persons":
    "Leaders, artists, scientists, and figures whose lives defined an era.",
  "Born on This Day": "Notable people born on this date throughout history.",
  "Died on This Day":
    "Notable people who died on this date throughout history.",
};

function toTitlePillarSlug(slugStr) {
  return (
    BLOG_PILLARS.find(
      (p) =>
        p
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, "") === slugStr,
    ) || null
  );
}

async function servePillarHub(env, slugStr, url = null) {
  const pillarName = toTitlePillarSlug(slugStr);
  if (!pillarName) return serve404(env);

  const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  const posts = getArchivePostsForPillar(index, pillarName);
  const pageIndexable = archiveCollectionIsIndexable(posts, url);
  const qualifiedPillars = BLOG_PILLARS.filter((pillar) =>
    archiveCollectionIsIndexable(getArchivePostsForPillar(index, pillar)),
  );

  const html = buildPillarHubHTML(
    pillarName,
    slugStr,
    posts,
    pageIndexable,
    qualifiedPillars,
  );
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
      ...(!pageIndexable ? { "X-Robots-Tag": "noindex, follow" } : {}),
    },
  });
}

function buildPillarHubHTML(
  pillarName,
  slugStr,
  posts,
  pageIndexable = false,
  qualifiedPillars = [],
) {
  const canonicalUrl = `https://thisday.info/blog/topic/${slugStr}/`;
  const description =
    PILLAR_DESCRIPTIONS[pillarName] ||
    `Articles about ${pillarName} on thisDay.`;
  const pageTitle = `${pillarName} — Historical Articles | thisDay.`;
  const editorialContext = archiveEditorialContext(
    pillarName,
    posts,
    "pillar",
  );

  const postItems = posts.length
    ? posts
        .map((entry) => renderBlogPostListItem(entry))
        .join("\n")
    : '<p class="text-muted">No articles in this category yet — check back soon.</p>';

  const otherPillars = qualifiedPillars
    .filter((p) => p !== pillarName)
    .map((p) => {
      const s = p
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
      return `<a href="/blog/topic/${s}/" class="badge text-decoration-none me-1 mb-1" style="background:var(--btn-bg);color:#fff;font-weight:500;font-size:.78rem;padding:.35em .7em;border-radius:20px">${esc(p)}</a>`;
    })
    .join("");
  const usablePostCount = archiveUsablePosts(posts).length;
  const editorialBlock = editorialContext
    ? `<section class="card-box mb-4 archive-editorial-context" data-archive-indexable="1" aria-labelledby="pillar-reading-path">
          <h2 class="section-header" id="pillar-reading-path">How to explore ${esc(pillarName)}</h2>
          <p>${esc(editorialContext.lead)}</p>
          <p>${esc(editorialContext.route)}</p>
          <ol class="mb-0">
            ${editorialContext.examples
              .map(
                (post) =>
                  `<li><a href="/blog/${esc(post.slug)}/">${esc(post.title)}</a>${
                    post.description
                      ? ` — ${esc(truncateForMeta(post.description, 120))}`
                      : ""
                  }</li>`,
              )
              .join("")}
          </ol>
        </section>`
    : `<section class="card-box mb-4 archive-editorial-context" data-archive-indexable="0">
          <h2 class="section-header">Collection status</h2>
          <p class="mb-0">This collection currently has ${usablePostCount} complete related article${usablePostCount === 1 ? "" : "s"}. It remains available for reader navigation while the archive grows toward ${ARCHIVE_MIN_INDEXABLE_ARTICLES} substantive entries.</p>
        </section>`;

  const jsonLd = JSON.stringify(
    {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: pageTitle,
      url: canonicalUrl,
      description,
      publisher: {
        "@type": "Organization",
        name: "thisDay.info",
        url: "https://thisday.info/",
        logo: {
          "@type": "ImageObject",
          url: "https://thisday.info/images/logo.png",
        },
      },
      hasPart: posts.slice(0, 20).map((p) => ({
        "@type": "BlogPosting",
        name: p.title,
        url: `https://thisday.info/blog/${p.slug}/`,
        datePublished: p.publishedAt
          ? new Date(p.publishedAt).toISOString().split("T")[0]
          : undefined,
        description: p.description,
      })),
    },
    null,
    2,
  );

  const breadcrumbJsonLd = JSON.stringify(
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "thisDay.",
          item: "https://thisday.info/",
        },
        {
          "@type": "ListItem",
          position: 2,
          name: "Historical Blog",
          item: "https://thisday.info/blog/",
        },
        {
          "@type": "ListItem",
          position: 3,
          name: pillarName,
          item: canonicalUrl,
        },
      ],
    },
    null,
    2,
  );

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${esc(pageTitle)}</title>
    <link rel="canonical" href="${esc(canonicalUrl)}" />
    <meta name="robots" content="${archiveRobotsDirective(pageIndexable)}" />
    <meta name="description" content="${esc(description)}" />
    <meta name="author" content="thisDay. Editorial" />
    <meta property="og:title" content="${esc(pageTitle)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${esc(canonicalUrl)}" />
    <meta property="og:image" content="https://thisday.info/images/logo.png" />
    <meta property="og:locale" content="en_US" />
    <meta property="og:site_name" content="thisDay." />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(pageTitle)}" />
    <meta name="twitter:description" content="${esc(description)}" />
    <meta name="twitter:image" content="https://thisday.info/images/logo.png" />
    <script type="application/ld+json">${jsonLd}</script>
    <script type="application/ld+json">${breadcrumbJsonLd}</script>
    <link rel="icon" href="/images/favicon.ico" />
    <link rel="apple-touch-icon" href="/images/apple-touch-icon.png" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" />
    <link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/css/style.css?v=8" />
    <link rel="stylesheet" href="/css/custom.css?v=33" />
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-WXEZ3868VN"></script>
    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag("js",new Date());gtag("config","G-WXEZ3868VN");</script>
    <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8565025017387209" crossorigin="anonymous"></script>
    <style>
      :root{--bg:#ffffff;--bg-alt:#f2f7f2;--text:#1a2e20;--text-muted:#5c7a65;--border:#cfe0cf;--btn-bg:#1b3a2d;--btn-text:#fff;--btn-hover:#2a4d3a;--accent:#9dc43a;--radius:4px;--shadow:0 16px 32px -8px rgba(27,58,45,.08)}
      body{font-family:Lora,serif;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--text)}
      main{flex:1;padding:20px 0}
      h1,h2,h3{color:var(--text)}
      a{color:var(--btn-bg);text-decoration:none}a:hover{text-decoration:underline}
      .blog-post-link{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border:1px solid var(--border);border-radius:8px;background-color:var(--bg);text-decoration:none;color:var(--text);transition:transform .15s ease,box-shadow .15s ease;margin-bottom:10px}
      .blog-post-link:hover{transform:translateX(4px);box-shadow:0 3px 12px rgba(0,0,0,.08);text-decoration:none;color:var(--text)}
      .post-thumb{width:108px;height:78px;object-fit:cover;object-position:top;border-radius:8px;flex-shrink:0;background:rgba(0,0,0,.06)}
      .post-thumb-placeholder{width:108px;height:78px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:rgba(0,0,0,.06);color:var(--btn-bg);font-size:1.15rem}
      .post-copy{min-width:0}
      .post-title{font-weight:600;font-size:.95rem;line-height:1.4;color:var(--btn-bg)}
      .post-pillars{margin:.35rem 0 .2rem}
      .post-pillar-badge{display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;background:var(--bg-alt);border:1px solid var(--border);color:var(--btn-bg);font-size:.72rem;font-weight:700;line-height:1}
      .section-header{font-size:1.3rem;font-weight:700;color:var(--btn-bg)!important;border-bottom:2px solid var(--border);padding-bottom:6px;margin-bottom:14px}
      .breadcrumb{font-size:.82rem;margin-bottom:1.2rem}
      .breadcrumb a{color:var(--text-muted)}
      ${BLOG_NAV_WIDTH_FIX_CSS}
      ${NAV_CSS}
      ${FOOTER_CSS}
    </style>
  </head>
  <body>
  ${siteNav()}

  <main class="container">
    <div class="row justify-content-center">
      <div class="col-lg-9 col-xl-7">
        <nav aria-label="breadcrumb" class="breadcrumb">
          <a href="/">thisDay.</a> &rsaquo;
          <a href="/blog/">Historical Blog</a> &rsaquo;
          <span>${esc(pillarName)}</span>
        </nav>

        <h1 class="fw-bold mb-2" style="font-size:1.8rem">${esc(pillarName)}</h1>
        <p class="mb-4" style="color:var(--text-muted,#5c7a65)">${esc(description)}</p>
        ${editorialBlock}

        <div class="ad-unit-container mb-4">
          <span class="ad-unit-label">Advertisement</span>
          <ins class="adsbygoogle"
               style="display:block;border-radius:8px;overflow:hidden"
               data-ad-client="ca-pub-8565025017387209"
               data-ad-slot="9477779891"
               data-ad-format="auto"
               data-full-width-responsive="true"></ins>
        </div>

        <div class="mb-5">
          <h2 class="section-header">
            <i class="bi bi-journals me-2"></i>Articles (${posts.length})
          </h2>
          ${postItems}
        </div>

        <div class="ad-unit-container mb-5">
          <span class="ad-unit-label">Advertisement</span>
          <ins class="adsbygoogle"
               style="display:block;border-radius:8px;overflow:hidden"
               data-ad-client="ca-pub-8565025017387209"
               data-ad-slot="9183511632"
               data-ad-format="autorelaxed"></ins>
        </div>

        ${otherPillars ? `<div class="mb-5">
          <h2 class="section-header" style="font-size:1rem">Explore Other Topics</h2>
          <div>${otherPillars}</div>
        </div>` : ""}
      </div>
    </div>
  </main>

  ${siteFooter()}
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
  <script>
    ${footerYearScript()}
    ${navToggleScript()}
    if (location.hostname === 'thisday.info' || location.hostname === 'www.thisday.info') {
      document.querySelectorAll('ins.adsbygoogle').forEach((ins) => {
        if (!ins.getAttribute('data-adsbygoogle-status') && !ins.getAttribute('data-ad-pushed') && ins.offsetWidth > 0) {
          ins.setAttribute('data-ad-pushed', '1');
          try { (adsbygoogle = window.adsbygoogle || []).push({}); } catch {}
        }
      });
    }
  </script>
  ${supportPopupSnippet()}
  </body>
</html>`;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function todayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function renderBlogPostListItem(entry) {
  const date = new Date(entry.publishedAt);
  const dateStr = `${MONTH_NAMES[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
  const rawImg = isProxyableArticleImageUrl(entry.imageUrl) ? entry.imageUrl : "";
  const proxiedImg = rawImg
    ? `/image-proxy?src=${encodeURIComponent(rawImg)}&w=240&q=80`
    : "";
  const fallbackImg = rawImg ? esc(rawImg) : "";
  const title = esc(entry.title);
  const slug = esc(entry.slug);
  const firstPillar =
    Array.isArray(entry.pillars) && entry.pillars.length > 0 ? entry.pillars[0] : null;
  const pillarBadge = firstPillar
    ? `<div class="post-pillars"><span class="post-pillar-badge">${esc(firstPillar)}</span></div>`
    : "";
  const thumbHtml = proxiedImg
    ? `<img src="${proxiedImg}" alt="${title}" class="post-thumb" loading="lazy" onerror="this.onerror=null;this.src='${fallbackImg}'">`
    : `<div class="post-thumb-placeholder"><i class="bi bi-image-alt"></i></div>`;
  return `
        <a href="/blog/${slug}/" class="blog-post-link">
          ${thumbHtml}
          <div class="post-copy">
            <div class="post-title">${title}</div>
            ${pillarBadge}
            <small style="color:var(--text-muted,#5c7a65);opacity:.7">${esc(dateStr)}</small>
          </div>
        </a>`;
}

// ---------------------------------------------------------------------------
// Smart 404 page
// ---------------------------------------------------------------------------

/**
 * Returns a styled 404 HTML response with links to the 3 most recent posts
 * from KV, giving visitors somewhere to go instead of a dead end.
 */
async function serve404(env) {
  let recentPosts = [];
  try {
    const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
    recentPosts = indexRaw ? JSON.parse(indexRaw).slice(0, 3) : [];
  } catch {
    // Suggestions are optional — don't let a KV failure block the 404 page.
  }

  const suggestions =
    recentPosts.length > 0
      ? `<h5 class="mt-5 mb-3 fw-semibold">Recent Articles</h5>
        <div class="list-group">
          ${recentPosts
            .map(
              (p) => `
          <a href="/blog/${esc(p.slug)}/" class="list-group-item list-group-item-action py-3">
            <div class="fw-semibold">${esc(p.title)}</div>
            <div class="small text-muted mt-1">${esc(p.description)}</div>
          </a>`,
            )
            .join("")}
        </div>`
      : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Page Not Found — thisDay.</title>
  <meta name="robots" content="noindex, nofollow" />
  <link rel="icon" href="/images/favicon.ico" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" />
  <link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/css/style.css" />
  <link rel="stylesheet" href="/css/custom.css" />
  <style>
    :root{--bg:#ffffff;--bg-alt:#f2f7f2;--text:#1a2e20;--text-muted:#5c7a65;--border:#cfe0cf;--btn-bg:#1b3a2d;--btn-text:#fff;--btn-hover:#2a4d3a;--accent:#9dc43a;--radius:4px;--shadow:0 16px 32px -8px rgba(27,58,45,.08)}
    body{font-family:Lora,serif;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--text)}
    main{flex:1}
    .hero-code{font-size:6rem;font-weight:700;color:var(--btn-bg);line-height:1}
    ${BLOG_NAV_WIDTH_FIX_CSS}
    ${NAV_CSS}
    ${FOOTER_CSS}
  </style>
</head>
<body>
${siteNav()}

<main class="container py-5">
  <div class="row justify-content-center">
    <div class="col-lg-7 text-center">
      <div class="hero-code">404</div>
      <h1 class="h3 mt-2 mb-3">Page Not Found</h1>
      <p class="text-muted mb-4">
        This page doesn&rsquo;t exist or may have moved.<br />
        Try the <a href="/">homepage</a> to explore today&rsquo;s events, or browse the <a href="/blog/">blog</a>.
      </p>
      <a href="/" class="btn btn-primary px-4 me-2">
        <i class="bi bi-house-door me-1"></i>Home
      </a>
      <a href="/blog/" class="btn btn-outline-secondary px-4">
        <i class="bi bi-journal-text me-1"></i>Blog
      </a>
      ${suggestions}
    </div>
  </div>
</main>

${siteFooter()}
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
<script>${navToggleScript()}${footerYearScript()}</script>
${marqueeScript()}
</body>
</html>`;

  return new Response(html, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSlug(date) {
  return `${date.getDate()}-${MONTH_SLUGS[date.getMonth()]}-${date.getFullYear()}`;
}

/**
 * Inverse of buildSlug — parses "15-march-2026" into its components.
 * Returns null if the slug doesn't match the expected format.
 */
function parseSlugDate(slug) {
  const m = slug.match(/^(\d+)-([a-z]+)-\d+$/i);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monthSlug = m[2].toLowerCase();
  const monthIndex = MONTH_SLUGS.indexOf(monthSlug);
  if (monthIndex < 0) return null;
  return { day, monthSlug, monthIndex, monthDisplay: MONTH_NAMES[monthIndex] };
}

function buildDateExploreCard(sp, thumbHtml = "") {
  if (!sp) return "";
  const monthDisplay = esc(sp.monthDisplay);
  const monthSlug = esc(sp.monthSlug);
  const day = esc(sp.day);
  const links = `<div class="authority-links-row">
      <a href="/events/${monthSlug}/${day}/" class="authority-link">Events</a>
      <a href="/born/${monthSlug}/${day}/" class="authority-link">Born</a>
      <a href="/died/${monthSlug}/${day}/" class="authority-link">Died</a>
      <a href="/quiz/${monthSlug}/${day}/" class="authority-link">Quiz</a>
    </div>`;
  const inner = thumbHtml
    ? `<div style="display:flex;align-items:flex-start;gap:12px">${thumbHtml}<div style="flex:1;min-width:0"><p style="font-size:15px;margin:0 0 10px">Jump between the main events, famous births, notable deaths, and quiz for this date.</p>${links}</div></div>`
    : `<p style="font-size:15px;margin:0 0 10px">Jump between the main events, famous births, notable deaths, and quiz for this date.</p>${links}`;
  return `<div data-explore-injected="1" class="authority-links mt-4">
    <span class="authority-links-label">Explore ${monthDisplay} ${day} in History</span>
    ${inner}
  </div>`;
}

/** Minimal HTML entity escaping to prevent XSS in generated output. */
function esc(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripGoogleFundingChoices(html) {
  return String(html || "")
    .replace(
      /\s*<script\b[^>]*\bsrc=["']https:\/\/fundingchoicesmessages\.google\.com\/i\/pub-8565025017387209\?ers=1["'][^>]*>\s*<\/script>/gi,
      "",
    )
    .replace(
      /\s*<script>\(function\(\)\{function signalGooglefcPresent\(\)\{[\s\S]*?signalGooglefcPresent\(\);\}\)\(\);<\/script>/gi,
      "",
    );
}

function normalizeHeadingAuditHtml(html) {
  return String(html || "")
    .replace(
      /\s*<h2\b(?=[^>]*\bid=["']article-short-answer-title["'])(?=[^>]*\bstyle=["'][^"']*display\s*:\s*none[^"']*["'])[^>]*>[\s\S]*?<\/h2>/gi,
      "",
    )
    .replace(
      /<h3>([^<]+)<\/h3>(\s*<\/article>)/gi,
      '<p class="dyn-fact">$1</p>$2',
    )
    .replace(
      /<article class="related-question-card">\s*<h3>([\s\S]*?)<\/h3>/gi,
      '<article class="related-question-card">\n        <p class="related-question-title">$1</p>',
    )
    .replace(
      /<h3 class="h6 mb-2">Explore connected topic hubs<\/h3>/gi,
      '<strong class="topic-hub-label">Explore connected topic hubs</strong>',
    );
}

function normalizeSearchPreviewHtml(html) {
  const normalizePreviewContent = (value) => {
    const decoded = String(value || "").replace(/&amp;/g, "&");
    try {
      const parsed = new URL(decoded, "https://thisday.info");
      if (parsed.hostname === "thisday.info" && parsed.pathname === "/image-proxy") {
        const proxiedSrc = parsed.searchParams.get("src");
        if (proxiedSrc) return buildSocialPreviewImageUrl(proxiedSrc);
      }
      if (isProxyableArticleImageUrl(decoded)) {
        return buildSocialPreviewImageUrl(decoded);
      }
    } catch (_) {
      /* leave malformed URLs unchanged */
    }
    return decoded;
  };
  const escapeAttrUrl = (value) => String(value || "").replace(/&/g, "&amp;");

  return String(html || "")
    .replace(
      /<meta name="robots" content="index, follow"\s*\/?>/i,
      '<meta name="robots" content="index, follow, max-image-preview:large" />',
    )
    .replace(
      /(<meta property="og:image" content=")([^"]+)(")/i,
      (_, pre, imageUrl, post) =>
        `${pre}${escapeAttrUrl(normalizePreviewContent(imageUrl))}${post}`,
    )
    .replace(
      /(<meta name="twitter:image" content=")([^"]+)(")/i,
      (_, pre, imageUrl, post) =>
        `${pre}${escapeAttrUrl(normalizePreviewContent(imageUrl))}${post}`,
    );
}

function normalizeCrawlableLinksHtml(html) {
  return String(html || "").replace(
    /(<a\b[^>]*\bid=["']tdq-cta-btn["'][^>]*\bhref=["'])javascript:void\(0\)(["'][^>]*\bonclick=["'])/gi,
    "$1/quiz/$2event.preventDefault();",
  );
}

function normalizeImageAltHtml(html) {
  return String(html || "").replace(
    /(<div data-explore-injected="1"[\s\S]*?<span class="authority-links-label">Explore\s+([^<]+?)\s+in History<\/span>[\s\S]*?<img\b[^>]*\salt=(["']))\3([^>]*>)/gi,
    (_match, pre, dateLabel, quote, post) =>
      `${pre}Explore ${esc(unesc(dateLabel))} in history${quote}${post}`,
  );
}

function normalizeStackedTitleHtml(html) {
  const source = String(html || "");
  const titleMatch =
    source.match(/<h1[^>]*>([^<]+)<\/h1>/i) ||
    source.match(/<title>([^<]+?)\s+\|\s+thisDay\.<\/title>/i) ||
    source.match(/<meta property="og:title" content="([^"]+)"/i);
  const currentTitle = unesc(titleMatch?.[1] || "");
  const currentLead = getTitleLead(currentTitle);
  const repairedLead = repairStackedTitleLead(currentLead);
  if (!currentLead || repairedLead === currentLead) return source;

  const dateSuffix = currentTitle.includes(" — ")
    ? currentTitle.split(" — ").slice(1).join(" — ")
    : "";
  const repairedTitle = dateSuffix
    ? buildCanonicalTitle(repairedLead, dateSuffix)
    : repairedLead;

  let updated = source;
  for (const [before, after] of [
    [currentTitle, repairedTitle],
    [currentLead, repairedLead],
  ]) {
    if (!before || !after || before === after) continue;
    updated = updated.split(esc(before)).join(esc(after));
    updated = updated.split(before).join(after);
  }
  return updated;
}

function stripDynSliderFiguresHtml(html) {
  // Replace figures only within dyn-slide article elements, not outside them.
  // The old approach used a greedy cross-element regex that accidentally removed
  // floating figures placed after DYN slides in the main article body.
  return String(html || "").replace(
    /(<article\b[^>]*\bdyn-slide\b[^>]*>)([\s\S]*?)(<\/article>)/gi,
    (_, open, content, close) =>
      open + content.replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, "") + close,
  );
}

function findDivBlockRangeContaining(html, phrase, classPattern = null) {
  const source = String(html || "");
  const phraseIndex = source.indexOf(phrase);
  if (phraseIndex === -1) return null;
  const divRe = /<div\b[^>]*>/gi;
  let match;
  let found = null;
  while ((match = divRe.exec(source))) {
    if (match.index > phraseIndex) break;
    if (classPattern && !classPattern.test(match[0])) continue;
    const end = findArticleHeroWrapEnd(source, match.index);
    if (end !== -1 && end > phraseIndex) {
      found = { start: match.index, end };
    }
  }
  if (!found) return null;

  const nearby = source.slice(Math.max(0, found.start - 100), found.start);
  const commentMatch = nearby.match(/<!-- Free Library Reading -->\s*$/);
  if (commentMatch) {
    found.start -= commentMatch[0].length;
  }
  return found;
}

function findExploreCardRange(html) {
  const source = String(html || "");
  const start = source.indexOf('<div data-explore-injected="1"');
  if (start === -1) return null;
  const end = findArticleHeroWrapEnd(source, start);
  return end === -1 ? null : { start, end };
}

function findElementBlockEnd(html, elementStart, tagName) {
  if (elementStart < 0 || !tagName) return -1;
  const safeTag = String(tagName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tagRe = new RegExp(`</?${safeTag}\\b[^>]*>`, "gi");
  tagRe.lastIndex = elementStart;
  let depth = 0;
  let match;
  while ((match = tagRe.exec(html))) {
    if (new RegExp(`^<${safeTag}\\b`, "i").test(match[0])) {
      depth += 1;
    } else {
      depth -= 1;
      if (depth === 0) return match.index + match[0].length;
    }
  }
  return -1;
}

function findSectionRangeContaining(html, phrase, classPattern = null) {
  const source = String(html || "");
  const phraseIndex = source.indexOf(phrase);
  if (phraseIndex === -1) return null;
  const sectionRe = /<section\b[^>]*>/gi;
  let match;
  let found = null;
  while ((match = sectionRe.exec(source))) {
    if (match.index > phraseIndex) break;
    if (classPattern && !classPattern.test(match[0])) continue;
    const end = findElementBlockEnd(source, match.index, "section");
    if (end !== -1 && end > phraseIndex) {
      found = { start: match.index, end };
    }
  }
  return found;
}

function moveHtmlRangeBefore(html, range, anchorIndex) {
  if (!range || anchorIndex === -1) return html;
  if (anchorIndex >= range.start && anchorIndex <= range.end) return html;
  const between = range.end <= anchorIndex ? html.slice(range.end, anchorIndex) : "";
  if (range.end <= anchorIndex && between.replace(/\s+/g, "") === "") return html;

  const block = html.slice(range.start, range.end).trim();
  const without = html.slice(0, range.start) + html.slice(range.end);
  const adjustedAnchor = anchorIndex > range.start ? anchorIndex - (range.end - range.start) : anchorIndex;
  return `${without.slice(0, adjustedAnchor)}${block}\n          ${without.slice(adjustedAnchor)}`;
}

function moveHeroOutsideArticleHtml(body) {
  const html = String(body || "");
  const heroStart = html.search(/<div\b[^>]*\bclass="[^"]*\barticle-hero-wrap\b/i);
  if (heroStart === -1) return html;
  const heroEnd = findArticleHeroWrapEnd(html, heroStart);
  if (heroEnd === -1) return html;
  const breadcrumbStart = html.search(/<nav\b[^>]*\baria-label="breadcrumb"/i);
  if (breadcrumbStart === -1) return html;
  const breadcrumbEnd = findElementBlockEnd(html, breadcrumbStart, "nav");
  if (breadcrumbEnd === -1) return html;
  const articleStart = html.search(/<article\b/i);

  let heroBlock = html.slice(heroStart, heroEnd);
  heroBlock = heroBlock.replace(/class="([^"]*)"/i, (_match, classes) => {
    const merged = classes.split(/\s+/).filter(Boolean).concat("article-hero-standalone");
    return `class="${[...new Set(merged)].join(" ")}"`;
  });

  // The desired document order is breadcrumb -> hero -> article. New HTML is
  // already emitted this way; legacy stored posts keep the hero inside article.
  if (heroStart >= breadcrumbEnd && (articleStart === -1 || heroEnd <= articleStart)) {
    return html.slice(0, heroStart) + heroBlock + html.slice(heroEnd);
  }

  const withoutHero = html.slice(0, heroStart) + html.slice(heroEnd);
  const adjustedBreadcrumbEnd = breadcrumbEnd > heroStart
    ? breadcrumbEnd - (heroEnd - heroStart)
    : breadcrumbEnd;
  return `${withoutHero.slice(0, adjustedBreadcrumbEnd)}\n${heroBlock}\n${withoutHero.slice(adjustedBreadcrumbEnd)}`;
}

function normalizeArticleLayoutHtml(body) {
  let html = moveHeroOutsideArticleHtml(body);

  if (html.includes('<section class="dyn-slider-shell') && !html.includes("<h2 class=\"h3\">Did You Know?</h2>")) {
    html = html.replace(
      '<section class="dyn-slider-shell',
      '<h2 class="h3">Did You Know?</h2>\n          <section class="dyn-slider-shell',
    );
  }

  const freeLibraryRange = findDivBlockRangeContaining(
    html,
    "Free library reading",
    /\bclass="[^"]*\bmt-3\b[^"]*\bp-3\b[^"]*\brounded\b/i,
  );
  const analysisAnchor = html.indexOf("<!-- Personal Analysis -->");
  if (freeLibraryRange && analysisAnchor !== -1) {
    html = moveHtmlRangeBefore(html, freeLibraryRange, analysisAnchor);
  }

  html = html.replace(
    /(<!-- Personal Analysis -->\s*)<section class="mt-5"(?![^>]*margin-top)/i,
    '$1<section class="mt-5" style="margin-top:2rem!important"',
  );

  const exploreRange = findExploreCardRange(html);
  const authorityAnchor = html.indexOf('<div class="authority-links mt-3 mb-4">');
  const amazonAnchor = html.indexOf('<section class="amazon-related');
  const exploreAnchor = authorityAnchor !== -1 ? authorityAnchor : amazonAnchor;
  if (exploreRange && exploreAnchor !== -1) {
    html = moveHtmlRangeBefore(html, exploreRange, exploreAnchor);
  }

  const amazonRelatedRange = findSectionRangeContaining(
    html,
    "Related books",
    /\bclass="[^"]*\bamazon-related\b/i,
  );
  if (amazonRelatedRange && !html.includes("article-body-ad-v1")) {
    html = `${html.slice(0, amazonRelatedRange.end)}
          ${buildArticleBodyAdBlock()}
          ${html.slice(amazonRelatedRange.end)}`;
  }

  // Keep direct-source links at the bottom of the article, immediately after
  // the Test Your Knowledge CTA. This also repairs older stored posts whose
  // authority block was rendered near the overview.
  const trustedSourcesRange =
    findDivBlockRangeContaining(
      html,
      "Sources used for this article",
      /\bclass="[^"]*\bauthority-links\b/i,
    ) ||
    findDivBlockRangeContaining(
      html,
      "Learn more at trusted sources",
      /\bclass="[^"]*\bauthority-links\b/i,
    );
  const quizCtaRange = findDivBlockRangeContaining(
    html,
    "Test Your Knowledge",
    /\bclass="[^"]*\bauthority-links\b[^"]*\bmt-4\b/i,
  );
  if (trustedSourcesRange && quizCtaRange) {
    html = moveHtmlRangeBefore(html, trustedSourcesRange, quizCtaRange.end);
  }

  const relatedQuestionsRange =
    findSectionRangeContaining(
      html,
      "Related questions",
      /\bclass="[^"]*\bmt-5\b[^"]*\bp-4\b[^"]*\brounded\b[^"]*\bborder\b/i,
    ) ||
    findSectionRangeContaining(html, "related-question-grid");
  const disclosureCommentAnchor = html.indexOf("<!-- AI & Editorial Disclosure -->");
  const disclosureRange = findDivBlockRangeContaining(
    html,
    "About this article",
    /\bclass="[^"]*\bmt-5\b[^"]*\bp-3\b[^"]*\brounded\b/i,
  );
  const disclosureAnchor =
    disclosureCommentAnchor !== -1
      ? disclosureCommentAnchor
      : disclosureRange?.start ?? -1;
  if (relatedQuestionsRange && disclosureAnchor !== -1) {
    html = moveHtmlRangeBefore(html, relatedQuestionsRange, disclosureAnchor);
  }

  return html;
}

function normalizeAiAnswerCardHtml(body) {
  let html = String(body || "");
  if (!html.includes("ai-answer-card")) return html;

  html = html.replace(
    /<style>\/\*ai-card-patch-v[12]\*\/[\s\S]*?<\/style>/g,
    "",
  );

  const hasCurrentPatch = html.includes("ai-card-patch-v3");
  const needsPatch =
    !hasCurrentPatch &&
    (/\.ai-answer-card\{[^}]*background:#f5f5f5/i.test(html) ||
      /\.ai-answer-card\{[^}]*border:1px/i.test(html) ||
      /\.ai-answer-card\{[^}]*padding:18px/i.test(html) ||
      /ai-card-patch-v[12]/i.test(html));

  if (needsPatch && html.includes("</head>")) {
    const patch =
      "<style>/*ai-card-patch-v3*/.ai-answer-card{position:relative!important;z-index:1!important;clear:both!important;background:#fff!important;background-image:none!important;border:0!important;padding:0!important}.ai-answer-kicker{display:none!important}.ai-answer-card h2{display:none!important}.ai-answer-card>figure{display:none!important}.ai-answer-card>p{display:none!important}.site-btn.w-100{justify-content:center!important}</style>";
    html = html.replace("</head>", `${patch}</head>`);
  }

  if (!html.includes("article-layout-patch-v6") && html.includes("</head>")) {
    const layoutPatch =
      "<style>/*article-layout-patch-v6*/.article-hero-wrap.article-hero-standalone{margin:0 0 1.5rem!important}.h3{margin-top:0!important;margin-bottom:1rem!important}article.p-4>*+*{margin-top:2rem!important}article.p-4>.h3+*{margin-top:1rem!important}.entity-strip{margin:0 0 2rem!important}.article-body-ad{margin:1.5rem 0 2rem!important}.article-body-ad ins.adsbygoogle{min-height:90px!important}</style>";
    html = html.replace("</head>", `${layoutPatch}</head>`);
  }
  return html;
}

function normalizeArticleAssetVersionsHtml(body) {
  return String(body || "").replace(
    /\/css\/custom\.css\?v=\d+/g,
    "/css/custom.css?v=33",
  );
}

function prepareHtmlResponse(body) {
  return normalizeHistoryEntityCanonicalLinksHtml(
    normalizeArticleAssetVersionsHtml(
      normalizeArticleEntityStripPresentationHtml(
        normalizeStackedTitleHtml(
          normalizeImageAltHtml(
            normalizeCrawlableLinksHtml(
              normalizeSearchPreviewHtml(
                normalizeHeadingAuditHtml(
                  normalizeAiAnswerCardHtml(
                    normalizeArticleLayoutHtml(
                      stripDynSliderFiguresHtml(stripGoogleFundingChoices(body)),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function htmlResponse(body, status = 200) {
  return new Response(prepareHtmlResponse(body), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=86400, s-maxage=604800",
      "X-Content-Type-Options": "nosniff",
      "Strict-Transport-Security":
        "max-age=31536000; includeSubDomains; preload",
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy":
        "camera=(), microphone=(), geolocation=(), payment=()",
    },
  });
}

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

function ensureStylesheetLink(html, href) {
  if (html.includes(`href="${href}"`)) return html;
  if (!html.includes("</head>")) return html;
  return html.replace(
    "</head>",
    `  <link rel="stylesheet" href="${href}" />\n</head>`,
  );
}

function ensureBlogChromeAssets(html) {
  let nextHtml = ensureStylesheetLink(html, "/css/style.css");
  nextHtml = ensureStylesheetLink(nextHtml, "/css/custom.css");
  return nextHtml;
}

function injectBlogNavWidthFix(html) {
  if (html.includes(BLOG_NAV_WIDTH_FIX_CSS)) return html;
  if (!html.includes("</head>")) return html;
  return html.replace(
    "</head>",
    `<style>${BLOG_NAV_WIDTH_FIX_CSS}</style></head>`,
  );
}

export const __entityResolutionTestHooks = {
  sourceEventPageMatchesPerson,
  extractSourcePagesFromHtml,
  compactSourcePagesForIndex,
};

export const __contentGenerationTestHooks = {
  sanitizeJsonControlChars,
  parseJsonObjectFromAI,
  isShortArticleBodyFailure,
  articleBodyWordCount,
  validateChunkedArticleBodyChunk,
  MIN_REAL_ARTICLE_BODY_WORDS,
  CHUNKED_BODY_PARAGRAPH_MIN_WORDS,
  generateEntityTimeline,
  fetchWikipediaEntityData,
  hasRichWikipediaPersonProfile,
  hasVerifiedPersonProfileIdentity,
  compactArticleEntityMeta,
  articleEntityStripNeedsProfileValidation,
  unlinkedArticlePerson,
  hydrateArticleEntityImages,
  blogEntityQualityEligible,
  normalizedWikipediaEntityIdentity,
  buildEvergreenHistorySlug,
  evergreenHistoryCandidateEligibility,
  evergreenHistoryEditionQuality,
  normalizeEvergreenHistoryEdition,
  syncEvergreenHistoryDiscoveryForEntity,
  filterGroundingIssues,
  verifyArticleGrounding,
  normalizeContentMetadata,
  validateContentSemanticsForPublish,
  buildArticleEntityStrip,
  buildArticleHistoryDiscoveryCard,
  normalizeArticleEntityStripPresentationHtml,
  normalizeArticleHistoryEntityMeta,
  normalizeArticleHistoryDiscoveryCardHtml,
  normalizeHistoryEntityCanonicalLinksHtml,
  compactAnalysisSubject,
  publicArticleTitle,
  normalizeCuriosityTitleText,
  validateCuriosityTitleForPublish,
  evidenceMapRowsFromContent,
  validateEvidenceMapForPublish,
  buildEvidenceMapBlock,
  relevantOpenLibraryBooks,
  commercialRecommendationsAreRelevant,
  buildAmazonRelatedBlock,
  buildArticleProcessDisclosure,
  normalizeArticleProcessDisclosureHtml,
  buildPillarHubHTML,
  servePillarHub,
  buildPostHTML,
};
