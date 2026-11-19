use std::collections::{HashMap, HashSet};

use crate::detect::DiagramType;
use crate::diagram::timeline::scan::collapse_newline_ws;
use crate::error::{ErrorCode, PeleError};
use crate::util::chars::is_space_char;

use super::types::{C4Attr, C4Boundary, C4Element, C4ElementRef, C4Named, C4Rel, C4RelKind, C4Shape};

/// Parses leading base-10 integer matching JavaScript `parseInt(s, 10)`.
pub fn js_parse_int(raw: &str) -> Option<f64> {
    let s = raw.trim_start_matches(is_space_char);
    let bytes = s.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    let mut i = 0;
    let neg = if bytes[0] == b'-' {
        i = 1;
        true
    } else if bytes[0] == b'+' {
        i = 1;
        false
    } else {
        false
    };
    let start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == start {
        return None;
    }
    let val: f64 = s[start..i].parse().ok()?;
    Some(if neg { -val } else { val })
}

fn set_element_field(el: &mut C4Element, field: &str, value: String) {
    match field {
        "label" => el.label = value,
        "type" => el.elem_type = Some(value),
        "descr" => el.descr = Some(value),
        "techn" => el.techn = Some(value),
        "sprite" => el.sprite = Some(value),
        "tags" => el.tags = Some(value),
        "link" => el.link = Some(value),
        "bgColor" => el.bg_color = Some(value),
        "fontColor" => el.font_color = Some(value),
        "borderColor" => el.border_color = Some(value),
        "shadowing" => el.shadowing = Some(value),
        "shape" => el.shape = Some(value),
        "legendText" => el.legend_text = Some(value),
        "legendSprite" => el.legend_sprite = Some(value),
        other => {
            el.extra.insert(other.to_string(), value);
        }
    }
}

fn apply_el_named(el: &mut C4Element, attr: &C4Named) {
    set_element_field(el, &attr.key, attr.value.clone());
}

fn put_el(el: &mut C4Element, field: &str, attr: Option<&C4Attr>) {
    let Some(attr) = attr else { return };
    match attr {
        C4Attr::Positional(v) => set_element_field(el, field, v.clone()),
        C4Attr::Named(n) => apply_el_named(el, n),
    }
}

fn text_el(el: &mut C4Element, field: &str, attr: Option<&C4Attr>) {
    match attr {
        None => match field {
            "descr" if el.descr.is_none() => el.descr = Some(String::new()),
            "techn" if el.techn.is_none() => el.techn = Some(String::new()),
            _ => {}
        },
        Some(_) => put_el(el, field, attr),
    }
}

fn label_el(el: &mut C4Element, attr: Option<&C4Attr>) {
    el.label_attr = None;
    match attr {
        Some(C4Attr::Named(n)) => {
            el.label.clear();
            el.label_attr = Some(n.clone());
            apply_el_named(el, n);
        }
        Some(C4Attr::Positional(s)) => {
            el.label = s.clone();
        }
        None => {
            el.label.clear();
        }
    }
}

fn set_rel_field(rel: &mut C4Rel, field: &str, value: String) {
    match field {
        "label" => rel.label = value,
        "descr" => rel.descr = Some(value),
        "techn" => rel.techn = Some(value),
        "sprite" => rel.sprite = Some(value),
        "tags" => rel.tags = Some(value),
        "link" => rel.link = Some(value),
        "textColor" => rel.text_color = Some(value),
        "lineColor" => rel.line_color = Some(value),
        "offsetX" => rel.offset_x = js_parse_int(&value),
        "offsetY" => rel.offset_y = js_parse_int(&value),
        other => {
            rel.extra.insert(other.to_string(), value);
        }
    }
}

fn apply_rel_named(rel: &mut C4Rel, attr: &C4Named) {
    set_rel_field(rel, &attr.key, attr.value.clone());
}

fn put_rel(rel: &mut C4Rel, field: &str, attr: Option<&C4Attr>) {
    let Some(attr) = attr else { return };
    match attr {
        C4Attr::Positional(v) => set_rel_field(rel, field, v.clone()),
        C4Attr::Named(n) => apply_rel_named(rel, n),
    }
}

fn text_rel(rel: &mut C4Rel, field: &str, attr: Option<&C4Attr>) {
    match attr {
        None => match field {
            "descr" if rel.descr.is_none() => rel.descr = Some(String::new()),
            "techn" if rel.techn.is_none() => rel.techn = Some(String::new()),
            _ => {}
        },
        Some(_) => put_rel(rel, field, attr),
    }
}

fn label_rel(rel: &mut C4Rel, attr: Option<&C4Attr>) {
    rel.label_attr = None;
    match attr {
        Some(C4Attr::Named(n)) => {
            rel.label.clear();
            rel.label_attr = Some(n.clone());
            apply_rel_named(rel, n);
        }
        Some(C4Attr::Positional(s)) => {
            rel.label = s.clone();
        }
        None => {
            rel.label.clear();
        }
    }
}

