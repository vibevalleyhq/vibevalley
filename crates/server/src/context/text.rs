//! Shared cross-domain text helpers: UTF-16 clipping and fenced artifact view context.

use vibevalley_protocol::ArtifactViewContext;

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
pub fn format_artifact_view_context(vc: &ArtifactViewContext) -> String {
    let safe_json = serde_json::to_string(vc).unwrap_or_default().replace("</", "<\\/");
    format!("<artifact-view-context>\n{safe_json}\n</artifact-view-context>")
}
