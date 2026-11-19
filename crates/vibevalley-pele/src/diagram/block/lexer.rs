use crate::util::chars::{is_space_char, is_word};

use super::tokens::BlockToken;

pub struct BlockTokens {
    pub types: Vec<BlockToken>,
    pub texts: Vec<String>,
    pub starts: Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Initial,
    StringLit,
    MdString,
    Node,
    BlockArrow,
    ArrowDir,
    LLabel,
    ClassDef,
    ClassDefId,
    Class,
    ClassStyle,
    StyleStmnt,
    StyleDefinition,
    AccTitle,
    AccDescr,
    AccDescrMultiline,
}

const DIRECTIONS: &[&str] = &["right", "left", "x", "y", "up", "down"];

/// Characters that end a node id: ( ) [ { } < > - : = and whitespace.
const ID_STOP: [bool; 128] = {
    let mut t = [false; 128];
    let stop = [9u8, 10, 11, 12, 13, 32, 40, 41, 45, 58, 60, 61, 62, 91, 123, 125];
    let mut i = 0;
    while i < stop.len() {
        t[stop[i] as usize] = true;
        i += 1;
    }
    t
};

#[inline]
fn next_char(src: &str, p: usize) -> Option<(char, usize)> {
    let ch = src[p..].chars().next()?;
    Some((ch, ch.len_utf8()))
}

#[inline]
fn is_space_at(src: &str, p: usize) -> bool {
    let bytes = src.as_bytes();
    if p >= bytes.len() {
        return false;
    }
    let b = bytes[p];
    if b < 128 {
        matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c)
    } else {
        next_char(src, p).is_some_and(|(ch, _)| is_space_char(ch))
    }
}

fn ws(src: &str, mut q: usize) -> usize {
    let bytes = src.as_bytes();
    let n = bytes.len();
    while q < n {
        let b = bytes[q];
        if b < 128 {
            if matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c) {
                q += 1;
            } else {
                break;
            }
        } else if let Some((ch, len)) = next_char(src, q)
            && is_space_char(ch)
        {
            q += len;
        } else {
            break;
        }
    }
    q
}

fn digits(src: &str, mut q: usize) -> usize {
    let bytes = src.as_bytes();
    while q < bytes.len() && bytes[q].is_ascii_digit() {
        q += 1;
    }
    q
}

fn word(src: &str, mut q: usize) -> usize {
    let bytes = src.as_bytes();
    while q < bytes.len() && is_word(bytes[q] as u32) {
        q += 1;
    }
    q
}

fn keyword_at(src: &str, p: usize, text: &str) -> bool {
    if !src[p..].starts_with(text) {
        return false;
    }
    src.as_bytes().get(p + text.len()).is_none_or(|&b| !is_word(b as u32))
}

/// End of `.+-[xo>]?` at `q`, or `None`.
fn dotted(src: &str, mut q: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    if bytes.get(q) != Some(&b'.') {
        return None;
    }
    q += 1;
    while bytes.get(q) == Some(&b'.') {
        q += 1;
    }
    if bytes.get(q) != Some(&b'-') {
        return None;
    }
    match bytes.get(q + 1) {
        Some(b'x' | b'o' | b'>') => Some(q + 2),
        _ => Some(q + 1),
    }
}

/// End of a complete link at `q`, before its trailing whitespace, or `None`.
fn link_end(src: &str, mut q: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    if matches!(bytes.get(q), Some(b'x' | b'o' | b'<')) {
        q += 1;
    }
    let line = *bytes.get(q)?;
    if line == b'.' {
        return dotted(src, q);
    }
    if line != b'-' && line != b'=' {
        return None;
    }
    let mut k = q + 1;
    while bytes.get(k) == Some(&line) {
        k += 1;
    }
    if k - q == 1 {
        return if line == b'-' { dotted(src, k) } else { None };
    }
    if matches!(bytes.get(k), Some(b'x' | b'o' | b'>')) {
        return Some(k + 1);
    }
    if k - q >= 3 { Some(k) } else { None }
}

