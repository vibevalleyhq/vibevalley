use std::path::Path;

use globset::{Glob, GlobMatcher};
use ignore::WalkBuilder;
use regex::RegexBuilder;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::truncate::{DEFAULT_MAX_BYTES, truncate_bytes};
use super::workspace::Workspace;
use super::{ReplayPolicy, ToolContext, TypedTool, TypedToolOutput};
use vibevalley_oar::BoxFuture;

const DEFAULT_MAX_RESULTS: usize = 100;
const MAX_LINE_CHARS: usize = 500;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct GrepArgs {
    /// Regular expression pattern to search for.
    pub pattern: String,
    /// Directory or file path to search (defaults to workspace cwd).
    #[serde(default)]
    pub path: Option<String>,
    /// Optional glob filter for file paths (for example "*.rs" or "src/**/*.ts").
    #[serde(default)]
    pub glob: Option<String>,
    /// When true, match case-insensitively.
    #[serde(default)]
    pub case_insensitive: Option<bool>,
    /// Maximum number of matching lines to return (defaults to 100).
    #[serde(default)]
    pub max_results: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GrepDetails {
    pub matches: usize,
    pub truncated: bool,
}

pub struct Grep(pub Workspace);

impl TypedTool for Grep {
    type Args = GrepArgs;
    type Details = GrepDetails;

    fn name(&self) -> &'static str {
        "grep"
    }

    fn description(&self) -> &'static str {
        "Search file contents for a regex pattern, respecting .gitignore rules."
    }

    fn replay(&self) -> ReplayPolicy {
        ReplayPolicy::Safe
    }

    fn execute<'a>(&'a self, args: Self::Args, ctx: &'a ToolContext) -> BoxFuture<'a, Result<TypedToolOutput<Self::Details>, String>> {
        Box::pin(async move {
            if ctx.cancel.is_cancelled() {
                return Err("aborted by the user".into());
            }
            if args.pattern.is_empty() {
                return Err("pattern must not be empty".into());
            }
            let max_results = match args.max_results {
                Some(0) => return Err("max_results must be at least 1".into()),
                Some(n) => n,
                None => DEFAULT_MAX_RESULTS,
            };
            let regex = RegexBuilder::new(&args.pattern)
                .case_insensitive(args.case_insensitive.unwrap_or(false))
                .build()
                .map_err(|e| format!("invalid regex: {e}"))?;
            let glob = args
                .glob
                .as_deref()
                .filter(|g| !g.trim().is_empty())
                .map(|g| Glob::new(g).map(|g| g.compile_matcher()))
                .transpose()
                .map_err(|e| format!("invalid glob: {e}"))?;

            let root = args.path.as_deref().map(|p| self.0.resolve(p)).unwrap_or_else(|| self.0.cwd.clone());
            if !root.exists() {
                return Err(format!("{}: not found", root.display()));
            }

            let mut lines = Vec::new();
            let mut hit_limit = false;

            if root.is_file() {
                search_file(
                    &root,
                    root.file_name().map(Path::new).unwrap_or(&root),
                    &regex,
                    glob.as_ref(),
                    max_results,
                    &mut lines,
                    &mut hit_limit,
                );
            } else {
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

                for entry in builder.build() {
                    if ctx.cancel.is_cancelled() {
                        return Err("aborted by the user".into());
                    }
                    let Ok(entry) = entry else { continue };
                    if !entry.file_type().is_some_and(|t| t.is_file()) {
                        continue;
                    }
                    let path = entry.path();
                    let rel = path.strip_prefix(&root).unwrap_or(path);
                    if search_file(path, rel, &regex, glob.as_ref(), max_results, &mut lines, &mut hit_limit) {
                        break;
                    }
                }
            }

            if lines.is_empty() {
                return Ok(TypedToolOutput::ok_with("no matches found", GrepDetails { matches: 0, truncated: false }));
            }

            let match_count = lines.len();
            let mut joined = lines.join("\n");
            if hit_limit {
                joined.push_str(&format!("\n... (truncated at {max_results} matches)"));
            }
            let truncated = truncate_bytes(&joined, DEFAULT_MAX_BYTES);
            let is_truncated = hit_limit || truncated.truncated;

            Ok(TypedToolOutput::ok_with(
                truncated.text,
                GrepDetails {
                    matches: match_count,
                    truncated: is_truncated,
                },
            ))
        })
    }
}

fn search_file(
    path: &Path,
    display_path: &Path,
    regex: &regex::Regex,
    glob: Option<&GlobMatcher>,
    max_results: usize,
    out: &mut Vec<String>,
    hit_limit: &mut bool,
) -> bool {
    if let Some(matcher) = glob
        && !matcher.is_match(display_path)
    {
        return false;
    }
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return false;
    }
    let text = String::from_utf8_lossy(&bytes);
    let shown = display_path.to_string_lossy();
    for (idx, line) in text.lines().enumerate() {
        if regex.is_match(line) {
            if out.len() >= max_results {
                *hit_limit = true;
                return true;
            }
            let snippet = clip_line(line);
            out.push(format!("{shown}:{}: {snippet}", idx + 1));
        }
    }
    false
}

fn clip_line(line: &str) -> String {
    let trimmed = line.trim_end_matches('\r');
    let mut chars = trimmed.chars();
    let head: String = chars.by_ref().take(MAX_LINE_CHARS).collect();
    if chars.next().is_some() { format!("{head}…") } else { head }
}
