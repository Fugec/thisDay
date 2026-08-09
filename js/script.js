// Copyright (c) 2024–present Armin Kapetanovic. All Rights Reserved.
// Proprietary — see LICENSE in the repository root.
// Unauthorized use, reproduction, or deployment is prohibited.

const calendarGrid = document.getElementById("calendarGrid");
const currentMonthYearDisplay = document.getElementById("currentMonthYear");
const modalDate = document.getElementById("modalDate");
const modalDateSummary = document.getElementById("modalDateSummary");
const modalBodyContent = document.getElementById("modalBodyContent");
let eventDetailModal = null;

function getEventDetailModal() {
  if (eventDetailModal) return eventDetailModal;
  const modalElement = document.getElementById("eventDetailModal");
  const Modal = window.bootstrap?.Modal;
  if (!modalElement || !Modal) return null;
  eventDetailModal =
    typeof Modal.getOrCreateInstance === "function"
      ? Modal.getOrCreateInstance(modalElement)
      : new Modal(modalElement);
  return eventDetailModal;
}
const loadingIndicator = document.getElementById("loadingIndicator");

// Elements for carousel
const carouselInner = document.getElementById("carouselInner");
const carouselIndicators = document.getElementById("carouselIndicators");

const body = document.body;

// Ensure site does not start in dark mode — remove any dark-theme markers
try {
  if (body && body.classList) {
    body.classList.remove("dark-theme");
    body.classList.remove("dark");
  }
  // Some pages may set a data-theme attribute — clear it to avoid CSS selectors
  if (body && body.hasAttribute && body.hasAttribute("data-theme")) {
    body.removeAttribute("data-theme");
  }
} catch (e) {
  /* ignore */
}

var currentDate = new Date();
var lastActiveCard = null;

const CACHE_EXPIRY_TIME = 24 * 60 * 60 * 1000;
const LOCAL_STORAGE_CACHE_KEY = "wikipediaEventCacheV2";
const HOMEPAGE_DOCUMENT_TITLE =
  "On This Day in History: Events, Births & Deaths";

// Months
const monthNames = [
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

function getBlogPostSlugDateTime(slug) {
  const match = String(slug || "")
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})-([a-z]+)-(\d{4})$/);
  if (!match) return null;
  const day = Number.parseInt(match[1], 10);
  const monthIndex = monthNames.findIndex(
    (month) => month.toLowerCase() === match[2],
  );
  const year = Number.parseInt(match[3], 10);
  if (!Number.isInteger(day) || monthIndex < 0 || !Number.isInteger(year)) {
    return null;
  }
  const time = Date.UTC(year, monthIndex, day);
  const parsed = new Date(time);
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === monthIndex &&
    parsed.getUTCDate() === day
    ? time
    : null;
}

function getBlogPostPublicationTime(post) {
  const slugTime = getBlogPostSlugDateTime(post?.slug);
  if (slugTime != null) return slugTime;
  for (const value of [post?.publishedAt, post?.date]) {
    const time = value ? new Date(value).getTime() : NaN;
    if (Number.isFinite(time)) return time;
  }
  return 0;
}

function sortBlogPostsNewestFirst(posts) {
  if (!Array.isArray(posts)) return [];
  return posts
    .map((post, index) => ({
      post,
      index,
      publicationTime: getBlogPostPublicationTime(post),
      preciseTime: post?.publishedAt
        ? new Date(post.publishedAt).getTime() || 0
        : 0,
    }))
    .sort(
      (left, right) =>
        right.publicationTime - left.publicationTime ||
        right.preciseTime - left.preciseTime ||
        left.index - right.index,
    )
    .map((entry) => entry.post);
}

function homepageBlogIndexUrl(now = Date.now()) {
  // The minute bucket bypasses an already-installed legacy cache-first service
  // worker while still allowing all homepage consumers to share one response.
  return `/blog/index.json?homepage=${Math.floor(now / 60_000)}`;
}

function injectAdBlockRecoveryScript() {
  const existing = document.querySelector(
    'script[src^="https://fundingchoicesmessages.google.com/i/pub-8565025017387209"]',
  );
  if (existing) return;

  const loadScript = () => {
    const script = document.createElement("script");
    script.async = true;
    script.src =
      "https://fundingchoicesmessages.google.com/i/pub-8565025017387209?ers=1";
    document.body.appendChild(script);

    (function signalGooglefcPresent() {
      if (!window.frames["googlefcPresent"]) {
        if (document.body) {
          const iframe = document.createElement("iframe");
          iframe.style.cssText =
            "width:0;height:0;border:none;z-index:-1000;left:-1000px;top:-1000px;display:none;";
          iframe.name = "googlefcPresent";
          document.body.appendChild(iframe);
        } else {
          setTimeout(signalGooglefcPresent, 0);
        }
      }
    })();
  };

  if (document.body) {
    loadScript();
  } else {
    document.addEventListener("DOMContentLoaded", loadScript, { once: true });
  }
}

injectAdBlockRecoveryScript();

// Rate limiting variables
let requestCount = 0;
const MAX_REQUESTS_PER_SECOND = 10;
const RATE_LIMIT_WINDOW = 1000;

setInterval(() => {
  requestCount = 0;
}, RATE_LIMIT_WINDOW);

// --- Local Storage Cache Management ---

function loadCacheFromLocalStorage() {
  try {
    const cachedData = localStorage.getItem(LOCAL_STORAGE_CACHE_KEY);
    if (cachedData) {
      const parsedData = JSON.parse(cachedData);
      return new Map(Object.entries(parsedData));
    }
  } catch (e) {
    console.error("Error loading cache from localStorage:", e);
  }
  return new Map();
}

function saveCacheToLocalStorage(cacheMap) {
  try {
    const objToStore = {};
    cacheMap.forEach((value, key) => {
      objToStore[key] = value;
    });
    localStorage.setItem(LOCAL_STORAGE_CACHE_KEY, JSON.stringify(objToStore));
  } catch (e) {
    console.error("Error saving cache to localStorage:", e);
  }
}

let eventCache = loadCacheFromLocalStorage();

// --- End Local Storage Cache Management ---

