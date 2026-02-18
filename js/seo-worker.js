// This Cloudflare Worker dynamically injects SEO-friendly meta tags
// and preloads daily event data to improve the user experience on site.
// Adds various security headers to enhance protection.
// Injects Schema.org JSON-LD for better SEO.

// --- Configuration Constants ---
// Define a User-Agent for API requests to Wikipedia.
const WIKIPEDIA_USER_AGENT = "thisDay.info (kapetanovic.armin@gmail.com)";

const KV_CACHE_TTL_SECONDS = 24 * 60 * 60; // KV entry valid for 24 hours

// --- Helper function to fetch daily events from Wikipedia API ---
async function fetchDailyEvents(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const apiUrl = `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events/${month}/${day}`;

  const workerCache = caches.default;
  let response = await workerCache.match(apiUrl);
  if (response) {
    console.log("Worker internal Cache HIT for Wikipedia API:", apiUrl);
    return response.json();
  }

  console.log("Fetching from Wikipedia API:", apiUrl);
  try {
    const fetchResponse = await fetch(apiUrl, {
      headers: {
        "User-Agent": WIKIPEDIA_USER_AGENT,
      },
    });

    if (!fetchResponse.ok) {
      console.error(
        `Wikipedia API responded with status ${fetchResponse.status} for ${apiUrl}`,
      );
      await fetchResponse.text(); // Consume body to prevent issues
      throw new Error(
        `Failed to fetch Wikipedia events: ${fetchResponse.statusText}`,
      );
    }

    // Cache the successful response in worker's internal cache for immediate re-use
    await workerCache.put(apiUrl, fetchResponse.clone());

    return fetchResponse.json();
  } catch (error) {
    console.error(`Error fetching daily events from Wikipedia API: ${error}`);
    // Return a default structure in case of an error
    return { events: [], births: [], deaths: [], holidays: [], selected: [] };
  }
}

// --- Helper function to extract a plausible location from event text ---
function extractLocationFromName(text) {
  // Try to find patterns like "in City, Country" or "in City"
  let match = text.match(
    /(?:in|near)\s+([A-Za-z\s,\-]+(?:,\s*[A-Za-z\s\-]+)?)\b/i,
  );
  if (match && match[1]) {
    // Basic cleaning: remove trailing punctuation if any
    let location = match[1].trim();
    if (location.endsWith(".")) {
      location = location.slice(0, -1);
    }
    return location;
  }
  // Fallback if no specific location can be extracted
  return "Historical Location";
}

// --- Image Proxy: resize, cache, and optionally convert Wikipedia images ---
async function handleImageProxy(_request, url, ctx) {
  const src = url.searchParams.get("src");
  const width = Math.min(parseInt(url.searchParams.get("w") || "1200", 10), 2000);
  const quality = Math.min(parseInt(url.searchParams.get("q") || "82", 10), 100);

  if (!src) return new Response("Missing src parameter", { status: 400 });

  let imageUrl;
  try {
    const decoded = decodeURIComponent(src);
    const parsed = new URL(decoded);
    if (!parsed.hostname.endsWith("wikimedia.org")) {
      return new Response("Forbidden: only Wikimedia images allowed", { status: 403 });
    }
    // Resize by swapping the pixel-width segment in Wikipedia thumbnail paths
    // e.g. /320px-File.jpg  →  /1200px-File.jpg
    imageUrl = decoded.replace(/\/\d+px-/, `/${width}px-`);
  } catch {
    return new Response("Invalid URL", { status: 400 });
  }

  // Check worker-level cache first (keyed on final URL + dimensions)
  const workerCache = caches.default;
  const cacheKey = new Request(
    `https://img-cache.thisday.info/${encodeURIComponent(imageUrl)}?w=${width}&q=${quality}`,
  );
  const cached = await workerCache.match(cacheKey);
  if (cached) return cached;

  try {
    const imageResponse = await fetch(imageUrl, {
      headers: {
        "User-Agent": WIKIPEDIA_USER_AGENT,
        Accept: "image/avif,image/webp,image/jpeg,image/*",
      },
      cf: {
        cacheTtl: 60 * 60 * 24 * 30, // 30-day Cloudflare edge cache
        cacheEverything: true,
        // Cloudflare Image Resizing (Pro plan+): converts to WebP/AVIF automatically
        image: { width, quality, format: "auto" },
      },
    });

    if (!imageResponse.ok) {
      return new Response("Image not found", { status: imageResponse.status });
    }

    const headers = new Headers();
    headers.set(
      "Content-Type",
      imageResponse.headers.get("Content-Type") || "image/jpeg",
    );
    headers.set("Cache-Control", "public, max-age=2592000, immutable"); // 30 days browser cache
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Vary", "Accept"); // separate cache entry per Accept header (WebP vs JPEG)

    const result = new Response(imageResponse.body, { status: 200, headers });
    ctx.waitUntil(workerCache.put(cacheKey, result.clone()));
    return result;
  } catch {
    return new Response("Error fetching image", { status: 500 });
  }
}

// ─── Auto-Generated Blog Posts ───────────────────────────────────────────────

