import type { z } from "zod";

import { t } from "@vibevalley/i18n";

/** A response that is not in the query's shape. Carries none of the issues: they can contain credentials. */
export class QueryDecodeError extends Error {
  override readonly name = "QueryDecodeError";
  constructor() {
    super(t("web.base.query.invalidResponse"));
  }
}

export type QuerySchema<T> = z.ZodType<T>;

export function queryDecoder<T>(schema: QuerySchema<T>) {
  return {
    same: (left: T, right: T) => JSON.stringify(left) === JSON.stringify(right),
    decode: async (input: unknown, _signal: AbortSignal): Promise<T> => {
      const got = await schema.safeParseAsync(input);
      if (got.success) return got.data;
      throw new QueryDecodeError();
    },
    // A value the page writes is checked against the same Schema: the query's shapes read the same in and out.
    check: (input: T): T => {
      let got: z.ZodSafeParseResult<T>;
      try {
        got = schema.safeParse(input);
      } catch {
        // A Schema that decodes asynchronously cannot check a write synchronously: the page's own value is kept as it is.
        return input;
      }
      if (got.success) return got.data;
      throw new QueryDecodeError();
    },
  };
}
