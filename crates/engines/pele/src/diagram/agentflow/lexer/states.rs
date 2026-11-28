use super::super::tokens::AgentToken;
use super::scan::{Lexer, State, is_space_at, match_dir, match_empty_call, match_nodir, next_char, replace_nl_spaces};

impl Lexer<'_> {
    pub(super) fn step_string_lit(&mut self, b: u8) -> bool {
        let p = self.p;
        if b == b'"' {
            if self.bytes.get(p + 1) == Some(&b'`') {
                self.push_state(State::MdString);
                self.advance(p + 2);
            } else {
                self.pop_state();
                self.advance(p + 1);
            }
        } else {
            let end = self.src[p..].find('"').map_or(self.bytes.len(), |rel| p + rel);
            self.emit(AgentToken::Str, end);
        }
        true
    }

    pub(super) fn step_md_string(&mut self, b: u8) -> bool {
        let p = self.p;
        if b == b'`' {
            if self.bytes.get(p + 1) == Some(&b'"') {
                self.pop_state();
                self.advance(p + 2);
                true
            } else {
                false
            }
        } else if b == b'"' {
            self.quote();
            true
        } else {
            let n = self.bytes.len();
            let mut q = p + 1;
            while q < n && self.bytes[q] != b'`' && self.bytes[q] != b'"' {
                q += 1;
            }
            self.emit(AgentToken::MdStr, q);
            true
        }
    }

    pub(super) fn step_acc_single(&mut self) -> bool {
        let p = self.p;
        let end = self.src[p..].find('\n').map_or(self.bytes.len(), |rel| p + rel);
        let tok = if self.state == State::AccTitle {
            AgentToken::AccTitleValue
        } else {
            AgentToken::AccDescrValue
        };
        self.pop_state();
        self.emit(tok, end);
        true
    }

    pub(super) fn step_acc_multiline(&mut self, b: u8) -> bool {
        let p = self.p;
        if b == b'}' {
            self.pop_state();
            self.advance(p + 1);
        } else {
            let end = self.src[p..].find('}').map_or(self.bytes.len(), |rel| p + rel);
            self.emit(AgentToken::AccDescrMultilineValue, end);
        }
        true
    }

    pub(super) fn step_dir(&mut self, b: u8) -> bool {
        let p = self.p;
        if b == b'"' {
            self.quote();
            true
        } else if let Some(e) = match_nodir(self.src, p) {
            self.pop_state();
            self.emit(AgentToken::NoDir, e);
            true
        } else if let Some(e) = match_dir(self.src, p) {
            self.pop_state();
            self.emit(AgentToken::Dir, e);
            true
        } else {
            self.opener(b)
        }
    }

    pub(super) fn step_text(&mut self, b: u8) -> bool {
        let p = self.p;
        let d = self.bytes.get(p + 1).copied();
        match b {
            b'"' => {
                self.quote();
                true
            }
            b'(' | b'[' | b'{' => {
                let _ = self.opener(b);
                true
            }
            b']' => {
                self.pop_state();
                if d == Some(b')') {
                    self.emit_flat(AgentToken::StadiumEnd, p + 2);
                } else if d == Some(b']') {
                    self.emit_flat(AgentToken::SubroutineEnd, p + 2);
                } else {
                    self.emit_flat(AgentToken::Sqe, p + 1);
                }
                true
            }
            b')' => {
                self.pop_state();
                if d == Some(b']') {
                    self.emit_flat(AgentToken::CylinderEnd, p + 2);
                } else if d == Some(b')') && self.bytes.get(p + 2) == Some(&b')') {
                    self.emit_flat(AgentToken::DoubleCircleEnd, p + 3);
                } else {
                    self.emit_flat(AgentToken::Pe, p + 1);
                }
                true
            }
            b'|' => {
                self.pop_state();
                self.emit_flat(AgentToken::Pipe, p + 1);
                true
            }
            b'}' => {
                self.pop_state();
                self.emit_flat(AgentToken::DiamondStop, p + 1);
                true
            }
            b'%' => {
                if let Some(e) = self.comment_end(p) {
                    self.advance(e);
                    true
                } else {
                    false
                }
            }
            _ => {
                let n = self.bytes.len();
                let mut q = p + if b < 128 { 1 } else { next_char(self.src, p).map_or(1, |(_, l)| l) };
                while q < n {
                    let ch = self.bytes[q];
                    if matches!(ch, b'[' | b']' | b'(' | b')' | b'{' | b'}' | b'|' | b'"' | b'%') {
                        break;
                    }
                    q += 1;
                }
                self.emit(AgentToken::Text, q);
                true
            }
        }
    }

    pub(super) fn step_ellipse_text(&mut self, b: u8) -> bool {
        let p = self.p;
        let d = self.bytes.get(p + 1).copied();
        if b == b'"' {
            self.quote();
            true
        } else if b == b'%'
            && let Some(e) = self.comment_end(p)
        {
            self.advance(e);
            true
        } else if matches!(b, b'-' | b'/' | b')') && d == Some(b')') {
            self.pop_state();
            self.emit_flat(AgentToken::EllipseEnd, p + 2);
            true
        } else if matches!(b, b'(' | b'[' | b'{') {
            let _ = self.opener(b);
            true
        } else if matches!(b, b')' | b']' | b'}') {
            false
        } else {
            let n = self.bytes.len();
            let mut q = p + if b < 128 { 1 } else { next_char(self.src, p).map_or(1, |(_, l)| l) };
            while q < n {
                let ch = self.bytes[q];
                if matches!(ch, b'"' | b'(' | b')' | b'[' | b']' | b'{' | b'}') {
                    break;
                }
                if matches!(ch, b'-' | b'/') && self.bytes.get(q + 1) == Some(&b')') {
                    break;
                }
                if ch == b'%' && self.bytes.get(q + 1) == Some(&b'%') && self.bytes.get(q + 2) != Some(&b'{') {
                    break;
                }
                q += 1;
            }
            self.emit_chars(AgentToken::Text, q);
            true
        }
    }

    pub(super) fn step_trap_text(&mut self, b: u8) -> bool {
        let p = self.p;
        let d = self.bytes.get(p + 1).copied();
        if b == b'"' {
            self.quote();
            return true;
        }
        match b {
            b'(' => {
                if d == Some(b'-') || d == Some(b'[') || (d == Some(b'(') && self.bytes.get(p + 2) == Some(&b'(')) {
                    let _ = self.opener(b);
                } else if d == Some(b']') {
                    self.pop_state();
                    self.emit_flat(AgentToken::TrapEnd, p + 2);
                } else {
                    let _ = self.opener(b);
                }
                true
            }
            b'[' | b'{' => {
                let _ = self.opener(b);
                true
            }
            b'\\' => {
                if d == Some(b']') {
                    self.pop_state();
                    self.emit_flat(AgentToken::TrapEnd, p + 2);
                } else {
                    self.emit_flat(AgentToken::Text, p + 1);
                }
                true
            }
            b'/' => {
                if d == Some(b']') {
                    self.pop_state();
                    self.emit_flat(AgentToken::InvTrapEnd, p + 2);
                } else {
                    self.emit_flat(AgentToken::Text, p + 1);
                }
                true
            }
            b']' | b')' => {
                if d == Some(b']') {
                    self.pop_state();
                    self.emit_flat(AgentToken::TrapEnd, p + 2);
                    true
                } else {
                    false
                }
            }
            b'}' => false,
            b'%' => {
                if let Some(e) = self.comment_end(p) {
                    self.advance(e);
                    true
                } else {
                    false
                }
            }
            _ => {
                if matches!(b, b'?' | b'=') && d == Some(b']') {
                    self.pop_state();
                    self.emit_flat(AgentToken::TrapEnd, p + 2);
                } else {
                    let n = self.bytes.len();
                    let mut q = p + if b < 128 { 1 } else { next_char(self.src, p).map_or(1, |(_, l)| l) };
                    while q < n {
                        let ch = self.bytes[q];
                        if matches!(ch, b'\\' | b'[' | b']' | b'(' | b')' | b'{' | b'}' | b'/' | b'%') {
                            break;
                        }
                        q += 1;
                    }
                    self.emit(AgentToken::Text, q);
                }
                true
            }
        }
    }

    pub(super) fn step_edge_text(&mut self, b: u8) -> bool {
        let p = self.p;
        if b == b'"' {
            self.quote();
            true
        } else if let Some(e) = self.arrow_end(p) {
            self.pop_state();
            self.emit(AgentToken::Link, e);
            true
        } else if b == b'-' && self.bytes.get(p + 1) == Some(&b'-') {
            false
        } else {
            let n = self.bytes.len();
            let mut q = p + if b < 128 { 1 } else { next_char(self.src, p).map_or(1, |(_, l)| l) };
            while q < n {
                let ch = self.bytes[q];
                if ch == b'"' {
                    break;
                }
                if ch == b'-' {
                    if self.bytes.get(q + 1) == Some(&b'-') {
                        break;
                    }
                    q += 1;
                } else if is_space_at(self.src, q) {
                    if self.arrow_end(q).is_some() {
                        break;
                    }
                    q += if ch < 128 { 1 } else { next_char(self.src, q).map_or(1, |(_, l)| l) };
                } else {
                    q += if ch < 128 { 1 } else { next_char(self.src, q).map_or(1, |(_, l)| l) };
                }
            }
            self.emit_chars(AgentToken::EdgeText, q);
            true
        }
    }

    pub(super) fn step_click(&mut self, b: u8) -> bool {
        let p = self.p;
        if b == b'"' {
            self.quote();
        } else if is_space_at(self.src, p) {
            self.pop_state();
            let next = p + if b < 128 { 1 } else { next_char(self.src, p).map_or(1, |(_, l)| l) };
            self.advance(next);
        } else {
            let n = self.bytes.len();
            let mut q = p + if b < 128 { 1 } else { next_char(self.src, p).map_or(1, |(_, l)| l) };
            while q < n && !is_space_at(self.src, q) {
                let step = if self.bytes[q] < 128 {
                    1
                } else {
                    next_char(self.src, q).map_or(1, |(_, l)| l)
                };
                q += step;
            }
            self.emit_flat(AgentToken::Click, q);
        }
        true
    }

    pub(super) fn step_callback_name(&mut self, b: u8) -> bool {
        let p = self.p;
        if b == b'(' {
            let empty = match_empty_call(self.src, p);
            self.pop_state();
            if let Some(e) = empty {
                self.advance(e);
            } else {
                self.push_state(State::CallbackArgs);
                self.advance(p + 1);
            }
        } else {
            let end = self.src[p..].find('(').map_or(self.bytes.len(), |rel| p + rel);
            self.emit(AgentToken::CallbackName, end);
        }
        true
    }

    pub(super) fn step_callback_args(&mut self, b: u8) -> bool {
        let p = self.p;
        if b == b')' {
            self.pop_state();
            self.advance(p + 1);
        } else {
            let end = self.src[p..].find(')').map_or(self.bytes.len(), |rel| p + rel);
            self.emit(AgentToken::CallbackArgs, end);
        }
        true
    }

    pub(super) fn step_shape_data(&mut self, b: u8) -> bool {
        let p = self.p;
        if b == b'"' {
            self.push_state(State::ShapeDataStr);
            self.emit_flat(AgentToken::ShapeData, p + 1);
            true
        } else if b == b'}' {
            self.pop_state();
            self.advance(p + 1);
            true
        } else if b == b'^' {
            false
        } else {
            let n = self.bytes.len();
            let mut q = p + if b < 128 { 1 } else { next_char(self.src, p).map_or(1, |(_, l)| l) };
            while q < n && !matches!(self.bytes[q], b'}' | b'^' | b'"') {
                q += 1;
            }
            self.emit(AgentToken::ShapeData, q);
            true
        }
    }

    pub(super) fn step_shape_data_str(&mut self, b: u8) -> bool {
        let p = self.p;
        if b == b'"' {
            self.pop_state();
            self.emit_flat(AgentToken::ShapeData, p + 1);
        } else {
            let end = self.src[p..].find('"').map_or(self.bytes.len(), |rel| p + rel);
            let replaced = replace_nl_spaces(&self.src[p..end]);
            self.emit_text(AgentToken::ShapeData, replaced, end);
        }
        true
    }
}
