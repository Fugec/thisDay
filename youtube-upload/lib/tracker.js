/**
 * Tracks which blog post slugs have already been uploaded to YouTube.
 * Stored in the same Cloudflare KV namespace under the key "youtube:uploaded".
 * Value: JSON object — { [slug]: { youtubeId, uploadedAt, privacy } }
 *
 * privacy: 'public' | 'private' | 'unlisted'
 * Missing privacy field is treated as 'public' (backward-compatible).
 * To hide a video's iframe, set "privacy": "private" in the KV entry via CF dashboard.
 */

import { randomUUID } from "crypto";
import { kvDelete, kvGet, kvPut } from "./kv.js";
import { notifyPipelineIssue } from "./notify.js";

const TRACKER_KEY = "youtube:uploaded";
const UPLOAD_LOCK_KEY = "youtube:upload-lock";
const LOCK_TTL_MS = 6 * 60 * 60 * 1000;
const PIPELINE_STATE_KEY = "youtube:pipeline-state";

export async function getUploaded() {
  const raw = await kvGet(TRACKER_KEY);
  return raw ? JSON.parse(raw) : {};
}

export async function markUploaded(slug, youtubeId, privacy = "public") {
  const tracker = await getUploaded();
  tracker[slug] = { youtubeId, uploadedAt: new Date().toISOString(), privacy };
  await kvPut(TRACKER_KEY, JSON.stringify(tracker));
}

/**
 * Records that a video has been successfully posted to social platforms.
 * Only sets the timestamp for platforms that succeeded (truthy).
 *
 * @param {string} slug
 * @param {{ meta?: boolean, tiktok?: boolean, pinterest?: boolean }} platforms
 */
export async function markSocialPosted(slug, { meta, tiktok, pinterest } = {}) {
  const tracker = await getUploaded();
  if (!tracker[slug]) return;
  const now = new Date().toISOString();
  if (meta) tracker[slug].metaPostedAt = now;
  if (tiktok) tracker[slug].tiktokPostedAt = now;
  if (pinterest) tracker[slug].pinterestPostedAt = now;
  await kvPut(TRACKER_KEY, JSON.stringify(tracker));
}

/**
 * Tries to acquire a distributed upload lock stored in KV.
 * Returns a token string if the lock was acquired, or null if another run holds it.
 * The lock expires automatically after LOCK_TTL_MS (6 h) so stale locks don't block forever.
 * Note: KV has no atomic compare-and-set; the GH Actions concurrency group is the primary
 * guard against simultaneous runs — this lock is a belt-and-suspenders safeguard.
 *
 * @param {string} [owner]  Identifier for the process claiming the lock (e.g. run ID).
 * @returns {Promise<string|null>}
 */
export async function acquireUploadLock(owner = "youtube-upload") {
  const now = new Date();
  const existingRaw = await kvGet(UPLOAD_LOCK_KEY);

  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw);
      const claimedAt = existing?.claimedAt
        ? new Date(existing.claimedAt)
        : null;
      if (claimedAt && Number.isFinite(claimedAt.getTime())) {
        if (now.getTime() - claimedAt.getTime() < LOCK_TTL_MS) {
          return null;
        }
      }
    } catch {
      // Treat malformed lock as stale and overwrite below.
    }
  }

  const token = randomUUID();
  const lock = {
    token,
    owner,
    claimedAt: now.toISOString(),
  };

  await kvPut(UPLOAD_LOCK_KEY, JSON.stringify(lock));
  const verifiedRaw = await kvGet(UPLOAD_LOCK_KEY);
  if (!verifiedRaw) return null;

  try {
    const verified = JSON.parse(verifiedRaw);
    return verified?.token === token ? token : null;
  } catch {
    return null;
  }
}

/**
 * Releases the upload lock if the given token matches the current lock holder.
 * No-op if the lock is missing or owned by a different token.
 *
 * @param {string|null} token  The token returned by acquireUploadLock.
 */
export async function releaseUploadLock(token) {
  if (!token) return;

  const raw = await kvGet(UPLOAD_LOCK_KEY);
  if (!raw) return;

  try {
    const current = JSON.parse(raw);
    if (current?.token !== token) return;
  } catch {
    return;
  }

  await kvDelete(UPLOAD_LOCK_KEY);
}

function utcDateString(value = new Date()) {
  return value.toISOString().slice(0, 10);
}

async function getPipelineState() {
  const raw = await kvGet(PIPELINE_STATE_KEY);
  const parsed = raw ? JSON.parse(raw) : {};
  return {
    ...parsed,
    steps: parsed.steps ?? {},
    quota: parsed.quota ?? {},
  };
}

async function savePipelineState(state) {
  await kvPut(PIPELINE_STATE_KEY, JSON.stringify(state));
}

/**
 * Records that a pipeline step succeeded today, clearing any failure streak.
 *
 * @param {string} step  Step name, e.g. "blog" or "youtube".
 */
export async function recordPipelineSuccess(step) {
  const state = await getPipelineState();
  state.steps[step] ??= {};
  state.steps[step].lastSuccessDate = utcDateString();
  state.steps[step].lastFailureDate = null;
  state.steps[step].streak = 0;
  await savePipelineState(state);
}

/**
 * Records a pipeline step failure and sends a Discord alert if the same step
 * has failed on two or more consecutive days. Deduplicates within the same day
 * (only one alert per step per day).
 *
 * @param {{ step: string, slug: string, message: string, date?: Date }} opts
 * @returns {Promise<{ streak: number, alerted: boolean }>}
 */
export async function recordPipelineFailure({
  step,
  slug,
  message,
  date = new Date(),
}) {
  const today = utcDateString(date);
  const yesterday = utcDateString(new Date(date.getTime() - 86_400_000));
  const state = await getPipelineState();
  const stepState = state.steps[step] ?? {};

  if (stepState.lastFailureDate === today) {
    stepState.lastFailureSlug = slug;
    stepState.lastFailureMessage = message;
    state.steps[step] = stepState;
    await savePipelineState(state);
    return { streak: stepState.streak ?? 1, alerted: false };
  }

  const streak =
    stepState.lastFailureDate === yesterday ? (stepState.streak ?? 1) + 1 : 1;
  stepState.lastFailureDate = today;
  stepState.lastFailureSlug = slug;
  stepState.lastFailureMessage = message;
  stepState.streak = streak;
  state.steps[step] = stepState;
  await savePipelineState(state);

  const alertedToday = stepState.lastAlertDate === today;
  if (streak >= 2 && !alertedToday && process.env.DISCORD_WEBHOOK_URL) {
    await notifyPipelineIssue({
      step,
      slug,
      date: today,
      message,
      streak,
    });
    stepState.lastAlertDate = today;
    state.steps[step] = stepState;
    await savePipelineState(state);
    return { streak, alerted: true };
  }

  return { streak, alerted: false };
}

/**
 * Records a quota/rate-limit hit for a service (e.g. "elevenlabs", "groq-narration").
 * Increments a per-service daily counter in the pipeline state KV document.
 *
 * @param {string} service  Service identifier.
 * @param {string} details  Error message or quota detail string.
 */
export async function recordQuotaSignal(service, details) {
  const today = utcDateString();
  const state = await getPipelineState();
  state.quota[service] ??= { count: 0 };
  const serviceState = state.quota[service];
  if (serviceState.lastDate !== today) {
    serviceState.count = 0;
  }
  serviceState.count += 1;
  serviceState.lastDate = today;
  serviceState.lastDetails = details;
  state.quota[service] = serviceState;
  await savePipelineState(state);
  console.warn(`  ⚠ Quota signal [${service}]: ${details}`);
}
