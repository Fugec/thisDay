const ABBREVIATION_PATTERN =
  /\b(?:(?:Dr|Gen|Jr|Lt|Mr|Mrs|Ms|Prof|Sgt|Sr|St|U\.S|U\.K|N\.Y|D\.C)|[A-Z])\./g;

const NARRATION_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "among",
  "article",
  "because",
  "before",
  "being",
  "between",
  "during",
  "event",
  "from",
  "history",
  "into",
  "later",
  "more",
  "most",
  "other",
  "over",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "through",
  "under",
  "were",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
  "year",
  "years",
]);

const HARD_FILLER_PATTERNS = [
  /\b(?:published|event date|editorial team|min read)\b/i,
  /\b(?:significant|pivotal|important|tragic) event\b/i,
  /\b(?:lasting|enduring) (?:impact|legacy)\b/i,
  /\bwidely (?:recognized|reported|covered|remembered)\b/i,
  /\bdrew widespread (?:attention|condolences|media coverage)\b/i,
  /\bthorough and meticulous process\b/i,
  /\bunique perspective on\b/i,
  /\bcommitted to exploring\b/i,
  /\bremembered as (?:an?\s+)?(?:prominent|important|influential|major)?\s*(?:public|social|historical)?\s*(?:figure|personality)\b/i,
  /\bshocked the nation\b/i,
  /\bserves as a reminder\b/i,
  /\bit is important to remember\b/i,
  /\bthe article\b|\bsource material\b/i,
  /\bwould have\b|\bcould have\b|\bmight have\b|\bmay have\b/i,
  /\bhow such a tragedy could have been prevented\b/i,
  /\bprovid(?:ed|es|ing) valuable insights\b/i,
  /\bsymboli[sz](?:e[ds]?|ing)\b/i,
];

const SOFT_FILLER_PATTERNS = [
  /\bas (?:documented|reported|noted|described|recorded) (?:by|in)\b/i,
  /\baccording to\b/i,
  /\bvarious (?:biographies|publications|reports|sources)\b/i,
  /\bincluding (?:the )?new york times\b/i,
  /\bthe available source\b/i,
  /\bmedia (?:attention|coverage|outlets)\b/i,
  /\bpublic and the media\b/i,
  /\bsymboli[sz]ing\b/i,
];

const INTEREST_PATTERNS = [
  /\b(?:first|last|only|youngest|oldest|largest|smallest|deadliest|secret|unexpected)\b/i,
  /\b(?:assassinated|captured|crashed|died|disappeared|escaped|executed|killed|launched|rescued|salut(?:e[ds]?|ing)|survived|vanished|wounded)\b/i,
  /\b(?:record|world record|iconic|never before|for the first time)\b/i,
  /\b(?:wife|husband|sister|brother|daughter|son|president|queen|king|emperor)\b/i,
];

