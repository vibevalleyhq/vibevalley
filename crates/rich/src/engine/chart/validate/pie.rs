use crate::engine::chart::color::validate_color;
use crate::engine::chart::error::ChartError;
use crate::engine::chart::spec::PieSpec;

use super::MAX_SLICES;
use super::common::check_finite;

pub(super) fn validate_pie(pie: &PieSpec, is_donut: bool) -> Result<(), ChartError> {
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
