/**
 * Shared browser automation utilities for social media uploaders.
 */

/**
 * Builds a caption identical to the YouTube description format.
 * Safe for TikTok (2 200 chars), Instagram (2 200 chars), Facebook (63 206 chars).
 *
 * @param {{ slug: string, title: string, description: string }} post
 * @returns {string}
 */
export function buildCaption(post) {
  return [
    post.title,
    '',
    post.description,
    '',
    `Read the full article → https://thisday.info/blog/${post.slug}/`,
    '',
    '#OnThisDay #History #Shorts #ThisDay #HistoricalEvents #TodayInHistory',
  ].join('\n').slice(0, 2200);
}

// ── Gmail 2FA helper ──────────────────────────────────────────────────────────

/**
 * Per-platform Gmail search query and 2FA input selectors.
 */
const PLATFORM_CONFIG = {
  TikTok: {
    gmailSearch: 'from:tiktok verification OR code OR security',
    codeInputSelector: 'input[placeholder*="digit"], input[placeholder*="code"], input[maxlength="6"], input[maxlength="4"]',
    submitSelector: 'button[type="submit"], button:has-text("Submit"), button:has-text("Verify"), button:has-text("Next")',
  },
  Instagram: {
    gmailSearch: 'from:instagram is your Instagram code OR security code',
    codeInputSelector: 'input[name="verificationCode"], input[aria-label*="code" i], input[placeholder*="code" i]',
    submitSelector: 'button:has-text("Confirm"), button:has-text("Submit"), button[type="submit"]',
  },
  Facebook: {
    gmailSearch: 'from:facebook confirmation code OR security code',
    codeInputSelector: 'input[name="approvals_code"], input[id="approvals_code"], input[placeholder*="code" i]',
    submitSelector: 'button:has-text("Continue"), button:has-text("Submit"), button[type="submit"]',
  },
};

/**
 * Opens a new tab in the same browser context, logs into Gmail if needed,
 * searches for the latest verification email from the platform, and returns
 * the numeric code found in the email body.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {string} gmailAddress   e.g. 'kapetanovic.armin@gmail.com'
 * @param {string} gmailPassword  Gmail password (may contain special chars — pass as-is)
 * @param {string} platformName   'TikTok' | 'Instagram' | 'Facebook'
 * @returns {Promise<string>}     the numeric verification code
 */
