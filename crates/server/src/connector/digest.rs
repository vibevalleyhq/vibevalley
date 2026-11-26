//! What the chat apps are sent: a farm message as plain text under a head
//! saying who speaks, cut to what each app takes, and a digest of what
//! waited.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use vibevalley_core::rules::actor_role_of;
use vibevalley_i18n::{locale as current_locale, t, t_in};
use vibevalley_protocol::{AgentRole, Channel, ChannelType, ChatMessage, Issue, IssueStageKind, MessageKind, Millis, Outcome, Session, Spent, StuckReason};

use crate::context::text::{clip_plain, plain_text, within};

/// More than this many waiting go out as one digest.
pub const DIGEST_OVER: usize = 3;

static PAIR_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?i:配对|pair)").expect("a pattern"));

/// The user sees one chat, the farm has many threads: each line says who speaks and where.
pub fn user_line(m: &ChatMessage, place: &Channel) -> String {
    let who = if actor_role_of(&m.actor) == Some(AgentRole::Orchestrator) {
        t("server.connector.line.orchestrator", &[])
    } else {
        m.name.clone()
    };
    let what = match m.kind {
        MessageKind::Report => t(&format!("shared.outcome.{}", m.outcome.unwrap_or(Outcome::Interrupted).as_str()), &[]),
        MessageKind::Dispatch => t("server.connector.line.dispatch", &[]),
        MessageKind::Chat | MessageKind::Notice if place.r#type == ChannelType::Thread => t("server.connector.line.thread", &[]),
        MessageKind::Chat | MessageKind::Notice => String::new(),
    };
    let head = if what.is_empty() {
        t("server.connector.line.head", &[("who", who.into())])
    } else {
        t("server.connector.line.headWhat", &[("who", who.into()), ("what", what.into())])
    };
    format!("{head}\n{}", plain_text(&m.text))
}

/// `text` in pieces of at most `max` UTF-16 units, cut at a line's end when one is past the middle.
pub fn split_text(text: &str, max: usize) -> Vec<String> {
    let mut pieces = vec![];
    let mut rest = text;
    while rest.encode_utf16().count() > max {
        let window = &rest[..within(rest, max)];
        let at = match window.rfind('\n') {
            Some(cut) if window[..cut].encode_utf16().count() * 2 > max => cut,
            _ => window.len(),
        };
        pieces.push(rest[..at].trim_end().to_string());
        rest = rest[at..].trim_start();
    }
    if !rest.is_empty() {
        pieces.push(rest.to_string());
    }
    pieces
}

/// Many waiting lines as one: how many, and the start of each.
pub fn digest(lines: &[String]) -> String {
    let firsts: Vec<String> = lines
        .iter()
        .map(|l| {
            let mut parts = l.split('\n');
            let head = parts.next().unwrap_or("");
            let body = parts.next().unwrap_or("");
            let cut = within(body, 60);
            format!("{head} {}{}", &body[..cut], if cut < body.len() { "…" } else { "" })
        })
        .collect();
    t("server.connector.digest", &[("n", lines.len().into()), ("lines", firsts.join("\n").into())])
}

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

fn short_hash(value: &str) -> String {
    Sha256::digest(value.as_bytes()).iter().take(6).map(|b| format!("{b:02x}")).collect()
}

/// Kind of personal push event delivered to linked chat connectors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PersonalEventKind {
    IssueAsking {
        question: String,
        question_count: usize,
    },
    IssueReviewing {
        summary: String,
    },
    IssueConflict {
        base: String,
        files: Vec<String>,
        why: String,
    },
    IssueInterrupted {
        summary: String,
    },
    IssueFailed {
        summary: String,
    },
    RunCompleted {
        session_name: String,
        summary: String,
        tokens: Option<i64>,
    },
    RunFailed {
        session_name: String,
        summary: String,
    },
    PermissionRequest {
        request_id: String,
        session_name: String,
        tool: String,
        summary: String,
        input: Option<String>,
    },
}

