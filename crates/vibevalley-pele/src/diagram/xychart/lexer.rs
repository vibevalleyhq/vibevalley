use crate::diagram::common::word_at;
use crate::util::chars::{is_digit, is_letter, is_space, is_word};

use super::tokens::XyToken;

pub struct XyTokens<'a> {
    pub types: Vec<XyToken>,
    pub texts: Vec<&'a str>,
    pub starts: Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LexState {
    Initial,
    AxisData,
    AxisBandData,
    Data,
    DataInner,
    String,
    AccTitle,
    AccDescr,
    AccDescrMultiline,
}

impl LexState {
    const fn at_end(self) -> XyToken {
        match self {
            Self::Initial | Self::AxisData | Self::AxisBandData | Self::Data | Self::DataInner => XyToken::Eof,
            Self::String => XyToken::Str,
            Self::AccTitle => XyToken::AccTitleValue,
            Self::AccDescr => XyToken::AccDescrValue,
            Self::AccDescrMultiline => XyToken::AccDescrMultilineValue,
        }
    }
}

// Mermaid's grammar means to open a markdown string at `"` followed by a backtick,
// but its quoting turns the rule into one matching this literal text and popping state.
const BROKEN_RULE: &str =
    "`)                                    { this.pushstate(md_string); }\n<md_string>(?:(?!`\").)+                  { return md_str; }\n<md_string>(?:`";

fn single_token(b: u8) -> Option<XyToken> {
    match b {
        b':' => Some(XyToken::Colon),
        b'+' => Some(XyToken::Plus),
        b',' => Some(XyToken::Comma),
        b'=' => Some(XyToken::Equals),
        b'*' => Some(XyToken::Mult),
        b'#' => Some(XyToken::Brkt),
        b'_' => Some(XyToken::Underscore),
        b'.' => Some(XyToken::Dot),
        b'&' => Some(XyToken::Amp),
        b'-' => Some(XyToken::Minus),
        b';' => Some(XyToken::Semi),
        _ => None,
    }
}

