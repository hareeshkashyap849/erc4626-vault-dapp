/**
 * The read-only query API.
 *
 * NO FRAMEWORK, AND THAT IS A CONSTRAINT RATHER THAN A PREFERENCE
 *
 * This service has no npm registry access -- `package.json` has an empty
 * `dependencies` for that reason, not by taste -- so Express, Fastify and their
 * transitive trees are not available. `node:http` is. What a framework would add here
 * is routing and body parsing: there are no bodies (every endpoint is a GET), and
 * four routes are a dispatch table, not a router.
 *
 * WHAT THIS FILE IS ACTUALLY CAREFUL ABOUT
 *
 *   VALIDATION IS NOT DEFAULTING. An unparseable `limit` is a 400 that says what was
 *   wrong. The tempting alternative -- `Number(q.limit) || 50` -- turns `?limit=abc`
 *   into a silent 50 and `?limit=0` into a silent 50 as well, so a client asking a
 *   question it got wrong is told nothing and handed an answer to a different one.
 *   Every parameter here is either parsed correctly or refused by name.
 *
 *   THE CAP IS ENFORCED, NOT DOCUMENTED. `limit` is clamped to the endpoint's cap
 *   BEFORE it reaches SQL, so `?limit=99999999` cannot make SQLite hand over the
 *   whole table. A cap that only exists in a comment is not a cap.
 *
 *   NO STACK TRACE EVER LEAVES. A thrown error is logged in full and answered with a
 *   short message. A stack trace in a JSON body is a map of the server's insides, and
 *   this endpoint is on the public internet.
 *
 *   EVERY RESPONSE IS `no-store`. A cached index response is a response about a
 *   database that has since moved on, served by a layer that will not say so.
 *
 * @see src/api/price.ts for the arithmetic and why it is a separate module.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { Store } from '../lib/db.ts';
import { priceSeries, type PricePoint } from './price.ts';

/**
 * The event kinds the indexer models. `decode.ts` is the source of these names --
 * `TOPICS`/`SIGNATURES` there are keyed by exactly these three strings, and
 * `VaultEventRow.kind` holds one of them.
 */
