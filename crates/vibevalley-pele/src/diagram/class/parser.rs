use crate::detect::DiagramType;
use crate::error::{PeleError, SourceMap, syntax_error};
use crate::util::chars::is_space_char;

use super::db::ClassDb;
use super::lexer::{Tokens, tokenize};
use super::tokens::Tok;
use super::types::{ClassRelation, LineType, RelationEnd, RelationSpec};

const NAME_TOKENS: &str = "'UNICODE_TEXT', 'NUM', 'ALPHA', 'MINUS', 'BQUOTE_STR'";

struct Frame {
    id: String,
    classes: Vec<String>,
    notes: Vec<String>,
}

struct Parser<'a> {
    src: &'a str,
    origin: Option<&'a SourceMap<'a>>,
    tokens: Tokens,
    i: usize,
}

impl<'a> Parser<'a> {
    fn new(src: &'a str, origin: Option<&'a SourceMap<'a>>) -> Self {
        Self {
            src,
            origin,
            tokens: tokenize(src),
            i: 0,
        }
    }

    fn tok(&self) -> Tok {
        self.tokens.types[self.i]
    }

    fn text(&self) -> &str {
        &self.tokens.texts[self.i]
    }

    fn take(&mut self) -> String {
        let s = self.tokens.texts[self.i].clone();
        self.i += 1;
        s
    }

    fn fail(&self, expected: &str) -> PeleError {
        let t = self.tok();
        if t == Tok::Error {
            return syntax_error(DiagramType::Class, self.src, self.tokens.starts[self.i], "", true, self.origin);
        }
        syntax_error(
            DiagramType::Class,
            self.src,
            self.tokens.starts[self.i],
            &format!("Expecting {expected}, got '{}'", t.name()),
            false,
            self.origin,
        )
    }

    fn expect(&mut self, expected: Tok) -> Result<String, PeleError> {
        if self.tok() != expected {
            return Err(self.fail(&format!("'{}'", expected.name())));
        }
        Ok(self.take())
    }

    fn alpha_num(&mut self) -> Result<String, PeleError> {
        if !self.tok().is_alphanum() {
            return Err(self.fail("'UNICODE_TEXT', 'NUM', 'ALPHA', 'MINUS'"));
        }
        Ok(self.take())
    }

    fn name(&mut self, generic: bool) -> Result<String, PeleError> {
        let mut out = String::new();
        loop {
            if self.tok() == Tok::BquoteStr {
                out.push_str(&self.take());
                break;
            }
            if !self.tok().is_alphanum() {
                return Err(self.fail(NAME_TOKENS));
            }
            out.push_str(&self.take());
            let t = self.tok();
            if t == Tok::Dot {
                out.push('.');
                self.i += 1;
            } else if !t.is_alphanum() && t != Tok::BquoteStr {
                break;
            }
        }
        if generic && self.tok() == Tok::GenericType {
            out.push('~');
            out.push_str(&self.take());
            out.push('~');
        }
        Ok(out)
    }

    fn class_label(&mut self) -> Result<String, PeleError> {
        self.i += 1;
        let label = self.expect(Tok::Str)?;
        self.expect(Tok::Sqe)?;
        Ok(label)
    }

    fn members(&mut self) -> Result<Vec<String>, PeleError> {
        if self.tok() != Tok::Member {
            return Err(self.fail("'STRUCT_STOP', 'MEMBER'"));
        }
        let mut list = Vec::new();
        while self.tok() == Tok::Member {
            list.push(self.take());
        }
        self.expect(Tok::StructStop)?;
        // Grammar collects members last-to-first, and add_members reverses them back.
        list.reverse();
        Ok(list)
    }

