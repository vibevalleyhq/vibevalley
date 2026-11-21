use indexmap::IndexMap;

use crate::detect::DiagramType;
use crate::error::{Edit, PeleError, SourceMap, input_offset, syntax_error};
use crate::util::chars::is_space_char;

use super::db::FlowDb;
use super::lexer::tokenize;
use super::tokens::FlowToken;
use super::types::{DocItem, FlowLinkInfo, FlowText, LabelType};

const TEXT_TOKENS: &str = "'UNICODE_TEXT', 'TEXT', 'TAGSTART'";
const STATEMENT_START: &str = "'SEMI', 'NEWLINE', 'SPACE', 'EOF', 'subgraph', 'acc_title', 'acc_descr', 'acc_descr_multiline_value', 'STYLE', 'LINKSTYLE', 'CLASSDEF', 'CLASS', 'CLICK', 'NODE_STRING'";

fn is_id_token(t: FlowToken) -> bool {
    matches!(
        t,
        FlowToken::Num
            | FlowToken::NodeString
            | FlowToken::Down
            | FlowToken::Minus
            | FlowToken::Default
            | FlowToken::Comma
            | FlowToken::Colon
            | FlowToken::Amp
            | FlowToken::Brkt
            | FlowToken::Mult
            | FlowToken::UnicodeText
    )
}

fn is_alphanum_token(t: FlowToken) -> bool {
    matches!(
        t,
        FlowToken::Num
            | FlowToken::UnicodeText
            | FlowToken::NodeString
            | FlowToken::Dir
            | FlowToken::Down
            | FlowToken::Minus
            | FlowToken::Comma
            | FlowToken::Colon
            | FlowToken::Amp
            | FlowToken::Brkt
            | FlowToken::Mult
    )
}

fn is_no_tags_token(t: FlowToken) -> bool {
    matches!(
        t,
        FlowToken::Num
            | FlowToken::NodeString
            | FlowToken::Space
            | FlowToken::Minus
            | FlowToken::Amp
            | FlowToken::UnicodeText
            | FlowToken::Colon
            | FlowToken::Mult
            | FlowToken::Brkt
            | FlowToken::Style
            | FlowToken::LinkStyle
            | FlowToken::ClassDef
            | FlowToken::Class
            | FlowToken::Click
            | FlowToken::Graph
            | FlowToken::Dir
            | FlowToken::Subgraph
            | FlowToken::EndKw
            | FlowToken::Down
            | FlowToken::Up
            | FlowToken::StartLink
    )
}

fn is_style_part(t: FlowToken) -> bool {
    matches!(
        t,
        FlowToken::Num | FlowToken::NodeString | FlowToken::Colon | FlowToken::Space | FlowToken::Brkt | FlowToken::Style
    )
}

/// Replaces `/}\s*\n/g` with `}\n` and records byte-offset edits for error reporting.
fn strip_brace_trail(source: &str) -> Option<(String, Vec<Edit>)> {
    if !source.contains('}') {
        return None;
    }
    let mut out = String::with_capacity(source.len());
    let mut edits = Vec::new();
    let bytes = source.as_bytes();
    let n = bytes.len();
    let mut i = 0;
    let mut changed = false;

    while i < n {
        if bytes[i] == b'}' {
            let mut j = i + 1;
            let mut last_nl: Option<usize> = None;
            while j < n {
                let b = bytes[j];
                if b < 128 {
                    if b == b'\n' {
                        last_nl = Some(j);
                        j += 1;
                    } else if matches!(b, b' ' | b'\t' | b'\r' | 0x0b | 0x0c) {
                        j += 1;
                    } else {
                        break;
                    }
                } else {
                    let ch = source[j..].chars().next().unwrap();
                    if is_space_char(ch) {
                        j += ch.len_utf8();
                    } else {
                        break;
                    }
                }
            }
            if let Some(nl_pos) = last_nl {
                let match_end = nl_pos + 1;
                let removed = match_end - i;
                if removed != 2 {
                    changed = true;
                }
                out.push_str("}\n");
                edits.push(Edit::new(i, match_end, 2));
                i = match_end;
                continue;
            }
        }
        let ch = source[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }

    if changed { Some((out, edits)) } else { None }
}

struct Frame {
    id: Option<FlowText>,
    title: Option<FlowText>,
    same_id_and_title: bool,
    list: Vec<DocItem>,
    collect: bool,
}

struct Parser<'a> {
    source: &'a str,
    brace_edits: Option<Vec<Edit>>,
    origin: Option<&'a SourceMap<'a>>,
    types: Vec<FlowToken>,
    texts: Vec<String>,
    starts: Vec<usize>,
    i: usize,
    pending_data: Option<String>,
}