export const EVENT_KINDS = ['Deposit', 'Withdraw', 'YieldReported'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

const isEventKind = (value: string): value is EventKind => (EVENT_KINDS as readonly string[]).includes(value);

/**
 * Limits. Defaults and caps, in one place, because two places would drift.
 *
 * The key is `fallback`, matching what `intParam` destructures. It was `default` for
 * a while, which is why every price and events request answered 500: the destructure
 * produced `undefined`, `Number(undefined)` is `NaN`, and SQLite refused to bind it as
 * a LIMIT. `default` is also a reserved word, so the rename is an improvement twice
 * over.
 */
export const LIMITS = {
  price: { fallback: 500, max: 5000 },
  events: { fallback: 50, max: 500 },
} as const;

/**
 * The endpoints, as data. The 404 body and the CLI's startup banner both come from
 * this list, so a route cannot exist without being advertised or be advertised
 * without existing -- the two failures that make an API annoying to use.
 */
export const ENDPOINTS: readonly { path: string; description: string }[] = [
  { path: '/api/status', description: 'chain, vault, indexed block range, and whether the index is stale' },
  { path: '/api/price?limit=N', description: `share price series, oldest first (default ${LIMITS.price.fallback}, max ${LIMITS.price.max})` },
  { path: '/api/events?limit=N&kind=Deposit|Withdraw|YieldReported&account=0x...', description: `recent vault events, newest first (default ${LIMITS.events.fallback}, max ${LIMITS.events.max})` },
  { path: '/api/summary', description: 'event counts and summed assets per kind, plus the first and last event block' },
];

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const INTEGER_PATTERN = /^-?\d+$/;

export interface ApiServerConfig {
  chainId: number;
  vault: string;
  asset: string;
  /**
   * The vault's deployment block, from the deployment record the CLI loaded.
   *
   * Optional, and only used as a fallback: `indexer_state.startBlock` is what the rows
   * on disk were actually produced against, so it wins whenever there is any state.
   * This is here for the case where there is none -- a database that has never been
   * indexed still has a vault that was deployed at a known block, and the coverage note
   * needs something to compare the (empty) series against.
   */
  startBlock?: number;
  /**
   * The decimals the price is derived from, or undefined when they are unknown.
   *
   * Undefined is a real state and not a reason to guess: `readDecimals()` in the CLI
   * reads these off the chain, and if that read failed, inventing 18/6 would make
   * /api/price return numbers for a vault shape this service never verified. The
   * endpoint refuses instead.
   */
  decimals?: { assetDecimals: number; shareDecimals: number };
}

export interface Logger {
  info(message: string): void;
  error(message: string, err?: unknown): void;
}

export interface ServerOptions {
  store: Store;
  config: ApiServerConfig;
  logger?: Logger;
  /** Injected so `staleSeconds` is testable without waiting for a clock. */
  now?: () => number;
}

/** A request error with the HTTP status it should produce. */
class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const badRequest = (message: string): ApiError => new ApiError(400, message);

const defaultLogger: Logger = {
  info: (message) => console.log(`[api] ${message}`),
  error: (message, err) => console.error(`[api] ${message}`, err),
};

// --------------------------------------------------------------- query parsing

/**
 * One value for a parameter, or a 400 if it was sent more than once.
 *
 * `URLSearchParams.get` returns only the FIRST value, so `?limit=1&limit=2` looks
 * exactly like `?limit=1` and the second one is silently dropped. Whichever value a
 * server picks there, the client sent two different questions, and a silent pick is
 * how a client comes to believe a filter was applied when it was not. `getAll` is the
 * whole list, so the duplication is visible.
 */
function oneParam(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name);
  if (values.length === 0) return undefined;
  if (values.length > 1) throw badRequest(`${name} was given more than once`);
  return values[0];
}

/**
 * A required-format integer query parameter.
 *
 * `Number.parseInt` is not used. It stops at the first character it does not like,
 * so `parseInt('5abc')` is 5 and `parseInt('')` is NaN -- one silently accepts
 * rubbish, the other throws `NaN` into a SQL binding. And `NaN`, `-1` and `Infinity`
 * are each rejected explicitly rather than by luck: `Infinity` is the one that
 * matters, because it is a perfectly valid JS number and would reach SQLite as a
 * LIMIT that means "everything".
 */
function intParam(raw: string | undefined, name: string, { fallback, max }: { fallback: number; max: number }): number {
  if (raw === undefined) return fallback;

  const text = raw.trim();
  if (!INTEGER_PATTERN.test(text)) {
    throw badRequest(`${name} must be an integer, got "${raw}"`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw badRequest(`${name} is out of range: "${raw}"`);
  }
  if (value < 0) {
    throw badRequest(`${name} must not be negative, got ${value}`);
  }
  // Clamped, not rejected: `?limit=100000` is a request this API cannot serve in
  // full, and answering it with the largest page it does serve is more useful than
  // an error -- as long as the answer says so, which `limit` and `maxLimit` in the
  // body do.
  return Math.min(value, max);
}

function kindParam(raw: string | undefined): EventKind | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (!isEventKind(text)) {
    throw badRequest(`kind must be one of ${EVENT_KINDS.join(', ')}, got "${raw}"`);
  }
  return text;
}

function accountParam(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (!ADDRESS_PATTERN.test(text)) {
    throw badRequest(`account must be a 0x-prefixed 20-byte address, got "${raw}"`);
  }
  // Lower case, because `insertEvents` lower-cases the owner it decodes and the index
  // on the column holds what was written -- comparing mixed case would find nothing
  // and look like "this account did nothing" rather than like a bug.
  return text.toLowerCase();
}

