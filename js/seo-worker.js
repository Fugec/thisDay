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
        `Wikipedia API responded with status ${fetchResponse.status} for ${apiUrl}`
      );
      // If the response is not OK, we still need to consume the body to not block
      // subsequent requests in some environments.
      await fetchResponse.text(); // Consume body
      throw new Error(
        `Failed to fetch Wikipedia events: ${fetchResponse.statusText}`
      );
    }

    // Cache the successful response for future requests
    // We clone the response because a response can only be read once.
    const responseToCache = fetchResponse.clone();
    // Use an aggressive cache policy for the worker, matching the client-side
    const cacheOptions = {
      // Set the Cache-Control header for the cached response
      headers: {
        "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`,
      },
    };
    await cache.put(apiUrl, responseToCache);
    console.log("Worker Cache PUT for Wikipedia API:", apiUrl);

    return fetchResponse.json();
  } catch (error) {
    console.error(`Error fetching daily events from Wikipedia API: ${error}`);
    // Return a default structure in case of an error to prevent crashing the page
    return { events: [], births: [], deaths: [], holidays: [], selected: [] };
  }
}

// --- Main Request Handler ---
async function handleRequest(request) {
  const url = new URL(request.url);

  // Only handle requests for the root path or /index.html
  // Pass through all other requests (e.g., for JS, CSS, images) directly to the origin
  if (url.pathname !== "/" && url.pathname !== "/index.html") {
    return fetch(request);
  }

  // Determine the current date in UTC to ensure consistent daily events across timezones
  // For 'onthisday' API, it typically uses the UTC date.
  const today = new Date(); // This will be the server's current date (Cloudflare's edge location)
  // For global "on this day" content, UTC or the server's local time is usually fine.

  // Fetch daily events
  const eventsData = await fetchDailyEvents(today);

  // Prepare dynamic meta tags and content based on fetched data
  let dynamicDescription =
    "Explore historical events, milestones, and notable figures from any date. Dive into history with this interactive calendar.";
  let dynamicKeywords =
    "thisDay, historical events, on this day, history, daily highlights, calendar, famous birthdays, anniversaries, notable deaths, world history, today in history, educational, timeline, trivia, historical figures";
  let dynamicTitle =
    "thisDay. | What Happened on This Day? | Historical Events";
  const ogImageUrl = "https://thisday.info/assets/default-social-share.jpg"; // Default image
  const ogUrl = "https://thisday.info/"; // Canonical URL

  // Format the date for the title and description
  const options = { month: "long", day: "numeric" };
  const formattedDate = today.toLocaleDateString("en-US", options); // e.g., "June 28"

  if (eventsData && eventsData.events && eventsData.events.length > 0) {
    // Pick the top 3-5 events for a concise description
    const topEvents = eventsData.events
      .slice(0, 5)
      .map((event) => `In ${event.year}, ${event.text}`)
      .join("; ");

    dynamicTitle = `On This Day, ${formattedDate}: ${
      eventsData.events[0].year
    }, ${eventsData.events[0].text.substring(0, 70)}... | thisDay.info`;
    dynamicDescription = `Discover what happened on ${formattedDate}: ${topEvents}. Explore historical events, births, and deaths.`;

    // Add relevant keywords from event texts (simple approach)
    const eventKeywords = eventsData.events
      .slice(0, 10)
      .flatMap((event) => event.text.split(" "))
      .filter((word) => word.length > 3 && /^[a-zA-Z]+$/.test(word)) // Basic filter
      .map((word) => word.toLowerCase())
      .filter((value, index, self) => self.indexOf(value) === index) // Unique words
      .slice(0, 20) // Limit to top 20
      .join(", ");
    dynamicKeywords = `${dynamicKeywords}, ${eventKeywords}`;
  }

  // Fetch the original index.html from the origin server
  const originalResponse = await fetch(url.origin, request);
  const contentType = originalResponse.headers.get("content-type") || "";

  // Only apply transformations to HTML responses
  if (!contentType.includes("text/html")) {
    return originalResponse;
  }

  // Use HTMLRewriter to modify the HTML
  const rewriter = new HTMLRewriter()
    // --- Title Tag ---
    .on("title", {
      element(element) {
        element.setInnerContent(dynamicTitle);
      },
    })
    // --- Standard Meta Tags ---
    .on("meta[name='description']", {
      element(element) {
        element.setAttribute("content", dynamicDescription);
      },
    })
    .on("meta[name='keywords']", {
      element(element) {
        element.setAttribute("content", dynamicKeywords);
      },
    })
    // --- Open Graph Tags (for social media sharing) ---
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

  // Inject preloaded data for the current day into the HTML
  if (eventsData && eventsData.events && eventsData.events.length > 0) {
    const initialEventsForClient = eventsData.events.slice(0, 20); // Limit data to avoid large payloads
    const initialBirthsForClient = eventsData.births
      ? eventsData.births.slice(0, 10)
      : [];
    const initialDeathsForClient = eventsData.deaths
      ? eventsData.deaths.slice(0, 10)
      : [];

    const preloadedData = {
      events: initialEventsForClient,
      births: initialBirthsForClient,
      deaths: initialDeathsForClient,
    };
    const jsonData = JSON.stringify(preloadedData);

    rewriter.on("head", {
      // Inject into head or body
      element(element) {
        // Create a script tag with the preloaded data
        element.append(
          `<script id="preloaded-today-events" type="application/json">${jsonData}</script>`,
          { html: true }
        );
      },
    });
  }

  // Return the modified response. HTMLRewriter automatically handles streaming the transformation.
  return rewriter.transform(originalResponse);
}

// --- Worker Entry Point (ES Module Format) ---
export default {
  async fetch(request, env, ctx) {
    // The handleRequest function now becomes the core logic of the fetch handler
    // In a full module worker, 'env' would contain bindings (KV, Durable Objects etc.)
    // and 'ctx' would contain the ExecutionContext (for ctx.waitUntil etc.).
    return handleRequest(request);
  },
};
