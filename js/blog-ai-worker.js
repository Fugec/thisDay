/**
 * Cloudflare Worker — Blog Post Generator
 *
 * Runs on a cron trigger (daily at 06:00 UTC) and publishes a new blog post
 * every other day using Cloudflare Workers AI (free, no external API key).
 * Posts are stored in Cloudflare KV and served at:
 *   /blog/archive/         → listing of all published posts
 *   /blog/archive/[slug]/  → individual post page
 *
 * Manual trigger (for testing):
 *   POST /blog/publish     → immediately publishes today's post
 *
 * Required bindings: BLOG_AI_KV (KV namespace), AI (Workers AI)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Cloudflare Workers AI model — free tier, no API key needed.
const CF_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const KV_POST_PREFIX = "post:";
const KV_INDEX_KEY = "index";
const KV_LAST_GEN_KEY = "last_gen_date";
const EVERY_OTHER_DAYS = 1; // Generate every N days

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const MONTH_SLUGS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  /**
   * Cron trigger — runs daily, generates every other day.
   */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(maybeGenerateBlogPost(env));
  },

  /**
   * HTTP fetch handler — serves blog pages and the manual trigger endpoint.
   */
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    // Manual trigger (POST /blog/publish)
    // Requires:  Authorization: Bearer <PUBLISH_SECRET>
    if (path === "/blog/publish" && request.method === "POST") {
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.PUBLISH_SECRET || auth !== `Bearer ${env.PUBLISH_SECRET}`) {
        return jsonResponse({ status: "unauthorized" }, 401);
      }
      try {
        await generateAndStore(env);
        return jsonResponse({ status: "ok", message: "Blog post published." });
      } catch (err) {
        console.error(
          `Blog AI: /blog/publish generation failed — ${err.message}`,
        );
        const today = todayDateString();
        await env.BLOG_AI_KV.put(
          `error:${today}`,
          `Publish endpoint failed: ${err.message}`,
          { expirationTtl: 7 * 86_400 },
        );
        return jsonResponse({ status: "error", message: err.message }, 500);
      }
    }

    // Listing page: /blog/archive
    if (path === "/blog/archive") {
      return serveListing(env);
    }

    // JSON index used by the main blog page to dynamically render AI posts
    if (path === "/blog/archive.json") {
      const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
      const index = indexRaw ? JSON.parse(indexRaw) : [];
      return new Response(JSON.stringify(index), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    // Blog quiz API: /blog/quiz/{slug}
    const blogQuizMatch = path.match(/^\/blog\/quiz\/([^/]+)$/);
    if (blogQuizMatch) {
      const slug = blogQuizMatch[1];
      const quizRaw = await env.BLOG_AI_KV.get(`quiz:blog:${slug}`);
      if (quizRaw) {
        return new Response(quizRaw, {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=3600",
          },
        });
      }
      return new Response(JSON.stringify({ error: "Quiz not found" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Individual post: /blog/[slug]  (single-segment slugs only — e.g. /blog/20-february-2026)
    // Two-segment paths like /blog/august/1-2025/ are existing static posts — pass them through.
    const postMatch = path.match(/^\/blog\/([^/]+)$/);
    if (postMatch) {
      const slug = postMatch[1];
      const [html, ytRaw] = await Promise.all([
        env.BLOG_AI_KV.get(`${KV_POST_PREFIX}${slug}`),
        env.BLOG_AI_KV.get("youtube:uploaded"),
      ]);
      if (html) {
        // Patch old quiz API path in already-stored HTML
        let patchedHtml = html.replaceAll("/api/blog-quiz/", "/blog/quiz/");
        // Patch old btn-warning buttons to site-btn-primary
        patchedHtml = patchedHtml
          .replaceAll('class="site-btn site-btn-primary mt-2" id="tdq-cta-btn"', 'class="btn btn-sm btn-warning mt-2" id="tdq-cta-btn"')
          .replaceAll('class="btn btn-warning px-4 mt-3" id="tdq-submit-btn"', 'class="site-btn site-btn-primary mt-3" id="tdq-submit-btn"')
          .replaceAll('class="text-muted">Can you answer', 'class="tdq-cta-sub">Can you answer');
        // Patch old site-btn-primary submit button back to btn-warning
        patchedHtml = patchedHtml
          .replaceAll('class="site-btn site-btn-primary mt-3" id="tdq-submit-btn"', 'class="btn btn-warning mt-3" id="tdq-submit-btn"');
        // Inject quiz CTA + popup for old posts that don't have it
        if (!patchedHtml.includes("tdq-cta-btn")) {
          const quizCta = `
          <!-- Quiz CTA -->
          <div class="mt-4 p-3 rounded d-flex align-items-center gap-3" style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25)">
            <i class="bi bi-patch-question-fill" style="font-size:1.5rem;color:#f59e0b;flex-shrink:0"></i>
            <div>
              <strong style="color:var(--text-color)">Test Your Knowledge</strong><br/>
              <small class="tdq-cta-sub">Can you answer 5 questions about this event?</small><br/>
              <button class="btn btn-sm btn-warning mt-2" id="tdq-cta-btn" onclick="document.getElementById('tdq-overlay').style.display='block';document.getElementById('tdq-popup').style.display='block';requestAnimationFrame(function(){document.getElementById('tdq-popup').classList.add('tdq-popup-open');});document.body.style.overflow='hidden';if(typeof maybeLoadAndShowQuiz==='function')maybeLoadAndShowQuiz();">
                <i class="bi bi-play-fill me-1"></i>Take the Quiz
              </button>
            </div>
          </div>`;
          const quizBlock = `
  <!-- Quiz popup -->
  <div id="tdq-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9998" aria-hidden="true"></div>
  <div id="tdq-popup" role="dialog" aria-modal="true" aria-label="History Quiz" style="display:none;position:fixed;bottom:0;left:0;right:0;z-index:9999;max-height:90dvh;overflow-y:auto;background:var(--card-bg,#fff);border-radius:16px 16px 0 0;padding:24px 20px 32px;box-shadow:0 -4px 32px rgba(0,0,0,.18);font-family:Inter,sans-serif">
    <button id="tdq-close" aria-label="Close quiz" style="position:absolute;top:12px;right:16px;background:none;border:none;font-size:1.5rem;cursor:pointer;color:var(--text-color,#6c757d);line-height:1">&times;</button>
    <div id="tdq-topic" style="font-size:.72rem;font-weight:700;color:#f59e0b;text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px"></div>
    <h3 style="font-size:1.1rem;font-weight:700;margin-bottom:3px;color:var(--text-color,#1e293b)"><i class="bi bi-patch-question-fill me-2" style="color:#f59e0b"></i>Test Your Knowledge</h3>
    <p style="font-size:.85rem;color:var(--text-color,#6c757d);margin-bottom:6px;opacity:.8">Based on the article you just read — 5 questions, under a minute.</p>
    <div id="tdq-progress" style="font-size:.78rem;font-weight:600;color:#f59e0b;margin-bottom:16px">0 of 5 answered</div>
    <div id="tdq-questions"></div>
    <button class="btn btn-warning mt-3" id="tdq-submit-btn" style="display:none"><i class="bi bi-check2-circle me-1"></i>Check Answers</button>
    <div id="tdq-score" class="mt-3" hidden></div>
  </div>
  <div id="tdq-sentinel" style="height:1px"></div>
  <style>
    .tdq-question{margin-bottom:16px}.tdq-q-text{font-weight:600;margin-bottom:8px;font-size:.9rem;color:var(--text-color,#1e293b)}.tdq-options{display:flex;flex-direction:column;gap:7px}
    .tdq-opt{display:flex;align-items:center;gap:9px;padding:8px 12px;border:1.5px solid var(--card-border,#e2e8f0);border-radius:8px;cursor:pointer;font-size:.88rem;transition:background .15s,border-color .15s;user-select:none;color:var(--text-color,#1e293b)}
    .tdq-opt:hover{border-color:#3b82f6;background:rgba(59,130,246,.07)}.tdq-opt-selected{border-color:#3b82f6!important;background:rgba(59,130,246,.1)!important;font-weight:500}
    .tdq-opt-correct{border-color:#10b981!important;background:#d1fae5!important;color:#0f172a!important}.tdq-opt-wrong{border-color:#ef4444!important;background:#fee2e2!important;color:#0f172a!important}
    .tdq-opt-key{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#e2e8f0;font-size:.72rem;font-weight:700;flex-shrink:0}
    .tdq-opt-selected .tdq-opt-key{background:#3b82f6;color:#fff}.tdq-opt-correct .tdq-opt-key{background:#10b981;color:#fff}.tdq-opt-wrong .tdq-opt-key{background:#ef4444;color:#fff}
    body.dark-theme .tdq-opt{border-color:rgba(255,255,255,.15);color:#f8fafc}body.dark-theme .tdq-opt:hover{border-color:#60a5fa;background:rgba(96,165,250,.08)}
    body.dark-theme .tdq-opt-selected{border-color:#60a5fa!important;background:rgba(96,165,250,.15)!important}body.dark-theme .tdq-opt-key{background:#334155;color:#cbd5e1}
    body.dark-theme .tdq-opt-correct{background:rgba(16,185,129,.2)!important;border-color:#10b981!important;color:#e2e8f0!important}body.dark-theme .tdq-opt-wrong{background:rgba(239,68,68,.2)!important;border-color:#ef4444!important;color:#e2e8f0!important}
    .tdq-feedback{font-size:.82rem;margin-top:4px}.tdq-correct{color:#10b981;font-weight:600}.tdq-wrong{color:#ef4444;font-weight:600}
    .tdq-score-box{font-size:1rem;font-weight:600;padding:12px 14px;background:rgba(245,158,11,.1);border-radius:8px;border-left:4px solid #f59e0b}.tdq-score-num{color:#f59e0b;font-size:1.15rem}
    #tdq-popup{transition:transform .3s ease;transform:translateY(100%)}.tdq-popup-open{transform:translateY(0)!important}
    .tdq-cta-sub{color:#6c757d}body.dark-theme .tdq-cta-sub{color:#fff}
  </style>
  <script>
  (function () {
    var slug = "${slug}";
    var quizLoaded = false;
    var selected = {};
    var answers = [];
    function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
    function openPopup() {
      document.getElementById("tdq-overlay").style.display = "block";
      document.getElementById("tdq-popup").style.display = "block";
      requestAnimationFrame(function() { document.getElementById("tdq-popup").classList.add("tdq-popup-open"); });
      document.body.style.overflow = "hidden";
    }
    function closePopup() {
      var popup = document.getElementById("tdq-popup");
      popup.classList.remove("tdq-popup-open");
      setTimeout(function() { popup.style.display = "none"; document.getElementById("tdq-overlay").style.display = "none"; document.body.style.overflow = ""; }, 300);
    }
    document.getElementById("tdq-close").addEventListener("click", closePopup);
    document.getElementById("tdq-overlay").addEventListener("click", closePopup);
    function renderQuiz(quiz) {
      answers = quiz.questions.map(function(q) { return Number(q.answer); });
      var total = quiz.questions.length;
      var topicEl = document.getElementById("tdq-topic");
      if (topicEl) { var h1 = document.querySelector("h1"); if (h1) topicEl.textContent = "Quiz: " + h1.textContent.trim(); }
      var container = document.getElementById("tdq-questions");
      container.innerHTML = quiz.questions.map(function(q, qi) {
        var optsHtml = (q.options || []).map(function(opt, oi) {
          return '<div class="tdq-opt" data-qi="' + qi + '" data-oi="' + oi + '"><span class="tdq-opt-key">' + String.fromCharCode(65 + oi) + '</span>' + esc(String(opt)) + '</div>';
        }).join("");
        var expHtml = q.explanation ? '<div class="tdq-explanation" id="tdq-e-' + qi + '" hidden style="font-size:.82rem;margin-top:6px;padding:7px 11px;background:rgba(59,130,246,.07);border-left:3px solid #3b82f6;border-radius:0 6px 6px 0">' + esc(String(q.explanation)) + '</div>' : '';
        return '<div class="tdq-question" id="tdq-q-' + qi + '"><p class="tdq-q-text"><strong>' + (qi + 1) + '.</strong> ' + esc(String(q.q)) + '</p><div class="tdq-options">' + optsHtml + '</div><div class="tdq-feedback" id="tdq-f-' + qi + '" hidden></div>' + expHtml + '</div>';
      }).join("");
      container.querySelectorAll(".tdq-opt").forEach(function(opt) {
        opt.addEventListener("click", function() {
          var qi = parseInt(this.dataset.qi), oi = parseInt(this.dataset.oi);
          selected[qi] = oi;
          container.querySelectorAll('[data-qi="' + qi + '"]').forEach(function(o) { o.classList.remove("tdq-opt-selected"); });
          this.classList.add("tdq-opt-selected");
          var answered = Object.keys(selected).length;
          var progEl = document.getElementById("tdq-progress");
          if (progEl) progEl.textContent = answered + " of " + total + " answered";
          var allAnswered = quiz.questions.every(function(_, i) { return selected[i] !== undefined; });
          document.getElementById("tdq-submit-btn").style.display = allAnswered ? "" : "none";
        });
      });
    }
    document.getElementById("tdq-submit-btn").addEventListener("click", function() {
      var score = 0;
      answers.forEach(function(correct, qi) {
        var chosen = selected[qi] !== undefined ? selected[qi] : -1;
        var fb = document.getElementById("tdq-f-" + qi);
        var opts = document.querySelectorAll('[data-qi="' + qi + '"]');
        fb.hidden = false;
        opts.forEach(function(o) { o.style.pointerEvents = "none"; });
        opts[correct].classList.add("tdq-opt-correct");
        if (chosen === correct) { score++; fb.innerHTML = '<span class="tdq-correct">✓ Correct!</span>'; }
        else { if (chosen >= 0) opts[chosen].classList.add("tdq-opt-wrong"); fb.innerHTML = '<span class="tdq-wrong">✗ Incorrect.</span> Correct: <strong>' + String.fromCharCode(65 + correct) + '</strong>'; }
        var exp = document.getElementById("tdq-e-" + qi); if (exp) exp.hidden = false;
      });
      this.hidden = true;
      var pct = Math.round(score / answers.length * 100);
      var msg = pct === 100 ? "Perfect score!" : pct >= 80 ? "Excellent!" : pct >= 60 ? "Good job!" : "Keep learning!";
      var el = document.getElementById("tdq-score");
      el.hidden = false;
      el.innerHTML = '<div class="tdq-score-box">You scored <span class="tdq-score-num">' + score + '/' + answers.length + '</span> (' + pct + '%) — ' + msg + '</div>';
    });
    function maybeLoadAndShow() {
      if (quizLoaded) return; quizLoaded = true;
      fetch("/blog/quiz/" + slug)
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(quiz) { if (!quiz || !quiz.questions || quiz.questions.length < 3) return; renderQuiz(quiz); openPopup(); })
        .catch(function() {});
    }
    window.maybeLoadAndShowQuiz = maybeLoadAndShow;
    if (window.location.hash === "#quiz") { setTimeout(maybeLoadAndShow, 600); }
    if ("IntersectionObserver" in window) {
      var sentinel = document.getElementById("tdq-sentinel");
      var obs = new IntersectionObserver(function(entries) { if (entries[0].isIntersecting) { obs.disconnect(); setTimeout(maybeLoadAndShow, 800); } }, { threshold: 1.0 });
      obs.observe(sentinel);
    }
  })();
  <\/script>`;
          patchedHtml = patchedHtml.replace("</article>", quizCta + "\n        </article>");
          const bodyClose = patchedHtml.includes("</body>") ? "</body>" : "</html>";
          patchedHtml = patchedHtml.replace(bodyClose, quizBlock + "\n" + bodyClose);
        }
        // Inject scroll progress bar into older posts that were stored without it
        if (!patchedHtml.includes("read-progress")) {
          const progressCss = `<style>#read-progress{position:fixed;top:0;left:0;height:3px;width:0%;background:#3b82f6;z-index:9999;transition:width .1s linear;pointer-events:none}body.dark-theme #read-progress{background:#60a5fa}.site-btn{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border:1.5px solid var(--card-border,#e2e8f0);border-radius:8px;font-size:.875rem;font-weight:500;text-decoration:none;color:var(--text-color);background:transparent;cursor:pointer;transition:background .15s,border-color .15s,color .15s;user-select:none}.site-btn:hover{border-color:#3b82f6;background:rgba(59,130,246,.07)}.site-btn-primary{border-color:#3b82f6;color:#2563eb}.site-btn-primary:hover{background:rgba(59,130,246,.12);border-color:#2563eb;color:#1d4ed8}body.dark-theme .site-btn-primary{border-color:#60a5fa;color:#93c5fd}body.dark-theme .site-btn-primary:hover{background:rgba(96,165,250,.15);border-color:#93c5fd;color:#e0f2fe}.tdq-cta-sub{color:#6c757d}body.dark-theme .tdq-cta-sub{color:#fff}</style>`;
          const progressHtml = `<div id="read-progress" role="progressbar" aria-label="Reading progress" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"></div>`;
          const progressJs = `<script>(function(){var bar=document.getElementById('read-progress');if(!bar)return;document.addEventListener('scroll',function(){var doc=document.documentElement;var total=doc.scrollHeight-doc.clientHeight;var pct=total>0?Math.round((doc.scrollTop/total)*100):0;bar.style.width=pct+'%';bar.setAttribute('aria-valuenow',pct);},{passive:true});})();<\/script>`;
          patchedHtml = patchedHtml
            .replace("</head>", progressCss + "</head>")
            .replace("<nav ", progressHtml + "\n  <nav ")
            .replace("</body>", progressJs + "</body>");
          // If no </body>, append before </html>
          if (!patchedHtml.includes(progressJs)) {
            patchedHtml = patchedHtml.replace("</html>", progressJs + "</html>");
          }
        }
        const ytEntry = ytRaw ? (JSON.parse(ytRaw)[slug] ?? null) : null;
        if (ytEntry?.youtubeId && ytEntry.privacy !== "private") {
          const ytIframe = `<!-- YouTube -->
          <div class="my-4">
            <iframe
              width="100%"
              style="aspect-ratio:9/16;border:none;border-radius:8px"
              src="https://www.youtube.com/embed/${ytEntry.youtubeId}"
              title="Watch on YouTube"
              allowfullscreen
              loading="lazy"
            ></iframe>
          </div>

          <!-- Aftermath -->`;
          return htmlResponse(
            patchedHtml.replace(
              /<!-- YouTube -->[\s\S]*?<!-- Aftermath -->/,
              ytIframe,
            ),
          );
        }
        return htmlResponse(patchedHtml);
      }
    }

    // Pass through to origin; intercept 404 HTML responses with a helpful page.
    const originResponse = await fetch(request);
    if (
      originResponse.status === 404 &&
      (request.headers.get("Accept") ?? "").includes("text/html")
    ) {
      return serve404(env);
    }
    return originResponse;
  },
};

// ---------------------------------------------------------------------------
// Generation logic
// ---------------------------------------------------------------------------

/**
 * Checks the last generation date and generates a new post if enough days
 * have passed (every EVERY_OTHER_DAYS days).
 *
 * Retry strategy: tries up to 3 times with increasing delays so transient
 * CF Workers AI timeouts don't silently skip an entire day.
 */
async function maybeGenerateBlogPost(env) {
  const today = todayDateString(); // "YYYY-MM-DD"
  const lastGen = await env.BLOG_AI_KV.get(KV_LAST_GEN_KEY);

  if (lastGen) {
    const diffDays = Math.round(
      (new Date(today) - new Date(lastGen)) / 86_400_000,
    );
    if (diffDays < EVERY_OTHER_DAYS) {
      console.log(
        `Blog AI: last post was ${diffDays} day(s) ago — skipping (need ${EVERY_OTHER_DAYS}).`,
      );
      return;
    }
  }

  // Mark today as attempted before generating so tomorrow's cron always starts
  // from today's date regardless of whether generation succeeds or fails.
  await env.BLOG_AI_KV.put(KV_LAST_GEN_KEY, today);

  // Retry up to 3 times — CF Workers AI occasionally times out on the first attempt.
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await generateAndStore(env);
      console.log(
        `Blog AI: post generated successfully (attempt ${attempt}/3).`,
      );
      return;
    } catch (err) {
      lastError = err;
      console.error(`Blog AI: attempt ${attempt}/3 failed — ${err.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }

  // All attempts failed — persist error in KV so it's visible in the dashboard.
  const errMsg = lastError?.message ?? String(lastError);
  await env.BLOG_AI_KV.put(
    `error:${today}`,
    `Generation failed after 3 attempts: ${errMsg}`,
    { expirationTtl: 7 * 86_400 }, // auto-expire after 7 days
  );
  console.error(
    `Blog AI: all 3 attempts failed for ${today}. Error stored in KV.`,
  );
}

/**
 * Fetches a real image URL from the Wikipedia REST API for the given event title.
 * Falls back to null if the request fails or no image is found.
 */
async function fetchWikipediaImage(eventTitle, wikiUrl) {
  try {
    // Prefer the article slug from the wikiUrl so we hit the right page
    let title = eventTitle;
    if (wikiUrl) {
      const m = wikiUrl.match(/wikipedia\.org\/wiki\/(.+?)(?:\s|$)/);
      if (m) title = decodeURIComponent(m[1].split("#")[0]);
    }

    const ua = { "User-Agent": "thisday.info-blog/1.0 (https://thisday.info)" };

    // 1. REST summary — fastest, returns lead/thumbnail image
    const summaryRes = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      { headers: ua },
    );
    if (summaryRes.ok) {
      const d = await summaryRes.json();
      const img = d.thumbnail?.source ?? d.originalimage?.source ?? null;
      if (img) return img;
    }

    // 2. MediaWiki images list + imageinfo — catches infobox images not exposed
    //    by the REST summary (e.g. non-free images under /wikipedia/en/)
    const listRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=images&imlimit=10&format=json`,
      { headers: ua },
    );
    if (!listRes.ok) return null;
    const listData = await listRes.json();
    const page = Object.values(listData?.query?.pages ?? {})[0];
    const imageFiles = (page?.images ?? [])
      .map((i) => i.title)
      .filter(
        (t) =>
          /\.(jpe?g|png|webp|gif)$/i.test(t) &&
          !/icon|logo|flag|map|seal|coa/i.test(t),
      );

    if (!imageFiles.length) return null;

    const infoRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(imageFiles[0])}&prop=imageinfo&iiprop=url&format=json`,
      { headers: ua },
    );
    if (!infoRes.ok) return null;
    const infoData = await infoRes.json();
    const infoPage = Object.values(infoData?.query?.pages ?? {})[0];
    return infoPage?.imageinfo?.[0]?.url ?? null;
  } catch {
    return null;
  }
}

async function isWorkingImageUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return false;

    const headers = {
      "User-Agent": "thisday.info-blog/1.0 (https://thisday.info)",
    };

    // HEAD is cheap when supported.
    let res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers,
    });

    // Some CDNs disallow HEAD. Fallback to GET in that case.
    if (res.status === 405 || res.status === 403 || res.status === 501) {
      res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers,
      });
    }

    if (!res.ok) return false;
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    return contentType.startsWith("image/");
  } catch {
    return false;
  }
}

async function resolveWorkingImageForContent(content) {
  const candidates = [];

  if (content?.imageUrl) candidates.push(content.imageUrl);

  const wikiImage = await fetchWikipediaImage(
    content?.eventTitle,
    content?.wikiUrl,
  );
  if (wikiImage) candidates.push(wikiImage);

  // Try wikipedia URL title variant as a backup (decoded slug can differ from eventTitle).
  if (content?.wikiUrl) {
    try {
      const parsed = new URL(content.wikiUrl);
      const slug = parsed.pathname.split("/wiki/")[1];
      if (slug) {
        const slugTitle = decodeURIComponent(slug.split("#")[0]).replace(
          /_/g,
          " ",
        );
        const slugImage = await fetchWikipediaImage(slugTitle, null);
        if (slugImage) candidates.push(slugImage);
      }
    } catch {
      // ignore malformed URL
    }
  }

  const uniqueCandidates = [...new Set(candidates.filter(Boolean))];

  for (const candidate of uniqueCandidates) {
    if (await isWorkingImageUrl(candidate)) return candidate;
  }

  return null;
}

/**
 * Calls the Claude API, builds the HTML page, and persists everything to KV.
 */
async function generateAndStore(env) {
  const now = new Date();

  // Collect titles already published this month so the AI avoids duplicates
  const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
  const existingIndex = indexRaw ? JSON.parse(indexRaw) : [];
  const thisMonthPrefix = now.toISOString().slice(0, 7); // "YYYY-MM"
  const takenThisMonth = existingIndex
    .filter((e) => e.publishedAt && e.publishedAt.startsWith(thisMonthPrefix))
    .map((e) => e.title);

  let content = await callWorkersAI(env.AI, now, takenThisMonth);

  // Validate image URLs and fetch alternatives if broken.
  // If no working image is found, regenerate once with a different topic.
  const MAX_CONTENT_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_CONTENT_ATTEMPTS; attempt++) {
    const workingImage = await resolveWorkingImageForContent(content);
    if (workingImage) {
      content.imageUrl = workingImage;
      break;
    }

    if (attempt < MAX_CONTENT_ATTEMPTS) {
      const avoid = [...takenThisMonth, content.title].filter(Boolean);
      console.warn(
        `Blog AI: no valid image for \"${content.title}\". Regenerating content (${attempt + 1}/${MAX_CONTENT_ATTEMPTS}).`,
      );
      content = await callWorkersAI(env.AI, now, avoid);
      continue;
    }

    // No working image found after all attempts — throw so the caller retries
    // with a different topic rather than publishing with a logo background.
    throw new Error(
      `No working image for "${content.title}" after ${MAX_CONTENT_ATTEMPTS} attempts.`,
    );
  }

  // Ensure meta description meets minimum SEO length (120 chars)
  if (!content.description || content.description.length < 120) {
    const loc = content.location ? ` in ${content.location}` : "";
    content.description =
      `Discover the story of ${content.eventTitle} on ${content.historicalDate}${loc}. Learn about this pivotal historical event, its causes, immediate aftermath, and lasting legacy.`.substring(
        0,
        155,
      );
  }
  if (!content.ogDescription || content.ogDescription.length < 80) {
    content.ogDescription = content.description.substring(0, 130);
  }
  if (!content.twitterDescription || content.twitterDescription.length < 60) {
    content.twitterDescription = content.description.substring(0, 120);
  }

  const slug = buildSlug(now);
  const html = buildPostHTML(content, now, slug, existingIndex);

  // Persist the rendered page (no expiry — permanent archive)
  await env.BLOG_AI_KV.put(`${KV_POST_PREFIX}${slug}`, html);

  // Update the index (reuse the already-loaded existingIndex)
  const index = [...existingIndex];

  // Add or update the index entry for this slug
  const existingIdx = index.findIndex((e) => e.slug === slug);
  const entry = {
    slug,
    title: content.title,
    description: content.description,
    imageUrl: content.imageUrl,
    publishedAt: now.toISOString(),
  };
  if (existingIdx !== -1) {
    index[existingIdx] = entry;
  } else {
    index.unshift(entry);
  }
  // Cap the index at 200 entries
  if (index.length > 200) index.splice(200);
  await env.BLOG_AI_KV.put(KV_INDEX_KEY, JSON.stringify(index));

  // Purge the cached sitemap and RSS feed so they reflect the new post immediately
  // (both workers cache for 1 h — without this, the new post would be invisible
  //  to crawlers until the next cache expiry).
  const cache = caches.default;
  await Promise.allSettled([
    cache.delete(new Request("https://thisday.info/sitemap.xml")),
    cache.delete(new Request("https://thisday.info/rss.xml")),
    cache.delete(new Request("https://thisday.info/news-sitemap.xml")),
  ]);

  // Generate and store a quiz for this blog post
  try {
    const quiz = await generateBlogQuiz(env.AI, content, slug);
    if (quiz) {
      await env.BLOG_AI_KV.put(`quiz:blog:${slug}`, JSON.stringify(quiz), {
        expirationTtl: 90 * 86_400,
      });
    }
  } catch (e) {
    console.error("Blog quiz generation failed:", e);
  }

  console.log(
    `Blog: published post "${content.title}" → /blog/archive/${slug}/`,
  );
}