const MONTH_NUM_MAP = {
  january:1, february:2, march:3, april:4, may:5, june:6,
  july:7, august:8, september:9, october:10, november:11, december:12,
};
const MONTH_DISPLAY_NAMES = [
  "","January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
const MONTHS_ALL = [
  "january","february","march","april","may","june",
  "july","august","september","october","november","december",
];
const DAYS_IN_MONTH = [31,29,31,30,31,30,31,31,30,31,30,31]; // Feb=29 to cover all possible dates

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Returns an array of 2-3 original editorial paragraphs for the featured event.
// All text is authored by thisDay.info — safe to render as HTML without escaping.
function workerCommentary(year, text) {
  const y = parseInt(year, 10);
  const t = (text || "").toLowerCase();

  const war  = /war|battle|siege|invasion|conflict|defeat|victory|troops|army|military|combat/.test(t);
  const sci  = /discover|invent|launch|orbit|experiment|vaccine|gene|atom|microscope|telescope|theory|equation|element|laboratory/.test(t);
  const pol  = /treaty|signed|declared|constitution|independence|election|revolution|parliament|senate|congress|legislation/.test(t);
  const expl = /expedition|voyage|navigator|circumnavigat|new world|explorer|coloniz|sailing|landed/.test(t);
  const dis  = /earthquake|hurricane|typhoon|tsunami|eruption|wildfire|flood|epidemic|plague|famine|disaster|collapsed|shipwreck/.test(t);
  const art  = /\bfilm\b|novel|painting|symphony|opera|theatre|theater|poem|published|premiered|literary|artist|composer|sculptor|architecture|museum/.test(t);
  const rel  = /church|cathedral|pope|bishop|crusade|mosque|temple|monastery|reformation|heresy|clergy|saint|protestant|catholic/.test(t);

  const era =
    y < 500  ? "ancient"      :
    y < 1400 ? "medieval"     :
    y < 1700 ? "early_modern" :
    y < 1900 ? "modern"       : "contemporary";

  if (war) {
    if (era === "ancient") return [
      "In the ancient world, warfare was the ultimate arbiter of civilization. Kingdoms that had stood for centuries could be erased in a single campaign season — their people absorbed, enslaved, or scattered across unfamiliar lands.",
      "What the victors recorded as glorious triumph was, for the defeated, the collapse of everything they knew: language, gods, customs, and kinship networks reduced first to memory, then eventually to silence.",
      "Yet conflict also accelerated exchange. Technologies, crops, religions, and ideas spread fastest along routes carved by armies. War built the ancient world as much as it destroyed it.",
    ];
    if (era === "medieval") return [
      "Medieval warfare was rarely the chivalric contest romanticized in later literature. Sieges could last months, reducing entire populations to starvation; plague followed armies as reliably as supply carts followed generals.",
      "Feudal loyalty made alliances permanently treacherous. Kings who commanded the battlefield could lose the political war at home — undone by barons whose interests never fully aligned with the crown's ambitions.",
      "Still, medieval conflicts reshaped Europe's borders so profoundly that their lines echo in national identities today. The map of the modern world was drawn, in large part, by medieval swords.",
    ];
    if (era === "early_modern") return [
      "The introduction of gunpowder fundamentally restructured the calculus of war. Castle walls that had held for centuries became liabilities overnight. The armored knight — product of decades of expensive training — could be felled by a conscript armed with a musket.",
      "Early modern warfare also began to operate at imperial scale. Conflicts no longer stayed within European borders; they extended across oceans, reshaping the Americas, Africa, and Asia as collateral damage in European quarrels.",
      "These wars demanded new financial systems, bureaucracies, and supply chains — and in the effort to fund and sustain them, the modern nation-state was essentially invented.",
    ];
    if (era === "modern") return [
      "By the 19th century, industrialization had turned war into a logistical problem as much as a tactical one. Railroads, telegraphs, and mass production allowed armies to field hundreds of thousands — and to sustain those losses across years of grinding attrition.",
      "The wars of this era carried an ideological weight their predecessors lacked. Nationalism, liberation, imperial expansion — soldiers increasingly fought for abstractions rather than simply for monarchs or wages.",
      "The human cost was staggering enough to inspire the first serious international attempts at limiting conflict — the Geneva Conventions, the Hague Agreements — though none succeeded in curbing the century's appetite for war.",
    ];
    return [
      "20th and 21st century conflicts redefined what war means entirely. The industrial-scale destruction of two World Wars gave way to nuclear deterrence, proxy conflicts, and asymmetric warfare — each a different answer to the question of how to fight when total war means mutual annihilation.",
      "Today's wars are fought simultaneously on the ground, in the air, in cyberspace, and across media narratives. Shaping global perception has become as strategically important as seizing territory — sometimes more so.",
      "The century's sharpest lesson — that modern war produces no clean victors, only varying degrees of ruin — has yet to be fully absorbed by those who still reach for it as a first resort.",
    ];
  }

  if (sci) {
    if (era === "ancient" || era === "medieval") return [
      "In the ancient and medieval world, scientific inquiry was inseparable from philosophy and theology. Observation of the natural world was a form of reading a divine text — each pattern in the stars or body a reflection of cosmic order.",
      "This did not make early scholars incurious. The great minds of antiquity and the Islamic Golden Age made advances in mathematics, astronomy, and medicine that Europe would not surpass for centuries — achieved without the institutional infrastructure we now take for granted.",
      "What we retrospectively label superstition was often simply the best available framework — a coherent attempt to understand cause and effect with the tools at hand. History remembers the failures. It rarely appreciates how remarkable it was to try at all.",
    ];
    if (era === "early_modern") return [
      "The Scientific Revolution was not a single event but a slow erosion of inherited certainty. Each discovery challenged not just a theory but an entire worldview — and the institutions, both religious and political, that depended on that worldview remaining intact.",
      "Figures like Galileo, Copernicus, and Newton were not safely distant academics. They were, in their time, radicals — challenging what powerful institutions held to be settled truth, and sometimes paying a serious personal price for doing so.",
      "The methods they established — observation, hypothesis, experiment, replication — are now so thoroughly embedded in how we think that it is almost impossible to imagine reasoning without them. That is how completely they changed the world.",
    ];
    if (era === "modern") return [
      "The 19th century turned science into an industry. What had been the work of gentlemen-scholars with private means became organized, funded, and institutionalized — universities, peer-reviewed journals, international conferences. Discovery accelerated accordingly.",
      "The consequences extended far beyond the laboratory. Steam power, electrification, chemistry, and germ theory reshaped daily life faster than any social revolution had managed. A person born in 1800 who lived to 1900 witnessed changes that would have been indistinguishable from magic to their grandparents.",
      "Science also began to carry new moral weight in this period. Darwinian evolution, in particular, forced a renegotiation between empirical inquiry and religious identity that societies are, in some respects, still working through.",
    ];
    return [
      "Modern scientific progress has outpaced humanity's ability to fully absorb its own implications. In less than a century, we moved from the first powered flight to landing on the Moon — and from discovering the structure of DNA to editing it in living organisms.",
      "This pace creates a particular kind of vertigo. Technologies arrive before the ethical frameworks to govern them. The internet, CRISPR, and artificial intelligence all changed the world before anyone had agreed on the rules of engagement.",
      "Yet science remains the most reliable method humanity has found for separating truth from wishful thinking. Its willingness to revise itself when evidence demands it — to discard even beloved theories — is one of our most underappreciated cultural achievements.",
    ];
  }

  if (expl) return [
    "For those who undertook these journeys, the unknown was not an abstraction — it was literal. Coastlines that ended without warning, prevailing winds that shifted unpredictably, diseases no European immune system had encountered. The odds of safe return were never guaranteed.",
    "What exploration produced, beyond geographical knowledge, was a catastrophic redistribution of power, population, and disease. Civilizations encountered along the way — many sophisticated in their own right — were transformed, reduced, or erased within generations of first contact.",
    "We still speak of the 'discovery' of places that had been continuously inhabited for millennia. Revisiting this history honestly means holding two truths simultaneously: the genuine courage these journeys required, and the devastation that followed in their wake.",
  ];

  if (dis) return [
    "Natural disasters operate on geological or meteorological scales entirely indifferent to human plans. Yet their death tolls are shaped as much by social factors — poverty, inequality, political negligence — as by the event itself. The same earthquake kills thousands in one city and dozens in another.",
    "Catastrophe reveals a society's real priorities with uncomfortable clarity. Which communities get rebuilt first, which are quietly abandoned, who receives compensation and who is forgotten — these decisions expose power structures that official policy rarely acknowledges directly.",
    "History's great disasters also tend to accelerate reform. Building codes, early warning systems, and emergency response frameworks were largely built in the aftermath of tragedies that revealed how preventable the worst outcomes were. Progress here has almost always been reactive rather than proactive.",
  ];

  if (art) return [
    "Cultural history moves differently from political history. Where political events can be dated to a specific day, artistic movements accumulate gradually — a novel published here, a manifesto there, a performance that contemporary audiences found outrageous and critics a generation later called definitive.",
    "Art produced in one era is constantly reread by those that follow. Works dismissed as obscene or trivial are restored to the canon; once-celebrated masterworks lose their urgency. The cultural record is perpetually being negotiated and revised by new eyes.",
    "What tends to endure — across centuries and cultural contexts — is work that captured something true about human experience. Not necessarily the technically perfect or the ideologically correct, but the honest. History has a long memory for authenticity.",
  ];

  if (rel) return [
    "Religious history resists easy reduction. Doctrinal disputes that seem, in retrospect, impossibly arcane — precise questions of theology, the authority of a particular text, the correct form of a ritual — were, for those living through them, matters of ultimate consequence, worth dying and killing for.",
    "Religious institutions have simultaneously served as preservers of knowledge, patrons of the arts, centers of social organization, and engines of oppression. Rarely has any one of these functions entirely eclipsed the others in any tradition, for any sustained period.",
    "The relationship between faith and secular authority has never been permanently resolved — only temporarily arranged. Every settlement between them eventually produces the conditions for the next renegotiation, and the terms are always contested.",
  ];

  if (pol) return [
    y < 1800
      ? "Political power in this era was deeply personal. Constitutions and treaties were essentially agreements between powerful individuals — protections for ordinary people were largely absent from the political calculus, because ordinary people were largely absent from political life entirely."
      : "Modern political history is largely the story of who gets counted. The franchise expanded, contracted, and expanded again. Rights were declared, ignored, fought for, and sometimes, eventually, won.",
    y < 1800
      ? "The concepts we now treat as foundational to governance — popular sovereignty, individual rights, the separation of powers — were, in this period, radical ideas at the fringes of political thought. Not yet organizing principles of states, but dangerous propositions held by a small and often persecuted minority."
      : "Political moments that seem minor at the time — a speech, a vote, a protest, an arrest — often define entire generations. The seeds of major historical shifts are almost always visible in retrospect, hidden in plain sight at the time.",
    "The political structures we inhabit today were built on particular compromises, by particular people, under particular pressures. History could plausibly have produced very different outcomes — and very nearly did, more often than is comfortable to acknowledge.",
  ];

  // Default — era-based
  if (era === "ancient") return [
    "Events from the ancient world survive only through fragments — inscriptions, papyri, and secondhand accounts filtered through centuries of copying and interpretation. Every surviving detail was preserved against considerable odds.",
    "The civilizations that produced these events were far more complex and interconnected than popular imagination typically allows. Trade routes, diplomatic correspondence, and shared mythologies linked the ancient Mediterranean, Middle East, and Asia in ways that are still being mapped.",
    "What we call ancient history is largely the record of elites and institutions. The daily lives, beliefs, and experiences of ordinary people — the overwhelming majority — remain largely invisible, recoverable only in fragments through archaeology.",
  ];
  if (era === "medieval") return [
    "The medieval world was far more dynamic and interconnected than the 'Dark Ages' label once suggested. Scholarly exchange between Islamic, Jewish, Byzantine, and European traditions kept classical knowledge alive and advanced it significantly.",
    "Life in the medieval period was shaped by rhythms — liturgical, agricultural, and dynastic — that gave time a different texture than the linear, progress-oriented narrative we tend to impose on it from the outside.",
    "Medieval people were not primitive versions of us, waiting for modernity to arrive. They were fully formed human beings navigating a specific set of circumstances with intelligence, humor, ambition, and fear — much as we do now.",
  ];
  if (era === "early_modern") return [
    "The early modern period was defined by collisions: of continents, religions, political systems, and ways of understanding the world. Old certainties were crumbling faster than new ones could be built to replace them.",
    "Print technology, oceanic navigation, and the Reformation all arrived within decades of each other — a convergence of disruptions that transformed European society more rapidly than anything since the fall of Rome.",
    "People living through this period had no way of knowing they were in a hinge moment of history. They experienced it as confusion, opportunity, and violence in roughly equal measure — which is, perhaps, how most pivotal eras feel from the inside.",
  ];
  if (era === "modern") return [
    "The 19th century compressed centuries of prior change into a matter of decades. Industrial production, mass literacy, global communication, and modern medicine all emerged or transformed so rapidly that contemporaries frequently described feeling unmoored.",
    "This era also produced the modern concept of progress — the idea that history moves in a direction, that tomorrow will be materially better than today. It was a genuinely new way of relating to time, and it reshaped everything from politics to personal ambition.",
    "The century's confidence in its own advancement was not entirely misplaced, but it obscured the costs: ecological damage, colonial exploitation, and social displacement that would take the following century to begin reckoning with.",
  ];
  return [
    "Every event recorded in history represents a decision by someone to consider it worth preserving. The archives of any civilization reveal as much about its values — what it found worth recording — as about what actually occurred.",
    "Much of what happened on any given day was never written down at all. The farmers, merchants, and ordinary people who constituted the overwhelming majority of any era left almost no direct trace. What we call history is largely the record of the exceptional — the violent, the powerful, and the fortunate.",
    "This is precisely why revisiting dates matters. Not simply to accumulate facts, but to notice which stories were preserved and which were not — and to hold some humility about the vast quantity of human experience that passed through this world without leaving a single word behind.",
  ];
}

function generateBlogPostHTML(monthName, day, eventsData, siteUrl) {
  const mNum = MONTH_NUM_MAP[monthName] || 1;
  const mDisplay = MONTH_DISPLAY_NAMES[mNum];
  const canonical = `${siteUrl}/generated/${monthName}/${day}/`;
  const events = eventsData?.events || [];
  const births = eventsData?.births || [];
  const deaths = eventsData?.deaths || [];

  const featured = events.find(e => e.pages?.[0]?.thumbnail?.source) || events[0] || null;
  const others = events.filter(e => e !== featured).slice(0, 8);
  const topBirths = births.slice(0, 5);
  const topDeaths = deaths.slice(0, 5);

  const pageTitle = featured
    ? `${mDisplay} ${day} in History: ${featured.text.split(".")[0]} | thisDay.info`
    : `${mDisplay} ${day} in History | thisDay.info`;
  const rawDesc = featured
    ? `Discover what happened on ${mDisplay} ${day} throughout history. In ${featured.year}: ${featured.text.substring(0, 115)}...`
    : `Explore historical events, births, and deaths that occurred on ${mDisplay} ${day} throughout world history.`;
  const pageDesc = rawDesc.substring(0, 155);
  const ogImg = featured?.pages?.[0]?.thumbnail?.source || `${siteUrl}/images/logo.png`;
  const featImg = featured?.pages?.[0]?.originalimage?.source || featured?.pages?.[0]?.thumbnail?.source || null;
  const featWiki = featured?.pages?.[0]?.content_urls?.desktop?.page || "";
  const commentaryParas = featured
    ? workerCommentary(featured.year, featured.text)
    : [
        "Every date in history is someone's entire world.",
        "What we record as a footnote was, for those living it, the defining moment of their lives. The past was always someone's present.",
      ];
  const featTitle = featured
    ? `${escapeHtml(String(featured.year))} — ${escapeHtml(featured.text.split(".")[0])}`
    : escapeHtml(`Events on ${mDisplay} ${day}`);
  const today = new Date().toISOString().split("T")[0];

  const articleSchema = JSON.stringify({
    "@context": "https://schema.org", "@type": "Article",
    "headline": pageTitle, "description": pageDesc, "url": canonical,
    "datePublished": today, "dateModified": today,
    "author": { "@type": "Organization", "name": "thisDay.info", "url": siteUrl },
    "publisher": { "@type": "Organization", "name": "thisDay.info", "url": siteUrl },
    ...(featImg && { "image": featImg }),
  }).replace(/<\//g, "<\\/");

  const eventsSchema = events.length > 0 ? JSON.stringify({
    "@context": "https://schema.org", "@type": "ItemList",
    "name": `Historical Events on ${mDisplay} ${day}`, "numberOfItems": events.length,
    "itemListElement": events.slice(0, 5).map((e, i) => ({
      "@type": "ListItem", "position": i + 1,
      "item": { "@type": "Event", "name": e.text.substring(0, 100), "description": e.text, "temporalCoverage": String(e.year) },
    })),
  }).replace(/<\//g, "<\\/") : null;

  const othersHtml = others.map(e => {
    const w = e.pages?.[0]?.content_urls?.desktop?.page || "";
    const th = e.pages?.[0]?.thumbnail?.source || "";
    return `<div class="ev-row d-flex align-items-start gap-3">
  <div class="flex-grow-1"><span class="yr">${escapeHtml(String(e.year))}</span> ${escapeHtml(e.text)}${w ? ` <a href="${escapeHtml(w)}" class="small text-muted" target="_blank" rel="noopener noreferrer">Wikipedia &rarr;</a>` : ""}</div>
  ${th ? `<img src="${escapeHtml(th)}" alt="" width="44" height="44" style="border-radius:4px;object-fit:cover;flex-shrink:0" onerror="this.style.display=&#39;none&#39;" loading="lazy"/>` : ""}
</div>`;
  }).join("");

  const birthsHtml = topBirths.map(b => {
    const th = b.pages?.[0]?.thumbnail?.source || "";
    const w = b.pages?.[0]?.content_urls?.desktop?.page || "";
    const name = escapeHtml(b.text.split(",")[0]);
    return `<div class="person-row d-flex align-items-center gap-3">
  ${th ? `<img src="${escapeHtml(th)}" alt="${name}" class="p-thumb" onerror="this.style.display=&#39;none&#39;" loading="lazy"/>` : '<div class="p-thumb-blank"><i class="bi bi-person"></i></div>'}
  <div><span class="yr">${escapeHtml(String(b.year))}</span> ${w ? `<a href="${escapeHtml(w)}" target="_blank" rel="noopener noreferrer">${escapeHtml(b.text)}</a>` : escapeHtml(b.text)}</div>
</div>`;
  }).join("");

  const deathsHtml = topDeaths.map(d => {
    const th = d.pages?.[0]?.thumbnail?.source || "";
    const w = d.pages?.[0]?.content_urls?.desktop?.page || "";
    const name = escapeHtml(d.text.split(",")[0]);
    return `<div class="person-row d-flex align-items-center gap-3">
  ${th ? `<img src="${escapeHtml(th)}" alt="${name}" class="p-thumb" onerror="this.style.display=&#39;none&#39;" loading="lazy"/>` : '<div class="p-thumb-blank"><i class="bi bi-person"></i></div>'}
  <div><span class="yr" style="background:#6c757d">${escapeHtml(String(d.year))}</span> ${w ? `<a href="${escapeHtml(w)}" target="_blank" rel="noopener noreferrer">${escapeHtml(d.text)}</a>` : escapeHtml(d.text)}</div>
</div>`;
  }).join("");

  return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${escapeHtml(pageTitle)}</title>
<link rel="canonical" href="${escapeHtml(canonical)}"/><meta name="robots" content="index, follow"/><meta name="description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:title" content="${escapeHtml(pageTitle)}"/><meta property="og:description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:type" content="article"/><meta property="og:url" content="${escapeHtml(canonical)}"/>
<meta property="og:locale" content="en_US"/><meta property="og:image" content="${escapeHtml(ogImg)}"/>
<meta name="twitter:card" content="summary_large_image"/><meta name="twitter:title" content="${escapeHtml(pageTitle)}"/>
<meta name="twitter:description" content="${escapeHtml(pageDesc)}"/><meta name="twitter:image" content="${escapeHtml(ogImg)}"/>
<meta name="author" content="thisDay.info"/>
<script type="application/ld+json">${articleSchema}</script>
${eventsSchema ? `<script type="application/ld+json">${eventsSchema}</script>` : ""}
<link rel="icon" href="/images/favicon.ico" type="image/x-icon"/>
<link rel="apple-touch-icon" sizes="180x180" href="/images/apple-touch-icon.png"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"/>
<style>
:root{--pb:#3b82f6;--sb:#fff;--tc:#1e293b;--htc:#fff;--fb:#3b82f6;--ftc:#fff;--lc:#2563eb;--cb:#fff;--cbr:rgba(0,0,0,.1);--mu:#6c757d}
body.dark-theme{--pb:#020617;--sb:#1e293b;--tc:#f8fafc;--fb:#020617;--lc:#60a5fa;--cb:#1e293b;--cbr:rgba(255,255,255,.1);--mu:#94a3b8}
body{font-family:Inter,sans-serif;min-height:100vh;display:flex;flex-direction:column;background:var(--sb);color:var(--tc);transition:background .3s,color .3s}
.navbar{background:var(--pb)!important;position:sticky;top:0;z-index:1030}.navbar-brand,.nav-link{color:var(--htc)!important;font-weight:700!important}
main{flex:1;padding:20px 0}
.footer{background:var(--fb);color:var(--ftc);text-align:center;padding:20px;margin-top:30px;font-size:14px}.footer a{color:var(--ftc);text-decoration:underline}
h1,h2,h3,h4{color:var(--tc)}body.dark-theme h1,body.dark-theme h2,body.dark-theme h3,body.dark-theme h4{color:#f8fafc}
a{color:var(--lc)}a:hover{text-decoration:underline}
.form-check-input:checked{background-color:#2563eb!important;border-color:#2563eb!important}
.form-check-input{background:#e2e8f0;border-color:#e2e8f0}body.dark-theme .form-check-input{background:#334155;border-color:#334155}
.form-switch .form-check-input{background-image:url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='-4 -4 8 8'%3e%3ccircle r='3' fill='%23fff'/%3e%3c/svg%3e")}
.card-box{background:var(--cb);border:1px solid var(--cbr);border-radius:10px;padding:22px;margin-bottom:22px}
.feat-img{width:100%;max-height:420px;object-fit:cover;border-radius:8px;margin-bottom:20px}
.commentary{border-left:4px solid #3b82f6;padding:10px 14px;background:rgba(59,130,246,.07);border-radius:0 8px 8px 0;font-style:italic;color:var(--mu);margin:18px 0}
body.dark-theme .commentary{background:rgba(59,130,246,.15)}
.yr{background:#3b82f6;color:#fff;padding:2px 7px;border-radius:4px;font-size:.78rem;font-weight:600;margin-right:6px;white-space:nowrap}
.ev-row{padding:11px 0;border-bottom:1px solid var(--cbr)}.ev-row:last-child{border-bottom:none}
.person-row{padding:9px 0;border-bottom:1px solid var(--cbr)}.person-row:last-child{border-bottom:none}
.p-thumb{width:44px;height:44px;border-radius:50%;object-fit:cover;flex-shrink:0}
.p-thumb-blank{width:44px;height:44px;border-radius:50%;background:#e2e8f0;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:1.2rem;color:#6c757d}
body.dark-theme .p-thumb-blank{background:#334155;color:#94a3b8}
.auto-tag{display:inline-block;background:rgba(59,130,246,.12);color:#3b82f6;font-size:.7rem;font-weight:600;padding:2px 7px;border-radius:20px;margin-left:6px;vertical-align:middle}
body.dark-theme .auto-tag{background:rgba(96,165,250,.15);color:#60a5fa}
</style></head>
<body>
<nav class="navbar navbar-expand-lg navbar-dark">
  <div class="container-fluid">
    <a class="navbar-brand" href="/">thisDay.</a>
    <div class="form-check form-switch d-lg-none me-2">
      <input class="form-check-input" type="checkbox" id="tsm" aria-label="Toggle dark mode"/>
      <label class="form-check-label" for="tsm"><i class="bi bi-moon-fill" style="color:#fff;font-size:1.1rem;margin-left:4px"></i></label>
    </div>
    <div class="collapse navbar-collapse">
      <ul class="navbar-nav ms-auto">
        <li class="nav-item d-flex align-items-center">
          <div class="form-check form-switch d-none d-lg-block me-2">
            <input class="form-check-input" type="checkbox" id="tsd" aria-label="Toggle dark mode"/>
            <label class="form-check-label" for="tsd" style="color:#fff">Dark Mode</label>
          </div>
        </li>
      </ul>
    </div>
  </div>
</nav>
<main class="container my-4" style="max-width:860px">
  <nav aria-label="breadcrumb" class="mb-3">
    <ol class="breadcrumb">
      <li class="breadcrumb-item"><a href="/">Home</a></li>
      <li class="breadcrumb-item"><a href="/blog/">Blog</a></li>
      <li class="breadcrumb-item active">${escapeHtml(mDisplay)} ${day}</li>
    </ol>
  </nav>
  <h1 class="mb-1">${escapeHtml(mDisplay)} ${day} in History <span class="auto-tag">Auto</span></h1>
  <p class="text-muted mb-4" style="font-size:.9rem">A thisDay.info historical overview &mdash; sourced from <a href="https://www.wikipedia.org" target="_blank" rel="noopener noreferrer">Wikipedia</a></p>
  ${featured ? `
  <div class="card-box">
    ${featImg ? `<img src="${escapeHtml(featImg)}" alt="${escapeHtml(featured.text.substring(0, 80))}" class="feat-img" loading="eager"/>` : ""}
    <h2>${featTitle}</h2>
    <p class="mb-3">${escapeHtml(featured.text)}</p>
    <div class="commentary"><i class="bi bi-chat-quote me-1" style="color:#3b82f6"></i>${commentaryParas.map((p, i, a) => `<p class="${i === a.length - 1 ? "mb-0" : "mb-2"}">${p}</p>`).join("")}</div>
    <table class="table table-sm table-bordered mt-3" style="max-width:480px">
      <tr><th>Date</th><td>${escapeHtml(mDisplay)} ${day}</td></tr>
      <tr><th>Year</th><td>${escapeHtml(String(featured.year))}</td></tr>
      <tr><th>Events recorded</th><td>${events.length}</td></tr>
      <tr><th>Data source</th><td><a href="https://www.wikipedia.org" target="_blank" rel="noopener noreferrer">Wikipedia</a></td></tr>
    </table>
    ${featWiki ? `<a href="${escapeHtml(featWiki)}" class="btn btn-outline-primary btn-sm" target="_blank" rel="noopener noreferrer"><i class="bi bi-box-arrow-up-right me-1"></i>Full Article on Wikipedia</a>` : ""}
  </div>` : `<div class="alert alert-info">No events found for ${escapeHtml(mDisplay)} ${day}.</div>`}
  ${others.length > 0 ? `
  <div class="card-box">
    <h2 class="h4 mb-3"><i class="bi bi-calendar-event me-2" style="color:#3b82f6"></i>More Events on ${escapeHtml(mDisplay)} ${day}</h2>
    ${othersHtml}
  </div>` : ""}
  ${topBirths.length > 0 ? `
  <div class="card-box">
    <h2 class="h4 mb-3"><i class="bi bi-person-heart me-2" style="color:#3b82f6"></i>Born on ${escapeHtml(mDisplay)} ${day}</h2>
    ${birthsHtml}
  </div>` : ""}
  ${topDeaths.length > 0 ? `
  <div class="card-box">
    <h2 class="h4 mb-3"><i class="bi bi-flower1 me-2" style="color:#6c757d"></i>Died on ${escapeHtml(mDisplay)} ${day}</h2>
    ${deathsHtml}
  </div>` : ""}
  <div class="text-center my-5 pt-3 border-top">
    <p class="text-muted mb-3">Explore history for any date on the interactive calendar.</p>
    <a href="/" class="btn btn-primary me-2"><i class="bi bi-calendar3 me-1"></i>Open the Calendar</a>
    <a href="/blog/" class="btn btn-outline-primary"><i class="bi bi-journal-text me-1"></i>All Blog Posts</a>
  </div>
</main>
<footer class="footer">
  <div class="container d-flex justify-content-center my-2">
    <div class="me-2"><a href="https://github.com/Fugec" target="_blank" rel="noopener noreferrer" aria-label="GitHub"><i class="bi bi-github h3 text-white"></i></a></div>
    <div class="me-2"><a href="https://www.facebook.com/profile.php?id=61578009082537" target="_blank" rel="noopener noreferrer" aria-label="Facebook"><i class="bi bi-facebook h3 text-white"></i></a></div>
    <div class="me-2"><a href="https://www.instagram.com/thisday.info/" target="_blank" rel="noopener noreferrer" aria-label="Instagram"><i class="bi bi-instagram h3 text-white"></i></a></div>
    <div class="me-2"><a href="https://www.tiktok.com/@this__day" target="_blank" rel="noopener noreferrer" aria-label="TikTok"><i class="bi bi-tiktok h3 text-white"></i></a></div>
    <div class="me-2"><a href="https://www.youtube.com/@thisDay_info/shorts" target="_blank" rel="noopener noreferrer" aria-label="YouTube"><i class="bi bi-youtube h3 text-white"></i></a></div>
  </div>
  <p>&copy; <span id="yr"></span> thisDay. All rights reserved.</p>
  <p>Historical data sourced from Wikipedia.org under <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a> license. Data is for informational purposes and requires verification.</p>
  <p>This website is not affiliated with any official historical organization. Content is for educational and entertainment purposes only.</p>
  <p><a href="/blog/">Blog</a> | <a href="/about/">About Us</a> | <a href="/contact/">Contact</a> | <a href="/terms/">Terms</a> | <a href="/privacy-policy/">Privacy Policy</a></p>
</footer>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
<script>
document.getElementById('yr').textContent=new Date().getFullYear();
const ds=document.getElementById('tsd'),ms=document.getElementById('tsm');
const ap=d=>document.body.classList.toggle('dark-theme',d);
const dk=localStorage.getItem('theme')==='dark'||(window.matchMedia?.('(prefers-color-scheme:dark)').matches&&localStorage.getItem('theme')!=='light');
ap(dk);if(ds)ds.checked=dk;if(ms)ms.checked=dk;
if(ds)ds.addEventListener('change',()=>{ap(ds.checked);localStorage.setItem('theme',ds.checked?'dark':'light');if(ms)ms.checked=ds.checked;});
if(ms)ms.addEventListener('change',()=>{ap(ms.checked);localStorage.setItem('theme',ms.checked?'dark':'light');if(ds)ds.checked=ms.checked;});
</script>
</body></html>`;
}

function serveGeneratedSitemap(siteUrl) {
  const today = new Date().toISOString().split("T")[0];
  let urls = "";
  for (let m = 0; m < 12; m++) {
    for (let d = 1; d <= DAYS_IN_MONTH[m]; d++) {
      urls += `  <url>\n    <loc>${siteUrl}/generated/${MONTHS_ALL[m]}/${d}/</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>\n`;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}</urlset>`;
}

async function handleGeneratedPost(_request, env, ctx, url) {
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  // Expect: ['generated', 'july', '20']
  if (parts.length < 3) return new Response("Not Found", { status: 404 });
  const monthName = parts[1].toLowerCase();
  const day = parseInt(parts[2], 10);
  if (!MONTH_NUM_MAP[monthName] || isNaN(day) || day < 1 || day > 31) {
    return new Response("Not Found", { status: 404 });
  }

  // Try KV cache (7-day TTL)
  const kvKey = `gen-post-v1-${monthName}-${day}`;
  try {
    if (env.EVENTS_KV) {
      const cached = await env.EVENTS_KV.get(kvKey);
      if (cached) {
        return new Response(cached, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=3600, s-maxage=604800",
            "X-Cache": "HIT",
          },
        });
      }
    }
  } catch (e) { console.error("KV read:", e); }

  // Fetch from Wikipedia /all/ endpoint (returns events + births + deaths)
  const mPad = String(MONTH_NUM_MAP[monthName]).padStart(2, "0");
  const dPad = String(day).padStart(2, "0");
  const apiUrl = `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/all/${mPad}/${dPad}`;
  let eventsData = { events: [], births: [], deaths: [] };
  try {
    const r = await fetch(apiUrl, { headers: { "User-Agent": WIKIPEDIA_USER_AGENT } });
    if (r.ok) eventsData = await r.json();
  } catch (e) { console.error("Wikipedia API:", e); }

  const siteUrl = `${url.protocol}//${url.host}`;
  const html = generateBlogPostHTML(monthName, day, eventsData, siteUrl);

  // Queue KV write without blocking response
  if (env.EVENTS_KV) {
    ctx.waitUntil(
      env.EVENTS_KV.put(kvKey, html, { expirationTtl: 7 * 24 * 60 * 60 })
        .catch(e => console.error("KV write:", e))
    );
  }

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=604800",
      "X-Cache": "MISS",
    },
  });
}

// --- Main Request Handler (for user requests) ---
async function handleFetchRequest(request, env, ctx) {
  const url = new URL(request.url);

  if (url.pathname === "/llms.txt") {
    const llmsContent = `# Site Summary for Large Language Models...`; // your content
    return new Response(llmsContent, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // Image proxy — must be handled before the HTML pass-through guard
  if (url.pathname === "/img") {
    return handleImageProxy(request, url, ctx);
  }

  // Auto-generated blog posts — must be before the HTML pass-through guard
  if (url.pathname.startsWith("/generated/")) {
    return handleGeneratedPost(request, env, ctx, url);
  }

  // Generated sitemap listing all 366 /generated/ pages
  if (url.pathname === "/sitemap-generated.xml") {
    const siteUrl = `${url.protocol}//${url.host}`;
    return new Response(serveGeneratedSitemap(siteUrl), {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=3600, s-maxage=86400",
      },
    });
  }

  // Only handle requests for the root path or /index.html
  // Pass through all other requests (e.g., for JS, CSS, images) directly to the origin
  if (
    url.pathname !== "/" &&
    url.pathname !== "/index.html" &&
    url.pathname !== "/manifest.json"
  ) {
    return fetch(request);
  }

  if (url.pathname === "/manifest.json") {
    const manifestContent = {
      name: "This Day in History",
      short_name: "ThisDay",
      description:
        "Explore historical events, milestones, and notable figures from past and present. Discover what happened today in history. Browse by date and learn about wars, inventions, discoveries, and the lives of notable people. Make history come alive - one day at a time.",
      version: "1.0.0",
      start_url: "/",
      display: "standalone",
      background_color: "#2c3e50",
      theme_color: "#2c3e50",
      orientation: "any",
      scope: "/",
      lang: "en",
      icons: [
        {
          src: "icons/icon-72x72.png",
          sizes: "72x72",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "icons/icon-96x96.png",
          sizes: "96x96",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "icons/icon-128x128.png",
          sizes: "128x128",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "icons/icon-144x144.png",
          sizes: "144x144",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "icons/icon-152x152.png",
          sizes: "152x152",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "icons/icon-192x192.png",
          sizes: "192x192",
          type: "image/png",
          purpose: "any maskable",
        },
        {
          src: "icons/icon-384x384.png",
          sizes: "384x384",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "icons/icon-512x512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "any maskable",
        },
      ],
      categories: ["education", "reference", "history"],
      screenshots: [
        {
          src: "screenshots/desktop.png",
          sizes: "1280x720",
          type: "image/png",
          form_factor: "wide",
        },
        {
          src: "screenshots/mobile.png",
          sizes: "540x720",
          type: "image/png",
          form_factor: "narrow",
        },
      ],
    };
    return new Response(JSON.stringify(manifestContent), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const today = new Date(); // Current date (at Cloudflare edge)
  const isoDateKey = today.toISOString().split("T")[0]; // e.g. "2026-02-17"
  const todayKvKey = `today-events-${isoDateKey}`; // Date-specific key prevents stale cross-day data

  // 1. Try to get events data from KV first
  let eventsData;
  try {
    const cachedKvData = await env.EVENTS_KV.get(todayKvKey, { type: "json" });
    if (cachedKvData) {
      eventsData = cachedKvData;
      console.log("KV Cache HIT for today's events!");
    } else {
      // 2. If not in KV, fetch it now and update KV (this means KV wasn't pre-populated yet)
      console.log(
        "KV Cache MISS for today's events, fetching live and populating KV...",
      );
      eventsData = await fetchDailyEvents(today);
      // Queue KV write without blocking — handled after response is sent
      if (eventsData && eventsData.events && eventsData.events.length > 0) {
        ctx.waitUntil(
          env.EVENTS_KV.put(todayKvKey, JSON.stringify(eventsData), {
            expirationTtl: KV_CACHE_TTL_SECONDS,
          }),
        );
        console.log("KV update queued (non-blocking).");
      }
    }
  } catch (kvError) {
    console.error("Error accessing KV. Falling back to live fetch:", kvError);
    eventsData = await fetchDailyEvents(today); // Fallback to live fetch on KV error
  }

  // Prepare dynamic meta tags and content based on fetched data
  let dynamicDescription =
    "Explore historical events, milestones, and notable figures from any date. Dive into history with this interactive calendar.";
  let dynamicKeywords =
    "thisDay, historical events, on this day, history, daily highlights, calendar, famous birthdays, anniversaries, notable deaths, world history, today in history, history, educational, timeline, trivia, historical figures";
  let dynamicTitle =
    "thisDay. | What Happened on This Day? | Historical Events";
  let ogImageUrl = "https://thisday.info/images/logo.png"; // Default fallback image
  const ogUrl = "https://thisday.info/"; // Canonical URL

  // Format the date for the title and description
  const options = { month: "long", day: "numeric" };
  const formattedDate = today.toLocaleDateString("en-US", options); // e.g., "July 12"
  const isoDate = today.toISOString().split("T")[0]; // e.g., "2025-07-12"

  if (eventsData && eventsData.events && eventsData.events.length > 0) {
    // Use the first event's Wikipedia thumbnail for social sharing if available
    const firstWithImage = eventsData.events.find(
      (e) => e.pages?.[0]?.thumbnail?.source
    );
    if (firstWithImage) {
      const rawImgUrl = firstWithImage.pages[0].thumbnail.source;
      // Route through the image proxy: resizes to 1200px and caches at edge for 30 days
      ogImageUrl = `/img?src=${encodeURIComponent(rawImgUrl)}&w=1200&q=82`;
    }

    // Pick the top 3-5 events for a concise description
    const topEvents = eventsData.events
      .slice(0, 5)
      .map((event) => `In ${event.year}, ${event.text}`)
      .join("; ");

    const firstEventText = eventsData.events[0].text;
    const titleSnippet = firstEventText.length > 65
      ? firstEventText.substring(0, firstEventText.lastIndexOf(" ", 65)) + "..."
      : firstEventText;
    dynamicTitle = `On This Day, ${formattedDate}: ${eventsData.events[0].year}, ${titleSnippet} | thisDay.info`;

    const rawDesc = `Discover what happened on ${formattedDate}: ${topEvents}. Explore historical events, births, and deaths.`;
    dynamicDescription = rawDesc.length > 155
      ? rawDesc.substring(0, rawDesc.lastIndexOf(" ", 155)) + "..."
      : rawDesc;

    // Add relevant keywords from event texts (simple approach)
    const eventKeywords = eventsData.events
      .slice(0, 10)
      .flatMap((event) => event.text.split(" "))
      .filter((word) => word.length > 3 && /^[a-zA-Z]+$/.test(word)) // Basic filter
      .map((word) => word.toLowerCase())
      .filter((value, index, self) => self.indexOf(value) === index) // Unique words
      .slice(0, 20) // Limit to top 20
      .join(", ");
    dynamicKeywords = `${dynamicKeywords}, ${eventKeywords}`;
  }

  // Fetch the original index.html from the origin server
  const originalResponse = await fetch(url.origin, request);
  let contentType = originalResponse.headers.get("content-type") || "";

  // Only apply transformations to HTML responses
  if (!contentType.includes("text/html")) {
    return originalResponse;
  }

  const rewriter = new HTMLRewriter()
    // --- Meta Tags and Title ---
    .on("title", {
      element(element) {
        element.setInnerContent(dynamicTitle);
      },
    })
    .on("meta[name='description']", {
      element(element) {
        element.setAttribute("content", dynamicDescription);
      },
    })
    .on("meta[name='keywords']", {
      element(element) {
        element.setAttribute("content", dynamicKeywords);
      },
    })
    .on("meta[property='og:title']", {
      element(element) {
        element.setAttribute("content", dynamicTitle);
      },
    })
    .on("meta[property='og:description']", {
      element(element) {
        element.setAttribute("content", dynamicDescription);
      },
    })
    .on("meta[property='og:image']", {
      element(element) {
        element.setAttribute("content", ogImageUrl);
      },
    })
    .on("meta[property='og:url']", {
      element(element) {
        element.setAttribute("content", ogUrl);
      },
    })
    .on("meta[property='og:type']", {
      element(element) {
        element.setAttribute("content", "website");
      },
    })
    .on("meta[name='twitter:card']", {
      element(element) {
        element.setAttribute("content", "summary_large_image");
      },
    })
    .on("meta[name='twitter:title']", {
      element(element) {
        element.setAttribute("content", dynamicTitle);
      },
    })
    .on("meta[name='twitter:description']", {
      element(element) {
        element.setAttribute("content", dynamicDescription);
      },
    })
    .on("meta[name='twitter:image']", {
      element(element) {
        element.setAttribute("content", ogImageUrl);
      },
    })
    .on("meta[property='og:image:alt']", {
      element(element) {
        element.setAttribute("content", dynamicTitle);
      },
    })
    .on("meta[property='og:image:width']", {
      element(element) {
        element.setAttribute("content", "1200");
      },
    })
    .on("meta[property='og:image:height']", {
      element(element) {
        element.setAttribute("content", "630");
      },
    });

  // Inject preloaded data for the current day into the HTML
  if (eventsData && eventsData.events && eventsData.events.length > 0) {
    const initialEventsForClient = eventsData.events.slice(0, 20); // Limit data
    const initialBirthsForClient = eventsData.births
      ? eventsData.births.slice(0, 10)
      : [];
    const initialDeathsForClient = eventsData.deaths
      ? eventsData.deaths.slice(0, 10)
      : [];

    const preloadedData = {
      events: initialEventsForClient,
      births: initialBirthsForClient,
      deaths: initialDeathsForClient,
    };
    const jsonData = JSON.stringify(preloadedData);

    rewriter.on("head", {
      element(element) {
        // --- Inject Preloaded Data for Client-Side JS ---
        element.append(
          `<script id="preloaded-today-events" type="application/json">${jsonData}</script>`,
          { html: true },
        );

        // --- Main WebPage Schema with Events Collection ---
        const webPageSchema = {
          "@context": "https://schema.org",
          "@type": "WebPage",
          name: dynamicTitle,
          description: dynamicDescription,
          url: ogUrl,
          datePublished: isoDate,
          dateModified: isoDate,
          isPartOf: {
            "@type": "WebSite",
            name: "thisDay.info",
            url: "https://thisday.info/",
            description:
              "Explore historical events, milestones, and notable figures from any date",
            publisher: {
              "@type": "Organization",
              name: "thisDay.info",
              url: "https://thisday.info/",
            },
          },
          potentialAction: {
            "@type": "SearchAction",
            target: {
              "@type": "EntryPoint",
              urlTemplate: "https://thisday.info/?q={search_term_string}",
            },
            "query-input": "required name=search_term_string",
          },
          // Add mainEntity for primary content
          mainEntity: {
            "@type": "ItemList",
            name: `Historical Events on ${formattedDate}`,
            description: `Collection of historical events, births, and deaths that occurred on ${formattedDate}`,
            numberOfItems:
              (eventsData?.events?.length || 0) +
              (eventsData?.births?.length || 0) +
              (eventsData?.deaths?.length || 0),
          },
        };

        element.append(
          `<script type="application/ld+json">${JSON.stringify(
            webPageSchema,
          )}</script>`,
          { html: true },
        );

        // --- Consolidated Events Schema (limit to top events to avoid bloat) ---
        if (eventsData && eventsData.events && eventsData.events.length > 0) {
          // Create a consolidated events schema instead of individual ones
          const topEvents = eventsData.events.slice(0, 5); // Limit to top 5 events
          const eventsListSchema = {
            "@context": "https://schema.org",
            "@type": "ItemList",
            name: `Historical Events on ${formattedDate}`,
            description: `Major historical events that occurred on ${formattedDate} throughout history`,
            url: ogUrl,
            numberOfItems: topEvents.length,
            itemListElement: topEvents.map((eventItem, index) => {
              const locationName = extractLocationFromName(eventItem.text);
              const eventImage =
                eventItem.pages &&
                eventItem.pages.length > 0 &&
                eventItem.pages[0].thumbnail &&
                eventItem.pages[0].thumbnail.source
                  ? eventItem.pages[0].thumbnail.source
                  : undefined;

              return {
                "@type": "ListItem",
                position: index + 1,
                item: {
                  "@type": "Event",
                  name:
                    eventItem.text.length > 100
                      ? eventItem.text.substring(0, 100) + "..."
                      : eventItem.text,
                  startDate: `${eventItem.year}-${String(
                    today.getMonth() + 1,
                  ).padStart(2, "0")}-${String(today.getDate()).padStart(
                    2,
                    "0",
                  )}`,
                  description: eventItem.text,
                  // Temporal Coverage
                  temporalCoverage: eventItem.year.toString(),
                  // Location
                  location: {
                    "@type": "Place",
                    name: locationName,
                  },
                  // Image
                  ...(eventImage && { image: eventImage }),
                },
              };
            }),
          };

          element.append(
            `<script type="application/ld+json">${JSON.stringify(
              eventsListSchema,
            )}</script>`,
            { html: true },
          );
        }

        // --- Notable People Schema (Births - limit to top 3) ---
        if (eventsData?.births && eventsData.births.length > 0) {
          const topBirths = eventsData.births.slice(0, 3);
          const birthsListSchema = {
            "@context": "https://schema.org",
            "@type": "ItemList",
            name: `Notable People Born on ${formattedDate}`,
            description: `Famous individuals born on ${formattedDate} throughout history`,
            url: ogUrl,
            numberOfItems: topBirths.length,
            itemListElement: topBirths.map((birthItem, index) => {
              // Better name parsing - handle cases like "Name, title" or "Name (profession)"
              const nameMatch = birthItem.text.match(/^([^,\(]+)/);
              const personName = nameMatch
                ? nameMatch[1].trim()
                : birthItem.text.split(",")[0].trim();
              const personImage =
                birthItem.pages &&
                birthItem.pages.length > 0 &&
                birthItem.pages[0].thumbnail &&
                birthItem.pages[0].thumbnail.source
                  ? birthItem.pages[0].thumbnail.source
                  : undefined;

              const wikiUrl =
                birthItem.pages && birthItem.pages.length > 0 && birthItem.pages[0].content_urls?.desktop?.page
                  ? birthItem.pages[0].content_urls.desktop.page
                  : ogUrl;

              return {
                "@type": "ListItem",
                position: index + 1,
                item: {
                  "@type": "Person",
                  name: personName,
                  birthDate: `${birthItem.year}-${String(
                    today.getMonth() + 1,
                  ).padStart(2, "0")}-${String(today.getDate()).padStart(
                    2,
                    "0",
                  )}`,
                  description: birthItem.text,
                  url: wikiUrl,
                  // Add additional context if available
                  ...(birthItem.pages &&
                    birthItem.pages.length > 0 && {
                      sameAs: [
                        `https://en.wikipedia.org/wiki/${encodeURIComponent(
                          birthItem.pages[0].title.replace(/ /g, "_"),
                        )}`,
                      ],
                    }),
                  // Image for Person if available
                  ...(personImage && { image: personImage }),
                },
              };
            }),
          };

          element.append(
            `<script type="application/ld+json">${JSON.stringify(
              birthsListSchema,
            )}</script>`,
            { html: true },
          );
        }

        // --- Deaths Schema (limit to top 3) ---
        if (eventsData?.deaths && eventsData.deaths.length > 0) {
          const topDeaths = eventsData.deaths.slice(0, 3);
          const deathsListSchema = {
            "@context": "https://schema.org",
            "@type": "ItemList",
            name: `Notable People Who Died on ${formattedDate}`,
            description: `Famous individuals who died on ${formattedDate} throughout history`,
            url: ogUrl,
            numberOfItems: topDeaths.length,
            itemListElement: topDeaths.map((deathItem, index) => {
              const nameMatch = deathItem.text.match(/^([^,\(]+)/);
              const personName = nameMatch
                ? nameMatch[1].trim()
                : deathItem.text.split(",")[0].trim();
              const personImage =
                deathItem.pages &&
                deathItem.pages.length > 0 &&
                deathItem.pages[0].thumbnail &&
                deathItem.pages[0].thumbnail.source
                  ? deathItem.pages[0].thumbnail.source
                  : undefined;

              const wikiUrl =
                deathItem.pages && deathItem.pages.length > 0 && deathItem.pages[0].content_urls?.desktop?.page
                  ? deathItem.pages[0].content_urls.desktop.page
                  : ogUrl;

              return {
                "@type": "ListItem",
                position: index + 1,
                item: {
                  "@type": "Person",
                  name: personName,
                  deathDate: `${deathItem.year}-${String(
                    today.getMonth() + 1,
                  ).padStart(2, "0")}-${String(today.getDate()).padStart(
                    2,
                    "0",
                  )}`,
                  description: deathItem.text,
                  url: wikiUrl,
                  // Add Wikipedia link if available
                  ...(deathItem.pages &&
                    deathItem.pages.length > 0 && {
                      sameAs: [
                        `https://en.wikipedia.org/wiki/${encodeURIComponent(
                          deathItem.pages[0].title.replace(/ /g, "_"),
                        )}`,
                      ],
                    }),
                  // Image for Person if available
                  ...(personImage && { image: personImage }),
                },
              };
            }),
          };

          element.append(
            `<script type="application/ld+json">${JSON.stringify(
              deathsListSchema,
            )}</script>`,
            { html: true },
          );
        }

        // --- Add Breadcrumb Schema ---
        const breadcrumbSchema = {
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            {
              "@type": "ListItem",
              position: 1,
              name: "Home",
              item: "https://thisday.info/",
            },
            {
              "@type": "ListItem",
              position: 2,
              name: `${formattedDate} in History`,
              item: ogUrl,
            },
          ],
        };

        element.append(
          `<script type="application/ld+json">${JSON.stringify(
            breadcrumbSchema,
          )}</script>`,
          { html: true },
        );

        // --- Add FAQ Schema if you have common questions ---
        const faqSchema = {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: [
            {
              "@type": "Question",
              name: `What happened on ${formattedDate}?`,
              acceptedAnswer: {
                "@type": "Answer",
                text: dynamicDescription,
              },
            },
            {
              "@type": "Question",
              name: "How do I find historical events for other dates?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Use the interactive calendar on thisDay.info to navigate to any month and day. Click a day card to see all events, births, and deaths that occurred on that date throughout history.",
              },
            },
            {
              "@type": "Question",
              name: "Where does thisDay.info get its historical data?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "All historical event data is sourced from Wikipedia via the Wikimedia REST API. Each event links directly to its Wikipedia article for further reading.",
              },
            },
            {
              "@type": "Question",
              name: `Who was born on ${formattedDate}?`,
              acceptedAnswer: {
                "@type": "Answer",
                text: eventsData?.births?.length > 0
                  ? `Notable people born on ${formattedDate} include: ${eventsData.births.slice(0, 3).map(b => b.text.split(",")[0]).join(", ")}. Browse the full list on thisDay.info.`
                  : `Explore thisDay.info to discover notable people born on ${formattedDate} throughout history.`,
              },
            },
            {
              "@type": "Question",
              name: "Is thisDay.info free to use?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Yes, thisDay.info is completely free. Explore historical events, famous birthdays, and notable deaths for any date without any registration or subscription.",
              },
            },
          ],
        };

        element.append(
          `<script type="application/ld+json">${JSON.stringify(
            faqSchema,
          )}</script>`,
          { html: true },
        );

        // --- Inject today's generated URL so the carousel can link internally ---
        const mn = MONTHS_ALL[today.getMonth()];
        const dd = today.getDate();
        element.append(
          `<script>window.__todayGeneratedUrl="/generated/${mn}/${dd}/";</script>`,
          { html: true },
        );
      },
    });
  }

  // Transform the response
  const transformedResponse = rewriter.transform(originalResponse);

  // Clone the response to modify headers
  const newResponse = new Response(
    transformedResponse.body,
    transformedResponse,
  );

  // --- Add Security Headers ---

  // X-Content-Type-Options: nosniff - Prevents browsers from MIME-sniffing a response away from the declared Content-Type.
  newResponse.headers.set("X-Content-Type-Options", "nosniff");

  // Strict-Transport-Security (HSTS) - ONLY if your site is always HTTPS.
  // This tells browsers to only connect via HTTPS for a given duration, preventing downgrade attacks.
  // Be very careful with this; if you ever revert to HTTP, users might be locked out for max-age duration.
  newResponse.headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains; preload",
  );

  // Content-Security-Policy (CSP) - Most comprehensive.
  // This needs to be carefully crafted based on ALL resources your site uses (scripts, styles, images, fonts, etc.).
  // Incorrect CSP can break your site. Review and refine this based on your actual site's needs.
  // - default-src 'none': Blocks everything by default, forcing explicit allowance.
  // - connect-src: Allows connections to your domain ('self') and the Wikipedia API.
  // - script-src: Allows scripts from your domain ('self') and jsDelivr CDN (for Bootstrap/jQuery).
  // - style-src: Allows styles from your domain ('self'), jsDelivr CDN, and 'unsafe-inline' for any inline <style> tags or style attributes.
  // - img-src: Allows images from your domain ('self'), data URIs (for inline images), and Wikipedia (for event images).
  // - font-src: Allows fonts from your domain ('self') and jsDelivr CDN.
  // - base-uri 'self': Restricts the URLs that can be used in <base> elements.
  // - frame-ancestors 'none': Specifically for ClickJacking prevention (prevents embedding your site in iframes).
  // - object-src 'none': Prevents embedding <object>, <embed>, or <applet> elements.
  const csp =
    `default-src 'none'; ` +
    `connect-src 'self' https://api.wikimedia.org https://www.google-analytics.com https://www.google.com https://www.gstatic.com https://www.googleadservices.com https://pagead2.googlesyndication.com https://*.adtrafficquality.google https://cdn.jsdelivr.net; ` +
    `script-src 'self' https://cdn.jsdelivr.net https://consent.cookiebot.com https://www.googletagmanager.com https://www.googleadservices.com https://googleads.g.doubleclick.net https://pagead2.googlesyndication.com https://static.cloudflareinsights.com https://*.adtrafficquality.google 'unsafe-inline'; ` +
    `style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; ` +
    `img-src 'self' data: https://upload.wikimedia.org https://cdn.buymeacoffee.com https://imgsct.cookiebot.com https://www.google.com https://www.google.ba https://www.googleadservices.com https://pagead2.googlesyndication.com https://placehold.co https://www.googletagmanager.com https://i.ytimg.com; ` +
    `font-src 'self' https://cdn.jsdelivr.net https://fonts.gstatic.com; ` +
    `frame-src https://consentcdn.cookiebot.com https://td.doubleclick.net https://www.googletagmanager.com https://www.google.com https://www.youtube.com https://googleads.g.doubleclick.net; ` +
    `manifest-src 'self'; ` +
    `base-uri 'self'; ` +
    `frame-ancestors 'none'; ` +
    `object-src 'none';`;
  newResponse.headers.set("Content-Security-Policy", csp);

  // X-Frame-Options: DENY - Also for ClickJacking protection. Redundant if CSP frame-ancestors 'none' is used, but good for older browsers.
  newResponse.headers.set("X-Frame-Options", "DENY");

  // Referrer-Policy - controls what referrer info is sent with outbound requests
  newResponse.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  // Permissions-Policy - disable browser features the site doesn't use
  newResponse.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  );

  // Cache-Control - allow CDN/edge to cache transformed HTML for 1 hour, serve stale for 24h while revalidating
  newResponse.headers.set(
    "Cache-Control",
    "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
  );

  // Vary - tell proxies/CDNs this response varies by encoding, ensuring compressed variants are cached separately
  newResponse.headers.set("Vary", "Accept-Encoding");

  return newResponse;
}

// --- Scheduled Event Handler (Cron Trigger) ---
async function handleScheduledEvent(env) {
  console.log("Scheduled event triggered: Pre-fetching today's events to KV.");
  const today = new Date();
  const isoDateKey = today.toISOString().split("T")[0];
  const todayKvKey = `today-events-${isoDateKey}`;
  const eventsData = await fetchDailyEvents(today);

  if (eventsData && eventsData.events && eventsData.events.length > 0) {
    try {
      await env.EVENTS_KV.put(todayKvKey, JSON.stringify(eventsData), {
        expirationTtl: KV_CACHE_TTL_SECONDS,
      });
      console.log(`Successfully pre-fetched and stored events for ${isoDateKey} in KV.`);
    } catch (e) {
      console.error("Failed to put data into KV:", e);
    }
  } else {
    console.warn("No events data fetched, not updating KV.");
  }
}

// --- Worker Entry Point (ES Module Format) ---
export default {
  async fetch(request, env, ctx) {
    return handleFetchRequest(request, env, ctx);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(handleScheduledEvent(env));
  },
};
