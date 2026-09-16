/**
 * Candlestick tests.
 *
 * These exist to pin the two claims that make the chart trustworthy, both of which
 * are the kind of thing that is wrong while looking right:
 *
 *   1. Aggregation happens in exact integers, so a high cannot be reported that the
 *      vault never had. The test that matters uses a price whose 18th decimal place
 *      is not zero -- `Number()` would round it away and the assertion would pass
 *      for the wrong reason.
 *   2. Buckets are aligned to the epoch and don't depend on where the series starts.
 *      Two overlapping queries must agree about the candles they share.
 *
 * A third group pins what happens to prices that cannot exist: an empty vault reports
 * `null`, and those points must be counted and skipped rather than plotted at zero.
 * Plotting them at zero draws a crash that never happened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bucketsFor,
  formatBaseUnits,
  formatCandles,
  groupThousands,
  parsePrice,
  type Candle,
  type PricePointLike,
} from '../src/api/chart.ts';

// ── parsePrice ───────────────────────────────────────────────────────────────

test('parsePrice reads a decimal string exactly, without going through a float', () => {
  assert.equal(parsePrice('1.1', 6), 1_100_000n);
  assert.equal(parsePrice('1', 6), 1_000_000n);
  assert.equal(parsePrice('0.000001', 6), 1n);
  assert.equal(parsePrice('1234.5', 6), 1_234_500_000n);
});

test('parsePrice keeps the last decimal place that a float would drop', () => {
  // 1.100000000000000002 at 18 decimals. `Number('1.100000000000000002')` is
  // 1.1000000000000001 -- a different number. At 18 decimals both parse to the same
  // bigint only if the parser is exact; the assert below would fail if this module
  // ever went through Number().
  const exact = parsePrice('1.100000000000000002', 18);
  assert.equal(exact, 1_100_000_000_000_000_002n);
  assert.notEqual(BigInt(Math.round(Number('1.100000000000000002') * 1e18)), exact);
});

test('parsePrice rejects a price with more fraction digits than the asset has', () => {
  // Truncating would silently move a candle's low by one base unit. The two modules
  // disagreeing about precision is a reason to stop, not to round.
  assert.throws(() => parsePrice('1.1000000', 6), /fraction digits/);
});

test('parsePrice rejects things that are not prices rather than coercing them', () => {
  for (const bad of ['', 'abc', '1.2.3', '1e6', '--1', '0x10', ' ']) {
    assert.throws(() => parsePrice(bad, 6), /not a decimal price|fraction digits/, `should reject ${JSON.stringify(bad)}`);
  }
});

test('parsePrice rejects a negative decimal count instead of producing nonsense', () => {
  assert.throws(() => parsePrice('1', -1), /non-negative integer/);
});

// ── bucketsFor: the arithmetic ───────────────────────────────────────────────

const pt = (timestamp: number, price: string | null, blockNumber = timestamp): PricePointLike => ({
  timestamp,
  price,
  blockNumber,
});

/**
 * The candle at an index, asserted to exist.
 *
 * `noUncheckedIndexedAccess` is on, so `candles[0]` is `Candle | undefined` and every
 * field read needs a guard. Rather than sprinkle `!` through the assertions -- which
 * would also silence a real "the array is shorter than I think" failure -- this
 * checks the length FIRST and reports what it actually got. A test that fails with
 * "expected 2 candles, got 1" is diagnosable; one that fails with "cannot read
 * property open of undefined" is not.
 */
function candleAt(candles: readonly Candle[], i: number): Candle {
  assert.ok(
    candles.length > i,
    `expected at least ${i + 1} candle(s), got ${candles.length}: ${JSON.stringify(candles.map((c) => c.startsAt))}`,
  );
  return candles[i]!;
}

