/**
 * Tests for the share price.
 *
 * THE TEST THIS FILE EXISTS FOR
 *
 * `sharePrice` applies the decimal offset TWICE: once to compute
 * `offset = shareDecimals - assetDecimals` (12), and again to raise ten to it
 * (`10 ** 12`). An earlier version of the sibling dApp applied it once and used
 * `10 ** shareDecimals` (10**18) as the virtual-share term -- a term 10**6 too large,
 * reporting a per-share value that was 24,038,462/25,000,000 of the truth. A 4% error
 * that prints as a perfectly plausible number, which is why it survived a reading and
 * was caught only by an integration test.
 *
 * The regression test below therefore does not assert "a number came back". It
 * computes BOTH values, asserts the correct one against a hand-checked figure, asserts
 * the wrong one against ITS hand-checked figure, and asserts they differ. A future
 * change that reintroduces the bug fails on the second assert with the bad value named
 * in the message.
 *
 * Run: node --experimental-strip-types test/price.test.ts
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { formatUnits, priceSeries, sharePrice, type PriceDecimals, type SharePriceInput } from '../src/api/price.ts';
import type { VaultSnapshotRow } from '../src/lib/db.ts';

/**
 * The deployment's shape: a 6-decimal asset (USDC-like) and 18-decimal shares, so
 * `_decimalsOffset()` is 12. Every number in this file is hand-computed from
 * OpenZeppelin's formula with that offset -- none of it is captured output.
 */
const USDC = { assetDecimals: 6, shareDecimals: 18 } as const;

/**
 * A price at the deployment's shape, or at any other shape a test names.
 *
 * The parameter is annotated rather than inferred from `USDC`: left inferred, its type
 * would be the literal `{ assetDecimals: 6; shareDecimals: 18 }` and the 6/6 decimals
 * cross-check below would not typecheck even though it is exactly the point.
 */
const priceOf = (totalAssets: string, totalSupply: string, decimals: PriceDecimals = USDC): string | null =>
  sharePrice({ totalAssets, totalSupply, ...decimals });

/**
 * The bug, written out: the virtual-share term as `10**shareDecimals` instead of
 * `10**offset`. Kept as a function rather than as a comment so the regression test can
 * run it and show what it produces.
 */
function buggySharePrice({ totalAssets, totalSupply, assetDecimals, shareDecimals }: SharePriceInput): string | null {
  const supply = BigInt(totalSupply);
  if (supply === 0n) return null;
  const wrongTerm = 10n ** BigInt(shareDecimals); // the whole exponent, applied where the offset belongs
  return formatUnits(((BigInt(totalAssets) + 1n) * 10n ** BigInt(shareDecimals)) / (supply + wrongTerm), assetDecimals);
}

// -------------------------------------------------------------- the known-good case

/**
 * @dev THE KNOWN-GOOD CASE, AND ONE DIGIT OF DISAGREEMENT WITH THE BRIEF.
 *
 * The brief for this module states: "a vault with 550 assets and 500 shares at 6/18
 * decimals has a price of `1.1` (verify your formula reproduces this exactly before
 * writing the assertion -- compute it, do not guess)".
 *
 * Computed, it is `1.099999` -- and that is the correct answer for the formula the same
 * brief specifies, `(totalAssets + 1) * 10**shareDecimals / (totalSupply + 10**offset)`:
 *
 *     A = 550 * 10**6  = 550000000
 *     S = 500 * 10**18 = 500000000000000000000
 *     offset           = 18 - 6 = 12
 *
 *     (A + 1) * 10**18 / (S + 10**12)
 *       = 550000001 * 10**18 / (500000000000000000000000 + 1000000000000)
 *       = 550000001000000000000000000 / 500000000000000000001000000
 *       = 1099999 (exact quotient 1099999.999999999999997999...)
 *
 * so at the asset's 6 decimals the price is `1.099999`, one base unit below `1.1`. The
 * brief's own example output on its first page is `"1.099999"`, which is this number.
 *
 * The two are not in conflict, and the deployed vault shows why. A live run against the
 * local chain indexes `A = 934924100`, `S = 849930996648200851546` and the same formula
 * yields exactly 1100000 -- `"1.1"`. So the formula does produce 1.1, at ratios a
 * fraction above it; at exactly 550/500 it lands one base unit short. Both facts are
 * asserted below, because a test that only carried one of them would leave the reader
 * unable to tell which of the two figures was wrong.
 *
 * So the assertion is the computed value, and the brief's figure is carried here beside
 * it rather than quietly dropped.
 */
