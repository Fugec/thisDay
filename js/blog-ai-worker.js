/**
 * Cloudflare Worker — Blog Post Generator
 *
 * Runs on a cron trigger (daily at 06:00 UTC) and publishes a new blog post
 * every other day using Cloudflare Workers AI (free, no external API key).
 * Posts are stored in Cloudflare KV and served at:
 *   /blog/archive/         → listing of all published posts
 *   /blog/archive/[slug]/  → individual post page
 *
 * Manual trigger (for testing):
 *   POST /blog/publish     → immediately publishes today's post
 *
 * Required bindings: BLOG_AI_KV (KV namespace), AI (Workers AI)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Cloudflare Workers AI model — free tier, no API key needed.
const CF_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const KV_POST_PREFIX = "post:";
const KV_INDEX_KEY = "index";
const KV_LAST_GEN_KEY = "last_gen_date";
const EVERY_OTHER_DAYS = 1; // Generate every N days
const FALLBACK_IMAGE = "https://thisday.info/images/logo.png"; // Used when Wikipedia returns no image

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MONTH_SLUGS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  /**
   * Cron trigger — runs daily, generates every other day.
   */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(maybeGenerateBlogPost(env));
  },

  /**
   * HTTP fetch handler — serves blog pages and the manual trigger endpoint.
   */
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    // Manual trigger (POST /blog/publish)
    // Requires:  Authorization: Bearer <PUBLISH_SECRET>
    if (path === "/blog/publish" && request.method === "POST") {
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.PUBLISH_SECRET || auth !== `Bearer ${env.PUBLISH_SECRET}`) {
        return jsonResponse({ status: "unauthorized" }, 401);
      }
      try {
        await generateAndStore(env);
        return jsonResponse({ status: "ok", message: "Blog post published." });
      } catch (err) {
        return jsonResponse({ status: "error", message: String(err) }, 500);
      }
    }

    // Listing page: /blog/archive
    if (path === "/blog/archive") {
      return serveListing(env);
    }

    // JSON index used by the main blog page to dynamically render AI posts
    if (path === "/blog/archive.json") {
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

    // Individual post: /blog/[slug]  (single-segment slugs only — e.g. /blog/20-february-2026)
    // Two-segment paths like /blog/august/1-2025/ are existing static posts — pass them through.
    const postMatch = path.match(/^\/blog\/([^/]+)$/);
    if (postMatch) {
      const html = await env.BLOG_AI_KV.get(`${KV_POST_PREFIX}${postMatch[1]}`);
      if (html) return htmlResponse(html);
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
 */
async function maybeGenerateBlogPost(env) {
  const today = todayDateString(); // "YYYY-MM-DD"
  const lastGen = await env.BLOG_AI_KV.get(KV_LAST_GEN_KEY);

  if (lastGen) {
    const lastDate = new Date(lastGen);
    const todayDate = new Date(today);
    const diffDays = Math.round((todayDate - lastDate) / 86_400_000);
    if (diffDays < EVERY_OTHER_DAYS) {
      console.log(
        `Blog AI: last post was ${diffDays} day(s) ago — skipping (need ${EVERY_OTHER_DAYS}).`
      );
      return;
    }
  }

  await generateAndStore(env);
  await env.BLOG_AI_KV.put(KV_LAST_GEN_KEY, today);
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

    const apiUrl =
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const res = await fetch(apiUrl, {
      headers: { "User-Agent": "thisday.info-blog/1.0 (https://thisday.info)" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.thumbnail?.source ?? data.originalimage?.source ?? null;
  } catch {
    return null;
  }
}

/**
 * Calls the Claude API, builds the HTML page, and persists everything to KV.
 */
async function generateAndStore(env) {
  const now = new Date();

  // Collect titles already published this month so the AI avoids duplicates
  const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
  const existingIndex = indexRaw ? JSON.parse(indexRaw) : [];
  const thisMonthPrefix = now.toISOString().slice(0, 7); // "YYYY-MM"
  const takenThisMonth = existingIndex
    .filter((e) => e.publishedAt && e.publishedAt.startsWith(thisMonthPrefix))
    .map((e) => e.title);

  const content = await callWorkersAI(env.AI, now, takenThisMonth);

  // Replace the hallucinated Wikimedia URL with a real Wikipedia image.
  const realImage = await fetchWikipediaImage(content.eventTitle, content.wikiUrl);
  if (realImage) {
    content.imageUrl = realImage;
    // Wikipedia thumbnails already have attribution baked into the caption field;
    // keep whatever the model wrote for imageCaption so the source stays clear.
  } else {
    // Wikipedia returned nothing — use the site logo so the image slot is never broken.
    content.imageUrl = FALLBACK_IMAGE;
    content.imageAlt = `${content.eventTitle} — thisDay.info`;
    content.imageCaption = "Image unavailable. Historical data sourced from Wikipedia.";
  }

  const slug = buildSlug(now);
  const html = buildPostHTML(content, now, slug);

  // Persist the rendered page (no expiry — permanent archive)
  await env.BLOG_AI_KV.put(`${KV_POST_PREFIX}${slug}`, html);

  // Update the index (reuse the already-loaded existingIndex)
  const index = [...existingIndex];

  // Avoid duplicates
  if (!index.find((e) => e.slug === slug)) {
    index.unshift({
      slug,
      title: content.title,
      description: content.description,
      publishedAt: now.toISOString(),
    });
    // Cap the index at 200 entries
    if (index.length > 200) index.splice(200);
    await env.BLOG_AI_KV.put(KV_INDEX_KEY, JSON.stringify(index));
  }

  // Purge the cached sitemap and RSS feed so they reflect the new post immediately
  // (both workers cache for 1 h — without this, the new post would be invisible
  //  to crawlers until the next cache expiry).
  const cache = caches.default;
  await Promise.allSettled([
    cache.delete(new Request("https://thisday.info/sitemap.xml")),
    cache.delete(new Request("https://thisday.info/rss.xml")),
    cache.delete(new Request("https://thisday.info/news-sitemap.xml")),
  ]);

  console.log(`Blog: published post "${content.title}" → /blog/archive/${slug}/`);
}

// ---------------------------------------------------------------------------
// Claude API call
// ---------------------------------------------------------------------------

async function callWorkersAI(ai, date, takenThisMonth = []) {
  const monthName = MONTH_NAMES[date.getMonth()];
  const day = date.getDate();

  const avoidSection =
    takenThisMonth.length > 0
      ? `\nThese topics have already been covered this month — do NOT write about any of them:\n${takenThisMonth.map((t) => `- ${t}`).join("\n")}\nChoose a completely different event.\n`
      : "";

  const prompt = `You are a historical content writer for "thisDay.info", a website about historical events.

STRICT DATE REQUIREMENT: You MUST write about an event that occurred on ${monthName} ${day} ONLY. The event must have taken place in the month of ${monthName} on day ${day}. Events from ANY other month or day are strictly forbidden. Before choosing an event, verify it happened on ${monthName} ${day}. If you are not certain an event occurred on ${monthName} ${day}, choose a different event you are confident about.

Write a detailed, engaging blog post about a significant historical event that occurred on ${monthName} ${day} (any year). Choose the most interesting or impactful event for this exact date.
${avoidSection}
The article must be thorough and long — at least 800 words of body content — with multiple sections including eyewitness accounts, aftermath, and a personal editorial analysis of what went right and wrong about the event or the response to it.

Writing style rules:
- Do not use dashes ("-" or "—") inside sentences. Use commas, periods, or rewrite the sentence instead.
- Write in a natural, human tone. Avoid bullet-point thinking inside paragraphs.

Reply with ONLY a raw JSON object. No markdown, no code fences, no explanation — just the JSON.

{
  "title": "Event Name — ${monthName} ${day}, Year",
  "eventTitle": "Short event name",
  "historicalDate": "Month Day, Year",
  "historicalYear": 1234,
  "location": "City, Country",
  "country": "Country",
  "description": "One-sentence meta description under 155 chars",
  "ogDescription": "Open Graph description under 130 chars",
  "twitterDescription": "Twitter description under 120 chars",
  "keywords": "keyword1, keyword2, keyword3, keyword4, keyword5",
  "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/thumb/example.jpg",
  "imageAlt": "Alt text for the image",
  "imageCaption": "Image caption with source",
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
    "Surprising or lesser-known fact about the event, 1 to 2 sentences.",
    "Another interesting detail readers might not expect, 1 to 2 sentences.",
    "A third fact that adds color or context to the main story, 1 to 2 sentences."
  ],
  "overviewParagraphs": [
    "First paragraph: context and background leading up to the event, 4 to 5 sentences.",
    "Second paragraph: what happened — the main events, key actors, turning points, 4 to 5 sentences.",
    "Third paragraph: immediate consequences and how people reacted in the moment, 4 to 5 sentences.",
    "Fourth paragraph: broader context — how this fits into the larger history of the period, 3 to 4 sentences."
  ],
  "eyewitnessOrChronicle": [
    "First paragraph about contemporary accounts, documents, or eyewitness descriptions of the event, 4 to 5 sentences. Include the name of the source if known.",
    "Second paragraph with a paraphrased quote or summary of another account, or elaboration on what survivors or observers reported, 3 to 4 sentences.",
    "Optional third paragraph addressing the reliability of sources — what historians accept, what is disputed, and why, 3 to 4 sentences."
  ],
  "eyewitnessQuote": "A short paraphrased or real quote from a contemporary source about the event, under 200 characters.",
  "eyewitnessQuoteSource": "Name of the source, e.g. 'John Smith, Diary, 1776'",
  "aftermathParagraphs": [
    "First paragraph about immediate aftermath — what changed physically, politically, or socially in the weeks and months after the event, 4 to 5 sentences.",
    "Second paragraph about medium-term consequences — reforms, rebuilding, institutional changes, reactions from other nations or groups, 4 to 5 sentences.",
    "Third paragraph about long-term legacy — how historians view it today, what monuments or traditions commemorate it, and what was ultimately forgotten or ignored, 3 to 4 sentences."
  ],
  "conclusionParagraphs": [
    "First conclusion paragraph summarizing the event's place in history, 3 to 4 sentences.",
    "Second conclusion paragraph about its relevance to the modern world, 2 to 3 sentences.",
    "Third conclusion paragraph with a thought-provoking closing observation, 2 to 3 sentences."
  ],
  "analysisGood": [
    { "title": "Short label for what went right", "detail": "2 to 3 sentences explaining this positive aspect, who deserves credit, and why it mattered." },
    { "title": "Another positive aspect", "detail": "2 to 3 sentences of explanation." },
    { "title": "A third positive aspect", "detail": "2 to 3 sentences of explanation." }
  ],
  "analysisBad": [
    { "title": "Short label for what went wrong", "detail": "2 to 3 sentences explaining this failure, who is responsible, and what the consequences were." },
    { "title": "Another failure or missed opportunity", "detail": "2 to 3 sentences of explanation." },
    { "title": "A third thing that went wrong", "detail": "2 to 3 sentences of explanation." },
    { "title": "Optional fourth point about institutional or systemic failure", "detail": "2 to 3 sentences of explanation." }
  ],
  "editorialNote": "A 3 to 4 sentence personal editorial reflection from the thisDay. team — a frank, opinionated observation about what this event reveals about human nature, institutions, or history in general. Write in first-person plural (we think, what strikes us).",
  "wikiUrl": "https://en.wikipedia.org/wiki/Article",
  "youtubeSearchQuery": "specific event name year history documentary"
}`;

  const result = await ai.run(CF_AI_MODEL, {
    messages: [
      {
        role: "system",
        content: "You are a historical content writer. Always respond with valid JSON only, no markdown, no extra text.",
      },
      { role: "user", content: prompt },
    ],
    max_tokens: 4096,
  });

  const raw = (result.response ?? "").trim();
  // Strip any accidental markdown code fences the model may add
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  // Extract the first {...} block in case the model adds surrounding text
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON found in model output: ${raw.slice(0, 200)}`);

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error(`JSON parse failed: ${e.message} — Raw: ${raw.slice(0, 300)}`);
  }

  // Enforce that the title always contains the date (Month Day, Year).
  // The AI sometimes omits it or uses a wrong format.
  const year = parsed.historicalYear ?? date.getFullYear();
  const expectedDateSuffix = `${monthName} ${day}, ${year}`;
  if (!parsed.title || !parsed.title.includes(monthName)) {
    // Strip any existing trailing date-like pattern and append the correct one
    const cleanTitle = (parsed.title ?? parsed.eventTitle ?? "Untitled")
      .replace(/[—:\-]\s*\w+ \d{1,2},\s*\d{4}\s*$/, "")
      .trim();
    parsed.title = `${cleanTitle} — ${expectedDateSuffix}`;
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// HTML builders
// ---------------------------------------------------------------------------

/**
 * Builds the full blog post HTML page, matching the structure of existing
 * hand-written posts on thisday.info.
 */
function buildPostHTML(c, date, slug) {
  const monthName = MONTH_NAMES[date.getMonth()];
  const day = date.getDate();
  const publishYear = date.getFullYear();
  const canonicalUrl = `https://thisday.info/blog/${slug}/`;
  const publishedStr = `${monthName} ${day}, ${publishYear}`;

  const quickFactsRows = (c.quickFacts || [])
    .map((f) => `              <tr><th scope="row">${esc(f.label)}</th><td>${esc(f.value)}</td></tr>`)
    .join("\n");

  const didYouKnowItems = (c.didYouKnowFacts || [])
    .map((f) => `              <li>${esc(f)}</li>`)
    .join("\n");

  const overviewParas = (c.overviewParagraphs || [])
    .map((p) => `            <p>${esc(p)}</p>`)
    .join("\n");

  const eyewitnessParas = (c.eyewitnessOrChronicle || [])
    .map((p) => `            <p>${esc(p)}</p>`)
    .join("\n");

  const eyewitnessQuoteBlock = (c.eyewitnessQuote)
    ? `          <blockquote class="historical-quote mt-3">
            <p>"${esc(c.eyewitnessQuote)}"</p>
            <footer class="article-meta">${esc(c.eyewitnessQuoteSource || "Contemporary source")}</footer>
          </blockquote>`
    : "";

  const aftermathParas = (c.aftermathParagraphs || [])
    .map((p) => `            <p>${esc(p)}</p>`)
    .join("\n");

  const conclusionParas = (c.conclusionParagraphs || [])
    .map((p) => `            <p>${esc(p)}</p>`)
    .join("\n");

  const analysisGoodItems = (c.analysisGood || [])
    .map((item) => `                    <li class="mb-2"><strong>${esc(item.title)}:</strong> ${esc(item.detail)}</li>`)
    .join("\n");

  const analysisBadItems = (c.analysisBad || [])
    .map((item) => `                    <li class="mb-2"><strong>${esc(item.title)}:</strong> ${esc(item.detail)}</li>`)
    .join("\n");

  const editorialNote = c.editorialNote
    ? `          <p class="mt-4 fst-italic" style="font-size: 0.93rem; opacity: 0.85; border-left: 3px solid #3b82f6; padding-left: 1rem;">
            ${esc(c.editorialNote)}
          </p>`
    : "";

  const readingTime = c.readingTimeMinutes ? `&nbsp;|&nbsp;${esc(String(c.readingTimeMinutes))} min read` : "";

  const jsonLd = JSON.stringify(
    {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: c.title,
      datePublished: date.toISOString().split("T")[0],
      author: { "@type": "Organization", name: "thisDay.info" },
      publisher: {
        "@type": "Organization",
        name: "thisDay.info",
        logo: { "@type": "ImageObject", url: "https://thisday.info/images/logo.png" },
      },
      description: c.jsonLdDescription || c.description,
      image: c.imageUrl,
      url: canonicalUrl,
      about: {
        "@type": "Event",
        name: c.jsonLdName || c.eventTitle,
        startDate: String(c.historicalYear),
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
    },
    null,
    2
  );

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="X-UA-Compatible" content="ie=edge" />
    <title>${esc(c.title)} | thisDay.</title>
    <link rel="canonical" href="${canonicalUrl}" />
    <meta name="robots" content="index, follow" />
    <meta name="description" content="${esc(c.description)}" />
    <meta name="keywords" content="${esc(c.keywords)}" />

    <!-- Open Graph -->
    <meta property="og:title" content="${esc(c.title)}" />
    <meta property="og:description" content="${esc(c.ogDescription || c.description)}" />
    <meta property="og:type" content="article" />
    <meta property="og:url" content="${canonicalUrl}" />
    <meta property="og:image" content="${esc(c.imageUrl)}" />

    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(c.title)}" />
    <meta name="twitter:description" content="${esc(c.twitterDescription || c.description)}" />
    <meta name="twitter:image" content="${esc(c.imageUrl)}" />

    <!-- JSON-LD Schema -->
    <script type="application/ld+json">
${jsonLd}
    </script>

    <link rel="icon" href="/images/favicon.ico" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/css/style.css" />

    <script async src="https://www.googletagmanager.com/gtag/js?id=G-WXEZ3868VN"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag() { dataLayer.push(arguments); }
      gtag("js", new Date());
      gtag("config", "G-WXEZ3868VN");
      gtag("config", "AW-17262488503");
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
      :root {
        --link-hover-color: #1d4ed8;
        --primary-bg: #3b82f6;
        --secondary-bg: #fff;
        --text-color: #6c757d;
        --header-text-color: #ffffff;
        --card-bg: #ffffff;
        --card-border: #e2e8f0;
        --footer-bg: #3b82f6;
        --footer-text-color: #ffffff;
        --link-color: #2563eb;
        --switch-track-off: #e2e8f0;
        --switch-thumb-off: #cbd5e1;
        --switch-track-on: #2563eb;
        --switch-thumb-on: #ffffff;
        --border-radius: 0.5rem;
        background-color: var(--secondary-bg);
        color: var(--text-color);
      }
      body.dark-theme {
        --primary-bg: #020617;
        --secondary-bg: #1e293b;
        --text-color: #f8fafc;
        --header-text-color: #ffffff;
        --card-bg: #1e293b;
        --card-border: #334155;
        --footer-bg: #020617;
        --footer-text-color: #ffffff;
        --link-color: #60a5fa;
        --switch-track-off: #334155;
        --switch-thumb-off: #64748b;
        --switch-track-on: #2563eb;
        --switch-thumb-on: #f8fafc;
        background-color: var(--secondary-bg) !important;
        color: var(--text-color) !important;
      }
      body {
        font-family: Inter, sans-serif;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        transition: background-color 0.3s ease, color 0.3s ease;
      }
      .navbar {
        background-color: var(--primary-bg) !important;
        transition: background-color 0.3s ease;
        position: sticky;
        top: 0;
        z-index: 1030;
      }
      .navbar-brand, .navbar-nav .nav-link {
        color: var(--header-text-color) !important;
        font-weight: bold !important;
      }
      main { flex: 1; margin-top: 20px; }
      .footer .text-muted { color: rgba(255,255,255,0.85) !important; }
      .article-meta { color: #6c757d; font-size: 0.875rem; }
      body.dark-theme .article-meta { color: #94a3b8; }
      .breadcrumb { background: transparent; padding: 0; margin-bottom: 1rem; }
      body.dark-theme .breadcrumb-item a { color: #60a5fa; }
      body.dark-theme .breadcrumb-item.active { color: #94a3b8; }
      body.dark-theme .breadcrumb-item + .breadcrumb-item::before { color: #64748b; }
      .did-you-know { background: rgba(59,130,246,0.08); border-left: 4px solid #3b82f6; border-radius: 0 0.5rem 0.5rem 0; }
      body.dark-theme .did-you-know { background: rgba(59,130,246,0.15); }
      .analysis-good { background: rgba(34,197,94,0.08); border: 1px solid rgba(34,197,94,0.3); }
      body.dark-theme .analysis-good { background: rgba(34,197,94,0.1); border-color: rgba(34,197,94,0.25); }
      .analysis-bad { background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.3); }
      body.dark-theme .analysis-bad { background: rgba(239,68,68,0.1); border-color: rgba(239,68,68,0.25); }
      .related-card { border: 1px solid var(--card-border); background: var(--card-bg); transition: transform 0.15s ease, box-shadow 0.15s ease; }
      .related-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-decoration: none; }
      blockquote.historical-quote { border-left: 3px solid #3b82f6; padding-left: 1rem; margin-left: 0.5rem; font-style: italic; }
      body.dark-theme blockquote.historical-quote footer { color: #94a3b8; }
      .border {
        border: 1px solid var(--card-border);
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      }
      body.dark-theme .border {
        border: 1px solid #334255 !important;
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      }
      .footer {
        background-color: var(--footer-bg);
        color: var(--footer-text-color);
        text-align: center;
        padding: 20px;
        margin-top: 30px;
        transition: background-color 0.3s ease, color 0.3s ease;
      }
      .footer a { color: var(--footer-text-color); text-decoration: underline; }
      .btn-outline-primary {
        color: #6f787f;
        border-color: #e2e8f0;
        background: #fff;
        transition: color 0.3s ease, background-color 0.3s ease, border-color 0.3s ease;
      }
      body.dark-theme .btn-outline-primary {
        border-color: #334255;
        color: #f8fafc;
        background-color: #1d293b;
      }
      .theme-switch-desktop label { color: var(--header-text-color); }
      .theme-switch-mobile label i { color: var(--header-text-color); font-size: 1.2rem; margin-left: 0.5rem; }
    </style>
  </head>

  <nav class="navbar navbar-expand-lg navbar-dark bg-primary">
    <div class="container-fluid">
      <a class="navbar-brand" href="/">thisDay.</a>
      <div class="form-check form-switch theme-switch-mobile d-lg-none me-2">
        <input class="form-check-input" type="checkbox" id="themeSwitchMobile" aria-label="Toggle dark mode" />
        <label class="form-check-label" for="themeSwitchMobile">
          <i class="bi bi-moon-fill"></i>
        </label>
      </div>
      <div class="collapse navbar-collapse" id="navbarNav">
        <ul class="navbar-nav ms-auto">
          <li class="nav-item d-flex align-items-center">
            <div class="form-check form-switch theme-switch-desktop d-none d-lg-block me-2">
              <input class="form-check-input" type="checkbox" id="themeSwitchDesktop" aria-label="Toggle dark mode" />
              <label class="form-check-label" for="themeSwitchDesktop">Dark Mode</label>
            </div>
          </li>
        </ul>
      </div>
    </div>
  </nav>

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

        <article class="p-4 rounded border shadow-sm" style="background-color: var(--card-bg); color: var(--text-color)">

          <header class="mb-4 text-center">
            <h1 class="mb-2 fw-bold">${esc(c.title)}</h1>
            <p class="article-meta mb-0">
              <small>
                Published: ${esc(publishedStr)} &nbsp;|&nbsp;
                Event Date: ${esc(c.historicalDate)} &nbsp;|&nbsp;
                thisDay. Editorial Team${readingTime}
              </small>
            </p>
          </header>

          <figure class="text-center mb-4">
            <img
              src="${esc(c.imageUrl)}"
              class="img-fluid rounded"
              alt="${esc(c.imageAlt)}"
              style="max-height: 400px; object-fit: cover; width: 100%"
              loading="lazy"
            />
            <figcaption class="article-meta mt-2">
              <small>${esc(c.imageCaption || "Image: Wikimedia Commons")}</small>
            </figcaption>
          </figure>

          <!-- Quick Facts -->
          <h3 class="mt-4">Quick Facts</h3>
          <table class="table table-bordered">
            <tbody>
${quickFactsRows}
            </tbody>
          </table>

          <!-- Did You Know -->
          ${didYouKnowItems ? `<div class="did-you-know p-3 rounded mb-4">
            <strong>Did You Know?</strong>
            <ul class="mb-0 mt-2">
${didYouKnowItems}
            </ul>
          </div>` : ""}

          <!-- Overview -->
          <section class="mt-4">
            <h3>Overview</h3>
${overviewParas}
          </section>

          <!-- Eyewitness / Chronicle Accounts -->
          ${eyewitnessParas ? `<section class="mt-5">
            <h3>Eyewitness &amp; Chronicle Accounts</h3>
${eyewitnessParas}
${eyewitnessQuoteBlock}
          </section>` : ""}

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
          ${aftermathParas ? `<section class="mt-5">
            <h3>Aftermath &amp; What Changed</h3>
${aftermathParas}
          </section>` : ""}

          <!-- Conclusion -->
          <section class="mt-5">
            <h3>Conclusion</h3>
${conclusionParas}
          </section>

          <!-- Personal Analysis -->
          ${(analysisGoodItems || analysisBadItems) ? `<section class="mt-5">
            <h3>Our Take: What Went Right &amp; What Went Wrong</h3>
            <div class="row g-3 mt-1">
              <div class="col-md-6">
                <div class="analysis-good p-3 rounded h-100">
                  <h5 style="color:#16a34a">What Went Right</h5>
                  <ul class="mb-0">
${analysisGoodItems}
                  </ul>
                </div>
              </div>
              <div class="col-md-6">
                <div class="analysis-bad p-3 rounded h-100">
                  <h5 style="color:#dc2626">What Went Wrong</h5>
                  <ul class="mb-0">
${analysisBadItems}
                  </ul>
                </div>
              </div>
            </div>
            ${editorialNote}
          </section>` : ""}

          <!-- Wikipedia source -->
          <div class="mt-4 p-3 rounded" style="background-color: rgba(59,130,246,0.08); border: 1px solid rgba(59,130,246,0.2);">
            <small class="article-meta">
              Want to learn more? Read the full article on
              <a href="${esc(c.wikiUrl || c.jsonLdUrl)}" target="_blank" rel="noopener noreferrer">Wikipedia</a>.
              Historical data sourced under <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a>.
            </small>
          </div>

          <footer class="text-center mt-5 pt-3 border-top">
            <small class="article-meta">
              Part of the <strong>thisDay.</strong> historical blog archive &mdash;
              <a href="/blog/archive/">Browse more posts</a> &bull;
              <a href="/blog/">All posts</a>
            </small>
          </footer>

        </article>
      </div>
    </div>
  </main>

  <script src="/js/chatbot.js"></script>

  <footer class="footer">
    <div class="container d-flex justify-content-center my-2">
      <div class="me-2">
        <a href="https://github.com/Fugec" target="_blank" rel="noopener noreferrer" aria-label="GitHub">
          <i class="bi bi-github h3 text-white"></i>
        </a>
      </div>
      <div class="me-2">
        <a href="https://www.facebook.com/profile.php?id=61578009082537" target="_blank" rel="noopener noreferrer" aria-label="Facebook">
          <i class="bi bi-facebook h3 text-white"></i>
        </a>
      </div>
      <div class="me-2">
        <a href="https://www.instagram.com/thisday.info/" target="_blank" rel="noopener noreferrer" aria-label="Instagram">
          <i class="bi bi-instagram h3 text-white"></i>
        </a>
      </div>
      <div class="me-2">
        <a href="https://www.tiktok.com/@this__day" target="_blank" rel="noopener noreferrer" aria-label="TikTok">
          <i class="bi bi-tiktok h3 text-white"></i>
        </a>
      </div>
      <div class="me-2">
        <a href="https://www.youtube.com/@thisDay_info/shorts" target="_blank" rel="noopener noreferrer" aria-label="YouTube">
          <i class="bi bi-youtube h3 text-white"></i>
        </a>
      </div>
    </div>
    <p>&copy; <span id="currentYear"></span> thisDay. All rights reserved.</p>
    <p>
      Historical data sourced from Wikipedia.org under
      <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer"
         title="Creative Commons Attribution-ShareAlike 4.0 International License">CC BY-SA 4.0</a> license.
      Note: Data is for informational purposes and requires verification.
    </p>
    <p>
      This website is not affiliated with any official historical organization or entity.
      The content is provided for educational and entertainment purposes only.
    </p>
    <p class="footer-bottom">
      <a href="https://buymeacoffee.com/fugec?new=1" target="_blank">Support This Project</a>
      | <a href="/terms">Terms and Conditions</a>
      | <a href="/privacy-policy">Privacy Policy</a>
    </p>
  </footer>

  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
  <script src="/js/script.js"></script>
  <script>
    document.addEventListener("DOMContentLoaded", () => {
      const currentYearSpan = document.getElementById("currentYear");
      if (currentYearSpan) currentYearSpan.textContent = new Date().getFullYear();

      const themeSwitchDesktop = document.getElementById("themeSwitchDesktop");
      const themeSwitchMobile  = document.getElementById("themeSwitchMobile");
      const body = document.body;
      const DARK_THEME_KEY = "darkTheme";

      const setTheme = (isDark) => {
        isDark ? body.classList.add("dark-theme") : body.classList.remove("dark-theme");
        localStorage.setItem(DARK_THEME_KEY, String(isDark));
        if (themeSwitchDesktop) themeSwitchDesktop.checked = isDark;
        if (themeSwitchMobile)  themeSwitchMobile.checked  = isDark;
      };

      const savedTheme = localStorage.getItem(DARK_THEME_KEY);
      setTheme(savedTheme !== "false"); // default: dark

      if (themeSwitchDesktop) themeSwitchDesktop.addEventListener("change", (e) => setTheme(e.target.checked));
      if (themeSwitchMobile)  themeSwitchMobile.addEventListener("change",  (e) => setTheme(e.target.checked));
    });
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
</html>`;
}

/**
 * Builds the /blog/ai/ listing page, styled to match /blog/index.html.
 */
async function buildListingHTML(index) {
  const postItems = index.length
    ? index
        .map((entry) => {
          const date = new Date(entry.publishedAt);
          const dateStr = `${MONTH_NAMES[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
          return `
        <a href="/blog/${esc(entry.slug)}/" class="blog-post-link">
          <i class="bi bi-clock-history post-icon"></i>
          <div>
            <div class="post-title">${esc(entry.title)}</div>
            <small style="color: var(--text-color); opacity: 0.7">${esc(dateStr)}</small>
          </div>
        </a>`;
        })
        .join("\n")
    : '<p class="text-muted">No AI-generated posts yet. Check back soon!</p>';

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>History Blog | thisDay. — Articles on Historical Events</title>
    <link rel="canonical" href="https://thisday.info/blog/archive/" />
    <meta name="robots" content="index, follow" />
    <meta name="description" content="Original articles about historical events published regularly by thisDay.info." />
    <meta property="og:title" content="History Blog | thisDay." />
    <meta property="og:description" content="In-depth articles about the events, people, and moments that shaped world history." />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="https://thisday.info/blog/archive/" />
    <meta property="og:image" content="https://thisday.info/images/logo.png" />
    <link rel="icon" href="/images/favicon.ico" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/css/style.css" />
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-WXEZ3868VN"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag() { dataLayer.push(arguments); }
      gtag("js", new Date()); gtag("config", "G-WXEZ3868VN");
    </script>
    <style>
      :root {
        --primary-bg: #3b82f6; --secondary-bg: #fff; --text-color: #6c757d;
        --header-text-color: #fff; --footer-bg: #3b82f6; --footer-text-color: #fff;
        --link-color: #2563eb; --card-bg: #fff; --card-border: rgba(0,0,0,0.1);
        background-color: var(--secondary-bg); color: var(--text-color);
      }
      body.dark-theme {
        --primary-bg: #020617; --secondary-bg: #1e293b; --text-color: #f8fafc;
        --header-text-color: #fff; --footer-bg: #020617; --footer-text-color: #fff;
        --link-color: #60a5fa; --card-bg: #1e293b; --card-border: rgba(255,255,255,0.1);
        background-color: var(--secondary-bg) !important; color: var(--text-color) !important;
      }
      body { font-family: Inter, sans-serif; min-height: 100vh; display: flex; flex-direction: column; transition: background-color 0.3s ease, color 0.3s ease; }
      .navbar { background-color: var(--primary-bg) !important; position: sticky; top: 0; z-index: 1030; }
      .navbar-brand, .navbar-nav .nav-link { color: var(--header-text-color) !important; font-weight: bold !important; }
      main { flex: 1; padding: 20px 0; }
      .footer { background-color: var(--footer-bg); color: var(--footer-text-color); text-align: center; padding: 20px; margin-top: 30px; font-size: 14px; }
      .footer a { color: var(--footer-text-color); text-decoration: underline; }
      h1, h2, h3 { color: var(--text-color); }
      body.dark-theme h1, body.dark-theme h2, body.dark-theme h3 { color: #f8fafc; }
      a { color: var(--link-color); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .blog-post-link {
        display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px;
        border: 1px solid var(--card-border); border-radius: 8px;
        background-color: var(--card-bg); text-decoration: none; color: var(--text-color);
        transition: transform 0.15s ease, box-shadow 0.15s ease; margin-bottom: 10px;
      }
      .blog-post-link:hover { transform: translateX(4px); box-shadow: 0 3px 12px rgba(0,0,0,0.08); text-decoration: none; color: var(--text-color); }
      .post-icon { color: #3b82f6; font-size: 1.1rem; flex-shrink: 0; margin-top: 2px; }
      .post-title { font-weight: 600; font-size: 0.95rem; line-height: 1.4; color: var(--link-color); }
      body.dark-theme .post-title { color: #60a5fa; }
      .month-header { font-size: 1.3rem; font-weight: 700; color: #3b82f6 !important; border-bottom: 2px solid rgba(59,130,246,0.3); padding-bottom: 6px; margin-bottom: 14px; }
    </style>
  </head>

  <nav class="navbar navbar-expand-lg navbar-dark bg-primary">
    <div class="container-fluid">
      <a class="navbar-brand" href="/">thisDay.</a>
      <div class="form-check form-switch d-lg-none me-2">
        <input class="form-check-input" type="checkbox" id="themeSwitchMobile" aria-label="Toggle dark mode" />
        <label class="form-check-label" for="themeSwitchMobile"><i class="bi bi-moon-fill" style="color:#fff;font-size:1.2rem;margin-left:.5rem"></i></label>
      </div>
      <div class="collapse navbar-collapse" id="navbarNav">
        <ul class="navbar-nav ms-auto">
          <li class="nav-item d-flex align-items-center">
            <div class="form-check form-switch d-none d-lg-block me-2">
              <input class="form-check-input" type="checkbox" id="themeSwitchDesktop" aria-label="Toggle dark mode" />
              <label class="form-check-label" for="themeSwitchDesktop" style="color:#fff">Dark Mode</label>
            </div>
          </li>
        </ul>
      </div>
    </div>
  </nav>

  <main class="container">
    <div class="row justify-content-center">
      <div class="col-lg-9 col-xl-7">
        <h1 class="fw-bold mb-1" style="font-size:1.8rem">History Blog</h1>
        <p class="mb-4" style="color: var(--text-color); opacity: 0.8">
          In-depth articles covering fascinating historical events published regularly by thisDay.info.
          <a href="/blog/">View all posts</a>
        </p>
        <div class="month-section">
          <h2 class="month-header"><i class="bi bi-book me-2"></i>All Articles (${index.length})</h2>
          ${postItems}
        </div>
      </div>
    </div>
  </main>

  <footer class="footer">
    <div class="container d-flex justify-content-center my-2">
      <div class="me-2"><a href="https://github.com/Fugec" target="_blank" rel="noopener noreferrer" aria-label="GitHub"><i class="bi bi-github h3 text-white"></i></a></div>
      <div class="me-2"><a href="https://www.facebook.com/profile.php?id=61578009082537" target="_blank" rel="noopener noreferrer" aria-label="Facebook"><i class="bi bi-facebook h3 text-white"></i></a></div>
      <div class="me-2"><a href="https://www.instagram.com/thisday.info/" target="_blank" rel="noopener noreferrer" aria-label="Instagram"><i class="bi bi-instagram h3 text-white"></i></a></div>
      <div class="me-2"><a href="https://www.tiktok.com/@this__day" target="_blank" rel="noopener noreferrer" aria-label="TikTok"><i class="bi bi-tiktok h3 text-white"></i></a></div>
      <div class="me-2"><a href="https://www.youtube.com/@thisDay_info/shorts" target="_blank" rel="noopener noreferrer" aria-label="YouTube"><i class="bi bi-youtube h3 text-white"></i></a></div>
    </div>
    <p>&copy; <span id="currentYear"></span> thisDay. All rights reserved.</p>
    <p>Historical data sourced from Wikipedia.org. Content is for educational and entertainment purposes only.</p>
    <p><a href="/terms">Terms and Conditions</a> | <a href="/privacy-policy">Privacy Policy</a></p>
  </footer>

  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
  <script>
    document.addEventListener("DOMContentLoaded", () => {
      document.getElementById("currentYear").textContent = new Date().getFullYear();
      const td = document.getElementById("themeSwitchDesktop");
      const tm = document.getElementById("themeSwitchMobile");
      const body = document.body;
      const setTheme = (d) => {
        d ? body.classList.add("dark-theme") : body.classList.remove("dark-theme");
        localStorage.setItem("darkTheme", String(d));
        if (td) td.checked = d; if (tm) tm.checked = d;
      };
      setTheme(localStorage.getItem("darkTheme") !== "false");
      if (td) td.addEventListener("change", (e) => setTheme(e.target.checked));
      if (tm) tm.addEventListener("change",  (e) => setTheme(e.target.checked));
    });
  </script>
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
// Utilities
// ---------------------------------------------------------------------------

function todayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

  const suggestions = recentPosts.length > 0
    ? `<h5 class="mt-5 mb-3 fw-semibold">Recent Articles</h5>
        <div class="list-group">
          ${recentPosts.map((p) => `
          <a href="/blog/${esc(p.slug)}/" class="list-group-item list-group-item-action py-3">
            <div class="fw-semibold">${esc(p.title)}</div>
            <div class="small text-muted mt-1">${esc(p.description)}</div>
          </a>`).join("")}
        </div>`
    : "";

  const year = new Date().getFullYear();

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
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/css/style.css" />
  <style>
    body { font-family: Inter, sans-serif; min-height: 100vh; display: flex; flex-direction: column; }
    .navbar { background-color: #3b82f6 !important; position: sticky; top: 0; z-index: 1030; }
    .navbar-brand, .navbar-nav .nav-link { color: #fff !important; font-weight: bold !important; }
    main { flex: 1; }
    .footer { background-color: #3b82f6; color: #fff; text-align: center; padding: 20px; margin-top: 30px; }
    .footer a { color: #fff; text-decoration: underline; }
    .hero-code { font-size: 6rem; font-weight: 700; color: #3b82f6; line-height: 1; }
  </style>
</head>
<body>
<nav class="navbar navbar-expand-lg navbar-dark">
  <div class="container-fluid">
    <a class="navbar-brand" href="/">thisDay.</a>
    <ul class="navbar-nav ms-auto">
      <li class="nav-item"><a class="nav-link" href="/">Home</a></li>
      <li class="nav-item"><a class="nav-link" href="/blog/">Blog</a></li>
    </ul>
  </div>
</nav>

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

<footer class="footer">
  <p class="mb-0">
    &copy; ${year} <a href="/">thisDay.info</a> &middot;
    <a href="/privacy-policy/">Privacy</a> &middot;
    <a href="/contact/">Contact</a>
  </p>
</footer>
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
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
