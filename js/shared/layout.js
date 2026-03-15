/**
 * Shared site layout — canonical navbar, footer, CSS, and site description
 * used across all Cloudflare Workers (seo-worker, blog-ai-worker).
 *
 * Import:
 *   import { siteNav, siteFooter, FOOTER_CSS, NAV_CSS, footerYearScript, SITE_DESCRIPTION } from "./shared/layout.js";
 */

// ---------------------------------------------------------------------------
// Site-wide copy
// ---------------------------------------------------------------------------

export const SITE_DESCRIPTION =
  "Explore historical events, daily articles, quizzes, and YouTube Shorts. Discover what happened today in history — births, deaths, and milestones from every era.";

// Flipboard has no Bootstrap Icon — use their 3-square brand mark as inline SVG.
const FLIPBOARD_ICON =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" ` +
  `style="width:1.6rem;height:1.6rem;vertical-align:-.15em" aria-hidden="true">` +
  `<path d="M0 0h11v11H0zM13 0h11v11H13zM0 13h11v11H0z"/>` +
  `</svg>`;

// ---------------------------------------------------------------------------
// Navbar
// ---------------------------------------------------------------------------

/**
 * Returns the canonical site navbar HTML.
 *
 * @param {object} opts
 * @param {string}  [opts.todayLink]         href for "Today's Events" — omit to hide
 * @param {string}  [opts.switchIdMobile]    id for the mobile dark-mode toggle  (default "tsm")
 * @param {string}  [opts.switchIdDesktop]   id for the desktop dark-mode toggle (default "tsd")
 */
export function siteNav({
  todayLink = "",
  switchIdMobile = "tsm",
  switchIdDesktop = "tsd",
} = {}) {
  const todayItem = todayLink
    ? `<li class="nav-item"><a class="nav-link" href="${todayLink}">Today's Events</a></li>`
    : "";

  return `<nav class="navbar navbar-expand-lg navbar-dark">
  <div class="container-fluid">
    <a class="navbar-brand" href="/">thisDay.</a>
    <div class="form-check form-switch d-lg-none me-2">
      <input class="form-check-input" type="checkbox" id="${switchIdMobile}" aria-label="Toggle dark mode"/>
      <label class="form-check-label" for="${switchIdMobile}"><i class="bi bi-brightness-high-fill" style="color:#fff;font-size:1.1rem;margin-left:4px"></i></label>
    </div>
    <div class="collapse navbar-collapse">
      <ul class="navbar-nav ms-auto">
        ${todayItem}
        <li class="nav-item d-flex align-items-center">
          <div class="form-check form-switch d-none d-lg-block me-2">
            <input class="form-check-input" type="checkbox" id="${switchIdDesktop}" aria-label="Toggle dark mode"/>
            <label class="form-check-label" for="${switchIdDesktop}" style="color:#fff">Dark Mode</label>
          </div>
        </li>
      </ul>
    </div>
  </div>
</nav>`;
}

/** Navbar CSS — paste into the page <style> block. */
export const NAV_CSS =
  `.navbar{background:var(--pb,#1d4ed8)!important;position:sticky;top:0;z-index:1030}` +
  `.navbar-brand,.nav-link{color:var(--htc,#fff)!important;font-weight:700!important}`;

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

/**
 * Returns the canonical site footer HTML.
 * @param {string} yearSpanId  id for the copyright year <span> (default "yr")
 */
export function siteFooter(yearSpanId = "yr") {
  return `<footer class="footer">
  <div class="container d-flex justify-content-center flex-wrap my-2" style="gap:1.25rem">
    <a href="https://github.com/Fugec" target="_blank" rel="noopener noreferrer" aria-label="GitHub"><i class="bi bi-github h3 text-white mb-0"></i></a>
    <a href="https://www.facebook.com/profile.php?id=61578009082537" target="_blank" rel="noopener noreferrer" aria-label="Facebook"><i class="bi bi-facebook h3 text-white mb-0"></i></a>
    <a href="https://www.instagram.com/thisday.info/" target="_blank" rel="noopener noreferrer" aria-label="Instagram"><i class="bi bi-instagram h3 text-white mb-0"></i></a>
    <a href="https://www.tiktok.com/@this__day" target="_blank" rel="noopener noreferrer" aria-label="TikTok"><i class="bi bi-tiktok h3 text-white mb-0"></i></a>
    <a href="https://www.youtube.com/@thisDay_info/shorts" target="_blank" rel="noopener noreferrer" aria-label="YouTube"><i class="bi bi-youtube h3 text-white mb-0"></i></a>
    <a href="https://flipboard.com/@ArminKapetanovi/magazines/" target="_blank" rel="noopener noreferrer" aria-label="Flipboard">${FLIPBOARD_ICON}</a>
  </div>
  <p>&copy; <span id="${yearSpanId}"></span> thisDay. All rights reserved.</p>
  <p>Historical data sourced from Wikipedia.org under <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a> license. Data is for informational purposes and requires verification.</p>
  <p>This website is not affiliated with any official historical organization. Content is for educational and entertainment purposes only.</p>
  <p class="footer-bottom">
    <a href="https://buymeacoffee.com/fugec?new=1" target="_blank">Support This Project</a>
    | <a href="/blog/">Blog</a>
    | <a href="/about/">About Us</a>
    | <a href="/contact/">Contact</a>
    | <a href="/terms/">Terms and Conditions</a>
    | <a href="/privacy-policy/">Privacy Policy</a>
  </p>
</footer>`;
}

/**
 * Footer CSS — works with both workers' CSS variable schemes via fallbacks.
 * Paste into the page <style> block.
 */
export const FOOTER_CSS =
  `.footer{background:var(--footer-bg,var(--fb,#020617));color:var(--footer-text-color,var(--ftc,#fff));` +
  `text-align:center;padding:20px;margin-top:30px;font-size:14px;` +
  `transition:background-color .3s,color .3s}` +
  `.footer a{color:var(--footer-text-color,var(--ftc,#fff));text-decoration:underline}` +
  `.footer-bottom{font-size:.8rem;opacity:.8}`;

/**
 * Inline JS snippet to populate the footer copyright year.
 * @param {string} spanId  must match the yearSpanId passed to siteFooter()
 */
export function footerYearScript(spanId = "yr") {
  return `(function(){var e=document.getElementById(${JSON.stringify(spanId)});if(e)e.textContent=new Date().getFullYear();})();`;
}
