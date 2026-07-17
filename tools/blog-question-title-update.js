#!/usr/bin/env node

/**
 * Guarded production updater for one stored blog article's public question title.
 *
 * Dry-run by default. A production write requires --confirm-production-write.
 * The tool:
 *   - reads post:{slug} and the shared index directly from BLOG_AI_KV;
 *   - saves byte-for-byte backups and a hash manifest under /private/tmp;
 *   - updates only public title surfaces, factual event labels, and one index entry;
 *   - re-reads both values immediately before writing and rejects stale hashes;
 *   - writes the shared index last and verifies both final hashes.
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BLOG_KV_NAMESPACE = "5173c34a7bd04cde9988c0e89d77bb6e";

function parseEnvFile(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

function parseArgs(argv) {
  const out = { confirm: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--confirm-production-write") {
      out.confirm = true;
      continue;
    }
    const key = {
      "--slug": "slug",
      "--question-title": "questionTitle",
      "--factual-title": "factualTitle",
      "--event-title": "eventTitle",
    }[arg];
    if (!key || !argv[i + 1]) throw new Error(`Unknown or incomplete argument: ${arg}`);
    out[key] = argv[i + 1];
    i += 1;
  }
  for (const field of ["slug", "questionTitle", "factualTitle", "eventTitle"]) {
    if (!out[field]) throw new Error(`Missing --${field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  if (!/^\d{1,2}-[a-z]+-\d{4}$/.test(out.slug)) {
    throw new Error(`Invalid daily article slug: ${out.slug}`);
  }
  if (
    !/^(?:How|Why|What|Who|Which|Where)\b/.test(out.questionTitle) ||
    !out.questionTitle.endsWith("?")
  ) {
    throw new Error("Question title must begin with a supported question word and end with ?");
  }
  if (out.questionTitle.length < 35 || out.questionTitle.length > 65) {
    throw new Error(`Question title must be 35-65 characters, got ${out.questionTitle.length}`);
  }
  return out;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function kvRead(env, key) {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}` +
    `/storage/kv/namespaces/${BLOG_KV_NAMESPACE}/values/${encodeURIComponent(key)}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
  });
  if (!response.ok) {
    throw new Error(`KV read ${key} failed: HTTP ${response.status} ${await response.text()}`);
  }
  return response.text();
}

async function kvWrite(env, key, value, contentType) {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}` +
    `/storage/kv/namespaces/${BLOG_KV_NAMESPACE}/values/${encodeURIComponent(key)}`;
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": contentType,
    },
    body: value,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`KV write ${key} failed: HTTP ${response.status} ${body}`);
  }
  try {
    const parsed = JSON.parse(body);
    if (parsed?.success === false) {
      throw new Error(`KV write ${key} rejected: ${body}`);
    }
  } catch (error) {
    if (error.message.includes("rejected")) throw error;
  }
}

function replaceSingle(source, pattern, replacement, label) {
  const matches = source.match(pattern) || [];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label}, found ${matches.length}`);
  }
  return source.replace(pattern, replacement);
}

function patchJsonLd(html, questionTitle, eventTitle, canonical) {
  let articleCount = 0;
  let breadcrumbCount = 0;
  const next = html.replace(
    /(<script\b[^>]*type=["']application\/ld\+json["'][^>]*>)([\s\S]*?)(<\/script>)/gi,
    (full, open, json, close) => {
      let value;
      try {
        value = JSON.parse(json);
      } catch {
        return full;
      }
      let changed = false;
      if (["BlogPosting", "NewsArticle"].includes(value?.["@type"])) {
        articleCount += 1;
        value.headline = questionTitle;
        if (value.about?.["@type"] === "Event") value.about.name = eventTitle;
        changed = true;
      }
      if (value?.["@type"] === "BreadcrumbList") {
        const items = Array.isArray(value.itemListElement) ? value.itemListElement : [];
        const currentItem = items.at(-1);
        if (currentItem?.item === canonical) {
          breadcrumbCount += 1;
          currentItem.name = eventTitle;
          changed = true;
        }
      }
      if (!changed) return full;
      const leadingWhitespace = json.match(/^\s*/)?.[0] || "";
      const trailingWhitespace = json.match(/\s*$/)?.[0] || "";
      const serialized = json.trim().includes("\n")
        ? JSON.stringify(value, null, 2)
        : JSON.stringify(value);
      return `${open}${leadingWhitespace}${serialized}${trailingWhitespace}${close}`;
    },
  );
  if (articleCount !== 1 || breadcrumbCount < 1) {
    throw new Error(
      `Expected one article schema and at least one current-page BreadcrumbList, found ${articleCount}/${breadcrumbCount}`,
    );
  }
  return next;
}

