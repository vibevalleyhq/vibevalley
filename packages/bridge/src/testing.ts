import type { Link } from "./index";

export function linkPair(): readonly [Link, Link] {
  const ears = [new Set<(m: unknown) => void>(), new Set<(m: unknown) => void>()] as const;
  const end = (mine: 0 | 1): Link => ({
    send: (message) => {
      // Through JSON, as every real link carries it.
      const text = JSON.stringify(message);
      for (const fn of ears[mine === 0 ? 1 : 0]) fn(JSON.parse(text) as unknown);
    },
    receive: (fn) => {
      ears[mine].add(fn);
      return () => void ears[mine].delete(fn);
    },
  });
  return [end(0), end(1)];
}
