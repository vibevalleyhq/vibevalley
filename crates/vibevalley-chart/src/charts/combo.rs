use crate::charts::bar::{BarDrawStyle, bar_value_extent, draw_vertical_bars};
use crate::charts::build_curve_path;
use crate::charts::line::split_series_runs;
use crate::layout::{
    AnnotationScales, CartesianAxes, ChromeLayout, DATA_LABEL_FONT, DrawCtx, LegendItem, LegendSwatch, ResolvedLegend, XAxisMapping, category_x_center,
    compute_cartesian_plot, draw_annotations_back, draw_annotations_front, draw_category_x_axis, draw_left_y_axis, draw_right_y_axis, draw_y_gridlines,
};
use crate::scale::{NumericScale, format_value};
use crate::spec::{AxisScale, BarMode, ChartSpec, ComboSpec, NumberFormat, ValueAxisSide};
use crate::svg::{Paint, SvgBuilder, TextAnchor, TextStyle};

pub(crate) fn render(spec: &ChartSpec, combo: &ComboSpec, ctx: DrawCtx<'_>, svg: &mut SvgBuilder) {
    let mut bar_colors = Vec::with_capacity(combo.bars.len());
    let mut line_colors = Vec::with_capacity(combo.lines.len());
    let mut legend_items = Vec::with_capacity(combo.bars.len() + combo.lines.len());

    for (i, b) in combo.bars.iter().enumerate() {
        let c = ctx.tokens.series_color(i, b.color.as_deref(), spec.palette.as_deref());
        legend_items.push(LegendItem {
            label: b.name.clone(),
            color: c.clone(),
            swatch: LegendSwatch::Square,
            dashed: false,
        });
        bar_colors.push(c);
    }

    let line_offset = combo.bars.len();
    for (i, l) in combo.lines.iter().enumerate() {
        let c = ctx.tokens.series_color(line_offset + i, l.color.as_deref(), spec.palette.as_deref());
        legend_items.push(LegendItem {
            label: l.name.clone(),
            color: c.clone(),
            swatch: LegendSwatch::Line,
            dashed: l.dashed,
        });
        line_colors.push(c);
    }

    let default_legend = if legend_items.len() > 1 { ResolvedLegend::Top } else { ResolvedLegend::None };

    let chrome = ChromeLayout::compute(spec, ctx, &legend_items, default_legend);
    chrome.draw_background(svg, ctx.tokens);
    chrome.draw_header(svg, ctx.tokens);

    let (mut left_min, mut left_max) = if combo.bars.is_empty() {
        (f64::INFINITY, f64::NEG_INFINITY)
    } else {
        bar_value_extent(&combo.bars, combo.categories.len(), combo.bar_mode)
    };
    let mut right_min = f64::INFINITY;
    let mut right_max = f64::NEG_INFINITY;
    let mut has_right = false;

    for l in &combo.lines {
        for v in l.data.iter().flatten() {
            match l.axis {
                ValueAxisSide::Left => {
                    left_min = left_min.min(*v);
                    left_max = left_max.max(*v);
                }
                ValueAxisSide::Right => {
                    has_right = true;
                    right_min = right_min.min(*v);
                    right_max = right_max.max(*v);
                }
            }
        }
    }
    if !left_min.is_finite() {
        left_min = 0.0;
        left_max = 1.0;
    }

    let default_left_fmt = match combo.bar_mode {
        BarMode::PercentStacked if !combo.bars.is_empty() => NumberFormat::Percent,
        BarMode::Grouped | BarMode::Stacked | BarMode::PercentStacked => NumberFormat::Number,
    };
    let mut y_axis = spec.y_axis.clone();
    if combo.bar_mode == BarMode::PercentStacked && !combo.bars.is_empty() {
        y_axis.min.get_or_insert(0.0);
        y_axis.max.get_or_insert(1.0);
    }
    let y_scale = NumericScale::build(
        left_min,
        left_max,
        &y_axis,
        !combo.bars.is_empty() && y_axis.scale == AxisScale::Linear,
        default_left_fmt,
    );

    let y2_scale = if has_right {
        Some(NumericScale::build(right_min, right_max, &spec.y2_axis, false, NumberFormat::Number))
    } else {
        None
    };

    let axes = CartesianAxes {
        x_axis: &spec.x_axis,
        y_axis: &y_axis,
        y2_axis: if has_right { Some(&spec.y2_axis) } else { None },
        y_scale: &y_scale,
        y2_scale: y2_scale.as_ref(),
        x_categories: Some(&combo.categories),
        x_scale: None,
    };
    let (plot, x_plan) = compute_cartesian_plot(chrome.content, &axes, ctx.measurer);
    let ann_scales = AnnotationScales {
        x_map: XAxisMapping::Categories {
            categories: &combo.categories,
            center_in_slot: true,
        },
        y_left: &y_scale,
        y_right: y2_scale.as_ref(),
    };

    draw_y_gridlines(svg, plot, &y_scale, &y_axis, ctx.tokens);
    draw_annotations_back(svg, plot, &spec.annotations, &ann_scales, ctx.tokens);

    if !combo.bars.is_empty() {
        let style = BarDrawStyle {
            mode: combo.bar_mode,
            axis: &y_axis,
            default_fmt: default_left_fmt,
            colors: &bar_colors,
            spec_palette: spec.palette.as_deref(),
            radius: combo.bar_corner_radius.unwrap_or(3.0),
            show_values: combo.show_values,
        };
        draw_vertical_bars(svg, plot, &combo.bars, combo.categories.len(), &y_scale, &style, ctx.tokens);
    }

    if !combo.lines.is_empty() {
        let count = combo.categories.len();
        let x_coords: Vec<f64> = (0..count).map(|idx| category_x_center(plot, idx, count, true)).collect();

        svg.open_group("combo-lines");
        let mut labels: Vec<(f64, f64, String, String)> = Vec::new();
        for (idx, line) in combo.lines.iter().enumerate() {
            let color = &line_colors[idx];
            let sw = line.stroke_width.unwrap_or(2.4);
            let dash = if line.dashed { Some("6,4") } else { None };
            let (scale, axis_spec) = match line.axis {
                ValueAxisSide::Left => (&y_scale, &y_axis),
                ValueAxisSide::Right => (y2_scale.as_ref().unwrap_or(&y_scale), &spec.y2_axis),
            };

            svg.open_group_with_name("line-series", &line.name);
            let segments = split_series_runs(&line.data, &x_coords, scale, plot, false);
            for seg in &segments {
                if seg.len() >= 2 {
                    let pts: Vec<(f64, f64)> = seg.iter().map(|&(x, y, _)| (x, y)).collect();
                    let d = build_curve_path(&pts, combo.interpolation);
                    svg.path(&d, Paint::stroke(color, sw).dash(dash).round_caps());
                }
                for &(px, py, raw) in seg {
                    if combo.show_points || seg.len() == 1 {
                        svg.circle(px, py, 3.6, Paint::fill(color).with_stroke(&ctx.tokens.background, 1.5));
                    }
                    if combo.show_values {
                        let txt = format_value(raw, axis_spec.format, axis_spec.currency_symbol.as_deref(), axis_spec.decimals);
                        labels.push((px, (py - 8.0).max(plot.y + 8.0), txt, color.clone()));
                    }
                }
            }
            svg.close_group();
        }
        svg.close_group();

        if !labels.is_empty() {
            svg.open_group("combo-line-labels");
            for (x, y, txt, color) in labels {
                svg.text(x, y, &txt, TextStyle::new(&color, DATA_LABEL_FONT).bold(true).anchor(TextAnchor::Middle));
            }
            svg.close_group();
        }
    }

    draw_left_y_axis(svg, plot, chrome.content.x, &y_scale, &y_axis, ctx.tokens);
    if let Some(s2) = &y2_scale {
        draw_right_y_axis(svg, plot, chrome.content.right(), s2, &spec.y2_axis, ctx.tokens);
    }
    if let Some(plan) = &x_plan {
        draw_category_x_axis(svg, plot, &combo.categories, plan, &spec.x_axis, true, ctx);
    }

    draw_annotations_front(svg, plot, &spec.annotations, &ann_scales, ctx);
    chrome.draw_legend(svg, ctx.tokens);
}
