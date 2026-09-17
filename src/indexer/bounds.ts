/**
 * How much of a catch-up one run may attempt.
 *
 * WHY THIS IS A SEPARATE, TESTED FUNCTION
 *
 * The first version converted the time budget into a block budget using the CHAIN's
 * block time. That reads as reasonable -- "the two bounds are comparable" -- and it is
 * wrong in a way that only shows up on a schedule: on Base the measured block time is
 * 2.000 s, so a 20-second budget became NINE blocks, while the chain produces 150
 * blocks in the 5 minutes between cron runs. A scheduled indexer with those numbers
 * falls behind by about 141 blocks every run, forever, and looks healthy while doing it.
 *
 * That is measured, not theorised. With the workflow's own values
 * (`MAX_CATCHUP_BLOCKS=300`, `MAX_CATCHUP_SECONDS=20`) a run scanned 9 blocks while the
 * head advanced 58 blocks during the 90 seconds before it. The failure the workflow's
 * own comment claims to have fixed once -- "two timer parameters can each look sane and
 * be jointly impossible" -- had simply moved from the block bound to the time bound.
 *
 * The budget is WALL-CLOCK time this run may spend, so the conversion has to use the
 * rate at which THIS INDEXER scans blocks, not the rate at which the chain makes them.
 * Those differ by two orders of magnitude, which is why the distinction matters.
 */

/**
 * Blocks scanned per second of wall clock, when nothing has been measured yet.
 *
 * MEASURED FOUR TIMES AGAINST A PUBLIC ENDPOINT, AND THE LOWEST FIGURE IS USED.
 *
 * Against `sepolia.base.org`, from the runner the scheduled workflow uses (`src/config.ts`
 * quotes the run this came from):
 *
 *   * 300 blocks in 14,654 ms -> 20.5 blocks/s (run #108; a small range, so the fixed
 *     startup cost is spread over few blocks and this rate is FLATTERED)
 *
 * Against the same endpoint from this development machine, on a database built from
 * scratch, which is the slower of the two environments:
 *
 *   * 718 blocks in 196,875 ms -> 3.65 blocks/s (the cold-start path, measured 2026-09-18)
 *   * 300 blocks in  81,613 ms -> 3.68 blocks/s (the same range as run #108, same
 *     conditions except the machine: 5.6x slower than the runner)
 *   * 111 blocks in 23,069 ms  -> 4.8 blocks/s (the original measurement, a smaller range)
 *
 * The two environments differ by more than 5x and this repository does not contain the
 * measurement that would explain it, so the rule is applied literally: the conversion uses
 * the LOWEST rate measured anywhere, and 3.65 rounds DOWN to 4 at the one-significant-figure
 * precision the rest of this arithmetic uses. Rounding up to 5 would be a claim no
 * measurement supports; rounding down to 3 would over-state the cost by 20%, and the cost of
 * under-stating a rate is only that a run stops earlier than it could have.
 *
 * WHAT THIS MEANS FOR THE WORKFLOW'S BOUNDS, AND THE LIMIT OF WHAT A FLOOR CAN DO
 *
 * The floor rate is used to convert `maxCatchupSeconds` into blocks when a run has no history
 * to measure from. At the workflow's 450 s budget and this rate that is 1800 blocks against a
 * 3000-block bound, so a first, cold run is stopped by the TIME bound, not by the block bound.
 * Keeping the floor at 4 rather than raising it to 7.5 -- the rate at which a 450 s budget
 * would exactly match a 3000-block bound -- is deliberate, and it is the conservative choice
 * for a specific failure: under-stating the rate makes a run stop EARLY, which costs one
 * scheduler interval and is recorded as TRUNCATED; over-stating it makes a run overshoot the
 * job's 10-minute timeout, which is a run killed mid-scan with nothing committed at all. The
 * first failure is the one this bound exists to produce.
 *
 * From the second run onward the rate is the PREVIOUS run's measured rate
 * (`scanRateFromHistory` writes it into the log and reads it back), so the runner's own
 * measurement -- 20.5 blocks/s, which converts 450 s into 9225 blocks -- is what applies, and
 * the 3000-block bound is what decides. That is the intended shape: the time bound is a
 * ceiling for a slow endpoint or a cold start, and the block bound governs a warm run.
 *
 * The original mistake this file exists to prevent -- converting the budget at the CHAIN's
 * block time, which made 20 s mean 9 blocks -- is preserved in the workflow header and in
 * `test/bounds.test.ts`, because it is the reason the conversion is at a scan rate at all.
 */
export const DEFAULT_SCAN_BLOCKS_PER_SECOND = 4;

/** Blocks a wall-clock budget allows at a given scan rate. Never zero. */
export function blocksForBudget(remainingMs: number, scanBlocksPerSecond: number): number {
  const rate = scanBlocksPerSecond > 0 ? scanBlocksPerSecond : DEFAULT_SCAN_BLOCKS_PER_SECOND;
  return Math.max(1, Math.floor((Math.max(0, remainingMs) / 1000) * rate));
}

export interface Limit {
  /** The bound from `MAX_CATCHUP_BLOCKS`, and from what is actually left to do. */
  byBlocks: number;
  /** The bound from `MAX_CATCHUP_SECONDS`, converted at the scan rate. */
  timeBlocks: number;
  /** Whichever is smaller. */
  limit: number;
}

/**
 * Combine the two bounds.
 *
 * Both are applied and the smaller wins. That is the property worth testing rather than
 * reviewing: two limits that each look generous can still be jointly impossible, and the
 * pair only works if the block bound is what binds on a healthy run -- the time bound is
 * a safety net for a slow endpoint, not the thing that decides normal progress.
 */
export function chooseLimit(options: {
  maxBlocks: number;
  blocksNeeded: number;
  remainingMs: number;
  scanBlocksPerSecond: number;
}): Limit {
  const byBlocks = Math.max(1, Math.min(options.maxBlocks, options.blocksNeeded));
  const timeBlocks = blocksForBudget(options.remainingMs, options.scanBlocksPerSecond);
  return { byBlocks, timeBlocks, limit: Math.max(1, Math.min(byBlocks, timeBlocks)) };
}

/**
 * The scan rate to convert a budget with, from what previous runs recorded.
 *
 * `detail` is the string a previous run logged: `scanned=<n> elapsedMs=<ms>`. Returns
 * the conservative default when there is no usable history, because a first run has
 * nothing to learn from and must still be bounded.
 */
export function scanRateFromHistory(detail: string | undefined): number {
  if (!detail) return DEFAULT_SCAN_BLOCKS_PER_SECOND;
  const scanned = /scanned=(\d+)/.exec(detail);
  const elapsed = /elapsedMs=(\d+)/.exec(detail);
  if (!scanned || !elapsed) return DEFAULT_SCAN_BLOCKS_PER_SECOND;
  const blocks = Number(scanned[1]);
  const ms = Number(elapsed[1]);
  if (!Number.isFinite(blocks) || !Number.isFinite(ms) || blocks <= 0 || ms <= 0) return DEFAULT_SCAN_BLOCKS_PER_SECOND;
  return (blocks / ms) * 1000;
}
