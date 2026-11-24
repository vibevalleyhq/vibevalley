//! What the chat apps are sent: a farm message as plain text under a head
//! saying who speaks, cut to what each app takes, and a digest of what
//! waited.

use std::sync::LazyLock;

use regex::{Captures, Regex};
use vibevalley_core::rules::actor_role_of;
use vibevalley_i18n::t;
use vibevalley_protocol::{AgentRole, Channel, ChannelType, ChatMessage, MessageKind, Outcome};

/// More than this many waiting go out as one digest.
pub const DIGEST_OVER: usize = 3;

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
static PAIR_WORD: LazyLock<Regex> = LazyLock::new(|| re(r"^(?i:配对|pair)"));

fn plain_text(markdown: &str) -> String {
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

/// The byte index after at most `max` UTF-16 units of `s`.
fn within(s: &str, max: usize) -> usize {
    let mut units = 0;
    for (at, ch) in s.char_indices() {
        units += ch.len_utf16();
        if units > max {
            return at;
        }
    }
    s.len()
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
}
