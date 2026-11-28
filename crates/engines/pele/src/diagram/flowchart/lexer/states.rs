use super::super::tokens::FlowToken;
use super::links::{match_dotted_link, match_invis_link, match_link, match_thick_link};
use super::scan::{Lexer, State, is_space_at, match_dir, match_empty_call, match_nodir, next_char, replace_nl_spaces};

impl Lexer<'_> {
    pub(super) fn step_string_lit(&mut self, c: u8, d: u8) -> bool {
        if c == b'"' {
            if d == b'`' {
                self.push_state(State::MdString);
                self.p += 2;
            } else {
                self.pop_state();
                self.p += 1;
            }
        } else {
            let p = self.p;
            let e = self.src[p..].find('"').map_or(self.bytes.len(), |r| p + r);
            self.emit(FlowToken::Str, p, e);
        }
        true
    }

    pub(super) fn step_md_string(&mut self, c: u8, d: u8) -> bool {
        if c == b'`' {
            if d == b'"' {
                self.pop_state();
                self.p += 2;
                true
            } else {
                false
            }
        } else if c == b'"' {
            self.push_quote(d);
            true
        } else {
            let p = self.p;
            let n = self.bytes.len();
            let mut q = p + next_char(self.src, p).unwrap().1;
            while q < n {
                let ch = self.bytes[q];
                if ch == b'`' || ch == b'"' {
                    break;
                }
                if ch < 128 {
                    q += 1;
                } else {
                    q += next_char(self.src, q).unwrap().1;
                }
            }
            self.emit(FlowToken::MdStr, p, q);
            true
        }
    }

    pub(super) fn step_acc_single(&mut self) -> bool {
        let p = self.p;
        let e = self.src[p..].find('\n').map_or(self.bytes.len(), |r| p + r);
        let tok = if self.state == State::AccTitle {
            FlowToken::AccTitleValue
        } else {
            FlowToken::AccDescrValue
        };
        self.pop_state();
        self.emit(tok, p, e);
        true
    }

    pub(super) fn step_acc_multiline(&mut self, c: u8) -> bool {
        if c == b'}' {
            self.pop_state();
            self.p += 1;
        } else {
            let p = self.p;
            let e = self.src[p..].find('}').map_or(self.bytes.len(), |r| p + r);
            self.emit(FlowToken::AccDescrMultilineValue, p, e);
        }
        true
    }

    pub(super) fn step_dir(&mut self, c: u8, d: u8) -> bool {
        let p = self.p;
        if c == b'"' {
            self.push_quote(d);
            true
        } else if let Some(e) = match_nodir(self.src, p) {
            self.pop_state();
            self.emit(FlowToken::NoDir, p, e);
            true
        } else if let Some(e) = match_dir(self.src, p) {
            self.pop_state();
            self.emit(FlowToken::Dir, p, e);
            true
        } else {
            self.try_invis() || self.try_opener(c, d)
        }
    }

    pub(super) fn step_text(&mut self, c: u8, d: u8) -> bool {
        let p = self.p;
        match c {
            b'"' => self.push_quote(d),
            b'(' | b'[' | b'{' => {
                self.try_opener(c, d);
            }
            b']' => {
                self.pop_state();
                if d == b')' {
                    self.emit(FlowToken::StadiumEnd, p, p + 2);
                } else if d == b']' {
                    self.emit(FlowToken::SubroutineEnd, p, p + 2);
                } else {
                    self.emit(FlowToken::Sqe, p, p + 1);
                }
            }
            b')' => {
                self.pop_state();
                if d == b']' {
                    self.emit(FlowToken::CylinderEnd, p, p + 2);
                } else if d == b')' && self.bytes.get(p + 2) == Some(&b')') {
                    self.emit(FlowToken::DoubleCircleEnd, p, p + 3);
                } else {
                    self.emit(FlowToken::Pe, p, p + 1);
                }
            }
            b'|' => {
                self.pop_state();
                self.emit(FlowToken::Pipe, p, p + 1);
            }
            b'}' => {
                self.pop_state();
                self.emit(FlowToken::DiamondStop, p, p + 1);
            }
            _ => {
                if (c == b'~' || is_space_at(self.src, p)) && self.try_invis() {
                } else {
                    let n = self.bytes.len();
                    let mut q = p + next_char(self.src, p).unwrap().1;
                    while q < n {
                        let ch = self.bytes[q];
                        if matches!(ch, b'[' | b']' | b'(' | b')' | b'{' | b'}' | b'|' | b'"') {
                            break;
                        }
                        if ch < 128 {
                            q += 1;
                        } else {
                            q += next_char(self.src, q).unwrap().1;
                        }
                    }
                    self.emit(FlowToken::Text, p, q);
                }
            }
        }
        true
    }

    pub(super) fn step_ellipse_text(&mut self, c: u8, d: u8) -> bool {
        let p = self.p;
        if c == b'"' {
            self.push_quote(d);
            true
        } else if (c == b'~' || is_space_at(self.src, p)) && self.try_invis() {
            true
        } else if matches!(c, b'-' | b'/' | b')') && d == b')' {
            self.pop_state();
            self.emit(FlowToken::EllipseEnd, p, p + 2);
            true
        } else if matches!(c, b'(' | b'[' | b'{') {
            self.try_opener(c, d);
            true
        } else if matches!(c, b')' | b']' | b'}') {
            false
        } else {
            let n = self.bytes.len();
            let mut q = p + next_char(self.src, p).unwrap().1;
            while q < n {
                let ch = self.bytes[q];
                if matches!(ch, b'"' | b'(' | b')' | b'[' | b']' | b'{' | b'}') {
                    break;
                }
                if matches!(ch, b'-' | b'/') && self.bytes.get(q + 1) == Some(&b')') {
                    break;
                }
                if (ch == b'~' || is_space_at(self.src, q)) && self.invis_ahead(q) && match_invis_link(self.src, q).is_some() {
                    break;
                }
                if ch < 128 {
                    q += 1;
                } else {
                    q += next_char(self.src, q).unwrap().1;
                }
            }
            self.emit(FlowToken::Text, p, q);
            true
        }
    }

    pub(super) fn step_trap_text(&mut self, c: u8, d: u8) -> bool {
        let p = self.p;
        if c == b'"' {
            self.push_quote(d);
            return true;
        }
        if (c == b'~' || is_space_at(self.src, p)) && self.try_invis() {
            return true;
        }
        match c {
            b'(' => {
                if d == b'-' || d == b'[' || (d == b'(' && self.bytes.get(p + 2) == Some(&b'(')) {
                    self.try_opener(c, d);
                } else if d == b']' {
                    self.pop_state();
                    self.emit(FlowToken::TrapEnd, p, p + 2);
                } else {
                    self.try_opener(c, d);
                }
                true
            }
            b'[' | b'{' => {
                self.try_opener(c, d);
                true
            }
            b'\\' => {
                if d == b']' {
                    self.pop_state();
                    self.emit(FlowToken::TrapEnd, p, p + 2);
                } else {
                    self.emit(FlowToken::Text, p, p + 1);
                }
                true
            }
            b'/' => {
                if d == b']' {
                    self.pop_state();
                    self.emit(FlowToken::InvTrapEnd, p, p + 2);
                } else {
                    self.emit(FlowToken::Text, p, p + 1);
                }
                true
            }
            b']' | b')' => {
                if d == b']' {
                    self.pop_state();
                    self.emit(FlowToken::TrapEnd, p, p + 2);
                    true
                } else {
                    false
                }
            }
            b'}' => false,
            _ => {
                if matches!(c, b'?' | b'=') && d == b']' {
                    self.pop_state();
                    self.emit(FlowToken::TrapEnd, p, p + 2);
                } else {
                    let n = self.bytes.len();
                    let mut q = p + next_char(self.src, p).unwrap().1;
                    while q < n {
                        let ch = self.bytes[q];
                        if matches!(ch, b'\\' | b'[' | b']' | b'(' | b')' | b'{' | b'}' | b'/') {
                            break;
                        }
                        if ch < 128 {
                            q += 1;
                        } else {
                            q += next_char(self.src, q).unwrap().1;
                        }
                    }
                    self.emit(FlowToken::Text, p, q);
                }
                true
            }
        }
    }

    pub(super) fn step_edge_text(&mut self, c: u8, d: u8) -> bool {
        type LinkMatcher = fn(&str, usize) -> Option<usize>;
        let (a, b_alt, matcher): (u8, u8, LinkMatcher) = match self.state {
            State::EdgeText => (b'-', 0, match_link),
            State::ThickEdgeText => (b'=', 0, match_thick_link),
            State::DottedEdgeText => (b'.', b'-', match_dotted_link),
            _ => unreachable!(),
        };
        if c == b'"' {
            self.push_quote(d);
            return true;
        }
        let p = self.p;
        let lc = self.link_char(p);
        if (lc == a || (b_alt != 0 && lc == b_alt))
            && let Some(e) = matcher(self.src, p)
        {
            self.pop_state();
            self.emit(FlowToken::Link, p, e);
            return true;
        }
        if c == a && (a != b'-' || d == b'-') {
            return false;
        }
        let n = self.bytes.len();
        let mut q = p + next_char(self.src, p).unwrap().1;
        while q < n {
            let ch = self.bytes[q];
            if ch == b'"' {
                break;
            }
            if ch == a {
                if a != b'-' || self.bytes.get(q + 1) == Some(&b'-') {
                    break;
                }
            } else if matches!(ch, b'x' | b'o' | b'<') || (b_alt != 0 && ch == b_alt) || is_space_at(self.src, q) {
                let dd = self.link_char(q);
                if (dd == a || (b_alt != 0 && dd == b_alt)) && matcher(self.src, q).is_some() {
                    break;
                }
            }
            if ch < 128 {
                q += 1;
            } else {
                q += next_char(self.src, q).unwrap().1;
            }
        }
        self.emit(FlowToken::EdgeText, p, q);
        true
    }

    pub(super) fn step_click(&mut self, c: u8, d: u8) -> bool {
        let p = self.p;
        if c == b'"' {
            self.push_quote(d);
        } else if is_space_at(self.src, p) {
            self.pop_state();
            self.p += next_char(self.src, p).unwrap().1;
        } else {
            let n = self.bytes.len();
            let mut q = p + next_char(self.src, p).unwrap().1;
            while q < n && !is_space_at(self.src, q) {
                if self.bytes[q] < 128 {
                    q += 1;
                } else {
                    q += next_char(self.src, q).unwrap().1;
                }
            }
            self.emit(FlowToken::Click, p, q);
        }
        true
    }

    pub(super) fn step_callback_name(&mut self, c: u8) -> bool {
        let p = self.p;
        if c == b'(' {
            let empty = match_empty_call(self.src, p);
            self.pop_state();
            if let Some(e) = empty {
                self.p = e;
            } else {
                self.push_state(State::CallbackArgs);
                self.p += 1;
            }
        } else {
            let e = self.src[p..].find('(').map_or(self.bytes.len(), |r| p + r);
            self.emit(FlowToken::CallbackName, p, e);
        }
        true
    }

    pub(super) fn step_callback_args(&mut self, c: u8) -> bool {
        let p = self.p;
        if c == b')' {
            self.pop_state();
            self.p += 1;
        } else {
            let e = self.src[p..].find(')').map_or(self.bytes.len(), |r| p + r);
            self.emit(FlowToken::CallbackArgs, p, e);
        }
        true
    }

    pub(super) fn step_shape_data(&mut self, c: u8) -> bool {
        let p = self.p;
        if c == b'"' {
            self.push_state(State::ShapeDataStr);
            self.emit(FlowToken::ShapeData, p, p + 1);
            true
        } else if c == b'}' {
            self.pop_state();
            self.p += 1;
            true
        } else if c == b'^' {
            false
        } else {
            let n = self.bytes.len();
            let mut q = p + next_char(self.src, p).unwrap().1;
            while q < n {
                let ch = self.bytes[q];
                if matches!(ch, b'}' | b'^' | b'"') {
                    break;
                }
                if ch < 128 {
                    q += 1;
                } else {
                    q += next_char(self.src, q).unwrap().1;
                }
            }
            self.emit(FlowToken::ShapeData, p, q);
            true
        }
    }

    pub(super) fn step_shape_data_str(&mut self, c: u8) -> bool {
        let p = self.p;
        if c == b'"' {
            self.pop_state();
            self.emit(FlowToken::ShapeData, p, p + 1);
        } else {
            let e = self.src[p..].find('"').map_or(self.bytes.len(), |r| p + r);
            self.types.push(FlowToken::ShapeData);
            self.texts.push(replace_nl_spaces(&self.src[p..e]));
            self.starts.push(p);
            self.p = e;
        }
        true
    }
}
