use globset::Glob;
use ignore::WalkBuilder;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::truncate::{DEFAULT_MAX_BYTES, truncate_bytes};
use super::workspace::Workspace;
use super::{ReplayPolicy, ToolContext, TypedTool, TypedToolOutput};

const DEFAULT_MAX_RESULTS: usize = 500;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct FindArgs {
    /// Glob pattern to match file paths against (for example "*.rs" or "src/**/*.ts").
    pub pattern: String,
    /// Directory to search (defaults to workspace cwd).
    #[serde(default)]
    pub path: Option<String>,
    /// Maximum number of file paths to return (defaults to 500).
    #[serde(default)]
    pub max_results: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FindDetails {
    pub count: usize,
    pub truncated: bool,
}

pub struct Find(pub Workspace);

impl TypedTool for Find {
    type Args = FindArgs;
    type Details = FindDetails;

    fn name(&self) -> &'static str {
        "find"
    }

    fn description(&self) -> &'static str {
        "Find files matching a glob pattern, respecting .gitignore rules."
    }

    fn replay(&self) -> ReplayPolicy {
        ReplayPolicy::Safe
    }

    fn execute(&self, args: Self::Args, ctx: &ToolContext) -> Result<TypedToolOutput<Self::Details>, String> {
        if ctx.cancel.is_cancelled() {
            return Err("aborted by the user".into());
        }
        if args.pattern.trim().is_empty() {
            return Err("pattern must not be empty".into());
        }
        let max_results = match args.max_results {
            Some(0) => return Err("max_results must be at least 1".into()),
            Some(n) => n,
            None => DEFAULT_MAX_RESULTS,
        };
        let matcher = Glob::new(&args.pattern).map_err(|e| format!("invalid glob pattern: {e}"))?.compile_matcher();

        let root = args.path.as_deref().map(|p| self.0.resolve(p)).unwrap_or_else(|| self.0.cwd.clone());
        if !root.exists() {
            return Err(format!("{}: not found", root.display()));
        }
        if !root.is_dir() {
            return Err(format!("{}: not a directory", root.display()));
        }

        let mut builder = WalkBuilder::new(&root);
        builder
            .hidden(false)
            .ignore(false)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .parents(true)
            // Respect .gitignore even in folders without an initialized .git directory.
            .require_git(false)
            .follow_links(false)
            .sort_by_file_name(|a, b| a.cmp(b))
            .filter_entry(|entry| entry.file_name() != ".git");

        let mut found = Vec::new();
        let mut hit_limit = false;

        for entry in builder.build() {
            if ctx.cancel.is_cancelled() {
                return Err("aborted by the user".into());
            }
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let rel = entry.path().strip_prefix(&root).unwrap_or_else(|_| entry.path());
            if matcher.is_match(rel) {
                if found.len() >= max_results {
                    hit_limit = true;
                    break;
                }
                found.push(rel.to_string_lossy().into_owned());
            }
        }

        if found.is_empty() {
            return Ok(TypedToolOutput::ok_with("no matching files found", FindDetails { count: 0, truncated: false }));
        }

        let count = found.len();
        let mut joined = found.join("\n");
        if hit_limit {
            joined.push_str(&format!("\n... (truncated at {max_results} files)"));
        }
        let truncated = truncate_bytes(&joined, DEFAULT_MAX_BYTES);
        let is_truncated = hit_limit || truncated.truncated;

        Ok(TypedToolOutput::ok_with(
            truncated.text,
            FindDetails {
                count,
                truncated: is_truncated,
            },
        ))
    }
}
