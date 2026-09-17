/**
 * Configuration.
 *
 * TWO SOURCES, AND ONLY ONE OF THEM IS REQUIRED.
 *
 * The vault's address, asset and start block are not invented here -- they are read
 * from `deployments/<chain>.json` in the vault repository, which is the single
 * record of what was deployed where. Copying those values into this repository would
 * create a second place for them to be wrong, and the wrong one would be the one
 * nobody updated.
 *
 * `startBlock` in particular is not a detail. An indexer that starts too late misses
 * the vault's earliest events forever, and one that starts too early scans blocks in
 * which the vault did not exist -- which on some endpoints is an error and on others
 * is a very long wait. The value comes from the deployment record because that is
 * where it is known.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface DeploymentRecord {
  chainId: number;
  rpcUrl: string;
  vault: string;
  asset: string;
  owner: string;
  deployBlock: number;
  note?: string;
}

export interface Config {
  chainId: number;
  rpcUrl: string;
  vault: string;
  asset: string;
  startBlock: number;
  databasePath: string;
  apiPort: number;
  /** Bounds applied to a catch-up run. See ARCHITECTURE.md §7.2 for the arithmetic. */
  maxCatchupBlocks: number;
  maxCatchupSeconds: number;
  confirmations: number;
  /** Where the deployment record was read from, for logging. */
  recordPath: string;
}

const DEFAULTS = {
  apiPort: 8787,
  // HOW MANY BLOCKS ONE RUN MAY COVER, AND WHY IT IS 3000.
  //
  // The number to size this against is NOT the nominal cron interval. This workflow asks
  // for `*/5`, and the scheduler does not deliver it: measured across scheduled runs #93 to
  // #107, consecutive runs were 15.4 to 27.5 minutes apart, median 19.1 (17-18 typical).
  // Base produces a block every 2.000 s, so the median interval produces 573 blocks and the
  // worst gap produces 825. A run may reach for 3000: 2427 blocks of headroom on the median
  // interval, and still 2175 on the longest gap measured.
  //
  // 300 WAS BELOW ONE INTERVAL. At 300 the bound covered 10 minutes of chain, so every run
  // fell behind by at least 160 blocks and as much as 525 -- the snapshot could not catch up
  // by design, which is what a measured 26,612-block backlog looked like.
  //
  // 3000 FITS THE JOB'S OWN LIMIT. The workflow's job has `timeout-minutes: 10`, of which
  // checkout, the test suite and the deployment-record fetch take about 45 s measured, so a
  // run is boxed in at roughly 555 s and takes 3000 blocks in 146 s at the 20.5 blocks/s
  // measured on the runner (300 blocks in 14.6 s, run #108) -- about 190 s including the
  // setup, against a 600 s ceiling.
  //
  // THE TIME BOUND IS STILL 450 SECONDS, AND THE TIME BOUND IS STILL NOT THE ONE THAT BINDS.
  //
  // `maxCatchupSeconds` is a safety net for a slow endpoint, not a throughput target, so it
  // is set to the largest value that still leaves the job inside its own timeout. The
  // conversion is `blocks = seconds x scan rate` (see src/indexer/bounds.ts), and the rate
  // that conversion uses is the one the LAST RUN MEASURED, falling back to a conservative 4
  // blocks/s on a first run. So:
  //
  //   450 s x 4 blocks/s   = 1800 blocks  (floor: a slow endpoint stops the run early)
  //   450 s x 20.5 blocks/s = 9225 blocks (runner rate: the 3000-block bound decides)
  //
  // and 450 s + ~45 s of setup is 495 s of the 600 s the job has. It was 300 s, which at the
  // measured runner rate allows 6150 blocks -- above the 3000 bound, so 300 would still have
  // left the block bound in charge. It is 450 because the seconds budget is what bounds a run
  // on a SLOW endpoint, and 3000 blocks needs 3000/4 = 750 s at the floor rate, i.e. more
  // than the job has: without the larger budget a slow endpoint would be stopped by the old
  // 300-second ceiling at 1200 blocks and the larger block bound would never be reached.
  //
  // AND THE EARLIER MISTAKE, KEPT HERE ON PURPOSE.
  //
  // `maxCatchupSeconds` USED TO BE 20 SECONDS AND THAT WAS WRONG. 20 was chosen from a
  // measurement of what a 300-block catch-up costs in wall clock, which was the right
  // question; but the code converted the budget into blocks using the CHAIN's block time,
  // so 20 s became 9 blocks against the 150 a cron interval produces. Measured with those
  // exact values: a run scanned 9 blocks while the head advanced 58 in the 90 seconds before
  // it. Every run looked successful and the snapshot fell further behind on every one. See
  // src/indexer/bounds.ts -- the conversion is what was wrong, and it is now made at the
  // rate this indexer scans rather than at the rate the chain produces blocks.
  //
  // Both mistakes are the same mistake: a parameter chosen against a nominal interval or a
  // wrong unit instead of against a measured rate. The pair is only jointly possible if ONE
  // of the two bounds is comfortably the tighter one, and that one has to be the block bound
  // on a healthy endpoint.
  maxCatchupBlocks: 3000,
  maxCatchupSeconds: 450,
  confirmations: 0,
};