#[derive(Debug, Clone)]
pub struct C4Db {
    pub c4_type: Option<String>,
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub shapes: Vec<C4Shape>,
    /// `boundaries[0]` is always the unnamed top-level `"global"` boundary.
    pub boundaries: Vec<C4Boundary>,
    pub rels: Vec<C4Rel>,
    pub shape_in_row: usize,
    pub boundary_in_row: usize,
    shape_index: HashMap<String, usize>,
    boundary_index: HashMap<String, usize>,
    rel_index: HashMap<(String, String), usize>,
    current: usize,
    stack: Vec<usize>,
}

impl Default for C4Db {
    fn default() -> Self {
        Self::new()
    }
}

impl C4Db {
    pub fn new() -> Self {
        let root = C4Boundary {
            node_type: None,
            el: C4Element {
                alias: "global".to_string(),
                label: "global".to_string(),
                elem_type: Some("global".to_string()),
                parent: None,
                ..C4Element::default()
            },
        };
        Self {
            c4_type: None,
            title: None,
            acc_title: None,
            acc_descr: None,
            shapes: Vec::new(),
            boundaries: vec![root],
            rels: Vec::new(),
            shape_in_row: 4,
            boundary_in_row: 2,
            shape_index: HashMap::new(),
            boundary_index: HashMap::new(),
            rel_index: HashMap::new(),
            current: 0,
            stack: Vec::new(),
        }
    }

    pub fn set_c4_type(&mut self, c4_type: &str) {
        self.c4_type = Some(c4_type.to_string());
    }

    pub fn set_title(&mut self, title: &str) {
        self.title = Some(title.to_string());
    }

    pub fn set_acc_description(&mut self, descr: &str) {
        self.acc_descr = Some(collapse_newline_ws(descr));
    }

    fn ensure_shape(&mut self, alias: &C4Attr, title: Option<&C4Attr>) -> usize {
        let idx = match alias {
            C4Attr::Positional(a) => {
                if let Some(&existing) = self.shape_index.get(a) {
                    existing
                } else {
                    let idx = self.shapes.len();
                    self.shapes.push(C4Shape {
                        kind: String::new(),
                        el: C4Element {
                            alias: a.clone(),
                            ..C4Element::default()
                        },
                    });
                    self.shape_index.insert(a.clone(), idx);
                    idx
                }
            }
            C4Attr::Named(n) => {
                let idx = self.shapes.len();
                let mut el = C4Element {
                    alias_attr: Some(n.clone()),
                    ..C4Element::default()
                };
                apply_el_named(&mut el, n);
                self.shapes.push(C4Shape { kind: String::new(), el });
                idx
            }
        };
        label_el(&mut self.shapes[idx].el, title);
        idx
    }

    fn ensure_boundary(&mut self, alias: &C4Attr, title: Option<&C4Attr>, fallback: &str, type_attr: Option<&C4Attr>) -> usize {
        let idx = match alias {
            C4Attr::Positional(a) => {
                if let Some(&existing) = self.boundary_index.get(a) {
                    existing
                } else {
                    let idx = self.boundaries.len();
                    self.boundaries.push(C4Boundary {
                        node_type: None,
                        el: C4Element {
                            alias: a.clone(),
                            ..C4Element::default()
                        },
                    });
                    self.boundary_index.insert(a.clone(), idx);
                    idx
                }
            }
            C4Attr::Named(n) => {
                let idx = self.boundaries.len();
                let mut el = C4Element {
                    alias_attr: Some(n.clone()),
                    ..C4Element::default()
                };
                apply_el_named(&mut el, n);
                self.boundaries.push(C4Boundary { node_type: None, el });
                idx
            }
        };
        label_el(&mut self.boundaries[idx].el, title);
        match type_attr {
            None => self.boundaries[idx].el.elem_type = Some(fallback.to_string()),
            Some(_) => put_el(&mut self.boundaries[idx].el, "type", type_attr),
        }
        idx
    }

    fn finish_shape(&mut self, idx: usize, kind: &str, attrs: &[C4Attr], at: usize) {
        let shape = &mut self.shapes[idx];
        put_el(&mut shape.el, "sprite", attrs.get(at));
        put_el(&mut shape.el, "tags", attrs.get(at + 1));
        put_el(&mut shape.el, "link", attrs.get(at + 2));
        shape.kind = kind.to_string();
        shape.el.parent = Some(self.current);
    }

