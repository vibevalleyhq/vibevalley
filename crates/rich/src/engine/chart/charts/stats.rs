use crate::engine::chart::layout::{
    AnnotationScales, CartesianAxes, ChromeLayout, DATA_LABEL_FONT, DrawCtx, ResolvedLegend, XAxisMapping, category_x_center, compute_cartesian_plot,
    compute_horizontal_plot, draw_annotations_back, draw_annotations_front, draw_category_x_axis, draw_category_y_axis, draw_left_y_axis, draw_numeric_x_axis,
    draw_x_gridlines, draw_y_gridlines,
};
use crate::engine::chart::scale::{NumericScale, format_value, nice_number};
use crate::engine::chart::spec::{AxisScale, BarOrientation, BoxStats, BoxplotSpec, ChartSpec, HistogramMode, HistogramSpec, NumberFormat};
use crate::engine::chart::svg::{BarRoundEnd, Paint, SvgBuilder, TextAnchor, TextStyle, rounded_bar_path};

/// Computes Tukey five-number summary, 1.5*IQR whiskers, outliers, and mean from raw samples.
pub fn compute_box_stats(samples: &[f64]) -> BoxStats {
    let mut sorted: Vec<f64> = samples.iter().copied().filter(|v| v.is_finite()).collect();
    sorted.sort_by(f64::total_cmp);
    if sorted.is_empty() {
        return BoxStats {
            min: 0.0,
            q1: 0.0,
            median: 0.0,
            q3: 0.0,
            max: 0.0,
            outliers: Vec::new(),
            mean: Some(0.0),
        };
    }

    let q1 = percentile_sorted(&sorted, 0.25);
    let median = percentile_sorted(&sorted, 0.50);
    let q3 = percentile_sorted(&sorted, 0.75);
    let iqr = q3 - q1;
    let lower_fence = q1 - 1.5 * iqr;
    let upper_fence = q3 + 1.5 * iqr;

    let whisker_low = sorted.iter().copied().find(|&v| v >= lower_fence).unwrap_or(sorted[0]);
    let whisker_high = sorted.iter().copied().rev().find(|&v| v <= upper_fence).unwrap_or(sorted[sorted.len() - 1]);

    let outliers: Vec<f64> = sorted.iter().copied().filter(|&v| v < whisker_low || v > whisker_high).collect();
    let mean = sorted.iter().sum::<f64>() / sorted.len() as f64;

    BoxStats {
        min: whisker_low,
        q1,
        median,
        q3,
        max: whisker_high,
        outliers,
        mean: Some(mean),
    }
}

fn percentile_sorted(sorted: &[f64], p: f64) -> f64 {
    if sorted.len() == 1 {
        return sorted[0];
    }
    let idx = p.clamp(0.0, 1.0) * (sorted.len() - 1) as f64;
    let lo = idx.floor() as usize;
    let hi = idx.ceil() as usize;
    if lo == hi {
        sorted[lo]
    } else {
        let frac = idx - lo as f64;
        sorted[lo] + (sorted[hi] - sorted[lo]) * frac
    }
}

