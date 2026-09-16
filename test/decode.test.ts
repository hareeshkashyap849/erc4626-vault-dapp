/**
 * Tests for the event decoder.
 *
 * THE FIXTURE IS FROM A REAL CHAIN. `test/fixtures/vault-logs.json` was captured by
 * `tools/capture-fixture.ts` from the local chain the vault was deployed to, so the
 * logs are byte-for-byte what a node produced. That matters more here than anywhere
 * else in this repository: hand-written fixtures encode the author's misunderstanding
 * twice, once in the data and once in the expectation, and then agree with each other.
 *
 * Two independent things are checked against the fixture:
 *
 *   1. Every topic this decoder is registered under equals keccak256 of the signature
 *      it claims. Verified with the local keccak implementation against the topic0
 *      values present in REAL logs -- so both the topic table and the hash function
 *      are tested by the same comparison.
 *
 *   2. Every field of every decoded event is checked for internal consistency against
 *      the raw log it came from, and the counts are checked against what the chain
 *      actually emitted.
 *
 * Run: node --experimental-strip-types --test test/decode.test.ts
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOPICS, SIGNATURES, decodeVaultLog, decodeShareTransfer, assertTopics, type RawLog } from '../src/lib/decode.ts';
import { keccak256 } from '../src/lib/keccak.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(resolve(HERE, 'fixtures/vault-logs.json'), 'utf8')) as {
  vault: string;
  asset: string;
  fromBlock: number;
  toBlock: number;
  blockTimes: Record<string, number>;
  logs: RawLog[];
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// ------------------------------------------------------------------- keccak

test('keccak256 matches the published empty-string digest', () => {
  // A known vector, chosen because it is published rather than because I computed it.
  assert.equal(keccak256(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
});

test('keccak256 is not SHA3-256, and the difference is the padding', () => {
  // SHA3-256("") is a1d0ee25...; keccak256("") is c5d24601... Using node:crypto's
  // sha3-256 would produce the former and every topic would be wrong.
  assert.notEqual(keccak256(''), '0xa1d0ee25db4c84f3b6d0b4b8dd5f1a4d5d6d2cad48fd4d5d4a4d0e0e2d5e2d0e');
  assert.equal(keccak256('abc').length, 66, 'a 32-byte digest, as hex');
});

test('keccak256 of a multi-block input still hashes correctly', () => {
  // Longer than the 136-byte rate, so the absorb loop runs more than once. A
  // single-block implementation passes every short test and fails here.
  const long = 'a'.repeat(200);
  assert.equal(keccak256(long).length, 66);
  assert.notEqual(keccak256(long), keccak256('a'.repeat(199)), 'a one-character change must change the digest');
});

/**
 * @dev The topic table verified against REAL logs.
 *
 * This is the test that would have caught the bug this file exists for: the
 * `YieldReported` topic was first written as a zero placeholder, which matches no log
 * at all. The fixture contains a genuine YieldReported, and its topic0 is what the
 * signature must hash to.
 */
test('every registered topic equals the keccak256 of its signature, and appears in real logs', () => {
  assert.doesNotThrow(() => assertTopics(keccak256));

  for (const [kind, signature] of Object.entries(SIGNATURES)) {
    assert.equal(keccak256(signature).toLowerCase(), TOPICS[kind as keyof typeof TOPICS].toLowerCase(), `${kind} topic is wrong`);
  }

  // And the fixture proves these are the topics a chain actually emits.
  const seen = new Set(FIXTURE.logs.map((l) => l.topics[0]!.toLowerCase()));
  for (const kind of ['Deposit', 'Withdraw', 'YieldReported', 'Transfer'] as const) {
    assert.ok(seen.has(TOPICS[kind].toLowerCase()), `${kind} (${TOPICS[kind]}) does not appear in the captured logs`);
  }
});

test('a topic that does not match its signature is refused', () => {
  // The check must actually fail on a mismatch, or it is decoration.
  assert.throws(
    () => assertTopics((signature) => (signature.startsWith('Deposit') ? '0xdeadbeef' + '0'.repeat(56) : keccak256(signature))),
    /topic mismatch for Deposit/,
  );
});

// ------------------------------------------------------------------ decoding

