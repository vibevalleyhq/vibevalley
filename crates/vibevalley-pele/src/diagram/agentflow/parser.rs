use indexmap::IndexMap;

use crate::detect::DiagramType;
use crate::error::{Edit, PeleError, SourceMap, input_offset, syntax_error};
use crate::util::chars::is_space_char;

use super::db::{AgentflowDb, ErrorSource};
use super::lexer::tokenize;
use super::tokens::AgentToken;
use super::types::{DocItem, FlowText, LabelType, LinkInfo, Loc};

const TEXT_TOKENS: &str = "'UNICODE_TEXT', 'TEXT', 'TAGSTART'";
const SEPARATORS: &str = "'COMMENT', 'SEMI', 'NEWLINE', 'EOF'";
const STATEMENT_START: &str = "'COMMENT', 'SEMI', 'NEWLINE', 'SPACE', 'EOF', 'flow', 'global', 'connector', 'acc_title', 'acc_descr', 'acc_descr_multiline_value', 'STYLE', 'LINKSTYLE', 'CLASSDEF', 'CLASS', 'CLICK', 'NODE_STRING'";

fn is_id_token(t: AgentToken) -> bool {
    matches!(
        t,
        AgentToken::Num
            | AgentToken::NodeString
            | AgentToken::Down
            | AgentToken::Minus
            | AgentToken::Default
            | AgentToken::Comma
            | AgentToken::Colon
            | AgentToken::Amp
            | AgentToken::Brkt
            | AgentToken::Mult
            | AgentToken::UnicodeText
    )
}

fn is_alphanum_token(t: AgentToken) -> bool {
    matches!(
        t,
        AgentToken::Num
            | AgentToken::UnicodeText
            | AgentToken::NodeString
            | AgentToken::Dir
            | AgentToken::Down
            | AgentToken::Minus
            | AgentToken::Comma
            | AgentToken::Colon
            | AgentToken::Amp
            | AgentToken::Brkt
            | AgentToken::Mult
    )
}

fn is_no_tags_token(t: AgentToken) -> bool {
    matches!(
        t,
        AgentToken::Num
            | AgentToken::NodeString
            | AgentToken::Space
            | AgentToken::Minus
            | AgentToken::Amp
            | AgentToken::UnicodeText
            | AgentToken::Colon
            | AgentToken::Mult
            | AgentToken::Brkt
            | AgentToken::Style
            | AgentToken::LinkStyle
            | AgentToken::ClassDef
            | AgentToken::Class
            | AgentToken::Click
            | AgentToken::Graph
            | AgentToken::Dir
            | AgentToken::Flow
            | AgentToken::Connector
            | AgentToken::Global
            | AgentToken::EndKw
            | AgentToken::Down
            | AgentToken::Up
            | AgentToken::StartLink
    )
}

fn is_style_part(t: AgentToken) -> bool {
    matches!(
        t,
        AgentToken::Num | AgentToken::NodeString | AgentToken::Colon | AgentToken::Space | AgentToken::Brkt | AgentToken::Style
    )
}

fn is_separator(t: AgentToken) -> bool {
    matches!(t, AgentToken::Newline | AgentToken::Semi | AgentToken::Eof | AgentToken::Comment)
}

fn is_trailing(t: AgentToken) -> bool {
    matches!(t, AgentToken::Comment | AgentToken::Newline | AgentToken::Space | AgentToken::Eof)
}

