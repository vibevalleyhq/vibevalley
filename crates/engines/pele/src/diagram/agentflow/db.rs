use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;

use crate::detect::DiagramType;
use crate::error::{Edit, ErrorCode, PeleError, SourceLocation, SourceMap, input_offset, locate};
use crate::util::chars::is_space_char;
use crate::util::url::safe_url;
use crate::util::yaml::{YamlValue, parse_yaml};

use super::graph::AgentGraph;
use super::shapes::{ShapeSink, is_valid_shape, resolve_shape_alias};
use super::types::{
    AgentClassDef, AgentEdge, AgentNode, AgentSubgraph, Diagnostic, DiagnosticId, DiagnosticSeverity, DocItem, EdgeSemantic, ElementMapping, ElementPosition,
    FlowText, LabelType, LinkInfo, Loc, Metadata, SemanticConnector, SemanticEdge, SemanticModel, SemanticSubgraph, SemanticVertex, StatementType, VertexKind,
};

#[derive(Debug, Clone, Default)]
pub struct AgentflowDbOptions {
    pub max_edges: Option<usize>,
    pub inherit_dir: bool,
    pub direction: Option<String>,
    pub line_offset: usize,
}

pub struct ErrorSource<'a> {
    pub source: &'a str,
    pub brace_edits: Option<&'a [Edit]>,
    pub origin: Option<&'a SourceMap<'a>>,
}

fn is_presentation_key(key: &str) -> bool {
    matches!(
        key,
        "shape" | "view" | "icon" | "img" | "form" | "pos" | "w" | "h" | "class" | "style" | "labelType"
    )
}

pub fn is_tool_definition(vertex: &AgentNode) -> bool {
    matches!(
        vertex.node_type.as_deref(),
        Some("subroutine" | "subprocess" | "subproc" | "framed-rectangle" | "tool")
    )
}

fn label_type_from_yaml(value: Option<&YamlValue>) -> LabelType {
    match value.and_then(YamlValue::as_str) {
        Some("markdown") => LabelType::Markdown,
        Some("string") => LabelType::String,
        Some("text") => LabelType::Text,
        _ => LabelType::Markdown,
    }
}

fn unquote(text: &str) -> String {
    if text.len() >= 2 && text.starts_with('"') && text.ends_with('"') {
        text[1..text.len() - 1].to_string()
    } else {
        text.to_string()
    }
}

fn is_truthy(value: &YamlValue) -> bool {
    match value {
        YamlValue::Null => false,
        YamlValue::Bool(b) => *b,
        YamlValue::Number(n) => *n != 0.0 && !n.is_nan(),
        YamlValue::String(s) => !s.is_empty(),
        YamlValue::Seq(_) | YamlValue::Map(_) => true,
    }
}

fn yaml_to_js_string(value: &YamlValue) -> String {
    match value {
        YamlValue::Null => "null".to_string(),
        YamlValue::Bool(b) => b.to_string(),
        YamlValue::Number(n) => {
            if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e16 {
                format!("{}", *n as i64)
            } else {
                n.to_string()
            }
        }
        YamlValue::String(s) => s.clone(),
        YamlValue::Seq(items) => items.iter().map(yaml_to_js_string).collect::<Vec<_>>().join(","),
        YamlValue::Map(_) => "[object Object]".to_string(),
    }
}