test('a vault holding 550 assets against 500 shares prices one share at 1.099999, one base unit below 1.1', () => {
  // Base units, which is what vault_snapshots stores: 550 * 10**6 of a 6-decimal asset,
  // and 500 * 10**18 shares. The brief describes this position as "1.1"; the formula it
  // specifies floors to 1.099999999 base units, so six decimals read "1.099999".
  const price = priceOf('550000000', '500000000000000000000');

  assert.equal(price, '1.099999', 'the brief calls this 1.1; the formula it specifies computes this');
  assert.equal(formatUnits(((550000000n + 1n) * 10n ** 18n * 1000n) / (500n * 10n ** 18n + 10n ** 12n), 9), '1.099999999',
    'nine decimals show where the last unit went: the quotient is 1.099999999999... and it floors');
  // The comparison the brief asked for, made explicitly so the deviation is a statement
  // rather than a suspicion.
  assert.notEqual(price, '1.1', '1.1 is the prose figure, not the arithmetic one');
  assert.equal(Number(price), Number('1.099999'));
});

/**
 * @dev The other half of the 1.1 question, with numbers that came off the chain.
 *
 * These two totals were read from the deployed YieldVault by a live API run: they are
 * the last snapshot the indexer held, with 934924100 of a 6-decimal asset against
 * 849930996648200851546 shares. The same formula that returns 1.099999 for 550/500
 * returns EXACTLY 1100000 here -- `"1.1"`, with no shortfall at all.
 *
 * That is what makes the brief's figure right and the 550/500 shortfall real at the
 * same time: the ratio is a hair above 1.1, so the floor lands on it rather than one
 * unit below. A vault whose assets and shares sit just either side of that line prices
 * at 1.1 or at 1.099999 depending on which side it falls, and both are the contract's
 * answer rather than a rounding choice made here.
 */
test('the deployed vault prices at exactly 1.1 at ratios just above it', () => {
  const assets = '934924100';
  const supply = '849930996648200851546';

  assert.equal(priceOf(assets, supply), '1.1', 'the live deployment, where the floor lands on 1.1');
  // The hidden precision, to show the two cases are the same arithmetic and not a
  // special case: carried to 12 decimals this one is 1.100000004220..., above 1.1,
  // where 550/500 is 1.099999999... below it.
  assert.equal(
    formatUnits(((BigInt(assets) + 1n) * 10n ** 18n * 10n ** 6n) / (BigInt(supply) + 10n ** 12n), 12),
    '1.100000004220',
    'the real row sits just above 1.1, which is why six decimals read as exactly 1.1',
  );
});

test('the same vault in whole units rather than base units is the same price', () => {
  // Stated twice on purpose: the numbers above are only convincing if it is clear they
  // are base units. 550 * 10**6 and 500 * 10**18.
  assert.equal(priceOf((550n * 10n ** 6n).toString(), (500n * 10n ** 18n).toString()), priceOf('550000000', '500000000000000000000'));
});

test('a vault whose shares are worth exactly one asset prints "1", not "1.000000"', () => {
  // The first depositor's position, from the vault repository's own test: 25 USDC in
  // mints 25e6 * 1e12 = 2.5e19 shares, because the offset costs the first depositor
  // nothing. (A+1)*1e18/(S+1e12) = 25000001e18/25000001e12 = 1e6 -> "1.000000" -> "1".
  const shares = 25_000_000n * 10n ** 12n;
  assert.equal(priceOf('25000000', shares.toString()), '1');
});

