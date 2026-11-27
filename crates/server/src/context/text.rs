//! Shared cross-domain text helpers: UTF-16 clipping, Markdown plain-text
//! flattening, and fenced note view context.

use std::sync::LazyLock;

use regex::{Captures, Regex};
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

/// The byte index after at most `max` UTF-16 units of `s`.
pub fn within(s: &str, max: usize) -> usize {
    let mut units = 0;
    for (at, ch) in s.char_indices() {
        units += ch.len_utf16();
        if units > max {
            return at;
        }
    }
    s.len()
}

/// Flattens Markdown to a single line and clips it to at most `max_units` UTF-16 units.
pub fn clip_plain(text: &str, max_units: usize) -> String {
    let cleaned = plain_text(text).replace('\n', " ");
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut = within(&collapsed, max_units);
    if cut < collapsed.len() {
        format!("{}…", collapsed[..cut].trim_end())
    } else {
        collapsed
    }
}

/// `head` (base/clip.ts): at most `n` UTF-16 units, whole characters.
pub fn head(s: &str, n: usize) -> String {
    let mut out = String::new();
    let mut len = 0;
    for ch in s.chars() {
        len += ch.len_utf16();
        if len > n {
            break;
        }
        out.push(ch);
    }
    out
}

/// Formats untrusted client view state inside a fenced XML block so titles or summaries cannot break out.
pub fn format_note_view_context(vc: &NoteViewContext) -> String {
    let safe_json = serde_json::to_string(vc).unwrap_or_default().replace("</", "<\\/");
    format!("<note-view-context>\n{safe_json}\n</note-view-context>")
}
