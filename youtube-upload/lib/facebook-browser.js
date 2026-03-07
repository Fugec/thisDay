/**
 * Meta Business Suite uploader (Playwright).
 *
 * Logs into Facebook, then navigates to Meta Business Suite to create a Reel
 * that posts simultaneously to both Facebook and Instagram.
 *
 * Env vars (optional — only needed if auto-login is desired):
 *   INSTAGRAM_USERNAME   your Facebook/Meta email (same account as Instagram)
 *   INSTAGRAM_PASSWORD   your Facebook/Meta password
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { buildCaption, waitForLoginSuccess } from './browser-utils.js';

const SESSION_PATH = join('./assets', 'facebook-session.json');

/**
 * Uploads a Reel via Meta Business Suite (posts to Facebook + Instagram).
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
    // ── Login via Facebook ────────────────────────────────────────────────────
    console.log('  Meta: navigating to Facebook...');
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });

    const emailInput = page.locator('input[name="email"], input[id="email"]').first();
    const needsLogin = await emailInput.isVisible({ timeout: 8_000 }).catch(() => false);

    if (needsLogin) {
      const username = process.env.INSTAGRAM_USERNAME;
      const password = process.env.INSTAGRAM_PASSWORD;

      if (username && password) {
        console.log('  Meta: filling Facebook credentials...');
        await emailInput.fill(username);
        const passInput = page.locator('input[name="pass"], input[id="pass"]').first();
        await passInput.fill(password);
        await passInput.press('Enter');
      } else {
        console.log('  Meta: please log in manually in the browser window.');
      }

      // Check for "I'm not a robot" checkbox after login attempt
      await page.waitForTimeout(3_000);
      const captchaFrame = page.frameLocator('iframe[src*="recaptcha"], iframe[title*="recaptcha" i], iframe[src*="captcha"]');
      const robotCheckbox = captchaFrame.locator('#recaptcha-anchor, .recaptcha-checkbox').first();
      const robotVisible = await robotCheckbox.isVisible({ timeout: 3_000 }).catch(() => false);
      if (robotVisible) {
        console.log('  Meta: checking "I\'m not a robot"...');
        await robotCheckbox.click();
        await page.waitForTimeout(2_000);
      } else {
        // Also try clicking a plain "I'm not a robot" checkbox outside iframe
        const plainRobot = page.locator('[aria-label*="robot" i], label:has-text("not a robot")').first();
        const plainVisible = await plainRobot.isVisible({ timeout: 2_000 }).catch(() => false);
        if (plainVisible) {
          console.log('  Meta: checking plain "I\'m not a robot"...');
          await plainRobot.click();
          await page.waitForTimeout(2_000);
        }
      }

      await waitForLoginSuccess(page, 'Facebook', u =>
        u.href.includes('/login') || (!u.href.includes('facebook.com') && u.pathname !== '/'), {
        context,
        gmailAddress: process.env.INSTAGRAM_USERNAME,
        gmailPassword: process.env.INSTAGRAM_PASSWORD,
      });
      console.log('  Meta: logged in to Facebook.');
      await context.storageState({ path: SESSION_PATH });
    } else {
      console.log('  Meta: already logged in (session valid).');
    }

    // ── Navigate to the Page and open Meta Business Suite ───────────────────
    const pageUrl = process.env.FB_PAGE_URL || 'https://www.facebook.com/profile.php?id=61578009082537';
    console.log(`  Meta: navigating to Page...`);
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
    console.log(`  Meta: on Page → ${page.url()}`);

    // Click Meta Business Suite link — look by href (links to business.facebook.com)
    console.log('  Meta: clicking Meta Business Suite...');
    // First expand sidebar if there's a "See more" button
    const seeMore = page.locator('span:has-text("See more"), [aria-label*="See more" i]').first();
    const seeMoreVisible = await seeMore.isVisible({ timeout: 3_000 }).catch(() => false);
    if (seeMoreVisible) {
      await seeMore.click({ force: true });
      await page.waitForTimeout(1_000);
    }
    const mbs = page.locator(
      'a[href*="business.facebook.com"], ' +
      'a:has-text("Meta Business Suite"), a:has-text("Business Suite"), ' +
      'a:has-text("Go to Business Suite"), ' +
      '[aria-label*="Business Suite" i]'
    ).first();
    const mbsVisible = await mbs.isVisible({ timeout: 8_000 }).catch(() => false);
    if (mbsVisible) {
      await mbs.click();
    } else {
      // Fallback: navigate directly using existing session cookies
      console.log('  Meta: MBS link not found on Page — navigating directly to Business Suite...');
      await page.goto('https://business.facebook.com/latest/home/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(3_000);
    console.log(`  Meta: Business Suite URL → ${page.url()}`);

    // If redirected to BS login page, click "Log in with Facebook"
    if (page.url().includes('loginpage') || page.url().includes('business.facebook.com/login')) {
      console.log('  Meta: BS login page — clicking Log in with Facebook...');
      const fbBtn = page.locator(
        'button:has-text("Facebook"), a:has-text("Facebook"), ' +
        '[aria-label*="Facebook" i], [data-testid*="facebook" i]'
      ).first();
      await fbBtn.waitFor({ timeout: 15_000 });
      await fbBtn.click();
      console.log('  Meta: waiting for BS auth (solve CAPTCHA in browser if shown)...');
      await page.waitForURL(
        url => !url.href.includes('loginpage') && !url.href.includes('business.facebook.com/login'),
        { timeout: 300_000 }
      );
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(2_000);
      await context.storageState({ path: SESSION_PATH });
      console.log(`  Meta: BS authenticated → ${page.url()}`);
      // Navigate to BS home
      await page.goto('https://business.facebook.com/latest/home/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(2_000);
      console.log(`  Meta: BS home → ${page.url()}`);
    }

    // ── Click "Create reel" from top menu ────────────────────────────────────
    console.log('  Meta: clicking Create reel from top menu...');
    const createReelBtn = page.locator(
      'button:has-text("Create reel"), a:has-text("Create reel"), ' +
      'button:has-text("Create Reel"), a:has-text("Create Reel"), ' +
      '[aria-label*="Create reel" i]'
    ).first();
    await createReelBtn.waitFor({ timeout: 20_000 });
    await createReelBtn.click();
    await page.waitForTimeout(2_000);
    console.log(`  Meta: after Create Reel click → ${page.url()}`);

    // ── Add video via Media / "Add video" button ──────────────────────────────
    console.log('  Meta: clicking Add video in Media section...');
    const addVideoBtn = page.locator(
      'button:has-text("Add video"), [aria-label*="Add video" i], ' +
      'div[role="button"]:has-text("Add video")'
    ).first();
    await addVideoBtn.waitFor({ timeout: 15_000 });
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 20_000 }),
      addVideoBtn.click(),
    ]);
    await fileChooser.setFiles(absVideoPath);
    console.log('  Meta: video file set, waiting for upload...');

    // Wait for upload to finish (progress bar disappears or Next/Publish appears)
    await page.waitForTimeout(5_000);
    await page.locator(
      'button:has-text("Publish"), button:has-text("Post"), button:has-text("Share"), button:has-text("Next")'
    ).first().waitFor({ timeout: 180_000 });

    // ── Write description in "Text" field ─────────────────────────────────────
    console.log('  Meta: writing description in Text field...');
    const textField = page.locator(
      'textarea[aria-label="Text"], div[aria-label="Text"], ' +
      'div[contenteditable="true"][aria-label="Text"], ' +
      'textarea[placeholder*="Write something" i], ' +
      'div[contenteditable="true"][data-placeholder*="Write" i]'
    ).first();
    const textVisible = await textField.isVisible({ timeout: 8_000 }).catch(() => false);
    if (textVisible) {
      await textField.click();
      await textField.fill(buildCaption(post));
    } else {
      console.warn('  Meta: Text field not found — add description manually if needed.');
    }

    // ── Publish ───────────────────────────────────────────────────────────────
    console.log('  Meta: publishing Reel to Facebook + Instagram...');
    const publishBtn = page.locator(
      'button:has-text("Publish"), button:has-text("Post"), button:has-text("Share")'
    ).first();
    await publishBtn.waitFor({ timeout: 20_000 });
    await publishBtn.click();

    await page.locator('text=published, text=posted, text=scheduled, text=shared')
      .first().waitFor({ timeout: 120_000 }).catch(() => {
        console.warn('  Meta: could not confirm success — check browser for result.');
      });

    console.log('  Meta: Reel published to Facebook + Instagram.');

  } finally {
    await context.storageState({ path: SESSION_PATH });
    console.log(`  Meta: session saved → ${SESSION_PATH}`);
    await browser.close();
  }
}
