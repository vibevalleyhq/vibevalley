//! Per-channel notification formatting, text chunking, pairing helpers, and
//! missed-batch digest rendering across WeChat (`Weixin`), Feishu (`Feishu`), and QQ (`Qq`).

use std::sync::LazyLock;

use regex::Regex;
use vibevalley_i18n::{locale as current_locale, t_in};
use vibevalley_protocol::ConnectorID;

use crate::context::text::{clip_plain, within};

/// More than this many waiting go out as one digest.
pub const DIGEST_OVER: usize = 3;

static PAIR_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?i:配对|pair)").expect("a pattern"));

/// Spaces and the pairing word in front (配对, or pair) allowed, whatever the locale.
pub fn is_pairing(text: &str, code: &str) -> bool {
    let flat: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    PAIR_WORD.replace(&flat, "") == code
}

/// Enough to recognise, not to copy.
pub fn short_id(id: &str) -> String {
    let chars: Vec<char> = id.chars().collect();
    if chars.len() <= 10 {
        return id.to_string();
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

/// `text` in pieces of at most `max` UTF-16 units, preferring paragraph (`\n\n`) then line (`\n`) boundaries.
pub fn split_text(text: &str, max: usize) -> Vec<String> {
    if text.is_empty() {
        return vec![];
    }
    let max = max.max(1);
    let mut pieces = vec![];
    let mut rest = text;
    while rest.encode_utf16().count() > max {
        let window_end = within(rest, max);
        let window = &rest[..window_end];
        let para_cut = window
            .rfind("\n\n")
            .filter(|&cut| window[..cut].encode_utf16().count() * 3 >= max && !rest[..cut].trim_end().is_empty());
        let line_cut = window
            .rfind('\n')
            .filter(|&cut| window[..cut].encode_utf16().count() * 2 > max && !rest[..cut].trim_end().is_empty());
        let at = para_cut.or(line_cut).unwrap_or_else(|| {
            if window_end > 0 {
                window_end
            } else {
                rest.chars().next().map_or(0, char::len_utf8)
            }
        });
        pieces.push(rest[..at].trim_end().to_string());
        rest = rest[at..].trim_start();
    }
    if !rest.is_empty() {
        pieces.push(rest.to_string());
    }
    pieces
}

/// Structured notification item parsed for grouped digest rendering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DigestEntry {
    pub category_label: String,
    pub target: Option<String>,
    pub summary: String,
}

/// Parses an outbox notification body into a deduplicated [`DigestEntry`].
pub fn parse_digest_entry(message_id: &str, body: &str) -> DigestEntry {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return DigestEntry {
            category_label: String::new(),
            target: None,
            summary: String::new(),
        };
    }
    let (raw_head, rest) = match trimmed.split_once('\n') {
        Some((h, r)) => (h.trim(), r),
        None => (trimmed, ""),
    };
    let head = strip_heading_wrappers(raw_head);
    let inner = strip_outer_brackets(head);

    let Some(inner) = inner else {
        return DigestEntry {
            category_label: String::new(),
            target: None,
            summary: clip_plain(trimmed, 90),
        };
    };

    let (category_label, mut target) = match inner.split_once(" · ") {
        Some((cat, tgt)) => {
            let tgt = tgt.trim();
            (cat.trim().to_string(), (!tgt.is_empty()).then(|| tgt.to_string()))
        }
        None => (inner.trim().to_string(), None),
    };

    let first_para_lines = first_paragraph_lines(rest);
    let is_perm = message_id.starts_with("push:perm:") || first_para_lines.first().is_some_and(|l| l.starts_with("工具：") || l.starts_with("Tool: "));
    let raw_summary = if is_perm {
        first_para_lines.into_iter().take(2).collect::<Vec<_>>().join(" · ")
    } else {
        first_para_lines.into_iter().next().unwrap_or("").to_string()
    };

    let summary = dedupe_summary_against_target(&mut target, &raw_summary);
    DigestEntry {
        category_label,
        target,
        summary,
    }
}

fn strip_heading_wrappers(s: &str) -> &str {
    let s = s.trim();
    let s = s.strip_prefix("### ").map(str::trim).unwrap_or(s);
    s.strip_prefix("**").and_then(|inner| inner.strip_suffix("**")).map(str::trim).unwrap_or(s)
}

fn strip_outer_brackets(s: &str) -> Option<&str> {
    let s = s.trim();
    if let Some(inner) = s.strip_prefix('【').and_then(|rest| rest.strip_suffix('】')) {
        return Some(inner);
    }
    if let Some(inner) = s.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')) {
        return Some(inner);
    }
    None
}