// ------------------------------------------------------------------- responses

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // Every response here describes a database that is being written by the indexer
    // on a schedule. A cached one is a claim about a state that no longer holds.
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// -------------------------------------------------------------------- handlers

const decimalsOf = (config: ApiServerConfig): { assetDecimals: number; shareDecimals: number } => {
  const decimals = config.decimals;
  if (!decimals) {
    throw new ApiError(
      503,
      'share decimals are unknown: this process has not read decimals() from the vault, ' +
        'so the share price cannot be derived. The indexer CLI reads them at startup.',
    );
  }
  return decimals;
};

/**
 * How much of the vault's life the price series actually covers.
 *
 * WHY THIS IS IN THE BODY AND NOT ONLY IN THE README
 *
 * The series can begin LATER than the vault was deployed. A node does not necessarily
 * serve state at every block: the one this was developed against refuses `eth_call`
 * below about block 100 with `-32602 BlockOutOfRangeError`, because it was started
 * from a state snapshot and never had that history -- while `eth_getLogs` works from
 * block 8. So `vault_snapshots` simply has no rows before that point, and the indexer
 * records it in `indexer_log` as `series-derived` or `series-gap`.
 *
 * A chart drawn from that series without saying so implies the vault held nothing for
 * those blocks. It did not: nothing is known about them. That is the difference
 * between a gap in the data and a fact about the vault, and a client that has to read
 * the source to learn it will get it wrong.
 */
function coverageOf(store: Store, vaultStartBlock: number | undefined): unknown {
  const seriesFromBlock = store.seriesFromBlock();
  const eventsFromBlock = store.eventsFromBlock();

  /*
   * WHAT THE SERIES IS COMPARED AGAINST, and why it is not simply the deployment
   * block.
   *
   * The claim this flag makes is "there is a stretch between the deployment block and
   * the first price point about which nothing is known". That is true when the series
   * starts later than the earliest thing this service knows about -- which may be an
   * EVENT rather than a snapshot.
   *
   * An earlier version compared against the deployment block alone, so with events
   * recorded below the first snapshot it reported a gap in a region it had events for.
   * Both ways of being wrong are wrong, but they are not equally bad: claiming "nothing
   * happened here" when the truth is "this was not observed" asserts something about
   * the vault, while the reverse merely understates what is known. The conservative
   * comparison is the one that cannot invent activity or its absence.
   */
  const earliestKnown = [seriesFromBlock, eventsFromBlock, vaultStartBlock].filter((n): n is number => typeof n === 'number');
  const coverageBeginsAt = earliestKnown.length ? Math.min(...earliestKnown) : null;

  // `null` is not 0 and not the deployment block. It means the series is empty, which
  // is a different statement from "it starts at block 0".
  const startsLater = seriesFromBlock !== null && coverageBeginsAt !== null && seriesFromBlock > coverageBeginsAt;

  const note = startsLater
    ? `The price series begins at block ${seriesFromBlock}, but this service has records from block ${coverageBeginsAt}. ` +
      'NOTHING IS KNOWN about the blocks in between: the node serving this deployment does not hold state that far back, so no ' +
      'snapshot could be taken. This is a gap in the data, NOT a period of zero activity -- do not draw or read it as one.'
    : seriesFromBlock === null
      ? 'There are no snapshots at all, so the series is empty. This is not a vault with no activity; it is a vault this service has not read yet.'
      : `The series covers every block this service knows about, from ${seriesFromBlock} on.`;

  return {
    vaultStartBlock: vaultStartBlock ?? null,
    seriesFromBlock,
    eventsFromBlock,
    coverageBeginsAt,
    startsLaterThanDeployment: startsLater,
    note,
  };
}