function patchArticleHtml(html, questionTitle, eventTitle) {
  const canonical = html.match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/i)?.[1] || "";
  let next = html;
  next = replaceSingle(
    next,
    /<title>[^<]*<\/title>/gi,
    `<title>${questionTitle}</title>`,
    "HTML title",
  );
  next = replaceSingle(
    next,
    /<meta\b[^>]*property="og:title"[^>]*>/gi,
    `<meta property="og:title" content="${questionTitle}" />`,
    "Open Graph title",
  );
  next = replaceSingle(
    next,
    /<meta\b[^>]*name="twitter:title"[^>]*>/gi,
    `<meta name="twitter:title" content="${questionTitle}" />`,
    "Twitter title",
  );
  next = replaceSingle(
    next,
    /<h1\b([^>]*)>[\s\S]*?<\/h1>/gi,
    `<h1$1>${questionTitle}</h1>`,
    "article H1",
  );
  next = replaceSingle(
    next,
    /<li class="breadcrumb-item active" aria-current="page">[\s\S]*?<\/li>/gi,
    `<li class="breadcrumb-item active" aria-current="page">${eventTitle}</li>`,
    "visible active breadcrumb",
  );
  next = patchJsonLd(next, questionTitle, eventTitle, canonical);
  const afterCanonical =
    next.match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/i)?.[1] || "";
  if (!canonical || afterCanonical !== canonical) {
    throw new Error("Canonical URL changed during title patch");
  }
  for (const [label, pattern] of [
    ["HTML title", new RegExp(`<title>${escapeRegExp(questionTitle)}<\\/title>`)],
    ["H1", new RegExp(`<h1\\b[^>]*>${escapeRegExp(questionTitle)}<\\/h1>`)],
    ["article headline", new RegExp(`"headline":\\s*"${escapeRegExp(questionTitle)}"`)],
    ["event schema name", new RegExp(`"name":\\s*"${escapeRegExp(eventTitle)}"`)],
  ]) {
    if (!pattern.test(next)) throw new Error(`Patched ${label} is missing`);
  }
  return next;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patchIndex(raw, slug, questionTitle, factualTitle, eventTitle) {
  const index = JSON.parse(raw);
  if (!Array.isArray(index)) throw new Error("Shared index is not an array");
  const matches = index.filter((entry) => entry?.slug === slug);
  if (matches.length !== 1) {
    throw new Error(`Expected one ${slug} index entry, found ${matches.length}`);
  }
  const entry = matches[0];
  if (entry.title !== factualTitle && entry.factualTitle !== factualTitle) {
    throw new Error(
      `Index factual-title precondition failed: ${entry.title} / ${entry.factualTitle || "unset"}`,
    );
  }
  entry.title = questionTitle;
  entry.factualTitle = factualTitle;
  entry.eventTitle = eventTitle;
  return JSON.stringify(index);
}

async function verifyHash(env, key, expectedHash) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const value = await kvRead(env, key);
    if (sha256(value) === expectedHash) return true;
    if (attempt < 4) await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = parseEnvFile(resolve(ROOT, "youtube-upload/.env"));
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    throw new Error("Missing CF_ACCOUNT_ID / CF_API_TOKEN in youtube-upload/.env");
  }

  const postKey = `post:${args.slug}`;
  const [postBefore, indexBefore] = await Promise.all([
    kvRead(env, postKey),
    kvRead(env, "index"),
  ]);
  const postAfter = patchArticleHtml(postBefore, args.questionTitle, args.eventTitle);
  const indexAfter = patchIndex(
    indexBefore,
    args.slug,
    args.questionTitle,
    args.factualTitle,
    args.eventTitle,
  );
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const operationDir = `/private/tmp/thisday-question-title-${args.slug}-${timestamp}`;
  mkdirSync(operationDir, { recursive: true });
  writeFileSync(`${operationDir}/post.before.html`, postBefore);
  writeFileSync(`${operationDir}/post.after.html`, postAfter);
  writeFileSync(`${operationDir}/index.before.json`, indexBefore);
  writeFileSync(`${operationDir}/index.after.json`, indexAfter);

  const result = {
    slug: args.slug,
    questionTitle: args.questionTitle,
    factualTitle: args.factualTitle,
    eventTitle: args.eventTitle,
    operationDir,
    productionWrites: 0,
    before: {
      postSha256: sha256(postBefore),
      indexSha256: sha256(indexBefore),
    },
    after: {
      postSha256: sha256(postAfter),
      indexSha256: sha256(indexAfter),
    },
    confirmed: args.confirm,
  };
  writeFileSync(`${operationDir}/result.json`, JSON.stringify(result, null, 2));

  if (!args.confirm) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const [livePost, liveIndex] = await Promise.all([
    kvRead(env, postKey),
    kvRead(env, "index"),
  ]);
  if (
    sha256(livePost) !== result.before.postSha256 ||
    sha256(liveIndex) !== result.before.indexSha256
  ) {
    throw new Error("Live KV changed after planning; refusing stale title update");
  }

  await kvWrite(env, postKey, postAfter, "text/html; charset=utf-8");
  result.productionWrites += 1;
  await kvWrite(env, "index", indexAfter, "application/json");
  result.productionWrites += 1;
  result.verified = {
    post: await verifyHash(env, postKey, result.after.postSha256),
    index: await verifyHash(env, "index", result.after.indexSha256),
  };
  if (!result.verified.post || !result.verified.index) {
    throw new Error(`Post-write verification failed: ${JSON.stringify(result.verified)}`);
  }
  result.completedAt = new Date().toISOString();
  writeFileSync(`${operationDir}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(`ERROR: ${error.stack || error.message}`);
  process.exitCode = 1;
});
