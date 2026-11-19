use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;

use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError};
use crate::util::url::safe_url;
use crate::util::yaml::{YamlValue, parse_yaml};

use super::shapes::is_valid_shape;
use super::types::{DocItem, FlowClassDef, FlowEdge, FlowLinkInfo, FlowNode, FlowSubgraph, FlowText, LabelType};

#[derive(Debug, Clone, Default)]
pub struct FlowDbOptions {
    pub max_edges: Option<usize>,
    pub inherit_dir: bool,
    pub direction: Option<String>,
}

fn unquote(text: &str) -> &str {
    if text.len() >= 2 && text.starts_with('"') && text.ends_with('"') {
        &text[1..text.len() - 1]
    } else {
        text
    }
}

fn yaml_to_string(v: &YamlValue) -> String {
    match v {
        YamlValue::Null => "null".to_string(),
        YamlValue::Bool(b) => b.to_string(),
        YamlValue::Number(n) => {
            if n.fract() == 0.0 && n.abs() < 1e15 {
                format!("{}", *n as i64)
            } else {
                format!("{n}")
            }
        }
        YamlValue::String(s) => s.clone(),
        YamlValue::Seq(_) => String::new(),
        YamlValue::Map(_) => "[object Object]".to_string(),
    }
}

fn is_truthy_yaml(v: &YamlValue) -> bool {
    match v {
        YamlValue::Null => false,
        YamlValue::Bool(b) => *b,
        YamlValue::Number(n) => *n != 0.0 && !n.is_nan(),
        YamlValue::String(s) => !s.is_empty(),
        YamlValue::Seq(_) | YamlValue::Map(_) => true,
    }
}

fn destruct_start_link(raw: &str) -> (String, String) {
    let mut s = raw.trim();
    let link_type = match s.as_bytes().first() {
        Some(b'<') => {
            s = &s[1..];
            "arrow_point"
        }
        Some(b'x') => {
            s = &s[1..];
            "arrow_cross"
        }
        Some(b'o') => {
            s = &s[1..];
            "arrow_circle"
        }
        _ => "arrow_open",
    };
    let mut stroke = "normal";
    if s.contains('=') {
        stroke = "thick";
    }
    if s.contains('.') {
        stroke = "dotted";
    }
    (link_type.to_string(), stroke.to_string())
}

fn destruct_end_link(raw: &str) -> (String, String, i32) {
    let s = raw.trim();
    let mut line = if s.is_empty() { "" } else { &s[..s.len() - 1] };
    let mut link_type = "arrow_open".to_string();
    match s.as_bytes().last() {
        Some(b'x') => {
            link_type = "arrow_cross".to_string();
            if s.starts_with('x') && !line.is_empty() {
                link_type = format!("double_{link_type}");
                line = &line[1..];
            }
        }
        Some(b'>') => {
            link_type = "arrow_point".to_string();
            if s.starts_with('<') && !line.is_empty() {
                link_type = format!("double_{link_type}");
                line = &line[1..];
            }
        }
        Some(b'o') => {
            link_type = "arrow_circle".to_string();
            if s.starts_with('o') && !line.is_empty() {
                link_type = format!("double_{link_type}");
                line = &line[1..];
            }
        }
        _ => {}
    }
    let mut stroke = "normal";
    let mut length = line.len() as i32 - 1;
    if line.starts_with('=') {
        stroke = "thick";
    }
    if line.starts_with('~') {
        stroke = "invisible";
    }
    let dots = line.bytes().filter(|&b| b == b'.').count() as i32;
    if dots > 0 {
        stroke = "dotted";
        length = dots;
    }
    (link_type, stroke.to_string(), length)
}

#[derive(Debug, Clone)]
pub struct FlowDb {
    pub direction: Option<String>,
    pub nodes: IndexMap<String, FlowNode>,
    pub edges: Vec<FlowEdge>,
    pub subgraphs: Vec<FlowSubgraph>,
    pub classes: IndexMap<String, FlowClassDef>,
    pub tooltips: IndexMap<String, String>,
    pub default_edge_style: Option<Vec<String>>,
    pub default_interpolate: Option<String>,
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    subgraph_lookup: HashMap<String, usize>,
    members: HashSet<String>,
    edge_by_id: HashMap<String, usize>,
    pair_count: HashMap<(String, String), usize>,
    sub_count: usize,
    options: FlowDbOptions,
}

