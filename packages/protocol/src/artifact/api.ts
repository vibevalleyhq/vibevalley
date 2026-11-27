import { z } from "zod";

import { type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

const artifactDeleteInput = input({ id: S.ArtifactId });
const artifactSuggestionInput = input({ id: S.ArtifactId, suggestion: S.SuggestionId });

export interface ArtifactHandlers {
  /** The artifacts announced in a channel or made for an issue, newest change first; every one the workspace has when neither is given. */
  readonly "artifact.list": (a: T.ArtifactListRequest) => Promise<T.Artifact[]>;
  readonly "artifact.get": (a: { readonly id: T.ArtifactId }) => Promise<T.Artifact>;
  /** Reads the artifact's primary entry file content (optionally at a historical immutable snapshot version). */
  readonly "artifact.content.get": (a: T.ArtifactReadRequest) => Promise<T.ArtifactContent>;
  /** Creates a new directory-backed artifact seeded with starter files for its `artifactType`. */
  readonly "artifact.create": (a: T.ArtifactRequest) => Promise<T.Artifact>;
  /** Cuts a new immutable directory snapshot version over the latest state. */
  readonly "artifact.version.create": (a: T.ArtifactVersionRequest) => Promise<T.Artifact>;
  /** Updates an artifact's title, linked issue, or default design-system flag. */
  readonly "artifact.update": (a: T.ArtifactUpdateRequest) => Promise<T.Artifact>;
  readonly "artifact.delete": (a: { readonly id: T.ArtifactId }) => Promise<void>;
  readonly "artifact.previewDelete": (a: { readonly id: T.ArtifactId }) => Promise<T.Preview>;
  /** All 12 artifact types and the workspace's standing default design-system if any. */
  readonly "artifact.type.list": () => Promise<T.ArtifactTypeInfo[]>;
  /** An artifact type's SKILL.md guide or one of its named reference chapters. */
  readonly "artifact.type.read": (a: T.ArtifactTypeReadRequest) => Promise<T.ArtifactTypeGuide>;
  /** Lists files (`manifest.json`, `structure/*`, `asset/*`) inside an artifact directory. */
  readonly "artifact.file.list": (a: T.ArtifactFileListRequest) => Promise<T.ArtifactFileListResult>;
  /** Reads one file by relative path inside an artifact directory (or historical version snapshot). */
  readonly "artifact.file.get": (a: T.ArtifactFileGetRequest) => Promise<T.ArtifactFileContent>;
  /** Atomically writes one or more files into `structure/` or `asset/` with origin attribution and collab sync. */
  readonly "artifact.file.write": (a: T.ArtifactFileWriteRequest) => Promise<T.ArtifactFileWriteResult>;
  /** Deletes a relative path under `structure/` or `asset/` with origin attribution and collab sync. */
  readonly "artifact.file.delete": (a: T.ArtifactFileDeleteRequest) => Promise<T.ArtifactFileDeleteResult>;
  /** The open and resolved suggestions on an artifact, oldest first. */
  readonly "artifact.suggestion.list": (a: { readonly id: T.ArtifactId }) => Promise<T.Suggestion[]>;
  /** A proposed edit to a file or structured target inside an artifact directory. */
  readonly "artifact.suggestion.create": (a: { readonly id: T.ArtifactId } & T.SuggestionCreate) => Promise<T.Suggestion>;
  /** Accepts a pending suggestion and applies it to the artifact directory and collab state. */
  readonly "artifact.suggestion.accept": (a: { readonly id: T.ArtifactId; readonly suggestion: T.SuggestionId }) => Promise<T.Suggestion>;
  readonly "artifact.suggestion.reject": (a: { readonly id: T.ArtifactId; readonly suggestion: T.SuggestionId }) => Promise<T.Suggestion>;
  /** Ephemeral live presence update (cursor, selection, highlight, viewport); never persisted to SQLite. */
  readonly "artifact.presence.update": (a: T.ArtifactPresenceUpdateRequest) => Promise<void>;
  /** Newest first. */
  readonly "artifact.history.list": (a: T.ArtifactHistoryListRequest) => Promise<T.ArtifactHistoryEntry[]>;
  /** Read-only snapshot projection at the requested Loro frontiers. */
  readonly "artifact.history.preview": (a: T.ArtifactHistoryPreviewRequest) => Promise<T.ArtifactHistoryPreviewResult>;
  /** Restore an artifact to the snapshot at the requested Loro frontiers as a new commit. */
  readonly "artifact.history.restore": (a: T.ArtifactHistoryRestoreRequest) => Promise<T.Artifact>;
  /** Fork a new artifact starting from the snapshot at the requested Loro frontiers. */
  readonly "artifact.history.fork": (a: T.ArtifactHistoryForkRequest) => Promise<T.Artifact>;
  /** Selectively undo commits matching one origin while preserving concurrent edits from other actors. */
  readonly "artifact.history.undoOrigin": (a: T.ArtifactHistoryUndoOriginRequest) => Promise<T.Artifact>;
  /** Compact old operation history into a shallow snapshot while keeping current state intact. */
  readonly "artifact.history.compact": (a: T.ArtifactHistoryCompactRequest) => Promise<T.Artifact>;
  /** Export incremental Loro CRDT updates (or full snapshot) relative to a client VersionVector. */
  readonly "artifact.collab.export": (a: T.ArtifactCollabExportRequest) => Promise<T.ArtifactCollabExportResult>;
  /** Import incremental Loro CRDT updates (or snapshot) into an artifact and optionally return missing server updates. */
  readonly "artifact.collab.import": (a: T.ArtifactCollabImportRequest) => Promise<T.ArtifactCollabImportResult>;
  /** Saves a derived auto-captured cover image outside the artifact directory and CRDT. */
  readonly "artifact.cover.set": (a: T.ArtifactCoverSetRequest) => Promise<T.ArtifactCover>;
}

export const artifactEndpoints: readonly Endpoint[] = [
  {
    op: "artifact.list",
    about: [],
    input: S.ArtifactListRequest,
    result: z.array(S.Artifact),
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "artifact.get",
    about: ["id"],
    input: input({ id: S.ArtifactId }),
    result: S.Artifact,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "artifact.content.get",
    about: ["id"],
    input: S.ArtifactReadRequest,
    result: S.ArtifactContent,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "artifact.create",
    about: [],
    input: S.ArtifactRequest,
    result: S.Artifact,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "artifact.version.create",
    about: ["id"],
    input: S.ArtifactVersionRequest,
    result: S.Artifact,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "artifact.update",
    about: ["id"],
    input: S.ArtifactUpdateRequest,
    result: S.Artifact,
    can: ["user", "remote"],
  },
  {
    op: "artifact.delete",
    about: ["id"],
    input: artifactDeleteInput,
    result: undefined,
    can: ["user", "remote"],
    dryRun: "artifact.previewDelete",
  },
  {
    op: "artifact.previewDelete",
    about: ["id"],
    input: artifactDeleteInput,
    result: S.Preview,
    can: ["user", "remote"],
  },
  {
    op: "artifact.type.list",
    about: [],
    input: undefined,
    result: z.array(S.ArtifactTypeInfo),
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "artifact.type.read",
    about: [],
    input: S.ArtifactTypeReadRequest,
    result: S.ArtifactTypeGuide,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "artifact.file.list",
    about: ["id"],
    input: S.ArtifactFileListRequest,
    result: S.ArtifactFileListResult,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "artifact.file.get",
    about: ["id"],
    input: S.ArtifactFileGetRequest,
    result: S.ArtifactFileContent,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "artifact.file.write",
    about: ["id"],
    input: S.ArtifactFileWriteRequest,
    result: S.ArtifactFileWriteResult,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "artifact.file.delete",
    about: ["id"],
    input: S.ArtifactFileDeleteRequest,
    result: S.ArtifactFileDeleteResult,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "artifact.suggestion.list",
    about: ["id"],
    input: input({ id: S.ArtifactId }),
    result: z.array(S.Suggestion),
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "artifact.suggestion.create",
    about: ["id"],
    input: input({ id: S.ArtifactId }, S.SuggestionCreate),
    result: S.Suggestion,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "artifact.suggestion.accept",
    about: ["id"],
    input: artifactSuggestionInput,
    result: S.Suggestion,
    can: ["user", "remote"],
  },
  {
    op: "artifact.suggestion.reject",
    about: ["id"],
    input: artifactSuggestionInput,
    result: S.Suggestion,
    can: ["user", "remote"],
  },
  {
    op: "artifact.presence.update",
    about: ["id"],
    input: S.ArtifactPresenceUpdateRequest,
    result: undefined,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "artifact.history.list",
    about: ["id"],
    input: S.ArtifactHistoryListRequest,
    result: z.array(S.ArtifactHistoryEntry),
    can: ["user", "remote"],
  },
  {
    op: "artifact.history.preview",
    about: ["id"],
    input: S.ArtifactHistoryPreviewRequest,
    result: S.ArtifactHistoryPreviewResult,
    can: ["user", "remote"],
  },
  {
    op: "artifact.history.restore",
    about: ["id"],
    input: S.ArtifactHistoryRestoreRequest,
    result: S.Artifact,
    can: ["user", "remote"],
  },
  {
    op: "artifact.history.fork",
    about: ["id"],
    input: S.ArtifactHistoryForkRequest,
    result: S.Artifact,
    can: ["user", "remote"],
  },
  {
    op: "artifact.history.undoOrigin",
    about: ["id"],
    input: S.ArtifactHistoryUndoOriginRequest,
    result: S.Artifact,
    can: ["user", "remote"],
  },
  {
    op: "artifact.history.compact",
    about: ["id"],
    input: S.ArtifactHistoryCompactRequest,
    result: S.Artifact,
    can: ["user", "remote"],
  },
  {
    op: "artifact.collab.export",
    about: ["id"],
    input: S.ArtifactCollabExportRequest,
    result: S.ArtifactCollabExportResult,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "artifact.collab.import",
    about: ["id"],
    input: S.ArtifactCollabImportRequest,
    result: S.ArtifactCollabImportResult,
    can: ["user", "remote"],
  },
  {
    op: "artifact.cover.set",
    about: ["id"],
    input: S.ArtifactCoverSetRequest,
    result: S.ArtifactCover,
    can: ["user", "remote"],
  },
];
