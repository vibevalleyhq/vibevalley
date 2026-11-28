use std::collections::HashSet;

use crate::engine::canvas::model::{CanvasColor, EdgeId, PresetColor, Rgba8};

use super::geometry::ArrowConfig;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PresetSwatch {
    pub border: Rgba8,
    pub fill: Rgba8,
    pub fill_opacity: f64,
    pub label: Rgba8,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ThemePalette {
    pub background: Rgba8,
    pub dot_color: Rgba8,
    pub card_fill: Rgba8,
    pub card_border: Rgba8,
    pub group_fill: Rgba8,
    pub group_fill_opacity: f64,
    pub group_border: Rgba8,
    pub group_label_bg: Rgba8,
    pub text: Rgba8,
    pub muted: Rgba8,
    pub link: Rgba8,
    pub edge: Rgba8,
    pub edge_label_bg: Rgba8,
    pub presets: [PresetSwatch; 6],
}

impl ThemePalette {
    const fn swatch(border: u32, fill_opacity: f64, label: u32) -> PresetSwatch {
        let color = Rgba8::from_hex_u32(border);
        PresetSwatch {
            border: color,
            fill: color,
            fill_opacity,
            label: Rgba8::from_hex_u32(label),
        }
    }

    pub fn light() -> Self {
        Self {
            background: Rgba8::from_hex_u32(0xfafafa),
            dot_color: Rgba8::from_hex_u32(0xdedee2),
            card_fill: Rgba8::from_hex_u32(0xffffff),
            card_border: Rgba8::from_hex_u32(0xd4d4d8),
            group_fill: Rgba8::from_hex_u32(0xf0f0f3),
            group_fill_opacity: 0.65,
            group_border: Rgba8::from_hex_u32(0xc4c4cc),
            group_label_bg: Rgba8::from_hex_u32(0xededf0),
            text: Rgba8::from_hex_u32(0x171717),
            muted: Rgba8::from_hex_u32(0x6b6b6b),
            link: Rgba8::from_hex_u32(0x0060e2),
            edge: Rgba8::from_hex_u32(0x71717a),
            edge_label_bg: Rgba8::from_hex_u32(0xffffff),
            presets: [
                Self::swatch(0xd9383a, 0.09, 0xa61f22),
                Self::swatch(0xe6730e, 0.10, 0xa84e00),
                Self::swatch(0xd4a017, 0.12, 0x8a6500),
                Self::swatch(0x1e8a4f, 0.09, 0x146338),
                Self::swatch(0x0b8576, 0.09, 0x075e54),
                Self::swatch(0x8a35d6, 0.09, 0x6421a3),
            ],
        }
    }

    pub fn dark() -> Self {
        Self {
            background: Rgba8::from_hex_u32(0x111113),
            dot_color: Rgba8::from_hex_u32(0x27272b),
            card_fill: Rgba8::from_hex_u32(0x1b1b1f),
            card_border: Rgba8::from_hex_u32(0x323238),
            group_fill: Rgba8::from_hex_u32(0x18181c),
            group_fill_opacity: 0.72,
            group_border: Rgba8::from_hex_u32(0x3a3a42),
            group_label_bg: Rgba8::from_hex_u32(0x242429),
            text: Rgba8::from_hex_u32(0xededed),
            muted: Rgba8::from_hex_u32(0x94949c),
            link: Rgba8::from_hex_u32(0x6ea8fe),
            edge: Rgba8::from_hex_u32(0x8e8e98),
            edge_label_bg: Rgba8::from_hex_u32(0x1b1b1f),
            presets: [
                Self::swatch(0xff6b6b, 0.14, 0xffa496),
                Self::swatch(0xf28a2e, 0.14, 0xf7b06e),
                Self::swatch(0xe8c547, 0.14, 0xf2da7e),
                Self::swatch(0x41bd74, 0.14, 0x7ae0a3),
                Self::swatch(0x4fc3b4, 0.14, 0x85dfd3),
                Self::swatch(0xb48ef5, 0.15, 0xd5bcf9),
            ],
        }
    }

    pub fn preset(&self, color: PresetColor) -> &PresetSwatch {
        &self.presets[color.index()]
    }

    pub fn resolve_color(&self, color: &CanvasColor) -> Rgba8 {
        match color {
            CanvasColor::Preset(preset) => self.preset(*preset).border,
            CanvasColor::Hex(_) => color.to_hex_rgba().unwrap_or(self.card_border),
        }
    }

    pub(super) fn resolve_swatch(&self, color: Option<&CanvasColor>, default_border: Rgba8) -> (Rgba8, Option<(Rgba8, f64)>, Rgba8) {
        match color {
            None => (default_border, None, self.text),
            Some(CanvasColor::Preset(preset)) => {
                let s = self.preset(*preset);
                (s.border, Some((s.fill, s.fill_opacity)), s.label)
            }
            Some(CanvasColor::Hex(_)) => {
                let rgba = color.and_then(CanvasColor::to_hex_rgba).unwrap_or(default_border);
                let tint_opacity = (0.12 * rgba.opacity()).clamp(0.04, 0.28);
                (rgba, Some((rgba, tint_opacity)), rgba)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum SvgTheme {
    Light,
    Dark,
    Custom(Box<ThemePalette>),
}

impl SvgTheme {
    pub fn palette(&self) -> ThemePalette {
        match self {
            SvgTheme::Light => ThemePalette::light(),
            SvgTheme::Dark => ThemePalette::dark(),
            SvgTheme::Custom(palette) => (**palette).clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum EdgeStrokeStyle {
    Solid,
    Dashed { dash: f64, gap: f64 },
}

#[derive(Debug, Clone, PartialEq)]
pub struct SvgRenderOptions {
    pub theme: SvgTheme,
    pub padding: f64,
    pub show_grid: bool,
    pub grid_spacing: f64,
    pub edge_stroke: EdgeStrokeStyle,
    pub dashed_edges: HashSet<EdgeId>,
    pub edge_stroke_width: f64,
    pub corner_radius: f64,
    pub font_family: String,
    pub font_size: f64,
    pub arrow_config: ArrowConfig,
    pub explicit_size: Option<(u32, u32)>,
}

impl Default for SvgRenderOptions {
    fn default() -> Self {
        Self {
            theme: SvgTheme::Light,
            padding: 40.0,
            show_grid: true,
            grid_spacing: 20.0,
            edge_stroke: EdgeStrokeStyle::Solid,
            dashed_edges: HashSet::new(),
            edge_stroke_width: 2.0,
            corner_radius: 8.0,
            font_family: "-apple-system, BlinkMacSystemFont, Helvetica Neue, Arial, sans-serif".to_owned(),
            font_size: 14.0,
            arrow_config: ArrowConfig::default(),
            explicit_size: None,
        }
    }
}

impl SvgRenderOptions {
    pub fn light() -> Self {
        Self::default()
    }

    pub fn dark() -> Self {
        Self {
            theme: SvgTheme::Dark,
            ..Self::default()
        }
    }
}
