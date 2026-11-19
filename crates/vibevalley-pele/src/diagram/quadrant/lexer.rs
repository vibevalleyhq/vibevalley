use crate::diagram::common::word_at;
use crate::util::chars::{is_digit, is_letter, is_line_end, is_space, is_word};

use super::tokens::QuadrantToken;

pub struct QuadrantTokens<'a> {
    pub types: Vec<QuadrantToken>,
    pub texts: Vec<&'a str>,
    pub starts: Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LexState {
    Initial,
    Title,
    AccTitle,
    AccDescr,
    AccDescrMultiline,
    String,
    MdString,
    ClassName,
    PointStart,
    PointX,
    PointY,
}

impl LexState {
    const fn at_end(self) -> Option<QuadrantToken> {
        match self {
            Self::Initial => Some(QuadrantToken::Eof),
            Self::Title => Some(QuadrantToken::TitleValue),
            Self::AccTitle => Some(QuadrantToken::AccTitleValue),
            Self::AccDescr => Some(QuadrantToken::AccDescrValue),
            Self::AccDescrMultiline => Some(QuadrantToken::AccDescrMultilineValue),
            Self::String => Some(QuadrantToken::Str),
            Self::MdString | Self::ClassName | Self::PointStart | Self::PointX | Self::PointY => None,
        }
    }
}

fn single_token(b: u8) -> Option<QuadrantToken> {
    match b {
        b':' => Some(QuadrantToken::Colon),
        b'+' => Some(QuadrantToken::Plus),
        b',' => Some(QuadrantToken::Comma),
        b'=' => Some(QuadrantToken::Equals),
        b'*' => Some(QuadrantToken::Mult),
        b'#' => Some(QuadrantToken::Brkt),
        b'_' => Some(QuadrantToken::Underscore),
        b'.' => Some(QuadrantToken::Dot),
        b'&' => Some(QuadrantToken::Amp),
        b'-' => Some(QuadrantToken::Minus),
        b' ' | b'\t' | 0x0b | 0x0c => Some(QuadrantToken::Space),
        b';' => Some(QuadrantToken::Semi),
        b'!' | b'$' | b'%' | b'\'' | b'`' | b'?' | b'\\' | b'/' => Some(QuadrantToken::Punctuation),
        _ => None,
    }
}

fn byte_at(bytes: &[u8], i: usize) -> u8 {
    bytes.get(i).copied().unwrap_or(0)
}

fn line_end(src: &str, q: usize) -> usize {
    src[q..].find('\n').map_or(src.len(), |rel| q + rel)
}

fn run_ascii_spaces(bytes: &[u8], mut q: usize) -> usize {
    while q < bytes.len() && bytes[q] == b' ' {
        q += 1;
    }
    q
}

fn run_spaces(src: &str, mut q: usize) -> usize {
    let bytes = src.as_bytes();
    while q < bytes.len() {
        let b = bytes[q];
        if b < 128 {
            if is_space(b as u32) {
                q += 1;
            } else {
                break;
            }
        } else {
            let ch = src[q..].chars().next().unwrap();
            if is_space(ch as u32) {
                q += ch.len_utf8();
            } else {
                break;
            }
        }
    }
    q
}

fn is_space_at(src: &str, at: usize) -> bool {
    let bytes = src.as_bytes();
    if at >= bytes.len() {
        return false;
    }
    let b = bytes[at];
    if b < 128 {
        is_space(b as u32)
    } else {
        src[at..].chars().next().is_some_and(|ch| is_space(ch as u32))
    }
}

/// Mermaid's `(1)|(0(.\d+)?)`, where the dot is any character within a line.
fn scan_coordinate(src: &str, q: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let c = byte_at(bytes, q);
    if c == b'1' {
        return Some(q + 1);
    }
    if c != b'0' {
        return None;
    }
    let mut e = q + 1;
    if e < bytes.len()
        && let Some(ch) = src[e..].chars().next()
        && !is_line_end(ch as u32)
    {
        let after_dot = e + ch.len_utf8();
        if is_digit(byte_at(bytes, after_dot) as u32) {
            e = after_dot + 1;
            while e < bytes.len() && is_digit(bytes[e] as u32) {
                e += 1;
            }
        }
    }
    Some(e)
}

