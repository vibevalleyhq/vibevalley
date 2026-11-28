use crate::engine::chart::color::validate_color;
use crate::engine::chart::error::ChartError;
use crate::engine::chart::spec::{
    AreaMode, AreaSpec, AxisScale, AxisSpec, BarMode, BarOrientation, BarSpec, ChartSpec, ComboSpec, LineSpec, ScatterSpec, SparklineSpec, ValueAxisSide,
};

use super::common::{check_finite, check_opacity};
use super::{MAX_CATEGORIES, MAX_POINTS_PER_SERIES, MAX_SERIES, MAX_TOTAL_POINTS};

pub(super) fn validate_bar(spec: &ChartSpec, bar: &BarSpec) -> Result<(), ChartError> {
    if bar.categories.is_empty() {
        return Err(ChartError::EmptyData {
            field: "categories",
            message: "bar chart requires at least one category".to_string(),
        });
    }
    if bar.categories.len() > MAX_CATEGORIES {
        return Err(ChartError::LimitExceeded {
            field: "categories",
            max: MAX_CATEGORIES,
            actual: bar.categories.len(),
        });
    }
    if bar.series.is_empty() {
        return Err(ChartError::EmptyData {
            field: "series",
            message: "bar chart requires at least one series".to_string(),
        });
    }
    if bar.series.len() > MAX_SERIES {
        return Err(ChartError::LimitExceeded {
            field: "series",
            max: MAX_SERIES,
            actual: bar.series.len(),
        });
    }
    let total_points = bar.categories.len().saturating_mul(bar.series.len());
    if total_points > MAX_TOTAL_POINTS {
        return Err(ChartError::LimitExceeded {
            field: "points",
            max: MAX_TOTAL_POINTS,
            actual: total_points,
        });
    }

    if let Some(r) = bar.corner_radius {
        check_finite("cornerRadius", r)?;
        if !(0.0..=64.0).contains(&r) {
            return Err(ChartError::OutOfRange {
                field: "cornerRadius".to_string(),
                message: format!("must be between 0 and 64 (got {r})"),
            });
        }
    }

    let value_axis = match bar.orientation {
        BarOrientation::Vertical => &spec.y_axis,
        BarOrientation::Horizontal => &spec.x_axis,
    };
    let is_log = value_axis.scale == AxisScale::Log;
    if is_log && bar.mode == BarMode::PercentStacked {
        return Err(ChartError::InvalidAxis {
            axis: match bar.orientation {
                BarOrientation::Vertical => "yAxis",
                BarOrientation::Horizontal => "xAxis",
            },
            message: "log scale cannot be combined with percentStacked bars".to_string(),
        });
    }

    let mut has_any = false;
    for (s_idx, s) in bar.series.iter().enumerate() {
        if let Some(c) = &s.color {
            validate_color(&format!("series[{s_idx}].color"), c)?;
        }
        if s.data.len() != bar.categories.len() {
            return Err(ChartError::LengthMismatch {
                field: format!("series[{s_idx}].data"),
                expected: bar.categories.len(),
                actual: s.data.len(),
            });
        }
        for (p_idx, val) in s.data.iter().enumerate() {
            if let Some(v) = val {
                has_any = true;
                let field = format!("series[{s_idx}].data[{p_idx}]");
                check_finite(&field, *v)?;
                if bar.mode == BarMode::PercentStacked && *v < 0.0 {
                    return Err(ChartError::OutOfRange {
                        field,
                        message: format!("percentStacked bar charts require non-negative values (got {v})"),
                    });
                }
                if is_log && *v <= 0.0 {
                    return Err(ChartError::OutOfRange {
                        field,
                        message: format!("log scale requires strictly positive values (got {v})"),
                    });
                }
            }
        }
    }

    if !has_any {
        return Err(ChartError::EmptyData {
            field: "series",
            message: "bar chart must contain at least one non-null numeric value".to_string(),
        });
    }

    Ok(())
}

