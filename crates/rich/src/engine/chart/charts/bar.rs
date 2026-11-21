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
            let mut y_axis = spec.y_axis.clone();
            if bar.mode == BarMode::PercentStacked {
                y_axis.min.get_or_insert(0.0);
                y_axis.max.get_or_insert(1.0);
            }
            let include_zero = y_axis.scale == AxisScale::Linear;
            let y_scale = NumericScale::build(data_min, data_max, &y_axis, include_zero, default_fmt);

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
            draw_vertical_bars(svg, plot, &bar.series, bar.categories.len(), &y_scale, &style, ctx.tokens);

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
            let mut x_axis = spec.x_axis.clone();
            if bar.mode == BarMode::PercentStacked {
                x_axis.min.get_or_insert(0.0);
                x_axis.max.get_or_insert(1.0);
            }
            let include_zero = x_axis.scale == AxisScale::Linear;
            let x_scale = NumericScale::build(data_min, data_max, &x_axis, include_zero, default_fmt);
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
            draw_horizontal_bars(svg, plot, &bar.series, bar.categories.len(), &x_scale, &style, ctx.tokens);

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
    if cat_count == 0 || series.is_empty() {
        return;
    }
    let fmt = if style.axis.format == NumberFormat::Number {
        style.default_fmt
    } else {
        style.axis.format
    };
    let slot_w = plot.width / cat_count as f64;
    let group_w = (slot_w * 0.72).max(2.0);
    let baseline_val = if y_scale.scale == AxisScale::Log {
        y_scale.domain_min
    } else {
        0.0_f64.clamp(y_scale.domain_min, y_scale.domain_max)
    };
    let baseline_y = y_scale.map(baseline_val, plot.bottom(), plot.y);

    svg.open_group("series");
    let mut labels: Vec<(f64, f64, String, bool, String)> = Vec::new();

    match style.mode {
        BarMode::Grouped => {
            let n = series.len();
            let gap = if n > 1 { (group_w * 0.08).clamp(1.0, 4.0) } else { 0.0 };
            let bar_w = ((group_w - gap * (n - 1) as f64) / n as f64).max(1.5);
            let total_w = bar_w * n as f64 + gap * (n - 1) as f64;

            for (s_idx, s) in series.iter().enumerate() {
                svg.open_group_with_name("bar-series", &s.name);
                for (c_idx, val_opt) in s.data.iter().enumerate() {
                    let Some(val) = val_opt else {
                        continue;
                    };
                    let slot_left = plot.x + c_idx as f64 * slot_w + (slot_w - total_w) * 0.5;
                    let bx = slot_left + s_idx as f64 * (bar_w + gap);
                    let vy = y_scale.map(*val, plot.bottom(), plot.y).clamp(plot.y, plot.bottom());
                    let top = vy.min(baseline_y);
                    let h = (vy - baseline_y).abs();
                    if h > 0.05 {
                        let end = if *val >= baseline_val { BarRoundEnd::Top } else { BarRoundEnd::Bottom };
                        let d = rounded_bar_path(bx, top, bar_w, h, style.radius, end);
                        svg.path(&d, Paint::fill(&style.colors[s_idx]));
                    }
                    if style.show_values {
                        let text = format_value(*val, fmt, style.axis.currency_symbol.as_deref(), style.axis.decimals);
                        labels.push((bx + bar_w * 0.5, vy, text, *val >= baseline_val, tokens.text_muted.clone()));
                    }
                }
                svg.close_group();
            }
        }
        BarMode::Stacked | BarMode::PercentStacked => {
            let bar_w = (slot_w * 0.62).clamp(2.0, 72.0);
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
                        let r = if last_pos[c_idx] == Some(s_idx) {
                            BarRoundEnd::Top
                        } else {
                            BarRoundEnd::None
                        };
                        (start, acc_pos[c_idx], r)
                    } else {
                        let start = acc_neg[c_idx];
                        acc_neg[c_idx] += val;
                        let r = if last_neg[c_idx] == Some(s_idx) {
                            BarRoundEnd::Bottom
                        } else {
                            BarRoundEnd::None
                        };
                        (start, acc_neg[c_idx], r)
                    };

                    let y0 = y_scale.map(start, plot.bottom(), plot.y).clamp(plot.y, plot.bottom());
                    let y1 = y_scale.map(end_val, plot.bottom(), plot.y).clamp(plot.y, plot.bottom());
                    let top = y0.min(y1);
                    let h = (y1 - y0).abs();
                    let bx = plot.x + c_idx as f64 * slot_w + (slot_w - bar_w) * 0.5;
                    if h > 0.05 {
                        let d = rounded_bar_path(bx, top, bar_w, h, style.radius, round_end);
                        svg.path(&d, Paint::fill(&style.colors[s_idx]));
                    }
                    if style.show_values && h >= 14.0 {
                        let text = format_value(val, fmt, style.axis.currency_symbol.as_deref(), style.axis.decimals);
                        labels.push((bx + bar_w * 0.5, top + h * 0.5, text, true, inside_ink.clone()));
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
            let (ty, baseline) = match style.mode {
                BarMode::Grouped => {
                    if positive {
                        ((ly - 4.0).max(plot.y + 8.0), DominantBaseline::Auto)
                    } else {
                        ((ly + 4.0).min(plot.bottom() - 4.0), DominantBaseline::Hanging)
                    }
                }
                BarMode::Stacked | BarMode::PercentStacked => (ly, DominantBaseline::Central),
            };
            svg.text(
                lx,
                ty,
                &text,
                TextStyle::new(&fill, DATA_LABEL_FONT)
                    .bold(is_stacked)
                    .anchor(TextAnchor::Middle)
                    .baseline(baseline),
            );
        }
        svg.close_group();
    }
}

