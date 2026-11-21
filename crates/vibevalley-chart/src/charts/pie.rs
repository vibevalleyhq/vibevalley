use std::f64::consts::{FRAC_PI_2, PI, TAU};

use crate::layout::{ChromeLayout, DATA_LABEL_FONT, DrawCtx, LegendItem, LegendSwatch, Rect, ResolvedLegend};
use crate::measure::truncate_text;
use crate::scale::format_value;
use crate::spec::{ChartSpec, NumberFormat, PieLabelFormat, PieSpec};
use crate::svg::{DominantBaseline, Paint, SvgBuilder, TextAnchor, TextStyle, fmt_num};

struct PieGeometry {
    cx: f64,
    cy: f64,
    outer_r: f64,
    inner_r: f64,
    bounds: Rect,
}

pub(crate) fn render(spec: &ChartSpec, pie: &PieSpec, is_donut: bool, ctx: DrawCtx<'_>, svg: &mut SvgBuilder) {
    let colors: Vec<String> = pie
        .slices
        .iter()
        .enumerate()
        .map(|(i, s)| ctx.tokens.series_color(i, s.color.as_deref(), spec.palette.as_deref()))
        .collect();

    let legend_items: Vec<LegendItem> = pie
        .slices
        .iter()
        .enumerate()
        .map(|(i, s)| LegendItem {
            label: s.label.clone(),
            color: colors[i].clone(),
            swatch: LegendSwatch::Circle,
            dashed: false,
        })
        .collect();

    let chrome = ChromeLayout::compute(spec, ctx, &legend_items, ResolvedLegend::Right);
    chrome.draw_background(svg, ctx.tokens);
    chrome.draw_header(svg, ctx.tokens);

    let show_labels = pie.show_labels.unwrap_or(true);
    let label_format = match pie.label_format {
        PieLabelFormat::Auto => match chrome.legend_pos {
            ResolvedLegend::None => PieLabelFormat::LabelAndPercent,
            ResolvedLegend::Top | ResolvedLegend::Bottom | ResolvedLegend::Right => PieLabelFormat::Percent,
        },
        other => other,
    };

    let side_room = if show_labels {
        match label_format {
            PieLabelFormat::LabelAndPercent | PieLabelFormat::LabelAndValue => (chrome.content.width * 0.24).clamp(64.0, 125.0),
            PieLabelFormat::Auto | PieLabelFormat::Percent | PieLabelFormat::Value => (chrome.content.width * 0.14).clamp(36.0, 68.0),
        }
    } else {
        8.0
    };
    let vert_room = if show_labels { 22.0 } else { 8.0 };

    let avail_w = (chrome.content.width - side_room * 2.0).max(40.0);
    let avail_h = (chrome.content.height - vert_room * 2.0).max(40.0);
    let outer_r = (avail_w.min(avail_h) * 0.5).max(18.0);
    let inner_ratio = pie.inner_radius_ratio.unwrap_or(if is_donut { 0.56 } else { 0.0 });
    let inner_r = outer_r * inner_ratio;

    let geom = PieGeometry {
        cx: chrome.content.center_x(),
        cy: chrome.content.center_y(),
        outer_r,
        inner_r,
        bounds: chrome.content,
    };

    let total: f64 = pie.slices.iter().map(|s| s.value).sum();
    let non_zero_count = pie.slices.iter().filter(|s| s.value > 0.0).count();

    let mut slice_geoms: Vec<SliceGeom> = Vec::with_capacity(pie.slices.len());
    let mut angle = -FRAC_PI_2;
    for (idx, slice) in pie.slices.iter().enumerate() {
        let frac = if total > 0.0 { slice.value / total } else { 0.0 };
        let sweep = frac * TAU;
        let start = angle;
        let end = angle + sweep;
        angle = end;
        if slice.value <= 0.0 {
            continue;
        }
        slice_geoms.push(SliceGeom {
            idx,
            label: slice.label.clone(),
            value: slice.value,
            frac,
            start,
            end,
            mid: (start + end) * 0.5,
            sweep,
            color: colors[idx].clone(),
        });
    }

    svg.open_group("series");
    let stroke_w = if non_zero_count > 1 { 1.5 } else { 0.0 };
    for sg in &slice_geoms {
        svg.open_group_with_name("pie-slice", &sg.label);
        if sg.sweep >= TAU - 1e-5 {
            svg.circle(geom.cx, geom.cy, geom.outer_r, Paint::fill(&sg.color));
            if geom.inner_r > 0.1 {
                svg.circle(geom.cx, geom.cy, geom.inner_r, Paint::fill(&ctx.tokens.background));
            }
        } else {
            let d = annular_sector_path(geom.cx, geom.cy, geom.outer_r, geom.inner_r, sg.start, sg.end);
            let paint = if stroke_w > 0.0 {
                Paint::fill(&sg.color).with_stroke(&ctx.tokens.background, stroke_w)
            } else {
                Paint::fill(&sg.color)
            };
            svg.path(&d, paint);
        }
        svg.close_group();
    }
    svg.close_group();

    if geom.inner_r >= 22.0 && (pie.center_label.is_some() || pie.center_sublabel.is_some()) {
        svg.open_group("donut-center");
        let max_center_w = geom.inner_r * 1.72;
        match (&pie.center_label, &pie.center_sublabel) {
            (Some(main), Some(sub)) => {
                let main_t = truncate_text(main, max_center_w, 16.0, true, ctx.measurer);
                let sub_t = truncate_text(sub, max_center_w, 10.5, false, ctx.measurer);
                svg.text(
                    geom.cx,
                    geom.cy - 7.0,
                    &main_t,
                    TextStyle::new(&ctx.tokens.text, 16.0)
                        .bold(true)
                        .anchor(TextAnchor::Middle)
                        .baseline(DominantBaseline::Central),
                );
                svg.text(
                    geom.cx,
                    geom.cy + 11.0,
                    &sub_t,
                    TextStyle::new(&ctx.tokens.text_muted, 10.5)
                        .anchor(TextAnchor::Middle)
                        .baseline(DominantBaseline::Central),
                );
            }
            (Some(main), None) => {
                let main_t = truncate_text(main, max_center_w, 16.0, true, ctx.measurer);
                svg.text(
                    geom.cx,
                    geom.cy,
                    &main_t,
                    TextStyle::new(&ctx.tokens.text, 16.0)
                        .bold(true)
                        .anchor(TextAnchor::Middle)
                        .baseline(DominantBaseline::Central),
                );
            }
            (None, Some(sub)) => {
                let sub_t = truncate_text(sub, max_center_w, 11.0, false, ctx.measurer);
                svg.text(
                    geom.cx,
                    geom.cy,
                    &sub_t,
                    TextStyle::new(&ctx.tokens.text_muted, 11.0)
                        .anchor(TextAnchor::Middle)
                        .baseline(DominantBaseline::Central),
                );
            }
            (None, None) => {}
        }
        svg.close_group();
    }

    if show_labels {
        draw_pie_labels(svg, &slice_geoms, pie, spec, label_format, &geom, ctx);
    }

    chrome.draw_legend(svg, ctx.tokens);
}

