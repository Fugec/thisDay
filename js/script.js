const calendarGrid = document.getElementById("calendarGrid");
const currentMonthYearDisplay = document.getElementById("currentMonthYear");
const modalDate = document.getElementById("modalDate");
const modalBodyContent = document.getElementById("modalBodyContent");
const eventDetailModal = new bootstrap.Modal(
  document.getElementById("eventDetailModal")
);
const loadingIndicator = document.getElementById("loadingIndicator"); // This will be hidden by showInitialSkeleton now

// Elements for carousel
const carouselInner = document.getElementById("carouselInner");
const carouselIndicators = document.getElementById("carouselIndicators");

// Theme toggle elements (checkboxes)
const themeSwitchMobile = document.getElementById("themeSwitchMobile");
const themeSwitchDesktop = document.getElementById("themeSwitchDesktop");
const body = document.body;

let currentDate = new Date(); // Start with current date

// Enhanced cache for storing fetched events with expiration
const CACHE_EXPIRY_TIME = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
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
const RATE_LIMIT_WINDOW = 1000; // 1 second

// Reset request counter every second
setInterval(() => {
  requestCount = 0;
}, RATE_LIMIT_WINDOW);

// --- Local Storage Cache Management ---

// load cache from localStorage
function loadCacheFromLocalStorage() {
  try {
    const cachedData = localStorage.getItem(LOCAL_STORAGE_CACHE_KEY);
    if (cachedData) {
      const parsedData = JSON.parse(cachedData);
      // Convert plain object back to Map for easier use
      return new Map(Object.entries(parsedData));
    }
  } catch (e) {
    console.error("Error loading cache from localStorage:", e);
  }
  return new Map(); // Return empty Map if no data or error
}

// save cache to localStorage
function saveCacheToLocalStorage(cacheMap) {
  try {
    // Convert Map to a plain object for JSON stringification
    const objToStore = {};
    cacheMap.forEach((value, key) => {
      objToStore[key] = value;
    });
    localStorage.setItem(LOCAL_STORAGE_CACHE_KEY, JSON.stringify(objToStore));
  } catch (e) {
    console.error("Error saving cache to localStorage:", e);
  }
}

// Initialize eventCache from localStorage on startup
let eventCache = loadCacheFromLocalStorage();

// --- End Local Storage Cache Management ---

