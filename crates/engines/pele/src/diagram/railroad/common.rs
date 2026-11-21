use crate::diagram::common::{scan_directive, scan_single_line_comment, scan_yaml_block};
use crate::util::chars::{is_space_char, is_word};

use super::types::{RailroadNode, RailroadRule};

#[derive(Debug, Clone, Default)]
pub struct ParsedGrammar {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub rules: Vec<RailroadRule>,
}

/// Scans `accTitle[\t ]*:(?:[^\n\r]*?(?=%%)|[^\n\r]*)` without leading whitespace.
pub fn scan_rr_acc_title(src: &str, at: usize) -> Option<usize> {
    if !src[at..].starts_with("accTitle") {
        return None;
    }
    let bytes = src.as_bytes();
    let mut p = at + 8;
    while p < bytes.len() && matches!(bytes[p], b' ' | b'\t') {
        p += 1;
    }
    if bytes.get(p) != Some(&b':') {
        return None;
    }
    p += 1;
    while p < bytes.len() && !matches!(bytes[p], b'\n' | b'\r') {
        if bytes[p] == b'%' && bytes.get(p + 1) == Some(&b'%') {
            break;
        }
        p += 1;
    }
    Some(p)
}

/// Scans `accDescr(?:[\t ]*:...| \s*{...})` without leading whitespace, memoizing unclosed `{`.
pub fn scan_rr_acc_descr(src: &str, at: usize, unclosed_at: &mut usize) -> Option<usize> {
    if !src[at..].starts_with("accDescr") {
        return None;
    }
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut p = at + 8;
    while p < n && matches!(bytes[p], b' ' | b'\t') {
        p += 1;
    }
    if bytes.get(p) == Some(&b':') {
        p += 1;
        while p < n && !matches!(bytes[p], b'\n' | b'\r') {
            if bytes[p] == b'%' && bytes.get(p + 1) == Some(&b'%') {
                break;
            }
            p += 1;
        }
        return Some(p);
    }
    while p < n {
        let ch = src[p..].chars().next().unwrap();
        if is_space_char(ch) {
            p += ch.len_utf8();
        } else {
            break;
        }
    }
    if bytes.get(p) != Some(&b'{') || p >= *unclosed_at {
        return None;
    }
    match src[p + 1..].find('}') {
        Some(rel) => Some(p + 1 + rel + 1),
        None => {
            *unclosed_at = p;
            None
        }
    }
}

/// Scans `title(?:[\t ][^\n\r]*?(?=%%)|[\t ][^\n\r]*|(?!rest))` without leading whitespace.
pub fn scan_rr_title(src: &str, at: usize, allow_underscore: bool) -> Option<usize> {
    if !src[at..].starts_with("title") {
        return None;
    }
    let bytes = src.as_bytes();
    let mut p = at + 5;
    if matches!(bytes.get(p), Some(b' ' | b'\t')) {
        p += 1;
        while p < bytes.len() && !matches!(bytes[p], b'\n' | b'\r') {
            if bytes[p] == b'%' && bytes.get(p + 1) == Some(&b'%') {
                break;
            }
            p += 1;
        }
        return Some(p);
    }
    let continues_name = bytes.get(p).is_some_and(|&b| {
        if allow_underscore {
            is_word(b as u32) || b == b'-'
        } else {
            b.is_ascii_alphanumeric() || b == b'-'
        }
    });
    if continues_name { None } else { Some(p) }
}

/// Scans `/[A-Z_a-z][\w-]*/y`.
pub fn scan_rr_id(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let first = *bytes.get(at)?;
    if !(first.is_ascii_alphabetic() || first == b'_') {
        return None;
    }
    let mut p = at + 1;
    while p < bytes.len() && (is_word(bytes[p] as u32) || bytes[p] == b'-') {
        p += 1;
    }
    Some(p)
}

/// Scans `/[\t \r\n]+/y`.
pub fn scan_rr_whitespace(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut p = at;
    while p < bytes.len() && matches!(bytes[p], b'\t' | b' ' | b'\r' | b'\n') {
        p += 1;
    }
    (p > at).then_some(p)
}

/// Scans `/* ... */`, setting `dead` if an opener has no closer.
pub fn scan_block_comment(src: &str, at: usize, dead: &mut bool) -> Option<usize> {
    if *dead || !src[at..].starts_with("/*") {
        return None;
    }
    match src[at + 2..].find("*/") {
        Some(rel) => Some(at + 2 + rel + 2),
        None => {
            *dead = true;
            None
        }
    }
}

/// Tries the 4 standard railroad hidden tokens: whitespace, YAML, directive, `%%` comment.
pub fn scan_rr_hidden(src: &str, at: usize, dead_yaml: &mut bool, dead_dir: &mut bool) -> Option<usize> {
    let b = src.as_bytes()[at];
    if matches!(b, b'\t' | b' ' | b'\r' | b'\n')
        && let Some(end) = scan_rr_whitespace(src, at)
    {
        return Some(end);
    }
    if b == b'-'
        && let Some(end) = scan_yaml_block(src, at, dead_yaml)
    {
        return Some(end);
    }
    if matches!(b, b'\t' | b' ' | b'%') {
        if let Some(end) = scan_directive(src, at, dead_dir) {
            return Some(end);
        }
        if let Some(end) = scan_single_line_comment(src, at) {
            return Some(end);
        }
    }
    None
}

/// Railroad value converter unescaping (`\n`, `\r`, `\t`, otherwise literal char).
pub fn unescape(text: &str) -> String {
    if text.len() < 2 {
        return String::new();
    }
    let inner = &text[1..text.len() - 1];
    if !inner.contains('\\') {
        return inner.to_string();
    }
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(next) = chars.next() {
                match next {
                    'n' => out.push('\n'),
                    'r' => out.push('\r'),
                    't' => out.push('\t'),
                    other => out.push(other),
                }
            } else {
                out.push('\\');
            }
        } else {
            out.push(c);
        }
    }
    out
}

pub fn unquote_title(raw: &str, unescape_quotes: bool) -> String {
    let bytes = raw.as_bytes();
    if bytes.len() >= 2 && matches!(bytes[0], b'"' | b'\'') && bytes[bytes.len() - 1] == bytes[0] {
        if unescape_quotes { unescape(raw) } else { raw[1..raw.len() - 1].to_string() }
    } else {
        raw.to_string()
    }
}

pub fn terminal(value: String) -> RailroadNode {
    RailroadNode::Terminal(value)
}

pub fn nonterminal(name: String) -> RailroadNode {
    RailroadNode::NonTerminal(name)
}

pub fn special(text: String) -> RailroadNode {
    RailroadNode::Special(text)
}

pub fn optional(element: RailroadNode) -> RailroadNode {
    RailroadNode::Optional(Box::new(element))
}

pub fn repetition(element: RailroadNode, min: f64, max: f64) -> RailroadNode {
    RailroadNode::Repetition {
        element: Box::new(element),
        min,
        max,
    }
}

pub fn sequence(mut elements: Vec<RailroadNode>) -> RailroadNode {
    if elements.len() == 1 {
        elements.pop().unwrap()
    } else {
        RailroadNode::Sequence(elements)
    }
}

pub fn choice(mut alternatives: Vec<RailroadNode>) -> RailroadNode {
    if alternatives.len() == 1 {
        alternatives.pop().unwrap()
    } else {
        RailroadNode::Choice(alternatives)
    }
}
