import "dotenv/config";

import { getPostIndex, getQuickFacts } from "./lib/kv.js";
import {
  auditNarrationTopicConnection,
  buildNarrationTopicContext,
} from "./lib/narration-selection.js";
import { videoMatchTitle } from "./lib/titles.js";
import {
  collectReplacedYoutubeIds,
  getUploaded,
  updateUploaded,
} from "./lib/tracker.js";
import {
  auditYoutubeVideo,
  getYoutubeVideo,
  setYoutubeVideoPrivacy,
  verifyYoutubeAuth,
} from "./lib/youtube.js";

async function retireReplacedVideos(post, videoIds) {
  const changedVideos = [];
  try {
    for (const videoId of videoIds) {
      const video = await getYoutubeVideo(videoId);
      if (!video) {
        throw new Error(`Previous video ${videoId} was not found`);
      }
      const metadataAudit = auditYoutubeVideo(post, video);
      if (!metadataAudit.ok) {
        throw new Error(
          `REFUSING_VIDEO_RETIREMENT: ${videoId}: ${metadataAudit.reasons.join("; ")}`,
        );
      }
      const previousPrivacy = video.status?.privacyStatus;
      if (previousPrivacy !== "private") {
        changedVideos.push({ videoId, privacyStatus: previousPrivacy });
        await setYoutubeVideoPrivacy(videoId, "private");
      }
      const hidden = await getYoutubeVideo(videoId);
      if (hidden?.status?.privacyStatus !== "private") {
        throw new Error(`Previous video ${videoId} could not be made private`);
      }
      console.log(`Previous video ${videoId} is now private.`);
    }
    return changedVideos;
  } catch (error) {
    for (const { videoId, privacyStatus } of changedVideos) {
      await setYoutubeVideoPrivacy(videoId, privacyStatus).catch(() => {});
    }
    throw error;
  }
}

async function main() {
  const slug = String(process.env.PROMOTE_SLUG || "").trim();
  const retireOnly = process.env.PROMOTE_RETIRE_ONLY === "true";
  const explicitRetireId = String(
    process.env.PROMOTE_RETIRE_VIDEO_ID || "",
  ).trim();
  if (!slug) throw new Error("PROMOTE_SLUG is required");
  if (process.env.PROMOTE_CONFIRM_TOPIC_REVIEW !== "true") {
    throw new Error(
      "PROMOTE_CONFIRM_TOPIC_REVIEW=true is required before public promotion",
    );
  }
  if (explicitRetireId && !/^[A-Za-z0-9_-]{11}$/.test(explicitRetireId)) {
    throw new Error("PROMOTE_RETIRE_VIDEO_ID is not a valid YouTube video ID");
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
  if (tracked.privacy === "public" && !retireOnly) {
    console.warn(
      "Tracker privacy is stale/public; requiring the live YouTube private-state audit before promotion.",
    );
  }
  if (retireOnly && tracked.privacy !== "public") {
    console.warn(
      "Tracker privacy is stale/non-public; requiring the live YouTube public-state audit before reconciliation.",
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
    expectedPrivacy: retireOnly ? "public" : "private",
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

  const immediateTopicAudit = auditNarrationTopicConnection(
    title,
    storedAudit.facts,
    topicContext,
  );
  const immediateVideoAudit = auditYoutubeVideo(
    post,
    await getYoutubeVideo(tracked.youtubeId),
    { expectedPrivacy: retireOnly ? "public" : "private" },
  );
  if (!immediateTopicAudit.ok || !immediateVideoAudit.ok) {
    throw new Error(
      "FINAL_TOPIC_RECHECK_FAILED: current reviewed upload was not changed",
    );
  }

  if (!retireOnly) {
    // A same-state update proves the OAuth token can change privacy before any
    // replaced public video is touched.
    await setYoutubeVideoPrivacy(tracked.youtubeId, "private");
  }

  const replacementIds = [
    ...collectReplacedYoutubeIds(tracked, tracked.youtubeId),
    explicitRetireId,
  ];
  const uniqueReplacementIds = [...new Set(replacementIds)]
    .filter(Boolean)
    .filter((videoId) => videoId !== tracked.youtubeId);
  if (retireOnly && uniqueReplacementIds.length === 0) {
    throw new Error(
      "PROMOTE_RETIRE_VIDEO_ID or a tracked replacement is required",
    );
  }
  const replacedPreviousPrivacy = await retireReplacedVideos(
    post,
    uniqueReplacementIds,
  );

  if (retireOnly) {
    await updateUploaded(slug, {
      retiredYoutubeIds: [
        ...new Set([
          ...(Array.isArray(tracked.retiredYoutubeIds)
            ? tracked.retiredYoutubeIds
            : []),
          ...uniqueReplacementIds,
        ]),
      ],
      replacementsReconciledAt: new Date().toISOString(),
    });
    console.log(
      `Reconciled replaced videos for reviewed public upload ${tracked.youtubeId}.`,
    );
    return;
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
      retiredYoutubeIds: uniqueReplacementIds,
    });
  } catch (error) {
    await setYoutubeVideoPrivacy(tracked.youtubeId, "private").catch(() => {});
    for (const { videoId, privacyStatus } of replacedPreviousPrivacy) {
      await setYoutubeVideoPrivacy(videoId, privacyStatus).catch(() => {});
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
