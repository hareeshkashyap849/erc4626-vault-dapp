/**
 * The API's command line.
 *
 * STARTUP IS TWO STEPS, AND THE ORDER MATTERS.
 *
 * "B" -- the deployment plan's name for it -- is a bounded catch-up before the first
 * request is served. Without it, a process started after a quiet period answers
 * `/api/price` from a database that stopped at the last cron run, and it answers
 * confidently: the numbers are real, they are just old, and nothing in the response
 * says so. Running the indexer once at startup means the API is never more stale than
 * one bounded run.
 *
 * "BOUNDED" IS THE WHOLE POINT. `maxCatchupBlocks` and `maxCatchupSeconds` both
 * apply, so a service that has been down for a week does not spend that week catching
 * up before it will accept a connection. It indexes what it can afford and SERVES THE
 * REST: `lagBlocks` in `/api/status` reports the gap, which is the honest version of
 * "not caught up" -- as opposed to an API that is simply not answering.
 *
 * A FAILED CATCH-UP IS NOT A FAILED STARTUP. The catch-up needs a node. The API needs
 * only the database. If the node is unreachable, refusing to start would turn a stale
 * read-only API into no API at all -- strictly worse, since the database on disk is
 * still a correct record of everything indexed so far. So the failure is logged with
 * its reason and the server starts anyway. What is NOT done is starting with stale
 * in-memory numbers that look fresh: `updatedAt` and `staleSeconds` in the status
 * response are read from the database, so they keep saying how old the data is.
 *
 * SHARE DECIMALS ARE READ FROM THE CHAIN, NOT ASSUMED. The price formula needs both
 * decimal counts, and getting the share count wrong is exactly the 4%-low bug the
 * price module is written around. They are read through `decimals()` on the vault and
 * on the asset. If that read fails the API still starts, and `/api/price` answers 503
 * -- it does not fall back to 18/6 and print plausible numbers for a vault shape
 * nobody verified.
 *
 * @see src/api/server.ts for the endpoints, src/api/price.ts for the arithmetic.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, type Config } from '../config.ts';
import { openStore, type Store } from '../lib/db.ts';
import { RpcClient } from '../lib/rpc.ts';
import { keccak256 } from '../lib/keccak.ts';
import { Indexer } from '../indexer/indexer.ts';
import { createServer, ENDPOINTS, type ApiServerConfig } from './server.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

const stamp = (): string => new Date().toISOString();

const log = {
  info: (message: string): void => console.log(`${stamp()} [api] ${message}`),
  error: (message: string, err?: unknown): void =>
    console.error(`${stamp()} [api] ${message}`, err instanceof Error ? (err.stack ?? err.message) : (err ?? '')),
};

/** `decimals()` -- the ERC-20 selector, which both the vault and the asset implement. */
const DECIMALS_SELECTOR = '0x313ce567';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

/**
 * Read `decimals()` from a token at a given block.
 *
 * Returns undefined rather than throwing, because every caller treats "unknown" as a
 * state it can serve around. A `uint8` comes back in a 32-byte word; anything shorter
 * than a word is a node answering with something that is not an ABI-encoded uint.
 */
async function readDecimals(rpc: RpcClient, address: string, blockNumber: number): Promise<number | undefined> {
  const result = await rpc.call<string>('eth_call', [
    { to: address, data: DECIMALS_SELECTOR },
    `0x${blockNumber.toString(16)}`,
  ]);
  if (typeof result !== 'string' || result.length < 66) return undefined;
  const value = Number(BigInt(result));
  return Number.isInteger(value) && value >= 0 && value <= 255 ? value : undefined;
}

/**
 * The decimals the price needs, or undefined when they could not be read.
 *
 * Pinned to a block so the two reads and the snapshots they price are from one
 * consistent view. Left to "latest", the asset could be mid-upgrade between the two
 * calls and the offset would be a mix of two contracts.
 */
async function readPriceDecimals(rpc: RpcClient, config: Config): Promise<ApiServerConfig['decimals']> {
  const blockNumber = await rpc.blockNumber();
  const [assetDecimals, shareDecimals] = await Promise.all([
    readDecimals(rpc, config.asset, blockNumber),
    readDecimals(rpc, config.vault, blockNumber),
  ]);

  if (assetDecimals === undefined || shareDecimals === undefined) {
    log.error(
      `could not read decimals() at block ${blockNumber} ` +
        `(asset ${config.asset} -> ${assetDecimals ?? 'unreadable'}, vault ${config.vault} -> ${shareDecimals ?? 'unreadable'}). ` +
        '/api/price will answer 503 rather than price the vault with assumed decimals.',
    );
    return undefined;
  }

  log.info(`decimals read from the chain: asset ${assetDecimals}, shares ${shareDecimals} (offset ${shareDecimals - assetDecimals})`);
  return { assetDecimals, shareDecimals };
}

/**
 * "B": one bounded catch-up run, logging what it did.
 *
 * Never throws. The caller's next line starts the server whatever happened here,
 * which is the decision explained at the top of this file.
 */
