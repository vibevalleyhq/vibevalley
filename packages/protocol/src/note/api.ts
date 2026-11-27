import { z } from "zod";

import { type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

const noteDeleteInput = input({ id: S.NoteId });
const noteSuggestionInput = input({ id: S.NoteId, suggestion: S.SuggestionId });

export interface NoteHandlers {
  /** Notes filtered by channel, issue, noteType, or parentId, newest first. */
  readonly "note.list": (a: T.NoteListRequest) => Promise<T.Note[]>;
  readonly "note.get": (a: { readonly id: T.NoteId }) => Promise<T.Note>;
  /** Reads the note's primary entry file content (optionally at a historical immutable snapshot version). */
  readonly "note.content.get": (a: T.NoteReadRequest) => Promise<T.NoteContent>;
  /** Creates a new directory-backed note seeded with starter files for its `noteType`. */
  readonly "note.create": (a: T.NoteRequest) => Promise<T.Note>;
  /** Cuts a new immutable directory snapshot version over the latest state. */
  readonly "note.version.create": (a: T.NoteVersionRequest) => Promise<T.Note>;
  /** Updates a note's title, parent, sort order, or linked issue. */
  readonly "note.update": (a: T.NoteUpdateRequest) => Promise<T.Note>;
  readonly "note.delete": (a: { readonly id: T.NoteId }) => Promise<void>;
  readonly "note.previewDelete": (a: { readonly id: T.NoteId }) => Promise<T.Preview>;
  /** Moves a note within the page tree hierarchy (enforcing cycle protection). */
  readonly "note.tree.move": (a: T.NoteTreeMoveRequest) => Promise<T.Note>;
  /** Lists outgoing `[[note:...]]`/`[[issue:...]]` links and backlinks for a note or issue. */
  readonly "note.link.list": (a: T.NoteLinkListRequest) => Promise<T.NoteLinkListResult>;
  /** Projects a `doc` note's blocks, slide count, word count, and extracted links. */
  readonly "note.doc.view": (a: T.NoteDocViewRequest) => Promise<T.DocView>;
  /** Appends a DocBlock to a `doc` note cleanly via Loro CRDT. */
  readonly "note.doc.appendBlock": (a: T.NoteDocAppendBlockRequest) => Promise<T.DocView>;
  /** Projects a filtered, sorted, grouped, and summarized Multi-Dimensional Base sheet. */
  readonly "note.base.view": (a: T.BaseViewRequest) => Promise<T.BaseViewSnapshot>;
  /** Inserts or updates a row in a `base` note sheet. */
  readonly "note.base.upsertRow": (a: T.BaseUpsertRowRequest) => Promise<T.BaseViewSnapshot>;
  /** Runs an Agent Action column across selected or pending rows of a `base` note sheet. */
  readonly "note.base.runAgentColumn": (a: T.BaseRunAgentColumnRequest) => Promise<T.BaseRunAgentColumnResult>;
  /** All 4 consolidated note primitives (`doc`, `base`, `canvas`, `media`). */
  readonly "note.type.list": () => Promise<T.NoteTypeInfo[]>;
  /** A note primitive's SKILL.md guide or one of its named reference chapters. */
  readonly "note.type.read": (a: T.NoteTypeReadRequest) => Promise<T.NoteTypeGuide>;
  /** Lists files (`manifest.json`, `structure/*`, `asset/*`) inside a note directory. */
  readonly "note.file.list": (a: T.NoteFileListRequest) => Promise<T.NoteFileListResult>;
  /** Reads one file by relative path inside a note directory (or historical version snapshot). */
  readonly "note.file.get": (a: T.NoteFileGetRequest) => Promise<T.NoteFileContent>;
  /** Atomically writes one or more files into `structure/` or `asset/` with origin attribution and collab sync. */
  readonly "note.file.write": (a: T.NoteFileWriteRequest) => Promise<T.NoteFileWriteResult>;
  /** Deletes a relative path under `structure/` or `asset/` with origin attribution and collab sync. */
  readonly "note.file.delete": (a: T.NoteFileDeleteRequest) => Promise<T.NoteFileDeleteResult>;
  /** The open and resolved suggestions on a note, oldest first. */
  readonly "note.suggestion.list": (a: { readonly id: T.NoteId }) => Promise<T.Suggestion[]>;
  /** A proposed edit to a file or structured target inside a note directory. */
  readonly "note.suggestion.create": (a: { readonly id: T.NoteId } & T.SuggestionCreate) => Promise<T.Suggestion>;
  /** Accepts a pending suggestion and applies it to the note directory and collab state. */
  readonly "note.suggestion.accept": (a: { readonly id: T.NoteId; readonly suggestion: T.SuggestionId }) => Promise<T.Suggestion>;
  readonly "note.suggestion.reject": (a: { readonly id: T.NoteId; readonly suggestion: T.SuggestionId }) => Promise<T.Suggestion>;
  /** Ephemeral live presence update (cursor, selection, highlight, viewport); never persisted to SQLite. */
  readonly "note.presence.update": (a: T.NotePresenceUpdateRequest) => Promise<void>;
  /** Collaborative commit history timeline, newest first. */
  readonly "note.history.list": (a: T.NoteHistoryListRequest) => Promise<T.NoteHistoryEntry[]>;
  /** Read-only snapshot projection at the requested Loro frontiers. */
  readonly "note.history.preview": (a: T.NoteHistoryPreviewRequest) => Promise<T.NoteHistoryPreviewResult>;
  /** Restore a note to the snapshot at the requested Loro frontiers as a new commit. */
  readonly "note.history.restore": (a: T.NoteHistoryRestoreRequest) => Promise<T.Note>;
  /** Fork a new note starting from the snapshot at the requested Loro frontiers. */
  readonly "note.history.fork": (a: T.NoteHistoryForkRequest) => Promise<T.Note>;
  /** Selectively undo commits matching one origin while preserving concurrent edits from other actors. */
  readonly "note.history.undoOrigin": (a: T.NoteHistoryUndoOriginRequest) => Promise<T.Note>;
  /** Compact old operation history into a shallow snapshot while keeping current state intact. */
  readonly "note.history.compact": (a: T.NoteHistoryCompactRequest) => Promise<T.Note>;
  /** Export incremental Loro CRDT updates (or full snapshot) relative to a client VersionVector. */
  readonly "note.collab.export": (a: T.NoteCollabExportRequest) => Promise<T.NoteCollabExportResult>;
  /** Import incremental Loro CRDT updates (or snapshot) into a note and optionally return missing server updates. */
  readonly "note.collab.import": (a: T.NoteCollabImportRequest) => Promise<T.NoteCollabImportResult>;
  /** Saves a derived auto-captured cover image outside the note directory and CRDT. */
  readonly "note.cover.set": (a: T.NoteCoverSetRequest) => Promise<T.NoteCover>;
}

export const noteEndpoints: readonly Endpoint[] = [
  {
    op: "note.list",
    about: [],
    input: S.NoteListRequest,
    result: z.array(S.Note),
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "note.get",
    about: ["id"],
    input: input({ id: S.NoteId }),
    result: S.Note,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "note.content.get",
    about: ["id"],
    input: S.NoteReadRequest,
    result: S.NoteContent,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "note.create",
    about: [],
    input: S.NoteRequest,
    result: S.Note,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "note.version.create",
    about: ["id"],
    input: S.NoteVersionRequest,
    result: S.Note,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "note.update",
    about: ["id"],
    input: S.NoteUpdateRequest,
    result: S.Note,
    can: ["user", "remote"],
  },
  {
    op: "note.delete",
    about: ["id"],
    input: noteDeleteInput,
    result: undefined,
    can: ["user", "remote"],
    dryRun: "note.previewDelete",
  },
  {
    op: "note.previewDelete",
    about: ["id"],
    input: noteDeleteInput,
    result: S.Preview,
    can: ["user", "remote"],
  },
  {
    op: "note.tree.move",
    about: ["id"],
    input: S.NoteTreeMoveRequest,
    result: S.Note,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "note.link.list",
    about: ["entityId"],
    input: S.NoteLinkListRequest,
    result: S.NoteLinkListResult,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "note.doc.view",
    about: ["id"],
    input: S.NoteDocViewRequest,
    result: S.DocView,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "note.doc.appendBlock",
    about: ["id"],
    input: S.NoteDocAppendBlockRequest,
    result: S.DocView,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "note.base.view",
    about: ["id"],
    input: S.BaseViewRequest,
    result: S.BaseViewSnapshot,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "note.base.upsertRow",
    about: ["id"],
    input: S.BaseUpsertRowRequest,
    result: S.BaseViewSnapshot,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "note.base.runAgentColumn",
    about: ["id"],
    input: S.BaseRunAgentColumnRequest,
    result: S.BaseRunAgentColumnResult,
    can: ["user", "remote", "orchestrator"],
  },
  {
    op: "note.type.list",
    about: [],
    input: undefined,
    result: z.array(S.NoteTypeInfo),
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "note.type.read",
    about: [],
    input: S.NoteTypeReadRequest,
    result: S.NoteTypeGuide,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "note.file.list",
    about: ["id"],
    input: S.NoteFileListRequest,
    result: S.NoteFileListResult,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "note.file.get",
    about: ["id"],
    input: S.NoteFileGetRequest,
    result: S.NoteFileContent,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "note.file.write",
    about: ["id"],
    input: S.NoteFileWriteRequest,
    result: S.NoteFileWriteResult,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "note.file.delete",
    about: ["id"],
    input: S.NoteFileDeleteRequest,
    result: S.NoteFileDeleteResult,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "note.suggestion.list",
    about: ["id"],
    input: input({ id: S.NoteId }),
    result: z.array(S.Suggestion),
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "note.suggestion.create",
    about: ["id"],
    input: input({ id: S.NoteId }, S.SuggestionCreate),
    result: S.Suggestion,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "note.suggestion.accept",
    about: ["id"],
    input: noteSuggestionInput,
    result: S.Suggestion,
    can: ["user", "remote"],
  },
  {
    op: "note.suggestion.reject",
    about: ["id"],
    input: noteSuggestionInput,
    result: S.Suggestion,
    can: ["user", "remote"],
  },
  {
    op: "note.presence.update",
    about: ["id"],
    input: S.NotePresenceUpdateRequest,
    result: undefined,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "note.history.list",
    about: ["id"],
    input: S.NoteHistoryListRequest,
    result: z.array(S.NoteHistoryEntry),
    can: ["user", "remote"],
  },
  {
    op: "note.history.preview",
    about: ["id"],
    input: S.NoteHistoryPreviewRequest,
    result: S.NoteHistoryPreviewResult,
    can: ["user", "remote"],
  },
  {
    op: "note.history.restore",
    about: ["id"],
    input: S.NoteHistoryRestoreRequest,
    result: S.Note,
    can: ["user", "remote"],
  },
  {
    op: "note.history.fork",
    about: ["id"],
    input: S.NoteHistoryForkRequest,
    result: S.Note,
    can: ["user", "remote"],
  },
  {
    op: "note.history.undoOrigin",
    about: ["id"],
    input: S.NoteHistoryUndoOriginRequest,
    result: S.Note,
    can: ["user", "remote"],
  },
  {
    op: "note.history.compact",
    about: ["id"],
    input: S.NoteHistoryCompactRequest,
    result: S.Note,
    can: ["user", "remote"],
  },
  {
    op: "note.collab.export",
    about: ["id"],
    input: S.NoteCollabExportRequest,
    result: S.NoteCollabExportResult,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "note.collab.import",
    about: ["id"],
    input: S.NoteCollabImportRequest,
    result: S.NoteCollabImportResult,
    can: ["user", "remote"],
  },
  {
    op: "note.cover.set",
    about: ["id"],
    input: S.NoteCoverSetRequest,
    result: S.NoteCover,
    can: ["user", "remote"],
  },
];