    fn class_statement(&mut self, db: &mut ClassDb) -> Result<String, PeleError> {
        self.i += 1;
        let id = self.name(true)?;
        db.add_class(&id);
        if self.tok() == Tok::Sqs {
            let label = self.class_label()?;
            db.set_class_label(&id, &label);
        }
        match self.tok() {
            Tok::StyleSeparator => {
                self.i += 1;
                let css = self.alpha_num()?;
                db.set_css_class(&id, &css);
                if self.tok() == Tok::StructStart {
                    self.i += 1;
                    let list = self.members()?;
                    db.add_members(&id, list);
                }
            }
            Tok::StructStart => {
                self.i += 1;
                if self.tok() == Tok::StructStop {
                    self.i += 1;
                } else {
                    let list = self.members()?;
                    db.add_members(&id, list);
                }
            }
            Tok::AnnotationStart => {
                self.i += 1;
                let annotation = self.alpha_num()?;
                self.expect(Tok::AnnotationEnd)?;
                db.add_annotation(&id, &annotation);
                if self.tok() == Tok::StructStart {
                    self.i += 1;
                    if self.tok() == Tok::StructStop {
                        self.i += 1;
                    } else {
                        let list = self.members()?;
                        db.add_members(&id, list);
                    }
                }
            }
            Tok::End
            | Tok::Error
            | Tok::ClassDiagram
            | Tok::Newline
            | Tok::Eof
            | Tok::Sqs
            | Tok::Str
            | Tok::Sqe
            | Tok::Dot
            | Tok::GenericType
            | Tok::Label
            | Tok::AccTitle
            | Tok::AccTitleValue
            | Tok::AccDescr
            | Tok::AccDescrValue
            | Tok::AccDescrMultilineValue
            | Tok::StructStop
            | Tok::Namespace
            | Tok::AnnotationEnd
            | Tok::Class
            | Tok::Member
            | Tok::NoteFor
            | Tok::Note
            | Tok::ClassDef
            | Tok::Alpha
            | Tok::Comma
            | Tok::DirectionTb
            | Tok::DirectionBt
            | Tok::DirectionRl
            | Tok::DirectionLr
            | Tok::Aggregation
            | Tok::Extension
            | Tok::Composition
            | Tok::Dependency
            | Tok::Lollipop
            | Tok::Line
            | Tok::DottedLine
            | Tok::Callback
            | Tok::Link
            | Tok::LinkTarget
            | Tok::Click
            | Tok::CallbackName
            | Tok::CallbackArgs
            | Tok::Href
            | Tok::Style
            | Tok::CssClass
            | Tok::Colon
            | Tok::Brkt
            | Tok::Pct
            | Tok::Minus
            | Tok::UnicodeText
            | Tok::BquoteStr
            | Tok::EdgeState
            | Tok::EofInStruct
            | Tok::OpenInStruct
            | Tok::Plus
            | Tok::Equals
            | Tok::Punctuation => {}
        }
        Ok(id)
    }

    fn note_statement(&mut self, db: &mut ClassDb) -> Result<String, PeleError> {
        if self.tok() == Tok::Note {
            self.i += 1;
            let text = self.expect(Tok::Str)?;
            return Ok(db.add_note(&text, None));
        }
        self.i += 1;
        let id = self.name(true)?;
        let text = self.expect(Tok::Str)?;
        Ok(db.add_note(&text, Some(&id)))
    }

