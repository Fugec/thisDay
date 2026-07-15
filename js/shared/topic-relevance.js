// Deterministic topic evidence shared by the blog and SEO workers. Narrow
// topic hubs must never inherit articles from broad editorial pillars alone.

export const EVIDENCE_TOPIC_HUBS = [
  {
    slug: "world-war-ii",
    title: "World War II",
    summary:
      "A topic hub for battles, invasions, political decisions, and turning points tied to the Second World War.",
    explicitPhrases: [
      "world war ii",
      "second world war",
      "wwii",
      "ww2",
      "operation overlord",
      "d day",
      "pearl harbor",
      "battle of stalingrad",
      "the holocaust",
    ],
    anchors: ["nazi germany", "axis powers", "allied powers", "third reich"],
    keywords: [
      "nazi",
      "hitler",
      "allied",
      "allies",
      "axis",
      "germany",
      "poland",
      "normandy",
      "stalingrad",
      "wehrmacht",
      "luftwaffe",
      "blitzkrieg",
      "holocaust",
    ],
    yearRange: [1933, 1945],
    minimumKeywordMatches: 2,
    pillars: ["War & Conflict", "Politics & Government"],
  },
  {
    slug: "cold-war",
    title: "Cold War",
    summary:
      "Articles about nuclear brinkmanship, proxy conflicts, espionage, and the rivalry that shaped the late twentieth century.",
    explicitPhrases: [
      "cold war",
      "berlin wall",
      "cuban missile crisis",
      "warsaw pact",
      "iron curtain",
      "glassboro summit",
    ],
    anchors: ["soviet union", "nato", "arms race", "east germany", "west germany"],
    keywords: [
      "soviet",
      "communist",
      "nuclear",
      "superpower",
      "espionage",
      "proxy war",
      "kremlin",
      "detente",
    ],
    yearRange: [1945, 1991],
    minimumKeywordMatches: 2,
    pillars: ["Politics & Government", "War & Conflict"],
  },
  {
    slug: "french-revolution",
    title: "French Revolution",
    summary:
      "A hub for uprisings, leaders, and political shocks directly connected to the French Revolution.",
    explicitPhrases: [
      "french revolution",
      "reign of terror",
      "storming of the bastille",
      "committee of public safety",
    ],
    anchors: ["robespierre", "bastille", "jacobin", "sans culottes", "national convention"],
    keywords: [
      "revolutionary france",
      "louis xvi",
      "marie antoinette",
      "directory",
      "guillotine",
      "bourbon",
    ],
    yearRange: [1789, 1799],
    minimumKeywordMatches: 2,
    pillars: ["Politics & Government", "War & Conflict"],
  },
  {
    slug: "roman-empire",
    title: "Roman Empire",
    summary:
      "A hub for emperors, conquests, collapses, and political dramas from the Roman world.",
    explicitPhrases: ["roman empire", "western roman empire", "eastern roman empire"],
    anchors: ["roman emperor", "emperor of rome", "roman legion", "pax romana", "fall of rome"],
    keywords: ["rome", "roman", "augustus", "caesar", "constantinople", "byzantine"],
    yearRange: [1, 1453],
    minimumKeywordMatches: 2,
    pillars: ["Politics & Government", "War & Conflict"],
  },
  {
    slug: "space-exploration",
    title: "Space Exploration",
    summary:
      "Launches, missions, disasters, discoveries, and the people who pushed human exploration beyond Earth.",
    explicitPhrases: [
      "space exploration",
      "space race",
      "moon landing",
      "apollo program",
      "human spaceflight",
      "international space station",
    ],
    anchors: ["nasa mission", "apollo mission", "crewed spaceflight"],
    keywords: ["nasa", "apollo", "astronaut", "spacecraft", "satellite", "rocket", "orbit", "lunar", "mars"],
    yearRange: [1957, 2200],
    minimumKeywordMatches: 2,
    pillars: ["Science & Technology", "Exploration & Discovery"],
  },
  {
    slug: "civil-rights",
    title: "Civil Rights",
    summary:
      "A topic hub for protests, landmark rulings, reform movements, and the people who fought for equal rights.",
    explicitPhrases: ["civil rights", "civil rights movement"],
    anchors: [
      "segregation",
      "desegregation",
      "suffrage",
      "voting rights",
      "freedom riders",
      "human rights",
      "abolition",
    ],
    keywords: ["equality", "boycott", "emancipation", "jim crow"],
    minimumKeywordMatches: 2,
    pillars: ["Social & Human Rights", "Politics & Government"],
  },
  {
    slug: "medical-breakthroughs",
    title: "Medical Breakthroughs",
    summary:
      "Discoveries, vaccines, surgeries, and public health turning points that changed how people lived and survived.",
    explicitPhrases: ["medical breakthrough", "public health"],
    anchors: ["vaccine", "vaccination", "penicillin", "surgery", "epidemic", "pandemic"],
    keywords: ["medicine", "medical", "hospital", "disease", "treatment", "physician"],
    minimumKeywordMatches: 2,
    pillars: ["Health & Medicine", "Science & Technology"],
  },
  {
    slug: "exploration-and-discovery",
    title: "Exploration and Discovery",
    summary:
      "Voyages, expeditions, maps, and discoveries that expanded what people thought the world could be.",
    explicitPhrases: ["exploration and discovery", "age of discovery", "age of exploration"],
    anchors: ["expedition", "voyage", "explorer", "navigator", "polar exploration", "circumnavigation"],
    keywords: ["discovery", "atlantic", "pacific", "cartography", "charted"],
    minimumKeywordMatches: 2,
    pillars: ["Exploration & Discovery", "Science & Technology"],
  },
];

