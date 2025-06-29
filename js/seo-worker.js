// This Cloudflare Worker dynamically injects SEO-friendly meta tags
// and preloads daily event data to improve the user experience on site.

// --- Configuration Constants ---
// Define a User-Agent for API requests to Wikipedia.
const WIKIPEDIA_USER_AGENT = "thisDay.info (kapetanovic.armin@gmail.com)";

// Key for storing today's events in KV
const TODAY_EVENTS_KV_KEY = "today-events-data";
const KV_CACHE_TTL_SECONDS = 24 * 60 * 60; // KV entry valid for 24 hours

// --- Helper function to fetch daily events from Wikipedia API ---
async function fetchDailyEvents(date) {
  const month = date.getMonth() + 1; // getMonth() is 0-indexed
  const day = date.getDate();
  const apiUrl = `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events/${month}/${day}`;

  // This internal cache is now less critical as KV will be the primary cache,
  // but it can still serve as a fallback if KV is not yet populated or accessible.
  const workerCache = caches.default;
  let response = await workerCache.match(apiUrl);
  if (response) {
    console.log("Worker internal Cache HIT for Wikipedia API:", apiUrl);
    return response.json();
  }

  console.log("Fetching from Wikipedia API:", apiUrl);
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
      await fetchResponse.text(); // Consume body to prevent issues
      throw new Error(
        `Failed to fetch Wikipedia events: ${fetchResponse.statusText}`
      );
    }

    // Cache the successful response in worker's internal cache for immediate re-use
    await workerCache.put(apiUrl, fetchResponse.clone());

    return fetchResponse.json();
  } catch (error) {
    console.error(`Error fetching daily events from Wikipedia API: ${error}`);
    // Return a default structure in case of an error
    return { events: [], births: [], deaths: [], holidays: [], selected: [] };
  }
}

// --- Main Request Handler (for user requests) ---
async function handleFetchRequest(request, env) {
  const url = new URL(request.url);

  // Only handle requests for the root path or /index.html
  // Pass through all other requests (e.g., for JS, CSS, images) directly to the origin
  if (url.pathname !== "/" && url.pathname !== "/index.html") {
    return fetch(request);
  }

  const today = new Date(); // Current date (at Cloudflare edge)

  // 1. Try to get events data from KV first
  let eventsData;
  try {
    const cachedKvData = await env.EVENTS_KV.get(TODAY_EVENTS_KV_KEY, {
      type: "json",
    });
    if (cachedKvData) {
      eventsData = cachedKvData;
      console.log("KV Cache HIT for today's events!");
    } else {
      // 2. If not in KV, fetch it now and update KV (this means KV wasn't pre-populated yet)
      console.log(
        "KV Cache MISS for today's events, fetching live and populating KV..."
      );
      eventsData = await fetchDailyEvents(today);
      // Asynchronously update KV to not block the current request
      if (eventsData && eventsData.events && eventsData.events.length > 0) {
        await env.EVENTS_KV.put(
          TODAY_EVENTS_KV_KEY,
          JSON.stringify(eventsData),
          { expirationTtl: KV_CACHE_TTL_SECONDS }
        );
        console.log("KV updated with live fetched data.");
      }
    }
  } catch (kvError) {
    console.error("Error accessing KV. Falling back to live fetch:", kvError);
    eventsData = await fetchDailyEvents(today); // Fallback to live fetch on KV error
  }

  // Prepare dynamic meta tags and content based on fetched data
  let dynamicDescription =
    "Explore historical events, milestones, and notable figures from any date. Dive into history with this interactive calendar.";
  let dynamicKeywords =
    "thisDay, historical events, on this day, history, daily highlights, calendar, famous birthdays, anniversaries, notable deaths, world history, today in history, history, educational, timeline, trivia, historical figures";
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

  const rewriter = new HTMLRewriter()
    // --- Meta Tags and Title ---
    .on("title", {
      element(element) {
        element.setInnerContent(dynamicTitle);
      },
    })
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
        element.setAttribute("content", "website");
      },
    })
    .on("meta[name='twitter:card']", {
      element(element) {
        element.setAttribute("content", "summary_large_image");
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
    const initialEventsForClient = eventsData.events.slice(0, 20); // Limit data
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
      element(element) {
        element.append(
          `<script id="preloaded-today-events" type="application/json">${jsonData}</script>`,
          { html: true }
        );
      },
    });
  }

  return rewriter.transform(originalResponse);
}

// --- Scheduled Event Handler (Cron Trigger) ---
async function handleScheduledEvent(env) {
  console.log("Scheduled event triggered: Pre-fetching today's events to KV.");
  const today = new Date();
  const eventsData = await fetchDailyEvents(today);

  if (eventsData && eventsData.events && eventsData.events.length > 0) {
    try {
      await env.EVENTS_KV.put(TODAY_EVENTS_KV_KEY, JSON.stringify(eventsData), {
        expirationTtl: KV_CACHE_TTL_SECONDS,
      });
      console.log("Successfully pre-fetched and stored today's events in KV.");
    } catch (e) {
      console.error("Failed to put data into KV:", e);
    }
  } else {
    console.warn("No events data fetched, not updating KV.");
  }
}

// --- Worker Entry Point (ES Module Format) ---
export default {
  async fetch(request, env, ctx) {
    return handleFetchRequest(request, env);
  },
  async scheduled(event, env, ctx) {
    // You can use ctx.waitUntil to ensure the scheduled task completes
    ctx.waitUntil(handleScheduledEvent(env));
  },
};
