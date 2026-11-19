use crate::util::chars::{is_digit, is_hex, is_space, is_space_char, is_word};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VennToken {
    End,
    Error,
    Eof,
    Newline,
    Venn,
    Title,
    Set,
    Union,
    Text,
    IndentText,
    Style,
    BracketLabel,
    Numeric,
    HexColor,
    RgbColor,
    RgbaColor,
    Identifier,
    String,
    Comma,
    Colon,
}

impl VennToken {
    pub const fn name(self) -> &'static str {
        match self {
            Self::End => "$end",
            Self::Error => "INVALID",
            Self::Eof => "EOF",
            Self::Newline => "NEWLINE",
            Self::Venn => "VENN",
            Self::Title => "TITLE",
            Self::Set => "SET",
            Self::Union => "UNION",
            Self::Text => "TEXT",
            Self::IndentText => "INDENT_TEXT",
            Self::Style => "STYLE",
            Self::BracketLabel => "BRACKET_LABEL",
            Self::Numeric => "NUMERIC",
            Self::HexColor => "HEXCOLOR",
            Self::RgbColor => "RGBCOLOR",
            Self::RgbaColor => "RGBACOLOR",
            Self::Identifier => "IDENTIFIER",
            Self::String => "STRING",
            Self::Comma => "COMMA",
            Self::Colon => "COLON",
        }
    }

    pub const fn is_style_value_part(self) -> bool {
        matches!(self, Self::Identifier | Self::Numeric | Self::HexColor | Self::RgbColor | Self::RgbaColor)
    }
}

pub trait IndentHost {
    fn indent_mode(&self) -> bool;
    fn set_indent_mode(&mut self, enabled: bool);
}

const KEYWORDS: [(&str, VennToken); 5] = [
    ("venn-beta", VennToken::Venn),
    ("set", VennToken::Set),
    ("union", VennToken::Union),
    ("text", VennToken::Text),
    ("style", VennToken::Style),
];

pub struct VennLexer<'a> {
    src: &'a str,
    pub text: &'a str,
    pub start: usize,
    at: usize,
    line_start: bool,
    ended: bool,
}

impl<'a> VennLexer<'a> {
    pub fn new(src: &'a str) -> Self {
        Self {
            src,
            text: "",
            start: 0,
            at: 0,
            line_start: false,
            ended: false,
        }
    }

    fn byte_at(&self, idx: usize) -> u8 {
        self.src.as_bytes().get(idx).copied().unwrap_or(0)
    }

    fn word(&self, at: usize, word: &str) -> bool {
        let bytes = self.src.as_bytes();
        let wbytes = word.as_bytes();
        if at + wbytes.len() > bytes.len() {
            return false;
        }
        for k in 0..wbytes.len() {
            let c = bytes[at + k];
            let w = wbytes[k];
            if c != w && !(c.is_ascii_uppercase() && c + 32 == w) {
                return false;
            }
        }
        true
    }

    fn keyword(&self, at: usize, word: &str) -> bool {
        self.word(at, word) && !is_word(self.byte_at(at + word.len()) as u32)
    }

    fn run_spaces(&self, mut i: usize) -> usize {
        let bytes = self.src.as_bytes();
        while i < bytes.len() {
            let b = bytes[i];
            if b < 128 {
                if is_space(b as u32) {
                    i += 1;
                } else {
                    break;
                }
            } else {
                let ch = self.src[i..].chars().next().unwrap();
                if is_space(ch as u32) {
                    i += ch.len_utf8();
                } else {
                    break;
                }
            }
        }
        i
    }

    fn color(&self, at: usize, parts: usize) -> Option<usize> {
        let bytes = self.src.as_bytes();
        let mut i = at + 1;
        for part in 0..parts {
            i = self.run_spaces(i);
            let from = i;
            while i < bytes.len() && (is_digit(bytes[i] as u32) || bytes[i] == b'.') {
                i += 1;
            }
            if i == from {
                return None;
            }
            i = self.run_spaces(i);
            let expected = if part == parts - 1 { b')' } else { b',' };
            if self.byte_at(i) != expected {
                return None;
            }
            i += 1;
        }
        Some(i)
    }

    fn after_line_feed(&self, at: usize) -> bool {
        let bytes = self.src.as_bytes();
        let mut k = at;
        while k > 0 && matches!(bytes[k - 1], b' ' | b'\t') {
            k -= 1;
        }
        k > 0 && bytes[k - 1] == b'\n'
    }

    fn line_end(&self, from: usize) -> usize {
        self.src[from..].find('\n').map_or(self.src.len(), |rel| from + rel)
    }

    fn token(&mut self, kind: VennToken, end: usize) -> VennToken {
        self.text = &self.src[self.at..end];
        self.at = end;
        kind
    }

