pub mod bar;
pub mod combo;
pub mod heatmap;
pub mod line;
pub mod pie;
pub mod scatter;
pub mod sparkline;
pub mod stats;

use std::fmt::Write as _;

use crate::layout::DrawCtx;
use crate::spec::{ChartKind, ChartSpec, Interpolation};
use crate::svg::{SvgBuilder, fmt_num};

/// Dispatches rendering exhaustively across all closed `ChartKind` variants.
pub(crate) fn render_kind(spec: &ChartSpec, ctx: DrawCtx<'_>, svg: &mut SvgBuilder) {
    match &spec.kind {
        ChartKind::Bar(s) => bar::render(spec, s, ctx, svg),
        ChartKind::Line(s) => line::render_line(spec, s, ctx, svg),
        ChartKind::Area(s) => line::render_area(spec, s, ctx, svg),
        ChartKind::Scatter(s) => scatter::render(spec, s, false, ctx, svg),
        ChartKind::Bubble(s) => scatter::render(spec, s, true, ctx, svg),
        ChartKind::Pie(s) => pie::render(spec, s, false, ctx, svg),
        ChartKind::Donut(s) => pie::render(spec, s, true, ctx, svg),
        ChartKind::Combo(s) => combo::render(spec, s, ctx, svg),
        ChartKind::Heatmap(s) => heatmap::render(spec, s, ctx, svg),
        ChartKind::Boxplot(s) => stats::render_boxplot(spec, s, ctx, svg),
        ChartKind::Histogram(s) => stats::render_histogram(spec, s, ctx, svg),
        ChartKind::Sparkline(s) => sparkline::render(spec, s, ctx, svg),
    }
}

/// Builds an open SVG path (`M...`) through `pts` using the requested interpolation.
/// For `Smooth`, applies Fritsch-Carlson monotone cubic Hermite interpolation so the curve
/// preserves monotonicity and never overshoots extrema.
pub(crate) fn build_curve_path(pts: &[(f64, f64)], interpolation: Interpolation) -> String {
    if pts.len() < 2 {
        return String::new();
    }
    let mut d = String::with_capacity(pts.len() * 24);
    let _ = write!(d, "M{} {}", fmt_num(pts[0].0), fmt_num(pts[0].1));
    append_curve_segments(&mut d, pts, interpolation);
    d
}

/// Appends path segments starting from `pts[0]` (already positioned) through `pts[1..]`.
pub(crate) fn append_curve_segments(d: &mut String, pts: &[(f64, f64)], interpolation: Interpolation) {
    if pts.len() < 2 {
        return;
    }
    match interpolation {
        Interpolation::Linear => {
            for &(x, y) in &pts[1..] {
                let _ = write!(d, "L{} {}", fmt_num(x), fmt_num(y));
            }
        }
        Interpolation::Step => {
            for w in pts.windows(2) {
                let (_, y0) = w[0];
                let (x1, y1) = w[1];
                let _ = write!(d, "L{} {}L{} {}", fmt_num(x1), fmt_num(y0), fmt_num(x1), fmt_num(y1));
            }
        }
        Interpolation::StepBefore => {
            for w in pts.windows(2) {
                let (x0, _) = w[0];
                let (x1, y1) = w[1];
                let _ = write!(d, "L{} {}L{} {}", fmt_num(x0), fmt_num(y1), fmt_num(x1), fmt_num(y1));
            }
        }
        Interpolation::StepMiddle => {
            for w in pts.windows(2) {
                let (x0, y0) = w[0];
                let (x1, y1) = w[1];
                let xm = (x0 + x1) * 0.5;
                let _ = write!(
                    d,
                    "L{} {}L{} {}L{} {}",
                    fmt_num(xm),
                    fmt_num(y0),
                    fmt_num(xm),
                    fmt_num(y1),
                    fmt_num(x1),
                    fmt_num(y1)
                );
            }
        }
        Interpolation::Smooth => {
            if pts.len() == 2 {
                let _ = write!(d, "L{} {}", fmt_num(pts[1].0), fmt_num(pts[1].1));
                return;
            }
            let n = pts.len();
            let mut dx = vec![0.0_f64; n - 1];
            let mut dy = vec![0.0_f64; n - 1];
            let mut slope = vec![0.0_f64; n - 1];

            for i in 0..(n - 1) {
                dx[i] = pts[i + 1].0 - pts[i].0;
                dy[i] = pts[i + 1].1 - pts[i].1;
                slope[i] = if dx[i].abs() < 1e-9 { 0.0 } else { dy[i] / dx[i] };
            }

            let mut m = vec![0.0_f64; n];
            m[0] = slope[0];
            m[n - 1] = slope[n - 2];
            for i in 1..(n - 1) {
                if slope[i - 1] * slope[i] <= 0.0 {
                    m[i] = 0.0;
                } else {
                    m[i] = (slope[i - 1] + slope[i]) * 0.5;
                }
            }

            // Fritsch-Carlson overshoot clamping.
            for i in 0..(n - 1) {
                if slope[i].abs() < 1e-12 {
                    m[i] = 0.0;
                    m[i + 1] = 0.0;
                } else {
                    let alpha = m[i] / slope[i];
                    let beta = m[i + 1] / slope[i];
                    let sq = alpha * alpha + beta * beta;
                    if sq > 9.0 {
                        let tau = 3.0 / sq.sqrt();
                        m[i] = tau * alpha * slope[i];
                        m[i + 1] = tau * beta * slope[i];
                    }
                }
            }

            for i in 0..(n - 1) {
                let h = dx[i];
                let (x0, y0) = pts[i];
                let (x1, y1) = pts[i + 1];
                let cp1x = x0 + h / 3.0;
                let cp1y = y0 + m[i] * h / 3.0;
                let cp2x = x1 - h / 3.0;
                let cp2y = y1 - m[i + 1] * h / 3.0;
                let _ = write!(
                    d,
                    "C{} {} {} {} {} {}",
                    fmt_num(cp1x),
                    fmt_num(cp1y),
                    fmt_num(cp2x),
                    fmt_num(cp2y),
                    fmt_num(x1),
                    fmt_num(y1)
                );
            }
        }
    }
}

/// Builds a closed SVG area path between a top curve (`top`, left-to-right) and a bottom curve
/// (`bottom`, left-to-right), tracing `bottom` in reverse so stacked bands lock without gaps.
pub(crate) fn build_area_band_path(top: &[(f64, f64)], bottom: &[(f64, f64)], interpolation: Interpolation) -> String {
    if top.len() < 2 || top.len() != bottom.len() {
        return String::new();
    }
    let mut d = build_curve_path(top, interpolation);
    let last_bot = bottom[bottom.len() - 1];
    let _ = write!(d, "L{} {}", fmt_num(last_bot.0), fmt_num(last_bot.1));

    let rev_bottom: Vec<(f64, f64)> = bottom.iter().copied().rev().collect();
    let rev_interp = match interpolation {
        Interpolation::Linear => Interpolation::Linear,
        Interpolation::Smooth => Interpolation::Smooth,
        Interpolation::Step => Interpolation::StepBefore,
        Interpolation::StepBefore => Interpolation::Step,
        Interpolation::StepMiddle => Interpolation::StepMiddle,
    };
    append_curve_segments(&mut d, &rev_bottom, rev_interp);
    d.push('Z');
    d
}
