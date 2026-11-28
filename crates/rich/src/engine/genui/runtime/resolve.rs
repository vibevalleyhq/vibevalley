use std::collections::BTreeSet;

use crate::engine::genui::error::GenUiError;
use crate::engine::genui::expr::{eval_expr, eval_template, parse_expr_with_limits, parse_template_with_limits};
use crate::engine::genui::resolved::{
    ResolveDiagnostic, ResolvedChart, ResolvedChartContent, ResolvedChartSeries, ResolvedDoc, ResolvedNode, ResolvedNodeKind, ResolvedReactiveChart,
    ResolvedSelectOption, ResolvedTab, ResolvedTableColumn, ResolvedTableRow,
};
use crate::engine::genui::spec::{Align, CategoryBinding, ChartSource, ExprSource, NodeKind, SeriesValuesBinding, TableRows, TextAlign, TextExpr, ValueExpr};
use crate::engine::genui::value::{FormatKind, StateValue, format_value};

use super::state::GenUiRuntime;

impl GenUiRuntime {
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
