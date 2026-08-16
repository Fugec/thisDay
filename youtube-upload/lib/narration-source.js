import {
  assessOverviewNarration,
  buildNarrationParts,
  buildOverviewNarrationParts,
} from "./elevenlabs.js";
import {
  auditNarrationTopicConnection,
  buildNarrationTopicContext,
  selectInterestingNarrationFacts,
} from "./narration-selection.js";
import { videoHeadlineTitle, videoMatchTitle } from "./titles.js";

/**
 * Chooses the exact narration text without making an AI call.
 *
 * A sufficiently dense, topic-connected Overview paragraph wins. Current
 * Overview paragraphs are already chronological miniature narratives and are
 * kept verbatim. Older/thin/malformed articles retain the established
 * Did You Know + Quick Facts selector.
 */
export function prepareNarrationSource(
  post,
  {
    overviewText = null,
    didYouKnow = [],
    quickFacts = [],
    articleText = null,
  } = {},
) {
  const title = videoMatchTitle(post);
  const topicContext = buildNarrationTopicContext(post, quickFacts);
  const overviewAssessment = assessOverviewNarration(overviewText);

  if (overviewAssessment.ok) {
    const overviewParts = buildOverviewNarrationParts(overviewAssessment.text);
    const overviewTopicAudit = auditNarrationTopicConnection(
      title,
      overviewParts,
      topicContext,
      { continuousNarrative: true },
    );
    if (overviewTopicAudit.ok) {
      return {
        source: "overview",
        narrationParts: overviewParts,
        contentItems: overviewParts,
        topicContext,
        topicAudit: overviewTopicAudit,
        overviewAssessment,
        fallbackItems: [],
      };
    }
    overviewAssessment.reasons.push(
      ...overviewTopicAudit.results
        .filter((result) => !result.connected)
        .map((result) => `overview topic check: ${result.reason}`),
    );
    overviewAssessment.ok = false;
  }

  const fallbackItems = [
    ...(Array.isArray(didYouKnow) ? didYouKnow : []),
    ...(Array.isArray(quickFacts) ? quickFacts : []),
  ];
  const selected = selectInterestingNarrationFacts(
    title,
    fallbackItems,
    articleText,
    {
      limit: 3,
      dateHint: videoHeadlineTitle(post),
      topicContext,
    },
  );
  const preparedParts = buildNarrationParts(post, selected);
  const preparedAudit = auditNarrationTopicConnection(
    title,
    preparedParts,
    topicContext,
  );
  const narrationParts = preparedAudit.results
    .filter((result) => result.connected)
    .map((result) => result.text);
  const topicAudit = auditNarrationTopicConnection(
    title,
    narrationParts,
    topicContext,
  );

  return {
    source: "curated-facts",
    narrationParts,
    contentItems: selected,
    topicContext,
    topicAudit,
    overviewAssessment,
    fallbackItems,
  };
}
