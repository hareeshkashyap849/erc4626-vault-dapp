/**
 * Tests for the query API.
 *
 * THE REAL HANDLER, A REAL STORE, AND REAL LOGS
 *
 * Nothing here is a mock of this project's own code. The handler under test is the
 * one the CLI starts; the store is a real SQLite database (in memory) built by the
 * real `Store` methods; and the rows in it are decoded from
 * `test/fixtures/vault-logs.json` -- logs captured from a chain by
 * `tools/capture-fixture.ts`, decoded exactly the way `test/db.test.ts` decodes them.
 *
 * The three things these tests are actually about:
 *
 *   THE PRICE IS THE RIGHT PRICE. `/api/price` is checked against
 *   `sharePrice()` recomputed independently in the test from the same raw totals, so
 *   the endpoint is checked rather than the endpoint's own arithmetic being trusted.
 *
 *   A GAP IN THE DATA IS NOT A FACT ABOUT THE VAULT. The node this was developed
 *   against refuses `eth_call` below about block 100, so the series can begin later
 *   than the deployment block while `eth_getLogs` still works from block 8. A chart
 *   drawn without saying so reads as "the vault did nothing for those blocks". The
 *   coverage assertions below exist so that wording cannot be quietly dropped.
 *
 *   BAD INPUT IS REFUSED, NOT DEFAULTED. `?limit=abc` is a 400 that names the
 *   parameter. The tempting `Number(...) || 50` would answer a question the client got
 *   wrong, with the answer to a different one, and say nothing.
 *
 * Run: node --experimental-strip-types test/api.test.ts
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

import { openStore, type Store, type VaultEventRow, type ShareTransferRow, type VaultSnapshotRow } from '../src/lib/db.ts';
import { TOPICS, decodeVaultLog, decodeShareTransfer, type RawLog } from '../src/lib/decode.ts';
import { createServer, LIMITS, type ApiServerConfig, type Logger, type ServerOptions } from '../src/api/server.ts';
import { sharePrice } from '../src/api/price.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(resolve(HERE, 'fixtures/vault-logs.json'), 'utf8')) as {
  chainId: number;
  vault: string;
  asset: string;
  fromBlock: number;
  toBlock: number;
  blockTimes: Record<string, number>;
  logs: RawLog[];
};

/** The decimals the price needs. 6-decimal asset, 18-decimal shares, so offset 12. */
const DECIMALS = { assetDecimals: 6, shareDecimals: 18 } as const;

const CONFIG: ApiServerConfig = {
  chainId: FIXTURE.chainId,
  vault: FIXTURE.vault,
  asset: FIXTURE.asset,
  decimals: DECIMALS,
};

// -------------------------------------------------------------- fixture to store

/** Decode the real fixture into rows, the way `test/db.test.ts` does. */
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

const { events: FIXTURE_EVENTS, transfers: FIXTURE_TRANSFERS } = fixtureRows();

/**
 * One snapshot per block that produced an event, with the real block hash and
 * timestamp from the fixture.
 *
 * The totals themselves are synthetic and that is stated rather than hidden: the
 * fixture holds logs, not `eth_call` results, so there is no captured `totalAssets` or
 * `totalSupply` in it. They are derived from the running sum of the events, which is
 * what a vault's totals do -- deposits add to both, withdrawals subtract from both --
 * offset by a base deposit so the series starts at a plausible share price. What is
 * being tested is the API's arithmetic and its wording, both of which are indifferent
 * to whether these particular numbers came off a chain.
 */
function fixtureSnapshots(events: readonly VaultEventRow[]): VaultSnapshotRow[] {
  const byBlock = new Map<number, VaultEventRow>();
  for (const event of events) if (!byBlock.has(event.blockNumber)) byBlock.set(event.blockNumber, event);

  let assets = 1_000_000_000n; // 1000 asset units
  let supply = 1_000_000_000_000_000_000_000n; // 1000 shares

  return [...byBlock.values()]
    .sort((a, b) => a.blockNumber - b.blockNumber)
    .map((event) => {
      if (event.kind === 'Deposit' || event.kind === 'Withdraw') {
        // Deposits add to both totals, withdrawals subtract from both. A deposit that
        // ADDED to the supply would make the series rise where the events say it fell,
        // and the two would disagree in a way this file would then be asserting.
        const direction = event.kind === 'Deposit' ? 1n : -1n;
        if (event.assets) assets += direction * BigInt(event.assets);
        if (event.shares) supply += direction * BigInt(event.shares);
      }
      if (event.kind === 'YieldReported' && event.assets) assets += BigInt(event.assets);
      return {
        blockNumber: event.blockNumber,
        blockHash: event.blockHash,
        timestamp: event.timestamp,
        totalAssets: assets.toString(),
        totalSupply: supply.toString(),
      };
    });
}