impl PersonalEventKind {
    pub fn category(&self) -> &'static str {
        match self {
            Self::IssueAsking { .. } => "asking",
            Self::IssueReviewing { .. } => "reviewing",
            Self::IssueConflict { .. } => "conflict",
            Self::IssueInterrupted { .. } => "interrupted",
            Self::IssueFailed { .. } => "failed",
            Self::RunCompleted { .. } => "run_completed",
            Self::RunFailed { .. } => "run_failed",
            Self::PermissionRequest { .. } => "perm",
        }
    }

    pub fn is_urgent(&self) -> bool {
        matches!(
            self,
            Self::IssueAsking { .. }
                | Self::IssueConflict { .. }
                | Self::IssueInterrupted { .. }
                | Self::IssueFailed { .. }
                | Self::RunFailed { .. }
                | Self::PermissionRequest { .. }
        )
    }
}

/// Structured personal notification event eligible for WeChat / connector push.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersonalEvent {
    pub dedupe_key: String,
    pub issue_id: Option<String>,
    pub issue_number: Option<i64>,
    pub issue_title: Option<String>,
    pub session_id: Option<String>,
    pub channel_id: Option<String>,
    pub is_child_review: bool,
    pub at: Millis,
    pub kind: PersonalEventKind,
}

impl PersonalEvent {
    pub fn is_urgent(&self) -> bool {
        self.kind.is_urgent()
    }

    /// Stable `connector_outbox.message_id` used for deduplication and workbench-settled withdrawal.
    pub fn outbox_message_id(&self) -> String {
        match (&self.kind, self.issue_id.as_deref(), self.session_id.as_deref()) {
            (PersonalEventKind::PermissionRequest { request_id, .. }, _, Some(session_id)) => {
                format!("push:perm:{session_id}:{request_id}")
            }
            (_, Some(issue_id), _) => format!("push:issue:{issue_id}:{}:{}", self.kind.category(), short_hash(&self.dedupe_key)),
            _ => format!("push:run:{}:{}", self.kind.category(), short_hash(&self.dedupe_key)),
        }
    }
}

/// Parses a `push:issue:<issue_id>:<category>:<hash>` outbox message id.
pub fn parse_push_issue_message_id(message_id: &str) -> Option<(&str, &str)> {
    let rest = message_id.strip_prefix("push:issue:")?;
    let mut parts = rest.splitn(3, ':');
    let issue_id = parts.next().filter(|s| !s.is_empty())?;
    let category = parts.next().filter(|s| !s.is_empty())?;
    Some((issue_id, category))
}

/// Parses a `push:perm:<session_id>:<request_id>` outbox message id.
pub fn parse_push_perm_message_id(message_id: &str) -> Option<(&str, &str)> {
    let rest = message_id.strip_prefix("push:perm:")?;
    let (session_id, request_id) = rest.split_once(':')?;
    if session_id.is_empty() || request_id.is_empty() {
        return None;
    }
    Some((session_id, request_id))
}

/// Actionable push message reference resolved from an inbound quote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushTarget<'a> {
    Issue { issue_id: &'a str, category: &'a str },
    Permission { session_id: &'a str, request_id: &'a str },
}

/// Parses an actionable `push:issue:...` or `push:perm:...` outbox message id.
pub fn parse_push_message_id(message_id: &str) -> Option<PushTarget<'_>> {
    if let Some((issue_id, category)) = parse_push_issue_message_id(message_id) {
        return Some(PushTarget::Issue { issue_id, category });
    }
    if let Some((session_id, request_id)) = parse_push_perm_message_id(message_id) {
        return Some(PushTarget::Permission { session_id, request_id });
    }
    None
}

/// Structured command parsed from a quote-reply to a `push:issue:...` message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IssueReplyAction {
    Answer { text: String },
    Accept,
    Reject { reason: String },
    Retry { words: Option<String> },
}

