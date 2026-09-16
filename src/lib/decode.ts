/**
 * Event decoding.
 *
 * THE RISK THIS FILE CARRIES
 *
 * A wrong `topic0` does not throw. It silently turns a Deposit into a Withdraw, or
 * drops every yield report, and the resulting numbers still look plausible -- a
 * depositor's 100 becomes a withdrawal of 100 and the vault appears to be shrinking.
 * Nothing downstream can tell. So the signatures are not typed from memory: the
 * tests recompute every one of them with a keccak implementation and assert equality,
 * and `assertTopics()` refuses to start the indexer if a signature it was handed does
 * not hash to the topic it is registered under.
 *
 * HOW ERC-4626 EVENTS ARE LAID OUT
 *
 *   Deposit (topic0)
 *     topic1 = sender   (indexed)
 *     topic2 = owner    (indexed)
 *     data   = assets, shares   (NOT indexed -- these are the numbers)
 *
 *   Withdraw (topic0)
 *     topic1 = sender   (indexed)
 *     topic2 = receiver (indexed)
 *     topic3 = owner    (indexed)   <- THREE indexed parameters, so the data is
 *     data   = assets, shares        just two words instead of three topics + two
 *     words. Getting this layout wrong shifts every field by one and produces
 *     numbers that are off by orders of magnitude rather than by a little.
 *
 *   YieldReported (topic0 -- this contract's own event)
 *     topic1 = reporter (indexed)
 *     data   = assets   (ONE word, not two)
 *
 *   Transfer (ERC-20, applies to SHARES because the vault is the share token)
 *     topic1 = from, topic2 = to
 *     data   = value
 */

/** A raw log as JSON-RPC returns it. */
export interface RawLog {
  address: string;
  topics: readonly string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
  transactionIndex: string;
  removed?: boolean;
}

export interface DecodedEvent {
  kind: 'Deposit' | 'Withdraw' | 'YieldReported';
  blockNumber: number;
  logIndex: number;
  blockHash: string;
  txHash: string;
  /** The account the event concerns: owner for Deposit, owner for Withdraw, reporter for yield. */
  account: string;
  /** uint256 as a decimal string, or null when the event has no such field. */
  assets: string | null;
  shares: string | null;
}

export interface DecodedTransfer {
  blockNumber: number;
  logIndex: number;
  blockHash: string;
  txHash: string;
  from: string;
  to: string;
  value: string;
}

/** keccak256 of the event signature, as a 32-byte hex topic. */
export const TOPICS = {
  Deposit: '0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7',
  Withdraw: '0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db',
  /**
   * @dev This one was WRONG when first written -- filled in with a zero placeholder
   *      and never checked. It is the strongest argument in this repository for
   *      `assertTopics()`: a zero topic matches no log, so every `YieldReported`
   *      would have been silently dropped, and the price chart would have been
   *      missing exactly the jumps that make it worth looking at. No error, no
   *      warning, just a vault that appeared never to earn anything.
   */
  YieldReported: '0x0d95cfac633922e99f7c861b42672cf29738e55b6c7958cd638605bed5d0b6a6',
  Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
} as const;

/** The signatures those topics must equal. Kept beside them so a mismatch is visible. */
export const SIGNATURES = {
  Deposit: 'Deposit(address,address,uint256,uint256)',
  Withdraw: 'Withdraw(address,address,address,uint256,uint256)',
  YieldReported: 'YieldReported(address,uint256)',
  Transfer: 'Transfer(address,address,uint256)',
} as const;

export type EventKind = keyof typeof SIGNATURES;

const hex = (value: bigint): string => `0x${value.toString(16)}`;

/** A uint256 from a 32-byte word, as a decimal string. BigInt: these do not fit a number. */
function wordToDecimal(word: string): string {
  return BigInt(word).toString(10);
}

/** An address from an indexed 32-byte topic: the low 20 bytes. */
function topicToAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

const toNumber = (value: string): number => Number(BigInt(value));

/**
 * Decode a vault log, or return null if it is not one of the three events.
 *
 * Returning null rather than throwing is deliberate: this is called on every log
 * from the vault address, and a vault could legitimately emit something this
 * indexer does not model. Silently ignoring an unknown event would be a different
 * mistake, so the caller counts them and records the count -- see `indexRange`.
 */