impl<'a> Parser<'a> {
    fn fail(&self, expected: &str) -> PeleError {
        let t = self.types[self.i];
        let at = match &self.brace_edits {
            Some(edits) => input_offset(std::slice::from_ref(edits), self.starts[self.i]),
            None => self.starts[self.i],
        };
        if t == FlowToken::Error {
            return syntax_error(DiagramType::Flowchart, self.source, at, "", true, self.origin);
        }
        syntax_error(
            DiagramType::Flowchart,
            self.source,
            at,
            &format!("Expecting {expected}, got '{}'", t.name()),
            false,
            self.origin,
        )
    }

    fn expect(&mut self, token: FlowToken, also: &str) -> Result<String, PeleError> {
        if self.types[self.i] != token {
            let exp = if also.is_empty() {
                format!("'{}'", token.name())
            } else {
                format!("'{}', {also}", token.name())
            };
            return Err(self.fail(&exp));
        }
        let s = self.texts[self.i].clone();
        self.i += 1;
        Ok(s)
    }

    fn separator(&mut self) -> Result<(), PeleError> {
        let t = self.types[self.i];
        if !matches!(t, FlowToken::Newline | FlowToken::Semi | FlowToken::Eof) {
            return Err(self.fail("'SEMI', 'NEWLINE', 'EOF'"));
        }
        self.i += 1;
        Ok(())
    }

    fn id_string(&mut self) -> Result<String, PeleError> {
        if !is_id_token(self.types[self.i]) {
            return Err(self.fail("'NODE_STRING'"));
        }
        let mut s = self.texts[self.i].clone();
        self.i += 1;
        while is_id_token(self.types[self.i]) {
            s.push_str(&self.texts[self.i]);
            self.i += 1;
        }
        Ok(s)
    }

    fn alpha_num(&mut self) -> Result<String, PeleError> {
        if !is_alphanum_token(self.types[self.i]) {
            return Err(self.fail("'NODE_STRING'"));
        }
        let mut s = self.texts[self.i].clone();
        self.i += 1;
        while is_alphanum_token(self.types[self.i]) {
            s.push_str(&self.texts[self.i]);
            self.i += 1;
        }
        Ok(s)
    }

    fn text(&mut self) -> Result<FlowText, PeleError> {
        let label_type = match self.types[self.i] {
            FlowToken::Str => LabelType::String,
            FlowToken::MdStr => LabelType::Markdown,
            FlowToken::Text | FlowToken::TagStart | FlowToken::TagEnd | FlowToken::UnicodeText => LabelType::Text,
            _ => return Err(self.fail(&format!("{TEXT_TOKENS}, 'TAGEND', 'STR', 'MD_STR'"))),
        };
        let mut s = self.texts[self.i].clone();
        self.i += 1;
        while matches!(
            self.types[self.i],
            FlowToken::Text | FlowToken::TagStart | FlowToken::TagEnd | FlowToken::UnicodeText
        ) {
            s.push_str(&self.texts[self.i]);
            self.i += 1;
        }
        Ok(FlowText { text: s, label_type })
    }

    fn closed(&mut self, token: FlowToken) -> Result<(), PeleError> {
        self.expect(token, TEXT_TOKENS)?;
        Ok(())
    }

    fn edge_text(&mut self) -> Result<FlowText, PeleError> {
        let label_type = match self.types[self.i] {
            FlowToken::Str => LabelType::String,
            FlowToken::MdStr => LabelType::Markdown,
            FlowToken::EdgeText | FlowToken::UnicodeText => LabelType::Text,
            _ => return Err(self.fail("'EDGE_TEXT', 'STR', 'MD_STR'")),
        };
        let mut s = self.texts[self.i].clone();
        self.i += 1;
        while matches!(self.types[self.i], FlowToken::EdgeText | FlowToken::UnicodeText) {
            s.push_str(&self.texts[self.i]);
            self.i += 1;
        }
        Ok(FlowText { text: s, label_type })
    }

