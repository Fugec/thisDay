/**
 * Shared site layout — canonical nav, footer, CSS, and site description
 * used across all Cloudflare Workers (seo-worker, blog-ai-worker).
 *
 * Import:
 *   import { siteNav, siteFooter, NAV_CSS, FOOTER_CSS, footerYearScript, navToggleScript, SITE_DESCRIPTION } from "./shared/layout.js";
 */

// ---------------------------------------------------------------------------
// Site-wide copy
// ---------------------------------------------------------------------------

export const SITE_DESCRIPTION =
  "Explore historical events, daily articles, quizzes, and YouTube Shorts. Discover what happened today in history — births, deaths, and milestones from every era.";

// ---------------------------------------------------------------------------
// Color palette (mirrors css/custom.css :root)
// ---------------------------------------------------------------------------

export const ROOT_VARS =
  `:root{--bg:#ffffff;--bg-alt:#f2f7f2;--text:#1a2e20;--text-muted:#5c7a65;` +
  `--border:#cfe0cf;--btn-bg:#1b3a2d;--btn-text:#fff;--btn-hover:#2a4d3a;` +
  `--accent:#9dc43a;--radius:4px;--shadow:0 16px 32px -8px rgba(27,58,45,.08)}`;

// ---------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------

/**
 * Returns the canonical site nav HTML (matches index-new.html).
 */
export function siteNav() {
  return `<div class="site-chrome">
<nav class="nav">
  <div class="nav-inner">
    <a href="/" class="brand">thisDay.</a>
    <div class="nav-links">
      <a href="/events/today/">Events on this day</a>
      <a href="/born/today/">Born on this day</a>
      <a href="/died/today/">Died on this day</a>
      <a href="/blog/">Blog</a>
      <a href="/quiz/">Quiz</a>
      <a href="/about/">About</a>
      <a href="/contact/">Contact</a>
      <a href="https://buymeacoffee.com/fugec?new=1" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font-weight:600" aria-label="Support this project">☕ Support</a>
    </div>
    <button class="btn" id="navToggle" type="button" aria-label="Toggle menu" aria-controls="navMobile" aria-expanded="false">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
    </button>
  </div>
  <div class="nav-mobile" id="navMobile">
    <a href="/blog/">Blog</a>
    <a href="/quiz/">Quiz</a>
    <a href="/about/">About</a>
    <a href="/contact/">Contact</a>
    <div class="nav-mobile-bottom">
      <a href="/events/today/" class="mobile-menu-link">Events on this day</a>
      <a href="/born/today/" class="mobile-menu-link">Born on this day</a>
      <a href="/died/today/" class="mobile-menu-link">Died on this day</a>
      <div class="mobile-menu-social">
        <a href="https://github.com/Fugec" target="_blank" rel="noopener noreferrer" aria-label="GitHub"><i class="bi bi-github"></i></a>
        <a href="https://www.facebook.com/profile.php?id=61578009082537" target="_blank" rel="noopener noreferrer" aria-label="Facebook"><i class="bi bi-facebook"></i></a>
        <a href="https://www.instagram.com/thisday.info/" target="_blank" rel="noopener noreferrer" aria-label="Instagram"><i class="bi bi-instagram"></i></a>
        <a href="https://www.tiktok.com/@this__day" target="_blank" rel="noopener noreferrer" aria-label="TikTok"><i class="bi bi-tiktok"></i></a>
        <a href="https://www.youtube.com/@thisDay_info/shorts" target="_blank" rel="noopener noreferrer" aria-label="YouTube"><i class="bi bi-youtube"></i></a>
      </div>
    </div>
  </div>
</nav>
<div class="marquee-bar" id="marqueeBar" style="display:none">
  <div class="marquee-track" id="marqueeTrack"></div>
</div>
</div>`;
}

/**
 * Self-contained script that populates the marquee bar using today's Wikipedia events.
 * Identical behaviour to populateMarquee() in script.js — safe to include on any page.
 */