/**
 * The database path when `DATABASE_PATH` is not set: one file per chain.
 *
 * WHY IT IS NOT A FIXED `data/vault.sqlite`
 *
 * That path is the committed snapshot, and it is maintained by the scheduled
 * workflow, which indexes Base Sepolia into it. A local run defaulting to the same
 * file writes rows from a local anvil chain into the published snapshot -- which is
 * exactly what happened: the committed database held 33,702 local blocks beside a
 * Base Sepolia deployment, with nothing in the schema saying so. Naming the file
 * after the chain makes that mistake unavailable rather than merely discouraged,
 * and it matches the recorded convention (`DATABASE_PATH=data/vault-<chain>.sqlite`).
 */
function defaultDatabasePath(chainId: number): string {
  return `data/vault-${chainId}.sqlite`;
}

/** Read and validate a deployment record. */
export function readDeploymentRecord(path: string): DeploymentRecord {
  if (!existsSync(path)) {
    throw new Error(
      `no deployment record at ${path}.\n` +
        'This file is written by the vault repository when the contract is deployed:\n' +
        '  cd ../erc4626-vault && powershell -File scripts/dev-chain.ps1\n' +
        'It is the only place the address and start block are known, so it is required.',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }

  const record = raw as Partial<DeploymentRecord>;
  const problems: string[] = [];
  if (!Number.isInteger(record.chainId)) problems.push('chainId is missing or not an integer');
  if (!/^0x[0-9a-fA-F]{40}$/.test(record.vault ?? '')) problems.push('vault is missing or not an address');
  if (!/^0x[0-9a-fA-F]{40}$/.test(record.asset ?? '')) problems.push('asset is missing or not an address');
  if (!Number.isInteger(record.deployBlock) || (record.deployBlock ?? -1) < 0) problems.push('deployBlock is missing or not a block number');

  if (problems.length) {
    throw new Error(`${path} is not usable as a deployment record:\n  - ${problems.join('\n  - ')}`);
  }

  return record as DeploymentRecord;
}

/**
 * Build the config from a deployment record plus environment overrides.
 *
 * Environment overrides exist for deployment (a host sets a port and a database
 * path) rather than for convenience: nothing that identifies WHICH chain is
 * overridable, because a record that says one thing and an environment that says
 * another is a way to index the wrong contract silently.
 */
export function loadConfig({ recordPath, env = process.env }: { recordPath?: string; env?: NodeJS.ProcessEnv } = {}): Config {
  const path = resolve(recordPath ?? env.DEPLOYMENT_RECORD ?? '../erc4626-vault/deployments/local.json');
  const record = readDeploymentRecord(path);

  const number = (value: string | undefined, fallback: number): number => {
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`expected a number, got "${value}"`);
    return parsed;
  };

  return {
    chainId: record.chainId,
    rpcUrl: env.RPC_URL ?? record.rpcUrl,
    vault: record.vault,
    asset: record.asset,
    startBlock: record.deployBlock,
    databasePath: env.DATABASE_PATH ?? defaultDatabasePath(record.chainId),
    apiPort: number(env.PORT, DEFAULTS.apiPort),
    maxCatchupBlocks: number(env.MAX_CATCHUP_BLOCKS, DEFAULTS.maxCatchupBlocks),
    maxCatchupSeconds: number(env.MAX_CATCHUP_SECONDS, DEFAULTS.maxCatchupSeconds),
    confirmations: number(env.CONFIRMATIONS, DEFAULTS.confirmations),
    recordPath: path,
  };
}

export { DEFAULTS as CONFIG_DEFAULTS };
