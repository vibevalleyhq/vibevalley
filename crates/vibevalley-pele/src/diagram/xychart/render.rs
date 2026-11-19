use indexmap::IndexMap;

use crate::Rendered;
use crate::detect::DiagramType;
use crate::diagram::RenderContext;
use crate::diagram::common::cap_width;
use crate::error::{ErrorCode, PeleError};
use crate::measure::TextStyle;
use crate::svg::builder::{esc, esc_text, label_svg, num};
use crate::svg::root::{Accessible, svg_document};
use crate::text::label::{Label, layout_label};
use crate::util::yaml::YamlValue;

use super::db::{Orientation, PlotKind, XyAxis, XyChartModel, js_number_string};
use super::ticks::{tick_index, tick_step, tick_value, ticks_between};

const TICK: f64 = 4.0;
const SWATCH: f64 = 12.0;
const ROW: f64 = 26.0;
const LEGEND_GAP: f64 = 24.0;
const LIMIT: f64 = 1e300;

struct Mark {
    at: f64,
    label: Label,
}

fn on(section: Option<&IndexMap<String, YamlValue>>, key: &str, fallback: bool) -> bool {
    section.and_then(|m| m.get(key)).and_then(YamlValue::as_bool).unwrap_or(fallback)
}

fn dimension(section: Option<&IndexMap<String, YamlValue>>, key: &str, fallback: f64) -> f64 {
    match section.and_then(|m| m.get(key)).and_then(YamlValue::as_f64) {
        Some(v) if v > 0.0 => v.clamp(100.0, 4000.0).round(),
        _ => fallback,
    }
}

fn finite(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite()).map(|v| v.clamp(-LIMIT, LIMIT))
}

fn widest(marks: &[Mark]) -> f64 {
    marks.iter().map(|m| m.label.width).fold(0.0f64, f64::max)
}

fn aligned(label: &Label, x: f64, y: f64, anchor: &str, ctx: &RenderContext<'_>) -> String {
    if label.lines.len() == 1 && label.lines[0].len() == 1 {
        let only = &label.lines[0][0];
        if only.icon.is_none() && only.math.is_none() && only.style.is_empty() {
            return format!(
                r#"<text x="{}" y="{}" text-anchor="{anchor}">{}</text>"#,
                num(x),
                num(y + label.size * 0.35),
                esc(&only.text)
            );
        }
    }
    let dx = match anchor {
        "start" => label.width / 2.0,
        "end" => -label.width / 2.0,
        _ => 0.0,
    };
    label_svg(label, x + dx, y, "", ctx.theme, ctx.icons)
}

