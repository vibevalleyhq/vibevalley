use crate::detect::DiagramType;
use crate::diagram::common::{TokenReader, TokenStream, acc_descr_value, acc_title_value, scan_keyword, title_value};
use crate::error::{PeleError, SourceMap, syntax_error};
use crate::util::chars::is_hex;

use super::common::{
    ParsedGrammar, choice, nonterminal, optional, repetition, scan_rr_acc_descr, scan_rr_acc_title, scan_rr_hidden, scan_rr_title, sequence, terminal,
    unquote_title,
};
use super::types::{RailroadNode, RailroadRule};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tok {
    Keyword,
    Equals,
    Semicolon,
    Slash,
    Group,
    GroupEnd,
    Option,
    OptionEnd,
    Title,
    AccTitle,
    AccDescr,
    Name,
    String,
    Number,
    Repeat,
    Exact,
}

fn tok_name(tok: Tok) -> &'static str {
    match tok {
        Tok::Keyword => "railroad-abnf-beta",
        Tok::Equals => "=",
        Tok::Semicolon => ";",
        Tok::Slash => "/",
        Tok::Group => "(",
        Tok::GroupEnd => ")",
        Tok::Option => "[",
        Tok::OptionEnd => "]",
        Tok::Title => "TITLE",
        Tok::AccTitle => "ACC_TITLE",
        Tok::AccDescr => "ACC_DESCR",
        Tok::Name => "ABNF_RULENAME",
        Tok::String => "ABNF_STRING",
        Tok::Number => "ABNF_NUMVAL",
        Tok::Repeat => "ABNF_REPEAT",
        Tok::Exact => "ABNF_EXACT_REPEAT",
    }
}

fn scan_abnf_name(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    if !bytes.get(at)?.is_ascii_alphabetic() {
        return None;
    }
    let mut p = at + 1;
    while p < bytes.len() && (bytes[p].is_ascii_alphanumeric() || bytes[p] == b'-') {
        p += 1;
    }
    Some(p)
}

fn scan_abnf_string(src: &str, at: usize) -> Option<usize> {
    if src.as_bytes().get(at) != Some(&b'"') {
        return None;
    }
    let rel = src[at + 1..].find('"')?;
    Some(at + 1 + rel + 1)
}

/// Scans `/%[xXdDbB][0-9A-Fa-f]+(?:-[0-9A-Fa-f]+|\.[0-9A-Fa-f]+)*/y`.
fn scan_abnf_numval(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    if bytes.get(at) != Some(&b'%') {
        return None;
    }
    if !matches!(bytes.get(at + 1), Some(b'x' | b'X' | b'd' | b'D' | b'b' | b'B')) {
        return None;
    }
    let mut p = at + 2;
    let first_start = p;
    while p < bytes.len() && is_hex(bytes[p] as u32) {
        p += 1;
    }
    if p == first_start {
        return None;
    }
    while p < bytes.len() && matches!(bytes[p], b'-' | b'.') {
        let mut q = p + 1;
        while q < bytes.len() && is_hex(bytes[q] as u32) {
            q += 1;
        }
        if q == p + 1 {
            break;
        }
        p = q;
    }
    Some(p)
}

