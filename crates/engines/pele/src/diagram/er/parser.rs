use crate::detect::DiagramType;
use crate::error::{PeleError, SourceMap, syntax_error};

use super::db::ErDb;
use super::lexer::{ErTokens, tokenize};
use super::tokens::ErToken;
use super::types::{Cardinality, DocItem, Identification, ParsedAttribute, RelSpec};

const NAME: &str = "'UNICODE_TEXT', 'NUM', 'ENTITY_NAME', 'DECIMAL_NUM', 'ENTITY_ONE'";
const CARDS: &str = "'ZERO_OR_ONE', 'ZERO_OR_MORE', 'ONE_OR_MORE', 'ONLY_ONE', 'MD_PARENT'";
const LINE: &str = "'EOF', 'NEWLINE', 'title', 'acc_title', 'acc_descr', 'acc_descr_multiline_value', 'SUBGRAPH', 'direction_tb', 'direction_bt', 'direction_rl', 'direction_lr', 'CLASSDEF', 'CLASS', 'STYLE', 'UNICODE_TEXT', 'NUM', 'ENTITY_NAME', 'DECIMAL_NUM', 'ENTITY_ONE'";
const NESTED_LINE: &str = "'END', 'EOF', 'NEWLINE', 'title', 'acc_title', 'acc_descr', 'acc_descr_multiline_value', 'SUBGRAPH', 'direction_tb', 'direction_bt', 'direction_rl', 'direction_lr', 'CLASSDEF', 'CLASS', 'STYLE', 'UNICODE_TEXT', 'NUM', 'ENTITY_NAME', 'DECIMAL_NUM', 'ENTITY_ONE'";

fn cardinality_of(token: ErToken) -> Option<Cardinality> {
    match token {
        ErToken::ZeroOrOne => Some(Cardinality::ZeroOrOne),
        ErToken::ZeroOrMore => Some(Cardinality::ZeroOrMore),
        ErToken::OneOrMore => Some(Cardinality::OneOrMore),
        ErToken::OnlyOne => Some(Cardinality::OnlyOne),
        ErToken::MdParent => Some(Cardinality::MdParent),
        ErToken::End
        | ErToken::Error
        | ErToken::ErDiagram
        | ErToken::Eof
        | ErToken::Newline
        | ErToken::Colon
        | ErToken::StyleSeparator
        | ErToken::BlockStart
        | ErToken::BlockStop
        | ErToken::Sqs
        | ErToken::Sqe
        | ErToken::AccTitle
        | ErToken::AccTitleValue
        | ErToken::AccDescr
        | ErToken::AccDescrValue
        | ErToken::AccDescrMultilineValue
        | ErToken::EndKw
        | ErToken::Subgraph
        | ErToken::DirectionTb
        | ErToken::DirectionBt
        | ErToken::DirectionRl
        | ErToken::DirectionLr
        | ErToken::ClassDef
        | ErToken::UnicodeText
        | ErToken::StyleText
        | ErToken::Comma
        | ErToken::Class
        | ErToken::Style
        | ErToken::Semi
        | ErToken::Num
        | ErToken::Brkt
        | ErToken::EntityName
        | ErToken::DecimalNum
        | ErToken::EntityOne
        | ErToken::AttributeWord
        | ErToken::AttributeKey
        | ErToken::Comment
        | ErToken::NonIdentifying
        | ErToken::Identifying
        | ErToken::Word
        | ErToken::Char => None,
    }
}

