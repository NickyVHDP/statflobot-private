/**
 * src/main.js
 * Entry point for statflo-ruflo-bot.
 *
 * Usage:
 *   node src/main.js                           # interactive menu (always shown for missing flags)
 *   node src/main.js --list=1st --mode=dry     # flags skip the matching menu questions
 *   npm run dry                                # alias: dry mode, max 1 client
 *   npm run live                               # alias: live mode (still shows any missing prompts)
 *   npm run doctor                             # selector-check mode
 *
 * CLI flags:
 *   --list=1st|2nd|3rd
 *   --mode=dry|live
 *   --max=1|3|5|10|all
 *   --delay=safe|normal|fast
 *   --mode=doctor
 */

'use strict';

const minimist = require('minimist');
const inquirer = require('inquirer');
const chalk    = require('chalk');

const config  = require('./config');
const logger  = require('./logger');
const session = require('./session');
const statflo = require('./statflo');

// ─── Parse CLI flags ─────────────────────────────────────────────────────────

const argv = minimist(process.argv.slice(2), {
  string:  ['list', 'mode', 'max', 'delay'],
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

  // Mode — ask if flag was absent or not a recognised value
  if (!argv.mode || !['dry', 'live'].includes(argv.mode)) {
    questions.push({
      type:    'list',
      name:    'mode',
      message: 'Run mode?',
      choices: [
        { name: 'Dry run  (no messages sent — safest for testing)', value: 'dry' },
        { name: 'Live     (REAL messages will be sent)',             value: 'live' },
      ],
      default: 'dry',
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

  const modeColor = runConfig.mode === 'live' ? chalk.red.bold : chalk.green;

  const border = '─'.repeat(52);
  console.log(`\n  ${border}`);
  console.log(chalk.bold(`  Run Summary`));
  console.log(`  ${border}`);
  console.log(`  List         : ${chalk.cyan(runConfig.list)}`);
  console.log(`  Nav mode     : ${chalk.cyan(listCfg.navMode || 'n/a')}`);
  console.log(`  Message mode : ${chalk.cyan(listCfg.messageMode || 'n/a')}`);
  console.log(`  Max clients  : ${chalk.cyan(maxLabel)}`);
  console.log(`  Delay        : ${chalk.cyan(delayLabel)}`);
  console.log(`  Mode         : ${modeColor(runConfig.mode.toUpperCase())}`);
  console.log(`  ${border}\n`);
}

// ─── Live confirmation ────────────────────────────────────────────────────────

async function confirmLive(runConfig) {
  const { confirmed } = await inquirer.prompt([{
    type:    'confirm',
    name:    'confirmed',
    message:
      chalk.red.bold(`\n⚠  LIVE MODE — real messages WILL be sent.\n`) +
      `  List       : ${runConfig.list}\n` +
      `  Max clients: ${runConfig.maxClients === Infinity ? 'all' : runConfig.maxClients}\n` +
      `  Delay      : ${runConfig.delayProfile}\n\n` +
      `  Are you sure you want to proceed?`,
    default: false,
  }]);
  return confirmed;
}

// ─── Launch guard ─────────────────────────────────────────────────────────────

async function checkLaunchToken() {
  const token = process.env.RUFLO_LAUNCH_TOKEN;
  const port  = process.env.RUFLO_DASHBOARD_PORT;

  // No token present — direct invocation outside the dashboard.
  if (!token || !port) {
    console.error(
      chalk.red('\n  ✖  Direct execution is not permitted.\n') +
      '  Start the bot through the StatfloBot dashboard.\n'
    );
    process.exit(1);
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/internal/verify-launch`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ token }),
      signal:  AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error(chalk.red('\n  ✖  Launch token rejected — please restart from the dashboard.\n'));
      process.exit(1);
    }
  } catch {
    console.error(chalk.red('\n  ✖  Could not reach dashboard to verify launch token.\n'));
    process.exit(1);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  logger.banner('Statflo Ruflo Bot');
  logger.info(`Log file: ${logger.logFile}`);

  // ── Launch guard — must be launched via dashboard (skip in dev/doctor) ───
  if (argv.mode !== 'doctor' && !process.env.LICENSE_SKIP) {
    await checkLaunchToken();
  }

  // ── License gate (skip in doctor mode so selector checks always work) ────
  if (argv.mode !== 'doctor') {
    try {
      const authGate = require('../monetization/local-gate/auth-gate');
      const license  = await authGate.verify();
      if (!license.valid) {
        console.log('\n' + '═'.repeat(56));
        console.log('  Access Blocked — License Required');
        console.log('═'.repeat(56));
        console.log(`  ${license.message}`);
        console.log('═'.repeat(56) + '\n');
        process.exit(1);
      }
      logger.info(`[License] ${license.message}`);
    } catch (gateErr) {
      // If the gate module itself errors (e.g. missing file), log and continue.
      // This prevents a bad deploy from blocking all existing users.
      logger.warn(`[License] Gate error (non-blocking): ${gateErr.message}`);
    }
  }

  // ── Doctor mode ──────────────────────────────────────────────────────────
  if (argv.mode === 'doctor') {
    const { page } = await session.launchBrowser();
    await page.goto(config.accountsUrl, { waitUntil: 'domcontentloaded', timeout: config.defaultTimeout });

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
  const resolvedList = resolveListFlag();
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

  const runConfig = {
    list:         listKey,
    mode:         argv.mode && ['dry', 'live'].includes(argv.mode)
                    ? argv.mode
                    : (answers.mode || config.defaults.mode),
    maxClients,
    delayProfile: argv.delay || answers.delayProfile || config.defaults.delayProfile,
  };

  // ── Print startup summary ────────────────────────────────────────────────
  printStartupSummary(runConfig);

  // ── Live mode confirmation ───────────────────────────────────────────────
  // --skip-confirm is passed by the dashboard, which already confirmed via UI.
  if (runConfig.mode === 'live' && !argv['skip-confirm']) {
    const ok = await confirmLive(runConfig);
    if (!ok) {
      logger.info('Live run cancelled by user');
      process.exit(0);
    }
  } else if (runConfig.mode === 'live' && argv['skip-confirm']) {
    logger.info('Live mode confirmed via dashboard — skipping terminal prompt');
  }

  logger.banner(`Starting run — ${runConfig.list} [${runConfig.mode.toUpperCase()}]`);

  // ── Browser & session ────────────────────────────────────────────────────
  const { page } = await session.launchBrowser();

  const isAuthed = await session.isLoggedIn(page);
  if (!isAuthed) {
    await session.waitForManualLogin(page);
  }

  // ── Navigate to selected smart list ─────────────────────────────────────
  await statflo.navigateToSmartList(page, runConfig.list);

  // ── Processing loop — branched hard by navMode ───────────────────────────
  const listConfig = config.lists[runConfig.list];
  const navMode    = listConfig.navMode || 'nextActionFilter';

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

    while (true) {
      if (stats.processed >= runConfig.maxClients) {
        logger.info(`Reached max clients limit (${runConfig.maxClients}) — stopping`);
        break;
      }

      const rows = await statflo.getClientRows(page).catch(() => []);
      if (clientIndex >= rows.length) {
        logger.info('No more clients in list — run complete');
        break;
      }

      const result = await statflo.processClient(page, clientIndex, runConfig);
      stats.processed++;

      switch (result) {
        case 'messaged': stats.messaged++; consecutiveErrors = 0; break;
        case 'dnc':      stats.dnc++;      consecutiveErrors = 0; break;
        case 'skipped':  stats.skipped++;  consecutiveErrors = 0; break;
        case 'failed':
          stats.failed++;
          consecutiveErrors++;
          if (consecutiveErrors >= config.maxConsecutiveErrors) {
            logger.error(`${config.maxConsecutiveErrors} consecutive errors — stopping`);
          }
          break;
      }

      if (consecutiveErrors >= config.maxConsecutiveErrors) break;

      if (result === 'skipped' || result === 'failed') {
        clientIndex++;
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  logger.summary(stats);
  await session.closeBrowser();
}

main().catch(err => {
  logger.error('Fatal error in main()', err);
  session.closeBrowser().catch(() => {});
  process.exit(1);
});
