use crate::detect::DiagramType;
use crate::diagram::common::{TokenReader, TokenStream, acc_descr_value, acc_title_value, scan_keyword, scan_string, title_value};
use crate::error::{PeleError, SourceMap, syntax_error};

use super::common::{
    ParsedGrammar, choice, nonterminal, optional, repetition, scan_block_comment, scan_rr_acc_descr, scan_rr_acc_title, scan_rr_hidden, scan_rr_id,
    scan_rr_title, sequence, special, terminal, unescape, unquote_title,
};
use super::types::{RailroadNode, RailroadRule};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tok {
    Keyword,
    Nonterminal,
    ZeroOrMore,
    OneOrMore,
    Sequence,
    Optional,
    Terminal,
    Special,
    Choice,
    Equals,
    Semicolon,
    Open,
    Comma,
    Close,
    Title,
    AccTitle,
    AccDescr,
    Id,
    String,
}

fn tok_name(tok: Tok) -> &'static str {
    match tok {
        Tok::Keyword => "railroad-beta",
        Tok::Nonterminal => "nonterminal",
        Tok::ZeroOrMore => "zeroOrMore",
        Tok::OneOrMore => "oneOrMore",
        Tok::Sequence => "sequence",
        Tok::Optional => "optional",
        Tok::Terminal => "terminal",
        Tok::Special => "special",
        Tok::Choice => "choice",
        Tok::Equals => "=",
        Tok::Semicolon => ";",
        Tok::Open => "(",
        Tok::Comma => ",",
        Tok::Close => ")",
        Tok::Title => "TITLE",
        Tok::AccTitle => "ACC_TITLE",
        Tok::AccDescr => "ACC_DESCR",
        Tok::Id => "RR_ID",
        Tok::String => "RR_STRING",
    }
}

const KEYWORDS: [(&str, Tok); 8] = [
    ("nonterminal", Tok::Nonterminal),
    ("zeroOrMore", Tok::ZeroOrMore),
    ("oneOrMore", Tok::OneOrMore),
    ("sequence", Tok::Sequence),
    ("optional", Tok::Optional),
    ("terminal", Tok::Terminal),
    ("special", Tok::Special),
    ("choice", Tok::Choice),
];

