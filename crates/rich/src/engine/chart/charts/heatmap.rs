use crate::engine::chart::color::{Rgb, interpolate_ramp, parse_rgb};
use crate::engine::chart::layout::{AXIS_TITLE_FONT, CategoryXPlan, ChromeLayout, DATA_LABEL_FONT, DrawCtx, Rect, ResolvedLegend, TICK_FONT};
use crate::engine::chart::measure::truncate_text;
use crate::engine::chart::scale::format_value;
use crate::engine::chart::spec::{ChartSpec, HeatmapScale, HeatmapSpec};
use crate::engine::chart::svg::{DominantBaseline, Paint, SvgBuilder, TextAnchor, TextStyle};
use crate::engine::chart::theme::PaintTokens;

pub(crate) fn render(spec: &ChartSpec, hm: &HeatmapSpec, ctx: DrawCtx<'_>, svg: &mut SvgBuilder) {
    let chrome = ChromeLayout::compute(spec, ctx, &[], ResolvedLegend::None);
    chrome.draw_background(svg, ctx.tokens);
    chrome.draw_header(svg, ctx.tokens);

    let mut obs_min = f64::INFINITY;
    let mut obs_max = f64::NEG_INFINITY;
    for row in &hm.values {
        for cell in row.iter().flatten() {
            obs_min = obs_min.min(*cell);
            obs_max = obs_max.max(*cell);
        }
    }
    let min_v = hm.min.unwrap_or(obs_min);
    let max_v = hm.max.unwrap_or(obs_max);
    let show_color_bar = hm.show_color_bar.unwrap_or(true);

    let max_row_cap = (chrome.content.width * 0.28).clamp(56.0, 150.0);
    let row_label_w = hm
        .y_labels
        .iter()
        .map(|l| ctx.measurer.measure(l, TICK_FONT, false).width)
        .fold(24.0_f64, f64::max)
        .min(max_row_cap);
    let y_title_w = if spec.y_axis.label.as_deref().is_some_and(|l| !l.is_empty()) {
        AXIS_TITLE_FONT * 1.6
    } else {
        0.0
    };
    let left_margin = row_label_w + 10.0 + y_title_w;
    let right_margin = 10.0;
    let grid_w = (chrome.content.width - left_margin - right_margin).max(60.0);

    let x_plan = CategoryXPlan::compute(&hm.x_labels, grid_w, ctx.measurer);
    let x_title_h = if spec.x_axis.label.as_deref().is_some_and(|l| !l.is_empty()) {
        AXIS_TITLE_FONT * 1.6
    } else {
        0.0
    };
    let bar_h = if show_color_bar { 32.0 } else { 0.0 };
    let bottom_margin = x_plan.label_height + 8.0 + x_title_h + bar_h;
    let grid_h = (chrome.content.height - bottom_margin - 4.0).max(48.0);

    let grid = Rect {
        x: chrome.content.x + left_margin,
        y: chrome.content.y + 4.0,
        width: grid_w,
        height: grid_h,
    };

    let rows = hm.y_labels.len();
    let cols = hm.x_labels.len();
    let cell_w = grid.width / cols as f64;
    let cell_h = grid.height / rows as f64;
    let gap = hm.cell_gap.unwrap_or(2.0).min(cell_w * 0.25).min(cell_h * 0.25);
    let radius = hm.cell_radius.unwrap_or(2.0);
    let show_values = hm.show_values.unwrap_or(cell_w >= 28.0 && cell_h >= 18.0);

    let ramp = resolve_ramp(&hm.color_scale, ctx.tokens);
    let is_diverging = matches!(hm.color_scale, HeatmapScale::Diverging | HeatmapScale::Custom { mid: Some(_), .. });
    let default_mid = if min_v < 0.0 && max_v > 0.0 { 0.0 } else { (min_v + max_v) * 0.5 };
    let midpoint = hm.midpoint.unwrap_or(default_mid);

    svg.open_group("series");
    let mut cell_labels: Vec<(f64, f64, String, String)> = Vec::new();
    for (r_idx, row) in hm.values.iter().enumerate() {
        for (c_idx, val_opt) in row.iter().enumerate() {
            let x = grid.x + c_idx as f64 * cell_w + gap * 0.5;
            let y = grid.y + r_idx as f64 * cell_h + gap * 0.5;
            let w = (cell_w - gap).max(1.0);
            let h = (cell_h - gap).max(1.0);

            match val_opt {
                Some(v) => {
                    let t = normalize_heatmap(*v, min_v, max_v, is_diverging, midpoint);
                    let rgb = interpolate_ramp(&ramp, t);
                    let hex = rgb.to_hex();
                    svg.rect(x, y, w, h, Some(radius), Paint::fill(&hex));

                    if show_values {
                        let txt = format_value(*v, hm.value_format, spec.y_axis.currency_symbol.as_deref(), spec.y_axis.decimals);
                        let tw = ctx.measurer.measure(&txt, DATA_LABEL_FONT, false).width;
                        if tw <= w - 4.0 && DATA_LABEL_FONT <= h - 2.0 {
                            let ink = rgb.contrast_ink("#1c1917", "#fcfcfb");
                            cell_labels.push((x + w * 0.5, y + h * 0.5, txt, ink));
                        }
                    }
                }
                None => {
                    svg.rect(x, y, w, h, Some(radius), Paint::fill(&ctx.tokens.surface).with_stroke(&ctx.tokens.border, 0.6));
                }
            }
        }
    }
    svg.close_group();

    if !cell_labels.is_empty() {
        svg.open_group("data-labels");
        for (lx, ly, txt, ink) in cell_labels {
            svg.text(
                lx,
                ly,
                &txt,
                TextStyle::new(&ink, DATA_LABEL_FONT)
                    .anchor(TextAnchor::Middle)
                    .baseline(DominantBaseline::Central),
            );
        }
        svg.close_group();
    }

    svg.open_group("y-axis");
    for (r_idx, lbl) in hm.y_labels.iter().enumerate() {
        let cy = grid.y + (r_idx as f64 + 0.5) * cell_h;
        let text = truncate_text(lbl, max_row_cap, TICK_FONT, false, ctx.measurer);
        svg.text(
            grid.x - 7.0,
            cy,
            &text,
            TextStyle::new(&ctx.tokens.text_faint, TICK_FONT)
                .anchor(TextAnchor::End)
                .baseline(DominantBaseline::Central),
        );
    }
    if let Some(title) = spec.y_axis.label.as_deref()
        && !title.is_empty()
    {
        svg.text(
            chrome.content.x + AXIS_TITLE_FONT * 0.65,
            grid.center_y(),
            title,
            TextStyle::new(&ctx.tokens.text_muted, AXIS_TITLE_FONT)
                .anchor(TextAnchor::Middle)
                .baseline(DominantBaseline::Central)
                .rotate(Some(-90.0)),
        );
    }
    svg.close_group();

    svg.open_group("x-axis");
    for (c_idx, lbl) in hm.x_labels.iter().enumerate() {
        if !c_idx.is_multiple_of(x_plan.stride) && c_idx != cols - 1 {
            continue;
        }
        let cx = grid.x + (c_idx as f64 + 0.5) * cell_w;
        let text = truncate_text(lbl, x_plan.max_label_px, TICK_FONT, false, ctx.measurer);
        match x_plan.rotation_deg {
            Some(deg) => {
                svg.text(
                    cx + 2.0,
                    grid.bottom() + 8.0,
                    &text,
                    TextStyle::new(&ctx.tokens.text_faint, TICK_FONT)
                        .anchor(TextAnchor::End)
                        .baseline(DominantBaseline::Hanging)
                        .rotate(Some(deg)),
                );
            }
            None => {
                svg.text(
                    cx,
                    grid.bottom() + 6.0,
                    &text,
                    TextStyle::new(&ctx.tokens.text_faint, TICK_FONT)
                        .anchor(TextAnchor::Middle)
                        .baseline(DominantBaseline::Hanging),
                );
            }
        }
    }
    if let Some(title) = spec.x_axis.label.as_deref()
        && !title.is_empty()
    {
        svg.text(
            grid.center_x(),
            grid.bottom() + x_plan.label_height + 16.0,
            title,
            TextStyle::new(&ctx.tokens.text_muted, AXIS_TITLE_FONT).anchor(TextAnchor::Middle),
        );
    }
    svg.close_group();

    // Segmented color bar avoids <defs> ID collisions when multiple SVGs share a page.
    if show_color_bar {
        let cb_w = (grid.width * 0.55).clamp(120.0, 260.0);
        let cb_x = grid.center_x() - cb_w * 0.5;
        let cb_y = chrome.content.bottom() - 22.0;
        let cb_h = 9.0;
        let steps = 28usize;
        let step_w = cb_w / steps as f64;

        svg.open_group("color-bar");
        for i in 0..steps {
            let t = i as f64 / (steps - 1) as f64;
            let hex = interpolate_ramp(&ramp, t).to_hex();
            svg.rect(cb_x + i as f64 * step_w, cb_y, step_w + 0.4, cb_h, None, Paint::fill(&hex));
        }
        svg.rect(cb_x, cb_y, cb_w, cb_h, Some(2.0), Paint::stroke(&ctx.tokens.border, 0.8));

        let min_lbl = format_value(min_v, hm.value_format, spec.y_axis.currency_symbol.as_deref(), spec.y_axis.decimals);
        let max_lbl = format_value(max_v, hm.value_format, spec.y_axis.currency_symbol.as_deref(), spec.y_axis.decimals);
        svg.text(
            cb_x,
            cb_y + cb_h + 4.0,
            &min_lbl,
            TextStyle::new(&ctx.tokens.text_faint, DATA_LABEL_FONT).baseline(DominantBaseline::Hanging),
        );
        if is_diverging {
            let mid_lbl = format_value(midpoint, hm.value_format, spec.y_axis.currency_symbol.as_deref(), spec.y_axis.decimals);
            svg.text(
                cb_x + cb_w * 0.5,
                cb_y + cb_h + 4.0,
                &mid_lbl,
                TextStyle::new(&ctx.tokens.text_faint, DATA_LABEL_FONT)
                    .anchor(TextAnchor::Middle)
                    .baseline(DominantBaseline::Hanging),
            );
        }
        svg.text(
            cb_x + cb_w,
            cb_y + cb_h + 4.0,
            &max_lbl,
            TextStyle::new(&ctx.tokens.text_faint, DATA_LABEL_FONT)
                .anchor(TextAnchor::End)
                .baseline(DominantBaseline::Hanging),
        );
        svg.close_group();
    }
}