function normalizeText(value) {
  return String(value || "")
    .replace(/&(?:nbsp|amp|quot|apos|#39);/gi, " ")
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function splitNarrationSentences(value) {
  const clean = normalizeText(value);
  if (!clean) return [];
  const protectedText = clean.replace(
    ABBREVIATION_PATTERN,
    (match) => match.replace(/\./g, "\u0001"),
  );
  return protectedText
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(/\u0001/g, ".").trim())
    .filter(Boolean);
}

function stripFactLabel(value) {
  return normalizeText(value).replace(
    /^(?:event|date|location|key figure|source detail|confirmed outcome|significance|legacy|impact|record|investigation|trial|decision):\s*/i,
    "",
  );
}

function removeLowValueAttribution(value) {
  let text = normalizeText(value)
    .replace(/^(?:according to|as (?:documented|reported|noted|described) by)\s+[^,]{3,100},\s*/i, "")
    .replace(/,\s+as (?:documented|reported|noted|described|recorded|photographed) (?:by|in)\s+[\s\S]*$/i, "")
    .replace(/,\s+which was widely (?:reported|covered)\s+[\s\S]*$/i, "")
    .replace(/,\s+which was featured in several publications[\s\S]*$/i, "")
    .replace(/,\s+and was widely recognized for[\s\S]*$/i, "")
    .trim();

  const knownForMatch = text.match(
    /^(.{3,80}?)\s+was\b[\s\S]*?\bwhere\s+(?:he|she)\s+was known for\s+(.+)$/i,
  );
  if (knownForMatch) {
    text = `${knownForMatch[1].trim()} was known for ${knownForMatch[2].trim()}`;
  }

  if (text.length > 330) {
    const prefix = text.slice(0, 330);
    const boundary = Math.max(
      prefix.lastIndexOf("."),
      prefix.lastIndexOf(";"),
      prefix.lastIndexOf(","),
    );
    text = boundary >= 120 ? prefix.slice(0, boundary) : prefix.replace(/\s+\S*$/, "");
  }

  text = text.replace(/[,:;]\s*$/, "").trim();
  if (text && !/[.!?]$/.test(text)) text += ".";
  return text;
}

function narrationTokens(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(
      (token) =>
        token.length >= 4 &&
        !NARRATION_STOPWORDS.has(token) &&
        !/^\d+$/.test(token),
    );
}

function tokenOverlap(left, right) {
  const a = new Set(narrationTokens(left));
  const b = new Set(narrationTokens(right));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  return shared / Math.min(a.size, b.size);
}

function properNounCount(value) {
  return (
    normalizeText(value).match(
      /\b[A-Z][A-Za-z.'-]{2,}(?:\s+[A-Z][A-Za-z.'-]{2,})*/g,
    ) || []
  ).length;
}

export function narrationFactScore(value, title = "") {
  const text = normalizeText(value);
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 5 || words.length > 52) return -100;
  if (HARD_FILLER_PATTERNS.some((pattern) => pattern.test(text))) return -100;

  let score = 0;
  const numberCount = (text.match(/\b\d[\d,.]*\b/g) || []).length;
  score += Math.min(numberCount, 3) * 2;
  score += Math.min(properNounCount(text), 4);
  score += INTEREST_PATTERNS.reduce(
    (total, pattern) => total + (pattern.test(text) ? 4 : 0),
    0,
  );
  score -= SOFT_FILLER_PATTERNS.reduce(
    (total, pattern) => total + (pattern.test(text) ? 3 : 0),
    0,
  );
  if (words.length >= 12 && words.length <= 34) score += 3;
  if (words.length > 42) score -= 4;
  if (/\bwas born\b/i.test(text) && !/\b(?:born|birth)\b/i.test(title)) score -= 7;
  if (/\bearly childhood\b/i.test(text)) score -= 2;

  const titleLead = String(title || "").split(/\s+[—–-]\s+/)[0];
  const titleSimilarity = tokenOverlap(text, titleLead);
  if (titleSimilarity >= 0.75) score -= 8;
  else if (titleSimilarity >= 0.5) score -= 3;
  if (
    /\b(?:crash|dies?|died|death|killed)\b/i.test(titleLead) &&
    /\b(?:crash|dies?|died|death|killed)\b/i.test(text)
  ) {
    score -= 7;
  }

  return score;
}

export function isInterestingNarrationFact(value, title = "") {
  return narrationFactScore(value, title) >= 4;
}

function candidateSentences(items) {
  const primary = Array.isArray(items) ? items : [];
  const candidates = [];

  for (const item of primary) {
    const stripped = stripFactLabel(item);
    const sentences = splitNarrationSentences(stripped);
    for (const sentence of sentences) {
      const cleaned = removeLowValueAttribution(sentence);
      if (cleaned) candidates.push(cleaned);
    }
  }
  return candidates;
}

function scoredCandidates(title, items) {
  return candidateSentences(items).map((text, sourceOrder) => ({
    text,
    sourceOrder,
    score: narrationFactScore(text, title),
  }));
}

