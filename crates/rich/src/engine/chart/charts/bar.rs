use crate::engine::chart::layout::{
    AnnotationScales, CartesianAxes, ChromeLayout, DATA_LABEL_FONT, DrawCtx, LegendItem, LegendSwatch, Rect, ResolvedLegend, XAxisMapping,
    compute_cartesian_plot, compute_horizontal_plot, draw_annotations_back, draw_annotations_front, draw_category_x_axis, draw_category_y_axis,
    draw_left_y_axis, draw_numeric_x_axis, draw_x_gridlines, draw_y_gridlines,
};
use crate::engine::chart::scale::{NumericScale, format_value};
use crate::engine::chart::spec::{AxisScale, AxisSpec, BarMode, BarOrientation, BarSeries, BarSpec, ChartSpec, NumberFormat};
use crate::engine::chart::svg::{BarRoundEnd, DominantBaseline, Paint, SvgBuilder, TextAnchor, TextStyle, rounded_bar_path};
use crate::engine::chart::theme::PaintTokens;

pub(crate) struct BarDrawStyle<'a> {
    pub mode: BarMode,
    pub axis: &'a AxisSpec,
    pub default_fmt: NumberFormat,
    pub colors: &'a [String],
    pub spec_palette: Option<&'a [String]>,
    pub radius: f64,
    pub show_values: bool,
}

fn build_value_axis_and_scale(base: &AxisSpec, mode: BarMode, data_min: f64, data_max: f64, default_fmt: NumberFormat) -> (AxisSpec, NumericScale) {
    let mut axis = base.clone();
    if mode == BarMode::PercentStacked {
        axis.min.get_or_insert(0.0);
        axis.max.get_or_insert(1.0);
    }
    let include_zero = axis.scale == AxisScale::Linear;
    let scale = NumericScale::build(data_min, data_max, &axis, include_zero, default_fmt);
    (axis, scale)
}

