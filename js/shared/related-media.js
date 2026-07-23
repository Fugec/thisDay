const RELATED_MEDIA_CACHE_TTL_SECONDS = 30 * 86_400;
const MAX_RELATED_FILMS = 5;
const MAX_RELATED_BOOKS = 5;
const MAX_PERSON_FILMS = 6;
const RELATED_MEDIA_FETCH_TIMEOUT_MS = 6_000;

const RELATED_BOOK_STOPWORDS = new Set([
  "about", "after", "article", "before", "biography", "book", "books",
  "event", "first", "from", "history", "into", "launches", "person",
  "related", "second", "story", "that", "their", "this", "through",
  "united", "were", "with", "world",
]);

export function normalizeWikidataEntityId(value) {
  const match = String(value || "").trim().match(/(?:^|\/)(Q[1-9]\d*)$/i);
  return match ? match[1].toUpperCase() : "";
}

export function normalizeRelatedFilm(candidate) {
  const title = String(
    candidate?.title ||
      candidate?.workLabel?.value ||
      "",
  )
    .replace(/\s+/g, " ")
    .trim();
  const imdbId = String(
    candidate?.imdbId ||
      candidate?.imdb?.value ||
      "",
  ).trim();
  const wikidataEntityId = normalizeWikidataEntityId(
    candidate?.wikidataEntityId ||
      candidate?.work?.value ||
      "",
  );
  if (
    !title ||
    title.length > 160 ||
    /^Q[1-9]\d*$/i.test(title) ||
    !/^tt\d{5,12}$/.test(imdbId) ||
    !wikidataEntityId
  ) {
    return null;
  }

  const rawDate = String(
    candidate?.releaseDate ||
      candidate?.date?.value ||
      candidate?.year ||
      "",
  ).trim();
  const yearMatch = rawDate.match(/\b(18|19|20)\d{2}\b/);
  const sitelinks = Number(
    candidate?.sitelinks?.value ??
      candidate?.sitelinks ??
      0,
  );
  return {
    title,
    ...(yearMatch ? { year: Number(yearMatch[0]) } : {}),
    imdbId,
    wikidataEntityId,
    sitelinks: Number.isFinite(sitelinks) && sitelinks > 0
      ? Math.floor(sitelinks)
      : 0,
  };
}

export function normalizeRelatedFilms(candidates, limit = MAX_RELATED_FILMS) {
  const seen = new Set();
  return (Array.isArray(candidates) ? candidates : [])
    .map(normalizeRelatedFilm)
    .filter(Boolean)
    .filter((film) => {
      if (seen.has(film.imdbId)) return false;
      seen.add(film.imdbId);
      return true;
    })
    .sort(
      (a, b) =>
        b.sitelinks - a.sitelinks ||
        (b.year || 0) - (a.year || 0) ||
        a.title.localeCompare(b.title),
    )
    .slice(0, Math.max(1, Math.min(Number(limit) || MAX_RELATED_FILMS, 10)));
}

function relatedMediaFetchSignal() {
  return typeof AbortSignal !== "undefined" &&
      typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(RELATED_MEDIA_FETCH_TIMEOUT_MS)
    : undefined;
}

export function relevantRelatedFilms(content) {
  const subjectId = normalizeWikidataEntityId(
    content?.relatedMoviesSubjectQid,
  );
  if (!subjectId) return [];
  return normalizeRelatedFilms(content?.relatedMovies, MAX_RELATED_FILMS);
}