async function rateLimitedFetch(url, options = {}, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (requestCount >= MAX_REQUESTS_PER_SECOND) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      requestCount = 0;
    }

    requestCount++;

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          Accept: "application/json",
          ...options.headers,
        },
      });

      if (response.ok) {
        return response;
      } else if (response.status === 429) {
        const waitTime = Math.pow(2, attempt) * 1000;
        console.warn(
          `Rate limited. Waiting ${waitTime}ms before retry ${attempt + 1}`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        continue;
      } else if (response.status >= 500) {
        const waitTime = Math.pow(2, attempt) * 500;
        console.warn(
          `Server error ${response.status}. Retrying in ${waitTime}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        continue;
      } else {
        return response;
      }
    } catch (error) {
      if (attempt === maxRetries - 1) {
        throw error;
      }
      const waitTime = Math.pow(2, attempt) * 1000;
      console.warn(`Network error. Retrying in ${waitTime}ms:`, error);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }
  throw new Error(`Failed after ${maxRetries} attempts`);
}

// Route a Wikimedia image URL through the on-site image proxy.
// The proxy resizes Wikipedia thumbnails, sets a 30-day cache, and uses
// Cloudflare Image Resizing (WebP/AVIF) when available on Pro+ plans.
function getOptimizedImageUrl(url, width = 1200, quality = 82) {
  if (!url || !url.includes("wikimedia.org")) return url;
  return `/img?src=${encodeURIComponent(url)}&w=${width}&q=${quality}`;
}

function getResponsiveImageSrcset(
  url,
  widths = [320, 600, 960],
  quality = 82,
) {
  if (!url || !url.includes("wikimedia.org")) return "";
  return [...new Set(widths)]
    .filter((width) => Number.isInteger(width) && width > 0)
    .sort((a, b) => a - b)
    .map((width) => `${getOptimizedImageUrl(url, width, quality)} ${width}w`)
    .join(", ");
}

function historicalEventAnchorId(event) {
  const rawYear = String(event?.year ?? "").trim();
  const year = rawYear
    .replace(/^-/, "bc-")
    .replace(/[^a-z0-9-]+/gi, "-")
    .replace(/(^-|-$)/g, "") || "unknown";
  const normalizedText = String(
    event?.text || event?.description || event?.title || "",
  )
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  let hash = 2166136261;
  for (let index = 0; index < normalizedText.length; index += 1) {
    hash ^= normalizedText.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const label =
    normalizedText.slice(0, 48).replace(/-+$/g, "") || "historical-event";
  return `event-${year}-${label}-${(hash >>> 0).toString(36)}`;
}

function historicalPersonAnchorId(person, type = person?.type) {
  const kind = type === "death" || type === "died" ? "death" : "birth";
  const rawYear = String(person?.year ?? "").trim();
  const year =
    rawYear
      .replace(/^-/, "bc-")
      .replace(/[^a-z0-9-]+/gi, "-")
      .replace(/(^-|-$)/g, "") || "unknown";
  const name = String(
    person?.description ||
      person?.text ||
      person?.title ||
      person?.wikiTitle ||
      person?.name ||
      "",
  )
    .split(",")[0]
    .trim();
  const normalizedName = slugifyPersonName(name) || "historical-person";
  return `person-${kind}-${year}-${normalizedName.slice(0, 64).replace(/-+$/g, "")}`;
}

function slugifyPersonName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// Converts raw Wikipedia API response into the app's internal event format
function processRawWikipediaData(data) {
  const processedEvents = [];
  const processedBirths = [];
  const processedDeaths = [];

  const processItems = (items, targetArray, type) => {
    if (items && Array.isArray(items)) {
      items.forEach((item) => {
        if (!item || !item.text) return;
        let wikipediaLink = "";
        let thumbnailUrl = "";
        let pageDescription = "";
        let pageExtract = "";
        let pageTitle = "";
        if (item.pages && Array.isArray(item.pages) && item.pages.length > 0) {
          const page = item.pages[0];
          if (page.content_urls && page.content_urls.desktop) {
            wikipediaLink = page.content_urls.desktop.page;
          }
          if (page.thumbnail && page.thumbnail.source) {
            thumbnailUrl = page.thumbnail.source;
          }
          pageDescription = page.description || "";
          pageExtract = page.extract || "";
          pageTitle = page.title || page.normalizedtitle || "";
        }
        const text = String(item.text || "").trim();
        const commaIndex = text.indexOf(",");
        const title =
          type === "event"
            ? pickTeaserSentence(text) || text
            : commaIndex > 0
              ? text.slice(0, commaIndex).trim()
              : pageTitle || text;
        targetArray.push({
          title: title,
          description: text,
          pageDescription: pageDescription,
          pageExtract: pageExtract,
          wikiTitle: pageTitle,
          originalImageUrl: item.pages?.[0]?.originalimage?.source || "",
          slug: type === "event" ? "" : slugifyPersonName(pageTitle || title || text),
          year: item.year || "Unknown",
          sourceUrl: wikipediaLink,
          thumbnailUrl: thumbnailUrl,
          type: type,
        });
      });
    }
  };

  processItems(data.events, processedEvents, "event");
  processItems(data.births, processedBirths, "birth");
  processItems(data.deaths, processedDeaths, "death");

  return {
    events: processedEvents,
    births: processedBirths,
    deaths: processedDeaths,
    partial: data?.partial === true,
    counts:
      data?.counts && typeof data.counts === "object"
        ? {
            events: Number(data.counts.events) || processedEvents.length,
            births: Number(data.counts.births) || processedBirths.length,
            deaths: Number(data.counts.deaths) || processedDeaths.length,
          }
        : {
            events: processedEvents.length,
            births: processedBirths.length,
            deaths: processedDeaths.length,
          },
  };
}

async function fetchWikipediaEvents(month, day, options = {}) {
  const requireFull = options.requireFull === true;
  const cacheKey = `${month}-${day}-en`;
  if (eventCache.has(cacheKey)) {
    const cached = eventCache.get(cacheKey);
    const cachedIsComplete =
      cached.complete !== false && cached.data?.partial !== true;
    if (
      Date.now() - cached.timestamp < CACHE_EXPIRY_TIME &&
      (!requireFull || cachedIsComplete)
    ) {
      return cached.data;
    } else if (Date.now() - cached.timestamp >= CACHE_EXPIRY_TIME) {
      eventCache.delete(cacheKey);
      saveCacheToLocalStorage(eventCache);
    }
  }

  // The Worker injects a deliberately small preview for today's initial paint.
  // Complete modal data is fetched only when the visitor asks to open the day.
  const now = new Date();
  if (
    !requireFull &&
    month === now.getMonth() + 1 &&
    day === now.getDate()
  ) {
    const preloadedScript = document.getElementById("preloaded-today-events");
    if (preloadedScript) {
      try {
        const raw = JSON.parse(preloadedScript.textContent);
        if (raw && raw.events && raw.events.length > 0) {
          const resultData = processRawWikipediaData(raw);
          eventCache.set(cacheKey, {
            data: resultData,
            timestamp: Date.now(),
            complete: raw.partial !== true,
          });
          if (raw.partial !== true) saveCacheToLocalStorage(eventCache);
          return resultData;
        }
      } catch (e) {
        console.warn(
          "Failed to parse preloaded events, falling back to API.",
          e,
        );
      }
    }
  }

  const monthPadded = String(month).padStart(2, "0");
  const dayPadded = String(day).padStart(2, "0");
  const url = `/api/events/${monthPadded}/${dayPadded}`;

  try {
    const response = await rateLimitedFetch(url);

    if (!navigator.onLine && !response.ok) {
      console.warn("Offline: Cannot fetch new data from Wikipedia.");
      return { events: [], births: [], deaths: [] };
    }

    if (!response.ok) {
      console.warn(
        `No data for English Wikipedia for ${month}/${day} (Status: ${response.status})`,
      );
      const emptyData = { events: [], births: [], deaths: [] };
      eventCache.set(cacheKey, {
        data: emptyData,
        timestamp: Date.now(),
        complete: true,
      });
      saveCacheToLocalStorage(eventCache);
      return emptyData;
    }

    const data = await response.json();
    const resultData = processRawWikipediaData(data);
    eventCache.set(cacheKey, {
      data: resultData,
      timestamp: Date.now(),
      complete: true,
    });
    saveCacheToLocalStorage(eventCache);
    return resultData;
  } catch (error) {
    console.error(`Error fetching events for ${month}/${day}:`, error);
    return { events: [], births: [], deaths: [] };
  }
}

// --- NEW/MODIFIED CAROUSEL AND BLOG POST LOGIC ---

/**
 * Tries each fallback URL in sequence when a carousel image fails to load.
 * Covers all common formats (jpg, jpeg, png, webp) and naming variants.
 */
function tryCarouselFallbacks(img, fallbacks) {
  const next = fallbacks.shift();
  if (!next) {
    img.onerror = null;
    // All fallbacks exhausted — remove this slide so no blank/broken image shows
    const slide = img.closest(".carousel-item");
    if (slide) {
      const wasActive = slide.classList.contains("active");
      slide.remove();
      // If the removed slide was active, activate the next one
      const remaining = document.querySelectorAll("#carouselInner .carousel-item");
      if (wasActive && remaining.length > 0) {
        remaining[0].classList.add("active");
      }
      // Sync indicators
      document.querySelectorAll("#carouselIndicators button").forEach((btn, i) => {
        btn.classList.toggle("active", i === 0);
        btn.setAttribute("aria-current", i === 0 ? "true" : "false");
      });
    }
    return;
  }
  img.onerror = () => tryCarouselFallbacks(img, fallbacks);
  img.src = next;
}

// Extract a teaser sentence without getting tripped up by common abbreviations
// like "St." (e.g. "St. Patrick's Day...").
function pickTeaserSentence(text) {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";

  const abbreviations = new Set([
    "st",
    "mr",
    "mrs",
    "ms",
    "dr",
    "prof",
    "sr",
    "jr",
    "mt",
    "no",
    "vs",
    "etc",
    "e.g",
    "i.e",
  ]);

  const boundaryRe = /[.!?]\s+/g;
  let match;
  while ((match = boundaryRe.exec(clean))) {
    const punctIndex = match.index;
    const punct = clean[punctIndex];
    const before = clean.slice(0, punctIndex).trimEnd();

    if (punct === ".") {
      const lastToken = (before.split(/\s+/).pop() || "")
        .replace(/^[('"“]+/, "")
        .replace(/[)"'”]+$/, "");
      const tokenKey = lastToken.replace(/\.+$/, "").toLowerCase();
      if (abbreviations.has(tokenKey)) continue;
    }

    return before + punct;
  }

  return clean;
}

// Helper function to render a single carousel item
function renderCarouselItem(container, post, index) {
  const carouselItem = document.createElement("div");
  carouselItem.className = `carousel-item${index === 0 ? " active" : ""}`;
  const imageUrl = post.imageUrl;
  const d = post.day;
  const m = post.monthIndex + 1;
  const dp = String(d).padStart(2, "0");
  const mp = String(m).padStart(2, "0");
  // All local date-based image variants to try on error (jpg, jpeg, png, webp)
  const carouselFallbacks = JSON.stringify([
    `/images/blog/${d}.${m}.jpg`,
    `/images/blog/${d}.${m}.jpeg`,
    `/images/blog/${d}.${m}.png`,
    `/images/blog/${d}.${m}.webp`,
    `/images/blog/${dp}.${mp}.jpg`,
    `/images/blog/${dp}.${mp}.jpeg`,
    `/images/blog/${dp}.${mp}.png`,
    `/images/blog/${dp}.${mp}.webp`,
    `/images/blog/${m}.${d}.jpg`,
    `/images/blog/${mp}.${dp}.jpg`,
  ]);
  const MAX_WORDS = 15;
  let titleContent =
    post.title ||
    `Blog Post - ${post.day} ${monthNames[new Date().getMonth()]} ${post.year}`;
  const titleWords = titleContent.split(" ");
  let truncatedTitle = titleWords.slice(0, MAX_WORDS).join(" ");
  if (titleWords.length > MAX_WORDS) {
    truncatedTitle += "...";
  }
  const dateLabel = `<span style="display:none;" class="year-label">${
    post.day
  } ${monthNames[new Date().getMonth()]} ${post.year}</span>`;
  const teaserRaw = pickTeaserSentence(
    post.excerpt || "Read this blog post about historical events.",
  );
  const teaserSafe = teaserRaw
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .trim();
  const teaserFinal = /[.!?]$/.test(teaserSafe) ? teaserSafe : `${teaserSafe}.`;

  carouselItem.innerHTML = `
    <div style="position:relative;">
      ${dateLabel}
      <div class="carousel-image-container">
        <img src="${imageUrl}" class="d-block w-100" alt="${truncatedTitle}"
             onerror="tryCarouselFallbacks(this, ${carouselFallbacks});"
             ${
               index === 0 ? 'fetchpriority="high"' : 'loading="lazy"'
             } decoding="async" width="1200" height="350">
      </div>
    </div>
    <div class="carousel-caption">
      <h5>${truncatedTitle}</h5>
      <p>${teaserFinal}</p>
      <div class="d-flex justify-content-center gap-2">
        <a href="${post.url}" class="btn btn-primary btn-sm"
           ${post.isExternal ? 'target="_blank" rel="noopener noreferrer"' : ""}>Read Full Post</a>
        <a href="${window.__todayEventsUrl || window.__todayGeneratedUrl || "/events/" + new Date().toLocaleString("en-US", { month: "long" }).toLowerCase() + "/" + new Date().getDate() + "/"}" class="btn btn-primary btn-sm">Today's Events</a>
      </div>
    </div>
  `;
  container.appendChild(carouselItem);
}

// Helper function to render the "No Posts" placeholder
function renderPlaceholder(container, month) {
  const defaultItem = document.createElement("div");
  defaultItem.className = "carousel-item active";
  defaultItem.innerHTML = `
    <div class="carousel-image-container">
      <img src="https://placehold.co/1200x350/6c757d/ffffff?text=No+Blog+Posts+Available+for+${monthNames[month]}"
           class="d-block w-100" alt="No blog posts available" width="1200" height="350" fetchpriority="high" decoding="async">
    </div>
    <div class="carousel-caption">
      <h5>Blog Posts for ${monthNames[month]}</h5>
      <p>No blog posts available for this month. Check back later for new content!</p>
      <a href="#calendarGrid" class="btn btn-primary btn-sm">Explore Calendar</a>
    </div>
  `;
  container.appendChild(defaultItem);
}

// Helper function to render an error state
function renderErrorState(container) {
  const errorItem = document.createElement("div");
  errorItem.className = "carousel-item active";
  errorItem.innerHTML = `
    <div class="carousel-image-container">
      <img src="https://placehold.co/1200x350/dc3545/ffffff?text=Error+Loading+Blog+Posts"
           class="d-block w-100" alt="Error loading" width="1200" height="350" fetchpriority="high" decoding="async">
    </div>
    <div class="carousel-caption">
      <h5>Unable to Load Blog Posts</h5>
      <p>Please check your internet connection and try again.</p>
    </div>
  `;
  container.appendChild(errorItem);
}

// fetch all blog posts from the /blog/ folder structure
async function fetchBlogPosts(monthName, monthIndex) {
  const BLOG_CACHE_KEY = `blogPosts_${monthName}`;
  const cachedPosts = getCachedBlogPosts(BLOG_CACHE_KEY);
  if (cachedPosts) {
    return cachedPosts;
  }

  try {
    const manifestPosts = await fetchBlogPostsFromManifest(monthName);
    if (manifestPosts.length > 0) {
      setCachedBlogPosts(BLOG_CACHE_KEY, manifestPosts);
      return manifestPosts;
    }

    const allPosts = await fetchAllBlogPostsFromFolder(monthName, monthIndex);
    if (allPosts.length > 0) {
      setCachedBlogPosts(BLOG_CACHE_KEY, allPosts);
      return allPosts;
    }

    const generatedPosts = await generateMonthBlogPosts(monthName, monthIndex);
    if (generatedPosts.length > 0) {
      setCachedBlogPosts(BLOG_CACHE_KEY, generatedPosts);
      return generatedPosts;
    }

    return [];
  } catch (error) {
    console.error("Error fetching blog posts:", error);
    const fallbackPosts = await generateMonthBlogPosts(monthName, monthIndex);
    return fallbackPosts;
  }
}

// Fetch ALL blog posts from the month folder (starting from 2025, only before today)
async function fetchAllBlogPostsFromFolder(monthName, monthIndex) {
  const allPosts = [];
  const currentYear = new Date().getFullYear();
  const startYear = Math.max(2025, currentYear);

  const today = new Date();
  const currentMonth = today.getMonth();
  const currentDay = today.getDate();

  const daysInMonth = new Date(startYear, monthIndex + 1, 0).getDate();

  for (let day = 1; day <= daysInMonth; day++) {
    if (monthIndex === currentMonth && day > currentDay) {
      continue;
    }
    if (monthIndex > currentMonth) {
      continue;
    }
    const folderName = `${day}-${startYear}`;
    try {
      const response = await fetch(`/blog/${monthName}/${folderName}/`, {
        method: "HEAD",
        cache: "no-cache",
      });
      if (response.ok) {
        const postData = await fetchBlogPostData(
          monthName,
          folderName,
          day,
          startYear,
          monthIndex,
        );
        if (postData) {
          allPosts.push(postData);
        }
      }
    } catch (error) {}
  }
  return allPosts.sort((a, b) => b.day - a.day);
}

// generate blog posts for all days in the month (only before today)
async function generateMonthBlogPosts(monthName, monthIndex) {
  const posts = [];
  const currentYear = new Date().getFullYear();
  const year = Math.max(2025, currentYear);
  const today = new Date();
  const currentMonth = today.getMonth();
  const currentDay = today.getDate();

  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

  for (let day = 1; day <= daysInMonth; day++) {
    if (monthIndex === currentMonth && day > currentDay) {
      continue;
    }
    if (monthIndex > currentMonth) {
      continue;
    }
    const folderName = `${day}-${year}`;
    const imageUrl = `/images/blog/${day}.${monthIndex + 1}.jpg`;
    const postData = {
      day: day,
      year: year,
      title: `Historical Events - ${day} ${monthNames[monthIndex]} ${year}`,
      excerpt: `Discover what happened on ${day} ${monthNames[monthIndex]} ${year}. Explore historical events, birthdays, and significant moments from this day in history.`,
      imageUrl: imageUrl,
      url: `/blog/${monthName}/${folderName}/`,
      isExternal: false,
    };
    posts.push(postData);
  }
  return posts.sort((a, b) => b.day - a.day);
}

// fetch individual blog post data
async function fetchBlogPostData(monthName, folder, day, year, monthIndex) {
  try {
    const imageUrl = `/images/blog/${day}.${monthIndex + 1}.jpg`;
    const htmlResponse = await fetch(`/blog/${monthName}/${folder}/index.html`);
    if (htmlResponse.ok) {
      const html = await htmlResponse.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      const title =
        doc.querySelector("h1")?.textContent?.trim() ||
        doc
          .querySelector('meta[property="og:title"]')
          ?.getAttribute("content") ||
        doc.querySelector("title")?.textContent ||
        `Historical Events - ${day} ${monthNames[monthIndex]} ${year}`;
      const excerpt =
        doc
          .querySelector('meta[property="og:description"]')
          ?.getAttribute("content") ||
        doc
          .querySelector('meta[name="description"]')
          ?.getAttribute("content") ||
        `Discover what happened on ${day} ${monthNames[monthIndex]} ${year}`;
      return {
        day: day,
        year: year,
        title: title.trim(),
        excerpt: excerpt.trim(),
        imageUrl: imageUrl,
        url: `/blog/${monthName}/${folder}/`,
        isExternal: false,
      };
    }
    return {
      day: day,
      year: year,
      title: `Historical Events - ${day} ${monthNames[monthIndex]} ${year}`,
      excerpt: `Discover what happened on this day in ${year}`,
      imageUrl: imageUrl,
      url: `/blog/${monthName}/${folder}/`,
      isExternal: false,
    };
  } catch (error) {
    console.error(
      `Error fetching or parsing blog post HTML for ${folder}:`,
      error,
    );
    return {
      day: day,
      year: year,
      title: `Historical Events - ${day} ${monthNames[monthIndex]} ${year}`,
      excerpt: `Discover what happened on this day in ${year}`,
      imageUrl: `/images/blog/${day}.${monthIndex + 1}.jpg`,
      url: `/blog/${monthName}/${folder}/`,
      isExternal: false,
    };
  }
}

// In-memory cache for blog posts
const blogPostCache = new Map();

function getCachedBlogPosts(key) {
  try {
    const cached = blogPostCache.get(key);
    if (cached) {
      if (Date.now() - cached.timestamp < 60 * 60 * 1000) {
        return cached.posts;
      } else {
        blogPostCache.delete(key);
      }
    }
  } catch (error) {
    console.error("Error reading blog cache:", error);
  }
  return null;
}

function setCachedBlogPosts(key, posts) {
  try {
    blogPostCache.set(key, {
      posts: posts,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("Error setting blog cache:", error);
  }
}

async function fetchBlogPostsFromManifest(monthName) {
  try {
    const response = await fetch(`/blog/${monthName}/manifest.json`);
    if (!response.ok) {
      return [];
    }
    const manifest = await response.json();
    const today = new Date();
    const currentMonth = today.getMonth();
    const currentDay = today.getDate();
    const monthIndex = monthNames.findIndex(
      (m) => m.toLowerCase() === monthName.toLowerCase(),
    );
    const blogPosts = [];
    for (const post of manifest.posts || []) {
      if (monthIndex === currentMonth && post.day > currentDay) {
        continue;
      }
      if (monthIndex > currentMonth) {
        continue;
      }
      const imageUrl = `/images/blog/${post.day}.${monthIndex + 1}.jpg`;
      const postData = {
        day: post.day,
        year: post.year,
        title: post.title,
        excerpt: post.excerpt,
        imageUrl: imageUrl,
        url: `/blog/${monthName}/${post.folder}/`,
        isExternal: false,
      };
      blogPosts.push(postData);
    }
    return blogPosts.sort((a, b) => b.day - a.day);
  } catch (error) {
    console.error("Error fetching from manifest:", error);
    return [];
  }
}

function createDayCard(day, month) {
  const dayCard = document.createElement("div");
  dayCard.className = "day-card";
  dayCard.setAttribute("data-day", day);
  dayCard.setAttribute("data-month", month + 1);
  const dayNumber = document.createElement("div");
  dayNumber.className = "day-number";
  dayNumber.textContent = day;
  dayCard.appendChild(dayNumber);
  const eventSummary = document.createElement("div");
  eventSummary.className = "event-summary";
  eventSummary.textContent = "Click to load";
  dayCard.appendChild(eventSummary);
  return dayCard;
}

async function loadDayEvents(dayCard, month, forceLoad = false) {
  const day = parseInt(dayCard.getAttribute("data-day"), 10);
  if (dayCard.classList.contains("loaded") && !forceLoad) {
    return true;
  }
  const eventSummary = dayCard.querySelector(".event-summary");
  dayCard.classList.add("loading");
  dayCard.classList.remove("needs-load");
  eventSummary.innerHTML =
    '<div class="spinner-border spinner-border-sm" role="status"></div>';
  try {
    const eventsData = await fetchWikipediaEvents(month + 1, day, {
      requireFull: forceLoad,
    });
    dayCard.eventsData = eventsData;
    const totalEvents = eventsData.counts
      ? (eventsData.counts.events || 0) +
        (eventsData.counts.births || 0) +
        (eventsData.counts.deaths || 0)
      : (eventsData.events?.length || 0) +
        (eventsData.births?.length || 0) +
        (eventsData.deaths?.length || 0);
    dayCard.classList.remove("loading");
    dayCard.classList.add("loaded");
    if (totalEvents > 0) {
      eventSummary.textContent = `${totalEvents} Events`;
      dayCard.classList.remove("no-events");
    } else {
      eventSummary.textContent = "No Events";
      dayCard.classList.add("no-events");
    }
    if (!dayCard._hasClickListener) {
      dayCard.addEventListener("click", () => {
        showEventDetails(
          day,
          month + 1,
          currentDate.getFullYear(),
          dayCard.eventsData,
        );
      });
      dayCard._hasClickListener = true;
    }
    return true;
  } catch (error) {
    console.error(`Error loading events for day ${day}:`, error);
    const eventSummary = dayCard.querySelector(".event-summary");
    eventSummary.textContent = "Error";
    dayCard.classList.remove("loading");
    dayCard.classList.add("error");
    dayCard.classList.remove("loaded");
    return false;
  }
}

async function renderCalendar() {
  calendarGrid.innerHTML = "";
  calendarGrid.setAttribute("role", "grid");
  calendarGrid.setAttribute("aria-label", "Historical events calendar");
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const today = new Date();
  const isCurrentMonth =
    year === today.getFullYear() && month === today.getMonth();
  const todayDate = today.getDate();
  currentMonthYearDisplay.textContent = `${monthNames[month]}`;
  document.title = HOMEPAGE_DOCUMENT_TITLE;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const dayCards = [];
  for (let i = 1; i <= daysInMonth; i++) {
    const dayCard = createDayCard(i, month);
    dayCard.setAttribute("role", "button");
    dayCard.setAttribute("tabindex", "0");
    dayCard.setAttribute("aria-label", `Events for ${i} ${monthNames[month]}`);
    dayCard.setAttribute("aria-expanded", "false");
    dayCard.classList.add("needs-load");
    dayCard.addEventListener("click", async () => {
      if (
        dayCard.classList.contains("needs-load") ||
        dayCard.classList.contains("error")
      ) {
        await loadDayEvents(dayCard, month, true);
        dayCard.classList.remove("needs-load");
      }
      if (dayCard.eventsData) {
        lastActiveCard = dayCard;
        showEventDetails(
          parseInt(dayCard.getAttribute("data-day"), 10),
          month + 1,
          currentDate.getFullYear(),
          dayCard.eventsData,
        );
      }
    });
    dayCard._hasClickListener = true;
    if (isCurrentMonth && i === todayDate) {
      dayCard.classList.add("today-highlight");
      dayCard.setAttribute("aria-current", "date");
    }
    calendarGrid.appendChild(dayCard);
    dayCards.push(dayCard);
  }
  // Events load on click only (see click listener above) — no auto-loading observer.

  try {
    const carouselPromise = populateCarousel(month, year);
    if (isCurrentMonth) {
      const todayCard = dayCards.find(
        (card) => parseInt(card.getAttribute("data-day"), 10) === todayDate,
      );
      if (todayCard) {
        await loadDayEvents(todayCard, month, true);
      }
    }
    await carouselPromise;

    // Populate marquee on index-new using today's historical data.
    try {
      await populateMarquee();
    } catch (marqueeError) {
      console.warn("Marquee load failed:", marqueeError);
    }

    // Populate born/died people strip.
    try {
      await populatePeopleStrip();
    } catch (e) {
      console.warn("People strip load failed:", e);
    }

    // Populate today's event card (random event image, title).
    try {
      await populateTodayEventCard();
    } catch (todayEventError) {
      console.warn("Today event card load failed:", todayEventError);
    }
  } catch (error) {
    console.error("Error during calendar rendering:", error);
    console.error(
      "This error could be due to network issues, API rate limits, or unexpected data format. Please check your internet connection, ensure the API is accessible, and verify the data structure.",
    );
    calendarGrid.innerHTML = `
      <div class="col-12 text-center py-5">
        <div class="alert alert-danger" role="alert">
          <h5><i class="bi bi-exclamation-triangle"></i> Failed to Load Calendar</h5>
          <p>An error occurred while loading events. Please check your internet connection, ensure the Wikipedia API is accessible, and refresh the page. If the issue persists, try clearing your browser cache or using a different browser.</p>
        </div>
      </div>
    `;
  }
}

async function populateMarquee() {
  const marqueeBar = document.getElementById("marqueeBar");
  const marqueeTrack = document.getElementById("marqueeTrack");

  if (!marqueeBar || !marqueeTrack) return;
  if (marqueeTrack.dataset.marqueeReady === "true") return;

  marqueeTrack.dataset.marqueeReady = "true";

  marqueeTrack.innerHTML = "";

  const today = new Date();
  const month = today.getMonth() + 1;
  const day = today.getDate();

  let eventsData = { events: [], births: [], deaths: [] };

  try {
    eventsData = await fetchWikipediaEvents(month, day);
  } catch (error) {
    console.warn("Failed to fetch events for marquee:", error);
  }

  const entries = [];

  // Use today's events first, as requested.
  if (Array.isArray(eventsData.events)) {
    entries.push(...eventsData.events.slice(0, 12));
  }

  if (!entries.length) {
    marqueeBar.style.display = "none";
    return;
  }

  const maxItems = 12;
  const selected = entries.slice(0, maxItems);

  selected.forEach((item) => {
    const itemNode = document.createElement("div");
    itemNode.className = "marquee-item";

    const year = item.year || "Unknown";
    const title = item.title || item.description || "Historical event";

    const yearBadge = document.createElement("span");
    yearBadge.textContent = `${year}`;
    itemNode.appendChild(yearBadge);

    const titleText = document.createElement("span");
    titleText.textContent = ` ${title}`;
    titleText.style.fontWeight = "600";

    if (item.sourceUrl) {
      const link = document.createElement("a");
      link.href = item.sourceUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.style.color = "inherit";
      link.style.textDecoration = "none";
      link.textContent = title;
      itemNode.appendChild(document.createTextNode(" "));
      itemNode.appendChild(link);
    } else {
      itemNode.appendChild(titleText);
    }

    marqueeTrack.appendChild(itemNode);
  });

  // Duplicate for continuous scroll effect
  marqueeTrack.innerHTML += marqueeTrack.innerHTML;
  marqueeBar.style.display = "block";
}

function homepagePersonScore(person) {
  const text = [
    person?.title,
    person?.pageDescription,
    person?.pageExtract,
    person?.description,
  ]
    .join(" ")
    .toLowerCase();
  let score = 0;
  if (person?.originalImageUrl) score += 8;
  if (person?.thumbnailUrl) score += 6;
  if (person?.sourceUrl) score += 4;
  if (person?.pageExtract) score += Math.min(person.pageExtract.length / 120, 8);
  if (person?.pageDescription) score += 2;
  const signalPatterns = [
    /\b(president|prime minister|chancellor|monarch|king|queen|emperor|pope)\b/i,
    /\b(nobel|pulitzer|academy award|oscar|grammy|emmy|booker|tony award)\b/i,
    /\b(actor|actress|singer|musician|composer|writer|novelist|poet|artist|filmmaker|director)\b/i,
    /\b(scientist|physicist|chemist|mathematician|inventor|astronaut|explorer|philosopher)\b/i,
    /\b(olympic|world champion|champion|hall of fame|record holder)\b/i,
    /\b(founder|founded|pioneer|first|best known|one of the most|widely regarded|influential)\b/i,
  ];
  signalPatterns.forEach((pattern) => {
    if (pattern.test(text)) score += 5;
  });
  const iconicPatterns = [
    /\b(father|mother) of\b/i,
    /\bhighly influential\b/i,
    /\bwidely (?:regarded|considered) as (?:one of|the)\b/i,
    /\bone of the greatest\b/i,
    /\binternational [a-z\s-]*icon\b/i,
    /\bworld-record-holding\b/i,
    /\b(supreme court|associate justice)\b/i,
    /\b(nobel prize|academy awards?|triple crown|ballon d'or|fifa world player|grammy award winner)\b/i,
    /\b(computer science|turing machine|cryptanalyst|theoretical computer science)\b/i,
  ];
  iconicPatterns.forEach((pattern) => {
    if (pattern.test(text)) score += 10;
  });
  if (/\b(reality television|television personality|internet personality|youtuber|tiktoker)\b/i.test(text)) {
    score -= 4;
  }
  return score;
}

function selectHomepagePeople(items, limit = 6) {
  return (Array.isArray(items) ? items : [])
    .filter((person) => person && person.title && person.sourceUrl)
    .filter((person) => person.thumbnailUrl || person.originalImageUrl)
    .map((person) => ({
      ...person,
      thumbnailUrl: person.originalImageUrl || person.thumbnailUrl,
      slug: person.slug || slugifyPersonName(person.title),
      _homepageScore: homepagePersonScore(person),
    }))
    .sort((a, b) => {
      if (b._homepageScore !== a._homepageScore) {
        return b._homepageScore - a._homepageScore;
      }
      return String(a.title).localeCompare(String(b.title));
    })
    .slice(0, limit);
}

function localPersonHref(person, articlePeopleBySlug = new Map(), fallbackHref = "/people/", dateContext = {}) {
  const slug = person?.slug || slugifyPersonName(person?.title || person?.name || "");
  if (!slug) return fallbackHref;
  const existing = articlePeopleBySlug.get(slug);
  if (existing?.url) return existing.url;
  if (person?.sourceUrl && /^https:\/\/en\.wikipedia\.org\/wiki\//i.test(person.sourceUrl)) {
    const params = new URLSearchParams({
      wiki: person.sourceUrl,
      name: person.title || person.name || "",
      source: "homepage-people-strip",
    });
    const kind = person.type === "birth" ? "birth" : person.type === "death" ? "death" : "";
    if (kind) params.set("kind", kind);
    if (/^\d{1,4}$/.test(String(person.year || ""))) params.set("year", String(person.year));
    if (dateContext.month) params.set("month", String(dateContext.month));
    if (dateContext.day) params.set("day", String(dateContext.day));
    return `/people/${slug}/?${params.toString()}`;
  }
  return `/people/${slug}/`;
}

let homepagePersonIndexPromise = null;
let modalPersonLinksPromise = null;

function fetchHomepagePersonIndex() {
  if (!homepagePersonIndexPromise) {
    homepagePersonIndexPromise = fetch("/people/index.json")
      .then((response) => (response.ok ? response.json() : []))
      .then((people) => (Array.isArray(people) ? people : []))
      .catch(() => []);
  }
  return homepagePersonIndexPromise;
}

function fetchModalPersonLinks() {
  if (!modalPersonLinksPromise) {
    modalPersonLinksPromise = fetch("/people/index.json?scope=links")
      .then((response) => (response.ok ? response.json() : []))
      .then((people) => (Array.isArray(people) ? people : []))
      .catch(() => []);
  }
  return modalPersonLinksPromise;
}

async function populatePeopleStrip() {
  const track = document.getElementById("peopleTrack");
  const skeleton = document.getElementById("peopleSkeleton");
  if (!track) return;

  const today = new Date();
  const month = today.getMonth() + 1;
  const day = today.getDate();

  const section = document.getElementById("peopleStrip");
  let data = { births: [], deaths: [] };
  let articlePeople = [];
  try {
    const results = await Promise.allSettled([
      fetchWikipediaEvents(month, day),
      fetchHomepagePersonIndex(),
    ]);
    if (results[0].status === "fulfilled") data = results[0].value || data;
    if (results[1].status === "fulfilled" && Array.isArray(results[1].value)) {
      articlePeople = results[1].value;
    }
  } catch (e) {
    if (section) section.style.display = "none";
    return;
  }

  const articlePeopleBySlug = new Map(
    articlePeople
      .filter((p) => p && p.slug)
      .map((p) => [p.slug, p]),
  );
  const births = selectHomepagePeople(data.births || [], 6);
  const deaths = selectHomepagePeople(data.deaths || [], 6);
  const fromArticles = articlePeople.filter(p => p && p.name && p.slug).slice(0, 6);

  if (!births.length && !deaths.length && !fromArticles.length) {
    if (section) section.style.display = "none";
    return;
  }

  function makePill(person, href, options = {}) {
    const a = document.createElement("a");
    a.className = "person-pill";
    a.href = href;

    const circle = document.createElement("div");
    circle.className = "person-circle";

    const imageUrl = person.thumbnailUrl || person.imageUrl || "";
    if (imageUrl) {
      const img = document.createElement("img");
      if (options.useProxy) {
        const proxied = (width) =>
          "/image-proxy?src=" + encodeURIComponent(imageUrl) +
          "&w=" + width + "&h=" + width + "&fit=cover&q=80";
        img.src = proxied(160);
        img.srcset = `${proxied(80)} 80w, ${proxied(160)} 160w`;
      } else {
        img.src = getOptimizedImageUrl(imageUrl, 160, 80);
        img.srcset = getResponsiveImageSrcset(imageUrl, [80, 160], 80);
      }
      img.sizes = "80px";
      img.alt = person.title || person.name || "";
      img.width = 80;
      img.height = 80;
      img.loading = "lazy";
      img.decoding = "async";
      img.onerror = () => {
        circle.innerHTML = '<div class="person-circle-fallback"><i class="bi bi-person"></i></div>';
      };
      circle.appendChild(img);
    } else {
      circle.innerHTML = '<div class="person-circle-fallback"><i class="bi bi-person"></i></div>';
    }

    const name = document.createElement("div");
    name.className = "person-pill-name";
    name.textContent = person.title || person.name || "";

    const year = document.createElement("div");
    year.className = "person-pill-year";
    year.textContent = options.meta || (person.year ? person.year : "");

    a.appendChild(circle);
    a.appendChild(name);
    a.appendChild(year);
    return a;
  }

  function makeSeeAllPill(label, href) {
    const a = document.createElement("a");
    a.className = "person-pill person-pill-see-all";
    a.href = href;
    a.innerHTML =
      '<div class="person-circle person-circle-see-all"><i class="bi bi-arrow-right"></i></div>' +
      '<div class="person-pill-name">' + label + '</div>' +
      '<div class="person-pill-year">See all</div>';
    return a;
  }

  function appendPeopleGroup({ labelHtml, items, href, itemHref, pillOptions, seeAllHref }) {
    if (!items.length) return false;
    const wrap = document.createElement("div");
    wrap.className = "people-group-wrap";

    const label = document.createElement("h2");
    label.className = "group-label";
    label.innerHTML = labelHtml;

    const group = document.createElement("div");
    group.className = "people-group";
    items.forEach((p) => group.appendChild(makePill(p, itemHref ? itemHref(p) : href, pillOptions)));
    if (seeAllHref && !group.querySelector(".person-pill-see-all")) {
      group.appendChild(makeSeeAllPill("See all", seeAllHref));
    }

    wrap.appendChild(label);
    wrap.appendChild(group);
    track.appendChild(wrap);
    return true;
  }

  function appendDivider() {
    const div = document.createElement("div");
    div.className = "people-divider";
    track.appendChild(div);
  }

  // Remove skeleton
  if (skeleton) skeleton.remove();
  track.innerHTML = "";

  let hasGroup = appendPeopleGroup({
    labelHtml: "Born Today",
    items: births,
    href: "/born/today/",
    itemHref: (p) => localPersonHref(p, articlePeopleBySlug, "/born/today/", { month, day }),
    seeAllHref: "/born/today/",
  });
  if (hasGroup && deaths.length) appendDivider();
  hasGroup = appendPeopleGroup({
    labelHtml: "Died Today",
    items: deaths,
    href: "/died/today/",
    itemHref: (p) => localPersonHref(p, articlePeopleBySlug, "/died/today/", { month, day }),
    seeAllHref: "/died/today/",
  }) || hasGroup;
  if (hasGroup && fromArticles.length) appendDivider();
  appendPeopleGroup({
    labelHtml: "From Articles",
    items: fromArticles,
    itemHref: (p) => p.url || ("/people/" + p.slug + "/"),
    pillOptions: { useProxy: true, meta: "Article profile" },
    seeAllHref: "/people/",
  });
}

function populateFeaturedPersonCard(person, kind) {
  const isBirth = kind === "birth";
  const prefix = isBirth ? "bornToday" : "diedToday";
  const fallbackHref = isBirth ? "/born/today/" : "/died/today/";
  const imgEl = document.getElementById(`${prefix}Img`);
  const titleEl = document.getElementById(`${prefix}Title`);
  const descEl = document.getElementById(`${prefix}Desc`);
  const btnEl = document.getElementById(`${prefix}Btn`);

  if (btnEl && !btnEl.getAttribute("href")) btnEl.href = fallbackHref;
  if (!person || !titleEl) return;

  const title = person.title || (isBirth ? "Born Today" : "Died Today");
  const description = pickTeaserSentence(
    person.pageDescription || person.pageExtract || person.description,
  );
  titleEl.textContent = title;
  if (descEl && description) descEl.textContent = description;

  const imageUrl = person.originalImageUrl || person.thumbnailUrl || "";
  if (imgEl && imageUrl) {
    imgEl.src = getOptimizedImageUrl(imageUrl, 800);
    imgEl.srcset = getResponsiveImageSrcset(imageUrl, [400, 800, 1200]);
    imgEl.sizes = "(max-width: 900px) 70vw, 25vw";
    imgEl.alt = `${title}, ${isBirth ? "born" : "died"} on this day`;
    imgEl.width = 800;
    imgEl.height = 400;
    imgEl.loading = "lazy";
    imgEl.decoding = "async";
  }
}

async function populateTodayEventCard() {
  const imgEl = document.getElementById("todayEventImg");
  const titleEl = document.getElementById("todayEventTitle");
  const descEl = document.getElementById("todayEventDesc");
  const btnEl = document.getElementById("todayEventBtn");

  if (!titleEl || !btnEl) return;

  const today = new Date();
  const month = today.getMonth() + 1;
  const day = today.getDate();

  let eventsData = { events: [], births: [], deaths: [] };

  try {
    eventsData = await fetchWikipediaEvents(month, day);
  } catch (error) {
    console.warn("Failed to fetch events for Today Event card:", error);
  }

  populateFeaturedPersonCard(
    selectHomepagePeople(eventsData.births || [], 1)[0],
    "birth",
  );
  populateFeaturedPersonCard(
    selectHomepagePeople(eventsData.deaths || [], 1)[0],
    "death",
  );

  const todaysEvents = Array.isArray(eventsData.events)
    ? eventsData.events.filter((item) => item && item.title)
    : [];

  if (!todaysEvents.length) {
    titleEl.textContent = "Today's Events";
    if (descEl)
      descEl.textContent = "No event found for today. Browse all events.";
    btnEl.href = "/events/today/";
    if (imgEl) {
      imgEl.src = "https://placehold.co/800x400?text=No+Image";
      imgEl.alt = "No event image available";
    }
    return;
  }

  const illustratedEvents = todaysEvents.filter(
    (event) => event.thumbnailUrl || event.originalImageUrl,
  );
  const eventPool = illustratedEvents.length ? illustratedEvents : todaysEvents;
  const randomEvent = eventPool[Math.floor(Math.random() * eventPool.length)];

  titleEl.textContent = randomEvent.title || "Today's Event";
  if (descEl)
    descEl.textContent =
      randomEvent.description || "Explore this historical event.";
  btnEl.href = "/events/today/";
  btnEl.innerHTML = 'See all events <i class="bi bi-arrow-right"></i>';

  if (imgEl) {
    const rawUrl =
      randomEvent.originalImageUrl ||
      randomEvent.thumbnailUrl ||
      randomEvent.featuredImage ||
      "https://placehold.co/800x400?text=No+Image";
    imgEl.src = getOptimizedImageUrl(rawUrl, 800);
    imgEl.srcset = getResponsiveImageSrcset(rawUrl, [400, 800, 1200]);
    imgEl.sizes = "(max-width: 900px) 70vw, 25vw";
    imgEl.alt = randomEvent.title || "Today event image";
    imgEl.width = 800;
    imgEl.height = 400;
    imgEl.loading = "lazy";
    imgEl.decoding = "async";
  }
}

function formatTodayThroughTimeYear(value) {
  const year = Number.parseInt(String(value ?? ""), 10);
  if (Number.isFinite(year) && year < 0) return `${Math.abs(year)} BC`;
  return String(value || "—");
}

function updateTodayThroughTimeControls(viewport, previous, next) {
  if (!viewport || !previous || !next) return;
  const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  previous.disabled = viewport.scrollLeft <= 2;
  next.disabled = viewport.scrollLeft >= maxScroll - 2;
}

function selectTodayThroughTimeEvents(items, limit = 8) {
  const events = (Array.isArray(items) ? items : []).filter((event) =>
    Boolean(event && String(event.title || event.description || "").trim()),
  );
  const illustrated = events
    .map((event, sourceIndex) => ({
      event,
      sourceIndex,
      year: Number.parseInt(String(event?.year ?? ""), 10),
    }))
    .filter(({ event }) => Boolean(event.thumbnailUrl))
    .sort(
      (left, right) =>
        (Number.isFinite(left.year) ? left.year : Number.POSITIVE_INFINITY) -
          (Number.isFinite(right.year) ? right.year : Number.POSITIVE_INFINITY) ||
        left.sourceIndex - right.sourceIndex,
    );
  const selected = [];
  const seen = new Set();
  const add = (event) => {
    if (!event || selected.length >= limit || seen.has(event)) return;
    selected.push(event);
    seen.add(event);
  };
  const illustratedLimit = Math.min(limit, illustrated.length);
  if (illustratedLimit === 1) {
    add(illustrated[0].event);
  } else if (illustratedLimit > 1) {
    for (let index = 0; index < illustratedLimit; index += 1) {
      const sourceIndex = Math.round(
        (index * (illustrated.length - 1)) / (illustratedLimit - 1),
      );
      add(illustrated[sourceIndex].event);
    }
  }
  events.forEach(add);
  return selected.sort((left, right) => {
    const leftYear = Number.parseInt(String(left?.year ?? ""), 10);
    const rightYear = Number.parseInt(String(right?.year ?? ""), 10);
    return (
      (Number.isFinite(leftYear) ? leftYear : Number.POSITIVE_INFINITY) -
      (Number.isFinite(rightYear) ? rightYear : Number.POSITIVE_INFINITY)
    );
  });
}

async function populateTodayThroughTime() {
  const track = document.getElementById("todaysEventsGrid");
  const viewport = document.getElementById("todayThroughTimeViewport");
  const previous = document.getElementById("todayThroughTimePrev");
  const next = document.getElementById("todayThroughTimeNext");
  const count = document.getElementById("todayThroughTimeCount");
  const viewAll = document.getElementById("todayThroughTimeAll");
  if (!track || !viewport || !previous || !next) return;

  const today = new Date();
  const month = today.getMonth() + 1;
  const day = today.getDate();
  const monthSlug = monthNames[month - 1].toLowerCase();
  const datePageHref = `/events/${monthSlug}/${day}/`;

  try {
    const data = await fetchWikipediaEvents(month, day);
    const events = Array.isArray(data?.events) ? data.events : [];
    const selected = selectTodayThroughTimeEvents(events, 8);

    track.replaceChildren();
    if (!selected.length) {
      const empty = document.createElement("li");
      empty.className = "today-through-time-status";
      empty.textContent = "Today's timeline is temporarily unavailable.";
      track.appendChild(empty);
      previous.hidden = true;
      next.hidden = true;
      return;
    }

    selected.forEach((event) => {
      const title = String(event.title || event.description || "Historical event").trim();
      const anchorId = historicalEventAnchorId(event);
      const item = document.createElement("li");
      item.className = "today-through-time-item";

      const card = document.createElement("button");
      card.type = "button";
      card.className = "hero-highlight tl-card today-through-time-card";
      card.setAttribute("aria-haspopup", "dialog");
      card.setAttribute("aria-controls", "eventDetailModal");
      card.setAttribute("aria-expanded", "false");
      card.setAttribute("data-bs-toggle", "modal");
      card.setAttribute("data-bs-target", "#eventDetailModal");
      card.setAttribute(
        "aria-label",
        `Open details for ${formatTodayThroughTimeYear(event.year)}: ${title}`,
      );

      const body = document.createElement("span");
      body.className = "tl-card-body";
      const year = document.createElement("span");
      year.className = "tl-card-badge event-years-ago";
      year.textContent = formatTodayThroughTimeYear(event.year);
      const heading = document.createElement("span");
      heading.className = "tl-card-title";
      heading.textContent = title;
      let media;
      if (event.thumbnailUrl) {
        media = document.createElement("img");
        media.className = "tl-card-img";
        media.src = getOptimizedImageUrl(event.thumbnailUrl, 640, 80);
        media.srcset = getResponsiveImageSrcset(
          event.thumbnailUrl,
          [320, 640, 960],
          80,
        );
        media.sizes = "(max-width: 768px) 62vw, 28vw";
        media.alt = title;
        media.width = 640;
        media.height = 640;
        media.loading = "lazy";
        media.decoding = "async";
        media.addEventListener("error", () => {
          const fallback = document.createElement("span");
          fallback.className = "tl-card-img-blank";
          fallback.setAttribute("aria-hidden", "true");
          fallback.innerHTML = '<i class="bi bi-image-alt"></i>';
          media.replaceWith(fallback);
        });
      } else {
        card.classList.add("tl-card-noimg");
        media = document.createElement("span");
        media.className = "tl-card-img-blank";
        media.setAttribute("aria-hidden", "true");
        media.innerHTML = '<i class="bi bi-image-alt"></i>';
      }
      const actions = document.createElement("span");
      actions.className = "tl-card-actions";
      const action = document.createElement("span");
      action.className = "major-event-source";
      action.innerHTML = 'Open details <i class="bi bi-arrow-up-right" aria-hidden="true"></i>';
      actions.appendChild(action);
      body.append(heading, actions);
      card.append(year, media, body);
      card.addEventListener("click", (clickEvent) => {
        if (!getEventDetailModal()) {
          clickEvent.preventDefault();
          window.location.assign(`${datePageHref}#${anchorId}`);
          return;
        }
        // This card opens the modal after preparing its focused content. Stop
        // Bootstrap's delegated data-api handler from toggling the same modal
        // a second time after this listener bubbles to the document.
        clickEvent.stopPropagation();
        lastActiveCard = card;
        currentActiveFilter = "all";
        void showEventDetails(day, month, today.getFullYear(), data, anchorId);
      });
      item.appendChild(card);
      track.appendChild(item);
    });

    const totalEvents = Number(data?.counts?.events) || events.length;
    if (count) {
      count.textContent = `${totalEvents} event${totalEvents === 1 ? "" : "s"} recorded on this date`;
    }
    if (viewAll) {
      viewAll.href = datePageHref;
      viewAll.innerHTML = `View all ${totalEvents} events <i class="bi bi-arrow-right" aria-hidden="true"></i>`;
    }

    const scroll = (direction) => {
      const firstItem = track.querySelector(".today-through-time-item");
      const cardStep =
        (firstItem instanceof HTMLElement ? firstItem.offsetWidth : 0) + 12;
      viewport.scrollBy({
        left:
          direction *
          (cardStep > 12
            ? cardStep
            : Math.max(180, Math.floor(viewport.clientWidth * 0.6667))),
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    };
    previous.addEventListener("click", () => scroll(-1));
    next.addEventListener("click", () => scroll(1));
    viewport.addEventListener(
      "scroll",
      () => updateTodayThroughTimeControls(viewport, previous, next),
      { passive: true },
    );
    viewport.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        scroll(event.key === "ArrowLeft" ? -1 : 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        viewport.scrollTo({ left: 0, behavior: "smooth" });
      } else if (event.key === "End") {
        event.preventDefault();
        viewport.scrollTo({ left: viewport.scrollWidth, behavior: "smooth" });
      }
    });
    window.addEventListener(
      "resize",
      () => updateTodayThroughTimeControls(viewport, previous, next),
      { passive: true },
    );
    requestAnimationFrame(() =>
      updateTodayThroughTimeControls(viewport, previous, next),
    );
  } catch (error) {
    track.innerHTML =
      '<li class="today-through-time-status">Today\'s timeline failed to load. Please try again.</li>';
    previous.hidden = true;
    next.hidden = true;
  }
}

