import "dotenv/config";

import { getPostIndex, getQuickFacts } from "./lib/kv.js";
import {
  auditNarrationTopicConnection,
  buildNarrationTopicContext,
} from "./lib/narration-selection.js";
import { videoMatchTitle } from "./lib/titles.js";
import { getUploaded, updateUploaded } from "./lib/tracker.js";
import {
  auditYoutubeVideo,
  getYoutubeVideo,
  setYoutubeVideoPrivacy,
  verifyYoutubeAuth,
} from "./lib/youtube.js";

async function main() {
  const slug = String(process.env.PROMOTE_SLUG || "").trim();
  if (!slug) throw new Error("PROMOTE_SLUG is required");
  if (process.env.PROMOTE_CONFIRM_TOPIC_REVIEW !== "true") {
    throw new Error(
      "PROMOTE_CONFIRM_TOPIC_REVIEW=true is required before public promotion",
    );
  }

  const [posts, uploaded, quickFacts] = await Promise.all([
    getPostIndex(),
    getUploaded(),
    getQuickFacts(slug),
  ]);
  const post = posts.find((entry) => entry.slug === slug);
  const tracked = uploaded[slug];
  if (!post) throw new Error(`Post ${slug} is not present in the blog index`);
  if (!tracked?.youtubeId) {
    throw new Error(`No review upload is tracked for ${slug}`);
  }
  console.log(
    `Review tracker: youtubeId=${tracked.youtubeId}, privacy=${tracked.privacy || "unknown"}`,
  );
  if (tracked.privacy === "public") {
    console.warn(
      "Tracker privacy is stale/public; requiring the live YouTube private-state audit before promotion.",
    );
  }

  const storedAudit = tracked.topicAudit;
  if (
    storedAudit?.version !== 1 ||
    storedAudit?.connected !== true ||
    !Array.isArray(storedAudit?.facts) ||
    !storedAudit.facts.length ||
    !storedAudit.script ||
    Number(storedAudit.captionCoverage) < 0.9
  ) {
    throw new Error(`The review upload for ${slug} has no complete topic audit`);
  }

  const title = videoMatchTitle(post);
  const topicContext = buildNarrationTopicContext(post, quickFacts);
  const freshAudit = auditNarrationTopicConnection(
    title,
    storedAudit.facts,
    topicContext,
  );
  const rebuiltScript = storedAudit.facts
    .map((fact) => String(fact || "").trim())
    .filter(Boolean)
    .join(" ");
  if (!freshAudit.ok) {
    const failures = freshAudit.results
      .filter((result) => !result.connected)
      .map((result) => `${result.reason}: ${result.text}`)
      .join(" | ");
    throw new Error(`TOPIC_REVIEW_FAILED: ${failures}`);
  }
  if (rebuiltScript !== storedAudit.script) {
    throw new Error(
      "TOPIC_REVIEW_FAILED: stored narration does not match the audited facts",
    );
  }

  await verifyYoutubeAuth();
  const reviewVideo = await getYoutubeVideo(tracked.youtubeId);
  const reviewVideoAudit = auditYoutubeVideo(post, reviewVideo, {
    expectedPrivacy: "private",
  });
  if (!reviewVideoAudit.ok) {
    throw new Error(
      `YOUTUBE_REVIEW_MISMATCH: ${reviewVideoAudit.reasons.join("; ")}`,
    );
  }

  console.log(`Topic review passed for ${slug}:`);
  storedAudit.facts.forEach((fact, index) =>
    console.log(`  ${index + 1}. ${fact}`),
  );

  // A same-state update proves the OAuth token can change privacy before the
  // currently public video is touched.
  await setYoutubeVideoPrivacy(tracked.youtubeId, "private");
  const immediateTopicAudit = auditNarrationTopicConnection(
    title,
    storedAudit.facts,
    topicContext,
  );
  const immediateVideoAudit = auditYoutubeVideo(
    post,
    await getYoutubeVideo(tracked.youtubeId),
    { expectedPrivacy: "private" },
  );
  if (!immediateTopicAudit.ok || !immediateVideoAudit.ok) {
    throw new Error(
      "FINAL_TOPIC_RECHECK_FAILED: review upload remains private",
    );
  }

  let replacedWasPublic = false;
  const replacedId =
    tracked.replacesYoutubeId && tracked.replacesYoutubeId !== tracked.youtubeId
      ? tracked.replacesYoutubeId
      : "";
  if (replacedId) {
    const replaced = await getYoutubeVideo(replacedId);
    replacedWasPublic = replaced?.status?.privacyStatus === "public";
    if (replaced && replaced.status?.privacyStatus !== "private") {
      await setYoutubeVideoPrivacy(replacedId, "private");
      const hidden = await getYoutubeVideo(replacedId);
      if (hidden?.status?.privacyStatus !== "private") {
        throw new Error(`Previous video ${replacedId} could not be made private`);
      }
      console.log(`Previous video ${replacedId} is now private.`);
    }
  }

  try {
    await setYoutubeVideoPrivacy(tracked.youtubeId, "public");
    const promoted = await getYoutubeVideo(tracked.youtubeId);
    const promotedAudit = auditYoutubeVideo(post, promoted, {
      expectedPrivacy: "public",
    });
    if (!promotedAudit.ok) {
      throw new Error(
        `YouTube promotion audit failed: ${promotedAudit.reasons.join("; ")}`,
      );
    }
    await updateUploaded(slug, {
      privacy: "public",
      reviewedAt: new Date().toISOString(),
      topicAudit: {
        ...storedAudit,
        recheckedAt: new Date().toISOString(),
        connected: true,
      },
    });
  } catch (error) {
    await setYoutubeVideoPrivacy(tracked.youtubeId, "private").catch(() => {});
    if (replacedWasPublic && replacedId) {
      await setYoutubeVideoPrivacy(replacedId, "public").catch(() => {});
    }
    throw error;
  }

  console.log(
    `Promoted reviewed video: https://www.youtube.com/shorts/${tracked.youtubeId}`,
  );
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
