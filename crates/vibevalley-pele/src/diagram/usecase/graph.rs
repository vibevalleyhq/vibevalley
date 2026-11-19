use indexmap::IndexMap;

use super::types::{ActorType, Animation, BoundaryType, JsonValue, LabelType, Relationship, RelationshipType, UseCaseShape, UsecaseJsonNode, UsecaseModel};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonRow {
    /// Blank on the second and later values of an array.
    pub key: String,
    /// The key again, for every row.
    pub accessible_key: String,
    pub value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsecaseNodeShape {
    UsecaseActor,
    UsecaseActorHollow,
    UsecaseActorAwesome,
    UsecaseActorIcon,
    UsecaseEllipse,
    UsecaseBusiness,
    Rect,
    Note,
    UsecaseJsonTable,
    UsecaseSystemBoundary,
}

impl UsecaseNodeShape {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UsecaseActor => "usecaseActor",
            Self::UsecaseActorHollow => "usecaseActorHollow",
            Self::UsecaseActorAwesome => "usecaseActorAwesome",
            Self::UsecaseActorIcon => "usecaseActorIcon",
            Self::UsecaseEllipse => "usecaseEllipse",
            Self::UsecaseBusiness => "usecaseBusiness",
            Self::Rect => "rect",
            Self::Note => "note",
            Self::UsecaseJsonTable => "usecaseJsonTable",
            Self::UsecaseSystemBoundary => "usecaseSystemBoundary",
        }
    }
}

#[derive(Debug, Clone)]
pub struct UsecaseGraphNode {
    pub id: String,
    pub label: String,
    pub label_type: LabelType,
    pub shape: UsecaseNodeShape,
    pub is_group: bool,
    pub padding: f64,
    pub css_classes: String,
    pub css_styles: Vec<String>,
    pub css_compiled_styles: Vec<String>,
    pub actor_type: Option<ActorType>,
    pub business: bool,
    pub icon: Option<String>,
    pub stereotype: Option<String>,
    pub parent_id: Option<String>,
    pub note_target: Option<String>,
    pub json_rows: Option<Vec<JsonRow>>,
    pub boundary_type: Option<BoundaryType>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsecaseEdgeKind {
    Association,
    Include,
    Extend,
    Generalization,
    Note,
}

impl UsecaseEdgeKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Association => "association",
            Self::Include => "include",
            Self::Extend => "extend",
            Self::Generalization => "generalization",
            Self::Note => "note",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgePattern {
    Solid,
    Dotted,
}

#[derive(Debug, Clone)]
pub struct UsecaseGraphEdge {
    pub id: String,
    pub start: String,
    pub end: String,
    pub relationship_type: UsecaseEdgeKind,
    pub pattern: EdgePattern,
    pub arrow_type_start: &'static str,
    pub arrow_type_end: &'static str,
    pub label: Option<String>,
    pub label_type: Option<LabelType>,
    pub classes: String,
    pub style: Vec<String>,
    pub css_compiled_styles: Vec<String>,
    pub animate: bool,
    pub animation: Option<Animation>,
    pub minlen: i32,
    pub explicit_id: bool,
    /// The dotted line from a note to what it is about.
    pub internal: bool,
}

#[derive(Debug, Clone)]
pub struct UsecaseGraph {
    pub nodes: Vec<UsecaseGraphNode>,
    pub edges: Vec<UsecaseGraphEdge>,
}

fn actor_shape(actor_type: ActorType) -> UsecaseNodeShape {
    match actor_type {
        ActorType::Normal => UsecaseNodeShape::UsecaseActor,
        ActorType::Hollow => UsecaseNodeShape::UsecaseActorHollow,
        ActorType::Awesome => UsecaseNodeShape::UsecaseActorAwesome,
        ActorType::Icon => UsecaseNodeShape::UsecaseActorIcon,
    }
}

fn format_scalar(value: &JsonValue) -> String {
    match value {
        JsonValue::String(s) => s.clone(),
        JsonValue::Null => "null".to_string(),
        JsonValue::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        JsonValue::Number(n) => {
            if *n == 0.0 {
                "0".to_string()
            } else {
                n.to_string()
            }
        }
        JsonValue::Array(_) => "[]".to_string(),
        JsonValue::Object(_) => "{}".to_string(),
    }
}

fn is_scalar(value: &JsonValue) -> bool {
    matches!(value, JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) | JsonValue::String(_))
}