let currentDayAllItems = [];
let currentDayEventsData = null;
let currentActiveFilter = "all";
let currentModalDay = null;
let currentModalMonth = null;
let currentModalPersonLinks = new Map();

const eventCategories = {
  "War & Conflict": {
    include: [
      "war",
      "battle",
      "conflict",
      "siege",
      "attack",
      "invasion",
      "armistice",
      "military",
      "army",
      "navy",
      "air force",
      "troops",
      "soldiers",
      "fighting",
      "bombing",
      "genocide",
      "uprising",
      "rebellion",
      "revolution",
      "combat",
      "offensive",
      "surrender",
      "ceasefire",
      "annexation",
      "occupation",
      "insurrection",
      "bloodshed",
      "massacre",
      "mutiny",
      "crusade",
      "jihad",
      "liberation",
      "resistance",
      "revolt",
      "civil war",
      "world war",
      "cold war",
      "terrorism",
      "warfare",
      "hostilities",
      "blitzkrieg",
      "partisan",
      "militia",
      "casualty",
      "prisoner of war",
      "pow",
      "truce",
      "alliance",
      "blockade",
      "skirmish",
      "campaign",
      "guerilla",
      "guerrilla",
      "front",
      "regiment",
      "battalion",
      "division",
      "corps",
      "fleet",
      "squadron",
      "embargo",
      "sanctions",
    ],
    exclude: [
      "war on poverty",
      "war on drugs",
      "trade war",
      "price war",
      "culture war",
      "cold war era",
      "post-war",
      "pre-war",
      "war memorial",
      "war museum",
      "star wars",
      "console wars",
      "format war",
      "browser war",
    ],
  },
  "Politics & Government": {
    include: [
      "president",
      "king",
      "queen",
      "emperor",
      "parliament",
      "election",
      "government",
      "constitution",
      "assassination",
      "coup",
      "republic",
      "monarchy",
      "vote",
      "congress",
      "senate",
      "law",
      "act",
      "decree",
      "political",
      "prime minister",
      "chancellor",
      "diplomatic",
      "ambassador",
      "summit",
      "federation",
      "state",
      "nation",
      "cabinet",
      "ministry",
      "legislature",
      "policy",
      "proclamation",
      "administration",
      "sovereignty",
      "referendum",
      "bill",
      "veto",
      "democracy",
      "autocracy",
      "dictatorship",
      "regime",
      "governance",
      "embassy",
      "treaty",
      "accord",
      "pact",
      "impeachment",
      "inauguration",
      "coronation",
      "abdication",
      "succession",
      "dynasty",
      "duke",
      "duchess",
      "prince",
      "princess",
      "governor",
      "senator",
      "congressman",
      "minister",
      "mayor",
    ],
    exclude: [
      "student government",
      "corporate governance",
      "self-government",
      "government contract",
      "government employee",
      "government building",
      "king size",
      "queen bed",
      "emperor penguin",
      "minister of religion",
      "political science",
      "political theory",
      "political philosophy",
    ],
  },
  "Science & Technology": {
    include: [
      "discovery",
      "invention",
      "scientific",
      "technology",
      "space",
      "astronomy",
      "physics",
      "chemistry",
      "biology",
      "computer",
      "internet",
      "research",
      "experiment",
      "patent",
      "launch",
      "satellite",
      "innovation",
      "breakthrough",
      "engineering",
      "robotics",
      "artificial intelligence",
      "AI",
      "software",
      "hardware",
      "algorithm",
      "biotechnology",
      "genetics",
      "medicine",
      "vaccine",
      "cure",
      "theory",
      "quantum",
      "relativity",
      "telescope",
      "microscope",
      "nuclear",
      "reactor",
      "digital",
      "network",
      "laboratory",
      "mars",
      "moon landing",
      "shuttle",
      "rocket",
      "probe",
      "rover",
      "orbit",
      "astronaut",
      "cosmonaut",
      "dna",
      "genome",
      "cloning",
      "antibiotic",
      "surgery",
      "transplant",
      "laser",
      "nanotechnology",
      "renewable energy",
    ],
    exclude: [
      "rocket science",
      "brain surgery",
      "computer game",
      "computer graphics",
      "internet meme",
      "space opera",
      "space fantasy",
      "digital art",
      "digital music",
      "network television",
      "social network",
      "patent leather",
      "medicine man",
      "folk medicine",
      "alternative medicine",
      "space race",
    ],
  },
  "Arts & Culture": {
    include: [
      "art",
      "music",
      "film",
      "literature",
      "theater",
      "theatre",
      "opera",
      "painting",
      "sculpture",
      "artist",
      "writer",
      "poet",
      "composer",
      "play",
      "novel",
      "exhibition",
      "festival",
      "museum",
      "gallery",
      "symphony",
      "ballet",
      "premiere",
      "architect",
      "architecture",
      "dance",
      "photography",
      "fashion",
      "design",
      "masterpiece",
      "album",
      "song",
      "director",
      "actor",
      "actress",
      "performance",
      "folklore",
      "tradition",
      "heritage",
      "craft",
      "poetry",
      "prose",
      "cinema",
      "movie",
      "documentary",
      "concert",
      "recital",
      "manuscript",
      "bestseller",
      "anthology",
      "autobiography",
      "biography",
    ],
    exclude: [
      "art dealer",
      "art market",
      "music industry",
      "film industry",
      "theater of war",
      "performance indicator",
      "performance review",
      "architect of peace",
      "fashion police",
      "design pattern",
      "song bird",
      "actor model",
      "play ground",
      "novel idea",
      "craft beer",
      "craft fair",
    ],
  },
  "Disasters & Accidents": {
    include: [
      "earthquake",
      "flood",
      "hurricane",
      "tornado",
      "volcano",
      "tsunami",
      "epidemic",
      "pandemic",
      "famine",
      "disaster",
      "collapse",
      "accident",
      "crash",
      "fire",
      "explosion",
      "sinking",
      "blizzard",
      "drought",
      "tragedy",
      "catastrophe",
      "derailment",
      "wreck",
      "shipwreck",
      "landslide",
      "avalanche",
      "heatwave",
      "cyclone",
      "typhoon",
      "wildfire",
      "oil spill",
      "nuclear accident",
      "meltdown",
      "toxic leak",
      "pollution",
      "plague",
      "outbreak",
      "mudslide",
      "natural disaster",
      "calamity",
      "emergency",
      "evacuation",
      "rescue",
    ],
    exclude: [
      "disaster movie",
      "train wreck",
      "car crash test",
      "fire drill",
      "fire department",
      "fire station",
      "disaster preparedness",
      "emergency room",
      "emergency exit",
      "fire alarm",
      "smoke detector",
      "rescue dog",
    ],
  },
  Sports: {
    include: [
      "olympic",
      "olympics",
      "championship",
      "sport",
      "tournament",
      "medal",
      "cup",
      "athlete",
      "competition",
      "match",
      "record",
      "goal",
      "world cup",
      "football",
      "soccer",
      "basketball",
      "baseball",
      "tennis",
      "golf",
      "cricket",
      "rugby",
      "boxing",
      "swimming",
      "athletics",
      "marathon",
      "cycling",
      "skiing",
      "hockey",
      "volleyball",
      "formula 1",
      "super bowl",
      "grand slam",
      "trophy",
      "league",
      "season",
      "final",
      "playoffs",
      "stadium",
      "arena",
      "player",
      "coach",
      "race",
      "gymnastics",
      "wrestling",
      "sailing",
      "rowing",
      "diving",
    ],
    exclude: [
      "sport utility",
      "good sport",
      "sport coat",
      "transport",
      "passport",
      "stadium seating",
      "arena rock",
      "player piano",
      "coach class",
      "record label",
      "record store",
      "goal post",
      "cup holder",
      "medal of honor",
    ],
  },
  "Social & Human Rights": {
    include: [
      "slavery",
      "rights",
      "protest",
      "movement",
      "discrimination",
      "equality",
      "justice",
      "reform",
      "activist",
      "civil rights",
      "emancipation",
      "suffrage",
      "demonstration",
      "strike",
      "boycott",
      "freedom",
      "liberty",
      "charter",
      "humanitarian",
      "welfare",
      "labor rights",
      "women's rights",
      "minority rights",
      "indigenous rights",
      "refugee",
      "migration",
      "poverty",
      "social justice",
      "human rights",
      "civil liberties",
      "segregation",
      "integration",
      "march",
    ],
    exclude: [
      "property rights",
      "copyright",
      "patent rights",
      "mineral rights",
      "labor day",
      "labor cost",
      "welfare state",
      "freedom fighter",
      "liberty bell",
      "charter school",
      "charter flight",
      "reform school",
    ],
  },
  "Economy & Business": {
    include: [
      "bank",
      "stock market",
      "company",
      "trade",
      "economy",
      "financial",
      "industry",
      "currency",
      "market",
      "business",
      "corporation",
      "commerce",
      "recession",
      "inflation",
      "depression",
      "merger",
      "acquisition",
      "bankruptcy",
      "debt",
      "investment",
      "capital",
      "shares",
      "bonds",
      "tariff",
      "tax",
      "monopoly",
      "union",
      "manufacturing",
      "agriculture",
      "mining",
      "transport",
      "shipping",
      "railway",
      "airline",
      "boom",
      "bust",
      "entrepreneur",
      "startup",
      "globalization",
      "free trade",
      "commodity",
      "export",
      "import",
      "retail",
    ],
    exclude: [
      "blood bank",
      "river bank",
      "bank holiday",
      "investment bank",
      "food bank",
      "data bank",
      "piggy bank",
      "company picnic",
      "trade winds",
      "trade secret",
      "market place",
      "market research",
      "labor union",
      "student union",
      "european union",
      "tax break",
      "tax shelter",
    ],
  },
  "Health & Medicine": {
    include: [
      "hospital",
      "disease",
      "illness",
      "epidemic",
      "pandemic",
      "plague",
      "outbreak",
      "vaccine",
      "vaccination",
      "inoculation",
      "quarantine",
      "surgery",
      "transplant",
      "antibiotic",
      "penicillin",
      "treatment",
      "therapy",
      "diagnosis",
      "clinical",
      "pathology",
      "anatomy",
      "physician",
      "surgeon",
      "nursing",
      "public health",
      "healthcare",
      "health care",
      "red cross",
      "world health organization",
      "blood transfusion",
      "organ donation",
      "mental health",
      "psychiatric",
      "insulin",
      "chemotherapy",
      "radiation therapy",
      "DNA sequencing",
      "gene therapy",
    ],
    exclude: [
      "medicine man",
      "folk medicine",
      "alternative medicine",
      "witch doctor",
      "medicine show",
      "sports medicine",
    ],
  },
  "Exploration & Discovery": {
    include: [
      "expedition",
      "explorer",
      "exploration",
      "voyage",
      "circumnavigation",
      "cartography",
      "northwest passage",
      "new world",
      "colonization",
      "settlers",
      "frontier",
      "arctic",
      "antarctic",
      "mount everest",
      "deep sea",
      "first ascent",
      "first crossing",
      "first descent",
      "terra incognita",
      "uncharted",
      "conquistador",
      "new territory",
      "geographical",
    ],
    exclude: ["oil exploration", "space exploration", "mineral exploration"],
  },
  "Famous Persons": {
    include: [
      "author",
      "scientist",
      "composer",
      "philosopher",
      "physicist",
      "mathematician",
      "writer",
      "poet",
      "singer",
      "musician",
      "painter",
      "sculptor",
      "inventor",
      "explorer",
      "general",
      "statesman",
      "revolutionary",
      "humanitarian",
      "scholar",
      "economist",
      "historian",
      "novelist",
      "playwright",
      "choreographer",
      "dancer",
      "photographer",
      "journalist",
      "pioneer",
      "visionary",
      "genius",
      "celebrity",
      "laureate",
    ],
    exclude: [
      "ghost writer",
      "song writer",
      "copy writer",
      "type writer",
      "explorer browser",
      "general store",
      "general public",
      "general knowledge",
      "revolutionary war",
      "pioneer species",
      "dance music",
      "singer sewing machine",
    ],
  },
};

