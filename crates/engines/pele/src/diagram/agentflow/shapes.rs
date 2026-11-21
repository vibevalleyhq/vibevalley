use crate::diagram::flowchart::is_valid_shape as is_flowchart_shape;

use super::types::DiagnosticId;

pub const DEFAULT_SHAPE: &str = "roundedRect";

pub fn resolve_shape_alias(shape: &str) -> &str {
    match shape {
        "task" => "roundedRect",
        "tool" => "subroutine",
        "input" => "lean-right",
        "decision" => "diamond",
        "refdoc" => "lin-doc",
        "action" => "hexagon",
        "round" => "rect",
        other => other,
    }
}

pub fn is_removed_shape(shape: &str) -> bool {
    matches!(
        shape,
        "doc"
            | "stadium"
            | "terminal"
            | "circle"
            | "trapezoid"
            | "inv_trapezoid"
            | "inv-trapezoid"
            | "doublecircle"
            | "double-circle"
            | "typeDeclaration"
            | "procs"
            | "lean_left"
            | "lean-left"
            | "in-out"
            | "cylinder"
            | "ellipse"
            | "odd"
            | "tag-rect"
            | "tagged-rectangle"
            | "delay"
            | "half-rounded-rectangle"
            | "lin-rect"
            | "lined-rectangle"
            | "win-pane"
            | "window-pane"
            | "curv-trap"
            | "curved-trapezoid"
    )
}

pub fn is_allowed_shape(shape: &str) -> bool {
    matches!(
        shape,
        "roundedRect"
            | "subroutine"
            | "subprocess"
            | "subproc"
            | "framed-rectangle"
            | "lean-right"
            | "diamond"
            | "lin-doc"
            | "lined-document"
            | "hexagon"
            | "hex"
            | "connector"
            | "collapsedGroup"
    )
}

/// Mermaid looks a shape name up with `in` on a plain object, so `constructor` passes there too.
pub fn is_valid_shape(name: &str) -> bool {
    is_flowchart_shape(name) || name == "constructor"
}

pub trait ShapeSink {
    fn emit_shape_error(&mut self, id: DiagnosticId, message: String, node_id: &str);
    fn emit_shape_warning(&mut self, id: DiagnosticId, message: String, node_id: &str);
}

pub trait ShapedNode {
    fn id(&self) -> &str;
    fn is_group(&self) -> bool;
    fn shape(&self) -> &str;
    fn set_shape(&mut self, shape: String);
}

/// Reduces every node's shape to one agentflow draws, reporting removed and unsupported ones.
pub fn normalise_node_shapes<N: ShapedNode, S: ShapeSink>(nodes: &mut [N], sink: &mut S) {
    for node in nodes {
        if node.is_group() {
            continue;
        }
        let cur = node.shape();
        if cur.is_empty() || cur == "squareRect" || cur == "rect" {
            node.set_shape(DEFAULT_SHAPE.to_string());
        }
        let shape = node.shape().to_string();
        if is_removed_shape(&shape) {
            let id = node.id().to_string();
            sink.emit_shape_error(
                DiagnosticId::ShapeRemoved,
                format!(r#"shape "{shape}" was removed in v0.8.1, using "{DEFAULT_SHAPE}""#),
                &id,
            );
            node.set_shape(DEFAULT_SHAPE.to_string());
        } else if !is_allowed_shape(&shape) {
            let id = node.id().to_string();
            sink.emit_shape_warning(
                DiagnosticId::ShapeUnsupported,
                format!(r#"shape "{shape}" is not supported, using "{DEFAULT_SHAPE}""#),
                &id,
            );
            node.set_shape(DEFAULT_SHAPE.to_string());
        }
    }
}
