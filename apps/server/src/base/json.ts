import { Option, Result, Schema, type SchemaIssue } from "effect";

import { currentLocale } from "@vibevalley/i18n";

/** Read where unreadable JSON is already a defect: a value that does not fit the Schema is one too. */
export const jsonOf = <T, E = T>(schema: Schema.Codec<T, E>) => Schema.decodeUnknownSync(Schema.fromJsonString(schema));

/** Read where unreadable JSON is taken as none: a value that does not fit the Schema is none too. */
export const jsonOrNone = <T, E = T>(schema: Schema.Codec<T, E>) => {
  const decode = Schema.decodeUnknownOption(Schema.fromJsonString(schema));
  return (text: string | null | undefined): T | undefined => (text == null ? undefined : Option.getOrUndefined(decode(text)));
};

/** A data file kept in each language (seeds.json and seeds.en.json), read once per language; one that does not fit its
 * shape stops the server at its first use. */
export const localizedJson = <A, I>(schema: Schema.Codec<A, I>, zh: unknown, en: unknown) => {
  const kept = new Map<string, A>();
  return (): A => {
    const locale = currentLocale() === "en" ? "en" : "zh";
    let got = kept.get(locale);
    if (got === undefined) kept.set(locale, (got = Schema.decodeUnknownSync(schema)(locale === "en" ? en : zh)));
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
  readonly misfit: (issue: SchemaIssue.Issue) => string;
  /** The block fits but still is not taken (a draft with no title); undefined takes it. */
  readonly refuse?: (value: A) => string | undefined;
}

/** The last fenced block of a model's text that decodes with schema and is not refused, or the words for why the last one tried was not. */
export function lastJsonBlock<A>(text: string, schema: Schema.Decoder<A>, words: BlockWords<A>): Result.Result<A, string> {
  const blocks = [...text.matchAll(fencedBlock)].map((m) => m[1] ?? "");
  const decode = Schema.decodeUnknownResult(schema);
  let problem = words.none;
  for (const block of blocks.toReversed()) {
    let raw: unknown;
    try {
      raw = JSON.parse(block);
    } catch (e) {
      problem = words.unparsed(e);
      continue;
    }
    const decoded = decode(raw);
    if (Result.isFailure(decoded)) {
      problem = words.misfit(decoded.failure.issue);
      continue;
    }
    const refused = words.refuse?.(decoded.success);
    if (refused === undefined) return Result.succeed(decoded.success);
    problem = refused;
  }
  return Result.fail(problem);
}

/** The field a decoding first failed on, undefined when the value itself was not an object. */
export function misfitField(issue: SchemaIssue.Issue): string | undefined {
  if (issue._tag === "Composite") return issue.issues[0] === undefined ? undefined : misfitField(issue.issues[0]);
  if (issue._tag === "Pointer") return issue.path[0] === undefined ? undefined : String(issue.path[0]);
  return undefined;
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

/** The JSON text of value as the wire carries it: wireOf, then encoded by schema (which still fails on a missing required
 * field or a wrong type). */
export const wireJson = <A>(schema: Schema.Codec<A>) => {
  const encode = Schema.encodeEffect(Schema.fromJsonString(schema));
  return (value: A) => encode(wireOf(value));
};
