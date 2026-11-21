use crate::engine::chart::charts::{build_area_band_path, build_curve_path};
use crate::engine::chart::layout::{
    AnnotationScales, CartesianAxes, ChromeLayout, DATA_LABEL_FONT, DrawCtx, LegendItem, LegendSwatch, Rect, ResolvedLegend, XAxisMapping, category_x_center,
    compute_cartesian_plot, draw_annotations_back, draw_annotations_front, draw_category_x_axis, draw_left_y_axis, draw_numeric_x_axis, draw_x_gridlines,
    draw_y_gridlines,
};
use crate::engine::chart::scale::{NumericScale, format_value};
use crate::engine::chart::spec::{AreaMode, AreaSpec, AxisScale, ChartSpec, LineSeries, LineSpec, NumberFormat};
use crate::engine::chart::svg::{Paint, SvgBuilder, TextAnchor, TextStyle};

pub(crate) fn render_line(spec: &ChartSpec, line: &LineSpec, ctx: DrawCtx<'_>, svg: &mut SvgBuilder) {
    let colors: Vec<String> = line
        .series
        .iter()
        .enumerate()
        .map(|(i, s)| ctx.tokens.series_color(i, s.color.as_deref(), spec.palette.as_deref()))
        .collect();

    let legend_items: Vec<LegendItem> = line
        .series
        .iter()
        .enumerate()
        .map(|(i, s)| LegendItem {
            label: s.name.clone(),
            color: colors[i].clone(),
            swatch: LegendSwatch::Line,
            dashed: s.dashed,
        })
        .collect();

    let default_legend = if line.series.len() > 1 { ResolvedLegend::Top } else { ResolvedLegend::None };

    let chrome = ChromeLayout::compute(spec, ctx, &legend_items, default_legend);
    chrome.draw_background(svg, ctx.tokens);
    chrome.draw_header(svg, ctx.tokens);

    let (min_y, max_y) = line_extent(&line.series);
    let y_scale = NumericScale::build(min_y, max_y, &spec.y_axis, false, NumberFormat::Number);

    let x_scale = line.x_values.as_deref().map(|xs| {
        let lo = xs.iter().copied().fold(f64::INFINITY, f64::min);
        let hi = xs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        NumericScale::build(lo, hi, &spec.x_axis, false, NumberFormat::Number)
    });

    let cats_opt = if line.x_values.is_some() { None } else { Some(line.categories.as_slice()) };
    let axes = CartesianAxes {
        x_axis: &spec.x_axis,
        y_axis: &spec.y_axis,
        y2_axis: None,
        y_scale: &y_scale,
        y2_scale: None,
        x_categories: cats_opt,
        x_scale: x_scale.as_ref(),
    };
    let (plot, x_plan) = compute_cartesian_plot(chrome.content, &axes, ctx.measurer);

    let ann_scales = AnnotationScales {
        x_map: match &x_scale {
            Some(xs) => XAxisMapping::Numeric(xs),
            None => XAxisMapping::Categories {
                categories: &line.categories,
                center_in_slot: false,
            },
        },
        y_left: &y_scale,
        y_right: None,
    };

    draw_y_gridlines(svg, plot, &y_scale, &spec.y_axis, ctx.tokens);
    if let Some(xs) = &x_scale {
        draw_x_gridlines(svg, plot, xs, &spec.x_axis, false, ctx.tokens);
    }
    draw_annotations_back(svg, plot, &spec.annotations, &ann_scales, ctx.tokens);

    let x_coords = compute_x_coords(plot, &line.categories, line.x_values.as_deref(), x_scale.as_ref());

    svg.open_group("series");
    let mut value_labels: Vec<(f64, f64, String)> = Vec::new();
    for (s_idx, s) in line.series.iter().enumerate() {
        let color = &colors[s_idx];
        let sw = s.stroke_width.unwrap_or(2.2);
        let dash = if s.dashed { Some("6,4") } else { None };
        svg.open_group_with_name("line-series", &s.name);

        let segments = split_series_runs(&s.data, &x_coords, &y_scale, plot, line.connect_nulls);
        for seg in &segments {
            if seg.len() >= 2 {
                let pts: Vec<(f64, f64)> = seg.iter().map(|&(x, y, _)| (x, y)).collect();
                let d = build_curve_path(&pts, line.interpolation);
                svg.path(&d, Paint::stroke(color, sw).dash(dash).round_caps());
            }
            for &(px, py, raw) in seg {
                if line.show_points || seg.len() == 1 {
                    svg.circle(px, py, 3.5, Paint::fill(color).with_stroke(&ctx.tokens.background, 1.4));
                }
                if line.show_values {
                    let lbl = format_value(raw, spec.y_axis.format, spec.y_axis.currency_symbol.as_deref(), spec.y_axis.decimals);
                    value_labels.push((px, py - 8.0, lbl));
                }
            }
        }
        svg.close_group();
    }
    svg.close_group();

    if line.show_values && !value_labels.is_empty() {
        svg.open_group("data-labels");
        for (x, y, txt) in value_labels {
            svg.text(
                x,
                y.max(plot.y + 8.0),
                &txt,
                TextStyle::new(&ctx.tokens.text_muted, DATA_LABEL_FONT).anchor(TextAnchor::Middle),
            );
        }
        svg.close_group();
    }

    draw_left_y_axis(svg, plot, chrome.content.x, &y_scale, &spec.y_axis, ctx.tokens);
    match (&x_scale, &x_plan) {
        (Some(xs), _) => draw_numeric_x_axis(svg, plot, xs, &spec.x_axis, ctx),
        (None, Some(plan)) => draw_category_x_axis(svg, plot, &line.categories, plan, &spec.x_axis, false, ctx),
        (None, None) => {}
    }

    draw_annotations_front(svg, plot, &spec.annotations, &ann_scales, ctx);
    chrome.draw_legend(svg, ctx.tokens);
}

