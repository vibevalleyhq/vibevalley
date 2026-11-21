use indexmap::IndexMap;

use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError, SourceLocation, SourceMap};
use crate::util::chars::is_word;

use super::db::{
    DraftBoundary, DraftClassAssign, DraftClassDef, DraftElement, DraftEndpoint, DraftJson, DraftLabel, DraftMetadata, DraftNote, DraftProperty,
    DraftRelationship, DraftStyleAssign, Drafts, ElementKind, PropertyValue, resolve_usecase,
};
use super::json::parse_ordered_json;
use super::lexer::{Tokens, line_column, location_text, tokenize};
use super::tokens::UsecaseToken;
use super::types::{
    Arrow, Direction, EdgeOccurrence, GraphStatement, LabelType, MetadataOccurrence, NodeOccurrence, RelationshipType, Span, StatementKind, UseCaseShape,
    UsecaseModel,
};

const ARROWS: &str =
    "DEPENDENCY_ARROW|GENERALIZATION|FORWARD_SOLID|BACKWARD_SOLID|MARKERLESS_SOLID|FORWARD_CIRCLE|BACKWARD_CIRCLE|FORWARD_CROSS|BACKWARD_CROSS";
const NAMES: &str = "IDENTIFIER|PLAIN_STRING|MARKDOWN_STRING";
const LABELS: &str = "PLAIN_STRING|MARKDOWN_STRING|LABEL_TEXT";
const STATEMENTS: &str = "ACC_TITLE_LINE|ACC_DESCR_LINE|ACC_DESCR_BLOCK|DIRECTION|ACTOR|SYSTEM_BOUNDARY|NOTE|JSON_DECLARATION_START|CLASS_DEF|CLASS|STYLE";
const STYLE_PARTS: &str = "WORD|PLAIN_STRING|NUMBER|HASH_COLOR|CSS_IDENTIFIER|CSS_ESCAPED_COMMA|DASH|DOT|PERCENT|CSS_PUNCTUATION|COLON|LPAREN|RPAREN|LBRACKET|RBRACKET|LBRACE|RBRACE|AT|MARKERLESS_SOLID";

fn is_arrow(t: UsecaseToken) -> bool {
    matches!(
        t,
        UsecaseToken::DependencyArrow
            | UsecaseToken::Generalization
            | UsecaseToken::ForwardSolid
            | UsecaseToken::BackwardSolid
            | UsecaseToken::MarkerlessSolid
            | UsecaseToken::ForwardCircle
            | UsecaseToken::BackwardCircle
            | UsecaseToken::ForwardCross
            | UsecaseToken::BackwardCross
    )
}

fn is_line(t: UsecaseToken) -> bool {
    matches!(
        t,
        UsecaseToken::Newline
            | UsecaseToken::Comment
            | UsecaseToken::AccTitleLine
            | UsecaseToken::AccDescrLine
            | UsecaseToken::AccDescrBlock
            | UsecaseToken::Direction
            | UsecaseToken::Actor
            | UsecaseToken::SystemBoundary
            | UsecaseToken::Note
            | UsecaseToken::JsonDeclarationStart
            | UsecaseToken::ClassDef
            | UsecaseToken::Class
            | UsecaseToken::Style
            | UsecaseToken::Identifier
            | UsecaseToken::PlainString
            | UsecaseToken::MarkdownString
    )
}

fn is_relation(t: UsecaseToken) -> bool {
    t == UsecaseToken::Identifier || is_arrow(t)
}

fn is_style_part(t: UsecaseToken) -> bool {
    t.is_word()
        || matches!(
            t,
            UsecaseToken::PlainString
                | UsecaseToken::Number
                | UsecaseToken::HashColor
                | UsecaseToken::CssIdentifier
                | UsecaseToken::CssEscapedComma
                | UsecaseToken::Dash
                | UsecaseToken::Dot
                | UsecaseToken::Percent
                | UsecaseToken::CssPunctuation
                | UsecaseToken::Colon
                | UsecaseToken::LParen
                | UsecaseToken::RParen
                | UsecaseToken::LBracket
                | UsecaseToken::RBracket
                | UsecaseToken::LBrace
                | UsecaseToken::RBrace
                | UsecaseToken::At
                | UsecaseToken::MarkerlessSolid
        )
}

fn follows_name(t: UsecaseToken) -> bool {
    matches!(
        t,
        UsecaseToken::StereotypeStart | UsecaseToken::ClassSeparator | UsecaseToken::Identifier | UsecaseToken::Newline | UsecaseToken::Eof
    ) || is_arrow(t)
}

fn is_boundary_line(t: UsecaseToken) -> bool {
    matches!(
        t,
        UsecaseToken::Newline
            | UsecaseToken::Comment
            | UsecaseToken::Actor
            | UsecaseToken::Identifier
            | UsecaseToken::PlainString
            | UsecaseToken::MarkdownString
    )
}

fn closes_label(t: UsecaseToken) -> bool {
    matches!(
        t,
        UsecaseToken::ForwardSolid | UsecaseToken::MarkerlessSolid | UsecaseToken::ForwardCircle | UsecaseToken::ForwardCross
    )
}

