/**
 * src/session.js
 * Manages the Playwright persistent browser context.
 *
 * A persistent context stores cookies, localStorage, and IndexedDB inside
 * ./playwright-profile so your login survives between runs.
 *
 * Usage:
 *   const { launchBrowser, closeBrowser, isLoggedIn, waitForManualLogin } = require('./session');
 *   const { browser, context, page } = await launchBrowser();
 */

'use strict';

const path       = require('path');
const fs         = require('fs');
const readline   = require('readline');
const { chromium } = require('playwright');

const config  = require('./config');
const logger  = require('./logger');

let _browser = null;
let _context = null;

// ─── Profile lock cleanup ────────────────────────────────────────────────────

/**
 * Remove Chromium/Edge lock files left by a crashed or force-killed session.
 *
 * On Windows a stale SingletonLock prevents the next launch from acquiring the
 * profile directory and produces a "ProcessSingleton" startup error. On macOS
 * the same files can appear after an OS-level kill. Removing them before every
 * launch is safe — a running instance always re-creates them instantly.
 */
function cleanProfileLocks(profileDir) {
  const lockNames = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];
  let removed = 0;
  for (const name of lockNames) {
    const p = path.join(profileDir, name);
    try {
      fs.unlinkSync(p);
      removed++;
      logger.info(`[PROFILE_LOCK_REMOVED] ${p}`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn(`[PROFILE_LOCK_WARN] could not remove ${p}: ${err.message}`);
      }
    }
  }
  if (removed > 0) {
    logger.info(`[PROFILE_LOCK_CLEANUP] removed ${removed} stale lock file(s) from ${profileDir}`);
  }
}

// ─── Launch ─────────────────────────────────────────────────────────────────

/**
 * Launch (or reuse) the browser with a persistent profile.
 * Returns { browser, context, page }.
 */
async function launchBrowser() {
  const profileDir = config.sessionProfileDir;
  fs.mkdirSync(profileDir, { recursive: true });

  // Remove any stale Chromium/Edge lock files before attempting launch.
  // Prevents "ProcessSingleton" crashes on Windows when a previous session
  // was force-killed without proper browser teardown.
  cleanProfileLocks(profileDir);

  const channelLabel = config.browserChannel ?? '(bundled chromium)';
  logger.info(`[BROWSER_LAUNCH_STARTING] platform=${process.platform} channel=${channelLabel}`, {
    headless: config.headless,
    profile:  profileDir,
  });

  // Log the bundled Chromium executable path for diagnostics.
  try {
    const execPath = chromium.executablePath();
    logger.info(`[CHROMIUM_EXECUTABLE] bundled path: ${execPath}`);
  } catch { /* not available until playwright >= 1.18 or may throw if not installed */ }

  // Build launch options; only include 'channel' when explicitly set.
  // On Windows channel='msedge' (system Edge); on Mac channel is undefined
  // so playwright uses its own bundled chromium.
  const launchOptions = {
    headless:        config.headless,
    viewport:        { width: 1400, height: 900 },
    acceptDownloads: true,
    slowMo:          100,
  };
  if (config.browserChannel) {
    launchOptions.channel = config.browserChannel;
  }

  // Windows: try msedge → chrome → bundled chromium (in order).
  //   msedge: pre-installed on all Windows 10/11 machines.
  //   chrome: covers machines where Edge was uninstalled by enterprise policy.
  //   undefined: bundled Chromium — last resort if user ran `playwright install`.
  // macOS/Linux: use bundled chromium directly (no channel needed).
  const channelsToTry = process.platform === 'win32'
    ? [config.browserChannel, 'chrome', undefined].filter((c, i, arr) => arr.indexOf(c) === i)
    : [config.browserChannel].filter(Boolean);

  let lastErr;
  for (const ch of channelsToTry.length ? channelsToTry : [undefined]) {
    try {
      const opts = { ...launchOptions };
      if (ch) opts.channel = ch; else delete opts.channel;

      _context = await chromium.launchPersistentContext(profileDir, opts);
      logger.info(`[BROWSER_LAUNCHED] channel=${ch ?? '(bundled chromium)'} profile=${profileDir}`);
      break;
    } catch (err) {
      lastErr = err;
      logger.warn(`[BROWSER_LAUNCH_FAILED] channel=${ch ?? '(bundled)'} — ${err.message}`);

      // If this failure looks like a residual profile lock, clean and continue
      // to the next channel — the lock may have been recreated by a background process.
      if (/ProcessSingleton|SingletonLock|profile.*lock|lock.*profile/i.test(err.message)) {
        logger.warn('[PROFILE_LOCK_RETRY] lock error detected — cleaning locks before next channel attempt');
        cleanProfileLocks(profileDir);
      }
    }
  }

  if (!_context) {
    const hint = process.platform === 'win32'
      ? 'Tried msedge, chrome, and bundled chromium. Ensure Microsoft Edge or Google Chrome is installed, or run "npx playwright install chromium".'
      : 'Run "npm run install-browsers" to install the playwright chromium binary.';
    throw new Error(`[BROWSER_LAUNCH_ERROR] Could not launch any browser. ${hint}\nLast error: ${lastErr?.message}`);
  }

  _browser = _context.browser();
  const pages = _context.pages();
  const page  = pages.length > 0 ? pages[0] : await _context.newPage();

  return { context: _context, page };
}

// ─── Login detection ─────────────────────────────────────────────────────────

/**
 * Navigate to the accounts page and check whether we are already logged in.
 * Returns true if the accounts page loads without a redirect to a login page.
 */
