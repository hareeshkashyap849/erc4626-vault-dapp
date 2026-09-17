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
 * MEASURED, TWICE, AGAINST A PUBLIC ENDPOINT -- and the lower figure is used:
 *
 *   * 111 blocks in 23,069 ms -> 4.8 blocks/s (a larger range)
 *   * 29 blocks in 1,958 ms   -> 14.8 blocks/s (a smaller range; the fixed ~1.2 s
 *     startup is spread over fewer blocks, so this rate is flattered)
 *
 * The rate falls as the range grows, which is the opposite of what an optimistic
 * constant would assume, so the worst measurement is the one that is used and it is
 * rounded DOWN to 4 blocks/s: a budget is converted with 4 blocks/s, and a run therefore
 * stops earlier than it could have. Stopping early costs a cron interval; over-running a
 * budget is what the bound exists to prevent.
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
