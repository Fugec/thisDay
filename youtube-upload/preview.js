/**
 * Local preview generator — generates today's video and saves it to tmp/
 * without uploading to YouTube or touching KV.
 *
 * Run: node preview.js
 */

import "dotenv/config";
import { getPostIndex, getDidYouKnow, getQuickFacts, getArticleText, getPostWikipediaUrl } from "./lib/kv.js";
import { generateVideo } from "./lib/video.js";
import { videoHeadlineTitle, videoMatchTitle } from "./lib/titles.js";
import { generateNarration, buildNarrationScript, buildNarrationParts } from "./lib/elevenlabs.js";
import { selectInterestingNarrationFacts } from "./lib/narration-selection.js";
import { getMusicPath } from "./lib/music.js";

function getTodaySlug() {
  const now = new Date();
  const day = now.getDate();
  const month = now.toLocaleString("en-US", { month: "long" }).toLowerCase();
  const year = now.getFullYear();
  return `${day}-${month}-${year}`;
}

async function main() {
  const slug = process.argv[2] || getTodaySlug();
  console.log(`Preview: generating video for slug "${slug}" (no upload)`);

  const posts = await getPostIndex();
  const post = posts.find((p) => p.slug === slug);
  if (!post) {
    console.error(`Post "${slug}" not found in KV index.`);
    process.exit(1);
  }
  console.log(`Post: ${post.title}`);

  // Narration content
  const [dyk, qf, articleText, wikiUrl] = await Promise.all([
    getDidYouKnow(slug),
    getQuickFacts(slug),
    getArticleText(slug).catch(() => null),
    getPostWikipediaUrl(slug),
  ]);
  const rawItems = [...(dyk || []), ...(qf || [])];
  const selectedItems = selectInterestingNarrationFacts(
    videoMatchTitle(post),
    rawItems,
    articleText,
    { limit: 3, dateHint: videoHeadlineTitle(post) },
  );
  const contentItems = selectedItems;
  const narrationItems = selectedItems;

  const script = buildNarrationScript(post, narrationItems);
  console.log(`Narration script: "${script}"`);

  const { path: narrationPath, words } = await generateNarration(slug, script);
  const bgMusicPath = getMusicPath();
  const useAiImage = process.env.USE_AI_IMAGE !== "false";

  const videoResult = await generateVideo(post, {
    narrationPath,
    bgMusicPath,
    words,
    useAiImage,
    contentItems: selectedItems,
    wikiArticleUrl: wikiUrl,
    narrationParts: buildNarrationParts(post, narrationItems),
  });

  console.log(`\n✓ Preview video ready: ${videoResult.path}`);
  console.log(`  Open with: open "${videoResult.path}"`);
}

main().catch((err) => { console.error(err); process.exit(1); });