pub(crate) fn render_area(spec: &ChartSpec, area: &AreaSpec, ctx: DrawCtx<'_>, svg: &mut SvgBuilder) {
    let colors: Vec<String> = area
        .series
        .iter()
        .enumerate()
        .map(|(i, s)| ctx.tokens.series_color(i, s.color.as_deref(), spec.palette.as_deref()))
        .collect();

    let legend_items: Vec<LegendItem> = area
        .series
        .iter()
        .enumerate()
        .map(|(i, s)| LegendItem {
            label: s.name.clone(),
            color: colors[i].clone(),
            swatch: LegendSwatch::Square,
            dashed: false,
        })
        .collect();

    let default_legend = if area.series.len() > 1 { ResolvedLegend::Top } else { ResolvedLegend::None };

    let chrome = ChromeLayout::compute(spec, ctx, &legend_items, default_legend);
    chrome.draw_background(svg, ctx.tokens);
    chrome.draw_header(svg, ctx.tokens);

    let x_len = area.x_values.as_ref().map_or(area.categories.len(), Vec::len);
    let default_fmt = match area.mode {
        AreaMode::PercentStacked => NumberFormat::Percent,
        AreaMode::Standard | AreaMode::Stacked => NumberFormat::Number,
    };

    let mut y_axis = spec.y_axis.clone();
    let (min_y, max_y) = match area.mode {
        AreaMode::Standard => line_extent(&area.series),
        AreaMode::Stacked => {
            let mut max_sum = 0.0_f64;
            for i in 0..x_len {
                let sum: f64 = area.series.iter().filter_map(|s| s.data.get(i).copied().flatten()).sum();
                max_sum = max_sum.max(sum);
            }
            (0.0, max_sum)
        }
        AreaMode::PercentStacked => {
            y_axis.min.get_or_insert(0.0);
            y_axis.max.get_or_insert(1.0);
            (0.0, 1.0)
        }
    };

    let include_zero = y_axis.scale == AxisScale::Linear;
    let y_scale = NumericScale::build(min_y, max_y, &y_axis, include_zero, default_fmt);

    let x_scale = area.x_values.as_deref().map(|xs| {
        let lo = xs.iter().copied().fold(f64::INFINITY, f64::min);
        let hi = xs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        NumericScale::build(lo, hi, &spec.x_axis, false, NumberFormat::Number)
    });

    let cats_opt = if area.x_values.is_some() { None } else { Some(area.categories.as_slice()) };
    let axes = CartesianAxes {
        x_axis: &spec.x_axis,
        y_axis: &y_axis,
        y2_axis: None,
        y_scale: &y_scale,
        y2_scale: None,
        x_categories: cats_opt,
        x_scale: x_scale.as_ref(),
    };
    let (plot, x_plan) = compute_cartesian_plot(chrome.content, &axes, ctx.measurer);
    let ann_scales = AnnotationScales {
        x_map: match &x_scale {
            Some(xs) => XAxisMapping::Numeric(xs),
            None => XAxisMapping::Categories {
                categories: &area.categories,
                center_in_slot: false,
            },
        },
        y_left: &y_scale,
        y_right: None,
    };

    draw_y_gridlines(svg, plot, &y_scale, &y_axis, ctx.tokens);
    if let Some(xs) = &x_scale {
        draw_x_gridlines(svg, plot, xs, &spec.x_axis, false, ctx.tokens);
    }
    draw_annotations_back(svg, plot, &spec.annotations, &ann_scales, ctx.tokens);

    let x_coords = compute_x_coords(plot, &area.categories, area.x_values.as_deref(), x_scale.as_ref());
    let base_val = if y_scale.scale == AxisScale::Log {
        y_scale.domain_min
    } else {
        0.0_f64.clamp(y_scale.domain_min, y_scale.domain_max)
    };
    let base_y = y_scale.map(base_val, plot.bottom(), plot.y);

    svg.open_group("series");
    match area.mode {
        AreaMode::Standard => {
            let fill_op = area.fill_opacity.unwrap_or(0.24);
            for (s_idx, s) in area.series.iter().enumerate() {
                let color = &colors[s_idx];
                let sw = s.stroke_width.unwrap_or(2.0);
                let dash = if s.dashed { Some("6,4") } else { None };
                svg.open_group_with_name("area-series", &s.name);
                let segments = split_series_runs(&s.data, &x_coords, &y_scale, plot, area.connect_nulls);
                for seg in &segments {
                    if seg.len() >= 2 {
                        let top: Vec<(f64, f64)> = seg.iter().map(|&(x, y, _)| (x, y)).collect();
                        let bot: Vec<(f64, f64)> = top.iter().map(|&(x, _)| (x, base_y)).collect();
                        let area_d = build_area_band_path(&top, &bot, area.interpolation);
                        svg.path(&area_d, Paint::fill(color).fill_opacity(fill_op));
                        let stroke_d = build_curve_path(&top, area.interpolation);
                        svg.path(&stroke_d, Paint::stroke(color, sw).dash(dash).round_caps());
                    }
                    for &(px, py, _) in seg {
                        if area.show_points || seg.len() == 1 {
                            svg.circle(px, py, 3.2, Paint::fill(color).with_stroke(&ctx.tokens.background, 1.2));
                        }
                    }
                }
                svg.close_group();
            }
        }
        AreaMode::Stacked | AreaMode::PercentStacked => {
            let fill_op = area.fill_opacity.unwrap_or(0.72);
            let totals: Vec<f64> = (0..x_len)
                .map(|i| area.series.iter().filter_map(|s| s.data.get(i).copied().flatten()).sum())
                .collect();

            let mut acc = vec![0.0_f64; x_len];
            for (s_idx, s) in area.series.iter().enumerate() {
                let color = &colors[s_idx];
                let sw = s.stroke_width.unwrap_or(1.6);
                let mut prev_layer = Vec::with_capacity(x_len);
                let mut next_layer = Vec::with_capacity(x_len);

                for (i, &px) in x_coords.iter().enumerate() {
                    let raw = s.data.get(i).copied().flatten().unwrap_or(0.0);
                    let delta = match area.mode {
                        AreaMode::PercentStacked => {
                            if totals[i] <= 0.0 {
                                0.0
                            } else {
                                raw / totals[i]
                            }
                        }
                        AreaMode::Stacked | AreaMode::Standard => raw,
                    };
                    let y_bot = y_scale.map(acc[i], plot.bottom(), plot.y).clamp(plot.y, plot.bottom());
                    acc[i] += delta;
                    let y_top = y_scale.map(acc[i], plot.bottom(), plot.y).clamp(plot.y, plot.bottom());
                    prev_layer.push((px, y_bot));
                    next_layer.push((px, y_top));
                }

                svg.open_group_with_name("area-series", &s.name);
                if next_layer.len() >= 2 {
                    let area_d = build_area_band_path(&next_layer, &prev_layer, area.interpolation);
                    svg.path(&area_d, Paint::fill(color).fill_opacity(fill_op));
                    let stroke_d = build_curve_path(&next_layer, area.interpolation);
                    svg.path(&stroke_d, Paint::stroke(color, sw).round_caps());
                }
                if area.show_points || next_layer.len() == 1 {
                    for &(px, py) in &next_layer {
                        svg.circle(px, py, 3.0, Paint::fill(color).with_stroke(&ctx.tokens.background, 1.2));
                    }
                }
                svg.close_group();
            }
        }
    }
    svg.close_group();

    draw_left_y_axis(svg, plot, chrome.content.x, &y_scale, &y_axis, ctx.tokens);
    match (&x_scale, &x_plan) {
        (Some(xs), _) => draw_numeric_x_axis(svg, plot, xs, &spec.x_axis, ctx),
        (None, Some(plan)) => draw_category_x_axis(svg, plot, &area.categories, plan, &spec.x_axis, false, ctx),
        (None, None) => {}
    }

    draw_annotations_front(svg, plot, &spec.annotations, &ann_scales, ctx);
    chrome.draw_legend(svg, ctx.tokens);
}

