/**
 * YouTube Data API v3 — upload helper.
 *
 * Authentication:
 *   - Run `npm run auth` once to get a refresh token via browser OAuth.
 *   - Store the token in YOUTUBE_REFRESH_TOKEN (env var / GitHub Secret).
 *   - After the first auth, this module is fully headless.
 */

import { google } from "googleapis";
import { Gaxios } from "gaxios";
import { createReadStream } from "fs";
import { buildVideoTitle, videoMatchTitle } from "./titles.js";

// Root cause of the 2026-06-25 upload break: the GitHub-hosted runner image
// updated (ubuntu24/20260615 -> 20260622) and the new environment makes Google's
// gzipped HTTP responses end in a way that trips a bug in gaxios's bundled
// node-fetch 2.7.0 (ERR_STREAM_PREMATURE_CLOSE from its Gunzip handler). Nothing
// in this repo changed — node-fetch 2.7.0 had worked for months.
//
// gaxios picks its transport as `hasFetch() ? window.fetch : node-fetch`, so in
// Node it ALWAYS uses node-fetch unless `fetchImplementation` is set. The fix is
// to force Node's native fetch (undici), which does not have the bug. We set it
// (a) globally, (b) on the OAuth2 transporter for the token call, and (c) on the
// video-upload request itself (media uploads do not inherit the global options).
// Identity encoding is kept as belt-and-suspenders so there is no gzip to begin with.
const NATIVE_FETCH = globalThis.fetch;
google.options({
  headers: { "Accept-Encoding": "identity" },
  fetchImplementation: NATIVE_FETCH,
});

