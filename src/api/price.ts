/**
 * The share price, computed on read.
 *
 * WHY THIS IS A PURE MODULE AND NOT A METHOD ON THE SERVER
 *
 * The price is the one number in this service that can be wrong while looking right.
 * Keeping it in a module with no database, no clock and no HTTP in it means every
 * arithmetic claim here can be checked by calling a function, and the test that
 * matters -- the one that pins the exponent -- needs nothing but Node.
 *
 * THE FORMULA, AND THE MISTAKE IT EXISTS TO PREVENT
 *
 * This is OpenZeppelin's ERC-4626 conversion, verbatim from `ERC4626.sol`:
 *
 *     assets = shares.mulDiv(totalAssets() + 1, totalSupply() + 10 ** _decimalsOffset(), rounding)
 *
 * `_decimalsOffset()` returns a NUMBER OF DECIMAL PLACES -- YieldVault sets it to
 * `SHARE_DECIMALS - assetDecimals` (18 - 6 = 12) -- and OpenZeppelin then RAISES TEN
 * TO IT. The exponent therefore applies twice, and applying it only once is the bug
 * this file is written around: an earlier version of the sibling dApp used
 * `10 ** shareDecimals` (10**18) as the virtual-share term. That is a term 10**6 too
 * large, it reported a per-share value that was 24,038,462/25,000,000 of the truth
 * (a 4% error), and it printed as a perfectly plausible number. It survived a
 * reading and was caught only by an integration test.
 *
 * So `offset` below is `shareDecimals - assetDecimals` -- 12 -- and it is then raised
 * to ten. Written as one expression that would be easy to get wrong twice; written
 * as two named lines it is checkable at a glance.
 *
 * UNITS, WHICH IS WHERE THE OTHER HALF OF THE CONFUSION LIVES
 *
 * `totalAssets` and `totalSupply` are RAW uint256 values in BASE UNITS, exactly as
 * they come off the chain and exactly as `vault_snapshots` stores them. The result is
 * the value of ONE WHOLE SHARE (`10 ** shareDecimals` share base units) in ASSET BASE
 * UNITS, which is why it is formatted with `assetDecimals`. Nothing here converts
 * anything to whole tokens: `"1.1"` means 1.1 USDC per share for a 6-decimal asset,
 * and it is derived from `550e6` assets against `500e18` shares.
 *
 * If the formula turns out to be wrong, these functions can be fixed and the same
 * rows re-read -- which is the reason `db.ts` refuses to store a price at all.
 */

import type { VaultSnapshotRow } from '../lib/db.ts';

/** Everything the price depends on. Raw totals in base units, plus the two decimal counts. */
export interface SharePriceInput {
  /** uint256 as a decimal string -- NOT the row's bigint, the stored form. */
  totalAssets: string;
  /** uint256 as a decimal string. */
  totalSupply: string;
  assetDecimals: number;
  shareDecimals: number;
}

/** One point on the chart: the stored row, plus the price derived from it. */
export interface PricePoint extends VaultSnapshotRow {
  /** Decimal string, or null for an empty vault -- see `sharePrice`. */
  price: string | null;
}

/** What must be true for a price to be computable at all. */
export interface PriceDecimals {
  assetDecimals: number;
  shareDecimals: number;
}

const TEN = 10n;

/** 10 ** decimals. Negative counts are a programming error, not a config state. */
function scaleFor(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`decimals must be a non-negative integer, got ${decimals}`);
  }
  return TEN ** BigInt(decimals);
}

/**
 * `shareDecimals - assetDecimals`, the ERC-4626 decimal offset, as a BigInt exponent.
 *
 * Checked rather than clamped. A negative offset would make the virtual-share term
 * `10 ** -offset` -- a fraction -- which Solidity cannot express, so it cannot be
 * what the contract did; and clipping it to zero would quietly price a vault
 * differently from the chain it indexes.
 */
