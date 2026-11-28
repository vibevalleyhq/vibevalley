use crate::engine::chart::color::validate_color;
use crate::engine::chart::error::ChartError;
use crate::engine::chart::spec::{AxisScale, BarOrientation, BoxplotSpec, ChartSpec, HeatmapScale, HeatmapSpec, HistogramSpec};

use super::common::check_finite;
use super::{MAX_BINS, MAX_BOXPLOT_GROUPS, MAX_HEATMAP_CELLS, MAX_HEATMAP_COLS, MAX_HEATMAP_ROWS, MAX_HISTOGRAM_VALUES, MAX_SAMPLES_PER_GROUP};

pub(super) fn validate_heatmap(hm: &HeatmapSpec) -> Result<(), ChartError> {
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

pub(super) fn validate_boxplot(spec: &ChartSpec, bp: &BoxplotSpec) -> Result<(), ChartError> {
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

pub(super) fn validate_histogram(spec: &ChartSpec, hist: &HistogramSpec) -> Result<(), ChartError> {
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