struct SliceGeom {
    idx: usize,
    label: String,
    value: f64,
    frac: f64,
    start: f64,
    end: f64,
    mid: f64,
    sweep: f64,
    color: String,
}

struct CalloutItem {
    mid: f64,
    anchor_x: f64,
    anchor_y: f64,
    elbow_x: f64,
    target_y: f64,
    text: String,
    color: String,
}

fn draw_pie_labels(svg: &mut SvgBuilder, slices: &[SliceGeom], pie: &PieSpec, spec: &ChartSpec, format: PieLabelFormat, geom: &PieGeometry, ctx: DrawCtx<'_>) {
    let mut left_callouts: Vec<CalloutItem> = Vec::new();
    let mut right_callouts: Vec<CalloutItem> = Vec::new();
    let ring_thickness = geom.outer_r - geom.inner_r;
    let mid_r = if geom.inner_r > 0.0 {
        (geom.outer_r + geom.inner_r) * 0.5
    } else {
        geom.outer_r * 0.62
    };

    svg.open_group("data-labels");

    for sg in slices {
        let text = format_slice_label(sg, format, spec);
        let metrics = ctx.measurer.measure(&text, DATA_LABEL_FONT, true);

        let chord_w = 2.0 * mid_r * (sg.sweep * 0.5).min(FRAC_PI_2).sin();
        let fits_inside = matches!(format, PieLabelFormat::Percent | PieLabelFormat::Value)
            && sg.sweep >= 0.38
            && ring_thickness >= 24.0
            && metrics.width + 8.0 <= chord_w
            && metrics.width + 6.0 <= ring_thickness * 1.35;

        if fits_inside {
            let (lx, ly) = if sg.sweep >= TAU - 1e-5 && geom.inner_r <= 0.1 {
                (geom.cx, geom.cy)
            } else {
                (geom.cx + mid_r * sg.mid.cos(), geom.cy + mid_r * sg.mid.sin())
            };
            let rgb = ctx
                .tokens
                .concrete_series_rgb(sg.idx, pie.slices[sg.idx].color.as_deref(), spec.palette.as_deref());
            let ink = rgb.contrast_ink("#1c1917", "#fcfcfb");
            svg.text(
                lx,
                ly,
                &text,
                TextStyle::new(&ink, DATA_LABEL_FONT)
                    .bold(true)
                    .anchor(TextAnchor::Middle)
                    .baseline(DominantBaseline::Central),
            );
        } else {
            let cos_a = sg.mid.cos();
            let sin_a = sg.mid.sin();
            let elbow_r = geom.outer_r + 12.0;
            let item = CalloutItem {
                mid: sg.mid,
                anchor_x: geom.cx + geom.outer_r * cos_a,
                anchor_y: geom.cy + geom.outer_r * sin_a,
                elbow_x: geom.cx + elbow_r * cos_a,
                target_y: geom.cy + elbow_r * sin_a,
                text,
                color: sg.color.clone(),
            };
            if cos_a >= 0.0 {
                right_callouts.push(item);
            } else {
                left_callouts.push(item);
            }
        }
    }

    let min_gap = DATA_LABEL_FONT * 1.45;
    let min_y = geom.bounds.y + 8.0;
    let max_y = (geom.bounds.bottom() - 8.0).max(min_y + min_gap);

    spread_callouts(&mut right_callouts, min_y, max_y, min_gap);
    spread_callouts(&mut left_callouts, min_y, max_y, min_gap);

    let right_x = (geom.cx + geom.outer_r + 22.0).min(geom.bounds.right() - 24.0);
    let left_x = (geom.cx - geom.outer_r - 22.0).max(geom.bounds.x + 24.0);

    for item in &right_callouts {
        let max_w = (geom.bounds.right() - right_x - 4.0).max(24.0);
        let label = truncate_text(&item.text, max_w, DATA_LABEL_FONT, false, ctx.measurer);
        let elbow_x = item.elbow_x.min(right_x - 4.0);
        let d = format!(
            "M{} {}L{} {}L{} {}",
            fmt_num(item.anchor_x),
            fmt_num(item.anchor_y),
            fmt_num(elbow_x),
            fmt_num(item.target_y),
            fmt_num(right_x - 3.0),
            fmt_num(item.target_y),
        );
        svg.path(&d, Paint::stroke(&item.color, 1.0).stroke_opacity(0.75).round_caps());
        svg.text(
            right_x,
            item.target_y,
            &label,
            TextStyle::new(&ctx.tokens.text_muted, DATA_LABEL_FONT).baseline(DominantBaseline::Central),
        );
    }

    for item in &left_callouts {
        let max_w = (left_x - geom.bounds.x - 4.0).max(24.0);
        let label = truncate_text(&item.text, max_w, DATA_LABEL_FONT, false, ctx.measurer);
        let elbow_x = item.elbow_x.max(left_x + 4.0);
        let d = format!(
            "M{} {}L{} {}L{} {}",
            fmt_num(item.anchor_x),
            fmt_num(item.anchor_y),
            fmt_num(elbow_x),
            fmt_num(item.target_y),
            fmt_num(left_x + 3.0),
            fmt_num(item.target_y),
        );
        svg.path(&d, Paint::stroke(&item.color, 1.0).stroke_opacity(0.75).round_caps());
        svg.text(
            left_x,
            item.target_y,
            &label,
            TextStyle::new(&ctx.tokens.text_muted, DATA_LABEL_FONT)
                .anchor(TextAnchor::End)
                .baseline(DominantBaseline::Central),
        );
    }

    svg.close_group();
}

