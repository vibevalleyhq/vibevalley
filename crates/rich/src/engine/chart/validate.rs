use crate::engine::chart::color::validate_color;
use crate::engine::chart::error::ChartError;
use crate::engine::chart::spec::{
    Annotation, AreaMode, AreaSpec, AxisScale, AxisSpec, BarMode, BarOrientation, BarSpec, BoxplotSpec, ChartKind, ChartSpec, ComboSpec, HeatmapScale,
    HeatmapSpec, HistogramSpec, LineSpec, PieSpec, ScatterSpec, SparklineSpec, ValueAxisSide, XRef,
};

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

fn check_dimension(field: &'static str, val: f64, min: f64, max: f64) -> Result<(), ChartError> {
    if !val.is_finite() {
        return Err(ChartError::NonFiniteValue { field: field.to_string() });
    }
    if val < min || val > max {
        return Err(ChartError::InvalidDimension {
            field,
            message: format!("must be between {min} and {max} pixels (got {val})"),
        });
    }
    Ok(())
}

fn check_finite(field: &str, val: f64) -> Result<(), ChartError> {
    if !val.is_finite() {
        return Err(ChartError::NonFiniteValue { field: field.to_string() });
    }
    Ok(())
}

fn validate_axis(name: &'static str, axis: &AxisSpec) -> Result<(), ChartError> {
    if let Some(min) = axis.min {
        check_finite(&format!("{name}.min"), min)?;
        if axis.scale == AxisScale::Log && min <= 0.0 {
            return Err(ChartError::InvalidAxis {
                axis: name,
                message: format!("log scale requires min > 0 (got {min})"),
            });
        }
    }
    if let Some(max) = axis.max {
        check_finite(&format!("{name}.max"), max)?;
        if axis.scale == AxisScale::Log && max <= 0.0 {
            return Err(ChartError::InvalidAxis {
                axis: name,
                message: format!("log scale requires max > 0 (got {max})"),
            });
        }
    }
    if let (Some(min), Some(max)) = (axis.min, axis.max)
        && min >= max
    {
        return Err(ChartError::InvalidAxis {
            axis: name,
            message: format!("min ({min}) must be strictly less than max ({max})"),
        });
    }
    if let Some(ticks) = axis.tick_count
        && !(2..=50).contains(&ticks)
    {
        return Err(ChartError::InvalidAxis {
            axis: name,
            message: format!("tickCount must be between 2 and 50 (got {ticks})"),
        });
    }
    if let Some(decimals) = axis.decimals
        && decimals > 8
    {
        return Err(ChartError::InvalidAxis {
            axis: name,
            message: format!("decimals must be between 0 and 8 (got {decimals})"),
        });
    }
    Ok(())
}

fn validate_annotation(idx: usize, ann: &Annotation) -> Result<(), ChartError> {
    match ann {
        Annotation::HorizontalLine { value, color, .. } => {
            check_finite(&format!("annotations[{idx}].value"), *value)?;
            if let Some(c) = color {
                validate_color(&format!("annotations[{idx}].color"), c)?;
            }
        }
        Annotation::VerticalLine { value, color, .. } => {
            validate_xref(&format!("annotations[{idx}].value"), value)?;
            if let Some(c) = color {
                validate_color(&format!("annotations[{idx}].color"), c)?;
            }
        }
        Annotation::HorizontalBand { from, to, color, opacity, .. } => {
            check_finite(&format!("annotations[{idx}].from"), *from)?;
            check_finite(&format!("annotations[{idx}].to"), *to)?;
            if let Some(c) = color {
                validate_color(&format!("annotations[{idx}].color"), c)?;
            }
            if let Some(op) = opacity {
                check_opacity(&format!("annotations[{idx}].opacity"), *op)?;
            }
        }
        Annotation::VerticalBand { from, to, color, opacity, .. } => {
            validate_xref(&format!("annotations[{idx}].from"), from)?;
            validate_xref(&format!("annotations[{idx}].to"), to)?;
            if let Some(c) = color {
                validate_color(&format!("annotations[{idx}].color"), c)?;
            }
            if let Some(op) = opacity {
                check_opacity(&format!("annotations[{idx}].opacity"), *op)?;
            }
        }
    }
    Ok(())
}

