// JSON read by a Schema rather than cast: what this server wrote (a table's JSON column), and what a model writes in the
// json block it hands back.

import { Option, Schema } from "effect";

/** Read where unreadable JSON is already a defect: a value that does not fit the Schema is one too. */
export const jsonOf = <T, E = T>(schema: Schema.Codec<T, E>) => Schema.decodeUnknownSync(Schema.fromJsonString(schema));

/** Read where unreadable JSON is taken as none: a value that does not fit the Schema is none too. */
export const jsonOrNone = <T, E = T>(schema: Schema.Codec<T, E>) => {
  const decode = Schema.decodeUnknownOption(Schema.fromJsonString(schema));
  return (text: string | null | undefined): T | undefined => (text == null ? undefined : Option.getOrUndefined(decode(text)));
};

/** A field a model writes as one string or a list of them; missing or null is none (linesOf). */
export const lines = Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)])));
export const linesOf = (v: string | readonly string[] | null | undefined): string[] => (v == null ? [] : typeof v === "string" ? [v] : [...v]);

/** A text field a model may leave out or set to null: none is "". */
export const text = Schema.optionalKey(Schema.NullOr(Schema.String));
