import { z } from "zod";

import { type Location, updateSearch } from "./history";

export interface SearchCheck {
  valid: (search: string) => boolean;
}
export interface SearchDefinition<T> extends SearchCheck {
  read: (search: string) => T | undefined;
  write: (location: Location, value: T) => string;
}

/** A decode or an encode, or undefined when it fails; a Schema that decodes asynchronously never admits a value. */
export function attemptCodec<T>(run: () => z.ZodSafeParseResult<T>): T | undefined {
  try {
    const got = run();
    return got.success ? got.data : undefined;
  } catch {
    return undefined;
  }
}

/** One value of a search key, read with `schema`: a key given twice does not decode. */
export function searchParam<T>(schema: z.ZodType<T, string>) {
  return z.codec(z.tuple([z.string()]), schema, {
    decode: ([value]) => value,
    encode: (value) => [value] as [string],
  });
}
const SearchWire = z.record(z.string(), z.array(z.string()).optional());
export function search<const F extends Readonly<Record<string, z.ZodType<unknown, readonly string[] | undefined>>>>(
  fields: F,
): SearchDefinition<z.output<z.ZodObject<F>>> {
  const schema = z.object(fields);
  const keys = Object.keys(fields);
  if (Object.getOwnPropertySymbols(fields).length > 0) throw new Error("Search fields require string names");
  const read = (text: string) => {
    try {
      decodeURIComponent(text);
    } catch {
      return undefined;
    }
    const params = new URLSearchParams(text);
    const input = Object.fromEntries(keys.filter((key) => params.has(key)).map((key) => [key, params.getAll(key)]));
    return attemptCodec(() => schema.safeParse(input));
  };
  return {
    read,
    valid: (text) => read(text) !== undefined,
    write: (location, value) => {
      const encoded = attemptCodec(() => z.safeEncode(schema, value));
      if (encoded === undefined) throw new Error("Invalid search values");
      const result = SearchWire.safeParse(encoded);
      if (!result.success) throw new Error("Search codecs must encode arrays of strings");
      return updateSearch(location, Object.fromEntries(keys.map((key) => [key, result.data[key]])));
    },
  };
}
