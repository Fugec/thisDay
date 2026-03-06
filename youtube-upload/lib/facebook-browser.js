/**
 * Facebook Reels browser-based uploader (Playwright).
 *
 * Uses the same Meta Business credentials as Instagram.
 * Session cookies are saved to assets/facebook-session.json after first login —
 * subsequent runs skip the login step automatically.
 *
 * Env vars (optional — only needed if auto-login is desired):
 *   INSTAGRAM_USERNAME   your Facebook/Meta email (same account as Instagram)
 *   INSTAGRAM_PASSWORD   your Facebook/Meta password
 *
 * Optional:
 *   FACEBOOK_PAGE_URL    your Facebook Page URL (e.g. https://www.facebook.com/thisday.info)
 *                        If set, the Reel is posted on the Page instead of personal profile.
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { buildCaption, waitForLoginSuccess } from './browser-utils.js';

const SESSION_PATH  = join('./assets', 'facebook-session.json');
const REELS_URL     = 'https://www.facebook.com/reels/create';

/**
 * Uploads a video as a Facebook Reel using browser automation.
 *
 * @param {string} videoPath   Absolute or relative path to the MP4 file
 * @param {{ slug: string, title: string, description: string }} post
 * @returns {Promise<void>}
 */
export async function uploadToFacebook(videoPath, post) {
  const absVideoPath = resolve(videoPath);
  mkdirSync('./assets', { recursive: true });

  const hasSession = existsSync(SESSION_PATH);
  console.log(`  Facebook: launching browser (session ${hasSession ? 'found' : 'not found — login required'})...`);

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    storageState: hasSession ? SESSION_PATH : undefined,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  try {
    // ── Login ────────────────────────────────────────────────────────────────
    console.log('  Facebook: navigating...');
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });

    const needsLogin = await page.locator('input[name="email"], input[id="email"]')
      .isVisible({ timeout: 6_000 }).catch(() => false);

    if (needsLogin) {
      const username = process.env.INSTAGRAM_USERNAME; // same Meta account
      const password = process.env.INSTAGRAM_PASSWORD;

      if (username && password) {
        console.log('  Facebook: auto-logging in with Meta credentials...');
        await page.locator('input[name="email"], input[id="email"]').first().fill(username);
        await page.locator('input[name="pass"], input[id="pass"]').first().fill(password);
        await page.locator('button[name="login"], button[type="submit"]').first().click();
      } else {
        console.log('  Facebook: please log in manually in the browser window.');
      }

      await waitForLoginSuccess(page, 'Facebook', u =>
        u.href.includes('/login') || (!u.href.includes('facebook.com') && u.pathname !== '/'), {
        context,
        gmailAddress: process.env.INSTAGRAM_USERNAME,
        gmailPassword: process.env.INSTAGRAM_PASSWORD,
      });
      console.log('  Facebook: logged in.');
      // Save session immediately after login so it persists even if upload fails
      await context.storageState({ path: SESSION_PATH });
    }

    // ── Navigate to Reel creator ─────────────────────────────────────────────
    // If a Page URL is configured, post from the Page; otherwise personal profile
    const pageUrl = process.env.FACEBOOK_PAGE_URL;
    if (pageUrl) {
      console.log(`  Facebook: navigating to Page → ${pageUrl}`);
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(2_000);

      // Click "Create Reel" from the Page toolbar
      const createReelBtn = page.locator(
        'a:has-text("Create Reel"), button:has-text("Create Reel"), ' +
        '[aria-label="Create Reel"], span:has-text("Reel")'
      ).first();
      await createReelBtn.waitFor({ timeout: 15_000 });
      await createReelBtn.click();
    } else {
      console.log('  Facebook: navigating to Reels creator...');
      await page.goto(REELS_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }

    // ── File upload ──────────────────────────────────────────────────────────
    console.log('  Facebook: uploading video...');
    await page.waitForTimeout(2_000);

    // Try file chooser trigger first, fall back to direct input
    const uploadBtn = page.locator(
      'button:has-text("Add video"), button:has-text("Upload"), ' +
      'label:has-text("Add video"), [aria-label*="upload" i], [aria-label*="video" i]'
    ).first();

    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 20_000 }),
      uploadBtn.isVisible({ timeout: 5_000 })
        .then(v => v ? uploadBtn.click() : page.locator('input[type="file"]').first().click())
        .catch(() => page.locator('input[type="file"]').first().click()),
    ]);
    await fileChooser.setFiles(absVideoPath);

    // ── Wait for upload + processing ─────────────────────────────────────────
    console.log('  Facebook: processing video (may take a minute)...');
    // Wait for Next / Continue button to appear (signals processing done)
    await page.locator(
      'button:has-text("Next"), button:has-text("Continue")'
    ).first().waitFor({ timeout: 180_000 });
    await page.waitForTimeout(1_500);

    // ── Caption ──────────────────────────────────────────────────────────────
    console.log('  Facebook: adding caption...');
    // Facebook Reels description field
    const captionArea = page.locator(
      'div[contenteditable="true"][aria-label*="caption" i], ' +
      'div[contenteditable="true"][aria-label*="description" i], ' +
      'div[contenteditable="true"][role="textbox"], ' +
      'textarea[placeholder*="description" i], textarea[placeholder*="caption" i]'
    ).first();

    const captionVisible = await captionArea.isVisible({ timeout: 10_000 }).catch(() => false);
    if (captionVisible) {
      await captionArea.click();
      await captionArea.fill(buildCaption(post));
    } else {
      console.warn('  Facebook: caption field not found — you may need to add it manually.');
    }

    // ── Publish ──────────────────────────────────────────────────────────────
    console.log('  Facebook: publishing...');
    const publishBtn = page.locator(
      'button:has-text("Publish"), button:has-text("Post"), button:has-text("Share now")'
    ).first();
    await publishBtn.waitFor({ timeout: 20_000 });
    await publishBtn.click();

    // Wait for success
    await page.locator(
      'text=Your reel is published, text=Reel published, text=posted'
    ).first().waitFor({ timeout: 120_000 }).catch(() => {
      console.warn('  Facebook: could not auto-confirm success — check browser for result.');
    });

    console.log('  Facebook: upload complete.');

  } finally {
    await context.storageState({ path: SESSION_PATH });
    console.log(`  Facebook: session saved → ${SESSION_PATH}`);
    await browser.close();
  }
}
