// Row ids: uuidv7, which carries the time it was made, so rows sort in the order they were
// written. Within one millisecond the 12 bits after the time count up, so a row made in the same millisecond as the one
// before it still sorts after it; a clock that goes back across a restart can put a new id before an old one, which one
// farm on one machine accepts.

import { randomBytes, randomInt } from "node:crypto";

let lastMs = -1;
let seq = 0;

export function newId(now = Date.now()): string {
  let ms = Math.max(now, lastMs);
  if (ms === lastMs) {
    seq++;
    if (seq > 0xfff) {
      ms++;
      seq = 0;
    }
  } else {
    seq = randomInt(0, 0x800);
  }
  lastMs = ms;
  const b = randomBytes(16);
  for (let i = 0; i < 6; i++) b[i] = Math.floor(ms / 2 ** (8 * (5 - i))) & 0xff;
  b[6] = 0x70 | (seq >> 8);
  b[7] = seq & 0xff;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Leaves out what reads alike (0 O, 1 I L). */
const codeAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** A short human code, for pairing a device: not an id, and never a key. */
export const code = (n: number) => Array.from(randomBytes(n), (b) => codeAlphabet[b % codeAlphabet.length]).join("");
