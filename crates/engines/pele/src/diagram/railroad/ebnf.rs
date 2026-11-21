use crate::detect::DiagramType;
use crate::diagram::common::{TokenReader, TokenStream, acc_descr_value, acc_title_value, scan_keyword, scan_string, scan_yaml_block, title_value};
use crate::error::{PeleError, SourceMap, syntax_error};
use crate::util::chars::is_space_char;

use super::common::{
    ParsedGrammar, choice, nonterminal, optional, repetition, scan_block_comment, scan_rr_acc_descr, scan_rr_acc_title, scan_rr_hidden, scan_rr_id,
    scan_rr_title, sequence, special, terminal, unescape, unquote_title,
};
use super::types::{RailroadNode, RailroadRule};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tok {
    Keyword,
    Defines,
    Equals,
    Semicolon,
    Bar,
    Comma,
    Group,
    GroupEnd,
    Option,
    OptionEnd,
    Repeat,
    RepeatEnd,
    Question,
    Star,
    Plus,
    Minus,
    Title,
    AccTitle,
    AccDescr,
    Id,
    String,
    Special,
}

fn tok_name(tok: Tok) -> &'static str {
    match tok {
        Tok::Keyword => "railroad-ebnf-beta",
        Tok::Defines => "::=",
        Tok::Equals => "=",
        Tok::Semicolon => ";",
        Tok::Bar => "|",
        Tok::Comma => ",",
        Tok::Group => "(",
        Tok::GroupEnd => ")",
        Tok::Option => "[",
        Tok::OptionEnd => "]",
        Tok::Repeat => "{",
        Tok::RepeatEnd => "}",
        Tok::Question => "?",
        Tok::Star => "*",
        Tok::Plus => "+",
        Tok::Minus => "-",
        Tok::Title => "TITLE",
        Tok::AccTitle => "ACC_TITLE",
        Tok::AccDescr => "ACC_DESCR",
        Tok::Id => "EBNF_ID",
        Tok::String => "EBNF_STRING",
        Tok::Special => "EBNF_SPECIAL_SEQUENCE",
    }
}

/// Scans `? ... ?` containing at least one non-space char and no `?` or `;`.
fn scan_special_sequence(src: &str, at: usize) -> Option<usize> {
    if src.as_bytes().get(at) != Some(&b'?') {
        return None;
    }
    let mut solid = false;
    let mut i = at + 1;
    while i < src.len() {
        let ch = src[i..].chars().next().unwrap();
        if ch == '?' {
            return solid.then_some(i + 1);
        }
        if ch == ';' {
            return None;
        }
        if !is_space_char(ch) {
            solid = true;
        }
        i += ch.len_utf8();
    }
    None
}

fn scan_iso_comment(src: &str, at: usize, dead: &mut bool) -> Option<usize> {
    if *dead || !src[at..].starts_with("(*") {
        return None;
    }
    match src[at + 2..].find("*)") {
        Some(rel) => Some(at + 2 + rel + 2),
        None => {
            *dead = true;
            None
        }
    }
}