pub fn tokenize(src: &str) -> BlockTokens {
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut types: Vec<BlockToken> = Vec::new();
    let mut texts: Vec<String> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    let mut stack: Vec<State> = Vec::new();
    let mut state = State::Initial;
    let mut p = 0usize;

    macro_rules! put {
        ($kind:expr, $text:expr, $end:expr) => {{
            types.push($kind);
            texts.push($text);
            starts.push(p);
            p = $end;
        }};
    }

    macro_rules! emit {
        ($kind:expr, $end:expr) => {{
            let end = $end;
            put!($kind, src[p..end].to_string(), end);
        }};
    }

    macro_rules! push_state {
        ($s:expr) => {{
            stack.push(state);
            state = $s;
        }};
    }

    macro_rules! pop_state {
        () => {{
            if let Some(prev) = stack.pop() {
                state = prev;
            }
        }};
    }

    macro_rules! quote {
        () => {{
            if bytes.get(p + 1) == Some(&b'`') {
                push_state!(State::MdString);
                p += 2;
            } else {
                push_state!(State::StringLit);
                p += 1;
            }
        }};
    }

    macro_rules! line_state {
        ($kind:expr) => {{
            let end = src[p..].find('\n').map_or(n, |rel| p + rel);
            pop_state!();
            emit!($kind, end);
        }};
    }

    loop {
        if p >= n {
            let eof_tok = match state {
                State::Initial => Some(BlockToken::Eof),
                State::StringLit => Some(BlockToken::Str),
                State::ClassDefId => Some(BlockToken::ClassDefStyleOpts),
                State::ClassStyle => Some(BlockToken::StyleClass),
                State::StyleDefinition => Some(BlockToken::StyleDefinitionData),
                State::AccTitle => Some(BlockToken::AccTitleValue),
                State::AccDescr => Some(BlockToken::AccDescrValue),
                State::AccDescrMultiline => Some(BlockToken::AccDescrMultilineValue),
                State::MdString | State::Node | State::BlockArrow | State::ArrowDir | State::LLabel | State::ClassDef | State::Class | State::StyleStmnt => {
                    None
                }
            };
            if let Some(tok) = eof_tok {
                types.push(tok);
                texts.push(String::new());
                starts.push(n);
            }
            break;
        }

        let b = bytes[p];
        let mut ok = true;

        match state {
            State::Initial => {
                if is_space_at(src, p) {
                    let next = if b < 128 { p + 1 } else { p + next_char(src, p).map_or(1, |(_, len)| len) };
                    p = ws(src, next);
                    continue;
                }
                let mut handled = false;
                match b {
                    b'b' => {
                        if src[p..].starts_with("block") {
                            if keyword_at(src, p, "block-beta") {
                                emit!(BlockToken::Key, p + 10);
                                handled = true;
                            } else if bytes.get(p + 5) == Some(&b':') {
                                emit!(BlockToken::IdBlock, p + 6);
                                handled = true;
                            } else if bytes.get(p + 5).is_none_or(|&ch| !is_word(ch as u32)) {
                                emit!(BlockToken::Key, p + 5);
                                handled = true;
                            }
                        }
                    }
                    b'c' => {
                        if src[p..].starts_with("columns") {
                            let q = ws(src, p + 7);
                            if q > p + 7 {
                                if keyword_at(src, q, "auto") {
                                    put!(BlockToken::Columns, "-1".to_string(), q + 4);
                                    handled = true;
                                } else {
                                    let e = digits(src, q);
                                    if e > q {
                                        put!(BlockToken::Columns, src[q..e].to_string(), e);
                                        handled = true;
                                    }
                                }
                            }
                        } else if src[p..].starts_with("class") {
                            let def = src[p + 5..].starts_with("Def");
                            let from = if def { p + 8 } else { p + 5 };
                            let q = ws(src, from);
                            if q > from {
                                push_state!(if def { State::ClassDef } else { State::Class });
                                emit!(if def { BlockToken::ClassDef } else { BlockToken::Class }, q);
                                handled = true;
                            }
                        }
                    }
                    b'"' => {
                        quote!();
                        handled = true;
                    }
                    b's' => {
                        if src[p..].starts_with("space") {
                            if bytes.get(p + 5) == Some(&b':') {
                                let e = digits(src, p + 6);
                                if e > p + 6 {
                                    put!(BlockToken::SpaceBlock, src[p + 6..e].to_string(), e);
                                    handled = true;
                                }
                            }
                            if !handled && bytes.get(p + 5).is_none_or(|&ch| !is_word(ch as u32)) {
                                put!(BlockToken::SpaceBlock, "1".to_string(), p + 5);
                                handled = true;
                            }
                        } else if src[p..].starts_with("style") {
                            let q = ws(src, p + 5);
                            if q > p + 5 {
                                push_state!(State::StyleStmnt);
                                emit!(BlockToken::Style, q);
                                handled = true;
                            }
                        }
                    }
                    b'd' => {
                        if keyword_at(src, p, "default") {
                            emit!(BlockToken::Default, p + 7);
                            handled = true;
                        }
                    }
                    b'l' => {
                        if keyword_at(src, p, "linkStyle") {
                            emit!(BlockToken::LinkStyle, p + 9);
                            handled = true;
                        }
                    }
                    b'i' => {
                        if keyword_at(src, p, "interpolate") {
                            emit!(BlockToken::Interpolate, p + 11);
                            handled = true;
                        }
                    }
                    b'a' => {
                        if src[p..].starts_with("accTitle") {
                            let q = ws(src, p + 8);
                            if bytes.get(q) == Some(&b':') {
                                push_state!(State::AccTitle);
                                emit!(BlockToken::AccTitle, ws(src, q + 1));
                                handled = true;
                            }
                        } else if src[p..].starts_with("accDescr") {
                            let q = ws(src, p + 8);
                            match bytes.get(q) {
                                Some(&b':') => {
                                    push_state!(State::AccDescr);
                                    emit!(BlockToken::AccDescr, ws(src, q + 1));
                                    handled = true;
                                }
                                Some(&b'{') => {
                                    push_state!(State::AccDescrMultiline);
                                    p = ws(src, q + 1);
                                    handled = true;
                                }
                                _ => {}
                            }
                        }
                    }
                    b'e' => {
                        if keyword_at(src, p, "end") {
                            emit!(BlockToken::EndKw, ws(src, p + 3));
                            handled = true;
                        }
                    }
                    b'-' => {
                        if bytes.get(p + 1) == Some(&b')') {
                            push_state!(State::Node);
                            emit!(BlockToken::NodeDStart, p + 2);
                            handled = true;
                        } else {
                            if let Some(e) = link_end(src, p) {
                                emit!(BlockToken::Link, ws(src, e));
                                handled = true;
                            } else {
                                let a = bytes.get(p).copied();
                                let b2 = bytes.get(p + 1).copied();
                                if a == Some(b'-') && matches!(b2, Some(b'-' | b'.')) {
                                    push_state!(State::LLabel);
                                    emit!(BlockToken::StartLink, ws(src, p + 2));
                                    handled = true;
                                } else {
                                    ok = false;
                                    handled = true;
                                }
                            }
                        }
                    }
                    b'=' => {
                        if let Some(e) = link_end(src, p) {
                            emit!(BlockToken::Link, ws(src, e));
                            handled = true;
                        } else if bytes.get(p + 1) == Some(&b'=') {
                            push_state!(State::LLabel);
                            emit!(BlockToken::StartLink, ws(src, p + 2));
                            handled = true;
                        } else {
                            ok = false;
                            handled = true;
                        }
                    }
                    b'<' => {
                        if bytes.get(p + 1) == Some(&b'[') {
                            push_state!(State::BlockArrow);
                            emit!(BlockToken::BlockArrowStart, p + 2);
                            handled = true;
                        } else if let Some(e) = link_end(src, p) {
                            emit!(BlockToken::Link, ws(src, e));
                            handled = true;
                        } else {
                            let q = p + 1;
                            let a = bytes.get(q).copied();
                            let b2 = bytes.get(q + 1).copied();
                            if (a == Some(b'-') && matches!(b2, Some(b'-' | b'.'))) || (a == Some(b'=') && b2 == Some(b'=')) {
                                push_state!(State::LLabel);
                                emit!(BlockToken::StartLink, ws(src, q + 2));
                                handled = true;
                            } else {
                                ok = false;
                                handled = true;
                            }
                        }
                    }
                    b'(' => {
                        let d = bytes.get(p + 1).copied();
                        let len = if matches!(d, Some(b'-' | b'[')) {
                            2
                        } else if d == Some(b'(') {
                            if bytes.get(p + 2) == Some(&b'(') { 3 } else { 2 }
                        } else {
                            1
                        };
                        push_state!(State::Node);
                        emit!(BlockToken::NodeDStart, p + len);
                        handled = true;
                    }
                    b')' | b'{' => {
                        push_state!(State::Node);
                        let end = if bytes.get(p + 1) == Some(&b) { p + 2 } else { p + 1 };
                        emit!(BlockToken::NodeDStart, end);
                        handled = true;
                    }
                    b'>' => {
                        push_state!(State::Node);
                        emit!(BlockToken::NodeDStart, p + 1);
                        handled = true;
                    }
                    b'[' => {
                        let d = bytes.get(p + 1).copied();
                        push_state!(State::Node);
                        let end = if matches!(d, Some(b'[' | b'|' | b'(' | b'\\' | b'/')) { p + 2 } else { p + 1 };
                        emit!(BlockToken::NodeDStart, end);
                        handled = true;
                    }
                    b':' => {
                        let e = digits(src, p + 1);
                        if e > p + 1 {
                            put!(BlockToken::Size, src[p + 1..e].to_string(), e);
                        } else {
                            ok = false;
                        }
                        handled = true;
                    }
                    _ => {}
                }

                if !handled {
                    let mut q = p;
                    while q < n {
                        let ch = bytes[q];
                        if ch < 128 {
                            if ID_STOP[ch as usize] {
                                break;
                            }
                            q += 1;
                        } else if let Some((uc, len)) = next_char(src, q) {
                            if is_space_char(uc) {
                                break;
                            }
                            q += len;
                        } else {
                            break;
                        }
                    }
                    if q > p {
                        emit!(BlockToken::NodeId, q);
                    } else {
                        ok = false;
                    }
                }
            }

            State::StringLit => {
                if b == b'"' {
                    pop_state!();
                    p += 1;
                } else {
                    let end = src[p..].find('"').map_or(n, |rel| p + rel);
                    emit!(BlockToken::Str, end);
                }
            }

            State::MdString => {
                if b == b'`' {
                    ok = bytes.get(p + 1) == Some(&b'"');
                    if ok {
                        pop_state!();
                        p += 2;
                    }
                } else if b == b'"' {
                    ok = false;
                } else {
                    let mut q = p + 1;
                    while q < n && bytes[q] != b'`' && bytes[q] != b'"' {
                        q += 1;
                    }
                    emit!(BlockToken::MdStr, q);
                }
            }

            State::Node => {
                let d = bytes.get(p + 1).copied();
                if b == b'"' {
                    quote!();
                } else {
                    let len = match b {
                        b'(' => {
                            if d == Some(b'-') {
                                2
                            } else if d == Some(b'(') {
                                if bytes.get(p + 2) == Some(&b'(') { 3 } else { 2 }
                            } else {
                                1
                            }
                        }
                        b')' => {
                            if d == Some(b')') {
                                if bytes.get(p + 2) == Some(&b')') { 3 } else { 2 }
                            } else if d == Some(b']') {
                                2
                            } else {
                                1
                            }
                        }
                        b'}' => {
                            if d == Some(b'}') {
                                2
                            } else {
                                1
                            }
                        }
                        b'-' => {
                            if d == Some(b')') {
                                2
                            } else {
                                0
                            }
                        }
                        b']' => {
                            if matches!(d, Some(b']' | b')' | b'>')) {
                                2
                            } else {
                                1
                            }
                        }
                        b'\\' | b'/' if d == Some(b']') => 2,
                        _ => 0,
                    };
                    if len == 0 {
                        ok = false;
                    } else {
                        pop_state!();
                        emit!(BlockToken::NodeDEnd, p + len);
                    }
                }
            }

            State::BlockArrow => {
                if b == b'"' {
                    quote!();
                } else if b == b']' && bytes.get(p + 1) == Some(&b'>') {
                    let q = ws(src, p + 2);
                    ok = bytes.get(q) == Some(&b'(');
                    if ok {
                        push_state!(State::ArrowDir);
                        p = q + 1;
                    }
                } else {
                    ok = false;
                }
            }

            State::ArrowDir => {
                if b == b')' {
                    pop_state!();
                    pop_state!();
                    put!(BlockToken::BlockArrowEnd, "]>".to_string(), ws(src, p + 1));
                } else {
                    let from = ws(src, if b == b',' { p + 1 } else { p });
                    let mut matched = false;
                    for &dir in DIRECTIONS {
                        if src[from..].starts_with(dir) {
                            let e = ws(src, from + dir.len());
                            let start_slice = if b == b',' { from } else { p };
                            put!(BlockToken::Dir, src[start_slice..e].to_string(), e);
                            matched = true;
                            break;
                        }
                    }
                    if !matched {
                        ok = false;
                    }
                }
            }

            State::LLabel => {
                if b == b'"' {
                    if bytes.get(p + 1) == Some(&b'`') {
                        quote!();
                    } else {
                        emit!(BlockToken::LinkLabel, p + 1);
                        push_state!(State::StringLit);
                    }
                } else if let Some(e) = link_end(src, ws(src, p)) {
                    pop_state!();
                    emit!(BlockToken::Link, ws(src, e));
                } else {
                    ok = false;
                }
            }

            State::ClassDef => {
                let mut kind = BlockToken::DefaultClassDefId;
                let mut k = if src[p..].starts_with("DEFAULT") { p + 7 } else { p };
                let mut q = ws(src, k);
                if k == p || q == k {
                    kind = BlockToken::ClassDefId;
                    k = word(src, p);
                    q = ws(src, k);
                }
                ok = k > p && q > k;
                if ok {
                    state = State::ClassDefId;
                    emit!(kind, q);
                }
            }

            State::ClassDefId => {
                line_state!(BlockToken::ClassDefStyleOpts);
            }

            State::Class => {
                let mut k = word(src, p);
                if k == p {
                    ok = false;
                } else {
                    while bytes.get(k) == Some(&b',') {
                        let from = ws(src, k + 1);
                        let to = word(src, from);
                        if to == from {
                            break;
                        }
                        k = to;
                    }
                    state = State::ClassStyle;
                    emit!(BlockToken::ClassEntityIds, k);
                }
            }

            State::ClassStyle => {
                line_state!(BlockToken::StyleClass);
            }

            State::StyleStmnt => {
                let mut k = word(src, p);
                if k == p {
                    ok = false;
                } else {
                    while bytes.get(k) == Some(&b',') {
                        let from = ws(src, k + 1);
                        let to = word(src, from);
                        if to == from {
                            break;
                        }
                        k = to;
                    }
                    state = State::StyleDefinition;
                    emit!(BlockToken::StyleEntityIds, k);
                }
            }

            State::StyleDefinition => {
                line_state!(BlockToken::StyleDefinitionData);
            }

            State::AccTitle => {
                line_state!(BlockToken::AccTitleValue);
            }

            State::AccDescr => {
                line_state!(BlockToken::AccDescrValue);
            }

            State::AccDescrMultiline => {
                if b == b'}' {
                    pop_state!();
                    p += 1;
                } else {
                    let end = src[p..].find('}').map_or(n, |rel| p + rel);
                    emit!(BlockToken::AccDescrMultilineValue, end);
                }
            }
        }

        if !ok {
            types.push(BlockToken::Error);
            texts.push(String::new());
            starts.push(p);
            return BlockTokens { types, texts, starts };
        }
    }

    types.push(BlockToken::End);
    texts.push(String::new());
    starts.push(n);
    BlockTokens { types, texts, starts }
}
