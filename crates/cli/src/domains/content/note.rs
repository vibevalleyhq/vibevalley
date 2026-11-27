//! `note list|show|read|create|version|update|delete|move|links|doc-view|doc-append|base-view|base-upsert|base-run|cover`,
//! `note type ...`, `note file ...`, `note suggestion ...`, and `note history ...`.

use std::collections::BTreeMap;

use clap::{Args, Subcommand, ValueEnum};
use vibevalley_protocol::{
    BaseCellValue, BaseRunAgentColumnRequest, BaseUpsertRowRequest, BaseViewRequest, DocBlock, LinkEntityKind, Note, NoteCoverSetRequest, NoteDeleteInput,
    NoteDocAppendBlockRequest, NoteDocViewRequest, NoteFileDeleteRequest, NoteFileDeleteResult, NoteFileEncoding, NoteFileGetRequest, NoteFileListRequest,
    NoteFileWriteItem, NoteFileWriteRequest, NoteFileWriteResult, NoteGetInput, NoteHistoryCompactRequest, NoteHistoryForkRequest, NoteHistoryListRequest,
    NoteHistoryPreviewRequest, NoteHistoryRestoreRequest, NoteHistoryUndoOriginRequest, NoteLinkListRequest, NoteListRequest, NoteReadRequest, NoteRequest,
    NoteSuggestionAcceptInput, NoteSuggestionCreateInput, NoteSuggestionListInput, NoteTreeMoveRequest, NoteType, NoteTypeReadRequest, NoteUpdateRequest,
    NoteVersionRequest, Suggestion, SuggestionChange, ops,
};

use crate::client::{Client, Done, Failure};
use crate::output::{issue_ref, line, read_json_input, read_text_input};

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum NoteTypeArg {
    Doc,
    Base,
    Canvas,
    Media,
}