fn is_metadata_first(t: UsecaseToken) -> bool {
    matches!(
        t,
        UsecaseToken::Newline | UsecaseToken::Identifier | UsecaseToken::PlainString | UsecaseToken::RBrace
    )
}

fn is_key(t: UsecaseToken) -> bool {
    matches!(t, UsecaseToken::Identifier | UsecaseToken::PlainString)
}

fn is_forbidden(word: &str) -> bool {
    matches!(
        word.to_ascii_lowercase().as_str(),
        "allowmixing" | "newpage" | "package" | "rectangle" | "skinparam"
    )
}

fn generated_id(label: &str) -> String {
    label.chars().map(|c| if is_word(c as u32) { c } else { '_' }).collect()
}

fn statement_sequences() -> String {
    let names = ["IDENTIFIER", "PLAIN_STRING", "MARKDOWN_STRING"];
    let mut metadata: Vec<String> = Vec::new();
    for name in names {
        for next in ["NEWLINE", "IDENTIFIER", "PLAIN_STRING", "RBRACE"] {
            metadata.push(format!("{name}, METADATA_START, {next}"));
        }
    }
    let mut follows: Vec<&str> = vec!["STEREOTYPE_START", "CLASS_SEPARATOR", "IDENTIFIER"];
    follows.extend(ARROWS.split('|'));
    follows.extend(["NEWLINE", "EOF"]);
    let mut entities: Vec<String> = Vec::new();
    for (i, name) in names.iter().enumerate() {
        if i == 0 {
            entities.push(format!("{name}, LPAREN"));
            entities.push(format!("{name}, LBRACKET"));
        }
        for next in &follows {
            entities.push(format!("{name}, {next}"));
        }
    }
    let mut all: Vec<String> = Vec::new();
    all.push(STATEMENTS.to_string());
    all.extend(metadata.iter().cloned());
    all.extend(entities);
    all.extend(metadata);
    all.join("|")
}

struct Item {
    id: String,
    label: DraftLabel,
    span: Span,
    generated: bool,
    shape: Option<UseCaseShape>,
    metadata: Option<Vec<DraftProperty>>,
    stereotype: Option<String>,
    stereotype_span: Option<Span>,
    classes: Vec<String>,
    class_spans: Vec<Span>,
    explicit: bool,
    node_span: Span,
}

struct Tail {
    explicit_id: Option<String>,
    explicit_id_span: Option<Span>,
    rel_type: RelationshipType,
    arrow_type: Arrow,
    label: Option<DraftLabel>,
    minlen: i32,
    target: Item,
    span: Span,
}

struct Parser<'a> {
    src: &'a str,
    origin: Option<&'a SourceMap<'a>>,
    tokens: Tokens,
    p: usize,
    last_end: usize,
    drafts: Drafts,
    parent: Option<(String, Span)>,
    pending_json: Vec<(usize, usize)>,
    edge_count: usize,
    note_count: usize,
    top_stmt_index: usize,
}

impl<'a> Parser<'a> {
    fn tok(&self, k: usize) -> UsecaseToken {
        self.tokens.types[k]
    }

    fn cur(&self) -> UsecaseToken {
        self.tokens.types[self.p]
    }

