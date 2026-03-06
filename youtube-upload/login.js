/**
 * thisDay. — Social Media Login & Session Setup
 *
 * Logs into TikTok, Instagram, and Facebook, handles 2FA automatically
 * via Gmail, and saves session files so future uploads run without login prompts.
 *
 * Run once before your first upload, or whenever sessions expire.
 *
 * Usage:
 *   npm run login                        — log into all three platforms
 *   npm run login -- --platform tiktok   — log into TikTok only
 *   npm run login -- --platform meta     — log into Instagram + Facebook only
 *
 * Sessions saved to:
 *   assets/tiktok-session.json
 *   assets/instagram-session.json
 *   assets/facebook-session.json
 */

import 'dotenv/config';
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { waitForLoginSuccess } from './lib/browser-utils.js';

mkdirSync('./assets', { recursive: true });

// ── Parse CLI args ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1] ?? true;
      i++;
    }
  }
  return args;
}

const args     = parseArgs(process.argv.slice(2));
const platform = (args.platform ?? 'all').toLowerCase();

const doTikTok    = ['all', 'tiktok'].includes(platform);
const doInstagram = ['all', 'meta', 'instagram'].includes(platform);
const doFacebook  = ['all', 'meta', 'facebook'].includes(platform);

// ── Shared helpers ────────────────────────────────────────────────────────────

function newBrowser() {
  return chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

function newContext(browser) {
  return browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
}

/**
 * Dismisses cookie consent / GDPR banners that can block login forms.
 * Tries common "Accept all" / "Allow all" patterns silently.
 */
async function dismissCookies(page) {
  const cookieSelectors = [
    'button:has-text("Allow all cookies")',
    'button:has-text("Accept all cookies")',
    'button:has-text("Accept All")',
    'button:has-text("Accept all")',
    'button:has-text("Allow all")',
    'button:has-text("Decline optional cookies")',  // TikTok fallback
    '[data-testid="cookie-policy-manage-dialog-accept-button"]',
    '#acceptAllButton',
    'button[id*="accept"]',
  ];
  for (const sel of cookieSelectors) {
    const btn = page.locator(sel).first();
    const visible = await btn.isVisible({ timeout: 1_500 }).catch(() => false);
    if (visible) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(500);
      return;
    }
  }
}

// ── TikTok ────────────────────────────────────────────────────────────────────

async function loginTikTok() {
  const SESSION_PATH = join('./assets', 'tiktok-session.json');
  console.log('\n── TikTok ──────────────────────────────────────────────────────────');

  const browser = await newBrowser();
  const context = await newContext(browser);
  const page    = await context.newPage();

  try {
    console.log('  TikTok: opening login page...');
    await page.goto('https://www.tiktok.com/login', {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });

    await dismissCookies(page);

    const username = process.env.TIKTOK_USERNAME;
    const password = process.env.TIKTOK_PASSWORD;

    if (username && password) {
      console.log('  TikTok: navigating to email login...');

      // Step 1: click "Use phone / email"
      const phoneEmailBtn = page.locator(
        'a:has-text("Use phone / email"), button:has-text("Use phone / email"), ' +
        '[data-e2e="channel-item"]:has-text("phone")'
      ).first();
      await phoneEmailBtn.waitFor({ timeout: 10_000 });
      await phoneEmailBtn.click();
      await page.waitForTimeout(800);

      // Step 2: click "Use email or username"
      const emailUsernameBtn = page.locator(
        'a:has-text("Use email or username"), span:has-text("Use email or username"), ' +
        'a:has-text("Log in with email"), span:has-text("Log in with email")'
      ).first();
      await emailUsernameBtn.waitFor({ timeout: 10_000 });
      await emailUsernameBtn.click();
      await page.waitForTimeout(800);

      // Step 3: fill email + password
      console.log('  TikTok: filling credentials...');
      const emailInput = page.locator('input[name="username"], input[type="email"], input[placeholder*="Email"], input[placeholder*="email"]').first();
      await emailInput.waitFor({ timeout: 15_000 });
      await emailInput.fill(username);
      await page.locator('input[type="password"]').first().fill(password);
      await page.locator('button[type="submit"], button[data-e2e="login-button"]').first().click();
    } else {
      console.log('  TikTok: please log in manually in the browser window.');
    }

    await waitForLoginSuccess(page, 'TikTok', u => u.href.includes('/login'), {
      context,
      gmailAddress: process.env.TIKTOK_USERNAME,
      gmailPassword: process.env.TIKTOK_PASSWORD,
    });

    await context.storageState({ path: SESSION_PATH });
    console.log(`  TikTok: session saved → ${SESSION_PATH}`);
  } finally {
    await browser.close();
  }
}

// ── Meta (Facebook + Instagram in one browser) ────────────────────────────────

