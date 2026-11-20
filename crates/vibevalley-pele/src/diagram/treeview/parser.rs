use crate::detect::DiagramType;
use crate::diagram::common::{
    TokenReader, TokenStream, acc_descr_value, acc_title_value, scan_acc_descr, scan_acc_title, scan_keyword, scan_newline, scan_whitespace, title_value,
};
use crate::error::{PeleError, SourceMap, syntax_error};
use crate::util::chars::{is_blank, is_word};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tok {
    Keyword,
    AccDescr,
    AccTitle,
    Title,
    ClassAnnotation,
    IconAnnotation,
    DescAnnotation,
    Indentation,
    QuotedName,
    BareName,
}

fn tok_name(tok: Tok) -> &'static str {
    match tok {
        Tok::Keyword => "treeView-beta",
        Tok::AccDescr => "ACC_DESCR",
        Tok::AccTitle => "ACC_TITLE",
        Tok::Title => "TITLE",
        Tok::ClassAnnotation => "CLASS_ANNOTATION",
        Tok::IconAnnotation => "ICON_ANNOTATION",
        Tok::DescAnnotation => "DESC_ANNOTATION",
        Tok::Indentation => "INDENTATION",
        Tok::QuotedName => "QUOTED_NAME",
        Tok::BareName => "BARE_NAME",
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeNodeAst {
    pub indent: Option<usize>,
    pub name: String,
    pub class_annotation: Option<String>,
    pub icon_annotation: Option<String>,
    pub desc_annotation: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TreeViewAst {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub nodes: Vec<TreeNodeAst>,
}

fn annotation_at(src: &str, at: usize) -> bool {
    let rest = &src[at..];
    if rest.starts_with("##") || rest.starts_with("icon(") {
        return true;
    }
    if !rest.starts_with(":::") {
        return false;
    }
    let bytes = src.as_bytes();
    let mut i = at + 3;
    while i < bytes.len() && is_blank(bytes[i] as u32) {
        i += 1;
    }
    bytes.get(i).is_some_and(|&c| c.is_ascii_alphabetic() || c == b'_')
}

fn match_bare_name(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let first = *bytes.get(at)?;
    if is_blank(first as u32) || matches!(first, b'\n' | b'\r' | b'"' | b'\'') {
        return None;
    }
    let rest = &src[at..];
    if rest.starts_with(":::") || rest.starts_with("icon(") || rest.starts_with("##") {
        return None;
    }
    let n = bytes.len();
    let mut i = at + 1;
    while i < n {
        let c = bytes[i];
        if c == b'\n' || c == b'\r' {
            break;
        }
        if is_blank(c as u32) {
            let mut j = i + 1;
            while j < n && is_blank(bytes[j] as u32) {
                j += 1;
            }
            if annotation_at(src, j) {
                break;
            }
            i = j;
        } else {
            i += 1;
        }
    }
    Some(i)
}

/// `titleBefore((?!%%)[^\n\r])`: matches `title` + rest of line, or bare `title` only before `\n`, `\r`, `%%`, or EOF.
fn scan_treeview_title(src: &str, at: usize) -> Option<usize> {
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
    if p == bytes.len() || matches!(bytes[p], b'\n' | b'\r') || (bytes[p] == b'%' && bytes.get(p + 1) == Some(&b'%')) {
        Some(p)
    } else {
        None
    }
}

fn scan_class_annotation(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut p = at;
    while p < bytes.len() && is_blank(bytes[p] as u32) {
        p += 1;
    }
    if p == at || !src[p..].starts_with(":::") {
        return None;
    }
    p += 3;
    while p < bytes.len() && is_blank(bytes[p] as u32) {
        p += 1;
    }
    let first = *bytes.get(p)?;
    if !(first.is_ascii_alphabetic() || first == b'_') {
        return None;
    }
    p += 1;
    while p < bytes.len() && (is_word(bytes[p] as u32) || bytes[p] == b'-') {
        p += 1;
    }
    Some(p)
}

fn scan_icon_annotation(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut p = at;
    while p < bytes.len() && is_blank(bytes[p] as u32) {
        p += 1;
    }
    if p == at || !src[p..].starts_with("icon(") {
        return None;
    }
    p += 5;
    while p < bytes.len() && (is_word(bytes[p] as u32) || bytes[p] == b'-') {
        p += 1;
    }
    if bytes.get(p) == Some(&b':') {
        p += 1;
        let seg = p;
        while p < bytes.len() && (is_word(bytes[p] as u32) || bytes[p] == b'-') {
            p += 1;
        }
        if p == seg {
            return None;
        }
    }
    if bytes.get(p) == Some(&b')') { Some(p + 1) } else { None }
}

fn scan_desc_annotation(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut p = at;
    while p < bytes.len() && is_blank(bytes[p] as u32) {
        p += 1;
    }
    if p == at || !src[p..].starts_with("##") {
        return None;
    }
    p += 2;
    while p < bytes.len() && !matches!(bytes[p], b'\n' | b'\r') {
        p += 1;
    }
    Some(p)
}

fn scan_quoted_name(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let quote = *bytes.get(at)?;
    if quote != b'"' && quote != b'\'' {
        return None;
    }
    let rel = src[at + 1..].find(quote as char)?;
    Some(at + 1 + rel + 1)
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
        if b == b't'
            && let Some(kw_end) = scan_keyword(src, p, "treeView-beta")
        {
            if let Some(bare_end) = match_bare_name(src, p)
                && bare_end > kw_end
            {
                kinds.push(Some(Tok::BareName));
                starts.push(p);
                ends.push(bare_end);
                p = bare_end;
                continue;
            }
            kinds.push(Some(Tok::Keyword));
            starts.push(p);
            ends.push(kw_end);
            p = kw_end;
            continue;
        }
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
            && let Some(end) = scan_treeview_title(src, p)
        {
            kinds.push(Some(Tok::Title));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        if matches!(b, b' ' | b'\t') {
            if let Some(end) = scan_class_annotation(src, p) {
                kinds.push(Some(Tok::ClassAnnotation));
                starts.push(p);
                ends.push(end);
                p = end;
                continue;
            }
            if let Some(end) = scan_icon_annotation(src, p) {
                kinds.push(Some(Tok::IconAnnotation));
                starts.push(p);
                ends.push(end);
                p = end;
                continue;
            }
            if let Some(end) = scan_desc_annotation(src, p) {
                kinds.push(Some(Tok::DescAnnotation));
                starts.push(p);
                ends.push(end);
                p = end;
                continue;
            }
            if let Some(end) = scan_whitespace(src, p) {
                kinds.push(Some(Tok::Indentation));
                starts.push(p);
                ends.push(end);
                p = end;
                continue;
            }
        }
        if matches!(b, b'"' | b'\'')
            && let Some(end) = scan_quoted_name(src, p)
        {
            kinds.push(Some(Tok::QuotedName));
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
        if let Some(end) = match_bare_name(src, p) {
            kinds.push(Some(Tok::BareName));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        return Err(syntax_error(DiagramType::TreeView, src, p, "", true, origin));
    }

    kinds.push(None);
    starts.push(n);
    ends.push(n);
    Ok(TokenStream { kinds, starts, ends, src })
}

pub fn trim_blanks_end(text: &str) -> &str {
    text.trim_end_matches([' ', '\t'])
}

pub fn parse_tree_view(src: &str, origin: Option<&SourceMap<'_>>) -> Result<TreeViewAst, PeleError> {
    let tokens = tokenize(src, origin)?;
    let mut r = TokenReader::new(tokens, DiagramType::TreeView, origin, tok_name);
    let mut ast = TreeViewAst::default();

    r.expect(Tok::Keyword)?;
    loop {
        match r.kind() {
            Some(Tok::AccDescr) => ast.acc_descr = Some(acc_descr_value(r.take())),
            Some(Tok::AccTitle) => ast.acc_title = Some(acc_title_value(r.take())),
            Some(Tok::Title) => ast.title = Some(title_value(r.take())),
            _ => break,
        }
    }

    while r.kind().is_some() {
        let indent = if r.kind() == Some(Tok::Indentation) { Some(r.take().len()) } else { None };
        let name = match r.kind() {
            Some(Tok::QuotedName) => {
                let s = r.take();
                s[1..s.len() - 1].to_string()
            }
            Some(Tok::BareName) => trim_blanks_end(r.take()).to_string(),
            _ => return Err(r.fail("a name")),
        };
        let mut class_annotation = None;
        let mut icon_annotation = None;
        let mut desc_annotation = None;
        loop {
            match r.kind() {
                Some(Tok::ClassAnnotation) => {
                    class_annotation = Some(r.take().trim()[3..].trim().to_string());
                }
                Some(Tok::IconAnnotation) => {
                    let trimmed = r.take().trim();
                    icon_annotation = Some(trimmed[5..trimmed.len() - 1].to_string());
                }
                Some(Tok::DescAnnotation) => {
                    desc_annotation = Some(r.take().trim()[2..].trim().to_string());
                }
                _ => break,
            }
        }
        ast.nodes.push(TreeNodeAst {
            indent,
            name,
            class_annotation,
            icon_annotation,
            desc_annotation,
        });
    }
    Ok(ast)
}
