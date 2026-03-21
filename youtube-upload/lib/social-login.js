/**
 * One-time social media login via OpenClaw browser automation.
 *
 * Facebook login covers both Facebook and Instagram (via Business Suite).
 * Run this once locally — OpenClaw persists the session in the browser profile
 * so subsequent uploads work without re-logging in.
 *
 * Usage:
 *   node lib/social-login.js             # login to all platforms
 *   node lib/social-login.js facebook    # Facebook + Instagram (Business Suite)
 *   node lib/social-login.js tiktok
 *
 * Required in .env:
 *   FACEBOOK_EMAIL, FACEBOOK_PASSWORD
 *   TIKTOK_EMAIL, TIKTOK_PASSWORD
 *
 * Optional:
 *   OPENCLAW_PROFILE  — browser profile (default: "openclaw")
 */

import "dotenv/config";
import { execFileSync } from "child_process";

function profile() {
  return process.env.OPENCLAW_PROFILE ?? "openclaw";
}

function ocb(args, timeoutMs = 30_000) {
  return execFileSync("openclaw", ["browser", "--browser-profile", profile(), ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
  }).trim();
}

function findRef(snapshot, ...labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`"[^"]*${escaped}[^"]*"\\s*\\[ref=(e\\d+)\\]`, "i");
    const m = snapshot.match(re);
    if (m) return m[1];
  }
  return null;
}

/** Sync sleep using Atomics — no gateway needed. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Polls snapshot until the given text appears or timeoutMs elapses.
 * Does not use the gateway — works with browser CDP only.
 */
function waitForText(text, timeoutMs = 60_000, intervalMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    sleep(intervalMs);
    try {
      const snap = ocb(["snapshot", "--interactive"], 15_000);
      if (snap.toLowerCase().includes(text.toLowerCase())) return snap;
    } catch { /* page still loading */ }
  }
  throw new Error(`Timed out waiting for text: "${text}"`);
}

// ---------------------------------------------------------------------------
// Facebook  (covers Instagram via Business Suite)
// ---------------------------------------------------------------------------

async function loginFacebook() {
  const email    = process.env.FACEBOOK_EMAIL;
  const password = process.env.FACEBOOK_PASSWORD;
  if (!email || !password) throw new Error("FACEBOOK_EMAIL / FACEBOOK_PASSWORD not set in .env");

  console.log("  [FB] Navigating to login page...");
  ocb(["open", "https://www.facebook.com/login"]);
  sleep(3_000);

  const snap = ocb(["snapshot", "--interactive"], 20_000);
  const alreadyLoggedIn = snap.includes("Home") && !snap.includes("Log in");

  if (!alreadyLoggedIn) {
    const emailRef = findRef(snap, "Email address or mobile number", "Email", "Phone");
    const passRef  = findRef(snap, "Password");
    if (!emailRef || !passRef) throw new Error("[FB] Could not find login fields");

    ocb(["click", emailRef], 5_000);
    ocb(["type", emailRef, email], 10_000);
    ocb(["click", passRef], 5_000);
    ocb(["type", passRef, password], 10_000);
    ocb(["press", "Enter"], 5_000);

    console.log("  [FB] Waiting for home feed...");
    waitForText("Home", 30_000);
  } else {
    console.log("  [FB] Already logged in");
  }

  // Switch from personal profile to Page view so uploads go to the right account
  console.log("  [FB] Switching to Page view...");
  sleep(2_000);
  const snap2 = ocb(["snapshot", "--interactive"], 20_000);
  // "Your profile" button opens the account switcher
  const profileRef = findRef(snap2, "Your profile", "Switch profile", "See all profiles");
  if (profileRef) {
    ocb(["click", profileRef], 5_000);
    sleep(2_000);
    const snap3 = ocb(["snapshot", "--interactive"], 15_000);
    // Look for the Page in the switcher list
    const pageRef = findRef(snap3, "ThisDay", "Switch to Page", "View as Page", "Switch now");
    if (pageRef) {
      ocb(["click", pageRef], 5_000);
      sleep(2_000);
      console.log("  [FB] ✓ Switched to Page view");
    } else {
      console.warn("  [FB] ⚠ Page not found in switcher — you may need to switch manually");
    }
  } else {
    console.warn("  [FB] ⚠ Profile switcher not found");
  }

  console.log("  [FB] ✓ Session ready — Facebook + Instagram via Business Suite");
}

// ---------------------------------------------------------------------------
// TikTok
// ---------------------------------------------------------------------------

async function loginTikTok() {
  const email    = process.env.TIKTOK_EMAIL;
  const password = process.env.TIKTOK_PASSWORD;
  if (!email || !password) throw new Error("TIKTOK_EMAIL / TIKTOK_PASSWORD not set in .env");

  console.log("  [TT] Navigating to login page...");
  ocb(["open", "https://www.tiktok.com/login/phone-or-email/email"]);
  sleep(3_000);

  const snap = ocb(["snapshot", "--interactive"], 20_000);
  const alreadyLoggedIn = !snap.includes("Log in") && !snap.includes("Email or username");

  if (alreadyLoggedIn) {
    console.log("  [TT] Already logged in");
  } else {
    const emailRef = findRef(snap, "Email or username");
    const passRef  = findRef(snap, "Password");
    if (!emailRef || !passRef) throw new Error("[TT] Could not find login fields");

    ocb(["click", emailRef], 5_000);
    ocb(["type", emailRef, email], 10_000);
    ocb(["click", passRef], 5_000);
    ocb(["type", passRef, password], 10_000);
    ocb(["press", "Enter"], 5_000);

    console.log("  [TT] Waiting for home feed...");
    waitForText("For You", 30_000);
  }

  console.log("  [TT] ✓ Logged into TikTok");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const PLATFORMS = {
  facebook: loginFacebook,
  tiktok:   loginTikTok,
};

async function main() {
  try {
    execFileSync("openclaw", ["--version"], { encoding: "utf8", timeout: 5_000 });
  } catch {
    console.error("openclaw not found in PATH.");
    console.error("Install: https://docs.openclaw.ai/getting-started");
    process.exit(1);
  }

  const targets = process.argv[2]
    ? [process.argv[2].toLowerCase()]
    : Object.keys(PLATFORMS);

  for (const name of targets) {
    const fn = PLATFORMS[name];
    if (!fn) {
      console.error(`Unknown platform: ${name}. Choose from: ${Object.keys(PLATFORMS).join(", ")}`);
      process.exit(1);
    }
    console.log(`\n→ Logging into ${name}...`);
    try {
      await fn();
    } catch (err) {
      console.error(`  ✗ ${err.message}`);
    }
  }

  console.log("\nDone. Sessions saved — uploads will now work automatically.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
