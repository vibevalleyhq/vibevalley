//! The farm's tools, one set for the orchestrator and the helpers: each
//! tool takes its arguments as a typed struct, read leniently from what a
//! model wrote, and answers in words for the model. What the model sees of a
//! tool (name, description, JSON Schema) is in `assets/tools/`, which this
//! crate owns; who may call which is the file the tool is listed in.

mod chat;
mod content;
mod dispatch;
mod issue;
mod memory;
mod plan;
mod registry;
#[cfg(test)]
mod tests;
pub mod toolset;

pub use chat::message_line;
pub use dispatch::{Held, Tool, held, held_for, helper, orchestrator, unrun};
pub use registry::{Route, ToolRegistry, Who, Words};
pub use toolset::{Role, ToolAccess, access_of, allows, can_role, denied_message, toolset_of};
