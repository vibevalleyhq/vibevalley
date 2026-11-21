use crate::detect::DiagramType;
use crate::error::{PeleError, SourceMap, syntax_error};

use super::db::{
    REL_CONTAINS, REL_COPIES, REL_DERIVES, REL_REFINES, REL_SATISFIES, REL_TRACES, REL_VERIFIES, REQ_TYPE_DESIGN_CONSTRAINT, REQ_TYPE_FUNCTIONAL,
    REQ_TYPE_INTERFACE, REQ_TYPE_PERFORMANCE, REQ_TYPE_PHYSICAL, REQ_TYPE_REQUIREMENT, RISK_HIGH, RISK_LOW, RISK_MEDIUM, RequirementDb, VERIFY_ANALYSIS,
    VERIFY_DEMONSTRATION, VERIFY_INSPECTION, VERIFY_TEST,
};
use super::lexer::{Tokens, tokenize};
use super::tokens::ReqToken;

fn is_style_part(t: ReqToken) -> bool {
    matches!(t, ReqToken::Alpha | ReqToken::Colon | ReqToken::Brkt | ReqToken::Minus | ReqToken::Semicolon)
}

fn req_type_value(t: ReqToken) -> Option<&'static str> {
    match t {
        ReqToken::Requirement => Some(REQ_TYPE_REQUIREMENT),
        ReqToken::FunctionalRequirement => Some(REQ_TYPE_FUNCTIONAL),
        ReqToken::InterfaceRequirement => Some(REQ_TYPE_INTERFACE),
        ReqToken::PerformanceRequirement => Some(REQ_TYPE_PERFORMANCE),
        ReqToken::PhysicalRequirement => Some(REQ_TYPE_PHYSICAL),
        ReqToken::DesignConstraint => Some(REQ_TYPE_DESIGN_CONSTRAINT),
        _ => None,
    }
}

fn risk_value(t: ReqToken) -> Option<&'static str> {
    match t {
        ReqToken::LowRisk => Some(RISK_LOW),
        ReqToken::MedRisk => Some(RISK_MEDIUM),
        ReqToken::HighRisk => Some(RISK_HIGH),
        _ => None,
    }
}

fn verify_value(t: ReqToken) -> Option<&'static str> {
    match t {
        ReqToken::VerifyAnalysis => Some(VERIFY_ANALYSIS),
        ReqToken::VerifyDemonstration => Some(VERIFY_DEMONSTRATION),
        ReqToken::VerifyInspection => Some(VERIFY_INSPECTION),
        ReqToken::VerifyTest => Some(VERIFY_TEST),
        _ => None,
    }
}

fn rel_value(t: ReqToken) -> Option<&'static str> {
    match t {
        ReqToken::Contains => Some(REL_CONTAINS),
        ReqToken::Copies => Some(REL_COPIES),
        ReqToken::Derives => Some(REL_DERIVES),
        ReqToken::Satisfies => Some(REL_SATISFIES),
        ReqToken::Verifies => Some(REL_VERIFIES),
        ReqToken::Refines => Some(REL_REFINES),
        ReqToken::Traces => Some(REL_TRACES),
        _ => None,
    }
}