const categoryEmojis = {
  All: "📅",
  "War & Conflict": "⚔️",
  "Politics & Government": "🏛️",
  "Science & Technology": "🔬",
  "Arts & Culture": "🎭",
  "Disasters & Accidents": "🌋",
  Sports: "🏆",
  "Social & Human Rights": "✊",
  "Economy & Business": "📈",
  "Health & Medicine": "💊",
  "Exploration & Discovery": "🧭",
  Births: "👶",
  Deaths: "🕯️",
  "Famous Persons": "⭐",
  Miscellaneous: "📌",
};

function trackDayVisit(month, day) {
  const key = `${month}-${day}`;
  try {
    const data = JSON.parse(sessionStorage.getItem("thisDayExplored") || "[]");
    if (!data.includes(key)) data.push(key);
    sessionStorage.setItem("thisDayExplored", JSON.stringify(data));
    return data.length;
  } catch {
    return 1;
  }
}

function modalItemReadMoreHref(item) {
  const monthSlug = monthNames[currentModalMonth - 1]?.toLowerCase();
  if (!monthSlug || !currentModalDay) return item?.sourceUrl || "#";
  if (item?.type === "event") {
    return `/events/${monthSlug}/${currentModalDay}/#${historicalEventAnchorId(item)}`;
  }

  const slug = item?.slug || slugifyPersonName(item?.wikiTitle || item?.title || "");
  const localProfile = slug ? currentModalPersonLinks.get(slug) : null;
  if (localProfile) return localProfile;
  const route = item?.type === "death" ? "died" : "born";
  return `/${route}/${monthSlug}/${currentModalDay}/#${historicalPersonAnchorId(
    item,
    item?.type,
  )}`;
}

