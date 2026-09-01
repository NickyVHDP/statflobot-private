/**
 * src/statflo.js
 * Core Statflo automation logic.
 *
 * Exported functions:
 *   navigateToSmartList(page, listName)
 *   getClientRows(page)
 *   processClient(page, rowIndex, runConfig)
 *   runDoctor(page)
 *
 * runConfig shape:
 *   {
 *     list:         '1st Attempt' | '2nd Attempt' | '3rd Attempt',
 *     mode:         'dry' | 'live',
 *     delayProfile: 'safe' | 'normal' | 'fast',
 *   }
 */

'use strict';

const dns       = require('dns');
const config    = require('./config');
const SELECTORS = require('./selectors');
const logger    = require('./logger');

// ─── Safe JSON serialiser ────────────────────────────────────────────────────
// Prevents "Converting circular structure to JSON" crashes when logging
// objects that unexpectedly carry Playwright internal references.

function safeJson(val) {
  try { return JSON.stringify(val); } catch { return String(val); }
}

// ─── Timing helpers ─────────────────────────────────────────────────────────

async function humanDelay(page, profile = 'normal') {
  const { min, max } = config.delayProfiles[profile] || config.delayProfiles.normal;
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  logger.debug(`Waiting ${ms} ms`);
  await page.waitForTimeout(ms);
}

async function spaSettle(page) {
  await page.waitForTimeout(config.spaSettleWait);
}

/**
 * Shorter settle for 1st Attempt — gives the SPA enough time to react to a
 * click without the full 1500 ms spaSettle.  Used only on confirmed transitions
 * where the next step has its own readiness check.
 */
async function quickSettle(page, ms = 400) {
  await page.waitForTimeout(ms);
}

/**
 * Short post-send settle after a send-accepted/queued signal.
 * The send is already queued by Statflo — no need for a full humanDelay.
 */
async function applyFastReturnDelay(page) {
  const ms = config.postSendReturnDelayMs;
  logger.info(`[POST_SEND_RETURN_DELAY] ms=${ms}`);
  logger.info('[RETURNING_AFTER_SEND_ACCEPTED]');
  await safeWait(page, ms);
}

/**
 * Scroll an element into the automation viewport center before interacting.
 * Retries up to 3× until the bounding rect confirms the element is in-viewport.
 */
async function ensureVisibleForAutomation(page, selector) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.evaluate((sel) => {
        const el = _resolve(sel, null);
        if (el) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      }, selector);
      await page.waitForTimeout(150);
      const inViewport = await page.evaluate((sel) => {
        const el = _resolve(sel, null);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 &&
               r.top >= 0 && r.left >= 0 &&
               r.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
               r.right  <= (window.innerWidth  || document.documentElement.clientWidth);
      }, selector);
      if (inViewport) {
        logger.info(`[SELECTOR_VISIBLE_CONFIRMED] selector="${selector}"`);
        return;
      }
      if (attempt < 2) logger.info(`[SELECTOR_NOT_IN_VIEWPORT_RETRY] selector="${selector}" attempt=${attempt + 1}`);
    } catch (err) {
      logger.warn(`[SELECTOR_SCROLL_INTO_VIEW_FAILED] selector="${selector}" err=${err.message}`);
      return;
    }
  }
}

// ─── Network resilience ──────────────────────────────────────────────────────

const NETWORK_ERROR_PATTERNS = [
  'ERR_NETWORK_CHANGED',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_NAME_RESOLUTION_FAILED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_REFUSED',
  'ERR_EMPTY_RESPONSE',
  'ERR_TIMED_OUT',
  'net::ERR_',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNABORTED',
  'socket hang up',
];

function isNetworkError(err) {
  if (!err?.message) return false;
  const msg = err.message;
  return NETWORK_ERROR_PATTERNS.some(p => msg.includes(p));
}

function checkNetworkConnectivity() {
  return new Promise(resolve => {
    dns.lookup('accounts.statflo.com', err => resolve(!err));
  });
}

async function waitForNetworkRecovery(page, label) {
  logger.warn(`[NETWORK_OFFLINE_DETECTED] operation="${label}" — pausing until network returns`);
  logger.info('[RUN_PAUSED_NETWORK]');

  const MAX_WAIT_MS    = 10 * 60 * 1000; // 10 minutes
  const POLL_INTERVAL  = 15000;
  const start          = Date.now();

  while (Date.now() - start < MAX_WAIT_MS) {
    await page.waitForTimeout(POLL_INTERVAL);
    const elapsed = Math.round((Date.now() - start) / 1000);
    logger.info(`[NETWORK_ERROR_RETRY] checking connectivity... elapsed=${elapsed}s`);

    const online = await checkNetworkConnectivity();
    if (online) {
      logger.info('[NETWORK_RECOVERED] connectivity restored — resuming run');
      logger.info('[RUN_RESUMED_NETWORK]');
      return true;
    }
  }

  logger.error('[NETWORK_TIMEOUT] network did not recover within 10 minutes — aborting');
  return false;
}

async function navigationWithNetworkRetry(page, url, options, label) {
  logger.info(`[NETWORK_CHECK_START] navigating to "${label ?? url}"`);
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await page.goto(url, options);
      return;
    } catch (err) {
      if (!isNetworkError(err)) throw err;

      if (attempt < MAX_RETRIES) {
        const backoff = 2000 * (attempt + 1);
        logger.warn(`[NETWORK_ERROR_RETRY] attempt=${attempt + 1}/${MAX_RETRIES} label="${label}" backoff=${backoff}ms error="${err.message}"`);
        await page.waitForTimeout(backoff);
      } else {
        const recovered = await waitForNetworkRecovery(page, label ?? url);
        if (recovered) {
          await page.goto(url, options);
          return;
        }
        throw err;
      }
    }
  }
}

/**
 * Poll for any one of the given selectors to appear.
 * Phase 1 — fast: polls every fastInterval ms for up to fastMs.
 * Phase 2 — slow: polls every slowInterval ms for up to slowMs if phase 1 fails.
 * Returns the element handle on success, null on timeout.
 */
async function pollForElement(page, selectors, {
  fastMs       = 1200,
  fastInterval = 100,
  slowMs       = 3000,
  slowInterval = 300,
} = {}) {
  const sels = Array.isArray(selectors) ? selectors : [selectors];

  const check = async () => {
    for (const sel of sels) {
      try {
        const el = await page.$(sel);
        if (el) return el;
      } catch { /* invalid selector — skip */ }
    }
    return null;
  };

  // Phase 1 — fast
  const fastEnd = Date.now() + fastMs;
  while (Date.now() < fastEnd) {
    const el = await check();
    if (el) return el;
    await page.waitForTimeout(fastInterval);
  }

  // Phase 2 — slow
  const slowEnd = Date.now() + slowMs;
  while (Date.now() < slowEnd) {
    const el = await check();
    if (el) return el;
    await page.waitForTimeout(slowInterval);
  }

  return null;
}

// ─── Readiness gates ─────────────────────────────────────────────────────────

/**
 * Wait for the client list to be visible and stable.
 *
 * mode 'statusFilter'     → polls for a.crm-list-account-name (1st Attempt accounts list)
 * mode 'nextActionFilter' → polls for button[data-testid^="smartlist-card-"] (2nd/3rd cards)
 *
 * "Stable" = same non-zero count in two checks 200 ms apart (list stopped loading).
 * Stage A: 5 s, 150 ms interval.  Stage B: 5 s, 300 ms interval.
 * Logs a warning (non-fatal) if neither stage confirms — run continues.
 */
async function waitForClientListReady(page, mode) {
  const selector = mode === 'nextActionFilter'
    ? SELECTORS.smartListCard
    : SELECTORS.clientNameLink;

  logger.info('Waiting for client list to fully load');

  const STABLE_GAP = 200;

  const checkStable = async () => {
    const count1 = (await page.$$(selector).catch(() => [])).length;
    if (count1 === 0) return false;
    await page.waitForTimeout(STABLE_GAP);
    const count2 = (await page.$$(selector).catch(() => [])).length;
    return count2 === count1 && count2 > 0;
  };

  // Stage A — fast
  const stageAEnd = Date.now() + 5000;
  while (Date.now() < stageAEnd) {
    if (await checkStable()) { logger.info('Client list ready'); return; }
    await page.waitForTimeout(150);
  }

  // Stage B — extended
  logger.info('Client list slow to stabilise — extending wait');
  const stageBEnd = Date.now() + 5000;
  while (Date.now() < stageBEnd) {
    if (await checkStable()) { logger.info('Client list ready'); return; }
    await page.waitForTimeout(300);
  }

  logger.warn('Client list may not be fully stable — proceeding with caution');
}

/**
 * Wait for the client detail view to be ready after navigating into a client.
 *
 * mode 'statusFilter'     → waits for SMS buttons to be visible (1st Attempt).
 *                           SMS buttons visible = profile page fully rendered.
 *                           Falls back to broader signals (viewAccountLink area).
 * mode 'nextActionFilter' → waits for message textarea to be visible (2nd/3rd).
 *
 * Stage A: 3 s, 150 ms.  Stage B: 4 s, 300 ms.
 * Never fails hard — logs a warning and lets the next step's own gate handle it.
 */
async function waitForClientDetailReady(page, mode) {
  logger.info('Waiting for client detail view to fully load');

  const signals = mode === 'nextActionFilter'
    ? [
        'textarea#message-input',
        'textarea[placeholder="Write a message"]',
        SELECTORS.sendButton,
      ]
    : [
        SELECTORS.smsButton,
        SELECTORS.smsButtonDisabled,    // disabled = no SMS lines, still confirms load
        SELECTORS.viewAccountLink,       // View Account fallback area
      ];

  const check = async () => {
    for (const sel of signals) {
      if (!sel) continue;
      try {
        const el = await page.$(Array.isArray(sel) ? sel[0] : sel);
        if (el && await el.isVisible().catch(() => false)) return true;
      } catch { /* skip */ }
    }
    return false;
  };

  // Stage A — fast
  const stageAEnd = Date.now() + 3000;
  while (Date.now() < stageAEnd) {
    if (await check()) { logger.info('Client detail ready'); return; }
    await page.waitForTimeout(150);
  }

  // Stage B — extended
  logger.info('Client detail slow to load — extending wait');
  const stageBEnd = Date.now() + 4000;
  while (Date.now() < stageBEnd) {
    if (await check()) { logger.info('Client detail ready'); return; }
    await page.waitForTimeout(300);
  }

  logger.warn('Client detail view may not be fully loaded — proceeding with caution');
}

/**
 * Verify an element is stable (visible, attached, non-zero bbox, position unchanged).
 *
 * Takes two bbox readings 150 ms apart and checks that:
 *   - element is visible
 *   - bbox is non-zero
 *   - top/left position shifted < 2 px between readings (not mid-reflow)
 *
 * Returns true if stable, false otherwise.
 * Used before clicking major targets to avoid clicking during page transitions.
 */
async function isElementStable(el) {
  try {
    if (!await el.isVisible().catch(() => false)) return false;
    const b1 = await el.boundingBox();
    if (!b1 || b1.width === 0 || b1.height === 0) return false;
    await el.evaluateHandle(() => new Promise(r => setTimeout(r, 150)));
    const b2 = await el.boundingBox();
    if (!b2) return false;
    return Math.abs(b2.x - b1.x) < 2 && Math.abs(b2.y - b1.y) < 2;
  } catch {
    return false;
  }
}


// ─── Session memory helpers ──────────────────────────────────────────────────

/**
 * Normalize a client display name for session-memory comparisons.
 * Trims leading/trailing whitespace, collapses internal whitespace/newlines,
 * and lowercases so "John Smith " and "john smith" map to the same key.
 */
function normalizeClientName(name) {
  if (!name) return '';
  return name.replace(/\s+/g, ' ').trim().toLowerCase();
}

// ─── Page liveness helpers ───────────────────────────────────────────────────

/**
 * Returns true if page is open and safe to interact with.
 * Playwright throws "Target page, context or browser has been closed" errors
 * when issuing commands against a closed page — this guard lets callers bail
 * out before reaching those throws.
 */
function isPageAlive(page) {
  try {
    return page && !page.isClosed();
  } catch {
    return false;
  }
}

/**
 * page.waitForTimeout() that is a no-op when the page is already closed.
 * Prevents "Target closed" errors in teardown paths.
 */
async function safeWait(page, ms) {
  if (!isPageAlive(page)) return;
  try { await page.waitForTimeout(ms); } catch { /* page closed mid-wait */ }
}

// ─── Retry wrapper ───────────────────────────────────────────────────────────

async function retry(label, fn, retries = config.maxRetries) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      logger.warn(`${label} — attempt ${attempt}/${retries} failed`, err);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

// ─── Safe element helpers ────────────────────────────────────────────────────

/**
 * Try each selector in order and return the first visible element found.
 * Accepts a string (single selector) or an array of selectors.
 * Returns null if nothing is found within the timeout.
 */
async function findFirst(page, selectors, timeout = 5000) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  for (const sel of list) {
    if (!sel) continue;
    try {
      const el = await page.waitForSelector(sel, { state: 'visible', timeout });
      if (el) return el;
    } catch (_) {
      // Not found — try next selector
    }
  }
  return null;
}

/**
 * Ensure selector is in viewport then click.  Retries on failure.
 */
async function safeClick(page, selector, label = 'element') {
  return retry(`click ${label}`, async () => {
    await ensureVisibleForAutomation(page, selector);
    const el = await page.waitForSelector(selector, { state: 'visible', timeout: config.defaultTimeout });
    await el.click();
  });
}

/**
 * Select an option in a <select> or custom dropdown by visible text.
 * Tries native selectOption first, then click-the-container + click-the-option.
 */
async function selectDropdownOption(page, containerSel, optionText, label = 'dropdown') {
  return retry(`select ${label}`, async () => {
    const container = await page.waitForSelector(containerSel, { state: 'visible', timeout: config.defaultTimeout });
    await container.scrollIntoViewIfNeeded();

    const tag = await container.evaluate(el => el.tagName.toLowerCase());
    if (tag === 'select') {
      await container.selectOption({ label: optionText });
      return;
    }

    // Custom dropdown: click to open
    await container.click();
    await page.waitForTimeout(500);

    const optionSel = [
      `[role="option"]:has-text("${optionText}")`,
      `li:has-text("${optionText}")`,
      `.option:has-text("${optionText}")`,
      `:text("${optionText}")`,
    ].join(', ');
    const option = await page.waitForSelector(optionSel, { state: 'visible', timeout: 5000 });
    await option.click();
  });
}

// ─── Next Action filter Apply helper ────────────────────────────────────────

/**
 * Click the Apply button inside the Next Action filter panel.
 *
 * Apply and Reset both use button[data-testid="btn"], so we MUST distinguish
 * by visible text:
 *   1. Primary — :has-text("Apply") CSS selector (Playwright text filter).
 *   2. Fallback — evaluate all button[data-testid="btn"] in JS and click the
 *      one whose trimmed textContent is exactly "Apply".
 *
 * After clicking, waits for the filter panel to close (nextActionFilterButton
 * loses its expanded/active state) OR for client rows to appear — whichever
 * comes first.
 */
async function clickNextActionApply(page) {
  logger.debug('Clicking Next Action Apply button…');

  // Primary: selector already narrows by text — cannot hit Reset
  let clicked = false;
  try {
    const btn = await page.waitForSelector(
      SELECTORS.nextActionApplyButton,
      { state: 'visible', timeout: 4000 }
    );
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    clicked = true;
  } catch (_) {
    // Selector not found within timeout — fall through to JS evaluation
  }

  if (!clicked) {
    // Fallback: evaluate in-page to find the exact "Apply" button by textContent
    logger.debug('Primary Apply selector missed — using JS fallback');
    const found = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button[data-testid="btn"]'));
      const applyBtn = btns.find(b => b.textContent.trim() === 'Apply');
      if (applyBtn) { applyBtn.click(); return true; }
      return false;
    });
    if (!found) {
      throw new Error(
        'Could not find Apply button in Next Action filter panel.\n' +
        `Tried: ${SELECTORS.nextActionApplyButton} and JS textContent fallback.\n` +
        'Ensure the filter panel is open before applying.'
      );
    }
    clicked = true;
  }

  logger.debug('Apply clicked — waiting for filter panel to close / results to load');

  // Wait for either the panel to disappear or client links to appear.
  // Use Promise.race via sequential checks — Playwright has no built-in race.
  const settled = await Promise.race([
    page.waitForSelector(SELECTORS.clientNameLink, { state: 'visible', timeout: config.defaultTimeout })
      .then(() => 'rows'),
    page.waitForSelector(SELECTORS.nextActionFilterButton, { state: 'visible', timeout: config.defaultTimeout })
      .then(() => 'panel-closed'),
  ]).catch(() => 'timeout');

  logger.debug(`Filter settle result: ${settled}`);
}

// ─── Smart list navigation ───────────────────────────────────────────────────

/**
 * Check whether the page is already showing the target nextAction list.
 *
 * Inspects the first 3–5 visible client cards and checks whether their
 * visible text contains the target label (e.g. "2nd Attempt").
 * Returns true if at least 2 cards match — meaning the filter is already active.
 *
 * Scoped exclusively to nextActionFilter lists (2nd / 3rd Attempt).
 */
async function isTargetListAlreadyActive(page, targetLabel) {
  logger.info('Checking if target list is already active');

  // Gather the first few client link elements, then walk up to a card ancestor.
  let links;
  try {
    await page.waitForSelector(SELECTORS.clientNameLink, { state: 'visible', timeout: 3000 });
    links = await page.$$(SELECTORS.clientNameLink);
  } catch (_) {
    logger.debug('No client links visible — cannot confirm target list active');
    return false;
  }

  const sample = links.slice(0, 5);
  logger.info(`Visible cards inspected: ${sample.length}`);

  let matches = 0;
  for (const link of sample) {
    // Walk up the DOM up to 6 levels to find a card / row ancestor with more text.
    const cardText = await link.evaluate((el) => {
      let node = el;
      for (let i = 0; i < 6; i++) {
        if (!node.parentElement) break;
        node = node.parentElement;
        const text = node.innerText || node.textContent || '';
        // Stop as soon as we have a meaningful chunk of text (not just the link label)
        if (text.trim().length > (el.textContent || '').trim().length + 5) {
          return text.trim();
        }
      }
      return (el.textContent || '').trim();
    }).catch(() => '');

    if (cardText.includes(targetLabel)) {
      matches++;
    }
  }

  logger.info(`Cards matching "${targetLabel}": ${matches}`);

  if (matches >= 2) {
    logger.info(`Target list already active — skipping filter navigation`);
    return true;
  }

  logger.info('Target list not active — applying filter');
  return false;
}

/**
 * After Apply, confirm the visible cards contain the target attempt label.
 * Polls up to 10 s (checking every 500 ms).
 * Returns true if at least 1 card matches.
 */
async function verifyFilterApplied(page, targetLabel) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    let links;
    try {
      links = await page.$$(SELECTORS.clientNameLink);
    } catch (_) {
      await page.waitForTimeout(500);
      continue;
    }

    const sample = links.slice(0, 5);
    for (const link of sample) {
      const cardText = await link.evaluate((el) => {
        let node = el;
        for (let i = 0; i < 6; i++) {
          if (!node.parentElement) break;
          node = node.parentElement;
          const text = node.innerText || node.textContent || '';
          if (text.trim().length > (el.textContent || '').trim().length + 5) {
            return text.trim();
          }
        }
        return (el.textContent || '').trim();
      }).catch(() => '');

      if (cardText.includes(targetLabel)) {
        logger.info(`Filter verified — cards show "${targetLabel}"`);
        return true;
      }
    }

    await page.waitForTimeout(500);
  }

  logger.warn(`Could not verify filter — no cards contained "${targetLabel}" within 10 s`);
  return false;
}

/**
 * Shared (Mac + Windows): select the newest available month from #filterByDateCall.
 *
 * Reads all <option> values, picks the highest YYYY-MM, selects it, and fires
 * the change event so the page registers the update.
 *
 * Returns the selected value string, or null if the dropdown is absent.
 */
async function selectNewestMonthFilter(page) {
  const SEL = 'select#filterByDateCall';

  const el = await page.$(SEL).catch(() => null);
  if (!el) {
    logger.debug('[MONTH_FILTER_CHECK] #filterByDateCall not present — skipping month filter');
    return null;
  }

  // Read current value and all options
  const { current, options } = await page.evaluate((sel) => {
    const dropdown = document.querySelector(sel);
    if (!dropdown) return { current: null, options: [] };
    return {
      current: dropdown.value,
      options: Array.from(dropdown.options).map(o => o.value).filter(v => v),
    };
  }, SEL);

  logger.info(`[MONTH_FILTER_CHECK] current=${current ?? '(none)'} options=${options.join(',')}`);

  if (options.length === 0) return null;

  // Pick the highest YYYY-MM value (lexicographic sort is correct for ISO dates)
  const newest = options.slice().sort().reverse()[0];

  if (newest === current) {
    logger.info(`[MONTH_FILTER_SUCCESS] already on newest month selected=${newest}`);
    return newest;
  }

  logger.info(`[MONTH_FILTER_SELECT_NEWEST] newest=${newest} — selecting`);
  await page.selectOption(SEL, { value: newest });

  // Fire change/input events in case the SPA listens to them directly
  await page.evaluate((sel) => {
    const dropdown = document.querySelector(sel);
    if (!dropdown) return;
    dropdown.dispatchEvent(new Event('change', { bubbles: true }));
    dropdown.dispatchEvent(new Event('input',  { bubbles: true }));
  }, SEL);

  await page.waitForTimeout(150);

  // Verify the dropdown actually reflects the new value before returning.
  const verified = await page.$eval(SEL, el => el.value).catch(() => null);
  if (verified !== newest) {
    logger.warn(`[MONTH_FILTER_VERIFY_FAILED] expected=${newest} actual=${verified} — retrying selectOption`);
    await page.selectOption(SEL, { value: newest });
    await page.waitForTimeout(200);
  }

  logger.info(`[MONTH_FILTER_SUCCESS] selected=${newest}`);
  return newest;
}

/**
 * Navigate to the correct filtered smart list.
 *
 * navMode determines the flow:
 *
 *   'statusFilter'     — 1st Attempt
 *     1. Click a#nav-smart-lists
 *     2. Set select#filterByCompletedCall to listConfig.statusValue ("1")
 *     3. Click a#applySmartListFilters
 *
 *   'nextActionFilter' — 2nd / 3rd Attempt
 *     1. Pre-flight: check if target list is already showing (skip filter if so)
 *     2. Conversations nav → Smart Lists tab → Filters button
 *     3. Next Action filter → pick label → Apply
 *     4. Verify visible cards contain the target label
 */
async function navigateToSmartList(page, listName) {
  logger.info(`Navigating to smart list: ${listName}`);

  const listConfig = config.lists[listName];
  if (!listConfig) throw new Error(`Unknown list: "${listName}"`);

  const navMode = listConfig.navMode || 'nextActionFilter';

  await retry('navigate to smart list', async () => {

    if (navMode === 'statusFilter') {
      // ── 1st Attempt: Smart Lists nav → Status dropdown → Apply ─────────────
      await safeClick(page, SELECTORS.smartListsNav, 'Smart Lists nav');
      // Gate: wait for the status dropdown — confirms the accounts filter page is loaded.
      await page.waitForSelector(SELECTORS.statusDropdown, {
        state: 'visible',
        timeout: config.defaultTimeout,
      });

      await page.selectOption(SELECTORS.statusDropdown, { value: listConfig.statusValue || '1' });
      logger.debug(`Status dropdown set to "${listConfig.statusValue || '1'}"`);
      // 200 ms: selectOption is sync once resolved; let the DOM register the change.
      await page.waitForTimeout(200);

      // Always select the newest available month before applying.
      await selectNewestMonthFilter(page);

      await safeClick(page, SELECTORS.statusFilterApplyButton, 'Apply filter (status)');
      // Gate: wait for the client list to be visible and stable.
      await waitForClientListReady(page, 'statusFilter');

    } else {
      // ── 2nd / 3rd Attempt: Conversations → Smart Lists tab → Filters → Next Action → Apply ──
      const label = listConfig.label; // "2nd Attempt" or "3rd Attempt"

      // Informational pre-flight only — never blocks the run.
      await isTargetListAlreadyActive(page, label).catch(() => {});

      // Step 1: Open Conversations. The sidebar item can be mounted but hidden
      // after returning from an account profile (especially in the Windows
      // embedded browser). If the UI route does not expose the Smart Lists tab,
      // navigate to the same trusted Statflo route directly instead of retrying
      // a hidden element until the run is stranded on the profile page.
      try {
        await page.locator(SELECTORS.conversationsNav).first().click();
        logger.info('Clicked Conversations nav');
        await page.locator(SELECTORS.smartListsTab).waitFor({ state: 'visible', timeout: config.defaultTimeout });
      } catch (navErr) {
        const conversationsUrl = new URL('/t/conversations', config.accountsUrl).href;
        logger.warn(`[CONVERSATIONS_NAV_UI_FAILED] ${navErr.message} — using trusted direct-route fallback`);
        await page.goto(conversationsUrl, { waitUntil: 'domcontentloaded', timeout: config.defaultTimeout });
        await page.locator(SELECTORS.smartListsTab).waitFor({ state: 'visible', timeout: config.defaultTimeout });
        logger.info(`[CONVERSATIONS_NAV_ROUTE_FALLBACK_SUCCESS] url=${conversationsUrl}`);
      }

      // Step 2: Click Smart Lists tab
      // Gate: wait for the Filters button — confirms Smart Lists panel is loaded.
      await page.locator(SELECTORS.smartListsTab).click();
      logger.info('Clicked Smart Lists tab');
      await page.locator(SELECTORS.slFilterButton).first().waitFor({ state: 'visible', timeout: config.defaultTimeout });

      // Step 3: Click Filters button
      // Gate: wait for the Next Action filter button — confirms filter panel is open.
      await page.locator(SELECTORS.slFilterButton).first().click();
      logger.info('Clicked Filters button');
      await page.locator(SELECTORS.nextActionFilterButton).waitFor({ state: 'visible', timeout: config.defaultTimeout });

      // Step 4: Click Next Action filter button
      // Gate: findFirst for options below is the readiness check — no blind wait.
      await page.locator(SELECTORS.nextActionFilterButton).click();
      logger.info('Clicked Next Action filter button');

      // Step 5: Select the option whose visible text matches the list label
      // findFirst polls for up to 5 s — covers the dropdown open animation.
      const optionCandidates = [
        `[role="option"]:has-text("${label}")`,
        `li:has-text("${label}")`,
        `button:has-text("${label}")`,
        `:text("${label}")`,
      ];
      const option = await findFirst(page, optionCandidates, 5000);
      if (!option) {
        throw new Error(
          `Could not find Next Action option for "${label}".\n` +
          `Tried: ${optionCandidates.join(', ')}`
        );
      }
      await option.scrollIntoViewIfNeeded();
      await option.click();
      logger.info(`Selected "${label}" in Next Action filter`);
      // 150 ms: click registered, clickNextActionApply owns the settle from here.
      await page.waitForTimeout(150);

      // Step 6: Apply — clickNextActionApply waits for panel to close / results to appear.
      await clickNextActionApply(page);
      logger.info('Clicked Apply');
      // Gate: wait for Smart List cards to be visible and stable.
      await waitForClientListReady(page, 'nextActionFilter');
    }
  });

  logger.success(`Loaded smart list: ${listName}`);
}

// ─── Client list helpers ─────────────────────────────────────────────────────

/**
 * Open the first client from a Conversations > Smart Lists results view.
 * Used exclusively by 2nd / 3rd Attempt (nextActionFilter) flows.
 *
 * Waits for smartlist-card buttons to appear, clicks the first one,
 * then returns the card's visible label text for logging.
 */
async function openSmartListClient(page) {
  logger.info('Looking for first Smart Lists result card');

  // Short retry loop — cards are usually ready within one or two polls.
  const MAX_POLLS = 6;
  let firstCard = null;

  for (let i = 0; i < MAX_POLLS; i++) {
    const cards = await page.$$(SELECTORS.smartListCard);
    if (cards.length > 0) {
      firstCard = cards[0];
      break;
    }
    await page.waitForTimeout(500);
  }

  if (!firstCard) {
    throw new Error(
      `No Smart Lists result cards found after ${MAX_POLLS} polls (${MAX_POLLS * 500} ms).\n` +
      `Selector: ${SELECTORS.smartListCard}`
    );
  }

  const cardLabel = await firstCard.evaluate(el => (el.textContent || '').trim().slice(0, 80))
    .catch(() => 'unknown');

  logger.info(`Found first Smart Lists result card: "${cardLabel}"`);

  // Stability check before clicking — ensures card is not mid-reflow.
  const stable = await isElementStable(firstCard);
  logger.info(stable ? 'Target visible and stable — clicking' : 'Card stability uncertain — clicking anyway');

  logger.info('Opening first client now');
  await firstCard.scrollIntoViewIfNeeded();
  await firstCard.click();
}

async function getClientRows(page) {
  // clientRow is derived from the confirmed clientNameLink — wait for
  // the links first (reliable), then resolve their containing rows.
  await page.waitForSelector(SELECTORS.clientNameLink, {
    state: 'visible',
    timeout: config.defaultTimeout,
  });
  const rows = await page.$$(SELECTORS.clientRow);
  if (rows.length > 0) return rows;
  // Fallback: treat each clientNameLink as its own "row" handle so the
  // rest of processClient can still call row.$(clientNameLink) on it.
  return page.$$(SELECTORS.clientNameLink);
}

/**
 * Return all visible Smart Lists result cards for 2nd / 3rd Attempt.
 * Source of truth: button[data-testid^="smartlist-card-"]
 *
 * Does NOT wait — caller decides what to do when the array is empty.
 * Use after navigateToSmartList() has already run (the 1-second Apply delay
 * has elapsed and openSmartListClient's poll loop covers card readiness).
 */
async function getSmartListCards(page) {
  return page.$$(SELECTORS.smartListCard).catch(() => []);
}

// ─── Line / SMS inspection ───────────────────────────────────────────────────

/**
 * Inspect all phone lines on the client profile.
 * Returns { hasActiveSms: boolean }
 *
 * A client is only DNC-eligible when EVERY line is unavailable.
 */