// -------------------------------------------------------------------- empty vault

test('an empty vault has no price, and null is not 1', () => {
  assert.equal(priceOf('0', '0'), null, 'zero supply means the value of a share is undefined');

  // Not merely "falsy": 1 is the specific wrong answer, because an empty vault priced
  // at 1 is the attacker's number in the ERC-4626 inflation attack. Asserted as a
  // separate statement so the failure says which lie was told.
  assert.notEqual(priceOf('0', '0'), '1');
});

test('assets with no shares still has no price -- assets alone do not make one', () => {
  // A donation to an empty vault: real assets, zero supply. The formula is defined
  // here, but a "price" computed from donated assets and no shares is not the vault's
  // price -- it is the donation divided by the virtual term. Null.
  assert.equal(priceOf('1000000', '0'), null);
});

// ------------------------------------------------------------- the 4% bug, pinned

/**
 * @dev The regression test for the bug this file exists for.
 *
 * TWO INDEPENDENT CHECKS, because they catch different things:
 *
 *   1. The buggy variant run against the SAME 550/500 inputs. The correct term is
 *      1e12 and the wrong term is 1e18, so the wrong denominator is 1e18 too large --
 *      but totalSupply is 5e20, which is 500 times bigger again, so the denominator
 *      moves by only 0.2% and the price moves with it. "10**18 instead of 10**12"
 *      SOUNDS like a catastrophic error and is not: it is a small, plausible-looking
 *      one, which is exactly why it survived a reading.
 *
 *   2. The vault repository's own documented case, where the same bug produces
 *      24,038,462 against a true 25,000,000 -- 3.85% low. That is the figure its
 *      DESIGN.md §6 records, and the discrepancy between the two magnitudes is the
 *      lesson: how wrong the bug looks depends entirely on how large totalSupply is
 *      relative to 1e18, so a test at one scale does not cover the other.
 */
test('10**shareDecimals instead of 10**offset gives a different price, and both are shown', () => {
  const input: SharePriceInput = {
    totalAssets: '550000000',
    totalSupply: '500000000000000000000',
    ...USDC,
  };

  const right = sharePrice(input);
  const wrong = buggySharePrice(input);

  // The correct value, from the formula with the offset raised to ten.
  assert.equal(right, '1.099999', 'the correct term is 10**(18-6) = 1e12');
  // The wrong value, from the term the dApp shipped: 1e18. This assertion is what
  // names the bug in the failure output.
  assert.equal(wrong, '1.097804', 'the wrong term is 10**18, which is 1e18 too large -- 0.2% here, because supply is 5e20');
  // And they must not agree. If a future edit makes these equal, the offset is being
  // applied once again -- or applied three times, which would also be wrong and would
  // also show up here.
  assert.notEqual(right, wrong, 'a price computed with 10**shareDecimals must not equal the correct one');
});

test('the same bug is 3.85% low at the scale the vault repository documented', () => {
  // 25 assets into an empty vault mints 25e6 * 1e12 = 2.5e19 shares, so totalSupply is
  // 25 times 1e18 -- and now the wrong virtual-share term is not small beside it.
  const supply = (25_000_000n * 10n ** 12n).toString();

  const right = sharePrice({ totalAssets: '25000000', totalSupply: supply, ...USDC });
  const wrong = buggySharePrice({ totalAssets: '25000000', totalSupply: supply, ...USDC });

  assert.equal(right, '1', '25 assets against 25e18 shares is one asset per share');
  assert.equal(wrong, '0.961538', 'and the bug calls it 0.961538 -- a 3.85% shortfall that prints as a plausible number');
  assert.notEqual(right, wrong);

  // The per-share VALUE, which is where the vault repository measured it: the bug
  // returns 24,038,462 of a true 25,000,000. Same formula, one holding of shares.
  const shares = 25_000_000n * 10n ** 12n;
  const rightValue = (shares * (25_000_000n + 1n)) / (shares + 10n ** 12n);
  const wrongValue = (shares * (25_000_000n + 1n)) / (shares + 10n ** 18n);
  assert.equal(rightValue, 25_000_000n, 'the depositor can take all 25 assets back');
  assert.equal(wrongValue, 24_038_462n, 'the bug reports 24.038462 -- the figure DESIGN.md section 6 records');
  assert.equal(((rightValue - wrongValue) * 10_000n) / rightValue, 384n, 'about 3.85% low, and it looks like a number');
});