function matchesCategory(text, categoryRules) {
  const lowerText = text.toLowerCase();
  for (const excludeKeyword of categoryRules.exclude) {
    if (lowerText.includes(excludeKeyword.toLowerCase())) {
      return false;
    }
  }
  for (const includeKeyword of categoryRules.include) {
    if (lowerText.includes(includeKeyword.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function assignCategories(item) {
  const categoriesFound = new Set();
  if (item.type === "birth") {
    categoriesFound.add("Births");
    categoriesFound.add("Famous Persons");
  } else if (item.type === "death") {
    categoriesFound.add("Deaths");
    categoriesFound.add("Famous Persons");
  }
  const itemText = (item.description || item.title || "").toLowerCase();
  for (const categoryName in eventCategories) {
    if (matchesCategory(itemText, eventCategories[categoryName])) {
      categoriesFound.add(categoryName);
    }
  }
  const nonTypeBased = Array.from(categoriesFound).filter(
    (cat) => cat !== "Births" && cat !== "Deaths",
  );
  if (nonTypeBased.length === 0 && !categoriesFound.has("Famous Persons")) {
    categoriesFound.add("Miscellaneous");
  }
  return Array.from(categoriesFound);
}

// Returns a short editorial commentary for a given event based on its era and category
function getEventCommentary(event) {
  const year = parseInt(event.year, 10);
  const text = (event.description || "").toLowerCase();
  const cats = event.categories || [];

  // Births and deaths get their own commentary
  if (event.type === "birth") {
    if (year < 500)
      return "A figure from the ancient world whose ideas still echo today.";
    if (year < 1400)
      return "Born in an era before mass literacy, yet their legacy endured for centuries.";
    if (year < 1700)
      return "Their birth came at a time when the modern world was just taking shape.";
    if (year < 1900)
      return "A product of the industrial age, shaped by revolution and rapid change.";
    return "A life lived in the modern era — closer to us than it might feel.";
  }
  if (event.type === "death") {
    if (year < 500)
      return "Their passing marked the end of a chapter in the ancient world.";
    if (year < 1400)
      return "With their death, an era drew to a close — but their influence lingered.";
    if (year < 1700)
      return "The world they left behind would soon look very different from the one they knew.";
    return "History often turns on the loss of a single person. This was one of those moments.";
  }

  // Category-based commentary for events
  const isWar =
    cats.some((c) => /war|conflict|battle|military/i.test(c)) ||
    /war|battle|siege|troops|army|invasion|conflict|defeat|victory/i.test(text);
  const isScience =
    cats.some((c) => /science|technology|discovery/i.test(c)) ||
    /discover|invent|patent|experiment|launch|orbit|atom|gene|vaccine|telescope|microscope/i.test(
      text,
    );
  const isPolitics =
    cats.some((c) => /politic|government|law/i.test(c)) ||
    /treaty|signed|declared|constitution|parliament|election|president|king|queen|emperor|independence/i.test(
      text,
    );
  const isExploration =
    /explorer|voyage|expedition|columbus|magellan|circumnavigat|territory|discovered/i.test(
      text,
    );
  const isReligion =
    /pope|church|cathedral|crusade|reformation|religion|faith|missionary/i.test(
      text,
    );
  const isArts =
    cats.some((c) => /art|culture|literature/i.test(c)) ||
    /publish|painting|novel|symphony|poem|theatre|opera|film|broadcast/i.test(
      text,
    );

  const era =
    year < 500
      ? "ancient"
      : year < 1400
        ? "medieval"
        : year < 1700
          ? "early modern"
          : year < 1900
            ? "modern"
            : "contemporary";

  if (isWar) {
    const warComments = {
      ancient:
        "Conflict in the ancient world was total — no distinction between soldier and civilian, victor and conquered.",
      medieval:
        "Medieval warfare was as much about starvation and disease as it was about the battlefield.",
      "early modern":
        "Gunpowder changed the nature of war forever — this event reflects that transformation.",
      modern:
        "By this point, warfare had become industrialized, turning individual soldiers into statistics.",
      contemporary:
        "Modern conflicts are fought as much in the media as on the ground — context matters enormously.",
    };
    return (
      warComments[era] ||
      "War has always reshaped the boundaries of the possible."
    );
  }
  if (isScience) {
    const sciComments = {
      ancient:
        "In the ancient world, science and philosophy were inseparable — observation met mythology.",
      medieval:
        "Medieval scholars preserved and debated classical knowledge, laying groundwork they'd never see built.",
      "early modern":
        "The Scientific Revolution was underway — each discovery chipped away at centuries of assumption.",
      modern:
        "The 19th century turned science into an industry, accelerating change at an unprecedented rate.",
      contemporary:
        "Modern science moves so fast that today's breakthrough can become tomorrow's footnote.",
    };
    return (
      sciComments[era] ||
      "Every scientific breakthrough begins with someone daring to ask a different question."
    );
  }
  if (isExploration) {
    return year < 1600
      ? "The Age of Exploration reshaped the world — and not always for the better for those already living in it."
      : "Exploration is humanity's oldest instinct; the destinations just keep changing.";
  }
  if (isPolitics) {
    const polComments = {
      ancient:
        "Political power in the ancient world was deeply personal — empires rose and fell with individual rulers.",
      medieval:
        "Feudal politics were a constant negotiation between loyalty, land, and survival.",
      "early modern":
        "Nation-states were being invented in real time — the rules of governance were far from settled.",
      modern:
        "The 19th century saw democracy and nationalism collide with old imperial order.",
      contemporary:
        "Political events rarely happen in isolation — every decision carries the weight of what came before.",
    };
    return (
      polComments[era] ||
      "Political moments that seem small at the time often define generations."
    );
  }
  if (isReligion) {
    return year < 1500
      ? "In this era, religious authority and political power were nearly impossible to separate."
      : "Religion has always been both a comfort and a flashpoint — this event is a reminder of both.";
  }
  if (isArts) {
    return year < 1800
      ? "Art in this period was largely patronage-driven — what survived reflects who had money and power."
      : "Culture is the record a society keeps of itself. This moment left a lasting mark.";
  }

  // Generic era-based fallback
  const generic = {
    ancient:
      "Events from this era survive through fragments — every detail we have was preserved against the odds.",
    medieval:
      "The medieval world was far more connected and complex than popular imagination suggests.",
    "early modern":
      "This was an age of transition — old certainties crumbling, new ones not yet formed.",
    modern: "The 19th century compressed centuries of change into decades.",
    contemporary:
      "History is still being written about this period. Perspective takes time.",
  };
  return generic[era] || "Every date in history is someone's entire world.";
}

// Fetch AI-generated commentary from the worker and update the modal in-place
async function fetchAndApplyCommentary(month, day) {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  try {
    const resp = await fetch(`/api/commentary/${mm}/${dd}`);
    if (!resp.ok) return;
    const commentaryMap = await resp.json();
    if (!commentaryMap || !Object.keys(commentaryMap).length) return;
    // Persist on items so re-renders (filtering) keep AI commentary
    currentDayAllItems.forEach((item) => {
      const key = `${item.year}:${(item.description || "").substring(0, 30)}`;
      if (commentaryMap[key]) item.commentary = commentaryMap[key];
    });
    // Inject commentary paragraphs into event cards that have a match
    const modal = document.getElementById("modalBodyContent");
    if (!modal) return;
    modal.querySelectorAll("[data-ckey]").forEach((li) => {
      const text = commentaryMap[li.dataset.ckey];
      if (!text) return;
      // Don't double-inject
      if (li.querySelector(".event-commentary")) return;
      const p = document.createElement("p");
      p.className = "mb-2 fst-italic event-commentary";
      p.innerHTML = `<i class="bi bi-chat-quote me-1 event-commentary-icon"></i><span class="commentary-text">${text}</span>`;
      // Insert before .event-actions
      const actions = li.querySelector(".event-actions");
      if (actions) actions.before(p);
    });
  } catch (_) {
    // Fail silently — commentary section stays hidden
  }
}

function renderFilteredItems(itemsToRender) {
  const eventsListDiv = document.getElementById("modal-events-list");
  if (!eventsListDiv) return;
  if (itemsToRender.length === 0) {
    eventsListDiv.innerHTML =
      "<p class='text-muted text-center'>No items found for this category.</p>";
    return;
  }
  const escHtml = (value) =>
    String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  const currentYear = new Date().getFullYear();
  let htmlContent = `<div class="modal-timeline" role="list">`;
  itemsToRender.forEach((event) => {
    let typeLabel = "Event";
    if (event.type === "birth") {
      typeLabel = "Birth";
    } else if (event.type === "death") {
      typeLabel = "Death";
    }
    // Years ago badge — shown for all historical events
    const eventYear = parseInt(event.year, 10);
    const yearsAgo = currentYear - eventYear;
    let anniversaryBadge = "";
    if (yearsAgo > 0) {
      anniversaryBadge = `<span class="event-years-ago ms-2">${yearsAgo} years ago</span>`;
    }

    const fullDescription = String(event.description || "");
    const commaIndex = fullDescription.indexOf(",");
    let titleText = String(event.title || "").trim();
    let supportingText = "";
    if (event.type === "birth" || event.type === "death") {
      if (!titleText && commaIndex > 0) {
        titleText = fullDescription.slice(0, commaIndex).trim();
      }
      supportingText =
        event.pageDescription ||
        (commaIndex > 0 ? fullDescription.slice(commaIndex + 1).trim() : "");
    } else {
      titleText = titleText || pickTeaserSentence(fullDescription) || fullDescription;
      supportingText = fullDescription.trim();
      if (
        titleText &&
        supportingText.toLowerCase().startsWith(titleText.toLowerCase())
      ) {
        supportingText = supportingText.slice(titleText.length).trim();
      }
    }
    supportingText = supportingText.replace(/^\s*[-–—:]\s*/, "");
    if (!supportingText && fullDescription.trim() !== titleText) {
      supportingText = fullDescription.trim();
    }
    const extractText = String(event.pageExtract || "").trim();
    const imageAlt = titleText || event.title || "Historical event";
    const itemAnchorId =
      event.type === "event"
        ? historicalEventAnchorId(event)
        : historicalPersonAnchorId(event, event.type);
    const readMoreHref = modalItemReadMoreHref(event);
    const modalImageUrl = event.thumbnailUrl
      ? getOptimizedImageUrl(event.thumbnailUrl, 320, 80)
      : "";
    const modalImageSrcset = event.thumbnailUrl
      ? getResponsiveImageSrcset(event.thumbnailUrl, [160, 320], 80)
      : "";
    const mediaHtml = event.thumbnailUrl
      ? `
                        <div class="modal-tl-media">
                            <img src="${escHtml(modalImageUrl)}"
                                ${modalImageSrcset ? `srcset="${escHtml(modalImageSrcset)}" sizes="160px"` : ""}
                                alt="${escHtml(imageAlt.substring(0, 80))}" width="160" height="120" loading="lazy" decoding="async" onerror="this.parentElement.remove()">
                        </div>
                        `
      : "";

    htmlContent += `
            <article class="modal-tl-item event-item${event.thumbnailUrl ? " event-item-has-thumb" : ""}" role="listitem" data-ckey="${`${escHtml(event.year)}:${escHtml((event.description || "").substring(0, 30))}`}" data-item-anchor="${escHtml(itemAnchorId)}">
                <div class="modal-tl-marker">
                  <span class="event-year-text">${escHtml(event.year)}</span>
                </div>
                <div class="modal-tl-card">
                    ${mediaHtml}
                    <div class="modal-tl-body event-item-body">
                        <div class="modal-tl-meta">
                          <span class="modal-tl-type">${typeLabel}</span>
                          ${anniversaryBadge}
                        </div>
                        <h3 class="modal-tl-title">${escHtml(titleText)}</h3>
                        ${
                          supportingText
                            ? `<p class="modal-tl-desc mb-1">${escHtml(supportingText)}</p>`
                            : ""
                        }
                        ${
                          extractText
                            ? `<p class="modal-tl-extract">${escHtml(extractText)}</p>`
                            : ""
                        }
                        ${event.commentary ? `<p class="mb-2 fst-italic event-commentary"><i class="bi bi-chat-quote me-1 event-commentary-icon"></i><span class="commentary-text">${escHtml(event.commentary)}</span></p>` : ""}
                        <div class="event-actions modal-tl-actions">
                          <a href="${escHtml(readMoreHref)}" class="event-action-btn event-action-read btn btn-contrast btn-sm">
                            Read More
                          </a>
                        </div>
                    </div>
                </div>
            </article>`;
  });
  htmlContent += `</div>`;
  eventsListDiv.innerHTML = htmlContent;
}

function focusModalTimelineItem(itemAnchorId) {
  if (!itemAnchorId) return;
  const target = Array.from(
    modalBodyContent?.querySelectorAll("[data-item-anchor]") || [],
  ).find((item) => item.dataset.itemAnchor === itemAnchorId);
  if (!target) return;
  target.classList.add("modal-tl-item-targeted");
  target.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
    block: "center",
  });
}

function applyFilter() {
  const listToFilter = currentDayAllItems;
  const filteredItems = listToFilter.filter((item) => {
    if (currentActiveFilter === "all") {
      return true;
    }
    return item.categories
      .map((cat) => cat.toLowerCase())
      .includes(currentActiveFilter);
  });
  renderFilteredItems(filteredItems);

  // Scroll slowly to the first event after filtering
  setTimeout(() => {
    const eventsListDiv = document.getElementById("modal-events-list");
    if (eventsListDiv) {
      const firstTimelineEvent =
        eventsListDiv.querySelector(".modal-tl-item");
      if (firstTimelineEvent) {
        firstTimelineEvent.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  }, 100);
}

async function showEventDetails(
  day,
  month,
  year,
  preFetchedStructuredEvents = null,
  focusedItemAnchorId = "",
) {
  currentModalDay = day;
  currentModalMonth = month;
  const daysExplored = trackDayVisit(month, day);
  modalDate.textContent = `${day}. ${monthNames[month - 1]}`;
  if (modalDateSummary) {
    modalDateSummary.textContent =
      "A timeline of events, births, and deaths recorded for this date.";
  }
  modalBodyContent.innerHTML =
    "<div class='text-center'><div class='spinner-border' role='status'></div><p>Loading events...</p></div>";
  getEventDetailModal()?.show();
  lastActiveCard?.setAttribute("aria-expanded", "true");
  const personLinksPromise = fetchModalPersonLinks();
  let structuredEvents = preFetchedStructuredEvents;
  try {
    if (
      !structuredEvents ||
      structuredEvents.partial === true ||
      (structuredEvents.events?.length === 0 &&
        structuredEvents.births?.length === 0 &&
        structuredEvents.deaths?.length === 0)
    ) {
      structuredEvents = await fetchWikipediaEvents(month, day, {
        requireFull: true,
      });
    }
    const personIndex = await personLinksPromise;
    currentModalPersonLinks = new Map(
      personIndex
        .filter(
          (person) =>
            person?.slug && (person?.url || person?.indexable !== false),
        )
        .map((person) => [person.slug, person.url || `/people/${person.slug}/`]),
    );
    currentDayEventsData = structuredEvents;
    currentDayAllItems = [
      ...(structuredEvents.events || []),
      ...(structuredEvents.births || []),
      ...(structuredEvents.deaths || []),
    ].map((item) => ({
      ...item,
      categories: assignCategories(item),
    }));
    currentDayAllItems.sort((a, b) => {
      const yearA = parseInt(a.year, 10) || 0;
      const yearB = parseInt(b.year, 10) || 0;
      return yearA - yearB;
    });
    const allAvailableCategories = new Set(["All"]);
    currentDayAllItems.forEach((item) => {
      item.categories.forEach((cat) => allAvailableCategories.add(cat));
    });
    const sortedCategories = Array.from(allAvailableCategories).sort((a, b) => {
      if (a === "All") return -1;
      if (b === "All") return 1;
      if (a === "Births") return -1;
      if (b === "Births") return 1;
      if (a === "Deaths") return -1;
      if (b === "Deaths") return 1;
      if (a === "Famous Persons" && b !== "Births" && b !== "Deaths") return -1;
      if (b === "Famous Persons" && a !== "Births" && a !== "Deaths") return 1;
      return a.localeCompare(b);
    });
    const escapeFilterLabel = (value) =>
      String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    const activeFilterLabel =
      sortedCategories.find(
        (category) => category.toLowerCase() === currentActiveFilter,
      ) || "All";
    let filterButtonsHtml = `<div id="eventFilterContainer" class="event-filter-dropdown dropdown">
      <button class="btn btn-sm btn-contrast event-filter-toggle dropdown-toggle" type="button" id="eventFilterDropdown" data-bs-toggle="dropdown" aria-expanded="false">
        <i class="bi bi-funnel" aria-hidden="true"></i>
        <span class="event-filter-toggle-text">Filter: ${escapeFilterLabel(activeFilterLabel)}</span>
      </button>
      <div class="dropdown-menu event-filter-menu" aria-labelledby="eventFilterDropdown">`;
    sortedCategories.forEach((category) => {
      const isActive =
        category.toLowerCase() === currentActiveFilter ? "active" : "";
      filterButtonsHtml += `<button type="button" class="dropdown-item filter-btn event-filter-option ${isActive}" data-category="${escapeFilterLabel(category.toLowerCase())}" aria-pressed="${isActive ? "true" : "false"}">${escapeFilterLabel(category)}</button>`;
    });
    filterButtonsHtml += `</div></div>`;
    const totalEvents = currentDayAllItems.length;
    if (modalDateSummary) {
      const eventCount = structuredEvents.events?.length || 0;
      const birthCount = structuredEvents.births?.length || 0;
      const deathCount = structuredEvents.deaths?.length || 0;
      modalDateSummary.textContent = `${totalEvents} timeline item${
        totalEvents !== 1 ? "s" : ""
      }: ${eventCount} event${eventCount !== 1 ? "s" : ""}, ${birthCount} birth${
        birthCount !== 1 ? "s" : ""
      }, and ${deathCount} death${deathCount !== 1 ? "s" : ""} from across history.`;
    }
    const exploredLabel =
      daysExplored === 1 ? "1 day explored" : `${daysExplored} days explored`;
    // Filters always on top
    let modalHtml = `
      <div class="modal-header-content">
        ${filterButtonsHtml}
        <div class="d-flex justify-content-between align-items-center mb-3 px-1" style="font-size:0.8rem;opacity:0.75;">
          <span>📖 ${totalEvents} event${totalEvents !== 1 ? "s" : ""} on this day</span>
          <span>🗓️ ${exploredLabel}</span>
        </div>
      </div>
    `;
    // Everything is shown in one single filtered list, not a separate featured block.
    modalHtml += `<div id="modal-events-list"></div>`;
    modalBodyContent.innerHTML = modalHtml;
    modalBodyContent.querySelectorAll(".filter-btn").forEach((button) => {
      button.addEventListener("click", (event) => {
        const clickedButton = event.target.closest(".filter-btn");
        if (!clickedButton) return;
        const clickedCategory = clickedButton.dataset.category;
        if (clickedCategory === currentActiveFilter) {
          currentActiveFilter = "all";
          clickedButton.classList.remove("active");
          const allButton = modalBodyContent.querySelector(
            '.filter-btn[data-category="all"]',
          );
          if (allButton) {
            allButton.classList.add("active");
          }
        } else {
          currentActiveFilter = clickedCategory;
          modalBodyContent
            .querySelectorAll(".filter-btn")
            .forEach((btn) => {
              btn.classList.remove("active");
              btn.setAttribute("aria-pressed", "false");
            });
          clickedButton.classList.add("active");
        }
        modalBodyContent.querySelectorAll(".filter-btn").forEach((btn) => {
          btn.setAttribute(
            "aria-pressed",
            btn.classList.contains("active") ? "true" : "false",
          );
        });
        const selectedLabel =
          modalBodyContent.querySelector(".filter-btn.active")?.textContent?.trim() ||
          "All";
        const toggleText = modalBodyContent.querySelector(
          ".event-filter-toggle-text",
        );
        if (toggleText) toggleText.textContent = `Filter: ${selectedLabel}`;
        applyFilter();
      });
    });
    applyFilter();
    if (focusedItemAnchorId) {
      requestAnimationFrame(() => focusModalTimelineItem(focusedItemAnchorId));
    }
    fetchAndApplyCommentary(month, day);

    // Born / Died accordion wiring
    ["Born", "Died"].forEach((type) => {
      const toggle = modalBodyContent.querySelector(`#toggle${type}`);
      const panel = modalBodyContent.querySelector(`#panel${type}`);
      const content = modalBodyContent.querySelector(`#content${type}`);
      const countEl = modalBodyContent.querySelector(
        `#${type.toLowerCase()}Count`,
      );
      if (!toggle || !panel || !content) return;
      let loaded = false;

      const activateToggle = () => {
        const isOpen = toggle.getAttribute("aria-expanded") === "true";
        toggle.setAttribute("aria-expanded", String(!isOpen));
        panel.hidden = isOpen;
        toggle
          .querySelector(".born-died-chevron")
          .classList.toggle("rotated", !isOpen);

        if (!isOpen && !loaded) {
          loaded = true;
          const section = type.toLowerCase();
          const people =
            currentDayEventsData?.[section === "born" ? "births" : "deaths"] ||
            [];
          if (countEl)
            countEl.innerHTML = `<span>${people.length}</span> <i class="bi bi-chevron-down born-died-chevron${!isOpen ? " rotated" : ""}"></i>`;
          if (people.length === 0) {
            content.innerHTML = `<p class="text-muted text-center py-2" style="font-size:0.85rem;">No data available.</p>`;
            return;
          }
          content.innerHTML = people
            .map(
              (p) => `
            <div class="born-died-person">
              ${
                p.thumbnailUrl
                  ? `<img src="${getOptimizedImageUrl(p.thumbnailUrl, 72, 80)}" srcset="${getResponsiveImageSrcset(p.thumbnailUrl, [36, 72], 80)}" sizes="36px" alt="${p.title || ""}" class="born-died-thumb" width="36" height="36" loading="lazy" decoding="async" onerror="this.remove()">`
                  : ""
              }
              <div class="born-died-info">
                <a href="${p.sourceUrl || "#"}" target="_blank" rel="noopener" class="born-died-name">${p.title || p.description?.substring(0, 40) || ""}</a>
                <span class="born-died-year">${p.year ?? ""}</span>
              </div>
            </div>`,
            )
            .join("");
          content.insertAdjacentHTML(
            "beforeend",
            `<a href="/${section}/${toggle.dataset.month}/${toggle.dataset.day}/" class="born-died-view-all">See full page <i class="bi bi-arrow-right ms-1"></i></a>`,
          );
        }
      };
      toggle.addEventListener("click", activateToggle);
      toggle.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activateToggle();
        }
      });
    });
  } catch (error) {
    console.error("Error loading event details:", error);
    modalBodyContent.innerHTML = `
      <div class="alert alert-danger" role="alert">
        <h5><i class="bi bi-exclamation-circle me-1"></i>Loading Error</h5>
        <p class="mb-2">Unable to load events for this day. Please check your internet connection.</p>
        <button class="btn btn-sm btn-outline-danger" id="retryEventsBtn">
          <i class="bi bi-arrow-clockwise me-1"></i>Try again
        </button>
      </div>
    `;
    document.getElementById("retryEventsBtn")?.addEventListener("click", () => {
      showEventDetails(day, month, year, null);
    });
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    if (!calendarGrid) return;
    await Promise.all([
      populateTodayThroughTime(),
      renderCalendar(),
    ]);
  } catch (error) {
    console.error("Error initializing application:", error);
    if (calendarGrid) {
      calendarGrid.innerHTML = `
        <div class="col-12">
          <div class="alert alert-danger">
            <h5>Initialization Error</h5>
            <p>Unable to load the calendar. Please refresh the page and try again.</p>
          </div>
        </div>
      `;
    }
  }
});

