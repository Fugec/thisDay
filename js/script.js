const calendarGrid = document.getElementById("calendarGrid");
const currentMonthYearDisplay = document.getElementById("currentMonthYear");
const modalDate = document.getElementById("modalDate");
const modalBodyContent = document.getElementById("modalBodyContent");
const eventDetailModal = new bootstrap.Modal(
  document.getElementById("eventDetailModal"),
);
const loadingIndicator = document.getElementById("loadingIndicator");

// Elements for carousel
const carouselInner = document.getElementById("carouselInner");
const carouselIndicators = document.getElementById("carouselIndicators");

// Theme toggle elements (checkboxes)
const themeSwitchMobile = document.getElementById("themeSwitchMobile");
const themeSwitchDesktop = document.getElementById("themeSwitchDesktop");
const body = document.body;

let currentDate = new Date();

const CACHE_EXPIRY_TIME = 24 * 60 * 60 * 1000;
const LOCAL_STORAGE_CACHE_KEY = "wikipediaEventCache";

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
        if (item.pages && Array.isArray(item.pages) && item.pages.length > 0) {
          const page = item.pages[0];
          if (page.content_urls && page.content_urls.desktop) {
            wikipediaLink = page.content_urls.desktop.page;
          }
          if (page.thumbnail && page.thumbnail.source) {
            thumbnailUrl = page.thumbnail.source;
          }
        }
        targetArray.push({
          title: item.text.split(".")[0] + ".",
          description: item.text,
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

  return { events: processedEvents, births: processedBirths, deaths: processedDeaths };
}

async function fetchWikipediaEvents(month, day) {
  const cacheKey = `${month}-${day}-en`;
  if (eventCache.has(cacheKey)) {
    const cached = eventCache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_EXPIRY_TIME) {
      return cached.data;
    } else {
      eventCache.delete(cacheKey);
      saveCacheToLocalStorage(eventCache);
    }
  }

  // For today's date, use data the Cloudflare Worker already injected — no API call needed
  const now = new Date();
  if (month === now.getMonth() + 1 && day === now.getDate()) {
    const preloadedScript = document.getElementById("preloaded-today-events");
    if (preloadedScript) {
      try {
        const raw = JSON.parse(preloadedScript.textContent);
        if (raw && raw.events && raw.events.length > 0) {
          const resultData = processRawWikipediaData(raw);
          eventCache.set(cacheKey, { data: resultData, timestamp: Date.now() });
          saveCacheToLocalStorage(eventCache);
          return resultData;
        }
      } catch (e) {
        console.warn("Failed to parse preloaded events, falling back to API.", e);
      }
    }
  }

  const monthPadded = String(month).padStart(2, "0");
  const dayPadded = String(day).padStart(2, "0");
  const url = `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events/${monthPadded}/${dayPadded}?origin=*`;

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
      eventCache.set(cacheKey, { data: emptyData, timestamp: Date.now() });
      saveCacheToLocalStorage(eventCache);
      return emptyData;
    }

    const data = await response.json();
    const resultData = processRawWikipediaData(data);
    eventCache.set(cacheKey, { data: resultData, timestamp: Date.now() });
    saveCacheToLocalStorage(eventCache);
    return resultData;
  } catch (error) {
    console.error(`Error fetching events for ${month}/${day}:`, error);
    return { events: [], births: [], deaths: [] };
  }
}

// --- NEW/MODIFIED CAROUSEL AND BLOG POST LOGIC ---

