// JSON this server wrote (a table's JSON column), read back by its shape's Schema rather than cast.

import { Option, Schema } from "effect";

/** Read where unreadable JSON is already a defect: a value that does not fit the Schema is one too. */
export const jsonOf = <T>(schema: Schema.Codec<T>) => Schema.decodeUnknownSync(Schema.fromJsonString(schema));

/** Read where unreadable JSON is taken as none: a value that does not fit the Schema is none too. */
export const jsonOrNone = <T>(schema: Schema.Codec<T>) => {
  const decode = Schema.decodeUnknownOption(Schema.fromJsonString(schema));
  return (text: string | null | undefined): T | undefined => (text == null ? undefined : Option.getOrUndefined(decode(text)));
};
