/**
 * One-time OAuth 2.0 setup — run this ONCE locally to get your refresh token.
 *
 * Usage:
 *   npm run auth
 *
 * 1. A browser tab opens automatically with Google's consent screen.
 * 2. Authorise the app for your YouTube channel.
 * 3. Google redirects to localhost — the script captures the code automatically.
 * 4. Your YOUTUBE_REFRESH_TOKEN is printed — add it to .env (and GitHub Secrets).
 */

import { google } from 'googleapis';
import { createServer } from 'http';
import { URL } from 'url';
import { exec } from 'child_process';
import 'dotenv/config';

const PORT = 3838;
const REDIRECT_URI = `http://localhost:${PORT}`;

const client = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  REDIRECT_URI,
);

const authUrl = client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/youtube.upload'],
  prompt: 'consent',
});

// Open browser automatically (macOS / Linux / Windows)
const opener = process.platform === 'win32'
  ? `start "${authUrl}"`
  : process.platform === 'darwin'
    ? `open "${authUrl}"`
    : `xdg-open "${authUrl}"`;

console.log('\nOpening browser for Google authorisation...');
exec(opener);
console.log('If the browser did not open, visit this URL manually:\n');
console.log(authUrl + '\n');

// Local HTTP server catches the redirect with the auth code
const token = await new Promise((resolve, reject) => {
  const server = createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url, REDIRECT_URI);
      const code = reqUrl.searchParams.get('code');

      // Ignore browser pre-requests (favicon, etc.) that arrive without a code
      if (!code) {
        res.writeHead(200);
        res.end();
        return;
      }

      res.end('<h2>Authorised! You can close this tab.</h2>');
      server.close();

      const { tokens } = await client.getToken(code);
      resolve(tokens);
    } catch (err) {
      res.end('Error: ' + err.message);
      reject(err);
    }
  });

  server.listen(PORT, () => {
    console.log(`Waiting for Google redirect on http://localhost:${PORT} ...`);
  });
});

console.log('\n✓ Success! Add this to your .env file and GitHub Secrets:\n');
console.log('YOUTUBE_REFRESH_TOKEN=' + token.refresh_token);
console.log();
