use crate::engine::chart::color::{Rgb, canonical_hex, parse_rgb};

/// Concrete color palette matching VibeValley's warm workbench aesthetic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThemePalette {
    pub background: String,
    pub surface: String,
    pub text: String,
    pub text_muted: String,
    pub text_faint: String,
    pub axis: String,
    pub grid: String,
    pub border: String,
    pub annotation: String,
    pub negative: String,
    pub series: Vec<String>,
    pub heatmap_sequential: [String; 5],
    pub heatmap_diverging: [String; 5],
    pub font_family: String,
}

impl ThemePalette {
    /// VibeValley warm light workbench palette (`apps/mac/ui/design/theme.json`).
    pub fn light() -> Self {
        Self {
            background: "#fcfcfb".to_string(),
            surface: "#f6f5f3".to_string(),
            text: "#1c1917".to_string(),
            text_muted: "#5e5852".to_string(),
            text_faint: "#716a64".to_string(),
            axis: "#c5bfb7".to_string(),
            grid: "#eae7e2".to_string(),
            border: "#dedad4".to_string(),
            annotation: "#94531f".to_string(),
            negative: "#a83a2c".to_string(),
            series: vec![
                "#4d7a2a".to_string(), // leaf accent
                "#2c6aa3".to_string(), // water
                "#d99226".to_string(), // wheat
                "#b54534".to_string(), // berry
                "#7b5b8c".to_string(), // plum
                "#2d857a".to_string(), // pond teal
                "#8f6239".to_string(), // bark
                "#cf6d49".to_string(), // terracotta
            ],
            heatmap_sequential: [
                "#f6f4ee".to_string(),
                "#d8e6c3".to_string(),
                "#a4c678".to_string(),
                "#6b9940".to_string(),
                "#3b6125".to_string(),
            ],
            heatmap_diverging: [
                "#a83a2c".to_string(),
                "#df9a8d".to_string(),
                "#f6f5f3".to_string(),
                "#8cb6d9".to_string(),
                "#2c6aa3".to_string(),
            ],
            font_family: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', sans-serif".to_string(),
        }
    }

    /// VibeValley warm dark workbench palette (`apps/mac/ui/design/theme.json`).
    pub fn dark() -> Self {
        Self {
            background: "#151413".to_string(),
            surface: "#1b1a18".to_string(),
            text: "#ecebe8".to_string(),
            text_muted: "#a9a49e".to_string(),
            text_faint: "#8b867f".to_string(),
            axis: "#4b4742".to_string(),
            grid: "#2a2825".to_string(),
            border: "#34312d".to_string(),
            annotation: "#e0a062".to_string(),
            negative: "#e47d6d".to_string(),
            series: vec![
                "#8dbb5c".to_string(), // leaf
                "#6aa6dc".to_string(), // water
                "#e5a93c".to_string(), // wheat
                "#e47d6d".to_string(), // berry
                "#b494c8".to_string(), // plum
                "#5ec2b3".to_string(), // teal
                "#c99b6d".to_string(), // bark
                "#f09278".to_string(), // coral
            ],
            heatmap_sequential: [
                "#201f1d".to_string(),
                "#2c3d23".to_string(),
                "#496933".to_string(),
                "#74a046".to_string(),
                "#b4d685".to_string(),
            ],
            heatmap_diverging: [
                "#e47d6d".to_string(),
                "#8d473d".to_string(),
                "#252320".to_string(),
                "#3a6285".to_string(),
                "#6aa6dc".to_string(),
            ],
            font_family: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', sans-serif".to_string(),
        }
    }

    pub fn series_color(&self, index: usize, custom_palette: Option<&[String]>) -> String {
        if let Some(palette) = custom_palette
            && !palette.is_empty()
        {
            let raw = &palette[index % palette.len()];
            return canonical_hex(raw).unwrap_or_else(|| raw.clone());
        }
        if self.series.is_empty() {
            return "#4d7a2a".to_string();
        }
        let raw = &self.series[index % self.series.len()];
        canonical_hex(raw).unwrap_or_else(|| raw.clone())
    }

    pub fn sequential_stops(&self) -> [Rgb; 5] {
        self.heatmap_sequential.each_ref().map(|c| parse_rgb(c).unwrap_or(Rgb::new(0x74, 0xa0, 0x46)))
    }

