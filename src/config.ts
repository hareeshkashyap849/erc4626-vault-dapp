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
  databasePath: 'data/vault.sqlite',
  apiPort: 8787,
  // A 5-minute cron covers 150 blocks at Base's measured 2.000 s block time. 300 is
  // a 2x margin, and 20 s is what a measured 300-block catch-up costs with room to
  // spare. These three numbers were WRONG together in the first version of the plan
  // -- see the vault repository's ARCHITECTURE.md section 7.2, where the mistake is
  // recorded rather than quietly corrected.
  maxCatchupBlocks: 300,
  maxCatchupSeconds: 20,
  confirmations: 0,
};

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
    databasePath: env.DATABASE_PATH ?? DEFAULTS.databasePath,
    apiPort: number(env.PORT, DEFAULTS.apiPort),
    maxCatchupBlocks: number(env.MAX_CATCHUP_BLOCKS, DEFAULTS.maxCatchupBlocks),
    maxCatchupSeconds: number(env.MAX_CATCHUP_SECONDS, DEFAULTS.maxCatchupSeconds),
    confirmations: number(env.CONFIRMATIONS, DEFAULTS.confirmations),
    recordPath: path,
  };
}

export { DEFAULTS as CONFIG_DEFAULTS };
