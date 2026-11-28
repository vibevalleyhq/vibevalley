//! The read-only file viewer: highlighted text painted by GPUI, images,
//! and placeholders for binary or oversized files. Markdown files offer a
//! rendered preview and every file can open in Cursor, VS Code, Zed, `$EDITOR`,
//! or macOS Default App.

mod highlight;
mod render;
#[cfg(test)]
mod tests;
mod toolbar;
mod view;

use std::path::Path;
use std::sync::Arc;

use vibevalley_files::Language;

pub use highlight::Line;
pub(crate) use toolbar::{EditorToolbarState, is_html_path, split_display_path};
pub use view::{FileViewer, ViewerEvent};

pub(super) const MAX_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HtmlViewMode {
    Preview,
    Source,
}

impl HtmlViewMode {
    pub(super) fn default_for_path(path: &Path) -> Self {
        if is_html_path(path) { Self::Preview } else { Self::Source }
    }
}

pub(super) enum State {
    Loading,
    Text {
        lines: Arc<Vec<Line>>,
        language: Option<Language>,
        html_doc: Option<Arc<str>>,
    },
    Image,
    Binary(u64),
    TooLarge(u64),
    Error(String),
}
