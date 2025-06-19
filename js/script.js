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

let currentDate = new Date(); // Start with current date

// Enhanced cache for storing fetched events with expiration
const eventCache = new Map();
const CACHE_EXPIRY_TIME = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// English month names
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

// Schema.org metadata for search engine optimization
const script = document.createElement("script");
script.type = "application/ld+json";
script.innerHTML = `
{
  "@context": "https://schema.org",
  "@type": "WebApplication",
  "name": "thisDay.",
  "description": "Explore significant historical events that occurred on any given day throughout history with On This Day's interactive calendar and daily highlights.",
  "url": "https://thisday.info/",
  "author": {
    "@type": "Person",
    "name": "Armin Kapetanović",
  },
  "image": "https://thisday.info/images/logo.png"
}
`;

document.head.appendChild(script);
// Rate limiting variables
let requestCount = 0;
const MAX_REQUESTS_PER_SECOND = 10;
const RATE_LIMIT_WINDOW = 1000; // 1 second

// Reset request counter every second
setInterval(() => {
  requestCount = 0;
}, RATE_LIMIT_WINDOW);

// Enhanced rate-limited fetch with retry logic
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
          "User-Agent":
            "What Happened on This Day Calendar/1.0 (kapetanovic.armin@gmail.com)",
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
async function fetchWikipediaEvents(month, day) {
  const cacheKey = `${month}-${day}-en`;

  // Check cache with expiration
  if (eventCache.has(cacheKey)) {
    const cached = eventCache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_EXPIRY_TIME) {
      return cached.data;
    } else {
      eventCache.delete(cacheKey); // Remove expired cache
    }
  }

  const monthPadded = String(month).padStart(2, "0");
  const dayPadded = String(day).padStart(2, "0");
  const url = `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events/${monthPadded}/${dayPadded}`;

  try {
    const response = await rateLimitedFetch(url);

    if (!response.ok) {
      console.warn(
        `No data for English Wikipedia for ${month}/${day} (Status: ${response.status})`
      );
      // Cache empty result to avoid repeated failed requests
      eventCache.set(cacheKey, { data: [], timestamp: Date.now() });
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
    return events;
  } catch (error) {
    console.error(`Error fetching events for ${month}/${day}:`, error);
    // Return empty array but don't cache errors to allow retries
    return [];
  }
}

