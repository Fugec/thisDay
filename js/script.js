// Prevent FOUC and show skeleton immediately
document.documentElement.style.display = "block";

// Optimize the initial render by showing skeleton immediately
function showInitialSkeleton() {
  const carouselInner = document.getElementById("carouselInner");
  const calendarGrid = document.getElementById("calendarGrid");
  const loadingIndicator = document.getElementById("loadingIndicator");

  if (carouselInner) {
    carouselInner.innerHTML = `
            <div class="carousel-item active">
                <div class="carousel-caption">
                    <div class="skeleton-text skeleton-header-text"></div>
                    <div class="skeleton-paragraph skeleton-text"></div>
                    <div class="skeleton-button"></div>
                </div>
            </div>
        `;
  }

  if (calendarGrid) {
    let skeletonDaysHtml = "";
    for (let i = 0; i < 31; i++) {
      // Generate 31 skeleton day cards
      skeletonDaysHtml += `
                <div class="day-card skeleton">
                    <div class="day-number skeleton-text" style="width: 30%;"></div>
                    <div class="event-summary skeleton-text" style="width: 70%;"></div>
                </div>
            `;
    }
    calendarGrid.innerHTML = skeletonDaysHtml;
  }

  // Hide the general loading indicator because of skeletons
  if (loadingIndicator) {
    loadingIndicator.style.display = "none";
  }
}

// Call showInitialSkeleton immediately, before waiting for DOMContentLoaded
showInitialSkeleton();

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

// Function to load cache from localStorage
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

// Function to save cache to localStorage
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

// Optimized carousel population to focus on the current date
async function populateCarousel(month, year) {
  carouselInner.innerHTML = "";
  carouselIndicators.innerHTML = "";

  try {
    const today = new Date();
    const currentMonth = today.getMonth(); // 0-indexed
    const currentDay = today.getDate();

    // Fetch events only for the current day
    // Expect structured data from fetchWikipediaEvents
    const eventsData = await fetchWikipediaEvents(currentMonth + 1, currentDay);

    // Combine all event types for the carousel for image selection
    const allEventsForToday = [
      ...(eventsData.events || []),
      ...(eventsData.births || []),
      ...(eventsData.deaths || []),
    ];

    const eventsWithImages = allEventsForToday.filter(
      (event) =>
        event.sourceUrl &&
        event.sourceUrl.includes("wikipedia.org") &&
        event.thumbnailUrl &&
        event.thumbnailUrl !== ""
    );

    let uniqueEvents = [];
    if (eventsWithImages.length <= 3) {
      uniqueEvents = eventsWithImages; // If 3 or less, use all of them
    } else {
      // More efficient random selection without full array shuffle
      const selectedIndices = new Set();
      while (selectedIndices.size < 3) {
        selectedIndices.add(
          Math.floor(Math.random() * eventsWithImages.length)
        );
      }
      uniqueEvents = Array.from(selectedIndices).map(
        (index) => eventsWithImages[index]
      );
    }

    if (uniqueEvents.length === 0) {
      // Default placeholder if no events with images are found for today
      const defaultItem = document.createElement("div");
      defaultItem.className = "carousel-item active";
      // Carousel-image-container for consistent sizing
      defaultItem.innerHTML = `
        <div class="carousel-image-container">
          <img src="https://placehold.co/1200x350/6c75D/ffffff?text=No+Featured+Images+Available+for+Today"
               class="d-block w-100" alt="No images available" width="1200" height="350" fetchpriority="high" decoding="async">
        </div>
        <div class="carousel-caption">
          <h5>Discover History on ${currentDay} ${monthNames[currentMonth]}</h5>
          <p>No specific featured images available for today, but explore the calendar for more events!</p>
          <a href="#calendarGrid" class="btn btn-primary btn-sm">Explore Calendar</a>
        </div>
      `;
      carouselInner.appendChild(defaultItem);
      return;
    }

    uniqueEvents.forEach((event, index) => {
      const carouselItem = document.createElement("div");
      carouselItem.className = `carousel-item${index === 0 ? " active" : ""}`;

      const imageUrl = event.thumbnailUrl;
      const fallbackImageUrl = `https://placehold.co/1200x350/6c757d/ffffff?text=Image+Not+Available`;

      const MAX_WORDS = 15;
      let titleContent = event.title || "Historical Event on This Day";
      const titleWords = titleContent.split(" ");
      let truncatedTitle = titleWords.slice(0, MAX_WORDS).join(" ");

      if (titleWords.length > MAX_WORDS) {
        truncatedTitle += "...";
      }
      // Get the current day and month for the label
      const today = new Date();
      const currentMonth = today.getMonth(); // 0-indexed
      const currentDay = today.getDate();

      // Formatted as "Day Month Year" (e.g., "26 June 1980")
      const formattedDate = `${currentDay} ${monthNames[currentMonth]} ${event.year}`;

      const yearLabel = `
        <span class="year-label">
          ${formattedDate}
        </span>
      `;

      carouselItem.innerHTML = `
        <div style="position:relative;">
          ${yearLabel}
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
          <a href="${event.sourceUrl}" class="btn btn-primary btn-sm"
             target="_blank" rel="noopener noreferrer">Read More About ${
               event.title.length > 50
                 ? `${event.title.substring(0, 12)}...`
                 : event.title
             }</a>
        </div>
      `;
      carouselInner.appendChild(carouselItem);

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
        interval: 4000,
        ride: "carousel",
      });
    }
  } catch (error) {
    console.error("Error populating carousel:", error);
    // Show error state in carousel
    const errorItem = document.createElement("div");
    errorItem.className = "carousel-item active";
    // Carousel-image-container for consistent sizing
    errorItem.innerHTML = `
      <div class="carousel-image-container">
        <img src="https://placehold.co/1200x350/dc3545/ffffff?text=Error+Loading+Images"
             class="d-block w-100" alt="Error loading" width="1200" height="350" fetchpriority="high" decoding="async">
      </div>
      <div class="carousel-caption">
        <h5>Unable to Load Featured Content</h5>
        <p>Please check your internet connection and try again.</p>
      </div>
    `;
    carouselInner.appendChild(errorItem);
  }
}