    fn image(&self, k: usize) -> &'a str {
        &self.src[self.tokens.starts[k]..self.tokens.ends[k]]
    }

    fn span(&self, k: usize) -> Span {
        (self.tokens.starts[k], self.tokens.ends[k])
    }

    fn fail(&self, detail: &str) -> PeleError {
        let s = self.tokens.starts[self.p];
        let e = self.tokens.ends[self.p];
        let (line, column) = line_column(self.src, s, self.origin);
        PeleError::new(
            format!("Error parsing usecase diagram: {detail} at {}", location_text(self.src, s, e, self.origin)),
            ErrorCode::Syntax,
        )
        .with_diagram_type(DiagramType::Usecase)
        .with_location(SourceLocation {
            line,
            column,
            snippet: String::new(),
        })
    }

    fn mismatch(&self, name: &str) -> PeleError {
        self.fail(&format!("Expecting token of type --> {name} <-- but found --> '{}' <--", self.image(self.p)))
    }

    fn expect(&mut self, t: UsecaseToken) -> Result<usize, PeleError> {
        if self.cur() != t {
            return Err(self.mismatch(t.name()));
        }
        let k = self.p;
        self.p += 1;
        Ok(k)
    }

    fn no_alternative(&self, expected: &str) -> PeleError {
        let list: Vec<String> = expected.split('|').enumerate().map(|(i, seq)| format!("  {}. [{seq}]", i + 1)).collect();
        self.fail(&format!(
            "Expecting: one of these possible Token sequences:\n{}\nbut found: '{}'",
            list.join("\n"),
            self.image(self.p)
        ))
    }

    fn line_end(&mut self) -> Result<(), PeleError> {
        self.last_end = self.tokens.ends[self.p - 1];
        if self.cur() == UsecaseToken::Newline {
            self.p += 1;
            Ok(())
        } else if self.cur() == UsecaseToken::Eof {
            Ok(())
        } else {
            Err(self.no_alternative("NEWLINE|EOF"))
        }
    }

    fn content(&self, k: usize) -> Span {
        let trim = match self.tok(k) {
            UsecaseToken::MarkdownString => 2,
            UsecaseToken::PlainString => 1,
            _ => 0,
        };
        (self.tokens.starts[k] + trim, self.tokens.ends[k] - trim)
    }

    fn token_label(&self, k: usize) -> DraftLabel {
        let at = self.content(k);
        DraftLabel {
            text: self.src[at.0..at.1].to_string(),
            label_type: if self.tok(k) == UsecaseToken::MarkdownString {
                LabelType::Markdown
            } else {
                LabelType::Text
            },
            span: at,
        }
    }

    fn label(&mut self) -> Result<DraftLabel, PeleError> {
        let t = self.cur();
        if matches!(t, UsecaseToken::PlainString | UsecaseToken::MarkdownString) {
            let k = self.p;
            self.p += 1;
            return Ok(self.token_label(k));
        }
        if !t.is_label_text() {
            return Err(self.no_alternative(LABELS));
        }
        let first = self.p;
        while self.cur().is_label_text() {
            self.p += 1;
        }
        let at = (self.tokens.starts[first], self.tokens.ends[self.p - 1]);
        Ok(DraftLabel {
            text: self.src[at.0..at.1].to_string(),
            label_type: LabelType::Text,
            span: at,
        })
    }

    fn property(&mut self) -> Result<DraftProperty, PeleError> {
        let key = self.p;
        if !is_key(self.cur()) {
            return Err(self.no_alternative("IDENTIFIER|PLAIN_STRING"));
        }
        self.p += 1;
        self.expect(UsecaseToken::Colon)?;
        let value = self.p;
        let vt = self.cur();
        if !is_key(vt) && vt != UsecaseToken::True && vt != UsecaseToken::False {
            return Err(self.no_alternative("IDENTIFIER|PLAIN_STRING|TRUE|FALSE"));
        }
        self.p += 1;
        let key_span = self.content(key);
        let value_span = self.content(value);
        let val = match vt {
            UsecaseToken::True => PropertyValue::Bool(true),
            UsecaseToken::False => PropertyValue::Bool(false),
            _ => PropertyValue::Str(self.src[value_span.0..value_span.1].to_string()),
        };
        Ok(DraftProperty {
            key: self.src[key_span.0..key_span.1].to_string(),
            value: val,
            span: (self.tokens.starts[key], self.tokens.ends[value]),
            key_span,
            value_span,
        })
    }

    fn separator_ahead(&self) -> bool {
        let a = self.tok(self.p);
        let b = self.tok(self.p + 1);
        let c = self.tok(self.p + 2);
        if a == UsecaseToken::Comma {
            return is_key(b) || (b == UsecaseToken::Newline && (c == UsecaseToken::Newline || is_key(c)));
        }
        if a != UsecaseToken::Newline {
            return false;
        }
        b == UsecaseToken::Comma || is_key(b) || (b == UsecaseToken::Newline && (c == UsecaseToken::Newline || c == UsecaseToken::Comma || is_key(c)))
    }

    fn metadata(&mut self) -> Result<Vec<DraftProperty>, PeleError> {
        self.expect(UsecaseToken::MetadataStart)?;
        let mut properties = Vec::new();
        while self.cur() == UsecaseToken::Newline {
            self.p += 1;
        }
        if is_key(self.cur()) {
            properties.push(self.property()?);
            while self.separator_ahead() {
                if self.cur() == UsecaseToken::Comma {
                    self.p += 1;
                } else {
                    while self.cur() == UsecaseToken::Newline {
                        self.p += 1;
                    }
                    if self.cur() == UsecaseToken::Comma {
                        self.p += 1;
                    }
                }
                while self.cur() == UsecaseToken::Newline {
                    self.p += 1;
                }
                properties.push(self.property()?);
            }
            if self.cur() == UsecaseToken::Comma {
                self.p += 1;
            }
            while self.cur() == UsecaseToken::Newline {
                self.p += 1;
            }
        }
        self.expect(UsecaseToken::RBrace)?;
        Ok(properties)
    }

    fn class_suffix(&mut self, classes: &mut Vec<String>, spans: &mut Vec<Span>) -> Result<(), PeleError> {
        loop {
            self.p += 1;
            let id = self.expect(UsecaseToken::Identifier)?;
            classes.push(self.image(id).to_string());
            spans.push(self.span(id));
            if self.cur() != UsecaseToken::Comma {
                break;
            }
        }
        Ok(())
    }

    fn name(&mut self, brackets: bool) -> Result<Item, PeleError> {
        let k = self.p;
        let t = self.cur();
        let item_span = self.content(k);
        let generated = t != UsecaseToken::Identifier;
        let (id, label, shape) = match t {
            UsecaseToken::Identifier => {
                self.p += 1;
                let id_str = self.image(k).to_string();
                let open = self.cur();
                if open == UsecaseToken::LParen || (brackets && open == UsecaseToken::LBracket) {
                    self.p += 1;
                    let lbl = self.label()?;
                    self.expect(if open == UsecaseToken::LParen {
                        UsecaseToken::RParen
                    } else {
                        UsecaseToken::RBracket
                    })?;
                    let sh = if open == UsecaseToken::LParen {
                        UseCaseShape::Ellipse
                    } else {
                        UseCaseShape::Rect
                    };
                    (id_str, lbl, Some(sh))
                } else {
                    (id_str, self.token_label(k), None)
                }
            }
            UsecaseToken::PlainString | UsecaseToken::MarkdownString => {
                self.p += 1;
                let lbl = self.token_label(k);
                let gid = generated_id(&lbl.text);
                (gid, lbl, None)
            }
            _ => return Err(self.no_alternative(NAMES)),
        };
        Ok(Item {
            id,
            label,
            span: item_span,
            generated,
            shape,
            metadata: None,
            stereotype: None,
            stereotype_span: None,
            classes: Vec::new(),
            class_spans: Vec::new(),
            explicit: false,
            node_span: (0, 0),
        })
    }

    fn element(&mut self, actor: bool) -> Result<Item, PeleError> {
        let first = self.p;
        let mut item = self.name(!actor)?;
        if actor {
            item.shape = None;
        }
        if self.cur() == UsecaseToken::MetadataStart {
            item.metadata = Some(self.metadata()?);
        }
        if self.cur() == UsecaseToken::StereotypeStart {
            self.p += 1;
            let text_tok = self.expect(UsecaseToken::StereotypeText)?;
            self.expect(UsecaseToken::StereotypeEnd)?;
            item.stereotype = Some(self.image(text_tok).trim().to_string());
            item.stereotype_span = Some(self.span(text_tok));
        }
        if self.cur() == UsecaseToken::ClassSeparator {
            self.class_suffix(&mut item.classes, &mut item.class_spans)?;
        }
        item.explicit = item.shape.is_some() || item.metadata.is_some() || item.stereotype.is_some();
        item.node_span = (self.tokens.starts[first], self.tokens.ends[self.p - 1]);
        Ok(item)
    }

    fn draft_element(&self, item: &Item, kind: ElementKind) -> DraftElement {
        DraftElement {
            id: item.id.clone(),
            kind,
            label: item.label.clone(),
            span: item.span,
            generated: item.generated,
            parent: self.parent.clone(),
            shape: item.shape,
            metadata: item.metadata.clone(),
            stereotype: item.stereotype.clone(),
            classes: item.classes.clone(),
        }
    }

    fn draft_endpoint(item: &Item, declares: bool) -> DraftEndpoint {
        DraftEndpoint {
            id: item.id.clone(),
            label: item.label.clone(),
            span: item.span,
            generated: item.generated,
            declares,
            classed: !item.classes.is_empty(),
        }
    }

    fn occurrence(item: &Item, defines: bool) -> NodeOccurrence {
        NodeOccurrence {
            id: item.id.clone(),
            span: item.node_span,
            id_span: item.span,
            label_span: Some(item.label.span),
            defines,
            stereotype_span: item.stereotype_span,
            metadata: item.metadata.as_ref().map(|props| props.iter().map(DraftProperty::to_occurrence).collect()),
            class_spans: (!item.class_spans.is_empty()).then(|| item.class_spans.clone()),
        }
    }

    fn labeled_right(&self, allow_forward: bool) -> bool {
        if !self.cur().is_label_item() {
            return false;
        }
        let mut k = self.p + 1;
        loop {
            let t = self.tok(k);
            if t == UsecaseToken::MarkerlessSolid || (allow_forward && closes_label(t)) {
                return true;
            }
            if !t.is_label_item() {
                return false;
            }
            k += 1;
        }
    }

    fn minimum_length(&self, k: usize) -> i32 {
        let len = (self.tokens.ends[k] - self.tokens.starts[k]) as i32;
        let dashes = len - if self.tok(k) == UsecaseToken::MarkerlessSolid { 0 } else { 1 };
        (dashes - 1).max(1)
    }

    fn relation_tail(&mut self) -> Result<Tail, PeleError> {
        let first = self.p;
        let mut explicit_id = None;
        let mut explicit_id_span = None;
        if self.cur() == UsecaseToken::Identifier && self.tok(self.p + 1) == UsecaseToken::At {
            explicit_id = Some(self.image(self.p).to_string());
            explicit_id_span = Some(self.span(self.p));
            self.p += 2;
        }
        let k = self.p;
        let t = self.cur();
        self.p += 1;

        let mut rel_type = RelationshipType::Association;
        let mut arrow_type = Arrow::SolidArrow;
        let mut lbl: Option<DraftLabel> = None;
        let mut minlen = 1i32;

        match t {
            UsecaseToken::DependencyArrow => {
                self.expect(UsecaseToken::Colon)?;
                let kind_tok = self.cur();
                if kind_tok != UsecaseToken::Include && kind_tok != UsecaseToken::Extend {
                    return Err(self.no_alternative("INCLUDE|EXTEND"));
                }
                rel_type = if kind_tok == UsecaseToken::Include {
                    RelationshipType::Include
                } else {
                    RelationshipType::Extend
                };
                lbl = Some(DraftLabel {
                    text: rel_type.as_str().to_string(),
                    label_type: LabelType::Text,
                    span: self.span(self.p),
                });
                self.p += 1;
            }
            UsecaseToken::Generalization => {
                rel_type = RelationshipType::Generalization;
            }
            UsecaseToken::ForwardSolid => {
                minlen = self.minimum_length(k);
            }
            UsecaseToken::BackwardSolid => {
                arrow_type = Arrow::BackArrow;
                if self.tokens.ends[k] - self.tokens.starts[k] == 3 && self.labeled_right(false) {
                    lbl = Some(self.label()?);
                    let close_k = self.expect(UsecaseToken::MarkerlessSolid)?;
                    minlen = self.minimum_length(close_k);
                } else {
                    minlen = self.minimum_length(k);
                }
            }
            UsecaseToken::MarkerlessSolid => {
                arrow_type = Arrow::LineSolid;
                if self.tokens.ends[k] - self.tokens.starts[k] == 2 && self.labeled_right(true) {
                    lbl = Some(self.label()?);
                    let close = self.cur();
                    match close {
                        UsecaseToken::ForwardSolid => arrow_type = Arrow::SolidArrow,
                        UsecaseToken::ForwardCircle => arrow_type = Arrow::CircleArrow,
                        UsecaseToken::ForwardCross => arrow_type = Arrow::CrossArrow,
                        UsecaseToken::MarkerlessSolid => {}
                        _ => return Err(self.no_alternative("FORWARD_SOLID|MARKERLESS_SOLID|FORWARD_CIRCLE|FORWARD_CROSS")),
                    }
                    if matches!(arrow_type, Arrow::SolidArrow | Arrow::LineSolid) {
                        minlen = self.minimum_length(self.p);
                    }
                    self.p += 1;
                } else {
                    minlen = self.minimum_length(k);
                }
            }
            UsecaseToken::ForwardCircle => {
                arrow_type = Arrow::CircleArrow;
            }
            UsecaseToken::ForwardCross => {
                arrow_type = Arrow::CrossArrow;
            }
            UsecaseToken::BackwardCircle | UsecaseToken::BackwardCross => {
                arrow_type = if t == UsecaseToken::BackwardCircle {
                    Arrow::CircleArrowReversed
                } else {
                    Arrow::CrossArrowReversed
                };
                if self.labeled_right(false) {
                    lbl = Some(self.label()?);
                    self.expect(UsecaseToken::MarkerlessSolid)?;
                }
            }
            _ => {
                self.p -= 1;
                return Err(self.no_alternative(ARROWS));
            }
        }
        let target = self.element(false)?;
        let tail_span = (self.tokens.starts[first], self.tokens.ends[self.p - 1]);
        Ok(Tail {
            explicit_id,
            explicit_id_span,
            rel_type,
            arrow_type,
            label: lbl,
            minlen,
            target,
            span: tail_span,
        })
    }

    fn relationship(&mut self, source: &Item, declaration: bool, tail: Tail, mut nodes: Vec<NodeOccurrence>) -> GraphStatement {
        if tail.target.explicit {
            let elem = self.draft_element(&tail.target, ElementKind::Usecase);
            self.drafts.elements.push(elem);
        }
        let edge_id = match &tail.explicit_id {
            Some(id) => id.clone(),
            None => {
                let s = format!("edge-{}", self.edge_count);
                self.edge_count += 1;
                s
            }
        };
        let label_span = tail.label.as_ref().map(|l| l.span);
        let id_span = tail.explicit_id_span;
        nodes.push(Self::occurrence(&tail.target, tail.target.explicit));
        self.drafts.relationships.push(DraftRelationship {
            source: Self::draft_endpoint(source, declaration),
            target: Self::draft_endpoint(&tail.target, tail.target.explicit),
            span: tail.span,
            id: tail.explicit_id,
            id_span: tail.explicit_id_span,
            rel_type: tail.rel_type,
            arrow_type: tail.arrow_type,
            label: tail.label,
            minlen: tail.minlen,
        });
        let mut out = GraphStatement::new(StatementKind::Edge, (0, 0));
        out.nodes = Some(nodes);
        out.edges = Some(vec![EdgeOccurrence {
            id: edge_id,
            span: (0, 0),
            label_span,
            id_span,
            metadata: None,
        }]);
        out
    }

    fn declaration(nodes: Vec<NodeOccurrence>) -> GraphStatement {
        let mut out = GraphStatement::new(StatementKind::Node, (0, 0));
        out.nodes = Some(nodes);
        out
    }

    fn actors(&mut self, top: bool) -> Result<GraphStatement, PeleError> {
        self.p += 1;
        let mut items = vec![self.element(true)?];
        let mut tail: Option<Tail> = None;
        if self.cur() == UsecaseToken::Comma {
            while self.cur() == UsecaseToken::Comma {
                self.p += 1;
                items.push(self.element(true)?);
            }
        } else if top && is_relation(self.cur()) {
            tail = Some(self.relation_tail()?);
        }
        self.line_end()?;
        for item in &items {
            let elem = self.draft_element(item, ElementKind::Actor);
            self.drafts.elements.push(elem);
        }
        let nodes: Vec<NodeOccurrence> = items.iter().map(|it| Self::occurrence(it, true)).collect();
        Ok(match tail {
            Some(t) => self.relationship(&items[0], true, t, nodes),
            None => Self::declaration(nodes),
        })
    }

    fn entity(&mut self, top: bool) -> Result<GraphStatement, PeleError> {
        let mut source = self.element(false)?;
        let tail = if top && is_relation(self.cur()) { Some(self.relation_tail()?) } else { None };
        self.line_end()?;
        if tail.is_none() {
            source.explicit = true;
            if source.shape.is_none() {
                source.shape = Some(UseCaseShape::Ellipse);
            }
        }
        if source.explicit {
            let elem = self.draft_element(&source, ElementKind::Usecase);
            self.drafts.elements.push(elem);
        }
        let nodes = vec![Self::occurrence(&source, source.explicit)];
        Ok(match tail {
            Some(t) => self.relationship(&source, source.explicit, t, nodes),
            None => Self::declaration(nodes),
        })
    }

    fn boundary(&mut self) -> Result<GraphStatement, PeleError> {
        self.p += 1;
        let mut named = self.name(true)?;
        let inline = if self.cur() == UsecaseToken::MetadataStart {
            Some(self.metadata()?)
        } else {
            None
        };
        if self.cur() == UsecaseToken::ClassSeparator {
            self.class_suffix(&mut named.classes, &mut named.class_spans)?;
        }
        self.line_end()?;
        let group_id = named.id.clone();
        let group_span = named.span;
        let group = DraftBoundary {
            id: named.id,
            label: named.label.clone(),
            span: named.span,
            generated: named.generated,
            classes: named.classes,
        };
        self.drafts.boundaries.push(group);
        self.parent = Some((group_id.clone(), group_span));
        let mut children: Vec<GraphStatement> = Vec::new();
        while is_boundary_line(self.cur()) {
            children.push(self.line(false)?);
        }
        self.parent = None;
        let end = self.expect(UsecaseToken::End)?;
        self.line_end()?;
        let mut out = GraphStatement::new(StatementKind::Group, (0, 0));
        out.group = Some(group_id.clone());
        out.id_span = Some(group_span);
        out.title_span = Some(named.label.span);
        out.end_span = Some(self.span(end));
        out.class_spans = Some(named.class_spans);
        if !children.is_empty() {
            out.children = Some(children);
        }
        if let Some(props) = inline {
            let occs: Vec<MetadataOccurrence> = props.iter().map(DraftProperty::to_occurrence).collect();
            out.metadata = Some(occs);
            self.drafts.metadata.push(DraftMetadata {
                target: group_id,
                span: group_span,
                properties: props,
                stmt_index: None,
            });
        }
        Ok(out)
    }

    fn style(&mut self) -> Result<String, PeleError> {
        let first = self.p;
        let t = self.cur();
        if t.is_word() || t == UsecaseToken::CssIdentifier {
            self.p += 1;
        } else if t == UsecaseToken::MarkerlessSolid {
            self.p += 1;
            if !self.cur().is_word() {
                return Err(self.mismatch("WORD"));
            }
            self.p += 1;
        } else {
            return Err(self.no_alternative("WORD|CSS_IDENTIFIER|MARKERLESS_SOLID"));
        }
        self.expect(UsecaseToken::Colon)?;
        if !is_style_part(self.cur()) {
            return Err(self.fail(&format!(
                "Expecting: expecting at least one iteration which starts with one of these possible Token sequences::\n  <[{}]>\nbut found: '{}'",
                STYLE_PARTS.replace('|', "] ,["),
                self.image(self.p)
            )));
        }
        while is_style_part(self.cur()) {
            self.p += 1;
        }
        Ok(self.src[self.tokens.starts[first]..self.tokens.ends[self.p - 1]].replace("\\,", ","))
    }

    fn styles(&mut self) -> Result<Vec<String>, PeleError> {
        let mut out = vec![self.style()?];
        while self.cur() == UsecaseToken::Comma {
            self.p += 1;
            out.push(self.style()?);
        }
        Ok(out)
    }

    fn identifiers(&mut self) -> Result<Vec<usize>, PeleError> {
        let mut out = vec![self.expect(UsecaseToken::Identifier)?];
        while self.cur() == UsecaseToken::Comma {
            self.p += 1;
            out.push(self.expect(UsecaseToken::Identifier)?);
        }
        Ok(out)
    }

    fn reference(&self, k: usize) -> NodeOccurrence {
        let at = self.content(k);
        NodeOccurrence {
            id: self.image(k).to_string(),
            span: at,
            id_span: at,
            label_span: None,
            defines: false,
            stereotype_span: None,
            metadata: None,
            class_spans: None,
        }
    }

    fn top_statement(&mut self) -> Result<GraphStatement, PeleError> {
        let k = self.p;
        let t = self.cur();
        let out = match t {
            UsecaseToken::AccTitleLine => {
                self.p += 1;
                let text = self.image(k);
                let colon = text.find(':').unwrap();
                self.drafts.acc_title = text[colon + 1..].trim().to_string();
                GraphStatement::new(StatementKind::AccTitle, (0, 0))
            }
            UsecaseToken::AccDescrLine => {
                self.p += 1;
                let text = self.image(k);
                let colon = text.find(':').unwrap();
                self.drafts.acc_description = text[colon + 1..].trim().to_string();
                GraphStatement::new(StatementKind::AccDescr, (0, 0))
            }
            UsecaseToken::AccDescrBlock => {
                self.p += 1;
                let text = self.image(k);
                let open = text.find('{').unwrap();
                let close = text.rfind('}').unwrap();
                self.drafts.acc_description = text[open + 1..close].trim().to_string();
                GraphStatement::new(StatementKind::AccDescr, (0, 0))
            }
            UsecaseToken::Direction => {
                self.p += 1;
                let dir = match self.cur() {
                    UsecaseToken::Td | UsecaseToken::Tb => Direction::TB,
                    UsecaseToken::Bt => Direction::BT,
                    UsecaseToken::Lr => Direction::LR,
                    UsecaseToken::Rl => Direction::RL,
                    _ => return Err(self.no_alternative("TD|TB|BT|LR|RL")),
                };
                self.drafts.direction = Some(dir);
                self.p += 1;
                GraphStatement::new(StatementKind::Direction, (0, 0))
            }
            UsecaseToken::Actor => return self.actors(true),
            UsecaseToken::SystemBoundary => return self.boundary(),
            UsecaseToken::Note => {
                self.p += 1;
                self.expect(UsecaseToken::For)?;
                let target = self.expect(UsecaseToken::Identifier)?;
                let text = self.label()?;
                let text_span = text.span;
                self.drafts.notes.push(DraftNote {
                    target: self.image(target).to_string(),
                    span: self.span(target),
                    label: text,
                });
                let mut stmt = GraphStatement::new(StatementKind::Note, (0, 0));
                stmt.ref_id = Some(format!("note-{}", self.note_count));
                self.note_count += 1;
                stmt.ref_span = Some(text_span);
                stmt.nodes = Some(vec![self.reference(target)]);
                stmt
            }
            UsecaseToken::JsonDeclarationStart => {
                self.p += 1;
                let literal = self.expect(UsecaseToken::JsonObjectLiteral)?;
                let mut classes = Vec::new();
                let mut class_spans = Vec::new();
                if self.cur() == UsecaseToken::ClassSeparator {
                    self.class_suffix(&mut classes, &mut class_spans)?;
                }
                let bytes = self.src.as_bytes();
                let mut from = self.tokens.starts[k] + 4;
                while from < bytes.len() && matches!(bytes[from], b' ' | b'\t') {
                    from += 1;
                }
                let mut to = from;
                while to < bytes.len() && is_word(bytes[to] as u32) {
                    to += 1;
                }
                let id = self.src[from..to].to_string();
                let id_span = (from, to);
                let json_idx = self.drafts.jsons.len();
                self.drafts.jsons.push(DraftJson {
                    id: id.clone(),
                    value: IndexMap::new(),
                    property_order: IndexMap::new(),
                    span: id_span,
                    classes,
                });
                self.pending_json.push((json_idx, literal));
                let mut stmt = GraphStatement::new(StatementKind::Json, (0, 0));
                stmt.nodes = Some(vec![NodeOccurrence {
                    id,
                    span: id_span,
                    id_span,
                    label_span: None,
                    defines: true,
                    stereotype_span: None,
                    metadata: None,
                    class_spans: Some(class_spans.clone()),
                }]);
                stmt.class_spans = Some(class_spans);
                stmt
            }
            UsecaseToken::ClassDef => {
                self.p += 1;
                let ids = self.identifiers()?;
                let style_list = self.styles()?;
                let first_id = ids[0];
                self.drafts.class_defs.push(DraftClassDef {
                    ids: ids.iter().map(|&id| self.image(id).to_string()).collect(),
                    styles: style_list,
                });
                let mut stmt = GraphStatement::new(StatementKind::ClassDef, (0, 0));
                stmt.ref_id = Some(self.image(first_id).to_string());
                stmt.ref_span = Some(self.span(first_id));
                stmt
            }
            UsecaseToken::Class => {
                self.p += 1;
                let targets = self.identifiers()?;
                let classes = self.identifiers()?;
                let first_cls = classes[0];
                self.drafts.classes.push(DraftClassAssign {
                    targets: targets.iter().map(|&id| (self.image(id).to_string(), self.span(id))).collect(),
                    classes: classes.iter().map(|&id| self.image(id).to_string()).collect(),
                });
                let mut stmt = GraphStatement::new(StatementKind::ClassAssign, (0, 0));
                stmt.ref_id = Some(self.image(first_cls).to_string());
                stmt.ref_span = Some(self.span(first_cls));
                stmt.nodes = Some(targets.iter().map(|&id| self.reference(id)).collect());
                stmt
            }
            UsecaseToken::Style => {
                self.p += 1;
                let target = self.expect(UsecaseToken::Identifier)?;
                let style_list = self.styles()?;
                self.drafts.styles.push(DraftStyleAssign {
                    target: self.image(target).to_string(),
                    span: self.span(target),
                    styles: style_list,
                });
                let mut stmt = GraphStatement::new(StatementKind::Style, (0, 0));
                stmt.nodes = Some(vec![self.reference(target)]);
                stmt
            }
            _ => {
                let next = self.tok(self.p + 1);
                if next == UsecaseToken::MetadataStart {
                    if !is_metadata_first(self.tok(self.p + 2)) {
                        return Err(self.no_alternative(&statement_sequences()));
                    }
                    self.p += 1;
                    let mut target = self.reference(k);
                    if t != UsecaseToken::Identifier {
                        target.id = generated_id(&self.src[target.span.0..target.span.1]);
                    }
                    let assigned = self.metadata()?;
                    let occs: Vec<MetadataOccurrence> = assigned.iter().map(DraftProperty::to_occurrence).collect();
                    let target_id = target.id.clone();
                    let target_span = target.span;
                    let mut stmt = GraphStatement::new(StatementKind::Metadata, (0, 0));
                    stmt.nodes = Some(vec![target]);
                    stmt.metadata = Some(occs);
                    self.drafts.metadata.push(DraftMetadata {
                        target: target_id,
                        span: target_span,
                        properties: assigned,
                        stmt_index: Some(self.top_stmt_index),
                    });
                    stmt
                } else {
                    let follows = follows_name(next) || (t == UsecaseToken::Identifier && matches!(next, UsecaseToken::LParen | UsecaseToken::LBracket));
                    if !follows || (t == UsecaseToken::Identifier && is_forbidden(self.image(k))) {
                        return Err(self.no_alternative(&statement_sequences()));
                    }
                    return self.entity(true);
                }
            }
        };
        self.line_end()?;
        Ok(out)
    }

    fn line(&mut self, top: bool) -> Result<GraphStatement, PeleError> {
        let k = self.p;
        let t = self.cur();
        if t == UsecaseToken::Newline {
            self.p += 1;
            return Ok(GraphStatement::new(StatementKind::Blank, self.span(k)));
        }
        if t == UsecaseToken::Comment {
            self.p += 1;
            self.line_end()?;
            return Ok(GraphStatement::new(StatementKind::Comment, self.span(k)));
        }
        let mut out = if top {
            self.top_statement()?
        } else if t == UsecaseToken::Actor {
            self.actors(false)?
        } else {
            self.entity(false)?
        };
        out.span = (self.tokens.starts[k], self.last_end);
        if let Some(ref mut edges) = out.edges {
            for edge in edges {
                edge.span = out.span;
            }
        }
        Ok(out)
    }
}