/// Structured command parsed from a quote-reply to a `push:perm:...` message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionReplyAction {
    AllowOnce,
    AllowAlways,
    Deny { reason: Option<String> },
}

/// Reason a quote-reply could not be mapped to an actionable command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplyParseError {
    EmptyAnswer,
    ReviewUnrecognized,
    RejectNeedsReason,
    StuckUnrecognized,
    ConflictNeedsWorkbench,
    PermissionUnrecognized,
    UnsupportedCategory,
}

fn strip_command_prefix<'a>(input: &'a str, keyword: &str) -> Option<&'a str> {
    let prefix = input.get(..keyword.len())?;
    if !prefix.eq_ignore_ascii_case(keyword) {
        return None;
    }
    let rest = &input[keyword.len()..];
    if rest.is_empty() {
        return Some("");
    }
    let first = rest.chars().next()?;
    if first.is_whitespace() || matches!(first, ':' | '：' | '.' | '。' | '!' | '！') {
        Some(rest.trim_start_matches(|c: char| c.is_whitespace() || matches!(c, ':' | '：')))
    } else {
        None
    }
}

fn strip_trailing_punct(s: &str) -> &str {
    s.trim_end_matches(['.', '。', '!', '！'])
}

/// Parses a user quote-reply to an issue push notification (`asking` / `reviewing` / `failed` / `interrupted` / `conflict`).
pub fn parse_issue_reply(category: &str, text: &str) -> Result<IssueReplyAction, ReplyParseError> {
    let trimmed = text.trim();
    match category {
        "asking" => {
            if trimmed.is_empty() {
                Err(ReplyParseError::EmptyAnswer)
            } else {
                Ok(IssueReplyAction::Answer { text: trimmed.to_string() })
            }
        }
        "reviewing" => {
            let bare = strip_trailing_punct(trimmed).trim();
            let lower = bare.to_ascii_lowercase();
            if matches!(lower.as_str(), "accept" | "ok" | "approve" | "approved" | "lgtm" | "pass" | "yes")
                || matches!(bare, "通过" | "同意" | "确认" | "确认通过" | "通过验收" | "验收通过")
            {
                return Ok(IssueReplyAction::Accept);
            }
            for kw in ["reject", "changes", "rework", "打回", "拒绝", "退回"] {
                if let Some(rest) = strip_command_prefix(trimmed, kw) {
                    let reason = rest.trim();
                    if reason.is_empty() || strip_trailing_punct(reason).trim().is_empty() {
                        return Err(ReplyParseError::RejectNeedsReason);
                    }
                    return Ok(IssueReplyAction::Reject { reason: reason.to_string() });
                }
            }
            Err(ReplyParseError::ReviewUnrecognized)
        }
        "failed" | "interrupted" => {
            for kw in ["retry", "resume", "rerun", "重试", "恢复", "继续", "接着做", "接着修"] {
                if let Some(rest) = strip_command_prefix(trimmed, kw) {
                    let clean = strip_trailing_punct(rest).trim();
                    let words = (!clean.is_empty()).then(|| rest.trim().to_string());
                    return Ok(IssueReplyAction::Retry { words });
                }
            }
            Err(ReplyParseError::StuckUnrecognized)
        }
        "conflict" => Err(ReplyParseError::ConflictNeedsWorkbench),
        _ => Err(ReplyParseError::UnsupportedCategory),
    }
}

