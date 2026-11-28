use super::super::tokens::FlowToken;
use super::scan::{Lexer, State, is_space_at, skip_spaces};

pub(super) fn match_link(src: &str, p: usize) -> Option<usize> {
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

pub(super) fn match_thick_link(src: &str, p: usize) -> Option<usize> {
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

pub(super) fn match_dotted_link(src: &str, p: usize) -> Option<usize> {
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

pub(super) fn match_invis_link(src: &str, p: usize) -> Option<usize> {
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

impl Lexer<'_> {
    pub(super) fn link_char(&mut self, q: usize) -> u8 {
        let j = if q >= self.ws_from && q <= self.ws_to {
            self.ws_to
        } else if is_space_at(self.src, q) {
            let end = skip_spaces(self.src, q);
            self.ws_from = q;
            self.ws_to = end;
            end
        } else {
            q
        };
        let d = self.bytes.get(j).copied().unwrap_or(0);
        if matches!(d, b'x' | b'o' | b'<') {
            self.bytes.get(j + 1).copied().unwrap_or(0)
        } else {
            d
        }
    }

    pub(super) fn invis_ahead(&mut self, q: usize) -> bool {
        let j = if q >= self.ws_from && q <= self.ws_to {
            self.ws_to
        } else if is_space_at(self.src, q) {
            let end = skip_spaces(self.src, q);
            self.ws_from = q;
            self.ws_to = end;
            end
        } else {
            q
        };
        self.bytes.get(j) == Some(&b'~')
    }

    pub(super) fn try_invis(&mut self) -> bool {
        let p0 = self.p;
        if !self.invis_ahead(p0) {
            return false;
        }
        if let Some(e) = match_invis_link(self.src, p0) {
            self.emit(FlowToken::Link, p0, e);
            true
        } else {
            false
        }
    }

    pub(super) fn try_link(&mut self, c: u8) -> bool {
        let p0 = self.p;
        let lc = self.link_char(p0);
        if lc == b'-' {
            if let Some(e) = match_link(self.src, p0) {
                self.emit(FlowToken::Link, p0, e);
                return true;
            }
            if let Some(e) = match_start_link(self.src, p0) {
                self.push_state(State::EdgeText);
                self.emit(FlowToken::StartLink, p0, e);
                return true;
            }
            if let Some(e) = match_dotted_link(self.src, p0) {
                self.emit(FlowToken::Link, p0, e);
                return true;
            }
            if let Some(e) = match_dotted_start(self.src, p0) {
                self.push_state(State::DottedEdgeText);
                self.emit(FlowToken::StartLink, p0, e);
                return true;
            }
        } else if lc == b'=' {
            if let Some(e) = match_thick_link(self.src, p0) {
                self.emit(FlowToken::Link, p0, e);
                return true;
            }
            if let Some(e) = match_thick_start(self.src, p0) {
                self.push_state(State::ThickEdgeText);
                self.emit(FlowToken::StartLink, p0, e);
                return true;
            }
        } else if lc == b'.'
            && let Some(e) = match_dotted_link(self.src, p0)
        {
            self.emit(FlowToken::Link, p0, e);
            return true;
        }
        c != b'-' && c != b'=' && c != b'.' && self.try_invis()
    }
}
