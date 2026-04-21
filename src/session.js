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

// ─── Launch ─────────────────────────────────────────────────────────────────

/**
 * Launch (or reuse) the browser with a persistent profile.
 * Returns { browser, context, page }.
 */
async function launchBrowser() {
  fs.mkdirSync(config.sessionProfileDir, { recursive: true });

  const channelLabel = config.browserChannel ?? '(bundled chromium)';
  logger.info(`[BROWSER_LAUNCH_STARTING] Launching browser — channel: ${channelLabel}`, {
    headless: config.headless,
    profile:  config.sessionProfileDir,
    platform: process.platform,
  });

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

  // On Windows, if the primary channel (msedge) is not found, fall back to
  // system Chrome before giving up.  This covers the rare case where Edge has
  // been uninstalled or moved by enterprise policy.
  const channelsToTry = process.platform === 'win32'
    ? [config.browserChannel, 'chrome'].filter(Boolean)
    : [config.browserChannel].filter(Boolean);  // undefined → empty → no retry

  let lastErr;
  for (const ch of channelsToTry.length ? channelsToTry : [undefined]) {
    try {
      const opts = { ...launchOptions };
      if (ch) opts.channel = ch; else delete opts.channel;

      _context = await chromium.launchPersistentContext(config.sessionProfileDir, opts);
      logger.info(`[BROWSER_LAUNCHED] Browser launched via channel: ${ch ?? '(bundled chromium)'}`);
      break;
    } catch (err) {
      lastErr = err;
      logger.warn(`[BROWSER_LAUNCH_FAILED] channel=${ch ?? '(bundled)'} — ${err.message}`);
    }
  }

  if (!_context) {
    const hint = process.platform === 'win32'
      ? 'Tried msedge and chrome — ensure Microsoft Edge or Google Chrome is installed on this machine.'
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

  // Emit a machine-readable marker that the dashboard server parses.
  logger.info('[LOGIN_REQUIRED] Manual login required');
  logger.info('Waiting for dashboard login completion');

  const POLL_INTERVAL_MS = 2000;
  const TIMEOUT_MS       = 5 * 60 * 1000; // 5 minutes
  const deadline         = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
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