const RELATED_TOPIC_STOP_WORDS = new Set([
  "about", "after", "again", "against", "article", "before", "began", "begin", "begins",
  "between", "during", "event", "events", "first", "from", "government", "historic", "historical",
  "history", "into", "killed", "kills", "last", "later", "major", "more", "most", "near", "over",
  "people", "president", "same", "than", "that", "their", "them", "then", "there", "these", "they",
  "this", "through", "today", "under", "upon", "were", "when", "where", "which", "while", "with",
  "world", "would", "year", "years", "war",
]);

export function normalizeTopicEvidenceText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsTopicPhrase(normalizedHaystack, value) {
  const phrase = normalizeTopicEvidenceText(value);
  return Boolean(phrase && ` ${normalizedHaystack} `.includes(` ${phrase} `));
}

function contentEvidenceStrings(content) {
  if (typeof content === "string") return [content];
  const keyTerms = Array.isArray(content?.keyTerms)
    ? content.keyTerms.map((term) => term?.term || "")
    : [];
  const quickFacts = Array.isArray(content?.quickFacts)
    ? content.quickFacts.map((fact) => `${fact?.label || ""} ${fact?.value || ""}`)
    : [];
  const sourcePages = Array.isArray(content?.sourcePages)
    ? content.sourcePages.flatMap((page) => [
        page?.pageTitle || "",
        page?.extract || "",
        ...(Array.isArray(page?.supportedClaims) ? page.supportedClaims : []),
      ])
    : [];
  return [
    content?.title,
    content?.eventTitle,
    content?.sourceEventHeadline,
    content?.sourcePageTitle,
    content?.description,
    content?.keywords,
    content?.contentRationale,
    ...keyTerms,
    ...quickFacts,
    ...sourcePages,
  ].filter(Boolean);
}

function historicalYearFromContent(content) {
  if (!content || typeof content === "string") return null;
  const direct = Number.parseInt(content.historicalYear, 10);
  if (Number.isInteger(direct)) return direct;
  for (const value of [content.historicalDateISO, content.historicalDate]) {
    const match = String(value || "").match(/(?:^|\D)(\d{3,4})(?:\D|$)/);
    if (match) return Number.parseInt(match[1], 10);
  }
  return null;
}

export function topicHubEvidenceForContent(content, hub) {
  if (!hub) return { eligible: false, score: 0, year: null, matches: [] };
  const haystack = normalizeTopicEvidenceText(contentEvidenceStrings(content).join(" "));
  if (!haystack) return { eligible: false, score: 0, year: null, matches: [] };

  const explicitMatches = (hub.explicitPhrases || []).filter((term) =>
    containsTopicPhrase(haystack, term),
  );
  const anchorMatches = (hub.anchors || []).filter((term) =>
    containsTopicPhrase(haystack, term),
  );
  const keywordMatches = (hub.keywords || []).filter((term) =>
    containsTopicPhrase(haystack, term),
  );
  const year = historicalYearFromContent(content);
  const hasYearRange = Array.isArray(hub.yearRange) && hub.yearRange.length === 2;
  const yearMatches =
    !hasYearRange ||
    (Number.isInteger(year) && year >= hub.yearRange[0] && year <= hub.yearRange[1]);
  const minimumKeywordMatches = Math.max(2, Number(hub.minimumKeywordMatches) || 2);
  const eligible =
    explicitMatches.length > 0 ||
    (yearMatches && anchorMatches.length > 0) ||
    (yearMatches && keywordMatches.length >= minimumKeywordMatches);
  const score = eligible
    ? explicitMatches.length * 20 +
      anchorMatches.length * 8 +
      keywordMatches.length * 3 +
      (hasYearRange && yearMatches ? 1 : 0)
    : 0;

  return {
    eligible,
    score,
    year,
    matches: [...new Set([...explicitMatches, ...anchorMatches, ...keywordMatches])],
  };
}

