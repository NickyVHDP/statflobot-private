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

const path         = require('path');
const fs           = require('fs');
const http         = require('http');
const readline     = require('readline');
const { chromium } = require('playwright');

const config  = require('./config');
const logger  = require('./logger');

let _browser        = null;
let _context        = null;
let _isEmbeddedMode = false;

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

// ─── Embedded browser (CDP proxy) launch ────────────────────────────────────

async function _launchBrowserCDP(endpoint) {
  if (!endpoint) throw new Error('[EMBEDDED_BROWSER] EMBEDDED_BROWSER_WS_ENDPOINT not set');
  logger.info(`[EMBEDDED_BROWSER_CONNECT] connecting to CDP proxy at ${endpoint}`);
  logger.info(`[BROWSER_ENGINE_SELECTED] engine=electron-embedded platform=${process.platform}`);

  const browser = await chromium.connectOverCDP(endpoint, { timeout: 30000 });
  logger.info('[EMBEDDED_BROWSER_CDP_CONNECTED] connectOverCDP succeeded');

  // Poll for contexts — the proxy's auto-attach is async; contexts may not be
  // visible immediately after connectOverCDP resolves.
  let ctx = null;
  let page = null;
  for (let i = 0; i < 15; i++) {
    const contexts = browser.contexts();
    logger.info(`[EMBEDDED_CONTEXT_POLL] attempt=${i + 1} contexts=${contexts.length}`);
    for (const c of contexts) {
      const pages = c.pages();
      logger.info(`[EMBEDDED_CONTEXT_POLL] context pages=${pages.length} urls=${JSON.stringify(pages.map(p => p.url()))}`);
      if (pages.length > 0) { ctx = c; page = pages[0]; break; }
    }
    if (ctx) break;
    await new Promise(r => setTimeout(r, 200));
  }

  if (!ctx) {
    const ctxCount = browser.contexts().length;
    throw new Error(`[EMBEDDED_BROWSER] no context with pages after 15 polls (${ctxCount} contexts found — proxy may not have announced target)`);
  }

  const url = page.url();
  // Reject if we accidentally got the main renderer (localhost) — proxy should never expose it
  if (url.includes('localhost') || url.includes('127.0.0.1')) {
    logger.warn(`[EMBEDDED_TARGET_REJECTED] page url is localhost: "${url}"`);
    await browser.close().catch(() => {});
    throw new Error('[EMBEDDED_TARGET_REJECTED] wrong page selected — localhost leaked through proxy');
  }
  logger.info(`[EMBEDDED_TARGET_VERIFIED] page url="${url}"`);

  _context        = ctx;
  _isEmbeddedMode = true;

  // Close any extra pages left in the automation context
  for (const p of ctx.pages()) {
    if (p !== page) {
      logger.info(`[DUPLICATE_PAGE_CLOSED] closing extra page url=${p.url()}`);
      await p.close().catch(() => {});
    }
  }

  // Register duplicate page handler
  logger.info('[DUPLICATE_PAGE_HANDLER_RESET] registering duplicate-page handler for embedded context');
  ctx.on('page', (newPage) => {
    logger.info(`[DUPLICATE_PAGE_DETECTED] new page opened url=${newPage.url()}`);
    setTimeout(async () => {
      try {
        const u = newPage.url();
        const isStatfloOrOkta =
          u.includes('statflo.com') || u.includes('okta.com') ||
          u.includes('cellularsales') || u === 'about:blank';
        if (!isStatfloOrOkta) {
          logger.info(`[DUPLICATE_PAGE_CLOSED] non-Statflo page closed url=${u}`);
          await newPage.close().catch(() => {});
        } else {
          logger.info(`[DUPLICATE_PAGE_DETECTED] keeping Statflo/Okta page url=${u}`);
        }
      } catch { /* non-fatal */ }
    }, 800);
  });

  // Clear Statflo/Okta session cookies
  logger.info('[STATFLO_SESSION_RESET_START] clearing Statflo/Okta cookies (embedded mode)');
  logger.info('[LOGIN_SINGLE_PAGE_MODE] using main page for auth cleanup — no extra tab created');
  try {
    await ctx.clearCookies();
    logger.info('[STATFLO_SESSION_RESET] cookies cleared');
  } catch (err) {
    logger.warn(`[STATFLO_SESSION_RESET] clearCookies failed: ${err.message}`);
  }
  logger.info('[AUTH_CLEANUP_DONE] cookies cleared; navigating directly to Statflo login');

  // Navigate to Statflo login
  logger.info('[LOGIN_NAV_START] starting navigation to Statflo login (embedded mode)');
  let _loginNavUrl;
  try { _loginNavUrl = new URL(config.accountsUrl); } catch { _loginNavUrl = null; }
  logger.info(`[LOGIN_NAV_REDIRECT] host=${_loginNavUrl?.hostname ?? config.accountsUrl} path=${_loginNavUrl?.pathname ?? ''}`);
  await page.goto(config.accountsUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(e => {
    logger.warn(`[LOGIN_NAV_FAILED] goto error: ${e.message}`);
  });
  logger.info(`[LOGIN_NAV_FINAL] url=${page.url()}`);
  logger.info('[STATFLO_SESSION_RESET_DONE] cookies cleared; login required for this run');
  logger.info(`[EMBEDDED_BROWSER_CONNECTED] automation page ready endpoint=${endpoint}`);

  return { context: ctx, page };
}

// ─── Launch ─────────────────────────────────────────────────────────────────

/**
 * Launch (or reuse) the browser.
 * In embedded mode (EMBEDDED_BROWSER_MODE=true): connects to Electron's Chromium via CDP.
 * Fallback and default: launchPersistentContext with a local profile directory.
 * Returns { browser, context, page }.
 */
async function launchBrowser() {
  logger.info(`[BROWSER_ENV] EMBEDDED_BROWSER_MODE=${process.env.EMBEDDED_BROWSER_MODE ?? '(not set)'} EMBEDDED_BROWSER_WS_ENDPOINT=${process.env.EMBEDDED_BROWSER_WS_ENDPOINT ?? '(not set)'}`);

  if (process.env.EMBEDDED_BROWSER_MODE === 'true') {
    const endpoint = process.env.EMBEDDED_BROWSER_WS_ENDPOINT;
    logger.info(`[BROWSER_MODE] embedded=true endpoint=${endpoint || '(not set)'}`);
    try {
      return await _launchBrowserCDP(endpoint);
    } catch (err) {
      logger.warn(`[EMBEDDED_BROWSER_CONNECT_FAILED] ${err.message}`);
      logger.warn(`[EMBEDDED_BROWSER_FALLBACK_USED] embedded connect failed — falling back to external browser`);
    }
  }

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

  // Windows: try chrome → msedge → bundled chromium (in order).
  //   chrome: preferred when installed — looks native, not branded as Microsoft Edge.
  //   msedge: always pre-installed on Windows 10/11 — reliable fallback.
  //   undefined: bundled Chromium — last resort if user ran `playwright install`.
  // macOS/Linux: use bundled chromium directly (no channel needed).
  const channelsToTry = process.platform === 'win32'
    ? ['chrome', 'msedge', undefined]
    : [config.browserChannel].filter(Boolean);

  let lastErr;
  for (const ch of channelsToTry.length ? channelsToTry : [undefined]) {
    try {
      const opts = { ...launchOptions };
      if (ch) opts.channel = ch; else delete opts.channel;

      _context = await chromium.launchPersistentContext(profileDir, opts);
      logger.info(`[BROWSER_LAUNCHED] channel=${ch ?? '(bundled chromium)'} profile=${profileDir}`);
      logger.info(`[BROWSER_ENGINE_SELECTED] engine=${ch ?? 'bundled-chromium'} platform=${process.platform}`);
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
      ? 'Tried Chrome, Microsoft Edge, and bundled chromium. Ensure Google Chrome or Microsoft Edge is installed, or run "npx playwright install chromium".'
      : 'Run "npm run install-browsers" to install the playwright chromium binary.';
    throw new Error(`[BROWSER_LAUNCH_ERROR] Could not launch any browser. ${hint}\nLast error: ${lastErr?.message}`);
  }

  _browser = _context.browser();
  const pages = _context.pages();

  logger.info(`[BROWSER_CONTEXT_CREATED] persistentContext ready; existing pages=${pages.length}`);

  // Select the primary page (first existing page, or open a new one).
  const page = pages.length > 0 ? pages[0] : await _context.newPage();
  logger.info(`[PAGE_SELECTED] url=${page.url()}`);

  // Close any extra pages left over from a previous session.
  for (let i = 1; i < pages.length; i++) {
    logger.info(`[DUPLICATE_PAGE_CLOSED] closing extra page url=${pages[i].url()}`);
    await pages[i].close().catch(() => {});
  }

  // Watch for new pages that open during login (e.g. SSO pop-ups, Edge new-tab).
  // Keep only the most recent Statflo/Okta page; close everything else.
  // Registered once per launchBrowser() call — _context is fresh each run.
  logger.info('[DUPLICATE_PAGE_HANDLER_RESET] registering duplicate-page handler for this context');
  _context.on('page', (newPage) => {
    logger.info(`[DUPLICATE_PAGE_DETECTED] new page opened url=${newPage.url()}`);
    // Give the page a moment to navigate before checking its URL.
    setTimeout(async () => {
      try {
        const url = newPage.url();
        const isStatfloOrOkta =
          url.includes('statflo.com') ||
          url.includes('okta.com') ||
          url.includes('cellularsales') ||
          url === 'about:blank';
        if (!isStatfloOrOkta) {
          logger.info(`[DUPLICATE_PAGE_CLOSED] non-Statflo page closed url=${url}`);
          await newPage.close().catch(() => {});
        } else {
          logger.info(`[DUPLICATE_PAGE_DETECTED] keeping Statflo/Okta page url=${url}`);
        }
      } catch { /* non-fatal */ }
    }, 800);
  });

  // ── Clear Statflo/Okta auth cookies before every run ─────────────────────────
  // Clearing session cookies is sufficient to force fresh Okta login.
  // Stale localStorage tokens cannot re-authenticate without valid session cookies,
  // so per-origin storage traversal is unnecessary and only caused visible
  // intermediate error/blank pages before the login screen appeared.
  logger.info('[STATFLO_SESSION_RESET_START] clearing Statflo/Okta cookies');
  logger.info('[LOGIN_SINGLE_PAGE_MODE] using main page for auth cleanup — no extra tab created');
  if (process.platform === 'win32') {
    logger.info('[WINDOWS_DUPLICATE_PAGE_PREVENTED] single-tab cleanup path active');
  }
  try {
    await _context.clearCookies();
    logger.info('[STATFLO_SESSION_RESET] cookies cleared');
  } catch (err) {
    logger.warn(`[STATFLO_SESSION_RESET] clearCookies failed: ${err.message}`);
  }
  logger.info('[AUTH_CLEANUP_DONE] cookies cleared; navigating directly to Statflo login');

  // Navigate directly to Statflo — Okta detects missing session cookie and
  // redirects to the login page.  No intermediate origins need to be visited.
  logger.info('[LOGIN_NAV_START] starting direct navigation to Statflo login');
  let _loginNavUrl;
  try { _loginNavUrl = new URL(config.accountsUrl); } catch { _loginNavUrl = null; }
  logger.info(`[LOGIN_NAV_REDIRECT] host=${_loginNavUrl?.hostname ?? config.accountsUrl} path=${_loginNavUrl?.pathname ?? ''}`);
  await page.goto(config.accountsUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch((e) => {
    logger.warn(`[LOGIN_NAV_FAILED] goto error: ${e.message}`);
  });
  const _navFinalUrl = page.url();
  let _navFinalHost = _navFinalUrl, _navFinalPath = '';
  try { const u = new URL(_navFinalUrl); _navFinalHost = u.hostname; _navFinalPath = u.pathname; } catch { /* keep raw */ }
  logger.info(`[LOGIN_NAV_FINAL] host=${_navFinalHost} path=${_navFinalPath}`);
  if (_navFinalHost !== (_loginNavUrl?.hostname ?? '') && _navFinalHost !== 'about:blank') {
    logger.info(`[LOGIN_NAV_EXTRA_HOP] redirected from ${_loginNavUrl?.hostname ?? config.accountsUrl} → ${_navFinalHost}`);
  }
  logger.info('[STATFLO_SESSION_RESET_DONE] cookies cleared; login required for this run');

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

// ─── Login cancel error ──────────────────────────────────────────────────────

class LoginCancelledError extends Error {
  constructor() {
    super('Login cancelled — browser was closed by the user.');
    this.name = 'LoginCancelledError';
  }
}

// ─── Login helpers ────────────────────────────────────────────────────────────

async function safeWait(page, ms) {
  if (!page || page.isClosed()) return false;
  try {
    await page.waitForTimeout(ms);
    return true;
  } catch {
    return false;
  }
}

/**
 * Focus a login field exactly once. Only focus+click — never select(), never Tab.
 * Skips entirely if activeElement is already a valid input (user is already typing).
 */
async function focusLoginFieldOnce(page, selectors) {
  if (!page || page.isClosed()) return false;
  logger.info('[LOGIN_FOCUS_ONCE_START]');
  try {
    const alreadyFocused = await page.evaluate(() => {
      const el = document.activeElement;
      return !!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') &&
        el.type !== 'hidden' && el.offsetParent !== null);
    }).catch(() => false);

    if (alreadyFocused) {
      logger.info('[LOGIN_FOCUS_ONCE_SKIPPED_ACTIVE_INPUT]');
      return true;
    }

    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        const visible = await loc.isVisible().catch(() => false);
        if (!visible) continue;
        // Focus + click only — no select(), no keyboard simulation
        await page.evaluate((s) => {
          const el = document.querySelector(s);
          if (el) { el.focus(); el.click(); }
        }, sel).catch(() => {});
        logger.info(`[LOGIN_FOCUS_ONCE_SUCCESS] selector="${sel}"`);
        return true;
      } catch { /* try next selector */ }
    }
    logger.warn('[LOGIN_FOCUS_ONCE_FAILED]');
    return false;
  } catch {
    logger.warn('[LOGIN_FOCUS_ONCE_FAILED]');
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
  logger.info('[LOGIN_WAITING_FOR_USER] Please finish logging into Statflo.');

  const PASS_SELECTORS = [
    'input[name="credentials.passcode"]',
    '#input36',
    'input.password-with-toggle',
    'input[type="password"][autocomplete="current-password"]',
  ];
  const USER_SELECTORS = [
    'input[name="identifier"]',
    'input[autocomplete="username"]',
  ];

  const OAUTH_PATHS = ['/oauth', '/authorize', '/callback', '/sso', '/saml', 'okta.com', '/login', '/signin', '/auth/'];

  const POLL_INTERVAL_MS = 2000;
  const TIMEOUT_MS       = 5 * 60 * 1000;
  const deadline         = Date.now() + TIMEOUT_MS;

  let capturedLoginUsername  = null;
  let hasFocusedUsernameStep = false;
  let hasFocusedPasswordStep = false;
  let lastLoginUrl           = '';

  while (Date.now() < deadline) {
    if (!page || page.isClosed()) {
      logger.info('[LOGIN_CANCELLED_BY_USER] browser was closed during login wait');
      throw new LoginCancelledError();
    }

    const currentUrl = page.url();
    const onAccounts =
      currentUrl.includes('/accounts') ||
      currentUrl.includes('/t/conversations');

    if (onAccounts) {
      logger.info('[LOGIN_DETECTED] Login detected — accounts page confirmed');
      logger.info('[STATFLO_AUTH_PAGE_CONFIRMED] page URL is on authenticated Statflo route');
      logger.success('Login confirmed — accounts page detected');
      if (capturedLoginUsername) {
        logger.info(`[STATFLO_LOGIN_USERNAME_CAPTURED] raw=${capturedLoginUsername}`);
      }
      // Settle delay: Okta writes idToken/accessToken to localStorage AFTER the
      // final redirect lands on /accounts. Waiting here ensures detectStatfloIdentity
      // reads a populated token store rather than an empty one.
      logger.info('[STATFLO_IDENTITY_CHECK_DELAY_AFTER_LOGIN] waiting 3 s for Okta token storage to settle…');
      await safeWait(page, 3000);
      return capturedLoginUsername || null;
    }

    const onLoginPage = OAUTH_PATHS.some(p => currentUrl.includes(p));
    if (onLoginPage) {
      logger.info(`[LOGIN_PAGE_DETECTED] url=${currentUrl}`);

      // Reset per-step focus flags when the URL changes (e.g. username→password step nav)
      if (currentUrl !== lastLoginUrl) {
        hasFocusedUsernameStep = false;
        hasFocusedPasswordStep = false;
        let _hopHost = currentUrl, _hopPath = '';
        try { const u = new URL(currentUrl); _hopHost = u.hostname; _hopPath = u.pathname; } catch { /* keep raw */ }
        logger.info(`[LOGIN_NAV_EXTRA_HOP] login page navigation: host=${_hopHost} path=${_hopPath}`);
        lastLoginUrl = currentUrl;
      }

      // Snapshot field visibility — single evaluate, no side effects
      const ps = await page.evaluate((pSels, uSels) => {
        const getVisible = (sels) => sels.map(s => document.querySelector(s))
          .find(el => el && el.offsetParent !== null && !el.disabled);
        const passEl = getVisible(pSels);
        const userEl = getVisible(uSels);
        return { passVisible: !!passEl, userVisible: !!userEl };
      }, PASS_SELECTORS, USER_SELECTORS).catch(() => ({ passVisible: false, userVisible: false }));

      // One-time focus per step — never repeat after flag is set
      if (ps.passVisible && !hasFocusedPasswordStep) {
        hasFocusedPasswordStep = true;
        await focusLoginFieldOnce(page, PASS_SELECTORS);
      } else if (!ps.passVisible && ps.userVisible && !hasFocusedUsernameStep) {
        hasFocusedUsernameStep = true;
        await focusLoginFieldOnce(page, USER_SELECTORS);
      }

      // Always capture typed username value (read-only, non-destructive)
      try {
        const typedUsername = await page.evaluate(() => {
          const el =
            document.querySelector('input[name="identifier"]') ||
            document.querySelector('input[autocomplete="username"]');
          return el ? (el.value || '').trim() : '';
        }).catch(() => '');
        if (typedUsername.length >= 3) capturedLoginUsername = typedUsername;
      } catch { /* non-fatal */ }
    }

    const ok = await safeWait(page, POLL_INTERVAL_MS);
    if (!ok) {
      logger.info('[LOGIN_WAIT_ABORTED_PAGE_CLOSED]');
      logger.info('[LOGIN_CANCELLED_BY_USER] browser closed during login wait');
      throw new LoginCancelledError();
    }
  }

  throw new Error(
    'Login not detected after 5 minutes. ' +
    'Please log in to Statflo in the browser and restart the run.'
  );
}

// ─── Teardown ────────────────────────────────────────────────────────────────

async function closeBrowser() {
  if (_isEmbeddedMode) {
    // In embedded mode do NOT close the context — it would destroy the Electron BrowserView.
    // Instead navigate back to blank so the panel shows the idle placeholder.
    if (_context) {
      const pages = _context.pages();
      for (const p of pages) {
        try { await p.goto('about:blank', { timeout: 3000 }); } catch { /* non-fatal */ }
      }
      _context = null;
    }
    _isEmbeddedMode = false;
    _browser = null;
    logger.info('[EMBEDDED_BROWSER_RESET] automation view reset to blank');
    return;
  }

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

// ─── Statflo identity detection ──────────────────────────────────────────────

/**
 * Detect the logged-in Statflo username/email from the current browser session.
 *
 * Strategy (in order of reliability):
 *   1. Okta idToken / accessToken in localStorage — the most reliable source;
 *      available on any authenticated Statflo page, no UI selector needed.
 *   2. Common DOM elements that show the user's email in the nav/profile area.
 *
 * Returns the lowercased, trimmed email string, or null if detection fails.
 * Read-only — never sends or types anything.
 */
async function detectStatfloIdentity(page) {
  if (!page || page.isClosed()) return null;

  const currentUrl = page.url();
  logger.info(`[STATFLO_IDENTITY_DETECT_URL] url=${currentUrl}`);

  // Method 1: Okta token storage in localStorage then sessionStorage.
  // Returns email (first.last@cellularsales.com) or username (first.last).
  // Try sessionStorage too — some Okta configs write there instead of localStorage.
  try {
    const fromOkta = await page.evaluate(() => {
      try {
        const raw =
          localStorage.getItem('okta-token-storage') ||
          sessionStorage.getItem('okta-token-storage');
        if (!raw) return null;
        const storage = JSON.parse(raw);
        return (
          storage?.idToken?.claims?.email ||
          storage?.idToken?.claims?.preferred_username ||
          storage?.accessToken?.claims?.email ||
          storage?.accessToken?.claims?.preferred_username ||
          null
        );
      } catch { return null; }
    });
    if (fromOkta) {
      const val = String(fromOkta).trim();
      if (val.length >= 3) {
        logger.info(`[STATFLO_IDENTITY_DETECTED] source=okta-token-storage val=${val}`);
        return val;
      }
    }
  } catch { /* storage unavailable on this page */ }

  // Method 2: DOM selectors for user info elements
  const DOM_SELECTORS = [
    '[data-testid="user-email"]',
    '[data-testid="current-user-email"]',
    '[data-testid="nav-user-email"]',
    '.user-email',
    '[class*="user-info"] [class*="email"]',
    '[aria-label*="@"]',
  ];

  for (const sel of DOM_SELECTORS) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const text = (await el.textContent().catch(() => '')) || '';
      if (text.includes('@')) {
        const match = text.match(/[\w.+%-]+@[\w.-]+\.[a-z]{2,}/i);
        if (match) {
          logger.info(`[STATFLO_IDENTITY_DETECTED] source=dom-selector sel=${sel} val=${match[0]}`);
          return match[0].toLowerCase();
        }
      }
    } catch { /* try next */ }
  }

  // Method 3: Full-page text scan for email pattern — catches inline user badges
  try {
    const fromText = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const matches = text.match(/[\w.+%-]+@[\w.-]+\.[a-z]{2,}/gi);
      if (!matches) return null;
      // Prefer @cellularsales.com addresses — the Statflo identity domain
      const cs = matches.find(m => m.toLowerCase().includes('@cellularsales.com'));
      return cs || matches[0];
    });
    if (fromText) {
      const val = String(fromText).trim().toLowerCase();
      if (val.length >= 3) {
        logger.info(`[STATFLO_IDENTITY_DETECTED] source=page-text-scan val=${val}`);
        return val;
      }
    }
  } catch { /* page text unavailable */ }

  logger.warn(`[STATFLO_IDENTITY_DETECT_FAILED] could not extract identity from url=${currentUrl}`);
  return null;
}

