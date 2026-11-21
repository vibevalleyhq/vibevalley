use crate::diagram::timeline::scan::keyword_at;
use crate::util::chars::{is_space_char, is_word};

use super::tokens::GanttToken;

pub struct GanttTokens {
    pub types: Vec<GanttToken>,
    pub texts: Vec<String>,
    pub starts: Vec<usize>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Initial,
    AccTitle,
    AccDescr,
    AccDescrMultiline,
    Href,
    CallbackName,
    CallbackArgs,
    Click,
}

fn word_boundary(src: &str, at: usize) -> bool {
    !src.as_bytes().get(at).is_some_and(|&b| is_word(b as u32))
}

fn skip_ws(src: &str, mut p: usize) -> usize {
    while p < src.len()
        && let Some(ch) = src[p..].chars().next()
        && is_space_char(ch)
    {
        p += ch.len_utf8();
    }
    p
}

fn until_byte(src: &str, needle: u8, from: usize) -> usize {
    let bytes = src.as_bytes();
    let mut e = from;
    while e < bytes.len() && bytes[e] != needle {
        e += 1;
    }
    e
}

/// Matches `word\s*sep\s*` case-insensitively.
fn match_kw_sep_ws(src: &str, p: usize, word: &str, sep: u8) -> Option<usize> {
    if !keyword_at(src, p, word) {
        return None;
    }
    let q = skip_ws(src, p + word.len());
    if src.as_bytes().get(q) != Some(&sep) {
        return None;
    }
    Some(skip_ws(src, q + 1))
}

/// Matches `word\s+` case-insensitively, optionally requiring `after` byte.
fn match_kw_ws(src: &str, p: usize, word: &str, after: Option<u8>) -> Option<usize> {
    if !keyword_at(src, p, word) {
        return None;
    }
    let start = p + word.len();
    let q = skip_ws(src, start);
    if q == start {
        return None;
    }
    match after {
        None => Some(q),
        Some(b) => (src.as_bytes().get(q) == Some(&b)).then_some(q + 1),
    }
}

/// Matches `word\s[^#\n;]+` (or custom stop predicate) case-insensitively.
fn match_kw_line(src: &str, p: usize, word: &str, stop_hash: bool, stop_semi: bool, horiz_only: bool) -> Option<usize> {
    if !keyword_at(src, p, word) {
        return None;
    }
    let ws_pos = p + word.len();
    let ch = src.get(ws_pos..)?.chars().next()?;
    if !is_space_char(ch) {
        return None;
    }
    if horiz_only && (ch == '\r' || ch == '\n') {
        return None;
    }
    let from = ws_pos + ch.len_utf8();
    let bytes = src.as_bytes();
    let mut q = from;
    while q < bytes.len() {
        let b = bytes[q];
        if b == b'\n' || (stop_hash && b == b'#') || (stop_semi && b == b';') {
            break;
        }
        q += 1;
    }
    (q > from).then_some(q)
}