export function decodeVaultLog(log: RawLog): DecodedEvent | null {
  const topic0 = log.topics[0]?.toLowerCase();
  const base = {
    blockNumber: toNumber(log.blockNumber),
    logIndex: toNumber(log.logIndex),
    blockHash: log.blockHash,
    txHash: log.transactionHash,
  };

  if (topic0 === TOPICS.Deposit) {
    // sender, owner indexed; assets, shares in the data.
    if (log.topics.length !== 3 || log.data.length < 2 + 128) return null;
    const owner = topicToAddress(topicAt(log, 2));
    const [assets, shares] = splitWords(log.data, 2);
    return { ...base, kind: 'Deposit', account: owner, assets: wordToDecimal(assets), shares: wordToDecimal(shares) };
  }

  if (topic0 === TOPICS.Withdraw) {
    // sender, receiver, owner indexed -- three topics -- plus assets, shares.
    if (log.topics.length !== 4 || log.data.length < 2 + 128) return null;
    const owner = topicToAddress(topicAt(log, 3));
    const [assets, shares] = splitWords(log.data, 2);
    return { ...base, kind: 'Withdraw', account: owner, assets: wordToDecimal(assets), shares: wordToDecimal(shares) };
  }

  if (topic0 === TOPICS.YieldReported) {
    // reporter indexed; assets in the data -- ONE word, and a single-word data field
    // is the shape most likely to be misread as two.
    if (log.topics.length !== 2 || log.data.length < 2 + 64) return null;
    const [assets] = splitWords(log.data, 1);
    return { ...base, kind: 'YieldReported', account: topicToAddress(topicAt(log, 1)), assets: wordToDecimal(assets), shares: null };
  }

  return null;
}

/** Decode an ERC-20 Transfer of vault shares. */
export function decodeShareTransfer(log: RawLog): DecodedTransfer | null {
  if (log.topics[0]?.toLowerCase() !== TOPICS.Transfer) return null;
  if (log.topics.length !== 3 || log.data.length < 2 + 64) return null;
  const [value] = splitWords(log.data, 1);
  return {
    blockNumber: toNumber(log.blockNumber),
    logIndex: toNumber(log.logIndex),
    blockHash: log.blockHash,
    txHash: log.transactionHash,
    from: topicToAddress(topicAt(log, 1)),
    to: topicToAddress(topicAt(log, 2)),
    value: wordToDecimal(value),
  };
}

/**
 * The one- and two-word shapes events carry.
 *
 * Named tuples rather than a bare array: under `noUncheckedIndexedAccess` every
 * element of a `string[]` is `string | undefined`, so destructuring one puts
 * `string | undefined` into `BigInt()` and the compiler objects at every call site.
 * The length was already validated here, so the assertion belongs here too, once.
 */
type Words1 = [string];
type Words2 = [string, string];

/** Read ABI-encoded words, validating the length first. */
function splitWords(data: string, count: 1): Words1;
function splitWords(data: string, count: 2): Words2;
function splitWords(data: string, count: number): string[] {
  const body = data.startsWith('0x') ? data.slice(2) : data;
  const expected = count * 64;
  if (body.length < expected) throw new Error(`expected ${count} ABI words (${expected} hex chars), got ${body.length}`);
  const words: string[] = [];
  for (let i = 0; i < count; i++) words.push(`0x${body.slice(i * 64, (i + 1) * 64)}`);
  return words;
}

/** A 32-byte topic that must be present, given the length already checked. */
function topicAt(log: RawLog, index: number): string {
  const topic = log.topics[index];
  if (topic === undefined) throw new Error(`log has no topic ${index} despite the length check`);
  return topic;
}

/**
 * Verify that every topic matches its signature.
 *
 * Called at indexer start-up with a keccak implementation injected, so the check
 * uses the same source of truth as the decoder rather than a second hard-coded
 * table. If a signature and its topic disagree, the indexer refuses to run -- a
 * mis-decoding indexer produces wrong history, and wrong history is worse than no
 * history because it is not obviously missing.
 */
export function assertTopics(keccak256: (signature: string) => string): void {
  for (const [kind, signature] of Object.entries(SIGNATURES) as [EventKind, string][]) {
    const expected = keccak256(signature).toLowerCase();
    const actual = TOPICS[kind].toLowerCase();
    if (expected !== actual) {
      throw new Error(
        `event topic mismatch for ${kind}:\n` +
          `  signature ${signature}\n` +
          `  hashes to ${hex(BigInt(expected))}\n` +
          `  registered as ${actual}\n` +
          `A mismatch here silently mis-decodes every log of this kind, so it is fatal.`,
      );
    }
  }
}

export { hex };
