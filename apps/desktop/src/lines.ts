import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import { Schema } from "effect";

/** each hears every line first, a value of schema or not. */
export function jsonLines<S extends Schema.Codec<unknown, unknown>>(input: Readable, schema: S, fn: (said: S["Type"]) => void, each?: (line: string) => void) {
  const read = Schema.decodeUnknownOption(Schema.fromJsonString(schema));
  createInterface({ input }).on("line", (line) => {
    each?.(line);
    const said = read(line);
    if (said._tag === "Some") fn(said.value);
  });
}

export const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