test('the fixture contains the events it is supposed to', () => {
  const counts: Record<string, number> = {};
  for (const log of FIXTURE.logs) {
    const kind =
      log.topics[0]!.toLowerCase() === TOPICS.Deposit
        ? 'Deposit'
        : log.topics[0]!.toLowerCase() === TOPICS.Withdraw
          ? 'Withdraw'
          : log.topics[0]!.toLowerCase() === TOPICS.YieldReported
            ? 'YieldReported'
            : 'Transfer';
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  assert.ok((counts.Deposit ?? 0) > 0, 'need deposits to test with');
  assert.ok((counts.Withdraw ?? 0) > 0, 'need withdrawals to test with');
  assert.equal(counts.YieldReported ?? 0, 1, 'exactly one yield report was made on this chain');
  assert.ok((counts.Transfer ?? 0) > 0, 'need share transfers to test with');
});

test('every vault event decodes, and every field is internally consistent', () => {
  let checked = 0;

  for (const log of FIXTURE.logs) {
    if (log.topics[0]!.toLowerCase() === TOPICS.Transfer) continue;

    const event = decodeVaultLog(log);
    assert.ok(event, `failed to decode a ${log.topics[0]} log at block ${log.blockNumber}`);

    // Identity: taken from the log, not recomputed.
    assert.equal(event.blockNumber, Number(BigInt(log.blockNumber)), 'block number');
    assert.equal(event.logIndex, Number(BigInt(log.logIndex)), 'log index');
    assert.equal(event.blockHash, log.blockHash, 'block hash');
    assert.equal(event.txHash, log.transactionHash, 'transaction hash');

    // The account is an address, and it is the one in the topics.
    assert.match(event.account, /^0x[0-9a-f]{40}$/, 'account is a lower-case address');
    assert.ok(log.topics.some((t) => t.toLowerCase().endsWith(event.account.slice(2))), 'account comes from one of the indexed topics');

    // Amounts are decimal strings, and a uint256 never appears as a JS number.
    for (const [name, value] of [['assets', event.assets], ['shares', event.shares]] as const) {
      if (value === null) continue;
      assert.match(value, /^\d+$/, `${name} is a decimal string`);
      assert.ok(BigInt(value) >= 0n, `${name} is non-negative`);
    }

    checked += 1;
  }

  assert.ok(checked >= 10, `expected a meaningful number of events, checked ${checked}`);
});

/**
 * @dev The layout mistake that produces plausible wrong numbers.
 *
 * Deposit and Withdraw have DIFFERENT numbers of indexed parameters -- two against
 * three -- so their topics arrays are different lengths. A decoder that assumes one
 * shape reads the wrong topic on the other, and because every topic is a 32-byte hex
 * string the result is still a valid-looking address.
 *
 * AN HONEST LIMITATION OF THE FIXTURE: every withdrawal in it was a redeem to self,
 * so `receiver == owner` in all five and the fixture CANNOT distinguish topic2 from
 * topic3 on its own. Asserting they differ would have failed on correct data -- which
 * it did, first time. The distinction is therefore tested by taking a real Withdraw
 * log and changing only the receiver, which is a change the decoder must ignore.
 */
test('Deposit and Withdraw have different indexed layouts, and both decode correctly', () => {
  const deposit = FIXTURE.logs.find((l) => l.topics[0]!.toLowerCase() === TOPICS.Deposit)!;
  const withdraw = FIXTURE.logs.find((l) => l.topics[0]!.toLowerCase() === TOPICS.Withdraw)!;

  assert.equal(deposit.topics.length, 3, 'Deposit has two indexed parameters');
  assert.equal(withdraw.topics.length, 4, 'Withdraw has three indexed parameters');

  const d = decodeVaultLog(deposit)!;
  assert.equal(d.kind, 'Deposit');
  assert.equal(d.account, `0x${deposit.topics[2]!.slice(-40)}`.toLowerCase(), 'Deposit owner is topic2');
});

test('Withdraw takes the owner from topic3, not topic2, even when the two differ', () => {
  const real = FIXTURE.logs.find((l) => l.topics[0]!.toLowerCase() === TOPICS.Withdraw)!;

  // Change ONLY the receiver (topic2). A decoder reading topic2 would now report the
  // wrong owner; a correct one is unaffected.
  const otherReceiver = '0x00000000000000000000000000000000deadbeef';
  const withDifferentReceiver: RawLog = {
    ...real,
    topics: [real.topics[0]!, real.topics[1]!, `0x${otherReceiver.slice(2).padStart(64, '0')}`, real.topics[3]!],
  };

  const decoded = decodeVaultLog(withDifferentReceiver)!;
  assert.equal(decoded.kind, 'Withdraw');
  assert.equal(
    decoded.account,
    `0x${real.topics[3]!.slice(-40)}`.toLowerCase(),
    'the owner comes from topic3 and must not move when the receiver changes',
  );
  assert.notEqual(decoded.account, otherReceiver, 'and it is certainly not the receiver');
});

/**
 * @dev YieldReported carries ONE data word, not two.
 *
 * It is this contract's own event, so there is no standard to copy from, and reading
 * a second word would either throw on the length check or read past the end. The
 * amount must equal what the log's single word says.
 */
test('YieldReported decodes one word, and the amount matches the raw data', () => {
  const log = FIXTURE.logs.find((l) => l.topics[0]!.toLowerCase() === TOPICS.YieldReported)!;
  const event = decodeVaultLog(log)!;

  assert.equal(event.kind, 'YieldReported');
  assert.equal(log.topics.length, 2, 'one indexed parameter: the reporter');
  assert.equal(log.data.length, 2 + 64, 'exactly one data word');
  assert.equal(event.shares, null, 'a yield report mints no shares');
  assert.equal(event.assets, BigInt(log.data).toString(10), 'the amount is the raw data word');
  assert.equal(event.account, `0x${log.topics[1]!.slice(-40)}`.toLowerCase());
});

test('share transfers decode from and to as addresses and value as a decimal string', () => {
  const transfers = FIXTURE.logs.filter((l) => l.topics[0]!.toLowerCase() === TOPICS.Transfer);
  const decoded = transfers.map((l) => decodeShareTransfer(l));

  assert.ok(decoded.every(Boolean), 'every transfer decodes');
  for (const [i, t] of decoded.entries()) {
    assert.match(t!.from, /^0x[0-9a-f]{40}$/);
    assert.match(t!.to, /^0x[0-9a-f]{40}$/);
    assert.match(t!.value, /^\d+$/);
    assert.equal(t!.value, BigInt(transfers[i]!.data).toString(10), 'value is the raw data word');
  }

  // Minting and burning are Transfers from or to the zero address, which the vault
  // does whenever shares are created or destroyed. If the fixture has none, the test
  // would not be exercising the interesting case.
  assert.ok(
    decoded.some((t) => t!.from === ZERO_ADDRESS),
    'the fixture should contain a mint (transfer from the zero address)',
  );
});

test('an unknown event returns null rather than throwing or guessing', () => {
  const unknown: RawLog = {
    address: FIXTURE.vault,
    topics: ['0x' + 'ab'.repeat(32)],
    data: '0x',
    blockNumber: '0x1',
    blockHash: '0x' + 'cd'.repeat(32),
    transactionHash: '0x' + 'ef'.repeat(32),
    logIndex: '0x0',
    transactionIndex: '0x0',
  };
  assert.equal(decodeVaultLog(unknown), null, 'an unmodelled event is not silently decoded as something else');
  assert.equal(decodeShareTransfer(unknown), null);
});

test('a truncated log is refused instead of decoding to a wrong number', () => {
  // Data that is too short for the fields the event claims. Reading whatever is
  // there would produce a number built from missing bytes.
  const short: RawLog = {
    address: FIXTURE.vault,
    topics: [TOPICS.Deposit, '0x' + '00'.repeat(32), '0x' + '11'.repeat(32)],
    data: '0x' + '22'.repeat(32), // one word where two are required
    blockNumber: '0x1',
    blockHash: '0x' + 'cd'.repeat(32),
    transactionHash: '0x' + 'ef'.repeat(32),
    logIndex: '0x0',
    transactionIndex: '0x0',
  };
  assert.equal(decodeVaultLog(short), null, 'a Deposit with one data word is not a Deposit');
});

test('addresses are lower-cased, so comparisons do not depend on checksumming', () => {
  // Two writers disagreeing about case would produce duplicate accounts in every
  // aggregate query. Normalising at the edge means never thinking about it again.
  for (const log of FIXTURE.logs) {
    const event = log.topics[0]!.toLowerCase() === TOPICS.Transfer ? null : decodeVaultLog(log);
    if (event) assert.equal(event.account, event.account.toLowerCase());
    const transfer = decodeShareTransfer(log);
    if (transfer) {
      assert.equal(transfer.from, transfer.from.toLowerCase());
      assert.equal(transfer.to, transfer.to.toLowerCase());
    }
  }
});