fn validate_x_domain(categories: &[String], x_values: Option<&[f64]>, x_axis: &AxisSpec) -> Result<usize, ChartError> {
    match (categories.is_empty(), x_values) {
        (true, None) => Err(ChartError::EmptyData {
            field: "categories",
            message: "provide either non-empty `categories` or numeric `xValues`".to_string(),
        }),
        (false, Some(_)) => Err(ChartError::InvalidAxis {
            axis: "xAxis",
            message: "specify either `categories` or `xValues`, not both".to_string(),
        }),
        (false, None) => {
            if categories.len() > MAX_CATEGORIES {
                return Err(ChartError::LimitExceeded {
                    field: "categories",
                    max: MAX_CATEGORIES,
                    actual: categories.len(),
                });
            }
            Ok(categories.len())
        }
        (true, Some(xs)) => {
            if xs.is_empty() {
                return Err(ChartError::EmptyData {
                    field: "xValues",
                    message: "`xValues` must contain at least one value".to_string(),
                });
            }
            if xs.len() > MAX_POINTS_PER_SERIES {
                return Err(ChartError::LimitExceeded {
                    field: "xValues",
                    max: MAX_POINTS_PER_SERIES,
                    actual: xs.len(),
                });
            }
            for (idx, x) in xs.iter().enumerate() {
                let field = format!("xValues[{idx}]");
                check_finite(&field, *x)?;
                if x_axis.scale == AxisScale::Log && *x <= 0.0 {
                    return Err(ChartError::OutOfRange {
                        field,
                        message: format!("log xAxis requires strictly positive values (got {x})"),
                    });
                }
                if idx > 0 && *x < xs[idx - 1] {
                    return Err(ChartError::OutOfRange {
                        field,
                        message: "xValues must be sorted in non-decreasing order".to_string(),
                    });
                }
            }
            Ok(xs.len())
        }
    }
}

pub(super) fn validate_line(spec: &ChartSpec, line: &LineSpec) -> Result<(), ChartError> {
    let x_len = validate_x_domain(&line.categories, line.x_values.as_deref(), &spec.x_axis)?;
    if line.series.is_empty() {
        return Err(ChartError::EmptyData {
            field: "series",
            message: "line chart requires at least one series".to_string(),
        });
    }
    if line.series.len() > MAX_SERIES {
        return Err(ChartError::LimitExceeded {
            field: "series",
            max: MAX_SERIES,
            actual: line.series.len(),
        });
    }
    let total_points = x_len.saturating_mul(line.series.len());
    if total_points > MAX_TOTAL_POINTS {
        return Err(ChartError::LimitExceeded {
            field: "points",
            max: MAX_TOTAL_POINTS,
            actual: total_points,
        });
    }

    let is_log_y = spec.y_axis.scale == AxisScale::Log;
    let mut has_any = false;

    for (s_idx, s) in line.series.iter().enumerate() {
        if let Some(c) = &s.color {
            validate_color(&format!("series[{s_idx}].color"), c)?;
        }
        if let Some(w) = s.stroke_width {
            check_finite(&format!("series[{s_idx}].strokeWidth"), w)?;
            if !(0.5..=20.0).contains(&w) {
                return Err(ChartError::OutOfRange {
                    field: format!("series[{s_idx}].strokeWidth"),
                    message: format!("strokeWidth must be between 0.5 and 20 (got {w})"),
                });
            }
        }
        if s.data.len() != x_len {
            return Err(ChartError::LengthMismatch {
                field: format!("series[{s_idx}].data"),
                expected: x_len,
                actual: s.data.len(),
            });
        }
        for (p_idx, val) in s.data.iter().enumerate() {
            if let Some(v) = val {
                has_any = true;
                let field = format!("series[{s_idx}].data[{p_idx}]");
                check_finite(&field, *v)?;
                if is_log_y && *v <= 0.0 {
                    return Err(ChartError::OutOfRange {
                        field,
                        message: format!("log yAxis requires strictly positive values (got {v})"),
                    });
                }
            }
        }
    }

    if !has_any {
        return Err(ChartError::EmptyData {
            field: "series",
            message: "line chart must contain at least one non-null numeric value".to_string(),
        });
    }

    Ok(())
}

