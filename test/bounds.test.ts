/**
 * The run bounds, tested as arithmetic rather than reviewed as prose.
 *
 * WHY THIS FILE EXISTS
 *
 * A cron-driven indexer has two parameters that decide whether it keeps up: how many
 * blocks a run may cover, and how long a run may take. Each can look generous while the
 * pair makes progress impossible, and nothing about a run in isolation reveals it -- a
 * run that scanned nine blocks looks identical whether nine was the plan or nine was a
 * mis-converted twenty seconds.
 *
 * It happened three times in this project, and the third time is why the block bound is no
 * longer 300:
 *
 *   1. A 30-minute cron with a 300-block bound. A 30-minute gap is more than 300 blocks,
 *      so a catch-up could never close it. (Recorded in the vault repository's
 *      ARCHITECTURE.md section 7.2.)
 *   2. A 5-minute cron with `MAX_CATCHUP_SECONDS=20`, where the time bound was converted
 *      to blocks using the CHAIN's block time. On Base that is 2.000 s, so the budget
 *      became 9 blocks against 150 produced per cron interval. Measured.
 *   3. A 5-minute cron with a 300-block bound, where 5 minutes is not what the scheduler
 *      delivers. Measured over scheduled runs #93..#107: 15.4 to 27.5 minutes apart.
 *      A real interval produces 460-825 blocks at Base's 2.000 s, so 300 was below one
 *      interval and every run was a guaranteed net loss -- observed as a gap that grew
 *      from 25,700 to 26,612 blocks while two successful runs advanced 600.
 *
 * The second one is the reason these tests assert the CONVERSION and not just the
 * comparison: the comparison was right and the unit was wrong. The third is the reason they
 * assert against the MEASURED interval and not the nominal cron: the comparison was right
 * and the denominator was wrong.
 *
 * Run: node --experimental-strip-types test/bounds.test.ts
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  blocksForBudget,
  chooseLimit,
  scanRateFromHistory,
  DEFAULT_SCAN_BLOCKS_PER_SECOND,
} from '../src/indexer/bounds.ts';

/** Base's measured block time and the interval this cron actually runs at. */
const BASE_BLOCK_SECONDS = 2.0;
/**
 * The NOMINAL cron interval the workflow asks for.
 *
 * It is here to be distinguished from the next constant, not to be used: sizing the block
 * bound against 5 minutes is the mistake this file records twice.
 */
const CRON_SECONDS = 300;
const BLOCKS_PER_CRON = CRON_SECONDS / BASE_BLOCK_SECONDS; // 150
/**
 * The interval the scheduler ACTUALLY delivers, measured over scheduled runs #93..#107:
 * 15.4 to 27.5 minutes apart, median 19.1 -- which is 573 blocks at Base's 2.000 s. This is
 * the number the block bound has to outrun, and it is what makes the old 300-block bound a
 * guaranteed net loss.
 */
const MEASURED_INTERVAL_MINUTES = 19.1; // the median of those thirteen gaps
const MEASURED_INTERVAL_SECONDS = MEASURED_INTERVAL_MINUTES * 60;
const BLOCKS_PER_MEASURED_INTERVAL = MEASURED_INTERVAL_SECONDS / BASE_BLOCK_SECONDS; // 573
/**
 * The measured worst case for the scan rate: 111 blocks in 23,069 ms against a public
 * endpoint, from the development machine. The two runner measurements are in
 * `src/indexer/bounds.ts`; this is the slowest one on record, which is what the default
 * must not exceed because the default is the floor.
 */
const MEASURED_BLOCKS_PER_SECOND = 111 / 23.069; // 4.81
/** The workflow's values. */
const WORKFLOW_MAX_BLOCKS = 3000;
const WORKFLOW_MAX_SECONDS = 450;

test('the time budget is converted at the scan rate, not at the chain block time', () => {
  // The regression, stated as the number it produced: nine blocks for a twenty-second
  // budget, because 20 s / 2.000 s-per-block = 10. The budget is wall clock, so the
  // conversion is 20 s *the indexer's* scan rate.
  const wallClock = blocksForBudget(20_000, MEASURED_BLOCKS_PER_SECOND);
  const chainTime = Math.floor(20_000 / (BASE_BLOCK_SECONDS * 1000));
  assert.equal(chainTime, 10, 'the wrong conversion: seconds of chain history');
  assert.ok(wallClock > chainTime, `a wall-clock budget must allow more than ${chainTime} blocks`);
  assert.equal(wallClock, Math.floor(20 * MEASURED_BLOCKS_PER_SECOND), 'and it must allow what the measured rate allows');
});