pub fn render_xychart(model: &XyChartModel, ctx: &RenderContext<'_>) -> Result<Rendered, PeleError> {
    if model.plots.is_empty() {
        return Err(PeleError::new("No Plot to render, please provide a plot with some data", ErrorCode::Semantic).with_diagram_type(DiagramType::XyChart));
    }

    let chart = ctx.config.section("xyChart");
    let size = ctx.options.font_size.unwrap_or(16.0);
    let small = (size * 0.875).round();
    let tiny = (size * 0.75).round();
    let pad = ctx.options.padding.unwrap_or(8.0);
    let natural = dimension(chart, "width", 700.0);
    let width = cap_width(ctx.options, natural, 240.0, 0.0);
    let height = (dimension(chart, "height", 500.0) * (width / natural).max(0.6)).round();

    let cfg_horizontal = chart
        .and_then(|m| m.get("chartOrientation"))
        .and_then(YamlValue::as_str)
        .is_some_and(|s| s == "horizontal");
    let horizontal = match model.orientation {
        Some(Orientation::Horizontal) => true,
        Some(Orientation::Vertical) => false,
        None => cfg_horizontal,
    };
    let show_values = on(chart, "showDataLabel", false);
    let x = &model.x_axis;
    let plots = &model.plots;

    let text =
        |raw: Option<&str>, font_size: f64, max: f64| -> Label { layout_label(raw, false, ctx.measurer, font_size, max, TextStyle::NONE, ctx.icons, None) };
    let line_height = text(Some("0"), small, 4000.0).height;
    let tiny_height = text(Some("0"), tiny, 4000.0).height;

    let title = layout_label(
        if on(chart, "showTitle", true) { model.title.as_deref() } else { None },
        false,
        ctx.measurer,
        size,
        width - 2.0 * pad,
        TextStyle::BOLD,
        ctx.icons,
        None,
    );
    let title_space = if title.height > 0.0 { title.height + 12.0 } else { 0.0 };

    let mut legend: Vec<(usize, Label)> = Vec::new();
    let mut legend_width = 0.0f64;
    if on(chart, "showLegend", true) {
        for (index, plot) in plots.iter().enumerate() {
            if plot.title.is_empty() {
                continue;
            }
            let label = text(Some(&plot.title), small, width * 0.3);
            legend_width = legend_width.max(label.width + SWATCH + 8.0);
            legend.push((index, label));
        }
    }
    let legend_space = if !legend.is_empty() { legend_width + LEGEND_GAP } else { 0.0 };

    let bars = plots.iter().filter(|p| p.kind == PlotKind::Bar).count();
    let mut lo = finite(Some(model.y_min)).unwrap_or(f64::INFINITY);
    let mut hi = finite(Some(model.y_max)).unwrap_or(f64::NEG_INFINITY);
    let exact = model.has_set_y_axis && lo.is_finite() && hi.is_finite() && lo != hi;
    if !exact {
        lo = f64::INFINITY;
        hi = f64::NEG_INFINITY;
        for plot in plots {
            for &(_, raw) in &plot.data {
                let Some(value) = finite(raw) else { continue };
                if value < lo {
                    lo = value;
                }
                if value > hi {
                    hi = value;
                }
            }
        }
        if lo > hi {
            lo = 0.0;
            hi = 0.0;
        }
        if bars > 0 {
            lo = lo.min(0.0);
            hi = hi.max(0.0);
        }
        if lo == hi {
            if lo == 0.0 {
                hi = 1.0;
            } else {
                let half = lo.abs() / 2.0;
                lo -= half;
                hi += half;
            }
        }
    }

    let mut value_marks = |length: f64, spacing: f64| -> Vec<Mark> {
        let count = (length / spacing).floor().clamp(2.0, 10.0);
        let step = tick_step((hi - lo).abs(), count);
        if !exact {
            lo = tick_value(step, (tick_index(step, lo) + 1e-9).floor());
            hi = tick_value(step, (tick_index(step, hi) - 1e-9).ceil());
        }
        ticks_between(lo.min(hi), lo.max(hi), step)
            .into_iter()
            .map(|value| Mark {
                at: (value - lo) / (hi - lo),
                label: text(Some(&js_number_string(value)), small, 4000.0),
            })
            .collect()
    };

    let count = match x {
        XyAxis::Band { categories, .. } => categories.len().max(1),
        XyAxis::Linear { .. } => plots.iter().map(|p| p.data.len()).max().unwrap_or(1).max(1),
    };
    let slot = 1.0 / (count as f64);
    let is_band = matches!(x, XyAxis::Band { .. });
    let inset = if is_band || bars > 0 { slot / 2.0 } else { 0.0 };
    let (x0, x1) = match x {
        XyAxis::Linear { min, max, .. } => (finite(Some(*min)), finite(Some(*max))),
        XyAxis::Band { .. } => (None, None),
    };
    let ranged = x0.is_some() && x1.is_some() && x0 != x1;
    let place = |i: usize, n: usize| -> f64 {
        if is_band {
            (i as f64 + 0.5) * slot
        } else {
            let frac = if n > 1 {
                (i as f64) / ((n - 1) as f64)
            } else if ranged {
                0.0
            } else {
                0.5
            };
            inset + frac * (1.0 - 2.0 * inset)
        }
    };

    let category_conf = chart.and_then(|m| m.get("xAxis")).and_then(YamlValue::as_map);
    let value_conf = chart.and_then(|m| m.get("yAxis")).and_then(YamlValue::as_map);
    let left_conf = if horizontal { category_conf } else { value_conf };
    let bottom_conf = if horizontal { value_conf } else { category_conf };

    let left_title_raw = if on(left_conf, "showTitle", true) {
        Some(if horizontal { x.title() } else { model.y_axis_title.as_str() })
    } else {
        None
    };
    let bottom_title_raw = if on(bottom_conf, "showTitle", true) {
        Some(if horizontal { model.y_axis_title.as_str() } else { x.title() })
    } else {
        None
    };
    let left_title = text(left_title_raw, small, height * 0.8);
    let bottom_title = text(bottom_title_raw, small, width * 0.8);
    let left_tick = if on(left_conf, "showTick", true) { TICK } else { 0.0 };
    let bottom_tick = if on(bottom_conf, "showTick", true) { TICK } else { 0.0 };
    let left_labels = on(left_conf, "showLabel", true);
    let bottom_labels = on(bottom_conf, "showLabel", true);

    let wrap_at = if horizontal {
        width * 0.3
    } else {
        48.0f64.max((width - 2.0 * pad - 64.0 - legend_space) * slot - 8.0)
    };
    let categories: Vec<Label> = match x {
        XyAxis::Band { categories, .. } if on(category_conf, "showLabel", true) => categories.iter().map(|c| text(Some(c.as_str()), small, wrap_at)).collect(),
        XyAxis::Band { .. } | XyAxis::Linear { .. } => Vec::new(),
    };
    let mut category_width = 0.0f64;
    let mut category_height = 0.0f64;
    for label in &categories {
        category_width = category_width.max(label.width);
        category_height = category_height.max(label.height);
    }

    let category_marks = |length: f64| -> Vec<Mark> {
        let mut marks = Vec::new();
        match x {
            XyAxis::Band { categories: cats, .. } => {
                let need = if categories.is_empty() {
                    8.0
                } else if horizontal {
                    category_height
                } else {
                    category_width + 12.0
                };
                let every = ((need / (length * slot)).ceil() as usize).max(1);
                let mut i = 0;
                while i < cats.len() {
                    let label = categories.get(i).cloned().unwrap_or_else(|| text(None, small, 0.0));
                    marks.push(Mark {
                        at: (i as f64 + 0.5) * slot,
                        label,
                    });
                    i += every;
                }
            }
            XyAxis::Linear { .. } => {
                if let (Some(a), Some(b)) = (x0, x1) {
                    if a != b {
                        let spacing = if horizontal { 32.0 } else { 80.0 };
                        let step = tick_step((b - a).abs(), (length / spacing).floor().clamp(2.0, 10.0));
                        for value in ticks_between(a.min(b), a.max(b), step) {
                            marks.push(Mark {
                                at: inset + ((value - a) / (b - a)) * (1.0 - 2.0 * inset),
                                label: text(Some(&js_number_string(value)), small, 4000.0),
                            });
                        }
                    } else {
                        marks.push(Mark {
                            at: 0.5,
                            label: text(Some(&js_number_string(a)), small, 4000.0),
                        });
                    }
                }
            }
        }
        marks
    };

    let mut point_label_width = 0.0f64;
    let mut value_width = 0.0f64;
    for plot in plots {
        if let Some(plabels) = &plot.point_labels {
            for label in plabels {
                point_label_width = point_label_width.max(ctx.measurer.width(label, tiny, TextStyle::NONE));
            }
        }
        if show_values && horizontal && plot.kind == PlotKind::Bar {
            for &(_, raw) in &plot.data {
                if let Some(v) = finite(raw) {
                    let s = js_number_string(v);
                    value_width = value_width.max(ctx.measurer.width(&s, tiny, TextStyle::NONE));
                }
            }
        }
    }

    let bottom_label_height = if !bottom_labels {
        0.0
    } else if horizontal || !is_band {
        line_height
    } else {
        category_height
    };
    let bottom_space = bottom_tick
        + if bottom_label_height > 0.0 { bottom_label_height + 4.0 } else { 0.0 }
        + if bottom_title.height > 0.0 { bottom_title.height + 4.0 } else { 0.0 };
    let headroom = if horizontal {
        0.0
    } else if point_label_width > 0.0 || show_values {
        tiny_height + 4.0
    } else if left_labels {
        line_height / 2.0
    } else {
        0.0
    };
    let top = pad + title_space + headroom;
    let plot_height = (height - pad - bottom_space - top).max(1.0);
    let bottom = top + plot_height;

    let left_marks = if horizontal {
        category_marks(plot_height)
    } else {
        value_marks(plot_height, 56.0)
    };
    let left_label_width = if left_labels { widest(&left_marks) } else { 0.0 };
    let left = pad
        + if left_title.height > 0.0 { left_title.height + 6.0 } else { 0.0 }
        + if left_label_width > 0.0 { left_label_width + 6.0 } else { 0.0 }
        + left_tick;
    let beside = (if point_label_width > 0.0 { point_label_width + 12.0 } else { 0.0 }).max(if value_width > 0.0 { value_width + 8.0 } else { 0.0 });
    let reach = if horizontal { (width * 0.25).min(beside) } else { 0.0 };
    let mut plot_width = (width - pad - left - legend_space - reach).max(1.0);
    let bottom_marks = if horizontal {
        value_marks(plot_width, 80.0)
    } else {
        category_marks(plot_width)
    };
    if bottom_labels && legend_space + reach == 0.0 {
        let mut over = 0.0f64;
        for mark in &bottom_marks {
            over = over.max(mark.at * plot_width + mark.label.width / 2.0 - plot_width);
        }
        plot_width = (plot_width - over).max(1.0);
    }
    let right = left + plot_width;

    let px = |c: f64, v: f64| -> f64 { if horizontal { left + v * plot_width } else { left + c * plot_width } };
    let py = |c: f64, v: f64| -> f64 { if horizontal { top + c * plot_height } else { bottom - v * plot_height } };
    let scale = |value: f64| -> f64 { (value - lo) / (hi - lo) };
    let clamp01 = |v: f64| -> f64 { v.clamp(0.0, 1.0) };

    let rule = |v: f64| -> String {
        if horizontal {
            format!("M{},{}V{}", num(px(0.0, v)), num(top), num(bottom))
        } else {
            format!("M{},{}H{}", num(left), num(py(0.0, v)), num(right))
        }
    };

    let mut grid = String::new();
    for mark in if horizontal { &bottom_marks } else { &left_marks } {
        grid.push_str(&rule(mark.at));
    }

    let mut axis = String::new();
    let mut labels = String::new();
    if on(left_conf, "showAxisLine", true) {
        axis.push_str(&format!("M{},{}V{}", num(left), num(top), num(bottom)));
    }
    if on(bottom_conf, "showAxisLine", true) {
        axis.push_str(&format!("M{},{}H{}", num(left), num(bottom), num(right)));
    }
    for mark in &left_marks {
        let y = if horizontal {
            top + mark.at * plot_height
        } else {
            bottom - mark.at * plot_height
        };
        if left_tick > 0.0 {
            axis.push_str(&format!("M{},{}h{}", num(left), num(y), num(-left_tick)));
        }
        if left_labels {
            labels.push_str(&aligned(&mark.label, left - left_tick - 6.0, y, "end", ctx));
        }
    }
    for mark in &bottom_marks {
        let at = left + mark.at * plot_width;
        if bottom_tick > 0.0 {
            axis.push_str(&format!("M{},{}v{}", num(at), num(bottom), num(bottom_tick)));
        }
        if bottom_labels {
            labels.push_str(&aligned(&mark.label, at, bottom + bottom_tick + 4.0 + mark.label.height / 2.0, "middle", ctx));
        }
    }

    let span = (if horizontal { plot_height } else { plot_width }) * slot;
    let group = span * 0.7;
    let thickness = group / (bars.max(1) as f64);
    let gap = if bars > 1 { 2.0f64.min(thickness * 0.2) } else { 0.0 };
    let base = clamp01(scale(0.0));
    if bars > 0 && base > 0.0 && base < 1.0 {
        axis.push_str(&rule(base));
    }

    let mut series = String::new();
    let mut lines = String::new();
    let mut outside = String::new();
    let mut point_labels = String::new();
    let mut bar_idx = 0usize;

    for (index, plot) in plots.iter().enumerate() {
        let color = ctx.theme.series_color(index, ctx.palette);
        let id_attr = if plot.title.is_empty() {
            String::new()
        } else {
            format!(r#" data-id="{}""#, esc_text(&plot.title))
        };
        let n = if is_band { plot.data.len().min(count) } else { plot.data.len() };
        match plot.kind {
            PlotKind::Bar => {
                let offset = ((bar_idx as f64) - ((bars - 1) as f64) / 2.0) * thickness - (thickness - gap) / 2.0;
                bar_idx += 1;
                let mut rects = String::new();
                for i in 0..n {
                    let Some(value) = finite(plot.data[i].1) else { continue };
                    let c = place(i, n);
                    let v = clamp01(scale(value));
                    let from = base.min(v);
                    let to = base.max(v);
                    let bx = if horizontal { px(c, from) } else { px(c, 0.0) + offset };
                    let by = if horizontal { py(c, 0.0) + offset } else { py(c, to) };
                    let bw = if horizontal { (to - from) * plot_width } else { thickness - gap };
                    let bh = if horizontal { thickness - gap } else { (to - from) * plot_height };
                    rects.push_str(&format!(r#"<rect x="{}" y="{}" width="{}" height="{}"/>"#, num(bx), num(by), num(bw), num(bh)));
                    if !show_values {
                        continue;
                    }
                    let label = js_number_string(value);
                    let w = ctx.measurer.width(&label, tiny, TextStyle::NONE);
                    let out = if v >= base { 1.0 } else { -1.0 };
                    let mut tx = bx + bw / 2.0;
                    let mut ty = by + bh / 2.0;
                    let mut anchor = "middle";
                    if horizontal {
                        if bh < tiny {
                            continue;
                        }
                        tx = (if out > 0.0 { bx + bw } else { bx }) + out * 6.0;
                        anchor = if out > 0.0 { "start" } else { "end" };
                    } else {
                        if w + 2.0 > span / (bars as f64) {
                            continue;
                        }
                        ty = (if out > 0.0 { by } else { by + bh }) - out * (tiny_height / 2.0 + 2.0);
                    }
                    outside.push_str(&format!(
                        r#"<text x="{}" y="{}" text-anchor="{anchor}">{label}</text>"#,
                        num(tx),
                        num(ty + tiny * 0.35)
                    ));
                }
                series.push_str(&format!(r#"<g class="pele-series pele-bars"{id_attr} fill="{color}">{rects}</g>"#));
            }
            PlotKind::Line => {
                let mut d = String::new();
                let mut dots = String::new();
                let mut pen = false;
                let mut pc = 0.0f64;
                let mut pv = f64::NAN;
                for i in 0..n {
                    let Some(value) = finite(plot.data[i].1) else {
                        pv = f64::NAN;
                        continue;
                    };
                    let c = place(i, n);
                    let v = scale(value);
                    let visible = (0.0..=1.0).contains(&v);
                    if pv.is_nan() {
                        if visible {
                            d.push_str(&format!("M{},{}", num(px(c, v)), num(py(c, v))));
                        }
                        pen = visible;
                    } else {
                        let dv = v - pv;
                        let mut t0 = 0.0f64;
                        let mut t1 = 1.0f64;
                        if dv != 0.0 {
                            let a = -pv / dv;
                            let b = (1.0 - pv) / dv;
                            t0 = t0.max(a.min(b));
                            t1 = t1.min(a.max(b));
                        } else if !visible {
                            t0 = 2.0;
                        }
                        if t0 <= t1 {
                            let c0 = pc + (c - pc) * t0;
                            let v0 = pv + dv * t0;
                            let c1 = pc + (c - pc) * t1;
                            let v1 = pv + dv * t1;
                            if !pen || t0 > 0.0 {
                                d.push_str(&format!("M{},{}", num(px(c0, v0)), num(py(c0, v0))));
                            }
                            d.push_str(&format!("L{},{}", num(px(c1, v1)), num(py(c1, v1))));
                        }
                        pen = visible;
                    }
                    pc = c;
                    pv = v;
                    if !visible {
                        continue;
                    }
                    let cx = px(c, v);
                    let cy = py(c, v);
                    if span >= 12.0 {
                        dots.push_str(&format!(r#"<circle cx="{}" cy="{}" r="3"/>"#, num(cx), num(cy)));
                    }
                    let label = text(plot.point_labels.as_ref().and_then(|ls| ls.get(i)).map(String::as_str), tiny, 4000.0);
                    if label.height > 0.0 {
                        let half = label.width / 2.0;
                        if horizontal {
                            point_labels.push_str(&aligned(&label, cx + 10.0, cy, "start", ctx));
                        } else {
                            let clamped_x = cx.min(right - half).max(left + half);
                            point_labels.push_str(&aligned(&label, clamped_x, cy - 6.0 - label.height / 2.0, "middle", ctx));
                        }
                    }
                }
                lines.push_str(&format!(r#"<g class="pele-series pele-line"{id_attr} fill="{color}">"#));
                if !d.is_empty() {
                    lines.push_str(&format!(
                        r#"<path d="{d}" fill="none" stroke="{color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#
                    ));
                }
                lines.push_str(&dots);
                lines.push_str("</g>");
            }
        }
    }

    let mut titles = String::new();
    if left_title.height > 0.0 {
        titles.push_str(&format!(
            r#"<g transform="translate({},{}) rotate(-90)">{}</g>"#,
            num(pad + left_title.height / 2.0),
            num(top + plot_height / 2.0),
            label_svg(&left_title, 0.0, 0.0, "", ctx.theme, ctx.icons)
        ));
    }
    titles.push_str(&label_svg(
        &bottom_title,
        left + plot_width / 2.0,
        height - pad - bottom_title.height / 2.0,
        "",
        ctx.theme,
        ctx.icons,
    ));

    let mut legend_out = String::new();
    let legend_height: f64 = legend.iter().map(|(_, l)| ROW.max(l.height + 6.0)).sum();
    let mut ly = top + (plot_height - legend_height).max(0.0) / 2.0;
    let lx = right + reach + LEGEND_GAP;
    for &(index, ref label) in &legend {
        let row = ROW.max(label.height + 6.0);
        if ly + row > height {
            break;
        }
        let y = ly + row / 2.0;
        let color = ctx.theme.series_color(index, ctx.palette);
        legend_out.push_str(&format!(r#"<g class="pele-legend-item" data-id="{}">"#, esc_text(&plots[index].title)));
        match plots[index].kind {
            PlotKind::Bar => {
                legend_out.push_str(&format!(
                    r#"<rect x="{}" y="{}" width="{}" height="{}" rx="2" fill="{color}"/>"#,
                    num(lx),
                    num(y - SWATCH / 2.0),
                    num(SWATCH),
                    num(SWATCH),
                ));
            }
            PlotKind::Line => {
                legend_out.push_str(&format!(
                    r#"<path d="M{},{}h{}" stroke="{color}" stroke-width="2" stroke-linecap="round"/>"#,
                    num(lx),
                    num(y),
                    num(SWATCH),
                ));
            }
        }
        legend_out.push_str(&label_svg(label, lx + SWATCH + 8.0 + label.width / 2.0, y, "", ctx.theme, ctx.icons));
        legend_out.push_str("</g>");
        ly += row;
    }

    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let mut content = String::new();
    content.push_str(&label_svg(&title, width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, ctx.icons));
    if !grid.is_empty() {
        content.push_str(&format!(r#"<path class="pele-grid" d="{grid}" stroke="{}"/>"#, ctx.theme.surface_alt()));
    }
    content.push_str(&format!(r#"<g class="pele-plot">{series}{lines}</g>"#));
    if !axis.is_empty() {
        content.push_str(&format!(r#"<path class="pele-axis" d="{axis}" fill="none" stroke="{}"/>"#, ctx.theme.border()));
    }
    if !labels.is_empty() {
        content.push_str(&format!(
            r#"<g class="pele-axis-labels" font-size="{}" fill="{}">{labels}</g>"#,
            num(small),
            ctx.theme.muted()
        ));
    }
    if !titles.is_empty() {
        content.push_str(&format!(r#"<g class="pele-axis-titles" font-size="{}">{titles}</g>"#, num(small)));
    }
    if !outside.is_empty() {
        content.push_str(&format!(r#"<g class="pele-data-labels" font-size="{}">{outside}</g>"#, num(tiny)));
    }
    if !point_labels.is_empty() {
        content.push_str(&format!(r#"<g class="pele-point-labels" font-size="{}">{point_labels}</g>"#, num(tiny)));
    }
    if !legend_out.is_empty() {
        content.push_str(&format!(r#"<g class="pele-legend" font-size="{}">{legend_out}</g>"#, num(small)));
    }

    let svg = svg_document(
        "xychart",
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
    Ok(Rendered {
        svg,
        width,
        height,
        links: Vec::new(),
    })
}