pub(super) fn validate_area(spec: &ChartSpec, area: &AreaSpec) -> Result<(), ChartError> {
    let x_len = validate_x_domain(&area.categories, area.x_values.as_deref(), &spec.x_axis)?;
    if area.series.is_empty() {
        return Err(ChartError::EmptyData {
            field: "series",
            message: "area chart requires at least one series".to_string(),
        });
    }
    if area.series.len() > MAX_SERIES {
        return Err(ChartError::LimitExceeded {
            field: "series",
            max: MAX_SERIES,
            actual: area.series.len(),
        });
    }
    let total_points = x_len.saturating_mul(area.series.len());
    if total_points > MAX_TOTAL_POINTS {
        return Err(ChartError::LimitExceeded {
            field: "points",
            max: MAX_TOTAL_POINTS,
            actual: total_points,
        });
    }
    if let Some(op) = area.fill_opacity {
        check_opacity("fillOpacity", op)?;
    }

    let is_log_y = spec.y_axis.scale == AxisScale::Log;
    if is_log_y && matches!(area.mode, AreaMode::Stacked | AreaMode::PercentStacked) {
        return Err(ChartError::InvalidAxis {
            axis: "yAxis",
            message: "log scale cannot be combined with stacked area charts".to_string(),
        });
    }

    let require_non_negative = matches!(area.mode, AreaMode::Stacked | AreaMode::PercentStacked);
    let mut has_any = false;

    for (s_idx, s) in area.series.iter().enumerate() {
        if let Some(c) = &s.color {
            validate_color(&format!("series[{s_idx}].color"), c)?;
        }
        if let Some(w) = s.stroke_width {
            check_finite(&format!("series[{s_idx}].strokeWidth"), w)?;
            if !(0.5..=20.0).contains(&w) {
                return Err(ChartError::OutOfRange {
                    field: format!("series[{s_idx}].strokeWidth"),
                    message: format!("strokeWidth must be between 0.5 and 20 (got {w})"),
                });
            }
        }
        if s.data.len() != x_len {
            return Err(ChartError::LengthMismatch {
                field: format!("series[{s_idx}].data"),
                expected: x_len,
                actual: s.data.len(),
            });
        }
        for (p_idx, val) in s.data.iter().enumerate() {
            if let Some(v) = val {
                has_any = true;
                let field = format!("series[{s_idx}].data[{p_idx}]");
                check_finite(&field, *v)?;
                if require_non_negative && *v < 0.0 {
                    return Err(ChartError::OutOfRange {
                        field,
                        message: format!("stacked area charts require non-negative values (got {v})"),
                    });
                }
                if is_log_y && *v <= 0.0 {
                    return Err(ChartError::OutOfRange {
                        field,
                        message: format!("log yAxis requires strictly positive values (got {v})"),
                    });
                }
            }
        }
    }

    if !has_any {
        return Err(ChartError::EmptyData {
            field: "series",
            message: "area chart must contain at least one non-null numeric value".to_string(),
        });
    }

    Ok(())
}