test('a single point becomes a candle whose four values are all that point', () => {
  const { candles } = bucketsFor([pt(1000, '1.1')], { bucketSeconds: 60, assetDecimals: 6 });
  assert.equal(candles.length, 1);
  const c = candleAt(candles, 0);
  assert.deepEqual([c.open, c.high, c.low, c.close], [1_100_000n, 1_100_000n, 1_100_000n, 1_100_000n]);
  assert.equal(c.points, 1);
  assert.equal(c.startsAt, 960); // floor(1000/60)*60
  assert.equal(c.endsAt, 1020);
});

test('open and close follow time, high and low follow value, not position', () => {
  // Deliberately shuffled so that "first in the array" is not "first in time" and the
  // extremes are in the middle: a bug that read open from index 0 would still pass if
  // the input happened to be sorted.
  //
  // Every timestamp is inside one 60-second bucket: [960, 1020) for bucketSeconds=60.
  // The first version of this test used t=1020, which starts the NEXT bucket, so it
  // was asserting against a candle that held only part of the series -- the test was
  // wrong, not the code. Worth keeping the note: the boundary is exclusive.
  const { candles } = bucketsFor(
    [pt(1010, '1.05'), pt(1000, '1.10'), pt(1019, '1.02'), pt(1005, '1.20'), pt(1015, '1.01')],
    { bucketSeconds: 60, assetDecimals: 6 },
  );
  assert.equal(candles.length, 1, 'all five points are inside [960, 1020)');
  const c = candleAt(candles, 0);
  assert.equal(c.open, 1_100_000n, 'open is the earliest point');
  assert.equal(c.close, 1_020_000n, 'close is the latest point');
  assert.equal(c.high, 1_200_000n, 'high is the largest value');
  assert.equal(c.low, 1_010_000n, 'low is the smallest value');
  assert.equal(c.points, 5);
});

test('high and low are exact, not rounded through a float', () => {
  // Two prices one base unit apart at 6 decimals. A float pipeline would collapse
  // them and report low === high; the exact one keeps the gap.
  const { candles } = bucketsFor([pt(1000, '1.000001'), pt(1001, '1.000002')], {
    bucketSeconds: 60,
    assetDecimals: 6,
  });
  assert.equal(candleAt(candles, 0).low, 1_000_001n);
  assert.equal(candleAt(candles, 0).high, 1_000_002n);
  assert.equal(candleAt(candles, 0).high - candleAt(candles, 0).low, 1n, 'the one-unit gap must survive');
});

test('points at the same timestamp are ordered by block, so close is deterministic', () => {
  const { candles } = bucketsFor([pt(1000, '2', 5), pt(1000, '3', 7), pt(1000, '1', 6)], {
    bucketSeconds: 60,
    assetDecimals: 6,
  });
  assert.equal(candles.length, 1);
  assert.equal(candleAt(candles, 0).open, 2_000_000n, 'block 5 is the earliest');
  assert.equal(candleAt(candles, 0).close, 3_000_000n, 'block 7 is the latest');
  assert.deepEqual([candleAt(candles, 0).firstBlock, candleAt(candles, 0).lastBlock], [5, 7]);
});

// ── bucketsFor: bucket boundaries ────────────────────────────────────────────

test('buckets are aligned to the epoch, not to the first point', () => {
  // Starting at 1000 with 60-second buckets: the bucket is [960,1020), so a point at
  // 1019 belongs with 1000 and a point at 1020 does not.
  const { candles } = bucketsFor([pt(1000, '1'), pt(1019, '2'), pt(1020, '3')], {
    bucketSeconds: 60,
    assetDecimals: 6,
  });
  assert.equal(candles.length, 2);
  assert.deepEqual([candleAt(candles, 0).startsAt, candleAt(candles, 0).points], [960, 2]);
  assert.deepEqual([candleAt(candles, 1).startsAt, candleAt(candles, 1).points], [1020, 1]);
});

