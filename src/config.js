/**
 * src/config.js
 * Central configuration for statflo-ruflo-bot.
 *
 * WHAT TO EDIT HERE
 * ─────────────────
 * - Smart list labels, selectors, and fallback text
 * - Per-list message mode (premade vs typed text)
 * - Premade index / keyword for each list
 * - Exact typed message text for 2nd / 3rd Attempt
 * - DNC settings per list
 * - Timing profiles and retry counts
 *
 * Selectors for UI elements live in src/selectors.js — keep them separate.
 */

'use strict';

require('dotenv').config();

const path = require('path');
const fs   = require('fs');

// ── Diagnostic path logging ──────────────────────────────────────────────────
// Emitted immediately on startup so Windows logs clearly show what paths the
// bot is using. These lines are captured by ui/server stdout handler and
// forwarded to the dashboard log panel.
console.log('[config] ── path diagnostics ──────────────────────────────────');
console.log(`[config] platform        : ${process.platform}`);
console.log(`[config] BOT_DATA_DIR    : ${process.env.BOT_DATA_DIR    || '(not set — dev mode)'}`);
console.log(`[config] SESSION_PROFILE : ${process.env.SESSION_PROFILE_DIR || '(not set — using ./playwright-profile)'}`);
console.log(`[config] LOGS_DIR        : ${process.env.LOGS_DIR        || '(not set — using ./logs)'}`);
console.log(`[config] USER_DATA_DIR   : ${process.env.USER_DATA_DIR   || '(not set)'}`);
console.log('[config] ────────────────────────────────────────────────────────');

// Load dashboard-saved messages if present; fall back to empty defaults.
// BOT_DATA_DIR is set by ui/server when running in packaged mode so the path
// points to the user-scoped writable location rather than the read-only bundle.
// In dev mode fall back to ui/server/data/messages.json.
function loadSavedMessages() {
  const file = process.env.BOT_DATA_DIR
    ? path.join(process.env.BOT_DATA_DIR, 'messages.json')
    : path.resolve(__dirname, '../ui/server/data/messages.json');

  console.log(`[config] messages file   : ${file}`);
  try {
    const raw  = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    const hasSecond = !!(data.secondAttemptMessage || '').trim();
    const hasThird  = !!(data.thirdAttemptMessage  || '').trim();
    console.log(`[config] messages loaded : secondAttempt=${hasSecond ? 'YES' : 'EMPTY'}, thirdAttempt=${hasThird ? 'YES' : 'EMPTY'}`);
    return data;
  } catch (err) {
    console.log(`[config] messages file not found or unreadable (${err.code || err.message}) — using empty defaults`);
    return {};
  }
}

const _saved = loadSavedMessages();

const BASE_URL = process.env.STATFLO_BASE_URL || 'https://csok.app.us.statflo.com';
const ACCOUNTS_PATH = process.env.STATFLO_ACCOUNTS_PATH || '/accounts';

