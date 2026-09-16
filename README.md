# erc4626-vault-dapp

**The service behind the vault's front end: an event indexer, a SQLite snapshot, and
a read-only query API.**

The vault it indexes lives in
[`erc4626-vault`](https://github.com/hareeshkashyap849/erc4626-vault) — the contract,
its Foundry tests, the deployment scripts, `deployments/`, and the wallet dApp.

## Why this is a separate repository

By **language and deployment surface**, not by "contract vs front end":

| Repository | Contains | Changes |
|---|---|---|
| `erc4626-vault` | Solidity contract, its tests, deployment scripts, `deployments/`, and the wallet dApp | freezes once the vault is deployed |
| **`erc4626-vault-dapp`** (this one) | the event indexer, the SQLite database, and the query API | keeps being developed |

The vault is deployed once and is then immutable, so the contract and everything that
talks to it belong together — that is what makes "the code you are reading is the code
on chain" a checkable statement. A service with a database and a deployment of its own
does not belong in that repository.

## What it is for

The wallet dApp reads the chain directly, which is correct for balances and always
current. It cannot answer questions about the **past**:

- what the share price has been over time — the thing a chart needs
- every deposit and withdrawal, by whom
- how much yield has been reported, and when
- anything that happened while the page was closed

Those need an index, because a node will not answer "give me every Deposit since
deployment" cheaply or reliably, and because a price chart needs the price at every
block rather than the price right now.

## Run it

```bash
node --experimental-strip-types src/indexer/cli.ts --verbose   # index new blocks
node --experimental-strip-types src/api/cli.ts                 # serve the query API
node tools/run-all.mjs                                         # every check
```

No `npm install`. There are **no runtime dependencies**: SQLite is Node's own
`node:sqlite`, the HTTP server is `node:http`, and the tests use `node:test`. Node 22
or newer, and nothing else.

The vault's address and start block are not configured here — they are read from
`../erc4626-vault/deployments/<chain>.json`, which is the single place they are known.
Point `DEPLOYMENT_RECORD` elsewhere to index a different deployment.

## The API

| Endpoint | Returns |
|---|---|
| `GET /api/status` | chain, vault, indexed range, lag, staleness, and whether the index is healthy |
| `GET /api/price?limit=N` | the share price series, oldest first |
| `GET /api/events?limit=N&kind=…&account=0x…` | recent deposits, withdrawals and yield reports |
| `GET /api/summary` | counts and totals per event kind, as exact decimal strings |

Every limit is capped, and the response says what the cap was rather than silently
returning less. Unknown parameters produce a 400 naming the problem.

## The three decisions worth knowing

**The share price is not stored.** `vault_snapshots` holds the raw `totalAssets` and
`totalSupply` as they stood after each block, and the API computes the price on read.
A formula that turns out to be wrong can then be fixed against rows that still exist,
instead of being frozen into the database.

**That table has to exist because the contract has no price event.** `reportYield`
raises `totalAssets` and mints nothing, so the share price moves with no event that
carries the new totals. A series reconstructed from events alone would be missing
exactly the jumps a chart exists to show.

**Event topics are verified, not remembered.** `assertTopics()` refuses to start on a
mismatch, and the tests recompute all four topics with a local keccak256 and compare
them against `topic0` values taken from **real logs**. This is not ceremony: the first
version registered `YieldReported` under a zero placeholder, which matches no log, so
every yield report would have been silently dropped and the chart would have been
missing its most interesting moments — with no error anywhere.

## A limitation, stated rather than hidden

A node does not necessarily serve state at every block. The one this was developed
against refuses `eth_call` below roughly block 100 (`-32602 BlockOutOfRangeError`,
because it was started from a state snapshot) while serving `eth_getLogs` from block 8.

So the price series can legitimately **begin later than the deployment block**. The
indexer walks forward from the first readable block and records which points it read
and which it derived from events; the API reports `seriesFromBlock` and says in words
that the blocks before it are **not known**, rather than reporting zero activity.
`tools/verify-against-chain.ts` prints the gap.

## What is not done

- **Not deployed.** The cron workflow exists and has not run against a public network,
  because that needs a funded deployment in the vault repository first (its P2).
- **No reorg test against a real chain.** The rollback path is tested against the
  database, not against a chain that actually reorganised.
- **The API is read-only and unauthenticated**, which is correct for public on-chain
  data and is stated so nobody mistakes it for a service with a trust boundary.

## Licence

MIT. See `LICENSE`.
