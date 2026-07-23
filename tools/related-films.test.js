import assert from "node:assert/strict";
import test from "node:test";

import {
  __contentGenerationTestHooks as hooks,
} from "../js/blog-ai-worker.js";
import {
  __historyEvergreenTestHooks as historyHooks,
} from "../js/seo-worker.js";
import {
  fetchCachedOpenLibraryRelatedBooks,
} from "../js/shared/related-media.js";

function wikidataResponse(bindings) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        results: {
          bindings,
        },
      };
    },
  };
}

function filmBinding({
  qid,
  title,
  imdb,
  date = "",
  sitelinks = 0,
}) {
  return {
    work: { value: `http://www.wikidata.org/entity/${qid}` },
    workLabel: { value: title },
    imdb: { value: imdb },
    ...(date ? { date: { value: date } } : {}),
    sitelinks: { value: String(sitelinks) },
  };
}

test("related-film lookup uses one exact-subject Wikidata query and keeps only verified IMDb titles", async () => {
  const calls = [];
  const films = await hooks.fetchWikidataRelatedFilms("Q43653", {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return wikidataResponse([
        filmBinding({
          qid: "Q100",
          title: "Lower-ranked film",
          imdb: "tt1234567",
          date: "2001-01-01T00:00:00Z",
          sitelinks: 12,
        }),
        filmBinding({
          qid: "Q200",
          title: "Most notable documentary",
          imdb: "tt7654321",
          date: "1999-01-01T00:00:00Z",
          sitelinks: 80,
        }),
        filmBinding({
          qid: "Q300",
          title: "Invalid external identifier",
          imdb: "nm1234567",
          sitelinks: 100,
        }),
        filmBinding({
          qid: "Q400",
          title: "Duplicate IMDb title",
          imdb: "tt7654321",
          sitelinks: 20,
        }),
      ]);
    },
  });

  assert.equal(calls.length, 1);
  const requestUrl = new URL(calls[0].url);
  const query = requestUrl.searchParams.get("query");
  assert.equal(requestUrl.origin, "https://query.wikidata.org");
  assert.match(query, /VALUES \?subject \{ wd:Q43653 \}/);
  assert.match(query, /\?work wdt:P921 \?subject/);
  assert.match(query, /wdt:P31\/wdt:P279\* wd:Q11424/);
  assert.match(calls[0].options.headers.Accept, /sparql-results\+json/);
  assert.deepEqual(
    films.map((film) => film.imdbId),
    ["tt7654321", "tt1234567"],
  );
  assert.equal(films[0].year, 1999);
});

test("invalid Wikidata identity produces no network request", async () => {
  let calls = 0;
  const films = await hooks.fetchWikidataRelatedFilms("Apollo 11", {
    fetchImpl: async () => {
      calls += 1;
      throw new Error("should not be called");
    },
  });

  assert.deepEqual(films, []);
  assert.equal(calls, 0);
});

test("post-publication hydration selects the primary article entity and backs off after a sparse result", async () => {
  const content = {
    wikiUrl: "https://en.wikipedia.org/wiki/Apollo_11",
  };
  const entities = [
    {
      type: "event",
      name: "Secondary topic",
      wikidataEntityId: "Q111",
    },
    {
      type: "event",
      name: "Apollo 11",
      wikiUrl: "https://en.wikipedia.org/wiki/Apollo_11",
      wikidataEntityId: "Q43653",
      primaryHistoryEntity: true,
    },
  ];
  let calls = 0;
  const now = Date.parse("2026-07-23T01:00:00.000Z");
  await hooks.hydrateRelatedFilmsForContent(content, entities, {
    now,
    fetchImpl: async (url) => {
      calls += 1;
      const query = new URL(url).searchParams.get("query");
      assert.match(query, /wd:Q43653/);
      return wikidataResponse([
        filmBinding({
          qid: "Q100",
          title: "Only one exact match",
          imdb: "tt1234567",
          sitelinks: 20,
        }),
      ]);
    },
  });

  assert.equal(calls, 1);
  assert.equal(content.relatedMoviesSubjectQid, "Q43653");
  assert.equal(
    content.relatedMoviesCheckedAt,
    "2026-07-23T01:00:00.000Z",
  );
  assert.equal(content.relatedMovies, undefined);

  await hooks.hydrateRelatedFilmsForContent(content, entities, {
    now: now + 86_400_000,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("backoff failed");
    },
  });
  assert.equal(calls, 1);
});

