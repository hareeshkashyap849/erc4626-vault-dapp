/**
 * The committed snapshot must belong to the chain the deployment record names.
 *
 * WHY THIS FILE EXISTS
 *
 * `data/vault.sqlite` is committed, and the scheduled workflow indexes Base Sepolia
 * into it. Nothing else in the repository is allowed to write there, but nothing
 * enforced that either -- and the failure mode is silent in a specific way: block
 * numbers are just integers, so a local anvil chain's rows and Base Sepolia's rows sit
 * in one table with a plausible row count and no error anywhere.
 *
 * That is not hypothetical. The committed snapshot held 33,702 blocks (8..33,709) from
 * a local anvil chain beside a record naming a Base Sepolia deployment at block 46,919,124,
 * and the schema had no column that could have said so. Two things changed: `indexer_state`
 * now records `chain_id`, and this check refuses a snapshot that disagrees with the
 * record it is published next to.
 *
 * WHAT IS CHECKED, AND WHY EACH ONE
 *
 *   chain id      -- the snapshot must say which chain it is, and it must be the one
 *                    the record names. `null` (written before the column existed) is a
 *                    failure, not a pass: an unknown chain is not a matching chain.
 *   start block   -- must not be LATER than the record's deploy block. The two are not
 *                    equal, and asserting equality was wrong: starting at or before the
 *                    deployment block costs one scanned block and cannot miss an event,
 *                    while starting after it loses those events for good and leaves
 *                    nothing in the file that says they existed. The assertion is
 *                    one-sided because the failure is one-sided (see below).
 *   rows below it -- the two-chains-in-one-file detector, taken against the snapshot's OWN
 *                    `start_block`. A row earlier than the block the snapshot says it began
 *                    at came from somewhere else, by construction. Taken against the
 *                    record's deploy block instead, this check calls a legitimate
 *                    pre-deployment row a foreign one -- and it did, for exactly one row,
 *                    the moment the record's block was corrected.
 *
 * WHY `<=` AND NOT `===`, IN NUMBERS
 *
 * This file asserted `state.startBlock === record.deployBlock`, and both sides used to say
 * 46,919,124 -- because BOTH were the same wrong number. That number is the deployment script's
 * `DeployValidation` library, which `forge script` sends as a CREATE2 one block before the vault;
 * the vault's own CREATE, the transaction the record's `deployTxHash` names, was mined in
 * 46,919,125 (see `deployments/README.md` in the vault repository: all three sources -- the
 * receipt, the transaction and the broadcast file -- say so). The record was corrected; the
 * snapshot was not, and should not be. The indexer was pointed at 46,919,124, one block early is
 * harmless by construction, and editing a committed index to move its start one block later would
 * delete its only record of that block in exchange for making two numbers look alike.
 *
 * So equality would now fail on a correct record and a correct snapshot -- and the tempting
 * repair, setting `start_block` to 46,919,125, is editing data to fit an assertion. What the test
 * is FOR is that a late start silently loses events, and that is what it now asserts.
 *
 * Prerequisites are the snapshot and the record. Either absent is a SKIP, the same
 * convention as the rest of the suite: this project is expected to be usable offline,
 * and a check that cannot run must not pretend to have passed.
 *
 * Run: node --experimental-strip-types test/snapshot.test.ts
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openStore } from '../src/lib/db.ts';
import { readDeploymentRecord } from '../src/config.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

/** The committed snapshot, unless a run points somewhere else. */
const DB_PATH = resolve(REPO, process.env.DATABASE_PATH ?? 'data/vault.sqlite');

/**
 * The record the snapshot is published beside. The workflow fetches it into
 * `deployments/`; in a workspace checkout it is read from the vault repository.
 */
