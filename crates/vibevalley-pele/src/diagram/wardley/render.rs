use std::collections::{HashMap, HashSet};
use std::f64::consts::{FRAC_PI_6, SQRT_2};

use indexmap::IndexMap;

use crate::Rendered;
use crate::diagram::RenderContext;
use crate::diagram::common::fit_width;
use crate::diagram::xychart::db::js_number_string;
use crate::measure::TextStyle;
use crate::svg::builder::{esc, esc_text, label_svg, num, shared_style, span_style, text_style};
use crate::svg::edges::{marker, marker_trim};
use crate::svg::root::{Accessible, svg_document};
use crate::svg::theme::SvgTheme;
use crate::text::label::{Label, layout_label};
use crate::util::yaml::YamlValue;

use super::builder::{Flow, SourceStrategy, WardleyAnnotation, WardleyNode, WardleyNodeClass};
use super::model::WardleyModel;

const DEFAULT_STAGES: [&str; 4] = ["Genesis", "Custom Built", "Product", "Commodity"];
const CANVAS_MARGIN: f64 = 48.0;
const R: f64 = 6.0;
const SQUARE: f64 = 10.0;
const LABEL_OFFSET: f64 = 8.0;
const PIPELINE_PAD: f64 = 15.0;
const FORCE_WIDTH: f64 = 60.0;
const FORCE_HEIGHT: f64 = 30.0;
const FORCE_HEAD: f64 = 20.0;

struct Placed<'a> {
    x: f64,
    y: f64,
    node: &'a WardleyNode,
}

fn setting(section: Option<&IndexMap<String, YamlValue>>, key: &str, fallback: f64, min: f64, max: f64) -> f64 {
    match section.and_then(|m| m.get(key)).and_then(YamlValue::as_f64) {
        Some(v) if v >= min && v <= max => v,
        _ => fallback,
    }
}