async function getCodeFromGmail(context, gmailAddress, gmailPassword, platformName) {
  const gmailPage = await context.newPage();
  try {
    console.log(`  ${platformName}: opening Gmail to fetch verification code...`);
    await gmailPage.goto('https://mail.google.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    // ── Gmail login if needed ───────────────────────────────────────────────
    const needsLogin = await gmailPage.locator('input[type="email"]')
      .isVisible({ timeout: 5_000 }).catch(() => false);

    if (needsLogin) {
      console.log(`  ${platformName}: logging into Gmail (${gmailAddress})...`);
      await gmailPage.locator('input[type="email"]').fill(gmailAddress);
      await gmailPage.locator('#identifierNext').click();

      await gmailPage.locator('input[type="password"]').waitFor({ timeout: 10_000 });
      await gmailPage.locator('input[type="password"]').fill(gmailPassword);
      await gmailPage.locator('button:has-text("Next"), #passwordNext').click();

      await gmailPage.waitForURL(url => url.href.includes('mail.google.com/mail'), {
        timeout: 30_000,
      });
    }

    // ── Search for the latest verification email ────────────────────────────
    const config  = PLATFORM_CONFIG[platformName] ?? PLATFORM_CONFIG.TikTok;
    const searchUrl = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(config.gmailSearch)}`;

    console.log(`  ${platformName}: searching Gmail for verification email...`);
    await gmailPage.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30_000 });
    await gmailPage.waitForTimeout(2_000);

    // Click the first (newest) result row
    const firstRow = gmailPage.locator('tr.zA, div[role="row"]').first();
    await firstRow.waitFor({ timeout: 15_000 });
    await firstRow.click();
    await gmailPage.waitForTimeout(1_500);

    // Get email body text
    const bodyEl = gmailPage.locator('.a3s.aiL, .a3s, [data-message-id] .ii.gt').first();
    await bodyEl.waitFor({ timeout: 10_000 });
    const bodyText = await bodyEl.textContent();

    // Extract 4–8 digit code (skip years like 2024/2025)
    const matches = [...(bodyText ?? '').matchAll(/\b(\d{4,8})\b/g)]
      .map(m => m[1])
      .filter(n => !['2024', '2025', '2026', '2027'].includes(n)); // exclude years

    if (!matches.length) {
      throw new Error(`No verification code found in the email body.`);
    }

    const code = matches[0];
    console.log(`  ${platformName}: found code → ${code}`);
    return code;

  } finally {
    await gmailPage.close();
  }
}

// ── Main login helper ─────────────────────────────────────────────────────────

/**
 * After clicking a login button, waits for either:
 *   (a) successful redirect away from the login page, or
 *   (b) a 2FA / verification prompt.
 *
 * When a 2FA prompt is detected and Gmail credentials are provided, the function
 * automatically opens Gmail, reads the latest verification email, and fills in
 * the code. Otherwise it waits for the user to complete 2FA manually.
 *
 * @param {import('playwright').Page} page
 * @param {string} platformName            'TikTok' | 'Instagram' | 'Facebook'
 * @param {(url: URL) => boolean} isLoginUrl   returns true while still on login page
 * @param {{
 *   context?: import('playwright').BrowserContext,
 *   gmailAddress?: string,
 *   gmailPassword?: string,
 *   twoFaWaitMs?: number,
 * }} [options]
 */
export async function waitForLoginSuccess(page, platformName, isLoginUrl, options = {}) {
  const { context, gmailAddress, gmailPassword, twoFaWaitMs = 600_000 } = options;

  // Common 2FA / verification input selectors across Meta + TikTok
  const twoFaInputSelector = [
    'input[name="verificationCode"]',
    'input[name="approvals_code"]',
    'input[id="approvals_code"]',
    'input[autocomplete="one-time-code"]',
    'input[placeholder*="digit" i]',
    'input[placeholder*="verification" i]',
    'input[placeholder*="code" i]',
    'input[maxlength="6"]',
    'input[maxlength="4"]',
    // Headings / wrappers that indicate a 2FA screen is showing
    'h1:has-text("Two-factor")',
    'h2:has-text("Two-factor")',
    'div:has-text("Security verification")',
    'div:has-text("Suspicious login")',
    'iframe[src*="captcha"]',
  ].join(', ');

  // Quick check: did we land on the home page already (no 2FA needed)?
  const outcome = await Promise.race([
    page.waitForURL(url => !isLoginUrl(url), { timeout: 8_000 })
      .then(() => 'success').catch(() => null),
    page.waitForSelector(twoFaInputSelector, { timeout: 8_000 })
      .then(() => '2fa').catch(() => null),
  ]);

  if (outcome === 'success') return; // logged in without 2FA — done

  // ── 2FA detected (or we timed out the quick check) ───────────────────────
  console.log('');
  console.log(`  ${platformName}: 2FA / verification required.`);

  const canAutoFill = context && gmailAddress && gmailPassword;

  if (canAutoFill) {
    try {
      const code = await getCodeFromGmail(context, gmailAddress, gmailPassword, platformName);

      // Find the 2FA input on the current page and fill in the code
      const config = PLATFORM_CONFIG[platformName] ?? PLATFORM_CONFIG.TikTok;
      const codeInput = page.locator(config.codeInputSelector).first();
      await codeInput.waitFor({ timeout: 10_000 });
      await codeInput.fill(code);
      await page.waitForTimeout(500);

      // Submit
      const submitBtn = page.locator(config.submitSelector).first();
      const hasSubmit = await submitBtn.isVisible({ timeout: 3_000 }).catch(() => false);
      if (hasSubmit) await submitBtn.click();

      console.log(`  ${platformName}: code submitted automatically.`);
    } catch (err) {
      // Gmail auto-fill failed — fall back to manual
      console.warn(`  ${platformName}: auto-fill failed (${err.message})`);
      console.log(`  ${platformName}: please complete 2FA manually in the browser.`);
      console.log(`  ${platformName}: waiting up to ${Math.round(twoFaWaitMs / 60_000)} minutes...`);
    }
  } else {
    console.log(`  ${platformName}: please complete the verification manually in the browser.`);
    console.log(`  ${platformName}: waiting up to ${Math.round(twoFaWaitMs / 60_000)} minutes...`);
  }

  console.log('');
  await page.waitForURL(url => !isLoginUrl(url), { timeout: twoFaWaitMs });
  console.log(`  ${platformName}: login verified, continuing...`);
}