// ---------------------------------------------------------------------------
// Blog quiz generation
// ---------------------------------------------------------------------------

async function generateBlogQuiz(ai, content, _slug) {
  if (!ai) return null;

  const contextLines = [
    `Title: ${content.title}`,
    `Event: ${content.eventTitle} on ${content.historicalDate}`,
    `Location: ${content.location}, ${content.country}`,
    content.description
      ? `Summary: ${content.description.substring(0, 300)}`
      : "",
    ...(content.keyFacts || []).slice(0, 5).map((f) => `Fact: ${f}`),
  ].filter(Boolean);

  const aiTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("AI timeout")), 12000),
  );
  const aiResult = await Promise.race([
    ai.run(CF_AI_MODEL, {
      messages: [
        {
          role: "system",
          content:
            "You are a history quiz creator. Always respond with valid JSON only, no markdown, no extra text.",
        },
        {
          role: "user",
          content: `Generate a 5-question multiple choice quiz based on this historical blog post.\n\nContext:\n${contextLines.join("\n")}\n\nRules:\n- Exactly 5 questions\n- Each question has exactly 4 options\n- Exactly one correct answer per question (0-based index in "answer")\n- Questions must be specific and fact-based from the content above\n- Each question must include a short "explanation" field (1-2 sentences) that tells the reader WHY the answer is correct, reinforcing what they just read\n- Output ONLY valid JSON:\n{"questions":[{"q":"Question?","options":["A","B","C","D"],"answer":0,"explanation":"Why this answer is correct."}]}`,
        },
      ],
      max_tokens: 1500,
    }),
    aiTimeout,
  ]);

  const rawValue =
    aiResult.response ?? aiResult.choices?.[0]?.message?.content ?? "";
  const raw = (
    typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue)
  ).trim();
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!objMatch) return null;
  let parsed;
  try {
    parsed = JSON.parse(objMatch[0]);
  } catch (parseErr) {
    console.error("Blog quiz JSON.parse failed:", parseErr);
    return null;
  }
  if (!Array.isArray(parsed?.questions) || parsed.questions.length < 3)
    return null;
  return parsed;
}