pub(crate) fn render(spec: &ChartSpec, bar: &BarSpec, ctx: DrawCtx<'_>, svg: &mut SvgBuilder) {
    let colors: Vec<String> = bar
        .series
        .iter()
        .enumerate()
        .map(|(i, s)| ctx.tokens.series_color(i, s.color.as_deref(), spec.palette.as_deref()))
        .collect();

    let legend_items: Vec<LegendItem> = bar
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

    let default_legend = if bar.series.len() > 1 { ResolvedLegend::Top } else { ResolvedLegend::None };

    let chrome = ChromeLayout::compute(spec, ctx, &legend_items, default_legend);
    chrome.draw_background(svg, ctx.tokens);
    chrome.draw_header(svg, ctx.tokens);

    let (data_min, data_max) = bar_value_extent(&bar.series, bar.categories.len(), bar.mode);
    let default_fmt = match bar.mode {
        BarMode::PercentStacked => NumberFormat::Percent,
        BarMode::Grouped | BarMode::Stacked => NumberFormat::Number,
    };
    let radius = bar.corner_radius.unwrap_or(3.0);

    match bar.orientation {
        BarOrientation::Vertical => {
            let (y_axis, y_scale) = build_value_axis_and_scale(&spec.y_axis, bar.mode, data_min, data_max, default_fmt);

            let axes = CartesianAxes {
                x_axis: &spec.x_axis,
                y_axis: &y_axis,
                y2_axis: None,
                y_scale: &y_scale,
                y2_scale: None,
                x_categories: Some(&bar.categories),
                x_scale: None,
            };
            let (plot, x_plan) = compute_cartesian_plot(chrome.content, &axes, ctx.measurer);
            let ann_scales = AnnotationScales {
                x_map: XAxisMapping::Categories {
                    categories: &bar.categories,
                    center_in_slot: true,
                },
                y_left: &y_scale,
                y_right: None,
            };

            draw_y_gridlines(svg, plot, &y_scale, &y_axis, ctx.tokens);
            draw_annotations_back(svg, plot, &spec.annotations, &ann_scales, ctx.tokens);

            let style = BarDrawStyle {
                mode: bar.mode,
                axis: &y_axis,
                default_fmt,
                colors: &colors,
                spec_palette: spec.palette.as_deref(),
                radius,
                show_values: bar.show_values,
            };
            draw_bars(
                svg,
                plot,
                &bar.series,
                bar.categories.len(),
                &y_scale,
                &style,
                ctx.tokens,
                BarOrientation::Vertical,
            );

            if y_scale.domain_min < 0.0 && y_scale.domain_max > 0.0 {
                let zy = y_scale.map(0.0, plot.bottom(), plot.y);
                svg.line(plot.x, zy, plot.right(), zy, Paint::stroke(&ctx.tokens.axis, 1.0));
            }

            draw_left_y_axis(svg, plot, chrome.content.x, &y_scale, &y_axis, ctx.tokens);
            if let Some(plan) = &x_plan {
                draw_category_x_axis(svg, plot, &bar.categories, plan, &spec.x_axis, true, ctx);
            }
            draw_annotations_front(svg, plot, &spec.annotations, &ann_scales, ctx);
        }
        BarOrientation::Horizontal => {
            let (x_axis, x_scale) = build_value_axis_and_scale(&spec.x_axis, bar.mode, data_min, data_max, default_fmt);
            let (plot, max_cat_px) = compute_horizontal_plot(chrome.content, &x_axis, &spec.y_axis, &bar.categories, ctx.measurer);

            draw_x_gridlines(svg, plot, &x_scale, &x_axis, true, ctx.tokens);

            let dummy_y = NumericScale::build(0.0, bar.categories.len().max(1) as f64, &spec.y_axis, true, NumberFormat::Number);
            let ann_scales = AnnotationScales {
                x_map: XAxisMapping::Numeric(&x_scale),
                y_left: &dummy_y,
                y_right: None,
            };
            draw_annotations_back(svg, plot, &spec.annotations, &ann_scales, ctx.tokens);

            let style = BarDrawStyle {
                mode: bar.mode,
                axis: &x_axis,
                default_fmt,
                colors: &colors,
                spec_palette: spec.palette.as_deref(),
                radius,
                show_values: bar.show_values,
            };
            draw_bars(
                svg,
                plot,
                &bar.series,
                bar.categories.len(),
                &x_scale,
                &style,
                ctx.tokens,
                BarOrientation::Horizontal,
            );

            if x_scale.domain_min < 0.0 && x_scale.domain_max > 0.0 {
                let zx = x_scale.map(0.0, plot.x, plot.right());
                svg.line(zx, plot.y, zx, plot.bottom(), Paint::stroke(&ctx.tokens.axis, 1.0));
            }

            draw_category_y_axis(svg, plot, chrome.content.x, &bar.categories, max_cat_px, &spec.y_axis, ctx);
            draw_numeric_x_axis(svg, plot, &x_scale, &x_axis, ctx);
            draw_annotations_front(svg, plot, &spec.annotations, &ann_scales, ctx);
        }
    }

    chrome.draw_legend(svg, ctx.tokens);
}