const FIRST_SNAPSHOT_BLOCK = Math.min(...FIXTURE_EVENTS.map((e) => e.blockNumber));
const LAST_EVENT_BLOCK = Math.max(...FIXTURE_EVENTS.map((e) => e.blockNumber));
const CHAIN_HEAD = LAST_EVENT_BLOCK + 20;

/**
 * A store holding the fixture, indexed from the deployment block.
 *
 * `startBlock` is the deployment block the fixture was captured from (8). The series
 * still begins later than that, at the first block that produced an event (35), because
 * `vault_snapshots` only holds the blocks the indexer could read totals at -- so the
 * coverage gap is present in the real data and needs no simulation. `snapshotsFrom`
 * builds the more extreme version of the same thing, which is what a node that refuses
 * `eth_call` below some block produces. The events are untouched by it, because that
 * asymmetry is exactly what the two coverage fields exist to describe.
 */
function loadedStore({ startBlock = FIXTURE.fromBlock, snapshotsFrom }: { startBlock?: number; snapshotsFrom?: number } = {}): Store {
  const store = openStore(':memory:');
  store.insertEvents(FIXTURE_EVENTS);
  store.insertTransfers(FIXTURE_TRANSFERS);
  const snapshots = fixtureSnapshots(FIXTURE_EVENTS).filter((s) => snapshotsFrom === undefined || s.blockNumber >= snapshotsFrom);
  store.upsertSnapshots(snapshots);
  store.setState({ lastIndexedBlock: LAST_EVENT_BLOCK, chainHead: CHAIN_HEAD, startBlock });
  return store;
}

/** A store with nothing in it -- a database the indexer has never written to. */
function emptyStore(): Store {
  return openStore(':memory:');
}

// ------------------------------------------------------------------ HTTP driving

/** Captures what the handler logged, so the no-stack-trace rule can be checked. */
function recordingLogger(): Logger & { errors: { message: string; err: unknown }[] } {
  const errors: { message: string; err: unknown }[] = [];
  return {
    errors,
    info: () => {},
    error: (message, err) => errors.push({ message, err }),
  };
}

/**
 * The real server over a real socket on a kernel-assigned port.
 *
 * A socket rather than a direct call to the handler because the response is part of
 * the contract: status codes, `cache-control` and a JSON body parsed by a client. The
 * handler is exercised through `node:http`, which is the code path production uses.
 */
async function withServer<T>(options: ServerOptions, fn: (base: string) => Promise<T>): Promise<T> {
  const server = createServer({ ...options, port: 0 });
  await new Promise<void>((ready, failed) => {
    server.once('error', failed);
    server.listen(0, '127.0.0.1', () => ready());
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((closed) => server.close(() => closed()));
  }
}

interface Response {
  status: number;
  headers: Headers;
  body: any;
}

async function get(base: string, path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    // A body that is not JSON is a failure worth reporting as itself, not as a
    // confusing undefined-property error three assertions later.
    assert.fail(`GET ${path} returned a non-JSON body: ${text.slice(0, 200)}`);
  }
  return { status: response.status, headers: response.headers, body };
}

// ------------------------------------------------------------- the fixture itself

test('the fixture decodes to the events the other tests assert against', () => {
  // Guarding the guards: every number below is asserted against a body, and if the
  // fixture changed shape these counts would be the first thing to move. The transfer
  // count is DERIVED from the fixture rather than typed in, because the fixture is a
  // capture: it is re-taken from a chain, its length moves with the chain, and a
  // hard-coded number beside it would fail for a reason that is not a bug. What must
  // hold is that every Transfer topic in the file decoded, and that is what is checked.
  const transferLogs = FIXTURE.logs.filter((log) => log.topics[0]!.toLowerCase() === TOPICS.Transfer);
  assert.equal(FIXTURE_TRANSFERS.length, transferLogs.length, 'every Transfer log in the capture decoded to a row');
  assert.ok(transferLogs.length > 0, 'and there were some, so the comparison means something');
  assert.equal(FIXTURE_EVENTS.length, FIXTURE.logs.length - transferLogs.length, 'and every other log was a vault event');
  assert.deepEqual(
    [...new Set(FIXTURE_EVENTS.map((e) => e.kind))].sort(),
    ['Deposit', 'Withdraw', 'YieldReported'],
    'all three modelled kinds are present, so the filter test has something to filter',
  );
  assert.ok(
    FIXTURE_EVENTS.some((e) => e.kind === 'YieldReported'),
    'the fixture contains a yield report, which is the event the price chart exists to show',
  );
});