    fn text_no_tags(&mut self) -> Result<FlowText, PeleError> {
        let t = self.types[self.i];
        let label_type = if t == FlowToken::Str {
            LabelType::Text
        } else if t == FlowToken::MdStr {
            LabelType::Markdown
        } else if is_no_tags_token(t) {
            LabelType::Text
        } else {
            return Err(self.fail("'NODE_STRING', 'STR', 'MD_STR'"));
        };
        let mut s = self.texts[self.i].clone();
        self.i += 1;
        while is_no_tags_token(self.types[self.i]) {
            s.push_str(&self.texts[self.i]);
            self.i += 1;
        }
        Ok(FlowText { text: s, label_type })
    }

    fn shape_data(&mut self) -> String {
        let mut s = self.texts[self.i].clone();
        self.i += 1;
        while self.types[self.i] == FlowToken::ShapeData {
            s.push_str(&self.texts[self.i]);
            self.i += 1;
        }
        s
    }

    fn vertex(&mut self, db: &mut FlowDb) -> Result<String, PeleError> {
        let id = self.id_string()?;
        match self.types[self.i] {
            FlowToken::Sqs => {
                self.i += 1;
                let label = self.text()?;
                self.closed(FlowToken::Sqe)?;
                db.add_vertex(&id, Some(label), Some("square"), None, None, None, None, None)?;
            }
            FlowToken::DoubleCircleStart => {
                self.i += 1;
                let label = self.text()?;
                self.closed(FlowToken::DoubleCircleEnd)?;
                db.add_vertex(&id, Some(label), Some("doublecircle"), None, None, None, None, None)?;
            }
            FlowToken::Ps => {
                self.i += 1;
                if self.types[self.i] == FlowToken::Ps {
                    self.i += 1;
                    let label = self.text()?;
                    self.closed(FlowToken::Pe)?;
                    self.expect(FlowToken::Pe, "")?;
                    db.add_vertex(&id, Some(label), Some("circle"), None, None, None, None, None)?;
                } else {
                    let label = self.text()?;
                    self.closed(FlowToken::Pe)?;
                    db.add_vertex(&id, Some(label), Some("round"), None, None, None, None, None)?;
                }
            }
            FlowToken::EllipseStart => {
                self.i += 1;
                let label = self.text()?;
                self.closed(FlowToken::EllipseEnd)?;
                db.add_vertex(&id, Some(label), Some("ellipse"), None, None, None, None, None)?;
            }
            FlowToken::StadiumStart => {
                self.i += 1;
                let label = self.text()?;
                self.closed(FlowToken::StadiumEnd)?;
                db.add_vertex(&id, Some(label), Some("stadium"), None, None, None, None, None)?;
            }
            FlowToken::SubroutineStart => {
                self.i += 1;
                let label = self.text()?;
                self.closed(FlowToken::SubroutineEnd)?;
                db.add_vertex(&id, Some(label), Some("subroutine"), None, None, None, None, None)?;
            }
            FlowToken::VertexWithPropsStart => {
                self.i += 1;
                let field = self.expect(FlowToken::NodeString, "")?;
                self.expect(FlowToken::Colon, "")?;
                let value = self.expect(FlowToken::NodeString, "")?;
                self.expect(FlowToken::Pipe, "")?;
                let label = self.text()?;
                self.closed(FlowToken::Sqe)?;
                let mut props = IndexMap::new();
                props.insert(field, value);
                db.add_vertex(&id, Some(label), Some("rect"), None, None, None, Some(props), None)?;
            }
            FlowToken::CylinderStart => {
                self.i += 1;
                let label = self.text()?;
                self.closed(FlowToken::CylinderEnd)?;
                db.add_vertex(&id, Some(label), Some("cylinder"), None, None, None, None, None)?;
            }
            FlowToken::DiamondStart => {
                self.i += 1;
                if self.types[self.i] == FlowToken::DiamondStart {
                    self.i += 1;
                    let label = self.text()?;
                    self.closed(FlowToken::DiamondStop)?;
                    self.expect(FlowToken::DiamondStop, "")?;
                    db.add_vertex(&id, Some(label), Some("hexagon"), None, None, None, None, None)?;
                } else {
                    let label = self.text()?;
                    self.closed(FlowToken::DiamondStop)?;
                    db.add_vertex(&id, Some(label), Some("diamond"), None, None, None, None, None)?;
                }
            }
            FlowToken::TagEnd => {
                self.i += 1;
                let label = self.text()?;
                self.closed(FlowToken::Sqe)?;
                db.add_vertex(&id, Some(label), Some("odd"), None, None, None, None, None)?;
            }
            FlowToken::TrapStart => {
                self.i += 1;
                let label = self.text()?;
                if self.types[self.i] == FlowToken::InvTrapEnd {
                    self.i += 1;
                    db.add_vertex(&id, Some(label), Some("lean_right"), None, None, None, None, None)?;
                } else {
                    self.closed(FlowToken::TrapEnd)?;
                    db.add_vertex(&id, Some(label), Some("trapezoid"), None, None, None, None, None)?;
                }
            }
            FlowToken::InvTrapStart => {
                self.i += 1;
                let label = self.text()?;
                if self.types[self.i] == FlowToken::TrapEnd {
                    self.i += 1;
                    db.add_vertex(&id, Some(label), Some("lean_left"), None, None, None, None, None)?;
                } else {
                    self.closed(FlowToken::InvTrapEnd)?;
                    db.add_vertex(&id, Some(label), Some("inv_trapezoid"), None, None, None, None, None)?;
                }
            }
            _ => {
                db.add_vertex(&id, None, None, None, None, None, None, None)?;
            }
        }
        Ok(id)
    }

