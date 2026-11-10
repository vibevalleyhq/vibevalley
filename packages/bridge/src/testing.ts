import { Result, Schema } from "effect";

import type { Link } from "./index";

const Json = Schema.fromJsonString(Schema.Unknown);

export function linkPair(): readonly [Link, Link] {
  const ears = [new Set<(m: unknown) => void>(), new Set<(m: unknown) => void>()] as const;
  const end = (mine: 0 | 1): Link => ({
    send: (message) => {
      const text = Result.getOrThrow(Schema.encodeResult(Json)(message));
      for (const fn of ears[mine === 0 ? 1 : 0]) fn(Result.getOrThrow(Schema.decodeResult(Json)(text)));
    },
    receive: (fn) => {
      ears[mine].add(fn);
      return () => void ears[mine].delete(fn);
    },
  });
  return [end(0), end(1)];
}