test('the default rate is the measured one, not an optimistic guess', () => {
  // The first version of this constant was 20 blocks/s, which no measurement supported.
  // Under-stating the rate only makes a run stop early; over-stating it makes the bound
  // decorative. So the default must be at or below the WORST measurement -- 4.8 blocks/s
  // for a 111-block range -- which is why it is 4 and not 5.
  assert.ok(
    DEFAULT_SCAN_BLOCKS_PER_SECOND <= MEASURED_BLOCKS_PER_SECOND,
    `the default (${DEFAULT_SCAN_BLOCKS_PER_SECOND}) must not exceed the measured rate (${MEASURED_BLOCKS_PER_SECOND.toFixed(1)})`,
  );
  assert.equal(DEFAULT_SCAN_BLOCKS_PER_SECOND, 4);
});

test("the workflow's two bounds are jointly sufficient for one scheduler interval", () => {
  // THE RATE THE RUNNER MEASURED: 300 blocks in 14,654 ms (run #108). This is the rate the
  // conversion uses from the second run onward, because `scanRateFromHistory` reads the last
  // run's own measurement out of the log. It is what has to be jointly sufficient here.
  const RUNNER_BLOCKS_PER_SECOND = 300 / 14.654;
  const { byBlocks, timeBlocks, limit } = chooseLimit({
    maxBlocks: WORKFLOW_MAX_BLOCKS,
    blocksNeeded: 10_000, // a long-stopped indexer: only the parameters may bind
    remainingMs: WORKFLOW_MAX_SECONDS * 1000,
    scanBlocksPerSecond: RUNNER_BLOCKS_PER_SECOND,
  });

  assert.ok(
    timeBlocks >= WORKFLOW_MAX_BLOCKS,
    `the time bound (${timeBlocks} blocks) must not be tighter than the block bound (${WORKFLOW_MAX_BLOCKS}) at the ` +
      'rate a run actually measures; when it is, a healthy endpoint still falls behind on a schedule -- which is ' +
      'what happened at 20 seconds',
  );
  assert.equal(limit, WORKFLOW_MAX_BLOCKS, 'so the block bound is what binds');
  assert.equal(byBlocks, WORKFLOW_MAX_BLOCKS);
  assert.ok(
    limit >= BLOCKS_PER_MEASURED_INTERVAL,
    `a run must cover the ${BLOCKS_PER_MEASURED_INTERVAL} blocks the scheduler's real interval produces, ` +
      'or the snapshot falls further behind every run',
  );
});

/**
 * @dev THIS TEST IS THE REASON THE BLOCK BOUND IS NOT 300 ANY MORE.
 *
 * The old pair was internally coherent and still lost ground: it covered the nominal
 * 5-minute interval (150 blocks) with a 2x margin, and the scheduler does not run every
 * 5 minutes. Measured, scheduled runs came 15.4 to 27.5 minutes apart, so the bound was
 * BELOW one interval and every run was a guaranteed net loss. "Jointly sufficient" has to
 * be asserted against the interval that is measured, not the one that was asked for.
 */
test('the old 300-block bound cannot outrun the interval the scheduler actually delivers', () => {
  const old = chooseLimit({
    maxBlocks: 300,
    blocksNeeded: 10_000,
    remainingMs: 300_000,
    scanBlocksPerSecond: MEASURED_BLOCKS_PER_SECOND,
  });
  assert.equal(old.limit, 300, 'the old bound was the one that decided');
  assert.ok(
    old.limit < BLOCKS_PER_MEASURED_INTERVAL,
    `300 blocks must be less than the ${BLOCKS_PER_MEASURED_INTERVAL} one real interval produces -- ` +
      'that inequality is the backlog that was measured growing',
  );
  // And the new pair fixes exactly that, on the median and on the shortest gap observed.
  assert.ok(WORKFLOW_MAX_BLOCKS > BLOCKS_PER_MEASURED_INTERVAL);
  assert.ok(WORKFLOW_MAX_BLOCKS > (15.4 * 60) / BASE_BLOCK_SECONDS, 'and even on the shortest gap observed (15.4 min = 462 blocks)');
});

test('the twenty-second budget that failed would fail this test', () => {
  // Guards the guard: if the conversion regressed to chain time, or the budget went back
  // to 20 s, the pair above would silently become impossible again.
  const { timeBlocks, limit } = chooseLimit({
    maxBlocks: WORKFLOW_MAX_BLOCKS,
    blocksNeeded: 10_000,
    remainingMs: 20_000,
    scanBlocksPerSecond: MEASURED_BLOCKS_PER_SECOND,
  });
  assert.ok(timeBlocks < BLOCKS_PER_CRON, '20 s at the measured rate cannot cover even the nominal cron interval');
  assert.equal(limit, timeBlocks, 'and it would be the time bound that decides progress');
});

