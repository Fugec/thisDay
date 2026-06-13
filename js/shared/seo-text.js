// Shared SEO text helpers used by both the blog worker (article generation)
// and the seo worker (date/born/died page rendering). Extracted from
// blog-ai-worker.js so the high-traffic date pages get the same
// abbreviation-safe, clean-truncation, brand-free titles and descriptions.

// Masks the periods inside dotted acronyms / single-letter initials (U.S.,
// D.C., Franklin D.) and a list of common honorifics/abbreviations with a
// placeholder byte so a naive sentence split does not treat them as sentence
// boundaries. Callers restore the placeholder to "." afterward.
export function maskAbbreviationPeriods(text) {
  return String(text || "")
    // dotted acronyms / single-letter initials: U.S., D.C., U.S.S.R., "B."
    .replace(/\b[A-Z]\.(?:[A-Z]\.)*/g, (m) => m.replace(/\./g, "\x01"))
    // honorifics and common abbreviations
    .replace(
      /\b(?:St|Dr|Mr|Mrs|Ms|Prof|Lt|Gen|Sgt|Col|Capt|Maj|Adm|Gov|Sen|Rep|Pres|Jr|Sr|vs|etc|e\.g|i\.e|No|Inc|Ltd|Co|Corp|Mt|Ft)\./gi,
      (m) => m.replace(/\./g, "\x01"),
    );
}

// First sentence of a block of text, with abbreviation/initial periods kept
// intact. Returns whitespace-collapsed text with no enclosing markup handling.
export function extractFirstSentence(text) {
  return maskAbbreviationPeriods(String(text || "").replace(/\s+/g, " ").trim())
    .split(/(?<=[.!?])\s+/)[0]
    .replace(/\x01/g, ".");
}

/**
 * Trims text to a maximum length for use as a meta description / social snippet.
 * Cuts on a word boundary, strips any trailing dangling function word
 * (preposition/article/conjunction) and trailing punctuation, then appends a
 * single ellipsis only when the text was actually shortened. Prevents the
 * "…a historic first televised event with…" mid-clause cut that reads as broken
 * in a Google result and suppresses click-through.
 */
export function truncateForMeta(text, maxLength) {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= maxLength) return clean;
  // Reserve one character for the trailing ellipsis.
  let out = clean
    .slice(0, maxLength - 1)
    .replace(/\s+\S*$/, "")
    .trim();
  const TRAILING_FUNCTION_WORD_RE =
    /[\s,;:]+(?:by|of|in|to|for|from|with|on|at|about|as|into|over|after|before|against|between|during|under|within|without|upon|onto|the|a|an|and|but|or|nor)$/i;
  while (TRAILING_FUNCTION_WORD_RE.test(out)) {
    out = out.replace(TRAILING_FUNCTION_WORD_RE, "").trim();
  }
  out = out.replace(/[\s,;:.!?]+$/, "");
  return out ? `${out}…` : clean.slice(0, maxLength);
}

/**
 * Brand-free, abbreviation-safe <title> for an /events/{month}/{day}/ page.
 * Uses extractFirstSentence (never a naive ".split('.')[0]") so a featured
 * event whose source text begins with an abbreviation like "U.S. Senate
 * passes…" is not collapsed to "U.S". The seo worker escapes the result at
 * render time, and Google appends the site name automatically, so no
 * "| thisDay.info" suffix is included here.
 */
export function buildEventsDateTitle({ mDisplay, day, featured }) {
  const featuredText = featured && featured.text ? String(featured.text) : "";
  if (featuredText) {
    // Strip a single trailing sentence terminator so the headline does not end
    // with a stray period; internal abbreviation periods (U.S.) are preserved.
    const headline = extractFirstSentence(featuredText).replace(/[.!?]+$/, "");
    return `What Happened on ${mDisplay} ${day}: ${headline}`;
  }
  return `What Happened on ${mDisplay} ${day} in History`;
}
