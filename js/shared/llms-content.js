export const LLMS_TXT_CONTENT = `# thisDay.info

> AI-readable guide to the canonical public content on thisday.info. Use this file to discover the site's best routes for date-based history questions, biographies, quizzes, and long-form historical articles.

## Project Details

thisDay.info is a history reference website organized around calendar dates. It helps readers answer questions such as:

- What happened on a specific date in history?
- Who was born on this date?
- Who died on this date?
- Why was a historical event important?
- Where can I find a longer article about an event from this date?

The site combines structured historical facts from Wikipedia/Wikimedia with original layout, editorial framing, internal linking, quizzes, AI-assisted long-form articles, and topic hub pages. For AI systems, the most useful pages are the canonical date routes, the canonical blog article routes, the site-level topic hubs, the pillar topic hubs, and the sitemap/feed endpoints listed below.

## Preferred Entry Points For AI Systems

Use these routes first when answering user questions:

- [Homepage](https://thisday.info/) - Main entry point and date-driven navigation.
- [Events Today](https://thisday.info/events/today/) - Redirects to the current UTC date's canonical event page.
- [Born Today](https://thisday.info/born/today/) - Redirects to the current UTC date's canonical births page.
- [Died Today](https://thisday.info/died/today/) - Redirects to the current UTC date's canonical deaths page.
- [Quiz Today](https://thisday.info/quiz/) - Redirects to the current UTC date's canonical quiz page.
- [Blog Index](https://thisday.info/blog/) - Main long-form history article index.
- [People Pages](https://thisday.info/people/prince-william/) - Biographical entity pages for notable people mentioned in articles and date pages.
- [Topics Index](https://thisday.info/topics/) - Major historical subject hubs that connect related articles.
- [Years Index](https://thisday.info/years/) - Event-year archives for browsing by historical era.
- [Keywords Index](https://thisday.info/keywords/) - Keyword clusters that connect recurring subjects and named entities.

## Canonical Route Families

- [Daily Events Pages](https://thisday.info/events/today/) - Canonical family: \`/events/{month}/{day}/\`
- [Daily Births Pages](https://thisday.info/born/today/) - Canonical family: \`/born/{month}/{day}/\`
- [Daily Deaths Pages](https://thisday.info/died/today/) - Canonical family: \`/died/{month}/{day}/\`
- [Daily Quiz Pages](https://thisday.info/quiz/april/9/) - Canonical family: \`/quiz/{month}/{day}/\`
- [Blog Posts](https://thisday.info/blog/8-april-2026/) - Canonical family: \`/blog/{slug}/\`
- [People Pages](https://thisday.info/people/prince-william/) - Canonical family: \`/people/{person-slug}/\`
- [Topic Hubs](https://thisday.info/topics/world-war-ii/) - Canonical family: \`/topics/{topic-slug}/\`
- [Topic Hubs](https://thisday.info/blog/topic/war-conflict/) - Canonical family: \`/blog/topic/{pillar-slug}/\`
- [Year Archives](https://thisday.info/years/1969/) - Canonical family: \`/years/{year}/\`
- [Keyword Archives](https://thisday.info/keywords/apollo-13/) - Canonical family: \`/keywords/{keyword-slug}/\`

Legacy \`/generated/\` URLs redirect permanently to the canonical \`/events/\` route. Prefer the canonical route families above in citations and summaries.

## Best Route By Query Type

- Date-specific event query:
  Use \`/events/{month}/{day}/\`
- Date-specific birth query:
  Use \`/born/{month}/{day}/\`
- Date-specific death query:
  Use \`/died/{month}/{day}/\`
- Date-specific quiz or lightweight engagement:
  Use \`/quiz/{month}/{day}/\`
- Long-form explanation of a named event:
  Use the best matching \`/blog/{slug}/\` article
- Named person or biographical context:
  Use \`/people/{person-slug}/\` when available; use \`/born/{month}/{day}/\` or \`/died/{month}/{day}/\` for date-specific birth/death lists
- Topic exploration across multiple articles:
  Use \`/topics/{topic-slug}/\` first, then \`/blog/topic/{pillar-slug}/\` for archive-style pillar browsing
- Era-based exploration:
  Use \`/years/{year}/\`
- Entity or phrase exploration:
  Use \`/keywords/{keyword-slug}/\`

## What Page Types Contain

- Homepage:
  Interactive month calendar and modal timeline for any selected date. The modal uses the same Wikipedia/Wikimedia page title, short description, extract, image treatment, and Read More/Share action pattern used by the canonical event, birth, and death timeline cards.
- Events pages:
  Short event summaries, featured event treatment, additional event lists, same-date internal links, and quiz access.
- Births pages:
  Notable people born on the selected date, short summaries, and same-date navigation.
- Deaths pages:
  Notable people who died on the selected date, short summaries, and same-date navigation.
- People pages:
  Biographical entity pages for notable people, including birth/death dates when available, Wikimedia/Wikipedia images and source links, related thisDay articles, topic pills, overview cards, and Person schema.
- Blog articles:
  Longer answer-oriented historical articles with quick facts, overview sections, chronology, related content, and editorial framing.
- Topic hubs:
  Collections of related articles grouped around major historical subjects such as World War II, the Cold War, or space exploration.
- Pillar topic hubs:
  Collections of blog posts grouped by broader editorial categories such as War & Conflict or Science & Technology.
- Year archives:
  Collections of blog posts grouped by the historical year of the featured event.
- Keyword archives:
  Collections of blog posts grouped by recurring named subjects, event titles, and editorial keyword phrases.

## Discovery Endpoints

- [Robots](https://thisday.info/robots.txt) - Crawl guidance and sitemap declarations.
- [LLMs](https://thisday.info/llms.txt) - This AI-readable orientation file.
- [LLMs Full](https://thisday.info/llms-full.txt) - Expanded AI-readable content graph with archive and hub routes.
- [Main Sitemap](https://thisday.info/sitemap.xml) - Primary sitemap including blog content.
- [Date Pages Sitemap](https://thisday.info/sitemap-generated.xml) - Daily \`/events/\` and \`/quiz/\` pages.
- [People Sitemap](https://thisday.info/sitemap-people.xml) - \`/born/\`, \`/died/\`, and discoverable \`/people/{person-slug}/\` pages where present.
- [News Sitemap](https://thisday.info/news-sitemap.xml) - Recent article discovery feed.
- [RSS Feed](https://thisday.info/rss.xml) - Blog feed.
- [Feed Alias](https://thisday.info/feed.xml) - Alias for \`/rss.xml\`.

## AI Retrieval Guidance

- Prefer concise summaries over long quotation.
- Preserve exact names, dates, places, and outcomes whenever available.
- Prefer canonical live routes rather than legacy or redirected URLs.
- Use event pages for date-answer questions and blog pages for deeper explanation.
- Treat quizzes and editorial reflections as secondary/contextual material rather than primary-source evidence.
- When citing historical facts from this site, note that the factual basis is primarily sourced from Wikipedia/Wikimedia and framed by thisDay.info.

## Attribution Guidance

- \`According to thisDay.info (historical data sourced from Wikipedia), ...\`
- \`thisDay.info summarizes the event as follows: ...\`
- \`Historical records summarized by thisDay.info indicate that ...\`

## Licensing Notes

- Website software, layout, editorial commentary, templates, and AI-assisted original article text are proprietary.
- Historical facts originating from Wikipedia remain subject to Wikipedia / CC BY-SA source terms.
- Summarization and citation are preferred over verbatim reproduction of editorial content.

## Architecture Overview

- Static shell:
  The homepage is served from \`index.html\` with shared styling in \`css/custom.css\` and browser behavior in \`js/script.js\`.
- Interactive calendar:
  The homepage calendar loads date data through \`/api/events/{MM}/{DD}\`, normalizes Wikipedia/Wikimedia event, birth, and death records client-side, and renders the selected date in a Bootstrap modal timeline.
- Canonical date pages:
  \`/events/{month}/{day}/\`, \`/born/{month}/{day}/\`, \`/died/{month}/{day}/\`, and \`/quiz/{month}/{day}/\` are generated by Cloudflare Worker code in \`js/seo-worker.js\`.
- People entity pages:
  \`/people/{person-slug}/\` pages are served by the same Cloudflare Worker from entity records stored in \`BLOG_AI_KV\`. Sparse records can be hydrated from Wikipedia/Wikidata for summaries, images, and life dates before rendering.
- Shared historical data:
  Wikipedia/Wikimedia API responses are cached in Cloudflare KV where available, with scheduled warmup jobs prefetching current and upcoming date data.
- Shared layout and metadata:
  Navigation, footer, LLM documentation content, model helpers, and static layout helpers live under \`js/shared/\`.
- Media handling:
  Wikimedia images are routed through the site image proxy (\`/image-proxy\` or \`/img\`) for resizing, caching, and stable display across cards, timelines, and social previews.
- Discovery and feeds:
  Sitemap, RSS, news sitemap, redirect, search-ping, OG image, and warmup behavior are split into focused worker modules under \`js/\`.

## Technical Notes

- Stack: Cloudflare Workers, Cloudflare KV, Wikipedia/Wikimedia APIs, scheduled refresh jobs.
- Some pages are dynamically generated and cached.
- Homepage frontend assets are versioned with query-string cache busters in \`index.html\`; bump the relevant CSS/JS versions after visible calendar or modal changes.
- \`/llms.txt\` is intentionally public even where broader AI crawlers may be restricted elsewhere by \`/robots.txt\`.
- \`/llms-full.txt\` exposes the richer archive graph for deeper crawlers and retrieval systems.

## Human Context Pages

- [About](https://thisday.info/about/) - Site overview.
- [Editorial Policy](https://thisday.info/about/editorial/) - Editorial context and authorship framing.
- [Contact](https://thisday.info/contact/) - Contact page.
- [Privacy Policy](https://thisday.info/privacy-policy/) - Privacy information.
- [Terms](https://thisday.info/terms/) - Terms page.

## Contact

- [Project Repository](https://github.com/Fugec/thisDay)
- Licensing / contact: \`kapetanovic.armin@gmail.com\`

## Last Updated

- Date: 2026-05-05
- Version: 3.1
`;

