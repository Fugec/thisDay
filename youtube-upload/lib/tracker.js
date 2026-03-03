/**
 * Tracks which blog post slugs have already been uploaded to YouTube.
 * Stored in the same Cloudflare KV namespace under the key "youtube:uploaded".
 * Value: JSON object — { [slug]: { youtubeId, uploadedAt, privacy } }
 *
 * privacy: 'public' | 'private' | 'unlisted'
 * Missing privacy field is treated as 'public' (backward-compatible).
 * To hide a video's iframe, set "privacy": "private" in the KV entry via CF dashboard.
 */

import { kvGet, kvPut } from './kv.js';

const TRACKER_KEY = 'youtube:uploaded';

export async function getUploaded() {
  const raw = await kvGet(TRACKER_KEY);
  return raw ? JSON.parse(raw) : {};
}

export async function markUploaded(slug, youtubeId, privacy = 'public') {
  const tracker = await getUploaded();
  tracker[slug] = { youtubeId, uploadedAt: new Date().toISOString(), privacy };
  await kvPut(TRACKER_KEY, JSON.stringify(tracker));
}
