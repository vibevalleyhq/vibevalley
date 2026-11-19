use crate::charts::{build_area_band_path, build_curve_path};
use crate::color::canonical_hex;
use crate::layout::{DrawCtx, Rect};
use crate::spec::{ChartSpec, SparklineSpec, SparklineVariant};
use crate::svg::{BarRoundEnd, Paint, SvgBuilder, TextStyle, rounded_bar_path};

pub(crate) fn render(spec: &ChartSpec, spark: &SparklineSpec, ctx: DrawCtx<'_>, svg: &mut SvgBuilder) {
    let pad_x = 4.0;
    let pad_y = 4.0;
    let title_h = if spec.title.as_deref().is_some_and(|t| !t.trim().is_empty()) {
        14.0
    } else {
        0.0
    };

    if let Some(title) = spec.title.as_deref()
        && !title.trim().is_empty()
    {
        svg.open_group("header");
        svg.text(pad_x, 11.0, title.trim(), TextStyle::new(&ctx.tokens.text_muted, 10.0).bold(true));
        svg.close_group();
    }

    let plot = Rect {
        x: pad_x,
        y: pad_y + title_h,
        width: (ctx.width - pad_x * 2.0).max(8.0),
        height: (ctx.height - pad_y * 2.0 - title_h).max(6.0),
    };

    let mut min_v = f64::INFINITY;
    let mut max_v = f64::NEG_INFINITY;
    for v in spark.data.iter().flatten() {
        min_v = min_v.min(*v);
        max_v = max_v.max(*v);
    }
    if let Some(b) = spark.baseline {
        min_v = min_v.min(b);
        max_v = max_v.max(b);
    }
    if spark.variant == SparklineVariant::Bar {
        min_v = min_v.min(0.0);
        max_v = max_v.max(0.0);
    }
    if (max_v - min_v).abs() < 1e-12 {
        min_v -= 1.0;
        max_v += 1.0;
    }

    let map_y = |v: f64| -> f64 {
        let t = (v - min_v) / (max_v - min_v);
        plot.bottom() - t * plot.height
    };

    if let Some(b) = spark.baseline {
        let by = map_y(b);
        svg.open_group("baseline");
        svg.line(
            plot.x,
            by,
            plot.right(),
            by,
            Paint::stroke(&ctx.tokens.axis, 0.9).stroke_opacity(0.75).dash(Some("2,2")),
        );
        svg.close_group();
    }

    let color = ctx.tokens.series_color(0, spark.color.as_deref(), spec.palette.as_deref());
    let neg_color = spark
        .negative_color
        .as_deref()
        .map(|c| canonical_hex(c).unwrap_or_else(|| c.trim().to_string()))
        .unwrap_or_else(|| ctx.tokens.negative.clone());

    let n = spark.data.len();

    svg.open_group("series");
    match spark.variant {
        SparklineVariant::Bar => {
            let slot = plot.width / n as f64;
            let gap = if slot >= 5.0 { 1.5 } else { 0.5 };
            let bar_w = (slot - gap).max(1.0);
            let zero_y = map_y(0.0_f64.clamp(min_v, max_v));

            for (i, val_opt) in spark.data.iter().enumerate() {
                let Some(&v) = val_opt.as_ref() else {
                    continue;
                };
                let x = plot.x + i as f64 * slot + gap * 0.5;
                let vy = map_y(v);
                let top = vy.min(zero_y);
                let h = (vy - zero_y).abs().max(0.8);
                let fill = if v >= 0.0 { &color } else { &neg_color };
                let end = if v >= 0.0 { BarRoundEnd::Top } else { BarRoundEnd::Bottom };
                let d = rounded_bar_path(x, top, bar_w, h, 1.5, end);
                svg.path(&d, Paint::fill(fill));
            }
        }
        SparklineVariant::Line | SparklineVariant::Area => {
            let mut runs: Vec<Vec<(f64, f64, f64)>> = Vec::new();
            let mut current: Vec<(f64, f64, f64)> = Vec::new();
            let mut min_pt: Option<(f64, f64, f64)> = None;
            let mut max_pt: Option<(f64, f64, f64)> = None;
            let mut last_pt: Option<(f64, f64)> = None;

            for (i, val_opt) in spark.data.iter().enumerate() {
                match *val_opt {
                    Some(v) => {
                        let px = if n <= 1 {
                            plot.center_x()
                        } else {
                            plot.x + plot.width * (i as f64 / (n - 1) as f64)
                        };
                        let py = map_y(v);
                        current.push((px, py, v));
                        last_pt = Some((px, py));
                        if min_pt.is_none_or(|(_, _, mv)| v < mv) {
                            min_pt = Some((px, py, v));
                        }
                        if max_pt.is_none_or(|(_, _, mv)| v > mv) {
                            max_pt = Some((px, py, v));
                        }
                    }
                    None => {
                        if !current.is_empty() {
                            runs.push(std::mem::take(&mut current));
                        }
                    }
                }
            }
            if !current.is_empty() {
                runs.push(current);
            }

            for seg in &runs {
                if seg.len() >= 2 {
                    let pts: Vec<(f64, f64)> = seg.iter().map(|&(x, y, _)| (x, y)).collect();
                    if spark.variant == SparklineVariant::Area {
                        let bot: Vec<(f64, f64)> = pts.iter().map(|&(x, _)| (x, plot.bottom())).collect();
                        let area_d = build_area_band_path(&pts, &bot, spark.interpolation);
                        svg.path(&area_d, Paint::fill(&color).fill_opacity(0.22));
                    }
                    let line_d = build_curve_path(&pts, spark.interpolation);
                    svg.path(&line_d, Paint::stroke(&color, 1.8).round_caps());
                } else if let Some(&(px, py, _)) = seg.first() {
                    svg.circle(px, py, 2.2, Paint::fill(&color));
                }
            }

            if spark.highlight_extrema {
                if let Some((x, y, _)) = min_pt {
                    svg.circle(x, y, 2.5, Paint::fill(&neg_color));
                }
                if let Some((x, y, _)) = max_pt {
                    svg.circle(x, y, 2.5, Paint::fill(&color));
                }
            }
            if spark.highlight_last.unwrap_or(true)
                && let Some((lx, ly)) = last_pt
            {
                svg.circle(lx, ly, 2.6, Paint::fill(&color).with_stroke(&ctx.tokens.background, 1.0));
            }
        }
    }
    svg.close_group();
}
