#!/usr/bin/env node
/**
 * Interactive read-only Google Search Console OAuth authorization.
 *
 * This local-only helper:
 *   1. starts a loopback callback on a random localhost port;
 *   2. uses PKCE and a CSRF state token;
 *   3. requests only webmasters.readonly;
 *   4. verifies access to sc-domain:thisday.info;
 *   5. atomically updates the gitignored .secrets file without logging tokens.
 *
 * Usage:
 *   node tools/gsc-authorize.js
 *   node tools/gsc-authorize.js --client path/to/client_secret.json
 */

import {
  chmodSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  createHash,
  randomBytes,
} from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CLIENT_PATH = join(
  ROOT,
  "client_secret_580680514792-27t8semaqos75v0aonftg1cptmklnb34.apps.googleusercontent.com.json",
);
const SECRETS_PATH = join(ROOT, ".secrets");
const PROPERTY = "sc-domain:thisday.info";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    clientPath: DEFAULT_CLIENT_PATH,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--client") options.clientPath = argv[++index] || "";
    else if (arg.startsWith("--client=")) {
      options.clientPath = arg.slice("--client=".length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!options.clientPath) throw new Error("--client requires a JSON path.");
  if (!isAbsolute(options.clientPath)) {
    options.clientPath = resolve(ROOT, options.clientPath);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node tools/gsc-authorize.js [options]

Options:
  --client PATH   Installed/Desktop OAuth client JSON.
  -h, --help      Show this help.

The helper requests only Search Console read access and stores tokens in the
gitignored .secrets file. It never writes website content or production KV.`);
}

function loadInstalledClient(path) {
  const document = JSON.parse(readFileSync(path, "utf8"));
  const client = document.installed;
  if (!client?.client_id || !client?.client_secret) {
    throw new Error("OAuth JSON must contain installed.client_id and installed.client_secret.");
  }
  return {
    clientId: String(client.client_id),
    clientSecret: String(client.client_secret),
  };
}

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createPkce() {
  const verifier = base64Url(randomBytes(64));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function buildAuthorizationUrl({
  clientId,
  redirectUri,
  challenge,
  state,
}) {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return url.href;
}

async function exchangeAuthorizationCode({
  clientId,
  clientSecret,
  code,
  redirectUri,
  verifier,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(
      `OAuth token exchange failed (${response.status}): ${data.error_description || data.error || "unknown error"}`,
    );
  }
  if (!data.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Revoke the old app grant and retry with consent.",
    );
  }
  return data;
}

async function verifyPropertyAccess(accessToken, fetchImpl = fetch) {
  const response = await fetchImpl("https://www.googleapis.com/webmasters/v3/sites", {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Search Console property check failed (${response.status}): ${data.error?.message || "unknown error"}`,
    );
  }
  const property = (Array.isArray(data.siteEntry) ? data.siteEntry : [])
    .find((entry) => entry.siteUrl === PROPERTY);
  if (!property) {
    throw new Error(
      `The selected Google account does not have access to ${PROPERTY}. No credentials were changed.`,
    );
  }
  return String(property.permissionLevel || "unknown");
}