async function inspectLines(page) {
  // No leading spaSettle — the caller already navigated and settled.
  // waitForSelector below is the authoritative readiness gate.
  await page.waitForSelector(SELECTORS.smsButton, {
    state: 'attached',
    timeout: 8000,   // reduced from defaultTimeout (15 s) — if not present in 8 s, treat as no-SMS
  }).catch(() => {
    // Selector did not appear — we'll handle the empty case below.
  });

  const allSmsButtons = await page.$$(SELECTORS.smsButton);
  logger.info(`Found SMS line buttons: ${allSmsButtons.length}`);

  if (allSmsButtons.length === 0) {
    logger.warn(`No SMS buttons found (selector: ${SELECTORS.smsButton}) — treating as no-SMS client`);
    return { hasActiveSms: false };
  }

  // Check each button individually for disabled state.
  let activeCount = 0;
  for (const btn of allSmsButtons) {
    const isDisabled = await btn.evaluate(el =>
      el.disabled ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.classList.contains('disabled')
    );
    if (!isDisabled) activeCount++;
  }

  logger.info(`Enabled SMS line buttons: ${activeCount}`);
  return { hasActiveSms: activeCount > 0 };
}

// ─── SMS button ───────────────────────────────────────────────────────────────

/**
 * Collect all currently enabled SMS line buttons on the client profile.
 * Returns an array of element handles (may be empty).
 */
async function getEnabledSmsButtons(page) {
  await page.waitForSelector(SELECTORS.smsButton, {
    state: 'attached',
    timeout: 8000,
  }).catch(() => {});

  const allButtons = await page.$$(SELECTORS.smsButton);
  const enabled = [];
  for (const btn of allButtons) {
    const isDisabled = await btn.evaluate(el =>
      el.disabled ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.classList.contains('disabled')
    ).catch(() => true);
    if (!isDisabled) enabled.push(btn);
  }
  logger.info(`SMS buttons: ${allButtons.length} total, ${enabled.length} enabled`);
  return enabled;
}

/**
 * Collect the enabled SMS lines together with a STABLE identity for each.
 *
 * Line walking used to address lines by their position in the array returned by
 * getEnabledSmsButtons(). That array is re-collected after every profile
 * reload, and positions are not stable: when the line just attempted stops
 * being enabled, every later line shifts down one slot. The loop then asked for
 * the old index, found it past the end, and recorded "line disappeared" — so a
 * genuinely eligible second line was never tried.
 *
 * Identity is taken from the phone number where one is exposed (the last 10
 * digits survive formatting differences), otherwise from the visible label.
 * Identical keys are disambiguated by occurrence so two identically-labelled
 * lines still count as two distinct lines.
 *
 * Returns [{ handle, key }] in DOM order.
 */
async function getEnabledSmsLines(page) {
  return keySmsLineHandles(await getEnabledSmsButtons(page));
}

/** Same identity scheme, applied to any already-collected handle array. */
async function keySmsLineHandles(handles) {
  const seen = new Map();
  const lines = [];

  for (let i = 0; i < handles.length; i++) {
    const handle = handles[i];
    // Read EVERY plausible source and search all of them for a phone number,
    // rather than taking the first non-empty attribute. Preferring aria-label
    // meant two buttons both labelled "Send SMS" collapsed to the same key even
    // when their visible text carried different numbers — and once keys
    // collide, the positional tie-break below is no longer stable across a
    // reorder, which in Everyone Mode could re-send to a line already messaged.
    const raw = await handle.evaluate(el => {
      const parts = [
        el.getAttribute('data-phone'),
        el.getAttribute('data-number'),
        el.getAttribute('data-testid'),
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.value,
        el.textContent,
        // The number is often on an ancestor row rather than the button itself.
        el.closest('[data-phone]')?.getAttribute('data-phone'),
        el.closest('li,tr,[role="listitem"]')?.textContent,
      ];
      return parts.filter(Boolean).join(' ').trim().replace(/\s+/g, ' ');
    }).catch(() => '');

    // Longest digit run anywhere in that text — a formatted number survives
    // "(555) 111-0000" vs "+1 555 111 0000".
    const digitRuns = (raw.match(/\d[\d\s().+-]{8,}\d/g) ?? [])
      .map(r => r.replace(/\D/g, ''))
      .filter(d => d.length >= 10)
      .sort((a, b) => b.length - a.length);

    let key;
    let positional = false;
    if (digitRuns.length > 0) key = `tel:${digitRuns[0].slice(-10)}`;
    else if (raw)             key = `label:${raw.toLowerCase()}`;
    else { key = `pos:${i}`; positional = true; }  // unlabelled button — no real identity

    // Identity is ambiguous when it had to fall back to DOM order, either
    // because two lines produced the same key or because the button exposed
    // nothing to identify it by. Position is not stable across a reload, so the
    // mark lets callers that could cause a duplicate send (Everyone Mode) refuse
    // to walk, and stops the fallback engine logging DNC on tallies it cannot
    // trust. A `pos:` key counts as ambiguous even when it does not collide:
    // being unique within one snapshot says nothing about surviving the next.
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    const collided = occurrence > 1;
    if (collided) key = `${key}#${occurrence}`;

    lines.push({ handle, key, ambiguous: collided || positional });
  }

  const ambiguousCount = lines.filter(l => l.ambiguous).length;
  logger.info(`[SMS_LINE_KEYS] count=${lines.length} ambiguous=${ambiguousCount} keys=${safeJson(lines.map(l => l.key))}`);
  if (ambiguousCount > 0) {
    logger.warn(`[SMS_LINE_KEYS_AMBIGUOUS] ${ambiguousCount} line(s) could not be identified uniquely — position-based tie-break in use`);
  }
  return lines;
}

/** True when any line in a collected set lacks a unique identity. */
function hasAmbiguousLineKeys(lines) {
  return lines.some(l => l.ambiguous);
}

/**
 * True only when EVERY line is identified by its phone number.
 *
 * Required before walking multiple lines that each send a message. A unique
 * `label:` key is not proof of a line-bound identity: labels like "Line 1" /
 * "Line 2" are unique yet describe position, so after a reorder "Line 2" can
 * resolve to the line already messaged — texting one customer twice and missing
 * the other. Only a number ties an identity to a physical line.
 *
 * Engines that stop at the first successful send do not need this: they can
 * pick the wrong line, but they cannot send twice.
 */
function hasLineBoundIdentity(lines) {
  return lines.length > 0 && lines.every(l => !l.ambiguous && l.key.startsWith('tel:'));
}

/**
 * Re-query SMS line buttons globally from the page root.
 *
 * Unlike getEnabledSmsButtons, this logs with structured markers so the
 * fallback flow can trace exactly what the DOM looks like at each step.
 * If 0 buttons are found on first pass, waits 1 s then retries once.
 *
 * Returns array of enabled element handles (may be empty).
 */
async function querySmsLinesGlobally(page) {
  logger.info('[SMS_LINE_SCAN_START] querying SMS buttons from page root');

  const attempt = async () => {
    await page.waitForSelector(SELECTORS.smsButton, {
      state: 'attached',
      timeout: 4000,
    }).catch(() => {});
    const all = await page.$$(SELECTORS.smsButton);
    const enabled = [];
    for (const btn of all) {
      const disabled = await btn.evaluate(el =>
        el.disabled ||
        el.getAttribute('aria-disabled') === 'true' ||
        el.classList.contains('disabled')
      ).catch(() => true);
      if (!disabled) enabled.push(btn);
    }
    return { total: all.length, enabled };
  };

  let result = await attempt();

  if (result.total === 0) {
    logger.warn('[SMS_LINES_DISAPPEARED] 0 SMS buttons found — waiting 1 s and retrying');
    await page.waitForTimeout(1000);
    result = await attempt();
    if (result.total === 0) {
      logger.warn('[SMS_LINES_STILL_MISSING] SMS buttons still 0 after retry');
    } else {
      logger.info('[SMS_LINES_RESTORED] SMS buttons re-appeared after wait');
    }
  }

  logger.info(`[SMS_LINE_SCAN_RESULT] total=${result.total} enabled=${result.enabled.length}`);
  return result.enabled;
}

/**
 * Inspect the current page for any sign that Statflo is blocking the send
 * because this number was messaged too recently.
 *
 * Checks: visible body text (banners, modals, toasts), composer disabled state,
 * and SMS-button availability. Logs debug snapshots then returns a result.
 *
 * Returns { blocked: boolean, reason: string, details: string }.
 */
/**
 * "Recently messaged" — a TEMPORARY, per-line send block. The contact is still
 * a valid contact; the number simply cannot be texted again yet. A client in
 * this state must never be DNC'd and must never be counted as failed.
 */
const COOLDOWN_PATTERNS = [
  /recently\s+contact/i,
  /recently\s+messaged/i,
  /too\s+recently/i,
  /contact\s+again\s+after/i,
  /message\s+again\s+after/i,
  /message\s+again\s+on/i,
  /already\s+texted/i,
  /must\s+wait/i,
  /wait\s+before\s+(texting|messaging|sending)/i,
  /wait\s+until/i,
  /cooldown/i,
  /try\s+again\s+later/i,
  /send\s+limit/i,
  /daily\s+limit/i,
];

/**
 * True DNC — a PERMANENT opt-out on the line. Distinct from cooldown: these
 * lines are skipped outright, and seeing one must never be downgraded to
 * "recently messaged" (nor the reverse, which is what caused cooldown-only
 * clients to be treated as DNC candidates).
 */
const DNC_PATTERNS = [
  /do\s*not\s*contact/i,
  /\bdnc\b/i,
  /opted?\s*[-\s]?out/i,
  // Deliberately NOT a bare /unsubscrib/ match. The detector reads the whole
  // visible account view, which includes the message thread, and outbound
  // marketing copy routinely ends with "Reply STOP to unsubscribe". That bare
  // pattern therefore labelled ordinary cooldown skips as DNC. Require wording
  // that states the contact's status rather than merely mentioning the word.
  /has\s+unsubscribed/i,
  /unsubscribed\s+from/i,
  /has\s+blocked/i,
  /messaging\s+has\s+been\s+disabled/i,
  /not\s+available\s+for\s+messaging/i,
];

async function detectSmsBlockedOrCooldownState(page, contextLabel = '') {

  try {
    const visibleText = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const el = node.parentElement;
          if (!el) return NodeFilter.FILTER_REJECT;
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return NodeFilter.FILTER_REJECT;
          if (!el.offsetWidth && !el.offsetHeight) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const parts = [];
      let n;
      while ((n = walker.nextNode())) {
        const t = n.textContent.trim();
        if (t) parts.push(t);
      }
      return parts.join(' ').substring(0, 3000);
    }).catch(() => '');

    // Never log scraped page text. It can contain contact names, phone numbers,
    // addresses, and message content. Only the scan metadata is safe to retain.
    logger.info(`[SMS_VISIBLE_TEXT_SCANNED] ctx=${contextLabel} len=${visibleText.length}`);

    // DNC is checked first: a line that is genuinely opted out must never be
    // reported as a temporary cooldown.
    for (const pat of DNC_PATTERNS) {
      if (pat.test(visibleText)) {
        logger.warn(`[SMS_LINE_DNC_DETECTED] ctx=${contextLabel} pattern="${pat.source}"`);
        return { blocked: true, kind: 'dnc', reason: 'dnc', details: 'dnc-pattern-detected' };
      }
    }

    for (const pat of COOLDOWN_PATTERNS) {
      if (pat.test(visibleText)) {
        logger.warn(`[SMS_COOLDOWN_DETECTED] ctx=${contextLabel} pattern="${pat.source}"`);
        return { blocked: true, kind: 'cooldown', reason: 'recent-contact', details: 'recent-contact-pattern-detected' };
      }
    }

    const composerState = await page.evaluate(() => {
      const el = document.querySelector('#message-input, textarea[placeholder*="message" i], textarea');
      if (!el) return { found: false };
      return {
        found:    true,
        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
        readOnly: el.readOnly,
      };
    }).catch(() => ({ found: false }));
    logger.info(`[DEBUG_COMPOSER_STATE] ctx=${contextLabel} ${safeJson(composerState)}`);

    const smsInfo = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button[data-testid="sms-button"], button[aria-label*="SMS" i]'))
        .map(b => ({
          label:    b.textContent.trim().substring(0, 40),
          disabled: b.disabled || b.getAttribute('aria-disabled') === 'true',
          visible:  b.offsetWidth > 0 && b.offsetHeight > 0,
        }))
    ).catch(() => []);
    logger.info(`[DEBUG_CLICKABLE_SMS_LINES] ctx=${contextLabel} count=${smsInfo.length}`);

    return { blocked: false, kind: 'none', reason: 'none', details: '' };
  } catch (err) {
    logger.warn(`[SMS_COOLDOWN_DETECT_ERROR] ctx=${contextLabel} error="${err.message}"`);
    return { blocked: false, kind: 'none', reason: 'detect-error', details: err.message };
  }
}

// ─── Per-client skip reasons ─────────────────────────────────────────────────
// These are *skips*, not failures. A client is only "failed" when the bot or
// the Statflo UI actually broke — never because a line was DNC or already
// messaged recently.
const SKIP_REASONS = {
  RECENTLY_MESSAGED_SINGLE_LINE:      'SKIPPED_RECENTLY_MESSAGED_SINGLE_LINE',
  ALL_LINES_RECENTLY_MESSAGED:        'SKIPPED_ALL_LINES_RECENTLY_MESSAGED',
  ALL_LINES_DNC:                      'SKIPPED_ALL_LINES_DNC',
  SEND_STATE_UNCERTAIN:               'SKIPPED_SEND_STATE_UNCERTAIN',
  NO_ELIGIBLE_LINE:                   'SKIPPED_NO_ELIGIBLE_LINE',
  NO_TEXT_AREA_OR_PREMADE_AVAILABLE:  'SKIPPED_NO_TEXT_AREA_OR_PREMADE_AVAILABLE',
  // The walk could not reach every line it detected on the account. Distinct
  // from NO_ELIGIBLE_LINE, which means there was nothing to try in the first
  // place: this one says we ran out of reach, so the client must not be DNC'd.
  LINES_NOT_FULLY_ATTEMPTED:          'SKIPPED_LINES_NOT_FULLY_ATTEMPTED',
};

/**
 * Decide the final skip reason for a client from its per-line outcomes.
 *
 * Precedence matters: a client whose only blocker was cooldown must report a
 * cooldown reason (never DNC), so that downstream reporting and the operator
 * can tell "come back later" apart from "never contact".
 */
function resolveSkipReason({ totalLines, cooldownCount, dncCount, noComposeCount }) {
  if (cooldownCount > 0 && dncCount === 0 && noComposeCount === 0) {
    return totalLines === 1
      ? SKIP_REASONS.RECENTLY_MESSAGED_SINGLE_LINE
      : SKIP_REASONS.ALL_LINES_RECENTLY_MESSAGED;
  }
  if (dncCount > 0 && cooldownCount === 0 && noComposeCount === 0) {
    return SKIP_REASONS.ALL_LINES_DNC;
  }
  if (noComposeCount > 0 && cooldownCount === 0 && dncCount === 0) {
    return SKIP_REASONS.NO_TEXT_AREA_OR_PREMADE_AVAILABLE;
  }
  return SKIP_REASONS.NO_ELIGIBLE_LINE;
}

/**
 * Classify a single SMS line once its composer view is open.
 *
 * Returns { state, details } where state is one of:
 *   'eligible'          — a text area or premade option is usable
 *   'dnc'               — this specific line is opted out
 *   'recently-messaged' — this specific line is in cooldown
 *   'no-compose'        — neither a text box nor premade messages are present
 *
 * Per-line classification is what allows a multi-line account to continue to
 * the next number instead of failing the whole client on the first blocked one.
 */
async function classifyLineState(page, contextLabel) {
  const blockState = await detectSmsBlockedOrCooldownState(page, contextLabel);
  if (blockState.blocked) {
    return {
      state:   blockState.kind === 'dnc' ? 'dnc' : 'recently-messaged',
      details: blockState.details || blockState.reason,
    };
  }

  const composer = await page.evaluate(() => {
    const textarea = document.querySelector('#message-input, textarea[placeholder*="message" i], textarea, [contenteditable="true"]');
    const usable = !!textarea &&
      !textarea.disabled &&
      textarea.getAttribute('aria-disabled') !== 'true' &&
      !textarea.readOnly;
    return { hasTextArea: usable };
  }).catch(() => ({ hasTextArea: false }));

  let hasPremade = false;
  for (const sel of [...SELECTORS.premadeCardItem, SELECTORS.chatStarterButton]) {
    try {
      const handles = await page.$$(sel);
      for (const h of handles) {
        if (await h.isVisible().catch(() => false)) { hasPremade = true; break; }
      }
      if (hasPremade) break;
    } catch { /* selector not valid in this context */ }
  }

  logger.info(`[SMS_LINE_COMPOSE_PROBE] ctx=${contextLabel} textArea=${composer.hasTextArea} premade=${hasPremade}`);

  if (!composer.hasTextArea && !hasPremade) {
    return { state: 'no-compose', details: 'no text area and no premade message option' };
  }
  return { state: 'eligible', details: composer.hasTextArea ? 'text-area' : 'premade' };
}

/**
 * Poll for the SMS composer textarea after clicking a line button.
 *
 * After an SMS line click the SPA navigates and re-mounts the composer.
 * This is deliberately more generous than findFirst — the poll is every
 * 200 ms for up to timeoutMs (default 6 000 ms).
 *
 * Returns { found: true, element } or { found: false, reason }.
 */
async function waitForComposerAfterSmsLineClick(page, timeoutMs = 13000) {
  const SELECTORS_COMPOSER = [
    '#message-input',
    'textarea#message-input',
    'textarea[placeholder="Write a message"]',
    'textarea[placeholder*="message" i]',
    'textarea[placeholder*="reply" i]',
    'textarea',
    '[contenteditable="true"]',
    '[role="textbox"]',
    'input[placeholder*="message" i]',
    '[data-testid*="message" i]',
    '[data-testid*="composer" i]',
    '[class*="message" i] textarea',
    '[class*="composer" i] textarea',
  ];

  logger.info(`[SMS_LINE_STRONG_COMPOSER_WAIT_START] polling for composer (${timeoutMs} ms)`);

  const deadline = Date.now() + timeoutMs;
  const INTERVAL = 200;

  // First-contact UI selectors — shown when a phone number has never been messaged.
  const FIRST_CONTACT_SELECTORS = [
    ...SELECTORS.premadeCardItem,
    SELECTORS.chatStarterButton,
  ];

  while (Date.now() < deadline) {
    if (page.isClosed()) {
      logger.warn('[PAGE_CLOSED_GRACEFUL_STOP] page closed during composer wait');
      return { found: false, reason: 'page-closed' };
    }
    for (const sel of SELECTORS_COMPOSER) {
      try {
        const el = await page.$(sel);
        if (el) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) {
            logger.info(`[SMS_LINE_COMPOSER_FOUND] selector="${sel}"`);
            return { found: true, element: el, type: 'textarea' };
          }
        }
      } catch { /* element may have been detached during SPA re-render */ }
    }
    // Check for first-contact UI (premade cards / Chat Starter) before timing out.
    for (const sel of FIRST_CONTACT_SELECTORS) {
      try {
        const el = await page.$(sel);
        if (el) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) {
            logger.info(`[SMS_LINE_FIRST_CONTACT_DETECTED] selector="${sel}"`);
            return { found: true, element: el, type: 'firstContact' };
          }
        }
      } catch { /* non-fatal */ }
    }
    await page.waitForTimeout(INTERVAL);
  }

  logger.warn('[SMS_LINE_COMPOSER_TIMEOUT] composer did not appear within timeout');
  logger.warn('[SMS_LINE_COMPOSER_NOT_FOUND] will attempt back-navigation');
  const cooldownCheck = await detectSmsBlockedOrCooldownState(page, 'composer-timeout');
  // `kind` must be carried out with `blocked`. Returning only the boolean made
  // every composer-timeout block look like a cooldown to the callers, so a line
  // the detector had positively identified as DNC was counted as
  // "recently messaged" — still a skip, but the wrong reason in the run summary.
  return {
    found: false,
    reason: 'timeout',
    blockedByRecentContact: cooldownCheck.blocked,
    blockKind: cooldownCheck.kind ?? 'none',
    blockDetails: cooldownCheck.details ?? '',
  };
}

/**
 * After a failed SMS line attempt, navigate back to the account profile
 * where the SMS line buttons are visible.
 *
 * Strategy:
 *   1. page.goBack() — most SPAs push history on navigation
 *   2. Wait for SMS buttons to re-appear (3 s)
 *   3. If goBack() fails or no buttons appear, try returnToListButton
 *
 * Returns true if SMS buttons are visible after recovery, false otherwise.
 */
async function navigateBackToAccountProfile(page) {
  logger.info('[SMS_LINES_DISAPPEARED] attempting back-navigation to restore account profile');

  // Strategy 1: browser back (works when SPA pushed history)
  try {
    await page.goBack({ timeout: 4000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
  } catch { /* goBack may fail or time out — continue to fallback */ }

  // Check if SMS buttons are back
  const afterBack = await page.$$(SELECTORS.smsButton);
  if (afterBack.length > 0) {
    logger.info('[SMS_LINES_RESTORED] back navigation restored account profile');
    return true;
  }

  // Strategy 2: click back / breadcrumb in profile header
  const returnEl = await page.$(SELECTORS.returnToListButton).catch(() => null);
  if (returnEl) {
    try {
      await returnEl.click();
      await page.waitForTimeout(500);
      const after2 = await page.$$(SELECTORS.smsButton);
      if (after2.length > 0) {
        logger.info('[SMS_LINES_RESTORED] returnToList click restored account profile');
        return true;
      }
    } catch { /* ignore */ }
  }

  logger.warn('[SMS_LINES_STILL_MISSING] could not restore account profile view');
  return false;
}

/**
 * Restore the account profile page using multiple strategies and re-query
 * enabled SMS buttons. Returns the enabled button array (may be empty on
 * total failure, which causes the caller's line loop to exit naturally).
 *
 * Strategies (A → B → C):
 *   A. page.goBack()
 *   B. page.goto(accountProfileUrl) — direct URL navigation
 *   C. click returnToListButton breadcrumb
 */
async function restoreProfileAndRequerySmsLines(page, accountProfileUrl) {
  logger.info('[SMS_LINE_PROFILE_RESTORE_START]');

  // Strategy A: browser back
  try {
    await page.goBack({ timeout: 4000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    const btns = await page.$$(SELECTORS.smsButton);
    if (btns.length > 0) {
      logger.info('[SMS_LINE_PROFILE_RESTORE_SUCCESS] method=goBack');
      return await querySmsLinesGlobally(page);
    }
  } catch { /* continue to next strategy */ }

  // Strategy B: direct URL goto using the captured profile URL
  if (accountProfileUrl && !accountProfileUrl.startsWith('about:')) {
    try {
      await page.goto(accountProfileUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
      await page.waitForTimeout(800);
      const btns = await page.$$(SELECTORS.smsButton);
      if (btns.length > 0) {
        logger.info('[SMS_LINE_PROFILE_RESTORE_SUCCESS] method=gotoUrl');
        return await querySmsLinesGlobally(page);
      }
    } catch { /* continue to next strategy */ }
  }

  // Strategy C: returnToListButton breadcrumb / back link in profile header
  const returnEl = await page.$(SELECTORS.returnToListButton).catch(() => null);
  if (returnEl) {
    try {
      await returnEl.click();
      await page.waitForTimeout(600);
      const btns = await page.$$(SELECTORS.smsButton);
      if (btns.length > 0) {
        logger.info('[SMS_LINE_PROFILE_RESTORE_SUCCESS] method=returnButton');
        return await querySmsLinesGlobally(page);
      }
    } catch { /* ignore */ }
  }

  logger.warn('[SMS_LINE_PROFILE_RESTORE_FAILED] all restore strategies exhausted');
  return [];
}

/**
 * Before logging DNC, verify the page is still in an account/profile view
 * where "Log an Activity" is reachable.
 *
 * If not: attempt to re-navigate. If still not reachable, throws so the
 * caller can skip DNC and move on rather than crash.
 */
async function ensureAccountViewForDnc(page) {
  const LOG_BTN_SELECTORS = [
    SELECTORS.logActivityMenuItem,
    SELECTORS.accountDetailsButton,
    SELECTORS.threeDotsMenuButton,
    // Text fallbacks in case the XPath selector mismatches
    'button:has-text("Log an Activity")',
    '[role="menuitem"]:has-text("Log an Activity")',
  ];

  // Quick check: is any DNC-relevant element visible right now?
  for (const sel of LOG_BTN_SELECTORS) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible().catch(() => false)) {
        logger.info(`[DNC_MENU_RECOVERED] account view confirmed — selector="${sel}"`);
        return true;
      }
    } catch { /* ignore */ }
  }

  // Not visible — try navigating back
  logger.warn('[DNC_ACCOUNT_VIEW_RESTORE] Log Activity not visible — attempting back-navigation');
  try {
    await page.goBack({ timeout: 4000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
  } catch { /* ignore */ }

  // Re-check
  for (const sel of LOG_BTN_SELECTORS) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible().catch(() => false)) {
        logger.info(`[DNC_MENU_RECOVERED] account view restored — selector="${sel}"`);
        return true;
      }
    } catch { /* ignore */ }
  }

  logger.warn('[DNC_MENU_NOT_FOUND] cannot confirm account view — DNC may fail');
  return false;
}

/**
 * Click a specific SMS line button (three-tier: locator → mouse → JS) and
 * wait for the message UI to be ready.
 *
 * Returns the readySignal string (same as waitForFirstAttemptMessageUiReady).
 * Throws if the message UI never appears.
 */
async function clickSmsButton(page, btn) {
  await btn.scrollIntoViewIfNeeded();

  let clicked = false;
  try {
    await btn.click();
    clicked = true;
    logger.info('Clicked SMS line button');
  } catch (_) {
    logger.debug('SMS line button.click() failed — trying mouse fallback');
  }

  if (!clicked) {
    try {
      const bbox = await btn.boundingBox();
      if (bbox) {
        await page.mouse.click(
          Math.round(bbox.x + bbox.width / 2),
          Math.round(bbox.y + bbox.height / 2)
        );
        clicked = true;
        logger.info('Clicked SMS line button (mouse fallback)');
      }
    } catch (_) {
      logger.debug('SMS line mouse click failed — trying JS fallback');
    }
  }

  if (!clicked) {
    await btn.evaluate(el => el.click());
    logger.info('Clicked SMS line button (JS fallback)');
  }

  return waitForFirstAttemptMessageUiReady(page);
}

/**
 * Click the first enabled SMS button currently visible on the page.
 * Kept for backward compatibility; delegates to getEnabledSmsButtons + clickSmsButton.
 */
async function clickActiveSmsButton(page) {
  const enabled = await getEnabledSmsButtons(page);
  if (!enabled.length) {
    throw new Error('All SMS buttons disabled — should have been caught by inspectLines()');
  }
  return clickSmsButton(page, enabled[0]);
}

// ─── 1st Attempt message-UI readiness ────────────────────────────────────────

/**
 * Signals that indicate the message/composer panel has loaded after an SMS click.
 * Checked in priority order — first match wins.
 *
 * Strong signals (chat UI fully mounted):
 *   chatStarter, premadeCards, draftField, textarea, sendArea
 *
 * Early/transitional signals (panel mounted, content still loading):
 *   composerRegion — the composer wrapper div that appears before content renders
 *   inlineField    — the inline-field container (parent of contenteditable)
 *   chatPanel      — any data-testid containing "chat" or "conversation"
 *
 * Each entry: { signal: string, selector: string }
 */
const MESSAGE_UI_SIGNALS = [
  // Strong signals — full UI mounted (top premade checked first — strict priority)
  { signal: 'premadeCards',   selector: SELECTORS.premadeCardItem[0] },
  { signal: 'premadeCards',   selector: SELECTORS.premadeCardItem[1] },
  { signal: 'chatStarter',    selector: SELECTORS.chatStarterButton },
  { signal: 'draftField',     selector: SELECTORS.draftField },
  { signal: 'textarea',       selector: 'textarea#message-input' },
  { signal: 'textarea',       selector: 'textarea[placeholder="Write a message"]' },
  { signal: 'sendArea',       selector: SELECTORS.sendButton },
  // Early/transitional — panel mounted, content still loading
  { signal: 'inlineField',    selector: '[data-testid="inline-field"]' },
  { signal: 'composerRegion', selector: '[data-testid="message-compose"]' },
  { signal: 'composerRegion', selector: '[data-testid="compose-area"]' },
  { signal: 'chatPanel',      selector: '[data-testid="chat-view"]' },
  { signal: 'chatPanel',      selector: '[data-testid="conversation-panel"]' },
];

/**
 * Wait for any message-UI signal to appear after clicking an SMS line button.
 *
 * Three-stage strategy:
 *   Stage A — quick:    1500 ms, every 150 ms. Common case.
 *   Stage B — extended: 4000 ms, every 250 ms. Slow SPAs.
 *   Stage C — final:    3500 ms, every 300 ms. Occasional very slow loads.
 *   Hard timeout:       9000 ms total.
 *
 * Returns the signal name so the caller can skip redundant re-detection.
 * Throws on hard timeout. Never "proceeds anyway".
 */
async function waitForFirstAttemptMessageUiReady(page) {
  // Extended timeouts — 15 s total gives Statflo more room on slow loads.
  const STAGE_A_MS  = 2000;  const STAGE_A_INT = 150;
  const STAGE_B_MS  = 6000;  const STAGE_B_INT = 250;
  const STAGE_C_MS  = 7000;  const STAGE_C_INT = 300;

  const HOLD_ON_PATTERNS = [
    'hey, hold on',
    'hold on',
    'waiting for a reply',
    'before you send more messages',
    'best results by waiting',
  ];

  const check = async () => {
    if (!isPageAlive(page)) return 'pageClosed';

    // PRIORITY 1: hold-on / wait-for-reply block — exit immediately, no send.
    try {
      const blocked = await page.evaluate((patterns) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
          const t = node.textContent.toLowerCase();
          if (patterns.some(p => t.includes(p))) return true;
        }
        return false;
      }, HOLD_ON_PATTERNS);
      if (blocked) return 'holdOn';
    } catch { /* non-fatal */ }

    // PRIORITY 2: Send already enabled — skip premade/Chat Starter.
    try { if (await isSendEnabled(page)) return 'sendEnabled'; } catch { /* non-fatal */ }

    // PRIORITY 3: Normal UI signals (premade cards, Chat Starter, textarea, etc.)
    for (const { signal, selector } of MESSAGE_UI_SIGNALS) {
      if (!selector) continue;
      try {
        const el = await page.$(selector);
        if (el && await el.isVisible().catch(() => false)) return signal;
      } catch { /* invalid selector — skip */ }
    }
    return null;
  };

  logger.info('[FIRST_ATTEMPT_UI_WAIT_START] waiting for 1st Attempt message UI after SMS click');

  // Stage A — quick
  const stageAEnd = Date.now() + STAGE_A_MS;
  while (Date.now() < stageAEnd) {
    const found = await check();
    if (found) {
      logger.info(`[FIRST_ATTEMPT_UI_WAIT_SIGNAL] signal=${found}`);
      logger.info(`1st Attempt message UI ready via: ${found}`);
      return found;
    }
    await page.waitForTimeout(STAGE_A_INT);
  }

  // Stage B — extended
  logger.info('Message UI quick-check not ready — extending wait');
  const stageBEnd = Date.now() + STAGE_B_MS;
  while (Date.now() < stageBEnd) {
    const found = await check();
    if (found) {
      logger.info(`[FIRST_ATTEMPT_UI_WAIT_SIGNAL] signal=${found}`);
      logger.info(`1st Attempt message UI ready via: ${found}`);
      return found;
    }
    await page.waitForTimeout(STAGE_B_INT);
  }

  // Stage C — final push
  logger.info('Message UI still loading after SMS click — continuing extended wait');
  const stageCEnd = Date.now() + STAGE_C_MS;
  while (Date.now() < stageCEnd) {
    const found = await check();
    if (found) {
      logger.info(`[FIRST_ATTEMPT_UI_WAIT_SIGNAL] signal=${found}`);
      logger.info(`1st Attempt message UI ready via: ${found}`);
      return found;
    }
    await page.waitForTimeout(STAGE_C_INT);
  }

  // Hard timeout
  const totalMs = STAGE_A_MS + STAGE_B_MS + STAGE_C_MS;
  throw new Error(
    `1st Attempt message UI did not load after ${totalMs} ms — ` +
    'no hold-on block, Send, Chat Starter, premade cards, textarea, or compose region appeared.'
  );
}

