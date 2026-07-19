import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const css = readFileSync(join(root, "css/custom.css"), "utf8");
const script = readFileSync(join(root, "js/script.js"), "utf8");

test("homepage people labels stay visible while their horizontal group slides", () => {
  assert.match(
    css,
    /\.people-group-wrap \.group-label \{\s*position: sticky;\s*left: 0;\s*z-index: 2;\s*align-self: flex-start;\s*width: max-content;\s*max-width: 100%;\s*background: #fff;/,
  );
  assert.match(
    script,
    /wrap\.appendChild\(label\);\s*wrap\.appendChild\(group\);/,
    "the sticky label must remain bounded by its own people group",
  );
});