fn yaml_to_json_string(value: &YamlValue) -> String {
    match value {
        YamlValue::Null => "null".to_string(),
        YamlValue::Bool(b) => b.to_string(),
        YamlValue::Number(n) => {
            if !n.is_finite() {
                "null".to_string()
            } else if n.fract() == 0.0 && n.abs() < 1e16 {
                format!("{}", *n as i64)
            } else {
                n.to_string()
            }
        }
        YamlValue::String(s) => serde_json::to_string(s).unwrap_or_else(|_| format!(r#""{s}""#)),
        YamlValue::Seq(items) => {
            let parts: Vec<String> = items.iter().map(yaml_to_json_string).collect();
            format!("[{}]", parts.join(","))
        }
        YamlValue::Map(map) => {
            let parts: Vec<String> = map
                .iter()
                .map(|(k, v)| {
                    let ks = serde_json::to_string(k).unwrap_or_else(|_| format!(r#""{k}""#));
                    format!("{ks}:{}", yaml_to_json_string(v))
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

/// Drops `__proto__`, `constructor`, and `prototype` keys at every depth iteratively.
fn strip_prototype_keys(root: YamlValue) -> YamlValue {
    enum Work {
        Enter(YamlValue),
        FinishSeq(usize),
        FinishMap(Vec<String>),
    }
    let mut work = vec![Work::Enter(root)];
    let mut results: Vec<YamlValue> = Vec::new();

    while let Some(step) = work.pop() {
        match step {
            Work::Enter(val) => match val {
                YamlValue::Seq(items) => {
                    let len = items.len();
                    work.push(Work::FinishSeq(len));
                    for item in items.into_iter().rev() {
                        work.push(Work::Enter(item));
                    }
                }
                YamlValue::Map(map) => {
                    let mut keys = Vec::new();
                    let mut vals = Vec::new();
                    for (k, v) in map {
                        if matches!(k.as_str(), "__proto__" | "constructor" | "prototype") {
                            continue;
                        }
                        keys.push(k);
                        vals.push(v);
                    }
                    work.push(Work::FinishMap(keys));
                    for v in vals.into_iter().rev() {
                        work.push(Work::Enter(v));
                    }
                }
                other @ (YamlValue::Null | YamlValue::Bool(_) | YamlValue::Number(_) | YamlValue::String(_)) => {
                    results.push(other);
                }
            },
            Work::FinishSeq(len) => {
                let start = results.len() - len;
                let items: Vec<YamlValue> = results.drain(start..).collect();
                results.push(YamlValue::Seq(items));
            }
            Work::FinishMap(keys) => {
                let start = results.len() - keys.len();
                let vals: Vec<YamlValue> = results.drain(start..).collect();
                let mut map = IndexMap::with_capacity(keys.len());
                for (k, v) in keys.into_iter().zip(vals) {
                    map.insert(k, v);
                }
                results.push(YamlValue::Map(map));
            }
        }
    }
    results.pop().unwrap_or(YamlValue::Null)
}

/// Spreads parsed YAML into metadata matching JS `Object.assign(into ?? {}, doc)`.
fn merge_metadata(into: Option<Metadata>, doc: &YamlValue) -> Metadata {
    let mut out = into.unwrap_or_default();
    match doc {
        YamlValue::Map(m) => {
            for (k, v) in m {
                out.insert(k.clone(), v.clone());
            }
        }
        YamlValue::Seq(items) => {
            for (i, v) in items.iter().enumerate() {
                out.insert(i.to_string(), v.clone());
            }
        }
        YamlValue::String(s) => {
            for (i, ch) in s.chars().enumerate() {
                out.insert(i.to_string(), YamlValue::String(ch.to_string()));
            }
        }
        YamlValue::Null | YamlValue::Bool(_) | YamlValue::Number(_) => {}
    }
    out
}

fn is_block_scalar_header(code: &str) -> bool {
    let trimmed = code.trim_end_matches(is_space_char);
    let bytes = trimmed.as_bytes();
    let mut i = bytes.len();
    while i > 0 && (bytes[i - 1].is_ascii_digit() || matches!(bytes[i - 1], b'+' | b'-')) {
        i -= 1;
    }
    if i == 0 || !matches!(bytes[i - 1], b'>' | b'|') {
        return false;
    }
    i -= 1;
    let before = trimmed[..i].trim_end_matches(is_space_char);
    before.ends_with(':')
}

fn strip_trailing_comma(code: &str) -> String {
    let bytes = code.as_bytes();
    let mut end = bytes.len();
    while end > 0 && matches!(bytes[end - 1], b' ' | b'\t') {
        end -= 1;
    }
    if end > 0 && bytes[end - 1] == b',' {
        format!("{}{}", &code[..end - 1], &code[end..])
    } else {
        code.to_string()
    }
}

/// Removes trailing commas on lines of a multi-line metadata body while leaving quoted
/// scalars, flow collections, and block scalars untouched.
fn strip_line_trailing_commas(body: &str) -> String {
    let mut in_single = false;
    let mut in_double = false;
    let mut flow_depth: usize = 0;
    let mut block_scalar_indent: Option<usize> = None;
    let mut out: Vec<String> = Vec::new();

    for line in body.split('\n') {
        if let Some(bs_indent) = block_scalar_indent {
            let indent = line.len() - line.trim_start().len();
            if line.trim().is_empty() || indent > bs_indent {
                out.push(line.to_string());
                continue;
            }
            block_scalar_indent = None;
        }
        let mut comment_start: Option<usize> = None;
        let mut iter = line.char_indices().peekable();
        let mut prev_ch: Option<char> = None;
        while let Some((idx, ch)) = iter.next() {
            if in_double {
                if ch == '\\' {
                    let _ = iter.next();
                    prev_ch = None;
                    continue;
                } else if ch == '"' {
                    in_double = false;
                }
            } else if in_single {
                if ch == '\'' {
                    in_single = false;
                }
            } else if ch == '"' {
                in_double = true;
            } else if ch == '\'' {
                in_single = true;
            } else if ch == '#' && (idx == 0 || matches!(prev_ch, Some(' ' | '\t'))) {
                comment_start = Some(idx);
                break;
            } else if ch == '[' || ch == '{' {
                flow_depth += 1;
            } else if ch == ']' || ch == '}' {
                flow_depth = flow_depth.saturating_sub(1);
            }
            prev_ch = Some(ch);
        }
        if in_single || in_double || flow_depth > 0 {
            out.push(line.to_string());
            continue;
        }
        let (code, comment) = match comment_start {
            Some(at) => (&line[..at], &line[at..]),
            None => (line, ""),
        };
        if is_block_scalar_header(code) {
            block_scalar_indent = Some(line.len() - line.trim_start().len());
            out.push(line.to_string());
            continue;
        }
        let mut fixed = strip_trailing_comma(code);
        fixed.push_str(comment);
        out.push(fixed);
    }
    out.join("\n")
}

fn edge_semantic(link_type: &str, stroke: &str) -> Option<EdgeSemantic> {
    if link_type == "arrow_point" && stroke == "normal" {
        Some(EdgeSemantic::Sequence)
    } else if link_type == "arrow_cross" && stroke == "normal" {
        Some(EdgeSemantic::Failure)
    } else if link_type == "arrow_open" && stroke == "dotted" {
        Some(EdgeSemantic::Reference)
    } else {
        None
    }
}

fn destruct_end_link(raw: &str) -> (String, String, usize) {
    let s = raw.trim();
    let last = s.chars().last();
    let (mut line, link_type) = match last {
        Some('x') => (&s[..s.len() - 1], "arrow_cross"),
        Some('>') => (&s[..s.len() - 1], "arrow_point"),
        Some('-' | '.') => (s, "arrow_open"),
        Some(ch) => (&s[..s.len() - ch.len_utf8()], "arrow_open"),
        None => (s, "arrow_open"),
    };
    let mut stroke = "normal";
    let mut length = line.chars().count().saturating_sub(1);
    let dots = line.bytes().filter(|&b| b == b'.').count();
    if dots > 0 {
        stroke = "dotted";
        length = dots;
    }
    let _ = &mut line;
    (link_type.to_string(), stroke.to_string(), length)
}

fn semantic_metadata(metadata: Option<&Metadata>) -> Option<Metadata> {
    let meta = metadata?;
    let mut out = IndexMap::new();
    for (k, v) in meta {
        if is_presentation_key(k) {
            continue;
        }
        out.insert(k.clone(), v.clone());
    }
    if out.is_empty() { None } else { Some(out) }
}

#[derive(Debug, Clone)]
pub struct AgentflowDb {
    pub direction: Option<String>,
    pub nodes: IndexMap<String, AgentNode>,
    pub edges: Vec<AgentEdge>,
    pub subgraphs: Vec<AgentSubgraph>,
    pub connectors: IndexMap<String, AgentNode>,
    pub classes: IndexMap<String, AgentClassDef>,
    pub tooltips: IndexMap<String, String>,
    pub default_edge_style: Option<Vec<String>>,
    pub default_interpolate: Option<String>,
    pub mappings: Vec<ElementMapping>,
    pub diagnostics: Vec<Diagnostic>,
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub line_offset: usize,
    pub cached_graph: Option<AgentGraph>,

    subgraph_lookup: HashMap<String, usize>,
    global_nodes: HashSet<String>,
    members: HashSet<String>,
    edge_by_id: HashMap<String, usize>,
    pair_count: HashMap<(String, String), usize>,
    sub_count: usize,
    bare_mappings: HashSet<usize>,
    first_mapping: HashMap<String, usize>,
    reported: HashMap<String, Vec<Diagnostic>>,
    options: AgentflowDbOptions,
}

impl Default for AgentflowDb {
    fn default() -> Self {
        Self::new(AgentflowDbOptions::default())
    }
}

impl AgentflowDb {
    pub fn new(options: AgentflowDbOptions) -> Self {
        let line_offset = options.line_offset;
        Self {
            direction: None,
            nodes: IndexMap::new(),
            edges: Vec::new(),
            subgraphs: Vec::new(),
            connectors: IndexMap::new(),
            classes: IndexMap::new(),
            tooltips: IndexMap::new(),
            default_edge_style: None,
            default_interpolate: None,
            mappings: Vec::new(),
            diagnostics: Vec::new(),
            title: None,
            acc_title: None,
            acc_descr: None,
            line_offset,
            cached_graph: None,
            subgraph_lookup: HashMap::new(),
            global_nodes: HashSet::new(),
            members: HashSet::new(),
            edge_by_id: HashMap::new(),
            pair_count: HashMap::new(),
            sub_count: 0,
            bare_mappings: HashSet::new(),
            first_mapping: HashMap::new(),
            reported: HashMap::new(),
            options,
        }
    }

    fn error_at(&self, loc: Option<Loc>, err_src: Option<&ErrorSource<'_>>) -> (usize, usize) {
        let Some(loc) = loc else {
            return (0, 0);
        };
        if let Some(es) = err_src {
            let at = match es.brace_edits {
                Some(edits) => input_offset(&[edits.to_vec()], loc.start_byte),
                None => loc.start_byte,
            };
            let resolved = locate(es.source, at, es.origin);
            (resolved.line, resolved.column)
        } else {
            (loc.first_line + self.line_offset, loc.first_column + 1)
        }
    }

    fn shape_error(&self, message: String, loc: Option<Loc>, err_src: Option<&ErrorSource<'_>>) -> PeleError {
        let (line, column) = self.error_at(loc, err_src);
        PeleError::new(message, ErrorCode::Semantic)
            .with_diagram_type(DiagramType::Agentflow)
            .with_location(SourceLocation {
                line,
                column,
                snippet: String::new(),
            })
    }

    fn parse_metadata(&self, id: &str, source: &str, loc: Option<Loc>, err_src: Option<&ErrorSource<'_>>) -> Result<YamlValue, PeleError> {
        let multiline = source.contains('\n');
        let input = if multiline { format!("{source}\n") } else { format!("{{\n{source}\n}}") };
        let parsed = match parse_yaml(&input) {
            Ok(v) => v,
            Err(first_err) => {
                let stripped = if multiline { strip_line_trailing_commas(source) } else { source.to_string() };
                let retried = if stripped != source {
                    parse_yaml(&format!("{stripped}\n")).ok()
                } else {
                    None
                };
                match retried {
                    Some(v) => v,
                    None => {
                        let (line, column) = self.error_at(loc, err_src);
                        let at = if loc.is_some() { format!(" ({line}:{column})") } else { String::new() };
                        return Err(
                            PeleError::new(format!(r#"Metadata of "{id}" is not valid YAML. {first_err}{at}"#), ErrorCode::Syntax)
                                .with_diagram_type(DiagramType::Agentflow)
                                .with_location(SourceLocation {
                                    line,
                                    column,
                                    snippet: String::new(),
                                }),
                        );
                    }
                }
            }
        };
        let normalized = match parsed {
            YamlValue::Null => YamlValue::Map(IndexMap::new()),
            other @ (YamlValue::Bool(_) | YamlValue::Number(_) | YamlValue::String(_) | YamlValue::Seq(_) | YamlValue::Map(_)) => other,
        };
        Ok(strip_prototype_keys(normalized))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add_vertex(
        &mut self,
        id: &str,
        text_obj: Option<&FlowText>,
        node_type: Option<&str>,
        style: Option<&[String]>,
        classes: Option<&[String]>,
        dir: Option<&str>,
        props: Option<IndexMap<String, String>>,
        metadata: Option<&str>,
        metadata_loc: Option<Loc>,
        err_src: Option<&ErrorSource<'_>>,
    ) -> Result<(), PeleError> {
        if id.trim().is_empty() {
            return Ok(());
        }

        let mut doc: Option<YamlValue> = None;
        let mut authored_shape: Option<String> = None;
        if let Some(meta_src) = metadata {
            let mut parsed = self.parse_metadata(id, meta_src, metadata_loc, err_src)?;
            if let YamlValue::Map(ref mut map) = parsed
                && let Some(YamlValue::String(s)) = map.get("shape")
            {
                let authored = s.clone();
                let resolved = resolve_shape_alias(&authored).to_string();
                authored_shape = Some(authored);
                map.insert("shape".to_string(), YamlValue::String(resolved));
            }
            doc = Some(parsed);
        }

        if let Some(&sg_idx) = self.subgraph_lookup.get(id)
            && let Some(ref d) = doc
        {
            let cur = self.subgraphs[sg_idx].metadata.take();
            self.subgraphs[sg_idx].metadata = Some(merge_metadata(cur, d));
            return Ok(());
        }

        if self.connectors.contains_key(id)
            && let Some(ref d) = doc
        {
            if let Some(conn) = self.connectors.get_mut(id) {
                let cur = conn.metadata.take();
                conn.metadata = Some(merge_metadata(cur, d));
            }
            if let Some(node) = self.nodes.get_mut(id) {
                let cur = node.metadata.take();
                node.metadata = Some(merge_metadata(cur, d));
            }
            return Ok(());
        }

        if id == "connectors" {
            return Ok(());
        }

        if let Some(&edge_idx) = self.edge_by_id.get(id) {
            let edge = &mut self.edges[edge_idx];
            if let Some(YamlValue::Map(ref fields)) = doc {
                if let Some(anim) = fields.get("animate") {
                    edge.animate = Some(anim.clone());
                }
                if let Some(anim) = fields.get("animation") {
                    edge.animation = Some(anim.clone());
                }
                if let Some(curve) = fields.get("curve") {
                    edge.interpolate = Some(yaml_to_js_string(curve));
                }
            }
            if let Some(ref d) = doc {
                let cur = edge.metadata.take();
                edge.metadata = Some(merge_metadata(cur, d));
            }
            return Ok(());
        }

        let props_val = props.unwrap_or_default();
        if !self.nodes.contains_key(id) {
            self.nodes.insert(
                id.to_string(),
                AgentNode {
                    id: id.to_string(),
                    text: None,
                    label_type: LabelType::Text,
                    node_type: None,
                    styles: Vec::new(),
                    classes: Vec::new(),
                    dir: None,
                    props: None,
                    link: None,
                    link_target: None,
                    metadata: None,
                    is_connector: false,
                },
            );
        }

        {
            let vertex = self.nodes.get_mut(id).unwrap();
            if let Some(t) = text_obj {
                vertex.label_type = t.label_type;
                vertex.text = Some(unquote(t.text.trim()));
            } else if vertex.text.is_none() {
                vertex.text = Some(id.to_string());
            }
            if let Some(nt) = node_type {
                vertex.node_type = Some(nt.to_string());
            }
            if let Some(st) = style {
                vertex.styles.extend(st.iter().cloned());
            }
            if let Some(cl) = classes {
                vertex.classes.extend(cl.iter().cloned());
            }
            if let Some(d) = dir {
                vertex.dir = Some(d.to_string());
            }
            match vertex.props.as_mut() {
                None => vertex.props = Some(props_val),
                Some(existing) => {
                    for (k, v) in props_val {
                        existing.insert(k, v);
                    }
                }
            }
        }

        let Some(ref d) = doc else {
            return Ok(());
        };
        {
            let vertex = self.nodes.get_mut(id).unwrap();
            let cur = vertex.metadata.take();
            vertex.metadata = Some(merge_metadata(cur, d));
        }

        let YamlValue::Map(fields) = d else {
            return Ok(());
        };

        if let Some(shape_val) = fields.get("shape")
            && is_truthy(shape_val)
        {
            let authored = match (&authored_shape, shape_val) {
                (Some(a), _) => Some(a.as_str()),
                (None, YamlValue::String(s)) => Some(s.as_str()),
                (None, YamlValue::Null | YamlValue::Bool(_) | YamlValue::Number(_) | YamlValue::Seq(_) | YamlValue::Map(_)) => None,
            };
            let Some(authored_str) = authored else {
                return Err(self.shape_error(format!("No such shape: {}.", yaml_to_json_string(shape_val)), metadata_loc, err_src));
            };
            if authored_str != authored_str.to_lowercase() || authored_str.contains('_') {
                return Err(self.shape_error(
                    format!("No such shape: {authored_str}. Shape names should be lowercase."),
                    metadata_loc,
                    err_src,
                ));
            }
            let shape = shape_val.as_str().unwrap_or("");
            if !is_valid_shape(shape) {
                return Err(self.shape_error(format!("No such shape: {shape}."), metadata_loc, err_src));
            }
            self.nodes.get_mut(id).unwrap().node_type = Some(shape.to_string());
        }

        if let Some(label_val) = fields.get("label")
            && is_truthy(label_val)
        {
            let vertex = self.nodes.get_mut(id).unwrap();
            vertex.text = Some(yaml_to_js_string(label_val));
            vertex.label_type = label_type_from_yaml(fields.get("labelType"));
        }

        Ok(())
    }

    pub fn add_single_link(&mut self, start: &str, end: &str, info: Option<&LinkInfo>, id: Option<&str>) -> Result<(), PeleError> {
        let mut edge = AgentEdge {
            start: start.to_string(),
            end: end.to_string(),
            edge_type: None,
            text: String::new(),
            label_type: LabelType::Text,
            stroke: None,
            edge_semantic: None,
            length: None,
            style: None,
            classes: Vec::new(),
            id: None,
            is_user_defined_id: false,
            interpolate: self.default_interpolate.clone(),
            animate: None,
            animation: None,
            metadata: None,
        };
        if let Some(info) = info {
            if let Some(ref lt) = info.text {
                edge.text = unquote(lt.text.trim());
                edge.label_type = lt.label_type;
            }
            edge.edge_type = Some(info.link_type.clone());
            edge.stroke = Some(info.stroke.clone());
            edge.length = info.length.map(|l| l.min(10));
            edge.edge_semantic = info.edge_semantic;
        }
        let pair = (start.to_string(), end.to_string());
        let existing = self.pair_count.get(&pair).copied().unwrap_or(0);
        let assigned_id = if let Some(uid) = id
            && !uid.is_empty()
            && !self.edge_by_id.contains_key(uid)
        {
            edge.is_user_defined_id = true;
            uid.to_string()
        } else {
            let suffix = if existing == 0 { 0 } else { existing + 1 };
            format!("L_{start}_{end}_{suffix}")
        };
        edge.id = Some(assigned_id.clone());

        if let Some(max) = self.options.max_edges
            && self.edges.len() >= max
        {
            return Err(PeleError::new(format!("Edge limit exceeded. The limit is {max}."), ErrorCode::Limit).with_diagram_type(DiagramType::Agentflow));
        }

        let idx = self.edges.len();
        self.edges.push(edge);
        self.pair_count.insert(pair, existing + 1);
        self.edge_by_id.entry(assigned_id).or_insert(idx);
        Ok(())
    }

    pub fn add_link(&mut self, starts: &[String], ends: &[String], link_data: Option<&LinkInfo>) -> Result<(), PeleError> {
        let cleaned_id = link_data.and_then(|d| d.id.as_deref()).map(|s| s.replacen('@', "", 1));
        let last_start = starts.last().map(String::as_str);
        let first_end = ends.first().map(String::as_str);
        for start in starts {
            for end in ends {
                let use_id = if Some(start.as_str()) == last_start && Some(end.as_str()) == first_end {
                    cleaned_id.as_deref()
                } else {
                    None
                };
                self.add_single_link(start, end, link_data, use_id)?;
            }
        }
        Ok(())
    }

    fn edge_index(&self, pos: &str) -> Result<usize, PeleError> {
        if let Ok(idx) = pos.parse::<usize>()
            && idx < self.edges.len()
        {
            return Ok(idx);
        }
        let max_idx = self.edges.len() as isize - 1;
        Err(PeleError::new(
            format!(
                "The index {pos} for linkStyle is out of bounds. Valid indices for linkStyle are between 0 and {max_idx}. (Help: Ensure that the index is within the range of existing edges.)"
            ),
            ErrorCode::Semantic,
        )
        .with_diagram_type(DiagramType::Agentflow))
    }

    pub fn update_link_interpolate(&mut self, positions: &[String], interpolate: &str) -> Result<(), PeleError> {
        for pos in positions {
            if pos == "default" {
                self.default_interpolate = Some(interpolate.to_string());
            } else {
                let idx = self.edge_index(pos)?;
                self.edges[idx].interpolate = Some(interpolate.to_string());
            }
        }
        Ok(())
    }

    pub fn update_link(&mut self, positions: &[String], mut style: Vec<String>) -> Result<(), PeleError> {
        for pos in positions {
            if pos == "default" {
                self.default_edge_style = Some(style.clone());
                continue;
            }
            let idx = self.edge_index(pos)?;
            if !style.is_empty() && !style.iter().any(|s| s.starts_with("fill")) {
                style.push("fill:none".to_string());
            }
            self.edges[idx].style = Some(style.clone());
        }
        Ok(())
    }

    pub fn add_class(&mut self, ids: &str, styles: &[String]) {
        let joined = styles.join(",");
        let escaped = joined.replace("\\,", "§§§").replace(',', ";").replace("§§§", ",");
        let parts: Vec<String> = escaped.split(';').map(str::to_string).collect();
        for id in ids.split(',') {
            let class_node = self.classes.entry(id.to_string()).or_insert_with(|| AgentClassDef {
                id: id.to_string(),
                styles: Vec::new(),
                text_styles: Vec::new(),
            });
            for s in &parts {
                if s.contains("color") {
                    class_node.text_styles.push(s.replacen("fill", "bgFill", 1));
                }
                class_node.styles.push(s.clone());
            }
        }
    }

    pub fn set_direction(&mut self, dir: &str) {
        let mut d = dir.trim();
        if d.contains('<') {
            d = "RL";
        }
        if d.contains('^') {
            d = "BT";
        }
        if d.contains('>') {
            d = "LR";
        }
        if d.contains('v') {
            d = "TB";
        }
        if d == "TD" {
            d = "TB";
        }
        self.direction = Some(d.to_string());
    }

    pub fn set_class(&mut self, ids: &str, class_name: &str) {
        for id in ids.split(',') {
            if let Some(node) = self.nodes.get_mut(id) {
                node.classes.push(class_name.to_string());
            }
            if let Some(&edge_idx) = self.edge_by_id.get(id) {
                self.edges[edge_idx].classes.push(class_name.to_string());
            }
            if let Some(&sg_idx) = self.subgraph_lookup.get(id) {
                self.subgraphs[sg_idx].classes.push(class_name.to_string());
            }
        }
    }

    pub fn set_tooltip(&mut self, ids: &str, tooltip: Option<&str>) {
        let Some(tip) = tooltip else {
            return;
        };
        for id in ids.split(',') {
            self.tooltips.insert(id.to_string(), tip.to_string());
        }
    }

    pub fn set_link(&mut self, ids: &str, link: &str, target: Option<&str>) {
        let url = link.trim();
        for id in ids.split(',') {
            if let Some(vertex) = self.nodes.get_mut(id) {
                vertex.link = if url.is_empty() { None } else { Some(safe_url(url)) };
                vertex.link_target = target.map(str::to_string);
            }
        }
        self.set_class(ids, "clickable");
    }

    pub fn set_click_event(&mut self, ids: &str, _function_name: Option<&str>, _function_args: Option<&str>) {
        self.set_class(ids, "clickable");
    }

    pub fn set_acc_title(&mut self, text: &str) {
        self.acc_title = Some(text.trim_start_matches(is_space_char).to_string());
    }

    pub fn set_acc_description(&mut self, text: &str) {
        let mut out = String::with_capacity(text.len());
        let mut after_nl = false;
        for ch in text.chars() {
            if ch == '\n' {
                out.push('\n');
                after_nl = true;
            } else if after_nl && is_space_char(ch) {
                continue;
            } else {
                after_nl = false;
                out.push(ch);
            }
        }
        self.acc_descr = Some(out);
    }

    pub fn add_subgraph(&mut self, id_text: Option<&FlowText>, list: &[DocItem], title_text: Option<&FlowText>, same_id_and_title: bool) -> String {
        let mut id: Option<String> = id_text.map(|t| t.text.trim().to_string());
        let title = title_text.map_or("", |t| t.text.as_str());
        if same_id_and_title && title.chars().any(is_space_char) {
            id = None;
        }

        let mut seen: HashSet<String> = HashSet::new();
        let mut node_list: Vec<String> = Vec::new();
        let mut dir: Option<String> = None;
        for entry in list {
            match entry {
                DocItem::Single(item) => {
                    if !item.trim().is_empty() && seen.insert(item.clone()) {
                        node_list.push(item.clone());
                    }
                }
                DocItem::List(items) => {
                    for item in items {
                        if !item.trim().is_empty() && seen.insert(item.clone()) {
                            node_list.push(item.clone());
                        }
                    }
                }
                DocItem::Dir(v) => {
                    dir = Some(v.clone());
                }
            }
        }
        if dir.is_none() && self.options.inherit_dir {
            dir = self.direction.clone().or_else(|| self.options.direction.clone());
        }

        let id = id.unwrap_or_else(|| format!("subGraph{}", self.sub_count));
        self.sub_count += 1;

        let mut nodes = Vec::new();
        for node_id in node_list {
            if node_id != id && !self.global_nodes.contains(&node_id) && !self.members.contains(&node_id) {
                self.members.insert(node_id.clone());
                nodes.push(node_id);
            }
        }

        if let Some(&existing_idx) = self.subgraph_lookup.get(&id) {
            let existing = &mut self.subgraphs[existing_idx];
            existing.nodes.extend(nodes);
            if !title.trim().is_empty() {
                existing.title = title.trim().to_string();
            }
            if let Some(d) = dir {
                existing.dir = Some(d);
            }
            return id;
        }

        let lbl_type = title_text.map_or(LabelType::Markdown, |t| t.label_type);
        let sg = AgentSubgraph {
            id: id.clone(),
            nodes,
            title: title.trim().to_string(),
            classes: Vec::new(),
            dir,
            label_type: lbl_type,
            subgraph_type: "flow",
            metadata: None,
        };
        let idx = self.subgraphs.len();
        self.subgraphs.push(sg);
        self.subgraph_lookup.insert(id.clone(), idx);
        id
    }

    pub fn add_global(&mut self, list: &[DocItem]) {
        let mut release = false;
        let mut add = |item: &str| {
            let id = item.trim();
            if id.is_empty() {
                return;
            }
            self.global_nodes.insert(id.to_string());
            if self.members.remove(id) {
                release = true;
            }
        };
        for entry in list {
            match entry {
                DocItem::Single(s) => add(s),
                DocItem::List(items) => {
                    for s in items {
                        add(s);
                    }
                }
                DocItem::Dir(_) => {}
            }
        }
        if !release {
            return;
        }
        for sg in &mut self.subgraphs {
            sg.nodes.retain(|node_id| !self.global_nodes.contains(node_id));
        }
    }

    pub fn add_connector(&mut self, text_obj: Option<&FlowText>, title_obj: Option<&FlowText>) -> String {
        let Some(id) = text_obj.map(|t| t.text.trim()).filter(|s| !s.is_empty()) else {
            return String::new();
        };
        let title = title_obj.map_or("", |t| t.text.trim());
        if !self.connectors.contains_key(id) {
            let created = AgentNode {
                id: id.to_string(),
                text: Some(if !title.is_empty() { title.to_string() } else { id.to_string() }),
                label_type: LabelType::Text,
                node_type: None,
                styles: Vec::new(),
                classes: Vec::new(),
                dir: None,
                props: None,
                link: None,
                link_target: None,
                metadata: None,
                is_connector: true,
            };
            self.connectors.insert(id.to_string(), created.clone());
            self.nodes.insert(id.to_string(), created);
        } else if !title.is_empty() {
            if let Some(c) = self.connectors.get_mut(id) {
                c.text = Some(title.to_string());
            }
            if let Some(n) = self.nodes.get_mut(id) {
                n.text = Some(title.to_string());
            }
        }
        id.to_string()
    }

    pub fn destruct_link(end: &str, start: Option<&str>) -> LinkInfo {
        let (link_type, stroke, length) = destruct_end_link(end);
        if let Some(st) = start {
            let start_stroke = if st.contains('.') { "dotted" } else { "normal" };
            if start_stroke != stroke {
                return LinkInfo {
                    link_type: "INVALID".to_string(),
                    stroke: "INVALID".to_string(),
                    length: None,
                    edge_semantic: None,
                    text: None,
                    id: None,
                };
            }
        }
        let semantic = edge_semantic(&link_type, &stroke);
        LinkInfo {
            link_type,
            stroke,
            length: Some(length),
            edge_semantic: semantic,
            text: None,
            id: None,
        }
    }

    pub fn subgraph(&self, id: &str) -> Option<&AgentSubgraph> {
        self.subgraph_lookup.get(id).map(|&idx| &self.subgraphs[idx])
    }

    pub fn vertex_kind(&self, vertex: &AgentNode) -> VertexKind {
        if is_tool_definition(vertex) {
            return VertexKind::Tool;
        }
        let shape = vertex.node_type.as_deref().map(resolve_shape_alias);
        match shape {
            Some("hexagon" | "hex") => VertexKind::Action,
            Some("lean-right" | "lean_right") => VertexKind::Input,
            Some("lin-doc" | "lined-document") => VertexKind::Refdoc,
            Some("diamond") => VertexKind::Decision,
            _ => VertexKind::Task,
        }
    }

    pub fn semantic_model(&self) -> SemanticModel {
        let mut vertices = Vec::new();
        let mut connectors = Vec::new();
        for (id, v) in &self.nodes {
            if self.subgraph_lookup.contains_key(id) {
                continue;
            }
            let metadata = semantic_metadata(v.metadata.as_ref());
            if v.is_connector {
                let title = v.text.as_deref().filter(|&t| t != id).map(str::to_string);
                connectors.push(SemanticConnector {
                    id: id.clone(),
                    title,
                    metadata,
                });
                continue;
            }
            let shape = v.node_type.as_deref().map(|s| resolve_shape_alias(s).to_string());
            vertices.push(SemanticVertex {
                id: id.clone(),
                label: v.text.clone(),
                shape,
                vertex_kind: self.vertex_kind(v),
                metadata,
            });
        }

        let edges = self
            .edges
            .iter()
            .map(|e| SemanticEdge {
                start: e.start.clone(),
                end: e.end.clone(),
                id: e.id.clone(),
                label: if e.text.is_empty() { None } else { Some(e.text.clone()) },
                edge_type: e.edge_type.clone(),
                stroke: e.stroke.clone(),
                edge_semantic: e.edge_semantic,
                length: e.length,
                metadata: e.metadata.as_ref().filter(|m| !m.is_empty()).cloned(),
            })
            .collect();

        let subgraphs = self
            .subgraphs
            .iter()
            .map(|sg| SemanticSubgraph {
                id: sg.id.clone(),
                subgraph_type: sg.subgraph_type,
                title: sg.title.clone(),
                nodes: sg.nodes.clone(),
                metadata: semantic_metadata(sg.metadata.as_ref()),
                direction: sg.dir.clone(),
            })
            .collect();

        SemanticModel {
            direction: self.direction.clone(),
            vertices,
            edges,
            subgraphs,
            connectors,
            diagnostics: self.diagnostics.clone(),
        }
    }

    fn position(&self, loc: Option<Loc>) -> ElementPosition {
        let start_line = loc.map_or(0, |l| l.first_line);
        let start_column = loc.map_or(0, |l| l.first_column);
        let end_line = loc.map_or(start_line, |l| l.last_line);
        let end_column = loc.map_or(start_column, |l| l.last_column);
        ElementPosition {
            start_line: start_line + self.line_offset,
            start_column,
            end_line: end_line + self.line_offset,
            end_column,
            start_index: 0,
            end_index: 0,
        }
    }

    fn push_mapping(&mut self, id: String, stmt_type: StatementType, position: ElementPosition) -> usize {
        let idx = self.mappings.len();
        self.mappings.push(ElementMapping {
            id: id.clone(),
            stmt_type,
            position,
        });
        self.first_mapping.entry(id).or_insert(idx);
        idx
    }

    pub fn add_vertex_mapping(&mut self, id: &str, has_shape: bool, loc: Option<Loc>) {
        if id.is_empty() {
            return;
        }
        let pos = self.position(loc);
        let idx = self.push_mapping(id.to_string(), StatementType::Vertex, pos);
        if !has_shape {
            self.bare_mappings.insert(idx);
        }
    }

    pub fn extend_vertex_mapping(&mut self, id: &str, loc: Option<Loc>) {
        let Some(loc) = loc else {
            return;
        };
        if id.is_empty() {
            return;
        }
        let end = self.position(Some(loc));
        for i in (0..self.mappings.len()).rev() {
            if self.mappings[i].stmt_type != StatementType::Vertex || self.mappings[i].id != id {
                continue;
            }
            if self.bare_mappings.remove(&i) {
                self.mappings[i].stmt_type = StatementType::Attachment;
            }
            let p = &mut self.mappings[i].position;
            if end.end_line > p.end_line || (end.end_line == p.end_line && end.end_column > p.end_column) {
                p.end_line = end.end_line;
                p.end_column = end.end_column;
            }
            return;
        }
        self.push_mapping(id.to_string(), StatementType::Attachment, end);
    }

    pub fn add_edge_mapping(&mut self, to_nodes: &[String], loc: Option<Loc>) {
        let ids: Vec<&str> = to_nodes.iter().map(String::as_str).filter(|s| !s.is_empty()).collect();
        let id = if ids.is_empty() { "edge".to_string() } else { ids.join(">") };
        let pos = self.position(loc);
        self.push_mapping(id, StatementType::Edge, pos);
    }

    fn block_mapping(&mut self, id: &str, stmt_type: StatementType, start_loc: Option<Loc>, end_loc: Option<Loc>) {
        if id.is_empty() {
            return;
        }
        let start = self.position(start_loc);
        let end = end_loc.map_or(start, |l| self.position(Some(l)));
        self.push_mapping(
            id.to_string(),
            stmt_type,
            ElementPosition {
                start_line: start.start_line,
                start_column: start.start_column,
                end_line: end.end_line,
                end_column: end.end_column,
                start_index: 0,
                end_index: 0,
            },
        );
    }

    pub fn add_subgraph_mapping(&mut self, id: Option<&str>, start_loc: Option<Loc>, end_loc: Option<Loc>) {
        self.block_mapping(id.unwrap_or(""), StatementType::Subgraph, start_loc, end_loc);
    }

    pub fn add_connector_mapping(&mut self, text_obj: Option<&FlowText>, start_loc: Option<Loc>, end_loc: Option<Loc>) {
        let id = text_obj.map_or("", |t| t.text.trim());
        self.block_mapping(id, StatementType::Connector, start_loc, end_loc);
    }

    fn emit(&mut self, id: DiagnosticId, severity: DiagnosticSeverity, message: String, node_id: Option<&str>, edge_id: Option<&str>) {
        let anchor = node_id.or(edge_id);
        let position = anchor.and_then(|a| self.first_mapping.get(a).copied()).map(|idx| self.mappings[idx].position);
        let diagnostic = Diagnostic {
            id,
            severity,
            message,
            node_id: node_id.map(str::to_string),
            edge_id: if node_id.is_some() { None } else { edge_id.map(str::to_string) },
            position,
        };
        let key = anchor.unwrap_or("").to_string();
        let entry = self.reported.entry(key).or_default();
        for existing in entry.iter() {
            if existing.id == diagnostic.id
                && existing.severity == diagnostic.severity
                && existing.message == diagnostic.message
                && existing.node_id == diagnostic.node_id
                && existing.edge_id == diagnostic.edge_id
            {
                return;
            }
        }
        entry.push(diagnostic.clone());
        self.diagnostics.push(diagnostic);
    }

    pub fn emit_warning(&mut self, id: DiagnosticId, message: String, node_id: Option<&str>, edge_id: Option<&str>) {
        self.emit(id, DiagnosticSeverity::Warning, message, node_id, edge_id);
    }

    pub fn emit_error(&mut self, id: DiagnosticId, message: String, node_id: Option<&str>, edge_id: Option<&str>) {
        self.emit(id, DiagnosticSeverity::Error, message, node_id, edge_id);
    }
}

impl ShapeSink for AgentflowDb {
    fn emit_shape_error(&mut self, id: DiagnosticId, message: String, node_id: &str) {
        self.emit_error(id, message, Some(node_id), None);
    }

    fn emit_shape_warning(&mut self, id: DiagnosticId, message: String, node_id: &str) {
        self.emit_warning(id, message, Some(node_id), None);
    }
}
