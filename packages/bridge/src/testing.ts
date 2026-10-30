// Two links joined in memory, for a test of both sides in one process. A message goes through JSON, as over a WebView, and
// arrives at once: a test awaits the call it made, not the clock.

import type { Link } from "./index";

export function linkPair(): readonly [Link, Link] {
  const ears = [new Set<(m: unknown) => void>(), new Set<(m: unknown) => void>()] as const;
  const end = (mine: 0 | 1): Link => ({
    send: (message) => {
      const text = JSON.stringify(message);
      for (const fn of ears[mine === 0 ? 1 : 0]) fn(JSON.parse(text));
    },
    receive: (fn) => {
      ears[mine].add(fn);
      return () => void ears[mine].delete(fn);
    },
  });
  return [end(0), end(1)];
}
