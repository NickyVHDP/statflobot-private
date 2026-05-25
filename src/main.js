/**
 * src/main.js
 * Entry point for statflo-ruflo-bot.
 *
 * Usage:
 *   node src/main.js                      # interactive menu (always shown for missing flags)
 *   node src/main.js --list=1st           # flags skip the matching menu questions
 *   npm run live                          # run live (always live)
 *   npm run doctor                        # selector-check mode
 *
 * CLI flags:
 *   --list=1st|2nd|3rd
 *   --max=1|3|5|10|all
 *   --delay=safe|normal|fast
 *   --mode=doctor
 */

'use strict';

const minimist = require('minimist');
const inquirer = require('inquirer');
const chalk    = require('chalk');

const config      = require('./config');
const logger      = require('./logger');
const session     = require('./session');
const statflo     = require('./statflo');
const identity    = require('./identity');
const runReporter = require('./run-reporter');

// ─── Process-level safety nets ────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  logger.error(`[UNCAUGHT_EXCEPTION] ${err.stack || err.message || err}`);
  process.exit(1);
});
// Log unhandled rejections but do NOT exit — expired AbortSignal timers and
// other non-fatal rejections must not kill an otherwise-healthy run.
process.on('unhandledRejection', (err) => {
  logger.error(`[UNHANDLED_REJECTION] ${(err && (err.stack || err.message)) || err}`);
});

// ─── Parse CLI flags ─────────────────────────────────────────────────────────

const argv = minimist(process.argv.slice(2), {
  string:  ['list', 'mode', 'max', 'delay', 'everyone-mode'],
  boolean: ['skip-confirm'],
  default: {},
});

// Normalise --list shorthand: 1st → 1st Attempt, etc.
const LIST_ALIASES = {
  '1st':         '1st Attempt',
  '2nd':         '2nd Attempt',
  '3rd':         '3rd Attempt',
  '1st Attempt': '1st Attempt',
  '2nd Attempt': '2nd Attempt',
  '3rd Attempt': '3rd Attempt',
};

// ─── Flag validation ─────────────────────────────────────────────────────────

/**
 * If --list was provided, resolve it to the canonical name and validate.
 * Returns the resolved key, or null if the flag was absent.
 * Exits with an error message if the flag value is unrecognised.
 */
function resolveListFlag() {
  if (!argv.list) return null;
  const resolved = LIST_ALIASES[argv.list];
  if (!resolved || !config.lists[resolved]) {
    console.error(
      chalk.red(`\nUnknown --list value: "${argv.list}"\n`) +
      `  Valid values: ${Object.keys(LIST_ALIASES).filter(k => !k.includes(' ')).join(', ')}\n`
    );
    process.exit(1);
  }
  return resolved;
}

// ─── Interactive menu ─────────────────────────────────────────────────────────

async function askRunConfig(resolvedList) {
  const questions = [];

  // List — only ask if flag was absent (never silently default)
  if (!resolvedList) {
    questions.push({
      type:    'list',
      name:    'list',
      message: 'Which smart list do you want to process?',
      choices: Object.keys(config.lists),
    });
  }

  // Max clients — ask if flag was absent
  if (!argv.max) {
    questions.push({
      type:    'list',
      name:    'maxClients',
      message: 'How many clients to process max?',
      choices: [
        { name: '1  — single client (recommended for first run)', value: 1 },
        { name: '3',                                              value: 3 },
        { name: '5',                                              value: 5 },
        { name: '10',                                             value: 10 },
        { name: 'All (entire list)',                              value: 'all' },
      ],
      default: 1,
    });
  }

  // Delay profile — ask if flag was absent
  if (!argv.delay) {
    questions.push({
      type:    'list',
      name:    'delayProfile',
      message: 'Delay profile between actions?',
      choices: Object.entries(config.delayProfiles).map(([key, val]) => ({
        name:  val.label,
        value: key,
      })),
      default: config.defaults.delayProfile,
    });
  }

  if (questions.length > 0) {
    return inquirer.prompt(questions);
  }
  return {};
}

// ─── Startup summary ──────────────────────────────────────────────────────────

