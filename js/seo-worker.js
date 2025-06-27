// This Cloudflare Worker dynamically injects SEO-friendly meta tags
// to improve the user experience on site.

// --- Configuration Constants ---
// Define a User-Agent for API requests to Wikipedia.
const WIKIPEDIA_USER_AGENT = "thisDay.info (kapetanovic.armin@gmail.com)";

// --- Cache for API Responses
const WORKER_CACHE_NAME = "wikipedia-api-cache-v1";
const CACHE_TTL_SECONDS = 24 * 60 * 60; // Cache API responses for 24 hours in the Worker

// --- Helper function to fetch daily events from Wikipedia API ---
async function fetchDailyEvents(date) {
  const month = date.getMonth() + 1; // getMonth() is 0-indexed
  const day = date.getDate();
  const apiUrl = `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events/${month}/${day}`;

  const cache = caches.default; // Access Cloudflare's default Cache API

  // Try to get from cache first
  let response = await cache.match(apiUrl);
  if (response) {
    console.log("Worker Cache HIT for Wikipedia API:", apiUrl);
    return response.json(); // Return parsed JSON directly
  }

  // If not in cache, fetch from Wikipedia API
  console.log("Worker Cache MISS, fetching from Wikipedia API:", apiUrl);
  try {
    const fetchResponse = await fetch(apiUrl, {
      headers: {
        "User-Agent": WIKIPEDIA_USER_AGENT,
      },
    });

    if (!fetchResponse.ok) {
      console.error(
        `Wikipedia API error: ${fetchResponse.status} - ${fetchResponse.statusText}`
      );
      // Important: Clone the response before putting it in cache or consuming it
      // because a Response body can only be read once.
      const errorResponse = fetchResponse.clone();
      const errorBody = await errorResponse.text();
      console.error("Wikipedia API Error Body:", errorBody);
      return null; // Return null on API error
    }

    // Cache the successful response before returning.
    // It's crucial to clone the response as its body can only be read once.
    const responseToCache = fetchResponse.clone();
    await cache.put(apiUrl, responseToCache);
    console.log("Worker Cache PUT for Wikipedia API:", apiUrl);

    return fetchResponse.json(); // Return parsed JSON
  } catch (error) {
    console.error("Error fetching Wikipedia events in Worker:", error);
    return null; // Return null on network/fetch error
  }
}

// --- Main Worker Request Handler ---
async function handleRequest(request) {
  const url = new URL(request.url);

  // Only process requests for the root path (index.html)
  if (url.pathname !== "/" && url.pathname !== "/index.html") {
    return fetch(request); // For other assets (CSS, JS, images), just pass them through
  }

  // --- Determine the Date for Content ---
  // For this implementation, we're fetching events for the current day.

  const today = new Date();
  const eventsData = await fetchDailyEvents(today); // This now returns the full data object

  // --- Prepare Dynamic Meta Content ---
  let dynamicDescription =
    "Explore historical events, milestones, and notable figures from any date. Discover what happened on this day in history, featuring daily highlights.";
  let dynamicKeywords =
    "thisDay, historical events, on this day, history, daily highlights, calendar, famous birthdays, anniversaries, notable deaths, world history, today in history, educational, timeline, trivia, historical figures";
  let dynamicTitle =
    "thisDay. | What Happened on This Day? | Historical Events";
  let ogImageUrl = "https://thisday.info/images/default-social-share.jpg"; // Default social share image
  let ogUrl = url.href; // Canonical URL for social sharing

  const formattedDate = today.toLocaleString("en-US", {
    month: "long",
    day: "numeric",
  });

  // Check if eventsData and its 'events' array exist and is not empty
  if (eventsData && eventsData.events && eventsData.events.length > 0) {
    const events = eventsData.events;
    // Take the first few significant events for a concise description
    const topEvents = events
      .slice(0, 3)
      .map((e) => e.text)
      .join("; ");
    dynamicDescription = `On ${formattedDate}, discover events like: ${topEvents}. Explore more historical milestones on thisDay.info.`;
    dynamicTitle = `On This Day, ${formattedDate} | Historical Events & Facts | thisDay.`;
  }

  // --- Fetch Original index.html from Origin ---
  // It's crucial to fetch the base HTML from the origin server.
  const originalResponse = await fetch(request);

  // Ensure the response is HTML and successful before attempting to modify.
  const contentType = originalResponse.headers.get("Content-Type");
  if (
    !originalResponse.ok ||
    !contentType ||
    !contentType.includes("text/html")
  ) {
    return originalResponse; // Pass through non-HTML or error responses without modification
  }

  // --- Modify HTML using HTMLRewriter ---
  // HTMLRewriter allows to stream and transform HTML responses efficiently.
  const rewriter = new HTMLRewriter()
    // Update the <title> tag
    .on("title", {
      element(element) {
        element.setInnerContent(dynamicTitle);
      },
    })
    // Update standard meta description
    .on("meta[name='description']", {
      element(element) {
        element.setAttribute("content", dynamicDescription);
      },
    })
    // Update standard meta keywords
    .on("meta[name='keywords']", {
      element(element) {
        element.setAttribute("content", dynamicKeywords);
      },
    })
    // --- Open Graph (og:) Tags for Social Media ---
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
        element.setAttribute("content", "website"); // Usually "website" for general sites
      },
    })
    // --- Twitter Card Tags ---
    .on("meta[name='twitter:card']", {
      element(element) {
        element.setAttribute("content", "summary_large_image"); // Or "summary"
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
    });

  // Return the modified response. HTMLRewriter automatically handles streaming the transformation.
  return rewriter.transform(originalResponse);
}

// --- Worker Entry Point ---
// This is the standard entry point for all Cloudflare Workers.
addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});
