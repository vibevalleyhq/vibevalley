use std::collections::HashMap;

use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError};

use super::parser::{OptionValue, RadarAst};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RadarAxis {
    pub name: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RadarCurve {
    pub name: String,
    pub label: String,
    pub entries: Vec<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Graticule {
    Circle,
    Polygon,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RadarOptions {
    pub show_legend: bool,
    pub ticks: f64,
    pub max: Option<f64>,
    pub min: f64,
    pub graticule: Graticule,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RadarModel {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub axes: Vec<RadarAxis>,
    pub curves: Vec<RadarCurve>,
    pub options: RadarOptions,
}

const MAX_TICKS: f64 = 32.0;

fn invalid(message: impl Into<String>) -> PeleError {
    PeleError::new(message, ErrorCode::Semantic).with_diagram_type(DiagramType::Radar)
}

fn trim_multiline_indent(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut lines = text.split('\n');
    if let Some(first) = lines.next() {
        out.push_str(first);
        for line in lines {
            out.push('\n');
            out.push_str(line.trim_start());
        }
    }
    out
}

pub fn build_radar(ast: RadarAst, title: Option<&str>) -> Result<RadarModel, PeleError> {
    let axes: Vec<RadarAxis> = ast
        .axes
        .into_iter()
        .map(|axis| {
            let label = axis.label.unwrap_or_else(|| axis.name.clone());
            RadarAxis { name: axis.name, label }
        })
        .collect();

    let mut curves = Vec::with_capacity(ast.curves.len());
    for curve in ast.curves {
        let entries = if curve.entries.first().is_none_or(|e| e.axis.is_none()) {
            curve.entries.into_iter().map(|e| e.value).collect()
        } else {
            if axes.is_empty() {
                return Err(invalid("Axes must be populated before curves for reference entries"));
            }
            let mut by_axis: HashMap<String, f64> = HashMap::new();
            for entry in curve.entries {
                if let Some(axis_ref) = entry.axis {
                    by_axis.entry(axis_ref).or_insert(entry.value);
                }
            }
            let mut ordered = Vec::with_capacity(axes.len());
            for axis in &axes {
                let Some(&value) = by_axis.get(&axis.name) else {
                    return Err(invalid(format!("Missing entry for axis {}", axis.label)));
                };
                ordered.push(value);
            }
            ordered
        };
        let label = curve.label.unwrap_or_else(|| curve.name.clone());
        curves.push(RadarCurve {
            name: curve.name,
            label,
            entries,
        });
    }

    let mut options = RadarOptions {
        show_legend: true,
        ticks: 5.0,
        max: None,
        min: 0.0,
        graticule: Graticule::Circle,
    };
    for opt in ast.options {
        match opt {
            OptionValue::ShowLegend(b) => options.show_legend = b,
            OptionValue::Graticule(g) => options.graticule = g,
            OptionValue::Ticks(v) => options.ticks = v,
            OptionValue::Max(v) => options.max = Some(v),
            OptionValue::Min(v) => options.min = v,
        }
    }
    if options.ticks > MAX_TICKS {
        options.ticks = MAX_TICKS;
    }

    let resolved_title = match ast.title {
        Some(t) if !t.is_empty() => Some(t),
        _ => title.map(str::to_string),
    };
    let acc_title = ast.acc_title.filter(|s| !s.is_empty()).map(|s| s.trim_start().to_string());
    let acc_descr = ast.acc_descr.filter(|s| !s.is_empty()).map(|s| trim_multiline_indent(&s));

    Ok(RadarModel {
        title: resolved_title,
        acc_title,
        acc_descr,
        axes,
        curves,
        options,
    })
}
