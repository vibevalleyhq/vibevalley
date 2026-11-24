//! `artifact list|show|read|create|version|update|delete`, `artifact type ...`,
//! `artifact file ...`, `artifact suggestion ...`, and `artifact history ...`.

use clap::{ArgAction, Args, Subcommand, ValueEnum};
use vibevalley_protocol::{
    Artifact, ArtifactDeleteInput, ArtifactFileDeleteRequest, ArtifactFileDeleteResult, ArtifactFileEncoding, ArtifactFileGetRequest, ArtifactFileListRequest,
    ArtifactFileWriteItem, ArtifactFileWriteRequest, ArtifactFileWriteResult, ArtifactGetInput, ArtifactHistoryCompactRequest, ArtifactHistoryForkRequest,
    ArtifactHistoryListRequest, ArtifactHistoryPreviewRequest, ArtifactHistoryRestoreRequest, ArtifactHistoryUndoOriginRequest, ArtifactListRequest,
    ArtifactReadRequest, ArtifactRequest, ArtifactSuggestionAcceptInput, ArtifactSuggestionCreateInput, ArtifactSuggestionListInput, ArtifactType,
    ArtifactTypeReadRequest, ArtifactUpdateRequest, ArtifactVersionRequest, Suggestion, SuggestionChange, ops,
};

use crate::client::{Client, Done, Failure};
use crate::output::{issue_ref, line, read_json_input, read_text_input};

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum ArtifactTypeArg {
    Docs,
    Outline,
    Slides,
    Dashboard,
    Motion,
    Whiteboard,
    Design,
    #[value(name = "design-system")]
    DesignSystem,
    Sheet,
    Prototype,
    Diagram,
    Storyboard,
}

