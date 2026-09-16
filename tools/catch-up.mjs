/**
 * Drive the indexer to the chain head, one bounded run at a time.
 *
 * WHY THIS IS NEEDED AND WHY IT IS NOT A WORKAROUND FOR A BUG
 *
 * The indexer deliberately processes a BOUNDED number of blocks per run and reports
 * `TRUNCATED a bound stopped this run before the head`. That design is correct: a catch-up
 * over an unknown number of blocks must not run unbounded, or a long-stopped indexer would
 * block forever on restart with no progress to observe and no way to interrupt cleanly.
 *
 * The consequence is that catching up N blocks takes N/bound runs. On this machine the
 * chain block time is 2 seconds, so a chain left running for a couple of hours is thousands
 * of blocks ahead and the indexer needs a few hundred runs to reach it. Doing that by hand
 * is not a task anyone should do, so it is a script.
 *
 * It stops on the first of: the head is reached, `--max-runs` is hit, or a run fails. It
 * prints a line per run so progress is visible and the process can be watched or killed.
 *
 * Usage (from the erc4626-vault-dapp directory):
 *
 *   node tools/catch-up.mjs                 # up to 400 runs
 *   node tools/catch-up.mjs --max-runs 50
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const maxRuns = flag('--max-runs', 400);

const project = resolve(import.meta.dirname, '..');
const NO_PROXY_ENV = { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };

async function status() {
  const res = await fetch('http://127.0.0.1:8787/api/status', { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`index API answered ${res.status}`);
  return res.json();
}

async function chainHead() {
  const res = await fetch('http://127.0.0.1:8545', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  });
  const body = await res.json();
  return Number.parseInt(body.result, 16);
}

const before = await status();
const headAtStart = await chainHead();
console.log(`before : indexed ${before.lastIndexedBlock}, chain head ${headAtStart}, behind ${headAtStart - before.lastIndexedBlock}`);

let runs = 0;
let lastIndexed = before.lastIndexedBlock;
let crashes = 0;

for (; runs < maxRuns; runs += 1) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', 'src/indexer/cli.ts'],
    { cwd: project, stdio: 'ignore', env: { ...process.env, ...NO_PROXY_ENV } },
  );

  /**
   * PROGRESS IS THE TEST, NOT THE EXIT CODE.
   *
   * The indexer used to exit with `3221226505` (0xC0000409) AFTER committing its rows --
   * `process.exit()` racing `node:sqlite`'s native teardown, fixed in `src/indexer/cli.ts`.
   * Stopping on a non-zero status would therefore have abandoned a catch-up that was
   * working perfectly, and reported the loop as broken while the database quietly advanced.
   * A stored `last_indexed_block` is the only thing that proves a run did anything, so that
   * is what decides.
   */
  const st = await status();
  const head = await chainHead();
  const advanced = st.lastIndexedBlock !== lastIndexed;

  if (result.status !== 0) {
    crashes += 1;
    if (!advanced) {
      console.error(`run ${runs + 1} exited ${result.status} AND made no progress; stopping`);
      break;
    }
    console.error(`run ${runs + 1} exited ${result.status} but advanced ${lastIndexed} -> ${st.lastIndexedBlock}; continuing`);
  }

  if (runs % 10 === 0 || head - st.lastIndexedBlock <= 20) {
    console.log(
      `run ${String(runs + 1).padStart(3)} : indexed ${st.lastIndexedBlock}, head ${head}, behind ${head - st.lastIndexedBlock}` +
        (crashes > 0 ? `  (${crashes} non-zero exit(s) so far)` : ''),
    );
  }

  if (!advanced && head - st.lastIndexedBlock > 20) {
    console.error('no progress in the last run; stopping rather than looping forever');
    break;
  }

  lastIndexed = st.lastIndexedBlock;
  if (head - st.lastIndexedBlock <= 1) {
    console.log(`\ncaught up after ${runs + 1} run(s): indexed ${st.lastIndexedBlock}, head ${head}`);
    if (crashes > 0) console.log(`note: ${crashes} run(s) exited non-zero; see the comment above the exit check`);
    process.exit(0);
  }
}

const after = await status();
const headNow = await chainHead();
console.log(`\nstopped after ${runs} run(s): indexed ${after.lastIndexedBlock}, head ${headNow}, behind ${headNow - after.lastIndexedBlock}`);
process.exit(1);