pub fn parse_usecase(source: &str, title: Option<&str>, origin: Option<&SourceMap<'_>>) -> Result<UsecaseModel, PeleError> {
    let tokens = tokenize(source, origin)?;
    let mut parser = Parser {
        src: source,
        origin,
        tokens,
        p: 0,
        last_end: 0,
        drafts: Drafts::default(),
        parent: None,
        pending_json: Vec::new(),
        edge_count: 0,
        note_count: 0,
        top_stmt_index: 0,
    };

    let header = parser.expect(UsecaseToken::Usecase)?;
    let header_span = parser.span(header);
    parser.line_end()?;

    let mut statements: Vec<GraphStatement> = Vec::new();
    while is_line(parser.cur()) {
        parser.top_stmt_index = statements.len();
        let stmt = parser.line(true)?;
        statements.push(stmt);
    }
    if parser.cur() != UsecaseToken::Eof {
        return Err(parser.fail(&format!("Redundant input, expecting EOF but found: {}", parser.image(parser.p))));
    }

    // The whole text has to be well formed before the JSON in it is looked at, as in Mermaid.
    for &(json_idx, literal_tok) in &parser.pending_json {
        let lit_str = parser.image(literal_tok);
        let lit_start = parser.tokens.starts[literal_tok];
        let parsed = parse_ordered_json(lit_str, || line_column(source, lit_start, origin))?;
        parser.drafts.jsons[json_idx].value = parsed.value;
        parser.drafts.jsons[json_idx].property_order = parsed.property_order;
    }

    resolve_usecase(source, parser.drafts, header_span, statements, title.map(str::to_string), origin)
}
