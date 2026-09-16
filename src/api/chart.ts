/**
 * Candlesticks, computed from the price series.
 *
 * WHY THIS IS A PURE MODULE, LIKE `price.ts`
 *
 * A chart is a place where a wrong number looks completely plausible. There is no
 * axis label that says "this bar is 4% too tall", and nobody re-derives a candle
 * by hand. So the arithmetic that builds them is kept where it can be called as a
 * function: no database, no clock, no DOM, no HTTP. Every claim below is a test.
 *
 * THE PRICES ARRIVE AS DECIMAL STRINGS AND THAT IS NOT A CONVENIENCE
 *
 * `price.ts` returns the price as a decimal string because it is an exact rational
 * -- a per-share value with 18 decimal places of share precision divided into a
 * 6-decimal asset. `Number("1.100000000000000002")` silently becomes
 * `1.1000000000000001`, and a chart that computes a high from rounded inputs can
 * report a high that the vault never had. Since the whole point of recording the
 * series is being able to say what the price *was*, the candles are aggregated in
 * the exact form:
 *
 *   parse the decimal string ONCE into an integer in ASSET BASE UNITS (using
 *   `assetDecimals`), aggregate integers, format back at the edge.
 *
 * Integers are exact under comparison and addition, which is all an OHLC bucket
 * does. Floats are introduced only by whoever draws the chart, which is a rendering
 * decision and belongs there.
 *
 * WHY BUCKETS AND NOT ONE CANDLE PER BLOCK
 *
 * A block is not a unit anyone thinks in. The series here is one point per block,
 * and a local chain produces blocks as fast as it is asked to -- so the same chart
 * code would draw 12 candles on a quiet testnet and 700,000 on a busy one. The
 * caller picks a bucket width in SECONDS, which is the unit a person reads a chart
 * in, and this module does the rest.
 *
 * WHY A LOCAL CHAIN MAKES THE TIME AXIS AWKWARD, STATED RATHER THAN HIDDEN
 *
 * Anvil mines on demand, so its block timestamps do not advance in step with real
 * time: a thousand blocks can share a handful of seconds. Bucketing by timestamp is
 * still the right thing (it is what a chart means), but on such a chain most points
 * land in very few buckets and the candles are tall and few. That is a property of
 * the chain, not an error here -- and `bucketsFor` reports `skipped` so a gap caused
 * by unreadable blocks is visible instead of being drawn as flat.
 */

/** The shape this module needs from a price point. Kept narrow so tests need no Store. */
export interface PricePointLike {
  blockNumber: number;
  /** Unix seconds, as recorded for the block. */
  timestamp: number;
  /** Exact per-share price as a decimal string, or null for an empty vault. */
  price: string | null;
}

/** One candlestick. All four values are integers in ASSET BASE UNITS. */
export interface Candle {
  /** Unix seconds of the first point in the bucket. */
  startsAt: number;
  endsAt: number;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  /** How many price points fell in this bucket. 1 means the candle is a single block. */
  points: number;
  firstBlock: number;
  lastBlock: number;
}

/** What a caller has to supply to interpret prices. */
export interface CandleOptions {
  /** Seconds per bucket. Must be a positive integer. */
  bucketSeconds: number;
  /** Decimal places of the vault's ASSET -- the unit prices are expressed in. */
  assetDecimals: number;
}

/**
 * A decimal string to an integer in base units, exactly.
 *
 * Rejects anything it cannot represent rather than rounding it: a price string this
 * cannot parse means the series is not what it claims to be, and dropping the point
 * would leave a chart with a silent hole in it.
 *
 * Extra fraction digits beyond `decimals` are an ERROR, not truncated. `price.ts`
 * floors its division to `assetDecimals`, so a longer string means the two modules
 * disagree about the price's precision -- which is exactly the kind of mismatch that
 * should stop a chart rather than move a candle's low by one unit.
 */
export function parsePrice(price: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`assetDecimals must be a non-negative integer, got ${decimals}`);
  }
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(price.trim());
  if (!m) throw new Error(`not a decimal price: ${JSON.stringify(price)}`);

  // `noUncheckedIndexedAccess` is on in this project, and it is right to complain:
  // a regex match's groups are typed as possibly absent. Group 1 and 2 are not
  // optional in the pattern, so the `?? ''` branches cannot run -- but writing them
  // is cheaper than a non-null assertion, and it leaves the code correct if the
  // pattern is ever edited by someone who does not notice the reliance.
  const sign = m[1] ?? '';
  const whole = m[2] ?? '';
  const fraction = m[3] ?? '';
  if (fraction.length > decimals) {
    throw new Error(
      `price ${price} has ${fraction.length} fraction digits but the asset has ${decimals}; ` +
        'refusing to round a price that is supposed to be exact',
    );
  }
  const padded = fraction.padEnd(decimals, '0');
  const magnitude = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded === '' ? '0' : padded);
  return sign === '-' ? -magnitude : magnitude;
}