fn draw_horizontal_bars(
    svg: &mut SvgBuilder,
    plot: Rect,
    series: &[BarSeries],
    cat_count: usize,
    x_scale: &NumericScale,
    style: &BarDrawStyle<'_>,
    tokens: &PaintTokens,
) {
    if cat_count == 0 || series.is_empty() {
        return;
    }
    let fmt = if style.axis.format == NumberFormat::Number {
        style.default_fmt
    } else {
        style.axis.format
    };
    let slot_h = plot.height / cat_count as f64;
    let group_h = (slot_h * 0.72).max(2.0);
    let baseline_val = if x_scale.scale == AxisScale::Log {
        x_scale.domain_min
    } else {
        0.0_f64.clamp(x_scale.domain_min, x_scale.domain_max)
    };
    let baseline_x = x_scale.map(baseline_val, plot.x, plot.right());

    svg.open_group("series");
    let mut labels: Vec<(f64, f64, String, bool, String)> = Vec::new();

    match style.mode {
        BarMode::Grouped => {
            let n = series.len();
            let gap = if n > 1 { (group_h * 0.08).clamp(1.0, 4.0) } else { 0.0 };
            let bar_h = ((group_h - gap * (n - 1) as f64) / n as f64).max(1.5);
            let total_h = bar_h * n as f64 + gap * (n - 1) as f64;

            for (s_idx, s) in series.iter().enumerate() {
                svg.open_group_with_name("bar-series", &s.name);
                for (c_idx, val_opt) in s.data.iter().enumerate() {
                    let Some(val) = val_opt else {
                        continue;
                    };
                    let slot_top = plot.y + c_idx as f64 * slot_h + (slot_h - total_h) * 0.5;
                    let by = slot_top + s_idx as f64 * (bar_h + gap);
                    let vx = x_scale.map(*val, plot.x, plot.right()).clamp(plot.x, plot.right());
                    let left = vx.min(baseline_x);
                    let w = (vx - baseline_x).abs();
                    if w > 0.05 {
                        let end = if *val >= baseline_val { BarRoundEnd::Right } else { BarRoundEnd::Left };
                        let d = rounded_bar_path(left, by, w, bar_h, style.radius, end);
                        svg.path(&d, Paint::fill(&style.colors[s_idx]));
                    }
                    if style.show_values {
                        let text = format_value(*val, fmt, style.axis.currency_symbol.as_deref(), style.axis.decimals);
                        labels.push((vx, by + bar_h * 0.5, text, *val >= baseline_val, tokens.text_muted.clone()));
                    }
                }
                svg.close_group();
            }
        }
        BarMode::Stacked | BarMode::PercentStacked => {
            let bar_h = (slot_h * 0.62).clamp(2.0, 48.0);
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
                        let r = if last_pos[c_idx] == Some(s_idx) {
                            BarRoundEnd::Right
                        } else {
                            BarRoundEnd::None
                        };
                        (start, acc_pos[c_idx], r)
                    } else {
                        let start = acc_neg[c_idx];
                        acc_neg[c_idx] += val;
                        let r = if last_neg[c_idx] == Some(s_idx) {
                            BarRoundEnd::Left
                        } else {
                            BarRoundEnd::None
                        };
                        (start, acc_neg[c_idx], r)
                    };

                    let x0 = x_scale.map(start, plot.x, plot.right()).clamp(plot.x, plot.right());
                    let x1 = x_scale.map(end_val, plot.x, plot.right()).clamp(plot.x, plot.right());
                    let left = x0.min(x1);
                    let w = (x1 - x0).abs();
                    let by = plot.y + c_idx as f64 * slot_h + (slot_h - bar_h) * 0.5;
                    if w > 0.05 {
                        let d = rounded_bar_path(left, by, w, bar_h, style.radius, round_end);
                        svg.path(&d, Paint::fill(&style.colors[s_idx]));
                    }
                    if style.show_values && w >= 24.0 {
                        let text = format_value(val, fmt, style.axis.currency_symbol.as_deref(), style.axis.decimals);
                        labels.push((left + w * 0.5, by + bar_h * 0.5, text, true, inside_ink.clone()));
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
            let (tx, anchor) = match style.mode {
                BarMode::Grouped => {
                    if positive {
                        (lx + 4.0, TextAnchor::Start)
                    } else {
                        (lx - 4.0, TextAnchor::End)
                    }
                }
                BarMode::Stacked | BarMode::PercentStacked => (lx, TextAnchor::Middle),
            };
            svg.text(
                tx,
                ly,
                &text,
                TextStyle::new(&fill, DATA_LABEL_FONT)
                    .bold(is_stacked)
                    .anchor(anchor)
                    .baseline(DominantBaseline::Central),
            );
        }
        svg.close_group();
    }
}
