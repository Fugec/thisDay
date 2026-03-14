// This Cloudflare Worker dynamically injects SEO-friendly meta tags
// and preloads daily event data to improve the user experience on site.
// Adds various security headers to enhance protection.
// Injects Schema.org JSON-LD for better SEO.

// --- Configuration Constants ---
// Define a User-Agent for API requests to Wikipedia.
const WIKIPEDIA_USER_AGENT = "thisDay.info (kapetanovic.armin@gmail.com)";

const KV_CACHE_TTL_SECONDS = 24 * 60 * 60; // KV entry valid for 24 hours
const CF_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// --- Helper function to fetch daily events from Wikipedia API ---
async function fetchDailyEvents(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const apiUrl = `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/all/${month}/${day}`;

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
  const width = Math.min(
    parseInt(url.searchParams.get("w") || "1200", 10),
    2000,
  );
  const quality = Math.min(
    parseInt(url.searchParams.get("q") || "82", 10),
    100,
  );

  if (!src) return new Response("Missing src parameter", { status: 400 });

  let imageUrl;
  try {
    const decoded = decodeURIComponent(src);
    const parsed = new URL(decoded);
    if (!parsed.hostname.endsWith("wikimedia.org")) {
      return new Response("Forbidden: only Wikimedia images allowed", {
        status: 403,
      });
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
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};
const MONTH_DISPLAY_NAMES = [
  "",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTHS_ALL = [
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
];
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // Feb=29 to cover all possible dates

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

  const war =
    /war|battle|siege|invasion|conflict|defeat|victory|troops|army|military|combat/.test(
      t,
    );
  const sci =
    /discover|invent|launch|orbit|experiment|vaccine|gene|atom|microscope|telescope|theory|equation|element|laboratory/.test(
      t,
    );
  const pol =
    /treaty|signed|declared|constitution|independence|election|revolution|parliament|senate|congress|legislation/.test(
      t,
    );
  const expl =
    /expedition|voyage|navigator|circumnavigat|new world|explorer|coloniz|sailing|landed/.test(
      t,
    );
  const dis =
    /earthquake|hurricane|typhoon|tsunami|eruption|wildfire|flood|epidemic|pandemic|plague|famine|disaster|collapsed|shipwreck|covid|coronavirus|quarantine|lockdown|travel ban|public health/.test(
      t,
    );
  const art =
    /\bfilm\b|novel|painting|symphony|opera|theatre|theater|poem|published|premiered|literary|artist|composer|sculptor|architecture|museum/.test(
      t,
    );
  const rel =
    /church|cathedral|pope|bishop|crusade|mosque|temple|monastery|reformation|heresy|clergy|saint|protestant|catholic/.test(
      t,
    );
  const econ =
    /bank|stock market|recession|depression|financial crisis|bankruptcy|currency|inflation|trade|tariff|crash|bubble|debt|deficit|gdp|economy|market/.test(
      t,
    );
  const sport =
    /olympic|championship|world cup|tournament|record|gold medal|title|final|super bowl|grand slam|marathon|formula|athlete/.test(
      t,
    );

  const era =
    y < 500
      ? "ancient"
      : y < 1400
        ? "medieval"
        : y < 1700
          ? "early_modern"
          : y < 1900
            ? "modern"
            : "contemporary";

  if (war) {
    // Sub-categories within war for more connected commentary
    const isSiege =
      /siege|besieg|surrounded|fortif|garrison|blockade|starv/.test(t);
    const isNaval =
      /naval|fleet|ship|sea battle|maritime|admiral|frigate|armada/.test(t);
    const isLiberation =
      /liberat|resist|partisan|guerrilla|occupied|underground|freed/.test(t);
    const isAttrition =
      /world war|trench|western front|eastern front|million|casualties|stalemate/.test(
        t,
      );
    const isCivilWar =
      /civil war|civil conflict|secession|rebel|faction|brother against/.test(
        t,
      );
    const isSurrender =
      /surrender|capitulat|armistice|ceasefire|truce|ended|concluded|peace/.test(
        t,
      );
    const isAerial =
      /bombing|air raid|aerial|blitz|airforce|aircraft|bomb|drone|air strike/.test(
        t,
      );

    if (isSiege)
      return [
        "Sieges reduced warfare to its starkest arithmetic: the rate at which defenders consumed supplies versus the patience and resources of those outside the walls. Starvation and disease killed as reliably as any weapon.",
        "A successful siege required controlling the surrounding territory, maintaining reliable supply lines, and sustaining political will across months or even years. These were rarely guaranteed — many sieges collapsed not through military defeat but through the besieger's own logistical failures.",
        "For civilians trapped inside, the siege was not a military calculation but a daily question of survival — who controlled the food, who maintained order, and whether the walls could hold long enough for relief to arrive.",
      ];
    if (isNaval)
      return [
        "Naval power has always been primarily about logistics: the ability to project force, protect trade routes, and deny the same to an opponent. Battles at sea decided not just military outcomes but the economic fate of empires.",
        "A naval engagement concentrated enormous irreplaceable capital — ships, trained crews, experienced officers — into a few hours of chaotic violence. Fleets built over decades could be destroyed in a single afternoon.",
        "Control of the sea never guaranteed control of everything, but losing it tended to mean losing most things eventually. Maritime supremacy has consistently translated into commercial and strategic advantage in ways that land power alone could not replicate.",
      ];
    if (isLiberation)
      return [
        "Resistance movements rarely succeed through armed force alone. The combination of sustained guerrilla action, international pressure, the political delegitimization of the occupying power, and the mounting cost of repression tends to determine outcomes more than any single engagement.",
        "Occupation reshapes societies in ways that outlast the occupation itself. Identity hardens, collaboration becomes a lasting moral category, and the politics of the post-liberation period are defined by who resisted, who accommodated, and under what circumstances.",
        "What gets called liberation looks different depending on where you stand. The formal removal of an occupying power rarely resolves the underlying questions of who governs next, on whose behalf, and with what legitimacy.",
      ];
    if (isAttrition)
      return [
        "Industrial-scale warfare transformed conflict from a contest of tactics and leadership into a problem of production and endurance. The side that could sustain losses longest — in material, in manpower, in political will — tended to prevail, regardless of battlefield skill.",
        "Mass mobilization reshaped societies as profoundly as the fighting itself. Economies were restructured, gender roles disrupted, political compacts renegotiated. A society that entered a total war rarely emerged with its internal arrangements intact.",
        "The arithmetic of attrition was visible to everyone in real time, which is what made it so politically corrosive. Governments that could not explain why the losses were worth the gains eventually faced a crisis of legitimacy as dangerous as any military setback.",
      ];
    if (isCivilWar)
      return [
        "Civil wars are distinguished from other conflicts by who the enemy is: not a foreign power but a neighbour, a former ally, sometimes a family member. That proximity produces a particular kind of violence — intimate, difficult to end, and long-remembered.",
        "The causes of civil war are almost always multiple and contested. Economic inequality, ethnic or religious divisions, disputed legitimacy, and the collapse of institutions capable of managing disagreement tend to combine rather than act in isolation. Single-cause explanations come later, from the winners.",
        "Civil wars rarely end cleanly. The formal conclusion of fighting is followed by years of contested reconstruction — who gets to write the history, which grievances are acknowledged, and how the losing side is reintegrated into a shared political life. These questions prove at least as difficult as the war itself.",
      ];
    if (isSurrender)
      return [
        "Surrenders are often the moment when the real negotiation begins. The terms imposed on the defeated — reparations, territorial loss, political reorganization — shape the next generation's grievances as surely as the fighting shaped this one.",
        "The decision to stop fighting requires someone with authority to make it and the political standing to enforce it. Armies that refuse to accept the reality of defeat, or governments that collapse before surrender can be formalized, tend to produce prolonged and chaotic aftermaths.",
        "What the armistice ends is the shooting. What it does not end is the underlying conflict of interests, identities, and claims that produced the war. The durability of any peace depends on how seriously those deeper questions are addressed — a test that many ceasefires fail.",
      ];
    if (isAerial)
      return [
        "Aerial warfare added a dimension that fundamentally changed what it meant to be a civilian in wartime. The front line disappeared; distance from the fighting no longer offered safety. Cities, factories, and populations became legitimate targets under doctrines that were being improvised in real time.",
        "Strategic bombing promised to end wars quickly by destroying an enemy's will and capacity to fight from the air. The evidence for its effectiveness has always been contested — civilian populations proved more resilient than theorists predicted, and the economic disruption less decisive than promised.",
        "The moral framework for aerial warfare has never been fully resolved. The same technology used to deliver humanitarian aid can deliver ordnance. Drones, precision munitions, and autonomous systems have shifted the calculus again, raising questions that the laws of war — written for earlier technologies — struggle to answer.",
      ];

    if (era === "ancient")
      return [
        "In the ancient world, warfare was the ultimate arbiter of civilization. Kingdoms that had stood for centuries could be erased in a single campaign season — their people absorbed, enslaved, or scattered across unfamiliar lands.",
        "What the victors recorded as glorious triumph was, for the defeated, the collapse of everything they knew: language, gods, customs, and kinship networks reduced first to memory, then eventually to silence.",
        "Yet conflict also accelerated exchange. Technologies, crops, religions, and ideas spread fastest along routes carved by armies. War built the ancient world as much as it destroyed it.",
      ];
    if (era === "medieval")
      return [
        "Medieval warfare was rarely the chivalric contest romanticized in later literature. Sieges could last months, reducing entire populations to starvation; plague followed armies as reliably as supply carts followed generals.",
        "Feudal loyalty made alliances permanently treacherous. Kings who commanded the battlefield could lose the political war at home — undone by barons whose interests never fully aligned with the crown's ambitions.",
        "Still, medieval conflicts reshaped Europe's borders so profoundly that their lines echo in national identities today. The map of the modern world was drawn, in large part, by medieval swords.",
      ];
    if (era === "early_modern")
      return [
        "The introduction of gunpowder fundamentally restructured the calculus of war. Castle walls that had held for centuries became liabilities overnight. The armored knight — product of decades of expensive training — could be felled by a conscript armed with a musket.",
        "Early modern warfare also began to operate at imperial scale. Conflicts no longer stayed within European borders; they extended across oceans, reshaping the Americas, Africa, and Asia as collateral damage in European quarrels.",
        "These wars demanded new financial systems, bureaucracies, and supply chains — and in the effort to fund and sustain them, the modern nation-state was essentially invented.",
      ];
    if (era === "modern")
      return [
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
    const isSpace =
      /space|orbit|satellite|rocket|moon|mars|astronaut|cosmonaut|shuttle|spacecraft|launch pad/.test(
        t,
      );
    const isMedical =
      /vaccine|medicine|disease|cure|surgery|antibiotic|virus|epidemic|dna|gene|genome|transplant/.test(
        t,
      );
    const isPhysics =
      /atom|nuclear|quantum|relativity|particle|radiation|element|periodic|chemistry|fission|fusion/.test(
        t,
      );
    const isComputing =
      /computer|software|internet|algorithm|digital|program|data|network|code|processor|artificial intelligence/.test(
        t,
      );
    const isAstronomy =
      /comet|asteroid|star|planet|galaxy|nebula|eclipse|celestial|constellation|telescope|observatory/.test(
        t,
      );
    const isEnv =
      /climate|pollution|environment|ecosystem|conservation|species|extinction|carbon|deforestation|ozone/.test(
        t,
      );
    const isMath =
      /mathemati|theorem|proof|calculus|algebra|geometry|statistics|cipher|equation|formula|number/.test(
        t,
      );

    if (isSpace)
      return [
        "Space exploration demands solving problems at the absolute edge of what materials, mathematics, and human physiology can withstand. Every successful mission represents the convergence of thousands of engineering decisions, each of which had to be right.",
        "The political dimensions of space programs have always matched their scientific ones. National prestige, military capability signals, and the projection of technological power drove funding and timelines as forcefully as the pursuit of knowledge.",
        "What space exploration changed most durably was human self-perception. Seeing Earth from outside it — as a single, fragile object against an indifferent darkness — produced a shift in perspective that no purely terrestrial experience could replicate.",
      ];
    if (isMedical)
      return [
        "Medical progress rarely arrives as a clean breakthrough. It accumulates through decades of failure, partial understanding, and contested results — punctuated occasionally by discoveries that genuinely restructure everything that came before and after them.",
        "The gap between what medicine can do and what it actually delivers has always been one of the defining inequalities of every era. A treatment proven effective in one setting may be inaccessible, unaffordable, or contested in another. Discovery and access are separate problems.",
        "Disease has altered the course of history in ways that armies and diplomacy could not. Pathogens do not respect borders, social hierarchies, or military formations. Understanding this link between medicine and power is inseparable from understanding history itself.",
      ];
    if (isPhysics)
      return [
        "Discoveries at the fundamental level of physics have a habit of producing consequences that appear only decades later. The theoretical insights of one generation become the technological infrastructure of the next — and the ethical frameworks for managing them typically arrive last.",
        "Nuclear and quantum physics revealed that the universe operates by rules radically different from everyday experience. This created both extraordinary power and extraordinary conceptual difficulty — a science whose implications even its creators spent years working to understand.",
        "The institutional structures of modern science — large international collaborations, government-funded research, peer review at scale — were largely built around the demands of physics. In shaping how science is organized, the discipline reshaped the entire enterprise of knowledge-making.",
      ];
    if (isComputing)
      return [
        "Computing technology accelerated through a feedback loop: each generation of hardware enabled the development of the next, compressing decades of expected progress into years. The pace consistently outran the ability of legal, educational, and social institutions to adapt.",
        "The internet restructured the fundamental economics of information. When copying and distributing knowledge approaches zero cost, the industries and power structures built on controlling its scarcity face questions they were not designed to answer.",
        "What computing changed most profoundly was not any specific industry but the underlying assumption about what could be automated, optimized, and quantified. That assumption continues expanding into domains — creativity, judgment, interpersonal trust — that once seemed safely beyond its reach.",
      ];
    if (isAstronomy)
      return [
        "Astronomy has always occupied an unusual position in the hierarchy of sciences: its objects of study are entirely inaccessible, observable only at a distance measured in light-years, yet the patterns they reveal have structured timekeeping, navigation, and human self-understanding since the earliest civilizations.",
        "Each step outward in scale — from solar system to galaxy to observable universe — has required revising not just measurements but foundational assumptions about where we are and what we are made of. The universe turned out to be far older, larger, and stranger than anyone's first guess.",
        "Modern astronomy is fundamentally collaborative in a way few disciplines match. Telescopes span continents; data is shared across borders; discoveries arrive not through individual genius but through networked observation and computation. The romantic image of the lone astronomer at the eyepiece describes almost nothing about how the field actually works.",
      ];
    if (isEnv)
      return [
        "Environmental history reframes the standard narrative of progress by asking what was lost — ecologically, biologically, climatically — in the process of producing what we typically count as gains. The accounting looks considerably different when the costs are included.",
        "Ecosystems do not register political borders. A species extinction, an aquifer depleted, a river system dammed — these changes propagate across boundaries in ways that no single government is positioned to fully manage. The mismatch between the scale of environmental problems and the scale of political institutions is one of the central dilemmas of the modern era.",
        "The pace of environmental change in the industrial period has no precedent in human history and few in geological time. What makes this moment unusual is not that nature is changing — it always has — but that the driver of change is now the cumulative weight of human activity, and the timeline for consequences is measured in decades rather than millennia.",
      ];
    if (isMath)
      return [
        "Mathematics is unusual among intellectual disciplines in that its results, once proven, do not become obsolete. A theorem established two thousand years ago requires no revision when new evidence arrives — the proof either holds or it doesn't, and if it holds, it holds permanently.",
        "Mathematical structures discovered in purely abstract contexts have a persistent habit of turning out to describe physical reality with uncanny precision — often decades or centuries after the original work. This relationship between abstract reasoning and the behaviour of the physical world remains philosophically puzzling.",
        "The history of mathematics is also a history of expanding the concept of number itself: from counting integers to fractions, to irrational and imaginary numbers, to infinities of different sizes. Each expansion felt, to contemporaries, like a violation of common sense — and each eventually became indispensable.",
      ];

    if (era === "ancient" || era === "medieval")
      return [
        "In the ancient and medieval world, scientific inquiry was inseparable from philosophy and theology. Observation of the natural world was a form of reading a divine text — each pattern in the stars or in the body a reflection of a larger cosmic order.",
        "This did not make early scholars incurious. The great minds of antiquity and the Islamic Golden Age made advances in mathematics, astronomy, and medicine that Europe would not surpass for centuries — achieved without the institutional infrastructure we now take for granted.",
        "What we retrospectively label superstition was often simply the best available framework — a coherent attempt to understand cause and effect with the tools at hand. History remembers the failures. It rarely appreciates how remarkable it was to try at all.",
      ];
    if (era === "early_modern")
      return [
        "The Scientific Revolution was not a single event but a slow erosion of inherited certainty. Each discovery challenged not just a theory but an entire worldview — and the institutions, both religious and political, that depended on that worldview remaining intact.",
        "Figures like Galileo, Copernicus, and Newton were not safely distant academics. They were, in their time, radicals — challenging what powerful institutions held to be settled truth, and sometimes paying a serious personal price for doing so.",
        "The methods they established — observation, hypothesis, experiment, replication — are now so thoroughly embedded in how we think that it is almost impossible to imagine reasoning without them. That is how completely they changed the world.",
      ];
    if (era === "modern")
      return [
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

  if (expl)
    return [
      "For those who undertook these journeys, the unknown was not an abstraction — it was literal. Coastlines that ended without warning, prevailing winds that shifted unpredictably, diseases no European immune system had encountered. The odds of safe return were never guaranteed.",
      "What exploration produced, beyond geographical knowledge, was a catastrophic redistribution of power, population, and disease. Civilizations encountered along the way — many sophisticated in their own right — were transformed, reduced, or erased within generations of first contact.",
      "We still speak of the 'discovery' of places that had been continuously inhabited for millennia. Revisiting this history honestly means holding two truths simultaneously: the genuine courage these journeys required, and the devastation that followed in their wake.",
    ];

  if (dis)
    if (
      /pandemic|covid|coronavirus|quarantine|lockdown|travel ban|public health/.test(
        t,
      )
    )
      return [
        "Pandemics are biological events with political consequences. Measures like travel restrictions, quarantine rules, and emergency declarations are not just medical responses — they are state decisions that redistribute risk, responsibility, and economic burden across society.",
        "Cross-border disease transmission exposes how tightly modern systems are linked. Aviation, trade, and tourism connect economies at high speed, so disruptions in one region quickly become global policy questions rather than local incidents.",
        "The long-term historical significance of pandemic-era decisions is judged by institutional learning: whether governments improved surveillance, health capacity, and crisis coordination after the immediate emergency passed.",
      ];
  if (dis)
    return [
      "Natural disasters operate on geological or meteorological scales entirely indifferent to human plans. Yet their death tolls are shaped as much by social factors — poverty, inequality, political negligence — as by the event itself. The same earthquake kills thousands in one city and dozens in another.",
      "Catastrophe reveals a society's real priorities with uncomfortable clarity. Which communities get rebuilt first, which are quietly abandoned, who receives compensation and who is forgotten — these decisions expose power structures that official policy rarely acknowledges directly.",
      "History's great disasters also tend to accelerate reform. Building codes, early warning systems, and emergency response frameworks were largely built in the aftermath of tragedies that revealed how preventable the worst outcomes were. Progress here has almost always been reactive rather than proactive.",
    ];

  if (art)
    return [
      "Cultural history moves differently from political history. Where political events can be dated to a specific day, artistic movements accumulate gradually — a novel published here, a manifesto there, a performance that contemporary audiences found outrageous and critics a generation later called definitive.",
      "Art produced in one era is constantly reread by those that follow. Works dismissed as obscene or trivial are restored to the canon; once-celebrated masterworks lose their urgency. The cultural record is perpetually being negotiated and revised by new eyes.",
      "What tends to endure — across centuries and cultural contexts — is work that captured something true about human experience. Not necessarily the technically perfect or the ideologically correct, but the honest. History has a long memory for authenticity.",
    ];

  if (rel)
    return [
      "Religious history resists easy reduction. Doctrinal disputes that seem, in retrospect, impossibly arcane — precise questions of theology, the authority of a particular text, the correct form of a ritual — were, for those living through them, matters of ultimate consequence, worth dying and killing for.",
      "Religious institutions have simultaneously served as preservers of knowledge, patrons of the arts, centers of social organization, and engines of oppression. Rarely has any one of these functions entirely eclipsed the others in any tradition, for any sustained period.",
      "The relationship between faith and secular authority has never been permanently resolved — only temporarily arranged. Every settlement between them eventually produces the conditions for the next renegotiation, and the terms are always contested.",
    ];

  if (pol) {
    // Sub-categories within politics so commentary matches the actual event type
    const isElection =
      /election|vote|ballot|elected|campaign|referendum|suffrage|polling/.test(
        t,
      );
    const isTreaty =
      /treaty|accord|agreement|peace|diplomatic|negotiat|ceasefire|armistice/.test(
        t,
      );
    const isRevolution =
      /revolution|independence|uprising|coup|overthrow|liberat|rebel|proclaimed/.test(
        t,
      );
    const isAssassination = /assassin|murder|killed|shot|executed|impeach/.test(
      t,
    );
    const isLegislation =
      /constitution|legislation|bill|charter|amendment|decree|enacted|signed into law/.test(
        t,
      );

    if (isElection)
      return [
        "Elections are democracy's recurring proof of concept — contested, imperfect, and still the most reliable mechanism humanity has produced for transferring power without immediate violence.",
        "The outcome of any election is shaped by forces that begin years before polling day: demographic shifts, economic anxieties, media narratives, and the accumulated weight of earlier decisions. The ballot box measures a political moment, not just an individual preference.",
        "History judges elections not only by who won, but by what became possible — or permanently foreclosed — because of them. The full consequences of a particular result are rarely visible on election night.",
      ];
    if (isTreaty)
      return [
        "Treaties are political documents dressed as resolutions. What they commit to on paper and what they produce in practice are rarely identical — the gap between the two is where much of the subsequent history tends to unfold.",
        "Every peace agreement encodes the power imbalance of the moment it was signed. Those who negotiated from weakness rarely secured terms that held indefinitely. The seeds of the next conflict are almost always present in the language of the settlement.",
        "The durability of any treaty depends less on its wording than on whether the conditions that produced the original conflict have genuinely changed — a question that no signature alone can answer.",
      ];
    if (isRevolution)
      return [
        "Revolutions are rarely as sudden as they appear. The conditions that make them possible — accumulated grievances, weakened institutions, competing claims to legitimacy — build over years before a single event transforms long-standing tension into open rupture.",
        "Every revolution produces a gap between what it promised and what it delivers. The ideals of the opening phase are typically constrained by the practical pressures of consolidation, when the question shifts from 'what do we want?' to 'how do we hold this together?'",
        "What makes a revolutionary moment historically decisive is not simply that it changed who held power, but whether it changed the underlying rules by which power could be held, challenged, and transferred. By that measure, the verdict on most revolutions takes generations to reach.",
      ];
    if (isAssassination)
      return [
        "Political violence aimed at individuals rarely eliminates the ideas those individuals represented. Assassinations tend to accelerate the forces they aimed to stop — converting people into symbols and grievances into movements with longer half-lives than the original.",
        "The aftermath of a political killing reveals far more about a society than the act itself. How institutions respond, whether successor governments are strengthened or destabilized, and whether the act achieves its intended effect — these are the real historical questions.",
        "The counterfactual is irresistible but ultimately unanswerable: would history have unfolded differently had the individual survived? More revealing is the question of what conditions made such an outcome possible in the first place.",
      ];
    if (isLegislation)
      return [
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

  if (econ)
    return [
      "Economic crises have a way of revealing, very quickly, which elements of a financial system were more fragile than they appeared. The mechanisms that work smoothly during expansion — leverage, interconnection, confidence — amplify losses with equal efficiency on the way down.",
      "Markets are built on expectations about the future, which means they are built on collective psychology as much as on fundamentals. Confidence, once lost, tends to be slow to return and easy to shatter again. The narrative a society tells about its economy matters — sometimes as much as the underlying reality.",
      "The political consequences of economic crises consistently outlast the crises themselves. Governments that presided over financial collapses rarely survived them with their authority intact. The social strains produced by mass unemployment, lost savings, and deflated expectations tend to find political expression — not always in forms that democratic institutions can easily absorb.",
    ];

  if (sport)
    return [
      "Sporting achievement exists at the intersection of biological capacity, systematic training, and favorable circumstance — with the last element more consequential than athletic mythologies typically acknowledge. Champions are also products of access: to coaching, facilities, nutrition, and the freedom to specialize.",
      "Major sporting events have always served purposes beyond competition. They are displays of national prestige, commercial spectacles, diplomatic signals, and platforms for political statements — sometimes all simultaneously. The sport itself is embedded in a context that shapes everything from the schedule to the broadcast rights.",
      "Records exist to be broken, which is precisely what makes them useful as historical markers. Each time a presumed human limit is surpassed, the achievement recalibrates what the next generation believes is possible — a compounding effect that extends beyond sport into every domain where belief in possibility matters.",
    ];

  // Default — era-based
  if (era === "ancient")
    return [
      "Events from the ancient world survive only through fragments — inscriptions, papyri, and secondhand accounts filtered through centuries of copying and interpretation. Every surviving detail was preserved against considerable odds.",
      "The civilizations that produced these events were far more complex and interconnected than popular imagination typically allows. Trade routes, diplomatic correspondence, and shared mythologies linked the ancient Mediterranean, Middle East, and Asia in ways that are still being mapped.",
      "What we call ancient history is largely the record of elites and institutions. The daily lives, beliefs, and experiences of ordinary people — the overwhelming majority — remain largely invisible, recoverable only in fragments through archaeology.",
    ];
  if (era === "medieval")
    return [
      "The medieval world was far more dynamic and interconnected than the 'Dark Ages' label once suggested. Scholarly exchange between Islamic, Jewish, Byzantine, and European traditions kept classical knowledge alive and advanced it significantly.",
      "Life in the medieval period was shaped by rhythms — liturgical, agricultural, and dynastic — that gave time a different texture than the linear, progress-oriented narrative we tend to impose on it from the outside.",
      "Medieval people were not primitive versions of us, waiting for modernity to arrive. They were fully formed human beings navigating a specific set of circumstances with intelligence, humor, ambition, and fear — much as we do now.",
    ];
  if (era === "early_modern")
    return [
      "The early modern period was defined by collisions: of continents, religions, political systems, and ways of understanding the world. Old certainties were crumbling faster than new ones could be built to replace them.",
      "Print technology, oceanic navigation, and the Reformation all arrived within decades of each other — a convergence of disruptions that transformed European society more rapidly than anything since the fall of Rome.",
      "People living through this period had no way of knowing they were in a hinge moment of history. They experienced it as confusion, opportunity, and violence in roughly equal measure — which is, perhaps, how most pivotal eras feel from the inside.",
    ];
  if (era === "modern")
    return [
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

function buildDynamicOverview(featured, events, mDisplay, day) {
  if (!featured) {
    return {
      title: `Overview: ${mDisplay} ${day}`,
      paragraphs: [
        `This page gathers key moments connected to ${mDisplay} ${day}, with each entry offering historical context about a specific event, person, or turning point.`,
        `When no single featured item is available, the timeline still provides a focused view of how this date appears across different eras and topics.`,
      ],
    };
  }

  const cleanText = String(featured.text || "")
    .replace(/\s+/g, " ")
    .trim();
  const eventStatement = cleanText.replace(/[.\s]+$/, "");
  const firstSentence = (cleanText.split(".")[0] || cleanText).trim();
  const fullFeaturedLabel = `${featured.year} — ${firstSentence}`;
  const topical = workerCommentary(featured.year, featured.text);

  return {
    title: `Overview: ${fullFeaturedLabel}`,
    paragraphs: [
      `On ${mDisplay} ${day}, ${featured.year}, ${eventStatement}. This moment is most useful when read in its direct context: who acted, what changed, and why it mattered at that time.`,
      topical[0],
      topical[1] || topical[0],
    ],
  };
}

function generateBlogPostHTML(
  monthName,
  day,
  eventsData,
  siteUrl,
  didYouKnowFacts = [],
  quizHtml = "",
  quizData = null,
) {
  const mNum = MONTH_NUM_MAP[monthName] || 1;
  const mDisplay = MONTH_DISPLAY_NAMES[mNum];
  const canonical = `${siteUrl}/events/${monthName}/${day}/`;
  const events = eventsData?.events || [];
  const births = eventsData?.births || [];
  const deaths = eventsData?.deaths || [];

  const featured =
    events.find((e) => e.pages?.[0]?.thumbnail?.source) || events[0] || null;
  const others = events.filter((e) => e !== featured).slice(0, 8);
  const topBirths = births.slice(0, 5);
  const topDeaths = deaths.slice(0, 5);

  const pageTitle = featured
    ? `What Happened on ${mDisplay} ${day}: ${featured.text.split(".")[0]} | thisDay.info`
    : `What Happened on ${mDisplay} ${day} in History | thisDay.info`;
  const rawDesc = featured
    ? `Discover what happened on ${mDisplay} ${day} throughout history. In ${featured.year}: ${featured.text.substring(0, 115)}...`
    : `Explore historical events, births, and deaths that occurred on ${mDisplay} ${day} throughout world history.`;
  const pageDesc = rawDesc.substring(0, 155);
  const ogImg =
    featured?.pages?.[0]?.thumbnail?.source || `${siteUrl}/images/logo.png`;
  const featImg =
    featured?.pages?.[0]?.originalimage?.source ||
    featured?.pages?.[0]?.thumbnail?.source ||
    null;
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
  const introLine = featured
    ? `A thisDay.info historical digest for ${mDisplay} ${day}, sourced from Wikipedia`
    : `A thisDay.info historical digest, sourced from Wikipedia`;
  const today = new Date().toISOString().split("T")[0];
  const _todayDate = new Date();
  const todayMonthSlug = MONTHS_ALL[_todayDate.getUTCMonth()];
  const todayDayNum = _todayDate.getUTCDate();

  // Prev / next day navigation
  const mIdx = mNum - 1;
  const prevDayNum = day > 1 ? day - 1 : DAYS_IN_MONTH[(mIdx - 1 + 12) % 12];
  const prevMIdx = day > 1 ? mIdx : (mIdx - 1 + 12) % 12;
  const prevMonthName = MONTHS_ALL[prevMIdx];
  const prevMonthDisplay = MONTH_DISPLAY_NAMES[prevMIdx + 1];
  const nextDayNum = day < DAYS_IN_MONTH[mIdx] ? day + 1 : 1;
  const nextMIdx = day < DAYS_IN_MONTH[mIdx] ? mIdx : (mIdx + 1) % 12;
  const nextMonthName = MONTHS_ALL[nextMIdx];
  const nextMonthDisplay = MONTH_DISPLAY_NAMES[nextMIdx + 1];

  // FAQ schema for voice search + featured snippets
  const faqSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: `What happened on ${mDisplay} ${day} in history?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: featured
            ? `On ${mDisplay} ${day}, ${featured.year}: ${featured.text}`
            : `Explore historical events on thisDay.info for ${mDisplay} ${day}.`,
        },
      },
      ...(births.length > 0
        ? [
            {
              "@type": "Question",
              name: `Who are famous people born on ${mDisplay} ${day}?`,
              acceptedAnswer: {
                "@type": "Answer",
                text: `Famous people born on ${mDisplay} ${day} include: ${births
                  .slice(0, 3)
                  .map((b) => b.text.split(",")[0])
                  .join(", ")}.`,
              },
            },
          ]
        : []),
      ...(deaths.length > 0
        ? [
            {
              "@type": "Question",
              name: `What famous people died on ${mDisplay} ${day}?`,
              acceptedAnswer: {
                "@type": "Answer",
                text: `Notable historical figures who died on ${mDisplay} ${day} include: ${deaths
                  .slice(0, 3)
                  .map((d) => d.text.split(",")[0])
                  .join(", ")}.`,
              },
            },
          ]
        : []),
    ],
  }).replace(/<\//g, "<\\/");

  const articleSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
    headline: pageTitle,
    description: pageDesc,
    url: canonical,
    datePublished: today,
    dateModified: today,
    articleSection: "History",
    inLanguage: "en",
    author: {
      "@type": "Person",
      name: "thisDay.info Editorial Team",
      url: `${siteUrl}/about/`,
    },
    publisher: {
      "@type": "Organization",
      name: "thisDay.info",
      url: siteUrl,
      logo: { "@type": "ImageObject", url: `${siteUrl}/images/logo.png` },
    },
    ...(featImg && { image: { "@type": "ImageObject", url: featImg } }),
  }).replace(/<\//g, "<\\/");

  const eventsSchema =
    events.length > 0
      ? JSON.stringify({
          "@context": "https://schema.org",
          "@type": "ItemList",
          name: `Historical Events on ${mDisplay} ${day}`,
          numberOfItems: events.length,
          itemListElement: events.slice(0, 5).map((e, i) => ({
            "@type": "ListItem",
            position: i + 1,
            item: {
              "@type": "Event",
              name: e.text.substring(0, 100),
              description: e.text,
              temporalCoverage: String(e.year),
            },
          })),
        }).replace(/<\//g, "<\\/")
      : null;

  const quizSchema = quizData?.questions?.length
    ? JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Quiz",
        name: `${mDisplay} ${day} History Quiz`,
        description: quizData.topic
          ? `Think you know what happened on ${mDisplay} ${day}? Take our free 5-question history quiz on ${quizData.topic} and test your knowledge.`
          : `Test your knowledge of historical events on ${mDisplay} ${day}.`,
        url: `${siteUrl}/quiz/${monthName}/${day}/`,
        educationalLevel: "beginner",
        learningResourceType: "quiz",
        ...(quizData.topic
          ? {
              about: {
                "@type": "Event",
                name: quizData.topic,
                description: quizData.sourceEvent || "",
              },
            }
          : {}),
        isPartOf: {
          "@type": "WebPage",
          url: `${siteUrl}/events/${monthName}/${day}/`,
        },
        publisher: {
          "@type": "Organization",
          name: "thisday.info",
          url: siteUrl,
        },
        hasPart: quizData.questions.map((q) => ({
          "@type": "Question",
          name: q.q,
          acceptedAnswer: {
            "@type": "Answer",
            text: q.options?.[q.answer] ?? "",
          },
        })),
      }).replace(/<\//g, "<\\/")
    : null;

  const othersHtml = others
    .map((e) => {
      const w = e.pages?.[0]?.content_urls?.desktop?.page || "";
      const th = e.pages?.[0]?.thumbnail?.source || "";
      return `<div class="ev-row d-flex align-items-start gap-3">
  <div class="flex-grow-1"><span class="yr">${escapeHtml(String(e.year))}</span> ${escapeHtml(e.text)}${w ? ` <a href="${escapeHtml(w)}" class="small text-muted" target="_blank" rel="noopener noreferrer">Wikipedia &rarr;</a>` : ""}</div>
  ${th ? `<img src="${escapeHtml(th)}" alt="" width="44" height="44" style="border-radius:4px;object-fit:cover;flex-shrink:0" onerror="this.style.display=&#39;none&#39;" loading="lazy"/>` : ""}
</div>`;
    })
    .join("");

  const birthsHtml = topBirths
    .map((b) => {
      const th = b.pages?.[0]?.thumbnail?.source || "";
      const w = b.pages?.[0]?.content_urls?.desktop?.page || "";
      const name = escapeHtml(b.text.split(",")[0]);
      return `<div class="person-row d-flex align-items-center gap-3">
  ${th ? `<img src="${escapeHtml(th)}" alt="${name}" class="p-thumb" onerror="this.style.display=&#39;none&#39;" loading="lazy"/>` : '<div class="p-thumb-blank"><i class="bi bi-person"></i></div>'}
  <div><span class="yr">${escapeHtml(String(b.year))}</span> ${w ? `<a href="${escapeHtml(w)}" target="_blank" rel="noopener noreferrer">${escapeHtml(b.text)}</a>` : escapeHtml(b.text)}</div>
</div>`;
    })
    .join("");

  const deathsHtml = topDeaths
    .map((d) => {
      const th = d.pages?.[0]?.thumbnail?.source || "";
      const w = d.pages?.[0]?.content_urls?.desktop?.page || "";
      const name = escapeHtml(d.text.split(",")[0]);
      return `<div class="person-row d-flex align-items-center gap-3">
  ${th ? `<img src="${escapeHtml(th)}" alt="${name}" class="p-thumb" onerror="this.style.display=&#39;none&#39;" loading="lazy"/>` : '<div class="p-thumb-blank"><i class="bi bi-person"></i></div>'}
  <div><span class="yr" style="background:#6c757d">${escapeHtml(String(d.year))}</span> ${w ? `<a href="${escapeHtml(w)}" target="_blank" rel="noopener noreferrer">${escapeHtml(d.text)}</a>` : escapeHtml(d.text)}</div>
</div>`;
    })
    .join("");

  return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${escapeHtml(pageTitle)}</title>
<link rel="canonical" href="${escapeHtml(canonical)}"/>
<link rel="prev" href="${escapeHtml(`${siteUrl}/events/${prevMonthName}/${prevDayNum}/`)}"/>
<link rel="next" href="${escapeHtml(`${siteUrl}/events/${nextMonthName}/${nextDayNum}/`)}"/>
<meta name="robots" content="index, follow"/><meta name="description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:title" content="${escapeHtml(pageTitle)}"/><meta property="og:description" content="${escapeHtml(pageDesc)}"/>
<meta property="og:type" content="article"/><meta property="og:url" content="${escapeHtml(canonical)}"/>
<meta property="og:locale" content="en_US"/><meta property="og:image" content="${escapeHtml(ogImg)}"/>
<meta name="twitter:card" content="summary_large_image"/><meta name="twitter:title" content="${escapeHtml(pageTitle)}"/>
<meta name="twitter:description" content="${escapeHtml(pageDesc)}"/><meta name="twitter:image" content="${escapeHtml(ogImg)}"/>
<meta name="author" content="thisDay.info"/>
<script type="application/ld+json">${articleSchema}</script>
${eventsSchema ? `<script type="application/ld+json">${eventsSchema}</script>` : ""}
<script type="application/ld+json">${faqSchema}</script>
${quizSchema ? `<script type="application/ld+json">${quizSchema}</script>` : ""}
<link rel="icon" href="/images/favicon.ico" type="image/x-icon"/>
<link rel="apple-touch-icon" sizes="180x180" href="/images/apple-touch-icon.png"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"/>
<style>
:root{--pb:#3b82f6;--sb:#fff;--tc:#1e293b;--htc:#fff;--fb:#3b82f6;--ftc:#fff;--lc:#2563eb;--cb:#fff;--cbr:rgba(0,0,0,.1);--mu:#64748b}
body.dark-theme{--pb:#020617;--sb:#1e293b;--tc:#f8fafc;--fb:#020617;--lc:#60a5fa;--cb:#1e293b;--cbr:rgba(255,255,255,.1);--mu:#cbd5e1}
body{font-family:Inter,sans-serif;min-height:100vh;display:flex;flex-direction:column;background:var(--sb);color:var(--tc);transition:background .3s,color .3s}
.navbar{background:var(--pb)!important;position:sticky;top:0;z-index:1030}.navbar-brand,.nav-link{color:var(--htc)!important;font-weight:700!important}
main{flex:1;padding:20px 0}
.footer{background:var(--fb);color:var(--ftc);text-align:center;padding:20px;margin-top:30px;font-size:14px}.footer a{color:var(--ftc);text-decoration:underline}
.footer .container.d-flex.justify-content-center.my-2{gap:20px}
h1,h2,h3,h4{color:var(--tc)}body.dark-theme h1,body.dark-theme h2,body.dark-theme h3,body.dark-theme h4{color:#f8fafc}
a{color:var(--lc)}a:hover{text-decoration:underline}
.text-muted{color:var(--mu)!important}
.breadcrumb-item a{color:var(--lc)}
.breadcrumb-item.active{color:var(--mu)}
body.dark-theme .breadcrumb-item a{color:#93c5fd}
body.dark-theme .breadcrumb-item.active{color:#e2e8f0}
.form-check-input:checked{background-color:#2563eb!important;border-color:#2563eb!important}
.form-check-input{background:#e2e8f0;border-color:#e2e8f0}body.dark-theme .form-check-input{background:#334155;border-color:#334155}
.form-switch .form-check-input{background-image:url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='-4 -4 8 8'%3e%3ccircle r='3' fill='%23fff'/%3e%3c/svg%3e")}
.card-box{background:var(--cb);border:1px solid var(--cbr);border-radius:10px;padding:22px;margin-bottom:22px}
.feat-img{width:100%;max-height:420px;object-fit:cover;border-radius:8px;margin-bottom:20px}
.commentary{border-left:4px solid #3b82f6;padding:10px 14px;background:rgba(59,130,246,.07);border-radius:0 8px 8px 0;font-style:italic;color:var(--mu);margin:18px 0}
body.dark-theme .commentary{background:rgba(59,130,246,.15)}
.did-you-know{background:rgba(245,158,11,.07);border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;padding:14px 16px;margin:18px 0}.did-you-know h3{font-size:1rem;font-weight:700;margin-bottom:10px;color:var(--tc)}.did-you-know ul{padding-left:1.3rem;margin-bottom:0}.did-you-know li{margin-bottom:7px;line-height:1.55;font-size:.95rem}
body.dark-theme .did-you-know{background:rgba(245,158,11,.13)}
.yr{background:#3b82f6;color:#fff;padding:2px 7px;border-radius:4px;font-size:.78rem;font-weight:600;margin-right:6px;white-space:nowrap}
.ev-row{padding:11px 0;border-bottom:1px solid var(--cbr)}.ev-row:last-child{border-bottom:none}
.person-row{padding:9px 0;border-bottom:1px solid var(--cbr)}.person-row:last-child{border-bottom:none}
.p-thumb{width:44px;height:44px;border-radius:50%;object-fit:cover;flex-shrink:0}
.p-thumb-blank{width:44px;height:44px;border-radius:50%;background:#e2e8f0;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:1.2rem;color:#6c757d}
body.dark-theme .p-thumb-blank{background:#334155;color:#94a3b8}
.auto-tag{display:inline-block;background:rgba(59,130,246,.12);color:#3b82f6;font-size:.7rem;font-weight:600;padding:2px 7px;border-radius:20px;margin-left:6px;vertical-align:middle}
body.dark-theme .auto-tag{background:rgba(96,165,250,.15);color:#60a5fa}
.ad-unit{margin:22px 0;text-align:center}.ad-unit-label{font-size:.68rem;font-weight:600;letter-spacing:.06em;color:var(--mu);text-transform:uppercase;margin-bottom:6px;opacity:.7}
.tdq-question{margin-bottom:18px}.tdq-q-text{font-weight:600;margin-bottom:10px;font-size:.95rem;color:var(--tc)}.tdq-options{display:flex;flex-direction:column;gap:8px}
.tdq-opt{display:flex;align-items:center;gap:10px;padding:9px 14px;border:1.5px solid var(--cbr);border-radius:8px;cursor:pointer;font-size:.9rem;transition:background .15s,border-color .15s;user-select:none}
.tdq-opt:hover{border-color:#3b82f6;background:rgba(59,130,246,.07)}.tdq-opt-selected{border-color:#3b82f6!important;background:rgba(59,130,246,.1)!important;font-weight:500}
.tdq-opt-correct{border-color:#10b981!important;background:#d1fae5!important;color:#0f172a!important}.tdq-opt-wrong{border-color:#ef4444!important;background:#fee2e2!important;color:#0f172a!important}
.tdq-opt-key{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:#e2e8f0;font-size:.75rem;font-weight:700;flex-shrink:0}
.tdq-opt-selected .tdq-opt-key{background:#3b82f6;color:#fff}.tdq-opt-correct .tdq-opt-key{background:#10b981;color:#fff}.tdq-opt-wrong .tdq-opt-key{background:#ef4444;color:#fff}
body.dark-theme .tdq-opt{border-color:rgba(255,255,255,.15)}body.dark-theme .tdq-opt:hover{border-color:#60a5fa;background:rgba(96,165,250,.08)}
body.dark-theme .tdq-opt-selected{border-color:#60a5fa!important;background:rgba(96,165,250,.15)!important}body.dark-theme .tdq-opt-key{background:#334155;color:#cbd5e1}
body.dark-theme .tdq-opt-correct{background:rgba(16,185,129,.2)!important;border-color:#10b981!important;color:#e2e8f0!important}
body.dark-theme .tdq-opt-wrong{background:rgba(239,68,68,.2)!important;border-color:#ef4444!important;color:#e2e8f0!important}
.tdq-explanation{font-size:.85rem;margin-top:6px;padding:8px 12px;background:rgba(59,130,246,.07);border-left:3px solid #3b82f6;border-radius:0 6px 6px 0;color:var(--tc)}
body.dark-theme .tdq-explanation{background:rgba(59,130,246,.18);border-left-color:#60a5fa;color:#e2e8f0}
.tdq-feedback{font-size:.85rem;margin-top:5px}.tdq-correct{color:#10b981;font-weight:600}.tdq-wrong{color:#ef4444;font-weight:600}
.tdq-score-box{font-size:1.05rem;font-weight:600;padding:12px 16px;background:rgba(245,158,11,.1);border-radius:8px;border-left:4px solid #f59e0b}.tdq-score-num{color:#f59e0b;font-size:1.2rem}
.site-table{width:100%;max-width:480px;border-collapse:collapse;border:1.5px solid var(--cbr);border-radius:10px;overflow:hidden;margin-top:1rem;font-size:.9rem}
.site-table th,.site-table td{padding:8px 14px;border-bottom:1px solid var(--cbr);text-align:left;color:var(--tc)}
.site-table tr:last-child th,.site-table tr:last-child td{border-bottom:none}
.site-table th{background:rgba(59,130,246,.07);font-weight:600;white-space:nowrap;width:40%}
body.dark-theme .site-table{border-color:rgba(255,255,255,.15)}
body.dark-theme .site-table th{background:rgba(96,165,250,.1)}
body.dark-theme .site-table th,body.dark-theme .site-table td{border-bottom-color:rgba(255,255,255,.08)}
.site-btn{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border:1.5px solid var(--cbr);border-radius:8px;font-size:.875rem;font-weight:500;text-decoration:none;color:var(--tc);background:transparent;cursor:pointer;transition:background .15s,border-color .15s,color .15s;user-select:none}
.site-btn:hover{border-color:#3b82f6;background:rgba(59,130,246,.07);color:var(--tc);text-decoration:none}
.site-btn-primary{border-color:#3b82f6;color:#2563eb}
.site-btn-primary:hover{background:rgba(59,130,246,.12);border-color:#2563eb;color:#1d4ed8}
body.dark-theme .site-btn{border-color:rgba(255,255,255,.18);color:var(--tc)}
body.dark-theme .site-btn:hover{border-color:#60a5fa;background:rgba(96,165,250,.1);color:#f8fafc}
body.dark-theme .site-btn-primary{border-color:#60a5fa;color:#93c5fd}
body.dark-theme .site-btn-primary:hover{background:rgba(96,165,250,.15);border-color:#93c5fd;color:#e0f2fe}
#read-progress{position:fixed;top:0;left:0;height:3px;width:0%;background:#3b82f6;z-index:9999;transition:width .1s linear;pointer-events:none}
body.dark-theme #read-progress{background:#60a5fa}
</style>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8565025017387209" crossorigin="anonymous"></script>
</head>
<body>
<div id="read-progress" role="progressbar" aria-label="Reading progress" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"></div>
<nav class="navbar navbar-expand-lg navbar-dark">
  <div class="container-fluid">
    <a class="navbar-brand" href="/">thisDay.</a>
    <div class="form-check form-switch d-lg-none me-2">
      <input class="form-check-input" type="checkbox" id="tsm" aria-label="Toggle dark mode"/>
      <label class="form-check-label" for="tsm"><i class="bi bi-brightness-high-fill" style="color:#fff;font-size:1.1rem;margin-left:4px"></i></label>
    </div>
    <div class="collapse navbar-collapse">
      <ul class="navbar-nav ms-auto">
        <li class="nav-item">
          <a class="nav-link" href="/events/${todayMonthSlug}/${todayDayNum}/">Today's Events</a>
        </li>
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
      <li class="breadcrumb-item"><a href="/events/">On This Day</a></li>
      <li class="breadcrumb-item active" aria-current="page">${escapeHtml(mDisplay)} ${day}</li>
    </ol>
  </nav>
  <h1 class="mb-1">${escapeHtml(mDisplay)} ${day} in History <span class="auto-tag">Made for you</span></h1>
  <p class="text-muted mb-1" style="font-size:.9rem">${escapeHtml(introLine)} &mdash; <a href="https://www.wikipedia.org" target="_blank" rel="noopener noreferrer">Wikipedia</a></p>
  <p class="text-muted mb-4" style="font-size:.82rem">By <a href="/about/" rel="author" style="color:inherit">thisDay.info Editorial Team</a> &middot; <time datetime="${today}">${escapeHtml(mDisplay)} ${day}</time></p>
  ${
    featured
      ? `
  <div class="card-box">
    ${featImg ? `<img src="/image-proxy?src=${encodeURIComponent(featImg)}&w=800&q=85" srcset="/image-proxy?src=${encodeURIComponent(featImg)}&w=400 400w, /image-proxy?src=${encodeURIComponent(featImg)}&w=800 800w" sizes="(max-width:640px) 100vw, 800px" alt="${escapeHtml(featured.text.substring(0, 80))}" class="feat-img" loading="eager"/>` : ""}
    <h2>${featTitle}</h2>
    <p class="mb-3">${escapeHtml(featured.text)}</p>
    ${didYouKnowFacts.length > 0 ? `<div class="did-you-know"><h3><i class="bi bi-lightbulb-fill me-1" style="color:#f59e0b"></i>Did You Know?</h3><ul>${didYouKnowFacts.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul></div>` : `<div class="commentary"><i class="bi bi-chat-quote me-1" style="color:#3b82f6"></i>${commentaryParas.map((p, i, a) => `<p class="${i === a.length - 1 ? "mb-0" : "mb-2"}">${p}</p>`).join("")}</div>`}
    <table class="site-table">
      <tbody><tr><th>Date</th><td>${escapeHtml(mDisplay)} ${day}</td></tr>
      <tr><th>Year</th><td>${escapeHtml(String(featured.year))}</td></tr>
      <tr><th>Events recorded</th><td>${events.length}</td></tr>
      <tr><th>Data source</th><td><a href="https://www.wikipedia.org" target="_blank" rel="noopener noreferrer">Wikipedia</a></td></tr>
    </tbody></table>
    ${featWiki ? `<a href="${escapeHtml(featWiki)}" class="site-btn site-btn-primary mt-3" target="_blank" rel="noopener noreferrer"><i class="bi bi-box-arrow-up-right"></i>Full Article on Wikipedia</a>` : ""}
  </div>`
      : `<div class="alert alert-info">No events found for ${escapeHtml(mDisplay)} ${day}.</div>`
  }
  ${quizHtml}
  <div class="ad-unit">
    <div class="ad-unit-label">Advertisement</div>
    <ins class="adsbygoogle"
         style="display:block;border-radius:8px;overflow:hidden"
         data-ad-client="ca-pub-8565025017387209"
         data-ad-slot="4828593028"
         data-ad-format="auto"
         data-full-width-responsive="true"></ins>
  </div>
  ${
    others.length > 0
      ? `
  <div class="card-box">
    <h2 class="h4 mb-3"><i class="bi bi-calendar-event me-2" style="color:#3b82f6"></i>More Events on ${escapeHtml(mDisplay)} ${day}</h2>
    ${othersHtml}
  </div>
  <div class="ad-unit">
    <div class="ad-unit-label">Advertisement</div>
    <ins class="adsbygoogle"
         style="display:block;border-radius:8px;overflow:hidden"
         data-ad-client="ca-pub-8565025017387209"
         data-ad-slot="9477779891"
         data-ad-format="auto"
         data-full-width-responsive="true"></ins>
  </div>`
      : ""
  }
  ${
    topBirths.length > 0
      ? `
  <div class="card-box">
    <h2 class="h4 mb-3"><i class="bi bi-person-heart me-2" style="color:#3b82f6"></i>Born on ${escapeHtml(mDisplay)} ${day}</h2>
    ${birthsHtml}
  </div>`
      : ""
  }
  ${
    topDeaths.length > 0
      ? `
  <div class="card-box">
    <h2 class="h4 mb-3"><i class="bi bi-flower1 me-2" style="color:#6c757d"></i>Died on ${escapeHtml(mDisplay)} ${day}</h2>
    ${deathsHtml}
  </div>`
      : ""
  }
  <div class="my-5 pt-3 border-top">
    <div class="d-flex justify-content-between align-items-center mb-4">
      <a href="/events/${prevMonthName}/${prevDayNum}/" class="site-btn"><i class="bi bi-arrow-left"></i>${escapeHtml(prevMonthDisplay)} ${prevDayNum}</a>
      <a href="/events/${nextMonthName}/${nextDayNum}/" class="site-btn">${escapeHtml(nextMonthDisplay)} ${nextDayNum}<i class="bi bi-arrow-right"></i></a>
    </div>
    <div class="text-center">
      <p class="text-muted mb-3">Explore history for any date on the interactive calendar.</p>
      <a href="/" class="site-btn site-btn-primary me-2"><i class="bi bi-calendar3"></i>Open the Calendar</a>
      <a href="/blog/" class="site-btn"><i class="bi bi-journal-text"></i>All Blog Posts</a>
    </div>
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
  <p class="footer-bottom"><a href="https://buymeacoffee.com/fugec?new=1" target="_blank">Support This Project</a> | <a href="/blog/">Blog</a> | <a href="/about/">About Us</a> | <a href="/contact/">Contact</a> | <a href="/terms/">Terms and Conditions</a> | <a href="/privacy-policy/">Privacy Policy</a></p>
</footer>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
<script>
const yrEl=document.getElementById('yr');
if(yrEl)yrEl.textContent=new Date().getFullYear();
const ds=document.getElementById('tsd'),ms=document.getElementById('tsm');
const ap=d=>document.body.classList.toggle('dark-theme',d);
const gt=k=>{try{return localStorage.getItem(k)}catch{return null}};
const st=(k,v)=>{try{localStorage.setItem(k,v)}catch{}};
const dk=gt('darkTheme')!=='false';
ap(dk);if(ds)ds.checked=dk;if(ms)ms.checked=dk;
if(ds)ds.addEventListener('change',()=>{ap(ds.checked);st('darkTheme',String(ds.checked));if(ms)ms.checked=ds.checked;});
if(ms)ms.addEventListener('change',()=>{ap(ms.checked);st('darkTheme',String(ms.checked));if(ds)ds.checked=ms.checked;});

const syncAdUnitVisibility=(ins)=>{
  if(!ins) return;
  const unit=ins.closest('.ad-unit');
  if(!unit) return;
  const status=ins.getAttribute('data-ad-status');
  if(status==='unfilled') unit.style.display='none';
  if(status==='filled') unit.style.display='';
};

const adObserver=new MutationObserver((mutations)=>{
  for(const m of mutations){
    if(m.type==='attributes'&&m.attributeName==='data-ad-status'){
      syncAdUnitVisibility(m.target);
    }
  }
});

document.querySelectorAll('ins.adsbygoogle').forEach((ins)=>{
  syncAdUnitVisibility(ins);
  adObserver.observe(ins,{attributes:true,attributeFilter:['data-ad-status']});
});

setTimeout(()=>{
  document.querySelectorAll('ins.adsbygoogle').forEach(syncAdUnitVisibility);
},5000);

const initAds=()=>{
  // Avoid invalid ad requests on non-approved hosts (e.g. workers.dev previews)
  if(location.hostname!=='thisday.info'&&location.hostname!=='www.thisday.info')return;
  document.querySelectorAll('ins.adsbygoogle').forEach((ins)=>{
    if(ins.getAttribute('data-adsbygoogle-status'))return;
    if((ins.offsetWidth||0)<120)return;
    try{(adsbygoogle=window.adsbygoogle||[]).push({});}catch{}
  });
};

if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',initAds,{once:true});
}else{
  initAds();
}
setTimeout(initAds,1200);
</script>
<script async src="https://fundingchoicesmessages.google.com/i/pub-8565025017387209?ers=1"></script>
<script>(function(){function signalGooglefcPresent(){if(!window.frames['googlefcPresent']){if(document.body){const iframe=document.createElement('iframe');iframe.style='width:0;height:0;border:none;z-index:-1000;left:-1000px;top:-1000px;display:none;';iframe.name='googlefcPresent';document.body.appendChild(iframe);}else{setTimeout(signalGooglefcPresent,0);}}}signalGooglefcPresent();})();</script>
<script>(function(){var bar=document.getElementById('read-progress');if(!bar)return;document.addEventListener('scroll',function(){var doc=document.documentElement;var total=doc.scrollHeight-doc.clientHeight;var pct=total>0?Math.round((doc.scrollTop/total)*100):0;bar.style.width=pct+'%';bar.setAttribute('aria-valuenow',pct);},{passive:true});})();</script>
</body></html>`;
}

function serveGeneratedSitemap(siteUrl) {
  const today = new Date().toISOString().split("T")[0];
  let urls = "";
  for (let m = 0; m < 12; m++) {
    for (let d = 1; d <= DAYS_IN_MONTH[m]; d++) {
      urls += `  <url>\n    <loc>${siteUrl}/events/${MONTHS_ALL[m]}/${d}/</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>\n`;
      urls += `  <url>\n    <loc>${siteUrl}/quiz/${MONTHS_ALL[m]}/${d}/</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.5</priority>\n  </url>\n`;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}</urlset>`;
}

function normalizeDidYouKnowFact(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-•]\s*/, "")
    .replace(/^[^.]{2,120}\s+is directly connected to this event\.\s*/i, "")
    .replace(/\.{2,}/g, ".")
    .trim();
}

function pickRelevantWikiTitle(featuredEvent) {
  const pages = featuredEvent?.pages || [];
  if (!pages.length) return "";
  if (pages.length === 1) return pages[0]?.title || "";

  const text = String(featuredEvent?.text || "").toLowerCase();
  const stop = new Set([
    "the",
    "and",
    "with",
    "from",
    "into",
    "that",
    "this",
    "after",
    "before",
    "during",
    "were",
    "was",
    "have",
    "has",
    "had",
    "president",
    "states",
    "state",
  ]);

  const tokens = Array.from(
    new Set(
      text
        .split(/[^a-z0-9]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 5 && !stop.has(t)),
    ),
  );

  const genericTitles = new Set([
    "united states",
    "europe",
    "president of the united states",
  ]);

  let best = pages[0]?.title || "";
  let bestScore = -1;

  for (const p of pages) {
    const title = String(p?.title || "");
    const lower = title.toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      if (lower.includes(tok)) score += 2;
    }
    if (/covid|pandemic|emergency|declaration|national/i.test(lower))
      score += 4;
    if (genericTitles.has(lower)) score -= 3;
    if (title.length > 18) score += 0.5;

    if (score > bestScore) {
      bestScore = score;
      best = title;
    }
  }

  return best;
}

async function fetchWikipediaSummaryByTitle(title) {
  if (!title) return "";
  try {
    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const r = await fetch(summaryUrl, {
      headers: { "User-Agent": WIKIPEDIA_USER_AGENT },
    });
    if (!r.ok) return "";
    const data = await r.json();
    return String(data?.extract || "")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function buildTopicFallbackFacts(
  featuredEvent,
  wikiSummary = "",
  wikiTitle = "",
) {
  const year = featuredEvent?.year ? String(featuredEvent.year) : "";
  const eventText = String(featuredEvent?.text || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "");
  const summarySentences = String(wikiSummary || "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40)
    .filter(
      (s) =>
        !/\bis a country\b|\bsovereign state\b|\bprimarily located\b/i.test(s),
    )
    .slice(0, 5);

  const facts = [];

  if (eventText) {
    facts.push(
      `In ${year}, ${eventText}. This featured entry focuses on the immediate decision and its direct historical impact.`,
    );
  }

  const closers = [
    "This helps explain why the event mattered beyond the initial announcement.",
    "This clarifies the institutional and public response around the event.",
    "This shows how the event shaped policy and public communication in the same period.",
  ];

  let cIdx = 0;
  for (const sentence of summarySentences) {
    facts.push(`${sentence} ${closers[cIdx % closers.length]}`);
    cIdx += 1;
    if (facts.length >= 5) break;
  }

  while (facts.length < 5) {
    facts.push(
      `${year ? `In ${year}, ` : ""}${eventText || "this historical event"} had consequences that extended beyond the first headline. The key context is the institutions involved, the policy shift, and how the public response evolved afterward.`,
    );
  }

  return facts.map(normalizeDidYouKnowFact).slice(0, 5);
}

async function handleGeneratedPost(_request, env, ctx, url) {
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  // Expect: ['events', 'july', '20']
  if (parts.length !== 3) return new Response("Not Found", { status: 404 });
  const monthName = parts[1].toLowerCase();
  const day = parseInt(parts[2], 10);
  const monthNum = MONTH_NUM_MAP[monthName];
  const maxDay = monthNum ? DAYS_IN_MONTH[monthNum - 1] : 0;
  if (!monthNum || isNaN(day) || day < 1 || day > maxDay) {
    return new Response("Not Found", { status: 404 });
  }

  // Try KV cache (7-day TTL)
  const hostKey = (url.host || "").toLowerCase().replace(/[^a-z0-9.-]/g, "");
  const kvKey = `gen-post-v16-${hostKey}-${monthName}-${day}`;
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
  } catch (e) {
    console.error("KV read:", e);
  }

  // Fetch from Wikipedia /all/ endpoint (returns events + births + deaths)
  const mPad = String(MONTH_NUM_MAP[monthName]).padStart(2, "0");
  const dPad = String(day).padStart(2, "0");
  const apiUrl = `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/all/${mPad}/${dPad}`;
  let eventsData = { events: [], births: [], deaths: [] };
  try {
    const r = await fetch(apiUrl, {
      headers: { "User-Agent": WIKIPEDIA_USER_AGENT },
    });
    if (r.ok) eventsData = await r.json();
  } catch (e) {
    console.error("Wikipedia API:", e);
  }

  // Identify featured event and generate AI "Did You Know" facts
  const featuredEvent =
    eventsData?.events?.find((e) => e.pages?.[0]?.thumbnail?.source) ||
    eventsData?.events?.[0] ||
    null;
  let didYouKnowFacts = [];
  const wikiTitle = featuredEvent ? pickRelevantWikiTitle(featuredEvent) : "";
  const wikiSummary = featuredEvent
    ? await fetchWikipediaSummaryByTitle(wikiTitle)
    : "";

  // Run DYK and quiz generation in parallel to avoid double latency
  const [dykResult, quizResult] = await Promise.allSettled([
    // --- DYK async IIFE ---
    (async () => {
      if (!env.AI || !featuredEvent) return [];
      const eventDesc = `${featuredEvent.year} — ${featuredEvent.text}`;
      const contextChunks = [
        `Featured event: ${eventDesc}`,
        wikiTitle ? `Wikipedia article title: ${wikiTitle}` : "",
        wikiSummary ? `Wikipedia summary: ${wikiSummary}` : "",
      ].filter(Boolean);
      const aiTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("AI timeout")), 9000),
      );
      const aiResult = await Promise.race([
        env.AI.run(CF_AI_MODEL, {
          messages: [
            {
              role: "system",
              content:
                "You are a historical facts writer. Always respond with valid JSON only, no markdown, no extra text.",
            },
            {
              role: "user",
              content: `Using ONLY the featured event context below, write exactly 5 "Did You Know" paragraphs connected specifically to this one topic.\n\n${contextChunks.join("\n\n")}\n\nRules:\n- Exactly 5 items\n- Each item must be 2-3 sentences\n- Stay tightly tied to this featured event and its directly related entities\n- Do not include generic history advice, timeline instructions, or broad cross-era commentary\n- Prefer concrete names, institutions, places, and consequences mentioned in the context\n- Output ONLY a JSON array of 5 strings\n\nExample:\n["Fact one.", "Fact two.", "Fact three.", "Fact four.", "Fact five."]`,
            },
          ],
          max_tokens: 1024,
        }),
        aiTimeout,
      ]);
      const rawValue =
        aiResult.response ?? aiResult.choices?.[0]?.message?.content ?? "";
      const raw = (
        typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue)
      ).trim();
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "")
        .trim();
      const arrMatch = cleaned.match(/\[[\s\S]*\]/);
      if (arrMatch) {
        try {
          const parsed = JSON.parse(arrMatch[0]);
          if (Array.isArray(parsed) && parsed.length >= 3) {
            return parsed
              .filter((f) => typeof f === "string")
              .map(normalizeDidYouKnowFact)
              .filter(Boolean)
              .slice(0, 5);
          }
        } catch (parseErr) {
          console.error("DYK JSON.parse failed:", parseErr);
        }
      }
      return [];
    })(),
    // --- Quiz async call ---
    generateQuizForDate(
      env,
      monthName,
      day,
      eventsData,
      featuredEvent,
      wikiSummary,
    ),
  ]);

  didYouKnowFacts = dykResult.status === "fulfilled" ? dykResult.value : [];
  if (dykResult.status === "rejected")
    console.error("AI did-you-know generation failed:", dykResult.reason);

  if (featuredEvent && didYouKnowFacts.length < 5) {
    const fallbackFacts = buildTopicFallbackFacts(
      featuredEvent,
      wikiSummary,
      wikiTitle,
    );
    didYouKnowFacts = [...didYouKnowFacts, ...fallbackFacts]
      .map(normalizeDidYouKnowFact)
      .filter(Boolean)
      .slice(0, 5);
  }

  const quizData = quizResult.status === "fulfilled" ? quizResult.value : null;
  if (quizResult.status === "rejected")
    console.error("Quiz generation failed:", quizResult.reason);

  const siteUrl = "https://thisday.info";
  const mDisplayForQuiz = MONTH_DISPLAY_NAMES[monthNum];
  const quizHtml = quizData
    ? buildQuizHTML(quizData, mDisplayForQuiz, day)
    : "";

  const html = generateBlogPostHTML(
    monthName,
    day,
    eventsData,
    siteUrl,
    didYouKnowFacts,
    quizHtml,
    quizData,
  );

  // Only cache to KV when we have actual events (avoids caching API failure responses)
  if (env.EVENTS_KV && (eventsData?.events?.length || 0) > 0) {
    ctx.waitUntil(
      env.EVENTS_KV.put(kvKey, html, { expirationTtl: 7 * 24 * 60 * 60 }).catch(
        (e) => console.error("KV write:", e),
      ),
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

  if (url.pathname === "/robots.txt") {
    return new Response(
      [
        "User-agent: *",
        "Allow: /",
        "",
        `Sitemap: ${url.origin}/sitemap.xml`,
        `Sitemap: ${url.origin}/sitemap-generated.xml`,
        `Sitemap: ${url.origin}/news-sitemap.xml`,
      ].join("\n"),
      {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
        },
      },
    );
  }

  if (url.pathname === "/llms.txt") {
    const llmsContent = `# Site Summary for Large Language Models...`; // your content
    return new Response(llmsContent, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // Image proxy — must be handled before the HTML pass-through guard
  if (url.pathname === "/image-proxy" || url.pathname === "/img") {
    return handleImageProxy(request, url, ctx);
  }

  // Wikipedia events proxy — avoids CORS issues from direct browser requests
  const eventsProxyMatch = url.pathname.match(
    /^\/api\/events\/(\d{2})\/(\d{2})$/,
  );
  if (eventsProxyMatch) {
    const mm = eventsProxyMatch[1];
    const dd = eventsProxyMatch[2];
    const apiUrl = `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/all/${mm}/${dd}`;
    const corsHeaders = {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    };

    const workerCache = caches.default;
    const cacheKey = new Request(apiUrl);
    const cached = await workerCache.match(cacheKey);
    if (cached) {
      const body = await cached.text();
      return new Response(body, { headers: corsHeaders });
    }

    try {
      const r = await fetch(apiUrl, {
        headers: { "User-Agent": WIKIPEDIA_USER_AGENT },
      });
      if (!r.ok) throw new Error(r.statusText);
      const body = await r.text();
      ctx.waitUntil(
        workerCache.put(
          cacheKey,
          new Response(body, {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "public, max-age=86400",
            },
          }),
        ),
      );
      return new Response(body, { headers: corsHeaders });
    } catch (e) {
      console.error("Events proxy error:", e);
      return new Response(
        JSON.stringify({ events: [], births: [], deaths: [] }),
        { headers: corsHeaders },
      );
    }
  }

  // Legacy generated URLs -> /events (SEO-friendly permanent redirect)
  if (url.pathname === "/generated" || url.pathname === "/generated/") {
    return Response.redirect(`${url.origin}/events/`, 301);
  }
  if (url.pathname.startsWith("/generated/")) {
    const targetPath = url.pathname.replace(/^\/generated(?=\/|$)/, "/events");
    return Response.redirect(`${url.origin}${targetPath}${url.search}`, 301);
  }

  // /events landing -> today's date page
  if (url.pathname === "/events" || url.pathname === "/events/") {
    const now = new Date();
    const mn = MONTHS_ALL[now.getUTCMonth()];
    const dd = now.getUTCDate();
    return Response.redirect(`${url.origin}/events/${mn}/${dd}/`, 302);
  }

  // /quiz/ or /quiz → today's quiz
  if (url.pathname === "/quiz" || url.pathname === "/quiz/") {
    const now = new Date();
    const mn = MONTHS_ALL[now.getUTCMonth()];
    const dd = now.getUTCDate();
    return Response.redirect(`${url.origin}/quiz/${mn}/${dd}/`, 302);
  }

  // Quiz standalone pages: /quiz/{month}/{day}/
  const quizPageMatch = url.pathname.match(/^\/quiz\/([a-z]+)\/(\d+)\/?$/);
  if (quizPageMatch) {
    const monthSlug = quizPageMatch[1];
    const day = parseInt(quizPageMatch[2], 10);
    return handleQuizPage(request, env, monthSlug, day);
  }

  // Quiz API: /api/quiz/{month}/{day} — returns raw JSON
  const quizApiMatch = url.pathname.match(/^\/api\/quiz\/([a-z]+)\/(\d+)$/);
  if (quizApiMatch) {
    const monthSlug = quizApiMatch[1];
    const day = parseInt(quizApiMatch[2], 10);
    const monthNum = MONTH_NUM_MAP[monthSlug];
    if (
      !monthNum ||
      isNaN(day) ||
      day < 1 ||
      day > DAYS_IN_MONTH[monthNum - 1]
    ) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    const mm = String(monthNum).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    const kvKey = `quiz:${mm}-${dd}`;
    try {
      const cached = await env.EVENTS_KV.get(kvKey);
      if (cached) {
        return new Response(cached, {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=3600",
          },
        });
      }
    } catch (e) {
      /* ignore */
    }
    return new Response(JSON.stringify({ error: "Quiz not yet generated" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // Events pages — must be before the HTML pass-through guard
  if (url.pathname.startsWith("/events/")) {
    return handleGeneratedPost(request, env, ctx, url);
  }

  // Generated sitemap listing all 366 /events/ pages
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
      (e) => e.pages?.[0]?.thumbnail?.source,
    );
    if (firstWithImage) {
      const rawImgUrl = firstWithImage.pages[0].thumbnail.source;
      // Route through the image proxy: resizes to 1200px and caches at edge for 30 days
      ogImageUrl = `/image-proxy?src=${encodeURIComponent(rawImgUrl)}&w=1200&q=82`;
    }

    // Pick the top 3-5 events for a concise description
    const topEvents = eventsData.events
      .slice(0, 5)
      .map((event) => `In ${event.year}, ${event.text}`)
      .join("; ");

    const firstEventText = eventsData.events[0].text;
    const titleSnippet =
      firstEventText.length > 65
        ? firstEventText.substring(0, firstEventText.lastIndexOf(" ", 65)) +
          "..."
        : firstEventText;
    dynamicTitle = `On This Day, ${formattedDate}: ${eventsData.events[0].year}, ${titleSnippet} | thisDay.info`;

    const rawDesc = `Discover what happened on ${formattedDate}: ${topEvents}. Explore historical events, births, and deaths.`;
    dynamicDescription =
      rawDesc.length > 155
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
                birthItem.pages &&
                birthItem.pages.length > 0 &&
                birthItem.pages[0].content_urls?.desktop?.page
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
                deathItem.pages &&
                deathItem.pages.length > 0 &&
                deathItem.pages[0].content_urls?.desktop?.page
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
                text:
                  eventsData?.births?.length > 0
                    ? `Notable people born on ${formattedDate} include: ${eventsData.births
                        .slice(0, 3)
                        .map((b) => b.text.split(",")[0])
                        .join(", ")}. Browse the full list on thisDay.info.`
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
          `<script>window.__todayGeneratedUrl="/events/${mn}/${dd}/";</script>`,
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
        '<link rel="alternate" type="application/rss+xml" title="thisDay. — On This Day in History" href="https://thisday.info/rss.xml">\n' +
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
    `connect-src 'self' https://api.wikimedia.org https://en.wikipedia.org https://cdn.jsdelivr.net ` +
    `https://www.google-analytics.com https://www.google.com https://www.gstatic.com ` +
    `https://www.googleadservices.com https://pagead2.googlesyndication.com ` +
    `https://*.adtrafficquality.google https://*.doubleclick.net ` +
    `https://fundingchoicesmessages.google.com https://www.googletagmanager.com; ` +
    `script-src 'self' https://cdn.jsdelivr.net https://consent.cookiebot.com https://www.googletagmanager.com https://www.googleadservices.com https://googleads.g.doubleclick.net https://pagead2.googlesyndication.com https://static.cloudflareinsights.com https://*.adtrafficquality.google https://fundingchoicesmessages.google.com 'unsafe-inline'; ` +
    `style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; ` +
    `img-src 'self' data: https://upload.wikimedia.org https://cdn.buymeacoffee.com https://imgsct.cookiebot.com https://www.google.com https://www.google.ba https://www.googleadservices.com https://pagead2.googlesyndication.com https://placehold.co https://www.googletagmanager.com https://i.ytimg.com https://*.adtrafficquality.google https://*.doubleclick.net https://fundingchoicesmessages.google.com; ` +
    `font-src 'self' https://cdn.jsdelivr.net https://fonts.gstatic.com; ` +
    `frame-src https://consentcdn.cookiebot.com https://td.doubleclick.net https://www.googletagmanager.com https://www.google.com https://www.youtube.com https://googleads.g.doubleclick.net https://*.adtrafficquality.google https://fundingchoicesmessages.google.com; ` +
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
      "<https://fonts.googleapis.com>; rel=preconnect",
      "<https://fonts.gstatic.com>; rel=preconnect; crossorigin",
      "<https://cdn.jsdelivr.net>; rel=preconnect; crossorigin",
      "<https://api.wikimedia.org>; rel=dns-prefetch",
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
      console.log(
        `Successfully pre-fetched and stored events for ${isoDateKey} in KV.`,
      );
    } catch (e) {
      console.error("Failed to put data into KV:", e);
    }
  } else {
    console.warn("No events data fetched, not updating KV.");
  }

  // Pre-generate today's quiz
  try {
    const monthSlug = MONTHS_ALL[today.getUTCMonth()];
    const day = today.getUTCDate();
    const featuredEvent =
      eventsData?.events?.find((e) => e.pages?.[0]?.thumbnail?.source) ||
      eventsData?.events?.[0] ||
      null;
    const wikiTitle = featuredEvent ? pickRelevantWikiTitle(featuredEvent) : "";
    const wikiSummary = wikiTitle
      ? await fetchWikipediaSummaryByTitle(wikiTitle)
      : "";
    await generateQuizForDate(
      env,
      monthSlug,
      day,
      eventsData,
      featuredEvent,
      wikiSummary,
    );
    console.log(`Quiz pre-generated for ${monthSlug}/${day}.`);
  } catch (e) {
    console.error("Quiz pre-generation failed:", e);
  }
}

// --- Quiz: Generate quiz for a date using AI ---
async function generateQuizForDate(
  env,
  monthName,
  day,
  eventsData,
  featuredEvent,
  wikiSummary,
) {
  const mm = String(MONTH_NUM_MAP[monthName]).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const kvKey = `quiz:${mm}-${dd}`;

  try {
    const cached = await env.EVENTS_KV.get(kvKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      const hasTruncatedFallbackQuestion = Array.isArray(parsed?.questions)
        ? parsed.questions.some((q) => {
            const text = String(q?.q || "");
            return (
              /^In which year did\s+"/i.test(text) &&
              (text.includes("…") || /\.\.\./.test(text))
            );
          })
        : false;

      if (!hasTruncatedFallbackQuestion) {
        return parsed;
      }
    }
  } catch (e) {
    // ignore cache miss errors
  }

  const mDisplay = MONTH_DISPLAY_NAMES[MONTH_NUM_MAP[monthName]];
  const events = eventsData?.events || [];
  const births = eventsData?.births || [];

  const contextLines = [];
  if (featuredEvent)
    contextLines.push(
      `Featured event: ${featuredEvent.year} — ${featuredEvent.text}`,
    );
  if (wikiSummary)
    contextLines.push(`Wikipedia context: ${wikiSummary.substring(0, 300)}`);
  events
    .slice(0, 5)
    .forEach((e) =>
      contextLines.push(`Event: ${e.year} — ${e.text.substring(0, 100)}`),
    );
  births
    .slice(0, 3)
    .forEach((b) =>
      contextLines.push(`Birth: ${b.year} — ${b.text.substring(0, 80)}`),
    );

  let quiz = null;

  if (env.AI && contextLines.length > 0) {
    try {
      const aiTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("AI timeout")), 12000),
      );
      const aiResult = await Promise.race([
        env.AI.run(CF_AI_MODEL, {
          messages: [
            {
              role: "system",
              content:
                "You are a history quiz creator. Always respond with valid JSON only, no markdown, no extra text.",
            },
            {
              role: "user",
              content: `Generate a 5-question multiple choice quiz about historical events on ${mDisplay} ${day}.\n\nContext:\n${contextLines.join("\n")}\n\nRules:\n- Exactly 5 questions\n- Each question has exactly 4 options\n- Exactly one correct answer per question (0-based index in "answer")\n- Questions must be specific, fact-based, preferring cause/consequence/location over year questions\n- "topic" must be 5 words or fewer naming the featured event\n- "sourceEvent" is the full event text\n- Output ONLY valid JSON:\n{"topic":"string","sourceEvent":"string","questions":[{"q":"Question?","options":["A","B","C","D"],"answer":0,"explanation":"1-2 sentence explanation of correct answer"}]}`,
            },
          ],
          max_tokens: 1500,
        }),
        aiTimeout,
      ]);

      const rawValue =
        aiResult.response ?? aiResult.choices?.[0]?.message?.content ?? "";
      const raw = (
        typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue)
      ).trim();
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "")
        .trim();
      const objMatch = cleaned.match(/\{[\s\S]*\}/);
      if (objMatch) {
        const parsed = JSON.parse(objMatch[0]);
        if (Array.isArray(parsed?.questions) && parsed.questions.length >= 3) {
          // Validate each question has required fields — drop malformed ones
          const valid = parsed.questions.filter(
            (q) =>
              q.q &&
              Array.isArray(q.options) &&
              q.options.length === 4 &&
              typeof q.answer === "number" &&
              q.answer >= 0 &&
              q.answer <= 3,
          );
          if (valid.length >= 3) quiz = { ...parsed, questions: valid };
        }
      }
    } catch (e) {
      console.error("Quiz AI generation failed:", e);
    }
  }

  if (!quiz) quiz = buildFallbackQuiz(mDisplay, day, eventsData);

  try {
    await env.EVENTS_KV.put(kvKey, JSON.stringify(quiz), {
      expirationTtl: 24 * 60 * 60,
    });
  } catch (e) {
    // ignore storage error
  }

  return quiz;
}

function buildFallbackQuiz(mDisplay, day, eventsData) {
  const events = (eventsData?.events || []).filter((e) => e.year && e.text);
  const questions = [];

  for (const e of events.slice(0, 5)) {
    const yr = Number(e.year);
    const fullEventText = String(e.text || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.\s]+$/, "");
    questions.push({
      q: `In which year did "${fullEventText}" occur on ${mDisplay} ${day}?`,
      options: [
        String(yr),
        String(Math.max(1, yr - 12)),
        String(yr + 8),
        String(Math.max(1, yr - 25)),
      ],
      answer: 0,
    });
  }

  const genericPad = [
    {
      q: `How many days does ${mDisplay} typically have?`,
      options: ["28 or 29", "30", "31", "27"],
      answer: ["April", "June", "September", "November"].includes(mDisplay)
        ? 1
        : mDisplay === "February"
          ? 0
          : 2,
    },
    {
      q: `${mDisplay} is which month of the year?`,
      options: ["1st–3rd", "4th–6th", "7th–9th", "10th–12th"],
      answer: [1, 2, 3].includes(MONTH_NUM_MAP[mDisplay?.toLowerCase?.()] ?? 0)
        ? 0
        : [4, 5, 6].includes(MONTH_NUM_MAP[mDisplay?.toLowerCase?.()] ?? 0)
          ? 1
          : [7, 8, 9].includes(MONTH_NUM_MAP[mDisplay?.toLowerCase?.()] ?? 0)
            ? 2
            : 3,
    },
    {
      q: "Which hemisphere experiences winter in December?",
      options: ["Northern", "Southern", "Both", "Neither"],
      answer: 0,
    },
    {
      q: "What does 'A.D.' stand for in historical dates?",
      options: ["After Death", "Anno Domini", "Ancient Days", "Annual Date"],
      answer: 1,
    },
    {
      q: "Which calendar system is most widely used for modern historical dating?",
      options: ["Julian", "Gregorian", "Hebrew", "Islamic"],
      answer: 1,
    },
  ];

  let padIdx = 0;
  while (questions.length < 5) {
    questions.push(genericPad[padIdx % genericPad.length]);
    padIdx++;
  }

  return { questions: questions.slice(0, 5) };
}

function buildQuizHTML(quiz, monthDisplay, day) {
  if (!quiz?.questions?.length) return "";

  const questionsHtml = quiz.questions
    .map((q, qi) => {
      const optsHtml = (q.options || [])
        .map(
          (opt, oi) =>
            `<div class="tdq-opt" data-qi="${qi}" data-oi="${oi}" role="radio" aria-checked="false" tabindex="0">` +
            `<span class="tdq-opt-key">${String.fromCharCode(65 + oi)}</span>${escapeHtml(String(opt))}` +
            `</div>`,
        )
        .join("");
      return (
        `<div class="tdq-question" id="tdq-q-${qi}">` +
        `<p class="tdq-q-text"><strong>${qi + 1}.</strong> ${escapeHtml(String(q.q))}</p>` +
        `<div class="tdq-options">${optsHtml}</div>` +
        `<div class="tdq-feedback" id="tdq-f-${qi}" hidden></div>` +
        (q.explanation
          ? `<div class="tdq-explanation" id="tdq-e-${qi}" hidden>${escapeHtml(String(q.explanation))}</div>`
          : "") +
        `</div>`
      );
    })
    .join("");

  const answersJson = JSON.stringify(
    quiz.questions.map((q) => Number(q.answer)),
  );

  return (
    `<div class="card-box" id="tdq-widget">` +
    `<h2 class="h4 mb-3"><i class="bi bi-patch-question-fill me-2" style="color:#f59e0b"></i>Test Your Knowledge — ${escapeHtml(monthDisplay)} ${day}</h2>` +
    `<p class="text-muted mb-2" style="font-size:.9rem">How well do you know the history of ${escapeHtml(monthDisplay)} ${day}? Answer these 5 questions to find out.</p>` +
    `<a href="/quiz/${escapeHtml(monthDisplay.toLowerCase())}/${day}/" class="site-btn mb-3"><i class="bi bi-list-check"></i>Full quiz page</a>` +
    `<div id="tdq-questions">${questionsHtml}</div>` +
    `<button class="btn btn-warning mt-3" id="tdq-submit-btn"><i class="bi bi-check2-circle"></i>Check Answers</button>` +
    `<div id="tdq-score" class="mt-3" hidden></div>` +
    `</div>` +
    `<script>(function(){` +
    `var answers=${answersJson};` +
    `var selected={};` +
    `document.querySelectorAll('.tdq-opt').forEach(function(opt){` +
    `opt.addEventListener('click',function(){` +
    `var qi=parseInt(this.dataset.qi),oi=parseInt(this.dataset.oi);` +
    `selected[qi]=oi;` +
    `document.querySelectorAll('[data-qi="'+qi+'"]').forEach(function(o){o.classList.remove('tdq-opt-selected');o.setAttribute('aria-checked','false');});` +
    `this.classList.add('tdq-opt-selected');this.setAttribute('aria-checked','true');` +
    `});` +
    `});` +
    `document.getElementById('tdq-submit-btn').addEventListener('click',function(){` +
    `var score=0;` +
    `answers.forEach(function(correct,qi){` +
    `var chosen=selected[qi]!==undefined?selected[qi]:-1;` +
    `var fb=document.getElementById('tdq-f-'+qi);` +
    `var opts=document.querySelectorAll('[data-qi="'+qi+'"]');` +
    `fb.hidden=false;` +
    `opts.forEach(function(o){o.style.pointerEvents='none';});` +
    `opts[correct].classList.add('tdq-opt-correct');` +
    `if(chosen===correct){score++;fb.innerHTML='<span class="tdq-correct">✓ Correct!</span>';}` +
    `else{if(chosen>=0)opts[chosen].classList.add('tdq-opt-wrong');` +
    `fb.innerHTML='<span class="tdq-wrong">✗ Incorrect.</span> Correct answer: <strong>'+String.fromCharCode(65+correct)+'</strong>';}` +
    `var exp=document.getElementById('tdq-e-'+qi);if(exp)exp.hidden=false;` +
    `});` +
    `this.hidden=true;` +
    `var pct=Math.round(score/answers.length*100);` +
    `var msg=pct===100?'Perfect score!':pct>=80?'Excellent!':pct>=60?'Good job!':'Keep learning!';` +
    `var el=document.getElementById('tdq-score');` +
    `el.hidden=false;` +
    `el.innerHTML='<div class="tdq-score-box">You scored <span class="tdq-score-num">'+score+'/'+answers.length+'</span> ('+pct+'%) — '+msg+'</div>';` +
    `});` +
    `})();</script>`
  );
}

// ---------------------------------------------------------------------------
// Carousel quiz page builder — one event + one question per slide
// ---------------------------------------------------------------------------
function buildCarouselQuizHTML(quiz, topEvents, _monthDisplay, day, monthSlug, nextMonthSlug, nextDay) {
  if (!quiz?.questions?.length) return "<p class='text-muted'>Quiz unavailable for this date.</p>";

  const answers = quiz.questions.map((q) => Number(q.answer));
  const answersJson = JSON.stringify(answers);
  const total = Math.min(quiz.questions.length, 5);

  // Build slides — one per question
  const slidesHtml = quiz.questions.slice(0, total).map((q, qi) => {
    const ev = topEvents[qi] || topEvents[0] || null;
    const imgSrc = ev?.pages?.[0]?.thumbnail?.source || "";
    const imgAlt = ev?.pages?.[0]?.title || "";
    const evYear = ev?.year ? String(ev.year) : "";
    const evText = ev?.text ? escapeHtml(ev.text.split(".")[0].substring(0, 120)) : "";
    const wikiUrl = ev?.pages?.[0]?.content_urls?.desktop?.page || "";

    const imgHtml = imgSrc
      ? `<div class="qsc-img-wrap"><img src="${escapeHtml(imgSrc)}" alt="${escapeHtml(imgAlt)}" class="qsc-event-img" loading="${qi === 0 ? "eager" : "lazy"}"/><div class="qsc-img-overlay"></div>${evYear ? `<span class="qsc-year-pill">${escapeHtml(evYear)}</span>` : ""}</div>`
      : `<div class="qsc-img-wrap qsc-img-placeholder"><div class="qsc-img-overlay"></div>${evYear ? `<span class="qsc-year-pill">${escapeHtml(evYear)}</span>` : ""}</div>`;

    const evContextHtml = evText
      ? `<p class="qsc-event-text">${evText}${wikiUrl ? ` <a href="${escapeHtml(wikiUrl)}" target="_blank" rel="noopener" class="qsc-wiki-link" title="Read on Wikipedia"><i class="bi bi-box-arrow-up-right"></i></a>` : ""}</p>`
      : "";

    const optsHtml = (q.options || []).map((opt, oi) =>
      `<div class="tdq-opt qsc-opt" data-qi="${qi}" data-oi="${oi}" role="radio" aria-checked="false" tabindex="0">` +
      `<span class="tdq-opt-key">${String.fromCharCode(65 + oi)}</span>${escapeHtml(String(opt))}` +
      `</div>`
    ).join("");

    const expHtml = q.explanation
      ? `<div class="tdq-explanation qsc-explanation" id="tdq-e-${qi}" hidden>${escapeHtml(String(q.explanation))}</div>`
      : "";

    return `<div class="qsc-slide${qi === 0 ? " qsc-active" : ""}" data-slide="${qi}" id="qsc-slide-${qi}">` +
      imgHtml +
      `<div class="qsc-slide-body">` +
      evContextHtml +
      `<div class="qsc-q-label"><i class="bi bi-patch-question-fill me-1" style="color:#f59e0b"></i>Question ${qi + 1} of ${total}</div>` +
      `<p class="tdq-q-text qsc-q-text">${escapeHtml(String(q.q))}</p>` +
      `<div class="tdq-options qsc-opts-wrap">${optsHtml}</div>` +
      `<div class="tdq-feedback qsc-feedback" id="tdq-f-${qi}" hidden></div>` +
      expHtml +
      `<button class="qsc-next-btn" data-slide="${qi}" hidden>` +
      (qi < total - 1 ? `Next Question <i class="bi bi-arrow-right"></i>` : `See Results <i class="bi bi-trophy-fill"></i>`) +
      `</button>` +
      `</div></div>`;
  }).join("");

  // Final score slide
  const nextLink = nextMonthSlug && nextDay
    ? `<a href="/quiz/${escapeHtml(nextMonthSlug)}/${nextDay}/" class="qsc-cta-btn qsc-cta-primary"><i class="bi bi-arrow-right-circle"></i>Next Day's Quiz</a>`
    : "";
  const scoreSlide =
    `<div class="qsc-slide qsc-final-slide" data-slide="${total}" id="qsc-slide-${total}">` +
    `<div class="qsc-final-body">` +
    `<div class="qsc-trophy-wrap"><i class="bi bi-trophy-fill qsc-trophy-icon"></i></div>` +
    `<div class="tdq-score-box qsc-final-score" id="qsc-final-score">` +
    `You scored <span class="tdq-score-num" id="qsc-score-num">0/${total}</span> — <span id="qsc-msg">Keep learning!</span>` +
    `</div>` +
    `<div class="qsc-review-list" id="qsc-review-list"></div>` +
    `<div class="qsc-cta-row">` +
    `<a href="/events/${escapeHtml(monthSlug)}/${day}/" class="qsc-cta-btn"><i class="bi bi-calendar-event"></i>See All Events</a>` +
    `<a href="/blog/" class="qsc-cta-btn"><i class="bi bi-journal-text"></i>Read the Blog</a>` +
    nextLink +
    `</div></div></div>`;

  // Progress dots
  const dotsHtml = Array.from({ length: total }, (_, i) =>
    `<button class="qsc-dot${i === 0 ? " qsc-dot-active" : ""}" data-dot="${i}" aria-label="Question ${i + 1}" title="Q${i + 1}"></button>`
  ).join("");

  return (
    // Progress bar + dots
    `<div class="qsc-progress-wrap">` +
    `<div class="qsc-progress-track"><div class="qsc-progress-fill" id="qsc-bar" style="width:0%"></div></div>` +
    `<div class="qsc-dots-row">${dotsHtml}</div>` +
    `<p class="qsc-progress-label" id="qsc-progress-label">Question 1 of ${total}</p>` +
    `</div>` +
    // Back button
    `<div class="qsc-nav-row">` +
    `<button id="qsc-prev" class="qsc-back-btn" disabled><i class="bi bi-arrow-left"></i> Back</button>` +
    `<span class="qsc-hint" id="qsc-hint">Select an answer to continue</span>` +
    `</div>` +
    // Carousel
    `<div id="qsc-wrapper">${slidesHtml}${scoreSlide}</div>` +
    // Inline script
    `<script>(function(){` +
    `var answers=${answersJson};` +
    `var total=${total};` +
    `var cur=0;` +
    `var selected={};` +
    `var results={};` +
    `var score=0;` +
    // Show slide
    `function showSlide(n){` +
    `document.querySelectorAll('.qsc-slide').forEach(function(s){s.classList.remove('qsc-active');});` +
    `var s=document.getElementById('qsc-slide-'+n);if(s)s.classList.add('qsc-active');` +
    `cur=n;updateProgress(n);` +
    `document.getElementById('qsc-prev').disabled=(n===0);` +
    `}` +
    // Update progress
    `function updateProgress(n){` +
    `var pct=Math.round((n/total)*100);` +
    `document.getElementById('qsc-bar').style.width=pct+'%';` +
    `var lbl=document.getElementById('qsc-progress-label');` +
    `if(n<total){lbl.textContent='Question '+(n+1)+' of '+total;}else{lbl.textContent='Quiz complete!';document.getElementById('qsc-bar').style.width='100%';}` +
    `document.querySelectorAll('.qsc-dot').forEach(function(d,i){` +
    `d.classList.remove('qsc-dot-active','qsc-dot-done','qsc-dot-wrong');` +
    `if(i===n)d.classList.add('qsc-dot-active');` +
    `else if(results[i]===true)d.classList.add('qsc-dot-done');` +
    `else if(results[i]===false)d.classList.add('qsc-dot-wrong');` +
    `});` +
    `}` +
    // Handle option click
    `document.querySelectorAll('.qsc-opt').forEach(function(opt){` +
    `opt.addEventListener('click',function(){` +
    `var qi=parseInt(this.dataset.qi),oi=parseInt(this.dataset.oi);` +
    `if(selected[qi]!==undefined)return;` +
    `selected[qi]=oi;` +
    `document.querySelectorAll('[data-qi="'+qi+'"]').forEach(function(o){o.classList.remove('tdq-opt-selected');o.setAttribute('aria-checked','false');});` +
    `this.classList.add('tdq-opt-selected');this.setAttribute('aria-checked','true');` +
    `setTimeout(function(){evaluate(qi);},280);` +
    `});` +
    `});` +
    // Evaluate answer
    `function evaluate(qi){` +
    `var chosen=selected[qi];var correct=answers[qi];` +
    `var opts=document.querySelectorAll('[data-qi="'+qi+'"]');` +
    `var fb=document.getElementById('tdq-f-'+qi);` +
    `var exp=document.getElementById('tdq-e-'+qi);` +
    `opts.forEach(function(o){o.style.pointerEvents='none';});` +
    `opts[correct].classList.add('tdq-opt-correct');` +
    `if(chosen===correct){score++;results[qi]=true;fb.innerHTML='<span class="tdq-correct"><i class="bi bi-check-circle-fill me-1"></i>Correct!</span>';}` +
    `else{results[qi]=false;if(chosen>=0&&opts[chosen])opts[chosen].classList.add('tdq-opt-wrong');fb.innerHTML='<span class="tdq-wrong"><i class="bi bi-x-circle-fill me-1"></i>Incorrect.</span> Correct: <strong>'+String.fromCharCode(65+correct)+'</strong>';}` +
    `fb.hidden=false;if(exp)exp.hidden=false;` +
    `var nb=document.querySelector('.qsc-next-btn[data-slide="'+qi+'"]');if(nb)nb.hidden=false;` +
    `document.getElementById('qsc-hint').textContent='';` +
    `updateProgress(cur);` +
    `}` +
    // Next buttons
    `document.querySelectorAll('.qsc-next-btn').forEach(function(btn){` +
    `btn.addEventListener('click',function(){` +
    `var next=parseInt(this.dataset.slide)+1;` +
    `showSlide(next);` +
    `if(next===total)showFinal();` +
    `document.getElementById('qsc-hint').textContent=next<total?'Select an answer to continue':'';` +
    `});` +
    `});` +
    // Dot nav
    `document.querySelectorAll('.qsc-dot').forEach(function(d){` +
    `d.addEventListener('click',function(){` +
    `var i=parseInt(this.dataset.dot);` +
    `if(results[i]!==undefined||i<cur)showSlide(i);` +
    `});` +
    `});` +
    // Back button
    `document.getElementById('qsc-prev').addEventListener('click',function(){if(cur>0)showSlide(cur-1);});` +
    // Touch swipe
    `var tx=0;` +
    `var wrap=document.getElementById('qsc-wrapper');` +
    `wrap.addEventListener('touchstart',function(e){tx=e.touches[0].clientX;},{passive:true});` +
    `wrap.addEventListener('touchend',function(e){` +
    `var dx=e.changedTouches[0].clientX-tx;` +
    `if(dx<-40&&results[cur]!==undefined){var nb=document.querySelector('.qsc-next-btn[data-slide="'+cur+'"]');if(nb)nb.click();}` +
    `if(dx>40&&cur>0)showSlide(cur-1);` +
    `},{passive:true});` +
    // Final score
    `function showFinal(){` +
    `var pct=Math.round((score/total)*100);` +
    `var msg=pct===100?'Perfect score! \uD83C\uDF89':pct>=80?'Excellent work!':pct>=60?'Good job!':'Keep exploring!';` +
    `document.getElementById('qsc-score-num').textContent=score+'/'+total;` +
    `document.getElementById('qsc-msg').textContent=msg;` +
    `var rev='';` +
    `for(var i=0;i<total;i++){var ok=results[i];rev+='<div class="qsc-rev-item"><span class="'+(ok?'tdq-correct':'tdq-wrong')+'">'+(ok?'<i class=\"bi bi-check-circle-fill\"></i>':'<i class=\"bi bi-x-circle-fill\"></i>')+'</span><span>Q'+(i+1)+': '+(ok?'Correct':'Incorrect')+'</span></div>';}` +
    `document.getElementById('qsc-review-list').innerHTML=rev;` +
    `if(pct>=60)confetti();` +
    `}` +
    // Confetti
    `function confetti(){` +
    `var c=document.createElement('canvas');` +
    `c.style='position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999';` +
    `document.body.appendChild(c);` +
    `c.width=innerWidth;c.height=innerHeight;` +
    `var ctx=c.getContext('2d');` +
    `var cols=['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4'];` +
    `var pts=[];` +
    `for(var i=0;i<90;i++)pts.push({x:Math.random()*c.width,y:Math.random()*-c.height*.6,r:3+Math.random()*6,` +
    `col:cols[i%cols.length],vx:(Math.random()-.5)*4,vy:3+Math.random()*5,a:1,rot:Math.random()*360,rv:(Math.random()-.5)*8});` +
    `var fr=0;` +
    `function draw(){ctx.clearRect(0,0,c.width,c.height);` +
    `pts.forEach(function(p){ctx.save();ctx.globalAlpha=p.a;ctx.fillStyle=p.col;ctx.translate(p.x,p.y);ctx.rotate(p.rot*Math.PI/180);ctx.fillRect(-p.r/2,-p.r/2,p.r,p.r);ctx.restore();` +
    `p.x+=p.vx;p.y+=p.vy;p.rot+=p.rv;p.a-=.011;});` +
    `fr++;if(fr<130)requestAnimationFrame(draw);else c.remove();}` +
    `requestAnimationFrame(draw);}` +
    `showSlide(0);` +
    `})();</script>`
  );
}

async function handleQuizPage(_request, env, monthSlug, day) {
  const monthNum = MONTH_NUM_MAP[monthSlug];
  if (!monthNum || isNaN(day) || day < 1 || day > DAYS_IN_MONTH[monthNum - 1]) {
    return new Response("Not Found", { status: 404 });
  }

  const mDisplay = MONTH_DISPLAY_NAMES[monthNum];
  const mPad = String(monthNum).padStart(2, "0");
  const dPad = String(day).padStart(2, "0");
  const apiUrl = `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/all/${mPad}/${dPad}`;
  let eventsData = { events: [], births: [], deaths: [] };
  try {
    const r = await fetch(apiUrl, {
      headers: { "User-Agent": WIKIPEDIA_USER_AGENT },
    });
    if (r.ok) eventsData = await r.json();
  } catch (e) {
    console.error("Quiz page Wikipedia fetch:", e);
  }

  const featuredEvent =
    eventsData?.events?.find((e) => e.pages?.[0]?.thumbnail?.source) ||
    eventsData?.events?.[0] ||
    null;
  const wikiTitle = featuredEvent ? pickRelevantWikiTitle(featuredEvent) : "";
  const wikiSummary = wikiTitle
    ? await fetchWikipediaSummaryByTitle(wikiTitle)
    : "";

  const quiz = await generateQuizForDate(
    env,
    monthSlug,
    day,
    eventsData,
    featuredEvent,
    wikiSummary,
  );
  // Gather top events with images for carousel slides
  const topEvents = [];
  const evAll = eventsData?.events || [];
  for (const e of evAll) { if (e.pages?.[0]?.thumbnail?.source && topEvents.length < 5) topEvents.push(e); }
  for (const e of evAll) { if (!e.pages?.[0]?.thumbnail?.source && topEvents.length < 5) topEvents.push(e); }

  // Next day for CTA
  const _nd = new Date(Date.UTC(new Date().getUTCFullYear(), MONTH_NUM_MAP[monthSlug] - 1, day + 1));
  const nextMonthSlug = MONTHS_ALL[_nd.getUTCMonth()];
  const nextDay = _nd.getUTCDate();

  const carouselHtml = buildCarouselQuizHTML(quiz, topEvents, mDisplay, day, monthSlug, nextMonthSlug, nextDay);
  const siteUrl = "https://thisday.info";
  const canonical = `${siteUrl}/quiz/${monthSlug}/${day}/`;
  const _d = new Date();
  const todaySlug = MONTHS_ALL[_d.getUTCMonth()];
  const todayDay = _d.getUTCDate();

  const quizPageDesc = quiz?.topic
    ? `Think you know what happened on ${mDisplay} ${day}? Take our free 5-question history quiz on ${quiz.topic} and test your knowledge of this date's defining events.`.slice(
        0,
        158,
      )
    : `Test your knowledge of historical events on ${mDisplay} ${day}. A free 5-question multiple choice quiz covering key events, people, and milestones on this date.`;

  const quizPageTitle = quiz?.topic
    ? `${mDisplay} ${day} Quiz: ${quiz.topic} | thisDay.info`
    : `${mDisplay} ${day} History Quiz — 5 Questions | thisDay.info`;

  const quizPageSchema = quiz?.questions?.length
    ? JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Quiz",
        name: quizPageTitle.replace(" | thisDay.info", ""),
        description: quizPageDesc,
        url: canonical,
        educationalLevel: "beginner",
        learningResourceType: "quiz",
        ...(quiz.topic
          ? {
              about: {
                "@type": "Event",
                name: quiz.topic,
                description: quiz.sourceEvent || "",
              },
            }
          : {}),
        publisher: {
          "@type": "Organization",
          name: "thisday.info",
          url: siteUrl,
        },
        hasPart: quiz.questions.map((q) => ({
          "@type": "Question",
          name: q.q,
          acceptedAnswer: {
            "@type": "Answer",
            text: q.options?.[q.answer] ?? "",
          },
        })),
      }).replace(/<\//g, "<\\/")
    : null;

  const ogImg = featuredEvent?.pages?.[0]?.thumbnail?.source
    ? escapeHtml(featuredEvent.pages[0].thumbnail.source)
    : `${siteUrl}/images/logo.png`;

  const breadcrumbSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: siteUrl },
      { "@type": "ListItem", position: 2, name: `${mDisplay} ${day}`, item: `${siteUrl}/events/${monthSlug}/${day}/` },
      { "@type": "ListItem", position: 3, name: "Quiz", item: canonical },
    ],
  }).replace(/<\//g, "<\\/");

  const html = `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${escapeHtml(quizPageTitle)}</title>
<link rel="canonical" href="${escapeHtml(canonical)}"/>
<meta name="robots" content="index, follow"/>
<meta name="description" content="${escapeHtml(quizPageDesc)}"/>
<meta property="og:title" content="${escapeHtml(quizPageTitle)}"/>
<meta property="og:description" content="${escapeHtml(quizPageDesc)}"/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="${escapeHtml(canonical)}"/>
<meta property="og:image" content="${ogImg}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${escapeHtml(quizPageTitle)}"/>
<meta name="twitter:description" content="${escapeHtml(quizPageDesc)}"/>
<meta name="twitter:image" content="${ogImg}"/>
${quizPageSchema ? `<script type="application/ld+json">${quizPageSchema}<\/script>` : ""}
<script type="application/ld+json">${breadcrumbSchema}<\/script>
<link rel="icon" href="/images/favicon.ico" type="image/x-icon"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"/>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8565025017387209" crossorigin="anonymous"></script>
<style>
:root{--pb:#3b82f6;--sb:#f5f0e8;--tc:#1a1a1a;--htc:#fff;--fb:#1e293b;--ftc:#fff;--lc:#c0440a;--cb:#fff;--cbr:rgba(0,0,0,.1);--mu:#64748b;--badge:#c0440a}
body.dark-theme{--pb:#020617;--sb:#0f172a;--tc:#f1f5f9;--fb:#020617;--lc:#f97316;--cb:#1e293b;--cbr:rgba(255,255,255,.1);--mu:#94a3b8;--badge:#f97316}
body{font-family:Inter,sans-serif;background:var(--sb);color:var(--tc);min-height:100vh;display:flex;flex-direction:column}
.navbar{background:var(--pb)!important;position:sticky;top:0;z-index:1030}.navbar-brand,.nav-link{color:var(--htc)!important;font-weight:700!important}
main{flex:1;padding:28px 0}
.footer{background:var(--fb);color:var(--ftc);text-align:center;padding:20px;margin-top:40px;font-size:14px}.footer a{color:var(--ftc);text-decoration:underline}
a{color:var(--lc)}.text-muted{color:var(--mu)!important}
/* Base quiz option styles shared with events page */
.tdq-opt{display:flex;align-items:center;gap:10px;padding:10px 14px;border:1.5px solid var(--cbr);border-radius:8px;cursor:pointer;font-size:.92rem;transition:background .15s,border-color .15s,transform .1s;user-select:none;background:var(--cb)}
.tdq-opt:hover{border-color:#3b82f6;background:rgba(59,130,246,.06);transform:translateX(2px)}.tdq-opt-selected{border-color:#3b82f6!important;background:rgba(59,130,246,.1)!important;font-weight:500}
.tdq-opt-correct{border-color:#10b981!important;background:#d1fae5!important;color:#0f172a!important}.tdq-opt-wrong{border-color:#ef4444!important;background:#fee2e2!important;color:#0f172a!important}
.tdq-opt-key{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:#e2e8f0;font-size:.75rem;font-weight:700;flex-shrink:0}
.tdq-opt-selected .tdq-opt-key{background:#3b82f6;color:#fff}.tdq-opt-correct .tdq-opt-key{background:#10b981;color:#fff}.tdq-opt-wrong .tdq-opt-key{background:#ef4444;color:#fff}
body.dark-theme .tdq-opt{border-color:rgba(255,255,255,.15);background:rgba(255,255,255,.04)}body.dark-theme .tdq-opt:hover{border-color:#60a5fa;background:rgba(96,165,250,.08)}
body.dark-theme .tdq-opt-selected{border-color:#60a5fa!important;background:rgba(96,165,250,.15)!important}body.dark-theme .tdq-opt-key{background:#334155;color:#cbd5e1}
body.dark-theme .tdq-opt-correct{background:rgba(16,185,129,.2)!important;border-color:#10b981!important;color:#e2e8f0!important}
body.dark-theme .tdq-opt-wrong{background:rgba(239,68,68,.2)!important;border-color:#ef4444!important;color:#e2e8f0!important}
.tdq-explanation{font-size:.85rem;margin-top:8px;padding:10px 14px;background:rgba(59,130,246,.07);border-left:3px solid #3b82f6;border-radius:0 8px 8px 0;color:var(--tc);line-height:1.5}
body.dark-theme .tdq-explanation{background:rgba(59,130,246,.15);border-left-color:#60a5fa;color:#e2e8f0}
.tdq-feedback{font-size:.88rem;margin-top:6px;font-weight:600}.tdq-correct{color:#10b981}.tdq-wrong{color:#ef4444}
.tdq-score-box{font-size:1.05rem;font-weight:600;padding:14px 18px;background:rgba(245,158,11,.1);border-radius:10px;border-left:4px solid #f59e0b;text-align:left}.tdq-score-num{color:#f59e0b;font-size:1.3rem}
/* === Carousel quiz layout === */
/* Progress */
.qsc-progress-wrap{text-align:center;margin-bottom:20px}
.qsc-progress-track{height:5px;background:var(--cbr);border-radius:3px;overflow:hidden;margin-bottom:12px}
.qsc-progress-fill{height:100%;background:linear-gradient(90deg,#3b82f6,#10b981);border-radius:3px;transition:width .4s ease}
.qsc-dots-row{display:flex;justify-content:center;gap:10px;margin-bottom:8px}
.qsc-dot{width:12px;height:12px;border-radius:50%;border:none;background:var(--cbr);cursor:pointer;padding:0;transition:all .2s;outline:none}
.qsc-dot:hover{background:#94a3b8}.qsc-dot.qsc-dot-active{background:#3b82f6;transform:scale(1.3)}.qsc-dot.qsc-dot-done{background:#10b981}.qsc-dot.qsc-dot-wrong{background:#ef4444}
.qsc-progress-label{font-size:.82rem;color:var(--mu);margin:0}
/* Nav row */
.qsc-nav-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.qsc-back-btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border:1.5px solid var(--cbr);border-radius:8px;background:transparent;font-size:.85rem;font-weight:500;color:var(--tc);cursor:pointer;transition:all .15s}
.qsc-back-btn:hover:not(:disabled){border-color:#3b82f6;color:#3b82f6}.qsc-back-btn:disabled{opacity:.35;cursor:default}
.qsc-hint{font-size:.82rem;color:var(--mu);font-style:italic}
/* Carousel wrapper */
#qsc-wrapper{border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.12);background:var(--cb);margin-bottom:24px}
body.dark-theme #qsc-wrapper{box-shadow:0 4px 24px rgba(0,0,0,.4)}
/* Slides */
.qsc-slide{display:none;animation:qscIn .3s ease}
.qsc-slide.qsc-active{display:block}
@keyframes qscIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
/* Image area */
.qsc-img-wrap{position:relative;width:100%;height:220px;overflow:hidden;background:#1e293b}
@media(min-width:600px){.qsc-img-wrap{height:280px}}
.qsc-event-img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .4s ease}
.qsc-slide.qsc-active .qsc-event-img{transform:scale(1.02)}
.qsc-img-placeholder{background:linear-gradient(135deg,#1e3a5f 0%,#2d1b69 100%)}
.qsc-img-overlay{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.7) 0%,rgba(0,0,0,.1) 60%,transparent 100%)}
.qsc-year-pill{position:absolute;bottom:14px;left:16px;background:var(--badge);color:#fff;padding:4px 12px;border-radius:20px;font-size:.8rem;font-weight:700;letter-spacing:.04em}
/* Slide body */
.qsc-slide-body{padding:18px 20px 22px}
@media(min-width:600px){.qsc-slide-body{padding:22px 28px 28px}}
.qsc-event-text{font-size:.88rem;color:var(--mu);margin-bottom:14px;line-height:1.5;border-left:3px solid var(--badge);padding-left:10px}
.qsc-wiki-link{color:var(--mu);font-size:.8rem;opacity:.7;text-decoration:none}.qsc-wiki-link:hover{opacity:1}
.qsc-q-label{display:inline-flex;align-items:center;font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--badge);margin-bottom:10px}
.qsc-q-text{font-size:1.05rem;font-weight:700;color:var(--tc);margin-bottom:14px;line-height:1.45}
.qsc-opts-wrap{display:flex;flex-direction:column;gap:9px}
/* Next button */
.qsc-next-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;margin-top:18px;padding:12px;background:var(--badge);color:#fff;border:none;border-radius:10px;font-size:.95rem;font-weight:600;cursor:pointer;transition:background .15s,transform .1s;animation:qscIn .25s ease}
.qsc-next-btn:hover{background:#a03508;transform:translateY(-1px)}
body.dark-theme .qsc-next-btn{background:#f97316}.body.dark-theme .qsc-next-btn:hover{background:#ea6c0a}
/* Final score slide */
.qsc-final-slide .qsc-final-body{padding:32px 24px;text-align:center}
.qsc-trophy-wrap{margin-bottom:18px}
.qsc-trophy-icon{font-size:3.5rem;color:#f59e0b;animation:qscPop .5s cubic-bezier(.34,1.56,.64,1)}
@keyframes qscPop{from{transform:scale(0);opacity:0}to{transform:scale(1);opacity:1}}
.qsc-final-score{font-size:1.1rem;font-weight:600;text-align:left;margin-bottom:18px}
.qsc-review-list{text-align:left;border:1px solid var(--cbr);border-radius:10px;overflow:hidden;margin-bottom:22px}
.qsc-rev-item{display:flex;align-items:center;gap:10px;padding:10px 14px;font-size:.9rem;border-bottom:1px solid var(--cbr)}.qsc-rev-item:last-child{border-bottom:none}
.qsc-cta-row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.qsc-cta-btn{display:inline-flex;align-items:center;gap:7px;padding:10px 18px;border-radius:8px;font-size:.9rem;font-weight:600;text-decoration:none;border:1.5px solid var(--cbr);color:var(--tc);background:var(--cb);transition:all .15s}
.qsc-cta-btn:hover{border-color:#3b82f6;color:#3b82f6;transform:translateY(-1px)}
.qsc-cta-primary{background:var(--badge);color:#fff!important;border-color:var(--badge)}
.qsc-cta-primary:hover{background:#a03508;border-color:#a03508;color:#fff!important}
/* Page header */
.qsc-page-header{text-align:center;padding:8px 0 24px;border-bottom:1px solid var(--cbr);margin-bottom:28px}
.qsc-page-header h1{font-size:1.7rem;font-weight:800;color:var(--tc);margin-bottom:6px}
.qsc-page-header p{color:var(--mu);font-size:.95rem;margin:0}
</style>
</head>
<body>
<div id="read-progress" role="progressbar" aria-label="Reading progress" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"></div>
<nav class="navbar navbar-expand-lg navbar-dark">
  <div class="container-fluid">
    <a class="navbar-brand" href="/">thisDay.</a>
    <div class="form-check form-switch d-lg-none me-2">
      <input class="form-check-input" type="checkbox" id="tsm" aria-label="Toggle dark mode"/>
      <label class="form-check-label" for="tsm"><i class="bi bi-brightness-high-fill" style="color:#fff;font-size:1.1rem;margin-left:4px"></i></label>
    </div>
    <div class="collapse navbar-collapse">
      <ul class="navbar-nav ms-auto">
        <li class="nav-item"><a class="nav-link" href="/events/${todaySlug}/${todayDay}/">Today's Events</a></li>
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
<main class="container my-4" style="max-width:720px">
  <nav aria-label="breadcrumb" class="mb-3">
    <ol class="breadcrumb">
      <li class="breadcrumb-item"><a href="/">Home</a></li>
      <li class="breadcrumb-item"><a href="/events/${monthSlug}/${day}/">${escapeHtml(mDisplay)} ${day}</a></li>
      <li class="breadcrumb-item active">Quiz</li>
    </ol>
  </nav>
  <div class="qsc-page-header">
    <h1><i class="bi bi-patch-question-fill me-2" style="color:#f59e0b"></i>${escapeHtml(mDisplay)} ${day} — History Quiz</h1>
    <p>5 questions &middot; Based on real historical events &middot; Instant feedback</p>
  </div>
  ${carouselHtml}
  <p class="text-center" style="font-size:.85rem;color:var(--mu)"><a href="/events/${monthSlug}/${day}/" style="color:var(--mu)">← All events on ${escapeHtml(mDisplay)} ${day}</a></p>
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
  <p class="footer-bottom"><a href="https://buymeacoffee.com/fugec?new=1" target="_blank">Support This Project</a> | <a href="/blog/">Blog</a> | <a href="/about/">About Us</a> | <a href="/contact/">Contact</a> | <a href="/terms/">Terms and Conditions</a> | <a href="/privacy-policy/">Privacy Policy</a></p>
</footer>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
<script>
const yrEl=document.getElementById('yr');
if(yrEl)yrEl.textContent=new Date().getFullYear();
const ds=document.getElementById('tsd'),ms=document.getElementById('tsm');
const ap=d=>document.body.classList.toggle('dark-theme',d);
const gt=k=>{try{return localStorage.getItem(k)}catch{return null}};
const st=(k,v)=>{try{localStorage.setItem(k,v)}catch{}};
const dk=gt('darkTheme')!=='false';
ap(dk);if(ds)ds.checked=dk;if(ms)ms.checked=dk;
if(ds)ds.addEventListener('change',()=>{ap(ds.checked);st('darkTheme',String(ds.checked));if(ms)ms.checked=ds.checked;});
if(ms)ms.addEventListener('change',()=>{ap(ms.checked);st('darkTheme',String(ms.checked));if(ds)ds.checked=ms.checked;});
</script>
<script async src="https://fundingchoicesmessages.google.com/i/pub-8565025017387209?ers=1"></script>
<script>(function(){function signalGooglefcPresent(){if(!window.frames['googlefcPresent']){if(document.body){const iframe=document.createElement('iframe');iframe.style='width:0;height:0;border:none;z-index:-1000;left:-1000px;top:-1000px;display:none;';iframe.name='googlefcPresent';document.body.appendChild(iframe);}else{setTimeout(signalGooglefcPresent,0);}}}signalGooglefcPresent();})();</script>
<script>(function(){var bar=document.getElementById('read-progress');if(!bar)return;document.addEventListener('scroll',function(){var doc=document.documentElement;var total=doc.scrollHeight-doc.clientHeight;var pct=total>0?Math.round((doc.scrollTop/total)*100):0;bar.style.width=pct+'%';bar.setAttribute('aria-valuenow',pct);},{passive:true});})();</script>
</body></html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
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
