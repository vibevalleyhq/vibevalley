use crate::wire::{Caller, Endpoint};

pub(super) const ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        op: "note.list",
        module: "note",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteListRequest"),
        result: Some("Vec<Note>"),
    },
    Endpoint {
        op: "note.get",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteGetInput"),
        result: Some("Note"),
    },
    Endpoint {
        op: "note.content.get",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteReadRequest"),
        result: Some("NoteContent"),
    },
    Endpoint {
        op: "note.create",
        module: "note",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteRequest"),
        result: Some("Note"),
    },
    Endpoint {
        op: "note.version.create",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteVersionRequest"),
        result: Some("Note"),
    },
    Endpoint {
        op: "note.update",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteUpdateRequest"),
        result: Some("Note"),
    },
    Endpoint {
        op: "note.delete",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: Some("note.previewDelete"),
        input: Some("NoteDeleteInput"),
        result: None,
    },
    Endpoint {
        op: "note.previewDelete",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteDeleteInput"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "note.tree.move",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteTreeMoveRequest"),
        result: Some("Note"),
    },
    Endpoint {
        op: "note.link.list",
        module: "note",
        about: &["entityId"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteLinkListRequest"),
        result: Some("NoteLinkListResult"),
    },
    Endpoint {
        op: "note.doc.view",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteDocViewRequest"),
        result: Some("DocView"),
    },
    Endpoint {
        op: "note.doc.appendBlock",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteDocAppendBlockRequest"),
        result: Some("DocView"),
    },
    Endpoint {
        op: "note.base.view",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("BaseViewRequest"),
        result: Some("BaseViewSnapshot"),
    },
    Endpoint {
        op: "note.base.upsertRow",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("BaseUpsertRowRequest"),
        result: Some("BaseViewSnapshot"),
    },
    Endpoint {
        op: "note.base.runAgentColumn",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("BaseRunAgentColumnRequest"),
        result: Some("BaseRunAgentColumnResult"),
    },
    Endpoint {
        op: "note.annotation.upsert",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteAnnotationUpsertRequest"),
        result: Some("NoteAnnotationMutationResult"),
    },
    Endpoint {
        op: "note.annotation.delete",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteAnnotationDeleteRequest"),
        result: Some("NoteAnnotationMutationResult"),
    },
    Endpoint {
        op: "note.base.syncReview",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteReviewSyncRequest"),
        result: Some("NoteReviewSyncResult"),
    },
    Endpoint {
        op: "note.type.list",
        module: "note",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: None,
        result: Some("Vec<NoteTypeInfo>"),
    },
    Endpoint {
        op: "note.type.read",
        module: "note",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteTypeReadRequest"),
        result: Some("NoteTypeGuide"),
    },
    Endpoint {
        op: "note.file.list",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteFileListRequest"),
        result: Some("NoteFileListResult"),
    },
    Endpoint {
        op: "note.file.get",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteFileGetRequest"),
        result: Some("NoteFileContent"),
    },
    Endpoint {
        op: "note.file.write",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteFileWriteRequest"),
        result: Some("NoteFileWriteResult"),
    },
    Endpoint {
        op: "note.file.delete",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteFileDeleteRequest"),
        result: Some("NoteFileDeleteResult"),
    },
    Endpoint {
        op: "note.suggestion.list",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteSuggestionListInput"),
        result: Some("Vec<Suggestion>"),
    },
    Endpoint {
        op: "note.suggestion.create",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteSuggestionCreateInput"),
        result: Some("Suggestion"),
    },
    Endpoint {
        op: "note.suggestion.accept",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteSuggestionAcceptInput"),
        result: Some("Suggestion"),
    },
    Endpoint {
        op: "note.suggestion.reject",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteSuggestionAcceptInput"),
        result: Some("Suggestion"),
    },
    Endpoint {
        op: "note.presence.update",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NotePresenceUpdateRequest"),
        result: None,
    },
    Endpoint {
        op: "note.history.list",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteHistoryListRequest"),
        result: Some("Vec<NoteHistoryEntry>"),
    },
    Endpoint {
        op: "note.history.preview",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteHistoryPreviewRequest"),
        result: Some("NoteHistoryPreviewResult"),
    },
    Endpoint {
        op: "note.history.restore",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteHistoryRestoreRequest"),
        result: Some("Note"),
    },
    Endpoint {
        op: "note.history.fork",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteHistoryForkRequest"),
        result: Some("Note"),
    },
    Endpoint {
        op: "note.history.undoOrigin",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteHistoryUndoOriginRequest"),
        result: Some("Note"),
    },
    Endpoint {
        op: "note.history.compact",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteHistoryCompactRequest"),
        result: Some("Note"),
    },
    Endpoint {
        op: "note.collab.export",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("NoteCollabExportRequest"),
        result: Some("NoteCollabExportResult"),
    },
    Endpoint {
        op: "note.collab.import",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteCollabImportRequest"),
        result: Some("NoteCollabImportResult"),
    },
    Endpoint {
        op: "note.cover.set",
        module: "note",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NoteCoverSetRequest"),
        result: Some("NoteCover"),
    },
];

