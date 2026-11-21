use crate::detect::DiagramType;
use crate::diagram::common::{
    TokenReader, TokenStream, acc_descr_value, acc_title_value, scan_acc_descr, scan_acc_title, scan_directive, scan_keyword, scan_newline,
    scan_single_line_comment, scan_string, scan_title, scan_whitespace, scan_yaml_block, string_value, title_value,
};
use crate::error::{PeleError, SourceMap, syntax_error};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum DomainName {
    Chaotic,
    Clear,
    Complex,
    Complicated,
    Confusion,
}

impl DomainName {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Complex => "complex",
            Self::Complicated => "complicated",
            Self::Clear => "clear",
            Self::Chaotic => "chaotic",
            Self::Confusion => "confusion",
        }
    }

    pub fn from_name(s: &str) -> Option<Self> {
        match s {
            "complex" => Some(Self::Complex),
            "complicated" => Some(Self::Complicated),
            "clear" => Some(Self::Clear),
            "chaotic" => Some(Self::Chaotic),
            "confusion" => Some(Self::Confusion),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tok {
    KeywordColon,
    Keyword,
    Arrow,
    Colon,
    Domain,
    AccDescr,
    AccTitle,
    Title,
    String,
    Newline,
}

fn tok_name(tok: Tok) -> &'static str {
    match tok {
        Tok::KeywordColon => "cynefin-beta:",
        Tok::Keyword => "cynefin-beta",
        Tok::Arrow => "-->",
        Tok::Colon => ":",
        Tok::Domain => "DOMAIN_NAME",
        Tok::AccDescr => "ACC_DESCR",
        Tok::AccTitle => "ACC_TITLE",
        Tok::Title => "TITLE",
        Tok::String => "STRING",
        Tok::Newline => "NEWLINE",
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DomainBlockAst {
    pub domain: DomainName,
    pub items: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransitionAst {
    pub from: DomainName,
    pub to: DomainName,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CynefinAst {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub domains: Vec<DomainBlockAst>,
    pub transitions: Vec<TransitionAst>,
}

fn scan_domain(src: &str, at: usize) -> Option<usize> {
    let rest = &src[at..];
    // Order matches `/complex|complicated|clear|chaotic|confusion/y`.
    for word in ["complex", "complicated", "clear", "chaotic", "confusion"] {
        if rest.starts_with(word) {
            return Some(at + word.len());
        }
    }
    None
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
        if b == b'c' {
            if src[p..].starts_with("cynefin-beta:") {
                let end = p + 13;
                kinds.push(Some(Tok::KeywordColon));
                starts.push(p);
                ends.push(end);
                p = end;
                continue;
            }
            if let Some(end) = scan_keyword(src, p, "cynefin-beta") {
                kinds.push(Some(Tok::Keyword));
                starts.push(p);
                ends.push(end);
                p = end;
                continue;
            }
            if let Some(end) = scan_domain(src, p) {
                kinds.push(Some(Tok::Domain));
                starts.push(p);
                ends.push(end);
                p = end;
                continue;
            }
        }
        if b == b'-' && src[p..].starts_with("-->") {
            kinds.push(Some(Tok::Arrow));
            starts.push(p);
            ends.push(p + 3);
            p += 3;
            continue;
        }
        if b == b':' {
            kinds.push(Some(Tok::Colon));
            starts.push(p);
            ends.push(p + 1);
            p += 1;
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
        if matches!(b, b'"' | b'\'')
            && let Some(end) = scan_string(src, p)
        {
            kinds.push(Some(Tok::String));
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
        return Err(syntax_error(DiagramType::Cynefin, src, p, "", true, origin));
    }

    kinds.push(None);
    starts.push(n);
    ends.push(n);
    Ok(TokenStream { kinds, starts, ends, src })
}

fn skip_lines(r: &mut TokenReader<'_, Tok>) {
    while r.kind() == Some(Tok::Newline) {
        r.i += 1;
    }
}

fn end_of_line(r: &mut TokenReader<'_, Tok>) -> Result<(), PeleError> {
    if r.kind().is_none() {
        return Ok(());
    }
    if r.kind() != Some(Tok::Newline) {
        return Err(r.fail("a line break or the end of input"));
    }
    skip_lines(r);
    Ok(())
}

pub fn parse_cynefin(src: &str, origin: Option<&SourceMap<'_>>) -> Result<CynefinAst, PeleError> {
    let tokens = tokenize(src, origin)?;
    let mut r = TokenReader::new(tokens, DiagramType::Cynefin, origin, tok_name);
    let mut ast = CynefinAst::default();

    skip_lines(&mut r);
    if !matches!(r.kind(), Some(Tok::Keyword | Tok::KeywordColon)) {
        return Err(r.fail("'cynefin-beta'"));
    }
    r.i += 1;

    while let Some(kind) = r.kind() {
        match kind {
            Tok::Newline => {
                r.i += 1;
            }
            Tok::AccDescr => {
                ast.acc_descr = Some(acc_descr_value(r.take()));
                end_of_line(&mut r)?;
            }
            Tok::AccTitle => {
                ast.acc_title = Some(acc_title_value(r.take()));
                end_of_line(&mut r)?;
            }
            Tok::Title => {
                ast.title = Some(title_value(r.take()));
                end_of_line(&mut r)?;
            }
            Tok::Domain => {
                let name = DomainName::from_name(r.take()).unwrap();
                if r.accept(Tok::Arrow) {
                    let to = DomainName::from_name(r.expect(Tok::Domain)?).unwrap();
                    let label = if r.accept(Tok::Colon) {
                        Some(string_value(r.expect(Tok::String)?))
                    } else {
                        None
                    };
                    end_of_line(&mut r)?;
                    ast.transitions.push(TransitionAst { from: name, to, label });
                } else {
                    let mut items = Vec::new();
                    skip_lines(&mut r);
                    while r.kind() == Some(Tok::String) {
                        items.push(string_value(r.take()));
                        skip_lines(&mut r);
                    }
                    ast.domains.push(DomainBlockAst { domain: name, items });
                }
            }
            Tok::KeywordColon | Tok::Keyword | Tok::Arrow | Tok::Colon | Tok::String => {
                return Err(r.fail("a domain, a transition, a title, or a line break"));
            }
        }
    }
    Ok(ast)
}
