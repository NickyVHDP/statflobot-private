/**
 * src/logger.js
 * Structured logger — writes timestamped output to console and to a log file.
 *
 * Usage:
 *   const logger = require('./logger');
 *   logger.info('Processing client', { name: 'John Smith' });
 *   logger.warn('SMS button not found on line 2');
 *   logger.error('Failed to open DNC modal', err);
 *   logger.success('Message sent to John Smith');
 *   logger.summary({ processed: 5, messaged: 3, dnc: 1, skipped: 1, failed: 0 });
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const chalk = require('chalk');

const config = require('./config');

// Ensure the logs directory exists
fs.mkdirSync(config.logsDir, { recursive: true });

// One log file per run, named by start timestamp
const runTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
const logFilePath  = path.join(config.logsDir, `run-${runTimestamp}.log`);

// ─── Internal helpers ───────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString();
}

function write(level, msg, data) {
  const line = JSON.stringify({ ts: ts(), level, msg, ...(data ? { data } : {}) });
  fs.appendFileSync(logFilePath, line + '\n', 'utf8');
}

function formatData(data) {
  if (!data) return '';
  if (data instanceof Error) return ` — ${data.message}`;
  if (typeof data === 'object') return ' ' + JSON.stringify(data);
  return ` ${data}`;
}

// ─── Public API ─────────────────────────────────────────────────────────────

const logger = {
  /** Current log file path — handy to print at run start */
  logFile: logFilePath,

  info(msg, data) {
    console.log(chalk.cyan(`[INFO]  ${ts()}`) + ` ${msg}` + formatData(data));
    write('info', msg, data);
  },

  warn(msg, data) {
    console.log(chalk.yellow(`[WARN]  ${ts()}`) + ` ${msg}` + formatData(data));
    write('warn', msg, data);
  },

  error(msg, data) {
    const dataStr = data instanceof Error
      ? formatData(data) + (data.stack ? `\n${data.stack}` : '')
      : formatData(data);
    console.error(chalk.red(`[ERROR] ${ts()}`) + ` ${msg}` + dataStr);
    write('error', msg, data instanceof Error ? { message: data.message, stack: data.stack } : data);
  },

  success(msg, data) {
    console.log(chalk.green(`[OK]    ${ts()}`) + ` ${msg}` + formatData(data));
    write('success', msg, data);
  },

  debug(msg, data) {
    // Only printed when DEBUG env var is set
    if (process.env.DEBUG) {
      console.log(chalk.gray(`[DEBUG] ${ts()}`) + ` ${msg}` + formatData(data));
    }
    write('debug', msg, data);
  },

  // ─── Run-level summaries ──────────────────────────────────────────────────

  banner(title) {
    const line = '─'.repeat(60);
    console.log(chalk.bold.blue(`\n${line}`));
    console.log(chalk.bold.blue(`  ${title}`));
    console.log(chalk.bold.blue(`${line}\n`));
    write('banner', title);
  },

  /**
   * Print and log a structured run summary.
   * @param {object} stats
   * @param {string} stats.list         - Selected list name
   * @param {string} stats.mode         - 'dry' | 'live'
   * @param {number} stats.processed    - Total clients visited
   * @param {number} stats.messaged     - Clients a message was sent to
   * @param {number} stats.dnc          - Clients logged as DNC
   * @param {number} stats.skipped      - Clients skipped (no action needed)
   * @param {number} stats.failed       - Clients where the script errored
   */
  summary(stats) {
    const line = '─'.repeat(60);
    console.log(chalk.bold(`\n${line}`));
    console.log(chalk.bold('  RUN SUMMARY'));
    console.log(chalk.bold(`${line}`));
    console.log(`  List      : ${chalk.cyan(stats.list)}`);
    console.log(`  Mode      : ${stats.mode === 'live' ? chalk.red('LIVE') : chalk.yellow('DRY RUN')}`);
    console.log(`  Processed : ${stats.processed}`);
    console.log(`  Messaged  : ${chalk.green(stats.messaged)}`);
    console.log(`  DNC logged: ${chalk.yellow(stats.dnc)}`);
    console.log(`  Skipped   : ${stats.skipped}`);
    console.log(`  Failed    : ${stats.failed > 0 ? chalk.red(stats.failed) : stats.failed}`);
    console.log(chalk.bold(`${line}\n`));
    console.log(`  Log file  : ${logFilePath}`);
    console.log(chalk.bold(`${line}\n`));
    write('summary', 'run complete', stats);
  },
};

module.exports = logger;
