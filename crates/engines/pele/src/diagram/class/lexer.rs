use crate::util::chars::{is_line_end, is_space, is_word};
use crate::util::unicode::is_unicode_letter;

use super::tokens::Tok;

pub struct Tokens {
    pub types: Vec<Tok>,
    pub texts: Vec<String>,
    pub starts: Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LexState {
    Initial,
    String,
    BqString,
    Generic,
    CallbackName,
    CallbackArgs,
    AccTitle,
    AccDescr,
    AccDescrMultiline,
    Cls,
    ClassBody,
    Namespace,
    NamespaceBody,
}

impl LexState {
    const fn at_end(self) -> Tok {
        match self {
            Self::Initial => Tok::Eof,
            Self::String => Tok::Str,
            Self::BqString => Tok::Eof,
            Self::Generic => Tok::GenericType,
            Self::CallbackName => Tok::CallbackName,
            Self::CallbackArgs => Tok::CallbackArgs,
            Self::AccTitle => Tok::AccTitleValue,
            Self::AccDescr => Tok::AccDescrValue,
            Self::AccDescrMultiline => Tok::AccDescrMultilineValue,
            Self::Cls => Tok::Eof,
            Self::ClassBody => Tok::EofInStruct,
            Self::Namespace => Tok::Eof,
            Self::NamespaceBody => Tok::EofInStruct,
        }
    }
}

fn find_line_end(src: &str, from: usize) -> usize {
    for (rel, ch) in src[from..].char_indices() {
        if is_line_end(ch as u32) {
            return from + rel;
        }
    }
    src.len()
}

struct Lexer<'a> {
    src: &'a str,
    bytes: &'a [u8],
    n: usize,
    types: Vec<Tok>,
    texts: Vec<String>,
    starts: Vec<usize>,
    stack: Vec<LexState>,
    state: LexState,
    p: usize,
    dir_next: Option<usize>,
    line_end: Option<usize>,
    dir_failed: usize,
}

impl<'a> Lexer<'a> {
    fn new(src: &'a str) -> Self {
        Self {
            src,
            bytes: src.as_bytes(),
            n: src.len(),
            types: Vec::new(),
            texts: Vec::new(),
            starts: Vec::new(),
            stack: Vec::new(),
            state: LexState::Initial,
            p: 0,
            dir_next: src.find("direction"),
            line_end: None,
            dir_failed: 0,
        }
    }

    fn peek_char(&self, at: usize) -> char {
        self.src[at..].chars().next().unwrap()
    }

    fn emit(&mut self, tok: Tok, s: usize, e: usize) -> bool {
        self.types.push(tok);
        self.texts.push(self.src[s..e].to_string());
        self.starts.push(s);
        self.p = e;
        true
    }

    fn push(&mut self, next: LexState) {
        self.stack.push(self.state);
        self.state = next;
    }

    fn pop(&mut self) {
        if let Some(prev) = self.stack.pop() {
            self.state = prev;
        }
    }

    fn kw(&self, word: &str) -> bool {
        self.src[self.p..].starts_with(word) && self.bytes.get(self.p + word.len()).is_none_or(|&b| !is_word(b as u32))
    }

    fn skip_ws(&self, mut q: usize) -> usize {
        while q < self.n {
            let ch = self.peek_char(q);
            if is_space(ch as u32) {
                q += ch.len_utf8();
            } else {
                break;
            }
        }
        q
    }

    fn until(&self, ch: char) -> usize {
        self.src[self.p..].find(ch).map_or(self.n, |rel| self.p + rel)
    }

    // A run of whitespace is a NEWLINE up to its last line feed; the rest is skipped.
    fn space(&mut self, leaves: bool) {
        let mut q = self.p;
        let mut last_lf: Option<usize> = None;
        while q < self.n {
            let ch = self.peek_char(q);
            if !is_space(ch as u32) {
                break;
            }
            if ch == '\n' {
                last_lf = Some(q);
            }
            q += ch.len_utf8();
        }
        let Some(k) = last_lf else {
            self.p = q;
            return;
        };
        if leaves {
            self.pop();
        }
        let start = self.p;
        self.emit(Tok::Newline, start, k + 1);
    }