async function catchUp(store: Store, config: Config, indexer: Indexer): Promise<void> {
  log.info(
    `catching up: up to ${config.maxCatchupBlocks} block(s) or ${config.maxCatchupSeconds}s, ` +
      `from ${config.startBlock}, against ${config.rpcUrl}`,
  );

  try {
    const result = await indexer.run({
      maxBlocks: config.maxCatchupBlocks,
      maxSeconds: config.maxCatchupSeconds,
      confirmations: config.confirmations,
      // The same check the indexer CLI runs. A topic that does not match its
      // signature drops events silently, and a price chart missing exactly the yield
      // reports is worse than one that refused to build.
      keccak256,
    });

    log.info(
      `catch-up: scanned ${result.blocksScanned} block(s) ${result.fromBlock}..${result.toBlock}; ` +
        `inserted ${result.eventsInserted} event(s), ${result.transfersInserted} transfer(s), ${result.snapshotsWritten} snapshot(s); ` +
        `chain head ${result.chainHead}; reorg ${result.reorgDepth === 0 ? 'none' : `${result.reorgDepth} block(s) rolled back`}; ` +
        `${result.elapsedMs}ms`,
    );
    if (result.truncated) {
      log.info('catch-up stopped at a bound before the chain head; the API will report the remaining lag rather than hide it');
    }
    if (result.unknownLogs > 0) {
      log.info(`${result.unknownLogs} log(s) from the vault matched no known event -- counted, not ignored`);
    }
  } catch (err) {
    log.error(
      'catch-up failed; starting anyway and serving what the database already holds. ' +
        'The status endpoint reports how old that is.',
      err,
    );
  }
}

async function main(): Promise<number> {
  const config = loadConfig({ recordPath: option('record') });
  const verbose = flag('verbose');

  if (verbose) {
    log.info(`deployment record : ${config.recordPath}`);
    log.info(`vault             : ${config.vault}`);
    log.info(`asset             : ${config.asset}`);
    log.info(`chainId           : ${config.chainId}`);
    log.info(`startBlock        : ${config.startBlock}`);
    log.info(`database          : ${config.databasePath}`);
  }

  // The store is opened before anything can fail, because a failed catch-up must
  // still leave a database to serve.
  const store = openStore(config.databasePath);
  const rpc = new RpcClient(config.rpcUrl, { timeoutMs: 20_000 });

  log.info(`opening ${config.databasePath}: ${store.countEvents()} event(s), ${store.countSnapshots()} snapshot(s) before this run`);

  const indexer = new Indexer(store, rpc, {
    vault: config.vault,
    asset: config.asset,
    startBlock: config.startBlock,
    chainId: config.chainId,
    rpcUrl: config.rpcUrl,
  });

  await catchUp(store, config, indexer);

  // Read after the catch-up, so a fresh database gets its decimals from the same run
  // that filled it. A failure here degrades one endpoint rather than the process.
  let decimals: ApiServerConfig['decimals'];
  try {
    decimals = await readPriceDecimals(rpc, config);
  } catch (err) {
    log.error('could not reach the chain to read decimals; /api/price will answer 503', err);
  }

  const apiConfig: ApiServerConfig = {
    chainId: config.chainId,
    vault: config.vault,
    asset: config.asset,
    ...(decimals ? { decimals } : {}),
  };

  const server = createServer({ store, config: apiConfig, logger: log, port: config.apiPort });

  const listening = new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(config.apiPort, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  try {
    await listening;
  } catch (err) {
    log.error(`could not listen on 127.0.0.1:${config.apiPort}`, err);
    store.close();
    return 1;
  }

  const url = `http://127.0.0.1:${config.apiPort}`;
  log.info(`listening on ${url} (loopback only -- this API has no authentication)`);
  log.info('endpoints:');
  for (const endpoint of ENDPOINTS) log.info(`  GET ${endpoint.path}`);
  log.info(`  ${ENDPOINTS.map((e) => e.path).length} endpoint(s); everything else is a 404 with the list in the body`);

  // A clean shutdown matters here for one reason: SQLite in WAL mode leaves its
  // `-wal` file behind if the process is killed, and the next reader has to recover
  // it. Closing the store checkpoints and removes it.
  //
  // `process.exitCode` rather than `process.exit()` -- the same fix as the indexer CLI, for
  // the same reason. `process.exit()` while `node:sqlite`'s native handle is still tearing
  // down trips `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and the process dies
  // with 0xC0000409 instead of 0. The indexer hit that on EVERY run; this server only hits it
  // on shutdown, which is rarer and therefore easier to misread as "SIGINT is flaky".
  //
  // `done` guards against closing the store twice, which the two paths below would otherwise
  // do whenever `server.close` finishes inside the 2-second window.
  const shutdown = (signal: string): void => {
    log.info(`${signal} received; closing the database and exiting`);
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      store.close();
      // Nothing is left running, so the event loop drains and the process exits with this
      // status on its own.
      process.exitCode = 0;
    };
    server.close(finish);
    // A keep-alive connection that never closes would hold the process open past the
    // point of usefulness.
    setTimeout(finish, 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return 0;
}

// Only run when executed directly, so `main` can be imported by a test or a tool
// without starting a listener as a side effect.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      log.error('the API failed to start', err);
      process.exitCode = 1;
    });
}

export { main, REPO };
