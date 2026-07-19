import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  __contentGenerationTestHooks as blogHooks,
} from "../js/blog-ai-worker.js";

const richHistoryBody = [{
  heading: "History",
  paragraphs: [Array.from(
    { length: 320 },
    (_, index) => `documented${index}`,
  ).join(" ")],
}];

test("promotional title hooks are removed from factual event headlines", () => {
  const content = {
    eventTitle: "Join the Fight: Spanish Civil War Begins",
    title: "Join the Fight: Spanish Civil War Begins — July 17, 1936",
    historicalDate: "July 17, 1936",
    description:
      "A military uprising against Spain's Popular Front government begins the Spanish Civil War on July 17, 1936, and divides the country.",
    ogDescription:
      "A military uprising begins the Spanish Civil War and divides Spain between Republicans and Nationalists.",
    twitterDescription:
      "A military uprising begins the Spanish Civil War in Spain on July 17, 1936.",
    quickFacts: [{
      label: "Event",
      value: "Join the Fight: Spanish Civil War Begins",
    }],
  };

  blogHooks.normalizeContentMetadata(content);

  assert.equal(content.eventTitle, "Spanish Civil War Begins");
  assert.equal(content.title, "Spanish Civil War Begins — July 17, 1936");
  assert.equal(content.quickFacts[0].value, "Spanish Civil War Begins");
});

