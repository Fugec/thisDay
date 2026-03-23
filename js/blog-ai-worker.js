/**
 * Cloudflare Worker — Blog Post Generator
 *
 * Runs on a cron trigger (daily at 00:05 UTC) and publishes a new blog post
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

import { siteNav, siteFooter, footerYearScript } from "./shared/layout.js";
import {
  resolveAiModel,
  checkAndUpdateAiModel,
  CF_AI_MODEL,
} from "./shared/ai-model.js";
import { callAI } from "./shared/ai-call.js";
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
// Shared support popup (Buy Me a Coffee) — injected before </body> on all pages
// ---------------------------------------------------------------------------
function supportPopupSnippet() {
  return `<style>#supportPopup{position:fixed;inset:0;background:rgba(0,0,0,.35);display:none;justify-content:center;align-items:center;backdrop-filter:blur(2px);z-index:9998;opacity:0;transition:opacity .4s ease}#supportPopup.show{display:flex;opacity:1}.support-popup-content{background:var(--card-bg,#fff);color:var(--text-color,#1e293b);padding:25px 28px;border-radius:12px;max-width:300px;width:90%;text-align:center;border:1px solid var(--card-border,rgba(0,0,0,.1));box-shadow:0 8px 25px rgba(0,0,0,.2);position:relative;animation:popupFadeIn .35s ease}@keyframes popupFadeIn{from{transform:scale(.92);opacity:0}to{transform:scale(1);opacity:1}}.support-close-btn{position:absolute;top:8px;right:10px;border:none;background:transparent;font-size:1.4rem;cursor:pointer;color:#64748b;line-height:1;padding:0}.support-close-btn:hover{color:#1e293b}</style>
<div id="supportPopup"><div class="support-popup-content"><button class="support-close-btn">&times;</button><h4 style="font-size:1rem;margin-bottom:8px">History runs on facts, and this project runs on coffee!</h4><p style="font-size:.9rem;margin-bottom:14px">Your support is incredibly helpful and genuinely appreciated.</p><a href="https://buymeacoffee.com/fugec?new=1" target="_blank" rel="noopener" style="display:inline-block;padding:8px 18px;background:#3b82f6;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:.9rem">Support with a coffee ☕</a></div></div>
<script>(function(){var p=document.getElementById('supportPopup');var c=p&&p.querySelector('.support-close-btn');if(!p||!c)return;try{var _t=localStorage.getItem('supportPopupClosed');if(_t&&Date.now()-Number(_t)<86400000)return;}catch(e){}var shown=false;var ready=false;var past70=false;function show(){if(shown)return;shown=true;p.classList.add('show');}setTimeout(function(){ready=true;if(past70)show();},60000);setTimeout(function(){show();},90000);window.addEventListener('scroll',function(){var s=window.scrollY+window.innerHeight;var t=document.documentElement.scrollHeight;if(s/t>=0.7){past70=true;if(ready)show();}},{passive:true});c.addEventListener('click',function(){p.classList.remove('show');try{localStorage.setItem('supportPopupClosed',String(Date.now()));}catch(e){}});})();<\/script>`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  /**
   * Cron trigger — runs daily, generates every other day.
   */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        await checkAndUpdateAiModel(env, env.BLOG_AI_KV);
        await maybeGenerateBlogPost(env, ctx);
      })(),
    );
  },

  /**
   * HTTP fetch handler — serves blog pages and the manual trigger endpoint.
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    // Manual trigger (POST /blog/publish)
    // Requires:  Authorization: Bearer <PUBLISH_SECRET>  (blog failsafe)
    //        or  Authorization: Bearer <YOUTUBE_REGEN_SECRET>  (YouTube regen)
    if (path === "/blog/publish" && request.method === "POST") {
      const auth = request.headers.get("Authorization") ?? "";
      const validPublish =
        env.PUBLISH_SECRET && auth === `Bearer ${env.PUBLISH_SECRET}`;
      const validYtRegen =
        env.YOUTUBE_REGEN_SECRET &&
        auth === `Bearer ${env.YOUTUBE_REGEN_SECRET}`;
      if (!validPublish && !validYtRegen) {
        return jsonResponse({ status: "unauthorized" }, 401);
      }
      try {
        const publishUrl = new URL(request.url);
        const forcedEvent = publishUrl.searchParams.get("force-event") || null;
        await generateAndStore(env, ctx, forcedEvent);
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

    // Admin: patch SEO meta tags on existing posts without full regeneration
    // POST /blog/regen-seo?slug=22-march-2026   — single post
    // POST /blog/regen-seo?all=true             — all posts in index (sequential)
    if (path === "/blog/regen-seo" && request.method === "POST") {
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.PUBLISH_SECRET || auth !== `Bearer ${env.PUBLISH_SECRET}`) {
        return jsonResponse({ status: "unauthorized" }, 401);
      }
      const regenParams = new URL(request.url).searchParams;
      const targetSlug = regenParams.get("slug");
      const regenAll = regenParams.get("all") === "true";
      const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
      const index = indexRaw ? JSON.parse(indexRaw) : [];
      const slugs = targetSlug
        ? [targetSlug]
        : regenAll
          ? index.map((e) => e.slug)
          : [];
      if (slugs.length === 0) {
        return jsonResponse(
          { status: "error", message: "Provide ?slug=X or ?all=true" },
          400,
        );
      }
      const results = [];
      for (const slug of slugs) {
        try {
          const html = await env.BLOG_AI_KV.get(`${KV_POST_PREFIX}${slug}`);
          if (!html) {
            results.push({ slug, status: "not_found" });
            continue;
          }
          const { updatedHtml, changed, newDescription } = await patchSEOMeta(
            html,
            slug,
            env,
          );
          await env.BLOG_AI_KV.put(`${KV_POST_PREFIX}${slug}`, updatedHtml);
          // Sync description in the index if it changed
          if (newDescription) {
            const idx = index.findIndex((e) => e.slug === slug);
            if (idx !== -1) index[idx].description = newDescription;
          }
          results.push({ slug, status: "updated", changed });
        } catch (err) {
          results.push({ slug, status: "error", error: err.message });
        }
      }
      // Persist updated index (descriptions may have changed)
      await env.BLOG_AI_KV.put(KV_INDEX_KEY, JSON.stringify(index));
      return jsonResponse({ status: "ok", results });
    }

    // Admin: humanize body paragraphs on existing posts to reduce AI detection score
    // POST /blog/regen-humanize?slug=22-march-2026
    if (path === "/blog/regen-humanize" && request.method === "POST") {
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.PUBLISH_SECRET || auth !== `Bearer ${env.PUBLISH_SECRET}`) {
        return jsonResponse({ status: "unauthorized" }, 401);
      }
      const humanizeParams = new URL(request.url).searchParams;
      const targetSlug = humanizeParams.get("slug");
      if (!targetSlug) {
        return jsonResponse(
          { status: "error", message: "Provide ?slug=X" },
          400,
        );
      }
      const html = await env.BLOG_AI_KV.get(`${KV_POST_PREFIX}${targetSlug}`);
      if (!html)
        return jsonResponse(
          { status: "error", message: "Post not found" },
          404,
        );
      const { updatedHtml, changed } = await patchBodyParagraphs(html, env);
      await env.BLOG_AI_KV.put(`${KV_POST_PREFIX}${targetSlug}`, updatedHtml);
      return jsonResponse({ status: "ok", slug: targetSlug, changed });
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

    // Debug: show what facts would be sent to AI for a slug — GET /blog/quiz-debug/{slug}
    const quizDebugMatch = path.match(/^\/blog\/quiz-debug\/([^/]+)$/);
    if (quizDebugMatch) {
      const slug = quizDebugMatch[1];
      const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
      const index = indexRaw ? JSON.parse(indexRaw) : [];
      const entry = index.find((p) => p.slug === slug);
      if (!entry) return new Response("not found", { status: 404 });
      const content = await buildRichContent(entry, slug);
      const keyFacts = (content.keyFacts || []).slice(0, 5);
      return new Response(
        JSON.stringify(
          {
            keyFactsCount: content.keyFacts?.length,
            keyFacts,
            description: content.description?.substring(0, 200),
          },
          null,
          2,
        ),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // Admin: regenerate quizzes in parallel — POST /blog/preload-quizzes?offset=0&limit=8&force=false
    if (path === "/blog/preload-quizzes" && request.method === "POST") {
      const params = new URL(request.url).searchParams;
      const offset = parseInt(params.get("offset") || "0", 10);
      const limit = Math.min(parseInt(params.get("limit") || "8", 10), 15);
      const force = params.get("force") === "true";
      const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
      const index = indexRaw ? JSON.parse(indexRaw) : [];
      const batch = index.slice(offset, offset + limit);
      const results = await Promise.allSettled(
        batch.map(async (entry) => {
          const kvKey = `quiz-v3:blog:${entry.slug}`;
          if (!force) {
            const existing = await env.BLOG_AI_KV.get(kvKey);
            if (existing) return { slug: entry.slug, status: "skipped" };
          }
          const content = await buildRichContent(entry, entry.slug);
          const quiz = await generateBlogQuiz(env, content, entry.slug);
          if (quiz) {
            await env.BLOG_AI_KV.put(kvKey, JSON.stringify(quiz), {
              expirationTtl: 90 * 86_400,
            });
            return {
              slug: entry.slug,
              status: "generated",
              questions: quiz.questions.length,
            };
          }
          return { slug: entry.slug, status: "ai_failed" };
        }),
      );
      const out = results.map((r) =>
        r.status === "fulfilled"
          ? r.value
          : { slug: "?", status: "error", msg: r.reason?.message },
      );
      return new Response(
        JSON.stringify(
          { total: index.length, offset, batch: batch.length, results: out },
          null,
          2,
        ),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Blog quiz API: /blog/quiz/{slug}
    const blogQuizMatch = path.match(/^\/blog\/quiz\/([^/]+)$/);
    if (blogQuizMatch) {
      const slug = blogQuizMatch[1];
      const quizRaw = await env.BLOG_AI_KV.get(`quiz-v3:blog:${slug}`);
      if (quizRaw) {
        return new Response(quizRaw, {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=86400, s-maxage=0",
          },
        });
      }
      // Quiz not in KV — generate on-demand using rich content from the post HTML
      try {
        const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
        const index = indexRaw ? JSON.parse(indexRaw) : [];
        const entry = index.find((p) => p.slug === slug);
        if (entry && (env.AI || env.GROQ_API_KEY)) {
          const content = await buildRichContent(entry, slug);
          const quiz = await generateBlogQuiz(env, content, slug);
          if (quiz) {
            await env.BLOG_AI_KV.put(
              `quiz-v3:blog:${slug}`,
              JSON.stringify(quiz),
              { expirationTtl: 90 * 86_400 },
            );
            return new Response(JSON.stringify(quiz), {
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "public, max-age=3600",
              },
            });
          }
        }
      } catch (e) {
        console.error("On-demand quiz generation failed:", e);
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
      const slugParsedForThumb = parseSlugDate(slug);
      const eventsThumbPromise =
        slugParsedForThumb && env.EVENTS_KV
          ? env.EVENTS_KV.get(
              `events-data:${String(slugParsedForThumb.monthIndex + 1).padStart(2, "0")}-${String(slugParsedForThumb.day).padStart(2, "0")}`,
              { type: "json" },
            )
              .then(
                (d) =>
                  d?.events?.find((e) => e.pages?.[0]?.thumbnail?.source)
                    ?.pages?.[0]?.thumbnail?.source || "",
              )
              .catch(() => "")
          : Promise.resolve("");
      const [html, ytRaw, eventsThumb] = await Promise.all([
        env.BLOG_AI_KV.get(`${KV_POST_PREFIX}${slug}`),
        env.BLOG_AI_KV.get("youtube:uploaded"),
        eventsThumbPromise,
      ]);
      if (html) {
        // Patch old quiz API path in already-stored HTML
        let patchedHtml = html.replaceAll("/api/blog-quiz/", "/blog/quiz/");
        // Patch broken JS apostrophe — \'s inside template literal got unescaped to 's,
        // breaking the JS string literal in showResults()
        patchedHtml = patchedHtml.replace(
          "Previous Day's Story</a>'",
          "Previous Day&#39;s Story</a>'",
        );
        // Patch old btn-warning buttons to site-btn-primary
        patchedHtml = patchedHtml
          .replaceAll(
            'class="site-btn site-btn-primary mt-2" id="tdq-cta-btn"',
            'class="btn btn-warning fw-semibold w-100 mt-2" id="tdq-cta-btn"',
          )
          .replaceAll(
            'class="btn btn-sm btn-warning mt-2" id="tdq-cta-btn"',
            'class="btn btn-warning fw-semibold w-100 mt-2" id="tdq-cta-btn"',
          )
          .replaceAll(
            'class="btn btn-warning px-4 mt-3" id="tdq-submit-btn"',
            'class="site-btn site-btn-primary mt-3" id="tdq-submit-btn"',
          )
          .replaceAll(
            'class="text-muted">Can you answer',
            'class="tdq-cta-sub">Can you answer',
          );
        // Patch old site-btn-primary submit button back to btn-warning
        patchedHtml = patchedHtml.replaceAll(
          'class="site-btn site-btn-primary mt-3" id="tdq-submit-btn"',
          'class="btn btn-warning mt-3" id="tdq-submit-btn"',
        );
        // Patch old quick facts table style → site-table
        if (patchedHtml.includes('class="table table-bordered"')) {
          patchedHtml = patchedHtml
            .replaceAll('class="table table-bordered"', 'class="site-table"')
            .replaceAll('<th scope="row">', "<th>");
          if (!patchedHtml.includes(".site-table{")) {
            const siteTableCss = `<style>.site-table{width:100%;max-width:480px;border-collapse:collapse;border:1.5px solid var(--card-border,#e2e8f0);border-radius:10px;overflow:hidden;margin-top:1rem;margin-bottom:1.5rem;font-size:.9rem}.site-table th,.site-table td{padding:8px 14px;border-bottom:1px solid var(--card-border,#e2e8f0);text-align:left;color:var(--text-color)}.site-table tr:last-child th,.site-table tr:last-child td{border-bottom:none}.site-table th{background:rgba(59,130,246,.07);font-weight:600;white-space:nowrap;width:40%}body.dark-theme .site-table{border-color:rgba(255,255,255,.15)}body.dark-theme .site-table th{background:rgba(96,165,250,.1)}body.dark-theme .site-table th,body.dark-theme .site-table td{border-bottom-color:rgba(255,255,255,.08)}</style>`;
            patchedHtml = patchedHtml.replace(
              "</head>",
              siteTableCss + "</head>",
            );
          }
        }
        // Patch old footer — replace any footer that lacks the shared layout (gap:1.25rem + Flipboard icon)
        if (!patchedHtml.includes("gap:1.25rem")) {
          patchedHtml = patchedHtml.replace(
            /<footer class="footer">[\s\S]*?<\/footer>\s*(?=<\/body>|<\/html>|$)/,
            siteFooter(),
          );
        }
        // Patch image caption — replace any AI-generated caption with correct Wikimedia attribution
        patchedHtml = patchedHtml.replace(
          /<figcaption class="article-meta mt-2">\s*<small>(?!Image courtesy of)[\s\S]*?<\/small>\s*<\/figcaption>/,
          '<figcaption class="article-meta mt-2"><small>Image courtesy of <a href="https://commons.wikimedia.org/" target="_blank" rel="noopener noreferrer">Wikimedia Commons</a>.</small></figcaption>',
        );
        // Patch old quiz popup to flex-column sticky-header layout
        if (
          patchedHtml.includes('id="tdq-popup"') &&
          !patchedHtml.includes('id="tdq-header"')
        ) {
          patchedHtml = patchedHtml
            // Popup div: drop overflow-y:auto and old padding, add flex-direction:column
            .replace(
              /(<div id="tdq-popup"[^>]*?)overflow-y:auto;([^>]*?)padding:24px 20px 32px;/,
              "$1flex-direction:column;$2padding:0 0 32px;",
            )
            // Remove position:absolute from close button, add min touch target
            .replace(
              /(<button id="tdq-close"[^>]*?)position:absolute;top:12px;right:16px;([^>]*?line-height:1)(")/,
              "$1$2;flex-shrink:0;min-width:44px;min-height:44px$3",
            )
            // Wrap tdq-close + tdq-topic in sticky header div
            .replace(
              /(<button id="tdq-close"[\s\S]*?<\/button>)\s*(<div id="tdq-topic"[^>]*?><\/div>)/,
              '<div id="tdq-header" style="flex-shrink:0;border-bottom:1px solid var(--card-border,#e2e8f0);padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px">$2$1</div>',
            )
            // Wrap body content in scrollable inner div
            .replace(
              /(<\/div>)\s*(<h3 style="font-size:1\.1rem)/,
              '$1<div style="overflow-y:auto;padding:16px 20px 32px">$2',
            )
            .replace(
              /(<div id="tdq-score"[^>]*?hidden><\/div>)\s*(<\/div>)/,
              "$1</div>$2",
            )
            // Patch CSS: .tdq-popup-open needs display:flex!important
            .replace(
              ".tdq-popup-open{transform:translateY(0)!important}",
              ".tdq-popup-open{transform:translateY(0)!important;display:flex!important}",
            );
        }
        // Patch old show-all quiz JS → step-by-step (posts with quiz already baked in but old JS)
        // Only apply if post has old quiz (submit-btn, no finish-btn) AND doesn't already have step CSS (tdq-q-active)
        if (
          patchedHtml.includes('id="tdq-popup"') &&
          patchedHtml.includes('id="tdq-submit-btn"') &&
          !patchedHtml.includes("tdq-finish-btn") &&
          !patchedHtml.includes("tdq-q-active")
        ) {
          const stepOverride = `<script>
(function(){
  var sm=[].slice.call(document.scripts).find(function(s){return s.textContent.indexOf('var slug =')!==-1});
  var m=sm&&sm.textContent.match(/var slug = "([^"]+)"/);
  if(!m)return;
  var slug=m[1],selected={},answers=[],quizLoaded=false,total=0;
  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
  function openPopup(){var ol=document.getElementById('tdq-overlay'),pp=document.getElementById('tdq-popup');if(ol)ol.style.display='block';if(pp){pp.style.display='block';requestAnimationFrame(function(){pp.classList.add('tdq-popup-open')});}document.body.style.overflow='hidden';}
  function closePopup(){var pp=document.getElementById('tdq-popup');pp.classList.remove('tdq-popup-open');setTimeout(function(){pp.style.display='none';var ol=document.getElementById('tdq-overlay');if(ol)ol.style.display='none';document.body.style.overflow='';},300);}
  function renderQuiz(quiz){
    answers=quiz.questions.map(function(q){return Number(q.answer)});
    total=Math.min(quiz.questions.length,5);
    var topicEl=document.getElementById('tdq-topic');
    if(topicEl){var h1=document.querySelector('h1');if(h1)topicEl.textContent='Quiz: '+h1.textContent.trim();}
    var sb=document.getElementById('tdq-submit-btn');if(sb)sb.style.display='none';
    var container=document.getElementById('tdq-questions');
    container.innerHTML=quiz.questions.slice(0,total).map(function(q,qi){
      var optsHtml=(q.options||[]).map(function(opt,oi){return '<div class="tdq-opt" data-qi="'+qi+'" data-oi="'+oi+'"><span class="tdq-opt-key">'+String.fromCharCode(65+oi)+'</span>'+esc(String(opt))+'</div>';}).join('');
      var expHtml=q.explanation?'<div class="tdq-explanation" id="tdq-e-'+qi+'" hidden style="font-size:.82rem;margin-top:6px;padding:7px 11px;background:rgba(59,130,246,.07);border-left:3px solid #3b82f6;border-radius:0 6px 6px 0">'+esc(String(q.explanation))+'</div>':'';
      var actionBtn=qi<total-1?'<button class="tdq-next-btn" id="tdq-next-'+qi+'" data-qi="'+qi+'" style="display:none;width:100%;margin-top:18px;padding:12px;background:#c2410c;color:#fff;border:none;border-radius:10px;font-size:.95rem;font-weight:600;cursor:pointer;gap:8px;align-items:center;justify-content:center">Next Question <i class="bi bi-arrow-right"></i></button>':'<button id="tdq-finish-btn" style="display:none;width:100%;margin-top:18px;padding:12px;background:#c2410c;color:#fff;border:none;border-radius:10px;font-size:.95rem;font-weight:600;cursor:pointer"><i class="bi bi-check2-circle me-1"></i>See Results</button>';
      return '<div class="tdq-question" id="tdq-q-'+qi+'" style="display:'+(qi===0?'block':'none')+'"><p class="tdq-q-text"><strong>'+(qi+1)+'.</strong> '+esc(String(q.q))+'</p><div class="tdq-options">'+optsHtml+'</div><div class="tdq-feedback" id="tdq-f-'+qi+'" hidden></div>'+expHtml+actionBtn+'</div>';
    }).join('');
    container.querySelectorAll('.tdq-opt').forEach(function(opt){
      opt.addEventListener('click',function(){
        var qi=parseInt(this.dataset.qi),oi=parseInt(this.dataset.oi);
        if(selected[qi]!==undefined)return;
        selected[qi]=oi;
        var correct=answers[qi];
        var opts=container.querySelectorAll('.tdq-opt[data-qi="'+qi+'"]');
        opts.forEach(function(o){o.style.pointerEvents='none';});
        opts[correct].classList.add('tdq-opt-correct');
        var fb=document.getElementById('tdq-f-'+qi);fb.hidden=false;
        if(oi===correct){this.classList.add('tdq-opt-correct');fb.innerHTML='<span class="tdq-correct">✓ Correct!</span>';}
        else{this.classList.add('tdq-opt-wrong');fb.innerHTML='<span class="tdq-wrong">✗ Incorrect.</span> Correct: <strong>'+String.fromCharCode(65+correct)+'</strong>';}
        var exp=document.getElementById('tdq-e-'+qi);if(exp)exp.hidden=false;
        var progEl=document.getElementById('tdq-progress');if(progEl)progEl.textContent=Object.keys(selected).length+' of '+total+' answered';
        var nb=document.getElementById('tdq-next-'+qi);if(nb)nb.style.display='';
        var fb2=document.getElementById('tdq-finish-btn');if(fb2&&qi===total-1)fb2.style.display='';
      });
    });
    container.addEventListener('click',function(e){
      var btn=e.target.closest('.tdq-next-btn');if(!btn)return;
      var qi=parseInt(btn.dataset.qi);
      var inner=document.querySelector('#tdq-popup [style*="overflow-y:auto"]')||document.getElementById('tdq-popup');
      if(inner)inner.scrollTop=0;
      document.getElementById('tdq-q-'+qi).style.display='none';
      document.getElementById('tdq-q-'+(qi+1)).style.display='block';
    });
    var finBtn=document.getElementById('tdq-finish-btn');
    if(finBtn)finBtn.addEventListener('click',function(){
      var score=0;answers.forEach(function(c,qi){if(selected[qi]===c)score++;});
      this.hidden=true;
      document.getElementById('tdq-q-'+(total-1)).style.display='none';
      var pct=Math.round(score/answers.length*100);
      var msg=pct===100?'Perfect score!':pct>=80?'Excellent!':pct>=60?'Good job!':'Keep learning!';
      var el=document.getElementById('tdq-score');el.hidden=false;
      el.innerHTML='<div class="tdq-score-box">You scored <span class="tdq-score-num">'+score+'/'+answers.length+'</span> ('+pct+'%) — '+msg+'</div>';
      var inner=document.querySelector('#tdq-popup [style*="overflow-y:auto"]')||document.getElementById('tdq-popup');
      if(inner)inner.scrollTop=0;
    });
  }
  window.maybeLoadAndShowQuiz=function(){
    if(quizLoaded){openPopup();return;}
    quizLoaded=true;
    if(window.__tdqQuiz){var q=window.__tdqQuiz;window.__tdqQuiz=null;renderQuiz(q);openPopup();return;}
    fetch('/blog/quiz/'+slug).then(function(r){return r.ok?r.json():null;}).then(function(quiz){if(!quiz||!quiz.questions||quiz.questions.length<3)return;renderQuiz(quiz);openPopup();}).catch(function(){});
  };
  var closeBtn=document.getElementById('tdq-close');if(closeBtn){closeBtn.replaceWith(closeBtn.cloneNode(true));document.getElementById('tdq-close').addEventListener('click',closePopup);}
  var ol=document.getElementById('tdq-overlay');if(ol){ol.replaceWith(ol.cloneNode(true));document.getElementById('tdq-overlay').addEventListener('click',closePopup);}
})();
<\/script>`;
          // Disable old baked-in auto-triggers (IntersectionObserver + #quiz hash)
          // so the old private renderQuiz never fires and overwrites our step HTML
          patchedHtml = patchedHtml
            .replace(
              /setTimeout\(maybeLoadAndShow,\s*800\)/g,
              "setTimeout(function(){}/*tdq-disabled*/,800)",
            )
            .replace(
              /if\s*\(window\.location\.hash\s*===\s*"#quiz"\)\s*\{[^}]*\}/,
              "/* #quiz auto-open disabled */",
            );
          const bodyClose = patchedHtml.includes("</body>")
            ? "</body>"
            : "</html>";
          patchedHtml = patchedHtml.replace(
            bodyClose,
            stepOverride + "\n" + bodyClose,
          );
        }
        // Inject quiz CTA + popup for old posts that don't have it
        if (!patchedHtml.includes("tdq-cta-btn")) {
          const quizCta = `
          <!-- Quiz CTA -->
          <div class="mt-4 p-3 rounded d-flex align-items-center gap-3" style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25)">
            <i class="bi bi-patch-question-fill" style="font-size:1.5rem;color:#f59e0b;flex-shrink:0"></i>
            <div>
              <strong style="color:var(--text-color)">Test Your Knowledge</strong><br/>
              <small class="tdq-cta-sub">Can you answer 5 questions about this event?</small><br/>
              <button class="btn btn-warning fw-semibold w-100 mt-2" id="tdq-cta-btn" onclick="document.getElementById('tdq-overlay').style.display='block';document.getElementById('tdq-popup').style.display='block';requestAnimationFrame(function(){document.getElementById('tdq-popup').classList.add('tdq-popup-open');});document.body.style.overflow='hidden';if(typeof maybeLoadAndShowQuiz==='function')maybeLoadAndShowQuiz();">
                Take the Quiz
              </button>
            </div>
          </div>`;
          const quizBlock = `
  <!-- Quiz popup -->
  <div id="tdq-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9998" aria-hidden="true"></div>
  <div id="tdq-popup" role="dialog" aria-modal="true" aria-label="History Quiz" style="display:none;flex-direction:column;position:fixed;bottom:0;left:0;right:0;z-index:9999;max-height:90dvh;background:var(--card-bg,#fff);border-radius:16px 16px 0 0;box-shadow:0 -4px 32px rgba(0,0,0,.18);font-family:Inter,sans-serif">
    <div id="tdq-header" style="flex-shrink:0;border-bottom:1px solid var(--card-border,#e2e8f0);padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px">
      <div id="tdq-topic" style="font-size:.72rem;font-weight:700;color:#f59e0b;text-transform:uppercase;letter-spacing:.06em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>
      <button id="tdq-close" aria-label="Close quiz" style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:var(--text-color,#6c757d);line-height:1;flex-shrink:0;min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:flex-end">&times;</button>
    </div>
    <div id="tdq-scroll-body" style="overflow-y:auto;padding:16px 20px 32px">
      <h3 style="font-size:1.1rem;font-weight:700;margin-bottom:3px;color:var(--text-color,#1e293b)"><i class="bi bi-patch-question-fill me-2" style="color:#f59e0b"></i>Test Your Knowledge</h3>
      <p style="font-size:.85rem;color:var(--text-color,#6c757d);margin-bottom:6px;opacity:.8">Based on the article you just read — 5 questions, under a minute.</p>
      <div id="tdq-progress" style="font-size:.78rem;font-weight:600;color:#f59e0b;margin-bottom:16px">0 of 5 answered</div>
      <div id="tdq-questions"></div>
      <button class="btn btn-warning mt-3" id="tdq-submit-btn" style="display:none"><i class="bi bi-check2-circle me-1"></i>Check Answers</button>
      <div id="tdq-score" class="mt-3" hidden></div>
    </div>
  </div>
  <div id="tdq-sentinel" style="height:1px"></div>
  <style>
    .tdq-question{margin-bottom:16px}.tdq-q-text{font-weight:600;margin-bottom:8px;font-size:.9rem;color:var(--text-color,#1e293b)}.tdq-options{display:flex;flex-direction:column;gap:7px}
    .tdq-opt{display:flex;align-items:center;gap:9px;padding:8px 12px;border:1.5px solid var(--card-border,#e2e8f0);border-radius:8px;cursor:pointer;font-size:.88rem;transition:background .15s,border-color .15s;user-select:none;color:var(--text-color,#1e293b)}
    .tdq-opt:hover{border-color:#f59e0b;background:rgba(245,158,11,.07)}.tdq-opt-selected{border-color:#f59e0b!important;background:rgba(245,158,11,.12)!important;font-weight:500}
    .tdq-opt-correct{border-color:#10b981!important;background:#d1fae5!important;color:#0f172a!important}.tdq-opt-wrong{border-color:#ef4444!important;background:#fee2e2!important;color:#0f172a!important}
    .tdq-opt-key{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#e2e8f0;font-size:.72rem;font-weight:700;flex-shrink:0}
    .tdq-opt-selected .tdq-opt-key{background:#f59e0b;color:#fff}.tdq-opt-correct .tdq-opt-key{background:#10b981;color:#fff}.tdq-opt-wrong .tdq-opt-key{background:#ef4444;color:#fff}
    body.dark-theme .tdq-opt{border-color:rgba(255,255,255,.15);color:#f8fafc}body.dark-theme .tdq-opt:hover{border-color:#f59e0b;background:rgba(245,158,11,.08)}
    body.dark-theme .tdq-opt-selected{border-color:#f59e0b!important;background:rgba(245,158,11,.15)!important}body.dark-theme .tdq-opt-key{background:#334155;color:#cbd5e1}
    body.dark-theme .tdq-opt-correct{background:rgba(16,185,129,.2)!important;border-color:#10b981!important;color:#e2e8f0!important}body.dark-theme .tdq-opt-wrong{background:rgba(239,68,68,.2)!important;border-color:#ef4444!important;color:#e2e8f0!important}
    .tdq-feedback{font-size:.82rem;margin-top:4px}.tdq-correct{color:#10b981;font-weight:600}.tdq-wrong{color:#ef4444;font-weight:600}
    .tdq-score-box{font-size:1rem;font-weight:600;padding:12px 14px;background:rgba(245,158,11,.1);border-radius:8px;border-left:4px solid #f59e0b}.tdq-score-num{color:#f59e0b;font-size:1.15rem}
    #tdq-popup{transition:transform .3s ease;transform:translateY(100%)}.tdq-popup-open{transform:translateY(0)!important;display:flex!important}
    #tdq-scroll-body{scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.2) transparent}#tdq-scroll-body::-webkit-scrollbar{width:4px}#tdq-scroll-body::-webkit-scrollbar-thumb{background:rgba(0,0,0,.2);border-radius:4px}
    body.dark-theme #tdq-scroll-body{scrollbar-color:rgba(255,255,255,.15) transparent}body.dark-theme #tdq-scroll-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15)}
    .tdq-cta-sub{color:#6c757d}body.dark-theme .tdq-cta-sub{color:#fff}
    body.dark-theme #tdq-header{border-bottom-color:rgba(255,255,255,.1)}
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
        var actionBtn = qi < total - 1
          ? '<button class="tdq-next-btn" id="tdq-next-' + qi + '" data-qi="' + qi + '" style="display:none;width:100%;margin-top:18px;padding:12px;background:#c2410c;color:#fff;border:none;border-radius:10px;font-size:.95rem;font-weight:600;cursor:pointer">Next Question <i class="bi bi-arrow-right ms-1"></i></button>'
          : '<button id="tdq-finish-btn" style="display:none;width:100%;margin-top:18px;padding:12px;background:#c2410c;color:#fff;border:none;border-radius:10px;font-size:.95rem;font-weight:600;cursor:pointer"><i class="bi bi-check2-circle me-1"></i>See Results</button>';
        return '<div class="tdq-question" id="tdq-q-' + qi + '" style="display:' + (qi === 0 ? 'block' : 'none') + '"><p class="tdq-q-text"><strong>' + (qi + 1) + '.</strong> ' + esc(String(q.q)) + '</p><div class="tdq-options">' + optsHtml + '</div><div class="tdq-feedback" id="tdq-f-' + qi + '" hidden></div>' + expHtml + actionBtn + '</div>';
      }).join("");
      container.querySelectorAll(".tdq-opt").forEach(function(opt) {
        opt.addEventListener("click", function() {
          var qi = parseInt(this.dataset.qi), oi = parseInt(this.dataset.oi);
          if (selected[qi] !== undefined) return;
          selected[qi] = oi;
          var correct = answers[qi];
          var opts = container.querySelectorAll('[data-qi="' + qi + '"]');
          opts.forEach(function(o) { o.style.pointerEvents = "none"; });
          opts[correct].classList.add("tdq-opt-correct");
          var fb = document.getElementById("tdq-f-" + qi);
          fb.hidden = false;
          if (oi === correct) {
            this.classList.add("tdq-opt-correct");
            fb.innerHTML = '<span class="tdq-correct">✓ Correct!</span>';
          } else {
            this.classList.add("tdq-opt-wrong");
            fb.innerHTML = '<span class="tdq-wrong">✗ Incorrect.</span> Correct: <strong>' + String.fromCharCode(65 + correct) + '</strong>';
          }
          var exp = document.getElementById("tdq-e-" + qi); if (exp) exp.hidden = false;
          var progEl = document.getElementById("tdq-progress");
          if (progEl) progEl.textContent = Object.keys(selected).length + " of " + total + " answered";
          var nextBtn = document.getElementById("tdq-next-" + qi);
          if (nextBtn) nextBtn.style.display = "";
          var finishBtn = document.getElementById("tdq-finish-btn");
          if (finishBtn && qi === total - 1) finishBtn.style.display = "";
        });
      });
      container.addEventListener("click", function(e) {
        var btn = e.target.closest(".tdq-next-btn");
        if (!btn) return;
        var qi = parseInt(btn.dataset.qi);
        var inner = document.querySelector("#tdq-popup [style*='overflow-y:auto']") || document.getElementById("tdq-popup");
        if (inner) inner.scrollTop = 0;
        document.getElementById("tdq-q-" + qi).style.display = "none";
        document.getElementById("tdq-q-" + (qi + 1)).style.display = "block";
      });
      var finishBtn = document.getElementById("tdq-finish-btn");
      if (finishBtn) finishBtn.addEventListener("click", function() {
        var score = 0;
        answers.forEach(function(correct, qi) { if (selected[qi] === correct) score++; });
        this.hidden = true;
        document.getElementById("tdq-q-" + (total - 1)).style.display = "none";
        var pct = Math.round(score / answers.length * 100);
        var msg = pct === 100 ? "Perfect score!" : pct >= 80 ? "Excellent!" : pct >= 60 ? "Good job!" : "Keep learning!";
        var el = document.getElementById("tdq-score");
        el.hidden = false;
        el.innerHTML = '<div class="tdq-score-box">You scored <span class="tdq-score-num">' + score + '/' + answers.length + '</span> (' + pct + '%) — ' + msg + '</div>';
        var inner = document.querySelector("#tdq-popup [style*='overflow-y:auto']") || document.getElementById("tdq-popup");
        if (inner) inner.scrollTop = 0;
      });
    }
    document.getElementById("tdq-submit-btn").addEventListener("click", function() {});
    function maybeLoadAndShow() {
      if (quizLoaded) return; quizLoaded = true;
      if (window.__tdqQuiz) { var q=window.__tdqQuiz; window.__tdqQuiz=null; renderQuiz(q); openPopup(); return; }
      fetch("/blog/quiz/" + slug)
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(quiz) { if (!quiz || !quiz.questions || quiz.questions.length < 3) return; renderQuiz(quiz); openPopup(); })
        .catch(function() {});
    }
    window.maybeLoadAndShowQuiz = function(){if(quizLoaded){openPopup();}else{maybeLoadAndShow();}};
    if (window.location.hash === "#quiz") { setTimeout(maybeLoadAndShow, 600); }
    if ("IntersectionObserver" in window) {
      var sentinel = document.getElementById("tdq-sentinel");
      var obs = new IntersectionObserver(function(entries) { if (entries[0].isIntersecting) { obs.disconnect(); setTimeout(maybeLoadAndShow, 800); } }, { threshold: 1.0 });
      obs.observe(sentinel);
    }
  })();
  <\/script>`;
          // Strip any old icon-based Explore card before injecting the new thumbnail version
          patchedHtml = patchedHtml.replace(
            /<div class="mt-4 p-3 rounded d-flex align-items-center gap-3"[^>]*>\s*<i class="bi bi-calendar3[\s\S]*?<\/div>\s*<\/div>/,
            "",
          );
          // Fix intermediate explore cards that have data-explore-injected but Bootstrap flex classes (no nowrap)
          patchedHtml = patchedHtml.replace(
            /(<div data-explore-injected="1" class="mt-4 p-3 rounded) d-flex[^"]*"([^>]*)>/g,
            '$1" style="display:flex;flex-direction:row;flex-wrap:nowrap;align-items:flex-start;gap:12px;background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.18)">',
          );
          // Build "Explore in History" section
          const _sp = slugParsedForThumb;
          let exploreHtml = "";
          if (_sp) {
            const _thumb = eventsThumb
              ? `<img src="/image-proxy?src=${encodeURIComponent(eventsThumb)}&w=80&q=75" alt="" width="64" height="64" style="width:64px;height:64px;min-width:64px;object-fit:cover;border-radius:8px;flex-shrink:0;display:block" loading="lazy"/>`
              : "";
            exploreHtml = `
          <div data-explore-injected="1" class="mt-4 p-3 rounded" style="display:flex;flex-direction:row;flex-wrap:nowrap;align-items:flex-start;gap:12px;background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.18)">
            ${_thumb}<div style="flex:1;min-width:0">
              <strong>Explore ${_sp.monthDisplay} ${_sp.day} in History</strong><br/>
              <small class="article-meta">See all events, births, and deaths recorded on this date.</small><br/>
              <a href="/events/${_sp.monthSlug}/${_sp.day}/" class="btn btn-sm btn-outline-primary mt-2">View ${_sp.monthDisplay} ${_sp.day}</a>
            </div>
          </div>`;
          }
          // Inject quiz before Wikipedia source box (matching March 14 template order)
          const wikiAnchor =
            '<div class="mt-4 p-3 rounded" style="background-color: rgba(59,130,246,0.08)';
          if (patchedHtml.includes(wikiAnchor)) {
            patchedHtml = patchedHtml.replace(
              wikiAnchor,
              quizCta + "\n          " + wikiAnchor,
            );
            if (
              exploreHtml &&
              !patchedHtml.includes('data-explore-injected="1"')
            ) {
              const afterWikiAnchor = patchedHtml.includes("<!-- Quiz CTA -->")
                ? "<!-- Quiz CTA -->"
                : patchedHtml.includes("You Might Also Like")
                  ? '<h2 class="h5 mb-3">You Might Also Like</h2>'
                  : "</article>";
              patchedHtml = patchedHtml.replace(
                afterWikiAnchor,
                exploreHtml + "\n          " + afterWikiAnchor,
              );
            }
          } else {
            const quizAnchor = patchedHtml.includes("You Might Also Like")
              ? '<h2 class="h5 mb-3">You Might Also Like</h2>'
              : "</article>";
            patchedHtml = patchedHtml.replace(
              quizAnchor,
              quizCta + "\n          " + quizAnchor,
            );
          }
          const bodyClose = patchedHtml.includes("</body>")
            ? "</body>"
            : "</html>";
          patchedHtml = patchedHtml.replace(
            bodyClose,
            quizBlock + "\n" + bodyClose,
          );
        }
        // Strip chatbot from old KV posts (now removed from template)
        if (patchedHtml.includes("chatbot")) {
          patchedHtml = patchedHtml.replace(
            /<script\s+src="\/js\/chatbot\.js"><\/script>/g,
            "",
          );
          patchedHtml = patchedHtml.replace(
            /<button[^>]+id="chatbotToggle"[^>]*>[\s\S]*?<\/button>/g,
            "",
          );
          const chatbotCss =
            "<style>#chatbotToggle,#chatbotWindow,.chatbot-toggle,.chatbot-window{display:none!important}</style>";
          if (patchedHtml.includes("</head>")) {
            patchedHtml = patchedHtml.replace(
              "</head>",
              chatbotCss + "</head>",
            );
          } else {
            patchedHtml = patchedHtml.replace(
              /(<body[^>]*>)/,
              "$1" + chatbotCss,
            );
          }
        }
        // Always strip old icon-based Explore card (covers KV that has both old + new)
        if (patchedHtml.includes("bi-calendar3")) {
          patchedHtml = patchedHtml.replace(
            /<div class="mt-4 p-3 rounded d-flex align-items-center gap-3"[^>]*>\s*<i class="bi bi-calendar3[\s\S]*?<\/div>\s*<\/div>/,
            "",
          );
        }
        // Inject "Explore [Date] in History" card for any post missing it (covers posts with quiz already baked in)
        if (
          !patchedHtml.includes('data-explore-injected="1"') &&
          slugParsedForThumb
        ) {
          const sp = slugParsedForThumb;
          const thumb = eventsThumb
            ? `<img src="/image-proxy?src=${encodeURIComponent(eventsThumb)}&w=80&q=75" alt="" width="64" height="64" style="width:64px;height:64px;min-width:64px;object-fit:cover;border-radius:8px;flex-shrink:0;display:block" loading="lazy"/>`
            : "";
          const exploreCard = `<div data-explore-injected="1" class="mt-4 p-3 rounded" style="display:flex;flex-direction:row;flex-wrap:nowrap;align-items:flex-start;gap:12px;background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.18)">${thumb}<div style="flex:1;min-width:0"><strong>Explore ${sp.monthDisplay} ${sp.day} in History</strong><br/><small class="article-meta">See all events, births, and deaths recorded on this date.</small><br/><a href="/events/${sp.monthSlug}/${sp.day}/" class="btn btn-sm btn-outline-primary mt-2">View ${sp.monthDisplay} ${sp.day}</a></div></div>`;
          const anchor = patchedHtml.includes("<!-- Quiz CTA -->")
            ? "<!-- Quiz CTA -->"
            : patchedHtml.includes("You Might Also Like")
              ? '<h2 class="h5 mb-3">You Might Also Like</h2>'
              : "</article>";
          patchedHtml = patchedHtml.replace(
            anchor,
            exploreCard + "\n          " + anchor,
          );
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
            patchedHtml = patchedHtml.replace(
              "</html>",
              progressJs + "</html>",
            );
          }
        }
        // Patch old blue quiz option selection → amber (matches btn-warning on homepage)
        if (patchedHtml.includes("tdq-opt-selected{border-color:#3b82f6")) {
          patchedHtml = patchedHtml.replace(
            "</head>",
            "<style>.tdq-opt:hover{border-color:#f59e0b!important;background:rgba(245,158,11,.07)!important}.tdq-opt-selected{border-color:#f59e0b!important;background:rgba(245,158,11,.12)!important}.tdq-opt-selected .tdq-opt-key{background:#f59e0b!important}body.dark-theme .tdq-opt:hover{border-color:#f59e0b!important;background:rgba(245,158,11,.08)!important}body.dark-theme .tdq-opt-selected{border-color:#f59e0b!important;background:rgba(245,158,11,.15)!important}</style></head>",
          );
        }
        // Inject floating quiz bar into stored posts that don't have it yet
        if (!patchedHtml.includes("tdq-float-bar")) {
          const floatCss = `<style>#tdq-float-bar{position:fixed;bottom:0;left:0;right:0;z-index:1020;background:rgba(15,23,42,.96);backdrop-filter:blur(4px);box-shadow:0 -2px 16px rgba(0,0,0,.3);transform:translateY(100%);transition:transform .35s cubic-bezier(.22,.61,.36,1);padding:10px 16px;padding-bottom:max(10px,env(safe-area-inset-bottom));display:flex;align-items:center;justify-content:center}#tdq-float-bar.tdq-float-visible{transform:translateY(0)}#tdq-float-btn{background:linear-gradient(90deg,#f59e0b,#d97706);border:none;border-radius:100px;color:#fff;font-weight:700;font-size:.95rem;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;padding:11px 28px;box-shadow:0 2px 12px rgba(245,158,11,.35);max-width:320px;width:100%}#tdq-float-btn:hover{background:linear-gradient(90deg,#d97706,#b45309);box-shadow:0 2px 16px rgba(245,158,11,.5)}</style>`;
          const floatHtml = `<div id="tdq-float-bar"><button id="tdq-float-btn"><i class="bi bi-patch-question-fill"></i> Quiz This Day</button></div>`;
          const floatJs = `<script>(function(){var bar=document.getElementById('tdq-float-bar');var btn=document.getElementById('tdq-float-btn');var closeBtn=document.getElementById('tdq-close');if(!bar||!btn)return;function showBar(){bar.classList.add('tdq-float-visible');}function hideBar(){bar.classList.remove('tdq-float-visible');}btn.addEventListener('click',function(){hideBar();var overlay=document.getElementById('tdq-overlay');var popup=document.getElementById('tdq-popup');if(overlay)overlay.style.display='block';if(popup){popup.style.display='block';requestAnimationFrame(function(){popup.classList.add('tdq-popup-open');});}document.body.style.overflow='hidden';if(typeof maybeLoadAndShowQuiz==='function')maybeLoadAndShowQuiz();});if(closeBtn)closeBtn.addEventListener('click',function(){setTimeout(showBar,300);});var h2s=document.querySelectorAll('h2');var trigger=null;for(var i=0;i<h2s.length;i++){if(h2s[i].textContent.indexOf('Eyewitness')!==-1){trigger=h2s[i];break;}}if(trigger){function updateBar(){var rect=trigger.getBoundingClientRect();if(rect.top<window.innerHeight){showBar();}else{hideBar();}}window.addEventListener('scroll',updateBar,{passive:true});}else{document.addEventListener('scroll',function onScroll(){var d=document.documentElement;var total=d.scrollHeight-d.clientHeight;if(total>0&&d.scrollTop/total>0.35){showBar();document.removeEventListener('scroll',onScroll);}},{passive:true});}})();<\/script>`;
          const bodyClose = patchedHtml.includes("</body>")
            ? "</body>"
            : "</html>";
          patchedHtml = patchedHtml
            .replace("</head>", floatCss + "</head>")
            .replace(bodyClose, floatHtml + "\n" + floatJs + "\n" + bodyClose);
        }
        // Inject AdSense ad unit into stored posts that don't have one yet
        // Only inject for posts from March 2026 onwards — leave older posts alone
        const _adParts = slug.match(/^(\d+)-([a-z]+)-(\d{4})$/i);
        const _adYear = _adParts ? parseInt(_adParts[3], 10) : 0;
        const _adMonthIdx = _adParts
          ? MONTH_SLUGS.indexOf(_adParts[2].toLowerCase())
          : -1;
        const _isRecentPost =
          _adYear > 2026 || (_adYear === 2026 && _adMonthIdx >= 2);
        if (
          _isRecentPost &&
          !patchedHtml.includes('<ins class="adsbygoogle"') &&
          patchedHtml.includes("</article>")
        ) {
          const adUnit = `<div class="ad-unit-container"><span class="ad-unit-label">Advertisement</span><ins class="adsbygoogle" data-ad-client="ca-pub-8565025017387209" data-ad-slot="9477779891" data-ad-format="auto" data-full-width-responsive="true"></ins></div>`;
          const adInitJs = `<script>(function(){if(location.hostname!=='thisday.info'&&location.hostname!=='www.thisday.info')return;var ins=document.querySelector('ins.adsbygoogle');if(!ins)return;function push(){if(!ins.getAttribute('data-adsbygoogle-status')){try{(adsbygoogle=window.adsbygoogle||[]).push({});}catch(e){}}}if('IntersectionObserver' in window){new IntersectionObserver(function(e,o){if(e[0].isIntersecting){push();o.disconnect();}},{threshold:0.1}).observe(ins);}else{push();}})();<\/script>`;
          const bodyClose2 = patchedHtml.includes("</body>")
            ? "</body>"
            : "</html>";
          const lastArticleIdx = patchedHtml.lastIndexOf("</article>");
          patchedHtml =
            patchedHtml.slice(0, lastArticleIdx + "</article>".length) +
            "\n" +
            adUnit +
            patchedHtml.slice(lastArticleIdx + "</article>".length);
          patchedHtml = patchedHtml.replace(
            bodyClose2,
            adInitJs + "\n" + bodyClose2,
          );
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
          let ytHtml = patchedHtml.replace(
            /<!-- YouTube -->[\s\S]*?<!-- Aftermath -->/,
            ytIframe,
          );
          // Inject VideoObject JSON-LD schema for SEO
          if (!ytHtml.includes('"@type":"VideoObject"')) {
            // Extract title and description from existing NewsArticle schema or meta tags
            const titleMatch = ytHtml.match(
              /<meta property="og:title" content="([^"]+)"/,
            );
            const descMatch = ytHtml.match(
              /<meta(?:\s+(?:name="description"|property="og:description"))\s+content="([^"]+)"/,
            );
            const postTitle = titleMatch ? titleMatch[1] : slug;
            const postDesc = descMatch ? descMatch[1] : "";
            const videoSchema = {
              "@context": "https://schema.org",
              "@type": "VideoObject",
              name: postTitle,
              description: postDesc,
              thumbnailUrl: `https://img.youtube.com/vi/${ytEntry.youtubeId}/maxresdefault.jpg`,
              uploadDate: ytEntry.uploadedAt ?? new Date().toISOString(),
              duration: "PT45S",
              embedUrl: `https://www.youtube.com/embed/${ytEntry.youtubeId}`,
              contentUrl: `https://www.youtube.com/shorts/${ytEntry.youtubeId}`,
              publisher: {
                "@type": "Organization",
                name: "thisDay.info",
                url: "https://thisday.info",
                logo: {
                  "@type": "ImageObject",
                  url: "https://thisday.info/icons/android-chrome-192x192.png",
                },
              },
            };
            ytHtml = ytHtml.replace(
              "</head>",
              `<script type="application/ld+json">${JSON.stringify(videoSchema)}<\/script></head>`,
            );
          }
          return htmlResponse(ytHtml);
        }
        // Inline quiz JSON so popup opens instantly (no fetch round-trip)
        const inlineQuizRaw = await env.BLOG_AI_KV.get(`quiz-v3:blog:${slug}`);
        if (inlineQuizRaw) {
          const bodyCloseInline = patchedHtml.includes("</body>")
            ? "</body>"
            : "</html>";
          patchedHtml = patchedHtml.replace(
            bodyCloseInline,
            `<script>window.__tdqQuiz=${inlineQuizRaw};<\/script>\n${bodyCloseInline}`,
          );
        }
        // Pre-warm quiz in background so it's ready before the user clicks "Take the Quiz"
        ctx.waitUntil(
          (async () => {
            const cached =
              inlineQuizRaw ||
              (await env.BLOG_AI_KV.get(`quiz-v3:blog:${slug}`));
            if (!cached && (env.AI || env.GROQ_API_KEY)) {
              try {
                const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
                const index = indexRaw ? JSON.parse(indexRaw) : [];
                const entry = index.find((p) => p.slug === slug);
                if (entry) {
                  const richContent = await buildRichContent(entry, slug);
                  const quiz = await generateBlogQuiz(env, richContent, slug);
                  if (quiz)
                    await env.BLOG_AI_KV.put(
                      `quiz-v3:blog:${slug}`,
                      JSON.stringify(quiz),
                      { expirationTtl: 90 * 86_400 },
                    );
                }
              } catch (e) {
                console.error("Quiz pre-warm failed:", e);
              }
            }
          })(),
        );
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
async function maybeGenerateBlogPost(env, ctx) {
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
      await generateAndStore(env, ctx);
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
async function generateAndStore(env, ctx, forcedEvent = null) {
  const now = new Date();
  const activeModel = await resolveAiModel(env.BLOG_AI_KV);

  // Collect titles already published (all-time, capped at 50) so the AI avoids duplicates
  const indexRaw = await env.BLOG_AI_KV.get(KV_INDEX_KEY);
  const existingIndex = indexRaw ? JSON.parse(indexRaw) : [];
  // Full dedup list: most recent 50 posts across all time
  // When a forced event is provided, exclude it from the avoid list so the AI can write about it
  const takenAllTime = existingIndex
    .slice()
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, 50)
    .map((e) => e.title)
    .filter(
      (t) =>
        !forcedEvent ||
        !t
          .toLowerCase()
          .startsWith(
            forcedEvent.toLowerCase().split(" — ")[0].trim().toLowerCase(),
          ),
    );

  let content = await callWorkersAI(
    env.AI,
    now,
    takenAllTime,
    activeModel,
    forcedEvent,
  );

  // SEO expert review: improve meta fields, descriptions, keywords, and paragraph
  // sentence length before building HTML. Falls back to original on any error.
  content = await reviewContentWithSEOExpert(content, env);

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
      const avoid = [...takenAllTime, content.title].filter(Boolean);
      console.warn(
        `Blog AI: no valid image for \"${content.title}\". Regenerating content (${attempt + 1}/${MAX_CONTENT_ATTEMPTS}).`,
      );
      content = await callWorkersAI(env.AI, now, avoid, activeModel);
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
      `Discover the story of ${content.eventTitle} on ${content.historicalDate}${loc}.`.substring(
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

  // Core write is done — fire all post-publish extras in the background so
  // the response (or cron return) is not blocked by quiz generation, cache
  // purges, pings, or Discord. ctx may be undefined in unit tests — guard it.
  if (ctx?.waitUntil) {
    ctx.waitUntil(runPostPublishExtras(env, slug, content));
  } else {
    // Fallback for environments without ctx (e.g. tests): run synchronously
    await runPostPublishExtras(env, slug, content);
  }

  console.log(
    `Blog: published post "${content.title}" → /blog/archive/${slug}/`,
  );
}

/**
 * All non-critical post-publish work: cache purges, quiz generation,
 * quiz page cache bust, WebSub ping, Discord notify.
 * Runs via ctx.waitUntil() so it never blocks the HTTP response / cron return.
 */
async function runPostPublishExtras(env, slug, content) {
  // Purge the cached sitemap and RSS feed so they reflect the new post immediately
  // (both workers cache for 1 h — without this, the new post would be invisible
  //  to crawlers until the next cache expiry).
  const cache = caches.default;
  await Promise.allSettled([
    cache.delete(new Request("https://thisday.info/sitemap.xml")),
    cache.delete(new Request("https://thisday.info/rss.xml")),
    cache.delete(new Request("https://thisday.info/news-sitemap.xml")),
    // Optional: ping search engines so they discover sitemap updates faster.
    fetch("https://thisday.info/search-ping", {
      method: "POST",
      headers: env.SEARCH_PING_SECRET
        ? { Authorization: `Bearer ${env.SEARCH_PING_SECRET}` }
        : {},
    }),
  ]);

  // Generate and store a quiz for this blog post using rich context from the live post HTML
  try {
    const richContent = await buildRichContent(
      { title: content.title, description: content.description || "" },
      slug,
    );
    const enrichedContent = { ...content, ...richContent };
    const quiz = await generateBlogQuiz(env, enrichedContent, slug);
    if (quiz) {
      await env.BLOG_AI_KV.put(`quiz-v3:blog:${slug}`, JSON.stringify(quiz), {
        expirationTtl: 90 * 86_400,
      });
    }
  } catch (e) {
    console.error("Blog quiz generation failed:", e);
  }

  // Bust the quiz page HTML cache so /quiz/{month}/{day}/ rebuilds with the new blog quiz
  if (env.EVENTS_KV) {
    try {
      const sp = parseSlugDate(slug);
      if (sp) {
        const mPad = String(sp.monthIndex + 1).padStart(2, "0");
        const dPad = String(sp.day).padStart(2, "0");
        await env.EVENTS_KV.delete(`quiz-page-v21:${mPad}-${dPad}`);
        console.log(`Blog: busted quiz-page-v21:${mPad}-${dPad} cache`);
      }
    } catch (e) {
      console.error("Blog: quiz page cache bust failed:", e);
    }
  }

  // Ping WebSub hub so Flipboard (and other subscribers) get notified immediately
  try {
    const hubBody = new URLSearchParams({
      "hub.mode": "publish",
      "hub.url": "https://thisday.info/rss.xml",
    });
    await fetch("https://pubsubhubbub.appspot.com/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: hubBody,
    });
    console.log("Blog: WebSub hub pinged");
  } catch (e) {
    console.error("Blog: WebSub ping failed:", e);
  }

  // Notify Discord that a new post has been published (silent no-op if not configured).
  // Set DISCORD_WEBHOOK_URL via:  npx wrangler secret put DISCORD_WEBHOOK_URL --config wrangler-blog.jsonc
  if (env.DISCORD_WEBHOOK_URL) {
    try {
      const postUrl = `https://thisday.info/blog/${slug}/`;
      const message =
        `📰 **New blog post published**\n` +
        `📖 ${content.title}\n` +
        `🌐 ${postUrl}`;
      await fetch(env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message }),
      });
      console.log("Blog: Discord notified");
    } catch (e) {
      console.warn("Blog: Discord notify failed:", e.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Blog quiz generation
// ---------------------------------------------------------------------------

/**
 * Quiz Expert — uses Cloudflare Workers AI (same free binding as quiz generation)
 * to review and sharpen quiz questions after the initial generation pass.
 *
 * Goals:
 *   - Replace trivially easy recall questions with analytical or synthesis ones
 *   - Make wrong options plausible (same era, same field, genuinely confusable)
 *   - Ensure at least 3 of 5 questions require knowing a non-obvious fact
 *   - Preserve question variety (Who / What / Why+How / When+Where)
 *   - Keep the exact JSON schema unchanged so the frontend works without changes
 *
 * Falls back silently to original questions if the AI binding is absent,
 * the response is malformed, or validation fails.
 *
 * @param {Array}  questions  Validated questions from generateBlogQuiz()
 * @param {object} content    Rich content object (title, keyFacts, etc.)
 * @param {object} env        Worker environment bindings
 * @returns {Promise<Array>}  Improved questions, or originals on any failure
 */
async function reviewQuizWithExpert(questions, content, env) {
  if (!env.AI && !env.GROQ_API_KEY) return questions;

  const contextLines = [
    `Title: ${content.title}`,
    content.historicalDate ? `Date: ${content.historicalDate}` : "",
    ...(content.keyFacts || []).slice(0, 12).map((f) => `Fact: ${f}`),
  ]
    .filter(Boolean)
    .join("\n");

  let systemPrompt =
    "You are a rigorous history quiz editor. You receive a 5-question multiple-choice quiz " +
    "and a set of historical facts. Your job is to make the quiz harder and more educational " +
    "without changing its structure.\n\n" +
    "Rules:\n" +
    "- Keep all 5 questions, same order\n" +
    "- Keep the same JSON schema: {q, options, answer, explanation}\n" +
    "- answer is still a 0-based index (0-3) into options\n" +
    "- Make trivially easy questions harder by asking for a less obvious detail\n" +
    "- Wrong options must be plausible: same era, same country, same field — not obviously wrong\n" +
    "- At least 3 questions should require knowing a non-obvious fact, not just re-reading the title\n" +
    "- Never trick or mislead — every correct answer must be clearly supported by the facts provided\n" +
    "- Update the explanation to match any changes\n" +
    '- Output ONLY valid JSON, no markdown: {"questions":[...]}';

  // Punctuation guidance: ensure quiz text uses commas/semicolons rather than
  // in-sentence hyphens or em dashes. If you find '-' or '—' inside a sentence,
  // replace with a comma or rewrite for clarity.
  systemPrompt +=
    "\n\nPUNCTUATION NOTE: Do not use hyphens (-) or em dashes (—) inside sentences in questions or explanations. Use commas, semicolons, or rephrase the sentence instead.";

  const userMessage =
    `Historical context:\n${contextLines}\n\n` +
    `Current quiz (JSON):\n${JSON.stringify({ questions }, null, 2)}\n\n` +
    `Return the improved quiz as JSON: {"questions":[{"q":"...","options":["A","B","C","D"],"answer":0,"explanation":"..."}]}`;

  let raw;
  try {
    raw = await callAI(
      env,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      { maxTokens: 2000, timeoutMs: 25_000 },
    );
  } catch (err) {
    console.warn(
      `Quiz expert: AI call failed (${err.message}) — using original questions`,
    );
    return questions;
  }
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    console.warn(
      "Quiz expert: no JSON object in response — using original questions",
    );
    return questions;
  }

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    console.warn("Quiz expert: JSON parse error — using original questions");
    return questions;
  }

  const improved = parsed?.questions;
  if (
    !Array.isArray(improved) ||
    improved.length !== questions.length ||
    !improved.every(
      (q) =>
        typeof q.q === "string" &&
        q.q.trim().length > 10 &&
        Array.isArray(q.options) &&
        q.options.length === 4 &&
        q.options.every((o) => typeof o === "string" && o.trim().length > 2) &&
        Number.isInteger(q.answer) &&
        q.answer >= 0 &&
        q.answer <= 3 &&
        typeof q.explanation === "string" &&
        q.explanation.trim().length > 8,
    )
  ) {
    console.warn("Quiz expert: validation failed — using original questions");
    return questions;
  }

  console.log("Quiz expert: questions reviewed and sharpened");
  return improved;
}

