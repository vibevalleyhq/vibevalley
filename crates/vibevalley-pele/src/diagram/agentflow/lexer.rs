use crate::util::chars::{is_space_char, is_word};
use crate::util::unicode::is_unicode_letter;

use super::tokens::AgentToken;

pub struct AgentTokens {
    pub types: Vec<AgentToken>,
    pub texts: Vec<String>,
    pub starts: Vec<usize>,
    /// Four numbers per token matching Jison: first_line, first_col, last_line, last_col.
    /// Lines start at 1, columns at 0.
    pub locs: Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Initial,
    StringLit,
    MdString,
    AccTitle,
    AccDescr,
    AccDescrMultiline,
    Dir,
    Text,
    EllipseText,
    TrapText,
    EdgeText,
    Click,
    CallbackName,
    CallbackArgs,
    ShapeData,
    ShapeDataStr,
}

const NODE_CHAR: [bool; 128] = {
    let mut t = [false; 128];
    let allowed = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!\"#$%&'*+.`?\\_/".as_slice();
    let mut i = 0;
    while i < allowed.len() {
        t[allowed[i] as usize] = true;
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

fn utf16_len(s: &str) -> usize {
    if s.is_ascii() { s.len() } else { s.chars().map(char::len_utf16).sum() }
}

fn skip_spaces_raw(src: &str, mut p: usize) -> usize {
    let bytes = src.as_bytes();
    let n = bytes.len();
    while p < n {
        let b = bytes[p];
        if b < 128 {
            if matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c) {
                p += 1;
            } else {
                break;
            }
        } else if let Some((ch, len)) = next_char(src, p)
            && is_space_char(ch)
        {
            p += len;
        } else {
            break;
        }
    }
    p
}

fn match_acc_header(src: &str, p: usize, kw: &str, delim: u8) -> Option<usize> {
    if !src[p..].starts_with(kw) {
        return None;
    }
    let q = skip_spaces_raw(src, p + kw.len());
    if src.as_bytes().get(q) != Some(&delim) {
        return None;
    }
    Some(skip_spaces_raw(src, q + 1))
}

fn match_kw_space(src: &str, p: usize, kw: &str) -> Option<usize> {
    if !src[p..].starts_with(kw) {
        return None;
    }
    let after = p + kw.len();
    let end = skip_spaces_raw(src, after);
    (end > after).then_some(end)
}

fn match_nodir(src: &str, p: usize) -> Option<usize> {
    let end = skip_spaces_raw(src, p);
    let last_nl = src[p..end].rfind('\n')?;
    Some(p + last_nl + 1)
}

fn match_dir(src: &str, p: usize) -> Option<usize> {
    let q = skip_spaces_raw(src, p);
    let bytes = src.as_bytes();
    for code in ["LR", "RL", "TB", "BT", "TD", "BR"] {
        if src[q..].starts_with(code) {
            let after = q + 2;
            let next_word = bytes.get(after).is_some_and(|&b| is_word(b as u32));
            if !next_word {
                return Some(after);
            }
        }
    }
    if matches!(bytes.get(q), Some(b'<' | b'>' | b'^')) {
        return Some(q + 1);
    }
    if bytes.get(q) == Some(&b'v') {
        let after = q + 1;
        let next_word = bytes.get(after).is_some_and(|&b| is_word(b as u32));
        if !next_word {
            return Some(after);
        }
    }
    None
}

fn match_empty_call(src: &str, p: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    if bytes.get(p) != Some(&b'(') {
        return None;
    }
    let q = skip_spaces_raw(src, p + 1);
    if bytes.get(q) == Some(&b')') { Some(q + 1) } else { None }
}

fn find_line_end(src: &str, p: usize) -> usize {
    let bytes = src.as_bytes();
    let mut q = p;
    while q < bytes.len() {
        let b = bytes[q];
        if b == b'\n' || b == b'\r' {
            return q;
        }
        if b == 0xe2 && bytes.get(q + 1) == Some(&0x80) && matches!(bytes.get(q + 2), Some(0xa8 | 0xa9)) {
            return q;
        }
        q += 1;
    }
    bytes.len()
}

fn replace_nl_spaces(s: &str) -> String {
    if !s.contains('\n') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s.as_bytes()[i] == b'\n' {
            out.push_str("<br/>");
            i = skip_spaces_raw(s, i + 1);
        } else {
            let (ch, len) = next_char(s, i).unwrap();
            out.push(ch);
            i += len;
        }
    }
    out
}