// ------------------------------------------------------------------- /api/status

test('status reports the chain, the range and a derived staleness', async () => {
  const store = loadedStore();
  const logger = recordingLogger();
  // A clock pinned just past the last write, so `staleSeconds` is a number the test
  // chose rather than one that depends on how fast the suite runs.
  const updatedAt = store.getState()!.updatedAt;
  const now = () => updatedAt + 90_000;

  try {
    await withServer({ store, config: CONFIG, logger, now }, async (base) => {
      const { status, headers, body } = await get(base, '/api/status');

      assert.equal(status, 200);
      assert.match(headers.get('content-type') ?? '', /application\/json/);
      assert.equal(headers.get('cache-control'), 'no-store', 'a cached index response describes a state that has moved on');

      assert.equal(body.healthy, true);
      assert.equal(body.chainId, FIXTURE.chainId);
      assert.equal(body.vault, FIXTURE.vault);
      assert.equal(body.asset, FIXTURE.asset);
      assert.equal(body.startBlock, FIXTURE.fromBlock);
      assert.equal(body.lastIndexedBlock, LAST_EVENT_BLOCK);
      assert.equal(body.chainHeadAtLastRun, CHAIN_HEAD);
      assert.equal(body.lagBlocks, CHAIN_HEAD - LAST_EVENT_BLOCK, 'the gap left by the last run');
      assert.equal(body.eventCount, FIXTURE_EVENTS.length);
      assert.equal(body.snapshotCount, new Set(FIXTURE_EVENTS.map((e) => e.blockNumber)).size, 'one snapshot per block that changed the totals');
      assert.equal(body.updatedAt, new Date(updatedAt).toISOString());
      assert.equal(body.staleSeconds, 90, 'derived from updatedAt against the injected clock');
    });
  } finally {
    store.close();
  }
});

test('status says a service that has never run is NOT healthy', async () => {
  const store = emptyStore();
  try {
    await withServer({ store, config: CONFIG }, async (base) => {
      const { status, body } = await get(base, '/api/status');
      assert.equal(status, 200, 'an unindexed database is a reportable state, not an error');
      assert.equal(body.healthy, false, 'nothing has been indexed, so this service knows nothing about the chain');
      assert.equal(body.eventCount, 0);
      assert.equal(body.snapshotCount, 0);
      assert.equal(body.updatedAt, null);
      assert.equal(body.staleSeconds, 0);
      assert.equal(body.seriesFromBlock, null, 'null, not 0: the series is empty, it does not start at block 0');
      assert.equal(body.eventsFromBlock, null);
    });
  } finally {
    store.close();
  }
});

test('status carries both earliest-covered blocks, because a late start is not an idle vault', async () => {
  const store = loadedStore();
  try {
    await withServer({ store, config: CONFIG }, async (base) => {
      const { body } = await get(base, '/api/status');
      assert.equal(body.seriesFromBlock, FIRST_SNAPSHOT_BLOCK);
      assert.equal(body.eventsFromBlock, FIRST_SNAPSHOT_BLOCK, 'the fixture has no events the snapshots do not cover');
      assert.equal(body.coverage.vaultStartBlock, FIXTURE.fromBlock);

      // And the API is right to flag this, because it is true of the real capture: the
      // vault was deployed at block 8 and the first event it emitted is at block 35.
      // The 27 blocks in between are not a quiet period -- they are blocks this service
      // has no rows for, and the note says so. An earlier version of this test asserted
      // the opposite (that the series begins at deployment) and was simply wrong about
      // its own fixture.
      assert.ok(FIRST_SNAPSHOT_BLOCK > FIXTURE.fromBlock, 'the capture really does start after the deployment block');
      assert.equal(body.coverage.startsLaterThanDeployment, true);
      assert.match(body.coverage.note, /NOTHING IS KNOWN/);
    });
  } finally {
    store.close();
  }
});

// -------------------------------------------------------------------- /api/price

