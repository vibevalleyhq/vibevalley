use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;

use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError, SourceLocation, SourceMap};
use crate::util::chars::is_space_char;

use super::lexer::{line_column, location_text};
use super::types::{
    Actor, ActorType, Animation, Arrow, BoundaryType, ClassDef, Direction, EdgeOccurrence, GraphStatement, JsonValue, LabelType, MetadataOccurrence,
    Relationship, RelationshipType, Span, StatementKind, SymbolKind, SystemBoundary, UseCase, UseCaseShape, UsecaseJsonNode, UsecaseModel, UsecaseNote,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftLabel {
    pub text: String,
    pub label_type: LabelType,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PropertyValue {
    Str(String),
    Bool(bool),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftProperty {
    pub key: String,
    pub value: PropertyValue,
    pub span: Span,
    pub key_span: Span,
    pub value_span: Span,
}

impl DraftProperty {
    pub fn to_occurrence(&self) -> MetadataOccurrence {
        MetadataOccurrence {
            key: self.key.clone(),
            span: self.span,
            key_span: self.key_span,
            value_span: self.value_span,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElementKind {
    Actor,
    Usecase,
}

impl ElementKind {
    const fn symbol_kind(self) -> SymbolKind {
        match self {
            Self::Actor => SymbolKind::Actor,
            Self::Usecase => SymbolKind::Usecase,
        }
    }
}

#[derive(Debug, Clone)]
pub struct DraftElement {
    pub id: String,
    pub kind: ElementKind,
    pub label: DraftLabel,
    pub span: Span,
    pub generated: bool,
    pub parent: Option<(String, Span)>,
    pub shape: Option<UseCaseShape>,
    pub metadata: Option<Vec<DraftProperty>>,
    pub stereotype: Option<String>,
    pub classes: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct DraftBoundary {
    pub id: String,
    pub label: DraftLabel,
    pub span: Span,
    pub generated: bool,
    pub classes: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct DraftJson {
    pub id: String,
    pub value: IndexMap<String, JsonValue>,
    pub property_order: IndexMap<String, Vec<String>>,
    pub span: Span,
    pub classes: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct DraftEndpoint {
    pub id: String,
    pub label: DraftLabel,
    pub span: Span,
    pub generated: bool,
    pub declares: bool,
    pub classed: bool,
}

#[derive(Debug, Clone)]
pub struct DraftRelationship {
    pub source: DraftEndpoint,
    pub target: DraftEndpoint,
    pub span: Span,
    pub id: Option<String>,
    pub id_span: Option<Span>,
    pub rel_type: RelationshipType,
    pub arrow_type: Arrow,
    pub label: Option<DraftLabel>,
    pub minlen: i32,
}

#[derive(Debug, Clone)]
pub struct DraftNote {
    pub target: String,
    pub span: Span,
    pub label: DraftLabel,
}

#[derive(Debug, Clone)]
pub struct DraftMetadata {
    pub target: String,
    pub span: Span,
    pub properties: Vec<DraftProperty>,
    /// Index into top-level `statements` if this came from a standalone `id@{...}` statement.
    pub stmt_index: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct DraftClassAssign {
    pub targets: Vec<(String, Span)>,
    pub classes: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct DraftStyleAssign {
    pub target: String,
    pub span: Span,
    pub styles: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct DraftClassDef {
    pub ids: Vec<String>,
    pub styles: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Drafts {
    pub elements: Vec<DraftElement>,
    pub boundaries: Vec<DraftBoundary>,
    pub jsons: Vec<DraftJson>,
    pub relationships: Vec<DraftRelationship>,
    pub notes: Vec<DraftNote>,
    pub metadata: Vec<DraftMetadata>,
    pub classes: Vec<DraftClassAssign>,
    pub styles: Vec<DraftStyleAssign>,
    pub class_defs: Vec<DraftClassDef>,
    pub direction: Option<Direction>,
    pub acc_title: String,
    pub acc_description: String,
}

#[derive(Debug, Clone)]
struct Origin {
    kind: SymbolKind,
    span: Span,
    generated: bool,
    label: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NonIconActorType {
    Normal,
    Hollow,
    Awesome,
}

impl NonIconActorType {
    const fn to_actor_type(self) -> ActorType {
        match self {
            Self::Normal => ActorType::Normal,
            Self::Hollow => ActorType::Hollow,
            Self::Awesome => ActorType::Awesome,
        }
    }

    const fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Hollow => "hollow",
            Self::Awesome => "awesome",
        }
    }
}

#[derive(Debug, Clone)]
struct ElementState {
    kind: ElementKind,
    id: String,
    label: DraftLabel,
    span: Span,
    parent: Option<(String, Span)>,
    shape: Option<UseCaseShape>,
    stereotype: Option<String>,
    stereotype_span: Option<Span>,
    classes: Vec<String>,
    actor_type: Option<NonIconActorType>,
    icon: Option<String>,
    business: Option<bool>,
}

#[derive(Debug, Clone)]
struct BoundaryState {
    id: String,
    label: DraftLabel,
    span: Span,
    classes: Vec<String>,
    boundary_type: Option<BoundaryType>,
    members: Vec<String>,
}

fn push_unique(target: &mut Vec<String>, values: &[String]) {
    if values.is_empty() {
        return;
    }
    let mut seen: HashSet<String> = target.iter().cloned().collect();
    for v in values {
        if seen.insert(v.clone()) {
            target.push(v.clone());
        }
    }
}

fn infer_kind(properties: &[DraftProperty]) -> Option<&'static str> {
    let mut actor = true;
    let mut usecase = true;
    let mut boundary = true;
    let mut edge = true;
    for prop in properties {
        match prop.key.as_str() {
            "icon" => {
                actor = true;
                usecase = false;
                boundary = false;
                edge = false;
            }
            "animate" | "animation" => {
                actor = false;
                usecase = false;
                boundary = false;
                edge = true;
            }
            "type" => {
                actor = false;
                usecase = false;
                boundary = false;
                edge = false;
                if let PropertyValue::Str(ref s) = prop.value {
                    if matches!(s.as_str(), "rect" | "package") {
                        boundary = true;
                    } else if matches!(s.as_str(), "normal" | "hollow" | "awesome") {
                        actor = true;
                    }
                }
            }
            "business" => {
                boundary = false;
                edge = false;
            }
            _ => return None,
        }
    }
    let count = usize::from(actor) + usize::from(usecase) + usize::from(boundary) + usize::from(edge);
    if count != 1 {
        return None;
    }
    if actor {
        Some("actor")
    } else if usecase {
        Some("usecase")
    } else if boundary {
        Some("boundary")
    } else {
        Some("edge")
    }
}

fn normalize_acc_descr(text: &str) -> String {
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

/// Resolves what the parser read into a model, once the whole diagram is read: which ids are
/// actors, use cases, boundaries, JSON nodes or edges, in what order they appear, and whether the
/// statements about them agree. Ports Mermaid's UsecaseModelBuilder, with its messages.
pub fn resolve_usecase(
    src: &str,
    mut drafts: Drafts,
    header_span: Span,
    mut statements: Vec<GraphStatement>,
    title: Option<String>,
    origin: Option<&SourceMap<'_>>,
) -> Result<UsecaseModel, PeleError> {
    let mut model = UsecaseModel::empty();
    let mut symbols: HashMap<String, Origin> = HashMap::new();
    let mut elements: IndexMap<String, ElementState> = IndexMap::new();
    let mut boundaries: IndexMap<String, BoundaryState> = IndexMap::new();
    let mut edge_index: HashMap<String, usize> = HashMap::new();
    let mut first: HashMap<String, usize> = HashMap::new();

    let at = |span: Span| -> String { location_text(src, span.0, span.1, origin) };

    let make_error = |message: String, span: Span| -> PeleError {
        let (line, column) = line_column(src, span.0, origin);
        PeleError::new(message, ErrorCode::Semantic)
            .with_diagram_type(DiagramType::Usecase)
            .with_location(SourceLocation {
                line,
                column,
                snippet: String::new(),
            })
    };

    let fail = |message: String, span: Span| -> PeleError { make_error(format!("{message} at {}", at(span)), span) };

    let conflict = |message: &str, current: Span, previous: Span, current_label: Option<&str>, previous_label: Option<&str>| -> PeleError {
        let cur_suf = current_label.map_or_else(String::new, |l| format!(" (label \"{l}\")"));
        let prev_suf = previous_label.map_or_else(String::new, |l| format!(" (label \"{l}\")"));
        make_error(
            format!("{message} at {}{cur_suf}; previous declaration at {}{prev_suf}", at(current), at(previous)),
            current,
        )
    };

    let invalid = |id: &str, kind: &str, prop: &DraftProperty| -> PeleError {
        fail(format!("Metadata property '{}' is invalid for {kind} '{id}'", prop.key), prop.key_span)
    };

    let mut mention = |id: &str, offset: usize| {
        first
            .entry(id.to_string())
            .and_modify(|prev| {
                if offset < *prev {
                    *prev = offset;
                }
            })
            .or_insert(offset);
    };

    let claim = |symbols: &HashMap<String, Origin>, id: &str, span: Span, generated: bool, label_text: &str, kind: SymbolKind| -> Result<(), PeleError> {
        let Some(orig) = symbols.get(id) else {
            return Ok(());
        };
        let cur_label = generated.then_some(label_text);
        let orig_label = if orig.generated { orig.label.as_deref() } else { None };
        if orig.kind != kind {
            return Err(conflict(
                &format!("ID '{id}' is declared as both {} and {}", orig.kind.as_str(), kind.as_str()),
                span,
                orig.span,
                cur_label,
                orig_label,
            ));
        }
        if orig.generated || generated {
            return Err(conflict(
                &format!("Generated ID '{id}' collides with another declaration"),
                span,
                orig.span,
                cur_label,
                orig_label,
            ));
        }
        Ok(())
    };

    let unique = |symbols: &mut HashMap<String, Origin>, id: &str, kind: SymbolKind, span: Span| -> Result<(), PeleError> {
        if let Some(prev) = symbols.get(id) {
            return Err(conflict(
                &format!("ID '{id}' is declared more than once ({} and {})", prev.kind.as_str(), kind.as_str()),
                span,
                prev.span,
                None,
                if prev.generated { prev.label.as_deref() } else { None },
            ));
        }
        symbols.insert(
            id.to_string(),
            Origin {
                kind,
                span,
                generated: false,
                label: None,
            },
        );
        Ok(())
    };

    let apply_actor_property = |state: &mut ElementState, prop: &DraftProperty, replace: bool| -> Result<(), PeleError> {
        match (prop.key.as_str(), &prop.value) {
            ("type", PropertyValue::Str(s)) if matches!(s.as_str(), "normal" | "hollow" | "awesome") => {
                let parsed = match s.as_str() {
                    "normal" => NonIconActorType::Normal,
                    "hollow" => NonIconActorType::Hollow,
                    _ => NonIconActorType::Awesome,
                };
                if !replace
                    && let Some(prev) = state.actor_type
                    && prev != parsed
                {
                    return Err(conflict(
                        &format!("Actor '{}' has conflicting type metadata", state.id),
                        prop.key_span,
                        state.span,
                        None,
                        None,
                    ));
                }
                state.actor_type = Some(parsed);
            }
            ("icon", PropertyValue::Str(s)) => {
                if !replace
                    && let Some(ref prev) = state.icon
                    && prev != s
                {
                    return Err(conflict(
                        &format!("Actor '{}' has conflicting icon metadata", state.id),
                        prop.key_span,
                        state.span,
                        None,
                        None,
                    ));
                }
                state.icon = Some(s.clone());
            }
            ("business", PropertyValue::Bool(b)) => {
                if !replace
                    && let Some(prev) = state.business
                    && prev != *b
                {
                    return Err(conflict(
                        &format!("Actor '{}' has conflicting business metadata", state.id),
                        prop.key_span,
                        state.span,
                        None,
                        None,
                    ));
                }
                state.business = Some(*b);
            }
            _ => return Err(invalid(&state.id, "actor", prop)),
        }
        Ok(())
    };

    let apply_element_metadata = |state: &mut ElementState, props: &[DraftProperty], replace: bool| -> Result<(), PeleError> {
        for prop in props {
            match state.kind {
                ElementKind::Actor => apply_actor_property(state, prop, replace)?,
                ElementKind::Usecase => match (prop.key.as_str(), &prop.value) {
                    ("business", PropertyValue::Bool(b)) => {
                        if !replace
                            && let Some(prev) = state.business
                            && prev != *b
                        {
                            return Err(conflict(
                                &format!("Use case '{}' has conflicting business metadata", state.id),
                                prop.key_span,
                                state.span,
                                None,
                                None,
                            ));
                        }
                        state.business = Some(*b);
                    }
                    _ => return Err(invalid(&state.id, "usecase", prop)),
                },
            }
        }
        Ok(())
    };

    let publish = |model: &mut UsecaseModel, state: &ElementState| {
        let parent_id = state.parent.as_ref().and_then(|(pid, _)| (!pid.is_empty()).then(|| pid.clone()));
        match state.kind {
            ElementKind::Actor => {
                model.use_cases.shift_remove(&state.id);
                let styles = model.actors.get(&state.id).map(|a| a.styles.clone()).unwrap_or_default();
                let has_icon = state.icon.as_deref().is_some_and(|s| !s.is_empty());
                let actor_type = if has_icon {
                    ActorType::Icon
                } else {
                    state.actor_type.map_or(ActorType::Normal, NonIconActorType::to_actor_type)
                };
                let actor = Actor {
                    id: state.id.clone(),
                    label: state.label.text.clone(),
                    label_type: state.label.label_type,
                    actor_type,
                    icon: has_icon.then(|| state.icon.clone().unwrap()),
                    business: state.business.unwrap_or(false),
                    stereotype: state.stereotype.as_deref().filter(|s| !s.is_empty()).map(str::to_string),
                    parent_id,
                    classes: state.classes.clone(),
                    styles,
                };
                model.actors.insert(state.id.clone(), actor);
            }
            ElementKind::Usecase => {
                model.actors.shift_remove(&state.id);
                let styles = model.use_cases.get(&state.id).map(|u| u.styles.clone()).unwrap_or_default();
                let uc = UseCase {
                    id: state.id.clone(),
                    label: state.label.text.clone(),
                    label_type: state.label.label_type,
                    shape: state.shape.unwrap_or(UseCaseShape::Ellipse),
                    business: state.business.unwrap_or(false),
                    stereotype: state.stereotype.as_deref().filter(|s| !s.is_empty()).map(str::to_string),
                    parent_id,
                    classes: state.classes.clone(),
                    styles,
                };
                model.use_cases.insert(state.id.clone(), uc);
            }
        }
    };

    enum DeclRef {
        Element(usize),
        Boundary(usize),
        Json(usize),
        EdgeId(usize),
    }

    let mut decls: Vec<(usize, DeclRef)> = Vec::new();
    for rel in &drafts.relationships {
        mention(&rel.source.id, rel.source.span.0);
        mention(&rel.target.id, rel.target.span.0);
    }
    for (idx, d) in drafts.elements.iter().enumerate() {
        mention(&d.id, d.span.0);
        decls.push((d.span.0, DeclRef::Element(idx)));
    }
    for (idx, d) in drafts.boundaries.iter().enumerate() {
        mention(&d.id, d.span.0);
        decls.push((d.span.0, DeclRef::Boundary(idx)));
    }
    for (idx, d) in drafts.jsons.iter().enumerate() {
        mention(&d.id, d.span.0);
        decls.push((d.span.0, DeclRef::Json(idx)));
    }
    for (idx, rel) in drafts.relationships.iter().enumerate() {
        if rel.id.is_some()
            && let Some(id_span) = rel.id_span
        {
            decls.push((id_span.0, DeclRef::EdgeId(idx)));
        }
    }
    decls.sort_by_key(|&(offset, _)| offset);

    for (_, decl) in decls {
        match decl {
            DeclRef::Element(idx) => {
                let d = &drafts.elements[idx];
                claim(&symbols, &d.id, d.span, d.generated, &d.label.text, d.kind.symbol_kind())?;
                let non_empty_parent = d.parent.as_ref().filter(|(pid, _)| !pid.is_empty());
                if let Some(existing) = elements.get_mut(&d.id) {
                    if existing.label.text != d.label.text || existing.label.label_type != d.label.label_type {
                        return Err(conflict(&format!("ID '{}' has conflicting labels", d.id), d.span, existing.span, None, None));
                    }
                    if let (Some(ds), Some(es)) = (d.shape, existing.shape)
                        && ds != es
                    {
                        return Err(conflict(
                            &format!("Use case '{}' has conflicting shapes", d.id),
                            d.span,
                            existing.span,
                            None,
                            None,
                        ));
                    }
                    if let (Some((pid, pspan)), Some((epid, epspan))) = (non_empty_parent, existing.parent.as_ref().filter(|(id, _)| !id.is_empty()))
                        && pid != epid
                    {
                        return Err(conflict(
                            &format!("Element '{}' belongs to more than one system boundary", d.id),
                            *pspan,
                            *epspan,
                            None,
                            None,
                        ));
                    }
                    if let (Some(ds), Some(es)) = (&d.stereotype, &existing.stereotype)
                        && ds != es
                    {
                        return Err(conflict(
                            &format!("Element '{}' has conflicting stereotypes", d.id),
                            d.span,
                            existing.stereotype_span.unwrap_or(existing.span),
                            None,
                            None,
                        ));
                    }
                    if existing.shape.is_none() {
                        existing.shape = d.shape;
                    }
                    if existing.parent.is_none() {
                        existing.parent = d.parent.clone();
                    }
                    if existing.stereotype.is_none() {
                        existing.stereotype = d.stereotype.clone();
                    }
                    if existing.stereotype_span.is_none() && d.stereotype.is_some() {
                        existing.stereotype_span = Some(d.span);
                    }
                    push_unique(&mut existing.classes, &d.classes);
                    if let Some(ref meta) = d.metadata {
                        apply_element_metadata(existing, meta, false)?;
                    }
                } else {
                    let mut state = ElementState {
                        kind: d.kind,
                        id: d.id.clone(),
                        label: d.label.clone(),
                        span: d.span,
                        parent: non_empty_parent.cloned(),
                        shape: d.shape,
                        stereotype: d.stereotype.clone(),
                        stereotype_span: d.stereotype.as_ref().map(|_| d.span),
                        classes: d.classes.clone(),
                        actor_type: None,
                        icon: None,
                        business: None,
                    };
                    if let Some(ref meta) = d.metadata {
                        apply_element_metadata(&mut state, meta, false)?;
                    }
                    elements.insert(d.id.clone(), state);
                    symbols.insert(
                        d.id.clone(),
                        Origin {
                            kind: d.kind.symbol_kind(),
                            span: d.span,
                            generated: d.generated,
                            label: Some(d.label.text.clone()),
                        },
                    );
                }
            }
            DeclRef::Boundary(idx) => {
                let d = &drafts.boundaries[idx];
                claim(&symbols, &d.id, d.span, d.generated, &d.label.text, SymbolKind::Boundary)?;
                if let Some(existing) = boundaries.get_mut(&d.id) {
                    if existing.label.text != d.label.text || existing.label.label_type != d.label.label_type {
                        return Err(conflict(
                            &format!("Boundary '{}' has conflicting titles", d.id),
                            d.span,
                            existing.span,
                            None,
                            None,
                        ));
                    }
                    push_unique(&mut existing.classes, &d.classes);
                } else {
                    boundaries.insert(
                        d.id.clone(),
                        BoundaryState {
                            id: d.id.clone(),
                            label: d.label.clone(),
                            span: d.span,
                            classes: d.classes.clone(),
                            boundary_type: None,
                            members: Vec::new(),
                        },
                    );
                    symbols.insert(
                        d.id.clone(),
                        Origin {
                            kind: SymbolKind::Boundary,
                            span: d.span,
                            generated: d.generated,
                            label: Some(d.label.text.clone()),
                        },
                    );
                }
            }
            DeclRef::Json(idx) => {
                let d = &drafts.jsons[idx];
                unique(&mut symbols, &d.id, SymbolKind::Json, d.span)?;
            }
            DeclRef::EdgeId(idx) => {
                let rel = &drafts.relationships[idx];
                if let (Some(id), Some(id_span)) = (&rel.id, rel.id_span) {
                    unique(&mut symbols, id, SymbolKind::Edge, id_span)?;
                }
            }
        }
    }

    let mut elem_ids: Vec<String> = elements.keys().cloned().collect();
    elem_ids.sort_by_key(|id| first.get(id).copied().unwrap_or(0));
    for id in &elem_ids {
        publish(&mut model, &elements[id]);
    }

    let mut bound_ids: Vec<String> = boundaries.keys().cloned().collect();
    bound_ids.sort_by_key(|id| first.get(id).copied().unwrap_or(0));
    for id in &bound_ids {
        let state = &boundaries[id];
        model.system_boundaries.insert(
            state.id.clone(),
            SystemBoundary {
                id: state.id.clone(),
                label: state.label.text.clone(),
                label_type: state.label.label_type,
                boundary_type: BoundaryType::Rect,
                members: Vec::new(),
                classes: Vec::new(),
                styles: Vec::new(),
            },
        );
    }

    let mut json_order: Vec<usize> = (0..drafts.jsons.len()).collect();
    json_order.sort_by_key(|&idx| first.get(&drafts.jsons[idx].id).copied().unwrap_or(0));
    for idx in json_order {
        let d = &mut drafts.jsons[idx];
        model.json_nodes.insert(
            d.id.clone(),
            UsecaseJsonNode {
                id: d.id.clone(),
                value: std::mem::take(&mut d.value),
                property_order: std::mem::take(&mut d.property_order),
                classes: std::mem::take(&mut d.classes),
                styles: Vec::new(),
            },
        );
    }

    let mut anonymous = 0usize;
    for d in &drafts.relationships {
        let resolve_endpoint = |end: &DraftEndpoint,
                                symbols: &mut HashMap<String, Origin>,
                                elements: &mut IndexMap<String, ElementState>,
                                first: &mut HashMap<String, usize>|
         -> Result<SymbolKind, PeleError> {
            if end.classed && !end.declares {
                return Err(fail(
                    format!("Relationship endpoint '{}' uses ::: without declaring the node", end.id),
                    end.span,
                ));
            }
            if let Some(orig) = symbols.get(&end.id) {
                return Ok(orig.kind);
            }
            elements.insert(
                end.id.clone(),
                ElementState {
                    kind: ElementKind::Usecase,
                    id: end.id.clone(),
                    label: end.label.clone(),
                    span: end.span,
                    parent: None,
                    shape: Some(UseCaseShape::Ellipse),
                    stereotype: None,
                    stereotype_span: None,
                    classes: Vec::new(),
                    actor_type: None,
                    icon: None,
                    business: None,
                },
            );
            symbols.insert(
                end.id.clone(),
                Origin {
                    kind: SymbolKind::Usecase,
                    span: end.span,
                    generated: end.generated,
                    label: Some(end.label.text.clone()),
                },
            );
            first
                .entry(end.id.clone())
                .and_modify(|prev| {
                    if end.span.0 < *prev {
                        *prev = end.span.0;
                    }
                })
                .or_insert(end.span.0);
            Ok(SymbolKind::Usecase)
        };

        let source_kind = resolve_endpoint(&d.source, &mut symbols, &mut elements, &mut first)?;
        let target_kind = resolve_endpoint(&d.target, &mut symbols, &mut elements, &mut first)?;
        let is_related = |k: SymbolKind| matches!(k, SymbolKind::Actor | SymbolKind::Usecase | SymbolKind::Json);
        if !is_related(source_kind) {
            return Err(conflict(
                &format!("Relationship source '{}' cannot be {}", d.source.id, source_kind.as_str()),
                d.source.span,
                symbols[&d.source.id].span,
                None,
                None,
            ));
        }
        if !is_related(target_kind) {
            return Err(conflict(
                &format!("Relationship target '{}' cannot be {}", d.target.id, target_kind.as_str()),
                d.target.span,
                symbols[&d.target.id].span,
                None,
                None,
            ));
        }
        if matches!(d.rel_type, RelationshipType::Include | RelationshipType::Extend)
            && (source_kind != SymbolKind::Usecase || target_kind != SymbolKind::Usecase)
        {
            return Err(fail(format!("{} relationship requires use-case endpoints", d.rel_type.as_str()), d.span));
        }
        if d.rel_type == RelationshipType::Generalization && (source_kind == SymbolKind::Json || source_kind != target_kind) {
            return Err(fail(
                "Generalization requires actor-to-actor or use-case-to-use-case endpoints".to_string(),
                d.span,
            ));
        }
        if d.rel_type == RelationshipType::Association
            && (source_kind == SymbolKind::Json || target_kind == SymbolKind::Json)
            && !d.arrow_type.is_json_allowed()
        {
            return Err(fail(
                format!(
                    "JSON relationship '{}' to '{}' permits only point, reversed-point, or markerless solid association",
                    d.source.id, d.target.id
                ),
                d.span,
            ));
        }
        let id = match &d.id {
            Some(explicit) => explicit.clone(),
            None => {
                let s = format!("edge-{anonymous}");
                anonymous += 1;
                s
            }
        };
        let rel = Relationship {
            id: id.clone(),
            explicit_id: d.id.is_some(),
            source: d.source.id.clone(),
            target: d.target.id.clone(),
            rel_type: d.rel_type,
            arrow_type: d.arrow_type,
            label: d.label.as_ref().map(|l| l.text.clone()),
            label_type: d.label.as_ref().map(|l| l.label_type),
            minlen: d.minlen,
            classes: Vec::new(),
            styles: Vec::new(),
            animate: false,
            animation: None,
        };
        let rel_idx = model.relationships.len();
        model.relationships.push(rel);
        edge_index.insert(id, rel_idx);
    }

    // Reorder actors and use cases by first mention after implicit relationship endpoints were added.
    let declared_actors = std::mem::take(&mut model.actors);
    let declared_use_cases = std::mem::take(&mut model.use_cases);
    let mut all_elem_ids: Vec<String> = elements.keys().cloned().collect();
    all_elem_ids.sort_by_key(|id| first.get(id).copied().unwrap_or(0));
    for id in &all_elem_ids {
        if let Some(a) = declared_actors.get(id) {
            model.actors.insert(id.clone(), a.clone());
        } else if let Some(u) = declared_use_cases.get(id) {
            model.use_cases.insert(id.clone(), u.clone());
        } else {
            publish(&mut model, &elements[id]);
        }
    }

    for meta in &drafts.metadata {
        let Some(orig) = symbols.get(&meta.target) else {
            let suffix = infer_kind(&meta.properties).map_or_else(String::new, |k| format!(" (metadata implies {k})"));
            return Err(fail(format!("Metadata target '{}' is unresolved{suffix}", meta.target), meta.span));
        };
        let kind = orig.kind;
        match kind {
            SymbolKind::Actor | SymbolKind::Usecase => {
                let state = elements.get_mut(&meta.target).unwrap();
                apply_element_metadata(state, &meta.properties, true)?;
            }
            SymbolKind::Edge => {
                if let Some(stmt_idx) = meta.stmt_index {
                    let stmt = &mut statements[stmt_idx];
                    stmt.kind = StatementKind::EdgeMetadata;
                    stmt.edges = Some(vec![EdgeOccurrence {
                        id: meta.target.clone(),
                        span: stmt.span,
                        label_span: None,
                        id_span: Some(meta.span),
                        metadata: stmt.metadata.clone(),
                    }]);
                    stmt.nodes = None;
                }
                let e_idx = edge_index[&meta.target];
                let edge = &mut model.relationships[e_idx];
                for prop in &meta.properties {
                    match (prop.key.as_str(), &prop.value) {
                        ("animate", PropertyValue::Bool(b)) => edge.animate = *b,
                        ("animation", PropertyValue::Str(s)) if matches!(s.as_str(), "fast" | "slow") => {
                            edge.animation = Some(if s == "fast" { Animation::Fast } else { Animation::Slow });
                            edge.animate = true;
                        }
                        _ => return Err(invalid(&meta.target, kind.as_str(), prop)),
                    }
                }
            }
            SymbolKind::Boundary => {
                let boundary = boundaries.get_mut(&meta.target).unwrap();
                for prop in &meta.properties {
                    match (prop.key.as_str(), &prop.value) {
                        ("type", PropertyValue::Str(s)) if matches!(s.as_str(), "rect" | "package") => {
                            boundary.boundary_type = Some(if s == "rect" { BoundaryType::Rect } else { BoundaryType::Package });
                        }
                        _ => return Err(invalid(&meta.target, kind.as_str(), prop)),
                    }
                }
            }
            SymbolKind::Json => {
                if let Some(prop) = meta.properties.first() {
                    return Err(invalid(&meta.target, kind.as_str(), prop));
                }
            }
        }
    }
    for rel in &mut model.relationships {
        if rel.animation.is_some() {
            rel.animate = true;
        }
    }

    for state in elements.values() {
        match state.kind {
            ElementKind::Actor => {
                if state.icon.as_deref().is_some_and(|s| !s.is_empty())
                    && let Some(at_val) = state.actor_type
                    && at_val != NonIconActorType::Normal
                {
                    return Err(fail(
                        format!("Actor '{}' cannot combine icon with type '{}'", state.id, at_val.as_str()),
                        state.span,
                    ));
                }
                if state.business == Some(true) && (state.icon.as_deref().is_some_and(|s| !s.is_empty()) || state.actor_type == Some(NonIconActorType::Awesome))
                {
                    return Err(fail(format!("Business actor '{}' must use normal or hollow geometry", state.id), state.span));
                }
            }
            ElementKind::Usecase => {
                if state.shape == Some(UseCaseShape::Rect) && state.business == Some(true) {
                    return Err(fail(format!("Rectangular use case '{}' cannot be a business use case", state.id), state.span));
                }
            }
        }
        publish(&mut model, state);
    }

    let mut elem_order: Vec<usize> = (0..drafts.elements.len()).collect();
    elem_order.sort_by_key(|&idx| drafts.elements[idx].span.0);
    for idx in elem_order {
        let d = &drafts.elements[idx];
        if let Some((ref pid, _)) = d.parent
            && !pid.is_empty()
            && let Some(b) = boundaries.get_mut(pid)
            && !b.members.contains(&d.id)
        {
            b.members.push(d.id.clone());
        }
    }
    for state in boundaries.values() {
        if let Some(b) = model.system_boundaries.get_mut(&state.id) {
            b.boundary_type = state.boundary_type.unwrap_or(BoundaryType::Rect);
            b.members = state.members.clone();
            b.classes = state.classes.clone();
        }
    }

    for (note_idx, d) in drafts.notes.iter().enumerate() {
        let Some(orig) = symbols.get(&d.target) else {
            return Err(fail(format!("Note target '{}' is unresolved", d.target), d.span));
        };
        if !matches!(orig.kind, SymbolKind::Actor | SymbolKind::Usecase) {
            return Err(conflict(
                &format!("Note target '{}' must be an actor or use case, not {}", d.target, orig.kind.as_str()),
                d.span,
                orig.span,
                None,
                None,
            ));
        }
        let id = format!("note-{note_idx}");
        model.notes.insert(
            id.clone(),
            UsecaseNote {
                id,
                target: d.target.clone(),
                label: d.label.text.clone(),
                label_type: d.label.label_type,
            },
        );
    }

    for def in &drafts.class_defs {
        for id in &def.ids {
            model.class_defs.insert(
                id.clone(),
                ClassDef {
                    id: id.clone(),
                    styles: def.styles.clone(),
                },
            );
        }
    }

    let mut apply_classes = |id: &str, span: Span, classes: &[String]| -> Result<(), PeleError> {
        let target: Option<&mut Vec<String>> = match symbols.get(id).map(|o| o.kind) {
            Some(SymbolKind::Actor) => model.actors.get_mut(id).map(|v| &mut v.classes),
            Some(SymbolKind::Usecase) => model.use_cases.get_mut(id).map(|v| &mut v.classes),
            Some(SymbolKind::Boundary) => model.system_boundaries.get_mut(id).map(|v| &mut v.classes),
            Some(SymbolKind::Json) => model.json_nodes.get_mut(id).map(|v| &mut v.classes),
            Some(SymbolKind::Edge) => edge_index.get(id).map(|&i| &mut model.relationships[i].classes),
            None => None,
        };
        match target {
            Some(vec) => {
                push_unique(vec, classes);
                Ok(())
            }
            None => Err(fail(format!("Class/style target '{id}' is unresolved or anonymous"), span)),
        }
    };
    for assign in &drafts.classes {
        for (tid, tspan) in &assign.targets {
            apply_classes(tid, *tspan, &assign.classes)?;
        }
    }

    let mut apply_styles = |id: &str, span: Span, styles: &[String]| -> Result<(), PeleError> {
        let target: Option<&mut Vec<String>> = match symbols.get(id).map(|o| o.kind) {
            Some(SymbolKind::Actor) => model.actors.get_mut(id).map(|v| &mut v.styles),
            Some(SymbolKind::Usecase) => model.use_cases.get_mut(id).map(|v| &mut v.styles),
            Some(SymbolKind::Boundary) => model.system_boundaries.get_mut(id).map(|v| &mut v.styles),
            Some(SymbolKind::Json) => model.json_nodes.get_mut(id).map(|v| &mut v.styles),
            Some(SymbolKind::Edge) => edge_index.get(id).map(|&i| &mut model.relationships[i].styles),
            None => None,
        };
        match target {
            Some(vec) => {
                vec.extend(styles.iter().cloned());
                Ok(())
            }
            None => Err(fail(format!("Class/style target '{id}' is unresolved or anonymous"), span)),
        }
    };
    for assign in &drafts.styles {
        apply_styles(&assign.target, assign.span, &assign.styles)?;
    }

    if let Some(dir) = drafts.direction {
        model.direction = dir;
    }
    model.title = title;
    model.acc_title = drafts.acc_title;
    model.acc_descr = normalize_acc_descr(&drafts.acc_description);
    model.acc_description = drafts.acc_description;
    model.source = src.to_string();
    model.header_span = header_span;
    model.statements = statements;
    Ok(model)
}
