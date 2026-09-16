/**
 * SQLite storage.
 *
 * THE DECISIONS, and why each one is here rather than being obvious:
 *
 *   RAW FIELDS ONLY, DERIVED VALUES AT QUERY TIME. The share price is NOT stored.
 *   `totalAssets` and `totalSupply` are, and the price is computed from them when
 *   asked. Price is a formula -- `shares * (assets + 1) / (supply + 10**offset)` --
 *   and if the formula turns out to be wrong, correct code can re-read the same
 *   rows. A stored price would freeze the mistake into the database, and the rows
 *   to detect it would no longer be present. (Same principle as the sibling
 *   `base-swap-indexer`, recorded there in its own words.)
 *
 *   `vault_snapshots` EXISTS BECAUSE THE CONTRACT HAS NO PRICE EVENT. This is the
 *   central storage decision in this file. `reportYield` raises `totalAssets`
 *   WITHOUT minting shares, so the share price changes with no event that says so --
 *   it emits `YieldReported`, which carries the amount but not the new totals.
 *   Deposits and withdrawals change both figures. So the only way to know what the
 *   price was at a given block is to record `totalAssets` and `totalSupply` as they
 *   stood after each block that changed them. A price chart built from events alone
 *   would be wrong exactly when yield was reported, which is the most interesting
 *   moment on it.
 *
 *   `block_hash` is stored so a reorganisation is detectable: if the hash recorded
 *   for a block no longer matches the chain, that block and everything after it is
 *   deleted and re-indexed.
 *
 *   IDEMPOTENCE IS STRUCTURAL. `PRIMARY KEY (block_number, log_index)` with
 *   `INSERT OR IGNORE` means re-indexing a range cannot duplicate anything. Not
 *   hoped for -- enforced by the schema, so a retry after a partial failure is
 *   always safe.
 *
 *   NO ORM. The queries here are the product: "the price series" and "recent
 *   activity" are index and query-plan decisions, and an ORM would hide exactly the
 *   part worth showing.
 *
 *   `node:sqlite`, NOT better-sqlite3. A native module needs a compiler toolchain
 *   to install, which the environment this was built in does not have -- and a
 *   reviewer needing nothing but Node is worth more than a larger API. The
 *   trade-off is real and stated: `node:sqlite` is experimental on Node 24 and
 *   prints a warning, and its API is smaller. `openStore()` is the only place the
 *   driver is chosen, so changing that is a contained edit.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** One vault event, whatever kind. `payload` is JSON of the kind-specific fields. */
export interface VaultEventRow {
  blockNumber: number;
  logIndex: number;
  blockHash: string;
  txHash: string;
  /** Which event: Deposit | Withdraw | YieldReported. */
  kind: string;
  /** The account the event is about, where it has one. */
  account: string | null;
  /** Raw uint256 values as DECIMAL STRINGS -- they do not fit a JS number. */
  assets: string | null;
  shares: string | null;
  timestamp: number;
}

export interface ShareTransferRow {
  blockNumber: number;
  logIndex: number;
  blockHash: string;
  txHash: string;
  from: string;
  to: string;
  /** uint256 as a decimal string. */
  value: string;
  timestamp: number;
}

export interface BlockRow {
  blockNumber: number;
  blockHash: string;
  parentHash: string;
  timestamp: number;
}

/** totalAssets and totalSupply as they stood after a given block. */
export interface VaultSnapshotRow {
  blockNumber: number;
  blockHash: string;
  timestamp: number;
  totalAssets: string;
  totalSupply: string;
}

