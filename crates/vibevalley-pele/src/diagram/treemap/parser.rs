use crate::detect::DiagramType;
use crate::diagram::common::{
    TokenReader, TokenStream, acc_descr_value, acc_title_value, scan_acc_descr, scan_acc_title, scan_newline, scan_whitespace, title_value,
};
use crate::error::{PeleError, SourceMap, syntax_error};
use crate::util::chars::{is_space_char, is_word};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tok {
    AccDescr,
    AccTitle,
    Title,
    Keyword,
    ClassDef,
    StyleSeparator,
    Separator,
    Comma,
    Indentation,
    Id,
    Number,
    String,
}

fn tok_name(tok: Tok) -> &'static str {
    match tok {
        Tok::AccDescr => "ACC_DESCR",
        Tok::AccTitle => "ACC_TITLE",
        Tok::Title => "TITLE",
        Tok::Keyword => "TREEMAP_KEYWORD",
        Tok::ClassDef => "CLASS_DEF",
        Tok::StyleSeparator => "STYLE_SEPARATOR",
        Tok::Separator => "SEPARATOR",
        Tok::Comma => "COMMA",
        Tok::Indentation => "INDENTATION",
        Tok::Id => "ID2",
        Tok::Number => "NUMBER2",
        Tok::String => "STRING2",
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum TreemapItemAst {
    Section { name: String, class_selector: Option<String> },
    Leaf { name: String, value: f64, class_selector: Option<String> },
}

#[derive(Debug, Clone, PartialEq)]
pub enum TreemapStatementAst {
    Row {
        indent: Option<usize>,
        item: TreemapItemAst,
    },
    ClassDef {
        indent: Option<usize>,
        class_name: String,
        style_text: Option<String>,
    },
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TreemapAst {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub rows: Vec<TreemapStatementAst>,
}

/// `titleBefore(\w)`: matches `[\t ]*title(?:[\t ][^\n\r]*?(?=%%)|[\t ][^\n\r]*|(?!\w))`.
fn scan_title_before_word(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut p = at;
    while p < bytes.len() && matches!(bytes[p], b' ' | b'\t') {
        p += 1;
    }
    if !src[p..].starts_with("title") {
        return None;
    }
    p += 5;
    if matches!(bytes.get(p), Some(b' ' | b'\t')) {
        p += 1;
        while p < bytes.len() && !matches!(bytes[p], b'\n' | b'\r') {
            if bytes[p] == b'%' && bytes.get(p + 1) == Some(&b'%') {
                break;
            }
            p += 1;
        }
        return Some(p);
    }
    if bytes.get(p).is_some_and(|&b| is_word(b as u32)) {
        return None;
    }
    Some(p)
}

/// Matches `/classDef\s+([a-zA-Z_][a-zA-Z0-9_]+)(?:\s+([^;\r\n]*))?(?:;)?/y`.
fn scan_class_def(src: &str, at: usize) -> Option<usize> {
    if !src[at..].starts_with("classDef") {
        return None;
    }
    let mut p = at + 8;
    let ws_start = p;
    while p < src.len() {
        let ch = src[p..].chars().next().unwrap();
        if is_space_char(ch) {
            p += ch.len_utf8();
        } else {
            break;
        }
    }
    if p == ws_start {
        return None;
    }
    let bytes = src.as_bytes();
    let first = *bytes.get(p)?;
    if !(first.is_ascii_alphabetic() || first == b'_') {
        return None;
    }
    let name_start = p;
    p += 1;
    while p < bytes.len() && is_word(bytes[p] as u32) {
        p += 1;
    }
    if p - name_start < 2 {
        return None;
    }
    let after_name = p;
    let mut ws2 = p;
    while ws2 < src.len() {
        let ch = src[ws2..].chars().next().unwrap();
        if is_space_char(ch) {
            ws2 += ch.len_utf8();
        } else {
            break;
        }
    }
    if ws2 > after_name {
        let mut s = ws2;
        while s < bytes.len() && !matches!(bytes[s], b';' | b'\r' | b'\n') {
            s += 1;
        }
        p = s;
    }
    if bytes.get(p) == Some(&b';') {
        p += 1;
    }
    Some(p)
}

fn parse_class_def_text(text: &str) -> (String, Option<String>) {
    let mut p = 8; // after "classDef"
    while p < text.len() && is_space_char(text[p..].chars().next().unwrap()) {
        p += text[p..].chars().next().unwrap().len_utf8();
    }
    let name_start = p;
    let bytes = text.as_bytes();
    while p < bytes.len() && is_word(bytes[p] as u32) {
        p += 1;
    }
    let class_name = text[name_start..p].to_string();
    let rest = text[p..].strip_suffix(';').unwrap_or(&text[p..]);
    let mut ws = 0;
    while ws < rest.len() {
        let ch = rest[ws..].chars().next().unwrap();
        if is_space_char(ch) {
            ws += ch.len_utf8();
        } else {
            break;
        }
    }
    let style_text = if ws > 0 && ws < rest.len() { Some(rest[ws..].to_string()) } else { None };
    (class_name, style_text)
}

fn scan_plain_string(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let quote = *bytes.get(at)?;
    if quote != b'"' && quote != b'\'' {
        return None;
    }
    let rel = src[at + 1..].find(quote as char)?;
    Some(at + 1 + rel + 1)
}

fn scan_id(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let first = *bytes.get(at)?;
    if !(first.is_ascii_alphabetic() || first == b'_') {
        return None;
    }
    let mut p = at + 1;
    while p < bytes.len() && is_word(bytes[p] as u32) {
        p += 1;
    }
    Some(p)
}

fn scan_number(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut p = at;
    while p < bytes.len() && (bytes[p].is_ascii_digit() || matches!(bytes[p], b'_' | b'.' | b',')) {
        p += 1;
    }
    (p > at).then_some(p)
}

/// Emulates JS `parseFloat(text.replace(/,/g, ''))`.
fn js_parse_float(raw: &str) -> f64 {
    let cleaned = raw.replace(',', "");
    let s = cleaned.trim_start();
    let bytes = s.as_bytes();
    let mut i = 0usize;
    if i < bytes.len() && matches!(bytes[i], b'+' | b'-') {
        i += 1;
    }
    let mut digits = false;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        digits = true;
        i += 1;
    }
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            digits = true;
            i += 1;
        }
    }
    if !digits {
        return f64::NAN;
    }
    s[..i].parse::<f64>().unwrap_or(f64::NAN)
}

