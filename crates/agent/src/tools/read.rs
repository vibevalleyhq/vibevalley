use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::truncate::{DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, floor_char_boundary};
use super::workspace::Workspace;
use super::{ReplayPolicy, ToolContext, TypedTool, TypedToolOutput};
use vibevalley_oar::BoxFuture;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ReadArgs {
    /// Path to the file to read, relative to the workspace or absolute.
    pub path: String,
    /// First line to read (1-based, defaults to 1).
    #[serde(default)]
    pub offset: Option<usize>,
    /// Maximum number of lines to return (defaults to 2000).
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadDetails {
    pub path: String,
    pub total_lines: usize,
    pub total_bytes: usize,
    pub start_line: usize,
    pub end_line: usize,
    pub truncated: bool,
}

pub struct ReadFile(pub Workspace);

impl TypedTool for ReadFile {
    type Args = ReadArgs;
    type Details = ReadDetails;

    fn name(&self) -> &'static str {
        "read"
    }

    fn description(&self) -> &'static str {
        "Read a text file with line numbers. Reports total lines and provides an offset hint if truncated."
    }

    fn replay(&self) -> ReplayPolicy {
        ReplayPolicy::Safe
    }

    fn execute<'a>(&'a self, args: Self::Args, ctx: &'a ToolContext) -> BoxFuture<'a, Result<TypedToolOutput<Self::Details>, String>> {
        Box::pin(async move {
            if ctx.cancel.is_cancelled() {
                return Err("aborted by the user".into());
            }
            let path = self.0.resolve(&args.path);
            let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            let total_bytes = text.len();
            let lines: Vec<&str> = text.lines().collect();
            let total_lines = lines.len();

            if total_lines == 0 {
                return Ok(TypedToolOutput::ok_with(
                    "(empty file, 0 lines)",
                    ReadDetails {
                        path: path.display().to_string(),
                        total_lines: 0,
                        total_bytes,
                        start_line: 0,
                        end_line: 0,
                        truncated: false,
                    },
                ));
            }

            let offset = args.offset.unwrap_or(1).max(1);
            if offset > total_lines {
                return Err(format!("offset {offset} is beyond end of file ({total_lines} lines total)"));
            }

            let limit = match args.limit {
                Some(0) => return Err("limit must be at least 1".into()),
                Some(n) => n,
                None => DEFAULT_MAX_LINES,
            };

            let mut body = String::new();
            let mut end_line = offset - 1;
            let mut byte_truncated = false;

            for (idx, line) in lines.iter().enumerate().skip(offset - 1).take(limit) {
                let line_no = idx + 1;
                let formatted = format!("{line_no:>6}\t{line}\n");
                if !body.is_empty() && body.len() + formatted.len() > DEFAULT_MAX_BYTES {
                    byte_truncated = true;
                    break;
                }
                if body.is_empty() && formatted.len() > DEFAULT_MAX_BYTES {
                    let cut = floor_char_boundary(&formatted, DEFAULT_MAX_BYTES);
                    body.push_str(&formatted[..cut]);
                    if !body.ends_with('\n') {
                        body.push('\n');
                    }
                    end_line = line_no;
                    byte_truncated = true;
                    break;
                }
                body.push_str(&formatted);
                end_line = line_no;
            }

            let has_more = end_line < total_lines;
            let truncated = has_more || byte_truncated;
            let footer = if has_more {
                let next = end_line + 1;
                if byte_truncated {
                    format!("... (showing lines {offset}..{end_line} of {total_lines}, capped at {DEFAULT_MAX_BYTES} bytes; pass offset={next} to continue)")
                } else {
                    format!("... (showing lines {offset}..{end_line} of {total_lines}; pass offset={next} to continue)")
                }
            } else if byte_truncated {
                format!("... (showing lines {offset}..{end_line} of {total_lines}, capped at {DEFAULT_MAX_BYTES} bytes)")
            } else {
                format!("(showing lines {offset}..{end_line} of {total_lines})")
            };

            Ok(TypedToolOutput::ok_with(
                format!("{body}{footer}"),
                ReadDetails {
                    path: path.display().to_string(),
                    total_lines,
                    total_bytes,
                    start_line: offset,
                    end_line,
                    truncated,
                },
            ))
        })
    }
}
