import { z } from "zod";

import { currentLocale } from "@vibevalley/i18n";

import { Inconsistent, messageOf } from "./errors.ts";

const parsed = (text: string): unknown => JSON.parse(text);

/** A Zod failure in one line: the path of the first issue and what it says. */
export const problemOf = (e: z.ZodError): string => {
  const first = e.issues[0];
  if (first === undefined) return e.message;
  return first.path.length > 0 ? `${first.path.join(".")}: ${first.message}` : first.message;
};

/** Read where unreadable JSON is already a defect: a value that does not fit the Schema is one too. */
export const jsonOf =
  <T>(schema: z.ZodType<T>, where?: string) =>
  (text: string): T => {
    try {
      return schema.parse(parsed(text));
    } catch (cause) {
      const why = cause instanceof z.ZodError ? problemOf(cause) : messageOf(cause);
      throw where === undefined ? cause : new Inconsistent(`${where}: ${why}`, { cause });
    }
  };

/** Read a nullable JSON column written by this server: null stays undefined, while corrupt JSON fails fast as Inconsistent. */
export const storedJsonOrUndefined = <T>(schema: z.ZodType<T>, where: string) => {
  const decode = jsonOf(schema, where);
  return (text: string | null | undefined): T | undefined => (text == null ? undefined : decode(text));
};

/** Validate an in-memory row or value that must fit schema; a mismatch fails fast as Inconsistent. */
export const valueOf =
  <T>(schema: z.ZodType<T>, where = "stored value") =>
  (value: unknown): T => {
    const got = schema.safeParse(value);
    if (!got.success) throw new Inconsistent(`${where}: ${problemOf(got.error)}`, { cause: got.error });
    return got.data;
  };

/** As JSON.stringify writes it; a cycle or a bigint throws. */
export const jsonText = (value: unknown): string => JSON.stringify(value);

/** Read untrusted external JSON where unreadable or misfit input is taken as none. */
export const jsonOrNone =
  <T>(schema: z.ZodType<T>) =>
  (text: string | null | undefined): T | undefined => {
    if (text == null) return undefined;
    let raw: unknown;
    try {
      raw = parsed(text);
    } catch {
      return undefined;
    }
    const got = schema.safeParse(raw);
    return got.success ? got.data : undefined;
  };

/** A data file kept in each language (seeds.json and seeds.en.json), read once per language; one that does not fit its
 * shape stops the server at its first use. */
export const localizedJson = <A>(schema: z.ZodType<A>, zh: unknown, en: unknown) => {
  const kept = new Map<string, A>();
  return (): A => {
    const locale = currentLocale() === "en" ? "en" : "zh";
    let got = kept.get(locale);
    if (got === undefined) kept.set(locale, (got = schema.parse(locale === "en" ? en : zh)));
    return got;
  };
};

/** A fenced block, ```json or bare: models drop the language as often as they write it. */
const fencedBlock = /```(?:json)?[^\n]*\n([\s\S]*?)```/gu;

/** How the module that asked words a block it could not take; each is what the model is answered with. */
export interface BlockWords<A> {
  /** The text has no fenced block at all. */
  readonly none: string;
  /** The block is not JSON; e is what JSON.parse threw. */
  readonly unparsed: (e: unknown) => string;
  /** The block is JSON of another shape. */
  readonly misfit: (error: z.ZodError) => string;
  /** The block fits but still is not taken (a draft with no title); undefined takes it. */
  readonly refuse?: (value: A) => string | undefined;
}

export type BlockRead<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly problem: string };

/** The last fenced block of a model's text that decodes with schema and is not refused, or the words for why the last one tried was not. */
export function lastJsonBlock<A>(text: string, schema: z.ZodType<A>, words: BlockWords<A>): BlockRead<A> {
  const blocks = [...text.matchAll(fencedBlock)].map((m) => m[1] ?? "");
  let problem = words.none;
  for (const block of blocks.toReversed()) {
    let raw: unknown;
    try {
      raw = parsed(block);
    } catch (e) {
      problem = words.unparsed(e);
      continue;
    }
    const decoded = schema.safeParse(raw);
    if (!decoded.success) {
      problem = words.misfit(decoded.error);
      continue;
    }
    const refused = words.refuse?.(decoded.data);
    if (refused === undefined) return { ok: true, value: decoded.data };
    problem = refused;
  }
  return { ok: false, problem };
}

/** The field a decoding first failed on, undefined when the value itself was not an object. */
export function misfitField(error: z.ZodError): string | undefined {
  const first = error.issues[0]?.path[0];
  return first === undefined ? undefined : String(first);
}

// What goes on the wire is JSON: a key whose value is undefined is not there.

/** value with every own key set to undefined dropped, in plain objects and arrays all the way down. */
export const wireOf = <A>(value: A): A => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- wireOf keeps the shape and only drops the keys that hold undefined
  if (Array.isArray(value)) return value.map(wireOf) as A;
  if (value === null || typeof value !== "object") return value;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = wireOf(v);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- wireOf keeps the shape and only drops the keys that hold undefined
  return out as A;
};

/** The JSON text of value as the wire carries it: wireOf, then checked by schema (which still fails on a missing required
 * field or a wrong type). */
export const wireJson =
  <A>(schema: z.ZodType<unknown, A>) =>
  (value: A): string => {
    const wire = wireOf(value);
    const got = schema.safeParse(wire);
    if (!got.success) throw new Inconsistent(`not of its wire shape: ${problemOf(got.error)}`, { cause: got.error });
    return JSON.stringify(wire);
  };
