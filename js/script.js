const calendarGrid = document.getElementById("calendarGrid");
const currentMonthYearDisplay = document.getElementById("currentMonthYear");
const modalDate = document.getElementById("modalDate");
const modalBodyContent = document.getElementById("modalBodyContent");
const eventDetailModal = new bootstrap.Modal(
  document.getElementById("eventDetailModal")
);
const loadingIndicator = document.getElementById("loadingIndicator");

// New elements for carousel
const carouselInner = document.getElementById("carouselInner");
const carouselIndicators = document.getElementById("carouselIndicators");

// New theme toggle elements (checkboxes)
const themeSwitchMobile = document.getElementById("themeSwitchMobile");
const themeSwitchDesktop = document.getElementById("themeSwitchDesktop");
const body = document.body;

let currentDate = new Date(); // Start with current date
const monthNamesBs = [
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

// Cache for storing fetched events to avoid redundant API calls
const eventCache = {}; // Key: "month-day-lang", Value: array of events

// --- API Integration with Wikimedia REST API ---
async function fetchWikipediaEvents(month, day, lang = "en") {
  // Default to 'en'
  const cacheKey = `${month}-${day}-${lang}`;
  if (eventCache[cacheKey]) {
    return eventCache[cacheKey]; // Return from cache if available
  }

  const monthPadded = String(month).padStart(2, "0");
  const dayPadded = String(day).padStart(2, "0");
  const url = `https://api.wikimedia.org/feed/v1/wikipedia/${lang}/onthisday/events/${monthPadded}/${dayPadded}`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "HappenedCalendar/1.0 (info@happened.io)", // IMPORTANT: Replace with YOUR contact email
      },
    });

    if (!response.ok) {
      console.warn(
        `No data for ${lang.toUpperCase()} Wikipedia for ${month}/${day} (Status: ${
          response.status
        } ${response.statusText}).`
      );
      return []; // Return empty array if no data or error for this language
    }

    const data = await response.json();
    const events = [];

    if (data && data.events) {
      data.events.forEach((event) => {
        let description = event.text;
        let year = event.year;
        let wikipediaLink = "";
        let thumbnailUrl = "";

        if (event.pages && event.pages.length > 0) {
          wikipediaLink = event.pages[0].content_urls.desktop.page;
          if (event.pages[0].thumbnail && event.pages[0].thumbnail.source) {
            thumbnailUrl = event.pages[0].thumbnail.source;
          }
        }

        events.push({
          title: description.split(".")[0] + ".",
          description: description,
          year: year,
          sourceUrl: wikipediaLink,
          thumbnailUrl: thumbnailUrl,
          lang: lang, // Store the language this event was fetched from
        });
      });
    }
    eventCache[cacheKey] = events;
    return events;
  } catch (error) {
    console.error(
      `Network or parsing error for ${lang} (${month}/${day}):`,
      error
    );
    return [];
  }
}
// --- End API Integration ---

