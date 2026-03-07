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

/**
 * Fetches the live generated page (seo-worker) for a slug and returns post
 * metadata + Did You Know items. Used as fallback when blog KV has no posts.
 *
 * @param {string} slug  e.g. "7-march-2026"
 * @returns {Promise<{slug,title,description,imageUrl,publishedAt,dykItems}|null>}
 */
export async function fetchPageData(slug) {
  const parts = slug.split('-');
  if (parts.length < 3) return null;
  const [day, month] = parts;
  const url = `https://thisday.info/${month}/${day}/`;

  let html;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'thisday-uploader/1.0' } });
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }

  const h2Match   = html.match(/<h2>([^<]+)<\/h2>/);
  const metaMatch = html.match(/<meta name="description" content="([^"]+)"/i);
  const imgMatch  = html.match(/<img src="([^"]+)"[^>]*class="feat-img"/);

  const title       = h2Match   ? decodeEntities(h2Match[1])   : slug;
  const description = metaMatch ? decodeEntities(metaMatch[1]) : title;
  const imageUrl    = imgMatch  ? imgMatch[1] : null;

  const dykSection = html.match(/class="did-you-know[^"]*"[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/i);
  let dykItems = null;
  if (dykSection) {
    const items = [...dykSection[1].matchAll(/<li>([^<]+)<\/li>/gi)]
      .map(m => decodeEntities(m[1].trim()))
      .filter(Boolean);
    if (items.length) dykItems = items;
  }

  return { slug, title, description, imageUrl, publishedAt: new Date().toISOString(), dykItems };
}
