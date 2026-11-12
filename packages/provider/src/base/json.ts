import { z } from "zod";

/** JSON.stringify's text for value; String(value) for what JSON cannot hold (undefined, a cycle, a bigint), where
 * JSON.stringify would throw or give undefined. */
export const jsonText = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // A cycle or a bigint: the fallback above is the answer for exactly these.
    return String(value);
  }
};

/** text parsed as JSON and then by schema; undefined when it is not JSON or not that shape: callers answer both the same. */
export function fromJson<S extends z.ZodType>(schema: S, text: unknown): z.output<S> | undefined {
  if (typeof text !== "string") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Not JSON is the same answer as not this shape.
    return undefined;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** A string of between min and max Unicode code points (not UTF-16 units). */
export const codePoints = (min: number, max: number) =>
  z.string().refine((s) => {
    let n = 0;
    for (const _ of s) if (++n > max) return false;
    return n >= min;
  });

/** A whole number in [min, max]. */
export const int = (min = 0, max = Number.MAX_SAFE_INTEGER) => z.number().int().min(min).max(max);

/** An https URL without credentials or a fragment, at most maxHref long, parsed to a URL. */
export const httpsUrl = (maxHref = Number.POSITIVE_INFINITY) =>
  z.string().transform((s, ctx) => {
    const url = URL.parse(s);
    if (url === null || url.href.length > maxHref || url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
      ctx.addIssue({ code: "custom", message: "Not a plain https URL" });
      return z.NEVER;
    }
    return url;
  });