impl From<NoteTypeArg> for NoteType {
    fn from(value: NoteTypeArg) -> Self {
        match value {
            NoteTypeArg::Doc => NoteType::Doc,
            NoteTypeArg::Base => NoteType::Base,
            NoteTypeArg::Canvas => NoteType::Canvas,
            NoteTypeArg::Media => NoteType::Media,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum FileEncodingArg {
    Utf8,
    Base64,
}

impl From<FileEncodingArg> for NoteFileEncoding {
    fn from(value: FileEncodingArg) -> Self {
        match value {
            FileEncodingArg::Utf8 => NoteFileEncoding::Utf8,
            FileEncodingArg::Base64 => NoteFileEncoding::Base64,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum LinkEntityKindArg {
    Note,
    Issue,
}

impl From<LinkEntityKindArg> for LinkEntityKind {
    fn from(value: LinkEntityKindArg) -> Self {
        match value {
            LinkEntityKindArg::Note => LinkEntityKind::Note,
            LinkEntityKindArg::Issue => LinkEntityKind::Issue,
        }
    }
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct NoteCmd {
    #[command(subcommand)]
    pub action: NoteAction,
}

#[derive(Debug, Subcommand)]
pub enum NoteAction {
    /// List notes with optional filters
    #[command(after_help = "Examples:\n  vibevalley note list\n  vibevalley note list --type canvas --json")]
    List {
        /// Filter by issue number or id
        #[arg(long)]
        issue: Option<String>,
        /// Filter by channel id
        #[arg(long)]
        channel: Option<String>,
        /// Filter by note type
        #[arg(long = "type", value_enum)]
        note_type: Option<NoteTypeArg>,
        /// Filter by parent note id
        #[arg(long)]
        parent: Option<String>,
    },
    /// Show metadata for one note
    #[command(after_help = "Examples:\n  vibevalley note show n1")]
    Show {
        /// Note id
        note: String,
    },
    /// Read a note's primary entry file content
    #[command(after_help = "Examples:\n  vibevalley note read n1\n  vibevalley note read n1 --version 2")]
    Read {
        /// Note id
        note: String,
        /// Optional immutable snapshot version number
        #[arg(long)]
        version: Option<i64>,
    },
    /// Create a new directory-backed note
    #[command(
        after_help = "Examples:\n  vibevalley note create 'Architecture' --type canvas\n  vibevalley note create 'Launch Spec' --type doc --content @doc.json"
    )]
    Create {
        /// Note title
        title: String,
        /// Note type (`doc`, `base`, `canvas`, or `media`)
        #[arg(long = "type", value_enum, default_value_t = NoteTypeArg::Doc)]
        note_type: NoteTypeArg,
        /// Optional parent note id in the page tree
        #[arg(long)]
        parent: Option<String>,
        /// Optional sort order among siblings
        #[arg(long)]
        sort_order: Option<i64>,
        /// Optional initial primary entry content (inline text, '-' for stdin, or '@file')
        #[arg(long)]
        content: Option<String>,
        /// Channel id to announce in
        #[arg(long)]
        channel: Option<String>,
        /// Linked issue number or id
        #[arg(long)]
        issue: Option<String>,
        /// Version/announcement note
        #[arg(long)]
        note: Option<String>,
        /// Announce card in the target channel
        #[arg(long)]
        announce: bool,
    },
    /// Cut an immutable directory snapshot version of a note
    #[command(after_help = "Examples:\n  vibevalley note version n1 --note 'Milestone v1'")]
    Version {
        /// Note id
        note_id: String,
        /// Optional updated primary entry content before snapshotting (inline, '-', or '@file')
        #[arg(long)]
        content: Option<String>,
        /// Snapshot note
        #[arg(long)]
        note: Option<String>,
    },
    /// Update a note's title, parent, sort order, or linked issue
    #[command(after_help = "Examples:\n  vibevalley note update n1 --title 'Renamed'\n  vibevalley note update n1 --issue 42")]
    Update {
        /// Note id
        note: String,
        /// New title
        #[arg(long)]
        title: Option<String>,
        /// Parent note id, or empty string '' to move to root
        #[arg(long)]
        parent: Option<String>,
        /// Sort order among siblings
        #[arg(long)]
        sort_order: Option<i64>,
        /// Link to an issue number/id, or empty string '' to unlink
        #[arg(long)]
        issue: Option<String>,
    },
    /// Delete a note
    #[command(after_help = "Examples:\n  vibevalley note delete n1 --dry-run")]
    Delete {
        /// Note id
        note: String,
    },
    /// Move a note in the page tree hierarchy
    #[command(after_help = "Examples:\n  vibevalley note move n2 --parent n1 --sort-order 10")]
    Move {
        /// Note id
        note: String,
        /// New parent note id (omit to move to root)
        #[arg(long)]
        parent: Option<String>,
        /// Target sort order
        #[arg(long, default_value_t = 0)]
        sort_order: i64,
    },
    /// List outgoing links and backlinks for a note or issue
    #[command(after_help = "Examples:\n  vibevalley note links note n1\n  vibevalley note links issue 42")]
    Links {
        /// Entity kind (`note` or `issue`)
        #[arg(value_enum)]
        kind: LinkEntityKindArg,
        /// Entity id or issue number
        id: String,
    },
    /// View structured Block Doc projection (`doc` notes)
    #[command(after_help = "Examples:\n  vibevalley note doc-view n1")]
    DocView {
        /// Note id
        note: String,
    },
    /// Append a DocBlock JSON object to a `doc` note
    #[command(after_help = "Examples:\n  vibevalley note doc-append n1 @block.json")]
    DocAppend {
        /// Note id
        note: String,
        /// DocBlock JSON (inline, '-', or '@file')
        block: String,
        /// Insert after an existing block id
        #[arg(long)]
        after: Option<String>,
        /// Optional origin attribution override
        #[arg(long)]
        origin: Option<String>,
    },
    /// View a filtered/sorted/grouped Base sheet (`base` notes)
    #[command(after_help = "Examples:\n  vibevalley note base-view n1")]
    BaseView {
        /// Note id
        note: String,
        /// Optional sheet id
        #[arg(long)]
        sheet: Option<String>,
        /// Optional view id
        #[arg(long)]
        view: Option<String>,
    },
    /// Insert or update a row in a `base` note
    #[command(after_help = "Examples:\n  vibevalley note base-upsert n1 '{\"c_title\":{\"_tag\":\"text\",\"value\":\"Hi\"}}'")]
    BaseUpsert {
        /// Note id
        note: String,
        /// JSON object mapping column id -> BaseCellValue (inline, '-', or '@file')
        cells: String,
        /// Optional sheet id
        #[arg(long)]
        sheet: Option<String>,
        /// Optional existing row id to update
        #[arg(long)]
        row: Option<String>,
        /// Optional origin attribution override
        #[arg(long)]
        origin: Option<String>,
    },
    /// Execute an Agent Action column across rows of a `base` note
    #[command(after_help = "Examples:\n  vibevalley note base-run n1 c_agent --row r1")]
    BaseRun {
        /// Note id
        note: String,
        /// Agent Action column id
        column: String,
        /// Optional sheet id
        #[arg(long)]
        sheet: Option<String>,
        /// Specific row id(s) to run (repeatable)
        #[arg(long = "row")]
        rows: Vec<String>,
        /// Optional origin attribution override
        #[arg(long)]
        origin: Option<String>,
    },
    /// Set cover preview thumbnail for a note
    #[command(after_help = "Examples:\n  vibevalley note cover n1 @cover.b64 --seq 1 --mime image/png")]
    Cover {
        /// Note id
        note: String,
        /// Rendered note seq
        #[arg(long)]
        seq: i64,
        /// Image MIME type (`image/png`, `image/jpeg`, `image/webp`)
        #[arg(long)]
        mime: String,
        /// Base64 image data (inline, '-', or '@file')
        data: String,
        /// Optional image width
        #[arg(long)]
        width: Option<u32>,
        /// Optional image height
        #[arg(long)]
        height: Option<u32>,
    },
    /// Inspect the 4 note primitives and their progressive-disclosure guides
    Type(NoteTypeCmd),
    /// Read, write, and delete files inside a note directory (`manifest.json`, `structure/*`, `asset/*`)
    File(NoteFileCmd),
    /// List, create, accept, and reject collaborative suggestions on a note
    Suggestion(NoteSuggestionCmd),
    /// Inspect and manage collaborative change history on a note
    History(NoteHistoryCmd),
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct NoteTypeCmd {
    #[command(subcommand)]
    pub action: NoteTypeAction,
}

#[derive(Debug, Subcommand)]
pub enum NoteTypeAction {
    /// List all 4 note primitives
    #[command(after_help = "Examples:\n  vibevalley note type list --json")]
    List,
    /// Read a primitive's SKILL guide or a named reference chapter
    #[command(after_help = "Examples:\n  vibevalley note type read doc")]
    Read {
        /// Note type
        #[arg(value_enum)]
        note_type: NoteTypeArg,
        /// Optional reference chapter name
        #[arg(long)]
        reference: Option<String>,
    },
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct NoteFileCmd {
    #[command(subcommand)]
    pub action: NoteFileAction,
}

#[derive(Debug, Subcommand)]
pub enum NoteFileAction {
    /// List files inside a note directory
    #[command(after_help = "Examples:\n  vibevalley note file list n1 --prefix structure/")]
    List {
        /// Note id
        note: String,
        /// Optional relative path prefix filter (e.g. structure/ or asset/)
        #[arg(long)]
        prefix: Option<String>,
    },
    /// Read one file from a note directory
    #[command(after_help = "Examples:\n  vibevalley note file get n1 structure/doc.json")]
    Get {
        /// Note id
        note: String,
        /// Relative file path inside the note directory
        path: String,
        /// Optional immutable version snapshot number
        #[arg(long)]
        version: Option<i64>,
    },
    /// Write one file into `structure/` or `asset/` with origin attribution
    #[command(after_help = "Examples:\n  vibevalley note file write n1 structure/doc.json @doc.json --summary 'Update blocks'")]
    Write {
        /// Note id
        note: String,
        /// Relative file path (`structure/*` or `asset/*`)
        path: String,
        /// File content (inline text/base64, '-' for stdin, or '@file')
        content: String,
        /// Content encoding (utf8 or base64)
        #[arg(long, value_enum)]
        encoding: Option<FileEncodingArg>,
        /// Optional MIME type override
        #[arg(long)]
        mime: Option<String>,
        /// Optimistic concurrency guard matching current SHA-256 hash ("" requires absent)
        #[arg(long)]
        expected_hash: Option<String>,
        /// Optional origin attribution override
        #[arg(long)]
        origin: Option<String>,
        /// Optional change summary
        #[arg(long)]
        summary: Option<String>,
        /// Announce update in channel
        #[arg(long)]
        announce: bool,
    },
    /// Atomically write a JSON array of NoteFileWriteItem objects
    #[command(after_help = "Examples:\n  vibevalley note file batch n1 @files.json --summary 'Seed layout'")]
    Batch {
        /// Note id
        note: String,
        /// JSON array of NoteFileWriteItem (inline, '-', or '@file')
        files: String,
        /// Optional origin attribution override
        #[arg(long)]
        origin: Option<String>,
        /// Optional change summary
        #[arg(long)]
        summary: Option<String>,
        /// Announce update in channel
        #[arg(long)]
        announce: bool,
    },
    /// Delete a relative file under `structure/` or `asset/`
    #[command(after_help = "Examples:\n  vibevalley note file delete n1 asset/old.png")]
    Delete {
        /// Note id
        note: String,
        /// Relative file path under `structure/` or `asset/`
        path: String,
        /// Optional origin attribution override
        #[arg(long)]
        origin: Option<String>,
        /// Optional change summary
        #[arg(long)]
        summary: Option<String>,
    },
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct NoteSuggestionCmd {
    #[command(subcommand)]
    pub action: NoteSuggestionAction,
}

#[derive(Debug, Subcommand)]
pub enum NoteSuggestionAction {
    /// List suggestions on a note
    #[command(after_help = "Examples:\n  vibevalley note suggestion list n1")]
    List {
        /// Note id
        note: String,
    },
    /// Create a review suggestion on a file in a note
    #[command(after_help = "Examples:\n  vibevalley note suggestion create n1 structure/doc.json --content 'Updated'")]
    Create {
        /// Note id
        note: String,
        /// Relative file path
        path: String,
        /// Base note seq
        #[arg(long, default_value_t = 0)]
        base_rev: i64,
        /// Optional base file SHA-256 hash
        #[arg(long)]
        base_hash: Option<String>,
        /// Replacement file content (inline, '-', or '@file')
        #[arg(long)]
        content: Option<String>,
        /// RFC 7396 JSON merge patch (inline, '-', or '@file')
        #[arg(long)]
        patch: Option<String>,
        /// Optional target node/element/selector inside the file
        #[arg(long)]
        target: Option<String>,
        /// Propose deleting the file or target
        #[arg(long)]
        delete: bool,
        /// Short summary of the proposed change
        #[arg(long)]
        summary: Option<String>,
    },
    /// Accept a pending suggestion
    #[command(after_help = "Examples:\n  vibevalley note suggestion accept n1 s1")]
    Accept {
        /// Note id
        note: String,
        /// Suggestion id
        suggestion: String,
    },
    /// Reject a pending suggestion
    #[command(after_help = "Examples:\n  vibevalley note suggestion reject n1 s1")]
    Reject {
        /// Note id
        note: String,
        /// Suggestion id
        suggestion: String,
    },
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct NoteHistoryCmd {
    #[command(subcommand)]
    pub action: NoteHistoryAction,
}

#[derive(Debug, Subcommand)]
pub enum NoteHistoryAction {
    /// List collaborative commits, newest first
    #[command(after_help = "Examples:\n  vibevalley note history list n1 --limit 20")]
    List {
        /// Note id
        note: String,
        /// Max commits to return
        #[arg(long)]
        limit: Option<i64>,
    },
    /// Preview files at a historical frontiers checkpoint
    #[command(after_help = "Examples:\n  vibevalley note history preview n1 <frontiers>")]
    Preview {
        /// Note id
        note: String,
        /// Encoded Loro frontiers
        frontiers: String,
    },
    /// Restore a note to a historical frontiers checkpoint
    #[command(after_help = "Examples:\n  vibevalley note history restore n1 <frontiers> --note 'Revert layout'")]
    Restore {
        /// Note id
        note: String,
        /// Encoded Loro frontiers
        frontiers: String,
        /// Optional restore note
        #[arg(long)]
        note_text: Option<String>,
    },
    /// Fork a new note from a historical frontiers checkpoint
    #[command(after_help = "Examples:\n  vibevalley note history fork n1 <frontiers> --title 'Branch A'")]
    Fork {
        /// Note id
        note: String,
        /// Encoded Loro frontiers
        frontiers: String,
        /// Optional title for the forked note
        #[arg(long)]
        title: Option<String>,
        /// Optional channel id
        #[arg(long)]
        channel: Option<String>,
    },
    /// Selectively undo commits from one origin while keeping other concurrent edits
    #[command(after_help = "Examples:\n  vibevalley note history undo-origin n1 session:w1:turn:1")]
    UndoOrigin {
        /// Note id
        note: String,
        /// Origin identifier (e.g. session:w1:turn:1)
        origin: String,
    },
    /// Compact old operation history into a shallow snapshot
    #[command(after_help = "Examples:\n  vibevalley note history compact n1")]
    Compact {
        /// Note id
        note: String,
    },
}

fn note_line(note: &Note) -> String {
    let issue = note.issue.as_ref().map(|i| format!("issue {i}")).unwrap_or_default();
    let parent = note.parent_id.as_ref().map(|p| format!("parent {p}")).unwrap_or_default();
    line(&[
        &note.id,
        &note.title,
        note.note_type.as_str(),
        &format!("seq {}", note.seq),
        &format!("@{}", note.by_name),
        &parent,
        &issue,
    ])
}

fn write_text(res: &NoteFileWriteResult) -> String {
    let sug = res.suggestions.as_ref().map_or(0, Vec::len);
    format!("seq {}  {} files  {} suggestions", res.seq, res.files.len(), sug)
}

fn delete_text(res: &NoteFileDeleteResult) -> String {
    format!("seq {}  deleted {}", res.seq, res.path)
}

fn suggestion_line(s: &Suggestion) -> String {
    let summary = s.change.summary.as_deref().unwrap_or("");
    line(&[&s.id, s.status.as_str(), &s.path, &s.author, summary])
}

pub async fn run(client: &Client, cmd: NoteCmd) -> Done {
    match cmd.action {
        NoteAction::List {
            issue,
            channel,
            note_type,
            parent,
        } => {
            let notes = client
                .ask::<ops::NoteList>(&NoteListRequest {
                    issue: issue.map(|i| issue_ref(&i)),
                    channel,
                    note_type: note_type.map(Into::into),
                    parent_id: parent,
                })
                .await?;
            client.output.show(&notes, |list| list.iter().map(note_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }
        NoteAction::Show { note } => {
            let found = client.ask::<ops::NoteGet>(&NoteGetInput { id: note }).await?;
            client.output.show(&found, note_line);
            Ok(())
        }
        NoteAction::Read { note, version } => {
            let content = client.ask::<ops::NoteContentGet>(&NoteReadRequest { id: note, version }).await?;
            client.output.show(&content, |c| c.content.clone());
            Ok(())
        }
        NoteAction::Create {
            title,
            note_type,
            parent,
            sort_order,
            content,
            channel,
            issue,
            note,
            announce,
        } => {
            let content = content.as_deref().map(read_text_input).transpose()?;
            let request = NoteRequest {
                title,
                note_type: note_type.into(),
                parent_id: parent,
                sort_order,
                content,
                files: None,
                announce: announce.then_some(true),
                note,
                channel,
                issue: issue.map(|i| issue_ref(&i)),
            };
            client.mutate::<ops::NoteCreate>("note create", &request, note_line).await
        }
        NoteAction::Version { note_id, content, note } => {
            let content = content.as_deref().map(read_text_input).transpose()?;
            let request = NoteVersionRequest { id: note_id, content, note };
            client.mutate::<ops::NoteVersionCreate>("note version", &request, note_line).await
        }
        NoteAction::Update {
            note,
            title,
            parent,
            sort_order,
            issue,
        } => {
            if title.is_none() && parent.is_none() && sort_order.is_none() && issue.is_none() {
                return Err(Failure::usage("MissingArgument", "provide at least one field to update"));
            }
            let request = NoteUpdateRequest {
                id: note,
                title,
                parent_id: parent,
                sort_order,
                issue: issue.map(|i| if i.is_empty() { i } else { issue_ref(&i) }),
            };
            client.mutate::<ops::NoteUpdate>("note update", &request, note_line).await
        }
        NoteAction::Delete { note } => {
            let id = note.clone();
            client
                .mutate::<ops::NoteDelete>("note delete", &NoteDeleteInput { id: note }, |_| format!("deleted {id}"))
                .await
        }
        NoteAction::Move { note, parent, sort_order } => {
            let request = NoteTreeMoveRequest {
                id: note,
                parent_id: parent,
                sort_order,
            };
            client.mutate::<ops::NoteTreeMove>("note move", &request, note_line).await
        }
        NoteAction::Links { kind, id } => {
            let entity_kind: LinkEntityKind = kind.into();
            let entity_id = if matches!(entity_kind, LinkEntityKind::Issue) { issue_ref(&id) } else { id };
            let links = client.ask::<ops::NoteLinkList>(&NoteLinkListRequest { entity_kind, entity_id }).await?;
            client.output.show(&links, |res| {
                let mut lines = res
                    .outgoing
                    .iter()
                    .map(|l| format!("-> {}:{} ({})", l.target_kind.as_str(), l.target_id, l.relation.as_str()))
                    .collect::<Vec<_>>();
                lines.extend(
                    res.backlinks
                        .iter()
                        .map(|l| format!("<- {}:{} ({})", l.source_kind.as_str(), l.source_id, l.relation.as_str())),
                );
                lines.join("\n")
            });
            Ok(())
        }
        NoteAction::DocView { note } => {
            let view = client.ask::<ops::NoteDocView>(&NoteDocViewRequest { id: note }).await?;
            client
                .output
                .show(&view, |v| format!("{}  {} blocks  {} words", v.note_id, v.blocks.len(), v.word_count));
            Ok(())
        }
        NoteAction::DocAppend { note, block, after, origin } => {
            let block: DocBlock = read_json_input(&block)?;
            let request = NoteDocAppendBlockRequest {
                id: note,
                block,
                after_block_id: after,
                origin,
            };
            client
                .mutate::<ops::NoteDocAppendBlock>("note doc-append", &request, |v| {
                    format!("{}  {} blocks  {} words", v.note_id, v.blocks.len(), v.word_count)
                })
                .await
        }
        NoteAction::BaseView { note, sheet, view } => {
            let snap = client
                .ask::<ops::NoteBaseView>(&BaseViewRequest {
                    id: note,
                    sheet_id: sheet,
                    view_id: view,
                })
                .await?;
            client.output.show(&snap, |s| {
                format!("{}  sheet {}  view {}  {} rows", s.note_id, s.active_sheet_id, s.active_view_id, s.total_rows)
            });
            Ok(())
        }
        NoteAction::BaseUpsert {
            note,
            cells,
            sheet,
            row,
            origin,
        } => {
            let cells: BTreeMap<String, BaseCellValue> = read_json_input(&cells)?;
            let request = BaseUpsertRowRequest {
                id: note,
                sheet_id: sheet,
                row_id: row,
                cells,
                origin,
            };
            client
                .mutate::<ops::NoteBaseUpsertRow>("note base-upsert", &request, |s| {
                    format!("{}  sheet {}  {} rows", s.note_id, s.active_sheet_id, s.total_rows)
                })
                .await
        }
        NoteAction::BaseRun {
            note,
            column,
            sheet,
            rows,
            origin,
        } => {
            let request = BaseRunAgentColumnRequest {
                id: note,
                sheet_id: sheet,
                column_id: column,
                row_ids: (!rows.is_empty()).then_some(rows),
                origin,
            };
            client
                .mutate::<ops::NoteBaseRunAgentColumn>("note base-run", &request, |r| {
                    format!(
                        "{}  executed {}  rows {}  spawned {}",
                        r.note_id,
                        r.executed,
                        r.updated_row_ids.len(),
                        r.spawned_issue_ids.len()
                    )
                })
                .await
        }
        NoteAction::Cover {
            note,
            seq,
            mime,
            data,
            width,
            height,
        } => {
            let data = read_text_input(&data)?;
            let id = note.clone();
            let request = NoteCoverSetRequest {
                id: note,
                seq,
                mime,
                data,
                width,
                height,
            };
            client
                .mutate::<ops::NoteCoverSet>("note cover", &request, |_| format!("updated cover {id}"))
                .await
        }
        NoteAction::Type(cmd) => match cmd.action {
            NoteTypeAction::List => {
                let types = client.ask::<ops::NoteTypeList>(&()).await?;
                client.output.show(&types, |list| {
                    list.iter()
                        .map(|t| line(&[t.r#type.as_str(), &t.entry, &t.title]))
                        .collect::<Vec<_>>()
                        .join("\n")
                });
                Ok(())
            }
            NoteTypeAction::Read { note_type, reference } => {
                let guide = client
                    .ask::<ops::NoteTypeRead>(&NoteTypeReadRequest {
                        r#type: note_type.into(),
                        reference,
                    })
                    .await?;
                client.output.show(&guide, |g| g.content.clone());
                Ok(())
            }
        },
        NoteAction::File(cmd) => match cmd.action {
            NoteFileAction::List { note, prefix } => {
                let listing = client.ask::<ops::NoteFileList>(&NoteFileListRequest { id: note, prefix }).await?;
                client.output.show(&listing, |res| {
                    res.files
                        .iter()
                        .map(|f| line(&[&f.path, &f.mime, &format!("{}B", f.size), &f.hash]))
                        .collect::<Vec<_>>()
                        .join("\n")
                });
                Ok(())
            }
            NoteFileAction::Get { note, path, version } => {
                let file = client.ask::<ops::NoteFileGet>(&NoteFileGetRequest { id: note, path, version }).await?;
                client.output.show(&file, |f| f.content.clone());
                Ok(())
            }
            NoteFileAction::Write {
                note,
                path,
                content,
                encoding,
                mime,
                expected_hash,
                origin,
                summary,
                announce,
            } => {
                let loaded = read_text_input(&content)?;
                let request = NoteFileWriteRequest {
                    id: note,
                    files: vec![NoteFileWriteItem {
                        path,
                        content: loaded,
                        encoding: encoding.map(Into::into),
                        mime,
                        expected_hash,
                    }],
                    origin,
                    summary,
                    announce: announce.then_some(true),
                };
                client.mutate::<ops::NoteFileWrite>("note file write", &request, write_text).await
            }
            NoteFileAction::Batch {
                note,
                files,
                origin,
                summary,
                announce,
            } => {
                let parsed: Vec<NoteFileWriteItem> = read_json_input(&files)?;
                let request = NoteFileWriteRequest {
                    id: note,
                    files: parsed,
                    origin,
                    summary,
                    announce: announce.then_some(true),
                };
                client.mutate::<ops::NoteFileWrite>("note file batch", &request, write_text).await
            }
            NoteFileAction::Delete { note, path, origin, summary } => {
                let request = NoteFileDeleteRequest {
                    id: note,
                    path,
                    origin,
                    summary,
                };
                client.mutate::<ops::NoteFileDelete>("note file delete", &request, delete_text).await
            }
        },
        NoteAction::Suggestion(cmd) => match cmd.action {
            NoteSuggestionAction::List { note } => {
                let list = client.ask::<ops::NoteSuggestionList>(&NoteSuggestionListInput { id: note }).await?;
                client
                    .output
                    .show(&list, |items| items.iter().map(suggestion_line).collect::<Vec<_>>().join("\n"));
                Ok(())
            }
            NoteSuggestionAction::Create {
                note,
                path,
                base_rev,
                base_hash,
                content,
                patch,
                target,
                delete,
                summary,
            } => {
                let content = content.as_deref().map(read_text_input).transpose()?;
                let patch = patch.as_deref().map(read_text_input).transpose()?;
                if content.is_none() && patch.is_none() && !delete {
                    return Err(Failure::usage("MissingArgument", "provide --content, --patch, or --delete"));
                }
                let request = NoteSuggestionCreateInput {
                    id: note,
                    path,
                    base_rev,
                    base_hash,
                    change: SuggestionChange {
                        content,
                        patch,
                        target,
                        delete: delete.then_some(true),
                        summary,
                    },
                    cursor_start: None,
                    cursor_end: None,
                    start_offset: None,
                    end_offset: None,
                };
                client
                    .mutate::<ops::NoteSuggestionCreate>("note suggestion create", &request, suggestion_line)
                    .await
            }
            NoteSuggestionAction::Accept { note, suggestion } => {
                client
                    .mutate::<ops::NoteSuggestionAccept>("note suggestion accept", &NoteSuggestionAcceptInput { id: note, suggestion }, suggestion_line)
                    .await
            }
            NoteSuggestionAction::Reject { note, suggestion } => {
                client
                    .mutate::<ops::NoteSuggestionReject>("note suggestion reject", &NoteSuggestionAcceptInput { id: note, suggestion }, suggestion_line)
                    .await
            }
        },
        NoteAction::History(cmd) => match cmd.action {
            NoteHistoryAction::List { note, limit } => {
                let entries = client.ask::<ops::NoteHistoryList>(&NoteHistoryListRequest { id: note, limit }).await?;
                client.output.show(&entries, |list| {
                    list.iter()
                        .map(|e| line(&[&e.frontiers, &e.origin, &e.author, e.summary.as_deref().unwrap_or("")]))
                        .collect::<Vec<_>>()
                        .join("\n")
                });
                Ok(())
            }
            NoteHistoryAction::Preview { note, frontiers } => {
                let preview = client
                    .ask::<ops::NoteHistoryPreview>(&NoteHistoryPreviewRequest { id: note, frontiers })
                    .await?;
                client.output.show(&preview, |p| {
                    p.files
                        .iter()
                        .map(|f| line(&[&f.path, &f.mime, &format!("{}B", f.size)]))
                        .collect::<Vec<_>>()
                        .join("\n")
                });
                Ok(())
            }
            NoteHistoryAction::Restore { note, frontiers, note_text } => {
                client
                    .mutate::<ops::NoteHistoryRestore>(
                        "note history restore",
                        &NoteHistoryRestoreRequest {
                            id: note,
                            frontiers,
                            note: note_text,
                        },
                        note_line,
                    )
                    .await
            }
            NoteHistoryAction::Fork {
                note,
                frontiers,
                title,
                channel,
            } => {
                client
                    .mutate::<ops::NoteHistoryFork>(
                        "note history fork",
                        &NoteHistoryForkRequest {
                            id: note,
                            frontiers,
                            title,
                            channel,
                        },
                        note_line,
                    )
                    .await
            }
            NoteHistoryAction::UndoOrigin { note, origin } => {
                client
                    .mutate::<ops::NoteHistoryUndoOrigin>("note history undo-origin", &NoteHistoryUndoOriginRequest { id: note, origin }, note_line)
                    .await
            }
            NoteHistoryAction::Compact { note } => {
                client
                    .mutate::<ops::NoteHistoryCompact>("note history compact", &NoteHistoryCompactRequest { id: note }, note_line)
                    .await
            }
        },
    }
}
