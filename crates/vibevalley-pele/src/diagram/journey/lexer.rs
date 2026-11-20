use crate::diagram::timeline::scan::{AccKinds, ScanTokens, byte_at, char_at, keyword_at, scan_accessibility, skip_trivia};
use crate::util::chars::{is_space_char, is_word};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JourneyToken {
    End,
    Eof,
    Invalid,
    Newline,
    Journey,
    Title,
    AccTitle,
    AccTitleValue,
    AccDescr,
    AccDescrValue,
    AccDescrMultilineValue,
    Section,
    TaskName,
    TaskData,
    Colon,
}

impl JourneyToken {
    pub const fn name(self) -> &'static str {
        match self {
            Self::End => "1",
            Self::Eof => "EOF",
            Self::Invalid => "INVALID",
            Self::Newline => "NEWLINE",
            Self::Journey => "journey",
            Self::Title => "title",
            Self::AccTitle => "acc_title",
            Self::AccTitleValue => "acc_title_value",
            Self::AccDescr => "acc_descr",
            Self::AccDescrValue => "acc_descr_value",
            Self::AccDescrMultilineValue => "acc_descr_multiline_value",
            Self::Section => "section",
            Self::TaskName => "taskName",
            Self::TaskData => "taskData",
            Self::Colon => ":",
        }
    }
}

const ACC_KINDS: AccKinds<JourneyToken> = AccKinds {
    acc_title: JourneyToken::AccTitle,
    acc_title_value: JourneyToken::AccTitleValue,
    acc_descr: JourneyToken::AccDescr,
    acc_descr_value: JourneyToken::AccDescrValue,
    acc_descr_multiline_value: JourneyToken::AccDescrMultilineValue,
};

fn text_end(src: &str, from: usize, colon: bool) -> usize {
    let bytes = src.as_bytes();
    let mut e = from;
    while e < bytes.len() {
        let b = bytes[e];
        if b == b'#' || b == b'\n' || b == b';' || (colon && b == b':') {
            break;
        }
        e += 1;
    }
    e
}

pub fn tokenize(src: &str) -> ScanTokens<JourneyToken> {
    let n = src.len();
    let bytes = src.as_bytes();
    let mut out = ScanTokens::new();
    let mut p = 0usize;

    loop {
        p = skip_trivia(src, p);
        if p >= n {
            break;
        }
        let b = bytes[p];
        if b == b'\n' {
            let mut e = p + 1;
            while byte_at(src, e) == Some(b'\n') {
                e += 1;
            }
            out.push(JourneyToken::Newline, &src[p..e], p);
            p = e;
            continue;
        }
        if keyword_at(src, p, "journey") && !byte_at(src, p + 7).is_some_and(|k| is_word(k as u32)) {
            out.push(JourneyToken::Journey, &src[p..p + 7], p);
            p += 7;
            continue;
        }
        if keyword_at(src, p, "title") {
            let mut e = p + 5;
            while let Some(ch) = char_at(src, e)
                && ch != '\n'
                && is_space_char(ch)
            {
                e += ch.len_utf8();
            }
            if e == n || byte_at(src, e) == Some(b'\n') {
                p = e;
                continue;
            }
            if let Some(sep) = char_at(src, p + 5)
                && sep != '\r'
                && is_space_char(sep)
            {
                let body_start = p + 5 + sep.len_utf8();
                let end = text_end(src, body_start, false);
                if end > body_start {
                    out.push(JourneyToken::Title, &src[p..end], p);
                    p = end;
                    continue;
                }
            }
        }
        let next_p = scan_accessibility(src, p, &mut out, ACC_KINDS);
        if next_p != p {
            p = next_p;
            continue;
        }
        if keyword_at(src, p, "section")
            && let Some(sep) = char_at(src, p + 7)
            && is_space_char(sep)
        {
            let body_start = p + 7 + sep.len_utf8();
            let end = text_end(src, body_start, true);
            if end > body_start {
                out.push(JourneyToken::Section, &src[p..end], p);
                p = end;
                continue;
            }
        }
        if b == b':' {
            let end = text_end(src, p + 1, false);
            if end > p + 1 {
                out.push(JourneyToken::TaskData, &src[p..end], p);
                p = end;
            } else {
                out.push(JourneyToken::Colon, &src[p..p + 1], p);
                p += 1;
            }
        } else if b == b';' {
            out.push(JourneyToken::Invalid, &src[p..p + 1], p);
            p += 1;
        } else {
            let first_len = char_at(src, p).map_or(1, char::len_utf8);
            let end = text_end(src, p + first_len, true);
            out.push(JourneyToken::TaskName, &src[p..end], p);
            p = end;
        }
    }

    if out.starts.last().is_none_or(|&s| s < n) {
        out.push(JourneyToken::Eof, "", n);
    }
    out.push(JourneyToken::End, "", n);
    out
}
