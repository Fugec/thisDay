import { siteNav } from "./layout.js";

function buildNav({ includeMarquee = false, supportPopup = false } = {}) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = siteNav().trim();
  const chrome = wrapper.firstElementChild;

  if (!chrome) return null;

  const marquee = chrome.querySelector(".marquee-bar");
  if (!includeMarquee && marquee) marquee.remove();

  if (supportPopup) {
    const supportLink = chrome.querySelector('a[aria-label="Support this project"]');
    if (supportLink) {
      supportLink.href = "#";
      supportLink.id = "supportNavBtn";
      supportLink.removeAttribute("target");
      supportLink.removeAttribute("rel");
    }
  }

  return chrome;
}

function initNavToggle() {
  const toggle = document.getElementById("navToggle");
  const mobile = document.getElementById("navMobile");

  if (!toggle || !mobile || toggle.dataset.navReady === "true") return;

  toggle.dataset.navReady = "true";
  toggle.addEventListener("click", () => {
    mobile.classList.toggle("active");
  });
}

function initMarquee() {
  const bar = document.getElementById("marqueeBar");
  const track = document.getElementById("marqueeTrack");

  if (!bar || !track || track.dataset.marqueeReady === "true") return;

  track.dataset.marqueeReady = "true";

  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");

  fetch(`https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events/${mm}/${dd}`, {
    headers: { "User-Agent": "thisday.info/1.0" },
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      const items = (data && data.events) || [];
      if (!items.length) return;

      items.slice(0, 12).forEach((event) => {
        const item = document.createElement("div");
        item.className = "marquee-item";

        const year = document.createElement("span");
        year.textContent = event.year || "";
        item.appendChild(year);

        const page = event.pages && event.pages[0];
        const url =
          page &&
          page.content_urls &&
          page.content_urls.desktop &&
          page.content_urls.desktop.page;
        const text = ` ${event.text || ""}`;

        if (url) {
          const link = document.createElement("a");
          link.href = url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.style.cssText = "color:inherit;text-decoration:none;font-weight:600";
          link.textContent = text;
          item.appendChild(link);
        } else {
          const label = document.createElement("span");
          label.style.fontWeight = "600";
          label.textContent = text;
          item.appendChild(label);
        }

        track.appendChild(item);
      });

      track.innerHTML += track.innerHTML;
      bar.style.display = "block";
    })
    .catch(() => {});
}

export function mountStaticNav(options = {}) {
  const target = document.querySelector("[data-site-nav]");
  if (!target) return;

  const nav = buildNav(options);
  if (!nav) return;

  target.replaceWith(nav);
  initNavToggle();

  if (options.includeMarquee) initMarquee();
}
