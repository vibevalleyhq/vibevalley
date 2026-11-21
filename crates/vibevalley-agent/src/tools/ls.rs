use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::truncate::{DEFAULT_MAX_BYTES, truncate_bytes};
use super::workspace::Workspace;
use super::{ReplayPolicy, ToolContext, TypedTool, TypedToolOutput};

const DEFAULT_MAX_ENTRIES: usize = 500;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct LsArgs {
    /// Directory path to list (defaults to workspace cwd).
    #[serde(default)]
    pub path: Option<String>,
    /// Maximum number of entries to return (defaults to 500).
    #[serde(default)]
    pub max_entries: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LsDetails {
    pub path: String,
    pub total_entries: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntryKind {
    Dir,
    File,
    Symlink,
}

struct DirEntryItem {
    name: String,
    kind: EntryKind,
    size: u64,
}

pub struct Ls(pub Workspace);

impl TypedTool for Ls {
    type Args = LsArgs;
    type Details = LsDetails;

    fn name(&self) -> &'static str {
        "ls"
    }

    fn description(&self) -> &'static str {
        "List sorted directory entries with file/directory indicator and byte size."
    }

    fn replay(&self) -> ReplayPolicy {
        ReplayPolicy::Safe
    }

    fn execute(&self, args: Self::Args, ctx: &ToolContext) -> Result<TypedToolOutput<Self::Details>, String> {
        if ctx.cancel.is_cancelled() {
            return Err("aborted by the user".into());
        }
        let max_entries = match args.max_entries {
            Some(0) => return Err("max_entries must be at least 1".into()),
            Some(n) => n,
            None => DEFAULT_MAX_ENTRIES,
        };
        let dir = args.path.as_deref().map(|p| self.0.resolve(p)).unwrap_or_else(|| self.0.cwd.clone());
        let reader = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;

        let mut items = Vec::new();
        for entry in reader {
            let entry = entry.map_err(|e| format!("{}: {e}", dir.display()))?;
            let Ok(ft) = entry.file_type() else { continue };
            let kind = if ft.is_dir() {
                EntryKind::Dir
            } else if ft.is_symlink() {
                EntryKind::Symlink
            } else {
                EntryKind::File
            };
            let size = if kind == EntryKind::File {
                entry.metadata().map(|m| m.len()).unwrap_or(0)
            } else {
                0
            };
            items.push(DirEntryItem {
                name: entry.file_name().to_string_lossy().into_owned(),
                kind,
                size,
            });
        }

        items.sort_by(|a, b| {
            let a_is_dir = a.kind != EntryKind::Dir;
            let b_is_dir = b.kind != EntryKind::Dir;
            a_is_dir
                .cmp(&b_is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                .then_with(|| a.name.cmp(&b.name))
        });

        let total_entries = items.len();
        if total_entries == 0 {
            return Ok(TypedToolOutput::ok_with(
                "(empty directory)",
                LsDetails {
                    path: dir.display().to_string(),
                    total_entries: 0,
                    truncated: false,
                },
            ));
        }

        let hit_limit = total_entries > max_entries;
        let mut lines: Vec<String> = items
            .into_iter()
            .take(max_entries)
            .map(|item| match item.kind {
                EntryKind::Dir => format!("{}/ (dir)", item.name),
                EntryKind::Symlink => format!("{}@ (symlink)", item.name),
                EntryKind::File => format!("{} ({} bytes)", item.name, item.size),
            })
            .collect();

        if hit_limit {
            lines.push(format!("... (showing {max_entries} of {total_entries} entries)"));
        }

        let truncated = truncate_bytes(&lines.join("\n"), DEFAULT_MAX_BYTES);
        Ok(TypedToolOutput::ok_with(
            truncated.text,
            LsDetails {
                path: dir.display().to_string(),
                total_entries,
                truncated: hit_limit || truncated.truncated,
            },
        ))
    }
}
