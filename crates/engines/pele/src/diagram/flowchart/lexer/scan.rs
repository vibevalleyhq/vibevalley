use crate::util::chars::{is_space_char, is_word};

use super::super::tokens::FlowToken;
use super::FlowTokens;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum State {
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
pub(super) fn next_char(src: &str, p: usize) -> Option<(char, usize)> {
    let ch = src[p..].chars().next()?;
    Some((ch, ch.len_utf8()))
}

#[inline]
pub(super) fn is_space_at(src: &str, p: usize) -> bool {
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

pub(super) fn skip_spaces(src: &str, mut p: usize) -> usize {
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

pub(super) fn skip_hspaces(src: &str, mut p: usize) -> usize {
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

pub(super) fn match_acc_header(src: &str, p: usize, kw: &str, delim: u8) -> Option<usize> {
    if !src[p..].starts_with(kw) {
        return None;
    }
    let q = skip_spaces(src, p + kw.len());
    if src.as_bytes().get(q) != Some(&delim) {
        return None;
    }
    Some(skip_spaces(src, q + 1))
}

pub(super) fn match_kw_space(src: &str, p: usize, kw: &str) -> Option<usize> {
    if !src[p..].starts_with(kw) {
        return None;
    }
    let after = p + kw.len();
    let end = skip_spaces(src, after);
    (end > after).then_some(end)
}

pub(super) fn match_nodir(src: &str, p: usize) -> Option<usize> {
    let end = skip_spaces(src, p);
    let last_nl = src[p..end].rfind('\n')?;
    Some(p + last_nl + 1)
}

pub(super) fn match_dir(src: &str, p: usize) -> Option<usize> {
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

pub(super) fn match_newline(src: &str, p: usize) -> Option<usize> {
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

pub(super) fn match_empty_call(src: &str, p: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    if bytes.get(p) != Some(&b'(') {
        return None;
    }
    let q = skip_spaces(src, p + 1);
    if bytes.get(q) == Some(&b')') { Some(q + 1) } else { None }
}

pub(super) fn find_line_end(src: &str, p: usize) -> usize {
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

pub(super) fn match_direction_stmt(src: &str, p: usize, line_end: usize) -> Option<(FlowToken, usize)> {
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

pub(super) fn replace_nl_spaces(s: &str) -> String {
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

pub(super) struct Lexer<'a> {
    pub(super) src: &'a str,
    pub(super) bytes: &'a [u8],
    pub(super) types: Vec<FlowToken>,
    pub(super) texts: Vec<String>,
    pub(super) starts: Vec<usize>,
    pub(super) stack: Vec<State>,
    pub(super) state: State,
    pub(super) p: usize,
    pub(super) first_graph: bool,
    pub(super) dir_next: Option<usize>,
    pub(super) at_next: Option<usize>,
    pub(super) line_end: usize,
    pub(super) line_end_valid: bool,
    pub(super) dir_failed: usize,
    pub(super) run_end: usize,
    pub(super) run_at: Option<usize>,
    pub(super) ws_from: usize,
    pub(super) ws_to: usize,
}

impl<'a> Lexer<'a> {
    pub(super) fn new(src: &'a str) -> Self {
        Self {
            src,
            bytes: src.as_bytes(),
            types: Vec::new(),
            texts: Vec::new(),
            starts: Vec::new(),
            stack: Vec::new(),
            state: State::Initial,
            p: 0,
            first_graph: true,
            dir_next: src.find("direction"),
            at_next: src.find('@'),
            line_end: 0,
            line_end_valid: false,
            dir_failed: 0,
            run_end: 0,
            run_at: None,
            ws_from: usize::MAX,
            ws_to: 0,
        }
    }

    pub(super) fn run(mut self) -> FlowTokens {
        let n = self.bytes.len();
        loop {
            if self.p >= n {
                self.emit_eof();
                break;
            }
            let c = self.bytes[self.p];
            let d = self.bytes.get(self.p + 1).copied().unwrap_or(0);
            let ok = match self.state {
                State::Initial => self.step_initial(c, d),
                State::StringLit => self.step_string_lit(c, d),
                State::MdString => self.step_md_string(c, d),
                State::AccTitle | State::AccDescr => self.step_acc_single(),
                State::AccDescrMultiline => self.step_acc_multiline(c),
                State::Dir => self.step_dir(c, d),
                State::Text => self.step_text(c, d),
                State::EllipseText => self.step_ellipse_text(c, d),
                State::TrapText => self.step_trap_text(c, d),
                State::EdgeText | State::ThickEdgeText | State::DottedEdgeText => self.step_edge_text(c, d),
                State::Click => self.step_click(c, d),
                State::CallbackName => self.step_callback_name(c),
                State::CallbackArgs => self.step_callback_args(c),
                State::ShapeData => self.step_shape_data(c),
                State::ShapeDataStr => self.step_shape_data_str(c),
            };
            if !ok {
                self.types.push(FlowToken::Error);
                self.texts.push(String::new());
                self.starts.push(self.p);
                return FlowTokens {
                    types: self.types,
                    texts: self.texts,
                    starts: self.starts,
                };
            }
        }
        self.types.push(FlowToken::End);
        self.texts.push(String::new());
        self.starts.push(n);
        FlowTokens {
            types: self.types,
            texts: self.texts,
            starts: self.starts,
        }
    }

    fn emit_eof(&mut self) {
        let eof_tok = match self.state {
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
            self.types.push(t);
            self.texts.push(String::new());
            self.starts.push(self.bytes.len());
        }
    }

    #[inline]
    pub(super) fn emit(&mut self, t: FlowToken, s: usize, e: usize) {
        self.types.push(t);
        self.texts.push(self.src[s..e].to_string());
        self.starts.push(s);
        self.p = e;
    }

    #[inline]
    pub(super) fn push_state(&mut self, s: State) {
        self.stack.push(self.state);
        self.state = s;
    }

    #[inline]
    pub(super) fn pop_state(&mut self) {
        if let Some(prev) = self.stack.pop() {
            self.state = prev;
        }
    }

    #[inline]
    pub(super) fn push_quote(&mut self, d: u8) {
        if d == b'`' {
            self.push_state(State::MdString);
            self.p += 2;
        } else {
            self.push_state(State::StringLit);
            self.p += 1;
        }
    }

    #[inline]
    pub(super) fn kw(&self, p: usize, word: &str) -> bool {
        self.src[p..].starts_with(word) && !self.bytes.get(p + word.len()).is_some_and(|&b| is_word(b as u32))
    }

    pub(super) fn try_opener(&mut self, c: u8, d: u8) -> bool {
        let p0 = self.p;
        let (next_state, tok, len) = match c {
            b'(' => {
                if d == b'-' {
                    (State::EllipseText, FlowToken::EllipseStart, 2)
                } else if d == b'[' {
                    (State::Text, FlowToken::StadiumStart, 2)
                } else if d == b'(' && self.bytes.get(p0 + 2) == Some(&b'(') {
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
        self.push_state(next_state);
        self.emit(tok, p0, p0 + len);
        true
    }

    pub(super) fn try_node_string(&mut self) -> bool {
        let p0 = self.p;
        let n = self.bytes.len();
        let mut q = p0;
        while q < n {
            let ch = self.bytes[q];
            if ch < 128 && NODE_CHAR[ch as usize] {
                q += 1;
            } else if ch == b'-' && q + 1 < n {
                let nb = self.bytes[q + 1];
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
        self.emit(FlowToken::NodeString, p0, q);
        true
    }
}