// ─── Chat / compose area ─────────────────────────────────────────────────────

/**
 * Returns true if a Send button is present and not disabled.
 * Checks multiple selectors in priority order so that premade-card and
 * first-contact flows (where .primary may not yet be applied) are not missed.
 */
async function isSendEnabled(page) {
  const SEND_SELECTORS = [
    'button.btn.primary[data-testid="btn"]',
    'button[data-testid="btn"]:has-text("Send")',
    'button[aria-label="Send"]',
  ];
  try {
    for (const sel of SEND_SELECTORS) {
      const btns = await page.$$(sel);
      for (const btn of btns) {
        const disabled = await btn.evaluate(el =>
          el.disabled ||
          el.getAttribute('aria-disabled') === 'true' ||
          el.classList.contains('disabled')
        ).catch(() => true);
        if (!disabled) return true;
      }
    }
    return false;
  } catch (_) {
    return false;
  }
}

// ─── 1st Attempt flow helpers ─────────────────────────────────────────────────

/**
 * Briefly highlight an element with a red outline so SMS line targets are
 * visible in screen recordings / debugging. Non-fatal — never throws.
 */
async function highlightClickTarget(page, element, durationMs = 500) {
  try {
    await page.evaluate((el, ms) => {
      const orig = el.style.cssText;
      el.style.outline = '3px solid #ef4444';
      el.style.boxShadow = '0 0 0 4px rgba(239,68,68,0.4)';
      setTimeout(() => { el.style.cssText = orig; }, ms);
    }, element, durationMs);
  } catch { /* visual-only — swallow */ }
}

/**
 * Poll for Send enabled. Returns true if Send becomes enabled within timeoutMs.
 */
async function pollSendEnabled(page, timeoutMs = 4000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isSendEnabled(page)) return true;
    await page.waitForTimeout(intervalMs);
  }
  return false;
}

/**
 * Re-fire richer keyboard/input events on the current composer value.
 *
 * Some embedded Statflo builds visibly accept textarea.value changes but do not
 * flip the Send button enabled until they observe a fuller typing-like event
 * sequence. This helper preserves the exact final text, emits beforeinput/input
 * plus keydown/keypress/keyup for each character, and lets the caller re-check
 * Send without ever clicking it optimistically.
 */
async function refreshComposerInputSignals(page, selector, messageText) {
  if (!messageText || !String(messageText).trim()) return false;
  try {
    const selectors = Array.isArray(selector) ? selector : [
      selector,
      'textarea[placeholder="Write a message"]',
      'textarea.message-compose',
      'textarea[placeholder*="message" i]',
      '[data-testid="inline-field"][contenteditable="true"]',
      '[role="textbox"]',
    ].filter(Boolean);

    let composer = null;
    let matchedSelector = null;
    for (const candidate of selectors) {
      composer = await page.$(candidate);
      if (composer) {
        matchedSelector = candidate;
        break;
      }
    }
    if (!composer) return false;

    await composer.evaluate((el, text) => {
      const isTextArea = el.tagName === 'TEXTAREA';
      const isInput = el.tagName === 'INPUT';
      const isEditable = el.isContentEditable;
      const textProto = window.HTMLTextAreaElement.prototype;
      const inputProto = window.HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(isTextArea ? textProto : inputProto, 'value')?.set;
      const setValue = (next) => {
        if (isEditable) {
          el.textContent = next;
          return;
        }
        if (nativeSetter) nativeSetter.call(el, next);
        else el.value = next;
      };
      const emit = (event) => el.dispatchEvent(event);
      const fireInput = (type, data = null) => {
        try {
          emit(new InputEvent(type, { bubbles: true, data, inputType: 'insertText' }));
        } catch {
          emit(new Event(type, { bubbles: true }));
        }
      };

      el.focus();
      setValue('');
      fireInput('input');
      emit(new Event('change', { bubbles: true }));

      let current = '';
      for (const ch of String(text)) {
        emit(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
        fireInput('beforeinput', ch);
        current += ch;
        setValue(current);
        fireInput('input', ch);
        emit(new KeyboardEvent('keypress', { key: ch, bubbles: true }));
        emit(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      }

      emit(new Event('change', { bubbles: true }));
      if (!isEditable && typeof el.selectionStart === 'number' && typeof el.setSelectionRange === 'function') {
        el.setSelectionRange(current.length, current.length);
      }
    }, messageText);
    const finalValue = await composer.evaluate(el => {
      if (el.isContentEditable) return el.textContent || '';
      return el.value || el.textContent || '';
    });
    if (finalValue !== String(messageText)) {
      logger.warn(`[COMPOSER_SIGNAL_REFRESH_MISMATCH] selector=${matchedSelector ?? selector} expectedLen=${String(messageText).length} actualLen=${finalValue.length}`);
      return false;
    }
    return true;
  } catch (err) {
    logger.warn(`[COMPOSER_SIGNAL_REFRESH_FAILED] selector=${selector} error=${err.message}`);
    return false;
  }
}

/**
 * Collect visible+enabled Next buttons scoped INSIDE a specific container element.
 * Never queries page-globally — if containerEl is null, returns [].
 *
 * containerEl must be an ElementHandle captured before clicking Chat Starter.
 * It remains valid after the click since it is a parent, not the button itself.
 */
async function getInContainerNextButtons(containerEl) {
  if (!containerEl) return [];
  try {
    const candidates = await containerEl.$$(
      'button[aria-label="Next"][data-testid="btn"], button[aria-label="Next"]'
    ).catch(() => []);

    const visible = [];
    for (const btn of candidates) {
      const ok = await btn.evaluate(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        return !el.disabled && el.getAttribute('aria-disabled') !== 'true';
      }).catch(() => false);
      if (ok) visible.push(btn);
    }
    return visible;
  } catch (_) {
    return [];
  }
}

/**
 * Flow A — TOP premade cards (div.rounded-2xl.bg-blue-100) are visible.
 * Works for 1 or 2 cards. Clicks first card, verifies insertion, retries if needed.
 */
async function runTopPremadeFlow(page) {
  let card = null;
  let cardSelector = null;
  for (const sel of SELECTORS.premadeCardItem) {
    try {
      const handles = await page.$$(sel);
      for (const h of handles) {
        if (await h.isVisible().catch(() => false)) { card = h; cardSelector = sel; break; }
      }
      if (card) break;
    } catch { /* invalid selector */ }
  }

  if (!card) {
    logger.warn('[PREMADE_FLOW_FAILED] no visible premade card found');
    return false;
  }

  const bbox = await card.boundingBox().catch(() => null);
  if (bbox) {
    logger.info(`Top premade: card bbox x=${Math.round(bbox.x)} y=${Math.round(bbox.y)} w=${Math.round(bbox.width)} h=${Math.round(bbox.height)}`);
  }

  /**
   * Check whether the premade was actually inserted into the composer.
   * Returns true if any of: textarea has content, send is enabled.
   */
  async function composerHasContent() {
    // Check textarea value
    const val = await page.evaluate(() => {
      const ta = document.querySelector('#message-input') ||
                 document.querySelector('textarea[placeholder]');
      return ta ? ta.value : '';
    }).catch(() => '');
    const len = val.length;
    logger.info(`[PREMADE_TEXTAREA_VALUE_LEN] len=${len}`);
    if (len > 0) return true;
    // Check send enabled
    return pollSendEnabled(page, 300);
  }

  /**
   * Attempt a single click strategy and verify insertion within verifyMs.
   */
  async function attemptClick(strategy, verifyMs = 2000) {
    try {
      if (strategy === 'standard') {
        await card.scrollIntoViewIfNeeded();
        await card.click();
      } else if (strategy === 'mouse') {
        if (!bbox) return false;
        await page.mouse.click(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);
      } else if (strategy === 'nested-button') {
        const btn = await card.$('button').catch(() => null);
        if (!btn) return false;
        await btn.click();
      } else if (strategy === 'dblclick') {
        await card.dblclick().catch(() => card.evaluate(el => el.click()));
      } else if (strategy === 'force') {
        await page.locator(cardSelector).first().click({ force: true });
      } else if (strategy === 'js') {
        await card.evaluate(el => el.click());
      }
    } catch (_) {
      return false;
    }

    logger.info(`[PREMADE_RETRY_CLICK] strategy=${strategy}`);
    // Wait briefly then verify
    await page.waitForTimeout(500);
    const deadline = Date.now() + verifyMs;
    while (Date.now() < deadline) {
      if (await composerHasContent()) return true;
      await page.waitForTimeout(200);
    }
    return false;
  }

  // ── Initial click ─────────────────────────────────────────────────────────
  await card.scrollIntoViewIfNeeded();
  try { await card.click(); } catch (_) {
    if (bbox) await page.mouse.click(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2).catch(() => {});
    else await card.evaluate(el => el.click()).catch(() => {});
  }
  logger.info('[PREMADE_CLICKED]');

  // ── Verification phase (up to 8 s total) ─────────────────────────────────
  logger.info('[PREMADE_INSERT_WAIT] verifying composer insertion (up to 8 s)');
  const verifyDeadline = Date.now() + 8000;
  let confirmed = false;
  while (Date.now() < verifyDeadline && !confirmed) {
    confirmed = await composerHasContent();
    if (!confirmed) await page.waitForTimeout(200);
  }

  if (confirmed) {
    logger.info('[PREMADE_SEND_READY] composer confirmed after initial click');
    logger.info('[PREMADE_FLOW_CONFIRMED]');
    return true;
  }

  // ── Retry strategies ──────────────────────────────────────────────────────
  const strategies = ['mouse', 'nested-button', 'dblclick', 'force', 'js'];
  for (const strategy of strategies) {
    logger.info(`[PREMADE_RETRY_CLICK] attempting strategy=${strategy}`);
    // Re-acquire card handle in case DOM changed
    try {
      const handles = await page.$$(cardSelector ?? SELECTORS.premadeCardItem[0]);
      for (const h of handles) {
        if (await h.isVisible().catch(() => false)) { card = h; break; }
      }
    } catch { /* keep existing handle */ }

    const ok = await attemptClick(strategy, 2500);
    if (ok) {
      logger.info(`[PREMADE_SEND_READY] confirmed after retry strategy=${strategy}`);
      logger.info('[PREMADE_FLOW_CONFIRMED]');
      return true;
    }
  }

  logger.warn('[PREMADE_FLOW_FAILED] premade content never inserted and Send never enabled after all retry strategies');
  return false;
}

/**
 * Flow B — BOTTOM Chat Starter / premade wizard.
 *
 * Priority chain (A → B → C → D):
 *   A) Send already enabled after wizard opens → send immediately.
 *   B) Click/select the visible premade card → re-check Send.
 *   C) Click Next/arrow → re-check Send.
 *   D) All paths exhausted → return false.
 *
 * Never fails just because Next/arrow is unavailable.
 * Returns true when Send is confirmed ready; caller handles the actual send.
 */
async function runBottomChatStarterFlow(page) {
  const chatStarter = await findFirst(page, SELECTORS.chatStarterButton, 5000);
  if (!chatStarter) {
    logger.warn('Bottom Chat Starter flow: Chat Starter button not found');
    return false;
  }

  // Capture the container BEFORE clicking so we have a stable scope for
  // querying Next buttons after the wizard opens.
  const containerEl = await page.evaluateHandle((btn) => {
    let el = btn.parentElement;
    while (el && el !== document.body) {
      if (el.getBoundingClientRect().width >= 200) return el;
      el = el.parentElement;
    }
    return btn.parentElement;
  }, chatStarter).catch(() => null);

  await chatStarter.scrollIntoViewIfNeeded();
  await chatStarter.click();
  logger.info('Bottom Chat Starter: clicked Chat Starter');
  await quickSettle(page, 600);

  // ── Path A: Send already enabled — premade auto-selected ─────────────────
  const immediateSend = await pollSendEnabled(page, 800);
  if (immediateSend) {
    logger.info('[BOTTOM_PREMADE_SEND_READY_IMMEDIATE] Send already enabled after wizard open — sending immediately');
    logger.info('[BOTTOM_PREMADE_FLOW_CONFIRMED] path=immediate');
    return true;
  }

  // ── Path B: click the visible premade card/item ───────────────────────────
  const premadeItem = await findFirst(page, SELECTORS.premadeItem, 1500).catch(() => null);
  if (premadeItem) {
    logger.info('[BOTTOM_PREMADE_NEXT_FALLBACK] clicking visible premade item');
    try { await premadeItem.click(); } catch (_) {
      await premadeItem.evaluate(el => el.click()).catch(() => {});
    }
    await page.waitForTimeout(400);
    const afterItemClick = await pollSendEnabled(page, 1200);
    if (afterItemClick) {
      logger.info('[BOTTOM_PREMADE_SEND_READY_IMMEDIATE] Send enabled after premade item click');
      logger.info('[BOTTOM_PREMADE_FLOW_CONFIRMED] path=item-click');
      return true;
    }
  }

  // ── Path C: click in-container Next/arrow button ──────────────────────────
  const nextButtons = await getInContainerNextButtons(containerEl?.asElement?.() ?? containerEl);
  if (nextButtons.length > 0) {
    logger.info(`[BOTTOM_PREMADE_NEXT_FALLBACK] ${nextButtons.length} Next button(s) found — clicking`);
    const btn = nextButtons[0];
    await btn.scrollIntoViewIfNeeded();
    let clicked = false;
    try { await btn.click(); clicked = true; } catch (_) {}
    if (!clicked) { await btn.evaluate(el => el.click()); }
    logger.info('Bottom Chat Starter: clicked Next');

    const afterNext = await pollSendEnabled(page, 2000);
    if (afterNext) {
      logger.info('Bottom Chat Starter: Send enabled after Next');
      logger.info('[BOTTOM_PREMADE_FLOW_CONFIRMED] path=next-click');
      return true;
    }
    logger.warn('Bottom Chat Starter: Send not enabled after Next click');
  } else {
    logger.warn('[BOTTOM_PREMADE_NEXT_FALLBACK] no in-container Next button found — skipping Next path');
  }

  // ── Path D: all paths exhausted ───────────────────────────────────────────
  logger.warn('Bottom Chat Starter: all paths exhausted — Send never became enabled');
  return false;
}

/**
 * Everyone Mode first-contact send helper.
 *
 * When waitForComposerAfterSmsLineClick returns type='firstContact', the UI is
 * showing a premade-card chooser or Chat Starter wizard instead of a textarea.
 * runTopPremadeFlow / runBottomChatStarterFlow only get Send READY — they do not
 * click Send or confirm delivery.  This helper wraps both flows and completes the
 * full send cycle: option click → poll send enabled → clickSend → delivery confirm.
 *
 * Returns true on confirmed send, false on any failure.
 * Never throws — caller decides whether to restore and continue or abort.
 */
async function sendFirstContactPremadeInEveryoneMode(page, clientNum, lineDisplay) {
  logger.info(`[EVERYONE_FIRST_CONTACT_FLOW_START] client=${clientNum} line=${lineDisplay}`);

  let optionClicked = false;

  try {
    const premadeOk = await runTopPremadeFlow(page);
    if (premadeOk) {
      optionClicked = true;
      logger.info(`[EVERYONE_FIRST_CONTACT_OPTION_CLICKED] client=${clientNum} line=${lineDisplay} method=premade`);
    }
  } catch { /* fall through to Chat Starter */ }

  if (!optionClicked) {
    try {
      const chatOk = await runBottomChatStarterFlow(page);
      if (chatOk) {
        optionClicked = true;
        logger.info(`[EVERYONE_FIRST_CONTACT_OPTION_CLICKED] client=${clientNum} line=${lineDisplay} method=chatStarter`);
      }
    } catch { /* both flows failed */ }
  }

  if (!optionClicked) {
    logger.warn(`[EVERYONE_FIRST_CONTACT_SEND_FAILED] client=${clientNum} line=${lineDisplay} reason=no-option-clicked`);
    return false;
  }

  const sendReady = await pollSendEnabled(page, 5000);
  if (!sendReady) {
    logger.warn(`[EVERYONE_FIRST_CONTACT_SEND_FAILED] client=${clientNum} line=${lineDisplay} reason=send-not-enabled`);
    return false;
  }
  logger.info(`[EVERYONE_FIRST_CONTACT_SEND_READY] client=${clientNum} line=${lineDisplay}`);

  await clickSend(page);
  logger.info(`[EVERYONE_FIRST_CONTACT_SEND_CLICKED] client=${clientNum} line=${lineDisplay}`);

  const confirmed = await waitForMessageDeliveryConfirmation(page, 10000);
  if (confirmed) {
    logger.success(`[EVERYONE_FIRST_CONTACT_SENT] client=${clientNum} line=${lineDisplay}`);
    logger.info(`[SMS_SENT] mode=everyone-first-contact`);
    return true;
  }

  logger.warn(`[EVERYONE_FIRST_CONTACT_SEND_FAILED] client=${clientNum} line=${lineDisplay} reason=not-confirmed`);
  return false;
}


// ─── 1st Attempt: branching wrapper ──────────────────────────────────────────

/**
 * Strict-priority entry point for 1st Attempt flows.
 *
 * Priority:
 *   1. Top premade cards (div.rounded-2xl.bg-blue-100) — runTopPremadeFlow()
 *   2. Bottom Chat Starter wizard — runBottomChatStarterFlow()
 *   3. Throw — caller's SMS-line loop will try the next available line
 *
 * No custom-text fallback. If both UI flows fail on this SMS line, the line is
 * exhausted and the caller moves to the next SMS line on the same client.
 */
async function runFirstAttemptFlow(page, readySignal) {
  logger.info(`[PLATFORM_SHARED_FLOW] platform=${process.platform} attempt=1st engine=runFirstAttemptFlow signal=${readySignal}`);

  // ── PRIORITY 0: page closed ───────────────────────────────────────────────
  if (readySignal === 'pageClosed' || !isPageAlive(page)) {
    logger.warn('[USER_CLOSED_BROWSER_GRACEFUL_STOP] browser closed before 1st Attempt flow');
    throw new Error('Target page, context or browser has been closed');
  }

  // ── PRIORITY 1: hold-on / cooldown block ──────────────────────────────────
  if (readySignal === 'holdOn') {
    logger.warn('[FIRST_ATTEMPT_HOLD_ON_DETECTED] hold-on/cooldown block detected — skipping line');
    throw new HoldOnBlockError();
  }

  // ── PRIORITY 2: Send already enabled ─────────────────────────────────────
  if (readySignal === 'sendEnabled' || readySignal === 'sendArea') {
    logger.info('[FIRST_ATTEMPT_SEND_ALREADY_READY] Send already enabled — skipping premade/Chat Starter');
    const sendReady = readySignal === 'sendEnabled' || await pollSendEnabled(page, 1500);
    if (sendReady) {
      logger.info('[FIRST_ATTEMPT_DIRECT_SEND] proceeding to click Send immediately');
      logger.info('[FIRST_ATTEMPT_FLOW_CONFIRMED] path=sendAreaReady');
      return 'sendAreaReady';
    }
    logger.info('[FIRST_ATTEMPT_SEND_AREA_NOT_READY] Send not yet enabled — falling through to premade/Chat Starter');
    // Fall through
  }

  // ── PRIORITY 3: top premade cards ─────────────────────────────────────────
  let topCardsExist = readySignal === 'premadeCards';
  if (!topCardsExist) {
    for (const sel of SELECTORS.premadeCardItem) {
      try {
        const handles = await page.$$(sel);
        for (const h of handles) {
          if (await h.isVisible().catch(() => false)) { topCardsExist = true; break; }
        }
        if (topCardsExist) break;
      } catch { /* invalid selector */ }
    }
  }

  if (topCardsExist) {
    logger.info('1st Attempt: top premade flow');
    const ok = await runTopPremadeFlow(page);
    logger.info(`[PREMADE_SHARED_RESULT] platform=${process.platform} result=${ok ? 'confirmed' : 'failed'}`);
    if (ok) return 'topPremade';
    throw new Error('1st Attempt: top premade flow failed — SMS line unusable');
  }

  // ── PRIORITY 4: bottom Chat Starter wizard ────────────────────────────────
  const chatStarterEl = await page.$(SELECTORS.chatStarterButton);
  const chatStarterVisible = chatStarterEl
    ? await chatStarterEl.isVisible().catch(() => false)
    : false;

  if (chatStarterVisible || readySignal === 'chatStarter') {
    logger.info('1st Attempt: bottom Chat Starter flow');
    const ok = await runBottomChatStarterFlow(page);
    if (ok) return 'bottomChatStarter';
    throw new Error('1st Attempt: Chat Starter flow failed — SMS line unusable');
  }

  throw new Error(
    `1st Attempt: no usable UI found (signal="${readySignal}") — SMS line unusable.\n` +
    `Premade card selectors: ${SELECTORS.premadeCardItem.join(', ')}\n` +
    `Chat Starter selector: ${SELECTORS.chatStarterButton}`
  );
}

/**
 * Ensure the compose area is open for text / premade modes (2nd & 3rd Attempt).
 *
 * Does NOT click Next — that is exclusively handled by runFirstAttemptChatFlow.
 *
 *   1. If the draft field is already present → done.
 *   2. If Chat Starter button is visible → click it to open the compose area.
 */
async function ensureChatOpen(page) {
  await spaSettle(page);

  // If the compose area is already available, nothing to do.
  if (await findFirst(page, SELECTORS.draftField, 2000)) {
    logger.debug('Draft field already present — compose area ready');
    return;
  }

  // If Chat Starter is present, click it to surface the compose area.
  const chatStarter = await findFirst(page, SELECTORS.chatStarterButton, 5000);
  if (chatStarter) {
    logger.info('Chat Starter found — clicking to open compose area');
    await chatStarter.scrollIntoViewIfNeeded();
    await chatStarter.click();
    await spaSettle(page);
  } else {
    logger.debug('Chat Starter not present — compose area should already be accessible');
  }
}

// ─── Premade message flow ─────────────────────────────────────────────────────

async function openPremadePanel(page) {
  const alreadyVisible = await findFirst(page, SELECTORS.premadeItem, 2000);
  if (alreadyVisible) {
    logger.debug('Premade messages already visible');
    return;
  }

  logger.info('Opening premade messages panel…');
  const openBtn = await findFirst(page, SELECTORS.premadeOpenButton, 5000);
  if (!openBtn) {
    throw new Error(
      'Could not find button to open premade messages panel.\n' +
      'TODO: update SELECTORS.premadeOpenButton in src/selectors.js'
    );
  }
  await openBtn.scrollIntoViewIfNeeded();
  await openBtn.click();
  await spaSettle(page);
  await page.waitForSelector(SELECTORS.premadeItem, { state: 'visible', timeout: config.defaultTimeout });
}

/**
 * Select the configured premade message.
 *
 * Strategy:
 *   1. If premadeKeyword is set, scan visible items for text containing the keyword.
 *   2. Fall back to premadeIndex (0-based).
 *   3. If target is not visible, click the "next" arrow (up to 5 times).
 */
async function selectPremadeMessage(page, listConfig) {
  const keyword = listConfig.premadeKeyword;
  const index   = listConfig.premadeIndex;

  logger.info('Selecting premade message', { keyword, index });

  const getItems = () => page.$$(SELECTORS.premadeItem);

  // ── Keyword-based selection ───────────────────────────────────────────────
  if (keyword) {
    for (let arrowClicks = 0; arrowClicks <= 5; arrowClicks++) {
      const items = await getItems();
      for (const item of items) {
        const text = await item.textContent().catch(() => '');
        if (text.toLowerCase().includes(keyword.toLowerCase())) {
          logger.info(`Premade message matched keyword "${keyword}"`);
          await item.scrollIntoViewIfNeeded();
          await item.click();
          return;
        }
      }
      const nextArrow = await findFirst(page, SELECTORS.premadeNextArrow, 1500);
      if (!nextArrow) break;
      logger.debug('Premade next arrow clicked');
      await nextArrow.click();
      await page.waitForTimeout(600);
    }
    logger.warn(`Keyword "${keyword}" not found — falling back to index ${index}`);
  }

  // ── Index-based selection ─────────────────────────────────────────────────
  for (let arrowClicks = 0; arrowClicks <= 5; arrowClicks++) {
    const items = await getItems();
    if (index < items.length) {
      logger.info(`Selecting premade message at index ${index}`);
      await items[index].scrollIntoViewIfNeeded();
      await items[index].click();
      return;
    }
    const nextArrow = await findFirst(page, SELECTORS.premadeNextArrow, 1500);
    if (!nextArrow) {
      throw new Error(
        `Premade message index ${index} not found (only ${items.length} visible) ` +
        `and no "next" arrow available.`
      );
    }
    await nextArrow.click();
    await page.waitForTimeout(600);
  }

  throw new Error(`Could not select premade message. keyword="${keyword}", index=${index}`);
}

// ─── Direct text mode ────────────────────────────────────────────────────────

/**
 * Type (or fill) exact message text directly into the compose box.
 * Used when messageMode === 'text'.
 *
 * Playwright's fill() replaces the entire content of the field reliably.
 * For contenteditable divs it falls back to triple-click + type.
 */
async function typeDirectMessage(page, text) {
  if (!text || text.trim().length === 0) {
    throw new Error(
      'Message text is empty in config.\n' +
      'TODO: Fill in config.lists["<list>"].text before running in live mode.'
    );
  }

  logger.info('Typing direct message text…', { preview: text.slice(0, 60) + (text.length > 60 ? '…' : '') });

  const input = await findFirst(page, SELECTORS.messageInput, config.defaultTimeout);
  if (!input) {
    throw new Error(
      'Message compose input not found.\n' +
      'TODO: update SELECTORS.messageInput in src/selectors.js'
    );
  }

  await input.scrollIntoViewIfNeeded();
  await input.click();

  // Determine element type and fill accordingly
  const tag = await input.evaluate(el => el.tagName.toLowerCase());
  const isContentEditable = await input.evaluate(el => el.isContentEditable);

  if (tag === 'textarea' || tag === 'input') {
    await input.fill(text);
  } else if (isContentEditable) {
    // Select all existing text then overwrite
    await input.press('Control+A');
    await input.type(text, { delay: 20 });
  } else {
    // Fallback: fill (works for most cases)
    await input.fill(text);
  }

  logger.debug('Direct message text entered');
}

// ─── Message input verification ──────────────────────────────────────────────

async function verifyMessagePopulated(page) {
  const input = await findFirst(page, SELECTORS.messageInput, 4000);
  if (!input) {
    logger.warn('Message input not found — cannot verify content');
    return false;
  }
  const value = await input.evaluate(el => {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value;
    return el.textContent || el.innerText || '';
  });
  if (!value || value.trim().length === 0) {
    logger.warn('Message input appears empty');
    return false;
  }
  logger.debug('Message input confirmed populated', { preview: value.slice(0, 60) });
  return true;
}

// ─── Send ────────────────────────────────────────────────────────────────────

async function clickSend(page) {
  const TIMEOUT_MS = 20_000;
  const deadline   = Date.now() + TIMEOUT_MS;
  logger.info('[SEND_BUTTON_LOOKUP_START]');

  let sendEl = null;

  while (Date.now() < deadline) {
    try {
      // Primary: button.btn.primary[data-testid="btn"] (valid CSS, no :has-text needed)
      const btns = await page.$$('button.btn.primary[data-testid="btn"]').catch(() => []);
      for (const btn of btns) {
        const disabled = await btn.evaluate(el =>
          el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled')
        ).catch(() => true);
        if (!disabled) { sendEl = btn; break; }
      }

      if (!sendEl) {
        // Fallback: any non-disabled button[data-testid="btn"] with "Send" text
        const found = await page.evaluate(() => {
          const all = Array.from(document.querySelectorAll('button[data-testid="btn"]'));
          return all.some(btn => {
            if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
            const t = (btn.textContent || '').trim();
            return t === 'Send' || t.startsWith('Send');
          });
        }).catch(() => false);
        if (found) {
          sendEl = await page.$('button[data-testid="btn"]').catch(() => null);
        }
      }
    } catch { /* retry */ }

    if (sendEl) break;
    await page.waitForTimeout(200);
  }

  if (!sendEl) {
    logger.error(`[SEND_BUTTON_NOT_FOUND] Send button not visible after ${TIMEOUT_MS}ms — failing client`);
    throw new Error('[SEND_BUTTON_NOT_FOUND] Send button not found within timeout');
  }

  const btnText     = await sendEl.textContent().catch(() => '?');
  const btnDisabled = await sendEl.evaluate(el =>
    el.disabled || el.getAttribute('aria-disabled') === 'true'
  ).catch(() => false);
  logger.info(`[SEND_BUTTON_FOUND] text="${btnText.trim()}" disabled=${btnDisabled}`);

  logger.info('[SEND_BUTTON_CLICK_START]');
  await sendEl.scrollIntoViewIfNeeded();
  await sendEl.click();
  logger.info('[SEND_BUTTON_CLICKED]');

  await spaSettle(page);
  logger.success('Send clicked');
}

/**
 * Shared DOM probe — returns an object describing current send state.
 * Used by both the fast-path and the long-wait confirmation phase.
 */
async function probeSendState(page) {
  return page.evaluate(() => {
    // Sending indicator: leaf text "Sending"/"Sending…"
    const hasSendingText = Array.from(document.querySelectorAll('*')).some(el => {
      if (el.children.length > 0) return false;
      const t = el.textContent?.trim() ?? '';
      return t === 'Sending' || t === 'sending' || t === 'Sending…' || t === 'sending…';
    });

    // Sending indicator: reduced-opacity message bubble
    const bubbles = document.querySelectorAll(
      '[class*="message"], [class*="bubble"], [data-testid*="message"], [class*="chat-item"]'
    );
    let hasFadedBubble = false;
    for (const el of bubbles) {
      const opacity = parseFloat(window.getComputedStyle(el).opacity ?? '1');
      if (opacity < 0.9 && opacity > 0) { hasFadedBubble = true; break; }
    }

    // Sending indicator: aria-label or data-status
    const hasStatusEl = !!document.querySelector('[aria-label="Sending"], [data-status="sending"]');

    // Send button disabled/reset — means the send action was accepted
    const sendBtn = document.querySelector('button.btn.primary[data-testid="btn"]');
    const sendBtnDisabled = sendBtn ? sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true' : false;

    const sendingActive = hasSendingText || hasFadedBubble || hasStatusEl;
    return { sendingActive, sendBtnDisabled };
  }).catch(() => ({ sendingActive: false, sendBtnDisabled: false }));
}

/**
 * Fast-path: detect that the send action was accepted within a short window.
 *
 * Looks for ANY of:
 *   a) "Sending" indicator appears in DOM
 *   b) new outbound message bubble with reduced opacity
 *   c) Send button becomes disabled/reset
 *
 * Returns true as soon as any signal fires. Does NOT wait for full delivery.
 */
async function waitForSendStarted(page, timeoutMs = 1800) {
  const INTERVAL = 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { sendingActive, sendBtnDisabled } = await probeSendState(page);
    if (sendingActive || sendBtnDisabled) return true;
    await page.waitForTimeout(INTERVAL);
  }
  return false;
}