fn start_label(label: &Label, x: f64, y: f64, attrs: &str, theme: &SvgTheme) -> String {
    let shared = shared_style(label);
    let mut body = String::new();
    let mut baseline = y;
    for line in &label.lines {
        let mut first = true;
        for span in line {
            if span.icon.is_some() {
                continue;
            }
            let style = span_style(span.style & !shared, theme);
            let pos = if first {
                format!(r#" x="{}" y="{}""#, num(x), num(baseline))
            } else {
                String::new()
            };
            body.push_str(&format!("<tspan{pos}{style}>{}</tspan>", esc(&span.text)));
            first = false;
        }
        baseline += label.line_height;
    }
    if body.is_empty() {
        String::new()
    } else {
        format!(r#"<text{} xml:space="preserve">{body}</text>"#, text_style(attrs, shared, theme))
    }
}

fn dimension(section: Option<&IndexMap<String, YamlValue>>, given: Option<f64>, key: &str, fallback: f64) -> f64 {
    let value = match given {
        Some(v) if v.is_finite() => v,
        _ => setting(section, key, fallback, 1.0, 1e6),
    };
    value.clamp(200.0, 10000.0) - 2.0 * CANVAS_MARGIN
}

pub fn render_wardley(model: &WardleyModel, ctx: &RenderContext<'_>) -> Rendered {
    let section = ctx.config.section("wardley-beta");
    let natural = dimension(section, model.data.size.map(|s| s.width), "width", 900.0);
    fit_width(ctx.options, natural, 160.0, |plot_w, tight| draw(model, section, ctx, plot_w, natural, tight))
}

fn draw<'a>(
    model: &'a WardleyModel,
    section: Option<&IndexMap<String, YamlValue>>,
    ctx: &RenderContext<'_>,
    plot_w: f64,
    natural_w: f64,
    tight: bool,
) -> Rendered {
    let size = ctx.options.font_size.unwrap_or(16.0);
    let small = (size * 0.8125).round();
    let tiny = (size * 0.6875).round();
    let pad = ctx.options.padding.unwrap_or(8.0);
    let accent = ctx.theme.accent();
    let line_color = ctx.theme.line();
    let border = ctx.theme.border();
    let muted = ctx.theme.muted();
    let surface = ctx.theme.surface();
    let surface_alt = ctx.theme.surface_alt();
    let bg = ctx.theme.bg();
    let rounded = ctx.theme.rounded_standalone();

    let plot_h = dimension(section, model.data.size.map(|s| s.height), "height", 600.0) * (plot_w / natural_w).max(0.75);
    let show_grid = section.and_then(|m| m.get("showGrid")).and_then(YamlValue::as_bool) == Some(true);

    let mut min_x = 0.0f64;
    let mut min_y = 0.0f64;
    let mut max_x = plot_w;
    let mut max_y = plot_h;
    let grow = |min_x: &mut f64, min_y: &mut f64, max_x: &mut f64, max_y: &mut f64, x0: f64, y0: f64, x1: f64, y1: f64| {
        if x0 < *min_x {
            *min_x = x0;
        }
        if y0 < *min_y {
            *min_y = y0;
        }
        if x1 > *max_x {
            *max_x = x1;
        }
        if y1 > *max_y {
            *max_y = y1;
        }
    };

    let default_wrap = if tight { (plot_w / 2.0).clamp(64.0, 120.0) } else { 4000.0 };
    let text = |raw: &str, font_size: f64, max_width: f64, style: TextStyle| -> Label {
        layout_label(Some(raw), false, ctx.measurer, font_size, max_width, style, ctx.icons, None)
    };
    let project_x = |value: f64| -> f64 { (value / 100.0) * plot_w };
    let project_y = |value: f64| -> f64 { plot_h - (value / 100.0) * plot_h };

    let default_stages: Vec<String> = DEFAULT_STAGES.iter().map(|s| (*s).to_string()).collect();
    let stages: &[String] = match &model.data.axes.stages {
        Some(s) if !s.is_empty() => s.as_slice(),
        _ => &default_stages,
    };
    let boundaries = model.data.axes.stage_boundaries.as_deref();
    let custom = boundaries.is_some_and(|b| b.len() == stages.len());

    let mut frame = String::new();
    let mut stage_labels = String::new();
    let mut stage_bottom = plot_h;
    let mut previous = 0.0f64;
    for (index, stage) in stages.iter().enumerate() {
        let start = if custom { previous } else { (index as f64) / (stages.len() as f64) };
        let end = if custom {
            boundaries.unwrap()[index].clamp(0.0, 1.0)
        } else {
            ((index + 1) as f64) / (stages.len() as f64)
        };
        previous = end;
        if index > 0 {
            frame.push_str(&format!(
                r#"<path class="pele-wardley-stage" d="M{},0V{}" stroke="{border}" stroke-dasharray="4 4"/>"#,
                num(start * plot_w),
                num(plot_h)
            ));
        }
        let label = text(stage, small, ((end - start).abs() * plot_w - 12.0).max(48.0), TextStyle::NONE);
        let cx = ((start + end) / 2.0) * plot_w;
        let cy = plot_h + 8.0 + label.height / 2.0;
        grow(
            &mut min_x,
            &mut min_y,
            &mut max_x,
            &mut max_y,
            cx - label.width / 2.0,
            cy - label.height / 2.0,
            cx + label.width / 2.0,
            cy + label.height / 2.0,
        );
        let attrs = format!(r#" class="pele-wardley-stage-label" font-size="{}" fill="{muted}""#, num(small));
        stage_labels.push_str(&label_svg(&label, cx, cy, &attrs, ctx.theme, ctx.icons));
        stage_bottom = stage_bottom.max(plot_h + 8.0 + label.height);
    }

    if show_grid {
        for i in 1..4 {
            frame.push_str(&format!(
                r#"<path class="pele-wardley-grid" d="M{},0V{}M0,{}H{}" stroke="{border}" stroke-dasharray="2 6"/>"#,
                num((plot_w * (i as f64)) / 4.0),
                num(plot_h),
                num((plot_h * (i as f64)) / 4.0),
                num(plot_w)
            ));
        }
    }
    frame.push_str(&format!(
        r#"<path class="pele-wardley-axis" d="M0,0V{}H{}" stroke="{line_color}"/>"#,
        num(plot_h),
        num(plot_w)
    ));

    let x_title = text(model.data.axes.x_label.as_deref().unwrap_or("Evolution"), small, default_wrap, TextStyle::NONE);
    let y_title = text(model.data.axes.y_label.as_deref().unwrap_or("Visibility"), small, default_wrap, TextStyle::NONE);
    let axis_attrs = format!(
        r#" class="pele-wardley-axis-label" font-size="{}" font-weight="{}""#,
        num(small),
        ctx.theme.heading_weight()
    );
    let x_title_cy = stage_bottom + 6.0 + x_title.height / 2.0;
    grow(
        &mut min_x,
        &mut min_y,
        &mut max_x,
        &mut max_y,
        plot_w / 2.0 - x_title.width / 2.0,
        x_title_cy - x_title.height / 2.0,
        plot_w / 2.0 + x_title.width / 2.0,
        x_title_cy + x_title.height / 2.0,
    );
    let y_axis_attrs = format!(r#"{axis_attrs} transform="rotate(-90 -16 {})""#, num(plot_h / 2.0));
    let axis_labels = format!(
        "{}{}",
        label_svg(&x_title, plot_w / 2.0, x_title_cy, &axis_attrs, ctx.theme, ctx.icons),
        label_svg(&y_title, -16.0, plot_h / 2.0, &y_axis_attrs, ctx.theme, ctx.icons)
    );
    grow(&mut min_x, &mut min_y, &mut max_x, &mut max_y, -16.0 - y_title.height / 2.0, 0.0, 0.0, 0.0);
    let legend_top = stage_bottom + 6.0 + x_title.height + 10.0;

    let mut positions: IndexMap<&str, Placed<'_>> = IndexMap::new();
    for node in &model.data.nodes {
        positions.insert(
            node.id.as_str(),
            Placed {
                x: project_x(node.x.unwrap_or(0.0)),
                y: project_y(node.y.unwrap_or(0.0)),
                node,
            },
        );
    }

    let mut pipelines = String::new();
    let mut members: HashMap<&str, HashSet<&str>> = HashMap::new();
    for pipeline in &model.data.pipelines {
        members.insert(pipeline.node_id.as_str(), pipeline.component_ids.iter().map(String::as_str).collect());
        let mut xs: Vec<(f64, f64)> = pipeline
            .component_ids
            .iter()
            .filter_map(|id| positions.get(id.as_str()).map(|p| (p.x, p.y)))
            .collect();
        if xs.is_empty() {
            continue;
        }
        xs.sort_by(|a, b| a.0.total_cmp(&b.0));
        let left = xs[0].0;
        let right = xs[xs.len() - 1].0;
        let y = xs[0].1;
        let top = y - 2.0 * R;
        if let Some(parent) = positions.get_mut(pipeline.node_id.as_str()) {
            parent.x = (left + right) / 2.0;
            parent.y = top - SQUARE / 6.0;
        }
        grow(
            &mut min_x,
            &mut min_y,
            &mut max_x,
            &mut max_y,
            left - PIPELINE_PAD,
            top,
            right + PIPELINE_PAD,
            top + 4.0 * R,
        );
        pipelines.push_str(&format!(
            r#"<g class="pele-wardley-pipeline" data-id="{}"><rect x="{}" y="{}" width="{}" height="{}" fill="{surface}" stroke="{border}"{rounded}/>"#,
            esc_text(&pipeline.node_id),
            num(left - PIPELINE_PAD),
            num(top),
            num(right - left + 2.0 * PIPELINE_PAD),
            num(4.0 * R),
        ));
        if xs.len() > 1 {
            pipelines.push_str(&format!(
                r#"<path d="M{},{}H{}" stroke="{line_color}" stroke-dasharray="4 4"/>"#,
                num(left),
                num(y),
                num(right)
            ));
        }
        pipelines.push_str("</g>");
    }

    let anchor_wrap = if tight { (plot_w / 2.0).max(64.0) } else { 4000.0 };
    let mut anchor_labels: HashMap<&str, Label> = HashMap::new();
    let mut reach = |node: &'a WardleyNode, ux: f64, uy: f64| -> f64 {
        if node.class_name == Some(WardleyNodeClass::Anchor) {
            let label = anchor_labels
                .entry(node.id.as_str())
                .or_insert_with(|| text(&node.label, small, anchor_wrap, TextStyle::BOLD));
            return 1.0 / (ux / (label.width / 2.0 + 5.0)).hypot(uy / (small * 0.8));
        }
        if node.is_pipeline_parent {
            return SQUARE / SQRT_2;
        }
        if node.source_strategy.is_some() { 2.0 * R } else { R }
    };

    let mut taken: HashMap<&str, u8> = HashMap::new();
    let occupy = |taken: &mut HashMap<&'a str, u8>, id: &'a str, ux: f64, uy: f64| {
        if ux.abs() < 0.25 || uy.abs() < 0.25 {
            return;
        }
        let bit = if ux > 0.0 {
            if uy < 0.0 { 1 } else { 2 }
        } else if uy < 0.0 {
            4
        } else {
            8
        };
        *taken.entry(id).or_insert(0) |= bit;
    };

    let mut links = String::new();
    let trim = marker_trim("arrow_point");
    for link in &model.data.links {
        let (Some(from), Some(to)) = (positions.get(link.source.as_str()), positions.get(link.target.as_str())) else {
            continue;
        };
        if link.source == link.target {
            continue;
        }
        if members.get(link.target.as_str()).is_some_and(|set| set.contains(link.source.as_str())) {
            continue;
        }
        let dx = to.x - from.x;
        let dy = to.y - from.y;
        let distance = dx.hypot(dy);
        if distance < 0.01 {
            continue;
        }
        let ux = dx / distance;
        let uy = dy / distance;
        let start = reach(from.node, ux, uy);
        let end = reach(to.node, ux, uy);
        if start + end >= distance {
            continue;
        }
        occupy(&mut taken, from.node.id.as_str(), ux, uy);
        occupy(&mut taken, to.node.id.as_str(), -ux, -uy);
        let mut x1 = from.x + ux * start;
        let mut y1 = from.y + uy * start;
        let mut x2 = to.x - ux * end;
        let mut y2 = to.y - uy * end;
        let mut heads = String::new();
        if matches!(link.flow, Some(Flow::Forward | Flow::Bidirectional)) {
            heads.push_str(&marker("arrow_point", x2, y2, ux, uy, line_color, "none"));
            x2 -= ux * trim;
            y2 -= uy * trim;
        }
        if matches!(link.flow, Some(Flow::Backward | Flow::Bidirectional)) {
            heads.push_str(&marker("arrow_point", x1, y1, -ux, -uy, line_color, "none"));
            x1 += ux * trim;
            y1 += uy * trim;
        }
        let mut caption = String::new();
        if let Some(raw_label) = &link.label
            && !raw_label.is_empty()
        {
            let label = text(raw_label, tiny + 1.0, 200.0, TextStyle::NONE);
            let side = if ux >= 0.0 { 1.0 } else { -1.0 };
            let px = uy * side;
            let py = -ux * side;
            let away = 5.0 + (px.abs() * label.width) / 2.0 + (py.abs() * label.height) / 2.0;
            let cx = (from.x + to.x) / 2.0 + px * away;
            let cy = (from.y + to.y) / 2.0 + py * away;
            grow(
                &mut min_x,
                &mut min_y,
                &mut max_x,
                &mut max_y,
                cx - label.width / 2.0,
                cy - label.height / 2.0,
                cx + label.width / 2.0,
                cy + label.height / 2.0,
            );
            let attrs = format!(r#" class="pele-edge-label" font-size="{}" fill="{muted}""#, num(tiny + 1.0));
            caption = label_svg(&label, cx, cy, &attrs, ctx.theme, ctx.icons);
        }
        let cls = if link.dashed { "pele-edge pele-wardley-dashed" } else { "pele-edge" };
        let dash = if link.dashed { r#" stroke-dasharray="6 6""# } else { "" };
        links.push_str(&format!(
            r#"<g class="{cls}" data-id="{}-{}"><path d="M{},{}L{},{}" stroke="{line_color}"{dash}/>{heads}{caption}</g>"#,
            esc_text(&link.source),
            esc_text(&link.target),
            num(x1),
            num(y1),
            num(x2),
            num(y2),
        ));
    }

    let mut trends = String::new();
    for trend in &model.data.trends {
        let Some(origin) = positions.get(trend.node_id.as_str()) else {
            continue;
        };
        let tx = project_x(trend.target_x);
        let ty = project_y(trend.target_y);
        let dx = tx - origin.x;
        let dy = ty - origin.y;
        let distance = dx.hypot(dy);
        let mut arrow = String::new();
        let start = if distance > 0.0 {
            reach(origin.node, dx / distance, dy / distance)
        } else {
            0.0
        };
        if distance > start + R + 4.0 {
            let ux = dx / distance;
            let uy = dy / distance;
            let ex = tx - ux * (R + 2.0);
            let ey = ty - uy * (R + 2.0);
            arrow = format!(
                r#"<path d="M{},{}L{},{}" stroke="{accent}" stroke-dasharray="4 4"/>{}"#,
                num(origin.x + ux * start),
                num(origin.y + uy * start),
                num(ex - ux * trim),
                num(ey - uy * trim),
                marker("arrow_point", ex, ey, ux, uy, accent, "none"),
            );
        }
        grow(&mut min_x, &mut min_y, &mut max_x, &mut max_y, tx - R, ty - R, tx + R, ty + R);
        trends.push_str(&format!(
            r#"<g class="pele-wardley-trend" data-id="{}">{arrow}<circle cx="{}" cy="{}" r="{}" fill="{bg}" stroke="{accent}"/></g>"#,
            esc_text(&trend.node_id),
            num(tx),
            num(ty),
            num(R),
        ));
    }

    let mut nodes_out = String::new();
    let tri = 1.2 * R;
    let dot = 0.7 * R;
    for at in positions.values() {
        let node = at.node;
        let x = at.x;
        let y = at.y;
        let anchor = node.class_name == Some(WardleyNodeClass::Anchor);
        let strategy = node.source_strategy;
        let mut shape = String::new();
        if let Some(strat) = strategy {
            let fill = match strat {
                SourceStrategy::Outsource => muted,
                SourceStrategy::Buy => surface_alt,
                SourceStrategy::Build => surface,
                SourceStrategy::Market => bg,
            };
            shape.push_str(&format!(
                r#"<circle class="pele-wardley-{}" cx="{}" cy="{}" r="{}" fill="{fill}" stroke="{line_color}"/>"#,
                strat.as_str(),
                num(x),
                num(y),
                num(2.0 * R),
            ));
        }
        if strategy == Some(SourceStrategy::Market) {
            let bx = tri * FRAC_PI_6.cos();
            let by = y + tri * FRAC_PI_6.sin();
            shape.push_str(&format!(
                r#"<path d="M{},{}L{},{}H{}Z" fill="none" stroke="{line_color}"/>"#,
                num(x),
                num(y - tri),
                num(x - bx),
                num(by),
                num(x + bx),
            ));
            for (cx, cy) in [(x, y - tri), (x - bx, by), (x + bx, by)] {
                shape.push_str(&format!(
                    r#"<circle cx="{}" cy="{}" r="{}" fill="{bg}" stroke="{line_color}"/>"#,
                    num(cx),
                    num(cy),
                    num(dot),
                ));
            }
        } else if node.is_pipeline_parent {
            shape.push_str(&format!(
                r#"<rect x="{}" y="{}" width="{}" height="{}" fill="{bg}" stroke="{line_color}"/>"#,
                num(x - SQUARE / 2.0),
                num(y - SQUARE / 2.0),
                num(SQUARE),
                num(SQUARE),
            ));
        } else if !anchor {
            shape.push_str(&format!(
                r#"<circle cx="{}" cy="{}" r="{}" fill="{bg}" stroke="{line_color}"/>"#,
                num(x),
                num(y),
                num(R),
            ));
        }
        if node.inertia == Some(true) {
            let offset = (if node.is_pipeline_parent { SQUARE / 2.0 } else { R }) + 10.0 + if strategy.is_some() { R + 4.0 } else { 0.0 };
            shape.push_str(&format!(
                r#"<rect class="pele-wardley-inertia" x="{}" y="{}" width="4" height="{}" fill="{line_color}"/>"#,
                num(x + offset),
                num(y - R),
                num(2.0 * R),
            ));
        }

        let ox = node.label_offset_x.map(|v| v.clamp(-5000.0, 5000.0));
        let oy = node.label_offset_y.map(|v| v.clamp(-5000.0, 5000.0));
        let caption = if anchor {
            let label = anchor_labels
                .remove(node.id.as_str())
                .unwrap_or_else(|| text(&node.label, small, anchor_wrap, TextStyle::BOLD));
            let cx = x + ox.unwrap_or(0.0);
            let cy = y + oy.unwrap_or(-3.0);
            grow(
                &mut min_x,
                &mut min_y,
                &mut max_x,
                &mut max_y,
                cx - label.width / 2.0,
                cy - label.height / 2.0,
                cx + label.width / 2.0,
                cy + label.height / 2.0,
            );
            let attrs = format!(r#" class="pele-label" font-size="{}" font-weight="{}""#, num(small), ctx.theme.heading_weight());
            label_svg(&label, cx, cy, &attrs, ctx.theme, ctx.icons)
        } else {
            let label = text(&node.label, small, default_wrap, TextStyle::NONE);
            let attrs = format!(r#" class="pele-label" font-size="{}""#, num(small));
            let lift = LABEL_OFFSET + if strategy.is_some() { 10.0 } else { 0.0 };
            if ox.is_some() || oy.is_some() {
                let sx = x + ox.unwrap_or(lift);
                let sy = y + oy.unwrap_or(-lift);
                grow(
                    &mut min_x,
                    &mut min_y,
                    &mut max_x,
                    &mut max_y,
                    sx,
                    sy - label.size,
                    sx + label.width,
                    sy - label.size + label.height + 4.0,
                );
                start_label(&label, sx, sy, &attrs, ctx.theme)
            } else if node.in_pipeline {
                let cy = y + 2.0 * R + 4.0 + label.height / 2.0;
                grow(
                    &mut min_x,
                    &mut min_y,
                    &mut max_x,
                    &mut max_y,
                    x - label.width / 2.0,
                    cy - label.height / 2.0,
                    x + label.width / 2.0,
                    cy + label.height / 2.0,
                );
                label_svg(&label, x, cy, &attrs, ctx.theme, ctx.icons)
            } else {
                let busy = taken.get(node.id.as_str()).copied().unwrap_or(0);
                let corner = if (busy & 1) == 0 {
                    1
                } else if (busy & 2) == 0 {
                    2
                } else if (busy & 4) == 0 {
                    4
                } else if (busy & 8) == 0 {
                    8
                } else {
                    1
                };
                let right = corner == 1 || corner == 2;
                let up = corner == 1 || corner == 4;
                let sx = if right { x + lift } else { x - lift - label.width };
                let sy = if up { y - lift } else { y + lift + small * 0.75 };
                grow(
                    &mut min_x,
                    &mut min_y,
                    &mut max_x,
                    &mut max_y,
                    sx,
                    sy - label.size,
                    sx + label.width,
                    sy - label.size + label.height + 4.0,
                );
                start_label(&label, sx, sy, &attrs, ctx.theme)
            }
        };
        grow(
            &mut min_x,
            &mut min_y,
            &mut max_x,
            &mut max_y,
            x - 2.0 * R,
            y - 2.0 * R,
            x + 2.0 * R + 20.0,
            y + 2.0 * R,
        );
        let kind_cls = if anchor {
            "anchor"
        } else if node.is_pipeline_parent {
            "pipeline-parent"
        } else if node.in_pipeline {
            "pipeline-component"
        } else {
            "component"
        };
        nodes_out.push_str(&format!(
            r#"<g class="pele-node pele-wardley-{kind_cls}" data-id="{}">{shape}{caption}</g>"#,
            esc_text(&node.id)
        ));
    }

    let mut annotations = String::new();
    for annotation in &model.data.annotations {
        let num_str = js_number_string(annotation.number);
        let label = text(&num_str, tiny, 4000.0, TextStyle::BOLD);
        let mut marks = String::new();
        let mark_attrs = format!(r#" font-size="{}" font-weight="{}""#, num(tiny), ctx.theme.heading_weight());
        for coord in &annotation.coordinates {
            let x = project_x(coord.x);
            let y = project_y(coord.y);
            let r = 10.0f64.max(label.width / 2.0 + 4.0);
            grow(&mut min_x, &mut min_y, &mut max_x, &mut max_y, x - r, y - r, x + r, y + r);
            marks.push_str(&format!(
                r#"<circle cx="{}" cy="{}" r="{}" fill="{bg}" stroke="{line_color}"/>{}"#,
                num(x),
                num(y),
                num(r),
                label_svg(&label, x, y, &mark_attrs, ctx.theme, ctx.icons)
            ));
        }
        annotations.push_str(&format!(r#"<g class="pele-wardley-annotation" data-id="{}">{marks}</g>"#, esc_text(&num_str)));
    }

    let mut listed: Vec<&WardleyAnnotation> = model
        .data
        .annotations
        .iter()
        .filter(|a| a.text.as_deref().is_some_and(|t| !t.is_empty()))
        .collect();
    listed.sort_by(|a, b| a.number.total_cmp(&b.number));
    if !listed.is_empty() {
        let wrap = if tight { (plot_w - 20.0).max(80.0) } else { 320.0 };
        let lines: Vec<Label> = listed
            .iter()
            .map(|a| {
                let row = format!("{}. {}", js_number_string(a.number), a.text.as_deref().unwrap_or(""));
                text(&row, small, wrap, TextStyle::NONE)
            })
            .collect();
        let mut width = 0.0f64;
        let mut height = 0.0f64;
        for line in &lines {
            width = width.max(line.width);
            height += line.height;
        }
        width += 20.0;
        height += 14.0;
        let (bx, by) = match model.data.annotations_box {
            Some(b) => (
                project_x(b.x).clamp(0.0, (plot_w - width).max(0.0)),
                project_y(b.y).clamp(0.0, (plot_h - height).max(0.0)),
            ),
            None => (0.0, legend_top),
        };
        grow(&mut min_x, &mut min_y, &mut max_x, &mut max_y, bx, by, bx + width, by + height);
        let mut rows = String::new();
        let mut y = by + 7.0;
        let row_attrs = format!(r#" font-size="{}""#, num(small));
        for line in &lines {
            rows.push_str(&start_label(line, bx + 10.0, y + line.line_height / 2.0 + small * 0.35, &row_attrs, ctx.theme));
            y += line.height;
        }
        annotations.push_str(&format!(
            r#"<g class="pele-wardley-annotations"><rect x="{}" y="{}" width="{}" height="{}" fill="{bg}" stroke="{border}"{rounded}/>{rows}</g>"#,
            num(bx),
            num(by),
            num(width),
            num(height),
        ));
    }

    let mut notes_out = String::new();
    let note_attrs = format!(
        r#" class="pele-wardley-note" font-size="{}" font-weight="{}""#,
        num(small),
        ctx.theme.heading_weight()
    );
    for note in &model.data.notes {
        let label = text(&note.text, small, 360.0f64.min(plot_w * 0.6), TextStyle::BOLD);
        let sx = project_x(note.x);
        let sy = project_y(note.y);
        grow(
            &mut min_x,
            &mut min_y,
            &mut max_x,
            &mut max_y,
            sx,
            sy - label.size,
            sx + label.width,
            sy - label.size + label.height + 4.0,
        );
        notes_out.push_str(&start_label(&label, sx, sy, &note_attrs, ctx.theme));
    }

    let mut forces = String::new();
    let force_label_attrs = format!(r#" font-size="{}" font-weight="{}""#, num(tiny + 1.0), ctx.theme.heading_weight());
    let mut draw_force = |name: &str, px: f64, py: f64, forward: bool| {
        let x = project_x(px);
        let y = project_y(py);
        let half = FORCE_HEIGHT / 2.0;
        let tip = if forward { x + FORCE_WIDTH } else { x };
        let tail = if forward { x } else { x + FORCE_WIDTH };
        let neck = if forward { x + FORCE_WIDTH - FORCE_HEAD } else { x + FORCE_HEAD };
        let d = format!(
            "M{},{}H{}V{}L{},{}L{},{}V{}H{}Z",
            num(tail),
            num(y - half),
            num(neck),
            num(y - half - 8.0),
            num(tip),
            num(y),
            num(neck),
            num(y + half + 8.0),
            num(y + half),
            num(tail),
        );
        grow(
            &mut min_x,
            &mut min_y,
            &mut max_x,
            &mut max_y,
            x,
            y - half - 8.0,
            x + FORCE_WIDTH,
            y + half + 8.0,
        );
        let label = text(name, tiny + 1.0, 160.0, TextStyle::BOLD);
        let cx = x + FORCE_WIDTH / 2.0;
        let cy = y + half + 8.0 + 12.0;
        grow(
            &mut min_x,
            &mut min_y,
            &mut max_x,
            &mut max_y,
            cx - label.width / 2.0,
            cy - label.height / 2.0,
            cx + label.width / 2.0,
            cy + label.height / 2.0,
        );
        let cls = if forward { "accelerator" } else { "deaccelerator" };
        forces.push_str(&format!(
            r#"<g class="pele-wardley-{cls}" data-id="{}"><path d="{d}" fill="{surface}" stroke="{line_color}"/>{}</g>"#,
            esc_text(name),
            label_svg(&label, cx, cy, &force_label_attrs, ctx.theme, ctx.icons),
        ));
    };
    for a in &model.data.accelerators {
        draw_force(&a.name, a.x, a.y, true);
    }
    for d in &model.data.deaccelerators {
        draw_force(&d.name, d.x, d.y, false);
    }

    let title_wrap = if tight { plot_w.max(80.0) } else { 4000.0 };
    let title = layout_label(model.title.as_deref(), false, ctx.measurer, size, title_wrap, TextStyle::BOLD, ctx.icons, None);
    let title_height = if title.height > 0.0 { title.height + 12.0 } else { 0.0 };
    let left = min_x.min(plot_w / 2.0 - title.width / 2.0);
    let right = max_x.max(plot_w / 2.0 + title.width / 2.0);
    let tx = pad - left;
    let ty = pad + title_height - min_y;
    let total_width = (right - left + 2.0 * pad).ceil();
    let total_height = (max_y - min_y + title_height + 2.0 * pad).ceil();

    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let mut content = String::new();
    content.push_str(&label_svg(
        &title,
        tx + plot_w / 2.0,
        pad + title.height / 2.0,
        &title_attrs,
        ctx.theme,
        ctx.icons,
    ));
    content.push_str(&format!(r#"<g transform="translate({},{})">"#, num(tx), num(ty)));
    content.push_str(&format!(r#"<g class="pele-wardley-frame" fill="none">{frame}</g>"#));
    content.push_str(&stage_labels);
    content.push_str(&axis_labels);
    content.push_str(&pipelines);
    if !links.is_empty() {
        content.push_str(&format!(r#"<g class="pele-edges" fill="none">{links}</g>"#));
    }
    if !trends.is_empty() {
        content.push_str(&format!(r#"<g class="pele-wardley-trends" fill="none">{trends}</g>"#));
    }
    content.push_str(&nodes_out);
    content.push_str(&annotations);
    content.push_str(&notes_out);
    content.push_str(&forces);
    content.push_str("</g>");

    let svg = svg_document(
        "wardley",
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