function findRecord(): string | undefined {
  const candidates = [
    process.env.DEPLOYMENT_RECORD,
    resolve(REPO, 'deployments/base-sepolia.json'),
    resolve(REPO, '../erc4626-vault/deployments/base-sepolia.json'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  return candidates.map((p) => resolve(p)).find((p) => existsSync(p));
}

const recordPath = findRecord();

if (!existsSync(DB_PATH) || !recordPath) {
  const missing = [
    existsSync(DB_PATH) ? null : `no snapshot at ${DB_PATH}`,
    recordPath ? null : 'no deployment record (set DEPLOYMENT_RECORD to point at one)',
  ].filter(Boolean);
  console.log(`SKIP: ${missing.join('; ')}`);
} else {
  const record = readDeploymentRecord(recordPath);
  const store = openStore(DB_PATH);

  test('the snapshot says which chain it holds, and it is the record\'s chain', () => {
    const state = store.getState();
    assert.ok(state, `${DB_PATH} has no indexer_state row, so it does not say what it contains`);
    assert.notEqual(
      state.chainId,
      null,
      'the snapshot predates the chain_id column, so nothing in it identifies the chain; re-run the indexer to record it',
    );
    assert.equal(
      state.chainId,
      record.chainId,
      `the snapshot holds chain ${state.chainId}, but ${recordPath} names chain ${record.chainId}`,
    );
  });

  test('the snapshot does not start after the block the record says the vault was deployed in', () => {
    const state = store.getState()!;
    // One-sided on purpose: at or before is safe (one scanned block, nothing missed), after is
    // permanent. Equality would also pass, and it would be the stricter-looking version of the
    // same fact -- but it fails on a snapshot that legitimately started one block early, and a
    // test that fails for a correct input gets deleted or bent, which is how this one would stop
    // catching the late start it exists for.
    assert.ok(
      state.startBlock <= record.deployBlock,
      `the snapshot starts at ${state.startBlock}, but the record says the vault was deployed in ` +
        `${record.deployBlock}: an indexer that starts after the deployment has already missed those ` +
        'events for good, and nothing later in the file says they existed',
    );
    assert.ok(state.lastIndexedBlock >= state.startBlock, 'the snapshot has indexed nothing');
  });

  /**
   * @dev The detector for two chains in one file.
   *
   * Every table that carries a block number is checked, not just the events: a snapshot
   * row from another chain is the one that would show up in a price chart as a jump to
   * an absurd value, and it is exactly the table a check written for "events" would
   * miss.
   *
   * The bar is the snapshot's OWN `start_block`, not the record's deploy block. A row
   * between the two is not foreign data: it is a block this indexer was pointed at and
   * scanned. The committed snapshot has exactly one such row (46919124) and its absence is
   * meaningful -- it is the evidence that the start block was honoured rather than inferred.
   */
  test('no row in the snapshot predates the block the snapshot says it started at', () => {
    const start = store.getState()!.startBlock;
    const below = [
      ['blocks', store.db.prepare('SELECT COUNT(*) AS n FROM blocks WHERE block_number < ?').get(start)],
      ['vault_events', store.db.prepare('SELECT COUNT(*) AS n FROM vault_events WHERE block_number < ?').get(start)],
      ['share_transfers', store.db.prepare('SELECT COUNT(*) AS n FROM share_transfers WHERE block_number < ?').get(start)],
      ['vault_snapshots', store.db.prepare('SELECT COUNT(*) AS n FROM vault_snapshots WHERE block_number < ?').get(start)],
    ].filter(([, row]) => (row as { n: number }).n > 0);

    assert.equal(
      below.length,
      0,
      `rows below the block the snapshot says it started at (${start}) -- blocks this indexer never claims to ` +
        `have scanned, so they belong to another chain or another run: ${below
        .map(([table, row]) => `${table}=${(row as { n: number }).n}`)
        .join(', ')}`,
    );
  });

  test('the snapshot is not empty', () => {
    // A snapshot with no blocks is a snapshot that will be rebuilt from the deployment
    // block on the next cron run: slow, and on some public endpoints not permitted.
    const blocks = (store.db.prepare('SELECT COUNT(*) AS n FROM blocks').get() as { n: number }).n;
    assert.ok(blocks > 0, `${DB_PATH} has no indexed blocks`);
  });

  test.after(() => store.close());
}
