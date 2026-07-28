import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  join(import.meta.dirname, "..", ".github/workflows/youtube-upload.yml"),
  "utf8",
);

test("YouTube upload installs and verifies FFmpeg without a release-discovery action", () => {
  assert.doesNotMatch(workflow, /FedericoCarboni\/setup-ffmpeg/i);
  assert.match(workflow, /for attempt in 1 2 3/);
  assert.match(workflow, /sudo apt-get update/);
  assert.match(
    workflow,
    /sudo apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core/,
  );
  assert.match(workflow, /command -v ffmpeg/);
  assert.match(workflow, /command -v ffprobe/);
  assert.match(workflow, /ffmpeg -version/);
  assert.match(workflow, /ffprobe -version/);
});
