// JSON read by its shape's Schema rather than cast: what this server wrote (a table's JSON column, a file in its home),
// and what comes from outside (a vendor's body, a child process's line, a tool's output, a model's answer).

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

/**
 * The last fenced block of a model's text that decodes with schema and is not refused, or the words for why the last
 * one tried was not. Last first: a model that corrects itself writes the block again further down, and a later block
 * that does not read does not hide an earlier one that does.
 */
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