/**
 * Two-phase send confirmation:
 *
 *   Phase 1 (fast, ≤1.8 s): waitForSendStarted — any send-accepted signal.
 *     → If detected: log [SEND_STARTED_FAST], return true immediately.
 *
 *   Phase 2 (slow, up to remaining timeoutMs): wait for sending indicator to CLEAR.
 *     → Only reached if Phase 1 sees nothing at all.
 *     → If clears: [SEND_CONFIRMATION_SUCCESS].
 *     → If timeout: [SEND_CONFIRMATION_TIMEOUT], return false.
 *
 * This keeps normal sends fast (Phase 1 fires in < 200 ms) while still
 * protecting against the rare case where the SPA emits no transient indicator.
 */
async function waitForMessageDeliveryConfirmation(page, timeoutMs = 10000) {
  logger.info('[SEND_CONFIRMATION_WAIT_START]');
  logger.info(`[SEND_CONFIRMATION_WAIT] two-phase confirmation (fast≤1.8s, fallback≤${timeoutMs}ms)`);

  // ── Phase 1: fast-path ────────────────────────────────────────────────────
  const FAST_MS = 1800;
  const started = await waitForSendStarted(page, FAST_MS);
  if (started) {
    logger.info('[SEND_STARTED_FAST] send-accepted signal detected — moving to next client');
    logger.info('[SEND_CONFIRMED_OR_TIMEOUT] result=confirmed-fast');
    return true;
  }

  // ── Phase 2: slow-path — wait for sending indicator to clear ─────────────
  logger.info('[SEND_FALLBACK_WAIT] no fast signal — waiting for sending indicator to clear');
  const INTERVAL = 200;
  const deadline = Date.now() + (timeoutMs - FAST_MS);

  while (Date.now() < deadline) {
    const { sendingActive } = await probeSendState(page);
    if (!sendingActive) {
      logger.info('[SEND_CONFIRMATION_SUCCESS] sending indicator cleared — delivery confirmed');
      return true;
    }
    await page.waitForTimeout(INTERVAL);
  }

  logger.warn('[SEND_CONFIRMATION_TIMEOUT] no confirmation signal within timeout');
  logger.warn('[SEND_CONFIRMED_OR_TIMEOUT] result=timeout');
  return false;
}

/**
 * Check whether the last visible outbound message in the conversation
 * already matches our template text. Used to prevent duplicate sends.
 *
 * Returns true if a duplicate is detected.
 */
async function checkForDuplicateMessage(page, messageText) {
  if (!messageText) return false;
  try {
    const lastMsg = await page.evaluate(() => {
      // Look for outbound message bubbles — typically right-aligned or have a specific class
      const candidates = document.querySelectorAll(
        '[class*="outbound"] [class*="text"], [class*="sent"] [class*="text"], ' +
        '[class*="message-out"] p, [class*="message-out"] span, ' +
        '[data-testid*="message-out"], [class*="my-message"] p, ' +
        '.message-content, [class*="outgoing"] [class*="body"]'
      );
      if (candidates.length === 0) return null;
      const last = candidates[candidates.length - 1];
      return last.textContent?.trim() ?? null;
    });
    if (!lastMsg) return false;
    const normalized = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const isDupe = normalized(lastMsg) === normalized(messageText);
    if (isDupe) {
      logger.warn(`[DUPLICATE_PROTECTION] last outbound message matches template — skipping send`);
    }
    return isDupe;
  } catch {
    return false; // on any DOM evaluation error, assume not duplicate
  }
}

// ─── DNC flow ────────────────────────────────────────────────────────────────

/**
 * Log a DNC activity for the current client.
 *
 * Flow:
 *   1. Click "Log an Activity" directly via confirmed XPath.
 *      Fallback: open account menu first, then click it.
 *   2. Select Customer Interaction = SMS (value 4) from confirmed <select>.
 *   3. Select Outcome = DNC from confirmed <select>.
 *   4. Click the "All Channels" radio button.
 *   5. Fill note textarea with "DNC".
 *   6. Click the confirmed Save button.
 */
async function logDncActivity(page) {
  logger.info('Logging DNC activity…');

  // ── Step 1: Click "Log an Activity" ──────────────────────────────────────
  // Try direct selectors first (CSS text match is broader than XPath).
  // Only open the account menu if direct click fails or button not found.
  const LOG_ACTIVITY_SELECTORS = [
    'button:has-text("Log an Activity")',
    SELECTORS.logActivityMenuItem,
    'xpath=//button[contains(normalize-space(.), "Log an Activity")]',
    '[role="button"]:has-text("Log an Activity")',
  ];

  let logBtn = await findFirst(page, LOG_ACTIVITY_SELECTORS, 4000);
  let modalTriggered = false;

  if (logBtn) {
    logger.info('[DNC_LOG_ACTIVITY_DIRECT_FOUND]');
    try {
      await logBtn.scrollIntoViewIfNeeded();
      await logBtn.click();
      logger.info('[DNC_LOG_ACTIVITY_DIRECT_CLICKED]');
      modalTriggered = true;
    } catch (directErr) {
      logger.warn(`[DNC_LOG_ACTIVITY_DIRECT_FAILED] error="${directErr.message}" — trying menu fallback`);
    }
  }

  if (!modalTriggered) {
    logger.info('[DNC_LOG_ACTIVITY_MENU_FALLBACK_START]');
    const menuBtn = await findFirst(page, [
      SELECTORS.accountDetailsButton,
      SELECTORS.threeDotsMenuButton,
    ], 5000);
    if (!menuBtn) {
      logger.warn('[DNC_LOG_SKIPPED] Could not find "Log an Activity" button or account menu trigger — skipping DNC log');
      return false;
    }
    await menuBtn.scrollIntoViewIfNeeded();
    await menuBtn.click();
    await page.waitForTimeout(800);
    logBtn = await findFirst(page, LOG_ACTIVITY_SELECTORS, 5000);
    if (!logBtn) {
      logger.warn('[DNC_LOG_SKIPPED] "Log an Activity" not found in account menu — skipping DNC log');
      return false;
    }
    await logBtn.scrollIntoViewIfNeeded();
    await logBtn.click();
    modalTriggered = true;
  }

  await spaSettle(page);
  logger.debug('Log Activity modal triggered');

  const { dncValues } = SELECTORS;

  // ── Step 2: Customer Interaction = SMS (confirmed value: 4) ──────────────
  await page.waitForSelector(SELECTORS.customerInteractionDropdown, {
    state: 'visible',
    timeout: config.defaultTimeout,
  });
  await page.selectOption(SELECTORS.customerInteractionDropdown, { value: dncValues.customerInteractionValue });
  logger.debug(`Customer Interaction set to value ${dncValues.customerInteractionValue}`);
  await page.waitForTimeout(400);

  // ── Step 3: Outcome = DNC (confirmed value: 'DNC') ───────────────────────
  await page.waitForSelector(SELECTORS.outcomeDropdown, {
    state: 'visible',
    timeout: config.defaultTimeout,
  });
  await page.selectOption(SELECTORS.outcomeDropdown, { value: dncValues.outcomeValue });
  logger.debug(`Outcome set to value ${dncValues.outcomeValue}`);
  await page.waitForTimeout(400);

  // ── Step 4: All Channels radio ────────────────────────────────────────────
  const radio = await findFirst(page, SELECTORS.dncAllChannelsRadio, 5000);
  if (radio) {
    await radio.click();
    logger.debug('All Channels radio clicked');
    await page.waitForTimeout(300);
  } else {
    logger.warn('All Channels radio not found — TODO: verify SELECTORS.dncAllChannelsRadio');
  }

  // ── Step 5: Note = DNC ────────────────────────────────────────────────────
  const noteField = await findFirst(page, SELECTORS.activityNoteTextarea, 5000);
  if (noteField) {
    await noteField.fill(dncValues.note);
    logger.debug('Note filled');
  } else {
    logger.warn('Note textarea not found — TODO: verify SELECTORS.activityNoteTextarea');
  }

  // ── Step 6: Save ──────────────────────────────────────────────────────────
  await safeClick(page, SELECTORS.activityConfirmButton, 'Save DNC activity');
  await spaSettle(page);
  logger.success('DNC activity logged');
  return true;
}

// ─── Return to list ──────────────────────────────────────────────────────────

/**
 * 1st Attempt: return to the Smart Lists view with a single navigation.
 *
 * Clicks a#nav-smart-lists once and waits for clientNameLink to confirm.
 * If the link is already visible (rare edge case), logs and returns immediately.
 * Falls back to a full navigateToSmartList call ONLY if the link click fails
 * to restore the list — no browser.back(), no multi-step cascade.
 */
async function returnToSmartListsDirect(page, listName) {
  logger.info('Returning to Smart Lists once');

  // Already on the list? Nothing to do.
  const alreadyOnList = await page.$(SELECTORS.clientNameLink).catch(() => null);
  if (alreadyOnList) {
    logger.info('Already on Smart Lists list — no navigation needed');
    return;
  }

  // Step 1: try a#nav-smart-lists directly (primary path).
  //
  // Use a fresh locator at the moment of return — never a cached handle.
  // The nav link may be briefly hidden right after Send; poll up to 1500 ms
  // for it to become visible before concluding it is unavailable.
  logger.info('1st Attempt return: trying Smart Lists nav');

  const NAV_SEL   = 'a#nav-smart-lists';
  const pollEnd   = Date.now() + 1500;
  let   navVisible = false;

  do {
    try {
      const el = await page.$(NAV_SEL);
      if (el) navVisible = await el.isVisible().catch(() => false);
    } catch { /* transient — keep polling */ }
    if (!navVisible && Date.now() < pollEnd) await page.waitForTimeout(100);
  } while (!navVisible && Date.now() < pollEnd);

  if (navVisible) {
    try {
      // Re-query a fresh handle at click time so it is never stale.
      const navEl = await page.$(NAV_SEL);
      await navEl.scrollIntoViewIfNeeded();
      await navEl.click();
      logger.info('1st Attempt return: Smart Lists nav clicked');

      // Gate: wait for the client list to appear (New Accounts filter restores
      // automatically when navigating back to the same filtered URL).
      const listAppeared = await page.waitForSelector(SELECTORS.clientNameLink, {
        state:   'visible',
        timeout: 6000,
      }).then(() => true).catch(() => false);

      if (listAppeared) {
        logger.info('1st Attempt return: Smart Lists list restored via nav');
        return;
      }

      // Nav clicked but list did not appear — filter may have reset.
      logger.warn('1st Attempt return: list not visible after nav click — falling back to hard recovery');
    } catch (navErr) {
      logger.warn(`1st Attempt return: nav click error (${navErr.message}) — falling back to hard recovery`);
    }
  } else {
    logger.warn('1st Attempt return: Smart Lists nav unavailable — using hard recovery');
  }

  // Step 2: hard navigate to the accounts URL + re-apply the New Accounts filter.
  await recover1stAttemptList(page, listName);
}

/**
 * Hard recovery for 1st Attempt: go directly to the accounts URL and
 * re-apply the New Accounts status filter from scratch.
 *
 * Used when Smart Lists nav is not present in the DOM (SPA state lost or
 * mid-transition) and returnToSmartListsDirect cannot recover via a nav click.
 */
async function recover1stAttemptList(page, listName) {
  const listConfig  = config.lists[listName] || {};
  const statusValue = listConfig.statusValue || '1';

  logger.info('1st Attempt recovery: opening accounts page directly');
  await navigationWithNetworkRetry(page, config.accountsUrl, {
    waitUntil: 'domcontentloaded',
    timeout: config.defaultTimeout,
  }, 'recover1stAttemptList');
  // Gate: wait for the status dropdown — confirms the accounts filter UI is loaded.
  // Replaces quickSettle(600) with a real readiness signal.

  // Re-apply the status filter
  logger.info('1st Attempt recovery: reapplying New Accounts filter');

  await page.waitForSelector(SELECTORS.statusDropdown, {
    state: 'visible',
    timeout: 8000,
  }).catch(() => {
    logger.warn('Status dropdown not found after hard navigate — continuing anyway');
  });

  await page.selectOption(SELECTORS.statusDropdown, { value: statusValue }).catch((e) => {
    logger.warn(`Could not set status dropdown: ${e.message}`);
  });

  // 150 ms: selectOption is synchronous once resolved; just let DOM settle.
  await page.waitForTimeout(150);

  // Always select the newest available month before re-applying.
  await selectNewestMonthFilter(page);

  const applyBtn = await page.$(SELECTORS.statusFilterApplyButton).catch(() => null);
  if (applyBtn) {
    await applyBtn.scrollIntoViewIfNeeded();
    await applyBtn.click();
  } else {
    logger.warn('Apply filter button not found — list may still load without it');
  }

  // Wait for the client list directly — no blind spaSettle after apply.
  await page.waitForSelector(SELECTORS.clientNameLink, {
    state: 'visible',
    timeout: config.defaultTimeout,
  }).catch(() => {
    logger.warn('Client name links not visible after recovery — run may still continue');
  });

  logger.info('1st Attempt list recovered successfully');
}

/**
 * Return from a client profile to the smart list view.
 * For 2nd/3rd Attempt (nextActionFilter) only — 1st Attempt uses returnToSmartListsDirect.
 *
 * Two-step fallback chain:
 *   1. Try browser back() — fast for SPA navigation.
 *   2. Hard navigate to accountsUrl then re-apply the smart list filter.
 */
async function returnToList(page, listName) {
  logger.info('Returning to smart list…');

  // ── Step 1: Browser back() ──────────────────────────────────────────────
  try {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 8000 });
    await spaSettle(page);
    if (await findFirst(page, SELECTORS.clientNameLink, 4000)) {
      logger.debug('List view restored via browser back()');
      return;
    }
    logger.debug('browser back() did not land on list view — continuing fallback chain');
  } catch (err) {
    logger.debug(`browser back() failed (${err.message}) — continuing fallback chain`);
  }

  // ── Step 2: Hard navigate + re-apply the smart list filter ─────────────
  logger.warn('Falling back to hard navigation — navigating to accounts URL and re-applying filter');
  await page.goto(config.accountsUrl, { waitUntil: 'domcontentloaded', timeout: config.defaultTimeout });
  await spaSettle(page);
  await navigateToSmartList(page, listName);
  logger.debug('List view restored via hard navigation');
}

// ─── Single client processor ─────────────────────────────────────────────────

/**
 * Shared SMS line engine for 1st Attempt (statusFilter lists) — Mac and Windows identical.
 *
 * ctx: { listConfig, mode, delayProfile, clientName, clientProfileUrl, list }
 *
 * Tries each enabled SMS line in order. If a line fails, reloads the profile URL
 * and tries the next. Sends on success. Throws if all lines exhausted.
 */
async function runFirstAttemptShared(page, ctx) {
  const { listConfig, mode, delayProfile, clientName, clientProfileUrl, list } = ctx;
  logger.info(`[PLATFORM_SHARED_FLOW] platform=${process.platform} attempt=1st engine=runFirstAttemptShared client="${clientName}"`);

  const initialLines = await getEnabledSmsLines(page);
  const totalLines = initialLines.length;
  logger.info(`[CLIENT_LINE_SCAN] client="${clientName}" linesDetected=${totalLines}`);
  logger.info(`${clientName}: ${totalLines} enabled SMS line(s) — attempting in order`);

  if (totalLines === 0) {
    logger.warn(`[CLIENT_LINE_SCAN_EMPTY] client="${clientName}" — no enabled SMS lines to attempt`);
    logger.info(`[CLIENT_FINAL_DECISION] client="${clientName}" result=skipped reason=${SKIP_REASONS.NO_ELIGIBLE_LINE}`);
    return { result: 'skipped', reason: SKIP_REASONS.NO_ELIGIBLE_LINE, lineReport: [] };
  }

  let flowSucceeded = false;
  let flowName      = null;
  let sentOnLine    = null;
  // Keyed by stable line identity, not by array position — see getEnabledSmsLines().
  const attemptedLines = new Set();

  // Per-line tallies drive the final skip reason. They are kept separate so a
  // cooldown-only client can never be reported as DNC (or vice versa).
  let cooldownCount  = 0;
  let dncCount       = 0;
  let noComposeCount = 0;
  let errorCount     = 0;
  let lastError      = null;
  const lineReport   = [];

  /** Record one line's outcome for the run log and the final decision. */
  function recordLine(lineNum, state, details) {
    lineReport.push({ line: lineNum, state, details });
    logger.info(
      `[CLIENT_LINE_RESULT] client="${clientName}" line=${lineNum}/${totalLines} ` +
      `state=${state} dnc=${state === 'dnc'} recentlyMessaged=${state === 'recently-messaged'} details="${details}"`
    );
    if (state === 'dnc')                    dncCount++;
    else if (state === 'recently-messaged') cooldownCount++;
    else if (state === 'no-compose')        noComposeCount++;
    else if (state === 'error')             { errorCount++; }
  }

  /** Reload the profile so the next line starts from a clean account view. */
  async function reloadForNextLine(lineNum) {
    const remaining = totalLines - lineNum;
    if (remaining <= 0) {
      logger.info(`[CLIENT_LINE_NO_MORE_LINES] client="${clientName}" after line=${lineNum}`);
      return;
    }
    logger.info(`[CLIENT_LINE_MOVE_NEXT] client="${clientName}" from=${lineNum} remaining=${remaining}`);
    await page.goto(clientProfileUrl, { waitUntil: 'domcontentloaded', timeout: config.defaultTimeout });
    await waitForClientDetailReady(page, 'statusFilter');
  }

  // Walk by stable line identity. Each pass re-reads the live DOM and picks the
  // first line this client has not been tried on yet, so a line vanishing from
  // the enabled set can no longer strand the eligible lines behind it.
  // MAX_PASSES bounds the loop even if the page keeps producing new keys.
  const MAX_PASSES = totalLines * 2 + 2;
  let lineNum = 0;

  for (let pass = 0; pass < MAX_PASSES && !flowSucceeded; pass++) {
    const liveLines = await getEnabledSmsLines(page);
    const target = liveLines.find(l => !attemptedLines.has(l.key));

    if (!target) {
      logger.info(
        `[CLIENT_LINE_ALL_KEYS_ATTEMPTED] client="${clientName}" ` +
        `attempted=${attemptedLines.size} live=${liveLines.length} of ${totalLines} detected`
      );
      // Any line detected up front that never reappeared is reported once, so
      // the tallies still add up against totalLines.
      const missing = totalLines - attemptedLines.size;
      for (let m = 0; m < missing; m++) {
        recordLine(attemptedLines.size + m + 1, 'unavailable', 'line no longer present after reload');
      }
      break;
    }

    attemptedLines.add(target.key);
    lineNum += 1;
    const isFirstAttempt = lineNum === 1;
    const targetButton = target.handle;
    const ctxLabel = `client-${clientName}-line${lineNum}`;
    logger.info(`[CLIENT_LINE_ATTEMPT] client="${clientName}" line=${lineNum}/${totalLines} key=${target.key}`);

    try {
      if (totalLines > 1) {
        logger.info(`${clientName}: trying SMS line ${lineNum}/${totalLines}`);
      }

      let readySignal;
      if (isFirstAttempt) {
        // Line 1 gets a full retry before the loop advances to line 2.
        // Sequence: clicked → waited out the full readiness budget → retried the
        // same line once → failed → only then advance to the next line.
        // The budget is 15 s (waitForFirstAttemptMessageUiReady stages
        // 2 s + 6 s + 7 s), so a single line can occupy up to ~30 s across both
        // attempts. The comment here used to claim ≥20 s per wait, which never
        // matched the stage timings.
        logger.info(`[FIRST_ATTEMPT_LINE1_CLICK_TARGET] client="${clientName}" key=${target.key}`);
        await highlightClickTarget(page, targetButton, 600);
        logger.info(`[FIRST_ATTEMPT_LINE1_CLICKED] client="${clientName}"`);
        logger.info(`[FIRST_ATTEMPT_LINE1_WAIT_START] client="${clientName}"`);
        try {
          readySignal = await clickSmsButton(page, targetButton);
          logger.info(`[FIRST_ATTEMPT_LINE1_UI_READY] client="${clientName}" signal=${readySignal}`);
        } catch (line1Err) {
          logger.warn(`[FIRST_ATTEMPT_LINE1_RETRY_CLICK] client="${clientName}" first attempt failed (${line1Err.message}) — reloading and retrying line 1`);
          await page.goto(clientProfileUrl, { waitUntil: 'domcontentloaded', timeout: config.defaultTimeout });
          await waitForClientDetailReady(page, 'statusFilter');
          // Re-acquire the SAME line by key. The old code retried whatever
          // landed at index 0 after the reload, which could be a different
          // number entirely if the first line had dropped out of the list.
          const retryLines = await getEnabledSmsLines(page);
          const retryTarget = retryLines.find(l => l.key === target.key) ?? null;
          if (!retryTarget) {
            logger.warn(`[FIRST_ATTEMPT_LINE1_FINAL_SKIP] client="${clientName}" — line ${target.key} not present after retry reload`);
            throw new Error(`Line 1 retry: line ${target.key} not present after profile reload`);
          }
          await highlightClickTarget(page, retryTarget.handle, 600);
          logger.info(`[FIRST_ATTEMPT_LINE1_CLICKED] client="${clientName}" attempt=retry`);
          logger.info(`[FIRST_ATTEMPT_LINE1_WAIT_START] client="${clientName}" attempt=retry`);
          try {
            readySignal = await clickSmsButton(page, retryTarget.handle);
            logger.info(`[FIRST_ATTEMPT_LINE1_UI_READY] client="${clientName}" signal=${readySignal} attempt=retry`);
          } catch (retryErr) {
            logger.warn(`[FIRST_ATTEMPT_LINE1_FINAL_SKIP] client="${clientName}" — retry also failed: ${retryErr.message}`);
            throw retryErr;
          }
        }
      } else {
        readySignal = await clickSmsButton(page, targetButton);
      }

      // A hold-on signal means Statflo refused the line up front. Classify it
      // so "already messaged recently" is never confused with a real DNC, then
      // move to the next line on this same account.
      if (readySignal === 'holdOn') {
        const cls = await classifyLineState(page, ctxLabel);
        const state = cls.state === 'eligible' ? 'recently-messaged' : cls.state;
        recordLine(lineNum, state, cls.details);
        await reloadForNextLine(lineNum);
        continue;
      }

      flowName = await runFirstAttemptFlow(page, readySignal);
      flowSucceeded = true;
      sentOnLine = lineNum;
    } catch (lineErr) {
      if (!isPageAlive(page) || lineErr.message?.includes('Target page, context or browser has been closed')) {
        logger.warn('[USER_CLOSED_BROWSER_GRACEFUL_STOP] browser closed during 1st Attempt line attempt');
        throw new BrowserClosedError();
      }

      if (lineErr.isHoldOnBlock) {
        const cls = await classifyLineState(page, ctxLabel);
        const state = cls.state === 'eligible' ? 'recently-messaged' : cls.state;
        logger.warn(`[FIRST_ATTEMPT_HOLD_ON_DETECTED] client="${clientName}" line=${lineNum} state=${state}`);
        logger.info(`[FIRST_ATTEMPT_LINE_SKIPPED_HOLD_ON] client="${clientName}" line=${lineNum}`);
        recordLine(lineNum, state, cls.details);
        await reloadForNextLine(lineNum);
        continue;
      }

      // The line threw for some other reason. Before calling it a bot failure,
      // check whether the page is simply telling us the line is DNC, in
      // cooldown, or has no way to compose — those are skips, not failures.
      const cls = await classifyLineState(page, ctxLabel).catch(() => ({ state: 'eligible', details: '' }));
      if (cls.state !== 'eligible') {
        logger.warn(`[CLIENT_LINE_BLOCKED] client="${clientName}" line=${lineNum} state=${cls.state} details="${cls.details}"`);
        recordLine(lineNum, cls.state, cls.details);
        await reloadForNextLine(lineNum);
        continue;
      }

      lastError = lineErr;
      recordLine(lineNum, 'error', lineErr.message);
      const remaining = totalLines - lineNum;
      logger.warn(
        `${clientName}: SMS line ${lineNum} failed` +
        (remaining > 0 ? ` — ${remaining} more line(s) to try` : ' — no more lines') +
        `\n  reason: ${lineErr.message}`
      );
      if (remaining > 0) {
        logger.info(`${clientName}: reloading client profile to try next SMS line`);
      }
      await reloadForNextLine(lineNum);
    }
  }

  if (!flowSucceeded) {
    if (!isPageAlive(page)) throw new Error('Target page, context or browser has been closed');

    logger.info(
      `[CLIENT_LINE_SUMMARY] client="${clientName}" lines=${totalLines} attempted=${attemptedLines.size} ` +
      `dnc=${dncCount} recentlyMessaged=${cooldownCount} noCompose=${noComposeCount} errors=${errorCount}`
    );

    // This path used to throw, and processClient's catch did the navigation.
    // Now that it returns normally, it must restore the list itself or the next
    // client would be looked up while still on this client's profile page.
    await returnToSmartListsDirect(page, list)
      .catch(e => logger.warn(`[RETURNTOLIST_AFTER_SKIP_WARN] ${e.message}`));

    // Only a genuine bot/UI error counts as a failure. If any line was blocked
    // for a business reason, the client is skipped — that is what stopped
    // cooldown/DNC clients from inflating the failed count.
    if (errorCount > 0 && cooldownCount === 0 && dncCount === 0 && noComposeCount === 0) {
      logger.error(`[CLIENT_FINAL_DECISION] client="${clientName}" result=failed reason=bot-error error="${lastError?.message ?? 'unknown'}"`);
      return { result: 'failed', reason: 'bot-error', error: lastError, lineReport };
    }

    const reason = resolveSkipReason({ totalLines, cooldownCount, dncCount, noComposeCount });
    if (errorCount > 0) {
      logger.warn(`[CLIENT_LINE_MIXED_OUTCOME] client="${clientName}" ${errorCount} line error(s) alongside blocked lines — skipping rather than failing`);
    }
    logger.warn(`[CLIENT_SKIPPED] client="${clientName}" reason=${reason} lines=${totalLines} dnc=${dncCount} recentlyMessaged=${cooldownCount}`);
    logger.info(`[CLIENT_FINAL_DECISION] client="${clientName}" result=skipped reason=${reason}`);
    return { result: 'skipped', reason, lineReport };
  }

  const flowLabel = flowName === 'topPremade'        ? 'top premade flow'
                  : flowName === 'bottomChatStarter' ? 'Chat Starter flow'
                  : flowName === 'sendAreaReady'     ? 'send area already ready'
                  : flowName;
  logger.info(`${clientName}: ${flowLabel} complete — Send button confirmed enabled`);

  logger.info('[MODE] LIVE');
  const isDupe1st = await checkForDuplicateMessage(page, listConfig.text);
  let sendAccepted = false;
  if (isDupe1st) {
    logger.warn(`[DUPLICATE_PROTECTION] ${clientName}: skipping send — last message already matches template`);
  } else {
    await clickSend(page);
    // Brief fast-signal check — any Statflo send-accepted indicator (max 1.5 s).
    // Do NOT wait for Phase 2 delivery confirmation: Statflo may hold the message
    // in a pending/queued state for a long time before final delivery.
    const fastSignal = await waitForSendStarted(page, 1500).catch(() => false);
    sendAccepted = !!fastSignal;
    if (fastSignal) {
      logger.info('[SEND_STARTED_FAST] send-accepted signal detected');
    }
    // Treat as queued regardless of signal — Statflo will deliver later.
    logger.info('[SEND_ASSUMED_QUEUED_CONTINUE] send assumed queued by Statflo — not waiting for final delivery confirmation');
    logger.success(`${clientName}: Message SENT`);
    logger.info('[SMS_SENT] mode=normal');
    logger.info(`[CLIENT_REMEMBERED_AFTER_SEND_CLICK] client="${clientName}" — will be skipped if still visible on list return`);
  }

  logger.info(`[POST_SEND_ACCEPTED_FLAG] accepted=${sendAccepted}`);
  try {
    if (sendAccepted) {
      await applyFastReturnDelay(page).catch(() => {});
    } else {
      try { await humanDelay(page, delayProfile); } catch { /* page closed */ }
    }
    await returnToSmartListsDirect(page, list);
  } catch (returnErr) {
    logger.warn(`[POST_SEND_RETURN_WARN] return-to-list after successful send failed (non-fatal): ${returnErr.message}`);
  }

  logger.info(
    `[CLIENT_LINE_SUMMARY] client="${clientName}" lines=${totalLines} attempted=${attemptedLines.size} ` +
    `dnc=${dncCount} recentlyMessaged=${cooldownCount} noCompose=${noComposeCount} errors=${errorCount} sentOnLine=${sentOnLine}`
  );
  logger.info(`[CLIENT_FINAL_DECISION] client="${clientName}" result=sent reason=sent-line-${sentOnLine}`);
  return { result: 'messaged', reason: `sent-line-${sentOnLine}`, sentOnLine, lineReport };
}

