/**
 * YouTube Data API v3 — upload helper.
 *
 * Authentication:
 *   - Run `npm run auth` once to get a refresh token via browser OAuth.
 *   - Store the token in YOUTUBE_REFRESH_TOKEN (env var / GitHub Secret).
 *   - After the first auth, this module is fully headless.
 */

import { google } from 'googleapis';
import { createReadStream } from 'fs';

function getOAuth2Client() {
  const client = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
    'http://localhost:3838',
  );
  client.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
  return client;
}

/**
 * Uploads a video file to YouTube and returns the video ID.
 *
 * @param {string} videoPath  - Path to the MP4 file
 * @param {{ slug: string, title: string, description: string, publishedAt: string }} post
 * @returns {Promise<string>} YouTube video ID
 */
export async function uploadToYoutube(videoPath, post) {
  const auth    = getOAuth2Client();
  const youtube = google.youtube({ version: 'v3', auth });

  // YouTube title limit: 100 chars. Strip em-dash separators for cleaner titles.
  const rawTitle = post.title.replace(/ [—–] /g, ': ');
  const title    = rawTitle.length > 97
    ? rawTitle.slice(0, 94) + '...'
    : rawTitle;

  const description = [
    post.description,
    '',
    `Read the full article → https://thisday.info/blog/${post.slug}/`,
    '',
    '#OnThisDay #History #Shorts #ThisDay #HistoricalEvents #TodayInHistory',
  ].join('\n');

  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title,
        description,
        tags: [
          'on this day', 'history', 'shorts', 'thisday',
          'historical events', 'today in history', 'education',
        ],
        categoryId: '27', // Education
        defaultLanguage: 'en',
        defaultAudioLanguage: 'en',
      },
      status: {
        // Default 'public'; set YOUTUBE_PRIVACY=private to upload as draft for review
        privacyStatus: process.env.YOUTUBE_PRIVACY || 'public',
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      mimeType: 'video/mp4',
      body: createReadStream(videoPath),
    },
  });

  return res.data.id;
}
