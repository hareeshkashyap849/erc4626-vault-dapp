/**
 * Independent reconciliation of /api/candles against the database.
 *
 * WHY THIS IS A SEPARATE COMPUTATION AND NOT A CALL TO THE SAME FUNCTION
 *
 * `test/chart.test.ts` checks `bucketsFor` against hand-written expectations, which
 * catches arithmetic mistakes. It cannot catch a mistake in HOW THE API USES it --
 * the wrong limit, the wrong decimals, buckets built from the wrong column, a series
 * reversed before bucketing. For that the comparison has to come from somewhere that
 * shares no code with the thing under test.
 *
 * So this file:
 *   - reads vault_snapshots with its own SQL,
 *   - computes the share price with its own arithmetic (written out longhand from the
 *     ERC-4626 formula, not imported),
 *   - buckets by its own floor(timestamp / bucket),
 *   - and compares the result field by field against the live HTTP response.
 *
 * It is deliberately the slow, obvious version. If both agree, the agreement means
 * something; if the API called the same helper it would mean nothing.
 *
 * Usage: node --experimental-strip-types tools/verify-candles.ts [baseUrl] [bucketSeconds] [limit]
 *
 * NOTE ON WHAT A PASS MEANS, AND WHAT IT DOES NOT
 *
 * The API's `limit` is BLOCKS PULLED, counted back from the newest row. Most of this
 * chain's recent blocks carry an unchanged price, so a check that only ever looks at
 * the newest N rows will agree while every candle has open == high == low == close --
 * agreement that proves the plumbing but not the aggregation. The report prints
 * `distinct closes` for exactly that reason: a run with one distinct close has not
 * exercised the OHLC logic, whatever it says. Use a larger `limit` to reach a region
 * where the price actually moved.
 */
import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const BUCKET_SECONDS = Number(process.argv[3] ?? 600);
const LIMIT = Number(process.argv[4] ?? 3000);
/** Optional block range for the independent pass. TO=0 means "newest LIMIT rows". */
const FROM = Number(process.argv[5] ?? 0);
const TO = Number(process.argv[6] ?? 0);