pub(crate) fn render_boxplot(spec: &ChartSpec, bp: &BoxplotSpec, ctx: DrawCtx<'_>, svg: &mut SvgBuilder) {
    let chrome = ChromeLayout::compute(spec, ctx, &[], ResolvedLegend::None);
    chrome.draw_background(svg, ctx.tokens);
    chrome.draw_header(svg, ctx.tokens);

    let resolved: Vec<(String, BoxStats, String)> = bp
        .groups
        .iter()
        .enumerate()
        .map(|(i, g)| {
            let stats = match (&g.samples, &g.stats) {
                (Some(s), _) => compute_box_stats(s),
                (None, Some(st)) => st.clone(),
                (None, None) => compute_box_stats(&[]),
            };
            let color = ctx.tokens.series_color(i, g.color.as_deref(), spec.palette.as_deref());
            (g.label.clone(), stats, color)
        })
        .collect();

    let mut min_v = f64::INFINITY;
    let mut max_v = f64::NEG_INFINITY;
    for (_, st, _) in &resolved {
        min_v = min_v.min(st.min);
        max_v = max_v.max(st.max);
        for &o in &st.outliers {
            min_v = min_v.min(o);
            max_v = max_v.max(o);
        }
    }
    let labels: Vec<String> = resolved.iter().map(|(l, _, _)| l.clone()).collect();

    match bp.orientation {
        BarOrientation::Vertical => {
            let y_scale = NumericScale::build(min_v, max_v, &spec.y_axis, false, NumberFormat::Number);
            let axes = CartesianAxes {
                x_axis: &spec.x_axis,
                y_axis: &spec.y_axis,
                y2_axis: None,
                y_scale: &y_scale,
                y2_scale: None,
                x_categories: Some(&labels),
                x_scale: None,
            };
            let (plot, x_plan) = compute_cartesian_plot(chrome.content, &axes, ctx.measurer);
            let ann_scales = AnnotationScales {
                x_map: XAxisMapping::Categories {
                    categories: &labels,
                    center_in_slot: true,
                },
                y_left: &y_scale,
                y_right: None,
            };

            draw_y_gridlines(svg, plot, &y_scale, &spec.y_axis, ctx.tokens);
            draw_annotations_back(svg, plot, &spec.annotations, &ann_scales, ctx.tokens);

            let count = resolved.len();
            let slot_w = plot.width / count.max(1) as f64;
            let box_w = (slot_w * 0.46).clamp(10.0, 56.0);
            let cap_w = box_w * 0.55;

            svg.open_group("series");
            for (idx, (lbl, st, color)) in resolved.iter().enumerate() {
                let cx = category_x_center(plot, idx, count, true);
                let y_min = y_scale.map(st.min, plot.bottom(), plot.y).clamp(plot.y, plot.bottom());
                let y_q1 = y_scale.map(st.q1, plot.bottom(), plot.y).clamp(plot.y, plot.bottom());
                let y_med = y_scale.map(st.median, plot.bottom(), plot.y).clamp(plot.y, plot.bottom());
                let y_q3 = y_scale.map(st.q3, plot.bottom(), plot.y).clamp(plot.y, plot.bottom());
                let y_max = y_scale.map(st.max, plot.bottom(), plot.y).clamp(plot.y, plot.bottom());

                svg.open_group_with_name("boxplot-group", lbl);
                svg.line(cx, y_max, cx, y_q3, Paint::stroke(color, 1.5));
                svg.line(cx, y_q1, cx, y_min, Paint::stroke(color, 1.5));
                svg.line(cx - cap_w * 0.5, y_max, cx + cap_w * 0.5, y_max, Paint::stroke(color, 1.5));
                svg.line(cx - cap_w * 0.5, y_min, cx + cap_w * 0.5, y_min, Paint::stroke(color, 1.5));

                let box_top = y_q3.min(y_q1);
                let box_h = (y_q1 - y_q3).abs().max(1.0);
                svg.rect(
                    cx - box_w * 0.5,
                    box_top,
                    box_w,
                    box_h,
                    Some(2.5),
                    Paint::fill(color).fill_opacity(0.24).with_stroke(color, 1.6),
                );
                svg.line(cx - box_w * 0.5, y_med, cx + box_w * 0.5, y_med, Paint::stroke(color, 2.4));

                if bp.show_mean
                    && let Some(mean) = st.mean
                {
                    let ym = y_scale.map(mean, plot.bottom(), plot.y).clamp(plot.y, plot.bottom());
                    let r = 4.0;
                    svg.polygon(
                        &[(cx, ym - r), (cx + r, ym), (cx, ym + r), (cx - r, ym)],
                        Paint::fill(&ctx.tokens.background).with_stroke(color, 1.6),
                    );
                }

                for &o in &st.outliers {
                    let yo = y_scale.map(o, plot.bottom(), plot.y).clamp(plot.y, plot.bottom());
                    svg.circle(cx, yo, 3.2, Paint::fill(&ctx.tokens.background).with_stroke(color, 1.5));
                }
                svg.close_group();
            }
            svg.close_group();

            draw_left_y_axis(svg, plot, chrome.content.x, &y_scale, &spec.y_axis, ctx.tokens);
            if let Some(plan) = &x_plan {
                draw_category_x_axis(svg, plot, &labels, plan, &spec.x_axis, true, ctx);
            }
            draw_annotations_front(svg, plot, &spec.annotations, &ann_scales, ctx);
        }
        BarOrientation::Horizontal => {
            let x_scale = NumericScale::build(min_v, max_v, &spec.x_axis, false, NumberFormat::Number);
            let (plot, max_cat_px) = compute_horizontal_plot(chrome.content, &spec.x_axis, &spec.y_axis, &labels, ctx.measurer);
            draw_x_gridlines(svg, plot, &x_scale, &spec.x_axis, true, ctx.tokens);
            let dummy_y = NumericScale::build(0.0, labels.len().max(1) as f64, &spec.y_axis, true, NumberFormat::Number);
            let ann_scales = AnnotationScales {
                x_map: XAxisMapping::Numeric(&x_scale),
                y_left: &dummy_y,
                y_right: None,
            };
            draw_annotations_back(svg, plot, &spec.annotations, &ann_scales, ctx.tokens);

            let count = resolved.len();
            let slot_h = plot.height / count.max(1) as f64;
            let box_h = (slot_h * 0.46).clamp(10.0, 42.0);
            let cap_h = box_h * 0.55;

            svg.open_group("series");
            for (idx, (lbl, st, color)) in resolved.iter().enumerate() {
                let cy = plot.y + (idx as f64 + 0.5) * slot_h;
                let x_min = x_scale.map(st.min, plot.x, plot.right()).clamp(plot.x, plot.right());
                let x_q1 = x_scale.map(st.q1, plot.x, plot.right()).clamp(plot.x, plot.right());
                let x_med = x_scale.map(st.median, plot.x, plot.right()).clamp(plot.x, plot.right());
                let x_q3 = x_scale.map(st.q3, plot.x, plot.right()).clamp(plot.x, plot.right());
                let x_max = x_scale.map(st.max, plot.x, plot.right()).clamp(plot.x, plot.right());

                svg.open_group_with_name("boxplot-group", lbl);
                svg.line(x_min, cy, x_q1, cy, Paint::stroke(color, 1.5));
                svg.line(x_q3, cy, x_max, cy, Paint::stroke(color, 1.5));
                svg.line(x_min, cy - cap_h * 0.5, x_min, cy + cap_h * 0.5, Paint::stroke(color, 1.5));
                svg.line(x_max, cy - cap_h * 0.5, x_max, cy + cap_h * 0.5, Paint::stroke(color, 1.5));

                let left = x_q1.min(x_q3);
                let w = (x_q3 - x_q1).abs().max(1.0);
                svg.rect(
                    left,
                    cy - box_h * 0.5,
                    w,
                    box_h,
                    Some(2.5),
                    Paint::fill(color).fill_opacity(0.24).with_stroke(color, 1.6),
                );
                svg.line(x_med, cy - box_h * 0.5, x_med, cy + box_h * 0.5, Paint::stroke(color, 2.4));

                if bp.show_mean
                    && let Some(mean) = st.mean
                {
                    let xm = x_scale.map(mean, plot.x, plot.right()).clamp(plot.x, plot.right());
                    let r = 4.0;
                    svg.polygon(
                        &[(xm, cy - r), (xm + r, cy), (xm, cy + r), (xm - r, cy)],
                        Paint::fill(&ctx.tokens.background).with_stroke(color, 1.6),
                    );
                }

                for &o in &st.outliers {
                    let xo = x_scale.map(o, plot.x, plot.right()).clamp(plot.x, plot.right());
                    svg.circle(xo, cy, 3.2, Paint::fill(&ctx.tokens.background).with_stroke(color, 1.5));
                }
                svg.close_group();
            }
            svg.close_group();

            draw_category_y_axis(svg, plot, chrome.content.x, &labels, max_cat_px, &spec.y_axis, ctx);
            draw_numeric_x_axis(svg, plot, &x_scale, &spec.x_axis, ctx);
            draw_annotations_front(svg, plot, &spec.annotations, &ann_scales, ctx);
        }
    }
}