struct Parser<'a> {
    src: &'a str,
    origin: Option<&'a SourceMap<'a>>,
    tokens: Tokens,
    i: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> ReqToken {
        self.tokens.types[self.i]
    }

    fn take_text(&mut self) -> String {
        let s = self.tokens.texts[self.i].clone();
        self.i += 1;
        s
    }

    fn fail(&self, expected: &[ReqToken]) -> PeleError {
        let t = self.peek();
        if t == ReqToken::Error {
            return syntax_error(DiagramType::Requirement, self.src, self.tokens.starts[self.i], "", true, self.origin);
        }
        let names: Vec<String> = expected.iter().map(|tok| format!("'{}'", tok.name())).collect();
        syntax_error(
            DiagramType::Requirement,
            self.src,
            self.tokens.starts[self.i],
            &format!("Expecting {}, got '{}'", names.join(", "), t.name()),
            false,
            self.origin,
        )
    }

    fn expect(&mut self, tok: ReqToken) -> Result<String, PeleError> {
        if self.peek() != tok {
            return Err(self.fail(&[tok]));
        }
        Ok(self.take_text())
    }

    fn string(&mut self) -> Result<String, PeleError> {
        let t = self.peek();
        if !matches!(t, ReqToken::UnqString | ReqToken::QString) {
            return Err(self.fail(&[ReqToken::QString, ReqToken::UnqString]));
        }
        Ok(self.take_text())
    }

    fn directive(&mut self, db: &mut RequirementDb) -> Result<bool, PeleError> {
        match self.peek() {
            ReqToken::AccTitle => {
                self.i += 1;
                let v = self.expect(ReqToken::AccTitleValue)?;
                db.set_acc_title(v.trim());
                Ok(true)
            }
            ReqToken::AccDescr => {
                self.i += 1;
                let v = self.expect(ReqToken::AccDescrValue)?;
                db.set_acc_description(v.trim());
                Ok(true)
            }
            ReqToken::AccDescrMultilineValue => {
                let v = self.take_text();
                db.set_acc_description(v.trim());
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    fn id_list(&mut self) -> Result<Vec<String>, PeleError> {
        let mut list = Vec::new();
        loop {
            let t = self.peek();
            if !matches!(t, ReqToken::Alpha | ReqToken::UnqString | ReqToken::QString) {
                return Err(self.fail(&[ReqToken::QString, ReqToken::UnqString, ReqToken::Alpha]));
            }
            list.push(self.take_text());
            if self.peek() != ReqToken::Comma {
                return Ok(list);
            }
            self.i += 1;
        }
    }

    fn styles_opt(&mut self) -> Result<Vec<String>, PeleError> {
        let mut styles = Vec::new();
        loop {
            if !is_style_part(self.peek()) {
                return Err(self.fail(&[ReqToken::Alpha, ReqToken::Colon, ReqToken::Semicolon, ReqToken::Minus, ReqToken::Brkt]));
            }
            let mut style = self.take_text();
            while is_style_part(self.peek()) {
                style.push_str(&self.take_text());
            }
            styles.push(style);
            if self.peek() != ReqToken::Comma {
                return Ok(styles);
            }
            self.i += 1;
        }
    }

    fn class_list(&mut self) -> Result<Option<Vec<String>>, PeleError> {
        let classes = match self.peek() {
            ReqToken::StyleSeparator => {
                self.i += 1;
                let list = self.id_list()?;
                self.expect(ReqToken::StructStart)?;
                Some(list)
            }
            ReqToken::StructStart => {
                self.i += 1;
                None
            }
            _ => return Err(self.fail(&[ReqToken::StructStart, ReqToken::StyleSeparator])),
        };
        self.expect(ReqToken::Newline)?;
        Ok(classes)
    }

    fn body(&mut self, requirement: bool, db: &mut RequirementDb) -> Result<(), PeleError> {
        #[derive(Clone, Copy)]
        enum FieldKind {
            Id,
            Text,
            Risk,
            VerifyMthd,
            Type,
            DocRef,
        }
        let mut fields: Vec<FieldKind> = Vec::new();
        let mut values: Vec<String> = Vec::new();
        loop {
            let t = self.peek();
            if t == ReqToken::StructStop {
                self.i += 1;
                break;
            }
            if t == ReqToken::Newline {
                self.i += 1;
                continue;
            }
            let kind = if requirement {
                match t {
                    ReqToken::Id => Some(FieldKind::Id),
                    ReqToken::Text => Some(FieldKind::Text),
                    ReqToken::Risk => Some(FieldKind::Risk),
                    ReqToken::VerifyMthd => Some(FieldKind::VerifyMthd),
                    _ => None,
                }
            } else {
                match t {
                    ReqToken::Type => Some(FieldKind::Type),
                    ReqToken::DocRef => Some(FieldKind::DocRef),
                    _ => None,
                }
            };
            let Some(kind) = kind else {
                if requirement {
                    return Err(self.fail(&[
                        ReqToken::Id,
                        ReqToken::Text,
                        ReqToken::Risk,
                        ReqToken::VerifyMthd,
                        ReqToken::Newline,
                        ReqToken::StructStop,
                    ]));
                }
                return Err(self.fail(&[ReqToken::Type, ReqToken::DocRef, ReqToken::Newline, ReqToken::StructStop]));
            };
            self.i += 1;
            self.expect(ReqToken::ColonSep)?;
            let val = match kind {
                FieldKind::Risk => {
                    let k = self.peek();
                    let Some(s) = risk_value(k) else {
                        return Err(self.fail(&[ReqToken::LowRisk, ReqToken::MedRisk, ReqToken::HighRisk]));
                    };
                    self.i += 1;
                    s.to_string()
                }
                FieldKind::VerifyMthd => {
                    let k = self.peek();
                    let Some(s) = verify_value(k) else {
                        return Err(self.fail(&[
                            ReqToken::VerifyAnalysis,
                            ReqToken::VerifyDemonstration,
                            ReqToken::VerifyInspection,
                            ReqToken::VerifyTest,
                        ]));
                    };
                    self.i += 1;
                    s.to_string()
                }
                FieldKind::Id | FieldKind::Text | FieldKind::Type | FieldKind::DocRef => self.string()?,
            };
            values.push(val);
            fields.push(kind);
            self.expect(ReqToken::Newline)?;
        }
        // Right-recursive grammar applies fields last to first so the first of repeated fields wins.
        for (field, value) in fields.into_iter().zip(values).rev() {
            match field {
                FieldKind::Id => db.set_new_req_id(value),
                FieldKind::Text => db.set_new_req_text(value),
                FieldKind::Risk => db.set_new_req_risk(value),
                FieldKind::VerifyMthd => db.set_new_req_verify_method(value),
                FieldKind::Type => db.set_new_element_type(value),
                FieldKind::DocRef => db.set_new_element_doc_ref(value),
            }
        }
        Ok(())
    }
}

pub fn parse_requirement(src: &str, db: &mut RequirementDb, origin: Option<&SourceMap<'_>>) -> Result<(), PeleError> {
    let mut p = Parser {
        src,
        origin,
        tokens: tokenize(src),
        i: 0,
    };

    while p.directive(db)? {
        if p.peek() == ReqToken::Newline {
            p.i += 1;
        }
    }
    if p.peek() != ReqToken::Rd {
        return Err(p.fail(&[ReqToken::Rd, ReqToken::AccTitle, ReqToken::AccDescr, ReqToken::AccDescrMultilineValue]));
    }
    p.i += 1;
    p.expect(ReqToken::Newline)?;

    loop {
        let t = p.peek();
        if t == ReqToken::Eof {
            return Ok(());
        }
        if t == ReqToken::Newline {
            p.i += 1;
        } else if p.directive(db)? {
            continue;
        } else if let Some(dir) = match t {
            ReqToken::DirectionTb => Some("TB"),
            ReqToken::DirectionBt => Some("BT"),
            ReqToken::DirectionRl => Some("RL"),
            ReqToken::DirectionLr => Some("LR"),
            _ => None,
        } {
            p.i += 1;
            db.set_direction(dir);
        } else if let Some(req_type) = req_type_value(t) {
            p.i += 1;
            let name = p.string()?;
            let classes = p.class_list()?;
            p.body(true, db)?;
            db.add_requirement(&name, req_type);
            if let Some(cls) = classes {
                db.set_class(&[name], &cls)?;
            }
        } else if t == ReqToken::Element {
            p.i += 1;
            let name = p.string()?;
            let classes = p.class_list()?;
            p.body(false, db)?;
            db.add_element(&name);
            if let Some(cls) = classes {
                db.set_class(&[name], &cls)?;
            }
        } else if t == ReqToken::Style {
            p.i += 1;
            let ids = p.id_list()?;
            let styles = p.styles_opt()?;
            db.set_css_style(&ids, &styles)?;
        } else if t == ReqToken::ClassDef {
            p.i += 1;
            let ids = p.id_list()?;
            let styles = p.styles_opt()?;
            db.define_class(&ids, &styles)?;
        } else if t == ReqToken::Class {
            p.i += 1;
            let ids = p.id_list()?;
            let classes = p.id_list()?;
            db.set_class(&ids, &classes)?;
        } else if matches!(t, ReqToken::UnqString | ReqToken::QString) {
            let id = p.take_text();
            let next = p.peek();
            if next == ReqToken::StyleSeparator {
                p.i += 1;
                let classes = p.id_list()?;
                db.set_class(&[id], &classes)?;
            } else if matches!(next, ReqToken::EndArrowL | ReqToken::Line) {
                p.i += 1;
                let rel_tok = p.peek();
                let Some(relationship) = rel_value(rel_tok) else {
                    return Err(p.fail(&[
                        ReqToken::Contains,
                        ReqToken::Copies,
                        ReqToken::Derives,
                        ReqToken::Satisfies,
                        ReqToken::Verifies,
                        ReqToken::Refines,
                        ReqToken::Traces,
                    ]));
                };
                p.i += 1;
                p.expect(if next == ReqToken::Line { ReqToken::EndArrowR } else { ReqToken::Line })?;
                let other = p.string()?;
                if next == ReqToken::Line {
                    db.add_relationship(relationship, &id, &other);
                } else {
                    db.add_relationship(relationship, &other, &id);
                }
            } else {
                return Err(p.fail(&[ReqToken::StyleSeparator, ReqToken::EndArrowL, ReqToken::Line]));
            }
        } else {
            return Err(p.fail(&[
                ReqToken::Newline,
                ReqToken::Eof,
                ReqToken::AccTitle,
                ReqToken::AccDescr,
                ReqToken::AccDescrMultilineValue,
                ReqToken::DirectionTb,
                ReqToken::DirectionBt,
                ReqToken::DirectionRl,
                ReqToken::DirectionLr,
                ReqToken::Requirement,
                ReqToken::FunctionalRequirement,
                ReqToken::InterfaceRequirement,
                ReqToken::PerformanceRequirement,
                ReqToken::PhysicalRequirement,
                ReqToken::DesignConstraint,
                ReqToken::Element,
                ReqToken::ClassDef,
                ReqToken::Class,
                ReqToken::Style,
                ReqToken::UnqString,
                ReqToken::QString,
            ]));
        }
    }
}