pub fn tokenize(src: &str) -> QuadrantTokens<'_> {
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut types = Vec::new();
    let mut texts = Vec::new();
    let mut starts = Vec::new();
    let mut stack: Vec<LexState> = Vec::new();
    let mut state = LexState::Initial;
    let mut p = 0usize;

    let mut space_from = 0usize;
    let mut space_to = 0usize;
    let mut dash_from = 0usize;
    let mut dash_to = 0usize;
    let mut ws_from = 0usize;
    let mut ws_to = 0usize;
    let mut gap_from = 0usize;
    let mut gap_to = 0usize;

    macro_rules! emit {
        ($tok:expr, $s:expr, $e:expr) => {{
            types.push($tok);
            texts.push(&src[$s..$e]);
            starts.push($s);
            p = $e;
        }};
    }
    macro_rules! push {
        ($s:expr) => {{
            stack.push(state);
            state = $s;
        }};
    }
    macro_rules! pop {
        () => {{
            if let Some(prev) = stack.pop() {
                state = prev;
            }
        }};
    }

    while p < n {
        let c = bytes[p];
        let next = byte_at(bytes, p + 1);

        match state {
            LexState::Initial => {}
            LexState::Title | LexState::AccTitle | LexState::AccDescr => {
                let e = line_end(src, p);
                emit!(state.at_end().unwrap(), p, e);
                pop!();
                continue;
            }
            LexState::AccDescrMultiline => {
                if c == b'}' {
                    p += 1;
                    pop!();
                } else {
                    let e = src[p..].find('}').map_or(n, |rel| p + rel);
                    emit!(QuadrantToken::AccDescrMultilineValue, p, e);
                }
                continue;
            }
            LexState::String => {
                if c == b'"' {
                    p += 1;
                    pop!();
                } else {
                    let e = src[p..].find('"').map_or(n, |rel| p + rel);
                    emit!(QuadrantToken::Str, p, e);
                }
                continue;
            }
            LexState::MdString => {
                if c == b'`' && next == b'"' {
                    p += 2;
                    pop!();
                    continue;
                }
                if c != b'`' && c != b'"' {
                    let mut e = p + 1;
                    while e < n && bytes[e] != b'`' && bytes[e] != b'"' {
                        e += 1;
                    }
                    emit!(QuadrantToken::MdStr, p, e);
                    continue;
                }
                break;
            }
            LexState::ClassName => {
                if is_word(c as u32) {
                    let mut e = p + 1;
                    while e < n && is_word(bytes[e] as u32) {
                        e += 1;
                    }
                    emit!(QuadrantToken::ClassName, p, e);
                    pop!();
                    continue;
                }
                break;
            }
            LexState::PointStart => {
                if let Some(e) = scan_coordinate(src, p) {
                    emit!(QuadrantToken::PointX, p, e);
                    push!(LexState::PointX);
                    continue;
                }
                let k = run_spaces(src, p);
                if byte_at(bytes, k) == b']' {
                    p = run_ascii_spaces(bytes, k + 1);
                    pop!();
                    continue;
                }
                break;
            }
            LexState::PointX => {
                let k = run_spaces(src, p);
                if byte_at(bytes, k) == b',' {
                    p = run_spaces(src, k + 1);
                    state = LexState::PointY;
                    continue;
                }
                break;
            }
            LexState::PointY => {
                if let Some(e) = scan_coordinate(src, p) {
                    emit!(QuadrantToken::PointY, p, e);
                    pop!();
                    continue;
                }
                break;
            }
        }

        if c == b'%' && next == b'%' {
            p = line_end(src, p + 2);
            continue;
        }
        if c == b'\n' || c == b'\r' {
            let mut e = p + 1;
            while e < n && matches!(bytes[e], b'\n' | b'\r') {
                e += 1;
            }
            emit!(QuadrantToken::Newline, p, e);
            continue;
        }

        let lower = c | 32;
        if lower == b't' && word_at(src, p, "title") && !is_word(byte_at(bytes, p + 5) as u32) {
            emit!(QuadrantToken::Title, p, p + 5);
            push!(LexState::Title);
            continue;
        }
        if lower == b'a' && word_at(src, p, "acc") {
            let descr = word_at(src, p + 3, "descr");
            if descr || word_at(src, p + 3, "title") {
                let k = run_spaces(src, p + 8);
                let d = byte_at(bytes, k);
                if d == b':' {
                    let e = run_spaces(src, k + 1);
                    emit!(if descr { QuadrantToken::AccDescr } else { QuadrantToken::AccTitle }, p, e);
                    push!(if descr { LexState::AccDescr } else { LexState::AccTitle });
                    continue;
                }
                if d == b'{' && descr {
                    p = run_spaces(src, k + 1);
                    push!(LexState::AccDescrMultiline);
                    continue;
                }
            }
        }

        let mut j = p;
        if c == b' ' {
            if p < space_from || p >= space_to {
                space_from = p;
                space_to = run_ascii_spaces(bytes, p);
            }
            j = space_to;
        }
        let d = byte_at(bytes, j);
        let dl = d | 32;
        let mut kw_tok: Option<(QuadrantToken, usize)> = None;
        if dl == b'x' && word_at(src, j, "x-axis") {
            kw_tok = Some((QuadrantToken::XAxis, j + 6));
        } else if dl == b'y' && word_at(src, j, "y-axis") {
            kw_tok = Some((QuadrantToken::YAxis, j + 6));
        } else if d == b'-' {
            if j < dash_from || j >= dash_to {
                dash_from = j;
                dash_to = j;
                while dash_to < n && bytes[dash_to] == b'-' {
                    dash_to += 1;
                }
            }
            if dash_to - j >= 2 && byte_at(bytes, dash_to) == b'>' {
                kw_tok = Some((QuadrantToken::Delimiter, dash_to + 1));
            }
        } else if dl == b'q' && word_at(src, j, "quadrant") {
            let q = byte_at(bytes, j + 9);
            if byte_at(bytes, j + 8) == b'-' && (b'1'..=b'4').contains(&q) {
                let tok = match q {
                    b'1' => QuadrantToken::Quadrant1,
                    b'2' => QuadrantToken::Quadrant2,
                    b'3' => QuadrantToken::Quadrant3,
                    _ => QuadrantToken::Quadrant4,
                };
                kw_tok = Some((tok, j + 10));
            } else if word_at(src, j + 8, "chart") {
                kw_tok = Some((QuadrantToken::Quadrant, j + 13));
            }
        }
        if let Some((tok, end)) = kw_tok {
            emit!(tok, p, run_ascii_spaces(bytes, end));
            continue;
        }

        if lower == b'c' && word_at(src, p, "classdef") && !is_word(byte_at(bytes, p + 8) as u32) {
            emit!(QuadrantToken::ClassDef, p, p + 8);
            continue;
        }
        if c == b'"' {
            if next == b'`' {
                p += 2;
                push!(LexState::MdString);
            } else {
                p += 1;
                push!(LexState::String);
            }
            continue;
        }
        if c == b':' && next == b':' && byte_at(bytes, p + 2) == b':' {
            p += 3;
            push!(LexState::ClassName);
            continue;
        }
        if c == b':' || is_space_at(src, p) {
            let k = if c != b':' {
                if p < ws_from || p >= ws_to {
                    ws_from = p;
                    ws_to = run_spaces(src, p);
                }
                ws_to
            } else {
                p
            };
            if byte_at(bytes, k) == b':' {
                if k + 1 < gap_from || k + 1 >= gap_to {
                    gap_from = k + 1;
                    gap_to = run_spaces(src, k + 1);
                }
                if byte_at(bytes, gap_to) == b'[' {
                    let e = run_spaces(src, gap_to + 1);
                    emit!(QuadrantToken::PointStart, p, e);
                    push!(LexState::PointStart);
                    continue;
                }
            }
        }

        if is_letter(c as u32) {
            let mut e = p + 1;
            while e < n && is_letter(bytes[e] as u32) {
                e += 1;
            }
            emit!(QuadrantToken::Alpha, p, e);
            continue;
        }
        if c >= 128 {
            let mut e = p + 1;
            while e < n && bytes[e] >= 128 {
                e += 1;
            }
            emit!(QuadrantToken::UnicodeText, p, e);
            continue;
        }
        if is_digit(c as u32) {
            let mut e = p + 1;
            while e < n && is_digit(bytes[e] as u32) {
                e += 1;
            }
            emit!(QuadrantToken::Num, p, e);
            continue;
        }
        if let Some(tok) = single_token(c) {
            emit!(tok, p, p + 1);
            continue;
        }
        break;
    }

    if p < n {
        types.push(QuadrantToken::Error);
        texts.push("");
        starts.push(p);
        return QuadrantTokens { types, texts, starts };
    }
    if let Some(end_tok) = state.at_end() {
        types.push(end_tok);
        texts.push("");
        starts.push(n);
    }
    types.push(QuadrantToken::End);
    texts.push("");
    starts.push(n);
    QuadrantTokens { types, texts, starts }
}