fn validate_xref(field: &str, xref: &XRef) -> Result<(), ChartError> {
    match xref {
        XRef::Number(v) => check_finite(field, *v),
        XRef::Category(_) => Ok(()),
    }
}

fn check_opacity(field: &str, op: f64) -> Result<(), ChartError> {
    check_finite(field, op)?;
    if !(0.0..=1.0).contains(&op) {
        return Err(ChartError::OutOfRange {
            field: field.to_string(),
            message: format!("opacity must be between 0.0 and 1.0 (got {op})"),
        });
    }
    Ok(())
}

fn validate_bar(spec: &ChartSpec, bar: &BarSpec) -> Result<(), ChartError> {
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

fn validate_line(spec: &ChartSpec, line: &LineSpec) -> Result<(), ChartError> {
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

fn validate_area(spec: &ChartSpec, area: &AreaSpec) -> Result<(), ChartError> {
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

fn validate_scatter(spec: &ChartSpec, scatter: &ScatterSpec, require_size: bool) -> Result<(), ChartError> {
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

fn validate_pie(pie: &PieSpec, is_donut: bool) -> Result<(), ChartError> {
    if pie.slices.is_empty() {
        return Err(ChartError::EmptyData {
            field: "slices",
            message: "pie/donut chart requires at least one slice".to_string(),
        });
    }
    if pie.slices.len() > MAX_SLICES {
        return Err(ChartError::LimitExceeded {
            field: "slices",
            max: MAX_SLICES,
            actual: pie.slices.len(),
        });
    }
    if let Some(ratio) = pie.inner_radius_ratio {
        check_finite("innerRadiusRatio", ratio)?;
        let min_ratio = if is_donut { 0.05 } else { 0.0 };
        if ratio < min_ratio || ratio >= 0.92 {
            return Err(ChartError::OutOfRange {
                field: "innerRadiusRatio".to_string(),
                message: format!("must be in [{min_ratio}, 0.92) (got {ratio})"),
            });
        }
    }

    let mut total = 0.0_f64;
    for (idx, slice) in pie.slices.iter().enumerate() {
        let field = format!("slices[{idx}].value");
        check_finite(&field, slice.value)?;
        if slice.value < 0.0 {
            return Err(ChartError::OutOfRange {
                field,
                message: format!("slice value must be non-negative (got {})", slice.value),
            });
        }
        if let Some(c) = &slice.color {
            validate_color(&format!("slices[{idx}].color"), c)?;
        }
        total += slice.value;
    }

    if total <= 0.0 || !total.is_finite() {
        return Err(ChartError::EmptyData {
            field: "slices",
            message: "sum of pie/donut slice values must be strictly positive".to_string(),
        });
    }

    Ok(())
}

fn validate_combo(spec: &ChartSpec, combo: &ComboSpec) -> Result<(), ChartError> {
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

fn validate_heatmap(hm: &HeatmapSpec) -> Result<(), ChartError> {
    if hm.x_labels.is_empty() {
        return Err(ChartError::EmptyData {
            field: "xLabels",
            message: "heatmap requires at least one column label".to_string(),
        });
    }
    if hm.y_labels.is_empty() {
        return Err(ChartError::EmptyData {
            field: "yLabels",
            message: "heatmap requires at least one row label".to_string(),
        });
    }
    if hm.x_labels.len() > MAX_HEATMAP_COLS {
        return Err(ChartError::LimitExceeded {
            field: "xLabels",
            max: MAX_HEATMAP_COLS,
            actual: hm.x_labels.len(),
        });
    }
    if hm.y_labels.len() > MAX_HEATMAP_ROWS {
        return Err(ChartError::LimitExceeded {
            field: "yLabels",
            max: MAX_HEATMAP_ROWS,
            actual: hm.y_labels.len(),
        });
    }
    let cells = hm.x_labels.len().saturating_mul(hm.y_labels.len());
    if cells > MAX_HEATMAP_CELLS {
        return Err(ChartError::LimitExceeded {
            field: "values",
            max: MAX_HEATMAP_CELLS,
            actual: cells,
        });
    }
    if hm.values.len() != hm.y_labels.len() {
        return Err(ChartError::LengthMismatch {
            field: "values".to_string(),
            expected: hm.y_labels.len(),
            actual: hm.values.len(),
        });
    }

    if let Some(min) = hm.min {
        check_finite("min", min)?;
    }
    if let Some(max) = hm.max {
        check_finite("max", max)?;
    }
    if let Some(mid) = hm.midpoint {
        check_finite("midpoint", mid)?;
    }
    if let (Some(min), Some(max)) = (hm.min, hm.max)
        && min >= max
    {
        return Err(ChartError::OutOfRange {
            field: "min".to_string(),
            message: format!("heatmap min ({min}) must be strictly less than max ({max})"),
        });
    }
    if let Some(r) = hm.cell_radius {
        check_finite("cellRadius", r)?;
        if !(0.0..=32.0).contains(&r) {
            return Err(ChartError::OutOfRange {
                field: "cellRadius".to_string(),
                message: format!("must be between 0 and 32 (got {r})"),
            });
        }
    }
    if let Some(gap) = hm.cell_gap {
        check_finite("cellGap", gap)?;
        if !(0.0..=24.0).contains(&gap) {
            return Err(ChartError::OutOfRange {
                field: "cellGap".to_string(),
                message: format!("must be between 0 and 24 (got {gap})"),
            });
        }
    }

    match &hm.color_scale {
        HeatmapScale::Sequential | HeatmapScale::Diverging => {}
        HeatmapScale::Custom { low, mid, high } => {
            validate_color("colorScale.low", low)?;
            if let Some(m) = mid {
                validate_color("colorScale.mid", m)?;
            }
            validate_color("colorScale.high", high)?;
        }
    }

    let mut has_any = false;
    for (r_idx, row) in hm.values.iter().enumerate() {
        if row.len() != hm.x_labels.len() {
            return Err(ChartError::LengthMismatch {
                field: format!("values[{r_idx}]"),
                expected: hm.x_labels.len(),
                actual: row.len(),
            });
        }
        for (c_idx, cell) in row.iter().enumerate() {
            if let Some(v) = cell {
                has_any = true;
                check_finite(&format!("values[{r_idx}][{c_idx}]"), *v)?;
            }
        }
    }

    if !has_any {
        return Err(ChartError::EmptyData {
            field: "values",
            message: "heatmap must contain at least one non-null cell value".to_string(),
        });
    }

    Ok(())
}

fn validate_boxplot(spec: &ChartSpec, bp: &BoxplotSpec) -> Result<(), ChartError> {
    if bp.groups.is_empty() {
        return Err(ChartError::EmptyData {
            field: "groups",
            message: "boxplot requires at least one group".to_string(),
        });
    }
    if bp.groups.len() > MAX_BOXPLOT_GROUPS {
        return Err(ChartError::LimitExceeded {
            field: "groups",
            max: MAX_BOXPLOT_GROUPS,
            actual: bp.groups.len(),
        });
    }

    let value_axis = match bp.orientation {
        BarOrientation::Vertical => &spec.y_axis,
        BarOrientation::Horizontal => &spec.x_axis,
    };
    let is_log = value_axis.scale == AxisScale::Log;

    for (idx, group) in bp.groups.iter().enumerate() {
        if let Some(c) = &group.color {
            validate_color(&format!("groups[{idx}].color"), c)?;
        }
        match (&group.samples, &group.stats) {
            (Some(_), Some(_)) => {
                return Err(ChartError::OutOfRange {
                    field: format!("groups[{idx}]"),
                    message: "provide either `samples` or `stats`, not both".to_string(),
                });
            }
            (None, None) => {
                return Err(ChartError::EmptyData {
                    field: "groups",
                    message: format!("groups[{idx}] must provide either `samples` or `stats`"),
                });
            }
            (Some(samples), None) => {
                if samples.is_empty() {
                    return Err(ChartError::EmptyData {
                        field: "samples",
                        message: format!("groups[{idx}].samples cannot be empty"),
                    });
                }
                if samples.len() > MAX_SAMPLES_PER_GROUP {
                    return Err(ChartError::LimitExceeded {
                        field: "samples",
                        max: MAX_SAMPLES_PER_GROUP,
                        actual: samples.len(),
                    });
                }
                for (s_idx, val) in samples.iter().enumerate() {
                    let field = format!("groups[{idx}].samples[{s_idx}]");
                    check_finite(&field, *val)?;
                    if is_log && *val <= 0.0 {
                        return Err(ChartError::OutOfRange {
                            field,
                            message: format!("log scale requires strictly positive values (got {val})"),
                        });
                    }
                }
            }
            (None, Some(st)) => {
                let prefix = format!("groups[{idx}].stats");
                check_finite(&format!("{prefix}.min"), st.min)?;
                check_finite(&format!("{prefix}.q1"), st.q1)?;
                check_finite(&format!("{prefix}.median"), st.median)?;
                check_finite(&format!("{prefix}.q3"), st.q3)?;
                check_finite(&format!("{prefix}.max"), st.max)?;
                if !(st.min <= st.q1 && st.q1 <= st.median && st.median <= st.q3 && st.q3 <= st.max) {
                    return Err(ChartError::OutOfRange {
                        field: prefix,
                        message: "box stats must satisfy min <= q1 <= median <= q3 <= max".to_string(),
                    });
                }
                if is_log && st.min <= 0.0 {
                    return Err(ChartError::OutOfRange {
                        field: format!("{prefix}.min"),
                        message: "log scale requires strictly positive stats".to_string(),
                    });
                }
                if let Some(m) = st.mean {
                    check_finite(&format!("{prefix}.mean"), m)?;
                }
                for (o_idx, o) in st.outliers.iter().enumerate() {
                    let field = format!("{prefix}.outliers[{o_idx}]");
                    check_finite(&field, *o)?;
                    if is_log && *o <= 0.0 {
                        return Err(ChartError::OutOfRange {
                            field,
                            message: format!("log scale requires strictly positive outliers (got {o})"),
                        });
                    }
                }
            }
        }
    }

    Ok(())
}

fn validate_histogram(spec: &ChartSpec, hist: &HistogramSpec) -> Result<(), ChartError> {
    if hist.values.is_empty() {
        return Err(ChartError::EmptyData {
            field: "values",
            message: "histogram requires at least one numeric value".to_string(),
        });
    }
    if hist.values.len() > MAX_HISTOGRAM_VALUES {
        return Err(ChartError::LimitExceeded {
            field: "values",
            max: MAX_HISTOGRAM_VALUES,
            actual: hist.values.len(),
        });
    }
    if let Some(c) = &hist.color {
        validate_color("color", c)?;
    }
    if let Some(bins) = hist.bins
        && (bins == 0 || bins > MAX_BINS)
    {
        return Err(ChartError::OutOfRange {
            field: "bins".to_string(),
            message: format!("bins must be between 1 and {MAX_BINS} (got {bins})"),
        });
    }
    if let Some(edges) = &hist.bin_edges {
        if edges.len() < 2 {
            return Err(ChartError::OutOfRange {
                field: "binEdges".to_string(),
                message: "binEdges must contain at least 2 edges".to_string(),
            });
        }
        if edges.len() > MAX_BINS + 1 {
            return Err(ChartError::LimitExceeded {
                field: "binEdges",
                max: MAX_BINS + 1,
                actual: edges.len(),
            });
        }
        for (i, e) in edges.iter().enumerate() {
            check_finite(&format!("binEdges[{i}]"), *e)?;
            if i > 0 && *e <= edges[i - 1] {
                return Err(ChartError::OutOfRange {
                    field: format!("binEdges[{i}]"),
                    message: "binEdges must be strictly increasing".to_string(),
                });
            }
        }
    }
    for (idx, v) in hist.values.iter().enumerate() {
        let field = format!("values[{idx}]");
        check_finite(&field, *v)?;
        if spec.x_axis.scale == AxisScale::Log && *v <= 0.0 {
            return Err(ChartError::OutOfRange {
                field,
                message: format!("log xAxis requires strictly positive values (got {v})"),
            });
        }
    }

    Ok(())
}

fn validate_sparkline(spark: &SparklineSpec) -> Result<(), ChartError> {
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