test("successful related-film results refresh only after the 30-day cache window", async () => {
  const checkedAt = Date.parse("2026-07-01T01:00:00.000Z");
  const content = {
    relatedMoviesSubjectQid: "Q43653",
    relatedMoviesCheckedAt: new Date(checkedAt).toISOString(),
    relatedMovies: [
      {
        title: "First Man",
        imdbId: "tt1213641",
        wikidataEntityId: "Q42708010",
      },
      {
        title: "Apollo 11",
        imdbId: "tt8760684",
        wikidataEntityId: "Q61639822",
      },
    ],
  };
  const entities = [{
    type: "event",
    wikidataEntityId: "Q43653",
    primaryHistoryEntity: true,
  }];
  let calls = 0;

  await hooks.hydrateRelatedFilmsForContent(content, entities, {
    now: checkedAt + 29 * 86_400_000,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("fresh cache should not query");
    },
  });
  assert.equal(calls, 0);

  await hooks.hydrateRelatedFilmsForContent(content, entities, {
    now: checkedAt + 31 * 86_400_000,
    fetchImpl: async () => {
      calls += 1;
      return wikidataResponse([
        filmBinding({
          qid: "Q42708010",
          title: "First Man",
          imdb: "tt1213641",
          sitelinks: 44,
        }),
        filmBinding({
          qid: "Q61639822",
          title: "Apollo 11",
          imdb: "tt8760684",
          sitelinks: 13,
        }),
      ]);
    },
  });
  assert.equal(calls, 1);
  assert.equal(
    content.relatedMoviesCheckedAt,
    "2026-08-01T01:00:00.000Z",
  );
});