/**
 * Turn the price series into candles, oldest first.
 *
 * Buckets are aligned to the epoch (`floor(t / bucketSeconds)`), so a candle's
 * boundary does not depend on where the series happens to start: two calls over
 * overlapping ranges agree on the buckets they share. Aligning to the first point
 * instead would make the same block belong to different candles depending on the
 * query, which is the sort of thing that makes two charts of one vault disagree.
 *
 * Points with a null price (an empty vault has no price -- see `price.ts`) are
 * SKIPPED AND COUNTED. They are not zero, and a chart that plotted them at zero
 * would show a crash that never happened.
 */
export function bucketsFor(
  points: readonly PricePointLike[],
  { bucketSeconds, assetDecimals }: CandleOptions,
): { candles: Candle[]; skipped: number } {
  if (!Number.isInteger(bucketSeconds) || bucketSeconds <= 0) {
    throw new Error(`bucketSeconds must be a positive integer, got ${bucketSeconds}`);
  }

  const ordered = [...points].sort((a, b) => a.timestamp - b.timestamp || a.blockNumber - b.blockNumber);

  const candles: Candle[] = [];
  let skipped = 0;
  let current: Candle | null = null;
  let currentKey = Number.NaN;

  for (const p of ordered) {
    if (p.price === null) {
      skipped++;
      continue;
    }
    const value = parsePrice(p.price, assetDecimals);
    const key = Math.floor(p.timestamp / bucketSeconds);

    if (current === null || key !== currentKey) {
      current = {
        startsAt: key * bucketSeconds,
        endsAt: key * bucketSeconds + bucketSeconds,
        open: value,
        high: value,
        low: value,
        close: value,
        points: 1,
        firstBlock: p.blockNumber,
        lastBlock: p.blockNumber,
      };
      currentKey = key;
      candles.push(current);
      continue;
    }

    if (value > current.high) current.high = value;
    if (value < current.low) current.low = value;
    current.close = value;
    current.points++;
    if (p.blockNumber < current.firstBlock) current.firstBlock = p.blockNumber;
    if (p.blockNumber > current.lastBlock) current.lastBlock = p.blockNumber;
  }

  return { candles, skipped };
}

/**
 * A candle summary for display, with every number a decimal string in ASSET units.
 *
 * Formatting here rather than at each call site keeps one place that knows asset
 * decimals, which is the same reason `price.ts` owns `formatUnits`. It also means
 * the API can hand out candle-shaped JSON whose numbers are strings -- the shape a
 * JSON consumer can use without a bigint library.
 */
export interface FormattedCandle {
  startsAt: number;
  endsAt: number;
  open: string;
  high: string;
  low: string;
  close: string;
  points: number;
  firstBlock: number;
  lastBlock: number;
}

/** Group the integer part, leave the fraction alone: `1234.5` -> `1,234.5`. */
export function groupThousands(decimal: string): string {
  const negative = decimal.startsWith('-');
  const body = negative ? decimal.slice(1) : decimal;
  const [whole = '', fraction] = body.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fraction === undefined ? '' : `.${fraction}`}`;
}

/**
 * Base units to a decimal string, trailing zeros trimmed -- the same convention as
 * `price.ts` and the dApp's `formatUnits`, so one number is printed one way
 * everywhere. Duplicated deliberately: this module has no imports, which is what
 * lets a test exercise it with nothing but Node.
 */
export function formatBaseUnits(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / scale;
  const fraction = (magnitude % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  const body = fraction === '' ? whole.toString() : `${whole}.${fraction}`;
  return negative ? `-${body}` : body;
}

export function formatCandles(candles: readonly Candle[], assetDecimals: number): FormattedCandle[] {
  const f = (v: bigint) => groupThousands(formatBaseUnits(v, assetDecimals));
  return candles.map((c) => ({
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    open: f(c.open),
    high: f(c.high),
    low: f(c.low),
    close: f(c.close),
    points: c.points,
    firstBlock: c.firstBlock,
    lastBlock: c.lastBlock,
  }));
}