    pub fn add_person_or_system(&mut self, kind: &str, attrs: &[C4Attr]) {
        let Some(alias) = attrs.first() else { return };
        let idx = self.ensure_shape(alias, attrs.get(1));
        text_el(&mut self.shapes[idx].el, "descr", attrs.get(2));
        self.finish_shape(idx, kind, attrs, 3);
    }

    pub fn add_container(&mut self, kind: &str, attrs: &[C4Attr]) {
        let Some(alias) = attrs.first() else { return };
        let idx = self.ensure_shape(alias, attrs.get(1));
        text_el(&mut self.shapes[idx].el, "techn", attrs.get(2));
        text_el(&mut self.shapes[idx].el, "descr", attrs.get(3));
        self.finish_shape(idx, kind, attrs, 4);
    }

    pub fn add_component(&mut self, kind: &str, attrs: &[C4Attr]) {
        self.add_container(kind, attrs);
    }

    fn open_boundary(&mut self, idx: usize) {
        self.boundaries[idx].el.parent = Some(self.current);
        self.stack.push(self.current);
        self.current = idx;
    }

    pub fn add_person_or_system_boundary(&mut self, attrs: &[C4Attr], fallback: &str) {
        let Some(alias) = attrs.first() else { return };
        let idx = self.ensure_boundary(alias, attrs.get(1), fallback, attrs.get(2));
        put_el(&mut self.boundaries[idx].el, "tags", attrs.get(3));
        put_el(&mut self.boundaries[idx].el, "link", attrs.get(4));
        self.open_boundary(idx);
    }

    pub fn add_container_boundary(&mut self, attrs: &[C4Attr]) {
        self.add_person_or_system_boundary(attrs, "container");
    }

    pub fn add_deployment_node(&mut self, node_type: &str, attrs: &[C4Attr]) {
        let Some(alias) = attrs.first() else { return };
        let idx = self.ensure_boundary(alias, attrs.get(1), "node", attrs.get(2));
        text_el(&mut self.boundaries[idx].el, "descr", attrs.get(3));
        put_el(&mut self.boundaries[idx].el, "sprite", attrs.get(4));
        put_el(&mut self.boundaries[idx].el, "tags", attrs.get(5));
        put_el(&mut self.boundaries[idx].el, "link", attrs.get(6));
        self.boundaries[idx].node_type = Some(node_type.to_string());
        self.open_boundary(idx);
    }

    pub fn pop_boundary_parse_stack(&mut self) {
        self.current = self.stack.pop().unwrap_or(0);
    }

    pub fn add_rel(&mut self, rel_type: C4RelKind, attrs: &[C4Attr]) {
        let (Some(from), Some(to), Some(lbl)) = (attrs.first(), attrs.get(1), attrs.get(2)) else {
            return;
        };
        let idx = match (from, to) {
            (C4Attr::Positional(f), C4Attr::Positional(t)) => {
                if let Some(&existing) = self.rel_index.get(&(f.clone(), t.clone())) {
                    existing
                } else {
                    let idx = self.rels.len();
                    self.rels.push(C4Rel {
                        rel_type,
                        from: f.clone(),
                        to: t.clone(),
                        label: String::new(),
                        from_attr: None,
                        to_attr: None,
                        label_attr: None,
                        techn: None,
                        descr: None,
                        sprite: None,
                        tags: None,
                        link: None,
                        text_color: None,
                        line_color: None,
                        offset_x: None,
                        offset_y: None,
                        extra: Default::default(),
                    });
                    self.rel_index.insert((f.clone(), t.clone()), idx);
                    idx
                }
            }
            (C4Attr::Positional(_), C4Attr::Named(_)) | (C4Attr::Named(_), C4Attr::Positional(_)) | (C4Attr::Named(_), C4Attr::Named(_)) => {
                let idx = self.rels.len();
                let (from_s, from_attr) = match from {
                    C4Attr::Positional(s) => (s.clone(), None),
                    C4Attr::Named(n) => (String::new(), Some(n.clone())),
                };
                let (to_s, to_attr) = match to {
                    C4Attr::Positional(s) => (s.clone(), None),
                    C4Attr::Named(n) => (String::new(), Some(n.clone())),
                };
                self.rels.push(C4Rel {
                    rel_type,
                    from: from_s,
                    to: to_s,
                    label: String::new(),
                    from_attr,
                    to_attr,
                    label_attr: None,
                    techn: None,
                    descr: None,
                    sprite: None,
                    tags: None,
                    link: None,
                    text_color: None,
                    line_color: None,
                    offset_x: None,
                    offset_y: None,
                    extra: Default::default(),
                });
                idx
            }
        };
        let rel = &mut self.rels[idx];
        rel.rel_type = rel_type;
        label_rel(rel, Some(lbl));
        text_rel(rel, "techn", attrs.get(3));
        text_rel(rel, "descr", attrs.get(4));
        put_rel(rel, "sprite", attrs.get(5));
        put_rel(rel, "tags", attrs.get(6));
        put_rel(rel, "link", attrs.get(7));
    }

