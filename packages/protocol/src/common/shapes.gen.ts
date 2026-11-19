// Generated from crates/vibevalley-protocol/src/contract (vp run protocol:ts). Do not edit.

declare const brand: unique symbol;
/** A string that is one kind of id: two kinds do not mix, and a plain string becomes one only where the kind is known (schema.ts). */
export type Branded<K extends string> = string & { readonly [brand]: K };

/** An issue's id (not its number). */
export type IssueId = Branded<"IssueId">;

/** A session's id: w1, w2…, for the whole life of the farm. */
export type SessionId = Branded<"SessionId">;

/** An artifact's id. */
export type ArtifactId = Branded<"ArtifactId">;

/** A block's id, within its artifact: a block op names the block it is for, never its artifact. */
export type BlockId = Branded<"BlockId">;

/** A suggested change to a block. */
export type SuggestionId = Branded<"SuggestionId">;

export type MessageId = Branded<"MessageId">;

/**
 * What checking a form before saving it found: the first thing that would be refused, if any.
 */
export type Validation = { problem: string, };

export const ActorKindValues = ["user", "agent", "system"] as const;
export type ActorKind = (typeof ActorKindValues)[number];

export const AgentRoleValues = ["orchestrator", "worker"] as const;
export type AgentRole = (typeof AgentRoleValues)[number];

export type Actor = { "kind": "user", id: string, name?: string, } | { "kind": "agent", id: string, role: AgentRole, name?: string, forUser?: boolean, } | { "kind": "system", id: string, name?: string, };

export const OutcomeValues = ["completed", "failed", "interrupted"] as const;
export type Outcome = (typeof OutcomeValues)[number];

export type Spent = { tokens: number, cny?: number, };

export type Retry = { attempt: number, of?: number, };

/**
 * What a command that changes things would do, as its dry run answers it (an endpoint's `dryRun`): nothing was changed.
 */
export type Preview = {
/**
 * What it would do, in order, one step a line.
 */
does: Array<string>, };

/**
 * A change with nothing to answer but when it shows (issue.comment.create).
 */
export type Applied = { seq: number, };

export const KeySourceValues = ["settings", "config"] as const;
export type KeySource = (typeof KeySourceValues)[number];

export type KeyStatus = { source: KeySource | null, hint?: string, };

export const LocaleValues = ["zh", "en"] as const;
export type Locale = (typeof LocaleValues)[number];
