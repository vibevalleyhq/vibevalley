use crate::layout::{
    AnnotationScales, CartesianAxes, ChromeLayout, DATA_LABEL_FONT, DrawCtx, LegendItem, LegendSwatch, ResolvedLegend, XAxisMapping, compute_cartesian_plot,
    draw_annotations_back, draw_annotations_front, draw_left_y_axis, draw_numeric_x_axis, draw_x_gridlines, draw_y_gridlines,
};
use crate::scale::NumericScale;
use crate::spec::{ChartSpec, NumberFormat, ScatterSpec};
use crate::svg::{Paint, SvgBuilder, TextAnchor, TextStyle};

pub(crate) fn render(spec: &ChartSpec, scatter: &ScatterSpec, is_bubble: bool, ctx: DrawCtx<'_>, svg: &mut SvgBuilder) {
    let colors: Vec<String> = scatter
        .series
        .iter()
        .enumerate()
        .map(|(i, s)| ctx.tokens.series_color(i, s.color.as_deref(), spec.palette.as_deref()))
        .collect();

    let legend_items: Vec<LegendItem> = scatter
        .series
        .iter()
        .enumerate()
        .map(|(i, s)| LegendItem {
            label: s.name.clone(),
            color: colors[i].clone(),
            swatch: LegendSwatch::Circle,
            dashed: false,
        })
        .collect();

    let default_legend = if scatter.series.len() > 1 {
        ResolvedLegend::Top
    } else {
        ResolvedLegend::None
    };

    let chrome = ChromeLayout::compute(spec, ctx, &legend_items, default_legend);
    chrome.draw_background(svg, ctx.tokens);
    chrome.draw_header(svg, ctx.tokens);

    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    let mut min_size = f64::INFINITY;
    let mut max_size = f64::NEG_INFINITY;

    for s in &scatter.series {
        for pt in &s.points {
            min_x = min_x.min(pt.x);
            max_x = max_x.max(pt.x);
            min_y = min_y.min(pt.y);
            max_y = max_y.max(pt.y);
            if let Some(sz) = pt.size {
                min_size = min_size.min(sz);
                max_size = max_size.max(sz);
            }
        }
    }

    let x_scale = NumericScale::build(min_x, max_x, &spec.x_axis, false, NumberFormat::Number);
    let y_scale = NumericScale::build(min_y, max_y, &spec.y_axis, false, NumberFormat::Number);

    let axes = CartesianAxes {
        x_axis: &spec.x_axis,
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
    draw_x_gridlines(svg, plot, &x_scale, &spec.x_axis, true, ctx.tokens);
    draw_annotations_back(svg, plot, &spec.annotations, &ann_scales, ctx.tokens);

    let base_r = scatter.point_radius.unwrap_or(5.0);
    let min_r = scatter.min_radius.unwrap_or(5.0);
    let max_r = scatter.max_radius.unwrap_or(22.0);
    let has_sizes = is_bubble || min_size.is_finite();
    let fill_op = if has_sizes { 0.65 } else { 0.85 };

    svg.open_group("series");
    let mut labels: Vec<(f64, f64, String)> = Vec::new();
    for (s_idx, s) in scatter.series.iter().enumerate() {
        let color = &colors[s_idx];
        svg.open_group_with_name("scatter-series", &s.name);
        for pt in &s.points {
            let px = x_scale.map(pt.x, plot.x, plot.right()).clamp(plot.x, plot.right());
            let py = y_scale.map(pt.y, plot.bottom(), plot.y).clamp(plot.y, plot.bottom());
            let r = match pt.size {
                Some(sz) => {
                    // Scale radius by sqrt(size) so bubble area stays proportional to value.
                    if (max_size - min_size).abs() < 1e-12 {
                        (min_r + max_r) * 0.5
                    } else {
                        let t = ((sz.sqrt() - min_size.sqrt()) / (max_size.sqrt() - min_size.sqrt())).clamp(0.0, 1.0);
                        min_r + (max_r - min_r) * t
                    }
                }
                None => base_r,
            };

            svg.circle(px, py, r, Paint::fill(color).fill_opacity(fill_op).with_stroke(color, 1.4));
            if scatter.show_labels
                && let Some(lbl) = pt.label.as_deref()
                && !lbl.is_empty()
            {
                labels.push((px, (py - r - 4.0).max(plot.y + 8.0), lbl.to_string()));
            }
        }
        svg.close_group();
    }
    svg.close_group();

    if !labels.is_empty() {
        svg.open_group("data-labels");
        for (lx, ly, txt) in labels {
            svg.text(lx, ly, &txt, TextStyle::new(&ctx.tokens.text_muted, DATA_LABEL_FONT).anchor(TextAnchor::Middle));
        }
        svg.close_group();
    }

    draw_left_y_axis(svg, plot, chrome.content.x, &y_scale, &spec.y_axis, ctx.tokens);
    draw_numeric_x_axis(svg, plot, &x_scale, &spec.x_axis, ctx);
    draw_annotations_front(svg, plot, &spec.annotations, &ann_scales, ctx);
    chrome.draw_legend(svg, ctx.tokens);
}