interface ApiCandle {
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

/** The ERC-4626 conversion, written out from the spec rather than imported. */
function priceOf(totalAssets: string, totalSupply: string, assetDecimals: number, shareDecimals: number): bigint | null {
  const supply = BigInt(totalSupply);
  if (supply === 0n) return null;
  const assets = BigInt(totalAssets);
  // assets = shares * (totalAssets + 1) / (totalSupply + 10 ** decimalsOffset)
  // Inverting for one whole share:
  //   price = (totalAssets + 1) * 10**shareDecimals / (totalSupply + 10 ** (shareDecimals - assetDecimals))
  const numerator = (assets + 1n) * 10n ** BigInt(shareDecimals);
  const denominator = supply + 10n ** BigInt(shareDecimals - assetDecimals);
  return numerator / denominator; // integer division: the contract floors
}

const trim = (v: bigint, decimals: number): string => {
  const scale = 10n ** BigInt(decimals);
  const whole = v / scale;
  const frac = (v % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole}.${frac}`;
};

const group = (s: string): string => {
  const [w = '', f] = s.split('.');
  return w.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f === undefined ? '' : `.${f}`);
};

async function main(): Promise<number> {
  const decimalsResp = await fetch(`${BASE}/api/price?limit=1`);
  const decimalsBody = (await decimalsResp.json()) as { decimals: { asset: number; share: number } };
  const assetDecimals = decimalsBody.decimals.asset;
  const shareDecimals = decimalsBody.decimals.share;
  console.log(`decimals from the API : asset=${assetDecimals} share=${shareDecimals}`);

  const bucketSeconds = BUCKET_SECONDS;
  /**
   * The requested limit, clamped the way the API clamps it.
   *
   * This line exists because the first version of this tool got it wrong and reported
   * a false failure. `?limit=6076` is not a request the API serves: it clamps to
   * `LIMITS.candles.max` (5000) and says so in the body. Passing 6076 straight to the
   * database made the independent pass read 6076 rows against the API's 5000, so the
   * API looked like it was dropping the four oldest candles when it was doing exactly
   * what it documented.
   *
   * The reconciliation below then ASSERTS that the API reported the same effective
   * limit, so this cannot silently drift if the cap changes.
   */
  const requested = LIMIT;
  const limit = Math.min(requested, 5000);
  const resp = await fetch(`${BASE}/api/candles?bucket=${bucketSeconds}&limit=${requested}`);
  if (!resp.ok) {
    console.error(`/api/candles returned ${resp.status}: ${await resp.text()}`);
    return 1;
  }
  const body = (await resp.json()) as {
    candles: ApiCandle[];
    count: number;
    pointsPulled: number;
    pointsSkipped: number;
    limit: number;
  };
  console.log(`API                   : ${body.count} candles from ${body.pointsPulled} blocks, ${body.pointsSkipped} skipped`);

  const problems: string[] = [];
  // The API reports the limit it ACTUALLY applied. If that is not what this tool
  // assumed, every comparison after it is meaningless, so it is checked first.
  if (body.limit !== limit) {
    problems.push(
      `the API applied limit=${body.limit} but this tool assumed ${limit}. ` +
        'The clamp rule changed; fix this tool before trusting anything below.',
    );
  }
  if (body.pointsPulled > limit) problems.push(`the API pulled ${body.pointsPulled} blocks, more than its own limit ${limit}`);

  // The block range the API actually pulled, read off the response rather than guessed:
  // the candles span exactly the blocks that went into them.
  if (body.candles.length === 0) {
    console.log('\n[SKIP] the API returned no candles, so there is nothing to reconcile.');
    return 0;
  }
  const pulledFrom = body.candles[0]!.firstBlock;
  const pulledTo = body.candles[body.candles.length - 1]!.lastBlock;
  console.log(`API pulled blocks     : ${pulledFrom}..${pulledTo}`);

  // ── The independent recomputation ─────────────────────────────────────────
  //
  // IT MUST COVER THE WINDOW THE API ACTUALLY PULLED, not the range being inspected.
  //
  // The first version of this tool got that wrong: it computed buckets for [FROM, TO]
  // only, then compared them against the API's response, which covers the API's whole
  // pull. Every candle outside the range was reported as "the API produced something
  // the independent pass did not" -- 174 false failures from a comparison that was
  // never like-for-like. A reconciliation has to be given the same inputs before it
  // can say anything about the outputs.
  //
  // So: the API tells us its block range in the body (`coverage` / the points), and the
  // independent pass reads THE SAME ROWS. The range then only selects which buckets
  // get compared, and the boundary buckets are excluded because a bucket straddling
  // the edge is complete in one pass and partial in the other for reasons that say
  // nothing about either.
  const db = new DatabaseSync(resolve(REPO, 'data/vault.sqlite'), { readOnly: true });
  const rows = db
    .prepare(
      `SELECT block_number AS b, timestamp AS t, total_assets AS a, total_supply AS s
       FROM vault_snapshots WHERE block_number >= ? AND block_number <= ? ORDER BY block_number`,
    )
    .all(pulledFrom, pulledTo) as { b: number; t: number; a: string; s: string }[];
  db.close();

  if (rows.length !== body.pointsPulled) {
    problems.push(
      `the database returned ${rows.length} snapshots for blocks ${pulledFrom}..${pulledTo} ` +
        `but the API reports pulling ${body.pointsPulled} -- the two passes are not looking at the same rows`,
    );
  }

  const ranged = TO > 0;
  const inRange = (b: number) => (ranged ? b >= FROM && b <= TO : true);

  // The API pulls the NEWEST `limit` rows; mirror that, then order by time.
  const points = rows
    .map((r) => ({ b: r.b, t: r.t, p: priceOf(r.a, r.s, assetDecimals, shareDecimals) }))
    .sort((x, y) => x.t - y.t || x.b - y.b);

  const expect = new Map<number, { o: bigint; h: bigint; l: bigint; c: bigint; n: number; fb: number; lb: number }>();
  let skipped = 0;
  for (const p of points) {
    if (p.p === null) {
      skipped++;
      continue;
    }
    const key = Math.floor(p.t / bucketSeconds) * bucketSeconds;
    const cur = expect.get(key);
    if (cur === undefined) {
      expect.set(key, { o: p.p, h: p.p, l: p.p, c: p.p, n: 1, fb: p.b, lb: p.b });
    } else {
      if (p.p > cur.h) cur.h = p.p;
      if (p.p < cur.l) cur.l = p.p;
      cur.c = p.p;
      cur.n++;
      if (p.b < cur.fb) cur.fb = p.b;
      if (p.b > cur.lb) cur.lb = p.b;
    }
  }
  console.log(`independent           : ${expect.size} candles, ${skipped} skipped`);

  // ── Compare ───────────────────────────────────────────────────────────────
  // Only buckets fully inside [FROM, TO] are compared when a range was given; the
  // rest belong to the API's wider pull and are not the range's business.
  const comparable = new Set<number>();
  const boundary: number[] = [];
  for (const [key, e] of expect) {
    if (inRange(e.fb) && inRange(e.lb)) comparable.add(key);
    else boundary.push(key);
  }
  if (ranged) {
    console.log(`comparing             : ${comparable.size} candle(s) fully inside [${FROM}, ${TO}]; ${boundary.length} touching the edge skipped`);
  }

  const pullStart = Math.min(...expect.keys());
  const apiCandles = body.candles.filter((c) => (ranged ? c.startsAt >= pullStart : true));
  if (body.count !== expect.size) problems.push(`candle count: api=${body.count} independent=${expect.size}`);
  if (body.pointsSkipped !== skipped) problems.push(`skipped: api=${body.pointsSkipped} independent=${skipped}`);

  let checked = 0;
  for (const c of apiCandles) {
    const e = expect.get(c.startsAt);
    if (e === undefined) {
      problems.push(`api has a candle at ${c.startsAt} that the independent pass did not produce`);
      continue;
    }
    if (ranged && !comparable.has(c.startsAt)) continue;
    checked++;
    const want = {
      open: group(trim(e.o, assetDecimals)),
      high: group(trim(e.h, assetDecimals)),
      low: group(trim(e.l, assetDecimals)),
      close: group(trim(e.c, assetDecimals)),
      points: e.n,
      firstBlock: e.fb,
      lastBlock: e.lb,
    };
    for (const k of ['open', 'high', 'low', 'close', 'points', 'firstBlock', 'lastBlock'] as const) {
      if (c[k] !== want[k]) {
        problems.push(`bucket ${c.startsAt} ${k}: api=${String(c[k])} independent=${String(want[k])}`);
      }
    }
  }
  for (const key of comparable) {
    if (!body.candles.some((c) => c.startsAt === key)) problems.push(`bucket ${key} missing from the API response`);
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const varying = body.candles.filter((c) => c.open !== c.close || c.points > 1);
  console.log('');
  console.log(`candles with movement or more than one block : ${varying.length}`);
  for (const c of varying.slice(0, 4)) {
    console.log(`  ${new Date(c.startsAt * 1000).toISOString()}  o=${c.open} h=${c.high} l=${c.low} c=${c.close}  (${c.points} pts, blocks ${c.firstBlock}..${c.lastBlock})`);
  }

  const distinctCloses = new Set(body.candles.map((c) => c.close));
  console.log(`distinct closes : ${distinctCloses.size}  -> ${[...distinctCloses].slice(0, 6).join(', ')}${distinctCloses.size > 6 ? ', …' : ''}`);

  console.log('');
  if (problems.length === 0) {
    console.log(`[OK] /api/candles agrees with an independent recomputation on ${checked} candle(s).`);
    if (distinctCloses.size <= 1) {
      console.log(
        '[WARN] every candle has the same close, so open == high == low == close everywhere and the ' +
          'aggregation was not exercised -- only the plumbing was. Use a block range where the price moved.',
      );
    }
    return 0;
  }
  console.log(`[FAIL] ${problems.length} disagreement(s):`);
  for (const p of problems.slice(0, 20)) console.log(`  - ${p}`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('verify-candles failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