export interface IndexerState {
  lastIndexedBlock: number;
  chainHeadAtLastRun: number;
  updatedAt: number;
  /** Where the vault was deployed. The first block an indexer may not skip. */
  startBlock: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vault_events (
  block_number INTEGER NOT NULL,
  log_index    INTEGER NOT NULL,
  block_hash   TEXT    NOT NULL,
  tx_hash      TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  account      TEXT,
  assets       TEXT,              -- uint256, decimal string
  shares       TEXT,              -- uint256, decimal string
  timestamp    INTEGER NOT NULL,
  PRIMARY KEY (block_number, log_index)
);

-- The chart asks for a time range; the activity list asks for the latest few.
-- Both are served by an ordered scan, so the ordering is the access path that
-- matters and both directions get an index.
CREATE INDEX IF NOT EXISTS idx_events_block     ON vault_events (block_number DESC);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON vault_events (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_account   ON vault_events (account);

CREATE TABLE IF NOT EXISTS share_transfers (
  block_number INTEGER NOT NULL,
  log_index    INTEGER NOT NULL,
  block_hash   TEXT    NOT NULL,
  tx_hash      TEXT    NOT NULL,
  from_address TEXT    NOT NULL,
  to_address   TEXT    NOT NULL,
  value        TEXT    NOT NULL,  -- uint256, decimal string
  timestamp    INTEGER NOT NULL,
  PRIMARY KEY (block_number, log_index)
);

CREATE INDEX IF NOT EXISTS idx_transfers_block ON share_transfers (block_number DESC);
-- "who holds shares" and "what did this account do" both filter by address.
CREATE INDEX IF NOT EXISTS idx_transfers_from  ON share_transfers (from_address);
CREATE INDEX IF NOT EXISTS idx_transfers_to    ON share_transfers (to_address);

-- The price series. One row per block that changed the vault's totals, plus one at
-- the deployment block so the series has a starting point. See the note at the top
-- of this file for why this table has to exist at all.
CREATE TABLE IF NOT EXISTS vault_snapshots (
  block_number INTEGER PRIMARY KEY,
  block_hash   TEXT    NOT NULL,
  timestamp    INTEGER NOT NULL,
  total_assets TEXT    NOT NULL,  -- uint256, decimal string
  total_supply TEXT    NOT NULL   -- uint256, decimal string
);

CREATE TABLE IF NOT EXISTS blocks (
  block_number INTEGER PRIMARY KEY,
  block_hash   TEXT NOT NULL,
  parent_hash  TEXT NOT NULL,
  timestamp    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS indexer_state (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  last_indexed_block     INTEGER NOT NULL,
  chain_head_at_last_run INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  start_block            INTEGER NOT NULL
);

-- Append-only, so a reviewer can see what the indexer actually did, including
-- every reorganisation it recovered from. A log that can be edited is not evidence.
CREATE TABLE IF NOT EXISTS indexer_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  level  TEXT    NOT NULL,
  event  TEXT    NOT NULL,
  detail TEXT
);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(path);
    // WAL keeps a reader from blocking the indexer's writes; the API reads the same
    // file while a cron run writes it.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
  }

  /**
   * Run `fn` in a transaction.
   *
   * Hand-written because `node:sqlite` has no transaction helper, and being
   * explicit makes the rollback path visible -- which matters because a
   * half-written block is the corruption this service must never produce.
   */
  private txn<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ------------------------------------------------------------------ writes