function handleStatus(store: Store, config: ApiServerConfig, now: () => number): unknown {
  const state = store.getState();
  const nowMs = now();

  // `updatedAt` is returned twice on purpose: `updatedAt` as an ISO string because
  // that is what a human reads, and `staleSeconds` because that is what a monitor
  // alerts on. Deriving the second from the first would mean parsing a string back
  // into an instant to do arithmetic on it.
  const staleSeconds = state ? Math.max(0, Math.floor((nowMs - state.updatedAt) / 1000)) : 0;

  const lastIndexedBlock = state?.lastIndexedBlock;
  const chainHeadAtLastRun = state?.chainHeadAtLastRun;
  // The state's start block is where the indexer actually began; `config.startBlock`
  // is where the deployment record says the vault was deployed. They agree in normal
  // operation and the state wins, because it is what the rows on disk were produced
  // against.
  const startBlock = state?.startBlock ?? config.startBlock;

  return {
    // False when there is no state at all -- a fresh database has never been indexed,
    // which is not "healthy, with nothing in it". It is "this service has no idea
    // what the chain looks like", and a health check that cannot tell those apart
    // will pass on a service that has never once run.
    healthy: state !== undefined,
    chainId: config.chainId,
    vault: config.vault,
    asset: config.asset,
    startBlock,
    lastIndexedBlock,
    chainHeadAtLastRun,
    // How far behind the chain the last run left us. Named for what it is: the gap
    // against the head AS OF THE LAST RUN, not against the head now -- this process
    // is not connected to a node and cannot know the current head. A status endpoint
    // that silently implied otherwise would be reporting a freshness it cannot see.
    lagBlocks:
      lastIndexedBlock === undefined || chainHeadAtLastRun === undefined ? undefined : Math.max(0, chainHeadAtLastRun - lastIndexedBlock),
    eventCount: store.countEvents(),
    snapshotCount: store.countSnapshots(),
    // Both earliest blocks, because an empty or late-starting series is the one thing
    // about this service that looks like a fact and is not. See `coverageOf`.
    seriesFromBlock: store.seriesFromBlock(),
    eventsFromBlock: store.eventsFromBlock(),
    coverage: coverageOf(store, startBlock),
    updatedAt: state ? new Date(state.updatedAt).toISOString() : null,
    staleSeconds,
    note: 'lagBlocks is measured against the chain head recorded at the last indexer run, not against the chain now.',
  };
}

const PRICE_NOTE =
  'These prices are DERIVED ON READ from the raw totalAssets and totalSupply stored in vault_snapshots. ' +
  'They are not the price at any instant other than the block they were read at: each point is the vault ' +
  'as it stood AFTER that block, so no point predicts or interpolates a price between blocks, and the ' +
  'newest point is only as fresh as the last indexer run. One whole share is priced in asset base units ' +
  'and formatted with the asset decimals. `price` is null where totalSupply was 0 -- an empty vault has ' +
  'no price, and 1 would be an invented one.';

function handlePrice(store: Store, config: ApiServerConfig, params: URLSearchParams): unknown {
  const limit = intParam(oneParam(params, 'limit'), 'limit', LIMITS.price);
  const decimals = decimalsOf(config);

  const raw = store.priceSeries(limit);
  const points: PricePoint[] = priceSeries(raw, decimals);

  const state = store.getState();
  const coverage = coverageOf(store, state?.startBlock ?? config.startBlock);

  return {
    series: points,
    decimals: { asset: decimals.assetDecimals, share: decimals.shareDecimals },
    count: points.length,
    limit,
    maxLimit: LIMITS.price.max,
    // `seriesFromBlock` is hoisted to the top level as well as living inside
    // `coverage`, so a client that reads only the obvious fields still sees where the
    // series starts. `coverage.note` says what that means.
    seriesFromBlock: store.seriesFromBlock(),
    coverage,
    // Stated in the body rather than only in this file: a consumer that reads the
    // numbers and not the docs is the normal case, and this is the one thing about
    // them that is easy to get wrong.
    note: PRICE_NOTE,
  };
}

