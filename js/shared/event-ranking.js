// Shared historical-event ranking for the daily blog and calendar/date pages.
//
// Eligibility belongs to each caller because the blog has stricter publication
// requirements than a calendar page. This module only ranks eligible events; it
// never removes a topic category.

const SHARED_ROYAL_SUCCESSION_PATTERN =
  /\b(coronation|crowned|enthroned|papal election|papal conclave|antipope)\b|\b(elected|election of|becomes|proclaimed|acclaimed)\b[a-z0-9\s]{0,40}\b(pope|king|queen|emperor|tsar|sultan|caliph)\b|\b(pope|king|queen|emperor)\b[a-z0-9\s]{0,30}\b(is elected|is crowned)\b/;

const GENERIC_EVENT_PAGE_TITLES = new Set([
  "history",
  "calendar year",
  "list of years",
  "common year",
  "leap year",
]);

const CIVIC_RIGHTS_PATTERN =
  /\b(abolish\w*|civil rights|desegregat\w*|emancipat\w*|enfranchis\w*|equal rights|freedom|freed|human rights|slav(?:e|es|ery|ed|ing)\w*|suffrage|women(?:s| s) rights)\b/;
const LASTING_INSTITUTION_PATTERN =
  /\b(becomes? (?:a |an |the )?(?:federal|national|public) holiday|constitution|declaration|federal holiday|law|legislation|officially celebrated|public holiday|reform)\b/;
const LANDMARK_PATTERN =
  /\b(first|first ever|first officially|inaugural|landmark|largest|milestone|pioneer\w*|record altitude|record breaking|world s first)\b/;
const VIOLENCE_OR_DISASTER_PATTERN =
  /\b(crash|crashes|crashed|disaster|bomb\w*|shooting|massacre|assassinat\w*|deport\w*|wildfire|fire|explo\w*|earthquake|tsunami|famine|epidemic|pandemic|hijack\w*|genocide)\b/;
const ARMED_CONFLICT_PATTERN =
  /\b(battle|war|warfare|invasion|invades|coup|revolution|crisis|siege|uprising|rebellion|insurgency)\b/;
const CONSTRUCTIVE_MILESTONE_PATTERN =
  /\b(discover\w*|invent\w*|breakthrough|premiere|publish\w*|founded|founding|establish\w*|independence|treaty|peace|elect(?:ed|ion|oral|s)|coronation|crown\w*|expedition|spaceflight|orbit\w*|vaccine|nobel|unveil\w*|inaugurat\w*|charter\w*|abolish\w*|suffrage)\b/;
const ROUTINE_RESULT_PATTERN =
  /\b(regular season|preseason|friendly match|league match|exhibition match|qualifying match|is traded to|signs? (?:for|with) (?:the )?[a-z0-9 ]{2,40} club|appointed (?:head )?coach|scores? (?:his|her|their) \d+(?:st|nd|rd|th) career)\b/;
const ROUTINE_ASTRONOMY_PATTERN =
  /\b(passes within [a-z0-9,. ]{0,45}(?:earth|moon)|closest approach to (?:earth|the moon)|meteor shower peaks?)\b/;

export function normalizeRankingText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function sharedIsGenericEventPageTitle(pageTitle) {
  const normalized = normalizeRankingText(pageTitle);
  return (
    GENERIC_EVENT_PAGE_TITLES.has(normalized) ||
    /^(?:ad )?\d{1,4}$/.test(normalized)
  );
}

