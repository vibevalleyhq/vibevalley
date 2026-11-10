import { Effect, Exit, Schema } from "effect";

import { t } from "@vibevalley/i18n";

class QueryDecodeError extends Schema.TaggedError<QueryDecodeError, { readonly brand: unique symbol }>()("QueryDecodeError", {}) {
  override get message() {
    return t("web.base.query.invalidResponse");
  }
}
export function queryDecoder<T, E>(schema: Schema.Codec<T, E>) {
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
