use nsh_core::prelude::{Bounds, Hsla, Painter, Points, point, px, radians, size};

use crate::engine::whiteboard::geometry::Camera;
use crate::engine::whiteboard::model::GridStyle;

use super::palette::WhiteboardPalette;

pub(super) fn fast_shadow_color(pal: &WhiteboardPalette) -> Hsla {
    Hsla { a: 0.08, ..pal.card_shadow }
}

pub(super) fn fill_and_stroke_round_rect(painter: Painter, bounds: Bounds<Points>, radius: f32, fill: Hsla, stroke: Hsla, stroke_width: f32) -> Painter {
    painter
        .begin_path()
        .fill_color(fill)
        .round_rect(bounds, px(radius))
        .fill()
        .stroke_color(stroke)
        .line_width(stroke_width)
        .begin_path()
        .round_rect(bounds, px(radius))
        .stroke()
}

pub(super) fn fill_and_stroke_rect(painter: Painter, bounds: Bounds<Points>, fill: Hsla, stroke: Hsla, stroke_width: f32) -> Painter {
    painter
        .begin_path()
        .fill_color(fill)
        .rect(bounds)
        .fill()
        .stroke_color(stroke)
        .line_width(stroke_width)
        .begin_path()
        .rect(bounds)
        .stroke()
}

pub(super) fn fill_and_stroke_circle(painter: Painter, cx: f32, cy: f32, r: f32, fill: Hsla, stroke: Hsla, stroke_width: f32) -> Painter {
    let center = point(px(cx), px(cy));
    let radii = size(px(r), px(r));
    painter
        .begin_path()
        .fill_color(fill)
        .ellipse(center, radii, radians(0.0), radians(0.0), radians(std::f32::consts::TAU), false)
        .fill()
        .stroke_color(stroke)
        .line_width(stroke_width)
        .begin_path()
        .ellipse(center, radii, radians(0.0), radians(0.0), radians(std::f32::consts::TAU), false)
        .stroke()
}

#[allow(clippy::too_many_arguments)]
pub(super) fn fill_round_rect_shadowed(
    painter: Painter,
    bounds: Bounds<Points>,
    radius: f32,
    fill: Hsla,
    pal: &WhiteboardPalette,
    fast_shadows: bool,
    blur: f32,
    dy: f32,
) -> Painter {
    if fast_shadows {
        let shadow_bounds = Bounds::new(point(bounds.origin.x, px(f32::from(bounds.origin.y) + dy)), bounds.size);
        painter
            .begin_path()
            .fill_color(fast_shadow_color(pal))
            .round_rect(shadow_bounds, px(radius))
            .fill()
            .begin_path()
            .fill_color(fill)
            .round_rect(bounds, px(radius))
            .fill()
    } else {
        painter
            .save()
            .shadow(pal.card_shadow, px(blur), point(px(0.0), px(dy)))
            .begin_path()
            .fill_color(fill)
            .round_rect(bounds, px(radius))
            .fill()
            .restore()
    }
}

pub fn paint_grid(mut painter: Painter, style: GridStyle, camera: Camera, vw: f32, vh: f32, pal: &WhiteboardPalette) -> Painter {
    if style == GridStyle::None {
        return painter;
    }
    let zoom = camera.zoom.max(0.1);
    let step_world = if zoom < 0.45 { 96.0 } else { 24.0 };
    let step_px = step_world * zoom;
    if step_px < 6.0 {
        return painter;
    }

    let world_view = camera.visible_world_rect(f64::from(vw), f64::from(vh));
    let start_wx = (world_view.x / step_world).floor() * step_world;
    let start_wy = (world_view.y / step_world).floor() * step_world;

    match style {
        GridStyle::Architectural => {
            let major = step_world * 5.0;
            // Batch all minor vertical + horizontal lines into one path & stroke.
            painter = painter.stroke_color(pal.grid_minor).line_width(1.0).begin_path();
            let mut has_minor = false;
            let mut wx = start_wx;
            while wx <= world_view.right() {
                if (wx / major).fract().abs() > 0.05 {
                    let sx = (wx * zoom + camera.pan_x) as f32;
                    painter = painter.move_to(sx, 0.0).line_to(sx, vh);
                    has_minor = true;
                }
                wx += step_world;
            }
            let mut wy = start_wy;
            while wy <= world_view.bottom() {
                if (wy / major).fract().abs() > 0.05 {
                    let sy = (wy * zoom + camera.pan_y) as f32;
                    painter = painter.move_to(0.0, sy).line_to(vw, sy);
                    has_minor = true;
                }
                wy += step_world;
            }
            if has_minor {
                painter = painter.stroke();
            }
            // Batch all major vertical + horizontal lines into one path & stroke.
            painter = painter.stroke_color(pal.grid_major).line_width(1.0).begin_path();
            let mut has_major = false;
            let mut mwx = (world_view.x / major).floor() * major;
            while mwx <= world_view.right() {
                let sx = (mwx * zoom + camera.pan_x) as f32;
                painter = painter.move_to(sx, 0.0).line_to(sx, vh);
                has_major = true;
                mwx += major;
            }
            let mut mwy = (world_view.y / major).floor() * major;
            while mwy <= world_view.bottom() {
                let sy = (mwy * zoom + camera.pan_y) as f32;
                painter = painter.move_to(0.0, sy).line_to(vw, sy);
                has_major = true;
                mwy += major;
            }
            if has_major {
                painter = painter.stroke();
            }
        }
        GridStyle::Dots => {
            let dot_r = (1.15 * zoom.sqrt()).clamp(0.8, 2.0) as f32;
            painter = painter.fill_color(pal.grid_dot).begin_path();
            let mut has_dots = false;
            let mut wx = start_wx;
            while wx <= world_view.right() {
                let sx = (wx * zoom + camera.pan_x) as f32;
                let mut wy = start_wy;
                while wy <= world_view.bottom() {
                    let sy = (wy * zoom + camera.pan_y) as f32;
                    // Move to each circle's angle-0 point so tiny-skia starts a disconnected subpath per dot.
                    painter = painter.move_to(sx + dot_r, sy).ellipse(
                        point(px(sx), px(sy)),
                        size(px(dot_r), px(dot_r)),
                        radians(0.0),
                        radians(0.0),
                        radians(std::f32::consts::TAU),
                        false,
                    );
                    has_dots = true;
                    wy += step_world;
                }
                wx += step_world;
            }
            if has_dots {
                painter = painter.fill();
            }
        }
        GridStyle::None => {}
    }

    painter
}
