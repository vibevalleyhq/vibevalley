use indexmap::IndexMap;

use crate::error::PeleError;
use crate::util::chars::is_space_char;

use super::graph::{StateGraph, build_state_graph};
use super::lexer::trim_js;
use super::parser::StateBuilder;
use super::types::{DirectionStmt, StateClassDef, StateDescription, StateLink, StateNote, StateRelation, StateStmt, StateType, Stmt, clone_doc};

#[derive(Debug, Clone, Default)]
pub struct StateDb {
    pub root_doc: Vec<Stmt>,
    pub states: IndexMap<String, StateStmt>,
    pub relations: Vec<StateRelation>,
    pub classes: IndexMap<String, StateClassDef>,
    pub links: IndexMap<String, StateLink>,
    pub graph: StateGraph,
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    divider_count: usize,
}

fn split_dividers(doc: &mut Vec<Stmt>, divider_count: &mut usize) {
    let has_divider = doc.iter().any(|item| {
        matches!(
            item,
            Stmt::State(s) if s.state_type == Some(StateType::Divider) && s.doc.is_none()
        )
    });
    if !has_divider {
        return;
    }
    let mut regions: Vec<Stmt> = Vec::new();
    let mut current: Vec<Stmt> = Vec::new();
    for item in std::mem::take(doc) {
        match item {
            Stmt::State(mut s) if s.state_type == Some(StateType::Divider) && s.doc.is_none() => {
                s.doc = Some(std::mem::take(&mut current));
                regions.push(Stmt::State(s));
            }
            other => current.push(other),
        }
    }
    if !regions.is_empty() {
        if !current.is_empty() {
            *divider_count += 1;
            let mut trailing = StateStmt::new(format!("divider-id-{}", *divider_count), Some(StateType::Divider));
            trailing.doc = Some(current);
            regions.push(Stmt::State(Box::new(trailing)));
        }
        *doc = regions;
    }
}

fn collapse_newline_indent(text: &str) -> String {
    if !text.contains('\n') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        out.push(ch);
        if ch == '\n' {
            while chars.peek().is_some_and(|&c| is_space_char(c)) {
                chars.next();
            }
        }
    }
    out
}

impl StateDb {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn clear(&mut self) {
        *self = Self::new();
    }

    /// The direction the root document is laid out in: its last `direction` statement.
    pub fn direction(&self) -> &str {
        let mut dir = "TB";
        for item in &self.root_doc {
            if let Stmt::Direction(d) = item {
                dir = d.value.as_str();
            }
        }
        dir
    }

    /// First `direction` statement in `root_doc`, or `"TB"`.
    pub fn get_direction(&self) -> &str {
        for item in &self.root_doc {
            if let Stmt::Direction(d) = item {
                return d.value.as_str();
            }
        }
        "TB"
    }

    pub fn extract(&mut self, statements: &[Stmt]) -> Result<(), PeleError> {
        self.states.clear();
        self.relations.clear();
        self.classes.clear();
        for item in statements {
            match item {
                Stmt::Raw(_) | Stmt::Direction(_) => {}
                Stmt::State(s) => {
                    self.add_state(trim_js(&s.id), s.state_type, s.doc.as_deref(), s.description.as_ref(), s.note.as_ref(), None);
                }
                Stmt::Relation(r) => {
                    self.add_relation(&r.state1, &r.state2, r.description.as_deref().unwrap_or(""));
                }
                Stmt::ClassDef(c) => {
                    self.add_style_class(trim_js(&c.id), &c.classes);
                }
                Stmt::Style(st) => {
                    let styles: Vec<String> = st.style_class.split(',').map(|s| trim_js(&s.replace(';', "")).to_string()).collect();
                    for key in self.named_keys(trim_js(&st.id)) {
                        if let Some(state) = self.states.get_mut(&key) {
                            state.styles = styles.clone();
                        }
                    }
                }
                Stmt::ApplyClass(ac) => {
                    self.set_css_class(trim_js(&ac.id), &ac.style_class);
                }
                Stmt::Click(cl) => {
                    self.add_link(cl.id.id(), &cl.url, &cl.tooltip);
                }
            }
        }
        self.graph = build_state_graph(statements, &self.states, &self.classes)?;
        Ok(())
    }

