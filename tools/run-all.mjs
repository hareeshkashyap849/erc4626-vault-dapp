/**
 * Run every check, in order, and print one verdict.
 *
 * WHY NOT `node --test`
 *
 * `node --test` spawns a child process per file and captures its output through a
 * pipe. This sandbox forbids named pipes, so it fails with `EPERM` before running
 * anything -- which reads as "the tests are broken" rather than "the runner cannot
 * start". Each file is therefore run as a plain script and its exit code is the
 * result. That works everywhere, including here.
 *
 * SKIPS ARE NOT FAILURES, and are reported as such. A check whose prerequisite is
 * absent -- a chain, a deployment record -- reports SKIP and does not fail the run,
 * because being able to work offline is a property of this project rather than an
 * exception to it.
 *
 * Run: node tools/run-all.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const NODE_FLAGS = ['--experimental-strip-types', '--no-warnings'];

const CHECKS = [
  { name: 'keccak and event decoding (against real logs)', file: 'test/decode.test.ts' },
  // Existed but was never listed here, so it was never run -- found by this runner's own
  // "listed but missing" guard. It covers the real-deployment bug: a public endpoint
  // answers `0x` for a read at the deployment block, which is not zero.
  { name: 'RPC results: "0x" is unknown, never zero', file: 'test/rpc-results.test.ts' },
  // The throttle bug: a 429 on the second request of a scheduled run threw, which skipped the
  // workflow's commit step, so the published snapshot never advanced. MEASURED: 105 scheduled
  // runs, 105 failures, zero bot commits. These tests pin the retry/backoff distinction.
  { name: 'RPC retry: a 429 is throttling, not a capability fact', file: 'test/rpc-retry.test.ts' },
  { name: 'storage: idempotence and reorg rollback', file: 'test/db.test.ts' },
  { name: 'share price arithmetic', file: 'test/price.test.ts' },
  { name: 'candlestick aggregation and formatting', file: 'test/chart.test.ts' },
  { name: 'query API', file: 'test/api.test.ts' },
  { name: 'configuration and deployment record', file: 'test/config.test.ts' },
  // The two run bounds decide whether a scheduled indexer keeps up; their arithmetic is
  // tested because the comparison was right and the unit was wrong once.
  { name: 'run bounds: wall clock, not chain time', file: 'test/bounds.test.ts' },
  // The committed snapshot is an artifact, and an artifact that is never checked is
  // an artifact that drifts. Skips itself when the snapshot or the record is absent.
  { name: 'committed snapshot matches the deployment record', file: 'test/snapshot.test.ts' },
];

const failures = [];
const results = [];

for (const check of CHECKS) {
  const path = resolve(REPO, check.file);
  if (!existsSync(path)) {
    // A test file that does not exist yet is a skip, not a failure: the suite is
    // being built, and a missing file should not masquerade as a passing one.
    results.push(['SKIP', check.name, 'not written yet']);
    console.log(`\n=== SKIP  ${check.name}\n    ${check.file} does not exist yet`);
    continue;
  }

  console.log(`\n=== RUN   ${check.name}`);
  const run = spawnSync(process.execPath, [...NODE_FLAGS, path], {
    cwd: REPO,
    stdio: 'inherit',
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
  });

  if (run.error) {
    failures.push(`${check.name}: could not start (${run.error.message})`);
    results.push(['FAIL', check.name, run.error.message]);
    continue;
  }
  if (run.status === 0) {
    results.push(['ok', check.name, '']);
  } else {
    failures.push(`${check.name}: exit ${run.status}`);
    results.push(['FAIL', check.name, `exit ${run.status}`]);
  }
}

// Every test file present but unlisted would otherwise be silently skipped.
const listed = new Set(CHECKS.map((c) => resolve(REPO, c.file)));
const unlisted = existsSync(resolve(REPO, 'test'))
  ? readdirSync(resolve(REPO, 'test'))
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => resolve(REPO, 'test', f))
      .filter((f) => !listed.has(f))
  : [];
if (unlisted.length > 0) {
  for (const file of unlisted) failures.push(`${file} exists but is not in this runner, so it never runs`);
}

console.log('\n================================================');
for (const [status, name, detail] of results) {
  console.log(`  ${status.padEnd(4)} ${name}${detail ? `  (${detail})` : ''}`);
}
console.log('================================================');

const skipped = results.filter((r) => r[0] === 'SKIP').length;
console.log(`${results.length - failures.length - skipped} passed, ${failures.length} failed, ${skipped} skipped`);

if (failures.length) {
  console.log('');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nOK');
