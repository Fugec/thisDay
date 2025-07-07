const WIKIPEDIA_USER_AGENT = "thisDay.info (kapetanovic.armin@gmail.com)";
const KV_CACHE_TTL_SECONDS = 24 * 60 * 60;
// Escape JSON safely for embedding inside a <script> tag
function escapeHtmlJson(str) {
  return str.replace(/[<>&"\\']/g, (c) => {
    switch (c) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      case '"':
        return "\\u0022";
      case "'":
        return "\\u0027";
      case "\\":
        return "\\\\";
      default:
        return c;
    }
  });
}

async function fetchDailyEvents(date) {
  // Use UTC month and day for consistent results regardless of timezone
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const apiUrl = `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events/${month}/${day}`;

  const workerCache = caches.default;
  let response = await workerCache.match(apiUrl);
  if (response) {
    console.log("Worker Cache HIT:", apiUrl);
    return response.json();
  }

  try {
    const fetchResponse = await fetch(apiUrl, {
      headers: { "User-Agent": WIKIPEDIA_USER_AGENT },
    });

    if (!fetchResponse.ok) {
      await fetchResponse.text(); // consume body
      throw new Error(`Wikipedia fetch failed: ${fetchResponse.statusText}`);
    }

    await workerCache.put(apiUrl, fetchResponse.clone());
    return fetchResponse.json();
  } catch (error) {
    console.error("Wikipedia API error:", error);
    return { events: [], births: [], deaths: [], holidays: [], selected: [] };
  }
}

