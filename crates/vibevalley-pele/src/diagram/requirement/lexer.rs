use crate::util::chars::{is_line_end, is_space, is_space_char, is_word};

use super::tokens::{ReqToken, lookup_keyword};

pub struct Tokens {
    pub types: Vec<ReqToken>,
    pub texts: Vec<String>,
    pub starts: Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LexState {
    Initial,
    StringLit,
    Style,
    AccTitle,
    AccDescr,
    AccDescrMultiline,
}

const LONGEST_KEYWORD: usize = 22;

fn is_stop(b: u8) -> bool {
    matches!(b, b':' | b',' | b'\r' | b'\n' | b'{' | b'<' | b'>' | b'-' | b'=')
}

fn match_ci_prefix(s: &str, prefix: &[u8]) -> bool {
    s.len() >= prefix.len() && s.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix)
}

fn scan_acc_prefix(src: &str, at: usize, word: &[u8], delim: u8) -> Option<usize> {
    if !match_ci_prefix(&src[at..], word) {
        return None;
    }
    let mut q = at + word.len();
    while q < src.len() {
        let ch = src[q..].chars().next()?;
        if is_space_char(ch) {
            q += ch.len_utf8();
        } else {
            break;
        }
    }
    if src.as_bytes().get(q) != Some(&delim) {
        return None;
    }
    q += 1;
    while q < src.len() {
        let ch = src[q..].chars().next()?;
        if is_space_char(ch) {
            q += ch.len_utf8();
        } else {
            break;
        }
    }
    Some(q)
}

fn scan_directions(src: &str) -> ([Vec<usize>; 4], [Vec<usize>; 4], bool) {
    let mut dir_starts: [Vec<usize>; 4] = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
    let mut dir_ends: [Vec<usize>; 4] = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
    let mut any_dir = false;
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut pos = 0usize;
    while pos + 12 <= n {
        if (bytes[pos] | 32) == b'd' && match_ci_prefix(&src[pos..], b"direction") {
            let mut q = pos + 9;
            let sp_start = q;
            while q < n {
                let ch = src[q..].chars().next().unwrap();
                if is_space_char(ch) {
                    q += ch.len_utf8();
                } else {
                    break;
                }
            }
            if q > sp_start && q + 2 <= n {
                let kind = if match_ci_prefix(&src[q..], b"tb") {
                    Some(0)
                } else if match_ci_prefix(&src[q..], b"bt") {
                    Some(1)
                } else if match_ci_prefix(&src[q..], b"rl") {
                    Some(2)
                } else if match_ci_prefix(&src[q..], b"lr") {
                    Some(3)
                } else {
                    None
                };
                if let Some(k) = kind {
                    dir_starts[k].push(pos);
                    dir_ends[k].push(q + 2);
                    any_dir = true;
                    pos = q + 2;
                    continue;
                }
            }
        }
        let ch = src[pos..].chars().next().unwrap();
        pos += ch.len_utf8();
    }
    (dir_starts, dir_ends, any_dir)
}

fn find_line_end(src: &str, from: usize) -> usize {
    for (rel, ch) in src[from..].char_indices() {
        if is_line_end(ch as u32) {
            return from + rel;
        }
    }
    src.len()
}

fn line_break(src: &str, from: usize) -> usize {
    src[from..].find('\n').map_or(src.len(), |rel| from + rel)
}

