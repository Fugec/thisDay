/**
 * Cloudflare Worker — Blog Post Generator
 *
 * Runs on a cron trigger (daily at 00:05 UTC) and publishes a new blog post
 * every other day using Cloudflare Workers AI (free, no external API key).
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
import { callAI } from "./shared/ai-call.js";

const PIPELINE_STATE_KEY = "youtube:pipeline-state";

function utcDateString(value = new Date()) {
  return value.toISOString().slice(0, 10);
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
  await savePipelineState(env, state);

  if (streak >= 2) {
    await notifyPipelineIssue(env, {
      step,
      slug,
      date: today,
      message,
      streak,
    });
    stepState.lastAlertDate = today;
    state.steps[step] = stepState;
    await savePipelineState(env, state);
  }
}

const KV_POST_PREFIX = "post:";
const KV_INDEX_KEY = "index";
const KV_LAST_GEN_KEY = "last_gen_date";
const KV_PERSON_IMAGE_PREFIX = "person-image:";
const KV_PERSON_IMAGE_TTL = 60 * 60 * 24 * 30; // 30 days
const EVERY_OTHER_DAYS = 1; // Generate every N days
const BLOG_NAV_WIDTH_FIX_CSS =
  `.nav-inner{max-width:1920px!important;margin:0 auto!important}`;

function buildArticleAnswerBlock(content) {
  // Build grid rows from quickFacts; fall back to the four core fields when empty.
  const facts = content.quickFacts?.length
    ? content.quickFacts
    : [
        { label: "Event",     value: content.eventTitle },
        { label: "Date",      value: content.historicalDate },
        { label: "Location",  value: content.location || content.country || "Historical location" },
        { label: "Significance", value: (content.quickFacts || []).find((f) => /significance|impact|legacy/i.test(f.label))?.value || content.description },
      ];
  const gridItems = facts
    .map((f) => `      <div class="ai-answer-item"><strong>${esc(f.label)}</strong><span>${esc(f.value)}</span></div>`)
    .join("\n");

  return `<section class="ai-answer-card mb-4" aria-labelledby="article-short-answer-title">
    <div class="ai-answer-kicker">Short answer</div>
    <h2 id="article-short-answer-title" class="seo-only-title" style="display:none">What was ${esc(content.eventTitle)}?</h2>
    <div class="ai-answer-grid" aria-label="Key facts">
${gridItems}
    </div>
  </section>`;
}

function buildDidYouKnowSlider(facts) {
  const cleanedFacts = (facts || [])
    .map((fact) => String(fact || "").trim())
    .filter(Boolean);
  if (!cleanedFacts.length) return "";

  const sliderFacts = Array.from({ length: 5 }, (_, index) => {
    const fact = cleanedFacts[index] || cleanedFacts[index % cleanedFacts.length];
    return `            <article class="blog-cta-col dyn-slide" aria-label="Did you know fact ${index + 1}">
              <p>Did you know</p>
              <h3>${esc(fact)}</h3>
            </article>`;
  }).join("\n");

  return `<section class="dyn-slider-wrap mb-4" aria-label="Did you know">
            <div class="dyn-slider-track">
${sliderFacts}
            </div>
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

const ARTICLE_TOPIC_HUBS = [
  {
    slug: "world-war-ii",
    title: "World War II",
    keywords: ["world war ii", "second world war", "wwii", "nazi", "axis", "allied"],
    pillars: ["War & Conflict"],
  },
  {
    slug: "cold-war",
    title: "Cold War",
    keywords: ["cold war", "soviet", "berlin wall", "cuban missile crisis", "communist"],
    pillars: ["War & Conflict", "Politics & Government"],
  },
  {
    slug: "french-revolution",
    title: "French Revolution",
    keywords: ["french revolution", "robespierre", "bastille", "napoleon", "jacobin"],
    pillars: ["Politics & Government", "War & Conflict"],
  },
  {
    slug: "roman-empire",
    title: "Roman Empire",
    keywords: ["roman empire", "rome", "roman", "caesar", "augustus", "constantinople"],
    pillars: ["Politics & Government", "War & Conflict"],
  },
  {
    slug: "space-exploration",
    title: "Space Exploration",
    keywords: ["space", "apollo", "nasa", "astronaut", "moon", "rocket", "satellite"],
    pillars: ["Science & Technology", "Exploration & Discovery"],
  },
  {
    slug: "civil-rights",
    title: "Civil Rights",
    keywords: ["civil rights", "segregation", "suffrage", "voting rights", "human rights"],
    pillars: ["Social & Human Rights", "Politics & Government"],
  },
  {
    slug: "medical-breakthroughs",
    title: "Medical Breakthroughs",
    keywords: ["vaccine", "medicine", "medical", "pandemic", "epidemic", "surgery"],
    pillars: ["Health & Medicine", "Science & Technology", "Disasters & Accidents"],
  },
  {
    slug: "exploration-and-discovery",
    title: "Exploration and Discovery",
    keywords: ["expedition", "voyage", "explorer", "navigator", "discovery", "polar", "pacific", "atlantic"],
    pillars: ["Exploration & Discovery"],
  },
];

// Maps each blog pillar to the hub slugs that best represent it.
// Used as the primary (pillar-first) signal before keyword fallback.
const PILLAR_TO_HUB_SLUGS = {
  "War & Conflict":          ["world-war-ii", "cold-war", "french-revolution"],
  "Politics & Government":   ["cold-war", "civil-rights", "french-revolution"],
  "Science & Technology":    ["space-exploration", "medical-breakthroughs"],
  "Health & Medicine":       ["medical-breakthroughs"],
  "Exploration & Discovery": ["exploration-and-discovery", "space-exploration"],
  "Social & Human Rights":   ["civil-rights"],
  "Disasters & Accidents":   ["medical-breakthroughs"],
};

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

// Returns up to `limit` hub objects for an article.
// Primary signal: pillars (AI-classified, reliable).
// Fallback signal: keyword match against title/description/keyTerms/quickFacts.
function getArticleTopicHubMatches(content, limit = 3, pillars = []) {
  const seen = new Set();
  const results = [];

  // Pillar-first: deterministic match from AI classification
  for (const pillar of pillars) {
    const slugs = PILLAR_TO_HUB_SLUGS[pillar] || [];
    for (const slug of slugs) {
      if (!seen.has(slug)) {
        const hub = ARTICLE_TOPIC_HUBS.find((h) => h.slug === slug);
        if (hub) { seen.add(slug); results.push(hub); }
      }
      if (results.length >= limit) return results;
    }
  }

  // Keyword fallback: catches specific topics not covered by pillar mapping
  const haystack = normalizeTopicMatchText(
    [
      content?.title,
      content?.eventTitle,
      content?.description,
      ...(Array.isArray(content?.keyTerms) ? content.keyTerms.map((kt) => kt?.term || "") : []),
      ...(content?.quickFacts || []).map((f) => `${f?.label || ""} ${f?.value || ""}`),
    ].join(" "),
  );
  if (haystack) {
    for (const hub of ARTICLE_TOPIC_HUBS) {
      if (!seen.has(hub.slug) && hub.keywords.some((kw) => haystack.includes(normalizeTopicMatchText(kw)))) {
        seen.add(hub.slug);
        results.push(hub);
        if (results.length >= limit) break;
      }
    }
  }

  return results;
}

// Returns 4 question heading strings tuned to the article's dominant pillar.
function getQuestionHeadings(eventTitle, pillars = []) {
  const dominantPillar = pillars[0] || "default";
  const set = PILLAR_QUESTION_HEADINGS[dominantPillar] || PILLAR_QUESTION_HEADINGS.default;
  return set.map((fn) => fn(eventTitle));
}

function extractPlainSentence(text, maxLength = 220) {
  const sentence = String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)[0];

  if (!sentence) return "";
  return sentence.length > maxLength ? `${sentence.slice(0, maxLength - 1).trim()}…` : sentence;
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
  ensureFactDenseOpening(
    content.overviewParagraphs,
    `${content.eventTitle} happened on ${content.historicalDate}${locationPart}.`,
    [content.eventTitle, content.historicalDate, content.location],
  );
  ensureFactDenseOpening(
    content.eyewitnessParagraphs,
    `Contemporary accounts described ${content.eventTitle} as it unfolded on ${content.historicalDate}${locationPart}.`,
    [content.eventTitle, "witness", "account", content.historicalDate],
  );
  ensureFactDenseOpening(
    content.aftermathParagraphs,
    `The immediate aftermath of ${content.eventTitle} began as soon as events on ${content.historicalDate} were over.`,
    [content.eventTitle, "aftermath", "response", content.historicalDate],
  );
  ensureFactDenseOpening(
    content.conclusionParagraphs,
    `The lasting importance of ${content.eventTitle} lies in what changed after ${content.historicalDate}.`,
    [content.eventTitle, "legacy", "importance", content.historicalDate],
  );
}

function buildArticleRelatedQuestionsBlock(content, pillars = []) {
  const overviewAnswer =
    extractPlainSentence(content?.overviewParagraphs?.[0]) || content.description;
  const eyewitnessAnswer =
    extractPlainSentence(content?.eyewitnessParagraphs?.[0]) ||
    `The article follows contemporary accounts connected to ${content.eventTitle}.`;
  const aftermathAnswer =
    extractPlainSentence(content?.aftermathParagraphs?.[0]) ||
    `The aftermath section explains what changed in the days and months after ${content.eventTitle}.`;
  const legacyAnswer =
    extractPlainSentence(content?.conclusionParagraphs?.[0]) ||
    ((content.quickFacts || []).find((fact) => /significance|legacy|impact/i.test(fact.label))?.value || content.description);
  const topicLinks = getArticleTopicHubMatches(content, 3, pillars);
  const [q1, q2, q3, q4] = getQuestionHeadings(content.eventTitle, pillars);

  return `<section class="mt-5 p-4 rounded border" style="background-color:rgba(0,0,0,.03);color:var(--text)">
    <div class="ai-answer-kicker">Related questions</div>
    <h2 class="h3 mb-3">Questions readers ask about ${esc(content.eventTitle)}</h2>
    <div class="related-question-grid">
      <article class="related-question-card">
        <h3>${esc(q1)}</h3>
        <p>${esc(overviewAnswer)}</p>
      </article>
      <article class="related-question-card">
        <h3>${esc(q2)}</h3>
        <p>${esc(eyewitnessAnswer)}</p>
      </article>
      <article class="related-question-card">
        <h3>${esc(q3)}</h3>
        <p>${esc(aftermathAnswer)}</p>
      </article>
      <article class="related-question-card">
        <h3>${esc(q4)}</h3>
        <p>${esc(legacyAnswer)}</p>
      </article>
    </div>
    ${
      topicLinks.length > 0
        ? `<div class="topic-hub-links mt-3">
      <h3 class="h6 mb-2">Explore connected topic hubs</h3>
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
  </section>`;
}

// Maps each pillar to a third authority link (Britannica + History.com are always present).
const PILLAR_AUTHORITY_EXTRA = {
  "Science & Technology":    { name: "NASA",             url: (q) => `https://www.nasa.gov/search/?q=${q}` },
  "Exploration & Discovery": { name: "Smithsonian",      url: (q) => `https://www.si.edu/search?q=${q}` },
  "Health & Medicine":       { name: "MedlinePlus (NIH)",url: (q) => `https://medlineplus.gov/search/?query=${q}` },
  "Arts & Culture":          { name: "Smithsonian",      url: (q) => `https://www.si.edu/search?q=${q}` },
  "Social & Human Rights":   { name: "PBS",              url: (q) => `https://www.pbs.org/search/?q=${q}` },
  "Disasters & Accidents":   { name: "Smithsonian",      url: (q) => `https://www.si.edu/search?q=${q}` },
  "War & Conflict":          { name: "Khan Academy",     url: (q) => `https://www.khanacademy.org/search?search_again=1&page_search_query=${q}` },
  "Politics & Government":   { name: "Khan Academy",     url: (q) => `https://www.khanacademy.org/search?search_again=1&page_search_query=${q}` },
  "Economy & Business":      { name: "Khan Academy",     url: (q) => `https://www.khanacademy.org/search?search_again=1&page_search_query=${q}` },
  "Famous Persons":          { name: "Smithsonian",      url: (q) => `https://www.si.edu/search?q=${q}` },
};

function buildAuthorityLinksBlock(content, pillars = []) {
  const query = encodeURIComponent(
    String(content.eventTitle || "").replace(/[^\w\s]/g, " ").trim().substring(0, 80),
  );
  const extra = PILLAR_AUTHORITY_EXTRA[pillars[0] || ""] ||
    { name: "Khan Academy", url: (q) => `https://www.khanacademy.org/search?search_again=1&page_search_query=${q}` };

  const links = [
    { name: "Encyclopædia Britannica", url: `https://www.britannica.com/search?query=${query}` },
    { name: "History.com",             url: `https://www.history.com/search#q=${query}` },
    { name: extra.name,                url: extra.url(query) },
  ];

  const chips = links
    .map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" class="authority-link">${esc(l.name)}</a>`)
    .join("");

  return `<div class="authority-links mt-3 mb-4">
    <span class="authority-links-label">Learn more at trusted sources</span>
    <div class="authority-links-row">${chips}</div>
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

// ---------------------------------------------------------------------------
// Shared support popup (Buy Me a Coffee) — injected before </body> on all pages
// ---------------------------------------------------------------------------
function supportPopupSnippet() {
  return `<style>#supportPopup{position:fixed;inset:0;background:rgba(0,0,0,.35);display:none;justify-content:center;align-items:center;backdrop-filter:blur(2px);z-index:9998;opacity:0;transition:opacity .4s ease}#supportPopup.show{display:flex;opacity:1}.support-popup-content{background:var(--btn-bg,#1b3a2d);color:#fff;padding:25px 28px;border-radius:12px;max-width:300px;width:90%;text-align:center;border:1px solid rgba(255,255,255,.15);box-shadow:0 8px 25px rgba(0,0,0,.35);position:relative;animation:popupFadeIn .35s ease}@keyframes popupFadeIn{from{transform:scale(.92);opacity:0}to{transform:scale(1);opacity:1}}.support-close-btn{position:absolute;top:8px;right:10px;border:none;background:transparent;font-size:1.4rem;cursor:pointer;color:rgba(255,255,255,.7);line-height:1;padding:0}.support-close-btn:hover{color:#fff}</style>
<div id="supportPopup"><div class="support-popup-content"><button class="support-close-btn">&times;</button><h4 style="font-size:1rem;margin-bottom:8px">History runs on facts, and this project runs on coffee!</h4><p style="font-size:.9rem;margin-bottom:14px;color:rgba(255,255,255,.85)">Your support is incredibly helpful and genuinely appreciated.</p><a href="https://buymeacoffee.com/fugec?new=1" target="_blank" rel="noopener" style="display:inline-block;padding:8px 18px;background:var(--btn-bg,#1b3a2d);color:var(--accent,#9dc43a);border:1.5px solid var(--accent,#9dc43a);border-radius:8px;text-decoration:none;font-weight:600;font-size:.9rem">Support with a coffee ☕</a></div></div>
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
   * Cron trigger — runs daily, generates every other day.
   */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        await checkAndUpdateAiModel(env, env.BLOG_AI_KV);
        await maybeGenerateBlogPost(env, ctx);
      })(),
    );
  },

  /**
   * HTTP fetch handler — serves blog pages and the manual trigger endpoint.
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

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
      try {
        const publishUrl = new URL(request.url);
        const forcedEvent = publishUrl.searchParams.get("force-event") || null;
        const forceDate = publishUrl.searchParams.get("force-date") || null;
        const forceImage = publishUrl.searchParams.get("force-image") || null;
        await generateAndStore(env, ctx, forcedEvent, forceDate, forceImage);
        return jsonResponse({ status: "ok", message: "Blog post published." });
      } catch (err) {
        console.error(
          `Blog AI: /blog/publish generation failed — ${err.message}`,
        );
        const today = todayDateString();
        await recordPipelineFailure(env, {
          step: "blog",
          slug: today,
          message: err.message,
          date: new Date(),
        });
        await env.BLOG_AI_KV.put(
          `error:${today}`,
          `Publish endpoint failed: ${err.message}`,
          { expirationTtl: 7 * 86_400 },
        );
        return jsonResponse({ status: "error", message: err.message }, 500);
      }
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

    const legacyArchivePostMatch = path.match(/^\/blog\/archive\/([^/]+)\/?$/);
    if (legacyArchivePostMatch) {
      return Response.redirect(`${url.origin}/blog/${legacyArchivePostMatch[1]}/`, 301);
    }

    // Pillar hub pages: /blog/topic/:pillar-slug/
    const topicMatch = path.match(/^\/blog\/topic\/([a-z0-9-]+)$/);
    if (topicMatch) {
      return servePillarHub(env, topicMatch[1]);
    }

    // JSON feed of latest public YouTube videos, merged with blog index for titles/thumbnails
    if (path === "/blog/videos.json") {
      const [indexRaw, ytRaw] = await Promise.all([
        env.BLOG_AI_KV.get(KV_INDEX_KEY),
        env.BLOG_AI_KV.get("youtube:uploaded"),
      ]);
      const index = indexRaw ? JSON.parse(indexRaw) : [];
      const yt = ytRaw ? JSON.parse(ytRaw) : {};
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
            thumbnail: `https://img.youtube.com/vi/${v.youtubeId}/hqdefault.jpg`,
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
      const index = indexRaw ? JSON.parse(indexRaw) : [];
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
            if (existing) return { slug: entry.slug, status: "skipped" };
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
      if (quizRaw) {
        return new Response(quizRaw, {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=86400, s-maxage=0",
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
        if (env.AI || env.GROQ_API_KEY) {
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
      const [html, ytRaw, eventsThumb] = await Promise.all([
        env.BLOG_AI_KV.get(`${KV_POST_PREFIX}${slug}`),
        env.BLOG_AI_KV.get("youtube:uploaded"),
        eventsThumbPromise,
      ]);
      if (html) {
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
        // Patch raw og:image / twitter:image URLs → image-proxy at 1200px for proper social card sizing.
        // Old posts store the raw Wikimedia URL directly; new posts use image-proxy in buildPostHTML.
        if (!patchedHtml.includes('og:image" content="/image-proxy')) {
          patchedHtml = patchedHtml.replace(
            /(<meta property="og:image" content=")(https?:\/\/[^"]+)(")/,
            (_, pre, url, post) =>
              `${pre}/image-proxy?src=${encodeURIComponent(url)}&w=1200&q=85${post}`,
          );
        }
        if (!patchedHtml.includes('twitter:image" content="/image-proxy')) {
          patchedHtml = patchedHtml.replace(
            /(<meta name="twitter:image" content=")(https?:\/\/[^"]+)(")/,
            (_, pre, url, post) =>
              `${pre}/image-proxy?src=${encodeURIComponent(url)}&w=1200&q=85${post}`,
          );
        }
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
          `<style>:root{--bg:#ffffff;--bg-alt:#f2f7f2;--text:#1a2e20;--text-muted:#5c7a65;--border:#cfe0cf;--btn-bg:#1b3a2d;--btn-text:#fff;--btn-hover:#2a4d3a;--accent:#9dc43a;--radius:4px;--shadow:0 16px 32px -8px rgba(27,58,45,.08)}body{color:var(--text)!important;background:#fff!important;font-family:Lora,serif!important}.btn-primary,.btn-primary:focus{background:var(--btn-bg)!important;border-color:var(--btn-bg)!important;color:#fff!important}.btn-primary:hover{background:var(--btn-hover)!important;border-color:var(--btn-hover)!important}.btn-outline-primary{color:var(--btn-bg)!important;border-color:var(--btn-bg)!important}.btn-outline-primary:hover{background:var(--btn-bg)!important;color:#fff!important}.text-primary{color:var(--btn-bg)!important}a:not(.btn):not([class*="nav"]):not(.brand):not(.list-group-item):not(.mobile-menu-link){color:var(--btn-bg)}.pillar-pill-row{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-top:.75rem}.pillar-pill{display:inline-flex;align-items:center;justify-content:center;padding:7px 14px;border:1px solid var(--border);border-radius:999px;background:var(--bg-alt);color:var(--btn-bg)!important;font-size:13px;font-weight:400;letter-spacing:.01em;text-decoration:none!important;transition:background .15s ease,border-color .15s ease,color .15s ease}.pillar-pill:hover{background:#e7f0e7;border-color:var(--btn-bg)}.pillar-pill-featured{background:var(--btn-bg)!important;border-color:var(--btn-bg)!important;color:#fff!important}.pillar-pill-featured:hover{background:var(--btn-hover)!important;border-color:var(--btn-hover)!important}.dyn-slider-wrap{overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none}.dyn-slider-wrap::-webkit-scrollbar{display:none}.dyn-slider-track{display:flex;gap:14px;padding-bottom:4px}.dyn-slide{flex:0 0 240px;max-width:240px;min-height:220px;scroll-snap-align:start;background:var(--btn-bg);color:#fff;padding:2rem 1.75rem;display:flex;flex-direction:column;justify-content:center;gap:1rem;border-radius:10px}.dyn-slide p{font-size:15px;font-weight:400;text-transform:none;letter-spacing:normal;color:var(--accent);margin:0;line-height:1.6}.dyn-slide h3{font-size:15px;font-weight:400;color:#fff;margin:0;line-height:1.6}</style></head>`,
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
          const disclosureBlock =
            `<div class="mt-5 p-3 rounded" style="background:rgba(0,0,0,0.03);border:1px solid rgba(0,0,0,0.08);font-size:.82rem;line-height:1.6">` +
            `<strong style="display:block;margin-bottom:4px">About this article</strong>` +
            `<span class="article-meta">` +
            `This article was researched and drafted with AI assistance, then reviewed for factual accuracy by the ` +
            `<a href="/about/editorial/" rel="author">thisDay. editorial team</a>. ` +
            `Historical source: <a href="https://en.wikipedia.org/" target="_blank" rel="noopener noreferrer">Wikipedia</a> ` +
            `(licensed under <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a>). ` +
            `Images via <a href="https://commons.wikimedia.org/" target="_blank" rel="noopener noreferrer">Wikimedia Commons</a>. ` +
            `Found an error? <a href="/contact/">Let us know</a>.` +
            `</span></div>`;
          patchedHtml = patchedHtml.replace(
            "</article>",
            disclosureBlock + "\n</article>",
          );
        }
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
        // Inject quiz CTA + popup for old posts that don't have it
        if (!patchedHtml.includes("tdq-cta-btn")) {
          const quizCta = `
          <!-- Quiz CTA -->
          <div class="mt-4 p-3 rounded d-flex align-items-center gap-3" style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25)">
            <i class="bi bi-patch-question-fill" style="font-size:1.5rem;color:var(--accent,#9dc43a);flex-shrink:0"></i>
            <div>
              <strong style="color:var(--text,#1a2e20)">Test Your Knowledge</strong><br/>
              <small class="tdq-cta-sub">Can you answer 5 questions about this event?</small><br/>
              <button class="btn" id="tdq-cta-btn" onclick="document.getElementById('tdq-overlay').style.display='block';document.getElementById('tdq-popup').style.display='block';requestAnimationFrame(function(){document.getElementById('tdq-popup').classList.add('tdq-popup-open');});document.body.style.overflow='hidden';if(typeof maybeLoadAndShowQuiz==='function')maybeLoadAndShowQuiz();">
                Take the Quiz <i class="bi bi-arrow-right ms-1"></i>
              </button>
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
          // Fix intermediate explore cards that have data-explore-injected but Bootstrap flex classes (no nowrap)
          patchedHtml = patchedHtml.replace(
            /(<div data-explore-injected="1" class="mt-4 p-3 rounded) d-flex[^"]*"([^>]*)>/g,
            '$1" style="display:flex;flex-direction:row;flex-wrap:nowrap;align-items:flex-start;gap:12px;background:rgba(0,0,0,0.03);border:1px solid rgba(0,0,0,0.08)">',
          );
          // Build "Explore in History" section
          const _sp = slugParsedForThumb;
          let exploreHtml = "";
          if (_sp) {
            const _thumb = eventsThumb
              ? `<img src="/image-proxy?src=${encodeURIComponent(eventsThumb)}&w=80&q=75" alt="" width="64" height="64" style="width:64px;height:64px;min-width:64px;object-fit:cover;border-radius:8px;flex-shrink:0;display:block" loading="lazy"/>`
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
              const afterWikiAnchor = patchedHtml.includes("<!-- Quiz CTA -->")
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
            ? `<img src="/image-proxy?src=${encodeURIComponent(eventsThumb)}&w=80&q=75" alt="" width="64" height="64" style="width:64px;height:64px;min-width:64px;object-fit:cover;border-radius:8px;flex-shrink:0;display:block" loading="lazy"/>`
            : "";
          const exploreCard = buildDateExploreCard(sp, thumb);
          const anchor = patchedHtml.includes("<!-- Quiz CTA -->")
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

        // Backfill inline figures for already-stored posts that shipped without them.
        // Lazily inject and persist back to KV so the latest article gets figures immediately.
        if (!/<figure style="float:(?:right|left);/i.test(patchedHtml)) {
          const wikiUrl = extractWikiUrl(patchedHtml);
          const coverUrl = extractCoverSrc(patchedHtml);
          if (wikiUrl) {
            try {
              const imgs = await fetchEventImages(wikiUrl, coverUrl, 2);
              if (imgs.length > 0) {
                patchedHtml = injectEventImages(patchedHtml, imgs);
                if (ctx?.waitUntil) {
                  ctx.waitUntil(
                    env.BLOG_AI_KV
                      .put(`${KV_POST_PREFIX}${slug}`, patchedHtml)
                      .catch(() => {}),
                  );
                }
              }
            } catch (_) {
              /* non-fatal */
            }
          }
        }

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
        // hides kicker and h2 title to match the current clean card design).
        if (!patchedHtml.includes('ai-card-patch-v1')) {
          patchedHtml = patchedHtml.replace(
            '</head>',
            '<style>/*ai-card-patch-v1*/.ai-answer-card{background:#f5f5f5!important;background-image:none!important}.ai-answer-kicker{display:none!important}.ai-answer-card h2{display:none!important}.site-btn.w-100{justify-content:center!important}</style></head>',
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
            // Extract title and description from existing NewsArticle schema or meta tags
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
              thumbnailUrl: `https://img.youtube.com/vi/${ytEntry.youtubeId}/maxresdefault.jpg`,
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
          return htmlResponse(ytHtml);
        }
        // Inline quiz JSON so popup opens instantly (no fetch round-trip)
        const inlineQuizRaw = await env.BLOG_AI_KV.get(`quiz-v3:blog:${slug}`);
        if (inlineQuizRaw) {
          const bodyCloseInline = patchedHtml.includes("</body>")
            ? "</body>"
            : "</html>";
          patchedHtml = patchedHtml.replace(
            bodyCloseInline,
            `<script>window.__tdqQuiz=${inlineQuizRaw};<\/script>\n${bodyCloseInline}`,
          );
        }
        // Pre-warm quiz in background so it's ready before the user clicks "Take the Quiz"
        ctx.waitUntil(
          (async () => {
            const cached =
              inlineQuizRaw ||
              (await env.BLOG_AI_KV.get(`quiz-v3:blog:${slug}`));
            if (!cached && (env.AI || env.GROQ_API_KEY)) {
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
        return htmlResponse(patchedHtml);
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
      // Inject quiz CTA + popup if no quiz present
      if (!html.includes("tdq-cta-btn")) {
        const quizCta = `
          <div class="mt-4 p-3 rounded d-flex align-items-center gap-3" style="background:rgba(157,196,58,.08);border:1px solid rgba(157,196,58,.25)">
            <i class="bi bi-patch-question-fill" style="font-size:1.5rem;color:var(--accent,#9dc43a);flex-shrink:0"></i>
            <div>
              <strong style="color:var(--text,#1a2e20)">Test Your Knowledge</strong><br/>
              <small class="tdq-cta-sub" style="color:var(--text-muted,#5c7a65)">Can you answer 5 questions about this event?</small><br/>
              <button class="btn mt-1" id="tdq-cta-btn" onclick="if(typeof maybeLoadAndShowQuiz==='function')maybeLoadAndShowQuiz();">Take the Quiz <i class="bi bi-arrow-right ms-1"></i></button>
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
 * Retry strategy: tries up to 3 times with increasing delays so transient
 * CF Workers AI timeouts don't silently skip an entire day.
 */
async function maybeGenerateBlogPost(env, ctx) {
  const today = todayDateString(); // "YYYY-MM-DD"
  const lastGen = await env.BLOG_AI_KV.get(KV_LAST_GEN_KEY);

  if (lastGen) {
    const diffDays = Math.round(
      (new Date(today) - new Date(lastGen)) / 86_400_000,
    );
    if (diffDays < EVERY_OTHER_DAYS) {
      console.log(
        `Blog AI: last post was ${diffDays} day(s) ago — skipping (need ${EVERY_OTHER_DAYS}).`,
      );
      return;
    }
  }

  // Day-of-week aware publish variance (P2c — anti-spam-signal pattern break).
  //
  // YouTube upload runs Mon/Tue/Thu/Fri at 01:00 UTC and depends on today's
  // post being ready. Those days always generate.
  //
  // Wed/Sat/Sun have no scheduled YouTube run, so we skip ~35% of them
  // randomly. This makes the publish schedule non-deterministic without
  // breaking the YouTube pipeline or touching wrangler-blog.jsonc.
  const SKIP_PROBABILITY = 0.35;
  const YOUTUBE_DAYS = new Set([1, 2, 4, 5]); // Mon=1, Tue=2, Thu=4, Fri=5
  const todayDow = new Date(today + "T00:00:00Z").getUTCDay(); // 0=Sun…6=Sat
  if (!YOUTUBE_DAYS.has(todayDow) && Math.random() < SKIP_PROBABILITY) {
    console.log(
      `Blog AI: random publish skip applied (${Math.round(SKIP_PROBABILITY * 100)}% chance on non-YouTube days) — no post today.`,
    );
    return;
  }

  // Mark today as attempted before generating so tomorrow's cron always starts
  // from today's date regardless of whether generation succeeds or fails.
  await env.BLOG_AI_KV.put(KV_LAST_GEN_KEY, today);

  // Retry up to 3 times — CF Workers AI occasionally times out on the first attempt.
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await generateAndStore(env, ctx);
      console.log(
        `Blog AI: post generated successfully (attempt ${attempt}/3).`,
      );
      return;
    } catch (err) {
      lastError = err;
      console.error(`Blog AI: attempt ${attempt}/3 failed — ${err.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }

  // All attempts failed — persist error in KV so it's visible in the dashboard.
  const errMsg = lastError?.message ?? String(lastError);
  await recordPipelineFailure(env, {
    step: "blog",
    slug: today,
    message: errMsg,
    date: now,
  });
  await env.BLOG_AI_KV.put(
    `error:${today}`,
    `Generation failed after 3 attempts: ${errMsg}`,
    { expirationTtl: 7 * 86_400 }, // auto-expire after 7 days
  );
  console.error(
    `Blog AI: all 3 attempts failed for ${today}. Error stored in KV.`,
  );
}

/**
 * Fetches a real image URL from the Wikipedia REST API for the given event title.
 * Falls back to null if the request fails or no image is found.
 */
async function fetchWikipediaImage(eventTitle, wikiUrl) {
  try {
    // Prefer the article slug from the wikiUrl so we hit the right page
    let title = eventTitle;
    if (wikiUrl) {
      const m = wikiUrl.match(/wikipedia\.org\/wiki\/(.+?)(?:\s|$)/);
      if (m) title = decodeURIComponent(m[1].split("#")[0]);
    }

    const ua = { "User-Agent": "thisday.info-blog/1.0 (https://thisday.info)" };

    // 1. REST summary — fastest, returns lead/thumbnail image
    const summaryRes = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      { headers: ua },
    );
    if (summaryRes.ok) {
      const d = await summaryRes.json();
      const img = d.thumbnail?.source ?? d.originalimage?.source ?? null;
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
          !/icon|logo|flag|map|seal|coa/i.test(t),
      );

    if (!imageFiles.length) return null;

    const infoRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(imageFiles[0])}&prop=imageinfo&iiprop=url&format=json`,
      { headers: ua },
    );
    if (!infoRes.ok) return null;
    const infoData = await infoRes.json();
    const infoPage = Object.values(infoData?.query?.pages ?? {})[0];
    return infoPage?.imageinfo?.[0]?.url ?? null;
  } catch {
    return null;
  }
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
  const candidates = [];

  if (content?.imageUrl) candidates.push(content.imageUrl);

  const wikiImage = await fetchWikipediaImage(
    content?.eventTitle,
    content?.wikiUrl,
  );
  if (wikiImage) candidates.push(wikiImage);

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
        if (slugImage) candidates.push(slugImage);
      }
    } catch {
      // ignore malformed URL
    }
  }

  const uniqueCandidates = [...new Set(candidates.filter(Boolean))];

  for (const candidate of uniqueCandidates) {
    if (await isWorkingImageUrl(candidate)) return candidate;
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
  "the importance of this", "a reminder of", "shows the importance of",
  "demonstrated the power of", "played a crucial role", "played a key role",
  "played a significant role", "played a vital role", "had a profound impact",
  "had a lasting impact", "had a significant impact", "indelible mark",
  "far-reaching consequences", "world was forever changed", "world would never be the same",
  "made history", "turning point", "watershed moment", "stands as a", "serves as a",
  "testament to", "in the annals of history", "throughout history",
  "stood the test of time", "chapter in history",
  // Mood labels without evidence
  "it was a dark time", "it was a bleak time", "it was a difficult period",
  "it was chaos", "it was a complex time", "dark chapter", "in the face of adversity",
  // Vague connectors and filler
  "at its core", "in many ways", "at the heart of", "in no small part",
  "it goes without saying", "needless to say", "the fact remains",
  "at the end of the day", "in essence", "in the grand scheme",
  "time and again", "when all is said and done",
  // Casual speech patterns
  "that's the thing", "it's a shame", "he saw it all", "she saw it all",
  "they saw it all", "it's like they", "you have to understand",
  "it's a lesson", "we must not forget", "mustn't forget", "we can't forget",
  "as the world grapples", "it's a reminder", "still resonates today",
  "cannot be forgotten", "reminder of the past", "to this day",
];

const PARA_FIELDS = [
  "overviewParagraphs", "eyewitnessOrChronicle",
  "aftermathParagraphs", "conclusionParagraphs",
];

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

/**
 * Quality fix pass: rewrites paragraphs that contain banned phrases AND
 * removes cross-section repetition (same facts restated in a later section).
 * Sends all four sections together so the AI can see the full picture.
 * Called once after scanBannedPhrases finds violations.
 * Returns updated content — falls back to original on any error.
 */
async function fixBannedPhrases(env, content, violations) {
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
    "Rules: Preserve paragraph count exactly in every array. Never use dashes (-) or em dashes. " +
    "Keep all facts accurate. Return ONLY a JSON object with the arrays that changed. Omit unchanged arrays.";

  const userMessage =
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

/**
 * Calls the Claude API, builds the HTML page, and persists everything to KV.
 */
async function generateAndStore(env, ctx, forcedEvent = null, forceDate = null, forceImage = null) {
  const parsedForceDate = forceDate ? new Date(forceDate + "T12:00:00Z") : null;
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
    .map((e) => e.title)
    .filter(
      (t) =>
        !forcedEvent ||
        !t
          .toLowerCase()
          .startsWith(
            forcedEvent.toLowerCase().split(" — ")[0].trim().toLowerCase(),
          ),
    );

  // Pillar weekly rotation: ensure each day uses a different pillar.
  // - recentPillars: primary pillars of the last 7 published posts (explicit avoid list)
  // - preferredPillars: least-covered pillars from last 30 posts (positive signal)
  let preferredPillars = [];
  let recentPillars = [];
  if (!forcedEvent) {
    const sorted = existingIndex
      .slice()
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    // Last 7 posts → pillars to avoid repeating this week
    recentPillars = sorted
      .slice(0, 7)
      .filter((e) => Array.isArray(e.pillars) && e.pillars.length > 0)
      .map((e) => e.pillars[0]); // primary pillar only

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
        .filter(([p]) => p !== "Born on This Day" && p !== "Died on This Day")
        .sort((a, b) => a[1] - b[1])
        .slice(0, 3)
        .map(([p]) => p);
      console.log(
        `Blog AI: depth rotation — preferred pillars: [${preferredPillars.join(", ")}], avoid: [${recentPillars.join(", ")}]`,
      );
    }
  }

  // P4a — "why now" context hook: one short AI call that grounds the article
  // in the publish date's current world. The hook is injected into the main
  // generation prompt so at least one sentence exists that could not have been
  // written six months ago. Non-blocking — falls back to null on any error.
  const contextHook = await fetchContextHook(env, now, forcedEvent);

  let content = null;
  let pillars = [];
  let personImages = [];
  let eventImages = [];
  const MAX_CONTENT_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_CONTENT_ATTEMPTS; attempt++) {
    content =
      attempt === 1
        ? await callWorkersAI(
            env,
            now,
            takenAllTime,
            activeModel,
            forcedEvent,
            preferredPillars,
            contextHook,
            recentPillars,
          )
        : content;

    // Post-generation banned phrase scan + targeted fix pass.
    // If violations are found, one focused AI call patches only the offending paragraphs.
    // Falls back to original paragraphs if the fix call fails or produces worse output.
    const violations = scanBannedPhrases(content);
    if (violations.length > 0) {
      content = await fixBannedPhrases(env, content, violations);
    }

    // SEO expert review: improve meta fields, descriptions, keywords, and paragraph
    // sentence length before building HTML. Falls back to original on any error.
    content = await reviewContentWithSEOExpert(content, env);

    // Fact-check pass: verify date, year, location against the event name.
    // Applies corrections in-place; never blocks generation on failure.
    await factCheckContent(env, content);

    // Eyewitness quote validation: confirm the quote is from a verifiable source.
    // Clears eyewitnessQuote if the AI cannot confirm documented provenance,
    // preventing fabricated quotes from being published under real names.
    await validateEyewitnessQuote(env, content);

    // Pillar classification: assign article to 1–3 content pillars for topical
    // authority tracking and "You Might Also Like" relevance. Non-blocking.
    pillars = await classifyPillars(env, content);

    // Validate the main image first. If force-image was provided, use it directly.
    const workingImage = forceImage || await resolveWorkingImageForContent(content);
    if (!workingImage) {
      if (attempt < MAX_CONTENT_ATTEMPTS) {
        const avoid = [...takenAllTime, content.title].filter(Boolean);
        console.warn(
          `Blog AI: no valid image for "${content.title}". Regenerating content (${attempt + 1}/${MAX_CONTENT_ATTEMPTS}).`,
        );
        content = await callWorkersAI(
          env,
          now,
          avoid,
          activeModel,
          forcedEvent,
          preferredPillars,
          contextHook,
          recentPillars,
        );
        continue;
      }

      // No working image found after all attempts — throw so the caller retries
      // with a different topic rather than publishing with a logo background.
      throw new Error(
        `No working image for "${content.title}" after ${MAX_CONTENT_ATTEMPTS} attempts.`,
      );
    }
    content.imageUrl = workingImage;

    // Precheck wiki image coverage before publishing. The video pipeline needs
    // at least 3 usable Wikipedia images, so weak topics are regenerated here.
    [personImages, eventImages] = await Promise.all([
      fetchKeyPersonImages(env, content.keyTerms).catch(() => []),
      content.wikiUrl
        ? fetchEventImages(content.wikiUrl, content.imageUrl, 3).catch(() => [])
        : Promise.resolve([]),
    ]);
    const wikiImageTotal = personImages.length + eventImages.length;
    if (wikiImageTotal < 3) {
      if (attempt < MAX_CONTENT_ATTEMPTS) {
        const avoid = [...takenAllTime, content.title].filter(Boolean);
        console.warn(
          `Blog AI: wiki image precheck failed for "${content.title}" (${wikiImageTotal}/3). Regenerating content (${attempt + 1}/${MAX_CONTENT_ATTEMPTS}).`,
        );
        content = await callWorkersAI(
          env,
          now,
          avoid,
          activeModel,
          forcedEvent,
          preferredPillars,
          contextHook,
          recentPillars,
        );
        continue;
      }

      throw new Error(
        `IMAGE_UNAVAILABLE: wiki-only topic gate requires 3 usable Wikipedia images, got ${wikiImageTotal} for "${content.title}"`,
      );
    }

    // P4b — separate editorial note: a second isolated AI call that reads the
    // finished article and writes a perspective section that must reference the
    // current year. This creates structural differentiation between the research
    // layer (article body) and the perspective layer (editorial note).
    // Non-blocking — keeps existing editorialNote on any error.
    await generateEditorialNote(env, content, now);
    break;
  }

  // Ensure meta description meets minimum SEO length (120 chars).
  // Prefer the first sentence of the overview paragraph — specific and fact-dense.
  // Avoid the "Discover the story of…" boilerplate which AI engines treat as low-signal.
  if (!content.description || content.description.length < 120 || /^Discover the story of /i.test(content.description)) {
    const overviewLead = String(content.overviewParagraphs?.[0] || "")
      .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const firstSentence = overviewLead.split(/(?<=[.!?])\s+/)[0] || "";
    if (firstSentence.length >= 60) {
      content.description = firstSentence.length > 155
        ? firstSentence.substring(0, 152).trimEnd() + "..."
        : firstSentence;
    } else {
      // Factual fallback: "EventTitle (Date, Location): Significance."
      const sig = (content.quickFacts || []).find((f) => /significance|legacy|impact/i.test(f.label))?.value || "";
      const loc = content.location ? `, ${content.location}` : "";
      content.description = `${content.eventTitle} (${content.historicalDate}${loc})${sig ? `: ${sig}.` : "."}`.substring(0, 155);
    }
  }
  // Clamp meta description to 155 chars maximum (Google truncates beyond this)
  if (content.description.length > 155) {
    content.description =
      content.description.substring(0, 152).trimEnd() + "...";
  }
  if (!content.ogDescription || content.ogDescription.length < 80) {
    content.ogDescription = content.description.substring(0, 130);
  }
  if (content.ogDescription.length > 130) {
    content.ogDescription =
      content.ogDescription.substring(0, 127).trimEnd() + "...";
  }
  if (!content.twitterDescription || content.twitterDescription.length < 60) {
    content.twitterDescription = content.description.substring(0, 120);
  }
  if (content.twitterDescription.length > 120) {
    content.twitterDescription =
      content.twitterDescription.substring(0, 117).trimEnd() + "...";
  }

  const slug = buildSlug(now);

  // Fetch book cover in parallel with the final HTML assembly.
  const bookCoverUrl = await fetchBookCover(content.bookSearchQuery).catch(() => null);

  const rawHtml = buildPostHTML(content, now, slug, existingIndex, pillars, bookCoverUrl);
  let html = injectLinks(rawHtml, content.keyTerms, existingIndex, content.eventTitle);
  html = injectPersonImages(html, personImages);
  if (eventImages.length > 0) html = injectEventImages(html, eventImages);

  // Persist the rendered page (no expiry — permanent archive)
  await env.BLOG_AI_KV.put(`${KV_POST_PREFIX}${slug}`, html);

  // Update the index (reuse the already-loaded existingIndex)
  const index = [...existingIndex];

  // Add or update the index entry for this slug — remove ALL existing entries
  // for this slug first to prevent duplicates accumulating from retries/restores
  const deduped = index.filter((e) => e.slug !== slug);
  const entry = {
    slug,
    title: content.title,
    description: content.description,
    imageUrl: content.imageUrl,
    publishedAt: now.toISOString(),
    ...(content.keywords ? { keywords: content.keywords } : {}),
    ...(content.eventTitle ? { eventTitle: content.eventTitle } : {}),
    ...(Number.isInteger(content.historicalYear)
      ? { historicalYear: content.historicalYear }
      : {}),
    ...(Array.isArray(content.keyTerms) && content.keyTerms.length > 0
      ? { keyTerms: content.keyTerms }
      : {}),
    ...(pillars && pillars.length > 0 ? { pillars } : {}),
    ...(content.contentRationale
      ? { contentRationale: content.contentRationale }
      : {}),
  };
  deduped.unshift(entry);
  const finalIndex = deduped;
  // Cap the index at 200 entries
  if (finalIndex.length > 200) finalIndex.splice(200);
  await env.BLOG_AI_KV.put(KV_INDEX_KEY, JSON.stringify(finalIndex));

  // Core write is done — fire all post-publish extras in the background so
  // the response (or cron return) is not blocked by quiz generation, cache
  // purges, pings, or Discord. ctx may be undefined in unit tests — guard it.
  if (ctx?.waitUntil) {
    ctx.waitUntil(runPostPublishExtras(env, slug, content));
  } else {
    // Fallback for environments without ctx (e.g. tests): run synchronously
    await runPostPublishExtras(env, slug, content);
  }

  console.log(
    `Blog: published post "${content.title}" → /blog/${slug}/`,
  );
}

/**
 * All non-critical post-publish work: cache purges, quiz generation,
 * quiz page cache bust, WebSub ping, Discord notify.
 * Runs via ctx.waitUntil() so it never blocks the HTTP response / cron return.
 */
async function runPostPublishExtras(env, slug, content) {
  // Purge the cached sitemap and RSS feed so they reflect the new post immediately
  // (both workers cache for 1 h — without this, the new post would be invisible
  //  to crawlers until the next cache expiry).
  const cache = caches.default;
  await Promise.allSettled([
    cache.delete(new Request("https://thisday.info/sitemap.xml")),
    cache.delete(new Request("https://thisday.info/rss.xml")),
    cache.delete(new Request("https://thisday.info/news-sitemap.xml")),
    // Optional: ping search engines so they discover sitemap updates faster.
    fetch("https://thisday.info/search-ping", {
      method: "POST",
      headers: env.SEARCH_PING_SECRET
        ? { Authorization: `Bearer ${env.SEARCH_PING_SECRET}` }
        : {},
    }),
  ]);

  // Generate and store a quiz using the already-available content (no self-fetch round-trip that
  // can fail due to KV replication delay right after publishing)
  try {
    const allParas = [
      ...(content.overviewParagraphs || []),
      ...(content.eyewitnessOrChronicle || []),
      ...(content.aftermathParagraphs || []),
      ...(content.conclusionParagraphs || []),
    ];
    const enrichedContent = {
      ...content,
      keyFacts: allParas
        .filter((p) => p && p.length > 40 && p.length < 400)
        .slice(0, 12),
      description:
        content.description || allParas.slice(0, 3).join(" ").substring(0, 800),
    };
    const quiz = await generateBlogQuiz(env, enrichedContent, slug);
    if (quiz) {
      await env.BLOG_AI_KV.put(`quiz-v3:blog:${slug}`, JSON.stringify(quiz), {
        expirationTtl: 90 * 86_400,
      });
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
        await env.EVENTS_KV.delete(`quiz-page-v30:${mPad}-${dPad}`);
        console.log(`Blog: busted quiz-page-v30:${mPad}-${dPad} cache`);
      }
    } catch (e) {
      console.error("Blog: quiz page cache bust failed:", e);
    }
  }

  // Ping WebSub hub so Flipboard (and other subscribers) get notified immediately
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

  // Notify Discord that a new post has been published (silent no-op if not configured).
  // Set DISCORD_WEBHOOK_URL via:  npx wrangler secret put DISCORD_WEBHOOK_URL --config wrangler-blog.jsonc
  if (env.DISCORD_WEBHOOK_URL) {
    try {
      const postUrl = `https://thisday.info/blog/${slug}/`;
      const message =
        `📰 **New blog post published**\n` +
        `📖 ${content.title}\n` +
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

// ---------------------------------------------------------------------------
// Blog quiz generation
// ---------------------------------------------------------------------------

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
  if (!env.AI && !env.GROQ_API_KEY) return questions;

  const contextLines = [
    `Title: ${content.title}`,
    content.historicalDate ? `Date: ${content.historicalDate}` : "",
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
    raw = await callAI(
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
  if (
    !Array.isArray(improved) ||
    improved.length !== questions.length ||
    !improved.every(
      (q) =>
        typeof q.q === "string" &&
        q.q.trim().length > 10 &&
        Array.isArray(q.options) &&
        q.options.length === 4 &&
        q.options.every((o) => typeof o === "string" && o.trim().length > 2) &&
        Number.isInteger(q.answer) &&
        q.answer >= 0 &&
        q.answer <= 3 &&
        typeof q.explanation === "string" &&
        q.explanation.trim().length > 8,
    )
  ) {
    console.warn("Quiz expert: validation failed — using original questions");
    return questions;
  }

  console.log("Quiz expert: questions reviewed and sharpened");
  return improved;
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
  if (!env.AI && !env.GROQ_API_KEY) return null;

  const contextLines = [
    `Title: ${content.title}`,
    `Event: ${content.eventTitle} on ${content.historicalDate}`,
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
    raw = await callAI(
      env,
      [
        {
          role: "system",
          content:
            "You are a history quiz creator. Always respond with valid JSON only, no markdown, no extra text.",
        },
        {
          role: "user",
          content: `Generate a 5-question multiple choice quiz based on this historical blog post.\n\nContext:\n${contextLines.join("\n")}\n\nRules:\n- Exactly 5 questions, no more no less\n- Each question has exactly 4 options (never fewer, never more)\n- Exactly one correct answer per question (0-based index in "answer", must be 0, 1, 2, or 3)\n- Question types must vary: include at least one each of Who, What, Why/How, When/Where\n- Questions must progress: 1 easy recall, 2 medium analysis, 2 challenging synthesis\n- Draw from ALL Fact lines — do not repeat the same topic twice\n- Wrong options must be plausible but clearly incorrect; no trick questions\n- Each question must include a short "explanation" field (1-2 sentences) explaining why the answer is correct\n- All strings must be non-empty and longer than 5 characters\n- Output ONLY valid JSON, no markdown:\n{"questions":[{"q":"Question?","options":["A","B","C","D"],"answer":0,"explanation":"Why this answer is correct."}]}`,
        },
      ],
      { maxTokens: 1500, timeoutMs: 25_000 },
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
  const valid = parsed.questions.filter(
    (q) =>
      q.q &&
      typeof q.q === "string" &&
      q.q.trim().length > 10 &&
      Array.isArray(q.options) &&
      q.options.length === 4 &&
      q.options.every((o) => typeof o === "string" && o.trim().length > 2) &&
      Number.isInteger(q.answer) &&
      q.answer >= 0 &&
      q.answer <= 3 &&
      q.explanation &&
      typeof q.explanation === "string" &&
      q.explanation.trim().length > 8,
  );
  if (valid.length !== 5) return null;
  const sharpened = await reviewQuizWithExpert(valid, content, env);
  return { ...parsed, questions: sharpened };
}

// ---------------------------------------------------------------------------
// Claude API call
// ---------------------------------------------------------------------------

async function callWorkersAI(
  env,
  date,
  takenThisMonth = [],
  model = CF_AI_MODEL,
  forcedEvent = null,
  preferredPillars = [],
  contextHook = null,
  recentPillars = [],
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

  const contextHookSection = contextHook
    ? `\nCURRENT-WORLD CONTEXT (mandatory): The following hook connects this historical event to today's world as of the publish date. You MUST weave at least one sentence from this angle into the article — specifically into the conclusionParagraphs or editorialNote. The sentence must feel grounded in the present, not generic. Do not quote the hook verbatim; use it as a lens:\n"${contextHook}"\n`
    : "";

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

  const prompt = `You are a historical content writer for "thisDay.info", a website about historical events.
${contextHookSection}
STRICT DATE REQUIREMENT: You MUST write about an event that occurred on ${monthName} ${day} ONLY. The event must have taken place in the month of ${monthName} on day ${day}. Events from ANY other month or day are strictly forbidden. Before choosing an event, verify it happened on ${monthName} ${day}. If you are not certain an event occurred on ${monthName} ${day}, choose a different event you are confident about.

${eventSelection}
${avoidSection}
The article must be substantial — at least 1,500 words of body content across all paragraph fields combined. Every paragraph must earn its place with real historical depth, not filler.

VOICE AND PERSONALITY — this is the most important instruction:
Write like a passionate history obsessive who has spent weeks researching this event and genuinely cannot believe more people do not know about it. You have opinions. You find things surprising, tragic, infuriating, or inspiring, and you say so. You are not a textbook. You are not a Wikipedia summary. You are a storyteller who happens to know an enormous amount of history.
Write as a passionate, opinionated history narrator — serious and authoritative, never casual or colloquial. Do not write like you are texting or chatting. Assume the reader is intelligent but has never heard of this event. Explain every proper noun on its first mention with one short inline phrase — enough to orient the reader without a digression.

Specific voice qualities:
- PLAY YOUR ACE CARD FIRST: The single most surprising, counterintuitive, or little-known fact in the entire article belongs in the first two sentences. Do not save the best for the end. Most readers will not reach it.
- FOCUS ON ONE THREAD: Do not try to cover everything about the event. Find the sharpest angle — one person, one decision, one consequence — and pull that thread through the whole article. Breadth kills impact.
- MULTI-SENSORY writing: Do not describe only what something looked like. What did it sound like? What did it smell like? What did it feel like physically? Include at least one non-visual sensory detail in the Overview and one in the Eyewitness section.
- NEVER make a summary mood judgment. Do not write "it was a dark time", "it was a difficult period", "it was chaotic", "it was a bleak time", or any sentence that labels a mood without evidence. Describe the specific thing that is dark, difficult, or chaotic — what someone would see, hear, smell, or feel on the ground — and let the reader draw the conclusion themselves. The writer plants the evidence; the reader forms the judgment.
- FRESH COMPARISONS ONLY: Do not use stock idioms or pre-made comparisons. "As hot as hell" is dead from overuse. Write a fresh, specific comparison that could only come from this event: "as chaotic as a harbor pilot trying to dock in a force-9 gale" is better than "utterly chaotic."
- Have a point of view. If a leader made a cowardly decision, say so. If an act was unexpectedly brave, say so. Readers come for analysis, not neutrality.
- Use transitions that show your thinking: "What makes this stranger still is...", "Here is what the textbooks skip over:", "The irony is remarkable:", "Most people assume X, but the reality was Y."
- Connect the past to something the reader recognizes. A parallel to a modern situation, a personality trait that feels familiar, a consequence we still live with today.
- You are a guide traveling alongside the reader, not a sage on a podium dispensing wisdom. Share in the discovery.

Sentence and paragraph rules:
- Mix sentence lengths deliberately for rhythm. Some sentences can be 30+ words when building a complex, layered point. Use short sentences (under 10 words) for emphasis and dramatic beats. Never write five consecutive sentences of the same length.
- VARY SENTENCE FORMS, not just lengths. If one sentence is conditional ("If X, then Y"), the next should be a short declarative. Follow that with a cause-and-effect. Never write three consecutive sentences with the same grammatical structure — structural repetition kills energy even when length varies.
- Target an average of 18-22 words per sentence across each paragraph. This creates readable depth without choppiness.
- Every paragraph must contain at least one specific, verifiable fact: a real name, an exact year or number, a specific place, or a direct quote. No paragraph may consist entirely of vague generalizations.
- FACT FIRST IN EVERY SECTION: The first sentence of Overview, Eyewitness Accounts, Aftermath, and Legacy must state the key fact before any scene-setting. Answer the implied reader question immediately, then expand.
- NO REPETITION ACROSS SECTIONS: Each paragraph must introduce new information. Never restate a point, conclusion, or fact already made in a previous section. Do not name the same person, institution, or concept more than three times in the full article — use pronouns or contextual references after the first mention.
- Include at least one clear "what would need to be true for this to be wrong" check somewhere in the article when you make a strong claim.
- Start with the takeaway, then walk backward to the evidence. Avoid "Picture..." and "This was not some minor accident." Write like a human: a little uneven, a little opinionated, and not overly polished.
- Avoid semicolons. If absolutely necessary, use at most one semicolon in a paragraph.
- ABSOLUTE BAN ON DASHES: Never use "-" or "—" anywhere in the article body. Not mid-sentence, not at the end of a clause, not anywhere. Zero dashes in the entire text. Use a comma, or split into two sentences.
- Use active voice. Say who did what.
- Start each paragraph with a sentence that makes the reader want to keep reading.
- Use transition phrases between paragraphs: "What followed was even more remarkable.", "But the real damage was done quietly, in the years after.", "To understand why this mattered, you have to go back further."
- When nuance or complication enters a paragraph, represent it at its strongest — give the best version of the opposing case, not the weakest. Do not signal you are doing this with phrases like "critics argue" or "some would say." Just write it directly as part of the narrative flow: "Nehru rejected the resolution not because he dismissed Muslim concerns, but because he believed division would harden them into interstate conflict." Strong nuance woven naturally is far more persuasive than a weak position you announce and dismiss.

BANNED PHRASES — never write any of these:
"significant event", "pivotal moment", "changed history", "shaped the course of", "left a lasting impact", "cannot be overstated", "one of the most important", "it is worth noting", "it is important to remember", "this was a time of great change", "the importance of this", "a reminder of", "shows the importance of", "demonstrated the power of", "it was a dark time", "it was a bleak time", "it was a difficult period", "it was chaos", "it was a complex time", "dark chapter". These are filler. Replace them with the specific fact or analysis that the phrase was trying to avoid writing.

HARD RULE — NO RHETORICAL QUESTIONS: Do not write a single sentence in the form of a question directed at the reader. Not one. This includes: "But why was it significant?", "What were they thinking?", "What happened next?", "So, what happened?", "What does this tell us?", "What if King Faisal had lived?", "What were the consequences?", "Did it work?", or any variation. Every question you are tempted to write must be rewritten as a declarative statement that answers itself. Example: instead of "What were the consequences?" write "The consequences were immediate and lasting." Before submitting your response, scan every sentence — if any sentence ends with a question mark and is addressed to the reader, rewrite it.

HARD RULE — NO FAKE SUSPENSE OPENERS: Do not start any sentence with: "So,", "Picture this", "Picture the scene", "And then,", "But what", "But why", "You have to understand", "Nobody expected", "Frankly", "Which, frankly". These are conversational filler. State the fact directly.

DO NOT open consecutive paragraphs with the same word or conjunction. Each paragraph must begin with a structurally different sentence.

Title rules:
- The "title" field MUST follow exactly this format: "[Specific Action or Event] — ${monthName} ${day}, Year"
- The first part must be the specific historical event name (e.g. "Assassination of Julius Caesar", "Apollo 11 Moon Landing", "Fall of Constantinople").
- Do NOT use colloquial date names or phrases like "Ides of March", "D-Day", or "Black Tuesday" as the title — use the actual event name instead.
- The separator between event name and date MUST be " — " (space, em dash, space).

Reply with ONLY a raw JSON object. No markdown, no code fences, no explanation — just the JSON.

{
  "title": "Specific Event Name — ${monthName} ${day}, Year",
  "eventTitle": "Short event name",
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
    { "label": "Significance", "value": "Why it matters" },
    { "label": "Legacy", "value": "Long-term impact" }
  ],
  "didYouKnowFacts": [
    "A genuinely surprising lesser-known fact — something most people would not expect, 2 to 3 sentences, minimum 40 words. Must include a specific name, number, or place.",
    "A detail that reframes the main story or reveals a hidden layer of complexity, 2 to 3 sentences, minimum 40 words.",
    "A fact that connects the event to something unexpected — a consequence, a coincidence, or a strange footnote, 2 to 3 sentences, minimum 40 words."
  ],
  "overviewParagraphs": [
    "Paragraph 1 (claim + strongest evidence; ~120+ words): Open with a striking scene, a concrete detail, or a blunt declarative statement — never with a rhetorical question. State the core claim directly. Include the single strongest, attributable piece of evidence (name, year, number, or place) that supports it. No chatty openers like 'So, what happened' or 'For starters'. Start with the most important thing.",
    "Paragraph 2 (nuance + synthesis; ~100 words): Introduce the strongest complication or contrary reality as part of the narrative — not as a rhetorical question or a 'But why?' setup. State the complication directly as a fact or claim, then synthesize. Do NOT begin with 'But the [topic] wasn't without...' or 'But why was it...'. End with a precise assessment that links back to the opening claim."
  ],
  "eyewitnessOrChronicle": [
    "Paragraph 1 (vivid account + source criticism; ~100+ words): Present the most vivid contemporary account with full attribution (name, role, source). Then interrogate the source: why was this person present, what stake did they have in how the event was remembered, what biases or blind spots might they carry (insider, foreign observer, someone currying favor or evading blame), and what does the account leave out that you would expect it to address?",
    "Paragraph 2 (contrast + what the record reveals; ~100+ words): Offer a contrasting account or later scholarly appraisal. Explain what the gap between the two perspectives reveals about who controlled the narrative, whose version survived, and why. A modern historian reads these sources differently than their intended audience did. End with what historians now agree on or still dispute, and why the disagreement matters."
  ],
  "eyewitnessQuote": "A direct or closely paraphrased quote from a named contemporary source, under 200 characters. Must be attributed to a real person or document.",
  "eyewitnessQuoteSource": "Full attribution: name, role, source document, and year, plus one phrase noting the circumstances under which it was written (e.g. 'written under censorship', 'published posthumously', 'testimony given under oath'). Example: 'Ivan Turgenev, letter to a friend, March 1861, written in exile'",
  "aftermathParagraphs": [
    "Paragraph 1 (immediate aftermath; ~120+ words): Describe the first days and weeks after the event with concrete actions, dates, and effects on people and institutions. Focus on specific, attributable changes on the ground.",
    "Paragraph 2 (medium-term + long view synthesis; ~120+ words): Combine medium-term consequences and the long historical assessment: reforms, responses, and how historians judge the legacy. Be specific and, where appropriate, opinionated."
  ],
  "conclusionParagraphs": [
    "Paragraph 1 (honest assessment; ~100+ words): State plainly what the event changed and what remained unchanged. Name the specific people, institutions, or ideas that were different afterward, and name what surprised historians about the outcome. Avoid vague grandiosity.",
    "Paragraph 2 (reframing close; ~80+ words): End with a specific fact, contradiction, or detail that reframes everything the reader just learned — the kind of thing that makes someone put the article down and think. Not a call to reflection, not a generic statement about the importance of history. A concrete surprising detail that lands. The final sentence must be short, direct, and self-contained."
  ],
  "analysisGood": [
    { "title": "Concise label (3-5 words)", "detail": "Minimum 60 words. Name who deserves credit and why. Describe the specific decision, action, or circumstance that worked, what the alternatives were, and why this outcome was not guaranteed. No generic praise." },
    { "title": "Concise label (3-5 words)", "detail": "Minimum 60 words. Same standard — specific, analytical, opinionated." },
    { "title": "Concise label (3-5 words)", "detail": "Minimum 60 words. Same standard." }
  ],
  "analysisBad": [
    { "title": "Concise label (3-5 words)", "detail": "Minimum 60 words. Name who is responsible. Describe the specific failure, what the stakes were, and what a better decision would have looked like. Do not be vague or diplomatic." },
    { "title": "Concise label (3-5 words)", "detail": "Minimum 60 words. Same standard." },
    { "title": "Concise label (3-5 words)", "detail": "Minimum 60 words. Same standard." },
    { "title": "Optional: a systemic or institutional failure", "detail": "Minimum 60 words. The failure that no single person owned but that shaped the outcome nonetheless." }
  ],
  "editorialNote": "Minimum 80 words. A frank, first-person-plural editorial reflection from the thisDay. team. Start with 'What strikes us about this is...' or 'We keep coming back to one thing:' or a similarly direct opening. Say something that the body of the article could not quite say — an honest opinion about what this event reveals about power, human nature, or the gap between how history is remembered and what actually happened. No hedging. No 'it is important to remember'. Say the thing.",
  "keyTerms": [
    { "term": "Exact phrase as it appears in the article text", "wikiUrl": "https://en.wikipedia.org/wiki/Exact_Article", "type": "person" },
    { "term": "Another key person, place, or event named in the article", "wikiUrl": "https://en.wikipedia.org/wiki/Another_Article", "type": "event" },
    "provide 5 to 8 entries total — key people, battles, organizations, treaties, or places that appear verbatim in the article body; type must be one of: person, place, event, organization"
  ],
  "wikiUrl": "https://en.wikipedia.org/wiki/Article",
  "youtubeSearchQuery": "specific event name year history documentary",
  "bookSearchQuery": "3-5 word search query optimised for finding books about this specific event on eBay and Open Library. Example: 'italian invasion ethiopia 1935'.",
  "contentRationale": "Minimum 40 words. Answer this specific question: what does a reader find in this article that Wikipedia's entry on the same event does not already give them? Name the specific angle, the particular framing, the overlooked detail, or the editorial judgement that makes this article worth reading over the Wikipedia source. Do not be vague. Do not say 'deeper context' or 'engaging narrative'."
}`;

  const rawValue = await callAI(
    env,
    [
      {
        role: "system",
        content:
          "You are a historical content writer. Always respond with valid JSON only, no markdown, no extra text.",
      },
      { role: "user", content: prompt },
    ],
    { maxTokens: 4096, timeoutMs: 60_000, cfModel: model },
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

  // Extract the first {...} block in case the model adds surrounding text
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch)
    throw new Error(`No JSON found in model output: ${rawValue.slice(0, 200)}`);

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error(
      `JSON parse failed: ${e.message} — Raw: ${rawValue.slice(0, 300)}`,
    );
  }

  // Enforce that the title always follows the format "Event Name — Month Day, Year".
  // The AI sometimes omits the date, uses wrong format, or uses colloquial date names.
  const year = parsed.historicalYear ?? date.getFullYear();
  const expectedDateSuffix = `${monthName} ${day}, ${year}`;
  const hasSeparator = parsed.title && parsed.title.includes(" — ");
  // Also rebuild if the event part (before " — ") doesn't exactly match eventTitle —
  // catches cases like "Ides of March Assassination of Julius Caesar — …" where the
  // AI prefixed a colloquial name before the real event name.
  const eventPart = hasSeparator ? parsed.title.split(" — ")[0].trim() : "";
  const eventPartMismatch =
    parsed.eventTitle && eventPart !== parsed.eventTitle.trim();
  if (
    !parsed.title ||
    !parsed.title.includes(monthName) ||
    !hasSeparator ||
    eventPartMismatch
  ) {
    const cleanTitle = (
      parsed.eventTitle ??
      eventPart ??
      parsed.title ??
      "Untitled"
    ).trim();
    parsed.title = `${cleanTitle} — ${expectedDateSuffix}`;
  }

  enforceAnswerFirstSections(parsed);

  return parsed;
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

    const prompt =
      `You are the thisDay. editorial team writing a short opinion note to appear at the end of the article below.\n\n` +
      `ARTICLE:\n${articleSummary}\n\n` +
      `YOUR TASK:\n` +
      `Write a first-person-plural editorial note (100–150 words) that:\n` +
      `1. Opens with "What strikes us about this is..." or "We keep coming back to one thing:" or a similarly direct opener\n` +
      `2. Makes a specific connection to something happening in ${year} — name it (a conflict, a political situation, a technological shift, a cultural moment). Be concrete, not vague.\n` +
      `3. Says something the article body could not quite say — an honest opinion about what this event reveals about power, human nature, or the gap between how history is remembered vs what actually happened\n` +
      `4. Ends with one precise, memorable sentence\n\n` +
      `ABSOLUTE RULES:\n` +
      `- No hedging. No "it is important to remember". No "this serves as a reminder".\n` +
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
async function factCheckContent(env, content) {
  const prompt =
    `You are a strict historical fact-checker. Given the article data below, identify any clear factual errors.\n` +
    `Focus ONLY on: whether the event date/year matches the event name, and whether the location is correct.\n` +
    `Do NOT invent errors. Only flag what you are confident is wrong based on well-established historical fact.\n\n` +
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

      // Plausibility guard — reject year corrections more than 10 years off the
      // original to prevent hallucinated rewrites from corrupting the post.
      if (
        typeof cor.historicalYear === "number" &&
        typeof content.historicalYear === "number" &&
        Math.abs(cor.historicalYear - content.historicalYear) > 10
      ) {
        console.warn(
          `factCheck: year correction rejected (${content.historicalYear} → ${cor.historicalYear} exceeds ±10 yr window)`,
        );
        delete cor.historicalYear;
      }

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
      return null;
    }
    console.log(`classifyPillars: assigned [${valid.join(", ")}]`);
    return valid;
  } catch (err) {
    console.warn(`classifyPillars: skipped — ${err.message}`);
    return null;
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
 * description / ogDescription / twitterDescription / keywords / imageAlt,
 * then does targeted string replacements on the HTML.
 * Returns { updatedHtml, changed: string[], newDescription: string|null }.
 */
async function patchSEOMeta(html, _slug, env) {
  const getMeta = (re) => (html.match(re) || [])[1] || "";

  const currentTitle = getMeta(/<title>([^<]+) \| thisDay\.<\/title>/);
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
  const currentImageAlt = getMeta(
    /<meta name="twitter:image:alt" content="([^"]*?)"\s*\/>/,
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
    imageAlt: currentImageAlt,
  };

  const improved = await reviewSEOMetaOnly(minContent, env);

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

  patch(
    currentImageAlt,
    improved.imageAlt,
    /<meta name="twitter:image:alt" content="[^"]*?"\s*\/>/,
    `<meta name="twitter:image:alt" content="${esc(improved.imageAlt)}" />`,
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
 * Focused SEO-only AI call — improves only the 5 meta fields.
 * No paragraph rewriting. Falls back to original on any error.
 */
async function reviewSEOMetaOnly(content, env) {
  if (!env.AI && !env.GROQ_API_KEY) return content;

  const systemPrompt =
    "You are a senior SEO editor. Improve only these 5 fields for a historical blog post:\n" +
    "- description: 120–155 chars, start with year + event name, include location, specific hook\n" +
    "- ogDescription: 100–130 chars, curiosity-driven, makes people click\n" +
    "- twitterDescription: 90–120 chars, punchy, present-tense energy\n" +
    "- keywords: 5–8 comma-separated, specific — year, location, person names, historical context\n" +
    "- imageAlt: vivid 8–15 word phrase describing what is visible in the image\n\n" +
    "Rules: output ONLY valid JSON with the fields that need improvement. Omit unchanged fields. " +
    "Do not change title, content, or any other field.";

  const userMessage =
    `Title: ${content.title}\n` +
    `Event: ${content.eventTitle} on ${content.historicalDate} in ${content.location || "unknown"}\n` +
    `description: ${content.description}\n` +
    `ogDescription: ${content.ogDescription || ""}\n` +
    `twitterDescription: ${content.twitterDescription || ""}\n` +
    `keywords: ${content.keywords || ""}\n` +
    `imageAlt: ${content.imageAlt || ""}\n\n` +
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
    "imageAlt",
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
 *   - imageAlt descriptiveness
 *   - keywords relevance and specificity
 *   - Sentence length across all paragraph arrays (flags if avg > 20 words)
 *   - Content clarity, active voice, and readability signals
 *   - Title format and keyword alignment
 *
 * Returns the improved content object. Falls back to original on any error.
 */
async function reviewContentWithSEOExpert(content, env) {
  if (!env.AI && !env.GROQ_API_KEY) return content;

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
    "'had a profound impact', 'turning point', 'watershed moment', 'throughout history'\n" +
    "- Makes a mood judgment without observable evidence ('it was brutal' with no detail of what the brutality was)\n" +
    "- Restates a point already made in a previous paragraph\n" +
    "When rewriting: add the specific fact being avoided, replace mood labels with concrete observable detail, " +
    "open with a striking fact or consequence. Preserve paragraph count exactly.\n\n" +
    "JOB 2 — HUMAN VOICE:\n" +
    "Make every paragraph sound like a serious, authoritative narrator, not an AI assistant.\n" +
    "- Use contractions naturally where they fit: 'didn't', 'wasn't', 'couldn't'\n" +
    "- Vary sentence structure: avoid three consecutive sentences with the same grammatical opener\n" +
    "- Delete AI connectors: 'Furthermore', 'Moreover', 'Additionally', 'In conclusion', 'Notably', 'Significantly'\n" +
    "- Vary paragraph openers: some start with subject, some with time/place, some with consequence\n" +
    "PROHIBITIONS: No rhetorical questions to the reader. No 'Picture this', 'So,', 'You have to understand'. " +
    "No sentence fragments as a style device. No casual speech: 'That's the thing', 'It's a shame, really', 'He saw it all'.\n\n" +
    "PUNCTUATION: Never use hyphens (-) or em dashes (—). Use a comma or split into two sentences.\n\n" +
    "Return ONLY a JSON object with the paragraph arrays that needed improvement. " +
    "Omit arrays that are already good. Preserve array lengths exactly.\n" +
    "Example: {\"overviewParagraphs\":[\"para1\",\"para2\"]}";

  const paraUserMessage =
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
    "- description: 120–155 chars, open with year and event, include location and a specific hook\n" +
    "- ogDescription: 100–130 chars, curiosity-driven, give readers a reason to click\n" +
    "- twitterDescription: 90–120 chars, punchy, present-tense energy\n" +
    "- keywords: 5–8 specific terms including year, location, key people, historical context\n" +
    "- imageAlt: vivid 8–15 word description of what is visible in the image\n" +
    "- title: keep format 'Event Name — Month Day, Year'. Only change event name if vague or generic.\n\n" +
    "Return ONLY a JSON object with fields that need improvement. Omit fields that are already good.";

  const seoUserMessage =
    `Title: ${content.title}\n` +
    `Event: ${content.eventTitle} on ${content.historicalDate} in ${content.location || "unknown"}\n` +
    `description: ${content.description || ""}\n` +
    `ogDescription: ${content.ogDescription || ""}\n` +
    `twitterDescription: ${content.twitterDescription || ""}\n` +
    `keywords: ${content.keywords || ""}\n` +
    `imageAlt: ${content.imageAlt || ""}`;

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
    "title",
    "description",
    "ogDescription",
    "twitterDescription",
    "keywords",
    "imageAlt",
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

  // Guard: if the expert changed the title, make sure format is still correct
  if (improved.title !== content.title) {
    if (
      !improved.title.includes(" — ") ||
      !improved.title.includes(
        content.historicalDate?.split(",")[1]?.trim() ?? "",
      )
    ) {
      improved.title = content.title; // revert bad title
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
      // Cache miss — fetch from Wikipedia and store (fire-and-forget write)
      const imageUrl = await fetchWikipediaImage(kt.term, kt.wikiUrl);
      if (!imageUrl) continue;
      env.BLOG_AI_KV.put(cacheKey, JSON.stringify({ imageUrl }), { expirationTtl: KV_PERSON_IMAGE_TTL }).catch(() => {});
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
async function fetchEventImages(wikiUrl, coverUrl, limit = 2) {
  if (!wikiUrl) return [];
  const ua = { "User-Agent": "thisday.info-blog/1.0 (https://thisday.info)" };
  const BAD = /\b(icon|logo|flag|map|seal|stub|arrow|bullet|blank|placeholder)\b/i;
  try {
    const title = decodeURIComponent((wikiUrl.split("/wiki/")[1] ?? "").split("#")[0]);
    if (!title) return [];

    const listRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=images&imlimit=30&format=json`,
      { headers: ua },
    );
    if (!listRes.ok) return [];
    const listData = await listRes.json();
    const page = Object.values(listData?.query?.pages ?? {})[0];
    const candidates = (page?.images ?? [])
      .map((i) => i.title)
      .filter((t) => /\.(jpe?g|png|webp)$/i.test(t) && !BAD.test(t));
    if (!candidates.length) return [];

    const piped = candidates.slice(0, 15).join("|");
    const infoRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(piped)}&prop=imageinfo&iiprop=url|size&format=json`,
      { headers: ua },
    );
    if (!infoRes.ok) return [];
    const infoData = await infoRes.json();

    const coverFile = coverUrl ? coverUrl.split("/").pop().split("?")[0].toLowerCase() : "";
    return Object.values(infoData?.query?.pages ?? {})
      .map((p) => ({
        url: p?.imageinfo?.[0]?.url ?? null,
        px: (p?.imageinfo?.[0]?.width ?? 0) * (p?.imageinfo?.[0]?.height ?? 0),
        w: p?.imageinfo?.[0]?.width ?? 0,
        h: p?.imageinfo?.[0]?.height ?? 0,
      }))
      .filter(({ url, w, h }) => {
        if (!url || w < 300 || h < 200) return false;
        return url.split("/").pop().split("?")[0].toLowerCase() !== coverFile;
      })
      .sort((a, b) => b.px - a.px)
      .slice(0, limit)
      .map(({ url }) => ({ name: "via Wikimedia", imageUrl: url, wikiUrl }));
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
    return `<figure style="float:${float};margin:${margin};max-width:min(200px,40%);clear:${float};">` +
      `<a href="${esc(wikiUrl)}" target="_blank" rel="noopener noreferrer">` +
      `<img src="/image-proxy?src=${encodeURIComponent(imageUrl)}&w=200&q=80"` +
      ` alt="${esc(name)}" loading="lazy" class="img-fluid rounded"` +
      ` style="display:block;width:100%;height:auto;">` +
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

  for (const anchor of SECTION_ANCHORS) {
    if (imageIdx >= eventImages.length) break;
    const anchorPos = html.indexOf(anchor);
    if (anchorPos === -1) continue;
    if (anchorPos - lastInjectedAt < MIN_GAP) continue;

    // Find the first <p> after this anchor
    const pPos = html.indexOf("<p", anchorPos);
    if (pPos === -1) continue;

    // Skip this section if a <figure already exists within MIN_GAP chars (person image already placed)
    const windowEnd = Math.min(pPos + MIN_GAP, html.length);
    const windowStart = Math.max(0, pPos - MIN_GAP);
    if (html.slice(windowStart, windowEnd).includes("<figure")) continue;

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
    `<figure style="float:right;margin:0 0 1.2rem 1.5rem;max-width:min(150px,35%);clear:right;">` +
    `<a href="${esc(wikiUrl)}" target="_blank" rel="noopener noreferrer">` +
    `<img src="/image-proxy?src=${encodeURIComponent(imageUrl)}&w=200&q=80"` +
    ` alt="${esc(name)}" loading="lazy" class="img-fluid rounded"` +
    ` style="display:block;width:100%;height:auto;">` +
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

/**
 * Builds the full blog post HTML page, matching the structure of existing
 * hand-written posts on thisday.info.
 */
function buildPostHTML(c, date, slug, allPosts = [], currentPillars = [], bookCoverUrl = null) {
  const monthName = MONTH_NAMES[date.getMonth()];
  const day = date.getDate();
  const publishYear = date.getFullYear();
  const canonicalUrl = `https://thisday.info/blog/${slug}/`;
  const publishedStr = `${monthName} ${day}, ${publishYear}`;

  const didYouKnowSlider = buildDidYouKnowSlider(c.didYouKnowFacts || []);

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

  const analysisGoodItems = (c.analysisGood || [])
    .map(
      (item) =>
        `                    <li class="mb-2"><strong>${esc(item.title)}:</strong> ${esc(item.detail)}</li>`,
    )
    .join("\n");

  const analysisBadItems = (c.analysisBad || [])
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

  const publishedDateISO = date.toISOString().split("T")[0];
  const jsonLd = JSON.stringify(
    {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      mainEntityOfPage: { "@type": "WebPage", "@id": canonicalUrl },
      headline: c.title,
      datePublished: publishedDateISO,
      dateModified: publishedDateISO,
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
        logo: {
          "@type": "ImageObject",
          url: "https://thisday.info/images/logo.png",
        },
      },
      description: c.jsonLdDescription || c.description,
      image: c.imageUrl,
      url: canonicalUrl,
      about: {
        "@type": "Event",
        name: c.jsonLdName || c.eventTitle,
        startDate: c.historicalDateISO || String(c.historicalYear),
        description: c.jsonLdDescription || c.description,
        location: {
          "@type": "Place",
          name: c.location,
          address: { "@type": "PostalAddress", addressCountry: c.country },
        },
        url: c.wikiUrl || c.jsonLdUrl,
        eventStatus: "https://schema.org/EventCompleted",
        organizer: { "@type": "Organization", name: c.organizerName },
      },
      ...(Array.isArray(c.keyTerms) && c.keyTerms.length > 0 && {
        mentions: c.keyTerms.map((kt) => ({
          "@type": kt.type === "person" ? "Person" : kt.type === "place" ? "Place" : kt.type === "organization" ? "Organization" : "Thing",
          name: kt.term,
          ...(kt.wikiUrl ? { sameAs: kt.wikiUrl } : {}),
        })),
      }),
    },
    null,
    2,
  );

  // BreadcrumbList: Home > Blog > [Pillar] > Article
  // Pillar level included only when currentPillars data is available.
  // Pillar hub URLs (/blog/topic/…/) will be live once P3b (hub pages) lands.
  const pillarSlug = (str) =>
    str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  const breadcrumbItems = [
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
    breadcrumbItems.push({
      "@type": "ListItem",
      position: 3,
      name: currentPillars[0],
      item: `https://thisday.info/blog/topic/${pillarSlug(currentPillars[0])}/`,
    });
  }
  breadcrumbItems.push({
    "@type": "ListItem",
    position: breadcrumbItems.length + 1,
    name: c.title,
    item: canonicalUrl,
  });
  const breadcrumbJsonLd = JSON.stringify(
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: breadcrumbItems,
    },
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
    <title>${esc(c.title)} | thisDay.</title>
    <link rel="canonical" href="${canonicalUrl}" />
    <meta name="robots" content="index, follow" />
    <meta name="author" content="thisDay. Editorial" />
    <meta name="description" content="${esc(c.description)}" />
    <meta name="keywords" content="${esc(c.keywords)}" />

    <!-- Open Graph -->
    <meta property="og:title" content="${esc(c.title)}" />
    <meta property="og:description" content="${esc(c.ogDescription || c.description)}" />
    <meta property="og:type" content="article" />
    <meta property="og:url" content="${canonicalUrl}" />
    <meta property="og:image" content="${esc(c.imageUrl ? `/image-proxy?src=${encodeURIComponent(c.imageUrl)}&w=1200&q=85` : `https://thisday.info/images/logo.png`)}" />
    <meta property="og:image:alt" content="${esc(c.imageAlt || c.title)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:locale" content="en_US" />
    <meta property="og:site_name" content="thisDay." />
    <meta property="article:published_time" content="${date.toISOString()}" />
    <meta property="article:modified_time" content="${date.toISOString()}" />
    <meta property="article:section" content="History" />
    <meta property="article:author" content="https://thisday.info/" />
    ${(c.keywords || "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
      .slice(0, 6)
      .map((k) => `<meta property="article:tag" content="${esc(k)}" />`)
      .join("\n    ")}

    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(c.title)}" />
    <meta name="twitter:description" content="${esc(c.twitterDescription || c.description)}" />
    <meta name="twitter:image" content="${esc(c.imageUrl ? `/image-proxy?src=${encodeURIComponent(c.imageUrl)}&w=1200&q=85` : `https://thisday.info/images/logo.png`)}" />
    <meta name="twitter:image:alt" content="${esc(c.imageAlt || c.title)}" />

    <!-- JSON-LD Schema -->
    <script type="application/ld+json">
${jsonLd}
    </script>
    <script type="application/ld+json">
${breadcrumbJsonLd}
    </script>
    <script type="application/ld+json">
${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: `What was ${esc(c.eventTitle)}?`,
      acceptedAnswer: {
        "@type": "Answer",
        text: esc(c.jsonLdDescription || c.description),
      },
    },
    {
      "@type": "Question",
      name: `When and where did ${esc(c.eventTitle)} take place?`,
      acceptedAnswer: {
        "@type": "Answer",
        text: `${esc(c.eventTitle)} took place on ${esc(c.historicalDate)} in ${esc(c.location)}.`,
      },
    },
    {
      "@type": "Question",
      name: `What was the historical significance of ${esc(c.eventTitle)}?`,
      acceptedAnswer: {
        "@type": "Answer",
        text: esc(
          (c.quickFacts || []).find((f) => f.label === "Significance")?.value ||
            c.description,
        ),
      },
    },
  ],
})}
    </script>
    <script type="application/ld+json">
${JSON.stringify({
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
      name: "Blog",
      item: "https://thisday.info/blog/",
    },
    { "@type": "ListItem", position: 3, name: c.title, item: canonicalUrl },
  ],
})}
    </script>

    <link rel="icon" href="/images/favicon.ico" />
    <link rel="apple-touch-icon" href="/images/apple-touch-icon.png" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" />
    <link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/css/style.css" />
    <link rel="stylesheet" href="/css/custom.css" />

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
    <script async src="https://fundingchoicesmessages.google.com/i/pub-8565025017387209?ers=1"></script>
    <script>(function(){function signalGooglefcPresent(){if(!window.frames['googlefcPresent']){if(document.body){const iframe=document.createElement('iframe');iframe.style='width:0;height:0;border:none;z-index:-1000;left:-1000px;top:-1000px;display:none;';iframe.name='googlefcPresent';document.body.appendChild(iframe);}else{setTimeout(signalGooglefcPresent,0);}}}signalGooglefcPresent();})();</script>

    <style>
      :root{--bg:#ffffff;--bg-alt:#f2f7f2;--text:#1a2e20;--text-muted:#5c7a65;--border:#cfe0cf;--btn-bg:#1b3a2d;--btn-text:#fff;--btn-hover:#2a4d3a;--accent:#9dc43a;--radius:4px;--shadow:0 16px 32px -8px rgba(27,58,45,.08)}
      body{font-family:Lora,serif;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--text)}
      main{flex:1;margin-top:20px}
      p{font-size:15px;line-height:1.6}
      a{color:var(--btn-bg)}a:hover{color:var(--accent);text-decoration:underline}
      h1,h2,h3{color:var(--text)}
      .article-meta{color:var(--text-muted);font-size:13px}
      .pillar-pill-row{display:flex;flex-wrap:wrap;gap:10px}
      .pillar-pill{display:inline-flex;align-items:center;justify-content:center;padding:7px 14px;border:1px solid var(--border);border-radius:999px;background:var(--bg-alt);color:var(--btn-bg);font-size:13px;font-weight:400;letter-spacing:.01em;text-decoration:none;transition:background .15s ease,border-color .15s ease,color .15s ease}
      .pillar-pill:hover{background:#e7f0e7;border-color:var(--btn-bg);color:var(--btn-bg);text-decoration:none}
      .pillar-pill-featured{background:var(--btn-bg);border-color:var(--btn-bg);color:#fff}
      .pillar-pill-featured:hover{background:var(--btn-hover);border-color:var(--btn-hover);color:#fff}
      .breadcrumb{background:transparent;padding:0;margin-bottom:1rem}
      .breadcrumb-item a{color:var(--btn-bg)}.breadcrumb-item.active{color:var(--text-muted)}
      .seo-only-title{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
      .dyn-slider-wrap{overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none}
      .dyn-slider-wrap::-webkit-scrollbar{display:none}
      .dyn-slider-track{display:flex;gap:14px;padding-bottom:4px}
      .dyn-slide{flex:0 0 240px;max-width:240px;min-height:220px;scroll-snap-align:start;background:var(--btn-bg);color:#fff;padding:2rem 1.75rem;display:flex;flex-direction:column;justify-content:center;gap:1rem;border-radius:10px}
      .dyn-slide h3{font-size:15px;color:#fff;margin:0;line-height:1.6}
      .dyn-slide p{font-size:15px;line-height:1.6;color:var(--accent);margin:0}
      .analysis-good{background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.3)}
      .analysis-bad{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.3)}
      .related-card{border:1px solid var(--border);background:var(--bg);transition:transform .15s ease,box-shadow .15s ease}
      .related-card:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,.1);text-decoration:none}
      .related-question-grid{display:grid;grid-template-columns:1fr;gap:14px}
      @media(min-width:640px){.related-question-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
      .related-question-card{padding:16px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.72)}
      .related-question-card h3{font-size:1rem;margin-bottom:8px}
      .related-question-card p{margin-bottom:0;font-size:15px;line-height:1.6}
      .topic-hub-links{border-top:1px solid var(--border);padding-top:14px}
      .topic-hub-chip-row{display:flex;flex-wrap:wrap;gap:8px}
      .topic-hub-chip{display:inline-flex;align-items:center;justify-content:center;padding:7px 12px;border:1px solid var(--border);border-radius:999px;background:var(--bg-alt);color:var(--btn-bg);font-size:13px;font-weight:400;text-decoration:none}
      .topic-hub-chip:hover{background:#e7f0e7;border-color:var(--btn-bg);color:var(--btn-bg);text-decoration:none}
      .authority-links{background:var(--bg-alt);border:1px solid var(--border);border-radius:10px;padding:14px 16px}
      .authority-links-label{font-size:13px;font-weight:400;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted);display:block;margin-bottom:10px}
      .authority-links-row{display:flex;flex-wrap:wrap;gap:8px}
      .authority-link{display:inline-flex;align-items:center;padding:6px 12px;border:1px solid var(--border);border-radius:999px;font-size:13px;font-weight:400;color:var(--btn-bg);background:#fff;text-decoration:none}
      .authority-link:hover{background:var(--bg-alt);border-color:var(--btn-bg);text-decoration:none}
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
      .ai-answer-card{background:#f5f5f5;border:1px solid rgba(27,58,45,.14);border-radius:12px;padding:18px 20px}
      .ai-answer-card p{margin-bottom:.75rem}
      .ai-answer-kicker{display:none!important}
      .ai-answer-grid{display:grid;grid-template-columns:1fr;gap:10px;margin-top:14px}
      @media(min-width:640px){.ai-answer-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
      .ai-answer-item{display:flex;flex-direction:column;gap:3px;padding:10px 12px;background:rgba(255,255,255,.65);border:1px solid rgba(27,58,45,.08);border-radius:10px}
      .ai-answer-item strong{font-size:.74rem;letter-spacing:.03em;text-transform:uppercase;color:var(--text-muted)}
      .tdq-cta-sub{color:var(--text-muted)}
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

        <article class="p-4 rounded border" style="background-color: var(--bg); color: var(--text)">

          <header class="mb-4 text-center">
            <h1 class="mb-2 fw-bold">${esc(c.title)}</h1>
            <p class="article-meta mb-0">
              <small>
                Published: ${esc(publishedStr)} &nbsp;|&nbsp;
                Event Date: ${esc(c.historicalDate)} &nbsp;|&nbsp;
                By <a href="/about/editorial/" rel="author" style="color:inherit">thisDay. Editorial Team</a>${readingTime}
              </small>
            </p>
            ${pillarPills}
          </header>

          ${buildArticleAnswerBlock(c)}

          ${c.imageUrl ? `<figure class="text-center mb-4">
            <img
              src="/image-proxy?src=${encodeURIComponent(c.imageUrl)}&w=800&q=85"
              srcset="/image-proxy?src=${encodeURIComponent(c.imageUrl)}&w=400 400w, /image-proxy?src=${encodeURIComponent(c.imageUrl)}&w=800 800w"
              sizes="(max-width:640px) 100vw, 800px"
              class="img-fluid rounded"
              alt="${esc(c.imageAlt)}"
              style="max-height: 400px; object-fit: cover; width: 100%"
              loading="eager"
              onerror="this.onerror=null;this.removeAttribute('srcset');this.src='${esc(c.imageUrl)}';"
            />
            <figcaption class="article-meta mt-2">
              <small>Image courtesy of <a href="https://commons.wikimedia.org/" target="_blank" rel="noopener noreferrer">Wikimedia Commons</a>.</small>
            </figcaption>
          </figure>` : ""}

          <!-- Did You Know -->
          ${didYouKnowSlider}

          <!-- Overview -->
          ${
            overviewParas
              ? `<section class="mt-4" style="overflow:hidden;">
            <h2 class="h3">Overview</h2>
${overviewParas}
          </section>`
              : ""
          }

          ${bookCoverUrl && c.bookSearchQuery ? `<!-- Further Reading -->
          <div class="mt-3 p-3 rounded" style="background-color: rgba(0,0,0,0.04); border: 1px solid rgba(0,0,0,0.08); display:flex; align-items:flex-start; gap:14px;">
            <a href="https://openlibrary.org/search?q=${encodeURIComponent(c.bookSearchQuery)}&mode=books" target="_blank" rel="noopener noreferrer" style="flex-shrink:0;">
              <img src="${esc(bookCoverUrl)}" alt="Book cover" loading="lazy" style="width:60px;height:auto;border-radius:4px;display:block;">
            </a>
            <div>
              <strong style="font-size:0.9rem;">Want to read more?</strong><br>
              <small class="article-meta">If you want to explore this topic further, we recommend searching for books on
                <a href="https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(c.bookSearchQuery + " book")}&_sacat=267" target="_blank" rel="noopener noreferrer">eBay</a>
                or browsing free digital editions at
                <a href="https://openlibrary.org/search?q=${encodeURIComponent(c.bookSearchQuery)}&mode=books" target="_blank" rel="noopener noreferrer">Open Library</a>.
              </small>
            </div>
          </div>` : ""}

          ${buildAuthorityLinksBlock(c, currentPillars)}

          <!-- Eyewitness / Chronicle Accounts -->
          ${
            eyewitnessParas
              ? `<div class="ad-unit-container my-4"><span class="ad-unit-label">Advertisement</span><ins class="adsbygoogle" style="display:block" data-ad-client="ca-pub-8565025017387209" data-ad-slot="9477779891" data-ad-format="auto" data-full-width-responsive="true"></ins></div>
          <section class="mt-5">
            <h2 class="h3">Eyewitness Accounts</h2>
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

          <!-- Aftermath -->
          ${
            aftermathParas
              ? `<section class="mt-5">
            <h2 class="h3">Aftermath</h2>
${aftermathParas}
          </section>`
              : ""
          }

          <!-- Conclusion -->
          ${
            conclusionParas
              ? `<section class="mt-5">
            <h2 class="h3">Legacy</h2>
${conclusionParas}
          </section>`
              : ""
          }

          <!-- Personal Analysis -->
          ${
            analysisGoodItems || analysisBadItems
              ? `<section class="mt-5">
            <h2 class="h3">Our Take: What Went Right &amp; What Went Wrong</h2>
            <div class="row g-3 mt-1">
              <div class="col-md-6">
                <div class="analysis-good p-3 rounded h-100">
                  <h3 style="color:#16a34a">What Went Right</h3>
                  <ul class="mb-0">
${analysisGoodItems}
                  </ul>
                </div>
              </div>
              <div class="col-md-6">
                <div class="analysis-bad p-3 rounded h-100">
                  <h3 style="color:#dc2626">What Went Wrong</h3>
                  <ul class="mb-0">
${analysisBadItems}
                  </ul>
                </div>
              </div>
            </div>
            ${editorialNote}
          </section>`
              : ""
          }

          <!-- Wikipedia source -->
          <div class="mt-4 p-3 rounded" style="background-color: rgba(0,0,0,0.04); border: 1px solid rgba(0,0,0,0.08);">
            <small class="article-meta">
              Want to learn more? Read the full article on
              <a href="${esc(c.wikiUrl || c.jsonLdUrl)}" target="_blank" rel="noopener noreferrer">Wikipedia</a>.
              Historical data sourced under <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a>.
            </small>
          </div>

          ${(() => {
            const others = allPosts.filter((p) => p.slug !== slug);
            // Prefer posts that share at least one pillar with the current article.
            // Sort by overlap count descending, fill remainder from most recent.
            let related;
            if (currentPillars.length > 0) {
              const withOverlap = others
                .map((p) => ({
                  p,
                  overlap: Array.isArray(p.pillars)
                    ? p.pillars.filter((pl) => currentPillars.includes(pl))
                        .length
                    : 0,
                }))
                .sort((a, b) => b.overlap - a.overlap);
              const matching = withOverlap
                .filter((x) => x.overlap > 0)
                .map((x) => x.p)
                .slice(0, 3);
              if (matching.length < 3) {
                const seen = new Set(matching.map((p) => p.slug));
                const rest = others
                  .filter((p) => !seen.has(p.slug))
                  .slice(0, 3 - matching.length);
                related = [...matching, ...rest];
              } else {
                related = matching;
              }
            } else {
              related = others.slice(0, 3); // no pillar data yet — fall back to most recent
            }
            if (related.length === 0) return "";
            const cards = related
              .map((p) => {
                const thumb = p.imageUrl
                  ? `<img src="/image-proxy?src=${encodeURIComponent(p.imageUrl)}&w=80&q=75" alt="${esc(p.title)}" width="56" height="56" style="width:56px;height:56px;object-fit:cover;border-radius:8px;flex-shrink:0" loading="lazy"/>`
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
            return `<!-- Quiz CTA -->
          <div class="mt-4 p-3 rounded d-flex align-items-center gap-3" style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25)">
            <i class="bi bi-patch-question-fill" style="font-size:1.5rem;color:var(--accent,#9dc43a);flex-shrink:0"></i>
            <div>
              <strong style="color:var(--text,#1a2e20)">Test Your Knowledge</strong><br/>
              <small class="tdq-cta-sub">Can you answer 5 questions about this event?</small><br/>
              <button class="btn" id="tdq-cta-btn" onclick="document.getElementById('tdq-overlay').style.display='block';document.getElementById('tdq-popup').style.display='block';requestAnimationFrame(function(){document.getElementById('tdq-popup').classList.add('tdq-popup-open');});document.body.style.overflow='hidden';if(typeof maybeLoadAndShowQuiz==='function')maybeLoadAndShowQuiz();">
                Take the Quiz <i class="bi bi-arrow-right ms-1"></i>
              </button>
            </div>
          </div>
          <section class="mt-5">
            <h2 class="h5 mb-3">You Might Also Like</h2>
            <div class="row g-3">${cards}
            </div>
          </section>`;
          })()}

          ${buildArticleRelatedQuestionsBlock(c, currentPillars)}

          <!-- AI & Editorial Disclosure -->
          <div class="mt-5 p-3 rounded" style="background:rgba(0,0,0,0.03);border:1px solid rgba(0,0,0,0.08);font-size:.82rem;line-height:1.6">
            <strong style="display:block;margin-bottom:4px">About this article</strong>
            <span class="article-meta">
              This article was researched and drafted with AI assistance, then reviewed for factual accuracy by the
              <a href="/about/editorial/" rel="author">thisDay. editorial team</a>.
              Historical source: <a href="${esc(c.wikiUrl || c.jsonLdUrl)}" target="_blank" rel="noopener noreferrer">Wikipedia</a>
              (licensed under <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a>).
              Images via <a href="https://commons.wikimedia.org/" target="_blank" rel="noopener noreferrer">Wikimedia Commons</a>.
              Found an error? <a href="/contact/">Let us know</a>.
            </span>
          </div>

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
      "@type": "NewsArticle",
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
    <link rel="stylesheet" href="/css/style.css" />
    <link rel="stylesheet" href="/css/custom.css" />
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-WXEZ3868VN"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag() { dataLayer.push(arguments); }
      gtag("js", new Date()); gtag("config", "G-WXEZ3868VN");
    </script>
    <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8565025017387209" crossorigin="anonymous"></script>
    <script async src="https://fundingchoicesmessages.google.com/i/pub-8565025017387209?ers=1"></script>
    <script>(function(){function signalGooglefcPresent(){if(!window.frames['googlefcPresent']){if(document.body){const iframe=document.createElement('iframe');iframe.style='width:0;height:0;border:none;z-index:-1000;left:-1000px;top:-1000px;display:none;';iframe.name='googlefcPresent';document.body.appendChild(iframe);}else{setTimeout(signalGooglefcPresent,0);}}}signalGooglefcPresent();})();</script>
    <style>
      :root{--bg:#ffffff;--bg-alt:#f2f7f2;--text:#1a2e20;--text-muted:#5c7a65;--border:#cfe0cf;--btn-bg:#1b3a2d;--btn-text:#fff;--btn-hover:#2a4d3a;--accent:#9dc43a;--radius:4px;--shadow:0 16px 32px -8px rgba(27,58,45,.08)}
      body{font-family:Lora,serif;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--text)}
      main{flex:1;padding:20px 0}
      h1,h2,h3{color:var(--text)}
      a{color:var(--btn-bg);text-decoration:none}a:hover{text-decoration:underline}
      .blog-post-link{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border:1px solid var(--border);border-radius:8px;background-color:var(--bg);text-decoration:none;color:var(--text);transition:transform .15s ease,box-shadow .15s ease;margin-bottom:10px}
      .blog-post-link:hover{transform:translateX(4px);box-shadow:0 3px 12px rgba(0,0,0,.08);text-decoration:none;color:var(--text)}
      .post-thumb{width:108px;height:78px;object-fit:cover;border-radius:8px;flex-shrink:0;background:rgba(0,0,0,.06)}
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
               data-ad-client="ca-pub-8565025017387209"
               data-ad-slot="9477779891"
               data-ad-format="auto"
               data-full-width-responsive="true"></ins>
        </div>
        <div class="month-section">
          <h2 class="month-header"><i class="bi bi-book me-2"></i>All Articles (${index.length})</h2>
          ${postItems}
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

async function servePillarHub(env, slugStr) {
  const pillarName = toTitlePillarSlug(slugStr);
  if (!pillarName) return serve404(env);

  const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  const posts = index
    .filter((e) => Array.isArray(e.pillars) && e.pillars.includes(pillarName))
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const html = buildPillarHubHTML(pillarName, slugStr, posts);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}

function buildPillarHubHTML(pillarName, slugStr, posts) {
  const canonicalUrl = `https://thisday.info/blog/topic/${slugStr}/`;
  const description =
    PILLAR_DESCRIPTIONS[pillarName] ||
    `Articles about ${pillarName} on thisDay.`;
  const pageTitle = `${pillarName} — Historical Articles | thisDay.`;

  const postItems = posts.length
    ? posts
        .map((entry) => renderBlogPostListItem(entry))
        .join("\n")
    : '<p class="text-muted">No articles in this category yet — check back soon.</p>';

  const otherPillars = BLOG_PILLARS.filter((p) => p !== pillarName)
    .map((p) => {
      const s = p
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
      return `<a href="/blog/topic/${s}/" class="badge text-decoration-none me-1 mb-1" style="background:var(--btn-bg);color:#fff;font-weight:500;font-size:.78rem;padding:.35em .7em;border-radius:20px">${esc(p)}</a>`;
    })
    .join("");

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
        "@type": "NewsArticle",
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
    <meta name="robots" content="index, follow" />
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
    <link rel="stylesheet" href="/css/style.css" />
    <link rel="stylesheet" href="/css/custom.css" />
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-WXEZ3868VN"></script>
    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag("js",new Date());gtag("config","G-WXEZ3868VN");</script>
    <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8565025017387209" crossorigin="anonymous"></script>
    <script async src="https://fundingchoicesmessages.google.com/i/pub-8565025017387209?ers=1"></script>
    <script>(function(){function signalGooglefcPresent(){if(!window.frames['googlefcPresent']){if(document.body){const iframe=document.createElement('iframe');iframe.style='width:0;height:0;border:none;z-index:-1000;left:-1000px;top:-1000px;display:none;';iframe.name='googlefcPresent';document.body.appendChild(iframe);}else{setTimeout(signalGooglefcPresent,0);}}}signalGooglefcPresent();})();</script>
    <style>
      :root{--bg:#ffffff;--bg-alt:#f2f7f2;--text:#1a2e20;--text-muted:#5c7a65;--border:#cfe0cf;--btn-bg:#1b3a2d;--btn-text:#fff;--btn-hover:#2a4d3a;--accent:#9dc43a;--radius:4px;--shadow:0 16px 32px -8px rgba(27,58,45,.08)}
      body{font-family:Lora,serif;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--text)}
      main{flex:1;padding:20px 0}
      h1,h2,h3{color:var(--text)}
      a{color:var(--btn-bg);text-decoration:none}a:hover{text-decoration:underline}
      .blog-post-link{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border:1px solid var(--border);border-radius:8px;background-color:var(--bg);text-decoration:none;color:var(--text);transition:transform .15s ease,box-shadow .15s ease;margin-bottom:10px}
      .blog-post-link:hover{transform:translateX(4px);box-shadow:0 3px 12px rgba(0,0,0,.08);text-decoration:none;color:var(--text)}
      .post-thumb{width:108px;height:78px;object-fit:cover;border-radius:8px;flex-shrink:0;background:rgba(0,0,0,.06)}
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
               data-ad-slot="9477779891"
               data-ad-format="auto"
               data-full-width-responsive="true"></ins>
        </div>

        <div class="mb-5">
          <h2 class="section-header" style="font-size:1rem">Explore Other Topics</h2>
          <div>${otherPillars}</div>
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
// Utilities
// ---------------------------------------------------------------------------

function todayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function renderBlogPostListItem(entry) {
  const date = new Date(entry.publishedAt);
  const dateStr = `${MONTH_NAMES[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
  const rawImg = entry.imageUrl || "";
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
  return `<div data-explore-injected="1" class="mt-4 p-3 rounded" style="display:flex;flex-direction:row;flex-wrap:nowrap;align-items:flex-start;gap:12px;background:rgba(0,0,0,0.03);border:1px solid rgba(0,0,0,0.08)">
    ${thumbHtml}<div style="flex:1;min-width:0">
      <strong>Explore ${monthDisplay} ${day} in History</strong><br/>
      <small class="article-meta">Jump between the main events, famous births, notable deaths, and quiz for this date.</small>
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:12px">
        <a href="/events/${monthSlug}/${day}/" class="btn">Events</a>
        <a href="/born/${monthSlug}/${day}/" class="btn">Born</a>
        <a href="/died/${monthSlug}/${day}/" class="btn">Died</a>
        <a href="/quiz/${monthSlug}/${day}/" class="btn">Quiz</a>
      </div>
    </div>
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

function htmlResponse(body, status = 200) {
  return new Response(body, {
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

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
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
