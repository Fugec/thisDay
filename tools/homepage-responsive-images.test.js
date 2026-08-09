import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const script = readFileSync(join(root, "js/script.js"), "utf8");
const seoWorker = readFileSync(join(root, "js/seo-worker.js"), "utf8");
const serviceWorker = readFileSync(join(root, "sw.js"), "utf8");
const customCss = readFileSync(join(root, "css/custom.css"), "utf8");

test("homepage image helper builds width-descriptor proxy candidates", () => {
  assert.match(script, /function getResponsiveImageSrcset\(/);
  assert.match(script, /getOptimizedImageUrl\(url, width, quality\)/);
  assert.match(indexHtml, /getResponsiveImageSrcset\(img, \[320, 600, 960\]\)/);
  assert.match(script, /media\.className = "tl-card-img"/);
  assert.match(
    script,
    /getResponsiveImageSrcset\(\s*event\.thumbnailUrl,\s*\[320, 640, 960\],\s*80,?\s*\)/,
  );
  assert.match(script, /body\.className = "tl-card-body"/);
  assert.match(script, /card\.append\(year, media, body\)/);
  assert.match(
    seoWorker,
    /class="tl-card-img" width="640" height="640" loading="lazy" decoding="async"/,
  );
});

test("homepage cards reserve image space and defer below-fold decoding", () => {
  for (const id of [
    "todayEventImg",
    "latest-article-img",
    "bornTodayImg",
    "diedTodayImg",
  ]) {
    const image = indexHtml.match(new RegExp(`<img[\\s\\S]{0,500}id="${id}"[\\s\\S]{0,500}?\\/>`))?.[0] || "";
    assert.match(image, /width="800"/, `${id} must reserve width`);
    assert.match(image, /height="400"/, `${id} must reserve height`);
    assert.match(image, /loading="lazy"/, `${id} must lazy load`);
    assert.match(image, /decoding="async"/, `${id} must decode asynchronously`);
  }
  assert.match(indexHtml, /class="blog-card-img" width="600" height="400" loading="lazy" decoding="async"/);
  assert.match(indexHtml, /width="480" height="360" loading="lazy" decoding="async"/);
});

test("homepage editorial images use edge-to-edge proportional frames", () => {
  assert.match(
    customCss,
    /\.blog-card-img\s*\{[^}]*height:\s*auto[^}]*aspect-ratio:\s*1 \/ 1[^}]*object-fit:\s*cover[^}]*object-position:\s*center top[^}]*filter:\s*none/s,
  );
  assert.match(
    customCss,
    /\.quiz-card-img\s*\{[^}]*height:\s*auto[^}]*aspect-ratio:\s*1 \/ 1[^}]*object-fit:\s*cover[^}]*object-position:\s*center top/s,
  );
  assert.match(indexHtml, /sizes="\(max-width: 900px\) 70vw, 25vw"/);
  assert.match(seoWorker, /sizes="\(max-width: 900px\) 70vw, 25vw"/);
});

test("people, modal, and compact born/died images have explicit dimensions", () => {
  assert.match(script, /img\.width = 80;\s+img\.height = 80;/);
  assert.match(script, /img\.loading = "lazy";\s+img\.decoding = "async";/);
  assert.match(script, /width="160" height="120" loading="lazy" decoding="async"/);
  assert.match(script, /width="36" height="36" loading="lazy" decoding="async"/);
});

test("calendar modal omits missing or failed event, birth, and death images", () => {
  assert.doesNotMatch(script, /modal-tl-media modal-tl-media-blank/);
  assert.doesNotMatch(script, /born-died-thumb-placeholder/);
  assert.match(script, /onerror="this\.parentElement\.remove\(\)"/);
  assert.match(script, /class="born-died-thumb"[^>]*onerror="this\.remove\(\)"/);
});

test("carousel eagerly loads only its first responsive image", () => {
  assert.match(script, /getResponsiveImageSrcset\(\s*event\.sourceImageUrl/);
  assert.match(script, /srcset="\$\{responsiveSrcset\}" sizes="100vw"/);
  assert.match(script, /fetchpriority="high" loading="eager"/);
  assert.match(script, /fetchpriority="low" loading="lazy"/);
});

test("homepage static asset versions are current", () => {
  assert.match(indexHtml, /js\/script\.js\?v=27/);
  assert.match(indexHtml, /custom\.css\?v=51/);
  assert.match(indexHtml, /style\.css\?v=10/);
  assert.match(serviceWorker, /const CACHE_NAME = "thisday-v36"/);
  assert.match(serviceWorker, /"\/js\/script\.js\?v=27"/);
  assert.match(serviceWorker, /"\/css\/custom\.css\?v=51"/);
  assert.match(serviceWorker, /"\/css\/style\.css\?v=10"/);
  assert.match(seoWorker, /custom\.css\?v=51/);
  assert.match(seoWorker, /width="480" height="360" loading="lazy" decoding="async"/);
});