pub mod ops {
    use crate::contract as t;
    use crate::wire::Op;

    /// The notes announced in a channel or made for an issue, newest change first; every one the workspace has when neither is given.
    pub struct NoteList;
    impl Op for NoteList {
        const NAME: &'static str = "note.list";
        type Input = t::NoteListRequest;
        type Result = Vec<t::Note>;
    }
    pub struct NoteGet;
    impl Op for NoteGet {
        const NAME: &'static str = "note.get";
        type Input = t::NoteGetInput;
        type Result = t::Note;
    }
    /// Reads the note's primary entry file content (optionally at a historical version snapshot).
    pub struct NoteContentGet;
    impl Op for NoteContentGet {
        const NAME: &'static str = "note.content.get";
        type Input = t::NoteReadRequest;
        type Result = t::NoteContent;
    }
    /// Creates a new directory-backed note seeded with starter files for its `note_type`.
    pub struct NoteCreate;
    impl Op for NoteCreate {
        const NAME: &'static str = "note.create";
        type Input = t::NoteRequest;
        type Result = t::Note;
    }
    /// Cuts a new immutable directory snapshot version over the latest state.
    pub struct NoteVersionCreate;
    impl Op for NoteVersionCreate {
        const NAME: &'static str = "note.version.create";
        type Input = t::NoteVersionRequest;
        type Result = t::Note;
    }
    /// Updates a note's title, tree placement, or linked issue.
    pub struct NoteUpdate;
    impl Op for NoteUpdate {
        const NAME: &'static str = "note.update";
        type Input = t::NoteUpdateRequest;
        type Result = t::Note;
    }
    pub struct NoteDelete;
    impl Op for NoteDelete {
        const NAME: &'static str = "note.delete";
        type Input = t::NoteDeleteInput;
        type Result = ();
    }
    pub struct NotePreviewDelete;
    impl Op for NotePreviewDelete {
        const NAME: &'static str = "note.previewDelete";
        type Input = t::NoteDeleteInput;
        type Result = t::Preview;
    }
    /// Moves a note in the workspace page tree (`parent_id`, `sort_order`).
    pub struct NoteTreeMove;
    impl Op for NoteTreeMove {
        const NAME: &'static str = "note.tree.move";
        type Input = t::NoteTreeMoveRequest;
        type Result = t::Note;
    }
    /// Lists outgoing links and incoming backlinks for a note or issue.
    pub struct NoteLinkList;
    impl Op for NoteLinkList {
        const NAME: &'static str = "note.link.list";
        type Input = t::NoteLinkListRequest;
        type Result = t::NoteLinkListResult;
    }
    /// Projects a `doc` note into strongly-typed `DocView` blocks, counts, and extracted links.
    pub struct NoteDocView;
    impl Op for NoteDocView {
        const NAME: &'static str = "note.doc.view";
        type Input = t::NoteDocViewRequest;
        type Result = t::DocView;
    }
    /// Appends a strongly-typed `DocBlock` into a `doc` note.
    pub struct NoteDocAppendBlock;
    impl Op for NoteDocAppendBlock {
        const NAME: &'static str = "note.doc.appendBlock";
        type Input = t::NoteDocAppendBlockRequest;
        type Result = t::DocView;
    }
    /// Projects a `base` note into filtered/sorted/grouped `BaseViewSnapshot`.
    pub struct NoteBaseView;
    impl Op for NoteBaseView {
        const NAME: &'static str = "note.base.view";
        type Input = t::BaseViewRequest;
        type Result = t::BaseViewSnapshot;
    }
    /// Creates or updates a row in a `base` note and returns the refreshed view snapshot.
    pub struct NoteBaseUpsertRow;
    impl Op for NoteBaseUpsertRow {
        const NAME: &'static str = "note.base.upsertRow";
        type Input = t::BaseUpsertRowRequest;
        type Result = t::BaseViewSnapshot;
    }
    /// Runs an `agentAction` column across selected rows of a `base` note.
    pub struct NoteBaseRunAgentColumn;
    impl Op for NoteBaseRunAgentColumn {
        const NAME: &'static str = "note.base.runAgentColumn";
        type Input = t::BaseRunAgentColumnRequest;
        type Result = t::BaseRunAgentColumnResult;
    }
    /// Upserts a non-destructive `MediaAnnotation` on a `doc` media/compare block or `media` note and optionally syncs its linked `base` row.
    pub struct NoteAnnotationUpsert;
    impl Op for NoteAnnotationUpsert {
        const NAME: &'static str = "note.annotation.upsert";
        type Input = t::NoteAnnotationUpsertRequest;
        type Result = t::NoteAnnotationMutationResult;
    }
    /// Deletes a non-destructive `MediaAnnotation` from a `doc` media/compare block or `media` note.
    pub struct NoteAnnotationDelete;
    impl Op for NoteAnnotationDelete {
        const NAME: &'static str = "note.annotation.delete";
        type Input = t::NoteAnnotationDeleteRequest;
        type Result = t::NoteAnnotationMutationResult;
    }
    /// Bidirectionally syncs `MediaAnnotation` pins in a `doc` note with an embedded `base` review checklist (creating one from the built-in template when absent).
    pub struct NoteBaseSyncReview;
    impl Op for NoteBaseSyncReview {
        const NAME: &'static str = "note.base.syncReview";
        type Input = t::NoteReviewSyncRequest;
        type Result = t::NoteReviewSyncResult;
    }
    /// All 4 note primitives (`doc`, `base`, `canvas`, `media`).
    pub struct NoteTypeList;
    impl Op for NoteTypeList {
        const NAME: &'static str = "note.type.list";
        type Input = ();
        type Result = Vec<t::NoteTypeInfo>;
    }
    /// A note type's SKILL.md guide or one of its named reference chapters.
    pub struct NoteTypeRead;
    impl Op for NoteTypeRead {
        const NAME: &'static str = "note.type.read";
        type Input = t::NoteTypeReadRequest;
        type Result = t::NoteTypeGuide;
    }
    /// Lists files (`manifest.json`, `structure/*`, `asset/*`) inside a note directory.
    pub struct NoteFileList;
    impl Op for NoteFileList {
        const NAME: &'static str = "note.file.list";
        type Input = t::NoteFileListRequest;
        type Result = t::NoteFileListResult;
    }
    /// Reads one file by relative path inside a note directory (or historical version snapshot).
    pub struct NoteFileGet;
    impl Op for NoteFileGet {
        const NAME: &'static str = "note.file.get";
        type Input = t::NoteFileGetRequest;
        type Result = t::NoteFileContent;
    }
    /// Atomically writes one or more files into `structure/` or `asset/` with origin attribution and collab sync.
    pub struct NoteFileWrite;
    impl Op for NoteFileWrite {
        const NAME: &'static str = "note.file.write";
        type Input = t::NoteFileWriteRequest;
        type Result = t::NoteFileWriteResult;
    }
    /// Deletes a relative path under `structure/` or `asset/` with origin attribution and collab sync.
    pub struct NoteFileDelete;
    impl Op for NoteFileDelete {
        const NAME: &'static str = "note.file.delete";
        type Input = t::NoteFileDeleteRequest;
        type Result = t::NoteFileDeleteResult;
    }
    /// The open and resolved suggestions on a note, oldest first.
    pub struct NoteSuggestionList;
    impl Op for NoteSuggestionList {
        const NAME: &'static str = "note.suggestion.list";
        type Input = t::NoteSuggestionListInput;
        type Result = Vec<t::Suggestion>;
    }
    /// A proposed edit to a file or structured target inside a note directory.
    pub struct NoteSuggestionCreate;
    impl Op for NoteSuggestionCreate {
        const NAME: &'static str = "note.suggestion.create";
        type Input = t::NoteSuggestionCreateInput;
        type Result = t::Suggestion;
    }
    /// Accepts a pending suggestion and applies it to the note directory and collab state.
    pub struct NoteSuggestionAccept;
    impl Op for NoteSuggestionAccept {
        const NAME: &'static str = "note.suggestion.accept";
        type Input = t::NoteSuggestionAcceptInput;
        type Result = t::Suggestion;
    }
    pub struct NoteSuggestionReject;
    impl Op for NoteSuggestionReject {
        const NAME: &'static str = "note.suggestion.reject";
        type Input = t::NoteSuggestionAcceptInput;
        type Result = t::Suggestion;
    }
    /// Ephemeral live presence update (cursor, selection, highlight, viewport); never persisted to SQLite.
    pub struct NotePresenceUpdate;
    impl Op for NotePresenceUpdate {
        const NAME: &'static str = "note.presence.update";
        type Input = t::NotePresenceUpdateRequest;
        type Result = ();
    }
    /// Commit history timeline for a collaborative note, newest first.
    pub struct NoteHistoryList;
    impl Op for NoteHistoryList {
        const NAME: &'static str = "note.history.list";
        type Input = t::NoteHistoryListRequest;
        type Result = Vec<t::NoteHistoryEntry>;
    }
    /// Read-only snapshot projection at the requested Loro frontiers.
    pub struct NoteHistoryPreview;
    impl Op for NoteHistoryPreview {
        const NAME: &'static str = "note.history.preview";
        type Input = t::NoteHistoryPreviewRequest;
        type Result = t::NoteHistoryPreviewResult;
    }
    /// Restore a note to the snapshot at the requested Loro frontiers as a new commit.
    pub struct NoteHistoryRestore;
    impl Op for NoteHistoryRestore {
        const NAME: &'static str = "note.history.restore";
        type Input = t::NoteHistoryRestoreRequest;
        type Result = t::Note;
    }
    /// Fork a new note starting from the snapshot at the requested Loro frontiers.
    pub struct NoteHistoryFork;
    impl Op for NoteHistoryFork {
        const NAME: &'static str = "note.history.fork";
        type Input = t::NoteHistoryForkRequest;
        type Result = t::Note;
    }
    /// Selectively undo commits matching one origin while preserving concurrent edits from other actors.
    pub struct NoteHistoryUndoOrigin;
    impl Op for NoteHistoryUndoOrigin {
        const NAME: &'static str = "note.history.undoOrigin";
        type Input = t::NoteHistoryUndoOriginRequest;
        type Result = t::Note;
    }
    /// Compact old operation history into a shallow snapshot while keeping current state intact.
    pub struct NoteHistoryCompact;
    impl Op for NoteHistoryCompact {
        const NAME: &'static str = "note.history.compact";
        type Input = t::NoteHistoryCompactRequest;
        type Result = t::Note;
    }
    /// Export incremental Loro CRDT updates (or snapshot) relative to a client VersionVector.
    pub struct NoteCollabExport;
    impl Op for NoteCollabExport {
        const NAME: &'static str = "note.collab.export";
        type Input = t::NoteCollabExportRequest;
        type Result = t::NoteCollabExportResult;
    }
    /// Import incremental Loro CRDT updates (or snapshot) into a note and optionally return missing server updates.
    pub struct NoteCollabImport;
    impl Op for NoteCollabImport {
        const NAME: &'static str = "note.collab.import";
        type Input = t::NoteCollabImportRequest;
        type Result = t::NoteCollabImportResult;
    }
    /// Saves a derived auto-captured cover image outside the note directory and CRDT.
    pub struct NoteCoverSet;
    impl Op for NoteCoverSet {
        const NAME: &'static str = "note.cover.set";
        type Input = t::NoteCoverSetRequest;
        type Result = t::NoteCover;
    }
}