test("related-film renderer requires two exact-topic records and exposes safe IMDb links only", () => {
  const sparse = hooks.buildRelatedFilmsBlock({
    relatedMoviesSubjectQid: "Q43653",
    relatedMovies: [{
      title: "One film",
      imdbId: "tt1234567",
      wikidataEntityId: "Q100",
    }],
  });
  assert.equal(sparse, "");

  const html = hooks.buildRelatedFilmsBlock({
    relatedMoviesSubjectQid: "Q43653",
    relatedMovies: [
      {
        title: "Apollo 11",
        year: 2019,
        imdbId: "tt8760684",
        wikidataEntityId: "Q61870630",
        sitelinks: 40,
      },
      {
        title: "Moon <script>alert(1)</script>",
        year: 2009,
        imdbId: "tt1182345",
        wikidataEntityId: "Q185015",
        sitelinks: 30,
      },
    ],
  });

  assert.match(html, /Related films and documentaries/);
  assert.match(html, /https:\/\/www\.imdb\.com\/title\/tt8760684\//);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /Moon &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img\b/i);
  assert.doesNotMatch(html, /\brating\b|\breview\b/i);
  assert.doesNotMatch(html, /rel="sponsored/);
});

test("a failed optional lookup leaves article content untouched", async () => {
  const content = {
    wikiUrl: "https://en.wikipedia.org/wiki/Apollo_11",
  };
  await assert.rejects(
    hooks.hydrateRelatedFilmsForContent(
      content,
      [{
        type: "event",
        wikiUrl: content.wikiUrl,
        wikidataEntityId: "Q43653",
        primaryHistoryEntity: true,
      }],
      {
        fetchImpl: async () => ({
          ok: false,
          status: 429,
        }),
      },
    ),
    /failed \(429\)/,
  );
  assert.equal(content.relatedMoviesSubjectQid, undefined);
  assert.equal(content.relatedMoviesCheckedAt, undefined);
  assert.equal(content.relatedMovies, undefined);
});

test("stored articles receive the verified film slider at read time without a KV mutation", async () => {
  const html = [
    "<html><head></head><body><article>",
    "<section>Overview</section>",
    "<!-- Eyewitness / Chronicle Accounts -->",
    "<section>Chronicle</section>",
    "</article></body></html>",
  ].join("");
  const entityMeta = JSON.stringify([{
    type: "event",
    wikidataEntityId: "Q43653",
  }]);
  const patched = await hooks.injectRelatedFilmsIntoStoredArticleHtml(
    html,
    entityMeta,
    {
      cache: null,
      fetchImpl: async () => wikidataResponse([
        filmBinding({
          qid: "Q42708010",
          title: "First Man",
          imdb: "tt1213641",
          sitelinks: 44,
        }),
        filmBinding({
          qid: "Q61639822",
          title: "Apollo 11",
          imdb: "tt8760684",
          sitelinks: 13,
        }),
      ]),
    },
  );

  assert.match(patched, /Related films and documentaries/);
  assert.ok(
    patched.indexOf("Related films and documentaries") <
      patched.indexOf("<!-- Eyewitness / Chronicle Accounts -->"),
  );
  assert.match(patched, /tt1213641/);
  assert.match(patched, /tt8760684/);
});

test("Open Library enrichment keeps only topic-matched books and accepts coverless records", async () => {
  const books = await fetchCachedOpenLibraryRelatedBooks("Landsat 1", {
    cache: null,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          docs: [
            {
              title: "Hydrogeological Applications of Landsat 1 Imagery",
              author_name: ["Environment Canada"],
              first_publish_year: 1976,
            },
            {
              title: "Landsat-1 Digital Data",
              author_name: ["George A. Leshkevich"],
              cover_i: 7325545,
              first_publish_year: 1981,
            },
            {
              title: "Unrelated Medieval Chronicle",
              author_name: ["Example Author"],
              first_publish_year: 1990,
            },
          ],
        };
      },
    }),
  });

  assert.equal(books.length, 2);
  assert.equal(books[0].coverUrl, undefined);
  assert.match(books[1].coverUrl, /covers\.openlibrary\.org/);
});

test("evergreen layout places figures after early sections, books after section one, and films after section three", () => {
  const html = historyHooks.buildEntityBodySections({
    type: "event",
    name: "Apollo 11",
    summaryTitle: "Apollo 11",
    bodySections: [
      { heading: "First", paragraphs: ["First complete paragraph."] },
      { heading: "Second", paragraphs: ["Second complete paragraph."] },
      { heading: "Third", paragraphs: ["Third complete paragraph."] },
      { heading: "Fourth", paragraphs: ["Fourth complete paragraph."] },
    ],
    inlineImages: [
      {
        src: "https://upload.wikimedia.org/wikipedia/commons/a/a1/First.jpg",
        caption: "First image",
      },
      {
        src: "https://upload.wikimedia.org/wikipedia/commons/b/b2/Second.jpg",
        caption: "Second image",
      },
    ],
    relatedBooks: [
      {
        title: "Apollo 11: The Inside Story",
        author: "Example One",
      },
      {
        title: "Apollo 11 Mission Report",
        author: "Example Two",
      },
    ],
    relatedMovies: [
      {
        title: "First Man",
        year: 2018,
        imdbId: "tt1213641",
      },
      {
        title: "Apollo 11",
        year: 2019,
        imdbId: "tt8760684",
      },
    ],
  });

  const firstSection = html.indexOf(">First</h2>");
  const firstFigure = html.indexOf("First image");
  const books = html.indexOf("Related books");
  const secondSection = html.indexOf(">Second</h2>");
  const secondFigure = html.indexOf("Second image");
  const thirdSection = html.indexOf(">Third</h2>");
  const films = html.indexOf("Related films and documentaries");
  const fourthSection = html.indexOf(">Fourth</h2>");
  assert.ok(firstSection < firstFigure && firstFigure < books);
  assert.ok(books < secondSection && secondSection < secondFigure);
  assert.ok(secondFigure < thirdSection && thirdSection < films);
  assert.ok(films < fourthSection);
});