test("publication rejects analysis that reviews the article instead of history", () => {
  const result = blogHooks.validateContentSemanticsForPublish({
    title: "Spanish Civil War Begins — July 17, 1936",
    eventTitle: "Spanish Civil War Begins",
    historicalDate: "July 17, 1936",
    historicalDateISO: "1936-07-17",
    historicalYear: 1936,
    analysisGood: [{
      title: "Clear chronology",
      detail:
        "The article accurately records the opening of the conflict and correctly identifies the factions involved.",
    }],
    analysisBad: [{
      title: "Missing context",
      detail:
        "The article omits casualty data and does not explain the political transition after 1939.",
    }],
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.reasons.some((reason) =>
      /reviews the article instead of analyzing/i.test(reason)),
    JSON.stringify(result.reasons),
  );
});

test("history discovery is separated from the people row", () => {
  const html = blogHooks.buildArticleEntityStrip([
    {
      type: "person",
      slug: "francisco-franco",
      name: "Francisco Franco",
      url: "/people/francisco-franco/",
      wikiUrl: "https://en.wikipedia.org/wiki/Francisco_Franco",
      imageUrl:
        "https://upload.wikimedia.org/wikipedia/commons/4/4a/GENERAL_FRANCO.jpg",
      wikidataEntityId: "Q29179",
      wikidataInstanceOfHuman: true,
      profileLinkEligible: true,
      profileSubjectVerified: true,
    },
    {
      type: "event",
      slug: "spanish-civil-war-erupts",
      name: "Spanish Civil War Erupts",
      url: "/history/spanish-civil-war-erupts/",
      wikiUrl: "https://en.wikipedia.org/wiki/Spanish_Civil_War",
      imageUrl:
        "https://upload.wikimedia.org/wikipedia/commons/a/a0/spanish-civil-war.jpg",
      bodySections: richHistoryBody,
    },
  ]);

  const peopleRow = html.match(
    /<h2 class="h3">People in this story<\/h2><div class="[^"]*\bentity-person-chips\b[^"]*">([\s\S]*?)<\/div>/,
  )?.[1] || "";

  assert.match(
    html,
    /<div class="entity-strip people-strip" data-entity-strip="1">/,
  );
  assert.match(
    html,
    /<div class="entity-strip-content people-track-wrap">/,
  );
  assert.match(
    html,
    /<div class="entity-person-chips people-track">/,
  );
  assert.match(html, /w=160&h=160&fit=cover&q=80/);
  assert.match(html, /width="80" height="80"/);
  assert.doesNotMatch(html, /\.person-pill\{/);
  assert.match(peopleRow, /Francisco Franco/);
  assert.doesNotMatch(peopleRow, /Spanish Civil War|\/history\//);
  assert.match(
    html,
    /<section class="story-topic-section"[^>]*><h2 class="story-topic-heading"[^>]*>Explore this event<\/h2>/,
  );
  assert.match(html, /href="\/history\/spanish-civil-war-1936\/"/);
  assert.match(
    html,
    /class="story-topic-title">Why Did Spain&#39;s July 1936 Coup Fail—and Start a Civil War\?<\/strong>/,
  );
  assert.match(
    html,
    /class="story-topic-description">The coup was designed to replace Spain&#39;s government quickly\./,
  );
  assert.match(
    html,
    /class="story-topic-card-image"><img[^>]+w=720&h=405&fit=cover&q=82/,
  );
  assert.match(html, /Read the full history/);
  assert.equal(
    blogHooks.articleEntityStripNeedsProfileValidation(
      html,
      JSON.stringify([{
        type: "person",
        slug: "francisco-franco",
        name: "Francisco Franco",
        profileLinkEligible: true,
        profileSubjectVerified: true,
        wikidataEntityId: "Q29179",
        wikidataInstanceOfHuman: true,
      }]),
    ),
    false,
  );
});

test("legacy history pills become prominent linked preview cards at serve time", () => {
  const stored = `<!doctype html><html><head>
    <link rel="canonical" href="https://thisday.info/blog/17-july-2026/" />
  </head><body>
    <section class="story-topic-section" aria-label="Explore this event">
      <h2 class="h4">Explore this event</h2>
      <a href="/history/spanish-civil-war-erupts/" class="story-topic-pill" data-history-entity-link="1">
        <span class="story-topic-label">Explore</span><span>Spanish Civil War Erupts</span>
      </a>
    </section>
  </body></html>`;
  const entityMeta = JSON.stringify([{
    type: "event",
    slug: "spanish-civil-war-erupts",
    name: "Spanish Civil War Erupts",
    url: "/history/spanish-civil-war-erupts/",
    wikiUrl: "https://en.wikipedia.org/wiki/Spanish_Civil_War",
    imageUrl:
      "https://upload.wikimedia.org/wikipedia/commons/a/a0/spanish-civil-war.jpg",
    historyLinkEligible: true,
  }]);

  const upgraded = blogHooks.normalizeArticleHistoryDiscoveryCardHtml(
    stored,
    entityMeta,
  );

  assert.match(
    upgraded,
    /<link rel="canonical" href="https:\/\/thisday\.info\/blog\/17-july-2026\/"/,
  );
  assert.match(
    upgraded,
    /href="\/history\/spanish-civil-war-1936\/" class="story-topic-card"/,
  );
  assert.match(
    upgraded,
    /Why Did Spain&#39;s July 1936 Coup Fail—and Start a Civil War\?/,
  );
  assert.match(
    upgraded,
    /The coup was designed to replace Spain&#39;s government quickly\./,
  );
  assert.match(upgraded, /class="story-topic-card-image"><img/);
  assert.match(upgraded, /Read the full history/);
  assert.doesNotMatch(upgraded, /story-topic-pill/);
});

test("future article metadata retains the history card title, image, and description", () => {
  const [historyEntity] = blogHooks.compactArticleEntityMeta([{
    type: "event",
    slug: "moon-landing-1969",
    name: "Apollo 11 Moon Landing",
    pageHeading: "Why Did Apollo 11 Risk a Manual Lunar Landing?",
    description:
      "Explore the alarms, fuel pressure, and decisions behind Apollo 11's final descent.",
    imageUrl:
      "https://upload.wikimedia.org/wikipedia/commons/example-moon.jpg",
    url: "/history/moon-landing-1969/",
    wikiUrl: "https://en.wikipedia.org/wiki/Apollo_11",
    historyLinkEligible: true,
  }]);

  assert.equal(
    historyEntity.pageHeading,
    "Why Did Apollo 11 Risk a Manual Lunar Landing?",
  );
  assert.equal(
    historyEntity.description,
    "Explore the alarms, fuel pressure, and decisions behind Apollo 11's final descent.",
  );
  assert.equal(
    historyEntity.imageUrl,
    "https://upload.wikimedia.org/wikipedia/commons/example-moon.jpg",
  );
});

test("serve-time history link migration preserves the date article canonical", () => {
  const stored = `<!doctype html><html><head>
    <link rel="canonical" href="https://thisday.info/blog/17-july-2026/" />
  </head><body>
    <a href="/history/spanish-civil-war-erupts/">Spanish Civil War Erupts</a>
  </body></html>`;

  const migrated =
    blogHooks.normalizeHistoryEntityCanonicalLinksHtml(stored);

  assert.match(
    migrated,
    /<link rel="canonical" href="https:\/\/thisday\.info\/blog\/17-july-2026\/"/,
  );
  assert.match(
    migrated,
    /href="\/history\/spanish-civil-war-1936\/"/,
  );
  assert.doesNotMatch(
    migrated,
    /href="\/history\/spanish-civil-war-erupts\/"/,
  );
});

test("legacy article people strips adopt the homepage presentation at serve time", () => {
  const legacy = `<html><head><link rel="stylesheet" href="/css/custom.css?v=31"></head><body>
<style>.entity-strip{margin:0 0 2rem}.entity-person-chips{display:flex}.person-pill{display:inline-flex;white-space:nowrap}.person-circle{width:42px;height:42px}.person-pill-name{width:96px;overflow:hidden;white-space:nowrap}</style><div class="entity-strip" data-entity-strip="1"><div class="entity-strip-content"><h2 class="h3">People in this story</h2><div class="entity-person-chips"><a href="/people/francisco-franco/" class="person-pill"><span class="person-circle"><img src="/image-proxy?src=portrait.jpg&w=120&h=120&fit=cover&q=80" alt="Francisco Franco" loading="lazy"></span><span class="person-pill-name">Francisco Franco</span></a></div></div></div>
<p id="after-strip">After strip</p></body></html>`;

  const normalized =
    blogHooks.normalizeArticleEntityStripPresentationHtml(legacy);

  assert.match(
    normalized,
    /<div class="entity-strip people-strip" data-entity-strip="1">/,
  );
  assert.match(
    normalized,
    /class="entity-strip-content people-track-wrap"/,
  );
  assert.match(
    normalized,
    /class="entity-person-chips people-track"/,
  );
  assert.match(normalized, /w=160&h=160&fit=cover&q=80/);
  assert.match(normalized, /width="80" height="80"/);
  assert.match(normalized, /<span class="person-pill-name">Francisco Franco<\/span>/);
  assert.doesNotMatch(normalized, /\.person-pill\{/);
  assert.doesNotMatch(normalized, /width:42px|white-space:nowrap\}\.person-circle/);
  assert.match(normalized, /<p id="after-strip">After strip<\/p>/);
  assert.equal(
    blogHooks.normalizeArticleEntityStripPresentationHtml(normalized),
    normalized,
  );
});

test("legacy quiz float bars adopt the compact floating-card presentation", () => {
  const legacy = `<html><head><style>.kept{color:red}#tdq-float-bar{position:fixed;bottom:0;left:0;right:0;background:#fff}#tdq-float-bar.tdq-float-visible{transform:translateY(0)}#tdq-float-btn{background:#1a3a2d;color:#fff}#tdq-float-btn:hover{background:#1a3a2d}</style></head><body>
<div id="tdq-float-bar"><button id="tdq-float-btn"><i class="bi bi-patch-question-fill"></i> Quiz This Day</button></div>
<script>(function(){var bar=document.getElementById('tdq-float-bar');function showBar(){bar.classList.add('tdq-float-visible');}function hideBar(){bar.classList.remove('tdq-float-visible');}})();</script>
</body></html>`;

  const normalized = blogHooks.normalizeTdqFloatBarHtml(legacy);

  assert.match(normalized, /id="tdq-float-card-style"/);
  assert.match(
    normalized,
    /#tdq-float-bar\{position:fixed;left:50%;bottom:max\(12px,env\(safe-area-inset-bottom\)\);z-index:1040;width:min\(720px,calc\(100% - 24px\)\);display:grid;grid-template-columns:88px minmax\(0,1fr\) auto/,
  );
  assert.match(
    normalized,
    /border:1px solid var\(--border,#cfe0cf\);border-radius:9px;background:var\(--bg-alt,#f2f7f2\);box-shadow:0 18px 42px rgba\(27,58,45,.22\)/,
  );
  assert.match(
    normalized,
    /<aside id="tdq-float-bar" class="major-event-item tdq-float-bar" aria-label="Article quiz" aria-hidden="true" inert>/,
  );
  assert.match(normalized, /class="tdq-float-kicker">Quick quiz<\/span>/);
  assert.match(normalized, /class="tdq-float-title">Test Your Knowledge<\/strong>/);
  assert.match(normalized, /id="tdq-float-btn"[^>]*>Start Quiz<i class="bi bi-arrow-right"/);
  assert.match(normalized, /\.kept\{color:red\}/);
  assert.doesNotMatch(normalized, /bottom:0;left:0;right:0/);
  assert.match(
    normalized,
    /function showBar\(\)\{bar\.classList\.add\('tdq-float-visible'\);bar\.setAttribute\('aria-hidden','false'\);bar\.removeAttribute\('inert'\);\}/,
  );
  assert.match(
    normalized,
    /function hideBar\(\)\{bar\.classList\.remove\('tdq-float-visible'\);bar\.setAttribute\('aria-hidden','true'\);bar\.setAttribute\('inert',''\);\}/,
  );
  assert.equal(blogHooks.normalizeTdqFloatBarHtml(normalized), normalized);
});

test("stored quiz float bars are retriggered on the Did You Know slider", () => {
  const storedPost = `<html><head></head><body>
<article>
<h2 class="h3">Did You Know?</h2>
<section class="dyn-slider-shell" aria-label="Did you know"></section>
<h2 class="h3">First Reports From the Scene</h2>
</article>
<aside id="tdq-float-bar" class="major-event-item tdq-float-bar" aria-label="Article quiz" aria-hidden="true" inert></aside>
<script>
  (function(){
    var bar=document.getElementById('tdq-float-bar');
    // Trigger: show/hide bar based on Eyewitness heading scroll position
    var h2s=document.querySelectorAll('h2');
    var trigger=null;
    for(var i=0;i<h2s.length;i++){if(h2s[i].textContent.indexOf('Eyewitness')!==-1){trigger=h2s[i];break;}}
    if(trigger){
      function updateBar(){var rect=trigger.getBoundingClientRect();if(rect.top<window.innerHeight){showBar();}else{hideBar();}}
      window.addEventListener('scroll',updateBar,{passive:true});
    } else {
      document.addEventListener('scroll',function onScroll(){
        var d=document.documentElement;
        var total=d.scrollHeight-d.clientHeight;
        if(total>0&&d.scrollTop/total>0.35){showBar();document.removeEventListener('scroll',onScroll);}
      },{passive:true});
    }
  })();
</script>
</body></html>`;

  const normalized = blogHooks.normalizeTdqFloatBarHtml(storedPost);

  assert.ok(normalized.includes(blogHooks.TDQ_FLOAT_TRIGGER_JS));
  assert.match(
    normalized,
    /var trigger=document\.querySelector\('\.dyn-slider-shell'\)/,
  );
  assert.match(normalized, /window\.innerHeight\*\.72/);
  assert.doesNotMatch(normalized, /indexOf\('Eyewitness'\)/);
  assert.doesNotMatch(normalized, /var trigger=null/);
  assert.doesNotMatch(normalized, /scrollTop\/total>0\.35/);
  assert.equal(blogHooks.normalizeTdqFloatBarHtml(normalized), normalized);

  const singleLinePost = storedPost.replace(
    /\n\s*(?=var |for\(|if\(|document\.|window\.|\} else \{|\},\{passive|\}\s*\n)/g,
    "",
  );
  const singleLineNormalized =
    blogHooks.normalizeTdqFloatBarHtml(singleLinePost);
  assert.doesNotMatch(singleLineNormalized, /indexOf\('Eyewitness'\)/);
  assert.ok(singleLineNormalized.includes(blogHooks.TDQ_FLOAT_TRIGGER_JS));
});

test("the quiz float trigger uses the Did You Know slider in every template copy", () => {
  const workerSource = readFileSync(
    new URL("../js/blog-ai-worker.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(workerSource, /indexOf\('Eyewitness'\)/);
  const triggerUsages =
    workerSource.match(/\$\{TDQ_FLOAT_TRIGGER_JS\}/g) || [];
  assert.ok(triggerUsages.length >= 2);
  assert.match(
    blogHooks.TDQ_FLOAT_TRIGGER_JS,
    /^var trigger=document\.querySelector\('\.dyn-slider-shell'\);/,
  );
  assert.match(blogHooks.TDQ_FLOAT_TRIGGER_JS, /window\.innerHeight\*\.72/);
  assert.match(blogHooks.TDQ_FLOAT_TRIGGER_JS, /requestAnimationFrame/);
});

test("analysis is event-labelled and collapsed behind a native disclosure", () => {
  const analysisItems = (prefix) => Array.from({ length: 3 }, (_, index) => ({
    title: `${prefix} ${index + 1}`,
    detail:
      `The Spanish record for 1936 documents a concrete historical action, its limits, and a source-supported consequence for analysis point ${index + 1}.`,
  }));
  const html = blogHooks.buildPostHTML(
    {
      title: "Spanish Civil War Begins — July 17, 1936",
      curiosityTitle:
        "How Did a Partly Failed Coup Become the Spanish Civil War?",
      eventTitle: "Spanish Civil War Begins",
      sourcePageTitle: "Spanish Civil War",
      wikiUrl: "https://en.wikipedia.org/wiki/Spanish_Civil_War",
      historicalDate: "July 17, 1936",
      historicalDateISO: "1936-07-17",
      historicalYear: 1936,
      description:
        "A military uprising against Spain's Popular Front government begins the Spanish Civil War on July 17, 1936, and divides the country.",
      overviewParagraphs: [
        "The July 1936 uprising divided Spain between Republican and Nationalist forces.",
      ],
      analysisGood: analysisItems("Evidence"),
      analysisBad: analysisItems("Limit"),
      keyTerms: [{ term: "Francisco Franco", type: "person" }],
    },
    new Date("2026-07-17T00:05:00.000Z"),
    "17-july-2026",
    [],
    ["War & Conflict"],
  );

  assert.match(
    html,
    /<title>How Did a Partly Failed Coup Become the Spanish Civil War\?<\/title>/,
  );
  assert.match(
    html,
    /<h1 class="mb-2 fw-bold">How Did a Partly Failed Coup Become the Spanish Civil War\?<\/h1>/,
  );
  assert.match(
    html,
    /<li class="breadcrumb-item active" aria-current="page">Spanish Civil War Begins<\/li>/,
  );
  assert.match(html, /<h2 class="h3">Analysis: Spanish Civil War<\/h2>/);
  assert.match(html, /<details class="analysis-disclosure mt-2">/);
  assert.match(
    html,
    /<summary class="analysis-disclosure-summary">What the evidence supports and leaves unresolved<\/summary>/,
  );
  assert.doesNotMatch(html, /<h2 class="h3">Our Take:/);
});

test("future articles show the verified evidence comparison near the overview", () => {
  const sourcePages = [
    {
      pageTitle: "Spanish Civil War",
      pageUrl: "https://en.wikipedia.org/wiki/Spanish_Civil_War",
      publisher: "Wikipedia",
      accessedAt: "2026-07-17",
      supportedClaims: [
        "A military uprising in July 1936 began the Spanish Civil War.",
      ],
    },
    {
      pageTitle: "The Spanish Civil War",
      pageUrl: "https://www.iwm.org.uk/history/what-you-need-to-know-about-the-spanish-civil-war",
      publisher: "Imperial War Museums",
      accessedAt: "2026-07-17",
      supportedClaims: [
        "A military uprising in July 1936 began the Spanish Civil War.",
      ],
      verifiedIndependent: true,
    },
  ];

  const validation = blogHooks.validateEvidenceMapForPublish({ sourcePages });
  const html = blogHooks.buildEvidenceMapBlock({ sourcePages });
  const visibleText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  assert.equal(validation.ok, true, JSON.stringify(validation.reasons));
  assert.match(
    html,
    /<section class="article-evidence-map article-analysis mt-5" style="margin-top:2rem!important"/,
  );
  assert.match(html, /<details class="analysis-disclosure mt-2">/);
  assert.match(html, /<summary class="analysis-disclosure-summary">/);
  assert.match(
    html,
    /class="analysis-disclosure-body evidence-map-content"/,
  );
  assert.doesNotMatch(html, /evidence-map-summary|evidence-map-toggle-label/);
  assert.match(html, /Evidence Map: How We Checked the Central Claim/);
  assert.match(html, /Spanish Civil War · Wikipedia/);
  assert.match(html, /The Spanish Civil War · Imperial War Museums/);
  assert.match(html, /Independent corroboration/);
  assert.doesNotMatch(visibleText, /https?:\/\//);
});

test("commercial blocks render only with verified topic-matched books", () => {
  const baseContent = {
    title: "Spanish Civil War Begins — July 17, 1936",
    eventTitle: "Spanish Civil War Begins",
    sourcePageTitle: "Spanish Civil War",
    keywords: "Spanish Civil War, Francisco Franco, Republican Spain",
    keyTerms: [{ term: "Francisco Franco", type: "person" }],
    bookSearchQuery: "Spanish Civil War books",
    amazonBookTopic: "Books on the Spanish Civil War",
  };
  const relevantContent = {
    ...baseContent,
    openLibraryBooks: [
      {
        title: "The Spanish Civil War",
        author: "Hugh Thomas",
        coverUrl: "https://covers.openlibrary.org/b/id/1-M.jpg",
      },
      {
        title: "Franco",
        author: "Paul Preston",
        coverUrl: "https://covers.openlibrary.org/b/id/2-M.jpg",
      },
      {
        title: "The Roman Empire",
        author: "Mary Beard",
        coverUrl: "https://covers.openlibrary.org/b/id/3-M.jpg",
      },
    ],
  };
  const irrelevantContent = {
    ...baseContent,
    openLibraryBooks: [
      {
        title: "The Roman Empire",
        author: "Mary Beard",
        coverUrl: "https://covers.openlibrary.org/b/id/3-M.jpg",
      },
      {
        title: "Apollo 11",
        author: "James Donovan",
        coverUrl: "https://covers.openlibrary.org/b/id/4-M.jpg",
      },
      {
        title: "Napoleon",
        author: "Andrew Roberts",
        coverUrl: "https://covers.openlibrary.org/b/id/5-M.jpg",
      },
    ],
  };

  assert.equal(
    blogHooks.commercialRecommendationsAreRelevant(relevantContent),
    true,
  );
  assert.equal(
    blogHooks.relevantOpenLibraryBooks(relevantContent).length,
    2,
  );
  const relevantHtml = blogHooks.buildAmazonRelatedBlock(
    relevantContent,
    ["War & Conflict"],
  );
  assert.match(relevantHtml, /class="amazon-related/);
  const renderedTrack = relevantHtml.match(
    /<div class="amazon-slider-track"[^>]*>([\s\S]*?)<\/div>/,
  )?.[1] || "";
  assert.equal(
    (renderedTrack.match(/class="amazon-product-card"/g) || []).length,
    2,
  );
  assert.doesNotMatch(relevantHtml, /The Roman Empire/);

  assert.equal(
    blogHooks.commercialRecommendationsAreRelevant(irrelevantContent),
    false,
  );
  assert.equal(
    blogHooks.buildAmazonRelatedBlock(irrelevantContent, ["War & Conflict"]),
    "",
  );
});

test("irrelevant commercial recommendations omit both the affiliate slider and paired ad", () => {
  const html = blogHooks.buildPostHTML(
    {
      title: "Spanish Civil War Begins — July 17, 1936",
      eventTitle: "Spanish Civil War Begins",
      sourcePageTitle: "Spanish Civil War",
      historicalDate: "July 17, 1936",
      historicalDateISO: "1936-07-17",
      historicalYear: 1936,
      description:
        "A military uprising divided Spain and began the Spanish Civil War in July 1936.",
      keywords: "Spanish Civil War, Francisco Franco, Republican Spain",
      keyTerms: [{ term: "Francisco Franco", type: "person" }],
      bookSearchQuery: "Spanish Civil War books",
      openLibraryBooks: [
        {
          title: "Apollo 11",
          author: "James Donovan",
          coverUrl: "https://covers.openlibrary.org/b/id/4-M.jpg",
        },
        {
          title: "The Roman Empire",
          author: "Mary Beard",
          coverUrl: "https://covers.openlibrary.org/b/id/3-M.jpg",
        },
      ],
    },
    new Date("2026-07-17T00:05:00.000Z"),
    "17-july-2026",
    [],
    ["War & Conflict"],
  );

  assert.doesNotMatch(html, /class="amazon-related/);
  assert.doesNotMatch(html, /article-body-ad-v1/);
});

test("article disclosure accurately distinguishes automated safeguards from human review", () => {
  const html = blogHooks.buildArticleProcessDisclosure();

  assert.match(html, /AI assisted with source research and drafting/);
  assert.match(
    html,
    /automated safeguards checked direct citations, independent corroboration of the central claim, factual consistency, and required article structure/,
  );
  assert.match(
    html,
    /A human editor does not necessarily review every article before publication/,
  );
  assert.match(html, /href="\/about\/editorial\/">Read our editorial process/);
  assert.doesNotMatch(
    html,
    /reviewed for factual accuracy by the|reviewed by the editorial team/i,
  );
});

test("legacy article disclosures drop the guaranteed editorial-review claim", () => {
  const legacy = `<div><strong>About this article</strong><span>
    This article was researched and drafted with AI assistance, then reviewed for factual accuracy by the
    <a href="/about/editorial/" rel="author">thisDay. editorial team</a>.
    Historical source: Wikipedia.
  </span></div>`;
  const normalized = blogHooks.normalizeArticleProcessDisclosureHtml(legacy);

  assert.match(normalized, /Automated safeguards vary by publication date/);
  assert.match(
    normalized,
    /A human editor did not necessarily review it before publication/,
  );
  assert.doesNotMatch(normalized, /automated safeguards checked direct citations/i);
  assert.doesNotMatch(normalized, /reviewed for factual accuracy by the/i);
  assert.equal(
    blogHooks.normalizeArticleProcessDisclosureHtml(normalized),
    normalized,
  );
});

test("editorial policy documents the same non-guaranteed human-review workflow", () => {
  const policy = readFileSync(
    new URL("../about/editorial/index.html", import.meta.url),
    "utf8",
  );

  assert.match(policy, /Automated source and fact checks/);
  assert.match(policy, /Automated SEO and quality pass/);
  assert.match(policy, /Human review is not guaranteed before publication/);
  assert.doesNotMatch(policy, /using its training\s+knowledge of the event/i);
});

test("public question titles use a source-supported niche while factual metadata stays locked", () => {
  const content = {
    title: "Spanish Civil War Begins — July 17, 1936",
    curiosityTitle:
      "How Did a Partly Failed Coup Become the Spanish Civil War?",
    eventTitle: "Spanish Civil War Begins",
    sourceEventHeadline: "Spanish Civil War Begins",
    sourcePageTitle: "Spanish Civil War",
    sourceText:
      "An army coup against the Spanish Republic was only partly successful and the country was divided, beginning the Spanish Civil War.",
    sourceExtract:
      "The coup failed to take control of the whole country. Spain split between Republican and Nationalist zones and the conflict developed into civil war.",
    sourcePages: [{
      pageTitle: "Spanish Civil War",
      pageUrl: "https://en.wikipedia.org/wiki/Spanish_Civil_War",
      supportedClaims: [
        "The military coup was only partly successful and developed into the Spanish Civil War.",
      ],
    }],
  };

  const validation = blogHooks.validateCuriosityTitleForPublish(content);

  assert.equal(validation.ok, true, JSON.stringify(validation.reasons));
  assert.equal(
    blogHooks.publicArticleTitle(content),
    "How Did a Partly Failed Coup Become the Spanish Civil War?",
  );
  assert.equal(content.eventTitle, "Spanish Civil War Begins");
  assert.equal(content.title, "Spanish Civil War Begins — July 17, 1936");
});

test("question-title contract rejects generic or unsupported clickbait", () => {
  const content = {
    title: "Spanish Civil War Begins — July 17, 1936",
    eventTitle: "Spanish Civil War Begins",
    sourcePageTitle: "Spanish Civil War",
    sourceText:
      "A military uprising divided Spain and began the Spanish Civil War.",
    sourcePages: [{
      pageTitle: "Spanish Civil War",
      pageUrl: "https://en.wikipedia.org/wiki/Spanish_Civil_War",
      supportedClaims: [
        "A military uprising divided Spain and began the Spanish Civil War.",
      ],
    }],
  };

  const generic = blogHooks.validateCuriosityTitleForPublish({
    ...content,
    curiosityTitle: "What Happened in the Spanish Civil War?",
  });
  const unsupported = blogHooks.validateCuriosityTitleForPublish({
    ...content,
    curiosityTitle: "Why Did a Secret Treaty Start the Spanish Civil War?",
  });

  assert.equal(generic.ok, false);
  assert.ok(generic.reasons.some((reason) => /generic/i.test(reason)));
  assert.equal(unsupported.ok, false);
  assert.ok(unsupported.reasons.some((reason) => /niche angle supported/i.test(reason)));
});

test("question-title normalization removes a redundant full date without rewriting the premise", () => {
  assert.equal(
    blogHooks.normalizeCuriosityTitleText(
      "Why did a non-employee set fire to Kyoto Animation's Studio 1 on July 18, 2019?",
    ),
    "Why did a non-employee set fire to Kyoto Animation's Studio 1?",
  );
});
