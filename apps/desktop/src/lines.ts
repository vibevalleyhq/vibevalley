// A child that speaks one JSON value a line (the server's ready line, the island's clicks).

import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import { Schema } from "effect";

/** fn hears each line that is one value of schema; every line, that or not, goes to each (a log) first. */
export function jsonLines<S extends Schema.Codec<unknown, unknown>>(input: Readable, schema: S, fn: (said: S["Type"]) => void, each?: (line: string) => void) {
  const read = Schema.decodeUnknownOption(schema);
  createInterface({ input }).on("line", (line) => {
    each?.(line);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const said = read(parsed);
    if (said._tag === "Some") fn(said.value);
  });
}

/** What an error says, for a log or the owner. */
export const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
