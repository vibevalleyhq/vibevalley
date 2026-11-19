use crate::diagram::common::word_at;
use crate::util::chars::{is_space_char, is_word};

use super::tokens::StateToken;

pub struct StateTokens {
    pub types: Vec<StateToken>,
    pub texts: Vec<String>,
    pub starts: Vec<usize>,
    /// Set when lexing stopped on the grammar's own error rather than unrecognized text.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LexState {
    Initial,
    Struct,
    State,
    StateString,
    StateId,
    Scale,
    AccTitle,
    AccDescr,
    AccDescrMultiline,
    ClassDef,
    ClassDefId,
    Class,
    ClassStyle,
    Style,
    StyleDefStyles,
    Note,
    NoteId,
    NoteText,
    FloatingNote,
    FloatingNoteId,
}

pub fn trim_js(s: &str) -> &str {
    s.trim_matches(is_space_char)
}

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

#[inline]
fn is_word_at(src: &str, p: usize) -> bool {
    src.as_bytes().get(p).is_some_and(|&b| is_word(b as u32))
}

fn ws_end(src: &str, mut j: usize) -> usize {
    let bytes = src.as_bytes();
    let n = bytes.len();
    while j < n {
        let b = bytes[j];
        if b < 128 {
            if matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c) {
                j += 1;
            } else {
                break;
            }
        } else if let Some((ch, len)) = next_char(src, j)
            && is_space_char(ch)
        {
            j += len;
        } else {
            break;
        }
    }
    j
}

fn non_nl_ws_end(src: &str, mut j: usize) -> usize {
    let bytes = src.as_bytes();
    let n = bytes.len();
    while j < n {
        let b = bytes[j];
        if b < 128 {
            if matches!(b, b' ' | b'\t' | b'\r' | 0x0b | 0x0c) {
                j += 1;
            } else {
                break;
            }
        } else if let Some((ch, len)) = next_char(src, j)
            && is_space_char(ch)
        {
            j += len;
        } else {
            break;
        }
    }
    j
}

fn word_end(src: &str, mut j: usize) -> usize {
    let bytes = src.as_bytes();
    while j < bytes.len() && is_word(bytes[j] as u32) {
        j += 1;
    }
    j
}

fn eol(src: &str, q: usize) -> usize {
    src[q..].find('\n').map_or(src.len(), |r| q + r)
}

/// Caches the next match of a forward pattern so repeated per-token lookahead stays linear.
#[derive(Default)]
struct CachedFinder {
    initialized: bool,
    from: usize,
    next: Option<usize>,
}

impl CachedFinder {
    fn find(&mut self, q: usize, scan: impl FnOnce(usize) -> Option<usize>) -> Option<usize> {
        if !self.initialized || q < self.from || self.next.is_some_and(|n| q > n) {
            self.next = scan(q);
            self.from = q;
            self.initialized = true;
        }
        self.next
    }
}