async function populateCarousel(month, year) {
  // Clear existing carousel items and indicators
  carouselInner.innerHTML = "";
  carouselIndicators.innerHTML = "";

  // Fetch events for the first day of the month for the carousel from English Wikipedia
  // Using a specific day like 15th to potentially get more varied content if 1st is often empty
  const eventsForCarouselDay = await fetchWikipediaEvents(month + 1, 15, "en");

  // Filter for events with images and limit to max 10
  const featuredEvents = eventsForCarouselDay
    .filter(
      (event) =>
        event.sourceUrl &&
        event.sourceUrl.includes("wikipedia.org") &&
        event.thumbnailUrl &&
        event.thumbnailUrl !== ""
    )
    .slice(0, 10); // Limit to 10 articles for more variety

  if (featuredEvents.length === 0) {
    // If no featured events, show a default placeholder with no text
    const defaultItem = document.createElement("div");
    defaultItem.className = "carousel-item active";
    // Improved placeholder for no image available
    defaultItem.innerHTML = `
            <img src="https://placehold.co/1200x350/6c757d/ffffff?text=No+Featured+Images+Available" class="d-block w-100" alt="No images available">
            <div class="carousel-caption">
                <h5>Discover History Daily</h5>
                <p>No specific featured image for this day, but explore the calendar for more events!</p>
                <a href="#calendarGrid" class="btn btn-primary btn-sm">Explore Calendar</a>
            </div>
        `;
    carouselInner.appendChild(defaultItem);
    return; // Exit if no events to display
  }

  featuredEvents.forEach((event, index) => {
    // Create carousel item
    const carouselItem = document.createElement("div");
    carouselItem.className = `carousel-item${index === 0 ? " active" : ""}`; // Add active class to first item

    // Set image with onerror fallback
    const imageUrl = event.thumbnailUrl;
    // Fallback image using a more neutral color
    const fallbackImageUrl = `https://placehold.co/1200x350/6c757d/ffffff?text=Image+Not+Available`;

    // Limit title to 20 words for display, and use it as alt text
    const titleWords = (event.title || "Historical Event on This Day").split(
      " "
    );
    const truncatedTitle = titleWords.slice(0, 20).join(" ");

    carouselItem.innerHTML = `
            <img src="${imageUrl}" class="d-block w-100" alt="${truncatedTitle}" onerror="this.onerror=null;this.src='${fallbackImageUrl}';">
            <div class="carousel-caption">
                <h5>${truncatedTitle}</h5>
                <a href="${event.sourceUrl}" class="btn btn-primary btn-sm" target="_blank" rel="noopener noreferrer">More Details</a>
            </div>
        `;
    carouselInner.appendChild(carouselItem);

    // Create carousel indicator
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

  // Re-initialize the carousel to ensure it picks up new items
  const carouselElement = document.getElementById("historicalCarousel");
  const bsCarousel = bootstrap.Carousel.getInstance(carouselElement);
  if (bsCarousel) {
    bsCarousel.to(0); // Go to the first slide
    bsCarousel.cycle(); // Start cycling
  } else {
    new bootstrap.Carousel(carouselElement, {
      interval: 7000, // Auto-cycle every 7 seconds
      ride: "carousel",
    });
  }
}

async function renderCalendar() {
  // --- IMPORTANT FIX: Clear existing day cards before rendering new ones ---
  calendarGrid.innerHTML = "";
  // --- END FIX ---

  loadingIndicator.style.display = "block";

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  currentMonthYearDisplay.textContent = `${monthNamesBs[month]} ${year}`; // Display month and year
  document.title = `Happened. | ${monthNamesBs[month]} ${year} Historical Events`; // SEO: Dynamic page title

  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const fetchPromises = [];
  for (let i = 1; i <= daysInMonth; i++) {
    // We only fetch for English for the calendar grid initial display
    // The modal will handle fallbacks if needed.
    fetchPromises.push(fetchWikipediaEvents(month + 1, i, "en"));
  }

  const allEventsForMonth = await Promise.all(fetchPromises);
  loadingIndicator.style.display = "none";

  for (let i = 1; i <= daysInMonth; i++) {
    const dayCard = document.createElement("div");
    dayCard.className = "day-card";
    dayCard.setAttribute("data-day", i);
    dayCard.setAttribute("data-month", month + 1);

    const dayNumber = document.createElement("div");
    dayNumber.className = "day-number";
    dayNumber.textContent = i;
    dayCard.appendChild(dayNumber);

    const eventSummary = document.createElement("div");
    eventSummary.className = "event-summary";

    const eventsForDay = allEventsForMonth[i - 1]; // Use the pre-fetched events
    if (eventsForDay && eventsForDay.length > 0) {
      // Display the count of events
      eventSummary.textContent = `${eventsForDay.length} Events`;
    } else {
      eventSummary.textContent = "No Events";
      dayCard.classList.add("no-events"); // Add class for styling days with no events
    }
    dayCard.appendChild(eventSummary);

    // Store events directly on the element for quick access in modal
    dayCard.eventsData = eventsForDay;

    dayCard.addEventListener("click", () => {
      // Pass stored events, if any, to avoid re-fetching immediately
      showEventDetails(i, month + 1, year, dayCard.eventsData);
    });

    calendarGrid.appendChild(dayCard);
  }

  // Populate the carousel after rendering the calendar
  await populateCarousel(month, year);
}

// Added language fallback logic to showEventDetails
async function showEventDetails(day, month, year, preFetchedEvents = null) {
  modalDate.textContent = `${day}. ${monthNamesBs[month - 1]} ${year}.`;
  modalBodyContent.innerHTML = "<p>Loading...</p>";

  let events = preFetchedEvents;
  let fetchedLang = "en"; // Assume English initially

  // If no pre-fetched events or pre-fetched events are empty, try fetching with fallbacks
  if (!events || events.length === 0) {
    events = await fetchWikipediaEvents(month, day, "en"); // Try English first
    if (!events || events.length === 0) {
      console.log(`No English events for ${month}/${day}, trying German.`);
      events = await fetchWikipediaEvents(month, day, "de"); // Fallback to German
      if (events && events.length > 0) fetchedLang = "de";
    }
    if (!events || events.length === 0) {
      console.log(`No German events for ${month}/${day}, trying French.`);
      events = await fetchWikipediaEvents(month, day, "fr"); // Fallback to French
      if (events && events.length > 0) fetchedLang = "fr";
    }
  } else {
    // If events were pre-fetched, use the language from the first event (if available)
    if (events.length > 0 && events[0].lang) {
      fetchedLang = events[0].lang;
    }
  }

  modalBodyContent.innerHTML = ""; // Clear loading message

  if (events && events.length > 0) {
    const ul = document.createElement("ul");
    events.forEach((event) => {
      const li = document.createElement("li");
      let eventText = event.description;
      let langCode = "en"; // Default for display
      if (event.sourceUrl) {
        const match = event.sourceUrl.match(/wikipedia\.org\/(\w+)\//);
        if (match && match[1]) {
          langCode = match[1];
        }
      }
      // Add year and description. Source link is added separately below for clarity.
      li.innerHTML = `<strong>${event.year}.</strong> ${eventText}`;
      if (event.sourceUrl) {
        const sourceLink = document.createElement("a");
        sourceLink.href = event.sourceUrl;
        // Indicate the language of the Wikipedia source
        sourceLink.textContent = ` (Source: ${langCode.toUpperCase()}.Wikipedia)`;
        sourceLink.target = "_blank";
        sourceLink.rel = "noopener noreferrer"; // Good practice for external links
        li.appendChild(sourceLink);
      }
      ul.appendChild(li);
    });
    modalBodyContent.appendChild(ul);

    // Add a note if events were fetched from a fallback language
    if (fetchedLang !== "en") {
      const langNote = document.createElement("p");
      langNote.className = "text-muted mt-3";
      langNote.textContent = `(Events for this day were found in ${fetchedLang.toUpperCase()} Wikipedia. English events might not be available.)`;
      modalBodyContent.appendChild(langNote);
    }
  } else {
    modalBodyContent.innerHTML = `
        <p>No events found for this day in English, German, or French Wikipedia.</p>
        <p class="text-muted">Historical data is subject to available records on Wikipedia. Try checking Wikipedia directly for more languages or broader historical context.</p>
    `;
  }

  eventDetailModal.show();
}

// Function to set the theme
function setTheme(theme) {
  if (theme === "dark") {
    body.classList.add("dark-theme");
    // Update both switches' checked state
    if (themeSwitchMobile) themeSwitchMobile.checked = true;
    if (themeSwitchDesktop) themeSwitchDesktop.checked = true;

    // Update mobile icon
    if (themeSwitchMobile && themeSwitchMobile.nextElementSibling) {
      themeSwitchMobile.nextElementSibling
        .querySelector("i")
        .classList.remove("bi-moon-fill");
      themeSwitchMobile.nextElementSibling
        .querySelector("i")
        .classList.add("bi-brightness-high-fill");
    }
    // Update desktop label text
    if (themeSwitchDesktop && themeSwitchDesktop.nextElementSibling) {
      themeSwitchDesktop.nextElementSibling.textContent = "Light Mode";
    }
    localStorage.setItem("theme", "dark");
  } else {
    body.classList.remove("dark-theme");
    // Update both switches' checked state
    if (themeSwitchMobile) themeSwitchMobile.checked = false;
    if (themeSwitchDesktop) themeSwitchDesktop.checked = false;

    // Update mobile icon
    if (themeSwitchMobile && themeSwitchMobile.nextElementSibling) {
      themeSwitchMobile.nextElementSibling
        .querySelector("i")
        .classList.remove("bi-brightness-high-fill");
      themeSwitchMobile.nextElementSibling
        .querySelector("i")
        .classList.add("bi-moon-fill");
    }
    // Update desktop label text
    if (themeSwitchDesktop && themeSwitchDesktop.nextElementSibling) {
      themeSwitchDesktop.nextElementSibling.textContent = "Dark Mode";
    }
    localStorage.setItem("theme", "light");
  }
}

// Check for saved theme preference on load
document.addEventListener("DOMContentLoaded", () => {
  const savedTheme = localStorage.getItem("theme") || "light"; // Default to light
  setTheme(savedTheme);
});

// Event listener for the theme toggle switches
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

// --- Other Event Listeners ---
document.getElementById("prevMonthBtn").addEventListener("click", () => {
  currentDate.setMonth(currentDate.getMonth() - 1);
  renderCalendar();
});

document.getElementById("nextMonthBtn").addEventListener("click", () => {
  currentDate.setMonth(currentDate.getMonth() + 1);
  renderCalendar();
});

// Set current year in footer
document.getElementById("currentYear").textContent = new Date().getFullYear();

// Initial render of the calendar and carousel
renderCalendar();

// Google Translate Initialization (Existing - keep if you plan to use it)
function googleTranslateElementInit() {
  new google.translate.TranslateElement(
    {
      pageLanguage: "en", // Set the original language of your page
      layout: google.translate.TranslateElement.InlineLayout.SIMPLE,
    },
    "google_translate_element"
  );
}
