use std::f64::consts::PI;

use indexmap::IndexMap;

use crate::Rendered;
use crate::diagram::RenderContext;
use crate::diagram::common::{fit_width, title_room};
use crate::measure::TextStyle;
use crate::svg::builder::{esc_text, label_svg, num};
use crate::svg::root::{Accessible, svg_document};
use crate::text::label::{Label, layout_label};
use crate::util::yaml::YamlValue;

use super::model::{Graticule, RadarModel};

const SWATCH: f64 = 12.0;
const ROW: f64 = 26.0;
const GAP: f64 = 24.0;

#[derive(Debug, Clone, Copy)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

fn option(section: Option<&IndexMap<String, YamlValue>>, key: &str, fallback: f64, min: f64, max: f64) -> f64 {
    match section.and_then(|m| m.get(key)).and_then(YamlValue::as_f64) {
        Some(v) if v >= min => v.min(max),
        _ => fallback,
    }
}

pub fn relative_radius(value: f64, min: f64, max: f64, radius: f64) -> f64 {
    let clipped = value.max(min).min(max);
    let scaled = radius * (clipped - min);
    if scaled.is_finite() {
        scaled / (max - min)
    } else {
        radius * ((clipped - min) / (max - min))
    }
}

/// Closed Catmull-Rom spline through `points` as cubic Bezier segments.
pub fn closed_round_curve(points: &[Point], tension: f64) -> String {
    let n = points.len();
    if n == 0 {
        return String::new();
    }
    let mut d = format!("M{},{}", num(points[0].x), num(points[0].y));
    for i in 0..n {
        let p0 = points[(i + n - 1) % n];
        let p1 = points[i];
        let p2 = points[(i + 1) % n];
        let p3 = points[(i + 2) % n];
        d.push_str(&format!(
            " C{},{} {},{} {},{}",
            num(p1.x + (p2.x - p0.x) * tension),
            num(p1.y + (p2.y - p0.y) * tension),
            num(p2.x - (p3.x - p1.x) * tension),
            num(p2.y - (p3.y - p1.y) * tension),
            num(p2.x),
            num(p2.y),
        ));
    }
    d.push_str(" Z");
    d
}

fn polygon_points(points: &[Point]) -> String {
    let mut out = String::new();
    for p in points {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&num(p.x));
        out.push(',');
        out.push_str(&num(p.y));
    }
    out
}

pub fn render_radar(model: &RadarModel, ctx: &RenderContext<'_>) -> Rendered {
    let section = ctx.config.section("radar");
    let natural = option(section, "width", 320.0, 1.0, 4000.0);
    let natural_h = option(section, "height", 320.0, 1.0, 4000.0);
    fit_width(ctx.options, natural, 160.0, |width, tight| {
        draw(model, section, ctx, width, (natural_h * width) / natural, tight)
    })
}