    // Keywords recognized in every state, even inside generics and backtick names.
    fn keyword(&mut self, c: u32) -> bool {
        let at = self.p;
        match c {
            99 => {
                if self.kw("cssClass") {
                    return self.emit(Tok::CssClass, at, at + 8);
                }
                if self.kw("callback") {
                    return self.emit(Tok::Callback, at, at + 8);
                }
                if self.kw("click") {
                    return self.emit(Tok::Click, at, at + 5);
                }
            }
            108 => {
                if self.kw("link") {
                    return self.emit(Tok::Link, at, at + 4);
                }
            }
            110 => {
                if self.kw("note for") {
                    return self.emit(Tok::NoteFor, at, at + 8);
                }
                if self.kw("note") {
                    return self.emit(Tok::Note, at, at + 4);
                }
            }
            60 => {
                if self.bytes.get(at + 1) == Some(&b'<') {
                    return self.emit(Tok::AnnotationStart, at, at + 2);
                }
            }
            62 => {
                if self.bytes.get(at + 1) == Some(&b'>') {
                    return self.emit(Tok::AnnotationEnd, at, at + 2);
                }
            }
            104 if self.kw("href") => {
                return self.emit(Tok::Href, at, at + 4);
            }
            _ => {}
        }
        false
    }

    fn common(&mut self, ch: char) -> bool {
        let c = ch as u32;
        if self.keyword(c) {
            return true;
        }
        let at = self.p;
        let d = self.bytes.get(at + 1).copied();
        match c {
            34 => {
                self.push(LexState::String);
                self.p += 1;
                return true;
            }
            126 => {
                self.push(LexState::Generic);
                self.p += 1;
                return true;
            }
            96 => {
                self.push(LexState::BqString);
                self.p += 1;
                return true;
            }
            95 => {
                if self.kw("_self") {
                    return self.emit(Tok::LinkTarget, at, at + 5);
                }
                if self.kw("_blank") {
                    return self.emit(Tok::LinkTarget, at, at + 6);
                }
                if self.kw("_parent") {
                    return self.emit(Tok::LinkTarget, at, at + 7);
                }
                if self.kw("_top") {
                    return self.emit(Tok::LinkTarget, at, at + 4);
                }
            }
            60 => {
                return if d == Some(b'|') {
                    self.emit(Tok::Extension, at, at + 2)
                } else {
                    self.emit(Tok::Dependency, at, at + 1)
                };
            }
            124 => {
                return d == Some(b'>') && self.emit(Tok::Extension, at, at + 2);
            }
            62 => return self.emit(Tok::Dependency, at, at + 1),
            42 => return self.emit(Tok::Composition, at, at + 1),
            111 => {
                if d.is_none_or(|b| !is_word(b as u32)) {
                    return self.emit(Tok::Aggregation, at, at + 1);
                }
            }
            40 => return d == Some(b')') && self.emit(Tok::Lollipop, at, at + 2),
            45 => {
                return if d == Some(b'-') {
                    self.emit(Tok::Line, at, at + 2)
                } else {
                    self.emit(Tok::Minus, at, at + 1)
                };
            }
            46 => {
                return if d == Some(b'.') {
                    self.emit(Tok::DottedLine, at, at + 2)
                } else {
                    self.emit(Tok::Dot, at, at + 1)
                };
            }
            58 => {
                let mut q = at + 1;
                while q < self.n && !matches!(self.bytes[q], b':' | b'\n' | b';') {
                    q += 1;
                }
                if q > at + 1 {
                    return self.emit(Tok::Label, at, q);
                }
                return d == Some(b':') && self.bytes.get(at + 2) == Some(&b':') && self.emit(Tok::StyleSeparator, at, at + 3);
            }
            43 => return self.emit(Tok::Plus, at, at + 1),
            37 => return self.emit(Tok::Pct, at, at + 1),
            61 => return self.emit(Tok::Equals, at, at + 1),
            91 => return self.emit(Tok::Sqs, at, at + 1),
            93 => return self.emit(Tok::Sqe, at, at + 1),
            33 | 35 | 36 | 38 | 39 | 44 | 63 | 92 | 47 => {
                return self.emit(Tok::Punctuation, at, at + 1);
            }
            _ => {}
        }
        if is_word(c) {
            let mut q = at + 1;
            while q < self.n && is_word(self.bytes[q] as u32) {
                q += 1;
            }
            return self.emit(Tok::Alpha, at, q);
        }
        is_unicode_letter(c) && self.emit(Tok::UnicodeText, at, at + ch.len_utf8())
    }

