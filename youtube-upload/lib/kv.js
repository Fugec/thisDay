/**
 * Cloudflare KV REST API client.
 * Reads/writes to the same BLOG_AI_KV namespace used by the blog worker.
 */

import { randomUUID } from "crypto";

function base() {
  return `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/storage/kv/namespaces/${process.env.CF_KV_NAMESPACE_ID}`;
}

function authHeader() {
  return { Authorization: `Bearer ${process.env.CF_API_TOKEN}` };
}

export async function kvGet(key) {
  const res = await fetch(`${base()}/values/${encodeURIComponent(key)}`, {
    headers: authHeader(),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV GET "${key}" failed: ${res.status}`);
  return res.text();
}

export async function kvPut(key, value) {
  const res = await fetch(`${base()}/values/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { ...authHeader(), "Content-Type": "text/plain" },
    body: value,
  });
  if (!res.ok) throw new Error(`KV PUT "${key}" failed: ${res.status}`);
}

/**
 * Deletes a KV key. Silently succeeds if the key does not exist.
 *
 * @param {string} key
 */
export async function kvDelete(key) {
  const res = await fetch(`${base()}/values/${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: authHeader(),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`KV DELETE "${key}" failed: ${res.status}`);
  }
}

/**
 * Verifies that KV read/write access is working by writing a probe key,
 * reading it back, and deleting it. Throws if the round-trip fails.
 *
 * @param {string} [prefix="youtube-upload"]  Namespace prefix for the probe key.
 */
export async function verifyKvReadWriteAccess(prefix = "youtube-upload") {
  const probeKey = `${prefix}:health:${randomUUID()}`;
  const probeValue = `ok:${new Date().toISOString()}`;
  await kvPut(probeKey, probeValue);
  const readBack = await kvGet(probeKey);
  await kvDelete(probeKey);
  if (readBack !== probeValue) {
    throw new Error("KV read/write verification failed");
  }
}

/**
 * Returns the full post index array from KV.
 * Each entry: { slug, title, description, imageUrl, publishedAt }
 */
export async function getPostIndex() {
  const raw = await kvGet("index");
  return raw ? JSON.parse(raw) : [];
}

/**
 * Removes a post entry from the KV index and deletes its HTML key.
 * Used before triggering a regeneration so the worker starts clean.
 *
 * @param {string} slug
 */
export async function deleteIndexEntry(slug) {
  const posts = await getPostIndex();
  const filtered = posts.filter((p) => p.slug !== slug);
  if (filtered.length === posts.length) return; // slug not found, nothing to do
  const deleteRes = await fetch(
    `${base()}/values/${encodeURIComponent(`post:${slug}`)}`,
    { method: "DELETE", headers: authHeader() },
  );
  if (!deleteRes.ok && deleteRes.status !== 404) {
    throw new Error(`KV DELETE "post:${slug}" failed: ${deleteRes.status}`);
  }
  await kvPut("index", JSON.stringify(filtered));
}

/**
 * Updates a single field (e.g. imageUrl) on a post entry in the KV index.
 * No-op if the slug is not found.
 *
 * @param {string} slug
 * @param {Record<string, unknown>} updates  Fields to merge into the entry.
 */
export async function updateIndexEntry(slug, updates) {
  const posts = await getPostIndex();
  const idx = posts.findIndex((p) => p.slug === slug);
  if (idx === -1) return;
  Object.assign(posts[idx], updates);
  await kvPut("index", JSON.stringify(posts));
}

/**
 * Fetches the full HTML content of a post from KV (key: post:{slug}),
 * strips HTML tags and decodes entities, then returns plain text
 * suitable for use as an AI image prompt.
 *
 * @param {string} slug
 * @returns {Promise<string|null>}
 */
export async function getPostContent(slug) {
  const raw = await kvGet(`post:${slug}`);
  if (!raw) return null;
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

/**
 * Extracts meaningful article paragraphs from a post's HTML stored in KV.
 * Returns up to ~1500 chars of clean prose, skipping boilerplate UI text.
 *
 * @param {string} slug
 * @returns {Promise<string|null>}
 */
export async function getArticleText(slug) {
  const raw = await kvGet(`post:${slug}`);
  if (!raw) return null;

  const paras = [...raw.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(([, v]) =>
      decodeEntities(
        v
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      ),
    )
    .filter((s) => s.length > 60 && s.length < 800)
    .slice(0, 8);

  return paras.length > 0 ? paras.join(" ").slice(0, 2000) : null;
}

/**
 * Extracts wiki-hosted image URLs from the stored post HTML.
 * The blog content uses /image-proxy?src=... wrappers; this unwraps them
 * back to the original Wikimedia/Commons URL so the video pipeline can reuse
 * the exact article images.
 *
 * @param {string} slug
 * @param {number} [limit=15]
 * @returns {Promise<string[]>}
 */
export async function getPostImageUrls(slug, limit = 15) {
  const raw = await kvGet(`post:${slug}`);
  if (!raw) return [];

  const urls = [];
  const seen = new Set();
  const imgRe = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const match of raw.matchAll(imgRe)) {
    let src = decodeEntities(match[1]);
    if (!src) continue;

    try {
      const parsed = new URL(src, "https://thisday.info");
      if (parsed.pathname.includes("/image-proxy")) {
        const proxied = parsed.searchParams.get("src");
        if (proxied) src = decodeEntities(proxied);
      } else if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        src = parsed.href;
      } else {
        continue;
      }
    } catch {
      continue;
    }

    if (src.startsWith("//")) src = `https:${src}`;
    if (!/^https?:\/\//i.test(src)) continue;

    let parsedSrc;
    try {
      parsedSrc = new URL(src);
    } catch {
      continue;
    }

    const host = parsedSrc.hostname.toLowerCase();
    if (!host.endsWith("wikimedia.org") && !host.endsWith("wikipedia.org")) {
      continue;
    }

    const dedupeKey = parsedSrc.href.split("#")[0];
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    urls.push(parsedSrc.href);
    if (urls.length >= limit) break;
  }

  return urls;
}

/**
 * Extracts the canonical Wikipedia article URL referenced by the stored post.
 * Prefers the article's explicit source link/JSON-LD over inferred titles.
 *
 * @param {string} slug
 * @returns {Promise<string|null>}
 */
export async function getPostWikipediaUrl(slug) {
  const raw = await kvGet(`post:${slug}`);
  if (!raw) return null;

  const normalizeWikipediaArticleUrl = (candidate) => {
    const decoded = decodeEntities(String(candidate || "").replace(/\\\//g, "/"));
    if (!decoded) return null;
    try {
      const parsed = new URL(decoded, "https://en.wikipedia.org");
      const host = parsed.hostname.toLowerCase();
      if (
        host !== "en.wikipedia.org" &&
        host !== "www.en.wikipedia.org" &&
        host !== "m.wikipedia.org"
      ) {
        return null;
      }
      if (!parsed.pathname.startsWith("/wiki/")) return null;
      const articlePath = parsed.pathname.slice("/wiki/".length);
      if (!articlePath) return null;
      if (/^(File|Special|Help|Template|Category|Portal|Talk):/i.test(articlePath)) {
        return null;
      }
      return `https://en.wikipedia.org/wiki/${articlePath}`;
    } catch {
      return null;
    }
  };

  const patterns = [
    /href="(https:\/\/en\.wikipedia\.org\/wiki\/[^"]+)"[^>]*>Wikipedia<\/a>/i,
    /"wikiUrl"\s*:\s*"((?:https?:)?\/\/en\.wikipedia\.org\/wiki\/[^"]+)"/i,
    /"jsonLdUrl"\s*:\s*"((?:https?:)?\/\/en\.wikipedia\.org\/wiki\/[^"]+)"/i,
    /"url"\s*:\s*"((?:https?:)?\/\/en\.wikipedia\.org\/wiki\/[^"]+)"/i,
    /href="((?:https?:)?\/\/en\.wikipedia\.org\/wiki\/[^"]+)"/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const normalized = normalizeWikipediaArticleUrl(match?.[1]);
    if (normalized) {
      return normalized;
    }
  }

  for (const match of raw.matchAll(/https?:\\?\/\\?\/en\.wikipedia\.org\\?\/wiki\\?\/[^"'\\\s<]+/gi)) {
    const normalized = normalizeWikipediaArticleUrl(match[0]);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extracts "Did You Know?" bullet items from a post's HTML.
 * Returns an array of plain-text strings, or null if the section is absent.
 * Newer posts (2026-02-27+) use this format.
 *
 * @param {string} slug
 * @returns {Promise<string[]|null>}
 */
export async function getDidYouKnow(slug) {
  const raw = await kvGet(`post:${slug}`);
  if (!raw) return null;

  const dykMatch = raw.match(
    /class="did-you-know[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  );
  if (!dykMatch) return null;

  const items = [...dykMatch[1].matchAll(/<li>([\s\S]*?)<\/li>/gi)]
    .map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, "")))
    .filter(Boolean);

  return items.length > 0 ? items : null;
}

/**
 * Extracts "Quick Facts" table rows as "{label}: {value}" strings.
 * Older posts (before 2026-02-27) use this format instead of Did You Know.
 *
 * @param {string} slug
 * @returns {Promise<string[]|null>}
 */
export async function getQuickFacts(slug) {
  const raw = await kvGet(`post:${slug}`);
  if (!raw) return null;

  const tableMatch = raw.match(/Quick Facts<\/h3>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return null;

  const rows = [...tableMatch[1].matchAll(/<tr>([\s\S]*?)<\/tr>/gi)]
    .map((m) => {
      const cells = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map((c) => decodeEntities(c[1].replace(/<[^>]+>/g, "")))
        .filter(Boolean);
      return cells.length >= 2 ? `${cells[0]}: ${cells[1]}` : null;
    })
    .filter(Boolean);

  return rows.length > 0 ? rows : null;
}