fn find_direction(src: &str, from: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    if from + 9 > bytes.len() {
        return None;
    }
    let last = bytes.len() - 9;
    let mut i = from;
    while i <= last {
        if (bytes[i] | 32) == b'd' && word_at(src, i, "direction") {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn find_stereotype(src: &str, from: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    if from + 8 > bytes.len() {
        return None;
    }
    let last = bytes.len() - 8;
    let mut i = from;
    while i <= last {
        let b = bytes[i];
        if (b == b'<' && bytes[i + 1] == b'<') || (b == b'[' && bytes[i + 1] == b'[') {
            let close = if b == b'<' { b'>' } else { b']' };
            if (word_at(src, i + 2, "fork") || word_at(src, i + 2, "join")) && bytes[i + 6] == close && bytes[i + 7] == close {
                return Some(i);
            }
            if i + 10 <= bytes.len() && word_at(src, i + 2, "choice") && bytes[i + 8] == close && bytes[i + 9] == close {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

fn find_line_end(src: &str, from: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut i = from;
    while i < bytes.len() {
        match bytes[i] {
            b'\n' | b'\r' => return Some(i),
            0xE2 if i + 2 < bytes.len() && bytes[i + 1] == 0x80 && (bytes[i + 2] == 0xA8 || bytes[i + 2] == 0xA9) => {
                return Some(i);
            }
            _ => i += 1,
        }
    }
    None
}

fn find_percent(src: &str, from: usize) -> Option<usize> {
    src[from..].find("%%").map(|r| from + r)
}

fn find_brace(src: &str, from: usize) -> Option<usize> {
    src[from..].find('{').map(|r| from + r)
}

const DIRECTION_TOKENS: [StateToken; 4] = [
    StateToken::DirectionTb,
    StateToken::DirectionBt,
    StateToken::DirectionRl,
    StateToken::DirectionLr,
];

pub fn tokenize(src: &str) -> StateTokens {
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut types = Vec::new();
    let mut texts = Vec::new();
    let mut starts = Vec::new();
    let mut stack = Vec::new();
    let mut state = LexState::Initial;
    let mut p = 0usize;
    let mut error: Option<String> = None;

    let mut next_direction = CachedFinder::default();
    let mut next_stereotype = CachedFinder::default();
    let mut next_line_end = CachedFinder::default();
    let mut next_percent = CachedFinder::default();
    let mut next_brace = CachedFinder::default();

    let mut dir_valid = false;
    let mut dir_from = 0usize;
    let mut dir_to = 0usize;
    let mut dir_at: [Option<usize>; 4] = [None; 4];
    let mut dir_end: [usize; 4] = [0; 4];

    let mut stereo_valid = false;
    let mut stereo_from = 0usize;
    let mut stereo_to = 0usize;
    let mut stereo_at: [Option<usize>; 6] = [None; 6];

    macro_rules! emit {
        ($tok:expr, $s:expr, $e:expr) => {{
            types.push($tok);
            texts.push(src[$s..$e].to_string());
            starts.push($s);
            p = $e;
        }};
    }

    macro_rules! emit_text {
        ($tok:expr, $txt:expr, $s:expr, $e:expr) => {{
            types.push($tok);
            texts.push($txt);
            starts.push($s);
            p = $e;
        }};
    }

    macro_rules! push_state {
        ($st:expr) => {{
            stack.push(state);
            state = $st;
        }};
    }

    macro_rules! pop_state {
        () => {{
            if let Some(prev) = stack.pop() {
                state = prev;
            }
        }};
    }

    macro_rules! finish {
        ($tok:expr) => {{
            types.push($tok);
            texts.push(String::new());
            starts.push(p);
            return StateTokens { types, texts, starts, error };
        }};
    }

    let mut emit_id = |s: usize, e: usize, types: &mut Vec<StateToken>, texts: &mut Vec<String>, starts: &mut Vec<usize>, p: &mut usize| -> bool {
        let at = next_percent.find(s, |q| find_percent(src, q));
        match at {
            None => {
                types.push(StateToken::Id);
                texts.push(src[s..e].to_string());
                starts.push(s);
                *p = e;
                true
            }
            Some(pos) if pos + 2 > e => {
                types.push(StateToken::Id);
                texts.push(src[s..e].to_string());
                starts.push(s);
                *p = e;
                true
            }
            Some(pos) if pos == s => {
                *p = e;
                false
            }
            Some(pos) => {
                types.push(StateToken::Id);
                texts.push(src[s..pos].to_string());
                starts.push(s);
                *p = pos;
                true
            }
        }
    };

    loop {
        if p >= n {
            // Jison runs the current start condition's rules once more on the empty remainder.
            match state {
                LexState::Initial => emit!(StateToken::Nl, n, n),
                LexState::AccTitle => emit!(StateToken::AccTitleValue, n, n),
                LexState::AccDescr => emit!(StateToken::AccDescrValue, n, n),
                LexState::AccDescrMultiline => emit!(StateToken::AccDescrMultilineValue, n, n),
                LexState::ClassDefId => emit!(StateToken::ClassDefStyleOpts, n, n),
                LexState::ClassStyle => emit!(StateToken::StyleClass, n, n),
                LexState::StyleDefStyles => emit!(StateToken::StyleDefStyleOpts, n, n),
                LexState::StateString => emit!(StateToken::StateDescr, n, n),
                LexState::FloatingNote => emit!(StateToken::NoteText, n, n),
                LexState::StateId | LexState::FloatingNoteId => emit!(StateToken::Id, n, n),
                LexState::Struct
                | LexState::State
                | LexState::Scale
                | LexState::ClassDef
                | LexState::Class
                | LexState::Style
                | LexState::Note
                | LexState::NoteId
                | LexState::NoteText => {}
            }
            finish!(StateToken::End);
        }

        let b = bytes[p];
        match state {
            LexState::Initial | LexState::Struct => {
                let root = state == LexState::Initial;
                let lc = b | 32;
                if root {
                    if lc == b'c' && word_at(src, p, "click") && !is_word_at(src, p + 5) {
                        emit!(StateToken::Click, p, p + 5);
                        continue;
                    }
                    if lc == b'h' && word_at(src, p, "href") && !is_word_at(src, p + 4) {
                        emit!(StateToken::Href, p, p + 4);
                        continue;
                    }
                    if b == b'"'
                        && let Some(rel) = src[p + 1..].find('"')
                    {
                        emit!(StateToken::String, p, p + 1 + rel + 1);
                        continue;
                    }
                    if lc == b'd' && word_at(src, p, "default") && !is_word_at(src, p + 7) {
                        emit!(StateToken::Default, p, p + 7);
                        continue;
                    }
                    let dir_kind = {
                        if !dir_valid || p < dir_from || p > dir_to {
                            let first = next_direction.find(p, |q| find_direction(src, q));
                            let end = match first {
                                None => n,
                                Some(_) => next_line_end.find(p, |q| find_line_end(src, q)).unwrap_or(n),
                            };
                            dir_valid = true;
                            dir_from = p;
                            dir_to = end;
                            dir_at = [None; 4];
                            let mut cur = first;
                            while let Some(d) = cur {
                                if d >= end {
                                    break;
                                }
                                let w = ws_end(src, d + 9);
                                if w > d + 9 {
                                    let kind = if word_at(src, w, "tb") {
                                        Some(0)
                                    } else if word_at(src, w, "bt") {
                                        Some(1)
                                    } else if word_at(src, w, "rl") {
                                        Some(2)
                                    } else if word_at(src, w, "lr") {
                                        Some(3)
                                    } else {
                                        None
                                    };
                                    if let Some(k) = kind {
                                        dir_at[k] = Some(d);
                                        dir_end[k] = w + 2;
                                    }
                                }
                                cur = next_direction.find(d + 1, |q| find_direction(src, q));
                            }
                        }
                        (0..4).find(|&k| dir_at[k].is_some_and(|at| at >= p))
                    };
                    if let Some(kind) = dir_kind {
                        emit!(DIRECTION_TOKENS[kind], p, eol(src, dir_end[kind]));
                        continue;
                    }
                    if b == b'\n' {
                        let mut j = p + 1;
                        while j < n && bytes[j] == b'\n' {
                            j += 1;
                        }
                        emit!(StateToken::Nl, p, j);
                        continue;
                    }
                    if is_space_at(src, p) {
                        p = ws_end(src, p);
                        continue;
                    }
                } else if b != b'\n' && is_space_at(src, p) {
                    p = non_nl_ws_end(src, p);
                    continue;
                }

                if b == b'#' || (b == b'%' && bytes.get(p + 1) == Some(&b'%') && bytes.get(p + 2) != Some(&b'{')) {
                    p = eol(src, p);
                    continue;
                }

                if lc == b's' {
                    if root && word_at(src, p, "scale") {
                        let e = ws_end(src, p + 5);
                        if e > p + 5 {
                            emit!(StateToken::Scale, p, e);
                            push_state!(LexState::Scale);
                            continue;
                        }
                    }
                    if word_at(src, p, "style") {
                        let e = ws_end(src, p + 5);
                        if e > p + 5 {
                            emit!(StateToken::Style, p, e);
                            push_state!(LexState::Style);
                            continue;
                        }
                    }
                    if word_at(src, p, "state") {
                        let e = ws_end(src, p + 5);
                        if e > p + 5 {
                            p = e;
                            push_state!(LexState::State);
                            continue;
                        }
                        if root && word_at(src, p + 5, "diagram") {
                            let from = if word_at(src, p + 12, "-v2") { p + 15 } else { p + 12 };
                            let e = ws_end(src, from);
                            if e > from {
                                emit!(StateToken::Sd, p, e);
                                continue;
                            }
                        }
                    }
                } else if lc == b'c' {
                    if word_at(src, p, "class") {
                        let def = word_at(src, p + 5, "def");
                        let from = if def { p + 8 } else { p + 5 };
                        let e = ws_end(src, from);
                        if e > from {
                            emit!(if def { StateToken::ClassDef } else { StateToken::Class }, p, e);
                            push_state!(if def { LexState::ClassDef } else { LexState::Class });
                            continue;
                        }
                    }
                } else if lc == b'a' && root && (word_at(src, p, "acctitle") || word_at(src, p, "accdescr")) {
                    let is_title = (bytes[p + 3] | 32) == b't';
                    let q = ws_end(src, p + 8);
                    let d = bytes.get(q).copied();
                    if d == Some(b':') {
                        emit!(if is_title { StateToken::AccTitle } else { StateToken::AccDescr }, p, ws_end(src, q + 1));
                        push_state!(if is_title { LexState::AccTitle } else { LexState::AccDescr });
                        continue;
                    }
                    if d == Some(b'{') && !is_title {
                        p = ws_end(src, q + 1);
                        push_state!(LexState::AccDescrMultiline);
                        continue;
                    }
                }

                if root {
                    if b == b'{' {
                        emit!(StateToken::StructStart, p, p + 1);
                        push_state!(LexState::Struct);
                        continue;
                    }
                } else {
                    let dir_kind = {
                        if !dir_valid || p < dir_from || p > dir_to {
                            let first = next_direction.find(p, |q| find_direction(src, q));
                            let end = match first {
                                None => n,
                                Some(_) => next_line_end.find(p, |q| find_line_end(src, q)).unwrap_or(n),
                            };
                            dir_valid = true;
                            dir_from = p;
                            dir_to = end;
                            dir_at = [None; 4];
                            let mut cur = first;
                            while let Some(d) = cur {
                                if d >= end {
                                    break;
                                }
                                let w = ws_end(src, d + 9);
                                if w > d + 9 {
                                    let kind = if word_at(src, w, "tb") {
                                        Some(0)
                                    } else if word_at(src, w, "bt") {
                                        Some(1)
                                    } else if word_at(src, w, "rl") {
                                        Some(2)
                                    } else if word_at(src, w, "lr") {
                                        Some(3)
                                    } else {
                                        None
                                    };
                                    if let Some(k) = kind {
                                        dir_at[k] = Some(d);
                                        dir_end[k] = w + 2;
                                    }
                                }
                                cur = next_direction.find(d + 1, |q| find_direction(src, q));
                            }
                        }
                        (0..4).find(|&k| dir_at[k].is_some_and(|at| at >= p))
                    };
                    if let Some(kind) = dir_kind {
                        emit!(DIRECTION_TOKENS[kind], p, eol(src, dir_end[kind]));
                        continue;
                    }
                    if b == b'}' {
                        emit!(StateToken::StructStop, p, p + 1);
                        pop_state!();
                        continue;
                    }
                    if b == b'\n' {
                        p += 1;
                        continue;
                    }
                }

                if lc == b'n' && word_at(src, p, "note") {
                    let e = ws_end(src, p + 4);
                    if e > p + 4 {
                        emit!(StateToken::Note, p, e);
                        push_state!(LexState::Note);
                        continue;
                    }
                }
                if root && lc == b'h' && word_at(src, p, "hide empty description") && !is_word_at(src, p + 22) {
                    emit!(StateToken::HideEmpty, p, p + 22);
                    continue;
                }
                if b == b'[' && bytes.get(p + 1) == Some(&b'*') && bytes.get(p + 2) == Some(&b']') {
                    emit!(StateToken::EdgeState, p, p + 3);
                    continue;
                }

                let mut j = p;
                while j < n {
                    let db = bytes[j];
                    if db < 128 {
                        if db == b':' || db == b'-' || db == b'{' || matches!(db, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c) {
                            break;
                        }
                        j += 1;
                    } else if let Some((ch, len)) = next_char(src, j) {
                        if is_space_char(ch) {
                            break;
                        }
                        j += len;
                    } else {
                        break;
                    }
                }
                if j > p {
                    emit_id(p, j, &mut types, &mut texts, &mut starts, &mut p);
                    continue;
                }

                if b == b':' {
                    j = p + 1;
                    while j < n {
                        let db = bytes[j];
                        if db == b'\n' || db == b';' {
                            break;
                        }
                        if db == b':' {
                            if j + 1 >= n {
                                break;
                            }
                            let after = bytes[j + 1];
                            if after == b':' || after == b'\n' || after == b';' {
                                break;
                            }
                            let next_len = next_char(src, j + 1).map_or(1, |(_, len)| len);
                            j += 1 + next_len;
                            continue;
                        }
                        if db < 128 {
                            j += 1;
                        } else {
                            let len = next_char(src, j).map_or(1, |(_, len)| len);
                            j += len;
                        }
                    }
                    if j > p + 1 {
                        emit_text!(StateToken::Descr, trim_js(&src[p..j]).to_string(), p, j);
                        continue;
                    }
                    if bytes.get(p + 1) == Some(&b':') && bytes.get(p + 2) == Some(&b':') {
                        emit!(StateToken::StyleSeparator, p, p + 3);
                        continue;
                    }
                } else if b == b'-' && bytes.get(p + 1) == Some(&b'-') {
                    if bytes.get(p + 2) == Some(&b'>') {
                        emit!(StateToken::Arrow, p, p + 3);
                        continue;
                    }
                    if !root {
                        emit!(StateToken::Concurrent, p, p + 2);
                        continue;
                    }
                }

                if !root {
                    finish!(StateToken::Error);
                }
                let char_len = next_char(src, p).map_or(1, |(_, len)| len);
                emit!(StateToken::Invalid, p, p + char_len);
            }

            LexState::State => {
                if b != b'\n' && is_space_at(src, p) {
                    p = non_nl_ws_end(src, p);
                    continue;
                }
                if b == b'#' || (b == b'%' && bytes.get(p + 1) == Some(&b'%') && bytes.get(p + 2) != Some(&b'{')) {
                    p = eol(src, p);
                    continue;
                }
                let stereo_kind = {
                    if !stereo_valid || p < stereo_from || p > stereo_to {
                        let first = next_stereotype.find(p, |q| find_stereotype(src, q));
                        let end = match first {
                            None => n,
                            Some(_) => next_line_end.find(p, |q| find_line_end(src, q)).unwrap_or(n),
                        };
                        stereo_valid = true;
                        stereo_from = p;
                        stereo_to = end;
                        stereo_at = [None; 6];
                        let mut cur = first;
                        while let Some(d) = cur {
                            if d >= end {
                                break;
                            }
                            let letter = bytes[d + 2] | 32;
                            let base = if bytes[d] == b'<' { 0 } else { 3 };
                            let offset = if letter == b'f' {
                                0
                            } else if letter == b'j' {
                                1
                            } else {
                                2
                            };
                            stereo_at[base + offset] = Some(d);
                            cur = next_stereotype.find(d + 1, |q| find_stereotype(src, q));
                        }
                    }
                    (0..6).find(|&k| stereo_at[k].is_some_and(|at| at >= p))
                };
                if let Some(kind) = stereo_kind {
                    let at = stereo_at[kind].expect("matched stereotype position");
                    let choice = kind == 2 || kind == 5;
                    let tok = if choice {
                        StateToken::Choice
                    } else if kind % 3 == 0 {
                        StateToken::Fork
                    } else {
                        StateToken::Join
                    };
                    emit_text!(tok, trim_js(&src[p..at]).to_string(), p, at + if choice { 10 } else { 8 });
                    pop_state!();
                    continue;
                }
                if b == b'"' {
                    p += 1;
                    push_state!(LexState::StateString);
                    continue;
                }
                let q = if b == b'\n' { ws_end(src, p) } else { p };
                if word_at(src, q, "as") {
                    let e = ws_end(src, q + 2);
                    if e > q + 2 {
                        emit!(StateToken::As, p, e);
                        push_state!(LexState::StateId);
                        continue;
                    }
                }
                if b == b'\n' {
                    p += 1;
                    pop_state!();
                    continue;
                }
                if b == b'{' {
                    emit!(StateToken::StructStart, p, p + 1);
                    pop_state!();
                    push_state!(LexState::Struct);
                    continue;
                }
                if is_word(b as u32) {
                    let first = word_end(src, p);
                    let second = ws_end(src, first);
                    if second > first
                        && is_word_at(src, second)
                        && let Some(brace) = next_brace.find(second + 1, |q| find_brace(src, q))
                    {
                        let le = next_line_end.find(second, |q| find_line_end(src, q)).unwrap_or(n);
                        if brace < le {
                            error = Some(format!("Error: State name must be a single word. Found: \"{}\"", trim_js(&src[p..=brace])));
                            finish!(StateToken::Error);
                        }
                    }
                }
                let first_len = next_char(src, p).map_or(1, |(_, len)| len);
                let mut j = p + first_len;
                while j < n {
                    let db = bytes[j];
                    if db < 128 {
                        if db == b'{' || matches!(db, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c) {
                            break;
                        }
                        j += 1;
                    } else if let Some((ch, len)) = next_char(src, j) {
                        if is_space_char(ch) {
                            break;
                        }
                        j += len;
                    } else {
                        break;
                    }
                }
                emit!(StateToken::CompositState, p, j);
            }

            LexState::StateString => {
                if b == b'"' {
                    p += 1;
                    pop_state!();
                    continue;
                }
                let close = src[p..].find('"').map_or(n, |r| p + r);
                emit!(StateToken::StateDescr, p, close);
            }

            LexState::StateId => {
                let mut j = p;
                while j < n && bytes[j] != b'\n' && bytes[j] != b'{' {
                    j += 1;
                }
                if emit_id(p, j, &mut types, &mut texts, &mut starts, &mut p) {
                    pop_state!();
                }
            }

            LexState::Scale => {
                if b.is_ascii_digit() {
                    let mut j = p + 1;
                    while j < n && bytes[j].is_ascii_digit() {
                        j += 1;
                    }
                    emit!(StateToken::Width, p, j);
                    continue;
                }
                let q = ws_end(src, p);
                if q > p && word_at(src, q, "width") && !is_word_at(src, q + 5) {
                    p = q + 5;
                    pop_state!();
                    continue;
                }
                finish!(StateToken::Error);
            }

            LexState::AccTitle => {
                emit!(StateToken::AccTitleValue, p, eol(src, p));
                pop_state!();
            }

            LexState::AccDescr => {
                emit!(StateToken::AccDescrValue, p, eol(src, p));
                pop_state!();
            }

            LexState::AccDescrMultiline => {
                if b == b'}' {
                    p += 1;
                    pop_state!();
                    continue;
                }
                let close = src[p..].find('}').map_or(n, |r| p + r);
                emit!(StateToken::AccDescrMultilineValue, p, close);
            }

            LexState::ClassDef => {
                let is_default = word_at(src, p, "default") && ws_end(src, p + 7) > p + 7;
                let j = if is_default { p + 7 } else { word_end(src, p) };
                let e = ws_end(src, j);
                if j == p || e == j {
                    finish!(StateToken::Error);
                }
                emit!(if is_default { StateToken::DefaultClassDefId } else { StateToken::ClassDefId }, p, e);
                pop_state!();
                push_state!(LexState::ClassDefId);
            }

            LexState::ClassDefId => {
                emit!(StateToken::ClassDefStyleOpts, p, eol(src, p));
                pop_state!();
            }

            LexState::Class => {
                let mut j = word_end(src, p);
                if j == p {
                    finish!(StateToken::Error);
                }
                while bytes.get(j) == Some(&b',') {
                    let k = ws_end(src, j + 1);
                    let e = word_end(src, k);
                    if e == k {
                        break;
                    }
                    j = e;
                }
                emit!(StateToken::ClassEntityIds, p, j);
                pop_state!();
                push_state!(LexState::ClassStyle);
            }

            LexState::ClassStyle => {
                emit!(StateToken::StyleClass, p, eol(src, p));
                pop_state!();
            }

            LexState::Style => {
                let mut j = p;
                while j < n && (is_word(bytes[j] as u32) || bytes[j] == b',') {
                    j += 1;
                }
                let e = ws_end(src, j);
                if j == p || e == j {
                    finish!(StateToken::Error);
                }
                emit!(StateToken::StyleIds, p, e);
                pop_state!();
                push_state!(LexState::StyleDefStyles);
            }

            LexState::StyleDefStyles => {
                emit!(StateToken::StyleDefStyleOpts, p, eol(src, p));
                pop_state!();
            }

            LexState::Note => {
                if word_at(src, p, "left of") && !is_word_at(src, p + 7) {
                    emit!(StateToken::LeftOf, p, p + 7);
                    pop_state!();
                    push_state!(LexState::NoteId);
                    continue;
                }
                if word_at(src, p, "right of") && !is_word_at(src, p + 8) {
                    emit!(StateToken::RightOf, p, p + 8);
                    pop_state!();
                    push_state!(LexState::NoteId);
                    continue;
                }
                if b == b'"' {
                    p += 1;
                    pop_state!();
                    push_state!(LexState::FloatingNote);
                    continue;
                }
                finish!(StateToken::Error);
            }

            LexState::NoteId => {
                let q = ws_end(src, p);
                let mut j = q;
                while j < n {
                    let db = bytes[j];
                    if db < 128 {
                        if db == b':' || db == b'-' || matches!(db, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c) {
                            break;
                        }
                        j += 1;
                    } else if let Some((ch, len)) = next_char(src, j) {
                        if is_space_char(ch) {
                            break;
                        }
                        j += len;
                    } else {
                        break;
                    }
                }
                if j == q {
                    finish!(StateToken::Error);
                }
                if emit_id(p, j, &mut types, &mut texts, &mut starts, &mut p) {
                    pop_state!();
                    push_state!(LexState::NoteText);
                }
            }

            LexState::NoteText => {
                let q = ws_end(src, p);
                if bytes.get(q) == Some(&b':') {
                    let mut j = q + 1;
                    while j < n {
                        let db = bytes[j];
                        if db == b':' || db == b'\n' || db == b';' {
                            break;
                        }
                        j += 1;
                    }
                    if j > q + 1 {
                        // Mermaid drops two characters here, expecting " :"; with no space before the colon
                        // the first character of the note goes too.
                        let mut chars = src[p..j].chars();
                        chars.next();
                        chars.next();
                        emit_text!(StateToken::NoteText, trim_js(chars.as_str()).to_string(), p, j);
                        pop_state!();
                        continue;
                    }
                }
                let mut k = src[p..].find('\n').map(|r| p + r);
                let mut e = 0usize;
                let mut found = false;
                while let Some(nl) = k {
                    e = ws_end(src, nl);
                    if word_at(src, e, "end note") && !is_word_at(src, e + 8) {
                        found = true;
                        break;
                    }
                    k = src[e..].find('\n').map(|r| e + r);
                }
                if !found {
                    finish!(StateToken::Error);
                }
                emit_text!(StateToken::NoteText, trim_js(&src[p..e]).to_string(), p, e + 8);
                pop_state!();
            }

            LexState::FloatingNote => {
                let q = ws_end(src, p);
                if word_at(src, q, "as") {
                    emit!(StateToken::As, p, ws_end(src, q + 2));
                    pop_state!();
                    push_state!(LexState::FloatingNoteId);
                    continue;
                }
                if b == b'"' {
                    p += 1;
                    continue;
                }
                let close = src[p..].find('"').map_or(n, |r| p + r);
                emit!(StateToken::NoteText, p, close);
            }

            LexState::FloatingNoteId => {
                if emit_id(p, eol(src, p), &mut types, &mut texts, &mut starts, &mut p) {
                    pop_state!();
                }
            }
        }
    }
}