/**
 * DOM-readiness gate for Everyone Mode.
 * Called after sends and page transitions to ensure the SPA has settled
 * before the next action. Waits up to 9s for any known stable element.
 */
async function waitForEveryoneModeReady(page, contextLabel) {
  logger.info(`[EVERYONE_MODE_PAGE_SETTLE_START] context=${contextLabel}`);
  await spaSettle(page);

  const SIGNALS = [
    'button.dialTwilio.js-trigger-twilio-message.row-icon-sms',
    'textarea#message-input',
    'textarea[placeholder*="message" i]',
    'a.crm-list-account-name',
    'button[data-testid^="smartlist-card-"]',
  ];
  const SETTLE_TIMEOUT = 9000;
  const deadline = Date.now() + SETTLE_TIMEOUT;
  let signal = null;

  outer: while (Date.now() < deadline) {
    for (const sel of SIGNALS) {
      try {
        const el = await page.$(sel);
        if (el) { signal = sel; break outer; }
      } catch { /* navigation in progress */ }
    }
    await page.waitForTimeout(200);
  }

  if (signal) {
    logger.info(`[EVERYONE_MODE_PAGE_SETTLE_DONE] context=${contextLabel} signal=${signal}`);
  } else {
    logger.warn(`[EVERYONE_MODE_PAGE_SETTLE_TIMEOUT] context=${contextLabel} — no readiness signal in ${SETTLE_TIMEOUT}ms`);
  }
}

/**
 * Everyone Mode variant of runFirstAttemptShared.
 * Sends to ALL enabled SMS lines instead of stopping at first success.
 */
async function runFirstAttemptEveryoneMode(page, ctx) {
  const { listConfig, mode, delayProfile, clientName, clientProfileUrl, list } = ctx;
  logger.info(`[EVERYONE_MODE_ON] mode=first client="${clientName}"`);
  logger.info(`[EVERYONE_FIRST_START] client="${clientName}" lines=scanning`);

  // Keyed up front so each line is re-found by identity after every reload,
  // rather than by a position that shifts when a line drops out of the list.
  const initialLines = await getEnabledSmsLines(page);
  // Everyone Mode sends to EVERY line, so an unstable identity is a duplicate
  // send waiting to happen: if two buttons key the same and the DOM reorders
  // between lines, the walk re-finds the wrong one and messages a number twice
  // while missing another. When identity is not unique, message only the first
  // line and report the rest — one missed line is recoverable, a second text to
  // the same customer is not.
  const keysAreAmbiguous = !hasLineBoundIdentity(initialLines);
  const lineKeys     = keysAreAmbiguous
    ? initialLines.slice(0, 1).map(l => l.key)
    : initialLines.map(l => l.key);
  const totalLines   = lineKeys.length;
  if (keysAreAmbiguous) {
    logger.warn(
      `[EVERYONE_LINE_WALK_RESTRICTED] client="${clientName}" — SMS lines are not identified by phone number; ` +
      `messaging only line 1 of ${initialLines.length} to rule out a duplicate send`
    );
  }
  logger.info(`[EVERYONE_FIRST_START] ${totalLines} SMS line(s) found`);
  logger.info(`[CLIENT_LINE_SCAN] client="${clientName}" linesDetected=${totalLines} mode=everyone`);

  if (totalLines === 0) {
    logger.warn(`[CLIENT_LINE_SCAN_EMPTY] client="${clientName}" mode=everyone`);
    logger.info(`[CLIENT_FINAL_DECISION] client="${clientName}" result=skipped reason=${SKIP_REASONS.NO_ELIGIBLE_LINE}`);
    return { result: 'skipped', reason: SKIP_REASONS.NO_ELIGIBLE_LINE, lineReport: [] };
  }

  let anySent = false;
  let sentCount = 0;

  // Separate tallies so cooldown is never reported as DNC.
  let cooldownCount  = 0;
  let dncCount       = 0;
  let noComposeCount = 0;
  let errorCount     = 0;
  let lastError      = null;
  const lineReport   = [];

  function recordLine(lineNum, state, details) {
    lineReport.push({ line: lineNum, state, details });
    logger.info(
      `[CLIENT_LINE_RESULT] client="${clientName}" line=${lineNum}/${totalLines} ` +
      `state=${state} dnc=${state === 'dnc'} recentlyMessaged=${state === 'recently-messaged'} details="${details}"`
    );
    if (state === 'dnc')                    dncCount++;
    else if (state === 'recently-messaged') cooldownCount++;
    else if (state === 'no-compose')        noComposeCount++;
    else if (state === 'error')             errorCount++;
  }

  for (let lineIdx = 0; lineIdx < totalLines; lineIdx++) {
    const lineKey = lineKeys[lineIdx];
    logger.info(`[EVERYONE_LINE_START] index=${lineIdx} displayLine=${lineIdx + 1} client="${clientName}" key=${lineKey}`);

    // Re-query lines on the current page state — no reload before line 0.
    const freshLines  = await getEnabledSmsLines(page);
    const targetLine  = freshLines.find(l => l.key === lineKey);
    if (!targetLine) {
      logger.warn(`[EVERYONE_LINE_SKIPPED] index=${lineIdx} displayLine=${lineIdx + 1} reason=not-available key=${lineKey}`);
      // Record it: without this the line report was shorter than totalLines and
      // the summary tallies did not add up to the number of lines detected.
      recordLine(lineIdx + 1, 'unavailable', `line ${lineKey} no longer present`);
      // Still need to reload for subsequent lines even if this one was skipped.
      if (lineIdx < totalLines - 1) {
        await navigationWithNetworkRetry(page, clientProfileUrl, { waitUntil: 'domcontentloaded', timeout: config.defaultTimeout }, 'everyone-mode-1st-reload');
        await waitForClientDetailReady(page, 'statusFilter');
      }
      continue;
    }
    const targetButton = targetLine.handle;

    try {
      let readySignal;
      if (lineIdx === 0) {
        // Everyone Mode: line 1 gets extended wait + one retry before being skipped.
        logger.info(`[FIRST_ATTEMPT_LINE1_CLICK_TARGET] client="${clientName}" key=${lineKey}`);
        await highlightClickTarget(page, targetButton, 600);
        logger.info(`[FIRST_ATTEMPT_LINE1_CLICKED] client="${clientName}"`);
        logger.info(`[FIRST_ATTEMPT_LINE1_WAIT_START] client="${clientName}"`);
        try {
          readySignal = await clickSmsButton(page, targetButton);
          logger.info(`[FIRST_ATTEMPT_LINE1_UI_READY] client="${clientName}" signal=${readySignal}`);
        } catch (line1Err) {
          logger.warn(`[FIRST_ATTEMPT_LINE1_RETRY_CLICK] client="${clientName}" first attempt failed (${line1Err.message}) — reloading and retrying`);
          await navigationWithNetworkRetry(page, clientProfileUrl, { waitUntil: 'domcontentloaded', timeout: config.defaultTimeout }, 'everyone-line1-retry');
          await waitForClientDetailReady(page, 'statusFilter');
          // Retry the SAME line by key — retrying whatever landed at index 0
          // could text a different number than the one that just failed.
          const retryLines  = await getEnabledSmsLines(page);
          const retryTarget = retryLines.find(l => l.key === lineKey);
          if (!retryTarget) {
            logger.warn(`[FIRST_ATTEMPT_LINE1_FINAL_SKIP] client="${clientName}" — line ${lineKey} not present after retry reload`);
            throw new Error(`Everyone line 1 retry: line ${lineKey} not present after reload`);
          }
          await highlightClickTarget(page, retryTarget.handle, 600);
          logger.info(`[FIRST_ATTEMPT_LINE1_CLICKED] client="${clientName}" attempt=retry`);
          logger.info(`[FIRST_ATTEMPT_LINE1_WAIT_START] client="${clientName}" attempt=retry`);
          try {
            readySignal = await clickSmsButton(page, retryTarget.handle);
            logger.info(`[FIRST_ATTEMPT_LINE1_UI_READY] client="${clientName}" signal=${readySignal} attempt=retry`);
          } catch (retryErr) {
            logger.warn(`[FIRST_ATTEMPT_LINE1_FINAL_SKIP] client="${clientName}" — retry also failed: ${retryErr.message}`);
            throw retryErr;
          }
        }
      } else {
        readySignal = await clickSmsButton(page, targetButton);
      }

      await runFirstAttemptFlow(page, readySignal);

      const isDupe = await checkForDuplicateMessage(page, listConfig.text);
      if (isDupe) {
        logger.warn(`[DUPLICATE_PROTECTION] ${clientName} line=${lineIdx + 1}: last message matches template — counting as sent`);
        anySent = true;
        sentCount++;
        recordLine(lineIdx + 1, 'sent', 'duplicate-protection (already matches template)');
        logger.info(`[EVERYONE_LINE_SENT] index=${lineIdx} displayLine=${lineIdx + 1} client="${clientName}" source=dupe`);
      } else {
        await clickSend(page);
        const confirmed = await waitForMessageDeliveryConfirmation(page, 10000);
        if (confirmed) {
          logger.success(`[EVERYONE_LINE_SENT] index=${lineIdx} displayLine=${lineIdx + 1} client="${clientName}"`);
          anySent = true;
          sentCount++;
          recordLine(lineIdx + 1, 'sent', 'delivery confirmed');
          await waitForEveryoneModeReady(page, `post-send-line${lineIdx + 1}`);
          const rateDelay = 1200 + Math.floor(Math.random() * 800);
          logger.info(`[EVERYONE_MODE_RATE_LIMIT_DELAY] waiting ${rateDelay}ms between lines`);
          await page.waitForTimeout(rateDelay);
        } else {
          logger.warn(`[EVERYONE_LINE_SKIPPED] index=${lineIdx} displayLine=${lineIdx + 1} reason=delivery-not-confirmed`);
          recordLine(lineIdx + 1, 'error', 'delivery not confirmed');
        }
      }
    } catch (lineErr) {
      if (lineErr.isUncertainSend) throw lineErr;
      if (!isPageAlive(page) || lineErr.message?.includes('Target page, context or browser has been closed')) {
        logger.warn(`[USER_CLOSED_BROWSER_GRACEFUL_STOP] browser closed during line ${lineIdx + 1} — stopping Everyone Mode (1st)`);
        break;
      }

      const ctxLabel = `everyone-${clientName}-line${lineIdx + 1}`;
      if (lineErr.isHoldOnBlock) {
        const cls = await classifyLineState(page, ctxLabel);
        const state = cls.state === 'eligible' ? 'recently-messaged' : cls.state;
        logger.warn(`[FIRST_ATTEMPT_HOLD_ON_DETECTED] client="${clientName}" line=${lineIdx + 1} state=${state}`);
        logger.info(`[FIRST_ATTEMPT_LINE_SKIPPED_HOLD_ON] client="${clientName}" line=${lineIdx + 1}`);
        recordLine(lineIdx + 1, state, cls.details);
      } else {
        const cls = await classifyLineState(page, ctxLabel).catch(() => ({ state: 'eligible', details: '' }));
        if (cls.state !== 'eligible') {
          logger.warn(`[CLIENT_LINE_BLOCKED] client="${clientName}" line=${lineIdx + 1} state=${cls.state} details="${cls.details}"`);
          recordLine(lineIdx + 1, cls.state, cls.details);
        } else {
          lastError = lineErr;
          logger.warn(`[EVERYONE_LINE_SKIPPED] index=${lineIdx} displayLine=${lineIdx + 1} reason=${lineErr.message}`);
          recordLine(lineIdx + 1, 'error', lineErr.message);
        }
      }
    }

    // Reload profile AFTER each line so the next iteration starts clean.
    // This applies to every line including index 0 — never skip.
    if (lineIdx < totalLines - 1) {
      await navigationWithNetworkRetry(page, clientProfileUrl, { waitUntil: 'domcontentloaded', timeout: config.defaultTimeout }, 'everyone-mode-1st-reload');
      await waitForClientDetailReady(page, 'statusFilter');
      await waitForEveryoneModeReady(page, `profile-reload-line${lineIdx + 1}`);
      const rateDelay = 1200 + Math.floor(Math.random() * 800);
      logger.info(`[EVERYONE_MODE_RATE_LIMIT_DELAY] waiting ${rateDelay}ms before next line`);
      await page.waitForTimeout(rateDelay);
    }
  }

  logger.info(`[EVERYONE_FIRST_COMPLETE] client="${clientName}" anySent=${anySent}`);
  try { await humanDelay(page, delayProfile); } catch { /* page closed */ }
  await returnToSmartListsDirect(page, list);

  logger.info(
    `[CLIENT_LINE_SUMMARY] client="${clientName}" mode=everyone lines=${totalLines} sent=${sentCount} ` +
    `dnc=${dncCount} recentlyMessaged=${cooldownCount} noCompose=${noComposeCount} errors=${errorCount}`
  );

  if (anySent) {
    logger.info(`[CLIENT_FINAL_DECISION] client="${clientName}" result=sent reason=everyone-sent-${sentCount}-line(s)`);
    return { result: 'messaged', reason: `everyone-sent-${sentCount}-lines`, sentCount, lineReport };
  }

  // Nothing sent — fail only on a genuine bot/UI error, skip otherwise.
  if (errorCount > 0 && cooldownCount === 0 && dncCount === 0 && noComposeCount === 0) {
    logger.error(`[CLIENT_FINAL_DECISION] client="${clientName}" result=failed reason=bot-error error="${lastError?.message ?? 'unknown'}"`);
    return { result: 'failed', reason: 'bot-error', error: lastError, lineReport };
  }

  const reason = resolveSkipReason({ totalLines, cooldownCount, dncCount, noComposeCount });
  if (errorCount > 0) {
    logger.warn(`[CLIENT_LINE_MIXED_OUTCOME] client="${clientName}" ${errorCount} line error(s) alongside blocked lines — skipping rather than failing`);
  }
  logger.warn(`[CLIENT_SKIPPED] client="${clientName}" reason=${reason} lines=${totalLines} dnc=${dncCount} recentlyMessaged=${cooldownCount}`);
  logger.info(`[CLIENT_FINAL_DECISION] client="${clientName}" result=skipped reason=${reason}`);
  return { result: 'skipped', reason, lineReport };
}

/**
 * Everyone Mode variant for 2nd/3rd Attempt.
 * Tries direct composer first, then sends to ALL SMS lines via View Account.
 * Returns 'messaged' if any send succeeded, 'skipped' otherwise.
 */
async function runNextActionEveryoneMode(page, clientNum, listConfig, mode, delayProfile, listName) {
  logger.info(`[EVERYONE_MODE_ON] mode=next client=${clientNum}`);
  logger.info(`[EVERYONE_NEXTACTION_START] client=${clientNum} list="${listName}"`);

  let anySent             = false;
  let directSent          = false; // tracks whether direct composer already used line 0
  let cooldownBlockedCount = 0;    // lines skipped due to recent-contact cooldown
  let dncBlockedCount      = 0;    // lines skipped because that line is truly DNC
  let unavailableLineCount = 0;    // lines detected up front that vanished before their turn

  // ── Step 1: Try direct composer ────────────────────────────────────────────
  try {
    logger.info(`[EVERYONE_NEXTACTION_DIRECT_TRY] client=${clientNum}`);
    await runNextActionAttemptShared(page, clientNum, listConfig, mode, delayProfile);
    logger.info(`[EVERYONE_NEXTACTION_DIRECT_SENT] client=${clientNum}`);
    anySent    = true;
    directSent = true; // direct composer sent on the primary (first) SMS line
  } catch (directErr) {
    if (directErr.isUncertainSend) throw directErr;
    logger.info(`[EVERYONE_NEXTACTION_DIRECT_SKIP] reason=${directErr.message}`);
  }

  // ── Step 2: View Account → send to remaining SMS lines ────────────────────
  // Skip line 0 when direct composer already sent to it to prevent double-message.
  const startLineIdx = directSent ? 1 : 0;

  try {
    await dismissOneSignalOverlay(page);
    await clickViewAccount(page);
    await page.waitForTimeout(600);

    const accountProfileUrl = page.url();
    logger.info(`[EVERYONE_NEXTACTION_PROFILE_URL] url=${accountProfileUrl}`);

    // Everyone Mode messages EVERY line, so the walk is driven by the list of
    // line identities captured up front rather than by array positions. After a
    // profile restore the DOM order can change and lines can drop out; looking
    // the line up by key means the right number is always clicked, and a line
    // that vanished is reported as skipped instead of silently shifting a
    // different number into its slot.
    let enabledLines   = await keySmsLineHandles(await querySmsLinesGlobally(page));
    // Same duplicate-send protection as the 1st-attempt Everyone engine: if the
    // lines cannot be told apart reliably, message only the first one.
    const keysAreAmbiguous = !hasLineBoundIdentity(enabledLines);
    const lineKeys     = keysAreAmbiguous
      ? enabledLines.slice(0, 1).map(l => l.key)
      : enabledLines.map(l => l.key);
    const totalLines   = lineKeys.length;
    if (keysAreAmbiguous) {
      logger.warn(
        `[EVERYONE_LINE_WALK_RESTRICTED] client=${clientNum} — SMS lines are not identified by phone number; ` +
        `messaging only line 1 of ${enabledLines.length} to rule out a duplicate send`
      );
    }
    logger.info(`[EVERYONE_NEXTACTION_LINE_SCAN] ${totalLines} SMS line(s) found startIdx=${startLineIdx}`);

    for (let lineIdx = startLineIdx; lineIdx < totalLines; lineIdx++) {
      const lineKey = lineKeys[lineIdx];
      logger.info(`[EVERYONE_LINE_START] index=${lineIdx} displayLine=${lineIdx + 1} client=${clientNum} key=${lineKey}`);
      logger.info(`[EVERYONE_NEXTACTION_LINE_ATTEMPT] line=${lineIdx + 1}/${totalLines} client=${clientNum}`);
      logger.info(`[SMS_LINE_CLICK_TARGET] index=${lineIdx} displayLine=${lineIdx + 1} total=${totalLines}`);
      logger.info(`[SMS_LINE_ATTEMPT_START] line=${lineIdx + 1} total=${totalLines} client=${clientNum} mode=everyone`);

      if (lineIdx > startLineIdx) {
        logger.info(`[EVERYONE_LINE_PROFILE_RESTORE_NEEDED] line=${lineIdx + 1}`);
        if (!isPageAlive(page)) {
          logger.warn('[PAGE_CLOSED_GRACEFUL_STOP] page closed before restore — stopping Everyone Mode');
          break;
        }
        enabledLines = await keySmsLineHandles(await restoreProfileAndRequerySmsLines(page, accountProfileUrl));
        logger.info(`[EVERYONE_LINE_REQUERY_READY] line=${lineIdx + 1} enabled=${enabledLines.length}`);
        await waitForEveryoneModeReady(page, `profile-restore-line${lineIdx + 1}`);
        const rateDelay = 1200 + Math.floor(Math.random() * 800);
        logger.info(`[EVERYONE_MODE_RATE_LIMIT_DELAY] waiting ${rateDelay}ms before next line`);
        await page.waitForTimeout(rateDelay);
      } else {
        logger.info(`[EVERYONE_LINE_PROFILE_RESTORE_SKIPPED] line=${lineIdx + 1} reason=already-on-profile`);
      }

      const targetLine = enabledLines.find(l => l.key === lineKey);
      if (!targetLine) {
        // Counted so the summary accounts for every line detected up front,
        // instead of silently reporting fewer lines than were scanned.
        unavailableLineCount++;
        logger.warn(`[EVERYONE_LINE_SKIPPED] index=${lineIdx} displayLine=${lineIdx + 1} reason=not-available key=${lineKey}`);
        logger.warn(`[EVERYONE_NEXTACTION_LINE_SKIP] line=${lineIdx + 1} no longer available`);
        continue;
      }

      const btn = targetLine.handle;
      logger.info(`[EVERYONE_SMS_LINE_CLICK_SAFE_START] line=${lineIdx + 1}`);
      try {
        await btn.evaluate(el => el.scrollIntoView({ block: 'nearest', behavior: 'instant' }));
        await safeWait(page, 150);
        await highlightClickTarget(page, btn, 600);
        logger.info(`[CLICK_TARGET_HIGHLIGHT] type=sms-line index=${lineIdx} displayLine=${lineIdx + 1}`);
        await btn.evaluate(el => el.click());
        logger.info(`[EVERYONE_SMS_LINE_CLICK_SAFE_DONE] line=${lineIdx + 1}`);
        logger.info(`[EVERYONE_NEXTACTION_LINE_CLICK] line=${lineIdx + 1}`);
      } catch (clickErr) {
        logger.warn(`[EVERYONE_NEXTACTION_LINE_CLICK_ERROR] line=${lineIdx + 1}: ${clickErr.message}`);
        continue;
      }

      // Wait for composer/first-contact UI — do NOT use URL-change as success signal.
      // Statflo SMS line clicks are SPA navigations that may keep the same URL;
      // verifying by URL caused false failures (~7 s wasted restore per line).
      await safeWait(page, 600);
      const urlAfterClick = page.url();
      if (urlAfterClick === (page._everyoneProfileUrl ?? accountProfileUrl)) {
        logger.info(`[SMS_LINE_CLICK_NO_URL_CHANGE_IGNORED] line=${lineIdx + 1} — URL unchanged; verifying by composer UI`);
      }
      logger.info(`[SMS_LINE_CLICK_VERIFY_BY_UI] line=${lineIdx + 1} — waiting for composer/first-contact UI`);

      logger.info(`[EVERYONE_SMS_COMPOSER_WAIT_AFTER_LINE_CLICK_START] line=${lineIdx + 1}`);
      const composerResult = await waitForComposerAfterSmsLineClick(page, 13000);
      logger.info(`[EVERYONE_SMS_COMPOSER_WAIT_AFTER_LINE_CLICK_RESULT] line=${lineIdx + 1} found=${composerResult.found} blockedByRecentContact=${composerResult.blockedByRecentContact ?? false}`);
      if (!composerResult.found) {
        const cooldown = composerResult.blockedByRecentContact
          ? {
              blocked: true,
              // Preserve the detector's verdict — synthesising this object
              // without `kind` made every timeout block count as a cooldown.
              kind:    composerResult.blockKind ?? 'cooldown',
              details: composerResult.blockDetails || 'detected by composer-timeout',
            }
          : await detectSmsBlockedOrCooldownState(page, `everyone-composer-line${lineIdx + 1}`);
        if (cooldown.blocked && cooldown.kind === 'dnc') {
          dncBlockedCount++;
          logger.warn(`[SMS_LINE_DNC_SKIPPED] line=${lineIdx + 1} client=${clientNum} — ${cooldown.details} — skipping this line, checking next`);
        } else if (cooldown.blocked) {
          cooldownBlockedCount++;
          logger.warn(`[SMS_LINE_UNAVAILABLE_RECENT_CONTACT] line=${lineIdx + 1} client=${clientNum} — ${cooldown.details}`);
          logger.warn(`[SMS_LINE_COOLDOWN_SKIP_NO_DNC] line=${lineIdx + 1} client=${clientNum} cooldownCount=${cooldownBlockedCount}`);
          logger.warn(`[EVERYONE_LINE_COOLDOWN_SKIPPED] line=${lineIdx + 1} client=${clientNum}`);
        }
        logger.warn(`[SMS_LINE_ATTEMPT_RESULT] line=${lineIdx + 1} result=${cooldown.blocked ? 'cooldown' : 'no-composer'} mode=everyone`);
        logger.warn(`[EVERYONE_NEXTACTION_COMPOSER_NOT_FOUND] line=${lineIdx + 1}`);
        continue;
      }

      if (composerResult.type === 'firstContact') {
        logger.info(`[NEXTACTION_FIRST_CONTACT_CHOOSER_DETECTED] line=${lineIdx + 1} — calling sendFirstContactPremadeInEveryoneMode`);
        const sent = await sendFirstContactPremadeInEveryoneMode(page, clientNum, lineIdx + 1);
        if (sent) {
          logger.info(`[SMS_LINE_ATTEMPT_RESULT] line=${lineIdx + 1} result=sent mode=everyone-first-contact`);
          logger.success(`[EVERYONE_LINE_SENT] index=${lineIdx} displayLine=${lineIdx + 1} client=${clientNum}`);
          anySent = true;
        } else {
          logger.warn(`[SMS_LINE_ATTEMPT_RESULT] line=${lineIdx + 1} result=first-contact-failed mode=everyone`);
          logger.warn(`[NEXTACTION_PREMADE_FALLBACK_SKIPPED] line=${lineIdx + 1} — first-contact send failed; restoring profile`);
          enabledLines = await keySmsLineHandles(await restoreProfileAndRequerySmsLines(page, accountProfileUrl));
        }
        continue;
      }

      try {
        await focusAndFillComposerAfterDnc(page, listConfig.text);
        logger.info(`[EVERYONE_NEXTACTION_FILLED] line=${lineIdx + 1}`);
      } catch (fillErr) {
        logger.warn(`[EVERYONE_NEXTACTION_FILL_ERROR] line=${lineIdx + 1}: ${fillErr.message}`);
        continue;
      }

      let sendReady = await pollSendEnabled(page, 3000);
      if (!sendReady) {
        sendReady = await retrySendReadyAfterComposerRefresh(page, lineIdx + 1, listConfig.text);
        if (sendReady) {
          logger.info(`[EVERYONE_SEND_READY_RECOVERED_AFTER_REFRESH] line=${lineIdx + 1}`);
        }
      }
      if (!sendReady) {
        const cooldown = await detectSmsBlockedOrCooldownState(page, `everyone-send-line${lineIdx + 1}`);
        if (cooldown.blocked && cooldown.kind === 'dnc') {
          dncBlockedCount++;
          logger.warn(`[SMS_LINE_DNC_SKIPPED] line=${lineIdx + 1} client=${clientNum} — ${cooldown.details} — skipping this line, checking next`);
        } else if (cooldown.blocked) {
          cooldownBlockedCount++;
          logger.warn(`[SMS_LINE_UNAVAILABLE_RECENT_CONTACT] line=${lineIdx + 1} client=${clientNum} — ${cooldown.details}`);
          logger.warn(`[SMS_LINE_COOLDOWN_SKIP_NO_DNC] line=${lineIdx + 1} client=${clientNum} cooldownCount=${cooldownBlockedCount}`);
        }
        logger.warn(`[SMS_LINE_ATTEMPT_RESULT] line=${lineIdx + 1} result=${cooldown.blocked ? 'cooldown' : 'disabled'} mode=everyone`);
        logger.warn(`[EVERYONE_LINE_COOLDOWN_SKIPPED] line=${lineIdx + 1} client=${clientNum}`);
        logger.warn(`[EVERYONE_NEXTACTION_SEND_BLOCKED] line=${lineIdx + 1}: cooldown — skipping`);
        continue;
      }

      const isDupe = await checkForDuplicateMessage(page, listConfig.text);
      if (isDupe) {
        logger.warn(`[DUPLICATE_PROTECTION] client=${clientNum} line=${lineIdx + 1}: matches template — counting as sent`);
        anySent = true;
      } else {
        await clickSend(page);
        const confirmed = await waitForMessageDeliveryConfirmation(page, 10000);
        if (confirmed) {
          logger.success(`[EVERYONE_LINE_SENT] index=${lineIdx} displayLine=${lineIdx + 1} client=${clientNum}`);
          logger.success(`[EVERYONE_NEXTACTION_LINE_SENT] client=${clientNum} line=${lineIdx + 1} SENT`);
          logger.info(`[SMS_LINE_ATTEMPT_RESULT] line=${lineIdx + 1} result=sent mode=everyone`);
          anySent = true;
          await waitForEveryoneModeReady(page, `post-send-line${lineIdx + 1}`);
          const rateDelay = 1200 + Math.floor(Math.random() * 800);
          logger.info(`[EVERYONE_MODE_RATE_LIMIT_DELAY] waiting ${rateDelay}ms before next line`);
          await page.waitForTimeout(rateDelay);
        } else {
          logger.warn(`[SMS_LINE_ATTEMPT_RESULT] line=${lineIdx + 1} result=not-confirmed mode=everyone`);
          logger.warn(`[EVERYONE_LINE_SKIPPED] index=${lineIdx} displayLine=${lineIdx + 1} reason=delivery-not-confirmed`);
          logger.warn(`[SEND_NOT_CONFIRMED] client=${clientNum} line=${lineIdx + 1}: delivery not confirmed`);
        }
      }
    }
  } catch (fallbackErr) {
    if (fallbackErr.isUncertainSend) throw fallbackErr;
    if (!isPageAlive(page) || fallbackErr.message?.includes('Target page, context or browser has been closed') || fallbackErr.message?.includes('Target closed')) {
      logger.warn('[USER_CLOSED_BROWSER_GRACEFUL_STOP] browser closed during Everyone Mode — stopping gracefully');
      logger.info(`[RUN_STOPPED_PAGE_CLOSED] client=${clientNum}`);
      return anySent ? 'messaged' : 'skipped';
    }
    logger.warn(`[EVERYONE_NEXTACTION_FALLBACK_ERROR] ${fallbackErr.message}`);
  }

  logger.info(`[EVERYONE_NEXTACTION_COMPLETE] client=${clientNum} anySent=${anySent} cooldownBlocked=${cooldownBlockedCount} dncBlocked=${dncBlockedCount} unavailable=${unavailableLineCount}`);
  logger.info(`[CLIENT_LINE_SUMMARY] client=${clientNum} mode=everyone-next dnc=${dncBlockedCount} recentlyMessaged=${cooldownBlockedCount} unavailable=${unavailableLineCount}`);

  if (!anySent && (cooldownBlockedCount > 0 || dncBlockedCount > 0)) {
    const reason = resolveSkipReason({
      totalLines:     cooldownBlockedCount + dncBlockedCount,
      cooldownCount:  cooldownBlockedCount,
      dncCount:       dncBlockedCount,
      noComposeCount: 0,
    });
    logger.warn(`[EVERYONE_CLIENT_SKIPPED_RECENT_CONTACT_NO_DNC] client=${clientNum} — cooldown=${cooldownBlockedCount} dnc=${dncBlockedCount}, no send path`);
    logger.info(`[CLIENT_FINAL_DECISION] client=${clientNum} result=skipped reason=${reason}`);
    return { result: 'skipped', reason };
  }

  if (!anySent) {
    logger.warn(`[CLIENT_SKIPPED_NO_AVAILABLE_LINES] client=${clientNum} — no lines available`);
    logger.info(`[CLIENT_FINAL_DECISION] client=${clientNum} result=skipped reason=${SKIP_REASONS.NO_ELIGIBLE_LINE}`);
    return { result: 'skipped', reason: SKIP_REASONS.NO_ELIGIBLE_LINE };
  }

  logger.info(`[CLIENT_FINAL_DECISION] client=${clientNum} result=messaged reason=everyone-sent`);
  return 'messaged';
}

