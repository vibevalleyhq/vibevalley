use crate::diagram::common::word_at;
use crate::util::chars::is_word;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SankeyToken {
    End,
    Stuck,
    Sankey,
    Newline,
    Comma,
    Dquote,
    NonEscapedText,
    EscapedText,
    Eof,
}

impl SankeyToken {
    pub const fn name(self) -> &'static str {
        match self {
            Self::End => "$end",
            Self::Stuck => "STUCK",
            Self::Sankey => "SANKEY",
            Self::Newline => "NEWLINE",
            Self::Comma => "COMMA",
            Self::Dquote => "DQUOTE",
            Self::NonEscapedText => "NON_ESCAPED_TEXT",
            Self::EscapedText => "ESCAPED_TEXT",
            Self::Eof => "EOF",
        }
    }
}

pub struct SankeyTokens<'a> {
    pub types: Vec<SankeyToken>,
    pub texts: Vec<&'a str>,
    pub starts: Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LexState {
    Initial,
    Csv,
    EscapedText,
}

/// RFC 4180 TEXTDATA extended to Unicode, excluding controls and invalid XML characters.
fn is_text_data(c: u32) -> bool {
    ((32..=126).contains(&c) && c != 34 && c != 44) || (0xa0..=0xd7ff).contains(&c) || (0xe000..=0xfffd).contains(&c) || (0x10000..=0x10ffff).contains(&c)
}

pub fn tokenize(src: &str) -> SankeyTokens<'_> {
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut types = Vec::new();
    let mut texts = Vec::new();
    let mut starts = Vec::new();
    let mut stack: Vec<LexState> = Vec::new();
    let mut state = LexState::Initial;
    let mut p = 0usize;

    macro_rules! emit {
        ($tok:expr, $s:expr, $e:expr) => {{
            types.push($tok);
            texts.push(&src[$s..$e]);
            starts.push($s);
            p = $e;
        }};
    }

    let keyword = |at: usize, word: &str| -> bool { word_at(src, at, word) && !is_word(bytes.get(at + word.len()).copied().unwrap_or(0) as u32) };

    while p < n {
        let c = bytes[p];
        let start = p;
        let mut q = p;

        if state == LexState::EscapedText {
            if c == b'"' && bytes.get(p + 1) != Some(&b'"') {
                if let Some(prev) = stack.pop() {
                    state = prev;
                }
                emit!(SankeyToken::Dquote, p, p + 1);
                continue;
            }
            while q < n {
                let ch = src[q..].chars().next().unwrap();
                let d = ch as u32;
                if is_text_data(d) || d == 44 || d == 13 || d == 10 {
                    q += ch.len_utf8();
                } else if d == 34 && bytes.get(q + 1) == Some(&b'"') {
                    q += 2;
                } else {
                    break;
                }
            }
            emit!(SankeyToken::EscapedText, p, q);
        } else {
            if state == LexState::Initial && (c | 32) == b's' {
                let len = if keyword(p, "sankey-beta") {
                    11
                } else if keyword(p, "sankey") {
                    6
                } else {
                    0
                };
                if len > 0 {
                    stack.push(state);
                    state = LexState::Csv;
                    emit!(SankeyToken::Sankey, p, p + len);
                    continue;
                }
            }
            if c == b'\n' || (c == b'\r' && bytes.get(p + 1) == Some(&b'\n')) {
                let e = if c == b'\n' { p + 1 } else { p + 2 };
                emit!(SankeyToken::Newline, p, e);
                continue;
            }
            if c == b',' {
                emit!(SankeyToken::Comma, p, p + 1);
                continue;
            }
            if c == b'"' {
                stack.push(state);
                state = LexState::EscapedText;
                emit!(SankeyToken::Dquote, p, p + 1);
                continue;
            }
            while q < n {
                let ch = src[q..].chars().next().unwrap();
                if !is_text_data(ch as u32) {
                    break;
                }
                q += ch.len_utf8();
            }
            emit!(SankeyToken::NonEscapedText, p, q);
        }

        if q == start {
            types.push(SankeyToken::Stuck);
            texts.push("");
            starts.push(p);
            return SankeyTokens { types, texts, starts };
        }
    }

    types.push(if state == LexState::EscapedText {
        SankeyToken::EscapedText
    } else {
        SankeyToken::Eof
    });
    texts.push("");
    starts.push(n);
    types.push(SankeyToken::End);
    texts.push("");
    starts.push(n);
    SankeyTokens { types, texts, starts }
}