/// Two-pass vertical relaxation so thin-slice callout labels never collide.
fn spread_callouts(items: &mut [CalloutItem], min_y: f64, max_y: f64, min_gap: f64) {
    if items.is_empty() {
        return;
    }
    items.sort_by(|a, b| a.target_y.total_cmp(&b.target_y).then(a.mid.total_cmp(&b.mid)));

    items[0].target_y = items[0].target_y.clamp(min_y, max_y);
    for i in 1..items.len() {
        let needed = items[i - 1].target_y + min_gap;
        if items[i].target_y < needed {
            items[i].target_y = needed;
        }
    }

    let last = items.len() - 1;
    if items[last].target_y > max_y {
        items[last].target_y = max_y;
        for i in (0..last).rev() {
            let ceiling = items[i + 1].target_y - min_gap;
            if items[i].target_y > ceiling {
                items[i].target_y = ceiling;
            }
        }
    }

    for item in items.iter_mut() {
        item.target_y = item.target_y.clamp(min_y, max_y);
    }
}

fn format_slice_label(sg: &SliceGeom, format: PieLabelFormat, spec: &ChartSpec) -> String {
    let pct = format_value(sg.frac, NumberFormat::Percent, None, None);
    let val = format_value(sg.value, spec.y_axis.format, spec.y_axis.currency_symbol.as_deref(), spec.y_axis.decimals);
    match format {
        PieLabelFormat::Auto | PieLabelFormat::Percent => pct,
        PieLabelFormat::Value => val,
        PieLabelFormat::LabelAndPercent => format!("{} ({pct})", sg.label),
        PieLabelFormat::LabelAndValue => format!("{} ({val})", sg.label),
    }
}

