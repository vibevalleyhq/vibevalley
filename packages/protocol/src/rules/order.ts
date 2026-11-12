import { t } from "@vibevalley/i18n";

const keyDigits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Long keys come from inserting at one place again and again; past this a key is refused (rebalancing is not done yet).
const maxKeyLen = 256;

export const validKey = (k: string) => k !== "" && k.length <= maxKeyLen && !k.endsWith("0") && [...k].every((c) => keyDigits.includes(c));

class KeyError extends Error {}

/** A key after a and before b; "" for a is the start, "" for b the end. */
export function keyBetween(a: string, b: string): string {
  if ((a !== "" && !validKey(a)) || (b !== "" && !validKey(b))) throw new KeyError(t("shared.order.invalid"));
  if (a !== "" && b !== "" && a >= b) throw new KeyError(t("shared.order.unordered", { a, b }));
  if (b === "") return after(a);
  if (a === "") return before(b);
  return midpoint(a, b);
}

const digitAt = (i: number) => keyDigits[i] ?? "0";
const indexOfHead = (s: string) => keyDigits.indexOf(s[0] ?? "0");

/** Steps the first digit up by one, so appending again and again adds a digit only every 61 keys. */
const after = (a: string) => (a === "" ? "V" : stepUp(a));

function stepUp(a: string): string {
  const head = a[0];
  if (head === undefined) return "1";
  const i = keyDigits.indexOf(head);
  return i < keyDigits.length - 1 ? digitAt(i + 1) : head + stepUp(a.slice(1));
}

/** Steps the first digit down by one; a key never ends in '0', so there is always a digit to step. */
function before(b: string): string {
  const i = indexOfHead(b);
  if (i > 1) return digitAt(i - 1);
  if (i === 1) return "0z";
  return "0" + before(b.slice(1));
}

const digitOf = (s: string, i: number) => s[i] ?? "0";

function midpoint(a: string, b: string): string {
  if (b !== "") {
    let n = 0;
    while (n < b.length && digitOf(a, n) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(n < a.length ? a.slice(n) : "", b.slice(n));
  }
  const lo = a !== "" ? indexOfHead(a) : 0;
  const hi = b !== "" ? indexOfHead(b) : keyDigits.length;
  if (hi - lo > 1) return digitAt(Math.floor((lo + hi + 1) / 2));
  if (b.length > 1) return b.slice(0, 1);
  return digitAt(lo) + midpoint(a.length > 1 ? a.slice(1) : "", "");
}
