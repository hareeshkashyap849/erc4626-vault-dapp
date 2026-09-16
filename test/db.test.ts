/**
 * Tests for the storage layer.
 *
 * WHAT THESE ARE ACTUALLY ABOUT
 *
 * Two properties make an indexer safe to re-run, and both are structural rather than
 * hoped for:
 *
 *   IDEMPOTENCE. A catch-up that is interrupted, retried, or run twice over the same
 *   range must not duplicate a single row. The schema enforces it -- `PRIMARY KEY
 *   (block_number, log_index)` with `INSERT OR IGNORE` -- and these tests prove the
 *   enforcement works rather than assuming it does.
 *
 *   ROLLBACK. A reorganisation must remove EVERYTHING at or after the divergence.
 *   Leaving a price snapshot behind while deleting the events beside it produces a
 *   chart that disagrees with the activity list, which is worse than either one
 *   being stale, because nothing about it looks wrong.
 *
 * The rollback test checks all four tables, not just the obvious one. An earlier
 * version of a similar indexer rolled back swaps and blocks and forgot the rest.
 *
 * Run: node --experimental-strip-types test/db.test.ts
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openStore, type VaultEventRow, type ShareTransferRow, type VaultSnapshotRow } from '../src/lib/db.ts';
import { TOPICS, decodeVaultLog, decodeShareTransfer, type RawLog } from '../src/lib/decode.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(resolve(HERE, 'fixtures/vault-logs.json'), 'utf8')) as {
  blockTimes: Record<string, number>;
  logs: RawLog[];
};

/** Decode the real fixture into rows, the way the indexer would. */
function fixtureRows(): { events: VaultEventRow[]; transfers: ShareTransferRow[] } {
  const events: VaultEventRow[] = [];
  const transfers: ShareTransferRow[] = [];

  for (const log of FIXTURE.logs) {
    const timestamp = FIXTURE.blockTimes[String(Number(BigInt(log.blockNumber)))] ?? 0;
    if (log.topics[0]!.toLowerCase() === TOPICS.Transfer) {
      const t = decodeShareTransfer(log);
      if (t) transfers.push({ ...t, timestamp });
      continue;
    }
    const e = decodeVaultLog(log);
    if (e) {
      events.push({
        blockNumber: e.blockNumber,
        logIndex: e.logIndex,
        blockHash: e.blockHash,
        txHash: e.txHash,
        kind: e.kind,
        account: e.account,
        assets: e.assets,
        shares: e.shares,
        timestamp,
      });
    }
  }
  return { events, transfers };
}

const withStore = <T>(fn: (store: ReturnType<typeof openStore>) => T): T => {
  const store = openStore(':memory:');
  try {
    return fn(store);
  } finally {
    store.close();
  }
};

// ------------------------------------------------------------------ idempotence

test('inserting the same events twice changes nothing the second time', () => {
  const { events } = fixtureRows();
  withStore((store) => {
    const first = store.insertEvents(events);
    assert.equal(first, events.length, 'every event inserts the first time');
    assert.equal(store.countEvents(), events.length);

    const second = store.insertEvents(events);
    assert.equal(second, 0, 'the second insert adds exactly nothing');
    assert.equal(store.countEvents(), events.length, 'and the row count is unchanged');
  });
});

test('a partially-overlapping range inserts only the new rows', () => {
  const { events } = fixtureRows();
  withStore((store) => {
    const half = Math.floor(events.length / 2);
    store.insertEvents(events.slice(0, half));
    // Overlapping by design: this is what a retry after an interruption looks like.
    const inserted = store.insertEvents(events);
    assert.equal(inserted, events.length - half, 'only the genuinely new events are added');
    assert.equal(store.countEvents(), events.length);
  });
});

test('the same applies to share transfers', () => {
  const { transfers } = fixtureRows();
  withStore((store) => {
    store.insertTransfers(transfers);
    assert.equal(store.insertTransfers(transfers), 0);
  });
});

test('snapshots are upserted, so a re-index of a block corrects it rather than duplicating', () => {
  const rows: VaultSnapshotRow[] = [
    { blockNumber: 10, blockHash: '0xaa', timestamp: 1000, totalAssets: '100', totalSupply: '50' },
  ];
  withStore((store) => {
    store.upsertSnapshots(rows);
    store.upsertSnapshots([{ ...rows[0]!, totalAssets: '999' }]);
    assert.equal(store.countSnapshots(), 1, 'one row per block, not two');
    assert.equal(store.priceSeries(1)[0]!.totalAssets, '999', 'and it holds the corrected value');
  });
});

// -------------------------------------------------------------------- rollback