pub(crate) fn bar_value_extent(series: &[BarSeries], cat_count: usize, mode: BarMode) -> (f64, f64) {
    match mode {
        BarMode::PercentStacked => (0.0, 1.0),
        BarMode::Grouped => {
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
        BarMode::Stacked => {
            let mut min_v = 0.0_f64;
            let mut max_v = 0.0_f64;
            for idx in 0..cat_count {
                let mut pos = 0.0_f64;
                let mut neg = 0.0_f64;
                for s in series {
                    if let Some(v) = s.data.get(idx).copied().flatten() {
                        if v >= 0.0 {
                            pos += v;
                        } else {
                            neg += v;
                        }
                    }
                }
                max_v = max_v.max(pos);
                min_v = min_v.min(neg);
            }
            (min_v, max_v)
        }
    }
}

pub(crate) fn draw_vertical_bars(
    svg: &mut SvgBuilder,
    plot: Rect,
    series: &[BarSeries],
    cat_count: usize,
    y_scale: &NumericScale,
    style: &BarDrawStyle<'_>,
    tokens: &PaintTokens,
) {
    draw_bars(svg, plot, series, cat_count, y_scale, style, tokens, BarOrientation::Vertical);
}

#[allow(clippy::too_many_arguments)]
fn draw_bars(
    svg: &mut SvgBuilder,
    plot: Rect,
    series: &[BarSeries],
    cat_count: usize,
    scale: &NumericScale,
    style: &BarDrawStyle<'_>,
    tokens: &PaintTokens,
    orientation: BarOrientation,
) {
    if cat_count == 0 || series.is_empty() {
        return;
    }
    let fmt = if style.axis.format == NumberFormat::Number {
        style.default_fmt
    } else {
        style.axis.format
    };
    let (slot_span, cat_origin, val_start, val_end, val_min, val_max, stacked_max_thick, label_min_len, pos_round, neg_round) = match orientation {
        BarOrientation::Vertical => (
            plot.width / cat_count as f64,
            plot.x,
            plot.bottom(),
            plot.y,
            plot.y,
            plot.bottom(),
            72.0,
            14.0,
            BarRoundEnd::Top,
            BarRoundEnd::Bottom,
        ),
        BarOrientation::Horizontal => (
            plot.height / cat_count as f64,
            plot.y,
            plot.x,
            plot.right(),
            plot.x,
            plot.right(),
            48.0,
            24.0,
            BarRoundEnd::Right,
            BarRoundEnd::Left,
        ),
    };
    let bar_rect = |cross: f64, val_pos: f64, thick: f64, len: f64| match orientation {
        BarOrientation::Vertical => (cross, val_pos, thick, len),
        BarOrientation::Horizontal => (val_pos, cross, len, thick),
    };
    let bar_center = |cross: f64, thick: f64, val_pos: f64| match orientation {
        BarOrientation::Vertical => (cross + thick * 0.5, val_pos),
        BarOrientation::Horizontal => (val_pos, cross + thick * 0.5),
    };

    let group_span = (slot_span * 0.72).max(2.0);
    let baseline_val = if scale.scale == AxisScale::Log {
        scale.domain_min
    } else {
        0.0_f64.clamp(scale.domain_min, scale.domain_max)
    };
    let baseline_px = scale.map(baseline_val, val_start, val_end);

    svg.open_group("series");
    let mut labels: Vec<(f64, f64, String, bool, String)> = Vec::new();

    match style.mode {
        BarMode::Grouped => {
            let n = series.len();
            let gap = if n > 1 { (group_span * 0.08).clamp(1.0, 4.0) } else { 0.0 };
            let bar_thick = ((group_span - gap * (n - 1) as f64) / n as f64).max(1.5);
            let total_span = bar_thick * n as f64 + gap * (n - 1) as f64;

            for (s_idx, s) in series.iter().enumerate() {
                svg.open_group_with_name("bar-series", &s.name);
                for (c_idx, val_opt) in s.data.iter().enumerate() {
                    let Some(val) = val_opt else {
                        continue;
                    };
                    let slot_offset = cat_origin + c_idx as f64 * slot_span + (slot_span - total_span) * 0.5;
                    let cross = slot_offset + s_idx as f64 * (bar_thick + gap);
                    let v_px = scale.map(*val, val_start, val_end).clamp(val_min, val_max);
                    let start_px = v_px.min(baseline_px);
                    let len = (v_px - baseline_px).abs();
                    if len > 0.05 {
                        let end = if *val >= baseline_val { pos_round } else { neg_round };
                        let (rx, ry, rw, rh) = bar_rect(cross, start_px, bar_thick, len);
                        let d = rounded_bar_path(rx, ry, rw, rh, style.radius, end);
                        svg.path(&d, Paint::fill(&style.colors[s_idx]));
                    }
                    if style.show_values {
                        let text = format_value(*val, fmt, style.axis.currency_symbol.as_deref(), style.axis.decimals);
                        let (lx, ly) = bar_center(cross, bar_thick, v_px);
                        labels.push((lx, ly, text, *val >= baseline_val, tokens.text_muted.clone()));
                    }
                }
                svg.close_group();
            }
        }
        BarMode::Stacked | BarMode::PercentStacked => {
            let bar_thick = (slot_span * 0.62).clamp(2.0, stacked_max_thick);
            let totals: Vec<f64> = (0..cat_count)
                .map(|c| series.iter().filter_map(|s| s.data.get(c).copied().flatten()).filter(|v| *v > 0.0).sum())
                .collect();

            let mut last_pos = vec![None; cat_count];
            let mut last_neg = vec![None; cat_count];
            for (s_idx, s) in series.iter().enumerate() {
                for (c_idx, val_opt) in s.data.iter().enumerate() {
                    if let Some(v) = val_opt {
                        if *v > 0.0 {
                            last_pos[c_idx] = Some(s_idx);
                        } else if *v < 0.0 {
                            last_neg[c_idx] = Some(s_idx);
                        }
                    }
                }
            }

            let mut acc_pos = vec![0.0_f64; cat_count];
            let mut acc_neg = vec![0.0_f64; cat_count];

            for (s_idx, s) in series.iter().enumerate() {
                let inside_ink = tokens
                    .concrete_series_rgb(s_idx, s.color.as_deref(), style.spec_palette)
                    .contrast_ink("#1c1917", "#fcfcfb");
                svg.open_group_with_name("bar-series", &s.name);
                for (c_idx, val_opt) in s.data.iter().enumerate() {
                    let Some(raw) = val_opt else {
                        continue;
                    };
                    let val = match style.mode {
                        BarMode::PercentStacked => {
                            if totals[c_idx] <= 0.0 {
                                0.0
                            } else {
                                *raw / totals[c_idx]
                            }
                        }
                        BarMode::Stacked | BarMode::Grouped => *raw,
                    };
                    if val.abs() < 1e-12 {
                        continue;
                    }
                    let (start, end_val, round_end) = if val >= 0.0 {
                        let start = acc_pos[c_idx];
                        acc_pos[c_idx] += val;
                        let r = if last_pos[c_idx] == Some(s_idx) { pos_round } else { BarRoundEnd::None };
                        (start, acc_pos[c_idx], r)
                    } else {
                        let start = acc_neg[c_idx];
                        acc_neg[c_idx] += val;
                        let r = if last_neg[c_idx] == Some(s_idx) { neg_round } else { BarRoundEnd::None };
                        (start, acc_neg[c_idx], r)
                    };

                    let p0 = scale.map(start, val_start, val_end).clamp(val_min, val_max);
                    let p1 = scale.map(end_val, val_start, val_end).clamp(val_min, val_max);
                    let start_px = p0.min(p1);
                    let len = (p1 - p0).abs();
                    let cross = cat_origin + c_idx as f64 * slot_span + (slot_span - bar_thick) * 0.5;
                    if len > 0.05 {
                        let (rx, ry, rw, rh) = bar_rect(cross, start_px, bar_thick, len);
                        let d = rounded_bar_path(rx, ry, rw, rh, style.radius, round_end);
                        svg.path(&d, Paint::fill(&style.colors[s_idx]));
                    }
                    if style.show_values && len >= label_min_len {
                        let text = format_value(val, fmt, style.axis.currency_symbol.as_deref(), style.axis.decimals);
                        let (lx, ly) = bar_center(cross, bar_thick, start_px + len * 0.5);
                        labels.push((lx, ly, text, true, inside_ink.clone()));
                    }
                }
                svg.close_group();
            }
        }
    }
    svg.close_group();

    if style.show_values && !labels.is_empty() {
        svg.open_group("data-labels");
        let is_stacked = matches!(style.mode, BarMode::Stacked | BarMode::PercentStacked);
        for (lx, ly, text, positive, fill) in labels {
            let (tx, ty, anchor, baseline) = match (orientation, style.mode) {
                (BarOrientation::Vertical, BarMode::Grouped) => {
                    if positive {
                        (lx, (ly - 4.0).max(plot.y + 8.0), TextAnchor::Middle, DominantBaseline::Auto)
                    } else {
                        (lx, (ly + 4.0).min(plot.bottom() - 4.0), TextAnchor::Middle, DominantBaseline::Hanging)
                    }
                }
                (BarOrientation::Horizontal, BarMode::Grouped) => {
                    if positive {
                        (lx + 4.0, ly, TextAnchor::Start, DominantBaseline::Central)
                    } else {
                        (lx - 4.0, ly, TextAnchor::End, DominantBaseline::Central)
                    }
                }
                (_, BarMode::Stacked | BarMode::PercentStacked) => (lx, ly, TextAnchor::Middle, DominantBaseline::Central),
            };
            svg.text(
                tx,
                ty,
                &text,
                TextStyle::new(&fill, DATA_LABEL_FONT).bold(is_stacked).anchor(anchor).baseline(baseline),
            );
        }
        svg.close_group();
    }
}