test('the wrong term is 1e18 too large, and how much that moves the price depends on the supply', () => {
  // The arithmetic of the bug, in full, because "10**18 instead of 10**12" does not
  // sound like a small error and can be: the denominator gains 1e18, so the size of
  // the error is 1e18 divided by totalSupply. At the 550/500 scale supply is 5e20 and
  // the price moves 0.2%; against 2.5e19 it moves 3.85%. Same bug, same code.
  const supply = 25_000_000n * 10n ** 12n; // 2.5e19 shares, 25 assets deposited
  const assets = 25_000_000n;
  const rightTerm = 10n ** 12n;
  const wrongTerm = 10n ** 18n;

  assert.equal(wrongTerm / rightTerm, 1_000_000n, 'the wrong term is 1e6 times the right one');
  assert.equal(supply / wrongTerm, 25n, 'and the supply is only 25 of those terms, which is why it hurts');

  const rightPrice = ((assets + 1n) * 10n ** 18n) / (supply + rightTerm); // asset base units, floored
  const wrongPrice = ((assets + 1n) * 10n ** 18n) / (supply + wrongTerm);
  assert.equal(rightPrice, 1_000_000n, 'one asset per share, as base units');
  assert.equal(wrongPrice, 961_538n);
  assert.equal(rightPrice - wrongPrice, 38_462n, 'the two prices differ by 38,462 base units in 1,000,000 -- 3.85%');
  assert.equal(((rightPrice - wrongPrice) * 10_000n) / rightPrice, 384n, 'which is 3.84% of the correct price');
});

test('the term is the OFFSET, so a 6/6 vault has no offset at all and prices at the plain ratio', () => {
  // A cross-check on the exponent itself: at offset 0 (asset and shares both 6
  // decimals) the virtual-share term is 1e0 = 1, so the price is the plain ratio to
  // within a base unit. If the term were 10**shareDecimals the answer would be 1e6
  // times smaller and this assertion would fail loudly rather than by a digit.
  const sixSix = { assetDecimals: 6, shareDecimals: 6 } as const;
  assert.equal(priceOf('1100000', '1000000', sixSix), '1.099999', 'the same one-base-unit floor as the 550/500 case');
  // (A+1)*1e6 / (S+1) with A = S = 1e6 is exactly 1e6, so this one floors to "1" --
  // the +1 in the numerator and the +1 in the denominator cancel there.
  assert.equal(priceOf('1000000', '1000000', sixSix), '1', 'equal totals price at one asset per share');
});

// ----------------------------------------------------------- yield, up and down

test('the price rises when assets rise with supply unchanged -- a yield report', () => {
  // reportYield raises totalAssets and mints nothing. This is the move a chart built
  // from events alone would miss, because no event carries the new totals.
  const supply = '1000000000000000000000'; // 1000 shares
  const before = priceOf('1000000000', supply); // 1000 asset units
  const after = priceOf('1050000000', supply); // 1050

  assert.equal(before, '1', '1000 assets against 1000 shares, and the +1 in the denominator floors it to exactly 1');
  assert.equal(after, '1.049999', 'a 5% yield, one base unit short of 1.05 for the same reason as the 550/500 case');
  assert.ok(
    Number(after) > Number(before),
    'assets up with supply flat must raise the price; a price that ignores the yield is the failure this test exists for',
  );
});

test('the price falls when assets fall with supply unchanged -- a loss report', () => {
  const supply = '1000000000000000000000';
  const before = priceOf('1000000000', supply);
  const after = priceOf('950000000', supply);

  assert.equal(before, '1');
  assert.equal(after, '0.95', '950/1000 floors to exactly 0.95 here: the virtual terms round down, not up');
  assert.ok(Number(after) < Number(before));
});