/// Replaces `/}[^\S\n]*\n/g` with `}\n` without folding blank lines, recording edits for error offsets.
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
            while j < n {
                let b = bytes[j];
                if b == b'\n' {
                    break;
                }
                if b < 128 {
                    if matches!(b, b' ' | b'\t' | b'\r' | 0x0b | 0x0c) {
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
            if j < n && bytes[j] == b'\n' {
                let match_end = j + 1;
                if match_end - i != 2 {
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
    global: bool,
    at: usize,
    id: Option<FlowText>,
    title: Option<FlowText>,
    data: Option<String>,
    data_from: usize,
    data_to: usize,
    list: Vec<DocItem>,
    collect: bool,
}

struct Parser<'a> {
    source: &'a str,
    src_storage: Option<String>,
    brace_edits: Option<Vec<Edit>>,
    origin: Option<&'a SourceMap<'a>>,
    types: Vec<AgentToken>,
    texts: Vec<String>,
    starts: Vec<usize>,
    locs: Vec<usize>,
    i: usize,
    pending_data: Option<String>,
    data_from: usize,
    data_to: usize,
}

impl<'a> Parser<'a> {
    fn src(&self) -> &str {
        self.src_storage.as_deref().unwrap_or(self.source)
    }

    fn error_source(&self) -> ErrorSource<'_> {
        ErrorSource {
            source: self.source,
            brace_edits: self.brace_edits.as_deref(),
            origin: self.origin,
        }
    }

    fn fail(&self, expected: &str) -> PeleError {
        let t = self.types[self.i];
        let mut from = self.starts[self.i];
        if t == AgentToken::Eof || t == AgentToken::End {
            let mut k = self.i;
            while k > 0 && is_trailing(self.types[k - 1]) {
                k -= 1;
            }
            from = self.src()[..self.starts[k]].trim_end().len();
        }
        let at = match &self.brace_edits {
            Some(edits) => input_offset(std::slice::from_ref(edits), from),
            None => from,
        };
        if t == AgentToken::Error {
            return syntax_error(DiagramType::Agentflow, self.source, at, "", true, self.origin);
        }
        syntax_error(
            DiagramType::Agentflow,
            self.source,
            at,
            &format!("Expecting {expected}, got '{}'", t.name()),
            false,
            self.origin,
        )
    }

    fn span(&self, a: usize, b: usize) -> Loc {
        Loc {
            first_line: self.locs[4 * a],
            first_column: self.locs[4 * a + 1],
            last_line: self.locs[4 * b + 2],
            last_column: self.locs[4 * b + 3],
            start_byte: self.starts[a],
        }
    }

    fn expect(&mut self, kind: AgentToken, also: &str) -> Result<String, PeleError> {
        if self.types[self.i] != kind {
            let exp = if also.is_empty() {
                format!("'{}'", kind.name())
            } else {
                format!("'{}', {also}", kind.name())
            };
            return Err(self.fail(&exp));
        }
        let s = self.texts[self.i].clone();
        self.i += 1;
        Ok(s)
    }

    fn separator(&mut self) -> Result<(), PeleError> {
        if !is_separator(self.types[self.i]) {
            return Err(self.fail(SEPARATORS));
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
        let t = self.types[self.i];
        let label_type = if t == AgentToken::Str {
            LabelType::String
        } else if t == AgentToken::MdStr {
            LabelType::Markdown
        } else if matches!(t, AgentToken::Text | AgentToken::TagStart | AgentToken::TagEnd | AgentToken::UnicodeText) {
            LabelType::Text
        } else {
            return Err(self.fail(&format!("{TEXT_TOKENS}, 'TAGEND', 'STR', 'MD_STR'")));
        };
        let mut s = self.texts[self.i].clone();
        self.i += 1;
        while matches!(
            self.types[self.i],
            AgentToken::Text | AgentToken::TagStart | AgentToken::TagEnd | AgentToken::UnicodeText
        ) {
            s.push_str(&self.texts[self.i]);
            self.i += 1;
        }
        Ok(FlowText { text: s, label_type })
    }

    fn closed(&mut self, kind: AgentToken) -> Result<(), PeleError> {
        let _ = self.expect(kind, TEXT_TOKENS)?;
        Ok(())
    }

    fn edge_text(&mut self) -> Result<FlowText, PeleError> {
        let t = self.types[self.i];
        let label_type = if t == AgentToken::Str {
            LabelType::String
        } else if t == AgentToken::MdStr {
            LabelType::Markdown
        } else if matches!(t, AgentToken::EdgeText | AgentToken::UnicodeText) {
            LabelType::Text
        } else {
            return Err(self.fail("'EDGE_TEXT', 'STR', 'MD_STR'"));
        };
        let mut s = self.texts[self.i].clone();
        self.i += 1;
        while matches!(self.types[self.i], AgentToken::EdgeText | AgentToken::UnicodeText) {
            s.push_str(&self.texts[self.i]);
            self.i += 1;
        }
        Ok(FlowText { text: s, label_type })
    }

    fn text_no_tags(&mut self) -> Result<FlowText, PeleError> {
        let t = self.types[self.i];
        let label_type = if t == AgentToken::Str {
            LabelType::Text
        } else if t == AgentToken::MdStr {
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
        self.data_from = self.i;
        let mut s = self.texts[self.i].clone();
        self.i += 1;
        while self.types[self.i] == AgentToken::ShapeData {
            s.push_str(&self.texts[self.i]);
            self.i += 1;
        }
        self.data_to = self.i - 1;
        s
    }

    fn attach(&self, db: &mut AgentflowDb, id: &str, data: &str, from: usize, to: usize) -> Result<(), PeleError> {
        let loc = self.span(from, to);
        let es = self.error_source();
        db.add_vertex(id, None, None, None, None, None, None, Some(data), Some(loc), Some(&es))?;
        db.extend_vertex_mapping(id, Some(loc));
        Ok(())
    }

    fn attach_data(&self, db: &mut AgentflowDb, id: &str, frame: &Frame) -> Result<(), PeleError> {
        let Some(ref data) = frame.data else {
            return Ok(());
        };
        let loc = self.span(frame.data_from, frame.data_to);
        let es = self.error_source();
        db.add_vertex(id, None, None, None, None, None, None, Some(data), Some(loc), Some(&es))
    }

    fn vertex(&mut self, db: &mut AgentflowDb) -> Result<String, PeleError> {
        let from = self.i;
        let id = self.id_string()?;
        let mut label: Option<FlowText> = None;
        let mut node_type: Option<&'static str> = None;
        let mut props: Option<IndexMap<String, String>> = None;

        match self.types[self.i] {
            AgentToken::Sqs => {
                self.i += 1;
                label = Some(self.text()?);
                self.closed(AgentToken::Sqe)?;
                node_type = Some("square");
            }
            AgentToken::DoubleCircleStart => {
                self.i += 1;
                label = Some(self.text()?);
                self.closed(AgentToken::DoubleCircleEnd)?;
                node_type = Some("doublecircle");
            }
            AgentToken::Ps => {
                self.i += 1;
                if self.types[self.i] == AgentToken::Ps {
                    self.i += 1;
                    label = Some(self.text()?);
                    self.closed(AgentToken::Pe)?;
                    let _ = self.expect(AgentToken::Pe, "")?;
                    node_type = Some("circle");
                } else {
                    label = Some(self.text()?);
                    self.closed(AgentToken::Pe)?;
                    node_type = Some("round");
                }
            }
            AgentToken::EllipseStart => {
                self.i += 1;
                label = Some(self.text()?);
                self.closed(AgentToken::EllipseEnd)?;
                node_type = Some("ellipse");
            }
            AgentToken::StadiumStart => {
                self.i += 1;
                label = Some(self.text()?);
                self.closed(AgentToken::StadiumEnd)?;
                node_type = Some("stadium");
            }
            AgentToken::SubroutineStart => {
                self.i += 1;
                label = Some(self.text()?);
                self.closed(AgentToken::SubroutineEnd)?;
                node_type = Some("subroutine");
            }
            AgentToken::VertexWithPropsStart => {
                self.i += 1;
                let field = self.expect(AgentToken::NodeString, "")?;
                let _ = self.expect(AgentToken::Colon, "")?;
                let value = self.expect(AgentToken::NodeString, "")?;
                let _ = self.expect(AgentToken::Pipe, "")?;
                label = Some(self.text()?);
                self.closed(AgentToken::Sqe)?;
                node_type = Some("rect");
                let mut map = IndexMap::new();
                map.insert(field, value);
                props = Some(map);
            }
            AgentToken::CylinderStart => {
                self.i += 1;
                label = Some(self.text()?);
                self.closed(AgentToken::CylinderEnd)?;
                node_type = Some("cylinder");
            }
            AgentToken::DiamondStart => {
                self.i += 1;
                if self.types[self.i] == AgentToken::DiamondStart {
                    self.i += 1;
                    label = Some(self.text()?);
                    self.closed(AgentToken::DiamondStop)?;
                    let _ = self.expect(AgentToken::DiamondStop, "")?;
                    node_type = Some("hexagon");
                } else {
                    label = Some(self.text()?);
                    self.closed(AgentToken::DiamondStop)?;
                    node_type = Some("diamond");
                }
            }
            AgentToken::TagEnd => {
                self.i += 1;
                label = Some(self.text()?);
                self.closed(AgentToken::Sqe)?;
                node_type = Some("odd");
            }
            AgentToken::TrapStart => {
                self.i += 1;
                label = Some(self.text()?);
                if self.types[self.i] == AgentToken::InvTrapEnd {
                    self.i += 1;
                    node_type = Some("lean_right");
                } else {
                    self.closed(AgentToken::TrapEnd)?;
                    node_type = Some("trapezoid");
                }
            }
            AgentToken::InvTrapStart => {
                self.i += 1;
                label = Some(self.text()?);
                if self.types[self.i] == AgentToken::TrapEnd {
                    self.i += 1;
                    node_type = Some("lean_left");
                } else {
                    self.closed(AgentToken::InvTrapEnd)?;
                    node_type = Some("inv_trapezoid");
                }
            }
            AgentToken::End
            | AgentToken::Error
            | AgentToken::AccTitle
            | AgentToken::AccTitleValue
            | AgentToken::AccDescr
            | AgentToken::AccDescrValue
            | AgentToken::AccDescrMultilineValue
            | AgentToken::ShapeData
            | AgentToken::CallbackName
            | AgentToken::CallbackArgs
            | AgentToken::MdStr
            | AgentToken::Str
            | AgentToken::Style
            | AgentToken::Default
            | AgentToken::LinkStyle
            | AgentToken::Interpolate
            | AgentToken::ClassDef
            | AgentToken::Class
            | AgentToken::Href
            | AgentToken::Click
            | AgentToken::Graph
            | AgentToken::Flow
            | AgentToken::Connector
            | AgentToken::Global
            | AgentToken::EndKw
            | AgentToken::LinkTarget
            | AgentToken::NoDir
            | AgentToken::Dir
            | AgentToken::DirectionTb
            | AgentToken::DirectionBt
            | AgentToken::DirectionRl
            | AgentToken::DirectionLr
            | AgentToken::DirectionTd
            | AgentToken::LinkId
            | AgentToken::Num
            | AgentToken::Brkt
            | AgentToken::StyleSeparator
            | AgentToken::Colon
            | AgentToken::Amp
            | AgentToken::Semi
            | AgentToken::Comma
            | AgentToken::Mult
            | AgentToken::Link
            | AgentToken::StartLink
            | AgentToken::EdgeText
            | AgentToken::EllipseEnd
            | AgentToken::Text
            | AgentToken::StadiumEnd
            | AgentToken::SubroutineEnd
            | AgentToken::CylinderEnd
            | AgentToken::DoubleCircleEnd
            | AgentToken::TrapEnd
            | AgentToken::InvTrapEnd
            | AgentToken::TagStart
            | AgentToken::Up
            | AgentToken::Sep
            | AgentToken::Down
            | AgentToken::Comment
            | AgentToken::NodeString
            | AgentToken::Minus
            | AgentToken::UnicodeText
            | AgentToken::Pipe
            | AgentToken::Pe
            | AgentToken::Sqe
            | AgentToken::DiamondStop
            | AgentToken::Newline
            | AgentToken::Space
            | AgentToken::Eof => {}
        }

        let es = self.error_source();
        db.add_vertex(&id, label.as_ref(), node_type, None, None, None, props, None, None, Some(&es))?;
        db.add_vertex_mapping(&id, node_type.is_some(), Some(self.span(from, self.i - 1)));
        Ok(id)
    }

    fn styled_vertex(&mut self, db: &mut AgentflowDb) -> Result<String, PeleError> {
        let id = self.vertex(db)?;
        if self.types[self.i] == AgentToken::StyleSeparator {
            self.i += 1;
            let cls = self.id_string()?;
            db.set_class(&id, &cls);
        }
        Ok(id)
    }

    fn node(&mut self, db: &mut AgentflowDb) -> Result<Vec<String>, PeleError> {
        let mut ids = vec![self.styled_vertex(db)?];
        self.pending_data = None;
        loop {
            let data = if self.types[self.i] == AgentToken::ShapeData {
                Some(self.shape_data())
            } else {
                None
            };
            let from = self.data_from;
            let to = self.data_to;
            if self.types[self.i] != AgentToken::Space {
                self.pending_data = data;
                return Ok(ids);
            }
            self.i += 1;
            while self.types[self.i] == AgentToken::Space {
                self.i += 1;
            }
            if self.types[self.i] != AgentToken::Amp {
                if data.is_some() {
                    return Err(self.fail("'AMP'"));
                }
                return Ok(ids);
            }
            self.i += 1;
            if self.types[self.i] != AgentToken::Space {
                return Err(self.fail("'SPACE'"));
            }
            self.i += 1;
            while self.types[self.i] == AgentToken::Space {
                self.i += 1;
            }
            let next = self.styled_vertex(db)?;
            if let Some(ref d) = data {
                let prev = ids.last().unwrap().clone();
                self.attach(db, &prev, d, from, to)?;
            }
            ids.push(next);
        }
    }

    fn link(&mut self) -> Result<LinkInfo, PeleError> {
        let mut id: Option<String> = None;
        if self.types[self.i] == AgentToken::LinkId {
            id = Some(self.texts[self.i].clone());
            self.i += 1;
        }
        if self.types[self.i] == AgentToken::Link {
            let mut info = AgentflowDb::destruct_link(&self.texts[self.i], None);
            self.i += 1;
            if let Some(uid) = id {
                info.id = Some(uid);
            }
            if self.types[self.i] == AgentToken::Pipe {
                self.i += 1;
                info.text = Some(self.text()?);
                self.closed(AgentToken::Pipe)?;
                if self.types[self.i] == AgentToken::Space {
                    self.i += 1;
                }
            }
            return Ok(info);
        }
        if self.types[self.i] == AgentToken::StartLink {
            let start = self.texts[self.i].clone();
            self.i += 1;
            let label = self.edge_text()?;
            let end = self.expect(AgentToken::Link, "'EDGE_TEXT'")?;
            let mut info = AgentflowDb::destruct_link(&end, Some(&start));
            info.text = Some(label);
            if let Some(uid) = id {
                info.id = Some(uid);
            }
            return Ok(info);
        }
        Err(self.fail("'LINK', 'START_LINK'"))
    }

    fn vertex_statement(&mut self, db: &mut AgentflowDb) -> Result<Vec<String>, PeleError> {
        let from = self.i;
        let mut stmt = self.node(db)?;
        if let Some(data) = self.pending_data.take() {
            let last = stmt.last().unwrap().clone();
            self.attach(db, &last, &data, self.data_from, self.data_to)?;
        }
        let mut nodes = stmt.clone();
        loop {
            let t = self.types[self.i];
            if !matches!(t, AgentToken::Link | AgentToken::StartLink | AgentToken::LinkId) {
                return Ok(nodes);
            }
            let info = self.link()?;
            let next = self.node(db)?;
            if let Some(data) = self.pending_data.take() {
                let last = next.last().unwrap().clone();
                self.attach(db, &last, &data, self.data_from, self.data_to)?;
            }
            db.add_link(&stmt, &next, Some(&info))?;
            db.add_edge_mapping(&next, Some(self.span(from, self.i - 1)));
            let mut combined = next.clone();
            combined.extend(nodes);
            nodes = combined;
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
        while self.types[self.i] == AgentToken::Comma {
            self.i += 1;
            out.push(self.style()?);
        }
        Ok(out)
    }

    fn link_style_statement(&mut self, db: &mut AgentflowDb) -> Result<(), PeleError> {
        self.i += 1;
        let _ = self.expect(AgentToken::Space, "")?;
        let positions = if self.types[self.i] == AgentToken::Default {
            let s = self.texts[self.i].clone();
            self.i += 1;
            vec![s]
        } else {
            let mut pos = vec![self.expect(AgentToken::Num, "'DEFAULT'")?];
            while self.types[self.i] == AgentToken::Comma {
                self.i += 1;
                pos.push(self.expect(AgentToken::Num, "")?);
            }
            pos
        };
        let _ = self.expect(AgentToken::Space, "")?;
        if self.types[self.i] != AgentToken::Interpolate {
            let styles = self.styles_opt()?;
            db.update_link(&positions, styles)?;
            return Ok(());
        }
        self.i += 1;
        let _ = self.expect(AgentToken::Space, "")?;
        let interpolate = self.alpha_num()?;
        if self.types[self.i] == AgentToken::Space {
            self.i += 1;
            let styles = self.styles_opt()?;
            db.update_link_interpolate(&positions, &interpolate)?;
            db.update_link(&positions, styles)?;
        } else {
            db.update_link_interpolate(&positions, &interpolate)?;
        }
        Ok(())
    }

    fn link_tail(&mut self, db: &mut AgentflowDb, id: &str, url: &str) -> Result<(), PeleError> {
        if self.types[self.i] != AgentToken::Space {
            db.set_link(id, url, None);
            return Ok(());
        }
        self.i += 1;
        if self.types[self.i] == AgentToken::LinkTarget {
            let target = self.texts[self.i].clone();
            self.i += 1;
            db.set_link(id, url, Some(&target));
            return Ok(());
        }
        let tooltip = self.expect(AgentToken::Str, "'LINK_TARGET'")?;
        if self.types[self.i] == AgentToken::Space {
            self.i += 1;
            let target = self.expect(AgentToken::LinkTarget, "")?;
            db.set_link(id, url, Some(&target));
        } else {
            db.set_link(id, url, None);
        }
        db.set_tooltip(id, Some(&tooltip));
        Ok(())
    }

    fn click_statement(&mut self, db: &mut AgentflowDb) -> Result<(), PeleError> {
        let id = self.texts[self.i].clone();
        self.i += 1;
        if self.types[self.i] == AgentToken::CallbackName {
            let name = self.texts[self.i].clone();
            self.i += 1;
            let args = if self.types[self.i] == AgentToken::CallbackArgs {
                let a = self.texts[self.i].clone();
                self.i += 1;
                Some(a)
            } else {
                None
            };
            let tooltip = if self.types[self.i] == AgentToken::Space {
                self.i += 1;
                Some(self.expect(AgentToken::Str, "")?)
            } else {
                None
            };
            db.set_click_event(&id, Some(&name), args.as_deref());
            if let Some(tip) = tooltip {
                db.set_tooltip(&id, Some(&tip));
            }
        } else if self.types[self.i] == AgentToken::Href {
            self.i += 1;
            let url = self.expect(AgentToken::Str, "")?;
            self.link_tail(db, &id, &url)?;
        } else if self.types[self.i] == AgentToken::Str {
            let url = self.texts[self.i].clone();
            self.i += 1;
            self.link_tail(db, &id, &url)?;
        } else {
            let name = self.alpha_num()?;
            if self.types[self.i] == AgentToken::Space {
                self.i += 1;
                let tooltip = self.expect(AgentToken::Str, "")?;
                db.set_click_event(&id, Some(&name), None);
                db.set_tooltip(&id, Some(&tooltip));
            } else {
                db.set_click_event(&id, Some(&name), None);
            }
        }
        Ok(())
    }

    fn header(&mut self, at: usize) -> Result<Frame, PeleError> {
        let _ = self.expect(AgentToken::Space, SEPARATORS)?;
        let id = self.text_no_tags()?;
        let mut title = FlowText {
            text: String::new(),
            label_type: LabelType::Text,
        };
        if self.types[self.i] == AgentToken::Sqs {
            self.i += 1;
            title = self.text()?;
            self.closed(AgentToken::Sqe)?;
        }
        let data = if self.types[self.i] == AgentToken::ShapeData {
            Some(self.shape_data())
        } else {
            None
        };
        if !is_separator(self.types[self.i]) {
            return Err(self.fail(&format!("{SEPARATORS}, 'SHAPE_DATA'")));
        }
        Ok(Frame {
            global: false,
            at,
            id: Some(id),
            title: Some(title),
            data,
            data_from: self.data_from,
            data_to: self.data_to,
            list: Vec::new(),
            collect: false,
        })
    }

    fn statement(&mut self, db: &mut AgentflowDb) -> Result<Option<DocItem>, PeleError> {
        let t = self.types[self.i];
        match t {
            AgentToken::Style => {
                self.i += 1;
                let _ = self.expect(AgentToken::Space, "")?;
                let id = self.id_string()?;
                let _ = self.expect(AgentToken::Space, "")?;
                let styles = self.styles_opt()?;
                let es = self.error_source();
                db.add_vertex(&id, None, None, Some(&styles), None, None, None, None, None, Some(&es))?;
                self.separator()?;
                Ok(None)
            }
            AgentToken::LinkStyle => {
                self.link_style_statement(db)?;
                self.separator()?;
                Ok(None)
            }
            AgentToken::ClassDef => {
                self.i += 1;
                let _ = self.expect(AgentToken::Space, "")?;
                let id = self.id_string()?;
                let _ = self.expect(AgentToken::Space, "")?;
                let styles = self.styles_opt()?;
                db.add_class(&id, &styles);
                self.separator()?;
                Ok(None)
            }
            AgentToken::Class => {
                self.i += 1;
                let _ = self.expect(AgentToken::Space, "")?;
                let ids = self.id_string()?;
                let _ = self.expect(AgentToken::Space, "")?;
                let cls = self.id_string()?;
                db.set_class(&ids, &cls);
                self.separator()?;
                Ok(None)
            }
            AgentToken::Click => {
                self.click_statement(db)?;
                self.separator()?;
                Ok(None)
            }
            AgentToken::Connector => {
                let at = self.i;
                self.i += 1;
                let frame = self.header(at)?;
                let sep = self.i;
                self.i += 1;
                let id = db.add_connector(frame.id.as_ref(), frame.title.as_ref());
                self.attach_data(db, &id, &frame)?;
                db.add_connector_mapping(frame.id.as_ref(), Some(self.span(frame.at, frame.at)), Some(self.span(sep, sep)));
                Ok(Some(DocItem::Single(id)))
            }
            AgentToken::DirectionTb => {
                self.i += 1;
                Ok(Some(DocItem::Dir("TB".to_string())))
            }
            AgentToken::DirectionBt => {
                self.i += 1;
                Ok(Some(DocItem::Dir("BT".to_string())))
            }
            AgentToken::DirectionRl => {
                self.i += 1;
                Ok(Some(DocItem::Dir("RL".to_string())))
            }
            AgentToken::DirectionLr => {
                self.i += 1;
                Ok(Some(DocItem::Dir("LR".to_string())))
            }
            AgentToken::DirectionTd => {
                self.i += 1;
                Ok(Some(DocItem::Dir("TD".to_string())))
            }
            AgentToken::AccTitle => {
                self.i += 1;
                let value = self.expect(AgentToken::AccTitleValue, "")?.trim().to_string();
                db.set_acc_title(&value);
                Ok(Some(DocItem::Single(value)))
            }
            AgentToken::AccDescr => {
                self.i += 1;
                let value = self.expect(AgentToken::AccDescrValue, "")?.trim().to_string();
                db.set_acc_description(&value);
                Ok(Some(DocItem::Single(value)))
            }
            AgentToken::AccDescrMultilineValue => {
                let value = self.texts[self.i].trim().to_string();
                self.i += 1;
                db.set_acc_description(&value);
                Ok(Some(DocItem::Single(value)))
            }
            AgentToken::End
            | AgentToken::Error
            | AgentToken::AccTitleValue
            | AgentToken::AccDescrValue
            | AgentToken::ShapeData
            | AgentToken::CallbackName
            | AgentToken::CallbackArgs
            | AgentToken::MdStr
            | AgentToken::Str
            | AgentToken::Default
            | AgentToken::Interpolate
            | AgentToken::Href
            | AgentToken::Graph
            | AgentToken::Flow
            | AgentToken::Global
            | AgentToken::EndKw
            | AgentToken::LinkTarget
            | AgentToken::NoDir
            | AgentToken::Dir
            | AgentToken::LinkId
            | AgentToken::Num
            | AgentToken::Brkt
            | AgentToken::StyleSeparator
            | AgentToken::Colon
            | AgentToken::Amp
            | AgentToken::Semi
            | AgentToken::Comma
            | AgentToken::Mult
            | AgentToken::Link
            | AgentToken::StartLink
            | AgentToken::EdgeText
            | AgentToken::EllipseEnd
            | AgentToken::Text
            | AgentToken::EllipseStart
            | AgentToken::StadiumEnd
            | AgentToken::StadiumStart
            | AgentToken::SubroutineEnd
            | AgentToken::SubroutineStart
            | AgentToken::VertexWithPropsStart
            | AgentToken::TagEnd
            | AgentToken::CylinderEnd
            | AgentToken::CylinderStart
            | AgentToken::DoubleCircleEnd
            | AgentToken::DoubleCircleStart
            | AgentToken::TrapEnd
            | AgentToken::InvTrapEnd
            | AgentToken::TrapStart
            | AgentToken::InvTrapStart
            | AgentToken::TagStart
            | AgentToken::Up
            | AgentToken::Sep
            | AgentToken::Down
            | AgentToken::Comment
            | AgentToken::NodeString
            | AgentToken::Minus
            | AgentToken::UnicodeText
            | AgentToken::Pipe
            | AgentToken::Pe
            | AgentToken::Ps
            | AgentToken::Sqe
            | AgentToken::Sqs
            | AgentToken::DiamondStop
            | AgentToken::DiamondStart
            | AgentToken::Newline
            | AgentToken::Space
            | AgentToken::Eof => {
                if !is_id_token(t) {
                    return Err(self.fail(STATEMENT_START));
                }
                let nodes = self.vertex_statement(db)?;
                self.separator()?;
                Ok(if nodes.is_empty() { None } else { Some(DocItem::List(nodes)) })
            }
        }
    }

    fn document(&mut self, db: &mut AgentflowDb) -> Result<(), PeleError> {
        let mut open: Vec<Frame> = Vec::new();
        let mut list: Vec<DocItem> = Vec::new();
        let mut collect = false;

        loop {
            let t = self.types[self.i];
            if t == AgentToken::End {
                break;
            }
            if t == AgentToken::EndKw {
                let Some(frame) = open.pop() else {
                    break;
                };
                let at = self.i;
                self.i += 1;
                if frame.global {
                    db.add_global(&list);
                    list = frame.list;
                    collect = frame.collect;
                    continue;
                }
                let id = db.add_subgraph(frame.id.as_ref(), &list, frame.title.as_ref(), false);
                self.attach_data(db, &id, &frame)?;
                db.add_subgraph_mapping(
                    frame.id.as_ref().map(|f| f.text.as_str()),
                    Some(self.span(frame.at, frame.at)),
                    Some(self.span(at, at)),
                );
                list = frame.list;
                collect = frame.collect;
                if collect {
                    list.push(DocItem::Single(id));
                }
            } else if matches!(t, AgentToken::Semi | AgentToken::Newline | AgentToken::Space | AgentToken::Eof) {
                if collect {
                    list.push(DocItem::Single(self.texts[self.i].clone()));
                }
                self.i += 1;
            } else if t == AgentToken::Comment {
                self.i += 1;
            } else if t == AgentToken::Flow || t == AgentToken::Global {
                let at = self.i;
                self.i += 1;
                let frame = if t == AgentToken::Global || is_separator(self.types[self.i]) {
                    self.separator()?;
                    Frame {
                        global: t == AgentToken::Global,
                        at,
                        id: None,
                        title: None,
                        data: None,
                        data_from: 0,
                        data_to: 0,
                        list,
                        collect,
                    }
                } else {
                    let mut f = self.header(at)?;
                    f.list = list;
                    f.collect = collect;
                    self.i += 1;
                    f
                };
                open.push(frame);
                list = Vec::new();
                collect = true;
            } else if let Some(item) = self.statement(db)?
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

pub fn parse_agentflow(source: &str, db: &mut AgentflowDb, raw: bool, origin: Option<&SourceMap<'_>>) -> Result<(), PeleError> {
    let (src_storage, brace_edits) = if !raw {
        match strip_brace_trail(source) {
            Some((s, edits)) => (Some(s), Some(edits)),
            None => (None, None),
        }
    } else {
        (None, None)
    };
    let tokens = tokenize(src_storage.as_deref().unwrap_or(source));
    let mut parser = Parser {
        source,
        src_storage,
        brace_edits,
        origin,
        types: tokens.types,
        texts: tokens.texts,
        starts: tokens.starts,
        locs: tokens.locs,
        i: 0,
        pending_data: None,
        data_from: 0,
        data_to: 0,
    };

    while matches!(parser.types[parser.i], AgentToken::Space | AgentToken::Newline | AgentToken::Comment) {
        parser.i += 1;
    }
    let _ = parser.expect(AgentToken::Graph, "'SPACE', 'NEWLINE', 'COMMENT'")?;
    if parser.types[parser.i] == AgentToken::NoDir {
        parser.i += 1;
        db.set_direction("TB");
    } else {
        let dir = parser.expect(AgentToken::Dir, "'NODIR'")?;
        let mut t = parser.types[parser.i];
        if t == AgentToken::Space {
            parser.i += 1;
            while parser.types[parser.i] == AgentToken::Space {
                parser.i += 1;
            }
            t = parser.types[parser.i];
            if t != AgentToken::Newline {
                return Err(parser.fail("'NEWLINE', 'SPACE'"));
            }
        } else if !matches!(t, AgentToken::Semi | AgentToken::Newline | AgentToken::Comment) {
            return Err(parser.fail("'COMMENT', 'SEMI', 'NEWLINE', 'SPACE'"));
        }
        parser.i += 1;
        db.set_direction(&dir);
    }
    parser.document(db)?;
    if parser.types[parser.i] != AgentToken::End {
        return Err(parser.fail(STATEMENT_START));
    }
    Ok(())
}
