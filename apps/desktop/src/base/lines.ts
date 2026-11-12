import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import type { z } from "zod";

/** each hears every line first, a value of schema or not. */
export function jsonLines<A>(input: Readable, schema: z.ZodType<A>, fn: (said: A) => void, each?: (line: string) => void) {
  createInterface({ input }).on("line", (line) => {
    each?.(line);
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      // Not JSON: a line for the log only (each heard it).
      return;
    }
    const said = schema.safeParse(json);
    if (said.success) fn(said.data);
  });
}

export const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