  /** Insert vault events. Idempotent: re-running a range changes nothing. */
  insertEvents(rows: readonly VaultEventRow[]): number {
    if (rows.length === 0) return 0;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO vault_events
        (block_number, log_index, block_hash, tx_hash, kind, account, assets, shares, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return this.txn(() => {
      let inserted = 0;
      for (const r of rows) {
        inserted += Number(
          stmt.run(r.blockNumber, r.logIndex, r.blockHash, r.txHash, r.kind, r.account, r.assets, r.shares, r.timestamp).changes,
        );
      }
      return inserted;
    });
  }

  insertTransfers(rows: readonly ShareTransferRow[]): number {
    if (rows.length === 0) return 0;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO share_transfers
        (block_number, log_index, block_hash, tx_hash, from_address, to_address, value, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return this.txn(() => {
      let inserted = 0;
      for (const r of rows) {
        inserted += Number(
          stmt.run(r.blockNumber, r.logIndex, r.blockHash, r.txHash, r.from.toLowerCase(), r.to.toLowerCase(), r.value, r.timestamp).changes,
        );
      }
      return inserted;
    });
  }

  /** Record totals after a block. The last write for a block wins, which is correct. */
  upsertSnapshots(rows: readonly VaultSnapshotRow[]): number {
    if (rows.length === 0) return 0;
    const stmt = this.db.prepare(`
      INSERT INTO vault_snapshots (block_number, block_hash, timestamp, total_assets, total_supply)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(block_number) DO UPDATE SET
        block_hash   = excluded.block_hash,
        timestamp    = excluded.timestamp,
        total_assets = excluded.total_assets,
        total_supply = excluded.total_supply
    `);
    return this.txn(() => {
      for (const r of rows) {
        stmt.run(r.blockNumber, r.blockHash, r.timestamp, r.totalAssets, r.totalSupply);
      }
      return rows.length;
    });
  }

  upsertBlock(b: BlockRow): void {
    this.db
      .prepare(
        `INSERT INTO blocks (block_number, block_hash, parent_hash, timestamp)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(block_number) DO UPDATE SET
           block_hash  = excluded.block_hash,
           parent_hash = excluded.parent_hash,
           timestamp   = excluded.timestamp`,
      )
      .run(b.blockNumber, b.blockHash, b.parentHash, b.timestamp);
  }

  /**
   * Delete everything at or after a block.
   *
   * Every table with a block number is included. A reorg that removed events but
   * left snapshots behind would produce a price series that disagrees with the
   * events beside it, which is worse than either one being stale.
   */
  rollbackFrom(blockNumber: number): { events: number; transfers: number; snapshots: number; blocks: number } {
    return this.txn(() => ({
      events: Number(this.db.prepare('DELETE FROM vault_events WHERE block_number >= ?').run(blockNumber).changes),
      transfers: Number(this.db.prepare('DELETE FROM share_transfers WHERE block_number >= ?').run(blockNumber).changes),
      snapshots: Number(this.db.prepare('DELETE FROM vault_snapshots WHERE block_number >= ?').run(blockNumber).changes),
      blocks: Number(this.db.prepare('DELETE FROM blocks WHERE block_number >= ?').run(blockNumber).changes),
    }));
  }

  setState(state: { lastIndexedBlock: number; chainHead: number; startBlock: number }): void {
    this.db
      .prepare(
        `INSERT INTO indexer_state (id, last_indexed_block, chain_head_at_last_run, updated_at, start_block)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           last_indexed_block     = excluded.last_indexed_block,
           chain_head_at_last_run = excluded.chain_head_at_last_run,
           updated_at             = excluded.updated_at,
           start_block            = excluded.start_block`,
      )
      .run(state.lastIndexedBlock, state.chainHead, Date.now(), state.startBlock);
  }

  log(level: 'info' | 'warn' | 'error', event: string, detail?: string): void {
    this.db.prepare('INSERT INTO indexer_log (ts, level, event, detail) VALUES (?, ?, ?, ?)').run(Date.now(), level, event, detail ?? null);
  }

  // ------------------------------------------------------------------- reads

  getState(): IndexerState | undefined {
    const row = this.db
      .prepare('SELECT last_indexed_block, chain_head_at_last_run, updated_at, start_block FROM indexer_state WHERE id = 1')
      .get() as { last_indexed_block: number; chain_head_at_last_run: number; updated_at: number; start_block: number } | undefined;
    if (!row) return undefined;
    return {
      lastIndexedBlock: row.last_indexed_block,
      chainHeadAtLastRun: row.chain_head_at_last_run,
      updatedAt: row.updated_at,
      startBlock: row.start_block,
    };
  }

  getBlockHash(blockNumber: number): string | undefined {
    const row = this.db.prepare('SELECT block_hash FROM blocks WHERE block_number = ?').get(blockNumber) as { block_hash: string } | undefined;
    return row?.block_hash;
  }

  countEvents(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM vault_events').get() as { n: number }).n;
  }

  countSnapshots(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM vault_snapshots').get() as { n: number }).n;
  }

  /**
   * The price series, newest first.
   *
   * Returns RAW totals, not a price. The caller computes it, which is the decision
   * at the top of this file: a formula that turns out to be wrong can be fixed
   * against the same rows.
   *
   * The columns are ALIASED to camelCase in the SQL rather than mapped afterwards.
   * A `as unknown as VaultSnapshotRow[]` cast was the first version and it lied: the
   * rows came back with snake_case keys, the type said otherwise, and the mistake
   * only appeared at the call site as `Cannot convert undefined to a BigInt`.
   * Aliasing makes the query produce the declared shape, so the cast is honest.
   */
  priceSeries(limit: number): VaultSnapshotRow[] {
    return this.db
      .prepare(
        `SELECT block_number AS blockNumber,
                block_hash   AS blockHash,
                timestamp,
                total_assets AS totalAssets,
                total_supply AS totalSupply
         FROM vault_snapshots
         ORDER BY block_number DESC
         LIMIT ?`,
      )
      .all(limit) as unknown as VaultSnapshotRow[];
  }

  /**
   * The earliest block the price series covers.
   *
   * THIS IS NOT COSMETIC. A node does not necessarily serve state at every block --
   * the one this was developed against refuses anything below about block 100 because
   * it was started from a state snapshot and never had that history. So the series
   * can begin LATER than the vault was deployed, and a chart drawn without saying so
   * would imply the vault did nothing for those blocks rather than that nothing is
   * known about them.
   *
   * The API reports this, and the page is expected to say it too.
   */
  seriesFromBlock(): number | null {
    const row = this.db.prepare('SELECT MIN(block_number) AS m FROM vault_snapshots').get() as { m: number | null };
    return row.m;
  }

  /** The earliest block any event is recorded at, for the same reason. */
  eventsFromBlock(): number | null {
    const row = this.db.prepare('SELECT MIN(block_number) AS m FROM vault_events').get() as { m: number | null };
    return row.m;
  }

  close(): void {
    this.db.close();
  }
}

/** Open the store. The only place the SQLite driver is chosen. */
export function openStore(path: string): Store {
  return new Store(path);
}