fn first_paragraph_lines(rest: &str) -> Vec<&str> {
    if rest.starts_with('\n') || rest.starts_with("\r\n") {
        let after_blank = rest.trim_start_matches(['\r', '\n']);
        if after_blank.trim_start().starts_with("---") || !after_blank.contains("\n\n") {
            return Vec::new();
        }
    }
    let mut lines = Vec::new();
    for line in rest.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed == "---" {
            if !lines.is_empty() {
                break;
            }
            continue;
        }
        lines.push(trimmed);
    }
    lines
}

fn issue_number_prefix(target: &str) -> Option<&str> {
    let after_hash = target.strip_prefix('#')?;
    let digits_len = after_hash.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digits_len == 0 {
        return None;
    }
    let end = 1 + digits_len;
    if target.as_bytes().get(end) == Some(&b' ') {
        Some(&target[..end])
    } else {
        None
    }
}

fn strip_issue_prefix(target: &str) -> &str {
    match issue_number_prefix(target) {
        Some(prefix) => target[prefix.len()..].trim_start(),
        None => target,
    }
}

fn dedupe_summary_against_target(target: &mut Option<String>, raw_summary: &str) -> String {
    let clean_summary = clip_plain(raw_summary, 240);
    if clean_summary.is_empty() {
        return String::new();
    }
    if let Some(tgt) = target.as_deref() {
        let clean_tgt = clip_plain(tgt, 240);
        let title_part = strip_issue_prefix(&clean_tgt);
        if clean_summary == clean_tgt || (!title_part.is_empty() && clean_summary == title_part) {
            return String::new();
        }
        if title_part.ends_with('…') {
            let prefix = title_part.trim_end_matches('…').trim_end();
            if !prefix.is_empty() && clean_summary.starts_with(prefix) {
                let tail = &clean_summary[prefix.len()..];
                if !tail.starts_with([':', '：']) {
                    *target = Some(match issue_number_prefix(&clean_tgt) {
                        Some(num) => format!("{num} {}", clip_plain(&clean_summary, 72)),
                        None => clip_plain(&clean_summary, 72),
                    });
                    return String::new();
                }
            }
        }
    }
    clip_plain(&clean_summary, 100)
}

/// Adapts a canonical single push notification body for `channel`.
pub fn adapt_notification(channel: ConnectorID, body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let (head, rest) = match trimmed.split_once('\n') {
        Some((h, r)) => (h.trim(), r.trim_end()),
        None => (trimmed, ""),
    };
    let (middle, footer) = split_middle_and_footer(rest);

    match channel {
        ConnectorID::Weixin => join_plain_notification(head, &middle, &footer, false),
        ConnectorID::Feishu => join_feishu_notification(head, &middle, &footer),
        ConnectorID::Qq => join_plain_notification(head, &middle, &footer, true),
    }
}

/// Renders grouped missed-batch notifications for `channel` in the active locale.
pub fn render_digest(channel: ConnectorID, entries: &[DigestEntry]) -> String {
    render_digest_in(channel, &current_locale(), entries)
}

/// Renders grouped missed-batch notifications for `channel` in an explicit `locale`.
pub fn render_digest_in(channel: ConnectorID, locale: &str, entries: &[DigestEntry]) -> String {
    if entries.is_empty() {
        return String::new();
    }
    let groups = group_entries(locale, entries);
    let summary_clip = match channel {
        ConnectorID::Weixin => 72,
        ConnectorID::Feishu => 100,
        ConnectorID::Qq => 80,
    };
    let rendered_groups: Vec<String> = groups
        .into_iter()
        .map(|(category, items)| {
            let group_key = match channel {
                ConnectorID::Weixin | ConnectorID::Qq => "server.connector.digestGroup",
                ConnectorID::Feishu => "server.connector.digestGroupMarkdown",
            };
            let group_head = t_in(locale, group_key, &[("category", category.into()), ("n", (items.len() as i64).into())]);
            let lines: Vec<String> = items
                .into_iter()
                .enumerate()
                .map(|(idx, entry)| format_digest_item(channel, idx + 1, entry, summary_clip))
                .collect();
            format!("{group_head}\n{}", lines.join("\n"))
        })
        .collect();

    let total = entries.len() as i64;
    let body = rendered_groups.join("\n\n");
    let wrapper_key = match channel {
        ConnectorID::Weixin | ConnectorID::Qq => "server.connector.digest",
        ConnectorID::Feishu => "server.connector.digestMarkdown",
    };
    t_in(locale, wrapper_key, &[("n", total.into()), ("lines", body.into())])
}

/// Convenience helper for raw message lines.
pub fn render_digest_lines(channel: ConnectorID, locale: &str, lines: &[String]) -> String {
    let entries: Vec<DigestEntry> = lines.iter().map(|line| parse_digest_entry("", line)).collect();
    render_digest_in(channel, locale, &entries)
}

