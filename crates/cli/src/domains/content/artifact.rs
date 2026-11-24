//! `artifact list|show|read|create|update|delete` and `artifact entry list|get|set|batch`.

use clap::{ArgAction, Args, Subcommand, ValueEnum};
use vibevalley_protocol::{
    Artifact, ArtifactDeleteInput, ArtifactDisplay, ArtifactEntryBatchRequest, ArtifactEntryBatchResult, ArtifactEntryGetRequest, ArtifactEntryKind,
    ArtifactEntryListRequest, ArtifactEntryOp, ArtifactEntryWriteInput, ArtifactGetInput, ArtifactKind, ArtifactListRequest, ArtifactReadRequest,
    ArtifactRequest, ArtifactType, ArtifactUpdateRequest, ops,
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
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum ArtifactKindArg {
    Html,
    Markdown,
    Store,
}

impl From<ArtifactKindArg> for ArtifactKind {
    fn from(value: ArtifactKindArg) -> Self {
        match value {
            ArtifactKindArg::Html => ArtifactKind::Html,
            ArtifactKindArg::Markdown => ArtifactKind::Markdown,
            ArtifactKindArg::Store => ArtifactKind::Store,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum ArtifactDisplayArg {
    Page,
    Slides,
    Motion,
}

impl From<ArtifactDisplayArg> for ArtifactDisplay {
    fn from(value: ArtifactDisplayArg) -> Self {
        match value {
            ArtifactDisplayArg::Page => ArtifactDisplay::Page,
            ArtifactDisplayArg::Slides => ArtifactDisplay::Slides,
            ArtifactDisplayArg::Motion => ArtifactDisplay::Motion,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum EntryKindArg {
    Text,
    Json,
    Asset,
}

impl From<EntryKindArg> for ArtifactEntryKind {
    fn from(value: EntryKindArg) -> Self {
        match value {
            EntryKindArg::Text => ArtifactEntryKind::Text,
            EntryKindArg::Json => ArtifactEntryKind::Json,
            EntryKindArg::Asset => ArtifactEntryKind::Asset,
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
        /// Filter by structured artifact type
        #[arg(long = "type", value_enum)]
        artifact_type: Option<ArtifactTypeArg>,
    },
    /// Show metadata for one artifact
    #[command(after_help = "Examples:\n  vibevalley artifact show a1")]
    Show {
        /// Artifact id
        artifact: String,
    },
    /// Read an HTML or blocks artifact's content
    #[command(after_help = "Examples:\n  vibevalley artifact read a1\n  vibevalley artifact read a1 --version 2")]
    Read {
        /// Artifact id
        artifact: String,
        /// Optional version number for HTML artifacts
        #[arg(long)]
        version: Option<i64>,
    },
    /// Create a new artifact (typed store, HTML, or Markdown)
    #[command(
        after_help = "Examples:\n  vibevalley artifact create 'Architecture' --type whiteboard\n  vibevalley artifact create 'Demo' --kind html --content @demo.html"
    )]
    Create {
        /// Artifact title
        title: String,
        /// Structured artifact type
        #[arg(long = "type", value_enum)]
        artifact_type: Option<ArtifactTypeArg>,
        /// Storage kind (html, markdown, store)
        #[arg(long, value_enum)]
        kind: Option<ArtifactKindArg>,
        /// Display mode for HTML artifacts
        #[arg(long, value_enum)]
        display: Option<ArtifactDisplayArg>,
        /// Initial content (inline text, '-' for stdin, or '@file')
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
    /// Update an artifact's title, display mode, or default flag
    #[command(after_help = "Examples:\n  vibevalley artifact update a1 --title 'Renamed'")]
    Update {
        /// Artifact id
        artifact: String,
        /// New title
        #[arg(long)]
        title: Option<String>,
        /// New HTML display mode
        #[arg(long, value_enum)]
        display: Option<ArtifactDisplayArg>,
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
    /// Read and write structured store entries on an artifact
    Entry(ArtifactEntryCmd),
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct ArtifactEntryCmd {
    #[command(subcommand)]
    pub action: ArtifactEntryAction,
}

#[derive(Debug, Subcommand)]
pub enum ArtifactEntryAction {
    /// List entries in a store artifact
    #[command(after_help = "Examples:\n  vibevalley artifact entry list a1 --prefix elements/ --values")]
    List {
        /// Artifact id
        artifact: String,
        /// Optional path prefix filter
        #[arg(long)]
        prefix: Option<String>,
        /// Include entry values in the response
        #[arg(long)]
        values: bool,
    },
    /// Read one entry from a store artifact
    #[command(after_help = "Examples:\n  vibevalley artifact entry get a1 board/meta")]
    Get {
        /// Artifact id
        artifact: String,
        /// Entry path
        path: String,
    },
    /// Set a single entry on a store artifact
    #[command(after_help = "Examples:\n  vibevalley artifact entry set a1 board/meta '{\"title\":\"Board\"}' --kind json")]
    Set {
        /// Artifact id
        artifact: String,
        /// Entry path
        path: String,
        /// Entry value (inline text/JSON, '-' for stdin, or '@file')
        value: String,
        /// Entry kind
        #[arg(long, value_enum, default_value_t = EntryKindArg::Json)]
        kind: EntryKindArg,
        /// Optional MIME type override
        #[arg(long)]
        mime: Option<String>,
        /// Optimistic concurrency revision guard (0 requires absent)
        #[arg(long)]
        if_rev: Option<i64>,
        /// Optional batch note
        #[arg(long)]
        note: Option<String>,
        /// Announce the update in the channel
        #[arg(long)]
        announce: bool,
    },
    /// Apply an atomic JSON batch of entry writes (inline JSON array, '-' for stdin, or '@file')
    #[command(after_help = "Examples:\n  vibevalley artifact entry batch a1 @writes.json --note 'Seed board'")]
    Batch {
        /// Artifact id
        artifact: String,
        /// JSON array of ArtifactEntryWriteInput (inline, '-', or '@file')
        writes: String,
        /// Optional batch note
        #[arg(long)]
        note: Option<String>,
        /// Announce the update in the channel
        #[arg(long)]
        announce: bool,
    },
}

fn artifact_line(artifact: &Artifact) -> String {
    let body = match artifact.artifact_type {
        Some(kind) => format!("{}:{}", artifact.body.as_str(), kind.as_str()),
        None => artifact.body.as_str().to_owned(),
    };
    let issue = artifact.issue.as_ref().map(|i| format!("issue {i}")).unwrap_or_default();
    line(&[&artifact.id, &artifact.title, &body, &format!("@{}", artifact.by_name), &issue])
}

fn batch_text(res: &ArtifactEntryBatchResult) -> String {
    let mut lines = vec![format!(
        "seq {}  {}  {} entries  {} conflicts",
        res.seq,
        if res.applied { "applied" } else { "rejected" },
        res.entries.len(),
        res.conflicts.len()
    )];
    for conflict in &res.conflicts {
        lines.push(format!(
            "conflict: {} (expected rev {}, actual rev {})",
            conflict.path, conflict.expected_rev, conflict.actual_rev
        ));
    }
    lines.join("\n")
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
            kind,
            display,
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
                kind: kind.map(Into::into),
                artifact_type: artifact_type.map(Into::into),
                display: display.map(Into::into),
                content,
                entries: None,
                is_default: default.then_some(true),
                announce: announce.then_some(true),
                note,
                channel,
                issue: issue.map(|i| issue_ref(&i)),
            };
            client.mutate::<ops::ArtifactCreate>("artifact create", &request, artifact_line)
        }
        ArtifactAction::Update {
            artifact,
            title,
            display,
            default,
        } => {
            if title.is_none() && display.is_none() && default.is_none() {
                return Err(Failure::usage("MissingArgument", "provide at least one field to update"));
            }
            let request = ArtifactUpdateRequest {
                id: artifact,
                title,
                display: display.map(Into::into),
                is_default: default,
            };
            client.mutate::<ops::ArtifactUpdate>("artifact update", &request, artifact_line)
        }
        ArtifactAction::Delete { artifact } => {
            let id = artifact.clone();
            client.mutate::<ops::ArtifactDelete>("artifact delete", &ArtifactDeleteInput { id: artifact }, |_| format!("deleted {id}"))
        }
        ArtifactAction::Entry(entry) => match entry.action {
            ArtifactEntryAction::List { artifact, prefix, values } => {
                let snapshot = client.ask::<ops::ArtifactEntryList>(&ArtifactEntryListRequest {
                    id: artifact,
                    prefix,
                    include_values: values.then_some(true),
                })?;
                client.output.show(&snapshot, |snap| {
                    snap.entries
                        .iter()
                        .map(|e| line(&[&e.path, e.kind.as_str(), &format!("rev {}", e.rev), &format!("{}B", e.size)]))
                        .collect::<Vec<_>>()
                        .join("\n")
                });
                Ok(())
            }
            ArtifactEntryAction::Get { artifact, path } => {
                let found = client.ask::<ops::ArtifactEntryGet>(&ArtifactEntryGetRequest { id: artifact, path })?;
                client.output.show(&found, |e| {
                    e.value
                        .clone()
                        .or_else(|| e.attachment_id.clone())
                        .unwrap_or_else(|| line(&[&e.path, e.kind.as_str(), &format!("rev {}", e.rev)]))
                });
                Ok(())
            }
            ArtifactEntryAction::Set {
                artifact,
                path,
                value,
                kind,
                mime,
                if_rev,
                note,
                announce,
            } => {
                let loaded = read_text_input(&value)?;
                let request = ArtifactEntryBatchRequest {
                    id: artifact,
                    writes: vec![ArtifactEntryWriteInput {
                        op: ArtifactEntryOp::Set,
                        path,
                        kind: Some(kind.into()),
                        value: Some(loaded),
                        from: None,
                        mime,
                        if_rev,
                    }],
                    note,
                    announce: announce.then_some(true),
                };
                client.mutate::<ops::ArtifactEntryBatch>("artifact entry set", &request, batch_text)
            }
            ArtifactEntryAction::Batch {
                artifact,
                writes,
                note,
                announce,
            } => {
                let parsed: Vec<ArtifactEntryWriteInput> = read_json_input(&writes)?;
                let request = ArtifactEntryBatchRequest {
                    id: artifact,
                    writes: parsed,
                    note,
                    announce: announce.then_some(true),
                };
                client.mutate::<ops::ArtifactEntryBatch>("artifact entry batch", &request, batch_text)
            }
        },
    }
}
