/**
 * YouTube Data API v3 — upload helper.
 *
 * Authentication:
 *   - Run `npm run auth` once to get a refresh token via browser OAuth.
 *   - Store the token in YOUTUBE_REFRESH_TOKEN (env var / GitHub Secret).
 *   - After the first auth, this module is fully headless.
 */

import { google } from "googleapis";
import { createReadStream } from "fs";

function getOAuth2Client() {
  const client = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
    "http://localhost:3838",
  );
  client.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
  return client;
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
 * Returns an empty string when fewer than 2 cuts are provided.
 *
 * @param {number[]} cuts  Scene boundary timestamps in seconds
 * @returns {string}
 */
function buildChapters(cuts) {
  if (!cuts?.length) return null;
  const LABELS = [
    "On This Day",
    "Did You Know?",
    "Historical Facts",
    "The Aftermath",
    "Legacy & Impact",
  ];
  const times = [0, ...cuts];
  return times
    .map((t, i) => `${fmtTime(t)} ${LABELS[i] ?? `Scene ${i + 1}`}`)
    .join("\n");
}

/**
 * Uploads a video file to YouTube and returns the video ID.
 *
 * @param {string} videoPath  - Path to the MP4 file
 * @param {{ slug: string, title: string, description: string, publishedAt: string }} post
 * @param {number[]} [cuts]   - Scene boundary timestamps for chapter markers
 * @returns {Promise<string>} YouTube video ID
 */
export async function uploadToYoutube(videoPath, post, cuts = []) {
  const auth = getOAuth2Client();
  const youtube = google.youtube({ version: "v3", auth });

  // YouTube title limit: 100 chars. Strip em-dash separators for cleaner titles.
  const rawTitle = post.title.replace(/ [—–] /g, ": ");
  const title = rawTitle.length > 97 ? rawTitle.slice(0, 94) + "..." : rawTitle;

  const description = [
    post.description,
    "",
    buildChapters(cuts),
    `Read the full article → https://thisday.info/blog/${post.slug}/`,
    "",
    "#OnThisDay #History #Shorts #ThisDay #HistoricalEvents #TodayInHistory",
  ]
    .filter((line) => line !== null && line !== undefined)
    .join("\n");

  const uploadPromise = youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title,
        description,
        tags: [
          "on this day",
          "history",
          "shorts",
          "thisday",
          "historical events",
          "today in history",
          "education",
        ],
        categoryId: "27", // Education
        defaultLanguage: "en",
        defaultAudioLanguage: "en",
      },
      status: {
        privacyStatus: process.env.YOUTUBE_PRIVACY || "public",
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      mimeType: "video/mp4",
      body: createReadStream(videoPath),
    },
  });

  const res = await Promise.race([
    uploadPromise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("YouTube upload timed out after 5 minutes")),
        5 * 60 * 1000,
      ),
    ),
  ]);

  return res.data.id;
}

export async function verifyYoutubeAuth() {
  const auth = getOAuth2Client();
  await auth.getAccessToken();
}