const prevMonthBtn = document.getElementById("prevMonthBtn");
const nextMonthBtn = document.getElementById("nextMonthBtn");

if (prevMonthBtn) {
  prevMonthBtn.addEventListener("click", async () => {
    prevMonthBtn.disabled = true;
    try {
      currentDate.setMonth(currentDate.getMonth() - 1);
      await renderCalendar();
    } catch (error) {
      console.error("Error navigating to previous month:", error);
    } finally {
      prevMonthBtn.disabled = false;
    }
  });
}

if (nextMonthBtn) {
  nextMonthBtn.addEventListener("click", async () => {
    nextMonthBtn.disabled = true;
    try {
      currentDate.setMonth(currentDate.getMonth() + 1);
      await renderCalendar();
    } catch (error) {
      console.error("Error navigating to next month:", error);
    } finally {
      nextMonthBtn.disabled = false;
    }
  });
}

const currentYearElement = document.getElementById("currentYear");
if (currentYearElement) {
  currentYearElement.textContent = new Date().getFullYear();
}

function normalizeFooterContent() {
  const footer = document.querySelector("footer.footer");
  if (!footer) return;

  footer
    .querySelectorAll('a[aria-label="Pinterest"], a[href*="pinterest.com"]')
    .forEach((link) => {
      const wrapper = link.closest(".me-2") || link;
      wrapper.remove();
    });

  const footerBottom =
    footer.querySelector(".footer-bottom") ||
    footer.querySelector("p:last-of-type");

  if (!footerBottom) return;

  footerBottom.classList.add("footer-bottom");
  footerBottom.innerHTML =
    '<a href="https://buymeacoffee.com/fugec?new=1" target="_blank">Support This Project</a> | ' +
    '<a href="/blog/">Blog</a> | ' +
    '<a href="/about/">About Us</a> | ' +
    '<a href="/contact/">Contact</a> | ' +
    '<a href="/terms/">Terms and Conditions</a> | ' +
    '<a href="/privacy-policy/">Privacy Policy</a>';
}

