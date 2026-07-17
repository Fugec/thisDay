/**
 * Title contract for the video pipeline.
 *
 * Index entries carry three title fields with distinct jobs:
 * - post.title         → article headline (a curiosity question since July 2026)
 * - post.factualTitle  → dated factual headline ("Spanish Civil War Begins — July 17, 1936")
 * - post.eventTitle    → bare event name, best for topic/image/narration matching
 *
 * The video heading and YouTube metadata must always show the dated factual
 * headline, never the curiosity question. Legacy index entries predate
 * factualTitle, so every consumer falls back to post.title.
 */

export function videoHeadlineTitle(post) {
  return String(post?.factualTitle || post?.title || "").trim();
}

export function videoMatchTitle(post) {
  return String(
    post?.eventTitle || post?.factualTitle || post?.title || "",
  ).trim();
}

export function buildVideoTitle(post) {
  const rawTitle = videoHeadlineTitle(post).replace(/ [—–] /g, ": ");
  return rawTitle.length > 97 ? rawTitle.slice(0, 94) + "..." : rawTitle;
}