export function marqueeScript() {
  return `<script>
(function(){
  var bar=document.getElementById('marqueeBar');
  var track=document.getElementById('marqueeTrack');
  if(!bar||!track)return;
  if(track.dataset.marqueeReady==="true")return;
  track.dataset.marqueeReady="true";
  track.innerHTML="";
  var now=new Date();
  var mm=String(now.getMonth()+1).padStart(2,'0');
  var dd=String(now.getDate()).padStart(2,'0');
  fetch('https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events/'+mm+'/'+dd,{headers:{'User-Agent':'thisday.info/1.0'}})
    .then(function(r){return r.ok?r.json():null;})
    .then(function(d){
      var items=(d&&d.events)||[];
      var selected=items.slice(0,12);
      if(!selected.length){bar.style.display='none';return;}
      selected.forEach(function(e){
        var el=document.createElement('div');
        el.className='marquee-item';
        var yr=document.createElement('span');
        yr.textContent=e.year||'Unknown';
        el.appendChild(yr);
        var pages=e.pages&&e.pages[0];
        var url=pages&&pages.content_urls&&pages.content_urls.desktop&&pages.content_urls.desktop.page;
        var title=e.title||e.description||e.text||'Historical event';
        if(url){
          var a=document.createElement('a');
          a.href=url;a.target='_blank';a.rel='noopener noreferrer';
          a.style.color='inherit';
          a.style.textDecoration='none';
          a.textContent=title;
          el.appendChild(document.createTextNode(' '));
          el.appendChild(a);
        }else{
          var s=document.createElement('span');
          s.style.fontWeight='600';
          s.textContent=' '+title;
          el.appendChild(s);
        }
        track.appendChild(el);
      });
      track.innerHTML+=track.innerHTML;
      bar.style.display='block';
    }).catch(function(){});
})();
</script>`;
}

/** Nav CSS — extracted from css/custom.css. Paste into the page <style> block. */
export const NAV_CSS =
  `.site-chrome{position:sticky;top:0;z-index:1000;background:var(--bg);box-shadow:0 6px 18px rgba(27,58,45,.08)}` +
  `.nav{background:var(--bg);border-bottom:1px solid var(--border);padding:1rem 0;position:relative;z-index:2}` +
  `.nav-inner{padding:0 2rem;display:flex;align-items:center;width:100%;max-width:1920px;margin:0 auto;position:relative;z-index:2}` +
  `.brand{font-family:"Lora",Georgia,serif;font-size:1.5rem;font-weight:700;color:var(--text);text-decoration:none}` +
  `.brand:hover{color:var(--text);text-decoration:none}` +
  `.nav-links{display:flex;gap:1.5rem;font-size:.9rem;margin-left:auto}` +
  `.nav-links a{color:var(--text-muted);text-decoration:none;font-weight:500}` +
  `.nav-links a:hover{color:var(--text)}` +
  `.btn#navToggle{display:none;background:none;color:var(--text);padding:.4rem;margin-left:auto;position:relative;z-index:4;pointer-events:auto;cursor:pointer}` +
  `.btn#navToggle:hover{background:var(--bg-alt);color:var(--text)}` +
  `.btn#navToggle svg{width:20px;height:20px;display:block}` +
  `.nav-mobile{display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg);border-bottom:1px solid var(--border);padding:0 1.5rem;z-index:3}` +
  `.nav-mobile.active{display:block}` +
  `.nav-mobile a{display:block;padding:1rem 0;color:var(--text);text-decoration:none;font-size:1rem;border-bottom:1px solid var(--border)}` +
  `.nav-mobile a:last-child{border-bottom:none}` +
  `.mobile-menu-link{display:flex;align-items:center;gap:.5rem;padding:.75rem 0;color:var(--text);text-decoration:none;border-bottom:1px solid var(--border)}` +
  `.mobile-menu-link:last-child{border-bottom:none}` +
  `.mobile-menu-social{margin-top:.75rem;display:flex;gap:.6rem}` +
  `.mobile-menu-social a{color:var(--text);font-size:1.1rem}` +
  `@media(max-width:768px){.nav-links{display:none}.btn#navToggle{display:flex}.site-chrome{position:sticky}.nav{position:relative}}`;

/** @deprecated — kept for backward compat; will be removed when workers are updated. */
export const NAV_CSS_FALLBACK = "";

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

/**
 * Returns the canonical site footer HTML (matches index-new.html).
 * @param {string} yearSpanId  id for the copyright year <span> (default "yr")
 */
