mod json;
mod palette;
mod svg;
mod svg_elements;

use std::collections::BTreeSet;

use nsh_core::prelude::{Bounds, Painter, point, px, size};

use crate::engine::whiteboard::layout::measure_text_span;
use crate::engine::whiteboard::model::{BoardDoc, ElementKind, Rect2};
use crate::engine::whiteboard::paint::{WhiteboardPalette, paint_board_into_painter, paint_grid, paint_presences_into_painter, parse_hex_hsla};

pub use json::{export_json, export_json_canvas};
pub use svg::export_svg;

pub(super) fn export_bounds(doc: &BoardDoc) -> Rect2 {
    let raw = doc.content_bounds().unwrap_or(Rect2::new(0.0, 0.0, 960.0, 540.0));
    let mut out = raw.expand(48.0);
    for el in &doc.elements {
        if let ElementKind::Container { x, y, w, h, title, .. } = &el.kind
            && !title.trim().is_empty()
        {
            out = out.union(Rect2::new(*x - 12.0, *y - 34.0, *w + 24.0, *h + 46.0));
        }
    }
    for p in &doc.presences {
        if let Some(r) = p.region_rect() {
            out = out.union(r.expand(18.0));
        }
        if !p.has_cursor {
            continue;
        }
        let status_msg = p.status.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let pill_w = match status_msg {
            Some(msg) if msg.chars().count() > 14 => (measure_text_span(msg, 12.5, false) + 56.0).clamp(160.0, 580.0),
            Some(st) => (measure_text_span(&format!("{} · {st}", p.name), 11.5, true) + 28.0).max(70.0),
            None => (measure_text_span(&p.name, 11.5, true) + 28.0).max(70.0),
        };
        let pr = Rect2::new(p.x - 16.0, p.y - 16.0, pill_w + 36.0, 62.0);
        out = out.union(pr);
    }
    Rect2::new(out.x.floor(), out.y.floor(), out.w.max(320.0).ceil(), out.h.max(240.0).ceil())
}

pub fn build_export_painter(doc: &BoardDoc, dark: bool) -> (Painter, f32, f32) {
    let bounds = export_bounds(doc);
    let pal = WhiteboardPalette::for_mode(dark);
    let lookup = doc.rect_lookup();
    let hidden = BTreeSet::new();
    let w = bounds.w as f32;
    let h = bounds.h as f32;

    let bg = doc.meta.background.as_deref().and_then(parse_hex_hsla).unwrap_or(pal.page);

    let mut painter = Painter::new()
        .begin_path()
        .fill_color(bg)
        .rect(Bounds::new(point(px(0.0), px(0.0)), size(px(w), px(h))))
        .fill();

    let cam = crate::engine::whiteboard::geometry::Camera {
        pan_x: -bounds.x,
        pan_y: -bounds.y,
        zoom: 1.0,
    };
    painter = paint_grid(painter, doc.meta.grid, cam, w, h, &pal);
    painter = painter.save().translate(-bounds.x as f32, -bounds.y as f32);
    let empty_dismissed = BTreeSet::new();
    painter = paint_board_into_painter(painter, doc, &lookup, &pal, None, None, &hidden);
    painter = paint_presences_into_painter(painter, doc, &pal, 1.0, &empty_dismissed);
    painter = painter.restore();

    (painter, w, h)
}
