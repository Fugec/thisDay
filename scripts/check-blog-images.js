#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, "..");
const BLOG_DIR = path.join(ROOT, "blog");
const FALLBACK_IMAGE = "https://thisday.info/images/logo.png";
const FETCH_TIMEOUT_MS = 8000;

const args = new Set(process.argv.slice(2));
const shouldFix = args.has("--fix");

function stripQuotes(v = "") {
  return v.replace(/^['"]|['"]$/g, "").trim();
}

function getAttr(html, regex) {
  const m = html.match(regex);
  return m?.[1] ? stripQuotes(m[1]) : null;
}

function setAttr(html, regex, nextValue) {
  return html.replace(regex, (_full, _prefix, _prev, suffix) => {
    return `${_prefix}${nextValue}${suffix}`;
  });
}

async function walkHtmlFiles(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkHtmlFiles(full)));
    } else if (entry.isFile() && entry.name.toLowerCase() === "index.html") {
      out.push(full);
    }
  }
  return out;
}

async function isImageReachable(url) {
  if (!url) return false;

  // Local path check
  if (url.startsWith("/")) {
    const local = path.join(ROOT, url.replace(/^\//, ""));
    try {
      const stat = await fs.stat(local);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  // Remote URL check
  if (!/^https?:\/\//i.test(url)) return false;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    if ([403, 405, 501].includes(res.status)) {
      res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
      });
    }
    clearTimeout(timer);

    if (!res.ok) return false;
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    return contentType.startsWith("image/");
  } catch {
    return false;
  }
}

async function chooseReplacement(candidates) {
  const seen = new Set();
  for (const candidate of [...candidates, FALLBACK_IMAGE]) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (await isImageReachable(candidate)) return candidate;
  }
  return FALLBACK_IMAGE;
}

function toRelative(p) {
  return path.relative(ROOT, p).split(path.sep).join("/");
}

async function run() {
  const files = await walkHtmlFiles(BLOG_DIR);
  const report = [];

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];

    if (i > 0 && i % 25 === 0) {
      console.error(`Progress: ${i}/${files.length} files scanned...`);
    }

    let html = await fs.readFile(filePath, "utf8");

    const imageSrc = getAttr(
      html,
      /<img[^>]*\bsrc\s*=\s*(["'][^"']+["'])[^>]*>/i,
    );
    const ogImage = getAttr(
      html,
      /<meta[^>]*property=["']og:image["'][^>]*content\s*=\s*(["'][^"']+["'])[^>]*>/i,
    );
    const twitterImage = getAttr(
      html,
      /<meta[^>]*name=["']twitter:image["'][^>]*content\s*=\s*(["'][^"']+["'])[^>]*>/i,
    );

    const checks = [];
    if (imageSrc) checks.push(["hero", imageSrc]);
    if (ogImage) checks.push(["og", ogImage]);
    if (twitterImage) checks.push(["twitter", twitterImage]);

    let changed = false;

    for (const [kind, url] of checks) {
      const ok = await isImageReachable(url);
      if (ok) continue;

      const replacement = await chooseReplacement([
        kind !== "hero" ? imageSrc : null,
        kind !== "og" ? ogImage : null,
        kind !== "twitter" ? twitterImage : null,
      ]);

      report.push({
        file: toRelative(filePath),
        field: kind,
        broken: url,
        replacement,
      });

      if (!shouldFix) continue;

      if (kind === "hero") {
        html = setAttr(
          html,
          /(<img[^>]*\bsrc\s*=\s*["'])([^"']+)(["'][^>]*>)/i,
          replacement,
        );
        changed = true;
      } else if (kind === "og") {
        html = setAttr(
          html,
          /(<meta[^>]*property=["']og:image["'][^>]*content\s*=\s*["'])([^"']+)(["'][^>]*>)/i,
          replacement,
        );
        changed = true;
      } else if (kind === "twitter") {
        html = setAttr(
          html,
          /(<meta[^>]*name=["']twitter:image["'][^>]*content\s*=\s*["'])([^"']+)(["'][^>]*>)/i,
          replacement,
        );
        changed = true;
      }
    }

    if (changed) {
      await fs.writeFile(filePath, html, "utf8");
    }
  }

  const summary = {
    scannedFiles: files.length,
    brokenReferences: report.length,
    fixed: shouldFix,
    details: report,
  };

  console.log(JSON.stringify(summary, null, 2));
}

run().catch((err) => {
  console.error("Image checker failed:", err);
  process.exit(1);
});