impl FlowDb {
    pub fn new(options: FlowDbOptions) -> Self {
        Self {
            direction: None,
            nodes: IndexMap::new(),
            edges: Vec::new(),
            subgraphs: Vec::new(),
            classes: IndexMap::new(),
            tooltips: IndexMap::new(),
            default_edge_style: None,
            default_interpolate: None,
            title: None,
            acc_title: None,
            acc_descr: None,
            subgraph_lookup: HashMap::new(),
            members: HashSet::new(),
            edge_by_id: HashMap::new(),
            pair_count: HashMap::new(),
            sub_count: 0,
            options,
        }
    }

    pub fn subgraph(&self, id: &str) -> Option<&FlowSubgraph> {
        self.subgraph_lookup.get(id).map(|&idx| &self.subgraphs[idx])
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add_vertex(
        &mut self,
        id: &str,
        text_obj: Option<FlowText>,
        shape_type: Option<&str>,
        style: Option<Vec<String>>,
        classes: Option<Vec<String>>,
        dir: Option<String>,
        props: Option<IndexMap<String, String>>,
        metadata: Option<&str>,
    ) -> Result<(), PeleError> {
        if id.trim().is_empty() {
            return Ok(());
        }

        let mut doc: Option<IndexMap<String, YamlValue>> = None;
        if let Some(meta) = metadata {
            let yaml = if meta.contains('\n') {
                format!("{meta}\n")
            } else {
                format!("{{\n{meta}\n}}")
            };
            let parsed = parse_yaml(&yaml).map_err(|err| {
                PeleError::new(format!("Metadata of \"{id}\" is not valid YAML. {err}"), ErrorCode::Syntax).with_diagram_type(DiagramType::Flowchart)
            })?;
            if let YamlValue::Map(map) = parsed {
                doc = Some(map);
            }
        }

        if let Some(&sg_idx) = self.subgraph_lookup.get(id)
            && let Some(doc_map) = doc
        {
            let target = self.subgraphs[sg_idx].metadata.get_or_insert_with(IndexMap::new);
            for (k, v) in doc_map {
                target.insert(k, v);
            }
            return Ok(());
        }

        if let Some(&edge_idx) = self.edge_by_id.get(id) {
            if let Some(doc_map) = doc {
                let edge = &mut self.edges[edge_idx];
                if let Some(v) = doc_map.get("animate") {
                    edge.animate = v.as_bool();
                }
                if let Some(v) = doc_map.get("animation") {
                    edge.animation = v.as_str().map(str::to_string);
                }
                if let Some(v) = doc_map.get("curve") {
                    edge.interpolate = v.as_str().map(str::to_string);
                }
            }
            return Ok(());
        }

        let vertex = self.nodes.entry(id.to_string()).or_insert_with(|| FlowNode {
            id: id.to_string(),
            text: None,
            label_type: LabelType::Text,
            shape_type: None,
            styles: Vec::new(),
            classes: Vec::new(),
            dir: None,
            props: IndexMap::new(),
            link: None,
            link_target: None,
            icon: None,
            form: None,
            pos: None,
            img: None,
            constraint: None,
            asset_width: None,
            asset_height: None,
        });

        if let Some(text) = text_obj {
            vertex.label_type = text.label_type;
            vertex.text = Some(unquote(text.text.trim()).to_string());
        } else if vertex.text.is_none() {
            vertex.text = Some(id.to_string());
        }
        if let Some(st) = shape_type {
            vertex.shape_type = Some(st.to_string());
        }
        if let Some(styles) = style {
            vertex.styles.extend(styles);
        }
        if let Some(cls) = classes {
            vertex.classes.extend(cls);
        }
        if let Some(d) = dir {
            vertex.dir = Some(d);
        }
        if let Some(p) = props {
            for (k, v) in p {
                vertex.props.insert(k, v);
            }
        }

        let Some(doc_map) = doc else {
            return Ok(());
        };

        if let Some(v) = doc_map.get("shape")
            && is_truthy_yaml(v)
        {
            let shape = yaml_to_string(v);
            if shape != shape.to_lowercase() || shape.contains('_') {
                return Err(
                    PeleError::new(format!("No such shape: {shape}. Shape names should be lowercase."), ErrorCode::Semantic)
                        .with_diagram_type(DiagramType::Flowchart),
                );
            }
            if !is_valid_shape(&shape) {
                return Err(PeleError::new(format!("No such shape: {shape}."), ErrorCode::Semantic).with_diagram_type(DiagramType::Flowchart));
            }
            vertex.shape_type = Some(shape);
        }
        let label_str = doc_map.get("label").and_then(YamlValue::as_str).map(str::to_string);
        if let Some(v) = doc_map.get("label")
            && is_truthy_yaml(v)
        {
            vertex.text = Some(yaml_to_string(v));
            let lt = doc_map.get("labelType").and_then(YamlValue::as_str);
            vertex.label_type = LabelType::from_opt(lt);
        }
        let has_nonempty_label = label_str.as_deref().is_some_and(|s| !s.trim().is_empty());
        if let Some(v) = doc_map.get("icon")
            && is_truthy_yaml(v)
        {
            vertex.icon = Some(yaml_to_string(v));
            if !has_nonempty_label && vertex.text.as_deref() == Some(id) {
                vertex.text = Some(String::new());
            }
        }
        if let Some(v) = doc_map.get("form")
            && is_truthy_yaml(v)
        {
            vertex.form = Some(yaml_to_string(v));
        }
        if let Some(v) = doc_map.get("pos")
            && is_truthy_yaml(v)
        {
            vertex.pos = Some(yaml_to_string(v));
        }
        if let Some(v) = doc_map.get("img")
            && is_truthy_yaml(v)
        {
            vertex.img = Some(yaml_to_string(v));
            if !has_nonempty_label && vertex.text.as_deref() == Some(id) {
                vertex.text = Some(String::new());
            }
        }
        if let Some(v) = doc_map.get("constraint")
            && is_truthy_yaml(v)
        {
            vertex.constraint = Some(yaml_to_string(v));
        }
        if let Some(v) = doc_map.get("w")
            && is_truthy_yaml(v)
        {
            vertex.asset_width = v.as_f64().or_else(|| yaml_to_string(v).parse().ok());
        }
        if let Some(v) = doc_map.get("h")
            && is_truthy_yaml(v)
        {
            vertex.asset_height = v.as_f64().or_else(|| yaml_to_string(v).parse().ok());
        }
        Ok(())
    }

    pub fn add_single_link(&mut self, start: &str, end: &str, link_info: Option<&FlowLinkInfo>, id: Option<&str>) -> Result<(), PeleError> {
        let mut edge = FlowEdge {
            start: start.to_string(),
            end: end.to_string(),
            edge_type: None,
            text: String::new(),
            label_type: LabelType::Text,
            stroke: None,
            length: None,
            style: None,
            classes: Vec::new(),
            id: None,
            is_user_defined_id: false,
            interpolate: self.default_interpolate.clone(),
            animate: None,
            animation: None,
        };
        if let Some(info) = link_info {
            if let Some(ref lt) = info.text {
                edge.text = unquote(lt.text.trim()).to_string();
                edge.label_type = lt.label_type;
            }
            edge.edge_type = Some(info.link_type.clone());
            edge.stroke = Some(info.stroke.clone());
            edge.length = info.length.map(|l| l.min(10));
        }
        let pair = (start.to_string(), end.to_string());
        let count = self.pair_count.get(&pair).copied().unwrap_or(0);
        let edge_id = if let Some(uid) = id
            && !uid.is_empty()
            && !self.edge_by_id.contains_key(uid)
        {
            edge.is_user_defined_id = true;
            uid.to_string()
        } else {
            format!("L_{start}_{end}_{}", if count == 0 { 0 } else { count + 1 })
        };
        edge.id = Some(edge_id.clone());

        if let Some(max) = self.options.max_edges
            && self.edges.len() >= max
        {
            return Err(PeleError::new(format!("Edge limit exceeded. The limit is {max}."), ErrorCode::Limit).with_diagram_type(DiagramType::Flowchart));
        }
        let idx = self.edges.len();
        self.edges.push(edge);
        self.pair_count.insert(pair, count + 1);
        self.edge_by_id.entry(edge_id).or_insert(idx);
        Ok(())
    }

    pub fn add_link(&mut self, starts: &[String], ends: &[String], link_data: Option<&FlowLinkInfo>) -> Result<(), PeleError> {
        let id = link_data.and_then(|d| d.id.as_deref()).map(|s| s.replacen('@', "", 1));
        let last_start = starts.last().map(String::as_str);
        let first_end = ends.first().map(String::as_str);
        for start in starts {
            for end in ends {
                let use_id = if Some(start.as_str()) == last_start && Some(end.as_str()) == first_end {
                    id.as_deref()
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
        let last = self.edges.len() as isize - 1;
        Err(PeleError::new(
            format!(
                "The index {pos} for linkStyle is out of bounds. Valid indices for linkStyle are between 0 and {last}. (Help: Ensure that the index is within the range of existing edges.)"
            ),
            ErrorCode::Semantic,
        )
        .with_diagram_type(DiagramType::Flowchart))
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
        let parts: Vec<&str> = escaped.split(';').collect();
        for id in ids.split(',') {
            let entry = self.classes.entry(id.to_string()).or_insert_with(|| FlowClassDef {
                id: id.to_string(),
                styles: Vec::new(),
                text_styles: Vec::new(),
            });
            for &s in &parts {
                if s.contains("color") {
                    entry.text_styles.push(s.replacen("fill", "bgFill", 1));
                }
                entry.styles.push(s.to_string());
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

    pub fn set_click_event(&mut self, ids: &str) {
        self.set_class(ids, "clickable");
    }

    pub fn set_acc_title(&mut self, text: &str) {
        self.acc_title = Some(text.trim_start().to_string());
    }

    pub fn set_acc_description(&mut self, text: &str) {
        let mut out = String::with_capacity(text.len());
        let mut after_nl = false;
        for ch in text.chars() {
            if ch == '\n' {
                out.push('\n');
                after_nl = true;
            } else if after_nl && ch.is_whitespace() {
                continue;
            } else {
                after_nl = false;
                out.push(ch);
            }
        }
        self.acc_descr = Some(out);
    }

    pub fn add_subgraph(&mut self, id_text: Option<&FlowText>, list: &[DocItem], title_text: Option<&FlowText>, same_id_and_title: bool) -> String {
        let mut id = id_text.map(|t| t.text.trim().to_string());
        let title = title_text.map_or("", |t| t.text.as_str());
        if same_id_and_title && title.chars().any(char::is_whitespace) {
            id = None;
        }

        let mut seen = HashSet::new();
        let mut node_list: Vec<String> = Vec::new();
        let mut dir: Option<String> = None;
        for entry in list {
            match entry {
                DocItem::Single(s) => {
                    if !s.trim().is_empty() && seen.insert(s.clone()) {
                        node_list.push(s.clone());
                    }
                }
                DocItem::Many(items) => {
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

        let filtered: Vec<String> = node_list.into_iter().filter(|nid| !self.members.contains(nid) && nid != &id).collect();
        for nid in &filtered {
            self.members.insert(nid.clone());
        }

        if let Some(&existing_idx) = self.subgraph_lookup.get(&id) {
            self.subgraphs[existing_idx].nodes.extend(filtered);
        } else {
            let sg = FlowSubgraph {
                id: id.clone(),
                nodes: filtered,
                title: title.trim().to_string(),
                classes: Vec::new(),
                dir,
                label_type: title_text.map_or(LabelType::Markdown, |t| t.label_type),
                metadata: None,
            };
            let idx = self.subgraphs.len();
            self.subgraphs.push(sg);
            self.subgraph_lookup.insert(id.clone(), idx);
        }
        id
    }

    pub fn destruct_link(&self, end: &str, start: Option<&str>) -> FlowLinkInfo {
        let (end_type, end_stroke, end_len) = destruct_end_link(end);
        let Some(start_str) = start else {
            return FlowLinkInfo {
                link_type: end_type,
                stroke: end_stroke,
                length: Some(end_len),
                text: None,
                id: None,
            };
        };
        let (mut start_type, start_stroke) = destruct_start_link(start_str);
        if start_stroke != end_stroke {
            return FlowLinkInfo {
                link_type: "INVALID".to_string(),
                stroke: "INVALID".to_string(),
                length: None,
                text: None,
                id: None,
            };
        }
        if start_type == "arrow_open" {
            start_type = end_type;
        } else {
            if start_type != end_type {
                return FlowLinkInfo {
                    link_type: "INVALID".to_string(),
                    stroke: "INVALID".to_string(),
                    length: None,
                    text: None,
                    id: None,
                };
            }
            start_type = format!("double_{start_type}");
        }
        if start_type == "double_arrow" {
            start_type = "double_arrow_point".to_string();
        }
        FlowLinkInfo {
            link_type: start_type,
            stroke: start_stroke,
            length: Some(end_len),
            text: None,
            id: None,
        }
    }
}
