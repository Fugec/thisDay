/**
 * Cloudflare Worker — Dynamic OG Image Generator
 *
 * Generates a branded social-sharing card for any date / event title.
 * Served at /og-image?title=...&date=...
 *
 * The seo-worker points og:image here when no Wikipedia thumbnail is available,
 * so every page gets a consistent, branded preview instead of a generic logo.
 *
 * Output format: image/svg+xml
 *   Supported by: Facebook, LinkedIn, WhatsApp, Slack, Discord, iMessage.
 *   Twitter/X requires PNG — add @resvg/resvg-wasm to convert if needed.
 *
 * Deploy:  npx wrangler deploy --config wrangler-og.jsonc
 * Dev:     npx wrangler dev --config wrangler-og.jsonc
 *
 * No bindings required.
 */

const CACHE_MAX_AGE = 86_400; // 24 h — cards are date-specific, stable for a day

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname !== "/og-image") {
      return fetch(request);
    }

    // Serve from edge cache when available
    const cache = caches.default;
    const cacheKey = new Request(url.toString());
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const title = url.searchParams.get("title") ||
      "thisDay. — On This Day in History";
    const date = url.searchParams.get("date") ||
      new Date().toLocaleDateString("en-US", { month: "long", day: "numeric" });

    const svg = buildSVG(title, date);

    const response = new Response(svg, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": `public, max-age=${CACHE_MAX_AGE}, s-maxage=${CACHE_MAX_AGE}, immutable`,
      },
    });

    await cache.put(cacheKey, response.clone());
    return response;
  },
};

// ---------------------------------------------------------------------------
// SVG builder
// ---------------------------------------------------------------------------

function buildSVG(title, date) {
  // Wrap title into at most 3 lines of ~44 chars each
  const titleLines = wrapText(escXml(title), 44).slice(0, 3);

  // Vertical centre the title block (each line is ~52px tall)
  const blockHeight = titleLines.length * 52;
  const titleStartY = Math.round((630 - 80 - 60) / 2 + 80 - blockHeight / 2 + 40);

  const titleSvg = titleLines
    .map(
      (line, i) =>
        `<text x="60" y="${titleStartY + i * 52}" ` +
        `font-family="Georgia,'Times New Roman',serif" font-size="46" ` +
        `font-weight="bold" fill="#ffffff" filter="url(#shadow)">${line}</text>`,
    )
    .join("\n  ");

  // Date badge width — roughly 13 px per character + 40 px padding
  const badgeW = Math.min(date.length * 14 + 44, 480);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <!-- Deep-blue background gradient -->
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#1e3a8a"/>
    </linearGradient>
    <!-- Blue accent gradient (left bar + badge) -->
    <linearGradient id="accent" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%"   stop-color="#60a5fa"/>
      <stop offset="100%" stop-color="#2563eb"/>
    </linearGradient>
    <!-- Subtle text shadow for readability -->
    <filter id="shadow" x="-5%" y="-5%" width="110%" height="130%">
      <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000000" flood-opacity="0.5"/>
    </filter>
  </defs>

  <!-- Background -->
  <rect width="1200" height="630" fill="url(#bg)"/>

  <!-- Decorative circle (top-right) -->
  <circle cx="1100" cy="80" r="260" fill="rgba(59,130,246,0.07)"/>
  <circle cx="1100" cy="80" r="180" fill="rgba(59,130,246,0.06)"/>

  <!-- Left accent bar -->
  <rect x="0" y="0" width="6" height="630" fill="url(#accent)"/>

  <!-- Top bar -->
  <rect x="0" y="0" width="1200" height="78" fill="rgba(0,0,0,0.35)"/>

  <!-- Site name -->
  <text x="40" y="52"
    font-family="Georgia,'Times New Roman',serif"
    font-size="34" font-weight="bold" fill="#ffffff" letter-spacing="1">
    thisDay.
  </text>

  <!-- Top-bar divider -->
  <line x1="168" y1="20" x2="168" y2="58" stroke="rgba(255,255,255,0.2)" stroke-width="1"/>

  <!-- Tagline in top bar -->
  <text x="184" y="50"
    font-family="Arial,sans-serif" font-size="20" fill="rgba(255,255,255,0.55)">
    On This Day in History
  </text>

  <!-- Horizontal rule below top bar -->
  <line x1="40" y1="98" x2="1160" y2="98"
    stroke="rgba(255,255,255,0.1)" stroke-width="1"/>

  <!-- Date badge -->
  <rect x="40" y="116" width="${badgeW}" height="46" rx="8"
    fill="rgba(37,99,235,0.45)" stroke="rgba(96,165,250,0.4)" stroke-width="1"/>
  <text x="60" y="148"
    font-family="Arial,sans-serif" font-size="24" font-weight="600" fill="#93c5fd">
    ${escXml(date)}
  </text>

  <!-- Title -->
  ${titleSvg}

  <!-- Bottom bar -->
  <rect x="0" y="570" width="1200" height="60" fill="rgba(0,0,0,0.4)"/>
  <text x="40" y="606"
    font-family="Arial,sans-serif" font-size="20" fill="rgba(255,255,255,0.5)">
    thisday.info
  </text>

  <!-- Calendar icon (right side of bottom bar) -->
  <text x="1160" y="606"
    font-family="Arial,sans-serif" font-size="22" fill="rgba(255,255,255,0.35)"
    text-anchor="end">
    &#x1F4C5; Explore history
  </text>
</svg>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wraps `text` into lines of at most `maxLen` characters, breaking on spaces.
 */
function wrapText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxLen) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Escapes the five XML special characters for safe SVG text embedding. */
function escXml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