fn scan_abnf_comment(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    if bytes.get(at) != Some(&b';') {
        return None;
    }
    let mut p = at + 1;
    while p < bytes.len() && !matches!(bytes[p], b'\n' | b'\r') {
        p += 1;
    }
    Some(p)
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
            && let Some(kw_end) = scan_keyword(src, p, "railroad-abnf-beta")
        {
            let name_end = scan_abnf_name(src, p).unwrap_or(0);
            let (tok, end) = if name_end > kw_end { (Tok::Name, name_end) } else { (Tok::Keyword, kw_end) };
            kinds.push(Some(tok));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        if b == b';' {
            // Semicolon closes a rule only at end of line; with anything after it, it is a hidden comment.
            if let Some(end) = scan_abnf_comment(src, p)
                && end > p + 1
            {
                p = end;
                continue;
            }
            kinds.push(Some(Tok::Semicolon));
            starts.push(p);
            ends.push(p + 1);
            p += 1;
            continue;
        }
        let single = match b {
            b'=' => Some(Tok::Equals),
            b'/' => Some(Tok::Slash),
            b'(' => Some(Tok::Group),
            b')' => Some(Tok::GroupEnd),
            b'[' => Some(Tok::Option),
            b']' => Some(Tok::OptionEnd),
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
            && let Some(end) = scan_rr_title(src, p, false)
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
        if b.is_ascii_alphabetic()
            && let Some(end) = scan_abnf_name(src, p)
        {
            kinds.push(Some(Tok::Name));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        if b == b'"'
            && let Some(end) = scan_abnf_string(src, p)
        {
            kinds.push(Some(Tok::String));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        if b == b'%'
            && let Some(end) = scan_abnf_numval(src, p)
        {
            kinds.push(Some(Tok::Number));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        if b.is_ascii_digit() || b == b'*' {
            let mut q = p;
            while q < n && bytes[q].is_ascii_digit() {
                q += 1;
            }
            if bytes.get(q) == Some(&b'*') {
                q += 1;
                while q < n && bytes[q].is_ascii_digit() {
                    q += 1;
                }
                kinds.push(Some(Tok::Repeat));
                starts.push(p);
                ends.push(q);
                p = q;
                continue;
            }
            if q > p {
                kinds.push(Some(Tok::Exact));
                starts.push(p);
                ends.push(q);
                p = q;
                continue;
            }
        }
        if let Some(end) = scan_rr_hidden(src, p, &mut dead_yaml, &mut dead_dir) {
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

fn apply_repeat(node: RailroadNode, repeat: Option<&str>) -> RailroadNode {
    let Some(rep) = repeat else {
        return node;
    };
    if rep.is_empty() {
        return node;
    }
    let (min, max) = match rep.find('*') {
        None => {
            let n = rep.parse::<f64>().unwrap_or(f64::INFINITY);
            (n, n)
        }
        Some(star) => {
            let min = if star > 0 { rep[..star].parse::<f64>().unwrap_or(f64::INFINITY) } else { 0.0 };
            let max = if star + 1 < rep.len() {
                rep[star + 1..].parse::<f64>().unwrap_or(f64::INFINITY)
            } else {
                f64::INFINITY
            };
            (min, max)
        }
    };
    if min == 0.0 && max == 1.0 {
        optional(node)
    } else {
        repetition(node, min, max)
    }
}

struct Frame<'a> {
    alternatives: Vec<RailroadNode>,
    elements: Vec<RailroadNode>,
    bracket: Option<(bool, Tok)>, // (is_optional, close_tok)
    repeat: Option<&'a str>,
}

impl<'a> Frame<'a> {
    fn new(bracket: Option<(bool, Tok)>, repeat: Option<&'a str>) -> Self {
        Self {
            alternatives: Vec::new(),
            elements: Vec::new(),
            bracket,
            repeat,
        }
    }

    fn flush_concat(&mut self) {
        let seq = sequence(std::mem::take(&mut self.elements));
        self.alternatives.push(seq);
    }

    fn finish(mut self) -> RailroadNode {
        self.flush_concat();
        let inner = choice(self.alternatives);
        match self.bracket {
            Some((true, _)) => optional(inner),
            _ => inner,
        }
    }
}

fn alternation(r: &mut TokenReader<'_, Tok>) -> Result<RailroadNode, PeleError> {
    let mut stack: Vec<Frame<'_>> = Vec::new();
    let mut top = Frame::new(None, None);

    loop {
        let mut repeat = if matches!(r.kind(), Some(Tok::Repeat | Tok::Exact)) {
            Some(r.take())
        } else {
            None
        };
        let mut primary = match r.kind() {
            Some(Tok::String) => {
                let s = r.take();
                terminal(s[1..s.len() - 1].to_string())
            }
            Some(Tok::Number) => terminal(r.take().to_string()),
            Some(Tok::Name) => nonterminal(r.take().to_string()),
            Some(Tok::Group) => {
                r.i += 1;
                stack.push(top);
                top = Frame::new(Some((false, Tok::GroupEnd)), repeat);
                continue;
            }
            Some(Tok::Option) => {
                r.i += 1;
                stack.push(top);
                top = Frame::new(Some((true, Tok::OptionEnd)), repeat);
                continue;
            }
            _ => return Err(r.fail("a string, a number, a name, or an opening bracket")),
        };

        loop {
            top.elements.push(apply_repeat(primary, repeat));
            if let Some((_, close_tok)) = top.bracket
                && r.kind() == Some(close_tok)
            {
                r.i += 1;
                repeat = top.repeat;
                primary = top.finish();
                top = stack.pop().unwrap();
                continue;
            }
            match r.kind() {
                Some(Tok::Slash) => {
                    r.i += 1;
                    top.flush_concat();
                }
                Some(Tok::String | Tok::Number | Tok::Name | Tok::Group | Tok::Option | Tok::Repeat | Tok::Exact) => {}
                _ => {
                    if stack.is_empty() {
                        return Ok(top.finish());
                    }
                    let close_tok = top.bracket.unwrap().1;
                    return Err(r.fail(&format!("token of type '{}'", tok_name(close_tok))));
                }
            }
            break;
        }
    }
}

pub fn parse_abnf(src: &str, origin: Option<&SourceMap<'_>>) -> Result<ParsedGrammar, PeleError> {
    let tokens = tokenize(src, origin)?;
    let mut r = TokenReader::new(tokens, DiagramType::Railroad, origin, tok_name);
    let mut out = ParsedGrammar::default();

    r.expect(Tok::Keyword)?;
    loop {
        match r.kind() {
            Some(Tok::Title) => {
                let raw = title_value(r.take());
                out.title = Some(unquote_title(&raw, false));
            }
            Some(Tok::AccTitle) => out.acc_title = Some(acc_title_value(r.take())),
            Some(Tok::AccDescr) => out.acc_descr = Some(acc_descr_value(r.take())),
            _ => break,
        }
    }
    while r.kind().is_some() {
        let name = r.expect(Tok::Name)?.to_string();
        r.expect(Tok::Equals)?;
        let def = alternation(&mut r)?;
        r.expect(Tok::Semicolon)?;
        out.rules.push(RailroadRule { name, definition: def });
    }
    Ok(out)
}
