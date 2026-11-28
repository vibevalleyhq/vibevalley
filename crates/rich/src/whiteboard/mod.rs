//! Native interactive `VvWhiteboard` `#[component]` backed by pure-Rust `engine::whiteboard`.
//!
//! Renders infinite pan/zoom boards in a single atomic [`nsh_core::prelude::canvas`] view (so
//! background grid, world elements, selection chrome, snap guides, and collaborator cursors
//! always share the same camera transform) with GPUI-native floating docks, borderless in-place
//! inline editing, minimap, context menu, and collapsible inspector (zero `WKWebView`).

mod chrome;
mod component;
mod dock;
mod hud;
mod inline_editor;
mod inspector;
mod overlays;
mod props;
mod replica;
mod stage;
mod state;

pub use component::{VvWhiteboard, VvWhiteboardElement, vv_whiteboard};
pub use props::{
    VvWhiteboardBatchEvent, VvWhiteboardChatEvent, VvWhiteboardCursorEvent, VvWhiteboardEvent, VvWhiteboardExportEvent, VvWhiteboardProps,
    VvWhiteboardSelectionEvent, VvWhiteboardViewportEvent,
};
