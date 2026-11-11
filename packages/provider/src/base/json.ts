import { Option, Schema } from "effect";

const Json = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeOption(Json);

/** JSON.stringify's text for value; String(value) for what JSON cannot hold (undefined, a cycle, a bigint), where
 * JSON.stringify would throw or give undefined. */
export const jsonText = (value: unknown): string => Option.getOrElse(encodeJson(value), () => String(value));