/// Computed histogram bin.
#[derive(Debug, Clone, PartialEq)]
pub struct HistogramBin {
    pub x0: f64,
    pub x1: f64,
    pub count: usize,
    pub height: f64,
}

/// Bins `values` into histogram bars using explicit edges, explicit bin count, or
/// Freedman-Diaconis / Sturges auto-binning snapped to Heckbert nice numbers.
pub fn compute_histogram_bins(values: &[f64], explicit_bins: Option<usize>, explicit_edges: Option<&[f64]>, mode: HistogramMode) -> Vec<HistogramBin> {
    let mut sorted: Vec<f64> = values.iter().copied().filter(|v| v.is_finite()).collect();
    sorted.sort_by(f64::total_cmp);
    if sorted.is_empty() {
        return Vec::new();
    }

    let edges: Vec<f64> = if let Some(ed) = explicit_edges {
        ed.to_vec()
    } else {
        let min_v = sorted[0];
        let max_v = sorted[sorted.len() - 1];
        let (lo, hi) = if (max_v - min_v).abs() < 1e-12 {
            (min_v - 0.5, max_v + 0.5)
        } else {
            (min_v, max_v)
        };

        let bin_count = match explicit_bins {
            Some(k) => k.clamp(1, 200),
            None => auto_bin_count(&sorted),
        };

        if explicit_bins.is_some() {
            let step = (hi - lo) / bin_count as f64;
            let mut e: Vec<f64> = (0..=bin_count).map(|i| lo + i as f64 * step).collect();
            if let Some(last) = e.last_mut() {
                *last = hi;
            }
            e
        } else {
            let step = nice_number((hi - lo) / bin_count as f64, true);
            let start = (lo / step).floor() * step;
            let end = (hi / step).ceil() * step;
            let count = (((end - start) / step).round() as usize).clamp(1, 200);
            let mut e: Vec<f64> = (0..=count).map(|i| start + i as f64 * step).collect();
            if let Some(last) = e.last_mut()
                && *last < hi
            {
                *last = hi;
            }
            e
        }
    };

    let n_bins = edges.len().saturating_sub(1);
    let mut counts = vec![0usize; n_bins];
    let tol = 1e-12 * (edges[n_bins] - edges[0]).abs().max(1.0);
    for &v in &sorted {
        if v < edges[0] - tol || v > edges[n_bins] + tol {
            continue;
        }
        if v >= edges[n_bins] - tol {
            counts[n_bins - 1] += 1;
            continue;
        }
        let pos = edges.partition_point(|&e| e <= v);
        let bin = pos.saturating_sub(1).min(n_bins - 1);
        counts[bin] += 1;
    }

    let total = sorted.len() as f64;
    (0..n_bins)
        .map(|i| {
            let x0 = edges[i];
            let x1 = edges[i + 1];
            let width = (x1 - x0).max(1e-12);
            let count = counts[i];
            let height = match mode {
                HistogramMode::Count => count as f64,
                HistogramMode::Percent => count as f64 / total,
                HistogramMode::Density => count as f64 / (total * width),
            };
            HistogramBin { x0, x1, count, height }
        })
        .collect()
}

