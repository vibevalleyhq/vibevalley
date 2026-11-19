use indexmap::IndexMap;

use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError};

use super::parser::PieAst;

#[derive(Debug, Clone)]
pub struct PieModel {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub show_data: bool,
    pub sections: IndexMap<String, f64>,
}

fn format_js_number(v: f64) -> String {
    if v == 0.0 {
        "0".to_string()
    } else if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

pub fn build_pie(ast: PieAst, title: Option<&str>) -> Result<PieModel, PeleError> {
    let mut sections: IndexMap<String, f64> = IndexMap::new();
    for sec in ast.sections {
        if sec.value < 0.0 {
            return Err(PeleError::new(
                format!(
                    "\"{}\" has invalid value: {}. Negative values are not allowed in pie charts. All slice values must be >= 0.",
                    sec.label,
                    format_js_number(sec.value)
                ),
                ErrorCode::Semantic,
            )
            .with_diagram_type(DiagramType::Pie));
        }
        sections.entry(sec.label).or_insert(sec.value);
    }
    let resolved_title = match ast.title {
        Some(t) if !t.is_empty() => Some(t),
        _ => title.map(str::to_string),
    };
    let acc_title = ast.acc_title.filter(|s| !s.is_empty()).map(|s| s.trim_start().to_string());
    let acc_descr = ast.acc_descr.filter(|s| !s.is_empty()).map(|s| {
        let mut out = String::with_capacity(s.len());
        let mut after_nl = false;
        for ch in s.chars() {
            if ch == '\n' {
                out.push('\n');
                after_nl = true;
            } else if after_nl && ch.is_whitespace() {
                continue;
            } else {
                after_nl = false;
                out.push(ch);
            }
        }
        out
    });
    Ok(PieModel {
        title: resolved_title,
        acc_title,
        acc_descr,
        show_data: ast.show_data,
        sections,
    })
}