test('two overlapping queries agree about the candles they share', () => {
  // This is the property epoch alignment buys, and the reason it is not "align to the
  // first point": otherwise the same block lands in different candles depending on
  // the range asked for, and two charts of one vault disagree.
  const xs = [pt(1000, '1'), pt(1060, '1.1'), pt(1120, '1.2'), pt(1180, '1.3')];
  const all = bucketsFor(xs, { bucketSeconds: 60, assetDecimals: 6 }).candles;
  const tail = bucketsFor(xs.slice(2), { bucketSeconds: 60, assetDecimals: 6 }).candles;
  assert.equal(tail.length, 2);
  for (const t of tail) {
    const match = all.find((a) => a.startsAt === t.startsAt);
    assert.ok(match, `the shared bucket ${t.startsAt} must exist in both`);
    assert.deepEqual(
      [match.open, match.high, match.low, match.close],
      [t.open, t.high, t.low, t.close],
      `bucket ${t.startsAt} must be identical in both queries`,
    );
  }
});

test('candles come out oldest first, and the array order does not matter', () => {
  const forward = bucketsFor([pt(1000, '1'), pt(2000, '2')], { bucketSeconds: 60, assetDecimals: 6 }).candles;
  const backward = bucketsFor([pt(2000, '2'), pt(1000, '1')], { bucketSeconds: 60, assetDecimals: 6 }).candles;
  assert.deepEqual(forward.map((c) => c.startsAt), backward.map((c) => c.startsAt));
  assert.deepEqual(forward.map((c) => c.startsAt), [...forward.map((c) => c.startsAt)].sort((a, b) => a - b));
});

test('a gap in time produces two candles, not one wide one', () => {
  // The gap is real information and must not be smoothed away by merging buckets.
  const { candles } = bucketsFor([pt(1000, '1'), pt(100_000, '2')], { bucketSeconds: 60, assetDecimals: 6 });
  assert.equal(candles.length, 2);
  assert.notEqual(candleAt(candles, 0).startsAt, candleAt(candles, 1).startsAt);
});

test('bucketSeconds must be a positive integer', () => {
  assert.throws(() => bucketsFor([], { bucketSeconds: 0, assetDecimals: 6 }), /positive integer/);
  assert.throws(() => bucketsFor([], { bucketSeconds: -60, assetDecimals: 6 }), /positive integer/);
  assert.throws(() => bucketsFor([], { bucketSeconds: 1.5, assetDecimals: 6 }), /positive integer/);
});

// ── bucketsFor: the empty vault ──────────────────────────────────────────────

test('points with no price are counted and skipped, never plotted at zero', () => {
  // An empty vault has no price (see price.ts). Plotting null as 0 would draw a
  // collapse to zero followed by a recovery, which is a story the vault did not tell.
  const { candles, skipped } = bucketsFor(
    [pt(1000, null), pt(1060, '1.1'), pt(1120, null), pt(1180, '1.2')],
    { bucketSeconds: 60, assetDecimals: 6 },
  );
  assert.equal(skipped, 2);
  assert.equal(candles.length, 2);
  for (const c of candles) assert.notEqual(c.open, 0n);
  assert.deepEqual(candles.map((c) => c.close), [1_100_000n, 1_200_000n]);
});

test('an all-null series yields no candles, and says how many it skipped', () => {
  const { candles, skipped } = bucketsFor([pt(1000, null), pt(1060, null)], { bucketSeconds: 60, assetDecimals: 6 });
  assert.deepEqual(candles, []);
  assert.equal(skipped, 2);
});

test('an empty input is not an error, it is an empty chart', () => {
  const { candles, skipped } = bucketsFor([], { bucketSeconds: 60, assetDecimals: 6 });
  assert.deepEqual(candles, []);
  assert.equal(skipped, 0);
});

test('a price that cannot be parsed stops the chart instead of leaving a hole', () => {
  assert.throws(
    () => bucketsFor([pt(1000, '1.1'), pt(1060, 'not-a-price')], { bucketSeconds: 60, assetDecimals: 6 }),
    /not a decimal price/,
  );
});

// ── formatting ───────────────────────────────────────────────────────────────

test('formatBaseUnits trims trailing zeros, matching price.ts and the dApp', () => {
  assert.equal(formatBaseUnits(1_100_000n, 6), '1.1');
  assert.equal(formatBaseUnits(1_000_000n, 6), '1');
  assert.equal(formatBaseUnits(1n, 6), '0.000001');
  assert.equal(formatBaseUnits(0n, 6), '0');
});