    fn styled_vertex(&mut self, db: &mut FlowDb) -> Result<String, PeleError> {
        let id = self.vertex(db)?;
        if self.types[self.i] == FlowToken::StyleSeparator {
            self.i += 1;
            let cls = self.id_string()?;
            db.set_class(&id, &cls);
        }
        Ok(id)
    }

    fn node(&mut self, db: &mut FlowDb) -> Result<Vec<String>, PeleError> {
        let mut ids = vec![self.styled_vertex(db)?];
        self.pending_data = None;
        loop {
            let data = if self.types[self.i] == FlowToken::ShapeData {
                Some(self.shape_data())
            } else {
                None
            };
            if self.types[self.i] != FlowToken::Space {
                self.pending_data = data;
                return Ok(ids);
            }
            while self.types[self.i] == FlowToken::Space {
                self.i += 1;
            }
            if self.types[self.i] != FlowToken::Amp {
                if data.is_some() {
                    return Err(self.fail("'AMP'"));
                }
                return Ok(ids);
            }
            self.i += 1;
            if self.types[self.i] != FlowToken::Space {
                return Err(self.fail("'SPACE'"));
            }
            while self.types[self.i] == FlowToken::Space {
                self.i += 1;
            }
            let next = self.styled_vertex(db)?;
            if let Some(meta) = data {
                let last_id = ids.last().unwrap().clone();
                db.add_vertex(&last_id, None, None, None, None, None, None, Some(&meta))?;
            }
            ids.push(next);
        }
    }

    fn link(&mut self, db: &FlowDb) -> Result<FlowLinkInfo, PeleError> {
        let mut id: Option<String> = None;
        if self.types[self.i] == FlowToken::LinkId {
            id = Some(self.texts[self.i].clone());
            self.i += 1;
        }
        if self.types[self.i] == FlowToken::Link {
            let raw = self.texts[self.i].clone();
            self.i += 1;
            let mut info = db.destruct_link(&raw, None);
            info.id = id;
            if self.types[self.i] == FlowToken::Pipe {
                self.i += 1;
                info.text = Some(self.text()?);
                self.closed(FlowToken::Pipe)?;
                if self.types[self.i] == FlowToken::Space {
                    self.i += 1;
                }
            }
            return Ok(info);
        }
        if self.types[self.i] == FlowToken::StartLink {
            let start = self.texts[self.i].clone();
            self.i += 1;
            let label = self.edge_text()?;
            let end = self.expect(FlowToken::Link, "'EDGE_TEXT'")?;
            let mut info = db.destruct_link(&end, Some(&start));
            info.text = Some(label);
            info.id = id;
            return Ok(info);
        }
        Err(self.fail("'LINK', 'START_LINK'"))
    }