normalizeFooterContent();

function cleanupCache() {
  const now = Date.now();
  const keysToDelete = [];
  for (const [key, value] of eventCache.entries()) {
    if (now - value.timestamp > CACHE_EXPIRY_TIME) {
      keysToDelete.push(key);
    }
  }
  if (keysToDelete.length > 0) {
    keysToDelete.forEach((key) => eventCache.delete(key));
    saveCacheToLocalStorage(eventCache);
  }
}

setInterval(cleanupCache, 60 * 60 * 1000);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    cleanupCache();
  }
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection:", event.reason);
  event.preventDefault();
});

if (typeof PerformanceObserver !== "undefined") {
  const observer = new PerformanceObserver((list) => {
    list.getEntries().forEach((entry) => {
      if (entry.entryType === "navigation") return;
      if (/^GTM-|^AW-|googletag|googleads/i.test(entry.name)) return;
      if (entry.duration > 1000) {
        console.warn(
          `Slow operation detected: ${entry.name} took ${entry.duration}ms`,
        );
      }
    });
  });
  try {
    observer.observe({ entryTypes: ["measure", "navigation"] });
  } catch (e) {}
}

document.addEventListener("DOMContentLoaded", () => {
  if (navigator.onLine && location.pathname === "/") {
    const PREFETCH_KEY = "imagePrefetchDone";
    const today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem(PREFETCH_KEY) !== today) {
      fetch("https://thisday.info/api/today-images")
        .then((res) => res.json())
        .then((data) => {
          if (data && data.prefetched) {
            if (data.prefetched.eager) {
              const img = new Image();
              img.src = data.prefetched.eager;
            }
            data.prefetched.lazy.forEach((url) => {
              const img = new Image();
              img.src = url;
            });
          }
          localStorage.setItem(PREFETCH_KEY, today);
        })
        .catch((err) => console.warn("Prefetching error:", err));
    }
  }
});

const eventDetailModalElement = document.getElementById("eventDetailModal");
if (eventDetailModalElement) {
  eventDetailModalElement
    .querySelector(".btn-close")
    .addEventListener("click", (e) => {
      e.currentTarget.blur(); // move focus before Bootstrap sets aria-hidden
      getEventDetailModal()?.hide();
      currentActiveFilter = "all";
    });
  eventDetailModalElement.addEventListener("hidden.bs.modal", function () {
    currentActiveFilter = "all";
    const returnTarget = lastActiveCard;
    returnTarget?.setAttribute("aria-expanded", "false");
    lastActiveCard = null;
    returnTarget?.focus({ preventScroll: true });
  });
}

