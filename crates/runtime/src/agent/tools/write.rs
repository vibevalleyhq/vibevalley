use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::workspace::Workspace;
use super::{ReplayPolicy, ToolContext, TypedTool, TypedToolOutput};

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct WriteArgs {
    /// Path to the file to create or overwrite, relative to the workspace or absolute.
    pub path: String,
    /// Full file content to write.
    pub content: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WriteDetails {
    pub path: String,
    pub bytes_written: usize,
}

pub struct WriteFile(pub Workspace);

impl TypedTool for WriteFile {
    type Args = WriteArgs;
    type Details = WriteDetails;

    fn name(&self) -> &'static str {
        "write"
    }

    fn description(&self) -> &'static str {
        "Create or overwrite a file with the given content, creating parent directories automatically."
    }

    fn replay(&self) -> ReplayPolicy {
        ReplayPolicy::Unsafe
    }

    fn execute(&self, args: Self::Args, ctx: &ToolContext) -> Result<TypedToolOutput<Self::Details>, String> {
        if ctx.cancel.is_cancelled() {
            return Err("aborted by the user".into());
        }
        let path = self.0.resolve(&args.path);
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        std::fs::write(&path, &args.content).map_err(|e| format!("{}: {e}", path.display()))?;
        let bytes_written = args.content.len();
        Ok(TypedToolOutput::ok_with(
            format!("wrote {bytes_written} bytes to {}", path.display()),
            WriteDetails {
                path: path.display().to_string(),
                bytes_written,
            },
        ))
    }
}
