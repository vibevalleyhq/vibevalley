import type { Socket } from "node:net";

import { Option, Result, Schema } from "effect";

import type { Link } from "./index";

const Json = Schema.fromJsonString(Schema.Unknown);
const parse = Schema.decodeOption(Json);
const stringify = Schema.encodeResult(Json);

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
      if (Option.isNone(message)) continue;
      for (const fn of ears) fn(message.value);
    }
  });
  return {
    send: (message) => {
      if (socket.destroyed) return;
      // A message that is not JSON is the sender's mistake: it throws to the one sending it.
      socket.write(Result.getOrThrow(stringify(message)) + "\n");
    },
    receive: (fn) => {
      ears.add(fn);
      return () => void ears.delete(fn);
    },
  };
}
