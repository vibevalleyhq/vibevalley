use std::collections::BTreeMap;

use serde_json::Value;

use crate::engine::whiteboard::model::{
    ArrowCurve, ArrowHead, BoardMeta, ElementId, ElementKind, ElementRecord, GridStyle, InkMode, MilestoneKind, Presence, PresenceKind, StrokeStyle, TextAlign,
};

use super::wire::{
    GridWire, WhiteboardEntryKind, WhiteboardEntryOp, WhiteboardWriteInput, WireElement, WireMeta, WireMilestone, WirePoint, WirePresence, align_str,
    compact_json, encode_endpoint, head_str, json_merge_diff, shape_str, stroke_style_str, text_variant_str,
};

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

pub fn encode_element_write(el: &ElementRecord, include_if_rev: bool) -> WhiteboardWriteInput {
    WhiteboardWriteInput {
        op: WhiteboardEntryOp::Set,
        path: format!("elements/{}", el.id),
        kind: Some(WhiteboardEntryKind::Json),
        value: Some(encode_element_json(el)),
        from: None,
        mime: None,
        if_rev: (include_if_rev && el.rev > 0).then_some(el.rev),
    }
}

pub fn encode_element_patch(before: &ElementRecord, after: &ElementRecord, include_if_rev: bool) -> WhiteboardWriteInput {
    let prev = compact_json(encode_element_value(before));
    let next = compact_json(encode_element_value(after));
    let diff = json_merge_diff(&prev, &next);
    WhiteboardWriteInput {
        op: WhiteboardEntryOp::Patch,
        path: format!("elements/{}", after.id),
        kind: Some(WhiteboardEntryKind::Json),
        value: Some(serde_json::to_string(&diff).unwrap_or_else(|_| "{}".to_owned())),
        from: None,
        mime: None,
        if_rev: (include_if_rev && before.rev > 0).then_some(before.rev),
    }
}

pub fn encode_element_delete(id: &ElementId, rev: i64, include_if_rev: bool) -> WhiteboardWriteInput {
    WhiteboardWriteInput {
        op: WhiteboardEntryOp::Delete,
        path: format!("elements/{id}"),
        kind: None,
        value: None,
        from: None,
        mime: None,
        if_rev: (include_if_rev && rev > 0).then_some(rev),
    }
}

pub fn encode_meta_write(meta: &BoardMeta) -> WhiteboardWriteInput {
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
    WhiteboardWriteInput {
        op: WhiteboardEntryOp::Set,
        path: "board/meta".to_owned(),
        kind: Some(WhiteboardEntryKind::Json),
        value: Some(serde_json::to_string(&compact_json(serde_json::to_value(wire).unwrap_or(Value::Null))).unwrap_or_else(|_| "{}".to_owned())),
        from: None,
        mime: None,
        if_rev: None,
    }
}

pub fn encode_presence_write(presence: &Presence) -> WhiteboardWriteInput {
    let wire = WirePresence {
        id: Some(presence.id.clone()),
        name: Some(presence.name.clone()),
        color: Some(presence.custom_color.clone().unwrap_or_else(|| presence.color.as_str().to_owned())),
        kind: (presence.kind != PresenceKind::Cursor).then(|| presence.kind.as_str().to_owned()),
        x: Some(presence.x),
        y: Some(presence.y),
        w: presence.w,
        h: presence.h,
        status: presence.status.clone(),
        selected_ids: presence.selected_ids.iter().map(|i| i.0.clone()).collect(),
        viewport: presence.viewport,
        updated_at: presence.updated_at,
        hide_label: presence.hide_label,
    };
    WhiteboardWriteInput {
        op: WhiteboardEntryOp::Set,
        path: format!("presence/{}", presence.id),
        kind: Some(WhiteboardEntryKind::Json),
        value: Some(serde_json::to_string(&compact_json(serde_json::to_value(wire).unwrap_or(Value::Null))).unwrap_or_else(|_| "{}".to_owned())),
        from: None,
        mime: None,
        if_rev: None,
    }
}
