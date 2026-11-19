use crate::detect::DiagramType;
use crate::diagram::common::{
    TokenReader, TokenStream, acc_descr_value, acc_title_value, scan_acc_descr, scan_acc_title, scan_directive, scan_keyword, scan_newline,
    scan_single_line_comment, scan_string, scan_title, scan_whitespace, scan_yaml_block, string_value, title_value,
};
use crate::error::{PeleError, SourceMap, syntax_error};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tok {
    PacketBeta,
    Packet,
    Dash,
    Plus,
    Colon,
    AccDescr,
    AccTitle,
    Title,
    Int,
    String,
    Newline,
}

fn tok_name(tok: Tok) -> &'static str {
    match tok {
        Tok::PacketBeta => "packet-beta",
        Tok::Packet => "packet",
        Tok::Dash => "-",
        Tok::Plus => "+",
        Tok::Colon => ":",
        Tok::AccDescr => "ACC_DESCR",
        Tok::AccTitle => "ACC_TITLE",
        Tok::Title => "TITLE",
        Tok::Int => "INT",
        Tok::String => "STRING",
        Tok::Newline => "NEWLINE",
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PacketBlockAst {
    pub start: Option<f64>,
    pub end: Option<f64>,
    pub bits: Option<f64>,
    pub label: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PacketAst {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub blocks: Vec<PacketBlockAst>,
}

/// Matches `/0|[1-9][0-9]*(?!\.)/y` verbatim.
fn scan_int(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let first = *bytes.get(at)?;
    if first == b'0' {
        return Some(at + 1);
    }
    if !(b'1'..=b'9').contains(&first) {
        return None;
    }
    let mut end = at + 1;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    if bytes.get(end) == Some(&b'.') {
        if end > at + 1 { Some(end - 1) } else { None }
    } else {
        Some(end)
    }
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
        if b == b'p' {
            if src[p..].starts_with("packet-beta") {
                let end = p + 11;
                kinds.push(Some(Tok::PacketBeta));
                starts.push(p);
                ends.push(end);
                p = end;
                continue;
            }
            if let Some(end) = scan_keyword(src, p, "packet") {
                kinds.push(Some(Tok::Packet));
                starts.push(p);
                ends.push(end);
                p = end;
                continue;
            }
        }
        if b == b'-' {
            // Front matter starts with dashes, so YAML wins as LONGER_ALT over '-'.
            if let Some(end) = scan_yaml_block(src, p, &mut dead_yaml)
                && end > p + 1
            {
                p = end;
                continue;
            }
            kinds.push(Some(Tok::Dash));
            starts.push(p);
            ends.push(p + 1);
            p += 1;
            continue;
        }
        if b == b'+' {
            kinds.push(Some(Tok::Plus));
            starts.push(p);
            ends.push(p + 1);
            p += 1;
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
        if b.is_ascii_digit()
            && let Some(end) = scan_int(src, p)
        {
            kinds.push(Some(Tok::Int));
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
        return Err(syntax_error(DiagramType::Packet, src, p, "", true, origin));
    }

    kinds.push(None);
    starts.push(n);
    ends.push(n);
    Ok(TokenStream { kinds, starts, ends, src })
}

fn end_of_line(r: &mut TokenReader<'_, Tok>) -> Result<(), PeleError> {
    if r.kind().is_none() {
        return Ok(());
    }
    if r.kind() != Some(Tok::Newline) {
        return Err(r.fail("a line break or the end of input"));
    }
    while r.kind() == Some(Tok::Newline) {
        r.i += 1;
    }
    Ok(())
}

pub fn parse_packet(src: &str, origin: Option<&SourceMap<'_>>) -> Result<PacketAst, PeleError> {
    let tokens = tokenize(src, origin)?;
    let mut r = TokenReader::new(tokens, DiagramType::Packet, origin, tok_name);
    let mut ast = PacketAst::default();

    while r.kind() == Some(Tok::Newline) {
        r.i += 1;
    }
    if !r.accept(Tok::PacketBeta) {
        r.expect(Tok::Packet)?;
    }
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
            Tok::Int | Tok::Plus => {
                let mut block = PacketBlockAst::default();
                if r.accept(Tok::Plus) {
                    block.bits = Some(r.expect(Tok::Int)?.parse::<f64>().unwrap_or(f64::INFINITY));
                } else {
                    block.start = Some(r.take().parse::<f64>().unwrap_or(f64::INFINITY));
                    if r.accept(Tok::Dash) {
                        block.end = Some(r.expect(Tok::Int)?.parse::<f64>().unwrap_or(f64::INFINITY));
                    }
                }
                r.expect(Tok::Colon)?;
                block.label = string_value(r.expect(Tok::String)?);
                ast.blocks.push(block);
                end_of_line(&mut r)?;
            }
            Tok::PacketBeta | Tok::Packet | Tok::Dash | Tok::Colon | Tok::String => {
                return Err(r.fail("a field, a title, or a line break"));
            }
        }
    }
    Ok(ast)
}
