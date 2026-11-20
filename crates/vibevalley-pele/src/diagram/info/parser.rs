use crate::detect::DiagramType;
use crate::diagram::common::{
    TokenReader, TokenStream, acc_descr_value, acc_title_value, scan_acc_descr, scan_acc_title, scan_directive, scan_keyword, scan_newline,
    scan_single_line_comment, scan_title, scan_whitespace, scan_yaml_block, title_value,
};
use crate::error::{PeleError, SourceMap, syntax_error};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tok {
    ShowInfo,
    Info,
    AccDescr,
    AccTitle,
    Title,
    Newline,
}

fn tok_name(tok: Tok) -> &'static str {
    match tok {
        Tok::ShowInfo => "showInfo",
        Tok::Info => "info",
        Tok::AccDescr => "ACC_DESCR",
        Tok::AccTitle => "ACC_TITLE",
        Tok::Title => "TITLE",
        Tok::Newline => "NEWLINE",
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InfoAst {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
}

fn tokenize<'a>(src: &'a str, origin: Option<&'a SourceMap<'a>>) -> Result<TokenStream<'a, Tok>, PeleError> {
    let mut kinds: Vec<Option<Tok>> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    let mut ends: Vec<usize> = Vec::new();

    let mut unclosed_descr = false;
    let mut dead_yaml = false;
    let mut dead_dir = false;

    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut p = 0usize;

    while p < n {
        let b = bytes[p];
        if b == b's'
            && let Some(end) = scan_keyword(src, p, "showInfo")
        {
            kinds.push(Some(Tok::ShowInfo));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        if b == b'i'
            && let Some(end) = scan_keyword(src, p, "info")
        {
            kinds.push(Some(Tok::Info));
            starts.push(p);
            ends.push(end);
            p = end;
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
            && let Some(end) = scan_title(src, p)
        {
            kinds.push(Some(Tok::Title));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        if matches!(b, b'\r' | b'\n')
            && let Some(end) = scan_newline(src, p)
        {
            kinds.push(Some(Tok::Newline));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        if matches!(b, b'\t' | b' ')
            && let Some(end) = scan_whitespace(src, p)
        {
            p = end;
            continue;
        }
        if b == b'-'
            && let Some(end) = scan_yaml_block(src, p, &mut dead_yaml)
        {
            p = end;
            continue;
        }
        if matches!(b, b'\t' | b' ' | b'%') {
            if let Some(end) = scan_directive(src, p, &mut dead_dir) {
                p = end;
                continue;
            }
            if let Some(end) = scan_single_line_comment(src, p) {
                p = end;
                continue;
            }
        }
        return Err(syntax_error(DiagramType::Info, src, p, "", true, origin));
    }

    kinds.push(None);
    starts.push(n);
    ends.push(n);
    Ok(TokenStream { kinds, starts, ends, src })
}

pub fn parse_info(src: &str, origin: Option<&SourceMap<'_>>) -> Result<InfoAst, PeleError> {
    let tokens = tokenize(src, origin)?;
    let mut r = TokenReader::new(tokens, DiagramType::Info, origin, tok_name);
    let mut ast = InfoAst::default();

    while r.kind() == Some(Tok::Newline) {
        r.i += 1;
    }
    r.expect(Tok::Info)?;
    while r.kind() == Some(Tok::Newline) {
        r.i += 1;
    }
    if r.accept(Tok::ShowInfo) {
        while r.kind() == Some(Tok::Newline) {
            r.i += 1;
        }
    }
    while let Some(kind) = r.kind() {
        match kind {
            Tok::AccDescr => ast.acc_descr = Some(acc_descr_value(r.take())),
            Tok::AccTitle => ast.acc_title = Some(acc_title_value(r.take())),
            Tok::Title => ast.title = Some(title_value(r.take())),
            Tok::ShowInfo | Tok::Info | Tok::Newline => return Err(r.fail("a title or the end of input")),
        }
        if r.kind().is_none() {
            break;
        }
        if r.kind() != Some(Tok::Newline) {
            return Err(r.fail("a line break or the end of input"));
        }
        while r.kind() == Some(Tok::Newline) {
            r.i += 1;
        }
    }
    Ok(ast)
}
