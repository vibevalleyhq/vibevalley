use crate::util::chars::{is_space_char, is_word};
use crate::util::unicode::is_unicode_letter;

use super::super::tokens::AgentToken;
use super::scan::{Lexer, State, find_line_end, is_space_at, match_acc_header, match_kw_space, next_char};

impl Lexer<'_> {
    pub(super) fn step_initial(&mut self, b: u8) -> bool {
        if self.try_initial_keyword(b) {
            return true;
        }
        if self.try_direction_stmt() {
            return true;
        }
        if self.try_link_id(b) {
            return true;
        }
        if b.is_ascii_digit() {
            let n = self.bytes.len();
            let mut q = self.p + 1;
            while q < n && self.bytes[q].is_ascii_digit() {
                q += 1;
            }
            self.emit_flat(AgentToken::Num, q);
            return true;
        }
        self.step_initial_punct_or_other(b)
    }

    fn try_initial_keyword(&mut self, b: u8) -> bool {
        let p = self.p;
        match b {
            b'a' => {
                if self.src[p..].starts_with("acc") {
                    if let Some(e) = match_acc_header(self.src, p, "accTitle", b':') {
                        self.push_state(State::AccTitle);
                        self.emit(AgentToken::AccTitle, e);
                        return true;
                    }
                    if let Some(e) = match_acc_header(self.src, p, "accDescr", b':') {
                        self.push_state(State::AccDescr);
                        self.emit(AgentToken::AccDescr, e);
                        return true;
                    }
                    if let Some(e) = match_acc_header(self.src, p, "accDescr", b'{') {
                        self.push_state(State::AccDescrMultiline);
                        self.advance(e);
                        return true;
                    }
                }
                if self.kw(p, "agentflow-beta") {
                    if self.first_graph {
                        self.first_graph = false;
                        self.push_state(State::Dir);
                    }
                    self.emit_flat(AgentToken::Graph, p + 14);
                    return true;
                }
            }
            b'@' => {
                if self.bytes.get(p + 1) == Some(&b'{') {
                    self.push_state(State::ShapeData);
                    self.emit_text(AgentToken::ShapeData, String::new(), p + 2);
                    return true;
                }
            }
            b'c' => {
                if let Some(e) = match_kw_space(self.src, p, "call") {
                    self.push_state(State::CallbackName);
                    self.advance(e);
                    return true;
                }
                if self.kw(p, "classDef") {
                    self.emit_flat(AgentToken::ClassDef, p + 8);
                    return true;
                }
                if self.kw(p, "class") {
                    self.emit_flat(AgentToken::Class, p + 5);
                    return true;
                }
                if let Some(e) = match_kw_space(self.src, p, "click") {
                    self.push_state(State::Click);
                    self.advance(e);
                    return true;
                }
                if self.kw(p, "connector") {
                    self.emit_flat(AgentToken::Connector, p + 9);
                    return true;
                }
            }
            b'"' => {
                self.quote();
                return true;
            }
            b's' => {
                if self.kw(p, "style") {
                    self.emit_flat(AgentToken::Style, p + 5);
                    return true;
                }
            }
            b'd' => {
                if self.kw(p, "default") {
                    self.emit_flat(AgentToken::Default, p + 7);
                    return true;
                }
            }
            b'l' => {
                if self.kw(p, "linkStyle") {
                    self.emit_flat(AgentToken::LinkStyle, p + 9);
                    return true;
                }
            }
            b'i' => {
                if self.kw(p, "interpolate") {
                    self.emit_flat(AgentToken::Interpolate, p + 11);
                    return true;
                }
            }
            b'h' => {
                if self.src[p..].starts_with("href") && is_space_at(self.src, p + 4) {
                    let step = if self.bytes[p + 4] < 128 {
                        1
                    } else {
                        next_char(self.src, p + 4).map_or(1, |(_, l)| l)
                    };
                    self.emit(AgentToken::Href, p + 4 + step);
                    return true;
                }
            }
            b'f' => {
                if self.kw(p, "flow") {
                    self.emit_flat(AgentToken::Flow, p + 4);
                    return true;
                }
            }
            b'g' => {
                if self.kw(p, "global") {
                    let end = self.blanks(p + 6);
                    self.emit_flat(AgentToken::Global, end);
                    return true;
                }
            }
            b'e' => {
                if self.kw(p, "end") {
                    let end = self.blanks(p + 3);
                    self.emit_flat(AgentToken::EndKw, end);
                    return true;
                }
            }
            b'_' => {
                if self.kw(p, "_self") {
                    self.emit_flat(AgentToken::LinkTarget, p + 5);
                    return true;
                }
                if self.kw(p, "_blank") {
                    self.emit_flat(AgentToken::LinkTarget, p + 6);
                    return true;
                }
                if self.kw(p, "_parent") {
                    self.emit_flat(AgentToken::LinkTarget, p + 7);
                    return true;
                }
                if self.kw(p, "_top") {
                    self.emit_flat(AgentToken::LinkTarget, p + 4);
                    return true;
                }
            }
            _ => {}
        }
        false
    }

    // Direction statements (`.*direction\s+(TB|BT|RL|LR|TD)[^\n]*`)
    fn try_direction_stmt(&mut self) -> bool {
        let p = self.p;
        if self.dir_next.is_none() || p < self.dir_failed {
            return false;
        }
        if let Some(dn) = self.dir_next
            && dn < p
        {
            self.dir_next = self.src[p..].find("direction").map(|rel| p + rel);
        }
        if let Some(dn) = self.dir_next {
            let le = match self.line_end {
                Some(cur) if cur >= p => cur,
                _ => {
                    let found = find_line_end(self.src, p);
                    self.line_end = Some(found);
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
                let n = self.bytes.len();
                let mut dir_match: Option<(AgentToken, usize)> = None;
                for (code, tok) in DIRS {
                    let mut search = 0;
                    while let Some(rel) = self.src[p + search..le].find("direction") {
                        let after_kw = p + search + rel + 9;
                        let after_ws = self.ws_end(after_kw);
                        if after_ws > after_kw && self.src[after_ws..].starts_with(code) {
                            let end = self.src[after_ws + 2..].find('\n').map_or(n, |r| after_ws + 2 + r);
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
                    self.emit(tok, end);
                    return true;
                }
                self.dir_failed = le;
            }
        }
        false
    }

    // Link ID: non-space run up to last `@` not followed by `{` or `"`.
    fn try_link_id(&mut self, b: u8) -> bool {
        let p = self.p;
        let n = self.bytes.len();
        if self.at_next.is_none() || b == b'"' || is_space_at(self.src, p) {
            return false;
        }
        if p >= self.run_end {
            if let Some(an) = self.at_next
                && an < p
            {
                self.at_next = self.src[p..].find('@').map(|rel| p + rel);
            }
            let mut q = p;
            while q < n {
                let ch = self.bytes[q];
                if ch == b'"' {
                    break;
                }
                if ch < 128 {
                    if matches!(ch, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c) {
                        break;
                    }
                    q += 1;
                } else if let Some((uc, len)) = next_char(self.src, q) {
                    if is_space_char(uc) {
                        break;
                    }
                    q += len;
                } else {
                    break;
                }
            }
            self.run_end = q;
            self.run_at = None;
            if let Some(an) = self.at_next
                && an < q
            {
                let mut k = q.min(n.saturating_sub(1));
                while k > an {
                    k -= 1;
                    if self.bytes[k] != b'@' {
                        continue;
                    }
                    let after = self.bytes.get(k + 1).copied();
                    if after != Some(b'{') && after != Some(b'"') {
                        self.run_at = Some(k);
                        break;
                    }
                }
            }
        }
        if let Some(ra) = self.run_at
            && ra > p
        {
            self.emit_flat(AgentToken::LinkId, ra + 1);
            return true;
        }
        false
    }

    fn step_initial_punct_or_other(&mut self, b: u8) -> bool {
        let p = self.p;
        match b {
            b'#' => {
                self.emit_flat(AgentToken::Brkt, p + 1);
                true
            }
            b':' => {
                if self.bytes.get(p + 1) == Some(&b':') && self.bytes.get(p + 2) == Some(&b':') {
                    self.emit_flat(AgentToken::StyleSeparator, p + 3);
                } else {
                    self.emit_flat(AgentToken::Colon, p + 1);
                }
                true
            }
            b'&' => {
                self.emit_flat(AgentToken::Amp, p + 1);
                true
            }
            b';' => {
                self.emit_flat(AgentToken::Semi, p + 1);
                true
            }
            b',' => {
                self.emit_flat(AgentToken::Comma, p + 1);
                true
            }
            b'*' => {
                self.emit_flat(AgentToken::Mult, p + 1);
                true
            }
            b'<' => {
                self.emit_flat(AgentToken::TagStart, p + 1);
                true
            }
            b'-' => {
                if self.try_link() || self.try_node_string() {
                    return true;
                }
                self.emit_flat(AgentToken::Minus, p + 1);
                true
            }
            b'(' => self.opener(b),
            b'[' => {
                if self.bytes.get(p + 1) == Some(&b'|') {
                    self.emit_flat(AgentToken::VertexWithPropsStart, p + 2);
                    true
                } else {
                    self.opener(b)
                }
            }
            b'|' | b'{' => self.opener(b),
            b'>' => {
                self.push_state(State::Text);
                self.emit_flat(AgentToken::TagEnd, p + 1);
                true
            }
            b'^' => {
                self.emit_flat(AgentToken::Up, p + 1);
                true
            }
            b'\\' => {
                if self.bytes.get(p + 1) == Some(&b'|') {
                    self.emit_flat(AgentToken::Sep, p + 2);
                    true
                } else {
                    self.try_node_string()
                }
            }
            b'v' => {
                if self.bytes.get(p + 1).is_none_or(|&ch| !is_word(ch as u32)) {
                    self.emit_flat(AgentToken::Down, p + 1);
                    true
                } else {
                    self.try_node_string()
                }
            }
            b'%' => {
                if let Some(e) = self.comment_end(p) {
                    self.emit(AgentToken::Comment, e);
                    true
                } else {
                    self.try_node_string()
                }
            }
            _ => self.step_initial_space_or_word(b),
        }
    }

    fn step_initial_space_or_word(&mut self, b: u8) -> bool {
        let p = self.p;
        let n = self.bytes.len();
        if is_space_at(self.src, p) {
            if self.try_link() {
                return true;
            }
            if matches!(b, b' ' | b'\t') {
                let be = self.blank_end(p);
                if let Some(e) = self.comment_end(be) {
                    self.emit(AgentToken::Comment, e);
                    return true;
                }
            }
            let mut e = p;
            while e < n {
                if self.bytes[e] == b'\n' {
                    e += 1;
                } else if self.bytes[e] == b'\r' && self.bytes.get(e + 1) == Some(&b'\n') {
                    e += 2;
                } else {
                    break;
                }
            }
            if e > p {
                self.emit(AgentToken::Newline, e);
            } else {
                let step = if b < 128 { 1 } else { next_char(self.src, p).map_or(1, |(_, l)| l) };
                self.emit(AgentToken::Space, p + step);
            }
            true
        } else if b < 128 {
            self.try_node_string()
        } else if let Some((uc, len)) = next_char(self.src, p)
            && is_unicode_letter(uc as u32)
        {
            self.emit_flat(AgentToken::UnicodeText, p + len);
            true
        } else {
            false
        }
    }
}