/**
 * Process one client at rowIndex.
 * Returns: 'messaged' | 'dnc' | 'skipped' | 'failed'
 */
async function processClient(page, rowIndex, runConfig) {
  const { list, mode, delayProfile } = runConfig;
  const listConfig = config.lists[list];

  const navMode = listConfig.navMode || 'nextActionFilter';

  logger.info(`─── Client ${rowIndex + 1} ───`);

  // Hoisted so catch block can reference them for hold-on / page-closed bookkeeping.
  let clientName = `Client #${rowIndex + 1}`;
  let clientKey  = ''; // populated in the statusFilter branch; '' for nextActionFilter

  try {
    let clientHref = '';

    if (navMode === 'nextActionFilter') {
      // 2nd / 3rd Attempt: clients are in the Conversations Smart Lists view.
      // Cards are button[data-testid^="smartlist-card-"] — open the first one.
      await openSmartListClient(page);
      // Gate: wait for the conversation/compose view to be ready before typing.
      await waitForClientDetailReady(page, 'nextActionFilter');
    } else {
      // 1st Attempt (and any future statusFilter lists): clients are in the
      // Accounts page table, opened via a.crm-list-account-name links.
      //
      // Uses a lazy Playwright locator (re-queries DOM at click time) instead of
      // stored element handles to prevent "element not attached to the DOM" errors
      // when the list re-renders between query and click.
      const clientLinks = page.locator(SELECTORS.clientNameLink);
      const linkCount   = await clientLinks.count().catch(() => 0);

      if (rowIndex >= linkCount) {
        logger.info(`Row ${rowIndex} no longer in list — may have been removed`);
        return 'skipped';
      }

      // Read name and href before clicking — locator re-queries DOM each time.
      clientName = await clientLinks.nth(rowIndex)
        .getAttribute('title').then(t => t?.trim() || '').catch(() => '')
        || await clientLinks.nth(rowIndex)
          .textContent().then(t => t?.trim() || `Client #${rowIndex + 1}`).catch(() => `Client #${rowIndex + 1}`);

      // Stable dedup key: prefer href (contains account ID) over display name alone.
      clientHref = await clientLinks.nth(rowIndex)
        .getAttribute('href').then(h => h?.trim() || '').catch(() => '');
      clientKey  = clientHref || normalizeClientName(clientName);

      // Duplicate-client guard
      if (runConfig.processedClients?.has(clientKey)) {
        logger.warn(`[DUPLICATE_VISIBLE_CLIENT_SKIPPED_THIS_RUN] ${clientName} (key=${clientKey}) already handled this run — skipping`);
        // Return distinct value so the run loop counts this separately from real skips.
        return 'duplicate-skipped';
      }

      logger.info(`Opening client: ${clientName}`);

      // Stability check on a fresh handle (non-stale — just acquired).
      const freshEl    = await clientLinks.nth(rowIndex).elementHandle().catch(() => null);
      const linkStable = freshEl ? await isElementStable(freshEl).catch(() => false) : false;
      logger.info(linkStable ? 'Target visible and stable — clicking' : 'Link stability uncertain — clicking anyway');

      logger.info('Opening client via fresh locator');
      try {
        await clientLinks.nth(rowIndex).scrollIntoViewIfNeeded();
        await clientLinks.nth(rowIndex).click();
      } catch (clickErr) {
        const isDetach = clickErr.message && (
          clickErr.message.includes('not attached') ||
          clickErr.message.includes('detached') ||
          clickErr.message.includes('not connected')
        );
        if (isDetach) {
          logger.warn('Client row handle detached — reacquiring target');
          // Brief settle, then re-wait for list and retry.
          await page.waitForTimeout(300);
          await waitForClientListReady(page, 'statusFilter');
          const freshLinks = page.locator(SELECTORS.clientNameLink);
          const freshCount = await freshLinks.count().catch(() => 0);
          if (rowIndex >= freshCount) {
            logger.info(`Row ${rowIndex} no longer in list after reacquire`);
            return 'skipped';
          }
          logger.info('Reacquired client row successfully');
          await freshLinks.nth(rowIndex).scrollIntoViewIfNeeded();
          await freshLinks.nth(rowIndex).click();
        } else {
          throw clickErr;
        }
      }

      // Gate: wait for SMS buttons (or account content) to be visible before
      // inspectLines() runs. Replaces spaSettle(1500) + humanDelay(2000-4000).
      await waitForClientDetailReady(page, 'statusFilter');
    }

    if (navMode === 'nextActionFilter') {
      // ── 2nd / 3rd Attempt: direct compose flow — no SMS line detection ────────
      // The conversation view is already open after clicking the smartlist card.
      // Do NOT look for SMS buttons. Do NOT run DNC logic.
      logger.info('Using direct-message flow for nextActionFilter');

      // Focus the message textarea using the same fallback ordering as the
      // other composer paths so Mac-specific variants can be handled.
      const { handle: textarea, selector: matchedSelector } = await findDirectComposer(page, config.defaultTimeout);
      logger.info(`[DIRECT_COMPOSER_FOUND] selector=${matchedSelector}`);
      await textarea.scrollIntoViewIfNeeded();
      await textarea.click();
      await humanDelay(page, delayProfile);

      // Type the configured message
      await typeDirectMessage(page, listConfig.text);
      logger.info('Typed configured message');
      await humanDelay(page, delayProfile);

      // Verify Send becomes enabled
      let sendReady = await isSendEnabled(page);
      if (!sendReady) {
        sendReady = await retrySendReadyAfterComposerRefresh(page, rowIndex + 1, listConfig.text, matchedSelector);
      }
      if (sendReady) {
        logger.info('Send enabled');
      } else {
        logger.warn('Send button not enabled after typing — textarea may not have registered input');
        throw new HoldOnBlockError('SEND_DISABLED_AFTER_COMPOSER_REFRESH');
      }

      // Send (always live)
      logger.info('[MODE] LIVE');
      const isNavDupe = await checkForDuplicateMessage(page, listConfig.text);
      if (isNavDupe) {
        logger.warn(`[DUPLICATE_PROTECTION] ${clientName}: skipping send — last message already matches template`);
      } else {
        await clickSend(page);
        const confirmed = await waitForMessageDeliveryConfirmation(page, 10000);
        if (confirmed) {
          logger.success(`${clientName}: Message SENT`);
          logger.info('[SMS_SENT] mode=normal');
        } else {
          logger.warn(`[SEND_NOT_CONFIRMED] ${clientName}: delivery not confirmed — skipping client to prevent duplicate`);
          logger.info(`[UNCERTAIN_SEND_SKIP_CLIENT] message may have sent, skipping client to prevent duplicate`);
          await humanDelay(page, delayProfile);
          await returnToList(page, list);
          await humanDelay(page, delayProfile);
          throw new UncertainSendError();
        }
      }

      await applyFastReturnDelay(page);
      logger.info('Returning to smart list');
      await returnToList(page, list);
      // Post-send bookkeeping — wrapped so it never converts a successful send into 'failed'.
      try {
        runConfig.processedClients?.add(normalizeClientName(clientName));
        logger.info(`[CLIENT_SUCCESS_TRACKED] client=${clientName} key=${normalizeClientName(clientName)}`);
      } catch (trackErr) {
        logger.warn(`[CLIENT_TRACK_WARN] bookkeeping error (send succeeded): ${trackErr.message}`);
      }
      return 'messaged';
    }

    // ── 1st Attempt (statusFilter): SMS line detection → Chat Starter / DNC ────
    const { hasActiveSms } = await inspectLines(page);

    if (!hasActiveSms) {
      logger.info(`${clientName}: No active SMS lines`);

      if (listConfig.dncEnabled) {
        const dncOk = await logDncActivity(page);
        if (!dncOk) {
          logger.warn(`[DNC_LOG_ACTIVITY_FAILED_NONFATAL] ${clientName}: Log Activity not found — skipping DNC, continuing run`);
          logger.info('[SMARTLIST_RESTORE_AFTER_DNC_FAILURE_START]');
          await returnToSmartListsDirect(page, list).catch(e => logger.warn('[RETURNTOLIST_AFTER_DNC_WARN] ' + e.message));
          logger.info('[SMARTLIST_RESTORE_AFTER_DNC_FAILURE_DONE]');
          return 'skipped';
        }
        logger.success(`${clientName}: DNC activity logged`);
        // Bookkeeping before navigation — wrapped defensively.
        try {
          const dncKey = clientKey || clientName;
          if (!dncKey) logger.warn('[CLIENT_KEY_MISSING] falling back to clientName for DNC tracking');
          runConfig.processedClients?.add(dncKey || normalizeClientName(clientName));
        } catch (trackErr) {
          logger.warn(`[CLIENT_TRACK_WARN] DNC bookkeeping error: ${trackErr.message}`);
        }
        await returnToSmartListsDirect(page, list);
        await humanDelay(page, delayProfile);
        return 'dnc';
      }

      logger.info(`${clientName}: DNC disabled for this list — skipping`);
      await returnToSmartListsDirect(page, list);
      return 'skipped';
    }

    const flowCtx = { listConfig, mode, delayProfile, clientName, clientProfileUrl: page.url(), list };
    const flowOutcome = runConfig.everyoneMode === 'first'
      ? await runFirstAttemptEveryoneMode(page, flowCtx)
      : await runFirstAttemptShared(page, flowCtx);

    // The flow now reports its own verdict. Previously its return value was
    // discarded and every client that reached here was recorded as 'messaged',
    // while blocked lines threw a generic Error and landed in the catch as
    // 'failed' — which is what inflated the failed count for DNC / recently
    // messaged clients.
    const outcome = flowOutcome?.result ?? 'messaged';

    // Bookkeeping is wrapped so it can never convert a real outcome into 'failed'.
    try {
      if (!clientKey) {
        logger.warn('[CLIENT_KEY_MISSING] falling back to clientName for 1st Attempt tracking');
        clientKey = clientName;
      }
      runConfig.processedClients?.add(clientKey);
      logger.info(`[CLIENT_${outcome === 'messaged' ? 'SUCCESS' : 'HANDLED'}_TRACKED] client=${clientName} key=${clientKey} outcome=${outcome}`);
    } catch (trackErr) {
      logger.warn(`[CLIENT_TRACK_WARN] bookkeeping error (outcome=${outcome}): ${trackErr.message}`);
    }

    if (outcome === 'skipped') {
      logger.warn(`[CLIENT_SKIPPED_NOT_FAILED] client=${rowIndex + 1} name="${clientName}" reason=${flowOutcome.reason}`);
      return { result: 'skipped', reason: flowOutcome.reason };
    }
    if (outcome === 'failed') {
      let failUrl = 'unknown';
      try { failUrl = page.url(); } catch { /* page may be gone */ }
      logger.error(`[CLIENT_FAILURE_SUMMARY] client=${rowIndex + 1} list=${list} error=${flowOutcome.error?.message ?? flowOutcome.reason} url=${failUrl}`);
      return { result: 'failed', reason: flowOutcome.reason };
    }
    return 'messaged';

  } catch (err) {
    if (err.isUncertainSend) {
      // Send was clicked but delivery unconfirmed — skip safely, do not retry or DNC.
      logger.warn(`[UNCERTAIN_SEND_SKIP_CLIENT] client ${rowIndex + 1}: uncertain send — skipping safely`);
      return 'skipped';
    }
    if (err.isBrowserClosed || !isPageAlive(page) || err.message?.includes('Target page, context or browser has been closed')) {
      logger.warn('[USER_CLOSED_BROWSER_GRACEFUL_STOP] browser closed');
      logger.warn('[RUN_STOPPED_BROWSER_CLOSED] browser was closed — marking run as stopped');
      return 'browser_closed';
    }
    if (err.isHoldOnBlock) {
      logger.warn(`[FIRST_ATTEMPT_CLIENT_SKIPPED_HOLD_ON_NO_DNC] client=${rowIndex + 1} name="${clientName}"`);
      logger.info(`[FIRST_ATTEMPT_PENDING_OR_HOLDON_SKIP_CONTINUE] client="${clientName}" — marked handled for this run, returning to list`);
      logger.info(`[FIRST_ATTEMPT_CLIENT_REMEMBERED] client=${rowIndex + 1} name="${clientName}"`);
      try {
        const remKey = clientKey || normalizeClientName(clientName);
        if (remKey) runConfig.processedClients?.add(remKey);
      } catch { /* non-critical */ }
      return 'skipped';
    }
    // Structured failure summary — makes post-run log inspection actionable
    let lastUrl = 'unknown';
    try { lastUrl = page.url(); } catch { /* page may be gone */ }
    logger.error(`[CLIENT_FAILURE_SUMMARY] client=${rowIndex + 1} list=${list} error=${err.message} url=${lastUrl}`);
    logger.error(`Client ${rowIndex + 1} failed`, err);
    await returnToSmartListsDirect(page, list).catch(() => {});
    return 'failed';
  }
}

// ─── Doctor mode ─────────────────────────────────────────────────────────────

/**
 * Check all selectors against the live page and print a detailed report.
 * Does not click anything destructive.
 *
 * Page context is detected automatically:
 *   - Accounts/list page: checks accounts selectors and smart list sidebar.
 *   - Client profile page: checks SMS, chat, DNC, and modal selectors.
 *   - Unknown page: shows a warning and skips the irrelevant group.
 */
