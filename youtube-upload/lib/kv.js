/**
 * Cloudflare KV REST API client.
 * Reads/writes to the same BLOG_AI_KV namespace used by the blog worker.
 */

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
    method: 'PUT',
    headers: { ...authHeader(), 'Content-Type': 'text/plain' },
    body: value,
  });
  if (!res.ok) throw new Error(`KV PUT "${key}" failed: ${res.status}`);
}

/**
 * Returns the full post index array from KV.
 * Each entry: { slug, title, description, imageUrl, publishedAt }
 */
export async function getPostIndex() {
  const raw = await kvGet('index');
  return raw ? JSON.parse(raw) : [];
}

/**
 * Updates a single field (e.g. imageUrl) on a post entry in the KV index.
 * No-op if the slug is not found.
 *
 * @param {string} slug
 * @param {Record<string, unknown>} updates  Fields to merge into the entry.
 */
/**
 * Removes a post entry from the KV index and deletes its HTML key.
 * Used before triggering a regeneration so the worker starts clean.
 */
export async function deleteIndexEntry(slug) {
  const posts = await getPostIndex();
  const filtered = posts.filter((p) => p.slug !== slug);
  if (filtered.length === posts.length) return; // slug not found, nothing to do
  const deleteRes = await fetch(
    `${base()}/values/${encodeURIComponent(`post:${slug}`)}`,
    { method: 'DELETE', headers: authHeader() },
  );
  if (!deleteRes.ok && deleteRes.status !== 404) {
    throw new Error(`KV DELETE "post:${slug}" failed: ${deleteRes.status}`);
  }
  await kvPut('index', JSON.stringify(filtered));
}

export async function updateIndexEntry(slug, updates) {
  const posts = await getPostIndex();
  const idx = posts.findIndex((p) => p.slug === slug);
  if (idx === -1) return;
  Object.assign(posts[idx], updates);
  await kvPut('index', JSON.stringify(posts));
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
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
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
      decodeEntities(v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()),
    )
    .filter((s) => s.length > 60 && s.length < 800)
    .slice(0, 8);

  return paras.length > 0 ? paras.join(' ').slice(0, 2000) : null;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
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

  const dykMatch = raw.match(/class="did-you-know[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (!dykMatch) return null;

  const items = [...dykMatch[1].matchAll(/<li>([\s\S]*?)<\/li>/gi)]
    .map(m => decodeEntities(m[1].replace(/<[^>]+>/g, '')))
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
    .map(m => {
      const cells = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map(c => decodeEntities(c[1].replace(/<[^>]+>/g, '')))
        .filter(Boolean);
      return cells.length >= 2 ? `${cells[0]}: ${cells[1]}` : null;
    })
    .filter(Boolean);

  return rows.length > 0 ? rows : null;
}
