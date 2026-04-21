/**
 * src/selectors.js
 * All Playwright selectors in one place.
 *
 * HOW TO UPDATE SELECTORS
 * ───────────────────────
 * 1. Run `npm run doctor` — the browser opens and checks every selector.
 * 2. Look at the NOT FOUND items. Open DevTools, inspect the element, copy the
 *    selector here.
 * 3. Re-run doctor to confirm it is FOUND.
 *
 * PLAYWRIGHT SELECTOR TIPS
 * ─────────────────────────
 * :text("…")         — matches any element whose visible text equals the string
 * :has-text("…")     — matches a container that contains the text anywhere inside
 * :has(selector)     — matches a container that contains a matching child
 * xpath=//…          — XPath selector (xpath= prefix required for Playwright)
 *
 * CONFIDENCE LEVELS
 * ──────────────────
 * [CONFIRMED]  — user provided this selector; known to work
 * [LIKELY]     — strong evidence; not yet run against live DOM
 * [TODO]       — unknown; MUST be verified before live runs
 */

'use strict';

const SELECTORS = {

  // ─────────────────────────────────────────────────────────────────────────
  // SMART LISTS NAVIGATION
  // ─────────────────────────────────────────────────────────────────────────

  // Top-level "Smart Lists" nav link. Click this to reach the filter area.
  // [CONFIRMED] Provided by user.
  smartListsNav: 'a#nav-smart-lists',

  // ─────────────────────────────────────────────────────────────────────────
  // 2nd / 3rd ATTEMPT NAVIGATION (Conversations → Smart Lists → Filters flow)
  // ─────────────────────────────────────────────────────────────────────────

  // Step 1 — Conversations nav link.
  // [CONFIRMED] Provided by user.
  conversationsNav: '[data-testid="nav-link-nav-conversations"], a[href="/t/conversations"]',

  // Step 3 — Smart Lists tab inside the Conversations page.
  // [CONFIRMED] Provided by user.
  smartListsTab: 'button[data-testid="main-tabs-tab-smartlist"]',

  // Step 5 — Filters button that opens the filter panel.
  // [CONFIRMED] Provided by user.
  slFilterButton: 'button#sl-filter-button, button[data-testid="btn-sl-filter-button"]',

  // ── 1st Attempt navigation (Status filter flow) ───────────────────────────
  // Status dropdown — select value "1" for New Accounts.
  // [CONFIRMED] Provided by user.
  statusDropdown: 'select#filterByCompletedCall',

  // Apply button for the Status filter flow (1st Attempt only).
  // This is a distinct <a> element, not the shared button[data-testid="btn"].
  // [CONFIRMED] Provided by user.
  statusFilterApplyButton: 'a#applySmartListFilters',

  // ── 2nd / 3rd Attempt navigation (Next Action filter flow) ────────────────
  // Button that opens the Next Action filter listbox.
  // [CONFIRMED] Provided by user.
  nextActionFilterButton: 'button[data-testid="listbox-slf-filter-filterByNextAction-btn"]',

  // Apply button inside the Next Action filter panel.
  // Apply and Reset share button[data-testid="btn"] — must discriminate by text.
  // Primary: :has-text("Apply") narrows to the correct button.
  // [CONFIRMED] Provided by user.
  nextActionApplyButton: 'button[data-testid="btn"]:has-text("Apply")',

  // ─────────────────────────────────────────────────────────────────────────
  // CLIENT LIST — ACCOUNTS PAGE (1st Attempt)
  // ─────────────────────────────────────────────────────────────────────────

  // A single client row. Derived from the confirmed clientNameLink selector —
  // look for a <tr> or <li> that contains the link.
  // [LIKELY] Derived from confirmed clientNameLink.
  clientRow: 'tr:has(a.crm-list-account-name), li:has(a.crm-list-account-name)',

  // The clickable link inside a row that opens the client profile.
  // [CONFIRMED] Provided by user.
  clientNameLink: 'a.crm-list-account-name',

  // Next page pagination link.
  // [CONFIRMED] Provided by user.
  paginationNext: 'li.paginate_button.page-item.next:not(.disabled) a.page-link',

  // ─────────────────────────────────────────────────────────────────────────
  // CLIENT LIST — CONVERSATIONS SMART LISTS (2nd / 3rd Attempt)
  // ─────────────────────────────────────────────────────────────────────────

  // First result card in the Smart Lists results panel.
  // [CONFIRMED] Provided by user.
  smartListCardFirst: 'button[data-testid="smartlist-card-0"]',

  // Any result card (general, index-agnostic).
  // [CONFIRMED] Provided by user.
  smartListCard: 'button[data-testid^="smartlist-card-"]',

  // ─────────────────────────────────────────────────────────────────────────
  // CLIENT PROFILE — SMS BUTTONS
  // ─────────────────────────────────────────────────────────────────────────

  // The SMS action button on a line. [CONFIRMED] Provided by user.
  smsButton: 'button.dialTwilio.js-trigger-twilio-message.row-icon-sms',

  // Disabled SMS button — same selector, checked programmatically via
  // el.disabled / aria-disabled / .disabled class.
  // [CONFIRMED] Derived from the confirmed smsButton selector.
  smsButtonDisabled: 'button.dialTwilio.js-trigger-twilio-message.row-icon-sms[disabled], button.dialTwilio.js-trigger-twilio-message.row-icon-sms.disabled',

  // ─────────────────────────────────────────────────────────────────────────
  // CONVERSATION / CHAT UI
  // ─────────────────────────────────────────────────────────────────────────

  // Chat Starter button — appears when the conversation has not been started.
  // Click this to enter the Chat Starter wizard.
  // [CONFIRMED] Provided by user (both forms).
  chatStarterButton: 'button[aria-label="Chat Starter"][data-testid="btn"], button[aria-label="Chat Starter"]',

  // "Next" button inside the Chat Starter wizard.
  // Real outerHTML: <button aria-label="Next" class="btn … plain tertiary …" data-testid="btn">
  // aria-label is capital-N "Next", not lowercase.
  // [CONFIRMED] Provided by user.
  chatStarterNextButton: 'button[aria-label="Next"][data-testid="btn"], button[aria-label="Next"], button.btn.plain.tertiary[data-testid="btn"][aria-label="Next"]',

  // Draft / compose field populated by Chat Starter.
  // [CONFIRMED] Provided by user.
  draftField: '[data-testid="inline-field"][contenteditable="true"]',

  // ─────────────────────────────────────────────────────────────────────────
  // PREMADE MESSAGES (only used when messageMode === 'premade')
  // ─────────────────────────────────────────────────────────────────────────

  // Button/link to open the premade messages panel if not already visible.
  // [TODO] Verify against live DOM.
  premadeOpenButton: 'button[aria-label*="premade" i], button[aria-label*="template" i], :text("Premade"), :text("Templates"), [data-testid="premade-btn"]',

  // A single premade message item.
  // [TODO] Could be a button, li, or div — inspect the premade panel.
  premadeItem: '[data-testid="premade-item"], .premade-message-item, .template-item',

  // 1st Attempt alternate flow: premade message cards shown directly in the chat panel
  // without a Chat Starter button.
  //
  // Confirmed card structure (from user-provided outerHTML):
  //   <div data-testid="74eb1fe3-…" class="rounded-2xl p-3 max-w-md … bg-blue-100 …">
  //
  // Strategy: match on rounded-2xl + bg-blue-100 combination which is stable.
  // [CONFIRMED] Structure provided by user.
  premadeCardItem: [
    'div[data-testid][class*="rounded-2xl"][class*="bg-blue-100"]',
    'div[class*="rounded-2xl"][class*="bg-blue-100"]',
  ],

  // "Next" arrow inside the premade panel.
  // [TODO] May be the same element as chatStarterNextButton — verify in the live UI.
  premadeNextArrow: 'button[aria-label="next"].plain.tertiary, button[aria-label="next"], [data-testid="premade-next"], .premade-next',

  // ─────────────────────────────────────────────────────────────────────────
  // MESSAGE COMPOSE & SEND
  // ─────────────────────────────────────────────────────────────────────────

  // Message input for 2nd / 3rd Attempt typed messages.
  // Primary: confirmed textarea#message-input.
  // Secondary: confirmed textarea[placeholder="Write a message"].
  // Fallback: contenteditable draftField (used by Chat Starter / 1st Attempt).
  // [CONFIRMED] textarea#message-input and placeholder form provided by user.
  messageInput: 'textarea#message-input, textarea[placeholder="Write a message"], [data-testid="inline-field"][contenteditable="true"], textarea.message-compose, div[contenteditable="true"][data-placeholder], textarea[placeholder*="message" i]',

  // The Send button.
  // [CONFIRMED] Provided by user (both forms listed).
  sendButton: 'button.btn.primary[data-testid="btn"], button[data-testid="btn"]:has-text("Send")',

  // ─────────────────────────────────────────────────────────────────────────
  // DNC FLOW — LOG ACTIVITY
  // ─────────────────────────────────────────────────────────────────────────

  // "Log an Activity" button — XPath confirmed by user.
  // Tried directly first; falls back to opening the account menu.
  // [CONFIRMED] Provided by user.
  logActivityMenuItem: "xpath=//button[.//span[contains(text(), 'Log an Activity')]]",

  // Account details button — fallback menu trigger.
  // [CONFIRMED] Provided by user.
  accountDetailsButton: 'button[aria-label="Open"][data-testid="mobile-account-details"]',

  // Three-dot kebab menu — secondary fallback.
  // [TODO] Inspect the client profile toolbar.
  threeDotsMenuButton: 'button[aria-label="More options"], button[aria-label*="more" i], [data-testid="more-options"]',

  // ─────────────────────────────────────────────────────────────────────────
  // DNC FLOW — LOG ACTIVITY MODAL FORM FIELDS
  // ─────────────────────────────────────────────────────────────────────────

  // "Customer Interaction" <select> dropdown.
  // [CONFIRMED] Provided by user.
  customerInteractionDropdown: 'select#conversationSelectType',

  // "Phone Outcome" <select> dropdown. Dots in the ID are CSS-escaped as \\.
  // [CONFIRMED] Provided by user.
  outcomeDropdown: 'select#conversationSelectType\\.collection\\.items\\.1\\.dependent_field\\.phoneOutcome',

  // "All Channels" radio button.
  // [CONFIRMED] Provided by user.
  dncAllChannelsRadio: 'input#conversationSelectType\\.collection\\.items\\.1\\.dependent_field\\.phoneOutcome\\.collection\\.items\\.4\\.dependent_field\\.dncChannelTypes--all--logActivity',

  // Note textarea inside the modal.
  // [CONFIRMED] Provided by user.
  activityNoteTextarea: 'textarea#phoneMessage',

  // Save / submit button inside the modal.
  // [CONFIRMED] Provided by user.
  activityConfirmButton: 'button.stfloCallWidget__button.stfloCallWidget__button--save',

  // ─────────────────────────────────────────────────────────────────────────
  // DNC FIELD VALUES
  // ─────────────────────────────────────────────────────────────────────────
  dncValues: {
    // [CONFIRMED] <select> option value for "SMS" interaction type.
    customerInteractionValue: '4',
    // [CONFIRMED] <select> option value for "DNC" outcome.
    outcomeValue:             'DNC',
    // [CONFIRMED] Note text logged on the activity.
    note:                     'DNC',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // VIEW ACCOUNT (from Conversations / Smart Lists card view)
  // ─────────────────────────────────────────────────────────────────────────

  // Link/button that opens the full account profile from a conversation card.
  // Order: stable text → aria → href pattern → DOM-path last resort.
  // [CONFIRMED] Text-based primary provided by user; DOM-path fallback provided.
  viewAccountLink: [
    'a:has-text("View Account")',
    'button:has-text("View Account")',
    '[aria-label="View Account"]',
    'a[href*="/accounts/"]',
    // DOM-path last resort (fragile — only used if nothing above matches):
    '#root > div > div.flex-1.block > div > div > div.h-\\[100dvh\\].flex.flex-col.w-full.overflow-hidden.relative.shadow-navigation.dark\\:shadow-transparent.dark\\:border-l.dark\\:border-blueGrey-800 > div.flex.flex-col.gap-3.bg-blueGrey-50.flex-1.p-3.overflow-y-auto.scroller.dark\\:bg-darkMode-900 > div:nth-child(1) > div > div:nth-child(2) > div > div.w-full.flex.justify-center > a',
  ],

  // ─────────────────────────────────────────────────────────────────────────
  // NAVIGATION — BACK TO LIST
  // ─────────────────────────────────────────────────────────────────────────

  // "Back to list" / breadcrumb shown on a client profile page.
  // [TODO] Inspect the profile page header to find this element.
  returnToListButton: '[data-testid="back-to-list"], button[aria-label*="back" i], .back-button, a[href*="/accounts"]',

};

module.exports = SELECTORS;