async function isLoggedIn(page) {
  logger.info('[LOGIN_CHECK_STARTING] Checking session validity', { url: config.accountsUrl });
  try {
    await page.goto(config.accountsUrl, { waitUntil: 'domcontentloaded', timeout: config.defaultTimeout });
    // Give the SPA a moment to redirect if auth is required
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    const isOnAccounts = currentUrl.includes('/accounts') || currentUrl.includes(config.accountsUrl);

    if (isOnAccounts) {
      logger.success('Session is valid — already on accounts page');
      return true;
    }

    logger.warn('Session invalid or expired', { redirectedTo: currentUrl });
    return false;
  } catch (err) {
    logger.warn('Session check failed', err);
    return false;
  }
}

// ─── Manual login flow ───────────────────────────────────────────────────────

/**
 * Wait for manual login without requiring terminal ENTER.
 *
 * Emits structured log lines that the dashboard server detects:
 *   "[LOGIN_REQUIRED]" → server emits login:required to frontend
 *   "[LOGIN_DETECTED]" → server emits login:detected to frontend
 *
 * Polls the page URL every 2 s for up to 5 minutes.
 * Works identically for terminal runs (prints instructions) and
 * dashboard runs (the dashboard detects the log markers).
 */
async function waitForManualLogin(page) {
  const border = '═'.repeat(62);
  console.log(`\n${border}`);
  console.log('  ACTION REQUIRED: Manual login needed');
  console.log(border);
  console.log('  1. The Statflo login page should now be open in the browser.');
  console.log('  2. Log in with your credentials.');
  console.log('  3. Wait until the Statflo accounts page has fully loaded.');
  console.log(`${border}\n`);

  logger.info('[LOGIN_REQUIRED] Manual login required');
  logger.info('Waiting for dashboard login completion');

  // Priority order: email/username first (shown first on Okta), then password
  const LOGIN_FIELD_SELECTORS = [
    '#okta-signin-username',
    'input[type="email"]',
    'input[name="username"]',
    'input[name="email"]',
    'input[autocomplete="username"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="user" i]',
    '#okta-signin-password',
    'input[type="password"]',
    'input[autocomplete="current-password"]',
  ];

  const POLL_INTERVAL_MS = 2000;
  const TIMEOUT_MS       = 5 * 60 * 1000; // 5 minutes
  const deadline         = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (page.isClosed()) {
      logger.warn('[LOGIN_TIMEOUT] browser page closed during login wait — stopping');
      throw new Error('Browser was closed while waiting for login. Please restart the run.');
    }

    const currentUrl = page.url();
    const onAccounts =
      currentUrl.includes('/accounts') ||
      currentUrl.includes('/t/conversations') ||
      (currentUrl.includes('statflo.com') && !currentUrl.includes('/login'));

    if (onAccounts) {
      logger.info('[LOGIN_DETECTED] Login detected — resuming run');
      logger.success('Login confirmed — accounts page detected');
      return true;
    }

    // Continuous focus correction: on every poll while the login/Okta page is visible,
    // check whether a valid input has focus. If not, click the best visible input.
    // This prevents keystrokes from going to the URL bar when Playwright navigation
    // leaves focus on the address bar (common Windows Playwright behaviour).
    const onLoginPage =
      currentUrl.includes('/login') ||
      currentUrl.includes('okta') ||
      currentUrl.includes('/signin') ||
      currentUrl.includes('/auth/');

    if (onLoginPage) {
      logger.info(`[LOGIN_FOCUS_LOOP] on login page — checking input focus url=${currentUrl}`);
      try {
        const activeIsInput = await page.evaluate(() => {
          const el = document.activeElement;
          return !!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.type !== 'hidden');
        }).catch(() => false);

        if (!activeIsInput) {
          logger.info('[LOGIN_URL_BAR_PROTECTION_RETRY] activeElement is not a visible input — attempting focus correction');
          for (const sel of LOGIN_FIELD_SELECTORS) {
            try {
              const el = await page.$(sel);
              if (!el) continue;
              const visible = await el.isVisible().catch(() => false);
              if (!visible) continue;
              logger.info(`[LOGIN_FIELD_CANDIDATE] trying selector=${sel}`);
              await el.click({ timeout: 1500 });
              const isActive = await page.evaluate(
                el => document.activeElement === el, el
              ).catch(() => false);
              if (isActive) {
                logger.info(`[LOGIN_FIELD_ACTIVE_OK] selector=${sel} is now the active element — keystrokes will go to login input`);
                break;
              } else {
                logger.warn(`[LOGIN_FIELD_ACTIVE_BAD] clicked ${sel} but activeElement is still something else — trying next`);
              }
            } catch { /* field not found or click timed out — try next */ }
          }
        } else {
          logger.info('[LOGIN_FOCUS_LOOP] activeElement is already a valid input — no correction needed');
        }
      } catch { /* focus check failed — non-fatal, continue polling */ }
    }

    await page.waitForTimeout(POLL_INTERVAL_MS);
  }

  throw new Error(
    'Login not detected after 5 minutes. ' +
    'Please log in to Statflo in the browser and restart the run.'
  );
}

// ─── Teardown ────────────────────────────────────────────────────────────────

async function closeBrowser() {
  if (_context) {
    await _context.close().catch(() => {});
    _context = null;
  }
  _browser = null;
  logger.info('Browser closed');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Pause and wait for the user to press ENTER in the terminal.
 * @param {string} [prompt]
 */
function pressEnterToContinue(prompt = 'Press ENTER to continue…') {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

module.exports = { launchBrowser, isLoggedIn, waitForManualLogin, closeBrowser, pressEnterToContinue };