fn is_name(token: ErToken) -> bool {
    match token {
        ErToken::UnicodeText | ErToken::EntityName | ErToken::Num | ErToken::DecimalNum | ErToken::EntityOne => true,
        ErToken::End
        | ErToken::Error
        | ErToken::ErDiagram
        | ErToken::Eof
        | ErToken::Newline
        | ErToken::Colon
        | ErToken::StyleSeparator
        | ErToken::BlockStart
        | ErToken::BlockStop
        | ErToken::Sqs
        | ErToken::Sqe
        | ErToken::AccTitle
        | ErToken::AccTitleValue
        | ErToken::AccDescr
        | ErToken::AccDescrValue
        | ErToken::AccDescrMultilineValue
        | ErToken::EndKw
        | ErToken::Subgraph
        | ErToken::DirectionTb
        | ErToken::DirectionBt
        | ErToken::DirectionRl
        | ErToken::DirectionLr
        | ErToken::ClassDef
        | ErToken::StyleText
        | ErToken::Comma
        | ErToken::Class
        | ErToken::Style
        | ErToken::Semi
        | ErToken::Brkt
        | ErToken::AttributeWord
        | ErToken::AttributeKey
        | ErToken::Comment
        | ErToken::ZeroOrOne
        | ErToken::ZeroOrMore
        | ErToken::OneOrMore
        | ErToken::OnlyOne
        | ErToken::MdParent
        | ErToken::NonIdentifying
        | ErToken::Identifying
        | ErToken::Word
        | ErToken::Char => false,
    }
}

fn is_style_component(token: ErToken) -> bool {
    match token {
        ErToken::StyleText | ErToken::Num | ErToken::Colon | ErToken::Brkt => true,
        ErToken::End
        | ErToken::Error
        | ErToken::ErDiagram
        | ErToken::Eof
        | ErToken::Newline
        | ErToken::StyleSeparator
        | ErToken::BlockStart
        | ErToken::BlockStop
        | ErToken::Sqs
        | ErToken::Sqe
        | ErToken::AccTitle
        | ErToken::AccTitleValue
        | ErToken::AccDescr
        | ErToken::AccDescrValue
        | ErToken::AccDescrMultilineValue
        | ErToken::EndKw
        | ErToken::Subgraph
        | ErToken::DirectionTb
        | ErToken::DirectionBt
        | ErToken::DirectionRl
        | ErToken::DirectionLr
        | ErToken::ClassDef
        | ErToken::UnicodeText
        | ErToken::Comma
        | ErToken::Class
        | ErToken::Style
        | ErToken::Semi
        | ErToken::EntityName
        | ErToken::DecimalNum
        | ErToken::EntityOne
        | ErToken::AttributeWord
        | ErToken::AttributeKey
        | ErToken::Comment
        | ErToken::ZeroOrOne
        | ErToken::ZeroOrMore
        | ErToken::OneOrMore
        | ErToken::OnlyOne
        | ErToken::MdParent
        | ErToken::NonIdentifying
        | ErToken::Identifying
        | ErToken::Word
        | ErToken::Char => false,
    }
}

struct Frame {
    id: String,
    title: String,
    list: Vec<DocItem>,
}

struct Parser<'a> {
    src: &'a str,
    origin: Option<&'a SourceMap<'a>>,
    tokens: ErTokens,
    i: usize,
}

impl<'a> Parser<'a> {
    fn fail(&self, expected: &str) -> PeleError {
        let t = self.tokens.types[self.i];
        if t == ErToken::Error {
            return syntax_error(DiagramType::Er, self.src, self.tokens.starts[self.i], "", true, self.origin);
        }
        let got = if t == ErToken::Char { self.tokens.texts[self.i].as_str() } else { t.name() };
        syntax_error(
            DiagramType::Er,
            self.src,
            self.tokens.starts[self.i],
            &format!("Expecting {expected}, got '{got}'"),
            false,
            self.origin,
        )
    }

    fn expect(&mut self, token: ErToken) -> Result<String, PeleError> {
        if self.tokens.types[self.i] != token {
            return Err(self.fail(&format!("'{}'", token.name())));
        }
        let text = self.tokens.texts[self.i].clone();
        self.i += 1;
        Ok(text)
    }

    fn separator(&mut self) -> Result<(), PeleError> {
        let t = self.tokens.types[self.i];
        if !matches!(t, ErToken::Newline | ErToken::Semi | ErToken::Eof) {
            return Err(self.fail("'EOF', 'NEWLINE', 'SEMI'"));
        }
        self.i += 1;
        Ok(())
    }

    fn entity_name(&mut self) -> Result<String, PeleError> {
        let t = self.tokens.types[self.i];
        if !is_name(t) {
            return Err(self.fail(NAME));
        }
        let text = &self.tokens.texts[self.i];
        let out = if t == ErToken::EntityName {
            text[1..text.len() - 1].to_string()
        } else {
            text.clone()
        };
        self.i += 1;
        Ok(out)
    }