pub fn tokenize(src: &str) -> AgentTokens {
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut types: Vec<AgentToken> = Vec::new();
    let mut texts: Vec<String> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    let mut locs: Vec<usize> = Vec::new();
    let mut stack: Vec<State> = Vec::new();
    let mut state = State::Initial;
    let mut p = 0usize;
    let mut line = 1usize;
    let mut col = 0usize;
    let mut first_graph = true;

    let mut dir_next: Option<usize> = src.find("direction");
    let mut at_next: Option<usize> = src.find('@');
    let mut line_end: Option<usize> = None;
    let mut dir_failed = 0usize;
    let mut run_end = 0usize;
    let mut run_at: Option<usize> = None;
    let mut ws_from = usize::MAX;
    let mut ws_to = 0usize;
    let mut blank_from = usize::MAX;
    let mut blank_to = 0usize;
    let mut no_link: Option<usize> = None;
    let mut no_arrow: Option<usize> = None;

    let advance = |p: &mut usize, line: &mut usize, col: &mut usize, e: usize| {
        let start = *p;
        let mut brk: Option<usize> = None;
        let mut k = start;
        while k < e {
            let b = bytes[k];
            if b == b'\n' {
                *line += 1;
                brk = Some(k);
                k += 1;
            } else if b == b'\r' {
                if k + 1 < e && bytes[k + 1] == b'\n' {
                    k += 1;
                }
                *line += 1;
                brk = Some(k);
                k += 1;
            } else {
                k += 1;
            }
        }
        match brk {
            None => {
                *col += utf16_len(&src[start..e]);
            }
            Some(b_idx) => {
                let tail = &src[b_idx + 1..e];
                let mut units = 0usize;
                for ch in tail.chars() {
                    if ch == '\u{2028}' || ch == '\u{2029}' {
                        break;
                    }
                    units += ch.len_utf16();
                }
                *col = units;
            }
        }
        *p = e;
    };

    macro_rules! emit {
        ($kind:expr, $end:expr) => {{
            let end = $end;
            types.push($kind);
            texts.push(src[p..end].to_string());
            starts.push(p);
            locs.push(line);
            locs.push(col);
            advance(&mut p, &mut line, &mut col, end);
            locs.push(line);
            locs.push(col);
        }};
    }

    macro_rules! emit_flat {
        ($kind:expr, $end:expr) => {{
            let end = $end;
            types.push($kind);
            texts.push(src[p..end].to_string());
            starts.push(p);
            locs.push(line);
            locs.push(col);
            col += utf16_len(&src[p..end]);
            p = end;
            locs.push(line);
            locs.push(col);
        }};
    }

    macro_rules! emit_chars {
        ($kind:expr, $end:expr) => {{
            let end = $end;
            types.push($kind);
            texts.push(src[p..end].to_string());
            starts.push(p);
            locs.push(line);
            locs.push(col);
            for ch in src[p..end].chars() {
                if ch == '\n' || ch == '\r' {
                    line += 1;
                    col = 0;
                } else {
                    col += ch.len_utf16();
                }
            }
            p = end;
            locs.push(line);
            locs.push(col);
        }};
    }

    macro_rules! emit_text {
        ($kind:expr, $text:expr, $end:expr) => {{
            let end = $end;
            types.push($kind);
            texts.push($text);
            starts.push(p);
            locs.push(line);
            locs.push(col);
            advance(&mut p, &mut line, &mut col, end);
            locs.push(line);
            locs.push(col);
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

    macro_rules! ws_end {
        ($q:expr) => {{
            let q = $q;
            if q >= ws_from && q <= ws_to {
                ws_to
            } else {
                let end = skip_spaces_raw(src, q);
                ws_from = q;
                ws_to = end;
                end
            }
        }};
    }

    macro_rules! blank_end {
        ($q:expr) => {{
            let q = $q;
            if q >= blank_from && q <= blank_to {
                blank_to
            } else {
                let mut j = q;
                while j < n && matches!(bytes[j], b' ' | b'\t') {
                    j += 1;
                }
                blank_from = q;
                blank_to = j;
                j
            }
        }};
    }

    let kw = |at: usize, word: &str| -> bool { src[at..].starts_with(word) && bytes.get(at + word.len()).is_none_or(|&b| !is_word(b as u32)) };

    let comment_end = |q: usize| -> Option<usize> {
        if bytes.get(q) != Some(&b'%') || bytes.get(q + 1) != Some(&b'%') || bytes.get(q + 2) == Some(&b'{') {
            return None;
        }
        Some(src[q + 2..].find('\n').map_or(n, |rel| q + 2 + rel))
    };

    macro_rules! quote {
        () => {{
            if bytes.get(p + 1) == Some(&b'`') {
                push_state!(State::MdString);
                let next = p + 2;
                advance(&mut p, &mut line, &mut col, next);
            } else {
                push_state!(State::StringLit);
                let next = p + 1;
                advance(&mut p, &mut line, &mut col, next);
            }
        }};
    }

    macro_rules! opener {
        ($b:expr) => {{
            let b = $b;
            let d = bytes.get(p + 1).copied();
            if b == b'(' {
                if d == Some(b'-') {
                    push_state!(State::EllipseText);
                    emit_flat!(AgentToken::EllipseStart, p + 2);
                } else if d == Some(b'[') {
                    push_state!(State::Text);
                    emit_flat!(AgentToken::StadiumStart, p + 2);
                } else if d == Some(b'(') && bytes.get(p + 2) == Some(&b'(') {
                    push_state!(State::Text);
                    emit_flat!(AgentToken::DoubleCircleStart, p + 3);
                } else {
                    push_state!(State::Text);
                    emit_flat!(AgentToken::Ps, p + 1);
                }
                true
            } else if b == b'[' {
                if d == Some(b'[') {
                    push_state!(State::Text);
                    emit_flat!(AgentToken::SubroutineStart, p + 2);
                } else if d == Some(b'(') {
                    push_state!(State::Text);
                    emit_flat!(AgentToken::CylinderStart, p + 2);
                } else if d == Some(b'/') {
                    push_state!(State::TrapText);
                    emit_flat!(AgentToken::TrapStart, p + 2);
                } else if d == Some(b'\\') {
                    push_state!(State::TrapText);
                    emit_flat!(AgentToken::InvTrapStart, p + 2);
                } else {
                    push_state!(State::Text);
                    emit_flat!(AgentToken::Sqs, p + 1);
                }
                true
            } else if b == b'|' {
                push_state!(State::Text);
                emit_flat!(AgentToken::Pipe, p + 1);
                true
            } else if b == b'{' {
                push_state!(State::Text);
                emit_flat!(AgentToken::DiamondStart, p + 1);
                true
            } else {
                false
            }
        }};
    }

    macro_rules! arrow_end {
        ($q:expr) => {{
            let j = ws_end!($q);
            if no_arrow == Some(j) || bytes.get(j) != Some(&b'-') || bytes.get(j + 1) != Some(&b'-') {
                None
            } else {
                let mut k = j + 2;
                while bytes.get(k) == Some(&b'-') {
                    k += 1;
                }
                if matches!(bytes.get(k), Some(b'x' | b'>')) {
                    Some(ws_end!(k + 1))
                } else {
                    no_arrow = Some(j);
                    None
                }
            }
        }};
    }

    macro_rules! try_link {
        () => {{
            let j = ws_end!(p);
            if no_link == Some(j) || bytes.get(j) != Some(&b'-') {
                false
            } else {
                let d = bytes.get(j + 1).copied();
                let mut k = j + 2;
                if d == Some(b'-') {
                    while bytes.get(k) == Some(&b'-') {
                        k += 1;
                    }
                    if matches!(bytes.get(k), Some(b'x' | b'>')) {
                        let end = ws_end!(k + 1);
                        emit!(AgentToken::Link, end);
                    } else {
                        push_state!(State::EdgeText);
                        let end = ws_end!(j + 2);
                        emit!(AgentToken::StartLink, end);
                    }
                    true
                } else if d == Some(b'.') {
                    while bytes.get(k) == Some(&b'.') {
                        k += 1;
                    }
                    if bytes.get(k) == Some(&b'-') {
                        let end = ws_end!(k + 1);
                        emit!(AgentToken::Link, end);
                        true
                    } else {
                        no_link = Some(j);
                        false
                    }
                } else {
                    no_link = Some(j);
                    false
                }
            }
        }};
    }

    macro_rules! try_node_string {
        () => {{
            let mut q = p;
            while q < n {
                let ch = bytes[q];
                if ch < 128 && NODE_CHAR[ch as usize] {
                    q += 1;
                } else if ch == b'-' && q + 1 < n {
                    let d = bytes[q + 1];
                    if matches!(d, b'>' | b'-' | b'.') {
                        break;
                    }
                    q += 1;
                } else {
                    break;
                }
            }
            if q > p {
                emit_flat!(AgentToken::NodeString, q);
                true
            } else {
                false
            }
        }};
    }

    let blanks = |from: usize| -> usize {
        let mut e = from;
        while e < n && matches!(bytes[e], b' ' | b'\t') {
            e += 1;
        }
        e
    };

    loop {
        if p >= n {
            let eof_tok = match state {
                State::Initial => Some(AgentToken::Eof),
                State::AccTitle => Some(AgentToken::AccTitleValue),
                State::AccDescr => Some(AgentToken::AccDescrValue),
                State::AccDescrMultiline => Some(AgentToken::AccDescrMultilineValue),
                State::Click => Some(AgentToken::Click),
                State::CallbackName => Some(AgentToken::CallbackName),
                State::CallbackArgs => Some(AgentToken::CallbackArgs),
                State::StringLit
                | State::MdString
                | State::Dir
                | State::Text
                | State::EllipseText
                | State::TrapText
                | State::EdgeText
                | State::ShapeData
                | State::ShapeDataStr => None,
            };
            if let Some(tok) = eof_tok {
                types.push(tok);
                texts.push(String::new());
                starts.push(n);
                locs.push(line);
                locs.push(col);
                locs.push(line);
                locs.push(col);
            }
            break;
        }

        let b = bytes[p];
        let mut ok = true;

        match state {
            State::Initial => {
                let mut matched = false;
                match b {
                    b'a' => {
                        if src[p..].starts_with("acc") {
                            if let Some(e) = match_acc_header(src, p, "accTitle", b':') {
                                push_state!(State::AccTitle);
                                emit!(AgentToken::AccTitle, e);
                                matched = true;
                            } else if let Some(e) = match_acc_header(src, p, "accDescr", b':') {
                                push_state!(State::AccDescr);
                                emit!(AgentToken::AccDescr, e);
                                matched = true;
                            } else if let Some(e) = match_acc_header(src, p, "accDescr", b'{') {
                                push_state!(State::AccDescrMultiline);
                                advance(&mut p, &mut line, &mut col, e);
                                matched = true;
                            }
                        }
                        if !matched && kw(p, "agentflow-beta") {
                            if first_graph {
                                first_graph = false;
                                push_state!(State::Dir);
                            }
                            emit_flat!(AgentToken::Graph, p + 14);
                            matched = true;
                        }
                    }
                    b'@' => {
                        if bytes.get(p + 1) == Some(&b'{') {
                            push_state!(State::ShapeData);
                            emit_text!(AgentToken::ShapeData, String::new(), p + 2);
                            matched = true;
                        }
                    }
                    b'c' => {
                        if let Some(e) = match_kw_space(src, p, "call") {
                            push_state!(State::CallbackName);
                            advance(&mut p, &mut line, &mut col, e);
                            matched = true;
                        } else if kw(p, "classDef") {
                            emit_flat!(AgentToken::ClassDef, p + 8);
                            matched = true;
                        } else if kw(p, "class") {
                            emit_flat!(AgentToken::Class, p + 5);
                            matched = true;
                        } else if let Some(e) = match_kw_space(src, p, "click") {
                            push_state!(State::Click);
                            advance(&mut p, &mut line, &mut col, e);
                            matched = true;
                        } else if kw(p, "connector") {
                            emit_flat!(AgentToken::Connector, p + 9);
                            matched = true;
                        }
                    }
                    b'"' => {
                        quote!();
                        matched = true;
                    }
                    b's' => {
                        if kw(p, "style") {
                            emit_flat!(AgentToken::Style, p + 5);
                            matched = true;
                        }
                    }
                    b'd' => {
                        if kw(p, "default") {
                            emit_flat!(AgentToken::Default, p + 7);
                            matched = true;
                        }
                    }
                    b'l' => {
                        if kw(p, "linkStyle") {
                            emit_flat!(AgentToken::LinkStyle, p + 9);
                            matched = true;
                        }
                    }
                    b'i' => {
                        if kw(p, "interpolate") {
                            emit_flat!(AgentToken::Interpolate, p + 11);
                            matched = true;
                        }
                    }
                    b'h' => {
                        if src[p..].starts_with("href") && is_space_at(src, p + 4) {
                            let step = if bytes[p + 4] < 128 { 1 } else { next_char(src, p + 4).map_or(1, |(_, l)| l) };
                            emit!(AgentToken::Href, p + 4 + step);
                            matched = true;
                        }
                    }
                    b'f' => {
                        if kw(p, "flow") {
                            emit_flat!(AgentToken::Flow, p + 4);
                            matched = true;
                        }
                    }
                    b'g' => {
                        if kw(p, "global") {
                            emit_flat!(AgentToken::Global, blanks(p + 6));
                            matched = true;
                        }
                    }
                    b'e' => {
                        if kw(p, "end") {
                            emit_flat!(AgentToken::EndKw, blanks(p + 3));
                            matched = true;
                        }
                    }
                    b'_' => {
                        if kw(p, "_self") {
                            emit_flat!(AgentToken::LinkTarget, p + 5);
                            matched = true;
                        } else if kw(p, "_blank") {
                            emit_flat!(AgentToken::LinkTarget, p + 6);
                            matched = true;
                        } else if kw(p, "_parent") {
                            emit_flat!(AgentToken::LinkTarget, p + 7);
                            matched = true;
                        } else if kw(p, "_top") {
                            emit_flat!(AgentToken::LinkTarget, p + 4);
                            matched = true;
                        }
                    }
                    _ => {}
                }
                if matched {
                    continue;
                }

                // Direction statements (`.*direction\s+(TB|BT|RL|LR|TD)[^\n]*`)
                if dir_next.is_some() && p >= dir_failed {
                    if let Some(dn) = dir_next
                        && dn < p
                    {
                        dir_next = src[p..].find("direction").map(|rel| p + rel);
                    }
                    if let Some(dn) = dir_next {
                        let le = match line_end {
                            Some(cur) if cur >= p => cur,
                            _ => {
                                let found = find_line_end(src, p);
                                line_end = Some(found);
                                found
                            }
                        };
                        if dn < le {
                            const DIRS: [(&str, AgentToken); 5] = [
                                ("TB", AgentToken::DirectionTb),
                                ("BT", AgentToken::DirectionBt),
                                ("RL", AgentToken::DirectionRl),
                                ("LR", AgentToken::DirectionLr),
                                ("TD", AgentToken::DirectionTd),
                            ];
                            let slice = &src[p..le];
                            let mut dir_match: Option<(AgentToken, usize)> = None;
                            for (code, tok) in DIRS {
                                let mut search = 0;
                                while let Some(rel) = slice[search..].find("direction") {
                                    let after_kw = p + search + rel + 9;
                                    let after_ws = ws_end!(after_kw);
                                    if after_ws > after_kw && src[after_ws..].starts_with(code) {
                                        let end = src[after_ws + 2..].find('\n').map_or(n, |r| after_ws + 2 + r);
                                        dir_match = Some((tok, end));
                                        break;
                                    }
                                    search += rel + 9;
                                }
                                if dir_match.is_some() {
                                    break;
                                }
                            }
                            if let Some((tok, end)) = dir_match {
                                emit!(tok, end);
                                continue;
                            }
                            dir_failed = le;
                        }
                    }
                }

                // Link ID: non-space run up to last `@` not followed by `{` or `"`.
                if at_next.is_some() && b != b'"' && !is_space_at(src, p) {
                    if p >= run_end {
                        if let Some(an) = at_next
                            && an < p
                        {
                            at_next = src[p..].find('@').map(|rel| p + rel);
                        }
                        let mut q = p;
                        while q < n {
                            let ch = bytes[q];
                            if ch == b'"' {
                                break;
                            }
                            if ch < 128 {
                                if matches!(ch, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c) {
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
                        run_end = q;
                        run_at = None;
                        if let Some(an) = at_next
                            && an < q
                        {
                            let mut k = q.min(n.saturating_sub(1));
                            while k > an {
                                k -= 1;
                                if bytes[k] != b'@' {
                                    continue;
                                }
                                let after = bytes.get(k + 1).copied();
                                if after != Some(b'{') && after != Some(b'"') {
                                    run_at = Some(k);
                                    break;
                                }
                            }
                        }
                    }
                    if let Some(ra) = run_at
                        && ra > p
                    {
                        emit_flat!(AgentToken::LinkId, ra + 1);
                        continue;
                    }
                }

                if b.is_ascii_digit() {
                    let mut q = p + 1;
                    while q < n && bytes[q].is_ascii_digit() {
                        q += 1;
                    }
                    emit_flat!(AgentToken::Num, q);
                    continue;
                }

                match b {
                    b'#' => {
                        emit_flat!(AgentToken::Brkt, p + 1);
                        continue;
                    }
                    b':' => {
                        if bytes.get(p + 1) == Some(&b':') && bytes.get(p + 2) == Some(&b':') {
                            emit_flat!(AgentToken::StyleSeparator, p + 3);
                        } else {
                            emit_flat!(AgentToken::Colon, p + 1);
                        }
                        continue;
                    }
                    b'&' => {
                        emit_flat!(AgentToken::Amp, p + 1);
                        continue;
                    }
                    b';' => {
                        emit_flat!(AgentToken::Semi, p + 1);
                        continue;
                    }
                    b',' => {
                        emit_flat!(AgentToken::Comma, p + 1);
                        continue;
                    }
                    b'*' => {
                        emit_flat!(AgentToken::Mult, p + 1);
                        continue;
                    }
                    b'<' => {
                        emit_flat!(AgentToken::TagStart, p + 1);
                        continue;
                    }
                    b'-' => {
                        if try_link!() || try_node_string!() {
                            continue;
                        }
                        emit_flat!(AgentToken::Minus, p + 1);
                        continue;
                    }
                    b'(' => {
                        ok = opener!(b);
                    }
                    b'[' => {
                        if bytes.get(p + 1) == Some(&b'|') {
                            emit_flat!(AgentToken::VertexWithPropsStart, p + 2);
                        } else {
                            ok = opener!(b);
                        }
                    }
                    b'|' | b'{' => {
                        ok = opener!(b);
                    }
                    b'>' => {
                        push_state!(State::Text);
                        emit_flat!(AgentToken::TagEnd, p + 1);
                        continue;
                    }
                    b'^' => {
                        emit_flat!(AgentToken::Up, p + 1);
                        continue;
                    }
                    b'\\' => {
                        if bytes.get(p + 1) == Some(&b'|') {
                            emit_flat!(AgentToken::Sep, p + 2);
                        } else {
                            ok = try_node_string!();
                        }
                    }
                    b'v' => {
                        if bytes.get(p + 1).is_none_or(|&ch| !is_word(ch as u32)) {
                            emit_flat!(AgentToken::Down, p + 1);
                        } else {
                            ok = try_node_string!();
                        }
                    }
                    b'%' => {
                        if let Some(e) = comment_end(p) {
                            emit!(AgentToken::Comment, e);
                        } else {
                            ok = try_node_string!();
                        }
                    }
                    _ => {
                        if is_space_at(src, p) {
                            if try_link!() {
                                continue;
                            }
                            if matches!(b, b' ' | b'\t')
                                && let Some(e) = comment_end(blank_end!(p))
                            {
                                emit!(AgentToken::Comment, e);
                                continue;
                            }
                            let mut e = p;
                            while e < n {
                                if bytes[e] == b'\n' {
                                    e += 1;
                                } else if bytes[e] == b'\r' && bytes.get(e + 1) == Some(&b'\n') {
                                    e += 2;
                                } else {
                                    break;
                                }
                            }
                            if e > p {
                                emit!(AgentToken::Newline, e);
                            } else {
                                let step = if b < 128 { 1 } else { next_char(src, p).map_or(1, |(_, l)| l) };
                                emit!(AgentToken::Space, p + step);
                            }
                            continue;
                        }
                        if b < 128 {
                            ok = try_node_string!();
                        } else if let Some((uc, len)) = next_char(src, p)
                            && is_unicode_letter(uc as u32)
                        {
                            emit_flat!(AgentToken::UnicodeText, p + len);
                        } else {
                            ok = false;
                        }
                    }
                }
            }

            State::StringLit => {
                if b == b'"' {
                    if bytes.get(p + 1) == Some(&b'`') {
                        push_state!(State::MdString);
                        let next = p + 2;
                        advance(&mut p, &mut line, &mut col, next);
                    } else {
                        pop_state!();
                        let next = p + 1;
                        advance(&mut p, &mut line, &mut col, next);
                    }
                } else {
                    let end = src[p..].find('"').map_or(n, |rel| p + rel);
                    emit!(AgentToken::Str, end);
                }
            }

            State::MdString => {
                if b == b'`' {
                    if bytes.get(p + 1) == Some(&b'"') {
                        pop_state!();
                        let next = p + 2;
                        advance(&mut p, &mut line, &mut col, next);
                    } else {
                        ok = false;
                    }
                } else if b == b'"' {
                    quote!();
                } else {
                    let mut q = p + 1;
                    while q < n && bytes[q] != b'`' && bytes[q] != b'"' {
                        q += 1;
                    }
                    emit!(AgentToken::MdStr, q);
                }
            }

            State::AccTitle | State::AccDescr => {
                let end = src[p..].find('\n').map_or(n, |rel| p + rel);
                let tok = if state == State::AccTitle {
                    AgentToken::AccTitleValue
                } else {
                    AgentToken::AccDescrValue
                };
                pop_state!();
                emit!(tok, end);
            }

            State::AccDescrMultiline => {
                if b == b'}' {
                    pop_state!();
                    let next = p + 1;
                    advance(&mut p, &mut line, &mut col, next);
                } else {
                    let end = src[p..].find('}').map_or(n, |rel| p + rel);
                    emit!(AgentToken::AccDescrMultilineValue, end);
                }
            }

            State::Dir => {
                if b == b'"' {
                    quote!();
                } else if let Some(e) = match_nodir(src, p) {
                    pop_state!();
                    emit!(AgentToken::NoDir, e);
                } else if let Some(e) = match_dir(src, p) {
                    pop_state!();
                    emit!(AgentToken::Dir, e);
                } else {
                    ok = opener!(b);
                }
            }

            State::Text => {
                let d = bytes.get(p + 1).copied();
                match b {
                    b'"' => {
                        quote!();
                    }
                    b'(' | b'[' | b'{' => {
                        let _ = opener!(b);
                    }
                    b']' => {
                        pop_state!();
                        if d == Some(b')') {
                            emit_flat!(AgentToken::StadiumEnd, p + 2);
                        } else if d == Some(b']') {
                            emit_flat!(AgentToken::SubroutineEnd, p + 2);
                        } else {
                            emit_flat!(AgentToken::Sqe, p + 1);
                        }
                    }
                    b')' => {
                        pop_state!();
                        if d == Some(b']') {
                            emit_flat!(AgentToken::CylinderEnd, p + 2);
                        } else if d == Some(b')') && bytes.get(p + 2) == Some(&b')') {
                            emit_flat!(AgentToken::DoubleCircleEnd, p + 3);
                        } else {
                            emit_flat!(AgentToken::Pe, p + 1);
                        }
                    }
                    b'|' => {
                        pop_state!();
                        emit_flat!(AgentToken::Pipe, p + 1);
                    }
                    b'}' => {
                        pop_state!();
                        emit_flat!(AgentToken::DiamondStop, p + 1);
                    }
                    b'%' => {
                        if let Some(e) = comment_end(p) {
                            advance(&mut p, &mut line, &mut col, e);
                        } else {
                            ok = false;
                        }
                    }
                    _ => {
                        let mut q = p + if b < 128 { 1 } else { next_char(src, p).map_or(1, |(_, l)| l) };
                        while q < n {
                            let ch = bytes[q];
                            if matches!(ch, b'[' | b']' | b'(' | b')' | b'{' | b'}' | b'|' | b'"' | b'%') {
                                break;
                            }
                            q += 1;
                        }
                        emit!(AgentToken::Text, q);
                    }
                }
            }

            State::EllipseText => {
                let d = bytes.get(p + 1).copied();
                if b == b'"' {
                    quote!();
                } else if b == b'%'
                    && let Some(e) = comment_end(p)
                {
                    advance(&mut p, &mut line, &mut col, e);
                } else if matches!(b, b'-' | b'/' | b')') && d == Some(b')') {
                    pop_state!();
                    emit_flat!(AgentToken::EllipseEnd, p + 2);
                } else if matches!(b, b'(' | b'[' | b'{') {
                    let _ = opener!(b);
                } else if matches!(b, b')' | b']' | b'}') {
                    ok = false;
                } else {
                    let mut q = p + if b < 128 { 1 } else { next_char(src, p).map_or(1, |(_, l)| l) };
                    while q < n {
                        let ch = bytes[q];
                        if matches!(ch, b'"' | b'(' | b')' | b'[' | b']' | b'{' | b'}') {
                            break;
                        }
                        if matches!(ch, b'-' | b'/') && bytes.get(q + 1) == Some(&b')') {
                            break;
                        }
                        if ch == b'%' && bytes.get(q + 1) == Some(&b'%') && bytes.get(q + 2) != Some(&b'{') {
                            break;
                        }
                        q += 1;
                    }
                    emit_chars!(AgentToken::Text, q);
                }
            }

            State::TrapText => {
                let d = bytes.get(p + 1).copied();
                if b == b'"' {
                    quote!();
                } else {
                    match b {
                        b'(' => {
                            if d == Some(b'-') || d == Some(b'[') || (d == Some(b'(') && bytes.get(p + 2) == Some(&b'(')) {
                                let _ = opener!(b);
                            } else if d == Some(b']') {
                                pop_state!();
                                emit_flat!(AgentToken::TrapEnd, p + 2);
                            } else {
                                let _ = opener!(b);
                            }
                        }
                        b'[' | b'{' => {
                            let _ = opener!(b);
                        }
                        b'\\' => {
                            if d == Some(b']') {
                                pop_state!();
                                emit_flat!(AgentToken::TrapEnd, p + 2);
                            } else {
                                emit_flat!(AgentToken::Text, p + 1);
                            }
                        }
                        b'/' => {
                            if d == Some(b']') {
                                pop_state!();
                                emit_flat!(AgentToken::InvTrapEnd, p + 2);
                            } else {
                                emit_flat!(AgentToken::Text, p + 1);
                            }
                        }
                        b']' | b')' => {
                            if d == Some(b']') {
                                pop_state!();
                                emit_flat!(AgentToken::TrapEnd, p + 2);
                            } else {
                                ok = false;
                            }
                        }
                        b'}' => {
                            ok = false;
                        }
                        b'%' => {
                            if let Some(e) = comment_end(p) {
                                advance(&mut p, &mut line, &mut col, e);
                            } else {
                                ok = false;
                            }
                        }
                        _ => {
                            if matches!(b, b'?' | b'=') && d == Some(b']') {
                                pop_state!();
                                emit_flat!(AgentToken::TrapEnd, p + 2);
                            } else {
                                let mut q = p + if b < 128 { 1 } else { next_char(src, p).map_or(1, |(_, l)| l) };
                                while q < n {
                                    let ch = bytes[q];
                                    if matches!(ch, b'\\' | b'[' | b']' | b'(' | b')' | b'{' | b'}' | b'/' | b'%') {
                                        break;
                                    }
                                    q += 1;
                                }
                                emit!(AgentToken::Text, q);
                            }
                        }
                    }
                }
            }

            State::EdgeText => {
                if b == b'"' {
                    quote!();
                } else if let Some(e) = arrow_end!(p) {
                    pop_state!();
                    emit!(AgentToken::Link, e);
                } else if b == b'-' && bytes.get(p + 1) == Some(&b'-') {
                    ok = false;
                } else {
                    let mut q = p + if b < 128 { 1 } else { next_char(src, p).map_or(1, |(_, l)| l) };
                    while q < n {
                        let ch = bytes[q];
                        if ch == b'"' {
                            break;
                        }
                        if ch == b'-' {
                            if bytes.get(q + 1) == Some(&b'-') {
                                break;
                            }
                            q += 1;
                        } else if is_space_at(src, q) {
                            if arrow_end!(q).is_some() {
                                break;
                            }
                            q += if ch < 128 { 1 } else { next_char(src, q).map_or(1, |(_, l)| l) };
                        } else {
                            q += if ch < 128 { 1 } else { next_char(src, q).map_or(1, |(_, l)| l) };
                        }
                    }
                    emit_chars!(AgentToken::EdgeText, q);
                }
            }

            State::Click => {
                if b == b'"' {
                    quote!();
                } else if is_space_at(src, p) {
                    pop_state!();
                    let next = p + if b < 128 { 1 } else { next_char(src, p).map_or(1, |(_, l)| l) };
                    advance(&mut p, &mut line, &mut col, next);
                } else {
                    let mut q = p + if b < 128 { 1 } else { next_char(src, p).map_or(1, |(_, l)| l) };
                    while q < n && !is_space_at(src, q) {
                        let step = if bytes[q] < 128 { 1 } else { next_char(src, q).map_or(1, |(_, l)| l) };
                        q += step;
                    }
                    emit_flat!(AgentToken::Click, q);
                }
            }

            State::CallbackName => {
                if b == b'(' {
                    let empty = match_empty_call(src, p);
                    pop_state!();
                    if let Some(e) = empty {
                        advance(&mut p, &mut line, &mut col, e);
                    } else {
                        push_state!(State::CallbackArgs);
                        let next = p + 1;
                        advance(&mut p, &mut line, &mut col, next);
                    }
                } else {
                    let end = src[p..].find('(').map_or(n, |rel| p + rel);
                    emit!(AgentToken::CallbackName, end);
                }
            }

            State::CallbackArgs => {
                if b == b')' {
                    pop_state!();
                    let next = p + 1;
                    advance(&mut p, &mut line, &mut col, next);
                } else {
                    let end = src[p..].find(')').map_or(n, |rel| p + rel);
                    emit!(AgentToken::CallbackArgs, end);
                }
            }

            State::ShapeData => {
                if b == b'"' {
                    push_state!(State::ShapeDataStr);
                    emit_flat!(AgentToken::ShapeData, p + 1);
                } else if b == b'}' {
                    pop_state!();
                    let next = p + 1;
                    advance(&mut p, &mut line, &mut col, next);
                } else if b == b'^' {
                    ok = false;
                } else {
                    let mut q = p + if b < 128 { 1 } else { next_char(src, p).map_or(1, |(_, l)| l) };
                    while q < n && !matches!(bytes[q], b'}' | b'^' | b'"') {
                        q += 1;
                    }
                    emit!(AgentToken::ShapeData, q);
                }
            }

            State::ShapeDataStr => {
                if b == b'"' {
                    pop_state!();
                    emit_flat!(AgentToken::ShapeData, p + 1);
                } else {
                    let end = src[p..].find('"').map_or(n, |rel| p + rel);
                    let replaced = replace_nl_spaces(&src[p..end]);
                    emit_text!(AgentToken::ShapeData, replaced, end);
                }
            }
        }

        if !ok {
            types.push(AgentToken::Error);
            texts.push(String::new());
            starts.push(p);
            locs.push(line);
            locs.push(col);
            locs.push(line);
            locs.push(col);
            return AgentTokens { types, texts, starts, locs };
        }
    }

    types.push(AgentToken::End);
    texts.push(String::new());
    starts.push(n);
    locs.push(line);
    locs.push(col);
    locs.push(line);
    locs.push(col);
    AgentTokens { types, texts, starts, locs }
}
