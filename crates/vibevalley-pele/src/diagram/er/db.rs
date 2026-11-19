use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;

use crate::util::chars::is_space_char;

use super::types::{DocItem, ErAttribute, ErClassDef, ErEntity, ErLabelType, ErRelationship, ErSubgraph, ParsedAttribute, RelSpec};

#[derive(Debug, Clone)]
pub struct ErDb {
    pub direction: String,
    pub entities: IndexMap<String, ErEntity>,
    pub relationships: Vec<ErRelationship>,
    pub classes: IndexMap<String, ErClassDef>,
    pub subgraphs: Vec<ErSubgraph>,
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    subgraph_lookup: HashMap<String, usize>,
    claimed: HashSet<String>,
}

impl Default for ErDb {
    fn default() -> Self {
        Self::new()
    }
}

impl ErDb {
    pub fn new() -> Self {
        Self {
            direction: "TB".to_string(),
            entities: IndexMap::new(),
            relationships: Vec::new(),
            classes: IndexMap::new(),
            subgraphs: Vec::new(),
            title: None,
            acc_title: None,
            acc_descr: None,
            subgraph_lookup: HashMap::new(),
            claimed: HashSet::new(),
        }
    }

    pub fn add_entity(&mut self, name: &str, alias: &str) -> &mut ErEntity {
        if !self.entities.contains_key(name) {
            let id = format!("entity-{name}-{}", self.entities.len());
            self.entities.insert(
                name.to_string(),
                ErEntity {
                    id,
                    label: name.to_string(),
                    alias: alias.to_string(),
                    attributes: Vec::new(),
                    css_classes: "default".to_string(),
                    css_styles: Vec::new(),
                },
            );
        } else if let Some(entity) = self.entities.get_mut(name)
            && entity.alias.is_empty()
            && !alias.is_empty()
        {
            entity.alias = alias.to_string();
        }
        self.entities.get_mut(name).expect("entity just inserted")
    }

    /// The grammar builds the attribute list back to front, so the last attribute written comes first.
    pub fn add_attributes(&mut self, name: &str, attributes: Vec<ParsedAttribute>) {
        let entity = self.add_entity(name, "");
        for attr in attributes.into_iter().rev() {
            entity.attributes.push(ErAttribute {
                attr_type: attr.attr_type,
                name: attr.name,
                keys: attr.keys.unwrap_or_default(),
                comment: attr.comment.unwrap_or_default(),
            });
        }
    }

    pub fn add_relationship(&mut self, ent_a: &str, role_a: &str, ent_b: &str, rel_spec: RelSpec) {
        let entity_a = if self.subgraph_lookup.contains_key(ent_a) {
            ent_a.to_string()
        } else {
            self.add_entity(ent_a, "").id.clone()
        };
        let entity_b = if self.subgraph_lookup.contains_key(ent_b) {
            ent_b.to_string()
        } else {
            self.add_entity(ent_b, "").id.clone()
        };
        self.relationships.push(ErRelationship {
            entity_a,
            role_a: role_a.to_string(),
            entity_b,
            rel_spec,
        });
    }

    pub fn set_direction(&mut self, dir: &str) {
        self.direction = dir.to_string();
    }

    pub fn add_css_styles(&mut self, ids: &[String], styles: &[String]) {
        for id in ids {
            if let Some(entity) = self.entities.get_mut(id) {
                entity.css_styles.extend(styles.iter().cloned());
            }
            if let Some(&idx) = self.subgraph_lookup.get(id) {
                self.subgraphs[idx].css_styles.extend(styles.iter().cloned());
            }
        }
    }

    pub fn add_class(&mut self, ids: &[String], styles: &[String]) {
        for id in ids {
            let def = self.classes.entry(id.clone()).or_insert_with(|| ErClassDef {
                id: id.clone(),
                styles: Vec::new(),
                text_styles: Vec::new(),
            });
            for style in styles {
                if style.contains("color") {
                    def.text_styles.push(style.replacen("fill", "bgFill", 1));
                }
                def.styles.push(style.clone());
            }
        }
    }

    pub fn set_class(&mut self, ids: &[String], class_names: &[String]) {
        for id in ids {
            if let Some(entity) = self.entities.get_mut(id) {
                for name in class_names {
                    entity.css_classes.push(' ');
                    entity.css_classes.push_str(name);
                }
            }
            if let Some(&idx) = self.subgraph_lookup.get(id) {
                self.subgraphs[idx].classes.extend(class_names.iter().cloned());
            }
        }
    }

    pub fn add_subgraph(&mut self, id_text: &str, list: &[DocItem], title_text: &str, label_type: Option<&str>) -> String {
        let id = id_text.trim().to_string();
        let mut seen: HashSet<&str> = HashSet::new();
        let mut nodes: Vec<String> = Vec::new();
        let mut dir: Option<String> = None;
        for item in list {
            match item {
                DocItem::Dir(value) => dir = Some(value.clone()),
                DocItem::Name(raw) => {
                    let trimmed = raw.trim();
                    if trimmed.is_empty() || !seen.insert(trimmed) {
                        continue;
                    }
                    // A node belongs to the first subgraph that lists it.
                    if !self.claimed.contains(raw) {
                        nodes.push(raw.clone());
                    }
                }
            }
        }
        for node in &nodes {
            self.claimed.insert(node.clone());
        }
        let subgraph = ErSubgraph {
            id: id.clone(),
            nodes,
            title: title_text.trim().to_string(),
            classes: Vec::new(),
            css_styles: Vec::new(),
            dir,
            label_type: ErLabelType::from_opt(label_type),
        };
        let idx = self.subgraphs.len();
        self.subgraphs.push(subgraph);
        self.subgraph_lookup.insert(id.clone(), idx);
        id
    }

    pub fn set_acc_title(&mut self, text: &str) {
        self.acc_title = Some(text.trim_start_matches(is_space_char).to_string());
    }

    pub fn set_acc_description(&mut self, text: &str) {
        let mut out = String::with_capacity(text.len());
        let mut chars = text.chars().peekable();
        while let Some(c) = chars.next() {
            out.push(c);
            if c == '\n' {
                while let Some(&next) = chars.peek() {
                    if is_space_char(next) {
                        chars.next();
                    } else {
                        break;
                    }
                }
            }
        }
        self.acc_descr = Some(out);
    }
}
