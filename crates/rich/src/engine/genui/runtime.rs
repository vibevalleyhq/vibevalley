use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::engine::genui::error::GenUiError;
use crate::engine::genui::expr::{
    EvalLimits, eval_expr, eval_template, parse_expr_with_limits, parse_template_with_limits, referenced_keys, template_referenced_keys,
};
use crate::engine::genui::resolved::{
    ResolveDiagnostic, ResolvedChart, ResolvedChartContent, ResolvedChartSeries, ResolvedDoc, ResolvedNode, ResolvedNodeKind, ResolvedReactiveChart,
    ResolvedSelectOption, ResolvedTab, ResolvedTableColumn, ResolvedTableRow,
};
use crate::engine::genui::spec::{
    Align, CategoryBinding, ChartSource, ExprSource, GenUiNode, GenUiSpec, NodeKind, PatchOp, PropsPatch, SeriesValuesBinding, TableRows, TextAlign, TextExpr,
    ValueExpr,
};
use crate::engine::genui::stream::{GenUiStream, StreamEvent, StreamLimits};
use crate::engine::genui::value::{FormatKind, StateStore, StateValue, format_value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeLimits {
    pub eval: EvalLimits,
    pub stream: StreamLimits,
    pub max_nodes: usize,
    pub max_tree_depth: usize,
}

impl Default for RuntimeLimits {
    fn default() -> Self {
        Self {
            eval: EvalLimits::default(),
            stream: StreamLimits::default(),
            max_nodes: 2_048,
            max_tree_depth: 64,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct GenUiDoc {
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub root_id: Option<String>,
    pub nodes: BTreeMap<String, GenUiNode>,
    pub generation: u64,
    pub complete: bool,
}

impl GenUiDoc {
    pub fn node(&self, id: &str) -> Option<&GenUiNode> {
        self.nodes.get(id)
    }

    pub fn node_generation(&self, id: &str) -> Option<u64> {
        self.nodes.get(id).map(|n| n.generation)
    }

    pub fn is_complete(&self) -> bool {
        self.complete
    }

    pub fn to_spec(&self, state: &StateStore) -> GenUiSpec {
        GenUiSpec {
            title: self.title.clone(),
            subtitle: self.subtitle.clone(),
            root_id: self.root_id.clone(),
            state: state.entries().clone(),
            nodes: self.nodes.values().cloned().collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatchOutcome {
    pub generation: u64,
    pub dirty_nodes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RuntimeEvent {
    PatchApplied { line: usize, generation: u64, dirty_nodes: Vec<String> },
    Complete { line: usize, generation: u64 },
    Error { line: usize, error: GenUiError },
}

#[derive(Debug, Clone)]
pub struct GenUiRuntime {
    doc: GenUiDoc,
    state: StateStore,
    state_revision: u64,
    user_modified_keys: BTreeSet<String>,
    node_deps: BTreeMap<String, BTreeSet<String>>,
    key_dependents: BTreeMap<String, BTreeSet<String>>,
    stream: GenUiStream,
    limits: RuntimeLimits,
}

impl Default for GenUiRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl GenUiRuntime {
    pub fn new() -> Self {
        Self::with_limits(RuntimeLimits::default())
    }

    pub fn with_limits(limits: RuntimeLimits) -> Self {
        Self {
            doc: GenUiDoc::default(),
            state: StateStore::new(),
            state_revision: 0,
            user_modified_keys: BTreeSet::new(),
            node_deps: BTreeMap::new(),
            key_dependents: BTreeMap::new(),
            stream: GenUiStream::with_limits(limits.stream),
            limits,
        }
    }

    pub fn from_spec(spec: GenUiSpec) -> Result<Self, GenUiError> {
        Self::from_spec_with_limits(spec, RuntimeLimits::default())
    }

    pub fn from_spec_with_limits(spec: GenUiSpec, limits: RuntimeLimits) -> Result<Self, GenUiError> {
        let mut runtime = Self::with_limits(limits);
        if let Some(title) = spec.title {
            runtime.apply_patch(PatchOp::Title {
                title,
                subtitle: spec.subtitle,
            })?;
        } else {
            runtime.doc.subtitle = spec.subtitle;
        }
        if !spec.state.is_empty() {
            runtime.apply_patch(PatchOp::StateInit {
                state: spec.state,
                overwrite: true,
            })?;
        }
        let explicit_root = spec.root_id;
        for node in spec.nodes {
            let is_root = explicit_root.as_deref() == Some(node.id.as_str());
            runtime.apply_patch(PatchOp::SetNode {
                node: Box::new(node),
                root: is_root,
            })?;
        }
        runtime.apply_patch(PatchOp::Done)?;
        Ok(runtime)
    }

    pub fn doc(&self) -> &GenUiDoc {
        &self.doc
    }

    pub fn state(&self) -> &StateStore {
        &self.state
    }

    pub fn is_complete(&self) -> bool {
        self.doc.complete
    }

    pub fn state_revision(&self) -> u64 {
        self.state_revision
    }

    pub fn node_dependencies(&self, node_id: &str) -> Option<&BTreeSet<String>> {
        self.node_deps.get(node_id)
    }

    pub fn dependent_nodes(&self, key: &str) -> Vec<String> {
        self.key_dependents.get(key).map(|set| set.iter().cloned().collect()).unwrap_or_default()
    }

    pub fn push_chunk(&mut self, delta: &str) -> Vec<RuntimeEvent> {
        let events = self.stream.push_chunk(delta);
        self.ingest_stream_events(events)
    }

    pub fn push_bytes(&mut self, bytes: &[u8]) -> Vec<RuntimeEvent> {
        let events = self.stream.push_bytes(bytes);
        self.ingest_stream_events(events)
    }

    pub fn finish_stream(&mut self) -> Vec<RuntimeEvent> {
        let events = self.stream.finish();
        self.ingest_stream_events(events)
    }

    fn ingest_stream_events(&mut self, events: Vec<StreamEvent>) -> Vec<RuntimeEvent> {
        let mut out = Vec::with_capacity(events.len());
        for event in events {
            match event {
                StreamEvent::Patch { line, op, .. } => match self.apply_patch(op) {
                    Ok(outcome) => out.push(RuntimeEvent::PatchApplied {
                        line,
                        generation: outcome.generation,
                        dirty_nodes: outcome.dirty_nodes,
                    }),
                    Err(error) => out.push(RuntimeEvent::Error { line, error }),
                },
                StreamEvent::Complete { line, .. } => out.push(RuntimeEvent::Complete {
                    line,
                    generation: self.doc.generation,
                }),
                StreamEvent::Error { line, error } => out.push(RuntimeEvent::Error { line, error }),
            }
        }
        out
    }

    pub fn set_state(&mut self, key: impl Into<String>, value: StateValue) -> Result<Vec<String>, GenUiError> {
        validate_state_value(&value)?;
        let key = key.into();
        let changed = self.state.set(key.clone(), value);
        self.user_modified_keys.insert(key.clone());
        if !changed {
            return Ok(Vec::new());
        }
        self.state_revision += 1;
        Ok(self.dependent_nodes(&key))
    }

    pub fn apply_patch(&mut self, op: PatchOp) -> Result<PatchOutcome, GenUiError> {
        match op {
            PatchOp::Title { title, subtitle } => {
                self.doc.title = Some(title);
                if subtitle.is_some() {
                    self.doc.subtitle = subtitle;
                }
                self.doc.generation += 1;
                Ok(PatchOutcome {
                    generation: self.doc.generation,
                    dirty_nodes: Vec::new(),
                })
            }
            PatchOp::StateInit { state, overwrite } => {
                for value in state.values() {
                    validate_state_value(value)?;
                }
                let mut dirty = BTreeSet::new();
                let mut any_changed = false;
                for (key, value) in state {
                    if !overwrite && self.user_modified_keys.contains(&key) {
                        continue;
                    }
                    if self.state.set(key.clone(), value) {
                        any_changed = true;
                        if let Some(deps) = self.key_dependents.get(&key) {
                            dirty.extend(deps.iter().cloned());
                        }
                    }
                }
                if any_changed {
                    self.state_revision += 1;
                }
                self.doc.generation += 1;
                Ok(PatchOutcome {
                    generation: self.doc.generation,
                    dirty_nodes: dirty.into_iter().collect(),
                })
            }
            PatchOp::SetNode { node, root } => {
                let mut node = *node;
                validate_node(&node)?;
                if !self.doc.nodes.contains_key(&node.id) && self.doc.nodes.len() >= self.limits.max_nodes {
                    return Err(GenUiError::NodeLimitExceeded { limit: self.limits.max_nodes });
                }
                let child_ids: Vec<String> = node.kind.child_ids().into_iter().map(str::to_owned).collect();
                self.ensure_acyclic(&node.id, &child_ids)?;

                self.doc.generation += 1;
                node.generation = self.doc.generation;
                let id = node.id.clone();
                if root || self.doc.root_id.is_none() {
                    self.doc.root_id = Some(id.clone());
                }
                self.reindex_node_deps(&node);
                self.doc.nodes.insert(id.clone(), node);

                Ok(PatchOutcome {
                    generation: self.doc.generation,
                    dirty_nodes: vec![id],
                })
            }
            PatchOp::AppendChild {
                parent_id,
                child_id,
                tab_id,
                node,
            } => {
                if !self.doc.nodes.contains_key(&parent_id) {
                    return Err(GenUiError::NodeNotFound { id: parent_id });
                }
                if let Some(inline) = &node {
                    if inline.id != child_id {
                        return Err(GenUiError::ChildIdMismatch {
                            child_id,
                            node_id: inline.id.clone(),
                        });
                    }
                    validate_node(inline)?;
                    if !self.doc.nodes.contains_key(&inline.id) && self.doc.nodes.len() >= self.limits.max_nodes {
                        return Err(GenUiError::NodeLimitExceeded { limit: self.limits.max_nodes });
                    }
                }

                // Validate container kind & tab target before mutating anything.
                let mut parent_clone = self
                    .doc
                    .nodes
                    .get(&parent_id)
                    .cloned()
                    .ok_or_else(|| GenUiError::NodeNotFound { id: parent_id.clone() })?;
                append_child_to_kind(&mut parent_clone, &child_id, tab_id.as_deref())?;

                if let Some(inline) = &node {
                    let inline_children: Vec<String> = inline.kind.child_ids().into_iter().map(str::to_owned).collect();
                    self.ensure_acyclic(&inline.id, &inline_children)?;
                }
                let new_parent_children: Vec<String> = parent_clone.kind.child_ids().into_iter().map(str::to_owned).collect();
                self.ensure_acyclic_with_override(&parent_id, &new_parent_children, node.as_deref())?;

                self.doc.generation += 1;
                let generation = self.doc.generation;
                let mut dirty = Vec::new();

                if let Some(inline) = node {
                    let mut inline = *inline;
                    inline.generation = generation;
                    self.reindex_node_deps(&inline);
                    dirty.push(inline.id.clone());
                    self.doc.nodes.insert(inline.id.clone(), inline);
                }

                parent_clone.generation = generation;
                self.reindex_node_deps(&parent_clone);
                self.doc.nodes.insert(parent_id.clone(), parent_clone);
                dirty.push(parent_id);

                Ok(PatchOutcome {
                    generation,
                    dirty_nodes: dirty,
                })
            }
            PatchOp::UpdateProps { id, visible, props } => {
                let mut updated = self.doc.nodes.get(&id).cloned().ok_or_else(|| GenUiError::NodeNotFound { id: id.clone() })?;

                visible.apply(&mut updated.visible);
                apply_props_patch(&mut updated, *props)?;
                validate_node(&updated)?;

                let child_ids: Vec<String> = updated.kind.child_ids().into_iter().map(str::to_owned).collect();
                self.ensure_acyclic(&updated.id, &child_ids)?;

                self.doc.generation += 1;
                updated.generation = self.doc.generation;
                self.reindex_node_deps(&updated);
                self.doc.nodes.insert(id.clone(), updated);

                Ok(PatchOutcome {
                    generation: self.doc.generation,
                    dirty_nodes: vec![id],
                })
            }
            PatchOp::RemoveNode { id, recursive } => {
                if !self.doc.nodes.contains_key(&id) {
                    return Err(GenUiError::NodeNotFound { id });
                }

                let mut to_remove = BTreeSet::new();
                if recursive {
                    let mut queue = VecDeque::new();
                    queue.push_back(id.clone());
                    while let Some(cur) = queue.pop_front() {
                        if !to_remove.insert(cur.clone()) {
                            continue;
                        }
                        if let Some(node) = self.doc.nodes.get(&cur) {
                            for child in node.kind.child_ids() {
                                if !to_remove.contains(child) {
                                    queue.push_back(child.to_owned());
                                }
                            }
                        }
                    }
                } else {
                    to_remove.insert(id.clone());
                }

                self.doc.generation += 1;
                let generation = self.doc.generation;

                for dead_id in &to_remove {
                    self.doc.nodes.remove(dead_id);
                    self.remove_node_deps(dead_id);
                }

                if let Some(root) = &self.doc.root_id
                    && to_remove.contains(root)
                {
                    self.doc.root_id = None;
                }

                let mut dirty = Vec::new();
                for node in self.doc.nodes.values_mut() {
                    if detach_children(&mut node.kind, &to_remove) {
                        node.generation = generation;
                        dirty.push(node.id.clone());
                    }
                }

                Ok(PatchOutcome {
                    generation,
                    dirty_nodes: dirty,
                })
            }
            PatchOp::Done => {
                self.doc.complete = true;
                self.doc.generation += 1;
                Ok(PatchOutcome {
                    generation: self.doc.generation,
                    dirty_nodes: Vec::new(),
                })
            }
        }
    }

    pub fn resolve_tree(&self) -> ResolvedDoc {
        let mut diagnostics = Vec::new();
        let root = self.doc.root_id.as_deref().and_then(|root_id| {
            let mut visited = BTreeSet::new();
            self.resolve_node(root_id, 0, &mut visited, &mut diagnostics)
        });
        ResolvedDoc {
            title: self.doc.title.clone(),
            subtitle: self.doc.subtitle.clone(),
            is_complete: self.doc.complete,
            doc_generation: self.doc.generation,
            state_revision: self.state_revision,
            root,
            diagnostics,
        }
    }

    pub fn try_resolve_tree(&self) -> Result<ResolvedDoc, GenUiError> {
        let doc = self.resolve_tree();
        if let Some(first) = doc.diagnostics.first() {
            return Err(first.error.clone());
        }
        Ok(doc)
    }

    fn resolve_node(&self, id: &str, depth: usize, visited: &mut BTreeSet<String>, diagnostics: &mut Vec<ResolveDiagnostic>) -> Option<ResolvedNode> {
        if depth > self.limits.max_tree_depth {
            diagnostics.push(ResolveDiagnostic {
                node_id: id.to_owned(),
                field: "tree".to_owned(),
                error: GenUiError::DepthLimitExceeded {
                    limit: self.limits.max_tree_depth,
                },
            });
            return None;
        }
        let node = self.doc.nodes.get(id)?;
        if !visited.insert(id.to_owned()) {
            diagnostics.push(ResolveDiagnostic {
                node_id: id.to_owned(),
                field: "tree".to_owned(),
                error: GenUiError::CycleDetected { node_id: id.to_owned() },
            });
            return None;
        }

        if let Some(vis_expr) = &node.visible {
            match self.eval_expr_source(vis_expr) {
                Ok(val) => {
                    if !val.is_truthy() {
                        visited.remove(id);
                        return None;
                    }
                }
                Err(error) => {
                    diagnostics.push(ResolveDiagnostic {
                        node_id: id.to_owned(),
                        field: "visible".to_owned(),
                        error,
                    });
                }
            }
        }

        let kind = match &node.kind {
            NodeKind::Stack {
                direction,
                gap,
                align,
                children,
            } => ResolvedNodeKind::Stack {
                direction: *direction,
                gap: gap.unwrap_or(12.0),
                align: align.unwrap_or(Align::Stretch),
                children: self.resolve_children(children, depth + 1, visited, diagnostics),
            },
            NodeKind::Grid { columns, gap, children } => ResolvedNodeKind::Grid {
                columns: *columns,
                gap: gap.unwrap_or(12.0),
                children: self.resolve_children(children, depth + 1, visited, diagnostics),
            },
            NodeKind::Card { title, subtitle, children } => ResolvedNodeKind::Card {
                title: title.as_ref().map(|t| self.eval_text_or_record(id, "title", t, diagnostics)),
                subtitle: subtitle.as_ref().map(|t| self.eval_text_or_record(id, "subtitle", t, diagnostics)),
                children: self.resolve_children(children, depth + 1, visited, diagnostics),
            },
            NodeKind::Tabs { bind, tabs } => {
                let bound_value = self.state.get(bind).map(StateValue::to_display_string);
                let active_tab = if let Some(candidate) = bound_value
                    && tabs.iter().any(|tab| tab.id == candidate)
                {
                    candidate
                } else {
                    tabs.first().map(|t| t.id.clone()).unwrap_or_default()
                };
                let resolved_tabs = tabs
                    .iter()
                    .map(|tab| ResolvedTab {
                        id: tab.id.clone(),
                        label: self.eval_text_or_record(id, "tabs.label", &tab.label, diagnostics),
                        active: tab.id == active_tab,
                        children: self.resolve_children(&tab.children, depth + 1, visited, diagnostics),
                    })
                    .collect();
                ResolvedNodeKind::Tabs {
                    bind: bind.clone(),
                    active_tab,
                    tabs: resolved_tabs,
                }
            }
            NodeKind::Divider { label } => ResolvedNodeKind::Divider {
                label: label.as_ref().map(|t| self.eval_text_or_record(id, "label", t, diagnostics)),
            },
            NodeKind::Text { value, tone, size } => ResolvedNodeKind::Text {
                value: self.eval_text_or_record(id, "value", value, diagnostics),
                tone: *tone,
                size: *size,
            },
            NodeKind::Markdown { text } => ResolvedNodeKind::Markdown {
                text: self.eval_text_or_record(id, "text", text, diagnostics),
            },
            NodeKind::Metric { label, value, delta, format } => {
                let resolved_label = self.eval_text_or_record(id, "label", label, diagnostics);
                let raw_value = self.eval_value_expr_or_record(id, "value", value, diagnostics);
                let formatted = match format {
                    Some(fmt) => match format_value(&raw_value, *fmt, None) {
                        Ok(s) => s,
                        Err(error) => {
                            diagnostics.push(ResolveDiagnostic {
                                node_id: id.to_owned(),
                                field: "format".to_owned(),
                                error,
                            });
                            raw_value.to_display_string()
                        }
                    },
                    None => raw_value.to_display_string(),
                };
                let resolved_delta = delta.as_ref().map(|d| self.eval_text_or_record(id, "delta", d, diagnostics));
                ResolvedNodeKind::Metric {
                    label: resolved_label,
                    value: formatted,
                    raw_value,
                    delta: resolved_delta,
                    format: *format,
                }
            }
            NodeKind::Badge { label, tone } => ResolvedNodeKind::Badge {
                label: self.eval_text_or_record(id, "label", label, diagnostics),
                tone: *tone,
            },
            NodeKind::Progress { value, max, label } => {
                let raw_val = self.eval_value_expr_or_record(id, "value", value, diagnostics);
                let raw_max = self.eval_value_expr_or_record(id, "max", max, diagnostics);
                let num_val = extract_numeric_or_record(id, "value", &raw_val, 0.0, diagnostics);
                let num_max = extract_numeric_or_record(id, "max", &raw_max, 100.0, diagnostics);
                let ratio = if num_max > 0.0 { (num_val / num_max).clamp(0.0, 1.0) } else { 0.0 };
                ResolvedNodeKind::Progress {
                    value: num_val,
                    max: num_max,
                    ratio,
                    label: label.as_ref().map(|t| self.eval_text_or_record(id, "label", t, diagnostics)),
                }
            }
            NodeKind::Callout { callout_kind, title, body } => ResolvedNodeKind::Callout {
                callout_kind: *callout_kind,
                title: title.as_ref().map(|t| self.eval_text_or_record(id, "title", t, diagnostics)),
                body: self.eval_text_or_record(id, "body", body, diagnostics),
            },
            NodeKind::Table { columns, rows } => {
                let resolved_cols: Vec<ResolvedTableColumn> = columns
                    .iter()
                    .map(|col| ResolvedTableColumn {
                        key: col.key.clone(),
                        label: self.eval_text_or_record(id, "columns.label", &col.label, diagnostics),
                        align: col.align.unwrap_or(TextAlign::Left),
                        format: col.format,
                    })
                    .collect();
                let resolved_rows = self.resolve_table_rows(id, &resolved_cols, rows, diagnostics);
                ResolvedNodeKind::Table {
                    columns: resolved_cols,
                    rows: resolved_rows,
                }
            }
            NodeKind::Slider {
                bind,
                label,
                min,
                max,
                step,
                unit,
            } => {
                let current = self.state.get(bind).and_then(StateValue::as_f64).map(|n| n.clamp(*min, *max)).unwrap_or(*min);
                ResolvedNodeKind::Slider {
                    bind: bind.clone(),
                    label: self.eval_text_or_record(id, "label", label, diagnostics),
                    value: current,
                    min: *min,
                    max: *max,
                    step: *step,
                    unit: unit.clone(),
                }
            }
            NodeKind::Switch { bind, label } => ResolvedNodeKind::Switch {
                bind: bind.clone(),
                label: self.eval_text_or_record(id, "label", label, diagnostics),
                checked: self.state.get(bind).is_some_and(StateValue::is_truthy),
            },
            NodeKind::Select { bind, label, options } => {
                let resolved_opts: Vec<ResolvedSelectOption> = options
                    .iter()
                    .map(|opt| ResolvedSelectOption {
                        value: opt.value.clone(),
                        label: self.eval_text_or_record(id, "options.label", &opt.label, diagnostics),
                    })
                    .collect();
                let selected = self
                    .state
                    .get(bind)
                    .map(StateValue::to_display_string)
                    .unwrap_or_else(|| resolved_opts.first().map(|o| o.value.clone()).unwrap_or_default());
                ResolvedNodeKind::Select {
                    bind: bind.clone(),
                    label: self.eval_text_or_record(id, "label", label, diagnostics),
                    selected,
                    options: resolved_opts,
                }
            }
            NodeKind::Chart {
                title,
                subtitle,
                width,
                height,
                source,
            } => {
                let resolved_title = title.as_ref().map(|t| self.eval_text_or_record(id, "title", t, diagnostics));
                let resolved_subtitle = subtitle.as_ref().map(|t| self.eval_text_or_record(id, "subtitle", t, diagnostics));
                let content = self.resolve_chart_source(id, source, diagnostics);
                ResolvedNodeKind::Chart(ResolvedChart {
                    title: resolved_title,
                    subtitle: resolved_subtitle,
                    width: *width,
                    height: *height,
                    content,
                })
            }
            NodeKind::Diagram { source } => ResolvedNodeKind::Diagram {
                source: self.eval_text_or_record(id, "source", source, diagnostics),
            },
            NodeKind::Canvas { data } => ResolvedNodeKind::Canvas {
                data: self.eval_text_or_record(id, "data", data, diagnostics),
            },
            NodeKind::CodeBlock { code, language } => ResolvedNodeKind::CodeBlock {
                code: self.eval_text_or_record(id, "code", code, diagnostics),
                language: language.clone(),
            },
        };

        visited.remove(id);
        Some(ResolvedNode {
            id: node.id.clone(),
            generation: node.generation,
            kind,
        })
    }

    fn resolve_children(
        &self,
        child_ids: &[String],
        depth: usize,
        visited: &mut BTreeSet<String>,
        diagnostics: &mut Vec<ResolveDiagnostic>,
    ) -> Vec<ResolvedNode> {
        let mut out = Vec::with_capacity(child_ids.len());
        for child_id in child_ids {
            if let Some(child) = self.resolve_node(child_id, depth, visited, diagnostics) {
                out.push(child);
            }
        }
        out
    }

    fn resolve_table_rows(
        &self,
        node_id: &str,
        columns: &[ResolvedTableColumn],
        rows: &TableRows,
        diagnostics: &mut Vec<ResolveDiagnostic>,
    ) -> Vec<ResolvedTableRow> {
        match rows {
            TableRows::Static(static_rows) => static_rows
                .iter()
                .map(|row| ResolvedTableRow {
                    cells: row
                        .iter()
                        .map(|cell| self.eval_text_or_record(node_id, "rows.cell", cell, diagnostics))
                        .collect(),
                })
                .collect(),
            TableRows::Expr(expr_src) => match self.eval_expr_source(expr_src) {
                Ok(StateValue::List(items)) => items
                    .iter()
                    .map(|item| match item {
                        StateValue::Record(_) => ResolvedTableRow {
                            cells: columns
                                .iter()
                                .map(|col| {
                                    let val = item.get_field(&col.key).unwrap_or(&StateValue::Null);
                                    format_table_cell(node_id, &col.key, val, col.format, diagnostics)
                                })
                                .collect(),
                        },
                        StateValue::List(cells) => ResolvedTableRow {
                            cells: columns
                                .iter()
                                .enumerate()
                                .map(|(idx, col)| {
                                    let val = cells.get(idx).unwrap_or(&StateValue::Null);
                                    format_table_cell(node_id, &col.key, val, col.format, diagnostics)
                                })
                                .collect(),
                        },
                        StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::Text(_) => {
                            let mut cells = Vec::with_capacity(columns.len().max(1));
                            if let Some(first_col) = columns.first() {
                                cells.push(format_table_cell(node_id, &first_col.key, item, first_col.format, diagnostics));
                                for _ in 1..columns.len() {
                                    cells.push(String::new());
                                }
                            } else {
                                cells.push(item.to_display_string());
                            }
                            ResolvedTableRow { cells }
                        }
                    })
                    .collect(),
                Ok(other @ (StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::Text(_) | StateValue::Record(_))) => {
                    diagnostics.push(ResolveDiagnostic {
                        node_id: node_id.to_owned(),
                        field: "rows".to_owned(),
                        error: GenUiError::TypeMismatch {
                            context: "table rows".to_owned(),
                            expected: "list".to_owned(),
                            actual: other.type_name().to_owned(),
                        },
                    });
                    Vec::new()
                }
                Err(error) => {
                    diagnostics.push(ResolveDiagnostic {
                        node_id: node_id.to_owned(),
                        field: "rows".to_owned(),
                        error,
                    });
                    Vec::new()
                }
            },
        }
    }

    fn resolve_chart_source(&self, node_id: &str, source: &ChartSource, diagnostics: &mut Vec<ResolveDiagnostic>) -> ResolvedChartContent {
        match source {
            ChartSource::Template { template } => ResolvedChartContent::SpecJson {
                spec_json: self.eval_text_or_record(node_id, "source.template", template, diagnostics),
            },
            ChartSource::Reactive {
                chart_kind,
                x_label,
                y_label,
                y_format,
                categories,
                series,
            } => {
                let resolved_categories = match categories {
                    CategoryBinding::Static(items) => items
                        .iter()
                        .map(|t| self.eval_text_or_record(node_id, "source.categories", t, diagnostics))
                        .collect(),
                    CategoryBinding::Expr(expr_src) => match self.eval_expr_source(expr_src) {
                        Ok(StateValue::List(items)) => items.iter().map(StateValue::to_display_string).collect(),
                        Ok(other @ (StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::Text(_) | StateValue::Record(_))) => {
                            diagnostics.push(ResolveDiagnostic {
                                node_id: node_id.to_owned(),
                                field: "source.categories".to_owned(),
                                error: GenUiError::TypeMismatch {
                                    context: "chart categories".to_owned(),
                                    expected: "list".to_owned(),
                                    actual: other.type_name().to_owned(),
                                },
                            });
                            Vec::new()
                        }
                        Err(error) => {
                            diagnostics.push(ResolveDiagnostic {
                                node_id: node_id.to_owned(),
                                field: "source.categories".to_owned(),
                                error,
                            });
                            Vec::new()
                        }
                    },
                };

                let resolved_series = series
                    .iter()
                    .map(|s| {
                        let name = self.eval_text_or_record(node_id, "source.series.name", &s.name, diagnostics);
                        let values = match &s.values {
                            SeriesValuesBinding::Static(vals) => vals.clone(),
                            SeriesValuesBinding::Expr(expr_src) => match self.eval_expr_source(expr_src) {
                                Ok(StateValue::List(items)) => {
                                    let mut nums = Vec::with_capacity(items.len());
                                    for item in items {
                                        match item {
                                            StateValue::Number(n) if n.is_finite() => nums.push(Some(n)),
                                            StateValue::Null => nums.push(None),
                                            other @ (StateValue::Number(_)
                                            | StateValue::Bool(_)
                                            | StateValue::Text(_)
                                            | StateValue::List(_)
                                            | StateValue::Record(_)) => {
                                                diagnostics.push(ResolveDiagnostic {
                                                    node_id: node_id.to_owned(),
                                                    field: "source.series.values".to_owned(),
                                                    error: GenUiError::TypeMismatch {
                                                        context: "chart series element".to_owned(),
                                                        expected: "number or null".to_owned(),
                                                        actual: other.type_name().to_owned(),
                                                    },
                                                });
                                                nums.push(None);
                                            }
                                        }
                                    }
                                    nums
                                }
                                Ok(other @ (StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::Text(_) | StateValue::Record(_))) => {
                                    diagnostics.push(ResolveDiagnostic {
                                        node_id: node_id.to_owned(),
                                        field: "source.series.values".to_owned(),
                                        error: GenUiError::TypeMismatch {
                                            context: "chart series values".to_owned(),
                                            expected: "list".to_owned(),
                                            actual: other.type_name().to_owned(),
                                        },
                                    });
                                    Vec::new()
                                }
                                Err(error) => {
                                    diagnostics.push(ResolveDiagnostic {
                                        node_id: node_id.to_owned(),
                                        field: "source.series.values".to_owned(),
                                        error,
                                    });
                                    Vec::new()
                                }
                            },
                        };
                        ResolvedChartSeries {
                            name,
                            values,
                            color: s.color.clone(),
                        }
                    })
                    .collect();

                ResolvedChartContent::Reactive(ResolvedReactiveChart {
                    chart_kind: *chart_kind,
                    x_label: x_label.as_ref().map(|t| self.eval_text_or_record(node_id, "source.x_label", t, diagnostics)),
                    y_label: y_label.as_ref().map(|t| self.eval_text_or_record(node_id, "source.y_label", t, diagnostics)),
                    y_format: *y_format,
                    categories: resolved_categories,
                    series: resolved_series,
                })
            }
        }
    }

    fn eval_expr_source(&self, source: &ExprSource) -> Result<StateValue, GenUiError> {
        let expr = parse_expr_with_limits(source.as_str(), self.limits.eval)?;
        eval_expr(&expr, &self.state, self.limits.eval)
    }

    fn eval_text_or_record(&self, node_id: &str, field: &str, text: &TextExpr, diagnostics: &mut Vec<ResolveDiagnostic>) -> String {
        match parse_template_with_limits(text.as_str(), self.limits.eval).and_then(|tpl| eval_template(&tpl, &self.state, self.limits.eval)) {
            Ok(rendered) => rendered,
            Err(error) => {
                diagnostics.push(ResolveDiagnostic {
                    node_id: node_id.to_owned(),
                    field: field.to_owned(),
                    error,
                });
                text.0.clone()
            }
        }
    }

    fn eval_value_expr_or_record(&self, node_id: &str, field: &str, expr: &ValueExpr, diagnostics: &mut Vec<ResolveDiagnostic>) -> StateValue {
        match expr {
            ValueExpr::Literal(val) => val.clone(),
            ValueExpr::Expr(src) => match self.eval_expr_source(src) {
                Ok(val) => val,
                Err(error) => {
                    diagnostics.push(ResolveDiagnostic {
                        node_id: node_id.to_owned(),
                        field: field.to_owned(),
                        error,
                    });
                    StateValue::Null
                }
            },
            ValueExpr::Template(tpl) => {
                let text = self.eval_text_or_record(node_id, field, tpl, diagnostics);
                StateValue::Text(text)
            }
        }
    }

    fn reindex_node_deps(&mut self, node: &GenUiNode) {
        self.remove_node_deps(&node.id);
        let deps = collect_node_dependencies(node, self.limits.eval);
        for key in &deps {
            self.key_dependents.entry(key.clone()).or_default().insert(node.id.clone());
        }
        self.node_deps.insert(node.id.clone(), deps);
    }

    fn remove_node_deps(&mut self, node_id: &str) {
        if let Some(old_deps) = self.node_deps.remove(node_id) {
            for key in old_deps {
                if let Some(nodes) = self.key_dependents.get_mut(&key) {
                    nodes.remove(node_id);
                    if nodes.is_empty() {
                        self.key_dependents.remove(&key);
                    }
                }
            }
        }
    }

    fn ensure_acyclic(&self, node_id: &str, candidate_children: &[String]) -> Result<(), GenUiError> {
        self.ensure_acyclic_with_override(node_id, candidate_children, None)
    }

    fn ensure_acyclic_with_override(&self, node_id: &str, candidate_children: &[String], extra_node: Option<&GenUiNode>) -> Result<(), GenUiError> {
        let mut visited = BTreeSet::new();
        let mut stack: Vec<&str> = candidate_children.iter().map(String::as_str).collect();
        while let Some(cur) = stack.pop() {
            if cur == node_id {
                return Err(GenUiError::CycleDetected { node_id: node_id.to_owned() });
            }
            if !visited.insert(cur) {
                continue;
            }
            if let Some(extra) = extra_node
                && extra.id == cur
            {
                for child in extra.kind.child_ids() {
                    stack.push(child);
                }
                continue;
            }
            if let Some(existing) = self.doc.nodes.get(cur) {
                for child in existing.kind.child_ids() {
                    stack.push(child);
                }
            }
        }
        Ok(())
    }
}

fn validate_state_value(value: &StateValue) -> Result<(), GenUiError> {
    match value {
        StateValue::Number(n) => {
            if !n.is_finite() {
                return Err(GenUiError::NonFiniteResult {
                    context: "state value".to_owned(),
                });
            }
            Ok(())
        }
        StateValue::List(items) => {
            for item in items {
                validate_state_value(item)?;
            }
            Ok(())
        }
        StateValue::Record(entries) => {
            for (_, v) in entries {
                validate_state_value(v)?;
            }
            Ok(())
        }
        StateValue::Null | StateValue::Bool(_) | StateValue::Text(_) => Ok(()),
    }
}

fn validate_node(node: &GenUiNode) -> Result<(), GenUiError> {
    if node.id.trim().is_empty() {
        return Err(GenUiError::InvalidNodeProp {
            id: node.id.clone(),
            message: "node id must not be empty".to_owned(),
        });
    }
    match &node.kind {
        NodeKind::Stack { gap, .. } => {
            if let Some(g) = gap
                && (!g.is_finite() || *g < 0.0)
            {
                return Err(GenUiError::InvalidNodeProp {
                    id: node.id.clone(),
                    message: "stack gap must be finite and non-negative".to_owned(),
                });
            }
        }
        NodeKind::Grid { columns, gap, .. } => {
            if *columns == 0 {
                return Err(GenUiError::InvalidNodeProp {
                    id: node.id.clone(),
                    message: "grid columns must be >= 1".to_owned(),
                });
            }
            if let Some(g) = gap
                && (!g.is_finite() || *g < 0.0)
            {
                return Err(GenUiError::InvalidNodeProp {
                    id: node.id.clone(),
                    message: "grid gap must be finite and non-negative".to_owned(),
                });
            }
        }
        NodeKind::Tabs { bind, .. } | NodeKind::Switch { bind, .. } | NodeKind::Select { bind, .. } => {
            if bind.trim().is_empty() {
                return Err(GenUiError::InvalidNodeProp {
                    id: node.id.clone(),
                    message: "control `bind` key must not be empty".to_owned(),
                });
            }
        }
        NodeKind::Slider { bind, min, max, step, .. } => {
            if bind.trim().is_empty() {
                return Err(GenUiError::InvalidNodeProp {
                    id: node.id.clone(),
                    message: "slider `bind` key must not be empty".to_owned(),
                });
            }
            if !min.is_finite() || !max.is_finite() || !step.is_finite() || min > max || *step <= 0.0 {
                return Err(GenUiError::InvalidNodeProp {
                    id: node.id.clone(),
                    message: format!("invalid slider bounds min={min}, max={max}, step={step}"),
                });
            }
        }
        NodeKind::Card { .. }
        | NodeKind::Divider { .. }
        | NodeKind::Text { .. }
        | NodeKind::Markdown { .. }
        | NodeKind::Metric { .. }
        | NodeKind::Badge { .. }
        | NodeKind::Progress { .. }
        | NodeKind::Callout { .. }
        | NodeKind::Table { .. }
        | NodeKind::Chart { .. }
        | NodeKind::Diagram { .. }
        | NodeKind::Canvas { .. }
        | NodeKind::CodeBlock { .. } => {}
    }
    Ok(())
}

fn append_child_to_kind(parent: &mut GenUiNode, child_id: &str, tab_id: Option<&str>) -> Result<(), GenUiError> {
    let parent_id = parent.id.clone();
    match &mut parent.kind {
        NodeKind::Stack { children, .. } | NodeKind::Grid { children, .. } | NodeKind::Card { children, .. } => {
            if !children.iter().any(|c| c == child_id) {
                children.push(child_id.to_owned());
            }
            Ok(())
        }
        NodeKind::Tabs { tabs, .. } => {
            let target = match tab_id {
                Some(tid) => tabs.iter_mut().find(|t| t.id == tid).ok_or_else(|| GenUiError::TabNotFound {
                    node_id: parent_id,
                    tab_id: tid.to_owned(),
                })?,
                None => tabs.first_mut().ok_or_else(|| GenUiError::TabNotFound {
                    node_id: parent_id,
                    tab_id: String::new(),
                })?,
            };
            if !target.children.iter().any(|c| c == child_id) {
                target.children.push(child_id.to_owned());
            }
            Ok(())
        }
        NodeKind::Divider { .. }
        | NodeKind::Text { .. }
        | NodeKind::Markdown { .. }
        | NodeKind::Metric { .. }
        | NodeKind::Badge { .. }
        | NodeKind::Progress { .. }
        | NodeKind::Callout { .. }
        | NodeKind::Table { .. }
        | NodeKind::Slider { .. }
        | NodeKind::Switch { .. }
        | NodeKind::Select { .. }
        | NodeKind::Chart { .. }
        | NodeKind::Diagram { .. }
        | NodeKind::Canvas { .. }
        | NodeKind::CodeBlock { .. } => Err(GenUiError::NotAContainer {
            id: parent_id,
            kind: parent.kind.kind_name().to_owned(),
        }),
    }
}

fn apply_props_patch(node: &mut GenUiNode, patch: PropsPatch) -> Result<(), GenUiError> {
    let id = node.id.clone();
    let expected = node.kind.kind_name();
    let actual = patch.kind_name();
    let mismatch = || GenUiError::NodeKindMismatch {
        id: id.clone(),
        expected: expected.to_owned(),
        actual: actual.to_owned(),
    };

    match patch {
        PropsPatch::Stack {
            direction,
            gap,
            align,
            children,
        } => {
            let NodeKind::Stack {
                direction: d,
                gap: g,
                align: a,
                children: c,
            } = &mut node.kind
            else {
                return Err(mismatch());
            };
            if let Some(v) = direction {
                *d = v;
            }
            gap.apply(g);
            align.apply(a);
            if let Some(v) = children {
                *c = v;
            }
        }
        PropsPatch::Grid { columns, gap, children } => {
            let NodeKind::Grid {
                columns: cols,
                gap: g,
                children: c,
            } = &mut node.kind
            else {
                return Err(mismatch());
            };
            if let Some(v) = columns {
                *cols = v;
            }
            gap.apply(g);
            if let Some(v) = children {
                *c = v;
            }
        }
        PropsPatch::Card { title, subtitle, children } => {
            let NodeKind::Card {
                title: t,
                subtitle: sub,
                children: c,
            } = &mut node.kind
            else {
                return Err(mismatch());
            };
            title.apply(t);
            subtitle.apply(sub);
            if let Some(v) = children {
                *c = v;
            }
        }
        PropsPatch::Tabs { bind, tabs } => {
            let NodeKind::Tabs { bind: b, tabs: t } = &mut node.kind else {
                return Err(mismatch());
            };
            if let Some(v) = bind {
                *b = v;
            }
            if let Some(v) = tabs {
                *t = v;
            }
        }
        PropsPatch::Divider { label } => {
            let NodeKind::Divider { label: l } = &mut node.kind else {
                return Err(mismatch());
            };
            label.apply(l);
        }
        PropsPatch::Text { value, tone, size } => {
            let NodeKind::Text { value: v, tone: t, size: s } = &mut node.kind else {
                return Err(mismatch());
            };
            if let Some(nv) = value {
                *v = nv;
            }
            if let Some(nt) = tone {
                *t = nt;
            }
            if let Some(ns) = size {
                *s = ns;
            }
        }
        PropsPatch::Markdown { text } => {
            let NodeKind::Markdown { text: t } = &mut node.kind else {
                return Err(mismatch());
            };
            if let Some(v) = text {
                *t = v;
            }
        }
        PropsPatch::Metric { label, value, delta, format } => {
            let NodeKind::Metric {
                label: l,
                value: v,
                delta: d,
                format: f,
            } = &mut node.kind
            else {
                return Err(mismatch());
            };
            if let Some(nl) = label {
                *l = nl;
            }
            if let Some(nv) = value {
                *v = nv;
            }
            delta.apply(d);
            format.apply(f);
        }
        PropsPatch::Badge { label, tone } => {
            let NodeKind::Badge { label: l, tone: t } = &mut node.kind else {
                return Err(mismatch());
            };
            if let Some(nl) = label {
                *l = nl;
            }
            if let Some(nt) = tone {
                *t = nt;
            }
        }
        PropsPatch::Progress { value, max, label } => {
            let NodeKind::Progress { value: v, max: m, label: l } = &mut node.kind else {
                return Err(mismatch());
            };
            if let Some(nv) = value {
                *v = nv;
            }
            if let Some(nm) = max {
                *m = nm;
            }
            label.apply(l);
        }
        PropsPatch::Callout { callout_kind, title, body } => {
            let NodeKind::Callout {
                callout_kind: k,
                title: t,
                body: b,
            } = &mut node.kind
            else {
                return Err(mismatch());
            };
            if let Some(nk) = callout_kind {
                *k = nk;
            }
            title.apply(t);
            if let Some(nb) = body {
                *b = nb;
            }
        }
        PropsPatch::Table { columns, rows } => {
            let NodeKind::Table { columns: c, rows: r } = &mut node.kind else {
                return Err(mismatch());
            };
            if let Some(nc) = columns {
                *c = nc;
            }
            if let Some(nr) = rows {
                *r = nr;
            }
        }
        PropsPatch::Slider {
            bind,
            label,
            min,
            max,
            step,
            unit,
        } => {
            let NodeKind::Slider {
                bind: b,
                label: l,
                min: lo,
                max: hi,
                step: st,
                unit: u,
            } = &mut node.kind
            else {
                return Err(mismatch());
            };
            if let Some(nb) = bind {
                *b = nb;
            }
            if let Some(nl) = label {
                *l = nl;
            }
            if let Some(nlo) = min {
                *lo = nlo;
            }
            if let Some(nhi) = max {
                *hi = nhi;
            }
            if let Some(nst) = step {
                *st = nst;
            }
            unit.apply(u);
        }
        PropsPatch::Switch { bind, label } => {
            let NodeKind::Switch { bind: b, label: l } = &mut node.kind else {
                return Err(mismatch());
            };
            if let Some(nb) = bind {
                *b = nb;
            }
            if let Some(nl) = label {
                *l = nl;
            }
        }
        PropsPatch::Select { bind, label, options } => {
            let NodeKind::Select {
                bind: b,
                label: l,
                options: opts,
            } = &mut node.kind
            else {
                return Err(mismatch());
            };
            if let Some(nb) = bind {
                *b = nb;
            }
            if let Some(nl) = label {
                *l = nl;
            }
            if let Some(nopts) = options {
                *opts = nopts;
            }
        }
        PropsPatch::Chart {
            title,
            subtitle,
            width,
            height,
            source,
        } => {
            let NodeKind::Chart {
                title: t,
                subtitle: sub,
                width: w,
                height: h,
                source: src,
            } = &mut node.kind
            else {
                return Err(mismatch());
            };
            title.apply(t);
            subtitle.apply(sub);
            width.apply(w);
            height.apply(h);
            if let Some(nsrc) = source {
                *src = nsrc;
            }
        }
        PropsPatch::Diagram { source } => {
            let NodeKind::Diagram { source: s } = &mut node.kind else {
                return Err(mismatch());
            };
            if let Some(ns) = source {
                *s = ns;
            }
        }
        PropsPatch::Canvas { data } => {
            let NodeKind::Canvas { data: d } = &mut node.kind else {
                return Err(mismatch());
            };
            if let Some(nd) = data {
                *d = nd;
            }
        }
        PropsPatch::CodeBlock { code, language } => {
            let NodeKind::CodeBlock { code: c, language: lang } = &mut node.kind else {
                return Err(mismatch());
            };
            if let Some(nc) = code {
                *c = nc;
            }
            language.apply(lang);
        }
    }
    Ok(())
}

fn detach_children(kind: &mut NodeKind, removed: &BTreeSet<String>) -> bool {
    match kind {
        NodeKind::Stack { children, .. } | NodeKind::Grid { children, .. } | NodeKind::Card { children, .. } => {
            let before = children.len();
            children.retain(|c| !removed.contains(c));
            children.len() != before
        }
        NodeKind::Tabs { tabs, .. } => {
            let mut changed = false;
            for tab in tabs {
                let before = tab.children.len();
                tab.children.retain(|c| !removed.contains(c));
                if tab.children.len() != before {
                    changed = true;
                }
            }
            changed
        }
        NodeKind::Divider { .. }
        | NodeKind::Text { .. }
        | NodeKind::Markdown { .. }
        | NodeKind::Metric { .. }
        | NodeKind::Badge { .. }
        | NodeKind::Progress { .. }
        | NodeKind::Callout { .. }
        | NodeKind::Table { .. }
        | NodeKind::Slider { .. }
        | NodeKind::Switch { .. }
        | NodeKind::Select { .. }
        | NodeKind::Chart { .. }
        | NodeKind::Diagram { .. }
        | NodeKind::Canvas { .. }
        | NodeKind::CodeBlock { .. } => false,
    }
}

fn collect_node_dependencies(node: &GenUiNode, limits: EvalLimits) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    if let Some(vis) = &node.visible {
        collect_expr_source_deps(vis, limits, &mut keys);
    }
    match &node.kind {
        NodeKind::Stack { .. } | NodeKind::Grid { .. } => {}
        NodeKind::Card { title, subtitle, .. } => {
            if let Some(t) = title {
                collect_text_expr_deps(t, limits, &mut keys);
            }
            if let Some(sub) = subtitle {
                collect_text_expr_deps(sub, limits, &mut keys);
            }
        }
        NodeKind::Tabs { bind, tabs } => {
            keys.insert(bind.clone());
            for tab in tabs {
                collect_text_expr_deps(&tab.label, limits, &mut keys);
            }
        }
        NodeKind::Divider { label } => {
            if let Some(l) = label {
                collect_text_expr_deps(l, limits, &mut keys);
            }
        }
        NodeKind::Text { value, .. } => collect_text_expr_deps(value, limits, &mut keys),
        NodeKind::Markdown { text } => collect_text_expr_deps(text, limits, &mut keys),
        NodeKind::Metric { label, value, delta, .. } => {
            collect_text_expr_deps(label, limits, &mut keys);
            collect_value_expr_deps(value, limits, &mut keys);
            if let Some(d) = delta {
                collect_text_expr_deps(d, limits, &mut keys);
            }
        }
        NodeKind::Badge { label, .. } => collect_text_expr_deps(label, limits, &mut keys),
        NodeKind::Progress { value, max, label } => {
            collect_value_expr_deps(value, limits, &mut keys);
            collect_value_expr_deps(max, limits, &mut keys);
            if let Some(l) = label {
                collect_text_expr_deps(l, limits, &mut keys);
            }
        }
        NodeKind::Callout { title, body, .. } => {
            if let Some(t) = title {
                collect_text_expr_deps(t, limits, &mut keys);
            }
            collect_text_expr_deps(body, limits, &mut keys);
        }
        NodeKind::Table { columns, rows } => {
            for col in columns {
                collect_text_expr_deps(&col.label, limits, &mut keys);
            }
            match rows {
                TableRows::Static(static_rows) => {
                    for row in static_rows {
                        for cell in row {
                            collect_text_expr_deps(cell, limits, &mut keys);
                        }
                    }
                }
                TableRows::Expr(src) => collect_expr_source_deps(src, limits, &mut keys),
            }
        }
        NodeKind::Slider { bind, label, .. } | NodeKind::Switch { bind, label } => {
            keys.insert(bind.clone());
            collect_text_expr_deps(label, limits, &mut keys);
        }
        NodeKind::Select { bind, label, options } => {
            keys.insert(bind.clone());
            collect_text_expr_deps(label, limits, &mut keys);
            for opt in options {
                collect_text_expr_deps(&opt.label, limits, &mut keys);
            }
        }
        NodeKind::Chart { title, subtitle, source, .. } => {
            if let Some(t) = title {
                collect_text_expr_deps(t, limits, &mut keys);
            }
            if let Some(sub) = subtitle {
                collect_text_expr_deps(sub, limits, &mut keys);
            }
            match source {
                ChartSource::Template { template } => collect_text_expr_deps(template, limits, &mut keys),
                ChartSource::Reactive {
                    x_label,
                    y_label,
                    categories,
                    series,
                    ..
                } => {
                    if let Some(xl) = x_label {
                        collect_text_expr_deps(xl, limits, &mut keys);
                    }
                    if let Some(yl) = y_label {
                        collect_text_expr_deps(yl, limits, &mut keys);
                    }
                    match categories {
                        CategoryBinding::Static(items) => {
                            for item in items {
                                collect_text_expr_deps(item, limits, &mut keys);
                            }
                        }
                        CategoryBinding::Expr(src) => collect_expr_source_deps(src, limits, &mut keys),
                    }
                    for s in series {
                        collect_text_expr_deps(&s.name, limits, &mut keys);
                        match &s.values {
                            SeriesValuesBinding::Static(_) => {}
                            SeriesValuesBinding::Expr(src) => collect_expr_source_deps(src, limits, &mut keys),
                        }
                    }
                }
            }
        }
        NodeKind::Diagram { source } => collect_text_expr_deps(source, limits, &mut keys),
        NodeKind::Canvas { data } => collect_text_expr_deps(data, limits, &mut keys),
        NodeKind::CodeBlock { code, .. } => collect_text_expr_deps(code, limits, &mut keys),
    }
    keys
}

fn collect_expr_source_deps(src: &ExprSource, limits: EvalLimits, keys: &mut BTreeSet<String>) {
    if let Ok(expr) = parse_expr_with_limits(src.as_str(), limits) {
        keys.extend(referenced_keys(&expr));
    }
}

fn collect_text_expr_deps(text: &TextExpr, limits: EvalLimits, keys: &mut BTreeSet<String>) {
    if let Ok(tpl) = parse_template_with_limits(text.as_str(), limits) {
        keys.extend(template_referenced_keys(&tpl));
    }
}

fn collect_value_expr_deps(val: &ValueExpr, limits: EvalLimits, keys: &mut BTreeSet<String>) {
    match val {
        ValueExpr::Literal(_) => {}
        ValueExpr::Expr(src) => collect_expr_source_deps(src, limits, keys),
        ValueExpr::Template(tpl) => collect_text_expr_deps(tpl, limits, keys),
    }
}

fn extract_numeric_or_record(node_id: &str, field: &str, value: &StateValue, fallback: f64, diagnostics: &mut Vec<ResolveDiagnostic>) -> f64 {
    match value {
        StateValue::Number(n) if n.is_finite() => *n,
        StateValue::Null => fallback,
        StateValue::Number(_) | StateValue::Bool(_) | StateValue::Text(_) | StateValue::List(_) | StateValue::Record(_) => {
            diagnostics.push(ResolveDiagnostic {
                node_id: node_id.to_owned(),
                field: field.to_owned(),
                error: GenUiError::TypeMismatch {
                    context: format!("progress {field}"),
                    expected: "number".to_owned(),
                    actual: value.type_name().to_owned(),
                },
            });
            fallback
        }
    }
}

fn format_table_cell(node_id: &str, column_key: &str, value: &StateValue, format: Option<FormatKind>, diagnostics: &mut Vec<ResolveDiagnostic>) -> String {
    match format {
        Some(fmt) => match format_value(value, fmt, None) {
            Ok(rendered) => rendered,
            Err(error) => {
                diagnostics.push(ResolveDiagnostic {
                    node_id: node_id.to_owned(),
                    field: format!("table.{column_key}"),
                    error,
                });
                value.to_display_string()
            }
        },
        None => value.to_display_string(),
    }
}
