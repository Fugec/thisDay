/**
 * TikTok browser-based uploader (Playwright).
 *
 * Uses a headed Chromium browser so you can handle 2FA / CAPTCHAs manually.
 * Session cookies are saved to assets/tiktok-session.json after first login —
 * subsequent runs skip the login step automatically.
 *
 * First run:
 *   npm run social -- --slug <slug> --video <path>
 *   → browser opens, log in manually (or auto with env vars), session saved
 *
 * Subsequent runs:
 *   → logs in automatically using saved session
 *
 * Env vars (optional — only needed if auto-login is desired):
 *   TIKTOK_USERNAME   your TikTok username / email / phone
 *   TIKTOK_PASSWORD   your TikTok password
 */

import { chromium } from "playwright";
import { existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { buildCaption, waitForLoginSuccess } from "./browser-utils.js";

const SESSION_PATH = join("./assets", "tiktok-session.json");
const UPLOAD_URL = "https://www.tiktok.com/tiktokstudio/upload";

/**
 * Uploads a video to TikTok using browser automation.
 *
 * @param {string} videoPath   Absolute or relative path to the MP4 file
 * @param {{ slug: string, title: string, description: string }} post
 * @returns {Promise<void>}
 */
export async function uploadToTikTok(videoPath, post) {
  const absVideoPath = resolve(videoPath);
  mkdirSync("./assets", { recursive: true });

  const hasSession = existsSync(SESSION_PATH);
  console.log(
    `  TikTok: launching browser (session ${hasSession ? "found" : "not found — login required"})...`,
  );

  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    storageState: hasSession ? SESSION_PATH : undefined,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  try {
    console.log("  TikTok: navigating to creator center...");
    await page.goto(UPLOAD_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    // ── Login check ──────────────────────────────────────────────────────────
    const needsLogin = await page
      .locator(
        'input[name="username"], input[placeholder*="email"], input[placeholder*="phone"], ' +
          'a[href*="/login"], button:has-text("Log in")',
      )
      .first()
      .isVisible({ timeout: 6_000 })
      .catch(() => false);

    if (needsLogin) {
      const username = process.env.TIKTOK_USERNAME;
      const password = process.env.TIKTOK_PASSWORD;

      if (username && password) {
        console.log("  TikTok: auto-logging in with credentials...");

        // TikTok may show a "Log in" button that opens a modal
        const loginBtn = page
          .locator('a[href*="/login"], button:has-text("Log in")')
          .first();
        const loginBtnVisible = await loginBtn
          .isVisible({ timeout: 3_000 })
          .catch(() => false);
        if (loginBtnVisible) await loginBtn.click();

        // Fill in credentials
        await page
          .locator(
            'input[name="username"], input[placeholder*="email"], input[placeholder*="phone"]',
          )
          .first()
          .waitFor({ timeout: 10_000 });
        await page
          .locator(
            'input[name="username"], input[placeholder*="email"], input[placeholder*="phone"]',
          )
          .first()
          .fill(username);
        await page.locator('input[type="password"]').first().fill(password);
        await page
          .locator('button[type="submit"], button[data-e2e="login-button"]')
          .first()
          .click();
      } else {
        console.log("  TikTok: please log in manually in the browser window.");
      }

      await waitForLoginSuccess(
        page,
        "TikTok",
        (u) => u.href.includes("/login"),
        {
          context,
          gmailAddress: process.env.TIKTOK_USERNAME,
          gmailPassword: process.env.TIKTOK_PASSWORD,
        },
      );
      console.log("  TikTok: logged in.");
      // Save session immediately after login so it persists even if upload fails
      await context.storageState({ path: SESSION_PATH });

      // Navigate to upload after login
      await page.goto(UPLOAD_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    }

    // ── Wait for upload page / iframe ────────────────────────────────────────
    console.log("  TikTok: waiting for upload area...");
    await page
      .waitForLoadState("networkidle", { timeout: 30_000 })
      .catch(() => {});

    // If we landed on a login/verify page, treat it as needing login
    const currentUrl = page.url();
    if (
      currentUrl.includes("/login") ||
      currentUrl.includes("/passport") ||
      !currentUrl.includes("tiktok")
    ) {
      throw new Error(
        `Session expired — redirected to ${currentUrl}. Re-run: npm run login -- --platform tiktok`,
      );
    }

    // TikTok Studio may load upload area in iframe or directly on page
    let frame;
    const hasIframe = await page
      .locator("iframe")
      .first()
      .isVisible({ timeout: 15_000 })
      .catch(() => false);
    if (hasIframe) {
      frame = page.frameLocator("iframe:first-of-type");
    } else {
      // No iframe — use page itself as frame context
      frame = page;
    }

    // ── File upload ──────────────────────────────────────────────────────────
    console.log(`  TikTok: uploading video...`);
    const fileInput = frame.locator('input[type="file"]');
    await fileInput.waitFor({ state: "attached", timeout: 30_000 });
    await fileInput.setInputFiles(absVideoPath);

    // Wait for upload to finish (progress bar / "Uploading" text disappears)
    console.log(
      "  TikTok: waiting for upload to finish (may take a few minutes)...",
    );
    await frame
      .locator("text=Uploading")
      .waitFor({ state: "hidden", timeout: 300_000 });
    await page.waitForTimeout(2_000);

    // ── Caption ──────────────────────────────────────────────────────────────
    console.log("  TikTok: filling in caption...");
    const captionBox = frame
      .locator(
        '[data-e2e="caption-input"], .caption-input, div[contenteditable="true"]',
      )
      .first();
    await captionBox.waitFor({ timeout: 20_000 });
    await captionBox.click({ force: true });
    await captionBox.fill("");
    await captionBox.pressSequentially(buildCaption(post), { delay: 8 });

    // ── Post or Save draft ───────────────────────────────────────────────────
    if (process.env.TIKTOK_DRAFT === "true") {
      console.log("  TikTok: saving as draft...");
      const draftBtn = frame
        .locator(
          'button:has-text("Save draft"), button:has-text("Drafts"), [data-e2e="draft-button"]',
        )
        .first();
      await draftBtn.waitFor({ timeout: 20_000 });
      await draftBtn.click();
      console.log("  TikTok: saved as draft.");
    } else {
      console.log("  TikTok: posting...");
      const postBtn = frame
        .locator('button:has-text("Post"), button[data-e2e="post-button"]')
        .first();
      await postBtn.waitFor({ timeout: 20_000 });
      await postBtn.click();
      await Promise.race([
        frame
          .locator("text=Video posted, text=successfully posted")
          .first()
          .waitFor({ timeout: 60_000 }),
        page.waitForURL((u) => u.href.includes("manage"), { timeout: 60_000 }),
      ]).catch(() => {
        console.warn(
          "  TikTok: could not auto-confirm success — check browser for result.",
        );
      });
    }

    console.log("  TikTok: upload complete.");
  } finally {
    await context.storageState({ path: SESSION_PATH });
    console.log(`  TikTok: session saved → ${SESSION_PATH}`);
    await browser.close();
  }
}