// Enhanced rate-limited fetch with retry logic - CORS FIX
async function rateLimitedFetch(url, options = {}, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Check rate limit
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
        // Rate limited, wait and retry
        const waitTime = Math.pow(2, attempt) * 1000; // Exponential backoff
        console.warn(
          `Rate limited. Waiting ${waitTime}ms before retry ${attempt + 1}`
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        continue;
      } else if (response.status >= 500) {
        // Server error, retry
        const waitTime = Math.pow(2, attempt) * 500;
        console.warn(
          `Server error ${response.status}. Retrying in ${waitTime}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        continue;
      } else {
        // Client error, don't retry
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

// Enhanced Wikipedia API function with better error handling and caching
// Now returns a structured object { events: [], births: [], deaths: [] }
async function fetchWikipediaEvents(month, day) {
  const cacheKey = `${month}-${day}-en`;

  // Check cache with expiration
  if (eventCache.has(cacheKey)) {
    const cached = eventCache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_EXPIRY_TIME) {
      return cached.data; // Return cached structured data
    } else {
      eventCache.delete(cacheKey); // Remove expired cache
      saveCacheToLocalStorage(eventCache); // Update localStorage
    }
  }

  const monthPadded = String(month).padStart(2, "0");
  const dayPadded = String(day).padStart(2, "0");
  // *** API ***
  const url = `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events/${monthPadded}/${dayPadded}?origin=*`;

  try {
    const response = await rateLimitedFetch(url);

    // Check if offline
    if (!navigator.onLine && !response.ok) {
      console.warn("Offline: Cannot fetch new data from Wikipedia.");
      // Return empty structured data if offline and no cache
      return { events: [], births: [], deaths: [] };
    }

    if (!response.ok) {
      console.warn(
        `No data for English Wikipedia for ${month}/${day} (Status: ${response.status})`
      );
      const emptyData = { events: [], births: [], deaths: [] };
      // Cache empty result to avoid repeated failed requests
      eventCache.set(cacheKey, { data: emptyData, timestamp: Date.now() });
      saveCacheToLocalStorage(eventCache); // Update localStorage
      return emptyData;
    }

    const data = await response.json();
    const processedEvents = [];
    const processedBirths = [];
    const processedDeaths = [];

    // Helper to process an array of items (events, births, deaths)
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
            title: item.text.split(".")[0] + ".", // Basic title extraction
            description: item.text,
            year: item.year || "Unknown",
            sourceUrl: wikipediaLink,
            thumbnailUrl: thumbnailUrl,
            type: type, // Explicitly add type for categorization
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

    // Cache the result with timestamp
    eventCache.set(cacheKey, { data: resultData, timestamp: Date.now() });
    saveCacheToLocalStorage(eventCache); // Update localStorage
    return resultData;
  } catch (error) {
    console.error(`Error fetching events for ${month}/${day}:`, error);
    // Return empty structured data but don't cache errors to allow retries
    return { events: [], births: [], deaths: [] };
  }
}

// Enhanced carousel population to load blog posts from /blog/ folder structure
async function populateCarousel(month, year) {
  carouselInner.innerHTML = "";
  carouselIndicators.innerHTML = "";

  try {
    const today = new Date();
    const currentMonth = today.getMonth(); // 0-indexed
    const currentDay = today.getDate();

    // Get month name for folder structure
    const monthName = monthNames[currentMonth].toLowerCase();

    console.log(`Fetching ALL blog posts for entire month: ${monthName}`);

    // Fetch ALL blog posts for the current month (not just current day)
    const blogPosts = await fetchBlogPosts(monthName, currentMonth);

    console.log(`Found ${blogPosts.length} blog posts`);

    if (blogPosts.length === 0) {
      // Default placeholder if no blog posts are found
      const defaultItem = document.createElement("div");
      defaultItem.className = "carousel-item active";
      defaultItem.innerHTML = `
        <div class="carousel-image-container">
          <img src="https://placehold.co/1200x350/6c757d/ffffff?text=No+Blog+Posts+Available+for+${monthName}"
               class="d-block w-100" alt="No blog posts available" width="1200" height="350" fetchpriority="high" decoding="async">
        </div>
        <div class="carousel-caption">
          <h5>Blog Posts for ${monthNames[currentMonth]}</h5>
          <p>No blog posts available for this month. Check back later for new content!</p>
          <a href="#calendarGrid" class="btn btn-primary btn-sm">Explore Calendar</a>
        </div>
      `;
      carouselInner.appendChild(defaultItem);
      return;
    }

    // Create carousel items for each blog post
    blogPosts.forEach((post, index) => {
      const carouselItem = document.createElement("div");
      carouselItem.className = `carousel-item${index === 0 ? " active" : ""}`;

      const imageUrl =
        post.imageUrl ||
        `https://placehold.co/1200x350/6c757d/ffffff?text=Blog+Post+${post.day}`;
      const fallbackImageUrl = `https://placehold.co/1200x350/6c757d/ffffff?text=Blog+Post+${post.day}`;

      // Truncate title if too long
      const MAX_WORDS = 15;
      let titleContent =
        post.title ||
        `Blog Post - ${post.day} ${monthNames[currentMonth]} ${post.year}`;
      const titleWords = titleContent.split(" ");
      let truncatedTitle = titleWords.slice(0, MAX_WORDS).join(" ");

      if (titleWords.length > MAX_WORDS) {
        truncatedTitle += "...";
      }

      // Date label for the blog post
      const dateLabel = `
        <span class="year-label">
          ${post.day} ${monthNames[currentMonth]} ${post.year}
        </span>
      `;

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
          <p>${
            post.excerpt || "Read this blog post about historical events."
          }</p>
          <a href="${post.url}" class="btn btn-primary btn-sm"
             ${
               post.isExternal
                 ? 'target="_blank" rel="noopener noreferrer"'
                 : ""
             }>
             Read Full Post
          </a>
        </div>
      `;
      carouselInner.appendChild(carouselItem);

      // Create carousel indicators
      const indicator = document.createElement("button");
      indicator.setAttribute("type", "button");
      indicator.setAttribute("data-bs-target", "#historicalCarousel");
      indicator.setAttribute("data-bs-slide-to", index);
      indicator.setAttribute("aria-label", `Slide ${index + 1}`);
      if (index === 0) {
        indicator.className = "active";
        indicator.setAttribute("aria-current", "true");
      }
      carouselIndicators.appendChild(indicator);
    });

    // Initialize carousel
    const carouselElement = document.getElementById("historicalCarousel");
    const bsCarousel = bootstrap.Carousel.getInstance(carouselElement);
    if (bsCarousel) {
      bsCarousel.to(0);
      bsCarousel.cycle();
    } else {
      new bootstrap.Carousel(carouselElement, {
        interval: 3000, // 3 seconds per slide
        ride: "carousel",
      });
    }
  } catch (error) {
    console.error("Error populating carousel:", error);
    // Show error state in carousel
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
    carouselInner.appendChild(errorItem);
  }
}

// fetch blog posts from the /blog/ folder structure
async function fetchBlogPosts(monthName, monthIndex) {
  const blogPosts = [];
  const BLOG_CACHE_KEY = `blogPosts_${monthName}`;

  console.log(`Attempting to fetch ALL blog posts for ${monthName}`);

  // Check cache first (using in-memory cache)
  const cachedPosts = getCachedBlogPosts(BLOG_CACHE_KEY);
  if (cachedPosts) {
    console.log("Using cached blog posts");
    return cachedPosts;
  }

  try {
    // Method 1: Try to fetch from manifest file first (recommended approach)
    const manifestPosts = await fetchBlogPostsFromManifest(monthName);
    if (manifestPosts.length > 0) {
      console.log(`Found ${manifestPosts.length} posts from manifest`);
      setCachedBlogPosts(BLOG_CACHE_KEY, manifestPosts);
      return manifestPosts;
    }

    // Method 2: Try to fetch all posts from the month folder
    const allPosts = await fetchAllBlogPostsFromFolder(monthName, monthIndex);
    if (allPosts.length > 0) {
      console.log(`Found ${allPosts.length} posts from folder scanning`);
      setCachedBlogPosts(BLOG_CACHE_KEY, allPosts);
      return allPosts;
    }

    // Method 3: Generate posts for all days in the month
    const generatedPosts = await generateMonthBlogPosts(monthName, monthIndex);
    if (generatedPosts.length > 0) {
      console.log(`Generated ${generatedPosts.length} posts for the month`);
      setCachedBlogPosts(BLOG_CACHE_KEY, generatedPosts);
      return generatedPosts;
    }

    console.log(`No blog posts found for ${monthName}`);
    return [];
  } catch (error) {
    console.error("Error fetching blog posts:", error);

    // Fallback: try to generate blog posts for the entire month
    const fallbackPosts = await generateMonthBlogPosts(monthName, monthIndex);
    console.log(`Using fallback posts: ${fallbackPosts.length}`);
    return fallbackPosts;
  }
}

// Fetch ALL blog posts from the month folder (starting from 2025, only before today)
async function fetchAllBlogPostsFromFolder(monthName, monthIndex) {
  const allPosts = [];
  const currentYear = new Date().getFullYear();
  const startYear = Math.max(2025, currentYear); // Start from 2025 or current year, whichever is higher

  const today = new Date();
  const currentMonth = today.getMonth();
  const currentDay = today.getDate();

  console.log(
    `Scanning for all blog posts in ${monthName} folder starting from ${startYear} (only before today)...`
  );

  // Get number of days in the month
  const daysInMonth = new Date(startYear, monthIndex + 1, 0).getDate();

  // Try to find posts for all days of the month, but only for days before today
  for (let day = 1; day <= daysInMonth; day++) {
    // Skip future days (allow today)
    if (monthIndex === currentMonth && day > currentDay) {
      continue;
    }

    // Skip future months
    if (monthIndex > currentMonth) {
      continue;
    }

    const folderName = `${day}-${startYear}`;

    try {
      // Check if this post exists by trying to fetch it
      const response = await fetch(`/blog/${monthName}/${folderName}/`, {
        method: "HEAD",
        cache: "no-cache",
      });

      if (response.ok) {
        console.log(`Found blog post: ${folderName}`);
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
    } catch (error) {
      // Ignore errors for non-existent posts
    }
  }

  // Sort posts by day (most recent first)
  return allPosts.sort((a, b) => b.day - a.day);
}

// generate blog posts for all days in the month (only before today)
async function generateMonthBlogPosts(monthName, monthIndex) {
  const posts = [];
  const currentYear = new Date().getFullYear();
  const year = Math.max(2025, currentYear); // Use 2025 or current year, whichever is higher

  const today = new Date();
  const currentMonth = today.getMonth();
  const currentDay = today.getDate();

  console.log(
    `Generating blog posts for all days in ${monthName} ${year} (only before today)...`
  );

  // Get number of days in the month
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

  // Generate posts for each day, but only for days before today
  for (let day = 1; day <= daysInMonth; day++) {
    // Skip days that are today or in the future
    if (monthIndex === currentMonth && day >= currentDay) {
      continue;
    }

    // Skip future months
    if (monthIndex > currentMonth) {
      continue;
    }

    const folderName = `${day}-${year}`;

    // Create image URL using the format day.month.jpg (e.g., 18.7.jpg)
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

  // Sort posts by day (most recent first)
  return posts.sort((a, b) => b.day - a.day);
}

// fetch individual blog post data
async function fetchBlogPostData(monthName, folder, day, year, monthIndex) {
  try {
    console.log(`Fetching HTML for blog post: ${monthName}/${folder}`); // Updated log message

    // Create image URL using the format day.month.jpg (e.g., 18.7.jpg)
    const imageUrl = `/images/blog/${day}.${monthIndex + 1}.jpg`;

    // --- Directly try to fetch index.html and parse it ---
    const htmlResponse = await fetch(`/blog/${monthName}/${folder}/index.html`);

    if (htmlResponse.ok) {
      const html = await htmlResponse.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");

      // Extract title from various possible sources
      const title =
        doc
          .querySelector('meta[property="og:title"]')
          ?.getAttribute("content") ||
        doc.querySelector("title")?.textContent ||
        `Historical Events - ${day} ${monthNames[monthIndex]} ${year}`;

      // Extract excerpt/description
      const excerpt =
        doc
          .querySelector('meta[property="og:description"]')
          ?.getAttribute("content") ||
        doc
          .querySelector('meta[name="description"]')
          ?.getAttribute("content") ||
        `Discover what happened on ${day} ${monthNames[monthIndex]} ${year}`;

      console.log(`Parsed HTML for ${folder}:`, { title, excerpt });

      return {
        day: day,
        year: year,
        title: title.trim(),
        excerpt: excerpt.trim(),
        imageUrl: imageUrl, // Always use the standardized image format
        url: `/blog/${monthName}/${folder}/`,
        isExternal: false,
      };
    }

    // If no content found (index.html not found/OK), return basic info with standardized image
    console.warn(
      `No index.html found for ${monthName}/${folder}, returning basic info.`
    );
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

    // Return basic data with standardized image even on error
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

// In-memory cache for blog posts (replacing localStorage)
const blogPostCache = new Map();

function getCachedBlogPosts(key) {
  try {
    const cached = blogPostCache.get(key);
    if (cached) {
      if (Date.now() - cached.timestamp < 60 * 60 * 1000) {
        // 1 hour cache
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

// Improved manifest-based approach (only before today)
async function fetchBlogPostsFromManifest(monthName) {
  try {
    console.log(`Trying to fetch manifest for ${monthName}`);
    const response = await fetch(`/blog/${monthName}/manifest.json`);
    if (!response.ok) {
      console.log(
        `Manifest not found for ${monthName} (Status: ${response.status})`
      );
      return [];
    }

    const manifest = await response.json();
    console.log(`Manifest loaded for ${monthName}:`, manifest);

    const today = new Date();
    const currentMonth = today.getMonth();
    const currentDay = today.getDate();
    const monthIndex = monthNames.findIndex(
      (m) => m.toLowerCase() === monthName.toLowerCase()
    );

    const blogPosts = [];

    for (const post of manifest.posts || []) {
      // Skip future days (allow today)
      if (monthIndex === currentMonth && post.day > currentDay) {
        continue;
      }

      // Skip future months
      if (monthIndex > currentMonth) {
        continue;
      }

      // Use standardized image format
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

// Debug test blog post fetching
async function debugBlogPosts() {
  const today = new Date();
  const monthName = monthNames[today.getMonth()].toLowerCase();

  console.log("=== Blog Post Debug ===");
  console.log(`Month: ${monthName}`);
  console.log(`Looking for ALL posts in /blog/${monthName}/`);
  console.log(`Starting from year: ${Math.min(2025, today.getFullYear())}`);
  console.log(`Using image format: /images/blog/[day].[month].jpg`);

  // Test manifest
  console.log("Testing manifest...");
  const manifestPosts = await fetchBlogPostsFromManifest(monthName);
  console.log("Manifest posts:", manifestPosts);

  // Test folder scanning
  console.log("Testing folder scanning...");
  const folderPosts = await fetchAllBlogPostsFromFolder(
    monthName,
    today.getMonth()
  );
  console.log("Folder posts:", folderPosts);

  // Test month generation
  console.log("Testing month generation...");
  const generatedPosts = await generateMonthBlogPosts(
    monthName,
    today.getMonth()
  );
  console.log("Generated posts:", generatedPosts);

  // Test specific posts
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

// create day card element// create day card element
function createDayCard(day, month) {
  const dayCard = document.createElement("div");
  dayCard.className = "day-card"; // Remove initial loading class
  dayCard.setAttribute("data-day", day);
  dayCard.setAttribute("data-month", month + 1);

  const dayNumber = document.createElement("div");
  dayNumber.className = "day-number";
  dayNumber.textContent = day;
  dayCard.appendChild(dayNumber);

  const eventSummary = document.createElement("div");
  eventSummary.className = "event-summary";
  eventSummary.textContent = "Click to load"; // Default inactive state
  dayCard.appendChild(eventSummary);

  return dayCard;
}

// load events for a specific day card
async function loadDayEvents(dayCard, month, forceLoad = false) {
  const day = parseInt(dayCard.getAttribute("data-day"));
  // Only load if not already loaded or if forceLoad is true
  if (dayCard.classList.contains("loaded") && !forceLoad) {
    console.log(`Events for day ${day} already loaded.`);
    return true;
  }

  // Set loading state
  const eventSummary = dayCard.querySelector(".event-summary");
  dayCard.classList.add("loading");
  dayCard.classList.remove("needs-load");
  eventSummary.innerHTML =
    '<div class="spinner-border spinner-border-sm" role="status"></div>';

  try {
    // Expect structured data from fetchWikipediaEvents
    const eventsData = await fetchWikipediaEvents(month + 1, day);
    // Store the structured events data directly on the card
    dayCard.eventsData = eventsData;

    // Update UI based on combined event count
    const totalEvents =
      (eventsData.events?.length || 0) +
      (eventsData.births?.length || 0) +
      (eventsData.deaths?.length || 0);

    dayCard.classList.remove("loading");
    dayCard.classList.add("loaded"); // Mark as loaded

    if (totalEvents > 0) {
      eventSummary.textContent = `${totalEvents} Events`;
      dayCard.classList.remove("no-events");
    } else {
      eventSummary.textContent = "No Events";
      dayCard.classList.add("no-events");
    }

    // Attach click listener if not already attached for this card's data state
    // Ensure click listener is only attached once or updates its bound data
    if (!dayCard._hasClickListener) {
      dayCard.addEventListener("click", () => {
        showEventDetails(
          day,
          month + 1,
          currentDate.getFullYear(),
          dayCard.eventsData // Pass pre-fetched structured data
        );
      });
      dayCard._hasClickListener = true; // Mark that listener is attached
    }

    return true;
  } catch (error) {
    console.error(`Error loading events for day ${day}:`, error);
    const eventSummary = dayCard.querySelector(".event-summary");
    eventSummary.textContent = "Error";
    dayCard.classList.remove("loading");
    dayCard.classList.add("error");
    dayCard.classList.remove("loaded"); // If error, not fully loaded
    return false;
  }
}

async function renderCalendar() {
  // Clear only day cards from the calendar grid
  calendarGrid.innerHTML = ""; // Clear previous content

  calendarGrid.setAttribute("role", "grid");
  calendarGrid.setAttribute("aria-label", "Historical events calendar");

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth(); // 0-indexed month
  const today = new Date();
  const isCurrentMonth =
    year === today.getFullYear() && month === today.getMonth();
  const todayDate = today.getDate();

  currentMonthYearDisplay.textContent = `${monthNames[month]}`;
  document.title = `What Happened on This Day | ${monthNames[month]} Historical Events`;

  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // 1. Create all calendar grid structure first in inactive state
  const dayCards = [];
  for (let i = 1; i <= daysInMonth; i++) {
    const dayCard = createDayCard(i, month);

    // Add ARIA roles and labels
    dayCard.setAttribute("role", "button");
    dayCard.setAttribute("tabindex", "0");
    dayCard.setAttribute("aria-label", `Events for ${i} ${monthNames[month]}`);
    dayCard.setAttribute("aria-pressed", "false");

    // Mark all cards as needing to load initially
    dayCard.classList.add("needs-load");

    // Add click listener for lazy loading to all cards
    dayCard.addEventListener("click", async () => {
      if (
        dayCard.classList.contains("needs-load") ||
        dayCard.classList.contains("error")
      ) {
        await loadDayEvents(dayCard, month, true); // Force load
        dayCard.classList.remove("needs-load");
      }
      // After loading (or if already loaded), show event details
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
    // 2. Load Carousel content in parallel
    const carouselPromise = populateCarousel(month, year);

    // 3. Only load events for today's date if we're viewing the current month
    if (isCurrentMonth) {
      const todayCard = dayCards.find(
        (card) => parseInt(card.getAttribute("data-day")) === todayDate
      );

      if (todayCard) {
        // Load today's events immediately
        await loadDayEvents(todayCard, month, true);

        // Scroll to today's card after its events are loaded
        setTimeout(() => {
          todayCard.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        }, 300); // Small delay to allow rendering
      }
    }

    // Ensure carousel is also finished
    await carouselPromise;
  } catch (error) {
    console.error("Error during calendar rendering:", error);
    console.error(
      "This error could be due to network issues, API rate limits, or unexpected data format. Please check your internet connection, ensure the API is accessible, and verify the data structure."
    );
    // Display a general error message if something critical fails
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

// --- GLOBAL VARIABLES FOR FILTERING ---
let currentDayAllItems = []; // Stores all events for the currently opened day, with assigned categories
let currentActiveFilter = "all"; // Tracks the currently active filter category

// --- CATEGORY DEFINITIONS WITH INCLUDE/EXCLUDE PRINCIPLE ---
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

// Helper function to check if text matches include/exclude criteria
function matchesCategory(text, categoryRules) {
  const lowerText = text.toLowerCase();

  // Check if any exclude keywords are present
  for (const excludeKeyword of categoryRules.exclude) {
    if (lowerText.includes(excludeKeyword.toLowerCase())) {
      return false;
    }
  }

  // Check if any include keywords are present
  for (const includeKeyword of categoryRules.include) {
    if (lowerText.includes(includeKeyword.toLowerCase())) {
      return true;
    }
  }

  return false;
}

// Main categorization function
function assignCategories(item) {
  const categoriesFound = new Set();

  // 1. Handle explicit type-based categories first
  if (item.type === "birth") {
    categoriesFound.add("Births");
    categoriesFound.add("Famous Persons");
  } else if (item.type === "death") {
    categoriesFound.add("Deaths");
    categoriesFound.add("Famous Persons");
  }

  // 2. Categorize based on include/exclude keyword matching
  const itemText = (item.description || item.title || "").toLowerCase();

  for (const categoryName in eventCategories) {
    if (matchesCategory(itemText, eventCategories[categoryName])) {
      categoriesFound.add(categoryName);
    }
  }

  // 3. Add 'Miscellaneous' if no categories found (excluding type-based ones)
  const nonTypeBased = Array.from(categoriesFound).filter(
    (cat) => cat !== "Births" && cat !== "Deaths"
  );

  if (nonTypeBased.length === 0 && !categoriesFound.has("Famous Persons")) {
    categoriesFound.add("Miscellaneous");
  }

  return Array.from(categoriesFound);
}

// Render Items in the Modal
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
    // Determine special emphasis based on explicit 'type'
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

// Apply the Filter
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

// showEventDetails include filtering and process structured data
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
    // If no pre-fetched structured events, fetch new ones (this will check cache first)
    if (
      !structuredEvents ||
      (structuredEvents.events?.length === 0 &&
        structuredEvents.births?.length === 0 &&
        structuredEvents.deaths?.length === 0)
    ) {
      structuredEvents = await fetchWikipediaEvents(month, day);
    }

    // --- Combine all event types into a single array for processing ---
    currentDayAllItems = [
      ...(structuredEvents.events || []),
      ...(structuredEvents.births || []),
      ...(structuredEvents.deaths || []),
    ].map((item) => ({
      ...item,
      // Pass the entire item to assignCategories to leverage 'type' and 'description'
      categories: assignCategories(item),
    }));

    // Sort events by year
    currentDayAllItems.sort((a, b) => {
      const yearA = parseInt(a.year) || 0;
      const yearB = parseInt(b.year) || 0;
      return yearA - yearB;
    });

    // --- Generate Filter Buttons ---
    const allAvailableCategories = new Set(["All"]);
    currentDayAllItems.forEach((item) => {
      item.categories.forEach((cat) => allAvailableCategories.add(cat));
    });

    const sortedCategories = Array.from(allAvailableCategories).sort((a, b) => {
      // Prioritize "All", then "Births", "Deaths", "Famous Persons", then alphabetical
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
    // --- END Filter Buttons ---

    // --- Build Modal Content HTML with Filter Container ---
    modalBodyContent.innerHTML = `
    <div class="modal-header-content">
        ${filterButtonsHtml}
    </div>
    <div id="modal-events-list">
        </div>
`;
    // --- END Modal Content ---

    // Attach event listeners to filter buttons
    modalBodyContent.querySelectorAll(".filter-btn").forEach((button) => {
      button.addEventListener("click", (event) => {
        const clickedCategory = event.target.dataset.category;

        if (clickedCategory === currentActiveFilter) {
          // If the active filter button is clicked again, reset to "All"
          currentActiveFilter = "all";
          // Remove active class from current button
          event.target.classList.remove("active");
          // Find and activate the "All" button
          const allButton = modalBodyContent.querySelector(
            '.filter-btn[data-category="all"]'
          );
          if (allButton) {
            allButton.classList.add("active");
          }
        } else {
          // Normal behavior: set new active filter
          currentActiveFilter = clickedCategory;
          // Update active state in UI
          modalBodyContent
            .querySelectorAll(".filter-btn")
            .forEach((btn) => btn.classList.remove("active"));
          event.target.classList.add("active");
        }

        applyFilter();
      });
    });

    // Initial render based on the current active filter (which is "all" by default or from previous modal open)
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

// Theme management functions
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

// Initialize application with TODAY-FIRST approach
document.addEventListener("DOMContentLoaded", async () => {
  try {
    console.log("Initializing calendar with today-first loading strategy...");

    const savedTheme = localStorage.getItem("theme") || "dark";
    setTheme(savedTheme);

    // Initial skeleton shown
    // Render the calendar
    await renderCalendar();
  } catch (error) {
    console.error("Error initializing application:", error);
    // Show error message to user
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

// Event listeners with error handling
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

// Navigation event listeners
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

// Set current year in footer (Moved from inline script in index.html)
const currentYearElement = document.getElementById("currentYear");
if (currentYearElement) {
  currentYearElement.textContent = new Date().getFullYear();
}

// Cleanup function for cache management
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
    saveCacheToLocalStorage(eventCache); // Update localStorage after cleanup
  }
}

// Run cache cleanup every hour
setInterval(cleanupCache, 60 * 60 * 1000);

// Add visibility change handler to pause/resume when tab becomes visible/hidden
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    // Optionally refresh data when tab becomes visible again
    cleanupCache();
  }
});

// Add error boundary for unhandled promise rejections
window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection:", event.reason);
  // Optionally show user-friendly error message
  event.preventDefault();
});

// Performance monitoring (optional)
if (typeof PerformanceObserver !== "undefined") {
  const observer = new PerformanceObserver((list) => {
    list.getEntries().forEach((entry) => {
      if (entry.duration > 1000) {
        // Log slow operations
        console.warn(
          `Slow operation detected: ${entry.name} took ${entry.duration}ms`
        );
      }
    });
  });

  try {
    observer.observe({ entryTypes: ["measure", "navigation"] });
  } catch (e) {
    // Performance Observer not supported, ignore
  }
}

document.addEventListener("DOMContentLoaded", () => {
  if (navigator.onLine && location.pathname === "/") {
    const PREFETCH_KEY = "imagePrefetchDone";
    const today = new Date().toISOString().slice(0, 10);

    if (localStorage.getItem(PREFETCH_KEY) !== today) {
      fetch("https://thisday.info/api/today-images")
        .then((res) => res.json())
        .then((data) => {
          console.log("Image prefetch data from worker:", data);

          // Client-side prefetching based on worker's response
          if (data && data.prefetched) {
            // Preload eager image (if any)
            if (data.prefetched.eager) {
              const link = document.createElement("link");
              link.rel = "preload";
              link.as = "image";
              link.href = data.prefetched.eager;
              document.head.appendChild(link);
              console.log(
                "Client-side preloaded eager image:",
                data.prefetched.eager
              );
            }

            // Prefetch lazy images (e.g., by creating Image objects)
            data.prefetched.lazy.forEach((url) => {
              const img = new Image();
              img.src = url;
              console.log("Client-side prefetched lazy image:", url);
            });
          }

          localStorage.setItem(PREFETCH_KEY, today);
        })
        .catch((err) => console.warn("Prefetching error:", err));
    }
  }
});

// Modal close listener to reset filter
// Add event listener for the modal close button
const eventDetailModalElement = document.getElementById("eventDetailModal");
if (eventDetailModalElement) {
  eventDetailModalElement
    .querySelector(".btn-close")
    .addEventListener("click", () => {
      eventDetailModal.hide(); // Use Bootstrap's hide method
      currentActiveFilter = "all"; // Reset filter on close
    });
  // Also handle when dismissed via backdrop click or ESC key
  eventDetailModalElement.addEventListener("hidden.bs.modal", function () {
    currentActiveFilter = "all"; // Reset filter when modal is completely hidden
  });
}
