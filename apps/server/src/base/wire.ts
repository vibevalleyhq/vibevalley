import { Schema } from "effect";

// What goes on the wire is JSON: a key whose value is undefined is not there. The services keep TypeScript's optional
// fields that way (`{ ...x, callReason: undefined }`), and the Schemas say "absent or a value", so values are encoded
// as JSON.stringify would send them: such keys dropped first, everything else still checked by the Schema.

/** value with every own key set to undefined dropped, in plain objects and arrays all the way down; other objects as
 * they are (class instances, such as a tagged error, encode through their own Schema). */
export const wireOf = <A>(value: A): A => {
  if (Array.isArray(value)) return value.map(wireOf) as A;
  if (value === null || typeof value !== "object") return value;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = wireOf(v);
  return out as A;
};

/** The JSON text of value as the wire carries it: wireOf, then encoded by schema (which still fails on a missing required
 * field or a wrong type). */
export const wireJson = <A>(schema: Schema.Codec<A>) => {
  const encode = Schema.encodeEffect(Schema.fromJsonString(schema));
  return (value: A) => encode(wireOf(value));
};