const config = {
  // Full URL to the Statflo accounts / smart-list landing page
  accountsUrl: `${BASE_URL}${ACCOUNTS_PATH}`,

  // ─── Session ──────────────────────────────────────────────────────────────
  // SESSION_PROFILE_DIR is injected by ui/server in packaged mode to point to
  // the user-writable Application Support directory instead of the read-only
  // app bundle. Falls back to ./playwright-profile for dev/terminal runs.
  sessionProfileDir: path.resolve(
    process.env.SESSION_PROFILE_DIR || './playwright-profile'
  ),

  // ─── Browser ─────────────────────────────────────────────────────────────
  // headless:false means the browser window is visible — keep this way for testing
  headless: process.env.HEADLESS === 'true',

  // Windows: use system Edge (pre-installed on all Windows 10/11 machines).
  // Playwright's bundled 'chromium' requires a manual `playwright install chromium`
  // step that end users on Windows will not have run.  msedge is always present.
  //
  // Mac/Linux: use playwright's own bundled chromium (no system browser required;
  // the developer environment already ran `npm run install-browsers`).
  browserChannel: process.platform === 'win32' ? 'msedge' : undefined,

  // ─── Retry & Error Thresholds ────────────────────────────────────────────
  maxRetries: 3,
  maxConsecutiveErrors: parseInt(process.env.MAX_CONSECUTIVE_ERRORS, 10) || 3,

  // ─── Timing Profiles ─────────────────────────────────────────────────────
  // Delays are randomly picked in [min, max] to look more human.
  // All values are in milliseconds.
  delayProfiles: {
    safe:   { min: 3000, max: 6000, label: 'Safe   (3–6 s)' },
    normal: { min: 2000, max: 4000, label: 'Normal (2–4 s)' },
    fast:   { min: 1000, max: 2000, label: 'Fast   (1–2 s)' },
    // Minimal humanDelay between confirmed UI transitions.
    // Safe for all flows — readiness checks are unaffected by this profile.
    turbo:  { min:  300, max:  600, label: 'Turbo  (0.3–0.6 s)' },
  },
  defaultDelayProfile: 'normal',

  // Extra pause (ms) after navigation / modal open to let the SPA settle
  spaSettleWait: 1500,

  // Element wait timeout (ms) — how long before a selector lookup gives up
  defaultTimeout: 15000,

  // ─── Smart List Configuration ────────────────────────────────────────────
  //
  // Each key is the "canonical name" shown in the CLI menu.
  //
  // Fields
  // ──────
  //   label          Text as it appears in the Statflo smart-list sidebar.
  //                  This is used for text-based matching when no exact
  //                  selector is provided.
  //
  //   selector       Optional exact CSS selector that uniquely targets the
  //                  smart-list sidebar item. Leave as '' if unknown.
  //                  When set, this is tried FIRST before text matching.
  //                  Example: 'span.text-subtitle-2.truncate'
  //                  The bot will automatically combine it with :text("label")
  //                  to narrow the match.
  //
  //   fallbackLabel  Alternate visible text to try if `label` is not found.
  //                  Leave as null if not needed.
  //
  //   messageMode    'premade' — select a message from the in-app premade list
  //                  'text'    — type / paste exact text into the compose box
  //
  //   premadeIndex   0-based index of the premade message to click.
  //                  Only used when messageMode === 'premade'.
  //
  //   premadeKeyword If set, prefer the premade message whose visible text
  //                  contains this keyword (case-insensitive) over index.
  //                  Falls back to premadeIndex if no keyword match is found.
  //                  Only used when messageMode === 'premade'.
  //
  //   text           Exact message text to type into the compose box.
  //                  Only used when messageMode === 'text'.
  //                  Set to '' as a placeholder — fill it in before live use.
  //
  //   dncEnabled     Whether to log a DNC activity when all lines are
  //                  unavailable for SMS.
  //
  //   notes          Human-readable notes — not used by any code.
  // ─────────────────────────────────────────────────────────────────────────

  lists: {
    // ── 1st Attempt ─────────────────────────────────────────────────────────
    '1st Attempt': {
      label: '1st Attempt',

      // Navigation: Smart Lists nav → Status dropdown (value "1") → Apply.
      // [CONFIRMED] See SELECTORS.smartListsNav, statusDropdown, filterApplyButton.
      navMode: 'statusFilter',
      statusValue: '1',   // "1" = New Accounts in the Status dropdown

      // 1st Attempt uses Chat Starter → Next → Send.
      // ensureChatOpen handles the CS + Next steps; no separate premade
      // panel selection is needed.
      messageMode: 'chatStarter',

      // Keep premadeIndex in case the fallback premade flow is ever needed.
      premadeIndex: 1,
      premadeKeyword: null,
      text: null,

      // Flow B: which visible starter card to click (0-based).
      // The UI shows multiple large premade/starter cards — 0 clicks the first.
      // Change to 1 if the second card should be used instead.
      flowBCardIndex: 0,

      // Direct-message fallback used when Chat Starter / Flow B cannot enable Send.
      // Reads from the same persistent store as 2nd Attempt so the dashboard
      // message editor controls both. Do NOT duplicate the message text here.
      fallbackCustomText: _saved.secondAttemptMessage || '',

      dncEnabled: true,
      notes: 'Initial outreach — Chat Starter flow, New Accounts filter',
    },

    // ── 2nd Attempt ─────────────────────────────────────────────────────────
    '2nd Attempt': {
      label: '2nd Attempt',

      // Navigation: Next Action filter button → pick "2nd Attempt" → Apply.
      // [CONFIRMED] See SELECTORS.nextActionFilterButton, filterApplyButton.
      navMode: 'nextActionFilter',

      messageMode: 'text',

      premadeIndex: null,
      premadeKeyword: null,

      text: _saved.secondAttemptMessage || '',

      dncEnabled: true,
      notes: 'Follow-up — second contact, typed text',
    },

    // ── 3rd Attempt ─────────────────────────────────────────────────────────
    '3rd Attempt': {
      label: '3rd Attempt',

      // Navigation: Next Action filter button → pick "3rd Attempt" → Apply.
      navMode: 'nextActionFilter',

      messageMode: 'text',

      premadeIndex: null,
      premadeKeyword: null,

      // Loaded from dashboard-saved messages; falls back to empty — must be set via dashboard.
      text: _saved.thirdAttemptMessage || '',

      dncEnabled: true,
      notes: 'Final attempt — same text as 2nd Attempt',
    },
  },

  // ─── Default run settings (overridden by CLI menu / flags) ───────────────
  defaults: {
    mode: 'dry',
    maxClients: 1,
    delayProfile: 'normal',
  },

  // ─── Output paths ─────────────────────────────────────────────────────────
  // LOGS_DIR injected by ui/server in packaged mode (user-writable location).
  logsDir: path.resolve(process.env.LOGS_DIR || './logs'),
};

module.exports = config;