    fn id_list(&mut self) -> Result<Vec<String>, PeleError> {
        let mut ids = Vec::new();
        loop {
            let t = self.tokens.types[self.i];
            if t != ErToken::UnicodeText && t != ErToken::StyleText {
                return Err(self.fail("'UNICODE_TEXT', 'STYLE_TEXT'"));
            }
            ids.push(self.tokens.texts[self.i].clone());
            self.i += 1;
            if self.tokens.types[self.i] != ErToken::Comma {
                return Ok(ids);
            }
            self.i += 1;
        }
    }

    fn styles_opt(&mut self) -> Result<Vec<String>, PeleError> {
        let mut styles = Vec::new();
        loop {
            if !is_style_component(self.tokens.types[self.i]) {
                return Err(self.fail("'STYLE_TEXT', 'COLON', 'NUM', 'BRKT'"));
            }
            let mut style = self.tokens.texts[self.i].clone();
            self.i += 1;
            while is_style_component(self.tokens.types[self.i]) {
                style.push_str(&self.tokens.texts[self.i]);
                self.i += 1;
            }
            styles.push(style);
            if self.tokens.types[self.i] != ErToken::Comma {
                return Ok(styles);
            }
            self.i += 1;
        }
    }

    fn rel_spec(&mut self, card_b: Cardinality) -> Result<RelSpec, PeleError> {
        self.i += 1;
        let rel_type = match self.tokens.types[self.i] {
            ErToken::Identifying => Identification::Identifying,
            ErToken::NonIdentifying => Identification::NonIdentifying,
            ErToken::End
            | ErToken::Error
            | ErToken::ErDiagram
            | ErToken::Eof
            | ErToken::Newline
            | ErToken::Colon
            | ErToken::StyleSeparator
            | ErToken::BlockStart
            | ErToken::BlockStop
            | ErToken::Sqs
            | ErToken::Sqe
            | ErToken::AccTitle
            | ErToken::AccTitleValue
            | ErToken::AccDescr
            | ErToken::AccDescrValue
            | ErToken::AccDescrMultilineValue
            | ErToken::EndKw
            | ErToken::Subgraph
            | ErToken::DirectionTb
            | ErToken::DirectionBt
            | ErToken::DirectionRl
            | ErToken::DirectionLr
            | ErToken::ClassDef
            | ErToken::UnicodeText
            | ErToken::StyleText
            | ErToken::Comma
            | ErToken::Class
            | ErToken::Style
            | ErToken::Semi
            | ErToken::Num
            | ErToken::Brkt
            | ErToken::EntityName
            | ErToken::DecimalNum
            | ErToken::EntityOne
            | ErToken::AttributeWord
            | ErToken::AttributeKey
            | ErToken::Comment
            | ErToken::ZeroOrOne
            | ErToken::ZeroOrMore
            | ErToken::OneOrMore
            | ErToken::OnlyOne
            | ErToken::MdParent
            | ErToken::Word
            | ErToken::Char => return Err(self.fail("'NON_IDENTIFYING', 'IDENTIFYING'")),
        };
        self.i += 1;
        let Some(card_a) = cardinality_of(self.tokens.types[self.i]) else {
            return Err(self.fail(CARDS));
        };
        self.i += 1;
        Ok(RelSpec { card_a, rel_type, card_b })
    }