export async function fetchWikidataRelatedFilms(
  subjectEntityId,
  { fetchImpl = fetch } = {},
) {
  const subjectId = normalizeWikidataEntityId(subjectEntityId);
  if (!subjectId) return [];

  const query = `
SELECT DISTINCT ?work ?workLabel ?imdb ?date ?sitelinks WHERE {
  VALUES ?subject { wd:${subjectId} }
  ?work wdt:P921 ?subject;
        wdt:P345 ?imdb;
        wdt:P31/wdt:P279* wd:Q11424.
  OPTIONAL { ?work wdt:P577 ?date. }
  OPTIONAL { ?work wikibase:sitelinks ?sitelinks. }
  FILTER(REGEX(STR(?imdb), "^tt[0-9]+$"))
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY DESC(?sitelinks) DESC(?date)
LIMIT 20`;
  const endpoint = new URL("https://query.wikidata.org/sparql");
  endpoint.searchParams.set("query", query);
  endpoint.searchParams.set("format", "json");
  const response = await fetchImpl(endpoint.toString(), {
    headers: {
      Accept: "application/sparql-results+json",
      "User-Agent":
        "thisDay.info related-films/1.0 (https://thisday.info/contact/)",
    },
    signal: relatedMediaFetchSignal(),
  });
  if (!response?.ok) {
    throw new Error(
      `Wikidata related-film query failed (${response?.status || "unknown"})`,
    );
  }
  const data = await response.json();
  return normalizeRelatedFilms(data?.results?.bindings, MAX_RELATED_FILMS);
}

export function normalizePersonFilmography(
  candidates,
  limit = MAX_PERSON_FILMS,
) {
  const filmsByImdbId = new Map();
  let personImdbId = "";
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const candidatePersonImdbId = String(
      candidate?.personImdbId ||
        candidate?.personImdb?.value ||
        "",
    ).trim();
    if (/^nm\d{5,12}$/.test(candidatePersonImdbId)) {
      personImdbId ||= candidatePersonImdbId;
    }
    const film = normalizeRelatedFilm(candidate);
    if (!film) continue;
    const existing = filmsByImdbId.get(film.imdbId);
    if (!existing) {
      filmsByImdbId.set(film.imdbId, film);
      continue;
    }
    filmsByImdbId.set(film.imdbId, {
      ...existing,
      sitelinks: Math.max(existing.sitelinks || 0, film.sitelinks || 0),
      ...(
        existing.year && film.year
          ? { year: Math.min(existing.year, film.year) }
          : film.year
            ? { year: film.year }
            : {}
      ),
    });
  }
  const films = [...filmsByImdbId.values()]
    .sort(
      (a, b) =>
        b.sitelinks - a.sitelinks ||
        (b.year || 0) - (a.year || 0) ||
        a.title.localeCompare(b.title),
    )
    .slice(0, Math.max(1, Math.min(Number(limit) || MAX_PERSON_FILMS, 10)));
  return {
    ...(personImdbId ? { personImdbId } : {}),
    films,
  };
}

export async function fetchWikidataPersonFilmography(
  personEntityId,
  { fetchImpl = fetch } = {},
) {
  const personId = normalizeWikidataEntityId(personEntityId);
  if (!personId) return { films: [] };

  const query = `
SELECT DISTINCT ?work ?workLabel ?imdb ?date ?sitelinks ?personImdb WHERE {
  VALUES ?person { wd:${personId} }
  OPTIONAL { ?person wdt:P345 ?personImdb. }
  ?work wdt:P161 ?person;
        wdt:P345 ?imdb;
        wdt:P31/wdt:P279* wd:Q11424.
  OPTIONAL { ?work wdt:P577 ?date. }
  OPTIONAL { ?work wikibase:sitelinks ?sitelinks. }
  FILTER(REGEX(STR(?imdb), "^tt[0-9]+$"))
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY DESC(?sitelinks) DESC(?date)
LIMIT 80`;
  const endpoint = new URL("https://query.wikidata.org/sparql");
  endpoint.searchParams.set("query", query);
  endpoint.searchParams.set("format", "json");
  const response = await fetchImpl(endpoint.toString(), {
    headers: {
      Accept: "application/sparql-results+json",
      "User-Agent":
        "thisDay.info person-filmography/1.0 (https://thisday.info/contact/)",
    },
    signal: relatedMediaFetchSignal(),
  });
  if (!response?.ok) {
    throw new Error(
      `Wikidata person-filmography query failed (${response?.status || "unknown"})`,
    );
  }
  const data = await response.json();
  return normalizePersonFilmography(
    data?.results?.bindings,
    MAX_PERSON_FILMS,
  );
}

function cacheRequest(kind, key) {
  return new Request(
    `https://thisday.info/__related-media-cache/${kind}/${encodeURIComponent(key)}.json`,
  );
}