pub(super) fn validate_scatter(spec: &ChartSpec, scatter: &ScatterSpec, require_size: bool) -> Result<(), ChartError> {
    if scatter.series.is_empty() {
        return Err(ChartError::EmptyData {
            field: "series",
            message: "scatter/bubble chart requires at least one series".to_string(),
        });
    }
    if scatter.series.len() > MAX_SERIES {
        return Err(ChartError::LimitExceeded {
            field: "series",
            max: MAX_SERIES,
            actual: scatter.series.len(),
        });
    }

    if let Some(r) = scatter.point_radius {
        check_finite("pointRadius", r)?;
        if !(1.0..=64.0).contains(&r) {
            return Err(ChartError::OutOfRange {
                field: "pointRadius".to_string(),
                message: format!("must be between 1 and 64 (got {r})"),
            });
        }
    }
    if let Some(r) = scatter.min_radius {
        check_finite("minRadius", r)?;
        if !(1.0..=64.0).contains(&r) {
            return Err(ChartError::OutOfRange {
                field: "minRadius".to_string(),
                message: format!("must be between 1 and 64 (got {r})"),
            });
        }
    }
    if let Some(r) = scatter.max_radius {
        check_finite("maxRadius", r)?;
        if !(1.0..=120.0).contains(&r) {
            return Err(ChartError::OutOfRange {
                field: "maxRadius".to_string(),
                message: format!("must be between 1 and 120 (got {r})"),
            });
        }
    }
    if let (Some(min_r), Some(max_r)) = (scatter.min_radius, scatter.max_radius)
        && min_r > max_r
    {
        return Err(ChartError::OutOfRange {
            field: "minRadius".to_string(),
            message: format!("minRadius ({min_r}) cannot exceed maxRadius ({max_r})"),
        });
    }

    let mut total_points = 0usize;
    let is_log_x = spec.x_axis.scale == AxisScale::Log;
    let is_log_y = spec.y_axis.scale == AxisScale::Log;

    for (s_idx, s) in scatter.series.iter().enumerate() {
        if let Some(c) = &s.color {
            validate_color(&format!("series[{s_idx}].color"), c)?;
        }
        if s.points.len() > MAX_POINTS_PER_SERIES {
            return Err(ChartError::LimitExceeded {
                field: "points",
                max: MAX_POINTS_PER_SERIES,
                actual: s.points.len(),
            });
        }
        total_points = total_points.saturating_add(s.points.len());
        if total_points > MAX_TOTAL_POINTS {
            return Err(ChartError::LimitExceeded {
                field: "points",
                max: MAX_TOTAL_POINTS,
                actual: total_points,
            });
        }

        for (p_idx, pt) in s.points.iter().enumerate() {
            let x_field = format!("series[{s_idx}].points[{p_idx}].x");
            let y_field = format!("series[{s_idx}].points[{p_idx}].y");
            check_finite(&x_field, pt.x)?;
            check_finite(&y_field, pt.y)?;
            if is_log_x && pt.x <= 0.0 {
                return Err(ChartError::OutOfRange {
                    field: x_field,
                    message: format!("log xAxis requires strictly positive values (got {})", pt.x),
                });
            }
            if is_log_y && pt.y <= 0.0 {
                return Err(ChartError::OutOfRange {
                    field: y_field,
                    message: format!("log yAxis requires strictly positive values (got {})", pt.y),
                });
            }
            match pt.size {
                Some(sz) => {
                    let s_field = format!("series[{s_idx}].points[{p_idx}].size");
                    check_finite(&s_field, sz)?;
                    if sz <= 0.0 {
                        return Err(ChartError::OutOfRange {
                            field: s_field,
                            message: format!("point size must be strictly positive (got {sz})"),
                        });
                    }
                }
                None if require_size => {
                    return Err(ChartError::OutOfRange {
                        field: format!("series[{s_idx}].points[{p_idx}].size"),
                        message: "bubble chart points require a positive `size` value".to_string(),
                    });
                }
                None => {}
            }
        }
    }

    if total_points == 0 {
        return Err(ChartError::EmptyData {
            field: "series",
            message: "scatter/bubble chart must contain at least one point".to_string(),
        });
    }

    Ok(())
}