    pub fn diverging_stops(&self) -> [Rgb; 5] {
        self.heatmap_diverging.each_ref().map(|c| parse_rgb(c).unwrap_or(Rgb::new(0x74, 0xa0, 0x46)))
    }
}

/// Controls whether emitted SVG uses concrete resolved hex colors (`resvg`/`usvg` safe)
/// or CSS custom properties with concrete fallbacks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThemeMode {
    Resolved(Box<ThemePalette>),
    CssVariables,
}

impl Default for ThemeMode {
    fn default() -> Self {
        Self::light()
    }
}

impl ThemeMode {
    pub fn light() -> Self {
        Self::Resolved(Box::new(ThemePalette::light()))
    }

    pub fn dark() -> Self {
        Self::Resolved(Box::new(ThemePalette::dark()))
    }

    pub fn resolved(palette: ThemePalette) -> Self {
        Self::Resolved(Box::new(palette))
    }

    pub fn css_variables() -> Self {
        Self::CssVariables
    }
}

/// Internal resolved paint tokens used during SVG emission.
#[derive(Debug, Clone)]
pub(crate) struct PaintTokens {
    pub background: String,
    pub surface: String,
    pub text: String,
    pub text_muted: String,
    pub text_faint: String,
    pub axis: String,
    pub grid: String,
    pub border: String,
    pub annotation: String,
    pub negative: String,
    pub font_family: String,
    pub palette: ThemePalette,
    pub css_vars: bool,
}

impl PaintTokens {
    pub(crate) fn from_mode(mode: &ThemeMode) -> Self {
        match mode {
            ThemeMode::Resolved(palette) => {
                let p = (**palette).clone();
                Self {
                    background: canonical_or(&p.background),
                    surface: canonical_or(&p.surface),
                    text: canonical_or(&p.text),
                    text_muted: canonical_or(&p.text_muted),
                    text_faint: canonical_or(&p.text_faint),
                    axis: canonical_or(&p.axis),
                    grid: canonical_or(&p.grid),
                    border: canonical_or(&p.border),
                    annotation: canonical_or(&p.annotation),
                    negative: canonical_or(&p.negative),
                    font_family: p.font_family.clone(),
                    palette: p,
                    css_vars: false,
                }
            }
            ThemeMode::CssVariables => {
                let fallback = ThemePalette::light();
                Self {
                    background: format!("var(--vv-chart-bg, {})", fallback.background),
                    surface: format!("var(--vv-chart-surface, {})", fallback.surface),
                    text: format!("var(--vv-chart-text, {})", fallback.text),
                    text_muted: format!("var(--vv-chart-text-muted, {})", fallback.text_muted),
                    text_faint: format!("var(--vv-chart-text-faint, {})", fallback.text_faint),
                    axis: format!("var(--vv-chart-axis, {})", fallback.axis),
                    grid: format!("var(--vv-chart-grid, {})", fallback.grid),
                    border: format!("var(--vv-chart-border, {})", fallback.border),
                    annotation: format!("var(--vv-chart-annotation, {})", fallback.annotation),
                    negative: format!("var(--vv-chart-negative, {})", fallback.negative),
                    font_family: format!("var(--vv-chart-font, {})", fallback.font_family),
                    palette: fallback,
                    css_vars: true,
                }
            }
        }
    }

    pub(crate) fn series_color(&self, index: usize, explicit: Option<&str>, spec_palette: Option<&[String]>) -> String {
        if let Some(color) = explicit {
            return canonical_or(color);
        }
        let concrete = self.palette.series_color(index, spec_palette);
        if self.css_vars && spec_palette.is_none() {
            format!("var(--vv-chart-series-{}, {concrete})", (index % 8) + 1)
        } else {
            concrete
        }
    }

    /// Concrete RGB for WCAG contrast checks (falls back to light palette under CssVariables).
    pub(crate) fn concrete_series_rgb(&self, index: usize, explicit: Option<&str>, spec_palette: Option<&[String]>) -> Rgb {
        let color = explicit
            .map(ToString::to_string)
            .unwrap_or_else(|| self.palette.series_color(index, spec_palette));
        parse_rgb(&color).unwrap_or(Rgb::new(0x4d, 0x7a, 0x2a))
    }
}

fn canonical_or(color: &str) -> String {
    canonical_hex(color).unwrap_or_else(|| color.trim().to_string())
}
