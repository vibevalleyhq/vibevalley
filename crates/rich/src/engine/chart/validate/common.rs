use crate::engine::chart::color::validate_color;
use crate::engine::chart::error::ChartError;
use crate::engine::chart::spec::{Annotation, AxisScale, AxisSpec, XRef};

pub(super) fn check_dimension(field: &'static str, val: f64, min: f64, max: f64) -> Result<(), ChartError> {
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

pub(super) fn check_finite(field: &str, val: f64) -> Result<(), ChartError> {
    if !val.is_finite() {
        return Err(ChartError::NonFiniteValue { field: field.to_string() });
    }
    Ok(())
}

pub(super) fn validate_axis(name: &'static str, axis: &AxisSpec) -> Result<(), ChartError> {
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

pub(super) fn validate_annotation(idx: usize, ann: &Annotation) -> Result<(), ChartError> {
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

pub(super) fn check_opacity(field: &str, op: f64) -> Result<(), ChartError> {
    check_finite(field, op)?;
    if !(0.0..=1.0).contains(&op) {
        return Err(ChartError::OutOfRange {
            field: field.to_string(),
            message: format!("opacity must be between 0.0 and 1.0 (got {op})"),
        });
    }
    Ok(())
}
