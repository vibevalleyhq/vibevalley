//! Shared cross-domain text helpers: UTF-16 clipping, Markdown plain-text
//! flattening, and fenced note view context.

use std::sync::LazyLock;

use regex::{Captures, Regex};
pub use vibevalley_kit::core::text::{head, within};
use vibevalley_protocol::NoteViewContext;

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a pattern")
}

static FENCE: LazyLock<Regex> = LazyLock::new(|| re(r"```[^\n]*\n([\s\S]*?)```"));
static CODE: LazyLock<Regex> = LazyLock::new(|| re(r"`([^`\n]+)`"));
static IMAGE: LazyLock<Regex> = LazyLock::new(|| re(r"!\[([^\]]*)\]\(([^)]+)\)"));
static LINK: LazyLock<Regex> = LazyLock::new(|| re(r"\[([^\]]+)\]\(([^)]+)\)"));
static HEADING: LazyLock<Regex> = LazyLock::new(|| re(r"(?m)^#{1,6}\s+"));
static BOLD: LazyLock<Regex> = LazyLock::new(|| re(r"\*\*(.+?)\*\*|__(.+?)__"));
static ITALIC: LazyLock<Regex> = LazyLock::new(|| re(r"(^|[^*])\*([^*\s][^*\n]*?)\*"));
static BULLET: LazyLock<Regex> = LazyLock::new(|| re(r"(?m)^\s*[-*+]\s+"));
static GAPS: LazyLock<Regex> = LazyLock::new(|| re(r"\n{3,}"));

/// Strips common Markdown formatting into readable plain text.
pub fn plain_text(markdown: &str) -> String {
    let s = FENCE.replace_all(markdown, |c: &Captures| c[1].trim_end().to_string());
    let s = CODE.replace_all(&s, "$1");
    let s = IMAGE.replace_all(&s, "[$1] $2");
    let s = LINK.replace_all(&s, "$1 ($2)");
    let s = HEADING.replace_all(&s, "");
    let s = BOLD.replace_all(&s, |c: &Captures| c.get(1).or(c.get(2)).map_or("", |m| m.as_str()).to_string());
    let s = ITALIC.replace_all(&s, "$1$2");
    let s = BULLET.replace_all(&s, "· ");
    GAPS.replace_all(&s, "\n\n").trim().to_string()
}

/// Flattens Markdown to a single line and clips it to at most `max_units` UTF-16 units.
pub fn clip_plain(text: &str, max_units: usize) -> String {
    let cleaned = plain_text(text).replace('\n', " ");
    let collapsed = vibevalley_kit::core::text::collapse_whitespace(&cleaned);
    let cut = within(&collapsed, max_units);
    if cut < collapsed.len() {
        format!("{}…", collapsed[..cut].trim_end())
    } else {
        collapsed
    }
}

/// Formats untrusted client view state inside a fenced XML block so titles or summaries cannot break out.
pub fn format_note_view_context(vc: &NoteViewContext) -> String {
    let safe_json = serde_json::to_string(vc).unwrap_or_default().replace("</", "<\\/");
    format!("<note-view-context>\n{safe_json}\n</note-view-context>")
}