export function siteFooter(yearSpanId = "yr") {
  return `<footer class="footer">
  <div class="footer-inner">
    <div class="footer-social">
      <a href="https://github.com/Fugec" target="_blank" rel="noopener noreferrer" aria-label="GitHub"><i class="bi bi-github"></i></a>
      <a href="https://www.facebook.com/profile.php?id=61578009082537" target="_blank" rel="noopener noreferrer" aria-label="Facebook"><i class="bi bi-facebook"></i></a>
      <a href="https://www.instagram.com/thisday.info/" target="_blank" rel="noopener noreferrer" aria-label="Instagram"><i class="bi bi-instagram"></i></a>
      <a href="https://www.tiktok.com/@this__day" target="_blank" rel="noopener noreferrer" aria-label="TikTok"><i class="bi bi-tiktok"></i></a>
      <a href="https://www.youtube.com/@thisDay_info/shorts" target="_blank" rel="noopener noreferrer" aria-label="YouTube"><i class="bi bi-youtube"></i></a>
    </div>
    <div class="footer-text">
      <p>&copy; <span id="${yearSpanId}"></span> thisDay. All rights reserved.</p>
      <p>Historical data sourced from <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">Wikipedia.org under CC BY-SA 4.0</a> license.</p>
      <p>This website is not affiliated with any official historical organization. Content is for educational and entertainment purposes only.</p>
    </div>
    <div class="footer-bottom">
      <a href="https://buymeacoffee.com/fugec?new=1" target="_blank" rel="noopener noreferrer">Support This Project</a>
      <a href="/blog/">Blog</a>
      <a href="/about/">About</a>
      <a href="/contact/">Contact</a>
      <a href="/terms/">Terms</a>
      <a href="/privacy-policy/">Privacy</a>
    </div>
  </div>
</footer>`;
}

/** Footer CSS — extracted from css/custom.css. Paste into the page <style> block. */
export const FOOTER_CSS =
  `.footer{background:var(--bg-alt);color:var(--text);padding:2.5rem 1.5rem;margin-top:auto;border-top:1px solid var(--border)}` +
  `.footer-inner{max-width:1200px;margin:0 auto}` +
  `.footer-social{display:flex;justify-content:center;gap:1.5rem;margin-bottom:1.5rem;padding-bottom:1.5rem;border-bottom:1px solid var(--border)}` +
  `.footer-social a{color:var(--text);font-size:1.4rem;opacity:.7;transition:opacity .2s;text-decoration:none}` +
  `.footer-social a:hover{opacity:1;color:var(--text)}` +
  `.footer-text{text-align:center;font-size:.85rem;line-height:1.8;color:var(--text-muted)}` +
  `.footer-text p{margin:.25rem 0}` +
  `.footer-text a{color:var(--text);text-decoration:underline}` +
  `.footer-bottom{margin-top:1.5rem;padding-top:1.5rem;border-top:1px solid var(--border);text-align:center;font-size:.8rem;color:var(--text-muted)}` +
  `.footer-bottom a{color:var(--text);text-decoration:none;margin:0 .75rem}` +
  `.footer-bottom a:hover{text-decoration:underline}`;

// ---------------------------------------------------------------------------
// Inline scripts
// ---------------------------------------------------------------------------

/**
 * Inline JS snippet to populate the footer copyright year.
 * @param {string} spanId  must match the yearSpanId passed to siteFooter()
 */
export function footerYearScript(spanId = "yr") {
  return `(function(){var e=document.getElementById(${JSON.stringify(spanId)});if(e)e.textContent=new Date().getFullYear();})();`;
}

/**
 * Inline JS snippet for the mobile nav hamburger toggle.
 */
export function navToggleScript() {
  return `(function(){var t=document.getElementById("navToggle"),m=document.getElementById("navMobile");if(!t||!m||t.dataset.navReady==="true")return;t.dataset.navReady="true";function sync(){t.setAttribute("aria-expanded",m.classList.contains("active")?"true":"false");}function toggle(e){if(e)e.preventDefault();m.classList.toggle("active");sync();}t.addEventListener("click",toggle);t.addEventListener("touchend",toggle,{passive:false});document.addEventListener("click",function(e){if(!m.classList.contains("active"))return;if(e.target===t||t.contains(e.target)||m.contains(e.target))return;m.classList.remove("active");sync();});sync();})();`;
}
