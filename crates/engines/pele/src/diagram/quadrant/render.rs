use indexmap::IndexMap;

use crate::Rendered;
use crate::diagram::RenderContext;
use crate::diagram::common::cap_width;
use crate::measure::TextStyle;
use crate::svg::builder::{esc_text, label_svg, num};
use crate::svg::root::{Accessible, svg_document};
use crate::svg::theme::{class_names, resolve_style};
use crate::text::label::{Label, layout_label};
use crate::util::yaml::YamlValue;

use super::db::{QuadrantModel, QuadrantText, QuadrantTextKind};

const GAP: f64 = 4.0;
const CAREFUL: usize = 300;

struct Dot {
    cx: f64,
    cy: f64,
    reach: f64,
    text: Label,
}

fn length(section: Option<&IndexMap<String, YamlValue>>, key: &str, fallback: f64, max: f64) -> f64 {
    match section.and_then(|m| m.get(key)).and_then(YamlValue::as_f64) {
        Some(v) if v >= 0.0 => v.min(max),
        _ => fallback,
    }
}

fn text_size(section: Option<&IndexMap<String, YamlValue>>, key: &str, fallback: f64) -> f64 {
    match section.and_then(|m| m.get(key)).and_then(YamlValue::as_f64) {
        Some(v) if v.is_finite() => v.clamp(4.0, 72.0),
        _ => fallback,
    }
}

fn hex(color: &str) -> String {
    if color.starts_with('#') { color.to_string() } else { format!("#{color}") }
}

