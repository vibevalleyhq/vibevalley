use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::engine::whiteboard::model::{
    AnchorSide, ArrowCurve, ArrowEndpoint, ArrowHead, ElementId, Point2, PresenceViewport, Rect2, ShapeKind, StrokeStyle, TextAlign, TextVariant,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WhiteboardEntryKind {
    Text,
    Json,
    Asset,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WhiteboardEntryOp {
    Set,
    Patch,
    Delete,
    Copy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhiteboardEntry {
    #[serde(alias = "artifactId", alias = "artifact_id", default)]
    pub note_id: String,
    pub path: String,
    pub kind: WhiteboardEntryKind,
    pub mime: String,
    pub size: i64,
    pub rev: i64,
    pub updated_by: String,
    pub updated: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhiteboardWriteInput {
    pub op: WhiteboardEntryOp,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<WhiteboardEntryKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub if_rev: Option<i64>,
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum CodecError {
    #[error("json error: {0}")]
    Json(String),
    #[error("missing element id at path {0}")]
    MissingId(String),
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct WireMeta {
    pub(super) title: Option<String>,
    pub(super) grid: Option<GridWire>,
    pub(super) background: Option<String>,
    #[serde(flatten)]
    pub(super) extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub(super) enum GridWire {
    Bool(bool),
    Name(String),
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct WirePresence {
    pub(super) id: Option<String>,
    pub(super) name: Option<String>,
    pub(super) color: Option<String>,
    pub(super) kind: Option<String>,
    pub(super) x: Option<f64>,
    pub(super) y: Option<f64>,
    pub(super) w: Option<f64>,
    pub(super) h: Option<f64>,
    pub(super) status: Option<String>,
    #[serde(default)]
    pub(super) selected_ids: Vec<String>,
    pub(super) viewport: Option<PresenceViewport>,
    pub(super) updated_at: Option<i64>,
    #[serde(default)]
    pub(super) hide_label: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub(super) enum WireEndpoint {
    Bound { id: String, side: Option<String> },
    Free { x: f64, y: f64 },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WireMilestone {
    pub(super) t: Option<f64>,
    pub(super) x: Option<f64>,
    pub(super) y: Option<f64>,
    #[serde(default)]
    pub(super) label: String,
    pub(super) kind: Option<String>,
    pub(super) tone: Option<String>,
    pub(super) caption: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(super) struct WirePoint {
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) pressure: Option<f32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct WireElement {
    pub(super) id: Option<String>,
    #[serde(rename = "type", default)]
    pub(super) kind_name: String,
    pub(super) shape: Option<String>,
    pub(super) variant: Option<String>,
    pub(super) x: Option<f64>,
    pub(super) y: Option<f64>,
    pub(super) w: Option<f64>,
    pub(super) h: Option<f64>,
    pub(super) z: Option<i32>,
    pub(super) locked: Option<bool>,
    pub(super) group_id: Option<String>,
    pub(super) parent_id: Option<String>,
    pub(super) rotation: Option<f64>,
    pub(super) opacity: Option<f32>,
    pub(super) label: Option<String>,
    pub(super) text: Option<String>,
    pub(super) title: Option<String>,
    pub(super) body: Option<String>,
    pub(super) subtitle: Option<String>,
    pub(super) highlight: Option<String>,
    pub(super) icon: Option<String>,
    pub(super) badge: Option<String>,
    pub(super) align: Option<String>,
    pub(super) font_size: Option<f32>,
    pub(super) fill: Option<String>,
    pub(super) color: Option<String>,
    pub(super) stroke: Option<String>,
    pub(super) stroke_width: Option<f32>,
    pub(super) corner_radius: Option<f32>,
    pub(super) sticker: Option<String>,
    pub(super) sticker_svg: Option<String>,
    pub(super) svg: Option<String>,
    pub(super) html: Option<String>,
    pub(super) attachment_id: Option<String>,
    pub(super) uri: Option<String>,
    pub(super) alt: Option<String>,
    pub(super) crop: Option<Rect2>,
    pub(super) collapsed: Option<bool>,
    pub(super) curve: Option<String>,
    pub(super) style: Option<String>,
    pub(super) head: Option<String>,
    pub(super) start_head: Option<String>,
    pub(super) end_head: Option<String>,
    pub(super) from: Option<WireEndpoint>,
    pub(super) to: Option<WireEndpoint>,
    pub(super) bends: Option<Vec<WirePoint>>,
    pub(super) points: Option<Vec<WirePoint>>,
    pub(super) milestones: Option<Vec<WireMilestone>>,
    pub(super) headers: Option<Vec<String>>,
    pub(super) rows: Option<Vec<Vec<String>>>,
    pub(super) mode: Option<String>,
    pub(super) agent_id: Option<String>,
    pub(super) status: Option<String>,
    #[serde(flatten)]
    pub(super) extra: BTreeMap<String, Value>,
}

pub(super) fn compact_json(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let cleaned: serde_json::Map<String, Value> = map.into_iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k, compact_json(v))).collect();
            Value::Object(cleaned)
        }
        Value::Array(arr) => Value::Array(arr.into_iter().map(compact_json).collect()),
        other => other,
    }
}

pub(super) fn json_merge_diff(before: &Value, after: &Value) -> Value {
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

pub(super) fn decode_endpoint(ep: Option<WireEndpoint>) -> Option<ArrowEndpoint> {
    match ep? {
        WireEndpoint::Bound { id, side } => Some(ArrowEndpoint::Bound {
            id: ElementId::new(id),
            side: side.as_deref().and_then(AnchorSide::parse),
        }),
        WireEndpoint::Free { x, y } => Some(ArrowEndpoint::Free(Point2::new(x, y))),
    }
}

pub(super) fn encode_endpoint(ep: &ArrowEndpoint) -> WireEndpoint {
    match ep {
        ArrowEndpoint::Bound { id, side } => WireEndpoint::Bound {
            id: id.0.clone(),
            side: side.map(|s| s.as_str().to_owned()),
        },
        ArrowEndpoint::Free(pt) => WireEndpoint::Free { x: pt.x, y: pt.y },
    }
}

pub(super) fn parse_align(raw: Option<&str>) -> TextAlign {
    match raw.map(str::trim).unwrap_or("center").to_ascii_lowercase().as_str() {
        "left" => TextAlign::Left,
        "right" => TextAlign::Right,
        _ => TextAlign::Center,
    }
}

pub(super) fn align_str(align: TextAlign) -> &'static str {
    match align {
        TextAlign::Left => "left",
        TextAlign::Center => "center",
        TextAlign::Right => "right",
    }
}

pub(super) fn parse_text_variant(raw: Option<&str>) -> TextVariant {
    match raw.map(str::trim).unwrap_or("body").to_ascii_lowercase().as_str() {
        "title" => TextVariant::Title,
        "subtitle" => TextVariant::Subtitle,
        "callout" => TextVariant::Callout,
        _ => TextVariant::Body,
    }
}

pub(super) fn text_variant_str(v: TextVariant) -> &'static str {
    match v {
        TextVariant::Title => "title",
        TextVariant::Subtitle => "subtitle",
        TextVariant::Callout => "callout",
        TextVariant::Body => "body",
    }
}

pub(super) fn parse_shape_kind(raw: &str) -> ShapeKind {
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

pub(super) fn shape_str(s: ShapeKind) -> &'static str {
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

pub(super) fn parse_stroke_style(raw: Option<&str>) -> StrokeStyle {
    match raw.map(str::trim).unwrap_or("solid").to_ascii_lowercase().as_str() {
        "dashed" => StrokeStyle::Dashed,
        "dotted" => StrokeStyle::Dotted,
        _ => StrokeStyle::Solid,
    }
}

pub(super) fn stroke_style_str(s: StrokeStyle) -> &'static str {
    match s {
        StrokeStyle::Solid => "solid",
        StrokeStyle::Dashed => "dashed",
        StrokeStyle::Dotted => "dotted",
    }
}

pub(super) fn parse_arrow_curve(raw: Option<&str>) -> ArrowCurve {
    match raw.map(str::trim).unwrap_or("smooth").to_ascii_lowercase().as_str() {
        "orthogonal" | "ortho" => ArrowCurve::Orthogonal,
        "straight" => ArrowCurve::Straight,
        _ => ArrowCurve::Smooth,
    }
}

pub(super) fn parse_arrow_head(raw: Option<&str>, fallback: ArrowHead) -> ArrowHead {
    match raw.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("none") => ArrowHead::None,
        Some("diamond") => ArrowHead::Diamond,
        Some("dot") => ArrowHead::Dot,
        Some("arrow") => ArrowHead::Arrow,
        _ => fallback,
    }
}

pub(super) fn head_str(h: ArrowHead) -> &'static str {
    match h {
        ArrowHead::Arrow => "arrow",
        ArrowHead::None => "none",
        ArrowHead::Diamond => "diamond",
        ArrowHead::Dot => "dot",
    }
}
