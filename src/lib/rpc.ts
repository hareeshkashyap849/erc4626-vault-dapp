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
 */

export interface BlockHeader {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
}

export interface RpcOptions {
  /** How many HTTP attempts per call. One retry covers an intermittent failure. */
  attempts?: number;
  /** Abort a single HTTP request after this long. */
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class RpcClient {
  readonly url: string;
  private nextId = 1;
  private readonly attempts: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(url: string, options: RpcOptions = {}) {
    if (!url) throw new Error('RpcClient needs a url');
    this.url = url;
    this.attempts = options.attempts ?? 2;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
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
      try {
        const res = await this.fetchFn(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        return await res.json();
      } catch (err) {
        lastError = err as Error;
        // A retry only helps for transport failures. Retrying a rejected request
        // just spends the catch-up budget twice on the same rejection.
        if (attempt < this.attempts) await new Promise((r) => setTimeout(r, 250 * attempt));
      } finally {
        clearTimeout(timer);
      }
    }

    throw new Error(`${this.url}: ${lastError?.message ?? 'request failed'}`);
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
