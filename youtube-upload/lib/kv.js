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