fn annular_sector_path(cx: f64, cy: f64, outer_r: f64, inner_r: f64, start: f64, end: f64) -> String {
    let large_arc = if (end - start).abs() > PI { 1 } else { 0 };
    let ox0 = cx + outer_r * start.cos();
    let oy0 = cy + outer_r * start.sin();
    let ox1 = cx + outer_r * end.cos();
    let oy1 = cy + outer_r * end.sin();

    if inner_r <= 0.1 {
        format!(
            "M{} {}L{} {}A{} {} 0 {large_arc} 1 {} {}Z",
            fmt_num(cx),
            fmt_num(cy),
            fmt_num(ox0),
            fmt_num(oy0),
            fmt_num(outer_r),
            fmt_num(outer_r),
            fmt_num(ox1),
            fmt_num(oy1),
        )
    } else {
        let ix0 = cx + inner_r * start.cos();
        let iy0 = cy + inner_r * start.sin();
        let ix1 = cx + inner_r * end.cos();
        let iy1 = cy + inner_r * end.sin();
        format!(
            "M{} {}A{} {} 0 {large_arc} 1 {} {}L{} {}A{} {} 0 {large_arc} 0 {} {}Z",
            fmt_num(ox0),
            fmt_num(oy0),
            fmt_num(outer_r),
            fmt_num(outer_r),
            fmt_num(ox1),
            fmt_num(oy1),
            fmt_num(ix1),
            fmt_num(iy1),
            fmt_num(inner_r),
            fmt_num(inner_r),
            fmt_num(ix0),
            fmt_num(iy0),
        )
    }
}
