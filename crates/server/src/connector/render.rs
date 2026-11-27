//! Per-channel notification and missed-batch digest rendering across
//! WeChat (`Weixin`), Feishu (`Feishu`), and QQ (`Qq`).

use vibevalley_i18n::{locale as current_locale, t_in};
use vibevalley_protocol::ConnectorID;

use super::digest::{DigestEntry, PersonalEvent, format_personal_event_in, parse_digest_entry};
use crate::context::text::clip_plain;

/// Renders a single [`PersonalEvent`] adapted for `channel` in the active locale.
pub fn render_personal_event(channel: ConnectorID, event: &PersonalEvent) -> String {
    render_personal_event_in(channel, &current_locale(), event)
}

/// Renders a single [`PersonalEvent`] adapted for `channel` in an explicit `locale`.
pub fn render_personal_event_in(channel: ConnectorID, locale: &str, event: &PersonalEvent) -> String {
    let canonical = format_personal_event_in(locale, event);
    adapt_notification(channel, &canonical)
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

/// Convenience helper for raw message lines (used by `digest::digest`).
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
    use crate::connector::digest::{personal_event_for_issue, split_text};
    use vibevalley_protocol::{Issue, IssueStage, IssueStageKind};

    fn review_issue(number: i64, title: &str) -> Issue {
        let mut issue = Issue::new(format!("iss-{number}"), number, title, 1_000);
        issue.stage = IssueStage {
            state: IssueStageKind::Reviewing,
            since: Some(2_000 + number),
            stuck: None,
            lead: None,
            acts: vec![],
        };
        issue
    }

    #[test]
    fn single_notifications_adapt_per_channel_in_zh_and_en_without_title_duplication() {
        let issue = review_issue(83, "[UX/工作区] 优化标签页切换动画");
        let ev_no_summary = personal_event_for_issue(&issue, None, 2_000, None).unwrap();
        let ev_with_summary = personal_event_for_issue(&issue, Some("已补充快捷键与测试"), 2_000, None).unwrap();

        // Weixin: plain mobile text, no raw markdown, no repeated title.
        let wx_zh = render_personal_event_in(ConnectorID::Weixin, "zh", &ev_no_summary);
        assert_eq!(wx_zh, "【待你验收 · #83 [UX/工作区] 优化标签页切换动画】\n\n请在工作台验收或回复意见。");
        assert!(!wx_zh.contains("**") && !wx_zh.contains("###") && !wx_zh.contains("---"));
        assert_eq!(wx_zh.matches("优化标签页切换动画").count(), 1);

        let wx_en = render_personal_event_in(ConnectorID::Weixin, "en", &ev_with_summary);
        assert_eq!(
            wx_en,
            "[Ready for Review · #83 [UX/工作区] 优化标签页切换动画]\n已补充快捷键与测试\n\nReview in VibeValley or reply with feedback."
        );

        // Feishu: structured markdown heading, blank-line breaks, and visual divider.
        let fs_zh = render_personal_event_in(ConnectorID::Feishu, "zh", &ev_with_summary);
        assert_eq!(
            fs_zh,
            "**【待你验收 · #83 [UX/工作区] 优化标签页切换动画】**\n\n已补充快捷键与测试\n\n---\n请在工作台验收或回复意见。"
        );
        let fs_en = render_personal_event_in(ConnectorID::Feishu, "en", &ev_no_summary);
        assert_eq!(
            fs_en,
            "**[Ready for Review · #83 [UX/工作区] 优化标签页切换动画]**\n\n---\nReview in VibeValley or reply with feedback."
        );

        // QQ: platform-safe plain text with blank-line paragraph separation and no markdown.
        let qq_zh = render_personal_event_in(ConnectorID::Qq, "zh", &ev_with_summary);
        assert_eq!(
            qq_zh,
            "【待你验收 · #83 [UX/工作区] 优化标签页切换动画】\n\n已补充快捷键与测试\n\n请在工作台验收或回复意见。"
        );
        assert!(!qq_zh.contains("**") && !qq_zh.contains("###"));
        let qq_en = render_personal_event_in(ConnectorID::Qq, "en", &ev_no_summary);
        assert_eq!(
            qq_en,
            "[Ready for Review · #83 [UX/工作区] 优化标签页切换动画]\n\nReview in VibeValley or reply with feedback."
        );
    }

    #[test]
    fn nineteen_item_review_digest_groups_deduplicates_and_adapts_across_channels_in_zh_and_en() {
        let issues: Vec<Issue> = (83..102).map(|n| review_issue(n, &format!("[UX/工作区] 第 {n} 项任务卡片打磨"))).collect();

        for locale in ["zh", "en"] {
            let entries: Vec<DigestEntry> = issues
                .iter()
                .map(|issue| {
                    let ev = personal_event_for_issue(issue, None, 2_000, None).unwrap();
                    DigestEntry::from_event(locale, &ev)
                })
                .collect();

            for channel in ConnectorID::ALL {
                let rendered = render_digest_in(channel, locale, &entries);
                let paragraphs: Vec<&str> = rendered.split("\n\n").collect();
                assert_eq!(paragraphs.len(), 3, "{channel:?}/{locale}: expected header, 1 group, footer: {rendered}");

                for n in 83..102 {
                    let idx = (n - 83) + 1;
                    let title = format!("[UX/工作区] 第 {n} 项任务卡片打磨");
                    assert!(
                        rendered.contains(&format!("{idx}. #{n} {title}")),
                        "{channel:?}/{locale}: missing item #{n}: {rendered}"
                    );
                    assert_eq!(rendered.matches(&title).count(), 1, "{channel:?}/{locale}: duplicated title #{n}: {rendered}");
                }

                match channel {
                    ConnectorID::Weixin => {
                        assert!(!rendered.contains("**") && !rendered.contains("###") && !rendered.contains("---"));
                        if locale == "zh" {
                            assert!(rendered.contains("你不在的时候有 19 条消息：\n\n【待你验收 (19)】\n1. #83 "));
                            assert!(rendered.ends_with("\n\n完整的在默认频道里。"));
                        } else {
                            assert!(rendered.contains("19 messages while you were away:\n\n[Ready for Review (19)]\n1. #83 "));
                            assert!(rendered.ends_with("\n\nThe whole of them is in the default channel."));
                        }
                    }
                    ConnectorID::Feishu => {
                        if locale == "zh" {
                            assert!(rendered.contains("**你不在的时候有 19 条消息**\n\n### 【待你验收 (19)】\n1. #83 "));
                            assert!(rendered.ends_with("\n\n---\n完整的在默认频道里。"));
                        } else {
                            assert!(rendered.contains("**19 messages while you were away**\n\n### [Ready for Review (19)]\n1. #83 "));
                            assert!(rendered.ends_with("\n\n---\nThe whole of them is in the default channel."));
                        }
                    }
                    ConnectorID::Qq => {
                        assert!(!rendered.contains("**") && !rendered.contains("###") && !rendered.contains("---"));
                        if locale == "zh" {
                            assert!(rendered.contains("你不在的时候有 19 条消息：\n\n【待你验收 (19)】\n1. #83 "));
                            assert!(rendered.ends_with("\n\n完整的在默认频道里。"));
                        } else {
                            assert!(rendered.contains("19 messages while you were away:\n\n[Ready for Review (19)]\n1. #83 "));
                            assert!(rendered.ends_with("\n\nThe whole of them is in the default channel."));
                        }
                        let pieces = split_text(&rendered, 2000);
                        assert!(pieces.iter().all(|p| p.encode_utf16().count() <= 2000));
                    }
                }
            }
        }
    }

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
            // Every piece keeps group headers intact without orphan splits mid-entry.
            for line in piece.lines() {
                if line.starts_with("1. ") || line.starts_with("2. ") {
                    assert!(line.contains('#') || line.contains("构建已通过"), "unexpected split inside item: {line}");
                }
            }
        }
    }
}
