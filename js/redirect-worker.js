/**
 * Cloudflare Worker — Canonical URL Redirects
 *
 * Enforces canonical URL patterns to prevent duplicate-content penalties:
 *   1. www.thisday.info/* → thisday.info/* (301)
 *   2. /index.html        → /             (301)
 *
 * Runs before the SEO worker and origin for the routes it owns.
 * All other requests are passed through unchanged.
 *
 * Deploy:  npx wrangler deploy --config wrangler-redirect.jsonc
 * Dev:     npx wrangler dev --config wrangler-redirect.jsonc
 *
 * No bindings required.
 */

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // 1. Redirect www → non-www (consolidates link equity to the apex domain)
    if (url.hostname === "www.thisday.info") {
      url.hostname = "thisday.info";
      return Response.redirect(url.toString(), 301);
    }

    // 2. Redirect /index.html → / (prevents dual-indexing of the homepage)
    if (url.pathname === "/index.html") {
      url.pathname = "/";
      return Response.redirect(url.toString(), 301);
    }

    // Pass everything else through to the next matching worker / origin.
    return fetch(request);
  },
};