    pub fn get_c4_shape(&self, alias: &str) -> Option<C4ElementRef> {
        if let Some(&idx) = self.shape_index.get(alias) {
            Some(C4ElementRef::Shape(idx))
        } else {
            self.boundary_index.get(alias).copied().map(C4ElementRef::Boundary)
        }
    }

    pub fn update_el_style(&mut self, attrs: &[C4Attr]) {
        let Some(C4Attr::Positional(alias)) = attrs.first() else { return };
        let Some(target) = self.get_c4_shape(alias) else { return };
        let el = match target {
            C4ElementRef::Shape(i) => &mut self.shapes[i].el,
            C4ElementRef::Boundary(i) => &mut self.boundaries[i].el,
        };
        put_el(el, "bgColor", attrs.get(1));
        put_el(el, "fontColor", attrs.get(2));
        put_el(el, "borderColor", attrs.get(3));
        put_el(el, "shadowing", attrs.get(4));
        put_el(el, "shape", attrs.get(5));
        put_el(el, "sprite", attrs.get(6));
        put_el(el, "techn", attrs.get(7));
        put_el(el, "legendText", attrs.get(8));
        put_el(el, "legendSprite", attrs.get(9));
    }

    pub fn update_rel_style(&mut self, attrs: &[C4Attr]) {
        let (Some(C4Attr::Positional(from)), Some(C4Attr::Positional(to))) = (attrs.first(), attrs.get(1)) else {
            return;
        };
        let Some(&idx) = self.rel_index.get(&(from.clone(), to.clone())) else {
            return;
        };
        let rel = &mut self.rels[idx];
        put_rel(rel, "textColor", attrs.get(2));
        put_rel(rel, "lineColor", attrs.get(3));
        match attrs.get(4) {
            Some(C4Attr::Positional(x)) => rel.offset_x = js_parse_int(x),
            Some(C4Attr::Named(n)) => apply_rel_named(rel, n),
            None => {}
        }
        match attrs.get(5) {
            Some(C4Attr::Positional(y)) => rel.offset_y = js_parse_int(y),
            Some(C4Attr::Named(n)) => apply_rel_named(rel, n),
            None => {}
        }
    }

    pub fn update_layout_config(&mut self, attrs: &[C4Attr]) {
        let count = |attr: Option<&C4Attr>| -> Option<usize> {
            let s = match attr? {
                C4Attr::Positional(v) => v.as_str(),
                C4Attr::Named(n) => n.value.as_str(),
            };
            let n = js_parse_int(s)?;
            if n >= 1.0 && n.is_finite() {
                Some((n as u64).min(1_000_000) as usize)
            } else {
                None
            }
        };
        if let Some(shapes) = count(attrs.first()) {
            self.shape_in_row = shapes;
        }
        if let Some(boundaries) = count(attrs.get(1)) {
            self.boundary_in_row = boundaries;
        }
    }

    /// Validates that every relation references a reachable shape or non-root boundary.
    pub fn validate_rels(&self) -> Result<(), PeleError> {
        let mut kids: Vec<Vec<usize>> = vec![Vec::new(); self.boundaries.len()];
        for (i, b) in self.boundaries.iter().enumerate() {
            if let Some(p) = b.el.parent
                && p < kids.len()
            {
                kids[p].push(i);
            }
        }
        let mut reachable_boundaries: HashSet<usize> = HashSet::new();
        let mut queue: Vec<usize> = vec![0];
        reachable_boundaries.insert(0);
        let mut head = 0usize;
        while head < queue.len() {
            let cur = queue[head];
            head += 1;
            for &kid in &kids[cur] {
                if reachable_boundaries.insert(kid) {
                    queue.push(kid);
                }
            }
        }
        let is_reachable = |r: C4ElementRef| -> bool {
            match r {
                C4ElementRef::Shape(i) => self.shapes[i].el.parent.is_some_and(|p| reachable_boundaries.contains(&p)),
                C4ElementRef::Boundary(i) => i != 0 && reachable_boundaries.contains(&i),
            }
        };
        for rel in &self.rels {
            let from = if rel.from_attr.is_some() { None } else { self.get_c4_shape(&rel.from) };
            let to = if rel.to_attr.is_some() { None } else { self.get_c4_shape(&rel.to) };
            if !from.is_some_and(is_reachable) || !to.is_some_and(is_reachable) {
                return Err(PeleError::new(
                    format!(r#"C4 rel "{}" -> "{}" references an unknown shape or boundary"#, rel.from, rel.to),
                    ErrorCode::Semantic,
                )
                .with_diagram_type(DiagramType::C4));
            }
        }
        Ok(())
    }
}
