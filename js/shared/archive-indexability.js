import {
  EVIDENCE_TOPIC_HUBS,
  scoreContentForTopicHub,
} from "./topic-relevance.js";

export const ARCHIVE_MIN_INDEXABLE_ARTICLES = 5;
export const ARCHIVE_MIN_INDEXABLE_CHILDREN = 3;
export const ARCHIVE_MIN_DESCRIPTION_CHARS = 50;

export function archiveSlugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function pillarArchiveSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function archiveArticleIsUsable(post) {
  const slug = String(post?.slug || "").trim();
  const title = String(post?.title || "").replace(/\s+/g, " ").trim();
  const description = String(post?.description || "")
    .replace(/\s+/g, " ")
    .trim();
  const publishedAt = Date.parse(String(post?.publishedAt || ""));

  return Boolean(
    /^[a-z0-9][a-z0-9-]*$/.test(slug) &&
      title.length >= 20 &&
      description.length >= ARCHIVE_MIN_DESCRIPTION_CHARS &&
      Number.isFinite(publishedAt) &&
      post?.indexable !== false &&
      post?.noindex !== true,
  );
}

export function dedupeArchivePosts(posts, { usableOnly = false } = {}) {
  const deduped = [];
  const seen = new Set();
  for (const post of Array.isArray(posts) ? posts : []) {
    const slug = String(post?.slug || "").trim();
    if (!slug || seen.has(slug)) continue;
    if (usableOnly && !archiveArticleIsUsable(post)) continue;
    seen.add(slug);
    deduped.push(post);
  }
  return deduped;
}

export function archiveUsablePosts(posts) {
  return dedupeArchivePosts(posts, { usableOnly: true });
}

export function archiveRequestIsCanonical(url) {
  if (!url || typeof url !== "object") return true;
  return !url.search || url.search === "";
}

export function archiveCollectionIsIndexable(posts, url = null) {
  return (
    archiveRequestIsCanonical(url) &&
    archiveUsablePosts(posts).length >= ARCHIVE_MIN_INDEXABLE_ARTICLES
  );
}

export function archiveRootIsIndexable(entries, url = null) {
  if (!archiveRequestIsCanonical(url)) return false;
  const qualified = (Array.isArray(entries) ? entries : []).filter((entry) =>
    archiveCollectionIsIndexable(entry?.posts),
  );
  return qualified.length >= ARCHIVE_MIN_INDEXABLE_CHILDREN;
}

export function archiveRobotsDirective(indexable) {
  return indexable
    ? "index, follow, max-image-preview:large"
    : "noindex, follow";
}

export function getArchiveHistoricalYear(post) {
  if (Number.isInteger(post?.historicalYear)) return post.historicalYear;

  const iso = String(post?.historicalDateISO || "");
  const isoMatch = iso.match(/^(-?\d{1,4})-\d{2}-\d{2}$/);
  if (isoMatch) return Number.parseInt(isoMatch[1], 10);

  const title = String(post?.title || "");
  const titleYearMatch = title.match(/,\s*(-?\d{3,4})\s*\??$/);
  if (titleYearMatch) return Number.parseInt(titleYearMatch[1], 10);

  const desc = String(post?.description || "");
  const descYearMatch = desc.match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
  if (descYearMatch) return Number.parseInt(descYearMatch[1], 10);

  return null;
}

export function getArchiveKeywordPhrases(post) {
  const phrases = [];
  const pushPhrase = (value) => {
    const label = String(value || "").replace(/\s+/g, " ").trim();
    if (!label || /^\d{4}$/.test(label)) return;
    if (label.length < 3 || label.length > 50) return;
    if (
      /^(history|historical|event|events|article|articles|this day|on this day)$/i.test(
        label,
      )
    ) {
      return;
    }
    phrases.push(label);
  };

  if (typeof post?.keywords === "string" && post.keywords.trim()) {
    for (const keyword of post.keywords.split(",")) pushPhrase(keyword);
  }
  if (Array.isArray(post?.keyTerms)) {
    for (const term of post.keyTerms) pushPhrase(term?.term || "");
  }
  if (post?.eventTitle) pushPhrase(post.eventTitle);

  const title = String(post?.title || "");
  const titleLead = title.split("—")[0].trim();
  if (titleLead && titleLead !== title) pushPhrase(titleLead);

  const deduped = [];
  const seen = new Set();
  for (const label of phrases) {
    const slug = archiveSlugify(label);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    deduped.push({ label, slug });
  }
  return deduped.slice(0, 8);
}

export function buildArchiveYearEntries(posts) {
  const map = new Map();
  for (const post of dedupeArchivePosts(posts)) {
    const year = getArchiveHistoricalYear(post);
    // Keep generated archive URLs inside the SEO Worker's supported
    // /years/{3-or-4-digit-year}/ route contract.
    if (!Number.isInteger(year) || year < 100 || year > 9999) continue;
    if (!map.has(year)) map.set(year, []);
    map.get(year).push(post);
  }

  return Array.from(map.entries())
    .map(([year, yearPosts]) => ({
      year,
      posts: yearPosts.sort(
        (a, b) =>
          new Date(b?.publishedAt || 0) - new Date(a?.publishedAt || 0),
      ),
    }))
    .sort((a, b) => b.year - a.year);
}

