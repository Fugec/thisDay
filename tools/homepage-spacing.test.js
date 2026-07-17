import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const css = readFileSync(join(root, "css/custom.css"), "utf8");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");

test("gutter token is defined once with a mobile override", () => {
  assert.match(css, /:root \{[\s\S]*?--gutter-x: 40px;/);
  assert.match(css, /@media \(max-width: 768px\) \{\s*:root \{\s*--gutter-x: 1\.7rem;/);
  assert.equal(css.match(/--gutter-x:/g).length, 2);
});

test("hero, titles, and paragraphs share the gutter token", () => {
  assert.match(css, /\.hero-inner \{[\s\S]*?padding: 40px var\(--gutter-x\);/);
  assert.match(
    css,
    /\.homepage-section-title \{[\s\S]*?padding: 40px var\(--gutter-x\);/,
  );
  assert.match(
    css,
    /body\[data-page="v2"\] > \.homepage-section-title \{\s*padding: 28px var\(--gutter-x\) 18px;/,
  );
  assert.match(
    css,
    /body\[data-page="v2"\] > \.homepage-section-title \+ p \{\s*padding: 0 var\(--gutter-x\) 20px !important;/,
  );
  assert.match(css, /\.hero-inner \{[\s\S]*?padding: 2\.35rem var\(--gutter-x\) 2\.4rem;/);
});

test("homepage body sections share the gutter token", () => {
  assert.match(
    css,
    /body\[data-page="v2"\] > \.people-strip \{\s*padding: 1rem var\(--gutter-x\);/,
  );
  assert.match(
    css,
    /body\[data-page="v2"\] > \.people-strip \{\s*padding: 0\.85rem var\(--gutter-x\) 1rem;/,
  );
  assert.match(
    css,
    /body\[data-page="v2"\] > \.faq-section \{\s*padding: 0 var\(--gutter-x\) 3rem;/,
  );
  assert.match(css, /\.calendar-section \{\s*padding: 2\.5rem var\(--gutter-x\);/);
});

test("blog articles keep their original shared-class padding", () => {
  assert.match(css, /\.people-strip \{[\s\S]*?padding: 1rem 1\.5rem;/);
  assert.match(css, /\.people-strip \{\s*padding: 0\.85rem 1rem 1rem;/);
  assert.match(css, /\.faq-section \{\s*padding: 0 1\.5rem 3rem;/);
});

test("inline intro paragraphs use the gutter token", () => {
  assert.doesNotMatch(indexHtml, /padding: 0 10px 28px 30px/);
  assert.doesNotMatch(indexHtml, /padding: 0 10px 0 0/);
  assert.equal(
    indexHtml.match(/padding: 0 var\(--gutter-x\) 28px;/g).length,
    4,
  );
});

test("blog CTA bands collapse to one desktop row with the button right", () => {
  assert.match(
    css,
    /@media \(min-width: 768px\) \{\s*body\[data-page="v2"\] \.blog-cta-col \{\s*flex-direction: row;[\s\S]*?padding: 1\.4rem var\(--gutter-x\);/,
  );
  assert.match(css, /body\[data-page="v2"\] \.blog-cta-col p \{\s*display: none;/);
  assert.match(css, /body\[data-page="v2"\] \.blog-cta-col h2 \{\s*padding: 0;/);
  assert.match(
    css,
    /body\[data-page="v2"\] \.blog-cta-col \.btn \{\s*margin-left: auto;\s*align-self: center;/,
  );
  assert.match(css, /\.blog-cta-col \{[\s\S]*?flex-direction: column;/);
});

test("legacy uneven gutters are gone", () => {
  assert.doesNotMatch(css, /padding: 40px 10px 40px 30px/);
  assert.doesNotMatch(css, /\.homepage-section-title-date \{[^}]*10px/);
  assert.doesNotMatch(css, /\.calendar-section \{[^}]*1\.5rem/);
  assert.doesNotMatch(css, /\.hero \{\s*\}/);
  assert.doesNotMatch(css, /\.hero-inner \{\s*padding-inline: 1\.7rem;\s*\}/);
});
