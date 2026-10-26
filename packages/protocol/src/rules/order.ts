// A document's order keys are fractional indexes in base62 (David Greenspan's midpoint between two keys; one digit up
// or down at either end): a key sorts between its neighbours as a plain string, never ends in '0' (so there is always
// room before it), and siblings that got the same key sort by id. The server checks them; the page makes them for the
// blocks it inserts.

import { wording } from "../words";

const keyDigits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Long keys come from inserting at one place again and again; past this a key is refused (rebalancing is not done yet).
const maxKeyLen = 256;

export const validKey = (k: string) => k !== "" && k.length <= maxKeyLen && !k.endsWith("0") && [...k].every((c) => keyDigits.includes(c));

export class KeyError extends Error {}

/** A key after a and before b; "" for a is the start, "" for b the end. */
export function keyBetween(a: string, b: string): string {
  if ((a !== "" && !validKey(a)) || (b !== "" && !validKey(b))) throw new KeyError(wording().order.invalid);
  if (a !== "" && b !== "" && a >= b) throw new KeyError(wording().order.unordered(a, b));
  if (b === "") return after(a);
  if (a === "") return before(b);
  return midpoint(a, b);
}

/** Steps the first digit up by one, so appending again and again adds a digit only every 61 keys. */
const after = (a: string) => (a === "" ? "V" : stepUp(a));

function stepUp(a: string): string {
  if (a === "") return "1";
  const i = keyDigits.indexOf(a[0]!);
  return i < keyDigits.length - 1 ? keyDigits[i + 1]! : a[0]! + stepUp(a.slice(1));
}

/** Steps the first digit down by one; a key never ends in '0', so there is always a digit to step. */
function before(b: string): string {
  const i = keyDigits.indexOf(b[0]!);
  if (i > 1) return keyDigits[i - 1]!;
  if (i === 1) return "0z";
  return "0" + before(b.slice(1));
}

const digitOf = (s: string, i: number) => (i < s.length ? s[i]! : "0");

function midpoint(a: string, b: string): string {
  if (b !== "") {
    let n = 0;
    while (n < b.length && digitOf(a, n) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(n < a.length ? a.slice(n) : "", b.slice(n));
  }
  const lo = a !== "" ? keyDigits.indexOf(a[0]!) : 0;
  const hi = b !== "" ? keyDigits.indexOf(b[0]!) : keyDigits.length;
  if (hi - lo > 1) return keyDigits[Math.floor((lo + hi + 1) / 2)]!;
  if (b.length > 1) return b.slice(0, 1);
  return keyDigits[lo]! + midpoint(a.length > 1 ? a.slice(1) : "", "");
}