fn auto_bin_count(sorted: &[f64]) -> usize {
    let n = sorted.len();
    if n <= 3 {
        return n.max(1);
    }
    let sturges = ((n as f64).log2().ceil() as usize + 1).clamp(3, 30);
    let q1 = percentile_sorted(sorted, 0.25);
    let q3 = percentile_sorted(sorted, 0.75);
    let iqr = q3 - q1;
    let span = sorted[n - 1] - sorted[0];
    if iqr > 1e-12 && span > 1e-12 {
        let fd_width = 2.0 * iqr / (n as f64).cbrt();
        if fd_width > 0.0 {
            let fd_bins = (span / fd_width).ceil() as usize;
            return fd_bins.clamp(4, 30);
        }
    }
    sturges
}

pub(crate) fn render_histogram(spec: &ChartSpec, hist: &HistogramSpec, ctx: DrawCtx<'_>, svg: &mut SvgBuilder) {
    let chrome = ChromeLayout::compute(spec, ctx, &[], ResolvedLegend::None);
    chrome.draw_background(svg, ctx.tokens);
    chrome.draw_header(svg, ctx.tokens);

    let bins = compute_histogram_bins(&hist.values, hist.bins, hist.bin_edges.as_deref(), hist.normalize);
    if bins.is_empty() {
        return;
    }

    let x_min = bins[0].x0;
    let x_max = bins[bins.len() - 1].x1;
    let y_max = bins.iter().map(|b| b.height).fold(0.0_f64, f64::max);

    let default_y_fmt = match hist.normalize {
        HistogramMode::Percent => NumberFormat::Percent,
        HistogramMode::Count | HistogramMode::Density => NumberFormat::Number,
    };

    let mut x_axis = spec.x_axis.clone();
    x_axis.min.get_or_insert(x_min);
    x_axis.max.get_or_insert(x_max);
    let x_scale = NumericScale::build(x_min, x_max, &x_axis, false, NumberFormat::Number);
    let y_scale = NumericScale::build(0.0, y_max, &spec.y_axis, spec.y_axis.scale == AxisScale::Linear, default_y_fmt);

    let axes = CartesianAxes {
        x_axis: &x_axis,
        y_axis: &spec.y_axis,
        y2_axis: None,
        y_scale: &y_scale,
        y2_scale: None,
        x_categories: None,
        x_scale: Some(&x_scale),
    };
    let (plot, _) = compute_cartesian_plot(chrome.content, &axes, ctx.measurer);
    let ann_scales = AnnotationScales {
        x_map: XAxisMapping::Numeric(&x_scale),
        y_left: &y_scale,
        y_right: None,
    };

    draw_y_gridlines(svg, plot, &y_scale, &spec.y_axis, ctx.tokens);
    draw_annotations_back(svg, plot, &spec.annotations, &ann_scales, ctx.tokens);

    let color = ctx.tokens.series_color(0, hist.color.as_deref(), spec.palette.as_deref());
    let y_fmt = if spec.y_axis.format == NumberFormat::Number {
        default_y_fmt
    } else {
        spec.y_axis.format
    };

    svg.open_group("series");
    let mut labels: Vec<(f64, f64, String)> = Vec::new();
    for bin in &bins {
        let bx0 = x_scale.map(bin.x0, plot.x, plot.right()).clamp(plot.x, plot.right());
        let bx1 = x_scale.map(bin.x1, plot.x, plot.right()).clamp(plot.x, plot.right());
        let gap = if (bx1 - bx0) > 4.0 { 1.5 } else { 0.4 };
        let w = (bx1 - bx0 - gap).max(1.0);
        let x = bx0 + gap * 0.5;
        let top = y_scale.map(bin.height, plot.bottom(), plot.y).clamp(plot.y, plot.bottom());
        let h = (plot.bottom() - top).max(0.0);
        if h > 0.05 {
            let d = rounded_bar_path(x, top, w, h, 2.0, BarRoundEnd::Top);
            svg.path(&d, Paint::fill(&color).fill_opacity(0.85));
        }
        if hist.show_values && bin.count > 0 && w >= 16.0 {
            let txt = format_value(bin.height, y_fmt, spec.y_axis.currency_symbol.as_deref(), spec.y_axis.decimals);
            labels.push((x + w * 0.5, (top - 4.0).max(plot.y + 8.0), txt));
        }
    }
    svg.close_group();

    if hist.show_mean {
        let mean = hist.values.iter().sum::<f64>() / hist.values.len() as f64;
        let mx = x_scale.map(mean, plot.x, plot.right());
        if mx >= plot.x && mx <= plot.right() {
            svg.open_group("histogram-mean");
            svg.line(mx, plot.y, mx, plot.bottom(), Paint::stroke(&ctx.tokens.annotation, 1.5).dash(Some("5,3")));
            let lbl = format!(
                "Mean {}",
                format_value(mean, spec.x_axis.format, spec.x_axis.currency_symbol.as_deref(), spec.x_axis.decimals)
            );
            let anchor = if mx > plot.right() - 64.0 { TextAnchor::End } else { TextAnchor::Start };
            svg.text(
                (mx + 4.0).min(plot.right() - 4.0),
                plot.y + 11.0,
                &lbl,
                TextStyle::new(&ctx.tokens.annotation, DATA_LABEL_FONT).bold(true).anchor(anchor),
            );
            svg.close_group();
        }
    }

    if !labels.is_empty() {
        svg.open_group("data-labels");
        for (x, y, txt) in labels {
            svg.text(x, y, &txt, TextStyle::new(&ctx.tokens.text_muted, DATA_LABEL_FONT).anchor(TextAnchor::Middle));
        }
        svg.close_group();
    }

    draw_left_y_axis(svg, plot, chrome.content.x, &y_scale, &spec.y_axis, ctx.tokens);
    draw_numeric_x_axis(svg, plot, &x_scale, &x_axis, ctx);
    draw_annotations_front(svg, plot, &spec.annotations, &ann_scales, ctx);
}