fn match_bare_title(src: &str, p: usize) -> Option<usize> {
    if !keyword_at(src, p, "title") {
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
    if q == src.len() || matches!(src.as_bytes()[q], b'\r' | b'\n') {
        Some(q)
    } else {
        None
    }
}

fn match_weekday(src: &str, p: usize) -> Option<(GanttToken, usize)> {
    const DAYS: [(&str, GanttToken); 7] = [
        ("monday", GanttToken::WeekdayMonday),
        ("tuesday", GanttToken::WeekdayTuesday),
        ("wednesday", GanttToken::WeekdayWednesday),
        ("thursday", GanttToken::WeekdayThursday),
        ("friday", GanttToken::WeekdayFriday),
        ("saturday", GanttToken::WeekdaySaturday),
        ("sunday", GanttToken::WeekdaySunday),
    ];
    let q = match_kw_ws(src, p, "weekday", None)?;
    for &(day, tok) in &DAYS {
        if keyword_at(src, q, day) && word_boundary(src, q + day.len()) {
            return Some((tok, q + day.len()));
        }
    }
    None
}

fn match_weekend(src: &str, p: usize) -> Option<(GanttToken, usize)> {
    let q = match_kw_ws(src, p, "weekend", None)?;
    if keyword_at(src, q, "friday") && word_boundary(src, q + 6) {
        return Some((GanttToken::WeekendFriday, q + 6));
    }
    if keyword_at(src, q, "saturday") && word_boundary(src, q + 8) {
        return Some((GanttToken::WeekendSaturday, q + 8));
    }
    None
}

fn match_iso_date(src: &str, p: usize) -> bool {
    let bytes = src.as_bytes();
    if p + 10 > bytes.len() {
        return false;
    }
    bytes[p].is_ascii_digit()
        && bytes[p + 1].is_ascii_digit()
        && bytes[p + 2].is_ascii_digit()
        && bytes[p + 3].is_ascii_digit()
        && bytes[p + 4] == b'-'
        && bytes[p + 5].is_ascii_digit()
        && bytes[p + 6].is_ascii_digit()
        && bytes[p + 7] == b'-'
        && bytes[p + 8].is_ascii_digit()
        && bytes[p + 9].is_ascii_digit()
        && word_boundary(src, p + 10)
}

fn match_empty_call(src: &str, p: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    if bytes.get(p) != Some(&b'(') {
        return None;
    }
    let q = skip_ws(src, p + 1);
    (bytes.get(q) == Some(&b')')).then_some(q + 1)
}

pub fn tokenize(src: &str) -> GanttTokens {
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut types = Vec::new();
    let mut texts = Vec::new();
    let mut starts = Vec::new();
    let mut state = State::Initial;
    let mut p = 0usize;

    let emit = |types: &mut Vec<GanttToken>, texts: &mut Vec<String>, starts: &mut Vec<usize>, kind: GanttToken, s: usize, e: usize, p_ref: &mut usize| {
        types.push(kind);
        texts.push(src[s..e].to_string());
        starts.push(s);
        *p_ref = e;
    };

    loop {
        if p >= n {
            let tok = match state {
                State::Initial => GanttToken::Eof,
                State::AccTitle => GanttToken::AccTitleValue,
                State::AccDescr => GanttToken::AccDescrValue,
                State::AccDescrMultiline => GanttToken::AccDescrMultilineValue,
                State::Href => GanttToken::Href,
                State::CallbackName => GanttToken::CallbackName,
                State::CallbackArgs => GanttToken::CallbackArgs,
                State::Click => GanttToken::Click,
            };
            emit(&mut types, &mut texts, &mut starts, tok, n, n, &mut p);
            break;
        }

        let b = bytes[p];
        match state {
            State::Initial => {
                if b == b'%' {
                    let d = bytes.get(p + 1).copied();
                    if d != Some(b'%') {
                        let mut e = until_byte(src, b'\n', p + 1);
                        while bytes.get(e) == Some(&b'\n') {
                            e += 1;
                        }
                        p = e;
                    } else if bytes.get(p + 2) == Some(&b'{') {
                        emit(&mut types, &mut texts, &mut starts, GanttToken::OpenDirective, p, p + 3, &mut p);
                        emit(&mut types, &mut texts, &mut starts, GanttToken::Error, p, p, &mut p);
                        return GanttTokens { types, texts, starts };
                    } else {
                        p = until_byte(src, b'\n', p + 2);
                    }
                    continue;
                }
                if b == b'\n' {
                    let mut e = p + 1;
                    while bytes.get(e) == Some(&b'\n') {
                        e += 1;
                    }
                    emit(&mut types, &mut texts, &mut starts, GanttToken::Nl, p, e, &mut p);
                    continue;
                }
                if let Some(ch) = src[p..].chars().next()
                    && is_space_char(ch)
                {
                    p = skip_ws(src, p + ch.len_utf8());
                    continue;
                }

                // Keyword dispatch (ASCII case-insensitive).
                let lower = b.to_ascii_lowercase();
                let mut matched_kw = false;
                match lower {
                    b'a' => {
                        if let Some(e) = match_kw_sep_ws(src, p, "acctitle", b':') {
                            state = State::AccTitle;
                            emit(&mut types, &mut texts, &mut starts, GanttToken::AccTitle, p, e, &mut p);
                            matched_kw = true;
                        } else if let Some(e) = match_kw_sep_ws(src, p, "accdescr", b':') {
                            state = State::AccDescr;
                            emit(&mut types, &mut texts, &mut starts, GanttToken::AccDescr, p, e, &mut p);
                            matched_kw = true;
                        } else if let Some(e) = match_kw_sep_ws(src, p, "accdescr", b'{') {
                            state = State::AccDescrMultiline;
                            p = e;
                            matched_kw = true;
                        } else if let Some(e) = match_kw_line(src, p, "axisformat", true, true, false) {
                            emit(&mut types, &mut texts, &mut starts, GanttToken::AxisFormat, p, e, &mut p);
                            matched_kw = true;
                        } else if let Some(e) = match_kw_line(src, p, "accdescription", true, true, false) {
                            emit(&mut types, &mut texts, &mut starts, GanttToken::AccDescription, p, e, &mut p);
                            matched_kw = true;
                        }
                    }
                    b'h' => {
                        if let Some(e) = match_kw_ws(src, p, "href", Some(b'"')) {
                            state = State::Href;
                            p = e;
                            matched_kw = true;
                        }
                    }
                    b'c' => {
                        if let Some(e) = match_kw_ws(src, p, "call", None) {
                            state = State::CallbackName;
                            p = e;
                            matched_kw = true;
                        } else if let Some(e) = match_kw_ws(src, p, "click", None) {
                            state = State::Click;
                            p = e;
                            matched_kw = true;
                        }
                    }
                    b't' => {
                        if let Some(e) = match_bare_title(src, p) {
                            p = e;
                            matched_kw = true;
                        } else if keyword_at(src, p, "topaxis") && word_boundary(src, p + 7) {
                            emit(&mut types, &mut texts, &mut starts, GanttToken::TopAxis, p, p + 7, &mut p);
                            matched_kw = true;
                        } else if let Some(e) = match_kw_line(src, p, "tickinterval", true, true, false) {
                            emit(&mut types, &mut texts, &mut starts, GanttToken::TickInterval, p, e, &mut p);
                            matched_kw = true;
                        } else if let Some(e) = match_kw_line(src, p, "todaymarker", false, true, false) {
                            emit(&mut types, &mut texts, &mut starts, GanttToken::TodayMarker, p, e, &mut p);
                            matched_kw = true;
                        } else if let Some(e) = match_kw_line(src, p, "title", false, false, true) {
                            emit(&mut types, &mut texts, &mut starts, GanttToken::Title, p, e, &mut p);
                            matched_kw = true;
                        }
                    }
                    b'w' => {
                        if let Some((tok, e)) = match_weekday(src, p) {
                            emit(&mut types, &mut texts, &mut starts, tok, p, e, &mut p);
                            matched_kw = true;
                        } else if let Some((tok, e)) = match_weekend(src, p) {
                            emit(&mut types, &mut texts, &mut starts, tok, p, e, &mut p);
                            matched_kw = true;
                        }
                    }
                    b'g' => {
                        if keyword_at(src, p, "gantt") && word_boundary(src, p + 5) {
                            emit(&mut types, &mut texts, &mut starts, GanttToken::Gantt, p, p + 5, &mut p);
                            matched_kw = true;
                        }
                    }
                    b'd' => {
                        if let Some(e) = match_kw_line(src, p, "dateformat", true, true, false) {
                            emit(&mut types, &mut texts, &mut starts, GanttToken::DateFormat, p, e, &mut p);
                            matched_kw = true;
                        }
                    }
                    b'i' => {
                        if keyword_at(src, p, "inclusiveenddates") && word_boundary(src, p + 17) {
                            emit(&mut types, &mut texts, &mut starts, GanttToken::InclusiveEndDates, p, p + 17, &mut p);
                            matched_kw = true;
                        } else if let Some(e) = match_kw_line(src, p, "includes", true, true, false) {
                            emit(&mut types, &mut texts, &mut starts, GanttToken::Includes, p, e, &mut p);
                            matched_kw = true;
                        }
                    }
                    b'e' => {
                        if let Some(e) = match_kw_line(src, p, "excludes", true, true, false) {
                            emit(&mut types, &mut texts, &mut starts, GanttToken::Excludes, p, e, &mut p);
                            matched_kw = true;
                        }
                    }
                    b's' => {
                        if let Some(e) = match_kw_line(src, p, "section", false, false, false) {
                            emit(&mut types, &mut texts, &mut starts, GanttToken::Section, p, e, &mut p);
                            matched_kw = true;
                        }
                    }
                    _ => {}
                }
                if matched_kw {
                    continue;
                }

                if b.is_ascii_digit() && match_iso_date(src, p) {
                    emit(&mut types, &mut texts, &mut starts, GanttToken::Date, p, p + 10, &mut p);
                } else if b != b':' {
                    let first_len = src[p..].chars().next().map_or(1, char::len_utf8);
                    let mut e = p + first_len;
                    while e < n && bytes[e] != b':' && bytes[e] != b'\n' {
                        e += 1;
                    }
                    emit(&mut types, &mut texts, &mut starts, GanttToken::TaskTxt, p, e, &mut p);
                } else {
                    let mut e = p + 1;
                    while e < n && !matches!(bytes[e], b'#' | b'\n' | b';') {
                        e += 1;
                    }
                    let tok = if e > p + 1 { GanttToken::TaskData } else { GanttToken::Colon };
                    emit(&mut types, &mut texts, &mut starts, tok, p, e, &mut p);
                }
            }
            State::AccTitle | State::AccDescr => {
                let tok = if state == State::AccTitle {
                    GanttToken::AccTitleValue
                } else {
                    GanttToken::AccDescrValue
                };
                state = State::Initial;
                let end = until_byte(src, b'\n', p);
                emit(&mut types, &mut texts, &mut starts, tok, p, end, &mut p);
            }
            State::AccDescrMultiline => {
                if b == b'}' {
                    state = State::Initial;
                    p += 1;
                } else {
                    let end = until_byte(src, b'}', p);
                    emit(&mut types, &mut texts, &mut starts, GanttToken::AccDescrMultilineValue, p, end, &mut p);
                }
            }
            State::Href => {
                if b == b'"' {
                    state = State::Initial;
                    p += 1;
                } else {
                    let end = until_byte(src, b'"', p);
                    emit(&mut types, &mut texts, &mut starts, GanttToken::Href, p, end, &mut p);
                }
            }
            State::CallbackName => {
                if b == b'(' {
                    if let Some(e) = match_empty_call(src, p) {
                        state = State::Initial;
                        p = e;
                    } else {
                        state = State::CallbackArgs;
                        p += 1;
                    }
                } else {
                    let end = until_byte(src, b'(', p);
                    emit(&mut types, &mut texts, &mut starts, GanttToken::CallbackName, p, end, &mut p);
                }
            }
            State::CallbackArgs => {
                if b == b')' {
                    state = State::Initial;
                    p += 1;
                } else {
                    let end = until_byte(src, b')', p);
                    emit(&mut types, &mut texts, &mut starts, GanttToken::CallbackArgs, p, end, &mut p);
                }
            }
            State::Click => {
                if let Some(ch) = src[p..].chars().next()
                    && is_space_char(ch)
                {
                    state = State::Initial;
                    p += ch.len_utf8();
                } else {
                    let mut e = p;
                    while e < n
                        && let Some(ch) = src[e..].chars().next()
                        && !is_space_char(ch)
                    {
                        e += ch.len_utf8();
                    }
                    emit(&mut types, &mut texts, &mut starts, GanttToken::Click, p, e, &mut p);
                }
            }
        }
    }

    types.push(GanttToken::End);
    texts.push(String::new());
    starts.push(n);
    GanttTokens { types, texts, starts }
}