fn resolve_ramp(scale: &HeatmapScale, tokens: &PaintTokens) -> Vec<Rgb> {
    match scale {
        HeatmapScale::Sequential => tokens.palette.sequential_stops().to_vec(),
        HeatmapScale::Diverging => tokens.palette.diverging_stops().to_vec(),
        HeatmapScale::Custom { low, mid, high } => {
            let lo = parse_rgb(low).unwrap_or(Rgb::new(0xf6, 0xf5, 0xf3));
            let hi = parse_rgb(high).unwrap_or(Rgb::new(0x4d, 0x7a, 0x2a));
            match mid.as_deref().and_then(parse_rgb) {
                Some(m) => vec![lo, m, hi],
                None => vec![lo, hi],
            }
        }
    }
}

fn normalize_heatmap(v: f64, min_v: f64, max_v: f64, diverging: bool, midpoint: f64) -> f64 {
    if (max_v - min_v).abs() < 1e-12 {
        return 0.5;
    }
    if diverging {
        if v <= midpoint {
            let span = (midpoint - min_v).max(1e-12);
            ((v - min_v) / span).clamp(0.0, 1.0) * 0.5
        } else {
            let span = (max_v - midpoint).max(1e-12);
            0.5 + ((v - midpoint) / span).clamp(0.0, 1.0) * 0.5
        }
    } else {
        ((v - min_v) / (max_v - min_v)).clamp(0.0, 1.0)
    }
}
