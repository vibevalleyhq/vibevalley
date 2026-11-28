use crate::util::chars::is_word;
use crate::util::unicode::is_unicode_letter;

use super::super::tokens::FlowToken;
use super::scan::{
    Lexer, State, find_line_end, is_space_at, match_acc_header, match_direction_stmt, match_kw_space, match_newline, next_char, skip_hspaces, skip_spaces,
};

impl Lexer<'_> {
    pub(super) fn step_initial(&mut self, c: u8, d: u8) -> bool {
        if self.try_initial_keyword(c, d) {
            return true;
        }
        if self.try_direction_stmt() {
            return true;
        }
        if self.try_link_id(c) {
            return true;
        }
        if c.is_ascii_digit() {
            let p0 = self.p;
            let n = self.bytes.len();
            let mut q = p0 + 1;
            while q < n && self.bytes[q].is_ascii_digit() {
                q += 1;
            }
            self.emit(FlowToken::Num, p0, q);
            return true;
        }
        if let Some(ok) = self.try_initial_punct(c, d) {
            return ok;
        }
        self.step_initial_fallback(c)
    }

    fn try_initial_keyword(&mut self, c: u8, d: u8) -> bool {
        let p = self.p;
        match c {
            b'a' if self.src[p..].starts_with("acc") => {
                if let Some(e) = match_acc_header(self.src, p, "accTitle", b':') {
                    self.push_state(State::AccTitle);
                    self.emit(FlowToken::AccTitle, p, e);
                    return true;
                }
                if let Some(e) = match_acc_header(self.src, p, "accDescr", b':') {
                    self.push_state(State::AccDescr);
                    self.emit(FlowToken::AccDescr, p, e);
                    return true;
                }
                if let Some(e) = match_acc_header(self.src, p, "accDescr", b'{') {
                    self.push_state(State::AccDescrMultiline);
                    self.p = e;
                    return true;
                }
            }
            b'@' if d == b'{' => {
                self.push_state(State::ShapeData);
                self.types.push(FlowToken::ShapeData);
                self.texts.push(String::new());
                self.starts.push(p);
                self.p += 2;
                return true;
            }
            b'c' => {
                if let Some(e) = match_kw_space(self.src, p, "call") {
                    self.push_state(State::CallbackName);
                    self.p = e;
                    return true;
                }
                if self.kw(p, "classDef") {
                    self.emit(FlowToken::ClassDef, p, p + 8);
                    return true;
                }
                if self.kw(p, "class") {
                    self.emit(FlowToken::Class, p, p + 5);
                    return true;
                }
                if let Some(e) = match_kw_space(self.src, p, "click") {
                    self.push_state(State::Click);
                    self.p = e;
                    return true;
                }
            }
            b'"' => {
                self.push_quote(d);
                return true;
            }
            b's' => {
                if self.kw(p, "style") {
                    self.emit(FlowToken::Style, p, p + 5);
                    return true;
                }
                if self.kw(p, "swimlane-beta") {
                    if self.first_graph {
                        self.first_graph = false;
                        self.push_state(State::Dir);
                    }
                    self.emit(FlowToken::Graph, p, p + 13);
                    return true;
                }
                if self.kw(p, "subgraph") {
                    self.emit(FlowToken::Subgraph, p, p + 8);
                    return true;
                }
            }
            b'd' if self.kw(p, "default") => {
                self.emit(FlowToken::Default, p, p + 7);
                return true;
            }
            b'l' if self.kw(p, "linkStyle") => {
                self.emit(FlowToken::LinkStyle, p, p + 9);
                return true;
            }
            b'i' if self.kw(p, "interpolate") => {
                self.emit(FlowToken::Interpolate, p, p + 11);
                return true;
            }
            b'h' if self.src[p..].starts_with("href") && is_space_at(self.src, p + 4) => {
                let (_, slen) = next_char(self.src, p + 4).unwrap();
                self.emit(FlowToken::Href, p, p + 4 + slen);
                return true;
            }
            b'f' => {
                if self.kw(p, "flowchart-elk") {
                    if self.first_graph {
                        self.first_graph = false;
                        self.push_state(State::Dir);
                    }
                    self.emit(FlowToken::Graph, p, p + 13);
                    return true;
                }
                if self.kw(p, "flowchart") {
                    if self.first_graph {
                        self.first_graph = false;
                        self.push_state(State::Dir);
                    }
                    self.emit(FlowToken::Graph, p, p + 9);
                    return true;
                }
            }
            b'g' if self.kw(p, "graph") => {
                if self.first_graph {
                    self.first_graph = false;
                    self.push_state(State::Dir);
                }
                self.emit(FlowToken::Graph, p, p + 5);
                return true;
            }
            b'e' if self.kw(p, "end") => {
                let e = skip_spaces(self.src, p + 3);
                self.emit(FlowToken::EndKw, p, e);
                return true;
            }
            b'_' => {
                if self.kw(p, "_self") {
                    self.emit(FlowToken::LinkTarget, p, p + 5);
                    return true;
                }
                if self.kw(p, "_blank") {
                    self.emit(FlowToken::LinkTarget, p, p + 6);
                    return true;
                }
                if self.kw(p, "_parent") {
                    self.emit(FlowToken::LinkTarget, p, p + 7);
                    return true;
                }
                if self.kw(p, "_top") {
                    self.emit(FlowToken::LinkTarget, p, p + 4);
                    return true;
                }
            }
            _ => {}
        }
        false
    }

    fn try_direction_stmt(&mut self) -> bool {
        let p = self.p;
        if self.dir_next.is_none() || p < self.dir_failed {
            return false;
        }
        if self.dir_next.is_some_and(|dn| dn < p) {
            self.dir_next = self.src[p..].find("direction").map(|r| p + r);
        }
        if let Some(dn) = self.dir_next {
            if !self.line_end_valid || self.line_end < p {
                self.line_end = find_line_end(self.src, p);
                self.line_end_valid = true;
            }
            if dn < self.line_end {
                if let Some((tok, e)) = match_direction_stmt(self.src, p, self.line_end) {
                    self.emit(tok, p, e);
                    return true;
                }
                self.dir_failed = self.line_end;
            }
        }
        false
    }

    fn try_link_id(&mut self, c: u8) -> bool {
        let p = self.p;
        let n = self.bytes.len();
        if self.at_next.is_none() || c == b'"' || is_space_at(self.src, p) {
            return false;
        }
        if p >= self.run_end {
            if self.at_next.is_some_and(|an| an < p) {
                self.at_next = self.src[p..].find('@').map(|r| p + r);
            }
            let mut q = p;
            while q < n {
                let ch = self.bytes[q];
                if ch == b'"' || is_space_at(self.src, q) {
                    break;
                }
                if ch < 128 {
                    q += 1;
                } else {
                    q += next_char(self.src, q).unwrap().1;
                }
            }
            self.run_end = q;
            self.run_at = None;
            if let Some(an) = self.at_next
                && an < q
            {
                let limit = q.min(n.saturating_sub(1));
                let mut k = limit;
                while k > an {
                    k -= 1;
                    if self.bytes[k] == b'@' {
                        let after = self.bytes.get(k + 1).copied().unwrap_or(0);
                        if after != b'{' && after != b'"' {
                            self.run_at = Some(k);
                            break;
                        }
                    }
                }
                if self.run_at.is_none() && an < limit && self.bytes[an] == b'@' {
                    let after = self.bytes.get(an + 1).copied().unwrap_or(0);
                    if after != b'{' && after != b'"' {
                        self.run_at = Some(an);
                    }
                }
            }
        }
        if let Some(ra) = self.run_at
            && ra > p
        {
            self.emit(FlowToken::LinkId, p, ra + 1);
            return true;
        }
        false
    }

    fn try_initial_punct(&mut self, c: u8, d: u8) -> Option<bool> {
        let p = self.p;
        let ok = match c {
            b'#' => {
                self.emit(FlowToken::Brkt, p, p + 1);
                true
            }
            b':' => {
                if d == b':' && self.bytes.get(p + 2) == Some(&b':') {
                    self.emit(FlowToken::StyleSeparator, p, p + 3);
                } else {
                    self.emit(FlowToken::Colon, p, p + 1);
                }
                true
            }
            b'&' => {
                self.emit(FlowToken::Amp, p, p + 1);
                true
            }
            b';' => {
                self.emit(FlowToken::Semi, p, p + 1);
                true
            }
            b',' => {
                self.emit(FlowToken::Comma, p, p + 1);
                true
            }
            b'*' => {
                self.emit(FlowToken::Mult, p, p + 1);
                true
            }
            b'x' | b'o' => self.try_link(c) || self.try_node_string(),
            b'<' => {
                if !self.try_link(c) {
                    self.emit(FlowToken::TagStart, p, p + 1);
                }
                true
            }
            b'-' => {
                if !self.try_link(c) && !self.try_node_string() {
                    self.emit(FlowToken::Minus, p, p + 1);
                }
                true
            }
            b'=' => self.try_link(c),
            b'.' => self.try_link(c) || self.try_node_string(),
            b'~' => self.try_invis(),
            b'(' | b'|' | b'{' => self.try_opener(c, d),
            b'[' => {
                if d == b'|' {
                    self.emit(FlowToken::VertexWithPropsStart, p, p + 2);
                    true
                } else {
                    self.try_opener(c, d)
                }
            }
            b'>' => {
                self.push_state(State::Text);
                self.emit(FlowToken::TagEnd, p, p + 1);
                true
            }
            b'^' => {
                self.emit(FlowToken::Up, p, p + 1);
                true
            }
            b'\\' => {
                if d == b'|' {
                    self.emit(FlowToken::Sep, p, p + 2);
                    true
                } else {
                    self.try_node_string()
                }
            }
            b'v' => {
                if !is_word(d as u32) {
                    self.emit(FlowToken::Down, p, p + 1);
                    true
                } else {
                    self.try_node_string()
                }
            }
            _ => return None,
        };
        Some(ok)
    }

    fn step_initial_fallback(&mut self, c: u8) -> bool {
        let p = self.p;
        if is_space_at(self.src, p) {
            if self.try_link(c) {
                true
            } else if let Some(e) = match_newline(self.src, p) {
                self.emit(FlowToken::Newline, p, e);
                true
            } else {
                let e = skip_hspaces(self.src, p);
                if e > p {
                    self.emit(FlowToken::Space, p, e);
                    true
                } else {
                    false
                }
            }
        } else if c < 128 {
            self.try_node_string()
        } else if let Some((ch, len)) = next_char(self.src, p)
            && is_unicode_letter(ch as u32)
        {
            self.emit(FlowToken::UnicodeText, p, p + len);
            true
        } else {
            false
        }
    }
}
