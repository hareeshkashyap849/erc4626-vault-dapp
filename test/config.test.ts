/**
 * Tests for configuration and the deployment record.
 *
 * WHY THIS FILE EXISTS
 *
 * The vault's address and start block are not configured here -- they are READ from
 * the vault repository's deployment record, which is the single place they are known.
 * That makes this file the one boundary where a mistake becomes silent: an indexer
 * pointed at the wrong address indexes nothing and reports no error, and a start
 * block that is too late misses the vault's earliest events forever.
 *
 * So the validation is tested, including the failures. A configuration loader whose
 * error paths are untested is a loader that accepts a record missing its address and
 * fails an hour later with a mystery.
 *
 * Run: node --experimental-strip-types test/config.test.ts
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, readDeploymentRecord, CONFIG_DEFAULTS } from '../src/config.ts';

const GOOD = {
  chainId: 31337,
  rpcUrl: 'http://127.0.0.1:8545',
  walletRpcUrl: 'http://127.0.0.1:8545',
  chainName: 'Anvil Local',
  vault: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  asset: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  owner: '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720',
  deployBlock: 8,
  note: 'One disposable local chain.',
};

/** Write a record to a temp file and hand back its path. Cleaned up by the caller. */
function withRecord(contents: unknown, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'vault-rec-'));
  const path = join(dir, 'deployment.json');
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2), 'utf8');
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a complete record round-trips', () => {
  withRecord(GOOD, (path) => {
    const record = readDeploymentRecord(path);
    assert.equal(record.vault, GOOD.vault);
    assert.equal(record.asset, GOOD.asset);
    assert.equal(record.deployBlock, 8);
    assert.equal(record.chainId, 31337);
  });
});

/**
 * @dev `deployBlock` is the field most worth refusing to guess.
 *
 * An indexer that starts too late misses the vault's first events permanently, and
 * there is no later signal that they existed -- the index simply has less in it than
 * the chain does. An absent or non-numeric value must therefore be fatal rather than
 * defaulted to zero or to the current head.
 */
test('a record missing its start block is refused, not defaulted', () => {
  for (const broken of [
    { ...GOOD, deployBlock: undefined },
    { ...GOOD, deployBlock: null },
    { ...GOOD, deployBlock: 'eight' },
    { ...GOOD, deployBlock: -1 },
    { ...GOOD, deployBlock: 8.5 },
  ]) {
    withRecord(broken, (path) => {
      assert.throws(() => readDeploymentRecord(path), /deployBlock/, `accepted deployBlock ${JSON.stringify(broken.deployBlock)}`);
    });
  }
});

test('a record missing an address is refused', () => {
  for (const broken of [
    { ...GOOD, vault: undefined },
    { ...GOOD, vault: '' },
    { ...GOOD, vault: '0xnotanaddress' },
    { ...GOOD, vault: '9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0' },
    { ...GOOD, asset: undefined },
    { ...GOOD, asset: '0x1234' },
  ]) {
    withRecord(broken, (path) => {
      assert.throws(() => readDeploymentRecord(path), /vault|asset/, `accepted ${JSON.stringify(broken)}`);
    });
  }
});

test('a record missing its chain id is refused', () => {
  withRecord({ ...GOOD, chainId: undefined }, (path) => {
    assert.throws(() => readDeploymentRecord(path), /chainId/);
  });
});

test('every problem is listed at once, not one per attempt', () => {
  // Fixing a record one error at a time is how somebody ends up running the loader
  // four times to learn four things.
  withRecord({ chainId: 'x', vault: 'nope', asset: 'nope', deployBlock: 'later' }, (path) => {
    try {
      readDeploymentRecord(path);
      assert.fail('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      for (const field of ['chainId', 'vault', 'asset', 'deployBlock']) {
        assert.match(message, new RegExp(field), `${field} should be named in the error`);
      }
    }
  });
});

test('a missing record says where to get one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-none-'));
  try {
    assert.throws(
      () => readDeploymentRecord(join(dir, 'absent.json')),
      // The message must say what to run, because the file is produced by another
      // repository and its absence is the first thing a new reader will hit.
      /dev-chain\.ps1|no deployment record/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed JSON is reported as malformed, not as a missing file', () => {
  withRecord('{ this is not json', (path) => {
    assert.throws(() => readDeploymentRecord(path), /not valid JSON/);
  });
});

// ------------------------------------------------------------------- loadConfig

test('loadConfig takes the identity from the record and the rest from the environment', () => {
  withRecord(GOOD, (path) => {
    const config = loadConfig({
      recordPath: path,
      env: { PORT: '9999', DATABASE_PATH: '/tmp/x.sqlite', MAX_CATCHUP_BLOCKS: '42', CONFIRMATIONS: '5' } as NodeJS.ProcessEnv,
    });

    assert.equal(config.vault, GOOD.vault, 'the address comes from the record');
    assert.equal(config.startBlock, 8, 'and so does the start block');
    assert.equal(config.apiPort, 9999, 'the port comes from the environment');
    assert.equal(config.databasePath, '/tmp/x.sqlite');
    assert.equal(config.maxCatchupBlocks, 42);
    assert.equal(config.confirmations, 5);
  });
});

/**
 * @dev The identity fields are deliberately NOT overridable.
 *
 * A record that says one chain and an environment that says another is a way to
 * index the wrong contract while every log line looks correct. Where the vault is is
 * not a deployment-time knob.
 */
test('the environment cannot redirect which contract is indexed', () => {
  withRecord(GOOD, (path) => {
    const config = loadConfig({
      recordPath: path,
      env: {
        VAULT: '0x000000000000000000000000000000000000dead',
        ASSET: '0x000000000000000000000000000000000000beef',
        START_BLOCK: '999999',
        CHAIN_ID: '1',
      } as NodeJS.ProcessEnv,
    });

    assert.equal(config.vault, GOOD.vault, 'VAULT in the environment must be ignored');
    assert.equal(config.asset, GOOD.asset, 'so must ASSET');
    assert.equal(config.startBlock, 8, 'so must START_BLOCK');
    assert.equal(config.chainId, 31337, 'so must CHAIN_ID');
  });
});

test('a non-numeric environment value is an error rather than a silent NaN', () => {
  withRecord(GOOD, (path) => {
    assert.throws(() => loadConfig({ recordPath: path, env: { PORT: 'soon' } as NodeJS.ProcessEnv }), /expected a number/);
  });
});

test('defaults are the documented ones, and the pair is internally consistent', () => {
  withRecord(GOOD, (path) => {
    const config = loadConfig({ recordPath: path, env: {} as NodeJS.ProcessEnv });
    assert.equal(config.maxCatchupBlocks, CONFIG_DEFAULTS.maxCatchupBlocks);
    assert.equal(config.maxCatchupSeconds, CONFIG_DEFAULTS.maxCatchupSeconds);

    // THE ARITHMETIC CHECK, which is the mistake the vault repository's
    // ARCHITECTURE.md section 7.2 records: a cron interval, a block bound and a time
    // bound can each look reasonable and be jointly impossible. Base produces a
    // block every 2.000 s, a 5-minute cron covers 150 blocks, and the bound must
    // cover that with margin.
    const blocksPerCron = 300 / 2.0; // 5 minutes at 2 s per block
    assert.ok(
      config.maxCatchupBlocks >= blocksPerCron,
      `maxCatchupBlocks (${config.maxCatchupBlocks}) must cover one cron interval (${blocksPerCron} blocks) or the catch-up can never close the gap`,
    );
  });
});
