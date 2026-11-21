use crate::util::chars::{is_line_end, is_space_char, is_word};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tok {
    End,
    Eof,
    Spaceline,
    Nl,
    Ishikawa,
    Spacelist,
    Text,
}

impl Tok {
    pub const fn name(self) -> &'static str {
        match self {
            Self::End => "$end",
            Self::Eof => "EOF",
            Self::Spaceline => "SPACELINE",
            Self::Nl => "NL",
            Self::Ishikawa => "ISHIKAWA",
            Self::Spacelist => "SPACELIST",
            Self::Text => "TEXT",
        }
    }
}

pub struct Tokens {
    pub types: Vec<Tok>,
    pub starts: Vec<usize>,
    pub ends: Vec<usize>,
}

fn keyword(src: &str, at: usize) -> usize {
    let bytes = src.as_bytes();
    let word = b"ishikawa-beta";
    let mut k = 0usize;
    while k < 13 && at + k < bytes.len() {
        let c = bytes[at + k];
        let w = word[k];
        if c != w && !(c.is_ascii_uppercase() && c + 32 == w) {
            break;
        }
        k += 1;
    }
    if k == 13 && bytes.get(at + 13).is_none_or(|&b| !is_word(b as u32)) {
        return 13;
    }
    if k >= 8 && bytes.get(at + 8).is_none_or(|&b| !is_word(b as u32)) {
        8
    } else {
        0
    }
}

pub fn tokenize(src: &str) -> Tokens {
    let mut types = Vec::new();
    let mut starts = Vec::new();
    let mut ends = Vec::new();
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut i = 0usize;

    while i < n {
        let mut j = i;
        let mut last_break: Option<usize> = None;
        while j < n {
            let ch = src[j..].chars().next().unwrap();
            if !is_space_char(ch) {
                break;
            }
            if ch == '\n' {
                last_break = Some(j);
            }
            j += ch.len_utf8();
        }
        let (tok, end) = if bytes.get(j) == Some(&b'%') && bytes.get(j + 1) == Some(&b'%') {
            let mut e = j + 2;
            while e < n {
                let ch = src[e..].chars().next().unwrap();
                if is_line_end(ch as u32) {
                    break;
                }
                e += ch.len_utf8();
            }
            (Tok::Spaceline, e)
        } else if j == i {
            let len = keyword(src, i);
            if len > 0 {
                (Tok::Ishikawa, i + len)
            } else {
                let e = src[i..].find('\n').map_or(n, |rel| i + rel);
                (Tok::Text, e)
            }
        } else if let Some(lb) = last_break {
            if lb > i { (Tok::Spaceline, lb + 1) } else { (Tok::Nl, i + 1) }
        } else {
            (Tok::Spacelist, j)
        };
        types.push(tok);
        starts.push(i);
        ends.push(end);
        i = end;
    }
    types.push(Tok::Eof);
    types.push(Tok::End);
    starts.push(n);
    starts.push(n);
    ends.push(n);
    ends.push(n);
    Tokens { types, starts, ends }
}