    fn direction(&mut self) -> bool {
        if self.dir_next.is_none() || self.p < self.dir_failed {
            return false;
        }
        if self.dir_next.is_some_and(|dn| dn < self.p) {
            self.dir_next = self.src[self.p..].find("direction").map(|rel| self.p + rel);
        }
        let Some(dn) = self.dir_next else {
            return false;
        };
        if self.line_end.is_none_or(|le| le < self.p) {
            self.line_end = Some(find_line_end(self.src, self.p));
        }
        let le = self.line_end.unwrap();
        if dn >= le {
            return false;
        }
        let mut best: Option<(u8, Tok, usize)> = None;
        let mut scan = dn;
        while scan < le {
            let after = scan + 9;
            let q = self.skip_ws(after);
            if q > after {
                let dir_match = if self.src[q..].starts_with("TB") {
                    Some((0u8, Tok::DirectionTb))
                } else if self.src[q..].starts_with("BT") {
                    Some((1u8, Tok::DirectionBt))
                } else if self.src[q..].starts_with("RL") {
                    Some((2u8, Tok::DirectionRl))
                } else if self.src[q..].starts_with("LR") {
                    Some((3u8, Tok::DirectionLr))
                } else {
                    None
                };
                if let Some((idx, tok)) = dir_match {
                    let end = self.src[q + 2..].find('\n').map_or(self.n, |rel| q + 2 + rel);
                    if best.is_none_or(|(best_idx, _, _)| idx <= best_idx) {
                        best = Some((idx, tok, end));
                    }
                }
            }
            match self.src[scan + 9..le].find("direction") {
                Some(rel) => scan = scan + 9 + rel,
                None => break,
            }
        }
        if let Some((_, tok, end)) = best {
            let start = self.p;
            return self.emit(tok, start, end);
        }
        self.dir_failed = le;
        false
    }

    fn initial(&mut self, ch: char) -> bool {
        if self.direction() {
            return true;
        }
        let c = ch as u32;
        if is_space(c) {
            self.space(false);
            return true;
        }
        let at = self.p;
        match c {
            37 => {
                if self.bytes.get(at + 1) == Some(&b'%') {
                    let mut e = self.until('\n');
                    while e < self.n && matches!(self.bytes[e], b'\n' | b'\r') {
                        e += 1;
                    }
                    self.p = e;
                    return true;
                }
            }
            97 => {
                let is_title = self.src[at..].starts_with("accTitle");
                if is_title || self.src[at..].starts_with("accDescr") {
                    let q = self.skip_ws(at + 8);
                    let d = self.bytes.get(q).copied();
                    if d == Some(b':') {
                        let tok = if is_title { Tok::AccTitle } else { Tok::AccDescr };
                        let end = self.skip_ws(q + 1);
                        self.emit(tok, at, end);
                        self.push(if is_title { LexState::AccTitle } else { LexState::AccDescr });
                        return true;
                    }
                    if d == Some(b'{') && !is_title {
                        self.p = self.skip_ws(q + 1);
                        self.push(LexState::AccDescrMultiline);
                        return true;
                    }
                }
            }
            99 => {
                if self.kw("classDiagram-v2") {
                    return self.emit(Tok::ClassDiagram, at, at + 15);
                }
                if self.kw("classDiagram") {
                    return self.emit(Tok::ClassDiagram, at, at + 12);
                }
                if self.src[at..].starts_with("call") && at + 4 < self.n && is_space(self.peek_char(at + 4) as u32) {
                    self.p = self.skip_ws(at + 4);
                    self.push(LexState::CallbackName);
                    return true;
                }
                if self.kw("classDef") {
                    return self.emit(Tok::ClassDef, at, at + 8);
                }
                if self.kw("class") {
                    self.push(LexState::Cls);
                    return self.emit(Tok::Class, at, at + 5);
                }
            }
            91 => {
                if self.src[at + 1..].starts_with("*]") {
                    return self.emit(Tok::EdgeState, at, at + 3);
                }
            }
            115 => {
                if self.kw("style") {
                    return self.emit(Tok::Style, at, at + 5);
                }
            }
            110 => {
                if self.kw("namespace") {
                    self.push(LexState::Namespace);
                    return self.emit(Tok::Namespace, at, at + 9);
                }
            }
            44 => return self.emit(Tok::Comma, at, at + 1),
            35 => return self.emit(Tok::Brkt, at, at + 1),
            _ => {}
        }
        self.common(ch) || (c == 58 && self.emit(Tok::Colon, at, at + 1))
    }

