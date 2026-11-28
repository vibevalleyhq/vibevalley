use crate::util::chars::{is_space_char, is_word};

use super::super::tokens::AgentToken;
use super::AgentTokens;

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

pub(super) fn match_acc_header(src: &str, p: usize, kw: &str, delim: u8) -> Option<usize> {
    if !src[p..].starts_with(kw) {
        return None;
    }
    let q = skip_spaces_raw(src, p + kw.len());
    if src.as_bytes().get(q) != Some(&delim) {
        return None;
    }
    Some(skip_spaces_raw(src, q + 1))
}

pub(super) fn match_kw_space(src: &str, p: usize, kw: &str) -> Option<usize> {
    if !src[p..].starts_with(kw) {
        return None;
    }
    let after = p + kw.len();
    let end = skip_spaces_raw(src, after);
    (end > after).then_some(end)
}

pub(super) fn match_nodir(src: &str, p: usize) -> Option<usize> {
    let end = skip_spaces_raw(src, p);
    let last_nl = src[p..end].rfind('\n')?;
    Some(p + last_nl + 1)
}

pub(super) fn match_dir(src: &str, p: usize) -> Option<usize> {
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

pub(super) fn match_empty_call(src: &str, p: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    if bytes.get(p) != Some(&b'(') {
        return None;
    }
    let q = skip_spaces_raw(src, p + 1);
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

pub(super) fn replace_nl_spaces(s: &str) -> String {
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

pub(super) struct Lexer<'a> {
    pub(super) src: &'a str,
    pub(super) bytes: &'a [u8],
    pub(super) types: Vec<AgentToken>,
    pub(super) texts: Vec<String>,
    pub(super) starts: Vec<usize>,
    pub(super) locs: Vec<usize>,
    pub(super) stack: Vec<State>,
    pub(super) state: State,
    pub(super) p: usize,
    pub(super) line: usize,
    pub(super) col: usize,
    pub(super) first_graph: bool,
    pub(super) dir_next: Option<usize>,
    pub(super) at_next: Option<usize>,
    pub(super) line_end: Option<usize>,
    pub(super) dir_failed: usize,
    pub(super) run_end: usize,
    pub(super) run_at: Option<usize>,
    pub(super) ws_from: usize,
    pub(super) ws_to: usize,
    pub(super) blank_from: usize,
    pub(super) blank_to: usize,
    pub(super) no_link: Option<usize>,
    pub(super) no_arrow: Option<usize>,
}

impl<'a> Lexer<'a> {
    pub(super) fn new(src: &'a str) -> Self {
        Self {
            src,
            bytes: src.as_bytes(),
            types: Vec::new(),
            texts: Vec::new(),
            starts: Vec::new(),
            locs: Vec::new(),
            stack: Vec::new(),
            state: State::Initial,
            p: 0,
            line: 1,
            col: 0,
            first_graph: true,
            dir_next: src.find("direction"),
            at_next: src.find('@'),
            line_end: None,
            dir_failed: 0,
            run_end: 0,
            run_at: None,
            ws_from: usize::MAX,
            ws_to: 0,
            blank_from: usize::MAX,
            blank_to: 0,
            no_link: None,
            no_arrow: None,
        }
    }

    pub(super) fn run(mut self) -> AgentTokens {
        let n = self.bytes.len();
        loop {
            if self.p >= n {
                self.emit_eof();
                break;
            }
            let b = self.bytes[self.p];
            let ok = match self.state {
                State::Initial => self.step_initial(b),
                State::StringLit => self.step_string_lit(b),
                State::MdString => self.step_md_string(b),
                State::AccTitle | State::AccDescr => self.step_acc_single(),
                State::AccDescrMultiline => self.step_acc_multiline(b),
                State::Dir => self.step_dir(b),
                State::Text => self.step_text(b),
                State::EllipseText => self.step_ellipse_text(b),
                State::TrapText => self.step_trap_text(b),
                State::EdgeText => self.step_edge_text(b),
                State::Click => self.step_click(b),
                State::CallbackName => self.step_callback_name(b),
                State::CallbackArgs => self.step_callback_args(b),
                State::ShapeData => self.step_shape_data(b),
                State::ShapeDataStr => self.step_shape_data_str(b),
            };
            if !ok {
                self.types.push(AgentToken::Error);
                self.texts.push(String::new());
                self.starts.push(self.p);
                self.locs.push(self.line);
                self.locs.push(self.col);
                self.locs.push(self.line);
                self.locs.push(self.col);
                return AgentTokens {
                    types: self.types,
                    texts: self.texts,
                    starts: self.starts,
                    locs: self.locs,
                };
            }
        }
        self.types.push(AgentToken::End);
        self.texts.push(String::new());
        self.starts.push(n);
        self.locs.push(self.line);
        self.locs.push(self.col);
        self.locs.push(self.line);
        self.locs.push(self.col);
        AgentTokens {
            types: self.types,
            texts: self.texts,
            starts: self.starts,
            locs: self.locs,
        }
    }

    fn emit_eof(&mut self) {
        let eof_tok = match self.state {
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
            self.types.push(tok);
            self.texts.push(String::new());
            self.starts.push(self.bytes.len());
            self.locs.push(self.line);
            self.locs.push(self.col);
            self.locs.push(self.line);
            self.locs.push(self.col);
        }
    }

    pub(super) fn advance(&mut self, e: usize) {
        let start = self.p;
        let mut brk: Option<usize> = None;
        let mut k = start;
        while k < e {
            let b = self.bytes[k];
            if b == b'\n' {
                self.line += 1;
                brk = Some(k);
                k += 1;
            } else if b == b'\r' {
                if k + 1 < e && self.bytes[k + 1] == b'\n' {
                    k += 1;
                }
                self.line += 1;
                brk = Some(k);
                k += 1;
            } else {
                k += 1;
            }
        }
        match brk {
            None => {
                self.col += utf16_len(&self.src[start..e]);
            }
            Some(b_idx) => {
                let tail = &self.src[b_idx + 1..e];
                let mut units = 0usize;
                for ch in tail.chars() {
                    if ch == '\u{2028}' || ch == '\u{2029}' {
                        break;
                    }
                    units += ch.len_utf16();
                }
                self.col = units;
            }
        }
        self.p = e;
    }

    pub(super) fn emit(&mut self, kind: AgentToken, end: usize) {
        self.types.push(kind);
        self.texts.push(self.src[self.p..end].to_string());
        self.starts.push(self.p);
        self.locs.push(self.line);
        self.locs.push(self.col);
        self.advance(end);
        self.locs.push(self.line);
        self.locs.push(self.col);
    }

    pub(super) fn emit_flat(&mut self, kind: AgentToken, end: usize) {
        self.types.push(kind);
        self.texts.push(self.src[self.p..end].to_string());
        self.starts.push(self.p);
        self.locs.push(self.line);
        self.locs.push(self.col);
        self.col += utf16_len(&self.src[self.p..end]);
        self.p = end;
        self.locs.push(self.line);
        self.locs.push(self.col);
    }

    pub(super) fn emit_chars(&mut self, kind: AgentToken, end: usize) {
        self.types.push(kind);
        self.texts.push(self.src[self.p..end].to_string());
        self.starts.push(self.p);
        self.locs.push(self.line);
        self.locs.push(self.col);
        for ch in self.src[self.p..end].chars() {
            if ch == '\n' || ch == '\r' {
                self.line += 1;
                self.col = 0;
            } else {
                self.col += ch.len_utf16();
            }
        }
        self.p = end;
        self.locs.push(self.line);
        self.locs.push(self.col);
    }

    pub(super) fn emit_text(&mut self, kind: AgentToken, text: String, end: usize) {
        self.types.push(kind);
        self.texts.push(text);
        self.starts.push(self.p);
        self.locs.push(self.line);
        self.locs.push(self.col);
        self.advance(end);
        self.locs.push(self.line);
        self.locs.push(self.col);
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

    pub(super) fn ws_end(&mut self, q: usize) -> usize {
        if q >= self.ws_from && q <= self.ws_to {
            self.ws_to
        } else {
            let end = skip_spaces_raw(self.src, q);
            self.ws_from = q;
            self.ws_to = end;
            end
        }
    }

    pub(super) fn blank_end(&mut self, q: usize) -> usize {
        if q >= self.blank_from && q <= self.blank_to {
            self.blank_to
        } else {
            let n = self.bytes.len();
            let mut j = q;
            while j < n && matches!(self.bytes[j], b' ' | b'\t') {
                j += 1;
            }
            self.blank_from = q;
            self.blank_to = j;
            j
        }
    }

    pub(super) fn blanks(&self, from: usize) -> usize {
        let n = self.bytes.len();
        let mut e = from;
        while e < n && matches!(self.bytes[e], b' ' | b'\t') {
            e += 1;
        }
        e
    }

    #[inline]
    pub(super) fn kw(&self, at: usize, word: &str) -> bool {
        self.src[at..].starts_with(word) && self.bytes.get(at + word.len()).is_none_or(|&b| !is_word(b as u32))
    }

    pub(super) fn comment_end(&self, q: usize) -> Option<usize> {
        if self.bytes.get(q) != Some(&b'%') || self.bytes.get(q + 1) != Some(&b'%') || self.bytes.get(q + 2) == Some(&b'{') {
            return None;
        }
        Some(self.src[q + 2..].find('\n').map_or(self.bytes.len(), |rel| q + 2 + rel))
    }

    pub(super) fn quote(&mut self) {
        if self.bytes.get(self.p + 1) == Some(&b'`') {
            self.push_state(State::MdString);
            let next = self.p + 2;
            self.advance(next);
        } else {
            self.push_state(State::StringLit);
            let next = self.p + 1;
            self.advance(next);
        }
    }

    pub(super) fn opener(&mut self, b: u8) -> bool {
        let p = self.p;
        let d = self.bytes.get(p + 1).copied();
        if b == b'(' {
            if d == Some(b'-') {
                self.push_state(State::EllipseText);
                self.emit_flat(AgentToken::EllipseStart, p + 2);
            } else if d == Some(b'[') {
                self.push_state(State::Text);
                self.emit_flat(AgentToken::StadiumStart, p + 2);
            } else if d == Some(b'(') && self.bytes.get(p + 2) == Some(&b'(') {
                self.push_state(State::Text);
                self.emit_flat(AgentToken::DoubleCircleStart, p + 3);
            } else {
                self.push_state(State::Text);
                self.emit_flat(AgentToken::Ps, p + 1);
            }
            true
        } else if b == b'[' {
            if d == Some(b'[') {
                self.push_state(State::Text);
                self.emit_flat(AgentToken::SubroutineStart, p + 2);
            } else if d == Some(b'(') {
                self.push_state(State::Text);
                self.emit_flat(AgentToken::CylinderStart, p + 2);
            } else if d == Some(b'/') {
                self.push_state(State::TrapText);
                self.emit_flat(AgentToken::TrapStart, p + 2);
            } else if d == Some(b'\\') {
                self.push_state(State::TrapText);
                self.emit_flat(AgentToken::InvTrapStart, p + 2);
            } else {
                self.push_state(State::Text);
                self.emit_flat(AgentToken::Sqs, p + 1);
            }
            true
        } else if b == b'|' {
            self.push_state(State::Text);
            self.emit_flat(AgentToken::Pipe, p + 1);
            true
        } else if b == b'{' {
            self.push_state(State::Text);
            self.emit_flat(AgentToken::DiamondStart, p + 1);
            true
        } else {
            false
        }
    }

    pub(super) fn arrow_end(&mut self, q: usize) -> Option<usize> {
        let j = self.ws_end(q);
        if self.no_arrow == Some(j) || self.bytes.get(j) != Some(&b'-') || self.bytes.get(j + 1) != Some(&b'-') {
            None
        } else {
            let mut k = j + 2;
            while self.bytes.get(k) == Some(&b'-') {
                k += 1;
            }
            if matches!(self.bytes.get(k), Some(b'x' | b'>')) {
                Some(self.ws_end(k + 1))
            } else {
                self.no_arrow = Some(j);
                None
            }
        }
    }

    pub(super) fn try_link(&mut self) -> bool {
        let j = self.ws_end(self.p);
        if self.no_link == Some(j) || self.bytes.get(j) != Some(&b'-') {
            return false;
        }
        let d = self.bytes.get(j + 1).copied();
        let mut k = j + 2;
        if d == Some(b'-') {
            while self.bytes.get(k) == Some(&b'-') {
                k += 1;
            }
            if matches!(self.bytes.get(k), Some(b'x' | b'>')) {
                let end = self.ws_end(k + 1);
                self.emit(AgentToken::Link, end);
            } else {
                self.push_state(State::EdgeText);
                let end = self.ws_end(j + 2);
                self.emit(AgentToken::StartLink, end);
            }
            true
        } else if d == Some(b'.') {
            while self.bytes.get(k) == Some(&b'.') {
                k += 1;
            }
            if self.bytes.get(k) == Some(&b'-') {
                let end = self.ws_end(k + 1);
                self.emit(AgentToken::Link, end);
                true
            } else {
                self.no_link = Some(j);
                false
            }
        } else {
            self.no_link = Some(j);
            false
        }
    }

    pub(super) fn try_node_string(&mut self) -> bool {
        let p = self.p;
        let n = self.bytes.len();
        let mut q = p;
        while q < n {
            let ch = self.bytes[q];
            if ch < 128 && NODE_CHAR[ch as usize] {
                q += 1;
            } else if ch == b'-' && q + 1 < n {
                let d = self.bytes[q + 1];
                if matches!(d, b'>' | b'-' | b'.') {
                    break;
                }
                q += 1;
            } else {
                break;
            }
        }
        if q > p {
            self.emit_flat(AgentToken::NodeString, q);
            true
        } else {
            false
        }
    }
}
