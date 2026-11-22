use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use vibevalley_protocol::{ArtifactEntry, ArtifactEntryKind, ArtifactEntryOp, ArtifactEntryWriteInput};

use crate::engine::canvas::{Canvas, CanvasColor, End, Node as CanvasNode, PresetColor, Side};
use crate::engine::whiteboard::model::{
    AnchorSide, ArrowCurve, ArrowEndpoint, ArrowHead, BoardDoc, BoardMeta, ElementId, ElementKind, ElementRecord, ExtraFields, GridStyle, InkMode,
    MilestoneKind, Point2, Presence, PresenceColor, Rect2, ShapeKind, StrokePoint, StrokeStyle, TextAlign, TextVariant, TimelineMilestone, WbFill,
};

#[derive(Debug, Clone, thiserror::Error)]
pub enum CodecError {
    #[error("json error: {0}")]
    Json(String),
    #[error("missing element id at path {0}")]
    MissingId(String),
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct WireMeta {
    title: Option<String>,
    grid: Option<GridWire>,
    background: Option<String>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
enum GridWire {
    Bool(bool),
    Name(String),
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct WirePresence {
    id: Option<String>,
    name: Option<String>,
    color: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    status: Option<String>,
    #[serde(default)]
    selected_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
enum WireEndpoint {
    Bound { id: String, side: Option<String> },
    Free { x: f64, y: f64 },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireMilestone {
    t: Option<f64>,
    x: Option<f64>,
    y: Option<f64>,
    #[serde(default)]
    label: String,
    kind: Option<String>,
    tone: Option<String>,
    caption: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct WirePoint {
    x: f64,
    y: f64,
    pressure: Option<f32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct WireElement {
    id: Option<String>,
    #[serde(rename = "type", default)]
    kind_name: String,
    shape: Option<String>,
    variant: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    w: Option<f64>,
    h: Option<f64>,
    z: Option<i32>,
    locked: Option<bool>,
    group_id: Option<String>,
    parent_id: Option<String>,
    rotation: Option<f64>,
    opacity: Option<f32>,
    label: Option<String>,
    text: Option<String>,
    title: Option<String>,
    body: Option<String>,
    subtitle: Option<String>,
    highlight: Option<String>,
    icon: Option<String>,
    badge: Option<String>,
    align: Option<String>,
    font_size: Option<f32>,
    fill: Option<String>,
    color: Option<String>,
    stroke: Option<String>,
    stroke_width: Option<f32>,
    corner_radius: Option<f32>,
    sticker: Option<String>,
    sticker_svg: Option<String>,
    svg: Option<String>,
    html: Option<String>,
    attachment_id: Option<String>,
    uri: Option<String>,
    alt: Option<String>,
    crop: Option<Rect2>,
    collapsed: Option<bool>,
    curve: Option<String>,
    style: Option<String>,
    head: Option<String>,
    start_head: Option<String>,
    end_head: Option<String>,
    from: Option<WireEndpoint>,
    to: Option<WireEndpoint>,
    bends: Option<Vec<WirePoint>>,
    points: Option<Vec<WirePoint>>,
    milestones: Option<Vec<WireMilestone>>,
    headers: Option<Vec<String>>,
    rows: Option<Vec<Vec<String>>>,
    mode: Option<String>,
    agent_id: Option<String>,
    status: Option<String>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

pub fn decode_board_entries(entries: &[ArtifactEntry], seq: i64) -> BoardDoc {
    let mut doc = BoardDoc { seq, ..BoardDoc::default() };

    for entry in entries {
        let Some(raw) = entry.value.as_deref() else {
            continue;
        };
        if entry.path == "board/meta" {
            if let Ok(meta) = decode_meta(raw) {
                doc.meta = meta;
            }
        } else if let Some(path_id) = entry.path.strip_prefix("elements/") {
            if let Ok(mut el) = decode_element(path_id, entry.rev, raw) {
                if el.z == 0 {
                    el.z = (doc.elements.len() + 1) as i32;
                }
                doc.elements.push(el);
            }
        } else if let Some(path_id) = entry.path.strip_prefix("presence/")
            && let Ok(p) = decode_presence(path_id, entry.rev, raw)
        {
            doc.presences.push(p);
        }
    }
    doc.sort_by_z();
    doc
}

pub fn decode_meta(raw: &str) -> Result<BoardMeta, CodecError> {
    let wire: WireMeta = serde_json::from_str(raw).map_err(|e| CodecError::Json(e.to_string()))?;
    let grid = match wire.grid {
        Some(GridWire::Bool(false)) => GridStyle::None,
        Some(GridWire::Bool(true)) | None => GridStyle::Architectural,
        Some(GridWire::Name(s)) => match s.trim().to_ascii_lowercase().as_str() {
            "dots" | "dot" => GridStyle::Dots,
            "none" | "off" | "false" => GridStyle::None,
            _ => GridStyle::Architectural,
        },
    };
    Ok(BoardMeta {
        title: wire.title.unwrap_or_default(),
        grid,
        background: wire.background,
    })
}

pub fn decode_presence(fallback_id: &str, rev: i64, raw: &str) -> Result<Presence, CodecError> {
    let wire: WirePresence = serde_json::from_str(raw).map_err(|e| CodecError::Json(e.to_string()))?;
    let id = wire.id.filter(|s| !s.is_empty()).unwrap_or_else(|| fallback_id.to_owned());
    Ok(Presence {
        name: wire.name.filter(|s| !s.is_empty()).unwrap_or_else(|| id.clone()),
        id,
        color: PresenceColor::from_wire(wire.color.as_deref().unwrap_or("coral")),
        x: wire.x.unwrap_or(0.0),
        y: wire.y.unwrap_or(0.0),
        status: wire.status,
        selected_ids: wire.selected_ids.into_iter().map(ElementId::from).collect(),
        rev,
    })
}

pub fn decode_element(fallback_id: &str, rev: i64, raw: &str) -> Result<ElementRecord, CodecError> {
    let wire: WireElement = serde_json::from_str(raw).map_err(|e| CodecError::Json(e.to_string()))?;
    let id_str = wire.id.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| fallback_id.to_owned());
    if id_str.is_empty() {
        return Err(CodecError::MissingId(fallback_id.to_owned()));
    }
    let align = parse_align(wire.align.as_deref());
    let fill = WbFill::from_wire(wire.fill.as_deref().unwrap_or("default"));
    let x = wire.x.unwrap_or(80.0);
    let y = wire.y.unwrap_or(80.0);
    let w = wire.w.unwrap_or(188.0);
    let h = wire.h.unwrap_or(92.0);
    let stroke_style = parse_stroke_style(wire.style.as_deref());
    let type_key = wire.kind_name.trim().to_ascii_lowercase();

    let kind = match type_key.as_str() {
        "text" | "callout" => {
            let variant = if type_key == "callout" {
                TextVariant::Callout
            } else {
                parse_text_variant(wire.variant.as_deref())
            };
            ElementKind::Text {
                x,
                y,
                w: wire.w.unwrap_or(if variant == TextVariant::Callout { 240.0 } else { 420.0 }),
                h: wire.h.unwrap_or(44.0),
                variant,
                label: wire.label.or(wire.text).or(wire.title).unwrap_or_default(),
                highlight: wire.highlight,
                icon: wire.icon,
                align: wire.align.as_deref().map_or(TextAlign::Left, |a| parse_align(Some(a))),
                font_size: wire.font_size,
                fill: wire.fill.as_deref().map(WbFill::from_wire),
                color: wire.color,
            }
        }
        "container" | "frame" | "group" => ElementKind::Container {
            x,
            y,
            w: wire.w.unwrap_or(460.0),
            h: wire.h.unwrap_or(300.0),
            title: wire.title.or(wire.label).or(wire.text).unwrap_or_default(),
            fill: wire.fill.as_deref().map_or(WbFill::Side, WbFill::from_wire),
            stroke: wire.stroke,
            collapsed: wire.collapsed.unwrap_or(false),
        },
        "timeline" => ElementKind::Timeline {
            x,
            y,
            w: wire.w.unwrap_or(760.0),
            h: wire.h.unwrap_or(92.0),
            fill: wire.fill.as_deref().map_or(WbFill::Peach, WbFill::from_wire),
            points: wire.points.unwrap_or_default().into_iter().map(|p| Point2::new(p.x, p.y)).collect(),
            milestones: wire
                .milestones
                .unwrap_or_default()
                .into_iter()
                .map(|m| TimelineMilestone {
                    t: m.t,
                    pos: m.x.zip(m.y).map(|(mx, my)| Point2::new(mx, my)),
                    label: m.label,
                    kind: match m.kind.as_deref() {
                        Some("minor") => MilestoneKind::Minor,
                        _ => MilestoneKind::Major,
                    },
                    tone: m.tone,
                    caption: m.caption,
                })
                .collect(),
        },
        "arrow" | "connector" => {
            let from = decode_endpoint(wire.from).unwrap_or(ArrowEndpoint::Free(Point2::new(x, y)));
            let to = decode_endpoint(wire.to).unwrap_or(ArrowEndpoint::Free(Point2::new(x + 140.0, y)));
            let end_head = parse_arrow_head(wire.end_head.as_deref().or(wire.head.as_deref()), ArrowHead::Arrow);
            let start_head = parse_arrow_head(wire.start_head.as_deref(), ArrowHead::None);
            ElementKind::Arrow {
                from,
                to,
                bends: wire.bends.unwrap_or_default().into_iter().map(|p| Point2::new(p.x, p.y)).collect(),
                curve: parse_arrow_curve(wire.curve.as_deref()),
                style: stroke_style,
                start_head,
                end_head,
                stroke: wire.stroke,
                stroke_width: wire.stroke_width.unwrap_or(1.75),
                label: wire.label.or(wire.text),
            }
        }
        "path" => ElementKind::Path {
            points: wire
                .points
                .unwrap_or_default()
                .into_iter()
                .map(|p| StrokePoint::new(p.x, p.y, p.pressure.unwrap_or(0.5)))
                .collect(),
            stroke: wire.stroke.unwrap_or_else(|| "#a83a2c".to_owned()),
            stroke_width: wire.stroke_width.unwrap_or(3.0),
            mode: match wire.mode.as_deref() {
                Some("highlighter") => InkMode::Highlighter,
                _ => InkMode::Pen,
            },
        },
        "sticker" => ElementKind::Sticker {
            x,
            y,
            w: wire.w.unwrap_or(72.0),
            h: wire.h.unwrap_or(72.0),
            sticker: wire.sticker.unwrap_or_else(|| "sparkles".to_owned()),
            svg: wire.svg,
            label: wire.label.or(wire.title),
        },
        "svg" => ElementKind::Svg {
            x,
            y,
            w: wire.w.unwrap_or(120.0),
            h: wire.h.unwrap_or(90.0),
            svg: wire.svg.unwrap_or_default(),
            label: wire.label.or(wire.title),
        },
        "image" => ElementKind::Image {
            x,
            y,
            w: wire.w.unwrap_or(240.0),
            h: wire.h.unwrap_or(180.0),
            attachment_id: wire.attachment_id,
            uri: wire.uri.unwrap_or_default(),
            alt: wire.alt.or(wire.label),
            crop: wire.crop,
        },
        "table" => ElementKind::Table {
            x,
            y,
            w: wire.w.unwrap_or(360.0),
            h: wire.h.unwrap_or(160.0),
            headers: wire.headers.unwrap_or_default(),
            rows: wire.rows.unwrap_or_default(),
            fill,
        },
        "claim" => ElementKind::Claim {
            x,
            y,
            w: wire.w.unwrap_or(220.0),
            h: wire.h.unwrap_or(120.0),
            label: wire.label.or(wire.title).unwrap_or_else(|| "Editing".to_owned()),
            agent_id: wire.agent_id,
            status: wire.status,
        },
        "html" => ElementKind::HtmlEmbed {
            x,
            y,
            w: wire.w.unwrap_or(280.0),
            h: wire.h.unwrap_or(180.0),
            html: wire.html.unwrap_or_default(),
            title: wire.title.or(wire.label),
        },
        _ => {
            let shape_name = wire.shape.as_deref().unwrap_or(
                if matches!(
                    type_key.as_str(),
                    "sticky" | "card" | "rect" | "rounded" | "diamond" | "ellipse" | "pill" | "triangle" | "cylinder"
                ) {
                    type_key.as_str()
                } else {
                    "card"
                },
            );
            let shape = parse_shape_kind(shape_name);
            let title = wire.title.or(wire.label).or(wire.text).unwrap_or_default();
            let body = wire.body.or(wire.subtitle).unwrap_or_default();
            let resolved_fill = if wire.fill.is_none() && matches!(shape, ShapeKind::Card | ShapeKind::Sticky) {
                WbFill::Sun
            } else {
                fill
            };
            ElementKind::Shape {
                x,
                y,
                w,
                h,
                shape,
                title,
                body,
                fill: resolved_fill,
                stroke: wire.stroke,
                stroke_style,
                corner_radius: wire.corner_radius,
                sticker: wire.sticker,
                sticker_svg: wire.sticker_svg,
                badge: wire.badge,
                align,
            }
        }
    };

    Ok(ElementRecord {
        id: ElementId::new(id_str),
        rev,
        z: wire.z.unwrap_or(0),
        locked: wire.locked.unwrap_or(false),
        group_id: wire.group_id,
        parent_id: wire.parent_id.filter(|s| !s.is_empty()).map(ElementId::new),
        rotation_deg: wire.rotation.unwrap_or(0.0),
        opacity: wire.opacity.unwrap_or(1.0).clamp(0.05, 1.0),
        kind,
        extra: ExtraFields(wire.extra),
    })
}

pub fn encode_element_value(el: &ElementRecord) -> Value {
    let mut wire = WireElement {
        id: Some(el.id.0.clone()),
        z: (el.z != 0).then_some(el.z),
        locked: el.locked.then_some(true),
        group_id: el.group_id.clone(),
        parent_id: el.parent_id.as_ref().map(|p| p.0.clone()),
        rotation: (el.rotation_deg.abs() > 1e-4).then_some(el.rotation_deg),
        opacity: ((el.opacity - 1.0).abs() > 1e-3).then_some(el.opacity),
        extra: el.extra.0.clone(),
        ..Default::default()
    };

    match &el.kind {
        ElementKind::Text {
            x,
            y,
            w,
            h,
            variant,
            label,
            highlight,
            icon,
            align,
            font_size,
            fill,
            color,
        } => {
            wire.kind_name = "text".to_owned();
            wire.variant = Some(text_variant_str(*variant).to_owned());
            wire.x = Some(*x);
            wire.y = Some(*y);
            wire.w = Some(*w);
            wire.h = Some(*h);
            wire.label = Some(label.clone());
            wire.highlight = highlight.clone();
            wire.icon = icon.clone();
            wire.align = Some(align_str(*align).to_owned());
            wire.font_size = *font_size;
            wire.fill = fill.as_ref().map(|f| f.as_str().to_owned());
            wire.color = color.clone();
        }
        ElementKind::Shape {
            x,
            y,
            w,
            h,
            shape,
            title,
            body,
            fill,
            stroke,
            stroke_style,
            corner_radius,
            sticker,
            sticker_svg,
            badge,
            align,
        } => {
            wire.kind_name = "shape".to_owned();
            wire.shape = Some(shape_str(*shape).to_owned());
            wire.x = Some(*x);
            wire.y = Some(*y);
            wire.w = Some(*w);
            wire.h = Some(*h);
            if !title.is_empty() {
                wire.title = Some(title.clone());
            }
            if !body.is_empty() {
                wire.body = Some(body.clone());
            }
            wire.fill = Some(fill.as_str().to_owned());
            wire.stroke = stroke.clone();
            if *stroke_style != StrokeStyle::Solid {
                wire.style = Some(stroke_style_str(*stroke_style).to_owned());
            }
            wire.corner_radius = *corner_radius;
            wire.sticker = sticker.clone();
            wire.sticker_svg = sticker_svg.clone();
            wire.badge = badge.clone();
            if *align != TextAlign::Center {
                wire.align = Some(align_str(*align).to_owned());
            }
        }
        ElementKind::Container {
            x,
            y,
            w,
            h,
            title,
            fill,
            stroke,
            collapsed,
        } => {
            wire.kind_name = "container".to_owned();
            wire.x = Some(*x);
            wire.y = Some(*y);
            wire.w = Some(*w);
            wire.h = Some(*h);
            wire.title = Some(title.clone());
            wire.fill = Some(fill.as_str().to_owned());
            wire.stroke = stroke.clone();
            wire.collapsed = (*collapsed).then_some(true);
        }
        ElementKind::Timeline {
            x,
            y,
            w,
            h,
            fill,
            points,
            milestones,
        } => {
            wire.kind_name = "timeline".to_owned();
            wire.x = Some(*x);
            wire.y = Some(*y);
            wire.w = Some(*w);
            wire.h = Some(*h);
            wire.fill = Some(fill.as_str().to_owned());
            wire.points = Some(
                points
                    .iter()
                    .map(|p| WirePoint {
                        x: p.x,
                        y: p.y,
                        pressure: None,
                    })
                    .collect(),
            );
            wire.milestones = Some(
                milestones
                    .iter()
                    .map(|m| WireMilestone {
                        t: m.t,
                        x: m.pos.map(|p| p.x),
                        y: m.pos.map(|p| p.y),
                        label: m.label.clone(),
                        kind: Some(match m.kind {
                            MilestoneKind::Major => "major".to_owned(),
                            MilestoneKind::Minor => "minor".to_owned(),
                        }),
                        tone: m.tone.clone(),
                        caption: m.caption.clone(),
                    })
                    .collect(),
            );
        }
        ElementKind::Arrow {
            from,
            to,
            bends,
            curve,
            style,
            start_head,
            end_head,
            stroke,
            stroke_width,
            label,
        } => {
            wire.kind_name = "arrow".to_owned();
            wire.from = Some(encode_endpoint(from));
            wire.to = Some(encode_endpoint(to));
            if !bends.is_empty() {
                wire.bends = Some(
                    bends
                        .iter()
                        .map(|p| WirePoint {
                            x: p.x,
                            y: p.y,
                            pressure: None,
                        })
                        .collect(),
                );
            }
            wire.curve = Some(match curve {
                ArrowCurve::Smooth => "smooth".to_owned(),
                ArrowCurve::Orthogonal => "orthogonal".to_owned(),
                ArrowCurve::Straight => "straight".to_owned(),
            });
            if *style != StrokeStyle::Solid {
                wire.style = Some(stroke_style_str(*style).to_owned());
            }
            if *start_head != ArrowHead::None {
                wire.start_head = Some(head_str(*start_head).to_owned());
            }
            wire.head = Some(head_str(*end_head).to_owned());
            wire.stroke = stroke.clone();
            if (*stroke_width - 1.75).abs() > 1e-2 {
                wire.stroke_width = Some(*stroke_width);
            }
            wire.label = label.clone();
        }
        ElementKind::Path {
            points,
            stroke,
            stroke_width,
            mode,
        } => {
            wire.kind_name = "path".to_owned();
            wire.points = Some(
                points
                    .iter()
                    .map(|p| WirePoint {
                        x: p.x,
                        y: p.y,
                        pressure: Some(p.pressure),
                    })
                    .collect(),
            );
            wire.stroke = Some(stroke.clone());
            wire.stroke_width = Some(*stroke_width);
            if *mode != InkMode::Pen {
                wire.mode = Some("highlighter".to_owned());
            }
        }
        ElementKind::Sticker {
            x,
            y,
            w,
            h,
            sticker,
            svg,
            label,
        } => {
            wire.kind_name = "sticker".to_owned();
            wire.x = Some(*x);
            wire.y = Some(*y);
            wire.w = Some(*w);
            wire.h = Some(*h);
            wire.sticker = Some(sticker.clone());
            wire.svg = svg.clone();
            wire.label = label.clone();
        }
        ElementKind::Svg { x, y, w, h, svg, label } => {
            wire.kind_name = "svg".to_owned();
            wire.x = Some(*x);
            wire.y = Some(*y);
            wire.w = Some(*w);
            wire.h = Some(*h);
            wire.svg = Some(svg.clone());
            wire.label = label.clone();
        }
        ElementKind::Image {
            x,
            y,
            w,
            h,
            attachment_id,
            uri,
            alt,
            crop,
        } => {
            wire.kind_name = "image".to_owned();
            wire.x = Some(*x);
            wire.y = Some(*y);
            wire.w = Some(*w);
            wire.h = Some(*h);
            wire.attachment_id = attachment_id.clone();
            wire.uri = Some(uri.clone());
            wire.alt = alt.clone();
            wire.crop = *crop;
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
            wire.kind_name = "table".to_owned();
            wire.x = Some(*x);
            wire.y = Some(*y);
            wire.w = Some(*w);
            wire.h = Some(*h);
            wire.headers = Some(headers.clone());
            wire.rows = Some(rows.clone());
            wire.fill = Some(fill.as_str().to_owned());
        }
        ElementKind::Claim {
            x,
            y,
            w,
            h,
            label,
            agent_id,
            status,
        } => {
            wire.kind_name = "claim".to_owned();
            wire.x = Some(*x);
            wire.y = Some(*y);
            wire.w = Some(*w);
            wire.h = Some(*h);
            wire.label = Some(label.clone());
            wire.agent_id = agent_id.clone();
            wire.status = status.clone();
        }
        ElementKind::HtmlEmbed { x, y, w, h, html, title } => {
            wire.kind_name = "html".to_owned();
            wire.x = Some(*x);
            wire.y = Some(*y);
            wire.w = Some(*w);
            wire.h = Some(*h);
            wire.html = Some(html.clone());
            wire.title = title.clone();
        }
    }

    serde_json::to_value(wire).unwrap_or(Value::Null)
}

pub fn encode_element_json(el: &ElementRecord) -> String {
    serde_json::to_string(&compact_json(encode_element_value(el))).unwrap_or_else(|_| "{}".to_owned())
}

pub fn encode_element_write(el: &ElementRecord, include_if_rev: bool) -> ArtifactEntryWriteInput {
    ArtifactEntryWriteInput {
        op: ArtifactEntryOp::Set,
        path: format!("elements/{}", el.id),
        kind: Some(ArtifactEntryKind::Json),
        value: Some(encode_element_json(el)),
        from: None,
        mime: None,
        if_rev: (include_if_rev && el.rev > 0).then_some(el.rev),
    }
}

pub fn encode_element_patch(before: &ElementRecord, after: &ElementRecord, include_if_rev: bool) -> ArtifactEntryWriteInput {
    let prev = compact_json(encode_element_value(before));
    let next = compact_json(encode_element_value(after));
    let diff = json_merge_diff(&prev, &next);
    ArtifactEntryWriteInput {
        op: ArtifactEntryOp::Patch,
        path: format!("elements/{}", after.id),
        kind: Some(ArtifactEntryKind::Json),
        value: Some(serde_json::to_string(&diff).unwrap_or_else(|_| "{}".to_owned())),
        from: None,
        mime: None,
        if_rev: (include_if_rev && before.rev > 0).then_some(before.rev),
    }
}

pub fn encode_element_delete(id: &ElementId, rev: i64, include_if_rev: bool) -> ArtifactEntryWriteInput {
    ArtifactEntryWriteInput {
        op: ArtifactEntryOp::Delete,
        path: format!("elements/{id}"),
        kind: None,
        value: None,
        from: None,
        mime: None,
        if_rev: (include_if_rev && rev > 0).then_some(rev),
    }
}

pub fn encode_meta_write(meta: &BoardMeta) -> ArtifactEntryWriteInput {
    let grid = match meta.grid {
        GridStyle::Architectural => "architectural",
        GridStyle::Dots => "dots",
        GridStyle::None => "none",
    };
    let wire = WireMeta {
        title: Some(meta.title.clone()),
        grid: Some(GridWire::Name(grid.to_owned())),
        background: meta.background.clone(),
        extra: BTreeMap::new(),
    };
    ArtifactEntryWriteInput {
        op: ArtifactEntryOp::Set,
        path: "board/meta".to_owned(),
        kind: Some(ArtifactEntryKind::Json),
        value: Some(serde_json::to_string(&compact_json(serde_json::to_value(wire).unwrap_or(Value::Null))).unwrap_or_else(|_| "{}".to_owned())),
        from: None,
        mime: None,
        if_rev: None,
    }
}

pub fn encode_presence_write(presence: &Presence) -> ArtifactEntryWriteInput {
    let wire = WirePresence {
        id: Some(presence.id.clone()),
        name: Some(presence.name.clone()),
        color: Some(presence.color.as_str().to_owned()),
        x: Some(presence.x),
        y: Some(presence.y),
        status: presence.status.clone(),
        selected_ids: presence.selected_ids.iter().map(|i| i.0.clone()).collect(),
    };
    ArtifactEntryWriteInput {
        op: ArtifactEntryOp::Set,
        path: format!("presence/{}", presence.id),
        kind: Some(ArtifactEntryKind::Json),
        value: Some(serde_json::to_string(&compact_json(serde_json::to_value(wire).unwrap_or(Value::Null))).unwrap_or_else(|_| "{}".to_owned())),
        from: None,
        mime: None,
        if_rev: None,
    }
}

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

fn compact_json(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let cleaned: serde_json::Map<String, Value> = map.into_iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k, compact_json(v))).collect();
            Value::Object(cleaned)
        }
        Value::Array(arr) => Value::Array(arr.into_iter().map(compact_json).collect()),
        other => other,
    }
}

fn json_merge_diff(before: &Value, after: &Value) -> Value {
    let (Value::Object(prev), Value::Object(next)) = (before, after) else {
        return after.clone();
    };
    let mut patch = serde_json::Map::new();
    for k in prev.keys() {
        if !next.contains_key(k) {
            patch.insert(k.clone(), Value::Null);
        }
    }
    for (k, next_v) in next {
        match prev.get(k) {
            Some(prev_v) if prev_v == next_v => {}
            Some(prev_v) if prev_v.is_object() && next_v.is_object() => {
                patch.insert(k.clone(), json_merge_diff(prev_v, next_v));
            }
            _ => {
                patch.insert(k.clone(), next_v.clone());
            }
        }
    }
    Value::Object(patch)
}

fn decode_endpoint(ep: Option<WireEndpoint>) -> Option<ArrowEndpoint> {
    match ep? {
        WireEndpoint::Bound { id, side } => Some(ArrowEndpoint::Bound {
            id: ElementId::new(id),
            side: side.as_deref().and_then(AnchorSide::parse),
        }),
        WireEndpoint::Free { x, y } => Some(ArrowEndpoint::Free(Point2::new(x, y))),
    }
}

fn encode_endpoint(ep: &ArrowEndpoint) -> WireEndpoint {
    match ep {
        ArrowEndpoint::Bound { id, side } => WireEndpoint::Bound {
            id: id.0.clone(),
            side: side.map(|s| s.as_str().to_owned()),
        },
        ArrowEndpoint::Free(pt) => WireEndpoint::Free { x: pt.x, y: pt.y },
    }
}

fn parse_align(raw: Option<&str>) -> TextAlign {
    match raw.map(str::trim).unwrap_or("center").to_ascii_lowercase().as_str() {
        "left" => TextAlign::Left,
        "right" => TextAlign::Right,
        _ => TextAlign::Center,
    }
}

fn align_str(align: TextAlign) -> &'static str {
    match align {
        TextAlign::Left => "left",
        TextAlign::Center => "center",
        TextAlign::Right => "right",
    }
}

fn parse_text_variant(raw: Option<&str>) -> TextVariant {
    match raw.map(str::trim).unwrap_or("body").to_ascii_lowercase().as_str() {
        "title" => TextVariant::Title,
        "subtitle" => TextVariant::Subtitle,
        "callout" => TextVariant::Callout,
        _ => TextVariant::Body,
    }
}

fn text_variant_str(v: TextVariant) -> &'static str {
    match v {
        TextVariant::Title => "title",
        TextVariant::Subtitle => "subtitle",
        TextVariant::Callout => "callout",
        TextVariant::Body => "body",
    }
}

fn parse_shape_kind(raw: &str) -> ShapeKind {
    match raw.trim().to_ascii_lowercase().as_str() {
        "sticky" => ShapeKind::Sticky,
        "rect" => ShapeKind::Rect,
        "rounded" => ShapeKind::Rounded,
        "diamond" => ShapeKind::Diamond,
        "ellipse" | "circle" => ShapeKind::Ellipse,
        "pill" => ShapeKind::Pill,
        "triangle" => ShapeKind::Triangle,
        "cylinder" => ShapeKind::Cylinder,
        _ => ShapeKind::Card,
    }
}

fn shape_str(s: ShapeKind) -> &'static str {
    match s {
        ShapeKind::Card => "card",
        ShapeKind::Sticky => "sticky",
        ShapeKind::Rect => "rect",
        ShapeKind::Rounded => "rounded",
        ShapeKind::Diamond => "diamond",
        ShapeKind::Ellipse => "ellipse",
        ShapeKind::Pill => "pill",
        ShapeKind::Triangle => "triangle",
        ShapeKind::Cylinder => "cylinder",
    }
}

