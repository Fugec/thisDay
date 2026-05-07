// Copyright (c) 2024–present Armin Kapetanovic. All Rights Reserved.
// Proprietary — see LICENSE in the repository root.
// Unauthorized use, reproduction, or deployment is prohibited.
//
// This Cloudflare Worker dynamically injects SEO-friendly meta tags
// and preloads daily event data to improve the user experience on site.
// Adds various security headers to enhance protection.
// Injects Schema.org JSON-LD for better SEO.

import {
  siteNav,
  siteFooter,
  footerYearScript,
  SITE_DESCRIPTION,
  NAV_CSS,
  FOOTER_CSS,
  navToggleScript,
  marqueeScript,
} from "./shared/layout.js";
import { callAI } from "./shared/ai-call.js";
import {
  LLMS_TXT_CONTENT,
  LLMS_FULL_TXT_CONTENT,
} from "./shared/llms-content.js";

// --- Configuration Constants ---
// Define a User-Agent for API requests to Wikipedia.
const WIKIPEDIA_USER_AGENT = "thisDay.info (kapetanovic.armin@gmail.com)";

const KV_CACHE_TTL_SECONDS = 24 * 60 * 60; // KV entry valid for 24 hours
const MIN_PERSON_ENTITY_BODY_WORDS = 150;
const MIN_EVENT_ENTITY_BODY_WORDS = 150;

// --- Helper function to fetch daily events from Wikipedia API ---
async function fetchDailyEvents(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const apiUrl = `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/all/${month}/${day}`;

  const workerCache = caches.default;
  let response = await workerCache.match(apiUrl);
  if (response) {
    console.log("Worker internal Cache HIT for Wikipedia API:", apiUrl);
    return response.json();
  }

  console.log("Fetching from Wikipedia API:", apiUrl);
  try {
    const fetchResponse = await fetch(apiUrl, {
      headers: {
        "User-Agent": WIKIPEDIA_USER_AGENT,
      },
    });

    if (!fetchResponse.ok) {
      console.error(
        `Wikipedia API responded with status ${fetchResponse.status} for ${apiUrl}`,
      );
      await fetchResponse.text(); // Consume body to prevent issues
      throw new Error(
        `Failed to fetch Wikipedia events: ${fetchResponse.statusText}`,
      );
    }

    // Cache the successful response in worker's internal cache for immediate re-use
    await workerCache.put(apiUrl, fetchResponse.clone());

    return fetchResponse.json();
  } catch (error) {
    console.error(`Error fetching daily events from Wikipedia API: ${error}`);
    // Return a default structure in case of an error
    return { events: [], births: [], deaths: [], holidays: [], selected: [] };
  }
}

// --- Helper function to extract a plausible location from event text ---
function extractLocationFromName(text) {
  // Try to find patterns like "in City, Country" or "in City"
  let match = text.match(
    /(?:in|near)\s+([A-Za-z\s,\-]+(?:,\s*[A-Za-z\s\-]+)?)\b/i,
  );
  if (match && match[1]) {
    // Basic cleaning: remove trailing punctuation if any
    let location = match[1].trim();
    if (location.endsWith(".")) {
      location = location.slice(0, -1);
    }
    return location;
  }
  // Fallback if no specific location can be extracted
  return "Historical Location";
}

// --- Image Proxy: resize, cache, and optionally convert Wikipedia images ---
function normalizeWikimediaImageUrl(src) {
  return String(src || "")
    // Wikimedia thumbnail URLs can arrive with their percent escapes escaped
    // again by callers, e.g. "%2528" for an encoded "(". Keep UTF-8 escapes
    // encoded, but collapse the extra layer so Wikimedia sees the real path.
    .replace(/%25([0-9A-Fa-f]{2})/g, "%$1");
}

async function handleImageProxy(_request, url, ctx) {
  const src = url.searchParams.get("src");
  const width = Math.min(
    parseInt(url.searchParams.get("w") || "1200", 10),
    2000,
  );
  const heightParam = parseInt(url.searchParams.get("h") || "0", 10);
  const height =
    Number.isFinite(heightParam) && heightParam > 0
      ? Math.min(heightParam, 2000)
      : null;
  const fitParam = String(url.searchParams.get("fit") || "").toLowerCase();
  const fit = ["cover", "contain", "scale-down", "crop", "pad"].includes(
    fitParam,
  )
    ? fitParam
    : height
      ? "cover"
      : undefined;
  const quality = Math.min(
    parseInt(url.searchParams.get("q") || "82", 10),
    100,
  );

  if (!src) return new Response("Missing src parameter", { status: 400 });

  let imageUrl;
  try {
    const normalizedSrc = normalizeWikimediaImageUrl(src);
    // URLSearchParams already decoded the src param once — use it directly.
    // A second decodeURIComponent() would turn %C3%BC into ü (raw Unicode)
    // which Wikimedia rejects; percent-encoded form is the correct fetch URL.
    const parsed = new URL(normalizedSrc);
    if (!parsed.hostname.endsWith("wikimedia.org")) {
      return new Response("Forbidden: only Wikimedia images allowed", {
        status: 403,
      });
    }
    // Resize by swapping the pixel-width segment in Wikipedia thumbnail paths
    // e.g. /320px-File.jpg  →  /1200px-File.jpg
    imageUrl = normalizedSrc.replace(/\/\d+px-/, `/${width}px-`);
  } catch {
    return new Response("Invalid URL", { status: 400 });
  }

  // Check worker-level cache first (keyed on final URL + dimensions)
  const workerCache = caches.default;
  const cacheKey = new Request(
    `https://img-cache.thisday.info/${encodeURIComponent(imageUrl)}?w=${width}&h=${height || ""}&fit=${fit || ""}&q=${quality}`,
  );
  const cached = await workerCache.match(cacheKey);
  if (cached) return cached;

  try {
    const imageOptions = { width, quality, format: "auto" };
    if (height) imageOptions.height = height;
    if (fit) imageOptions.fit = fit;
    const imageResponse = await fetch(imageUrl, {
      headers: {
        "User-Agent": WIKIPEDIA_USER_AGENT,
        Accept: "image/avif,image/webp,image/jpeg,image/*",
      },
      cf: {
        cacheTtl: 60 * 60 * 24 * 30, // 30-day Cloudflare edge cache
        cacheEverything: true,
        // Cloudflare Image Resizing (Pro plan+): converts to WebP/AVIF automatically
        image: imageOptions,
      },
    });

    if (!imageResponse.ok) {
      return new Response("Image not found", { status: imageResponse.status });
    }

    const headers = new Headers();
    headers.set(
      "Content-Type",
      imageResponse.headers.get("Content-Type") || "image/jpeg",
    );
    headers.set("Cache-Control", "public, max-age=2592000, immutable"); // 30 days browser cache
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Vary", "Accept"); // separate cache entry per Accept header (WebP vs JPEG)

    const result = new Response(imageResponse.body, { status: 200, headers });
    ctx.waitUntil(workerCache.put(cacheKey, result.clone()));
    return result;
  } catch {
    return new Response("Error fetching image", { status: 500 });
  }
}

// ─── Auto-Generated Blog Posts ───────────────────────────────────────────────

const MONTH_NUM_MAP = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};
const MONTH_DISPLAY_NAMES = [
  "",
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
const MONTHS_ALL = [
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
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // Feb=29 to cover all possible dates

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

const TOPIC_HUBS = [
  {
    slug: "world-war-ii",
    title: "World War II",
    summary:
      "A topic hub for battles, invasions, political decisions, and turning points tied to the Second World War.",
    keywords: [
      "world war ii",
      "second world war",
      "wwii",
      "nazi",
      "hitler",
      "allied",
      "axis",
      "d-day",
      "normandy",
      "stalingrad",
      "holocaust",
      "pearl harbor",
    ],
    pillars: ["War & Conflict", "Politics & Government"],
  },
  {
    slug: "cold-war",
    title: "Cold War",
    summary:
      "Articles about nuclear brinkmanship, proxy conflicts, espionage, and the rivalry that shaped the late twentieth century.",
    keywords: [
      "cold war",
      "soviet",
      "nato",
      "warsaw pact",
      "berlin wall",
      "cuban missile crisis",
      "arms race",
      "communist",
    ],
    pillars: ["Politics & Government", "War & Conflict"],
  },
  {
    slug: "french-revolution",
    title: "French Revolution",
    summary:
      "A hub for uprisings, leaders, and political shocks connected to the French Revolution and the Napoleonic age.",
    keywords: [
      "french revolution",
      "robespierre",
      "bastille",
      "napoleon",
      "directory",
      "jacobin",
      "bourbon",
    ],
    pillars: ["Politics & Government", "War & Conflict"],
  },
  {
    slug: "roman-empire",
    title: "Roman Empire",
    summary:
      "A hub for emperors, conquests, collapses, and political dramas from the Roman world.",
    keywords: [
      "roman empire",
      "rome",
      "roman",
      "caesar",
      "augustus",
      "constantinople",
      "byzantine",
      "republic",
    ],
    pillars: ["Politics & Government", "War & Conflict"],
  },
  {
    slug: "space-exploration",
    title: "Space Exploration",
    summary:
      "Launches, missions, disasters, discoveries, and the people who pushed human exploration beyond Earth.",
    keywords: [
      "space",
      "apollo",
      "nasa",
      "cosmos",
      "moon landing",
      "astronaut",
      "satellite",
      "mars",
      "rocket",
    ],
    pillars: ["Science & Technology", "Exploration & Discovery"],
  },
  {
    slug: "civil-rights",
    title: "Civil Rights",
    summary:
      "A topic hub for protests, landmark rulings, reform movements, and the people who fought for equal rights.",
    keywords: [
      "civil rights",
      "segregation",
      "abolition",
      "suffrage",
      "voting rights",
      "freedom riders",
      "human rights",
      "desegregation",
    ],
    pillars: ["Social & Human Rights", "Politics & Government"],
  },
  {
    slug: "medical-breakthroughs",
    title: "Medical Breakthroughs",
    summary:
      "Discoveries, vaccines, surgeries, and public health turning points that changed how people lived and survived.",
    keywords: [
      "vaccine",
      "medicine",
      "medical",
      "epidemic",
      "pandemic",
      "surgery",
      "penicillin",
      "hospital",
    ],
    pillars: ["Health & Medicine", "Science & Technology"],
  },
  {
    slug: "exploration-and-discovery",
    title: "Exploration and Discovery",
    summary:
      "Voyages, expeditions, maps, and discoveries that expanded what people thought the world could be.",
    keywords: [
      "expedition",
      "voyage",
      "exploration",
      "discovery",
      "navigator",
      "polar",
      "atlantic",
      "pacific",
    ],
    pillars: ["Exploration & Discovery", "Science & Technology"],
  },
];

function getTopicHubBySlug(slug) {
  return TOPIC_HUBS.find((hub) => hub.slug === slug) || null;
}

function normalizeTopicMatchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTopicHubMatches(sourceText = "", limit = 3) {
  const haystack = normalizeTopicMatchText(sourceText);
  if (!haystack) return [];

  return TOPIC_HUBS.filter((hub) =>
    hub.keywords.some((keyword) => haystack.includes(normalizeTopicMatchText(keyword))),
  ).slice(0, limit);
}

function buildTopicHubLinks(sourceText = "", heading = "Explore Related Topics") {
  const matches = getTopicHubMatches(sourceText, 3);
  if (matches.length === 0) return "";

  return `<div class="topic-hub-links mt-3">
    <h3 class="h6 mb-2">${escapeHtml(heading)}</h3>
    <div class="topic-hub-chip-row">
      ${matches
        .map(
          (hub) =>
            `<a href="/topics/${hub.slug}/" class="topic-hub-chip">${escapeHtml(hub.title)}</a>`,
        )
        .join("")}
    </div>
  </div>`;
}

function buildRelatedQuestionsBlock(title, questions = [], sourceText = "") {
  if (!Array.isArray(questions) || questions.length === 0) return "";

  return `<section class="card-box ai-question-block">
    <div class="ai-answer-kicker">Related questions</div>
    <h2 class="h4 mb-3">${escapeHtml(title)}</h2>
    <div class="ai-question-grid">
      ${questions
        .filter((item) => item?.question && item?.answer)
        .map(
          (item) => `<article class="ai-question-card">
            <h3>${escapeHtml(item.question)}</h3>
            <p>${escapeHtml(item.answer)}</p>
            ${
              item.href
                ? `<a href="${escapeHtml(item.href)}" class="site-btn site-btn-primary">${escapeHtml(item.cta || "Explore")}</a>`
                : ""
            }
          </article>`,
        )
        .join("")}
    </div>
    ${buildTopicHubLinks(sourceText)}
  </section>`;
}

function buildEventRelatedQuestionsBlock({
  mDisplay,
  day,
  featured,
  events,
  births,
  deaths,
  relatedBlogEntry,
}) {
  if (!featured) return "";

  const eventText = String(featured.text || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "");
  const birthNames = births
    .slice(0, 3)
    .map((item) => String(item?.text || "").split(",")[0].trim())
    .filter(Boolean);
  const deathNames = deaths
    .slice(0, 3)
    .map((item) => String(item?.text || "").split(",")[0].trim())
    .filter(Boolean);
  const questions = [
    {
      question: `What happened on ${mDisplay} ${day}?`,
      answer: `A featured event on this date is ${featured.year}: ${eventText}. This page also lists ${events.length} events from other years on the same day.`,
    },
    {
      question: `Why is ${mDisplay} ${day} remembered in history?`,
      answer: `${mDisplay} ${day} brings together events, births, and deaths across many eras, which makes it useful for seeing how one calendar date connects different historical turning points.`,
    },
    birthNames.length > 0
      ? {
          question: `Who was born on ${mDisplay} ${day}?`,
          answer: `Notable birthdays on this date include ${birthNames.join(", ")}.`,
          href: `/born/${MONTHS_ALL[MONTH_DISPLAY_NAMES.indexOf(mDisplay)]}/${day}/`,
          cta: "See birthdays",
        }
      : null,
    deathNames.length > 0
      ? {
          question: `Who died on ${mDisplay} ${day}?`,
          answer: `Notable deaths on this date include ${deathNames.join(", ")}.`,
          href: `/died/${MONTHS_ALL[MONTH_DISPLAY_NAMES.indexOf(mDisplay)]}/${day}/`,
          cta: "See deaths",
        }
      : relatedBlogEntry
        ? {
            question: "What should I read next about this date?",
            answer: `The blog article "${relatedBlogEntry.title}" goes deeper on one of this date's most compelling stories.`,
            href: `/blog/${relatedBlogEntry.slug}/`,
            cta: "Read the article",
          }
        : null,
  ].filter(Boolean);

  return buildRelatedQuestionsBlock(
    `More questions about ${mDisplay} ${day}`,
    questions,
    `${eventText} ${birthNames.join(" ")} ${deathNames.join(" ")}`,
  );
}

async function getBlogIndexEntries(env) {
  const index = env.BLOG_AI_KV
    ? await env.BLOG_AI_KV.get("index", { type: "json" }).catch(() => null)
    : null;
  return Array.isArray(index) ? index : [];
}

function slugifyArchiveLabel(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function entityKey(type, slug) {
  return `entity-v1:${type}:${slug}`;
}

const ENTITY_PLACEHOLDER_FRAGMENTS = [
  "public role summarized from the linked source",
  "life date details are sourced from",
  "life and death details are taken from",
  "is the current thisday link for",
  "as more articles mention the same person",
  "entity page, with the related article",
  "the outcome card keeps the immediate result",
  "this event matters because it links",
  "date details are sourced from the related",
  "location details are sourced from the related",
  "key people are drawn from the related article",
];

function isEntityPlaceholder(value) {
  const v = String(value || "").toLowerCase();
  return ENTITY_PLACEHOLDER_FRAGMENTS.some((f) => v.includes(f));
}

const PERSON_CARD_SKIP = [
  /was born (into|in|at)\b/i,
  /born into the\b/i,
  /\bis the current thisday\b/i,
  /\bwas born (and raised|to a)\b/i,
  /\bthe (son|daughter|child) of\b/i,
  /grew up in\b/i,
];

const PERSON_CARD_PREFER = [
  /\bprimary author\b/i, /\bprincipal author\b/i,
  /\bfounded\b/i, /\binvented\b/i, /\bdiscovered\b/i,
  /\bserved as\b/i, /\bwrote\b/i, /\bcomposed\b/i,
  /\bpioneered\b/i, /\bwon\b/i, /\bawarded\b/i,
  /\bproponent\b/i, /\barchitect of\b/i, /\bauthor of\b/i,
  /\bled\b/i, /\bchampioned\b/i, /\bestablished\b/i,
];

function personIntroSentences(text) {
  if (!text) return [];
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 45 && s.length <= 350)
    .filter((s) => !PERSON_CARD_SKIP.some((p) => p.test(s)))
    .sort((a, b) => {
      return PERSON_CARD_PREFER.filter((p) => p.test(b)).length - PERSON_CARD_PREFER.filter((p) => p.test(a)).length;
    })
    .slice(0, 4);
}

function sentenceLabel(sentence) {
  if (/primary author|principal author|wrote|composed|authored/i.test(sentence)) return "Written work";
  if (/founded|established|created|built/i.test(sentence)) return "Founded";
  if (/invented|discovered|pioneered/i.test(sentence)) return "Discovery";
  if (/proponent|democracy|rights|philosophy/i.test(sentence)) return "Philosophy";
  if (/served as|president|governor|minister|senator|general/i.test(sentence)) return "Career";
  if (/awarded|won|prize|medal/i.test(sentence)) return "Achievement";
  return "Legacy";
}

function buildEntityOverviewSlider(entity) {
  const cards = [];

  if (entity.type === "person") {
    // Dates from direct entity fields
    if (entity.birthDate || entity.deathDate) {
      const dates = entity.birthDate && entity.deathDate
        ? `${entity.birthDate} – ${entity.deathDate}`
        : entity.birthDate
          ? `b. ${entity.birthDate}`
          : `d. ${entity.deathDate}`;
      cards.push({ label: "Born / Died", value: dates });
    }

    // Role from Wikipedia description (most reliable one-liner)
    if (entity.description && !isEntityPlaceholder(entity.description)) {
      cards.push({ label: "Role", value: entity.description });
    }

    // Concrete sentences from Wikipedia intro
    const sentences = personIntroSentences(entity.intro || entity.summary || "");
    const usedTexts = new Set(cards.map((c) => c.value.toLowerCase()));
    for (const sentence of sentences) {
      if (cards.length >= 5) break;
      if (!usedTexts.has(sentence.toLowerCase())) {
        cards.push({ label: sentenceLabel(sentence), value: sentence });
        usedTexts.add(sentence.toLowerCase());
      }
    }

    // Fill remaining from stored AI cards that look concrete
    const storedGood = (entity.overviewCards || [])
      .filter((c) => c?.label && c?.value)
      .filter((c) => !["Context", "Life and death", "Main role", "Known for"].includes(c.label))
      .filter((c) => !isEntityPlaceholder(c.value))
      .filter((c) => !PERSON_CARD_SKIP.some((p) => p.test(c.value)));
    for (const c of storedGood) {
      if (cards.length >= 6) break;
      if (!usedTexts.has(c.value.toLowerCase())) {
        cards.push(c);
        usedTexts.add(c.value.toLowerCase());
      }
    }
  } else {
    const storedCards = (entity.overviewCards || [])
      .filter((c) => c?.label && c?.value)
      .filter((c) => c.label !== "Context")
      .filter((c) => !isEntityPlaceholder(c.value));
    cards.push(...storedCards);
    if (!cards.length) {
      cards.push({ label: "What happened", value: entity.summary || entity.description || entity.name });
    }
  }

  if (!cards.length) return "";

  return `<section class="mt-4" style="overflow:hidden">
    <h2 class="h3">Overview</h2>
    <div class="dyn-slider-wrap">
      <div class="dyn-slider-track">
        ${cards
          .map(
            (card) =>
              `<article class="dyn-slide"><p>${escapeHtml(card.label)}</p><p class="dyn-fact">${escapeHtml(card.value)}</p></article>`,
          )
          .join("")}
      </div>
    </div>
  </section>`;
}

const ENTITY_INLINE_AD = `<div class="ad-unit-container my-4">
  <span class="ad-unit-label">Advertisement</span>
  <ins class="adsbygoogle" style="display:block"
       data-ad-client="ca-pub-8565025017387209"
       data-ad-slot="9477779891"
       data-ad-format="auto"
       data-full-width-responsive="true"></ins>
</div>`;

function buildEntityBookOrAdSlot(entity) {
  const topic = [
    entity.name,
    entity.description,
    entity.sourcePostTitle,
    ...(Array.isArray(entity.relatedTopics) ? entity.relatedTopics : []),
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const keywords = topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !["history", "world", "first", "second", "person", "article", "related"].includes(word))
    .slice(0, 14)
    .join(" ");

  return `<div class="entity-book-slot my-4" data-entity-book-slot data-query="${escapeHtml(`${entity.name} biography history`)}" data-keywords="${escapeHtml(keywords)}" data-amazon-tag="thisday0c-20">
    <section class="amazon-related mt-4 p-3 rounded" aria-label="Related book recommendations" style="display:none">
      <div class="amazon-related-head"><span class="amazon-kicker">Related books</span></div>
      <div class="amazon-slider-shell">
        <button type="button" class="amazon-slider-btn" aria-label="Previous related books" onclick="this.parentElement.querySelector('.amazon-slider-wrap').scrollBy({left:-260,behavior:'smooth'})">&#8249;</button>
        <div class="amazon-slider-wrap"><div class="amazon-slider-track" aria-live="polite"></div></div>
        <button type="button" class="amazon-slider-btn" aria-label="Next related books" onclick="this.parentElement.querySelector('.amazon-slider-wrap').scrollBy({left:260,behavior:'smooth'})">&#8250;</button>
      </div>
      <small class="article-meta d-block mt-2">Book covers from Open Library. As an Amazon Associate I earn from qualifying purchases.</small>
    </section>
    <div class="entity-book-fallback">${ENTITY_INLINE_AD}</div>
  </div>`;
}

function buildEntityBodySections(entity) {
  const sections = Array.isArray(entity.bodySections) ? entity.bodySections : [];
  const validSections = sections
    .map((section) => ({
      heading: String(section?.heading || "").trim(),
      paragraphs: Array.isArray(section?.paragraphs)
        ? section.paragraphs.map((p) => String(p || "").trim()).filter(Boolean)
        : [],
    }))
    .filter((section) => section.heading && section.paragraphs.length > 0)
    .slice(0, 5);

  if (!validSections.length) {
    const fallback = entity.intro || entity.summary || entity.description || "";
    if (!fallback) return "";
    return `<section class="entity-body mt-4">
      <h2 class="h3">About ${escapeHtml(entity.name)}</h2>
      <p>${escapeHtml(fallback)}</p>
    </section>`;
  }

  return `<section class="entity-body mt-4">
    ${validSections
      .map(
        (section, i) =>
          `<div class="entity-body-section">
            <h2 class="h3">${escapeHtml(section.heading)}</h2>
            ${section.paragraphs.map((paragraph) => `<p>${escapeHtml(ensureCompleteSentences(paragraph))}</p>`).join("")}
          </div>${i === 0 ? buildEntityBookOrAdSlot(entity) : ""}${i === 1 ? `<div class="entity-career-ad">${ENTITY_INLINE_AD}</div>` : ""}`,
      )
      .join("")}
  </section>`;
}

function buildEntityRelatedPosts(entity, posts) {
  const relatedSlugs = Array.isArray(entity.relatedPosts) ? entity.relatedPosts : [];
  const related = relatedSlugs
    .map((slug) => posts.find((post) => post.slug === slug))
    .filter(Boolean)
    .slice(0, 6);
  if (!related.length) return "";
  return `<section class="mt-5">
    <h2 class="h3">Related on thisDay</h2>
    <div class="entity-grid">
      ${related
        .map(
          (post) =>
            `<a class="entity-card" href="/blog/${escapeHtml(post.slug)}/"><strong>${escapeHtml(post.title)}</strong><p class="mb-0 article-meta">${escapeHtml(post.description || "Read the related thisDay article.")}</p></a>`,
        )
        .join("")}
    </div>
  </section>`;
}

function buildEntityAdUnits() {
  return "";
}

async function buildHomepageVideoCards(env) {
  if (!env.BLOG_AI_KV) return "";
  const [indexRaw, ytRaw] = await Promise.all([
    env.BLOG_AI_KV.get("index").catch(() => null),
    env.BLOG_AI_KV.get("youtube:uploaded").catch(() => null),
  ]);
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  const yt = ytRaw ? JSON.parse(ytRaw) : {};
  const indexBySlug = Object.fromEntries(index.map((post) => [post.slug, post]));
  return Object.entries(yt)
    .filter(([, video]) => video?.youtubeId && video.privacy !== "private")
    .sort(([, a], [, b]) => new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0))
    .slice(0, 6)
    .map(([slug, video]) => {
      const post = indexBySlug[slug] || {};
      const title = post.title || slug;
      const shortTitle = title.length > 55 ? `${title.slice(0, 52)}...` : title;
      const desc = post.description || "";
      const shortDesc = desc.length > 90 ? `${desc.slice(0, 87)}...` : desc;
      const thumbnail = `https://img.youtube.com/vi/${video.youtubeId}/hqdefault.jpg`;
      return `<a class="blog-card video-card" href="https://www.youtube.com/shorts/${escapeHtml(video.youtubeId)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;color:inherit;">
        <div class="video-card-thumb">
          <img src="${escapeHtml(thumbnail)}" alt="${escapeHtml(shortTitle)}" loading="lazy" onerror="if(this.src.indexOf('hqdefault')>-1){this.src=this.src.replace('hqdefault','mqdefault');}else{this.style.display='none';}" />
          <div class="video-card-play"><i class="bi bi-play-circle-fill"></i></div>
        </div>
        <div class="blog-card-body">
          <div class="blog-card-date">YouTube Shorts</div>
          <h3>${escapeHtml(shortTitle)}</h3>
          ${shortDesc ? `<p>${escapeHtml(shortDesc)}</p>` : ""}
          <span class="btn" style="align-self:flex-start;margin-top:auto">Watch <i class="bi bi-arrow-right"></i></span>
        </div>
      </a>`;
    })
    .join("");
}

async function handlePeopleIndexPage(request, env, url) {
  const raw = await env.BLOG_AI_KV?.get("entity-index-v1").catch(() => null);
  const index = await refreshEntityIndexFromStoredEntities(env, raw ? JSON.parse(raw) : [], "person");
  const people = index
    .filter((entry) => entry?.type === "person" && entry.slug && entry.name)
    .sort((a, b) => {
      const ai = a.indexable ? 1 : 0;
      const bi = b.indexable ? 1 : 0;
      if (ai !== bi) return bi - ai;
      return String(a.name).localeCompare(String(b.name));
    });
  const pageTitle = "People in History | thisDay.";
  const description = "Browse people connected to thisDay historical articles, with biographical context, source links, and related coverage.";
  const cards = people.length
    ? people.map((person) => {
        const image = person.imageUrl
          ? `<img src="/image-proxy?src=${encodeURIComponent(person.imageUrl)}&w=180&h=180&fit=cover&q=80" alt="${escapeHtml(person.name)}" loading="lazy">`
          : `<span class="people-card-fallback" aria-hidden="true">${escapeHtml(String(person.name).slice(0, 1).toUpperCase())}</span>`;
        const meta = [
          person.indexable ? "Profile ready" : "Profile warming up",
          Array.isArray(person.relatedPosts) && person.relatedPosts.length
            ? `${person.relatedPosts.length} related article${person.relatedPosts.length === 1 ? "" : "s"}`
            : "",
        ].filter(Boolean).join(" · ");
        return `<a class="people-card" href="/people/${escapeHtml(person.slug)}/">
          <span class="people-card-image">${image}</span>
          <span class="people-card-copy">
            <strong>${escapeHtml(person.name)}</strong>
            ${person.summary ? `<small>${escapeHtml(person.summary).slice(0, 145)}${person.summary.length > 145 ? "..." : ""}</small>` : ""}
            <em>${escapeHtml(meta)}</em>
          </span>
        </a>`;
      }).join("")
    : `<p class="article-meta mb-0">People pages will appear here as new articles add entity records.</p>`;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(pageTitle)}</title>
  <link rel="canonical" href="${url.origin}/people/" />
  <meta name="robots" content="index, follow" />
  <meta name="description" content="${escapeHtml(description)}" />
  <meta property="og:title" content="${escapeHtml(pageTitle)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${url.origin}/people/" />
  <meta property="og:image" content="${url.origin}/images/logo.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="icon" href="/images/favicon.ico" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" />
  <link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/css/style.css" />
  <link rel="stylesheet" href="/css/custom.css" />
  <style>
    ${NAV_CSS}
    ${FOOTER_CSS}
    body{font-family:Lora,serif;background:#fff;color:#1a2e20;min-height:100vh;display:flex;flex-direction:column}main{flex:1}.people-grid{display:grid;grid-template-columns:1fr;gap:12px}.people-card{display:flex;gap:14px;padding:14px;border:1px solid #cfe0cf;border-radius:10px;background:#fff;color:inherit;text-decoration:none}.people-card:hover{background:#f2f7f2;color:inherit;text-decoration:none}.people-card-image{width:68px;height:68px;border-radius:50%;overflow:hidden;background:#f2f7f2;border:1px solid #cfe0cf;display:flex;align-items:center;justify-content:center;flex:0 0 68px}.people-card-image img{width:100%;height:100%;object-fit:cover;object-position:top}.people-card-fallback{font-size:1.5rem;color:#1b3a2d}.people-card-copy{min-width:0;display:flex;flex-direction:column;gap:3px}.people-card-copy strong{font-size:1rem;color:#1b3a2d}.people-card-copy small{font-size:14px;line-height:1.45;color:#1a2e20}.people-card-copy em{font-size:12px;color:#5c7a65;font-style:normal}.breadcrumb{background:transparent;padding:0}.breadcrumb-item a{color:#1b3a2d}@media(min-width:760px){.people-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  </style>
</head>
<body>
${siteNav()}
<main class="container my-5" style="max-width:1040px">
  <nav aria-label="breadcrumb" class="mb-3"><ol class="breadcrumb"><li class="breadcrumb-item"><a href="/">Home</a></li><li class="breadcrumb-item active" aria-current="page">People</li></ol></nav>
  <header class="mb-4">
    <h1 class="h2 fw-bold mb-2">People in History</h1>
    <p class="article-meta mb-0">${escapeHtml(description)}</p>
  </header>
  <section class="people-grid">${cards}</section>
</main>
${siteFooter("yr")}
${footerYearScript()}
</body>
</html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=1800",
    },
  });
}

function wikiTitleFromEntityUrl(wikiUrl) {
  try {
    const parsed = new URL(wikiUrl);
    const title = parsed.pathname.split("/wiki/")[1];
    return title ? decodeURIComponent(title.split("#")[0]).replace(/_/g, " ") : "";
  } catch {
    return "";
  }
}

function formatWikidataDate(claim) {
  const raw = claim?.mainsnak?.datavalue?.value?.time;
  const match = raw ? raw.match(/^[+-](\d{4})-(\d{2})-(\d{2})/) : null;
  if (!match) return "";
  const [, year, month, day] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
    .toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

async function fetchEntityLifeDates(type, pageTitle) {
  if (type !== "person" || !pageTitle) return {};
  const pageRes = await fetch(
    `https://en.wikipedia.org/w/api.php?action=query&redirects=1&prop=pageprops&ppprop=wikibase_item&format=json&origin=*&titles=${encodeURIComponent(pageTitle)}`,
    { headers: { "User-Agent": WIKIPEDIA_USER_AGENT } },
  ).catch(() => null);
  if (!pageRes?.ok) return {};
  const pageData = await pageRes.json();
  const page = Object.values(pageData?.query?.pages || {})[0];
  const qid = page?.pageprops?.wikibase_item;
  if (!qid) return {};
  const entityRes = await fetch(
    `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(qid)}.json`,
    { headers: { "User-Agent": WIKIPEDIA_USER_AGENT } },
  ).catch(() => null);
  if (!entityRes?.ok) return {};
  const entityData = await entityRes.json();
  const claims = entityData?.entities?.[qid]?.claims || {};
  return {
    birthDate: formatWikidataDate(claims.P569?.[0]),
    deathDate: formatWikidataDate(claims.P570?.[0]),
  };
}

async function fetchEntityWikiHydration(entity, type) {
  const pageTitle = wikiTitleFromEntityUrl(entity.wikiUrl) || entity.name;
  if (!pageTitle) return {};
  const [summaryRes, extractRes, lifeDates] = await Promise.all([
    fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}`,
      { headers: { "User-Agent": WIKIPEDIA_USER_AGENT } },
    ).catch(() => null),
    fetch(
      `https://en.wikipedia.org/w/api.php?action=query&redirects=1&prop=extracts&explaintext=1&exchars=3200&format=json&origin=*&titles=${encodeURIComponent(pageTitle)}`,
      { headers: { "User-Agent": WIKIPEDIA_USER_AGENT } },
    ).catch(() => null),
    fetchEntityLifeDates(type, pageTitle),
  ]);

  const summary = summaryRes?.ok ? await summaryRes.json() : {};
  const extractData = extractRes?.ok ? await extractRes.json() : {};
  const page = Object.values(extractData?.query?.pages || {})[0];
  const intro = cleanWikiExtract(page?.extract || summary.extract || "");
  return {
    summary: summary.extract || "",
    intro,
    description: summary.description || "",
    imageUrl: summary.thumbnail?.source || summary.originalimage?.source || "",
    ...lifeDates,
  };
}

function cleanWikiExtract(value) {
  return String(value || "")
    .replace(/^=+[^=\n]+?=+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitEntityHydratedSections(entity) {
  const text = String(entity.intro || entity.summary || "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)/g) || [text];
  const sections = [];
  let current = [];
  let words = 0;
  for (const sentence of sentences) {
    const count = sentence.trim().split(/\s+/).filter(Boolean).length;
    if (words + count > 130 && current.length) {
      sections.push(current.join(" ").trim());
      current = [sentence.trim()];
      words = count;
    } else {
      current.push(sentence.trim());
      words += count;
    }
  }
  if (current.length) sections.push(current.join(" ").trim());

  const name = entity.name || "This subject";
  const headings = entity.type === "person"
    ? [`Who was ${name}?`, "Career and public life", "Historical significance"]
    : [`What was ${name}?`, "Background and consequences", "Why it matters"];
  return sections.slice(0, 3).map((paragraph, index) => ({
    heading: headings[index] || headings[headings.length - 1],
    paragraphs: [paragraph],
  }));
}

function entityBodyWordCount(entity) {
  return (Array.isArray(entity?.bodySections) ? entity.bodySections : [])
    .flatMap((s) => (Array.isArray(s.paragraphs) ? s.paragraphs : []))
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;
}

async function updateEntityIndexEntry(env, entity) {
  if (!env.BLOG_AI_KV || !entity?.type || !entity?.slug) return;
  const raw = await env.BLOG_AI_KV.get("entity-index-v1").catch(() => null);
  const index = raw ? JSON.parse(raw) : [];
  const minWords = entity.type === "person" ? MIN_PERSON_ENTITY_BODY_WORDS : MIN_EVENT_ENTITY_BODY_WORDS;
  const nextEntry = {
    type: entity.type,
    slug: entity.slug,
    name: entity.name,
    url: entity.url || (entity.type === "person" ? `/people/${entity.slug}/` : `/history/${entity.slug}/`),
    wikiUrl: entity.wikiUrl || "",
    imageUrl: entity.imageUrl || "",
    summary: entity.summary || entity.description || "",
    relatedPosts: Array.isArray(entity.relatedPosts) ? entity.relatedPosts : [],
    updatedAt: entity.updatedAt || new Date().toISOString(),
    indexable: entityBodyWordCount(entity) >= minWords,
    ...(entity.needsWikiRefresh ? { needsWikiRefresh: true } : {}),
  };
  const byId = new Map(index.map((entry) => [`${entry.type}:${entry.slug}`, entry]));
  byId.set(`${nextEntry.type}:${nextEntry.slug}`, {
    ...(byId.get(`${nextEntry.type}:${nextEntry.slug}`) || {}),
    ...nextEntry,
  });
  await env.BLOG_AI_KV.put(
    "entity-index-v1",
    JSON.stringify([...byId.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)))),
  );
}

async function refreshEntityIndexFromStoredEntities(env, index, typeFilter = "person") {
  if (!env.BLOG_AI_KV || !Array.isArray(index)) return index;
  let changed = false;
  const refreshed = [];
  for (const entry of index) {
    if (entry?.type !== typeFilter || !entry.slug) {
      refreshed.push(entry);
      continue;
    }
    const raw = await env.BLOG_AI_KV.get(entityKey(entry.type, entry.slug)).catch(() => null);
    if (!raw) {
      refreshed.push(entry);
      continue;
    }
    try {
      const entity = JSON.parse(raw);
      const minWords = entity.type === "person" ? MIN_PERSON_ENTITY_BODY_WORDS : MIN_EVENT_ENTITY_BODY_WORDS;
      const next = {
        ...entry,
        name: entity.name || entry.name,
        url: entity.url || entry.url,
        wikiUrl: entity.wikiUrl || entry.wikiUrl || "",
        imageUrl: entity.imageUrl || entry.imageUrl || "",
        summary: entity.summary || entity.description || entry.summary || "",
        relatedPosts: Array.isArray(entity.relatedPosts) ? entity.relatedPosts : (entry.relatedPosts || []),
        updatedAt: entity.updatedAt || entry.updatedAt,
        indexable: entityBodyWordCount(entity) >= minWords,
      };
      if (next.indexable) delete next.needsWikiRefresh;
      if (JSON.stringify(next) !== JSON.stringify(entry)) changed = true;
      refreshed.push(next);
    } catch {
      refreshed.push(entry);
    }
  }
  if (changed) {
    const sorted = refreshed.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    await env.BLOG_AI_KV.put("entity-index-v1", JSON.stringify(sorted)).catch(() => {});
    return sorted;
  }
  return refreshed;
}

function stripGenericEntityContextSections(sections) {
  return (Array.isArray(sections) ? sections : []).filter((section) => {
    const heading = String(section?.heading || "").toLowerCase();
    const text = (Array.isArray(section?.paragraphs) ? section.paragraphs : [])
      .join(" ")
      .toLowerCase();
    return !(
      heading.includes("biographical notes") ||
      text.includes("is included here because") ||
      text.includes("the page is designed to give readers") ||
      text.includes("for thisday readers, the point is navigation") ||
      text.includes("is described in the source record as")
    );
  });
}

function entityFactParagraphs(entity) {
  const name = entity.name || "This person";
  const seen = new Set();
  const normalizeSentence = (value) =>
    String(value || "")
      .replace(/\s+/g, " ")
      .replace(/\(\s*([^)]*?)\s*$/, "")
      .trim();
  const addSentences = (value, target) => {
    const sentences = cleanWikiExtract(value)
      .match(/[^.!?]+[.!?]+(?:\s|$)/g) || [];
    for (const sentence of sentences) {
      const clean = normalizeSentence(sentence);
      const key = clean.toLowerCase();
      if (clean.length < 35 || seen.has(key)) continue;
      seen.add(key);
      target.push(clean);
    }
  };

  const facts = [];
  addSentences(entity.intro, facts);
  addSentences(entity.summary, facts);
  for (const card of Array.isArray(entity.overviewCards) ? entity.overviewCards : []) {
    addSentences(card?.value, facts);
  }

  const lifeLine = entity.birthDate && entity.deathDate
    ? `${name} lived from ${entity.birthDate} to ${entity.deathDate}.`
    : entity.birthDate
      ? `${name} was born on ${entity.birthDate}.`
      : entity.deathDate
        ? `${name} died on ${entity.deathDate}.`
        : "";

  const paragraphs = [];
  if (lifeLine || facts[0]) {
    paragraphs.push([lifeLine, facts[0]].filter(Boolean).join(" "));
  }
  if (facts.length > 1) paragraphs.push(facts.slice(1, 4).join(" "));
  if (facts.length > 4) paragraphs.push(facts.slice(4, 7).join(" "));

  return paragraphs
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.split(/\s+/).length >= 18);
}

function ensureEntityContextSections(entity, type) {
  const minWords = type === "person" ? MIN_PERSON_ENTITY_BODY_WORDS : MIN_EVENT_ENTITY_BODY_WORDS;
  const bodySections = stripGenericEntityContextSections(entity.bodySections);
  const currentWords = entityBodyWordCount({ bodySections });
  if (currentWords >= minWords) return bodySections;

  const name = entity.name || (type === "person" ? "This person" : "This event");
  const sourcePost = entity.sourcePostTitle || "the related thisDay article";
  const relatedTopics = Array.isArray(entity.relatedTopics) && entity.relatedTopics.length
    ? entity.relatedTopics.join(", ")
    : "the wider historical setting";

  if (type === "person") {
    if (bodySections.length > 0 && currentWords >= 35) return bodySections;
    const factualParagraphs = entityFactParagraphs(entity);
    bodySections.push({
      heading: `${name}: biographical notes`,
      paragraphs: factualParagraphs.length
        ? factualParagraphs
        : [
            `${name} is connected with ${sourcePost}. ${entity.description ? `${name} is described as ${entity.description}.` : ""}`.trim(),
          ].filter(Boolean),
    });
  } else {
    bodySections.push({
      heading: `${name} in context`,
      paragraphs: [
        `${name} is included here as a connected history page for ${sourcePost}. The page gathers the article link, source material, and topic context so readers can move from one date-based story into the wider background.`,
        `The surrounding themes include ${relatedTopics}. Those links help explain why the event remains useful beyond its date: it connects people, institutions, consequences, and later memory in one navigable place.`,
      ],
    });
  }

  return bodySections;
}

function syncEntitySourcePostFromIndex(entity, posts) {
  if (!entity || !Array.isArray(posts)) return entity;
  const relatedSlug =
    (Array.isArray(entity.relatedPosts) && entity.relatedPosts[0]) ||
    String(entity.sourcePostUrl || "").match(/\/blog\/([^/]+)\//)?.[1] ||
    "";
  const sourcePost = relatedSlug
    ? posts.find((post) => post?.slug === relatedSlug)
    : null;
  if (!sourcePost?.title) return entity;

  const previousTitle = entity.sourcePostTitle || "";
  if (previousTitle === sourcePost.title) return entity;

  entity.sourcePostTitle = sourcePost.title;
  entity.sourcePostUrl = entity.sourcePostUrl || `/blog/${sourcePost.slug}/`;
  entity.updatedAt = new Date().toISOString();
  entity._sourcePostSynced = true;

  const replaceTitle = (value) =>
    previousTitle
      ? String(value || "").replaceAll(previousTitle, sourcePost.title)
      : value;

  if (Array.isArray(entity.bodySections)) {
    entity.bodySections = entity.bodySections.map((section) => ({
      ...section,
      paragraphs: Array.isArray(section.paragraphs)
        ? section.paragraphs.map(replaceTitle)
        : section.paragraphs,
    }));
  }
  if (Array.isArray(entity.overviewCards)) {
    entity.overviewCards = entity.overviewCards.map((card) => ({
      ...card,
      value: replaceTitle(card.value),
    }));
  }
  return entity;
}

async function hydrateSparseEntity(env, entity, type, ctx) {
  entity.bodySections = stripGenericEntityContextSections(entity.bodySections);
  const minWords = type === "person" ? MIN_PERSON_ENTITY_BODY_WORDS : MIN_EVENT_ENTITY_BODY_WORDS;
  const bodyWords = entityBodyWordCount(entity);
  const hasWikiMarkup = /={2,}[^=]+={2,}/.test(`${entity.intro || ""} ${entity.summary || ""}`);
  const sparse = !entity.intro || !entity.summary || !entity.imageUrl || bodyWords < minWords || hasWikiMarkup;
  if (!sparse || !entity.wikiUrl) return entity;

  const wiki = await fetchEntityWikiHydration(entity, type).catch(() => ({}));
  const hydrated = {
    ...entity,
    type,
    summary: cleanWikiExtract(entity.summary || wiki.summary || ""),
    intro: cleanWikiExtract(hasWikiMarkup ? (wiki.intro || wiki.summary || entity.intro) : (entity.intro || wiki.intro || wiki.summary || "")),
    description: entity.description || wiki.description || "",
    imageUrl: entity.imageUrl || wiki.imageUrl || "",
    birthDate: entity.birthDate || wiki.birthDate || "",
    deathDate: entity.deathDate || wiki.deathDate || "",
    updatedAt: new Date().toISOString(),
  };
  if (bodyWords < minWords || hasWikiMarkup) {
    hydrated.bodySections = splitEntityHydratedSections(hydrated);
  }
  hydrated.bodySections = ensureEntityContextSections(hydrated, type);
  if (hydrated.intro || hydrated.summary) delete hydrated.needsWikiRefresh;

  const write = env.BLOG_AI_KV
    ? Promise.all([
        env.BLOG_AI_KV.put(entityKey(type, hydrated.slug), JSON.stringify(hydrated)),
        updateEntityIndexEntry(env, hydrated),
      ]).catch(() => {})
    : null;
  if (ctx?.waitUntil && write) ctx.waitUntil(write);
  else if (write) await write;
  return hydrated;
}

async function handleEntityPage(request, env, url, type, slug, ctx) {
  const raw = await env.BLOG_AI_KV?.get(entityKey(type, slug)).catch(() => null);
  if (!raw) {
    return fetch(request);
  }
  let entity = JSON.parse(raw);
  const posts = await getBlogIndexEntries(env);
  entity = syncEntitySourcePostFromIndex(entity, posts);
  entity = await hydrateSparseEntity(env, entity, type, ctx);
  const indexWrite = updateEntityIndexEntry(env, entity).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(indexWrite);
  else await indexWrite;
  if (entity._sourcePostSynced) {
    delete entity._sourcePostSynced;
    const write = env.BLOG_AI_KV?.put(entityKey(type, entity.slug), JSON.stringify(entity)).catch(() => {});
    if (ctx?.waitUntil && write) ctx.waitUntil(write);
  }
  const title = `${entity.name} | thisDay.`;
  const canonical = `${url.origin}${entity.url || url.pathname}`;
  const descriptionBase = type === "person"
    ? `Explore ${entity.name} through thisDay articles, biographical context, source links, and related historical coverage.`
    : (entity.summary || entity.description || `Explore ${entity.name} through thisDay articles, sources, and related history.`);
  const description = descriptionBase
    .replace(/\s+/g, " ")
    .slice(0, 155);
  const imageUrl = entity.imageUrl
    ? `${url.origin}/image-proxy?src=${encodeURIComponent(entity.imageUrl)}&w=1200&h=630&fit=cover&q=85`
    : `${url.origin}/images/logo.png`;
  const bodySectionWords = entityBodyWordCount(entity);
  const minEntityWords = type === "person" ? MIN_PERSON_ENTITY_BODY_WORDS : MIN_EVENT_ENTITY_BODY_WORDS;
  const robotsMeta = bodySectionWords >= minEntityWords
    ? "index, follow, max-image-preview:large"
    : "noindex, follow";
  const schemaType = type === "person" ? "Person" : "Event";
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": schemaType,
    name: entity.name,
    url: canonical,
    sameAs: entity.wikiUrl || undefined,
    description,
    image: imageUrl,
    ...(type === "person" && entity.birthDate ? { birthDate: entity.birthDate } : {}),
    ...(type === "person" && entity.deathDate ? { deathDate: entity.deathDate } : {}),
  });
  const breadcrumbLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${url.origin}/` },
      { "@type": "ListItem", position: 2, name: type === "person" ? "People" : "History", item: `${url.origin}${type === "person" ? "/people/" : "/history/"}` },
      { "@type": "ListItem", position: 3, name: entity.name, item: canonical },
    ],
  });
  const imageFigure = entity.imageUrl
    ? `<figure class="entity-hero-image text-center mb-4">
        <img src="/image-proxy?src=${encodeURIComponent(entity.imageUrl)}&w=900&q=85" class="img-fluid rounded" alt="${escapeHtml(entity.name)}" loading="eager" />
        <figcaption class="article-meta mt-2"><small>Image via Wikimedia Commons or Wikipedia.</small></figcaption>
      </figure>`
    : "";
  const topicPills = Array.isArray(entity.relatedTopics) && entity.relatedTopics.length > 0
    ? `<div class="pillar-pill-row mt-3">${entity.relatedTopics
        .map(
          (topic, index) =>
            `<span class="pillar-pill${index === 0 ? " pillar-pill-featured" : ""}">${escapeHtml(topic)}</span>`,
        )
        .join("")}</div>`
    : "";
  const sourceLinks = `<div class="authority-links mt-4">
    <span class="authority-links-label">Sources and Links</span>
    <div class="authority-links-row">
      ${entity.sourcePostUrl ? `<a class="authority-link" href="${escapeHtml(entity.sourcePostUrl)}">Read the article</a>` : ""}
      ${entity.wikiUrl ? `<a class="authority-link" href="${escapeHtml(entity.wikiUrl)}" target="_blank" rel="noopener">Wikipedia source</a>` : ""}
    </div>
  </div>`;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <link rel="canonical" href="${escapeHtml(canonical)}" />
  <meta name="robots" content="${robotsMeta}" />
  <meta name="description" content="${escapeHtml(description)}" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:type" content="${type === "person" ? "profile" : "article"}" />
  <meta property="og:url" content="${escapeHtml(canonical)}" />
  <meta property="og:image" content="${escapeHtml(imageUrl)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <script type="application/ld+json">${jsonLd}</script>
  <script type="application/ld+json">${breadcrumbLd}</script>
  <link rel="icon" href="/images/favicon.ico" />
  <link rel="apple-touch-icon" href="/images/apple-touch-icon.png" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" />
  <link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/css/style.css" />
  <link rel="stylesheet" href="/css/custom.css" />
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8565025017387209" crossorigin="anonymous"></script>
  <style>
    :root{--bg:#ffffff;--bg-alt:#f2f7f2;--text:#1a2e20;--text-muted:#5c7a65;--border:#cfe0cf;--btn-bg:#1b3a2d;--btn-text:#fff;--btn-hover:#2a4d3a;--accent:#9dc43a}
    body{font-family:Lora,serif;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--text)}main{flex:1;margin-top:20px}p{font-size:15px;line-height:1.6}a{color:var(--btn-bg)}a:hover{color:var(--accent)}h1,h2,h3{color:var(--text)}.article-meta{color:var(--text-muted);font-size:13px}.breadcrumb{background:transparent;padding:0;margin-bottom:1rem}.breadcrumb-item a{color:var(--btn-bg)}.breadcrumb-item.active{color:var(--text-muted)}
    .pillar-pill-row{display:flex;flex-wrap:wrap;gap:10px;justify-content:center}.pillar-pill{display:inline-flex;align-items:center;justify-content:center;padding:7px 14px;border:1px solid var(--border);border-radius:999px;background:var(--bg-alt);color:var(--btn-bg);font-size:13px;text-decoration:none}.pillar-pill-featured{background:var(--btn-bg);border-color:var(--btn-bg);color:#fff}
    .dyn-slider-wrap{overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none}.dyn-slider-wrap::-webkit-scrollbar{display:none}.dyn-slider-track{display:flex;gap:14px;padding-bottom:4px}.dyn-slide{flex:0 0 240px;max-width:240px;min-height:220px;scroll-snap-align:start;background:var(--btn-bg);color:#fff;padding:2rem 1.75rem;display:flex;flex-direction:column;justify-content:center;gap:1rem;border-radius:10px}.dyn-slide img,.dyn-slide figure,.dyn-slider-wrap figure{display:none!important}.dyn-slide p{font-size:15px;line-height:1.6;color:var(--accent);margin:0}.dyn-slide .dyn-fact{font-size:15px;color:#fff;margin:0;line-height:1.6}.slider-controls{display:flex;justify-content:flex-end;gap:8px;margin:0 0 10px}.slider-btn{width:38px;height:38px;border:1px solid var(--border);border-radius:50%;background:#fff;color:var(--btn-bg);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}.slider-btn:hover{border-color:var(--btn-bg);background:var(--bg-alt)}.slider-btn:disabled{opacity:.35;cursor:default}
    .entity-hero-image img{max-width:100%;height:auto;display:block;margin:0 auto;border-radius:8px}.entity-body{border-top:1px solid var(--border);padding-top:1.5rem}.entity-body-section+ .entity-body-section{margin-top:1.75rem}.entity-body p{font-size:16px;line-height:1.75;margin-bottom:1rem}.authority-links{background:var(--bg-alt);border:1px solid var(--border);border-radius:10px;padding:14px 16px}.authority-links-label{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted);display:block;margin-bottom:10px}.authority-links-row{display:flex;flex-wrap:wrap;gap:8px}.authority-link{display:inline-flex;align-items:center;padding:6px 12px;border:1px solid var(--border);border-radius:999px;font-size:13px;color:var(--btn-bg);background:#fff;text-decoration:none}.authority-link:hover{background:var(--bg-alt);border-color:var(--btn-bg);text-decoration:none}
    .amazon-related{background:var(--bg-alt);border:1px solid var(--border);border-radius:10px}.amazon-related-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px}.amazon-kicker{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted)}.amazon-slider-shell{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:center}.amazon-slider-btn{display:none;align-items:center;justify-content:center;width:34px;height:34px;border:1px solid var(--border);border-radius:999px;background:#fff;color:var(--btn-bg);font-size:18px;line-height:1;cursor:pointer}.amazon-slider-btn:hover{border-color:var(--btn-bg);background:#f9fbf7}.amazon-slider-wrap{overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none}.amazon-slider-wrap::-webkit-scrollbar{display:none}.amazon-slider-track{display:flex;gap:10px;padding:2px 0 4px}.amazon-product-card{flex:0 0 170px;min-height:240px;display:flex;flex-direction:column;justify-content:space-between;gap:8px;padding:10px;border:1px solid var(--border);border-radius:8px;background:#fff;color:var(--btn-bg);font-size:14px;line-height:1.35;text-decoration:none;scroll-snap-align:start}.amazon-product-card:hover{border-color:var(--btn-bg);background:#f9fbf7;text-decoration:none}.amazon-product-card strong{font-size:14px;color:var(--text);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.amazon-product-card small{color:var(--text-muted)}.amazon-card-cover{height:150px;border:1px solid var(--border);border-radius:7px;background:#f9fbf7;display:flex;align-items:center;justify-content:center;overflow:hidden}.amazon-card-cover img{width:100%;height:100%;object-fit:cover;display:block}@media(min-width:768px){.amazon-slider-btn{display:inline-flex}}@media(max-width:767px){.amazon-slider-shell{grid-template-columns:minmax(0,1fr)}}
    .entity-grid{display:grid;grid-template-columns:1fr;gap:14px}@media(min-width:720px){.entity-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}.entity-card{padding:16px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.72);text-decoration:none;color:inherit}.entity-card:hover{background:var(--bg-alt);text-decoration:none;color:inherit}.border{border:1px solid var(--border)!important;box-shadow:none}.nav-inner{max-width:1920px!important;margin:0 auto!important}
    .entity-description{font-size:1rem;color:var(--text-muted);font-style:italic;line-height:1.4}.entity-dates{font-size:13px;color:var(--text-muted)}
    ${NAV_CSS}
    ${FOOTER_CSS}
  </style>
</head>
<body>
${siteNav()}
<main class="container my-5">
  <div class="row justify-content-center">
    <div class="col-lg-10 col-xl-8">
      <nav aria-label="breadcrumb" class="mb-3"><ol class="breadcrumb"><li class="breadcrumb-item"><a href="/">Home</a></li><li class="breadcrumb-item"><a href="${type === "person" ? "/people/" : "/history/"}">${type === "person" ? "People" : "History"}</a></li><li class="breadcrumb-item active" aria-current="page">${escapeHtml(entity.name)}</li></ol></nav>
      <article class="p-4 rounded border" style="background-color:var(--bg);color:var(--text)">
        <header class="mb-4 text-center">
          <h1 class="mb-2 fw-bold">${escapeHtml(entity.name)}</h1>
          ${entity.description ? `<p class="entity-description mb-1">${escapeHtml(entity.description)}</p>` : ""}
          ${type === "person" && (entity.birthDate || entity.deathDate) ? `<p class="entity-dates article-meta mb-2">${[entity.birthDate ? `Born: ${escapeHtml(entity.birthDate)}` : "", entity.deathDate ? `Died: ${escapeHtml(entity.deathDate)}` : ""].filter(Boolean).join(" &nbsp;·&nbsp; ")}</p>` : ""}
          ${topicPills}
        </header>
        ${imageFigure}
        ${buildEntityOverviewSlider(entity)}
        ${buildEntityBodySections(entity)}
        ${buildEntityAdUnits()}
        ${buildEntityRelatedPosts(entity, posts)}
        ${sourceLinks}
      </article>
    </div>
  </div>
</main>
${siteFooter("yr")}
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
<script>
${navToggleScript()}
${footerYearScript("yr")}
document.querySelectorAll(".dyn-slider-wrap").forEach(function(slider){
  if (slider.dataset.controlsReady) return;
  slider.dataset.controlsReady = "1";
  slider.setAttribute("tabindex", "0");
  var controls = document.createElement("div");
  controls.className = "slider-controls";
  var prev = document.createElement("button");
  var next = document.createElement("button");
  prev.className = next.className = "slider-btn";
  prev.type = next.type = "button";
  prev.setAttribute("aria-label", "Previous overview cards");
  next.setAttribute("aria-label", "Next overview cards");
  prev.innerHTML = "&larr;";
  next.innerHTML = "&rarr;";
  controls.append(prev, next);
  slider.parentNode.insertBefore(controls, slider);
  function update(){
    prev.disabled = slider.scrollLeft <= 2;
    next.disabled = slider.scrollLeft + slider.clientWidth >= slider.scrollWidth - 2;
  }
  function move(direction){
    slider.scrollBy({ left: direction * Math.max(260, Math.floor(slider.clientWidth * 0.85)), behavior: "smooth" });
  }
  prev.addEventListener("click", function(){ move(-1); });
  next.addEventListener("click", function(){ move(1); });
  slider.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  update();
});
(function(){
  document.querySelectorAll("[data-entity-book-slot]").forEach(function(slot){
    if(slot.dataset.loaded==="true")return;
    slot.dataset.loaded="true";
    var slider=slot.querySelector(".amazon-related");
    var track=slot.querySelector(".amazon-slider-track");
    var fallback=slot.querySelector(".entity-book-fallback");
    var careerAd=document.querySelector(".entity-career-ad");
    var query=slot.dataset.query||"biography history";
    var keywords=(slot.dataset.keywords||"").split(/\s+/).filter(Boolean);
    var tag=slot.dataset.amazonTag||"thisday0c-20";
    function escText(value){var s=String(value||"");return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");}
    function amazonUrl(title,author){return "https://www.amazon.com/s?k="+encodeURIComponent([title,author].filter(Boolean).join(" "))+"&tag="+encodeURIComponent(tag);}
    function pushVisibleAds(){
      if(location.hostname !== "thisday.info" && location.hostname !== "www.thisday.info") return;
      document.querySelectorAll("ins.adsbygoogle").forEach(function(ins){
        if(ins.getAttribute("data-adsbygoogle-status") || ins.getAttribute("data-ad-pushed")) return;
        if((ins.offsetWidth || 0) === 0) return;
        ins.setAttribute("data-ad-pushed", "1");
        try{ (adsbygoogle = window.adsbygoogle || []).push({}); }catch(e){}
      });
    }
    function showFallback(){
      if(fallback)fallback.style.display="";
      if(careerAd)careerAd.remove();
      pushVisibleAds();
    }
    fetch("https://openlibrary.org/search.json?q="+encodeURIComponent(query)+"&mode=books&limit=10&fields=title,author_name,cover_i,subject")
      .then(function(res){return res.ok?res.json():null;})
      .then(function(data){
        var docs=((data&&data.docs)||[]).filter(function(doc){
          if(!doc||!doc.title)return false;
          var hay=[doc.title,(doc.author_name&&doc.author_name[0])||"",((doc.subject||[]).slice(0,8).join(" "))].join(" ").toLowerCase();
          return !keywords.length||keywords.some(function(word){return hay.indexOf(word)!==-1;});
        }).slice(0,5);
        if(docs.length<1){showFallback();return;}
        track.innerHTML=docs.map(function(doc){
          var author=(doc.author_name&&doc.author_name[0])||"";
          var title=doc.title||"Related book";
          var cover=doc.cover_i?"https://covers.openlibrary.org/b/id/"+doc.cover_i+"-M.jpg":"";
          return '<a class="amazon-product-card" href="'+amazonUrl(title,author)+'" target="_blank" rel="sponsored noopener noreferrer">'+
            (cover?'<span class="amazon-card-cover"><img src="'+cover+'" alt="'+escText(title)+' cover" loading="lazy"></span>':'<span class="amazon-card-cover amazon-card-cover-fallback" aria-hidden="true"><i class="bi bi-book"></i></span>')+
            '<strong>'+escText(title)+'</strong>'+
            (author?'<small>'+escText(author)+'</small>':'<small>View on Amazon</small>')+
          '</a>';
        }).join("");
        if(fallback)fallback.remove();
        if(slider)slider.style.display="";
        pushVisibleAds();
      })
      .catch(showFallback);
  });
})();
(function(){
  if(location.hostname !== "thisday.info" && location.hostname !== "www.thisday.info") return;
  function pushAds(){
    document.querySelectorAll("ins.adsbygoogle").forEach(function(ins){
      if(ins.getAttribute("data-adsbygoogle-status") || ins.getAttribute("data-ad-pushed")) return;
      if((ins.offsetWidth || 0) === 0) return;
      ins.setAttribute("data-ad-pushed", "1");
      try{ (adsbygoogle = window.adsbygoogle || []).push({}); }catch(e){}
    });
  }
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", pushAds, { once: true });
  else pushAds();
  setTimeout(pushAds, 1200);
})();
</script>
${marqueeScript()}
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}

function getHistoricalYearFromPost(post) {
  if (Number.isInteger(post?.historicalYear)) return post.historicalYear;

  const title = String(post?.title || "");
  const titleYearMatch = title.match(/,\s*(-?\d{3,4})\s*$/);
  if (titleYearMatch) return parseInt(titleYearMatch[1], 10);

  const desc = String(post?.description || "");
  const descYearMatch = desc.match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
  if (descYearMatch) return parseInt(descYearMatch[1], 10);

  return null;
}

function normalizeKeywordLabel(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function getKeywordPhrasesFromPost(post) {
  const phrases = [];
  const pushPhrase = (value) => {
    const cleaned = normalizeKeywordLabel(value);
    if (!cleaned) return;
    if (/^\d{4}$/.test(cleaned)) return;
    if (cleaned.length < 3 || cleaned.length > 50) return;
    if (/^(history|historical|event|events|article|articles)$/i.test(cleaned)) return;
    phrases.push(cleaned);
  };

  if (typeof post?.keywords === "string" && post.keywords.trim()) {
    for (const keyword of post.keywords.split(",")) pushPhrase(keyword);
  }

  if (Array.isArray(post?.keyTerms)) {
    for (const term of post.keyTerms) pushPhrase(term?.term || "");
  }

  if (post?.eventTitle) pushPhrase(post.eventTitle);

  const title = String(post?.title || "");
  const titleLead = title.split("—")[0].trim();
  if (titleLead && titleLead !== title) pushPhrase(titleLead);

  if (Array.isArray(post?.pillars) && post.pillars.length > 0) {
    pushPhrase(post.pillars[0]);
  }

  const deduped = [];
  const seen = new Set();
  for (const phrase of phrases) {
    const slug = slugifyArchiveLabel(phrase);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    deduped.push({ label: phrase, slug });
  }
  return deduped.slice(0, 8);
}

function buildYearArchiveEntries(posts) {
  const map = new Map();
  for (const post of posts) {
    const year = getHistoricalYearFromPost(post);
    if (!year) continue;
    if (!map.has(year)) map.set(year, []);
    map.get(year).push(post);
  }

  return Array.from(map.entries())
    .map(([year, yearPosts]) => ({
      year,
      posts: yearPosts.sort(
        (a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0),
      ),
    }))
    .sort((a, b) => b.year - a.year);
}

function buildKeywordArchiveEntries(posts) {
  const map = new Map();
  for (const post of posts) {
    for (const keyword of getKeywordPhrasesFromPost(post)) {
      if (!map.has(keyword.slug)) {
        map.set(keyword.slug, { slug: keyword.slug, label: keyword.label, posts: [] });
      }
      map.get(keyword.slug).posts.push(post);
    }
  }

  return Array.from(map.values())
    .map((entry) => ({
      ...entry,
      posts: entry.posts
        .filter(
          (post, idx, arr) =>
            arr.findIndex((candidate) => candidate.slug === post.slug) === idx,
        )
        .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0)),
    }))
    .filter((entry) => entry.posts.length > 0)
    .sort((a, b) => {
      if (b.posts.length !== a.posts.length) return b.posts.length - a.posts.length;
      return a.label.localeCompare(b.label);
    });
}

function renderArchiveCards(items, options = {}) {
  const {
    makeHref,
    makeLabel,
    makeMeta,
    emptyText = "No archive entries available yet.",
  } = options;

  if (!items.length) {
    return `<div class="card-box"><p class="text-muted mb-0">${escapeHtml(emptyText)}</p></div>`;
  }

  return items
    .map((item) => `<article class="card-box">
      <h2 class="h4 mb-2"><a href="${escapeHtml(makeHref(item))}" style="color:inherit;text-decoration:none">${escapeHtml(makeLabel(item))}</a></h2>
      <p class="text-muted mb-3" style="font-size:.9rem">${escapeHtml(makeMeta(item))}</p>
      <a href="${escapeHtml(makeHref(item))}" class="site-btn site-btn-primary">Open archive</a>
    </article>`)
    .join("");
}

async function handleYearsIndex(env, url) {
  const posts = await getBlogIndexEntries(env);
  const yearEntries = buildYearArchiveEntries(posts);
  const canonical = `${url.origin}/years/`;
  const pageTitle = "Years | thisDay.";
  const pageDesc =
    "Browse thisDay.info historical articles by event year to explore connected coverage across eras.";
  const schema = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: pageTitle,
    url: canonical,
    description: pageDesc,
    about: { "@type": "Thing", name: "Historical year archives" },
  };

  const html = `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${pageTitle}</title>
<link rel="canonical" href="${escapeHtml(canonical)}"/>
<meta name="robots" content="index, follow"/>
<meta name="description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:title" content="${escapeHtml(pageTitle)}"/>
<meta property="og:description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="${escapeHtml(canonical)}"/>
<meta property="og:site_name" content="thisDay."/>
<meta property="og:image" content="${escapeHtml(`${url.origin}/images/logo.png`)}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${escapeHtml(pageTitle)}"/>
<meta name="twitter:description" content="${escapeHtml(pageDesc)}"/>
<meta name="twitter:image" content="${escapeHtml(`${url.origin}/images/logo.png`)}"/>
<script type="application/ld+json">${JSON.stringify(schema)}</script>
<link rel="icon" href="/images/favicon.ico" type="image/x-icon"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"/>
<link rel="stylesheet" href="/css/style.css"/>
<link rel="stylesheet" href="/css/custom.css"/>
<style>${getSharedPageStyles()}</style>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8565025017387209" crossorigin="anonymous"></script>
</head>
<body>
${siteNav()}
<main class="container my-4" style="max-width:860px">
  <nav aria-label="breadcrumb" class="mb-3">
    <ol class="breadcrumb">
      <li class="breadcrumb-item"><a href="/">Home</a></li>
      <li class="breadcrumb-item active" aria-current="page">Years</li>
    </ol>
  </nav>
  <section class="ai-answer-card">
    <div class="ai-answer-kicker">Archive hub</div>
    <h1 class="h3 mb-2">Browse historical coverage by year</h1>
    <p class="mb-0">Use year archives to move from one cited event into the broader historical moment around it.</p>
  </section>
  ${renderArchiveCards(yearEntries.slice(0, 80), {
    makeHref: (item) => `/years/${item.year}/`,
    makeLabel: (item) => String(item.year),
    makeMeta: (item) => `${item.posts.length} matched article${item.posts.length === 1 ? "" : "s"}`,
    emptyText: "No year archives available yet.",
  })}
  <div class="ad-unit my-4">
    <div class="ad-unit-label">Advertisement</div>
    <ins class="adsbygoogle" style="display:block;border-radius:8px;overflow:hidden"
         data-ad-client="ca-pub-8565025017387209" data-ad-slot="9477779891"
         data-ad-format="auto" data-full-width-responsive="true"></ins>
  </div>
  <div class="ad-unit-container my-4">
    <span class="ad-unit-label">Advertisement</span>
    <ins class="adsbygoogle" style="display:block" data-ad-format="autorelaxed"
         data-ad-client="ca-pub-8565025017387209" data-ad-slot="9183511632"></ins>
  </div>
</main>
${siteFooter("yr")}
${getSharedPageScripts({ pageType: "years-index", pageSlug: "years" })}
</body></html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=1800",
    },
  });
}

async function handleYearArchivePage(env, url, year) {
  const posts = await getBlogIndexEntries(env);
  const yearEntry = buildYearArchiveEntries(posts).find((entry) => entry.year === year);
  if (!yearEntry) return new Response("Not Found", { status: 404 });

  const canonical = `${url.origin}/years/${year}/`;
  const pageTitle = `${year} | thisDay.`;
  const pageDesc = `Historical articles on thisDay.info connected to the year ${year}.`;
  const schema = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: pageTitle,
    url: canonical,
    description: pageDesc,
    about: { "@type": "Thing", name: `History in ${year}` },
  };

  const html = `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${escapeHtml(pageTitle)}</title>
<link rel="canonical" href="${escapeHtml(canonical)}"/>
<meta name="robots" content="index, follow"/>
<meta name="description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:title" content="${escapeHtml(pageTitle)}"/>
<meta property="og:description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="${escapeHtml(canonical)}"/>
<meta property="og:site_name" content="thisDay."/>
<meta property="og:image" content="${escapeHtml(`${url.origin}/images/logo.png`)}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${escapeHtml(pageTitle)}"/>
<meta name="twitter:description" content="${escapeHtml(pageDesc)}"/>
<meta name="twitter:image" content="${escapeHtml(`${url.origin}/images/logo.png`)}"/>
<script type="application/ld+json">${JSON.stringify(schema)}</script>
<link rel="icon" href="/images/favicon.ico" type="image/x-icon"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"/>
<link rel="stylesheet" href="/css/style.css"/>
<link rel="stylesheet" href="/css/custom.css"/>
<style>${getSharedPageStyles()}</style>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8565025017387209" crossorigin="anonymous"></script>
</head>
<body>
${siteNav()}
<main class="container my-4" style="max-width:860px">
  <nav aria-label="breadcrumb" class="mb-3">
    <ol class="breadcrumb">
      <li class="breadcrumb-item"><a href="/">Home</a></li>
      <li class="breadcrumb-item"><a href="/years/">Years</a></li>
      <li class="breadcrumb-item active" aria-current="page">${year}</li>
    </ol>
  </nav>
  <section class="ai-answer-card">
    <div class="ai-answer-kicker">Year archive</div>
    <h1 class="h3 mb-2">${year} in the thisDay.info archive</h1>
    <p class="mb-0">${yearEntry.posts.length} article${yearEntry.posts.length === 1 ? "" : "s"} currently connect to this historical year.</p>
  </section>
  ${renderTopicHubPostCards(yearEntry.posts)}
  <div class="ad-unit my-4">
    <div class="ad-unit-label">Advertisement</div>
    <ins class="adsbygoogle" style="display:block;border-radius:8px;overflow:hidden"
         data-ad-client="ca-pub-8565025017387209" data-ad-slot="9477779891"
         data-ad-format="auto" data-full-width-responsive="true"></ins>
  </div>
  <div class="ad-unit-container my-4">
    <span class="ad-unit-label">Advertisement</span>
    <ins class="adsbygoogle" style="display:block" data-ad-format="autorelaxed"
         data-ad-client="ca-pub-8565025017387209" data-ad-slot="9183511632"></ins>
  </div>
</main>
${siteFooter("yr")}
${getSharedPageScripts({ pageType: "year-archive", pageSlug: String(year) })}
</body></html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=1800",
    },
  });
}

async function handleKeywordsIndex(env, url) {
  const posts = await getBlogIndexEntries(env);
  const keywordEntries = buildKeywordArchiveEntries(posts).filter(
    (entry) => entry.posts.length >= 1,
  );
  const canonical = `${url.origin}/keywords/`;
  const pageTitle = "Keywords | thisDay.";
  const pageDesc =
    "Browse thisDay.info articles by recurring historical subject, named entity, or archive keyword cluster.";
  const schema = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: pageTitle,
    url: canonical,
    description: pageDesc,
    about: { "@type": "Thing", name: "Historical keyword archives" },
  };

  const html = `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${pageTitle}</title>
<link rel="canonical" href="${escapeHtml(canonical)}"/>
<meta name="robots" content="index, follow"/>
<meta name="description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:title" content="${escapeHtml(pageTitle)}"/>
<meta property="og:description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="${escapeHtml(canonical)}"/>
<meta property="og:site_name" content="thisDay."/>
<meta property="og:image" content="${escapeHtml(`${url.origin}/images/logo.png`)}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${escapeHtml(pageTitle)}"/>
<meta name="twitter:description" content="${escapeHtml(pageDesc)}"/>
<meta name="twitter:image" content="${escapeHtml(`${url.origin}/images/logo.png`)}"/>
<script type="application/ld+json">${JSON.stringify(schema)}</script>
<link rel="icon" href="/images/favicon.ico" type="image/x-icon"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"/>
<link rel="stylesheet" href="/css/style.css"/>
<link rel="stylesheet" href="/css/custom.css"/>
<style>${getSharedPageStyles()}</style>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8565025017387209" crossorigin="anonymous"></script>
</head>
<body>
${siteNav()}
<main class="container my-4" style="max-width:860px">
  <nav aria-label="breadcrumb" class="mb-3">
    <ol class="breadcrumb">
      <li class="breadcrumb-item"><a href="/">Home</a></li>
      <li class="breadcrumb-item active" aria-current="page">Keywords</li>
    </ol>
  </nav>
  <section class="ai-answer-card">
    <div class="ai-answer-kicker">Archive hub</div>
    <h1 class="h3 mb-2">Browse historical coverage by keyword cluster</h1>
    <p class="mb-0">Keyword archives connect related articles around recurring names, subjects, and historical phrases.</p>
  </section>
  ${renderArchiveCards(keywordEntries.slice(0, 120), {
    makeHref: (item) => `/keywords/${item.slug}/`,
    makeLabel: (item) => item.label,
    makeMeta: (item) => `${item.posts.length} matched article${item.posts.length === 1 ? "" : "s"}`,
    emptyText: "No keyword archives available yet.",
  })}
  <div class="ad-unit my-4">
    <div class="ad-unit-label">Advertisement</div>
    <ins class="adsbygoogle" style="display:block;border-radius:8px;overflow:hidden"
         data-ad-client="ca-pub-8565025017387209" data-ad-slot="9477779891"
         data-ad-format="auto" data-full-width-responsive="true"></ins>
  </div>
  <div class="ad-unit-container my-4">
    <span class="ad-unit-label">Advertisement</span>
    <ins class="adsbygoogle" style="display:block" data-ad-format="autorelaxed"
         data-ad-client="ca-pub-8565025017387209" data-ad-slot="9183511632"></ins>
  </div>
</main>
${siteFooter("yr")}
${getSharedPageScripts({ pageType: "keywords-index", pageSlug: "keywords" })}
</body></html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=1800",
    },
  });
}

async function handleKeywordArchivePage(env, url, slug) {
  const posts = await getBlogIndexEntries(env);
  const keywordEntry = buildKeywordArchiveEntries(posts).find((entry) => entry.slug === slug);
  if (!keywordEntry) return new Response("Not Found", { status: 404 });

  const canonical = `${url.origin}/keywords/${slug}/`;
  const pageTitle = `${keywordEntry.label} | thisDay.`;
  const pageDesc = `Historical articles on thisDay.info connected to the keyword ${keywordEntry.label}.`;
  const schema = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: pageTitle,
    url: canonical,
    description: pageDesc,
    about: { "@type": "Thing", name: keywordEntry.label },
  };

  const html = `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${escapeHtml(pageTitle)}</title>
<link rel="canonical" href="${escapeHtml(canonical)}"/>
<meta name="robots" content="index, follow"/>
<meta name="description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:title" content="${escapeHtml(pageTitle)}"/>
<meta property="og:description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="${escapeHtml(canonical)}"/>
<meta property="og:site_name" content="thisDay."/>
<meta property="og:image" content="${escapeHtml(`${url.origin}/images/logo.png`)}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${escapeHtml(pageTitle)}"/>
<meta name="twitter:description" content="${escapeHtml(pageDesc)}"/>
<meta name="twitter:image" content="${escapeHtml(`${url.origin}/images/logo.png`)}"/>
<script type="application/ld+json">${JSON.stringify(schema)}</script>
<link rel="icon" href="/images/favicon.ico" type="image/x-icon"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"/>
<link rel="stylesheet" href="/css/style.css"/>
<link rel="stylesheet" href="/css/custom.css"/>
<style>${getSharedPageStyles()}</style>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8565025017387209" crossorigin="anonymous"></script>
</head>
<body>
${siteNav()}
<main class="container my-4" style="max-width:860px">
  <nav aria-label="breadcrumb" class="mb-3">
    <ol class="breadcrumb">
      <li class="breadcrumb-item"><a href="/">Home</a></li>
      <li class="breadcrumb-item"><a href="/keywords/">Keywords</a></li>
      <li class="breadcrumb-item active" aria-current="page">${escapeHtml(keywordEntry.label)}</li>
    </ol>
  </nav>
  <section class="ai-answer-card">
    <div class="ai-answer-kicker">Keyword archive</div>
    <h1 class="h3 mb-2">${escapeHtml(keywordEntry.label)}</h1>
    <p class="mb-0">${keywordEntry.posts.length} article${keywordEntry.posts.length === 1 ? "" : "s"} currently connect to this keyword cluster.</p>
  </section>
  ${renderTopicHubPostCards(keywordEntry.posts)}
  <div class="ad-unit my-4">
    <div class="ad-unit-label">Advertisement</div>
    <ins class="adsbygoogle" style="display:block;border-radius:8px;overflow:hidden"
         data-ad-client="ca-pub-8565025017387209" data-ad-slot="9477779891"
         data-ad-format="auto" data-full-width-responsive="true"></ins>
  </div>
  <div class="ad-unit-container my-4">
    <span class="ad-unit-label">Advertisement</span>
    <ins class="adsbygoogle" style="display:block" data-ad-format="autorelaxed"
         data-ad-client="ca-pub-8565025017387209" data-ad-slot="9183511632"></ins>
  </div>
</main>
${siteFooter("yr")}
${getSharedPageScripts({ pageType: "keyword-archive", pageSlug: slug })}
</body></html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=1800",
    },
  });
}

function scorePostForTopicHub(post, hub) {
  const haystack = normalizeTopicMatchText(
    [post?.title, post?.description, post?.slug, ...(post?.pillars || [])].join(" "),
  );
  if (!haystack) return 0;

  let score = 0;
  for (const keyword of hub.keywords) {
    if (haystack.includes(normalizeTopicMatchText(keyword))) score += 3;
  }
  for (const pillar of hub.pillars || []) {
    if (Array.isArray(post?.pillars) && post.pillars.includes(pillar)) score += 2;
  }
  return score;
}

function getPostsForTopicHub(posts, hub, limit = 12) {
  return posts
    .map((post) => ({ post, score: scorePostForTopicHub(post, hub) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.post?.publishedAt || 0) - new Date(a.post?.publishedAt || 0);
    })
    .slice(0, limit)
    .map((entry) => entry.post);
}

function renderTopicHubPostCards(posts) {
  if (posts.length === 0) {
    return `<div class="card-box"><p class="text-muted mb-0">This topic hub is live, but it does not have matched articles yet. New articles will appear here as the archive grows.</p></div>`;
  }

  return posts
    .map((post) => {
      const title = escapeHtml(post.title || post.slug || "Historical article");
      const desc = escapeHtml(post.description || "");
      const slug = escapeHtml(post.slug || "");
      const published = post.publishedAt
        ? new Date(post.publishedAt).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          })
        : "";
      const pillars = Array.isArray(post.pillars)
        ? post.pillars
            .slice(0, 3)
            .map((pillar) => `<span class="topic-hub-chip">${escapeHtml(pillar)}</span>`)
            .join("")
        : "";

      return `<article class="card-box">
        <h2 class="h4 mb-2"><a href="/blog/${slug}/" style="color:inherit;text-decoration:none">${title}</a></h2>
        ${published ? `<p class="text-muted mb-2" style="font-size:.85rem">${escapeHtml(published)}</p>` : ""}
        ${desc ? `<p class="mb-3">${desc}</p>` : ""}
        ${pillars ? `<div class="topic-hub-chip-row mb-3">${pillars}</div>` : ""}
        <a href="/blog/${slug}/" class="site-btn site-btn-primary">Read article</a>
      </article>`;
    })
    .join("");
}

async function handleTopicsIndex(env, url) {
  const posts = await getBlogIndexEntries(env);
  const hubs = TOPIC_HUBS.map((hub) => ({
    ...hub,
    articleCount: getPostsForTopicHub(posts, hub, 6).length,
  }));

  const canonical = `${url.origin}/topics/`;
  const pageTitle = "Topics | thisDay.";
  const pageDesc =
    "Explore major historical subjects on thisDay.info through topic hubs that connect related articles, themes, and turning points.";
  const collectionSchema = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: pageTitle,
    url: canonical,
    description: pageDesc,
    about: { "@type": "Thing", name: "History topics" },
  };

  const cards = hubs
    .map(
      (hub) => `<article class="card-box">
        <div class="ai-answer-kicker">Topic hub</div>
        <h2 class="h4 mb-2"><a href="/topics/${hub.slug}/" style="color:inherit;text-decoration:none">${escapeHtml(hub.title)}</a></h2>
        <p class="mb-3">${escapeHtml(hub.summary)}</p>
        <p class="text-muted mb-3" style="font-size:.85rem">${hub.articleCount} matched article${hub.articleCount === 1 ? "" : "s"} so far.</p>
        <a href="/topics/${hub.slug}/" class="site-btn site-btn-primary">Open hub</a>
      </article>`,
    )
    .join("");

  const html = `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${pageTitle}</title>
<link rel="canonical" href="${escapeHtml(canonical)}"/>
<meta name="robots" content="index, follow"/>
<meta name="description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:title" content="${escapeHtml(pageTitle)}"/>
<meta property="og:description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="${escapeHtml(canonical)}"/>
<meta property="og:site_name" content="thisDay."/>
<meta property="og:image" content="${escapeHtml(`${url.origin}/images/logo.png`)}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${escapeHtml(pageTitle)}"/>
<meta name="twitter:description" content="${escapeHtml(pageDesc)}"/>
<meta name="twitter:image" content="${escapeHtml(`${url.origin}/images/logo.png`)}"/>
<script type="application/ld+json">${JSON.stringify(collectionSchema)}</script>
<link rel="icon" href="/images/favicon.ico" type="image/x-icon"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"/>
<link rel="stylesheet" href="/css/style.css"/>
<link rel="stylesheet" href="/css/custom.css"/>
<style>${getSharedPageStyles()}</style>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8565025017387209" crossorigin="anonymous"></script>
</head>
<body>
${siteNav()}
<main class="container my-4" style="max-width:860px">
  <nav aria-label="breadcrumb" class="mb-3">
    <ol class="breadcrumb">
      <li class="breadcrumb-item"><a href="/">Home</a></li>
      <li class="breadcrumb-item active" aria-current="page">Topics</li>
    </ol>
  </nav>
  <section class="ai-answer-card">
    <div class="ai-answer-kicker">Knowledge graph</div>
    <h1 class="h3 mb-2">Topic hubs for major historical subjects</h1>
    <p class="mb-0">These hubs connect thisDay.info articles into broader themes so readers and AI systems can move from one event page to a wider historical subject.</p>
  </section>
  ${cards}
  <div class="ad-unit my-4">
    <div class="ad-unit-label">Advertisement</div>
    <ins class="adsbygoogle" style="display:block;border-radius:8px;overflow:hidden"
         data-ad-client="ca-pub-8565025017387209" data-ad-slot="9477779891"
         data-ad-format="auto" data-full-width-responsive="true"></ins>
  </div>
  <div class="ad-unit-container my-4">
    <span class="ad-unit-label">Advertisement</span>
    <ins class="adsbygoogle" style="display:block" data-ad-format="autorelaxed"
         data-ad-client="ca-pub-8565025017387209" data-ad-slot="9183511632"></ins>
  </div>
</main>
${siteFooter("yr")}
${getSharedPageScripts({ pageType: "topics-index", pageSlug: "topics" })}
</body></html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=1800",
    },
  });
}

async function handleTopicHubPage(env, url, slug) {
  const hub = getTopicHubBySlug(slug);
  if (!hub) return new Response("Not Found", { status: 404 });

  const posts = await getBlogIndexEntries(env);
  const matchedPosts = getPostsForTopicHub(posts, hub, 12);
  const canonical = `${url.origin}/topics/${slug}/`;
  const pageTitle = `${hub.title} | thisDay.`;
  const pageDesc = hub.summary;
  const schema = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: pageTitle,
    url: canonical,
    description: pageDesc,
    about: { "@type": "Thing", name: hub.title },
    hasPart: matchedPosts.slice(0, 10).map((post) => ({
      "@type": "NewsArticle",
      headline: post.title,
      url: `${url.origin}/blog/${post.slug}/`,
      description: post.description,
    })),
  };

  const pillarLinks = (hub.pillars || [])
    .map((pillar) => {
      const pillarSlug = pillar
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
      return `<a href="/blog/topic/${pillarSlug}/" class="topic-hub-chip">${escapeHtml(pillar)}</a>`;
    })
    .join("");

  const html = `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${escapeHtml(pageTitle)}</title>
<link rel="canonical" href="${escapeHtml(canonical)}"/>
<meta name="robots" content="index, follow"/>
<meta name="description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:title" content="${escapeHtml(pageTitle)}"/>
<meta property="og:description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="${escapeHtml(canonical)}"/>
<meta property="og:site_name" content="thisDay."/>
<meta property="og:image" content="${escapeHtml(`${url.origin}/images/logo.png`)}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${escapeHtml(pageTitle)}"/>
<meta name="twitter:description" content="${escapeHtml(pageDesc)}"/>
<meta name="twitter:image" content="${escapeHtml(`${url.origin}/images/logo.png`)}"/>
<script type="application/ld+json">${JSON.stringify(schema)}</script>
<link rel="icon" href="/images/favicon.ico" type="image/x-icon"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"/>
<link rel="stylesheet" href="/css/style.css"/>
<link rel="stylesheet" href="/css/custom.css"/>
<style>${getSharedPageStyles()}</style>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8565025017387209" crossorigin="anonymous"></script>
</head>
<body>
${siteNav()}
<main class="container my-4" style="max-width:860px">
  <nav aria-label="breadcrumb" class="mb-3">
    <ol class="breadcrumb">
      <li class="breadcrumb-item"><a href="/">Home</a></li>
      <li class="breadcrumb-item"><a href="/topics/">Topics</a></li>
      <li class="breadcrumb-item active" aria-current="page">${escapeHtml(hub.title)}</li>
    </ol>
  </nav>
  <section class="ai-answer-card">
    <div class="ai-answer-kicker">Topic hub</div>
    <h1 class="h3 mb-2">${escapeHtml(hub.title)}</h1>
    <p>${escapeHtml(hub.summary)}</p>
    <div class="ai-answer-grid" aria-label="Topic hub facts">
      <div class="ai-answer-item"><strong>Articles</strong><span>${matchedPosts.length}</span></div>
      <div class="ai-answer-item"><strong>Primary pillars</strong><span>${escapeHtml((hub.pillars || []).join(", "))}</span></div>
    </div>
    <!-- machine-readable only -->
    <meta itemprop="url" content="https://thisday.info/topics/${escapeHtml(hub.slug)}/">
    <meta itemprop="description" content="Connected reading and citation-friendly topic discovery">
  </section>
  ${pillarLinks ? `<div class="topic-hub-chip-row mb-4">${pillarLinks}</div>` : ""}
  ${renderTopicHubPostCards(matchedPosts)}
  <div class="ad-unit my-4">
    <div class="ad-unit-label">Advertisement</div>
    <ins class="adsbygoogle" style="display:block;border-radius:8px;overflow:hidden"
         data-ad-client="ca-pub-8565025017387209" data-ad-slot="9477779891"
         data-ad-format="auto" data-full-width-responsive="true"></ins>
  </div>
  <div class="ad-unit-container my-4">
    <span class="ad-unit-label">Advertisement</span>
    <ins class="adsbygoogle" style="display:block" data-ad-format="autorelaxed"
         data-ad-client="ca-pub-8565025017387209" data-ad-slot="9183511632"></ins>
  </div>
</main>
${siteFooter("yr")}
${getSharedPageScripts({ pageType: "topic-hub", pageSlug: slug })}
</body></html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=1800",
    },
  });
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ensureCompleteSentences(text) {
  if (!text) return "";
  const t = String(text).replace(/[…]+$/, "").trim();
  const match = t.match(/^([\s\S]*[.!?])/);
  return match ? match[1].trim() : "";
}

function buildEventAnswerBlock({
  mDisplay,
  day,
  featured,
  events,
  evEraRange,
}) {
  if (!featured) return "";

  const location = extractLocationFromName(featured.text || "");
  const eventText = String(featured.text || "").trim();
  const summaryLead = `On ${mDisplay} ${day}, one notable event in history was ${featured.year}: ${eventText}`;
  const summaryContext = `This date currently highlights ${events.length} recorded events on thisDay.info${evEraRange ? `, spanning ${evEraRange}` : ""}.`;

  return `<section class="ai-answer-card" aria-labelledby="short-answer-title">
    <div class="ai-answer-kicker">Short answer</div>
    <h2 id="short-answer-title" class="h4 mb-2">What happened on ${escapeHtml(mDisplay)} ${day} in history?</h2>
    <p>${escapeHtml(summaryLead)}.</p>
    <p class="mb-0">${escapeHtml(summaryContext)}</p>
    <div class="ai-answer-grid" aria-label="Key facts">
      <div class="ai-answer-item"><strong>Date</strong><span>${escapeHtml(mDisplay)} ${day}</span></div>
      <div class="ai-answer-item"><strong>Featured year</strong><span>${escapeHtml(String(featured.year))}</span></div>
      <div class="ai-answer-item"><strong>Location</strong><span>${escapeHtml(location)}</span></div>
      <div class="ai-answer-item"><strong>Events listed</strong><span>${escapeHtml(String(events.length))}</span></div>
    </div>
  </section>`;
}

function buildDidYouKnowSlider(facts, extraClass = "") {
  const cleanedFacts = (facts || [])
    .map((fact) => String(fact || "").trim())
    .filter(Boolean);
  if (!cleanedFacts.length) return "";

  const sliderFacts = cleanedFacts.map((fact, index) =>
    `<article class="dyn-slide${extraClass ? ` ${extraClass}` : ""}" aria-label="Did you know fact ${index + 1}">
      <p>Did you know</p>
      <p class="dyn-fact">${escapeHtml(fact)}</p>
    </article>`
  ).join("");

  return `<section class="dyn-slider-shell" aria-label="Did you know">
    <button type="button" class="dyn-slider-btn dyn-slider-btn-prev" aria-label="Previous did you know card" onclick="this.parentElement.querySelector('.dyn-slider-wrap').scrollBy({ left: -280, behavior: 'smooth' })">
      <i class="bi bi-chevron-left"></i>
    </button>
    <div class="dyn-slider-wrap">
      <div class="dyn-slider-track">
        ${sliderFacts}
      </div>
    </div>
    <button type="button" class="dyn-slider-btn dyn-slider-btn-next" aria-label="Next did you know card" onclick="this.parentElement.querySelector('.dyn-slider-wrap').scrollBy({ left: 280, behavior: 'smooth' })">
      <i class="bi bi-chevron-right"></i>
    </button>
  </section>`;
}

function buildQuizAnswerBlock({ mDisplay, day, quiz, featuredEvent }) {
  if (!quiz?.topic) return "";

  const topicText = escapeHtml(quiz.topic);
  const sourceEvent = quiz.sourceEvent
    ? escapeHtml(String(quiz.sourceEvent).trim().split(".")[0])
    : "";
  const summaryLead = sourceEvent
    ? `This quiz focuses on ${topicText}. ${sourceEvent}.`
    : `Test your knowledge of key events on ${mDisplay} ${day} — this quiz covers ${topicText}.`;
  const eventYear = featuredEvent?.year ? escapeHtml(String(featuredEvent.year)) : "";

  return `<section class="ai-answer-card" aria-labelledby="quiz-answer-title">
    <div class="ai-answer-kicker">About this quiz</div>
    <h2 id="quiz-answer-title" class="h4 mb-2">What is the ${mDisplay} ${day} history quiz about?</h2>
    <p class="mb-0">${summaryLead}</p>
    <div class="ai-answer-grid" aria-label="Quiz facts">
      <div class="ai-answer-item"><strong>Date</strong><span>${mDisplay} ${day}</span></div>
      <div class="ai-answer-item"><strong>Topic</strong><span>${topicText}</span></div>
      <div class="ai-answer-item"><strong>Questions</strong><span>${quiz.questions?.length ?? 5}</span></div>
      ${eventYear ? `<div class="ai-answer-item"><strong>Featured year</strong><span>${eventYear}</span></div>` : ""}
    </div>
  </section>`;
}

function buildPersonAnswerBlock({ mDisplay, day, featured, count, type, eraRange }) {
  if (!featured) return "";
  const p = featured.pages?.[0];
  const personName = escapeHtml(featured.text.split(",")[0].trim());
  const wikiDesc = p?.description ? escapeHtml(p.description) : "";
  const wikiUrl = p?.content_urls?.desktop?.page || "";
  const extract = p?.extract || "";
  const knownFor = extract
    ? escapeHtml(extract.split(/\.\s+/)[1]?.trim() || extract.split(/\.\s+/)[0]?.trim() || "")
    : "";
  const yearLabel = type === "born" ? "Birth year" : "Death year";
  const countLabel = type === "born" ? "Birthdays on this date" : "Deaths on this date";
  const question = type === "born" ? `Who was born on ${mDisplay} ${day}?` : `Who died on ${mDisplay} ${day}?`;
  const kicker = type === "born" ? "Famous birthdays" : "Notable deaths";
  const titleId = type === "born" ? "born-answer-title" : "died-answer-title";

  return `<section class="ai-answer-card" aria-labelledby="${titleId}">
    <div class="ai-answer-kicker">${kicker}</div>
    <h2 id="${titleId}" class="h4 mb-2">${escapeHtml(question)}</h2>
    ${wikiDesc ? `<p class="mb-3">${personName} — ${wikiDesc}</p>` : ""}
    <div class="ai-answer-grid" aria-label="Key facts">
      <div class="ai-answer-item"><strong>Featured</strong><span>${wikiUrl ? `<a href="${escapeHtml(wikiUrl)}" target="_blank" rel="noopener noreferrer" style="color:inherit">${personName}</a>` : personName}</span></div>
      <div class="ai-answer-item"><strong>${yearLabel}</strong><span>${escapeHtml(String(featured.year))}</span></div>
      ${knownFor ? `<div class="ai-answer-item" style="grid-column:1/-1"><strong>Known for</strong><span>${knownFor}</span></div>` : ""}
      <div class="ai-answer-item"><strong>${countLabel}</strong><span>${escapeHtml(String(count))}${eraRange ? ` (${escapeHtml(eraRange)})` : ""}</span></div>
    </div>
  </section>`;
}

function buildBornAnswerBlock({ mDisplay, day, featured, births, eraRange }) {
  return buildPersonAnswerBlock({ mDisplay, day, featured, count: births.length, type: "born", eraRange });
}

function buildDiedAnswerBlock({ mDisplay, day, featured, deaths, eraRange }) {
  return buildPersonAnswerBlock({ mDisplay, day, featured, count: deaths.length, type: "died", eraRange });
}

function buildPersonMentions(items = [], dateKey) {
  return items.slice(0, 8).map((item) => {
    const name = String(item?.text || "").split(",")[0].trim();
    const description = String(item?.text || "").trim();
    return {
      "@type": "Person",
      name,
      ...(item?.year ? { [dateKey]: `${item.year}` } : {}),
      ...(description ? { description } : {}),
      ...(item?.pages?.[0]?.content_urls?.desktop?.page
        ? { sameAs: item.pages[0].content_urls.desktop.page }
        : {}),
    };
  });
}

function buildEventMentions(items = []) {
  return items.slice(0, 8).map((item) => ({
    "@type": "Event",
    name: String(item?.text || "").split(".")[0].trim(),
    ...(item?.year ? { startDate: String(item.year) } : {}),
    ...(item?.pages?.[0]?.content_urls?.desktop?.page
      ? { sameAs: item.pages[0].content_urls.desktop.page }
      : {}),
  }));
}

function redirectNoStore(url, status = 302) {
  return new Response(null, {
    status,
    headers: {
      Location: url,
      "Cache-Control": "no-store",
    },
  });
}

// Scores a Wikipedia-enriched item by content richness. Higher = better featured candidate.
function wikiRichScore(item) {
  const p = item?.pages?.[0];
  if (!p) return 0;
  let s = 0;
  if (p.thumbnail?.source) s += 3;
  if (p.originalimage?.source) s += 2;
  if (p.extract) s += Math.min(p.extract.length / 100, 5);
  if (p.description) s += 1;
  return s;
}

// Returns an array of 2-3 original editorial paragraphs for the featured event.
// All text is authored by thisDay.info — safe to render as HTML without escaping.
function workerCommentary(year, text) {
  const y = parseInt(year, 10);
  const t = (text || "").toLowerCase();

  const war =
    /war|battle|siege|invasion|conflict|defeat|victory|troops|army|military|combat/.test(
      t,
    );
  const sci =
    /discover|invent|launch|orbit|experiment|vaccine|gene|atom|microscope|telescope|theory|equation|element|laboratory/.test(
      t,
    );
  const pol =
    /treaty|signed|declared|constitution|independence|election|revolution|parliament|senate|congress|legislation/.test(
      t,
    );
  const expl =
    /expedition|voyage|navigator|circumnavigat|new world|explorer|coloniz|sailing|landed/.test(
      t,
    );
  const dis =
    /earthquake|hurricane|typhoon|tsunami|eruption|wildfire|flood|epidemic|pandemic|plague|famine|disaster|collapsed|shipwreck|covid|coronavirus|quarantine|lockdown|travel ban|public health/.test(
      t,
    );
  const art =
    /\bfilm\b|novel|painting|symphony|opera|theatre|theater|poem|published|premiered|literary|artist|composer|sculptor|architecture|museum/.test(
      t,
    );
  const rel =
    /church|cathedral|pope|bishop|crusade|mosque|temple|monastery|reformation|heresy|clergy|saint|protestant|catholic/.test(
      t,
    );
  const econ =
    /bank|stock market|recession|depression|financial crisis|bankruptcy|currency|inflation|trade|tariff|crash|bubble|debt|deficit|gdp|economy|market/.test(
      t,
    );
  const sport =
    /olympic|championship|world cup|tournament|record|gold medal|title|final|super bowl|grand slam|marathon|formula|athlete/.test(
      t,
    );

  const era =
    y < 500
      ? "ancient"
      : y < 1400
        ? "medieval"
        : y < 1700
          ? "early_modern"
          : y < 1900
            ? "modern"
            : "contemporary";

  if (war) {
    // Sub-categories within war for more connected commentary
    const isSiege =
      /siege|besieg|surrounded|fortif|garrison|blockade|starv/.test(t);
    const isNaval =
      /naval|fleet|ship|sea battle|maritime|admiral|frigate|armada/.test(t);
    const isLiberation =
      /liberat|resist|partisan|guerrilla|occupied|underground|freed/.test(t);
    const isAttrition =
      /world war|trench|western front|eastern front|million|casualties|stalemate/.test(
        t,
      );
    const isCivilWar =
      /civil war|civil conflict|secession|rebel|faction|brother against/.test(
        t,
      );
    const isSurrender =
      /surrender|capitulat|armistice|ceasefire|truce|ended|concluded|peace/.test(
        t,
      );
    const isAerial =
      /bombing|air raid|aerial|blitz|airforce|aircraft|bomb|drone|air strike/.test(
        t,
      );

    if (isSiege)
      return [
        "Sieges reduced warfare to its starkest arithmetic: the rate at which defenders consumed supplies versus the patience and resources of those outside the walls. Starvation and disease killed as reliably as any weapon.",
        "A successful siege required controlling the surrounding territory, maintaining reliable supply lines, and sustaining political will across months or even years. These were rarely guaranteed — many sieges collapsed not through military defeat but through the besieger's own logistical failures.",
        "For civilians trapped inside, the siege was not a military calculation but a daily question of survival — who controlled the food, who maintained order, and whether the walls could hold long enough for relief to arrive.",
      ];
    if (isNaval)
      return [
        "Naval power has always been primarily about logistics: the ability to project force, protect trade routes, and deny the same to an opponent. Battles at sea decided not just military outcomes but the economic fate of empires.",
        "A naval engagement concentrated enormous irreplaceable capital — ships, trained crews, experienced officers — into a few hours of chaotic violence. Fleets built over decades could be destroyed in a single afternoon.",
        "Control of the sea never guaranteed control of everything, but losing it tended to mean losing most things eventually. Maritime supremacy has consistently translated into commercial and strategic advantage in ways that land power alone could not replicate.",
      ];
    if (isLiberation)
      return [
        "Resistance movements rarely succeed through armed force alone. The combination of sustained guerrilla action, international pressure, the political delegitimization of the occupying power, and the mounting cost of repression tends to determine outcomes more than any single engagement.",
        "Occupation reshapes societies in ways that outlast the occupation itself. Identity hardens, collaboration becomes a lasting moral category, and the politics of the post-liberation period are defined by who resisted, who accommodated, and under what circumstances.",
        "What gets called liberation looks different depending on where you stand. The formal removal of an occupying power rarely resolves the underlying questions of who governs next, on whose behalf, and with what legitimacy.",
      ];
    if (isAttrition)
      return [
        "Industrial-scale warfare transformed conflict from a contest of tactics and leadership into a problem of production and endurance. The side that could sustain losses longest — in material, in manpower, in political will — tended to prevail, regardless of battlefield skill.",
        "Mass mobilization reshaped societies as profoundly as the fighting itself. Economies were restructured, gender roles disrupted, political compacts renegotiated. A society that entered a total war rarely emerged with its internal arrangements intact.",
        "The arithmetic of attrition was visible to everyone in real time, which is what made it so politically corrosive. Governments that could not explain why the losses were worth the gains eventually faced a crisis of legitimacy as dangerous as any military setback.",
      ];
    if (isCivilWar)
      return [
        "Civil wars are distinguished from other conflicts by who the enemy is: not a foreign power but a neighbour, a former ally, sometimes a family member. That proximity produces a particular kind of violence — intimate, difficult to end, and long-remembered.",
        "The causes of civil war are almost always multiple and contested. Economic inequality, ethnic or religious divisions, disputed legitimacy, and the collapse of institutions capable of managing disagreement tend to combine rather than act in isolation. Single-cause explanations come later, from the winners.",
        "Civil wars rarely end cleanly. The formal conclusion of fighting is followed by years of contested reconstruction — who gets to write the history, which grievances are acknowledged, and how the losing side is reintegrated into a shared political life. These questions prove at least as difficult as the war itself.",
      ];
    if (isSurrender)
      return [
        "Surrenders are often the moment when the real negotiation begins. The terms imposed on the defeated — reparations, territorial loss, political reorganization — shape the next generation's grievances as surely as the fighting shaped this one.",
        "The decision to stop fighting requires someone with authority to make it and the political standing to enforce it. Armies that refuse to accept the reality of defeat, or governments that collapse before surrender can be formalized, tend to produce prolonged and chaotic aftermaths.",
        "What the armistice ends is the shooting. What it does not end is the underlying conflict of interests, identities, and claims that produced the war. The durability of any peace depends on how seriously those deeper questions are addressed — a test that many ceasefires fail.",
      ];
    if (isAerial)
      return [
        "Aerial warfare added a dimension that fundamentally changed what it meant to be a civilian in wartime. The front line disappeared; distance from the fighting no longer offered safety. Cities, factories, and populations became legitimate targets under doctrines that were being improvised in real time.",
        "Strategic bombing promised to end wars quickly by destroying an enemy's will and capacity to fight from the air. The evidence for its effectiveness has always been contested — civilian populations proved more resilient than theorists predicted, and the economic disruption less decisive than promised.",
        "The moral framework for aerial warfare has never been fully resolved. The same technology used to deliver humanitarian aid can deliver ordnance. Drones, precision munitions, and autonomous systems have shifted the calculus again, raising questions that the laws of war — written for earlier technologies — struggle to answer.",
      ];

    if (era === "ancient")
      return [
        "In the ancient world, warfare was the ultimate arbiter of civilization. Kingdoms that had stood for centuries could be erased in a single campaign season — their people absorbed, enslaved, or scattered across unfamiliar lands.",
        "What the victors recorded as glorious triumph was, for the defeated, the collapse of everything they knew: language, gods, customs, and kinship networks reduced first to memory, then eventually to silence.",
        "Yet conflict also accelerated exchange. Technologies, crops, religions, and ideas spread fastest along routes carved by armies. War built the ancient world as much as it destroyed it.",
      ];
    if (era === "medieval")
      return [
        "Medieval warfare was rarely the chivalric contest romanticized in later literature. Sieges could last months, reducing entire populations to starvation; plague followed armies as reliably as supply carts followed generals.",
        "Feudal loyalty made alliances permanently treacherous. Kings who commanded the battlefield could lose the political war at home — undone by barons whose interests never fully aligned with the crown's ambitions.",
        "Still, medieval conflicts reshaped Europe's borders so profoundly that their lines echo in national identities today. The map of the modern world was drawn, in large part, by medieval swords.",
      ];
    if (era === "early_modern")
      return [
        "The introduction of gunpowder fundamentally restructured the calculus of war. Castle walls that had held for centuries became liabilities overnight. The armored knight — product of decades of expensive training — could be felled by a conscript armed with a musket.",
        "Early modern warfare also began to operate at imperial scale. Conflicts no longer stayed within European borders; they extended across oceans, reshaping the Americas, Africa, and Asia as collateral damage in European quarrels.",
        "These wars demanded new financial systems, bureaucracies, and supply chains — and in the effort to fund and sustain them, the modern nation-state was essentially invented.",
      ];
    if (era === "modern")
      return [
        "By the 19th century, industrialization had turned war into a logistical problem as much as a tactical one. Railroads, telegraphs, and mass production allowed armies to field hundreds of thousands — and to sustain those losses across years of grinding attrition.",
        "The wars of this era carried an ideological weight their predecessors lacked. Nationalism, liberation, imperial expansion — soldiers increasingly fought for abstractions rather than simply for monarchs or wages.",
        "The human cost was staggering enough to inspire the first serious international attempts at limiting conflict — the Geneva Conventions, the Hague Agreements — though none succeeded in curbing the century's appetite for war.",
      ];
    return [
      "20th and 21st century conflicts redefined what war means entirely. The industrial-scale destruction of two World Wars gave way to nuclear deterrence, proxy conflicts, and asymmetric warfare — each a different answer to the question of how to fight when total war means mutual annihilation.",
      "Today's wars are fought simultaneously on the ground, in the air, in cyberspace, and across media narratives. Shaping global perception has become as strategically important as seizing territory — sometimes more so.",
      "The century's sharpest lesson — that modern war produces no clean victors, only varying degrees of ruin — has yet to be fully absorbed by those who still reach for it as a first resort.",
    ];
  }

  if (sci) {
    // Sub-categories within science for more connected commentary
    const isSpace =
      /space|orbit|satellite|rocket|moon|mars|astronaut|cosmonaut|shuttle|spacecraft|launch pad/.test(
        t,
      );
    const isMedical =
      /vaccine|medicine|disease|cure|surgery|antibiotic|virus|epidemic|dna|gene|genome|transplant/.test(
        t,
      );
    const isPhysics =
      /atom|nuclear|quantum|relativity|particle|radiation|element|periodic|chemistry|fission|fusion/.test(
        t,
      );
    const isComputing =
      /computer|software|internet|algorithm|digital|program|data|network|code|processor|artificial intelligence/.test(
        t,
      );
    const isAstronomy =
      /comet|asteroid|star|planet|galaxy|nebula|eclipse|celestial|constellation|telescope|observatory/.test(
        t,
      );
    const isEnv =
      /climate|pollution|environment|ecosystem|conservation|species|extinction|carbon|deforestation|ozone/.test(
        t,
      );
    const isMath =
      /mathemati|theorem|proof|calculus|algebra|geometry|statistics|cipher|equation|formula|number/.test(
        t,
      );

    if (isSpace)
      return [
        "Space exploration demands solving problems at the absolute edge of what materials, mathematics, and human physiology can withstand. Every successful mission represents the convergence of thousands of engineering decisions, each of which had to be right.",
        "The political dimensions of space programs have always matched their scientific ones. National prestige, military capability signals, and the projection of technological power drove funding and timelines as forcefully as the pursuit of knowledge.",
        "What space exploration changed most durably was human self-perception. Seeing Earth from outside it — as a single, fragile object against an indifferent darkness — produced a shift in perspective that no purely terrestrial experience could replicate.",
      ];
    if (isMedical)
      return [
        "Medical progress rarely arrives as a clean breakthrough. It accumulates through decades of failure, partial understanding, and contested results — punctuated occasionally by discoveries that genuinely restructure everything that came before and after them.",
        "The gap between what medicine can do and what it actually delivers has always been one of the defining inequalities of every era. A treatment proven effective in one setting may be inaccessible, unaffordable, or contested in another. Discovery and access are separate problems.",
        "Disease has altered the course of history in ways that armies and diplomacy could not. Pathogens do not respect borders, social hierarchies, or military formations. Understanding this link between medicine and power is inseparable from understanding history itself.",
      ];
    if (isPhysics)
      return [
        "Discoveries at the fundamental level of physics have a habit of producing consequences that appear only decades later. The theoretical insights of one generation become the technological infrastructure of the next — and the ethical frameworks for managing them typically arrive last.",
        "Nuclear and quantum physics revealed that the universe operates by rules radically different from everyday experience. This created both extraordinary power and extraordinary conceptual difficulty — a science whose implications even its creators spent years working to understand.",
        "The institutional structures of modern science — large international collaborations, government-funded research, peer review at scale — were largely built around the demands of physics. In shaping how science is organized, the discipline reshaped the entire enterprise of knowledge-making.",
      ];
    if (isComputing)
      return [
        "Computing technology accelerated through a feedback loop: each generation of hardware enabled the development of the next, compressing decades of expected progress into years. The pace consistently outran the ability of legal, educational, and social institutions to adapt.",
        "The internet restructured the fundamental economics of information. When copying and distributing knowledge approaches zero cost, the industries and power structures built on controlling its scarcity face questions they were not designed to answer.",
        "What computing changed most profoundly was not any specific industry but the underlying assumption about what could be automated, optimized, and quantified. That assumption continues expanding into domains — creativity, judgment, interpersonal trust — that once seemed safely beyond its reach.",
      ];
    if (isAstronomy)
      return [
        "Astronomy has always occupied an unusual position in the hierarchy of sciences: its objects of study are entirely inaccessible, observable only at a distance measured in light-years, yet the patterns they reveal have structured timekeeping, navigation, and human self-understanding since the earliest civilizations.",
        "Each step outward in scale — from solar system to galaxy to observable universe — has required revising not just measurements but foundational assumptions about where we are and what we are made of. The universe turned out to be far older, larger, and stranger than anyone's first guess.",
        "Modern astronomy is fundamentally collaborative in a way few disciplines match. Telescopes span continents; data is shared across borders; discoveries arrive not through individual genius but through networked observation and computation. The romantic image of the lone astronomer at the eyepiece describes almost nothing about how the field actually works.",
      ];
    if (isEnv)
      return [
        "Environmental history reframes the standard narrative of progress by asking what was lost — ecologically, biologically, climatically — in the process of producing what we typically count as gains. The accounting looks considerably different when the costs are included.",
        "Ecosystems do not register political borders. A species extinction, an aquifer depleted, a river system dammed — these changes propagate across boundaries in ways that no single government is positioned to fully manage. The mismatch between the scale of environmental problems and the scale of political institutions is one of the central dilemmas of the modern era.",
        "The pace of environmental change in the industrial period has no precedent in human history and few in geological time. What makes this moment unusual is not that nature is changing — it always has — but that the driver of change is now the cumulative weight of human activity, and the timeline for consequences is measured in decades rather than millennia.",
      ];
    if (isMath)
      return [
        "Mathematics is unusual among intellectual disciplines in that its results, once proven, do not become obsolete. A theorem established two thousand years ago requires no revision when new evidence arrives — the proof either holds or it doesn't, and if it holds, it holds permanently.",
        "Mathematical structures discovered in purely abstract contexts have a persistent habit of turning out to describe physical reality with uncanny precision — often decades or centuries after the original work. This relationship between abstract reasoning and the behaviour of the physical world remains philosophically puzzling.",
        "The history of mathematics is also a history of expanding the concept of number itself: from counting integers to fractions, to irrational and imaginary numbers, to infinities of different sizes. Each expansion felt, to contemporaries, like a violation of common sense — and each eventually became indispensable.",
      ];

    if (era === "ancient" || era === "medieval")
      return [
        "In the ancient and medieval world, scientific inquiry was inseparable from philosophy and theology. Observation of the natural world was a form of reading a divine text — each pattern in the stars or in the body a reflection of a larger cosmic order.",
        "This did not make early scholars incurious. The great minds of antiquity and the Islamic Golden Age made advances in mathematics, astronomy, and medicine that Europe would not surpass for centuries — achieved without the institutional infrastructure we now take for granted.",
        "What we retrospectively label superstition was often simply the best available framework — a coherent attempt to understand cause and effect with the tools at hand. History remembers the failures. It rarely appreciates how remarkable it was to try at all.",
      ];
    if (era === "early_modern")
      return [
        "The Scientific Revolution was not a single event but a slow erosion of inherited certainty. Each discovery challenged not just a theory but an entire worldview — and the institutions, both religious and political, that depended on that worldview remaining intact.",
        "Figures like Galileo, Copernicus, and Newton were not safely distant academics. They were, in their time, radicals — challenging what powerful institutions held to be settled truth, and sometimes paying a serious personal price for doing so.",
        "The methods they established — observation, hypothesis, experiment, replication — are now so thoroughly embedded in how we think that it is almost impossible to imagine reasoning without them. That is how completely they changed the world.",
      ];
    if (era === "modern")
      return [
        "The 19th century turned science into an industry. What had been the work of gentlemen-scholars with private means became organized, funded, and institutionalized — universities, peer-reviewed journals, international conferences. Discovery accelerated accordingly.",
        "The consequences extended far beyond the laboratory. Steam power, electrification, chemistry, and germ theory reshaped daily life faster than any social revolution had managed. A person born in 1800 who lived to 1900 witnessed changes that would have been indistinguishable from magic to their grandparents.",
        "Science also began to carry new moral weight in this period. Darwinian evolution, in particular, forced a renegotiation between empirical inquiry and religious identity that societies are, in some respects, still working through.",
      ];
    return [
      "Modern scientific progress has outpaced humanity's ability to fully absorb its own implications. In less than a century, we moved from the first powered flight to landing on the Moon — and from discovering the structure of DNA to editing it in living organisms.",
      "This pace creates a particular kind of vertigo. Technologies arrive before the ethical frameworks to govern them. The internet, CRISPR, and artificial intelligence all changed the world before anyone had agreed on the rules of engagement.",
      "Yet science remains the most reliable method humanity has found for separating truth from wishful thinking. Its willingness to revise itself when evidence demands it — to discard even beloved theories — is one of our most underappreciated cultural achievements.",
    ];
  }

  if (expl)
    return [
      "For those who undertook these journeys, the unknown was not an abstraction — it was literal. Coastlines that ended without warning, prevailing winds that shifted unpredictably, diseases no European immune system had encountered. The odds of safe return were never guaranteed.",
      "What exploration produced, beyond geographical knowledge, was a catastrophic redistribution of power, population, and disease. Civilizations encountered along the way — many sophisticated in their own right — were transformed, reduced, or erased within generations of first contact.",
      "We still speak of the 'discovery' of places that had been continuously inhabited for millennia. Revisiting this history honestly means holding two truths simultaneously: the genuine courage these journeys required, and the devastation that followed in their wake.",
    ];

  if (dis)
    if (
      /pandemic|covid|coronavirus|quarantine|lockdown|travel ban|public health/.test(
        t,
      )
    )
      return [
        "Pandemics are biological events with political consequences. Measures like travel restrictions, quarantine rules, and emergency declarations are not just medical responses — they are state decisions that redistribute risk, responsibility, and economic burden across society.",
        "Cross-border disease transmission exposes how tightly modern systems are linked. Aviation, trade, and tourism connect economies at high speed, so disruptions in one region quickly become global policy questions rather than local incidents.",
        "The long-term historical significance of pandemic-era decisions is judged by institutional learning: whether governments improved surveillance, health capacity, and crisis coordination after the immediate emergency passed.",
      ];
  if (dis)
    return [
      "Natural disasters operate on geological or meteorological scales entirely indifferent to human plans. Yet their death tolls are shaped as much by social factors — poverty, inequality, political negligence — as by the event itself. The same earthquake kills thousands in one city and dozens in another.",
      "Catastrophe reveals a society's real priorities with uncomfortable clarity. Which communities get rebuilt first, which are quietly abandoned, who receives compensation and who is forgotten — these decisions expose power structures that official policy rarely acknowledges directly.",
      "History's great disasters also tend to accelerate reform. Building codes, early warning systems, and emergency response frameworks were largely built in the aftermath of tragedies that revealed how preventable the worst outcomes were. Progress here has almost always been reactive rather than proactive.",
    ];

  if (art)
    return [
      "Cultural history moves differently from political history. Where political events can be dated to a specific day, artistic movements accumulate gradually — a novel published here, a manifesto there, a performance that contemporary audiences found outrageous and critics a generation later called definitive.",
      "Art produced in one era is constantly reread by those that follow. Works dismissed as obscene or trivial are restored to the canon; once-celebrated masterworks lose their urgency. The cultural record is perpetually being negotiated and revised by new eyes.",
      "What tends to endure — across centuries and cultural contexts — is work that captured something true about human experience. Not necessarily the technically perfect or the ideologically correct, but the honest. History has a long memory for authenticity.",
    ];

  if (rel)
    return [
      "Religious history resists easy reduction. Doctrinal disputes that seem, in retrospect, impossibly arcane — precise questions of theology, the authority of a particular text, the correct form of a ritual — were, for those living through them, matters of ultimate consequence, worth dying and killing for.",
      "Religious institutions have simultaneously served as preservers of knowledge, patrons of the arts, centers of social organization, and engines of oppression. Rarely has any one of these functions entirely eclipsed the others in any tradition, for any sustained period.",
      "The relationship between faith and secular authority has never been permanently resolved — only temporarily arranged. Every settlement between them eventually produces the conditions for the next renegotiation, and the terms are always contested.",
    ];

  if (pol) {
    // Sub-categories within politics so commentary matches the actual event type
    const isElection =
      /election|vote|ballot|elected|campaign|referendum|suffrage|polling/.test(
        t,
      );
    const isTreaty =
      /treaty|accord|agreement|peace|diplomatic|negotiat|ceasefire|armistice/.test(
        t,
      );
    const isRevolution =
      /revolution|independence|uprising|coup|overthrow|liberat|rebel|proclaimed/.test(
        t,
      );
    const isAssassination = /assassin|murder|killed|shot|executed|impeach/.test(
      t,
    );
    const isLegislation =
      /constitution|legislation|bill|charter|amendment|decree|enacted|signed into law/.test(
        t,
      );

    if (isElection)
      return [
        "Elections are democracy's recurring proof of concept — contested, imperfect, and still the most reliable mechanism humanity has produced for transferring power without immediate violence.",
        "The outcome of any election is shaped by forces that begin years before polling day: demographic shifts, economic anxieties, media narratives, and the accumulated weight of earlier decisions. The ballot box measures a political moment, not just an individual preference.",
        "History judges elections not only by who won, but by what became possible — or permanently foreclosed — because of them. The full consequences of a particular result are rarely visible on election night.",
      ];
    if (isTreaty)
      return [
        "Treaties are political documents dressed as resolutions. What they commit to on paper and what they produce in practice are rarely identical — the gap between the two is where much of the subsequent history tends to unfold.",
        "Every peace agreement encodes the power imbalance of the moment it was signed. Those who negotiated from weakness rarely secured terms that held indefinitely. The seeds of the next conflict are almost always present in the language of the settlement.",
        "The durability of any treaty depends less on its wording than on whether the conditions that produced the original conflict have genuinely changed — a question that no signature alone can answer.",
      ];
    if (isRevolution)
      return [
        "Revolutions are rarely as sudden as they appear. The conditions that make them possible — accumulated grievances, weakened institutions, competing claims to legitimacy — build over years before a single event transforms long-standing tension into open rupture.",
        "Every revolution produces a gap between what it promised and what it delivers. The ideals of the opening phase are typically constrained by the practical pressures of consolidation, when the question shifts from 'what do we want?' to 'how do we hold this together?'",
        "What makes a revolutionary moment historically decisive is not simply that it changed who held power, but whether it changed the underlying rules by which power could be held, challenged, and transferred. By that measure, the verdict on most revolutions takes generations to reach.",
      ];
    if (isAssassination)
      return [
        "Political violence aimed at individuals rarely eliminates the ideas those individuals represented. Assassinations tend to accelerate the forces they aimed to stop — converting people into symbols and grievances into movements with longer half-lives than the original.",
        "The aftermath of a political killing reveals far more about a society than the act itself. How institutions respond, whether successor governments are strengthened or destabilized, and whether the act achieves its intended effect — these are the real historical questions.",
        "The counterfactual is irresistible but ultimately unanswerable: would history have unfolded differently had the individual survived? More revealing is the question of what conditions made such an outcome possible in the first place.",
      ];
    if (isLegislation)
      return [
        "Laws are not self-executing. A constitution can articulate rights that exist nowhere in practice; legislation can transform a society or gather dust depending entirely on whether the political will that produced it survives the moment of passage.",
        "The language of law is always a compromise — an attempt to build a durable framework from competing interests and predictions about the future that will inevitably prove partly wrong. The meaning of any law continues to shift as the circumstances it was written for change.",
        "Constitutional moments feel more decisive at the time than they often prove to be. What determines their legacy is whether the institutions built around them are strong enough to hold when the document is tested — as it always eventually is.",
      ];

    // General political fallback
    return [
      y < 1800
        ? "Political power in this era was deeply personal. Constitutions and treaties were essentially agreements between powerful individuals — the interests of ordinary people were largely absent from the political calculus, because ordinary people were largely absent from political life."
        : "Political decisions that shape generations are rarely made with clear visibility into their long-term consequences. Those in power respond to immediate pressures — the long view is a luxury that the moment rarely permits.",
      y < 1800
        ? "The concepts we now treat as foundational to governance — popular sovereignty, individual rights, the separation of powers — were radical ideas in this period, held by a small and often persecuted minority at the fringes of political thought."
        : "Every political settlement eventually generates the conditions for its own renegotiation. What one era treats as a permanent arrangement, the next often treats as a grievance.",
      "The political structures that shape daily life today were built through specific compromises, under specific pressures, by people who could not anticipate what came after. History could plausibly have produced very different arrangements — and very nearly did.",
    ];
  }

  if (econ)
    return [
      "Economic crises have a way of revealing, very quickly, which elements of a financial system were more fragile than they appeared. The mechanisms that work smoothly during expansion — leverage, interconnection, confidence — amplify losses with equal efficiency on the way down.",
      "Markets are built on expectations about the future, which means they are built on collective psychology as much as on fundamentals. Confidence, once lost, tends to be slow to return and easy to shatter again. The narrative a society tells about its economy matters — sometimes as much as the underlying reality.",
      "The political consequences of economic crises consistently outlast the crises themselves. Governments that presided over financial collapses rarely survived them with their authority intact. The social strains produced by mass unemployment, lost savings, and deflated expectations tend to find political expression — not always in forms that democratic institutions can easily absorb.",
    ];

  if (sport)
    return [
      "Sporting achievement exists at the intersection of biological capacity, systematic training, and favorable circumstance — with the last element more consequential than athletic mythologies typically acknowledge. Champions are also products of access: to coaching, facilities, nutrition, and the freedom to specialize.",
      "Major sporting events have always served purposes beyond competition. They are displays of national prestige, commercial spectacles, diplomatic signals, and platforms for political statements — sometimes all simultaneously. The sport itself is embedded in a context that shapes everything from the schedule to the broadcast rights.",
      "Records exist to be broken, which is precisely what makes them useful as historical markers. Each time a presumed human limit is surpassed, the achievement recalibrates what the next generation believes is possible — a compounding effect that extends beyond sport into every domain where belief in possibility matters.",
    ];

  // Default — era-based
  if (era === "ancient")
    return [
      "Events from the ancient world survive only through fragments — inscriptions, papyri, and secondhand accounts filtered through centuries of copying and interpretation. Every surviving detail was preserved against considerable odds.",
      "The civilizations that produced these events were far more complex and interconnected than popular imagination typically allows. Trade routes, diplomatic correspondence, and shared mythologies linked the ancient Mediterranean, Middle East, and Asia in ways that are still being mapped.",
      "What we call ancient history is largely the record of elites and institutions. The daily lives, beliefs, and experiences of ordinary people — the overwhelming majority — remain largely invisible, recoverable only in fragments through archaeology.",
    ];
  if (era === "medieval")
    return [
      "The medieval world was far more dynamic and interconnected than the 'Dark Ages' label once suggested. Scholarly exchange between Islamic, Jewish, Byzantine, and European traditions kept classical knowledge alive and advanced it significantly.",
      "Life in the medieval period was shaped by rhythms — liturgical, agricultural, and dynastic — that gave time a different texture than the linear, progress-oriented narrative we tend to impose on it from the outside.",
      "Medieval people were not primitive versions of us, waiting for modernity to arrive. They were fully formed human beings navigating a specific set of circumstances with intelligence, humor, ambition, and fear — much as we do now.",
    ];
  if (era === "early_modern")
    return [
      "The early modern period was defined by collisions: of continents, religions, political systems, and ways of understanding the world. Old certainties were crumbling faster than new ones could be built to replace them.",
      "Print technology, oceanic navigation, and the Reformation all arrived within decades of each other — a convergence of disruptions that transformed European society more rapidly than anything since the fall of Rome.",
      "People living through this period had no way of knowing they were in a hinge moment of history. They experienced it as confusion, opportunity, and violence in roughly equal measure — which is, perhaps, how most pivotal eras feel from the inside.",
    ];
  if (era === "modern")
    return [
      "The 19th century compressed centuries of prior change into a matter of decades. Industrial production, mass literacy, global communication, and modern medicine all emerged or transformed so rapidly that contemporaries frequently described feeling unmoored.",
      "This era also produced the modern concept of progress — the idea that history moves in a direction, that tomorrow will be materially better than today. It was a genuinely new way of relating to time, and it reshaped everything from politics to personal ambition.",
      "The century's confidence in its own advancement was not entirely misplaced, but it obscured the costs: ecological damage, colonial exploitation, and social displacement that would take the following century to begin reckoning with.",
    ];
  return [
    "Every event recorded in history represents a decision by someone to consider it worth preserving. The archives of any civilization reveal as much about its values — what it found worth recording — as about what actually occurred.",
    "Much of what happened on any given day was never written down at all. The farmers, merchants, and ordinary people who constituted the overwhelming majority of any era left almost no direct trace. What we call history is largely the record of the exceptional — the violent, the powerful, and the fortunate.",
    "This is precisely why revisiting dates matters. Not simply to accumulate facts, but to notice which stories were preserved and which were not — and to hold some humility about the vast quantity of human experience that passed through this world without leaving a single word behind.",
  ];
}

function buildDynamicOverview(featured, events, mDisplay, day) {
  if (!featured) {
    return {
      title: `Overview: ${mDisplay} ${day}`,
      paragraphs: [
        `This page gathers key moments connected to ${mDisplay} ${day}, with each entry offering historical context about a specific event, person, or turning point.`,
        `When no single featured item is available, the timeline still provides a focused view of how this date appears across different eras and topics.`,
      ],
    };
  }

  const cleanText = String(featured.text || "")
    .replace(/\s+/g, " ")
    .trim();
  const eventStatement = cleanText.replace(/[.\s]+$/, "");
  const firstSentence = (cleanText.split(".")[0] || cleanText).trim();
  const fullFeaturedLabel = `${featured.year} — ${firstSentence}`;
  const topical = workerCommentary(featured.year, featured.text);

  return {
    title: `Overview: ${fullFeaturedLabel}`,
    paragraphs: [
      `On ${mDisplay} ${day}, ${featured.year}, ${eventStatement}. This moment is most useful when read in its direct context: who acted, what changed, and why it mattered at that time.`,
      topical[0],
      topical[1] || topical[0],
    ],
  };
}

function getSharedPageStyles() {
  return (
    `:root{--bg:#ffffff;--bg-alt:#f2f7f2;--text:#1a2e20;--text-muted:#5c7a65;--border:#cfe0cf;--btn-bg:#1b3a2d;--btn-text:#fff;--btn-hover:#2a4d3a;--accent:#9dc43a;--radius:4px;--shadow:0 16px 32px -8px rgba(27,58,45,.08);--cb:var(--bg);--cbr:var(--border);--tc:var(--text);--mu:var(--text-muted);--lc:var(--btn-bg);--ftc:#fff;--fb:var(--bg-alt)}

body{font-family:Lora,serif;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--text)}
main{flex:1;padding:20px 0}
h1,h2,h3,h4{color:var(--text)}
p{font-size:15px;line-height:1.6}
a{color:var(--lc)}a:hover{text-decoration:underline}
.text-muted{color:var(--text-muted)!important}
.breadcrumb-item a{color:var(--lc)}.breadcrumb-item.active{color:var(--text-muted)}
` +
    NAV_CSS +
    "\n" +
    FOOTER_CSS +
    "\n" +
    `
.marquee-bar{background:var(--btn-bg);color:#fff;overflow:hidden;white-space:nowrap;padding:.5rem 0;font-size:.82rem}
.marquee-track{display:inline-flex;gap:0;animation:marquee-scroll 55s linear infinite;will-change:transform}
.marquee-track:hover{animation-play-state:paused}
.marquee-item{padding:0 2.5rem;border-right:1px solid rgba(255,255,255,.2)}
.marquee-item span{color:var(--accent);font-weight:700;margin-right:.5rem}
@keyframes marquee-scroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}

.card-box{background:var(--cb);border:1px solid var(--cbr);border-radius:10px;padding:22px;margin-bottom:22px}
.feat-img{width:100%;max-height:420px;object-fit:cover;object-position:top;border-radius:8px;margin-bottom:20px}
.commentary{border-left:4px solid var(--btn-bg);padding:10px 14px;background:rgba(0,0,0,.07);border-radius:0 8px 8px 0;font-style:italic;color:var(--text-muted);margin:18px 0}

.dyn-slider-shell{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center;margin:18px 0}
.dyn-slider-btn{display:none;align-items:center;justify-content:center;width:42px;height:42px;border:1.5px solid var(--cbr);border-radius:999px;background:var(--cb);color:var(--tc);font-size:15px;font-weight:400;cursor:pointer;transition:background .15s,border-color .15s,color .15s;flex-shrink:0}
.dyn-slider-btn:hover{background:var(--bg-alt);border-color:var(--btn-bg);color:var(--btn-bg)}
.dyn-slider-wrap{overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;margin:0}
.dyn-slider-wrap::-webkit-scrollbar{height:8px}
.dyn-slider-wrap::-webkit-scrollbar-thumb{background:rgba(27,58,45,.25);border-radius:999px}
.dyn-slider-track{display:flex;gap:14px;padding-bottom:4px}
.dyn-slide{flex:0 0 240px;max-width:240px;min-height:220px;scroll-snap-align:start;background:var(--btn-bg);color:#fff;padding:2rem 1.75rem;display:flex;flex-direction:column;justify-content:center;gap:1rem;border-radius:10px}
.dyn-slide img,.dyn-slide figure,.dyn-slider-wrap figure{display:none!important}
.dyn-slide p{font-size:15px;font-weight:400;text-transform:none;letter-spacing:normal;color:var(--accent);margin:0;line-height:1.55}
.dyn-slide .dyn-fact{font-size:15px;font-weight:400;color:#fff;margin:0;line-height:1.55}
.dyn-slide-inline{margin:10px 0}
@media(min-width:768px){.dyn-slider-btn{display:inline-flex}}
@media(max-width:767px){.dyn-slider-shell{grid-template-columns:minmax(0,1fr)}}

.ai-answer-card{background:#f5f5f5;border:1px solid rgba(27,58,45,.14);border-radius:12px;padding:18px 20px;margin:0 0 22px}
.ai-answer-card p{margin-bottom:.7rem}
.ai-answer-kicker{display:none!important}
.ai-answer-card h2{display:none!important}
.ai-answer-grid{display:grid;grid-template-columns:1fr;gap:10px;margin-top:14px}
@media(min-width:640px){.ai-answer-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
.ai-answer-item{display:flex;flex-direction:column;gap:3px;padding:10px 12px;background:rgba(255,255,255,.65);border:1px solid rgba(27,58,45,.08);border-radius:10px}
.ai-answer-item strong{font-size:.74rem;letter-spacing:.03em;text-transform:uppercase;color:var(--text-muted)}

.yr{color:#1a1a1a;font-size:.95rem;font-weight:700;margin-right:8px;white-space:nowrap;font-family:Georgia,serif}
.ev-scroll-wrap{max-height:320px;overflow-y:auto;-webkit-overflow-scrolling:touch;scrollbar-width:thin;scrollbar-color:var(--cbr) transparent;border:1px solid var(--cbr);border-radius:8px;padding:0 8px 0 0}.ev-scroll-wrap::-webkit-scrollbar{width:4px}.ev-scroll-wrap::-webkit-scrollbar-thumb{background:var(--cbr);border-radius:4px}.ev-scroll-wrap .ev-row,.ev-scroll-wrap .person-row{padding-left:10px}
.ev-row{padding:11px 0;border-bottom:1px solid var(--cbr)}.ev-row:last-child{border-bottom:none}
.person-row{padding:9px 0;border-bottom:1px solid var(--cbr)}.person-row:last-child{border-bottom:none}
.p-thumb{width:44px;height:44px;border-radius:50%;object-fit:cover;flex-shrink:0}
.p-thumb-blank{width:44px;height:44px;border-radius:50%;background:#e2e8f0;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:1.2rem;color:#6c757d}

.auto-tag{display:inline-block;background:rgba(0,0,0,.12);color:#1a1a1a;font-size:13px;font-weight:400;padding:2px 7px;border-radius:20px;margin-left:6px;vertical-align:middle}

.ad-unit{margin:22px 0;text-align:center}.ad-unit-label{font-size:13px;font-weight:400;letter-spacing:.06em;color:var(--mu);text-transform:uppercase;margin-bottom:6px;opacity:.7}
.tdq-question{margin-bottom:18px}.tdq-q-text{font-weight:600;margin-bottom:10px;font-size:.95rem;color:var(--tc)}.tdq-options{display:flex;flex-direction:column;gap:8px}
.tdq-opt{display:flex;align-items:center;gap:10px;padding:9px 14px;border:1.5px solid var(--cbr);border-radius:8px;cursor:pointer;font-size:.9rem;transition:background .15s,border-color .15s;user-select:none}
.tdq-opt:hover{border-color:var(--btn-bg);background:var(--bg-alt)}.tdq-opt-selected{border-color:var(--btn-bg)!important;background:rgba(157,196,58,.15)!important;font-weight:500}
.tdq-opt-correct{border-color:#10b981!important;background:#d1fae5!important;color:#0f172a!important}.tdq-opt-wrong{border-color:#ef4444!important;background:#fee2e2!important;color:#0f172a!important}
.tdq-opt-key{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:#e2e8f0;font-size:.75rem;font-weight:700;flex-shrink:0}
.tdq-opt-selected .tdq-opt-key{background:var(--btn-bg);color:#fff}.tdq-opt-correct .tdq-opt-key{background:#10b981;color:#fff}.tdq-opt-wrong .tdq-opt-key{background:#ef4444;color:#fff}

.tdq-explanation{font-size:.85rem;margin-top:6px;padding:8px 12px;background:rgba(0,0,0,.07);border-left:3px solid var(--btn-bg);border-radius:0 6px 6px 0;color:var(--text)}

.tdq-feedback{font-size:.85rem;margin-top:5px}.tdq-correct{color:#10b981;font-weight:600}.tdq-wrong{color:#ef4444;font-weight:600}
.tdq-score-box{font-size:1.05rem;font-weight:600;padding:12px 16px;background:rgba(157,196,58,.1);border-radius:8px;border-left:4px solid var(--accent)}.tdq-score-num{color:var(--accent);font-size:1.2rem}
.site-table{width:100%;max-width:480px;border-collapse:collapse;border:1.5px solid var(--cbr);border-radius:10px;overflow:hidden;margin-top:1rem;font-size:.9rem}
.site-table th,.site-table td{padding:8px 14px;border-bottom:1px solid var(--cbr);text-align:left;color:var(--tc)}
.site-table tr:last-child th,.site-table tr:last-child td{border-bottom:none}
.site-table th{background:rgba(0,0,0,.07);font-weight:600;white-space:nowrap;width:40%}

.site-btn{display:inline-flex;align-items:center;gap:8px;padding:.5rem 1.1rem;background:transparent;color:var(--text);border:1.5px solid var(--border);border-radius:4px;font-size:15px;font-family:Lora,serif;font-weight:400;text-decoration:none;cursor:pointer;transition:background .15s,border-color .15s;user-select:none;white-space:nowrap}
.site-btn:hover{background:var(--bg-alt);color:var(--text);border-color:var(--border);text-decoration:none}
.site-btn-primary{background:#1a3a2d!important;color:#fff!important;border-color:#1a3a2d!important}
.site-btn-primary:hover{background:#2a4d3a!important;border-color:#2a4d3a!important;color:#fff!important}

#read-progress{position:fixed;top:0;left:0;height:3px;width:0%;background:var(--btn-bg);z-index:9999;transition:width .1s linear;pointer-events:none}

.explore-actions{display:flex;flex-direction:column;gap:.5rem}
@media(min-width:576px){.explore-actions{flex-direction:row;flex-wrap:wrap;gap:.5rem}}
.explore-action-btn{display:flex;align-items:center;width:100%;padding:.6rem 1rem;font-size:15px;font-weight:400;border:1.5px solid var(--cbr);border-radius:8px;text-decoration:none;color:var(--tc);background:transparent;transition:background .15s,border-color .15s}
@media(min-width:576px){.explore-action-btn{width:auto}}
.explore-action-btn:hover{background:rgba(0,0,0,.06);border-color:rgba(0,0,0,.35);color:#1a1a1a;text-decoration:none}
.explore-action-quiz{border-color:rgba(0,0,0,.3);color:#1a1a1a}
.explore-action-quiz:hover{background:rgba(0,0,0,.1);border-color:#1a1a1a}

.date-cluster-card{padding:18px 20px}
.date-cluster-links{display:grid;grid-template-columns:1fr;gap:.65rem}
@media(min-width:576px){.date-cluster-links{grid-template-columns:repeat(2,minmax(0,1fr))}}
.date-cluster-link{display:flex;align-items:center;gap:.7rem;padding:.8rem 1rem;border:1.5px solid var(--cbr);border-radius:8px;background:transparent;color:var(--tc);text-decoration:none;font-size:15px;font-weight:400;transition:background .15s,border-color .15s,transform .15s}
.date-cluster-link:hover{background:rgba(0,0,0,.05);border-color:rgba(0,0,0,.35);color:#1a1a1a;text-decoration:none;transform:translateY(-1px)}
.date-cluster-link i{font-size:1rem;flex-shrink:0}
.date-cluster-link-active{background:var(--bg-alt);border-color:var(--btn-bg)}

/* ── Events Timeline ─────────────────────────────────────────── */
.tl-wrap{position:relative;padding:4px 0 8px}
.tl-wrap::before{content:'';position:absolute;left:50%;top:0;bottom:0;width:2px;background:var(--border);transform:translateX(-50%);z-index:0;pointer-events:none}
.tl-item{display:flex;align-items:flex-start;position:relative;margin-bottom:28px}
.tl-body{flex:1;min-width:0}
.tl-media{flex:1;min-width:0}
.tl-item-odd .tl-body{order:1;padding-right:44px}
.tl-item-odd .tl-node{order:2}
.tl-item-odd .tl-media{order:3;padding-left:44px}
.tl-item-even .tl-media{order:1;padding-right:44px}
.tl-item-even .tl-node{order:2}
.tl-item-even .tl-body{order:3;padding-left:44px}
.tl-node{flex:0 0 72px;display:flex;justify-content:center;padding-top:10px;position:relative;z-index:1}
.tl-node-badge{display:inline-block;background:var(--btn-bg);color:#fff;font-size:13px;font-weight:400;padding:4px 9px;border-radius:20px;white-space:nowrap;font-family:Georgia,serif;letter-spacing:.01em;box-shadow:0 0 0 3px var(--bg)}
.tl-card{border:1px solid var(--cbr);border-radius:10px;overflow:hidden;background:var(--bg);transition:box-shadow .15s;display:flex;flex-direction:column}
.tl-card:hover{box-shadow:var(--shadow)}
.tl-card-img{width:100%;height:200px;object-fit:cover;object-position:top;display:block}
.tl-card-img-blank{width:100%;height:160px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:2rem;background:rgba(0,0,0,.05)}
.tl-card-body{padding:14px 16px;flex:1;display:flex;flex-direction:column}
.tl-card-title{font-weight:700;font-size:15px;line-height:1.4;color:var(--text);margin-bottom:4px}
.tl-card-desc{font-size:14px;color:#333;line-height:1.6;margin-bottom:6px;font-style:italic}
.tl-card-extract{font-size:14px;color:#333;line-height:1.6;margin-bottom:10px;opacity:.85;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;flex:1}
.tl-btn{font-size:15px!important;font-weight:400!important;padding:9px 10px!important;margin-top:auto;display:flex!important;justify-content:center!important;width:100%!important;box-sizing:border-box}
.tl-thumb{width:100%;height:auto;max-height:130px;object-fit:contain;border-radius:8px;display:block;background:rgba(0,0,0,.04);padding:4px}
.tl-thumb-blank{width:100%;height:100px;border-radius:8px;background:rgba(0,0,0,.05);display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:1.6rem}
/* Featured first-event style */
.tl-card-feat{border-color:var(--btn-bg);border-width:2px;padding:16px 18px}
.tl-feat-img{width:100%;max-height:180px;object-fit:contain;border-radius:8px;margin-bottom:10px;background:rgba(0,0,0,.04);padding:4px;display:block}
.tl-feat-title{font-weight:400;font-size:15px;line-height:1.4;color:var(--text);margin-bottom:8px}
.tl-feat-body{font-size:15px;line-height:1.6;margin-bottom:10px}
.tl-node-badge-feat{font-size:13px;padding:5px 11px}
/* Mobile — single column with line + badge on left */
@media(max-width:767px){
  .tl-wrap::before{left:23px;transform:none}
  .tl-item{display:flex;flex-direction:row;align-items:flex-start;margin-bottom:16px;padding:0}
  .tl-item-odd .tl-node,.tl-item-even .tl-node{order:1!important;flex:0 0 46px;min-width:46px;display:flex;justify-content:center;padding-top:4px;position:static}
  .tl-item-odd .tl-body,.tl-item-even .tl-body{order:2!important;flex:1;min-width:0;padding:0 0 0 10px}
  .tl-item-odd .tl-media,.tl-item-even .tl-media{display:none}
  .tl-node-badge{font-size:13px;padding:3px 6px;letter-spacing:0;box-shadow:0 0 0 2px var(--bg)}
  .tl-node-badge-feat{font-size:13px;padding:4px 7px}
}

.ai-question-block{padding:20px}
.ai-question-grid{display:grid;grid-template-columns:1fr;gap:14px}
@media(min-width:640px){.ai-question-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
.ai-question-card{padding:16px;border:1px solid var(--cbr);border-radius:10px;background:rgba(255,255,255,.7)}
.ai-question-card h3{font-size:1rem;margin-bottom:8px}
.ai-question-card p{margin-bottom:12px;font-size:15px;line-height:1.6}
.topic-hub-links{border-top:1px solid var(--cbr);padding-top:14px}
.topic-hub-chip-row{display:flex;flex-wrap:wrap;gap:8px}
.topic-hub-chip{display:inline-flex;align-items:center;padding:7px 12px;border:1px solid var(--cbr);border-radius:999px;background:var(--bg-alt);color:var(--btn-bg);text-decoration:none;font-size:13px;font-weight:400}
.topic-hub-chip:hover{background:#e7f0e7;color:var(--btn-bg);text-decoration:none}

#supportPopup{position:fixed;inset:0;background:rgba(0,0,0,.35);display:none;justify-content:center;align-items:center;backdrop-filter:blur(2px);z-index:9998;opacity:0;transition:opacity .4s ease}
#supportPopup.show{display:flex;opacity:1}
.support-popup-content{background:var(--cb,#fff);color:var(--tc,#1e293b);padding:25px 28px;border-radius:12px;max-width:300px;width:90%;text-align:center;border:1px solid var(--cbr,rgba(0,0,0,.1));box-shadow:0 8px 25px rgba(0,0,0,.2);position:relative;animation:popupFadeIn .35s ease}
@keyframes popupFadeIn{from{transform:scale(.92);opacity:0}to{transform:scale(1);opacity:1}}
.support-close-btn{position:absolute;top:8px;right:10px;border:none;background:transparent;font-size:1.4rem;cursor:pointer;color:var(--mu,#64748b);line-height:1;padding:0}
.support-close-btn:hover{color:var(--tc,#1e293b)}`
  );
}

function getSharedPageScripts({ pageType = "page", pageSlug = "" } = {}) {
  return `<script async src="https://www.googletagmanager.com/gtag/js?id=G-WXEZ3868VN"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag("js", new Date());
gtag("config", "G-WXEZ3868VN");
gtag("config", "AW-17262488503");
</script>
<script>
(function(){
  var ref=document.referrer||"";
  if(!ref) return;
  var pageType=${JSON.stringify(pageType)};
  var pageSlug=${JSON.stringify(pageSlug)};
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
    page_type: pageType,
    page_slug: pageSlug,
    page_location: location.pathname
  });
  gtag("event","citation_target_visit",{
    ai_source: match.label,
    page_type: pageType,
    page_slug: pageSlug
  });
})();
</script>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
<script>
(function(){var t=document.getElementById('navToggle'),m=document.getElementById('navMobile');if(t&&m)t.addEventListener('click',function(){m.classList.toggle('active');});})();
const yrEl=document.getElementById('yr');
if(yrEl)yrEl.textContent=new Date().getFullYear();
const gt=k=>{try{return localStorage.getItem(k)}catch{return null}};
const st=(k,v)=>{try{localStorage.setItem(k,v)}catch{}};
const syncAdUnitVisibility=(ins)=>{if(!ins)return;const unit=ins.closest('.ad-unit,.ad-unit-container');if(!unit)return;const status=ins.getAttribute('data-ad-status');if(status==='unfilled')unit.style.display='none';if(status==='filled')unit.style.display='';};
const adObserver=new MutationObserver((mutations)=>{for(const m of mutations){if(m.type==='attributes'&&m.attributeName==='data-ad-status'){syncAdUnitVisibility(m.target);}}});
document.querySelectorAll('ins.adsbygoogle').forEach((ins)=>{syncAdUnitVisibility(ins);adObserver.observe(ins,{attributes:true,attributeFilter:['data-ad-status']});});
setTimeout(()=>{document.querySelectorAll('ins.adsbygoogle').forEach(syncAdUnitVisibility);},5000);
const initAds=()=>{if(location.hostname!=='thisday.info'&&location.hostname!=='www.thisday.info')return;document.querySelectorAll('ins.adsbygoogle').forEach((ins)=>{if(ins.getAttribute('data-adsbygoogle-status')||ins.getAttribute('data-ad-pushed'))return;if((ins.offsetWidth||0)===0)return;ins.setAttribute('data-ad-pushed','1');try{(adsbygoogle=window.adsbygoogle||[]).push({});}catch{}});};
if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',initAds,{once:true});}else{initAds();}
setTimeout(initAds,1200);
</script>
<script>(function(){var bar=document.getElementById('read-progress');if(!bar)return;document.addEventListener('scroll',function(){var doc=document.documentElement;var total=doc.scrollHeight-doc.clientHeight;var pct=total>0?Math.round((doc.scrollTop/total)*100):0;bar.style.width=pct+'%';bar.setAttribute('aria-valuenow',pct);},{passive:true});})();</script>
<div id="supportPopup"><div class="support-popup-content"><button class="support-close-btn">&times;</button><h4 style="font-size:1rem;margin-bottom:8px">History runs on facts, and this project runs on coffee!</h4><p style="font-size:.9rem;margin-bottom:14px">Your support is incredibly helpful and genuinely appreciated.</p><a href="https://buymeacoffee.com/fugec?new=1" target="_blank" rel="noopener" style="display:inline-block;padding:8px 18px;background:var(--btn-bg);color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:.9rem">Support with a coffee ☕</a></div></div>
<script>(function(){var p=document.getElementById('supportPopup');var c=p&&p.querySelector('.support-close-btn');if(!p||!c)return;try{var _t=localStorage.getItem('supportPopupClosed');if(_t&&Date.now()-Number(_t)<86400000)return;}catch(e){}var shown=false;var ready=false;var past70=false;function show(){if(shown)return;shown=true;p.classList.add('show');}setTimeout(function(){ready=true;if(past70)show();},60000);setTimeout(function(){show();},90000);window.addEventListener('scroll',function(){var s=window.scrollY+window.innerHeight;var t=document.documentElement.scrollHeight;if(s/t>=0.7){past70=true;if(ready)show();}},{passive:true});c.addEventListener('click',function(){p.classList.remove('show');try{localStorage.setItem('supportPopupClosed',String(Date.now()));}catch(e){}});})();</script>
${marqueeScript()}`;
}

function generateEventsDateHTML(
  monthName,
  day,
  eventsData,
  siteUrl,
  didYouKnowFacts = [],
  quizHtml = "",
  quizData = null,
  relatedBlogEntry = null,
) {
  const mNum = MONTH_NUM_MAP[monthName] || 1;
  const mDisplay = MONTH_DISPLAY_NAMES[mNum];
  const canonical = `${siteUrl}/events/${monthName}/${day}/`;
  const events = (eventsData?.events || []).slice().sort((a, b) => a.year - b.year);
  const births = eventsData?.births || [];
  const deaths = eventsData?.deaths || [];

  const featured = events.length
    ? events.reduce((best, e) => wikiRichScore(e) >= wikiRichScore(best) ? e : best, events[0])
    : null;
  const others = events.filter((e) => e !== featured);
  const topBirths = births.slice(0, 20);
  const topDeaths = deaths.slice(0, 20);

  const pageTitle = featured
    ? `What Happened on ${mDisplay} ${day}: ${featured.text.split(".")[0]} | thisDay.info`
    : `What Happened on ${mDisplay} ${day} in History | thisDay.info`;
  const rawDesc = featured
    ? `Discover what happened on ${mDisplay} ${day} throughout history. In ${featured.year}: ${featured.text.substring(0, 115)}...`
    : `Explore historical events, births, and deaths that occurred on ${mDisplay} ${day} throughout world history.`;
  const pageDesc = rawDesc.substring(0, 155);
  const ogImg =
    featured?.pages?.[0]?.thumbnail?.source || `${siteUrl}/images/logo.png`;
  const featImg =
    featured?.pages?.[0]?.originalimage?.source ||
    featured?.pages?.[0]?.thumbnail?.source ||
    null;
  const featWiki = featured?.pages?.[0]?.content_urls?.desktop?.page || "";
  const commentaryParas = featured
    ? workerCommentary(featured.year, featured.text)
    : [
        "Every date in history is someone's entire world.",
        "What we record as a footnote was, for those living it, the defining moment of their lives. The past was always someone's present.",
      ];
  const featTitle = featured
    ? `${escapeHtml(String(featured.year))} — ${escapeHtml(featured.text.split(".")[0])}`
    : escapeHtml(`Events on ${mDisplay} ${day}`);
  const featRemainder = featured
    ? featured.text.substring(featured.text.indexOf(".") + 1).trim()
    : "";

  // Era range helpers (must be before eventsIntroLine which references evEraRange)
  const fmtY = (y) => (y < 0 ? `${Math.abs(y)} BC` : String(y));
  const allEventYears = events
    .map((e) => parseInt(e.year) || null)
    .filter((y) => y !== null);
  const evMin = allEventYears.length ? Math.min(...allEventYears) : null;
  const evMax = allEventYears.length ? Math.max(...allEventYears) : null;
  const evEraRange =
    evMin !== null && evMax !== null && evMin !== evMax
      ? `${fmtY(evMin)} – ${fmtY(evMax)}`
      : evMin !== null
        ? fmtY(evMin)
        : "";

  // Intro paragraph — original content for SEO depth
  const eventsCountLabel =
    events.length > 0 ? `${events.length} recorded events` : "recorded events";
  const eventsIntroLine =
    events.length > 0
      ? `${mDisplay} ${day} spans ${eventsCountLabel} across recorded history${evEraRange ? ` — from ${evEraRange}` : ""}. Below is a curated digest of the most significant moments tied to this date.`
      : `Explore historical events, births, and deaths that occurred on ${mDisplay} ${day} throughout world history.`;
  const today = new Date().toISOString().split("T")[0];
  const _todayDate = new Date();
  const todayMonthSlug = MONTHS_ALL[_todayDate.getUTCMonth()];
  const todayDayNum = _todayDate.getUTCDate();

  // Prev / next day navigation
  const mIdx = mNum - 1;
  const prevDayNum = day > 1 ? day - 1 : DAYS_IN_MONTH[(mIdx - 1 + 12) % 12];
  const prevMIdx = day > 1 ? mIdx : (mIdx - 1 + 12) % 12;
  const prevMonthName = MONTHS_ALL[prevMIdx];
  const prevMonthDisplay = MONTH_DISPLAY_NAMES[prevMIdx + 1];
  const nextDayNum = day < DAYS_IN_MONTH[mIdx] ? day + 1 : 1;
  const nextMIdx = day < DAYS_IN_MONTH[mIdx] ? mIdx : (mIdx + 1) % 12;
  const nextMonthName = MONTHS_ALL[nextMIdx];
  const nextMonthDisplay = MONTH_DISPLAY_NAMES[nextMIdx + 1];

  // FAQ schema for voice search + featured snippets
  const faqSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: `What happened on ${mDisplay} ${day} in history?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: featured
            ? `On ${mDisplay} ${day}, ${featured.year}: ${featured.text}`
            : `Explore historical events on thisDay.info for ${mDisplay} ${day}.`,
        },
      },
      ...(births.length > 0
        ? [
            {
              "@type": "Question",
              name: `Who are famous people born on ${mDisplay} ${day}?`,
              acceptedAnswer: {
                "@type": "Answer",
                text: `Famous people born on ${mDisplay} ${day} include: ${births
                  .slice(0, 3)
                  .map((b) => b.text.split(",")[0])
                  .join(", ")}.`,
              },
            },
          ]
        : []),
      ...(deaths.length > 0
        ? [
            {
              "@type": "Question",
              name: `What famous people died on ${mDisplay} ${day}?`,
              acceptedAnswer: {
                "@type": "Answer",
                text: `Notable historical figures who died on ${mDisplay} ${day} include: ${deaths
                  .slice(0, 3)
                  .map((d) => d.text.split(",")[0])
                  .join(", ")}.`,
              },
            },
          ]
        : []),
    ],
  }).replace(/<\//g, "<\\/");

  const articleSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
    headline: pageTitle,
    description: pageDesc,
    url: canonical,
    datePublished: today,
    dateModified: today,
    articleSection: "History",
    inLanguage: "en",
    author: {
      "@type": "Person",
      name: "thisDay.info Editorial Team",
      url: `${siteUrl}/about/`,
    },
    publisher: {
      "@type": "Organization",
      name: "thisDay.info",
      url: siteUrl,
      logo: { "@type": "ImageObject", url: `${siteUrl}/images/logo.png` },
    },
    ...(featImg && { image: { "@type": "ImageObject", url: featImg } }),
    about: { "@type": "Thing", name: `Historical events on ${mDisplay} ${day}` },
    ...(events.length > 0 && {
      mentions: events.slice(0, 6).map((ev) => ({
        "@type": "Event",
        name: String(ev.text || "").split(".")[0].trim(),
        startDate: String(ev.year),
        ...(ev.pages?.[0]?.content_urls?.desktop?.page
          ? { sameAs: ev.pages[0].content_urls.desktop.page }
          : {}),
      })),
    }),
  }).replace(/<\//g, "<\\/");

  const eventsSchema =
    events.length > 0
      ? JSON.stringify({
          "@context": "https://schema.org",
          "@type": "ItemList",
          name: `Historical Events on ${mDisplay} ${day}`,
          numberOfItems: events.length,
          itemListElement: events.slice(0, 5).map((e, i) => ({
            "@type": "ListItem",
            position: i + 1,
            item: {
              "@type": "Event",
              name: e.text.substring(0, 100),
              description: e.text,
              temporalCoverage: String(e.year),
            },
          })),
        }).replace(/<\//g, "<\\/")
      : null;

  const quizSchema = quizData?.questions?.length
    ? JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Quiz",
        name: `${mDisplay} ${day} History Quiz`,
        description: quizData.topic
          ? `Think you know what happened on ${mDisplay} ${day}? Take our free 5-question history quiz on ${quizData.topic} and test your knowledge.`
          : `Test your knowledge of historical events on ${mDisplay} ${day}.`,
        url: `${siteUrl}/quiz/${monthName}/${day}/`,
        educationalLevel: "beginner",
        learningResourceType: "quiz",
        ...(quizData.topic
          ? {
              about: {
                "@type": "Event",
                name: quizData.topic,
                description: quizData.sourceEvent || "",
              },
            }
          : {}),
        isPartOf: {
          "@type": "WebPage",
          url: `${siteUrl}/events/${monthName}/${day}/`,
        },
        publisher: {
          "@type": "Organization",
          name: "thisday.info",
          url: siteUrl,
        },
        hasPart: quizData.questions.map((q) => ({
          "@type": "Question",
          name: q.q,
          acceptedAnswer: {
            "@type": "Answer",
            text: q.options?.[q.answer] ?? "",
          },
        })),
      }).replace(/<\//g, "<\\/")
    : null;

  const breadcrumbSchema = buildBreadcrumbSchema([
    { name: "Home", item: `${siteUrl}/` },
    { name: "On This Day", item: `${siteUrl}/events/` },
    { name: `${mDisplay} ${day} in History`, item: canonical },
  ]);

  // Births era range
  const birthYears = topBirths
    .map((b) => parseInt(b.year) || null)
    .filter((y) => y !== null);
  const bMin = birthYears.length ? Math.min(...birthYears) : null;
  const bMax = birthYears.length ? Math.max(...birthYears) : null;
  const birthEraRange =
    bMin !== null && bMax !== null && bMin !== bMax
      ? `${fmtY(bMin)} – ${fmtY(bMax)}`
      : bMin !== null
        ? fmtY(bMin)
        : "";

  // Deaths era range
  const deathYears = topDeaths
    .map((d) => parseInt(d.year) || null)
    .filter((y) => y !== null);
  const dMin = deathYears.length ? Math.min(...deathYears) : null;
  const dMax = deathYears.length ? Math.max(...deathYears) : null;
  const deathEraRange =
    dMin !== null && dMax !== null && dMin !== dMax
      ? `${fmtY(dMin)} – ${fmtY(dMax)}`
      : dMin !== null
        ? fmtY(dMin)
        : "";

  // Featured event as first timeline item (hero)
  const renderFeaturedTimelineItem = () => {
    if (!featured) return "";
    const yearStr = escapeHtml(String(featured.year));
    const mobileImg = featImg
      ? `<img src="/image-proxy?src=${encodeURIComponent(featImg)}&w=600&q=80" alt="${escapeHtml(featured.text.substring(0, 80))}" class="tl-feat-img d-md-none" loading="eager"/>`
      : "";
    const didYouKnowHtml = didYouKnowFacts.length > 0
      ? buildDidYouKnowSlider(didYouKnowFacts, "dyn-slide-inline")
      : `<div class="commentary" style="margin:10px 0"><i class="bi bi-chat-quote me-1" style="color:#1a1a1a"></i>${commentaryParas.map((p, i, a) => `<p class="${i === a.length - 1 ? "mb-0" : "mb-2"}">${p}</p>`).join("")}</div>`;
    const card = `<div class="tl-card tl-card-feat">
  ${mobileImg}
  <div class="tl-feat-title">${featTitle}</div>
  <p class="tl-feat-body">${escapeHtml(featured.text)}</p>
  ${didYouKnowHtml}
  <table class="site-table" style="margin-top:10px">
    <tbody>
      <tr><th>Date</th><td>${escapeHtml(mDisplay)} ${day}</td></tr>
      <tr><th>Year</th><td>${escapeHtml(String(featured.year))}</td></tr>
      <tr><th>Events recorded</th><td>${events.length}</td></tr>
      <tr><th>Data source</th><td><a href="https://www.wikipedia.org" target="_blank" rel="noopener noreferrer">Wikipedia</a></td></tr>
    </tbody>
  </table>
  ${featWiki ? `<a href="${escapeHtml(featWiki)}" class="site-btn w-100 mt-3" style="justify-content:center" target="_blank" rel="noopener noreferrer"><i class="bi bi-box-arrow-up-right"></i>Full Article on Wikipedia</a>` : ""}
</div>`;
    const media = featImg
      ? `<div class="tl-media"><img src="/image-proxy?src=${encodeURIComponent(featImg)}&w=400&q=85" alt="${escapeHtml(featured.text.substring(0, 80))}" class="tl-thumb" style="max-height:220px" loading="eager" onerror="this.closest('.tl-media').innerHTML='<div class=\\'tl-thumb-blank\\'><i class=\\'bi bi-calendar-event\\'></i></div>'"/></div>`
      : `<div class="tl-media"><div class="tl-thumb-blank"><i class="bi bi-calendar-event"></i></div></div>`;
    const node = `<div class="tl-node"><span class="tl-node-badge tl-node-badge-feat event-years-ago">${yearStr}</span></div>`;
    return `<div class="tl-item tl-item-odd">
  <div class="tl-body">${card}</div>${node}${media}
</div>`;
  };

  // Events timeline — alternating left/right layout with center line
  const renderTimelineItem = (e, idx) => {
    const w = e.pages?.[0]?.content_urls?.desktop?.page || "";
    const th = e.pages?.[0]?.thumbnail?.source || "";
    const yearStr = escapeHtml(String(e.year));
    const fullText = e.text;
    const dotIdx = fullText.indexOf(". ");
    const titleText = dotIdx > 0 ? escapeHtml(fullText.slice(0, dotIdx + 1)) : escapeHtml(fullText);
    const descText = dotIdx > 0 ? escapeHtml(fullText.slice(dotIdx + 2).trim()) : "";
    const pageDesc = escapeHtml(e.pages?.[0]?.description || "");
    const pageExtract = escapeHtml(e.pages?.[0]?.extract || "");
    const imgAlt = escapeHtml(
      e.pages?.[0]?.title || e.pages?.[0]?.normalizedtitle || fullText,
    );
    const isEven = idx % 2 === 1;
    const imgHtml = th
      ? w
        ? `<a href="${escapeHtml(w)}" target="_blank" rel="noopener noreferrer" tabindex="-1"><img src="${escapeHtml(th)}" alt="${imgAlt}" class="tl-card-img" loading="lazy" onerror="this.closest('a').outerHTML='<div class=\\'tl-card-img-blank\\'><i class=\\'bi bi-image-alt\\'></i></div>'"></a>`
        : `<img src="${escapeHtml(th)}" alt="${imgAlt}" class="tl-card-img" loading="lazy" onerror="this.outerHTML='<div class=\\'tl-card-img-blank\\'><i class=\\'bi bi-image-alt\\'></i></div>'">`
      : `<div class="tl-card-img-blank"><i class="bi bi-image-alt"></i></div>`;
    const card = `<div class="tl-card">
  ${imgHtml}
  <div class="tl-card-body">
    <div class="tl-card-title">${titleText}</div>
    ${descText ? `<div class="tl-card-desc">${descText}</div>` : pageDesc ? `<div class="tl-card-desc">${pageDesc}</div>` : ""}
    ${pageExtract ? `<div class="tl-card-extract">${pageExtract}</div>` : ""}
    ${w ? `<a href="${escapeHtml(w)}" target="_blank" rel="noopener noreferrer" class="site-btn site-btn-primary tl-btn">Read More</a>` : ""}
  </div>
</div>`;
    const node = `<div class="tl-node"><span class="tl-node-badge event-years-ago">${yearStr}</span></div>`;
    return `<div class="tl-item ${isEven ? "tl-item-even" : "tl-item-odd"}">
  <div class="tl-body">${card}</div>
  ${node}
  <div class="tl-media"></div>
</div>`;
  };
  const othersVisibleHtml = others.slice(0, 10).map((e, i) => renderTimelineItem(e, i)).join("");
  const othersHiddenHtml = others.slice(10).map((e, i) => renderTimelineItem(e, i + 10)).join("");

  // Person timeline item renderer (replaces card + grid row)
  const renderPersonTimelineItem = (p, idx, isDeaths = false) => {
    const th = p.pages?.[0]?.thumbnail?.source || "";
    const w = p.pages?.[0]?.content_urls?.desktop?.page || "";
    const name = escapeHtml(p.text.split(",")[0]);
    const desc = p.text.includes(",")
      ? escapeHtml(p.text.slice(p.text.indexOf(",") + 1).trim())
      : "";
    const rawExtract = p.pages?.[0]?.extract || "";
    const extract = rawExtract
      ? escapeHtml(rawExtract.length > 220 ? rawExtract.slice(0, 220).replace(/\s\S*$/, "") + "…" : rawExtract)
      : "";
    const year = escapeHtml(String(p.year));
    const badgeStyle = isDeaths ? ' style="background:#6c757d"' : "";
    const isEven = idx % 2 === 1;
    const imgHtml = th
      ? w
        ? `<a href="${escapeHtml(w)}" target="_blank" rel="noopener noreferrer" tabindex="-1"><img src="${escapeHtml(th)}" alt="${name}" class="tl-card-img" loading="lazy" onerror="this.closest('a').outerHTML='<div class=\\'tl-card-img-blank\\'><i class=\\'bi bi-person\\'></i></div>'"></a>`
        : `<img src="${escapeHtml(th)}" alt="${name}" class="tl-card-img" loading="lazy" onerror="this.outerHTML='<div class=\\'tl-card-img-blank\\'><i class=\\'bi bi-person\\'></i></div>'">`
      : `<div class="tl-card-img-blank"><i class="bi bi-person"></i></div>`;
    const card = `<div class="tl-card">
  ${imgHtml}
  <div class="tl-card-body">
    <div class="tl-card-title">${name}</div>
    ${desc ? `<div class="tl-card-desc">${desc}</div>` : ""}
    ${extract ? `<div class="tl-card-extract">${extract}</div>` : ""}
    ${w ? `<a href="${escapeHtml(w)}" target="_blank" rel="noopener noreferrer" class="site-btn site-btn-primary tl-btn">Read More</a>` : ""}
  </div>
</div>`;
    const media = `<div class="tl-media"></div>`;
    const node = `<div class="tl-node"><span class="tl-node-badge event-years-ago"${badgeStyle}>${year}</span></div>`;
    return `<div class="tl-item ${isEven ? "tl-item-even" : "tl-item-odd"}">
  <div class="tl-body">${card}</div>${node}${media}
</div>`;
  };

  const birthTimelineHtml = topBirths
    .map((b, i) => renderPersonTimelineItem(b, i, false))
    .join("");
  const deathTimelineHtml = topDeaths
    .map((d, i) => renderPersonTimelineItem(d, i, true))
    .join("");
  const relatedBlogHtml = buildRelatedBlogCard(
    relatedBlogEntry,
    `${mDisplay} ${day} in the Blog`,
  );
  const relatedQuestionsHtml = buildEventRelatedQuestionsBlock({
    mDisplay,
    day,
    featured,
    events,
    births,
    deaths,
    relatedBlogEntry,
  });

  return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${escapeHtml(pageTitle)}</title>
<link rel="canonical" href="${escapeHtml(canonical)}"/>
<link rel="prev" href="${escapeHtml(`${siteUrl}/events/${prevMonthName}/${prevDayNum}/`)}"/>
<link rel="next" href="${escapeHtml(`${siteUrl}/events/${nextMonthName}/${nextDayNum}/`)}"/>
<meta name="robots" content="index, follow"/><meta name="description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:title" content="${escapeHtml(pageTitle)}"/><meta property="og:description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:type" content="article"/><meta property="og:url" content="${escapeHtml(canonical)}"/>
<meta property="og:locale" content="en_US"/>
<meta property="og:site_name" content="thisDay."/><meta property="og:image" content="${escapeHtml(ogImg)}"/>
<meta name="twitter:card" content="summary_large_image"/><meta name="twitter:title" content="${escapeHtml(pageTitle)}"/>
<meta name="twitter:description" content="${escapeHtml(pageDesc)}"/><meta name="twitter:image" content="${escapeHtml(ogImg)}"/>
<meta name="author" content="thisDay.info"/>
<script type="application/ld+json">${articleSchema}</script>
${eventsSchema ? `<script type="application/ld+json">${eventsSchema}</script>` : ""}
<script type="application/ld+json">${faqSchema}</script>
<script type="application/ld+json">${breadcrumbSchema}</script>
${quizSchema ? `<script type="application/ld+json">${quizSchema}</script>` : ""}
<link rel="icon" href="/images/favicon.ico" type="image/x-icon"/>
<link rel="apple-touch-icon" sizes="180x180" href="/images/apple-touch-icon.png"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"/>
<link rel="stylesheet" href="/css/style.css"/>
<link rel="stylesheet" href="/css/custom.css"/>
<style>${getSharedPageStyles()}</style>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8565025017387209" crossorigin="anonymous"></script>
</head>
<body>
<div id="read-progress" role="progressbar" aria-label="Reading progress" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"></div>
${siteNav()}
<main class="container my-4" style="max-width:860px">
  <nav aria-label="breadcrumb" class="mb-3">
    <ol class="breadcrumb">
      <li class="breadcrumb-item"><a href="/">Home</a></li>
      <li class="breadcrumb-item"><a href="/events/">On This Day</a></li>
      <li class="breadcrumb-item active" aria-current="page">${escapeHtml(mDisplay)} ${day}</li>
    </ol>
  </nav>
  <h1 class="mb-2">${escapeHtml(mDisplay)} ${day} in History</h1>
  <div class="d-flex flex-wrap gap-2 align-items-center mb-2">
    ${events.length > 0 ? `<span class="auto-tag event-years-ago ms-2"><i class="bi bi-list-ul me-1"></i>${events.length} events</span>` : ""}
    ${evEraRange ? `<span class="auto-tag event-years-ago ms-2"><i class="bi bi-clock-history me-1"></i>${escapeHtml(evEraRange)}</span>` : ""}
  </div>
  <p class="text-muted mb-2" style="font-size:15px">${escapeHtml(eventsIntroLine)}</p>
  <p class="text-muted mb-4" style="font-size:.82rem">By <a href="/about/" rel="author" style="color:inherit">thisDay.info Editorial Team</a> &middot; <time datetime="${today}">${escapeHtml(mDisplay)} ${day}</time> &mdash; <a href="https://www.wikipedia.org" target="_blank" rel="noopener noreferrer">Wikipedia</a></p>
  ${
    featured || others.length > 0
      ? `
  <div class="card-box" style="padding:0;overflow:hidden">
    ${featImg && featured ? `<img src="/image-proxy?src=${encodeURIComponent(featImg)}&w=800&q=85" srcset="/image-proxy?src=${encodeURIComponent(featImg)}&w=400 400w, /image-proxy?src=${encodeURIComponent(featImg)}&w=800 800w" sizes="(max-width:640px) 100vw, 800px" alt="${escapeHtml(featured.text.substring(0, 80))}" class="feat-img" loading="eager" style="width:100%;display:block;max-height:380px;object-fit:cover;object-position:top"/>` : ""}
    <div style="padding:20px 24px">
    ${featured ? `
    <h2 style="margin-top:0">${featTitle}</h2>
    ${featRemainder ? `<p class="mb-3">${escapeHtml(featRemainder)}</p>` : ""}
    ${didYouKnowFacts.length > 0 ? buildDidYouKnowSlider(didYouKnowFacts) : `<div class="commentary"><i class="bi bi-chat-quote me-1" style="color:#1a1a1a"></i>${commentaryParas.map((p, i, a) => `<p class="${i === a.length - 1 ? "mb-0" : "mb-2"}">${p}</p>`).join("")}</div>`}
    <hr style="border:none;border-top:1px solid var(--cbr);margin:20px 0 16px"/>` : ""}
    ${others.length > 0 ? `
    <div class="tl-wrap">${othersVisibleHtml}</div>
    ${othersHiddenHtml ? `<div id="events-more" style="display:none"><div class="tl-wrap">${othersHiddenHtml}</div></div>
    <button onclick="var m=document.getElementById('events-more');m.style.display=m.style.display==='none'?'block':'none';this.innerHTML=m.style.display==='none'?'<i class=\\'bi bi-chevron-down me-1\\'></i>Show all ${others.length} events':'<i class=\\'bi bi-chevron-up me-1\\'></i>Show less';" class="site-btn w-100 mt-3" style="justify-content:center"><i class="bi bi-chevron-down me-1"></i>Show all ${others.length} events</button>` : ""}` : ""}
    </div>
  </div>`
      : `<div class="alert alert-info">No events found for ${escapeHtml(mDisplay)} ${day}.</div>`
  }
  <div class="ad-unit">
    <div class="ad-unit-label">Advertisement</div>
    <ins class="adsbygoogle"
         style="display:block;border-radius:8px;overflow:hidden"
         data-ad-client="ca-pub-8565025017387209"
         data-ad-slot="9477779891"
         data-ad-format="auto"
         data-full-width-responsive="true"></ins>
  </div>
  ${
    topBirths.length > 0
      ? `
  <div class="card-box">
    <h2 class="h4 mb-2"><i class="bi bi-person-heart me-2" style="color:#1a1a1a"></i>Born on ${escapeHtml(mDisplay)} ${day}</h2>
    <div class="d-flex flex-wrap gap-2 align-items-center mb-3">
      <span class="auto-tag event-years-ago ms-2"><i class="bi bi-people me-1"></i>${topBirths.length} people</span>
      ${birthEraRange ? `<span class="auto-tag event-years-ago ms-2"><i class="bi bi-clock-history me-1"></i>${escapeHtml(birthEraRange)}</span>` : ""}
    </div>
    <div class="tl-wrap">${birthTimelineHtml}</div>
    <a href="/born/${monthName}/${day}/" class="site-btn w-100 mt-3" style="justify-content:center"><i class="bi bi-person-heart"></i>See all birthdays on ${escapeHtml(mDisplay)} ${day}</a>
  </div>`
      : ""
  }
  ${
    topDeaths.length > 0
      ? `
  <div class="card-box">
    <h2 class="h4 mb-2"><i class="bi bi-flower1 me-2" style="color:#6c757d"></i>Died on ${escapeHtml(mDisplay)} ${day}</h2>
    <div class="d-flex flex-wrap gap-2 align-items-center mb-3">
      <span class="auto-tag event-years-ago ms-2"><i class="bi bi-people me-1"></i>${topDeaths.length} people</span>
      ${deathEraRange ? `<span class="auto-tag event-years-ago ms-2"><i class="bi bi-clock-history me-1"></i>${escapeHtml(deathEraRange)}</span>` : ""}
    </div>
    <div class="tl-wrap">${deathTimelineHtml}</div>
    <a href="/died/${monthName}/${day}/" class="site-btn w-100 mt-3" style="justify-content:center"><i class="bi bi-flower1"></i>See all deaths on ${escapeHtml(mDisplay)} ${day}</a>
  </div>`
      : ""
  }
  ${relatedBlogHtml}
  ${relatedQuestionsHtml}
  ${buildEventAnswerBlock({ mDisplay, day, featured, events, evEraRange })}
	  ${buildDateClusterCard(monthName, day, mDisplay, "events")}
  <div class="card-box">
    <h3 class="h5 mb-3"><i class="bi bi-compass me-2" style="color:#1a1a1a"></i>Explore ${escapeHtml(mDisplay)} ${day}</h3>
    <div class="explore-actions">
      <a href="/quiz/${monthName}/${day}/" class="explore-action-btn explore-action-quiz"><i class="bi bi-patch-question me-2"></i>Test Your Knowledge</a>
      <a href="/born/${monthName}/${day}/" class="explore-action-btn"><i class="bi bi-person-heart me-2"></i>Famous Birthdays</a>
      <a href="/died/${monthName}/${day}/" class="explore-action-btn"><i class="bi bi-flower1 me-2"></i>Notable Deaths</a>
    </div>
  </div>
  <div class="ad-unit-container my-4">
    <span class="ad-unit-label">Advertisement</span>
    <ins class="adsbygoogle"
         style="display:block"
         data-ad-format="autorelaxed"
         data-ad-client="ca-pub-8565025017387209"
         data-ad-slot="9183511632"></ins>
  </div>
  <div class="my-5 pt-3 border-top">
    <div class="d-flex justify-content-between align-items-center mb-4">
      <a href="/events/${prevMonthName}/${prevDayNum}/" class="site-btn"><i class="bi bi-arrow-left"></i>${escapeHtml(prevMonthDisplay)} ${prevDayNum}</a>
      <a href="/events/${nextMonthName}/${nextDayNum}/" class="site-btn">${escapeHtml(nextMonthDisplay)} ${nextDayNum}<i class="bi bi-arrow-right"></i></a>
    </div>
    <div class="text-center">
      <p class="text-muted mb-3">Explore history for any date on the interactive calendar.</p>
      <a href="/" class="site-btn site-btn-primary w-100 mt-3"><i class="bi bi-calendar3"></i>Open the Calendar</a>
      <a href="/blog/" class="site-btn w-100 mt-3"><i class="bi bi-journal-text"></i>All Blog Posts</a>
    </div>
  </div>
</main>
${siteFooter("yr")}
${getSharedPageScripts({ pageType: "events-date", pageSlug: `${monthName}-${day}` })}
</body></html>`;
}

function serveEventsDateSitemap(siteUrl) {
  let urls = "";
  for (let m = 0; m < 12; m++) {
    for (let d = 1; d <= DAYS_IN_MONTH[m]; d++) {
      // Note: <lastmod> should reflect the actual last significant content change.
      // Since these pages are generated from upstream data and can change asynchronously,
      // we omit <lastmod> entirely to avoid sending inaccurate signals to crawlers.
      urls += `  <url>\n    <loc>${siteUrl}/events/${MONTHS_ALL[m]}/${d}/</loc>\n  </url>\n`;
      urls += `  <url>\n    <loc>${siteUrl}/quiz/${MONTHS_ALL[m]}/${d}/</loc>\n  </url>\n`;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}</urlset>`;
}

async function servePeopleSitemap(siteUrl, env) {
  let urls = "";
  for (let m = 0; m < 12; m++) {
    for (let d = 1; d <= DAYS_IN_MONTH[m]; d++) {
      urls += `  <url>\n    <loc>${siteUrl}/born/${MONTHS_ALL[m]}/${d}/</loc>\n  </url>\n`;
      urls += `  <url>\n    <loc>${siteUrl}/died/${MONTHS_ALL[m]}/${d}/</loc>\n  </url>\n`;
    }
  }
  const entityRaw = await env.BLOG_AI_KV?.get("entity-index-v1").catch(() => null);
  const entityIndex = await refreshEntityIndexFromStoredEntities(env, entityRaw ? JSON.parse(entityRaw) : [], "person");
  for (const person of entityIndex.filter((entry) => entry?.type === "person" && entry.indexable && entry.url)) {
    urls += `  <url>\n    <loc>${siteUrl}${person.url}</loc>\n  </url>\n`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}</urlset>`;
}

function buildDateClusterCard(monthName, day, mDisplay, currentType) {
  const links = [
    {
      type: "events",
      href: `/events/${monthName}/${day}/`,
      icon: "bi-calendar-event",
      label: `Events on ${mDisplay} ${day}`,
    },
    {
      type: "born",
      href: `/born/${monthName}/${day}/`,
      icon: "bi-person-heart",
      label: `Birthdays on ${mDisplay} ${day}`,
    },
    {
      type: "died",
      href: `/died/${monthName}/${day}/`,
      icon: "bi-flower1",
      label: `Deaths on ${mDisplay} ${day}`,
    },
    {
      type: "quiz",
      href: `/quiz/${monthName}/${day}/`,
      icon: "bi-patch-question",
      label: `${mDisplay} ${day} quiz`,
    },
  ];

  const buttons = links
    .map((link) => {
      const active = link.type === currentType;
      return `<a href="${link.href}" class="date-cluster-link${active ? " date-cluster-link-active" : ""}"${active ? ' aria-current="page"' : ""}><i class="bi ${link.icon}"></i>${escapeHtml(link.label)}</a>`;
    })
    .join("");

  return `<div class="card-box date-cluster-card">
    <h2 class="h5 mb-3"><i class="bi bi-signpost-split me-2" style="color:#1a1a1a"></i>Explore ${escapeHtml(mDisplay)} ${day}</h2>
    <p class="text-muted mb-3" style="font-size:15px">Jump between the main pages for this date to compare events, people, and the daily quiz.</p>
    <div class="date-cluster-links">${buttons}</div>
  </div>`;
}

function buildRelatedBlogCard(entry, heading = "Related Story") {
  if (!entry?.slug) return "";
  const title = escapeHtml(entry.title || "Read the related historical story");
  const description = escapeHtml(entry.description || "");
  const img = entry.imageUrl
    ? `/image-proxy?src=${encodeURIComponent(entry.imageUrl)}&w=320&q=80`
    : "";
  const thumb = img
    ? `<img src="${img}" alt="${title}" width="96" height="72" style="width:96px;height:72px;min-width:96px;object-fit:cover;border-radius:8px;display:block" loading="lazy">`
    : `<div style="width:96px;height:72px;min-width:96px;border-radius:8px;background:rgba(0,0,0,.06);display:flex;align-items:center;justify-content:center;color:var(--btn-bg,#1b3a2d);font-size:1.1rem"><i class="bi bi-journal-richtext"></i></div>`;
  return `<div class="card-box">
    <h3 class="h5 mb-3"><i class="bi bi-journal-richtext me-2" style="color:#1a1a1a"></i>${escapeHtml(heading)}</h3>
    <a href="/blog/${escapeHtml(entry.slug)}/" class="d-flex align-items-start gap-3 text-decoration-none" style="color:inherit">
      ${thumb}
      <div style="min-width:0">
        <div class="fw-semibold" style="font-size:.96rem;line-height:1.35;color:var(--btn-bg,#1b3a2d)">${title}</div>
        ${description ? `<p class="mb-2 mt-1 text-muted" style="font-size:15px;line-height:1.6">${description}</p>` : ""}
        <span class="small" style="font-weight:600">Read the full story <i class="bi bi-arrow-right ms-1"></i></span>
      </div>
    </a>
  </div>`;
}

async function findMatchingDateBlogEntry(env, monthName, day) {
  if (!env?.BLOG_AI_KV) return null;
  try {
    const index = await env.BLOG_AI_KV.get("index", { type: "json" });
    if (!Array.isArray(index) || !index.length) return null;
    const currentYear = new Date().getUTCFullYear();
    const candidates = [`${day}-${monthName}-${currentYear}`, `${day}-${monthName}-${currentYear - 1}`];
    for (const slug of candidates) {
      const match = index.find((entry) => entry?.slug === slug);
      if (match) return match;
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

function buildBreadcrumbSchema(items) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.item,
    })),
  }).replace(/<\//g, "<\\/");
}

function buildPageSchema({
  type = "WebPage",
  name,
  description,
  url,
  mainEntityId,
  about,
  mentions,
}) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": type,
    name,
    description,
    url,
    isPartOf: {
      "@type": "WebSite",
      name: "thisDay.info",
      url: "https://thisday.info/",
    },
    ...(about ? { about } : {}),
    ...(mentions?.length ? { mentions } : {}),
    ...(mainEntityId ? { mainEntity: { "@id": mainEntityId } } : {}),
  }).replace(/<\//g, "<\\/");
}

function generateBornHTML(siteUrl, monthName, day, eventsData, relatedBlogEntry = null) {
  const mNum = MONTH_NUM_MAP[monthName] || 1;
  const mDisplay = MONTH_DISPLAY_NAMES[mNum];
  const MM = String(mNum).padStart(2, "0");
  const DD = String(day).padStart(2, "0");
  const canonical = `${siteUrl}/born/${monthName}/${day}/`;

  const births = (eventsData?.births || []).slice().sort((a, b) => a.year - b.year);
  // Count qualifying DYK sentences for a person — prefer someone who produces DYK cards,
  // using wikiRichScore as a tiebreaker so we still get images when DYK counts are equal.
  const countDyk = (b) => {
    const extract = b?.pages?.[0]?.extract || "";
    return extract.split(/\.\s+/).filter((s) => {
      s = s.replace(/\s+/g, " ").trim();
      if (s.length < 50 || s.length > 220) return false;
      if (/^(He|She|It|This|They|The [a-z])/.test(s) && !/\d/.test(s)) return false;
      return true;
    }).length;
  };
  const hasImage = (p) => !!(p?.pages?.[0]?.thumbnail?.source || p?.pages?.[0]?.originalimage?.source);
  const bornScore = (b) => countDyk(b) * 10 + wikiRichScore(b);
  const birthsWithImg = births.filter(hasImage);
  const featuredPool = birthsWithImg.length ? birthsWithImg : births;
  const featured = featuredPool.length
    ? featuredPool.reduce((best, b) => bornScore(b) >= bornScore(best) ? b : best, featuredPool[0])
    : null;
  const othersB = births.filter((b) => b !== featured);
  const featName = featured ? escapeHtml(featured.text.split(",")[0]) : "";
  const featImg = featured?.pages?.[0]?.originalimage?.source || featured?.pages?.[0]?.thumbnail?.source || null;
  const featRemainder = featured ? featured.text.substring(featured.text.indexOf(",") + 1).trim() : "";
  const commentaryParas = featured ? workerCommentary(featured.year, featured.text) : [];
  const didYouKnowFacts = (() => {
    const scoreS = (s) =>
      (/\d/.test(s) ? 2 : 0) +
      (/\b(first|only|never|most|oldest|youngest|record|won|invented|discovered|became)\b/i.test(s) ? 3 : 0) +
      (/[A-Z][a-z]/.test(s.slice(5)) ? 1 : 0);
    return (featured?.pages?.[0]?.extract || "")
      .split(/\.\s+/)
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((s) => {
        if (s.length < 50 || s.length > 220) return false;
        if (/^(He|She|It|This|They|The [a-z])/.test(s) && !/\d/.test(s)) return false;
        return true;
      })
      .sort((a, b) => scoreS(b) - scoreS(a))
      .slice(0, 5);
  })();
  const ogImg = featImg || `${siteUrl}/images/logo.png`;
  const pageTitle = featured
    ? `${featName} & Other Famous Birthdays on ${mDisplay} ${day} | thisDay.info`
    : `Famous Birthdays on ${mDisplay} ${day} | thisDay.info`;
  const pageDesc =
    `Discover famous people born on ${mDisplay} ${day} throughout history. ${births.length} notable birthdays including ${births
      .slice(0, 3)
      .map((b) => b.text.split(",")[0])
      .join(", ")}.`.substring(0, 155);

  const mIdx = mNum - 1;
  const prevDay = day > 1 ? day - 1 : DAYS_IN_MONTH[(mIdx - 1 + 12) % 12];
  const prevMIdx = day > 1 ? mIdx : (mIdx - 1 + 12) % 12;
  const prevMonth = MONTHS_ALL[prevMIdx];
  const prevMDisplay = MONTH_DISPLAY_NAMES[prevMIdx + 1];
  const nextDay = day < DAYS_IN_MONTH[mIdx] ? day + 1 : 1;
  const nextMIdx = day < DAYS_IN_MONTH[mIdx] ? mIdx : (mIdx + 1) % 12;
  const nextMonth = MONTHS_ALL[nextMIdx];
  const nextMDisplay = MONTH_DISPLAY_NAMES[nextMIdx + 1];

  // Era range for stat bar
  const rawYears = births
    .map((b) => parseInt(b.year) || null)
    .filter((y) => y !== null);
  const minYear = rawYears.length ? Math.min(...rawYears) : null;
  const maxYear = rawYears.length ? Math.max(...rawYears) : null;
  const fmtYear = (y) => (y < 0 ? `${Math.abs(y)} BC` : String(y));
  const eraRange =
    minYear !== null && maxYear !== null && minYear !== maxYear
      ? `${fmtYear(minYear)} – ${fmtYear(maxYear)}`
      : minYear !== null
        ? fmtYear(minYear)
        : "";

  // Intro paragraph — original content for SEO depth
  const introLine =
    births.length > 0
      ? `${mDisplay} ${day} has seen ${births.length} notable people enter the world across recorded history${eraRange ? ` — from ${eraRange}` : ""}. Below are the most significant names born on this date.`
      : `Explore notable people born on ${mDisplay} ${day} throughout history.`;

  const topEvents = (eventsData?.events || []).slice(0, 3);

  // Schema — FAQPage
  const faqSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: `Who was born on ${mDisplay} ${day}?`,
        acceptedAnswer: {
          "@type": "Answer",
          text:
            births.length > 0
              ? `Famous people born on ${mDisplay} ${day} include: ${births
                  .slice(0, 5)
                  .map((b) => b.text.split(",")[0])
                  .join(", ")}.`
              : `Explore notable birthdays on ${mDisplay} ${day} at thisDay.info.`,
        },
      },
      ...(featured
        ? [
            {
              "@type": "Question",
              name: `What is ${featName} known for?`,
              acceptedAnswer: {
                "@type": "Answer",
                text: escapeHtml(featured.text),
              },
            },
          ]
        : []),
    ],
  });

  // Schema — ItemList with jobTitle
  const personListSchema =
    births.length > 0
      ? JSON.stringify({
          "@context": "https://schema.org",
          "@id": `${canonical}#birthdays`,
          "@type": "ItemList",
          name: `Famous Birthdays on ${mDisplay} ${day}`,
          url: canonical,
          numberOfItems: births.length,
          itemListElement: births.slice(0, 20).map((b, i) => {
            const jobTitle = b.text.includes(",")
              ? b.text.slice(b.text.indexOf(",") + 1).trim()
              : "";
            return {
              "@type": "ListItem",
              position: i + 1,
              item: {
                "@type": "Person",
                name: b.text.split(",")[0],
                birthDate: `${b.year}-${MM}-${DD}`,
                description: b.text,
                ...(jobTitle ? { jobTitle } : {}),
                ...(b.pages?.[0]?.content_urls?.desktop?.page
                  ? { sameAs: b.pages[0].content_urls.desktop.page }
                  : {}),
              },
            };
          }),
        })
      : null;

  const pageSchema = buildPageSchema({
    type: "CollectionPage",
    name: pageTitle.replace(" | thisDay.info", ""),
    description: pageDesc,
    url: canonical,
    mainEntityId: births.length > 0 ? `${canonical}#birthdays` : null,
    about: { "@type": "Thing", name: `Birthdays on ${mDisplay} ${day}` },
    mentions: buildPersonMentions(births, "birthDate"),
  });

  const breadcrumbSchema = buildBreadcrumbSchema([
    { name: "Home", item: `${siteUrl}/` },
    { name: "On This Day", item: `${siteUrl}/events/` },
    { name: `Born on ${mDisplay} ${day}`, item: canonical },
  ]);
  const relatedBlogHtml = buildRelatedBlogCard(
    relatedBlogEntry,
    `${mDisplay} ${day} in the Blog`,
  );

  // Timeline item renderer for born page
  const renderBornTlItem = (b, idx) => {
    const th = b.pages?.[0]?.thumbnail?.source || "";
    const w = b.pages?.[0]?.content_urls?.desktop?.page || "";
    const name = escapeHtml(b.text.split(",")[0]);
    const desc = b.text.includes(",")
      ? escapeHtml(b.text.slice(b.text.indexOf(",") + 1).trim())
      : "";
    const rawExtract = b.pages?.[0]?.extract || "";
    const extract = rawExtract
      ? escapeHtml(rawExtract.length > 220 ? rawExtract.slice(0, 220).replace(/\s\S*$/, "") + "…" : rawExtract)
      : "";
    const year = escapeHtml(String(b.year));
    const isEven = idx % 2 === 1;
    const imgHtml = th
      ? w
        ? `<a href="${escapeHtml(w)}" target="_blank" rel="noopener noreferrer" tabindex="-1"><img src="${escapeHtml(th)}" alt="${name}" class="tl-card-img" loading="lazy" onerror="this.closest('a').outerHTML='<div class=\\'tl-card-img-blank\\'><i class=\\'bi bi-person\\'></i></div>'"></a>`
        : `<img src="${escapeHtml(th)}" alt="${name}" class="tl-card-img" loading="lazy" onerror="this.outerHTML='<div class=\\'tl-card-img-blank\\'><i class=\\'bi bi-person\\'></i></div>'">`
      : `<div class="tl-card-img-blank"><i class="bi bi-person"></i></div>`;
    const card = `<div class="tl-card">
  ${imgHtml}
  <div class="tl-card-body">
    <div class="tl-card-title">${name}</div>
    ${desc ? `<div class="tl-card-desc">${desc}</div>` : ""}
    ${extract ? `<div class="tl-card-extract">${extract}</div>` : ""}
    ${w ? `<a href="${escapeHtml(w)}" target="_blank" rel="noopener noreferrer" class="site-btn site-btn-primary tl-btn">Read More</a>` : ""}
  </div>
</div>`;
    const media = `<div class="tl-media"></div>`;
    const node = `<div class="tl-node"><span class="tl-node-badge event-years-ago">${year}</span></div>`;
    return `<div class="tl-item ${isEven ? "tl-item-even" : "tl-item-odd"}">
  <div class="tl-body">${card}</div>${node}${media}
</div>`;
  };

  const visibleBirths = othersB.slice(0, 20);
  const hiddenBirths = othersB.slice(20);

  let visibleTlHtml = "";
  visibleBirths.forEach((b, i) => {
    visibleTlHtml += renderBornTlItem(b, i);
  });

  const hiddenTlHtml = hiddenBirths.map((b, i) => renderBornTlItem(b, i + visibleBirths.length)).join("");

  // Events snippet — left-border accent style
  const eventsSnippetHtml = topEvents
    .map((e) => {
      const w = e.pages?.[0]?.content_urls?.desktop?.page || "";
      return `<div class="d-flex gap-2 align-items-start mb-2 pb-2" style="border-bottom:1px solid var(--cbr)">
  <span class="yr flex-shrink-0 event-years-ago ms-2">${escapeHtml(String(e.year))}</span>
  <div style="font-size:.88rem;line-height:1.45">${escapeHtml(e.text)}${w ? ` <a href="${escapeHtml(w)}" class="small text-muted" target="_blank" rel="noopener noreferrer">Wikipedia &rarr;</a>` : ""}</div>
</div>`;
    })
    .join("");

  return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${escapeHtml(pageTitle)}</title>
<link rel="canonical" href="${escapeHtml(canonical)}"/>
<link rel="prev" href="${escapeHtml(`${siteUrl}/born/${prevMonth}/${prevDay}/`)}"/>
<link rel="next" href="${escapeHtml(`${siteUrl}/born/${nextMonth}/${nextDay}/`)}"/>
<meta name="robots" content="index, follow"/>
<meta name="description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:title" content="${escapeHtml(pageTitle)}"/>
<meta property="og:description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:type" content="article"/>
<meta property="og:url" content="${escapeHtml(canonical)}"/>
<meta property="og:locale" content="en_US"/>
<meta property="og:site_name" content="thisDay."/>
<meta property="og:image" content="${escapeHtml(ogImg)}"/>
<meta name="twitter:card" content="summary_large_image"/>
	<meta name="twitter:title" content="${escapeHtml(pageTitle)}"/>
	<meta name="twitter:description" content="${escapeHtml(pageDesc)}"/>
	<meta name="twitter:image" content="${escapeHtml(ogImg)}"/>
	<meta name="author" content="thisDay.info"/>
	<script type="application/ld+json">${pageSchema}</script>
	<script type="application/ld+json">${faqSchema}</script>
	<script type="application/ld+json">${breadcrumbSchema}</script>
	${personListSchema ? `<script type="application/ld+json">${personListSchema}</script>` : ""}
<link rel="icon" href="/images/favicon.ico" type="image/x-icon"/>
<link rel="apple-touch-icon" sizes="180x180" href="/images/apple-touch-icon.png"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"/>
<link rel="stylesheet" href="/css/style.css"/>
<link rel="stylesheet" href="/css/custom.css"/>
<style>${getSharedPageStyles()}</style>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8565025017387209" crossorigin="anonymous"></script>
</head>
<body>
<div id="read-progress" role="progressbar" aria-label="Reading progress" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"></div>
${siteNav()}
<main class="container my-4" style="max-width:860px">
  <nav aria-label="breadcrumb" class="mb-3">
    <ol class="breadcrumb">
      <li class="breadcrumb-item"><a href="/">Home</a></li>
      <li class="breadcrumb-item"><a href="/events/">On This Day</a></li>
      <li class="breadcrumb-item active" aria-current="page">Born on ${escapeHtml(mDisplay)} ${day}</li>
    </ol>
  </nav>
  <h1 class="mb-2">Famous Birthdays on ${escapeHtml(mDisplay)} ${day}</h1>
  <div class="d-flex flex-wrap gap-2 align-items-center mb-2">
    <span class="auto-tag event-years-ago ms-2"><i class="bi bi-people me-1"></i>${births.length} people</span>
    ${eraRange ? `<span class="auto-tag event-years-ago ms-2"><i class="bi bi-clock-history me-1"></i>${escapeHtml(eraRange)}</span>` : ""}
  </div>
  <p class="text-muted mb-2" style="font-size:15px">${escapeHtml(introLine)}</p>
  <p class="text-muted mb-4" style="font-size:.82rem">By <a href="/about/" rel="author" style="color:inherit">thisDay.info Editorial Team</a> &middot; <time datetime="${MM}-${DD}">${escapeHtml(mDisplay)} ${day}</time> &mdash; <a href="https://www.wikipedia.org" target="_blank" rel="noopener noreferrer">Wikipedia</a></p>
  ${featured || othersB.length > 0 ? `
  <div class="card-box" style="padding:0;overflow:hidden">
    ${featImg ? `<img src="/image-proxy?src=${encodeURIComponent(featImg)}&w=800&q=85" srcset="/image-proxy?src=${encodeURIComponent(featImg)}&w=400 400w, /image-proxy?src=${encodeURIComponent(featImg)}&w=800 800w" sizes="(max-width:640px) 100vw, 800px" alt="${featName}" class="feat-img" loading="eager" style="width:100%;display:block;max-height:380px;object-fit:cover;object-position:top"/>` : ""}
    <div style="padding:20px 24px">
    ${featured ? `
    <h2 style="margin-top:0">${escapeHtml(String(featured.year))} — ${featName}</h2>
    ${featRemainder ? `<p class="mb-3">${escapeHtml(featRemainder)}</p>` : ""}
    ${didYouKnowFacts.length >= 3 ? buildDidYouKnowSlider(didYouKnowFacts) : `<div class="commentary"><i class="bi bi-chat-quote me-1" style="color:#1a1a1a"></i>${commentaryParas.map((p, i, a) => `<p class="${i === a.length - 1 ? "mb-0" : "mb-2"}">${p}</p>`).join("")}</div>`}
    <hr style="border:none;border-top:1px solid var(--cbr);margin:20px 0 16px"/>` : ""}
    ${othersB.length > 0 ? `
    <div class="tl-wrap">${visibleTlHtml}</div>
    ${hiddenTlHtml ? `<div id="births-more" style="display:none"><div class="tl-wrap">${hiddenTlHtml}</div></div>
    <button onclick="var m=document.getElementById('births-more');m.style.display=m.style.display==='none'?'block':'none';this.innerHTML=m.style.display==='none'?'<i class=\\'bi bi-chevron-down me-1\\'></i>Show all ${othersB.length} birthdays':'<i class=\\'bi bi-chevron-up me-1\\'></i>Show less';" class="site-btn w-100 mt-3" style="justify-content:center"><i class="bi bi-chevron-down me-1"></i>Show all ${othersB.length} birthdays</button>` : ""}` : ""}
    </div>
  </div>` : `<div class="alert alert-info">No birthday data found for ${escapeHtml(mDisplay)} ${day}.</div>`}
  <div class="ad-unit">
    <div class="ad-unit-label">Advertisement</div>
    <ins class="adsbygoogle" style="display:block;border-radius:8px;overflow:hidden"
         data-ad-client="ca-pub-8565025017387209" data-ad-slot="9477779891"
         data-ad-format="auto" data-full-width-responsive="true"></ins>
  </div>
  ${relatedBlogHtml}
  ${buildBornAnswerBlock({ mDisplay, day, featured, births, eraRange })}
  ${buildDateClusterCard(monthName, day, mDisplay, "born")}
  ${topEvents.length > 0 ? `
  <div class="card-box">
    <h2 class="h4 mb-3"><i class="bi bi-calendar-event me-2" style="color:#1a1a1a"></i>Also on ${escapeHtml(mDisplay)} ${day} in History</h2>
    ${eventsSnippetHtml}
    <a href="/events/${monthName}/${day}/" class="site-btn w-100 mt-3" style="justify-content:center"><i class="bi bi-arrow-right"></i>See all events on ${escapeHtml(mDisplay)} ${day}</a>
  </div>` : ""}
  <div class="ad-unit-container my-4">
    <span class="ad-unit-label">Advertisement</span>
    <ins class="adsbygoogle" style="display:block" data-ad-format="autorelaxed"
         data-ad-client="ca-pub-8565025017387209" data-ad-slot="9183511632"></ins>
  </div>
  <div class="my-5 pt-3 border-top">
    <div class="d-flex justify-content-between align-items-center mb-4">
      <a href="/born/${prevMonth}/${prevDay}/" class="site-btn"><i class="bi bi-arrow-left"></i>${escapeHtml(prevMDisplay)} ${prevDay}</a>
      <a href="/born/${nextMonth}/${nextDay}/" class="site-btn">${escapeHtml(nextMDisplay)} ${nextDay}<i class="bi bi-arrow-right"></i></a>
    </div>
    <div class="text-center">
      <p class="text-muted mb-3">Explore famous birthdays on the interactive calendar.</p>
      <a href="/" class="site-btn site-btn-primary w-100 mt-3"><i class="bi bi-calendar3"></i>Open the Calendar</a>
      <a href="/blog/" class="site-btn w-100 mt-3"><i class="bi bi-journal-text"></i>All Blog Posts</a>
    </div>
  </div>
</main>
${siteFooter("yr")}
${getSharedPageScripts({ pageType: "born-date", pageSlug: `${monthName}-${day}` })}
</body></html>`;
}

function generateDiedHTML(siteUrl, monthName, day, eventsData, relatedBlogEntry = null) {
  const mNum = MONTH_NUM_MAP[monthName] || 1;
  const mDisplay = MONTH_DISPLAY_NAMES[mNum];
  const MM = String(mNum).padStart(2, "0");
  const DD = String(day).padStart(2, "0");
  const canonical = `${siteUrl}/died/${monthName}/${day}/`;

  const deaths = (eventsData?.deaths || []).slice().sort((a, b) => a.year - b.year);
  // Prefer a featured person whose extract produces DYK cards; use wikiRichScore as tiebreaker.
  const countDykD = (d) => {
    const extract = d?.pages?.[0]?.extract || "";
    return extract.split(/\.\s+/).filter((s) => {
      s = s.replace(/\s+/g, " ").trim();
      if (s.length < 50 || s.length > 220) return false;
      if (/^(He|She|It|This|They|The [a-z])/.test(s) && !/\d/.test(s)) return false;
      return true;
    }).length;
  };
  const hasImgD = (p) => !!(p?.pages?.[0]?.thumbnail?.source || p?.pages?.[0]?.originalimage?.source);
  const diedScore = (d) => countDykD(d) * 10 + wikiRichScore(d);
  const deathsWithImg = deaths.filter(hasImgD);
  const featuredPoolD = deathsWithImg.length ? deathsWithImg : deaths;
  const featured = featuredPoolD.length
    ? featuredPoolD.reduce((best, d) => diedScore(d) >= diedScore(best) ? d : best, featuredPoolD[0])
    : null;
  const othersD = deaths.filter((d) => d !== featured);
  const featName = featured ? escapeHtml(featured.text.split(",")[0]) : "";
  const featImg = featured?.pages?.[0]?.originalimage?.source || featured?.pages?.[0]?.thumbnail?.source || null;
  const featRemainder = featured ? featured.text.substring(featured.text.indexOf(",") + 1).trim() : "";
  const commentaryParas = featured ? workerCommentary(featured.year, featured.text) : [];
  const didYouKnowFacts = (() => {
    const scoreS = (s) =>
      (/\d/.test(s) ? 2 : 0) +
      (/\b(first|only|never|most|oldest|youngest|record|won|invented|discovered|became)\b/i.test(s) ? 3 : 0) +
      (/[A-Z][a-z]/.test(s.slice(5)) ? 1 : 0);
    return (featured?.pages?.[0]?.extract || "")
      .split(/\.\s+/)
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((s) => {
        if (s.length < 50 || s.length > 220) return false;
        if (/^(He|She|It|This|They|The [a-z])/.test(s) && !/\d/.test(s)) return false;
        return true;
      })
      .sort((a, b) => scoreS(b) - scoreS(a))
      .slice(0, 5);
  })();
  const ogImg = featImg || `${siteUrl}/images/logo.png`;
  const pageTitle = featured
    ? `${featName} & Others Who Died on ${mDisplay} ${day} | thisDay.info`
    : `Notable Deaths on ${mDisplay} ${day} | thisDay.info`;
  const pageDesc =
    `Discover notable people who died on ${mDisplay} ${day} throughout history. ${deaths.length} recorded deaths including ${deaths
      .slice(0, 3)
      .map((d) => d.text.split(",")[0])
      .join(", ")}.`.substring(0, 155);

  const mIdx = mNum - 1;
  const prevDay = day > 1 ? day - 1 : DAYS_IN_MONTH[(mIdx - 1 + 12) % 12];
  const prevMIdx = day > 1 ? mIdx : (mIdx - 1 + 12) % 12;
  const prevMonth = MONTHS_ALL[prevMIdx];
  const prevMDisplay = MONTH_DISPLAY_NAMES[prevMIdx + 1];
  const nextDay = day < DAYS_IN_MONTH[mIdx] ? day + 1 : 1;
  const nextMIdx = day < DAYS_IN_MONTH[mIdx] ? mIdx : (mIdx + 1) % 12;
  const nextMonth = MONTHS_ALL[nextMIdx];
  const nextMDisplay = MONTH_DISPLAY_NAMES[nextMIdx + 1];

  // Era range for stat bar
  const rawYears = deaths
    .map((d) => parseInt(d.year) || null)
    .filter((y) => y !== null);
  const minYear = rawYears.length ? Math.min(...rawYears) : null;
  const maxYear = rawYears.length ? Math.max(...rawYears) : null;
  const fmtYear = (y) => (y < 0 ? `${Math.abs(y)} BC` : String(y));
  const eraRange =
    minYear !== null && maxYear !== null && minYear !== maxYear
      ? `${fmtYear(minYear)} – ${fmtYear(maxYear)}`
      : minYear !== null
        ? fmtYear(minYear)
        : "";

  // Intro paragraph — original content for SEO depth
  const introLine =
    deaths.length > 0
      ? `${mDisplay} ${day} has seen ${deaths.length} notable figures pass away throughout recorded history${eraRange ? ` — from ${eraRange}` : ""}. Below are the most significant names who died on this date.`
      : `Explore notable people who died on ${mDisplay} ${day} throughout history.`;

  const topEvents = (eventsData?.events || []).slice(0, 3);

  // Schema — FAQPage
  const faqSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: `Who died on ${mDisplay} ${day}?`,
        acceptedAnswer: {
          "@type": "Answer",
          text:
            deaths.length > 0
              ? `Notable people who died on ${mDisplay} ${day} include: ${deaths
                  .slice(0, 5)
                  .map((d) => d.text.split(",")[0])
                  .join(", ")}.`
              : `Explore notable deaths on ${mDisplay} ${day} at thisDay.info.`,
        },
      },
      ...(featured
        ? [
            {
              "@type": "Question",
              name: `What is ${featName} known for?`,
              acceptedAnswer: {
                "@type": "Answer",
                text: escapeHtml(featured.text),
              },
            },
          ]
        : []),
    ],
  });

  // Schema — ItemList with jobTitle
  const personListSchema =
    deaths.length > 0
      ? JSON.stringify({
          "@context": "https://schema.org",
          "@id": `${canonical}#deaths`,
          "@type": "ItemList",
          name: `Notable Deaths on ${mDisplay} ${day}`,
          url: canonical,
          numberOfItems: deaths.length,
          itemListElement: deaths.slice(0, 20).map((d, i) => {
            const jobTitle = d.text.includes(",")
              ? d.text.slice(d.text.indexOf(",") + 1).trim()
              : "";
            return {
              "@type": "ListItem",
              position: i + 1,
              item: {
                "@type": "Person",
                name: d.text.split(",")[0],
                deathDate: `${d.year}-${MM}-${DD}`,
                description: d.text,
                ...(jobTitle ? { jobTitle } : {}),
                ...(d.pages?.[0]?.content_urls?.desktop?.page
                  ? { sameAs: d.pages[0].content_urls.desktop.page }
                  : {}),
              },
            };
          }),
        })
      : null;

  const pageSchema = buildPageSchema({
    type: "CollectionPage",
    name: pageTitle.replace(" | thisDay.info", ""),
    description: pageDesc,
    url: canonical,
    mainEntityId: deaths.length > 0 ? `${canonical}#deaths` : null,
    about: { "@type": "Thing", name: `Deaths on ${mDisplay} ${day}` },
    mentions: buildPersonMentions(deaths, "deathDate"),
  });

  const breadcrumbSchema = buildBreadcrumbSchema([
    { name: "Home", item: `${siteUrl}/` },
    { name: "On This Day", item: `${siteUrl}/events/` },
    { name: `Died on ${mDisplay} ${day}`, item: canonical },
  ]);
  const relatedBlogHtml = buildRelatedBlogCard(
    relatedBlogEntry,
    `${mDisplay} ${day} in the Blog`,
  );

  // Timeline item renderer for died page
  const renderDiedTlItem = (d, idx) => {
    const th = d.pages?.[0]?.thumbnail?.source || "";
    const w = d.pages?.[0]?.content_urls?.desktop?.page || "";
    const name = escapeHtml(d.text.split(",")[0]);
    const desc = d.text.includes(",")
      ? escapeHtml(d.text.slice(d.text.indexOf(",") + 1).trim())
      : "";
    const rawExtract = d.pages?.[0]?.extract || "";
    const extract = rawExtract
      ? escapeHtml(rawExtract.length > 220 ? rawExtract.slice(0, 220).replace(/\s\S*$/, "") + "…" : rawExtract)
      : "";
    const year = escapeHtml(String(d.year));
    const isEven = idx % 2 === 1;
    const imgHtml = th
      ? w
        ? `<a href="${escapeHtml(w)}" target="_blank" rel="noopener noreferrer" tabindex="-1"><img src="${escapeHtml(th)}" alt="${name}" class="tl-card-img" loading="lazy" onerror="this.closest('a').outerHTML='<div class=\\'tl-card-img-blank\\'><i class=\\'bi bi-person\\'></i></div>'"></a>`
        : `<img src="${escapeHtml(th)}" alt="${name}" class="tl-card-img" loading="lazy" onerror="this.outerHTML='<div class=\\'tl-card-img-blank\\'><i class=\\'bi bi-person\\'></i></div>'">`
      : `<div class="tl-card-img-blank"><i class="bi bi-person"></i></div>`;
    const card = `<div class="tl-card">
  ${imgHtml}
  <div class="tl-card-body">
    <div class="tl-card-title">${name}</div>
    ${desc ? `<div class="tl-card-desc">${desc}</div>` : ""}
    ${extract ? `<div class="tl-card-extract">${extract}</div>` : ""}
    ${w ? `<a href="${escapeHtml(w)}" target="_blank" rel="noopener noreferrer" class="site-btn site-btn-primary tl-btn">Read More</a>` : ""}
  </div>
</div>`;
    const media = `<div class="tl-media"></div>`;
    const node = `<div class="tl-node"><span class="tl-node-badge event-years-ago" style="background:#6c757d">${year}</span></div>`;
    return `<div class="tl-item ${isEven ? "tl-item-even" : "tl-item-odd"}">
  <div class="tl-body">${card}</div>${node}${media}
</div>`;
  };

  const visibleDeaths = othersD.slice(0, 20);
  const hiddenDeaths = othersD.slice(20);

  let visibleDiedTlHtml = "";
  visibleDeaths.forEach((d, i) => {
    visibleDiedTlHtml += renderDiedTlItem(d, i);
  });

  const hiddenDiedTlHtml = hiddenDeaths.map((d, i) => renderDiedTlItem(d, i + visibleDeaths.length)).join("");

  // Events snippet — consistent style with born page
  const eventsSnippetHtml = topEvents
    .map((e) => {
      const w = e.pages?.[0]?.content_urls?.desktop?.page || "";
      return `<div class="d-flex gap-2 align-items-start mb-2 pb-2" style="border-bottom:1px solid var(--cbr)">
  <span class="yr flex-shrink-0 event-years-ago ms-2">${escapeHtml(String(e.year))}</span>
  <div style="font-size:.88rem;line-height:1.45">${escapeHtml(e.text)}${w ? ` <a href="${escapeHtml(w)}" class="small text-muted" target="_blank" rel="noopener noreferrer">Wikipedia &rarr;</a>` : ""}</div>
</div>`;
    })
    .join("");

  return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${escapeHtml(pageTitle)}</title>
<link rel="canonical" href="${escapeHtml(canonical)}"/>
<link rel="prev" href="${escapeHtml(`${siteUrl}/died/${prevMonth}/${prevDay}/`)}"/>
<link rel="next" href="${escapeHtml(`${siteUrl}/died/${nextMonth}/${nextDay}/`)}"/>
<meta name="robots" content="index, follow"/>
<meta name="description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:title" content="${escapeHtml(pageTitle)}"/>
<meta property="og:description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:type" content="article"/>
<meta property="og:url" content="${escapeHtml(canonical)}"/>
<meta property="og:locale" content="en_US"/>
<meta property="og:site_name" content="thisDay."/>
<meta property="og:image" content="${escapeHtml(ogImg)}"/>
<meta name="twitter:card" content="summary_large_image"/>
	<meta name="twitter:title" content="${escapeHtml(pageTitle)}"/>
	<meta name="twitter:description" content="${escapeHtml(pageDesc)}"/>
	<meta name="twitter:image" content="${escapeHtml(ogImg)}"/>
	<meta name="author" content="thisDay.info"/>
	<script type="application/ld+json">${pageSchema}</script>
	<script type="application/ld+json">${faqSchema}</script>
	<script type="application/ld+json">${breadcrumbSchema}</script>
	${personListSchema ? `<script type="application/ld+json">${personListSchema}</script>` : ""}
<link rel="icon" href="/images/favicon.ico" type="image/x-icon"/>
<link rel="apple-touch-icon" sizes="180x180" href="/images/apple-touch-icon.png"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"/>
<link rel="stylesheet" href="/css/style.css"/>
<link rel="stylesheet" href="/css/custom.css"/>
<style>${getSharedPageStyles()}</style>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8565025017387209" crossorigin="anonymous"></script>
</head>
<body>
<div id="read-progress" role="progressbar" aria-label="Reading progress" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"></div>
${siteNav()}
<main class="container my-4" style="max-width:860px">
  <nav aria-label="breadcrumb" class="mb-3">
    <ol class="breadcrumb">
      <li class="breadcrumb-item"><a href="/">Home</a></li>
      <li class="breadcrumb-item"><a href="/events/">On This Day</a></li>
      <li class="breadcrumb-item active" aria-current="page">Died on ${escapeHtml(mDisplay)} ${day}</li>
    </ol>
  </nav>
  <h1 class="mb-2">Notable Deaths on ${escapeHtml(mDisplay)} ${day}</h1>
  <div class="d-flex flex-wrap gap-2 align-items-center mb-2">
    <span class="auto-tag event-years-ago ms-2"><i class="bi bi-people me-1"></i>${deaths.length} people</span>
    ${eraRange ? `<span class="auto-tag event-years-ago ms-2"><i class="bi bi-clock-history me-1"></i>${escapeHtml(eraRange)}</span>` : ""}
  </div>
  <p class="text-muted mb-2" style="font-size:15px">${escapeHtml(introLine)}</p>
  <p class="text-muted mb-4" style="font-size:.82rem">By <a href="/about/" rel="author" style="color:inherit">thisDay.info Editorial Team</a> &middot; <time datetime="${MM}-${DD}">${escapeHtml(mDisplay)} ${day}</time> &mdash; <a href="https://www.wikipedia.org" target="_blank" rel="noopener noreferrer">Wikipedia</a></p>
  ${featured || othersD.length > 0 ? `
  <div class="card-box" style="padding:0;overflow:hidden">
    ${featImg ? `<img src="/image-proxy?src=${encodeURIComponent(featImg)}&w=800&q=85" srcset="/image-proxy?src=${encodeURIComponent(featImg)}&w=400 400w, /image-proxy?src=${encodeURIComponent(featImg)}&w=800 800w" sizes="(max-width:640px) 100vw, 800px" alt="${featName}" class="feat-img" loading="eager" style="width:100%;display:block;max-height:380px;object-fit:cover;object-position:top"/>` : ""}
    <div style="padding:20px 24px">
    ${featured ? `
    <h2 style="margin-top:0">${escapeHtml(String(featured.year))} — ${featName}</h2>
    ${featRemainder ? `<p class="mb-3">${escapeHtml(featRemainder)}</p>` : ""}
    ${didYouKnowFacts.length >= 3 ? buildDidYouKnowSlider(didYouKnowFacts) : `<div class="commentary"><i class="bi bi-chat-quote me-1" style="color:#1a1a1a"></i>${commentaryParas.map((p, i, a) => `<p class="${i === a.length - 1 ? "mb-0" : "mb-2"}">${p}</p>`).join("")}</div>`}
    <hr style="border:none;border-top:1px solid var(--cbr);margin:20px 0 16px"/>` : ""}
    ${othersD.length > 0 ? `
    <div class="tl-wrap">${visibleDiedTlHtml}</div>
    ${hiddenDiedTlHtml ? `<div id="deaths-more" style="display:none"><div class="tl-wrap">${hiddenDiedTlHtml}</div></div>
    <button onclick="var m=document.getElementById('deaths-more');m.style.display=m.style.display==='none'?'block':'none';this.innerHTML=m.style.display==='none'?'<i class=\\'bi bi-chevron-down me-1\\'></i>Show all ${othersD.length} deaths':'<i class=\\'bi bi-chevron-up me-1\\'></i>Show less';" class="site-btn w-100 mt-3" style="justify-content:center"><i class="bi bi-chevron-down me-1"></i>Show all ${othersD.length} deaths</button>` : ""}` : ""}
    </div>
  </div>` : `<div class="alert alert-info">No death records found for ${escapeHtml(mDisplay)} ${day}.</div>`}
  <div class="ad-unit">
    <div class="ad-unit-label">Advertisement</div>
    <ins class="adsbygoogle" style="display:block;border-radius:8px;overflow:hidden"
         data-ad-client="ca-pub-8565025017387209" data-ad-slot="9477779891"
         data-ad-format="auto" data-full-width-responsive="true"></ins>
  </div>
  ${relatedBlogHtml}
  ${buildDiedAnswerBlock({ mDisplay, day, featured, deaths, eraRange })}
  ${buildDateClusterCard(monthName, day, mDisplay, "died")}
  ${topEvents.length > 0 ? `
  <div class="card-box">
    <h2 class="h4 mb-3"><i class="bi bi-calendar-event me-2" style="color:#1a1a1a"></i>Also on ${escapeHtml(mDisplay)} ${day} in History</h2>
    ${eventsSnippetHtml}
    <a href="/events/${monthName}/${day}/" class="site-btn w-100 mt-3" style="justify-content:center"><i class="bi bi-arrow-right"></i>See all events on ${escapeHtml(mDisplay)} ${day}</a>
  </div>` : ""}
  <div class="ad-unit-container my-4">
    <span class="ad-unit-label">Advertisement</span>
    <ins class="adsbygoogle" style="display:block" data-ad-format="autorelaxed"
         data-ad-client="ca-pub-8565025017387209" data-ad-slot="9183511632"></ins>
  </div>
  <div class="my-5 pt-3 border-top">
    <div class="d-flex justify-content-between align-items-center mb-4">
      <a href="/died/${prevMonth}/${prevDay}/" class="site-btn"><i class="bi bi-arrow-left"></i>${escapeHtml(prevMDisplay)} ${prevDay}</a>
      <a href="/died/${nextMonth}/${nextDay}/" class="site-btn">${escapeHtml(nextMDisplay)} ${nextDay}<i class="bi bi-arrow-right"></i></a>
    </div>
    <div class="text-center">
      <p class="text-muted mb-3">Explore notable deaths on the interactive calendar.</p>
      <a href="/" class="site-btn site-btn-primary w-100 mt-3"><i class="bi bi-calendar3"></i>Open the Calendar</a>
      <a href="/blog/" class="site-btn w-100 mt-3"><i class="bi bi-journal-text"></i>All Blog Posts</a>
    </div>
  </div>
</main>
${siteFooter("yr")}
${getSharedPageScripts({ pageType: "died-date", pageSlug: `${monthName}-${day}` })}
</body></html>`;
}

async function handleBlogIndex(env, url) {
  const index = env.BLOG_AI_KV
    ? await env.BLOG_AI_KV.get("index", { type: "json" }).catch(() => null)
    : null;
  const posts = Array.isArray(index) ? index.slice(0, 3) : [];
  const latestPost = posts[0] || null;
  const latestPostIso =
    latestPost?.publishedAt &&
    !Number.isNaN(new Date(latestPost.publishedAt).getTime())
      ? new Date(latestPost.publishedAt).toISOString()
      : null;
  const latestPostLabel = latestPostIso
    ? new Date(latestPostIso).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;
  const canonical = `${url.origin}/blog/`;
  const collectionSchema = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Blog | thisDay.",
    url: canonical,
    description:
      "Latest historical articles from thisDay.info, covering major events, people, and turning points tied to specific calendar dates.",
    isPartOf: {
      "@type": "WebSite",
      name: "thisDay.info",
      url: `${url.origin}/`,
    },
    about: { "@type": "Thing", name: "History" },
    ...(latestPostIso && { dateModified: latestPostIso }),
    mainEntity: {
      "@type": "ItemList",
      itemListOrder: "https://schema.org/ItemListOrderDescending",
      numberOfItems: posts.length,
      itemListElement: posts.map((post, idx) => ({
        "@type": "ListItem",
        position: idx + 1,
        url: `${url.origin}/blog/${post.slug}/`,
        name: post.title || post.slug,
      })),
    },
  };
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: `${url.origin}/`,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Blog",
        item: `${url.origin}/blog/`,
      },
    ],
  };

  const postsHtml =
    posts.length > 0
      ? posts
          .map((post) => {
            const slug = escapeHtml(post.slug || "");
            const title = escapeHtml(post.title || slug);
            const img = post.imageUrl ? escapeHtml(post.imageUrl) : "";
            const desc = escapeHtml(post.description || "");
            const rawDate = post.publishedAt || "";
            const dateStr = rawDate
              ? escapeHtml(
                  new Date(rawDate).toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  }),
                )
              : "";
            return (
              `<div class="card-box mb-4"><div class="row g-0 align-items-center">` +
              (img
                ? `<div class="col-4 col-md-3"><a href="/blog/${slug}/"><img src="${img}" alt="${title}" style="width:100%;height:120px;object-fit:cover;object-position:top;border-radius:8px" loading="lazy"></a></div>`
                : "") +
              `<div class="${img ? "col-8 col-md-9 ps-3" : "col-12"}">` +
              `<h2 class="h5 mb-1"><a href="/blog/${slug}/" style="color:inherit;text-decoration:none">${title}</a></h2>` +
              (dateStr
                ? `<div class="text-muted mb-2" style="font-size:.8rem">${dateStr}</div>`
                : "") +
              (desc
                ? `<p class="mb-2" style="font-size:15px">${desc}</p>`
                : "") +
              `<a href="/blog/${slug}/" class="site-btn" style="padding:6px 12px;font-size:.8rem"><i class="bi bi-arrow-right me-1"></i>Read More</a>` +
              `</div></div></div>`
            );
          })
          .join("")
      : `<div class="card-box text-center py-5"><p class="text-muted mb-0">No posts available yet.</p></div>`;

  const pageTitle = "Blog | thisDay.";
  const pageDesc = latestPostLabel
    ? `Latest historical articles from thisDay.info. Most recent update: ${latestPostLabel}.`
    : "Latest historical articles from thisDay.info.";

  const html = `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${pageTitle}</title>
<link rel="canonical" href="${escapeHtml(canonical)}"/>
<meta name="robots" content="index, follow"/>
<meta name="description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:title" content="${escapeHtml(pageTitle)}"/>
<meta property="og:description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="${escapeHtml(canonical)}"/>
<meta property="og:site_name" content="thisDay."/>
<meta property="og:image" content="${escapeHtml(`${url.origin}/images/logo.png`)}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${escapeHtml(pageTitle)}"/>
<meta name="twitter:description" content="${escapeHtml(pageDesc)}"/>
<meta name="twitter:image" content="${escapeHtml(`${url.origin}/images/logo.png`)}"/>
<script type="application/ld+json">${JSON.stringify(collectionSchema)}</script>
<script type="application/ld+json">${JSON.stringify(breadcrumbSchema)}</script>
<link rel="icon" href="/images/favicon.ico" type="image/x-icon"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"/>
<link rel="stylesheet" href="/css/style.css"/>
<link rel="stylesheet" href="/css/custom.css"/>
<style>${getSharedPageStyles()}</style>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8565025017387209" crossorigin="anonymous"></script>
</head>
<body>
${siteNav()}
<main class="container my-4" style="max-width:860px">
  <nav aria-label="breadcrumb" class="mb-3">
    <ol class="breadcrumb">
      <li class="breadcrumb-item"><a href="/">Home</a></li>
      <li class="breadcrumb-item active" aria-current="page">Blog</li>
    </ol>
  </nav>
  <h1 class="mb-4">Latest Posts</h1>
  ${
    latestPostLabel
      ? `<p class="text-muted mb-4" style="font-size:15px">Latest article published on <time datetime="${escapeHtml(latestPostIso)}">${escapeHtml(latestPostLabel)}</time>.</p>`
      : ""
  }
  ${postsHtml}
  <div class="ad-unit my-4">
    <div class="ad-unit-label">Advertisement</div>
    <ins class="adsbygoogle" style="display:block;border-radius:8px;overflow:hidden"
         data-ad-client="ca-pub-8565025017387209" data-ad-slot="9477779891"
         data-ad-format="auto" data-full-width-responsive="true"></ins>
  </div>
  <div class="ad-unit-container my-4">
    <span class="ad-unit-label">Advertisement</span>
    <ins class="adsbygoogle" style="display:block" data-ad-format="autorelaxed"
         data-ad-client="ca-pub-8565025017387209" data-ad-slot="9183511632"></ins>
  </div>
</main>
${siteFooter("yr")}
${getSharedPageScripts({ pageType: "blog-index", pageSlug: "blog" })}
</body></html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=600",
    },
  });
}

async function handleBornPage(request, env, ctx, url) {
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length !== 3) return new Response("Not Found", { status: 404 });
  const monthName = parts[1].toLowerCase();
  const day = parseInt(parts[2], 10);
  const monthNum = MONTH_NUM_MAP[monthName];
  const maxDay = monthNum ? DAYS_IN_MONTH[monthNum - 1] : 0;
  if (!monthNum || isNaN(day) || day < 1 || day > maxDay)
    return new Response("Not Found", { status: 404 });

  const hostKey = (url.host || "").toLowerCase().replace(/[^a-z0-9.-]/g, "");
  const kvKey = `born-v19-${hostKey}-${monthName}-${day}`;
  const bypassCache =
    url.searchParams.get("fresh") === "1" ||
    url.searchParams.get("nocache") === "1";
  try {
    if (env.EVENTS_KV && !bypassCache) {
      const cached = await env.EVENTS_KV.get(kvKey);
      if (cached) {
        const patched = cached.includes('ai-card-patch-v1') ? cached : cached.replace('</head>', '<style>/*ai-card-patch-v1*/.ai-answer-card{background:#f5f5f5!important;background-image:none!important}.ai-answer-kicker{display:none!important}.ai-answer-card h2{display:none!important}.site-btn.w-100{justify-content:center!important}</style></head>');
        return new Response(patched, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=3600, s-maxage=604800",
            "X-Cache": "HIT",
          },
        });
      }
    }
  } catch (e) {
    console.error("KV read born:", e);
  }

  const mPad = String(monthNum).padStart(2, "0");
  const dPad = String(day).padStart(2, "0");
  let eventsData = { events: [], births: [], deaths: [] };
  if (env.EVENTS_KV) {
    try {
      const kv = await env.EVENTS_KV.get(`events-data:${mPad}-${dPad}`, {
        type: "json",
      });
      if (kv?.births?.length) eventsData = kv;
    } catch (_) {}
  }
  if (!eventsData.births.length) {
    try {
      const r = await fetch(
        `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/all/${mPad}/${dPad}`,
        { headers: { "User-Agent": WIKIPEDIA_USER_AGENT } },
      );
      if (r.ok) {
        eventsData = await r.json();
        if (env.EVENTS_KV && eventsData?.events?.length)
          ctx.waitUntil(
            env.EVENTS_KV.put(
              `events-data:${mPad}-${dPad}`,
              JSON.stringify(eventsData),
              { expirationTtl: 7 * 24 * 60 * 60 },
            ).catch(() => {}),
          );
      }
    } catch (e) {
      console.error("Wikipedia API born:", e);
    }
  }

  const relatedBlogEntry = await findMatchingDateBlogEntry(env, monthName, day);
  const html = generateBornHTML(
    "https://thisday.info",
    monthName,
    day,
    eventsData,
    relatedBlogEntry,
  );
  if (env.EVENTS_KV && eventsData?.births?.length)
    ctx.waitUntil(
      env.EVENTS_KV.put(kvKey, html, { expirationTtl: 7 * 24 * 60 * 60 }).catch(
        () => {},
      ),
    );

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": bypassCache
        ? "no-store, no-cache"
        : "public, max-age=3600, s-maxage=604800",
      "X-Cache": bypassCache ? "BYPASS" : "MISS",
    },
  });
}

async function handleDiedPage(request, env, ctx, url) {
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length !== 3) return new Response("Not Found", { status: 404 });
  const monthName = parts[1].toLowerCase();
  const day = parseInt(parts[2], 10);
  const monthNum = MONTH_NUM_MAP[monthName];
  const maxDay = monthNum ? DAYS_IN_MONTH[monthNum - 1] : 0;
  if (!monthNum || isNaN(day) || day < 1 || day > maxDay)
    return new Response("Not Found", { status: 404 });

  const hostKey = (url.host || "").toLowerCase().replace(/[^a-z0-9.-]/g, "");
  const kvKey = `died-v18-${hostKey}-${monthName}-${day}`;
  const bypassCache =
    url.searchParams.get("fresh") === "1" ||
    url.searchParams.get("nocache") === "1";
  try {
    if (env.EVENTS_KV && !bypassCache) {
      const cached = await env.EVENTS_KV.get(kvKey);
      if (cached) {
        const patched = cached.includes('ai-card-patch-v1') ? cached : cached.replace('</head>', '<style>/*ai-card-patch-v1*/.ai-answer-card{background:#f5f5f5!important;background-image:none!important}.ai-answer-kicker{display:none!important}.ai-answer-card h2{display:none!important}.site-btn.w-100{justify-content:center!important}</style></head>');
        return new Response(patched, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=3600, s-maxage=604800",
            "X-Cache": "HIT",
          },
        });
      }
    }
  } catch (e) {
    console.error("KV read died:", e);
  }

  const mPad = String(monthNum).padStart(2, "0");
  const dPad = String(day).padStart(2, "0");
  let eventsData = { events: [], births: [], deaths: [] };
  if (env.EVENTS_KV) {
    try {
      const kv = await env.EVENTS_KV.get(`events-data:${mPad}-${dPad}`, {
        type: "json",
      });
      if (kv?.deaths?.length) eventsData = kv;
    } catch (_) {}
  }
  if (!eventsData.deaths.length) {
    try {
      const r = await fetch(
        `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/all/${mPad}/${dPad}`,
        { headers: { "User-Agent": WIKIPEDIA_USER_AGENT } },
      );
      if (r.ok) {
        eventsData = await r.json();
        if (env.EVENTS_KV && eventsData?.events?.length)
          ctx.waitUntil(
            env.EVENTS_KV.put(
              `events-data:${mPad}-${dPad}`,
              JSON.stringify(eventsData),
              { expirationTtl: 7 * 24 * 60 * 60 },
            ).catch(() => {}),
          );
      }
    } catch (e) {
      console.error("Wikipedia API died:", e);
    }
  }

  const relatedBlogEntry = await findMatchingDateBlogEntry(env, monthName, day);
  const html = generateDiedHTML(
    "https://thisday.info",
    monthName,
    day,
    eventsData,
    relatedBlogEntry,
  );
  if (env.EVENTS_KV && eventsData?.deaths?.length)
    ctx.waitUntil(
      env.EVENTS_KV.put(kvKey, html, { expirationTtl: 7 * 24 * 60 * 60 }).catch(
        () => {},
      ),
    );

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": bypassCache
        ? "no-store, no-cache"
        : "public, max-age=3600, s-maxage=604800",
      "X-Cache": bypassCache ? "BYPASS" : "MISS",
    },
  });
}

function normalizeDidYouKnowFact(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-•]\s*/, "")
    .replace(/^did you know that\s*/i, "")
    .replace(/^did you know[,:]?\s*/i, "")
    .replace(/^[^.]{2,120}\s+is directly connected to this event\.\s*/i, "")
    .replace(/\.{2,}/g, ".")
    .trim();
}

function pickRelevantWikiTitle(featuredEvent) {
  const pages = featuredEvent?.pages || [];
  if (!pages.length) return "";
  if (pages.length === 1) return pages[0]?.title || "";

  const text = String(featuredEvent?.text || "").toLowerCase();
  const stop = new Set([
    "the",
    "and",
    "with",
    "from",
    "into",
    "that",
    "this",
    "after",
    "before",
    "during",
    "were",
    "was",
    "have",
    "has",
    "had",
    "president",
    "states",
    "state",
  ]);

  const tokens = Array.from(
    new Set(
      text
        .split(/[^a-z0-9]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 5 && !stop.has(t)),
    ),
  );

  const genericTitles = new Set([
    "united states",
    "europe",
    "president of the united states",
  ]);

  let best = pages[0]?.title || "";
  let bestScore = -1;

  for (const p of pages) {
    const title = String(p?.title || "");
    const lower = title.toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      if (lower.includes(tok)) score += 2;
    }
    if (/covid|pandemic|emergency|declaration|national/i.test(lower))
      score += 4;
    if (genericTitles.has(lower)) score -= 3;
    if (title.length > 18) score += 0.5;

    if (score > bestScore) {
      bestScore = score;
      best = title;
    }
  }

  return best;
}

async function fetchWikipediaSummaryByTitle(title) {
  if (!title) return "";
  try {
    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const r = await fetch(summaryUrl, {
      headers: { "User-Agent": WIKIPEDIA_USER_AGENT },
    });
    if (!r.ok) return "";
    const data = await r.json();
    return String(data?.extract || "")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function buildTopicFallbackFacts(
  featuredEvent,
  wikiSummary = "",
  wikiTitle = "",
) {
  const year = featuredEvent?.year ? String(featuredEvent.year) : "";
  const eventText = String(featuredEvent?.text || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "");
  const summarySentences = String(wikiSummary || "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40)
    .filter(
      (s) =>
        !/\bis a country\b|\bsovereign state\b|\bprimarily located\b/i.test(s),
    )
    .slice(0, 5);

  const facts = [];

  if (eventText) {
    facts.push(
      `In ${year}, ${eventText}. This featured entry focuses on the immediate decision and its direct historical impact.`,
    );
  }

  const closers = [
    "This helps explain why the event mattered beyond the initial announcement.",
    "This clarifies the institutional and public response around the event.",
    "This shows how the event shaped policy and public communication in the same period.",
  ];

  let cIdx = 0;
  for (const sentence of summarySentences) {
    facts.push(`${sentence} ${closers[cIdx % closers.length]}`);
    cIdx += 1;
    if (facts.length >= 5) break;
  }

  while (facts.length < 5) {
    facts.push(
      `${year ? `In ${year}, ` : ""}${eventText || "this historical event"} had consequences that extended beyond the first headline. The key context is the institutions involved, the policy shift, and how the public response evolved afterward.`,
    );
  }

  return facts.map(normalizeDidYouKnowFact).slice(0, 5);
}

async function handleEventsDatePage(_request, env, ctx, url) {
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  // Expect: ['events', 'july', '20']
  if (parts.length !== 3) return new Response("Not Found", { status: 404 });
  const monthName = parts[1].toLowerCase();
  const day = parseInt(parts[2], 10);
  const monthNum = MONTH_NUM_MAP[monthName];
  const maxDay = monthNum ? DAYS_IN_MONTH[monthNum - 1] : 0;
  if (!monthNum || isNaN(day) || day < 1 || day > maxDay) {
    return new Response("Not Found", { status: 404 });
  }

  // Try KV cache (7-day TTL)
  const hostKey = (url.host || "").toLowerCase().replace(/[^a-z0-9.-]/g, "");
  const kvKey = `gen-post-v38-${hostKey}-${monthName}-${day}`;
  const bypassCache =
    url.searchParams.get("fresh") === "1" ||
    url.searchParams.get("nocache") === "1";
  try {
    if (env.EVENTS_KV && !bypassCache) {
      const cached = await env.EVENTS_KV.get(kvKey);
      if (cached) {
        const patched = cached.includes('ai-card-patch-v1') ? cached : cached.replace('</head>', '<style>/*ai-card-patch-v1*/.ai-answer-card{background:#f5f5f5!important;background-image:none!important}.ai-answer-kicker{display:none!important}.ai-answer-card h2{display:none!important}.site-btn.w-100{justify-content:center!important}</style></head>');
        return new Response(patched, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=3600, s-maxage=604800",
            "X-Cache": "HIT",
          },
        });
      }
    }
  } catch (e) {
    console.error("KV read:", e);
  }

  // Fetch events: KV first (avoids Wikipedia round-trip on cache miss), then Wikipedia
  const mPad = String(MONTH_NUM_MAP[monthName]).padStart(2, "0");
  const dPad = String(day).padStart(2, "0");
  let eventsData = { events: [], births: [], deaths: [] };
  let eventsFromKv = false;
  if (env.EVENTS_KV) {
    try {
      const kvData = await env.EVENTS_KV.get(`events-data:${mPad}-${dPad}`, {
        type: "json",
      });
      if (kvData?.events?.length) {
        eventsData = kvData;
        eventsFromKv = true;
      }
    } catch (_) {
      /* ignore */
    }
  }
  if (!eventsFromKv) {
    const apiUrl = `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/all/${mPad}/${dPad}`;
    try {
      const r = await fetch(apiUrl, {
        headers: { "User-Agent": WIKIPEDIA_USER_AGENT },
      });
      if (r.ok) {
        eventsData = await r.json();
        if (env.EVENTS_KV && eventsData?.events?.length) {
          ctx.waitUntil(
            env.EVENTS_KV.put(
              `events-data:${mPad}-${dPad}`,
              JSON.stringify(eventsData),
              { expirationTtl: 7 * 24 * 60 * 60 },
            ).catch(() => {}),
          );
        }
      }
    } catch (e) {
      console.error("Wikipedia API:", e);
    }
  }

  // Identify featured event and generate AI "Did You Know" facts
  // Must use the same wikiRichScore selection as generateEventsDateHTML so DYK facts match the featured card.
  const _evForFeatured = (eventsData?.events || []).slice().sort((a, b) => a.year - b.year);
  const featuredEvent = _evForFeatured.length
    ? _evForFeatured.reduce((best, e) => wikiRichScore(e) >= wikiRichScore(best) ? e : best, _evForFeatured[0])
    : null;
  let didYouKnowFacts = [];
  const wikiTitle = featuredEvent ? pickRelevantWikiTitle(featuredEvent) : "";
  const wikiSummary = featuredEvent
    ? await fetchWikipediaSummaryByTitle(wikiTitle)
    : "";

  // Run DYK and quiz generation in parallel to avoid double latency
  const [dykResult, quizResult] = await Promise.allSettled([
    // --- DYK async IIFE ---
    (async () => {
      if ((!env.AI && !env.GROQ_API_KEY) || !featuredEvent) return [];
      const eventDesc = `${featuredEvent.year} — ${featuredEvent.text}`;
      const contextChunks = [
        `Featured event: ${eventDesc}`,
        wikiTitle ? `Wikipedia article title: ${wikiTitle}` : "",
        wikiSummary ? `Wikipedia summary: ${wikiSummary}` : "",
      ].filter(Boolean);
      const raw = await callAI(
        env,
        [
          {
            role: "system",
            content:
              "You are a historical facts writer. Always respond with valid JSON only, no markdown, no extra text.",
          },
          {
            role: "user",
            content: `Using ONLY the featured event context below, write exactly 5 concise historical facts about this specific topic.\n\nFeatured event (do NOT repeat this verbatim): ${eventDesc}\n\n${contextChunks.slice(1).join("\n\n")}\n\nRules:\n- Exactly 5 items\n- Each item is 1-2 sentences, starting directly with the fact\n- Do NOT start with "Did You Know", "Did You Know that", or any similar preamble\n- Do NOT restate the featured event description — add new information only\n- Stay tightly tied to this topic and its directly related entities\n- Prefer concrete names, institutions, places, dates, and consequences\n- Output ONLY a JSON array of 5 strings\n\nExample:\n["Tokayev served as UN Director-General in Geneva before becoming president.", "Kazakhstan's constitution was amended three times under Nazarbayev's rule."]`,
          },
        ],
        { maxTokens: 1024, timeoutMs: 9_000 },
      );
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "")
        .trim();
      const arrMatch = cleaned.match(/\[[\s\S]*\]/);
      if (arrMatch) {
        try {
          const parsed = JSON.parse(arrMatch[0]);
          if (Array.isArray(parsed) && parsed.length >= 3) {
            return parsed
              .filter((f) => typeof f === "string")
              .map(normalizeDidYouKnowFact)
              .filter(Boolean)
              .slice(0, 5);
          }
        } catch (parseErr) {
          console.error("DYK JSON.parse failed:", parseErr);
        }
      }
      return [];
    })(),
    // --- Quiz async call ---
    generateQuizForDate(
      env,
      monthName,
      day,
      eventsData,
      featuredEvent,
      wikiSummary,
    ),
  ]);

  didYouKnowFacts = dykResult.status === "fulfilled" ? dykResult.value : [];
  if (dykResult.status === "rejected")
    console.error("AI did-you-know generation failed:", dykResult.reason);

  if (featuredEvent && didYouKnowFacts.length < 5) {
    const fallbackFacts = buildTopicFallbackFacts(
      featuredEvent,
      wikiSummary,
      wikiTitle,
    );
    didYouKnowFacts = [...didYouKnowFacts, ...fallbackFacts]
      .map(normalizeDidYouKnowFact)
      .filter(Boolean)
      .slice(0, 5);
  }

  const quizData = quizResult.status === "fulfilled" ? quizResult.value : null;
  if (quizResult.status === "rejected")
    console.error("Quiz generation failed:", quizResult.reason);

  const siteUrl = "https://thisday.info";
  const mDisplayForQuiz = MONTH_DISPLAY_NAMES[monthNum];
  const quizHtml = quizData
    ? buildQuizHTML(quizData, mDisplayForQuiz, day)
    : "";

  const relatedBlogEntry = await findMatchingDateBlogEntry(env, monthName, day);
  const html = generateEventsDateHTML(
    monthName,
    day,
    eventsData,
    siteUrl,
    didYouKnowFacts,
    quizHtml,
    quizData,
    relatedBlogEntry,
  );

  // Only cache to KV when we have actual events (avoids caching API failure responses)
  if (env.EVENTS_KV && (eventsData?.events?.length || 0) > 0) {
    ctx.waitUntil(
      env.EVENTS_KV.put(kvKey, html, { expirationTtl: 7 * 24 * 60 * 60 }).catch(
        (e) => console.error("KV write:", e),
      ),
    );
  }

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": bypassCache
        ? "no-store, no-cache"
        : "public, max-age=3600, s-maxage=604800",
      "X-Cache": bypassCache ? "BYPASS" : "MISS",
    },
  });
}

// --- Generate and cache AI editorial insights for each event on a given date ---
async function generateEventCommentary(env, mm, dd) {
  if (!env.AI && !env.GROQ_API_KEY) return {};
  let eventsData = { events: [], births: [], deaths: [] };
  if (env.EVENTS_KV) {
    try {
      const kv = await env.EVENTS_KV.get(`events-data:${mm}-${dd}`, {
        type: "json",
      });
      if (kv?.events?.length) eventsData = kv;
    } catch (_) {}
  }
  if (!eventsData.events.length) {
    try {
      const r = await fetch(
        `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/all/${mm}/${dd}`,
        { headers: { "User-Agent": WIKIPEDIA_USER_AGENT } },
      );
      if (r.ok) eventsData = await r.json();
    } catch (_) {}
  }
  const commentary = {};
  const typedSets = [
    eventsData.events || [],
    eventsData.births || [],
    eventsData.deaths || [],
  ];

  const processBatch = async (items) => {
    if (!items.length) return;
    const batch = items.slice(0, 30);
    const lines = batch
      .map(
        (e, i) => `${i + 1}. [${e.year}] ${(e.text || "").substring(0, 120)}`,
      )
      .join("\n");
    try {
      const raw = await callAI(
        env,
        [
          {
            role: "system",
            content:
              "You are a sharp, opinionated historical editor. Respond with valid JSON only — no markdown, no extra text.",
          },
          {
            role: "user",
            content: `Write exactly one editorial insight for each event below. Each insight must be:\n- Exactly 1 sentence, 15–22 words\n- Specific to that event (no generic phrases like "pivotal moment", "changed history", "shaped the course")\n- Vivid and human — something a curious reader would find surprising or memorable\n\nReply ONLY with a JSON array of strings in the same order as the list.\n\nEvents:\n${lines}`,
          },
        ],
        { maxTokens: 2000, timeoutMs: 12000 },
      );
      const cleaned = (raw || "")
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "")
        .trim();
      const arrMatch = cleaned.match(/\[[\s\S]*\]/);
      if (arrMatch) {
        const insights = JSON.parse(arrMatch[0]);
        batch.forEach((e, i) => {
          if (typeof insights[i] === "string" && insights[i].trim()) {
            const key = `${e.year}:${(e.text || "").substring(0, 30)}`;
            commentary[key] = insights[i].trim();
          }
        });
      }
    } catch (_) {}
  };

  await Promise.all(typedSets.map(processBatch));
  return commentary;
}

// --- Main Request Handler (for user requests) ---
async function handleFetchRequest(request, env, ctx) {
  const url = new URL(request.url);

  // --- Maintenance Mode ---
  // When maintenance mode is enabled, redirect to maintenance page
  // except for preview parameter (?preview=secret) which allows viewing the live pages
  const MAINTENANCE_ENABLED = false;
  const PREVIEW_SECRET = "secret";
  const isPreview = url.searchParams.get("preview") === PREVIEW_SECRET;
  const isExcludedRoute =
    url.pathname === "/maintenance.html" ||
    url.pathname.startsWith("/css/") ||
    url.pathname.startsWith("/images/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/favicon.ico" ||
    url.pathname === "/manifest.json" ||
    url.pathname === "/robots.txt" ||
    url.pathname === "/llms.txt" ||
    url.pathname === "/llms-full.txt";

  if (MAINTENANCE_ENABLED && !isPreview && !isExcludedRoute) {
    // Check if this is a worker route that should show maintenance
    const workerRoutes = [
      "/",
      "/blog",
      "/blog/",
      "/blog/index.json",
      "/blog/archive.json",
      "/events",
      "/events/",
      "/births",
      "/born/today/",
      "/deaths",
      "/died/today/",
      "/born/",
      "/died/",
      "/quiz",
      "/quiz/",
      "/people",
      "/people/",
      "/history",
      "/history/",
      "/about",
      "/about/",
      "/contact",
      "/contact/",
    ];
    const isWorkerRoute = workerRoutes.some(
      (route) => url.pathname === route || url.pathname.startsWith(route),
    );

    if (isWorkerRoute) {
      const maintenanceUrl = new URL(request.url);
      maintenanceUrl.pathname = "/maintenance.html";
      maintenanceUrl.search = "";
      return Response.redirect(maintenanceUrl.toString(), 302);
    }
  }

  if (url.pathname === "/robots.txt") {
    return new Response(
      [
        "User-agent: *",
        "Disallow: /blog/publish",
        "Disallow: /blog/preload-quizzes",
        "Disallow: /blog/quiz-debug/",
        "Disallow: /search-ping",
        "Disallow: /warmup",
        "",
        "# Allow all AI crawlers — full site access for training and citation",
        `Sitemap: ${url.origin}/sitemap.xml`,
        `Sitemap: ${url.origin}/sitemap-generated.xml`,
        `Sitemap: ${url.origin}/sitemap-people.xml`,
        `Sitemap: ${url.origin}/sitemap-entities.xml`,
        `Sitemap: ${url.origin}/news-sitemap.xml`,
      ].join("\n"),
      {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
        },
      },
    );
  }

  if (url.pathname === "/llms.txt") {
    return new Response(LLMS_TXT_CONTENT, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (url.pathname === "/llms-full.txt") {
    return new Response(LLMS_FULL_TXT_CONTENT, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // Image proxy — must be handled before the HTML pass-through guard
  if (url.pathname === "/image-proxy" || url.pathname === "/img") {
    return handleImageProxy(request, url, ctx);
  }

  // Wikipedia events proxy — avoids CORS issues from direct browser requests
  const eventsProxyMatch = url.pathname.match(
    /^\/api\/events\/(\d{2})\/(\d{2})$/,
  );
  if (eventsProxyMatch) {
    const mm = eventsProxyMatch[1];
    const dd = eventsProxyMatch[2];
    const apiUrl = `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/all/${mm}/${dd}`;
    const corsHeaders = {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    };

    const workerCache = caches.default;
    const cacheKey = new Request(apiUrl);
    const cached = await workerCache.match(cacheKey);
    if (cached) {
      const body = await cached.text();
      return new Response(body, { headers: corsHeaders });
    }

    try {
      const r = await fetch(apiUrl, {
        headers: { "User-Agent": WIKIPEDIA_USER_AGENT },
      });
      if (!r.ok) throw new Error(r.statusText);
      const body = await r.text();
      ctx.waitUntil(
        workerCache.put(
          cacheKey,
          new Response(body, {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "public, max-age=86400",
            },
          }),
        ),
      );
      return new Response(body, { headers: corsHeaders });
    } catch (e) {
      console.error("Events proxy error:", e);
      return new Response(
        JSON.stringify({ events: [], births: [], deaths: [] }),
        { headers: corsHeaders },
      );
    }
  }

  // AI commentary endpoint — generates & caches per-event editorial insights
  const commentaryMatch = url.pathname.match(
    /^\/api\/commentary\/(\d{2})\/(\d{2})$/,
  );
  if (commentaryMatch) {
    const mm = commentaryMatch[1];
    const dd = commentaryMatch[2];
    const corsBase = {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    };
    const commentaryKvKey = `event-commentary:${mm}-${dd}`;
    if (env.EVENTS_KV) {
      try {
        const cached = await env.EVENTS_KV.get(commentaryKvKey);
        // KV hit: real data — cache at edge for 1 day
        if (cached)
          return new Response(cached, {
            headers: {
              ...corsBase,
              "Cache-Control": "public, max-age=3600, s-maxage=86400",
            },
          });
      } catch (_) {}
    }
    const commentary = await generateEventCommentary(env, mm, dd);
    const json = JSON.stringify(commentary);
    const hasData = Object.keys(commentary).length > 0;
    if (env.EVENTS_KV && hasData) {
      ctx.waitUntil(
        env.EVENTS_KV.put(commentaryKvKey, json, {
          expirationTtl: 7 * 24 * 60 * 60,
        }).catch(() => {}),
      );
    }
    // Don't cache empty responses at the edge — AI may have timed out, allow retry
    return new Response(json, {
      headers: {
        ...corsBase,
        "Cache-Control": hasData
          ? "public, max-age=300, s-maxage=3600"
          : "no-store",
      },
    });
  }

  // Legacy /generated URLs always redirect to the canonical /events route
  if (url.pathname === "/generated" || url.pathname === "/generated/") {
    return Response.redirect(`${url.origin}/events/`, 301);
  }
  if (url.pathname.startsWith("/generated/")) {
    const targetPath = url.pathname.replace(/^\/generated(?=\/|$)/, "/events");
    return Response.redirect(`${url.origin}${targetPath}${url.search}`, 301);
  }

  // /events/today/ → redirect to today's date page
  if (url.pathname === "/events/today" || url.pathname === "/events/today/") {
    const now = new Date();
    const mn = MONTHS_ALL[now.getUTCMonth()];
    const dd = now.getUTCDate();
    return redirectNoStore(`${url.origin}/events/${mn}/${dd}/`, 302);
  }

  // /events landing -> today's date page
  if (url.pathname === "/events" || url.pathname === "/events/") {
    const now = new Date();
    const mn = MONTHS_ALL[now.getUTCMonth()];
    const dd = now.getUTCDate();
    return redirectNoStore(`${url.origin}/events/${mn}/${dd}/`, 302);
  }

  // /quiz/ or /quiz → today's quiz
  if (url.pathname === "/quiz" || url.pathname === "/quiz/") {
    const now = new Date();
    const mn = MONTHS_ALL[now.getUTCMonth()];
    const dd = now.getUTCDate();
    return redirectNoStore(`${url.origin}/quiz/${mn}/${dd}/`, 302);
  }

  // Quiz standalone pages: /quiz/{month}/{day}/
  const quizPageMatch = url.pathname.match(/^\/quiz\/([a-z]+)\/(\d+)\/?$/);
  if (quizPageMatch) {
    const monthSlug = quizPageMatch[1];
    const day = parseInt(quizPageMatch[2], 10);
    return handleQuizPage(request, env, monthSlug, day);
  }

  // Quiz API: /api/quiz/{month}/{day} — returns raw JSON
  const quizApiMatch = url.pathname.match(/^\/api\/quiz\/([a-z]+)\/(\d+)$/);
  if (quizApiMatch) {
    const monthSlug = quizApiMatch[1];
    const day = parseInt(quizApiMatch[2], 10);
    const monthNum = MONTH_NUM_MAP[monthSlug];
    if (
      !monthNum ||
      isNaN(day) ||
      day < 1 ||
      day > DAYS_IN_MONTH[monthNum - 1]
    ) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    const mm = String(monthNum).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    const kvKey = `quiz-v15:${mm}-${dd}`;
    try {
      const cached = await env.EVENTS_KV.get(kvKey);
      if (cached) {
        return new Response(cached, {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=3600",
          },
        });
      }
    } catch (e) {
      /* ignore */
    }
    return new Response(JSON.stringify({ error: "Quiz not yet generated" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // /today/ → redirect to today's events page
  if (url.pathname === "/today" || url.pathname === "/today/") {
    const now = new Date();
    const mn = MONTHS_ALL[now.getUTCMonth()];
    const dd = now.getUTCDate();
    return redirectNoStore(`${url.origin}/events/${mn}/${dd}/`, 302);
  }

  // /born/today/ → redirect to today's born page
  if (url.pathname === "/born/today" || url.pathname === "/born/today/") {
    const now = new Date();
    const mn = MONTHS_ALL[now.getUTCMonth()];
    const dd = now.getUTCDate();
    return redirectNoStore(`${url.origin}/born/${mn}/${dd}/`, 302);
  }

  // /born landing -> today's born page
  if (url.pathname === "/born" || url.pathname === "/born/") {
    const now = new Date();
    const mn = MONTHS_ALL[now.getUTCMonth()];
    const dd = now.getUTCDate();
    return redirectNoStore(`${url.origin}/born/${mn}/${dd}/`, 302);
  }

  // /died/today/ → redirect to today's died page
  if (url.pathname === "/died/today" || url.pathname === "/died/today/") {
    const now = new Date();
    const mn = MONTHS_ALL[now.getUTCMonth()];
    const dd = now.getUTCDate();
    return redirectNoStore(`${url.origin}/died/${mn}/${dd}/`, 302);
  }

  // /died landing -> today's died page
  if (url.pathname === "/died" || url.pathname === "/died/") {
    const now = new Date();
    const mn = MONTHS_ALL[now.getUTCMonth()];
    const dd = now.getUTCDate();
    return redirectNoStore(`${url.origin}/died/${mn}/${dd}/`, 302);
  }

  // Legacy people aliases -> canonical routes
  if (url.pathname === "/births" || url.pathname === "/births/") {
    return Response.redirect(`${url.origin}/born/today/`, 301);
  }
  if (url.pathname === "/deaths" || url.pathname === "/deaths/") {
    return Response.redirect(`${url.origin}/died/today/`, 301);
  }

  if (url.pathname === "/people" || url.pathname === "/people/") {
    return handlePeopleIndexPage(request, env, url);
  }

  const personEntityMatch = url.pathname.match(/^\/people\/([a-z0-9-]+)\/?$/);
  if (personEntityMatch) {
    return handleEntityPage(request, env, url, "person", personEntityMatch[1], ctx);
  }

  const historyEntityMatch = url.pathname.match(/^\/history\/([a-z0-9-]+)\/?$/);
  if (historyEntityMatch) {
    return handleEntityPage(request, env, url, "event", historyEntityMatch[1], ctx);
  }

  // Born pages: /born/{month}/{day}/
  const bornPageMatch = url.pathname.match(/^\/born\/([a-z]+)\/(\d+)\/?$/);
  if (bornPageMatch) {
    const monthSlug = bornPageMatch[1];
    const day = parseInt(bornPageMatch[2], 10);
    return handleBornPage(request, env, ctx, url, monthSlug, day);
  }

  // Died pages: /died/{month}/{day}/
  const diedPageMatch = url.pathname.match(/^\/died\/([a-z]+)\/(\d+)\/?$/);
  if (diedPageMatch) {
    const monthSlug = diedPageMatch[1];
    const day = parseInt(diedPageMatch[2], 10);
    return handleDiedPage(request, env, ctx, url, monthSlug, day);
  }

  // Blog index page
  if (url.pathname === "/blog" || url.pathname === "/blog/") {
    return handleBlogIndex(env, url);
  }

  if (url.pathname === "/topics" || url.pathname === "/topics/") {
    return handleTopicsIndex(env, url);
  }

  const topicHubMatch = url.pathname.match(/^\/topics\/([a-z0-9-]+)\/?$/);
  if (topicHubMatch) {
    return handleTopicHubPage(env, url, topicHubMatch[1]);
  }

  if (url.pathname === "/years" || url.pathname === "/years/") {
    return handleYearsIndex(env, url);
  }

  const yearArchiveMatch = url.pathname.match(/^\/years\/(\d{3,4})\/?$/);
  if (yearArchiveMatch) {
    return handleYearArchivePage(env, url, parseInt(yearArchiveMatch[1], 10));
  }

  if (url.pathname === "/keywords" || url.pathname === "/keywords/") {
    return handleKeywordsIndex(env, url);
  }

  const keywordArchiveMatch = url.pathname.match(/^\/keywords\/([a-z0-9-]+)\/?$/);
  if (keywordArchiveMatch) {
    return handleKeywordArchivePage(env, url, keywordArchiveMatch[1]);
  }

  // Serve the KV blog index as canonical /blog/index.json.
  // Keep /blog/archive.json as a legacy alias for older homepage consumers.
  if (
    url.pathname === "/blog/index.json" ||
    url.pathname === "/blog/archive.json"
  ) {
    const index = env.BLOG_AI_KV
      ? await env.BLOG_AI_KV.get("index", { type: "json" }).catch(() => null)
      : null;
    const data = Array.isArray(index) ? index : [];
    return new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300, s-maxage=3600",
      },
    });
  }

  // Events pages — must be before the HTML pass-through guard
  if (url.pathname.startsWith("/events/")) {
    return handleEventsDatePage(request, env, ctx, url);
  }

  // Sitemap for born/died pages (366 × 2 = 732 URLs)
  if (url.pathname === "/sitemap-people.xml") {
    const siteUrl = `${url.protocol}//${url.host}`;
    return new Response(await servePeopleSitemap(siteUrl, env), {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=3600, s-maxage=86400",
        "X-Robots-Tag": "noindex",
      },
    });
  }

  // Date-route sitemap listing all canonical /events/ pages and /quiz/ pages
  if (url.pathname === "/sitemap-generated.xml") {
    const siteUrl = `${url.protocol}//${url.host}`;
    return new Response(serveEventsDateSitemap(siteUrl), {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=3600, s-maxage=86400",
        "X-Robots-Tag": "noindex",
      },
    });
  }

  // Test/staging pages — always serve fresh, never from edge cache
  if (url.pathname === "/indexv2.html") {
    const resp = await fetch(request, { cf: { cacheEverything: false } });
    const fresh = new Response(resp.body, resp);
    fresh.headers.set("Cache-Control", "no-store, no-cache");
    return fresh;
  }

  // Only handle requests for the root path or /index.html
  // Pass through all other requests (e.g., for JS, CSS, images) directly to the origin
  if (
    url.pathname !== "/" &&
    url.pathname !== "/index.html" &&
    url.pathname !== "/manifest.json"
  ) {
    return fetch(request);
  }

  if (url.pathname === "/manifest.json") {
    const manifestContent = {
      name: "This Day in History",
      short_name: "ThisDay",
      description:
        "Explore historical events, milestones, and notable figures from past and present. Discover what happened today in history. Browse by date and learn about wars, inventions, discoveries, and the lives of notable people. Make history come alive - one day at a time.",
      version: "1.0.0",
      start_url: "/",
      display: "standalone",
      background_color: "#2c3e50",
      theme_color: "#2c3e50",
      orientation: "any",
      scope: "/",
      lang: "en",
      icons: [
        {
          src: "icons/icon-72x72.png",
          sizes: "72x72",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "icons/icon-96x96.png",
          sizes: "96x96",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "icons/icon-128x128.png",
          sizes: "128x128",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "icons/icon-144x144.png",
          sizes: "144x144",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "icons/icon-152x152.png",
          sizes: "152x152",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "icons/icon-192x192.png",
          sizes: "192x192",
          type: "image/png",
          purpose: "any maskable",
        },
        {
          src: "icons/icon-384x384.png",
          sizes: "384x384",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "icons/icon-512x512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "any maskable",
        },
      ],
      categories: ["education", "reference", "history"],
      screenshots: [
        {
          src: "screenshots/desktop.png",
          sizes: "1280x720",
          type: "image/png",
          form_factor: "wide",
        },
        {
          src: "screenshots/mobile.png",
          sizes: "540x720",
          type: "image/png",
          form_factor: "narrow",
        },
      ],
    };
    return new Response(JSON.stringify(manifestContent), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const today = new Date(); // Current date (at Cloudflare edge)
  const isoDateKey = today.toISOString().split("T")[0]; // e.g. "2026-02-17"
  const todayKvKey = `today-events-${isoDateKey}`; // Date-specific key prevents stale cross-day data

  // 1. Try to get events data from KV first
  let eventsData;
  try {
    const cachedKvData = await env.EVENTS_KV.get(todayKvKey, { type: "json" });
    if (cachedKvData) {
      eventsData = cachedKvData;
      console.log("KV Cache HIT for today's events!");
    } else {
      // 2. If not in KV, fetch it now and update KV (this means KV wasn't pre-populated yet)
      console.log(
        "KV Cache MISS for today's events, fetching live and populating KV...",
      );
      eventsData = await fetchDailyEvents(today);
      // Queue KV write without blocking — handled after response is sent
      if (eventsData && eventsData.events && eventsData.events.length > 0) {
        ctx.waitUntil(
          env.EVENTS_KV.put(todayKvKey, JSON.stringify(eventsData), {
            expirationTtl: KV_CACHE_TTL_SECONDS,
          }),
        );
        console.log("KV update queued (non-blocking).");
      }
    }
  } catch (kvError) {
    console.error("Error accessing KV. Falling back to live fetch:", kvError);
    eventsData = await fetchDailyEvents(today); // Fallback to live fetch on KV error
  }

  // Prepare dynamic meta tags and content based on fetched data
  let dynamicDescription = SITE_DESCRIPTION;
  let dynamicKeywords =
    "thisDay, historical events, on this day, history, daily highlights, calendar, famous birthdays, anniversaries, notable deaths, world history, today in history, educational, timeline, trivia, historical figures, history quiz, daily quiz, history blog, history articles, YouTube Shorts history, this day in history, what happened today, historical milestones, Flipboard history";
  let dynamicTitle =
    "thisDay. | What Happened on This Day? | Historical Events";
  let ogImageUrl = "https://thisday.info/images/logo.png"; // Default fallback image
  const ogUrl = "https://thisday.info/"; // Canonical URL

  // Format the date for the title and description
  const options = { month: "long", day: "numeric" };
  const formattedDate = today.toLocaleDateString("en-US", options); // e.g., "July 12"
  const isoDate = today.toISOString().split("T")[0]; // e.g., "2025-07-12"

  if (eventsData && eventsData.events && eventsData.events.length > 0) {
    // Use the first event's Wikipedia thumbnail for social sharing if available
    const firstWithImage = eventsData.events.find(
      (e) => e.pages?.[0]?.thumbnail?.source,
    );
    if (firstWithImage) {
      const rawImgUrl = firstWithImage.pages[0].thumbnail.source;
      // Route through the image proxy: resizes to 1200px and caches at edge for 30 days
      ogImageUrl = `/image-proxy?src=${encodeURIComponent(rawImgUrl)}&w=1200&q=82`;
    }

    // Pick the top 3-5 events for a concise description
    const topEvents = eventsData.events
      .slice(0, 5)
      .map((event) => `In ${event.year}, ${event.text}`)
      .join("; ");

    const firstEventText = eventsData.events[0].text;
    const titleSnippet =
      firstEventText.length > 65
        ? firstEventText.substring(0, firstEventText.lastIndexOf(" ", 65)) +
          "..."
        : firstEventText;
    dynamicTitle = `On This Day, ${formattedDate}: ${eventsData.events[0].year}, ${titleSnippet} | thisDay.info`;

    const rawDesc = `Discover what happened on ${formattedDate}: ${topEvents}. Explore historical events, births, and deaths.`;
    dynamicDescription =
      rawDesc.length > 155
        ? rawDesc.substring(0, rawDesc.lastIndexOf(" ", 155)) + "..."
        : rawDesc;

    // Add relevant keywords from event texts (simple approach)
    const eventKeywords = eventsData.events
      .slice(0, 10)
      .flatMap((event) => event.text.split(" "))
      .filter((word) => word.length > 3 && /^[a-zA-Z]+$/.test(word)) // Basic filter
      .map((word) => word.toLowerCase())
      .filter((value, index, self) => self.indexOf(value) === index) // Unique words
      .slice(0, 20) // Limit to top 20
      .join(", ");
    dynamicKeywords = `${dynamicKeywords}, ${eventKeywords}`;
  }

  // When no Wikipedia thumbnail was found, fall back to the dynamic OG image
  // worker which generates a branded SVG card with the date and event title.
  if (ogImageUrl === "https://thisday.info/images/logo.png") {
    ogImageUrl = `/og-image?title=${encodeURIComponent(dynamicTitle)}&date=${encodeURIComponent(formattedDate)}`;
  }
  const homepageVideoCards = await buildHomepageVideoCards(env).catch(() => "");

  // Fetch the original index.html from the origin server
  const originalResponse = await fetch(url.origin, request);
  let contentType = originalResponse.headers.get("content-type") || "";

  // Only apply transformations to HTML responses
  if (!contentType.includes("text/html")) {
    return originalResponse;
  }

  const rewriter = new HTMLRewriter()
    // --- Meta Tags and Title ---
    .on("title", {
      element(element) {
        element.setInnerContent(dynamicTitle);
      },
    })
    .on("meta[name='description']", {
      element(element) {
        element.setAttribute("content", dynamicDescription);
      },
    })
    .on("meta[name='keywords']", {
      element(element) {
        element.setAttribute("content", dynamicKeywords);
      },
    })
    .on("meta[property='og:title']", {
      element(element) {
        element.setAttribute("content", dynamicTitle);
      },
    })
    .on("meta[property='og:description']", {
      element(element) {
        element.setAttribute("content", dynamicDescription);
      },
    })
    .on("meta[property='og:image']", {
      element(element) {
        element.setAttribute("content", ogImageUrl);
      },
    })
    .on("meta[property='og:url']", {
      element(element) {
        element.setAttribute("content", ogUrl);
      },
    })
    .on("meta[property='og:type']", {
      element(element) {
        element.setAttribute("content", "website");
      },
    })
    .on("meta[name='twitter:card']", {
      element(element) {
        element.setAttribute("content", "summary_large_image");
      },
    })
    .on("meta[name='twitter:title']", {
      element(element) {
        element.setAttribute("content", dynamicTitle);
      },
    })
    .on("meta[name='twitter:description']", {
      element(element) {
        element.setAttribute("content", dynamicDescription);
      },
    })
    .on("meta[name='twitter:image']", {
      element(element) {
        element.setAttribute("content", ogImageUrl);
      },
    })
    .on("meta[property='og:image:alt']", {
      element(element) {
        element.setAttribute("content", dynamicTitle);
      },
    })
    .on("meta[property='og:image:width']", {
      element(element) {
        element.setAttribute("content", "1200");
      },
    })
    .on("meta[property='og:image:height']", {
      element(element) {
        element.setAttribute("content", "630");
      },
    })
    .on("#videoGrid", {
      element(element) {
        if (homepageVideoCards) {
          element.setInnerContent(homepageVideoCards, { html: true });
        }
      },
    });

  // Inject preloaded data for the current day into the HTML
  if (eventsData && eventsData.events && eventsData.events.length > 0) {
    const initialEventsForClient = eventsData.events;
    const initialBirthsForClient = eventsData.births || [];
    const initialDeathsForClient = eventsData.deaths || [];

    const preloadedData = {
      events: initialEventsForClient,
      births: initialBirthsForClient,
      deaths: initialDeathsForClient,
    };
    const jsonData = JSON.stringify(preloadedData);

    rewriter.on("head", {
      element(element) {
        // --- Inject Preloaded Data for Client-Side JS ---
        element.append(
          `<script id="preloaded-today-events" type="application/json">${jsonData}</script>`,
          { html: true },
        );

        // --- Main WebPage Schema with Events Collection ---
        const webPageSchema = {
          "@context": "https://schema.org",
          "@type": "WebPage",
          name: dynamicTitle,
          description: dynamicDescription,
          url: ogUrl,
          datePublished: isoDate,
          dateModified: isoDate,
          isPartOf: {
            "@type": "WebSite",
            name: "thisDay.info",
            url: "https://thisday.info/",
            description:
              "Explore historical events, milestones, and notable figures from any date",
            publisher: {
              "@type": "Organization",
              name: "thisDay.info",
              url: "https://thisday.info/",
            },
          },
          potentialAction: {
            "@type": "SearchAction",
            target: {
              "@type": "EntryPoint",
              urlTemplate: "https://thisday.info/?q={search_term_string}",
            },
            "query-input": "required name=search_term_string",
          },
          // Add mainEntity for primary content
          mainEntity: {
            "@type": "ItemList",
            name: `Historical Events on ${formattedDate}`,
            description: `Collection of historical events, births, and deaths that occurred on ${formattedDate}`,
            numberOfItems:
              (eventsData?.events?.length || 0) +
              (eventsData?.births?.length || 0) +
              (eventsData?.deaths?.length || 0),
          },
        };

        element.append(
          `<script type="application/ld+json">${JSON.stringify(
            webPageSchema,
          )}</script>`,
          { html: true },
        );

        // --- Consolidated Events Schema (limit to top events to avoid bloat) ---
        if (eventsData && eventsData.events && eventsData.events.length > 0) {
          // Create a consolidated events schema instead of individual ones
          const topEvents = eventsData.events.slice(0, 5); // Limit to top 5 events
          const eventsListSchema = {
            "@context": "https://schema.org",
            "@type": "ItemList",
            name: `Historical Events on ${formattedDate}`,
            description: `Major historical events that occurred on ${formattedDate} throughout history`,
            url: ogUrl,
            numberOfItems: topEvents.length,
            itemListElement: topEvents.map((eventItem, index) => {
              const locationName = extractLocationFromName(eventItem.text);
              const eventImage =
                eventItem.pages &&
                eventItem.pages.length > 0 &&
                eventItem.pages[0].thumbnail &&
                eventItem.pages[0].thumbnail.source
                  ? eventItem.pages[0].thumbnail.source
                  : undefined;

              return {
                "@type": "ListItem",
                position: index + 1,
                item: {
                  "@type": "Event",
                  name:
                    eventItem.text.length > 100
                      ? eventItem.text.substring(0, 100) + "..."
                      : eventItem.text,
                  startDate: `${eventItem.year}-${String(
                    today.getMonth() + 1,
                  ).padStart(2, "0")}-${String(today.getDate()).padStart(
                    2,
                    "0",
                  )}`,
                  description: eventItem.text,
                  // Temporal Coverage
                  temporalCoverage: eventItem.year.toString(),
                  // Location
                  location: {
                    "@type": "Place",
                    name: locationName,
                  },
                  // Image
                  ...(eventImage && { image: eventImage }),
                },
              };
            }),
          };

          element.append(
            `<script type="application/ld+json">${JSON.stringify(
              eventsListSchema,
            )}</script>`,
            { html: true },
          );
        }

        // --- Notable People Schema (Births - limit to top 3) ---
        if (eventsData?.births && eventsData.births.length > 0) {
          const topBirths = eventsData.births.slice(0, 3);
          const birthsListSchema = {
            "@context": "https://schema.org",
            "@type": "ItemList",
            name: `Notable People Born on ${formattedDate}`,
            description: `Famous individuals born on ${formattedDate} throughout history`,
            url: ogUrl,
            numberOfItems: topBirths.length,
            itemListElement: topBirths.map((birthItem, index) => {
              // Better name parsing - handle cases like "Name, title" or "Name (profession)"
              const nameMatch = birthItem.text.match(/^([^,\(]+)/);
              const personName = nameMatch
                ? nameMatch[1].trim()
                : birthItem.text.split(",")[0].trim();
              const personImage =
                birthItem.pages &&
                birthItem.pages.length > 0 &&
                birthItem.pages[0].thumbnail &&
                birthItem.pages[0].thumbnail.source
                  ? birthItem.pages[0].thumbnail.source
                  : undefined;

              const wikiUrl =
                birthItem.pages &&
                birthItem.pages.length > 0 &&
                birthItem.pages[0].content_urls?.desktop?.page
                  ? birthItem.pages[0].content_urls.desktop.page
                  : ogUrl;

              return {
                "@type": "ListItem",
                position: index + 1,
                item: {
                  "@type": "Person",
                  name: personName,
                  birthDate: `${birthItem.year}-${String(
                    today.getMonth() + 1,
                  ).padStart(2, "0")}-${String(today.getDate()).padStart(
                    2,
                    "0",
                  )}`,
                  description: birthItem.text,
                  url: wikiUrl,
                  // Add additional context if available
                  ...(birthItem.pages &&
                    birthItem.pages.length > 0 && {
                      sameAs: [
                        `https://en.wikipedia.org/wiki/${encodeURIComponent(
                          birthItem.pages[0].title.replace(/ /g, "_"),
                        )}`,
                      ],
                    }),
                  // Image for Person if available
                  ...(personImage && { image: personImage }),
                },
              };
            }),
          };

          element.append(
            `<script type="application/ld+json">${JSON.stringify(
              birthsListSchema,
            )}</script>`,
            { html: true },
          );
        }

        // --- Deaths Schema (limit to top 3) ---
        if (eventsData?.deaths && eventsData.deaths.length > 0) {
          const topDeaths = eventsData.deaths.slice(0, 3);
          const deathsListSchema = {
            "@context": "https://schema.org",
            "@type": "ItemList",
            name: `Notable People Who Died on ${formattedDate}`,
            description: `Famous individuals who died on ${formattedDate} throughout history`,
            url: ogUrl,
            numberOfItems: topDeaths.length,
            itemListElement: topDeaths.map((deathItem, index) => {
              const nameMatch = deathItem.text.match(/^([^,\(]+)/);
              const personName = nameMatch
                ? nameMatch[1].trim()
                : deathItem.text.split(",")[0].trim();
              const personImage =
                deathItem.pages &&
                deathItem.pages.length > 0 &&
                deathItem.pages[0].thumbnail &&
                deathItem.pages[0].thumbnail.source
                  ? deathItem.pages[0].thumbnail.source
                  : undefined;

              const wikiUrl =
                deathItem.pages &&
                deathItem.pages.length > 0 &&
                deathItem.pages[0].content_urls?.desktop?.page
                  ? deathItem.pages[0].content_urls.desktop.page
                  : ogUrl;

              return {
                "@type": "ListItem",
                position: index + 1,
                item: {
                  "@type": "Person",
                  name: personName,
                  deathDate: `${deathItem.year}-${String(
                    today.getMonth() + 1,
                  ).padStart(2, "0")}-${String(today.getDate()).padStart(
                    2,
                    "0",
                  )}`,
                  description: deathItem.text,
                  url: wikiUrl,
                  // Add Wikipedia link if available
                  ...(deathItem.pages &&
                    deathItem.pages.length > 0 && {
                      sameAs: [
                        `https://en.wikipedia.org/wiki/${encodeURIComponent(
                          deathItem.pages[0].title.replace(/ /g, "_"),
                        )}`,
                      ],
                    }),
                  // Image for Person if available
                  ...(personImage && { image: personImage }),
                },
              };
            }),
          };

          element.append(
            `<script type="application/ld+json">${JSON.stringify(
              deathsListSchema,
            )}</script>`,
            { html: true },
          );
        }

        // --- Add Breadcrumb Schema ---
        const breadcrumbSchema = {
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            {
              "@type": "ListItem",
              position: 1,
              name: "Home",
              item: "https://thisday.info/",
            },
            {
              "@type": "ListItem",
              position: 2,
              name: `${formattedDate} in History`,
              item: ogUrl,
            },
          ],
        };

        element.append(
          `<script type="application/ld+json">${JSON.stringify(
            breadcrumbSchema,
          )}</script>`,
          { html: true },
        );

        // --- Add FAQ Schema if you have common questions ---
        const faqSchema = {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: [
            {
              "@type": "Question",
              name: `What happened on ${formattedDate}?`,
              acceptedAnswer: {
                "@type": "Answer",
                text: dynamicDescription,
              },
            },
            {
              "@type": "Question",
              name: "How do I find historical events for other dates?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Use the interactive calendar on thisDay.info to navigate to any month and day. Click a day card to see all events, births, and deaths that occurred on that date throughout history.",
              },
            },
            {
              "@type": "Question",
              name: "Where does thisDay.info get its historical data?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "All historical event data is sourced from Wikipedia via the Wikimedia REST API. Each event links directly to its Wikipedia article for further reading.",
              },
            },
            {
              "@type": "Question",
              name: `Who was born on ${formattedDate}?`,
              acceptedAnswer: {
                "@type": "Answer",
                text:
                  eventsData?.births?.length > 0
                    ? `Notable people born on ${formattedDate} include: ${eventsData.births
                        .slice(0, 3)
                        .map((b) => b.text.split(",")[0])
                        .join(", ")}. Browse the full list on thisDay.info.`
                    : `Explore thisDay.info to discover notable people born on ${formattedDate} throughout history.`,
              },
            },
            {
              "@type": "Question",
              name: "Is thisDay.info free to use?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Yes, thisDay.info is completely free. Explore historical events, famous birthdays, and notable deaths for any date without any registration or subscription.",
              },
            },
          ],
        };

        element.append(
          `<script type="application/ld+json">${JSON.stringify(
            faqSchema,
          )}</script>`,
          { html: true },
        );

        // --- Inject today's canonical events URL so the carousel can link internally ---
        const mn = MONTHS_ALL[today.getMonth()];
        const dd = today.getDate();
        element.append(
          `<script>window.__todayEventsUrl="/events/${mn}/${dd}/";window.__todayGeneratedUrl=window.__todayEventsUrl;</script>`,
          { html: true },
        );
      },
    });
  }

  // --- Resource Hints -------------------------------------------------------
  // Prepend preconnect / dns-prefetch tags to <head> so the browser opens
  // TCP/TLS connections to critical external domains as early as possible,
  // before the parser reaches those resources further down the page.
  rewriter.on("head", {
    element(element) {
      element.prepend(
        '<link rel="alternate" type="application/rss+xml" title="thisDay. — On This Day in History" href="https://thisday.info/rss.xml">\n' +
          '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
          '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
          '<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>\n' +
          '<link rel="dns-prefetch" href="https://api.wikimedia.org">\n' +
          '<link rel="dns-prefetch" href="https://upload.wikimedia.org">\n' +
          '<link rel="dns-prefetch" href="https://www.googletagmanager.com">\n' +
          '<link rel="dns-prefetch" href="https://pagead2.googlesyndication.com">',
        { html: true },
      );
    },
  });

  // --- SSR Pre-render -------------------------------------------------------
  // Injects today's top 5 historical events as real HTML into #calendarGrid,
  // replacing the loading spinner. Crawlers that don't execute JavaScript
  // (or render slowly) can index meaningful text content instead of a spinner.
  //
  // For real users: script.js does `calendarGrid.innerHTML = ""` on line 636
  // when it renders the interactive calendar, cleanly replacing this content.
  if (eventsData && eventsData.events && eventsData.events.length > 0) {
    const ssrItems = eventsData.events
      .slice(0, 5)
      .map(
        (e) =>
          `<li class="mb-2"><b>${escapeHtml(String(e.year))}:</b> ${escapeHtml(e.text)}</li>`,
      )
      .join("");

    rewriter.on("#calendarGrid", {
      element(element) {
        element.setInnerContent(
          `<section class="p-4" aria-label="Today's events in history">\n` +
            `<h2 class="h5 mb-3">On This Day, ${escapeHtml(formattedDate)}</h2>\n` +
            `<ul class="list-unstyled mb-0">${ssrItems}</ul>\n` +
            `</section>`,
          { html: true },
        );
      },
    });
  }

  // Transform the response
  const transformedResponse = rewriter.transform(originalResponse);

  // Clone the response to modify headers
  const newResponse = new Response(
    transformedResponse.body,
    transformedResponse,
  );

  // --- Add Security Headers ---

  // X-Content-Type-Options: nosniff - Prevents browsers from MIME-sniffing a response away from the declared Content-Type.
  newResponse.headers.set("X-Content-Type-Options", "nosniff");

  // Strict-Transport-Security (HSTS) - ONLY if your site is always HTTPS.
  // This tells browsers to only connect via HTTPS for a given duration, preventing downgrade attacks.
  // Be very careful with this; if you ever revert to HTTP, users might be locked out for max-age duration.
  newResponse.headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains; preload",
  );

  // Content-Security-Policy (CSP) - Most comprehensive.
  // This needs to be carefully crafted based on ALL resources your site uses (scripts, styles, images, fonts, etc.).
  // Incorrect CSP can break your site. Review and refine this based on your actual site's needs.
  // - default-src 'none': Blocks everything by default, forcing explicit allowance.
  // - connect-src: Allows connections to your domain ('self') and the Wikipedia API.
  // - script-src: Allows scripts from your domain ('self') and jsDelivr CDN (for Bootstrap/jQuery).
  // - style-src: Allows styles from your domain ('self'), jsDelivr CDN, and 'unsafe-inline' for any inline <style> tags or style attributes.
  // - img-src: Allows images from your domain ('self'), data URIs (for inline images), and Wikipedia (for event images).
  // - font-src: Allows fonts from your domain ('self') and jsDelivr CDN.
  // - base-uri 'self': Restricts the URLs that can be used in <base> elements.
  // - frame-ancestors 'none': Specifically for ClickJacking prevention (prevents embedding your site in iframes).
  // - object-src 'none': Prevents embedding <object>, <embed>, or <applet> elements.
  const csp =
    `default-src 'none'; ` +
    `connect-src 'self' https://api.wikimedia.org https://en.wikipedia.org https://cdn.jsdelivr.net ` +
    `https://www.google-analytics.com https://www.google.com https://www.google.ba https://www.gstatic.com ` +
    `https://www.googleadservices.com https://pagead2.googlesyndication.com ` +
    `https://*.adtrafficquality.google https://*.doubleclick.net ` +
    `https://www.googletagmanager.com https://fundingchoicesmessages.google.com https://openlibrary.org; ` +
    `script-src 'self' https://cdn.jsdelivr.net https://consent.cookiebot.com https://www.googletagmanager.com https://www.googleadservices.com https://googleads.g.doubleclick.net https://pagead2.googlesyndication.com https://fundingchoicesmessages.google.com https://static.cloudflareinsights.com https://*.adtrafficquality.google 'unsafe-inline'; ` +
    `style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; ` +
    `img-src 'self' data: https://upload.wikimedia.org https://covers.openlibrary.org https://cdn.buymeacoffee.com https://imgsct.cookiebot.com https://www.google.com https://www.google.ba https://www.googleadservices.com https://pagead2.googlesyndication.com https://placehold.co https://www.googletagmanager.com https://i.ytimg.com https://img.youtube.com https://*.adtrafficquality.google https://*.doubleclick.net; ` +
    `font-src 'self' https://cdn.jsdelivr.net https://fonts.gstatic.com; ` +
    `frame-src https://consentcdn.cookiebot.com https://td.doubleclick.net https://www.googletagmanager.com https://www.google.com https://www.youtube.com https://googleads.g.doubleclick.net https://fundingchoicesmessages.google.com https://*.adtrafficquality.google; ` +
    `manifest-src 'self'; ` +
    `base-uri 'self'; ` +
    `frame-ancestors 'none'; ` +
    `object-src 'none';`;
  newResponse.headers.set("Content-Security-Policy", csp);

  // X-Frame-Options: DENY - Also for ClickJacking protection. Redundant if CSP frame-ancestors 'none' is used, but good for older browsers.
  newResponse.headers.set("X-Frame-Options", "DENY");

  // Referrer-Policy - controls what referrer info is sent with outbound requests
  newResponse.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  // Permissions-Policy - disable browser features the site doesn't use
  newResponse.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  );

  // Cache-Control - allow CDN/edge to cache transformed HTML for 1 hour, serve stale for 24h while revalidating
  newResponse.headers.set(
    "Cache-Control",
    "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
  );

  // Vary - tell proxies/CDNs this response varies by encoding, ensuring compressed variants are cached separately
  newResponse.headers.set("Vary", "Accept-Encoding");

  // HTTP Link header — browsers and CDNs act on preconnect hints in HTTP
  // headers before they even start parsing HTML, giving an extra head-start.
  newResponse.headers.set(
    "Link",
    [
      "<https://fonts.googleapis.com>; rel=preconnect",
      "<https://fonts.gstatic.com>; rel=preconnect; crossorigin",
      "<https://cdn.jsdelivr.net>; rel=preconnect; crossorigin",
      "<https://api.wikimedia.org>; rel=dns-prefetch",
    ].join(", "),
  );

  return newResponse;
}

// --- Scheduled Event Handler (Cron Trigger) ---
async function handleScheduledEvent(env) {
  console.log("Scheduled event triggered: Pre-fetching today's events to KV.");
  const today = new Date();
  const isoDateKey = today.toISOString().split("T")[0];
  const todayKvKey = `today-events-${isoDateKey}`;
  const eventsData = await fetchDailyEvents(today);

  if (eventsData && eventsData.events && eventsData.events.length > 0) {
    try {
      await env.EVENTS_KV.put(todayKvKey, JSON.stringify(eventsData), {
        expirationTtl: KV_CACHE_TTL_SECONDS,
      });
      // Also store under the per-date key used by the quiz page fast-path
      const mNum = String(today.getUTCMonth() + 1).padStart(2, "0");
      const dNum = String(today.getUTCDate()).padStart(2, "0");
      await env.EVENTS_KV.put(
        `events-data:${mNum}-${dNum}`,
        JSON.stringify(eventsData),
        { expirationTtl: 7 * 24 * 60 * 60 },
      );
      // Invalidate stale full-page HTML cache so next visit regenerates with fresh data
      await env.EVENTS_KV.delete(`quiz-page-v30:${mNum}-${dNum}`);
      console.log(
        `Successfully pre-fetched and stored events for ${isoDateKey} in KV.`,
      );
    } catch (e) {
      console.error("Failed to put data into KV:", e);
    }
  } else {
    console.warn("No events data fetched, not updating KV.");
  }

  // Pre-generate today's quiz
  try {
    const monthSlug = MONTHS_ALL[today.getUTCMonth()];
    const day = today.getUTCDate();
    const featuredEvent =
      eventsData?.events?.find((e) => e.pages?.[0]?.thumbnail?.source) ||
      eventsData?.events?.[0] ||
      null;
    const wikiTitle = featuredEvent ? pickRelevantWikiTitle(featuredEvent) : "";
    const wikiSummary = wikiTitle
      ? await fetchWikipediaSummaryByTitle(wikiTitle)
      : "";
    const cronTopEvents = [];
    const cronEvAll = eventsData?.events || [];
    for (const e of cronEvAll) {
      if (e.pages?.[0]?.thumbnail?.source && cronTopEvents.length < 5)
        cronTopEvents.push(e);
    }
    for (const e of cronEvAll) {
      if (!e.pages?.[0]?.thumbnail?.source && cronTopEvents.length < 5)
        cronTopEvents.push(e);
    }
    await generateQuizForDate(
      env,
      monthSlug,
      day,
      eventsData,
      featuredEvent,
      wikiSummary,
      cronTopEvents,
    );
    console.log(`Quiz pre-generated for ${monthSlug}/${day}.`);

    // Best-effort: notify IndexNow (via /search-ping) that the dynamic pages changed.
    // This helps Bing discover fresh daily /events/ and /quiz/ content faster.
    // (Google's sitemap ping endpoint is deprecated; sitemaps still work normally.)
    try {
      const urls = [
        `https://thisday.info/events/${monthSlug}/${day}/`,
        `https://thisday.info/born/${monthSlug}/${day}/`,
        `https://thisday.info/died/${monthSlug}/${day}/`,
        `https://thisday.info/quiz/${monthSlug}/${day}/`,
      ];
      await fetch("https://thisday.info/search-ping", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(env.SEARCH_PING_SECRET
            ? { Authorization: `Bearer ${env.SEARCH_PING_SECRET}` }
            : {}),
        },
        body: JSON.stringify({ urls }),
      });
    } catch (e) {
      console.error("Scheduled: /search-ping failed:", e);
    }
  } catch (e) {
    console.error("Quiz pre-generation failed:", e);
  }
}

// --- Quiz: Generate quiz for a date using AI ---
async function generateQuizForDate(
  env,
  monthName,
  day,
  eventsData,
  featuredEvent,
  wikiSummary,
  topEvents = [],
) {
  const mm = String(MONTH_NUM_MAP[monthName]).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const kvKey = `quiz-v15:${mm}-${dd}`;

  try {
    const cached = await env.EVENTS_KV.get(kvKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      const hasTruncatedFallbackQuestion = Array.isArray(parsed?.questions)
        ? parsed.questions.some((q) => {
            const text = String(q?.q || "");
            return (
              /^In which year did\s+"/i.test(text) &&
              (text.includes("…") || /\.\.\./.test(text))
            );
          })
        : false;

      if (!hasTruncatedFallbackQuestion) {
        return parsed;
      }
    }
  } catch (e) {
    // ignore cache miss errors
  }

  const mDisplay = MONTH_DISPLAY_NAMES[MONTH_NUM_MAP[monthName]];
  const births = eventsData?.births || [];

  // Use topEvents if provided (same order as carousel slides), else fall back to raw events
  const indexedEvents =
    topEvents.length > 0 ? topEvents : (eventsData?.events || []).slice(0, 5);

  const contextLines = [];
  if (featuredEvent) contextLines.push(`Featured event: ${featuredEvent.text}`);
  if (wikiSummary)
    contextLines.push(
      `Wikipedia context: ${wikiSummary.replace(/\b(1[0-9]{3}|20[0-2][0-9])\b/g, "").substring(0, 300)}`,
    );
  indexedEvents.forEach((e, i) =>
    contextLines.push(`Event[${i}]: ${e.text.substring(0, 150)}`),
  );
  births
    .slice(0, 3)
    .forEach((b) => contextLines.push(`Birth: ${b.text.substring(0, 100)}`));

  let quiz = null;

  if ((env.AI || env.GROQ_API_KEY) && contextLines.length > 0) {
    try {
      const raw = await callAI(
        env,
        [
          {
            role: "system",
            content:
              "You are a history quiz creator. Always respond with valid JSON only, no markdown, no extra text.",
          },
          {
            role: "user",
            content: `Generate a 5-question multiple choice quiz about historical events on ${mDisplay} ${day}.\n\nThe user can already READ the following event descriptions on screen — treat these as VISIBLE TO USER:\n${contextLines.join("\n")}\n\n#1 RULE — NO VISIBLE ANSWERS: Every question's correct answer must require knowledge that is NOT stated in the event description above. If a user can answer by reading the event text, the question is INVALID.\n\nGood question types (answer requires historical knowledge beyond the description):\n- What caused this event / what triggered it\n- What happened as a direct consequence or aftermath\n- Who was the key leader, commander, or decision-maker involved\n- What was the death toll, scale, or magnitude\n- What agreement, treaty, or legislation resulted\n- What country or organization was directly responsible\n- What prior event led to this one\n\nFORBIDDEN question types (answer visible in event text or trivially known):\n- Where did it happen (location often in the title)\n- In which year / what year / when (year is shown on screen)\n- What is the name of the event (it's in the title)\n\nRules:\n- Exactly 5 questions, one per event: Q1 about Event[0], Q2 about Event[1], Q3 about Event[2], Q4 about Event[3], Q5 about Event[4]\n- Each question has exactly 4 options\n- Exactly one correct answer (0-based index "answer", must be 0–3)\n- All 4 options must be plausible — wrong options should be real historical alternatives, not obvious nonsense\n- Each question needs an "explanation" (1-2 sentences) stating why the answer is correct\n- "topic" = 5 words or fewer naming the event\n- "sourceEvent" = full event text\n- Output ONLY valid JSON:\n{"topic":"string","sourceEvent":"string","questions":[{"q":"Question?","options":["A","B","C","D"],"answer":0,"explanation":"Why correct."}]}`,
          },
        ],
        { maxTokens: 1500, timeoutMs: 12_000 },
      );
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "")
        .trim();
      const objMatch = cleaned.match(/\{[\s\S]*\}/);
      if (objMatch) {
        const parsed = JSON.parse(objMatch[0]);
        const eventCount = Math.min(indexedEvents.length, 5);
        if (
          Array.isArray(parsed?.questions) &&
          parsed.questions.length === eventCount
        ) {
          // All-or-nothing: every question must be valid and correspond to an event
          const valid = parsed.questions.filter(
            (q) =>
              q.q &&
              String(q.q).length > 15 &&
              Array.isArray(q.options) &&
              q.options.length === 4 &&
              q.options.every((o) => o && String(o).length > 2) &&
              typeof q.answer === "number" &&
              q.answer >= 0 &&
              q.answer <= 3 &&
              q.explanation &&
              String(q.explanation).length > 8,
          );
          if (valid.length === eventCount) {
            // Hard filter: reject the entire quiz if ANY question asks about a year/date
            // — the AI ignores prompt instructions, so we enforce this deterministically
            const yearPattern =
              /\b(in which year|what year|when did|which year|what century|what decade|in \d{3,4}|since \d{3,4})\b/i;
            const hasYearQuestion = valid.some((q) =>
              yearPattern.test(String(q.q)),
            );
            if (!hasYearQuestion) quiz = { ...parsed, questions: valid };
          }
        }
      }
    } catch (e) {
      console.error("Quiz AI generation failed:", e);
    }
  }

  if (!quiz) quiz = buildFallbackQuiz(mDisplay, day, eventsData, indexedEvents);

  try {
    await env.EVENTS_KV.put(kvKey, JSON.stringify(quiz), {
      expirationTtl: 24 * 60 * 60,
    });
  } catch (e) {
    // ignore storage error
  }

  return quiz;
}

function buildFallbackQuiz(mDisplay, day, eventsData, orderedEvents = []) {
  // Use orderedEvents (topEvents order = same as carousel) when available, else fall back to raw Wikipedia order
  const source =
    orderedEvents.length > 0 ? orderedEvents : eventsData?.events || [];
  const events = source.filter((e) => e.year && e.text);
  const questions = [];

  // Fallback question templates that don't require knowing the year
  const fallbackTemplates = [
    (text) => ({
      q: `Which of the following best describes what happened on ${mDisplay} ${day}?`,
      opts: [
        text,
        "A royal coronation ceremony",
        "A scientific moon landing",
        "A major peace treaty signing",
      ],
      ans: 0,
    }),
    (text) => ({
      q: `On ${mDisplay} ${day}, a notable event occurred. Which description matches it?`,
      opts: [
        "A volcanic eruption in Iceland",
        text,
        "The founding of the United Nations",
        "A major earthquake in Japan",
      ],
      ans: 1,
    }),
    (text) => ({
      q: `Which event took place on ${mDisplay} ${day} in history?`,
      opts: [
        "Discovery of penicillin",
        "Fall of the Berlin Wall",
        text,
        "First commercial flight",
      ],
      ans: 2,
    }),
    (text) => ({
      q: `Historians remember ${mDisplay} ${day} for which of the following?`,
      opts: [
        "First Moon walk by astronauts",
        "Signing of the Magna Carta",
        "Launch of the first satellite",
        text,
      ],
      ans: 3,
    }),
    (text) => ({
      q: `What significant event is recorded on ${mDisplay} ${day}?`,
      opts: [
        "Opening of the Suez Canal",
        text,
        "End of World War I",
        "First transatlantic telegraph cable",
      ],
      ans: 1,
    }),
  ];

  for (
    let i = 0;
    i < Math.min(events.slice(0, 5).length, fallbackTemplates.length);
    i++
  ) {
    const e = events[i];
    const shortText = String(e.text || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.\s]+$/, "")
      .substring(0, 80);
    const tmpl = fallbackTemplates[i](shortText);
    questions.push({ q: tmpl.q, options: tmpl.opts, answer: tmpl.ans });
  }

  const genericPad = [
    {
      q: `How many days does ${mDisplay} typically have?`,
      options: ["28 or 29", "30", "31", "27"],
      answer: ["April", "June", "September", "November"].includes(mDisplay)
        ? 1
        : mDisplay === "February"
          ? 0
          : 2,
    },
    {
      q: `${mDisplay} is which month of the year?`,
      options: ["1st–3rd", "4th–6th", "7th–9th", "10th–12th"],
      answer: [1, 2, 3].includes(MONTH_NUM_MAP[mDisplay?.toLowerCase?.()] ?? 0)
        ? 0
        : [4, 5, 6].includes(MONTH_NUM_MAP[mDisplay?.toLowerCase?.()] ?? 0)
          ? 1
          : [7, 8, 9].includes(MONTH_NUM_MAP[mDisplay?.toLowerCase?.()] ?? 0)
            ? 2
            : 3,
    },
    {
      q: "Which hemisphere experiences winter in December?",
      options: ["Northern", "Southern", "Both", "Neither"],
      answer: 0,
    },
    {
      q: "What does 'A.D.' stand for in historical dates?",
      options: ["After Death", "Anno Domini", "Ancient Days", "Annual Date"],
      answer: 1,
    },
    {
      q: "Which calendar system is most widely used for modern historical dating?",
      options: ["Julian", "Gregorian", "Hebrew", "Islamic"],
      answer: 1,
    },
  ];

  let padIdx = 0;
  while (questions.length < 5) {
    questions.push(genericPad[padIdx % genericPad.length]);
    padIdx++;
  }

  return { questions: questions.slice(0, 5) };
}

function buildQuizHTML(quiz, monthDisplay, day) {
  if (!quiz?.questions?.length) return "";

  const questionsHtml = quiz.questions
    .map((q, qi) => {
      const optsHtml = (q.options || [])
        .map(
          (opt, oi) =>
            `<div class="tdq-opt" data-qi="${qi}" data-oi="${oi}" role="radio" aria-checked="false" tabindex="0">` +
            `<span class="tdq-opt-key">${String.fromCharCode(65 + oi)}</span>${escapeHtml(String(opt))}` +
            `</div>`,
        )
        .join("");
      return (
        `<div class="tdq-question" id="tdq-q-${qi}">` +
        `<p class="tdq-q-text"><strong>${qi + 1}.</strong> ${escapeHtml(String(q.q))}</p>` +
        `<div class="tdq-options">${optsHtml}</div>` +
        `<div class="tdq-feedback" id="tdq-f-${qi}" hidden></div>` +
        (q.explanation
          ? `<div class="tdq-explanation" id="tdq-e-${qi}" hidden>${escapeHtml(String(q.explanation))}</div>`
          : "") +
        `</div>`
      );
    })
    .join("");

  const answersJson = JSON.stringify(
    quiz.questions.map((q) => Number(q.answer)),
  );

  return (
    `<div class="card-box" id="tdq-widget">` +
    `<h2 class="h4 mb-3"><i class="bi bi-patch-question-fill me-2" style="color:var(--accent,#9dc43a)"></i>Test Your Knowledge — ${escapeHtml(monthDisplay)} ${day}</h2>` +
    `<p class="text-muted mb-2" style="font-size:15px">How well do you know the history of ${escapeHtml(monthDisplay)} ${day}? Answer these 5 questions to find out.</p>` +
    `<a href="/quiz/${escapeHtml(monthDisplay.toLowerCase())}/${day}/" class="site-btn mb-3"><i class="bi bi-list-check"></i>Full quiz page</a>` +
    `<div id="tdq-questions">${questionsHtml}</div>` +
    `<div id="tdq-score" class="mt-3" hidden></div>` +
    `</div>` +
    `<script>(function(){` +
    `var answers=${answersJson};` +
    `var selected={};` +
    `var graded=false;` +
    `function grade(){` +
    `if(graded)return;` +
    `graded=true;` +
    `var score=0;` +
    `answers.forEach(function(correct,qi){` +
    `var chosen=selected[qi]!==undefined?selected[qi]:-1;` +
    `var fb=document.getElementById('tdq-f-'+qi);` +
    `var opts=document.querySelectorAll('[data-qi="'+qi+'"]');` +
    `fb.hidden=false;` +
    `opts.forEach(function(o){o.style.pointerEvents='none';});` +
    `opts[correct].classList.add('tdq-opt-correct');` +
    `if(chosen===correct){score++;fb.innerHTML='<span class="tdq-correct">✓ Correct!</span>';}` +
    `else{if(chosen>=0)opts[chosen].classList.add('tdq-opt-wrong');` +
    `fb.innerHTML='<span class="tdq-wrong">✗ Incorrect.</span> Correct answer: <strong>'+String.fromCharCode(65+correct)+'</strong>';}` +
    `var exp=document.getElementById('tdq-e-'+qi);if(exp)exp.hidden=false;` +
    `});` +
    `var pct=Math.round(score/answers.length*100);` +
    `var msg=pct===100?'Perfect score!':pct>=80?'Excellent!':pct>=60?'Good job!':'Keep learning!';` +
    `var el=document.getElementById('tdq-score');` +
    `el.hidden=false;` +
    `el.innerHTML='<div class="tdq-score-box">You scored <span class="tdq-score-num">'+score+'/'+answers.length+'</span> ('+pct+'%) — '+msg+'</div>';` +
    `}` +
    `document.querySelectorAll('.tdq-opt').forEach(function(opt){` +
    `opt.addEventListener('click',function(){` +
    `var qi=parseInt(this.dataset.qi),oi=parseInt(this.dataset.oi);` +
    `selected[qi]=oi;` +
    `document.querySelectorAll('[data-qi="'+qi+'"]').forEach(function(o){o.classList.remove('tdq-opt-selected');o.setAttribute('aria-checked','false');});` +
    `this.classList.add('tdq-opt-selected');this.setAttribute('aria-checked','true');` +
    `if(Object.keys(selected).length===answers.length)grade();` +
    `});` +
    `});` +
    `})();</script>`
  );
}

// ---------------------------------------------------------------------------
// Carousel quiz page builder — one event + one question per slide
// ---------------------------------------------------------------------------
function buildCarouselQuizHTML(
  quiz,
  topEvents,
  _monthDisplay,
  day,
  monthSlug,
  nextMonthSlug,
  nextDay,
  blogEntry = null,
) {
  if (!quiz?.questions?.length)
    return "<p class='text-muted'>Quiz unavailable for this date.</p>";

  const answers = quiz.questions.map((q) => Number(q.answer));
  const answersJson = JSON.stringify(answers);
  const total = Math.min(quiz.questions.length, 5);

  // Blog post mode: same image + link for all slides
  const blogImgSrc = blogEntry?.imageUrl || "";
  const blogTitle = blogEntry?.title || "";
  const blogUrl = blogEntry ? `/blog/${blogEntry.slug}/` : "";

  // Build slides — one per question
  const slidesHtml = quiz.questions
    .slice(0, total)
    .map((q, qi) => {
      // When blog post quiz: use blog image for all slides; otherwise use per-event images
      const imgSrc = blogEntry
        ? blogImgSrc
        : topEvents[qi]?.pages?.[0]?.thumbnail?.source ||
          topEvents[0]?.pages?.[0]?.thumbnail?.source ||
          "";
      const imgAlt = blogEntry
        ? blogTitle
        : topEvents[qi]?.pages?.[0]?.title || "";
      const evYear = blogEntry
        ? ""
        : topEvents[qi]?.year
          ? String(topEvents[qi].year)
          : "";
      const readMoreUrl = blogEntry
        ? blogUrl
        : topEvents[qi]?.pages?.[0]?.content_urls?.desktop?.page ||
          `/events/${escapeHtml(monthSlug)}/${day}/`;
      const readMoreTarget =
        blogEntry || !topEvents[qi]?.pages?.[0]?.content_urls?.desktop?.page
          ? "_self"
          : "_blank";

      const imgHtml = imgSrc
        ? `<div class="qsc-img-wrap"><img src="${escapeHtml(imgSrc)}" alt="${escapeHtml(imgAlt)}" class="qsc-event-img" loading="${qi === 0 ? "eager" : "lazy"}"/><div class="qsc-img-overlay"></div>${evYear ? `<span class="qsc-year-pill">${escapeHtml(evYear)}</span>` : ""}</div>`
        : `<div class="qsc-img-wrap qsc-img-placeholder"><div class="qsc-img-overlay"></div>${evYear ? `<span class="qsc-year-pill">${escapeHtml(evYear)}</span>` : ""}</div>`;

      const readMoreHtml = `<a href="${escapeHtml(readMoreUrl)}" target="${readMoreTarget}" rel="noopener" class="btn qsc-read-more-btn"><i class="bi bi-book me-1"></i>Don't know? Read more</a>`;

      const optsHtml = (q.options || [])
        .map(
          (opt, oi) =>
            `<div class="tdq-opt qsc-opt" data-qi="${qi}" data-oi="${oi}" role="radio" aria-checked="false" tabindex="0">` +
            `<span class="tdq-opt-key">${String.fromCharCode(65 + oi)}</span>${escapeHtml(String(opt))}` +
            `</div>`,
        )
        .join("");

      const expHtml = q.explanation
        ? `<div class="tdq-explanation qsc-explanation" id="tdq-e-${qi}" hidden>${escapeHtml(String(q.explanation))}</div>`
        : "";

      return (
        `<div class="qsc-slide${qi === 0 ? " qsc-active" : ""}" data-slide="${qi}" id="qsc-slide-${qi}">` +
        imgHtml +
        `<div class="qsc-slide-body" id="qsc-body-${qi}">` +
        `<div class="qsc-q-label"><i class="bi bi-patch-question-fill me-1" style="color:var(--accent,#9dc43a)"></i>Question ${qi + 1} of ${total}</div>` +
        `<p class="tdq-q-text qsc-q-text">${escapeHtml(String(q.q))}</p>` +
        `<div class="tdq-options qsc-opts-wrap">${optsHtml}</div>` +
        readMoreHtml +
        `<div class="tdq-feedback qsc-feedback" id="tdq-f-${qi}" hidden></div>` +
        expHtml +
        `<button class="qsc-next-btn" id="qsc-next-${qi}" data-slide="${qi}" hidden>` +
        (qi < total - 1
          ? `Next Question <i class="bi bi-arrow-right"></i>`
          : `See Results <i class="bi bi-trophy-fill"></i>`) +
        `</button>` +
        `</div></div>`
      );
    })
    .join("");

  // Final score slide
  const nextLink =
    nextMonthSlug && nextDay
      ? `<a href="/quiz/${escapeHtml(nextMonthSlug)}/${nextDay}/" class="qsc-cta-btn qsc-cta-primary"><i class="bi bi-arrow-left-circle"></i>Previous Day's Quiz</a>`
      : "";
  const scoreSlide =
    `<div class="qsc-slide qsc-final-slide" data-slide="${total}" id="qsc-slide-${total}">` +
    `<div class="qsc-final-body">` +
    `<div class="qsc-trophy-wrap"><i class="bi bi-trophy-fill qsc-trophy-icon"></i></div>` +
    `<div class="tdq-score-box qsc-final-score" id="qsc-final-score">` +
    `You scored <span class="tdq-score-num" id="qsc-score-num">0/${total}</span> — <span id="qsc-msg">Keep learning!</span>` +
    `</div>` +
    `<div class="qsc-review-list" id="qsc-review-list"></div>` +
    `<div class="qsc-cta-row">` +
    `<a href="/events/${escapeHtml(monthSlug)}/${day}/" class="qsc-cta-btn"><i class="bi bi-calendar-event"></i>See All Events</a>` +
    `<a href="/blog/" class="qsc-cta-btn"><i class="bi bi-journal-text"></i>Read the Blog</a>` +
    nextLink +
    `</div></div></div>`;

  // Progress dots
  const dotsHtml = Array.from(
    { length: total },
    (_, i) =>
      `<button class="qsc-dot${i === 0 ? " qsc-dot-active" : ""}" data-dot="${i}" aria-label="Question ${i + 1}" title="Q${i + 1}"></button>`,
  ).join("");

  return (
    // Progress bar + dots
    `<div class="qsc-progress-wrap">` +
    `<div class="qsc-progress-track"><div class="qsc-progress-fill" id="qsc-bar" style="width:0%"></div></div>` +
    `<div class="qsc-dots-row">${dotsHtml}</div>` +
    `<p class="qsc-progress-label" id="qsc-progress-label">Question 1 of ${total}</p>` +
    `</div>` +
    // Back button
    `<div class="qsc-nav-row">` +
    `<button id="qsc-prev" class="qsc-back-btn" disabled><i class="bi bi-arrow-left"></i> Back</button>` +
    `<span class="qsc-hint" id="qsc-hint">Select an answer to continue</span>` +
    `</div>` +
    // Carousel
    `<div id="qsc-wrapper">${slidesHtml}${scoreSlide}</div>` +
    // Inline script
    `<script>(function(){` +
    `var answers=${answersJson};` +
    `var total=${total};` +
    `var cur=0;` +
    `var selected={};` +
    `var results={};` +
    `var score=0;` +
    // Show slide
    `function showSlide(n,noScroll){` +
    `document.querySelectorAll('.qsc-slide').forEach(function(s){s.classList.remove('qsc-active');});` +
    `var s=document.getElementById('qsc-slide-'+n);if(s)s.classList.add('qsc-active');` +
    `cur=n;updateProgress(n);` +
    `document.getElementById('qsc-prev').disabled=(n===0);` +
    `if(!noScroll){var b=document.getElementById('qsc-body-'+n);if(b)setTimeout(function(){b.scrollIntoView({behavior:'smooth',block:'start'});},80);}` +
    `}` +
    // Update progress
    `function updateProgress(n){` +
    `var pct=Math.round((n/total)*100);` +
    `document.getElementById('qsc-bar').style.width=pct+'%';` +
    `var lbl=document.getElementById('qsc-progress-label');` +
    `if(n<total){lbl.textContent='Question '+(n+1)+' of '+total;}else{lbl.textContent='Quiz complete!';document.getElementById('qsc-bar').style.width='100%';}` +
    `document.querySelectorAll('.qsc-dot').forEach(function(d,i){` +
    `d.classList.remove('qsc-dot-active','qsc-dot-done','qsc-dot-wrong');` +
    `if(i===n)d.classList.add('qsc-dot-active');` +
    `else if(results[i]===true)d.classList.add('qsc-dot-done');` +
    `else if(results[i]===false)d.classList.add('qsc-dot-wrong');` +
    `});` +
    `}` +
    // Handle option click
    `document.querySelectorAll('.qsc-opt').forEach(function(opt){` +
    `opt.addEventListener('click',function(){` +
    `var qi=parseInt(this.dataset.qi),oi=parseInt(this.dataset.oi);` +
    `if(selected[qi]!==undefined)return;` +
    `selected[qi]=oi;` +
    `document.querySelectorAll('[data-qi="'+qi+'"]').forEach(function(o){o.classList.remove('tdq-opt-selected');o.setAttribute('aria-checked','false');});` +
    `this.classList.add('tdq-opt-selected');this.setAttribute('aria-checked','true');` +
    `setTimeout(function(){evaluate(qi);},280);` +
    `});` +
    `});` +
    // Evaluate answer
    `function evaluate(qi){` +
    `var chosen=selected[qi];var correct=answers[qi];` +
    `var opts=document.querySelectorAll('[data-qi="'+qi+'"]');` +
    `var fb=document.getElementById('tdq-f-'+qi);` +
    `var exp=document.getElementById('tdq-e-'+qi);` +
    `opts.forEach(function(o){o.style.pointerEvents='none';});` +
    `opts[correct].classList.add('tdq-opt-correct');` +
    `if(chosen===correct){score++;results[qi]=true;fb.innerHTML='<span class="tdq-correct"><i class="bi bi-check-circle-fill me-1"></i>Correct!</span>';}` +
    `else{results[qi]=false;if(chosen>=0&&opts[chosen])opts[chosen].classList.add('tdq-opt-wrong');fb.innerHTML='<span class="tdq-wrong"><i class="bi bi-x-circle-fill me-1"></i>Incorrect.</span> Correct: <strong>'+String.fromCharCode(65+correct)+'</strong>';}` +
    `fb.hidden=false;if(exp)exp.hidden=false;` +
    `var nb=document.getElementById('qsc-next-'+qi);if(nb){nb.hidden=false;setTimeout(function(){nb.scrollIntoView({behavior:'smooth',block:'end'});},80);}` +
    `document.getElementById('qsc-hint').textContent='';` +
    `updateProgress(cur);` +
    `}` +
    // Next buttons
    `document.querySelectorAll('.qsc-next-btn').forEach(function(btn){` +
    `btn.addEventListener('click',function(){` +
    `var next=parseInt(this.dataset.slide)+1;` +
    `showSlide(next);` +
    `if(next===total)showFinal();` +
    `document.getElementById('qsc-hint').textContent=next<total?'Select an answer to continue':'';` +
    `});` +
    `});` +
    // Dot nav
    `document.querySelectorAll('.qsc-dot').forEach(function(d){` +
    `d.addEventListener('click',function(){` +
    `var i=parseInt(this.dataset.dot);` +
    `if(results[i]!==undefined||i<cur)showSlide(i);` +
    `});` +
    `});` +
    // Back button
    `document.getElementById('qsc-prev').addEventListener('click',function(){if(cur>0)showSlide(cur-1);});` +
    // Touch swipe
    `var tx=0;` +
    `var wrap=document.getElementById('qsc-wrapper');` +
    `wrap.addEventListener('touchstart',function(e){tx=e.touches[0].clientX;},{passive:true});` +
    `wrap.addEventListener('touchend',function(e){` +
    `var dx=e.changedTouches[0].clientX-tx;` +
    `if(dx<-40&&results[cur]!==undefined){var nb=document.querySelector('.qsc-next-btn[data-slide="'+cur+'"]');if(nb)nb.click();}` +
    `if(dx>40&&cur>0)showSlide(cur-1);` +
    `},{passive:true});` +
    // Final score
    `function showFinal(){` +
    `var pct=Math.round((score/total)*100);` +
    `var msg=pct===100?'Perfect score! \uD83C\uDF89':pct>=80?'Excellent work!':pct>=60?'Good job!':'Keep exploring!';` +
    `document.getElementById('qsc-score-num').textContent=score+'/'+total;` +
    `document.getElementById('qsc-msg').textContent=msg;` +
    `var rev='';` +
    `for(var i=0;i<total;i++){var ok=results[i];rev+='<div class="qsc-rev-item"><span class="'+(ok?'tdq-correct':'tdq-wrong')+'">'+(ok?'<i class=\"bi bi-check-circle-fill\"></i>':'<i class=\"bi bi-x-circle-fill\"></i>')+'</span><span>Q'+(i+1)+': '+(ok?'Correct':'Incorrect')+'</span></div>';}` +
    `document.getElementById('qsc-review-list').innerHTML=rev;` +
    `if(pct>=60)confetti();` +
    `}` +
    // Confetti
    `function confetti(){` +
    `var c=document.createElement('canvas');` +
    `c.style='position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999';` +
    `document.body.appendChild(c);` +
    `c.width=innerWidth;c.height=innerHeight;` +
    `var ctx=c.getContext('2d');` +
    `var cols=['#1a1a1a','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4'];` +
    `var pts=[];` +
    `for(var i=0;i<90;i++)pts.push({x:Math.random()*c.width,y:Math.random()*-c.height*.6,r:3+Math.random()*6,` +
    `col:cols[i%cols.length],vx:(Math.random()-.5)*4,vy:3+Math.random()*5,a:1,rot:Math.random()*360,rv:(Math.random()-.5)*8});` +
    `var fr=0;` +
    `function draw(){ctx.clearRect(0,0,c.width,c.height);` +
    `pts.forEach(function(p){ctx.save();ctx.globalAlpha=p.a;ctx.fillStyle=p.col;ctx.translate(p.x,p.y);ctx.rotate(p.rot*Math.PI/180);ctx.fillRect(-p.r/2,-p.r/2,p.r,p.r);ctx.restore();` +
    `p.x+=p.vx;p.y+=p.vy;p.rot+=p.rv;p.a-=.011;});` +
    `fr++;if(fr<130)requestAnimationFrame(draw);else c.remove();}` +
    `requestAnimationFrame(draw);}` +
    `showSlide(0,true);` +
    `})();</script>`
  );
}

async function handleQuizPage(_request, env, monthSlug, day) {
  const monthNum = MONTH_NUM_MAP[monthSlug];
  if (!monthNum || isNaN(day) || day < 1 || day > DAYS_IN_MONTH[monthNum - 1]) {
    return new Response("Not Found", { status: 404 });
  }

  const mDisplay = MONTH_DISPLAY_NAMES[monthNum];
  const mPad = String(monthNum).padStart(2, "0");
  const dPad = String(day).padStart(2, "0");

  // Full-page HTML cache (set by cron or previous visit)
  const pageHtmlKey = `quiz-page-v30:${mPad}-${dPad}`;
  if (env.EVENTS_KV) {
    try {
      const cachedHtml = await env.EVENTS_KV.get(pageHtmlKey);
      if (cachedHtml) {
        return new Response(cachedHtml, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=1800, s-maxage=3600",
            "X-Cache": "HIT",
          },
        });
      }
    } catch (_) {
      /* ignore */
    }
  }

  // --- Blog post quiz for this date (primary source) ---
  let blogQuiz = null;
  let blogEntry = null;
  if (env.BLOG_AI_KV) {
    const curYear = new Date().getUTCFullYear();
    for (const yr of [curYear, curYear - 1]) {
      try {
        const bSlug = `${day}-${monthSlug}-${yr}`;
        const raw = await env.BLOG_AI_KV.get(`quiz-v3:blog:${bSlug}`);
        if (raw) {
          blogQuiz = JSON.parse(raw);
          const indexRaw = await env.BLOG_AI_KV.get("index");
          const idx = indexRaw ? JSON.parse(indexRaw) : [];
          blogEntry = idx.find((e) => e.slug === bSlug) || {
            slug: bSlug,
            title: `${mDisplay} ${day}`,
            imageUrl: null,
          };
          break;
        }
      } catch (_) {
        /* ignore */
      }
    }
  }

  // Events data: try KV first, fall back to Wikipedia API
  const eventsKvKey = `events-data:${mPad}-${dPad}`;
  const todayIso = new Date().toISOString().split("T")[0];
  const todayEventsKey = `today-events-${todayIso}`;
  let eventsData = { events: [], births: [], deaths: [] };
  let eventsFromKv = false;
  if (env.EVENTS_KV) {
    try {
      const isToday =
        mPad ===
          String(MONTH_NUM_MAP[MONTHS_ALL[new Date().getUTCMonth()]]).padStart(
            2,
            "0",
          ) && dPad === String(new Date().getUTCDate()).padStart(2, "0");
      const kvData =
        (await env.EVENTS_KV.get(eventsKvKey, { type: "json" })) ||
        (isToday
          ? await env.EVENTS_KV.get(todayEventsKey, { type: "json" })
          : null);
      if (kvData?.events?.length) {
        eventsData = kvData;
        eventsFromKv = true;
      }
    } catch (_) {
      /* ignore */
    }
  }
  if (!eventsFromKv) {
    const apiUrl = `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/all/${mPad}/${dPad}`;
    try {
      const r = await fetch(apiUrl, {
        headers: { "User-Agent": WIKIPEDIA_USER_AGENT },
      });
      if (r.ok) {
        eventsData = await r.json();
        if (env.EVENTS_KV && eventsData?.events?.length) {
          try {
            await env.EVENTS_KV.put(eventsKvKey, JSON.stringify(eventsData), {
              expirationTtl: 7 * 24 * 60 * 60,
            });
          } catch (_) {
            /* non-fatal */
          }
        }
      }
    } catch (e) {
      console.error("Quiz page Wikipedia fetch:", e);
    }
  }

  const featuredEvent =
    eventsData?.events?.find((e) => e.pages?.[0]?.thumbnail?.source) ||
    eventsData?.events?.[0] ||
    null;
  const wikiTitle = featuredEvent ? pickRelevantWikiTitle(featuredEvent) : "";
  const wikiSummary = wikiTitle
    ? await fetchWikipediaSummaryByTitle(wikiTitle)
    : "";

  // Gather top events with images for carousel slides (images-first order)
  const topEvents = [];
  const evAll = eventsData?.events || [];
  for (const e of evAll) {
    if (e.pages?.[0]?.thumbnail?.source && topEvents.length < 5)
      topEvents.push(e);
  }
  for (const e of evAll) {
    if (!e.pages?.[0]?.thumbnail?.source && topEvents.length < 5)
      topEvents.push(e);
  }

  const quiz =
    blogQuiz ||
    (await generateQuizForDate(
      env,
      monthSlug,
      day,
      eventsData,
      featuredEvent,
      wikiSummary,
      topEvents,
    ));

  // Previous day for CTA
  const _pd = new Date(
    Date.UTC(
      new Date().getUTCFullYear(),
      MONTH_NUM_MAP[monthSlug] - 1,
      day - 1,
    ),
  );
  const nextMonthSlug = MONTHS_ALL[_pd.getUTCMonth()];
  const nextDay = _pd.getUTCDate();

  const carouselHtml = buildCarouselQuizHTML(
    quiz,
    topEvents,
    mDisplay,
    day,
    monthSlug,
    nextMonthSlug,
    nextDay,
    blogEntry,
  );

  // Adjacent quiz days: up to 6 past days (no future dates)
  const todayUTC = new Date();
  todayUTC.setUTCHours(0, 0, 0, 0);
  const adjDays = [];
  for (let offset = -1; offset >= -6; offset--) {
    const d = new Date(
      Date.UTC(new Date().getUTCFullYear(), monthNum - 1, day + offset),
    );
    if (d > todayUTC) continue; // skip future dates
    const mSlug = MONTHS_ALL[d.getUTCMonth()];
    adjDays.push({
      monthSlug: mSlug,
      monthDisplay: MONTH_DISPLAY_NAMES[MONTH_NUM_MAP[mSlug]],
      day: d.getUTCDate(),
      mPad: String(d.getUTCMonth() + 1).padStart(2, "0"),
      dPad: String(d.getUTCDate()).padStart(2, "0"),
    });
  }
  // Fetch blog post images for adjacent days from BLOG_AI_KV index (directly tied to quiz topic)
  const blogIndex = env.BLOG_AI_KV
    ? await env.BLOG_AI_KV.get("index", { type: "json" }).catch(() => null)
    : null;
  const adjCards = adjDays.map((d) => {
    const curYear = new Date().getUTCFullYear();
    const blogEntry2 =
      (blogIndex || []).find(
        (e) => e.slug === `${d.day}-${d.monthSlug}-${curYear}`,
      ) ||
      (blogIndex || []).find(
        (e) => e.slug === `${d.day}-${d.monthSlug}-${curYear - 1}`,
      );
    const thumb = blogEntry2?.imageUrl || null;
    const imgHtml = thumb
      ? `<img src="${escapeHtml(thumb)}" alt="${escapeHtml(d.monthDisplay)} ${d.day}" class="qsc-rec-img" loading="lazy"/>`
      : "";
    return (
      `<a href="/quiz/${escapeHtml(d.monthSlug)}/${d.day}/" class="qsc-rec-card" aria-label="${escapeHtml(d.monthDisplay)} ${d.day} quiz">` +
      `<div class="qsc-rec-img-wrap">${imgHtml}<div class="qsc-rec-overlay"></div><span class="qsc-rec-badge">Quiz</span></div>` +
      `<div class="qsc-rec-body"><div class="qsc-rec-date">${escapeHtml(d.monthDisplay)} ${d.day}</div><div class="qsc-rec-lbl">5 questions</div></div>` +
      `</a>`
    );
  });
  const recSliderHtml =
    `<div class="mt-4 mb-2">` +
    `<h2 class="qsc-rec-heading"><i class="bi bi-calendar3-range me-2" style="color:#1a1a1a"></i>More Daily Quizzes</h2>` +
    `<div class="qsc-rec-slider">${adjCards.join("")}</div>` +
    `</div>`;

  const siteUrl = "https://thisday.info";
  const canonical = `${siteUrl}/quiz/${monthSlug}/${day}/`;
  const _d = new Date();
  const todaySlug = MONTHS_ALL[_d.getUTCMonth()];
  const todayDay = _d.getUTCDate();

  const quizPageDesc = quiz?.topic
    ? `Think you know what happened on ${mDisplay} ${day}? Take our free 5-question history quiz on ${quiz.topic} and test your knowledge of this date's defining events.`.slice(
        0,
        158,
      )
    : `Test your knowledge of historical events on ${mDisplay} ${day}. A free 5-question multiple choice quiz covering key events, people, and milestones on this date.`;

  const quizPageTitle = quiz?.topic
    ? `${mDisplay} ${day} Quiz: ${quiz.topic} | thisDay.info`
    : `${mDisplay} ${day} History Quiz — 5 Questions | thisDay.info`;

  const quizPageSchema = quiz?.questions?.length
    ? JSON.stringify({
        "@context": "https://schema.org",
        "@id": `${canonical}#quiz`,
        "@type": "Quiz",
        name: quizPageTitle.replace(" | thisDay.info", ""),
        description: quizPageDesc,
        url: canonical,
        educationalLevel: "beginner",
        learningResourceType: "quiz",
        ...(quiz.topic
          ? {
              about: {
                "@type": "Event",
                name: quiz.topic,
                description: quiz.sourceEvent || "",
              },
            }
          : {}),
        publisher: {
          "@type": "Organization",
          name: "thisday.info",
          url: siteUrl,
        },
        hasPart: quiz.questions.map((q) => ({
          "@type": "Question",
          name: q.q,
          acceptedAnswer: {
            "@type": "Answer",
            text: q.options?.[q.answer] ?? "",
          },
        })),
      }).replace(/<\//g, "<\\/")
    : null;

  const quizWebPageSchema = buildPageSchema({
    type: "WebPage",
    name: quizPageTitle.replace(" | thisDay.info", ""),
    description: quizPageDesc,
    url: canonical,
    mainEntityId: quiz?.questions?.length ? `${canonical}#quiz` : null,
    about: quiz?.topic
      ? { "@type": "Thing", name: quiz.topic }
      : { "@type": "Thing", name: `${mDisplay} ${day} history quiz` },
    mentions: buildEventMentions(topEvents),
  });

  const breadcrumbSchema = buildBreadcrumbSchema([
    { name: "Home", item: `${siteUrl}/` },
    { name: `${mDisplay} ${day} in History`, item: `${siteUrl}/events/${monthSlug}/${day}/` },
    { name: `${mDisplay} ${day} Quiz`, item: canonical },
  ]);
  const relatedBlogHtml = buildRelatedBlogCard(
    blogEntry,
    `${mDisplay} ${day} in the Blog`,
  );

  const html = `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${escapeHtml(quizPageTitle)}</title>
<link rel="canonical" href="${escapeHtml(canonical)}"/>
<meta name="robots" content="index, follow"/>
<meta name="description" content="${escapeHtml(quizPageDesc)}"/>
<meta property="og:title" content="${escapeHtml(quizPageTitle)}"/>
<meta property="og:description" content="${escapeHtml(quizPageDesc)}"/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="${escapeHtml(canonical)}"/>
<meta property="og:image" content="${featuredEvent?.pages?.[0]?.thumbnail?.source ? escapeHtml(featuredEvent.pages[0].thumbnail.source) : `https://thisday.info/images/logo.png`}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${escapeHtml(quizPageTitle)}"/>
<meta name="twitter:description" content="${escapeHtml(quizPageDesc)}"/>
<meta name="twitter:image" content="${featuredEvent?.pages?.[0]?.thumbnail?.source ? escapeHtml(featuredEvent.pages[0].thumbnail.source) : `https://thisday.info/images/logo.png`}"/>
<meta property="og:locale" content="en_US"/>
	<meta property="og:site_name" content="thisDay."/>
	<meta name="author" content="thisDay.info"/>
	<script type="application/ld+json">${quizWebPageSchema}</script>
	${quizPageSchema ? `<script type="application/ld+json">${quizPageSchema}</script>` : ""}
	<script type="application/ld+json">${breadcrumbSchema}</script>
<link rel="icon" href="/images/favicon.ico" type="image/x-icon"/>
<link rel="apple-touch-icon" sizes="180x180" href="/images/apple-touch-icon.png"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"/>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8565025017387209" crossorigin="anonymous"></script>
<style>${getSharedPageStyles()}
:root{--bg:#ffffff;--bg-alt:#f2f7f2;--text:#1a2e20;--text-muted:#5c7a65;--border:#cfe0cf;--btn-bg:#1b3a2d;--btn-text:#fff;--btn-hover:#2a4d3a;--accent:#9dc43a;--radius:4px;--shadow:0 16px 32px -8px rgba(27,58,45,.08);--cb:var(--bg);--cbr:var(--border);--tc:var(--text);--mu:var(--text-muted);--lc:var(--btn-bg);--ftc:#fff;--fb:var(--bg-alt);--badge:var(--accent)}
body{font-family:Lora,serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;flex-direction:column}
main{flex:1;padding:28px 0}
a{color:var(--lc)}.text-muted{color:var(--text-muted)!important}
.breadcrumb-item a{color:var(--lc)}.breadcrumb-item.active{color:var(--text-muted)}
/* Marquee (nav + scripts inject items; without CSS it becomes a giant text block) */
.marquee-bar{background:var(--btn-bg);color:#fff;overflow:hidden;white-space:nowrap;padding:.5rem 0;font-size:.82rem}
.marquee-track{display:inline-flex;gap:0;animation:marquee-scroll 55s linear infinite;will-change:transform}
.marquee-track:hover{animation-play-state:paused}
.marquee-item{padding:0 2.5rem;border-right:1px solid rgba(255,255,255,.2)}
.marquee-item span{color:var(--accent);font-weight:700;margin-right:.5rem}
@keyframes marquee-scroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}
/* Base quiz option styles shared with events page */
.tdq-opt{display:flex;align-items:center;gap:10px;padding:10px 14px;border:1.5px solid var(--cbr);border-radius:8px;cursor:pointer;font-size:.92rem;transition:background .15s,border-color .15s,transform .1s;user-select:none;background:var(--cb)}
.tdq-opt:hover{border-color:var(--btn-bg);background:var(--bg-alt);transform:translateX(2px)}.tdq-opt-selected{border-color:var(--btn-bg)!important;background:rgba(157,196,58,.15)!important;font-weight:500}
.tdq-opt-correct{border-color:#10b981!important;background:#d1fae5!important;color:#0f172a!important}.tdq-opt-wrong{border-color:#ef4444!important;background:#fee2e2!important;color:#0f172a!important}
.tdq-opt-key{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:#e2e8f0;font-size:.75rem;font-weight:700;flex-shrink:0}
.tdq-opt-selected .tdq-opt-key{background:var(--btn-bg);color:#fff}.tdq-opt-correct .tdq-opt-key{background:#10b981;color:#fff}.tdq-opt-wrong .tdq-opt-key{background:#ef4444;color:#fff}

.tdq-explanation{font-size:.85rem;margin-top:8px;padding:10px 14px;background:rgba(0,0,0,.07);border-left:3px solid var(--btn-bg);border-radius:0 8px 8px 0;color:var(--text);line-height:1.5}

.tdq-feedback{font-size:.88rem;margin-top:6px;font-weight:600}.tdq-correct{color:#10b981}.tdq-wrong{color:#ef4444}
.tdq-score-box{font-size:1.05rem;font-weight:600;padding:14px 18px;background:rgba(157,196,58,.1);border-radius:10px;border-left:4px solid var(--accent);text-align:left}.tdq-score-num{color:var(--accent);font-size:1.3rem}
/* === Carousel quiz layout === */
/* Progress */
.qsc-progress-wrap{text-align:center;margin-bottom:20px}
.qsc-progress-track{height:5px;background:var(--cbr);border-radius:3px;overflow:hidden;margin-bottom:12px}
.qsc-progress-fill{height:100%;background:linear-gradient(90deg,var(--btn-bg),#10b981);border-radius:3px;transition:width .4s ease}
.qsc-dots-row{display:flex;justify-content:center;gap:10px;margin-bottom:8px}
.qsc-dot{width:12px;height:12px;border-radius:50%;border:none;background:var(--cbr);cursor:pointer;padding:0;transition:all .2s;outline:none}
.qsc-dot:hover{background:#94a3b8}.qsc-dot.qsc-dot-active{background:var(--btn-bg);transform:scale(1.3)}.qsc-dot.qsc-dot-done{background:#10b981}.qsc-dot.qsc-dot-wrong{background:#ef4444}
.qsc-progress-label{font-size:13px;color:var(--mu);margin:0}
/* Nav row */
.qsc-nav-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.qsc-back-btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border:1.5px solid var(--cbr);border-radius:8px;background:transparent;font-size:15px;font-weight:400;color:var(--tc);cursor:pointer;transition:all .15s}
.qsc-back-btn:hover:not(:disabled){border-color:#1a1a1a;color:#1a1a1a}.qsc-back-btn:disabled{opacity:.35;cursor:default}
.qsc-hint{font-size:13px;color:var(--mu);font-style:italic}
/* Carousel wrapper */
#qsc-wrapper{border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.12);background:var(--cb);margin-bottom:24px}

/* Slides */
.qsc-slide{display:none;animation:qscIn .3s ease}
.qsc-slide.qsc-active{display:block}
@keyframes qscIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
/* Image area */
.qsc-img-wrap{position:relative;width:100%;height:220px;overflow:hidden;background:#1e293b}
@media(min-width:600px){.qsc-img-wrap{height:280px}}
.qsc-event-img{width:100%;height:100%;object-fit:cover;object-position:top;display:block;transition:transform .4s ease}
.qsc-slide.qsc-active .qsc-event-img{transform:scale(1.02)}
.qsc-img-placeholder{background:linear-gradient(135deg,#1e3a5f 0%,#2d1b69 100%)}
.qsc-img-overlay{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.7) 0%,rgba(0,0,0,.1) 60%,transparent 100%)}
.qsc-year-pill{position:absolute;bottom:14px;left:16px;background:var(--badge);color:#fff;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:400;letter-spacing:.04em}
/* Slide body */
.qsc-slide-body{padding:18px 20px 22px;scroll-margin-top:60px}
@media(min-width:600px){.qsc-slide-body{padding:22px 28px 28px}}
.qsc-read-more-btn{display:inline-flex;align-items:center;gap:6px;margin:10px 0 14px;padding:6px 14px;border:1.5px solid rgba(0,0,0,.35);border-radius:20px;font-size:15px;font-weight:400;color:#1a1a1a;text-decoration:none;transition:all .2s;background:rgba(0,0,0,.06)}
.qsc-read-more-btn:hover{background:rgba(0,0,0,.14);border-color:#1a1a1a;color:#1a1a1a;text-decoration:none}
.qsc-q-label{display:inline-flex;align-items:center;font-size:13px;font-weight:400;text-transform:uppercase;letter-spacing:.08em;color:var(--badge);margin-bottom:10px}
.qsc-q-text{font-size:1.05rem;font-weight:700;color:var(--tc);margin-bottom:14px;line-height:1.45}
.qsc-opts-wrap{display:flex;flex-direction:column;gap:9px}
/* Next button */
.qsc-next-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;margin-top:18px;padding:12px;background:var(--btn-bg);color:var(--btn-text);border:none;border-radius:10px;font-size:15px;font-weight:400;cursor:pointer;transition:background .15s,transform .1s;animation:qscIn .25s ease}
.qsc-next-btn:hover{background:var(--btn-hover);transform:translateY(-1px)}
.
/* Final score slide */
.qsc-final-slide .qsc-final-body{padding:32px 24px;text-align:center}
.qsc-trophy-wrap{margin-bottom:18px}
.qsc-trophy-icon{font-size:3.5rem;color:var(--accent);animation:qscPop .5s cubic-bezier(.34,1.56,.64,1)}
@keyframes qscPop{from{transform:scale(0);opacity:0}to{transform:scale(1);opacity:1}}
.qsc-final-score{font-size:1.1rem;font-weight:600;text-align:left;margin-bottom:18px}
.qsc-review-list{text-align:left;border:1px solid var(--cbr);border-radius:10px;overflow:hidden;margin-bottom:22px}
.qsc-rev-item{display:flex;align-items:center;gap:10px;padding:10px 14px;font-size:.9rem;border-bottom:1px solid var(--cbr)}.qsc-rev-item:last-child{border-bottom:none}
.qsc-cta-row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.qsc-cta-btn{display:inline-flex;align-items:center;gap:7px;padding:10px 18px;border-radius:8px;font-size:15px;font-weight:400;text-decoration:none;border:1.5px solid var(--cbr);color:var(--tc);background:var(--cb);transition:all .15s}
.qsc-cta-btn:hover{border-color:#1a1a1a;color:#1a1a1a;transform:translateY(-1px)}
.qsc-cta-primary{background:var(--badge);color:#fff!important;border-color:var(--badge)}
.qsc-cta-primary:hover{background:#a03508;border-color:#a03508;color:#fff!important}
/* Page header */
.qsc-page-header{text-align:center;padding:8px 0 24px;border-bottom:1px solid var(--cbr);margin-bottom:28px}
.qsc-page-header h1{font-size:1.7rem;font-weight:800;color:var(--tc);margin-bottom:6px}
.qsc-page-header p{color:var(--mu);font-size:.95rem;margin:0}
/* Recommended quizzes slider */
.qsc-rec-heading{font-size:1rem;font-weight:700;color:var(--tc);margin-bottom:12px}
.qsc-rec-slider{display:flex;gap:12px;overflow-x:auto;padding-bottom:8px;scrollbar-width:thin;-webkit-overflow-scrolling:touch}.qsc-rec-slider::-webkit-scrollbar{height:4px}.qsc-rec-slider::-webkit-scrollbar-thumb{background:var(--cbr);border-radius:2px}
.qsc-rec-card{flex:0 0 130px;text-decoration:none;border-radius:12px;overflow:hidden;border:1.5px solid var(--cbr);background:var(--cb);transition:transform .15s,border-color .15s;display:block}
.qsc-rec-card:hover{transform:translateY(-3px);border-color:#1a1a1a;text-decoration:none}
.qsc-rec-img-wrap{height:82px;overflow:hidden;position:relative;background:linear-gradient(135deg,#1e3a5f 0%,#2d1b69 100%)}
.qsc-rec-img{width:100%;height:100%;object-fit:cover;object-position:top;display:block}
.qsc-rec-overlay{position:absolute;inset:0;background:rgba(0,0,0,.25)}
.qsc-rec-badge{position:absolute;top:7px;right:8px;background:var(--badge);color:#fff;font-size:13px;font-weight:400;padding:2px 7px;border-radius:10px;letter-spacing:.04em;text-transform:uppercase}
.qsc-rec-body{padding:8px 10px}
.qsc-rec-date{font-size:13px;font-weight:400;color:var(--tc);line-height:1.2}
.qsc-rec-lbl{font-size:13px;color:var(--mu);margin-top:2px}

</style>
</head>
<body>
${siteNav()}
<main class="container my-4" style="max-width:720px">
  <nav aria-label="breadcrumb" class="mb-3">
    <ol class="breadcrumb">
      <li class="breadcrumb-item"><a href="/">Home</a></li>
      <li class="breadcrumb-item"><a href="/events/${monthSlug}/${day}/">${escapeHtml(mDisplay)} ${day}</a></li>
      <li class="breadcrumb-item active">Quiz</li>
    </ol>
  </nav>
	  <div class="qsc-page-header">
	    <h1><i class="bi bi-patch-question-fill me-2" style="color:var(--accent,#9dc43a)"></i>${escapeHtml(mDisplay)} ${day} — History Quiz</h1>
	    <p>5 questions &middot; Based on real historical events &middot; Instant feedback</p>
	  </div>
	  ${carouselHtml}
  ${recSliderHtml}
  ${buildDateClusterCard(monthSlug, day, mDisplay, "quiz")}
  ${relatedBlogHtml}
  ${buildQuizAnswerBlock({ mDisplay, day, quiz, featuredEvent })}
  <p class="text-center" style="font-size:.85rem;color:var(--mu)"><a href="/events/${monthSlug}/${day}/" style="color:var(--mu)">← All events on ${escapeHtml(mDisplay)} ${day}</a></p>
  <div class="ad-unit" style="margin:24px 0;overflow:hidden">
    <div class="ad-unit-label">Advertisement</div>
    <ins class="adsbygoogle"
         style="display:block;width:100%;overflow:hidden"
         data-ad-client="ca-pub-8565025017387209"
         data-ad-slot="9477779891"
         data-ad-format="auto"
         data-full-width-responsive="true"></ins>
  </div>
  <div class="ad-unit-container my-4" style="overflow:hidden">
    <span class="ad-unit-label">Advertisement</span>
    <ins class="adsbygoogle" style="display:block;width:100%" data-ad-format="autorelaxed"
         data-ad-client="ca-pub-8565025017387209" data-ad-slot="9183511632"></ins>
  </div>
</main>
${siteFooter("yr")}
${getSharedPageScripts({ pageType: "quiz-date", pageSlug: `${monthSlug}-${day}` })}
</body></html>`;

  // Cache the full rendered page for future visits
  if (env.EVENTS_KV) {
    try {
      await env.EVENTS_KV.put(pageHtmlKey, html, {
        expirationTtl: 24 * 60 * 60,
      });
    } catch (_) {
      /* non-fatal */
    }
  }

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
      "X-Cache": "MISS",
    },
  });
}

// --- Worker Entry Point (ES Module Format) ---
export default {
  async fetch(request, env, ctx) {
    return handleFetchRequest(request, env, ctx);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(handleScheduledEvent(env));
  },
};
