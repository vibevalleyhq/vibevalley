pub use crate::core::tool::{ReplayPolicy, Tool, ToolContext, ToolOutput, ToolUpdate, TypedTool, TypedToolAdapter, TypedToolOutput, typed_execute, typed_spec};

pub mod bash;
pub mod edit;
pub mod find;
pub mod grep;
pub mod ls;
pub mod read;
pub mod truncate;
pub mod workspace;
pub mod write;

#[cfg(test)]
mod tests;

pub use bash::Bash;
pub use edit::EditFile;
pub use find::Find;
pub use grep::Grep;
pub use ls::Ls;
pub use read::ReadFile;
pub use workspace::Workspace;
pub use write::WriteFile;

/// read, write, edit, bash, grep, find and ls in one workspace.
pub fn coding_tools(ws: &Workspace) -> Vec<Box<dyn Tool>> {
    vec![
        Box::new(TypedToolAdapter(ReadFile(ws.clone()))),
        Box::new(TypedToolAdapter(WriteFile(ws.clone()))),
        Box::new(TypedToolAdapter(EditFile(ws.clone()))),
        Box::new(TypedToolAdapter(Bash(ws.clone()))),
        Box::new(TypedToolAdapter(Grep(ws.clone()))),
        Box::new(TypedToolAdapter(Find(ws.clone()))),
        Box::new(TypedToolAdapter(Ls(ws.clone()))),
    ]
}

/// read, grep, find and ls in one workspace.
pub fn read_only_tools(ws: &Workspace) -> Vec<Box<dyn Tool>> {
    vec![
        Box::new(TypedToolAdapter(ReadFile(ws.clone()))),
        Box::new(TypedToolAdapter(Grep(ws.clone()))),
        Box::new(TypedToolAdapter(Find(ws.clone()))),
        Box::new(TypedToolAdapter(Ls(ws.clone()))),
    ]
}
