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

  // ── Clear Statflo/Okta auth cookies and storage before every run ─────────────
  // Forces a fresh login so the current Statflo username can always be captured
  // and compared against the locked identity.
  // NOTE: Only clears browser auth — does NOT touch the local statflo-identity.json.
  logger.info('[STATFLO_SESSION_RESET_START] clearing Statflo/Okta cookies and storage');
  const AUTH_ORIGINS = [
    'https://csok.app.us.statflo.com',
    'https://cellularsales.okta.com',
    'https://sso.us.statflo.com',
    'https://www.statflo.com',
    'https://app.statflo.com',
  ];
  try {
    await _context.clearCookies();
    logger.info('[STATFLO_SESSION_RESET] cookies cleared');
  } catch (err) {
    logger.warn(`[STATFLO_SESSION_RESET] clearCookies failed: ${err.message}`);
  }
  // Use a hidden background page so the user never sees storage-clearing navigations.
  // The main visible page stays clean and navigates to the login URL after cleanup.
  let _cleanupPage = null;
  try {
    _cleanupPage = await _context.newPage();
    logger.info('[AUTH_CLEANUP_PAGE_CREATED] hidden cleanup page opened for storage clearing');
    for (const origin of AUTH_ORIGINS) {
      try {
        await _cleanupPage.goto(origin, { waitUntil: 'commit', timeout: 8000 }).catch(() => {});
        await _cleanupPage.evaluate(() => {
          try { localStorage.clear(); } catch { /* cross-origin guard */ }
          try { sessionStorage.clear(); } catch { /* cross-origin guard */ }
        }).catch(() => {});
      } catch { /* unreachable origin — skip */ }
    }
  } finally {
    if (_cleanupPage) await _cleanupPage.close().catch(() => {});
    logger.info('[AUTH_CLEANUP_DONE] hidden cleanup page closed; auth storage cleared');
  }
  // Navigate main page directly to Statflo so user sees the login screen immediately.
  logger.info('[LOGIN_FLOW_START] navigating main page to Statflo login');
  await page.goto(config.accountsUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  logger.info('[STATFLO_SESSION_RESET_DONE] auth storage cleared; login required for this run');

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

  // Okta-specific selectors — password first (step 2), username second (step 1).
  // Not used for iteration; kept for Tab fallback reference only.
  // Primary focus is done via DOM evaluate below.
  const LOGIN_FIELD_SELECTORS = [
    'input[name="credentials.passcode"]',
    'input[type="password"][autocomplete="current-password"]',
    'input.password-with-toggle',
    'input[name="identifier"]',
    'input[autocomplete="username"]',
  ];

  const POLL_INTERVAL_MS = 2000;
  const TIMEOUT_MS       = 5 * 60 * 1000; // 5 minutes
  const deadline         = Date.now() + TIMEOUT_MS;

  // Paths that indicate an OAuth/SSO intermediate redirect — not yet on the
  // authenticated Statflo app. waitForManualLogin must NOT return on these.
  const OAUTH_PATHS = ['/oauth', '/authorize', '/callback', '/sso', '/saml', 'okta.com', '/login', '/signin', '/auth/'];

  let capturedLoginUsername = null;
  let lastFocusedSelector   = null;
  let lastFocusTimestamp    = 0;
  const FOCUS_COOLDOWN_MS   = 4000;

  while (Date.now() < deadline) {
    if (page.isClosed()) {
      logger.warn('[LOGIN_TIMEOUT] browser page closed during login wait — stopping');
      throw new Error('Browser was closed while waiting for login. Please restart the run.');
    }

    const currentUrl = page.url();

    // Only consider login complete when on a confirmed authenticated Statflo page.
    // The loose "statflo.com && not /login" check was too permissive — it matched
    // OAuth callback and SSO redirect pages that appear BEFORE the accounts page,
    // causing detectStatfloIdentity to run before the Okta token was persisted.
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
      await page.waitForTimeout(3000);
      return capturedLoginUsername || null;
    }

    // State-aware focus controller v2:
    // Respects user typing, applies cooldown, handles username→password transition.
    const onLoginPage = OAUTH_PATHS.some(p => currentUrl.includes(p));

    if (onLoginPage) {
      logger.info(`[LOGIN_PAGE_DETECTED] url=${currentUrl}`);
      try {
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
        const ALL_SELECTORS = [...PASS_SELECTORS, ...USER_SELECTORS];

        const now = Date.now();
        const elapsed = now - lastFocusTimestamp;

        // ── Cooldown guard ──────────────────────────────────────────────────────
        if (elapsed < FOCUS_COOLDOWN_MS) {
          logger.info(`[LOGIN_FOCUS_COOLDOWN_SKIP] ${elapsed}ms since last attempt — skipping (cooldown ${FOCUS_COOLDOWN_MS}ms)`);
          // Still capture username value below — fall through to capture block.
        } else {
          // ── Snapshot page state in one evaluate call ──────────────────────────
          const ps = await page.evaluate((pSels, uSels) => {
            const getVisible = (sels) => sels.map(s => document.querySelector(s))
              .find(el => el && el.offsetParent !== null && !el.disabled);
            const passEl = getVisible(pSels);
            const userEl = getVisible(uSels);
            const active = document.activeElement;
            const activeIsInput = !!(active && active.tagName === 'INPUT' && active.type !== 'hidden' && active.offsetParent !== null);
            return {
              passVisible:    !!passEl,
              passEmpty:      !passEl || passEl.value.length === 0,
              userVisible:    !!userEl,
              userHasText:    userEl ? userEl.value.length > 0 : false,
              activeIsInput,
              activeHasValue: activeIsInput ? active.value.length > 0 : false,
              windowFocused:  document.hasFocus(),
            };
          }, PASS_SELECTORS, USER_SELECTORS).catch(() => ({
            passVisible: false, passEmpty: true,
            userVisible: false, userHasText: false,
            activeIsInput: false, activeHasValue: false,
            windowFocused: false,
          }));

          // Bring page to front ONLY if window is not already focused
          if (!ps.windowFocused) {
            await page.bringToFront().catch(() => {});
          } else {
            logger.info('[LOGIN_WINDOW_ALREADY_FOCUSED]');
          }

          // ── Decide focus action based on field state ─────────────────────────

          if (!ps.passEmpty && ps.userHasText) {
            // Both fields have content — user is done, leave alone
            logger.info('[LOGIN_FOCUS_ALREADY_SATISFIED] both fields have content — not interfering');

          } else if (ps.activeIsInput && ps.activeHasValue) {
            // Active element is a valid input with text — user is typing
            logger.info('[LOGIN_ACTIVE_INPUT_VALID] active input has content — skipping refocus');

          } else if (ps.userHasText && ps.passVisible && ps.passEmpty) {
            // Username typed, password field appeared and is empty — transition to it
            logger.info('[LOGIN_PASSWORD_TRANSITION] username filled, password visible and empty — focusing password');
            let transitioned = false;
            for (const sel of PASS_SELECTORS) {
              try {
                const loc = page.locator(sel).first();
                const visible = await loc.isVisible().catch(() => false);
                if (!visible) continue;
                await loc.click({ force: true }).catch(() => {});
                await loc.focus().catch(() => {});
                // Never select() on password — just focus+click
                await page.evaluate(s => {
                  const el = document.querySelector(s);
                  if (el) { el.focus(); el.click(); }
                }, sel).catch(() => {});
                lastFocusedSelector = sel;
                lastFocusTimestamp  = now;
                logger.info(`[LOGIN_PASSWORD_FIELD_FOCUSED_ONCE] selector="${sel}"`);
                transitioned = true;
                break;
              } catch { /* try next selector */ }
            }
            if (!transitioned) {
              logger.warn('[LOGIN_FOCUS_FAILED] password transition — no visible password field');
            }

          } else if (!ps.userHasText && ps.passEmpty) {
            // Nothing filled yet — focus the first available field (password-first)
            logger.info('[LOGIN_FOCUS_FORCE_START] no content in fields — attempting initial focus');
            let focused = false;
            for (const sel of ALL_SELECTORS) {
              try {
                const loc = page.locator(sel).first();
                const visible = await loc.isVisible().catch(() => false);
                if (!visible) continue;
                const isPasswordField = PASS_SELECTORS.includes(sel);
                await loc.click({ force: true }).catch(() => {});
                await loc.focus().catch(() => {});
                const result = await page.evaluate((s, isPass) => {
                  const el = document.querySelector(s);
                  if (!el) return { ok: false };
                  el.focus();
                  el.click();
                  // Never call select() on password fields
                  if (!isPass && el.select) el.select();
                  return {
                    ok: document.activeElement === el,
                    tag: el.tagName, type: el.type, name: el.name, id: el.id,
                  };
                }, sel, isPasswordField).catch(() => ({ ok: false }));
                if (result.ok) {
                  logger.info(`[LOGIN_FOCUS_TARGET_FOUND] selector="${sel}" tag=${result.tag} type=${result.type} name=${result.name} id=${result.id}`);
                  if (isPasswordField) {
                    logger.info(`[LOGIN_PASSWORD_FIELD_FOCUSED_ONCE] selector="${sel}"`);
                  } else {
                    logger.info(`[LOGIN_USERNAME_FIELD_FOCUSED_ONCE] selector="${sel}"`);
                  }
                  logger.info(`[LOGIN_FOCUS_SUCCESS] focus confirmed on selector="${sel}"`);
                  lastFocusedSelector = sel;
                  lastFocusTimestamp  = now;
                  focused = true;
                  break;
                }
              } catch { /* selector not present on this step — try next */ }
            }
            if (!focused) {
              logger.warn('[LOGIN_FOCUS_FAILED] no login input could be focused — user may need to click manually');
            }

          } else {
            logger.info('[LOGIN_FOCUS_SKIPPED_USER_TYPING] input field has content — not interfering with user');
          }
        }

        // ── Always capture username from identifier field (non-destructive) ─────
        try {
          const typedUsername = await page.evaluate(() => {
            const el =
              document.querySelector('input[name="identifier"]') ||
              document.querySelector('input[autocomplete="username"]');
            return el ? (el.value || '').trim() : '';
          }).catch(() => '');
          if (typedUsername.length >= 3) {
            capturedLoginUsername = typedUsername;
          }
        } catch { /* non-fatal */ }
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

module.exports = { launchBrowser, isLoggedIn, waitForManualLogin, waitForAuthenticatedStatfloPage, closeBrowser, pressEnterToContinue, detectStatfloIdentity };