// Fetch a blog post's HTML and extract rich context for quiz generation
async function extractRichContext(slug) {
  try {
    const res = await fetch(`https://thisday.info/blog/${slug}`, {
      headers: { "User-Agent": "thisday-quiz-bot/1.0" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const ctx = {};
    // Quick facts table: <th>…</th> … <td>…</td>
    const factRows = [
      ...html.matchAll(
        /<th[^>]*>([\s\S]*?)<\/th>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/gi,
      ),
    ];
    ctx.quickFacts = factRows
      .map(
        ([, k, v]) =>
          `${k.replace(/<[^>]+>/g, "").trim()}: ${v.replace(/<[^>]+>/g, "").trim()}`,
      )
      .filter(Boolean);
    // Did You Know + analysis list items — grab informative <li> items (>40 chars)
    const liItems = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
      .map(([, v]) =>
        v
          .replace(/<[^>]+>/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter((s) => s.length > 40 && s.length < 400);
    ctx.facts = liItems.slice(0, 12);
    // Article paragraphs from <p> tags inside the article (skip very short ones)
    const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map(([, v]) =>
        v
          .replace(/<[^>]+>/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter((s) => s.length > 80 && s.length < 750);
    ctx.paragraphs = paras.slice(0, 6);
    return ctx;
  } catch (e) {
    return null;
  }
}

// Build a rich content object for quiz generation from index entry + parsed HTML
async function buildRichContent(entry, slug) {
  const titleParts = (entry.title || slug).split(" - ");
  const base = {
    title: entry.title || slug,
    eventTitle: titleParts[0] || entry.title || slug,
    historicalDate: titleParts[1] || "",
    location: "",
    country: "",
    description: entry.description || entry.title || "",
    keyFacts: [],
  };
  const rich = await extractRichContext(slug);
  if (rich) {
    if (rich.quickFacts?.length) {
      const locFact = rich.quickFacts.find((f) => /^Location:/i.test(f));
      if (locFact) {
        const parts = locFact
          .replace(/^Location:\s*/i, "")
          .split(",")
          .map((s) => s.trim());
        base.location = parts[0] || "";
        base.country = parts[1] || "";
      }
      // Put rich Did You Know / analysis facts FIRST — they produce better questions
      // Quick facts (date, name) go last so the AI focuses on the interesting content
      base.keyFacts = [...(rich.facts || []), ...rich.quickFacts].slice(0, 15);
    } else if (rich.facts?.length) {
      base.keyFacts = rich.facts.slice(0, 15);
    }
    if (rich.paragraphs?.length)
      base.description = rich.paragraphs
        .slice(0, 3)
        .join(" ")
        .substring(0, 800);
  }
  return base;
}

async function generateBlogQuiz(env, content, _slug) {
  if (!env.AI && !env.GROQ_API_KEY) return null;

  const contextLines = [
    `Title: ${content.title}`,
    `Event: ${content.eventTitle} on ${content.historicalDate}`,
    content.location || content.country
      ? `Location: ${[content.location, content.country].filter(Boolean).join(", ")}`
      : "",
    content.description
      ? `Summary: ${content.description.replace(/Published:.*?min read\s*/s, "").substring(0, 400)}`
      : "",
    ...(content.keyFacts || []).slice(0, 15).map((f) => `Fact: ${f}`),
  ].filter(Boolean);

  // Skip AI only if we have truly nothing beyond title/event line
  const factLines = contextLines.filter(
    (l) => l.startsWith("Fact:") || l.startsWith("Summary:"),
  );
  if (factLines.length < 1) {
    console.error(
      `Blog quiz: no context for "${content.title}" — skipping AI call`,
    );
    return null;
  }

  let raw;
  try {
    raw = await callAI(
      env,
      [
        {
          role: "system",
          content:
            "You are a history quiz creator. Always respond with valid JSON only, no markdown, no extra text.",
        },
        {
          role: "user",
          content: `Generate a 5-question multiple choice quiz based on this historical blog post.\n\nContext:\n${contextLines.join("\n")}\n\nRules:\n- Exactly 5 questions, no more no less\n- Each question has exactly 4 options (never fewer, never more)\n- Exactly one correct answer per question (0-based index in "answer", must be 0, 1, 2, or 3)\n- Question types must vary: include at least one each of Who, What, Why/How, When/Where\n- Questions must progress: 1 easy recall, 2 medium analysis, 2 challenging synthesis\n- Draw from ALL Fact lines — do not repeat the same topic twice\n- Wrong options must be plausible but clearly incorrect; no trick questions\n- Each question must include a short "explanation" field (1-2 sentences) explaining why the answer is correct\n- All strings must be non-empty and longer than 5 characters\n- Output ONLY valid JSON, no markdown:\n{"questions":[{"q":"Question?","options":["A","B","C","D"],"answer":0,"explanation":"Why this answer is correct."}]}`,
        },
      ],
      { maxTokens: 1500, timeoutMs: 25_000 },
    );
  } catch (err) {
    console.error("Blog quiz: AI call failed —", err.message);
    return null;
  }
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
  if (!Array.isArray(parsed?.questions) || parsed.questions.length !== 5)
    return null;
  const valid = parsed.questions.filter(
    (q) =>
      q.q &&
      typeof q.q === "string" &&
      q.q.trim().length > 10 &&
      Array.isArray(q.options) &&
      q.options.length === 4 &&
      q.options.every((o) => typeof o === "string" && o.trim().length > 2) &&
      Number.isInteger(q.answer) &&
      q.answer >= 0 &&
      q.answer <= 3 &&
      q.explanation &&
      typeof q.explanation === "string" &&
      q.explanation.trim().length > 8,
  );
  if (valid.length !== 5) return null;
  const sharpened = await reviewQuizWithExpert(valid, content, env);
  return { ...parsed, questions: sharpened };
}

// ---------------------------------------------------------------------------
// Claude API call
// ---------------------------------------------------------------------------

async function callWorkersAI(
  ai,
  date,
  takenThisMonth = [],
  model = CF_AI_MODEL,
  forcedEvent = null,
) {
  const monthName = MONTH_NAMES[date.getMonth()];
  const day = date.getDate();

  const avoidSection =
    takenThisMonth.length > 0
      ? `\nThese topics have already been covered recently — do NOT write about any of them:\n${takenThisMonth.map((t) => `- ${t}`).join("\n")}\nChoose a completely different event.\n`
      : "";

  const eventSelection = forcedEvent
    ? `You MUST write about this specific event: "${forcedEvent}". Do not choose a different event.`
    : `Write a detailed, engaging blog post about a significant historical event that occurred on ${monthName} ${day} (any year). Choose the most interesting or impactful event for this exact date.`;

  const prompt = `You are a historical content writer for "thisDay.info", a website about historical events.

STRICT DATE REQUIREMENT: You MUST write about an event that occurred on ${monthName} ${day} ONLY. The event must have taken place in the month of ${monthName} on day ${day}. Events from ANY other month or day are strictly forbidden. Before choosing an event, verify it happened on ${monthName} ${day}. If you are not certain an event occurred on ${monthName} ${day}, choose a different event you are confident about.

${eventSelection}
${avoidSection}
The article must be substantial — at least 1,500 words of body content across all paragraph fields combined. Every paragraph must earn its place with real historical depth, not filler.

VOICE AND PERSONALITY — this is the most important instruction:
Write like a passionate history obsessive who has spent weeks researching this event and genuinely cannot believe more people do not know about it. You have opinions. You find things surprising, tragic, infuriating, or inspiring, and you say so. You are not a textbook. You are not a Wikipedia summary. You are a storyteller who happens to know an enormous amount of history.

Specific voice qualities:
- Open sections with a scene, a striking detail, or a provocative question — not with "The event was..."
- Use vivid, concrete language. Instead of "there was widespread suffering", write what the suffering looked like, smelled like, felt like.
- Have a point of view. If a leader made a cowardly decision, say so. If an act was unexpectedly brave, say so. Readers come for analysis, not neutrality.
- Use transitions that show your thinking: "What makes this stranger still is...", "Here is what the textbooks skip over:", "The irony is remarkable:", "Most people assume X, but the reality was Y."
- Connect the past to something the reader recognizes. A parallel to a modern situation, a personality trait that feels familiar, a consequence we still live with today.

Sentence and paragraph rules:
- Mix sentence lengths deliberately for rhythm. Some sentences can be 30+ words when building a complex, layered point. Use short sentences (under 10 words) for emphasis and dramatic beats. Never write five consecutive sentences of the same length.
- Target an average of 18-22 words per sentence across each paragraph. This creates readable depth without choppiness.
- Every paragraph must contain at least one specific, verifiable fact: a real name, an exact year or number, a specific place, or a direct quote. No paragraph may consist entirely of vague generalizations.
- Do not use dashes ("-" or "—") inside sentences. Use commas, semicolons, or rewrite.
- Use active voice. Say who did what.
- Start each paragraph with a sentence that makes the reader want to keep reading.
- Use transition phrases between paragraphs: "What followed was even more remarkable.", "But the real damage was done quietly, in the years after.", "To understand why this mattered, you have to go back further."
- When nuance or complication enters a paragraph, represent it at its strongest — give the best version of the opposing case, not the weakest. Do not signal you are doing this with phrases like "critics argue" or "some would say." Just write it directly as part of the narrative flow: "Nehru rejected the resolution not because he dismissed Muslim concerns, but because he believed division would harden them into interstate conflict." Strong nuance woven naturally is far more persuasive than a weak position you announce and dismiss.

BANNED PHRASES — never write any of these:
"significant event", "pivotal moment", "changed history", "shaped the course of", "left a lasting impact", "cannot be overstated", "one of the most important", "it is worth noting", "it is important to remember", "this was a time of great change", "the importance of this", "a reminder of", "shows the importance of", "demonstrated the power of". These are filler. Replace them with the specific fact or analysis that the phrase was trying to avoid writing.

Title rules:
- The "title" field MUST follow exactly this format: "[Specific Action or Event] — ${monthName} ${day}, Year"
- The first part must be the specific historical event name (e.g. "Assassination of Julius Caesar", "Apollo 11 Moon Landing", "Fall of Constantinople").
- Do NOT use colloquial date names or phrases like "Ides of March", "D-Day", or "Black Tuesday" as the title — use the actual event name instead.
- The separator between event name and date MUST be " — " (space, em dash, space).

Reply with ONLY a raw JSON object. No markdown, no code fences, no explanation — just the JSON.

{
  "title": "Specific Event Name — ${monthName} ${day}, Year",
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
    "A genuinely surprising lesser-known fact — something most people would not expect, 2 to 3 sentences, minimum 40 words. Must include a specific name, number, or place.",
    "A detail that reframes the main story or reveals a hidden layer of complexity, 2 to 3 sentences, minimum 40 words.",
    "A fact that connects the event to something unexpected — a consequence, a coincidence, or a strange footnote, 2 to 3 sentences, minimum 40 words."
  ],
  "overviewParagraphs": [
    "Paragraph 1 (claim + strongest evidence; ~120+ words): Open with a striking scene or detail and state the core claim about why this event mattered. Include the single strongest, attributable piece of evidence (name, year, number, or place) that supports the claim. Be vivid, specific, and direct.",
    "Paragraph 2 (nuance + synthesis; ~100 words): Introduce the strongest complication or contrary reality naturally, without announcing it as 'the opposing view' or 'critics argue'. Just write it as part of the narrative. Then synthesize: show where the complication holds and where it falls short. End with a brief assessment that links back to the opening claim."
  ],
  "eyewitnessOrChronicle": [
    "Paragraph 1 (vivid account; ~100+ words): Present the most vivid contemporary account with full attribution (name, role, source). Let the account show the texture of the moment — what a named eyewitness described and why their perspective matters.",
    "Paragraph 2 (contrast + historical appraisal; ~100+ words): Offer a contrasting contemporary perspective or later scholarly appraisal, and explain what the gap between accounts reveals about narrative control, bias, or documentary limits. End with what historians now agree or still dispute."
  ],
  "eyewitnessQuote": "A direct or closely paraphrased quote from a named contemporary source, under 200 characters. Must be attributed to a real person or document.",
  "eyewitnessQuoteSource": "Full attribution: name, role, and source document with year — e.g. 'Ivan Turgenev, letter to a friend, March 1861'",
  "aftermathParagraphs": [
    "Paragraph 1 (immediate aftermath; ~120+ words): Describe the first days and weeks after the event with concrete actions, dates, and effects on people and institutions. Focus on specific, attributable changes on the ground.",
    "Paragraph 2 (medium-term + long view synthesis; ~120+ words): Combine medium-term consequences and the long historical assessment: reforms, responses, and how historians judge the legacy. Be specific and, where appropriate, opinionated."
  ],
  "conclusionParagraphs": [
    "Paragraph 1 (honest assessment; ~100+ words): State plainly what the event changed and what remained. Be precise: name people, systems, or ideas affected. Avoid vague grandiosity.",
    "Paragraph 2 (modern resonance + closing thought; ~80+ words): Draw a direct modern parallel or leave the reader with a pointed question or observation that lingers. End with a concise, memorable final sentence."
  ],
  "analysisGood": [
    { "title": "Concise label (3-5 words)", "detail": "Minimum 60 words. Name who deserves credit and why. Describe the specific decision, action, or circumstance that worked, what the alternatives were, and why this outcome was not guaranteed. No generic praise." },
    { "title": "Concise label (3-5 words)", "detail": "Minimum 60 words. Same standard — specific, analytical, opinionated." },
    { "title": "Concise label (3-5 words)", "detail": "Minimum 60 words. Same standard." }
  ],
  "analysisBad": [
    { "title": "Concise label (3-5 words)", "detail": "Minimum 60 words. Name who is responsible. Describe the specific failure, what the stakes were, and what a better decision would have looked like. Do not be vague or diplomatic." },
    { "title": "Concise label (3-5 words)", "detail": "Minimum 60 words. Same standard." },
    { "title": "Concise label (3-5 words)", "detail": "Minimum 60 words. Same standard." },
    { "title": "Optional: a systemic or institutional failure", "detail": "Minimum 60 words. The failure that no single person owned but that shaped the outcome nonetheless." }
  ],
  "editorialNote": "Minimum 80 words. A frank, first-person-plural editorial reflection from the thisDay. team. Start with 'What strikes us about this is...' or 'We keep coming back to one thing:' or a similarly direct opening. Say something that the body of the article could not quite say — an honest opinion about what this event reveals about power, human nature, or the gap between how history is remembered and what actually happened. No hedging. No 'it is important to remember'. Say the thing.",
  "wikiUrl": "https://en.wikipedia.org/wiki/Article",
  "youtubeSearchQuery": "specific event name year history documentary"
}`;

  const result = await ai.run(model, {
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

  // Enforce that the title always follows the format "Event Name — Month Day, Year".
  // The AI sometimes omits the date, uses wrong format, or uses colloquial date names.
  const year = parsed.historicalYear ?? date.getFullYear();
  const expectedDateSuffix = `${monthName} ${day}, ${year}`;
  const hasSeparator = parsed.title && parsed.title.includes(" — ");
  // Also rebuild if the event part (before " — ") doesn't exactly match eventTitle —
  // catches cases like "Ides of March Assassination of Julius Caesar — …" where the
  // AI prefixed a colloquial name before the real event name.
  const eventPart = hasSeparator ? parsed.title.split(" — ")[0].trim() : "";
  const eventPartMismatch =
    parsed.eventTitle && eventPart !== parsed.eventTitle.trim();
  if (
    !parsed.title ||
    !parsed.title.includes(monthName) ||
    !hasSeparator ||
    eventPartMismatch
  ) {
    const cleanTitle = (
      parsed.eventTitle ??
      eventPart ??
      parsed.title ??
      "Untitled"
    ).trim();
    parsed.title = `${cleanTitle} — ${expectedDateSuffix}`;
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// SEO meta patcher — updates meta tags in existing KV HTML without regenerating
// ---------------------------------------------------------------------------

/**
 * Extracts current SEO meta values from stored HTML, calls AI to improve only
 * description / ogDescription / twitterDescription / keywords / imageAlt,
 * then does targeted string replacements on the HTML.
 * Returns { updatedHtml, changed: string[], newDescription: string|null }.
 */
async function patchSEOMeta(html, _slug, env) {
  const getMeta = (re) => (html.match(re) || [])[1] || "";

  const currentTitle = getMeta(/<title>([^<]+) \| thisDay\.<\/title>/);
  const currentDesc = getMeta(
    /<meta name="description" content="([^"]*?)"\s*\/>/,
  );
  const currentOgDesc = getMeta(
    /<meta property="og:description" content="([^"]*?)"\s*\/>/,
  );
  const currentTwitterDesc = getMeta(
    /<meta name="twitter:description" content="([^"]*?)"\s*\/>/,
  );
  const currentKeywords = getMeta(
    /<meta name="keywords" content="([^"]*?)"\s*\/>/,
  );
  const currentImageAlt = getMeta(
    /<meta name="twitter:image:alt" content="([^"]*?)"\s*\/>/,
  );

  // Pull event context from first JSON-LD block
  let eventName = "",
    eventDate = "",
    eventLocation = "";
  const jldMatch = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
  );
  if (jldMatch) {
    try {
      const jld = JSON.parse(jldMatch[1]);
      eventName = jld.about?.name || jld.headline || "";
      eventDate = jld.about?.startDate || "";
      eventLocation = jld.about?.location?.name || "";
    } catch {
      /* ignore */
    }
  }

  const minContent = {
    title: currentTitle,
    eventTitle: eventName,
    historicalDate: eventDate,
    location: eventLocation,
    description: currentDesc,
    ogDescription: currentOgDesc,
    twitterDescription: currentTwitterDesc,
    keywords: currentKeywords,
    imageAlt: currentImageAlt,
  };

  const improved = await reviewSEOMetaOnly(minContent, env);

  let updatedHtml = html;
  const changed = [];

  const patch = (oldVal, newVal, pattern, replacement) => {
    if (newVal && newVal !== oldVal) {
      updatedHtml = updatedHtml.replace(pattern, replacement);
      changed.push(pattern.source?.split("content")[0]?.trim() || "field");
    }
  };

  patch(
    currentDesc,
    improved.description,
    /<meta name="description" content="[^"]*?"\s*\/>/,
    `<meta name="description" content="${esc(improved.description)}" />`,
  );

  patch(
    currentOgDesc,
    improved.ogDescription,
    /<meta property="og:description" content="[^"]*?"\s*\/>/,
    `<meta property="og:description" content="${esc(improved.ogDescription)}" />`,
  );

  patch(
    currentTwitterDesc,
    improved.twitterDescription,
    /<meta name="twitter:description" content="[^"]*?"\s*\/>/,
    `<meta name="twitter:description" content="${esc(improved.twitterDescription)}" />`,
  );

  patch(
    currentImageAlt,
    improved.imageAlt,
    /<meta name="twitter:image:alt" content="[^"]*?"\s*\/>/,
    `<meta name="twitter:image:alt" content="${esc(improved.imageAlt)}" />`,
  );

  // keywords + article:tag block
  if (improved.keywords && improved.keywords !== currentKeywords) {
    updatedHtml = updatedHtml.replace(
      /<meta name="keywords" content="[^"]*?"\s*\/>/,
      `<meta name="keywords" content="${esc(improved.keywords)}" />`,
    );
    // Replace all article:tag lines with freshly generated ones
    const newTags = improved.keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
      .slice(0, 6)
      .map((k) => `<meta property="article:tag" content="${esc(k)}" />`)
      .join("\n    ");
    updatedHtml = updatedHtml.replace(
      /(<meta property="article:tag" content="[^"]*?"\s*\/>\n?\s*)+/,
      newTags + "\n    ",
    );
    changed.push("keywords");
  }

  return {
    updatedHtml,
    changed,
    newDescription:
      improved.description !== currentDesc ? improved.description : null,
  };
}