/// Produces the token stream of Mermaid's requirement lexer. Its rules are tried in order and
/// the first match wins, so a line that holds a direction statement anywhere is one token.
pub fn tokenize(src: &str) -> Tokens {
    let n = src.len();
    let bytes = src.as_bytes();
    let mut types: Vec<ReqToken> = Vec::new();
    let mut texts: Vec<String> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    let mut stack: Vec<LexState> = Vec::new();
    let mut state = LexState::Initial;
    let mut p = 0usize;

    let (dir_starts, dir_ends, any_dir) = scan_directions(src);
    let mut dir_seen = [0usize; 4];
    let mut line_end_known = false;
    let mut line_end = 0usize;

    macro_rules! emit {
        ($tok:expr, $s:expr, $e:expr) => {{
            let s = $s;
            let e = $e;
            types.push($tok);
            texts.push(src[s..e].to_string());
            starts.push(s);
            p = e;
        }};
    }

    while p < n {
        let ch = src[p..].chars().next().unwrap();
        let c = ch as u32;
        let ok = match state {
            LexState::Initial => {
                let mut matched = false;
                let lower = c | 32;
                if lower == b't' as u32
                    && match_ci_prefix(&src[p..], b"title")
                    && let Some(sp) = src[p + 5..].chars().next()
                    && is_space_char(sp)
                {
                    let body_start = p + 5 + sp.len_utf8();
                    let mut q = body_start;
                    while q < n {
                        let d = bytes[q];
                        if d == b'#' || d == b'\n' || d == b';' {
                            break;
                        }
                        q += 1;
                    }
                    if q > body_start {
                        emit!(ReqToken::Title, p, q);
                        matched = true;
                    }
                }
                if !matched && lower == b'a' as u32 && p + 2 < n && (bytes[p + 1] | 32) == b'c' && (bytes[p + 2] | 32) == b'c' {
                    if let Some(e) = scan_acc_prefix(src, p, b"accTitle", b':') {
                        stack.push(state);
                        state = LexState::AccTitle;
                        emit!(ReqToken::AccTitle, p, e);
                        matched = true;
                    } else if let Some(e) = scan_acc_prefix(src, p, b"accDescr", b':') {
                        stack.push(state);
                        state = LexState::AccDescr;
                        emit!(ReqToken::AccDescr, p, e);
                        matched = true;
                    } else if let Some(e) = scan_acc_prefix(src, p, b"accDescr", b'{') {
                        stack.push(state);
                        state = LexState::AccDescrMultiline;
                        p = e;
                        matched = true;
                    }
                }
                if !matched && any_dir && !is_line_end(c) {
                    if !line_end_known || line_end < p {
                        line_end = find_line_end(src, p);
                        line_end_known = true;
                        for k in 0..4 {
                            let list = &dir_starts[k];
                            let mut j = dir_seen[k];
                            while j < list.len() && list[j] <= line_end {
                                j += 1;
                            }
                            dir_seen[k] = j;
                        }
                    }
                    for k in 0..4 {
                        if dir_seen[k] > 0 {
                            let j = dir_seen[k] - 1;
                            if dir_starts[k][j] >= p {
                                let end = line_break(src, dir_ends[k][j]);
                                emit!(ReqToken::direction_from_index(k), p, end);
                                matched = true;
                                break;
                            }
                        }
                    }
                }
                if !matched {
                    if c == 10 || (c == 13 && bytes.get(p + 1) == Some(&b'\n')) {
                        let mut q = p;
                        while q < n {
                            let d = bytes[q];
                            if d == b'\n' {
                                q += 1;
                            } else if d == b'\r' && bytes.get(q + 1) == Some(&b'\n') {
                                q += 2;
                            } else {
                                break;
                            }
                        }
                        emit!(ReqToken::Newline, p, q);
                        matched = true;
                    } else if is_space(c) {
                        p += ch.len_utf8();
                        while p < n {
                            let next_ch = src[p..].chars().next().unwrap();
                            if is_space_char(next_ch) {
                                p += next_ch.len_utf8();
                            } else {
                                break;
                            }
                        }
                        matched = true;
                    } else if c == b'#' as u32 || c == b'%' as u32 {
                        p = line_break(src, p);
                        matched = true;
                    } else if is_word(c) {
                        let mut q = p + 1;
                        while q < n && is_word(bytes[q] as u32) {
                            q += 1;
                        }
                        if q - p <= LONGEST_KEYWORD {
                            let lower_kw = src[p..q].to_ascii_lowercase();
                            if let Some(keyword) = lookup_keyword(&lower_kw) {
                                if matches!(keyword, ReqToken::Style | ReqToken::ClassDef | ReqToken::Class) {
                                    stack.push(state);
                                    state = LexState::Style;
                                }
                                emit!(keyword, p, q);
                                matched = true;
                            }
                        }
                        if !matched {
                            while q < n {
                                let d = bytes[q];
                                if d < 128 && is_stop(d) {
                                    break;
                                }
                                q += 1;
                            }
                            types.push(ReqToken::UnqString);
                            texts.push(src[p..q].trim().to_string());
                            starts.push(p);
                            p = q;
                            matched = true;
                        }
                    } else {
                        match c {
                            123 => {
                                emit!(ReqToken::StructStart, p, p + 1);
                                matched = true;
                            }
                            125 => {
                                emit!(ReqToken::StructStop, p, p + 1);
                                matched = true;
                            }
                            58 => {
                                if bytes.get(p + 1) == Some(&b':') && bytes.get(p + 2) == Some(&b':') {
                                    emit!(ReqToken::StyleSeparator, p, p + 3);
                                } else {
                                    emit!(ReqToken::ColonSep, p, p + 1);
                                }
                                matched = true;
                            }
                            60 => {
                                if bytes.get(p + 1) == Some(&b'-') {
                                    emit!(ReqToken::EndArrowL, p, p + 2);
                                    matched = true;
                                }
                            }
                            45 => {
                                if bytes.get(p + 1) == Some(&b'>') {
                                    emit!(ReqToken::EndArrowR, p, p + 2);
                                } else {
                                    emit!(ReqToken::Line, p, p + 1);
                                }
                                matched = true;
                            }
                            34 => {
                                stack.push(state);
                                state = LexState::StringLit;
                                p += 1;
                                matched = true;
                            }
                            44 => {
                                emit!(ReqToken::Comma, p, p + 1);
                                matched = true;
                            }
                            _ => {}
                        }
                    }
                }
                matched
            }
            LexState::Style => {
                if is_word(c) {
                    let mut q = p + 1;
                    while q < n && is_word(bytes[q] as u32) {
                        q += 1;
                    }
                    emit!(ReqToken::Alpha, p, q);
                    true
                } else {
                    match c {
                        58 => {
                            emit!(ReqToken::Colon, p, p + 1);
                            true
                        }
                        59 => {
                            emit!(ReqToken::Semicolon, p, p + 1);
                            true
                        }
                        37 => {
                            emit!(ReqToken::Percent, p, p + 1);
                            true
                        }
                        45 => {
                            emit!(ReqToken::Minus, p, p + 1);
                            true
                        }
                        35 => {
                            emit!(ReqToken::Brkt, p, p + 1);
                            true
                        }
                        32 => {
                            p += 1;
                            true
                        }
                        34 => {
                            stack.push(state);
                            state = LexState::StringLit;
                            p += 1;
                            true
                        }
                        10 => {
                            if let Some(prev) = stack.pop() {
                                state = prev;
                            }
                            p += 1;
                            true
                        }
                        44 => {
                            emit!(ReqToken::Comma, p, p + 1);
                            true
                        }
                        _ => false,
                    }
                }
            }
            LexState::StringLit => {
                if c == b'"' as u32 {
                    if let Some(prev) = stack.pop() {
                        state = prev;
                    }
                    p += 1;
                } else {
                    let e = src[p..].find('"').map_or(n, |rel| p + rel);
                    emit!(ReqToken::QString, p, e);
                }
                true
            }
            LexState::AccTitle => {
                if let Some(prev) = stack.pop() {
                    state = prev;
                }
                let e = line_break(src, p);
                emit!(ReqToken::AccTitleValue, p, e);
                true
            }
            LexState::AccDescr => {
                if let Some(prev) = stack.pop() {
                    state = prev;
                }
                let e = line_break(src, p);
                emit!(ReqToken::AccDescrValue, p, e);
                true
            }
            LexState::AccDescrMultiline => {
                if c == b'}' as u32 {
                    if let Some(prev) = stack.pop() {
                        state = prev;
                    }
                    p += 1;
                } else {
                    let e = src[p..].find('}').map_or(n, |rel| p + rel);
                    emit!(ReqToken::AccDescrMultilineValue, p, e);
                }
                true
            }
        };
        if !ok {
            types.push(ReqToken::Error);
            texts.push(String::new());
            starts.push(p);
            return Tokens { types, texts, starts };
        }
    }

    // At the end of input Jison still tries the rules that can match nothing, once.
    let last = match state {
        LexState::Initial => Some(ReqToken::Eof),
        LexState::StringLit => Some(ReqToken::QString),
        LexState::AccTitle => Some(ReqToken::AccTitleValue),
        LexState::AccDescr => Some(ReqToken::AccDescrValue),
        LexState::AccDescrMultiline => Some(ReqToken::AccDescrMultilineValue),
        LexState::Style => None,
    };
    if let Some(tok) = last {
        types.push(tok);
        texts.push(String::new());
        starts.push(n);
    }
    types.push(ReqToken::End);
    texts.push(String::new());
    starts.push(n);
    Tokens { types, texts, starts }
}
