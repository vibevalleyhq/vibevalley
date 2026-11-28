use std::collections::HashMap;

use crate::engine::canvas::{Canvas, CanvasColor, End, Node as CanvasNode, PresetColor, Side};
use crate::engine::whiteboard::model::{
    AnchorSide, ArrowCurve, ArrowEndpoint, ArrowHead, BoardDoc, ElementId, ElementKind, ElementRecord, Rect2, ShapeKind, StrokeStyle, TextAlign, WbFill,
};

pub fn import_json_canvas(canvas: &Canvas, title: impl Into<String>) -> BoardDoc {
    let mut doc = BoardDoc::new(title);
    let mut z_idx = 1i32;

    for node in &canvas.nodes {
        let mut el = match node {
            CanvasNode::Group(g) => ElementRecord::new(
                g.id.as_str(),
                ElementKind::Container {
                    x: g.x as f64,
                    y: g.y as f64,
                    w: g.width as f64,
                    h: g.height as f64,
                    title: g.label.clone().unwrap_or_default(),
                    fill: g.color.as_ref().map_or(WbFill::Side, map_canvas_color),
                    stroke: None,
                    collapsed: false,
                },
            ),
            CanvasNode::Text(t) => ElementRecord::new(
                t.id.as_str(),
                ElementKind::Shape {
                    x: t.x as f64,
                    y: t.y as f64,
                    w: t.width as f64,
                    h: t.height as f64,
                    shape: ShapeKind::Card,
                    title: t.text.lines().next().unwrap_or("").to_owned(),
                    body: t.text.lines().skip(1).collect::<Vec<_>>().join("\n"),
                    fill: t.color.as_ref().map_or(WbFill::Sun, map_canvas_color),
                    stroke: None,
                    stroke_style: StrokeStyle::Solid,
                    corner_radius: None,
                    sticker: None,
                    sticker_svg: None,
                    badge: None,
                    align: TextAlign::Center,
                },
            ),
            CanvasNode::File(f) => ElementRecord::new(
                f.id.as_str(),
                ElementKind::Shape {
                    x: f.x as f64,
                    y: f.y as f64,
                    w: f.width as f64,
                    h: f.height as f64,
                    shape: ShapeKind::Card,
                    title: f.file.clone(),
                    body: f.subpath.clone().unwrap_or_default(),
                    fill: f.color.as_ref().map_or(WbFill::Water, map_canvas_color),
                    stroke: None,
                    stroke_style: StrokeStyle::Solid,
                    corner_radius: None,
                    sticker: Some("chart-board".to_owned()),
                    sticker_svg: None,
                    badge: Some("FILE".to_owned()),
                    align: TextAlign::Center,
                },
            ),
            CanvasNode::Link(l) => ElementRecord::new(
                l.id.as_str(),
                ElementKind::Shape {
                    x: l.x as f64,
                    y: l.y as f64,
                    w: l.width as f64,
                    h: l.height as f64,
                    shape: ShapeKind::Card,
                    title: l.url.clone(),
                    body: String::new(),
                    fill: l.color.as_ref().map_or(WbFill::Lavender, map_canvas_color),
                    stroke: None,
                    stroke_style: StrokeStyle::Solid,
                    corner_radius: None,
                    sticker: None,
                    sticker_svg: None,
                    badge: Some("LINK".to_owned()),
                    align: TextAlign::Center,
                },
            ),
        };
        el.z = z_idx;
        z_idx += 1;
        doc.elements.push(el);
    }

    for edge in &canvas.edges {
        let mut el = ElementRecord::new(
            edge.id.as_str(),
            ElementKind::Arrow {
                from: ArrowEndpoint::Bound {
                    id: ElementId::new(edge.from_node.as_str()),
                    side: edge.from_side.map(map_canvas_side),
                },
                to: ArrowEndpoint::Bound {
                    id: ElementId::new(edge.to_node.as_str()),
                    side: edge.to_side.map(map_canvas_side),
                },
                bends: Vec::new(),
                curve: ArrowCurve::Smooth,
                style: StrokeStyle::Solid,
                start_head: map_canvas_end(edge.from_end, ArrowHead::None),
                end_head: map_canvas_end(edge.to_end, ArrowHead::Arrow),
                stroke: edge.color.as_ref().map(|c| match c {
                    CanvasColor::Preset(p) => match p {
                        PresetColor::Red => "#a83a2c".to_owned(),
                        PresetColor::Orange => "#c96e52".to_owned(),
                        PresetColor::Yellow => "#c77c1e".to_owned(),
                        PresetColor::Green => "#4d7a2a".to_owned(),
                        PresetColor::Cyan => "#2f6fa8".to_owned(),
                        PresetColor::Purple => "#7c5cdb".to_owned(),
                    },
                    CanvasColor::Hex(h) => h.clone(),
                }),
                stroke_width: 1.75,
                label: edge.label.clone(),
            },
        );
        el.z = z_idx;
        z_idx += 1;
        doc.elements.push(el);
    }

    let lookup: HashMap<ElementId, Rect2> = doc.rect_lookup();
    let containers: Vec<(ElementId, Rect2)> = doc
        .elements
        .iter()
        .filter(|e| e.is_container())
        .filter_map(|e| lookup.get(&e.id).map(|r| (e.id.clone(), *r)))
        .collect();
    for el in &mut doc.elements {
        if el.is_container() || el.is_arrow() {
            continue;
        }
        if let Some(r) = lookup.get(&el.id) {
            let center = r.center();
            if let Some((cid, _)) = containers.iter().rev().find(|(_, cr)| cr.contains_point(center)) {
                el.parent_id = Some(cid.clone());
            }
        }
    }

    doc
}

fn map_canvas_color(color: &CanvasColor) -> WbFill {
    match color {
        CanvasColor::Preset(PresetColor::Red) => WbFill::Berry,
        CanvasColor::Preset(PresetColor::Orange) => WbFill::Peach,
        CanvasColor::Preset(PresetColor::Yellow) => WbFill::Sun,
        CanvasColor::Preset(PresetColor::Green) => WbFill::Leaf,
        CanvasColor::Preset(PresetColor::Cyan) => WbFill::Water,
        CanvasColor::Preset(PresetColor::Purple) => WbFill::Lavender,
        CanvasColor::Hex(h) => WbFill::Custom(h.clone()),
    }
}

fn map_canvas_side(side: Side) -> AnchorSide {
    match side {
        Side::Top => AnchorSide::N,
        Side::Right => AnchorSide::E,
        Side::Bottom => AnchorSide::S,
        Side::Left => AnchorSide::W,
    }
}

fn map_canvas_end(end: Option<End>, default_head: ArrowHead) -> ArrowHead {
    match end {
        Some(End::None) => ArrowHead::None,
        Some(End::Arrow) => ArrowHead::Arrow,
        None => default_head,
    }
}