test('the price series is oldest first and every point is priced from its stored totals', async () => {
  const store = loadedStore();
  const snapshots = fixtureSnapshots(FIXTURE_EVENTS);
  try {
    await withServer({ store, config: CONFIG }, async (base) => {
      const { status, headers, body } = await get(base, '/api/price');

      assert.equal(status, 200);
      assert.equal(headers.get('cache-control'), 'no-store');
      assert.equal(body.decimals.asset, 6);
      assert.equal(body.decimals.share, 18);
      assert.equal(body.count, snapshots.length);
      assert.equal(body.limit, LIMITS.price.fallback, 'the documented default, and it is the cap-limited one');

      const blocks = body.series.map((point: any) => point.blockNumber);
      assert.deepEqual(blocks, [...blocks].sort((a: number, b: number) => a - b), 'a chart reads left to right through time');
      assert.deepEqual(blocks, snapshots.map((s) => s.blockNumber));

      // The endpoint's arithmetic against the module's, recomputed here from the same
      // stored totals. The test does not take the response's word for the price.
      const expected = snapshots.map((s) =>
        sharePrice({ totalAssets: s.totalAssets, totalSupply: s.totalSupply, assetDecimals: 6, shareDecimals: 18 }),
      );
      assert.deepEqual(body.series.map((point: any) => point.price), expected);

      // The raw totals travel with the price, so a consumer can check the derivation
      // rather than trusting it -- which is the reason the database stores them.
      assert.equal(body.series[0].totalAssets, snapshots[0]!.totalAssets);
      assert.equal(body.series[0].totalSupply, snapshots[0]!.totalSupply);
      assert.ok(body.series.every((point: any) => point.price !== undefined), 'no point is missing a price key');
    });
  } finally {
    store.close();
  }
});

test('the price note states that the prices are derived and tied to their block', async () => {
  const store = loadedStore();
  try {
    await withServer({ store, config: CONFIG }, async (base) => {
      const { body } = await get(base, '/api/price');
      const note: string = body.note;

      assert.match(note, /DERIVED ON READ/);
      assert.match(note, /not the price at any instant other than the block they were read at/);
      assert.match(note, /null where totalSupply was 0/, 'the empty-vault rule is stated where the nulls are');
      assert.ok(note.length > 100, 'a note short enough to be decoration would not survive review');
    });
  } finally {
    store.close();
  }
});

test('limit is honoured and capped, so no request can dump the table', async () => {
  const store = loadedStore();
  const snapshotCount = new Set(FIXTURE_EVENTS.map((e) => e.blockNumber)).size;
  try {
    await withServer({ store, config: CONFIG }, async (base) => {
      const one = await get(base, '/api/price?limit=1');
      assert.equal(one.status, 200);
      assert.equal(one.body.series.length, 1);
      assert.equal(one.body.limit, 1);

      // Newest first from the store, then reversed for the chart -- so a limit of 1 is
      // the LATEST point, not the first.
      assert.equal(one.body.series[0].blockNumber, LAST_EVENT_BLOCK);

      const everything = await get(base, `/api/price?limit=${snapshotCount}`);
      assert.equal(everything.body.series.length, snapshotCount);

      // The cap, requested absurdly and off the top of the range entirely.
      const capped = await get(base, '/api/price?limit=99999999');
      assert.equal(capped.status, 200);
      assert.equal(capped.body.limit, LIMITS.price.max, 'clamped to the cap before it reaches SQL');
      assert.ok(capped.body.series.length <= LIMITS.price.max, 'and the cap is enforced, not documented');

      // The specific shape that would be a dump: a limit larger than the table.
      assert.ok(LIMITS.price.max >= snapshotCount, 'this fixture is small enough that the cap is what is tested');

      const zero = await get(base, '/api/price?limit=0');
      assert.equal(zero.status, 200, '0 is an integer and not an error: it asks for an empty page');
      assert.deepEqual(zero.body.series, [], 'and it gets one, rather than a silent default');
      assert.equal(zero.body.limit, 0);
    });
  } finally {
    store.close();
  }
});

