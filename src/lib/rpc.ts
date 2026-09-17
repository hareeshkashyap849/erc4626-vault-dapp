/**
 * JSON-RPC access.
 *
 * BATCHING IS PART OF THE DESIGN, NOT AN OPTIMISATION.
 *
 * A catch-up pass needs a timestamp per block. Asking one block at a time is a
 * round trip each, and the vault repository's `ARCHITECTURE.md` §7.3 MEASURED the
 * difference on real Base endpoints: 437 ms for a batched timestamp call against
 * 177-317 ms PER BLOCK on the fallback. For the 300-block catch-up the plan budgets
 * for, that is the difference between about 0.65 s and about 12.5 s -- and against a
 * 20 s budget, the unbatched path is one bad endpoint away from never finishing.
 *
 * ERRORS ARE RETURNED, NOT THROWN, for one specific case: a method the endpoint does
 * not support. `mainnet.base.org` does not serve batched `eth_getBlockByNumber` at
 * all, and the documented fallback exists for exactly that. Every other error is
 * thrown, because swallowing them would turn a broken endpoint into silent gaps in
 * the index.
 *
 * A RATE LIMIT IS A THIRD CASE, AND IT IS NOT A CAPABILITY FACT.
 *
 * This client used to treat every non-2xx alike: one retry after a fixed 250 ms, then
 * throw. Against a public endpoint that answer is wrong, and it was measured wrong in
 * production. The scheduled workflow ran 105 times and failed 105 times -- 104 of them
 * before the RPC URL secret existed, and after that secret was added it still failed,
 * because the public endpoint throttles GitHub's runner IPs:
 *
 *     indexer failed: https://sepolia.base.org: HTTP 429 Too Many Requests
 *
 * That 429 arrives on the SECOND request of the run -- `eth_chainId` succeeds and the
 * next call is refused -- and because the run throws, the workflow's "Commit the
 * snapshot if it changed" step never executes, so the published snapshot never
 * advances at all.
 *
 * Measured shape of the limit on `sepolia.base.org`, so the backoff below is sized from
 * a fact rather than from a guess:
 *
 *     30 requests concurrently  -> 30 x 200
 *     60 requests concurrently  -> 40 x 200, 20 x 429   (the ceiling is concurrency, ~40)
 *     30 requests sequentially  -> 30 x 200             (no per-second limit)
 *     5 s after a 429, 1/s      -> 20 x 200             (a 429 clears within seconds)
 *
 * So a throttled endpoint must be backed off and asked again, not written off. The
 * distinction is the same one recorded in `docs/优化检查点.md`: a 429 is throttling, a
 * 5xx is jitter, and only a genuine capability failure is fatal on the first attempt.
 */

export interface BlockHeader {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
}

export interface RpcOptions {
  /**
   * How many HTTP attempts per request. Default 5.
   *
   * Not 2 any more: a throttled public endpoint refuses the SAME request that would
   * succeed a few seconds later, so the number of tries is what decides whether a run
   * survives a rate limit at all.
   */
  attempts?: number;
  /** Abort a single HTTP request after this long. */
  timeoutMs?: number;
  /** Longest single backoff between attempts, in ms. Default 8000. */
  maxBackoffMs?: number;
  fetchFn?: typeof fetch;
  /** Injected in tests so backoff can be observed without waiting for it. */
  sleepFn?: (ms: number) => Promise<void>;
}

/** How the client should react to a failed HTTP request. */
export type FailureKind =
  /** Throttled or temporarily broken: ask again after a backoff. */
  | 'retry'
  /** A fact about this endpoint or this request: retrying repeats the same rejection. */
  | 'fatal';

/**
 * Decide, from a status code, whether asking again can help.
 *
 * 429 is the case this exists for. 5xx is included because a public endpoint answers
 * those under load, and the correct reaction is the same. Everything else -- a 400, a
 * 401, a 404 -- is a statement about the request, and re-sending it spends the
 * catch-up budget to receive the identical rejection.
 */
export function classifyHttpFailure(status: number): FailureKind {
  if (status === 429) return 'retry';
  if (status >= 500) return 'retry';
  return 'fatal';
}

/**
 * `Retry-After` in seconds, when the endpoint supplies it.
 *
 * Providers that send it know better than our backoff curve does. Capped, because a
 * hostile or mistaken value must not park the run past its own wall-clock bound.
 */
export function retryAfterMs(headerValue: string | null, capMs: number): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, capMs);
}

