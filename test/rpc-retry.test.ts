/**
 * Tests for how the RPC client reacts to a THROTTLED endpoint.
 *
 * THE BUG THESE EXIST FOR, AND HOW IT WAS FOUND
 *
 * `#post` treated every non-2xx response the same way: one retry after a fixed 250 ms, then throw. A
 * public endpoint throttles by concurrency, and the scheduled workflow runs from GitHub's shared
 * runner IPs, so the run took a 429 on its SECOND request -- `eth_chainId` answered, the next call did
 * not. The throw skipped the workflow's "Commit the snapshot if it changed" step entirely, so the
 * published `data/vault.sqlite` never advanced. MEASURED: 105 scheduled runs, 105 failures, zero
 * commits by `github-actions[bot]`.
 *
 * The endpoint is not broken and the limit is not permanent. Measured against `sepolia.base.org`:
 *
 *     30 requests concurrently -> 30 x 200
 *     60 requests concurrently -> 40 x 200, 20 x 429
 *     a few seconds later       -> 200 again
 *
 * So the distinction is: a 429 or a 5xx is a fact about this MOMENT and is worth retrying with
 * backoff; any other 4xx is a fact about this REQUEST and retrying it just repeats the rejection. The
 * same rule is recorded in this workspace's `docs/优化检查点.md`: 429 means throttling, 5xx means
 * jitter, and only a genuine capability failure is fatal at the first attempt.
 *
 * The last test below is the one that fails on the old code.
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RpcClient, classifyHttpFailure, retryAfterMs, RpcHttpError } from '../src/lib/rpc.ts';

const RPC_BODY = { jsonrpc: '2.0', id: 1, result: '0x2cc5744' };

/** A Response stand-in carrying only what `#post` reads. */
function response(status: number, body: unknown = RPC_BODY, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `Status ${status}`,
    headers: new Headers(headers),
    json: async () => body,
  } as unknown as Response;
}

/**
 * A fetch stand-in that answers with a scripted list of responses and counts the calls.
 *
 * `sleepFn` is injected so the backoff is observed rather than waited out: the test asserts that the
 * client DID wait, which is the part of the fix that makes a throttled run survive, without spending
 * the real seconds.
 */
function scriptedFetch(responses: Response[]): { fetchFn: typeof fetch; calls: () => number } {
  let call = 0;
  const fetchFn = (async () => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return next;
  }) as unknown as typeof fetch;
  return { fetchFn, calls: () => call };
}

/** Records every backoff the client asks for, and returns immediately. */
function recordingSleep(): { sleepFn: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleepFn: async (ms: number) => {
      waits.push(ms);
    },
  };
}

test('a 429 is classified as retryable, and other 4xx as fatal', () => {
  assert.equal(classifyHttpFailure(429), 'retry', 'throttling is a fact about this moment');
  assert.equal(classifyHttpFailure(500), 'retry', 'a 5xx is jitter, and asking again is cheap');
  assert.equal(classifyHttpFailure(503), 'retry');
  assert.equal(classifyHttpFailure(400), 'fatal', 'the request itself is wrong; resending repeats it');
  assert.equal(classifyHttpFailure(401), 'fatal');
  assert.equal(classifyHttpFailure(404), 'fatal');
});

test('Retry-After is honoured in seconds, and capped so it cannot park a run', () => {
  assert.equal(retryAfterMs('2', 8000), 2000);
  assert.equal(retryAfterMs('0', 8000), 0);
  assert.equal(retryAfterMs(null, 8000), null, 'absent header: fall back to the backoff curve');
  assert.equal(retryAfterMs('soon', 8000), null, 'a value that is not a number is ignored');
  assert.equal(retryAfterMs('600', 8000), 8000, 'an hour would outlive the run: capped');
});

