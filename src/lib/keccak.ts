/**
 * keccak256, in about sixty lines.
 *
 * WHY THIS IS HERE AND NOT A DEPENDENCY
 *
 * Event topics are keccak256 of the event signature, and this repository's whole
 * argument for trusting its decoder is that the topics are CHECKED rather than typed
 * from memory. A check needs a hash. Pulling in a library for one function would put
 * a dependency in the one place that is supposed to be independent, and the vendored
 * ESM bundle used elsewhere in this project expects browser globals it would be
 * absurd to stub for a hash.
 *
 * Node does not help: `node:crypto` offers SHA-3, and Keccak-256 is NOT SHA-3-256.
 * They differ in the padding byte (0x01 against 0x06), which changes every digest.
 * Using the wrong one is the kind of mistake that produces a plausible-looking
 * 32-byte value and no error at all.
 *
 * HOW IT IS VERIFIED
 *
 * Not by trusting this file. `test/decode.test.ts` hashes each event signature with
 * this implementation and compares against topic0 values taken from REAL LOGS on a
 * chain -- the exact bytes the node produced. If this code is wrong, that comparison
 * fails. Nothing here is taken on its own word.
 *
 * Implementation follows FIPS-202's Keccak-f[1600] permutation with the original
 * Keccak padding, using BigInt lanes so no 32-bit splitting is needed.
 */

const MASK64 = (1n << 64n) - 1n;

/** Round constants for the iota step. */
const RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** Rotation offsets, indexed by lane. */
const ROTATION: number[] = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

const rotl = (value: bigint, shift: number): bigint => ((value << BigInt(shift)) | (value >> BigInt(64 - shift))) & MASK64;

/** The Keccak-f[1600] permutation, in place on 25 lanes. */
function keccakF(state: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    // theta
    const c: bigint[] = [];
    for (let x = 0; x < 5; x++) c[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 25; y += 5) state[x + y] = state[x + y]! ^ d;
    }

    // rho and pi, combined into one pass over a copy
    const b: bigint[] = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const index = x + 5 * y;
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[index]!, ROTATION[index]!);
      }
    }

    // chi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const base = 5 * y;
        state[x + base] = b[x + base]! ^ (~b[((x + 1) % 5) + base]! & b[((x + 2) % 5) + base]!) & MASK64;
      }
    }

    // iota
    state[0] = state[0]! ^ RC[round]!;
  }
}

/** keccak256 of a byte string or of a UTF-8 string. Returns 0x-prefixed hex. */
export function keccak256(input: string | Uint8Array): string {
  let bytes: Uint8Array;
  if (typeof input === 'string') {
    // Solidity signatures are ASCII, but TextEncoder is the correct general answer.
    bytes = new TextEncoder().encode(input.startsWith('0x') ? input.slice(2) : input);
  } else {
    bytes = input;
  }

  const RATE = 136; // (1600 - 2*256) / 8
  const state: bigint[] = new Array(25).fill(0n);

  // pad10*1 with the Keccak (not SHA-3) domain byte, which is 0x01.
  //
  // `padded` is at least RATE bytes even for empty input -- `Math.ceil(1 / 136)` is 1
  // -- so the last index always exists. The assertion says so, because a zero here
  // would still hash without complaint and produce a digest that is wrong only for
  // inputs that need padding.
  const padded = new Uint8Array(Math.max(RATE, Math.ceil((bytes.length + 1) / RATE) * RATE));
  padded.set(bytes);
  padded[bytes.length] = 0x01;
  padded[padded.length - 1] = padded[padded.length - 1]! | 0x80;

  for (let offset = 0; offset < padded.length; offset += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[offset + i * 8 + j]!);
      state[i] = state[i]! ^ lane;
    }
    keccakF(state);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    const lane = state[i]!;
    for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((lane >> BigInt(8 * j)) & 0xffn);
  }

  return `0x${[...out].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
