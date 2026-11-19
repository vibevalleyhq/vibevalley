use std::f64::consts::PI;

use crate::Rendered;
use crate::diagram::RenderContext;
use crate::diagram::common::{fit_width, title_room};
use crate::measure::TextStyle;
use crate::svg::builder::{esc_text, label_svg, num};
use crate::svg::root::{Accessible, svg_document};
use crate::text::label::{Label, layout_label};

use super::model::PieModel;

const RADIUS: f64 = 120.0;
const SWATCH: f64 = 12.0;
const ROW: f64 = 26.0;
const GAP: f64 = 32.0;
const OUTSIDE: f64 = 28.0;

fn point(angle: f64, radius: f64) -> String {
    format!("{},{}", num(angle.sin() * radius), num(-angle.cos() * radius))
}

fn slice_path(start: f64, end: f64, outer: f64, inner: f64) -> String {
    if end - start >= PI * 2.0 - 1e-9 {
        let ring = |r: f64, sweep: u8| -> String {
            let nr = num(r);
            format!("M0,{}A{nr},{nr} 0 1 {sweep} 0,{nr}A{nr},{nr} 0 1 {sweep} 0,{}Z", num(-r), num(-r))
        };
        let mut out = ring(outer, 1);
        if inner > 0.0 {
            out.push_str(&ring(inner, 0));
        }
        return out;
    }
    let large = u8::from(end - start > PI);
    if inner <= 0.0 {
        return format!("M0,0L{}A{},{} 0 {large} 1 {}Z", point(start, outer), num(outer), num(outer), point(end, outer),);
    }
    format!(
        "M{}A{},{} 0 {large} 1 {}L{}A{},{} 0 {large} 0 {}Z",
        point(start, outer),
        num(outer),
        num(outer),
        point(end, outer),
        point(end, inner),
        num(inner),
        num(inner),
        point(start, inner),
    )
}

