//! Blocks to Markdown and back (`markdown.ts`): the format artifacts trade
//! with agents in, not how they are stored.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use vibevalley_protocol::{Block, BlockAttrs, BlockType, SpanMarks, TextSpan};

use crate::artifact::ops::ordered;
use crate::artifact::spans::{js_trim, normal_spans, plain, span, text_for, unmarked};

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

/// Normalized result of importing a `.md` file into an `ArtifactType::Outline` artifact.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportedOutline {
    pub title: String,
    pub markdown: String,
    pub blocks: Vec<MdBlock>,
}

static LOGSEQ_PROP_LINE: LazyLock<Regex> = LazyLock::new(|| re(r"^[a-zA-Z][a-zA-Z0-9_-]*::\s*(.*)$"));
static LOGSEQ_BLOCK_PROP_LINE: LazyLock<Regex> =
    LazyLock::new(|| re(r"^(?:id|collapsed|completed|deadline|scheduled|render|caption|source-anchor|comment)::\s*.*$"));
static LOGSEQ_MARKER_LINE: LazyLock<Regex> = LazyLock::new(|| re(r"^([-*+])\s+(TODO|DOING|DONE|NOW|LATER|WAITING|CANCELED)\s+(?:\[#([ABC])\]\s+)?(.*)$"));

fn title_from_filename(filename: &str) -> String {
    let base = filename.trim().replace('\\', "/");
    let name = base.rsplit('/').next().unwrap_or(&base).trim();
    let lower = name.to_ascii_lowercase();
    let stem = [".outline.md", ".doc.md", ".markdown", ".md"]
        .into_iter()
        .find_map(|ext| lower.ends_with(ext).then(|| &name[..name.len() - ext.len()]))
        .unwrap_or(name);
    stem.replace("__", "/").trim().to_string()
}

fn unquote_yaml(raw: &str) -> String {
    let s = raw.trim();
    if s.len() >= 2 && ((s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\''))) {
        s[1..s.len() - 1].trim().to_string()
    } else {
        s.to_string()
    }
}