/** Reverse of esc() — decode HTML entities back to plain text. */
function unesc(str) {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Humanizes a single section's paragraphs to beat AI detection.
 * Focused JOB 3 only — one section at a time to stay within token limits.
 * Returns the rewritten array, or the original on any failure.
 */
async function humanizeSection(
  paragraphs,
  sectionName,
  eventTitle,
  env,
  usedOpeners = [],
) {
  if (!paragraphs.length) return paragraphs;

  let systemPrompt =
    "You are a senior writer for serious history documentaries — think BBC, PBS, Ken Burns. " +
    "Your draft is then reviewed by two specialists. Apply all three perspectives before output.\n\n" +
    "LEAD WRITER — BBC/PBS DOCUMENTARY VOICE:\n" +
    "Authoritative narrator. Weighty subject, weighty prose. " +
    "Never open a paragraph with 'On [date],' or '[Place] was...' — start with the person, action, or consequence.\n\n" +
    "REVIEWER 1 — LINGUISTICS PROFESSOR (syntactic humanization):\n" +
    "These techniques make text pass AI detectors at the sentence level. Apply them with restraint — " +
    "overusing any single technique creates gibberish. Vary across sentences.\n" +
    "- RELATIVE CLAUSES: at most 2 per sentence, and each must logically follow the previous. " +
    "'Jinnah read a statement, which became known as the Pakistan Resolution.' — two clauses, coherent. " +
    "Never chain 4+ clauses into a run-on. Each sentence must still make sense on its own.\n" +
    "- SWAP FORMAL VERBS for simpler colloquial ones: 'presented' → 'read', 'advocated' → 'fought for', " +
    "'electrified' → 'moved', 'deemed' → 'considered to be', 'recalled' → 'remembered'\n" +
    "- BREAK NOMINALIZATIONS: 'a carefully crafted document reflecting years of struggle' → " +
    "'a product of years of struggle'\n" +
    "- PARTICIPIAL OPENERS: 'being the leader of' instead of 'as the leader of'\n" +
    "- CLOSE SENTENCES with short participial phrases: '...which surprised no one, considering the circumstances'\n" +
    "- USE 'and' sparingly as a mid-flow connector: 'and this had consequences', 'and they knew it'\n" +
    "- SHIFT TO PRONOUNS once established: 'Jinnah's words' → 'his words'\n" +
    "- ADVERB INTENSIFIERS used lightly: 'quite vehemently', 'rather quickly', 'fairly certain'\n" +
    "- SEMICOLONS in conversational flow: 'And that is exactly what it was; nobody would dispute it'\n" +
    "- NEVER start two paragraphs in the same section with the same subject or the same grammatical pattern\n" +
    "- Remove AI connectors: 'Furthermore', 'Moreover', 'Additionally', 'In conclusion', " +
    "'It is worth noting', 'Notably', 'Importantly', 'Significantly'\n\n" +
    "REVIEWER 2 — COGNITIVE PSYCHOLOGIST (reasoning and voice texture):\n" +
    "- SELF-AFFIRMING VALIDATION: 'And that is exactly what it was' — humans confirm their own points, AI never does\n" +
    "- VAGUE TEMPORAL MARKERS: 'for quite some time', 'over the years', 'for a while' — AI uses precise dates\n" +
    "- EPISTEMIC HEDGES: 'It seemed that', 'It appeared that', 'apparently' — AI states facts directly\n" +
    "- REFLEXIVE PRONOUNS for emphasis: 'Jinnah himself remembered', 'they themselves had little choice'\n" +
    "- VAGUE QUANTIFIERS: 'many to wonder', 'few anticipated', 'almost instantly', 'finally realized'\n" +
    "- Leave some tension unresolved: 'Whether this was miscalculation or strategy is still debated.'\n" +
    "- One measured judgment per section, not per paragraph: 'The British response was, at best, halfhearted.'\n" +
    "- Use each rhetorical device ONCE across the whole section — vary: understatement, question, implication\n" +
    "- Replace hollow phrases with actual consequences: never 'cannot be overstated', 'pivotal moment', " +
    "'shaped the course of', 'left a lasting impact', 'significant event', 'changed history', " +
    "'shows the importance of', 'reminder of', 'throughout history'\n\n" +
    "SHARED RULES:\n" +
    "- Return ONLY a JSON array with exactly the same number of strings as the input\n" +
    "- Preserve every fact. Do not invent, merge, or split paragraphs.\n" +
    "- No casual fillers: 'So,', 'Done.', 'It's crazy, really.', 'Nobody expected that.'";

  // Explicit punctuation guidance: prefer commas over hyphens inside sentences
  systemPrompt +=
    "\n\nPUNCTUATION NOTE: Avoid using hyphens (-) inside sentences; prefer commas or restructure the sentence to maintain flow and clarity.";

  // Append concise essay-writing guidance from Oxford's "Tips from my first year - essay writing".
  // Keep all previous humanization rules intact; add planning/PEE/evidence-first reminders.
  systemPrompt +=
    "\n\nOXFORD ESSAY GUIDANCE (append):\n" +
    "- Before rewriting, sketch a brief plan: claim, evidence, explanation.\n" +
    "- Follow PEE at the paragraph level: state the claim, present one strongest piece of evidence, then explain why it matters.\n" +
    "- Lead paragraphs with the clearest fact when possible (evidence-first).\n" +
    "- Keep introductions and conclusions concise; define any technical term once and briefly.\n" +
    "- When combining or trimming paragraphs, preserve the claim+evidence then the nuance/synthesis.\n" +
    "- When a paragraph contains nuance or complication, give the strongest version of it, not the weakest. Write it naturally into the flow — never signal it with 'critics argue' or 'some would say'. Just state it as fact.\n" +
    "- Each paragraph can work as: position, complication woven in, then synthesis.\n" +
    "- Apply a 'why' test to every statement: if you cannot answer 'why does this matter?', cut or sharpen the sentence.";

  const avoidLine = usedOpeners.length
    ? `\nDo NOT start any paragraph with these already-used openers: ${usedOpeners.map((s) => `"${s}"`).join(", ")}\n`
    : "";

  const userMessage =
    `Event: ${eventTitle}\nSection: ${sectionName}\n${avoidLine}\n` +
    `Rewrite these ${paragraphs.length} paragraphs to beat AI detection:\n` +
    `${JSON.stringify(paragraphs, null, 2)}\n\n` +
    `Return ONLY a JSON array of ${paragraphs.length} strings.`;

  let raw;
  try {
    raw = await callAI(
      env,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      { maxTokens: 2500, timeoutMs: 45_000, temperature: 0.75 },
    );
  } catch (err) {
    console.warn(
      `humanizeSection [${sectionName}]: AI call failed — ${err.message}`,
    );
    return paragraphs;
  }

  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!arrMatch) {
    console.warn(`humanizeSection [${sectionName}]: no JSON array in response`);
    return paragraphs;
  }

  let result;
  try {
    result = JSON.parse(arrMatch[0]);
  } catch {
    console.warn(`humanizeSection [${sectionName}]: JSON parse error`);
    return paragraphs;
  }

  if (!Array.isArray(result) || result.length !== paragraphs.length) {
    console.warn(
      `humanizeSection [${sectionName}]: array length mismatch (got ${result?.length}, expected ${paragraphs.length})`,
    );
    return paragraphs;
  }

  if (!result.every((p) => typeof p === "string" && p.trim().length > 20)) {
    console.warn(
      `humanizeSection [${sectionName}]: invalid paragraph strings in response`,
    );
    return paragraphs;
  }

  return result;
}