export function getEvidenceBasedTopicHubBySlug(slug) {
  return EVIDENCE_TOPIC_HUBS.find((hub) => hub.slug === slug) || null;
}

export function getEvidenceBasedTopicHubMatches(content, limit = 3) {
  return EVIDENCE_TOPIC_HUBS.map((hub) => ({
    hub,
    evidence: topicHubEvidenceForContent(content, hub),
  }))
    .filter((entry) => entry.evidence.eligible)
    .sort((a, b) => b.evidence.score - a.evidence.score)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.hub);
}

export function scoreContentForTopicHub(content, hub) {
  return topicHubEvidenceForContent(content, hub).score;
}

function strongTopicTerms(content) {
  if (!content || typeof content === "string" || !Array.isArray(content.keyTerms)) return new Set();
  return new Set(
    content.keyTerms
      .filter((term) => term?.type !== "place")
      .map((term) => normalizeTopicEvidenceText(term?.term))
      .filter((term) => term.length >= 5),
  );
}

function topicalTokens(content) {
  const values = typeof content === "string"
    ? [content]
    : [
        content?.title,
        content?.eventTitle,
        content?.sourcePageTitle,
        content?.description,
        content?.keywords,
        ...(Array.isArray(content?.keyTerms) ? content.keyTerms.map((term) => term?.term || "") : []),
      ];
  return new Set(
    normalizeTopicEvidenceText(values.filter(Boolean).join(" "))
      .split(" ")
      .filter((token) => token.length >= 4 && !RELATED_TOPIC_STOP_WORDS.has(token) && !/^\d+$/.test(token)),
  );
}

function setIntersection(left, right) {
  return [...left].filter((value) => right.has(value));
}

export function topicalRelationshipEvidence(currentContent, candidateContent) {
  const currentHubs = new Set(getEvidenceBasedTopicHubMatches(currentContent, EVIDENCE_TOPIC_HUBS.length).map((hub) => hub.slug));
  const candidateHubs = new Set(getEvidenceBasedTopicHubMatches(candidateContent, EVIDENCE_TOPIC_HUBS.length).map((hub) => hub.slug));
  const sharedHubs = setIntersection(currentHubs, candidateHubs);
  const sharedTerms = setIntersection(strongTopicTerms(currentContent), strongTopicTerms(candidateContent));
  const sharedTokens = setIntersection(topicalTokens(currentContent), topicalTokens(candidateContent));
  const eligible = sharedHubs.length > 0 || sharedTerms.length > 0 || sharedTokens.length >= 2;
  return { eligible, sharedHubs, sharedTerms, sharedTokens };
}

export function selectTopicallyRelatedPosts(
  currentContent,
  posts,
  currentSlug = "",
  currentPillars = [],
  limit = 3,
) {
  const safePosts = Array.isArray(posts) ? posts : [];
  return safePosts
    .filter((post) => post?.slug && post.slug !== currentSlug)
    .map((post) => {
      const evidence = topicalRelationshipEvidence(currentContent, post);
      const pillarOverlap = Array.isArray(post.pillars)
        ? post.pillars.filter((pillar) => currentPillars.includes(pillar)).length
        : 0;
      return {
        post,
        evidence,
        score:
          evidence.sharedHubs.length * 20 +
          evidence.sharedTerms.length * 12 +
          Math.min(evidence.sharedTokens.length, 8) * 2 +
          pillarOverlap * 0.25,
      };
    })
    .filter((entry) => entry.evidence.eligible)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.post?.publishedAt || 0) - new Date(a.post?.publishedAt || 0);
    })
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.post);
}