function virtualShareExponent(assetDecimals: number, shareDecimals: number): bigint {
  const offset = shareDecimals - assetDecimals;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(
      `shareDecimals (${shareDecimals}) must not be less than assetDecimals (${assetDecimals}): ` +
        'the virtual-share term 10 ** (shareDecimals - assetDecimals) is a power of ten in the contract.',
    );
  }
  return BigInt(offset);
}

/**
 * Base units to a decimal string, trimming trailing zeros: `1100000000n` at 6 decimals
 * is `"1.1"`, not `"1.100000"`.
 *
 * Trimmed output is what makes the known-good case assertable as `"1.1"` and what
 * makes a regression test readable -- `"1.1"` against `"0.000000001"` says what is
 * wrong, where two long strings of zeros would not. Same convention as the dApp's
 * `formatUnits`, so the page and the API print the same number the same way.
 */
export function formatUnits(value: bigint, decimals: number): string {
  const scale = scaleFor(decimals);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / scale;
  const fraction = (magnitude % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  const body = fraction === '' ? whole.toString() : `${whole}.${fraction}`;
  return negative ? `-${body}` : body;
}

/**
 * The share price: the value of one whole share in asset base units, as a decimal
 * string. `null` when the vault holds no shares.
 *
 * The null is the important part. An empty vault has no price -- `totalSupply` is 0,
 * so "the value of a share" is not a small number, it is undefined -- and returning
 * `"1"` would invent one. It would also be the specific lie that matters here: the
 * inflation attack this vault's `10**offset` term defends against works precisely by
 * getting a price of one set on an empty or nearly-empty vault, so a service that
 * reports 1 for an empty vault is reporting the attacker's number as if it were a
 * fact. `null` says "no price", and the API passes it through as `null`.
 *
 * Note the two guards around the division, both of which are deliberate: the +1 and
 * the `10**offset` make the result well-defined for any NON-zero supply, which is the
 * whole point of virtual assets and shares. The `totalSupply === 0` check is not
 * defensive coding -- it is the one case the formula does not cover.
 */
export function sharePrice({ totalAssets, totalSupply, assetDecimals, shareDecimals }: SharePriceInput): string | null {
  const supply = BigInt(totalSupply);
  if (supply === 0n) return null;

  const assets = BigInt(totalAssets);
  const assetsTerm = assets + 1n; // virtual assets: the +1 of OpenZeppelin's formula
  const sharesTerm = supply + TEN ** virtualShareExponent(assetDecimals, shareDecimals); // 10**offset, NOT 10**shareDecimals

  // Integer division, deliberately: the contract floors, so the API floors. A float
  // would agree with the chain on small numbers and diverge on real ones.
  const priceInAssetBaseUnits = (assetsTerm * scaleFor(shareDecimals)) / sharesTerm;
  return formatUnits(priceInAssetBaseUnits, assetDecimals);
}

/**
 * A series with the price added, oldest-first, ready for a chart.
 *
 * `store.priceSeries(n)` returns newest-first, which is right for "the last n rows"
 * and wrong for a chart: a series drawn left to right from it would run backwards
 * through time, and it would look plausible. The reversal happens here, once, so
 * every caller gets the same order.
 *
 * A row whose totals cannot be parsed is a hard error rather than a skipped point.
 * The database column is a decimal string written by the indexer from a `uint256`,
 * so an unparseable one means the row is not what it claims to be -- and a chart that
 * silently omits the block where that happened is a chart with a lie in the middle of
 * it. The API turns this into a 500, which is the honest answer.
 */
export function priceSeries(rows: readonly VaultSnapshotRow[], decimals: PriceDecimals): PricePoint[] {
  return [...rows]
    .sort((a, b) => a.blockNumber - b.blockNumber)
    .map((row) => ({
      ...row,
      price: sharePrice({
        totalAssets: row.totalAssets,
        totalSupply: row.totalSupply,
        assetDecimals: decimals.assetDecimals,
        shareDecimals: decimals.shareDecimals,
      }),
    }));
}
