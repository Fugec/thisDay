/**
 * Tracks which blog post slugs have already been uploaded to YouTube.
 * Stored in the same Cloudflare KV namespace under the key "youtube:uploaded".
 * Value: JSON object — { [slug]: { youtubeId, uploadedAt } }
 */

import { kvGet, kvPut } from './kv.js';

const TRACKER_KEY = 'youtube:uploaded';

export async function getUploaded() {
  const raw = await kvGet(TRACKER_KEY);
  return raw ? JSON.parse(raw) : {};
}

export async function markUploaded(slug, youtubeId) {
  const tracker = await getUploaded();
  tracker[slug] = { youtubeId, uploadedAt: new Date().toISOString() };
  await kvPut(TRACKER_KEY, JSON.stringify(tracker));
}
