use crate::engine::genui::error::GenUiError;
use crate::engine::genui::spec::{GenUiNode, NodeKind};
use crate::engine::genui::value::StateValue;

pub(super) fn validate_state_value(value: &StateValue) -> Result<(), GenUiError> {
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

pub(super) fn validate_node(node: &GenUiNode) -> Result<(), GenUiError> {
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