test('the price is an exact rational, and a stored price would have been a truncated one', () => {
  // This is the reason the price is computed on read. The stored totals are integers
  // and the formula is integer arithmetic, so there is no floating-point error here at
  // all -- but the QUOTIENT is truncated, and how much is lost depends on the inputs.
  // At 1000 assets against 1000 shares it happens to lose nothing: totalSupply at that
  // scale is an exact multiple of 10**12, so (A+1)*10**18 / (S+10**12) divides exactly.
  const S = 1000n * 10n ** 18n;
  const exactHere = ((1000000000n + 1n) * 10n ** 18n) / (S + 10n ** 12n);
  assert.equal((1000000000n + 1n) * 10n ** 18n, 1000000n * (S + 10n ** 12n), 'the division is exact, so nothing is lost');
  assert.equal(formatUnits(exactHere, 6), '1');

  // At the brief's 550/500 it is not exact. The quotient is 1099999.999999999999 --
  // a hair under 1.1 assets per share -- and six decimals report 1099999 of it:
  const A = 550000000n;
  const S550 = 500n * 10n ** 18n;
  const N = (A + 1n) * 10n ** 18n;
  const D = S550 + 10n ** 12n;
  assert.equal(N / D, 1099999n);
  assert.equal(N % D, 499900001000000000000n, 'and the remainder is nearly a whole base unit, not zero');
  assert.equal(formatUnits(N / D, 6), '1.099999');
  // The remainder is what the six-decimal answer threw away: as a fraction of the
  // denominator it is 0.999999999999 of a base unit. Carrying the quotient further
  // shows the price as 1.0999999998 -- approaching the 1.1 the brief describes, and
  // never reaching it.
  const exactAt15 = formatUnits((N * 10n ** 9n) / D, 15);
  assert.equal(exactAt15, '1.0999999998', 'the true quotient carried further: 1.0999999998..., still short of 1.1');
  assert.notEqual(exactAt15, '1.1');
  assert.equal((N * 10n ** 9n) / D, 1099999999800000n, 'fifteen decimals of the quotient, as integer units');
  // The gap to 1.1, stated once in the raw units of the formula so no one has to count
  // zeroes to check it: 1.1 * D = 550000001100000000000, and the numerator is
  // 550000001000000000000000000, so 1.1 lies BELOW the quotient rather than above it.
  // The floor is what keeps the answer short of the figure a reader expects.
  assert.equal(11n * D / 10n, 550000001100000000000n, '1.1 in the denominator units is smaller than the numerator');
  assert.ok(N * 10n ** 12n / D < 1100000000000000000n, 'and at 18 decimals the quotient is still under 1.1');

  // The same truncation on the yield move, which is what a consumer actually reads.
  assert.equal(priceOf('1000000000', (S).toString()), '1');
  assert.equal(priceOf('1050000000', (S).toString()), '1.049999');
  assert.notEqual(priceOf('1050000000', (S).toString()), '1.05', 'a 5% yield does not print as exactly 5%');
});

// ------------------------------------------------------------------ the series

const snapshots: VaultSnapshotRow[] = [
  { blockNumber: 30, blockHash: '0xc', timestamp: 300, totalAssets: '1050000000', totalSupply: '1000000000000000000000' },
  { blockNumber: 10, blockHash: '0xa', timestamp: 100, totalAssets: '1000000000', totalSupply: '1000000000000000000000' },
  { blockNumber: 20, blockHash: '0xb', timestamp: 200, totalAssets: '1000000000', totalSupply: '1000000000000000000000' },
];

test('the series is oldest-first even though the store returns newest-first', () => {
  const series = priceSeries(snapshots, USDC);
  assert.deepEqual(
    series.map((point) => point.blockNumber),
    [10, 20, 30],
    'a chart drawn left to right from newest-first rows would run backwards through time',
  );
  assert.deepEqual(series.map((point) => point.price), ['1', '1', '1.049999'], 'and the yield at block 30 is the only move');
});

