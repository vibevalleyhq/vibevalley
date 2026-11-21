use crate::util::chars::{is_digit, is_space_char, is_word};

use super::tokens::SeqToken;

pub struct SeqTokens {
    pub types: Vec<SeqToken>,
    pub texts: Vec<String>,
    pub starts: Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Initial,
    Id,
    Alias,
    Line,
    Config,
    AccTitle,
    AccDescr,
    AccDescrMultiline,
}

const C_ACTOR_START: u8 = 1;
const C_ACTOR_REST: u8 = 2;
const C_ID: u8 = 4;
const C_ID_WIDE: u8 = 8;
const C_LINE: u8 = 16;
const C_MENU: u8 = 32;

const CLASS: [u8; 128] = {
    let mut t = [0u8; 128];
    let mut c = 0usize;
    while c < 128 {
        let b = c as u8;
        let ws = b == b' ' || (b >= 9 && b <= 13);
        let mut bits = 0u8;
        if !matches!(b, b'/' | b'\\' | b'+' | b'(' | b')' | b'<' | b'-' | b'>' | b':' | b'\n' | b',' | b';') {
            bits |= C_ACTOR_START;
        }
        if !matches!(b, b'+' | b'<' | b'-' | b'>' | b':' | b'\n' | b',' | b';') {
            bits |= C_ACTOR_REST;
        }
        if !matches!(b, b'<' | b'>' | b':' | b'\n' | b',' | b';' | b'@') {
            bits |= C_ID_WIDE;
            if !ws {
                bits |= C_ID;
            }
        }
        if !matches!(b, b'#' | b'\n' | b';') {
            bits |= C_LINE;
        }
        if !ws && !matches!(b, b'/' | b'\\' | b'+' | b'(' | b')' | b'<' | b'>' | b':' | b'\n' | b',' | b';' | b'-') {
            bits |= C_MENU;
        }
        t[c] = bits;
        c += 1;
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

pub fn tokenize(src: &str) -> SeqTokens {
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut types: Vec<SeqToken> = Vec::new();
    let mut texts: Vec<String> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    let mut stack: Vec<State> = Vec::new();
    let mut state = State::Initial;
    let mut p = 0usize;
    let mut next_nl: Option<usize> = None;

    macro_rules! emit {
        ($t:expr, $s:expr, $e:expr) => {{
            types.push($t);
            texts.push(src[$s..$e].to_string());
            starts.push($s);
            p = $e;
        }};
    }
    macro_rules! emit_text {
        ($t:expr, $s:expr, $e:expr, $txt:expr) => {{
            types.push($t);
            texts.push($txt);
            starts.push($s);
            p = $e;
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

    let eol = |q: usize, next_nl: &mut Option<usize>| -> usize {
        if next_nl.is_none_or(|nl| nl < q) {
            *next_nl = Some(src[q..].find('\n').map_or(n, |r| q + r));
        }
        next_nl.unwrap()
    };

    let has = |q: usize, bit: u8| -> bool {
        if q >= n {
            return false;
        }
        let c = bytes[q];
        if c < 128 {
            (CLASS[c as usize] & bit) != 0
        } else if bit == C_ID || bit == C_MENU {
            !is_space_at(src, q)
        } else {
            true
        }
    };

    let step_char = |q: usize| -> usize { if bytes[q] < 128 { q + 1 } else { q + next_char(src, q).unwrap().1 } };

    let ci = |q: usize, word: &str| -> bool {
        let wb = word.as_bytes();
        if q + wb.len() > n {
            return false;
        }
        for k in 0..wb.len() {
            let w = wb[k];
            let c = bytes[q + k];
            if w.is_ascii_lowercase() {
                if (c | 32) != w {
                    return false;
                }
            } else if c != w {
                return false;
            }
        }
        true
    };

    let word_at = |p: usize, lit: &str| -> bool { ci(p, lit) && !bytes.get(p + lit.len()).is_some_and(|&b| is_word(b as u32)) };

    let skip_ws = |mut q: usize| -> usize {
        while q < n && is_space_at(src, q) {
            q = step_char(q);
        }
        q
    };

    let skip_same_line = |p_ref: &mut usize| -> bool {
        let mut q = *p_ref;
        while q < n && bytes[q] != b'\n' && is_space_at(src, q) {
            q = step_char(q);
        }
        if q == *p_ref {
            return false;
        }
        *p_ref = q;
        true
    };

    let line_run = |mut q: usize| -> usize {
        while q < n && has(q, C_LINE) {
            q = step_char(q);
        }
        q
    };

    let arrow_ahead = |q: usize| -> bool {
        let c = bytes.get(q).copied().unwrap_or(0);
        let d = bytes.get(q + 1).copied().unwrap_or(0);
        if c == b'-' {
            if matches!(d, b'x' | b'X' | b')' | b'\\' | b'/' | b'-') {
                return true;
            }
            let e = bytes.get(q + 2).copied().unwrap_or(0);
            return d == b'|' && matches!(e, b'\\' | b'/');
        }
        if matches!(c, b'/' | b'\\') {
            return (d == b'|' || d == c) && bytes.get(q + 2) == Some(&b'-');
        }
        c == b'(' && d == b')'
    };

    while p < n {
        let c = bytes[p];
        let d = bytes.get(p + 1).copied().unwrap_or(0);
        match state {
            State::Initial => {
                if c == b'\n' {
                    let mut q = p + 1;
                    while q < n && bytes[q] == b'\n' {
                        q += 1;
                    }
                    emit!(SeqToken::Newline, p, q);
                    continue;
                }
                if is_space_at(src, p) {
                    p = skip_ws(step_char(p));
                    continue;
                }
                if c == b'#' || (c == b'%' && d != b'{') {
                    p = eol(p, &mut next_nl);
                    continue;
                }
                if is_digit(c as u32) || c == b'.' {
                    let mut q = p;
                    while q < n && is_digit(bytes[q] as u32) {
                        q += 1;
                    }
                    let whole = q > p;
                    let mut matched_num = false;
                    if bytes.get(q) == Some(&b'.') && bytes.get(q + 1).is_some_and(|&b| is_digit(b as u32)) {
                        let r = if bytes.get(q + 2).is_some_and(|&b| is_digit(b as u32)) {
                            q + 3
                        } else {
                            q + 2
                        };
                        if matches!(bytes.get(r), Some(b' ' | b'\n')) {
                            emit!(SeqToken::Num, p, r);
                            matched_num = true;
                        }
                    }
                    if !matched_num && whole && matches!(bytes.get(q), Some(b' ' | b'\n')) {
                        emit!(SeqToken::Num, p, q);
                        matched_num = true;
                    }
                    if matched_num {
                        continue;
                    }
                }

                if c < 128 && (c | 32).is_ascii_lowercase() {
                    let mut kw_hit = false;
                    macro_rules! try_kw {
                        ($lit:expr, $tok:expr, $next:expr) => {{
                            if word_at(p, $lit) {
                                emit!($tok, p, p + $lit.len());
                                if let Some(ns) = $next {
                                    push_state!(ns);
                                }
                                true
                            } else {
                                false
                            }
                        }};
                    }
                    macro_rules! try_menu {
                        ($lit:expr, $tok:expr) => {{
                            if ci(p, $lit) {
                                let mut q = p + $lit.len();
                                if matches!(bytes.get(q), Some(b' ' | b'\t')) {
                                    while matches!(bytes.get(q), Some(b' ' | b'\t')) {
                                        q += 1;
                                    }
                                    if q < n && has(q, C_MENU) {
                                        emit!($tok, p, p + $lit.len());
                                        true
                                    } else {
                                        false
                                    }
                                } else {
                                    false
                                }
                            } else {
                                false
                            }
                        }};
                    }
                    match c | 32 {
                        b'a' => {
                            kw_hit = try_kw!("actor", SeqToken::ParticipantActor, Some(State::Id))
                                || try_kw!("alt", SeqToken::AltKw, Some(State::Line))
                                || try_kw!("and", SeqToken::AndKw, Some(State::Line))
                                || try_kw!("activate", SeqToken::Activate, Some(State::Id));
                            if !kw_hit {
                                let descr = ci(p, "accdescr");
                                if descr || ci(p, "acctitle") {
                                    let q = skip_ws(p + 8);
                                    let ch = bytes.get(q).copied().unwrap_or(0);
                                    if ch == b':' {
                                        let end = skip_ws(q + 1);
                                        emit!(if descr { SeqToken::AccDescr } else { SeqToken::AccTitle }, p, end);
                                        push_state!(if descr { State::AccDescr } else { State::AccTitle });
                                        kw_hit = true;
                                    } else if descr && ch == b'{' {
                                        p = skip_ws(q + 1);
                                        push_state!(State::AccDescrMultiline);
                                        kw_hit = true;
                                    }
                                }
                            }
                            if !kw_hit {
                                kw_hit = try_kw!("autonumber", SeqToken::Autonumber, None::<State>);
                            }
                        }
                        b'b' => {
                            kw_hit = try_kw!("box", SeqToken::BoxKw, Some(State::Line)) || try_kw!("break", SeqToken::BreakKw, Some(State::Line));
                        }
                        b'c' => {
                            kw_hit = try_kw!("create", SeqToken::Create, None::<State>) || try_kw!("critical", SeqToken::CriticalKw, Some(State::Line));
                        }
                        b'd' => {
                            kw_hit = try_kw!("destroy", SeqToken::Destroy, Some(State::Id))
                                || try_menu!("details", SeqToken::Details)
                                || try_kw!("deactivate", SeqToken::Deactivate, Some(State::Id));
                        }
                        b'e' => {
                            kw_hit = try_kw!("else", SeqToken::ElseKw, Some(State::Line)) || try_kw!("end", SeqToken::EndKw, None::<State>);
                        }
                        b'l' => {
                            kw_hit = try_kw!("loop", SeqToken::LoopKw, Some(State::Line))
                                || try_kw!("left of", SeqToken::LeftOf, None::<State>)
                                || try_menu!("links", SeqToken::Links)
                                || try_menu!("link", SeqToken::Link);
                        }
                        b'n' => {
                            kw_hit = try_kw!("note", SeqToken::Note, None::<State>);
                        }
                        b'o' => {
                            kw_hit = try_kw!("opt", SeqToken::OptKw, Some(State::Line))
                                || try_kw!("option", SeqToken::OptionKw, Some(State::Line))
                                || try_kw!("over", SeqToken::Over, None::<State>)
                                || try_kw!("off", SeqToken::Off, None::<State>);
                        }
                        b'p' => {
                            kw_hit = try_kw!("participant", SeqToken::Participant, Some(State::Id))
                                || try_kw!("par", SeqToken::ParKw, Some(State::Line))
                                || try_kw!("par_over", SeqToken::ParOverKw, Some(State::Line))
                                || try_menu!("properties", SeqToken::Properties);
                        }
                        b'r' => {
                            kw_hit = try_kw!("rect", SeqToken::RectKw, Some(State::Line)) || try_kw!("right of", SeqToken::RightOf, None::<State>);
                        }
                        b's' => {
                            kw_hit = try_kw!("sequencediagram", SeqToken::Sd, None::<State>);
                        }
                        b't' if ci(p, "title") => {
                            let mut q = p + 5;
                            let legacy = bytes.get(q) == Some(&b':');
                            if legacy {
                                q += 1;
                            }
                            let mut e = q;
                            while e < n && bytes[e] != b'\n' && is_space_at(src, e) {
                                e = step_char(e);
                            }
                            if e == n || bytes[e] == b'\n' {
                                p = e;
                                kw_hit = true;
                            } else if is_space_at(src, q) && bytes[q] != b'\r' {
                                let after_sep = step_char(q);
                                if has(after_sep, C_LINE) {
                                    let end = line_run(after_sep);
                                    emit!(if legacy { SeqToken::LegacyTitle } else { SeqToken::Title }, p, end);
                                    kw_hit = true;
                                }
                            }
                        }
                        _ => {}
                    }
                    if kw_hit {
                        continue;
                    }
                }

                if c == b',' {
                    emit!(SeqToken::Comma, p, p + 1);
                } else if c == b';' {
                    emit!(SeqToken::Newline, p, p + 1);
                } else if has(p, C_ACTOR_START) {
                    let mut q = step_char(p);
                    while q < n && has(q, C_ACTOR_START) {
                        q = step_char(q);
                    }
                    while q < n && !arrow_ahead(q) {
                        let mut r = q;
                        while r < n && bytes[r] == b'-' {
                            r += 1;
                        }
                        if r >= n || !has(r, C_ACTOR_REST) {
                            break;
                        }
                        r = step_char(r);
                        while r < n && has(r, C_ACTOR_REST) {
                            r = step_char(r);
                        }
                        q = r;
                    }
                    emit_text!(SeqToken::Actor, p, q, src[p..q].trim().to_string());
                } else if c == b'-' {
                    let e = bytes.get(p + 2).copied().unwrap_or(0);
                    if d == b'>' {
                        if e == b'>' {
                            emit!(SeqToken::SolidArrow, p, p + 3);
                        } else {
                            emit!(SeqToken::SolidOpenArrow, p, p + 2);
                        }
                    } else if d == b'x' || d == b'X' {
                        emit!(SeqToken::SolidCross, p, p + 2);
                    } else if d == b')' {
                        emit!(SeqToken::SolidPoint, p, p + 2);
                    } else if d == b'|' && e == b'\\' {
                        emit!(SeqToken::SolidArrowTop, p, p + 3);
                    } else if d == b'|' && e == b'/' {
                        emit!(SeqToken::SolidArrowBottom, p, p + 3);
                    } else if d == b'\\' && e == b'\\' {
                        emit!(SeqToken::StickArrowTop, p, p + 3);
                    } else if d == b'/' && e == b'/' {
                        emit!(SeqToken::StickArrowBottom, p, p + 3);
                    } else if d == b'-' {
                        let f = bytes.get(p + 3).copied().unwrap_or(0);
                        if e == b'>' {
                            if f == b'>' {
                                emit!(SeqToken::DottedArrow, p, p + 4);
                            } else {
                                emit!(SeqToken::DottedOpenArrow, p, p + 3);
                            }
                        } else if e == b'x' || e == b'X' {
                            emit!(SeqToken::DottedCross, p, p + 3);
                        } else if e == b')' {
                            emit!(SeqToken::DottedPoint, p, p + 3);
                        } else if e == b'|' && f == b'\\' {
                            emit!(SeqToken::SolidArrowTopDotted, p, p + 4);
                        } else if e == b'|' && f == b'/' {
                            emit!(SeqToken::SolidArrowBottomDotted, p, p + 4);
                        } else if e == b'\\' && f == b'\\' {
                            emit!(SeqToken::StickArrowTopDotted, p, p + 4);
                        } else if e == b'/' && f == b'/' {
                            emit!(SeqToken::StickArrowBottomDotted, p, p + 4);
                        } else {
                            emit!(SeqToken::Minus, p, p + 1);
                        }
                    } else {
                        emit!(SeqToken::Minus, p, p + 1);
                    }
                } else if c == b'<' && src[p..].starts_with("<<->>") {
                    emit!(SeqToken::BidirectionalSolidArrow, p, p + 5);
                } else if c == b'<' && src[p..].starts_with("<<-->>") {
                    emit!(SeqToken::BidirectionalDottedArrow, p, p + 6);
                } else if matches!(c, b'/' | b'\\') && (d == b'|' || d == c) && bytes.get(p + 2) == Some(&b'-') {
                    let dotted = bytes.get(p + 3) == Some(&b'-');
                    let top = c == b'/';
                    let tok = if d == b'|' {
                        if dotted {
                            if top {
                                SeqToken::SolidArrowTopReverseDotted
                            } else {
                                SeqToken::SolidArrowBottomReverseDotted
                            }
                        } else if top {
                            SeqToken::SolidArrowTopReverse
                        } else {
                            SeqToken::SolidArrowBottomReverse
                        }
                    } else if dotted {
                        if top {
                            SeqToken::StickArrowTopReverseDotted
                        } else {
                            SeqToken::StickArrowBottomReverseDotted
                        }
                    } else if top {
                        SeqToken::StickArrowTopReverse
                    } else {
                        SeqToken::StickArrowBottomReverse
                    };
                    emit!(tok, p, p + if dotted { 4 } else { 3 });
                } else if c == b':' {
                    let end = line_run(p + 1);
                    emit!(SeqToken::Txt, p, end);
                } else if c == b'+' {
                    emit!(SeqToken::Plus, p, p + 1);
                } else if c == b'(' && d == b')' {
                    emit!(SeqToken::Central, p, p + 2);
                } else {
                    emit!(SeqToken::Invalid, p, step_char(p));
                }
            }

            State::Id => {
                if skip_same_line(&mut p) {
                    continue;
                }
                let c = bytes[p];
                let d = bytes.get(p + 1).copied().unwrap_or(0);
                if c == b'#' {
                    p = eol(p, &mut next_nl);
                    continue;
                }
                if c == b'@' && d == b'{' {
                    emit!(SeqToken::ConfigStart, p, p + 2);
                    push_state!(State::Config);
                    continue;
                }
                let mut a = p;
                while a < n && has(a, C_ID) {
                    a = step_char(a);
                }
                if a > p {
                    let w = skip_ws(a);
                    if bytes.get(w) == Some(&b'@') && bytes.get(w + 1) == Some(&b'{') {
                        emit!(SeqToken::Actor, p, a);
                        continue;
                    }
                    if w > a && ci(w, "as") && is_space_at(src, w + 2) {
                        emit!(SeqToken::Actor, p, a);
                        push_state!(State::Alias);
                        continue;
                    }
                }
                let mut b = a;
                while b < n && has(b, C_ID_WIDE) {
                    b = step_char(b);
                }
                if b > p {
                    let end_b = bytes.get(b).copied().unwrap_or(0);
                    let mut cut = b;
                    if b < n && end_b != b'\n' && end_b != b';' {
                        cut = src[p..b].rfind('#').map_or(p, |rel| p + rel);
                    }
                    if cut > p {
                        emit_text!(SeqToken::Actor, p, cut, src[p..cut].trim().to_string());
                        pop_state!();
                        continue;
                    }
                }
                if bytes.get(b) == Some(&b'<') {
                    let end = eol(p, &mut next_nl);
                    emit!(SeqToken::Invalid, p, end);
                    pop_state!();
                    continue;
                }
                if c != b'\n' {
                    let end = eol(p, &mut next_nl);
                    emit_text!(SeqToken::Invalid, p, end, src[p..end].trim().to_string());
                    pop_state!();
                    continue;
                }
                types.push(SeqToken::Error);
                texts.push(String::new());
                starts.push(p);
                return SeqTokens { types, texts, starts };
            }

            State::Alias => {
                if skip_same_line(&mut p) {
                    continue;
                }
                if bytes[p] == b'#' {
                    p = eol(p, &mut next_nl);
                    continue;
                }
                pop_state!();
                pop_state!();
                if word_at(p, "as") {
                    emit!(SeqToken::AsKw, p, p + 2);
                    push_state!(State::Line);
                } else {
                    emit!(SeqToken::Newline, p, p);
                }
            }

            State::Line => {
                if skip_same_line(&mut p) {
                    continue;
                }
                if bytes[p] == b'#' {
                    p = eol(p, &mut next_nl);
                    continue;
                }
                let end = line_run(p);
                emit!(SeqToken::RestOfLine, p, end);
                pop_state!();
            }

            State::Config => {
                if c != b'}' {
                    let q = src[p..].find('}').map_or(n, |r| p + r);
                    emit!(SeqToken::ConfigContent, p, q);
                } else {
                    let w = skip_ws(p + 1);
                    let alias = w > p + 1 && ci(w, "as") && is_space_at(src, w + 2);
                    emit!(SeqToken::ConfigEnd, p, p + 1);
                    pop_state!();
                    if alias {
                        push_state!(State::Alias);
                    } else {
                        pop_state!();
                    }
                }
            }

            State::AccTitle | State::AccDescr => {
                let end = eol(p, &mut next_nl);
                let tok = if state == State::AccTitle {
                    SeqToken::AccTitleValue
                } else {
                    SeqToken::AccDescrValue
                };
                emit!(tok, p, end);
                pop_state!();
            }

            State::AccDescrMultiline => {
                if c == b'}' {
                    p += 1;
                    pop_state!();
                } else {
                    let q = src[p..].find('}').map_or(n, |r| p + r);
                    emit!(SeqToken::AccDescrMultilineValue, p, q);
                }
            }
        }
    }

    let eof_tok = match state {
        State::Initial | State::Alias => Some(SeqToken::Newline),
        State::Line => Some(SeqToken::RestOfLine),
        State::AccTitle => Some(SeqToken::AccTitleValue),
        State::AccDescr => Some(SeqToken::AccDescrValue),
        State::AccDescrMultiline => Some(SeqToken::AccDescrMultilineValue),
        State::Id | State::Config => None,
    };
    if let Some(t) = eof_tok {
        types.push(t);
        texts.push(String::new());
        starts.push(n);
    }
    types.push(SeqToken::End);
    texts.push(String::new());
    starts.push(n);
    SeqTokens { types, texts, starts }
}