/// Parses a user quote-reply to a permission request push notification (`push:perm:<session_id>:<request_id>`).
pub fn parse_permission_reply(text: &str) -> Result<PermissionReplyAction, ReplyParseError> {
    let trimmed = text.trim();
    let bare = strip_trailing_punct(trimmed).trim();
    let lower = bare.to_ascii_lowercase();
    if matches!(lower.as_str(), "allow always" | "always" | "always allow") || matches!(bare, "始终允许" | "总是允许") {
        return Ok(PermissionReplyAction::AllowAlways);
    }
    if matches!(lower.as_str(), "allow" | "allow once" | "approve" | "ok" | "yes") || matches!(bare, "允许" | "同意" | "批准" | "一次允许") {
        return Ok(PermissionReplyAction::AllowOnce);
    }
    for kw in ["deny", "reject", "no", "拒绝", "禁止", "不允许", "不同意"] {
        if let Some(rest) = strip_command_prefix(trimmed, kw) {
            let clean = strip_trailing_punct(rest).trim();
            let reason = (!clean.is_empty()).then(|| rest.trim().to_string());
            return Ok(PermissionReplyAction::Deny { reason });
        }
    }
    Err(ReplyParseError::PermissionUnrecognized)
}

fn issue_stage_stamp(issue: &Issue, fallback_at: Millis, extra: &str) -> String {
    let ts = issue
        .stage
        .since
        .or_else(|| issue.last_run.as_ref().and_then(|r| r.ended_at))
        .or_else(|| issue.last_run.as_ref().map(|r| r.started_at))
        .unwrap_or(fallback_at);
    if extra.is_empty() {
        ts.to_string()
    } else {
        format!("{ts}:{}", short_hash(extra))
    }
}

/// Builds a [`PersonalEvent`] when `issue` is currently in an actionable stage waiting on the user.
pub fn personal_event_for_issue(issue: &Issue, session_summary: Option<&str>, fallback_at: Millis, channel_id: Option<String>) -> Option<PersonalEvent> {
    let summary_or = |fallback: &str| session_summary.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(fallback).to_string();
    let (kind, extra, is_child_review) = match issue.stage.state {
        IssueStageKind::Asking => {
            let question = issue.questions.first().map_or("", |q| q.question.as_str()).to_string();
            let question_count = issue.questions.len().max(1);
            let fp = question.clone();
            (PersonalEventKind::IssueAsking { question, question_count }, fp, false)
        }
        IssueStageKind::Reviewing => {
            let summary = summary_or(&issue.title);
            (PersonalEventKind::IssueReviewing { summary }, String::new(), issue.parent.is_some())
        }
        IssueStageKind::Stuck => match issue.stage.stuck {
            Some(StuckReason::Conflict) => {
                let (base, files, fp) = match &issue.conflict {
                    Some(c) => (c.base.clone(), c.files.clone(), format!("{}:{}", c.base, c.files.join(","))),
                    None => (String::new(), Vec::new(), String::new()),
                };
                let why = issue
                    .questions
                    .first()
                    .map(|q| q.question.clone())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_default();
                let fp = if fp.is_empty() { why.clone() } else { fp };
                (PersonalEventKind::IssueConflict { base, files, why }, fp, false)
            }
            Some(StuckReason::Interrupted) => {
                let fallback = issue.questions.first().map_or("", |q| q.question.as_str());
                let summary = summary_or(fallback);
                (PersonalEventKind::IssueInterrupted { summary }, String::new(), false)
            }
            Some(StuckReason::Failed) => {
                let fallback = issue.questions.first().map_or("", |q| q.question.as_str());
                let summary = summary_or(fallback);
                let fp = summary.clone();
                (PersonalEventKind::IssueFailed { summary }, fp, false)
            }
            Some(StuckReason::Quiet) | None => return None,
        },
        IssueStageKind::Draft | IssueStageKind::Queued | IssueStageKind::Working | IssueStageKind::Done | IssueStageKind::Canceled => return None,
    };
    let stamp = issue_stage_stamp(issue, fallback_at, &extra);
    let dedupe_key = format!("issue:{}:{}:{stamp}", issue.id, kind.category());
    Some(PersonalEvent {
        dedupe_key,
        issue_id: Some(issue.id.clone()),
        issue_number: Some(issue.number),
        issue_title: Some(issue.title.clone()),
        session_id: issue.latest_session_id().cloned(),
        channel_id,
        is_child_review,
        at: issue.stage.since.unwrap_or(fallback_at),
        kind,
    })
}

