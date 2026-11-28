use crate::engine::whiteboard::model::{
    ArrowEndpoint, ArrowHead, BoardDoc, BoardMeta, ElementId, ElementKind, ElementRecord, ExtraFields, GridStyle, InkMode, MilestoneKind, Point2, Presence,
    PresenceColor, PresenceKind, PresenceViewport, ShapeKind, StrokePoint, TextAlign, TextVariant, TimelineMilestone, WbFill,
};

use super::wire::{
    CodecError, GridWire, WhiteboardEntry, WireElement, WireMeta, WirePresence, decode_endpoint, parse_align, parse_arrow_curve, parse_arrow_head,
    parse_shape_kind, parse_stroke_style, parse_text_variant,
};

pub fn decode_board_entries(entries: &[WhiteboardEntry], seq: i64) -> BoardDoc {
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

fn sanitize_viewport(raw: Option<PresenceViewport>) -> Option<PresenceViewport> {
    let vp = raw?;
    if !vp.x.is_finite() || !vp.y.is_finite() || !vp.w.is_finite() || !vp.h.is_finite() || vp.w <= 1.0 || vp.h <= 1.0 {
        return None;
    }
    Some(PresenceViewport {
        x: vp.x,
        y: vp.y,
        w: vp.w,
        h: vp.h,
        zoom: vp.zoom.filter(|z| z.is_finite() && *z > 0.0),
    })
}

fn is_valid_hex_color(raw: &str) -> bool {
    let Some(hex) = raw.trim().strip_prefix('#') else {
        return false;
    };
    matches!(hex.len(), 3 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit())
}

fn presence_from_wire(fallback_id: &str, rev: i64, wire: WirePresence, default_xy: (f64, f64)) -> Option<Presence> {
    let id = wire.id.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| fallback_id.to_owned());
    if id.trim().is_empty() {
        return None;
    }
    let name = wire.name.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| id.clone());
    let kind = wire.kind.as_deref().map_or(PresenceKind::Cursor, PresenceKind::from_wire);
    let raw_x = wire.x.filter(|v| v.is_finite());
    let raw_y = wire.y.filter(|v| v.is_finite());
    let raw_w = wire.w.filter(|v| v.is_finite() && *v > 1.0);
    let raw_h = wire.h.filter(|v| v.is_finite() && *v > 1.0);

    let mut viewport = sanitize_viewport(wire.viewport);
    if kind == PresenceKind::Viewport
        && viewport.is_none()
        && let (Some(x), Some(y), Some(w), Some(h)) = (raw_x, raw_y, raw_w, raw_h)
    {
        viewport = Some(PresenceViewport { x, y, w, h, zoom: None });
    }

    let (x, y) = match (raw_x, raw_y) {
        (Some(x), Some(y)) => (x, y),
        (x_opt, y_opt) => {
            if let Some(vp) = viewport {
                let c = vp.center();
                (x_opt.unwrap_or(c.x), y_opt.unwrap_or(c.y))
            } else {
                (x_opt.unwrap_or(default_xy.0), y_opt.unwrap_or(default_xy.1))
            }
        }
    };

    let has_cursor = (raw_x.is_some() && raw_y.is_some()) || (kind != PresenceKind::Viewport && viewport.is_none());
    let custom_color = wire.color.as_deref().filter(|c| is_valid_hex_color(c)).map(|c| c.trim().to_owned());
    let color = PresenceColor::from_wire(wire.color.as_deref().unwrap_or("coral"));

    Some(Presence {
        id,
        name,
        color,
        custom_color,
        kind,
        x,
        y,
        w: raw_w,
        h: raw_h,
        status: wire.status.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()),
        selected_ids: wire.selected_ids.into_iter().map(ElementId::from).collect(),
        viewport,
        updated_at: wire.updated_at,
        has_cursor,
        rev,
    })
}

pub fn decode_presence(fallback_id: &str, rev: i64, raw: &str) -> Result<Presence, CodecError> {
    let wire: WirePresence = serde_json::from_str(raw).map_err(|e| CodecError::Json(e.to_string()))?;
    presence_from_wire(fallback_id, rev, wire, (0.0, 0.0)).ok_or_else(|| CodecError::MissingId(fallback_id.to_owned()))
}

/// Decodes a JSON array of live collaborator presences (`ArtifactPresence`, `PresencePayload`,
/// or simplified `{id, name, color, x, y, status}` records), deduplicating by `id`.
pub fn decode_presences_json(raw: &str) -> Vec<Presence> {
    if raw.trim().is_empty() {
        return Vec::new();
    }
    let Ok(items) = serde_json::from_str::<Vec<WirePresence>>(raw) else {
        return Vec::new();
    };
    let mut out: Vec<Presence> = Vec::with_capacity(items.len());
    for wire in items {
        let Some(p) = presence_from_wire("", 0, wire, (120.0, 120.0)) else {
            continue;
        };
        if let Some(existing) = out.iter_mut().find(|e| e.id == p.id) {
            let incoming_newer = match (existing.updated_at, p.updated_at) {
                (Some(old_ts), Some(new_ts)) => new_ts >= old_ts,
                _ => true,
            };
            if incoming_newer {
                *existing = p;
            }
        } else {
            out.push(p);
        }
    }
    out
}

/// Merges live Loro presence updates into `doc.presences`, letting live records override matching IDs.
pub fn merge_live_presences(doc: &mut BoardDoc, live: Vec<Presence>) {
    for mut p in live {
        if let Some(existing) = doc.presences.iter_mut().find(|e| e.id == p.id) {
            if p.selected_ids.is_empty() && !existing.selected_ids.is_empty() {
                p.selected_ids = existing.selected_ids.clone();
            }
            *existing = p;
        } else {
            doc.presences.push(p);
        }
    }
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