fn draw(model: &RadarModel, section: Option<&IndexMap<String, YamlValue>>, ctx: &RenderContext<'_>, width: f64, height: f64, tight: bool) -> Rendered {
    let size = ctx.options.font_size.unwrap_or(16.0);
    let small = (size * 0.875).round();
    let pad = ctx.options.padding.unwrap_or(8.0);

    let axis_scale = option(section, "axisScaleFactor", 1.0, 0.0, 10.0);
    let label_factor = option(section, "axisLabelFactor", 1.05, 0.0, 10.0);
    let tension = option(section, "curveTension", 0.17, 0.0, 1.0);
    let radius = width.min(height) / 2.0;

    let axes = &model.axes;
    let curves = &model.curves;
    let ticks = model.options.ticks;
    let graticule = model.options.graticule;
    let min = model.options.min;
    let count = axes.len();

    let unit: Vec<Point> = (0..count)
        .map(|i| {
            let angle = (2.0 * PI * (i as f64)) / (count as f64) - PI / 2.0;
            Point {
                x: angle.cos(),
                y: angle.sin(),
            }
        })
        .collect();

    let max = match model.options.max {
        Some(m) => m,
        None => {
            let mut m = f64::NEG_INFINITY;
            for curve in curves {
                for &v in &curve.entries {
                    if v > m {
                        m = v;
                    }
                }
            }
            m
        }
    };

    let mut x0 = -width / 2.0 - option(section, "marginLeft", 16.0, 0.0, 2000.0);
    let mut x1 = width / 2.0 + option(section, "marginRight", 16.0, 0.0, 2000.0);
    let mut y0 = -height / 2.0 - option(section, "marginTop", 16.0, 0.0, 2000.0);
    let mut y1 = height / 2.0 + option(section, "marginBottom", 16.0, 0.0, 2000.0);

    let mut grid = String::new();
    let mut tick_idx = 0usize;
    while (tick_idx as f64) < ticks {
        let r = radius.min((radius * ((tick_idx + 1) as f64)) / ticks);
        match graticule {
            Graticule::Circle => grid.push_str(&format!(r#"<circle r="{}"/>"#, num(r))),
            Graticule::Polygon => {
                let pts: Vec<Point> = unit.iter().map(|u| Point { x: u.x * r, y: u.y * r }).collect();
                grid.push_str(&format!(r#"<polygon points="{}"/>"#, polygon_points(&pts)));
            }
        }
        tick_idx += 1;
    }

    let mut spokes = String::new();
    let mut labels = String::new();
    for (i, u) in unit.iter().enumerate() {
        let reach = radius * axis_scale;
        spokes.push_str(&format!("M0,0L{},{}", num(u.x * reach), num(u.y * reach)));
        let label = layout_label(Some(&axes[i].label), false, ctx.measurer, small, 4000.0, TextStyle::NONE, ctx.icons, None);
        let at = radius * label_factor + 6.0;
        let cx = u.x * at
            + if u.x > 0.01 {
                label.width / 2.0
            } else if u.x < -0.01 {
                -label.width / 2.0
            } else {
                0.0
            };
        let cy = u.y * at
            + if u.y > 0.01 {
                label.height / 2.0
            } else if u.y < -0.01 {
                -label.height / 2.0
            } else {
                0.0
            };
        labels.push_str(&format!(
            r#"<g class="pele-axis-label" data-id="{}">{}</g>"#,
            esc_text(&axes[i].name),
            label_svg(&label, cx, cy, "", ctx.theme, ctx.icons)
        ));
        x0 = x0.min(cx - label.width / 2.0);
        x1 = x1.max(cx + label.width / 2.0);
        y0 = y0.min(cy - label.height / 2.0);
        y1 = y1.max(cy + label.height / 2.0);
    }

    let mut shapes = String::new();
    for (index, curve) in curves.iter().enumerate() {
        if curve.entries.len() != count || count == 0 {
            continue;
        }
        let points: Vec<Point> = curve
            .entries
            .iter()
            .enumerate()
            .map(|(i, &value)| {
                let r = relative_radius(value, min, max, radius);
                let safe = if r.is_finite() { r } else { 0.0 };
                Point {
                    x: unit[i].x * safe,
                    y: unit[i].y * safe,
                }
            })
            .collect();
        let color = ctx.theme.series_color(index, ctx.palette);
        let attrs = format!(r#" class="pele-curve" data-id="{}" fill="{color}" stroke="{color}""#, esc_text(&curve.name));
        match graticule {
            Graticule::Circle => shapes.push_str(&format!(r#"<path{attrs} d="{}"/>"#, closed_round_curve(&points, tension))),
            Graticule::Polygon => shapes.push_str(&format!(r#"<polygon{attrs} points="{}"/>"#, polygon_points(&points))),
        }
    }

    let legend: Vec<Label> = if model.options.show_legend {
        curves
            .iter()
            .map(|c| layout_label(Some(&c.label), false, ctx.measurer, small, 4000.0, TextStyle::NONE, ctx.icons, None))
            .collect()
    } else {
        Vec::new()
    };
    let legend_width = legend.iter().map(|l| l.width).fold(0.0f64, f64::max);
    let legend_height = (legend.len() as f64) * ROW;
    let legend_x = if tight { -(SWATCH + 8.0 + legend_width) / 2.0 } else { x1 + GAP };
    let legend_top = if tight { y1 + GAP / 2.0 } else { -legend_height / 2.0 };
    if !legend.is_empty() {
        if tight {
            x0 = x0.min(legend_x);
            x1 = x1.max(-legend_x);
            y1 = legend_top + legend_height;
        } else {
            x1 = legend_x + SWATCH + 8.0 + legend_width;
            y0 = y0.min(-legend_height / 2.0);
            y1 = y1.max(legend_height / 2.0);
        }
    }

    let mut legend_out = String::new();
    for (index, label) in legend.iter().enumerate() {
        let y = legend_top + (index as f64) * ROW + ROW / 2.0;
        let color = ctx.theme.series_color(index, ctx.palette);
        legend_out.push_str(&format!(
            r#"<g class="pele-legend-item" data-id="{}"><rect x="{}" y="{}" width="{}" height="{}" rx="2" fill="{color}" fill-opacity="0.4" stroke="{color}"/>{}</g>"#,
            esc_text(&curves[index].name),
            num(legend_x),
            num(y - SWATCH / 2.0),
            num(SWATCH),
            num(SWATCH),
            label_svg(label, legend_x + SWATCH + 8.0 + label.width / 2.0, y, "", ctx.theme, ctx.icons)
        ));
    }

    let title = layout_label(
        model.title.as_deref(),
        false,
        ctx.measurer,
        size,
        title_room(ctx.options),
        TextStyle::BOLD,
        ctx.icons,
        None,
    );
    let title_height = if title.height > 0.0 { title.height + 8.0 } else { 0.0 };
    let body_width = (x1 - x0).max(title.width);
    let total_width = (body_width + 2.0 * pad).ceil();
    let total_height = (y1 - y0 + title_height + 2.0 * pad).ceil();
    let origin = format!("translate({},{})", num(pad + (body_width - (x1 - x0)) / 2.0 - x0), num(pad + title_height - y0));

    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let mut content = String::new();
    content.push_str(&label_svg(
        &title,
        total_width / 2.0,
        pad + title.height / 2.0,
        &title_attrs,
        ctx.theme,
        ctx.icons,
    ));
    content.push_str(&format!(r#"<g transform="{origin}">"#));
    if !grid.is_empty() {
        content.push_str(&format!(
            r#"<g class="pele-graticule" fill="none" stroke="{}">{grid}</g>"#,
            ctx.theme.surface_alt()
        ));
    }
    if !spokes.is_empty() {
        content.push_str(&format!(
            r#"<path class="pele-axes" d="{spokes}" fill="none" stroke="{}"/>"#,
            ctx.theme.border()
        ));
    }
    if !shapes.is_empty() {
        content.push_str(&format!(
            r#"<g class="pele-curves" fill-opacity="0.2" stroke-width="1.5" stroke-linejoin="round">{shapes}</g>"#
        ));
    }
    if !labels.is_empty() {
        content.push_str(&format!(r#"<g class="pele-axis-labels" font-size="{}">{labels}</g>"#, num(small)));
    }
    if !legend_out.is_empty() {
        content.push_str(&format!(r#"<g class="pele-legend" font-size="{}">{legend_out}</g>"#, num(small)));
    }
    content.push_str("</g>");

    let svg = svg_document(
        "radar",
        total_width,
        total_height,
        size,
        ctx.options,
        ctx.responsive,
        ctx.theme,
        ctx.palette,
        Accessible {
            acc_title: model.acc_title.as_deref(),
            acc_descr: model.acc_descr.as_deref(),
        },
        &content,
    );
    Rendered {
        svg,
        width: total_width,
        height: total_height,
        links: Vec::new(),
    }
}
