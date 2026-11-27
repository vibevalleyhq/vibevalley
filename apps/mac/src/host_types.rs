//! Shared zero-dependency host callback, layout bounds, terminal naming, and
//! standalone HTML sandbox policy primitives.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gpui::{Bounds, Pixels, Point};
use serde_json::Value;
use vibevalley_workspace::{Axis, Layout, Node};

/// Answers one `host.*` call of a hosted view (event `reply:<id>`).
#[derive(Clone)]
pub struct Replier {
    channel: nsh_engine::HostChannel,
    id: String,
}

impl std::fmt::Debug for Replier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Replier({})", self.id)
    }
}

impl Replier {
    pub fn new(channel: nsh_engine::HostChannel, id: String) -> Self {
        Self { channel, id }
    }

    pub fn send(self, envelope: vibevalley_server::gateway::bridge::Envelope) {
        let _ = self
            .channel
            .send(format!("reply:{}", self.id), serde_json::to_value(envelope).unwrap_or(Value::Null));
    }
}

/// Where each split was laid out last frame, for divider drags.
#[derive(Default, Clone)]
pub struct SplitBounds(Rc<RefCell<HashMap<u64, Bounds<Pixels>>>>);

impl SplitBounds {
    pub(crate) fn insert(&self, id: u64, bounds: Bounds<Pixels>) {
        self.0.borrow_mut().insert(id, bounds);
    }

    /// The fraction child `index` of `split` should take of the space it
    /// shares with the next child, for a divider dragged to `at`.
    pub fn fraction(&self, layout: &Layout, split: u64, index: usize, at: Point<Pixels>) -> Option<f32> {
        let bounds = *self.0.borrow().get(&split)?;
        let s = find_split(&layout.root, split)?;
        let (origin, size, pos) = match s.axis {
            Axis::Horizontal => (bounds.origin.x, bounds.size.width, at.x),
            Axis::Vertical => (bounds.origin.y, bounds.size.height, at.y),
        };
        let size = f32::from(size);
        if size <= 0.0 || index + 1 >= s.ratios.len() {
            return None;
        }
        let before: f32 = s.ratios[..index].iter().sum();
        let pair = s.ratios[index] + s.ratios[index + 1];
        let start = f32::from(origin) + before * size;
        Some(((f32::from(pos) - start) / (pair * size)).clamp(0.0, 1.0))
    }
}

fn find_split(node: &Node, id: u64) -> Option<&vibevalley_workspace::Split> {
    match node {
        Node::Split(s) if s.id == id => Some(s),
        Node::Split(s) => s.children.iter().find_map(|c| find_split(c, id)),
        Node::Group(_) => None,
    }
}

/// Default shell-generated titles that add noise in tabs and the sidebar:
/// `user@host`, `user@host:~/dir`, `zsh — user@host`, bare paths (`~/...`, `/...`),
/// or raw shell paths (`/bin/zsh`, `-zsh`).
pub(crate) fn is_default_title(title: &str) -> bool {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return true;
    }
    if trimmed.starts_with("~/") || trimmed.starts_with('/') || trimmed == "~" {
        return true;
    }
    let bare = trimmed.trim_start_matches('-').rsplit('/').next().unwrap_or(trimmed);
    if matches!(bare, "zsh" | "bash" | "sh" | "fish" | "nu" | "pwsh" | "login") {
        return true;
    }
    trimmed.split_whitespace().any(|tok| {
        let tok = tok.trim_matches(|c: char| matches!(c, '(' | ')' | '[' | ']' | ':' | ','));
        tok.contains('@') && !tok.starts_with('@') && tok.split_once('@').is_some_and(|(u, h)| !u.is_empty() && !h.is_empty() && !u.contains('/'))
    })
}

pub(crate) fn shell_name() -> String {
    std::env::var("SHELL")
        .ok()
        .and_then(|s| s.rsplit('/').next().map(String::from))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "shell".into())
}

pub(crate) fn chat_runtime_label(runtime: &str) -> &str {
    match runtime {
        "antigravity" => "Antigravity",
        "claude" => "Claude",
        "codex" => "Codex",
        other if !other.is_empty() => other,
        _ => "Chat",
    }
}

const POLICY_META: &str = concat!(
    "<meta http-equiv=\"Content-Security-Policy\" content=\"",
    "default-src 'none'; ",
    "script-src 'unsafe-inline'; ",
    "style-src 'unsafe-inline'; ",
    "img-src data: blob:; ",
    "font-src data:; ",
    "media-src data: blob:; ",
    "connect-src 'none'; ",
    "form-action 'none'; ",
    "base-uri 'none'",
    "\">",
);

fn find_ascii_ci(haystack: &str, needle: &str) -> Option<usize> {
    let h = haystack.as_bytes();
    let n = needle.as_bytes();
    if n.is_empty() || h.len() < n.len() {
        return None;
    }
    h.windows(n.len()).position(|w| w.eq_ignore_ascii_case(n))
}

fn starts_with_ci(s: &str, prefix: &str) -> bool {
    s.get(..prefix.len()).is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

/// Inserts the strict CSP `<meta>` right after `<head>`, else after `<!doctype ...>`, else first.
pub fn with_policy(page: &str) -> String {
    if let Some(head_idx) = find_head_tag_end(page) {
        let mut out = String::with_capacity(page.len() + POLICY_META.len());
        out.push_str(&page[..head_idx]);
        out.push_str(POLICY_META);
        out.push_str(&page[head_idx..]);
        return out;
    }
    let trimmed_start = page.len() - page.trim_start().len();
    if let Some(after_ws) = page.get(trimmed_start..)
        && starts_with_ci(after_ws, "<!doctype")
        && let Some(gt) = after_ws.find('>')
    {
        let insert_at = trimmed_start + gt + 1;
        let mut out = String::with_capacity(page.len() + POLICY_META.len());
        out.push_str(&page[..insert_at]);
        out.push_str(POLICY_META);
        out.push_str(&page[insert_at..]);
        return out;
    }
    format!("{POLICY_META}{page}")
}

fn find_head_tag_end(page: &str) -> Option<usize> {
    let mut offset = 0usize;
    while let Some(rel) = find_ascii_ci(&page[offset..], "<head") {
        let start = offset + rel;
        let after = &page[start + "<head".len()..];
        let next_ok = after.as_bytes().first().is_some_and(|b| b.is_ascii_whitespace() || *b == b'>');
        if next_ok && let Some(gt) = after.find('>') {
            return Some(start + "<head".len() + gt + 1);
        }
        offset = start + "<head".len();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_goes_after_head_else_after_doctype_else_first() {
        assert!(with_policy("<html><head><title>x</title></head></html>").starts_with(&format!("<html><head>{POLICY_META}")));
        assert!(with_policy("<html><HEAD lang=\"en\"><title>x</title></HEAD></html>").starts_with(&format!("<html><HEAD lang=\"en\">{POLICY_META}")));
        assert!(with_policy("<!doctype html><p>x</p>").starts_with(&format!("<!doctype html>{POLICY_META}")));
        assert!(with_policy("<p>x</p>").starts_with(POLICY_META));
    }
}