/**
 * Extracts body paragraphs from stored HTML, humanizes each section with a focused
 * per-section AI call (JOB 3 — AI detection reduction), then patches the <p> tags
 * back in place. Returns { updatedHtml, changed: string[] }.
 */
async function patchBodyParagraphs(html, env) {
  // Extract eventTitle directly from the Overview h2 — most reliable source
  // (JSON-LD uses c.jsonLdName which may differ from c.eventTitle used in h2 headings)
  let eventTitle = "";
  const overviewH2Match = html.match(/<h2 class="h3">Overview: ([^<]+)<\/h2>/);
  if (overviewH2Match) eventTitle = unesc(overviewH2Match[1]);

  // Fallback: extract from JSON-LD
  if (!eventTitle) {
    const jldMatch = html.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
    );
    if (jldMatch) {
      try {
        const jld = JSON.parse(jldMatch[1]);
        eventTitle = jld.about?.name || jld.headline?.split(" — ")[0] || "";
      } catch {
        /* ignore */
      }
    }
  }

  // Extract <p> text from a named section (by its exact <h2> text)
  const extractSectionParas = (h2Text) => {
    const escaped = h2Text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      '<h2 class="h3">' +
        escaped +
        "<\\/h2>([\\s\\S]*?)(?:<\\/section>|<blockquote)",
    );
    const match = html.match(re);
    if (!match) return [];
    return [...match[1].matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) =>
      unesc(m[1]),
    );
  };

  const sections = [
    { name: "overviewParagraphs", h2: `Overview: ${eventTitle}` },
    {
      name: "eyewitnessOrChronicle",
      h2: `Eyewitness Accounts of ${eventTitle}`,
    },
    { name: "aftermathParagraphs", h2: `Aftermath of ${eventTitle}` },
    { name: "conclusionParagraphs", h2: `Legacy of ${eventTitle}` },
  ].map((s) => ({ ...s, paras: extractSectionParas(s.h2) }));

  if (!sections[0].paras.length) {
    console.warn(
      `patchBodyParagraphs: no overview paragraphs found (eventTitle="${eventTitle}") — skipping`,
    );
    return { updatedHtml: html, changed: [] };
  }

  // Humanize each section sequentially — one focused AI call per section
  // Track first-word openers of each paragraph so later sections don't repeat them
  let updatedHtml = html;
  const changed = [];
  const usedOpeners = [];

  for (const section of sections) {
    if (!section.paras.length) continue;

    const humanized = await humanizeSection(
      section.paras,
      section.name,
      eventTitle,
      env,
      usedOpeners,
    );

    // Collect the first ~6 words of each humanized paragraph as an opener
    for (const p of humanized) {
      const opener = p.split(/\s+/).slice(0, 6).join(" ");
      if (opener) usedOpeners.push(opener);
    }

    const oldBlock = section.paras
      .map((p) => `            <p>${esc(p)}</p>`)
      .join("\n");
    const newBlock = humanized
      .map((p) => `            <p>${esc(p)}</p>`)
      .join("\n");

    if (oldBlock === newBlock) {
      console.log(`patchBodyParagraphs [${section.name}]: unchanged`);
      continue;
    }
    if (!updatedHtml.includes(oldBlock)) {
      console.warn(
        `patchBodyParagraphs [${section.name}]: block not found in HTML — skipping`,
      );
      continue;
    }
    updatedHtml = updatedHtml.replace(oldBlock, newBlock);
    changed.push(section.name);
  }

  console.log(
    `patchBodyParagraphs: ${changed.length} section(s) humanized — ${changed.join(", ") || "none"}`,
  );
  return { updatedHtml, changed };
}