    fn vertex_statement(&mut self, db: &mut FlowDb, collect: bool) -> Result<Vec<String>, PeleError> {
        let mut stmt = self.node(db)?;
        if let Some(meta) = self.pending_data.take() {
            let last_id = stmt.last().unwrap().clone();
            db.add_vertex(&last_id, None, None, None, None, None, None, Some(&meta))?;
        }
        let mut nodes = stmt.clone();
        loop {
            let t = self.types[self.i];
            if !matches!(t, FlowToken::Link | FlowToken::StartLink | FlowToken::LinkId) {
                return Ok(nodes);
            }
            let info = self.link(db)?;
            let next = self.node(db)?;
            if let Some(meta) = self.pending_data.take() {
                let last_id = next.last().unwrap().clone();
                db.add_vertex(&last_id, None, None, None, None, None, None, Some(&meta))?;
            }
            db.add_link(&stmt, &next, Some(&info))?;
            if collect {
                let mut combined = next.clone();
                combined.extend(nodes);
                nodes = combined;
            }
            stmt = next;
        }
    }

    fn style(&mut self) -> Result<String, PeleError> {
        if !is_style_part(self.types[self.i]) {
            return Err(self.fail("'NODE_STRING', 'NUM', 'COLON', 'BRKT'"));
        }
        let mut s = self.texts[self.i].clone();
        self.i += 1;
        while is_style_part(self.types[self.i]) {
            s.push_str(&self.texts[self.i]);
            self.i += 1;
        }
        Ok(s)
    }

    fn styles_opt(&mut self) -> Result<Vec<String>, PeleError> {
        let mut out = vec![self.style()?];
        while self.types[self.i] == FlowToken::Comma {
            self.i += 1;
            out.push(self.style()?);
        }
        Ok(out)
    }

    fn link_style_statement(&mut self, db: &mut FlowDb) -> Result<(), PeleError> {
        self.i += 1;
        self.expect(FlowToken::Space, "")?;
        let positions = if self.types[self.i] == FlowToken::Default {
            let s = self.texts[self.i].clone();
            self.i += 1;
            vec![s]
        } else {
            let mut pos = vec![self.expect(FlowToken::Num, "'DEFAULT'")?];
            while self.types[self.i] == FlowToken::Comma {
                self.i += 1;
                pos.push(self.expect(FlowToken::Num, "")?);
            }
            pos
        };
        self.expect(FlowToken::Space, "")?;
        if self.types[self.i] != FlowToken::Interpolate {
            let styles = self.styles_opt()?;
            return db.update_link(&positions, styles);
        }
        self.i += 1;
        self.expect(FlowToken::Space, "")?;
        let interpolate = self.alpha_num()?;
        if self.types[self.i] == FlowToken::Space {
            self.i += 1;
            let styles = self.styles_opt()?;
            db.update_link_interpolate(&positions, &interpolate)?;
            db.update_link(&positions, styles)
        } else {
            db.update_link_interpolate(&positions, &interpolate)
        }
    }

    fn link_tail(&mut self, db: &mut FlowDb, id: &str, url: &str) -> Result<(), PeleError> {
        if self.types[self.i] != FlowToken::Space {
            db.set_link(id, url, None);
            return Ok(());
        }
        self.i += 1;
        if self.types[self.i] == FlowToken::LinkTarget {
            let target = self.texts[self.i].clone();
            self.i += 1;
            db.set_link(id, url, Some(&target));
            return Ok(());
        }
        let tooltip = self.expect(FlowToken::Str, "'LINK_TARGET'")?;
        if self.types[self.i] == FlowToken::Space {
            self.i += 1;
            let target = self.expect(FlowToken::LinkTarget, "")?;
            db.set_link(id, url, Some(&target));
        } else {
            db.set_link(id, url, None);
        }
        db.set_tooltip(id, Some(&tooltip));
        Ok(())
    }