    /// Namespaces nest, so parse them iteratively with an explicit stack of open frames.
    fn namespace_statement(&mut self, db: &mut ClassDb) -> Result<(), PeleError> {
        let mut open: Vec<Frame> = Vec::new();
        loop {
            self.i += 1;
            let ns = self.name(false)?;
            let id = if self.tok() == Tok::Sqs {
                let label = self.class_label()?;
                db.add_namespace(&ns, Some(&label))
            } else {
                db.add_namespace(&ns, None)
            };
            self.expect(Tok::StructStart)?;
            if self.tok() == Tok::Newline {
                self.i += 1;
            }
            open.push(Frame {
                id,
                classes: Vec::new(),
                notes: Vec::new(),
            });
            let mut item = true;
            while item {
                let t = self.tok();
                if t == Tok::Namespace {
                    break;
                }
                if t == Tok::Class {
                    let cls = self.class_statement(db)?;
                    open.last_mut().unwrap().classes.push(cls);
                } else if t == Tok::Note || t == Tok::NoteFor {
                    let note = self.note_statement(db)?;
                    open.last_mut().unwrap().notes.push(note);
                } else {
                    return Err(self.fail("'NAMESPACE', 'CLASS', 'NOTE_FOR', 'NOTE'"));
                }
                loop {
                    if self.tok() == Tok::Newline {
                        let next = self.tokens.types[self.i + 1];
                        if matches!(next, Tok::Namespace | Tok::Class | Tok::Note | Tok::NoteFor) {
                            self.i += 1;
                            break;
                        }
                        self.i += 1;
                    }
                    self.expect(Tok::StructStop)?;
                    let done = open.pop().unwrap();
                    db.add_classes_to_namespace(&done.id, &done.classes, &done.notes);
                    db.pop_namespace();
                    if open.is_empty() {
                        item = false;
                        break;
                    }
                }
            }
            if open.is_empty() {
                return Ok(());
            }
        }
    }

    fn relation_end(&mut self) -> RelationEnd {
        match self.tok().relation_end() {
            Some(rt) => {
                self.i += 1;
                RelationEnd::Type(rt)
            }
            None => RelationEnd::None,
        }
    }

    fn class_or_relation(&mut self, db: &mut ClassDb) -> Result<(), PeleError> {
        let id1 = self.name(true)?;
        let t = self.tok();
        if t == Tok::Label {
            let label = self.take();
            let cleaned = db.cleanup_label(&label);
            db.add_member(&id1, &cleaned);
            return Ok(());
        }
        let mut title1 = "none".to_string();
        if t == Tok::Str {
            title1 = self.take();
        } else if t.relation_end().is_none() && t != Tok::Line && t != Tok::DottedLine {
            return Ok(());
        }
        let type1 = self.relation_end();
        let line_type = match self.tok() {
            Tok::Line => LineType::Line,
            Tok::DottedLine => LineType::DottedLine,
            Tok::End
            | Tok::Error
            | Tok::ClassDiagram
            | Tok::Newline
            | Tok::Eof
            | Tok::Sqs
            | Tok::Str
            | Tok::Sqe
            | Tok::Dot
            | Tok::GenericType
            | Tok::Label
            | Tok::AccTitle
            | Tok::AccTitleValue
            | Tok::AccDescr
            | Tok::AccDescrValue
            | Tok::AccDescrMultilineValue
            | Tok::StructStart
            | Tok::StructStop
            | Tok::Namespace
            | Tok::StyleSeparator
            | Tok::AnnotationStart
            | Tok::AnnotationEnd
            | Tok::Class
            | Tok::Member
            | Tok::NoteFor
            | Tok::Note
            | Tok::ClassDef
            | Tok::Alpha
            | Tok::Comma
            | Tok::DirectionTb
            | Tok::DirectionBt
            | Tok::DirectionRl
            | Tok::DirectionLr
            | Tok::Aggregation
            | Tok::Extension
            | Tok::Composition
            | Tok::Dependency
            | Tok::Lollipop
            | Tok::Callback
            | Tok::Link
            | Tok::LinkTarget
            | Tok::Click
            | Tok::CallbackName
            | Tok::CallbackArgs
            | Tok::Href
            | Tok::Style
            | Tok::CssClass
            | Tok::Colon
            | Tok::Brkt
            | Tok::Pct
            | Tok::Minus
            | Tok::UnicodeText
            | Tok::BquoteStr
            | Tok::EdgeState
            | Tok::EofInStruct
            | Tok::OpenInStruct
            | Tok::Plus
            | Tok::Equals
            | Tok::Punctuation => {
                return Err(self.fail("'AGGREGATION', 'EXTENSION', 'COMPOSITION', 'DEPENDENCY', 'LOLLIPOP', 'LINE', 'DOTTED_LINE'"));
            }
        };
        self.i += 1;
        let type2 = self.relation_end();
        let title2 = if self.tok() == Tok::Str { self.take() } else { "none".to_string() };
        let id2 = self.name(true)?;
        let title = if self.tok() == Tok::Label {
            let raw = self.take();
            Some(db.cleanup_label(&raw))
        } else {
            None
        };
        db.add_relation(ClassRelation {
            id1,
            id2,
            relation: RelationSpec { type1, type2, line_type },
            relation_title1: title1,
            relation_title2: title2,
            title,
        });
        Ok(())
    }