/// Normalizes an imported Markdown file (standard Markdown, YAML frontmatter, or
/// Logseq-style outline Markdown) into a clean outline title, canonical Markdown,
/// and parsed `MdBlock` list.
pub fn import_outline_markdown(raw: &str, filename: Option<&str>, title: Option<&str>) -> ImportedOutline {
    let normalized_nl = raw.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized_nl.split('\n').collect();
    let mut i = 0;
    let mut meta_title: Option<String> = None;

    // Strip optional YAML frontmatter (`---` ... `---`).
    if lines.first().is_some_and(|l| l.trim() == "---") {
        let mut j = 1;
        while j < lines.len() && lines[j].trim() != "---" {
            if let Some((k, v)) = lines[j].split_once(':')
                && k.trim().eq_ignore_ascii_case("title")
            {
                let parsed = unquote_yaml(v);
                if !parsed.is_empty() {
                    meta_title = Some(parsed);
                }
            }
            j += 1;
        }
        if j < lines.len() && lines[j].trim() == "---" {
            i = j + 1;
            while i < lines.len() && blank(lines[i]) {
                i += 1;
            }
        }
    }

    // Strip leading Logseq page-level `key:: value` header lines.
    while i < lines.len() {
        let line = lines[i];
        if indent_of(line) == 0
            && !line.starts_with('\t')
            && let Some(caps) = LOGSEQ_PROP_LINE.captures(line)
        {
            if let Some((k, _)) = line.split_once("::")
                && k.trim().eq_ignore_ascii_case("title")
            {
                let v = group(&caps, 1).trim();
                if !v.is_empty() && meta_title.is_none() {
                    meta_title = Some(v.to_string());
                }
            }
            i += 1;
            continue;
        }
        break;
    }

    // Normalize indentation (tabs -> 2 spaces), drop Logseq block metadata lines,
    // and map Logseq task markers to standard Markdown checkboxes outside fenced code.
    let mut body_lines: Vec<String> = Vec::with_capacity(lines.len().saturating_sub(i));
    let mut in_code_fence = false;
    for raw_line in &lines[i..] {
        let expanded = raw_line.replace('\t', "  ");
        let spaces = indent_of(&expanded);
        let rest = &expanded[spaces..];
        if rest.starts_with("```") {
            in_code_fence = !in_code_fence;
            body_lines.push(expanded);
            continue;
        }
        if !in_code_fence {
            if spaces > 0 && LOGSEQ_BLOCK_PROP_LINE.is_match(rest) {
                continue;
            }
            if let Some(caps) = LOGSEQ_MARKER_LINE.captures(rest) {
                let bullet = group(&caps, 1);
                let marker = group(&caps, 2);
                let text = group(&caps, 4);
                let box_mark = if matches!(marker, "DONE" | "CANCELED") { "x" } else { " " };
                body_lines.push(format!("{}{bullet} [{box_mark}] {text}", " ".repeat(spaces)));
                continue;
            }
        }
        body_lines.push(expanded);
    }

    let markdown = body_lines.join("\n").trim_matches('\n').to_string();
    let blocks = blocks_of_markdown(&markdown);
    let h1_title = blocks
        .iter()
        .find(|b| b.r#type == BlockType::Heading && b.attrs.level == Some(1))
        .map(|b| plain(&b.text).trim().to_string())
        .filter(|s| !s.is_empty());

    let resolved_title = title
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or(meta_title)
        .or(h1_title)
        .or_else(|| filename.map(title_from_filename).filter(|s| !s.is_empty()))
        .unwrap_or_default();

    ImportedOutline {
        title: resolved_title,
        markdown,
        blocks,
    }
}

#[cfg(test)]
mod import_tests {
    use super::*;

    #[test]
    fn imports_standard_markdown_with_frontmatter_and_infers_title() {
        let raw = "---\ntitle: \"Release Notes\"\ntags: [release]\n---\n\n# Ignored H1\n- First item\n  - Nested bullet\n";
        let imported = import_outline_markdown(raw, Some("release-notes.md"), None);
        assert_eq!(imported.title, "Release Notes");
        assert_eq!(imported.blocks.len(), 3);
        assert_eq!(imported.blocks[0].r#type, BlockType::Heading);
        assert_eq!(imported.blocks[1].r#type, BlockType::Bulleted);
        assert_eq!(imported.blocks[2].depth, 1);
    }

    #[test]
    fn imports_logseq_outline_and_strips_block_props() {
        let raw =
            "title:: Weekly Plan\npara:: project\n\n- TODO [#A] Ship outline import\n  id:: 65012345-abcd\n  collapsed:: true\n\t- DONE Archive old notes\n";
        let imported = import_outline_markdown(raw, Some("01_Projects/weekly-plan.md"), None);
        assert_eq!(imported.title, "Weekly Plan");
        assert_eq!(imported.blocks.len(), 2);
        assert_eq!(imported.blocks[0].r#type, BlockType::Todo);
        assert_eq!(imported.blocks[0].attrs.checked, Some(false));
        assert_eq!(plain(&imported.blocks[0].text), "Ship outline import");
        assert_eq!(imported.blocks[1].r#type, BlockType::Todo);
        assert_eq!(imported.blocks[1].attrs.checked, Some(true));
        assert_eq!(imported.blocks[1].depth, 1);
        assert_eq!(plain(&imported.blocks[1].text), "Archive old notes");
    }

    #[test]
    fn explicit_title_overrides_frontmatter_h1_and_filename() {
        let imported = import_outline_markdown("# Heading\n- Point", Some("notes__draft.outline.md"), Some("Custom"));
        assert_eq!(imported.title, "Custom");
        let from_file = import_outline_markdown("- Point only", Some("notes__draft.outline.md"), None);
        assert_eq!(from_file.title, "notes/draft");
        let from_h1 = import_outline_markdown("# From Heading\n- Point", Some("fallback.md"), None);
        assert_eq!(from_h1.title, "From Heading");
    }
}
