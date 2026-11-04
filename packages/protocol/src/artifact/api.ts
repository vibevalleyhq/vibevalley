// The endpoints of artifacts: their answers (ArtifactHandlers) and their lines in the table (api.ts puts the
// concepts together).

import { type Effect, Schema } from "effect";

import { type ApiError, type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

const artifactDeleteInput = input({ id: S.ArtifactId });
const artifactBlockDeleteInput = input({ id: S.ArtifactId }, S.BlockDelete);
const artifactSuggestionInput = input({ id: S.ArtifactId, suggestion: S.SuggestionId });

export interface ArtifactHandlers<R = never> {
  /** The artifacts announced in a channel or made for an issue, newest change first; every one the farm has when neither is given. */
  readonly "artifact.list": (a: T.ArtifactListRequest) => Effect.Effect<T.Artifact[], ApiError, R>;
  readonly "artifact.get": (a: { readonly id: T.ArtifactId }) => Effect.Effect<T.Artifact, ApiError, R>;
  /** Its words: an html one's version as made, a blocks one's Markdown now (its version is its seq). What an agent reads
   * to make the next one. */
  readonly "artifact.content.get": (a: T.ArtifactReadRequest) => Effect.Effect<T.ArtifactContent, ApiError, R>;
  /** Without content, an empty blocks one to write in; with content, a hand-in its maker announces with its card. */
  readonly "artifact.create": (a: T.ArtifactRequest) => Effect.Effect<T.Artifact, ApiError, R>;
  /** An html one's new version over the latest; the old ones stay. Announced like the first. A blocks one is changed
   * block by block instead. */
  readonly "artifact.version.create": (a: T.ArtifactVersionRequest) => Effect.Effect<T.Artifact, ApiError, R>;
  /** Its title, as the owner renames it. */
  readonly "artifact.update": (a: { readonly id: T.ArtifactId; readonly title: string }) => Effect.Effect<T.Artifact, ApiError, R>;
  readonly "artifact.delete": (a: { readonly id: T.ArtifactId }) => Effect.Effect<void, ApiError, R>;
  readonly "artifact.previewDelete": (a: { readonly id: T.ArtifactId }) => Effect.Effect<T.Preview, ApiError, R>;
  /** A blocks artifact and every live block (no tombstones), in order. */
  readonly "artifact.block.list": (a: { readonly id: T.ArtifactId }) => Effect.Effect<T.BlockSnapshot, ApiError, R>;
  /** A batch of ops, as the owner: taken in order, in one transaction, one batch at a time. */
  readonly "artifact.submit": (a: { readonly id: T.ArtifactId } & T.BlockSubmit) => Effect.Effect<T.BlockAck, ApiError, R>;
  /** One block inserted, as one batch of one op. */
  readonly "artifact.block.create": (a: { readonly id: T.ArtifactId } & T.BlockCreate) => Effect.Effect<T.BlockOpResult, ApiError, R>;
  /** One block's words, type or attrs changed, as one batch. */
  readonly "artifact.block.update": (a: { readonly id: T.ArtifactId } & T.BlockUpdate) => Effect.Effect<T.BlockOpResult, ApiError, R>;
  /** One block and its children put in their tombstones. */
  readonly "artifact.block.delete": (a: { readonly id: T.ArtifactId } & T.BlockDelete) => Effect.Effect<T.BlockOpResult, ApiError, R>;
  readonly "artifact.block.previewDelete": (a: { readonly id: T.ArtifactId } & T.BlockDelete) => Effect.Effect<T.Preview, ApiError, R>;
  /** The open and resolved suggestions on an artifact, oldest first. */
  readonly "artifact.suggestion.list": (a: { readonly id: T.ArtifactId }) => Effect.Effect<T.Suggestion[], ApiError, R>;
  /** A change an agent proposes to a block the owner wrote. */
  readonly "artifact.suggestion.create": (a: { readonly id: T.ArtifactId } & T.SuggestionCreate) => Effect.Effect<T.Suggestion, ApiError, R>;
  /** The owner takes a suggestion; a block that moved on since it was read comes back stale, and is not changed. */
  readonly "artifact.suggestion.accept": (a: { readonly id: T.ArtifactId; readonly suggestion: T.SuggestionId }) => Effect.Effect<T.Suggestion, ApiError, R>;
  readonly "artifact.suggestion.reject": (a: { readonly id: T.ArtifactId; readonly suggestion: T.SuggestionId }) => Effect.Effect<T.Suggestion, ApiError, R>;
  /** A blocks artifact as Markdown: the format artifacts trade with agents and MEMORY.md in, not how they are stored. */
  readonly "artifact.markdown.get": (a: { readonly id: T.ArtifactId }) => Effect.Effect<T.ArtifactMarkdown, ApiError, R>;
  /** Starts the scripted demo (up to three helpers writing their own sections at once, no model) and returns at once;
   * one already running is refused. */
  readonly "artifact.demo": (a: { readonly id: T.ArtifactId }) => Effect.Effect<void, ApiError, R>;
}

export const artifactEndpoints: readonly Endpoint[] = [
  {
    op: "artifact.list",
    about: [],
    input: S.ArtifactListRequest,
    result: Schema.mutable(Schema.Array(S.Artifact)),
    can: ["owner", "remote", "orchestrator", "session"],
  },
  {
    op: "artifact.get",
    about: ["id"],
    input: input({ id: S.ArtifactId }),
    result: S.Artifact,
    can: ["owner", "remote", "orchestrator", "session"],
  },
  {
    op: "artifact.content.get",
    about: ["id"],
    input: S.ArtifactReadRequest,
    result: S.ArtifactContent,
    can: ["owner", "remote", "orchestrator", "session"],
  },
  {
    op: "artifact.create",
    about: [],
    input: S.ArtifactRequest,
    result: S.Artifact,
    can: ["owner", "remote", "orchestrator", "session"],
  },
  {
    op: "artifact.version.create",
    about: ["id"],
    input: S.ArtifactVersionRequest,
    result: S.Artifact,
    can: ["owner", "remote", "orchestrator", "session"],
  },
  {
    op: "artifact.update",
    about: ["id"],
    input: input({ id: S.ArtifactId, title: Schema.String }),
    result: S.Artifact,
    can: ["owner", "remote"],
  },
  {
    op: "artifact.delete",
    about: ["id"],
    input: artifactDeleteInput,
    result: undefined,
    can: ["owner", "remote"],
    dryRun: "artifact.previewDelete",
  },
  {
    op: "artifact.previewDelete",
    about: ["id"],
    input: artifactDeleteInput,
    result: S.Preview,
    can: ["owner", "remote"],
  },
  {
    op: "artifact.block.list",
    about: ["id"],
    input: input({ id: S.ArtifactId }),
    result: S.BlockSnapshot,
    can: ["owner", "remote"],
  },
  {
    op: "artifact.submit",
    about: ["id"],
    input: input({ id: S.ArtifactId }, S.BlockSubmit),
    result: S.BlockAck,
    can: ["owner", "remote"],
  },
  {
    op: "artifact.block.create",
    about: ["id"],
    input: input({ id: S.ArtifactId }, S.BlockCreate),
    result: S.BlockOpResult,
    can: ["owner", "remote", "session", "orchestrator"],
  },
  {
    op: "artifact.block.update",
    about: ["id"],
    input: input({ id: S.ArtifactId }, S.BlockUpdate),
    result: S.BlockOpResult,
    can: ["owner", "remote", "session", "orchestrator"],
  },
  {
    op: "artifact.block.delete",
    about: ["id"],
    input: artifactBlockDeleteInput,
    result: S.BlockOpResult,
    can: ["owner", "remote", "session", "orchestrator"],
    dryRun: "artifact.block.previewDelete",
  },
  {
    op: "artifact.block.previewDelete",
    about: ["id"],
    input: artifactBlockDeleteInput,
    result: S.Preview,
    can: ["owner", "remote", "session", "orchestrator"],
  },
  {
    op: "artifact.suggestion.list",
    about: ["id"],
    input: input({ id: S.ArtifactId }),
    result: Schema.mutable(Schema.Array(S.Suggestion)),
    can: ["owner", "remote"],
  },
  {
    op: "artifact.suggestion.create",
    about: ["id"],
    input: input({ id: S.ArtifactId }, S.SuggestionCreate),
    result: S.Suggestion,
    can: ["owner", "remote"],
  },
  {
    op: "artifact.suggestion.accept",
    about: ["id"],
    input: artifactSuggestionInput,
    result: S.Suggestion,
    can: ["owner", "remote"],
  },
  {
    op: "artifact.suggestion.reject",
    about: ["id"],
    input: artifactSuggestionInput,
    result: S.Suggestion,
    can: ["owner", "remote"],
  },
  {
    op: "artifact.markdown.get",
    about: ["id"],
    input: input({ id: S.ArtifactId }),
    result: S.ArtifactMarkdown,
    can: ["owner", "remote"],
  },
  {
    op: "artifact.demo",
    about: ["id"],
    input: input({ id: S.ArtifactId }),
    result: undefined,
    can: ["owner"],
  },
];
