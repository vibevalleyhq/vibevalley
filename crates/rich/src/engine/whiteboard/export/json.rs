use std::collections::BTreeSet;

use crate::engine::canvas::{Canvas, CanvasColor, Edge, End, Node as CanvasNode, NodeBounds, PresetColor, Side};
use crate::engine::whiteboard::codec::encode_element_json;
use crate::engine::whiteboard::model::{AnchorSide, ArrowEndpoint, ArrowHead, BoardDoc, ElementId, ElementKind, WbFill};

pub fn export_json(doc: &BoardDoc) -> Result<String, serde_json::Error> {
    let elements: Vec<serde_json::Value> = doc
        .elements
        .iter()
        .filter_map(|el| serde_json::from_str(&encode_element_json(el)).ok())
        .collect();
    let payload = serde_json::json!({
        "meta": doc.meta,
        "elements": elements,
        "presences": doc.presences,
        "seq": doc.seq,
    });
    serde_json::to_string_pretty(&payload)
}

pub fn export_json_canvas(doc: &BoardDoc) -> Result<String, serde_json::Error> {
    let mut canvas = Canvas::new();
    let lookup = doc.rect_lookup();
    let mut valid_nodes: BTreeSet<ElementId> = BTreeSet::new();

    for el in &doc.elements {
        match &el.kind {
            ElementKind::Container { x, y, w, h, title, fill, .. } => {
                let bounds = NodeBounds::new(x.round() as i64, y.round() as i64, w.max(40.0).round() as i64, h.max(40.0).round() as i64);
                let mut node = CanvasNode::group(el.id.as_str(), bounds, (!title.is_empty()).then(|| title.clone()));
                if let Some(c) = wb_fill_to_canvas(fill) {
                    node = node.with_color(c);
                }
                valid_nodes.insert(el.id.clone());
                canvas.nodes.push(node);
            }
            ElementKind::Shape {
                x, y, w, h, title, body, fill, ..
            } => {
                let bounds = NodeBounds::new(x.round() as i64, y.round() as i64, w.max(40.0).round() as i64, h.max(40.0).round() as i64);
                let text = match (title.trim().is_empty(), body.trim().is_empty()) {
                    (false, false) => format!("{title}\n{body}"),
                    (false, true) => title.clone(),
                    (true, false) => body.clone(),
                    (true, true) => String::new(),
                };
                let mut node = CanvasNode::text(el.id.as_str(), bounds, text);
                if let Some(c) = wb_fill_to_canvas(fill) {
                    node = node.with_color(c);
                }
                valid_nodes.insert(el.id.clone());
                canvas.nodes.push(node);
            }
            ElementKind::Text { x, y, w, h, label, fill, .. } => {
                let bounds = NodeBounds::new(x.round() as i64, y.round() as i64, w.max(40.0).round() as i64, h.max(32.0).round() as i64);
                let mut node = CanvasNode::text(el.id.as_str(), bounds, label.clone());
                if let Some(f) = fill
                    && let Some(c) = wb_fill_to_canvas(f)
                {
                    node = node.with_color(c);
                }
                valid_nodes.insert(el.id.clone());
                canvas.nodes.push(node);
            }
            ElementKind::Table {
                x,
                y,
                w,
                h,
                headers,
                rows,
                fill,
            } => {
                let bounds = NodeBounds::new(x.round() as i64, y.round() as i64, w.max(80.0).round() as i64, h.max(60.0).round() as i64);
                let mut md = headers.join(" | ");
                for row in rows {
                    md.push('\n');
                    md.push_str(&row.join(" | "));
                }
                let mut node = CanvasNode::text(el.id.as_str(), bounds, md);
                if let Some(c) = wb_fill_to_canvas(fill) {
                    node = node.with_color(c);
                }
                valid_nodes.insert(el.id.clone());
                canvas.nodes.push(node);
            }
            ElementKind::Claim { x, y, w, h, label, .. } => {
                let bounds = NodeBounds::new(x.round() as i64, y.round() as i64, w.max(40.0).round() as i64, h.max(40.0).round() as i64);
                valid_nodes.insert(el.id.clone());
                canvas
                    .nodes
                    .push(CanvasNode::text(el.id.as_str(), bounds, label.clone()).with_color(CanvasColor::preset(PresetColor::Red)));
            }
            _ => {}
        }
    }

    for el in &doc.elements {
        if let ElementKind::Arrow {
            from,
            to,
            start_head,
            end_head,
            label,
            ..
        } = &el.kind
            && let ArrowEndpoint::Bound { id: fid, side: fside } = from
            && let ArrowEndpoint::Bound { id: tid, side: tside } = to
            && valid_nodes.contains(fid)
            && valid_nodes.contains(tid)
        {
            let mut edge = Edge::new(el.id.as_str(), fid.as_str(), tid.as_str())
                .with_sides(fside.map(map_anchor_side), tside.map(map_anchor_side))
                .with_ends(Some(map_head(*start_head)), Some(map_head(*end_head)));
            if let Some(lbl) = label {
                edge = edge.with_label(lbl);
            }
            canvas.edges.push(edge);
        }
    }

    let _ = lookup;
    serde_json::to_string_pretty(&canvas)
}

fn wb_fill_to_canvas(fill: &WbFill) -> Option<CanvasColor> {
    match fill {
        WbFill::Berry => Some(CanvasColor::preset(PresetColor::Red)),
        WbFill::Peach => Some(CanvasColor::preset(PresetColor::Orange)),
        WbFill::Sun => Some(CanvasColor::preset(PresetColor::Yellow)),
        WbFill::Leaf => Some(CanvasColor::preset(PresetColor::Green)),
        WbFill::Water => Some(CanvasColor::preset(PresetColor::Cyan)),
        WbFill::Lavender => Some(CanvasColor::preset(PresetColor::Purple)),
        WbFill::Custom(h) => CanvasColor::hex(h).ok(),
        WbFill::Default | WbFill::Side => None,
    }
}

fn map_anchor_side(side: AnchorSide) -> Side {
    match side {
        AnchorSide::N => Side::Top,
        AnchorSide::E => Side::Right,
        AnchorSide::S => Side::Bottom,
        AnchorSide::W => Side::Left,
    }
}

fn map_head(head: ArrowHead) -> End {
    match head {
        ArrowHead::None => End::None,
        ArrowHead::Arrow | ArrowHead::Diamond | ArrowHead::Dot => End::Arrow,
    }
}