    pub fn next(&mut self, host: &mut impl IndentHost) -> VennToken {
        let bytes = self.src.as_bytes();
        let n = bytes.len();
        loop {
            let mut i = self.at;
            self.start = i;
            self.text = "";
            if i >= n {
                if self.ended {
                    return VennToken::End;
                }
                self.ended = true;
                return VennToken::Eof;
            }
            let c = bytes[i];
            if c == b'%' && self.byte_at(i + 1) == b'%' && self.byte_at(i + 2) != b'{' {
                self.at = self.line_end(i + 2);
                continue;
            }
            if self.line_start
                && self.word(i, "title")
                && self.after_line_feed(i)
                && self.src[i + 5..self.line_end(i + 5)].trim_matches(is_space_char).is_empty()
            {
                let mut j = self.line_end(i + 5);
                while j < n && matches!(bytes[j], b'\n' | b'\r') {
                    j += 1;
                }
                self.at = j;
                continue;
            }
            if self.line_start {
                if c == b' ' || c == b'\t' {
                    let mut j = i + 1;
                    while j < n && matches!(bytes[j], b' ' | b'\t') {
                        j += 1;
                    }
                    self.at = j;
                    if self.keyword(j, "text") && host.indent_mode() {
                        self.at = j + 4;
                        self.line_start = false;
                        self.text = &self.src[i..j];
                        return VennToken::IndentText;
                    }
                    continue;
                }
                if c != b'\n' && c != b'\r' {
                    host.set_indent_mode(false);
                    self.line_start = false;
                }
            }
            if c == b'\n' || c == b'\r' {
                i += 1;
                while i < n && matches!(bytes[i], b'\n' | b'\r') {
                    i += 1;
                }
                self.line_start = true;
                return self.token(VennToken::Newline, i);
            }
            if c == b'%' && self.byte_at(i + 1) == b'%' {
                self.at = self.line_end(i);
                continue;
            }
            if c == b' ' || c == b'\t' {
                i += 1;
                while i < n && matches!(bytes[i], b' ' | b'\t') {
                    i += 1;
                }
                self.at = i;
                continue;
            }

            if ((c | 32) >= b'a' && (c | 32) <= b'z') || c == b'_' {
                if self.word(i, "title")
                    && let Some(sep) = self.src[i + 5..].chars().next()
                    && is_space(sep as u32)
                    && sep != '\n'
                    && sep != '\r'
                {
                    let start_body = i + 5 + sep.len_utf8();
                    let mut end = start_body;
                    while end < n {
                        let ch = bytes[end];
                        if ch == b'#' || ch == b'\n' || ch == b';' {
                            break;
                        }
                        end += 1;
                    }
                    if end > start_body {
                        return self.token(VennToken::Title, end);
                    }
                }
                for (word, kind) in KEYWORDS {
                    if self.keyword(i, word) && self.byte_at(i + word.len()) != b'-' {
                        return self.token(kind, i + word.len());
                    }
                }
                if self.word(i, "rgb") {
                    let alpha = (self.byte_at(i + 3) | 32) == b'a';
                    let open = i + if alpha { 4 } else { 3 };
                    if self.byte_at(open) == b'('
                        && let Some(end) = self.color(open, if alpha { 4 } else { 3 })
                    {
                        return self.token(if alpha { VennToken::RgbaColor } else { VennToken::RgbColor }, end);
                    }
                }
                i += 1;
                while i < n && (is_word(bytes[i] as u32) || bytes[i] == b'-') {
                    i += 1;
                }
                return self.token(VennToken::Identifier, i);
            }

            if c == b'[' {
                if self.byte_at(i + 1) == b'"' {
                    let Some(rel) = self.src[i + 2..].find('"') else {
                        return VennToken::Error;
                    };
                    let quote = i + 2 + rel;
                    if self.byte_at(quote + 1) != b']' {
                        return VennToken::Error;
                    }
                    self.at = quote + 2;
                    self.text = &self.src[i + 2..quote];
                    return VennToken::BracketLabel;
                }
                let mut end = i + 1;
                while end < n && bytes[end] != b']' && bytes[end] != b'"' {
                    end += 1;
                }
                if end == i + 1 || self.byte_at(end) != b']' {
                    return VennToken::Error;
                }
                self.at = end + 1;
                self.text = self.src[i + 1..end].trim_matches(is_space_char);
                return VennToken::BracketLabel;
            }

            if is_digit(c as u32) || matches!(c, b'.' | b'+' | b'-') {
                if c == b'+' || c == b'-' {
                    i += 1;
                }
                let from = i;
                while i < n && is_digit(bytes[i] as u32) {
                    i += 1;
                }
                if i > from {
                    if self.byte_at(i) == b'.' && is_digit(self.byte_at(i + 1) as u32) {
                        i += 2;
                        while i < n && is_digit(bytes[i] as u32) {
                            i += 1;
                        }
                    }
                } else if self.byte_at(i) == b'.' && is_digit(self.byte_at(i + 1) as u32) {
                    i += 2;
                    while i < n && is_digit(bytes[i] as u32) {
                        i += 1;
                    }
                } else {
                    return VennToken::Error;
                }
                return self.token(VennToken::Numeric, i);
            }

            if c == b'#' {
                let mut end = i + 1;
                while end < n && end < i + 9 && is_hex(bytes[end] as u32) {
                    end += 1;
                }
                return if end >= i + 4 {
                    self.token(VennToken::HexColor, end)
                } else {
                    VennToken::Error
                };
            }

            if c == b'"' {
                let Some(rel) = self.src[i + 1..].find('"') else {
                    return VennToken::Error;
                };
                return self.token(VennToken::String, i + 1 + rel + 1);
            }

            if c == b',' {
                return self.token(VennToken::Comma, i + 1);
            }
            if c == b':' {
                return self.token(VennToken::Colon, i + 1);
            }
            return VennToken::Error;
        }
    }
}