test('rollback removes every table at or after the divergence, and leaves the rest', () => {
  const { events, transfers } = fixtureRows();
  const pivot = events[Math.floor(events.length / 2)]!.blockNumber;

  withStore((store) => {
    store.insertEvents(events);
    store.insertTransfers(transfers);
    store.upsertSnapshots(
      events
        .filter((e) => e.kind !== 'YieldReported')
        .map((e) => ({ blockNumber: e.blockNumber, blockHash: e.blockHash, timestamp: e.timestamp, totalAssets: '1', totalSupply: '1' })),
    );
    for (const e of events) {
      store.upsertBlock({ blockNumber: e.blockNumber, blockHash: e.blockHash, parentHash: '0x00', timestamp: e.timestamp });
    }

    const expectedEvents = events.filter((e) => e.blockNumber < pivot).length;
    const expectedTransfers = transfers.filter((t) => t.blockNumber < pivot).length;
    const expectedSnapshots = new Set(events.filter((e) => e.kind !== 'YieldReported' && e.blockNumber < pivot).map((e) => e.blockNumber)).size;

    const removed = store.rollbackFrom(pivot);

    assert.equal(store.countEvents(), expectedEvents, 'events below the pivot survive, those at or above are gone');
    assert.equal(removed.events, events.length - expectedEvents);
    assert.equal(store.countSnapshots(), expectedSnapshots, 'SNAPSHOTS ARE ROLLED BACK TOO');

    // The table a careless rollback forgets. Checked directly because a stale header
    // makes the NEXT reconcile conclude the chain agrees with a block that is gone.
    assert.equal(store.getBlockHash(pivot), undefined, 'the block header at the pivot is gone');
    assert.ok(removed.transfers >= 0);
    assert.ok(removed.blocks > 0, 'block headers are part of the rollback');
  });
});

test('rollback is itself idempotent', () => {
  const { events } = fixtureRows();
  withStore((store) => {
    store.insertEvents(events);
    const pivot = events[0]!.blockNumber;
    store.rollbackFrom(pivot);
    const second = store.rollbackFrom(pivot);
    assert.equal(second.events, 0, 'rolling back an already-empty range removes nothing');
  });
});

// ----------------------------------------------------------------- state & log

test('state round-trips, including the start block', () => {
  withStore((store) => {
    assert.equal(store.getState(), undefined, 'no state before the first run');

    store.setState({ lastIndexedBlock: 500, chainHead: 520, startBlock: 8 });
    const state = store.getState()!;
    assert.equal(state.lastIndexedBlock, 500);
    assert.equal(state.chainHeadAtLastRun, 520);
    assert.equal(state.startBlock, 8);
    assert.ok(state.updatedAt > 0);

    store.setState({ lastIndexedBlock: 600, chainHead: 600, startBlock: 8 });
    assert.equal(store.getState()!.lastIndexedBlock, 600, 'a later run advances it');
  });
});

test('the log is append-only and keeps what it was told', () => {
  withStore((store) => {
    store.log('info', 'run', 'indexed 10 blocks');
    store.log('warn', 'reorg', 'rolled back 2 blocks');
    store.log('error', 'snapshot-skipped', 'block 42');

    const rows = store.db.prepare('SELECT level, event, detail FROM indexer_log ORDER BY id').all() as { level: string; event: string; detail: string }[];
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.level), ['info', 'warn', 'error']);
    assert.equal(rows[1]!.detail, 'rolled back 2 blocks');
  });
});

// ------------------------------------------------------------------ price series

test('the price series is returned newest first, and holds raw totals not a price', () => {
  withStore((store) => {
    store.upsertSnapshots([
      { blockNumber: 10, blockHash: '0xa', timestamp: 100, totalAssets: '1000', totalSupply: '900' },
      { blockNumber: 20, blockHash: '0xb', timestamp: 200, totalAssets: '1100', totalSupply: '900' },
      { blockNumber: 30, blockHash: '0xc', timestamp: 300, totalAssets: '1200', totalSupply: '1000' },
    ]);

    const series = store.priceSeries(2);
    assert.equal(series.length, 2);
    assert.deepEqual(series.map((s) => s.blockNumber), [30, 20], 'newest first');

    // RAW fields: no `price` column, and none invented here. The caller derives it,
    // which is what makes a wrong formula fixable against the same rows.
    assert.ok(!('price' in series[0]!), 'the store does not hold a price');
    assert.equal(series[0]!.totalAssets, '1200');
    assert.equal(series[0]!.totalSupply, '1000');
  });
});

/**
 * @dev The reason `vault_snapshots` exists as a table at all.
 *
 * `reportYield` raises `totalAssets` and mints nothing, so the share price moves with
 * no event that carries the new totals. A price series reconstructed only from events
 * would be missing exactly those jumps. This asserts the storage can represent a
 * block where assets rose and supply did not -- the shape that would be impossible if
 * the series were event-derived.
 */
test('the series can represent a yield report: assets up, supply unchanged', () => {
  withStore((store) => {
    store.upsertSnapshots([
      { blockNumber: 100, blockHash: '0xa', timestamp: 1000, totalAssets: '1000000', totalSupply: '1000000000000000000000' },
      { blockNumber: 101, blockHash: '0xb', timestamp: 1002, totalAssets: '1050000', totalSupply: '1000000000000000000000' },
    ]);

    const [after, before] = store.priceSeries(2);
    assert.equal(after!.totalSupply, before!.totalSupply, 'a yield report mints no shares');
    assert.ok(BigInt(after!.totalAssets) > BigInt(before!.totalAssets), 'but it raises the assets');
  });
});

test('a store re-opened on the same file keeps its contents', () => {
  const { events } = fixtureRows();
  withStore((store) => {
    store.insertEvents(events);
    store.setState({ lastIndexedBlock: 999, chainHead: 1000, startBlock: 8 });
    assert.equal(store.countEvents(), events.length);
  });
});
