/**
 * The indexer's command line.
 *
 * TWO BOUNDS, AND A RECORD OF WHERE IT GOT TO.
 *
 * This runs on a schedule rather than as a resident process -- no free hosting tier
 * runs a long-lived process -- so a run MUST finish. Both a block bound and a
 * wall-clock bound apply, and if either stops the run it stops cleanly with its
 * progress recorded, so the next run resumes rather than starting over. An unbounded
 * catch-up is a run that gets killed halfway with nothing written about how far it
 * went.
 *
 * `--verify-topics` is the default and can be turned off only with an explicit flag,
 * because the check is cheap and the failure it prevents is invisible: a decoder
 * registered under a wrong topic drops events silently and produces history that
 * looks complete.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config.ts';
import { openStore } from '../lib/db.ts';
import { RpcClient } from '../lib/rpc.ts';
import { keccak256 } from '../lib/keccak.ts';
import { Indexer } from './indexer.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const verbose = flag('verbose');

async function main(): Promise<number> {
  const config = loadConfig({ recordPath: option('record') });

  if (verbose) {
    console.log(`deployment record : ${config.recordPath}`);
    console.log(`vault             : ${config.vault}`);
    console.log(`asset             : ${config.asset}`);
    console.log(`chainId           : ${config.chainId}`);
    console.log(`startBlock        : ${config.startBlock}`);
    console.log(`rpc               : ${config.rpcUrl}`);
    console.log(`database          : ${config.databasePath}`);
  }

  const store = openStore(config.databasePath);
  const rpc = new RpcClient(config.rpcUrl);

  // Check the chain before touching the database. Indexing one chain's blocks into
  // a database that describes another produces a mixture that no later run can
  // untangle -- the block numbers overlap and the hashes do not.
  const chainId = await rpc.chainId();
  if (chainId !== config.chainId) {
    console.error(
      `the chain at ${config.rpcUrl} is ${chainId}, but the deployment record is for ${config.chainId}.\n` +
        'Refusing to index: the block numbers would overlap and the hashes would not.',
    );
    store.close();
    return 1;
  }

  const indexer = new Indexer(store, rpc, {
    vault: config.vault,
    asset: config.asset,
    startBlock: config.startBlock,
    chainId: config.chainId,
    rpcUrl: config.rpcUrl,
  });

  if (!flag('no-verify-topics')) {
    indexer.verifyTopics(keccak256);
    if (verbose) console.log('event topics verified against their signatures');
  }
  indexer.verbose = verbose;

  const result = await indexer.run({
    maxBlocks: Number(option('max-blocks', String(config.maxCatchupBlocks))),
    maxSeconds: Number(option('max-seconds', String(config.maxCatchupSeconds))),
    confirmations: config.confirmations,
    keccak256,
  });

  console.log(
    [
      `scanned   ${result.blocksScanned} block(s)  ${result.fromBlock}..${result.toBlock}`,
      `inserted  ${result.eventsInserted} event(s), ${result.transfersInserted} transfer(s), ${result.snapshotsWritten} snapshot(s)`,
      `chain     head ${result.chainHead}`,
      `reorg     ${result.reorgDepth === 0 ? 'none' : `${result.reorgDepth} block(s) rolled back`}`,
      `elapsed   ${result.elapsedMs}ms`,
      result.truncated ? `TRUNCATED a bound stopped this run before the head; the next run continues` : 'caught up',
    ].join('\n'),
  );

  if (result.unknownLogs > 0) {
    // Reported rather than ignored: these are events this indexer does not model, so
    // they are gaps in what it knows. A gap nobody can see is one nobody can fix.
    console.warn(`\nwarning: ${result.unknownLogs} log(s) from the vault matched no known event`);
  }

  store.close();
  return result.truncated ? 0 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`indexer failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });

export { REPO };
