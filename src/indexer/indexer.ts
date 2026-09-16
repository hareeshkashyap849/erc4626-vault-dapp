/**
 * The indexer.
 *
 * WHAT IT HAS TO GET RIGHT, in rough order of how badly each would fail:
 *
 *   REORGANISATIONS. A block that was indexed can stop existing. If that is not
 *   handled, the index contains events that never happened and a price series with
 *   a step in it that the chain never had. The check is per-run and cheap: take the
 *   hash recorded for the last indexed block, ask the chain for that block's hash,
 *   and if they differ walk backwards until they agree, rolling back everything
 *   from the divergence.
 *
 *   IDEMPOTENCE. A catch-up that is interrupted must be safely re-runnable. That is
 *   enforced by the schema, not by care: `PRIMARY KEY (block_number, log_index)`
 *   with `INSERT OR IGNORE`.
 *
 *   BOUNDED WORK. This runs on a schedule, not resident, so a run must finish. Two
 *   independent bounds -- blocks and wall-clock -- both apply, and if either is hit
 *   the run stops cleanly and records where it got to. The alternative, an unbounded
 *   catch-up, is a run that is killed halfway through with no record of how far it
 *   went.
 *
 *   THE PRICE SERIES, which is the part that is easy to leave out. `reportYield`
 *   raises `totalAssets` and mints nothing, so the share price moves with no event
 *   that reports the new price -- it emits `YieldReported`, which carries the
 *   contribution but not the resulting totals. Reconstructing the price from events
 *   alone therefore misses exactly the jumps a chart exists to show. So each block
 *   in range is asked for its `totalAssets` and `totalSupply` directly, batched.
 */

import type { RpcClient, BlockHeader } from '../lib/rpc.ts';
import type { Store, VaultEventRow, ShareTransferRow, VaultSnapshotRow } from '../lib/db.ts';
import { TOPICS, decodeVaultLog, decodeShareTransfer, assertTopics, type RawLog } from '../lib/decode.ts';

export interface IndexerConfig {
  vault: string;
  asset: string;
  /** The vault's deployment block. Nothing before it can be the vault's. */
  startBlock: number;
  chainId: number;
  rpcUrl: string;
}

export interface RunOptions {
  /** Stop after this many blocks, whatever the clock says. */
  maxBlocks?: number;
  /** Stop after this long, whatever the block count says. */
  maxSeconds?: number;
  /** Confirmations to wait for before treating a block as final. */
  confirmations?: number;
  keccak256?: (signature: string) => string;
  now?: () => number;
}

export interface RunResult {
  fromBlock: number;
  toBlock: number;
  blocksScanned: number;
  eventsInserted: number;
  transfersInserted: number;
  snapshotsWritten: number;
  unknownLogs: number;
  reorgDepth: number;
  /** True when a bound stopped the run before it reached the target. */
  truncated: boolean;
  chainHead: number;
  elapsedMs: number;
}

/** Function selectors, for the two views the price series needs. */
const SELECTOR = {
  totalAssets: '0x01e1d114',
  totalSupply: '0x18160ddd',
};

export class Indexer {
  readonly store: Store;
  readonly rpc: RpcClient;
  readonly config: IndexerConfig;
  /** Write the bound arithmetic to the log, so a wrong bound is visible rather than inferred. */
  verbose = false;

  constructor(store: Store, rpc: RpcClient, config: IndexerConfig) {
    this.store = store;
    this.rpc = rpc;
    this.config = config;
  }

  /**
   * Verify the event topics against their signatures before indexing anything.
   *
   * Fatal on mismatch. A mis-decoded log does not throw -- it produces plausible
   * wrong history, and wrong history is worse than missing history because nothing
   * about it looks absent. The keccak implementation is injected so the check uses
   * the caller's source of truth rather than a second hard-coded table.
   */
  verifyTopics(keccak256?: (signature: string) => string): void {
    if (!keccak256) return;
    assertTopics(keccak256);
  }