    fn styles(&mut self) -> Result<Vec<String>, PeleError> {
        let mut out = Vec::new();
        loop {
            if !self.tok().is_style_part() {
                return Err(self.fail("'ALPHA', 'NUM', 'COLON', 'UNIT', 'SPACE', 'BRKT', 'STYLE', 'PCT', 'LABEL'"));
            }
            let mut s = self.take();
            while self.tok().is_style_part() {
                s.push_str(self.text());
                self.i += 1;
            }
            out.push(s);
            if self.tok() != Tok::Comma {
                return Ok(out);
            }
            self.i += 1;
        }
    }

    fn tooltip(&mut self, id: &str, db: &mut ClassDb) {
        if self.tok() == Tok::Str {
            let tip = self.take();
            db.set_tooltip(id, Some(&tip));
        }
    }

    fn link_statement(&mut self, id: &str, db: &mut ClassDb) -> Result<(), PeleError> {
        let href = self.expect(Tok::Str)?;
        let tip = if self.tok() == Tok::Str { Some(self.take()) } else { None };
        if self.tok() == Tok::LinkTarget {
            let target = self.take();
            db.set_link(id, &href, Some(&target));
        } else {
            db.set_link(id, &href, None);
        }
        if let Some(t) = tip {
            db.set_tooltip(id, Some(&t));
        }
        Ok(())
    }