test('a series that starts after the deployment block says so, and does not imply an idle vault', async () => {
  // The case this wording exists for. The node refuses `eth_call` below about block
  // 100, so no snapshot could be taken there while `eth_getLogs` still works from
  // block 8: the series begins at 607 while the vault was deployed at 8.
  const snapshotsFrom = 607;
  const store = loadedStore({ startBlock: 8, snapshotsFrom });
  try {
    assert.equal(store.seriesFromBlock(), snapshotsFrom, 'the store reports where the series really begins');
    assert.equal(store.eventsFromBlock(), FIRST_SNAPSHOT_BLOCK, 'while the events were indexed from the start');

    await withServer({ store, config: CONFIG }, async (base) => {
      const price = await get(base, '/api/price');
      assert.equal(price.status, 200);
      assert.equal(price.body.seriesFromBlock, snapshotsFrom, 'hoisted to the top level as well as in coverage');
      assert.equal(price.body.coverage.vaultStartBlock, 8);
      assert.equal(price.body.coverage.seriesFromBlock, snapshotsFrom);
      assert.equal(price.body.coverage.startsLaterThanDeployment, true, 'the two differ, so this is true');
      assert.equal(price.body.series[0].blockNumber, snapshotsFrom, 'and the series really does start later');

      const note: string = price.body.coverage.note;
      assert.match(note, new RegExp(`begins at block ${snapshotsFrom}`), 'the note names the block');
      assert.match(note, /this service has records from block 8/, 'and names the earliest block it does know about');
      assert.match(note, /NOTHING IS KNOWN about the blocks in between/);
      assert.match(note, /NOT a period of zero activity/);
      // The comparison is against the earliest thing known, NOT the deployment block:
      // `coverageBeginsAt` is the earliest of the series, the events and the deployment
      // block, so in a store whose events predate its snapshots it is an EVENT block.
      // The note says "records from", never "the deployment block", because the number
      // would not support the stronger claim.
      assert.equal(price.body.coverage.coverageBeginsAt, 8);

      const status = await get(base, '/api/status');
      assert.equal(status.body.seriesFromBlock, snapshotsFrom);
      assert.equal(status.body.eventsFromBlock, FIRST_SNAPSHOT_BLOCK, 'events are covered from earlier than snapshots');
      assert.equal(status.body.coverage.startsLaterThanDeployment, true);
      // The two earliest blocks differ, which is the whole reason both are reported:
      // "what does the chart show" and "what does the activity list show" have
      // different answers here, and neither is the deployment block.
      assert.notEqual(status.body.eventsFromBlock, status.body.seriesFromBlock);
      assert.ok(status.body.eventsFromBlock! < status.body.seriesFromBlock!);
    });
  } finally {
    store.close();
  }
});

test('an empty series says it is empty rather than reporting coverage from block 0', async () => {
  const store = emptyStore();
  store.setState({ lastIndexedBlock: 8, chainHead: 8, startBlock: 8 });
  try {
    await withServer({ store, config: CONFIG }, async (base) => {
      const { body } = await get(base, '/api/price');
      assert.equal(body.count, 0);
      assert.equal(body.seriesFromBlock, null);
      assert.match(body.coverage.note, /no snapshots at all/);
      assert.match(body.coverage.note, /not a vault with no activity/);
    });
  } finally {
    store.close();
  }
});

test('price answers 503 when the decimals were never read, rather than assuming 18/6', async () => {
  // The one place an assumption would be invisible: assuming the offset is exactly the
  // bug this module exists to prevent, and it would print plausible numbers for a
  // vault shape nobody verified.
  const store = loadedStore();
  const config: ApiServerConfig = { chainId: CONFIG.chainId, vault: CONFIG.vault, asset: CONFIG.asset };
  try {
    await withServer({ store, config }, async (base) => {
      const { status, body } = await get(base, '/api/price');
      assert.equal(status, 503);
      assert.match(body.error, /decimals are unknown/);
      assert.equal(body.series, undefined, 'no series is served');

      // The other endpoints do not need decimals and keep working.
      assert.equal((await get(base, '/api/events')).status, 200);
      assert.equal((await get(base, '/api/summary')).status, 200);
      assert.equal((await get(base, '/api/status')).status, 200);
    });
  } finally {
    store.close();
  }
});

// ------------------------------------------------------------------- /api/events

test('events come back newest first, with the newest at log index and block tie-broken', async () => {
  const store = loadedStore();
  try {
    await withServer({ store, config: CONFIG }, async (base) => {
      const { status, body } = await get(base, '/api/events');
      assert.equal(status, 200);
      assert.equal(body.limit, LIMITS.events.fallback);
      assert.equal(body.count, FIXTURE_EVENTS.length, 'the whole fixture fits under the default limit');

      const keys = body.events.map((e: any) => `${e.blockNumber}:${e.logIndex}`);
      const sorted = [...keys].sort((a, b) => {
        const [ab, ai] = a.split(':').map(Number);
        const [bb, bi] = b.split(':').map(Number);
        return bb - ab || bi - ai;
      });
      assert.deepEqual(keys, sorted, 'newest first, tie-broken by log index so a page boundary cannot repeat an event');

      const first = body.events[0];
      const expected = FIXTURE_EVENTS.find((e) => e.blockNumber === LAST_EVENT_BLOCK)!;
      assert.equal(first.blockNumber, expected.blockNumber);
      assert.equal(first.kind, expected.kind);
      assert.equal(first.account, expected.account);
      assert.equal(first.assets, expected.assets, 'uint256 values stay decimal strings');
      assert.equal(first.shares, expected.shares);
      assert.ok(!('price' in first), 'an event is not a price point');
    });
  } finally {
    store.close();
  }
});

