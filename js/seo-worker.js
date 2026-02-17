// This Cloudflare Worker dynamically injects SEO-friendly meta tags
// and preloads daily event data to improve the user experience on site.
// Adds various security headers to enhance protection.
// Injects Schema.org JSON-LD for better SEO.

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
        `Wikipedia API responded with status ${fetchResponse.status} for ${apiUrl}`,
      );
      await fetchResponse.text(); // Consume body to prevent issues
      throw new Error(
        `Failed to fetch Wikipedia events: ${fetchResponse.statusText}`,
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

// --- Helper function to extract a plausible location from event text ---
function extractLocationFromName(text) {
  // Try to find patterns like "in City, Country" or "in City"
  let match = text.match(
    /(?:in|near)\s+([A-Za-z\s,\-]+(?:,\s*[A-Za-z\s\-]+)?)\b/i,
  );
  if (match && match[1]) {
    // Basic cleaning: remove trailing punctuation if any
    let location = match[1].trim();
    if (location.endsWith(".")) {
      location = location.slice(0, -1);
    }
    return location;
  }
  // Fallback if no specific location can be extracted
  return "Historical Location";
}

// --- Main Request Handler (for user requests) ---
async function handleFetchRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/llms.txt") {
    const llmsContent = `# Site Summary for Large Language Models...`; // your content
    return new Response(llmsContent, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // Only handle requests for the root path or /index.html
  // Pass through all other requests (e.g., for JS, CSS, images) directly to the origin
  if (url.pathname !== "/" && url.pathname !== "/index.html") {
    return fetch(request);
  }

  if (url.pathname === "/manifest.json") {
    const manifestContent = {
      name: "This Day in History",
      short_name: "ThisDay",
      description:
        "Explore historical events, milestones, and notable figures from past and present. Discover what happened today in history. Browse by date and learn about wars, inventions, discoveries, and the lives of notable people. Make history come alive - one day at a time.",
      version: "1.0.0",
      start_url: "/",
      display: "standalone",
      background_color: "#2c3e50",
      theme_color: "#2c3e50",
      orientation: "any",
      scope: "/",
      lang: "en",
      icons: [
        {
          src: "icons/icon-72x72.png",
          sizes: "72x72",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "icons/icon-96x96.png",
          sizes: "96x96",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "icons/icon-128x128.png",
          sizes: "128x128",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "icons/icon-144x144.png",
          sizes: "144x144",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "icons/icon-152x152.png",
          sizes: "152x152",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "icons/icon-192x192.png",
          sizes: "192x192",
          type: "image/png",
          purpose: "any maskable",
        },
        {
          src: "icons/icon-384x384.png",
          sizes: "384x384",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "icons/icon-512x512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "any maskable",
        },
      ],
      categories: ["education", "reference", "history"],
      screenshots: [
        {
          src: "screenshots/desktop.png",
          sizes: "1280x720",
          type: "image/png",
          form_factor: "wide",
        },
        {
          src: "screenshots/mobile.png",
          sizes: "540x720",
          type: "image/png",
          form_factor: "narrow",
        },
      ],
    };
    return new Response(JSON.stringify(manifestContent), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
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
        "KV Cache MISS for today's events, fetching live and populating KV...",
      );
      eventsData = await fetchDailyEvents(today);
      // Asynchronously update KV to not block the current request
      if (eventsData && eventsData.events && eventsData.events.length > 0) {
        await env.EVENTS_KV.put(
          TODAY_EVENTS_KV_KEY,
          JSON.stringify(eventsData),
          { expirationTtl: KV_CACHE_TTL_SECONDS },
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
  let ogImageUrl = "https://thisday.info/images/logo.png"; // Default fallback image
  const ogUrl = "https://thisday.info/"; // Canonical URL

  // Format the date for the title and description
  const options = { month: "long", day: "numeric" };
  const formattedDate = today.toLocaleDateString("en-US", options); // e.g., "July 12"
  const isoDate = today.toISOString().split("T")[0]; // e.g., "2025-07-12"

  if (eventsData && eventsData.events && eventsData.events.length > 0) {
    // Use the first event's Wikipedia thumbnail for social sharing if available
    const firstWithImage = eventsData.events.find(
      (e) => e.pages?.[0]?.thumbnail?.source
    );
    if (firstWithImage) {
      ogImageUrl =
        firstWithImage.pages[0].originalimage?.source ||
        firstWithImage.pages[0].thumbnail.source;
    }

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
  let contentType = originalResponse.headers.get("content-type") || "";

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
        // --- Inject Preloaded Data for Client-Side JS ---
        element.append(
          `<script id="preloaded-today-events" type="application/json">${jsonData}</script>`,
          { html: true },
        );

        // --- Main WebPage Schema with Events Collection ---
        const webPageSchema = {
          "@context": "https://schema.org",
          "@type": "WebPage",
          name: dynamicTitle,
          description: dynamicDescription,
          url: ogUrl,
          datePublished: isoDate,
          dateModified: isoDate,
          isPartOf: {
            "@type": "WebSite",
            name: "thisDay.info",
            url: "https://thisday.info/",
            description:
              "Explore historical events, milestones, and notable figures from any date",
            publisher: {
              "@type": "Organization",
              name: "thisDay.info",
              url: "https://thisday.info/",
            },
          },
          potentialAction: {
            "@type": "SearchAction",
            target: {
              "@type": "EntryPoint",
              urlTemplate: "https://thisday.info/?q={search_term_string}",
            },
            "query-input": "required name=search_term_string",
          },
          // Add mainEntity for primary content
          mainEntity: {
            "@type": "ItemList",
            name: `Historical Events on ${formattedDate}`,
            description: `Collection of historical events, births, and deaths that occurred on ${formattedDate}`,
            numberOfItems:
              (eventsData?.events?.length || 0) +
              (eventsData?.births?.length || 0) +
              (eventsData?.deaths?.length || 0),
          },
        };

        element.append(
          `<script type="application/ld+json">${JSON.stringify(
            webPageSchema,
          )}</script>`,
          { html: true },
        );

        // --- Consolidated Events Schema (limit to top events to avoid bloat) ---
        if (eventsData && eventsData.events && eventsData.events.length > 0) {
          // Create a consolidated events schema instead of individual ones
          const topEvents = eventsData.events.slice(0, 5); // Limit to top 5 events
          const eventsListSchema = {
            "@context": "https://schema.org",
            "@type": "ItemList",
            name: `Historical Events on ${formattedDate}`,
            description: `Major historical events that occurred on ${formattedDate} throughout history`,
            url: ogUrl,
            numberOfItems: topEvents.length,
            itemListElement: topEvents.map((eventItem, index) => {
              const locationName = extractLocationFromName(eventItem.text);
              const eventImage =
                eventItem.pages &&
                eventItem.pages.length > 0 &&
                eventItem.pages[0].thumbnail &&
                eventItem.pages[0].thumbnail.source
                  ? eventItem.pages[0].thumbnail.source
                  : undefined;

              return {
                "@type": "ListItem",
                position: index + 1,
                item: {
                  "@type": "Event",
                  name:
                    eventItem.text.length > 100
                      ? eventItem.text.substring(0, 100) + "..."
                      : eventItem.text,
                  startDate: `${eventItem.year}-${String(
                    today.getMonth() + 1,
                  ).padStart(2, "0")}-${String(today.getDate()).padStart(
                    2,
                    "0",
                  )}`,
                  description: eventItem.text,
                  // Temporal Coverage
                  temporalCoverage: eventItem.year.toString(),
                  // Location
                  location: {
                    "@type": "Place",
                    name: locationName,
                  },
                  // Image
                  ...(eventImage && { image: eventImage }),
                },
              };
            }),
          };

          element.append(
            `<script type="application/ld+json">${JSON.stringify(
              eventsListSchema,
            )}</script>`,
            { html: true },
          );
        }

        // --- Notable People Schema (Births - limit to top 3) ---
        if (eventsData?.births && eventsData.births.length > 0) {
          const topBirths = eventsData.births.slice(0, 3);
          const birthsListSchema = {
            "@context": "https://schema.org",
            "@type": "ItemList",
            name: `Notable People Born on ${formattedDate}`,
            description: `Famous individuals born on ${formattedDate} throughout history`,
            url: ogUrl,
            numberOfItems: topBirths.length,
            itemListElement: topBirths.map((birthItem, index) => {
              // Better name parsing - handle cases like "Name, title" or "Name (profession)"
              const nameMatch = birthItem.text.match(/^([^,\(]+)/);
              const personName = nameMatch
                ? nameMatch[1].trim()
                : birthItem.text.split(",")[0].trim();
              const personImage =
                birthItem.pages &&
                birthItem.pages.length > 0 &&
                birthItem.pages[0].thumbnail &&
                birthItem.pages[0].thumbnail.source
                  ? birthItem.pages[0].thumbnail.source
                  : undefined;

              return {
                "@type": "ListItem",
                position: index + 1,
                item: {
                  "@type": "Person",
                  name: personName,
                  birthDate: `${birthItem.year}-${String(
                    today.getMonth() + 1,
                  ).padStart(2, "0")}-${String(today.getDate()).padStart(
                    2,
                    "0",
                  )}`,
                  description: birthItem.text,
                  url: ogUrl, // This 'url' is acceptable for Person if no specific profile page exists
                  // Add additional context if available
                  ...(birthItem.pages &&
                    birthItem.pages.length > 0 && {
                      sameAs: [
                        `https://en.wikipedia.org/wiki/${encodeURIComponent(
                          birthItem.pages[0].title.replace(/ /g, "_"),
                        )}`,
                      ],
                    }),
                  // Image for Person if available
                  ...(personImage && { image: personImage }),
                },
              };
            }),
          };

          element.append(
            `<script type="application/ld+json">${JSON.stringify(
              birthsListSchema,
            )}</script>`,
            { html: true },
          );
        }

        // --- Deaths Schema (limit to top 3) ---
        if (eventsData?.deaths && eventsData.deaths.length > 0) {
          const topDeaths = eventsData.deaths.slice(0, 3);
          const deathsListSchema = {
            "@context": "https://schema.org",
            "@type": "ItemList",
            name: `Notable People Who Died on ${formattedDate}`,
            description: `Famous individuals who died on ${formattedDate} throughout history`,
            url: ogUrl,
            numberOfItems: topDeaths.length,
            itemListElement: topDeaths.map((deathItem, index) => {
              const nameMatch = deathItem.text.match(/^([^,\(]+)/);
              const personName = nameMatch
                ? nameMatch[1].trim()
                : deathItem.text.split(",")[0].trim();
              const personImage =
                deathItem.pages &&
                deathItem.pages.length > 0 &&
                deathItem.pages[0].thumbnail &&
                deathItem.pages[0].thumbnail.source
                  ? deathItem.pages[0].thumbnail.source
                  : undefined;

              return {
                "@type": "ListItem",
                position: index + 1,
                item: {
                  "@type": "Person",
                  name: personName,
                  deathDate: `${deathItem.year}-${String(
                    today.getMonth() + 1,
                  ).padStart(2, "0")}-${String(today.getDate()).padStart(
                    2,
                    "0",
                  )}`,
                  description: deathItem.text,
                  url: ogUrl, // This 'url' is acceptable for Person if no specific profile page exists
                  // Add Wikipedia link if available
                  ...(deathItem.pages &&
                    deathItem.pages.length > 0 && {
                      sameAs: [
                        `https://en.wikipedia.org/wiki/${encodeURIComponent(
                          deathItem.pages[0].title.replace(/ /g, "_"),
                        )}`,
                      ],
                    }),
                  // Image for Person if available
                  ...(personImage && { image: personImage }),
                },
              };
            }),
          };

          element.append(
            `<script type="application/ld+json">${JSON.stringify(
              deathsListSchema,
            )}</script>`,
            { html: true },
          );
        }

        // --- Add Breadcrumb Schema ---
        const breadcrumbSchema = {
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            {
              "@type": "ListItem",
              position: 1,
              name: "Home",
              item: "https://thisday.info/",
            },
            {
              "@type": "ListItem",
              position: 2,
              name: `${formattedDate} in History`,
              item: ogUrl,
            },
          ],
        };

        element.append(
          `<script type="application/ld+json">${JSON.stringify(
            breadcrumbSchema,
          )}</script>`,
          { html: true },
        );

        // --- Add FAQ Schema if you have common questions ---
        const faqSchema = {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: [
            {
              "@type": "Question",
              name: `What happened on ${formattedDate}?`,
              acceptedAnswer: {
                "@type": "Answer",
                text: dynamicDescription,
              },
            },
            {
              "@type": "Question",
              name: "How do I find historical events for other dates?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Use the interactive calendar on thisDay.info to navigate to any month and day. Click a day card to see all events, births, and deaths that occurred on that date throughout history.",
              },
            },
            {
              "@type": "Question",
              name: "Where does thisDay.info get its historical data?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "All historical event data is sourced from Wikipedia via the Wikimedia REST API. Each event links directly to its Wikipedia article for further reading.",
              },
            },
            {
              "@type": "Question",
              name: `Who was born on ${formattedDate}?`,
              acceptedAnswer: {
                "@type": "Answer",
                text: eventsData?.births?.length > 0
                  ? `Notable people born on ${formattedDate} include: ${eventsData.births.slice(0, 3).map(b => b.text.split(",")[0]).join(", ")}. Browse the full list on thisDay.info.`
                  : `Explore thisDay.info to discover notable people born on ${formattedDate} throughout history.`,
              },
            },
            {
              "@type": "Question",
              name: "Is thisDay.info free to use?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Yes, thisDay.info is completely free. Explore historical events, famous birthdays, and notable deaths for any date without any registration or subscription.",
              },
            },
          ],
        };

        element.append(
          `<script type="application/ld+json">${JSON.stringify(
            faqSchema,
          )}</script>`,
          { html: true },
        );
      },
    });
  }

  // Transform the response
  const transformedResponse = rewriter.transform(originalResponse);

  // Clone the response to modify headers
  const newResponse = new Response(
    transformedResponse.body,
    transformedResponse,
  );

  // --- Add Security Headers ---

  // X-Content-Type-Options: nosniff - Prevents browsers from MIME-sniffing a response away from the declared Content-Type.
  newResponse.headers.set("X-Content-Type-Options", "nosniff");

  // Strict-Transport-Security (HSTS) - ONLY if your site is always HTTPS.
  // This tells browsers to only connect via HTTPS for a given duration, preventing downgrade attacks.
  // Be very careful with this; if you ever revert to HTTP, users might be locked out for max-age duration.
  newResponse.headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains; preload",
  );

  // Content-Security-Policy (CSP) - Most comprehensive.
  // This needs to be carefully crafted based on ALL resources your site uses (scripts, styles, images, fonts, etc.).
  // Incorrect CSP can break your site. Review and refine this based on your actual site's needs.
  // - default-src 'none': Blocks everything by default, forcing explicit allowance.
  // - connect-src: Allows connections to your domain ('self') and the Wikipedia API.
  // - script-src: Allows scripts from your domain ('self') and jsDelivr CDN (for Bootstrap/jQuery).
  // - style-src: Allows styles from your domain ('self'), jsDelivr CDN, and 'unsafe-inline' for any inline <style> tags or style attributes.
  // - img-src: Allows images from your domain ('self'), data URIs (for inline images), and Wikipedia (for event images).
  // - font-src: Allows fonts from your domain ('self') and jsDelivr CDN.
  // - base-uri 'self': Restricts the URLs that can be used in <base> elements.
  // - frame-ancestors 'none': Specifically for ClickJacking prevention (prevents embedding your site in iframes).
  // - object-src 'none': Prevents embedding <object>, <embed>, or <applet> elements.
  const csp =
    `default-src 'none'; ` +
    `connect-src 'self' https://api.wikimedia.org https://www.google-analytics.com https://www.google.com https://www.gstatic.com https://www.googleadservices.com https://pagead2.googlesyndication.com; ` +
    `script-src 'self' https://cdn.jsdelivr.net https://consent.cookiebot.com https://www.googletagmanager.com https://www.googleadservices.com https://googleads.g.doubleclick.net https://pagead2.googlesyndication.com https://static.cloudflareinsights.com 'unsafe-inline'; ` +
    `style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; ` +
    `img-src 'self' data: https://upload.wikimedia.org https://cdn.buymeacoffee.com https://imgsct.cookiebot.com https://www.google.com https://www.google.ba https://www.googleadservices.com https://pagead2.googlesyndication.com https://placehold.co https://www.googletagmanager.com https://i.ytimg.com; ` +
    `font-src 'self' https://cdn.jsdelivr.net https://fonts.gstatic.com; ` +
    `frame-src https://consentcdn.cookiebot.com https://td.doubleclick.net https://www.googletagmanager.com https://www.google.com https://www.youtube.com; ` +
    `base-uri 'self'; ` +
    `frame-ancestors 'none'; ` +
    `object-src 'none';`;
  newResponse.headers.set("Content-Security-Policy", csp);

  // X-Frame-Options: DENY - Also for ClickJacking protection. Redundant if CSP frame-ancestors 'none' is used, but good for older browsers.
  newResponse.headers.set("X-Frame-Options", "DENY");

  return newResponse;
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
    ctx.waitUntil(handleScheduledEvent(env));
  },
};