fn line_extent(series: &[LineSeries]) -> (f64, f64) {
    let mut min_v = f64::INFINITY;
    let mut max_v = f64::NEG_INFINITY;
    for s in series {
        for v in s.data.iter().flatten() {
            min_v = min_v.min(*v);
            max_v = max_v.max(*v);
        }
    }
    if !min_v.is_finite() { (0.0, 1.0) } else { (min_v, max_v) }
}

fn compute_x_coords(plot: Rect, categories: &[String], x_values: Option<&[f64]>, x_scale: Option<&NumericScale>) -> Vec<f64> {
    if let (Some(xs), Some(scale)) = (x_values, x_scale) {
        xs.iter().map(|&x| scale.map(x, plot.x, plot.right())).collect()
    } else {
        let count = categories.len();
        (0..count).map(|idx| category_x_center(plot, idx, count, false)).collect()
    }
}

pub(crate) fn split_series_runs(data: &[Option<f64>], x_coords: &[f64], y_scale: &NumericScale, plot: Rect, connect_nulls: bool) -> Vec<Vec<(f64, f64, f64)>> {
    let mut runs: Vec<Vec<(f64, f64, f64)>> = Vec::new();
    let mut current: Vec<(f64, f64, f64)> = Vec::new();

    for (idx, val_opt) in data.iter().enumerate() {
        match val_opt {
            Some(v) => {
                let px = x_coords[idx];
                let py = y_scale.map(*v, plot.bottom(), plot.y).clamp(plot.y, plot.bottom());
                current.push((px, py, *v));
            }
            None => {
                if !connect_nulls && !current.is_empty() {
                    runs.push(std::mem::take(&mut current));
                }
            }
        }
    }
    if !current.is_empty() {
        runs.push(current);
    }
    runs
}