function printStartupSummary(runConfig) {
  const listCfg = config.lists[runConfig.list];
  const maxLabel = runConfig.maxClients === Infinity
    ? 'all'
    : String(runConfig.maxClients);
  const delayLabel = (config.delayProfiles[runConfig.delayProfile] || {}).label || runConfig.delayProfile;

  const border = '─'.repeat(52);
  console.log(`\n  ${border}`);
  console.log(chalk.bold(`  Run Summary`));
  console.log(`  ${border}`);
  console.log(`  List         : ${chalk.cyan(runConfig.list)}`);
  console.log(`  Nav mode     : ${chalk.cyan(listCfg.navMode || 'n/a')}`);
  console.log(`  Message mode : ${chalk.cyan(listCfg.messageMode || 'n/a')}`);
  console.log(`  Max clients  : ${chalk.cyan(maxLabel)}`);
  console.log(`  Delay        : ${chalk.cyan(delayLabel)}`);
  console.log(`  Mode         : ${chalk.red.bold('LIVE')}`);
  console.log(`  ${border}\n`);
}

// ─── Launch guard ─────────────────────────────────────────────────────────────

async function checkLaunchToken() {
  const token = process.env.RUFLO_LAUNCH_TOKEN;
  const port  = process.env.RUFLO_DASHBOARD_PORT;

  logger.info(`[LAUNCH_TOKEN_CHECK] token=${token ? 'present' : 'MISSING'} port=${port ?? 'MISSING'}`);

  // No token present — direct invocation outside the dashboard.
  if (!token || !port) {
    logger.error('[LAUNCH_TOKEN_FAIL] reason=missing-env RUFLO_LAUNCH_TOKEN or RUFLO_DASHBOARD_PORT not set — start via the StatfloBot dashboard');
    process.exit(1);
  }

  // Use AbortController + clearTimeout instead of AbortSignal.timeout() so the
  // timer is cancelled on success and cannot fire as an unhandled rejection later.
  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/internal/verify-launch`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ token }),
      signal:  ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error(`[LAUNCH_TOKEN_FAIL] reason=rejected status=${res.status} body=${body.slice(0, 200)}`);
      process.exit(1);
    }
    logger.info('[LAUNCH_TOKEN_OK] token verified successfully');
  } catch (err) {
    clearTimeout(timer);
    logger.error(`[LAUNCH_TOKEN_FAIL] reason=unreachable port=${port} error=${err.message}`);
    process.exit(1);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  logger.banner('Statflo Ruflo Bot');
  logger.info(`Log file: ${logger.logFile}`);
  logger.info(`[BOOT_ARGS_PARSED] list=${argv.list ?? '(none)'} mode=${argv.mode ?? '(none)'} max=${argv.max ?? '(none)'} delay=${argv.delay ?? '(none)'} skipConfirm=${!!argv['skip-confirm']}`);

  // ── Launch guard — must be launched via dashboard (skip in dev/doctor) ───
  if (argv.mode !== 'doctor' && !process.env.LICENSE_SKIP) {
    await checkLaunchToken();
  }
  logger.info('[BOOT_AFTER_LAUNCH_TOKEN]');

  // ── License gate ──────────────────────────────────────────────────────────
  // Skipped when:
  //   - doctor mode (selector checks must always work)
  //   - LICENSE_SKIP is set (debug bypass)
  //   - DASHBOARD_ACCESS_VERIFIED=1 (server already verified access before spawn)
  //     This prevents a double-check against the dead Vercel license endpoint.
  if (argv.mode !== 'doctor' && !process.env.LICENSE_SKIP && process.env.DASHBOARD_ACCESS_VERIFIED !== '1') {
    try {
      logger.info('[BOOT_LICENSE_START] loading auth-gate');
      const authGate = require('../monetization/local-gate/auth-gate');
      const license  = await authGate.verify();
      logger.info(`[BOOT_LICENSE_RESULT] valid=${license.valid} plan=${license.plan ?? '(none)'} msg="${license.message}"`);
      if (!license.valid) {
        logger.error(`[BOOT_LICENSE_BLOCKED] ${license.message}`);
        console.log('\n' + '═'.repeat(56));
        console.log('  Access Blocked — License Required');
        console.log('═'.repeat(56));
        console.log(`  ${license.message}`);
        console.log('═'.repeat(56) + '\n');
        process.exit(1);
      }
    } catch (gateErr) {
      // If the gate module itself errors (e.g. missing file), log and continue.
      // This prevents a bad deploy from blocking all existing users.
      logger.warn(`[BOOT_LICENSE_ERROR] Gate error (non-blocking): ${gateErr.message}`);
    }
  } else if (process.env.DASHBOARD_ACCESS_VERIFIED === '1') {
    logger.info('[BOOT_LICENSE_SKIPPED_DASHBOARD_VERIFIED] server already verified access — skipping local auth-gate');
  }

  // ── Doctor mode ──────────────────────────────────────────────────────────
  if (argv.mode === 'doctor') {
    const { page } = await session.launchBrowser();
    // launchBrowser() already navigates to config.accountsUrl — no extra goto needed.

    const isAuthed = await session.isLoggedIn(page);
    if (!isAuthed) {
      await session.waitForManualLogin(page);
    }

    await statflo.runDoctor(page);
    await session.pressEnterToContinue('\nPress ENTER to close the browser…');
    await session.closeBrowser();
    return;
  }

  // ── Resolve flags and run interactive menu for any missing values ─────────
  logger.info('[BOOT_MODE_RESOLVED] mode=live');
  const resolvedList = resolveListFlag();
  logger.info(`[BOOT_LIST_RESOLVED] list=${resolvedList ?? '(interactive)'}`);
  const answers      = await askRunConfig(resolvedList);

  // Merge: flags take precedence; menu answers fill the gaps.
  const listKey = resolvedList || answers.list;
  if (!listKey || !config.lists[listKey]) {
    // Should not happen — menu enforces valid choices — but guard anyway.
    console.error(chalk.red('\nNo valid list selected. Exiting.\n'));
    process.exit(1);
  }

  let maxClients;
  if (argv.max) {
    maxClients = argv.max === 'all' ? Infinity : parseInt(argv.max, 10);
  } else if (answers.maxClients === 'all') {
    maxClients = Infinity;
  } else {
    maxClients = parseInt(answers.maxClients, 10) || config.defaults.maxClients;
  }

  const processedClients = new Set();

  const runConfig = {
    list:         listKey,
    mode:         'live',
    maxClients,
    delayProfile: argv.delay || answers.delayProfile || config.defaults.delayProfile,
    processedClients,
    everyoneMode: argv['everyone-mode'] || null,
  };

  // ── Print startup summary ────────────────────────────────────────────────
  printStartupSummary(runConfig);

  logger.info('[MODE] LIVE — all sends are real');
  logger.info('[RUN_MEMORY_INIT] processedClients initialized');
  logger.banner(`Starting run — ${runConfig.list} [LIVE]`);

  // ── Browser & session ────────────────────────────────────────────────────
  logger.info('[BOOT_SESSION_START] launching browser');
  const { page } = await session.launchBrowser();
  logger.info('[BOOT_SESSION_READY] browser launched successfully');

  // launchBrowser() always clears Statflo/Okta auth — fresh login is required every run.
  // Skip the session-validity check and go straight to manual login.
  logger.info('[LOGIN_FLOW_FORCED_FRESH] browser session cleared — waiting for manual login');
  const capturedLoginUsername = await session.waitForManualLogin(page);
  logger.info('[BOT_FLOW_RESUME_AFTER_LOGIN] login confirmed — resuming bot outreach flow');

  // Extra guard: ensure we are on a confirmed authenticated Statflo page
  // BEFORE running the identity check.  After Okta login there are several
  // OAuth redirect hops (callback → sso → /accounts) during which the Okta
  // token is not yet written to localStorage.  Running detectStatfloIdentity
  // on those intermediate pages returns null and triggers a false block.
  const onAuthPage = await session.waitForAuthenticatedStatfloPage(page);
  logger.info('[BOT_FLOW_AUTH_CONFIRMED] authenticated Statflo page confirmed — proceeding to identity check');
  if (!onAuthPage) {
    // If we timed out and still aren't on /accounts, navigate there now.
    // This handles edge cases where the browser opened to a non-accounts URL.
    logger.warn('[AUTH_PAGE_GUARD] not on /accounts yet — navigating directly');
    try {
      await page.goto(config.accountsUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(2000);
    } catch { /* navigation errors are non-fatal — proceed and let identity check run */ }
  }

  // ── Statflo identity lock check ──────────────────────────────────────────
  // STATFLO_IDENTITY = the LOCKED/expected key (saved when user entered username in UI).
  // It is NOT treated as the current login — it is only the expected comparand.
  // We always detect the actual current Statflo login and compare it against the lock.
  //
  // Detection priority:
  //   1. Username captured from the Okta login form (most reliable — typed by the user)
  //   2. Okta token storage in localStorage/sessionStorage (30 s retry)
  //   3. DOM text scan on the authenticated Statflo page

  const lockedIdentity = (process.env.STATFLO_IDENTITY ?? '').trim() || null;
  if (lockedIdentity) {
    logger.info(`[STATFLO_IDENTITY_LOCKED_EXPECTED] key=${lockedIdentity}`);
  }

  // ── Detect current login identity ─────────────────────────────────────────
  let currentIdentity = null;

  // Path A: username the user just typed into the Okta form (captured during login wait)
  if (capturedLoginUsername) {
    const normalized = identity.normalizeStatfloIdentity(capturedLoginUsername);
    if (normalized) {
      logger.info(`[STATFLO_LOGIN_USERNAME_CAPTURED] raw=${capturedLoginUsername} key=${normalized}`);
      currentIdentity = normalized;
    }
  }

  // Path B: Okta token localStorage / DOM scan — retry for up to 30 s
  if (!currentIdentity) {
    const RETRY_DEADLINE = Date.now() + 30_000;
    let attempt = 0;
    logger.info('[STATFLO_IDENTITY_RETRY_START] polling Okta/DOM identity detection for 30 s…');
    while (Date.now() < RETRY_DEADLINE && !page.isClosed()) {
      attempt++;
      logger.info(`[STATFLO_IDENTITY_RETRY_ATTEMPT] attempt=${attempt}`);
      const detected = await session.detectStatfloIdentity(page);
      if (detected) {
        const normalized = identity.normalizeStatfloIdentity(detected);
        if (normalized) {
          logger.info(`[STATFLO_CURRENT_IDENTITY_DETECTED] raw=${detected} key=${normalized} attempt=${attempt}`);
          currentIdentity = normalized;
          break;
        }
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!currentIdentity) {
      logger.warn('[STATFLO_IDENTITY_RETRY_EXHAUSTED] could not detect current Statflo identity after 30 s');
    }
  }

  logger.info(`[BOT_FLOW_IDENTITY_RESULT] detected=${currentIdentity ?? '(null)'} locked=${lockedIdentity ?? '(none)'}`);

  // ── Compare or lock ───────────────────────────────────────────────────────
  if (lockedIdentity) {
    // A locked identity exists — compare strictly and block on any mismatch or unknown.
    if (!currentIdentity) {
      logger.error(
        `[STATFLO_IDENTITY_UNKNOWN_BLOCKED] Locked identity is "${lockedIdentity}" but the current ` +
        `Statflo login could not be detected. Ensure you are fully logged into Statflo and try again.`
      );
      logger.error(`[BOT_FLOW_STOP_AFTER_LOGIN_REASON] identity=unknown locked=${lockedIdentity}`);
      await new Promise(r => setTimeout(r, 5000));
      await session.closeBrowser();
      process.exit(2);
    }

    if (currentIdentity !== lockedIdentity) {
      logger.error(
        `[STATFLO_IDENTITY_MISMATCH_BLOCKED] locked=${lockedIdentity} current=${currentIdentity} — ` +
        `This StatfloBot account is locked to a different Statflo login. ` +
        `Please sign into the original Statflo account or contact support.`
      );
      logger.error(`[BOT_FLOW_STOP_AFTER_LOGIN_REASON] identity=mismatch locked=${lockedIdentity} detected=${currentIdentity}`);
      await new Promise(r => setTimeout(r, 5000));
      await session.closeBrowser();
      process.exit(2);
    }

    logger.info(`[STATFLO_IDENTITY_MATCHED] locked=${lockedIdentity} current=${currentIdentity}`);
    logger.info(`[BOT_FLOW_IDENTITY_MATCH_CONFIRMED] identity verified — proceeding with run`);
  } else {
    // No lock yet — fall through to checkAndLockIdentity which creates the lock.
    const identityResult = await identity.checkAndLockIdentity(currentIdentity, {
      dashboardPort: process.env.RUFLO_DASHBOARD_PORT,
      botDataDir:    process.env.BOT_DATA_DIR,
    });

    logger.info(
      `[STATFLO_IDENTITY_CHECK] locked=${identityResult.lockedKey ?? '(none)'} current=${currentIdentity ?? '(not-detected)'} allowed=${identityResult.allowed}`
    );

    if (!identityResult.allowed) {
      if (identityResult.reason === 'mismatch' || identityResult.reason === 'local-mismatch') {
        logger.error(
          `[STATFLO_IDENTITY_MISMATCH_BLOCKED] This StatfloBot account is locked to Statflo user ` +
          `"${identityResult.lockedKey ?? '?'}". ` +
          `Detected user is "${currentIdentity ?? 'unknown'}". ` +
          `Please sign into the original Statflo account or contact support.`
        );
      } else {
        logger.error(
          `[STATFLO_IDENTITY_UNKNOWN_BLOCKED] Could not detect Statflo username — ` +
          `run blocked for security. Ensure you are fully logged into Statflo and try again.`
        );
      }
      logger.error(`[BOT_FLOW_STOP_AFTER_LOGIN_REASON] allowed=false reason=${identityResult.reason ?? 'unknown'} detected=${currentIdentity ?? '(null)'} locked=${identityResult.lockedKey ?? '(none)'}`);
      await new Promise(r => setTimeout(r, 1500));
      await session.closeBrowser();
      process.exit(2);
    }

    logger.info(`[STATFLO_IDENTITY_MATCHED] identity verified — key=${identityResult.lockedKey ?? currentIdentity}`);
    logger.info(`[BOT_FLOW_IDENTITY_MATCH_CONFIRMED] identity verified — proceeding with run`);
  }

  // ── Navigate to selected smart list ─────────────────────────────────────
  logger.info(`[BOT_FLOW_SMARTLIST_START] navigating to smart list: ${runConfig.list}`);
  try {
    await statflo.navigateToSmartList(page, runConfig.list);
  } catch (smartlistErr) {
    logger.error(`[BOT_FLOW_BLOCKED_AFTER_LOGIN_REASON] reason=smartlist-nav-failed error="${smartlistErr.message}"`);
    await session.closeBrowser();
    process.exit(1);
  }
  logger.info(`[BOT_FLOW_SMARTLIST_LOADED] smart list navigation complete — entering processing loop`);

  // ── Processing loop — branched hard by navMode ───────────────────────────
  const listConfig = config.lists[runConfig.list];
  const navMode    = listConfig.navMode || 'nextActionFilter';

  logger.info(`[BOT_FLOW_FIRST_CLIENT_START] starting client processing loop navMode=${navMode}`);

  let stats;

  if (navMode === 'nextActionFilter') {
    // ── FLOW B: 2nd / 3rd Attempt ─────────────────────────────────────────
    // runNextActionList owns the full lifecycle:
    //   poll smartlist-card buttons → open → direct-message → return → repeat
    const result = await statflo.runNextActionList(page, runConfig);
    stats = {
      list:      runConfig.list,
      mode:      runConfig.mode,
      processed: result.processed,
      messaged:  result.messaged,
      dnc:       result.dnc,
      skipped:   result.skipped,
      failed:    result.failed,
    };

  } else {
    // ── FLOW A: 1st Attempt / statusFilter ────────────────────────────────
    // Accounts-page row loop: a.crm-list-account-name → SMS inspection →
    // Chat Starter / DNC.
    stats = {
      list:      runConfig.list,
      mode:      runConfig.mode,
      processed: 0,
      messaged:  0,
      dnc:       0,
      skipped:   0,
      failed:    0,
    };

    let consecutiveErrors = 0;
    let clientIndex       = 0;
    let browserClosed     = false;
    const maxDisplay      = runConfig.maxClients === Infinity ? '∞' : runConfig.maxClients;

    while (true) {
      if (stats.processed >= runConfig.maxClients) {
        logger.info(`[RUN_COMPLETE] target reached (${maxDisplay}) — stopping`);
        break;
      }

      // If the page was already closed by a previous iteration, stop immediately.
      if (page.isClosed()) {
        logger.warn('[RUN_STOPPED_BROWSER_CLOSED] page is closed at loop start — stopping run');
        browserClosed = true;
        break;
      }

      let rows = await statflo.getClientRows(page).catch(() => []);
      logger.info(`[RUN_LOOP] list="${runConfig.list}" iter=${stats.processed + 1}/${maxDisplay} clientIdx=${clientIndex} visible=${rows.length} sent=${stats.messaged} dnc=${stats.dnc} skip=${stats.skipped} fail=${stats.failed} consErr=${consecutiveErrors}`);
      logger.info(`[RUN_LOOP_VISIBLE_COUNT] visible=${rows.length} clientIdx=${clientIndex}`);

      // Guard: zero visible rows may mean the page is mid-load or in the wrong state
      // after a send + return. Before attempting recovery, check that the browser is
      // still alive — a closed browser always yields 0 rows and should not be retried.
      if (rows.length === 0) {
        if (page.isClosed()) {
          logger.warn('[RUN_STOPPED_BROWSER_CLOSED] browser closed — stopping run instead of recovering');
          browserClosed = true;
          break;
        }
        logger.warn(`[RUN_LOOP_RECOVERY_AFTER_CLIENT] visible=0 clientIdx=${clientIndex} — reloading list`);
        await statflo.navigateToSmartList(page, runConfig.list).catch(e => {
          logger.warn(`[RUN_LOOP_RECOVERY_AFTER_CLIENT] list reload failed: ${e.message}`);
        });
        rows = await statflo.getClientRows(page).catch(() => []);
        logger.info(`[RUN_LOOP_VISIBLE_COUNT] after recovery: visible=${rows.length} clientIdx=${clientIndex}`);
        if (rows.length === 0) {
          if (page.isClosed()) {
            logger.warn('[RUN_STOPPED_BROWSER_CLOSED] browser closed after recovery attempt — stopping run');
            browserClosed = true;
            break;
          }
          logger.info('[RUN_LOOP_LIST_EXHAUSTED_CONFIRMED] list still empty after recovery — confirmed exhausted');
          break;
        }
        logger.info(`[RUN_LOOP_RECOVERY_AFTER_CLIENT] recovered ${rows.length} row(s) — continuing`);
      }

      if (clientIndex >= rows.length) {
        logger.info(`[RUN_LOOP_LIST_EXHAUSTED_CONFIRMED] clientIdx=${clientIndex} >= visible=${rows.length} — list exhausted`);
        break;
      }

      const result = await statflo.processClient(page, clientIndex, runConfig);
      stats.processed++;

      if (result === 'browser_closed') {
        logger.warn('[RUN_STOPPED_BROWSER_CLOSED] processClient detected browser closed — stopping run');
        browserClosed = true;
        break;
      }

      switch (result) {
        case 'messaged':
          stats.messaged++;
          consecutiveErrors = 0;
          break;
        case 'dnc':
          stats.dnc++;
          consecutiveErrors = 0;
          break;
        case 'skipped':
          stats.skipped++;
          consecutiveErrors = 0;
          clientIndex++;
          break;
        case 'failed':
          stats.failed++;
          consecutiveErrors++;
          clientIndex++;
          logger.warn(`[RUN_FAIL] consecutive=${consecutiveErrors} clientIdx=${clientIndex - 1} processed=${stats.processed}`);
          break;
      }

      logger.info(`[RUN_CLIENT_DONE] result=${result} processed=${stats.processed}/${maxDisplay} clientIdx=${clientIndex}`);
    }

    if (browserClosed) {
      stats._browserClosed = true;
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  logger.summary(stats);

  // ── Upload sanitized run summary (fire-and-forget, never blocks) ─────────
  const allFailed = !stats._browserClosed &&
    stats.processed > 0 &&
    stats.messaged === 0 &&
    stats.failed === stats.processed;

  if (allFailed) {
    logger.error(`[RUN_ALL_CLIENTS_FAILED] processed=${stats.processed} messaged=0 failed=${stats.failed} — marking run as failed`);
  }

  const runStatus = stats._browserClosed
    ? 'browser_closed'
    : allFailed ? 'failed'
    : stats.failed > 0 ? 'completed_with_errors' : 'completed';
  await runReporter.report(stats, { logFilePath: logger.logFile, status: runStatus });

  await session.closeBrowser();
  // Explicit exit ensures the process terminates even when the list finishes
  // naturally or the browser was closed mid-run — Playwright can leave async
  // listeners that keep Node alive indefinitely without this.
  process.exit(allFailed ? 1 : 0);
}

main().catch(err => {
  if (err instanceof session.LoginCancelledError || err.name === 'LoginCancelledError') {
    logger.info('[LOGIN_CANCELLED_BY_USER] browser closed by user — exiting cleanly');
    session.closeBrowser().catch(() => {});
    runReporter.report(
      { list: null, mode: 'live', messaged: 0, dnc: 0, skipped: 0, failed: 0 },
      { logFilePath: logger.logFile, status: 'stopped' }
    ).catch(() => {});
    process.exit(0);
  }
  logger.error(`[BOOT_FATAL] ${err.stack || err.message || err}`);
  session.closeBrowser().catch(() => {});
  runReporter.report(
    { list: null, mode: 'live', messaged: 0, dnc: 0, skipped: 0, failed: 1 },
    { logFilePath: logger.logFile, status: 'failed' }
  ).catch(() => {});
  process.exit(1);
});