    /// Mermaid's `docTranslator`: gives each `[*]` an id scoped to its parent, and turns a
    /// document split by `--` into one region per part.
    pub fn translate(&mut self) {
        enum TranslateItem<'a> {
            Stmt(&'a mut Stmt),
            State(&'a mut StateStmt),
        }

        split_dividers(&mut self.root_doc, &mut self.divider_count);
        let mut pending: Vec<(String, TranslateItem<'_>, bool)> = Vec::with_capacity(self.root_doc.len());
        for child in self.root_doc.iter_mut().rev() {
            pending.push(("root".to_string(), TranslateItem::Stmt(child), true));
        }

        while let Some((parent_id, item, first)) = pending.pop() {
            let s = match item {
                TranslateItem::Stmt(stmt) => match stmt {
                    Stmt::Relation(rel) => {
                        pending.push((parent_id.clone(), TranslateItem::State(&mut rel.state2), false));
                        pending.push((parent_id, TranslateItem::State(&mut rel.state1), true));
                        continue;
                    }
                    Stmt::State(s) => s,
                    Stmt::Raw(_) | Stmt::ClassDef(_) | Stmt::Style(_) | Stmt::ApplyClass(_) | Stmt::Direction(_) | Stmt::Click(_) => continue,
                },
                TranslateItem::State(s) => s,
            };
            if s.id == "[*]" {
                s.id = format!("{parent_id}{}", if first { "_start" } else { "_end" });
                s.start = Some(first);
            } else {
                s.id = trim_js(&s.id).to_string();
            }
            if let Some(doc) = &mut s.doc {
                split_dividers(doc, &mut self.divider_count);
                let next_parent = s.id.clone();
                for child in doc.iter_mut().rev() {
                    pending.push((next_parent.clone(), TranslateItem::Stmt(child), true));
                }
            }
        }
    }

    pub fn add_state(
        &mut self,
        id: &str,
        state_type: Option<StateType>,
        doc: Option<&[Stmt]>,
        descr: Option<&StateDescription>,
        note: Option<&StateNote>,
        classes: Option<&[String]>,
    ) {
        let trimmed_id = trim_js(id).to_string();
        let effective_type = state_type.unwrap_or(StateType::Default);
        if let Some(existing) = self.states.get_mut(&trimmed_id) {
            if existing.doc.is_none()
                && let Some(d) = doc
            {
                existing.doc = Some(clone_doc(d));
            }
            if existing.state_type.is_none() {
                existing.state_type = Some(effective_type);
            }
            if let Some(n) = note {
                existing.note = Some(n.clone());
            }
        } else {
            let mut state = StateStmt::new(trimmed_id.clone(), Some(effective_type));
            if let Some(d) = doc {
                state.doc = Some(clone_doc(d));
            }
            if let Some(n) = note {
                state.note = Some(n.clone());
            }
            self.states.insert(trimmed_id.clone(), state);
        }

        if let Some(d) = descr
            && d.is_truthy()
        {
            match d {
                StateDescription::Single(text) => self.add_description(&trimmed_id, trim_js(text)),
                StateDescription::Multi(list) => {
                    for text in list {
                        self.add_description(&trimmed_id, trim_js(text));
                    }
                }
            }
        }
        if let Some(cls) = classes {
            for name in cls {
                self.set_css_class(&trimmed_id, trim_js(name));
            }
        }
    }

    pub fn get_state(&self, id: &str) -> Option<&StateStmt> {
        self.states.get(id)
    }

    pub fn add_link(&mut self, state_id: &str, url: &str, tooltip: &str) {
        self.links.insert(
            state_id.to_string(),
            StateLink {
                url: url.to_string(),
                tooltip: tooltip.to_string(),
            },
        );
    }

    pub fn add_relation(&mut self, item1: &StateStmt, item2: &StateStmt, title: &str) {
        for item in [item1, item2] {
            let classes = if item.classes.is_empty() { None } else { Some(item.classes.as_slice()) };
            self.add_state(
                &item.id,
                item.state_type,
                item.doc.as_deref(),
                item.description.as_ref(),
                item.note.as_ref(),
                classes,
            );
        }
        self.relations.push(StateRelation {
            id1: trim_js(&item1.id).to_string(),
            id2: trim_js(&item2.id).to_string(),
            relation_title: title.to_string(),
        });
    }

    pub fn add_description(&mut self, id: &str, descr: &str) {
        if let Some(state) = self.states.get_mut(id) {
            let text = match descr.strip_prefix(':') {
                Some(rest) => trim_js(rest).to_string(),
                None => descr.to_string(),
            };
            state.descriptions.push(text);
        }
    }

    pub fn add_style_class(&mut self, id: &str, style_attributes: &str) {
        let found = self.classes.entry(id.to_string()).or_insert_with(|| StateClassDef {
            id: id.to_string(),
            styles: Vec::new(),
            text_styles: Vec::new(),
        });
        if style_attributes.is_empty() {
            return;
        }
        for attrib in style_attributes.split(',') {
            let fixed = trim_js(&attrib.replacen(';', "", 1)).to_string();
            if attrib.contains("color") {
                found.text_styles.push(fixed.replacen("fill", "bgFill", 1).replacen("color", "fill", 1));
            }
            found.styles.push(fixed);
        }
    }

    pub fn set_css_class(&mut self, item_ids: &str, css_class_name: &str) {
        for key in self.named_keys(item_ids) {
            if let Some(state) = self.states.get_mut(&key) {
                state.classes.push(css_class_name.to_string());
            }
        }
    }

    fn named_keys(&mut self, ids: &str) -> Vec<String> {
        let mut out = Vec::new();
        for id in ids.split(',') {
            if self.states.contains_key(id) {
                out.push(id.to_string());
            } else {
                self.add_state(id, None, None, None, None, None);
                let trimmed = trim_js(id);
                if self.states.contains_key(trimmed) {
                    out.push(trimmed.to_string());
                }
            }
        }
        out
    }
}

impl StateBuilder for StateDb {
    fn set_root_doc(&mut self, doc: Vec<Stmt>) -> Result<(), PeleError> {
        self.root_doc = doc;
        self.translate();
        let root_copy = std::mem::take(&mut self.root_doc);
        let res = self.extract(&root_copy);
        self.root_doc = root_copy;
        res
    }

    fn trim_colon(&self, text: &str) -> String {
        match text.strip_prefix(':') {
            Some(rest) => trim_js(rest).to_string(),
            None => trim_js(text).to_string(),
        }
    }

    fn get_divider_id(&mut self) -> String {
        self.divider_count += 1;
        format!("divider-id-{}", self.divider_count)
    }

    fn set_direction(&mut self, dir: &str) {
        for item in &mut self.root_doc {
            if let Stmt::Direction(d) = item {
                d.value = dir.to_string();
                return;
            }
        }
        self.root_doc.insert(0, Stmt::Direction(DirectionStmt { value: dir.to_string() }));
    }

    fn set_acc_title(&mut self, text: &str) {
        self.acc_title = Some(text.trim_start_matches(is_space_char).to_string());
    }

    fn set_acc_description(&mut self, text: &str) {
        self.acc_descr = Some(collapse_newline_indent(text));
    }
}
