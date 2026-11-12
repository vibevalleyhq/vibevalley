import type { Socket } from "node:net";

import type { Link } from "./index";

const parse = (line: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } => {
  try {
    return { ok: true, value: JSON.parse(line) as unknown };
  } catch {
    // A line that is not JSON is the other side's noise: it is passed over.
    return { ok: false };
  }
};

export function socketLink(socket: Socket): Link {
  const ears = new Set<(m: unknown) => void>();
  let rest = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    rest += chunk;
    for (let at = rest.indexOf("\n"); at >= 0; at = rest.indexOf("\n")) {
      const line = rest.slice(0, at);
      rest = rest.slice(at + 1);
      if (line.trim() === "") continue;
      const message = parse(line);
      if (!message.ok) continue;
      for (const fn of ears) fn(message.value);
    }
  });
  return {
    send: (message) => {
      if (socket.destroyed) return;
      // A message that is not JSON is the sender's mistake: it throws to the one sending it.
      socket.write(JSON.stringify(message) + "\n");
    },
    receive: (fn) => {
      ears.add(fn);
      return () => void ears.delete(fn);
    },
  };
}