test('groupThousands groups the integer part and leaves the fraction alone', () => {
  assert.equal(groupThousands('1234.5'), '1,234.5');
  assert.equal(groupThousands('1234567'), '1,234,567');
  assert.equal(groupThousands('999'), '999');
  assert.equal(groupThousands('1000.000001'), '1,000.000001');
  assert.equal(groupThousands('-1234.5'), '-1,234.5');
});

test('formatCandles renders every value as a decimal string in asset units', () => {
  const { candles } = bucketsFor([pt(1000, '1234.5'), pt(1010, '1235.25')], { bucketSeconds: 60, assetDecimals: 6 });
  const [c] = formatCandles(candles, 6);
  assert.ok(c, "formatCandles must return one candle for one input candle");
  assert.equal(c.open, '1,234.5');
  assert.equal(c.high, '1,235.25');
  assert.equal(c.low, '1,234.5');
  assert.equal(c.close, '1,235.25');
  assert.equal(c.points, 2);
  // Strings, not numbers: a JSON consumer needs no bigint library, and a value that
  // does not fit a double cannot be silently rounded on the way out.
  for (const k of ['open', 'high', 'low', 'close'] as const) assert.equal(typeof c[k], 'string');
});

// ── the end-to-end shape the API serves ──────────────────────────────────────

test('a realistic series produces candles whose closes follow the underlying series', () => {
  // 10 blocks, one per second, price rising then falling, bucket = 5 seconds.
  const prices = ['1.10', '1.12', '1.15', '1.13', '1.11', '1.09', '1.07', '1.10', '1.14', '1.18'];
  const points = prices.map((p, i) => pt(1000 + i, p, 100 + i));
  const { candles } = bucketsFor(points, { bucketSeconds: 5, assetDecimals: 6 });

  assert.equal(candles.length, 2);
  // Bucket 0 covers t=1000..1004 -> prices 1.10 1.12 1.15 1.13 1.11.
  // open=1.10 (first), high=1.15 (max), low=1.10 (min -- the opening value itself,
  // which is the case a hand-written expectation gets wrong), close=1.11 (last).
  assert.deepEqual(
    [candleAt(candles, 0).open, candleAt(candles, 0).high, candleAt(candles, 0).low, candleAt(candles, 0).close],
    [1_100_000n, 1_150_000n, 1_100_000n, 1_110_000n],
  );
  assert.equal(candleAt(candles, 0).points, 5);
  // Bucket 1 covers t=1005..1009 -> prices 1.09 1.07 1.10 1.14 1.18
  assert.deepEqual(
    [candleAt(candles, 1).open, candleAt(candles, 1).high, candleAt(candles, 1).low, candleAt(candles, 1).close],
    [1_090_000n, 1_180_000n, 1_070_000n, 1_180_000n],
  );
  assert.equal(candleAt(candles, 1).points, 5);

  // The closes must equal the last point of each bucket -- the check a reader would do.
  assert.ok(prices[4] !== undefined && prices[9] !== undefined, 'the fixture has ten prices');
  assert.equal(candleAt(candles, 0).close, parsePrice(prices[4], 6));
  assert.equal(candleAt(candles, 1).close, parsePrice(prices[9], 6));
});

test('total points across candles plus skipped equals the input length', () => {
  // No point may vanish: a chart that quietly drops points is a chart nobody can
  // reconcile against the series it came from.
  const points: PricePointLike[] = [];
  for (let i = 0; i < 250; i++) points.push(pt(1000 + i, i % 17 === 0 ? null : `1.${String(i % 100).padStart(2, '0')}`, i));
  const { candles, skipped } = bucketsFor(points, { bucketSeconds: 30, assetDecimals: 6 });
  const counted = candles.reduce((n, c) => n + c.points, 0);
  assert.equal(counted + skipped, points.length);
});
