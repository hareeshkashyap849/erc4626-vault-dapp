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
 * It happened twice in this project, in both directions:
 *
 *   1. A 30-minute cron with a 300-block bound. A 30-minute gap is more than 300 blocks,
 *      so a catch-up could never close it. (Recorded in the vault repository's
 *      ARCHITECTURE.md section 7.2.)
 *   2. A 5-minute cron with `MAX_CATCHUP_SECONDS=20`, where the time bound was converted
 *      to blocks using the CHAIN's block time. On Base that is 2.000 s, so the budget
 *      became 9 blocks against 150 produced per cron interval. Measured.
 *
 * The second one is the reason these tests assert the CONVERSION and not just the
 * comparison: the comparison was right and the unit was wrong.
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

/** Base's measured block time and the cron interval the workflow actually runs. */
const BASE_BLOCK_SECONDS = 2.0;
const CRON_SECONDS = 300;
const BLOCKS_PER_CRON = CRON_SECONDS / BASE_BLOCK_SECONDS; // 150
/** The measured worst case: 111 blocks in 23,069 ms against a public endpoint. */
const MEASURED_BLOCKS_PER_SECOND = 111 / 23.069;
const WORKFLOW_MAX_BLOCKS = 300; // the workflow's value: a 2x margin over 150
const WORKFLOW_MAX_SECONDS = 300; // the workflow's value: one cron interval

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

test("the workflow's two bounds are jointly sufficient for one cron interval", () => {
  const { byBlocks, timeBlocks, limit } = chooseLimit({
    maxBlocks: WORKFLOW_MAX_BLOCKS,
    blocksNeeded: 10_000, // a long-stopped indexer: only the parameters may bind
    remainingMs: WORKFLOW_MAX_SECONDS * 1000,
    scanBlocksPerSecond: MEASURED_BLOCKS_PER_SECOND,
  });

  assert.ok(
    timeBlocks >= WORKFLOW_MAX_BLOCKS,
    `the time bound (${timeBlocks} blocks) must not be tighter than the block bound (${WORKFLOW_MAX_BLOCKS}); ` +
      'when it is, a healthy endpoint still falls behind on a schedule -- which is what happened at 20 seconds',
  );
  assert.equal(limit, WORKFLOW_MAX_BLOCKS, 'so the block bound is what binds');
  assert.equal(byBlocks, WORKFLOW_MAX_BLOCKS);
  assert.ok(
    limit >= BLOCKS_PER_CRON,
    `a run must cover the ${BLOCKS_PER_CRON} blocks one cron interval produces, or the snapshot falls further behind every run`,
  );
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
  assert.ok(timeBlocks < BLOCKS_PER_CRON, '20 s at the measured rate cannot cover a cron interval');
  assert.equal(limit, timeBlocks, 'and it would be the time bound that decides progress');
});

test('a slow endpoint makes the time bound bind, which is what it is for', () => {
  // At 2 blocks/s -- roughly a badly rate-limited public endpoint -- a 300-second budget
  // still allows 600 blocks, so the block bound stays in charge. That is the healthy
  // case: the time bound is a safety net, not the thing that decides normal progress.
  const slow = chooseLimit({ maxBlocks: WORKFLOW_MAX_BLOCKS, blocksNeeded: 10_000, remainingMs: 300_000, scanBlocksPerSecond: 2 });
  assert.equal(slow.timeBlocks, 600);
  assert.equal(slow.limit, WORKFLOW_MAX_BLOCKS, 'the block bound still binds, as it should on a slow-but-usable endpoint');

  // And on a genuinely slow endpoint the time bound takes over, which is the point of it.
  const verySlow = chooseLimit({ maxBlocks: WORKFLOW_MAX_BLOCKS, blocksNeeded: 10_000, remainingMs: 60_000, scanBlocksPerSecond: 2 });
  assert.equal(verySlow.timeBlocks, 120);
  assert.equal(verySlow.limit, 120, 'a short budget at a slow rate is what stops the run');
  assert.ok(verySlow.limit < verySlow.byBlocks, 'and the time bound is the one that decided');
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
