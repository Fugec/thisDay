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
 * @param {string}  [opts.todayLink]         href for "Today" (default "/today")
 */
export function siteNav({ todayLink = "/today" } = {}) {
  return `<nav class="navbar navbar-expand-lg navbar-light">
  <div class="container-fluid">
    <a class="navbar-brand" href="/">thisDay.</a>
    <button
      class="navbar-toggler"
      type="button"
      data-bs-toggle="collapse"
      data-bs-target="#siteNavbar"
      aria-controls="siteNavbar"
      aria-expanded="false"
      aria-label="Toggle navigation"
    >
      <span class="navbar-toggler-icon"></span>
    </button>
    <div class="collapse navbar-collapse" id="siteNavbar">
      <ul class="navbar-nav ms-auto">
        <li class="nav-item"><a class="nav-link" href="/">Home</a></li>
        <li class="nav-item"><a class="nav-link" href="${todayLink}">Today</a></li>
        <li class="nav-item"><a class="nav-link" href="/blog/">Blog</a></li>
        <li class="nav-item"><a class="nav-link" href="/about/">About</a></li>
        <li class="nav-item"><a class="nav-link" href="/contact/">Contact</a></li>
        <li class="nav-item"><a class="nav-link" href="/terms/">Terms</a></li>
        <li class="nav-item"><a class="nav-link" href="/privacy-policy/">Privacy</a></li>
      </ul>
    </div>
  </div>
</nav>`;
}

/** Navbar CSS — paste into the page <style> block. */
export const NAV_CSS =
  `.navbar{background:var(--pb,var(--primary-bg,#ffffff))!important;position:sticky;top:0;z-index:1030}` +
  `.navbar-brand,.nav-link{color:var(--htc,var(--header-text-color,#1f1f1f))!important;font-weight:700!important}` +
  `.navbar-toggler{border-color:var(--card-border,#e2e8f0)}` +
  `.navbar-toggler:focus{box-shadow:0 0 0 .15rem rgba(0,0,0,.12)}` +
  `body.dark-theme .navbar-toggler{border-color:rgba(255,255,255,.35)}` +
  `body.dark-theme .navbar-toggler-icon{filter:invert(1)}`;

// Small fallback for the hamburger icon in case Bootstrap's icon styles are
// not available (ensures a visible 3-bar icon on all pages).
export const NAV_CSS_FALLBACK =
  `.navbar-toggler-icon{background-image:none!important;position:relative;width:1.6rem;height:1rem;display:inline-block}` +
  `.navbar-toggler-icon::before{content:'';position:absolute;left:0;right:0;top:50%;height:2px;background:currentColor;box-shadow:0 -6px 0 currentColor, 0 6px 0 currentColor;transform:translateY(-50%);border-radius:2px}` +
  `@media (prefers-reduced-motion: reduce){.navbar-toggler{transition:none}}`;

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
