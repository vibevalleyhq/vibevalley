//! Native GPUI bridge painting workbench reicon vectors from `vibevalley-rich`.

use gpui::{
    AnyElement, Bounds, FillOptions, FillRule, Hsla, IntoElement as _, Path, PathBuilder, PathStyle, Pixels, StrokeOptions, Styled as _, canvas, div, point, px,
};
use vibevalley_rich::icon::{IconShape, Num, PathOp, icon_paths, icon_shapes};

const ICON_VIEWBOX: f32 = 24.0;

fn num(v: Num) -> f32 {
    match v {
        Num::Const(n) => n,
        Num::Slot(_) => 0.0,
    }
}

fn feed_ops(pb: &mut PathBuilder, ops: &[PathOp], x0: f32, y0: f32, scale: f32) {
    let pt = |x: f32, y: f32| point(px(x0 + x * scale), px(y0 + y * scale));
    for op in ops {
        match op {
            PathOp::MoveTo(x, y) => pb.move_to(pt(num(*x), num(*y))),
            PathOp::LineTo(x, y) => pb.line_to(pt(num(*x), num(*y))),
            PathOp::QuadTo([cx, cy, x, y]) => pb.curve_to(pt(num(*x), num(*y)), pt(num(*cx), num(*cy))),
            PathOp::CubicTo([x1, y1, x2, y2, x, y]) => pb.cubic_bezier_to(pt(num(*x), num(*y)), pt(num(*x1), num(*y1)), pt(num(*x2), num(*y2))),
            PathOp::Rect([x, y, w, h]) => {
                let (rx, ry, rw, rh) = (num(*x), num(*y), num(*w), num(*h));
                pb.move_to(pt(rx, ry));
                pb.line_to(pt(rx + rw, ry));
                pb.line_to(pt(rx + rw, ry + rh));
                pb.line_to(pt(rx, ry + rh));
                pb.close();
            }
            PathOp::Close => pb.close(),
            PathOp::Arc { .. } | PathOp::ArcTo(_) | PathOp::Ellipse { .. } | PathOp::RoundRect(_, _) => {}
        }
    }
}

fn build_shape_paths(shapes: &[IconShape], paths: &[vibevalley_rich::icon::Path], bounds: Bounds<Pixels>, color: Hsla) -> Vec<(Path<Pixels>, Hsla)> {
    let w = f32::from(bounds.size.width);
    let h = f32::from(bounds.size.height);
    let side = w.min(h);
    if !side.is_finite() || side <= 0.0 {
        return Vec::new();
    }
    let x0 = f32::from(bounds.origin.x) + (w - side) * 0.5;
    let y0 = f32::from(bounds.origin.y) + (h - side) * 0.5;
    let scale = side / ICON_VIEWBOX;
    let mut out = Vec::with_capacity(shapes.len());

    for (shape, ops) in shapes.iter().zip(paths.iter()) {
        let paint_color = match shape.opacity {
            Some(alpha) => Hsla {
                a: color.a * alpha.clamp(0.0, 1.0),
                ..color
            },
            None => color,
        };
        if shape.fill {
            let rule = if shape.evenodd { FillRule::EvenOdd } else { FillRule::NonZero };
            let mut pb = PathBuilder::fill().with_style(PathStyle::Fill(FillOptions::default().with_fill_rule(rule).with_tolerance(0.05)));
            feed_ops(&mut pb, ops, x0, y0, scale);
            if let Ok(built) = pb.build() {
                out.push((built, paint_color));
            }
        }
        if let Some(width) = shape.stroke
            && width > 0.0
        {
            let stroke_width = width * scale;
            let mut pb = PathBuilder::stroke(px(stroke_width))
                .with_style(PathStyle::Stroke(StrokeOptions::default().with_line_width(stroke_width).with_tolerance(0.05)));
            feed_ops(&mut pb, ops, x0, y0, scale);
            if let Ok(built) = pb.build() {
                out.push((built, paint_color));
            }
        }
    }
    out
}

/// Paints a registered `vibevalley-rich` reicon vector directly onto a GPUI `canvas`.
pub fn gpui_icon(name: &str, size: f32, color: Hsla) -> AnyElement {
    let sz = if size.is_finite() && size > 0.0 { size } else { 0.0 };
    let (Some(shapes), Some(paths)) = (icon_shapes(name), icon_paths(name)) else {
        return div().size(px(sz)).flex_none().into_any_element();
    };
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            for (path, paint_color) in build_shape_paths(shapes, paths, bounds, color) {
                window.paint_path(path, paint_color);
            }
        },
    )
    .size(px(sz))
    .flex_none()
    .into_any_element()
}

#[cfg(test)]
mod tests {
    use gpui::{Bounds, Hsla, point, px, size};
    use vibevalley_rich::icon::{ICON_NAMES, icon_paths, icon_shapes};

    use super::build_shape_paths;

    #[test]
    fn all_registered_icons_tessellate_into_gpui_paths() {
        let bounds = Bounds::new(point(px(0.0), px(0.0)), size(px(14.0), px(14.0)));
        let color = Hsla::white();
        for &name in ICON_NAMES {
            let shapes = icon_shapes(name).expect("shape");
            let paths = icon_paths(name).expect("path");
            let built = build_shape_paths(shapes, paths, bounds, color);
            assert!(!built.is_empty(), "icon `{name}` produced zero GPUI paths");
        }
    }
}
