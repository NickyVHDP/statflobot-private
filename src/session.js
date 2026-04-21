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

  logger.info('[BROWSER_LAUNCH_STARTING] Launching browser', { headless: config.headless, profile: config.sessionProfileDir });

  // launchPersistentContext keeps session data on disk between runs.
  _context = await chromium.launchPersistentContext(config.sessionProfileDir, {
    headless: config.headless,
    channel: config.browserChannel,
    viewport: { width: 1400, height: 900 },
    // Accept downloads so modal "export" actions don't hang
    acceptDownloads: true,
    // Slow down actions slightly so the SPA can keep up
    slowMo: 100,
  });

  // _context acts as both browser and context for persistent sessions.
  // Expose a dummy _browser reference for close().
  _browser = _context.browser();

  // Reuse existing pages or open a fresh one
  const pages = _context.pages();
  const page  = pages.length > 0 ? pages[0] : await _context.newPage();

  logger.info('[BROWSER_LAUNCHED] Browser launched successfully');
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