// ─── Authenticated page guard ────────────────────────────────────────────────

/**
 * Polls until the page URL is on a confirmed authenticated Statflo route
 * (/accounts or /t/conversations) and NOT on any login/OAuth intermediate page.
 *
 * Used after waitForManualLogin() and after isLoggedIn() returns true to ensure
 * detectStatfloIdentity() always runs on a real authenticated page, never on an
 * OAuth callback or SSO redirect page where the Okta token may not yet be stored.
 *
 * Returns true when confirmed, false on timeout.
 */
async function waitForAuthenticatedStatfloPage(page, timeoutMs = 15_000) {
  if (!page || page.isClosed()) return false;
  const LOGIN_PATHS = ['/oauth', '/authorize', '/callback', '/sso', '/saml', 'okta.com', '/login', '/signin', '/auth/'];
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (page.isClosed()) return false;
    const url = page.url();
    const isConfirmed =
      (url.includes('/accounts') || url.includes('/t/conversations')) &&
      !LOGIN_PATHS.some(p => url.includes(p));
    if (isConfirmed) {
      logger.info(`[STATFLO_AUTH_PAGE_CONFIRMED] confirmed on authenticated Statflo page url=${url}`);
      return true;
    }
    await page.waitForTimeout(500);
  }

  logger.warn(`[STATFLO_AUTH_PAGE_TIMEOUT] timed out waiting for authenticated Statflo page — url=${page.isClosed() ? '(closed)' : page.url()}`);
  return false;
}

module.exports = { launchBrowser, isLoggedIn, waitForManualLogin, waitForAuthenticatedStatfloPage, closeBrowser, pressEnterToContinue, detectStatfloIdentity, LoginCancelledError };
