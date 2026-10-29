// How an issue goes into its row: text that may be absent as null, JSON or null, and the next graph id.

const int64Max = 9223372036854775807n;

export function nextTaskId(ids: readonly string[]): string {
  let top = 0n;
  for (const id of ids) {
    const m = /^p([+-]?\d+)$/.exec(id);
    if (m) {
      const n = BigInt(m[1]!);
      if (n > top && n <= int64Max) top = n;
    }
  }
  return "p" + (top + 1n).toString();
}

export const nullText = (s: string | undefined) => {
  const text = (s ?? "").trim();
  return text === "" ? null : text;
};

export const jsonOrNull = (v: unknown, there: boolean) => (there ? JSON.stringify(v) : null);
