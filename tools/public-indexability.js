import { pathToFileURL } from "node:url";

const DEFAULT_SITE = "https://thisday.info";
// Do not impersonate Googlebot from CI: Cloudflare correctly challenges a
// Googlebot user agent arriving from an unverified GitHub runner IP. The live
// check validates the public response and crawler directives as a normal
// browser; verified search-engine access belongs in Search Console.
const INDEXABILITY_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

function htmlAttribute(tag, name) {
  const match = String(tag || "").match(
    new RegExp(
      `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
      "i",
    ),
  );
  return match ? match[1] ?? match[2] ?? match[3] ?? "" : "";
}

export function robotsMetaDirectives(html) {
  return (String(html || "").match(/<meta\b[^>]*>/gi) || [])
    .filter((tag) => htmlAttribute(tag, "name").toLowerCase() === "robots")
    .map((tag) => htmlAttribute(tag, "content").trim())
    .filter(Boolean);
}

export function isCloudflareManagedChallenge({
  status,
  headers = new Headers(),
  html = "",
}) {
  if (status !== 403) return false;
  const server = headers.get("server") || "";
  const ray = headers.get("cf-ray") || "";
  const body = String(html || "");
  return Boolean(
    /cloudflare/i.test(server) &&
      ray &&
      /(?:\bjust a moment\b|cf_chl_|cdn-cgi\/challenge-platform|enable javascript and cookies)/i.test(
        body,
      ),
  );
}

export function inspectPublicIndexability({
  requestedUrl,
  finalUrl = requestedUrl,
  status,
  headers = new Headers(),
  html = "",
}) {
  const metaDirectives = robotsMetaDirectives(html);
  const headerDirective = headers.get("x-robots-tag") || "";
  const directives = [...metaDirectives, headerDirective]
    .join(",")
    .toLowerCase();
  const issues = [];
  const cloudflareChallenge = isCloudflareManagedChallenge({
    status,
    headers,
    html,
  });

  if (status !== 200) issues.push(`returned HTTP ${status}`);
  if (/\bnoindex\b/.test(directives)) issues.push("declares noindex");
  if (/\bnofollow\b/.test(directives)) issues.push("declares nofollow");

  return {
    requestedUrl,
    finalUrl,
    status,
    metaDirectives,
    headerDirective,
    cloudflareChallenge,
    issues,
    indexable: issues.length === 0,
  };
}

export function failingPublicIndexabilityResults(
  results,
  { allowCloudflareChallenge = false } = {},
) {
  return results.filter(
    (result) =>
      !result.indexable &&
      !(allowCloudflareChallenge && result.cloudflareChallenge === true),
  );
}

async function latestArticlePath(fetchImpl, site) {
  try {
    const response = await fetchImpl(`${site}/blog/index.json`, {
      headers: { Accept: "application/json", "User-Agent": INDEXABILITY_USER_AGENT },
      redirect: "follow",
    });
    if (!response.ok) return "";
    const payload = await response.json();
    const entries = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.posts)
        ? payload.posts
        : [];
    const slug = String(entries[0]?.slug || "").trim();
    return /^[a-z0-9-]+$/.test(slug) ? `/blog/${slug}/` : "";
  } catch (_) {
    return "";
  }
}

export async function verifyPublicIndexability({
  site = DEFAULT_SITE,
  fetchImpl = fetch,
} = {}) {
  const normalizedSite = site.replace(/\/$/, "");
  const paths = ["/", "/blog/"];
  const articlePath = await latestArticlePath(fetchImpl, normalizedSite);
  if (articlePath) paths.push(articlePath);

  const results = [];
  for (const path of paths) {
    const requestedUrl = `${normalizedSite}${path}`;
    try {
      const response = await fetchImpl(requestedUrl, {
        headers: { Accept: "text/html", "User-Agent": INDEXABILITY_USER_AGENT },
        redirect: "follow",
      });
      const html = await response.text();
      results.push(
        inspectPublicIndexability({
          requestedUrl,
          finalUrl: response.url || requestedUrl,
          status: response.status,
          headers: response.headers,
          html,
        }),
      );
    } catch (error) {
      results.push({
        requestedUrl,
        finalUrl: requestedUrl,
        status: 0,
        metaDirectives: [],
        headerDirective: "",
        issues: [`request failed: ${error?.message || error}`],
        indexable: false,
      });
    }
  }
  return results;
}

async function runCli() {
  const results = await verifyPublicIndexability();
  const allowCloudflareChallenge = process.argv.includes(
    "--allow-cloudflare-challenge",
  );
  for (const result of results) {
    const challengeSkipped =
      allowCloudflareChallenge && result.cloudflareChallenge === true;
    const state = result.indexable ? "PASS" : challengeSkipped ? "SKIP" : "FAIL";
    console.log(
      `${state} ${result.requestedUrl} -> ${result.finalUrl} ` +
        `(HTTP ${result.status}; robots: ${
          [...result.metaDirectives, result.headerDirective].filter(Boolean).join(" | ") ||
          "default"
        })`,
    );
    if (challengeSkipped) {
      console.warn("  GitHub runner was blocked by a Cloudflare managed challenge");
    } else {
      for (const issue of result.issues) console.error(`  ${issue}`);
    }
  }
  if (
    failingPublicIndexabilityResults(results, { allowCloudflareChallenge })
      .length
  ) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runCli();
}