fn split_middle_and_footer(rest: &str) -> (String, String) {
    if rest.is_empty() {
        return (String::new(), String::new());
    }
    let starts_with_blank = rest.starts_with('\n') || rest.starts_with("\r\n");
    let clean_rest = rest.trim();
    if let Some((before, after)) = clean_rest.rsplit_once("\n\n") {
        let before_clean = before.trim();
        let after_clean = after.trim().trim_start_matches("---").trim();
        if !after_clean.is_empty() {
            return (before_clean.to_string(), after_clean.to_string());
        }
    }
    if starts_with_blank {
        let footer = clean_rest.trim_start_matches("---").trim();
        return (String::new(), footer.to_string());
    }
    (clean_rest.to_string(), String::new())
}

fn join_plain_notification(head: &str, middle: &str, footer: &str, blank_before_body: bool) -> String {
    let clean_head = strip_markdown_emphasis(head);
    let clean_middle = if middle.is_empty() {
        String::new()
    } else {
        middle
            .lines()
            .map(strip_markdown_emphasis)
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    };
    let clean_footer = strip_markdown_emphasis(footer);
    let mut out = clean_head;
    if !clean_middle.is_empty() {
        out.push_str(if blank_before_body { "\n\n" } else { "\n" });
        out.push_str(&clean_middle);
    }
    if !clean_footer.is_empty() {
        out.push_str("\n\n");
        out.push_str(&clean_footer);
    }
    out
}

fn join_feishu_notification(head: &str, middle: &str, footer: &str) -> String {
    let heading = format!("**{}**", strip_markdown_emphasis(head));
    let mut sections = vec![heading];
    if !middle.is_empty() {
        sections.push(middle.to_string());
    }
    if !footer.is_empty() {
        sections.push(format!("---\n{footer}"));
    }
    sections.join("\n\n")
}

fn strip_markdown_emphasis(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    clip_plain(trimmed, usize::MAX / 4)
}

fn group_entries<'a>(locale: &str, entries: &'a [DigestEntry]) -> Vec<(String, Vec<&'a DigestEntry>)> {
    let fallback = t_in(locale, "server.connector.digestOther", &[]);
    let mut groups: Vec<(String, Vec<&'a DigestEntry>)> = Vec::new();
    for entry in entries {
        let label = if entry.category_label.trim().is_empty() {
            fallback.as_str()
        } else {
            entry.category_label.trim()
        };
        if let Some((_, items)) = groups.iter_mut().find(|(cat, _)| cat == label) {
            items.push(entry);
        } else {
            groups.push((label.to_string(), vec![entry]));
        }
    }
    groups
}

fn format_digest_item(channel: ConnectorID, index: usize, entry: &DigestEntry, summary_clip: usize) -> String {
    let plain_target = entry.target.as_deref().map(|t| clip_plain(t, 64)).filter(|t| !t.is_empty());
    let plain_summary = clip_plain(&entry.summary, summary_clip);

    let line_body = match (plain_target, plain_summary.is_empty()) {
        (Some(target), true) => target,
        (Some(target), false) => match channel {
            ConnectorID::Weixin | ConnectorID::Feishu | ConnectorID::Qq => format!("{target} — {plain_summary}"),
        },
        (None, false) => plain_summary,
        (None, true) => entry.category_label.clone(),
    };
    format!("{index}. {line_body}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixed_category_digest_separates_groups_and_splits_on_paragraph_boundaries() {
        let ask = DigestEntry {
            category_label: "需要回复".into(),
            target: Some("#80 发布窗口".into()),
            summary: "是否开启安静时段？".into(),
        };
        let rev_a = DigestEntry {
            category_label: "待你验收".into(),
            target: Some("#83 工作区优化".into()),
            summary: String::new(),
        };
        let rev_b = DigestEntry {
            category_label: "待你验收".into(),
            target: Some("#84 连接器排版".into()),
            summary: "已完成去重与分组".into(),
        };
        let chat = DigestEntry {
            category_label: "主助手".into(),
            target: None,
            summary: "构建已通过".into(),
        };

        let rendered = render_digest_in(ConnectorID::Weixin, "zh", &[ask, rev_a, rev_b, chat]);
        assert_eq!(
            rendered,
            "你不在的时候有 4 条消息：\n\n【需要回复 (1)】\n1. #80 发布窗口 — 是否开启安静时段？\n\n【待你验收 (2)】\n1. #83 工作区优化\n2. #84 连接器排版 — 已完成去重与分组\n\n【主助手 (1)】\n1. 构建已通过\n\n完整的在默认频道里。"
        );

        let pieces = split_text(&rendered, 110);
        assert!(pieces.len() >= 2);
        for piece in &pieces {
            assert!(piece.encode_utf16().count() <= 110);
            for line in piece.lines() {
                if line.starts_with("1. ") || line.starts_with("2. ") {
                    assert!(line.contains('#') || line.contains("构建已通过"), "unexpected split inside item: {line}");
                }
            }
        }
    }
}