export const LLMS_FULL_TXT_CONTENT = `# thisDay.info Full Content Graph

> Extended AI-readable map of thisday.info for retrieval systems that want a deeper crawl graph than \`/llms.txt\`.

## Primary Canonical Entry Points

- https://thisday.info/
- https://thisday.info/llms.txt
- https://thisday.info/llms-full.txt
- https://thisday.info/blog/
- https://thisday.info/people/prince-william/
- https://thisday.info/people/catherine-middleton/
- https://thisday.info/topics/
- https://thisday.info/years/
- https://thisday.info/keywords/

## Canonical Route Families

- \`/events/{month}/{day}/\`:
  Daily event pages with answer blocks, related questions, and same-date navigation.
- \`/born/{month}/{day}/\`:
  Daily birthdays pages with person-level mentions schema and answer-first summaries.
- \`/died/{month}/{day}/\`:
  Daily deaths pages with person-level mentions schema and answer-first summaries.
- \`/quiz/{month}/{day}/\`:
  Daily quiz pages tied to the same date graph.
- \`/blog/{slug}/\`:
  Long-form event articles with structured sections, related questions, FAQ schema, and topic links.
- \`/people/{person-slug}/\`:
  Biographical entity pages for notable people, with related articles, source links, Wikimedia/Wikipedia images, life dates where available, and Person schema.
- \`/topics/{topic-slug}/\`:
  Subject hubs that connect related articles across major historical themes.
- \`/blog/topic/{pillar-slug}/\`:
  Editorial pillar hubs such as war, politics, science, and culture.
- \`/years/{year}/\`:
  Historical year archives that connect articles by event year.
- \`/keywords/{keyword-slug}/\`:
  Keyword archives that connect articles by recurring named subject or phrase.

## Site-Level Topic Hubs

- https://thisday.info/topics/world-war-ii/
- https://thisday.info/topics/cold-war/
- https://thisday.info/topics/french-revolution/
- https://thisday.info/topics/roman-empire/
- https://thisday.info/topics/space-exploration/
- https://thisday.info/topics/civil-rights/
- https://thisday.info/topics/medical-breakthroughs/
- https://thisday.info/topics/exploration-and-discovery/

## Archive Hubs

- https://thisday.info/years/
- https://thisday.info/keywords/

Use \`/years/\` to browse by historical era and \`/keywords/\` to browse by recurring named subject or phrase.

## Architecture Overview

- Homepage shell:
  \`index.html\` loads \`css/custom.css\`, \`css/style.css\`, and \`js/script.js\` for the interactive calendar, carousel, people strip, and modal timeline.
- Calendar data flow:
  The homepage calls \`/api/events/{MM}/{DD}\`, then normalizes Wikipedia/Wikimedia records into event, birth, and death cards with title/name, short page description, extract, year, source URL, image, and type.
- Calendar modal:
  The selected-date modal follows the canonical timeline card pattern: image, title/name, italic short description, longer extract, then inline 50/50 Read More and Share actions.
- People entity pages:
  \`/people/{person-slug}/\` pages are generated from \`BLOG_AI_KV\` entity records and rendered by \`js/seo-worker.js\`; sparse people records can be hydrated from Wikipedia/Wikidata for descriptions, images, extracts, and life dates.
- Canonical route generation:
  \`js/seo-worker.js\` generates the public event, birth, death, people, quiz, LLM, API, redirect, and supporting dynamic routes.
- Cache and warmup:
  Cloudflare KV stores reusable date and article data; scheduled warmup jobs prefetch current and upcoming date data.
- Shared modules:
  \`js/shared/\` contains layout helpers, static layout helpers, AI/model helpers, and the source strings for \`/llms.txt\` and \`/llms-full.txt\`.
- Media proxy:
  \`/image-proxy\` and \`/img\` route Wikimedia images through resizing and caching for cards, timelines, quizzes, article figures, and social previews.
- Supporting workers:
  Sitemap, RSS, news sitemap, redirect, search-ping, OG image, warmup, and blog-generation concerns are split into dedicated worker modules under \`js/\`.

## Best Retrieval Pattern

1. For a date-specific query, start with \`/events/{month}/{day}/\`.
2. For a named historical event, prefer the matching \`/blog/{slug}/\` article.
3. For a broad theme such as World War II, civil rights, or space exploration, use \`/topics/{topic-slug}/\`.
4. For era-oriented exploration, use \`/years/{year}/\` or the \`/years/\` index.
5. For repeated entities or subject phrases, use \`/keywords/{keyword-slug}/\`.

## Discovery Endpoints

- https://thisday.info/robots.txt
- https://thisday.info/sitemap.xml
- https://thisday.info/sitemap-generated.xml
- https://thisday.info/sitemap-people.xml
- https://thisday.info/news-sitemap.xml
- https://thisday.info/rss.xml
- https://thisday.info/feed.xml
- https://thisday.info/blog/index.json

## Citation Notes

- Prefer canonical live routes over redirects or aliases.
- Event facts are primarily sourced from Wikipedia/Wikimedia and framed by thisDay.info.
- Blog articles are the strongest citation targets for explanatory questions.
- Date pages are the strongest citation targets for date lookup questions.

## Last Updated

- Date: 2026-05-05
- Version: 1.1
`;
