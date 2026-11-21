use crate::util::chars::{is_space_char, is_word};
use crate::util::unicode::is_unicode_letter;

use super::tokens::FlowToken;

pub struct FlowTokens {
    pub types: Vec<FlowToken>,
    pub texts: Vec<String>,
    pub starts: Vec<usize>,
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
    ThickEdgeText,
    DottedEdgeText,
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

fn skip_spaces(src: &str, mut p: usize) -> usize {
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

fn skip_hspaces(src: &str, mut p: usize) -> usize {
    let bytes = src.as_bytes();
    let n = bytes.len();
    while p < n {
        let b = bytes[p];
        if b < 128 {
            if matches!(b, b' ' | b'\t' | 0x0b | 0x0c) {
                p += 1;
            } else {
                break;
            }
        } else if let Some((ch, len)) = next_char(src, p)
            && is_space_char(ch)
            && ch != '\n'
            && ch != '\r'
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
    let q = skip_spaces(src, p + kw.len());
    if src.as_bytes().get(q) != Some(&delim) {
        return None;
    }
    Some(skip_spaces(src, q + 1))
}

fn match_kw_space(src: &str, p: usize, kw: &str) -> Option<usize> {
    if !src[p..].starts_with(kw) {
        return None;
    }
    let after = p + kw.len();
    let end = skip_spaces(src, after);
    (end > after).then_some(end)
}

fn match_nodir(src: &str, p: usize) -> Option<usize> {
    let end = skip_spaces(src, p);
    let last_nl = src[p..end].rfind('\n')?;
    Some(p + last_nl + 1)
}

fn match_dir(src: &str, p: usize) -> Option<usize> {
    let q = skip_spaces(src, p);
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

fn match_link(src: &str, p: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut q = skip_spaces(src, p);
    if matches!(bytes.get(q), Some(b'x' | b'o' | b'<')) {
        q += 1;
    }
    let start_dash = q;
    while bytes.get(q) == Some(&b'-') {
        q += 1;
    }
    let dashes = q - start_dash;
    if matches!(bytes.get(q), Some(b'x' | b'o' | b'>')) {
        if dashes < 2 {
            return None;
        }
        q += 1;
    } else if dashes < 3 {
        return None;
    }
    Some(skip_spaces(src, q))
}

fn match_start_link(src: &str, p: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut q = skip_spaces(src, p);
    if matches!(bytes.get(q), Some(b'x' | b'o' | b'<')) {
        q += 1;
    }
    if bytes.get(q) == Some(&b'-') && bytes.get(q + 1) == Some(&b'-') {
        Some(skip_spaces(src, q + 2))
    } else {
        None
    }
}

fn match_thick_link(src: &str, p: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut q = skip_spaces(src, p);
    if matches!(bytes.get(q), Some(b'x' | b'o' | b'<')) {
        q += 1;
    }
    let start_eq = q;
    while bytes.get(q) == Some(&b'=') {
        q += 1;
    }
    let eqs = q - start_eq;
    if matches!(bytes.get(q), Some(b'x' | b'o' | b'>')) {
        if eqs < 2 {
            return None;
        }
        q += 1;
    } else if eqs < 3 {
        return None;
    }
    Some(skip_spaces(src, q))
}

fn match_thick_start(src: &str, p: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut q = skip_spaces(src, p);
    if matches!(bytes.get(q), Some(b'x' | b'o' | b'<')) {
        q += 1;
    }
    if bytes.get(q) == Some(&b'=') && bytes.get(q + 1) == Some(&b'=') {
        Some(skip_spaces(src, q + 2))
    } else {
        None
    }
}

fn match_dotted_link(src: &str, p: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut q = skip_spaces(src, p);
    if matches!(bytes.get(q), Some(b'x' | b'o' | b'<')) {
        q += 1;
    }
    if bytes.get(q) == Some(&b'-') {
        q += 1;
    }
    let dot_start = q;
    while bytes.get(q) == Some(&b'.') {
        q += 1;
    }
    if q == dot_start || bytes.get(q) != Some(&b'-') {
        return None;
    }
    q += 1;
    if matches!(bytes.get(q), Some(b'x' | b'o' | b'>')) {
        q += 1;
    }
    Some(skip_spaces(src, q))
}

fn match_dotted_start(src: &str, p: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut q = skip_spaces(src, p);
    if matches!(bytes.get(q), Some(b'x' | b'o' | b'<')) {
        q += 1;
    }
    if bytes.get(q) == Some(&b'-') && bytes.get(q + 1) == Some(&b'.') {
        Some(skip_spaces(src, q + 2))
    } else {
        None
    }
}

fn match_invis_link(src: &str, p: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut q = skip_spaces(src, p);
    let start = q;
    while bytes.get(q) == Some(&b'~') {
        q += 1;
    }
    if q - start < 3 {
        return None;
    }
    Some(skip_spaces(src, q))
}

fn match_newline(src: &str, p: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut q = p;
    while q < bytes.len() {
        if bytes[q] == b'\r' && bytes.get(q + 1) == Some(&b'\n') {
            q += 2;
        } else if bytes[q] == b'\n' {
            q += 1;
        } else {
            break;
        }
    }
    (q > p).then_some(q)
}

fn match_empty_call(src: &str, p: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    if bytes.get(p) != Some(&b'(') {
        return None;
    }
    let q = skip_spaces(src, p + 1);
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

fn match_direction_stmt(src: &str, p: usize, line_end: usize) -> Option<(FlowToken, usize)> {
    const DIRS: [(&str, FlowToken); 5] = [
        ("TB", FlowToken::DirectionTb),
        ("BT", FlowToken::DirectionBt),
        ("RL", FlowToken::DirectionRl),
        ("LR", FlowToken::DirectionLr),
        ("TD", FlowToken::DirectionTd),
    ];
    let slice = &src[p..line_end];
    for (code, tok) in DIRS {
        let mut search = 0;
        while let Some(rel) = slice[search..].find("direction") {
            let after_kw = p + search + rel + 9;
            let after_ws = skip_spaces(src, after_kw);
            if after_ws > after_kw && src[after_ws..].starts_with(code) {
                let end = src[p..].find('\n').map_or(src.len(), |r| p + r);
                return Some((tok, end));
            }
            search += rel + 9;
        }
    }
    None
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
            i = skip_spaces(s, i + 1);
        } else {
            let (ch, len) = next_char(s, i).unwrap();
            out.push(ch);
            i += len;
        }
    }
    out
}

pub fn tokenize(src: &str) -> FlowTokens {
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut types: Vec<FlowToken> = Vec::new();
    let mut texts: Vec<String> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    let mut stack: Vec<State> = Vec::new();
    let mut state = State::Initial;
    let mut p = 0usize;
    let mut first_graph = true;
    let mut dir_next = src.find("direction");
    let mut at_next = src.find('@');
    let mut line_end = 0usize;
    let mut line_end_valid = false;
    let mut dir_failed = 0usize;
    let mut run_end = 0usize;
    let mut run_at: Option<usize> = None;
    let mut ws_from = usize::MAX;
    let mut ws_to = 0usize;

    macro_rules! emit {
        ($t:expr, $s:expr, $e:expr) => {{
            types.push($t);
            texts.push(src[$s..$e].to_string());
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

    let kw = |p: usize, word: &str| -> bool { src[p..].starts_with(word) && !bytes.get(p + word.len()).is_some_and(|&b| is_word(b as u32)) };

    let link_char = |q: usize, ws_from: &mut usize, ws_to: &mut usize| -> u8 {
        let j = if q >= *ws_from && q <= *ws_to {
            *ws_to
        } else if is_space_at(src, q) {
            let end = skip_spaces(src, q);
            *ws_from = q;
            *ws_to = end;
            end
        } else {
            q
        };
        let d = bytes.get(j).copied().unwrap_or(0);
        if matches!(d, b'x' | b'o' | b'<') {
            bytes.get(j + 1).copied().unwrap_or(0)
        } else {
            d
        }
    };

    let invis_ahead = |q: usize, ws_from: &mut usize, ws_to: &mut usize| -> bool {
        let j = if q >= *ws_from && q <= *ws_to {
            *ws_to
        } else if is_space_at(src, q) {
            let end = skip_spaces(src, q);
            *ws_from = q;
            *ws_to = end;
            end
        } else {
            q
        };
        bytes.get(j) == Some(&b'~')
    };

    loop {
        if p >= n {
            let eof_tok = match state {
                State::Initial => Some(FlowToken::Eof),
                State::AccTitle => Some(FlowToken::AccTitleValue),
                State::AccDescr => Some(FlowToken::AccDescrValue),
                State::AccDescrMultiline => Some(FlowToken::AccDescrMultilineValue),
                State::Click => Some(FlowToken::Click),
                State::CallbackName => Some(FlowToken::CallbackName),
                State::CallbackArgs => Some(FlowToken::CallbackArgs),
                State::StringLit
                | State::MdString
                | State::Dir
                | State::Text
                | State::EllipseText
                | State::TrapText
                | State::EdgeText
                | State::ThickEdgeText
                | State::DottedEdgeText
                | State::ShapeData
                | State::ShapeDataStr => None,
            };
            if let Some(t) = eof_tok {
                types.push(t);
                texts.push(String::new());
                starts.push(n);
            }
            break;
        }

        let c = bytes[p];
        let d = bytes.get(p + 1).copied().unwrap_or(0);
        let mut ok = true;

        let try_invis =
            |p_ref: &mut usize, ws_from: &mut usize, ws_to: &mut usize, types: &mut Vec<FlowToken>, texts: &mut Vec<String>, starts: &mut Vec<usize>| -> bool {
                if !invis_ahead(*p_ref, ws_from, ws_to) {
                    return false;
                }
                if let Some(e) = match_invis_link(src, *p_ref) {
                    types.push(FlowToken::Link);
                    texts.push(src[*p_ref..e].to_string());
                    starts.push(*p_ref);
                    *p_ref = e;
                    true
                } else {
                    false
                }
            };

        let try_opener = |c: u8,
                          d: u8,
                          p_ref: &mut usize,
                          state_ref: &mut State,
                          stack_ref: &mut Vec<State>,
                          types: &mut Vec<FlowToken>,
                          texts: &mut Vec<String>,
                          starts: &mut Vec<usize>|
         -> bool {
            let p0 = *p_ref;
            let (next_state, tok, len) = match c {
                b'(' => {
                    if d == b'-' {
                        (State::EllipseText, FlowToken::EllipseStart, 2)
                    } else if d == b'[' {
                        (State::Text, FlowToken::StadiumStart, 2)
                    } else if d == b'(' && bytes.get(p0 + 2) == Some(&b'(') {
                        (State::Text, FlowToken::DoubleCircleStart, 3)
                    } else {
                        (State::Text, FlowToken::Ps, 1)
                    }
                }
                b'[' => {
                    if d == b'[' {
                        (State::Text, FlowToken::SubroutineStart, 2)
                    } else if d == b'(' {
                        (State::Text, FlowToken::CylinderStart, 2)
                    } else if d == b'/' {
                        (State::TrapText, FlowToken::TrapStart, 2)
                    } else if d == b'\\' {
                        (State::TrapText, FlowToken::InvTrapStart, 2)
                    } else {
                        (State::Text, FlowToken::Sqs, 1)
                    }
                }
                b'|' => (State::Text, FlowToken::Pipe, 1),
                b'{' => (State::Text, FlowToken::DiamondStart, 1),
                _ => return false,
            };
            stack_ref.push(*state_ref);
            *state_ref = next_state;
            types.push(tok);
            texts.push(src[p0..p0 + len].to_string());
            starts.push(p0);
            *p_ref = p0 + len;
            true
        };

        let try_node_string = |p_ref: &mut usize, types: &mut Vec<FlowToken>, texts: &mut Vec<String>, starts: &mut Vec<usize>| -> bool {
            let p0 = *p_ref;
            let mut q = p0;
            while q < n {
                let ch = bytes[q];
                if ch < 128 && NODE_CHAR[ch as usize] {
                    q += 1;
                } else if ch == b'-' && q + 1 < n {
                    let nb = bytes[q + 1];
                    if nb == b'>' || nb == b'-' || nb == b'.' {
                        break;
                    }
                    q += 1;
                } else {
                    break;
                }
            }
            if q == p0 {
                return false;
            }
            types.push(FlowToken::NodeString);
            texts.push(src[p0..q].to_string());
            starts.push(p0);
            *p_ref = q;
            true
        };

        let try_link = |c: u8,
                        p_ref: &mut usize,
                        state_ref: &mut State,
                        stack_ref: &mut Vec<State>,
                        ws_from: &mut usize,
                        ws_to: &mut usize,
                        types: &mut Vec<FlowToken>,
                        texts: &mut Vec<String>,
                        starts: &mut Vec<usize>|
         -> bool {
            let p0 = *p_ref;
            let lc = link_char(p0, ws_from, ws_to);
            if lc == b'-' {
                if let Some(e) = match_link(src, p0) {
                    types.push(FlowToken::Link);
                    texts.push(src[p0..e].to_string());
                    starts.push(p0);
                    *p_ref = e;
                    return true;
                }
                if let Some(e) = match_start_link(src, p0) {
                    stack_ref.push(*state_ref);
                    *state_ref = State::EdgeText;
                    types.push(FlowToken::StartLink);
                    texts.push(src[p0..e].to_string());
                    starts.push(p0);
                    *p_ref = e;
                    return true;
                }
                if let Some(e) = match_dotted_link(src, p0) {
                    types.push(FlowToken::Link);
                    texts.push(src[p0..e].to_string());
                    starts.push(p0);
                    *p_ref = e;
                    return true;
                }
                if let Some(e) = match_dotted_start(src, p0) {
                    stack_ref.push(*state_ref);
                    *state_ref = State::DottedEdgeText;
                    types.push(FlowToken::StartLink);
                    texts.push(src[p0..e].to_string());
                    starts.push(p0);
                    *p_ref = e;
                    return true;
                }
            } else if lc == b'=' {
                if let Some(e) = match_thick_link(src, p0) {
                    types.push(FlowToken::Link);
                    texts.push(src[p0..e].to_string());
                    starts.push(p0);
                    *p_ref = e;
                    return true;
                }
                if let Some(e) = match_thick_start(src, p0) {
                    stack_ref.push(*state_ref);
                    *state_ref = State::ThickEdgeText;
                    types.push(FlowToken::StartLink);
                    texts.push(src[p0..e].to_string());
                    starts.push(p0);
                    *p_ref = e;
                    return true;
                }
            } else if lc == b'.'
                && let Some(e) = match_dotted_link(src, p0)
            {
                types.push(FlowToken::Link);
                texts.push(src[p0..e].to_string());
                starts.push(p0);
                *p_ref = e;
                return true;
            }
            c != b'-' && c != b'=' && c != b'.' && try_invis(p_ref, ws_from, ws_to, types, texts, starts)
        };

        match state {
            State::Initial => {
                let mut handled = false;
                match c {
                    b'a' if src[p..].starts_with("acc") => {
                        if let Some(e) = match_acc_header(src, p, "accTitle", b':') {
                            push_state!(State::AccTitle);
                            emit!(FlowToken::AccTitle, p, e);
                            handled = true;
                        } else if let Some(e) = match_acc_header(src, p, "accDescr", b':') {
                            push_state!(State::AccDescr);
                            emit!(FlowToken::AccDescr, p, e);
                            handled = true;
                        } else if let Some(e) = match_acc_header(src, p, "accDescr", b'{') {
                            push_state!(State::AccDescrMultiline);
                            p = e;
                            handled = true;
                        }
                    }
                    b'@' if d == b'{' => {
                        push_state!(State::ShapeData);
                        types.push(FlowToken::ShapeData);
                        texts.push(String::new());
                        starts.push(p);
                        p += 2;
                        handled = true;
                    }
                    b'c' => {
                        if let Some(e) = match_kw_space(src, p, "call") {
                            push_state!(State::CallbackName);
                            p = e;
                            handled = true;
                        } else if kw(p, "classDef") {
                            emit!(FlowToken::ClassDef, p, p + 8);
                            handled = true;
                        } else if kw(p, "class") {
                            emit!(FlowToken::Class, p, p + 5);
                            handled = true;
                        } else if let Some(e) = match_kw_space(src, p, "click") {
                            push_state!(State::Click);
                            p = e;
                            handled = true;
                        }
                    }
                    b'"' => {
                        if d == b'`' {
                            push_state!(State::MdString);
                            p += 2;
                        } else {
                            push_state!(State::StringLit);
                            p += 1;
                        }
                        handled = true;
                    }
                    b's' => {
                        if kw(p, "style") {
                            emit!(FlowToken::Style, p, p + 5);
                            handled = true;
                        } else if kw(p, "swimlane-beta") {
                            if first_graph {
                                first_graph = false;
                                push_state!(State::Dir);
                            }
                            emit!(FlowToken::Graph, p, p + 13);
                            handled = true;
                        } else if kw(p, "subgraph") {
                            emit!(FlowToken::Subgraph, p, p + 8);
                            handled = true;
                        }
                    }
                    b'd' if kw(p, "default") => {
                        emit!(FlowToken::Default, p, p + 7);
                        handled = true;
                    }
                    b'l' if kw(p, "linkStyle") => {
                        emit!(FlowToken::LinkStyle, p, p + 9);
                        handled = true;
                    }
                    b'i' if kw(p, "interpolate") => {
                        emit!(FlowToken::Interpolate, p, p + 11);
                        handled = true;
                    }
                    b'h' if src[p..].starts_with("href") && is_space_at(src, p + 4) => {
                        let (_, slen) = next_char(src, p + 4).unwrap();
                        emit!(FlowToken::Href, p, p + 4 + slen);
                        handled = true;
                    }
                    b'f' => {
                        if kw(p, "flowchart-elk") {
                            if first_graph {
                                first_graph = false;
                                push_state!(State::Dir);
                            }
                            emit!(FlowToken::Graph, p, p + 13);
                            handled = true;
                        } else if kw(p, "flowchart") {
                            if first_graph {
                                first_graph = false;
                                push_state!(State::Dir);
                            }
                            emit!(FlowToken::Graph, p, p + 9);
                            handled = true;
                        }
                    }
                    b'g' if kw(p, "graph") => {
                        if first_graph {
                            first_graph = false;
                            push_state!(State::Dir);
                        }
                        emit!(FlowToken::Graph, p, p + 5);
                        handled = true;
                    }
                    b'e' if kw(p, "end") => {
                        let e = skip_spaces(src, p + 3);
                        emit!(FlowToken::EndKw, p, e);
                        handled = true;
                    }
                    b'_' => {
                        if kw(p, "_self") {
                            emit!(FlowToken::LinkTarget, p, p + 5);
                            handled = true;
                        } else if kw(p, "_blank") {
                            emit!(FlowToken::LinkTarget, p, p + 6);
                            handled = true;
                        } else if kw(p, "_parent") {
                            emit!(FlowToken::LinkTarget, p, p + 7);
                            handled = true;
                        } else if kw(p, "_top") {
                            emit!(FlowToken::LinkTarget, p, p + 4);
                            handled = true;
                        }
                    }
                    _ => {}
                }

                if !handled && dir_next.is_some() && p >= dir_failed {
                    if dir_next.is_some_and(|dn| dn < p) {
                        dir_next = src[p..].find("direction").map(|r| p + r);
                    }
                    if let Some(dn) = dir_next {
                        if !line_end_valid || line_end < p {
                            line_end = find_line_end(src, p);
                            line_end_valid = true;
                        }
                        if dn < line_end {
                            if let Some((tok, e)) = match_direction_stmt(src, p, line_end) {
                                emit!(tok, p, e);
                                handled = true;
                            } else {
                                dir_failed = line_end;
                            }
                        }
                    }
                }

                if !handled && at_next.is_some() && c != b'"' && !is_space_at(src, p) {
                    if p >= run_end {
                        if at_next.is_some_and(|an| an < p) {
                            at_next = src[p..].find('@').map(|r| p + r);
                        }
                        let mut q = p;
                        while q < n {
                            let ch = bytes[q];
                            if ch == b'"' || is_space_at(src, q) {
                                break;
                            }
                            if ch < 128 {
                                q += 1;
                            } else {
                                q += next_char(src, q).unwrap().1;
                            }
                        }
                        run_end = q;
                        run_at = None;
                        if let Some(an) = at_next
                            && an < q
                        {
                            let limit = q.min(n.saturating_sub(1));
                            let mut k = limit;
                            while k > an {
                                k -= 1;
                                if bytes[k] == b'@' {
                                    let after = bytes.get(k + 1).copied().unwrap_or(0);
                                    if after != b'{' && after != b'"' {
                                        run_at = Some(k);
                                        break;
                                    }
                                }
                            }
                            if run_at.is_none() && an < limit && bytes[an] == b'@' {
                                let after = bytes.get(an + 1).copied().unwrap_or(0);
                                if after != b'{' && after != b'"' {
                                    run_at = Some(an);
                                }
                            }
                        }
                    }
                    if let Some(ra) = run_at
                        && ra > p
                    {
                        emit!(FlowToken::LinkId, p, ra + 1);
                        handled = true;
                    }
                }

                if !handled && c.is_ascii_digit() {
                    let mut q = p + 1;
                    while q < n && bytes[q].is_ascii_digit() {
                        q += 1;
                    }
                    emit!(FlowToken::Num, p, q);
                    handled = true;
                }

                if !handled {
                    match c {
                        b'#' => {
                            emit!(FlowToken::Brkt, p, p + 1);
                            handled = true;
                        }
                        b':' => {
                            if d == b':' && bytes.get(p + 2) == Some(&b':') {
                                emit!(FlowToken::StyleSeparator, p, p + 3);
                            } else {
                                emit!(FlowToken::Colon, p, p + 1);
                            }
                            handled = true;
                        }
                        b'&' => {
                            emit!(FlowToken::Amp, p, p + 1);
                            handled = true;
                        }
                        b';' => {
                            emit!(FlowToken::Semi, p, p + 1);
                            handled = true;
                        }
                        b',' => {
                            emit!(FlowToken::Comma, p, p + 1);
                            handled = true;
                        }
                        b'*' => {
                            emit!(FlowToken::Mult, p, p + 1);
                            handled = true;
                        }
                        b'x' | b'o' => {
                            ok = try_link(c, &mut p, &mut state, &mut stack, &mut ws_from, &mut ws_to, &mut types, &mut texts, &mut starts)
                                || try_node_string(&mut p, &mut types, &mut texts, &mut starts);
                            handled = true;
                        }
                        b'<' => {
                            if !try_link(c, &mut p, &mut state, &mut stack, &mut ws_from, &mut ws_to, &mut types, &mut texts, &mut starts) {
                                emit!(FlowToken::TagStart, p, p + 1);
                            }
                            handled = true;
                        }
                        b'-' => {
                            if !try_link(c, &mut p, &mut state, &mut stack, &mut ws_from, &mut ws_to, &mut types, &mut texts, &mut starts)
                                && !try_node_string(&mut p, &mut types, &mut texts, &mut starts)
                            {
                                emit!(FlowToken::Minus, p, p + 1);
                            }
                            handled = true;
                        }
                        b'=' => {
                            ok = try_link(c, &mut p, &mut state, &mut stack, &mut ws_from, &mut ws_to, &mut types, &mut texts, &mut starts);
                            handled = true;
                        }
                        b'.' => {
                            ok = try_link(c, &mut p, &mut state, &mut stack, &mut ws_from, &mut ws_to, &mut types, &mut texts, &mut starts)
                                || try_node_string(&mut p, &mut types, &mut texts, &mut starts);
                            handled = true;
                        }
                        b'~' => {
                            ok = try_invis(&mut p, &mut ws_from, &mut ws_to, &mut types, &mut texts, &mut starts);
                            handled = true;
                        }
                        b'(' | b'|' | b'{' => {
                            ok = try_opener(c, d, &mut p, &mut state, &mut stack, &mut types, &mut texts, &mut starts);
                            handled = true;
                        }
                        b'[' => {
                            if d == b'|' {
                                emit!(FlowToken::VertexWithPropsStart, p, p + 2);
                            } else {
                                ok = try_opener(c, d, &mut p, &mut state, &mut stack, &mut types, &mut texts, &mut starts);
                            }
                            handled = true;
                        }
                        b'>' => {
                            push_state!(State::Text);
                            emit!(FlowToken::TagEnd, p, p + 1);
                            handled = true;
                        }
                        b'^' => {
                            emit!(FlowToken::Up, p, p + 1);
                            handled = true;
                        }
                        b'\\' => {
                            if d == b'|' {
                                emit!(FlowToken::Sep, p, p + 2);
                            } else {
                                ok = try_node_string(&mut p, &mut types, &mut texts, &mut starts);
                            }
                            handled = true;
                        }
                        b'v' => {
                            if !is_word(d as u32) {
                                emit!(FlowToken::Down, p, p + 1);
                            } else {
                                ok = try_node_string(&mut p, &mut types, &mut texts, &mut starts);
                            }
                            handled = true;
                        }
                        _ => {}
                    }
                }

                if !handled {
                    if is_space_at(src, p) {
                        if try_link(c, &mut p, &mut state, &mut stack, &mut ws_from, &mut ws_to, &mut types, &mut texts, &mut starts) {
                            ok = true;
                        } else if let Some(e) = match_newline(src, p) {
                            emit!(FlowToken::Newline, p, e);
                        } else {
                            let e = skip_hspaces(src, p);
                            if e > p {
                                emit!(FlowToken::Space, p, e);
                            } else {
                                ok = false;
                            }
                        }
                    } else if c < 128 {
                        ok = try_node_string(&mut p, &mut types, &mut texts, &mut starts);
                    } else if let Some((ch, len)) = next_char(src, p)
                        && is_unicode_letter(ch as u32)
                    {
                        emit!(FlowToken::UnicodeText, p, p + len);
                    } else {
                        ok = false;
                    }
                }
            }

            State::StringLit => {
                if c == b'"' {
                    if d == b'`' {
                        push_state!(State::MdString);
                        p += 2;
                    } else {
                        pop_state!();
                        p += 1;
                    }
                } else {
                    let e = src[p..].find('"').map_or(n, |r| p + r);
                    emit!(FlowToken::Str, p, e);
                }
            }

            State::MdString => {
                if c == b'`' {
                    if d == b'"' {
                        pop_state!();
                        p += 2;
                    } else {
                        ok = false;
                    }
                } else if c == b'"' {
                    if d == b'`' {
                        push_state!(State::MdString);
                        p += 2;
                    } else {
                        push_state!(State::StringLit);
                        p += 1;
                    }
                } else {
                    let mut q = p + next_char(src, p).unwrap().1;
                    while q < n {
                        let ch = bytes[q];
                        if ch == b'`' || ch == b'"' {
                            break;
                        }
                        if ch < 128 {
                            q += 1;
                        } else {
                            q += next_char(src, q).unwrap().1;
                        }
                    }
                    emit!(FlowToken::MdStr, p, q);
                }
            }

            State::AccTitle | State::AccDescr => {
                let e = src[p..].find('\n').map_or(n, |r| p + r);
                let tok = if state == State::AccTitle {
                    FlowToken::AccTitleValue
                } else {
                    FlowToken::AccDescrValue
                };
                pop_state!();
                emit!(tok, p, e);
            }

            State::AccDescrMultiline => {
                if c == b'}' {
                    pop_state!();
                    p += 1;
                } else {
                    let e = src[p..].find('}').map_or(n, |r| p + r);
                    emit!(FlowToken::AccDescrMultilineValue, p, e);
                }
            }

            State::Dir => {
                if c == b'"' {
                    if d == b'`' {
                        push_state!(State::MdString);
                        p += 2;
                    } else {
                        push_state!(State::StringLit);
                        p += 1;
                    }
                } else if let Some(e) = match_nodir(src, p) {
                    pop_state!();
                    emit!(FlowToken::NoDir, p, e);
                } else if let Some(e) = match_dir(src, p) {
                    pop_state!();
                    emit!(FlowToken::Dir, p, e);
                } else {
                    ok = try_invis(&mut p, &mut ws_from, &mut ws_to, &mut types, &mut texts, &mut starts)
                        || try_opener(c, d, &mut p, &mut state, &mut stack, &mut types, &mut texts, &mut starts);
                }
            }

            State::Text => match c {
                b'"' => {
                    if d == b'`' {
                        push_state!(State::MdString);
                        p += 2;
                    } else {
                        push_state!(State::StringLit);
                        p += 1;
                    }
                }
                b'(' | b'[' | b'{' => {
                    try_opener(c, d, &mut p, &mut state, &mut stack, &mut types, &mut texts, &mut starts);
                }
                b']' => {
                    pop_state!();
                    if d == b')' {
                        emit!(FlowToken::StadiumEnd, p, p + 2);
                    } else if d == b']' {
                        emit!(FlowToken::SubroutineEnd, p, p + 2);
                    } else {
                        emit!(FlowToken::Sqe, p, p + 1);
                    }
                }
                b')' => {
                    pop_state!();
                    if d == b']' {
                        emit!(FlowToken::CylinderEnd, p, p + 2);
                    } else if d == b')' && bytes.get(p + 2) == Some(&b')') {
                        emit!(FlowToken::DoubleCircleEnd, p, p + 3);
                    } else {
                        emit!(FlowToken::Pe, p, p + 1);
                    }
                }
                b'|' => {
                    pop_state!();
                    emit!(FlowToken::Pipe, p, p + 1);
                }
                b'}' => {
                    pop_state!();
                    emit!(FlowToken::DiamondStop, p, p + 1);
                }
                _ => {
                    if (c == b'~' || is_space_at(src, p)) && try_invis(&mut p, &mut ws_from, &mut ws_to, &mut types, &mut texts, &mut starts) {
                    } else {
                        let mut q = p + next_char(src, p).unwrap().1;
                        while q < n {
                            let ch = bytes[q];
                            if matches!(ch, b'[' | b']' | b'(' | b')' | b'{' | b'}' | b'|' | b'"') {
                                break;
                            }
                            if ch < 128 {
                                q += 1;
                            } else {
                                q += next_char(src, q).unwrap().1;
                            }
                        }
                        emit!(FlowToken::Text, p, q);
                    }
                }
            },

            State::EllipseText => {
                if c == b'"' {
                    if d == b'`' {
                        push_state!(State::MdString);
                        p += 2;
                    } else {
                        push_state!(State::StringLit);
                        p += 1;
                    }
                } else if (c == b'~' || is_space_at(src, p)) && try_invis(&mut p, &mut ws_from, &mut ws_to, &mut types, &mut texts, &mut starts) {
                } else if matches!(c, b'-' | b'/' | b')') && d == b')' {
                    pop_state!();
                    emit!(FlowToken::EllipseEnd, p, p + 2);
                } else if matches!(c, b'(' | b'[' | b'{') {
                    try_opener(c, d, &mut p, &mut state, &mut stack, &mut types, &mut texts, &mut starts);
                } else if matches!(c, b')' | b']' | b'}') {
                    ok = false;
                } else {
                    let mut q = p + next_char(src, p).unwrap().1;
                    while q < n {
                        let ch = bytes[q];
                        if matches!(ch, b'"' | b'(' | b')' | b'[' | b']' | b'{' | b'}') {
                            break;
                        }
                        if matches!(ch, b'-' | b'/') && bytes.get(q + 1) == Some(&b')') {
                            break;
                        }
                        if (ch == b'~' || is_space_at(src, q)) && invis_ahead(q, &mut ws_from, &mut ws_to) && match_invis_link(src, q).is_some() {
                            break;
                        }
                        if ch < 128 {
                            q += 1;
                        } else {
                            q += next_char(src, q).unwrap().1;
                        }
                    }
                    emit!(FlowToken::Text, p, q);
                }
            }

            State::TrapText => {
                if c == b'"' {
                    if d == b'`' {
                        push_state!(State::MdString);
                        p += 2;
                    } else {
                        push_state!(State::StringLit);
                        p += 1;
                    }
                } else if (c == b'~' || is_space_at(src, p)) && try_invis(&mut p, &mut ws_from, &mut ws_to, &mut types, &mut texts, &mut starts) {
                } else {
                    match c {
                        b'(' => {
                            if d == b'-' || d == b'[' || (d == b'(' && bytes.get(p + 2) == Some(&b'(')) {
                                try_opener(c, d, &mut p, &mut state, &mut stack, &mut types, &mut texts, &mut starts);
                            } else if d == b']' {
                                pop_state!();
                                emit!(FlowToken::TrapEnd, p, p + 2);
                            } else {
                                try_opener(c, d, &mut p, &mut state, &mut stack, &mut types, &mut texts, &mut starts);
                            }
                        }
                        b'[' | b'{' => {
                            try_opener(c, d, &mut p, &mut state, &mut stack, &mut types, &mut texts, &mut starts);
                        }
                        b'\\' => {
                            if d == b']' {
                                pop_state!();
                                emit!(FlowToken::TrapEnd, p, p + 2);
                            } else {
                                emit!(FlowToken::Text, p, p + 1);
                            }
                        }
                        b'/' => {
                            if d == b']' {
                                pop_state!();
                                emit!(FlowToken::InvTrapEnd, p, p + 2);
                            } else {
                                emit!(FlowToken::Text, p, p + 1);
                            }
                        }
                        b']' | b')' => {
                            if d == b']' {
                                pop_state!();
                                emit!(FlowToken::TrapEnd, p, p + 2);
                            } else {
                                ok = false;
                            }
                        }
                        b'}' => {
                            ok = false;
                        }
                        _ => {
                            if matches!(c, b'?' | b'=') && d == b']' {
                                pop_state!();
                                emit!(FlowToken::TrapEnd, p, p + 2);
                            } else {
                                let mut q = p + next_char(src, p).unwrap().1;
                                while q < n {
                                    let ch = bytes[q];
                                    if matches!(ch, b'\\' | b'[' | b']' | b'(' | b')' | b'{' | b'}' | b'/') {
                                        break;
                                    }
                                    if ch < 128 {
                                        q += 1;
                                    } else {
                                        q += next_char(src, q).unwrap().1;
                                    }
                                }
                                emit!(FlowToken::Text, p, q);
                            }
                        }
                    }
                }
            }

            State::EdgeText | State::ThickEdgeText | State::DottedEdgeText => {
                type LinkMatcher = fn(&str, usize) -> Option<usize>;
                let (a, b_alt, matcher): (u8, u8, LinkMatcher) = match state {
                    State::EdgeText => (b'-', 0, match_link),
                    State::ThickEdgeText => (b'=', 0, match_thick_link),
                    State::DottedEdgeText => (b'.', b'-', match_dotted_link),
                    _ => unreachable!(),
                };
                if c == b'"' {
                    if d == b'`' {
                        push_state!(State::MdString);
                        p += 2;
                    } else {
                        push_state!(State::StringLit);
                        p += 1;
                    }
                } else {
                    let lc = link_char(p, &mut ws_from, &mut ws_to);
                    if (lc == a || (b_alt != 0 && lc == b_alt))
                        && let Some(e) = matcher(src, p)
                    {
                        pop_state!();
                        emit!(FlowToken::Link, p, e);
                    } else if c == a && (a != b'-' || d == b'-') {
                        ok = false;
                    } else {
                        let mut q = p + next_char(src, p).unwrap().1;
                        while q < n {
                            let ch = bytes[q];
                            if ch == b'"' {
                                break;
                            }
                            if ch == a {
                                if a != b'-' || bytes.get(q + 1) == Some(&b'-') {
                                    break;
                                }
                            } else if matches!(ch, b'x' | b'o' | b'<') || (b_alt != 0 && ch == b_alt) || is_space_at(src, q) {
                                let dd = link_char(q, &mut ws_from, &mut ws_to);
                                if (dd == a || (b_alt != 0 && dd == b_alt)) && matcher(src, q).is_some() {
                                    break;
                                }
                            }
                            if ch < 128 {
                                q += 1;
                            } else {
                                q += next_char(src, q).unwrap().1;
                            }
                        }
                        emit!(FlowToken::EdgeText, p, q);
                    }
                }
            }

            State::Click => {
                if c == b'"' {
                    if d == b'`' {
                        push_state!(State::MdString);
                        p += 2;
                    } else {
                        push_state!(State::StringLit);
                        p += 1;
                    }
                } else if is_space_at(src, p) {
                    pop_state!();
                    p += next_char(src, p).unwrap().1;
                } else {
                    let mut q = p + next_char(src, p).unwrap().1;
                    while q < n && !is_space_at(src, q) {
                        if bytes[q] < 128 {
                            q += 1;
                        } else {
                            q += next_char(src, q).unwrap().1;
                        }
                    }
                    emit!(FlowToken::Click, p, q);
                }
            }

            State::CallbackName => {
                if c == b'(' {
                    let empty = match_empty_call(src, p);
                    pop_state!();
                    if let Some(e) = empty {
                        p = e;
                    } else {
                        push_state!(State::CallbackArgs);
                        p += 1;
                    }
                } else {
                    let e = src[p..].find('(').map_or(n, |r| p + r);
                    emit!(FlowToken::CallbackName, p, e);
                }
            }

            State::CallbackArgs => {
                if c == b')' {
                    pop_state!();
                    p += 1;
                } else {
                    let e = src[p..].find(')').map_or(n, |r| p + r);
                    emit!(FlowToken::CallbackArgs, p, e);
                }
            }

            State::ShapeData => {
                if c == b'"' {
                    push_state!(State::ShapeDataStr);
                    emit!(FlowToken::ShapeData, p, p + 1);
                } else if c == b'}' {
                    pop_state!();
                    p += 1;
                } else if c == b'^' {
                    ok = false;
                } else {
                    let mut q = p + next_char(src, p).unwrap().1;
                    while q < n {
                        let ch = bytes[q];
                        if matches!(ch, b'}' | b'^' | b'"') {
                            break;
                        }
                        if ch < 128 {
                            q += 1;
                        } else {
                            q += next_char(src, q).unwrap().1;
                        }
                    }
                    emit!(FlowToken::ShapeData, p, q);
                }
            }

            State::ShapeDataStr => {
                if c == b'"' {
                    pop_state!();
                    emit!(FlowToken::ShapeData, p, p + 1);
                } else {
                    let e = src[p..].find('"').map_or(n, |r| p + r);
                    types.push(FlowToken::ShapeData);
                    texts.push(replace_nl_spaces(&src[p..e]));
                    starts.push(p);
                    p = e;
                }
            }
        }

        if !ok {
            types.push(FlowToken::Error);
            texts.push(String::new());
            starts.push(p);
            return FlowTokens { types, texts, starts };
        }
    }

    types.push(FlowToken::End);
    texts.push(String::new());
    starts.push(n);
    FlowTokens { types, texts, starts }
}
