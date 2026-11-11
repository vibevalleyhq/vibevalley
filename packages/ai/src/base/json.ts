import { Option, Schema } from "effect";

const Json = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeOption(Json);
const encodeIndentedJson = Schema.encodeOption(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

/** JSON.stringify's text for value (indented by two spaces when asked); String(value) for what JSON cannot hold
 * (undefined, a cycle, a bigint), where JSON.stringify would throw or give undefined. */
export const jsonText = (value: unknown, options?: { readonly indent?: boolean }): string =>
  Option.getOrElse((options?.indent === true ? encodeIndentedJson : encodeJson)(value), () => String(value));

export const parsedJson = Schema.decodeOption(Json);
