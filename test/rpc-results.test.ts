/**
 * Tests for `decodeUintResult`.
 *
 * THE BUG THESE EXIST FOR, AND WHY IT WAS ONLY FOUND BY DEPLOYING FOR REAL
 *
 * The indexer reads `totalAssets` and `totalSupply` with batched `eth_call`s and converted the results
 * with `BigInt(result)`, having checked only that the reply HAD a `result` field. A JSON-RPC success with
 * an empty result -- `result: "0x"` -- has that field and no value in it, and `BigInt('0x')` throws:
 *
 *     indexer failed: Cannot convert 0x to a BigInt
 *
 * Every local run passed, because an Anvil node answers such a call with a zero word. A public node asked
 * for the vault's totals AT THE DEPLOYMENT BLOCK answers `0x`, because the contract is not part of the
 * state it serves for that height -- and the indexer's first block IS the deployment block. So the
 * failure appears exactly once you deploy somewhere real, on the first block, and it is total: nothing
 * can be indexed at all.
 *
 * The tests below pin the distinction the fix rests on: `null` is "this was not read", and it is NOT
 * zero. Collapsing them would write a fabricated `totalAssets: 0` into the series for every block a node
 * declines to answer for.
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeUintResult } from '../src/lib/rpc.ts';

test('a real word decodes to the number it holds', () => {
  // 1,000,000 in a 32-byte word -- an ordinary totalAssets for a 6-decimal asset.
  const word = `0x${(1_000_000n).toString(16).padStart(64, '0')}`;
  assert.equal(decodeUintResult({ result: word }), 1_000_000n);
});

test('an empty result is null, not zero', () => {
  // THE BUG. This is what a public node answers for a call at a block where the contract does not exist.
  assert.equal(decodeUintResult({ result: '0x' }), null);
  assert.equal(decodeUintResult({ result: '' }), null);
  assert.equal(decodeUintResult({}), null);
  assert.equal(decodeUintResult(undefined), null);
  // The distinction that matters: a genuine zero is 0n, and it must NOT come back as null.
  assert.equal(decodeUintResult({ result: `0x${''.padStart(64, '0')}` }), 0n);
  assert.notEqual(decodeUintResult({ result: '0x' }), 0n);
});

test('an error entry is null rather than a thrown BigInt error', () => {
  // A batched reply can carry `{error: {...}}` per element; the caller handles the error separately, but
  // this function must not explode on it either.
  assert.equal(decodeUintResult({ error: { code: -32000, message: 'execution reverted' } }), null);
});

test('a value that is not a hex integer is null, not a guess', () => {
  assert.equal(decodeUintResult({ result: 'not-hex' }), null);
  assert.equal(decodeUintResult({ result: '0xzz' }), null);
  assert.equal(decodeUintResult({ result: '12345' }), 12345n, 'a bare decimal is still a BigInt');
  assert.equal(decodeUintResult({ result: 42 }), null, 'a number, not a string: refused rather than trusted');
});

test('the largest uint256 round-trips exactly', () => {
  // The top of the type, where a double would lose everything: `BigInt(2n ** 256n - 1n)`.
  const max = (2n ** 256n - 1n).toString(16);
  assert.equal(decodeUintResult({ result: `0x${max}` }), 2n ** 256n - 1n);
});
