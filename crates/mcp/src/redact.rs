//! Secret redaction helpers for MCP tool outputs and resource contents.

use crate::protocol::{ContentBlock, ResourceContent, ToolCallResult};

/// Replacement marker emitted whenever a known secret is scrubbed from output.
pub const REDACTED_MARKER: &str = "[redacted]";

/// Replaces every non-empty secret in `secrets` with [`REDACTED_MARKER`].
///
/// Longer secrets are scrubbed before shorter ones so a prefix secret cannot
/// partially mangle a longer token before the full match is redacted.
pub fn scrub_secrets<S: AsRef<str>>(text: &str, secrets: &[S]) -> String {
    let mut needles: Vec<&str> = secrets.iter().map(|s| s.as_ref().trim()).filter(|s| !s.is_empty()).collect();
    if needles.is_empty() {
        return text.to_owned();
    }
    if needles.len() > 1 {
        needles.sort_by_key(|s| std::cmp::Reverse(s.len()));
        needles.dedup();
    }
    let mut out = text.to_owned();
    for needle in needles {
        if out.contains(needle) {
            out = out.replace(needle, REDACTED_MARKER);
        }
    }
    out
}

/// Scrubs all text blocks and embedded text resources inside `result` in place.
pub fn scrub_tool_result<S: AsRef<str>>(result: &mut ToolCallResult, secrets: &[S]) {
    for block in &mut result.content {
        match block {
            ContentBlock::Text { text } => {
                *text = scrub_secrets(text, secrets);
            }
            ContentBlock::Resource { resource } => {
                scrub_resource_content(resource, secrets);
            }
            ContentBlock::Image { .. } => {}
        }
    }
}

/// Scrubs text inside a [`ResourceContent`] in place.
pub fn scrub_resource_content<S: AsRef<str>>(content: &mut ResourceContent, secrets: &[S]) {
    if let Some(text) = content.text.as_mut() {
        *text = scrub_secrets(text, secrets);
    }
}