async function readCachedJson(cache, request) {
  if (!cache?.match) return null;
  const response = await cache.match(request).catch(() => null);
  if (!response?.ok) return null;
  return response.json().catch(() => null);
}

async function writeCachedJson(cache, request, value, ttlSeconds) {
  if (!cache?.put) return;
  await cache.put(
    request,
    new Response(JSON.stringify(value), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${ttlSeconds}`,
      },
    }),
  ).catch(() => {});
}

export async function fetchCachedWikidataRelatedFilms(
  subjectEntityId,
  {
    fetchImpl = fetch,
    cache = globalThis.caches?.default,
    ttlSeconds = RELATED_MEDIA_CACHE_TTL_SECONDS,
  } = {},
) {
  const subjectId = normalizeWikidataEntityId(subjectEntityId);
  if (!subjectId) return [];
  const request = cacheRequest("films", subjectId);
  const cached = await readCachedJson(cache, request);
  if (Array.isArray(cached)) return normalizeRelatedFilms(cached);
  const films = await fetchWikidataRelatedFilms(subjectId, { fetchImpl });
  await writeCachedJson(cache, request, films, ttlSeconds);
  return films;
}

export async function fetchCachedWikidataPersonFilmography(
  personEntityId,
  {
    fetchImpl = fetch,
    cache = globalThis.caches?.default,
    ttlSeconds = RELATED_MEDIA_CACHE_TTL_SECONDS,
  } = {},
) {
  const personId = normalizeWikidataEntityId(personEntityId);
  if (!personId) return { films: [] };
  const request = cacheRequest("person-filmography", personId);
  const cached = await readCachedJson(cache, request);
  if (cached && typeof cached === "object") {
    return normalizePersonFilmography(
      (Array.isArray(cached.films) ? cached.films : []).map((film) => ({
        ...film,
        personImdbId: cached.personImdbId,
      })),
      MAX_PERSON_FILMS,
    );
  }
  const filmography = await fetchWikidataPersonFilmography(personId, {
    fetchImpl,
  });
  await writeCachedJson(cache, request, filmography, ttlSeconds);
  return filmography;
}

function wikipediaPageTitle(value) {
  const source = String(value || "").trim();
  if (!source) return "";
  try {
    const url = new URL(source);
    if (
      url.hostname === "en.wikipedia.org" &&
      url.pathname.startsWith("/wiki/")
    ) {
      return decodeURIComponent(url.pathname.slice(6)).replace(/_/g, " ");
    }
  } catch {}
  return source.replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

export async function fetchCachedWikipediaWikidataId(
  wikipediaTitleOrUrl,
  {
    fetchImpl = fetch,
    cache = globalThis.caches?.default,
    ttlSeconds = RELATED_MEDIA_CACHE_TTL_SECONDS,
  } = {},
) {
  const title = wikipediaPageTitle(wikipediaTitleOrUrl);
  if (!title || title.length > 180) return "";
  const request = cacheRequest(
    "wikipedia-wikidata-id",
    title.toLowerCase(),
  );
  const cached = await readCachedJson(cache, request);
  if (cached && typeof cached === "object" && "wikidataEntityId" in cached) {
    return normalizeWikidataEntityId(cached.wikidataEntityId);
  }

  const endpoint = new URL("https://en.wikipedia.org/w/api.php");
  endpoint.searchParams.set("action", "query");
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("formatversion", "2");
  endpoint.searchParams.set("redirects", "1");
  endpoint.searchParams.set("prop", "pageprops");
  endpoint.searchParams.set("ppprop", "wikibase_item");
  endpoint.searchParams.set("titles", title);
  endpoint.searchParams.set("origin", "*");
  const response = await fetchImpl(endpoint.toString(), {
    headers: {
      Accept: "application/json",
      "User-Agent":
        "thisDay.info person-filmography/1.0 (https://thisday.info/contact/)",
    },
    signal: relatedMediaFetchSignal(),
  });
  if (!response?.ok) {
    throw new Error(
      `Wikipedia Wikidata identity lookup failed (${response?.status || "unknown"})`,
    );
  }
  const data = await response.json();
  const wikidataEntityId = normalizeWikidataEntityId(
    data?.query?.pages?.find((page) => !page?.missing)?.pageprops
      ?.wikibase_item,
  );
  await writeCachedJson(
    cache,
    request,
    { wikidataEntityId },
    ttlSeconds,
  );
  return wikidataEntityId;
}

function relatedBookTokens(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(
      (token) =>
        token.length >= 4 &&
        !/^\d+$/.test(token) &&
        !RELATED_BOOK_STOPWORDS.has(token),
    );
}

function normalizeRelatedBook(doc) {
  const title = String(doc?.title || "").replace(/\s+/g, " ").trim();
  const author = Array.isArray(doc?.author_name)
    ? String(doc.author_name[0] || "").replace(/\s+/g, " ").trim()
    : String(doc?.author || "").replace(/\s+/g, " ").trim();
  if (!title || title.length > 180) return null;
  const coverId = Number.parseInt(String(doc?.cover_i || ""), 10);
  const storedCoverUrl = /^https:\/\/covers\.openlibrary\.org\/b\/id\/\d+-M\.jpg$/i.test(
    String(doc?.coverUrl || ""),
  )
    ? String(doc.coverUrl)
    : "";
  const year = Number.parseInt(
    String(doc?.first_publish_year || doc?.firstPublishYear || ""),
    10,
  );
  return {
    title,
    ...(author ? { author } : {}),
    ...(storedCoverUrl
      ? { coverUrl: storedCoverUrl }
      : Number.isFinite(coverId) && coverId > 0
      ? {
          coverUrl:
            `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`,
        }
      : {}),
    ...(Number.isFinite(year) && year >= 1400 && year <= 2100
      ? { firstPublishYear: year }
      : {}),
    subjects: Array.isArray(doc?.subject)
      ? doc.subject.slice(0, 8).map((subject) => String(subject))
      : Array.isArray(doc?.subjects)
        ? doc.subjects.slice(0, 8).map((subject) => String(subject))
        : [],
  };
}

export function relevantRelatedBooks(candidates, topic, limit = MAX_RELATED_BOOKS) {
  const topicTokens = new Set(relatedBookTokens(topic));
  if (!topicTokens.size) return [];
  const seen = new Set();
  return (Array.isArray(candidates) ? candidates : [])
    .map(normalizeRelatedBook)
    .filter(Boolean)
    .filter((book) => {
      const hayTokens = new Set(
        relatedBookTokens(
          `${book.title} ${book.author || ""} ${(book.subjects || []).join(" ")}`,
        ),
      );
      const matches = [...topicTokens].filter((token) => hayTokens.has(token));
      if (
        matches.length < 2 &&
        !matches.some((token) => token.length >= 6)
      ) {
        return false;
      }
      const key = book.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(1, Math.min(Number(limit) || MAX_RELATED_BOOKS, 10)));
}

export async function fetchCachedOpenLibraryRelatedBooks(
  topic,
  {
    fetchImpl = fetch,
    cache = globalThis.caches?.default,
    ttlSeconds = RELATED_MEDIA_CACHE_TTL_SECONDS,
  } = {},
) {
  const cleanTopic = String(topic || "").replace(/\s+/g, " ").trim();
  if (!cleanTopic || !relatedBookTokens(cleanTopic).length) return [];
  const cacheKey = cleanTopic.toLowerCase().slice(0, 160);
  const request = cacheRequest("books", cacheKey);
  const cached = await readCachedJson(cache, request);
  if (Array.isArray(cached)) {
    return relevantRelatedBooks(cached, cleanTopic);
  }

  const response = await fetchImpl(
    `https://openlibrary.org/search.json?q=${encodeURIComponent(cleanTopic)}&mode=books&limit=12&fields=title,author_name,cover_i,first_publish_year,subject`,
    {
      headers: {
        "User-Agent": "thisDay.info related-books/1.0 (https://thisday.info)",
      },
      signal: relatedMediaFetchSignal(),
    },
  );
  if (!response?.ok) {
    throw new Error(
      `Open Library related-book query failed (${response?.status || "unknown"})`,
    );
  }
  const data = await response.json();
  const books = relevantRelatedBooks(data?.docs, cleanTopic);
  await writeCachedJson(cache, request, books, ttlSeconds);
  return books;
}