fn parse_stroke_style(raw: Option<&str>) -> StrokeStyle {
    match raw.map(str::trim).unwrap_or("solid").to_ascii_lowercase().as_str() {
        "dashed" => StrokeStyle::Dashed,
        "dotted" => StrokeStyle::Dotted,
        _ => StrokeStyle::Solid,
    }
}

fn stroke_style_str(s: StrokeStyle) -> &'static str {
    match s {
        StrokeStyle::Solid => "solid",
        StrokeStyle::Dashed => "dashed",
        StrokeStyle::Dotted => "dotted",
    }
}

fn parse_arrow_curve(raw: Option<&str>) -> ArrowCurve {
    match raw.map(str::trim).unwrap_or("smooth").to_ascii_lowercase().as_str() {
        "orthogonal" | "ortho" => ArrowCurve::Orthogonal,
        "straight" => ArrowCurve::Straight,
        _ => ArrowCurve::Smooth,
    }
}

fn parse_arrow_head(raw: Option<&str>, fallback: ArrowHead) -> ArrowHead {
    match raw.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("none") => ArrowHead::None,
        Some("diamond") => ArrowHead::Diamond,
        Some("dot") => ArrowHead::Dot,
        Some("arrow") => ArrowHead::Arrow,
        _ => fallback,
    }
}

fn head_str(h: ArrowHead) -> &'static str {
    match h {
        ArrowHead::Arrow => "arrow",
        ArrowHead::None => "none",
        ArrowHead::Diamond => "diamond",
        ArrowHead::Dot => "dot",
    }
}