    fn click_statement(&mut self, db: &mut FlowDb) -> Result<(), PeleError> {
        let id = self.texts[self.i].clone();
        self.i += 1;
        match self.types[self.i] {
            FlowToken::CallbackName => {
                self.i += 1;
                if self.types[self.i] == FlowToken::CallbackArgs {
                    self.i += 1;
                }
                let mut tooltip: Option<String> = None;
                if self.types[self.i] == FlowToken::Space {
                    self.i += 1;
                    tooltip = Some(self.expect(FlowToken::Str, "")?);
                }
                db.set_click_event(&id);
                if let Some(tip) = tooltip {
                    db.set_tooltip(&id, Some(&tip));
                }
                Ok(())
            }
            FlowToken::Href => {
                self.i += 1;
                let url = self.expect(FlowToken::Str, "")?;
                self.link_tail(db, &id, &url)
            }
            FlowToken::Str => {
                let url = self.texts[self.i].clone();
                self.i += 1;
                self.link_tail(db, &id, &url)
            }
            _ => {
                let _name = self.alpha_num()?;
                if self.types[self.i] == FlowToken::Space {
                    self.i += 1;
                    let tooltip = self.expect(FlowToken::Str, "")?;
                    db.set_click_event(&id);
                    db.set_tooltip(&id, Some(&tooltip));
                } else {
                    db.set_click_event(&id);
                }
                Ok(())
            }
        }
    }

    fn subgraph_header(&mut self) -> Result<Frame, PeleError> {
        self.i += 1;
        let t = self.types[self.i];
        if matches!(t, FlowToken::Newline | FlowToken::Semi | FlowToken::Eof) {
            self.i += 1;
            return Ok(Frame {
                id: None,
                title: None,
                same_id_and_title: false,
                list: Vec::new(),
                collect: false,
            });
        }
        self.expect(FlowToken::Space, "'SEMI', 'NEWLINE', 'EOF'")?;
        let id = self.text_no_tags()?;
        let (title, same) = if self.types[self.i] == FlowToken::Sqs {
            self.i += 1;
            let t_val = self.text()?;
            self.closed(FlowToken::Sqe)?;
            (t_val, false)
        } else {
            (id.clone(), true)
        };
        let t = self.types[self.i];
        if !matches!(t, FlowToken::Newline | FlowToken::Semi | FlowToken::Eof) {
            return Err(self.fail("'SEMI', 'NEWLINE', 'EOF', 'SQS'"));
        }
        self.i += 1;
        Ok(Frame {
            id: Some(id),
            title: Some(title),
            same_id_and_title: same,
            list: Vec::new(),
            collect: false,
        })
    }

    fn statement(&mut self, db: &mut FlowDb, collect: bool) -> Result<Option<DocItem>, PeleError> {
        let t = self.types[self.i];
        match t {
            FlowToken::Style => {
                self.i += 1;
                self.expect(FlowToken::Space, "")?;
                let id = self.id_string()?;
                self.expect(FlowToken::Space, "")?;
                let styles = self.styles_opt()?;
                db.add_vertex(&id, None, None, Some(styles), None, None, None, None)?;
                self.separator()?;
                Ok(None)
            }
            FlowToken::LinkStyle => {
                self.link_style_statement(db)?;
                self.separator()?;
                Ok(None)
            }
            FlowToken::ClassDef => {
                self.i += 1;
                self.expect(FlowToken::Space, "")?;
                let id = self.id_string()?;
                self.expect(FlowToken::Space, "")?;
                let styles = self.styles_opt()?;
                db.add_class(&id, &styles);
                self.separator()?;
                Ok(None)
            }
            FlowToken::Class => {
                self.i += 1;
                self.expect(FlowToken::Space, "")?;
                let ids = self.id_string()?;
                self.expect(FlowToken::Space, "")?;
                let cls = self.id_string()?;
                db.set_class(&ids, &cls);
                self.separator()?;
                Ok(None)
            }
            FlowToken::Click => {
                self.click_statement(db)?;
                self.separator()?;
                Ok(None)
            }
            FlowToken::DirectionTb => {
                self.i += 1;
                Ok(Some(DocItem::Dir("TB".to_string())))
            }
            FlowToken::DirectionBt => {
                self.i += 1;
                Ok(Some(DocItem::Dir("BT".to_string())))
            }
            FlowToken::DirectionRl => {
                self.i += 1;
                Ok(Some(DocItem::Dir("RL".to_string())))
            }
            FlowToken::DirectionLr => {
                self.i += 1;
                Ok(Some(DocItem::Dir("LR".to_string())))
            }
            FlowToken::DirectionTd => {
                self.i += 1;
                Ok(Some(DocItem::Dir("TD".to_string())))
            }
            FlowToken::AccTitle => {
                self.i += 1;
                let value = self.expect(FlowToken::AccTitleValue, "")?.trim().to_string();
                db.set_acc_title(&value);
                Ok(Some(DocItem::Single(value)))
            }
            FlowToken::AccDescr => {
                self.i += 1;
                let value = self.expect(FlowToken::AccDescrValue, "")?.trim().to_string();
                db.set_acc_description(&value);
                Ok(Some(DocItem::Single(value)))
            }
            FlowToken::AccDescrMultilineValue => {
                let value = self.texts[self.i].trim().to_string();
                self.i += 1;
                db.set_acc_description(&value);
                Ok(Some(DocItem::Single(value)))
            }
            _ => {
                if !is_id_token(t) {
                    return Err(self.fail(STATEMENT_START));
                }
                let nodes = self.vertex_statement(db, collect)?;
                self.separator()?;
                if nodes.is_empty() { Ok(None) } else { Ok(Some(DocItem::Many(nodes))) }
            }
        }
    }

