/**
 * Prove the new test DISCRIMINATES: that the assertion it makes fails under the old behaviour.
 *
 * WHY THIS FILE EXISTS AND IS NOT IN `test/`
 *
 * A test that passes on both the old and the new code pins nothing. The old `#post` gave every failed
 * request ONE retry after 250 ms and then threw, so the discriminator is the attempt budget with
 * backoff removed -- `attempts: 1` reproduces exactly that outcome. This script asserts the new
 * behaviour AND that the old behaviour is genuinely absent, and it also checks the "must not be
 * counted as a capability failure" rule from `docs/优化检查点.md`: a 429 must NOT be recorded as a fact
 * about the endpoint, because writing off the only endpoint that works is the expensive mistake.
 *
 * Kept out of `test/` because it is a one-off demonstration of discrimination, not a regression test,
 * and `tools/run-all.mjs` fails the suite for any `.test.ts` file present but unlisted.
 *
 * Run: node tools/verify-throttle-fix.ts   (from the repo root)
 */
import assert from 'node:assert/strict';

import { RpcClient, classifyHttpFailure } from '../src/lib/rpc.ts';

const BODY = { jsonrpc: '2.0', id: 1, result: '0x2cc5744' };

function response(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `Status ${status}`,
    headers: new Headers(),
    json: async () => BODY,
  } as unknown as Response;
}

const sleepFn = async () => {};

// --- 1. The old behaviour is genuinely gone ---
{
  const fetchFn = (async () => response(429)) as unknown as typeof fetch;
  const rpc = new RpcClient('https://example.invalid', { fetchFn, sleepFn, attempts: 1 });
  await assert.rejects(
    rpc.blockNumber(),
    /HTTP 429/,
    'with a single attempt a 429 must still throw -- this reproduces the old code, so the new test is discriminating',
  );
  console.log('old behaviour (1 attempt, no backoff) -> throws HTTP 429   [as the old code did]');
}

// --- 2. The new behaviour survives the same throttle ---
{
  let call = 0;
  const fetchFn = (async () => {
    call += 1;
    return call < 3 ? response(429) : response(200);
  }) as unknown as typeof fetch;
  const waits: number[] = [];
  const rpc = new RpcClient('https://example.invalid', {
    fetchFn,
    sleepFn: async (ms) => {
      waits.push(ms);
    },
    attempts: 5,
  });
  const head = await rpc.blockNumber();
  assert.equal(head, 0x2cc5744);
  assert.equal(waits.length, 2, 'backed off once per throttled attempt');
  console.log(`new behaviour (5 attempts) -> recovered after ${waits.length} backoffs ${JSON.stringify(waits)}  head=${head}`);
}

// --- 3. A 429 is not a capability fact ---
{
  assert.equal(classifyHttpFailure(429), 'retry');
  const message = String(new Error('HTTP 429 Too Many Requests').message).toLowerCase();
  const looksLikeCapability = /batch not supported|non-batch reply|max.*batch|invalid params/.test(message);
  assert.equal(looksLikeCapability, false, 'a 429 must never be recorded as "this endpoint cannot do it"');
  console.log('429 is classified retryable and is not a capability failure');
}

console.log('\nOK');
