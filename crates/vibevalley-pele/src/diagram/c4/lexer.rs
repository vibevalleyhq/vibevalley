use crate::util::chars::{is_line_end, is_space_char, is_word};

use super::tokens::C4Token;

pub struct C4Tokens {
    pub types: Vec<C4Token>,
    pub starts: Vec<usize>,
    pub ends: Vec<usize>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Initial,
    Struct,
    Attribute,
    String,
    StringKv,
    StringKvKey,
    StringKvValue,
    Acc,
    AccDescrMultiline,
}

fn keyword_token(word: &str) -> Option<C4Token> {
    match word {
        "C4Context" => Some(C4Token::C4Context),
        "C4Container" => Some(C4Token::C4Container),
        "C4Component" => Some(C4Token::C4Component),
        "C4Dynamic" => Some(C4Token::C4Dynamic),
        "C4Deployment" => Some(C4Token::C4Deployment),
        "Person" => Some(C4Token::Person),
        "Person_Ext" => Some(C4Token::PersonExt),
        "System" => Some(C4Token::System),
        "SystemDb" => Some(C4Token::SystemDb),
        "SystemQueue" => Some(C4Token::SystemQueue),
        "System_Ext" => Some(C4Token::SystemExt),
        "SystemDb_Ext" => Some(C4Token::SystemExtDb),
        "SystemQueue_Ext" => Some(C4Token::SystemExtQueue),
        "Container" => Some(C4Token::Container),
        "ContainerDb" => Some(C4Token::ContainerDb),
        "ContainerQueue" => Some(C4Token::ContainerQueue),
        "Container_Ext" => Some(C4Token::ContainerExt),
        "ContainerDb_Ext" => Some(C4Token::ContainerExtDb),
        "ContainerQueue_Ext" => Some(C4Token::ContainerExtQueue),
        "Component" => Some(C4Token::Component),
        "ComponentDb" => Some(C4Token::ComponentDb),
        "ComponentQueue" => Some(C4Token::ComponentQueue),
        "Component_Ext" => Some(C4Token::ComponentExt),
        "ComponentDb_Ext" => Some(C4Token::ComponentExtDb),
        "ComponentQueue_Ext" => Some(C4Token::ComponentExtQueue),
        "Enterprise_Boundary" => Some(C4Token::EnterpriseBoundary),
        "System_Boundary" => Some(C4Token::SystemBoundary),
        "Boundary" => Some(C4Token::Boundary),
        "Container_Boundary" => Some(C4Token::ContainerBoundary),
        "Deployment_Node" | "Node" => Some(C4Token::Node),
        "Node_L" => Some(C4Token::NodeL),
        "Node_R" => Some(C4Token::NodeR),
        "Rel" => Some(C4Token::Rel),
        "BiRel" => Some(C4Token::BiRel),
        "Rel_Up" | "Rel_U" => Some(C4Token::RelU),
        "Rel_Down" | "Rel_D" => Some(C4Token::RelD),
        "Rel_Left" | "Rel_L" => Some(C4Token::RelL),
        "Rel_Right" | "Rel_R" => Some(C4Token::RelR),
        "Rel_Back" => Some(C4Token::RelB),
        "RelIndex" => Some(C4Token::RelIndex),
        "UpdateElementStyle" => Some(C4Token::UpdateElStyle),
        "UpdateRelStyle" => Some(C4Token::UpdateRelStyle),
        "UpdateLayoutConfig" => Some(C4Token::UpdateLayoutConfig),
        _ => None,
    }
}

fn find_line_end(src: &str, from: usize) -> usize {
    let bytes = src.as_bytes();
    let mut p = from;
    while p < bytes.len() {
        let b = bytes[p];
        if b == b'\n' || b == b'\r' {
            return p;
        }
        if b < 128 {
            p += 1;
        } else {
            let ch = src[p..].chars().next().unwrap();
            if is_line_end(ch as u32) {
                return p;
            }
            p += ch.len_utf8();
        }
    }
    bytes.len()
}

/// Matches JS `/.*direction\s+(TB|BT|RL|LR)[^\n]*/y` in priority order TB, BT, RL, LR.
fn match_direction(src: &str, p: usize, line_end: usize) -> Option<(C4Token, usize)> {
    const DIRS: [(&str, C4Token); 4] = [
        ("TB", C4Token::DirectionTb),
        ("BT", C4Token::DirectionBt),
        ("RL", C4Token::DirectionRl),
        ("LR", C4Token::DirectionLr),
    ];
    let slice = &src[p..line_end];
    for &(code, tok) in &DIRS {
        let mut search = 0;
        let mut matched_end: Option<usize> = None;
        while let Some(rel) = slice[search..].find("direction") {
            let pos = p + search + rel;
            let mut q = pos + 9;
            let ws_start = q;
            while q < src.len()
                && let Some(ch) = src[q..].chars().next()
                && is_space_char(ch)
            {
                q += ch.len_utf8();
            }
            if q > ws_start && src[q..].starts_with(code) {
                let end = src[q + 2..].find('\n').map_or(src.len(), |r| q + 2 + r);
                matched_end = Some(end);
            }
            search += rel + 1;
        }
        if let Some(end) = matched_end {
            return Some((tok, end));
        }
    }
    None
}

