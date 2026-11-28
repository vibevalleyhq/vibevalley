mod common;
mod distribution;
mod pie;
mod series;

use crate::engine::chart::color::validate_color;
use crate::engine::chart::error::ChartError;
use crate::engine::chart::spec::{ChartKind, ChartSpec};

use self::common::{check_dimension, validate_annotation, validate_axis};
use self::distribution::{validate_boxplot, validate_heatmap, validate_histogram};
use self::pie::validate_pie;
use self::series::{validate_area, validate_bar, validate_combo, validate_line, validate_scatter, validate_sparkline};

pub const MAX_INPUT_BYTES: usize = 1024 * 1024;
pub const MAX_SERIES: usize = 32;
pub const MAX_CATEGORIES: usize = 2_000;
pub const MAX_POINTS_PER_SERIES: usize = 5_000;
pub const MAX_TOTAL_POINTS: usize = 20_000;
pub const MAX_SLICES: usize = 64;
pub const MAX_HEATMAP_ROWS: usize = 100;
pub const MAX_HEATMAP_COLS: usize = 100;
pub const MAX_HEATMAP_CELLS: usize = 2_500;
pub const MAX_ANNOTATIONS: usize = 64;
pub const MAX_BINS: usize = 200;
pub const MAX_HISTOGRAM_VALUES: usize = 50_000;
pub const MAX_BOXPLOT_GROUPS: usize = 64;
pub const MAX_SAMPLES_PER_GROUP: usize = 10_000;
pub const MAX_DIMENSION: f64 = 4096.0;

pub fn validate_spec(spec: &ChartSpec) -> Result<(), ChartError> {
    let is_sparkline = matches!(spec.kind, ChartKind::Sparkline(_));
    let min_w = if is_sparkline { 24.0 } else { 120.0 };
    let min_h = if is_sparkline { 12.0 } else { 80.0 };

    if let Some(w) = spec.width {
        check_dimension("width", w, min_w, MAX_DIMENSION)?;
    }
    if let Some(h) = spec.height {
        check_dimension("height", h, min_h, MAX_DIMENSION)?;
    }

    if let Some(palette) = &spec.palette {
        if palette.is_empty() {
            return Err(ChartError::EmptyData {
                field: "palette",
                message: "palette cannot be empty when specified".to_string(),
            });
        }
        if palette.len() > MAX_SERIES {
            return Err(ChartError::LimitExceeded {
                field: "palette",
                max: MAX_SERIES,
                actual: palette.len(),
            });
        }
        for (idx, color) in palette.iter().enumerate() {
            validate_color(&format!("palette[{idx}]"), color)?;
        }
    }

    validate_axis("xAxis", &spec.x_axis)?;
    validate_axis("yAxis", &spec.y_axis)?;
    validate_axis("y2Axis", &spec.y2_axis)?;

    if spec.annotations.len() > MAX_ANNOTATIONS {
        return Err(ChartError::LimitExceeded {
            field: "annotations",
            max: MAX_ANNOTATIONS,
            actual: spec.annotations.len(),
        });
    }
    for (idx, ann) in spec.annotations.iter().enumerate() {
        validate_annotation(idx, ann)?;
    }

    match &spec.kind {
        ChartKind::Bar(bar) => validate_bar(spec, bar),
        ChartKind::Line(line) => validate_line(spec, line),
        ChartKind::Area(area) => validate_area(spec, area),
        ChartKind::Scatter(scatter) => validate_scatter(spec, scatter, false),
        ChartKind::Bubble(bubble) => validate_scatter(spec, bubble, true),
        ChartKind::Pie(pie) => validate_pie(pie, false),
        ChartKind::Donut(donut) => validate_pie(donut, true),
        ChartKind::Combo(combo) => validate_combo(spec, combo),
        ChartKind::Heatmap(heatmap) => validate_heatmap(heatmap),
        ChartKind::Boxplot(boxplot) => validate_boxplot(spec, boxplot),
        ChartKind::Histogram(histogram) => validate_histogram(spec, histogram),
        ChartKind::Sparkline(sparkline) => validate_sparkline(sparkline),
    }
}
