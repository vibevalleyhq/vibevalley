import { Exit, Schema, SchemaGetter } from "effect";

import { type Location, updateSearch } from "./history";

export interface SearchCheck {
  valid: (search: string) => boolean;
}
export interface SearchDefinition<T> extends SearchCheck {
  read: (search: string) => T | undefined;
  write: (location: Location, value: T) => string;
}
export function searchParam<T>(schema: Schema.Codec<T, string>) {
  return Schema.Tuple([Schema.String]).pipe(
    Schema.decodeTo(schema, {
      decode: SchemaGetter.transform(([value]) => value),
      encode: SchemaGetter.transform((value: string) => [value] as const),
    }),
  );
}
const SearchWire = Schema.Record(Schema.String, Schema.UndefinedOr(Schema.Array(Schema.String)));
export function search<const F extends Readonly<Record<string, Schema.Codec<unknown, readonly string[] | undefined>>>>(
  fields: F,
): SearchDefinition<Schema.Struct<F>["Type"]> {
  const schema = Schema.Struct(fields);
  const decode = Schema.decodeUnknownExit(schema);
  const encode = Schema.encodeUnknownExit(schema);
  const wire = Schema.decodeUnknownExit(SearchWire);
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
    const result = decode(input);
    return Exit.isSuccess(result) ? result.value : undefined;
  };
  return {
    read,
    valid: (text) => read(text) !== undefined,
    write: (location, value) => {
      const encoded = encode(value);
      if (Exit.isFailure(encoded)) throw new Error("Invalid search values");
      const result = wire(encoded.value);
      if (Exit.isFailure(result)) throw new Error("Search codecs must encode arrays of strings");
      return updateSearch(location, Object.fromEntries(keys.map((key) => [key, result.value[key]])));
    },
  };
}
