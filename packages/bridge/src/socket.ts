// A link over a local stream socket, one JSON message a line: the desktop app answers its command line on it
// (apps/desktop src/control.ts), the command line asks on it (apps/server src/cli/app.ts).

import type { Socket } from "node:net";

import type { Link } from "./index";

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
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        // Not a message: the bridge reads only what decodes, so a line that does not parse is one it would drop.
        continue;
      }
      for (const fn of ears) fn(message);
    }
  });
  return {
    send: (message) => {
      if (!socket.destroyed) socket.write(JSON.stringify(message) + "\n");
    },
    receive: (fn) => {
      ears.add(fn);
      return () => void ears.delete(fn);
    },
  };
}