async function runDoctor(page) {
  const chalk = require('chalk');
  logger.banner('Doctor Mode — Selector Check');

  const currentUrl = page.url();
  console.log(`  Current URL: ${currentUrl}\n`);

  // Detect page context by presence of known confirmed elements.
  const onAccountsList = !!(await page.$(SELECTORS.clientNameLink).catch(() => null));
  const onClientProfile = !!(await page.$(SELECTORS.smsButton).catch(() => null));

  let pageContext;
  if (onClientProfile) {
    pageContext = 'profile';
    console.log(`  Page context: ${chalk.cyan('client profile page')}\n`);
  } else if (onAccountsList) {
    pageContext = 'accounts';
    console.log(`  Page context: ${chalk.green('accounts / smart list page')}\n`);
  } else {
    pageContext = 'unknown';
    console.log(`  Page context: ${chalk.yellow('unknown — navigate to the accounts page or open a client profile')}\n`);
  }

  // ── Navigation selectors (accounts page only) ────────────────────────────
  console.log(chalk.bold('  ── Smart List Navigation Selectors ────────────────────'));
  if (pageContext !== 'accounts') {
    console.log(chalk.yellow('  SKIPPED — navigate to the accounts page to check navigation selectors.\n'));
  } else {
    const navChecks = [
      ['Smart Lists nav',         SELECTORS.smartListsNav,           'accounts page'],
      ['Status dropdown (1st)',   SELECTORS.statusDropdown,          'accounts page'],
      ['Apply btn (status/1st)',  SELECTORS.statusFilterApplyButton, 'accounts page'],
      ['Apply btn (nextAction)',  SELECTORS.nextActionApplyButton,   'accounts page'],
      ['Conversations nav',       SELECTORS.conversationsNav,        'accounts page'],
      ['Smart Lists tab',         SELECTORS.smartListsTab,           'conversations page'],
      ['Filters button (sl)',     SELECTORS.slFilterButton,          'smart lists page'],
      ['Next Action filter btn',  SELECTORS.nextActionFilterButton,  'smart lists filters'],
      ['Smart list card (first)', SELECTORS.smartListCardFirst,      'smart lists results'],
      ['Smart list card (any)',   SELECTORS.smartListCard,           'smart lists results'],
      ['Client name link',        SELECTORS.clientNameLink,          'accounts page'],
      ['Client row (derived)',  SELECTORS.clientRow,               'accounts page'],
      ['Pagination next',       SELECTORS.paginationNext,          'accounts page'],
    ];
    await runSelectorChecks(page, navChecks, chalk);
  }

  // ── Accounts page selectors ───────────────────────────────────────────────
  const accountsChecks = [
    ['Client name link', SELECTORS.clientNameLink, 'accounts page'],
    ['Client row',       SELECTORS.clientRow,      'accounts page'],
    ['Pagination next',  SELECTORS.paginationNext, 'accounts page'],
  ];

  console.log(chalk.bold('  ── Accounts Page Selectors ─────────────────────────────'));
  if (pageContext !== 'accounts') {
    console.log(chalk.yellow('  SKIPPED — not on the accounts page.\n'));
  } else {
    await runSelectorChecks(page, accountsChecks, chalk);
  }

  // ── Client profile selectors ──────────────────────────────────────────────
  const profileChecks = [
    ['SMS button',           SELECTORS.smsButton,                  'profile'],
    ['SMS button (disabled)',SELECTORS.smsButtonDisabled,          'profile'],
    ['Chat Starter',         SELECTORS.chatStarterButton,          'profile (after SMS click)'],
    ['Chat Starter Next',    SELECTORS.chatStarterNextButton,      'profile (chat starter open)'],
    ['Draft field',          SELECTORS.draftField,                 'profile (chat starter open)'],
    ['Message input',        SELECTORS.messageInput,               'profile (chat open)'],
    ['Send button',          SELECTORS.sendButton,                 'profile (message ready)'],
    ['Return to list',       SELECTORS.returnToListButton,         'profile'],
    ['Account details btn',  SELECTORS.accountDetailsButton,       'profile'],
    ['Log Activity button',  SELECTORS.logActivityMenuItem,        'profile'],
    ['Interaction dropdown', SELECTORS.customerInteractionDropdown,'profile (modal open)'],
    ['Outcome dropdown',     SELECTORS.outcomeDropdown,            'profile (modal open)'],
    ['All Channels radio',   SELECTORS.dncAllChannelsRadio,        'profile (modal open)'],
    ['Note textarea',        SELECTORS.activityNoteTextarea,       'profile (modal open)'],
    ['DNC Save button',      SELECTORS.activityConfirmButton,      'profile (modal open)'],
  ];

  console.log(chalk.bold('\n  ── Client Profile Selectors ────────────────────────────'));
  if (pageContext !== 'profile') {
    console.log(chalk.yellow('  SKIPPED — open a client profile page, then re-run doctor.\n'));
  } else {
    await runSelectorChecks(page, profileChecks, chalk);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(chalk.bold('\n  To fix a NOT FOUND selector:'));
  console.log('  1. Keep the browser open (press ENTER when done, not before)');
  console.log('  2. Open Chrome DevTools → Elements tab');
  console.log('  3. Inspect the element you need');
  console.log('  4. Copy the selector into src/selectors.js');
  console.log('  5. Re-run: npm run doctor\n');
}

async function runSelectorChecks(page, checks, chalk) {
  let found = 0, notFound = 0;
  for (const [label, sel] of checks) {
    const selList = Array.isArray(sel) ? sel : [sel];
    let matchedSel = null;
    for (const s of selList) {
      if (!s) continue;
      try {
        const el = await page.$(s);
        if (el) { matchedSel = s; break; }
      } catch (e) {
        // invalid selector — note the error
        console.log(`  ${chalk.red('ERROR').padEnd(18)} ${label}`);
        console.log(`             ${chalk.gray('selector error: ' + e.message.split('\n')[0])}`);
        notFound++;
        continue;
      }
    }
    if (matchedSel) {
      found++;
      console.log(`  ${chalk.green('FOUND').padEnd(18)} ${label}`);
      console.log(`             ${chalk.gray('via: ' + matchedSel)}`);
    } else {
      notFound++;
      const tried = selList.slice(0, 2).join(', ') + (selList.length > 2 ? ', …' : '');
      console.log(`  ${chalk.red('NOT FOUND').padEnd(18)} ${label}`);
      console.log(`             ${chalk.gray('tried: ' + tried)}`);
    }
  }
  console.log(chalk.gray(`\n  ${found} found, ${notFound} not found`));
}

// ─── Dedicated nextActionFilter run path (2nd / 3rd Attempt) ─────────────────

/**
 * Poll for smartlist-card buttons after Apply.
 * Returns an array of element handles (may be empty after timeout).
 *
 * Polls every 500 ms for up to totalMs milliseconds.
 * Logs the count on every attempt.
 */
async function pollForSmartListCards(page, totalMs = 10000) {
  const interval   = 500;
  const maxPolls   = Math.ceil(totalMs / interval);

  for (let i = 1; i <= maxPolls; i++) {
    const cards = await page.$$(SELECTORS.smartListCard).catch(() => []);
    logger.info(`Smart Lists cards poll ${i}/${maxPolls}: found ${cards.length}`);
    if (cards.length > 0) return cards;
    await page.waitForTimeout(interval);
  }

  return [];
}

/**
 * Open the first available smartlist-card.
 * Prefers button[data-testid="smartlist-card-0"]; falls back to the first
 * card in the general button[data-testid^="smartlist-card-"] set.
 */
async function openFirstSmartListCard(page) {
  // Try the specific card-0 selector first (most reliable).
  let card = await page.$(SELECTORS.smartListCardFirst).catch(() => null);

  if (card) {
    logger.info('Opening first Smart Lists client via smartlist-card-0');
  } else {
    // Fall back to whichever card comes first in DOM order.
    const cards = await page.$$(SELECTORS.smartListCard).catch(() => []);
    if (cards.length === 0) {
      throw new Error(
        'No Smart Lists cards found when attempting to open first client.\n' +
        `Selector: ${SELECTORS.smartListCard}`
      );
    }
    card = cards[0];
    logger.info('Opening first visible Smart Lists card');
  }

  await card.scrollIntoViewIfNeeded();
  await card.click();
}

/**
 * Run the full 2nd / 3rd Attempt workflow for a single client.
 *
 * Called after the smartlist-card has already been clicked and the
 * conversation view is open.
 *
 * Flow:
 *   1. Focus textarea#message-input (fallback: textarea[placeholder="Write a message"])
 *   2. Type the configured direct message
 *   3. Verify Send button is enabled
 *   4. Dry: log; Live: click Send
 *   5. Return to smart list
 */

/**
 * Verify the Smart Lists panel still shows filtered results.
 * If cards are gone (page drifted after View Account / back-nav), re-navigate
 * back to the correct filtered list.
 *
 * Called after every client so the loop never silently falls into Inbox or
 * an unfiltered conversation view.
 */
async function restoreSmartListsContextIfNeeded(page, listName) {
  logger.info(`[SMARTLIST_RESTORE_SHARED] checking list context for "${listName}"`);

  // Fast path: cards are still in the left panel — no action needed.
  const cards = await page.$$(SELECTORS.smartListCard).catch(() => []);
  if (cards.length > 0) {
    logger.info('[NEXT_ACTION_SHARED_RESTORE_SUCCESS] Smart Lists panel already showing results');
    return;
  }

  logger.info('[NEXT_ACTION_SHARED_RESTORE_SMARTLISTS] Smart Lists cards gone — attempting recovery');
  logger.info('[SHARED_RECOVERY_PATH] entering shared restore path');

  // Light recovery: Smart Lists tab still visible → click it
  // (happens when we drifted within Conversations but the tab is still mounted)
  try {
    const tab = await page.$(SELECTORS.smartListsTab);
    if (tab && await tab.isVisible().catch(() => false)) {
      await tab.click();
      await page.waitForTimeout(600);
      const afterTab = await page.$$(SELECTORS.smartListCard).catch(() => []);
      if (afterTab.length > 0) {
        logger.info('[NEXT_ACTION_SHARED_RESTORE_SUCCESS] Smart Lists restored via tab click');
        return;
      }
    }
  } catch { /* fall through to full re-nav */ }

  // Full re-navigation: Conversations → Smart Lists → filter → Apply
  logger.info('[NEXT_ACTION_SHARED_RESTORE_SMARTLISTS] full re-navigation required');
  await navigateToSmartList(page, listName);
  logger.info('[NEXT_ACTION_SHARED_RESTORE_SUCCESS] Smart Lists restored via full re-navigation');
}

/**
 * Assert that the page is still in the correct Smart Lists context.
 * For nextActionFilter lists: verifies smartlist-card buttons are present.
 * Delegates recovery to restoreSmartListsContextIfNeeded if context is gone.
 *
 * Logs [LIST_ASSERT_START] and [LIST_ASSERT_SUCCESS].
 */
async function assertCorrectListContext(page, listName) {
  logger.info(`[LIST_ASSERT_START] asserting list context for "${listName}"`);
  const listConfig = config.lists[listName];
  if (!listConfig) {
    logger.warn(`[LIST_ASSERT_START] unknown list "${listName}" — skipping assertion`);
    return;
  }
  if (listConfig.navMode !== 'nextActionFilter') return; // 1st Attempt manages its own context

  const cards = await page.$$(SELECTORS.smartListCard).catch(() => []);
  if (cards.length > 0) {
    logger.info(`[LIST_ASSERT_SUCCESS] list context verified — ${cards.length} card(s) present`);
    return;
  }

  logger.warn(`[LIST_ASSERT_START] list context lost for "${listName}" — recovering`);
  await restoreSmartListsContextIfNeeded(page, listName);
  logger.info(`[LIST_ASSERT_SUCCESS] list context restored for "${listName}"`);
}

/**
 * Click the "View Account" link/button from a Smart Lists conversation card.
 * Tries stable selectors first; falls back to the DOM-path as a last resort.
 */
async function clickViewAccount(page) {
  const candidates = SELECTORS.viewAccountLink; // array defined in selectors.js
  const el = await findFirst(page, candidates, 8000);
  if (!el) {
    throw new Error(
      'View Account link not found.\n' +
      `Tried: ${candidates.slice(0, 3).join(', ')} …`
    );
  }
  await el.scrollIntoViewIfNeeded();
  await el.click();
  logger.info('Clicked View Account');
}

/**
 * Shared multi-line SMS fallback for nextActionFilter (2nd AND 3rd Attempt).
 *
 * Called whenever the primary direct-message flow is blocked (no textarea,
 * or Send never enables). Identical behavior for both list types — the only
 * intentional differences (message text, DNC flag) come from listConfig.
 *
 * State machine:
 *   State A — Account profile  (SMS buttons visible, Log Activity reachable)
 *   State B — Single-line SMS composer  (after clicking a line button)
 *
 * After each line click:
 *   - Wait up to 6 s for #message-input (State B)
 *   - If found → focus, fill, verify length, poll Send, click Send
 *   - If not found → page.goBack() → return to State A → re-query → next line
 *
 * Before DNC: ensureAccountViewForDnc() verifies State A is reachable.
 */
/**
 * Aggressive fallback: restore the smart list → reopen the top card → click
 * View Account → re-query SMS buttons.  Called when restoreProfileAndRequerySmsLines
 * has already returned [] and a complete page-state recovery is needed.
 */
async function performFullSmsLineRecovery(page, accountProfileUrl, listName) {
  // Attempt 1: restore smart list context, reopen the card, then View Account.
  try {
    await restoreSmartListsContextIfNeeded(page, listName);
    await page.waitForTimeout(600);
    await openFirstSmartListCard(page);
    await page.waitForTimeout(500);
    await clickViewAccount(page);
    await page.waitForTimeout(600);
    const btns = await querySmsLinesGlobally(page);
    if (btns.length > 0) return btns;
  } catch { /* continue to next strategy */ }

  // Attempt 2: direct URL goto as a last resort.
  if (accountProfileUrl && !accountProfileUrl.startsWith('about:')) {
    try {
      await page.goto(accountProfileUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
      await page.waitForTimeout(800);
      const btns = await querySmsLinesGlobally(page);
      if (btns.length > 0) return btns;
    } catch { /* ignore */ }
  }

  return [];
}

async function dismissOneSignalOverlay(page) {
  try {
    const removed = await page.evaluate(() => {
      const el = document.querySelector('#onesignal-slidedown-container');
      if (el) { el.remove(); return true; }
      return false;
    });
    if (removed) logger.info('[ONESIGNAL_OVERLAY_DISMISSED]');
  } catch { /* non-fatal — page may not support evaluate */ }
}

async function handleNextActionMultiLineFallback(page, clientNum, listConfig, mode, delayProfile, listName) {
  logger.info(`[NEXT_ACTION_SHARED_FALLBACK_START] listName="${listName}" client=${clientNum}`);
  logger.info('Direct-message flow blocked — opening View Account');
  await dismissOneSignalOverlay(page);
  // A Smart List card can remain mounted while its detail pane is in a
  // transient/error state (for example, Statflo's "We seem to have lost you"
  // screen).  In that state there is no View Account control to click.  Do
  // not turn a missing fallback control into a fatal client failure: restore
  // the list and record a safe, non-DNC skip so the run can continue.
  try {
    await clickViewAccount(page);
  } catch (viewAccountErr) {
    logger.warn(
      `[NEXT_ACTION_ACCOUNT_VIEW_UNAVAILABLE] client=${clientNum} — ${viewAccountErr.message}; restoring Smart Lists and skipping safely`
    );
    await restoreSmartListsContextIfNeeded(page, listName).catch((restoreErr) => {
      logger.warn(`[NEXT_ACTION_ACCOUNT_VIEW_RESTORE_FAILED] client=${clientNum} — ${restoreErr.message}`);
    });
    return { result: 'skipped', reason: 'SKIPPED_ACCOUNT_VIEW_UNAVAILABLE' };
  }
  await page.waitForTimeout(600);

  // Capture account profile URL immediately for reliable restoration.
  let accountProfileUrl = page.url();
  logger.info(`[SMS_LINE_PROFILE_URL_CAPTURED] url=${accountProfileUrl}`);

  let lineAttempts       = 0; // number of lines actually entered the attempt body
  let cooldownBlockedCount = 0; // lines skipped because of recent-contact cooldown
  let dncBlockedCount      = 0; // lines skipped because that line is truly DNC
  let uncertainBlockedCount = 0; // Send disabled for an unknown UI reason; never DNC
  let composerFound      = false;
  let fillFailed         = false; // composer was found but fill/send had automation error
  let resultReason       = 'unknown';
  let dncLogged          = false;

  // ── Initial SMS line scan ─────────────────────────────────────────────────
  logger.info('[NEXT_ACTION_SHARED_SMS_SCAN] scanning SMS lines after View Account');
  let enabledLines        = await keySmsLineHandles(await querySmsLinesGlobally(page));
  const initialTotalLines = enabledLines.length;
  // Lines we have SELECTED — prevents re-picking the same line and looping.
  const attemptedKeys     = new Set();
  // Lines we actually managed to CLICK. The DNC guard uses this one: a click
  // that threw on a detached handle still marked the line attempted, so two
  // failed clicks reached "attempted === detected" and let the DNC write
  // through even though neither line was ever opened.
  const enteredKeys       = new Set();
  // Set when any collected line lacked a unique identity at any point. Tallies
  // built from ambiguous keys can double-count one physical line, so they are
  // not a sound basis for marking someone Do Not Contact.
  let lineIdentityAmbiguous = hasAmbiguousLineKeys(enabledLines);

  if (initialTotalLines === 0) {
    resultReason = 'no-enabled-lines';
    logger.warn('[NEXT_ACTION_SHARED_SMS_SCAN] no enabled SMS lines — will proceed to DNC check');
  } else {
    logger.info(`[NEXT_ACTION_SHARED_SMS_SCAN] ${initialTotalLines} enabled SMS line(s) found`);
  }

  // ── Line attempt loop ─────────────────────────────────────────────────────
  //
  // Lines are chosen by STABLE IDENTITY, not by position. `lineAttempts` counts
  // how many lines have been entered; `attemptedKeys` records which ones.
  //
  // The previous design used `lineAttempts` as an index into a freshly
  // re-queried button array. Positions are not stable across a reload: when the
  // line just attempted stops being enabled, the remaining lines shift down a
  // slot, the index runs past the end, the loop breaks early — and because no
  // cooldown, DNC or fill error was recorded, execution fell through to the DNC
  // write below. That marked a contact Do Not Contact while an eligible line had
  // never been tried. A hard guard before the DNC write now backs this up.
  //
  // When a restore returns nothing, performFullSmsLineRecovery reopens the card
  // and rebuilds the list; selection then simply resumes at the first line whose
  // key has not been attempted yet.

  while (attemptedKeys.size < initialTotalLines) {

    // ── Page-closed guard ─────────────────────────────────────────────────────
    if (page.isClosed()) {
      logger.warn('[PAGE_CLOSED_GRACEFUL_STOP] page closed — stopping fallback run');
      break;
    }

    // ── Pick the first line we have not entered yet ──────────────────────────
    let target = enabledLines.find(l => !attemptedKeys.has(l.key));

    // ── Nothing left in the current list — try full recovery ─────────────────
    if (!target) {
      logger.info(`[SMS_LINE_ATTEMPTED_SET] attempted=${lineAttempts} total=${initialTotalLines}`);
      logger.info('[SMS_LINE_FULL_RECOVERY_START]');

      enabledLines = await keySmsLineHandles(await performFullSmsLineRecovery(page, accountProfileUrl, listName));
      // Must propagate here too. Full recovery reopens the card from scratch, so
      // it is the branch MOST likely to return differently-identified lines —
      // and if that ambiguity is not recorded, colliding keys can count one
      // physical line twice, reach the expected total, and release the DNC write
      // while another line was never tried.
      lineIdentityAmbiguous = lineIdentityAmbiguous || hasAmbiguousLineKeys(enabledLines);

      if (enabledLines.length === 0) {
        logger.warn('[SMS_LINE_FULL_RECOVERY_FAILED]');
        break; // cannot reach more lines — exit loop, let the guards below decide
      }

      logger.info(`[SMS_LINE_FULL_RECOVERY_SUCCESS] enabled=${enabledLines.length}`);

      // After full recovery the card was reopened, so accountProfileUrl may have
      // changed. Update it so Strategy B in future restores is still valid.
      // This used to log the new URL and then keep using the stale one, because
      // accountProfileUrl was a const — every later restore navigated to a URL
      // the recovery had already moved away from.
      const freshUrl = page.url();
      if (freshUrl && !freshUrl.startsWith('about:') && freshUrl !== accountProfileUrl) {
        logger.info(`[SMS_LINE_PROFILE_URL_UPDATED] newUrl=${freshUrl}`);
        accountProfileUrl = freshUrl;
      }

      target = enabledLines.find(l => !attemptedKeys.has(l.key));
      if (!target) {
        logger.warn(`[SMS_LINE_NEXT_AVAILABLE_NONE] recovery surfaced no untried line — attempted=${lineAttempts}/${initialTotalLines}`);
        break;
      }
    }

    // ── Enter attempt for the selected line ──────────────────────────────────
    attemptedKeys.add(target.key);
    lineAttempts++;
    const lineNum = lineAttempts;
    logger.info(`[SMS_LINE_ATTEMPT] line=${lineNum} total=${initialTotalLines} key=${target.key}`);
    logger.info(`[SMS_LINE_ATTEMPT_START] line=${lineNum} total=${initialTotalLines} client=${clientNum}`);

    // ── A. Click line button ────────────────────────────────────────────────
    const btn = target.handle;

    // Log click target for diagnostics before touching anything
    let bboxStr = '(unavailable)';
    try {
      const bbox = await btn.boundingBox();
      if (bbox) bboxStr = `x=${Math.round(bbox.x)},y=${Math.round(bbox.y)},w=${Math.round(bbox.width)},h=${Math.round(bbox.height)}`;
    } catch { /* stale handle — continue to click attempt */ }
    logger.info(`[SMS_LINE_CLICK_TARGET] line=${lineNum} selector=${SELECTORS.smsButton} bbox=${bboxStr}`);

    let clickOk = false;
    logger.info(`[SMS_LINE_CLICK_SAFE_START] line=${lineNum}`);
    try {
      // Use btn.evaluate() — avoids passing the handle as a page.evaluate() argument
      // which triggers circular-JSON serialization in the EmbeddedPage/EmbeddedKeyboard
      // implementation (the handle's _page → keyboard → _page cycle).
      await btn.evaluate(el => el.scrollIntoView({ block: 'nearest', behavior: 'instant' }));
      await page.waitForTimeout(150);
      await highlightClickTarget(page, btn, 500);
      logger.info(`[CLICK_TARGET_HIGHLIGHT] type=sms-line displayLine=${lineNum} key=${target.key}`);
      await btn.evaluate(el => el.click());
      clickOk = true;
      // NOTE: entering the line is confirmed further down, not here. A
      // dispatched click only proves JavaScript fired an event — not that
      // Statflo opened the SMS line.
      logger.info(`[SMS_LINE_CLICK_SAFE_DONE] line=${lineNum}`);
      logger.info(`[SMS_LINE_CLICK_FIRED] line=${lineNum}`);
    } catch (clickErr) {
      logger.warn(`[SMS_LINE_CLICK_ERROR] line=${lineNum} error="${clickErr.message}" — re-querying enabled SMS buttons`);
      enabledLines = await keySmsLineHandles(await restoreProfileAndRequerySmsLines(page, accountProfileUrl));
      lineIdentityAmbiguous = lineIdentityAmbiguous || hasAmbiguousLineKeys(enabledLines);
      logger.info(`[SMS_LINE_REQUERY_AFTER_RESTORE] total=${enabledLines.length} untried=${enabledLines.filter(l => !attemptedKeys.has(l.key)).length}`);
      continue;
    }

    if (!clickOk) continue;
    await page.waitForTimeout(400);

    // ── B. Wait for composer ────────────────────────────────────────────────
    logger.info(`[SMS_COMPOSER_WAIT_AFTER_LINE_CLICK_START] line=${lineNum}`);
    logger.info(`[NEXT_ACTION_SHARED_COMPOSER_WAIT] waiting for composer on line ${lineNum}`);
    const composerResult = await waitForComposerAfterSmsLineClick(page, 13000);
    logger.info(`[SMS_COMPOSER_WAIT_AFTER_LINE_CLICK_RESULT] line=${lineNum} found=${composerResult.found} blockedByRecentContact=${composerResult.blockedByRecentContact ?? false}`);

    // ── Confirm the line actually opened ────────────────────────────────────
    // This, not the click, is what counts toward "every line was tried". A
    // composer means Statflo opened the line; a classified cooldown/DNC means
    // Statflo answered for that line. An unclassified composer timeout is
    // neither — it is automation/UI uncertainty, and treating it as a tried
    // line let a client whose lines all silently failed to open fall through
    // to logDncActivity() with no positive evidence of anything.
    if (composerResult.found || composerResult.blockedByRecentContact) {
      enteredKeys.add(target.key);
    } else {
      logger.warn(`[SMS_LINE_NOT_CONFIRMED_OPEN] line=${lineNum} key=${target.key} — click dispatched but no composer and no block verdict; not counted as tried`);
    }

    if (!composerResult.found) {
      // Split by the detector's verdict. Counting a positively-identified DNC
      // as a cooldown made resolveSkipReason() report
      // SKIPPED_ALL_LINES_RECENTLY_MESSAGED for lines that are permanently
      // opted out. Either way the client is skipped, never failed and never
      // freshly DNC-logged.
      if (composerResult.blockedByRecentContact && composerResult.blockKind === 'dnc') {
        dncBlockedCount++;
        logger.warn(`[SMS_LINE_DNC_SKIPPED] line=${lineNum} client=${clientNum} — ${composerResult.blockDetails || 'detected by composer wait'} — skipping this line, checking next`);
      } else if (composerResult.blockedByRecentContact) {
        cooldownBlockedCount++;
        logger.warn(`[SMS_LINE_UNAVAILABLE_RECENT_CONTACT] line=${lineNum} client=${clientNum} — recent-contact block detected by composer wait`);
        logger.warn(`[SMS_LINE_COOLDOWN_SKIP_NO_DNC] line=${lineNum} client=${clientNum} cooldownCount=${cooldownBlockedCount}`);
      }
      logger.warn(`[SMS_LINE_ATTEMPT_RESULT] line=${lineNum} result=${composerResult.blockedByRecentContact ? (composerResult.blockKind === 'dnc' ? 'dnc' : 'cooldown') : 'no-composer'}`);
      logger.warn(`[SMS_LINE_TRY_NEXT] line=${lineNum} — no composer; restoring account profile and trying next line`);
      logger.info(`[SMS_LINE_NEXT_AVAILABLE_SEARCH] line=${lineNum} looking for next enabled line after failure`);
      enabledLines = await keySmsLineHandles(await restoreProfileAndRequerySmsLines(page, accountProfileUrl));
      lineIdentityAmbiguous = lineIdentityAmbiguous || hasAmbiguousLineKeys(enabledLines);
      logger.info(`[SMS_LINE_REQUERY_AFTER_RESTORE] total=${enabledLines.length} untried=${enabledLines.filter(l => !attemptedKeys.has(l.key)).length}`);
      if (enabledLines.some(l => !attemptedKeys.has(l.key))) {
        logger.info(`[SMS_LINE_NEXT_AVAILABLE_FOUND] available=${enabledLines.filter(l => !attemptedKeys.has(l.key)).length}`);
      } else {
        logger.warn(`[SMS_LINE_NEXT_AVAILABLE_NONE] no more lines after line=${lineNum}`);
      }
      continue; // loop escalates to full recovery when no untried line remains
    }

    // ── C. Handle composer type ─────────────────────────────────────────────
    composerFound = true;
    const settleMs = config.sendReadySettleMs ?? 1500;
    logger.info(`[NEXT_ACTION_SHARED_COMPOSER_FOUND] composer present on line ${lineNum} type=${composerResult.type}`);

    if (composerResult.type === 'firstContact' && config.usePremadesWhenNoTextbox !== false) {
      // ── C1. First-contact premade flow ──────────────────────────────────────
      // Statflo is showing premade cards or a Chat Starter wizard instead of a
      // regular textarea.  Use the same premade helpers as 1st Attempt / Everyone Mode.
      logger.info(`[SMS_LINE_FIRST_CONTACT_PREMADE_FLOW_START] line=${lineNum} client=${clientNum}`);

      let premadeOk = false;

      try {
        const topOk = await runTopPremadeFlow(page);
        if (topOk) {
          logger.info(`[SMS_LINE_PREMADE_TOP_FOUND] line=${lineNum}`);
          premadeOk = true;
        }
      } catch { /* fall through to Chat Starter */ }

      if (!premadeOk) {
        try {
          const botOk = await runBottomChatStarterFlow(page);
          if (botOk) {
            logger.info(`[SMS_LINE_PREMADE_BOTTOM_FOUND] line=${lineNum}`);
            premadeOk = true;
          }
        } catch { /* both premade flows failed */ }
      }

      if (!premadeOk) {
        logger.warn(`[SMS_LINE_PREMADE_FLOW_FAILED] line=${lineNum} client=${clientNum} — no premade option clicked`);
        enabledLines = await keySmsLineHandles(await restoreProfileAndRequerySmsLines(page, accountProfileUrl));
      lineIdentityAmbiguous = lineIdentityAmbiguous || hasAmbiguousLineKeys(enabledLines);
        logger.info(`[SMS_LINE_REQUERY_AFTER_RESTORE] total=${enabledLines.length} untried=${enabledLines.filter(l => !attemptedKeys.has(l.key)).length}`);
        composerFound = false;
        continue;
      }

      logger.info(`[SMS_LINE_PREMADE_CLICKED] line=${lineNum}`);
      logger.info(`[SMS_SEND_READY_WAIT_START] line=${lineNum} settle=${settleMs}ms`);
      await page.waitForTimeout(settleMs);
      const premadeSendReady = await pollSendEnabled(page, config.sendConfirmTimeoutMs ?? 6000);

      if (!premadeSendReady) {
        logger.warn(`[SMS_LINE_PREMADE_SEND_READY] line=${lineNum} sendReady=false`);
        logger.warn(`[SMS_SEND_READY_FALSE_AFTER_SETTLE] line=${lineNum} client=${clientNum}`);
        enabledLines = await keySmsLineHandles(await restoreProfileAndRequerySmsLines(page, accountProfileUrl));
      lineIdentityAmbiguous = lineIdentityAmbiguous || hasAmbiguousLineKeys(enabledLines);
        logger.info(`[SMS_LINE_REQUERY_AFTER_RESTORE] total=${enabledLines.length} untried=${enabledLines.filter(l => !attemptedKeys.has(l.key)).length}`);
        if (enabledLines.some(l => !attemptedKeys.has(l.key))) {
          logger.info(`[SMS_LINE_NEXT_AVAILABLE_FOUND] available=${enabledLines.filter(l => !attemptedKeys.has(l.key)).length}`);
        } else {
          logger.warn(`[SMS_LINE_NEXT_AVAILABLE_NONE] no more lines after line=${lineNum}`);
        }
        composerFound = false;
        continue;
      }

      logger.info(`[SMS_LINE_PREMADE_SEND_READY] line=${lineNum} sendReady=true`);
      logger.info(`[SMS_SEND_READY_TRUE] line=${lineNum}`);
      logger.info(`[POST_DNC_SEND_CLICK] clicking Send (premade) on line ${lineNum}`);
      logger.info('[MODE] LIVE');
      // No duplicate-text check for premade flows — no template text to compare.
      await clickSend(page);
      logger.info(`[SMS_LINE_PREMADE_SEND_SUCCESS] line=${lineNum}`);
      logger.info(`[SMS_LINE_SEND_CLICKED] line=${lineNum}`);
      const premadeConfirmed = await waitForMessageDeliveryConfirmation(page, 10000);
      if (premadeConfirmed) {
        logger.success(`Client ${clientNum}: Message SENT (first-contact premade) on line ${lineNum}`);
        logger.success(`[NORMAL_MODE_FALLBACK_LINE_SENT] client=${clientNum} line=${lineNum}`);
        logger.info(`[SMS_LINE_MESSAGE_SENT] client=${clientNum} line=${lineNum}`);
        logger.info('[SMS_SENT] mode=normal-first-contact-premade');
      } else {
        logger.warn(`[SEND_NOT_CONFIRMED] client=${clientNum} line=${lineNum}: premade delivery not confirmed`);
        logger.info('[UNCERTAIN_SEND_SKIP_CLIENT] message may have sent, skipping client to prevent duplicate');
        throw new UncertainSendError();
      }

      logger.info(`[SMS_LINE_ATTEMPT_RESULT] line=${lineNum} result=sent-premade`);
      resultReason = `sent-premade-line-${lineNum}`;
      logger.info(`[NEXT_ACTION_SHARED_RESULT] client=${clientNum} list="${listName}" lineAttempts=${lineAttempts} composerFound=true sent=true dncLogged=false reason=${resultReason}`);
      logger.info(`[CLIENT_FINAL_DECISION] client=${clientNum} result=messaged reason=sent-premade-line-${lineNum}`);
      return 'messaged';
    }

    // ── C2. Regular textarea fill ────────────────────────────────────────────
    try {
      await focusAndFillComposerAfterDnc(page, listConfig.text);
      logger.info(`[NEXT_ACTION_SHARED_TEXTAREA_FILLED] message filled on line ${lineNum}`);
      logger.info(`[SMS_LINE_MESSAGE_PASTED] len=${listConfig.text?.length ?? 0} line=${lineNum}`);
    } catch (fillErr) {
      logger.error(`[POST_DNC_FAILURE_REASON] fill failed on line ${lineNum}: ${fillErr.message}`);
      // Composer WAS found — this is an automation error, not a "no SMS lines" condition.
      // Set fillFailed so the post-loop code skips DNC and returns 'skipped' instead.
      fillFailed = true;
      enabledLines = await keySmsLineHandles(await restoreProfileAndRequerySmsLines(page, accountProfileUrl));
      lineIdentityAmbiguous = lineIdentityAmbiguous || hasAmbiguousLineKeys(enabledLines);
      logger.info(`[SMS_LINE_REQUERY_AFTER_RESTORE] total=${enabledLines.length} untried=${enabledLines.filter(l => !attemptedKeys.has(l.key)).length}`);
      composerFound = false;
      continue;
    }

    // ── D. Settle + poll Send ───────────────────────────────────────────────
    logger.info(`[SMS_SEND_READY_WAIT_START] line=${lineNum} settle=${settleMs}ms`);
    await page.waitForTimeout(settleMs);
    const sendReady = await pollSendEnabled(page, config.sendConfirmTimeoutMs ?? 6000);
    if (sendReady) {
      logger.info(`[SMS_SEND_READY_TRUE] line=${lineNum}`);
    }
    logger.info(`[NEXT_ACTION_SHARED_SEND_READY] line ${lineNum} sendReady=${sendReady}`);

    if (!sendReady) {
      const recoveredSendReady = await retrySendReadyAfterComposerRefresh(page, lineNum, listConfig.text);
      if (recoveredSendReady) {
        logger.info(`[SMS_SEND_READY_RECOVERED_AFTER_REFRESH] line=${lineNum}`);
        logger.info(`[POST_DNC_SEND_CLICK] clicking Send on line ${lineNum}`);
        logger.info('[MODE] LIVE');
        const isRecoveredDupeFallback = await checkForDuplicateMessage(page, listConfig.text);
        if (isRecoveredDupeFallback) {
          logger.warn(`[DUPLICATE_PROTECTION] client=${clientNum} line=${lineNum}: skipping send — last message already matches template`);
        } else {
          await clickSend(page);
          logger.info(`[SMS_LINE_SEND_CLICKED] line=${lineNum}`);
          const confirmed = await waitForMessageDeliveryConfirmation(page, 10000);
          if (confirmed) {
            logger.success(`Client ${clientNum}: Message SENT on line ${lineNum}`);
            logger.success(`[NORMAL_MODE_FALLBACK_LINE_SENT] client=${clientNum} line=${lineNum}`);
            logger.info(`[SMS_LINE_MESSAGE_SENT] client=${clientNum} line=${lineNum}`);
            logger.info('[SMS_SENT] mode=normal');
          } else {
            logger.warn(`[SEND_NOT_CONFIRMED] client=${clientNum} line=${lineNum}: delivery not confirmed — skipping client to prevent duplicate`);
            logger.info('[UNCERTAIN_SEND_SKIP_CLIENT] message may have sent, skipping client to prevent duplicate');
            throw new UncertainSendError();
          }
        }

        logger.info(`[SMS_LINE_ATTEMPT_RESULT] line=${lineNum} result=sent`);
        resultReason = `sent-line-${lineNum}`;
        logger.info(`[NEXT_ACTION_SHARED_RESULT] client=${clientNum} list="${listName}" lineAttempts=${lineAttempts} composerFound=true sent=true dncLogged=false reason=${resultReason}`);
        logger.info(`[CLIENT_FINAL_DECISION] client=${clientNum} result=messaged reason=sent-line-${lineNum}`);
        return 'messaged';
      }

      const cooldown = await detectSmsBlockedOrCooldownState(page, `send-blocked-line${lineNum}`);
      if (cooldown.blocked && cooldown.kind === 'dnc') {
        dncBlockedCount++;
        logger.warn(`[SMS_LINE_DNC_SKIPPED] line=${lineNum} client=${clientNum} — ${cooldown.details} — skipping this line, checking next`);
      } else if (cooldown.blocked) {
        cooldownBlockedCount++;
        logger.warn(`[SMS_LINE_UNAVAILABLE_RECENT_CONTACT] line=${lineNum} client=${clientNum} — ${cooldown.details}`);
        logger.warn(`[SMS_LINE_COOLDOWN_SKIP_NO_DNC] line=${lineNum} client=${clientNum} cooldownCount=${cooldownBlockedCount}`);
        logger.warn(`[SMS_SEND_BLOCKED_COOLDOWN_DETECTED] line=${lineNum}`);
      } else {
        uncertainBlockedCount++;
        logger.warn(`[SMS_SEND_BLOCKED_SELECTOR_UNCERTAIN] line=${lineNum} — Send not enabled but no cooldown block detected`);
        logger.warn(`[SMS_LINE_UNCERTAIN_SKIP_NO_DNC] line=${lineNum} client=${clientNum} uncertainCount=${uncertainBlockedCount}`);
      }
      logger.warn(`[SMS_SEND_READY_FALSE_AFTER_SETTLE] line=${lineNum} client=${clientNum}`);
      logger.warn(`[SMS_LINE_ATTEMPT_RESULT] line=${lineNum} result=${cooldown.blocked ? 'cooldown' : 'disabled'}`);
      logger.warn(`[SMS_LINE_TRY_NEXT] line=${lineNum} — Send blocked (cooldown/too-soon) — trying next line`);
      logger.info(`[SMS_LINE_NEXT_AVAILABLE_SEARCH] line=${lineNum} looking for next enabled line after send-blocked`);
      enabledLines = await keySmsLineHandles(await restoreProfileAndRequerySmsLines(page, accountProfileUrl));
      lineIdentityAmbiguous = lineIdentityAmbiguous || hasAmbiguousLineKeys(enabledLines);
      logger.info(`[SMS_LINE_REQUERY_AFTER_RESTORE] total=${enabledLines.length} untried=${enabledLines.filter(l => !attemptedKeys.has(l.key)).length}`);
      if (enabledLines.some(l => !attemptedKeys.has(l.key))) {
        logger.info(`[SMS_LINE_NEXT_AVAILABLE_FOUND] available=${enabledLines.filter(l => !attemptedKeys.has(l.key)).length}`);
      } else {
        logger.warn(`[SMS_LINE_NEXT_AVAILABLE_NONE] no more lines after line=${lineNum}`);
      }
      composerFound = false;
      continue;
    }

    // ── E. Send ─────────────────────────────────────────────────────────────
    logger.info(`[POST_DNC_SEND_CLICK] clicking Send on line ${lineNum}`);
    logger.info('[MODE] LIVE');
    const isDupeFallback = await checkForDuplicateMessage(page, listConfig.text);
    if (isDupeFallback) {
      logger.warn(`[DUPLICATE_PROTECTION] client=${clientNum} line=${lineNum}: skipping send — last message already matches template`);
      // treat as sent to avoid DNC
    } else {
      await clickSend(page);
      logger.info(`[SMS_LINE_SEND_CLICKED] line=${lineNum}`);
      const confirmed = await waitForMessageDeliveryConfirmation(page, 10000);
      if (confirmed) {
        logger.success(`Client ${clientNum}: Message SENT on line ${lineNum}`);
        logger.success(`[NORMAL_MODE_FALLBACK_LINE_SENT] client=${clientNum} line=${lineNum}`);
        logger.info(`[SMS_LINE_MESSAGE_SENT] client=${clientNum} line=${lineNum}`);
        logger.info('[SMS_SENT] mode=normal');
      } else {
        logger.warn(`[SEND_NOT_CONFIRMED] client=${clientNum} line=${lineNum}: delivery not confirmed — skipping client to prevent duplicate`);
        logger.info('[UNCERTAIN_SEND_SKIP_CLIENT] message may have sent, skipping client to prevent duplicate');
        throw new UncertainSendError();
      }
    }

    logger.info(`[SMS_LINE_ATTEMPT_RESULT] line=${lineNum} result=sent`);
    resultReason = `sent-line-${lineNum}`;
    logger.info(`[NEXT_ACTION_SHARED_RESULT] client=${clientNum} list="${listName}" lineAttempts=${lineAttempts} composerFound=true sent=true dncLogged=false reason=${resultReason}`);
    logger.info(`[CLIENT_FINAL_DECISION] client=${clientNum} result=messaged reason=sent-line-${lineNum}`);
    return 'messaged';
  }

  // ── All lines exhausted or full recovery failed ───────────────────────────
  logger.info(`[SMS_LINE_ATTEMPTED_SET] attempted=${lineAttempts} total=${initialTotalLines}`);
  logger.warn(`[SMS_LINE_EXHAUSTED] client=${clientNum} — ${lineAttempts}/${initialTotalLines} line(s) tried, none succeeded cooldownBlocked=${cooldownBlockedCount} dncBlocked=${dncBlockedCount} uncertainBlocked=${uncertainBlockedCount}`);
  logger.info(`[CLIENT_LINE_SUMMARY] client=${clientNum} lines=${initialTotalLines} attempted=${lineAttempts} dnc=${dncBlockedCount} recentlyMessaged=${cooldownBlockedCount} uncertain=${uncertainBlockedCount}`);
  logger.warn(`[NORMAL_MODE_NO_FALLBACK_AVAILABLE] client=${clientNum}`);
  logger.warn(`[SMS_LINE_ALL_EXHAUSTED] ${lineAttempts}/${initialTotalLines} line attempt(s) completed — no send path for client ${clientNum}`);

  // ── Hard guard: never mark a contact DNC on lines we never tried ──────────
  //
  // Logging DNC writes to the customer's record in Statflo, so it must only
  // happen when every line detected on this account was actually entered. The
  // walk could previously fall short without saying so: a line that dropped out
  // of the enabled list shifted the ones behind it down a slot, the positional
  // lookup ran off the end, the loop broke early — and with no cooldown, DNC or
  // fill error recorded, execution fell straight through to the DNC write. The
  // eligible line was never attempted and the contact was marked Do Not Contact.
  //
  // initialTotalLines === 0 is the genuine DNC case (no active SMS line at all)
  // and is deliberately still allowed through.
  // enteredKeys, not lineAttempts: a click that threw on a detached handle
  // still incremented lineAttempts, so two failed clicks satisfied
  // "attempted === detected" and let the DNC write through with neither line
  // ever opened. Ambiguous identity is refused for the same reason — tallies
  // built from colliding keys can count one physical line twice.
  if (initialTotalLines > 0 && (enteredKeys.size < initialTotalLines || lineIdentityAmbiguous)) {
    resultReason = SKIP_REASONS.LINES_NOT_FULLY_ATTEMPTED;
    logger.warn(
      `[SMS_LINE_INCOMPLETE_NO_DNC] client=${clientNum} — entered ${enteredKeys.size}/${initialTotalLines} line(s), ` +
      `selected=${lineAttempts}, identityAmbiguous=${lineIdentityAmbiguous}; ` +
      `refusing to log DNC unless every line was actually opened and uniquely identified`
    );
    logger.info(`[NEXT_ACTION_SHARED_RESULT] client=${clientNum} list="${listName}" lineAttempts=${lineAttempts} composerFound=${composerFound} sent=false dncLogged=false reason=${resultReason}`);
    logger.info(`[CLIENT_FINAL_DECISION] client=${clientNum} result=skipped reason=${resultReason}`);
    await returnToList(page, listName).catch(e => logger.warn('[RETURNTOLIST_AFTER_FALLBACK_WARN] ' + e.message));
    return { result: 'skipped', reason: SKIP_REASONS.LINES_NOT_FULLY_ATTEMPTED };
  }

  // If the composer was reached but fill failed due to an automation error, do NOT
  // log DNC — the SMS line is active and the contact should not be marked Do Not Contact.
  if (fillFailed) {
    resultReason = 'automation-send-failed';
    logger.warn(`[SMS_LINE_FILL_FAILED_NO_DNC] client=${clientNum} — composer found but fill had automation error — skipping without DNC`);
    logger.info(`[NEXT_ACTION_SHARED_RESULT] client=${clientNum} list="${listName}" lineAttempts=${lineAttempts} composerFound=true sent=false dncLogged=false reason=${resultReason}`);
    logger.info(`[CLIENT_FINAL_DECISION] client=${clientNum} result=skipped reason=automation-send-failed`);
    await returnToList(page, listName).catch(e => logger.warn('[RETURNTOLIST_AFTER_FALLBACK_WARN] ' + e.message));
    return 'skipped';
  }

  // A disabled Send button without a positive cooldown or DNC signal is an
  // unknown UI state, not proof the customer has no contactable number. Walk
  // every remaining line first, then skip safely. Historical runs showed this
  // ambiguous state falling through to a new DNC after all lines were tried.
  if (uncertainBlockedCount > 0) {
    resultReason = SKIP_REASONS.SEND_STATE_UNCERTAIN;
    logger.warn(`[CLIENT_SKIPPED_SEND_STATE_UNCERTAIN_NO_DNC] client=${clientNum} uncertain=${uncertainBlockedCount} of ${lineAttempts} line(s) — refusing DNC without a positive DNC signal`);
    logger.info(`[NEXT_ACTION_SHARED_RESULT] client=${clientNum} list="${listName}" lineAttempts=${lineAttempts} composerFound=${composerFound} sent=false dncLogged=false reason=${resultReason}`);
    logger.info(`[CLIENT_FINAL_DECISION] client=${clientNum} result=skipped reason=${resultReason}`);
    await returnToList(page, listName).catch(e => logger.warn('[RETURNTOLIST_AFTER_FALLBACK_WARN] ' + e.message));
    return { result: 'skipped', reason: resultReason };
  }

  // If any line was blocked for a business reason (already messaged recently, or
  // that line is DNC), skip the client cleanly. Never log a NEW DNC in this case:
  // a cooldown means "come back later", and an existing DNC is already recorded.
  if (cooldownBlockedCount > 0 || dncBlockedCount > 0) {
    const reason = resolveSkipReason({
      totalLines:     initialTotalLines,
      cooldownCount:  cooldownBlockedCount,
      dncCount:       dncBlockedCount,
      noComposeCount: 0,
    });
    resultReason = reason;
    logger.warn(`[CLIENT_SKIPPED_RECENT_CONTACT_NO_DNC] client=${clientNum} — cooldown=${cooldownBlockedCount} dnc=${dncBlockedCount} of ${lineAttempts} line(s) — skipping without logging DNC`);
    logger.info(`[NEXT_ACTION_SHARED_RESULT] client=${clientNum} list="${listName}" lineAttempts=${lineAttempts} composerFound=${composerFound} sent=false dncLogged=false reason=${resultReason}`);
    logger.info(`[CLIENT_FINAL_DECISION] client=${clientNum} result=skipped reason=${reason}`);
    await returnToList(page, listName).catch(e => logger.warn('[RETURNTOLIST_AFTER_FALLBACK_WARN] ' + e.message));
    return { result: 'skipped', reason };
  }

  logger.info(`[SMS_LINE_DNC_ALLOWED] reason=all-lines-exhausted attempted=${lineAttempts} total=${initialTotalLines}`);

  if (listConfig.dncEnabled) {
    const accountReady = await ensureAccountViewForDnc(page);
    if (!accountReady) {
      logger.error('[DNC_MENU_NOT_FOUND] account view not recoverable — skipping DNC for this client');
      resultReason = 'dnc-nav-failed';
      logger.info(`[NEXT_ACTION_SHARED_RESULT] client=${clientNum} list="${listName}" lineAttempts=${lineAttempts} composerFound=${composerFound} sent=false dncLogged=false reason=${resultReason}`);
      logger.info(`[CLIENT_FINAL_DECISION] client=${clientNum} result=skipped reason=dnc-nav-failed`);
      await returnToList(page, listName).catch(e => logger.warn('[RETURNTOLIST_AFTER_FALLBACK_WARN] ' + e.message));
      return 'skipped';
    }

    const dncOk = await logDncActivity(page);
    if (!dncOk) {
      logger.warn(`[DNC_LOG_ACTIVITY_FAILED_NONFATAL] client=${clientNum}: Log Activity not found — skipping DNC, continuing run`);
      resultReason = 'dnc-log-failed';
      logger.info(`[NEXT_ACTION_SHARED_RESULT] client=${clientNum} list="${listName}" lineAttempts=${lineAttempts} composerFound=${composerFound} sent=false dncLogged=false reason=${resultReason}`);
      logger.info(`[CLIENT_FINAL_DECISION] client=${clientNum} result=skipped reason=dnc-log-failed`);
      logger.info('[SMARTLIST_RESTORE_AFTER_DNC_FAILURE_START]');
      await returnToList(page, listName).catch(e => logger.warn('[RETURNTOLIST_AFTER_FALLBACK_WARN] ' + e.message));
      logger.info('[SMARTLIST_RESTORE_AFTER_DNC_FAILURE_DONE]');
      return 'skipped';
    }
    dncLogged = true;
    logger.success(`Client ${clientNum}: DNC activity logged`);
    resultReason = 'dnc';
    logger.info(`[NEXT_ACTION_SHARED_DNC] client=${clientNum} list="${listName}"`);
    logger.info(`[NEXT_ACTION_SHARED_RESULT] client=${clientNum} list="${listName}" lineAttempts=${lineAttempts} composerFound=${composerFound} sent=false dncLogged=${dncLogged} reason=${resultReason}`);
    logger.info(`[CLIENT_FINAL_DECISION] client=${clientNum} result=dnc reason=all-lines-exhausted`);
    await returnToList(page, listName).catch(e => logger.warn('[RETURNTOLIST_AFTER_FALLBACK_WARN] ' + e.message));
    return 'dnc';
  }

  resultReason = 'skipped-dnc-disabled';
  logger.warn(`[CLIENT_SKIPPED_NO_AVAILABLE_LINES] client=${clientNum} — all lines exhausted, DNC disabled`);
  logger.info(`[NEXT_ACTION_SHARED_RESULT] client=${clientNum} list="${listName}" lineAttempts=${lineAttempts} composerFound=${composerFound} sent=false dncLogged=false reason=${resultReason}`);
  logger.info(`[CLIENT_FINAL_DECISION] client=${clientNum} result=skipped reason=dnc-disabled`);
  await returnToList(page, listName).catch(e => logger.warn('[RETURNTOLIST_AFTER_FALLBACK_WARN] ' + e.message));
  return 'skipped';
}

// Backward-compat alias — runNextActionList previously called this name.
const handleNextActionDncFallback = handleNextActionMultiLineFallback;

// Sentinel error class — caught by runNextActionList to trigger DNC fallback.
class DncFallbackNeeded extends Error {
  constructor() { super('DNC_FALLBACK'); this.isDncFallback = true; }
}

// Sentinel error class — send was clicked but delivery unconfirmed.
// Do NOT retry, do NOT DNC, do NOT try another line — skip client safely.
class UncertainSendError extends Error {
  constructor() { super('UNCERTAIN_SEND'); this.isUncertainSend = true; }
}

// Sentinel: Statflo hold-on / wait-for-reply block detected on an SMS line.
// Skip the line/client without DNC — never counts as a failure.
class HoldOnBlockError extends Error {
  constructor(msg = 'HOLD_ON_BLOCK') { super(msg); this.isHoldOnBlock = true; }
}

// Sentinel: browser/page was closed by the user mid-run.
// Causes the main loop to break immediately and report status=browser_closed.
class BrowserClosedError extends Error {
  constructor() { super('BROWSER_CLOSED'); this.isBrowserClosed = true; }
}

/**
 * Hard-timebox check for the direct-message textarea.
 *
 * Uses page.$$() on each poll — a synchronous DOM snapshot with no internal
 * Playwright wait — so each iteration costs only a single IPC round-trip.
 * Total timeout: 1500 ms. Poll interval: 150 ms (≤10 polls).
 *
 * Returns the element handle if found.
 * Throws DncFallbackNeeded immediately if not found within the timebox.
 */
async function findDirectComposer(page, timeoutMs = 10000) {
  const CANDIDATE_SELECTORS = [
    'textarea#message-input',
    'textarea[placeholder="Write a message"]',
    'textarea[placeholder*="message" i]',
    'textarea[placeholder*="reply" i]',
    'textarea',
    '[contenteditable="true"]',
    '[role="textbox"]',
    'input[placeholder*="message" i]',
    '[data-testid*="message" i]',
    '[data-testid*="composer" i]',
    '[class*="message" i] textarea',
    '[class*="composer" i] textarea',
  ];
  const INTERVAL = 200;

  logger.info('Checking for direct-message composer');
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    for (const sel of CANDIDATE_SELECTORS) {
      try {
        const els = await page.$$(sel);
        for (const el of els) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) return { handle: el, selector: sel };
        }
      } catch { /* stale or detached — continue */ }
    }
    await page.waitForTimeout(INTERVAL);
  }

  const elapsed = Date.now() - start;
  logger.warn(`[DIRECT_MESSAGE_COMPOSER_NOT_FOUND_AFTER_STRONG_WAIT] waited ${elapsed}ms — falling back to View Account`);
  throw new DncFallbackNeeded();
}

