const calendarGrid = document.getElementById("calendarGrid");
const currentMonthYearDisplay = document.getElementById("currentMonthYear");
const modalDate = document.getElementById("modalDate");
const modalBodyContent = document.getElementById("modalBodyContent");
const eventDetailModal = new bootstrap.Modal(
  document.getElementById("eventDetailModal")
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
          `Rate limited. Waiting ${waitTime}ms before retry ${attempt + 1}`
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        continue;
      } else if (response.status >= 500) {
        const waitTime = Math.pow(2, attempt) * 500;
        console.warn(
          `Server error ${response.status}. Retrying in ${waitTime}ms`
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
        `No data for English Wikipedia for ${month}/${day} (Status: ${response.status})`
      );
      const emptyData = { events: [], births: [], deaths: [] };
      eventCache.set(cacheKey, { data: emptyData, timestamp: Date.now() });
      saveCacheToLocalStorage(eventCache);
      return emptyData;
    }

    const data = await response.json();
    const processedEvents = [];
    const processedBirths = [];
    const processedDeaths = [];

    const processItems = (items, targetArray, type) => {
      if (items && Array.isArray(items)) {
        items.forEach((item) => {
          if (!item || !item.text) return;
          let wikipediaLink = "";
          let thumbnailUrl = "";
          if (
            item.pages &&
            Array.isArray(item.pages) &&
            item.pages.length > 0
          ) {
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

    const resultData = {
      events: processedEvents,
      births: processedBirths,
      deaths: processedDeaths,
    };
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

// Helper function to render a single carousel indicator
function renderIndicator(container, index) {
  const indicator = document.createElement("button");
  indicator.setAttribute("type", "button");
  indicator.setAttribute("data-bs-target", "#historicalCarousel");
  indicator.setAttribute("data-bs-slide-to", index);
  indicator.setAttribute("aria-label", `Slide ${index + 1}`);
  if (index === 0) {
    indicator.className = "active";
    indicator.setAttribute("aria-current", "true");
  }
  container.appendChild(indicator);
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

// Helper function to initialize the Bootstrap Carousel
function initializeCarousel() {
  const carouselElement = document.getElementById("historicalCarousel");
  const bsCarousel = bootstrap.Carousel.getInstance(carouselElement);
  if (bsCarousel) {
    bsCarousel.to(0);
    bsCarousel.cycle();
  } else {
    new bootstrap.Carousel(carouselElement, {
      interval: 3000,
      ride: "carousel",
    });
  }
}

// Optimized function to fetch and return only the latest post
async function fetchLatestBlogPost(monthName, monthIndex) {
  const today = new Date();
  const currentDay = today.getDate();
  const currentYear = today.getFullYear();

  // Start from the current day and go backward to find the latest available post
  for (let day = currentDay; day >= 1; day--) {
    const folderName = `${day}-${currentYear}`;
    try {
      const response = await fetch(`/blog/${monthName}/${folderName}/`, {
        method: "HEAD",
        cache: "no-cache",
      });
      if (response.ok) {
        console.log(`Found latest blog post: ${folderName}`);
        const post = await fetchBlogPostData(
          monthName,
          folderName,
          day,
          currentYear,
          monthIndex
        );
        return post;
      }
    } catch (error) {
      // Ignore errors for non-existent posts
    }
  }

  // Fallback: If no post found for the current month, try to generate the latest available
  console.log(
    `No post found for ${monthName}, attempting to generate the latest available post.`
  );
  const generatedPosts = await generateMonthBlogPosts(monthName, monthIndex);
  return generatedPosts.length > 0 ? generatedPosts[0] : null;
}

// Enhanced carousel population to load latest post instantly, and rest later
async function populateCarousel(month, year) {
  const carouselInner = document.getElementById("carouselInner");
  const carouselIndicators = document.getElementById("carouselIndicators");

  carouselInner.innerHTML = "";
  carouselIndicators.innerHTML = "";

  try {
    const monthName = monthNames[month].toLowerCase();

    // Phase 1: INSTANTLY load and display the latest post for quick render
    const latestPost = await fetchLatestBlogPost(monthName, month);

    if (!latestPost) {
      renderPlaceholder(carouselInner, month);
      return;
    }

    // Render the latest post and its indicator
    renderCarouselItem(carouselInner, latestPost, 0);
    renderIndicator(carouselIndicators, 0);
    initializeCarousel();

    // Phase 2: Asynchronously load/generate the rest of the posts in the background
    console.log("Loading remaining posts in the background...");
    const allPosts = await fetchBlogPosts(monthName, month);

    const latestPostIndex = allPosts.findIndex(
      (p) => p.day === latestPost.day && p.year === latestPost.year
    );
    const remainingPosts = allPosts.filter(
      (_, index) => index !== latestPostIndex
    );

    remainingPosts.forEach((post, index) => {
      const newIndex = index + 1;
      renderCarouselItem(carouselInner, post, newIndex);
      renderIndicator(carouselIndicators, newIndex);
    });
  } catch (error) {
    console.error("Error populating carousel:", error);
    renderErrorState(carouselInner);
  }
}

// fetch all blog posts from the /blog/ folder structure
async function fetchBlogPosts(monthName, monthIndex) {
  const BLOG_CACHE_KEY = `blogPosts_${monthName}`;
  const cachedPosts = getCachedBlogPosts(BLOG_CACHE_KEY);
  if (cachedPosts) {
    console.log("Using cached blog posts");
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

    console.log(`No blog posts found for ${monthName}`);
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
          monthIndex
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
      error
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
      (m) => m.toLowerCase() === monthName.toLowerCase()
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

async function debugBlogPosts() {
  const today = new Date();
  const monthName = monthNames[today.getMonth()].toLowerCase();

  console.log("=== Blog Post Debug ===");
  console.log(`Month: ${monthName}`);
  console.log(`Looking for ALL posts in /blog/${monthName}/`);
  console.log(`Starting from year: ${Math.min(2025, today.getFullYear())}`);
  console.log(`Using image format: /images/blog/[day].[month].jpg`);

  console.log("Testing manifest...");
  const manifestPosts = await fetchBlogPostsFromManifest(monthName);
  console.log("Manifest posts:", manifestPosts);

  console.log("Testing folder scanning...");
  const folderPosts = await fetchAllBlogPostsFromFolder(
    monthName,
    today.getMonth()
  );
  console.log("Folder posts:", folderPosts);

  console.log("Testing month generation...");
  const generatedPosts = await generateMonthBlogPosts(
    monthName,
    today.getMonth()
  );
  console.log("Generated posts:", generatedPosts);

  console.log("Testing specific posts...");
  const testDays = [1, 15, 18, 25, 31];
  for (const day of testDays) {
    const testPost = await fetchBlogPostData(
      monthName,
      `${day}-${Math.max(2025, today.getFullYear())}`,
      day,
      Math.max(2025, today.getFullYear()),
      today.getMonth()
    );
    console.log(`Test post ${day}:`, testPost);
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
  const day = parseInt(dayCard.getAttribute("data-day"));
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
          dayCard.eventsData
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
          parseInt(dayCard.getAttribute("data-day")),
          month + 1,
          currentDate.getFullYear(),
          dayCard.eventsData
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
  try {
    const carouselPromise = populateCarousel(month, year);
    if (isCurrentMonth) {
      const todayCard = dayCards.find(
        (card) => parseInt(card.getAttribute("data-day")) === todayDate
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
      "This error could be due to network issues, API rate limits, or unexpected data format. Please check your internet connection, ensure the API is accessible, and verify the data structure."
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
    (cat) => cat !== "Births" && cat !== "Deaths"
  );
  if (nonTypeBased.length === 0 && !categoriesFound.has("Famous Persons")) {
    categoriesFound.add("Miscellaneous");
  }
  return Array.from(categoriesFound);
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
    htmlContent += `
            <li class="mb-3 p-3 border rounded">
                <div class="d-flex justify-content-between align-items-start">
                    <div class="flex-grow-1">
                        <strong class="text-primary">${event.year}</strong>
                        <p class="mb-1">${specialEmphasis}${
      event.description
    }</p>
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
  preFetchedStructuredEvents = null
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
      const yearA = parseInt(a.year) || 0;
      const yearB = parseInt(b.year) || 0;
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
            '.filter-btn[data-category="all"]'
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
          `Slow operation detected: ${entry.name} took ${entry.duration}ms`
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

// ============================================================================
// ADD THIS TO YOUR script.js - COMPLETE WORKING SOLUTION
// This will work both locally AND on live
// ============================================================================

// Add this function RIGHT AFTER your fetchWikipediaEvents function (around line 140)
async function fetchWikipediaEventsForCarousel() {
  try {
    console.log("Fetching Wikipedia events for carousel...");

    // First, check if Worker preloaded the data
    const preloadedScript = document.getElementById(
      "preloaded-carousel-events"
    );
    if (preloadedScript) {
      const wikipediaEvents = JSON.parse(preloadedScript.textContent);
      console.log(
        "Using preloaded Wikipedia events from Worker:",
        wikipediaEvents.length
      );
      return wikipediaEvents.map((event) => ({
        day: new Date().getDate(),
        year: event.year,
        title: `${event.year}: ${event.title}`,
        excerpt: event.description,
        imageUrl: event.imageUrl,
        url: event.url,
        isExternal: true,
      }));
    }

    // If not preloaded (local development), fetch directly
    console.log("No preloaded data, fetching from Wikipedia API...");
    const today = new Date();
    const month = today.getMonth() + 1;
    const day = today.getDate();

    const monthPadded = String(month).padStart(2, "0");
    const dayPadded = String(day).padStart(2, "0");
    const url = `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events/${monthPadded}/${dayPadded}`;

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      console.warn("Failed to fetch Wikipedia events for carousel");
      return [];
    }

    const data = await response.json();
    console.log("Wikipedia API response:", data);

    // Filter events with images
    const eventsWithImages = data.events.filter(
      (event) => event.pages?.[0]?.thumbnail?.source
    );

    console.log(`Found ${eventsWithImages.length} events with images`);

    // Take 3 random events
    const shuffled = [...eventsWithImages].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, 3);

    const carouselEvents = selected.map((event) => {
      const wikiTitle =
        event.pages?.[0]?.title || event.text.split(" ").slice(0, 5).join(" ");
      const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(
        wikiTitle.replace(/ /g, "_")
      )}`;
      const imageUrl = event.pages[0].thumbnail.source;
      const eventText =
        event.text.length > 150
          ? event.text.substring(0, 150) + "..."
          : event.text;

      return {
        day: day,
        year: event.year,
        title: `${event.year}: ${
          wikiTitle.length > 60 ? wikiTitle.substring(0, 60) + "..." : wikiTitle
        }`,
        excerpt: eventText,
        imageUrl: imageUrl,
        url: wikiUrl,
        isExternal: true,
      };
    });

    console.log("Prepared carousel events:", carouselEvents);
    return carouselEvents;
  } catch (error) {
    console.error("Error fetching Wikipedia carousel events:", error);
    return [];
  }
}

// REPLACE your existing populateCarousel function with this (around line 272):
async function populateCarousel(month, year) {
  console.log("populateCarousel called for month:", monthNames[month]);

  const carouselInner = document.getElementById("carouselInner");
  const carouselIndicators = document.getElementById("carouselIndicators");

  if (!carouselInner || !carouselIndicators) {
    console.error("Carousel elements not found!");
    console.log("carouselInner:", carouselInner);
    console.log("carouselIndicators:", carouselIndicators);
    return;
  }

  carouselInner.innerHTML = "";
  carouselIndicators.innerHTML = "";

  try {
    const monthName = monthNames[month].toLowerCase();

    // Phase 1: Load Wikipedia events FIRST
    console.log("Phase 1: Loading Wikipedia events...");
    const wikipediaEvents = await fetchWikipediaEventsForCarousel();

    if (wikipediaEvents && wikipediaEvents.length > 0) {
      console.log(
        `Got ${wikipediaEvents.length} Wikipedia events for carousel`
      );

      // Render Wikipedia events
      wikipediaEvents.forEach((event, index) => {
        console.log(`Rendering Wikipedia event ${index + 1}:`, event.title);
        renderCarouselItem(carouselInner, event, index);
        renderIndicator(carouselIndicators, index);
      });

      initializeCarousel();
      console.log("Wikipedia events rendered and carousel initialized!");
    } else {
      console.log("No Wikipedia events found");
    }

    // Phase 2: Load latest blog post
    console.log("Phase 2: Loading latest blog post...");
    const latestPost = await fetchLatestBlogPost(monthName, month);

    let currentItemCount = wikipediaEvents ? wikipediaEvents.length : 0;

    if (latestPost) {
      console.log("Got latest blog post:", latestPost.title);
      renderCarouselItem(carouselInner, latestPost, currentItemCount);
      renderIndicator(carouselIndicators, currentItemCount);
      currentItemCount++;
    }

    // If we have no items at all, show placeholder
    if (currentItemCount === 0) {
      console.log("No carousel items, showing placeholder");
      renderPlaceholder(carouselInner, month);
      return;
    }

    // Reinitialize carousel after adding blog post
    if (latestPost) {
      initializeCarousel();
    }

    // Phase 3: Load remaining blog posts in background
    console.log("Phase 3: Loading remaining blog posts in background...");
    const allBlogPosts = await fetchBlogPosts(monthName, month);

    const latestPostIndex = latestPost
      ? allBlogPosts.findIndex(
          (p) => p.day === latestPost.day && p.year === latestPost.year
        )
      : -1;

    const remainingPosts = allBlogPosts.filter(
      (_, index) => index !== latestPostIndex
    );

    remainingPosts.forEach((post) => {
      renderCarouselItem(carouselInner, post, currentItemCount);
      renderIndicator(carouselIndicators, currentItemCount);
      currentItemCount++;
    });

    console.log(`Carousel complete with ${currentItemCount} total items`);
  } catch (error) {
    console.error("Error populating carousel:", error);
    renderErrorState(carouselInner);
  }
}

// Make sure your renderCarouselItem function handles external links properly
// Update it to check for isExternal flag (should already be there around line 209)

console.log("Wikipedia carousel functions loaded!");