/// Builds a [`PersonalEvent`] for a standalone session run completion or failure.
pub fn personal_event_for_run(
    session: &Session,
    run_id: Option<&str>,
    outcome: Outcome,
    summary: &str,
    spent: Option<&Spent>,
    at: Millis,
) -> Option<PersonalEvent> {
    let kind = match outcome {
        Outcome::Completed => PersonalEventKind::RunCompleted {
            session_name: session.name.clone(),
            summary: summary.to_string(),
            tokens: spent.map(|s| s.tokens).filter(|t| *t > 0),
        },
        Outcome::Failed => PersonalEventKind::RunFailed {
            session_name: session.name.clone(),
            summary: summary.to_string(),
        },
        Outcome::Interrupted => return None,
    };
    let run_tag = run_id.filter(|r| !r.is_empty()).map(str::to_owned).unwrap_or_else(|| at.to_string());
    let dedupe_key = format!("run:{}:{run_tag}:{}", session.id, outcome.as_str());
    Some(PersonalEvent {
        dedupe_key,
        issue_id: session.issue_id().map(str::to_owned),
        issue_number: None,
        issue_title: None,
        session_id: Some(session.id.clone()),
        channel_id: session.channel_id().map(str::to_owned),
        is_child_review: false,
        at,
        kind,
    })
}

pub(super) fn issue_target_label(number: Option<i64>, title: Option<&str>) -> String {
    let clean_title = title.map(|t| clip_plain(t, 48)).unwrap_or_default();
    match (number, clean_title.is_empty()) {
        (Some(n), false) => format!("#{n} {clean_title}"),
        (Some(n), true) => format!("#{n}"),
        (None, false) => clean_title,
        (None, true) => "VibeValley".into(),
    }
}

/// Formats a [`PersonalEvent`] into concise, actionable i18n plain text for WeChat / chat connectors.
pub fn format_personal_event(event: &PersonalEvent) -> String {
    format_personal_event_in(&current_locale(), event)
}

