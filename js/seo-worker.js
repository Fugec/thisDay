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
  const econ = /bank|stock market|recession|depression|financial crisis|bankruptcy|currency|inflation|trade|tariff|crash|bubble|debt|deficit|gdp|economy|market/.test(t);
  const sport = /olympic|championship|world cup|tournament|record|gold medal|title|final|super bowl|grand slam|marathon|formula|athlete/.test(t);

  const era =
    y < 500  ? "ancient"      :
    y < 1400 ? "medieval"     :
    y < 1700 ? "early_modern" :
    y < 1900 ? "modern"       : "contemporary";

  if (war) {
    // Sub-categories within war for more connected commentary
    const isSiege      = /siege|besieg|surrounded|fortif|garrison|blockade|starv/.test(t);
    const isNaval      = /naval|fleet|ship|sea battle|maritime|admiral|frigate|armada/.test(t);
    const isLiberation = /liberat|resist|partisan|guerrilla|occupied|underground|freed/.test(t);
    const isAttrition  = /world war|trench|western front|eastern front|million|casualties|stalemate/.test(t);
    const isCivilWar   = /civil war|civil conflict|secession|rebel|faction|brother against/.test(t);
    const isSurrender  = /surrender|capitulat|armistice|ceasefire|truce|ended|concluded|peace/.test(t);
    const isAerial     = /bombing|air raid|aerial|blitz|airforce|aircraft|bomb|drone|air strike/.test(t);

    if (isSiege) return [
      "Sieges reduced warfare to its starkest arithmetic: the rate at which defenders consumed supplies versus the patience and resources of those outside the walls. Starvation and disease killed as reliably as any weapon.",
      "A successful siege required controlling the surrounding territory, maintaining reliable supply lines, and sustaining political will across months or even years. These were rarely guaranteed — many sieges collapsed not through military defeat but through the besieger's own logistical failures.",
      "For civilians trapped inside, the siege was not a military calculation but a daily question of survival — who controlled the food, who maintained order, and whether the walls could hold long enough for relief to arrive.",
    ];
    if (isNaval) return [
      "Naval power has always been primarily about logistics: the ability to project force, protect trade routes, and deny the same to an opponent. Battles at sea decided not just military outcomes but the economic fate of empires.",
      "A naval engagement concentrated enormous irreplaceable capital — ships, trained crews, experienced officers — into a few hours of chaotic violence. Fleets built over decades could be destroyed in a single afternoon.",
      "Control of the sea never guaranteed control of everything, but losing it tended to mean losing most things eventually. Maritime supremacy has consistently translated into commercial and strategic advantage in ways that land power alone could not replicate.",
    ];
    if (isLiberation) return [
      "Resistance movements rarely succeed through armed force alone. The combination of sustained guerrilla action, international pressure, the political delegitimization of the occupying power, and the mounting cost of repression tends to determine outcomes more than any single engagement.",
      "Occupation reshapes societies in ways that outlast the occupation itself. Identity hardens, collaboration becomes a lasting moral category, and the politics of the post-liberation period are defined by who resisted, who accommodated, and under what circumstances.",
      "What gets called liberation looks different depending on where you stand. The formal removal of an occupying power rarely resolves the underlying questions of who governs next, on whose behalf, and with what legitimacy.",
    ];
    if (isAttrition) return [
      "Industrial-scale warfare transformed conflict from a contest of tactics and leadership into a problem of production and endurance. The side that could sustain losses longest — in material, in manpower, in political will — tended to prevail, regardless of battlefield skill.",
      "Mass mobilization reshaped societies as profoundly as the fighting itself. Economies were restructured, gender roles disrupted, political compacts renegotiated. A society that entered a total war rarely emerged with its internal arrangements intact.",
      "The arithmetic of attrition was visible to everyone in real time, which is what made it so politically corrosive. Governments that could not explain why the losses were worth the gains eventually faced a crisis of legitimacy as dangerous as any military setback.",
    ];
    if (isCivilWar) return [
      "Civil wars are distinguished from other conflicts by who the enemy is: not a foreign power but a neighbour, a former ally, sometimes a family member. That proximity produces a particular kind of violence — intimate, difficult to end, and long-remembered.",
      "The causes of civil war are almost always multiple and contested. Economic inequality, ethnic or religious divisions, disputed legitimacy, and the collapse of institutions capable of managing disagreement tend to combine rather than act in isolation. Single-cause explanations come later, from the winners.",
      "Civil wars rarely end cleanly. The formal conclusion of fighting is followed by years of contested reconstruction — who gets to write the history, which grievances are acknowledged, and how the losing side is reintegrated into a shared political life. These questions prove at least as difficult as the war itself.",
    ];
    if (isSurrender) return [
      "Surrenders are often the moment when the real negotiation begins. The terms imposed on the defeated — reparations, territorial loss, political reorganization — shape the next generation's grievances as surely as the fighting shaped this one.",
      "The decision to stop fighting requires someone with authority to make it and the political standing to enforce it. Armies that refuse to accept the reality of defeat, or governments that collapse before surrender can be formalized, tend to produce prolonged and chaotic aftermaths.",
      "What the armistice ends is the shooting. What it does not end is the underlying conflict of interests, identities, and claims that produced the war. The durability of any peace depends on how seriously those deeper questions are addressed — a test that many ceasefires fail.",
    ];
    if (isAerial) return [
      "Aerial warfare added a dimension that fundamentally changed what it meant to be a civilian in wartime. The front line disappeared; distance from the fighting no longer offered safety. Cities, factories, and populations became legitimate targets under doctrines that were being improvised in real time.",
      "Strategic bombing promised to end wars quickly by destroying an enemy's will and capacity to fight from the air. The evidence for its effectiveness has always been contested — civilian populations proved more resilient than theorists predicted, and the economic disruption less decisive than promised.",
      "The moral framework for aerial warfare has never been fully resolved. The same technology used to deliver humanitarian aid can deliver ordnance. Drones, precision munitions, and autonomous systems have shifted the calculus again, raising questions that the laws of war — written for earlier technologies — struggle to answer.",
    ];

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
    // Sub-categories within science for more connected commentary
    const isSpace      = /space|orbit|satellite|rocket|moon|mars|astronaut|cosmonaut|shuttle|spacecraft|launch pad/.test(t);
    const isMedical    = /vaccine|medicine|disease|cure|surgery|antibiotic|virus|epidemic|dna|gene|genome|transplant/.test(t);
    const isPhysics    = /atom|nuclear|quantum|relativity|particle|radiation|element|periodic|chemistry|fission|fusion/.test(t);
    const isComputing  = /computer|software|internet|algorithm|digital|program|data|network|code|processor|artificial intelligence/.test(t);
    const isAstronomy  = /comet|asteroid|star|planet|galaxy|nebula|eclipse|celestial|constellation|telescope|observatory/.test(t);
    const isEnv        = /climate|pollution|environment|ecosystem|conservation|species|extinction|carbon|deforestation|ozone/.test(t);
    const isMath       = /mathemati|theorem|proof|calculus|algebra|geometry|statistics|cipher|equation|formula|number/.test(t);

    if (isSpace) return [
      "Space exploration demands solving problems at the absolute edge of what materials, mathematics, and human physiology can withstand. Every successful mission represents the convergence of thousands of engineering decisions, each of which had to be right.",
      "The political dimensions of space programs have always matched their scientific ones. National prestige, military capability signals, and the projection of technological power drove funding and timelines as forcefully as the pursuit of knowledge.",
      "What space exploration changed most durably was human self-perception. Seeing Earth from outside it — as a single, fragile object against an indifferent darkness — produced a shift in perspective that no purely terrestrial experience could replicate.",
    ];
    if (isMedical) return [
      "Medical progress rarely arrives as a clean breakthrough. It accumulates through decades of failure, partial understanding, and contested results — punctuated occasionally by discoveries that genuinely restructure everything that came before and after them.",
      "The gap between what medicine can do and what it actually delivers has always been one of the defining inequalities of every era. A treatment proven effective in one setting may be inaccessible, unaffordable, or contested in another. Discovery and access are separate problems.",
      "Disease has altered the course of history in ways that armies and diplomacy could not. Pathogens do not respect borders, social hierarchies, or military formations. Understanding this link between medicine and power is inseparable from understanding history itself.",
    ];
    if (isPhysics) return [
      "Discoveries at the fundamental level of physics have a habit of producing consequences that appear only decades later. The theoretical insights of one generation become the technological infrastructure of the next — and the ethical frameworks for managing them typically arrive last.",
      "Nuclear and quantum physics revealed that the universe operates by rules radically different from everyday experience. This created both extraordinary power and extraordinary conceptual difficulty — a science whose implications even its creators spent years working to understand.",
      "The institutional structures of modern science — large international collaborations, government-funded research, peer review at scale — were largely built around the demands of physics. In shaping how science is organized, the discipline reshaped the entire enterprise of knowledge-making.",
    ];
    if (isComputing) return [
      "Computing technology accelerated through a feedback loop: each generation of hardware enabled the development of the next, compressing decades of expected progress into years. The pace consistently outran the ability of legal, educational, and social institutions to adapt.",
      "The internet restructured the fundamental economics of information. When copying and distributing knowledge approaches zero cost, the industries and power structures built on controlling its scarcity face questions they were not designed to answer.",
      "What computing changed most profoundly was not any specific industry but the underlying assumption about what could be automated, optimized, and quantified. That assumption continues expanding into domains — creativity, judgment, interpersonal trust — that once seemed safely beyond its reach.",
    ];
    if (isAstronomy) return [
      "Astronomy has always occupied an unusual position in the hierarchy of sciences: its objects of study are entirely inaccessible, observable only at a distance measured in light-years, yet the patterns they reveal have structured timekeeping, navigation, and human self-understanding since the earliest civilizations.",
      "Each step outward in scale — from solar system to galaxy to observable universe — has required revising not just measurements but foundational assumptions about where we are and what we are made of. The universe turned out to be far older, larger, and stranger than anyone's first guess.",
      "Modern astronomy is fundamentally collaborative in a way few disciplines match. Telescopes span continents; data is shared across borders; discoveries arrive not through individual genius but through networked observation and computation. The romantic image of the lone astronomer at the eyepiece describes almost nothing about how the field actually works.",
    ];
    if (isEnv) return [
      "Environmental history reframes the standard narrative of progress by asking what was lost — ecologically, biologically, climatically — in the process of producing what we typically count as gains. The accounting looks considerably different when the costs are included.",
      "Ecosystems do not register political borders. A species extinction, an aquifer depleted, a river system dammed — these changes propagate across boundaries in ways that no single government is positioned to fully manage. The mismatch between the scale of environmental problems and the scale of political institutions is one of the central dilemmas of the modern era.",
      "The pace of environmental change in the industrial period has no precedent in human history and few in geological time. What makes this moment unusual is not that nature is changing — it always has — but that the driver of change is now the cumulative weight of human activity, and the timeline for consequences is measured in decades rather than millennia.",
    ];
    if (isMath) return [
      "Mathematics is unusual among intellectual disciplines in that its results, once proven, do not become obsolete. A theorem established two thousand years ago requires no revision when new evidence arrives — the proof either holds or it doesn't, and if it holds, it holds permanently.",
      "Mathematical structures discovered in purely abstract contexts have a persistent habit of turning out to describe physical reality with uncanny precision — often decades or centuries after the original work. This relationship between abstract reasoning and the behaviour of the physical world remains philosophically puzzling.",
      "The history of mathematics is also a history of expanding the concept of number itself: from counting integers to fractions, to irrational and imaginary numbers, to infinities of different sizes. Each expansion felt, to contemporaries, like a violation of common sense — and each eventually became indispensable.",
    ];

    if (era === "ancient" || era === "medieval") return [
      "In the ancient and medieval world, scientific inquiry was inseparable from philosophy and theology. Observation of the natural world was a form of reading a divine text — each pattern in the stars or in the body a reflection of a larger cosmic order.",
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

  if (pol) {
    // Sub-categories within politics so commentary matches the actual event type
    const isElection     = /election|vote|ballot|elected|campaign|referendum|suffrage|polling/.test(t);
    const isTreaty       = /treaty|accord|agreement|peace|diplomatic|negotiat|ceasefire|armistice/.test(t);
    const isRevolution   = /revolution|independence|uprising|coup|overthrow|liberat|rebel|proclaimed/.test(t);
    const isAssassination = /assassin|murder|killed|shot|executed|impeach/.test(t);
    const isLegislation  = /constitution|legislation|bill|charter|amendment|decree|enacted|signed into law/.test(t);

    if (isElection) return [
      "Elections are democracy's recurring proof of concept — contested, imperfect, and still the most reliable mechanism humanity has produced for transferring power without immediate violence.",
      "The outcome of any election is shaped by forces that begin years before polling day: demographic shifts, economic anxieties, media narratives, and the accumulated weight of earlier decisions. The ballot box measures a political moment, not just an individual preference.",
      "History judges elections not only by who won, but by what became possible — or permanently foreclosed — because of them. The full consequences of a particular result are rarely visible on election night.",
    ];
    if (isTreaty) return [
      "Treaties are political documents dressed as resolutions. What they commit to on paper and what they produce in practice are rarely identical — the gap between the two is where much of the subsequent history tends to unfold.",
      "Every peace agreement encodes the power imbalance of the moment it was signed. Those who negotiated from weakness rarely secured terms that held indefinitely. The seeds of the next conflict are almost always present in the language of the settlement.",
      "The durability of any treaty depends less on its wording than on whether the conditions that produced the original conflict have genuinely changed — a question that no signature alone can answer.",
    ];
    if (isRevolution) return [
      "Revolutions are rarely as sudden as they appear. The conditions that make them possible — accumulated grievances, weakened institutions, competing claims to legitimacy — build over years before a single event transforms long-standing tension into open rupture.",
      "Every revolution produces a gap between what it promised and what it delivers. The ideals of the opening phase are typically constrained by the practical pressures of consolidation, when the question shifts from 'what do we want?' to 'how do we hold this together?'",
      "What makes a revolutionary moment historically decisive is not simply that it changed who held power, but whether it changed the underlying rules by which power could be held, challenged, and transferred. By that measure, the verdict on most revolutions takes generations to reach.",
    ];
    if (isAssassination) return [
      "Political violence aimed at individuals rarely eliminates the ideas those individuals represented. Assassinations tend to accelerate the forces they aimed to stop — converting people into symbols and grievances into movements with longer half-lives than the original.",
      "The aftermath of a political killing reveals far more about a society than the act itself. How institutions respond, whether successor governments are strengthened or destabilized, and whether the act achieves its intended effect — these are the real historical questions.",
      "The counterfactual is irresistible but ultimately unanswerable: would history have unfolded differently had the individual survived? More revealing is the question of what conditions made such an outcome possible in the first place.",
    ];
    if (isLegislation) return [
      "Laws are not self-executing. A constitution can articulate rights that exist nowhere in practice; legislation can transform a society or gather dust depending entirely on whether the political will that produced it survives the moment of passage.",
      "The language of law is always a compromise — an attempt to build a durable framework from competing interests and predictions about the future that will inevitably prove partly wrong. The meaning of any law continues to shift as the circumstances it was written for change.",
      "Constitutional moments feel more decisive at the time than they often prove to be. What determines their legacy is whether the institutions built around them are strong enough to hold when the document is tested — as it always eventually is.",
    ];

    // General political fallback
    return [
      y < 1800
        ? "Political power in this era was deeply personal. Constitutions and treaties were essentially agreements between powerful individuals — the interests of ordinary people were largely absent from the political calculus, because ordinary people were largely absent from political life."
        : "Political decisions that shape generations are rarely made with clear visibility into their long-term consequences. Those in power respond to immediate pressures — the long view is a luxury that the moment rarely permits.",
      y < 1800
        ? "The concepts we now treat as foundational to governance — popular sovereignty, individual rights, the separation of powers — were radical ideas in this period, held by a small and often persecuted minority at the fringes of political thought."
        : "Every political settlement eventually generates the conditions for its own renegotiation. What one era treats as a permanent arrangement, the next often treats as a grievance.",
      "The political structures that shape daily life today were built through specific compromises, under specific pressures, by people who could not anticipate what came after. History could plausibly have produced very different arrangements — and very nearly did.",
    ];
  }

  if (econ) return [
    "Economic crises have a way of revealing, very quickly, which elements of a financial system were more fragile than they appeared. The mechanisms that work smoothly during expansion — leverage, interconnection, confidence — amplify losses with equal efficiency on the way down.",
    "Markets are built on expectations about the future, which means they are built on collective psychology as much as on fundamentals. Confidence, once lost, tends to be slow to return and easy to shatter again. The narrative a society tells about its economy matters — sometimes as much as the underlying reality.",
    "The political consequences of economic crises consistently outlast the crises themselves. Governments that presided over financial collapses rarely survived them with their authority intact. The social strains produced by mass unemployment, lost savings, and deflated expectations tend to find political expression — not always in forms that democratic institutions can easily absorb.",
  ];

  if (sport) return [
    "Sporting achievement exists at the intersection of biological capacity, systematic training, and favorable circumstance — with the last element more consequential than athletic mythologies typically acknowledge. Champions are also products of access: to coaching, facilities, nutrition, and the freedom to specialize.",
    "Major sporting events have always served purposes beyond competition. They are displays of national prestige, commercial spectacles, diplomatic signals, and platforms for political statements — sometimes all simultaneously. The sport itself is embedded in a context that shapes everything from the schedule to the broadcast rights.",
    "Records exist to be broken, which is precisely what makes them useful as historical markers. Each time a presumed human limit is surpassed, the achievement recalibrates what the next generation believes is possible — a compounding effect that extends beyond sport into every domain where belief in possibility matters.",
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
  const kvKey = `gen-post-v2-${monthName}-${day}`;
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

  // Only cache to KV when we have actual events (avoids caching API failure responses)
  if (env.EVENTS_KV && (eventsData?.events?.length || 0) > 0) {
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

  // When no Wikipedia thumbnail was found, fall back to the dynamic OG image
  // worker which generates a branded SVG card with the date and event title.
  if (ogImageUrl === "https://thisday.info/images/logo.png") {
    ogImageUrl = `/og-image?title=${encodeURIComponent(dynamicTitle)}&date=${encodeURIComponent(formattedDate)}`;
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
    const initialEventsForClient = eventsData.events;
    const initialBirthsForClient = eventsData.births || [];
    const initialDeathsForClient = eventsData.deaths || [];

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

  // --- Resource Hints -------------------------------------------------------
  // Prepend preconnect / dns-prefetch tags to <head> so the browser opens
  // TCP/TLS connections to critical external domains as early as possible,
  // before the parser reaches those resources further down the page.
  rewriter.on("head", {
    element(element) {
      element.prepend(
        '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
        '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
        '<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>\n' +
        '<link rel="dns-prefetch" href="https://api.wikimedia.org">\n' +
        '<link rel="dns-prefetch" href="https://upload.wikimedia.org">\n' +
        '<link rel="dns-prefetch" href="https://www.googletagmanager.com">\n' +
        '<link rel="dns-prefetch" href="https://pagead2.googlesyndication.com">',
        { html: true },
      );
    },
  });

  // --- SSR Pre-render -------------------------------------------------------
  // Injects today's top 5 historical events as real HTML into #calendarGrid,
  // replacing the loading spinner. Crawlers that don't execute JavaScript
  // (or render slowly) can index meaningful text content instead of a spinner.
  //
  // For real users: script.js does `calendarGrid.innerHTML = ""` on line 636
  // when it renders the interactive calendar, cleanly replacing this content.
  if (eventsData && eventsData.events && eventsData.events.length > 0) {
    const ssrItems = eventsData.events
      .slice(0, 5)
      .map(
        (e) =>
          `<li class="mb-2"><b>${escapeHtml(String(e.year))}:</b> ${escapeHtml(e.text)}</li>`,
      )
      .join("");

    rewriter.on("#calendarGrid", {
      element(element) {
        element.setInnerContent(
          `<section class="p-4" aria-label="Today's events in history">\n` +
          `<h2 class="h5 mb-3">On This Day, ${escapeHtml(formattedDate)}</h2>\n` +
          `<ul class="list-unstyled mb-0">${ssrItems}</ul>\n` +
          `</section>`,
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
    `connect-src 'self' https://api.wikimedia.org https://www.google-analytics.com https://www.google.com https://www.gstatic.com https://www.googleadservices.com https://pagead2.googlesyndication.com https://*.adtrafficquality.google https://cdn.jsdelivr.net https://*.doubleclick.net https://fundingchoicesmessages.google.com https://www.googletagmanager.com; ` +
    `script-src 'self' https://cdn.jsdelivr.net https://consent.cookiebot.com https://www.googletagmanager.com https://www.googleadservices.com https://googleads.g.doubleclick.net https://pagead2.googlesyndication.com https://static.cloudflareinsights.com https://*.adtrafficquality.google https://fundingchoicesmessages.google.com 'unsafe-inline'; ` +
    `style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; ` +
    `img-src 'self' data: https://upload.wikimedia.org https://cdn.buymeacoffee.com https://imgsct.cookiebot.com https://www.google.com https://www.google.ba https://www.googleadservices.com https://pagead2.googlesyndication.com https://placehold.co https://www.googletagmanager.com https://i.ytimg.com https://*.adtrafficquality.google https://*.doubleclick.net; ` +
    `font-src 'self' https://cdn.jsdelivr.net https://fonts.gstatic.com; ` +
    `frame-src https://consentcdn.cookiebot.com https://td.doubleclick.net https://www.googletagmanager.com https://www.google.com https://www.youtube.com https://googleads.g.doubleclick.net https://*.adtrafficquality.google; ` +
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

  // HTTP Link header — browsers and CDNs act on preconnect hints in HTTP
  // headers before they even start parsing HTML, giving an extra head-start.
  newResponse.headers.set(
    "Link",
    [
      '<https://fonts.googleapis.com>; rel=preconnect',
      '<https://fonts.gstatic.com>; rel=preconnect; crossorigin',
      '<https://cdn.jsdelivr.net>; rel=preconnect; crossorigin',
      '<https://api.wikimedia.org>; rel=dns-prefetch',
    ].join(", "),
  );

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
