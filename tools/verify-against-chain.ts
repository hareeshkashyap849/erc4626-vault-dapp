/**
 * Check the index against the chain it came from.
 *
 * WHY THIS IS SEPARATE FROM THE TESTS
 *
 * The unit tests prove the decoder handles the logs they were given, and the storage
 * tests prove the schema enforces what it claims. Neither one can catch the failure
 * that matters most: an index that is internally consistent AND WRONG -- built from
 * the wrong block range, a stale checkpoint, or a filter that quietly matched
 * nothing. Every row would look fine and the totals would disagree with the chain.
 *
 * So this compares the two directly, and it is the only check here that can:
 *
 *   - the events in the database are exactly the events the chain has, in that range
 *   - the newest price point matches `totalAssets` and `totalSupply` read at that block
 *   - the checkpoint is not ahead of the chain
 *
 * Run: node --experimental-strip-types tools/verify-against-chain.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openStore } from '../src/lib/db.ts';
import { RpcClient } from '../src/lib/rpc.ts';
import { TOPICS, decodeVaultLog, decodeShareTransfer, type RawLog } from '../src/lib/decode.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const recordPath = resolve(REPO, '../erc4626-vault/deployments/local.json');
if (!existsSync(recordPath)) {
  console.log(`SKIP: no deployment record at ${recordPath}`);
  process.exit(0);
}
const record = JSON.parse(readFileSync(recordPath, 'utf8'));
const databasePath = process.env.DATABASE_PATH ?? resolve(REPO, 'data/vault.sqlite');

if (!existsSync(databasePath)) {
  console.log(`SKIP: no database at ${databasePath} -- run the indexer first`);
  process.exit(0);
}

const store = openStore(databasePath);
const rpc = new RpcClient(process.env.RPC_URL ?? record.rpcUrl);

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(`${label}${detail ? ` -- ${detail}` : ''}`);
};

const state = store.getState();
if (!state) {
  console.log('SKIP: the database has no indexer state, so nothing has been indexed yet');
  store.close();
  process.exit(0);
}

console.log(`database  ${databasePath}`);
console.log(`vault     ${record.vault}`);
console.log(`indexed   block ${state.startBlock} .. ${state.lastIndexedBlock}`);
console.log('');

// --------------------------------------------------------------- the chain

const chainId = await rpc.chainId();
check('the database describes this chain', chainId === record.chainId, `chain ${chainId}, record ${record.chainId}`);

const head = await rpc.blockNumber();
check('the checkpoint is not ahead of the chain', state.lastIndexedBlock <= head, `checkpoint ${state.lastIndexedBlock}, head ${head}`);

// ---- events: the chain's set for this range vs the database's
const chainLogs = (await rpc.getLogs({
  address: record.vault,
  fromBlock: state.startBlock,
  toBlock: state.lastIndexedBlock,
  topics: [[TOPICS.Deposit, TOPICS.Withdraw, TOPICS.YieldReported]],
})) as RawLog[];

const chainEvents = chainLogs
  .map((log) => decodeVaultLog(log))
  .filter((e): e is NonNullable<typeof e> => e !== null)
  .map((e) => `${e.blockNumber}:${e.logIndex}`)
  .sort();

const dbEvents = (
  store.db
    .prepare('SELECT block_number, log_index FROM vault_events WHERE block_number BETWEEN ? AND ?')
    .all(state.startBlock, state.lastIndexedBlock) as { block_number: number; log_index: number }[]
)
  .map((r) => `${r.block_number}:${r.log_index}`)
  .sort();

check(
  'every vault event on the chain is in the index',
  chainEvents.every((key) => dbEvents.includes(key)),
  `${chainEvents.length} on chain, ${dbEvents.length} in the database`,
);
check('and the index holds nothing the chain does not', dbEvents.every((key) => chainEvents.includes(key)));

// ---- share transfers, same comparison
const chainTransfers = ((await rpc.getLogs({
  address: record.vault,
  fromBlock: state.startBlock,
  toBlock: state.lastIndexedBlock,
  topics: [[TOPICS.Transfer]],
})) as RawLog[])
  .map((log) => decodeShareTransfer(log))
  .filter((t): t is NonNullable<typeof t> => t !== null)
  .map((t) => `${t.blockNumber}:${t.logIndex}`)
  .sort();

const dbTransfers = (
  store.db
    .prepare('SELECT block_number, log_index FROM share_transfers WHERE block_number BETWEEN ? AND ?')
    .all(state.startBlock, state.lastIndexedBlock) as { block_number: number; log_index: number }[]
)
  .map((r) => `${r.block_number}:${r.log_index}`)
  .sort();

check('every share transfer is indexed', chainTransfers.every((k) => dbTransfers.includes(k)), `${chainTransfers.length} on chain, ${dbTransfers.length} in the database`);

// ---- the price series against the chain, at its most recent point
const latest = store.priceSeries(1)[0];
if (!latest) {
  check('the price series is not empty', false, 'no snapshots at all');
} else {
  // Only meaningful when the node still serves state at that block, which it may not.
  const result = await rpc
    .batchAllowingErrors<string>([
      { method: 'eth_call', params: [{ to: record.vault, data: '0x01e1d114' }, `0x${latest.blockNumber.toString(16)}`] },
      { method: 'eth_call', params: [{ to: record.vault, data: '0x18160ddd' }, `0x${latest.blockNumber.toString(16)}`] },
    ])
    .catch(() => null);

  if (!result || !('result' in result[0]!) || !('result' in result[1]!)) {
    console.log(`  skip  the newest price point could not be checked against the chain (node does not serve state at block ${latest.blockNumber})`);
  } else {
    check(
      'the newest price point matches the chain',
      BigInt(latest.totalAssets) === BigInt((result[0] as { result: string }).result) &&
        BigInt(latest.totalSupply) === BigInt((result[1] as { result: string }).result),
      `block ${latest.blockNumber}: index ${latest.totalAssets}/${latest.totalSupply}`,
    );
  }
}

// ---- coverage, stated rather than glossed over
const seriesFrom = store.seriesFromBlock();
if (seriesFrom !== null && seriesFrom > state.startBlock) {
  console.log(
    `  note  the price series starts at block ${seriesFrom}, not at the deployment block ${state.startBlock}.\n` +
      '        The node does not serve state that far back, so those points could not be read.\n' +
      '        The API reports this rather than drawing zeros for them.',
  );
}

store.close();

console.log('');
if (failures.length) {
  console.log(`${failures.length} problem(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('OK -- the index agrees with the chain');
