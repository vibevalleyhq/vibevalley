import { Effect, Exit, Schema } from "effect";
import type { z } from "zod";

import { t } from "@vibevalley/i18n";

class QueryDecodeError extends Schema.TaggedError<QueryDecodeError, { readonly brand: unique symbol }>()("QueryDecodeError", {}) {
  override get message() {
    return t("web.base.query.invalidResponse");
  }
}

export type QuerySchema<T, E = T> = z.ZodType<T> | Schema.Codec<T, E>;

const isZod = <T, E>(schema: QuerySchema<T, E>): schema is z.ZodType<T> => "_zod" in schema;

export function queryDecoder<T, E>(schema: QuerySchema<T, E>) {
  if (isZod(schema)) {
    const parse = (input: unknown): T => {
      const got = schema.safeParse(input);
      if (got.success) return got.data;
      throw QueryDecodeError.make({});
    };
    return {
      same: (left: T, right: T) => JSON.stringify(left) === JSON.stringify(right),
      decode: async (input: unknown, _signal: AbortSignal): Promise<T> => parse(input),
      check: (input: T): T => parse(input),
    };
  }
  const decode = Schema.decodeUnknownEffect(schema);
  const check = Schema.decodeUnknownExit(Schema.toType(schema));
  return {
    same: Schema.toEquivalence(schema),
    decode: async (input: unknown, signal: AbortSignal): Promise<T> => {
      const result = await Effect.runPromiseExit(decode(input), { signal });
      if (Exit.isSuccess(result)) return result.value;
      // Schema issues can contain credentials; cache only the boundary failure.
      throw QueryDecodeError.make({});
    },
    check: (input: T): T => {
      const result = check(input);
      if (Exit.isSuccess(result)) return result.value;
      throw QueryDecodeError.make({});
    },
  };
}
