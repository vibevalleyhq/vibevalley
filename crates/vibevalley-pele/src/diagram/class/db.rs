use std::collections::HashMap;

use indexmap::{IndexMap, IndexSet};

use crate::text::entities::decode_entities;
use crate::util::chars::{is_digit, is_space_char};
use crate::util::url::sanitize_url;

use super::members::{ClassMember, MemberType};
use super::types::{ClassInterface, ClassNode, ClassNote, ClassRelation, NamespaceNode, RelationEnd, RelationType, StyleClass};

/// Mermaid looks up ids that start with a digit under this prefix, so they never match a class.
const DOM_ID_PREFIX: &str = "classId-";

fn split_name(id: &str) -> (&str, &str) {
    match id.find('~') {
        Some(at) if at > 0 => {
            let rest = &id[at + 1..];
            let generic = match rest.find('~') {
                Some(end) => &rest[..end],
                None => rest,
            };
            (&id[..at], generic)
        }
        _ => (id, ""),
    }
}

fn lookup_id(id: &str) -> String {
    if id.as_bytes().first().is_some_and(|&b| is_digit(b as u32)) {
        let prefixed = format!("{DOM_ID_PREFIX}{id}");
        split_name(&prefixed).0.to_string()
    } else {
        split_name(id).0.to_string()
    }
}

fn trim_js(s: &str) -> &str {
    s.trim_matches(is_space_char)
}

#[derive(Debug, Clone)]
pub struct ClassDb {
    pub direction: String,
    pub classes: IndexMap<String, ClassNode>,
    pub relations: Vec<ClassRelation>,
    pub notes: IndexMap<String, ClassNote>,
    pub namespaces: IndexMap<String, NamespaceNode>,
    pub interfaces: Vec<ClassInterface>,
    pub style_classes: IndexMap<String, StyleClass>,
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    namespace_stack: Vec<String>,
    with_css_class: HashMap<String, IndexSet<String>>,
}

impl Default for ClassDb {
    fn default() -> Self {
        Self::new()
    }
}

impl ClassDb {
    pub fn new() -> Self {
        Self {
            direction: "TB".to_string(),
            classes: IndexMap::new(),
            relations: Vec::new(),
            notes: IndexMap::new(),
            namespaces: IndexMap::new(),
            interfaces: Vec::new(),
            style_classes: IndexMap::new(),
            title: None,
            acc_title: None,
            acc_descr: None,
            namespace_stack: Vec::new(),
            with_css_class: HashMap::new(),
        }
    }

    pub fn add_class(&mut self, id: &str) {
        let (class_name, generic_type) = split_name(id);
        if self.classes.contains_key(class_name) {
            return;
        }
        let class_name = class_name.to_string();
        let node = ClassNode {
            id: class_name.clone(),
            generic_type: generic_type.to_string(),
            label: class_name.clone(),
            css_classes: "default".to_string(),
            methods: Vec::new(),
            members: Vec::new(),
            annotations: Vec::new(),
            styles: Vec::new(),
            parent: None,
            link: None,
            link_target: None,
            have_callback: false,
            tooltip: None,
        };
        self.classes.insert(class_name.clone(), node);
        self.tag(&class_name, "default");
    }

    fn tag(&mut self, class_name: &str, css_class: &str) {
        self.with_css_class.entry(css_class.to_string()).or_default().insert(class_name.to_string());
    }

    fn ensure_mut(&mut self, id: &str) -> &mut ClassNode {
        self.add_class(id);
        let class_name = split_name(id).0;
        self.classes.get_mut(class_name).expect("class just added")
    }

    pub fn set_class_label(&mut self, id: &str, label: &str) {
        self.ensure_mut(id).label = label.to_string();
    }

    pub fn add_relation(&mut self, mut relation: ClassRelation) {
        let type1 = relation.relation.type1;
        let type2 = relation.relation.type2;
        if type1 == RelationEnd::Type(RelationType::Lollipop) && type2 == RelationEnd::None {
            self.add_class(&relation.id2);
            relation.id1 = self.add_interface(&relation.id1, &relation.id2);
        } else if type2 == RelationEnd::Type(RelationType::Lollipop) && type1 == RelationEnd::None {
            self.add_class(&relation.id1);
            relation.id2 = self.add_interface(&relation.id2, &relation.id1);
        } else {
            self.add_class(&relation.id1);
            self.add_class(&relation.id2);
        }
        relation.id1 = split_name(&relation.id1).0.to_string();
        relation.id2 = split_name(&relation.id2).0.to_string();
        relation.relation_title1 = trim_js(&relation.relation_title1).to_string();
        relation.relation_title2 = trim_js(&relation.relation_title2).to_string();
        self.relations.push(relation);
    }

