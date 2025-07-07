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

// Enhanced Wikipedia API function with better error handling and caching - CORS FIX
async function fetchWikipediaEvents(month, day) {
  const cacheKey = `${month}-${day}-en`;

  // Check cache with expiration
  if (eventCache.has(cacheKey)) {
    const cached = eventCache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_EXPIRY_TIME) {
      return cached.data;
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
      return []; // Return empty if offline and no cache
    }

    if (!response.ok) {
      console.warn(
        `No data for English Wikipedia for ${month}/${day} (Status: ${response.status})`
      );
      // Cache empty result to avoid repeated failed requests
      eventCache.set(cacheKey, { data: [], timestamp: Date.now() });
      saveCacheToLocalStorage(eventCache); // Update localStorage
      return [];
    }

    const data = await response.json();
    const events = [];

    if (data && data.events && Array.isArray(data.events)) {
      // Process all events
      data.events.forEach((event) => {
        if (!event || !event.text) return; // Skip invalid events

        let description = event.text;
        let year = event.year || "Unknown";
        let wikipediaLink = "";
        let thumbnailUrl = "";

        if (
          event.pages &&
          Array.isArray(event.pages) &&
          event.pages.length > 0
        ) {
          const page = event.pages[0];
          if (page.content_urls && page.content_urls.desktop) {
            wikipediaLink = page.content_urls.desktop.page;
          }
          if (page.thumbnail && page.thumbnail.source) {
            thumbnailUrl = page.thumbnail.source;
          }
        }

        events.push({
          title: description.split(".")[0] + ".",
          description: description,
          year: year,
          sourceUrl: wikipediaLink,
          thumbnailUrl: thumbnailUrl,
        });
      });
    }

    // Cache the result with timestamp
    eventCache.set(cacheKey, { data: events, timestamp: Date.now() });
    saveCacheToLocalStorage(eventCache); // Update localStorage
    return events;
  } catch (error) {
    console.error(`Error fetching events for ${month}/${day}:`, error);
    // Return empty array but don't cache errors to allow retries
    return [];
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
    const eventsForToday = await fetchWikipediaEvents(
      currentMonth + 1,
      currentDay
    );

    const eventsWithImages = eventsForToday.filter(
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
                 ? `${event.title.substring(0, 10)}...`
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
    const events = await fetchWikipediaEvents(month + 1, day);

    // Update UI
    dayCard.classList.remove("loading");
    dayCard.classList.add("loaded"); // Mark as loaded

    if (events && events.length > 0) {
      eventSummary.textContent = `${events.length} Events`;
      dayCard.eventsData = events; // Store events directly on the card
      dayCard.classList.remove("no-events");
      dayCard.classList.remove("skeleton"); // Remove skeleton class
    } else {
      eventSummary.textContent = "No Events";
      dayCard.classList.add("no-events");
      dayCard.eventsData = [];
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
          dayCard.eventsData // Pass pre-fetched data
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

// Enhanced event details
async function showEventDetails(day, month, year, preFetchedEvents = null) {
  modalDate.textContent = `${day}. ${monthNames[month - 1]}`;
  modalBodyContent.innerHTML =
    "<div class='text-center'><div class='spinner-border' role='status'></div><p>Loading events...</p></div>";

  let events = preFetchedEvents;

  try {
    // If no pre-fetched events, fetch new ones (this will check cache first)
    // This path is primarily for "Click to load" days or if preFetchedEvents was null/empty
    if (!events || events.length === 0) {
      events = await fetchWikipediaEvents(month, day);
    }

    modalBodyContent.innerHTML = "";

    if (events && events.length > 0) {
      // Sort events by year
      events.sort((a, b) => {
        const yearA = parseInt(a.year) || 0;
        const yearB = parseInt(b.year) || 0;
        return yearA - yearB;
      });

      const ul = document.createElement("ul");
      ul.className = "list-unstyled";

      events.forEach((event) => {
        const li = document.createElement("li");
        li.className = "mb-3 p-3 border rounded";

        let eventText =
          event.description || event.title || "No description available";

        li.innerHTML = `
          <div class="d-flex justify-content-between align-items-start">
            <div class="flex-grow-1">
              <strong class="text-primary">${event.year}</strong>
              <p class="mb-1">${eventText}</p>
              ${
                event.sourceUrl
                  ? `
                <a href="${
                  event.sourceUrl
                }" class="btn btn-sm btn-outline-primary"
                   target="_blank" rel="noopener noreferrer">
                  Read More About ${
                    event.title.length > 50
                      ? `${event.title.substring(0, 10)}...`
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
        `;
        ul.appendChild(li);
      });

      modalBodyContent.appendChild(ul);
    } else {
      modalBodyContent.innerHTML = `
        <div class="alert alert-warning" role="alert">
          <h5><i class="bi bi-exclamation-triangle"></i> No Events Found</h5>
          <p>No events found for this day on Wikipedia.</p>
          <p class="mb-0 text-muted">Historical data depends on available records.
             Try checking Wikipedia directly for more comprehensive information.</p>
        </div>
      `;
    }
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
