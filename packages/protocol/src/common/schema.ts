import { z } from "zod";

import type { Codec } from "../codec";
import * as T from "./shapes";

/** A string read as one kind of id. The only place a plain string becomes a branded one without a check of its own:
 * the kind is what the field says. */
const branded = <B extends T.Branded<string>>(): z.ZodType<B, string> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a brand is a promise about where the string came from, not a shape to check
  z.string().transform((s) => s as B);

export const IssueId = branded<T.IssueId>();
export const SessionId = branded<T.SessionId>();
export const ArtifactId = branded<T.ArtifactId>();
export const BlockId = branded<T.BlockId>();
export const SuggestionId = branded<T.SuggestionId>();
export const MessageId = branded<T.MessageId>();

/** An id minted, or taken from where the kind is known (a route, a row, a tool's argument for it). */
function mint<K extends string>(_kind: K): (s: string) => T.Branded<K> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as branded: the caller says where the string came from
  return (s) => s as T.Branded<K>;
}
export const issueId = mint("IssueId");
export const sessionId = mint("SessionId");
export const artifactId = mint("ArtifactId");
export const blockId = mint("BlockId");
export const suggestionId = mint("SuggestionId");
export const messageId = mint("MessageId");

/** JSON text read as x: a stored column, a file, a line. Not JSON, or JSON not of x's shape, fails the parse. */
export const jsonString = <A, I>(x: z.ZodType<A, I>): z.ZodType<A, string> =>
  z
    .string()
    .transform((text, ctx) => {
      try {
        return JSON.parse(text) as unknown;
      } catch (e) {
        ctx.addIssue({ code: "custom", message: `not JSON: ${e instanceof Error ? e.message : String(e)}` });
        return z.NEVER;
      }
    })
    .pipe(x);

/** A secret: kept out of JSON (it throws) and out of logs (it prints as [secret]); its value is read only by reveal. */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toJSON(): never {
    throw new Error("a secret is never written as JSON");
  }
  toString(): string {
    return "[secret]";
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[secret]";
  }
}

/** x's value read as a Secret. */
export const secretOf = <I>(x: z.ZodType<string, I>): z.ZodType<Secret, I> => x.transform((s) => new Secret(s));

export const Validation = z.object({
  problem: z.string(),
}) satisfies Codec<T.Validation>;

export const ActorKind = z.enum(T.ActorKindValues) satisfies Codec<T.ActorKind>;

const AgentRole = z.enum(T.AgentRoleValues) satisfies Codec<T.AgentRole>;

export const Actor = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"),
    id: z.string(),
    name: z.exactOptional(z.string()),
  }),
  z.object({
    kind: z.literal("agent"),
    id: z.string(),
    role: AgentRole,
    name: z.exactOptional(z.string()),
    forUser: z.exactOptional(z.boolean()),
  }),
  z.object({
    kind: z.literal("system"),
    id: z.string(),
    name: z.exactOptional(z.string()),
  }),
]) satisfies Codec<T.Actor>;

export const Outcome = z.enum(T.OutcomeValues) satisfies Codec<T.Outcome>;

export const Spent = z.object({
  tokens: z.number(),
  cny: z.exactOptional(z.number()),
}) satisfies Codec<T.Spent>;

export const Retry = z.object({
  attempt: z.number(),
  of: z.exactOptional(z.number()),
}) satisfies Codec<T.Retry>;

export const Preview = z.object({
  does: z.array(z.string()),
}) satisfies Codec<T.Preview>;

export const Applied = z.object({ seq: z.number() }) satisfies Codec<T.Applied>;

export const KeySource = z.enum(T.KeySourceValues) satisfies Codec<T.KeySource>;

export const KeyStatus = z.object({
  source: KeySource.nullable(),
  hint: z.exactOptional(z.string()),
}) satisfies Codec<T.KeyStatus>;

export const Locale = z.enum(T.LocaleValues) satisfies Codec<T.Locale>;

/** A string's length counted in code points, not UTF-16 units: an emoji is one character, as a person counts it.
 * Written into the JSON Schema a tool's model reads as minLength/maxLength, which count code points too (the bag's
 * minimum/maximum are what z.toJSONSchema reads for a string; a refine alone says nothing there). */
export const codePoints = (min: number, max: number) => {
  const check = z.refine<string>(
    (s) => {
      const n = [...s].length;
      return n >= min && n <= max;
    },
    { message: `between ${min} and ${max} characters` },
  );
  check._zod.onattach.push((schema) => {
    const bag: Record<string, unknown> = schema._zod.bag;
    bag["minimum"] = min;
    bag["maximum"] = max;
  });
  return check;
};
