import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { LLMS_TXT_CONTENT } from "../js/shared/llms-content.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const targetPath = resolve(__dirname, "../llms.txt");
const normalized = LLMS_TXT_CONTENT.endsWith("\n")
  ? LLMS_TXT_CONTENT
  : `${LLMS_TXT_CONTENT}\n`;
const checkOnly = process.argv.includes("--check");

let current = "";
try {
  current = readFileSync(targetPath, "utf8");
} catch {
  current = "";
}

if (checkOnly) {
  if (current !== normalized) {
    console.error("llms.txt is out of sync with js/shared/llms-content.js");
    process.exit(1);
  }
  console.log("llms.txt is in sync");
  process.exit(0);
}

writeFileSync(targetPath, normalized, "utf8");
console.log("Updated llms.txt from js/shared/llms-content.js");