// Enhanced function to fetch Wikipedia events with better randomization
async function fetchWikipediaEventsForCarousel() {
  try {
    // Try preloaded data from Cloudflare Worker first
    const preloadedScript = document.getElementById("preloaded-today-events");

    if (preloadedScript) {
      try {
        const rawData = JSON.parse(preloadedScript.textContent);

        if (rawData && rawData.events && Array.isArray(rawData.events)) {
          // Filter for events that have images
          const eventsWithImages = rawData.events.filter(
            (e) =>
              e.pages &&
              e.pages[0] &&
              e.pages[0].thumbnail &&
              e.pages[0].thumbnail.source,
          );

          // Randomly select 3 events
          const shuffled = eventsWithImages.sort(() => Math.random() - 0.5);
          const selectedEvents = shuffled.slice(0, 3);

          return selectedEvents.map((event) => {
            const wikiPage = event.pages[0];
            const optimized = getOptimizedImageUrl(
              wikiPage.thumbnail.source,
              1200,
            );
            return {
              day: new Date().getDate(),
              year: event.year,
              title: wikiPage.title || event.text.split(".")[0],
              excerpt: event.text,
              sourceImageUrl: wikiPage.thumbnail.source,
              imageUrl: optimized,
              backgroundUrl: optimized,
              url:
                wikiPage.content_urls?.desktop?.page ||
                window.__todayEventsUrl ||
                "/events/today/",
              isExternal: Boolean(wikiPage.content_urls?.desktop?.page),
            };
          });
        }
      } catch (e) {
        console.error("Error parsing preloaded worker data:", e);
      }
    }

    // Fallback: Fetch from Wikipedia API
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const day = String(today.getDate()).padStart(2, "0");
    const url = `/api/events/${month}/${day}`;

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      console.error("Wikipedia API request failed:", response.status);
      return [];
    }

    const data = await response.json();

    // Filter events with images
    const eventsWithImages = data.events.filter(
      (event) => event.pages?.[0]?.thumbnail?.source,
    );

    // Randomly select 3 events
    const shuffled = eventsWithImages.sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, 3);

    return selected.map((event) => {
      const wikiPage = event.pages[0];
      const optimized = getOptimizedImageUrl(wikiPage.thumbnail.source, 1200);
      return {
        day: today.getDate(),
        year: event.year,
        title: wikiPage.title,
        excerpt: event.text,
        sourceImageUrl: wikiPage.thumbnail.source,
        imageUrl: optimized,
        backgroundUrl: optimized,
        url: wikiPage.content_urls.desktop.page,
        isExternal: true,
      };
    });
  } catch (error) {
    console.error("Error fetching Wikipedia carousel events:", error);
    return [];
  }
}

// Render a carousel item using existing img + carousel-caption CSS
function renderFullWidthCarouselItem(container, event, index) {
  const item = document.createElement("div");
  item.className = `carousel-item${index === 0 ? " active" : ""}`;

  const title = (event.title || "").replace(/_/g, " ");
  const imageUrl =
    event.backgroundUrl ||
    event.imageUrl ||
    `https://placehold.co/1200x350/3b82f6/ffffff?text=${encodeURIComponent(title)}`;
  const fallbackUrl = `https://placehold.co/1200x350/3b82f6/ffffff?text=${encodeURIComponent(title)}`;
  const responsiveSrcset = getResponsiveImageSrcset(
    event.sourceImageUrl || "",
    [640, 960, 1200],
  );
  const excerpt =
    event.excerpt && event.excerpt.length > 160
      ? event.excerpt.substring(0, 160) + "..."
      : event.excerpt || "";

  item.innerHTML = `
    <div class="carousel-image-container">
      <img src="${imageUrl}" class="d-block w-100" alt="${title}"
           ${responsiveSrcset ? `srcset="${responsiveSrcset}" sizes="100vw"` : ""}
           onerror="this.onerror=null;this.src='${fallbackUrl}';"
           ${index === 0 ? 'fetchpriority="high" loading="eager"' : 'fetchpriority="low" loading="lazy"'} decoding="async" width="1200" height="350">
    </div>
    <div class="carousel-caption">
      <small style="opacity:0.75;font-size:0.85em;display:block;margin-bottom:6px;letter-spacing:0.05em;">${event.year}</small>
      <h5 style="font-size:20px;font-weight:700;line-height:1.2;margin-bottom:0.75rem;">${title}</h5>
      <p>${excerpt}</p>
      <div style="display:inline-flex;gap:8px;justify-content:center;flex-direction:row;">
        <a href="${event.url}" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm">Read on Wikipedia</a>
        ${window.__todayEventsUrl || window.__todayGeneratedUrl ? `<a href="${window.__todayEventsUrl || window.__todayGeneratedUrl}" class="btn btn-primary btn-sm">Today's Events</a>` : ""}
      </div>
    </div>
  `;

  container.appendChild(item);
}

// Render carousel indicator
function renderIndicator(container, index) {
  const indicator = document.createElement("button");
  indicator.type = "button";
  indicator.setAttribute("data-bs-target", "#historicalCarousel");
  indicator.setAttribute("data-bs-slide-to", index.toString());
  if (index === 0) {
    indicator.className = "active";
    indicator.setAttribute("aria-current", "true");
  }
  indicator.setAttribute("aria-label", `Slide ${index + 1}`);
  container.appendChild(indicator);
}

// Initialize Bootstrap carousel
function initializeCarousel() {
  const carouselElement = document.getElementById("historicalCarousel");
  if (carouselElement && typeof bootstrap !== "undefined") {
    new bootstrap.Carousel(carouselElement, {
      interval: 5000,
      wrap: true,
      touch: true,
    });
  }
}

function toAbsoluteUrl(url, baseUrl = window.location.origin) {
  if (!url || typeof url !== "string") return null;
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return null;
  }
}

function isBlockedCarouselImage(url) {
  if (!url) return true;
  const normalized = url.trim().toLowerCase();
  return (
    normalized === "https://thisday.info/images/logo.png" ||
    normalized.endsWith("/images/logo.png") ||
    normalized.includes("placehold.co")
  );
}

async function doesImageLoad(url, timeoutMs = 7000) {
  if (!url || isBlockedCarouselImage(url)) return false;

  return new Promise((resolve) => {
    let settled = false;
    const img = new Image();

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);

    img.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };

    img.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    };

    img.src = url;
  });
}

async function findWorkingImage(
  candidates = [],
  fallbackImage = null,
  baseUrl,
) {
  const unique = [];
  const seen = new Set();

  [...candidates, fallbackImage].filter(Boolean).forEach((candidate) => {
    const absolute = toAbsoluteUrl(candidate, baseUrl);
    if (!absolute || seen.has(absolute)) return;
    seen.add(absolute);
    unique.push(absolute);
  });

  for (const candidate of unique) {
    if (await doesImageLoad(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function fetchPostPreviewFromUrl(
  fetchUrl,
  postUrl,
  day,
  monthIndex,
  year,
) {
  try {
    const response = await fetch(fetchUrl, { cache: "no-cache" });
    if (!response.ok) return null;

    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    const ogImage =
      doc.querySelector('meta[property="og:image"]')?.getAttribute("content") ||
      null;
    const twitterImage =
      doc
        .querySelector('meta[name="twitter:image"]')
        ?.getAttribute("content") || null;
    const firstFigureImage =
      doc.querySelector("figure img")?.getAttribute("src") ||
      doc.querySelector("article img")?.getAttribute("src") ||
      null;

    // Build local fallback candidates across all common formats
    const d = day;
    const m = monthIndex + 1;
    const dp = String(d).padStart(2, "0");
    const mp = String(m).padStart(2, "0");
    const localCandidates = [
      `/images/blog/${d}.${m}.jpg`,
      `/images/blog/${d}.${m}.jpeg`,
      `/images/blog/${d}.${m}.png`,
      `/images/blog/${d}.${m}.webp`,
      `/images/blog/${dp}.${mp}.jpg`,
      `/images/blog/${dp}.${mp}.jpeg`,
      `/images/blog/${dp}.${mp}.png`,
      `/images/blog/${dp}.${mp}.webp`,
      `/images/blog/${m}.${d}.jpg`,
      `/images/blog/${mp}.${dp}.jpg`,
    ];

    let workingImage = await findWorkingImage(
      [ogImage, twitterImage, firstFigureImage, ...localCandidates],
      null,
      postUrl,
    );

    // Last resort: Wikipedia thumbnail by post title
    if (!workingImage) {
      const pageTitle =
        doc.querySelector("h1")?.textContent?.trim() ||
        doc
          .querySelector('meta[property="og:title"]')
          ?.getAttribute("content") ||
        null;
      if (pageTitle) {
        try {
          const wikiRes = await fetch(
            `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}`,
            { headers: { Accept: "application/json" } },
          );
          if (wikiRes.ok) {
            const wikiData = await wikiRes.json();
            const wikiImg =
              wikiData.thumbnail?.source ??
              wikiData.originalimage?.source ??
              null;
            if (wikiImg && (await doesImageLoad(wikiImg))) {
              workingImage = wikiImg;
            }
          }
        } catch {
          // ignore — just means no Wikipedia image available
        }
      }
    }

    if (!workingImage) return null;

    const title =
      doc.querySelector("h1")?.textContent?.trim() ||
      doc.querySelector('meta[property="og:title"]')?.getAttribute("content") ||
      doc.querySelector("title")?.textContent?.trim() ||
      `Historical Events - ${day} ${monthNames[monthIndex]} ${year}`;

    const excerpt =
      doc
        .querySelector('meta[property="og:description"]')
        ?.getAttribute("content") ||
      doc.querySelector('meta[name="description"]')?.getAttribute("content") ||
      `Discover what happened on ${day} ${monthNames[monthIndex]} ${year}`;

    return {
      day,
      year,
      monthIndex,
      title: title.trim(),
      excerpt: excerpt.trim(),
      imageUrl: workingImage,
      backgroundUrl: workingImage,
      url: postUrl,
      isExternal: false,
    };
  } catch {
    return null;
  }
}

// Fetch 3 random blog posts from the current month that have working cover images
async function fetchBlogPostsForCarousel(monthName, monthIndex) {
  const MAX_CAROUSEL_POSTS = 3;
  const today = new Date();

  // Priority 1: latest AI index posts (across months), but only with working images.
  try {
    const indexResponse = await fetch(homepageBlogIndexUrl(), {
      cache: "no-cache",
      headers: { Accept: "application/json" },
    });

    if (indexResponse.ok) {
      const index = await indexResponse.json();
      if (Array.isArray(index) && index.length > 0) {
        const latest = sortBlogPostsNewestFirst(index).slice(0, 20);
        const fromIndex = [];

        for (const entry of latest) {
          if (!entry?.slug || !entry?.imageUrl) continue;
          if (isBlockedCarouselImage(entry.imageUrl)) continue;
          // Skip entries whose image doesn't actually load — prevents blank slides
          if (!(await doesImageLoad(entry.imageUrl))) continue;

          const slugParts = String(entry.slug).split("-");
          const day = Number.parseInt(slugParts[0], 10);
          const parsedDay = Number.isFinite(day) ? day : today.getDate();
          const parsedYear =
            Number.parseInt(String(entry.publishedAt || "").slice(0, 4), 10) ||
            today.getFullYear();
          const slugMonthName = slugParts[1]?.toLowerCase() || "";
          const slugMonthIndex = monthNames.findIndex(
            (m) => m.toLowerCase() === slugMonthName,
          );
          const postMonthIndex =
            slugMonthIndex >= 0 ? slugMonthIndex : monthIndex;

          fromIndex.push({
            day: parsedDay,
            year: parsedYear,
            monthIndex: postMonthIndex,
            title: entry.title || `Historical Events - ${parsedDay}`,
            excerpt: entry.description || "",
            imageUrl: entry.imageUrl,
            backgroundUrl: entry.imageUrl,
            url: `/blog/${entry.slug}/`,
            isExternal: false,
          });

          if (fromIndex.length >= MAX_CAROUSEL_POSTS) {
            return fromIndex;
          }
        }
      }
    }
  } catch (e) {
    console.warn("Blog index fetch failed for carousel:", e);
  }

  // Priority 2: current month static/AI URL patterns.
  const year = Math.max(2025, today.getFullYear());
  const currentMonth = today.getMonth();
  const currentDay = today.getDate();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

  const posts = [];
  const startDay =
    monthIndex === currentMonth
      ? Math.min(currentDay, daysInMonth)
      : daysInMonth;

  for (let day = startDay; day >= 1; day--) {
    if (monthIndex > currentMonth) continue;

    const urlCandidates =
      year >= 2026
        ? [
            {
              fetchUrl: `/blog/${day}-${monthName}-${year}/`,
              postUrl: `/blog/${day}-${monthName}-${year}/`,
            },
            {
              fetchUrl: `/blog/${monthName}/${day}-${year}/index.html`,
              postUrl: `/blog/${monthName}/${day}-${year}/`,
            },
          ]
        : [
            {
              fetchUrl: `/blog/${monthName}/${day}-${year}/index.html`,
              postUrl: `/blog/${monthName}/${day}-${year}/`,
            },
            {
              fetchUrl: `/blog/${day}-${monthName}-${year}/`,
              postUrl: `/blog/${day}-${monthName}-${year}/`,
            },
          ];

    for (const { fetchUrl, postUrl } of urlCandidates) {
      const preview = await fetchPostPreviewFromUrl(
        fetchUrl,
        postUrl,
        day,
        monthIndex,
        year,
      );
      if (preview) {
        posts.push(preview);
        break;
      }
    }

    if (posts.length >= MAX_CAROUSEL_POSTS) {
      return posts;
    }
  }

  return posts;
}

// Main function to populate carousel
async function populateCarousel(month, _year) {
  const carouselInner = document.getElementById("carouselInner");
  const carouselIndicators = document.getElementById("carouselIndicators");

  if (!carouselInner || !carouselIndicators) {
    return;
  }

  // Clear existing content
  carouselInner.innerHTML = "";
  carouselIndicators.innerHTML = "";

  try {
    // Fetch 3 daily blog posts from this month with working cover images
    const currentMonthName = monthNames[month].toLowerCase();
    const blogPosts = await fetchBlogPostsForCarousel(currentMonthName, month);

    if (blogPosts && blogPosts.length > 0) {
      blogPosts.forEach((post, index) => {
        renderCarouselItem(carouselInner, post, index);
        renderIndicator(carouselIndicators, index);
      });

      document.getElementById("historicalCarousel").style.display = "block";
      initializeCarousel();
    } else {
      // Show placeholder if no events found
      carouselInner.innerHTML = `
        <div class="carousel-item active">
          <div class="carousel-slide" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
            <div class="carousel-overlay"></div>
            <div class="carousel-content">
              <h3 class="carousel-title">No Events Available</h3>
              <p class="carousel-excerpt">Unable to load historical events for today.</p>
            </div>
          </div>
        </div>
      `;
    }
  } catch (error) {
    console.error("Error populating carousel:", error);
    carouselInner.innerHTML = `
      <div class="carousel-item active">
        <div class="carousel-slide" style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);">
          <div class="carousel-overlay"></div>
          <div class="carousel-content">
            <h3 class="carousel-title">Error Loading Events</h3>
            <p class="carousel-excerpt">Something went wrong. Please try again later.</p>
          </div>
        </div>
      </div>
    `;
  }
}
