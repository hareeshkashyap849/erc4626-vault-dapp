# erc4626-vault-dapp

**The service behind the vault's front end: an event indexer, a SQLite snapshot, and
a read-only query API.**

> **Status: P4, in progress.** The vault it indexes lives in
> [`erc4626-vault`](https://github.com/hareeshkashyap849/erc4626-vault) — contract,
> tests, and the wallet dApp. This repository is the TypeScript service.

## Why this is a separate repository

By **language and deployment surface**, not by "contract vs front end":

| Repository | Contains | Changes |
|---|---|---|
| `erc4626-vault` | Solidity contract, its Foundry tests, deployment scripts, `deployments/`, and the wallet dApp | freezes once the vault is deployed |
| **`erc4626-vault-dapp`** (this one) | the event indexer, the SQLite database, and the query API | keeps being developed |

The vault is deployed once and is then immutable, so the contract and everything that
talks to it belong together — that is what makes "the code you are reading is the code
on chain" a checkable statement. A service with a database and a deployment of its own
does not belong in that repository.

## What it is for

The wallet dApp reads the chain directly, which is correct for balances and always
current. It cannot answer questions about the **past**:

- what the share price has been over time (the thing a chart needs)
- every deposit and withdrawal, by whom
- how much yield has been reported, and when
- the vault's history when the page was not open

Those need an indexer, because a node will not answer "give me every Deposit event
since deployment" cheaply or reliably, and because a chart needs a price at every
block rather than the price right now.

## Not written yet

This file is the only thing in the repository so far. The plan, the measured
constraints it follows, and the parameters that were initially wrong are in the
vault repository's `ARCHITECTURE.md` §7 — recorded there because they were derived
while designing the vault's deployment, and they are the reason this service is
scheduled rather than resident.

## Licence

MIT. See `LICENSE`.
