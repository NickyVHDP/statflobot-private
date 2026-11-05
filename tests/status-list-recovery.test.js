'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/statflo.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const SELECTORS = require('../src/selectors');
const sourceRequire = createRequire(path.join(root, 'src/statflo.js'));

// Run the real functions with an isolated clock and logger. No browser,
// customer data, local .env, auth, or network is involved in these fixtures.
function fixture(options = {}) {
  let now = 0;
  const logs = [];
  const actions = [];
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug', 'success']
    .map(level => [level, message => logs.push(String(message))]));
  class FixtureDate extends Date { static now() { return now; } }
  const config = {
    lists: { '1st Attempt': { navMode: 'statusFilter', statusValue: '1', dncEnabled: true } },
    accountsUrl: 'https://example.invalid/accounts', defaultTimeout: 600, maxRetries: 1,
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, Date: FixtureDate, process,
    setTimeout, clearTimeout,
    require: id => id === './config' ? config : id === './logger' ? logger : sourceRequire(id),
  }, { filename: 'statflo.js' });

  const node = (textContent = '', extra = {}) => ({
    textContent, getClientRects: () => [{}], style: {}, ...extra,
  });
  const state = { filter: true, apply: true, value: '1', rows: true, empty: false, processing: false, ...options };
  const apply = { scrollIntoViewIfNeeded: async () => {}, click: async () => actions.push('apply') };
  const nav = { isVisible: async () => true, scrollIntoViewIfNeeded: async () => {}, click: async () => actions.push('return-to-list') };
  const client = {
    getAttribute: async name => name === 'href' ? '/accounts?client=fixture' : 'Fixture client',
    elementHandle: async () => null,
    scrollIntoViewIfNeeded: async () => {}, click: async () => actions.push('open-client'),
  };
  const page = {
    url: () => config.accountsUrl,
    isClosed: () => false,
    goto: async () => actions.push('goto'),
    waitForTimeout: async ms => { now += ms; },
    waitForSelector: async selector => {
      if (selector === SELECTORS.statusDropdown && state.filter) return node('', { value: state.value });
      if (selector === SELECTORS.statusFilterApplyButton && state.apply) return apply;
      if (selector === SELECTORS.clientNameLink && state.rows) return client;
      throw new Error(`fixture missing ${selector}`);
    },
    selectOption: async () => {
      actions.push('select-status');
      if (state.selectError) throw new Error('fixture selection failed');
    },
    $: async selector => {
      if (selector === SELECTORS.smartListsNav) return nav;
      if (state.profile && selector === SELECTORS.accountDetailsButton) return { isVisible: async () => true };
      return null;
    },
    $$: async selector => selector === SELECTORS.smsButton ? (state.smsButtons || []) : [],
    locator: () => ({ count: async () => 1, nth: () => client }),
    evaluate: async (fn, ...args) => {
      assert.ok(args.length <= 1, 'standard Playwright evaluate accepts only one serialized argument');
      // Execute the actual DOM predicate against several distinct page states.
      const document = {
        querySelector: selector => {
          if (selector === SELECTORS.statusDropdown) return state.filter ? node('', { value: state.value }) : null;
          if (selector === SELECTORS.statusFilterApplyButton) return state.apply ? node() : null;
          return null;
        },
        querySelectorAll: selector => {
          if (selector === SELECTORS.clientNameLink) return state.rows ? [node()] : [];
          if (selector === '.dataTables_processing, .dt-processing') return state.processing ? [node()] : [];
          if (selector === 'table td.dataTables_empty, table td.dt-empty') return state.empty ? [node('No matching records found')] : [];
          return [];
        },
      };
      return vm.runInNewContext(`(${fn.toString()})(...args)`, {
        document, args, getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
      });
    },
  };
  return { statflo: module.exports, page, logs, actions, state, logger };
}

for (const [name, options] of [
  ['missing filter', { filter: false }],
  ['failed filter selection', { selectError: true }],
  ['missing Apply control', { apply: false }],
  ['missing results and empty state', { rows: false }],
  ['incorrect filter value', { value: '2' }],
]) {
  test(`hard recovery rejects ${name} instead of reporting success`, async () => {
    const f = fixture(options);
    await assert.rejects(f.statflo.recover1stAttemptList(f.page, '1st Attempt'));
    assert.ok(!f.logs.some(message => message.includes('list recovered successfully')));
  });
}

test('hard recovery uses the standard browser interface and applies its filter once', async () => {
  const f = fixture();
  await f.statflo.recover1stAttemptList(f.page, '1st Attempt');
  assert.equal(f.actions.filter(action => action === 'apply').length, 1);
  assert.ok(f.logs.some(message => message.endsWith('state=rows')));
});

test('a genuinely empty filtered table still completes recovery', async () => {
  const f = fixture({ rows: false, empty: true });
  await f.statflo.recover1stAttemptList(f.page, '1st Attempt');
  assert.ok(f.logs.some(message => message.endsWith('state=empty')));
});

test('an empty marker without the correct filters is not proof of exhaustion', async () => {
  const f = fixture({ rows: false, empty: true, filter: false });
  await assert.rejects(f.statflo.waitForStatusListReady(f.page, '1st Attempt'));
});

test('loading results cannot be mistaken for an empty list', async () => {
  const f = fixture({ rows: false, empty: true, processing: true });
  await assert.rejects(f.statflo.waitForStatusListReady(f.page, '1st Attempt'));
});

