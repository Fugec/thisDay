/**
 * Instagram Reels browser-based uploader (Playwright).
 *
 * Uses a headed Chromium browser so you can handle 2FA / CAPTCHAs manually.
 * Session cookies are saved to assets/instagram-session.json after first login —
 * subsequent runs skip the login step automatically.
 *
 * Env vars (optional — only needed if auto-login is desired):
 *   INSTAGRAM_USERNAME   your Instagram username / email
 *   INSTAGRAM_PASSWORD   your Instagram password
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { buildCaption, waitForLoginSuccess } from './browser-utils.js';

const SESSION_PATH = join('./assets', 'instagram-session.json');

/**
 * Uploads a video as an Instagram Reel using browser automation.
 *
 * @param {string} videoPath   Absolute or relative path to the MP4 file
 * @param {{ slug: string, title: string, description: string }} post
 * @returns {Promise<void>}
 */
export async function uploadToInstagram(videoPath, post) {
  const absVideoPath = resolve(videoPath);
  mkdirSync('./assets', { recursive: true });

  const hasSession = existsSync(SESSION_PATH);
  console.log(`  Instagram: launching browser (session ${hasSession ? 'found' : 'not found — login required'})...`);

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
    console.log('  Instagram: navigating to instagram.com...');
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // ── Login check ──────────────────────────────────────────────────────────
    const needsLogin = await page.locator('input[name="username"]')
      .isVisible({ timeout: 6_000 }).catch(() => false);

    if (needsLogin) {
      // Prefer "Log in with Facebook" — accounts are linked via Meta Business
      const fbLoginBtn = page.locator('button:has-text("Log in with Facebook"), a:has-text("Log in with Facebook")').first();
      const fbVisible = await fbLoginBtn.isVisible({ timeout: 4_000 }).catch(() => false);

      if (fbVisible) {
        console.log('  Instagram: logging in with Facebook...');
        await fbLoginBtn.click();
        await page.waitForTimeout(3_000);
        await page.locator('button:has-text("Continue"), button:has-text("OK")').first()
          .click({ timeout: 8_000 }).catch(() => {});
      } else {
        const username = process.env.INSTAGRAM_USERNAME;
        const password = process.env.INSTAGRAM_PASSWORD;
        if (username && password) {
          console.log('  Instagram: auto-logging in with credentials...');
          await page.locator('input[name="username"]').fill(username);
          const pwInput = page.locator('input[name="password"]').first();
          await pwInput.fill(password);
          await pwInput.press('Enter');
        } else {
          console.log('  Instagram: please log in manually in the browser window.');
        }
      }

      await waitForLoginSuccess(page, 'Instagram', u => u.href.includes('/accounts/login'), {
        context,
        gmailAddress: process.env.INSTAGRAM_USERNAME,
        gmailPassword: process.env.INSTAGRAM_PASSWORD,
      });
      console.log('  Instagram: logged in.');
      // Save session immediately after login so it persists even if upload fails
      await context.storageState({ path: SESSION_PATH });

      // Dismiss "Save login info" / "Turn on notifications" prompts
      for (let i = 0; i < 2; i++) {
        await page.locator('button:has-text("Not now"), button:has-text("Not Now")')
          .first().click({ timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(800);
      }
    }

    // ── Open Create dialog ───────────────────────────────────────────────────
    console.log('  Instagram: opening create dialog...');
    await page.waitForTimeout(2_000);

    const createBtn = page.locator(
      '[aria-label="New post"], [aria-label="Create"], svg[aria-label="New post"], svg[aria-label="Create"], a[href="/create/select/"]'
    ).first();
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await createBtn.waitFor({ timeout: 30_000 });
    await createBtn.click();

    // ── Select "Reel" if the sub-menu appears ────────────────────────────────
    const reelOption = page.locator('span:has-text("Reel"), [aria-label="Reel"]').first();
    const reelVisible = await reelOption.isVisible({ timeout: 4_000 }).catch(() => false);
    if (reelVisible) await reelOption.click();

    // ── File picker ──────────────────────────────────────────────────────────
    console.log('  Instagram: selecting video file...');
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 30_000 }),
      page.locator(
        'button:has-text("Select from computer"), button:has-text("Select From Computer")'
      ).first().click().catch(async () => {
        // Fallback: direct file input
        await page.locator('input[type="file"]').first().waitFor({ timeout: 10_000 });
        await page.locator('input[type="file"]').first().click();
      }),
    ]);
    await fileChooser.setFiles(absVideoPath);

    // ── Wait for video to process ────────────────────────────────────────────
    console.log('  Instagram: processing video (may take a minute)...');
    await page.locator('button:has-text("Next")').first()
      .waitFor({ timeout: 120_000 });

    // Step 1 — trim / crop
    console.log('  Instagram: step 1 — trim (skipping)...');
    await page.locator('div[role="dialog"] button:has-text("Next")').first().click();
    await page.waitForTimeout(1_500);

    // Step 2 — filters / effects
    console.log('  Instagram: step 2 — effects (skipping)...');
    await page.locator('div[role="dialog"] button:has-text("Next")').first()
      .waitFor({ timeout: 15_000 });
    await page.locator('div[role="dialog"] button:has-text("Next")').first().click();
    await page.waitForTimeout(1_500);

    // Step 3 — caption
    console.log('  Instagram: step 3 — adding caption...');
    const captionArea = page.locator(
      'div[role="dialog"] div[aria-label="Write a caption..."], ' +
      'div[role="dialog"] textarea[placeholder*="caption"], ' +
      'div[role="dialog"] div[contenteditable="true"]'
    ).first();
    await captionArea.waitFor({ timeout: 20_000 });
    await captionArea.click();
    await captionArea.fill(buildCaption(post));

    // ── Share ────────────────────────────────────────────────────────────────
    console.log('  Instagram: sharing reel...');
    await page.locator('div[role="dialog"] button:has-text("Share")').first()
      .waitFor({ timeout: 20_000 });
    await page.locator('div[role="dialog"] button:has-text("Share")').first().click();

    await page.locator(
      'text=Your reel has been shared, text=Reel shared'
    ).first().waitFor({ timeout: 120_000 }).catch(() => {
      console.warn('  Instagram: could not auto-confirm success — check browser for result.');
    });

    console.log('  Instagram: upload complete.');

  } finally {
    await context.storageState({ path: SESSION_PATH });
    console.log(`  Instagram: session saved → ${SESSION_PATH}`);
    await browser.close();
  }
}