// ---------------------------------------------------------------------------
// Claude API call
// ---------------------------------------------------------------------------

async function callWorkersAI(ai, date, takenThisMonth = []) {
  const monthName = MONTH_NAMES[date.getMonth()];
  const day = date.getDate();

  const avoidSection =
    takenThisMonth.length > 0
      ? `\nThese topics have already been covered this month — do NOT write about any of them:\n${takenThisMonth.map((t) => `- ${t}`).join("\n")}\nChoose a completely different event.\n`
      : "";

  const prompt = `You are a historical content writer for "thisDay.info", a website about historical events.

STRICT DATE REQUIREMENT: You MUST write about an event that occurred on ${monthName} ${day} ONLY. The event must have taken place in the month of ${monthName} on day ${day}. Events from ANY other month or day are strictly forbidden. Before choosing an event, verify it happened on ${monthName} ${day}. If you are not certain an event occurred on ${monthName} ${day}, choose a different event you are confident about.

Write a detailed, engaging blog post about a significant historical event that occurred on ${monthName} ${day} (any year). Choose the most interesting or impactful event for this exact date.
${avoidSection}
The article must be thorough and long — at least 800 words of body content — with multiple sections including eyewitness accounts, aftermath, and a personal editorial analysis of what went right and wrong about the event or the response to it.

Writing style rules:
- Do not use dashes ("-" or "—") inside sentences. Use commas, periods, or rewrite the sentence instead.
- Write in a natural, human tone. Avoid bullet-point thinking inside paragraphs.

Reply with ONLY a raw JSON object. No markdown, no code fences, no explanation — just the JSON.

{
  "title": "Event Name — ${monthName} ${day}, Year",
  "eventTitle": "Short event name",
  "historicalDate": "Month Day, Year",
  "historicalYear": 1234,
  "historicalDateISO": "YYYY-MM-DD",
  "location": "City, Country",
  "country": "Country",
  "description": "Meta description between 120-155 characters. Must be specific, keyword-rich, and describe the event, its date, and significance.",
  "ogDescription": "Open Graph description between 100-130 characters, engaging and specific.",
  "twitterDescription": "Twitter description between 90-120 characters, punchy and specific.",
  "keywords": "keyword1, keyword2, keyword3, keyword4, keyword5",
  "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/thumb/example.jpg",
  "imageAlt": "Alt text for the image",
  "jsonLdName": "Event name",
  "jsonLdDescription": "Schema.org description one or two sentences",
  "jsonLdUrl": "https://en.wikipedia.org/wiki/Article",
  "organizerName": "Key figure or organization",
  "readingTimeMinutes": 8,
  "quickFacts": [
    { "label": "Event", "value": "Full event name" },
    { "label": "Date", "value": "Month Day, Year" },
    { "label": "Location", "value": "Place" },
    { "label": "Key Figure", "value": "Name" },
    { "label": "Significance", "value": "Why it matters" },
    { "label": "Legacy", "value": "Long-term impact" }
  ],
  "didYouKnowFacts": [
    "Surprising or lesser-known fact about the event, 1 to 2 sentences.",
    "Another interesting detail readers might not expect, 1 to 2 sentences.",
    "A third fact that adds color or context to the main story, 1 to 2 sentences."
  ],
  "overviewParagraphs": [
    "First paragraph: context and background leading up to the event, 4 to 5 sentences.",
    "Second paragraph: what happened — the main events, key actors, turning points, 4 to 5 sentences.",
    "Third paragraph: immediate consequences and how people reacted in the moment, 4 to 5 sentences.",
    "Fourth paragraph: broader context — how this fits into the larger history of the period, 3 to 4 sentences."
  ],
  "eyewitnessOrChronicle": [
    "First paragraph about contemporary accounts, documents, or eyewitness descriptions of the event, 4 to 5 sentences. Include the name of the source if known.",
    "Second paragraph with a paraphrased quote or summary of another account, or elaboration on what survivors or observers reported, 3 to 4 sentences.",
    "Optional third paragraph addressing the reliability of sources — what historians accept, what is disputed, and why, 3 to 4 sentences."
  ],
  "eyewitnessQuote": "A short paraphrased or real quote from a contemporary source about the event, under 200 characters.",
  "eyewitnessQuoteSource": "Name of the source, e.g. 'John Smith, Diary, 1776'",
  "aftermathParagraphs": [
    "First paragraph about immediate aftermath — what changed physically, politically, or socially in the weeks and months after the event, 4 to 5 sentences.",
    "Second paragraph about medium-term consequences — reforms, rebuilding, institutional changes, reactions from other nations or groups, 4 to 5 sentences.",
    "Third paragraph about long-term legacy — how historians view it today, what monuments or traditions commemorate it, and what was ultimately forgotten or ignored, 3 to 4 sentences."
  ],
  "conclusionParagraphs": [
    "First conclusion paragraph summarizing the event's place in history, 3 to 4 sentences.",
    "Second conclusion paragraph about its relevance to the modern world, 2 to 3 sentences.",
    "Third conclusion paragraph with a thought-provoking closing observation, 2 to 3 sentences."
  ],
  "analysisGood": [
    { "title": "Short label for what went right", "detail": "2 to 3 sentences explaining this positive aspect, who deserves credit, and why it mattered." },
    { "title": "Another positive aspect", "detail": "2 to 3 sentences of explanation." },
    { "title": "A third positive aspect", "detail": "2 to 3 sentences of explanation." }
  ],
  "analysisBad": [
    { "title": "Short label for what went wrong", "detail": "2 to 3 sentences explaining this failure, who is responsible, and what the consequences were." },
    { "title": "Another failure or missed opportunity", "detail": "2 to 3 sentences of explanation." },
    { "title": "A third thing that went wrong", "detail": "2 to 3 sentences of explanation." },
    { "title": "Optional fourth point about institutional or systemic failure", "detail": "2 to 3 sentences of explanation." }
  ],
  "editorialNote": "A 3 to 4 sentence personal editorial reflection from the thisDay. team — a frank, opinionated observation about what this event reveals about human nature, institutions, or history in general. Write in first-person plural (we think, what strikes us).",
  "wikiUrl": "https://en.wikipedia.org/wiki/Article",
  "youtubeSearchQuery": "specific event name year history documentary"
}`;

  const result = await ai.run(CF_AI_MODEL, {
    messages: [
      {
        role: "system",
        content:
          "You are a historical content writer. Always respond with valid JSON only, no markdown, no extra text.",
      },
      { role: "user", content: prompt },
    ],
    max_tokens: 4096,
  });

  // Handle different response shapes across CF AI models:
  // - Some models return { response: "string" }
  // - Chat models return { choices: [{ message: { content: "string" } }] }
  // - Some models return the parsed JSON object directly
  const rawValue =
    result.response ?? result.choices?.[0]?.message?.content ?? result;
  if (
    !rawValue ||
    (typeof rawValue === "string" && rawValue.trim().length < 100)
  ) {
    throw new Error(
      `AI response too short or empty (${String(rawValue).length} chars)`,
    );
  }

  let parsed;
  if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
    parsed = rawValue; // Model already returned parsed JSON object
  } else {
    const raw = (
      typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue)
    ).trim();
    // Strip any accidental markdown code fences the model may add
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();

    // Extract the first {...} block in case the model adds surrounding text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch)
      throw new Error(`No JSON found in model output: ${raw.slice(0, 200)}`);

    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      throw new Error(
        `JSON parse failed: ${e.message} — Raw: ${raw.slice(0, 300)}`,
      );
    }
  }

  // Enforce that the title always contains the date (Month Day, Year).
  // The AI sometimes omits it or uses a wrong format.
  const year = parsed.historicalYear ?? date.getFullYear();
  const expectedDateSuffix = `${monthName} ${day}, ${year}`;
  if (!parsed.title || !parsed.title.includes(monthName)) {
    // Strip any existing trailing date-like pattern and append the correct one
    const cleanTitle = (parsed.title ?? parsed.eventTitle ?? "Untitled")
      .replace(/[—:\-]\s*\w+ \d{1,2},\s*\d{4}\s*$/, "")
      .trim();
    parsed.title = `${cleanTitle} — ${expectedDateSuffix}`;
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// HTML builders
// ---------------------------------------------------------------------------

/**
 * Builds the full blog post HTML page, matching the structure of existing
 * hand-written posts on thisday.info.
 */
function buildPostHTML(c, date, slug, allPosts = []) {
  const monthName = MONTH_NAMES[date.getMonth()];
  const day = date.getDate();
  const publishYear = date.getFullYear();
  const canonicalUrl = `https://thisday.info/blog/${slug}/`;
  const publishedStr = `${monthName} ${day}, ${publishYear}`;

  const quickFactsRows = (c.quickFacts || [])
    .map(
      (f) =>
        `              <tr><th scope="row">${esc(f.label)}</th><td>${esc(f.value)}</td></tr>`,
    )
    .join("\n");

  const didYouKnowItems = (c.didYouKnowFacts || [])
    .map((f) => `              <li>${esc(f)}</li>`)
    .join("\n");

  const overviewParas = (c.overviewParagraphs || [])
    .map((p) => `            <p>${esc(p)}</p>`)
    .join("\n");

  const eyewitnessParas = (c.eyewitnessOrChronicle || [])
    .map((p) => `            <p>${esc(p)}</p>`)
    .join("\n");

  const eyewitnessQuoteBlock = c.eyewitnessQuote
    ? `          <blockquote class="historical-quote mt-3">
            <p>"${esc(c.eyewitnessQuote)}"</p>
            <footer class="article-meta">${esc(c.eyewitnessQuoteSource || "Contemporary source")}</footer>
          </blockquote>`
    : "";

  const aftermathParas = (c.aftermathParagraphs || [])
    .map((p) => `            <p>${esc(p)}</p>`)
    .join("\n");

  const conclusionParas = (c.conclusionParagraphs || [])
    .map((p) => `            <p>${esc(p)}</p>`)
    .join("\n");

  const analysisGoodItems = (c.analysisGood || [])
    .map(
      (item) =>
        `                    <li class="mb-2"><strong>${esc(item.title)}:</strong> ${esc(item.detail)}</li>`,
    )
    .join("\n");

  const analysisBadItems = (c.analysisBad || [])
    .map(
      (item) =>
        `                    <li class="mb-2"><strong>${esc(item.title)}:</strong> ${esc(item.detail)}</li>`,
    )
    .join("\n");

  const editorialNote = c.editorialNote
    ? `          <p class="mt-4 fst-italic" style="font-size: 0.93rem; opacity: 0.85; border-left: 3px solid #3b82f6; padding-left: 1rem;">
            ${esc(c.editorialNote)}
          </p>`
    : "";

  const readingTime = c.readingTimeMinutes
    ? `&nbsp;|&nbsp;${esc(String(c.readingTimeMinutes))} min read`
    : "";

  const publishedDateISO = date.toISOString().split("T")[0];
  const jsonLd = JSON.stringify(
    {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      mainEntityOfPage: { "@type": "WebPage", "@id": canonicalUrl },
      headline: c.title,
      datePublished: publishedDateISO,
      dateModified: publishedDateISO,
      inLanguage: "en",
      articleSection: "History",
      author: {
        "@type": "Person",
        name: "thisDay.info Editorial Team",
        url: "https://thisday.info/about/",
      },
      publisher: {
        "@type": "Organization",
        name: "thisDay.info",
        logo: {
          "@type": "ImageObject",
          url: "https://thisday.info/images/logo.png",
        },
      },
      description: c.jsonLdDescription || c.description,
      image: c.imageUrl,
      url: canonicalUrl,
      about: {
        "@type": "Event",
        name: c.jsonLdName || c.eventTitle,
        startDate: c.historicalDateISO || String(c.historicalYear),
        description: c.jsonLdDescription || c.description,
        location: {
          "@type": "Place",
          name: c.location,
          address: { "@type": "PostalAddress", addressCountry: c.country },
        },
        url: c.wikiUrl || c.jsonLdUrl,
        eventStatus: "https://schema.org/EventCompleted",
        organizer: { "@type": "Organization", name: c.organizerName },
      },
    },
    null,
    2,
  );

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="X-UA-Compatible" content="ie=edge" />
    <title>${esc(c.title)} | thisDay.</title>
    <link rel="canonical" href="${canonicalUrl}" />
    <meta name="robots" content="index, follow" />
    <meta name="description" content="${esc(c.description)}" />
    <meta name="keywords" content="${esc(c.keywords)}" />

    <!-- Open Graph -->
    <meta property="og:title" content="${esc(c.title)}" />
    <meta property="og:description" content="${esc(c.ogDescription || c.description)}" />
    <meta property="og:type" content="article" />
    <meta property="og:url" content="${canonicalUrl}" />
    <meta property="og:image" content="${esc(c.imageUrl)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:locale" content="en_US" />
    <meta property="og:site_name" content="thisDay." />
    <meta property="article:published_time" content="${date.toISOString()}" />
    <meta property="article:modified_time" content="${date.toISOString()}" />
    <meta property="article:section" content="History" />
    <meta property="article:author" content="https://thisday.info/" />
    ${(c.keywords || "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
      .slice(0, 6)
      .map((k) => `<meta property="article:tag" content="${esc(k)}" />`)
      .join("\n    ")}

    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(c.title)}" />
    <meta name="twitter:description" content="${esc(c.twitterDescription || c.description)}" />
    <meta name="twitter:image" content="${esc(c.imageUrl)}" />
    <meta name="twitter:image:alt" content="${esc(c.imageAlt)}" />

    <!-- JSON-LD Schema -->
    <script type="application/ld+json">
${jsonLd}
    </script>
    <script type="application/ld+json">
${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: `What was ${esc(c.eventTitle)}?`,
      acceptedAnswer: {
        "@type": "Answer",
        text: esc(c.jsonLdDescription || c.description),
      },
    },
    {
      "@type": "Question",
      name: `When and where did ${esc(c.eventTitle)} take place?`,
      acceptedAnswer: {
        "@type": "Answer",
        text: `${esc(c.eventTitle)} took place on ${esc(c.historicalDate)} in ${esc(c.location)}.`,
      },
    },
    {
      "@type": "Question",
      name: `What was the historical significance of ${esc(c.eventTitle)}?`,
      acceptedAnswer: {
        "@type": "Answer",
        text: esc(
          (c.quickFacts || []).find((f) => f.label === "Significance")?.value ||
            c.description,
        ),
      },
    },
  ],
})}
    </script>
    <script type="application/ld+json">