    fn run(mut self) -> Tokens {
        loop {
            if self.p >= self.n {
                self.types.push(self.state.at_end());
                self.texts.push(String::new());
                self.starts.push(self.n);
                break;
            }
            let at = self.p;
            let ch = self.peek_char(at);
            let c = ch as u32;
            let mut ok = true;

            match self.state {
                LexState::Initial => {
                    ok = self.initial(ch);
                }
                LexState::Cls => {
                    if is_space(c) {
                        self.space(true);
                    } else if c == 125 {
                        self.pop();
                        self.pop();
                        self.emit(Tok::StructStop, at, at + 1);
                    } else if c == 123 {
                        self.push(LexState::ClassBody);
                        self.emit(Tok::StructStart, at, at + 1);
                    } else {
                        ok = self.common(ch);
                    }
                }
                LexState::ClassBody => {
                    if c == 34 {
                        self.push(LexState::String);
                        self.p += 1;
                    } else if c == 125 {
                        self.pop();
                        self.emit(Tok::StructStop, at, at + 1);
                    } else if c == 91 && self.src[at + 1..].starts_with("*]") {
                        self.emit(Tok::EdgeState, at, at + 3);
                    } else if c == 123 {
                        self.emit(Tok::OpenInStruct, at, at + 1);
                    } else if c == 10 {
                        self.p += 1;
                    } else {
                        let mut q = at + ch.len_utf8();
                        while q < self.n && !matches!(self.bytes[q], b'{' | b'}' | b'\n') {
                            q += 1;
                        }
                        self.emit(Tok::Member, at, q);
                    }
                }
                LexState::Namespace => {
                    if is_space(c) {
                        self.space(true);
                    } else if c == 123 {
                        self.push(LexState::NamespaceBody);
                        self.emit(Tok::StructStart, at, at + 1);
                    } else if c == 125 {
                        // The brace is read again in the state the namespace was opened from.
                        self.pop();
                    } else if c == 110 && self.kw("namespace") {
                        self.push(LexState::Namespace);
                        self.emit(Tok::Namespace, at, at + 9);
                    } else {
                        ok = self.common(ch);
                    }
                }
                LexState::NamespaceBody => {
                    if is_space(c) {
                        self.space(false);
                    } else if c == 125 {
                        self.pop();
                        self.emit(Tok::StructStop, at, at + 1);
                    } else if c == 110 && self.kw("namespace") {
                        self.push(LexState::Namespace);
                        self.emit(Tok::Namespace, at, at + 9);
                    } else if c == 91 && self.src[at + 1..].starts_with("*]") {
                        self.emit(Tok::EdgeState, at, at + 3);
                    } else if c == 99 && self.kw("class") {
                        self.push(LexState::Cls);
                        self.emit(Tok::Class, at, at + 5);
                    } else {
                        ok = self.common(ch);
                    }
                }
                LexState::String => {
                    if c == 34 {
                        self.pop();
                        self.p += 1;
                    } else {
                        let end = self.until('"');
                        self.emit(Tok::Str, at, end);
                    }
                }
                LexState::Generic => {
                    if c == 34 {
                        self.push(LexState::String);
                        self.p += 1;
                    } else if self.keyword(c) {
                        // Emitted keyword token inside generic state.
                    } else if c == 126 {
                        self.pop();
                        self.p += 1;
                    } else {
                        let end = self.until('~');
                        self.emit(Tok::GenericType, at, end);
                    }
                }
                LexState::BqString => {
                    if c == 34 {
                        self.push(LexState::String);
                        self.p += 1;
                    } else if self.keyword(c) {
                        // Emitted keyword token inside backtick name.
                    } else if c == 126 {
                        self.push(LexState::Generic);
                        self.p += 1;
                    } else if c == 96 {
                        self.pop();
                        self.p += 1;
                    } else {
                        let end = self.until('`');
                        self.emit(Tok::BquoteStr, at, end);
                    }
                }
                LexState::CallbackName => {
                    if c == 40 {
                        let q = self.skip_ws(at + 1);
                        self.pop();
                        if self.bytes.get(q) == Some(&b')') {
                            self.p = q + 1;
                        } else {
                            self.push(LexState::CallbackArgs);
                            self.p += 1;
                        }
                    } else {
                        let end = self.until('(');
                        self.emit(Tok::CallbackName, at, end);
                    }
                }
                LexState::CallbackArgs => {
                    if c == 41 {
                        self.pop();
                        self.p += 1;
                    } else {
                        let end = self.until(')');
                        self.emit(Tok::CallbackArgs, at, end);
                    }
                }
                LexState::AccTitle => {
                    let end = self.until('\n');
                    self.emit(Tok::AccTitleValue, at, end);
                    self.pop();
                }
                LexState::AccDescr => {
                    let end = self.until('\n');
                    self.emit(Tok::AccDescrValue, at, end);
                    self.pop();
                }
                LexState::AccDescrMultiline => {
                    if c == 125 {
                        self.pop();
                        self.p += 1;
                    } else {
                        let end = self.until('}');
                        self.emit(Tok::AccDescrMultilineValue, at, end);
                    }
                }
            }

            if !ok {
                self.types.push(Tok::Error);
                self.texts.push(String::new());
                self.starts.push(self.p);
                return Tokens {
                    types: self.types,
                    texts: self.texts,
                    starts: self.starts,
                };
            }
        }

        self.types.push(Tok::End);
        self.texts.push(String::new());
        self.starts.push(self.n);
        Tokens {
            types: self.types,
            texts: self.texts,
            starts: self.starts,
        }
    }
}

pub fn tokenize(src: &str) -> Tokens {
    Lexer::new(src).run()
}