    fn add_interface(&mut self, label: &str, class_id: &str) -> String {
        let id = format!("interface{}", self.interfaces.len());
        self.interfaces.push(ClassInterface {
            id: id.clone(),
            label: label.to_string(),
            class_id: class_id.to_string(),
        });
        id
    }

    pub fn add_annotation(&mut self, class_name: &str, annotation: &str) {
        self.ensure_mut(class_name).annotations.push(annotation.to_string());
    }

    pub fn add_member(&mut self, class_name: &str, member: &str) {
        let node = self.ensure_mut(class_name);
        let text = trim_js(member);
        if text.starts_with("<<") && text.ends_with(">>") && text.len() >= 4 {
            node.annotations.push(text[2..text.len() - 2].to_string());
        } else if text.find(')').is_some_and(|idx| idx > 0) {
            let parsed = ClassMember::parse(text, MemberType::Method);
            match parsed.member_type {
                MemberType::Method => node.methods.push(parsed),
                MemberType::Attribute => node.members.push(parsed),
            }
        } else if !text.is_empty() {
            node.members.push(ClassMember::parse(text, MemberType::Attribute));
        }
    }

    pub fn add_members(&mut self, class_name: &str, mut members: Vec<String>) {
        members.reverse();
        for member in members {
            self.add_member(class_name, &member);
        }
    }

    pub fn add_note(&mut self, text: &str, class_name: Option<&str>) -> String {
        let index = self.notes.len();
        let id = format!("note{index}");
        self.notes.insert(
            id.clone(),
            ClassNote {
                id: id.clone(),
                class: class_name.map(str::to_string),
                text: text.to_string(),
                index,
                parent: None,
            },
        );
        id
    }

    pub fn cleanup_label(&self, label: &str) -> String {
        let stripped = label.strip_prefix(':').unwrap_or(label);
        trim_js(stripped).to_string()
    }

    pub fn set_css_class(&mut self, ids: &str, class_name: &str) {
        for id in ids.split(',') {
            let key = lookup_id(id);
            let Some(node) = self.classes.get_mut(&key) else {
                continue;
            };
            node.css_classes.push(' ');
            node.css_classes.push_str(class_name);
            for word in class_name.split(' ') {
                self.tag(&key, word);
            }
        }
    }

    pub fn define_class(&mut self, ids: &[String], style: &[String]) {
        for id in ids {
            let style_class = self.style_classes.entry(id.clone()).or_insert_with(|| StyleClass {
                id: id.clone(),
                styles: Vec::new(),
                text_styles: Vec::new(),
            });
            for s in style {
                if s.contains("color") {
                    style_class.text_styles.push(s.replacen("fill", "bgFill", 1));
                }
                style_class.styles.push(s.clone());
            }
            let Some(tagged) = self.with_css_class.get(id).cloned() else {
                continue;
            };
            let parts: Vec<&str> = style.iter().flat_map(|s| s.split(',')).collect();
            for class_id in tagged {
                if let Some(node) = self.classes.get_mut(&class_id) {
                    for &part in &parts {
                        node.styles.push(part.to_string());
                    }
                }
            }
        }
    }

    pub fn set_tooltip(&mut self, ids: &str, tooltip: Option<&str>) {
        let Some(tooltip) = tooltip else {
            return;
        };
        for id in ids.split(',') {
            let class_name = split_name(id).0;
            if let Some(node) = self.classes.get_mut(class_name) {
                node.tooltip = Some(tooltip.to_string());
            }
        }
    }

    pub fn set_link(&mut self, ids: &str, link: &str, target: Option<&str>) {
        // Entity codes are resolved first so what is checked matches what a browser would follow.
        let decoded = decode_entities(link);
        let url = trim_js(&decoded);
        for id in ids.split(',') {
            let key = lookup_id(id);
            if let Some(node) = self.classes.get_mut(&key) {
                node.link = if url.is_empty() { None } else { Some(sanitize_url(url)) };
                node.link_target = Some(target.unwrap_or("_blank").to_string());
            }
        }
        self.set_css_class(ids, "clickable");
    }