fn size_attr(own: f64, inherited: f64) -> String {
    if own == inherited {
        String::new()
    } else {
        format!(r#" font-size="{}""#, num(own))
    }
}

pub fn render_quadrant(model: &QuadrantModel, ctx: &RenderContext<'_>) -> Rendered {
    let section = ctx.config.section("quadrantChart");
    let size = ctx.options.font_size.unwrap_or(16.0);
    let title_size = text_size(section, "titleFontSize", size);
    let quadrant_size = text_size(section, "quadrantLabelFontSize", size);
    let x_axis_size = text_size(section, "xAxisLabelFontSize", (size * 0.875).round());
    let y_axis_size = text_size(section, "yAxisLabelFontSize", (size * 0.875).round());
    let point_size = text_size(section, "pointLabelFontSize", (size * 0.75).round());

    let natural = length(section, "chartWidth", 500.0, 4000.0).max(100.0).round();
    let width = cap_width(ctx.options, natural, 280.0, 0.0).round();
    let height = ((length(section, "chartHeight", 500.0, 4000.0).max(100.0) * width) / natural).round();
    let outer = length(section, "quadrantPadding", ctx.options.padding.unwrap_or(8.0), 200.0);
    let x_pad = length(section, "xAxisLabelPadding", 5.0, 200.0);
    let y_pad = length(section, "yAxisLabelPadding", 5.0, 200.0);
    let has_points = !model.points.is_empty();

    let make_label = |text: Option<&QuadrantText>, font_size: f64, max: f64| -> Label {
        layout_label(
            text.map(|t| t.text.as_str()),
            text.is_some_and(|t| t.kind == QuadrantTextKind::Markdown),
            ctx.measurer,
            font_size,
            max.max(40.0),
            TextStyle::NONE,
            ctx.icons,
            None,
        )
    };

    let title = layout_label(
        model.title.as_deref(),
        false,
        ctx.measurer,
        title_size,
        (width - 2.0 * outer).max(40.0),
        TextStyle::BOLD,
        ctx.icons,
        None,
    );
    let title_pad = length(section, "titlePadding", 10.0, 200.0);
    let title_space = if title.height > 0.0 { title.height + title_pad } else { 0.0 };

    let has_x = model.x_axis_left.as_ref().is_some_and(|t| !t.text.is_empty()) || model.x_axis_right.as_ref().is_some_and(|t| !t.text.is_empty());
    let has_y = model.y_axis_bottom.as_ref().is_some_and(|t| !t.text.is_empty()) || model.y_axis_top.as_ref().is_some_and(|t| !t.text.is_empty());
    let x_below = has_points || section.and_then(|m| m.get("xAxisPosition")).and_then(YamlValue::as_str) == Some("bottom");
    let y_right = section.and_then(|m| m.get("yAxisPosition")).and_then(YamlValue::as_str) == Some("right");

    let side = width - 2.0 * outer;
    let x_left = make_label(
        model.x_axis_left.as_ref(),
        x_axis_size,
        if model.x_axis_right.is_some() { side / 2.0 - 16.0 } else { side },
    );
    let x_right = make_label(model.x_axis_right.as_ref(), x_axis_size, side / 2.0 - 16.0);
    let x_height = x_left.height.max(x_right.height);
    let x_space = if has_x { x_height + x_pad } else { 0.0 };
    let tall = height - 2.0 * outer - title_space - x_space;
    let y_bottom = make_label(
        model.y_axis_bottom.as_ref(),
        y_axis_size,
        if model.y_axis_top.is_some() { tall / 2.0 - 16.0 } else { tall },
    );
    let y_top = make_label(model.y_axis_top.as_ref(), y_axis_size, tall / 2.0 - 16.0);
    let y_height = y_bottom.height.max(y_top.height);
    let y_space = if has_y { y_height + y_pad } else { 0.0 };

    let left = outer + if y_right { 0.0 } else { y_space };
    let top = outer + title_space + if x_below { 0.0 } else { x_space };
    let w = (side - y_space).max(0.0);
    let h = tall.max(0.0);
    let tile_w = ((w - GAP) / 2.0).max(0.0);
    let tile_h = ((h - GAP) / 2.0).max(0.0);

    let mut taken = vec![left + tile_w, top, left + w - tile_w, top + h, left, top + tile_h, left + w, top + h - tile_h];
    let is_clear = |taken: &[f64], from: usize, x0: f64, y0: f64, x1: f64, y1: f64| -> bool {
        let mut k = from;
        while k + 3 < taken.len() {
            if taken[k] < taken[k + 2] && taken[k + 1] < taken[k + 3] && x0 < taken[k + 2] && x1 > taken[k] && y0 < taken[k + 3] && y1 > taken[k + 1] {
                return false;
            }
            k += 4;
        }
        true
    };

    let text_top = length(section, "quadrantTextTopPadding", 5.0, 200.0);
    let rounded = ctx.theme.rounded_standalone();
    let quad_label_attrs = format!(
        r#" class="pele-label"{} fill="{}" stroke="none""#,
        size_attr(quadrant_size, size),
        ctx.theme.fg()
    );
    let mut quadrants = String::new();
    for k in 0..4 {
        let x = if k == 0 || k == 3 { left + w - tile_w } else { left };
        let y = if k < 2 { top } else { top + h - tile_h };
        let text = make_label(model.quadrants[k].as_ref(), quadrant_size, tile_w - 16.0);
        let cx = x + tile_w / 2.0;
        let cy = if has_points { y + text_top + text.height / 2.0 } else { y + tile_h / 2.0 };
        taken.extend_from_slice(&[cx - text.width / 2.0, cy - text.height / 2.0, cx + text.width / 2.0, cy + text.height / 2.0]);
        quadrants.push_str(&format!(
            r#"<g class="pele-quadrant" data-id="{}"><rect x="{}" y="{}" width="{}" height="{}"{rounded}/>{}</g>"#,
            k + 1,
            num(x),
            num(y),
            num(tile_w),
            num(tile_h),
            label_svg(&text, cx, cy, &quad_label_attrs, ctx.theme, ctx.icons)
        ));
    }

    let mut axes = String::new();
    if has_x {
        let y = if x_below {
            top + h + x_pad + x_height / 2.0
        } else {
            top - x_pad - x_height / 2.0
        };
        let lx = if x_right.height > 0.0 { left + w / 4.0 } else { left + x_left.width / 2.0 };
        axes.push_str(&label_svg(&x_left, lx, y, "", ctx.theme, ctx.icons));
        axes.push_str(&label_svg(&x_right, left + (w * 3.0) / 4.0, y, "", ctx.theme, ctx.icons));
    }
    if has_y {
        let x = if y_right {
            left + w + y_pad + y_height / 2.0
        } else {
            left - y_pad - y_height / 2.0
        };
        let y_size_attr = size_attr(y_axis_size, x_axis_size);
        let turned = |label: &Label, y: f64| -> String {
            if label.height > 0.0 {
                format!(
                    r#"<g transform="translate({},{}) rotate(-90)"{y_size_attr}>{}</g>"#,
                    num(x),
                    num(y),
                    label_svg(label, 0.0, 0.0, "", ctx.theme, ctx.icons)
                )
            } else {
                String::new()
            }
        };
        let by = if y_top.height > 0.0 {
            top + (h * 3.0) / 4.0
        } else {
            top + h - y_bottom.width / 2.0
        };
        axes.push_str(&turned(&y_bottom, by));
        axes.push_str(&turned(&y_top, top + h / 4.0));
    }

    let radius = length(section, "pointRadius", 5.0, 200.0);
    let text_pad = length(section, "pointTextPadding", 5.0, 200.0);
    let fill = ctx.theme.series_color(0, ctx.palette);
    let mut dots: Vec<Dot> = Vec::new();
    let mut circles: Vec<String> = Vec::new();

    for point in &model.points {
        if !(point.x >= 0.0 && point.x <= 1.0 && point.y >= 0.0 && point.y <= 1.0) {
            continue;
        }
        let shared = model.classes.get(&point.class_name);
        let r = point.style.radius.or(shared.and_then(|s| s.radius)).unwrap_or(radius).min(2000.0);
        let color = point.style.color.as_deref().or(shared.and_then(|s| s.color.as_deref()));
        let stroke_color = point.style.stroke_color.as_deref().or(shared.and_then(|s| s.stroke_color.as_deref()));
        let stroke_width = point.style.stroke_width.as_deref().or(shared.and_then(|s| s.stroke_width.as_deref()));

        let mut styles: Vec<String> = Vec::new();
        if let Some(c) = color {
            styles.push(format!("fill:{}", hex(c)));
        }
        if let Some(sw) = stroke_width {
            if let Some(sc) = stroke_color {
                styles.push(format!("stroke:{}", hex(sc)));
            }
            styles.push(format!("stroke-width:{sw}"));
        }
        let cx = left + point.x * w;
        let cy = top + (1.0 - point.y) * h;
        let sw_reach = stroke_width
            .and_then(|sw| sw.strip_suffix("px"))
            .and_then(|d| d.parse::<f64>().ok())
            .map_or(0.0, |px| px.min(400.0) / 2.0);
        dots.push(Dot {
            cx,
            cy,
            reach: r + sw_reach,
            text: make_label(Some(&point.text), point_size, w),
        });
        let stroke_attr = if stroke_width.is_some() && stroke_color.is_none() {
            format!(r#" stroke="{fill}""#)
        } else {
            String::new()
        };
        circles.push(format!(
            r#"<circle class="pele-point{}" data-id="{}" cx="{}" cy="{}" r="{}"{stroke_attr}{}/>"#,
            class_names(&point.class_name),
            esc_text(&point.text.text),
            num(cx),
            num(cy),
            num(r),
            resolve_style(&styles).shape
        ));
    }

    let careful = dots.len() <= CAREFUL;
    if careful {
        for dot in &dots {
            taken.extend_from_slice(&[dot.cx - dot.reach, dot.cy - dot.reach, dot.cx + dot.reach, dot.cy + dot.reach]);
        }
    }
    let mut labels = String::new();
    for dot in &dots {
        let half_w = dot.text.width / 2.0;
        let half_h = dot.text.size * 0.6 + (dot.text.height - dot.text.line_height) / 2.0;
        let away = dot.reach + text_pad;
        let inset = away.min(((tile_w - dot.text.width) / 2.0).max(0.0));
        let quad = if dot.cx < left + w / 2.0 {
            if dot.cy < top + h / 2.0 { 1 } else { 2 }
        } else if dot.cy < top + h / 2.0 {
            0
        } else {
            3
        };
        let heading = 8 + 4 * quad;
        let below = (dot.cy + away).max(taken[heading + 3] + text_pad) + half_h;
        let spots = [
            dot.cx,
            dot.cy + away + half_h,
            dot.cx,
            dot.cy - away - half_h,
            dot.cx + away + half_w,
            dot.cy,
            dot.cx - away - half_w,
            dot.cy,
            dot.cx,
            below,
        ];
        let mut tx = dot.cx;
        let mut ty = spots[1];
        let mut found = false;
        let mut k = 0;
        while k < 20 {
            let spot = k % 10;
            let margin = if spot == 8 { inset } else { 0.0 };
            let x = if (spot < 4 || spot == 8) && dot.text.width < w {
                spots[spot].clamp(left + half_w + margin, left + w - half_w - margin)
            } else {
                spots[spot]
            };
            let y = spots[spot + 1];
            if x - half_w >= left && x + half_w <= left + w && y - half_h >= top && y + half_h <= top + h {
                let free = !careful || is_clear(&taken, if k < 10 { 0 } else { 8 }, x - half_w, y - half_h, x + half_w, y + half_h);
                if !found || free {
                    tx = x;
                    ty = y;
                    found = true;
                }
                if free {
                    break;
                }
            }
            k += 2;
        }
        if careful {
            taken.extend_from_slice(&[tx - half_w, ty - half_h, tx + half_w, ty + half_h]);
        }
        labels.push_str(&label_svg(&dot.text, tx, ty, r#" class="pele-label""#, ctx.theme, ctx.icons));
    }

    circles.reverse();
    let title_attrs = format!(
        r#" class="pele-title"{} font-weight="{}""#,
        size_attr(title_size, size),
        ctx.theme.title_weight()
    );
    let mut content = String::new();
    content.push_str(&label_svg(
        &title,
        width / 2.0,
        title_pad / 2.0 + title.height / 2.0,
        &title_attrs,
        ctx.theme,
        ctx.icons,
    ));
    content.push_str(&format!(
        r#"<g class="pele-quadrants" fill="{}" stroke="{}">{quadrants}</g>"#,
        ctx.theme.surface(),
        ctx.theme.border()
    ));
    if !axes.is_empty() {
        content.push_str(&format!(
            r#"<g class="pele-axis-labels" font-size="{}" fill="{}">{axes}</g>"#,
            num(x_axis_size),
            ctx.theme.muted()
        ));
    }
    if !dots.is_empty() {
        content.push_str(&format!(r#"<g class="pele-points" fill="{fill}">{}</g>"#, circles.concat()));
        content.push_str(&format!(r#"<g class="pele-point-labels" font-size="{}">{labels}</g>"#, num(point_size)));
    }

    let svg = svg_document(
        "quadrantChart",
        width,
        height,
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
        width,
        height,
        links: Vec::new(),
    }
}