export function scoreHistoricalEventSignificance(event, options = {}) {
  const haystack = normalizeRankingText(
    `${event?.pageTitle || ""} ${event?.text || ""}`,
  );
  const title = normalizeRankingText(event?.pageTitle || "");
  const signals = [];
  let editorialScore = 0;

  const add = (points, signal) => {
    editorialScore += points;
    signals.push({ signal, points });
  };

  // Dedicated year-prefixed event pages are usually a stronger article seed
  // than a country, institution, or person page attached to the feed entry.
  // This is deliberately a small source-quality tie-breaker: a dated title is
  // not evidence that the underlying event is historically more important.
  if (/^\d{4}\b/.test(title)) add(6, "dedicated dated event page");

  // Destructive events remain historically important, but human loss alone
  // must not dominate constructive and civic milestones.
  const hasViolenceOrDisaster = VIOLENCE_OR_DISASTER_PATTERN.test(haystack);
  const hasArmedConflict = ARMED_CONFLICT_PATTERN.test(haystack);
  if (hasViolenceOrDisaster || hasArmedConflict) {
    add(
      hasArmedConflict && !hasViolenceOrDisaster ? 14 : 8,
      hasViolenceOrDisaster && hasArmedConflict
        ? "violence, disaster, or armed conflict"
        : hasViolenceOrDisaster
          ? "disaster or violence"
          : "armed conflict or political upheaval",
    );
  }

  // Royal and papal successions receive one bounded signal rather than
  // stacking election, title, and predecessor-death bonuses.
  if (SHARED_ROYAL_SUCCESSION_PATTERN.test(haystack)) {
    add(12, "royal or papal succession");
  } else {
    const constructiveHaystack = haystack
      .replace(/\bwars? of [a-z0-9 ]{0,50}\bindependence\b/g, " ")
      .replace(/\bwar of national liberation\b/g, " ");
    const hasNonDestructiveLaunch =
      /\blaunch\w*\b/.test(constructiveHaystack) &&
      !hasViolenceOrDisaster &&
      !hasArmedConflict;
    if (
      CONSTRUCTIVE_MILESTONE_PATTERN.test(constructiveHaystack) ||
      hasNonDestructiveLaunch
    ) {
      add(22, "constructive or world-shaping milestone");
    }
    if (
      /\b(john f kennedy|martin luther king|winston churchill|napoleon|atat rk|ataturk|anne boleyn)\b/.test(
        title,
      )
    ) {
      add(20, "globally significant public figure");
    } else if (
      /\b(president|prime minister|foreign minister|supreme leader|head of state)\b/.test(
        haystack,
      )
    ) {
      add(12, "national political officeholder");
    }
  }

  // These phrases were missing from the former blog-only keyword scorer.
  // June 19 consequently treated Juneteenth as a low-value entry even though
  // the feed explicitly describes emancipation, freedom, and lasting public
  // commemoration.
  if (CIVIC_RIGHTS_PATTERN.test(haystack)) {
    add(30, "civil rights, emancipation, or freedom");
  }
  if (LASTING_INSTITUTION_PATTERN.test(haystack)) {
    add(14, "lasting institution, law, or observance");
  }
  if (LANDMARK_PATTERN.test(haystack)) {
    add(14, "first, landmark, or record");
  }

  const humanLossHaystack = haystack
    .replace(/\bdeath penalty\b/g, " ")
    .replace(/\bto kill a mockingbird\b/g, " ");
  if (
    /\b(kill\w*|dead|dies|death|beheaded|surrenders|defeat|defeats)\b/.test(
      humanLossHaystack,
    )
  ) {
    add(4, "human-loss outcome");
  }
  if (/\b(ratifies|cedes|annexes)\b/.test(haystack)) {
    add(8, "state action");
  }
  if (event?.hasThumbnail) add(4, "usable image");
  if (Number.parseInt(event?.extractLength, 10) >= 450) {
    add(4, "substantive source extract");
  }

  if (sharedIsGenericEventPageTitle(event?.pageTitle)) {
    add(-22, "generic source page");
  }
  // Topic categories never affect eligibility and are not penalized merely
  // for being sports, astronomy, local history, or a commemoration. Only a
  // narrowly recognizable routine result receives a modest tie-breaker.
  if (ROUTINE_RESULT_PATTERN.test(haystack)) {
    add(-8, "routine result or transaction");
  }
  if (
    ROUTINE_ASTRONOMY_PATTERN.test(haystack) &&
    !LANDMARK_PATTERN.test(haystack) &&
    !CONSTRUCTIVE_MILESTONE_PATTERN.test(haystack)
  ) {
    add(-8, "routine astronomical occurrence");
  }

  const recentFamilies = new Set(
    Array.isArray(options?.recentEventFamilies)
      ? options.recentEventFamilies
      : [],
  );
  const repeatedFamilies = [
    ...new Set(
      (Array.isArray(event?.eventFamilies) ? event.eventFamilies : []).filter(
        (family) => recentFamilies.has(family),
      ),
    ),
  ];
  const varietyPenalty = repeatedFamilies.length > 0 ? 6 : 0;
  const selectionScore = editorialScore - varietyPenalty;

  return {
    editorialScore,
    varietyPenalty,
    selectionScore,
    repeatedFamilies,
    signals,
  };
}

export function rankHistoricalEventCandidates(events, options = {}) {
  return (Array.isArray(events) ? events : [])
    .map((event, sourceIndex) => ({
      ...event,
      ...scoreHistoricalEventSignificance(event, options),
      sourceIndex,
    }))
    .sort((left, right) => {
      if (right.selectionScore !== left.selectionScore) {
        return right.selectionScore - left.selectionScore;
      }
      const richnessDifference =
        (Number(right?.sourceRichnessScore) || 0) -
        (Number(left?.sourceRichnessScore) || 0);
      if (richnessDifference) return richnessDifference;
      const yearDifference =
        (Number.parseInt(right?.year, 10) || 0) -
        (Number.parseInt(left?.year, 10) || 0);
      if (yearDifference) return yearDifference;
      return left.sourceIndex - right.sourceIndex;
    });
}