/** The event rows, filtered and newest-first. Values are bound, never interpolated. */
function queryEvents(store: Store, { limit, kind, account }: { limit: number; kind?: EventKind; account?: string }): unknown[] {
  const where: string[] = [];
  const bind: (string | number)[] = [];
  if (kind) {
    where.push('kind = ?');
    bind.push(kind);
  }
  if (account) {
    where.push('account = ?');
    bind.push(account);
  }

  const sql =
    `SELECT block_number AS blockNumber, log_index AS logIndex, block_hash AS blockHash, tx_hash AS txHash, ` +
    `kind, account, assets, shares, timestamp ` +
    `FROM vault_events ` +
    (where.length ? `WHERE ${where.join(' AND ')} ` : '') +
    // Tie-broken by log index so a page boundary cannot repeat or skip an event: two
    // events in one block share a block number, and ordering by that alone leaves
    // their relative order to the query planner.
    `ORDER BY block_number DESC, log_index DESC LIMIT ?`;

  return store.db.prepare(sql).all(...bind, limit) as unknown as unknown[];
}

function handleEvents(store: Store, params: URLSearchParams): unknown {
  const limit = intParam(oneParam(params, 'limit'), 'limit', LIMITS.events);
  const kind = kindParam(oneParam(params, 'kind'));
  const account = accountParam(oneParam(params, 'account'));

  const events = queryEvents(store, { limit, kind, account });

  return {
    events,
    count: events.length,
    limit,
    maxLimit: LIMITS.events.max,
    // Echoed so a client can tell an empty page from an ignored filter.
    filter: { kind: kind ?? null, account: account ?? null },
  };
}

/**
 * Totals from the event table.
 *
 * EVERY SUM IS A BigInt AND EVERY RESULT IS A STRING. `assets` is a uint256 --
 * 1.15e77 is a normal value for it, and the largest integer a JS number holds exactly
 * is 2**53-1, about 9e15. `Number(a) + Number(b)` on two real event amounts silently
 * returns a wrong number with the right number of digits, and JSON has no way to say
 * "this was approximate". Summing as BigInt and emitting decimal strings keeps the
 * value exact through `JSON.stringify`, which throws on BigInt precisely because
 * turning one into a number would be lossy.
 */
function handleSummary(store: Store): unknown {
  const kinds: Record<string, { count: number; assets: string }> = {};
  // Every known kind is present with a zero, so a client can read `kinds.Withdraw`
  // without checking whether any withdrawal has ever happened. An absent key and a
  // zero are different answers to "how many", and only one of them is this one.
  for (const kind of EVENT_KINDS) kinds[kind] = { count: 0, assets: '0' };

  // One pass, in JS, with BigInt accumulation. The tempting version is
  // `SELECT kind, SUM(assets) ... GROUP BY kind`, and it is wrong here for two
  // reasons: `assets` is stored as TEXT, so SQLite's SUM coerces it to a REAL and
  // loses precision above 2**53; and the result would come back as a number, which
  // this endpoint promises never to do. Summing as BigInt is exact for a uint256, and
  // `toString(10)` at the end is the only conversion.
  const totals = new Map<string, bigint>();
  const rows = store.db.prepare('SELECT kind, assets FROM vault_events').all() as unknown as { kind: string; assets: string | null }[];
  for (const row of rows) {
    const entry = kinds[row.kind];
    // A kind this API does not know is counted as unknown rather than folded into a
    // known one. It means the indexer wrote a kind the API was not told about, which
    // is a deployment mistake worth being able to see.
    if (!entry) continue;
    entry.count += 1;
    if (row.assets === null) continue;
    totals.set(row.kind, (totals.get(row.kind) ?? 0n) + BigInt(row.assets));
  }
  for (const [kind, sum] of totals) {
    kinds[kind]!.assets = sum.toString(10);
  }

  const range = store.db
    .prepare('SELECT MIN(block_number) AS firstBlock, MAX(block_number) AS lastBlock FROM vault_events')
    .get() as unknown as { firstBlock: number | null; lastBlock: number | null };

  const state = store.getState();
  const unknown = [...new Set(rows.filter((row) => !(row.kind in kinds)).map((row) => row.kind))];

  return {
    kinds,
    totalEvents: store.countEvents(),
    firstEventBlock: range.firstBlock,
    lastEventBlock: range.lastBlock,
    lastIndexedBlock: state?.lastIndexedBlock ?? null,
    unknownKinds: unknown,
    note:
      "assets is the SUM of each event's assets field as a uint256 decimal string -- exact, and never a JS number. " +
      "YieldReported carries the amount reported, not the vault's totalAssets at the time.",
  };
}