test('THE FIX: a 429 followed by a 200 is a successful read, not a thrown error', async () => {
  const { fetchFn, calls } = scriptedFetch([response(429), response(200)]);
  const { sleepFn, waits } = recordingSleep();
  const rpc = new RpcClient('https://example.invalid', { fetchFn, sleepFn });

  // On the old code this threw `HTTP 429 Too Many Requests`, which is what killed every scheduled run.
  const head = await rpc.blockNumber();

  assert.equal(head, 0x2cc5744, 'the retry result is the value that comes back');
  assert.equal(calls(), 2, 'the throttled attempt was retried exactly once');
  assert.equal(waits.length, 1, 'and the client backed off before asking again');
  assert.ok(waits[0]! > 0, `backoff must be a positive wait, got ${waits[0]}`);
});

test('a run of 429s is survived when the endpoint recovers', async () => {
  const { fetchFn, calls } = scriptedFetch([response(429), response(429), response(429), response(200)]);
  const { sleepFn, waits } = recordingSleep();
  const rpc = new RpcClient('https://example.invalid', { fetchFn, sleepFn });

  assert.equal(await rpc.blockNumber(), 0x2cc5744);
  assert.equal(calls(), 4);
  assert.equal(waits.length, 3, 'one backoff per throttled attempt');
  // Exponential, so a short throttle does not turn into a long run: each wait is larger than the last.
  assert.ok(waits[1]! > waits[0]!, `expected growth, got ${waits.join(', ')}`);
  assert.ok(waits[2]! > waits[1]!, `expected growth, got ${waits.join(', ')}`);
});

test('retrying is BOUNDED: a permanently throttled endpoint still fails, and says why', async () => {
  const { fetchFn, calls } = scriptedFetch([response(429)]);
  const { sleepFn, waits } = recordingSleep();
  const rpc = new RpcClient('https://example.invalid', { fetchFn, sleepFn, attempts: 3 });

  await assert.rejects(rpc.blockNumber(), /HTTP 429/, 'the failure is loud, not swallowed');
  assert.equal(calls(), 3, 'exactly `attempts` tries: a run cannot hang on a dead endpoint');
  assert.equal(waits.length, 2, 'and it does not sleep after the final attempt');
});

test('a genuine capability failure is still fatal on the FIRST attempt', async () => {
  const { fetchFn, calls } = scriptedFetch([response(400)]);
  const { sleepFn, waits } = recordingSleep();
  const rpc = new RpcClient('https://example.invalid', { fetchFn, sleepFn, attempts: 5 });

  await assert.rejects(rpc.blockNumber(), /HTTP 400/);
  assert.equal(calls(), 1, 'a 400 is a statement about the request; five tries would be four wasted');
  assert.equal(waits.length, 0);
});

test('a transport failure is still retried, and still bounded', async () => {
  let call = 0;
  const fetchFn = (async () => {
    call += 1;
    throw new Error('fetch failed');
  }) as unknown as typeof fetch;
  const { sleepFn, waits } = recordingSleep();
  const rpc = new RpcClient('https://example.invalid', { fetchFn, sleepFn, attempts: 2 });

  await assert.rejects(rpc.blockNumber(), /fetch failed/);
  assert.equal(call, 2);
  assert.equal(waits.length, 1);
});

test('Retry-After from the endpoint overrides the backoff curve', async () => {
  const { fetchFn } = scriptedFetch([response(429, RPC_BODY, { 'retry-after': '3' }), response(200)]);
  const { sleepFn, waits } = recordingSleep();
  const rpc = new RpcClient('https://example.invalid', { fetchFn, sleepFn });

  assert.equal(await rpc.blockNumber(), 0x2cc5744);
  assert.deepEqual(waits, [3000], 'the endpoint knows its own limit better than a fixed curve does');
});

test('RpcHttpError carries the status so the decision is not re-parsed from a message', () => {
  const err = new RpcHttpError(429, 'Too Many Requests');
  assert.equal(err.status, 429);
  assert.match(err.message, /HTTP 429/);
  assert.ok(err instanceof Error);
});
