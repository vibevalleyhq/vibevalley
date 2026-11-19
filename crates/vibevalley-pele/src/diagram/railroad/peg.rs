use crate::detect::DiagramType;
use crate::diagram::common::{TokenReader, TokenStream, acc_descr_value, acc_title_value, scan_keyword, scan_string, title_value};
use crate::error::{PeleError, SourceMap, syntax_error};

use super::common::{
    ParsedGrammar, choice, nonterminal, optional, repetition, scan_rr_acc_descr, scan_rr_acc_title, scan_rr_hidden, scan_rr_id, scan_rr_title, sequence,
    special, terminal, unescape, unquote_title,
};
use super::types::{RailroadNode, RailroadRule};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tok {
    Keyword,
    Arrow,
    Semicolon,
    Slash,
    And,
    Not,
    Question,
    Star,
    Plus,
    Group,
    GroupEnd,
    Dot,
    Title,
    AccTitle,
    AccDescr,
    Id,
    String,
}

fn tok_name(tok: Tok) -> &'static str {
    match tok {
        Tok::Keyword => "railroad-peg-beta",
        Tok::Arrow => "<-",
        Tok::Semicolon => ";",
        Tok::Slash => "/",
        Tok::And => "&",
        Tok::Not => "!",
        Tok::Question => "?",
        Tok::Star => "*",
        Tok::Plus => "+",
        Tok::Group => "(",
        Tok::GroupEnd => ")",
        Tok::Dot => ".",
        Tok::Title => "TITLE",
        Tok::AccTitle => "ACC_TITLE",
        Tok::AccDescr => "ACC_DESCR",
        Tok::Id => "PEG_ID",
        Tok::String => "PEG_STRING",
    }
}

fn tokenize<'a>(src: &'a str, origin: Option<&'a SourceMap<'a>>) -> Result<TokenStream<'a, Tok>, PeleError> {
    let mut kinds: Vec<Option<Tok>> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    let mut ends: Vec<usize> = Vec::new();

    let mut unclosed_descr = usize::MAX;
    let mut dead_yaml = false;
    let mut dead_dir = false;

    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut p = 0usize;

    while p < n {
        let b = bytes[p];
        if b == b'r'
            && let Some(kw_end) = scan_keyword(src, p, "railroad-peg-beta")
        {
            let id_end = scan_rr_id(src, p).unwrap_or(0);
            let (tok, end) = if id_end > kw_end { (Tok::Id, id_end) } else { (Tok::Keyword, kw_end) };
            kinds.push(Some(tok));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        if b == b'<' && bytes.get(p + 1) == Some(&b'-') {
            kinds.push(Some(Tok::Arrow));
            starts.push(p);
            ends.push(p + 2);
            p += 2;
            continue;
        }
        let single = match b {
            b';' => Some(Tok::Semicolon),
            b'/' => Some(Tok::Slash),
            b'&' => Some(Tok::And),
            b'!' => Some(Tok::Not),
            b'?' => Some(Tok::Question),
            b'*' => Some(Tok::Star),
            b'+' => Some(Tok::Plus),
            b'(' => Some(Tok::Group),
            b')' => Some(Tok::GroupEnd),
            b'.' => Some(Tok::Dot),
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
        if b == b'#' {
            p += 1;
            while p < n && !matches!(bytes[p], b'\n' | b'\r') {
                p += 1;
            }
            continue;
        }
        return Err(syntax_error(DiagramType::Railroad, src, p, "", true, origin));
    }

    kinds.push(None);
    starts.push(n);
    ends.push(n);
    Ok(TokenStream { kinds, starts, ends, src })
}

fn predicate_label(node: &RailroadNode) -> String {
    match node {
        RailroadNode::Terminal(v) => format!("\"{v}\""),
        RailroadNode::NonTerminal(name) => name.clone(),
        RailroadNode::Special(text) => text.clone(),
        RailroadNode::Sequence(_) | RailroadNode::Choice(_) | RailroadNode::Optional(_) | RailroadNode::Repetition { .. } => "(...)".to_string(),
    }
}

struct Frame<'a> {
    alternatives: Vec<RailroadNode>,
    elements: Vec<RailroadNode>,
    operator: Option<&'a str>,
}

impl<'a> Frame<'a> {
    fn new(operator: Option<&'a str>) -> Self {
        Self {
            alternatives: Vec::new(),
            elements: Vec::new(),
            operator,
        }
    }

    fn flush_sequence(&mut self) {
        let seq = sequence(std::mem::take(&mut self.elements));
        self.alternatives.push(seq);
    }

    fn finish(mut self) -> RailroadNode {
        self.flush_sequence();
        choice(self.alternatives)
    }
}

fn definition(r: &mut TokenReader<'_, Tok>) -> Result<RailroadNode, PeleError> {
    let mut stack: Vec<Frame<'_>> = Vec::new();
    let mut top = Frame::new(None);

    loop {
        let mut operator = if matches!(r.kind(), Some(Tok::And | Tok::Not)) {
            Some(r.take())
        } else {
            None
        };
        let mut primary = match r.kind() {
            Some(Tok::String) => terminal(unescape(r.take())),
            Some(Tok::Id) => nonterminal(r.take().to_string()),
            Some(Tok::Dot) => special(r.take().to_string()),
            Some(Tok::Group) => {
                r.i += 1;
                stack.push(top);
                top = Frame::new(operator);
                continue;
            }
            _ => return Err(r.fail("a literal, a name, a dot, or an opening parenthesis")),
        };

        loop {
            let suffixed = match r.kind() {
                Some(Tok::Question) => {
                    r.i += 1;
                    optional(primary)
                }
                Some(Tok::Star) => {
                    r.i += 1;
                    repetition(primary, 0.0, f64::INFINITY)
                }
                Some(Tok::Plus) => {
                    r.i += 1;
                    repetition(primary, 1.0, f64::INFINITY)
                }
                _ => primary,
            };
            let prefixed = match operator {
                Some(op) => special(format!("{op}{}", predicate_label(&suffixed))),
                None => suffixed,
            };
            top.elements.push(prefixed);

            if r.kind() == Some(Tok::GroupEnd) && !stack.is_empty() {
                r.i += 1;
                operator = top.operator;
                primary = top.finish();
                top = stack.pop().unwrap();
                continue;
            }
            match r.kind() {
                Some(Tok::Slash) => {
                    r.i += 1;
                    top.flush_sequence();
                }
                Some(Tok::And | Tok::Not | Tok::String | Tok::Id | Tok::Dot | Tok::Group) => {}
                _ => {
                    if stack.is_empty() {
                        return Ok(top.finish());
                    }
                    return Err(r.fail("token of type ')'"));
                }
            }
            break;
        }
    }
}

pub fn parse_peg(src: &str, origin: Option<&SourceMap<'_>>) -> Result<ParsedGrammar, PeleError> {
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
        r.expect(Tok::Arrow)?;
        let def = definition(&mut r)?;
        r.expect(Tok::Semicolon)?;
        out.rules.push(RailroadRule { name, definition: def });
    }
    Ok(out)
}