/// Matches JS `/title[^\S\r\n]*(?=[\r\n]|$)\s*/y`.
fn match_bare_title(src: &str, p: usize) -> Option<usize> {
    if !src[p..].starts_with("title") {
        return None;
    }
    let mut q = p + 5;
    while q < src.len()
        && let Some(ch) = src[q..].chars().next()
        && ch != '\r'
        && ch != '\n'
        && is_space_char(ch)
    {
        q += ch.len_utf8();
    }
    if q < src.len() && !matches!(src.as_bytes()[q], b'\r' | b'\n') {
        return None;
    }
    while q < src.len()
        && let Some(ch) = src[q..].chars().next()
        && is_space_char(ch)
    {
        q += ch.len_utf8();
    }
    Some(q)
}

fn skip_ws(src: &str, mut q: usize) -> usize {
    while q < src.len()
        && let Some(ch) = src[q..].chars().next()
        && is_space_char(ch)
    {
        q += ch.len_utf8();
    }
    q
}

fn up_to(src: &str, ch: u8, from: usize) -> usize {
    let bytes = src.as_bytes();
    let mut q = from;
    while q < bytes.len() && bytes[q] != ch {
        q += 1;
    }
    q
}

/// Follows the Jison lexer compiled from `c4Diagram.jison`.
pub fn tokenize(src: &str) -> C4Tokens {
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut types = Vec::new();
    let mut starts = Vec::new();
    let mut ends = Vec::new();
    let mut state = State::Initial;
    let mut acc_value = C4Token::AccTitleValue;
    let mut p = 0usize;
    let mut done = false;
    let mut dir_next: Option<usize> = None;
    let mut dir_exhausted = false;
    let mut line_end = 0usize;
    let mut line_end_valid = false;
    let mut dir_failed = 0usize;

    let mut emit = |kind: C4Token, s: usize, e: usize, p_ref: &mut usize| {
        types.push(kind);
        starts.push(s);
        ends.push(e);
        *p_ref = e;
    };

    let match_statement = |word: &str, at: usize| -> Option<usize> {
        if !src[at..].starts_with(word) {
            return None;
        }
        let ws_pos = at + word.len();
        let ch = src.get(ws_pos..)?.chars().next()?;
        if !is_space_char(ch) {
            return None;
        }
        let from = ws_pos + ch.len_utf8();
        let mut q = from;
        while q < n && !matches!(bytes[q], b'#' | b'\n' | b';') {
            q += 1;
        }
        (q > from).then_some(q)
    };

    loop {
        if done {
            emit(C4Token::End, n, n, &mut p);
            break;
        }
        if p >= n {
            done = true;
        }
        let b = bytes.get(p).copied();

        match state {
            State::Initial => {
                if p >= n {
                    emit(C4Token::Eof, n, n, &mut p);
                    continue;
                }
                if !dir_exhausted && p >= dir_failed {
                    if dir_next.is_none_or(|dn| dn < p) {
                        match src[p..].find("direction") {
                            Some(rel) => dir_next = Some(p + rel),
                            None => dir_exhausted = true,
                        }
                    }
                    if let Some(dn) = dir_next
                        && !dir_exhausted
                    {
                        if !line_end_valid || line_end < p {
                            line_end = find_line_end(src, p);
                            line_end_valid = true;
                        }
                        if dn < line_end {
                            if let Some((tok, end)) = match_direction(src, p, line_end) {
                                emit(tok, p, end, &mut p);
                                continue;
                            }
                            dir_failed = line_end;
                        }
                    }
                }
                let c = b.unwrap();
                if c == b't' {
                    if let Some(end) = match_bare_title(src, p) {
                        p = end;
                        continue;
                    }
                    if let Some(end) = match_statement("title", p) {
                        emit(C4Token::Title, p, end, &mut p);
                        continue;
                    }
                }
                if c == b'a' {
                    if let Some(end) = match_statement("accDescription", p) {
                        emit(C4Token::AccDescription, p, end, &mut p);
                        continue;
                    }
                    let is_title = src[p..].starts_with("accTitle");
                    if is_title || src[p..].starts_with("accDescr") {
                        let q = skip_ws(src, p + 8);
                        match bytes.get(q) {
                            Some(&b':') => {
                                let after = skip_ws(src, q + 1);
                                emit(if is_title { C4Token::AccTitle } else { C4Token::AccDescr }, p, after, &mut p);
                                acc_value = if is_title { C4Token::AccTitleValue } else { C4Token::AccDescrValue };
                                state = State::Acc;
                                continue;
                            }
                            Some(&b'{') if !is_title => {
                                p = skip_ws(src, q + 1);
                                state = State::AccDescrMultiline;
                                continue;
                            }
                            _ => {}
                        }
                    }
                }
                if c == b'%' && bytes.get(p + 1) == Some(&b'%') {
                    let mut q = up_to(src, b'\n', p + 2);
                    while q < n && matches!(bytes[q], b'\n' | b'\r') {
                        q += 1;
                    }
                    p = q;
                    continue;
                }
                if let Some(ch) = src[p..].chars().next()
                    && is_space_char(ch)
                {
                    let mut q = p;
                    let mut last_nl: Option<usize> = None;
                    while q < n
                        && let Some(d) = src[q..].chars().next()
                        && is_space_char(d)
                    {
                        if d == '\n' {
                            last_nl = Some(q);
                        }
                        q += d.len_utf8();
                    }
                    if let Some(nl) = last_nl {
                        emit(C4Token::Newline, p, nl + 1, &mut p);
                    } else {
                        p = q;
                    }
                    continue;
                }
                if c == b'{' {
                    emit(C4Token::LBrace, p, p + 1, &mut p);
                    continue;
                }
                if c == b'}' {
                    emit(C4Token::RBrace, p, p + 1, &mut p);
                    continue;
                }
                if is_word(c as u32) {
                    let mut q = p + 1;
                    while q < n && is_word(bytes[q] as u32) {
                        q += 1;
                    }
                    if q - p <= 19
                        && let Some(kind) = keyword_token(&src[p..q])
                    {
                        if !kind.is_header() {
                            state = State::Struct;
                        }
                        emit(kind, p, q, &mut p);
                        continue;
                    }
                }
                emit(C4Token::Error, p, p, &mut p);
                break;
            }
            State::Struct => {
                if p >= n {
                    emit(C4Token::EofInStruct, n, n, &mut p);
                } else if b == Some(b'(') {
                    let mut q = p + 1;
                    while bytes.get(q) == Some(&b' ') {
                        q += 1;
                    }
                    if bytes.get(q) == Some(&b',') {
                        emit(C4Token::AttributeEmpty, p, q + 1, &mut p);
                    } else {
                        p += 1;
                    }
                    state = State::Attribute;
                } else if b == Some(b')') {
                    p += 1;
                    state = State::Initial;
                } else {
                    emit(C4Token::Error, p, p, &mut p);
                    break;
                }
            }
            State::Attribute => {
                if p >= n {
                    continue;
                }
                if b == Some(b')') {
                    p += 1;
                    state = State::Initial;
                } else if b == Some(b',') {
                    if bytes.get(p + 1) == Some(&b',') {
                        emit(C4Token::AttributeEmpty, p, p + 2, &mut p);
                    } else {
                        p += 1;
                    }
                } else {
                    let mut q = p;
                    while bytes.get(q) == Some(&b' ') {
                        q += 1;
                    }
                    let d = bytes.get(q).copied();
                    if d == Some(b'"') {
                        if bytes.get(q + 1) == Some(&b'"') {
                            emit(C4Token::AttributeEmpty, p, q + 2, &mut p);
                        } else {
                            p = q + 1;
                            state = State::String;
                        }
                    } else if d == Some(b'$') {
                        p = q + 1;
                        state = State::StringKv;
                    } else {
                        let end = up_to(src, b',', p);
                        emit(C4Token::Str, p, end, &mut p);
                    }
                }
            }
            State::String => {
                if b == Some(b'"') {
                    p += 1;
                    state = State::Attribute;
                } else {
                    let end = up_to(src, b'"', p);
                    emit(C4Token::Str, p, end, &mut p);
                }
            }
            State::StringKv => {
                let end = up_to(src, b'=', p);
                emit(C4Token::StrKey, p, end, &mut p);
                state = State::StringKvKey;
            }
            State::StringKvKey => {
                if p >= n {
                    continue;
                }
                let mut q = p + 1;
                if b == Some(b'=') {
                    while bytes.get(q) == Some(&b' ') {
                        q += 1;
                    }
                }
                if b != Some(b'=') || bytes.get(q) != Some(&b'"') {
                    emit(C4Token::Error, p, p, &mut p);
                    break;
                }
                p = q + 1;
                state = State::StringKvValue;
            }
            State::StringKvValue => {
                if p >= n {
                    continue;
                }
                if b == Some(b'"') {
                    p += 1;
                    state = State::Attribute;
                } else {
                    let end = up_to(src, b'"', p);
                    emit(C4Token::StrValue, p, end, &mut p);
                }
            }
            State::Acc => {
                let end = up_to(src, b'\n', p);
                emit(acc_value, p, end, &mut p);
                state = State::Initial;
            }
            State::AccDescrMultiline => {
                if b == Some(b'}') {
                    p += 1;
                    state = State::Initial;
                } else {
                    let end = up_to(src, b'}', p);
                    emit(C4Token::AccDescrMultilineValue, p, end, &mut p);
                }
            }
        }
    }

    C4Tokens { types, starts, ends }
}