    fn document(&mut self, db: &mut FlowDb) -> Result<(), PeleError> {
        let mut open: Vec<Frame> = Vec::new();
        let mut list: Vec<DocItem> = Vec::new();
        let mut collect = false;
        loop {
            let t = self.types[self.i];
            if t == FlowToken::End {
                break;
            }
            if t == FlowToken::EndKw {
                let Some(frame) = open.pop() else {
                    break;
                };
                self.i += 1;
                let id = db.add_subgraph(frame.id.as_ref(), &list, frame.title.as_ref(), frame.same_id_and_title);
                list = frame.list;
                collect = frame.collect;
                if collect {
                    list.push(DocItem::Single(id));
                }
            } else if matches!(t, FlowToken::Semi | FlowToken::Newline | FlowToken::Space | FlowToken::Eof) {
                if collect {
                    list.push(DocItem::Single(self.texts[self.i].clone()));
                }
                self.i += 1;
            } else if t == FlowToken::Subgraph {
                let mut frame = self.subgraph_header()?;
                frame.list = list;
                frame.collect = collect;
                open.push(frame);
                list = Vec::new();
                collect = true;
            } else if let Some(item) = self.statement(db, collect)?
                && collect
            {
                list.push(item);
            }
        }
        if !open.is_empty() {
            return Err(self.fail("'end'"));
        }
        Ok(())
    }
}

pub fn parse_flowchart(source: &str, db: &mut FlowDb, origin: Option<&SourceMap<'_>>) -> Result<(), PeleError> {
    let stripped = strip_brace_trail(source);
    let (src_ref, brace_edits) = match &stripped {
        Some((s, edits)) => (s.as_str(), Some(edits.clone())),
        None => (source, None),
    };
    let tokens = tokenize(src_ref);
    let mut parser = Parser {
        source,
        brace_edits,
        origin,
        types: tokens.types,
        texts: tokens.texts,
        starts: tokens.starts,
        i: 0,
        pending_data: None,
    };

    while matches!(parser.types[parser.i], FlowToken::Space | FlowToken::Newline) {
        parser.i += 1;
    }
    parser.expect(FlowToken::Graph, "'SPACE', 'NEWLINE'")?;
    if parser.types[parser.i] == FlowToken::NoDir {
        parser.i += 1;
        db.set_direction("TB");
    } else {
        let dir = parser.expect(FlowToken::Dir, "'NODIR'")?;
        let mut t = parser.types[parser.i];
        if t == FlowToken::Space {
            while parser.types[parser.i] == FlowToken::Space {
                parser.i += 1;
            }
            t = parser.types[parser.i];
            if t != FlowToken::Newline {
                return Err(parser.fail("'NEWLINE', 'SPACE'"));
            }
        } else if t != FlowToken::Semi && t != FlowToken::Newline {
            return Err(parser.fail("'SEMI', 'NEWLINE', 'SPACE'"));
        }
        parser.i += 1;
        db.set_direction(&dir);
    }
    parser.document(db)?;
    if parser.types[parser.i] != FlowToken::End {
        return Err(parser.fail(STATEMENT_START));
    }
    Ok(())
}