fn tokenize<'a>(src: &'a str, origin: Option<&'a SourceMap<'a>>) -> Result<TokenStream<'a, Tok>, PeleError> {
    let mut kinds: Vec<Option<Tok>> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    let mut ends: Vec<usize> = Vec::new();

    let mut unclosed_descr = false;
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut p = 0usize;

    while p < n {
        let b = bytes[p];
        if matches!(b, b'\t' | b' ' | b'a') {
            if let Some(end) = scan_acc_descr(src, p, &mut unclosed_descr) {
                kinds.push(Some(Tok::AccDescr));
                starts.push(p);
                ends.push(end);
                p = end;
                continue;
            }
            if let Some(end) = scan_acc_title(src, p) {
                kinds.push(Some(Tok::AccTitle));
                starts.push(p);
                ends.push(end);
                p = end;
                continue;
            }
        }
        if matches!(b, b'\t' | b' ' | b't')
            && let Some(end) = scan_title_before_word(src, p)
        {
            kinds.push(Some(Tok::Title));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        if b == b't' {
            if src[p..].starts_with("treemap-beta") {
                let end = p + 12;
                kinds.push(Some(Tok::Keyword));
                starts.push(p);
                ends.push(end);
                p = end;
                continue;
            }
            if src[p..].starts_with("treemap") {
                let end = p + 7;
                kinds.push(Some(Tok::Keyword));
                starts.push(p);
                ends.push(end);
                p = end;
                continue;
            }
        }
        if b == b'c'
            && let Some(end) = scan_class_def(src, p)
        {
            kinds.push(Some(Tok::ClassDef));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        if b == b':' {
            if src[p..].starts_with(":::") {
                kinds.push(Some(Tok::StyleSeparator));
                starts.push(p);
                ends.push(p + 3);
                p += 3;
            } else {
                kinds.push(Some(Tok::Separator));
                starts.push(p);
                ends.push(p + 1);
                p += 1;
            }
            continue;
        }
        if b == b',' {
            kinds.push(Some(Tok::Comma));
            starts.push(p);
            ends.push(p + 1);
            p += 1;
            continue;
        }
        if matches!(b, b' ' | b'\t')
            && let Some(end) = scan_whitespace(src, p)
        {
            kinds.push(Some(Tok::Indentation));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        if b == b'%' && bytes.get(p + 1) == Some(&b'%') {
            p += 2;
            while p < n && bytes[p] != b'\n' {
                p += 1;
            }
            continue;
        }
        if matches!(b, b'\r' | b'\n')
            && let Some(end) = scan_newline(src, p)
        {
            p = end;
            continue;
        }
        if (b.is_ascii_alphabetic() || b == b'_')
            && let Some(end) = scan_id(src, p)
        {
            kinds.push(Some(Tok::Id));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        if (b.is_ascii_digit() || matches!(b, b'_' | b'.' | b','))
            && let Some(end) = scan_number(src, p)
        {
            kinds.push(Some(Tok::Number));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        if matches!(b, b'"' | b'\'')
            && let Some(end) = scan_plain_string(src, p)
        {
            kinds.push(Some(Tok::String));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        return Err(syntax_error(DiagramType::Treemap, src, p, "", true, origin));
    }

    kinds.push(None);
    starts.push(n);
    ends.push(n);
    Ok(TokenStream { kinds, starts, ends, src })
}

pub fn parse_treemap(src: &str, origin: Option<&SourceMap<'_>>) -> Result<TreemapAst, PeleError> {
    let tokens = tokenize(src, origin)?;
    let mut r = TokenReader::new(tokens, DiagramType::Treemap, origin, tok_name);
    let mut ast = TreemapAst::default();

    r.expect(Tok::Keyword)?;
    while let Some(kind) = r.kind() {
        match kind {
            Tok::AccDescr => {
                ast.acc_descr = Some(acc_descr_value(r.take()));
            }
            Tok::AccTitle => {
                ast.acc_title = Some(acc_title_value(r.take()));
            }
            Tok::Title => {
                ast.title = Some(title_value(r.take()));
            }
            Tok::Indentation | Tok::String | Tok::ClassDef => {
                let indent = if kind == Tok::Indentation { Some(r.take().len()) } else { None };
                if r.kind() == Some(Tok::ClassDef) {
                    let (class_name, style_text) = parse_class_def_text(r.take());
                    ast.rows.push(TreemapStatementAst::ClassDef {
                        indent,
                        class_name,
                        style_text,
                    });
                    continue;
                }
                let raw_str = r.expect(Tok::String)?;
                let name = raw_str[1..raw_str.len() - 1].to_string();
                let after = if r.tokens.kinds[r.i] == Some(Tok::Indentation) { r.i + 1 } else { r.i };
                let item = if matches!(r.tokens.kinds[after], Some(Tok::Separator | Tok::Comma)) {
                    r.i = after + 1;
                    r.accept(Tok::Indentation);
                    let value = js_parse_float(r.expect(Tok::Number)?);
                    let class_selector = if r.accept(Tok::StyleSeparator) {
                        Some(r.expect(Tok::Id)?.to_string())
                    } else {
                        None
                    };
                    TreemapItemAst::Leaf { name, value, class_selector }
                } else {
                    let class_selector = if r.accept(Tok::StyleSeparator) {
                        Some(r.expect(Tok::Id)?.to_string())
                    } else {
                        None
                    };
                    TreemapItemAst::Section { name, class_selector }
                };
                ast.rows.push(TreemapStatementAst::Row { indent, item });
            }
            Tok::Keyword | Tok::StyleSeparator | Tok::Separator | Tok::Comma | Tok::Id | Tok::Number => {
                return Err(r.fail("a node, a class definition, or a title"));
            }
        }
    }
    Ok(ast)
}
