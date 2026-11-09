import type { Brand } from "effect";

/** An issue's id (not its number). */
export type IssueId = string & Brand.Brand<"IssueId">;
/** A session's id: w1, w2…, for the whole life of the farm. */
export type SessionId = string & Brand.Brand<"SessionId">;
/** An artifact's id. */
export type ArtifactId = string & Brand.Brand<"ArtifactId">;
/** A block's id, within its artifact: a block op names the block it is for, never its artifact. */
export type BlockId = string & Brand.Brand<"BlockId">;
/** A suggested change to a block. */
export type SuggestionId = string & Brand.Brand<"SuggestionId">;
export type MessageId = string & Brand.Brand<"MessageId">;

/** The built-in orchestrator's profile id. */
export const defaultOrchestrator = "orchestrator";

/** The runtime of VibeValley's own agent: the only one an orchestrator runs on. */
export const orchestratorRuntime = "vibevalley";

/** The owner's participant id: who the owner mention is. */
export const ownerId = "owner";

/** Who the everyone mention is. */
export const everyone = "everyone";

/** The first channel, made default when the farm has none; then a name like any other, stored and in its address. */
/** Sessions working at once; also the beds on the farm. */
export const maxRunning = 6;

/** Times are Unix milliseconds. */
export const dayMs = 86400000;

/** What checking a form before saving it found: the first thing that would be refused, if any. */
export interface Validation {
  problem: string;
}

/** Who did a thing, as it is kept: the owner, an agent (whatever its role), or the farm itself; also who said a message. */
export const ActorKindValues = ["owner", "agent", "system"] as const;
export type ActorKind = (typeof ActorKindValues)[number];

export const OutcomeValues = ["completed", "failed", "interrupted"] as const;
export type Outcome = (typeof OutcomeValues)[number];

export interface Spent {
  tokens: number;
  cny?: number;
}

/** A change with nothing to answer but when it shows (issue.comment.create). */
export interface Applied {
  seq: number;
}

/** What a command that changes things would do, as its dry run answers it (an endpoint's `dryRun`): nothing was changed. */
export interface Preview {
  /** What it would do, in order, one step a line. */
  does: string[];
}

export { LocaleValues, type Locale } from "@vibevalley/i18n";

export interface KeyStatus {
  source: KeySource | null;
  hint?: string;
}

export const KeySourceValues = ["settings", "config"] as const;
export type KeySource = (typeof KeySourceValues)[number];

export interface Retry {
  attempt: number;
  of?: number;
}
