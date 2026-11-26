//! The helpers' MCP door (`gateway/mcp`): JSON-RPC over `POST /mcp` backed by
//! `vibevalley-mcp` (SEP-2575 stateless core, SEP-2640 Skills over MCP, and
//! legacy `initialize` compatibility).

mod door;
pub mod mode;
pub mod resource;
mod skills;

pub use door::Mcp;
pub use mode::{HelperRunMode, ToolDispatchPort, ToolSpecWire, tool_allowed_in_mode};
pub use resource::{McpResourceContentWire, McpResourceTemplateWire, McpResourceWire, Resource, ResourceReadArgs, ResourceReader};