test('the series keeps every stored field it was given', () => {
  const [first] = priceSeries(snapshots, USDC);
  assert.equal(first!.blockHash, '0xa');
  assert.equal(first!.timestamp, 100);
  assert.equal(first!.totalAssets, '1000000000', 'the raw totals stay in the response: the price is derived, not a replacement');
  assert.equal(first!.totalSupply, '1000000000000000000000');
});

test('the series does not mutate the rows it was handed', () => {
  const rows: VaultSnapshotRow[] = [...snapshots];
  priceSeries(rows, USDC);
  assert.deepEqual(
    rows.map((row) => row.blockNumber),
    [30, 10, 20],
    'the input order is left alone -- a caller that sorted in place would change what the store returned',
  );
  assert.ok(!('price' in rows[0]!), 'and no price is written onto the original rows');
});

test('a point with zero supply carries a null price and the series still lines up', () => {
  const series = priceSeries(
    [
      { blockNumber: 1, blockHash: '0x1', timestamp: 1, totalAssets: '0', totalSupply: '0' },
      { blockNumber: 2, blockHash: '0x2', timestamp: 2, totalAssets: '5000000', totalSupply: '5000000000000000000000' },
    ],
    USDC,
  );
  assert.equal(series[0]!.price, null, 'the deployment block has no shares, so no price');
  assert.equal(series[1]!.price, '0.001', '5000 assets against 5000 shares -- the virtual terms are invisible at this scale');
});

test('an unparseable total is an error, not a skipped point', () => {
  // The column is a decimal string written from a uint256. Something that is not one
  // means the row is not what it claims, and a chart that drops the block where that
  // happened has a lie in the middle of it.
  assert.throws(
    () => priceSeries([{ blockNumber: 1, blockHash: '0x1', timestamp: 1, totalAssets: '12.5', totalSupply: '1' }], USDC),
    /Cannot convert|not a valid/i,
  );
});

// ------------------------------------------------------------------ formatUnits

test('formatUnits trims trailing zeros and keeps the value exact', () => {
  assert.equal(formatUnits(1100000n, 6), '1.1');
  assert.equal(formatUnits(1100000000n, 6), '1100', 'the same digits at a larger scale are a larger number: 1100.000000');
  assert.equal(formatUnits(1000000n, 6), '1');
  assert.equal(formatUnits(999999n, 6), '0.999999');
  assert.equal(formatUnits(0n, 6), '0');
  assert.equal(formatUnits(1n, 6), '0.000001');
  assert.equal(formatUnits(123456789012345678901234567890n, 18), '123456789012.34567890123456789');
});

test('formatUnits refuses a negative decimal count rather than guessing', () => {
  assert.throws(() => formatUnits(1n, -1), /non-negative integer/);
  assert.throws(() => formatUnits(1n, 1.5), /non-negative integer/);
});

test('a negative offset is refused, because the contract cannot have produced one', () => {
  // assetDecimals > shareDecimals would make the virtual-share term 10**-n, a
  // fraction. Clamping it to zero would price the vault differently from the chain it
  // indexes, silently.
  assert.throws(
    () => sharePrice({ totalAssets: '1', totalSupply: '1', assetDecimals: 18, shareDecimals: 6 }),
    /must not be less than/,
  );
});

test('uint256-scale values do not lose precision', () => {
  // 2**200 assets against 2**180 shares. Every step is BigInt; a single Number
  // anywhere in the chain would produce a number with the right digit count and the
  // wrong digits.
  const assets = (2n ** 200n).toString();
  const supply = (2n ** 180n).toString();
  const price = priceOf(assets, supply);
  assert.equal(price, formatUnits(((2n ** 200n + 1n) * 10n ** 18n) / (2n ** 180n + 10n ** 12n), 6));
  assert.ok(price !== null && price.length > 10, 'a huge ratio is still an exact decimal string');
});