const OAUTH_REDIRECT_URI = "http://localhost:3838";
const YOUTUBE_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const EDUCATION_CATEGORY_ID = "27";
const CHAPTER_LABELS = [
  "On This Day",
  "Did You Know?",
  "Historical Facts",
  "The Aftermath",
  "Legacy & Impact",
];
const DEFAULT_TAGS = [
  "on this day",
  "history",
  "shorts",
  "thisday",
  "historical events",
  "today in history",
  "education",
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function getOAuth2Client() {
  const client = new google.auth.OAuth2(
    requireEnv("YOUTUBE_CLIENT_ID"),
    requireEnv("YOUTUBE_CLIENT_SECRET"),
    OAUTH_REDIRECT_URI,
  );
  client.setCredentials({ refresh_token: requireEnv("YOUTUBE_REFRESH_TOKEN") });
  // Use a transporter backed by Node's native fetch (undici) instead of gaxios's
  // default node-fetch (which has the runner-triggered premature-close bug). See
  // the NATIVE_FETCH note at the top of this file. Identity encoding + retries
  // are kept as extra safety for the token call.
  client.transporter = new Gaxios({
    fetchImplementation: NATIVE_FETCH,
    headers: { "Accept-Encoding": "identity" },
    retry: true,
    retryConfig: { retry: 4, noResponseRetries: 4 },
  });
  return client;
}

function getYoutubeClient() {
  return google.youtube({ version: "v3", auth: getOAuth2Client() });
}

/**
 * Formats a seconds value as M:SS for YouTube chapter markers.
 * @param {number} secs
 * @returns {string}
 */
function fmtTime(secs) {
  const m = Math.floor(secs / 60);
  const s = String(Math.floor(secs % 60)).padStart(2, "0");
  return `${m}:${s}`;
}

/**
 * Builds the YouTube chapters string from scene cut timestamps.
 * Returns null when no scene cuts are provided.
 *
 * @param {number[]} cuts  Scene boundary timestamps in seconds
 * @returns {string}
 */
function buildChapters(cuts) {
  if (!cuts?.length) return null;
  const times = [0, ...cuts];
  return times
    .map((t, i) => `${fmtTime(t)} ${CHAPTER_LABELS[i] ?? `Scene ${i + 1}`}`)
    .join("\n");
}

function getEventName(post) {
  return videoMatchTitle(post)
    .replace(/\s*[—–-]\s+[A-Z][a-z]+ \d{1,2},\s*\d{4}\s*$/, "")
    .replace(/\s*[—–-]\s+\w+ \d{1,2},\s*\d{4}\s*$/, "")
    .trim();
}

function toHashtag(value) {
  const compact = String(value || "")
    .split(/\s+/)
    .map((word) => word.replace(/[^a-zA-Z0-9]/g, ""))
    .filter(Boolean)
    .map((word) => {
      // All-uppercase word (≥ 2 chars) — acronym like VTA, USA, FBI, NASA: preserve as-is
      if (word.length >= 2 && /^[A-Z0-9]+$/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join("");
  return compact ? `#${compact.slice(0, 40)}` : null;
}

function buildEventHashtags(post) {
  const eventName = getEventName(post);
  const hashtags = [];
  const add = (value) => {
    const tag = toHashtag(value);
    if (tag && !hashtags.includes(tag)) hashtags.push(tag);
  };

  const people = Array.isArray(post.keyTerms)
    ? post.keyTerms
        .filter((term) => term?.type === "person")
        .map((term) => term.term)
        .filter((term) => {
          const normalizedEvent = eventName.toLowerCase();
          const parts = String(term || "")
            .toLowerCase()
            .split(/\s+/)
            .map((part) => part.replace(/[^a-z0-9]/g, ""))
            .filter((part) => part.length > 2);
          return parts.length > 0 && parts.some((part) => normalizedEvent.includes(part));
        })
    : [];

  for (const person of people.slice(0, 2)) add(person);

  if (/\broyal wedding\b/i.test(`${eventName} ${post.keywords || ""}`)) {
    add("Royal Wedding");
  } else {
    add(
      eventName
        .replace(/\b(wedding of|sinking of|battle of|disaster|sinking)\b/gi, "")
        .trim() || eventName,
    );
  }

  return hashtags.slice(0, 3);
}

function buildVideoDescription(post, cuts) {
  const hashtagLine = [
    ...buildEventHashtags(post),
    "#OnThisDay",
    "#History",
  ]
    .filter(Boolean)
    .join(" ");

  return [
    post.description,
    "",
    buildChapters(cuts),
    `Read the full article → https://thisday.info/blog/${post.slug}/`,
    "",
    hashtagLine,
  ]
    .filter((line) => line !== null && line !== undefined)
    .join("\n");
}

function buildVideoTags(post) {
  return [...DEFAULT_TAGS, getEventName(post)].filter(Boolean);
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeoutId));
}

/**
 * Uploads a video file to YouTube and returns the video ID.
 *
 * @param {string} videoPath  - Path to the MP4 file
 * @param {{ slug: string, title: string, eventTitle?: string, description: string, publishedAt: string }} post
 * @param {number[]} [cuts]   - Scene boundary timestamps for chapter markers
 * @returns {Promise<string>} YouTube video ID
 */
// Retry only transient network/server failures — never 4xx (quota, auth, or an
// invalid video), which will not succeed on retry and would waste API quota.
function isRetryableUploadError(err) {
  const status = err?.code ?? err?.response?.status ?? err?.status;
  if (typeof status === "number") return status >= 500; // 4xx -> no retry, 5xx -> retry
  return /premature close|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network|terminated|aborted|timed out/i.test(
    String(err?.message || ""),
  );
}

export async function uploadToYoutube(videoPath, post, cuts = []) {
  const youtube = getYoutubeClient();
  const requestBody = {
    snippet: {
      title: buildVideoTitle(post),
      description: buildVideoDescription(post, cuts),
      tags: buildVideoTags(post),
      categoryId: EDUCATION_CATEGORY_ID,
      defaultLanguage: "en",
      defaultAudioLanguage: "en",
    },
    status: {
      privacyStatus: process.env.YOUTUBE_PRIVACY || "public",
      selfDeclaredMadeForKids: false,
    },
  };

  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const uploadPromise = youtube.videos.insert(
        {
          part: ["snippet", "status"],
          requestBody,
          // A FRESH read stream every attempt — a consumed/aborted stream
          // cannot be replayed, so the retry must build its own.
          media: { mimeType: "video/mp4", body: createReadStream(videoPath) },
        },
        {
          // Per-request options for the MEDIA UPLOAD specifically. The multipart
          // upload does NOT inherit google.options, so force native fetch +
          // identity encoding + duplex here. See the NATIVE_FETCH note above.
          fetchImplementation: NATIVE_FETCH,
          headers: { "Accept-Encoding": "identity" },
          // undici requires duplex:"half" when the request body is a stream.
          duplex: "half",
        },
      );
      const res = await withTimeout(
        uploadPromise,
        YOUTUBE_UPLOAD_TIMEOUT_MS,
        "YouTube upload timed out after 5 minutes",
      );
      return res.data.id;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS && isRetryableUploadError(err)) {
        const waitMs = 3000 * attempt;
        console.warn(
          `  ⚠ Upload attempt ${attempt}/${MAX_ATTEMPTS} failed (${err.message}); retrying in ${waitMs / 1000}s...`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function verifyYoutubeAuth() {
  const auth = getOAuth2Client();
  await auth.getAccessToken();
}