    /// Callbacks are never executed; the class is only marked clickable.
    pub fn set_click_event(&mut self, ids: &str, _function_name: Option<&str>, _function_args: Option<&str>) {
        for id in ids.split(',') {
            let class_name = split_name(id).0;
            if let Some(node) = self.classes.get_mut(class_name) {
                node.have_callback = true;
            }
        }
        self.set_css_class(ids, "clickable");
    }

    pub fn set_direction(&mut self, dir: &str) {
        self.direction = dir.to_string();
    }

    pub fn set_acc_title(&mut self, text: &str) {
        self.acc_title = Some(text.trim_start_matches(is_space_char).to_string());
    }

    pub fn set_acc_description(&mut self, text: &str) {
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
        self.acc_descr = Some(out);
    }

    pub fn add_namespace(&mut self, id: &str, label: Option<&str>) -> String {
        let prefix = self.namespace_stack.last().cloned();
        let qualified = match &prefix {
            Some(p) => format!("{p}.{id}"),
            None => id.to_string(),
        };
        self.namespace_stack.push(qualified.clone());

        if let Some(existing) = self.namespaces.get_mut(&qualified) {
            existing.explicit = true;
            if let Some(lbl) = label
                && !lbl.is_empty()
            {
                existing.label = lbl.to_string();
            }
            return qualified;
        }

        let mut parent_id = prefix.clone().filter(|p| !p.is_empty());
        let mut from = prefix.as_ref().map_or(0, |p| p.len() + 1);
        loop {
            let dot = qualified[from..].find('.').map(|rel| from + rel);
            let leaf = dot.is_none();
            let end = dot.unwrap_or(qualified.len());
            let current = qualified[..end].to_string();

            if let Some(node) = self.namespaces.get_mut(&current) {
                if leaf {
                    node.explicit = true;
                }
            } else {
                let part = &qualified[from..end];
                let lbl = if leaf { label.filter(|l| !l.is_empty()).unwrap_or(part) } else { part };
                self.namespaces.insert(
                    current.clone(),
                    NamespaceNode {
                        id: current.clone(),
                        label: lbl.to_string(),
                        classes: IndexSet::new(),
                        notes: IndexSet::new(),
                        children: IndexSet::new(),
                        parent: parent_id.clone(),
                        explicit: leaf,
                    },
                );
            }

            if let Some(ref pid) = parent_id {
                if let Some(parent) = self.namespaces.get_mut(pid) {
                    parent.children.insert(current.clone());
                }
                if let Some(node) = self.namespaces.get_mut(&current)
                    && node.parent.is_none()
                {
                    node.parent = Some(pid.clone());
                }
            }

            if leaf {
                return qualified;
            }
            parent_id = Some(current);
            from = end + 1;
        }
    }

    pub fn pop_namespace(&mut self) {
        self.namespace_stack.pop();
    }

    pub fn add_classes_to_namespace(&mut self, id: &str, class_names: &[String], note_names: &[String]) {
        if !self.namespaces.contains_key(id) {
            return;
        }
        let mut added_classes = Vec::new();
        for name in class_names {
            let class_name = split_name(name).0;
            if let Some(node) = self.classes.get_mut(class_name) {
                node.parent = Some(id.to_string());
                added_classes.push(class_name.to_string());
            }
        }
        let mut added_notes = Vec::new();
        for name in note_names {
            if let Some(note) = self.notes.get_mut(name) {
                note.parent = Some(id.to_string());
                added_notes.push(name.clone());
            }
        }
        if let Some(ns) = self.namespaces.get_mut(id) {
            for c in added_classes {
                ns.classes.insert(c);
            }
            for n in added_notes {
                ns.notes.insert(n);
            }
        }
    }

    pub fn set_css_style(&mut self, id: &str, styles: &[String]) {
        let Some(node) = self.classes.get_mut(id) else {
            return;
        };
        for s in styles {
            for part in s.split(',') {
                node.styles.push(part.to_string());
            }
        }
    }
}