/// Formats a [`PersonalEvent`] in an explicit `locale` without mutating process-wide i18n state.
pub fn format_personal_event_in(locale: &str, event: &PersonalEvent) -> String {
    let target = issue_target_label(event.issue_number, event.issue_title.as_deref());
    match &event.kind {
        PersonalEventKind::IssueAsking { question, question_count } => {
            let q = clip_plain(question, 220);
            if *question_count > 1 {
                t_in(
                    locale,
                    "server.connector.push.askingMore",
                    &[("target", target.into()), ("question", q.into()), ("n", (*question_count as i64).into())],
                )
            } else {
                t_in(locale, "server.connector.push.asking", &[("target", target.into()), ("question", q.into())])
            }
        }
        PersonalEventKind::IssueReviewing { summary } => {
            let s = clip_plain(summary, 240);
            t_in(locale, "server.connector.push.reviewing", &[("target", target.into()), ("summary", s.into())])
        }
        PersonalEventKind::IssueConflict { base, files, why } => {
            if files.is_empty() && !why.is_empty() {
                let w = clip_plain(why, 200);
                t_in(locale, "server.connector.push.conflictWhy", &[("target", target.into()), ("why", w.into())])
            } else {
                let preview = files.iter().take(3).cloned().collect::<Vec<_>>().join(", ");
                let preview = if files.len() > 3 { format!("{preview}…") } else { preview };
                let base_label = if base.is_empty() { "main" } else { base.as_str() };
                t_in(
                    locale,
                    "server.connector.push.conflict",
                    &[
                        ("target", target.into()),
                        ("base", base_label.into()),
                        ("n", (files.len() as i64).into()),
                        ("files", preview.into()),
                    ],
                )
            }
        }
        PersonalEventKind::IssueInterrupted { summary } => {
            let s = clip_plain(summary, 200);
            t_in(locale, "server.connector.push.interrupted", &[("target", target.into()), ("summary", s.into())])
        }
        PersonalEventKind::IssueFailed { summary } => {
            let s = clip_plain(summary, 200);
            t_in(locale, "server.connector.push.failed", &[("target", target.into()), ("summary", s.into())])
        }
        PersonalEventKind::RunCompleted { session_name, summary, tokens } => {
            let name = clip_plain(session_name, 40);
            let s = clip_plain(summary, 240);
            match tokens {
                Some(tok) if *tok > 0 => t_in(
                    locale,
                    "server.connector.push.runCompletedTokens",
                    &[("name", name.into()), ("summary", s.into()), ("tokens", (*tok).into())],
                ),
                _ => t_in(locale, "server.connector.push.runCompleted", &[("name", name.into()), ("summary", s.into())]),
            }
        }
        PersonalEventKind::RunFailed { session_name, summary } => {
            let name = clip_plain(session_name, 40);
            let s = clip_plain(summary, 240);
            t_in(locale, "server.connector.push.runFailed", &[("name", name.into()), ("summary", s.into())])
        }
        PersonalEventKind::PermissionRequest {
            session_name,
            tool,
            summary,
            input,
            ..
        } => {
            let session = clip_plain(session_name, 40);
            let tool = clip_plain(tool, 40);
            let summary = clip_plain(summary, 180);
            match input.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(raw_input) => {
                    let clipped = clip_plain(raw_input, 160);
                    t_in(
                        locale,
                        "server.connector.push.permissionInput",
                        &[
                            ("session", session.into()),
                            ("tool", tool.into()),
                            ("summary", summary.into()),
                            ("input", clipped.into()),
                        ],
                    )
                }
                None => t_in(
                    locale,
                    "server.connector.push.permission",
                    &[("session", session.into()), ("tool", tool.into()), ("summary", summary.into())],
                ),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_goes_out_as_plain_text() {
        let text = "## 结果\n\n收到：**打卡页** 和 `main.rs`\n- 一\n- [文档](https://x.dev/a)\n\n\n\n```rs\nfn a() {}\n```";
        assert_eq!(plain_text(text), "结果\n\n收到：打卡页 和 main.rs\n· 一\n· 文档 (https://x.dev/a)\n\nfn a() {}");
    }

    #[test]
    fn long_text_is_cut_at_a_line_end_and_never_inside_a_character() {
        let text = format!("{}\n{}", "一".repeat(30), "二".repeat(30));
        assert_eq!(split_text(&text, 40), vec!["一".repeat(30), "二".repeat(30)]);
        let pieces = split_text(&"😀".repeat(10), 5);
        assert_eq!(pieces, vec!["😀😀", "😀😀", "😀😀", "😀😀", "😀😀"]);
        assert_eq!(split_text("short", 40), vec!["short"]);
    }

    #[test]
    fn what_waited_is_one_digest_of_first_lines() {
        vibevalley_i18n::set_locale("zh");
        let lines: Vec<String> = ["一", "二", "三", "四"].iter().map(|w| format!("【助手】\n收到：{w}\n第二行")).collect();
        assert_eq!(
            digest(&lines),
            "你不在的时候有 4 条消息：\n【助手】 收到：一\n【助手】 收到：二\n【助手】 收到：三\n【助手】 收到：四\n\n完整的在默认频道里。"
        );
    }

    #[test]
    fn a_pairing_message_is_the_code_with_or_without_the_word() {
        assert!(is_pairing("123456", "123456"));
        assert!(is_pairing(" 配对 123 456 ", "123456"));
        assert!(is_pairing("Pair123456", "123456"));
        assert!(!is_pairing("配对 654321", "123456"));
        assert!(!is_pairing("请配对 123456", "123456"));
    }

    #[test]
    fn a_long_id_is_shown_by_its_ends() {
        assert_eq!(short_id("o9cq80wkM5NnUserOfThisFarm@im.wechat"), "o9cq…chat");
        assert_eq!(short_id("short"), "short");
    }

    #[test]
    fn personal_events_format_actionable_zh_and_en_and_parse_push_ids() {
        use vibevalley_protocol::{Conflict, IssueStage, Question};

        let mut issue = Issue::new("i24", 24, "微信推送", 1_000);
        issue.stage = IssueStage {
            state: IssueStageKind::Asking,
            since: Some(2_000),
            stuck: None,
            lead: None,
            acts: vec![],
        };
        issue.questions = vec![
            Question {
                question: "**确认** 是否启用 `quiet` 模式？".into(),
                options: vec![],
            },
            Question {
                question: "第二个问题".into(),
                options: vec![],
            },
        ];

        let ask_ev = personal_event_for_issue(&issue, None, 2_000, Some("general".into())).unwrap();
        assert!(ask_ev.is_urgent());
        let msg_id = ask_ev.outbox_message_id();
        assert_eq!(parse_push_issue_message_id(&msg_id), Some(("i24", "asking")));
        let zh_text = format_personal_event_in("zh", &ask_ev);
        assert!(zh_text.contains("【需要回复 · #24 微信推送】"));
        assert!(zh_text.contains("确认 是否启用 quiet 模式？"));
        assert!(zh_text.contains("共 2 个问题"));

        let en_text = format_personal_event_in("en", &ask_ev);
        assert!(en_text.contains("[Question · #24 微信推送]"));
        assert!(en_text.contains("2 questions total"));

        // Child issue Reviewing is marked `is_child_review` so NotifyGate quiets it.
        issue.parent = Some("i1".into());
        issue.stage.state = IssueStageKind::Reviewing;
        let child_review = personal_event_for_issue(&issue, Some("implemented"), 3_000, None).unwrap();
        assert!(child_review.is_child_review);
        assert!(!child_review.is_urgent());

        // Conflict & Interrupted
        issue.parent = None;
        issue.stage.state = IssueStageKind::Stuck;
        issue.stage.stuck = Some(StuckReason::Conflict);
        issue.conflict = Some(Conflict {
            base: "main".into(),
            files: vec!["a.rs".into(), "b.rs".into()],
        });
        let conflict_ev = personal_event_for_issue(&issue, None, 4_000, None).unwrap();
        let conflict_zh = format_personal_event_in("zh", &conflict_ev);
        assert!(conflict_zh.contains("【合并冲突 · #24 微信推送】"));
        assert!(conflict_zh.contains("a.rs, b.rs"));

        issue.stage.stuck = Some(StuckReason::Interrupted);
        issue.conflict = None;
        let int_ev = personal_event_for_issue(&issue, Some("process killed"), 5_000, None).unwrap();
        assert!(format_personal_event_in("zh", &int_ev).contains("【运行中断 · #24 微信推送】"));

        // Quiet worker produces no personal push.
        issue.stage.stuck = Some(StuckReason::Quiet);
        assert!(personal_event_for_issue(&issue, None, 6_000, None).is_none());
    }

    #[test]
    fn permission_push_formats_parses_and_reply_commands_parse_cleanly() {
        let perm_ev = PersonalEvent {
            dedupe_key: "perm:s1:req-9".into(),
            issue_id: None,
            issue_number: None,
            issue_title: None,
            session_id: Some("s1".into()),
            channel_id: None,
            is_child_review: false,
            at: 10_000,
            kind: PersonalEventKind::PermissionRequest {
                request_id: "req-9".into(),
                session_name: "Workspace".into(),
                tool: "shell".into(),
                summary: "Run cargo test".into(),
                input: Some("cargo test -p vibevalley-server".into()),
            },
        };
        assert!(perm_ev.is_urgent());
        let perm_msg_id = perm_ev.outbox_message_id();
        assert_eq!(perm_msg_id, "push:perm:s1:req-9");
        assert_eq!(
            parse_push_message_id(&perm_msg_id),
            Some(PushTarget::Permission {
                session_id: "s1",
                request_id: "req-9"
            })
        );
        let zh_perm = format_personal_event_in("zh", &perm_ev);
        assert!(zh_perm.contains("【请求授权 · Workspace】"));
        assert!(zh_perm.contains("cargo test -p vibevalley-server"));
        let en_perm = format_personal_event_in("en", &perm_ev);
        assert!(en_perm.contains("[Permission Request · Workspace]"));
        assert!(en_perm.contains("Reply allow to approve or deny to reject."));

        // Asking reply parsing
        assert_eq!(
            parse_issue_reply("asking", "  Yes, enable quiet hours  "),
            Ok(IssueReplyAction::Answer {
                text: "Yes, enable quiet hours".into()
            })
        );
        assert_eq!(parse_issue_reply("asking", "   "), Err(ReplyParseError::EmptyAnswer));

        // Reviewing reply parsing
        assert_eq!(parse_issue_reply("reviewing", "accept"), Ok(IssueReplyAction::Accept));
        assert_eq!(parse_issue_reply("reviewing", " OK! "), Ok(IssueReplyAction::Accept));
        assert_eq!(parse_issue_reply("reviewing", "通过。"), Ok(IssueReplyAction::Accept));
        assert_eq!(
            parse_issue_reply("reviewing", "reject: missing edge case tests"),
            Ok(IssueReplyAction::Reject {
                reason: "missing edge case tests".into()
            })
        );
        assert_eq!(
            parse_issue_reply("reviewing", "打回 缺少边界测试"),
            Ok(IssueReplyAction::Reject {
                reason: "缺少边界测试".into()
            })
        );
        assert_eq!(parse_issue_reply("reviewing", "reject"), Err(ReplyParseError::RejectNeedsReason));
        assert_eq!(parse_issue_reply("reviewing", "reject:   "), Err(ReplyParseError::RejectNeedsReason));
        assert_eq!(parse_issue_reply("reviewing", "maybe later"), Err(ReplyParseError::ReviewUnrecognized));
        assert_eq!(parse_issue_reply("reviewing", "retry"), Err(ReplyParseError::ReviewUnrecognized));

        // Failed / Interrupted reply parsing
        assert_eq!(parse_issue_reply("failed", "retry"), Ok(IssueReplyAction::Retry { words: None }));
        assert_eq!(
            parse_issue_reply("interrupted", "resume check git log first"),
            Ok(IssueReplyAction::Retry {
                words: Some("check git log first".into())
            })
        );
        assert_eq!(parse_issue_reply("failed", "重试"), Ok(IssueReplyAction::Retry { words: None }));
        assert_eq!(parse_issue_reply("interrupted", "accept"), Err(ReplyParseError::StuckUnrecognized));
        assert_eq!(parse_issue_reply("conflict", "retry"), Err(ReplyParseError::ConflictNeedsWorkbench));

        // Permission reply parsing
        assert_eq!(parse_permission_reply("allow"), Ok(PermissionReplyAction::AllowOnce));
        assert_eq!(parse_permission_reply("允许。"), Ok(PermissionReplyAction::AllowOnce));
        assert_eq!(parse_permission_reply("allow always"), Ok(PermissionReplyAction::AllowAlways));
        assert_eq!(parse_permission_reply("始终允许"), Ok(PermissionReplyAction::AllowAlways));
        assert_eq!(parse_permission_reply("deny"), Ok(PermissionReplyAction::Deny { reason: None }));
        assert_eq!(
            parse_permission_reply("deny: too risky"),
            Ok(PermissionReplyAction::Deny {
                reason: Some("too risky".into())
            })
        );
        assert_eq!(parse_permission_reply("maybe"), Err(ReplyParseError::PermissionUnrecognized));
    }
}
