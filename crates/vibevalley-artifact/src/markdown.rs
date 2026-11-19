//! Blocks to Markdown and back (`markdown.ts`): the format artifacts trade
//! with agents in, not how they are stored.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use vibevalley_protocol::{Block, BlockAttrs, BlockType, SpanMarks, TextSpan};

use crate::ops::ordered;
use crate::spans::{js_trim, normal_spans, plain, span, text_for, unmarked};

/// A block as Markdown says it: its place is its depth under the block
/// before it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct MdBlock {
    pub depth: usize,
    #[serde(rename = "type")]
    pub r#type: BlockType,
    pub attrs: BlockAttrs,
    pub text: Vec<TextSpan>,
}

fn is_list(t: BlockType) -> bool {
    matches!(t, BlockType::Bulleted | BlockType::Numbered | BlockType::Todo)
}

/// The live blocks, in artifact order.
pub fn markdown_of(blocks: &[Block]) -> String {
    let mut depth: HashMap<String, usize> = HashMap::new();
    let mut numbers: HashMap<String, i64> = HashMap::new();
    let mut out = String::new();
    let mut prev: Option<BlockType> = None;
    for blk in ordered(blocks) {
        let d = blk.parent_id.as_ref().and_then(|p| depth.get(p)).map_or(0, |pd| pd + 1);
        depth.insert(blk.id.clone(), d);
        let parent = blk.parent_id.clone().unwrap_or_default();
        if blk.r#type == BlockType::Numbered {
            *numbers.entry(parent.clone()).or_default() += 1;
        } else {
            numbers.remove(&parent);
        }
        if let Some(p) = prev {
            out.push_str(if is_list(p) && is_list(blk.r#type) { "\n" } else { "\n\n" });
        }
        let indent = "  ".repeat(d);
        let line = block_line(&blk, numbers.get(&parent).copied().unwrap_or(0));
        let lines: Vec<String> = line
            .split('\n')
            .map(|l| if l.is_empty() { String::new() } else { format!("{indent}{l}") })
            .collect();
        out.push_str(&lines.join("\n"));
        prev = Some(blk.r#type);
    }
    if out.is_empty() { out } else { out + "\n" }
}

fn block_line(b: &Block, number: i64) -> String {
    let text = inline_of(&b.text);
    match b.r#type {
        BlockType::Heading => {
            let level = b.attrs.level.map_or(1, |l| l.clamp(1, 3));
            format!("{} {text}", "#".repeat(level as usize))
        }
        BlockType::Bulleted => format!("- {text}"),
        BlockType::Numbered => format!("{number}. {text}"),
        BlockType::Todo => format!("{}{text}", if b.attrs.checked == Some(true) { "- [x] " } else { "- [ ] " }),
        BlockType::Quote => format!("> {}", text.replace('\n', "\n> ")),
        BlockType::Code => format!("```{}\n{}\n```", b.attrs.language.as_deref().unwrap_or(""), plain(&b.text)),
        BlockType::Divider => "---".into(),
        BlockType::Image => {
            let title = match (b.attrs.width, b.attrs.height) {
                (Some(w), Some(h)) => format!(" \"{w}x{h}\""),
                _ => String::new(),
            };
            format!(
                "![{}]({}{title})",
                escape(b.attrs.alt.as_deref().unwrap_or("")),
                b.attrs.src.as_deref().unwrap_or("")
            )
        }
        BlockType::IssueRef => format!("<!-- issue:{} -->", b.attrs.issue_id.as_deref().unwrap_or("")),
        BlockType::MemoryItem => format!("<!-- memory:{} --> {text}", b.attrs.memory_id.as_deref().unwrap_or("")),
        BlockType::Paragraph => text
            .split('\n')
            .map(|line| {
                if !line.is_empty() && (line.starts_with(' ') || classify(line).r#type != BlockType::Paragraph) {
                    format!("\\{line}")
                } else {
                    line.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

const SPECIALS: &str = "\\*_`~[]";

fn escape(t: &str) -> String {
    let mut out = String::with_capacity(t.len());
    for c in t.chars() {
        if SPECIALS.contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn wordy(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric())
}

fn inline_of(spans: &[TextSpan]) -> String {
    let all = normal_spans(spans);
    let mut out = String::new();
    for (i, s) in all.iter().enumerate() {
        let mut t = if s.marks.code == Some(true) { code_span(&s.t) } else { escape(&s.t) };
        if s.marks.italic == Some(true) {
            let prev = i.checked_sub(1).and_then(|j| all.get(j));
            let next = all.get(i + 1);
            let star = prev.is_some_and(|p| wordy(p.t.chars().last())) || next.is_some_and(|n| wordy(n.t.chars().next()));
            let mark = if star { "*" } else { "_" };
            t = format!("{mark}{t}{mark}");
        }
        if s.marks.bold == Some(true) {
            t = format!("**{t}**");
        }
        if s.marks.strike == Some(true) {
            t = format!("~~{t}~~");
        }
        if let Some(link) = &s.marks.link {
            t = format!("[{t}]({link})");
        }
        out.push_str(&t);
    }
    out
}

fn code_span(t: &str) -> String {
    if t.contains('`') { format!("`` {t} ``") } else { format!("`{t}`") }
}

fn re(s: &str) -> Regex {
    Regex::new(s).expect("a fixed pattern")
}

static HEADING: LazyLock<Regex> = LazyLock::new(|| re(r"(?s)^(#{1,3}) (.*)$"));
static TODO: LazyLock<Regex> = LazyLock::new(|| re(r"(?s)^[-*+] \[( |x|X)\] ?(.*)$"));
static BULLET: LazyLock<Regex> = LazyLock::new(|| re(r"(?s)^[-*+] (.*)$"));
static NUMBER: LazyLock<Regex> = LazyLock::new(|| re(r"(?s)^[0-9]+[.)] (.*)$"));
static DIVIDER: LazyLock<Regex> = LazyLock::new(|| re(r"^(-{3,}|\*{3,}|_{3,})$"));
static IMAGE: LazyLock<Regex> = LazyLock::new(|| re(r#"(?s)^!\[((?:\\.|[^\]])*)\]\(([^)\s]*)(?: "([0-9]+)x([0-9]+)")?\)$"#));
static ISSUE: LazyLock<Regex> = LazyLock::new(|| re(r"^<!-- issue:(\S+) -->$"));
static MEMORY: LazyLock<Regex> = LazyLock::new(|| re(r"(?s)^<!-- memory:(\S+) -->(?: (.*))?$"));
static FENCE: LazyLock<Regex> = LazyLock::new(|| re(r"^```(\S*)$"));
static QUOTE: LazyLock<Regex> = LazyLock::new(|| re(r"(?s)^> ?(.*)$"));

fn indent_of(s: &str) -> usize {
    s.len() - s.trim_start_matches(' ').len()
}

struct LineKind {
    r#type: BlockType,
    attrs: BlockAttrs,
    rest: String,
}

fn kind(t: BlockType, attrs: BlockAttrs, rest: &str) -> LineKind {
    LineKind {
        r#type: t,
        attrs,
        rest: rest.to_string(),
    }
}

fn group<'a>(c: &'a regex::Captures, i: usize) -> &'a str {
    c.get(i).map_or("", |m| m.as_str())
}

fn classify(line: &str) -> LineKind {
    let none = BlockAttrs::default;
    if let Some(m) = HEADING.captures(line) {
        let level = group(&m, 1).len() as i64;
        return kind(BlockType::Heading, BlockAttrs { level: Some(level), ..none() }, group(&m, 2));
    }
    if DIVIDER.is_match(line) {
        return kind(BlockType::Divider, none(), "");
    }
    if let Some(m) = TODO.captures(line) {
        return kind(
            BlockType::Todo,
            BlockAttrs {
                checked: Some(group(&m, 1) != " "),
                ..none()
            },
            group(&m, 2),
        );
    }
    if let Some(m) = BULLET.captures(line) {
        return kind(BlockType::Bulleted, none(), group(&m, 1));
    }
    if let Some(m) = NUMBER.captures(line) {
        return kind(BlockType::Numbered, none(), group(&m, 1));
    }
    if let Some(m) = FENCE.captures(line) {
        let lang = group(&m, 1);
        let attrs = if lang.is_empty() {
            none()
        } else {
            BlockAttrs {
                language: Some(lang.into()),
                ..none()
            }
        };
        return kind(BlockType::Code, attrs, "");
    }
    if let Some(m) = QUOTE.captures(line) {
        return kind(BlockType::Quote, none(), group(&m, 1));
    }
    if let Some(m) = IMAGE.captures(line) {
        let mut attrs = BlockAttrs {
            alt: Some(plain(&inline_spans(group(&m, 1)))),
            src: Some(group(&m, 2).into()),
            ..none()
        };
        if m.get(3).is_some() {
            attrs.width = group(&m, 3).parse().ok();
            attrs.height = group(&m, 4).parse().ok();
        }
        return kind(BlockType::Image, attrs, "");
    }
    if let Some(m) = ISSUE.captures(line) {
        return kind(
            BlockType::IssueRef,
            BlockAttrs {
                issue_id: Some(group(&m, 1).into()),
                ..none()
            },
            "",
        );
    }
    if let Some(m) = MEMORY.captures(line) {
        return kind(
            BlockType::MemoryItem,
            BlockAttrs {
                memory_id: Some(group(&m, 1).into()),
                ..none()
            },
            group(&m, 2),
        );
    }
    kind(BlockType::Paragraph, none(), line)
}

fn blank(s: &str) -> bool {
    js_trim(s).is_empty()
}

/// Reads Markdown into blocks, each with its depth under the block before.
pub fn blocks_of_markdown(md: &str) -> Vec<MdBlock> {
    let md = md.replace("\r\n", "\n");
    let lines: Vec<&str> = md.split('\n').collect();
    let line_at = |i: usize| lines.get(i).copied().unwrap_or("");
    let mut out = vec![];
    let mut open = 0;
    let mut i = 0;
    while i < lines.len() {
        let raw = lines[i];
        if blank(raw) {
            i += 1;
            continue;
        }
        let spaces = indent_of(raw);
        let depth = (spaces / 2).min(open);
        let line = &raw[spaces..];
        let strip = |l: &str| -> (String, bool) {
            if indent_of(l) < spaces {
                (l.trim_start_matches(' ').to_string(), false)
            } else {
                (l[spaces..].to_string(), true)
            }
        };
        let mut k = classify(line);
        match k.r#type {
            BlockType::Code => {
                let mut body = vec![];
                i += 1;
                while i < lines.len() {
                    let (l, _) = strip(line_at(i));
                    if l == "```" {
                        break;
                    }
                    body.push(l);
                    i += 1;
                }
                k.rest = body.join("\n");
            }
            BlockType::Quote => {
                let mut text = vec![k.rest.clone()];
                while i + 1 < lines.len() {
                    let next = line_at(i + 1);
                    let (l, ok) = strip(next);
                    let Some(m) = QUOTE.captures(&l) else { break };
                    if !ok || blank(next) {
                        break;
                    }
                    text.push(group(&m, 1).to_string());
                    i += 1;
                }
                k.rest = text.join("\n");
            }
            BlockType::Paragraph => {
                let mut text = vec![line.to_string()];
                while i + 1 < lines.len() && !blank(line_at(i + 1)) {
                    let (l, ok) = strip(line_at(i + 1));
                    if !ok || indent_of(&l) > 0 || classify(&l).r#type != BlockType::Paragraph {
                        break;
                    }
                    text.push(l);
                    i += 1;
                }
                k.rest = text.join("\n");
            }
            _ => {}
        }
        let text = if k.r#type == BlockType::Code {
            unmarked(&[span(k.rest.clone())])
        } else {
            text_for(k.r#type, &inline_spans(&k.rest))
        };
        out.push(MdBlock {
            depth,
            r#type: k.r#type,
            attrs: k.attrs,
            text,
        });
        open = depth + 1;
        i += 1;
    }
    out
}

/// Markdown's inline marks: **bold**, _italic_ or *italic*, `code`,
/// ~~strike~~, [text](url), and \ before any character to take it as is.
pub fn inline_spans(s: &str) -> Vec<TextSpan> {
    let chars: Vec<char> = s.chars().collect();
    normal_spans(&inline(&chars, &SpanMarks::default()))
}

fn with(m: &SpanMarks, f: impl FnOnce(&mut SpanMarks)) -> SpanMarks {
    let mut m = m.clone();
    f(&mut m);
    m
}

fn inline(s: &[char], m: &SpanMarks) -> Vec<TextSpan> {
    let mut out = vec![];
    let mut buf = String::new();
    let flush = |buf: &mut String, out: &mut Vec<TextSpan>| {
        if !buf.is_empty() {
            out.push(TextSpan {
                t: std::mem::take(buf),
                marks: m.clone(),
            });
        }
    };
    let mut i = 0;
    while i < s.len() {
        let c = s[i];
        if c == '\\' && i + 1 < s.len() {
            i += 1;
            buf.push(s[i]);
            i += 1;
            continue;
        } else if c == '`' {
            let fence = if i + 1 < s.len() && s[i + 1] == '`' { 2 } else { 1 };
            if let Some(j) = closing(s, i + fence, &"`".repeat(fence), false) {
                flush(&mut buf, &mut out);
                let mut body: String = s[i + fence..j].iter().collect();
                if fence == 2 {
                    if body.starts_with(' ') {
                        body.remove(0);
                    }
                    if body.ends_with(' ') {
                        body.pop();
                    }
                }
                out.push(TextSpan {
                    t: body,
                    marks: with(m, |m| m.code = Some(true)),
                });
                i = j + fence;
                continue;
            }
        } else if (c == '*' || c == '~') && i + 1 < s.len() && s[i + 1] == c {
            if let Some(j) = closing(s, i + 2, &format!("{c}{c}"), true) {
                flush(&mut buf, &mut out);
                let marks = if c == '*' {
                    with(m, |m| m.bold = Some(true))
                } else {
                    with(m, |m| m.strike = Some(true))
                };
                out.extend(inline(&s[i + 2..j], &marks));
                i = j + 2;
                continue;
            }
        } else if c == '_' && i > 0 && wordy(Some(s[i - 1])) {
            // snake_case
        } else if c == '_' || c == '*' {
            if let Some(j) = closing(s, i + 1, &c.to_string(), true)
                && (c == '*' || j + 1 >= s.len() || !wordy(Some(s[j + 1])))
            {
                flush(&mut buf, &mut out);
                out.extend(inline(&s[i + 1..j], &with(m, |m| m.italic = Some(true))));
                i = j + 1;
                continue;
            }
        } else if c == '['
            && let Some(j) = closing(s, i + 1, "]", true)
            && j + 1 < s.len()
            && s[j + 1] == '('
            && let Some(k) = closing(s, j + 2, ")", false)
        {
            flush(&mut buf, &mut out);
            let link: String = s[j + 2..k].iter().collect();
            out.extend(inline(&s[i + 1..j], &with(m, |m| m.link = Some(link))));
            i = k + 1;
            continue;
        }
        buf.push(c);
        i += 1;
    }
    flush(&mut buf, &mut out);
    out
}

fn closing(s: &[char], from: usize, mark: &str, non_empty: bool) -> Option<usize> {
    let m: Vec<char> = mark.chars().collect();
    let start = if non_empty { from + 1 } else { from };
    let mut i = from;
    while i < s.len() {
        if m[0] != '`' {
            if s[i] == '\\' {
                i += 2;
                continue;
            }
            if s[i] == '`'
                && let Some(j) = closing(s, i + 1, "`", false)
            {
                i = j + 1;
                continue;
            }
        }
        if i >= start && i + m.len() <= s.len() && s[i..i + m.len()] == m[..] {
            return Some(i);
        }
        i += 1;
    }
    None
}
