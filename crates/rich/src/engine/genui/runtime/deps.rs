use std::collections::BTreeSet;

use crate::engine::genui::error::GenUiError;
use crate::engine::genui::expr::{EvalLimits, parse_expr_with_limits, parse_template_with_limits, referenced_keys, template_referenced_keys};
use crate::engine::genui::spec::{CategoryBinding, ChartSource, ExprSource, GenUiNode, NodeKind, SeriesValuesBinding, TableRows, TextExpr, ValueExpr};

use super::state::GenUiRuntime;

impl GenUiRuntime {
    pub(super) fn reindex_node_deps(&mut self, node: &GenUiNode) {
        self.remove_node_deps(&node.id);
        let deps = collect_node_dependencies(node, self.limits.eval);
        for key in &deps {
            self.key_dependents.entry(key.clone()).or_default().insert(node.id.clone());
        }
        self.node_deps.insert(node.id.clone(), deps);
    }

    pub(super) fn remove_node_deps(&mut self, node_id: &str) {
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

    pub(super) fn ensure_acyclic(&self, node_id: &str, candidate_children: &[String]) -> Result<(), GenUiError> {
        self.ensure_acyclic_with_override(node_id, candidate_children, None)
    }

    pub(super) fn ensure_acyclic_with_override(&self, node_id: &str, candidate_children: &[String], extra_node: Option<&GenUiNode>) -> Result<(), GenUiError> {
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
