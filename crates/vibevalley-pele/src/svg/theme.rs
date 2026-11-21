use std::borrow::Cow;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::svg::builder::{esc, has_invalid_xml_char, num};
use crate::svg::ink::parse_hex_rgb;
use crate::svg::palette::PaletteOverrides;

pub const DEFAULT_SERIES: [&str; 8] = ["#4c78a8", "#f58518", "#54a24b", "#e45756", "#72b7b2", "#eeca3b", "#b279a2", "#9d755d"];

pub const ROOT_STYLE_VARS: &str = "--_bg:var(--pele-bg,#fff);--_fg:var(--pele-fg,#1f1f1f);--_m:var(--pele-muted,#6e6e6e);\
--_l:var(--pele-line,#1f1f1f);--_s:var(--pele-surface,#f3f3f3);--_a:var(--pele-surface-alt,#e6e6e6);\
--_b:var(--pele-border,#8a8a8a);--_c:var(--pele-accent,#5b7bd5);color:var(--_fg)";

pub const RADIUS_VAR: &str = "var(--pele-radius,4px)";
pub const ROUNDED_VAR: &str = r#" style="rx:var(--_r)""#;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThemePalette {
    pub bg: String,
    pub fg: String,
    pub muted: String,
    pub line: String,
    pub surface: String,
    pub surface_alt: String,
    pub border: String,
    pub accent: String,
    pub critical: String,
    pub fg_on_light: String,
    pub fg_on_dark: String,
    pub series: [String; 8],
    pub radius: f64,
    pub font_family: String,
    pub font_family_mono: String,
    pub title_weight: String,
    pub heading_weight: String,
    pub bold_weight: String,
}

impl ThemePalette {
    /// Pele's default light palette.
    pub fn light() -> Self {
        Self {
            bg: "#ffffff".to_string(),
            fg: "#1f1f1f".to_string(),
            muted: "#6e6e6e".to_string(),
            line: "#1f1f1f".to_string(),
            surface: "#f3f3f3".to_string(),
            surface_alt: "#e6e6e6".to_string(),
            border: "#8a8a8a".to_string(),
            accent: "#5b7bd5".to_string(),
            critical: "#e45756".to_string(),
            fg_on_light: "#1f1f1f".to_string(),
            fg_on_dark: "#ffffff".to_string(),
            series: DEFAULT_SERIES.map(str::to_string),
            radius: 4.0,
            font_family: "sans-serif".to_string(),
            font_family_mono: "monospace".to_string(),
            title_weight: "bold".to_string(),
            heading_weight: "bold".to_string(),
            bold_weight: "bold".to_string(),
        }
    }

    /// Dark palette suitable for dark-mode native rendering in `resvg`.
    pub fn dark() -> Self {
        Self {
            bg: "#1e1e1e".to_string(),
            fg: "#e6e6e6".to_string(),
            muted: "#9e9e9e".to_string(),
            line: "#d4d4d4".to_string(),
            surface: "#2a2a2a".to_string(),
            surface_alt: "#343434".to_string(),
            border: "#5c5c5c".to_string(),
            accent: "#7aa2f7".to_string(),
            critical: "#f7768e".to_string(),
            fg_on_light: "#1f1f1f".to_string(),
            fg_on_dark: "#ffffff".to_string(),
            series: ["#7aa2f7", "#ff9e64", "#9ece6a", "#f7768e", "#73daca", "#e0af68", "#bb9af7", "#c0a36e"].map(str::to_string),
            radius: 4.0,
            font_family: "sans-serif".to_string(),
            font_family_mono: "monospace".to_string(),
            title_weight: "bold".to_string(),
            heading_weight: "bold".to_string(),
            bold_weight: "bold".to_string(),
        }
    }
}

