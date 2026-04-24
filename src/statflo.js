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

const config    = require('./config');
const SELECTORS = require('./selectors');
const logger    = require('./logger');

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
 * Scroll into view then click.  Retries on failure.
 */
async function safeClick(page, selector, label = 'element') {
  return retry(`click ${label}`, async () => {
    const el = await page.waitForSelector(selector, { state: 'visible', timeout: config.defaultTimeout });
    await el.scrollIntoViewIfNeeded();
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

      await safeClick(page, SELECTORS.statusFilterApplyButton, 'Apply filter (status)');
      // Gate: wait for the client list to be visible and stable.
      await waitForClientListReady(page, 'statusFilter');

    } else {
      // ── 2nd / 3rd Attempt: Conversations → Smart Lists tab → Filters → Next Action → Apply ──
      const label = listConfig.label; // "2nd Attempt" or "3rd Attempt"

      // Informational pre-flight only — never blocks the run.
      await isTargetListAlreadyActive(page, label).catch(() => {});

      // Step 1: Click Conversations nav
      // Gate: wait for Smart Lists tab — confirms Conversations view is loaded.
      await page.locator(SELECTORS.conversationsNav).first().click();
      logger.info('Clicked Conversations nav');
      await page.locator(SELECTORS.smartListsTab).waitFor({ state: 'visible', timeout: config.defaultTimeout });

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
 * Poll for the SMS composer textarea after clicking a line button.
 *
 * After an SMS line click the SPA navigates and re-mounts the composer.
 * This is deliberately more generous than findFirst — the poll is every
 * 200 ms for up to timeoutMs (default 6 000 ms).
 *
 * Returns { found: true, element } or { found: false, reason }.
 */
async function waitForComposerAfterSmsLineClick(page, timeoutMs = 6000) {
  const SELECTORS_COMPOSER = [
    '#message-input',
    'textarea[placeholder="Write a message"]',
    'textarea[placeholder*="message" i]',
  ];

  logger.info(`[POST_DNC_COMPOSER_WAIT] polling for composer textarea (${timeoutMs} ms)`);

  const deadline = Date.now() + timeoutMs;
  const INTERVAL = 200;

  while (Date.now() < deadline) {
    for (const sel of SELECTORS_COMPOSER) {
      try {
        const el = await page.$(sel);
        if (el) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) {
            logger.info(`[SMS_LINE_COMPOSER_FOUND] selector="${sel}"`);
            return { found: true, element: el };
          }
        }
      } catch { /* element may have been detached during SPA re-render */ }
    }
    await page.waitForTimeout(INTERVAL);
  }

  logger.warn('[SMS_LINE_COMPOSER_TIMEOUT] composer did not appear within timeout');
  logger.warn('[SMS_LINE_COMPOSER_NOT_FOUND] will attempt back-navigation');
  return { found: false, reason: 'timeout' };
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
  const STAGE_A_MS  = 1500;  const STAGE_A_INT = 150;
  const STAGE_B_MS  = 4000;  const STAGE_B_INT = 250;
  const STAGE_C_MS  = 3500;  const STAGE_C_INT = 300;

  const check = async () => {
    for (const { signal, selector } of MESSAGE_UI_SIGNALS) {
      if (!selector) continue;
      try {
        const el = await page.$(selector);
        if (el) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) return signal;
        }
      } catch { /* invalid selector — skip */ }
    }
    return null;
  };

  logger.info('Waiting for 1st Attempt message UI after SMS click');

  // Stage A — quick
  const stageAEnd = Date.now() + STAGE_A_MS;
  while (Date.now() < stageAEnd) {
    const found = await check();
    if (found) { logger.info(`1st Attempt message UI ready via: ${found}`); return found; }
    await page.waitForTimeout(STAGE_A_INT);
  }

  // Stage B — extended
  logger.info('Message UI quick-check not ready — extending wait');
  const stageBEnd = Date.now() + STAGE_B_MS;
  while (Date.now() < stageBEnd) {
    const found = await check();
    if (found) { logger.info(`1st Attempt message UI ready via: ${found}`); return found; }
    await page.waitForTimeout(STAGE_B_INT);
  }

  // Stage C — final push
  logger.info('Message UI still loading after SMS click — continuing extended wait');
  const stageCEnd = Date.now() + STAGE_C_MS;
  while (Date.now() < stageCEnd) {
    const found = await check();
    if (found) { logger.info(`1st Attempt message UI ready via: ${found}`); return found; }
    await page.waitForTimeout(STAGE_C_INT);
  }

  // Hard timeout
  const totalMs = STAGE_A_MS + STAGE_B_MS + STAGE_C_MS;
  throw new Error(
    `1st Attempt message UI did not load after ${totalMs} ms — ` +
    'no Chat Starter, premade cards, draft/inline field, textarea, compose region, or Send area appeared.'
  );
}