function rankedCandidates(title, items) {
  return scoredCandidates(title, items)
    .filter((candidate) => candidate.score >= 4)
    .sort(
      (left, right) =>
        right.score - left.score || left.sourceOrder - right.sourceOrder,
    );
}

// The interest scorer deliberately penalizes facts that restate the title, so
// for multi-year events (wars, reigns) the fact describing the anniversary day
// itself tends to lose to dramatic facts from elsewhere in the timespan. A
// date hint (the dated factual headline) lets selection reserve the opening
// slot for the day's own event.
const EVENT_START_PATTERN =
  /\b(?:began|begins|beginning|broke out|breaks out|outbreak|erupt(?:ed|s)|coup|uprising|revolt|rebellion|insurrection|invasion|invaded|declared war|started|starts)\b/i;

function parseDateHint(dateHint) {
  const matches = [
    ...String(dateHint || "").matchAll(
      /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{3,4})\b/g,
    ),
  ];
  const last = matches[matches.length - 1];
  if (!last) return null;
  return { month: last[1], day: parseInt(last[2], 10), year: parseInt(last[3], 10) };
}

function dayRelevanceBonus(text, hint) {
  if (!hint) return 0;
  const clean = normalizeText(text);
  const monthNearYear = new RegExp(
    `\\b(?:${hint.day}\\s+)?${hint.month}\\b[^.;]{0,40}?\\b${hint.year}\\b|\\b${hint.month}\\s+${hint.day}\\b`,
    "i",
  );
  let bonus = 0;
  if (monthNearYear.test(clean)) bonus += 8;
  else if (
    new RegExp(`\\b${hint.year}\\b`).test(clean) &&
    EVENT_START_PATTERN.test(clean)
  ) {
    bonus += 7;
  }
  if (bonus > 0 && EVENT_START_PATTERN.test(clean)) bonus += 4;
  return bonus;
}

function pickDayFact(title, hint, items, articleText) {
  if (!hint) return null;
  const pools = [items];
  if (articleText) pools.push(splitNarrationSentences(articleText));
  for (const pool of pools) {
    const candidates = scoredCandidates(title, pool)
      .map((candidate) => ({
        ...candidate,
        day: dayRelevanceBonus(candidate.text, hint),
      }))
      .filter((candidate) => candidate.score > -100 && candidate.day >= 7)
      .sort(
        (left, right) =>
          right.score + right.day - (left.score + left.day) ||
          left.sourceOrder - right.sourceOrder,
      );
    if (candidates.length > 0) return candidates[0];
  }
  return null;
}

function earliestYear(text) {
  const years = String(text).match(/\b(?:1\d{3}|20\d{2})\b/g);
  return years ? Math.min(...years.map(Number)) : Infinity;
}

export function selectInterestingNarrationFacts(
  title,
  items,
  articleText = null,
  { limit = 3, dateHint = "" } = {},
) {
  const selected = [];

  const addRankedCandidates = (ranked) => {
    for (const candidate of ranked) {
      if (
        selected.some(
          (existing) =>
            tokenOverlap(existing.text, candidate.text) >= 0.58,
        )
      ) {
        continue;
      }
      selected.push(candidate);
      if (selected.length >= limit) break;
    }
  };

  const dayFact = pickDayFact(title, parseDateHint(dateHint), items, articleText);
  if (dayFact) selected.push(dayFact);

  addRankedCandidates(rankedCandidates(title, items));
  if (selected.length < limit && articleText) {
    addRankedCandidates(
      rankedCandidates(title, splitNarrationSentences(articleText)),
    );
  }

  if (dayFact && selected.length > 1) {
    const rest = selected.slice(1);
    rest.sort((left, right) => earliestYear(left.text) - earliestYear(right.text));
    return [selected[0], ...rest].map((candidate) => candidate.text);
  }

  return selected.map((candidate) => candidate.text);
}