fn byte_at(bytes: &[u8], i: usize) -> u8 {
    bytes.get(i).copied().unwrap_or(0)
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

fn run_digits(bytes: &[u8], mut q: usize) -> usize {
    while q < bytes.len() && is_digit(bytes[q] as u32) {
        q += 1;
    }
    q
}

fn line_end(src: &str, q: usize) -> usize {
    src[q..].find('\n').map_or(src.len(), |rel| q + rel)
}

pub fn tokenize(src: &str) -> XyTokens<'_> {
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut types = Vec::new();
    let mut texts = Vec::new();
    let mut starts = Vec::new();
    let mut stack: Vec<LexState> = Vec::new();
    let mut state = LexState::Initial;
    let mut p = 0usize;

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

    let keyword = |at: usize, word: &str| -> bool { word_at(src, at, word) && !is_word(byte_at(bytes, at + word.len()) as u32) };

    while p < n {
        let c = bytes[p];

        if state == LexState::String {
            if c == b'"' {
                p += 1;
                pop!();
            } else {
                let e = src[p..].find('"').map_or(n, |rel| p + rel);
                emit!(XyToken::Str, p, e);
            }
            continue;
        }
        if state == LexState::AccTitle || state == LexState::AccDescr {
            let e = line_end(src, p);
            emit!(state.at_end(), p, e);
            pop!();
            continue;
        }
        if state == LexState::AccDescrMultiline {
            if c == b'}' {
                p += 1;
                pop!();
            } else {
                let e = src[p..].find('}').map_or(n, |rel| p + rel);
                emit!(XyToken::AccDescrMultilineValue, p, e);
            }
            continue;
        }

        let next = byte_at(bytes, p + 1);
        if c == b'%' && next == b'%' {
            p = line_end(src, p + 2);
            continue;
        }
        if c == b'\n' || c == b'\r' {
            if matches!(state, LexState::AxisData | LexState::Data) && (c == b'\n' || next == b'\n') {
                let e = if c == b'\n' { p + 1 } else { p + 2 };
                emit!(XyToken::Newline, p, e);
                pop!();
                continue;
            }
            let mut e = p + 1;
            while e < n && matches!(bytes[e], b'\n' | b'\r') {
                e += 1;
            }
            emit!(XyToken::Newline, p, e);
            continue;
        }

        match c | 32 {
            b't' if keyword(p, "title") => {
                emit!(XyToken::Title, p, p + 5);
                continue;
            }
            b'a' if word_at(src, p, "acc") => {
                let descr = word_at(src, p + 3, "descr");
                if descr || word_at(src, p + 3, "title") {
                    let k = run_spaces(src, p + 8);
                    let d = byte_at(bytes, k);
                    if d == b':' {
                        let e = run_spaces(src, k + 1);
                        emit!(if descr { XyToken::AccDescr } else { XyToken::AccTitle }, p, e);
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
            b'x' => {
                if keyword(p, "xychart-beta") {
                    emit!(XyToken::XyChart, p, p + 12);
                    continue;
                }
                if keyword(p, "xychart") {
                    emit!(XyToken::XyChart, p, p + 7);
                    continue;
                }
                if keyword(p, "x-axis") {
                    emit!(XyToken::XAxis, p, p + 6);
                    push!(LexState::AxisData);
                    continue;
                }
            }
            b'y' if keyword(p, "y-axis") => {
                emit!(XyToken::YAxis, p, p + 6);
                push!(LexState::AxisData);
                continue;
            }
            b'v' if word_at(src, p, "vertical") => {
                emit!(XyToken::ChartOrientation, p, p + 8);
                continue;
            }
            b'h' if word_at(src, p, "horizontal") => {
                emit!(XyToken::ChartOrientation, p, p + 10);
                continue;
            }
            b'l' if keyword(p, "line") => {
                emit!(XyToken::Line, p, p + 4);
                push!(LexState::Data);
                continue;
            }
            b'b' if keyword(p, "bar") => {
                emit!(XyToken::Bar, p, p + 3);
                push!(LexState::Data);
                continue;
            }
            _ => {}
        }

        if c == b'[' {
            if state == LexState::AxisData {
                push!(LexState::AxisBandData);
            } else if state == LexState::Data {
                push!(LexState::DataInner);
            }
            emit!(XyToken::SquareBracesStart, p, p + 1);
            continue;
        }
        if c == b']' {
            if matches!(state, LexState::DataInner | LexState::AxisBandData) {
                pop!();
            }
            emit!(XyToken::SquareBracesEnd, p, p + 1);
            continue;
        }
        if state == LexState::AxisData && c == b'-' && next == b'-' && byte_at(bytes, p + 2) == b'>' {
            emit!(XyToken::ArrowDelimiter, p, p + 3);
            continue;
        }
        if matches!(state, LexState::AxisData | LexState::DataInner) {
            let q = if c == b'+' || c == b'-' { p + 1 } else { p };
            let d = byte_at(bytes, q);
            let mut end = None;
            if is_digit(d as u32) {
                let mut e = run_digits(bytes, q + 1);
                if byte_at(bytes, e) == b'.' && is_digit(byte_at(bytes, e + 1) as u32) {
                    e = run_digits(bytes, e + 2);
                }
                end = Some(e);
            } else if d == b'.' && is_digit(byte_at(bytes, q + 1) as u32) {
                end = Some(run_digits(bytes, q + 2));
            }
            if let Some(e) = end {
                emit!(XyToken::NumberWithDecimal, p, e);
                continue;
            }
        }
        if c == b'`' && word_at(src, p, BROKEN_RULE) {
            p += BROKEN_RULE.len();
            pop!();
            continue;
        }
        if c == b'"' {
            p += 1;
            push!(LexState::String);
            continue;
        }
        if is_letter(c as u32) {
            let mut e = p + 1;
            while e < n && is_letter(bytes[e] as u32) {
                e += 1;
            }
            emit!(XyToken::Alpha, p, e);
            continue;
        }
        if is_digit(c as u32) {
            let e = run_digits(bytes, p + 1);
            emit!(XyToken::Num, p, e);
            continue;
        }
        if c < 128 {
            if is_space(c as u32) {
                p = run_spaces(src, p + 1);
                continue;
            }
            if let Some(tok) = single_token(c) {
                emit!(tok, p, p + 1);
                continue;
            }
        } else if let Some(ch) = src[p..].chars().next()
            && is_space(ch as u32)
        {
            p = run_spaces(src, p + ch.len_utf8());
            continue;
        }
        break;
    }

    if p < n {
        types.push(XyToken::Error);
        texts.push("");
        starts.push(p);
        return XyTokens { types, texts, starts };
    }
    types.push(state.at_end());
    texts.push("");
    starts.push(n);
    types.push(XyToken::End);
    texts.push("");
    starts.push(n);
    XyTokens { types, texts, starts }
}