export function buildArchiveKeywordEntries(posts) {
  const map = new Map();
  for (const post of dedupeArchivePosts(posts)) {
    for (const keyword of getArchiveKeywordPhrases(post)) {
      if (!map.has(keyword.slug)) {
        map.set(keyword.slug, {
          slug: keyword.slug,
          label: keyword.label,
          posts: [],
        });
      }
      map.get(keyword.slug).posts.push(post);
    }
  }

  return Array.from(map.values())
    .map((entry) => ({
      ...entry,
      posts: dedupeArchivePosts(entry.posts).sort(
        (a, b) =>
          new Date(b?.publishedAt || 0) - new Date(a?.publishedAt || 0),
      ),
    }))
    .filter((entry) => entry.posts.length > 0)
    .sort((a, b) => {
      if (b.posts.length !== a.posts.length) {
        return b.posts.length - a.posts.length;
      }
      return a.label.localeCompare(b.label);
    });
}

export function getArchivePostsForTopicHub(posts, hub, limit = 12) {
  return dedupeArchivePosts(posts)
    .map((post) => ({ post, score: scoreContentForTopicHub(post, hub) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (
        new Date(b.post?.publishedAt || 0) -
        new Date(a.post?.publishedAt || 0)
      );
    })
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.post);
}

export function getArchivePostsForPillar(posts, pillar) {
  return dedupeArchivePosts(posts)
    .filter(
      (post) =>
        Array.isArray(post?.pillars) && post.pillars.includes(String(pillar)),
    )
    .sort(
      (a, b) =>
        new Date(b?.publishedAt || 0) - new Date(a?.publishedAt || 0),
    );
}

export function archiveEditorialContext(label, posts, kind = "topic") {
  const usable = archiveUsablePosts(posts);
  if (usable.length < ARCHIVE_MIN_INDEXABLE_ARTICLES) return null;

  const examples = usable.slice(0, 3);
  const names = examples.map((post) =>
    String(post?.title || post?.slug || "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  const lead =
    kind === "year"
      ? `This year archive connects separate events recorded in ${label}, allowing readers to compare what changed across different places and subjects.`
      : kind === "keyword"
        ? `This keyword archive groups independently published articles that share the subject “${label}”, making recurring people, institutions, and consequences easier to compare.`
        : kind === "pillar"
          ? `This editorial collection follows ${label} across distinct historical events instead of treating the category as a single undifferentiated timeline.`
          : `This focused hub traces ${label} through articles with direct subject evidence, helping readers follow causes, turning points, and consequences across the collection.`;

  const route =
    names.length >= 3
      ? `A useful reading path starts with “${names[0]}”, continues with “${names[1]}”, and then compares “${names[2]}”.`
      : "";

  return {
    lead,
    route,
    examples,
  };
}

export function qualifiedArchivePaths(posts, pillars = []) {
  const paths = [];

  const topicEntries = EVIDENCE_TOPIC_HUBS.map((hub) => ({
    hub,
    posts: getArchivePostsForTopicHub(posts, hub, Number.MAX_SAFE_INTEGER),
  }));
  const qualifiedTopics = topicEntries.filter((entry) =>
    archiveCollectionIsIndexable(entry.posts),
  );
  if (qualifiedTopics.length >= ARCHIVE_MIN_INDEXABLE_CHILDREN) {
    paths.push("/topics/");
  }
  for (const entry of qualifiedTopics) {
    paths.push(`/topics/${entry.hub.slug}/`);
  }

  const qualifiedYears = buildArchiveYearEntries(posts).filter((entry) =>
    archiveCollectionIsIndexable(entry.posts),
  );
  if (qualifiedYears.length >= ARCHIVE_MIN_INDEXABLE_CHILDREN) {
    paths.push("/years/");
  }
  for (const entry of qualifiedYears) {
    paths.push(`/years/${entry.year}/`);
  }

  const qualifiedKeywords = buildArchiveKeywordEntries(posts).filter((entry) =>
    archiveCollectionIsIndexable(entry.posts),
  );
  if (qualifiedKeywords.length >= ARCHIVE_MIN_INDEXABLE_CHILDREN) {
    paths.push("/keywords/");
  }
  for (const entry of qualifiedKeywords) {
    paths.push(`/keywords/${entry.slug}/`);
  }

  for (const pillar of Array.isArray(pillars) ? pillars : []) {
    const pillarPosts = getArchivePostsForPillar(posts, pillar);
    if (!archiveCollectionIsIndexable(pillarPosts)) continue;
    paths.push(`/blog/topic/${pillarArchiveSlug(pillar)}/`);
  }

  return Array.from(new Set(paths)).sort();
}