// ----------------------------------------------------------------------- server

export interface Handler {
  (req: IncomingMessage, res: ServerResponse): Promise<void>;
}

/**
 * The request handler, as a plain function.
 *
 * Exported on its own so it can be tested without a socket. A test that starts a
 * server is testing `node:http`; the parts worth testing here are routing, validation
 * and the price arithmetic, and all three are reachable from this function.
 */
export function createHandler({ store, config, logger = defaultLogger, now = Date.now }: ServerOptions): Handler {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // `req.url` is only a path for an origin-form request, which is all a GET can be
    // in practice. The guard is here because `new URL(undefined)` throws, and a
    // request line this server cannot parse should be a 400 about the request rather
    // than a 500 about the server.
    const raw = req.url;
    if (typeof raw !== 'string' || raw === '') {
      sendJson(res, 400, { error: 'the request had no URL' });
      return;
    }

    let path: string;
    let params: URLSearchParams;
    try {
      const url = new URL(raw, 'http://127.0.0.1');
      path = url.pathname.replace(/\/+$/, '') || '/';
      params = url.searchParams;
    } catch {
      sendJson(res, 400, { error: `could not parse the request URL: ${raw}` });
      return;
    }

    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('allow', 'GET, HEAD');
        sendJson(res, 405, { error: `this API is read-only: ${req.method} is not supported`, endpoints: ENDPOINTS });
        return;
      }

      switch (path) {
        case '/':
        case '/api':
          sendJson(res, 200, { service: 'erc4626-vault-dapp query API', endpoints: ENDPOINTS });
          return;
        case '/api/status':
          sendJson(res, 200, handleStatus(store, config, now));
          return;
        case '/api/price':
          sendJson(res, 200, handlePrice(store, config, params));
          return;
        case '/api/events':
          sendJson(res, 200, handleEvents(store, params));
          return;
        case '/api/summary':
          sendJson(res, 200, handleSummary(store));
          return;
        default:
          sendJson(res, 404, { error: `no such endpoint: ${path}`, endpoints: ENDPOINTS });
          return;
      }
    } catch (err) {
      // The one place a thrown error becomes a response. A 4xx from validation is the
      // client's problem and is reported as it was written; anything else is logged
      // with its stack and answered with a sentence, because a stack trace in a JSON
      // body tells an attacker where to aim and tells a user nothing.
      if (err instanceof ApiError) {
        sendJson(res, err.status, { error: err.message, path });
        return;
      }
      logger.error(`unhandled error serving ${path}`, err);
      if (res.headersSent) {
        res.end();
        return;
      }
      try {
        sendJson(res, 500, { error: 'internal error; the failure was logged and no data was served' });
      } catch {
        // The response is already unusable. Nothing further can be said to the client,
        // and the log line above is the record.
        res.destroy();
      }
    }
  };
}

/** Start the API on 127.0.0.1. Loopback only: there is no authentication here. */
export function createServer(options: ServerOptions & { port: number }): Server {
  const handler = createHandler(options);
  return createHttpServer((req, res) => {
    void handler(req, res);
  });
}
