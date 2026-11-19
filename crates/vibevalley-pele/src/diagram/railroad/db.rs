use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError, SourceMap};

use super::abnf::parse_abnf;
use super::common::ParsedGrammar;
use super::ebnf::parse_ebnf;
use super::ir::parse_ir;
use super::peg::parse_peg;
use super::types::{Notation, RailroadModel};

/// Detects railroad notation case-insensitively, matching Mermaid's four detectors.
pub fn notation_of(source: &str) -> Option<Notation> {
    let s = source.trim_start();
    if s.len() < 13 || !s.as_bytes()[..9].eq_ignore_ascii_case(b"railroad-") {
        return None;
    }
    let rest = &s[9..];
    if rest.len() >= 4 && rest.as_bytes()[..4].eq_ignore_ascii_case(b"beta") {
        return Some(Notation::Railroad);
    }
    if rest.len() >= 9 && rest.as_bytes()[..9].eq_ignore_ascii_case(b"ebnf-beta") {
        return Some(Notation::Ebnf);
    }
    if rest.len() >= 9 && rest.as_bytes()[..9].eq_ignore_ascii_case(b"abnf-beta") {
        return Some(Notation::Abnf);
    }
    if rest.len() >= 8 && rest.as_bytes()[..8].eq_ignore_ascii_case(b"peg-beta") {
        return Some(Notation::Peg);
    }
    None
}

pub fn parse_grammar_for(source: &str, notation: Notation, origin: Option<&SourceMap<'_>>) -> Result<ParsedGrammar, PeleError> {
    match notation {
        Notation::Railroad => parse_ir(source, origin),
        Notation::Ebnf => parse_ebnf(source, origin),
        Notation::Abnf => parse_abnf(source, origin),
        Notation::Peg => parse_peg(source, origin),
    }
}

pub fn parse_railroad(source: &str, title: Option<&str>, origin: Option<&SourceMap<'_>>) -> Result<RailroadModel, PeleError> {
    let Some(notation) = notation_of(source) else {
        return Err(PeleError::new("No railroad diagram keyword found.", ErrorCode::Syntax).with_diagram_type(DiagramType::Railroad));
    };
    let parsed = parse_grammar_for(source, notation, origin)?;
    Ok(RailroadModel {
        notation,
        title: parsed.title.filter(|s| !s.is_empty()).or_else(|| title.map(str::to_string)),
        acc_title: crate::diagram::info::model::trim_acc_title(parsed.acc_title),
        acc_descr: crate::diagram::info::model::trim_acc_descr(parsed.acc_descr),
        rules: parsed.rules,
    })
}
