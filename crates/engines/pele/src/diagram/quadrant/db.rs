use indexmap::IndexMap;

use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuadrantTextKind {
    Text,
    Markdown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuadrantText {
    pub text: String,
    pub kind: QuadrantTextKind,
}

impl QuadrantText {
    pub fn trimmed(self) -> Self {
        Self {
            text: self.text.trim().to_string(),
            kind: self.kind,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PointStyle {
    pub radius: Option<f64>,
    pub color: Option<String>,
    pub stroke_color: Option<String>,
    pub stroke_width: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct QuadrantPoint {
    pub x: f64,
    pub y: f64,
    pub text: QuadrantText,
    pub class_name: String,
    pub style: PointStyle,
}

#[derive(Debug, Clone, PartialEq)]
pub struct QuadrantModel {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    /// Quadrants 1 to 4: top right, top left, bottom left, bottom right.
    pub quadrants: [Option<QuadrantText>; 4],
    pub x_axis_left: Option<QuadrantText>,
    pub x_axis_right: Option<QuadrantText>,
    pub y_axis_bottom: Option<QuadrantText>,
    pub y_axis_top: Option<QuadrantText>,
    pub points: Vec<QuadrantPoint>,
    pub classes: IndexMap<String, PointStyle>,
}

impl Default for QuadrantModel {
    fn default() -> Self {
        Self::new()
    }
}

fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn is_hex_code(s: &str) -> bool {
    let digits = s.strip_prefix('#').unwrap_or(s);
    matches!(digits.len(), 3 | 6) && digits.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_pixels(s: &str) -> bool {
    s.strip_suffix("px").is_some_and(is_digits)
}

fn invalid(style: &str, value: &str, kind: &str) -> PeleError {
    PeleError::new(format!("value for {style} {value} is invalid, please use a valid {kind}"), ErrorCode::Semantic)
        .with_diagram_type(DiagramType::QuadrantChart)
}

fn key_value(style: &str) -> (&str, &str) {
    let s = style.trim();
    let Some(colon) = s.find(':') else {
        return (s, "undefined");
    };
    let rest = s[colon + 1..].trim_start();
    let key = s[..colon].trim_end();
    match rest.find(':') {
        Some(next) => (key, rest[..next].trim_end()),
        None => (key, rest),
    }
}

pub fn parse_styles(styles: &[String]) -> Result<PointStyle, PeleError> {
    let mut out = PointStyle::default();
    for style in styles {
        let (key, value) = key_value(style);
        match key {
            "radius" => {
                if !is_digits(value) {
                    return Err(invalid(key, value, "number"));
                }
                out.radius = Some(value.parse::<f64>().unwrap_or(f64::INFINITY));
            }
            "color" => {
                if !is_hex_code(value) {
                    return Err(invalid(key, value, "hex code"));
                }
                out.color = Some(value.to_string());
            }
            "stroke-color" => {
                if !is_hex_code(value) {
                    return Err(invalid(key, value, "hex code"));
                }
                out.stroke_color = Some(value.to_string());
            }
            "stroke-width" => {
                if !is_pixels(value) {
                    return Err(invalid(key, value, "number of pixels (eg. 10px)"));
                }
                out.stroke_width = Some(value.to_string());
            }
            _ => {
                return Err(PeleError::new(format!("style named {key} is not supported."), ErrorCode::Semantic).with_diagram_type(DiagramType::QuadrantChart));
            }
        }
    }
    Ok(out)
}

fn js_number(raw: &str) -> f64 {
    let s = raw.trim();
    if s.is_empty() {
        return 0.0;
    }
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        return u128::from_str_radix(hex, 16).map_or(f64::NAN, |v| v as f64);
    }
    if let Some(bin) = s.strip_prefix("0b").or_else(|| s.strip_prefix("0B")) {
        return u128::from_str_radix(bin, 2).map_or(f64::NAN, |v| v as f64);
    }
    if let Some(oct) = s.strip_prefix("0o").or_else(|| s.strip_prefix("0O")) {
        return u128::from_str_radix(oct, 8).map_or(f64::NAN, |v| v as f64);
    }
    s.parse::<f64>().unwrap_or(f64::NAN)
}

impl QuadrantModel {
    pub fn new() -> Self {
        Self {
            title: None,
            acc_title: None,
            acc_descr: None,
            quadrants: [None, None, None, None],
            x_axis_left: None,
            x_axis_right: None,
            y_axis_bottom: None,
            y_axis_top: None,
            points: Vec::new(),
            classes: IndexMap::new(),
        }
    }

    pub fn set_quadrant_text(&mut self, index: usize, label: QuadrantText) {
        if index < 4 {
            self.quadrants[index] = Some(label.trimmed());
        }
    }

    pub fn set_x_axis_left_text(&mut self, label: QuadrantText) {
        self.x_axis_left = Some(label.trimmed());
    }

    pub fn set_x_axis_right_text(&mut self, label: QuadrantText) {
        self.x_axis_right = Some(label.trimmed());
    }

    pub fn set_y_axis_bottom_text(&mut self, label: QuadrantText) {
        self.y_axis_bottom = Some(label.trimmed());
    }

    pub fn set_y_axis_top_text(&mut self, label: QuadrantText) {
        self.y_axis_top = Some(label.trimmed());
    }

    pub fn add_point(&mut self, label: QuadrantText, class_name: String, x: &str, y: &str, styles: &[String]) -> Result<(), PeleError> {
        let style = parse_styles(styles)?;
        self.points.push(QuadrantPoint {
            x: js_number(x),
            y: js_number(y),
            text: label.trimmed(),
            class_name,
            style,
        });
        Ok(())
    }

    pub fn add_class(&mut self, class_name: String, styles: &[String]) -> Result<(), PeleError> {
        let style = parse_styles(styles)?;
        self.classes.insert(class_name, style);
        Ok(())
    }

    pub fn set_diagram_title(&mut self, text: String) {
        self.title = Some(text);
    }

    pub fn set_acc_title(&mut self, text: &str) {
        self.acc_title = Some(text.trim_start().to_string());
    }

    pub fn set_acc_description(&mut self, text: &str) {
        let mut out = String::with_capacity(text.len());
        let mut lines = text.split('\n');
        if let Some(first) = lines.next() {
            out.push_str(first);
            for line in lines {
                out.push('\n');
                out.push_str(line.trim_start());
            }
        }
        self.acc_descr = Some(out);
    }
}