async function handleFetchRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname !== "/" && url.pathname !== "/index.html") {
    // Let other paths be handled normally
    return fetch(request);
  }
  // Normalize date to UTC midnight for consistent caching
  const now = new Date();
  const utcYear = now.getUTCFullYear();
  const utcMonth = now.getUTCMonth();
  const utcDate = now.getUTCDate();
  const todayUTC = new Date(Date.UTC(utcYear, utcMonth, utcDate));
  const isoDate = todayUTC.toISOString().split("T")[0];
  // Use locale string for display, but keep UTC date for caching
  const options = { month: "long", day: "numeric" };
  const formattedDate = todayUTC.toLocaleDateString("en-US", options);
  // Use dynamic KV key with date for daily unique cache
  const todayEventsKVKey = `today-events-${isoDate}`;

  let eventsData;
  try {
    const cached = await env.EVENTS_KV.get(todayEventsKVKey, { type: "json" });
    if (cached) {
      eventsData = cached;
      console.log("KV Cache HIT:", todayEventsKVKey);
    } else {
      console.log("KV MISS. Fetching live...");
      eventsData = await fetchDailyEvents(todayUTC);
      if (eventsData?.events?.length > 0) {
        await env.EVENTS_KV.put(todayEventsKVKey, JSON.stringify(eventsData), {
          expirationTtl: KV_CACHE_TTL_SECONDS,
        });
        console.log("KV updated:", todayEventsKVKey);
      }
    }
  } catch (err) {
    console.error("KV Error:", err);
    // fallback to live fetch
    eventsData = await fetchDailyEvents(todayUTC);
  }

  const hasEvents = eventsData?.events?.length > 0;
  // Default SEO metadata
  let dynamicTitle =
    "thisDay. | What Happened on This Day? | Historical Events";
  let dynamicDescription =
    "Explore historical events, milestones, and notable figures from past and present. Discover what happened today in history. Browse by date and learn about wars, inventions, discoveries, and the lives of notable people. Make history come alive - one day at a time.";
  let dynamicKeywords =
    "thisDay, historical events, on this day, history, daily highlights, calendar, famous events, anniversaries, notable deaths, world history, educational, timeline, trivia, historical figures";
  const ogImageUrl = "https://thisday.info/assets/default-social-share.jpg";
  const ogUrl = "https://thisday.info/";

  const imageUrlsToPreload = [];

  if (hasEvents) {
    const topEvents = eventsData.events
      .slice(0, 5)
      .map((event) => `In ${event.year}, ${event.text}`)
      .join("; ");

    dynamicTitle = `On This Day, ${formattedDate}: ${
      eventsData.events[0].year
    }, ${eventsData.events[0].text.substring(0, 70)}... | thisDay.info`;

    dynamicDescription = `Discover what happened on ${formattedDate}: ${topEvents}. Explore historical events, births, and deaths.`;

    const eventKeywords = eventsData.events
      .slice(0, 10)
      .flatMap((event) => event.text.split(" "))
      .filter((word) => word.length > 3 && /^[a-zA-Z]+$/.test(word))
      .map((word) => word.toLowerCase())
      .filter((value, index, self) => self.indexOf(value) === index)
      .slice(0, 20)
      .join(", ");

    dynamicKeywords += `, ${eventKeywords}`;

    const images = eventsData.events.filter((e) => e.thumbnail?.source);
    for (let i = 0; i < Math.min(images.length, 3); i++) {
      imageUrlsToPreload.push(images[i].thumbnail.source);
    }
  }
  // Fetch original response from origin server
  const originalResponse = await env.ASSETS.fetch(request);
  const contentType = originalResponse.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return originalResponse;

  const rewriter = new HTMLRewriter()
    .on("title", {
      element(e) {
        e.setInnerContent(dynamicTitle);
      },
    })
    .on("meta[name='description']", {
      element(e) {
        e.setAttribute("content", dynamicDescription);
      },
    })
    .on("meta[name='keywords']", {
      element(e) {
        e.setAttribute("content", dynamicKeywords);
      },
    })
    .on("meta[property='og:title']", {
      element(e) {
        e.setAttribute("content", dynamicTitle);
      },
    })
    .on("meta[property='og:description']", {
      element(e) {
        e.setAttribute("content", dynamicDescription);
      },
    })
    .on("meta[property='og:image']", {
      element(e) {
        e.setAttribute("content", ogImageUrl);
      },
    })
    .on("meta[property='og:url']", {
      element(e) {
        e.setAttribute("content", ogUrl);
      },
    })
    .on("meta[property='og:type']", {
      element(e) {
        e.setAttribute("content", "website");
      },
    })
    .on("meta[name='twitter:card']", {
      element(e) {
        e.setAttribute("content", "summary_large_image");
      },
    })
    .on("meta[name='twitter:title']", {
      element(e) {
        e.setAttribute("content", dynamicTitle);
      },
    })
    .on("meta[name='twitter:description']", {
      element(e) {
        e.setAttribute("content", dynamicDescription);
      },
    })
    .on("meta[name='twitter:image']", {
      element(e) {
        e.setAttribute("content", ogImageUrl);
      },
    })
    .on("img", {
      element(e) {
        // Lazy load non-critical images
        if (!e.getAttribute("loading")) {
          e.setAttribute("loading", "lazy");
        }
      },
    });

  if (hasEvents) {
    const jsonData = JSON.stringify({
      events: eventsData.events.slice(0, 20),
      births: eventsData.births?.slice(0, 10) || [],
      deaths: eventsData.deaths?.slice(0, 10) || [],
    });

    rewriter.on("head", {
      element(element) {
        element.append(
          `<script id="preloaded-today-events" type="application/json">${escapeHtmlJson(
            jsonData
          )}</script>`,
          { html: true }
        );

        imageUrlsToPreload.forEach((url) => {
          const extMatch = url.split(".").pop().toLowerCase();
          let mimeType = "image/jpeg";
          switch (extMatch) {
            case "jpg":
            case "jpeg":
              mimeType = "image/jpeg";
              break;
            case "png":
              mimeType = "image/png";
              break;
            case "gif":
              mimeType = "image/gif";
              break;
            case "svg":
              mimeType = "image/svg+xml";
              break;
            case "webp":
              mimeType = "image/webp";
              break;
            case "avif":
              mimeType = "image/avif";
              break;
            case "tif":
            case "tiff":
              mimeType = "image/tiff";
              break;
          }

          element.append(
            `<link rel="preload" as="image" type="${mimeType}" href="${url}">`,
            { html: true }
          );
        });

        const schemaData = {
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
          },
          potentialAction: {
            "@type": "SearchAction",
            target: {
              "@type": "EntryPoint",
              urlTemplate: "https://thisday.info/?q={search_term_string}",
            },
            "query-input": "required name=search_term_string",
          },
        };

        element.append(
          `<script type="application/ld+json">${escapeHtmlJson(
            JSON.stringify(schemaData)
          )}</script>`,
          { html: true }
        );
      },
    });
  }

  const transformedResponse = rewriter.transform(originalResponse);
  const newResponse = new Response(
    transformedResponse.body,
    transformedResponse
  );
  // --- Add Security Headers ---

  // X-Content-Type-Options: nosniff - Prevents browsers from MIME-sniffing a response away from the declared Content-Type.
  newResponse.headers.set("X-Content-Type-Options", "nosniff");

  // Strict-Transport-Security (HSTS) - ONLY if your site is always HTTPS.
  // This tells browsers to only connect via HTTPS for a given duration, preventing downgrade attacks.
  // Be very careful with this; if you ever revert to HTTP, users might be locked out for max-age duration.
  newResponse.headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains; preload"
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
    `connect-src 'self' https://api.wikimedia.org https://www.google-analytics.com https://www.google.com https://www.gstatic.com https://www.googleadservices.com; ` +
    `script-src 'self' https://cdn.jsdelivr.net https://consent.cookiebot.com https://www.googletagmanager.com https://www.googleadservices.com https://googleads.g.doubleclick.net 'unsafe-inline'; ` +
    `style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; ` +
    `img-src 'self' data: https://upload.wikimedia.org https://cdn.buymeacoffee.com https://imgsct.cookiebot.com https://www.google.com https://www.google.ba https://www.googleadservices.com; ` + // ADDED THESE DOMAINS
    `font-src 'self' https://cdn.jsdelivr.net https://fonts.gstatic.com; ` +
    `frame-src https://consentcdn.cookiebot.com https://td.doubleclick.net https://www.googletagmanager.com https://www.google.com; ` +
    `base-uri 'self'; ` +
    `frame-ancestors 'none'; ` +
    `object-src 'none';`;
  newResponse.headers.set("Content-Security-Policy", csp);

  // X-Frame-Options: DENY - Also for ClickJacking protection. Redundant if CSP frame-ancestors 'none' is used, but good for older browsers.
  newResponse.headers.set("X-Frame-Options", "DENY");

  return newResponse;
}

async function handleScheduledEvent(env) {
  console.log("Scheduled KV pre-population...");
  const now = new Date();
  const utcYear = now.getUTCFullYear();
  const utcMonth = now.getUTCMonth();
  const utcDate = now.getUTCDate();
  const todayUTC = new Date(Date.UTC(utcYear, utcMonth, utcDate));

  const eventsData = await fetchDailyEvents(todayUTC);
  const isoDate = todayUTC.toISOString().split("T")[0];
  const todayEventsKVKey = `today-events-${isoDate}`;

  if (eventsData?.events?.length > 0) {
    try {
      await env.EVENTS_KV.put(todayEventsKVKey, JSON.stringify(eventsData), {
        expirationTtl: KV_CACHE_TTL_SECONDS,
      });
      console.log("KV populated:", todayEventsKVKey);
    } catch (e) {
      console.error("KV put error:", e);
    }
  } else {
    console.warn("No events to store in KV.");
  }
}

export default {
  async fetch(request, env, ctx) {
    return handleFetchRequest(request, env);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduledEvent(env));
  },
};