    fn statement(&mut self, db: &mut ClassDb) -> Result<(), PeleError> {
        match self.tok() {
            Tok::UnicodeText | Tok::Alpha | Tok::Minus | Tok::BquoteStr => self.class_or_relation(db),
            Tok::Namespace => self.namespace_statement(db),
            Tok::Class => {
                self.class_statement(db)?;
                Ok(())
            }
            Tok::Member => {
                self.i += 1;
                Ok(())
            }
            Tok::AnnotationStart => {
                self.i += 1;
                let annotation = self.alpha_num()?;
                self.expect(Tok::AnnotationEnd)?;
                let target = self.name(true)?;
                db.add_annotation(&target, &annotation);
                Ok(())
            }
            Tok::Callback => {
                self.i += 1;
                let id = self.name(true)?;
                let fn_name = self.expect(Tok::Str)?;
                db.set_click_event(&id, Some(&fn_name), None);
                self.tooltip(&id, db);
                Ok(())
            }
            Tok::Link => {
                self.i += 1;
                let id = self.name(true)?;
                self.link_statement(&id, db)
            }
            Tok::Click => {
                self.i += 1;
                let id = self.name(true)?;
                if self.tok() == Tok::Href {
                    self.i += 1;
                    return self.link_statement(&id, db);
                }
                let fn_name = self.expect(Tok::CallbackName)?;
                if self.tok() == Tok::CallbackArgs {
                    let args = self.take();
                    db.set_click_event(&id, Some(&fn_name), Some(&args));
                } else {
                    db.set_click_event(&id, Some(&fn_name), None);
                }
                self.tooltip(&id, db);
                Ok(())
            }
            Tok::Style => {
                self.i += 1;
                let id = self.expect(Tok::Alpha)?;
                let list = self.styles()?;
                db.set_css_style(&id, &list);
                Ok(())
            }
            Tok::CssClass => {
                self.i += 1;
                let ids = self.expect(Tok::Str)?;
                let css = self.expect(Tok::Alpha)?;
                db.set_css_class(&ids, &css);
                Ok(())
            }
            Tok::Note | Tok::NoteFor => {
                self.note_statement(db)?;
                Ok(())
            }
            Tok::ClassDef => {
                self.i += 1;
                let mut ids = vec![self.expect(Tok::Alpha)?];
                while self.tok() == Tok::Comma {
                    self.i += 1;
                    ids.push(self.expect(Tok::Alpha)?);
                }
                let list = self.styles()?;
                db.define_class(&ids, &list);
                Ok(())
            }
            Tok::DirectionTb => {
                self.i += 1;
                db.set_direction("TB");
                Ok(())
            }
            Tok::DirectionBt => {
                self.i += 1;
                db.set_direction("BT");
                Ok(())
            }
            Tok::DirectionRl => {
                self.i += 1;
                db.set_direction("RL");
                Ok(())
            }
            Tok::DirectionLr => {
                self.i += 1;
                db.set_direction("LR");
                Ok(())
            }
            Tok::AccTitle => {
                self.i += 1;
                let raw = self.expect(Tok::AccTitleValue)?;
                db.set_acc_title(raw.trim_matches(is_space_char));
                Ok(())
            }
            Tok::AccDescr => {
                self.i += 1;
                let raw = self.expect(Tok::AccDescrValue)?;
                db.set_acc_description(raw.trim_matches(is_space_char));
                Ok(())
            }
            Tok::AccDescrMultilineValue => {
                let raw = self.take();
                db.set_acc_description(raw.trim_matches(is_space_char));
                Ok(())
            }
            Tok::End
            | Tok::Error
            | Tok::ClassDiagram
            | Tok::Newline
            | Tok::Eof
            | Tok::Sqs
            | Tok::Str
            | Tok::Sqe
            | Tok::Dot
            | Tok::GenericType
            | Tok::Label
            | Tok::AccTitleValue
            | Tok::AccDescrValue
            | Tok::StructStart
            | Tok::StructStop
            | Tok::StyleSeparator
            | Tok::AnnotationEnd
            | Tok::Comma
            | Tok::Aggregation
            | Tok::Extension
            | Tok::Composition
            | Tok::Dependency
            | Tok::Lollipop
            | Tok::Line
            | Tok::DottedLine
            | Tok::LinkTarget
            | Tok::CallbackName
            | Tok::CallbackArgs
            | Tok::Href
            | Tok::Colon
            | Tok::Brkt
            | Tok::Pct
            | Tok::EdgeState
            | Tok::EofInStruct
            | Tok::OpenInStruct
            | Tok::Plus
            | Tok::Equals
            | Tok::Punctuation => Err(self.fail(
                "'acc_title', 'acc_descr', 'acc_descr_multiline_value', 'NAMESPACE', 'ANNOTATION_START', 'CLASS', 'MEMBER', 'NOTE_FOR', 'NOTE', 'CLASSDEF', 'direction_tb', 'CALLBACK', 'LINK', 'CLICK', 'STYLE', 'CSSCLASS', 'ALPHA', 'MINUS', 'BQUOTE_STR'",
            )),
        }
    }
}

pub fn parse_class_diagram(src: &str, db: &mut ClassDb, origin: Option<&SourceMap<'_>>) -> Result<(), PeleError> {
    let mut parser = Parser::new(src, origin);
    // Mermaid's grammar also accepts statements with no `classDiagram` line before them.
    let header = parser.tok() == Tok::ClassDiagram;
    if header {
        parser.i += 1;
        parser.expect(Tok::Newline)?;
    }
    loop {
        parser.statement(db)?;
        if parser.tok() != Tok::Newline {
            break;
        }
        parser.i += 1;
        if parser.tok() == Tok::Eof || parser.tok() == Tok::End {
            break;
        }
    }
    if header {
        parser.expect(Tok::Eof)?;
    }
    parser.expect(Tok::End)?;
    Ok(())
}