    fn role(&mut self) -> Result<String, PeleError> {
        let t = self.tokens.types[self.i];
        let text = &self.tokens.texts[self.i];
        let out = match t {
            ErToken::UnicodeText => text.clone(),
            ErToken::Word | ErToken::EntityName => text[1..text.len() - 1].to_string(),
            ErToken::End
            | ErToken::Error
            | ErToken::ErDiagram
            | ErToken::Eof
            | ErToken::Newline
            | ErToken::Colon
            | ErToken::StyleSeparator
            | ErToken::BlockStart
            | ErToken::BlockStop
            | ErToken::Sqs
            | ErToken::Sqe
            | ErToken::AccTitle
            | ErToken::AccTitleValue
            | ErToken::AccDescr
            | ErToken::AccDescrValue
            | ErToken::AccDescrMultilineValue
            | ErToken::EndKw
            | ErToken::Subgraph
            | ErToken::DirectionTb
            | ErToken::DirectionBt
            | ErToken::DirectionRl
            | ErToken::DirectionLr
            | ErToken::ClassDef
            | ErToken::StyleText
            | ErToken::Comma
            | ErToken::Class
            | ErToken::Style
            | ErToken::Semi
            | ErToken::Num
            | ErToken::Brkt
            | ErToken::DecimalNum
            | ErToken::EntityOne
            | ErToken::AttributeWord
            | ErToken::AttributeKey
            | ErToken::Comment
            | ErToken::ZeroOrOne
            | ErToken::ZeroOrMore
            | ErToken::OneOrMore
            | ErToken::OnlyOne
            | ErToken::MdParent
            | ErToken::NonIdentifying
            | ErToken::Identifying
            | ErToken::Char => return Err(self.fail("'UNICODE_TEXT', 'ENTITY_NAME', 'WORD'")),
        };
        self.i += 1;
        Ok(out)
    }

    fn is_char(&self, ch: &str) -> bool {
        self.tokens.types[self.i] == ErToken::Char && self.tokens.texts[self.i] == ch
    }

    /// Returns attributes last to first, as Mermaid's right-recursive rule builds them.
    fn attributes(&mut self) -> Result<Vec<ParsedAttribute>, PeleError> {
        let mut list = Vec::new();
        loop {
            let mut attr_type = self.expect(ErToken::AttributeWord)?;
            if self.is_char("?") {
                attr_type.push_str(&self.tokens.texts[self.i]);
                self.i += 1;
            }
            if self.tokens.types[self.i] != ErToken::AttributeWord {
                return Err(self.fail(if attr_type.ends_with('?') {
                    "'ATTRIBUTE_WORD'"
                } else {
                    "'ATTRIBUTE_WORD', '?'"
                }));
            }
            let name = self.tokens.texts[self.i].clone();
            self.i += 1;
            let keys = if self.tokens.types[self.i] == ErToken::AttributeKey {
                let mut keys = vec![self.tokens.texts[self.i].clone()];
                self.i += 1;
                while self.is_char(",") {
                    self.i += 1;
                    keys.push(self.expect(ErToken::AttributeKey)?);
                }
                Some(keys)
            } else {
                None
            };
            let comment = if self.tokens.types[self.i] == ErToken::Comment {
                let raw = &self.tokens.texts[self.i];
                let stripped = raw[1..raw.len() - 1].to_string();
                self.i += 1;
                Some(stripped)
            } else {
                None
            };
            list.push(ParsedAttribute {
                attr_type,
                name,
                keys,
                comment,
            });
            if self.tokens.types[self.i] == ErToken::BlockStop {
                break;
            }
        }
        list.reverse();
        Ok(list)
    }

    fn block(&mut self) -> Result<Option<Vec<ParsedAttribute>>, PeleError> {
        if self.tokens.types[self.i] != ErToken::BlockStart {
            return Ok(None);
        }
        self.i += 1;
        if self.tokens.types[self.i] == ErToken::BlockStop {
            self.i += 1;
            return Ok(None);
        }
        let list = self.attributes()?;
        self.i += 1;
        Ok(Some(list))
    }