async function runNextActionAttemptShared(page, clientNum, listConfig, mode, delayProfile) {
  logger.info(`[PLATFORM_SHARED_FLOW] platform=${process.platform} attempt=2nd/3rd engine=runNextActionAttemptShared client=${clientNum}`);
  logger.info('[DIRECT_MESSAGE_FLOW_START]');

  const { handle: textarea, selector: matchedSelector } = await findDirectComposer(page, 10000);
  logger.info(`[DIRECT_COMPOSER_FOUND] selector=${matchedSelector}`);

  await textarea.scrollIntoViewIfNeeded();
  await textarea.click();

  await typeDirectMessage(page, listConfig.text);
  logger.info(`[DIRECT_MESSAGE_PASTED] len=${listConfig.text?.length ?? 0}`);

  const refreshedSendReady = await retrySendReadyAfterComposerRefresh(page, clientNum, listConfig.text, matchedSelector);
  logger.info(`[DIRECT_MESSAGE_SEND_READY_AFTER_REFRESH] client=${clientNum} refreshedSendReady=${refreshedSendReady}`);

  // Poll Send for 2 s. A disabled Send after typing means the line is in a
  // cooldown / wait-to-send state — throw DncFallbackNeeded so the caller can
  // try the next available SMS line on this client.
  const sendReady = refreshedSendReady || await pollSendEnabled(page, 2000);
  if (!sendReady) {
    logger.warn('Send not enabled after typing — line may be blocked by cooldown, triggering SMS line fallback');
    throw new DncFallbackNeeded();
  }

  logger.info('[MODE] LIVE');
  const isNavSharedDupe = await checkForDuplicateMessage(page, listConfig.text);
  if (isNavSharedDupe) {
    logger.warn(`[DUPLICATE_PROTECTION] client=${clientNum}: skipping send — last message already matches template`);
    logger.info(`[NEXT_ACTION_SHARED_RESULT] platform=${process.platform} client=${clientNum} result=duplicate-skipped`);
  } else {
    await clickSend(page);
    logger.info('[DIRECT_SEND_CLICKED]');
    const confirmed = await waitForMessageDeliveryConfirmation(page, 10000);
    if (confirmed) {
      logger.success(`Client ${clientNum}: Message SENT`);
      logger.info('[DIRECT_MESSAGE_SENT]');
      logger.info('[SMS_SENT] mode=normal');
      logger.info('[NEXT_ACTION_STAY_ON_SMARTLISTS]');
      logger.info(`[NEXT_ACTION_SHARED_RESULT] platform=${process.platform} client=${clientNum} result=messaged`);
    } else {
      logger.warn(`[SEND_NOT_CONFIRMED] client=${clientNum}: delivery not confirmed — skipping client to prevent duplicate`);
      logger.info(`[UNCERTAIN_SEND_SKIP_CLIENT] message may have sent, skipping client to prevent duplicate`);
      logger.info(`[NEXT_ACTION_SHARED_RESULT] platform=${process.platform} client=${clientNum} result=uncertain-send`);
      throw new UncertainSendError();
    }
  }
}

// Backward-compat alias
const processNextActionClient = runNextActionAttemptShared;

/**
 * Force-focus and fill #message-input after a DNC transition.
 *
 * After a DNC the SPA re-renders the composer. The element handle from before
 * the navigation is stale. This helper re-waits for the selector, gets a fresh
 * handle, uses three-tier focus escalation, clears stale value via the native
 * setter so React's controlled-input onChange fires, fills, and verifies the
 * value is non-empty before returning.
 *
 * Throws with [POST_DNC_FAILURE_REASON] marker if the textarea cannot be filled.
 */
async function focusAndFillComposerAfterDnc(page, messageText) {
  const SELECTOR = '#message-input';

  // ── 1. Wait for visible ──────────────────────────────────────────────────
  logger.info(`[POST_DNC_COMPOSER_WAIT] waiting for ${SELECTOR} visible (8 s)`);
  try {
    await page.waitForSelector(SELECTOR, { state: 'visible', timeout: 8000 });
  } catch (waitErr) {
    logger.error(`[POST_DNC_FAILURE_REASON] ${SELECTOR} never became visible: ${waitErr.message}`);
    throw waitErr;
  }

  // ── 2. Fresh handle ──────────────────────────────────────────────────────
  const textarea = await page.$(SELECTOR);
  if (!textarea) {
    const msg = `[POST_DNC_FAILURE_REASON] ${SELECTOR} disappeared after waitForSelector`;
    logger.error(msg);
    throw new Error(msg);
  }
  logger.info(`[POST_DNC_TEXTAREA_FOUND] ${SELECTOR} handle acquired`);

  await textarea.scrollIntoViewIfNeeded();

  // ── 3. Focus — three escalating strategies ───────────────────────────────
  // All evaluate calls use textarea.evaluate(fn) — avoids passing the handle as a
  // page.evaluate() argument which triggers circular-JSON errors in EmbeddedPage.
  // Strategy A: DOM focus + click
  await textarea.evaluate(el => { el.focus(); el.click(); });
  let isFocused = await textarea.evaluate(el => document.activeElement === el);

  // Strategy B: double-click via handle
  if (!isFocused) {
    logger.warn('[POST_DNC_TEXTAREA_FOCUSED] strategy A failed — trying double-click');
    await textarea.click({ clickCount: 2, delay: 50 });
    await page.waitForTimeout(200);
    isFocused = await textarea.evaluate(el => document.activeElement === el);
  }

  // Strategy C: locator force click (ignores pointer-events / overlay)
  if (!isFocused) {
    logger.warn('[POST_DNC_TEXTAREA_FOCUSED] strategy B failed — using locator force click');
    await page.locator(SELECTOR).click({ force: true });
    await page.waitForTimeout(150);
    isFocused = await textarea.evaluate(el => document.activeElement === el);
  }

  logger.info(`[POST_DNC_TEXTAREA_FOCUSED] activeElement === ${SELECTOR}: ${isFocused}`);

  // ── 4. Clear stale value via native setter so React onChange fires ────────
  await textarea.evaluate(el => {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(el, '');
    } else {
      el.value = '';
    }
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(150);

  // ── 5. Fill — safe DOM evaluate (no handle-as-arg serialization) ──────────
  await textarea.evaluate((el, text) => {
    el.focus();
    el.value = text;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
    }
  }, messageText);

  // ── 6. Verify value ───────────────────────────────────────────────────────
  let value = await textarea.evaluate(el => el.value || el.textContent || '');
  logger.info(`[POST_DNC_TEXTAREA_VALUE_LEN] after fill: ${value.length} chars`);

  // ── 7. Retry: native setter + dispatch if fill did not stick ─────────────
  if (!value || value.trim().length === 0) {
    logger.warn('[POST_DNC_TEXTAREA_VALUE_LEN] fill() did not stick — using native setter');
    await textarea.evaluate((el, text) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(el, text);
      } else {
        el.value = text;
      }
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, messageText);
    await page.waitForTimeout(100);
    value = await textarea.evaluate(el => el.value || el.textContent || '');
    logger.info(`[POST_DNC_TEXTAREA_VALUE_LEN] after native setter: ${value.length} chars`);
  }

  // ── 8. Hard guard ─────────────────────────────────────────────────────────
  if (!value || value.trim().length === 0) {
    const msg = `[POST_DNC_FAILURE_REASON] textarea still empty after all fill strategies — aborting`;
    logger.error(msg);
    throw new Error(msg);
  }

  const refreshed = await refreshComposerInputSignals(page, SELECTOR, messageText);
  logger.info(`[POST_DNC_COMPOSER_SIGNAL_REFRESH] selector=${SELECTOR} refreshed=${refreshed}`);
  if (!refreshed) {
    const msg = '[POST_DNC_FAILURE_REASON] composer signal refresh failed or changed message text — aborting';
    logger.error(msg);
    throw new Error(msg);
  }
}

async function retrySendReadyAfterComposerRefresh(page, lineNum, messageText, selector = '#message-input') {
  const refreshed = await refreshComposerInputSignals(page, selector, messageText);
  logger.info(`[SMS_SEND_READY_RECOVERY_ATTEMPT] line=${lineNum} selector=${selector} refreshed=${refreshed}`);
  if (!refreshed) return false;
  await page.waitForTimeout(250);
  const recovered = await pollSendEnabled(page, 2500);
  logger.info(`[SMS_SEND_READY_RECOVERY_RESULT] line=${lineNum} recovered=${recovered}`);
  return recovered;
}

/**
 * Post-DNC send path for nextActionFilter (2nd / 3rd Attempt).
 *
 * After a DNC fallback the page is left on the Account view. When the next
 * card is opened, the SMS composer needs extra time to settle. Uses
 * focusAndFillComposerAfterDnc for reliable textarea fill with verification.
 */
async function processNextActionClientAfterDnc(page, clientNum, listConfig, mode, delayProfile) {
  logger.info('[3RD_ATTEMPT_AFTER_DNC] Post-DNC transition — entering focusAndFillComposerAfterDnc');

  try {
    await focusAndFillComposerAfterDnc(page, listConfig.text);
  } catch (err) {
    logger.error(`[POST_DNC_FAILURE_REASON] fill failed: ${err.message}`);
    throw new DncFallbackNeeded();
  }

  const sendReady = await pollSendEnabled(page, 3000);
  logger.info(`[POST_DNC_SEND_READY] pollSendEnabled result: ${sendReady}`);
  if (!sendReady) {
    logger.warn('[POST_DNC_FAILURE_REASON] Send button not enabled after fill — triggering line fallback');
    throw new DncFallbackNeeded();
  }

  logger.info('[MODE] LIVE');
  const isPostDncDupe = await checkForDuplicateMessage(page, listConfig.text);
  if (isPostDncDupe) {
    logger.warn(`[DUPLICATE_PROTECTION] client=${clientNum}: skipping send (post-DNC) — last message already matches template`);
  } else {
    logger.info('[POST_DNC_SEND_CLICK] clicking Send');
    await clickSend(page);
    const confirmed = await waitForMessageDeliveryConfirmation(page, 10000);
    if (confirmed) {
      logger.success(`Client ${clientNum}: Message SENT (post-DNC transition)`);
      logger.info('[SMS_SENT] mode=normal');
    } else {
      logger.warn(`[SEND_NOT_CONFIRMED] client=${clientNum}: delivery not confirmed (post-DNC) — skipping client to prevent duplicate`);
      logger.info(`[UNCERTAIN_SEND_SKIP_CLIENT] message may have sent, skipping client to prevent duplicate`);
      throw new UncertainSendError();
    }
  }
}

/**
 * Complete run loop for nextActionFilter lists (2nd / 3rd Attempt).
 *
 * Owns the full lifecycle from Apply onward:
 *   poll cards → open card → direct-message → return → repeat
 *
 * Returns a stats object: { processed, messaged, failed }
 */
async function runNextActionList(page, runConfig, liveStats = null) {
  const { mode, maxClients, delayProfile } = runConfig;
  const listConfig = config.lists[runConfig.list];

  logger.info('Entering dedicated nextActionFilter run path');

  const stats = liveStats ?? { processed: 0, messaged: 0, dnc: 0, skipped: 0, duplicateSkipped: 0, failed: 0 };
  let consecutiveErrors = 0;
  let lastOutcome = null;
  const maxDisplay = maxClients === Infinity ? '∞' : maxClients;

  logger.info(`[RUN_START] list="${runConfig.list}" target=${maxDisplay}`);

  while (true) {
    if (page.isClosed()) {
      logger.warn('[PAGE_CLOSED_GRACEFUL_STOP] browser was closed by user — stopping run');
      break;
    }

    if (stats.processed >= maxClients) {
      logger.info(`[RUN_COMPLETE] target reached (${maxDisplay}) — stopping`);
      break;
    }

    const cards = await pollForSmartListCards(page, 10000);

    logger.info(`[RUN_LOOP] list="${runConfig.list}" client=${stats.processed + 1}/${maxDisplay} cards=${cards.length} sent=${stats.messaged} dnc=${stats.dnc} skip=${stats.skipped} dupSkip=${stats.duplicateSkipped} fail=${stats.failed} consErr=${consecutiveErrors} prevOutcome=${lastOutcome ?? 'none'}`);

    if (cards.length === 0) {
      // Before declaring the list exhausted, restore Smart List context in case the page
      // drifted to an account/profile view (e.g. after a failed/DNC navigation).
      logger.warn('[RUN_CARDS_ZERO] cards=0 — restoring Smart List context before declaring exhausted');
      try {
        await restoreSmartListsContextIfNeeded(page, runConfig.list);
      } catch (restoreErr) {
        stats._runError = 'smartlist-recovery-failed-before-exhaustion';
        logger.error(
          `[RUN_ABORT_NAVIGATION_RECOVERY_FAILED] could not verify Smart Lists before exhaustion — ${restoreErr.message}`,
          restoreErr,
        );
        break;
      }
      const retryCards = await page.$$(SELECTORS.smartListCard).catch(() => []);
      if (retryCards.length === 0) {
        logger.info(`[RUN_COMPLETE] no cards remaining — list exhausted after ${stats.processed} clients`);
        break;
      }
      logger.info(`[RUN_CARDS_RECOVERED] found ${retryCards.length} card(s) after context restore — continuing`);
    }

    logger.info('Scanning visible Smart List cards for next unprocessed client');

    // Hoisted so the catch block can add the client to processedClients on error.
    let cardClientName = '';

    try {
      await assertCorrectListContext(page, runConfig.list);

      // Scan ALL visible cards and pick the first one not yet processed this run.
      const allCards = await getSmartListCards(page);
      const cardNames = await Promise.all(
        allCards.map(c =>
          c.textContent()
            .then(t => normalizeClientName(t?.split('\n')[0] || ''))
            .catch(() => '')
        )
      );

      logger.info(`[CLIENT_CARD_SELECTION_SCAN] visible=${allCards.length}`);

      let selectedIdx = -1;
      for (let i = 0; i < allCards.length; i++) {
        const n = cardNames[i];
        if (!n) continue;
        if (runConfig.processedClients?.has(n)) {
          logger.info(`[CLIENT_CARD_SKIPPED_ALREADY_SEEN] index=${i} name="${n}"`);
          logger.info(`[SESSION_CLIENT_ALREADY_SEEN] name="${n}"`);
        } else {
          selectedIdx = i;
          break;
        }
      }

      if (selectedIdx < 0) {
        logger.warn(`[CLIENT_ALL_VISIBLE_ALREADY_PROCESSED] all ${allCards.length} visible cards already seen this run — stopping`);
        break;
      }

      cardClientName = cardNames[selectedIdx];
      logger.info(`[CLIENT_CARD_SELECTED] index=${selectedIdx} name="${cardClientName}"`);

      // For index 0 use the reliable first-card opener; for deeper indices click
      // the element handle directly (cards array is fresh — handles are not stale).
      if (selectedIdx === 0) {
        await openFirstSmartListCard(page);
      } else {
        try {
          await allCards[selectedIdx].scrollIntoViewIfNeeded();
          await allCards[selectedIdx].click();
        } catch (cardClickErr) {
          // Handle stale element (SPA re-rendered between scan and click)
          logger.warn(`[CLIENT_CARD_CLICK_STALE] index=${selectedIdx} name="${cardClientName}" — ${cardClickErr.message}; retrying via fresh query`);
          const freshCards = await getSmartListCards(page);
          if (selectedIdx >= freshCards.length) {
            logger.warn(`[EVERYONE_LINE_SKIPPED] index=${selectedIdx} reason=card-gone-after-stale`);
            continue;
          }
          await freshCards[selectedIdx].scrollIntoViewIfNeeded();
          await freshCards[selectedIdx].click();
        }
      }
      // Short fixed pause — runNextActionAttemptShared polls the textarea itself.
      await safeWait(page, 400);

      let outcome;
      try {
        // ── Primary: direct-message flow (or Everyone Mode) ───────────────
        logger.info(`[NEXT_ACTION_SHARED_FLOW_START] client=${stats.processed + 1} list="${runConfig.list}" prevOutcome=${lastOutcome ?? 'none'}`);
        if (runConfig.everyoneMode === 'next') {
          outcome = await runNextActionEveryoneMode(page, stats.processed + 1, listConfig, mode, delayProfile, runConfig.list);
        } else {
          await runNextActionAttemptShared(page, stats.processed + 1, listConfig, mode, delayProfile);
          outcome = 'messaged';
        }
      } catch (innerErr) {
        if (innerErr.isUncertainSend) {
          // Send was clicked but delivery unconfirmed — skip safely, never retry or DNC.
          outcome = 'skipped';
          await restoreSmartListsContextIfNeeded(page, runConfig.list);
        } else if (innerErr.isDncFallback) {
          // ── Fallback: View Account → inspect lines → DNC decision ────────
          outcome = await handleNextActionMultiLineFallback(
            page, stats.processed + 1, listConfig, mode, delayProfile, runConfig.list
          );
        } else {
          throw innerErr; // genuine error — re-throw to outer catch
        }
      }

      // The multi-line flows report { result, reason }; older paths report a
      // bare string. Normalize both before any stats or logging happen.
      const outcomeResult = typeof outcome === 'string' ? outcome : (outcome?.result ?? 'skipped');
      const outcomeReason = typeof outcome === 'string' ? outcome : (outcome?.reason ?? outcome?.result ?? 'unknown');

      // Remember this client for ALL outcomes — prevents re-clicking the same card
      // if Statflo is slow to remove it from the list after processing.
      if (cardClientName) {
        runConfig.processedClients?.add(cardClientName);
        logger.info(`[SESSION_CLIENT_REMEMBERED] name="${cardClientName}" outcome=${outcomeResult} reason=${outcomeReason}`);
        if (outcomeResult === 'cooldown-skipped' || outcomeResult === 'skipped') {
          logger.info(`[SESSION_MEMORY_COOLDOWN_CLIENT_SKIPPED] ${cardClientName} will not be retried this run`);
        }
      }

      // Normalize 'cooldown-skipped' → 'skipped' for stats. Skips are never failures.
      const reportOutcome = outcomeResult === 'cooldown-skipped' ? 'skipped' : outcomeResult;
      lastOutcome = reportOutcome;
      stats.processed++;
      if (reportOutcome === 'messaged') stats.messaged++;
      else if (reportOutcome === 'dnc') stats.dnc++;
      else {
        stats.skipped++;
        stats.skipReasons = stats.skipReasons ?? {};
        stats.skipReasons[outcomeReason] = (stats.skipReasons[outcomeReason] ?? 0) + 1;
        logger.info(`[RUN_SKIP_REASON] reason=${outcomeReason} total=${stats.skipReasons[outcomeReason]}`);
      }
      consecutiveErrors = 0;

      logger.info(`[CLIENT_FINAL_DECISION] client=${stats.processed} result=${reportOutcome} reason=${outcomeReason}`);
      logger.info(`[RUN_CLIENT_DONE] processed=${stats.processed}/${maxDisplay} result=${reportOutcome} reason=${outcomeReason} sent=${stats.messaged} dnc=${stats.dnc} skip=${stats.skipped} fail=${stats.failed}`);

      // The customer outcome is final before navigation recovery begins. A
      // confirmed send must never be reclassified as a failed customer merely
      // because Statflo's sidebar or Smart Lists page failed to reopen.
      try {
        await restoreSmartListsContextIfNeeded(page, runConfig.list);
      } catch (restoreErr) {
        stats._runError = 'smartlist-recovery-failed-after-outcome';
        logger.error(
          `[RUN_ABORT_NAVIGATION_RECOVERY_FAILED] client outcome preserved as ${reportOutcome}; stopping before another client — ${restoreErr.message}`,
          restoreErr,
        );
        break;
      }

      // Short pause before next card — do NOT navigate away.
      await safeWait(page, 400);

    } catch (err) {
      // Browser closed by user — stop cleanly, no error count increment.
      if (!isPageAlive(page) || err.message?.includes('Target page, context or browser has been closed') || err.message?.includes('Target closed')) {
        logger.warn('[USER_CLOSED_BROWSER_GRACEFUL_STOP] browser closed by user — ending run');
        logger.info(`[RUN_STOPPED_PAGE_CLOSED] processed=${stats.processed} sent=${stats.messaged}`);
        break;
      }
      // Remember the client on error paths too so we don't re-click it.
      if (cardClientName) {
        runConfig.processedClients?.add(cardClientName);
        logger.info(`[SESSION_CLIENT_REMEMBERED] name="${cardClientName}" outcome=error`);
      }

      if (err.isUncertainSend) {
        // UncertainSendError escaped from handleNextActionMultiLineFallback — safe skip, not a failure.
        logger.warn(`[UNCERTAIN_SEND_SKIP_CLIENT] client=${stats.processed + 1}: uncertain send in fallback path — skipping safely`);
        await restoreSmartListsContextIfNeeded(page, runConfig.list).catch(() => {});
        stats.processed++;
        stats.skipped++;
        consecutiveErrors = 0;
      } else {
        logger.error(`[RUN_FAIL] nextActionFilter client ${stats.processed + 1} failed`, err);
        stats.processed++;
        stats.failed++;
        consecutiveErrors++;
        logger.warn(`[RUN_FAIL] consecutive=${consecutiveErrors} processed=${stats.processed}/${maxDisplay}`);
      }

      logger.info(`[RUN_CLIENT_DONE] processed=${stats.processed}/${maxDisplay} sent=${stats.messaged} dnc=${stats.dnc} skip=${stats.skipped} fail=${stats.failed}`);
      await safeWait(page, 400);
    }
  }

  logger.info(`[RUN_SUMMARY] list="${runConfig.list}" processed=${stats.processed} sent=${stats.messaged} dnc=${stats.dnc} skip=${stats.skipped} dupSkip=${stats.duplicateSkipped} fail=${stats.failed}`);
  return stats;
}

module.exports = {
  navigateToSmartList,
  getClientRows,
  getSmartListCards,
  runNextActionList,
  processClient,
  runDoctor,
  humanDelay,
  spaSettle,
  // Shared platform-neutral engines — same logic on Mac and Windows
  runFirstAttemptShared,
  runNextActionAttemptShared,
  assertCorrectListContext,
  restoreSmartListsContextIfNeeded,
  handleNextActionMultiLineFallback,
  runFirstAttemptEveryoneMode,
  runNextActionEveryoneMode,
  // Multi-line eligibility helpers (exported for tests)
  SKIP_REASONS,
  resolveSkipReason,
  classifyLineState,
  detectSmsBlockedOrCooldownState,
  // Line identity — exported so the key scheme itself is testable
  keySmsLineHandles,
  hasAmbiguousLineKeys,
  hasLineBoundIdentity,
};