pub(super) fn validate_combo(spec: &ChartSpec, combo: &ComboSpec) -> Result<(), ChartError> {
    if combo.categories.is_empty() {
        return Err(ChartError::EmptyData {
            field: "categories",
            message: "combo chart requires at least one category".to_string(),
        });
    }
    if combo.categories.len() > MAX_CATEGORIES {
        return Err(ChartError::LimitExceeded {
            field: "categories",
            max: MAX_CATEGORIES,
            actual: combo.categories.len(),
        });
    }
    if combo.bars.is_empty() && combo.lines.is_empty() {
        return Err(ChartError::EmptyData {
            field: "series",
            message: "combo chart requires at least one bar or line series".to_string(),
        });
    }
    let series_count = combo.bars.len() + combo.lines.len();
    if series_count > MAX_SERIES {
        return Err(ChartError::LimitExceeded {
            field: "series",
            max: MAX_SERIES,
            actual: series_count,
        });
    }
    let total_points = combo.categories.len().saturating_mul(series_count);
    if total_points > MAX_TOTAL_POINTS {
        return Err(ChartError::LimitExceeded {
            field: "points",
            max: MAX_TOTAL_POINTS,
            actual: total_points,
        });
    }

    if let Some(r) = combo.bar_corner_radius {
        check_finite("barCornerRadius", r)?;
        if !(0.0..=64.0).contains(&r) {
            return Err(ChartError::OutOfRange {
                field: "barCornerRadius".to_string(),
                message: format!("must be between 0 and 64 (got {r})"),
            });
        }
    }

    if !combo.bars.is_empty() && combo.bar_mode == BarMode::PercentStacked && spec.y_axis.scale == AxisScale::Log {
        return Err(ChartError::InvalidAxis {
            axis: "yAxis",
            message: "log scale cannot be combined with percentStacked combo bars".to_string(),
        });
    }

    let mut has_any = false;
    for (idx, s) in combo.bars.iter().enumerate() {
        if let Some(c) = &s.color {
            validate_color(&format!("bars[{idx}].color"), c)?;
        }
        if s.data.len() != combo.categories.len() {
            return Err(ChartError::LengthMismatch {
                field: format!("bars[{idx}].data"),
                expected: combo.categories.len(),
                actual: s.data.len(),
            });
        }
        for (p_idx, val) in s.data.iter().enumerate() {
            if let Some(v) = val {
                has_any = true;
                let field = format!("bars[{idx}].data[{p_idx}]");
                check_finite(&field, *v)?;
                if combo.bar_mode == BarMode::PercentStacked && *v < 0.0 {
                    return Err(ChartError::OutOfRange {
                        field,
                        message: format!("percentStacked combo bars require non-negative values (got {v})"),
                    });
                }
                if spec.y_axis.scale == AxisScale::Log && *v <= 0.0 {
                    return Err(ChartError::OutOfRange {
                        field,
                        message: format!("log yAxis requires strictly positive values (got {v})"),
                    });
                }
            }
        }
    }

    for (idx, s) in combo.lines.iter().enumerate() {
        if let Some(c) = &s.color {
            validate_color(&format!("lines[{idx}].color"), c)?;
        }
        if let Some(w) = s.stroke_width {
            check_finite(&format!("lines[{idx}].strokeWidth"), w)?;
            if !(0.5..=20.0).contains(&w) {
                return Err(ChartError::OutOfRange {
                    field: format!("lines[{idx}].strokeWidth"),
                    message: format!("strokeWidth must be between 0.5 and 20 (got {w})"),
                });
            }
        }
        if s.data.len() != combo.categories.len() {
            return Err(ChartError::LengthMismatch {
                field: format!("lines[{idx}].data"),
                expected: combo.categories.len(),
                actual: s.data.len(),
            });
        }
        let axis_scale = match s.axis {
            ValueAxisSide::Left => spec.y_axis.scale,
            ValueAxisSide::Right => spec.y2_axis.scale,
        };
        for (p_idx, val) in s.data.iter().enumerate() {
            if let Some(v) = val {
                has_any = true;
                let field = format!("lines[{idx}].data[{p_idx}]");
                check_finite(&field, *v)?;
                if axis_scale == AxisScale::Log && *v <= 0.0 {
                    return Err(ChartError::OutOfRange {
                        field,
                        message: format!("log axis requires strictly positive values (got {v})"),
                    });
                }
            }
        }
    }

    if !has_any {
        return Err(ChartError::EmptyData {
            field: "series",
            message: "combo chart must contain at least one non-null value".to_string(),
        });
    }

    Ok(())
}

pub(super) fn validate_sparkline(spark: &SparklineSpec) -> Result<(), ChartError> {
    if spark.data.is_empty() {
        return Err(ChartError::EmptyData {
            field: "data",
            message: "sparkline requires at least one data point".to_string(),
        });
    }
    if spark.data.len() > MAX_POINTS_PER_SERIES {
        return Err(ChartError::LimitExceeded {
            field: "data",
            max: MAX_POINTS_PER_SERIES,
            actual: spark.data.len(),
        });
    }
    if let Some(c) = &spark.color {
        validate_color("color", c)?;
    }
    if let Some(c) = &spark.negative_color {
        validate_color("negativeColor", c)?;
    }
    if let Some(b) = spark.baseline {
        check_finite("baseline", b)?;
    }
    let mut has_any = false;
    for (idx, val) in spark.data.iter().enumerate() {
        if let Some(v) = val {
            has_any = true;
            check_finite(&format!("data[{idx}]"), *v)?;
        }
    }
    if !has_any {
        return Err(ChartError::EmptyData {
            field: "data",
            message: "sparkline must contain at least one non-null numeric value".to_string(),
        });
    }
    Ok(())
}