// Function to create day card element
function createDayCard(day, month) {
  const dayCard = document.createElement("div");
  dayCard.className = "day-card loading"; // Start with loading class
  dayCard.setAttribute("data-day", day);
  dayCard.setAttribute("data-month", month + 1);

  const dayNumber = document.createElement("div");
  dayNumber.className = "day-number";
  dayNumber.textContent = day;
  dayCard.appendChild(dayNumber);

  const eventSummary = document.createElement("div");
  eventSummary.className = "event-summary";
  eventSummary.innerHTML =
    '<div class="spinner-border spinner-border-sm" role="status"></div>'; // Default loading spinner
  dayCard.appendChild(eventSummary);

  return dayCard;
}

// Function to load events for a specific day card
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
      dayCard.classList.remove("skeleton"); // Remove skeleton class
    } else {
      eventSummary.textContent = "No Events";
      dayCard.classList.add("no-events");
      dayCard.classList.remove("skeleton"); // Remove skeleton class
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
    dayCard.classList.remove("skeleton"); // Remove skeleton class
    return false;
  }
}

async function renderCalendar() {
  // Clear only day cards from the calendar grid
  calendarGrid.innerHTML = ""; // Clear previous content, including skeletons

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

  // 1. Create all calendar grid structure first with skeleton states
  const dayCards = [];
  for (let i = 1; i <= daysInMonth; i++) {
    const dayCard = createDayCard(i, month);
    dayCard.classList.add("skeleton"); // Add skeleton class initially

    // Add ARIA roles and labels
    dayCard.setAttribute("role", "button");
    dayCard.setAttribute("tabindex", "0");
    dayCard.setAttribute("aria-label", `Events for ${i} ${monthNames[month]}`);
    dayCard.setAttribute("aria-pressed", "false");

    if (isCurrentMonth && i === todayDate) {
      dayCard.classList.add("today-highlight");
      dayCard.setAttribute("aria-current", "date");
    }

    calendarGrid.appendChild(dayCard);
    dayCards.push(dayCard);
  }

  try {
    // Determine which days to prioritize for loading
    let daysToPrioritize = [];
    if (isCurrentMonth) {
      // Prioritize today's date and a total of 7 days around it if possible
      const startDay = Math.max(1, todayDate - 3); // 3 days before today
      const endDay = Math.min(daysInMonth, todayDate + 3); // 3 days after today

      for (let i = startDay; i <= endDay; i++) {
        const card = dayCards.find(
          (dCard) => parseInt(dCard.getAttribute("data-day")) === i
        );
        if (card) {
          daysToPrioritize.push(card);
        }
      }
    } else {
      // For other months, prioritize the first 7 days explicitly
      daysToPrioritize = dayCards.slice(0, Math.min(daysInMonth, 7));
    }

    // Filter out duplicates and ensure all are actual elements
    daysToPrioritize = [...new Set(daysToPrioritize)].filter(Boolean);

    // 2. Load Carousel content in parallel (high priority visual)
    const carouselPromise = populateCarousel(month, year);

    // 3. Load prioritized days with limited concurrency
    const CONCURRENCY_LIMIT =
      navigator.connection && navigator.connection.effectiveType === "4g"
        ? 10
        : 5; // Dynamically adjust based on network speed
    let activePromises = [];

    const loadDayPromisesWithConcurrency = async (cardsToLoad) => {
      for (const dayCard of cardsToLoad) {
        // Only load if the card is not already marked as loaded (e.g., from cache)
        if (!dayCard.classList.contains("loaded")) {
          const promise = loadDayEvents(dayCard, month);
          activePromises.push(promise);

          if (activePromises.length >= CONCURRENCY_LIMIT) {
            await Promise.race(activePromises).finally(() => {
              activePromises = activePromises.filter((p) => p !== promise);
            });
          }
        }
      }
      await Promise.all(activePromises); // Wait for any remaining
    };

    // Load prioritized days
    await loadDayPromisesWithConcurrency(daysToPrioritize);

    // Scroll to today's card if current month, after its events are loaded
    if (isCurrentMonth) {
      const todayCard = dayCards.find(
        (card) => parseInt(card.getAttribute("data-day")) === todayDate
      );
      if (todayCard) {
        setTimeout(() => {
          todayCard.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        }, 300); // Small delay to allow rendering
      }
    }

    // 4. For remaining cards, set up click-to-load behavior
    const remainingCards = dayCards.filter(
      (card) => !daysToPrioritize.includes(card)
    );

    remainingCards.forEach((dayCard) => {
      // Ensure existing loading spinner is removed and replaced with "Click to Load"
      const eventSummary = dayCard.querySelector(".event-summary");
      dayCard.classList.remove("loading"); // Remove initial loading state
      dayCard.classList.remove("skeleton"); // Remove skeleton class as it's now interactive
      eventSummary.textContent = "Click to load";
      dayCard.classList.add("needs-load"); // Add a class for styling/identification

      // Add a single event listener for lazy loading
      if (!dayCard._hasClickListener) {
        dayCard.addEventListener("click", async () => {
          if (dayCard.classList.contains("needs-load")) {
            await loadDayEvents(dayCard, month, true); // Force load
            dayCard.classList.remove("needs-load");
          }
          // After loading, show event details
          showEventDetails(
            parseInt(dayCard.getAttribute("data-day")),
            month + 1,
            currentDate.getFullYear(),
            dayCard.eventsData
          );
        });
        dayCard._hasClickListener = true;
      }
    });

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

// --- CATEGORY DEFINITIONS FOR KEYWORD MATCHING ---
const eventCategories = {
  "War & Conflict": [
    "war",
    "battle",
    "conflict",
    "siege",
    "attack",
    "invasion",
    "armistice",
    "treaty",
    "military",
    "forces",
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
    "peace treaty",
    "declaration of war",
    "skirmish",
    "campaign",
    "guerilla",
    "front",
    "combat",
    "offensive",
    "surrender",
    "ceasefire",
    "annexation",
    "occupation",
    "insurrection",
    "bloodshed",
    "massacre",
    "coup d'état",
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
    "extremism",
    "riot",
  ],
  "Politics & Government": [
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
    "treaty",
    "ambassador",
    "summit",
    "federation",
    "union",
    "state",
    "nation",
    "party",
    "cabinet",
    "ministry",
    "parliamentary",
    "legislature",
    "policy",
    "proclamation",
    "edict",
    "administration",
    "jurisdiction",
    "sovereignty",
    "referendum",
    "bill",
    "veto",
    "democracy",
    "autocracy",
    "dictatorship",
    "coup plot",
  ],
  "Science & Technology": [
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
    "machine",
    "device",
    "research",
    "experiment",
    "patent",
    "launch",
    "satellite",
    "telecom",
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
    "cosmology",
    "explorer",
    "telescope",
    "microscope",
    "nuclear",
    "reactor",
    "power plant",
    "digital",
    "network",
    "cybernetics",
    "data",
    "chip",
  ],
  "Arts & Culture": [
    "art",
    "music",
    "film",
    "literature",
    "theater",
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
    "award",
    "cultural",
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
    "library",
    "masterpiece",
    "genre",
    "album",
    "song",
    "director",
    "actor",
    "actress",
    "exhibit",
    "performance",
    "academy",
    "pulitzer",
    "grammy",
    "oscar",
    "tony",
    "emmy",
    "cannes",
    "venice",
    "berlin",
    "folklore",
    "tradition",
    "heritage",
    "craft",
    "poetry",
    "prose",
  ],
  "Disasters & Accidents": [
    "earthquake",
    "flood",
    "hurricane",
    "tornado",
    "volcano",
    "tsunami",
    "epidemic",
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
    "calamity",
    "tragedy",
    "catastrophe",
    "derailment",
    "wreck",
    "shipwreck",
    "landslide",
    "mudslide",
    "avalanche",
    "heatwave",
    "cold wave",
    "cyclone",
    "typhoon",
    "wildfire",
    "oil spill",
    "nuclear accident",
    "meltdown",
    "toxic leak",
    "pollution",
    "contagion",
    "plague",
    "pandemic",
    "illness",
    "disease",
    "natural disaster",
  ],
  Sports: [
    "olympic",
    "games",
    "championship",
    "sport",
    "tournament",
    "team",
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
    "track and field",
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
    "umpire",
    "referee",
    "race",
    "motor racing",
    "equestrian",
    "gymnastics",
    "wrestling",
    "judo",
    "karate",
    "fencing",
    "sailing",
    "rowing",
    "diving",
    "surfing",
    "skateboarding",
    "snowboarding",
    "badminton",
    "table tennis",
    "handball",
    "polo",
    "pentathlon",
    "decathlon",
    "triathlon",
    "winter olympics",
    "summer olympics",
    "commonwealth games",
    "asian games",
    "african games",
    "pan american games",
  ],
  "Social & Human Rights": [
    "slavery",
    "rights",
    "protest",
    "movement",
    "discrimination",
    "equality",
    "justice",
    "reform",
    "activist",
    "civil",
    "emancipation",
    "suffrage",
    "demonstration",
    "strike",
    "boycott",
    "freedom",
    "liberty",
    "charter",
    "declaration",
    "humanitarian",
    "charity",
    "social",
    "welfare",
    "education reform",
    "prison reform",
    "labor rights",
    "womens rights",
    "civil rights",
    "LGBTQ+",
    "minority rights",
    "indigenous rights",
    "refugee",
    "migration",
    "community",
    "poverty",
    "housing",
    "healthcare",
    "public health",
    "education",
    "literacy",
    "gender",
    "race relations",
    "class struggle",
    "social change",
    "activism",
    "advocacy",
  ],
  "Economy & Business": [
    "bank",
    "stock market",
    "company",
    "trade",
    "economy",
    "financial",
    "industry",
    "currency",
    "crisis",
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
    "trust",
    "union",
    "labor",
    "manufacturing",
    "agriculture",
    "mining",
    "transport",
    "shipping",
    "railway",
    "airline",
    "dot-com",
    "boom",
    "bust",
    "entrepreneur",
    "startup",
    "venture",
    "globalization",
    "free trade",
    "protectionism",
    "commodity",
    "export",
    "import",
    "retail",
    "wholesale",
    "consumer",
    "production",
    "distribution",
    "logistics",
  ],
  // Categories derived from 'type' property or keywords
  "Famous Persons": [
    "author",
    "artist",
    "scientist",
    "composer",
    "king",
    "queen",
    "president",
    "emperor",
    "pope",
    "philosopher",
    "physicist",
    "mathematician",
    "writer",
    "poet",
    "singer",
    "musician",
    "painter",
    "sculptor",
    "architect",
    "inventor",
    "explorer",
    "general",
    "statesman",
    "revolutionary",
    "activist",
    "athlete",
    "actor",
    "director",
    "producer",
    "comedian",
    "humanitarian",
    "scholar",
    "economist",
    "historian",
    "monarch",
    "ruler",
    "politician",
    "diplomat",
    "astronaut",
    "engineer",
    "biologist",
    "chemist",
    "astronomer",
    "novelist",
    "playwright",
    "lyricist",
    "choreographer",
    "dancer",
    "photographer",
    "fashion designer",
    "chef",
    "broadcaster",
    "journalist",
    "explorer",
    "pioneer",
    "visionary",
  ],
};

// Helper Function to Categorize an Item (based on type AND text)
function assignCategories(item) {
  const categoriesFound = new Set();

  // 1. Categorize based on explicit 'type' property from worker/API
  if (item.type === "birth") {
    categoriesFound.add("Births");
    categoriesFound.add("Famous Persons"); // Births are often famous persons
  } else if (item.type === "death") {
    categoriesFound.add("Deaths");
    categoriesFound.add("Famous Persons"); // Deaths are often famous persons
  }

  // 2. Categorize based on keywords in description (for general events and more specific famous persons)
  const itemText = item.description || item.title || "";
  const lowerText = itemText.toLowerCase();

  for (const category in eventCategories) {
    for (const keyword of eventCategories[category]) {
      if (lowerText.includes(keyword)) {
        categoriesFound.add(category);
        break; // Move to next category once a keyword is found for a given category
      }
    }
  }

  // Add a 'Miscellaneous' category if no other specific category was found
  if (categoriesFound.size === 0) {
    categoriesFound.add("Miscellaneous");
  }

  return Array.from(categoriesFound);
}

// Function to Render Items in the Modal
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

// Function to Apply the Filter
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

// showEventDetails function to include filtering and process structured data
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
                <h5 class="modal-title" id="eventModalLabel">${day}. ${
      monthNames[month - 1]
    }</h5>
                <hr>
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