function upsertEnvValues(source, updates) {
  const lines = String(source || "").split(/\r?\n/);
  const remaining = new Map(Object.entries(updates));
  const output = lines.map((line) => {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
    if (!match || !remaining.has(match[1])) return line;
    const value = remaining.get(match[1]);
    remaining.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  while (output.length && output.at(-1) === "") output.pop();
  if (remaining.size && output.length) output.push("");
  for (const [key, value] of remaining) output.push(`${key}=${value}`);
  return `${output.join("\n")}\n`;
}

function storeCredentials({
  clientId,
  clientSecret,
  refreshToken,
  accessToken,
}) {
  let existing = "";
  try {
    existing = readFileSync(SECRETS_PATH, "utf8");
  } catch {
    // A new ignored secrets file is acceptable for first-time setup.
  }
  const updated = upsertEnvValues(existing, {
    GSC_OAUTH_CLIENT_ID: clientId,
    GSC_OAUTH_CLIENT_SECRET: clientSecret,
    GSC_REFRESH_TOKEN: refreshToken,
    GSC_ACCESS_TOKEN: accessToken,
  });
  const temporaryPath = `${SECRETS_PATH}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, updated, { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, SECRETS_PATH);
  chmodSync(SECRETS_PATH, 0o600);
}

function htmlResponse(response, status, title, message) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:680px;margin:4rem auto;padding:0 1rem">
  <h1>${title}</h1>
  <p>${message}</p>
  <p>You can close this tab and return to Codex.</p>
</body>
</html>`);
}

async function authorize({
  clientPath = DEFAULT_CLIENT_PATH,
  fetchImpl = fetch,
  timeoutMs = CALLBACK_TIMEOUT_MS,
} = {}) {
  const client = loadInstalledClient(clientPath);
  const { verifier, challenge } = createPkce();
  const state = base64Url(randomBytes(32));

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close(() => {
        if (error) rejectPromise(error);
        else resolvePromise(result);
      });
    };

    const server = createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url || "/", "http://localhost");
        if (requestUrl.searchParams.get("state") !== state) {
          htmlResponse(response, 400, "Authorization rejected", "The OAuth state check failed.");
          finish(new Error("OAuth state mismatch. Credentials were not changed."));
          return;
        }
        const oauthError = requestUrl.searchParams.get("error");
        if (oauthError) {
          htmlResponse(response, 400, "Authorization cancelled", "Google authorization was not granted.");
          finish(new Error(`Google authorization failed: ${oauthError}`));
          return;
        }
        const code = requestUrl.searchParams.get("code");
        if (!code) {
          htmlResponse(response, 400, "Authorization rejected", "No authorization code was returned.");
          finish(new Error("OAuth callback did not contain an authorization code."));
          return;
        }
        const address = server.address();
        const redirectUri = `http://localhost:${address.port}`;
        const tokens = await exchangeAuthorizationCode({
          ...client,
          code,
          redirectUri,
          verifier,
          fetchImpl,
        });
        const permissionLevel = await verifyPropertyAccess(
          tokens.access_token,
          fetchImpl,
        );
        storeCredentials({
          ...client,
          refreshToken: tokens.refresh_token,
          accessToken: tokens.access_token,
        });
        htmlResponse(
          response,
          200,
          "Search Console authorized",
          `Read-only access to ${PROPERTY} was verified and saved locally.`,
        );
        finish(null, { permissionLevel, property: PROPERTY });
      } catch (error) {
        htmlResponse(
          response,
          500,
          "Authorization failed",
          "Credentials were not changed. Return to Codex for the error details.",
        );
        finish(error);
      }
    });
    server.on("error", (error) => finish(error));

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const redirectUri = `http://localhost:${address.port}`;
      const authorizationUrl = buildAuthorizationUrl({
        clientId: client.clientId,
        redirectUri,
        challenge,
        state,
      });
      console.log("");
      console.log("Open this Google authorization URL in your browser:");
      console.log("");
      console.log(authorizationUrl);
      console.log("");
      console.log(`Waiting up to ${Math.round(timeoutMs / 60_000)} minutes for the localhost callback…`);
    });

    const timeout = setTimeout(() => {
      finish(new Error("Timed out waiting for Google authorization. Credentials were not changed."));
    }, timeoutMs);
  });
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }
  const result = await authorize({ clientPath: options.clientPath });
  console.log("");
  console.log(`Verified ${result.property} access: ${result.permissionLevel}`);
  console.log("Credentials saved to the ignored .secrets file.");
  console.log("Next: node tools/gsc-weekly.js --inspect-indexing");
}

const isCli = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  main().catch((error) => {
    console.error("ERROR:", error.message);
    process.exitCode = 1;
  });
}

export {
  authorize,
  buildAuthorizationUrl,
  createPkce,
  exchangeAuthorizationCode,
  loadInstalledClient,
  parseArgs,
  upsertEnvValues,
  verifyPropertyAccess,
};