/**
 * Focused SEO-only AI call — improves only the 5 meta fields.
 * No paragraph rewriting. Falls back to original on any error.
 */
async function reviewSEOMetaOnly(content, env) {
  if (!env.AI && !env.GROQ_API_KEY) return content;

  const systemPrompt =
    "You are a senior SEO editor. Improve only these 5 fields for a historical blog post:\n" +
    "- description: 120–155 chars, start with year + event name, include location, specific hook\n" +
    "- ogDescription: 100–130 chars, curiosity-driven, makes people click\n" +
    "- twitterDescription: 90–120 chars, punchy, present-tense energy\n" +
    "- keywords: 5–8 comma-separated, specific — year, location, person names, historical context\n" +
    "- imageAlt: vivid 8–15 word phrase describing what is visible in the image\n\n" +
    "Rules: output ONLY valid JSON with the fields that need improvement. Omit unchanged fields. " +
    "Do not change title, content, or any other field.";

  const userMessage =
    `Title: ${content.title}\n` +
    `Event: ${content.eventTitle} on ${content.historicalDate} in ${content.location || "unknown"}\n` +
    `description: ${content.description}\n` +
    `ogDescription: ${content.ogDescription || ""}\n` +
    `twitterDescription: ${content.twitterDescription || ""}\n` +
    `keywords: ${content.keywords || ""}\n` +
    `imageAlt: ${content.imageAlt || ""}\n\n` +
    `Return ONLY JSON with improved fields, e.g. {"description":"...","keywords":"..."}`;

  let raw;
  try {
    raw = await callAI(
      env,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      { maxTokens: 800, timeoutMs: 25_000 },
    );
  } catch (err) {
    console.warn(
      `SEO meta patcher [${content.title}]: AI call failed — ${err.message}`,
    );
    return content;
  }

  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return content;

  let improvements;
  try {
    improvements = JSON.parse(match[0]);
  } catch {
    return content;
  }

  const ALLOWED = [
    "description",
    "ogDescription",
    "twitterDescription",
    "keywords",
    "imageAlt",
  ];
  const improved = { ...content };
  for (const f of ALLOWED) {
    if (
      typeof improvements[f] === "string" &&
      improvements[f].trim().length > 5
    ) {
      improved[f] = improvements[f];
    }
  }
  return improved;
}