fn escape_pointer(key: &str) -> String {
    if !key.contains('~') && !key.contains('/') {
        return key.to_string();
    }
    key.replace('~', "~0").replace('/', "~1")
}

/// One row for each leaf of a JSON object, depth first in the order the keys were written.
/// Uses an explicit stack so depth is limited by memory rather than the call stack.
pub fn flatten_json_rows(json: &UsecaseJsonNode) -> Vec<JsonRow> {
    enum Item<'a> {
        Root(&'a IndexMap<String, JsonValue>),
        Val(&'a JsonValue),
    }
    let mut rows: Vec<JsonRow> = Vec::new();
    let mut stack: Vec<(Item<'_>, String, String)> = vec![(Item::Root(&json.value), String::new(), String::new())];
    let mut children: Vec<(Item<'_>, String, String)> = Vec::new();
    while let Some((current, path, pointer)) = stack.pop() {
        children.clear();
        match current {
            Item::Root(obj) | Item::Val(JsonValue::Object(obj)) => {
                let ordered_keys: Vec<&str> = match json.property_order.get(&pointer) {
                    Some(keys) => keys.iter().map(String::as_str).collect(),
                    None => obj.keys().map(String::as_str).collect(),
                };
                if ordered_keys.is_empty() {
                    rows.push(JsonRow {
                        key: path.clone(),
                        accessible_key: path,
                        value: "{}".to_string(),
                    });
                } else {
                    for key in ordered_keys {
                        if let Some(val) = obj.get(key) {
                            let next_path = if path.is_empty() { key.to_string() } else { format!("{path}.{key}") };
                            let next_ptr = format!("{pointer}/{}", escape_pointer(key));
                            children.push((Item::Val(val), next_path, next_ptr));
                        }
                    }
                }
            }
            Item::Val(JsonValue::Array(arr)) => {
                if arr.is_empty() {
                    rows.push(JsonRow {
                        key: path.clone(),
                        accessible_key: path,
                        value: "[]".to_string(),
                    });
                } else if arr.iter().all(is_scalar) {
                    for (i, item) in arr.iter().enumerate() {
                        rows.push(JsonRow {
                            key: if i == 0 { path.clone() } else { String::new() },
                            accessible_key: path.clone(),
                            value: format_scalar(item),
                        });
                    }
                } else {
                    for (i, item) in arr.iter().enumerate() {
                        children.push((Item::Val(item), format!("{path}[{i}]"), format!("{pointer}/{i}")));
                    }
                }
            }
            Item::Val(scalar) => {
                rows.push(JsonRow {
                    key: path.clone(),
                    accessible_key: path,
                    value: format_scalar(scalar),
                });
            }
        }
        for child in children.drain(..).rev() {
            stack.push(child);
        }
    }
    rows
}

fn markers(rel: &Relationship) -> (&'static str, &'static str) {
    match rel.rel_type {
        RelationshipType::Generalization => ("none", "extension"),
        RelationshipType::Include | RelationshipType::Extend => ("none", "arrow_point"),
        RelationshipType::Association => rel.arrow_type.markers(),
    }
}

fn join_classes(parts: impl IntoIterator<Item = Option<String>>) -> String {
    let mut out = String::new();
    for part in parts.into_iter().flatten() {
        if part.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&part);
    }
    out
}

/// Resolves a parsed use case diagram into what is drawn: every actor, use case, note, JSON table
/// and boundary as a node with its class styles, and every relationship and note connector as an
/// edge with its markers.
pub fn build_usecase_graph(model: &UsecaseModel) -> UsecaseGraph {
    let mut nodes: Vec<UsecaseGraphNode> = Vec::new();
    let mut edges: Vec<UsecaseGraphEdge> = Vec::new();

    // A later class wins a property but keeps the place the property first took.
    let compiled = |class_names: &[String]| -> Vec<String> {
        let mut out: IndexMap<String, String> = IndexMap::new();
        for name in std::iter::once("default").chain(class_names.iter().map(String::as_str)) {
            let Some(def) = model.class_defs.get(name) else {
                continue;
            };
            for raw in &def.styles {
                let style = raw.trim();
                let property = match style.find(':') {
                    Some(colon) => style[..colon].trim(),
                    None => style,
                };
                if !property.is_empty() {
                    out.insert(property.to_string(), style.to_string());
                }
            }
        }
        out.into_values().collect()
    };

    for actor in model.actors.values() {
        let mut cls: Vec<Option<String>> = vec![
            Some("default".to_string()),
            Some("usecase-actor".to_string()),
            Some(format!("usecase-actor-{}", actor.actor_type.as_str())),
            actor.business.then(|| "usecase-business".to_string()),
        ];
        cls.extend(actor.classes.iter().cloned().map(Some));
        nodes.push(UsecaseGraphNode {
            id: actor.id.clone(),
            label: actor.label.clone(),
            label_type: actor.label_type,
            shape: actor_shape(actor.actor_type),
            is_group: false,
            padding: 10.0,
            css_classes: join_classes(cls),
            css_styles: actor.styles.clone(),
            css_compiled_styles: compiled(&actor.classes),
            actor_type: Some(actor.actor_type),
            business: actor.business,
            icon: actor.icon.clone(),
            stereotype: actor.stereotype.clone(),
            parent_id: actor.parent_id.clone(),
            note_target: None,
            json_rows: None,
            boundary_type: None,
        });
    }

    for uc in model.use_cases.values() {
        let ellipse = uc.shape == UseCaseShape::Ellipse;
        let shape = if !ellipse {
            UsecaseNodeShape::Rect
        } else if uc.business {
            UsecaseNodeShape::UsecaseBusiness
        } else {
            UsecaseNodeShape::UsecaseEllipse
        };
        let mut cls: Vec<Option<String>> = vec![
            Some("default".to_string()),
            Some("usecase-element".to_string()),
            Some(format!("usecase-{}", uc.shape.as_str())),
            uc.business.then(|| "usecase-business".to_string()),
        ];
        cls.extend(uc.classes.iter().cloned().map(Some));
        nodes.push(UsecaseGraphNode {
            id: uc.id.clone(),
            label: uc.label.clone(),
            label_type: uc.label_type,
            shape,
            is_group: false,
            padding: if ellipse { 20.0 } else { 10.0 },
            css_classes: join_classes(cls),
            css_styles: uc.styles.clone(),
            css_compiled_styles: compiled(&uc.classes),
            actor_type: None,
            business: uc.business,
            icon: None,
            stereotype: uc.stereotype.clone(),
            parent_id: uc.parent_id.clone(),
            note_target: None,
            json_rows: None,
            boundary_type: None,
        });
    }

    for note in model.notes.values() {
        nodes.push(UsecaseGraphNode {
            id: note.id.clone(),
            label: note.label.clone(),
            label_type: note.label_type,
            shape: UsecaseNodeShape::Note,
            is_group: false,
            padding: 10.0,
            css_classes: "default usecase-note".to_string(),
            css_styles: Vec::new(),
            css_compiled_styles: compiled(&[]),
            actor_type: None,
            business: false,
            icon: None,
            stereotype: None,
            parent_id: None,
            note_target: Some(note.target.clone()),
            json_rows: None,
            boundary_type: None,
        });
    }

    for json in model.json_nodes.values() {
        let mut cls: Vec<Option<String>> = vec![Some("default".to_string()), Some("usecase-json-table".to_string())];
        cls.extend(json.classes.iter().cloned().map(Some));
        nodes.push(UsecaseGraphNode {
            id: json.id.clone(),
            label: json.id.clone(),
            label_type: LabelType::Text,
            shape: UsecaseNodeShape::UsecaseJsonTable,
            is_group: false,
            padding: 10.0,
            css_classes: join_classes(cls),
            css_styles: json.styles.clone(),
            css_compiled_styles: compiled(&json.classes),
            actor_type: None,
            business: false,
            icon: None,
            stereotype: None,
            parent_id: None,
            note_target: None,
            json_rows: Some(flatten_json_rows(json)),
            boundary_type: None,
        });
    }

    for boundary in model.system_boundaries.values() {
        let mut cls: Vec<Option<String>> = vec![
            Some("default".to_string()),
            Some("system-boundary".to_string()),
            Some(format!("system-boundary-{}", boundary.boundary_type.as_str())),
        ];
        cls.extend(boundary.classes.iter().cloned().map(Some));
        nodes.push(UsecaseGraphNode {
            id: boundary.id.clone(),
            label: boundary.label.clone(),
            label_type: boundary.label_type,
            shape: UsecaseNodeShape::UsecaseSystemBoundary,
            is_group: true,
            padding: 20.0,
            css_classes: join_classes(cls),
            css_styles: boundary.styles.clone(),
            css_compiled_styles: compiled(&boundary.classes),
            actor_type: None,
            business: false,
            icon: None,
            stereotype: None,
            parent_id: None,
            note_target: None,
            json_rows: None,
            boundary_type: Some(boundary.boundary_type),
        });
    }

    for rel in &model.relationships {
        let semantic = matches!(rel.rel_type, RelationshipType::Include | RelationshipType::Extend);
        let (arrow_type_start, arrow_type_end) = markers(rel);
        let animated = rel.animate || rel.animation.is_some();
        let mut cls: Vec<Option<String>> = vec![
            Some("default".to_string()),
            Some("relationship".to_string()),
            Some(format!("relationship-{}", rel.rel_type.as_str())),
        ];
        cls.extend(rel.classes.iter().cloned().map(Some));
        if animated {
            cls.push(Some(format!("edge-animation-{}", rel.animation.map_or("fast", Animation::as_str))));
        }
        let (label, label_type) = if semantic {
            (Some(rel.rel_type.as_str().to_string()), Some(LabelType::Text))
        } else if rel.rel_type == RelationshipType::Association {
            (rel.label.as_deref().filter(|s| !s.is_empty()).map(str::to_string), rel.label_type)
        } else {
            (None, None)
        };
        let relationship_type = match rel.rel_type {
            RelationshipType::Association => UsecaseEdgeKind::Association,
            RelationshipType::Include => UsecaseEdgeKind::Include,
            RelationshipType::Extend => UsecaseEdgeKind::Extend,
            RelationshipType::Generalization => UsecaseEdgeKind::Generalization,
        };
        edges.push(UsecaseGraphEdge {
            id: rel.id.clone(),
            start: rel.source.clone(),
            end: rel.target.clone(),
            relationship_type,
            pattern: if semantic { EdgePattern::Dotted } else { EdgePattern::Solid },
            arrow_type_start,
            arrow_type_end,
            label,
            label_type,
            classes: join_classes(cls),
            style: rel.styles.clone(),
            css_compiled_styles: compiled(&rel.classes),
            animate: rel.animate,
            animation: rel.animation,
            minlen: rel.minlen,
            explicit_id: rel.explicit_id,
            internal: false,
        });
    }

    for note in model.notes.values() {
        edges.push(UsecaseGraphEdge {
            id: format!("{}-edge", note.id),
            start: note.id.clone(),
            end: note.target.clone(),
            relationship_type: UsecaseEdgeKind::Note,
            pattern: EdgePattern::Dotted,
            arrow_type_start: "none",
            arrow_type_end: "none",
            label: None,
            label_type: None,
            classes: "default relationship relationship-note".to_string(),
            style: Vec::new(),
            css_compiled_styles: compiled(&[]),
            animate: false,
            animation: None,
            minlen: 1,
            explicit_id: false,
            internal: true,
        });
    }

    UsecaseGraph { nodes, edges }
}