fn tokenize<'a>(src: &'a str, origin: Option<&'a SourceMap<'a>>) -> Result<TokenStream<'a, Tok>, PeleError> {
    let mut kinds: Vec<Option<Tok>> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    let mut ends: Vec<usize> = Vec::new();

    let mut unclosed_descr = usize::MAX;
    let mut dead_yaml = false;
    let mut dead_dir = false;
    let mut dead_block = false;

    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut p = 0usize;

    while p < n {
        let b = bytes[p];
        if b == b'r'
            && let Some(kw_end) = scan_keyword(src, p, "railroad-beta")
        {
            let id_end = scan_rr_id(src, p).unwrap_or(0);
            let (tok, end) = if id_end > kw_end { (Tok::Id, id_end) } else { (Tok::Keyword, kw_end) };
            kinds.push(Some(tok));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        let mut matched_kw = false;
        for &(word, tok) in &KEYWORDS {
            if b == word.as_bytes()[0] && src[p..].starts_with(word) {
                let w_end = p + word.len();
                let id_end = scan_rr_id(src, p).unwrap_or(0);
                let (actual_tok, actual_end) = if id_end > w_end { (Tok::Id, id_end) } else { (tok, w_end) };
                kinds.push(Some(actual_tok));
                starts.push(p);
                ends.push(actual_end);
                p = actual_end;
                matched_kw = true;
                break;
            }
        }
        if matched_kw {
            continue;
        }
        let single = match b {
            b'=' => Some(Tok::Equals),
            b';' => Some(Tok::Semicolon),
            b'(' => Some(Tok::Open),
            b',' => Some(Tok::Comma),
            b')' => Some(Tok::Close),
            _ => None,
        };
        if let Some(tok) = single {
            kinds.push(Some(tok));
            starts.push(p);
            ends.push(p + 1);
            p += 1;
            continue;
        }
        if b == b't'
            && let Some(end) = scan_rr_title(src, p, true)
        {
            kinds.push(Some(Tok::Title));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        if b == b'a' {
            if let Some(end) = scan_rr_acc_title(src, p) {
                kinds.push(Some(Tok::AccTitle));
                starts.push(p);
                ends.push(end);
                p = end;
                continue;
            }
            if let Some(end) = scan_rr_acc_descr(src, p, &mut unclosed_descr) {
                kinds.push(Some(Tok::AccDescr));
                starts.push(p);
                ends.push(end);
                p = end;
                continue;
            }
        }
        if (b.is_ascii_alphabetic() || b == b'_')
            && let Some(end) = scan_rr_id(src, p)
        {
            kinds.push(Some(Tok::Id));
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
        if let Some(end) = scan_rr_hidden(src, p, &mut dead_yaml, &mut dead_dir) {
            p = end;
            continue;
        }
        if b == b'/'
            && let Some(end) = scan_block_comment(src, p, &mut dead_block)
        {
            p = end;
            continue;
        }
        return Err(syntax_error(DiagramType::Railroad, src, p, "", true, origin));
    }

    kinds.push(None);
    starts.push(n);
    ends.push(n);
    Ok(TokenStream { kinds, starts, ends, src })
}

fn argument(r: &mut TokenReader<'_, Tok>) -> Result<String, PeleError> {
    r.i += 1;
    r.expect(Tok::Open)?;
    let val = unescape(r.expect(Tok::String)?);
    r.expect(Tok::Close)?;
    Ok(val)
}

enum OpenFrame {
    Sequence(Vec<RailroadNode>),
    Choice(Vec<RailroadNode>),
    Optional,
    OneOrMore,
    ZeroOrMore,
}

fn expression(r: &mut TokenReader<'_, Tok>) -> Result<RailroadNode, PeleError> {
    let mut open: Vec<OpenFrame> = Vec::new();
    loop {
        let mut value = match r.kind() {
            Some(Tok::Terminal) => terminal(argument(r)?),
            Some(Tok::Nonterminal) => nonterminal(argument(r)?),
            Some(Tok::Special) => special(argument(r)?),
            Some(Tok::Sequence) => {
                r.i += 1;
                r.expect(Tok::Open)?;
                open.push(OpenFrame::Sequence(Vec::new()));
                continue;
            }
            Some(Tok::Choice) => {
                r.i += 1;
                r.expect(Tok::Open)?;
                open.push(OpenFrame::Choice(Vec::new()));
                continue;
            }
            Some(Tok::Optional) => {
                r.i += 1;
                r.expect(Tok::Open)?;
                open.push(OpenFrame::Optional);
                continue;
            }
            Some(Tok::OneOrMore) => {
                r.i += 1;
                r.expect(Tok::Open)?;
                open.push(OpenFrame::OneOrMore);
                continue;
            }
            Some(Tok::ZeroOrMore) => {
                r.i += 1;
                r.expect(Tok::Open)?;
                open.push(OpenFrame::ZeroOrMore);
                continue;
            }
            _ => return Err(r.fail("an expression")),
        };

        loop {
            let Some(frame) = open.last_mut() else {
                return Ok(value);
            };
            match frame {
                OpenFrame::Sequence(elems) | OpenFrame::Choice(elems) => {
                    elems.push(value);
                    if r.accept(Tok::Comma) {
                        break;
                    }
                    r.expect(Tok::Close)?;
                    let finished = open.pop().unwrap();
                    value = match finished {
                        OpenFrame::Sequence(list) => sequence(list),
                        OpenFrame::Choice(list) => choice(list),
                        OpenFrame::Optional | OpenFrame::OneOrMore | OpenFrame::ZeroOrMore => unreachable!(),
                    };
                }
                OpenFrame::Optional | OpenFrame::OneOrMore | OpenFrame::ZeroOrMore => {
                    r.expect(Tok::Close)?;
                    value = match open.pop().unwrap() {
                        OpenFrame::Optional => optional(value),
                        OpenFrame::OneOrMore => repetition(value, 1.0, f64::INFINITY),
                        OpenFrame::ZeroOrMore => repetition(value, 0.0, f64::INFINITY),
                        OpenFrame::Sequence(_) | OpenFrame::Choice(_) => unreachable!(),
                    };
                }
            }
        }
    }
}

pub fn parse_ir(src: &str, origin: Option<&SourceMap<'_>>) -> Result<ParsedGrammar, PeleError> {
    let tokens = tokenize(src, origin)?;
    let mut r = TokenReader::new(tokens, DiagramType::Railroad, origin, tok_name);
    let mut out = ParsedGrammar::default();

    r.expect(Tok::Keyword)?;
    loop {
        match r.kind() {
            Some(Tok::Title) => {
                let raw = title_value(r.take());
                out.title = Some(unquote_title(&raw, true));
            }
            Some(Tok::AccTitle) => out.acc_title = Some(acc_title_value(r.take())),
            Some(Tok::AccDescr) => out.acc_descr = Some(acc_descr_value(r.take())),
            _ => break,
        }
    }
    while r.kind().is_some() {
        let name = r.expect(Tok::Id)?.to_string();
        r.expect(Tok::Equals)?;
        let definition = expression(&mut r)?;
        r.expect(Tok::Semicolon)?;
        out.rules.push(RailroadRule { name, definition });
    }
    Ok(out)
}