test('a transient empty marker must stabilize before it confirms completion', async () => {
  const f = fixture({ rows: false, empty: true });
  const wait = f.page.waitForTimeout;
  f.page.waitForTimeout = async ms => {
    f.state.empty = false;
    await wait(ms);
  };
  await assert.rejects(f.statflo.waitForStatusListReady(f.page, '1st Attempt'));
});

test('zero SMS buttons on an unloaded profile never enter DNC handling', async () => {
  const f = fixture();
  const processedClients = new Set();
  const outcome = await f.statflo.processClient(f.page, 0, {
    list: '1st Attempt', mode: 'live', delayProfile: 'safe', processedClients,
  });
  assert.equal(outcome.result, 'skipped');
  assert.equal(outcome.reason, 'SKIPPED_ACCOUNT_VIEW_UNAVAILABLE');
  assert.ok(processedClients.has('/accounts?client=fixture'));
  assert.ok(f.actions.includes('return-to-list'));
  assert.ok(!f.logs.some(message => /Logging DNC activity|DNC activity logged/.test(message)));
  assert.ok(!f.actions.includes('select-status'), 'no DNC form selection or fallback write');
});

test('a positively loaded no-SMS profile retains its existing classification', async () => {
  const f = fixture({ profile: true });
  const result = await f.statflo.inspectLines(f.page);
  assert.equal(result.hasActiveSms, false);
  assert.equal(result.profileReady, true);
});

for (const [name, disabled, hasActiveSms] of [
  ['an enabled SMS line', false, true],
  ['a disabled SMS line', true, false],
]) {
  test(`existing classification for ${name} is preserved`, async () => {
    const f = fixture({ smsButtons: [{ evaluate: async fn => fn({
      disabled, getAttribute: () => null, classList: { contains: () => false },
    }) }] });
    const result = await f.statflo.inspectLines(f.page);
    assert.equal(result.hasActiveSms, hasActiveSms);
    assert.equal(result.profileReady, true);
  });
}

// Execute the real first-attempt recovery branch. Importing main.js itself
// would start the app, so isolate only the existing loop's row-recovery block.
const loopStart = mainSource.indexOf('      let rows = await statflo.getClientRows(page)');
const loopEnd = mainSource.indexOf('      if (clientIndex >= rows.length)', loopStart);
assert.ok(loopStart >= 0 && loopEnd > loopStart);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runRecovery = new AsyncFunction('statflo', 'page', 'stats', 'logger', `
  const runConfig = { list: '1st Attempt' };
  const maxDisplay = '∞';
  const consecutiveErrors = 0;
  const clientIndex = 37;
  let browserClosed = false;
  while (true) {
    ${mainSource.slice(loopStart, loopEnd)}
    break;
  }
  return { stats, browserClosed };
`);

function previousCounts() {
  return { processed: 58, messaged: 19, dnc: 2, skipped: 36, duplicateSkipped: 0, failed: 1 };
}

test('the reported failed-recovery sequence preserves 19 sends and never claims exhaustion', async () => {
  const f = fixture();
  const stats = previousCounts();
  const statflo = {
    getClientRows: async () => [],
    navigateToSmartList: async () => { throw new Error('fixture navigation failure'); },
  };
  await runRecovery(statflo, f.page, stats, f.logger);
  assert.equal(stats._runError, 'statuslist-recovery-failed-before-exhaustion');
  assert.equal(stats.messaged, 19);
  assert.equal(stats.failed, 1, 'a navigation interruption is not another failed client');
  assert.equal(stats.processed, 58);
  assert.ok(!f.logs.some(message => message.includes('LIST_EXHAUSTED_CONFIRMED')));
});

test('unverified results after navigation interrupt instead of claiming completion', async () => {
  const f = fixture();
  const stats = previousCounts();
  await runRecovery({
    getClientRows: async () => [], navigateToSmartList: async () => {},
    waitForStatusListReady: async () => { throw new Error('fixture unknown page state'); },
  }, f.page, stats, f.logger);
  assert.ok(stats._runError);
  assert.ok(!f.logs.some(message => message.includes('LIST_EXHAUSTED_CONFIRMED')));
});

test('a verified empty list is still a normal completion', async () => {
  const f = fixture();
  const stats = previousCounts();
  await runRecovery({
    getClientRows: async () => [], navigateToSmartList: async () => {},
    waitForStatusListReady: async () => 'empty',
  }, f.page, stats, f.logger);
  assert.equal(stats._runError, undefined);
  assert.ok(f.logs.some(message => message.includes('LIST_EXHAUSTED_CONFIRMED')));
});

test('successful row recovery continues with counts unchanged', async () => {
  const f = fixture();
  const stats = previousCounts();
  let calls = 0;
  await runRecovery({
    getClientRows: async () => ++calls === 1 ? [] : [{}],
    navigateToSmartList: async () => {}, waitForStatusListReady: async () => 'rows',
  }, f.page, stats, f.logger);
  assert.deepEqual(stats, previousCounts());
  assert.ok(f.logs.some(message => message.includes('recovered 1 row(s)')));
});

test('browser closure during recovery retains the stopped-browser outcome', async () => {
  const f = fixture();
  const stats = previousCounts();
  let closed = false;
  f.page.isClosed = () => closed;
  const result = await runRecovery({
    getClientRows: async () => [],
    navigateToSmartList: async () => { closed = true; throw new Error('fixture browser closed'); },
  }, f.page, stats, f.logger);
  assert.equal(result.browserClosed, true);
  assert.equal(stats._runError, undefined);
  assert.equal(stats.messaged, 19);
});
