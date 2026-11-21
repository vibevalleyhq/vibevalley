use crate::util::chars::is_space_char;

/// Token stream shared by the Jison-derived `timeline` and `journey` lexers.
pub struct ScanTokens<T> {
    pub types: Vec<T>,
    pub texts: Vec<String>,
    pub starts: Vec<usize>,
}

impl<T> ScanTokens<T> {
    pub fn new() -> Self {
        Self {
            types: Vec::new(),
            texts: Vec::new(),
            starts: Vec::new(),
        }
    }

    pub fn push(&mut self, kind: T, text: &str, start: usize) {
        self.types.push(kind);
        self.texts.push(text.to_string());
        self.starts.push(start);
    }
}

pub fn char_at(src: &str, p: usize) -> Option<char> {
    src.get(p..)?.chars().next()
}

pub fn byte_at(src: &str, p: usize) -> Option<u8> {
    src.as_bytes().get(p).copied()
}

pub fn line_end(src: &str, from: usize) -> usize {
    match src[from..].find('\n') {
        Some(rel) => from + rel,
        None => src.len(),
    }
}

/// `word` is lowercase ASCII letters; the timeline and journey grammars are case-insensitive.
pub fn keyword_at(src: &str, p: usize, word: &str) -> bool {
    let bytes = src.as_bytes();
    let end = p + word.len();
    end <= bytes.len() && bytes[p..end].eq_ignore_ascii_case(word.as_bytes())
}

/// Skips comments and whitespace, stopping at a line break that starts a token (`NEWLINE`).
pub fn skip_trivia(src: &str, from: usize) -> usize {
    let n = src.len();
    let mut p = from;
    while p < n {
        let b = src.as_bytes()[p];
        if b == b'%' && byte_at(src, p + 1) != Some(b'{') {
            p = line_end(src, p);
        } else if b == b'\n' {
            return p;
        } else if b == b'#' {
            p = line_end(src, p);
        } else if let Some(ch) = char_at(src, p)
            && is_space_char(ch)
        {
            p += ch.len_utf8();
            while let Some(next) = char_at(src, p)
                && is_space_char(next)
            {
                p += next.len_utf8();
            }
        } else {
            return p;
        }
    }
    p
}

pub fn skip_space(src: &str, from: usize) -> usize {
    let mut p = from;
    while let Some(ch) = char_at(src, p)
        && is_space_char(ch)
    {
        p += ch.len_utf8();
    }
    p
}

/// Strips `prefix_bytes` followed by a single UTF-8 character (matching JS `substring(prefix + 1)`).
pub fn strip_keyword_sep(text: &str, prefix_bytes: usize) -> &str {
    let Some(rest) = text.get(prefix_bytes..) else {
        return "";
    };
    match rest.chars().next() {
        Some(ch) => &rest[ch.len_utf8()..],
        None => "",
    }
}

/// Accessibility token kinds emitted by `scan_accessibility`.
#[derive(Clone, Copy)]
pub struct AccKinds<T: Copy> {
    pub acc_title: T,
    pub acc_title_value: T,
    pub acc_descr: T,
    pub acc_descr_value: T,
    pub acc_descr_multiline_value: T,
}

/// Lexes an `accTitle` or `accDescr` statement at `p`, returning the new byte offset or `p` if none.
pub fn scan_accessibility<T: Copy>(src: &str, p: usize, out: &mut ScanTokens<T>, kinds: AccKinds<T>) -> usize {
    let descr = keyword_at(src, p, "accdescr");
    if !descr && !keyword_at(src, p, "acctitle") {
        return p;
    }
    let n = src.len();
    let mut q = skip_space(src, p + 8);
    let c = byte_at(src, q);
    if c == Some(b':') {
        q = skip_space(src, q + 1);
        let end = line_end(src, q);
        out.push(if descr { kinds.acc_descr } else { kinds.acc_title }, &src[p..q], p);
        out.push(if descr { kinds.acc_descr_value } else { kinds.acc_title_value }, &src[q..end], q);
        return end;
    }
    if !descr || c != Some(b'{') {
        return p;
    }
    q = skip_space(src, q + 1);
    while byte_at(src, q) != Some(b'}') {
        let end = src[q..].find('}').map_or(n, |rel| q + rel);
        out.push(kinds.acc_descr_multiline_value, &src[q..end], q);
        if q == n {
            return n;
        }
        q = end;
    }
    q + 1
}

/// Matches JS `text.replace(/^\s+/g, '')`.
pub fn trim_leading_ws(text: &str) -> String {
    text.trim_start_matches(is_space_char).to_string()
}

/// Matches JS `text.replace(/\n\s+/g, '\n')`.
pub fn collapse_newline_ws(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        out.push(ch);
        if ch == '\n' {
            while chars.peek().is_some_and(|&c| is_space_char(c)) {
                chars.next();
            }
        }
    }
    out
}