impl From<ArtifactTypeArg> for ArtifactType {
    fn from(value: ArtifactTypeArg) -> Self {
        match value {
            ArtifactTypeArg::Docs => ArtifactType::Docs,
            ArtifactTypeArg::Outline => ArtifactType::Outline,
            ArtifactTypeArg::Slides => ArtifactType::Slides,
            ArtifactTypeArg::Dashboard => ArtifactType::Dashboard,
            ArtifactTypeArg::Motion => ArtifactType::Motion,
            ArtifactTypeArg::Whiteboard => ArtifactType::Whiteboard,
            ArtifactTypeArg::Design => ArtifactType::Design,
            ArtifactTypeArg::DesignSystem => ArtifactType::DesignSystem,
            ArtifactTypeArg::Sheet => ArtifactType::Sheet,
            ArtifactTypeArg::Prototype => ArtifactType::Prototype,
            ArtifactTypeArg::Diagram => ArtifactType::Diagram,
            ArtifactTypeArg::Storyboard => ArtifactType::Storyboard,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum FileEncodingArg {
    Utf8,
    Base64,
}

impl From<FileEncodingArg> for ArtifactFileEncoding {
    fn from(value: FileEncodingArg) -> Self {
        match value {
            FileEncodingArg::Utf8 => ArtifactFileEncoding::Utf8,
            FileEncodingArg::Base64 => ArtifactFileEncoding::Base64,
        }
    }
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct ArtifactCmd {
    #[command(subcommand)]
    pub action: ArtifactAction,
}

#[derive(Debug, Subcommand)]
pub enum ArtifactAction {
    /// List artifacts with optional filters
    #[command(after_help = "Examples:\n  vibevalley artifact list\n  vibevalley artifact list --type whiteboard --json")]
    List {
        /// Filter by issue number or id
        #[arg(long)]
        issue: Option<String>,
        /// Filter by channel id
        #[arg(long)]
        channel: Option<String>,
        /// Filter by artifact type
        #[arg(long = "type", value_enum)]
        artifact_type: Option<ArtifactTypeArg>,
    },
    /// Show metadata for one artifact
    #[command(after_help = "Examples:\n  vibevalley artifact show a1")]
    Show {
        /// Artifact id
        artifact: String,
    },
    /// Read an artifact's primary entry file content
    #[command(after_help = "Examples:\n  vibevalley artifact read a1\n  vibevalley artifact read a1 --version 2")]
    Read {
        /// Artifact id
        artifact: String,
        /// Optional immutable snapshot version number
        #[arg(long)]
        version: Option<i64>,
    },
    /// Create a new directory-backed artifact
    #[command(
        after_help = "Examples:\n  vibevalley artifact create 'Architecture' --type diagram\n  vibevalley artifact create 'Launch Spec' --type docs --content @spec.md"
    )]
    Create {
        /// Artifact title
        title: String,
        /// Artifact type (one of the 12 product types)
        #[arg(long = "type", value_enum, default_value_t = ArtifactTypeArg::Docs)]
        artifact_type: ArtifactTypeArg,
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
        /// Mark as the default design-system artifact
        #[arg(long)]
        default: bool,
    },
    /// Cut an immutable directory snapshot version of an artifact
    #[command(after_help = "Examples:\n  vibevalley artifact version a1 --note 'Milestone v1'")]
    Version {
        /// Artifact id
        artifact: String,
        /// Optional updated primary entry content before snapshotting (inline, '-', or '@file')
        #[arg(long)]
        content: Option<String>,
        /// Snapshot note
        #[arg(long)]
        note: Option<String>,
    },
    /// Update an artifact's title or default flag
    #[command(after_help = "Examples:\n  vibevalley artifact update a1 --title 'Renamed'")]
    Update {
        /// Artifact id
        artifact: String,
        /// New title
        #[arg(long)]
        title: Option<String>,
        /// Set or clear default design-system flag (true or false)
        #[arg(long, action = ArgAction::Set)]
        default: Option<bool>,
    },
    /// Delete an artifact
    #[command(after_help = "Examples:\n  vibevalley artifact delete a1 --dry-run")]
    Delete {
        /// Artifact id
        artifact: String,
    },
    /// Inspect the 12 artifact types and their progressive-disclosure guides
    Type(ArtifactTypeCmd),
    /// Read, write, and delete files inside an artifact directory (`manifest.json`, `structure/*`, `asset/*`)
    File(ArtifactFileCmd),
    /// List, create, accept, and reject collaborative suggestions on an artifact
    Suggestion(ArtifactSuggestionCmd),
    /// Inspect and manage collaborative change history on an artifact
    History(ArtifactHistoryCmd),
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct ArtifactTypeCmd {
    #[command(subcommand)]
    pub action: ArtifactTypeAction,
}

#[derive(Debug, Subcommand)]
pub enum ArtifactTypeAction {
    /// List all 12 artifact types
    List,
    /// Read a type's SKILL guide or a named reference chapter
    Read {
        /// Artifact type
        #[arg(value_enum)]
        artifact_type: ArtifactTypeArg,
        /// Optional reference chapter name
        #[arg(long)]
        reference: Option<String>,
    },
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct ArtifactFileCmd {
    #[command(subcommand)]
    pub action: ArtifactFileAction,
}

#[derive(Debug, Subcommand)]
pub enum ArtifactFileAction {
    /// List files inside an artifact directory
    #[command(after_help = "Examples:\n  vibevalley artifact file list a1 --prefix structure/")]
    List {
        /// Artifact id
        artifact: String,
        /// Optional relative path prefix filter (e.g. structure/ or asset/)
        #[arg(long)]
        prefix: Option<String>,
    },
    /// Read one file from an artifact directory
    #[command(after_help = "Examples:\n  vibevalley artifact file get a1 structure/index.md")]
    Get {
        /// Artifact id
        artifact: String,
        /// Relative file path inside the artifact directory
        path: String,
        /// Optional immutable version snapshot number
        #[arg(long)]
        version: Option<i64>,
    },
    /// Write one file into `structure/` or `asset/` with origin attribution
    #[command(after_help = "Examples:\n  vibevalley artifact file write a1 structure/index.md @index.md --summary 'Update intro'")]
    Write {
        /// Artifact id
        artifact: String,
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
    /// Atomically write a JSON array of ArtifactFileWriteItem objects
    #[command(after_help = "Examples:\n  vibevalley artifact file batch a1 @files.json --summary 'Seed slides'")]
    Batch {
        /// Artifact id
        artifact: String,
        /// JSON array of ArtifactFileWriteItem (inline, '-', or '@file')
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
    #[command(after_help = "Examples:\n  vibevalley artifact file delete a1 asset/old.png")]
    Delete {
        /// Artifact id
        artifact: String,
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
pub struct ArtifactSuggestionCmd {
    #[command(subcommand)]
    pub action: ArtifactSuggestionAction,
}

#[derive(Debug, Subcommand)]
pub enum ArtifactSuggestionAction {
    /// List suggestions on an artifact
    List {
        /// Artifact id
        artifact: String,
    },
    /// Create a review suggestion on a file in an artifact
    Create {
        /// Artifact id
        artifact: String,
        /// Relative file path
        path: String,
        /// Base artifact seq
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
    Accept {
        /// Artifact id
        artifact: String,
        /// Suggestion id
        suggestion: String,
    },
    /// Reject a pending suggestion
    Reject {
        /// Artifact id
        artifact: String,
        /// Suggestion id
        suggestion: String,
    },
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct ArtifactHistoryCmd {
    #[command(subcommand)]
    pub action: ArtifactHistoryAction,
}

#[derive(Debug, Subcommand)]
pub enum ArtifactHistoryAction {
    /// List collaborative commits, newest first
    List {
        /// Artifact id
        artifact: String,
        /// Max commits to return
        #[arg(long)]
        limit: Option<i64>,
    },
    /// Preview files at a historical frontiers checkpoint
    Preview {
        /// Artifact id
        artifact: String,
        /// Encoded Loro frontiers
        frontiers: String,
    },
    /// Restore an artifact to a historical frontiers checkpoint
    Restore {
        /// Artifact id
        artifact: String,
        /// Encoded Loro frontiers
        frontiers: String,
        /// Optional restore note
        #[arg(long)]
        note: Option<String>,
    },
    /// Fork a new artifact from a historical frontiers checkpoint
    Fork {
        /// Artifact id
        artifact: String,
        /// Encoded Loro frontiers
        frontiers: String,
        /// Optional title for the forked artifact
        #[arg(long)]
        title: Option<String>,
        /// Optional channel id
        #[arg(long)]
        channel: Option<String>,
    },
    /// Selectively undo commits from one origin while keeping other concurrent edits
    UndoOrigin {
        /// Artifact id
        artifact: String,
        /// Origin identifier (e.g. session:w1:turn:1)
        origin: String,
    },
    /// Compact old operation history into a shallow snapshot
    Compact {
        /// Artifact id
        artifact: String,
    },
}

fn artifact_line(artifact: &Artifact) -> String {
    let issue = artifact.issue.as_ref().map(|i| format!("issue {i}")).unwrap_or_default();
    line(&[
        &artifact.id,
        &artifact.title,
        artifact.artifact_type.as_str(),
        &format!("seq {}", artifact.seq),
        &format!("@{}", artifact.by_name),
        &issue,
    ])
}

fn write_text(res: &ArtifactFileWriteResult) -> String {
    let sug = res.suggestions.as_ref().map_or(0, Vec::len);
    format!("seq {}  {} files  {} suggestions", res.seq, res.files.len(), sug)
}

fn delete_text(res: &ArtifactFileDeleteResult) -> String {
    format!("seq {}  deleted {}", res.seq, res.path)
}

fn suggestion_line(s: &Suggestion) -> String {
    let summary = s.change.summary.as_deref().unwrap_or("");
    line(&[&s.id, s.status.as_str(), &s.path, &s.author, summary])
}

pub fn run(client: &Client, cmd: ArtifactCmd) -> Done {
    match cmd.action {
        ArtifactAction::List { issue, channel, artifact_type } => {
            let artifacts = client.ask::<ops::ArtifactList>(&ArtifactListRequest {
                issue: issue.map(|i| issue_ref(&i)),
                channel,
                artifact_type: artifact_type.map(Into::into),
            })?;
            client
                .output
                .show(&artifacts, |list| list.iter().map(artifact_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }
        ArtifactAction::Show { artifact } => {
            let found = client.ask::<ops::ArtifactGet>(&ArtifactGetInput { id: artifact })?;
            client.output.show(&found, artifact_line);
            Ok(())
        }
        ArtifactAction::Read { artifact, version } => {
            let content = client.ask::<ops::ArtifactContentGet>(&ArtifactReadRequest { id: artifact, version })?;
            client.output.show(&content, |c| c.content.clone());
            Ok(())
        }
        ArtifactAction::Create {
            title,
            artifact_type,
            content,
            channel,
            issue,
            note,
            announce,
            default,
        } => {
            let content = content.as_deref().map(read_text_input).transpose()?;
            let request = ArtifactRequest {
                title,
                artifact_type: artifact_type.into(),
                content,
                files: None,
                is_default: default.then_some(true),
                announce: announce.then_some(true),
                note,
                channel,
                issue: issue.map(|i| issue_ref(&i)),
            };
            client.mutate::<ops::ArtifactCreate>("artifact create", &request, artifact_line)
        }
        ArtifactAction::Version { artifact, content, note } => {
            let content = content.as_deref().map(read_text_input).transpose()?;
            let request = ArtifactVersionRequest { id: artifact, content, note };
            client.mutate::<ops::ArtifactVersionCreate>("artifact version", &request, artifact_line)
        }
        ArtifactAction::Update { artifact, title, default } => {
            if title.is_none() && default.is_none() {
                return Err(Failure::usage("MissingArgument", "provide at least one field to update"));
            }
            let request = ArtifactUpdateRequest {
                id: artifact,
                title,
                is_default: default,
            };
            client.mutate::<ops::ArtifactUpdate>("artifact update", &request, artifact_line)
        }
        ArtifactAction::Delete { artifact } => {
            let id = artifact.clone();
            client.mutate::<ops::ArtifactDelete>("artifact delete", &ArtifactDeleteInput { id: artifact }, |_| format!("deleted {id}"))
        }
        ArtifactAction::Type(cmd) => match cmd.action {
            ArtifactTypeAction::List => {
                let types = client.ask::<ops::ArtifactTypeList>(&())?;
                client.output.show(&types, |list| {
                    list.iter()
                        .map(|t| line(&[t.r#type.as_str(), &t.entry, &t.title]))
                        .collect::<Vec<_>>()
                        .join("\n")
                });
                Ok(())
            }
            ArtifactTypeAction::Read { artifact_type, reference } => {
                let guide = client.ask::<ops::ArtifactTypeRead>(&ArtifactTypeReadRequest {
                    r#type: artifact_type.into(),
                    reference,
                })?;
                client.output.show(&guide, |g| g.content.clone());
                Ok(())
            }
        },
        ArtifactAction::File(cmd) => match cmd.action {
            ArtifactFileAction::List { artifact, prefix } => {
                let listing = client.ask::<ops::ArtifactFileList>(&ArtifactFileListRequest { id: artifact, prefix })?;
                client.output.show(&listing, |res| {
                    res.files
                        .iter()
                        .map(|f| line(&[&f.path, &f.mime, &format!("{}B", f.size), &f.hash]))
                        .collect::<Vec<_>>()
                        .join("\n")
                });
                Ok(())
            }
            ArtifactFileAction::Get { artifact, path, version } => {
                let file = client.ask::<ops::ArtifactFileGet>(&ArtifactFileGetRequest { id: artifact, path, version })?;
                client.output.show(&file, |f| f.content.clone());
                Ok(())
            }
            ArtifactFileAction::Write {
                artifact,
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
                let request = ArtifactFileWriteRequest {
                    id: artifact,
                    files: vec![ArtifactFileWriteItem {
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
                client.mutate::<ops::ArtifactFileWrite>("artifact file write", &request, write_text)
            }
            ArtifactFileAction::Batch {
                artifact,
                files,
                origin,
                summary,
                announce,
            } => {
                let parsed: Vec<ArtifactFileWriteItem> = read_json_input(&files)?;
                let request = ArtifactFileWriteRequest {
                    id: artifact,
                    files: parsed,
                    origin,
                    summary,
                    announce: announce.then_some(true),
                };
                client.mutate::<ops::ArtifactFileWrite>("artifact file batch", &request, write_text)
            }
            ArtifactFileAction::Delete {
                artifact,
                path,
                origin,
                summary,
            } => {
                let request = ArtifactFileDeleteRequest {
                    id: artifact,
                    path,
                    origin,
                    summary,
                };
                client.mutate::<ops::ArtifactFileDelete>("artifact file delete", &request, delete_text)
            }
        },
        ArtifactAction::Suggestion(cmd) => match cmd.action {
            ArtifactSuggestionAction::List { artifact } => {
                let list = client.ask::<ops::ArtifactSuggestionList>(&ArtifactSuggestionListInput { id: artifact })?;
                client
                    .output
                    .show(&list, |items| items.iter().map(suggestion_line).collect::<Vec<_>>().join("\n"));
                Ok(())
            }
            ArtifactSuggestionAction::Create {
                artifact,
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
                let request = ArtifactSuggestionCreateInput {
                    id: artifact,
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
                client.mutate::<ops::ArtifactSuggestionCreate>("artifact suggestion create", &request, suggestion_line)
            }
            ArtifactSuggestionAction::Accept { artifact, suggestion } => client.mutate::<ops::ArtifactSuggestionAccept>(
                "artifact suggestion accept",
                &ArtifactSuggestionAcceptInput { id: artifact, suggestion },
                suggestion_line,
            ),
            ArtifactSuggestionAction::Reject { artifact, suggestion } => client.mutate::<ops::ArtifactSuggestionReject>(
                "artifact suggestion reject",
                &ArtifactSuggestionAcceptInput { id: artifact, suggestion },
                suggestion_line,
            ),
        },
        ArtifactAction::History(cmd) => match cmd.action {
            ArtifactHistoryAction::List { artifact, limit } => {
                let entries = client.ask::<ops::ArtifactHistoryList>(&ArtifactHistoryListRequest { id: artifact, limit })?;
                client.output.show(&entries, |list| {
                    list.iter()
                        .map(|e| line(&[&e.frontiers, &e.origin, &e.author, e.summary.as_deref().unwrap_or("")]))
                        .collect::<Vec<_>>()
                        .join("\n")
                });
                Ok(())
            }
            ArtifactHistoryAction::Preview { artifact, frontiers } => {
                let preview = client.ask::<ops::ArtifactHistoryPreview>(&ArtifactHistoryPreviewRequest { id: artifact, frontiers })?;
                client.output.show(&preview, |p| {
                    p.files
                        .iter()
                        .map(|f| line(&[&f.path, &f.mime, &format!("{}B", f.size)]))
                        .collect::<Vec<_>>()
                        .join("\n")
                });
                Ok(())
            }
            ArtifactHistoryAction::Restore { artifact, frontiers, note } => client.mutate::<ops::ArtifactHistoryRestore>(
                "artifact history restore",
                &ArtifactHistoryRestoreRequest { id: artifact, frontiers, note },
                artifact_line,
            ),
            ArtifactHistoryAction::Fork {
                artifact,
                frontiers,
                title,
                channel,
            } => client.mutate::<ops::ArtifactHistoryFork>(
                "artifact history fork",
                &ArtifactHistoryForkRequest {
                    id: artifact,
                    frontiers,
                    title,
                    channel,
                },
                artifact_line,
            ),
            ArtifactHistoryAction::UndoOrigin { artifact, origin } => client.mutate::<ops::ArtifactHistoryUndoOrigin>(
                "artifact history undo-origin",
                &ArtifactHistoryUndoOriginRequest { id: artifact, origin },
                artifact_line,
            ),
            ArtifactHistoryAction::Compact { artifact } => {
                client.mutate::<ops::ArtifactHistoryCompact>("artifact history compact", &ArtifactHistoryCompactRequest { id: artifact }, artifact_line)
            }
        },
    }
}