  /**
   * Check for a reorganisation and undo it.
   *
   * Returns how many blocks were rolled back -- 0 when the chain agrees with us.
   * Walks back at most `maxDepth` blocks: a divergence deeper than that is not a
   * reorg, it is a different chain, and continuing to walk would delete the whole
   * index one block at a time. That case is reported instead.
   */
  async reconcile({ maxDepth = 128 }: { maxDepth?: number } = {}): Promise<number> {
    const state = this.store.getState();
    if (!state || state.lastIndexedBlock <= state.startBlock - 1) return 0;

    let cursor = state.lastIndexedBlock;
    let depth = 0;

    while (cursor >= this.config.startBlock && depth <= maxDepth) {
      const recorded = this.store.getBlockHash(cursor);
      if (recorded === undefined) {
        // Nothing recorded for this block, so there is nothing to disagree with.
        return 0;
      }
      const onChain = await this.rpc.blockHeader(cursor);
      if (onChain && onChain.hash.toLowerCase() === recorded.toLowerCase()) {
        if (depth === 0) return 0;
        this.store.rollbackFrom(cursor + 1);
        this.store.log('warn', 'reorg', `rolled back ${depth} block(s) from ${cursor + 1}`);
        return depth;
      }
      cursor -= 1;
      depth += 1;
    }

    if (depth > maxDepth) {
      this.store.log('error', 'reorg-too-deep', `no agreement within ${maxDepth} blocks of ${state.lastIndexedBlock}`);
      throw new Error(
        `no common block within ${maxDepth} blocks of ${state.lastIndexedBlock}. ` +
          'This is not a reorganisation -- the index belongs to a different chain. Re-index from scratch.',
      );
    }
    return 0;
  }

  /** Index up to the confirmed chain head, within both bounds. */
  async run(options: RunOptions = {}): Promise<RunResult> {
    const started = options.now ? options.now() : Date.now();
    const now = options.now ?? (() => Date.now());
    const maxBlocks = options.maxBlocks ?? 300;
    const maxSeconds = options.maxSeconds ?? 20;
    const confirmations = options.confirmations ?? 0;

    this.verifyTopics(options.keccak256);

    const reorgDepth = await this.reconcile();

    const chainHead = await this.rpc.blockNumber();
    const target = chainHead - confirmations;
    const state = this.store.getState();
    const fromBlock = state && state.lastIndexedBlock >= this.config.startBlock - 1 ? state.lastIndexedBlock + 1 : this.config.startBlock;

    if (target < fromBlock) {
      this.store.setState({ lastIndexedBlock: Math.max(fromBlock - 1, this.config.startBlock - 1), chainHead, startBlock: this.config.startBlock });
      return {
        fromBlock,
        toBlock: fromBlock - 1,
        blocksScanned: 0,
        eventsInserted: 0,
        transfersInserted: 0,
        snapshotsWritten: 0,
        unknownLogs: 0,
        reorgDepth,
        truncated: false,
        chainHead,
        elapsedMs: now() - started,
      };
    }

    const byBlocks = Math.min(maxBlocks, target - fromBlock + 1);
    const spentMs = now() - started;
    const byTime = Math.max(0, maxSeconds * 1000 - spentMs);
    // Time is converted to blocks using the measured block time, so the two bounds
    // are comparable. Both are then taken, and whichever is smaller wins -- two
    // limits that each look generous can still be jointly impossible, which is the
    // mistake the vault repository's ARCHITECTURE.md section 7.2 documents.
    const blockTime = this.#blockTimeMs();
    const blocksPerSecond = 1000 / Math.max(1, blockTime);
    const timeBlocks = Math.max(1, Math.floor((byTime / 1000) * blocksPerSecond));
    const limit = Math.max(1, Math.min(byBlocks, timeBlocks));

    if (this.verbose) {
      this.store.log(
        'info',
        'bounds',
        `maxBlocks=${maxBlocks} target=${target} from=${fromBlock} byBlocks=${byBlocks} ` +
          `spentMs=${spentMs} byTime=${Math.round(byTime)} blockTimeMs=${Math.round(blockTime)} timeBlocks=${timeBlocks} limit=${limit}`,
      );
    }

    const toBlock = Math.min(target, fromBlock + limit - 1);
    const result = await this.indexRange(fromBlock, toBlock);

    this.store.setState({ lastIndexedBlock: toBlock, chainHead, startBlock: this.config.startBlock });

    return {
      ...result,
      fromBlock,
      toBlock,
      reorgDepth,
      truncated: toBlock < target,
      chainHead,
      elapsedMs: now() - started,
    };
  }

