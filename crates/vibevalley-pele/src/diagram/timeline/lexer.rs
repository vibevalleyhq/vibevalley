use crate::util::chars::{is_space_char, is_word};

use super::scan::{AccKinds, ScanTokens, byte_at, char_at, keyword_at, line_end, scan_accessibility, skip_trivia};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimelineToken {
    End,
    Eof,
    Invalid,
    Newline,
    Timeline,
    TimelineLr,
    TimelineTd,
    Title,
    AccTitle,
    AccTitleValue,
    AccDescr,
    AccDescrValue,
    AccDescrMultilineValue,
    Section,
    Period,
    Event,
}

impl TimelineToken {
    pub const fn name(self) -> &'static str {
        match self {
            Self::End => "1",
            Self::Eof => "EOF",
            Self::Invalid => "INVALID",
            Self::Newline => "NEWLINE",
            Self::Timeline => "timeline",
            Self::TimelineLr => "timeline_lr",
            Self::TimelineTd => "timeline_td",
            Self::Title => "title",
            Self::AccTitle => "acc_title",
            Self::AccTitleValue => "acc_title_value",
            Self::AccDescr => "acc_descr",
            Self::AccDescrValue => "acc_descr_value",
            Self::AccDescrMultilineValue => "acc_descr_multiline_value",
            Self::Section => "section",
            Self::Period => "period",
            Self::Event => "event",
        }
    }
}

const ACC_KINDS: AccKinds<TimelineToken> = AccKinds {
    acc_title: TimelineToken::AccTitle,
    acc_title_value: TimelineToken::AccTitleValue,
    acc_descr: TimelineToken::AccDescr,
    acc_descr_value: TimelineToken::AccDescrValue,
    acc_descr_multiline_value: TimelineToken::AccDescrMultilineValue,
};

pub fn tokenize(src: &str) -> ScanTokens<TimelineToken> {
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
            out.push(TimelineToken::Newline, &src[p..e], p);
            p = e;
            continue;
        }
        if keyword_at(src, p, "timeline") {
            let mut e = p + 8;
            while matches!(byte_at(src, e), Some(b' ' | b'\t')) {
                e += 1;
            }
            let lr = keyword_at(src, e, "lr");
            if e > p + 8 && (lr || keyword_at(src, e, "td")) && !byte_at(src, e + 2).is_some_and(|k| is_word(k as u32)) {
                let kind = if lr { TimelineToken::TimelineLr } else { TimelineToken::TimelineTd };
                out.push(kind, &src[p..e + 2], p);
                p = e + 2;
                continue;
            }
            if !byte_at(src, p + 8).is_some_and(|k| is_word(k as u32)) {
                out.push(TimelineToken::Timeline, &src[p..p + 8], p);
                p += 8;
                continue;
            }
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
                let end = line_end(src, p + 5 + sep.len_utf8());
                out.push(TimelineToken::Title, &src[p..end], p);
                p = end;
                continue;
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
            let start_body = p + 7 + sep.len_utf8();
            let mut e = start_body;
            while e < n && bytes[e] != b':' && bytes[e] != b'\n' {
                e += 1;
            }
            if e > start_body {
                out.push(TimelineToken::Section, &src[p..e], p);
                p = e;
                continue;
            }
        }
        if b != b':' {
            let first_len = char_at(src, p).map_or(1, char::len_utf8);
            let mut e = p + first_len;
            while e < n && !matches!(bytes[e], b'#' | b':' | b'\n') {
                e += 1;
            }
            out.push(TimelineToken::Period, &src[p..e], p);
            p = e;
            continue;
        }
        if let Some(sep) = char_at(src, p + 1)
            && is_space_char(sep)
        {
            let start_body = p + 1 + sep.len_utf8();
            let mut e = start_body;
            while e < n {
                let k = bytes[e];
                if k == b'\n' || (k == b':' && char_at(src, e + 1).is_some_and(is_space_char)) {
                    break;
                }
                e += 1;
            }
            if e > start_body {
                out.push(TimelineToken::Event, &src[p..e], p);
                p = e;
                continue;
            }
        }
        let step = char_at(src, p).map_or(1, char::len_utf8);
        out.push(TimelineToken::Invalid, &src[p..p + step], p);
        p += step;
    }

    if out.starts.last().is_none_or(|&s| s < n) {
        out.push(TimelineToken::Eof, "", n);
    }
    out.push(TimelineToken::End, "", n);
    out
}