/** Thrown for a failed HTTP request, keeping the status so callers can classify it. */
export class RpcHttpError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string) {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ''}`);
    this.name = 'RpcHttpError';
    this.status = status;
  }
}

export class RpcClient {
  readonly url: string;
  private nextId = 1;
  private readonly attempts: number;
  private readonly timeoutMs: number;
  private readonly maxBackoffMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(url: string, options: RpcOptions = {}) {
    if (!url) throw new Error('RpcClient needs a url');
    this.url = url;
    this.attempts = options.attempts ?? 5;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 8_000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.sleepFn = options.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (typeof this.fetchFn !== 'function') throw new Error('RpcClient needs a fetch implementation');
  }

  /** A single JSON-RPC call. */
  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const results = await this.batch<T>([{ method, params }]);
    // `batch` maps over the requests it was given, so one request yields one result.
    // `noUncheckedIndexedAccess` cannot know that, and the assertion states it once.
    return results[0]!;
  }

  /**
   * Several calls in ONE HTTP request.
   *
   * Responses are matched by id, never by position: the JSON-RPC specification does
   * not guarantee order, and a positional matcher attaches every answer to the wrong
   * question without ever throwing.
   */
  async batch<T = unknown>(calls: readonly { method: string; params?: unknown[] }[]): Promise<T[]> {
    if (calls.length === 0) return [];

    const payload = calls.map((c) => ({ jsonrpc: '2.0', id: this.nextId++, method: c.method, params: c.params ?? [] }));
    const byId = new Map<number, { result?: T; error?: { code: number; message: string } }>();

    const body = payload.length === 1 ? payload[0] : payload;
    const response = await this.#post(body);

    for (const entry of Array.isArray(response) ? response : [response]) {
      byId.set(entry.id, entry);
    }

    return payload.map((request) => {
      const entry = byId.get(request.id);
      if (!entry) throw new Error(`no response for ${request.method} (id ${request.id})`);
      if (entry.error) {
        throw Object.assign(new Error(`${request.method}: ${entry.error.message}`), { code: entry.error.code });
      }
      return entry.result as T;
    });
  }

  /**
   * Like `batch`, but a per-call error comes back as `{ error }` instead of throwing.
   *
   * Used only where a caller has a documented fallback -- block headers on an
   * endpoint that refuses batched calls. Everywhere else, an error is an error.
   */
  async batchAllowingErrors<T = unknown>(calls: readonly { method: string; params?: unknown[] }[]): Promise<({ result: T } | { error: { code: number; message: string } })[]> {
    if (calls.length === 0) return [];
    const payload = calls.map((c) => ({ jsonrpc: '2.0', id: this.nextId++, method: c.method, params: c.params ?? [] }));
    const body = payload.length === 1 ? payload[0] : payload;
    const response = await this.#post(body);
    const byId = new Map<number, { result?: T; error?: { code: number; message: string } }>();
    for (const entry of Array.isArray(response) ? response : [response]) byId.set(entry.id, entry);

    return payload.map((request) => {
      const entry = byId.get(request.id);
      if (!entry) return { error: { code: 0, message: `no response for ${request.method}` } };
      if (entry.error) return { error: entry.error };
      return { result: entry.result as T };
    });
  }

  async #post(body: unknown): Promise<any> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      /** How long to wait before the next attempt, or null when this attempt did not fail. */
      let delayMs: number | null = null;
      try {
        const res = await this.fetchFn(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const failure = new RpcHttpError(res.status, res.statusText);
          // A rejection is a fact about this request; a throttle is a fact about this
          // moment. Only the second one is worth asking about again.
          if (classifyHttpFailure(res.status) === 'fatal') throw failure;
          const suggested = retryAfterMs(res.headers?.get?.('retry-after') ?? null, this.maxBackoffMs);
          lastError = failure;
          delayMs = suggested ?? this.#backoffMs(attempt);
        } else {
          return await res.json();
        }
      } catch (err) {
        // The response was received and classified: a fatal status is thrown out of the
        // loop here, and a retryable one arrives with its delay already chosen.
        if (err instanceof RpcHttpError) throw err;
        // Anything else is a transport failure -- reset connection, timeout, aborted.
        lastError = err as Error;
        delayMs = this.#backoffMs(attempt);
      } finally {
        clearTimeout(timer);
      }

      // Backoff for every retryable outcome, computed once, and skipped on the last
      // attempt because another would not follow it. The run's wall-clock bound still
      // applies to the total, so each sleep is bounded.
      if (delayMs !== null && attempt < this.attempts) await this.sleepFn(delayMs);
    }

    throw new Error(`${this.url}: ${lastError?.message ?? 'request failed'}`);
  }

  /**
   * Exponential backoff with jitter, capped.
   *
   * Jitter is not decoration: several runners throttled by the same endpoint would
   * otherwise retry in lockstep and throttle each other again at the same instant.
   * Capped so a run cannot spend its whole wall-clock budget waiting.
   */
  #backoffMs(attempt: number): number {
    const ceiling = Math.min(500 * 2 ** (attempt - 1), this.maxBackoffMs);
    return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
  }

  // ------------------------------------------------------------- chain reads

  async blockNumber(): Promise<number> {
    return Number(BigInt(await this.call<string>('eth_blockNumber')));
  }

  async chainId(): Promise<number> {
    return Number(BigInt(await this.call<string>('eth_chainId')));
  }

  /** One header. */
  async blockHeader(number: number): Promise<BlockHeader | null> {
    return this.#toHeader(await this.call<any>('eth_getBlockByNumber', [`0x${number.toString(16)}`, false]));
  }

  /**
   * Many headers, batched, with a per-block fallback.
   *
   * The fallback is not defensive coding: `mainnet.base.org` answers `-32601` to a
   * batched `eth_getBlockByNumber`, and the vault repository's measurements record
   * that. Without the fallback the indexer would work against one endpoint and fail
   * against another, which is the kind of difference that only shows up in
   * production.
   */
  async blockHeaders(numbers: readonly number[], { batchSize = 100, onFallback }: { batchSize?: number; onFallback?: (n: number) => void } = {}): Promise<Map<number, BlockHeader>> {
    const found = new Map<number, BlockHeader>();
    for (let i = 0; i < numbers.length; i += batchSize) {
      const chunk = numbers.slice(i, i + batchSize);
      const calls = chunk.map((n) => ({ method: 'eth_getBlockByNumber', params: [`0x${n.toString(16)}`, false] }));
      const results = await this.batchAllowingErrors<any>(calls);

      const missing: number[] = [];
      results.forEach((entry, index) => {
        if ('result' in entry && entry.result) {
          const header = this.#toHeader(entry.result);
          if (header) found.set(header.number, header);
        } else {
          // `results` is the same length as `chunk`, so this is present; the index
          // signature does not know that.
          const blockNumber = chunk[index];
          if (blockNumber !== undefined) missing.push(blockNumber);
        }
      });

      if (missing.length > 0) {
        onFallback?.(missing.length);
        // One at a time. Slower and it always works.
        for (const n of missing) {
          const header = await this.blockHeader(n);
          if (header) found.set(header.number, header);
        }
      }
    }
    return found;
  }

  /**
   * Logs in a block range.
   *
   * `topics[0]` is an OR-list, so this asks for every event this indexer models in
   * one request rather than one request per event kind.
   */
  async getLogs({ address, fromBlock, toBlock, topics }: { address: string; fromBlock: number; toBlock: number; topics: string[][] }): Promise<any[]> {
    return this.call<any[]>('eth_getLogs', [
      {
        address,
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
        topics,
      },
    ]);
  }

  #toHeader(raw: any): BlockHeader | null {
    if (!raw || typeof raw.number !== 'string') return null;
    return {
      number: Number(BigInt(raw.number)),
      hash: raw.hash,
      parentHash: raw.parentHash,
      timestamp: Number(BigInt(raw.timestamp)),
    };
  }
}

/**
 * A uint256 from an `eth_call` result, or `null` when the call returned nothing.
 *
 * A JSON-RPC SUCCESS WITH AN EMPTY RESULT IS NOT A ZERO, AND IT IS NOT A NUMBER EITHER.
 *
 * Found by deploying the vault to Base Sepolia for real. The indexer's first block IS the deployment
 * block, and a public node asked for the vault's `totalAssets` at that exact height answers
 * `result: "0x"` -- the contract exists by the end of that block, but the state the node serves for the
 * call does not contain it. `BigInt('0x')` then throws `Cannot convert 0x to a BigInt`, and the indexer
 * dies on the first block of its range: a fresh deployment could not be indexed at all.
 *
 * `null` means "this was not read", and the caller must treat it as a missing measurement -- NOT as
 * zero. Zero is a claim about the vault; an empty result is a statement about the node. Collapsing the
 * two would write a fabricated `totalAssets: 0` into the series for every block a node declines to
 * answer for, which is exactly the class of error this project exists to avoid.
 */
export function decodeUintResult(entry: { result?: unknown; error?: unknown } | undefined): bigint | null {
  const raw = entry?.result;
  if (typeof raw !== 'string' || raw === '' || raw === '0x') return null;
  try {
    return BigInt(raw);
  } catch {
    // A non-hex value is not a number this code can use, and inventing one would be worse than a gap.
    return null;
  }
}