test('kind filters to exactly that kind, and an unknown kind is refused by name', async () => {
  const store = loadedStore();
  try {
    await withServer({ store, config: CONFIG }, async (base) => {
      const deposits = await get(base, '/api/events?kind=Deposit');
      assert.equal(deposits.status, 200);
      assert.equal(deposits.body.count, FIXTURE_EVENTS.filter((e) => e.kind === 'Deposit').length);
      assert.ok(deposits.body.events.every((e: any) => e.kind === 'Deposit'));
      assert.equal(deposits.body.filter.kind, 'Deposit', 'the filter is echoed so an empty page is distinguishable from an ignored filter');

      const yields = await get(base, '/api/events?kind=YieldReported');
      assert.equal(yields.body.count, 1, 'the fixture has one yield report, the event kind a chart exists to show');

      const all = await get(base, '/api/events');
      assert.equal(all.body.filter.kind, null);

      // An unknown kind must not fall through to "no filter", which would answer
      // ?kind=Trnsfer with every event and look like it worked.
      const bad = await get(base, '/api/events?kind=Transfer');
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /kind must be one of Deposit, Withdraw, YieldReported/);
      assert.match(bad.body.error, /got "Transfer"/);

      const lower = await get(base, '/api/events?kind=deposit');
      assert.equal(lower.status, 400, 'case matters: these are Solidity event names');
    });
  } finally {
    store.close();
  }
});