fn tokenize<'a>(src: &'a str, origin: Option<&'a SourceMap<'a>>) -> Result<TokenStream<'a, Tok>, PeleError> {
    let mut kinds: Vec<Option<Tok>> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    let mut ends: Vec<usize> = Vec::new();

    let mut unclosed_descr = usize::MAX;
    let mut dead_yaml = false;
    let mut dead_dir = false;
    let mut dead_block = false;
    let mut dead_iso = false;

    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut p = 0usize;

    while p < n {
        let b = bytes[p];
        if b == b'r'
            && let Some(kw_end) = scan_keyword(src, p, "railroad-ebnf-beta")
        {
            let id_end = scan_rr_id(src, p).unwrap_or(0);
            let (tok, end) = if id_end > kw_end { (Tok::Id, id_end) } else { (Tok::Keyword, kw_end) };
            kinds.push(Some(tok));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        if b == b':' && src[p..].starts_with("::=") {
            kinds.push(Some(Tok::Defines));
            starts.push(p);
            ends.push(p + 3);
            p += 3;
            continue;
        }
        if b == b'(' {
            if let Some(end) = scan_iso_comment(src, p, &mut dead_iso)
                && end > p + 1
            {
                p = end;
                continue;
            }
            kinds.push(Some(Tok::Group));
            starts.push(p);
            ends.push(p + 1);
            p += 1;
            continue;
        }
        if b == b'?' {
            if let Some(end) = scan_special_sequence(src, p)
                && end > p + 1
            {
                kinds.push(Some(Tok::Special));
                starts.push(p);
                ends.push(end);
                p = end;
                continue;
            }
            kinds.push(Some(Tok::Question));
            starts.push(p);
            ends.push(p + 1);
            p += 1;
            continue;
        }
        if b == b'-' {
            if let Some(end) = scan_yaml_block(src, p, &mut dead_yaml)
                && end > p + 1
            {
                p = end;
                continue;
            }
            kinds.push(Some(Tok::Minus));
            starts.push(p);
            ends.push(p + 1);
            p += 1;
            continue;
        }
        let single = match b {
            b'=' => Some(Tok::Equals),
            b';' => Some(Tok::Semicolon),
            b'|' => Some(Tok::Bar),
            b',' => Some(Tok::Comma),
            b')' => Some(Tok::GroupEnd),
            b'[' => Some(Tok::Option),
            b']' => Some(Tok::OptionEnd),
            b'{' => Some(Tok::Repeat),
            b'}' => Some(Tok::RepeatEnd),
            b'*' => Some(Tok::Star),
            b'+' => Some(Tok::Plus),
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BracketKind {
    Group,
    Optional,
    Repetition,
}

struct Frame {
    alternatives: Vec<RailroadNode>,
    elements: Vec<RailroadNode>,
    term: Option<RailroadNode>,
    bracket: Option<(BracketKind, Tok)>,
    except: bool,
}

impl Frame {
    fn new(bracket: Option<(BracketKind, Tok)>, except: bool) -> Self {
        Self {
            alternatives: Vec::new(),
            elements: Vec::new(),
            term: None,
            bracket,
            except,
        }
    }

    fn flush_term(&mut self) {
        if let Some(t) = self.term.take() {
            self.elements.push(t);
        }
    }

    fn flush_sequence(&mut self) {
        self.flush_term();
        let seq = sequence(std::mem::take(&mut self.elements));
        self.alternatives.push(seq);
    }

    fn finish(mut self) -> RailroadNode {
        self.flush_sequence();
        let inner = choice(self.alternatives);
        match self.bracket {
            None | Some((BracketKind::Group, _)) => inner,
            Some((BracketKind::Optional, _)) => optional(inner),
            Some((BracketKind::Repetition, _)) => repetition(inner, 0.0, f64::INFINITY),
        }
    }
}

fn definition(r: &mut TokenReader<'_, Tok>) -> Result<RailroadNode, PeleError> {
    let mut stack: Vec<Frame> = Vec::new();
    let mut top = Frame::new(None, false);
    let mut except = false;

    loop {
        let mut primary = match r.kind() {
            Some(Tok::String) => terminal(unescape(r.take())),
            Some(Tok::Id) => nonterminal(r.take().to_string()),
            Some(Tok::Special) => {
                let raw = r.take();
                special(raw[1..raw.len() - 1].trim().to_string())
            }
            Some(Tok::Group) => {
                r.i += 1;
                stack.push(top);
                top = Frame::new(Some((BracketKind::Group, Tok::GroupEnd)), except);
                except = false;
                continue;
            }
            Some(Tok::Option) => {
                r.i += 1;
                stack.push(top);
                top = Frame::new(Some((BracketKind::Optional, Tok::OptionEnd)), except);
                except = false;
                continue;
            }
            Some(Tok::Repeat) => {
                r.i += 1;
                stack.push(top);
                top = Frame::new(Some((BracketKind::Repetition, Tok::RepeatEnd)), except);
                except = false;
                continue;
            }
            _ => return Err(r.fail("a terminal, a name, or an opening bracket")),
        };

        loop {
            if except {
                let prev = top.term.take().unwrap();
                top.term = Some(RailroadNode::Sequence(vec![prev, terminal("-".to_string()), primary]));
                except = false;
            } else {
                top.flush_term();
                top.term = Some(primary);
            }

            loop {
                match r.kind() {
                    Some(Tok::Question) => {
                        r.i += 1;
                        let t = top.term.take().unwrap();
                        top.term = Some(optional(t));
                    }
                    Some(Tok::Star) => {
                        r.i += 1;
                        let t = top.term.take().unwrap();
                        top.term = Some(repetition(t, 0.0, f64::INFINITY));
                    }
                    Some(Tok::Plus) => {
                        r.i += 1;
                        let t = top.term.take().unwrap();
                        top.term = Some(repetition(t, 1.0, f64::INFINITY));
                    }
                    _ => break,
                }
            }

            if let Some((_, close_tok)) = top.bracket
                && r.kind() == Some(close_tok)
            {
                r.i += 1;
                let was_except = top.except;
                primary = top.finish();
                except = was_except;
                top = stack.pop().unwrap();
                continue;
            }

            match r.kind() {
                Some(Tok::Minus) => {
                    r.i += 1;
                    except = true;
                }
                Some(Tok::Comma) => {
                    r.i += 1;
                }
                Some(Tok::Bar) => {
                    r.i += 1;
                    top.flush_sequence();
                }
                Some(Tok::String | Tok::Id | Tok::Special | Tok::Group | Tok::Option | Tok::Repeat) => {}
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

pub fn parse_ebnf(src: &str, origin: Option<&SourceMap<'_>>) -> Result<ParsedGrammar, PeleError> {
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
        if !r.accept(Tok::Equals) {
            r.expect(Tok::Defines)?;
        }
        let def = definition(&mut r)?;
        r.expect(Tok::Semicolon)?;
        out.rules.push(RailroadRule { name, definition: def });
    }
    Ok(out)
}