    fn entity_statement(&mut self, db: &mut ErDb) -> Result<Vec<String>, PeleError> {
        let a = self.entity_name()?;
        let mut t = self.tokens.types[self.i];
        if t == ErToken::Sqs {
            self.i += 1;
            let alias = self.entity_name()?;
            self.expect(ErToken::Sqe)?;
            let classes = if self.tokens.types[self.i] == ErToken::StyleSeparator {
                self.i += 1;
                Some(self.id_list()?)
            } else {
                None
            };
            let attrs = self.block()?;
            db.add_entity(&a, &alias);
            if let Some(attrs) = attrs {
                db.add_attributes(&a, attrs);
            }
            if let Some(classes) = classes {
                db.set_class(std::slice::from_ref(&a), &classes);
            }
            return Ok(vec![a]);
        }
        let classes = if t == ErToken::StyleSeparator {
            self.i += 1;
            let cls = self.id_list()?;
            t = self.tokens.types[self.i];
            Some(cls)
        } else {
            None
        };
        if let Some(card_b) = cardinality_of(t) {
            let spec = self.rel_spec(card_b)?;
            let b = self.entity_name()?;
            let classes_b = if self.tokens.types[self.i] == ErToken::StyleSeparator {
                self.i += 1;
                Some(self.id_list()?)
            } else {
                None
            };
            self.expect(ErToken::Colon)?;
            let label = self.role()?;
            db.add_entity(&a, "");
            db.add_entity(&b, "");
            db.add_relationship(&a, &label, &b, spec);
            if let Some(classes) = classes {
                db.set_class(std::slice::from_ref(&a), &classes);
            }
            if let Some(classes_b) = classes_b {
                db.set_class(std::slice::from_ref(&b), &classes_b);
            }
            return Ok(vec![a, b]);
        }
        let attrs = self.block()?;
        db.add_entity(&a, "");
        if let Some(attrs) = attrs {
            db.add_attributes(&a, attrs);
        }
        if let Some(classes) = classes {
            db.set_class(std::slice::from_ref(&a), &classes);
        }
        Ok(vec![a])
    }
}

