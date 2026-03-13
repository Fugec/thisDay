import "dotenv/config";
import { getPostIndex, kvGet } from "./lib/kv.js";

function isPlaceholder(url) {
  if (!url) return true;
  const n = url.trim().toLowerCase();
  return n.includes('/images/logo.png') || n.includes('placehold.co') || n.includes('placeholder');
}

async function isImageReachable(url) {
  if (!url || isPlaceholder(url)) return false;
  try {
    const headers = { "User-Agent": "thisday.info-blog/1.0 (https://thisday.info)" };
    let res = await fetch(url, { method: "HEAD", redirect: "follow", headers });
    if (res.status === 405 || res.status === 403 || res.status === 501) {
      res = await fetch(url, { method: "GET", redirect: "follow", headers });
    }
    if (!res.ok) return false;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    return ct.startsWith("image/");
  } catch {
    return false;
  }
}

async function fetchWikipediaImage(title) {
  if (!title) return null;
  try {
    const res = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      { headers: { "User-Agent": "thisday.info-blog/1.0 (https://thisday.info)" } },
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.thumbnail?.source ?? data.originalimage?.source ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const posts = await getPostIndex();
  const uploadedRaw = await kvGet("youtube:uploaded");
  const uploaded = uploadedRaw ? JSON.parse(uploadedRaw) : {};

  const latest = [...posts]
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, 10);

  console.log(`Posts in index: ${posts.length}`);
  console.log(`Uploads tracked: ${Object.keys(uploaded).length}`);
  console.log("\nLatest 10 posts — image check:\n");

  for (const p of latest) {
    const yt = uploaded[p.slug] || null;
    const uploadStatus = !yt
      ? "NO_UPLOAD"
      : yt.privacy === "private"
        ? "PRIVATE"
        : "PUBLIC";

    const imageOk = await isImageReachable(p.imageUrl);
    let imageStatus = imageOk
      ? "✓ OK"
      : isPlaceholder(p.imageUrl)
        ? "✗ PLACEHOLDER/LOGO"
        : "✗ BROKEN";

    let replacement = null;
    if (!imageOk) {
      replacement = await fetchWikipediaImage(p.title);
      const replOk = replacement ? await isImageReachable(replacement) : false;
      imageStatus += replOk
        ? `  →  Wikipedia replacement available`
        : `  →  NO REPLACEMENT FOUND`;
    }

    const ytLink = yt?.youtubeId ? ` https://youtube.com/shorts/${yt.youtubeId}` : "";
    console.log(`[${uploadStatus}] ${p.slug}`);
    console.log(`  image : ${p.imageUrl ?? "(none)"}`);
    console.log(`  status: ${imageStatus}`);
    if (replacement && !imageOk) {
      console.log(`  wiki  : ${replacement}`);
    }
    if (ytLink) console.log(`  yt    :${ytLink}`);
    console.log();
  }
}

main().catch((err) => {
  console.error("diagnose failed:", err.message);
  process.exit(1);
});