test('a slow endpoint makes the time bound bind, which is what it is for', () => {
  // At 2 blocks/s -- roughly a badly rate-limited public endpoint -- a 450-second budget
  // allows 900 blocks, so the time bound takes over and the run stops early with its
  // progress recorded. That is the intended shape on a poor endpoint.
  const slow = chooseLimit({ maxBlocks: WORKFLOW_MAX_BLOCKS, blocksNeeded: 10_000, remainingMs: WORKFLOW_MAX_SECONDS * 1000, scanBlocksPerSecond: 2 });
  assert.equal(slow.timeBlocks, 900);
  assert.equal(slow.limit, 900, 'a slow endpoint is stopped by the budget, not by the block bound');
  assert.ok(slow.limit < slow.byBlocks, 'and the time bound is the one that decided');

  // On a healthy endpoint the block bound is in charge, which is the property the pair
  // exists to have: the budget is a safety net, not the thing that decides normal progress.
  const healthy = chooseLimit({ maxBlocks: WORKFLOW_MAX_BLOCKS, blocksNeeded: 10_000, remainingMs: WORKFLOW_MAX_SECONDS * 1000, scanBlocksPerSecond: (300 / 14.654) });
  assert.equal(healthy.limit, WORKFLOW_MAX_BLOCKS);
  // And at the rate the runner measured (300 blocks in 14.654 s, run #108) there is enough
  // budget for more than twice the block bound, so the block bound decides by a wide margin.
  assert.ok(
    (WORKFLOW_MAX_SECONDS * 300) / 14.654 > WORKFLOW_MAX_BLOCKS * 2,
    'at the measured runner rate the time budget must be slack, not tight',
  );
});

test('the budget fits inside the job timeout, and the floor rate makes it the bound on a cold run', () => {
  // The third constraint, and the one that kills a run rather than truncating it: the
  // workflow's job has `timeout-minutes: 10`. A budget that cannot be spent inside that
  // window is a run killed mid-scan with nothing committed.
  const JOB_TIMEOUT_SECONDS = 600;
  const SETUP_SECONDS = 45; // measured: checkout + test suite + deployment record
  assert.ok(
    WORKFLOW_MAX_SECONDS + SETUP_SECONDS < JOB_TIMEOUT_SECONDS,
    `the budget (${WORKFLOW_MAX_SECONDS} s) plus setup (${SETUP_SECONDS} s) must leave room inside the ${JOB_TIMEOUT_SECONDS} s job timeout`,
  );
  // The block bound and the budget are only compatible if the budget is at least as long as
  // the block bound takes at the conservative default rate -- and on a first, cold run it is
  // NOT, which is deliberate and is the intended shape: the budget stops a cold run at the
  // floor rate (1800 blocks) and the block bound takes over from the second run, when the
  // rate is the previous run's measured one. What must never be true is the opposite: a
  // budget so small that a HEALTHY run is stopped by it, which is mistake (2) above.
  const floorRateBlocks = blocksForBudget(WORKFLOW_MAX_SECONDS * 1000, DEFAULT_SCAN_BLOCKS_PER_SECOND);
  assert.equal(floorRateBlocks, 1800, 'the floor rate converts the budget into 1800 blocks');
  assert.ok(floorRateBlocks < WORKFLOW_MAX_BLOCKS, 'so a cold run is stopped by the budget and a warm run by the block bound');
  assert.ok(floorRateBlocks > BLOCKS_PER_MEASURED_INTERVAL, 'and even the cold-run limit outruns one real scheduler interval');
});

test('the budget already spent is subtracted, and never goes negative', () => {
  assert.equal(blocksForBudget(0, 20), 1, 'never zero: a run must be able to do something');
  assert.equal(blocksForBudget(-5_000, 20), 1, 'a negative budget is not an error, it is nothing left');
  assert.equal(blocksForBudget(1_000, 20), 20);
});

test('a nonsense rate falls back to the conservative default rather than to zero', () => {
  assert.equal(blocksForBudget(10_000, 0), blocksForBudget(10_000, DEFAULT_SCAN_BLOCKS_PER_SECOND));
  assert.equal(blocksForBudget(10_000, -3), blocksForBudget(10_000, DEFAULT_SCAN_BLOCKS_PER_SECOND));
});

/**
 * @dev The rate is measured from what runs recorded, so a missing or empty history must
 * degrade to the default. A first run has nothing to learn from and is still bounded.
 */
test('the scan rate comes from the last run that recorded one', () => {
  assert.equal(scanRateFromHistory('scanned=200 elapsedMs=5000 toBlock=900'), 40);
  assert.equal(scanRateFromHistory('scanned=0 elapsedMs=900 upToDate=true'), DEFAULT_SCAN_BLOCKS_PER_SECOND);
  assert.equal(scanRateFromHistory(undefined), DEFAULT_SCAN_BLOCKS_PER_SECOND);
  assert.equal(scanRateFromHistory('scanned=abc elapsedMs=x'), DEFAULT_SCAN_BLOCKS_PER_SECOND);
  assert.equal(scanRateFromHistory(''), DEFAULT_SCAN_BLOCKS_PER_SECOND);
});