fn format_data_value(v: f64) -> String {
    if v == 0.0 {
        "0".to_string()
    } else if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

pub fn render_pie(model: &PieModel, ctx: &RenderContext<'_>) -> Rendered {
    fit_width(ctx.options, RADIUS * 2.0, 140.0, |diameter, tight| draw(model, ctx, diameter / 2.0, tight))
}

fn draw(model: &PieModel, ctx: &RenderContext<'_>, radius: f64, tight: bool) -> Rendered {
    let size = ctx.options.font_size.unwrap_or(16.0);
    let small = (size * 0.875).round();
    let pad = ctx.options.padding.unwrap_or(8.0);
    let pie_cfg = &ctx.config.pie;

    let text_position = match pie_cfg.text_position {
        Some(p) if (0.0..=1.0).contains(&p) => p,
        _ => 0.75,
    };
    let inner = match pie_cfg.donut_hole {
        Some(h) if h > 0.0 && h <= 0.9 => h * radius,
        _ => 0.0,
    };
    let placed = pie_cfg.legend_position.as_deref().unwrap_or("right");
    let legend_position = if tight && (placed == "left" || placed == "right") { "bottom" } else { placed };

    let entries: Vec<(&str, f64)> = model.sections.iter().map(|(k, &v)| (k.as_str(), v)).collect();
    let sum: f64 = entries.iter().map(|(_, v)| *v).sum();

    let legend: Vec<Label> = entries
        .iter()
        .map(|&(label, value)| {
            if model.show_data {
                let text = format!("{label} [{}]", format_data_value(value));
                layout_label(Some(&text), false, ctx.measurer, small, 4000.0, TextStyle::NONE, ctx.icons, None)
            } else {
                layout_label(Some(label), false, ctx.measurer, small, 4000.0, TextStyle::NONE, ctx.icons, None)
            }
        })
        .collect();
    let mut legend_width = 0.0f64;
    for label in &legend {
        legend_width = legend_width.max(label.width);
    }
    if !legend.is_empty() {
        legend_width += SWATCH + 8.0;
    }
    let legend_height = (legend.len() as f64) * ROW;

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
    let title_height = if title.height > 0.0 { title.height + 16.0 } else { 0.0 };

    let shares: Vec<f64> = entries
        .iter()
        .map(|&(_, value)| {
            let share = if sum > 0.0 { value / sum } else { 0.0 };
            if share * 100.0 >= 1.0 && (share * 100.0).round() as i64 != 0 {
                share
            } else {
                0.0
            }
        })
        .collect();
    let narrow: Vec<bool> = shares
        .iter()
        .map(|&share| {
            if share == 0.0 || share >= 0.5 {
                return false;
            }
            let chord = 2.0 * radius * text_position * (share * PI).sin();
            let pct = format!("{}%", (share * 100.0).round() as i64);
            chord < ctx.measurer.width(&pct, small, TextStyle::NONE) + 6.0
        })
        .collect();
    let margin = if narrow.iter().any(|&n| n) { OUTSIDE } else { 0.0 };

    let side = matches!(legend_position, "left" | "right" | "center");
    let stacked = matches!(legend_position, "top" | "bottom");
    let diameter = (radius + margin) * 2.0;
    let mut width = diameter;
    let mut height = diameter;
    if legend_position == "left" || legend_position == "right" {
        if legend_width > 0.0 {
            width += GAP + legend_width;
        }
        height = height.max(legend_height);
    } else if stacked {
        width = width.max(legend_width);
        if legend_height > 0.0 {
            height += 20.0 + legend_height;
        }
    }
    width = width.max(title.width);

    let cx = pad
        + if legend_position == "left" {
            legend_width + GAP + diameter / 2.0
        } else if legend_position == "right" {
            diameter / 2.0
        } else {
            width / 2.0
        };
    let body_top = pad + title_height;
    let cy = body_top
        + if legend_position == "top" {
            legend_height + 20.0 + diameter / 2.0
        } else if stacked {
            diameter / 2.0
        } else {
            height / 2.0
        };

    let mut slices = String::new();
    let mut labels = String::new();
    let mut outside = String::new();
    let mut angle = 0.0f64;
    let rim = radius + OUTSIDE / 2.0;
    let mut placed_outside: Vec<(f64, f64, f64)> = Vec::new();
    let clear = |placed: &[(f64, f64, f64)], x: f64, y: f64, w: f64| -> bool {
        placed
            .iter()
            .all(|&(ox, oy, ow)| (x - ox).abs() >= (w + ow) / 2.0 + 2.0 || (y - oy).abs() >= small + 2.0)
    };

    for (index, &(label, _)) in entries.iter().enumerate() {
        let share = shares[index];
        if share == 0.0 {
            continue;
        }
        let end = angle + share * PI * 2.0;
        slices.push_str(&format!(
            r#"<path class="pele-slice" data-id="{}" d="{}" fill="{}"/>"#,
            esc_text(label),
            slice_path(angle, end, radius, inner),
            ctx.theme.series_color(index, ctx.palette),
        ));
        let mid = (angle + end) / 2.0;
        let text = format!("{}%", (share * 100.0).round() as i64);
        if narrow[index] {
            let tw = ctx.measurer.width(&text, small, TextStyle::NONE);
            let mut at = mid;
            for _step in 0..360 {
                if clear(&placed_outside, at.sin() * rim, -at.cos() * rim, tw) {
                    break;
                }
                at += 2.0 / rim;
            }
            let x = at.sin() * rim;
            let y = -at.cos() * rim;
            placed_outside.push((x, y, tw));
            outside.push_str(&format!(r#"<text x="{}" y="{}">{text}</text>"#, num(x), num(y + small * 0.35),));
        } else {
            let r = radius * text_position;
            let ink = ctx.palette.series_ink_fill(index, ctx.theme);
            labels.push_str(&format!(
                r#"<text x="{}" y="{}"{ink}>{text}</text>"#,
                num(mid.sin() * r),
                num(-mid.cos() * r + small * 0.35),
            ));
        }
        angle = end;
    }
    if slices.is_empty() {
        slices = format!(
            r#"<circle class="pele-slice" r="{}" fill="none" stroke="{}"/>"#,
            num(radius),
            ctx.theme.border(),
        );
    }

    let (lx, ly) = if legend_position == "right" {
        (cx + diameter / 2.0 + GAP, body_top + (height - legend_height) / 2.0)
    } else if legend_position == "left" {
        (pad, body_top + (height - legend_height) / 2.0)
    } else if side {
        (cx - legend_width / 2.0, cy - legend_height / 2.0)
    } else {
        (
            pad + (width - legend_width) / 2.0,
            if legend_position == "top" { body_top } else { body_top + diameter + 20.0 },
        )
    };

    let mut legend_out = String::new();
    for (index, label) in legend.iter().enumerate() {
        let y = ly + (index as f64) * ROW + ROW / 2.0;
        legend_out.push_str(&format!(
            r#"<g class="pele-legend-item" data-id="{}"><rect x="{}" y="{}" width="{}" height="{}" rx="2" fill="{}"/>{}</g>"#,
            esc_text(entries[index].0),
            num(lx),
            num(y - SWATCH / 2.0),
            num(SWATCH),
            num(SWATCH),
            ctx.theme.series_color(index, ctx.palette),
            label_svg(label, lx + SWATCH + 8.0 + label.width / 2.0, y, "", ctx.theme, ctx.icons,),
        ));
    }

    let total_width = (width + 2.0 * pad).ceil();
    let total_height = (height + title_height + 2.0 * pad).ceil();
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
    content.push_str(&format!(
        r#"<g class="pele-slices" transform="translate({},{})" stroke="{}" stroke-width="1" stroke-linejoin="round">{slices}</g>"#,
        num(cx),
        num(cy),
        ctx.theme.bg(),
    ));
    if !labels.is_empty() {
        content.push_str(&format!(
            r#"<g class="pele-slice-labels" transform="translate({},{})" font-size="{}" text-anchor="middle" fill="{}">{labels}</g>"#,
            num(cx),
            num(cy),
            num(small),
            ctx.theme.bg(),
        ));
    }
    if !outside.is_empty() {
        content.push_str(&format!(
            r#"<g class="pele-slice-labels" transform="translate({},{})" font-size="{}" text-anchor="middle">{outside}</g>"#,
            num(cx),
            num(cy),
            num(small),
        ));
    }
    if !legend_out.is_empty() {
        content.push_str(&format!(r#"<g class="pele-legend" font-size="{}">{legend_out}</g>"#, num(small),));
    }

    let svg = svg_document(
        "pie",
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
