/**
 * Capture real logs from a chain into a fixture.
 *
 * WHY A FIXTURE RATHER THAN HAND-WRITTEN HEX
 *
 * Event decoding is the one part of this service that can be wrong without looking
 * wrong: a wrong topic turns a deposit into a withdrawal, a wrong indexed-parameter
 * count shifts every field by one word. Hand-written test data cannot catch either,
 * because the person writing it encodes the same misunderstanding twice. Logs taken
 * from a chain where the events genuinely happened can.
 *
 * The fixture makes the suite runnable with no chain, which matters because the
 * alternative is a suite that skips itself exactly when someone new tries it.
 *
 * Usage: node tools/capture-fixture.ts <fromBlock> <toBlock> [outFile]
 */
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcClient } from '../src/lib/rpc.ts';
import { TOPICS } from '../src/lib/decode.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const recordPath = resolve(REPO, '../erc4626-vault/deployments/local.json');
if (!existsSync(recordPath)) {
  console.error(`no deployment record at ${recordPath}`);
  process.exit(1);
}
const record = JSON.parse(readFileSync(recordPath, 'utf8'));

const fromBlock = Number(process.argv[2] ?? record.deployBlock ?? 0);
const toBlock = Number(process.argv[3] ?? 'latest');
const outFile = resolve(REPO, process.argv[4] ?? 'test/fixtures/vault-logs.json');

const rpc = new RpcClient(process.env.RPC_URL ?? record.rpcUrl);

const head = await rpc.blockNumber();
const to = toBlock === Number.NaN || process.argv[3] === undefined || process.argv[3] === 'latest' ? head : toBlock;

console.log(`vault   ${record.vault}`);
console.log(`blocks  ${fromBlock} .. ${to}  (head ${head})`);

const logs = await rpc.getLogs({
  address: record.vault,
  fromBlock,
  toBlock: to,
  topics: [[TOPICS.Deposit, TOPICS.Withdraw, TOPICS.YieldReported, TOPICS.Transfer]],
});

// Timestamps for every block that has a log, so the fixture is self-contained.
const blockNumbers = [...new Set(logs.map((l) => Number(BigInt(l.blockNumber))))].sort((a, b) => a - b);
const headers = await rpc.blockHeaders(blockNumbers);
const times = Object.fromEntries([...headers.entries()].map(([n, h]) => [n, h.timestamp]));

const fixture = {
  _comment:
    'Captured from a real chain by tools/capture-fixture.ts. Do not edit by hand: the point of this file is that nobody typed it.',
  capturedAt: new Date().toISOString(),
  chainId: await rpc.chainId(),
  vault: record.vault,
  asset: record.asset,
  fromBlock,
  toBlock: to,
  blockTimes: times,
  logs,
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(fixture, null, 2) + '\n', 'utf8');

const byTopic = {};
for (const log of logs) {
  const key = log.topics[0];
  byTopic[key] = (byTopic[key] ?? 0) + 1;
}
console.log(`\nwrote ${logs.length} logs to ${outFile}`);
console.log('by topic:');
for (const [topic, count] of Object.entries(byTopic)) {
  const name = Object.entries(TOPICS).find(([, t]) => t.toLowerCase() === topic.toLowerCase())?.[0] ?? 'UNKNOWN';
  console.log(`  ${String(count).padStart(4)}  ${name.padEnd(14)} ${topic}`);
}
