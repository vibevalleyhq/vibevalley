use crate::util::chars::{is_digit, is_space_char, is_word};

use super::tokens::ErToken;

pub struct ErTokens {
    pub types: Vec<ErToken>,
    pub texts: Vec<String>,
    pub starts: Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Initial,
    Block,
    BlockBq,
    AccTitle,
    AccDescr,
    AccDescrMultiline,
    Style,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SearchState {
    Uninit,
    None,
    At(usize),
}

const TEXT: u8 = 1;
const STYLE_TEXT: u8 = 2;
const ATTR_START: u8 = 4;
const ATTR_REST: u8 = 8;

const CLASS: [u8; 128] = {
    let mut table = [0u8; 128];
    let mut c = 0usize;
    while c < 128 {
        let word = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95;
        let letter = word && (c < 48 || c > 57);
        if word {
            table[c] |= TEXT | STYLE_TEXT | ATTR_REST;
        }
        if letter {
            table[c] |= ATTR_START;
        }
        c += 1;
    }
    table[b'-' as usize] |= TEXT | STYLE_TEXT | ATTR_REST;
    table[b'*' as usize] |= TEXT | STYLE_TEXT | ATTR_REST | ATTR_START;
    table[b'.' as usize] |= TEXT | ATTR_REST;
    table[b'[' as usize] |= ATTR_REST;
    table[b']' as usize] |= ATTR_REST;
    table[b'(' as usize] |= ATTR_REST;
    table[b')' as usize] |= ATTR_REST;
    table[b',' as usize] |= ATTR_REST;
    table
};

/// Mermaid's attribute pattern is case-insensitive, which lets the micro sign into its `\u00c0-\uffff` range.
#[inline]
fn is_attr(ch: char, kind: u8) -> bool {
    let c = ch as u32;
    if c < 128 { (CLASS[c as usize] & kind) != 0 } else { c >= 0xc0 || c == 0xb5 }
}

#[inline]
fn char_at(src: &str, p: usize) -> Option<(char, usize)> {
    let ch = src[p..].chars().next()?;
    Some((ch, ch.len_utf8()))
}

#[inline]
fn byte_at(bytes: &[u8], p: usize) -> u8 {
    bytes.get(p).copied().unwrap_or(0)
}

#[inline]
fn kw_at(bytes: &[u8], p: usize, word: &[u8]) -> bool {
    if p + word.len() > bytes.len() {
        return false;
    }
    for (i, &k) in word.iter().enumerate() {
        let c = bytes[p + i];
        if c != k && !(k.is_ascii_lowercase() && (c | 32) == k) {
            return false;
        }
    }
    true
}

#[inline]
fn kwb_at(bytes: &[u8], p: usize, word: &[u8]) -> bool {
    kw_at(bytes, p, word) && !is_word(byte_at(bytes, p + word.len()) as u32)
}

fn next_line_end(src: &str, from: usize) -> usize {
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut q = from;
    while q < n {
        let b = bytes[q];
        if b == b'\n' || b == b'\r' {
            return q;
        }
        if b == 0xe2 && q + 2 < n && bytes[q + 1] == 0x80 && (bytes[q + 2] == 0xa8 || bytes[q + 2] == 0xa9) {
            return q;
        }
        q += 1;
    }
    n
}

fn find_direction_word(bytes: &[u8], from: usize, limit: usize) -> Option<usize> {
    let mut q = from;
    while q + 9 <= limit {
        if (bytes[q] == b'd' || bytes[q] == b'D') && kw_at(bytes, q, b"direction") {
            return Some(q);
        }
        q += 1;
    }
    None
}

fn match_acc_header(src: &str, p: usize, word: &[u8], delim: u8) -> Option<usize> {
    let bytes = src.as_bytes();
    if !kw_at(bytes, p, word) {
        return None;
    }
    let mut q = p + word.len();
    while let Some((ch, len)) = char_at(src, q) {
        if is_space_char(ch) {
            q += len;
        } else {
            break;
        }
    }
    if bytes.get(q) != Some(&delim) {
        return None;
    }
    q += 1;
    while let Some((ch, len)) = char_at(src, q) {
        if is_space_char(ch) {
            q += len;
        } else {
            break;
        }
    }
    Some(q)
}

fn digits_end(bytes: &[u8], mut q: usize) -> usize {
    while q < bytes.len() && is_digit(bytes[q] as u32) {
        q += 1;
    }
    q
}

pub fn tokenize(src: &str) -> ErTokens {
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut types: Vec<ErToken> = Vec::new();
    let mut texts: Vec<String> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    let mut state = State::Initial;
    let mut p = 0usize;
    let mut dir_next = SearchState::Uninit;
    let mut dir_failed = 0usize;
    let mut line_end: Option<usize> = None;
    let mut tilde_next = SearchState::Uninit;
    let mut tilde_line: Option<usize> = None;
    let mut tilde_last: Option<usize> = None;
    let mut ws_next: Option<usize> = None;

    macro_rules! emit {
        ($tok:expr, $s:expr, $e:expr) => {{
            types.push($tok);
            texts.push(src[$s..$e].to_string());
            starts.push($s);
            p = $e;
        }};
    }

    while p < n {
        let b = bytes[p];
        match state {
            State::Initial => {
                if (b == b'a' || b == b'A') && kw_at(bytes, p, b"acc") {
                    if let Some(e) = match_acc_header(src, p, b"acctitle", b':') {
                        state = State::AccTitle;
                        emit!(ErToken::AccTitle, p, e);
                        continue;
                    }
                    if let Some(e) = match_acc_header(src, p, b"accdescr", b':') {
                        state = State::AccDescr;
                        emit!(ErToken::AccDescr, p, e);
                        continue;
                    }
                    if let Some(e) = match_acc_header(src, p, b"accdescr", b'{') {
                        state = State::AccDescrMultiline;
                        p = e;
                        continue;
                    }
                }

                // A direction statement swallows its whole line, from wherever the lexer stands on it.
                let mut matched_dir = false;
                if dir_next != SearchState::None {
                    let needs_search = match dir_next {
                        SearchState::Uninit => true,
                        SearchState::At(pos) => pos < p,
                        SearchState::None => false,
                    };
                    if needs_search {
                        dir_next = match find_direction_word(bytes, p, n) {
                            Some(pos) => SearchState::At(pos),
                            None => SearchState::None,
                        };
                    }
                    if let SearchState::At(first_dir) = dir_next
                        && p >= dir_failed
                    {
                        let le = match line_end {
                            Some(cur) if cur >= p => cur,
                            Some(_) | None => {
                                let computed = next_line_end(src, p);
                                line_end = Some(computed);
                                computed
                            }
                        };
                        if first_dir < le {
                            let mut best: [Option<usize>; 4] = [None; 4];
                            let mut q = first_dir;
                            while q + 9 <= le {
                                let mut r = q + 9;
                                let mut has_space = false;
                                while let Some((ch, len)) = char_at(src, r) {
                                    if is_space_char(ch) {
                                        has_space = true;
                                        r += len;
                                    } else {
                                        break;
                                    }
                                }
                                if has_space && r + 2 <= n {
                                    let dir_idx = if kw_at(bytes, r, b"tb") {
                                        Some(0)
                                    } else if kw_at(bytes, r, b"bt") {
                                        Some(1)
                                    } else if kw_at(bytes, r, b"rl") {
                                        Some(2)
                                    } else if kw_at(bytes, r, b"lr") {
                                        Some(3)
                                    } else {
                                        None
                                    };
                                    if let Some(idx) = dir_idx {
                                        let after = r + 2;
                                        let end = src[after..].find('\n').map_or(n, |rel| after + rel);
                                        best[idx] = Some(end);
                                    }
                                }
                                if r + 9 > le {
                                    break;
                                }
                                match find_direction_word(bytes, r, le) {
                                    Some(next_q) => q = next_q,
                                    None => break,
                                }
                            }
                            let dir_tokens = [ErToken::DirectionTb, ErToken::DirectionBt, ErToken::DirectionRl, ErToken::DirectionLr];
                            for (idx, tok) in dir_tokens.into_iter().enumerate() {
                                if let Some(end) = best[idx] {
                                    emit!(tok, p, end);
                                    matched_dir = true;
                                    break;
                                }
                            }
                            if !matched_dir {
                                dir_failed = le;
                            }
                        }
                    }
                }
                if matched_dir {
                    continue;
                }

                match b {
                    b' ' | b'\t' | b'\r' => {
                        let mut e = p + 1;
                        while e < n && matches!(bytes[e], b' ' | b'\t' | b'\r') {
                            e += 1;
                        }
                        p = e;
                        continue;
                    }
                    b'\n' => {
                        let mut e = p + 1;
                        while e < n && bytes[e] == b'\n' {
                            e += 1;
                        }
                        emit!(ErToken::Newline, p, e);
                        continue;
                    }
                    b'"' => {
                        if let Some(rel) = src[p + 1..].find('"') {
                            let e = p + 1 + rel;
                            let mut is_entity_name = e > p + 1;
                            if is_entity_name {
                                for &ch_b in &bytes[p + 1..e] {
                                    if matches!(ch_b, b'%' | b'\\' | b'\r' | b'\n' | 0x0b | 0x08) {
                                        is_entity_name = false;
                                        break;
                                    }
                                }
                            }
                            emit!(if is_entity_name { ErToken::EntityName } else { ErToken::Word }, p, e + 1);
                        } else {
                            emit!(ErToken::Char, p, p + 1);
                        }
                        continue;
                    }
                    b'{' => {
                        state = State::Block;
                        emit!(ErToken::BlockStart, p, p + 1);
                        continue;
                    }
                    b'#' => {
                        emit!(ErToken::Brkt, p, p + 1);
                        continue;
                    }
                    b',' => {
                        emit!(ErToken::Comma, p, p + 1);
                        continue;
                    }
                    b':' => {
                        if byte_at(bytes, p + 1) == b':' && byte_at(bytes, p + 2) == b':' {
                            emit!(ErToken::StyleSeparator, p, p + 3);
                        } else {
                            emit!(ErToken::Colon, p, p + 1);
                        }
                        continue;
                    }
                    b'[' => {
                        emit!(ErToken::Sqs, p, p + 1);
                        continue;
                    }
                    b']' => {
                        emit!(ErToken::Sqe, p, p + 1);
                        continue;
                    }
                    _ => {}
                }

                if is_digit(b as u32) {
                    let d = byte_at(bytes, p + 1);
                    if d == b'+' && (b == b'1' || b == b'0') {
                        emit!(if b == b'1' { ErToken::OneOrMore } else { ErToken::ZeroOrMore }, p, p + 2);
                        continue;
                    }
                    let q = digits_end(bytes, p + 1);
                    if byte_at(bytes, q) == b'.' && is_digit(byte_at(bytes, q + 1) as u32) {
                        let e = digits_end(bytes, q + 2);
                        emit!(ErToken::DecimalNum, p, e);
                        continue;
                    }
                    if b == b'1' {
                        if let Some((next_ch, next_len)) = char_at(src, p + 1)
                            && is_space_char(next_ch)
                        {
                            let mut r = p + 1 + next_len;
                            while let Some((ch, len)) = char_at(src, r) {
                                if is_space_char(ch) {
                                    r += len;
                                } else {
                                    break;
                                }
                            }
                            let f = byte_at(bytes, r);
                            if is_word(f as u32) || f == b'"' || f == b'\'' {
                                emit!(ErToken::OnlyOne, p, p + 1);
                                continue;
                            }
                        } else if d == b'-' || d == b'.' {
                            let f = byte_at(bytes, p + 2);
                            if f == b'-' || f == b'.' {
                                emit!(ErToken::OnlyOne, p, p + 1);
                                continue;
                            }
                        }
                        if !is_word(d as u32) {
                            emit!(ErToken::EntityOne, p, p + 1);
                            continue;
                        }
                    }
                    emit!(ErToken::Num, p, q);
                    continue;
                }

                let lc = if b.is_ascii_uppercase() { b + 32 } else { b };
                let d = byte_at(bytes, p + 1);
                let matched_kw = match lc {
                    b'e' => {
                        if kwb_at(bytes, p, b"erdiagram") {
                            emit!(ErToken::ErDiagram, p, p + 9);
                            true
                        } else if kwb_at(bytes, p, b"end") {
                            let mut e = p + 3;
                            while let Some((ch, len)) = char_at(src, e) {
                                if is_space_char(ch) {
                                    e += len;
                                } else {
                                    break;
                                }
                            }
                            emit!(ErToken::EndKw, p, e);
                            true
                        } else {
                            false
                        }
                    }
                    b's' => {
                        if kwb_at(bytes, p, b"style") {
                            state = State::Style;
                            emit!(ErToken::Style, p, p + 5);
                            true
                        } else if kwb_at(bytes, p, b"subgraph") {
                            emit!(ErToken::Subgraph, p, p + 8);
                            true
                        } else {
                            false
                        }
                    }
                    b'c' => {
                        if kwb_at(bytes, p, b"classdef") {
                            state = State::Style;
                            emit!(ErToken::ClassDef, p, p + 8);
                            true
                        } else if kwb_at(bytes, p, b"class") {
                            emit!(ErToken::Class, p, p + 5);
                            true
                        } else {
                            false
                        }
                    }
                    b'o' => {
                        if kwb_at(bytes, p, b"one or zero") {
                            emit!(ErToken::ZeroOrOne, p, p + 11);
                            true
                        } else if kwb_at(bytes, p, b"one or more") || kwb_at(bytes, p, b"one or many") {
                            emit!(ErToken::OneOrMore, p, p + 11);
                            true
                        } else if kwb_at(bytes, p, b"one") {
                            emit!(ErToken::OnlyOne, p, p + 3);
                            true
                        } else if kwb_at(bytes, p, b"only one") {
                            emit!(ErToken::OnlyOne, p, p + 8);
                            true
                        } else if d == b'|' {
                            emit!(ErToken::ZeroOrOne, p, p + 2);
                            true
                        } else if d == b'{' {
                            emit!(ErToken::ZeroOrMore, p, p + 2);
                            true
                        } else if kwb_at(bytes, p, b"optionally to") {
                            emit!(ErToken::NonIdentifying, p, p + 13);
                            true
                        } else {
                            false
                        }
                    }
                    b'z' => {
                        if kwb_at(bytes, p, b"zero or one") {
                            emit!(ErToken::ZeroOrOne, p, p + 11);
                            true
                        } else if kwb_at(bytes, p, b"zero or more") || kwb_at(bytes, p, b"zero or many") {
                            emit!(ErToken::ZeroOrMore, p, p + 12);
                            true
                        } else {
                            false
                        }
                    }
                    b'm' => {
                        if kw_at(bytes, p, b"many(0)") {
                            emit!(ErToken::ZeroOrMore, p, p + 7);
                            true
                        } else if kw_at(bytes, p, b"many(1)") {
                            emit!(ErToken::OneOrMore, p, p + 7);
                            true
                        } else if kwb_at(bytes, p, b"many") {
                            emit!(ErToken::ZeroOrMore, p, p + 4);
                            true
                        } else {
                            false
                        }
                    }
                    b't' => {
                        if kwb_at(bytes, p, b"to") {
                            emit!(ErToken::Identifying, p, p + 2);
                            true
                        } else {
                            false
                        }
                    }
                    b'u' => {
                        if matches!(d, b'.' | b'-' | b'|') {
                            emit!(ErToken::MdParent, p, p + 1);
                            true
                        } else {
                            false
                        }
                    }
                    b'|' => {
                        if d.eq_ignore_ascii_case(&b'o') && !is_word(byte_at(bytes, p + 2) as u32) {
                            emit!(ErToken::ZeroOrOne, p, p + 2);
                            true
                        } else if d == b'|' {
                            emit!(ErToken::OnlyOne, p, p + 2);
                            true
                        } else if d == b'{' {
                            emit!(ErToken::OneOrMore, p, p + 2);
                            true
                        } else {
                            false
                        }
                    }
                    b'}' => {
                        if d.eq_ignore_ascii_case(&b'o') && !is_word(byte_at(bytes, p + 2) as u32) {
                            emit!(ErToken::ZeroOrMore, p, p + 2);
                            true
                        } else if d == b'|' {
                            emit!(ErToken::OneOrMore, p, p + 2);
                            true
                        } else {
                            false
                        }
                    }
                    b'.' => {
                        if d == b'.' || d == b'-' {
                            emit!(ErToken::NonIdentifying, p, p + 2);
                            true
                        } else {
                            false
                        }
                    }
                    b'-' => {
                        if d == b'-' {
                            emit!(ErToken::Identifying, p, p + 2);
                            true
                        } else if d == b'.' {
                            emit!(ErToken::NonIdentifying, p, p + 2);
                            true
                        } else {
                            false
                        }
                    }
                    _ => false,
                };
                if matched_kw {
                    continue;
                }

                if b >= 128 || (CLASS[b as usize] & TEXT) != 0 {
                    let mut e = p + 1;
                    while e < n && (bytes[e] >= 128 || (CLASS[bytes[e] as usize] & TEXT) != 0) {
                        e += 1;
                    }
                    emit!(ErToken::UnicodeText, p, e);
                } else {
                    emit!(ErToken::Char, p, p + 1);
                }
            }

            State::Block => {
                let (ch, ch_len) = char_at(src, p).expect("p < n");
                if is_space_char(ch) {
                    p += ch_len;
                    while let Some((next_ch, next_len)) = char_at(src, p) {
                        if is_space_char(next_ch) {
                            p += next_len;
                        } else {
                            break;
                        }
                    }
                    continue;
                }
                if b < 128 {
                    let lc = b | 32;
                    if matches!(lc, b'p' | b'f' | b'u') && (byte_at(bytes, p + 1) | 32) == b'k' && !is_word(byte_at(bytes, p + 2) as u32) {
                        emit!(ErToken::AttributeKey, p, p + 2);
                        continue;
                    }
                }

                // Mermaid's generic type rule: a run of non-space characters holding a `~`, through the last `~` on the line.
                let mut matched_generic = false;
                if tilde_next != SearchState::None {
                    let needs_search = match tilde_next {
                        SearchState::Uninit => true,
                        SearchState::At(pos) => pos < p,
                        SearchState::None => false,
                    };
                    if needs_search {
                        tilde_next = match src[p..].find('~') {
                            Some(rel) => SearchState::At(p + rel),
                            None => SearchState::None,
                        };
                    }
                    if let SearchState::At(tn) = tilde_next {
                        let wn = match ws_next {
                            Some(cur) if cur >= p => cur,
                            Some(_) | None => {
                                let mut q = p;
                                while let Some((c2, l2)) = char_at(src, q) {
                                    if is_space_char(c2) {
                                        break;
                                    }
                                    q += l2;
                                }
                                ws_next = Some(q);
                                q
                            }
                        };
                        if tn < wn {
                            let tl_last = match tilde_line {
                                Some(cur) if cur >= p => tilde_last,
                                Some(_) | None => {
                                    let tl = next_line_end(src, p);
                                    let last = src[..tl].rfind('~');
                                    tilde_line = Some(tl);
                                    tilde_last = last;
                                    last
                                }
                            };
                            if let Some(last) = tl_last
                                && last > tn
                            {
                                let mut e = last + 1;
                                while let Some((c2, l2)) = char_at(src, e) {
                                    if is_space_char(c2) {
                                        break;
                                    }
                                    e += l2;
                                }
                                emit!(ErToken::AttributeWord, p, e);
                                matched_generic = true;
                            }
                        }
                    }
                }
                if matched_generic {
                    continue;
                }

                if is_attr(ch, ATTR_START) {
                    let mut e = p + ch_len;
                    while let Some((c2, l2)) = char_at(src, e) {
                        if is_attr(c2, ATTR_REST) {
                            e += l2;
                        } else {
                            break;
                        }
                    }
                    emit!(ErToken::AttributeWord, p, e);
                    continue;
                }
                if b == b'`' {
                    state = State::BlockBq;
                    p += 1;
                    continue;
                }
                if b == b'"' {
                    if let Some(rel) = src[p + 1..].find('"') {
                        let e = p + 1 + rel;
                        emit!(ErToken::Comment, p, e + 1);
                        continue;
                    }
                } else if b == b'}' {
                    state = State::Initial;
                    emit!(ErToken::BlockStop, p, p + 1);
                    continue;
                }
                emit!(ErToken::Char, p, p + ch_len);
            }

            State::BlockBq => {
                if b == b'`' {
                    state = State::Block;
                    p += 1;
                } else {
                    let e = src[p..].find('`').map_or(n, |rel| p + rel);
                    emit!(ErToken::AttributeWord, p, e);
                }
            }

            State::AccTitle | State::AccDescr => {
                let e = src[p..].find('\n').map_or(n, |rel| p + rel);
                let tok = match state {
                    State::AccTitle => ErToken::AccTitleValue,
                    State::AccDescr => ErToken::AccDescrValue,
                    State::Initial | State::Block | State::BlockBq | State::AccDescrMultiline | State::Style => unreachable!(),
                };
                emit!(tok, p, e);
                state = State::Initial;
            }

            State::AccDescrMultiline => {
                if b == b'}' {
                    state = State::Initial;
                    p += 1;
                } else {
                    let e = src[p..].find('}').map_or(n, |rel| p + rel);
                    emit!(ErToken::AccDescrMultilineValue, p, e);
                }
            }

            State::Style => {
                let (ch, ch_len) = char_at(src, p).expect("p < n");
                if b == b'\n' {
                    let mut e = p + 1;
                    while e < n && bytes[e] == b'\n' {
                        e += 1;
                    }
                    state = State::Initial;
                    emit!(ErToken::Newline, p, e);
                } else if is_space_char(ch) {
                    p += ch_len;
                    while let Some((c2, l2)) = char_at(src, p) {
                        if is_space_char(c2) {
                            p += l2;
                        } else {
                            break;
                        }
                    }
                } else if b == b':' {
                    emit!(ErToken::Colon, p, p + 1);
                } else if b == b',' {
                    emit!(ErToken::Comma, p, p + 1);
                } else if b == b'#' {
                    emit!(ErToken::Brkt, p, p + 1);
                } else if b == b';' {
                    emit!(ErToken::Semi, p, p + 1);
                } else if b >= 128 || (CLASS[b as usize] & STYLE_TEXT) != 0 {
                    let mut e = p + 1;
                    while e < n && (bytes[e] >= 128 || (CLASS[bytes[e] as usize] & STYLE_TEXT) != 0) {
                        e += 1;
                    }
                    emit!(ErToken::StyleText, p, e);
                } else {
                    types.push(ErToken::Error);
                    texts.push(String::new());
                    starts.push(p);
                    return ErTokens { types, texts, starts };
                }
            }
        }
    }

    // At the end of input Jison's INITIAL state yields EOF, title/description states yield an empty value,
    // and block/style states yield nothing.
    let last = match state {
        State::Initial => Some(ErToken::Eof),
        State::AccTitle => Some(ErToken::AccTitleValue),
        State::AccDescr => Some(ErToken::AccDescrValue),
        State::AccDescrMultiline => Some(ErToken::AccDescrMultilineValue),
        State::Block | State::BlockBq | State::Style => None,
    };
    if let Some(tok) = last {
        types.push(tok);
        texts.push(String::new());
        starts.push(n);
    }
    types.push(ErToken::End);
    texts.push(String::new());
    starts.push(n);
    ErTokens { types, texts, starts }
}
