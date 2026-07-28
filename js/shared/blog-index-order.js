const BLOG_MONTH_INDEX = new Map(
  [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ].map((month, index) => [month, index]),
);

function validDateTime(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function blogPostSlugDateTime(slug) {
  const match = String(slug || "")
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})-([a-z]+)-(\d{4})$/);
  if (!match) return null;
  const day = Number.parseInt(match[1], 10);
  const month = BLOG_MONTH_INDEX.get(match[2]);
  const year = Number.parseInt(match[3], 10);
  if (!Number.isInteger(day) || month == null || !Number.isInteger(year)) {
    return null;
  }
  const time = Date.UTC(year, month, day);
  const parsed = new Date(time);
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month &&
    parsed.getUTCDate() === day
    ? time
    : null;
}

export function blogPostPublicationTime(post) {
  // Daily article slugs are the canonical publication date and remain correct
  // when an older article is repaired or reinserted into the KV index later.
  const slugTime = blogPostSlugDateTime(post?.slug);
  if (slugTime != null) return slugTime;
  return validDateTime(post?.publishedAt) ?? validDateTime(post?.date) ?? 0;
}

export function sortBlogIndexNewestFirst(posts) {
  if (!Array.isArray(posts)) return [];
  return posts
    .map((post, index) => ({
      post,
      index,
      publicationTime: blogPostPublicationTime(post),
      preciseTime: validDateTime(post?.publishedAt) ?? 0,
    }))
    .sort(
      (left, right) =>
        right.publicationTime - left.publicationTime ||
        right.preciseTime - left.preciseTime ||
        left.index - right.index,
    )
    .map(({ post }) => post);
}