// Helper function to render a single carousel item
function renderCarouselItem(container, post, index) {
  const carouselItem = document.createElement("div");
  carouselItem.className = `carousel-item${index === 0 ? " active" : ""}`;
  const imageUrl =
    post.imageUrl ||
    `https://placehold.co/1200x350/6c757d/ffffff?text=Blog+Post+${post.day}`;
  const fallbackImageUrl = `https://placehold.co/1200x350/6c757d/ffffff?text=Blog+Post+${post.day}`;
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

  carouselItem.innerHTML = `
    <div style="position:relative;">
      ${dateLabel}
      <div class="carousel-image-container">
        <img src="${imageUrl}" class="d-block w-100" alt="${truncatedTitle}"
             onerror="this.onerror=null;this.src='${fallbackImageUrl}';"
             ${
               index === 0 ? 'fetchpriority="high"' : 'loading="lazy"'
             } decoding="async" width="1200" height="350">
      </div>
    </div>
    <div class="carousel-caption">
      <h5>${truncatedTitle}</h5>
      <p>${post.excerpt || "Read this blog post about historical events."}</p>
      <a href="${post.url}" class="btn btn-primary btn-sm"
         ${post.isExternal ? 'target="_blank" rel="noopener noreferrer"' : ""}>
         Read Full Post
      </a>
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
    const eventsData = await fetchWikipediaEvents(month + 1, day);
    dayCard.eventsData = eventsData;
    const totalEvents =
      (eventsData.events?.length || 0) +
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
  document.title = `What Happened on This Day | ${monthNames[month]} Historical Events`;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const dayCards = [];
  for (let i = 1; i <= daysInMonth; i++) {
    const dayCard = createDayCard(i, month);
    dayCard.setAttribute("role", "button");
    dayCard.setAttribute("tabindex", "0");
    dayCard.setAttribute("aria-label", `Events for ${i} ${monthNames[month]}`);
    dayCard.setAttribute("aria-pressed", "false");
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
  // Observe all day cards so events load automatically as they scroll into view
  initDayCardObserver(dayCards, month);

  try {
    const carouselPromise = populateCarousel(month, year);
    if (isCurrentMonth) {
      const todayCard = dayCards.find(
        (card) => parseInt(card.getAttribute("data-day"), 10) === todayDate,
      );
      if (todayCard) {
        await loadDayEvents(todayCard, month, true);
        setTimeout(() => {
          todayCard.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        }, 300);
      }
    }
    await carouselPromise;
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

// IntersectionObserver: auto-load events when day cards scroll into the viewport
let dayCardObserver = null;

function initDayCardObserver(dayCards, month) {
  if (dayCardObserver) {
    dayCardObserver.disconnect();
  }
  if (!("IntersectionObserver" in window)) return;

  dayCardObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (
          entry.isIntersecting &&
          entry.target.classList.contains("needs-load") &&
          !entry.target.classList.contains("loading")
        ) {
          loadDayEvents(entry.target, month);
          dayCardObserver.unobserve(entry.target);
        }
      });
    },
    { rootMargin: "100px", threshold: 0.1 },
  );

  dayCards.forEach((card) => {
    if (card.classList.contains("needs-load")) {
      dayCardObserver.observe(card);
    }
  });
}

let currentDayAllItems = [];
let currentActiveFilter = "all";

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
      "icon",
      "legend",
      "laureate",
      "recipient",
      "winner",
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
    if (year < 500) return "A figure from the ancient world whose ideas still echo today.";
    if (year < 1400) return "Born in an era before mass literacy, yet their legacy endured for centuries.";
    if (year < 1700) return "Their birth came at a time when the modern world was just taking shape.";
    if (year < 1900) return "A product of the industrial age, shaped by revolution and rapid change.";
    return "A life lived in the modern era — closer to us than it might feel.";
  }
  if (event.type === "death") {
    if (year < 500) return "Their passing marked the end of a chapter in the ancient world.";
    if (year < 1400) return "With their death, an era drew to a close — but their influence lingered.";
    if (year < 1700) return "The world they left behind would soon look very different from the one they knew.";
    return "History often turns on the loss of a single person. This was one of those moments.";
  }

  // Category-based commentary for events
  const isWar = cats.some(c => /war|conflict|battle|military/i.test(c)) ||
    /war|battle|siege|troops|army|invasion|conflict|defeat|victory/i.test(text);
  const isScience = cats.some(c => /science|technology|discovery/i.test(c)) ||
    /discover|invent|patent|experiment|launch|orbit|atom|gene|vaccine|telescope|microscope/i.test(text);
  const isPolitics = cats.some(c => /politic|government|law/i.test(c)) ||
    /treaty|signed|declared|constitution|parliament|election|president|king|queen|emperor|independence/i.test(text);
  const isExploration = /explorer|voyage|expedition|columbus|magellan|circumnavigat|territory|discovered/i.test(text);
  const isReligion = /pope|church|cathedral|crusade|reformation|religion|faith|missionary/i.test(text);
  const isArts = cats.some(c => /art|culture|literature/i.test(c)) ||
    /publish|painting|novel|symphony|poem|theatre|opera|film|broadcast/i.test(text);

  const era = year < 500 ? "ancient" : year < 1400 ? "medieval" : year < 1700 ? "early modern" : year < 1900 ? "modern" : "contemporary";

  if (isWar) {
    const warComments = {
      ancient: "Conflict in the ancient world was total — no distinction between soldier and civilian, victor and conquered.",
      medieval: "Medieval warfare was as much about starvation and disease as it was about the battlefield.",
      "early modern": "Gunpowder changed the nature of war forever — this event reflects that transformation.",
      modern: "By this point, warfare had become industrialized, turning individual soldiers into statistics.",
      contemporary: "Modern conflicts are fought as much in the media as on the ground — context matters enormously.",
    };
    return warComments[era] || "War has always reshaped the boundaries of the possible.";
  }
  if (isScience) {
    const sciComments = {
      ancient: "In the ancient world, science and philosophy were inseparable — observation met mythology.",
      medieval: "Medieval scholars preserved and debated classical knowledge, laying groundwork they'd never see built.",
      "early modern": "The Scientific Revolution was underway — each discovery chipped away at centuries of assumption.",
      modern: "The 19th century turned science into an industry, accelerating change at an unprecedented rate.",
      contemporary: "Modern science moves so fast that today's breakthrough can become tomorrow's footnote.",
    };
    return sciComments[era] || "Every scientific breakthrough begins with someone daring to ask a different question.";
  }
  if (isExploration) {
    return year < 1600
      ? "The Age of Exploration reshaped the world — and not always for the better for those already living in it."
      : "Exploration is humanity's oldest instinct; the destinations just keep changing.";
  }
  if (isPolitics) {
    const polComments = {
      ancient: "Political power in the ancient world was deeply personal — empires rose and fell with individual rulers.",
      medieval: "Feudal politics were a constant negotiation between loyalty, land, and survival.",
      "early modern": "Nation-states were being invented in real time — the rules of governance were far from settled.",
      modern: "The 19th century saw democracy and nationalism collide with old imperial order.",
      contemporary: "Political events rarely happen in isolation — every decision carries the weight of what came before.",
    };
    return polComments[era] || "Political moments that seem small at the time often define generations.";
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
    ancient: "Events from this era survive through fragments — every detail we have was preserved against the odds.",
    medieval: "The medieval world was far more connected and complex than popular imagination suggests.",
    "early modern": "This was an age of transition — old certainties crumbling, new ones not yet formed.",
    modern: "The 19th century compressed centuries of change into decades.",
    contemporary: "History is still being written about this period. Perspective takes time.",
  };
  return generic[era] || "Every date in history is someone's entire world.";
}

function renderFilteredItems(itemsToRender) {
  const eventsListDiv = document.getElementById("modal-events-list");
  if (!eventsListDiv) return;
  if (itemsToRender.length === 0) {
    eventsListDiv.innerHTML =
      "<p class='text-muted text-center'>No items found for this category.</p>";
    return;
  }
  let htmlContent = `<ul class="list-unstyled">`;
  itemsToRender.forEach((event) => {
    let specialEmphasis = "";
    if (event.type === "birth") {
      specialEmphasis = "<strong>Birth:</strong> ";
    } else if (event.type === "death") {
      specialEmphasis = "<strong>Death:</strong> ";
    }
    const commentary = getEventCommentary(event);
    htmlContent += `
            <li class="mb-3 p-3 border rounded">
                <div class="d-flex justify-content-between align-items-start">
                    <div class="flex-grow-1">
                        <strong class="text-primary">${event.year}</strong>
                        <p class="mb-1">${specialEmphasis}${
                          event.description
                        }</p>
                        <p class="mb-2 fst-italic text-muted" style="font-size:0.82rem; border-left: 3px solid #3b82f6; padding-left: 8px;">
                          <i class="bi bi-chat-quote me-1" style="color:#3b82f6;"></i>${commentary}
                        </p>
                        ${
                          event.sourceUrl
                            ? `
                            <a href="${
                              event.sourceUrl
                            }" class="btn btn-sm btn-outline-primary"
                               target="_blank" rel="noopener noreferrer">
                                Read More About ${
                                  event.title.length > 50
                                    ? `${event.title.substring(0, 12)}...`
                                    : event.title
                                }
                            </a>
                            `
                            : ""
                        }
                    </div>
                    ${
                      event.thumbnailUrl
                        ? `
                        <div class="modal-thumbnail-container ms-3">
                            <img src="${event.thumbnailUrl}" class="rounded"
                                style="width: 40px; height: 40px; object-fit: cover;"
                                alt="Event thumbnail" onerror="this.style.display='none'">
                        </div>
                        `
                        : ""
                    }
                </div>
            </li>`;
  });
  htmlContent += `</ul>`;
  eventsListDiv.innerHTML = htmlContent;
}

function applyFilter() {
  const filteredItems = currentDayAllItems.filter((item) => {
    if (currentActiveFilter === "all") {
      return true;
    }
    return item.categories
      .map((cat) => cat.toLowerCase())
      .includes(currentActiveFilter);
  });
  renderFilteredItems(filteredItems);
}

async function showEventDetails(
  day,
  month,
  year,
  preFetchedStructuredEvents = null,
) {
  modalDate.textContent = `${day}. ${monthNames[month - 1]}`;
  modalBodyContent.innerHTML =
    "<div class='text-center'><div class='spinner-border' role='status'></div><p>Loading events...</p></div>";
  let structuredEvents = preFetchedStructuredEvents;
  try {
    if (
      !structuredEvents ||
      (structuredEvents.events?.length === 0 &&
        structuredEvents.births?.length === 0 &&
        structuredEvents.deaths?.length === 0)
    ) {
      structuredEvents = await fetchWikipediaEvents(month, day);
    }
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
    let filterButtonsHtml = `<div id="eventFilterContainer" class="d-flex flex-wrap gap-2 mb-3">`;
    sortedCategories.forEach((category) => {
      const isActive =
        category.toLowerCase() === currentActiveFilter ? "active" : "";
      filterButtonsHtml += `<button class="btn btn-sm btn-outline-primary filter-btn ${isActive}" data-category="${category.toLowerCase()}">${category}</button>`;
    });
    filterButtonsHtml += `</div>`;
    modalBodyContent.innerHTML = `
    <div class="modal-header-content">
        ${filterButtonsHtml}
    </div>
    <div id="modal-events-list">
        </div>
`;
    modalBodyContent.querySelectorAll(".filter-btn").forEach((button) => {
      button.addEventListener("click", (event) => {
        const clickedCategory = event.target.dataset.category;
        if (clickedCategory === currentActiveFilter) {
          currentActiveFilter = "all";
          event.target.classList.remove("active");
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
            .forEach((btn) => btn.classList.remove("active"));
          event.target.classList.add("active");
        }
        applyFilter();
      });
    });
    applyFilter();
  } catch (error) {
    console.error("Error loading event details:", error);
    modalBodyContent.innerHTML = `
      <div class="alert alert-danger" role="alert">
        <h5><i class="bi bi-exclamation-circle"></i> Loading Error</h5>
        <p>Unable to load events for this day. Please check your internet connection and try again.</p>
      </div>
    `;
  }
  eventDetailModal.show();
}

function setTheme(theme) {
  if (theme === "dark") {
    body.classList.add("dark-theme");
    if (themeSwitchMobile) themeSwitchMobile.checked = true;
    if (themeSwitchDesktop) themeSwitchDesktop.checked = true;
    if (themeSwitchMobile && themeSwitchMobile.nextElementSibling) {
      const icon = themeSwitchMobile.nextElementSibling.querySelector("i");
      if (icon) {
        icon.classList.remove("bi-moon-fill");
        icon.classList.add("bi-brightness-high-fill");
      }
    }
    if (themeSwitchDesktop && themeSwitchDesktop.nextElementSibling) {
      themeSwitchDesktop.nextElementSibling.textContent = "Light Mode";
    }
    localStorage.setItem("theme", "dark");
  } else {
    body.classList.remove("dark-theme");
    if (themeSwitchMobile) themeSwitchMobile.checked = false;
    if (themeSwitchDesktop) themeSwitchDesktop.checked = false;
    if (themeSwitchMobile && themeSwitchMobile.nextElementSibling) {
      const icon = themeSwitchMobile.nextElementSibling.querySelector("i");
      if (icon) {
        icon.classList.remove("bi-brightness-high-fill");
        icon.classList.add("bi-moon-fill");
      }
    }
    if (themeSwitchDesktop && themeSwitchDesktop.nextElementSibling) {
      themeSwitchDesktop.nextElementSibling.textContent = "Dark Mode";
    }
    localStorage.setItem("theme", "light");
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const savedTheme = localStorage.getItem("theme") || "dark";
    setTheme(savedTheme);
    await renderCalendar();
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

if (themeSwitchMobile) {
  themeSwitchMobile.addEventListener("change", () => {
    setTheme(themeSwitchMobile.checked ? "dark" : "light");
  });
}

if (themeSwitchDesktop) {
  themeSwitchDesktop.addEventListener("change", () => {
    setTheme(themeSwitchDesktop.checked ? "dark" : "light");
  });
}

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
              const link = document.createElement("link");
              link.rel = "preload";
              link.as = "image";
              link.href = data.prefetched.eager;
              document.head.appendChild(link);
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
    .addEventListener("click", () => {
      eventDetailModal.hide();
      currentActiveFilter = "all";
    });
  eventDetailModalElement.addEventListener("hidden.bs.modal", function () {
    currentActiveFilter = "all";
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
            const optimized = getOptimizedImageUrl(wikiPage.thumbnail.source, 1200);
            return {
              day: new Date().getDate(),
              year: event.year,
              title: wikiPage.title || event.text.split(".")[0],
              excerpt: event.text,
              imageUrl: optimized,
              backgroundUrl: optimized,
              url: wikiPage.content_urls.desktop.page,
              isExternal: true,
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
    const url = `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events/${month}/${day}`;

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
  const excerpt =
    event.excerpt && event.excerpt.length > 160
      ? event.excerpt.substring(0, 160) + "..."
      : event.excerpt || "";

  item.innerHTML = `
    <div class="carousel-image-container">
      <img src="${imageUrl}" class="d-block w-100" alt="${title}"
           onerror="this.onerror=null;this.src='${fallbackUrl}';"
           ${index === 0 ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" width="1200" height="350">
    </div>
    <div class="carousel-caption">
      <small style="opacity:0.75;font-size:0.85em;display:block;margin-bottom:6px;letter-spacing:0.05em;">${event.year}</small>
      <h5 style="font-size:20px;font-weight:700;line-height:1.2;margin-bottom:0.75rem;">${title}</h5>
      <p>${excerpt}</p>
      <a href="${window.__todayGeneratedUrl || event.url}"
         ${!window.__todayGeneratedUrl ? 'target="_blank" rel="noopener noreferrer"' : ''}
         class="btn btn-primary btn-sm">
        ${window.__todayGeneratedUrl ? 'Read Full Story' : 'Read on Wikipedia'}
      </a>
      ${window.__todayGeneratedUrl
        ? `<a href="${event.url}" target="_blank" rel="noopener noreferrer"
             class="btn btn-outline-light btn-sm ms-2" style="font-size:.75rem">Wikipedia ↗</a>`
        : ''}
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

// Main function to populate carousel
async function populateCarousel(month, year) {
  const carouselInner = document.getElementById("carouselInner");
  const carouselIndicators = document.getElementById("carouselIndicators");

  if (!carouselInner || !carouselIndicators) {
    console.error("Carousel elements not found!");
    return;
  }

  // Clear existing content
  carouselInner.innerHTML = "";
  carouselIndicators.innerHTML = "";

  try {
    // Fetch 2 random Wikipedia events
    const wikipediaEvents = await fetchWikipediaEventsForCarousel();

    if (wikipediaEvents && wikipediaEvents.length > 0) {
      wikipediaEvents.forEach((event, index) => {
        renderFullWidthCarouselItem(carouselInner, event, index);
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
