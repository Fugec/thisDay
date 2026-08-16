/**
 * Local preview generator — generates today's video and saves it to tmp/
 * without uploading to YouTube or touching KV.
 *
 * Run: node preview.js
 */

import "dotenv/config";
import {
  getArticleText,
  getDidYouKnow,
  getOverviewNarration,
  getPostIndex,
  getPostWikipediaUrl,
  getQuickFacts,
} from "./lib/kv.js";
import { generateVideo } from "./lib/video.js";
import { videoMatchTitle } from "./lib/titles.js";
import { generateNarration } from "./lib/elevenlabs.js";
import {
  assessNarrationCaptionIntegrity,
  auditNarrationTopicConnection,
} from "./lib/narration-selection.js";
import { prepareNarrationSource } from "./lib/narration-source.js";
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
  const [overviewText, dyk, qf, articleText, wikiUrl] = await Promise.all([
    getOverviewNarration(slug),
    getDidYouKnow(slug),
    getQuickFacts(slug),
    getArticleText(slug).catch(() => null),
    getPostWikipediaUrl(slug),
  ]);
  const narration = prepareNarrationSource(post, {
    overviewText,
    didYouKnow: dyk,
    quickFacts: qf,
    articleText,
  });
  const topicContext = narration.topicContext;
  const narrationParts = narration.narrationParts;
  const contentItems = narration.contentItems;
  console.log(
    narration.source === "overview"
      ? `Narration source: Overview (${narration.overviewAssessment.words} words)`
      : `Narration source: curated facts (${narration.overviewAssessment.reasons.join("; ")})`,
  );
  const topicAudit = auditNarrationTopicConnection(
    videoMatchTitle(post),
    narrationParts,
    topicContext,
    { continuousNarrative: narration.source === "overview" },
  );
  if (!topicAudit.ok) {
    throw new Error(
      "NARRATION_TOPIC_MISMATCH: preview refused unrelated narration facts",
    );
  }

  const script = narrationParts.join(" ");
  console.log(`Narration script: "${script}"`);

  const { path: narrationPath, words } = await generateNarration(slug, script);
  const captionAudit = assessNarrationCaptionIntegrity(script, words);
  if (!captionAudit.ok) {
    throw new Error(`NARRATION_CAPTION_MISMATCH: ${captionAudit.reason}`);
  }
  const bgMusicPath = getMusicPath();
  const useAiImage = process.env.USE_AI_IMAGE !== "false";

  const videoResult = await generateVideo(post, {
    narrationPath,
    bgMusicPath,
    words,
    useAiImage,
    contentItems,
    wikiArticleUrl: wikiUrl,
    narrationParts,
  });

  console.log(`\n✓ Preview video ready: ${videoResult.path}`);
  console.log(`  Open with: open "${videoResult.path}"`);
}

main().catch((err) => { console.error(err); process.exit(1); });