${JSON.stringify({
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
      name: "Blog",
      item: "https://thisday.info/blog/",
    },
    { "@type": "ListItem", position: 3, name: c.title, item: canonicalUrl },
  ],
})}
    </script>

    <link rel="icon" href="/images/favicon.ico" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/css/style.css" />

    <script async src="https://www.googletagmanager.com/gtag/js?id=G-WXEZ3868VN"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag() { dataLayer.push(arguments); }
      gtag("js", new Date());
      gtag("config", "G-WXEZ3868VN");
      gtag("config", "AW-17262488503");
    </script>
    <script>
      function gtag_report_conversion(url) {
        var callback = function () { if (typeof url != "undefined") { window.location = url; } };
        gtag("event", "conversion", { send_to: "AW-17262488503/WsLuCMLVweEaELfXsqdA", event_callback: callback });
        return false;
      }
    </script>
    <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8565025017387209" crossorigin="anonymous"></script>

    <style>
      :root {
        --link-hover-color: #1d4ed8;
        --primary-bg: #3b82f6;
        --secondary-bg: #fff;
        --text-color: #6c757d;
        --header-text-color: #ffffff;
        --card-bg: #ffffff;
        --card-border: #e2e8f0;
        --footer-bg: #3b82f6;
        --footer-text-color: #ffffff;
        --link-color: #2563eb;
        --switch-track-off: #e2e8f0;
        --switch-thumb-off: #cbd5e1;
        --switch-track-on: #2563eb;
        --switch-thumb-on: #ffffff;
        --border-radius: 0.5rem;
        background-color: var(--secondary-bg);
        color: var(--text-color);
      }
      body.dark-theme {
        --primary-bg: #020617;
        --secondary-bg: #1e293b;
        --text-color: #f8fafc;
        --header-text-color: #ffffff;
        --card-bg: #1e293b;
        --card-border: #334155;
        --footer-bg: #020617;
        --footer-text-color: #ffffff;
        --link-color: #60a5fa;
        --switch-track-off: #334155;
        --switch-thumb-off: #64748b;
        --switch-track-on: #2563eb;
        --switch-thumb-on: #f8fafc;
        background-color: var(--secondary-bg) !important;
        color: var(--text-color) !important;
      }
      body {
        font-family: Inter, sans-serif;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        transition: background-color 0.3s ease, color 0.3s ease;
      }
      .navbar {
        background-color: var(--primary-bg) !important;
        transition: background-color 0.3s ease;
        position: sticky;
        top: 0;
        z-index: 1030;
      }
      .navbar-brand, .navbar-nav .nav-link {
        color: var(--header-text-color) !important;
        font-weight: bold !important;
      }
      main { flex: 1; margin-top: 20px; }
      .footer .text-muted { color: rgba(255,255,255,0.85) !important; }
      .article-meta { color: #6c757d; font-size: 0.875rem; }
      body.dark-theme .article-meta { color: #94a3b8; }
      .breadcrumb { background: transparent; padding: 0; margin-bottom: 1rem; }
      body.dark-theme .breadcrumb-item a { color: #60a5fa; }
      body.dark-theme .breadcrumb-item.active { color: #94a3b8; }
      body.dark-theme .breadcrumb-item + .breadcrumb-item::before { color: #64748b; }
      .did-you-know { background: rgba(59,130,246,0.08); border-left: 4px solid #3b82f6; border-radius: 0 0.5rem 0.5rem 0; }
      body.dark-theme .did-you-know { background: rgba(59,130,246,0.15); }
      .analysis-good { background: rgba(34,197,94,0.08); border: 1px solid rgba(34,197,94,0.3); }
      body.dark-theme .analysis-good { background: rgba(34,197,94,0.1); border-color: rgba(34,197,94,0.25); }
      .analysis-bad { background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.3); }
      body.dark-theme .analysis-bad { background: rgba(239,68,68,0.1); border-color: rgba(239,68,68,0.25); }
      .related-card { border: 1px solid var(--card-border); background: var(--card-bg); transition: transform 0.15s ease, box-shadow 0.15s ease; }
      .related-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-decoration: none; }
      blockquote.historical-quote { border-left: 3px solid #3b82f6; padding-left: 1rem; margin-left: 0.5rem; font-style: italic; }
      body.dark-theme blockquote.historical-quote footer { color: #94a3b8; }
      .border {
        border: 1px solid var(--card-border);
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      }
      body.dark-theme .border {
        border: 1px solid #334255 !important;
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      }
      .footer {
        background-color: var(--footer-bg);
        color: var(--footer-text-color);
        text-align: center;
        padding: 20px;
        margin-top: 30px;
        transition: background-color 0.3s ease, color 0.3s ease;
      }
      .footer a { color: var(--footer-text-color); text-decoration: underline; }
      .btn-outline-primary {
        color: #6f787f;
        border-color: #e2e8f0;
        background: #fff;
        transition: color 0.3s ease, background-color 0.3s ease, border-color 0.3s ease;
      }
      body.dark-theme .btn-outline-primary {
        border-color: #334255;
        color: #f8fafc;
        background-color: #1d293b;
      }
      .theme-switch-desktop label { color: var(--header-text-color); }
      .theme-switch-mobile label i { color: var(--header-text-color); font-size: 1.2rem; margin-left: 0.5rem; }
      #read-progress{position:fixed;top:0;left:0;height:3px;width:0%;background:#3b82f6;z-index:9999;transition:width .1s linear;pointer-events:none}
      body.dark-theme #read-progress{background:#60a5fa}
      .site-btn{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border:1.5px solid var(--card-border,#e2e8f0);border-radius:8px;font-size:.875rem;font-weight:500;text-decoration:none;color:var(--text-color);background:transparent;cursor:pointer;transition:background .15s,border-color .15s,color .15s;user-select:none}
      .site-btn:hover{border-color:#3b82f6;background:rgba(59,130,246,.07)}
      .site-btn-primary{border-color:#3b82f6;color:#2563eb}
      .site-btn-primary:hover{background:rgba(59,130,246,.12);border-color:#2563eb;color:#1d4ed8}
      body.dark-theme .site-btn-primary{border-color:#60a5fa;color:#93c5fd}
      body.dark-theme .site-btn-primary:hover{background:rgba(96,165,250,.15);border-color:#93c5fd;color:#e0f2fe}
      .tdq-cta-sub{color:#6c757d}
      body.dark-theme .tdq-cta-sub{color:#fff}
    </style>
  </head>
  <body>

  <div id="read-progress" role="progressbar" aria-label="Reading progress" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"></div>
  <nav class="navbar navbar-expand-lg navbar-dark bg-primary">
    <div class="container-fluid">
      <a class="navbar-brand" href="/">thisDay.</a>
      <div class="form-check form-switch theme-switch-mobile d-lg-none me-2">
        <input class="form-check-input" type="checkbox" id="themeSwitchMobile" aria-label="Toggle dark mode" />
        <label class="form-check-label" for="themeSwitchMobile">
          <i class="bi bi-brightness-high-fill"></i>
        </label>
      </div>
      <div class="collapse navbar-collapse" id="navbarNav">
        <ul class="navbar-nav ms-auto">
          <li class="nav-item d-flex align-items-center">
            <div class="form-check form-switch theme-switch-desktop d-none d-lg-block me-2">
              <input class="form-check-input" type="checkbox" id="themeSwitchDesktop" aria-label="Toggle dark mode" />
              <label class="form-check-label" for="themeSwitchDesktop">Dark Mode</label>
            </div>
          </li>
        </ul>
      </div>
    </div>
  </nav>

  <main class="container my-5">
    <div class="row justify-content-center">
      <div class="col-lg-10 col-xl-8">
        <!-- Breadcrumb -->
        <nav aria-label="breadcrumb" class="mb-3">
          <ol class="breadcrumb">
            <li class="breadcrumb-item"><a href="/">Home</a></li>
            <li class="breadcrumb-item"><a href="/blog/">Blog</a></li>
            <li class="breadcrumb-item active" aria-current="page">${esc(c.eventTitle)}</li>
          </ol>
        </nav>

        <article class="p-4 rounded border shadow-sm" style="background-color: var(--card-bg); color: var(--text-color)">

          <header class="mb-4 text-center">
            <h1 class="mb-2 fw-bold">${esc(c.title)}</h1>
            <p class="article-meta mb-0">
              <small>
                Published: ${esc(publishedStr)} &nbsp;|&nbsp;
                Event Date: ${esc(c.historicalDate)} &nbsp;|&nbsp;
                By <a href="/about/" rel="author" style="color:inherit">thisDay. Editorial Team</a>${readingTime}
              </small>
            </p>
          </header>

          <figure class="text-center mb-4">
            <img
              src="/image-proxy?src=${encodeURIComponent(c.imageUrl)}&w=800&q=85"
              srcset="/image-proxy?src=${encodeURIComponent(c.imageUrl)}&w=400 400w, /image-proxy?src=${encodeURIComponent(c.imageUrl)}&w=800 800w"
              sizes="(max-width:640px) 100vw, 800px"
              class="img-fluid rounded"
              alt="${esc(c.imageAlt)}"
              style="max-height: 400px; object-fit: cover; width: 100%"
              loading="eager"
              onerror="this.onerror=null;this.removeAttribute('srcset');"
            />
            <figcaption class="article-meta mt-2">
              <small>Image courtesy of <a href="https://commons.wikimedia.org/" target="_blank" rel="noopener noreferrer">Wikimedia Commons</a>.</small>
            </figcaption>
          </figure>

          <!-- Quick Facts -->
          <h2 class="mt-4 h3">Quick Facts</h2>
          <table class="table table-bordered">
            <tbody>
${quickFactsRows}
            </tbody>
          </table>

          <!-- Did You Know -->
          ${
            didYouKnowItems
              ? `<div class="did-you-know p-3 rounded mb-4">
            <strong>Did You Know?</strong>
            <ul class="mb-0 mt-2">
${didYouKnowItems}
            </ul>
          </div>`
              : ""
          }

          <!-- Overview -->
          <section class="mt-4">
            <h2 class="h3">Overview: ${esc(c.eventTitle)}</h2>
${overviewParas}
          </section>

          <!-- Eyewitness / Chronicle Accounts -->
          ${
            eyewitnessParas
              ? `<section class="mt-5">
            <h2 class="h3">Eyewitness Accounts of ${esc(c.eventTitle)}</h2>
${eyewitnessParas}
${eyewitnessQuoteBlock}
          </section>`
              : ""
          }

          <!-- YouTube -->
          <div class="my-4 p-4 rounded" style="background:#ff0000;color:#fff;">
            <div style="font-weight:700;font-size:1.05rem;margin-bottom:4px">Watch on YouTube</div>
            <div style="font-size:0.88rem;opacity:0.9;margin-bottom:10px">
              Find documentaries and videos about: ${esc(c.eventTitle)}
            </div>
            <a
              href="https://www.youtube.com/results?search_query=${encodeURIComponent(c.youtubeSearchQuery || c.eventTitle)}"
              target="_blank"
              rel="noopener noreferrer"
              style="display:inline-block;background:#fff;color:#ff0000;font-weight:700;padding:6px 16px;border-radius:4px;text-decoration:none;font-size:0.9rem;"
            >Search Videos</a>
          </div>

          <!-- Aftermath -->
          ${
            aftermathParas
              ? `<section class="mt-5">
            <h2 class="h3">Aftermath of ${esc(c.eventTitle)}</h2>
${aftermathParas}
          </section>`
              : ""
          }

          <!-- Conclusion -->
          <section class="mt-5">
            <h2 class="h3">Legacy of ${esc(c.eventTitle)}</h2>
${conclusionParas}
          </section>

          <!-- Personal Analysis -->
          ${
            analysisGoodItems || analysisBadItems
              ? `<section class="mt-5">
            <h2 class="h3">Our Take: What Went Right &amp; What Went Wrong</h2>
            <div class="row g-3 mt-1">
              <div class="col-md-6">
                <div class="analysis-good p-3 rounded h-100">
                  <h3 style="color:#16a34a">What Went Right</h3>
                  <ul class="mb-0">
${analysisGoodItems}
                  </ul>
                </div>
              </div>
              <div class="col-md-6">
                <div class="analysis-bad p-3 rounded h-100">
                  <h3 style="color:#dc2626">What Went Wrong</h3>
                  <ul class="mb-0">
${analysisBadItems}
                  </ul>
                </div>
              </div>
            </div>
            ${editorialNote}
          </section>`
              : ""
          }

          <!-- Quiz CTA -->
          <div class="mt-4 p-3 rounded d-flex align-items-center gap-3" style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25)">
            <i class="bi bi-patch-question-fill" style="font-size:1.5rem;color:#f59e0b;flex-shrink:0"></i>
            <div>
              <strong style="color:var(--text-color)">Test Your Knowledge</strong><br/>
              <small class="tdq-cta-sub">Can you answer 5 questions about this event?</small><br/>
              <button class="btn btn-sm btn-warning mt-2" id="tdq-cta-btn" onclick="document.getElementById('tdq-overlay').style.display='block';document.getElementById('tdq-popup').style.display='block';requestAnimationFrame(function(){document.getElementById('tdq-popup').classList.add('tdq-popup-open');});document.body.style.overflow='hidden';if(typeof maybeLoadAndShowQuiz==='function')maybeLoadAndShowQuiz();">
                <i class="bi bi-play-fill me-1"></i>Take the Quiz
              </button>
            </div>
          </div>

          <!-- Wikipedia source -->
          <div class="mt-4 p-3 rounded" style="background-color: rgba(59,130,246,0.08); border: 1px solid rgba(59,130,246,0.2);">
            <small class="article-meta">
              Want to learn more? Read the full article on
              <a href="${esc(c.wikiUrl || c.jsonLdUrl)}" target="_blank" rel="noopener noreferrer">Wikipedia</a>.
              Historical data sourced under <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a>.
            </small>
          </div>

          ${(() => {
            // Cross-link to /generated/ page for the event's month/day
            if (!c.historicalDateISO) return "";
            const hd = new Date(c.historicalDateISO + "T12:00:00Z");
            const hMonthSlug = MONTH_SLUGS[hd.getUTCMonth()];
            const hDay = hd.getUTCDate();
            const hMonthDisplay = MONTH_NAMES[hd.getUTCMonth()];
            return `<div class="mt-4 p-3 rounded d-flex align-items-center gap-3" style="background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.18)">
              <i class="bi bi-calendar3" style="font-size:1.5rem;color:#3b82f6;flex-shrink:0"></i>
              <div>
                <strong>Explore ${esc(hMonthDisplay)} ${hDay} in History</strong><br/>
                <small class="article-meta">See all events, births, and deaths recorded on this date.</small><br/>
                <a href="/generated/${esc(hMonthSlug)}/${hDay}/" class="btn btn-sm btn-outline-primary mt-2">
                  <i class="bi bi-arrow-right me-1"></i>View ${esc(hMonthDisplay)} ${hDay}
                </a>
              </div>
            </div>`;
          })()}

          ${(() => {
            const related = allPosts.filter((p) => p.slug !== slug).slice(0, 3); // already sorted newest-first; today's post is always shown first
            if (related.length === 0) return "";
            const cards = related
              .map(
                (p) => `
              <div class="col-md-4">
                <a href="/blog/${esc(p.slug)}/" class="related-card d-block p-3 rounded text-decoration-none h-100">
                  <p class="mb-1 fw-semibold" style="color:var(--text-color);font-size:.92rem;line-height:1.35">${esc(p.title)}</p>
                  <small class="article-meta">${new Date(p.publishedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</small>
                </a>
              </div>`,
              )
              .join("");
            return `<section class="mt-5">
            <h2 class="h5 mb-3">You Might Also Like</h2>
            <div class="row g-3">${cards}
            </div>
          </section>`;
          })()}

          <footer class="text-center mt-5 pt-3 border-top">
            <small class="article-meta">
              Part of the <strong>thisDay.</strong> historical blog archive &mdash;
              <a href="/blog/archive/">Browse more posts</a> &bull;
              <a href="/blog/">All posts</a>
            </small>
          </footer>

        </article>
      </div>
    </div>
  </main>

  <script src="/js/chatbot.js"></script>

  <footer class="footer">
    <div class="container d-flex justify-content-center my-2">
      <div class="me-2">
        <a href="https://github.com/Fugec" target="_blank" rel="noopener noreferrer" aria-label="GitHub">
          <i class="bi bi-github h3 text-white"></i>
        </a>
      </div>
      <div class="me-2">
        <a href="https://www.facebook.com/profile.php?id=61578009082537" target="_blank" rel="noopener noreferrer" aria-label="Facebook">
          <i class="bi bi-facebook h3 text-white"></i>
        </a>
      </div>
      <div class="me-2">
        <a href="https://www.instagram.com/thisday.info/" target="_blank" rel="noopener noreferrer" aria-label="Instagram">
          <i class="bi bi-instagram h3 text-white"></i>
        </a>
      </div>
      <div class="me-2">
        <a href="https://www.tiktok.com/@this__day" target="_blank" rel="noopener noreferrer" aria-label="TikTok">
          <i class="bi bi-tiktok h3 text-white"></i>
        </a>
      </div>
      <div class="me-2">
        <a href="https://www.youtube.com/@thisDay_info/shorts" target="_blank" rel="noopener noreferrer" aria-label="YouTube">
          <i class="bi bi-youtube h3 text-white"></i>
        </a>
      </div>
    </div>
    <p>&copy; <span id="currentYear"></span> thisDay. All rights reserved.</p>
    <p>
      Historical data sourced from Wikipedia.org under
      <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer"
         title="Creative Commons Attribution-ShareAlike 4.0 International License">CC BY-SA 4.0</a> license.
      Note: Data is for informational purposes and requires verification.
    </p>
    <p>
      This website is not affiliated with any official historical organization or entity.
      The content is provided for educational and entertainment purposes only.
    </p>
    <p class="footer-bottom">
      <a href="https://buymeacoffee.com/fugec?new=1" target="_blank">Support This Project</a>
      | <a href="/blog/">Blog</a>
      | <a href="/about/">About Us</a>
      | <a href="/contact/">Contact</a>
      | <a href="/terms/">Terms and Conditions</a>
      | <a href="/privacy-policy/">Privacy Policy</a>
    </p>
  </footer>

  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
  <script src="/js/script.js"></script>
  <script>
    document.addEventListener("DOMContentLoaded", () => {
      const currentYearSpan = document.getElementById("currentYear");
      if (currentYearSpan) currentYearSpan.textContent = new Date().getFullYear();

      const themeSwitchDesktop = document.getElementById("themeSwitchDesktop");
      const themeSwitchMobile  = document.getElementById("themeSwitchMobile");
      const body = document.body;
      const DARK_THEME_KEY = "darkTheme";

      const setTheme = (isDark) => {
        isDark ? body.classList.add("dark-theme") : body.classList.remove("dark-theme");
        localStorage.setItem(DARK_THEME_KEY, String(isDark));
        if (themeSwitchDesktop) themeSwitchDesktop.checked = isDark;
        if (themeSwitchMobile)  themeSwitchMobile.checked  = isDark;
      };

      const savedTheme = localStorage.getItem(DARK_THEME_KEY);
      setTheme(savedTheme !== "false"); // default: dark

      if (themeSwitchDesktop) themeSwitchDesktop.addEventListener("change", (e) => setTheme(e.target.checked));
      if (themeSwitchMobile)  themeSwitchMobile.addEventListener("change",  (e) => setTheme(e.target.checked));
    });
  </script>

  <!-- Google Ads: 60 Seconds on Site -->
  <script>
    (function () {
      var fired = false, timer = null;
      function fireConversion() {
        if (fired) return; fired = true;
        gtag("event", "conversion", { send_to: "AW-17262488503/pnJhCPrptfsbELfXsqdA" });
      }
      function startTimer() { if (!timer) timer = setTimeout(fireConversion, 60000); }
      function stopTimer()  { if (timer) { clearTimeout(timer); timer = null; } }
      document.addEventListener("visibilitychange", () => document.hidden ? stopTimer() : (!fired && startTimer()));
      if (!document.hidden) startTimer();
    })();
  </script>

  <!-- Quiz popup: load quiz data and show after scroll to bottom -->
  <div id="tdq-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9998" aria-hidden="true"></div>
  <div id="tdq-popup" role="dialog" aria-modal="true" aria-label="History Quiz" style="display:none;position:fixed;bottom:0;left:0;right:0;z-index:9999;max-height:90dvh;overflow-y:auto;background:var(--card-bg,#fff);border-radius:16px 16px 0 0;padding:24px 20px 32px;box-shadow:0 -4px 32px rgba(0,0,0,.18);font-family:Inter,sans-serif">
    <button id="tdq-close" aria-label="Close quiz" style="position:absolute;top:12px;right:16px;background:none;border:none;font-size:1.5rem;cursor:pointer;color:var(--text-color,#6c757d);line-height:1">&times;</button>
    <div id="tdq-topic" style="font-size:.72rem;font-weight:700;color:#f59e0b;text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px"></div>
    <h3 style="font-size:1.1rem;font-weight:700;margin-bottom:3px;color:var(--text-color,#1e293b)"><i class="bi bi-patch-question-fill me-2" style="color:#f59e0b"></i>Test Your Knowledge</h3>
    <p style="font-size:.85rem;color:var(--text-color,#6c757d);margin-bottom:6px;opacity:.8">Based on the article you just read — 5 questions, under a minute.</p>
    <div id="tdq-progress" style="font-size:.78rem;font-weight:600;color:#f59e0b;margin-bottom:16px">0 of 5 answered</div>
    <div id="tdq-questions"></div>
    <button class="btn btn-warning mt-3" id="tdq-submit-btn" style="display:none"><i class="bi bi-check2-circle me-1"></i>Check Answers</button>
    <div id="tdq-score" class="mt-3" hidden></div>
  </div>

  <div id="tdq-sentinel" style="height:1px"></div>

  <style>
    .tdq-question{margin-bottom:16px}.tdq-q-text{font-weight:600;margin-bottom:8px;font-size:.9rem;color:var(--text-color,#1e293b)}.tdq-options{display:flex;flex-direction:column;gap:7px}
    .tdq-opt{display:flex;align-items:center;gap:9px;padding:8px 12px;border:1.5px solid var(--card-border,#e2e8f0);border-radius:8px;cursor:pointer;font-size:.88rem;transition:background .15s,border-color .15s;user-select:none;color:var(--text-color,#1e293b)}
    .tdq-opt:hover{border-color:#3b82f6;background:rgba(59,130,246,.07)}.tdq-opt-selected{border-color:#3b82f6!important;background:rgba(59,130,246,.1)!important;font-weight:500}
    .tdq-opt-correct{border-color:#10b981!important;background:#d1fae5!important;color:#0f172a!important}.tdq-opt-wrong{border-color:#ef4444!important;background:#fee2e2!important;color:#0f172a!important}
    .tdq-opt-key{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#e2e8f0;font-size:.72rem;font-weight:700;flex-shrink:0}
    .tdq-opt-selected .tdq-opt-key{background:#3b82f6;color:#fff}.tdq-opt-correct .tdq-opt-key{background:#10b981;color:#fff}.tdq-opt-wrong .tdq-opt-key{background:#ef4444;color:#fff}
    body.dark-theme .tdq-opt{border-color:rgba(255,255,255,.15);color:#f8fafc}body.dark-theme .tdq-opt:hover{border-color:#60a5fa;background:rgba(96,165,250,.08)}
    body.dark-theme .tdq-opt-selected{border-color:#60a5fa!important;background:rgba(96,165,250,.15)!important}body.dark-theme .tdq-opt-key{background:#334155;color:#cbd5e1}
    body.dark-theme .tdq-opt-correct{background:rgba(16,185,129,.2)!important;border-color:#10b981!important;color:#e2e8f0!important}body.dark-theme .tdq-opt-wrong{background:rgba(239,68,68,.2)!important;border-color:#ef4444!important;color:#e2e8f0!important}
    .tdq-feedback{font-size:.82rem;margin-top:4px}.tdq-correct{color:#10b981;font-weight:600}.tdq-wrong{color:#ef4444;font-weight:600}
    .tdq-score-box{font-size:1rem;font-weight:600;padding:12px 14px;background:rgba(245,158,11,.1);border-radius:8px;border-left:4px solid #f59e0b}.tdq-score-num{color:#f59e0b;font-size:1.15rem}
    #tdq-popup{transition:transform .3s ease;transform:translateY(100%)}.tdq-popup-open{transform:translateY(0)!important}
  </style>

  <script>
  (function () {
    var slug = "${esc(slug)}";
    var quizLoaded = false;
    var selected = {};
    var answers = [];

    function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

    function openPopup() {
      document.getElementById("tdq-overlay").style.display = "block";
      document.getElementById("tdq-popup").style.display = "block";
      requestAnimationFrame(function() { document.getElementById("tdq-popup").classList.add("tdq-popup-open"); });
      document.body.style.overflow = "hidden";
    }

    function closePopup() {
      var popup = document.getElementById("tdq-popup");
      popup.classList.remove("tdq-popup-open");
      setTimeout(function() {
        popup.style.display = "none";
        document.getElementById("tdq-overlay").style.display = "none";
        document.body.style.overflow = "";
      }, 300);
    }

    document.getElementById("tdq-close").addEventListener("click", closePopup);
    document.getElementById("tdq-overlay").addEventListener("click", closePopup);

    function renderQuiz(quiz) {
      answers = quiz.questions.map(function(q) { return Number(q.answer); });
      var total = quiz.questions.length;
      var topicEl = document.getElementById("tdq-topic");
      if (topicEl) { var h1 = document.querySelector("h1"); if (h1) topicEl.textContent = "Quiz: " + h1.textContent.trim(); }
      var container = document.getElementById("tdq-questions");
      container.innerHTML = quiz.questions.map(function(q, qi) {
        var optsHtml = (q.options || []).map(function(opt, oi) {
          return '<div class="tdq-opt" data-qi="' + qi + '" data-oi="' + oi + '">' +
            '<span class="tdq-opt-key">' + String.fromCharCode(65 + oi) + '</span>' + esc(String(opt)) + '</div>';
        }).join("");
        var expHtml = q.explanation
          ? '<div class="tdq-explanation" id="tdq-e-' + qi + '" hidden style="font-size:.82rem;margin-top:6px;padding:7px 11px;background:rgba(59,130,246,.07);border-left:3px solid #3b82f6;border-radius:0 6px 6px 0">' + esc(String(q.explanation)) + '</div>'
          : '';
        return '<div class="tdq-question" id="tdq-q-' + qi + '">' +
          '<p class="tdq-q-text"><strong>' + (qi + 1) + '.</strong> ' + esc(String(q.q)) + '</p>' +
          '<div class="tdq-options">' + optsHtml + '</div>' +
          '<div class="tdq-feedback" id="tdq-f-' + qi + '" hidden></div>' +
          expHtml +
          '</div>';
      }).join("");

      container.querySelectorAll(".tdq-opt").forEach(function(opt) {
        opt.addEventListener("click", function() {
          var qi = parseInt(this.dataset.qi), oi = parseInt(this.dataset.oi);
          selected[qi] = oi;
          container.querySelectorAll('[data-qi="' + qi + '"]').forEach(function(o) { o.classList.remove("tdq-opt-selected"); });
          this.classList.add("tdq-opt-selected");
          var answered = Object.keys(selected).length;
          var progEl = document.getElementById("tdq-progress");
          if (progEl) progEl.textContent = answered + " of " + total + " answered";
          var allAnswered = quiz.questions.every(function(_, i) { return selected[i] !== undefined; });
          document.getElementById("tdq-submit-btn").style.display = allAnswered ? "" : "none";
        });
      });
    }

    document.getElementById("tdq-submit-btn").addEventListener("click", function() {
      var score = 0;
      answers.forEach(function(correct, qi) {
        var chosen = selected[qi] !== undefined ? selected[qi] : -1;
        var fb = document.getElementById("tdq-f-" + qi);
        var opts = document.querySelectorAll('[data-qi="' + qi + '"]');
        fb.hidden = false;
        opts.forEach(function(o) { o.style.pointerEvents = "none"; });
        opts[correct].classList.add("tdq-opt-correct");
        if (chosen === correct) {
          score++;
          fb.innerHTML = '<span class="tdq-correct">✓ Correct!</span>';
        } else {
          if (chosen >= 0) opts[chosen].classList.add("tdq-opt-wrong");
          fb.innerHTML = '<span class="tdq-wrong">✗ Incorrect.</span> Correct: <strong>' + String.fromCharCode(65 + correct) + '</strong>';
        }
        var exp = document.getElementById("tdq-e-" + qi);
        if (exp) exp.hidden = false;
      });
      this.hidden = true;
      var pct = Math.round(score / answers.length * 100);
      var msg = pct === 100 ? "Perfect score!" : pct >= 80 ? "Excellent!" : pct >= 60 ? "Good job!" : "Keep learning!";
      var el = document.getElementById("tdq-score");
      el.hidden = false;
      el.innerHTML = '<div class="tdq-score-box">You scored <span class="tdq-score-num">' + score + '/' + answers.length + '</span> (' + pct + '%) — ' + msg + '</div>';
    });

    function maybeLoadAndShow() {
      if (quizLoaded) return;
      quizLoaded = true;
      fetch("/blog/quiz/" + slug)
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(quiz) {
          if (!quiz || !quiz.questions || quiz.questions.length < 3) return;
          renderQuiz(quiz);
          openPopup();
        })
        .catch(function() { /* quiz unavailable, silently skip */ });
    }
    // Expose so the CTA button in the article body can trigger it
    window.maybeLoadAndShowQuiz = maybeLoadAndShow;

    // Auto-open if deep-linked with #quiz hash
    if (window.location.hash === "#quiz") {
      setTimeout(maybeLoadAndShow, 600);
    }

    if ("IntersectionObserver" in window) {
      var sentinel = document.getElementById("tdq-sentinel");
      var obs = new IntersectionObserver(function(entries) {
        if (entries[0].isIntersecting) { obs.disconnect(); setTimeout(maybeLoadAndShow, 800); }
      }, { threshold: 1.0 });
      obs.observe(sentinel);
    }
  })();
  </script>
  <script>
  (function(){
    var bar=document.getElementById('read-progress');
    if(!bar)return;
    document.addEventListener('scroll',function(){
      var doc=document.documentElement;
      var total=doc.scrollHeight-doc.clientHeight;
      var pct=total>0?Math.round((doc.scrollTop/total)*100):0;
      bar.style.width=pct+'%';
      bar.setAttribute('aria-valuenow',pct);
    },{passive:true});
  })();
  </script>
</body>
</html>`;
}

/**
 * Builds the /blog/ai/ listing page, styled to match /blog/index.html.
 */
async function buildListingHTML(index) {
  const postItems = index.length
    ? index
        .map((entry) => {
          const date = new Date(entry.publishedAt);
          const dateStr = `${MONTH_NAMES[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
          return `
        <a href="/blog/${esc(entry.slug)}/" class="blog-post-link">
          <i class="bi bi-clock-history post-icon"></i>
          <div>
            <div class="post-title">${esc(entry.title)}</div>
            <small style="color: var(--text-color); opacity: 0.7">${esc(dateStr)}</small>
          </div>
        </a>`;
        })
        .join("\n")
    : '<p class="text-muted">No AI-generated posts yet. Check back soon!</p>';

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>History Blog | thisDay. — Articles on Historical Events</title>
    <link rel="canonical" href="https://thisday.info/blog/archive/" />
    <meta name="robots" content="index, follow" />
    <meta name="description" content="Original articles about historical events published regularly by thisDay.info." />
    <meta property="og:title" content="History Blog | thisDay." />
    <meta property="og:description" content="In-depth articles about the events, people, and moments that shaped world history." />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="https://thisday.info/blog/archive/" />
    <meta property="og:image" content="https://thisday.info/images/logo.png" />
    <meta property="og:locale" content="en_US" />
    <meta property="og:site_name" content="thisDay." />

    <!-- JSON-LD -->
    <script type="application/ld+json">
${JSON.stringify(
  {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "History Blog | thisDay.",
    url: "https://thisday.info/blog/archive/",
    description:
      "Original articles about historical events published regularly by thisDay.info.",
    publisher: {
      "@type": "Organization",
      name: "thisDay.info",
      logo: {
        "@type": "ImageObject",
        url: "https://thisday.info/images/logo.png",
      },
    },
    hasPart: index.slice(0, 20).map((p) => ({
      "@type": "NewsArticle",
      name: p.title,
      url: `https://thisday.info/blog/${p.slug}/`,
      datePublished: p.publishedAt
        ? new Date(p.publishedAt).toISOString().split("T")[0]
        : undefined,
      description: p.description,
    })),
  },
  null,
  2,
)}
    </script>

    <link rel="icon" href="/images/favicon.ico" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/css/style.css" />
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-WXEZ3868VN"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag() { dataLayer.push(arguments); }
      gtag("js", new Date()); gtag("config", "G-WXEZ3868VN");
    </script>
    <style>
      :root {
        --primary-bg: #3b82f6; --secondary-bg: #fff; --text-color: #6c757d;
        --header-text-color: #fff; --footer-bg: #3b82f6; --footer-text-color: #fff;
        --link-color: #2563eb; --card-bg: #fff; --card-border: rgba(0,0,0,0.1);
        background-color: var(--secondary-bg); color: var(--text-color);
      }
      body.dark-theme {
        --primary-bg: #020617; --secondary-bg: #1e293b; --text-color: #f8fafc;
        --header-text-color: #fff; --footer-bg: #020617; --footer-text-color: #fff;
        --link-color: #60a5fa; --card-bg: #1e293b; --card-border: rgba(255,255,255,0.1);
        background-color: var(--secondary-bg) !important; color: var(--text-color) !important;
      }
      body { font-family: Inter, sans-serif; min-height: 100vh; display: flex; flex-direction: column; transition: background-color 0.3s ease, color 0.3s ease; }
      .navbar { background-color: var(--primary-bg) !important; position: sticky; top: 0; z-index: 1030; }
      .navbar-brand, .navbar-nav .nav-link { color: var(--header-text-color) !important; font-weight: bold !important; }
      main { flex: 1; padding: 20px 0; }
      .footer { background-color: var(--footer-bg); color: var(--footer-text-color); text-align: center; padding: 20px; margin-top: 30px; font-size: 14px; }
      .footer a { color: var(--footer-text-color); text-decoration: underline; }
      h1, h2, h3 { color: var(--text-color); }
      body.dark-theme h1, body.dark-theme h2, body.dark-theme h3 { color: #f8fafc; }
      a { color: var(--link-color); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .blog-post-link {
        display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px;
        border: 1px solid var(--card-border); border-radius: 8px;
        background-color: var(--card-bg); text-decoration: none; color: var(--text-color);
        transition: transform 0.15s ease, box-shadow 0.15s ease; margin-bottom: 10px;
      }
      .blog-post-link:hover { transform: translateX(4px); box-shadow: 0 3px 12px rgba(0,0,0,0.08); text-decoration: none; color: var(--text-color); }
      .post-icon { color: #3b82f6; font-size: 1.1rem; flex-shrink: 0; margin-top: 2px; }
      .post-title { font-weight: 600; font-size: 0.95rem; line-height: 1.4; color: var(--link-color); }
      body.dark-theme .post-title { color: #60a5fa; }
      .month-header { font-size: 1.3rem; font-weight: 700; color: #3b82f6 !important; border-bottom: 2px solid rgba(59,130,246,0.3); padding-bottom: 6px; margin-bottom: 14px; }
    </style>
  </head>
  <body>

  <nav class="navbar navbar-expand-lg navbar-dark bg-primary">
    <div class="container-fluid">
      <a class="navbar-brand" href="/">thisDay.</a>
      <div class="form-check form-switch d-lg-none me-2">
        <input class="form-check-input" type="checkbox" id="themeSwitchMobile" aria-label="Toggle dark mode" />
        <label class="form-check-label" for="themeSwitchMobile"><i class="bi bi-brightness-high-fill" style="color:#fff;font-size:1.2rem;margin-left:.5rem"></i></label>
      </div>
      <div class="collapse navbar-collapse" id="navbarNav">
        <ul class="navbar-nav ms-auto">
          <li class="nav-item d-flex align-items-center">
            <div class="form-check form-switch d-none d-lg-block me-2">
              <input class="form-check-input" type="checkbox" id="themeSwitchDesktop" aria-label="Toggle dark mode" />
              <label class="form-check-label" for="themeSwitchDesktop" style="color:#fff">Dark Mode</label>
            </div>
          </li>
        </ul>
      </div>
    </div>
  </nav>

  <main class="container">
    <div class="row justify-content-center">
      <div class="col-lg-9 col-xl-7">
        <h1 class="fw-bold mb-1" style="font-size:1.8rem">History Blog</h1>
        <p class="mb-4" style="color: var(--text-color); opacity: 0.8">
          In-depth articles covering fascinating historical events published regularly by thisDay.info.
          <a href="/blog/">View all posts</a>
        </p>
        <div class="month-section">
          <h2 class="month-header"><i class="bi bi-book me-2"></i>All Articles (${index.length})</h2>
          ${postItems}
        </div>
      </div>
    </div>
  </main>

  <footer class="footer">
    <div class="container d-flex justify-content-center my-2">
      <div class="me-2"><a href="https://github.com/Fugec" target="_blank" rel="noopener noreferrer" aria-label="GitHub"><i class="bi bi-github h3 text-white"></i></a></div>
      <div class="me-2"><a href="https://www.facebook.com/profile.php?id=61578009082537" target="_blank" rel="noopener noreferrer" aria-label="Facebook"><i class="bi bi-facebook h3 text-white"></i></a></div>
      <div class="me-2"><a href="https://www.instagram.com/thisday.info/" target="_blank" rel="noopener noreferrer" aria-label="Instagram"><i class="bi bi-instagram h3 text-white"></i></a></div>
      <div class="me-2"><a href="https://www.tiktok.com/@this__day" target="_blank" rel="noopener noreferrer" aria-label="TikTok"><i class="bi bi-tiktok h3 text-white"></i></a></div>
      <div class="me-2"><a href="https://www.youtube.com/@thisDay_info/shorts" target="_blank" rel="noopener noreferrer" aria-label="YouTube"><i class="bi bi-youtube h3 text-white"></i></a></div>
    </div>
    <p>&copy; <span id="currentYear"></span> thisDay. All rights reserved.</p>
    <p>Historical data sourced from Wikipedia.org. Content is for educational and entertainment purposes only.</p>
    <p class="footer-bottom"><a href="https://buymeacoffee.com/fugec?new=1" target="_blank">Support This Project</a> | <a href="/blog/">Blog</a> | <a href="/about/">About Us</a> | <a href="/contact/">Contact</a> | <a href="/terms/">Terms and Conditions</a> | <a href="/privacy-policy/">Privacy Policy</a></p>
  </footer>

  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
  <script>
    document.addEventListener("DOMContentLoaded", () => {
      document.getElementById("currentYear").textContent = new Date().getFullYear();
      const td = document.getElementById("themeSwitchDesktop");
      const tm = document.getElementById("themeSwitchMobile");
      const body = document.body;
      const setTheme = (d) => {
        d ? body.classList.add("dark-theme") : body.classList.remove("dark-theme");
        localStorage.setItem("darkTheme", String(d));
        if (td) td.checked = d; if (tm) tm.checked = d;
      };
      setTheme(localStorage.getItem("darkTheme") !== "false");
      if (td) td.addEventListener("change", (e) => setTheme(e.target.checked));
      if (tm) tm.addEventListener("change",  (e) => setTheme(e.target.checked));
    });
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

async function serveListing(env) {
  const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  const html = await buildListingHTML(index);
  return htmlResponse(html);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function todayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Smart 404 page
// ---------------------------------------------------------------------------

/**
 * Returns a styled 404 HTML response with links to the 3 most recent posts
 * from KV, giving visitors somewhere to go instead of a dead end.
 */
async function serve404(env) {
  let recentPosts = [];
  try {
    const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
    recentPosts = indexRaw ? JSON.parse(indexRaw).slice(0, 3) : [];
  } catch {
    // Suggestions are optional — don't let a KV failure block the 404 page.
  }

  const suggestions =
    recentPosts.length > 0
      ? `<h5 class="mt-5 mb-3 fw-semibold">Recent Articles</h5>
        <div class="list-group">
          ${recentPosts
            .map(
              (p) => `
          <a href="/blog/${esc(p.slug)}/" class="list-group-item list-group-item-action py-3">
            <div class="fw-semibold">${esc(p.title)}</div>
            <div class="small text-muted mt-1">${esc(p.description)}</div>
          </a>`,
            )
            .join("")}
        </div>`
      : "";

  const year = new Date().getFullYear();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Page Not Found — thisDay.</title>
  <meta name="robots" content="noindex, nofollow" />
  <link rel="icon" href="/images/favicon.ico" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/css/style.css" />
  <style>
    body { font-family: Inter, sans-serif; min-height: 100vh; display: flex; flex-direction: column; }
    .navbar { background-color: #3b82f6 !important; position: sticky; top: 0; z-index: 1030; }
    .navbar-brand, .navbar-nav .nav-link { color: #fff !important; font-weight: bold !important; }
    main { flex: 1; }
    .footer { background-color: #3b82f6; color: #fff; text-align: center; padding: 20px; margin-top: 30px; }
    .footer a { color: #fff; text-decoration: underline; }
    .hero-code { font-size: 6rem; font-weight: 700; color: #3b82f6; line-height: 1; }
  </style>
</head>
<body>
<nav class="navbar navbar-expand-lg navbar-dark">
  <div class="container-fluid">
    <a class="navbar-brand" href="/">thisDay.</a>
    <ul class="navbar-nav ms-auto">
      <li class="nav-item"><a class="nav-link" href="/">Home</a></li>
      <li class="nav-item"><a class="nav-link" href="/blog/">Blog</a></li>
    </ul>
  </div>
</nav>

<main class="container py-5">
  <div class="row justify-content-center">
    <div class="col-lg-7 text-center">
      <div class="hero-code">404</div>
      <h1 class="h3 mt-2 mb-3">Page Not Found</h1>
      <p class="text-muted mb-4">
        This page doesn&rsquo;t exist or may have moved.<br />
        Try the <a href="/">homepage</a> to explore today&rsquo;s events, or browse the <a href="/blog/">blog</a>.
      </p>
      <a href="/" class="btn btn-primary px-4 me-2">
        <i class="bi bi-house-door me-1"></i>Home
      </a>
      <a href="/blog/" class="btn btn-outline-secondary px-4">
        <i class="bi bi-journal-text me-1"></i>Blog
      </a>
      ${suggestions}
    </div>
  </div>
</main>

<footer class="footer">
  <p class="mb-0">
    &copy; ${year} <a href="/">thisDay.info</a> &middot;
    <a href="/privacy-policy/">Privacy</a> &middot;
    <a href="/contact/">Contact</a>
  </p>
</footer>
</body>
</html>`;

  return new Response(html, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSlug(date) {
  return `${date.getDate()}-${MONTH_SLUGS[date.getMonth()]}-${date.getFullYear()}`;
}

/** Minimal HTML entity escaping to prevent XSS in generated output. */
function esc(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=86400, s-maxage=604800",
      "X-Content-Type-Options": "nosniff",
      "Strict-Transport-Security":
        "max-age=31536000; includeSubDomains; preload",
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy":
        "camera=(), microphone=(), geolocation=(), payment=()",
    },
  });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
