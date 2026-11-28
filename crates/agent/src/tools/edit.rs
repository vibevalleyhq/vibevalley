use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::workspace::Workspace;
use super::{ReplayPolicy, ToolContext, TypedTool, TypedToolOutput};
use vibevalley_oar::BoxFuture;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct EditArgs {
    /// Path to the file to edit, relative to the workspace or absolute.
    pub path: String,
    /// Exact text to find in the file.
    pub old_text: String,
    /// Replacement text.
    pub new_text: String,
    /// Replace every match when true; otherwise require a unique match.
    #[serde(default)]
    pub replace_all: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EditDetails {
    pub path: String,
    pub replacements: usize,
}

pub struct EditFile(pub Workspace);

impl TypedTool for EditFile {
    type Args = EditArgs;
    type Details = EditDetails;

    fn name(&self) -> &'static str {
        "edit"
    }

    fn description(&self) -> &'static str {
        "Replace old_text with new_text in a file. Requires a unique match unless replace_all is true."
    }

    fn replay(&self) -> ReplayPolicy {
        ReplayPolicy::Unsafe
    }

    fn execute<'a>(&'a self, args: Self::Args, ctx: &'a ToolContext) -> BoxFuture<'a, Result<TypedToolOutput<Self::Details>, String>> {
        Box::pin(async move {
            if ctx.cancel.is_cancelled() {
                return Err("aborted by the user".into());
            }
            if args.old_text.is_empty() {
                return Err("old_text must not be empty".into());
            }
            let path = self.0.resolve(&args.path);
            let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            let matches = text.matches(&args.old_text).count();
            let (next, replacements) = match matches {
                0 => return Err("old_text was not found".into()),
                1 => (text.replacen(&args.old_text, &args.new_text, 1), 1),
                n if args.replace_all == Some(true) => (text.replace(&args.old_text, &args.new_text), n),
                n => return Err(format!("old_text occurs {n} times; include more context or pass replace_all=true")),
            };
            std::fs::write(&path, next).map_err(|e| format!("{}: {e}", path.display()))?;
            Ok(TypedToolOutput::ok_with(
                format!("edited {} ({replacements} replacement(s))", path.display()),
                EditDetails {
                    path: path.display().to_string(),
                    replacements,
                },
            ))
        })
    }
}
