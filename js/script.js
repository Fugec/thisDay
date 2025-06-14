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
  "Januar",
  "Februar",
  "Mart",
  "April",
  "Maj",
  "Juni",
  "Juli",
  "August",
  "Septembar",
  "Oktobar",
  "Novembar",
  "Decembar",
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
        "User-Agent": "HistorijskiKalendarBiH/1.0 (your-email@example.com)", // IMPORTANT: Replace with YOUR contact email
      },
    });

    if (!response.ok) {
      console.error(
        `Error fetching data from Wikipedia (${lang}): ${response.status} ${response.statusText}`
      );
      if (lang === "en" && response.status === 404) {
        // If English fails, try Bosnian
        console.log("No data for English Wikipedia, trying Bosnian.");
        const fallbackEvents = await fetchWikipediaEvents(month, day, "bs");
        eventCache[cacheKey] = fallbackEvents;
        return fallbackEvents;
      }
      return [];
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
          lang: lang,
        });
      });
    }
    eventCache[cacheKey] = events;
    return events;
  } catch (error) {
    console.error("Network or parsing error:", error);
    return [];
  }
}
// --- End API Integration ---

async function populateCarousel(month, year) {
  // Clear existing carousel items and indicators
  carouselInner.innerHTML = "";
  carouselIndicators.innerHTML = "";

  // Fetch events for the first day of the month for the carousel from English Wikipedia
  const eventsForDayOne = await fetchWikipediaEvents(month + 1, 1, "en");

  // Filter for events with images and limit to max 5
  const featuredEvents = eventsForDayOne
    .filter(
      (event) =>
        event.sourceUrl &&
        event.sourceUrl.includes("wikipedia.org") &&
        event.thumbnailUrl &&
        event.thumbnailUrl !== ""
    )
    .slice(0, 10); // Limit to 5 articles

  if (featuredEvents.length === 0) {
    // If no featured events, show a default placeholder with no text
    const defaultItem = document.createElement("div");
    defaultItem.className = "carousel-item active";
    defaultItem.innerHTML = `
            <img src="https://placehold.co/1200x350/0056b3/ffffff?text=Nema+dostupnih+slika" class="d-block w-100" alt="No images available">
            <div class="carousel-caption">
                <h5>Nema istaknutih događaja</h5>
                <a href="#" class="btn btn-primary btn-sm disabled">Više detalja</a>
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
    const fallbackImageUrl = `https://placehold.co/1200x350/0056b3/ffffff?text=Slika`; // Simplified fallback text

    // Limit title to 20 words
    const titleWords = (event.title || "Historijski Događaj").split(" ");
    const truncatedTitle = titleWords.slice(0, 20).join(" ");

    carouselItem.innerHTML = `
            <img src="${imageUrl}" class="d-block w-100" alt="${truncatedTitle}" onerror="this.onerror=null;this.src='${fallbackImageUrl}';">
            <div class="carousel-caption">
                <h5>${truncatedTitle}</h5>
                <a href="${event.sourceUrl}" class="btn btn-primary btn-sm" target="_blank" rel="noopener noreferrer">Više detalja</a>
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
  calendarGrid.innerHTML = "";
  loadingIndicator.style.display = "block";

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  currentMonthYearDisplay.textContent = `${monthNamesBs[month]} ${year}`;

  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const fetchPromises = [];
  for (let i = 1; i <= daysInMonth; i++) {
    fetchPromises.push(fetchWikipediaEvents(month + 1, i, "en")); // Fetch for English first
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

    const eventsForDay = allEventsForMonth[i - 1];
    if (eventsForDay && eventsForDay.length > 0) {
      // Display the count of events
      eventSummary.textContent = `${eventsForDay.length} događaja`;
    } else {
      eventSummary.textContent = "Nema događaja";
    }
    dayCard.appendChild(eventSummary);

    dayCard.addEventListener("click", () => {
      showEventDetails(i, month + 1, year, eventsForDay);
    });

    calendarGrid.appendChild(dayCard);
  }

  // Populate the carousel after rendering the calendar
  await populateCarousel(month, year);
}

async function showEventDetails(day, month, year, preFetchedEvents = null) {
  modalDate.textContent = `${day}. ${monthNamesBs[month - 1]} ${year}.`;
  modalBodyContent.innerHTML = "<p>Učitavanje događaja...</p>";

  let events =
    preFetchedEvents || (await fetchWikipediaEvents(month, day, "en")); // Fetch for English first

  modalBodyContent.innerHTML = "";

  if (events && events.length > 0) {
    const ul = document.createElement("ul");
    events.forEach((event) => {
      const li = document.createElement("li");
      let eventText = event.description;
      if (event.lang === "bs") {
        // Indicate if it came from Bosnian Wikipedia
        eventText += " (Prevedeno sa bosanskog)";
      }
      li.innerHTML = `<strong>${event.year}.</strong> ${eventText}`;
      if (event.sourceUrl) {
        const sourceLink = document.createElement("a");
        sourceLink.href = event.sourceUrl;
        sourceLink.textContent = " (Izvor: Wikipedia)";
        sourceLink.target = "_blank";
        sourceLink.rel = "noopener noreferrer";
        li.appendChild(sourceLink);
      }
      ul.appendChild(li);
    });
    modalBodyContent.appendChild(ul);
  } else {
    modalBodyContent.innerHTML =
      "<p>Za ovaj datum nisu pronađeni događaji na engleskoj niti bosanskoj Wikipediji.</p>";
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