// Optimized carousel population with better error handling
async function populateCarousel(month, year) {
  carouselInner.innerHTML = "";
  carouselIndicators.innerHTML = "";

  try {
    // Try multiple days to find events with images
    const daysToTry = [];
    for (let i = 1; i <= 31; i++) {
      daysToTry.push(i);
    } // Shuffle days to randomize the selection
    daysToTry.sort(() => Math.random() - 0.5);
    let featuredEvents = [];

    for (const day of daysToTry) {
      if (featuredEvents.length >= 12) break;

      const eventsForDay = await fetchWikipediaEvents(month + 1, day);
      const eventsWithImages = eventsForDay.filter(
        (event) =>
          event.sourceUrl &&
          event.sourceUrl.includes("wikipedia.org") &&
          event.thumbnailUrl &&
          event.thumbnailUrl !== ""
      );

      featuredEvents = [...featuredEvents, ...eventsWithImages];
    }

    // Remove duplicates and limit to 10
    const uniqueEvents = featuredEvents
      .filter(
        (event, index, self) =>
          index === self.findIndex((e) => e.sourceUrl === event.sourceUrl)
      )
      .slice(0, 12);

    if (uniqueEvents.length === 0) {
      // Default placeholder
      const defaultItem = document.createElement("div");
      defaultItem.className = "carousel-item active";
      defaultItem.innerHTML = `
        <img src="https://placehold.co/1200x350/6c757d/ffffff?text=No+Featured+Images+Available" 
             class="d-block w-100" alt="No images available">
        <div class="carousel-caption">
          <h5>Discover History Daily</h5>
          <p>No specific featured image for this day, but explore the calendar for more events!</p>
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

      const titleWords = (event.title || "Historical Event on This Day").split(
        " "
      );
      const truncatedTitle = titleWords.slice(0, 20).join(" ");

      carouselItem.innerHTML = `
        <img src="${imageUrl}" class="d-block w-100" alt="${truncatedTitle}"
          onerror="this.onerror=null;this.src='${fallbackImageUrl}';" loading="lazy">
        <div class="carousel-caption">
          <h5>${truncatedTitle}</h5>
          <a href="${event.sourceUrl}" class="btn btn-primary btn-sm" 
             target="_blank" rel="noopener noreferrer">More Details</a>
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
    errorItem.innerHTML = `
      <img src="https://placehold.co/1200x350/dc3545/ffffff?text=Error+Loading+Images" 
           class="d-block w-100" alt="Error loading">
      <div class="carousel-caption">
        <h5>Unable to Load Featured Content</h5>
        <p>Please check your internet connection and try again.</p>
      </div>
    `;
    carouselInner.appendChild(errorItem);
  }
}

// Optimized calendar rendering with concurrent requests and progressive loading
async function renderCalendar() {
  calendarGrid.innerHTML = "";
  loadingIndicator.style.display = "block";

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  currentMonthYearDisplay.textContent = `${monthNames[month]}`;
  document.title = `What Happened on This Day | ${monthNames[month]} Historical Events`;

  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Create calendar grid structure first (progressive loading)
  const dayCards = [];
  for (let i = 1; i <= daysInMonth; i++) {
    const dayCard = document.createElement("div");
    dayCard.className = "day-card loading";
    dayCard.setAttribute("data-day", i);
    dayCard.setAttribute("data-month", month + 1);

    const dayNumber = document.createElement("div");
    dayNumber.className = "day-number";
    dayNumber.textContent = i;
    dayCard.appendChild(dayNumber);

    const eventSummary = document.createElement("div");
    eventSummary.className = "event-summary";
    eventSummary.innerHTML =
      '<div class="spinner-border spinner-border-sm" role="status"></div>';
    dayCard.appendChild(eventSummary);

    calendarGrid.appendChild(dayCard);
    dayCards.push(dayCard);
  }

  // Load events with controlled concurrency
  const BATCH_SIZE = 5; // Process 5 days at a time
  const batches = [];
  for (let i = 0; i < daysInMonth; i += BATCH_SIZE) {
    batches.push(dayCards.slice(i, i + BATCH_SIZE));
  }

  try {
    for (const batch of batches) {
      // Process batch concurrently
      const batchPromises = batch.map(async (dayCard) => {
        const day = parseInt(dayCard.getAttribute("data-day"));
        try {
          const events = await fetchWikipediaEvents(month + 1, day);

          // Update UI
          const eventSummary = dayCard.querySelector(".event-summary");
          dayCard.classList.remove("loading");

          if (events && events.length > 0) {
            eventSummary.textContent = `${events.length} Events`;
            dayCard.eventsData = events;
          } else {
            eventSummary.textContent = "No Events";
            dayCard.classList.add("no-events");
            dayCard.eventsData = [];
          }

          dayCard.addEventListener("click", () => {
            showEventDetails(day, month + 1, year, dayCard.eventsData);
          });
        } catch (error) {
          console.error(`Error loading events for day ${day}:`, error);
          const eventSummary = dayCard.querySelector(".event-summary");
          eventSummary.textContent = "Error";
          dayCard.classList.remove("loading");
          dayCard.classList.add("error");
        }
      });

      // Wait for current batch to complete before processing next
      await Promise.allSettled(batchPromises);

      // Small delay between batches to avoid overwhelming the API
      if (batches.indexOf(batch) < batches.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  } catch (error) {
    console.error("Error during calendar rendering:", error);
  } finally {
    loadingIndicator.style.display = "none";
  }

  // Load carousel after calendar is populated
  await populateCarousel(month, year);
}

// Enhanced event details
async function showEventDetails(day, month, year, preFetchedEvents = null) {
  modalDate.textContent = `${day}. ${monthNames[month - 1]}`;
  modalBodyContent.innerHTML =
    "<div class='text-center'><div class='spinner-border' role='status'></div><p>Loading events...</p></div>";

  let events = preFetchedEvents;

  try {
    // If no pre-fetched events, fetch new ones
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
                <a href="${event.sourceUrl}" class="btn btn-sm btn-outline-primary" 
                   target="_blank" rel="noopener noreferrer">
                  Read more on Wikipedia
                </a>
              `
                  : ""
              }
            </div>
            ${
              event.thumbnailUrl
                ? `
              <img src="${event.thumbnailUrl}" class="ms-3 rounded" 
                   style="width: 60px; height: 60px; object-fit: cover;" 
                   alt="Event thumbnail" onerror="this.style.display='none'">
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
        <div class="alert alert-warning">
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
      <div class="alert alert-danger">
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

// Initialize application
document.addEventListener("DOMContentLoaded", async () => {
  try {
    const savedTheme = localStorage.getItem("theme") || "light";
    setTheme(savedTheme);

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

// Set current year in footer
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

  keysToDelete.forEach((key) => eventCache.delete(key));
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