impl Default for ThemePalette {
    fn default() -> Self {
        Self::light()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ThemeMode {
    /// Emits concrete attributes and colors safe for `resvg` (no `var(...)`, no `color-mix(...)`).
    Resolved(Box<ThemePalette>),
    /// Emits Pele's CSS custom properties (`var(--_bg)`, `var(--pele-bg,#fff)`, etc.).
    CssVariables,
}

impl ThemeMode {
    pub fn resolved(palette: ThemePalette) -> Self {
        Self::Resolved(Box::new(palette))
    }

    pub fn light() -> Self {
        Self::resolved(ThemePalette::light())
    }

    pub fn dark() -> Self {
        Self::resolved(ThemePalette::dark())
    }
}

impl Default for ThemeMode {
    fn default() -> Self {
        Self::light()
    }
}

#[derive(Debug, Clone)]
pub struct SvgTheme {
    mode: ThemeMode,
    font_family: String,
    font_family_mono: String,
}

impl SvgTheme {
    pub fn new(mode: ThemeMode, opt_font_family: Option<&str>, opt_font_mono: Option<&str>) -> Self {
        let (default_font, default_mono) = match &mode {
            ThemeMode::Resolved(p) => (p.font_family.as_str(), p.font_family_mono.as_str()),
            ThemeMode::CssVariables => ("sans-serif", "monospace"),
        };
        let font_family = safe_font_families(opt_font_family, default_font);
        let font_family_mono = safe_font_families(opt_font_mono, default_mono);
        Self {
            mode,
            font_family,
            font_family_mono,
        }
    }

    pub fn is_resolved(&self) -> bool {
        match &self.mode {
            ThemeMode::Resolved(_) => true,
            ThemeMode::CssVariables => false,
        }
    }

    pub fn font_family(&self) -> &str {
        &self.font_family
    }

    pub fn font_family_mono_raw(&self) -> &str {
        &self.font_family_mono
    }

    pub fn bg(&self) -> &str {
        match &self.mode {
            ThemeMode::Resolved(p) => &p.bg,
            ThemeMode::CssVariables => "var(--_bg)",
        }
    }

    pub fn fg(&self) -> &str {
        match &self.mode {
            ThemeMode::Resolved(p) => &p.fg,
            ThemeMode::CssVariables => "var(--_fg)",
        }
    }

    pub fn muted(&self) -> &str {
        match &self.mode {
            ThemeMode::Resolved(p) => &p.muted,
            ThemeMode::CssVariables => "var(--_m)",
        }
    }

    pub fn line(&self) -> &str {
        match &self.mode {
            ThemeMode::Resolved(p) => &p.line,
            ThemeMode::CssVariables => "var(--_l)",
        }
    }

    pub fn surface(&self) -> &str {
        match &self.mode {
            ThemeMode::Resolved(p) => &p.surface,
            ThemeMode::CssVariables => "var(--_s)",
        }
    }

    pub fn surface_alt(&self) -> &str {
        match &self.mode {
            ThemeMode::Resolved(p) => &p.surface_alt,
            ThemeMode::CssVariables => "var(--_a)",
        }
    }

    pub fn border(&self) -> &str {
        match &self.mode {
            ThemeMode::Resolved(p) => &p.border,
            ThemeMode::CssVariables => "var(--_b)",
        }
    }

    pub fn accent(&self) -> &str {
        match &self.mode {
            ThemeMode::Resolved(p) => &p.accent,
            ThemeMode::CssVariables => "var(--_c)",
        }
    }

    pub fn critical(&self) -> &str {
        match &self.mode {
            ThemeMode::Resolved(p) => &p.critical,
            ThemeMode::CssVariables => "var(--pele-critical,#e45756)",
        }
    }

    pub fn on_light(&self) -> &str {
        match &self.mode {
            ThemeMode::Resolved(p) => &p.fg_on_light,
            ThemeMode::CssVariables => "var(--pele-fg-on-light,#1f1f1f)",
        }
    }

    pub fn on_dark(&self) -> &str {
        match &self.mode {
            ThemeMode::Resolved(p) => &p.fg_on_dark,
            ThemeMode::CssVariables => "var(--pele-fg-on-dark,#fff)",
        }
    }

    pub fn font_mono(&self) -> &str {
        match &self.mode {
            ThemeMode::Resolved(_) => &self.font_family_mono,
            ThemeMode::CssVariables => "var(--_fm)",
        }
    }

    pub fn title_weight(&self) -> &str {
        match &self.mode {
            ThemeMode::Resolved(p) => &p.title_weight,
            ThemeMode::CssVariables => "var(--_tw)",
        }
    }

    pub fn heading_weight(&self) -> &str {
        match &self.mode {
            ThemeMode::Resolved(p) => &p.heading_weight,
            ThemeMode::CssVariables => "var(--_hw)",
        }
    }

    pub fn bold_weight(&self) -> &str {
        match &self.mode {
            ThemeMode::Resolved(p) => &p.bold_weight,
            ThemeMode::CssVariables => "var(--_w)",
        }
    }

    pub fn shape_attrs(&self) -> String {
        format!(r#" fill="{}" stroke="{}""#, self.surface(), self.border())
    }

    pub fn line_attrs(&self) -> String {
        format!(r#" stroke="{}""#, self.border())
    }

    pub fn rounded_standalone(&self) -> String {
        match &self.mode {
            ThemeMode::Resolved(p) => format!(r#" rx="{}""#, num(p.radius)),
            ThemeMode::CssVariables => ROUNDED_VAR.to_string(),
        }
    }

    pub fn rounded(&self, attrs: &str) -> String {
        match &self.mode {
            ThemeMode::Resolved(p) => {
                if attrs.contains(" rx=") || attrs.contains("rx:") {
                    attrs.to_string()
                } else {
                    format!(r#"{attrs} rx="{}""#, num(p.radius))
                }
            }
            ThemeMode::CssVariables => match attrs.find(r#" style=""#) {
                None => format!("{attrs}{ROUNDED_VAR}"),
                Some(at) => format!("{}rx:var(--_r);{}", &attrs[..at + 8], &attrs[at + 8..]),
            },
        }
    }

    pub fn series_color<'a>(&'a self, index: usize, overrides: &'a PaletteOverrides) -> Cow<'a, str> {
        let k = index % 8;
        match &self.mode {
            ThemeMode::Resolved(p) => {
                if let Some(custom) = &overrides.colors[k]
                    && !custom.contains("var(")
                    && !custom.contains("light-dark(")
                    && !custom.contains("color-mix(")
                {
                    return Cow::Borrowed(custom.as_str());
                }
                Cow::Borrowed(&p.series[k])
            }
            ThemeMode::CssVariables => Cow::Owned(format!("var(--pele-series-{},{})", k + 1, DEFAULT_SERIES[k])),
        }
    }

    /// Halo stroke color for a cluster title crossed by edges at nesting `depth`.
    pub fn cluster_halo(&self, depth: usize) -> String {
        let weight = 1.0 - 0.5f64.powi(depth as i32);
        match &self.mode {
            ThemeMode::Resolved(p) => {
                if let (Some((ar, ag, ab)), Some((br, bg, bb))) = (parse_hex_rgb(&p.surface_alt), parse_hex_rgb(&p.bg)) {
                    let mix = |a: u8, b: u8| -> u8 { ((a as f64) * weight + (b as f64) * (1.0 - weight)).round() as u8 };
                    format!("#{:02x}{:02x}{:02x}", mix(ar, br), mix(ag, bg), mix(ab, bb))
                } else {
                    p.bg.clone()
                }
            }
            ThemeMode::CssVariables => {
                format!("color-mix(in srgb,var(--_a) {}%,var(--_bg))", num(100.0 * weight))
            }
        }
    }

    pub fn root_font_style(&self, size: f64) -> String {
        format!(
            ";--_fm:var(--pele-font-mono,{});font:{}px sans-serif;\
            letter-spacing:normal;word-spacing:normal;text-transform:none;direction:ltr;\
            font-family:var(--pele-font,{})",
            self.font_family_mono,
            num(size),
            self.font_family
        )
    }
}

pub fn safe_font_families(list: Option<&str>, generic: &str) -> String {
    match list {
        Some(raw) if is_valid_font_family_list(raw) => raw.to_string(),
        _ => generic.to_string(),
    }
}

fn is_valid_font_family_list(list: &str) -> bool {
    let trimmed = list.trim();
    if trimmed.is_empty() {
        return false;
    }
    for part in trimmed.split(',') {
        let p = part.trim();
        if p.is_empty() {
            return false;
        }
        if (p.starts_with('"') && p.ends_with('"') && p.len() >= 2) || (p.starts_with('\'') && p.ends_with('\'') && p.len() >= 2) {
            let inner = &p[1..p.len() - 1];
            if inner
                .chars()
                .any(|c| matches!(c, '"' | '\'' | '\\' | '\n' | '<' | '>' | '{' | '}' | '(' | ')' | ';' | ':' | '@'))
            {
                return false;
            }
        } else {
            let mut chars = p.chars();
            let Some(first) = chars.next() else {
                return false;
            };
            if !(first.is_alphanumeric() || first == '_' || first == '-') {
                return false;
            }
            if !chars.all(|c| c.is_alphanumeric() || matches!(c, '_' | ' ' | '.' | '-')) {
                return false;
            }
        }
    }
    true
}

fn is_shape_prop(prop: &str) -> bool {
    matches!(
        prop,
        "fill"
            | "fill-opacity"
            | "stroke"
            | "stroke-width"
            | "stroke-dasharray"
            | "stroke-dashoffset"
            | "stroke-linecap"
            | "stroke-linejoin"
            | "stroke-opacity"
            | "opacity"
            | "rx"
            | "ry"
    )
}

fn is_text_prop(prop: &str) -> bool {
    matches!(
        prop,
        "color" | "font-size" | "font-family" | "font-weight" | "font-style" | "text-decoration" | "letter-spacing" | "word-spacing" | "opacity"
    )
}

fn is_unsafe_style_value(value: &str) -> bool {
    if value.chars().any(|c| matches!(c, '<' | '>' | '{' | '}' | ';' | '\\')) {
        return true;
    }
    let lower = value.to_ascii_lowercase();
    if lower.contains("javascript:") || lower.contains("@import") || lower.contains("image-set") || lower.contains("/*") {
        return true;
    }
    for kw in ["url", "expression"] {
        let mut search = 0;
        while let Some(rel) = lower[search..].find(kw) {
            let after = lower[search + rel + kw.len()..].trim_start();
            if after.starts_with('(') {
                return true;
            }
            search += rel + kw.len();
        }
    }
    false
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ResolvedStyle {
    pub shape: String,
    pub line: String,
    pub text: String,
    pub stroke: Option<String>,
    pub bold: bool,
    pub italic: bool,
    pub font_size: Option<f64>,
}

pub fn sets_fill(shape: &str) -> bool {
    shape.contains(r#""fill:"#) || shape.contains(";fill:")
}

pub fn resolve_style(declarations: &[String]) -> ResolvedStyle {
    if declarations.is_empty() {
        return ResolvedStyle::default();
    }
    let mut shape: IndexMap<String, String> = IndexMap::new();
    let mut text: IndexMap<String, String> = IndexMap::new();
    for decl in declarations {
        let Some(at) = decl.find(':') else {
            continue;
        };
        if at == 0 {
            continue;
        }
        let prop = decl[..at].trim().to_ascii_lowercase();
        let value = strip_important(&decl[at + 1..]);
        let value = value.trim();
        if value.is_empty() || is_unsafe_style_value(value) || has_invalid_xml_char(value) {
            continue;
        }
        if is_shape_prop(&prop) {
            shape.insert(prop.clone(), value.to_string());
        }
        if is_text_prop(&prop) {
            let mapped = if prop == "color" { "fill".to_string() } else { prop };
            text.insert(mapped, value.to_string());
        }
    }
    if shape.is_empty() && text.is_empty() {
        return ResolvedStyle::default();
    }
    let mut shape_css = String::new();
    let mut line_css = String::new();
    for (prop, value) in &shape {
        shape_css.push_str(prop);
        shape_css.push(':');
        shape_css.push_str(value);
        shape_css.push(';');
        if prop != "fill" && prop != "fill-opacity" {
            line_css.push_str(prop);
            line_css.push(':');
            line_css.push_str(value);
            line_css.push(';');
        }
    }
    let mut text_css = String::new();
    for (prop, value) in &text {
        text_css.push_str(prop);
        text_css.push(':');
        text_css.push_str(value);
        text_css.push(';');
    }
    let weight = text.get("font-weight").map(String::as_str);
    let bold = match weight {
        Some("bold" | "bolder") => true,
        Some(w) => w.parse::<f64>().is_ok_and(|n| n >= 600.0),
        None => false,
    };
    let italic = text.get("font-style").map(String::as_str) == Some("italic");
    let font_size = text.get("font-size").and_then(|s| {
        let stripped = s.strip_suffix("px").unwrap_or(s);
        if !stripped.is_empty() && stripped.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
            stripped.parse::<f64>().ok().filter(|&px| px > 0.0 && px <= 200.0)
        } else {
            None
        }
    });
    ResolvedStyle {
        shape: if shape_css.is_empty() {
            String::new()
        } else {
            format!(r#" style="{}""#, esc(&shape_css))
        },
        line: if line_css.is_empty() {
            String::new()
        } else {
            format!(r#" style="{}""#, esc(&line_css))
        },
        text: if text_css.is_empty() {
            String::new()
        } else {
            format!(r#" style="{}""#, esc(&text_css))
        },
        stroke: shape.get("stroke").cloned(),
        bold,
        italic,
        font_size,
    }
}

fn strip_important(s: &str) -> String {
    let lower = s.to_ascii_lowercase();
    if !lower.contains("!important") {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut cursor = 0;
    while let Some(rel) = lower[cursor..].find("!important") {
        let at = cursor + rel;
        out.push_str(&s[cursor..at]);
        cursor = at + 10;
    }
    out.push_str(&s[cursor..]);
    out
}

pub fn class_names(raw: &str) -> String {
    let mut out = String::new();
    let mut in_word = false;
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            if !in_word {
                out.push(' ');
                in_word = true;
            }
            out.push(ch);
        } else {
            in_word = false;
        }
    }
    out
}