// ─── Chat / compose area ─────────────────────────────────────────────────────

/**
 * Returns true if a Send button is present and not disabled.
 */
async function isSendEnabled(page) {
  try {
    const btns = await page.$$('button.btn.primary[data-testid="btn"]');
    for (const btn of btns) {
      const disabled = await btn.evaluate(el =>
        el.disabled ||
        el.getAttribute('aria-disabled') === 'true' ||
        el.classList.contains('disabled')
      );
      if (!disabled) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

// ─── 1st Attempt flow helpers ─────────────────────────────────────────────────

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

  // ── STRICT PRIORITY 1: top premade cards ─────────────────────────────────
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

  // ── STRICT PRIORITY 2: bottom Chat Starter wizard ────────────────────────
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
  logger.info('Clicking Send…');
  await safeClick(page, SELECTORS.sendButton, 'Send button');
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
  logger.info(`[SEND_CONFIRMATION_WAIT] two-phase confirmation (fast≤1.8s, fallback≤${timeoutMs}ms)`);

  // ── Phase 1: fast-path ────────────────────────────────────────────────────
  const FAST_MS = 1800;
  const started = await waitForSendStarted(page, FAST_MS);
  if (started) {
    logger.info('[SEND_STARTED_FAST] send-accepted signal detected — moving to next client');
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
  // Try direct XPath first (confirmed selector).
  // If it is not immediately visible, open the account menu first.
  let logBtn = await findFirst(page, SELECTORS.logActivityMenuItem, 4000);
  if (!logBtn) {
    logger.debug('"Log an Activity" not directly visible — trying account menu');
    const menuBtn = await findFirst(page, [
      SELECTORS.accountDetailsButton,
      SELECTORS.threeDotsMenuButton,
    ], 5000);
    if (!menuBtn) {
      throw new Error(
        'Could not find "Log an Activity" button or account menu trigger.\n' +
        'Check SELECTORS.logActivityMenuItem and SELECTORS.accountDetailsButton.'
      );
    }
    await menuBtn.scrollIntoViewIfNeeded();
    await menuBtn.click();
    await page.waitForTimeout(800);
    logBtn = await findFirst(page, SELECTORS.logActivityMenuItem, 5000);
    if (!logBtn) {
      throw new Error('"Log an Activity" not found in account menu.');
    }
  }
  await logBtn.scrollIntoViewIfNeeded();
  await logBtn.click();
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
  await page.goto(config.accountsUrl, {
    waitUntil: 'domcontentloaded',
    timeout: config.defaultTimeout,
  });
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

  const enabledButtons = await getEnabledSmsButtons(page);
  logger.info(`${clientName}: ${enabledButtons.length} enabled SMS line(s) — attempting in order`);

  let flowSucceeded = false;
  let flowName      = null;
  const attemptedLines = new Set();

  for (let lineIdx = 0; lineIdx < enabledButtons.length && !flowSucceeded; lineIdx++) {
    if (attemptedLines.has(lineIdx)) continue;
    attemptedLines.add(lineIdx);

    const freshButtons = await getEnabledSmsButtons(page);
    if (lineIdx >= freshButtons.length) {
      logger.warn(`${clientName}: line index ${lineIdx} no longer available after re-collect`);
      break;
    }

    try {
      if (enabledButtons.length > 1) {
        logger.info(`${clientName}: trying SMS line ${lineIdx + 1}/${enabledButtons.length}`);
      }
      const readySignal = await clickSmsButton(page, freshButtons[lineIdx]);
      flowName = await runFirstAttemptFlow(page, readySignal);
      flowSucceeded = true;
    } catch (lineErr) {
      const remaining = enabledButtons.length - lineIdx - 1;
      logger.warn(
        `${clientName}: SMS line ${lineIdx + 1} failed` +
        (remaining > 0 ? ` — ${remaining} more line(s) to try` : ' — no more lines') +
        `\n  reason: ${lineErr.message}`
      );
      if (remaining > 0) {
        logger.info(`${clientName}: reloading client profile to try next SMS line`);
        await page.goto(clientProfileUrl, { waitUntil: 'domcontentloaded', timeout: config.defaultTimeout });
        await waitForClientDetailReady(page, 'statusFilter');
      }
    }
  }

  if (!flowSucceeded) {
    throw new Error(`All ${attemptedLines.size} SMS line(s) exhausted — no usable message flow found`);
  }

  const flowLabel = flowName === 'topPremade'        ? 'top premade flow'
                  : flowName === 'bottomChatStarter' ? 'Chat Starter flow'
                  : flowName;
  logger.info(`${clientName}: ${flowLabel} complete — Send button confirmed enabled`);

  if (mode === 'live') {
    const isDupe = await checkForDuplicateMessage(page, listConfig.text);
    if (isDupe) {
      logger.warn(`[DUPLICATE_PROTECTION] ${clientName}: skipping send — last message already matches template`);
    } else {
      await clickSend(page);
      const confirmed = await waitForMessageDeliveryConfirmation(page, 10000);
      if (confirmed) {
        logger.success(`${clientName}: Message SENT`);
      } else {
        logger.warn(`[SEND_NOT_CONFIRMED] ${clientName}: delivery not confirmed — skipping client to prevent duplicate`);
        logger.info(`[UNCERTAIN_SEND_SKIP_CLIENT] message may have sent, skipping client to prevent duplicate`);
        await humanDelay(page, delayProfile);
        await returnToSmartListsDirect(page, list);
        throw new UncertainSendError();
      }
    }
  } else {
    logger.info(`[DRY RUN] Would send to ${clientName} — Send not clicked`);
  }

  await humanDelay(page, delayProfile);
  await returnToSmartListsDirect(page, list);
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

  try {
    let clientName = `Client #${rowIndex + 1}`;

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

      // Read name before clicking — locator re-queries DOM each time.
      clientName = await clientLinks.nth(rowIndex)
        .getAttribute('title').then(t => t?.trim() || '').catch(() => '')
        || await clientLinks.nth(rowIndex)
          .textContent().then(t => t?.trim() || `Client #${rowIndex + 1}`).catch(() => `Client #${rowIndex + 1}`);

      logger.info(`Opening client: ${clientName}`);

      // Stability check on a fresh handle (non-stale — just acquired).
      const freshEl   = await clientLinks.nth(rowIndex).elementHandle().catch(() => null);
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

      // Focus the message textarea
      const textarea = await findFirst(
        page,
        ['textarea#message-input', 'textarea[placeholder="Write a message"]'],
        config.defaultTimeout
      );
      if (!textarea) {
        throw new Error(
          'Message textarea not found after opening Smart Lists client.\n' +
          'Tried: textarea#message-input, textarea[placeholder="Write a message"]'
        );
      }
      logger.info('Focused message textarea');
      await textarea.scrollIntoViewIfNeeded();
      await textarea.click();
      await humanDelay(page, delayProfile);

      // Type the configured message
      await typeDirectMessage(page, listConfig.text);
      logger.info('Typed configured message');
      await humanDelay(page, delayProfile);

      // Verify Send becomes enabled
      const sendReady = await isSendEnabled(page);
      if (sendReady) {
        logger.info('Send enabled');
      } else {
        logger.warn('Send button not enabled after typing — textarea may not have registered input');
      }

      // Send or dry-run
      if (mode === 'live') {
        const isDupe = await checkForDuplicateMessage(page, listConfig.text);
        if (isDupe) {
          logger.warn(`[DUPLICATE_PROTECTION] ${clientName}: skipping send — last message already matches template`);
        } else {
          await clickSend(page);
          const confirmed = await waitForMessageDeliveryConfirmation(page, 10000);
          if (confirmed) {
            logger.success(`${clientName}: Message SENT`);
          } else {
            logger.warn(`[SEND_NOT_CONFIRMED] ${clientName}: delivery not confirmed — skipping client to prevent duplicate`);
            logger.info(`[UNCERTAIN_SEND_SKIP_CLIENT] message may have sent, skipping client to prevent duplicate`);
            await humanDelay(page, delayProfile);
            await returnToList(page, list);
            await humanDelay(page, delayProfile);
            throw new UncertainSendError();
          }
        }
      } else {
        logger.info(`[DRY RUN] Would send message`);
      }

      await humanDelay(page, delayProfile);
      logger.info('Returning to smart list');
      await returnToList(page, list);
      await humanDelay(page, delayProfile);
      return 'messaged';
    }

    // ── 1st Attempt (statusFilter): SMS line detection → Chat Starter / DNC ────
    const { hasActiveSms } = await inspectLines(page);

    if (!hasActiveSms) {
      logger.info(`${clientName}: No active SMS lines`);

      if (listConfig.dncEnabled) {
        if (mode === 'live') {
          await logDncActivity(page);
          logger.success(`${clientName}: DNC activity logged`);
        } else {
          logger.info(`[DRY RUN] Would log DNC for ${clientName}`);
        }
        await returnToSmartListsDirect(page, list);
        await humanDelay(page, delayProfile);
        return 'dnc';
      }

      logger.info(`${clientName}: DNC disabled for this list — skipping`);
      await returnToSmartListsDirect(page, list);
      return 'skipped';
    }

    await runFirstAttemptShared(page, { listConfig, mode, delayProfile, clientName, clientProfileUrl: page.url(), list });
    return 'messaged';

  } catch (err) {
    if (err.isUncertainSend) {
      // Send was clicked but delivery unconfirmed — skip safely, do not retry or DNC.
      logger.warn(`[UNCERTAIN_SEND_SKIP_CLIENT] client ${rowIndex + 1}: uncertain send — skipping safely`);
      return 'skipped';
    }
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
async function handleNextActionMultiLineFallback(page, clientNum, listConfig, mode, delayProfile, listName) {
  logger.info(`[NEXT_ACTION_SHARED_FALLBACK_START] listName="${listName}" client=${clientNum}`);
  logger.info('Direct-message flow blocked — opening View Account');
  await clickViewAccount(page);
  await page.waitForTimeout(600);

  let lineAttempts  = 0;
  let composerFound = false;
  let sent          = false;
  let dncLogged     = false;
  let resultReason  = 'unknown';

  // ── Initial SMS line scan ─────────────────────────────────────────────────
  logger.info(`[NEXT_ACTION_SHARED_SMS_SCAN] scanning SMS lines after View Account`);
  let enabledButtons = await querySmsLinesGlobally(page);

  if (enabledButtons.length === 0) {
    resultReason = 'no-enabled-lines';
    logger.warn(`[NEXT_ACTION_SHARED_SMS_SCAN] no enabled SMS lines — will proceed to DNC check`);
  } else {
    logger.info(`[NEXT_ACTION_SHARED_SMS_SCAN] ${enabledButtons.length} enabled SMS line(s) found`);
  }

  // ── Line attempt loop ─────────────────────────────────────────────────────
  let lineIndex = 0;

  while (lineIndex < enabledButtons.length) {
    lineAttempts++;
    const lineNum = lineIndex + 1;

    // ── A. Click line button ──────────────────────────────────────────────
    const btn = enabledButtons[lineIndex];
    logger.info(`[NEXT_ACTION_SHARED_SMS_SCAN] clicking line ${lineNum} of ${enabledButtons.length}`);
    try {
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
    } catch (clickErr) {
      logger.warn(`line ${lineNum} click error (${clickErr.message}) — re-querying`);
      await page.waitForTimeout(400);
      enabledButtons = await querySmsLinesGlobally(page);
      if (lineIndex >= enabledButtons.length) break;
      await enabledButtons[lineIndex].scrollIntoViewIfNeeded();
      await enabledButtons[lineIndex].click();
    }
    await page.waitForTimeout(400);

    // ── B. Wait for composer ──────────────────────────────────────────────
    logger.info(`[NEXT_ACTION_SHARED_COMPOSER_WAIT] waiting for #message-input on line ${lineNum}`);
    const composerResult = await waitForComposerAfterSmsLineClick(page, 6000);

    if (!composerResult.found) {
      logger.warn(`line ${lineNum} — no composer appeared; navigating back to account profile`);
      const restored = await navigateBackToAccountProfile(page);
      await page.waitForTimeout(600);
      if (!restored) {
        logger.warn('could not restore account profile — stopping line loop');
        resultReason = 'nav-restore-failed';
        break;
      }
      logger.info('[SMS_LINE_REQUERY_AFTER_FAIL] re-querying SMS buttons after back-nav');
      enabledButtons = await querySmsLinesGlobally(page);
      lineIndex++;
      continue;
    }

    // ── C. Composer found — fill ──────────────────────────────────────────
    composerFound = true;
    logger.info(`[NEXT_ACTION_SHARED_COMPOSER_FOUND] composer present on line ${lineNum}`);

    try {
      await focusAndFillComposerAfterDnc(page, listConfig.text);
      logger.info(`[NEXT_ACTION_SHARED_TEXTAREA_FILLED] message filled on line ${lineNum}`);
    } catch (fillErr) {
      logger.error(`[POST_DNC_FAILURE_REASON] fill failed on line ${lineNum}: ${fillErr.message}`);
      await navigateBackToAccountProfile(page).catch(() => {});
      await page.waitForTimeout(600);
      enabledButtons = await querySmsLinesGlobally(page);
      lineIndex++;
      composerFound = false;
      continue;
    }

    // ── D. Poll Send ──────────────────────────────────────────────────────
    const sendReady = await pollSendEnabled(page, 3000);
    logger.info(`[NEXT_ACTION_SHARED_SEND_READY] line ${lineNum} sendReady=${sendReady}`);

    if (!sendReady) {
      logger.warn(`line ${lineNum} — filled but Send blocked (cooldown) — trying next`);
      await navigateBackToAccountProfile(page).catch(() => {});
      await page.waitForTimeout(600);
      enabledButtons = await querySmsLinesGlobally(page);
      lineIndex++;
      composerFound = false;
      continue;
    }

    // ── E. Send ──────────────────────────────────────────────────────────
    logger.info(`[POST_DNC_SEND_CLICK] clicking Send on line ${lineNum}`);
    if (mode === 'live') {
      const isDupe = await checkForDuplicateMessage(page, listConfig.text);
      if (isDupe) {
        logger.warn(`[DUPLICATE_PROTECTION] client=${clientNum} line=${lineNum}: skipping send — last message already matches template`);
        sent = true; // treat as sent to avoid DNC
      } else {
        await clickSend(page);
        const confirmed = await waitForMessageDeliveryConfirmation(page, 10000);
        if (confirmed) {
          logger.success(`Client ${clientNum}: Message SENT on line ${lineNum}`);
          sent = true;
        } else {
          logger.warn(`[SEND_NOT_CONFIRMED] client=${clientNum} line=${lineNum}: delivery not confirmed — skipping client to prevent duplicate`);
          logger.info(`[UNCERTAIN_SEND_SKIP_CLIENT] message may have sent, skipping client to prevent duplicate`);
          throw new UncertainSendError();
        }
      }
    } else {
      logger.info(`[DRY RUN] Would send on line ${lineNum}`);
      sent = true;
    }

    resultReason = `sent-line-${lineNum}`;
    logger.info(`[NEXT_ACTION_SHARED_RESULT] client=${clientNum} list="${listName}" lineAttempts=${lineAttempts} composerFound=true sent=true dncLogged=false reason=${resultReason}`);
    return 'messaged';
  }

  // ── All lines exhausted — DNC or skip ────────────────────────────────────
  logger.warn(`all ${lineAttempts} line attempt(s) exhausted — no send path for client ${clientNum}`);

  if (listConfig.dncEnabled) {
    const accountReady = await ensureAccountViewForDnc(page);
    if (!accountReady) {
      logger.error('[DNC_MENU_NOT_FOUND] account view not recoverable — skipping DNC for this client');
      resultReason = 'dnc-nav-failed';
      logger.info(`[NEXT_ACTION_SHARED_RESULT] client=${clientNum} list="${listName}" lineAttempts=${lineAttempts} composerFound=${composerFound} sent=false dncLogged=false reason=${resultReason}`);
      return 'skipped';
    }

    if (mode === 'live') {
      await logDncActivity(page);
      dncLogged = true;
      logger.success(`Client ${clientNum}: DNC activity logged`);
    } else {
      logger.info(`[DRY RUN] Would log DNC for client ${clientNum}`);
      dncLogged = true;
    }
    resultReason = 'dnc';
    logger.info(`[NEXT_ACTION_SHARED_DNC] client=${clientNum} list="${listName}"`);
    logger.info(`[NEXT_ACTION_SHARED_RESULT] client=${clientNum} list="${listName}" lineAttempts=${lineAttempts} composerFound=${composerFound} sent=false dncLogged=${dncLogged} reason=${resultReason}`);
    return 'dnc';
  }

  resultReason = 'skipped-dnc-disabled';
  logger.info(`[NEXT_ACTION_SHARED_RESULT] client=${clientNum} list="${listName}" lineAttempts=${lineAttempts} composerFound=${composerFound} sent=false dncLogged=false reason=${resultReason}`);
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
async function findDirectMessageTextareaQuick(page) {
  const TIMEOUT  = 1500; // ms
  const INTERVAL =  150; // ms
  const SELECTORS_LIST = [
    'textarea#message-input',
    'textarea[placeholder="Write a message"]',
  ];

  logger.info('Checking for direct-message textarea');
  const start = Date.now();

  while (Date.now() - start < TIMEOUT) {
    for (const sel of SELECTORS_LIST) {
      const els = await page.$$(sel).catch(() => []);
      if (els.length > 0) return els[0];
    }
    await page.waitForTimeout(INTERVAL);
  }

  const elapsed = Date.now() - start;
  logger.info(`Direct-message textarea not found after ${elapsed} ms — falling back to View Account`);
  throw new DncFallbackNeeded();
}

async function runNextActionAttemptShared(page, clientNum, listConfig, mode, delayProfile) {
  logger.info(`[PLATFORM_SHARED_FLOW] platform=${process.platform} attempt=2nd/3rd engine=runNextActionAttemptShared client=${clientNum}`);
  logger.info('Using direct-message flow for nextActionFilter');

  // Hard-timebox check — throws DncFallbackNeeded if textarea absent within 1500 ms.
  const textarea = await findDirectMessageTextareaQuick(page);

  logger.info('Focused message textarea');
  await textarea.scrollIntoViewIfNeeded();
  await textarea.click();

  await typeDirectMessage(page, listConfig.text);
  logger.info('Typed configured message');

  // Poll Send for 2 s. A disabled Send after typing means the line is in a
  // cooldown / wait-to-send state — throw DncFallbackNeeded so the caller can
  // try the next available SMS line on this client.
  const sendReady = await pollSendEnabled(page, 2000);
  if (!sendReady) {
    logger.warn('Send not enabled after typing — line may be blocked by cooldown, triggering SMS line fallback');
    throw new DncFallbackNeeded();
  }

  if (mode === 'live') {
    const isDupe = await checkForDuplicateMessage(page, listConfig.text);
    if (isDupe) {
      logger.warn(`[DUPLICATE_PROTECTION] client=${clientNum}: skipping send — last message already matches template`);
      logger.info(`[NEXT_ACTION_SHARED_RESULT] platform=${process.platform} client=${clientNum} result=duplicate-skipped`);
    } else {
      await clickSend(page);
      const confirmed = await waitForMessageDeliveryConfirmation(page, 10000);
      if (confirmed) {
        logger.success(`Client ${clientNum}: Message SENT`);
        logger.info(`[NEXT_ACTION_SHARED_RESULT] platform=${process.platform} client=${clientNum} result=messaged`);
      } else {
        logger.warn(`[SEND_NOT_CONFIRMED] client=${clientNum}: delivery not confirmed — skipping client to prevent duplicate`);
        logger.info(`[UNCERTAIN_SEND_SKIP_CLIENT] message may have sent, skipping client to prevent duplicate`);
        logger.info(`[NEXT_ACTION_SHARED_RESULT] platform=${process.platform} client=${clientNum} result=uncertain-send`);
        throw new UncertainSendError();
      }
    }
  } else {
    logger.info(`[DRY RUN] Would send message`);
    logger.info(`[NEXT_ACTION_SHARED_RESULT] platform=${process.platform} client=${clientNum} result=dry-run`);
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
  // Strategy A: evaluate-based focus + click (bypasses SPA synthetic event path)
  await page.evaluate(el => { el.focus(); el.click(); }, textarea);
  let isFocused = await page.evaluate(el => document.activeElement === el, textarea);

  // Strategy B: double-click via handle
  if (!isFocused) {
    logger.warn('[POST_DNC_TEXTAREA_FOCUSED] strategy A failed — trying double-click');
    await textarea.click({ clickCount: 2, delay: 50 });
    await page.waitForTimeout(200);
    isFocused = await page.evaluate(el => document.activeElement === el, textarea);
  }

  // Strategy C: locator force click (ignores pointer-events / overlay)
  if (!isFocused) {
    logger.warn('[POST_DNC_TEXTAREA_FOCUSED] strategy B failed — using locator force click');
    await page.locator(SELECTOR).click({ force: true });
    await page.waitForTimeout(150);
    isFocused = await page.evaluate(el => document.activeElement === el, textarea);
  }

  logger.info(`[POST_DNC_TEXTAREA_FOCUSED] activeElement === ${SELECTOR}: ${isFocused}`);

  // ── 4. Clear stale value via native setter so React onChange fires ────────
  await page.evaluate(el => {
    // Use the native value setter so React's synthetic onChange is triggered
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
  }, textarea);
  await page.waitForTimeout(150);

  // ── 5. Fill — primary: locator.fill() ────────────────────────────────────
  await page.locator(SELECTOR).fill(messageText);

  // ── 6. Verify value ───────────────────────────────────────────────────────
  let value = await page.evaluate(el => el.value, textarea);
  logger.info(`[POST_DNC_TEXTAREA_VALUE_LEN] after fill: ${value.length} chars`);

  // ── 7. Retry: native setter + dispatch if fill() did not stick ────────────
  if (!value || value.trim().length === 0) {
    logger.warn('[POST_DNC_TEXTAREA_VALUE_LEN] fill() did not stick — using native setter');
    await page.evaluate((el, text) => {
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
    }, textarea, messageText);
    await page.waitForTimeout(100);
    value = await page.evaluate(el => el.value, textarea);
    logger.info(`[POST_DNC_TEXTAREA_VALUE_LEN] after native setter: ${value.length} chars`);
  }

  // ── 8. Hard guard ─────────────────────────────────────────────────────────
  if (!value || value.trim().length === 0) {
    const msg = `[POST_DNC_FAILURE_REASON] textarea still empty after all fill strategies — aborting`;
    logger.error(msg);
    throw new Error(msg);
  }
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

  if (mode === 'live') {
    const isDupe = await checkForDuplicateMessage(page, listConfig.text);
    if (isDupe) {
      logger.warn(`[DUPLICATE_PROTECTION] client=${clientNum}: skipping send (post-DNC) — last message already matches template`);
    } else {
      logger.info('[POST_DNC_SEND_CLICK] clicking Send');
      await clickSend(page);
      const confirmed = await waitForMessageDeliveryConfirmation(page, 10000);
      if (confirmed) {
        logger.success(`Client ${clientNum}: Message SENT (post-DNC transition)`);
      } else {
        logger.warn(`[SEND_NOT_CONFIRMED] client=${clientNum}: delivery not confirmed (post-DNC) — skipping client to prevent duplicate`);
        logger.info(`[UNCERTAIN_SEND_SKIP_CLIENT] message may have sent, skipping client to prevent duplicate`);
        throw new UncertainSendError();
      }
    }
  } else {
    logger.info(`[DRY RUN] Would send message (post-DNC transition)`);
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
async function runNextActionList(page, runConfig) {
  const { mode, maxClients, delayProfile } = runConfig;
  const listConfig = config.lists[runConfig.list];

  logger.info('Entering dedicated nextActionFilter run path');

  const stats = { processed: 0, messaged: 0, dnc: 0, skipped: 0, failed: 0 };
  let consecutiveErrors = 0;
  let lastOutcome = null; // tracks previous iteration outcome for logging

  // First poll — cards are visible after Apply + 1s wait in navigateToSmartList.
  logger.info('Polling for Smart Lists cards after Apply');

  while (true) {
    if (stats.processed >= maxClients) {
      logger.info(`Reached max clients limit (${maxClients}) — stopping`);
      break;
    }

    // ── Poll for smartlist-card buttons on the persistent left panel ─────────
    // On the first iteration this follows Apply. On subsequent iterations the
    // left panel is still visible — no navigation required.
    if (stats.processed > 0) {
      logger.info('Re-querying Smart Lists cards on persistent left list');
    }

    const cards = await pollForSmartListCards(page, 10000);

    if (cards.length === 0) {
      logger.info('No Smart Lists cards found after retries — run complete');
      break;
    }

    logger.info('Clicking top Smart Lists card for next client');

    try {
      await assertCorrectListContext(page, runConfig.list);
      await openFirstSmartListCard(page);
      // Short fixed pause — runNextActionAttemptShared polls the textarea itself.
      await page.waitForTimeout(400);

      let outcome;
      try {
        // ── Primary: direct-message flow ─────────────────────────────────
        logger.info(`[NEXT_ACTION_SHARED_FLOW_START] client=${stats.processed + 1} list="${runConfig.list}" prevOutcome=${lastOutcome ?? 'none'}`);
        await runNextActionAttemptShared(page, stats.processed + 1, listConfig, mode, delayProfile);
        outcome = 'messaged';
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

      await restoreSmartListsContextIfNeeded(page, runConfig.list);

      lastOutcome = outcome;
      stats.processed++;
      if (outcome === 'messaged') stats.messaged++;
      else if (outcome === 'dnc')  stats.dnc++;
      else                          stats.skipped++;
      consecutiveErrors = 0;

      logger.info(`Completed nextActionFilter client ${stats.processed}/${maxClients === Infinity ? '∞' : maxClients} [${outcome}]`);

      // Short pause before next card — do NOT navigate away.
      await page.waitForTimeout(400);

    } catch (err) {
      if (err.isUncertainSend) {
        // UncertainSendError escaped from handleNextActionMultiLineFallback — safe skip, not a failure.
        logger.warn(`[UNCERTAIN_SEND_SKIP_CLIENT] client=${stats.processed + 1}: uncertain send in fallback path — skipping safely`);
        await restoreSmartListsContextIfNeeded(page, runConfig.list).catch(() => {});
        stats.processed++;
        stats.skipped++;
        consecutiveErrors = 0;
      } else {
        logger.error(`nextActionFilter client ${stats.processed + 1} failed`, err);
        stats.processed++;
        stats.failed++;
        consecutiveErrors++;
        if (consecutiveErrors >= config.maxConsecutiveErrors) {
          logger.error(`${config.maxConsecutiveErrors} consecutive errors — stopping`);
          break;
        }
      }

      await page.waitForTimeout(400);
    }
  }

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
};