// ---------------------------------------------------------------------------
// SEO expert content review
// ---------------------------------------------------------------------------

/**
 * Reviews and improves generated blog post content for SEO quality before publishing.
 *
 * Checks and fixes:
 *   - Meta description length and keyword richness (120–155 chars)
 *   - OG / Twitter description quality
 *   - imageAlt descriptiveness
 *   - keywords relevance and specificity
 *   - Sentence length across all paragraph arrays (flags if avg > 20 words)
 *   - Content clarity, active voice, and readability signals
 *   - Title format and keyword alignment
 *
 * Returns the improved content object. Falls back to original on any error.
 */
async function reviewContentWithSEOExpert(content, env) {
  if (!env.AI && !env.GROQ_API_KEY) return content;

  // Build full paragraph payload organized by field — sent as JSON so expert knows which belongs where
  const allParagraphs = {
    overviewParagraphs: content.overviewParagraphs || [],
    eyewitnessOrChronicle: content.eyewitnessOrChronicle || [],
    aftermathParagraphs: content.aftermathParagraphs || [],
    conclusionParagraphs: content.conclusionParagraphs || [],
  };

  let systemPrompt =
    "You are a triple expert: a senior SEO editor, a passionate opinionated history writer, AND a human-voice specialist. " +
    "You receive a JSON content object for a historical blog post. Your three jobs are inseparable:\n\n" +
    "JOB 1 — SEO QUALITY:\n" +
    "- description: 120–155 chars, open with the year and event, include location and a specific hook\n" +
    "- ogDescription: 100–130 chars, curiosity-driven — give readers a reason to click, not just a summary\n" +
    "- twitterDescription: 90–120 chars, punchy, present-tense energy\n" +
    "- keywords: 5–8 specific terms — include year, location, key person names, and the historical context\n" +
    "- imageAlt: a vivid 8–15 word description of what is actually visible in the image\n" +
    "- title: must stay in format 'Event Name — Month Day, Year'. Only touch the event name if it is vague or generic.\n\n" +
    "JOB 2 — VOICE AND CONTENT QUALITY:\n" +
    "You are a history obsessive. You find generic, hollow paragraph writing offensive. " +
    "If any paragraph reads like a Wikipedia stub — vague, passive, free of specific facts — rewrite it.\n" +
    "Standards for a paragraph you would rewrite:\n" +
    "- It contains no specific names, numbers, dates, or places (pure generalization)\n" +
    "- It uses banned phrases: 'significant event', 'pivotal moment', 'changed history', 'shaped the course of', " +
    "'left a lasting impact', 'cannot be overstated', 'shows the importance of', 'reminder of'\n" +
    "- It is under 80 words and adds nothing a reader could not guess\n" +
    "- It reads like it was written by someone trying to avoid saying anything specific\n\n" +
    "When you rewrite a paragraph:\n" +
    "- Add the specific fact or detail that the vague phrase was avoiding\n" +
    "- Open with something that makes the reader want to continue — a striking detail, a contradiction, a question\n" +
    "- Mix sentence lengths: some long and layered (25-35 words), some short and punchy (under 10 words)\n" +
    "- Say what you actually think. If something was brutal, say brutal. If something was surprising, say surprising.\n" +
    "- Preserve paragraph count exactly. Do not add or remove paragraphs.\n\n" +
    "JOB 3 — HUMAN VOICE (AI DETECTION SCORE MUST BE BELOW 50%):\n" +
    "AI detectors flag text that is too uniform, too balanced, too clean. Every paragraph must pass as human.\n" +
    "Rewrite ALL paragraphs to beat AI detection — do not skip any, even good-sounding ones.\n\n" +
    "Mandatory humanization techniques — apply ALL of these across the full set of paragraphs:\n" +
    "1. CONTRACTIONS: use them naturally — 'didn't', 'wasn't', 'couldn't', 'it's', 'that's', 'they'd'\n" +
    "2. SENTENCE FRAGMENTS for emphasis. One word. Two words. Done.\n" +
    "3. START sentences with 'And', 'But', 'So', or 'Because' where natural — AI avoids this\n" +
    "4. RHETORICAL QUESTIONS mid-paragraph: 'What were they thinking?' 'Did it work? Barely.'\n" +
    "5. SECOND PERSON sparingly: 'You have to understand the pressure he was under.' 'Picture the scene.'\n" +
    "6. BREAK PARALLEL STRUCTURE: AI loves 'X did A, Y did B, Z did C' — destroy that pattern\n" +
    "7. SENTENCE LENGTH CHAOS: mix 3-word sentences with 40-word sentences back to back\n" +
    "8. AVOID consecutive sentences with the same grammatical opener (never 'The X... The Y... The Z...')\n" +
    "9. DELETE these AI-signature connectors: 'Furthermore', 'Moreover', 'Additionally', 'In conclusion', " +
    "'It is worth noting', 'It should be noted', 'Notably', 'Importantly', 'Significantly'\n" +
    "10. ADD personality asides: 'Which, frankly, was insane.' 'Nobody expected that.' 'It almost worked.'\n\n" +
    "Rules:\n" +
    "- Keep all JSON field names exactly as given\n" +
    "- Do not change: historicalDate, historicalYear, historicalDateISO, location, country, quickFacts, " +
    "didYouKnowFacts, analysisGood, analysisBad, editorialNote, wikiUrl, youtubeSearchQuery\n" +
    "- Output ONLY valid JSON with the fields that need improvement. Omit fields that are already good.";
  // Enforce punctuation guidance at the SEO/voice level as well
  systemPrompt +=
    "\n\nPUNCTUATION NOTE: Do not use hyphens (-) inside sentences. Use commas, semicolons, or restructure clauses instead to preserve readability and compliance with editorial style.";
  // Add Oxford essay-writing notes so the SEO expert also enforces PEE and evidence-first
  // while keeping existing SEO and voice rules.
  systemPrompt +=
    "\n\nOXFORD ESSAY GUIDANCE (append):\n" +
    "- Encourage an editorial plan: for each section, name the core claim and the one fact that proves it.\n" +
    "- Paragraph standard: claim + strongest evidence + brief explanation (PEE).\n" +
    "- Favor leading with evidence in body paragraphs; keep intro/conclusion short and pointed.\n" +
    "- Avoid jargon; when a technical term is necessary, provide a one-line definition.\n" +
    "- When nuance or complication enters a paragraph, give the strongest version of it. Write it naturally into the narrative flow — never signal it with 'critics argue', 'some would say', or 'the opposing view is'. Just state it directly.\n" +
    "- Each body paragraph can work as: position, complication woven in, then synthesis.\n" +
    "- Apply a 'why' test: every factual claim must answer 'why does this matter to the reader?' — if it cannot, cut or sharpen it.\n";

  const userMessage =
    `Blog post to review:\n` +
    `Title: ${content.title}\n` +
    `Event: ${content.eventTitle} on ${content.historicalDate} in ${content.location || "unknown"}\n` +
    `description: ${content.description}\n` +
    `ogDescription: ${content.ogDescription || ""}\n` +
    `twitterDescription: ${content.twitterDescription || ""}\n` +
    `keywords: ${content.keywords || ""}\n` +
    `imageAlt: ${content.imageAlt || ""}\n\n` +
    `ALL paragraphs — apply JOB 2 + JOB 3 to every paragraph array:\n` +
    `${JSON.stringify(allParagraphs, null, 2)}\n\n` +
    `TARGET: AI detection score below 50%. Rewrite every paragraph to sound unmistakably human.\n` +
    `Return ONLY a JSON object with the fields that need improvement:\n` +
    `{"description":"improved...","keywords":"improved...","overviewParagraphs":["para1","para2","para3","para4"]}`;

  let raw;
  try {
    raw = await callAI(
      env,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      { maxTokens: 6000, timeoutMs: 50_000 },
    );
  } catch (err) {
    console.warn(
      `SEO expert: AI call failed (${err.message}) — using original content`,
    );
    return content;
  }

  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    console.warn("SEO expert: no JSON in response — using original content");
    return content;
  }

  let improvements;
  try {
    improvements = JSON.parse(match[0]);
  } catch {
    console.warn("SEO expert: JSON parse error — using original content");
    return content;
  }

  // Whitelist of fields the SEO expert is allowed to improve
  const ALLOWED_FIELDS = [
    "title",
    "description",
    "ogDescription",
    "twitterDescription",
    "keywords",
    "imageAlt",
    "overviewParagraphs",
    "eyewitnessOrChronicle",
    "aftermathParagraphs",
    "conclusionParagraphs",
  ];

  let changed = 0;
  const improved = { ...content };
  for (const field of ALLOWED_FIELDS) {
    if (improvements[field] == null) continue;
    // Validate paragraph arrays: must stay the same length
    if (Array.isArray(improved[field])) {
      if (!Array.isArray(improvements[field])) continue;
      if (improvements[field].length !== improved[field].length) continue;
      if (
        !improvements[field].every(
          (p) => typeof p === "string" && p.trim().length > 20,
        )
      )
        continue;
    } else {
      if (
        typeof improvements[field] !== "string" ||
        improvements[field].trim().length < 5
      )
        continue;
    }
    improved[field] = improvements[field];
    changed++;
  }

  // Guard: if the expert changed the title, make sure format is still correct
  if (improved.title !== content.title) {
    if (
      !improved.title.includes(" — ") ||
      !improved.title.includes(
        content.historicalDate?.split(",")[1]?.trim() ?? "",
      )
    ) {
      improved.title = content.title; // revert bad title
    }
  }

  console.log(`SEO expert: reviewed content — ${changed} field(s) improved`);
  return improved;
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
        `              <tr><th>${esc(f.label)}</th><td>${esc(f.value)}</td></tr>`,
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
    <meta name="author" content="thisDay. Editorial" />
    <meta name="description" content="${esc(c.description)}" />
    <meta name="keywords" content="${esc(c.keywords)}" />

    <!-- Open Graph -->
    <meta property="og:title" content="${esc(c.title)}" />
    <meta property="og:description" content="${esc(c.ogDescription || c.description)}" />
    <meta property="og:type" content="article" />
    <meta property="og:url" content="${canonicalUrl}" />
    <meta property="og:image" content="${esc(c.imageUrl)}" />
    <meta property="og:image:alt" content="${esc(c.title)}" />
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
    <link rel="apple-touch-icon" href="/images/apple-touch-icon.png" />
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
      button#chatbotToggle,#chatbotWindow{display:none!important}
      .site-btn{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border:1.5px solid var(--card-border,#e2e8f0);border-radius:8px;font-size:.875rem;font-weight:500;text-decoration:none;color:var(--text-color);background:transparent;cursor:pointer;transition:background .15s,border-color .15s,color .15s;user-select:none}
      .site-btn:hover{border-color:#3b82f6;background:rgba(59,130,246,.07)}
      .site-btn-primary{border-color:#3b82f6;color:#2563eb}
      .site-btn-primary:hover{background:rgba(59,130,246,.12);border-color:#2563eb;color:#1d4ed8}
      body.dark-theme .site-btn-primary{border-color:#60a5fa;color:#93c5fd}
      body.dark-theme .site-btn-primary:hover{background:rgba(96,165,250,.15);border-color:#93c5fd;color:#e0f2fe}
      .site-table{width:100%;max-width:480px;border-collapse:collapse;border:1.5px solid var(--card-border,#e2e8f0);border-radius:10px;overflow:hidden;margin-top:1rem;margin-bottom:1.5rem;font-size:.9rem}
      .site-table th,.site-table td{padding:8px 14px;border-bottom:1px solid var(--card-border,#e2e8f0);text-align:left;color:var(--text-color)}
      .site-table tr:last-child th,.site-table tr:last-child td{border-bottom:none}
      .site-table th{background:rgba(59,130,246,.07);font-weight:600;white-space:nowrap;width:40%}
      body.dark-theme .site-table{border-color:rgba(255,255,255,.15)}
      body.dark-theme .site-table th{background:rgba(96,165,250,.1)}
      body.dark-theme .site-table th,body.dark-theme .site-table td{border-bottom-color:rgba(255,255,255,.08)}
      .tdq-cta-sub{color:#6c757d}
      body.dark-theme .tdq-cta-sub{color:#fff}
    </style>
  </head>
  <body>

  <div id="read-progress" role="progressbar" aria-label="Reading progress" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"></div>
  ${siteNav()}

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
          ${
            quickFactsRows
              ? `<h2 class="mt-4 h3">Quick Facts</h2>
          <table class="site-table">
            <tbody>
${quickFactsRows}
            </tbody>
          </table>`
              : ""
          }

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
          ${
            overviewParas
              ? `<section class="mt-4">
            <h2 class="h3">Overview: ${esc(c.eventTitle)}</h2>
${overviewParas}
          </section>`
              : ""
          }

          <!-- Eyewitness / Chronicle Accounts -->
          ${
            eyewitnessParas
              ? `<div class="ad-unit-container my-4"><span class="ad-unit-label">Advertisement</span><ins class="adsbygoogle" data-ad-client="ca-pub-8565025017387209" data-ad-slot="9477779891" data-ad-format="auto" data-full-width-responsive="true"></ins></div>
          <section class="mt-5">
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
          ${
            conclusionParas
              ? `<div class="ad-unit-container my-4"><span class="ad-unit-label">Advertisement</span><ins class="adsbygoogle" data-ad-client="ca-pub-8565025017387209" data-ad-slot="9477779891" data-ad-format="auto" data-full-width-responsive="true"></ins></div>
          <section class="mt-5">
            <h2 class="h3">Legacy of ${esc(c.eventTitle)}</h2>
${conclusionParas}
          </section>`
              : ""
          }

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
            let hMonthSlug, hDay, hMonthDisplay;
            if (!isNaN(hd.getTime())) {
              hMonthSlug = MONTH_SLUGS[hd.getUTCMonth()];
              hDay = hd.getUTCDate();
              hMonthDisplay = MONTH_NAMES[hd.getUTCMonth()];
            } else {
              // BCE or unparseable date — fall back to publication slug (e.g. "15-march-2026")
              const sp = parseSlugDate(slug);
              if (!sp) return "";
              hDay = sp.day;
              hMonthSlug = sp.monthSlug;
              hMonthDisplay = sp.monthDisplay;
            }
            const exploreThumb =
              c.eventsImageUrl || c.imageUrl
                ? `<img src="/image-proxy?src=${encodeURIComponent(c.eventsImageUrl || c.imageUrl)}&w=80&q=75" alt="${esc(c.eventTitle)} historical image" width="64" height="64" style="width:64px;height:64px;min-width:64px;object-fit:cover;border-radius:8px;flex-shrink:0;display:block" loading="lazy"/>`
                : "";
            return `<div data-explore-injected="1" class="mt-4 p-3 rounded" style="display:flex;flex-direction:row;flex-wrap:nowrap;align-items:flex-start;gap:12px;background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.18)">
              ${exploreThumb}
              <div style="flex:1;min-width:0">
                <strong>Explore ${esc(hMonthDisplay)} ${hDay} in History</strong><br/>
                <small class="article-meta">See all events, births, and deaths recorded on this date.</small><br/>
                <a href="/events/${esc(hMonthSlug)}/${hDay}/" class="btn btn-sm btn-outline-primary mt-2">View ${esc(hMonthDisplay)} ${hDay}</a>
              </div>
            </div>`;
          })()}

          ${(() => {
            const related = allPosts.filter((p) => p.slug !== slug).slice(0, 3); // already sorted newest-first; today's post is always shown first
            if (related.length === 0) return "";
            const cards = related
              .map((p) => {
                const thumb = p.imageUrl
                  ? `<img src="/image-proxy?src=${encodeURIComponent(p.imageUrl)}&w=80&q=75" alt="${esc(p.title)}" width="56" height="56" style="width:56px;height:56px;object-fit:cover;border-radius:8px;flex-shrink:0" loading="lazy"/>`
                  : `<div style="width:56px;height:56px;border-radius:8px;flex-shrink:0;background:var(--card-border,#e2e8f0);display:flex;align-items:center;justify-content:center"><i class="bi bi-clock-history" style="color:#94a3b8;font-size:1.2rem"></i></div>`;
                return `
              <div class="col-12 col-md-4">
                <a href="/blog/${esc(p.slug)}/" class="related-card d-flex align-items-center gap-2 p-3 rounded text-decoration-none h-100">
                  ${thumb}
                  <div style="min-width:0">
                    <p class="mb-0 fw-semibold" style="color:var(--text-color);font-size:.88rem;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${esc(p.title)}</p>
                    <small class="article-meta">${new Date(p.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</small>
                  </div>
                </a>
              </div>`;
              })
              .join("");
            return `<!-- Quiz CTA -->
          <div class="mt-4 p-3 rounded d-flex align-items-center gap-3" style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25)">
            <i class="bi bi-patch-question-fill" style="font-size:1.5rem;color:#f59e0b;flex-shrink:0"></i>
            <div>
              <strong style="color:var(--text-color)">Test Your Knowledge</strong><br/>
              <small class="tdq-cta-sub">Can you answer 5 questions about this event?</small><br/>
              <button class="btn btn-warning fw-semibold w-100 mt-2" id="tdq-cta-btn" onclick="document.getElementById('tdq-overlay').style.display='block';document.getElementById('tdq-popup').style.display='block';requestAnimationFrame(function(){document.getElementById('tdq-popup').classList.add('tdq-popup-open');});document.body.style.overflow='hidden';if(typeof maybeLoadAndShowQuiz==='function')maybeLoadAndShowQuiz();">
                Take the Quiz
              </button>
            </div>
          </div>
          <section class="mt-5">
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

        <div class="ad-unit-container">
          <span class="ad-unit-label">Advertisement</span>
          <ins class="adsbygoogle"
               data-ad-client="ca-pub-8565025017387209"
               data-ad-slot="9477779891"
               data-ad-format="auto"
               data-full-width-responsive="true"></ins>
        </div>
      </div>
    </div>
  </main>


  ${siteFooter()}

  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
  <script src="/js/script.js"></script>
  <script>
    document.addEventListener("DOMContentLoaded", () => {
      ${footerYearScript()}
      const tsd = document.getElementById("tsd");
      const tsm = document.getElementById("tsm");
      const body = document.body;
      const DARK_THEME_KEY = "darkTheme";

      const setTheme = (isDark) => {
        isDark ? body.classList.add("dark-theme") : body.classList.remove("dark-theme");
        localStorage.setItem(DARK_THEME_KEY, String(isDark));
        if (tsd) tsd.checked = isDark;
        if (tsm) tsm.checked  = isDark;
      };

      const savedTheme = localStorage.getItem(DARK_THEME_KEY);
      setTheme(savedTheme !== "false"); // default: dark

      if (tsd) tsd.addEventListener("change", (e) => setTheme(e.target.checked));
      if (tsm) tsm.addEventListener("change",  (e) => setTheme(e.target.checked));
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
  <div id="tdq-popup" role="dialog" aria-modal="true" aria-label="History Quiz" style="display:none;position:fixed;bottom:0;left:0;right:0;z-index:9999;max-height:90dvh;overflow-y:auto;background:var(--card-bg,#fff);border-radius:16px 16px 0 0;padding:0 0 32px;box-shadow:0 -4px 32px rgba(0,0,0,.18);font-family:Inter,sans-serif">
    <div id="tdq-header" style="position:sticky;top:0;z-index:1;background:var(--card-bg,#fff);border-radius:16px 16px 0 0;border-bottom:1px solid var(--card-border,#e2e8f0);padding:12px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px">
      <div id="tdq-topic" style="font-size:.72rem;font-weight:700;color:#f59e0b;text-transform:uppercase;letter-spacing:.06em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>
      <button id="tdq-close" aria-label="Close quiz" style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:var(--text-color,#6c757d);line-height:1;flex-shrink:0">&times;</button>
    </div>
    <div style="padding:16px 20px 0">
      <h3 style="font-size:1.1rem;font-weight:700;margin-bottom:3px;color:var(--text-color,#1e293b)"><i class="bi bi-patch-question-fill me-2" style="color:#f59e0b"></i>Test Your Knowledge</h3>
      <p style="font-size:.85rem;color:var(--text-color,#6c757d);margin-bottom:6px;opacity:.8">Based on the article you just read — 5 questions, under a minute.</p>
      <div id="tdq-progress" style="font-size:.78rem;font-weight:600;color:#f59e0b;margin-bottom:16px">0 of 5 answered</div>
      <div id="tdq-questions"></div>
      <button class="btn btn-warning mt-3" id="tdq-submit-btn" style="display:none"><i class="bi bi-check2-circle me-1"></i>Check Answers</button>
      <div id="tdq-score" class="mt-3" hidden></div>
    </div>
  </div>

  <div id="tdq-sentinel" style="height:1px"></div>

  <!-- Floating quiz bar — slides up when user reaches Eyewitness section -->
  <style>
    #tdq-float-bar{position:fixed;bottom:0;left:0;right:0;z-index:1020;background:rgba(15,23,42,.96);backdrop-filter:blur(4px);box-shadow:0 -2px 16px rgba(0,0,0,.3);transform:translateY(100%);transition:transform .35s cubic-bezier(.22,.61,.36,1);padding:10px 16px;padding-bottom:max(10px,env(safe-area-inset-bottom));display:flex;align-items:center;justify-content:center}
    #tdq-float-bar.tdq-float-visible{transform:translateY(0)}
    #tdq-float-btn{background:linear-gradient(90deg,#f59e0b,#d97706);border:none;border-radius:100px;color:#fff;font-weight:700;font-size:.95rem;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;padding:11px 28px;box-shadow:0 2px 12px rgba(245,158,11,.35);max-width:320px;width:100%}
    #tdq-float-btn:hover{background:linear-gradient(90deg,#d97706,#b45309);box-shadow:0 2px 16px rgba(245,158,11,.5)}
  </style>
  <div id="tdq-float-bar">
    <button id="tdq-float-btn">
      <i class="bi bi-patch-question-fill"></i> Quiz This Day
    </button>
  </div>
  <script>
  (function(){
    var bar=document.getElementById('tdq-float-bar');
    var btn=document.getElementById('tdq-float-btn');
    var closeBtn=document.getElementById('tdq-close');
    if(!bar||!btn)return;
    function showBar(){bar.classList.add('tdq-float-visible');}
    function hideBar(){bar.classList.remove('tdq-float-visible');}
    btn.addEventListener('click',function(){
      hideBar();
      var overlay=document.getElementById('tdq-overlay');
      var popup=document.getElementById('tdq-popup');
      if(overlay)overlay.style.display='block';
      if(popup){popup.style.display='block';requestAnimationFrame(function(){popup.classList.add('tdq-popup-open');});}
      document.body.style.overflow='hidden';
      if(typeof maybeLoadAndShowQuiz==='function')maybeLoadAndShowQuiz();
    });
    if(closeBtn)closeBtn.addEventListener('click',function(){setTimeout(showBar,300);});
    // Trigger: show/hide bar based on Eyewitness heading scroll position
    var h2s=document.querySelectorAll('h2');
    var trigger=null;
    for(var i=0;i<h2s.length;i++){if(h2s[i].textContent.indexOf('Eyewitness')!==-1){trigger=h2s[i];break;}}
    if(trigger){
      function updateBar(){var rect=trigger.getBoundingClientRect();if(rect.top<window.innerHeight){showBar();}else{hideBar();}}
      window.addEventListener('scroll',updateBar,{passive:true});
    } else {
      document.addEventListener('scroll',function onScroll(){
        var d=document.documentElement;
        var total=d.scrollHeight-d.clientHeight;
        if(total>0&&d.scrollTop/total>0.35){showBar();document.removeEventListener('scroll',onScroll);}
      },{passive:true});
    }
  })();
  </script>

  <style>
    .tdq-question{margin-bottom:16px;display:none}.tdq-question.tdq-q-active{display:block}
    @keyframes tdq-slide-in{from{opacity:0;transform:translateX(28px)}to{opacity:1;transform:translateX(0)}}
    .tdq-q-enter{animation:tdq-slide-in .22s ease forwards}
    @keyframes tdq-pulse-in{0%{background:rgba(59,130,246,.13)}60%{background:rgba(59,130,246,.06)}100%{background:transparent}}
    .tdq-q-pulse{animation:tdq-pulse-in .6s ease forwards}
    @media(prefers-reduced-motion:reduce){.tdq-q-pulse,.tdq-q-enter{animation:none;transition:none}}
    .tdq-q-text{font-weight:600;margin-bottom:8px;font-size:.9rem;color:var(--text-color,#1e293b)}.tdq-options{display:flex;flex-direction:column;gap:7px}
    .tdq-opt{display:flex;align-items:center;gap:9px;padding:8px 12px;border:1.5px solid var(--card-border,#e2e8f0);border-radius:8px;cursor:pointer;font-size:.88rem;transition:background .15s,border-color .15s;user-select:none;color:var(--text-color,#1e293b)}
    .tdq-opt:hover{border-color:#f59e0b;background:rgba(245,158,11,.07)}.tdq-opt-selected{border-color:#f59e0b!important;background:rgba(245,158,11,.12)!important;font-weight:500}
    .tdq-opt-correct{border-color:#10b981!important;background:#d1fae5!important;color:#0f172a!important}.tdq-opt-wrong{border-color:#ef4444!important;background:#fee2e2!important;color:#0f172a!important}
    .tdq-opt-key{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#e2e8f0;font-size:.72rem;font-weight:700;flex-shrink:0}
    .tdq-opt-selected .tdq-opt-key{background:#f59e0b;color:#fff}.tdq-opt-correct .tdq-opt-key{background:#10b981;color:#fff}.tdq-opt-wrong .tdq-opt-key{background:#ef4444;color:#fff}
    body.dark-theme .tdq-opt{border-color:rgba(255,255,255,.15);color:#f8fafc}body.dark-theme .tdq-opt:hover{border-color:#f59e0b;background:rgba(245,158,11,.08)}
    body.dark-theme .tdq-opt-selected{border-color:#f59e0b!important;background:rgba(245,158,11,.15)!important}body.dark-theme .tdq-opt-key{background:#334155;color:#cbd5e1}
    body.dark-theme .tdq-opt-correct{background:rgba(16,185,129,.2)!important;border-color:#10b981!important;color:#e2e8f0!important}body.dark-theme .tdq-opt-wrong{background:rgba(239,68,68,.2)!important;border-color:#ef4444!important;color:#e2e8f0!important}
    .tdq-feedback{font-size:.82rem;margin-top:4px}.tdq-correct{color:#10b981;font-weight:600}.tdq-wrong{color:#ef4444;font-weight:600}
    .tdq-next-btn{width:100%;margin-top:14px;padding:11px;border:none;border-radius:8px;background:#f59e0b;color:#fff;font-weight:700;font-size:.95rem;cursor:pointer;display:none;transition:background .15s}
    .tdq-next-btn:hover{background:#d97706}
    .tdq-score-box{font-size:1rem;font-weight:600;padding:12px 14px;background:rgba(245,158,11,.1);border-radius:8px;border-left:4px solid #f59e0b}.tdq-score-num{color:#f59e0b;font-size:1.15rem}
    #tdq-popup{transition:transform .3s ease;transform:translateY(100%);scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.2) transparent}.tdq-popup-open{transform:translateY(0)!important}
    #tdq-popup::-webkit-scrollbar{width:4px}#tdq-popup::-webkit-scrollbar-thumb{background:rgba(0,0,0,.2);border-radius:4px}
    body.dark-theme #tdq-popup{scrollbar-color:rgba(255,255,255,.15) transparent}body.dark-theme #tdq-popup::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15)}
    body.dark-theme #tdq-header{background:var(--card-bg,#1e293b);border-bottom-color:rgba(255,255,255,.1)}
  </style>

  <script>
  (function () {
    var slug = "${esc(slug)}";
    var quizLoaded = false;
    var selected = {};
    var answers = [];

    function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

    function openPopup() {
      var popup = document.getElementById("tdq-popup");
      document.getElementById("tdq-overlay").style.display = "block";
      popup.scrollTop = 0;
      popup.style.display = "block";
      requestAnimationFrame(function() { popup.classList.add("tdq-popup-open"); });
      document.body.style.overflow = "hidden";
      // After slide-up animation: ensure scroll at top and pulse active question for attention
      setTimeout(function() {
        popup.scrollTop = 0;
        var activeQ = popup.querySelector(".tdq-q-active") || popup.querySelector(".tdq-question");
        if (activeQ) { activeQ.classList.add("tdq-q-pulse"); setTimeout(function(){ activeQ.classList.remove("tdq-q-pulse"); }, 650); }
      }, 380);
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

    var currentQ = 0;

    function showQuestion(qi, animate) {
      var popup = document.getElementById("tdq-popup");
      var container = document.getElementById("tdq-questions");
      container.querySelectorAll(".tdq-question").forEach(function(el) { el.classList.remove("tdq-q-active", "tdq-q-enter"); });
      var qEl = document.getElementById("tdq-q-" + qi);
      if (!qEl) return;
      qEl.classList.add("tdq-q-active");
      if (animate) { void qEl.offsetWidth; qEl.classList.add("tdq-q-enter"); }
      if (popup) { setTimeout(function(){ popup.scrollTop = 0; }, 30); }
    }

    function prevDayUrl() {
      var m = slug.match(/^(\d+)-([a-z]+)-(\d+)$/i);
      if (!m) return "/blog/";
      var months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
      var idx = months.indexOf(m[2].toLowerCase());
      if (idx < 0) return "/blog/";
      var d = new Date(parseInt(m[3]), idx, parseInt(m[1]));
      d.setDate(d.getDate() - 1);
      return "/blog/" + d.getDate() + "-" + months[d.getMonth()] + "-" + d.getFullYear() + "/";
    }

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
        var isLast = qi === total - 1;
        var nextLabel = isLast ? '<i class="bi bi-check2-circle me-1"></i>See Results' : 'Next Question <i class="bi bi-arrow-right ms-1"></i>';
        var expHtml = q.explanation
          ? '<div class="tdq-explanation" id="tdq-e-' + qi + '" hidden style="font-size:.82rem;margin-top:6px;padding:7px 11px;background:rgba(59,130,246,.07);border-left:3px solid #3b82f6;border-radius:0 6px 6px 0">' + esc(String(q.explanation)) + '</div>'
          : '';
        return '<div class="tdq-question" id="tdq-q-' + qi + '">' +
          '<p class="tdq-q-text"><strong>' + (qi + 1) + ' / ' + total + '.</strong> ' + esc(String(q.q)) + '</p>' +
          '<div class="tdq-options">' + optsHtml + '</div>' +
          '<div class="tdq-feedback" id="tdq-f-' + qi + '" hidden></div>' +
          expHtml +
          '<button class="tdq-next-btn" id="tdq-next-' + qi + '">' + nextLabel + '</button>' +
          '</div>';
      }).join("");

      // Show first question
      currentQ = 0;
      showQuestion(0, false);
      var progEl = document.getElementById("tdq-progress");
      if (progEl) progEl.textContent = "1 of " + total;

      container.querySelectorAll(".tdq-opt").forEach(function(opt) {
        opt.addEventListener("click", function() {
          var qi = parseInt(this.dataset.qi), oi = parseInt(this.dataset.oi);
          if (qi !== currentQ) return; // only active question
          selected[qi] = oi;
          container.querySelectorAll('[data-qi="' + qi + '"]').forEach(function(o) { o.classList.remove("tdq-opt-selected"); });
          this.classList.add("tdq-opt-selected");
          // Show next button and scroll to it
          var nextBtn = document.getElementById("tdq-next-" + qi);
          if (nextBtn) {
            nextBtn.style.display = "block";
            var popup = document.getElementById("tdq-popup");
            setTimeout(function() {
              if (nextBtn) {
                nextBtn.scrollIntoView({ behavior: "smooth", block: "nearest" });
              }
            }, 160);
          }
        });
      });

      // Next button handlers
      for (var qi = 0; qi < total; qi++) {
        (function(qi) {
          var nextBtn = document.getElementById("tdq-next-" + qi);
          if (!nextBtn) return;
          nextBtn.addEventListener("click", function() {
            var isLast = qi === total - 1;
            if (isLast) {
              showResults(total);
            } else {
              currentQ = qi + 1;
              var progEl = document.getElementById("tdq-progress");
              if (progEl) progEl.textContent = (currentQ + 1) + " of " + total;
              showQuestion(currentQ, true);
            }
          });
        })(qi);
      }
    }

    function showResults(total) {
      var score = 0;
      answers.forEach(function(correct, qi) {
        var chosen = selected[qi] !== undefined ? selected[qi] : -1;
        var fb = document.getElementById("tdq-f-" + qi);
        var opts = document.querySelectorAll('[data-qi="' + qi + '"]');
        if (fb) fb.hidden = false;
        opts.forEach(function(o) { o.style.pointerEvents = "none"; });
        if (opts[correct]) opts[correct].classList.add("tdq-opt-correct");
        if (chosen === correct) {
          score++;
          if (fb) fb.innerHTML = '<span class="tdq-correct">✓ Correct!</span>';
        } else {
          if (chosen >= 0 && opts[chosen]) opts[chosen].classList.add("tdq-opt-wrong");
          if (fb) fb.innerHTML = '<span class="tdq-wrong">✗ Incorrect.</span> Correct: <strong>' + String.fromCharCode(65 + correct) + '</strong>';
        }
        var exp = document.getElementById("tdq-e-" + qi);
        if (exp) exp.hidden = false;
        // Show all questions for results view
        var qEl = document.getElementById("tdq-q-" + qi);
        if (qEl) { qEl.classList.add("tdq-q-active"); var nb = document.getElementById("tdq-next-" + qi); if (nb) nb.style.display = "none"; }
      });
      document.getElementById("tdq-submit-btn").style.display = "none";
      var pct = Math.round(score / total * 100);
      var msg = pct === 100 ? "Perfect score!" : pct >= 80 ? "Excellent!" : pct >= 60 ? "Good job!" : "Keep learning!";
      var el = document.getElementById("tdq-score");
      el.hidden = false;
      el.innerHTML = '<div class="tdq-score-box">You scored <span class="tdq-score-num">' + score + "/" + total + '</span> (' + pct + '%) — ' + msg + '</div>' +
        '<a href="' + prevDayUrl() + '" class="btn btn-outline-primary w-100 mt-3"><i class="bi bi-arrow-left me-1"></i>Previous Day&#39;s Story</a>';
      var popup = document.getElementById("tdq-popup");
      if (popup) { setTimeout(function(){ popup.scrollTop = 0; }, 30); }
      var progEl = document.getElementById("tdq-progress");
      if (progEl) progEl.textContent = "Results — " + score + "/" + total + " correct";
    }

    document.getElementById("tdq-submit-btn").addEventListener("click", function() { showResults(answers.length); });

    function maybeLoadAndShow() {
      if (quizLoaded) return;
      quizLoaded = true;
      if (window.__tdqQuiz) { var q = window.__tdqQuiz; window.__tdqQuiz = null; renderQuiz(q); openPopup(); return; }
      fetch("/blog/quiz/" + slug)
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(quiz) {
          if (!quiz || !quiz.questions || quiz.questions.length < 3) return;
          renderQuiz(quiz);
          openPopup();
        })
        .catch(function() { /* quiz unavailable, silently skip */ });
    }
    // Expose so the CTA button / floating bar can trigger it; re-opens if already loaded
    window.maybeLoadAndShowQuiz = function(){if(quizLoaded){openPopup();}else{maybeLoadAndShow();}};

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
  <script>
  (function(){
    if(location.hostname!=='thisday.info'&&location.hostname!=='www.thisday.info')return;
    var units=document.querySelectorAll('ins.adsbygoogle');
    if(!units.length)return;
    function pushIns(ins){if(ins.getAttribute('data-adsbygoogle-status')||ins.getAttribute('data-ad-pushed'))return;ins.setAttribute('data-ad-pushed','1');try{(adsbygoogle=window.adsbygoogle||[]).push({});}catch(e){}}
    if('IntersectionObserver' in window){
      var io=new IntersectionObserver(function(entries,obs){entries.forEach(function(e){if(e.isIntersecting){pushIns(e.target);obs.unobserve(e.target);}});},{threshold:0.1});
      units.forEach(function(ins){io.observe(ins);});
    } else { units.forEach(pushIns); }
  })();
  </script>
${supportPopupSnippet()}
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
    <meta name="author" content="thisDay. Editorial" />
    <meta name="description" content="Original articles about historical events published regularly by thisDay.info." />
    <meta property="og:title" content="History Blog | thisDay." />
    <meta property="og:description" content="In-depth articles about the events, people, and moments that shaped world history." />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="https://thisday.info/blog/archive/" />
    <meta property="og:image" content="https://thisday.info/images/logo.png" />
    <meta property="og:locale" content="en_US" />
    <meta property="og:site_name" content="thisDay." />
    <meta name="twitter:card" content="summary_large_image"/>
    <meta name="twitter:title" content="History Blog | thisDay."/>
    <meta name="twitter:description" content="In-depth articles covering historical events published regularly by thisDay.info."/>
    <meta name="twitter:image" content="https://thisday.info/images/logo.png"/>

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
    <link rel="apple-touch-icon" href="/images/apple-touch-icon.png" />
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
    <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8565025017387209" crossorigin="anonymous"></script>
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
      .ad-unit { text-align: center; }
      .ad-unit-label { font-size: 0.7rem; color: #adb5bd; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
    </style>
  </head>
  <body>

  ${siteNav()}

  <main class="container">
    <div class="row justify-content-center">
      <div class="col-lg-9 col-xl-7">
        <h1 class="fw-bold mb-1" style="font-size:1.8rem">History Blog</h1>
        <p class="mb-4" style="color: var(--text-color); opacity: 0.8">
          In-depth articles covering fascinating historical events published regularly by thisDay.info.
          <a href="/blog/">View all posts</a>
        </p>
        <div class="ad-unit-container">
          <span class="ad-unit-label">Advertisement</span>
          <ins class="adsbygoogle"
               data-ad-client="ca-pub-8565025017387209"
               data-ad-slot="9477779891"
               data-ad-format="auto"
               data-full-width-responsive="true"></ins>
        </div>
        <div class="month-section">
          <h2 class="month-header"><i class="bi bi-book me-2"></i>All Articles (${index.length})</h2>
          ${postItems}
        </div>
      </div>
    </div>
  </main>

  ${siteFooter()}

  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
  <script>
    document.addEventListener("DOMContentLoaded", () => {
      ${footerYearScript()}
      const tsd = document.getElementById("tsd");
      const tsm = document.getElementById("tsm");
      const body = document.body;
      const setTheme = (d) => {
        d ? body.classList.add("dark-theme") : body.classList.remove("dark-theme");
        localStorage.setItem("darkTheme", String(d));
        if (tsd) tsd.checked = d; if (tsm) tsm.checked = d;
      };
      setTheme(localStorage.getItem("darkTheme") !== "false");
      if (tsd) tsd.addEventListener("change", (e) => setTheme(e.target.checked));
      if (tsm) tsm.addEventListener("change",  (e) => setTheme(e.target.checked));
    });
    if (location.hostname === 'thisday.info' || location.hostname === 'www.thisday.info') {
      document.querySelectorAll('ins.adsbygoogle').forEach((ins) => {
        if (!ins.getAttribute('data-adsbygoogle-status') && !ins.getAttribute('data-ad-pushed')) {
          ins.setAttribute('data-ad-pushed', '1');
          try { (adsbygoogle = window.adsbygoogle || []).push({}); } catch {}
        }
      });
    }
  </script>
${supportPopupSnippet()}
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

/**
 * Inverse of buildSlug — parses "15-march-2026" into its components.
 * Returns null if the slug doesn't match the expected format.
 */
function parseSlugDate(slug) {
  const m = slug.match(/^(\d+)-([a-z]+)-\d+$/i);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monthSlug = m[2].toLowerCase();
  const monthIndex = MONTH_SLUGS.indexOf(monthSlug);
  if (monthIndex < 0) return null;
  return { day, monthSlug, monthIndex, monthDisplay: MONTH_NAMES[monthIndex] };
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