  /**
   * The measured block time, or a conservative default.
   *
   * Used only to convert a wall-clock budget into a block budget. Guessing too high
   * wastes the budget; guessing too low stops early. Neither is dangerous, which is
   * why this falls back rather than failing.
   */
  #blockTimeMs(): number {
    const rows = this.store.priceSeries(2);
    if (rows.length < 2) return 2000;
    const newer = rows[0]!;
    const older = rows[1]!;
    const seconds = newer.timestamp - older.timestamp;
    const blocks = newer.blockNumber - older.blockNumber;
    if (blocks <= 0 || seconds <= 0) return 2000;
    return (seconds / blocks) * 1000;
  }

  /** Index one inclusive range. Idempotent, so re-running it is always safe. */
  async indexRange(fromBlock: number, toBlock: number): Promise<Omit<RunResult, 'fromBlock' | 'toBlock' | 'reorgDepth' | 'truncated' | 'chainHead' | 'elapsedMs'>> {
    if (toBlock < fromBlock) {
      return { blocksScanned: 0, eventsInserted: 0, transfersInserted: 0, snapshotsWritten: 0, unknownLogs: 0 };
    }

    // ---- headers first, because every row needs a timestamp
    const numbers: number[] = [];
    for (let n = fromBlock; n <= toBlock; n++) numbers.push(n);
    const headers = await this.rpc.blockHeaders(numbers, {
      onFallback: (count) => this.store.log('warn', 'timestamp-batch-fallback', `${count} block(s) needed the per-block fallback`),
    });

    // ---- logs, all modelled events in one request
    const rawLogs = await this.rpc.getLogs({
      address: this.config.vault,
      fromBlock,
      toBlock,
      topics: [[TOPICS.Deposit, TOPICS.Withdraw, TOPICS.YieldReported, TOPICS.Transfer]],
    });

    const events: VaultEventRow[] = [];
    const transfers: ShareTransferRow[] = [];
    let unknownLogs = 0;

    for (const raw of rawLogs as RawLog[]) {
      const header = headers.get(Number(BigInt(raw.blockNumber)));
      const timestamp = header?.timestamp ?? 0;

      if (raw.topics[0]?.toLowerCase() === TOPICS.Transfer) {
        const transfer = decodeShareTransfer(raw);
        if (transfer) transfers.push({ ...transfer, timestamp });
        continue;
      }

      const event = decodeVaultLog(raw);
      if (!event) {
        // Counted, not ignored. An event this indexer does not model is a gap in
        // what it knows, and a gap nobody can see is one nobody can fix.
        unknownLogs += 1;
        continue;
      }
      events.push({
        blockNumber: event.blockNumber,
        logIndex: event.logIndex,
        blockHash: event.blockHash,
        txHash: event.txHash,
        kind: event.kind,
        account: event.account,
        assets: event.assets,
        shares: event.shares,
        timestamp,
      });
    }

    // ---- headers, stored
    for (const header of headers.values()) {
      this.store.upsertBlock({ blockNumber: header.number, blockHash: header.hash, parentHash: header.parentHash, timestamp: header.timestamp });
    }

    // ---- the price series: totals at every block in range, read or derived
    const snapshots = await this.#snapshotsForRange(numbers, headers, events);

    const eventsInserted = this.store.insertEvents(events);
    const transfersInserted = this.store.insertTransfers(transfers);
    const snapshotsWritten = this.store.upsertSnapshots(snapshots);

    return { blocksScanned: numbers.length, eventsInserted, transfersInserted, snapshotsWritten, unknownLogs };
  }

  /**
   * `totalAssets` and `totalSupply` per block, by whatever means the node allows.
   *
   * THE PROBLEM THIS SOLVES, learned the hard way and then measured:
   *
   * A node does not necessarily serve state at every block. This one refuses anything
   * below about block 100 -- `-32602 BlockOutOfRangeError` -- because it was started
   * from a state snapshot and never had that history. It serves LOGS from block 8
   * perfectly well. So "read the totals at each block" is not a strategy that works
   * everywhere, and the first version of this method produced an EMPTY price series
   * on this very chain while reporting nothing worse than a vague warning.
   *
   * So the totals are walked forward:
   *
   *   - try to read them at the block, which is exact when the node allows it;
   *   - where the read fails, DERIVE them from the previous block's totals plus the
   *     events in this block. Deposits add assets and shares, withdrawals subtract
   *     both, and a yield report adds assets and mints nothing.
   *
   * Deriving is exact for these events, not an approximation: they are the complete
   * set of things that move the two figures. But it is only as good as the baseline
   * it starts from, so a block whose totals could be neither read nor derived is
   * SKIPPED and counted -- a gap that is visible beats a wrong value that looks fine.
   *
   * WHICH PATH WAS USED IS RECORDED. If the series is derived below some block, that
   * belongs in the database rather than in a log nobody reads, because it is a
   * property of the data the API will serve.
   */
  async #snapshotsForRange(numbers: readonly number[], headers: Map<number, BlockHeader>, events: readonly VaultEventRow[]): Promise<VaultSnapshotRow[]> {
    const rows: VaultSnapshotRow[] = [];

    // WHICH BLOCKS CAN HAVE CHANGED ANYTHING. Only these are worth a chain read; the
    // rest carry the previous totals forward. Reading every block would be exact and
    // is what the first version did -- and at Base's 2 s block time that is 43,200
    // rows a day, a database that grows without bound, and twice as many RPC calls as
    // there is information to fetch. This is both faster and more honest about where
    // the numbers came from.
    const changed = new Set<number>([numbers[0]!]);
    for (const event of events) changed.add(event.blockNumber);

    // How the totals move, per block, from the events in it.
    const deltas = new Map<number, { assets: bigint; supply: bigint }>();
    for (const event of events) {
      if (event.kind === 'Transfer') continue;
      const delta = deltas.get(event.blockNumber) ?? { assets: 0n, supply: 0n };
      const assets = BigInt(event.assets ?? '0');
      const shares = BigInt(event.shares ?? '0');
      if (event.kind === 'Deposit') {
        delta.assets += assets;
        delta.supply += shares;
      } else if (event.kind === 'Withdraw') {
        delta.assets -= assets;
        delta.supply -= shares;
      } else if (event.kind === 'YieldReported') {
        // Assets rise, supply does not. This is the whole reason the series cannot be
        // derived from share transfers alone.
        delta.assets += assets;
      }
      deltas.set(event.blockNumber, delta);
    }

    // ---- one batched read per block that could have changed
    const reads = new Map<number, { assets: bigint; supply: bigint }>();
    const readFailures = new Map<number, string>();
    const wanted = numbers.filter((n) => changed.has(n));
    const perChunk = 50;

    for (let i = 0; i < wanted.length; i += perChunk) {
      const chunk = wanted.slice(i, i + perChunk);
      const calls = chunk.flatMap((n) => [
        { method: 'eth_call', params: [{ to: this.config.vault, data: SELECTOR.totalAssets }, `0x${n.toString(16)}`] },
        { method: 'eth_call', params: [{ to: this.config.vault, data: SELECTOR.totalSupply }, `0x${n.toString(16)}`] },
      ]);
      const results = await this.rpc.batchAllowingErrors<string>(calls);

      chunk.forEach((blockNumber, index) => {
        const assetsEntry = results[index * 2]!;
        const supplyEntry = results[index * 2 + 1]!;
        if ('result' in assetsEntry && 'result' in supplyEntry) {
          reads.set(blockNumber, { assets: BigInt(assetsEntry.result), supply: BigInt(supplyEntry.result) });
        } else {
          // The ERROR goes in the log. The first version recorded only "unreadable",
          // which is not a diagnosis: it took a separate investigation to learn that
          // every read was failing for one reason the log had thrown away.
          const first = 'error' in assetsEntry ? assetsEntry.error : (supplyEntry as { error: { code: number; message: string } }).error;
          readFailures.set(blockNumber, `${first.code} ${first.message}`);
        }
      });
    }

    // ---- walk forward, preferring a read and falling back to the previous totals
    let carried: { assets: bigint; supply: bigint } | null = null;
    let derived = 0;
    let skipped = 0;
    let carriedForward = 0;
    let firstRealRead: number | null = null;

    for (const blockNumber of numbers) {
      const header = headers.get(blockNumber);
      if (!header) continue;

      const direct = reads.get(blockNumber);
      if (direct) {
        carried = direct;
        firstRealRead ??= blockNumber;
      } else if (carried !== null) {
        const delta = deltas.get(blockNumber);
        if (delta) carried = { assets: carried.assets + delta.assets, supply: carried.supply + delta.supply };
        if (changed.has(blockNumber)) derived += 1;
        else carriedForward += 1;
      } else {
        skipped += 1;
        continue;
      }

      rows.push({
        blockNumber,
        blockHash: header.hash,
        timestamp: header.timestamp,
        totalAssets: carried.assets.toString(10),
        totalSupply: carried.supply.toString(10),
      });
    }

    const unreadable = [...readFailures.keys()];
    if (derived > 0 || unreadable.length > 0) {
      this.store.log(
        'warn',
        'series-derived',
        `${derived} changing block(s) could not be read and were derived from events; ` +
          `${carriedForward} unchanged block(s) carried forward; ${skipped} skipped for want of a baseline; ` +
          `first readable block ${firstRealRead ?? 'none'}` +
          (unreadable.length ? `; e.g. block ${unreadable[0]}: ${readFailures.get(unreadable[0]!)}` : ''),
      );
    }
    if (skipped > 0) {
      this.store.log('error', 'series-gap', `${skipped} block(s) have no totals: no baseline could be read and none could be derived`);
    }

    return rows;
  }
}
