import { Brand, Schema } from "effect";

import type { Codec } from "../codec";
import * as T from "./shapes";

export const IssueId: Codec<T.IssueId> = Schema.String.pipe(Schema.brand("IssueId"));
export const SessionId: Codec<T.SessionId> = Schema.String.pipe(Schema.brand("SessionId"));
export const ArtifactId: Codec<T.ArtifactId> = Schema.String.pipe(Schema.brand("ArtifactId"));
export const BlockId: Codec<T.BlockId> = Schema.String.pipe(Schema.brand("BlockId"));
export const SuggestionId: Codec<T.SuggestionId> = Schema.String.pipe(Schema.brand("SuggestionId"));
export const MessageId: Codec<T.MessageId> = Schema.String.pipe(Schema.brand("MessageId"));
/** An id minted, or taken from where the kind is known (a route, a row, a tool's argument for it). */
export const issueId = Brand.nominal<T.IssueId>();
export const sessionId = Brand.nominal<T.SessionId>();
export const artifactId = Brand.nominal<T.ArtifactId>();
export const blockId = Brand.nominal<T.BlockId>();
export const suggestionId = Brand.nominal<T.SuggestionId>();
export const messageId = Brand.nominal<T.MessageId>();

export const Validation: Codec<T.Validation> = Schema.Struct({
  problem: Schema.String,
});

export const ActorKind: Codec<T.ActorKind> = Schema.Literals(T.ActorKindValues);

export const AgentRole: Codec<T.AgentRole> = Schema.Literals(T.AgentRoleValues);

export const Actor: Codec<T.Actor> = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("user"),
    id: Schema.String,
    name: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    id: Schema.String,
    role: AgentRole,
    name: Schema.optionalKey(Schema.String),
    forUser: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("system"),
    id: Schema.String,
    name: Schema.optionalKey(Schema.String),
  }),
]);

export const Outcome: Codec<T.Outcome> = Schema.Literals(T.OutcomeValues);

export const Spent: Codec<T.Spent> = Schema.Struct({
  tokens: Schema.Finite,
  cny: Schema.optionalKey(Schema.Finite),
});

export const Retry: Codec<T.Retry> = Schema.Struct({
  attempt: Schema.Finite,
  of: Schema.optionalKey(Schema.Finite),
});

export const Preview: Codec<T.Preview> = Schema.Struct({
  does: Schema.mutable(Schema.Array(Schema.String)),
});

export const Applied: Codec<T.Applied> = Schema.Struct({ seq: Schema.Finite });

export const KeySource: Codec<T.KeySource> = Schema.Literals(T.KeySourceValues);

export const KeyStatus: Codec<T.KeyStatus> = Schema.Struct({
  source: Schema.NullOr(KeySource),
  hint: Schema.optionalKey(Schema.String),
});

export const Locale: Codec<T.Locale> = Schema.Literals(T.LocaleValues);