pub fn parse_er(src: &str, db: &mut ErDb, origin: Option<&SourceMap<'_>>) -> Result<(), PeleError> {
    let mut p = Parser {
        src,
        origin,
        tokens: tokenize(src),
        i: 0,
    };
    p.expect(ErToken::ErDiagram)?;

    // Subgraphs nest on this stack rather than on the call stack; the first frame is the diagram itself.
    let mut frames = vec![Frame {
        id: String::new(),
        title: String::new(),
        list: Vec::new(),
    }];

    loop {
        let nested = frames.len() > 1;
        let t = p.tokens.types[p.i];
        match t {
            ErToken::Newline => {
                p.i += 1;
            }
            ErToken::Eof => {
                p.i += 1;
                if nested {
                    return Err(p.fail(NESTED_LINE));
                }
                return Ok(());
            }
            ErToken::EndKw => {
                if !nested {
                    return Err(p.fail(LINE));
                }
                p.i += 1;
                let closed = frames.pop().expect("nested implies len > 1");
                let id = db.add_subgraph(&closed.id, &closed.list, &closed.title, None);
                if frames.len() > 1 {
                    frames.last_mut().expect("root frame").list.push(DocItem::Name(id));
                }
            }
            ErToken::Subgraph => {
                p.i += 1;
                let id = p.entity_name()?;
                let mut title = id.clone();
                if p.tokens.types[p.i] == ErToken::Sqs {
                    p.i += 1;
                    title = p.entity_name()?;
                    while is_name(p.tokens.types[p.i]) {
                        title.push(' ');
                        title.push_str(&p.entity_name()?);
                    }
                    p.expect(ErToken::Sqe)?;
                }
                p.separator()?;
                frames.push(Frame { id, title, list: Vec::new() });
            }
            ErToken::AccTitle => {
                p.i += 1;
                let value = p.expect(ErToken::AccTitleValue)?.trim().to_string();
                db.set_acc_title(&value);
                if nested {
                    frames.last_mut().expect("frame").list.push(DocItem::Name(value));
                }
            }
            ErToken::AccDescr => {
                p.i += 1;
                let value = p.expect(ErToken::AccDescrValue)?.trim().to_string();
                db.set_acc_description(&value);
                if nested {
                    frames.last_mut().expect("frame").list.push(DocItem::Name(value));
                }
            }
            ErToken::AccDescrMultilineValue => {
                let value = p.tokens.texts[p.i].trim().to_string();
                p.i += 1;
                db.set_acc_description(&value);
                if nested {
                    frames.last_mut().expect("frame").list.push(DocItem::Name(value));
                }
            }
            ErToken::DirectionTb | ErToken::DirectionBt | ErToken::DirectionRl | ErToken::DirectionLr => {
                p.i += 1;
                let value = match t {
                    ErToken::DirectionTb => "TB",
                    ErToken::DirectionBt => "BT",
                    ErToken::DirectionRl => "RL",
                    ErToken::DirectionLr => "LR",
                    ErToken::End
                    | ErToken::Error
                    | ErToken::ErDiagram
                    | ErToken::Eof
                    | ErToken::Newline
                    | ErToken::Colon
                    | ErToken::StyleSeparator
                    | ErToken::BlockStart
                    | ErToken::BlockStop
                    | ErToken::Sqs
                    | ErToken::Sqe
                    | ErToken::AccTitle
                    | ErToken::AccTitleValue
                    | ErToken::AccDescr
                    | ErToken::AccDescrValue
                    | ErToken::AccDescrMultilineValue
                    | ErToken::EndKw
                    | ErToken::Subgraph
                    | ErToken::ClassDef
                    | ErToken::UnicodeText
                    | ErToken::StyleText
                    | ErToken::Comma
                    | ErToken::Class
                    | ErToken::Style
                    | ErToken::Semi
                    | ErToken::Num
                    | ErToken::Brkt
                    | ErToken::EntityName
                    | ErToken::DecimalNum
                    | ErToken::EntityOne
                    | ErToken::AttributeWord
                    | ErToken::AttributeKey
                    | ErToken::Comment
                    | ErToken::ZeroOrOne
                    | ErToken::ZeroOrMore
                    | ErToken::OneOrMore
                    | ErToken::OnlyOne
                    | ErToken::MdParent
                    | ErToken::NonIdentifying
                    | ErToken::Identifying
                    | ErToken::Word
                    | ErToken::Char => unreachable!(),
                };
                if nested {
                    frames.last_mut().expect("frame").list.push(DocItem::Dir(value.to_string()));
                } else {
                    db.set_direction(value);
                }
            }
            ErToken::ClassDef => {
                let keyword = p.tokens.texts[p.i].clone();
                p.i += 1;
                let ids = p.id_list()?;
                let styles = p.styles_opt()?;
                p.separator()?;
                db.add_class(&ids, &styles);
                if nested {
                    frames.last_mut().expect("frame").list.push(DocItem::Name(keyword));
                }
            }
            ErToken::Class => {
                let keyword = p.tokens.texts[p.i].clone();
                p.i += 1;
                let ids = p.id_list()?;
                let class_names = p.id_list()?;
                db.set_class(&ids, &class_names);
                if nested {
                    frames.last_mut().expect("frame").list.push(DocItem::Name(keyword));
                }
            }
            ErToken::Style => {
                let keyword = p.tokens.texts[p.i].clone();
                p.i += 1;
                let ids = p.id_list()?;
                let styles = p.styles_opt()?;
                p.separator()?;
                db.add_css_styles(&ids, &styles);
                if nested {
                    frames.last_mut().expect("frame").list.push(DocItem::Name(keyword));
                }
            }
            ErToken::UnicodeText | ErToken::EntityName | ErToken::Num | ErToken::DecimalNum | ErToken::EntityOne => {
                let names = p.entity_statement(db)?;
                if nested {
                    let list = &mut frames.last_mut().expect("frame").list;
                    for name in names {
                        list.push(DocItem::Name(name));
                    }
                }
            }
            ErToken::End
            | ErToken::Error
            | ErToken::ErDiagram
            | ErToken::Colon
            | ErToken::StyleSeparator
            | ErToken::BlockStart
            | ErToken::BlockStop
            | ErToken::Sqs
            | ErToken::Sqe
            | ErToken::AccTitleValue
            | ErToken::AccDescrValue
            | ErToken::StyleText
            | ErToken::Comma
            | ErToken::Semi
            | ErToken::Brkt
            | ErToken::AttributeWord
            | ErToken::AttributeKey
            | ErToken::Comment
            | ErToken::ZeroOrOne
            | ErToken::ZeroOrMore
            | ErToken::OneOrMore
            | ErToken::OnlyOne
            | ErToken::MdParent
            | ErToken::NonIdentifying
            | ErToken::Identifying
            | ErToken::Word
            | ErToken::Char => {
                return Err(p.fail(if nested { NESTED_LINE } else { LINE }));
            }
        }
    }
}