test('account filters to exactly that account, case-insensitively, and a bad address is refused', async () => {
  const store = loadedStore();
  const busiest = FIXTURE_EVENTS.reduce<Record<string, number>>((counts, e) => {
    counts[e.account!] = (counts[e.account!] ?? 0) + 1;
    return counts;
  }, {});
  const [account, appearances] = Object.entries(busiest).sort((a, b) => b[1] - a[1])[0]!;

  try {
    await withServer({ store, config: CONFIG }, async (base) => {
      const filtered = await get(base, `/api/events?account=${account}`);
      assert.equal(filtered.status, 200);
      assert.equal(filtered.body.count, appearances);
      assert.ok(filtered.body.events.every((e: any) => e.account === account));
      assert.equal(filtered.body.filter.account, account);

      // Mixed case in the query, lower case in the response: the store lower-cases on
      // write, so comparing mixed case would find nothing and look like "this account
      // did nothing" rather than like a bug.
      const upper = await get(base, `/api/events?account=${account.toUpperCase().replace('0X', '0x')}`);
      assert.equal(upper.body.count, appearances);

      const combined = await get(base, `/api/events?account=${account}&kind=Withdraw&limit=2`);
      assert.equal(combined.status, 200);
      assert.ok(combined.body.events.every((e: any) => e.kind === 'Withdraw' && e.account === account));
      assert.ok(combined.body.count <= 2);

      for (const bad of ['0x123', 'not-an-address', '0x' + 'z'.repeat(40), account.slice(0, 40)]) {
        const response = await get(base, `/api/events?account=${encodeURIComponent(bad)}`);
        assert.equal(response.status, 400, `account=${bad} must be refused`);
        assert.match(response.body.error, /account must be a 0x-prefixed 20-byte address/);
        assert.match(response.body.error, /got "/, 'the message says what was received');
      }
    });
  } finally {
    store.close();
  }
});

test('an event limit is capped so the whole event table cannot be requested at once', async () => {
  const store = loadedStore();
  try {
    await withServer({ store, config: CONFIG }, async (base) => {
      const capped = await get(base, '/api/events?limit=100000');
      assert.equal(capped.status, 200);
      assert.equal(capped.body.limit, LIMITS.events.max);
      assert.ok(capped.body.count <= LIMITS.events.max);

      const two = await get(base, '/api/events?limit=2');
      assert.equal(two.body.count, 2);
      assert.equal(two.body.limit, 2);
    });
  } finally {
    store.close();
  }
});

// ------------------------------------------------------------------ /api/summary

test('summary counts and sums every kind, with the sums as exact decimal strings', async () => {
  const store = loadedStore();
  const expected = {
    Deposit: {
      count: FIXTURE_EVENTS.filter((e) => e.kind === 'Deposit').length,
      assets: FIXTURE_EVENTS.filter((e) => e.kind === 'Deposit').reduce((sum, e) => sum + BigInt(e.assets!), 0n),
    },
    Withdraw: {
      count: FIXTURE_EVENTS.filter((e) => e.kind === 'Withdraw').length,
      assets: FIXTURE_EVENTS.filter((e) => e.kind === 'Withdraw').reduce((sum, e) => sum + BigInt(e.assets!), 0n),
    },
    YieldReported: {
      count: FIXTURE_EVENTS.filter((e) => e.kind === 'YieldReported').length,
      assets: FIXTURE_EVENTS.filter((e) => e.kind === 'YieldReported').reduce((sum, e) => sum + BigInt(e.assets!), 0n),
    },
  };

  try {
    await withServer({ store, config: CONFIG }, async (base) => {
      const { status, body } = await get(base, '/api/summary');
      assert.equal(status, 200);

      for (const kind of ['Deposit', 'Withdraw', 'YieldReported'] as const) {
        assert.equal(body.kinds[kind].count, expected[kind].count, `${kind} count`);
        // A STRING, and the exact value. `typeof` first, because
        // `assert.equal(number, string)` on a coincidentally equal value would pass
        // and the type is half of what this endpoint promises.
        assert.equal(typeof body.kinds[kind].assets, 'string', `${kind} assets must be a decimal string, never a JS number`);
        assert.equal(body.kinds[kind].assets, expected[kind].assets.toString(), `${kind} assets sum`);
      }

      assert.equal(body.kinds.Deposit.assets, '1200124097', 'the fixture total, hand-checked');
      assert.equal(body.kinds.YieldReported.assets, '50000000');
      assert.equal(body.totalEvents, FIXTURE_EVENTS.length);
      assert.equal(body.firstEventBlock, FIRST_SNAPSHOT_BLOCK);
      assert.equal(body.lastEventBlock, LAST_EVENT_BLOCK);
      assert.equal(body.lastIndexedBlock, LAST_EVENT_BLOCK);
      assert.deepEqual(body.unknownKinds, []);
    });
  } finally {
    store.close();
  }
});

test('summary sums stay exact past the precision a JS number has', async () => {
  // 2**53-1 is the largest integer a JS number holds exactly. Two event amounts above
  // it summed as numbers give a wrong value with the right number of digits, and JSON
  // has no way to say "this was approximate".
  const store = emptyStore();
  const big = '9007199254740993'; // 2**53 + 1
  store.insertEvents([
    { blockNumber: 10, logIndex: 0, blockHash: '0xa', txHash: '0x1', kind: 'Deposit', account: '0xabc', assets: big, shares: null, timestamp: 1 },
    { blockNumber: 11, logIndex: 0, blockHash: '0xb', txHash: '0x2', kind: 'Deposit', account: '0xabc', assets: big, shares: null, timestamp: 2 },
  ]);
  try {
    await withServer({ store, config: CONFIG }, async (base) => {
      const { body } = await get(base, '/api/summary');
      const summed = (BigInt(big) * 2n).toString();
      assert.equal(body.kinds.Deposit.assets, summed);
      assert.equal(body.kinds.Deposit.assets, '18014398509481986');
      assert.notEqual(body.kinds.Deposit.assets, String(Number(big) * 2), 'the number version is a different, wrong value');
      assert.equal(typeof body.kinds.Deposit.assets, 'string');
    });
  } finally {
    store.close();
  }
});

test('summary reports every kind at zero on an empty vault, so a key is never missing', async () => {
  const store = emptyStore();
  try {
    await withServer({ store, config: CONFIG }, async (base) => {
      const { body } = await get(base, '/api/summary');
      for (const kind of ['Deposit', 'Withdraw', 'YieldReported']) {
        assert.equal(body.kinds[kind].count, 0);
        assert.equal(body.kinds[kind].assets, '0');
      }
      assert.equal(body.totalEvents, 0);
      assert.equal(body.firstEventBlock, null, 'null, not 0 -- there is no first event block');
      assert.equal(body.lastEventBlock, null);
    });
  } finally {
    store.close();
  }
});

// ------------------------------------------------------------ bad input and errors

test('an unparseable limit is a 400 that names the parameter, not a silent default', async () => {
  const store = loadedStore();
  try {
    await withServer({ store, config: CONFIG }, async (base) => {
      const bad = [
        ['abc', /limit must be an integer, got "abc"/],
        ['', /limit must be an integer, got ""/],
        ['5abc', /limit must be an integer, got "5abc"/], // parseInt would have made this 5
        ['1.5', /limit must be an integer, got "1.5"/],
        ['-1', /limit must not be negative, got -1/],
        ['-0.5', /limit must be an integer, got "-0.5"/],
        ['NaN', /limit must be an integer, got "NaN"/],
        ['Infinity', /limit must be an integer, got "Infinity"/], // a valid JS number, and a LIMIT that means everything
        ['-Infinity', /limit must be an integer, got "-Infinity"/],
        ['1e3', /limit must be an integer, got "1e3"/],
        ['0x10', /limit must be an integer, got "0x10"/],
        ['999999999999999999999999', /limit is out of range/],
      ] as const;

      for (const [value, message] of bad) {
        for (const path of [`/api/price?limit=${encodeURIComponent(value)}`, `/api/events?limit=${encodeURIComponent(value)}`]) {
          const { status, body } = await get(base, path);
          assert.equal(status, 400, `${path} must be a 400`);
          assert.match(body.error, message, `${path} must say what was wrong`);
        }
      }

      // The whole point of the previous block: a bad limit is refused, never replaced
      // by the default. If it were defaulted, these would be a 200 with a page in it.
      const refused = await get(base, '/api/events?limit=abc');
      assert.equal(refused.status, 400);
      assert.equal(refused.body.events, undefined, 'no page is served for a request that was wrong');
      assert.equal(refused.body.limit, undefined, 'and no limit is echoed, because none was accepted');
      assert.equal(refused.body.count, undefined);
    });
  } finally {
    store.close();
  }
});

test('a repeated parameter is refused rather than resolved', async () => {
  const store = loadedStore();
  try {
    await withServer({ store, config: CONFIG }, async (base) => {
      const { status, body } = await get(base, '/api/events?limit=1&limit=2');
      assert.equal(status, 400);
      assert.match(body.error, /limit was given more than once/);
    });
  } finally {
    store.close();
  }
});

test('an unknown path is a 404 whose body lists the endpoints', async () => {
  const store = loadedStore();
  try {
    await withServer({ store, config: CONFIG }, async (base) => {
      for (const path of ['/api/nope', '/api/price/series', '/metrics', '/api/../etc/passwd']) {
        const { status, headers, body } = await get(base, path);
        assert.equal(status, 404, `${path} must be a 404`);
        assert.equal(headers.get('cache-control'), 'no-store');
        assert.match(body.error, /no such endpoint/);
        assert.ok(Array.isArray(body.endpoints), 'the body lists what does exist');
        assert.deepEqual(
          body.endpoints.map((e: any) => e.path.split('?')[0]),
          ['/api/status', '/api/price', '/api/events', '/api/summary'],
          'every endpoint, and only the ones that exist',
        );
      }

      // The root is an index rather than a 404: it is the one path a person types.
      const root = await get(base, '/');
      assert.equal(root.status, 200);
      assert.equal(root.body.endpoints.length, 4);
    });
  } finally {
    store.close();
  }
});

test('a write is refused, and the Allow header says what is accepted', async () => {
  const store = loadedStore();
  try {
    await withServer({ store, config: CONFIG }, async (base) => {
      const { status, headers, body } = await get(base, '/api/events', { method: 'POST' });
      assert.equal(status, 405);
      assert.equal(headers.get('allow'), 'GET, HEAD');
      assert.match(body.error, /read-only/);
    });
  } finally {
    store.close();
  }
});

test('a thrown error is a 500 with a sentence, and the stack goes to the log instead', async () => {
  // A store whose read throws: what a locked, corrupt or half-migrated database looks
  // like from here. The failure is real rather than simulated -- the database handle is
  // closed underneath the handler, which is exactly the state a shutdown race produces.
  const store = loadedStore();
  const logger = recordingLogger();
  store.close();

  await withServer({ store, config: CONFIG, logger }, async (base) => {
    const { status, body } = await get(base, '/api/status');

    assert.equal(status, 500);
    assert.equal(body.error, 'internal error; the failure was logged and no data was served');
    const serialized = JSON.stringify(body);
    assert.ok(!/\bat \w/.test(serialized), 'no stack frames in the body');
    assert.ok(!serialized.includes('db.ts'), 'and no file paths');
    assert.ok(!serialized.includes('node:sqlite'), 'and no driver internals');

    assert.ok(logger.errors.length > 0, 'the failure was logged, with its stack, where an operator can see it');
    assert.match(logger.errors[0]!.message, /unhandled error serving \/api\/status/);
    assert.ok(logger.errors[0]!.err instanceof Error, 'logged as the error itself, so the stack survives');
  });
});