async function loginMeta() {
  const FB_SESSION_PATH = join('./assets', 'facebook-session.json');
  const IG_SESSION_PATH = join('./assets', 'instagram-session.json');

  const browser = await newBrowser();
  const context = await newContext(browser);

  try {
    // ── Step 1: Facebook ───────────────────────────────────────────────────────
    if (doFacebook) {
      console.log('\n── Facebook ────────────────────────────────────────────────────────');
      const page = await context.newPage();

      console.log('  Facebook: opening login page...');
      await page.goto('https://www.facebook.com/', {
        waitUntil: 'networkidle',
        timeout: 30_000,
      });

      await dismissCookies(page);
      await page.waitForTimeout(2_000);

      const username = process.env.INSTAGRAM_USERNAME; // same Meta account
      const password = process.env.INSTAGRAM_PASSWORD;

      if (username && password) {
        console.log('  Facebook: filling Meta credentials...');
        const emailInput = page.locator(
          'input[name="email"], #email, ' +
          'input[aria-label="Email or mobile number"], input[placeholder*="Email or mobile" i]'
        ).first();
        await emailInput.waitFor({ timeout: 20_000 });
        await emailInput.fill(username);
        const passInput = page.locator('input[name="pass"], #pass, input[aria-label="Password"], input[type="password"]').first();
        await passInput.fill(password);
        await passInput.press('Enter');
      } else {
        console.log('  Facebook: please log in manually in the browser window.');
      }

      await waitForLoginSuccess(page, 'Facebook', u => u.href.includes('/login'), {
        context,
        gmailAddress: process.env.INSTAGRAM_USERNAME,
        gmailPassword: process.env.INSTAGRAM_PASSWORD,
      });

      await context.storageState({ path: FB_SESSION_PATH });
      console.log(`  Facebook: session saved → ${FB_SESSION_PATH}`);
      await page.close();
    }

    // ── Step 2: Instagram via "Log in with Facebook" ──────────────────────────
    if (doInstagram) {
      console.log('\n── Instagram ───────────────────────────────────────────────────────');
      const page = await context.newPage();

      console.log('  Instagram: opening login page...');
      await page.goto('https://www.instagram.com/accounts/login/', {
        waitUntil: 'networkidle',
        timeout: 30_000,
      });

      await dismissCookies(page);
      await page.waitForTimeout(2_000);

      console.log('  Instagram: clicking "Log in with Facebook"...');
      const fbLoginBtn = page.locator(
        'button:has-text("Log in with Facebook"), a:has-text("Log in with Facebook"), ' +
        '[data-testid="royal_login_button"]:has-text("Facebook"), span:has-text("Log in with Facebook")'
      ).first();
      const fbBtnVisible = await fbLoginBtn.isVisible({ timeout: 5_000 }).catch(() => false);

      if (fbBtnVisible) {
        await fbLoginBtn.click();
        await page.waitForTimeout(3_000);
        // Facebook may show an "Continue as..." dialog — click it
        const continueBtn = page.locator(
          'button:has-text("Continue"), button:has-text("OK"), button:has-text("Yes")'
        ).first();
        await continueBtn.click({ timeout: 10_000 }).catch(() => {});
      } else {
        console.log('  Instagram: "Log in with Facebook" not found — trying manual credentials...');
        const username = process.env.INSTAGRAM_USERNAME;
        const password = process.env.INSTAGRAM_PASSWORD;
        if (username && password) {
          const usernameInput = page.locator('input[name="username"]').first();
          await usernameInput.waitFor({ state: 'attached', timeout: 20_000 });
          await usernameInput.fill(username);
          const passwordInput = page.locator('input[name="password"]').first();
          await passwordInput.fill(password);
          await passwordInput.press('Enter');
        }
      }

      await waitForLoginSuccess(page, 'Instagram', u => u.href.includes('/accounts/login'), {
        context,
        gmailAddress: process.env.INSTAGRAM_USERNAME,
        gmailPassword: process.env.INSTAGRAM_PASSWORD,
      });

      // Dismiss "Save login info" / notifications prompts
      for (let i = 0; i < 2; i++) {
        await page.locator('button:has-text("Not now"), button:has-text("Not Now")')
          .first().click({ timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(800);
      }

      await context.storageState({ path: IG_SESSION_PATH });
      console.log(`  Instagram: session saved → ${IG_SESSION_PATH}`);
      await page.close();
    }

  } finally {
    await browser.close();
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nSocial Login Setup');
  console.log(`Platforms: ${platform}`);

  if (doTikTok)                    await loginTikTok().catch(err => console.error(`TikTok login failed: ${err.message}`));
  if (doInstagram || doFacebook)   await loginMeta().catch(err => console.error(`Meta login failed: ${err.message}`));

  console.log('\nAll sessions saved. Ready to upload.');
  console.log('Run:  npm run social -- --slug <slug> --video <path>');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
