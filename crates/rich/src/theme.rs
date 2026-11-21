//! VibeValley warm light/dark palettes synchronized with `apps/mac/ui/design/theme.json`.
//!
//! Supplies concrete colors for:
//! - `nsh_core` native UI elements (`UiPalette` & `AdaptivePalette`)
//! - `vibevalley-shiki` warm light/dark TextMate themes
//! - `vibevalley-pele` resolved SVG palettes (no CSS `var()` so `resvg` renders accurately)
//! - `vibevalley-canvas` warm light/dark JSON Canvas palettes
//! - `vibevalley-chart` resolved SVG chart palettes

use std::collections::BTreeMap;

use crate::engine::canvas::{PresetSwatch as CanvasPresetSwatch, Rgba8 as CanvasRgba8, ThemePalette as CanvasThemePalette};
use crate::engine::chart::ThemePalette as ChartThemePalette;
use nsh_core::prelude::{AdaptiveColor, Hsla, rgb, rgba};
use vibevalley_pele::ThemePalette as PeleThemePalette;
use vibevalley_shiki::{RawTheme, RawThemeSetting, RawTokenSettings, ScopePatternList, ThemeType};

/// Name of VibeValley's built-in warm light Shiki theme.
pub const SHIKI_LIGHT_THEME: &str = "vibevalley-warm-light";
/// Name of VibeValley's built-in warm dark Shiki theme.
pub const SHIKI_DARK_THEME: &str = "vibevalley-warm-dark";

/// Preferred UI font stack for native macOS SVG rendering (`resvg` loads system fonts).
pub const DIAGRAM_FONT_SANS: &str = "PingFang SC, -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif";
/// Preferred monospace font stack for code blocks and SVG diagrams.
pub const CODE_FONT_MONO: &str = "Menlo, ui-monospace, SFMono-Regular, monospace";

/// Resolved `nsh_core` colors for a single appearance mode (light or dark), matching `theme.json`.
#[derive(Debug, Clone, Copy)]
pub struct UiPalette {
    pub page: Hsla,
    pub side: Hsla,
    pub ink: Hsla,
    pub muted: Hsla,
    pub faint: Hsla,
    pub line: Hsla,
    pub hover: Hsla,
    pub selected: Hsla,
    pub accent: Hsla,
    pub leaf: Hsla,
    pub wheat: Hsla,
    pub berry: Hsla,
    pub water: Hsla,
    pub ok_soft: Hsla,
    pub ok_ink: Hsla,
    pub bad_soft: Hsla,
    pub warn_ink: Hsla,
    pub code_surface: Hsla,
    pub code_ink: Hsla,
    pub inline_code_bg: Hsla,
}

impl UiPalette {
    pub const LIGHT: Self = Self {
        page: rgb(0xfcfcfb).to_hsla(),
        side: rgb(0xf6f5f3).to_hsla(),
        ink: rgb(0x1c1917).to_hsla(),
        muted: rgb(0x5e5852).to_hsla(),
        faint: rgb(0x716a64).to_hsla(),
        line: rgba(0x1c19_1714).to_hsla(),
        hover: rgba(0x1c19_170a).to_hsla(),
        selected: rgba(0x1c19_1711).to_hsla(),
        accent: rgb(0x4d7a2a).to_hsla(),
        leaf: rgb(0x74a046).to_hsla(),
        wheat: rgb(0xe5a93c).to_hsla(),
        berry: rgb(0xa83a2c).to_hsla(),
        water: rgb(0x2c6aa3).to_hsla(),
        ok_soft: rgb(0xe8f0de).to_hsla(),
        ok_ink: rgb(0x3b6125).to_hsla(),
        bad_soft: rgb(0xf8e4e0).to_hsla(),
        warn_ink: rgb(0x94531f).to_hsla(),
        // Matches CodeBlock.tsx's `mix("ink", 0.06)` over warm `page`.
        code_surface: rgb(0xf3f1ee).to_hsla(),
        code_ink: rgb(0x1c1917).to_hsla(),
        inline_code_bg: rgba(0x1c19_170f).to_hsla(),
    };

    pub const DARK: Self = Self {
        page: rgb(0x151413).to_hsla(),
        side: rgb(0x1b1a18).to_hsla(),
        ink: rgb(0xecebe8).to_hsla(),
        muted: rgb(0xa9a49e).to_hsla(),
        faint: rgb(0x8b867f).to_hsla(),
        line: rgba(0xeceb_e81a).to_hsla(),
        hover: rgba(0xeceb_e80c).to_hsla(),
        selected: rgba(0xeceb_e814).to_hsla(),
        accent: rgb(0x7fae4f).to_hsla(),
        leaf: rgb(0x8dbb5c).to_hsla(),
        wheat: rgb(0xe5a93c).to_hsla(),
        berry: rgb(0xe47d6d).to_hsla(),
        water: rgb(0x6aa6dc).to_hsla(),
        ok_soft: rgb(0x26331c).to_hsla(),
        ok_ink: rgb(0xb0d488).to_hsla(),
        bad_soft: rgb(0x3e231e).to_hsla(),
        warn_ink: rgb(0xe0a062).to_hsla(),
        code_surface: rgb(0x1d1c1a).to_hsla(),
        code_ink: rgb(0xecebe8).to_hsla(),
        inline_code_bg: rgba(0xeceb_e814).to_hsla(),
    };

    pub const fn for_mode(dark: bool) -> Self {
        if dark { Self::DARK } else { Self::LIGHT }
    }
}

/// Adaptive light/dark color pairs for declarative `nsh_core` elements.
pub struct AdaptiveUi;

impl AdaptiveUi {
    pub const fn pair(light: Hsla, dark: Hsla) -> AdaptiveColor {
        AdaptiveColor { light, dark }
    }

    pub const PAGE: AdaptiveColor = Self::pair(UiPalette::LIGHT.page, UiPalette::DARK.page);
    pub const INK: AdaptiveColor = Self::pair(UiPalette::LIGHT.ink, UiPalette::DARK.ink);
    pub const MUTED: AdaptiveColor = Self::pair(UiPalette::LIGHT.muted, UiPalette::DARK.muted);
    pub const FAINT: AdaptiveColor = Self::pair(UiPalette::LIGHT.faint, UiPalette::DARK.faint);
    pub const LINE: AdaptiveColor = Self::pair(UiPalette::LIGHT.line, UiPalette::DARK.line);
    pub const HOVER: AdaptiveColor = Self::pair(UiPalette::LIGHT.hover, UiPalette::DARK.hover);
    pub const SELECTED: AdaptiveColor = Self::pair(UiPalette::LIGHT.selected, UiPalette::DARK.selected);
    pub const SIDE: AdaptiveColor = Self::pair(UiPalette::LIGHT.side, UiPalette::DARK.side);
    pub const ACCENT: AdaptiveColor = Self::pair(UiPalette::LIGHT.accent, UiPalette::DARK.accent);
    pub const LEAF: AdaptiveColor = Self::pair(UiPalette::LIGHT.leaf, UiPalette::DARK.leaf);
    pub const WATER: AdaptiveColor = Self::pair(UiPalette::LIGHT.water, UiPalette::DARK.water);
    pub const WHEAT: AdaptiveColor = Self::pair(UiPalette::LIGHT.wheat, UiPalette::DARK.wheat);
    pub const BERRY: AdaptiveColor = Self::pair(UiPalette::LIGHT.berry, UiPalette::DARK.berry);
    pub const OK_SOFT: AdaptiveColor = Self::pair(UiPalette::LIGHT.ok_soft, UiPalette::DARK.ok_soft);
    pub const OK_INK: AdaptiveColor = Self::pair(UiPalette::LIGHT.ok_ink, UiPalette::DARK.ok_ink);
    pub const BAD_SOFT: AdaptiveColor = Self::pair(UiPalette::LIGHT.bad_soft, UiPalette::DARK.bad_soft);
    pub const WARN_INK: AdaptiveColor = Self::pair(UiPalette::LIGHT.warn_ink, UiPalette::DARK.warn_ink);
    pub const CODE_SURFACE: AdaptiveColor = Self::pair(UiPalette::LIGHT.code_surface, UiPalette::DARK.code_surface);
    pub const INLINE_CODE_BG: AdaptiveColor = Self::pair(UiPalette::LIGHT.inline_code_bg, UiPalette::DARK.inline_code_bg);
}

/// Converts a `vibevalley_shiki::Rgba` color into an `nsh_core::Hsla` color.
pub(crate) fn shiki_rgba_to_hsla(c: vibevalley_shiki::Rgba) -> Hsla {
    let packed = (u32::from(c.r) << 24) | (u32::from(c.g) << 16) | (u32::from(c.b) << 8) | u32::from(c.a);
    rgba(packed).to_hsla()
}

/// Builds a resolved `vibevalley_pele::ThemePalette` matching `apps/mac/ui/design/theme.json`.
///
/// Always uses concrete hex colors (zero CSS `var()`/`color-mix()`) so `nsh_core::svg::rasterize`
/// renders text and shapes identically on macOS retina displays.
pub fn vv_pele_palette(dark: bool) -> PeleThemePalette {
    if dark {
        PeleThemePalette {
            bg: "#151413".to_owned(),
            fg: "#ecebe8".to_owned(),
            muted: "#a9a49e".to_owned(),
            line: "#a9a49e".to_owned(),
            surface: "#1b1a18".to_owned(),
            surface_alt: "#262421".to_owned(),
            border: "#5c5750".to_owned(),
            accent: "#7fae4f".to_owned(),
            critical: "#e47d6d".to_owned(),
            fg_on_light: "#1c1917".to_owned(),
            fg_on_dark: "#ecebe8".to_owned(),
            series: ["#6aa6dc", "#e5a93c", "#8dbb5c", "#e47d6d", "#72b7b2", "#c8a46e", "#b48ef5", "#f3b07a"].map(str::to_owned),
            radius: 6.0,
            font_family: DIAGRAM_FONT_SANS.to_owned(),
            font_family_mono: CODE_FONT_MONO.to_owned(),
            title_weight: "600".to_owned(),
            heading_weight: "600".to_owned(),
            bold_weight: "600".to_owned(),
        }
    } else {
        PeleThemePalette {
            bg: "#fcfcfb".to_owned(),
            fg: "#1c1917".to_owned(),
            muted: "#5e5852".to_owned(),
            line: "#5e5852".to_owned(),
            surface: "#f6f5f3".to_owned(),
            surface_alt: "#efeeeb".to_owned(),
            border: "#8a837b".to_owned(),
            accent: "#4d7a2a".to_owned(),
            critical: "#a83a2c".to_owned(),
            fg_on_light: "#1c1917".to_owned(),
            fg_on_dark: "#fffaf0".to_owned(),
            series: ["#2c6aa3", "#b8682a", "#4d7a2a", "#a83a2c", "#3b8a82", "#9b7550", "#7c52a8", "#74a046"].map(str::to_owned),
            radius: 6.0,
            font_family: DIAGRAM_FONT_SANS.to_owned(),
            font_family_mono: CODE_FONT_MONO.to_owned(),
            title_weight: "600".to_owned(),
            heading_weight: "600".to_owned(),
            bold_weight: "600".to_owned(),
        }
    }
}

/// Builds a resolved `crate::engine::chart::ThemePalette` matching `apps/mac/ui/design/theme.json`.
///
/// Uses concrete hex colors (zero CSS `var()`) and VibeValley's macOS UI font stack so
/// `resvg` renders chart axes, legends, and labels accurately.
pub fn vv_chart_palette(dark: bool) -> ChartThemePalette {
    let mut palette = if dark { ChartThemePalette::dark() } else { ChartThemePalette::light() };
    palette.font_family = DIAGRAM_FONT_SANS.to_owned();
    palette
}

/// Builds a warm VibeValley `crate::engine::canvas::ThemePalette` for JSON Canvas SVG rendering.
pub fn vv_canvas_palette(dark: bool) -> CanvasThemePalette {
    if dark {
        CanvasThemePalette {
            background: CanvasRgba8::from_hex_u32(0x151413),
            dot_color: CanvasRgba8::from_hex_u32(0x2b2926),
            card_fill: CanvasRgba8::from_hex_u32(0x1b1a18),
            card_border: CanvasRgba8::from_hex_u32(0x3a3632),
            group_fill: CanvasRgba8::from_hex_u32(0x201e1c),
            group_fill_opacity: 0.72,
            group_border: CanvasRgba8::from_hex_u32(0x46413b),
            group_label_bg: CanvasRgba8::from_hex_u32(0x282522),
            text: CanvasRgba8::from_hex_u32(0xecebe8),
            muted: CanvasRgba8::from_hex_u32(0xa9a49e),
            link: CanvasRgba8::from_hex_u32(0x6aa6dc),
            edge: CanvasRgba8::from_hex_u32(0x8b867f),
            edge_label_bg: CanvasRgba8::from_hex_u32(0x1b1a18),
            presets: [
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0xe47d6d),
                    fill: CanvasRgba8::from_hex_u32(0xe47d6d),
                    fill_opacity: 0.14,
                    label: CanvasRgba8::from_hex_u32(0xf2a99c),
                },
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0xe0a062),
                    fill: CanvasRgba8::from_hex_u32(0xe0a062),
                    fill_opacity: 0.14,
                    label: CanvasRgba8::from_hex_u32(0xf3be8b),
                },
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0xe5a93c),
                    fill: CanvasRgba8::from_hex_u32(0xe5a93c),
                    fill_opacity: 0.14,
                    label: CanvasRgba8::from_hex_u32(0xf0ca78),
                },
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0x8dbb5c),
                    fill: CanvasRgba8::from_hex_u32(0x8dbb5c),
                    fill_opacity: 0.14,
                    label: CanvasRgba8::from_hex_u32(0xb0d488),
                },
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0x6aa6dc),
                    fill: CanvasRgba8::from_hex_u32(0x6aa6dc),
                    fill_opacity: 0.14,
                    label: CanvasRgba8::from_hex_u32(0x9bc4ea),
                },
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0xb48ef5),
                    fill: CanvasRgba8::from_hex_u32(0xb48ef5),
                    fill_opacity: 0.15,
                    label: CanvasRgba8::from_hex_u32(0xd5bcf9),
                },
            ],
        }
    } else {
        CanvasThemePalette {
            background: CanvasRgba8::from_hex_u32(0xfcfcfb),
            dot_color: CanvasRgba8::from_hex_u32(0xdfdcd5),
            card_fill: CanvasRgba8::from_hex_u32(0xfffaf0),
            card_border: CanvasRgba8::from_hex_u32(0xd8d2c7),
            group_fill: CanvasRgba8::from_hex_u32(0xf6f5f3),
            group_fill_opacity: 0.7,
            group_border: CanvasRgba8::from_hex_u32(0xc8c0b4),
            group_label_bg: CanvasRgba8::from_hex_u32(0xefeeeb),
            text: CanvasRgba8::from_hex_u32(0x1c1917),
            muted: CanvasRgba8::from_hex_u32(0x5e5852),
            link: CanvasRgba8::from_hex_u32(0x2c6aa3),
            edge: CanvasRgba8::from_hex_u32(0x716a64),
            edge_label_bg: CanvasRgba8::from_hex_u32(0xfcfcfb),
            presets: [
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0xa83a2c),
                    fill: CanvasRgba8::from_hex_u32(0xa83a2c),
                    fill_opacity: 0.09,
                    label: CanvasRgba8::from_hex_u32(0x882c21),
                },
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0xb8682a),
                    fill: CanvasRgba8::from_hex_u32(0xb8682a),
                    fill_opacity: 0.10,
                    label: CanvasRgba8::from_hex_u32(0x94531f),
                },
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0xc48b20),
                    fill: CanvasRgba8::from_hex_u32(0xe5a93c),
                    fill_opacity: 0.14,
                    label: CanvasRgba8::from_hex_u32(0x8a5e0d),
                },
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0x4d7a2a),
                    fill: CanvasRgba8::from_hex_u32(0x74a046),
                    fill_opacity: 0.11,
                    label: CanvasRgba8::from_hex_u32(0x3b6125),
                },
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0x2c6aa3),
                    fill: CanvasRgba8::from_hex_u32(0x4f8fbd),
                    fill_opacity: 0.11,
                    label: CanvasRgba8::from_hex_u32(0x21527f),
                },
                CanvasPresetSwatch {
                    border: CanvasRgba8::from_hex_u32(0x7c52a8),
                    fill: CanvasRgba8::from_hex_u32(0x7c52a8),
                    fill_opacity: 0.09,
                    label: CanvasRgba8::from_hex_u32(0x5d3b82),
                },
            ],
        }
    }
}

fn rule(scopes: &[&str], fg: &str, font_style: Option<&str>) -> RawThemeSetting {
    RawThemeSetting {
        name: None,
        scope: Some(ScopePatternList::Multiple(scopes.iter().map(|s| (*s).to_owned()).collect())),
        settings: Some(RawTokenSettings {
            foreground: Some(fg.to_owned()),
            font_style: font_style.map(str::to_owned),
            ..RawTokenSettings::default()
        }),
    }
}

/// VibeValley warm light TextMate theme matching `apps/mac/ui/design/theme.json`.
pub fn vv_shiki_light_theme() -> RawTheme {
    let mut colors = BTreeMap::new();
    colors.insert("editor.foreground".to_owned(), "#1c1917".to_owned());
    colors.insert("editor.background".to_owned(), "#f3f1ee".to_owned());
    RawTheme {
        name: Some(SHIKI_LIGHT_THEME.to_owned()),
        display_name: Some("VibeValley Warm Light".to_owned()),
        theme_type: Some(ThemeType::Light),
        colors,
        token_colors: Some(vec![
            rule(&["comment", "punctuation.definition.comment"], "#716a64", Some("italic")),
            rule(
                &[
                    "keyword",
                    "storage",
                    "storage.type",
                    "storage.modifier",
                    "keyword.control",
                    "keyword.operator.word",
                ],
                "#a83a2c",
                None,
            ),
            rule(&["keyword.operator", "punctuation.accessor"], "#5e5852", None),
            rule(&["string", "punctuation.definition.string"], "#3b6125", None),
            rule(&["constant.character.escape", "string.regexp"], "#94531f", None),
            rule(
                &["constant.numeric", "constant.language", "constant.other", "support.constant"],
                "#b8682a",
                None,
            ),
            rule(
                &["entity.name.function", "support.function", "meta.function-call", "variable.function"],
                "#2c6aa3",
                None,
            ),
            rule(
                &[
                    "entity.name.type",
                    "entity.name.class",
                    "entity.name.struct",
                    "entity.name.enum",
                    "entity.name.trait",
                    "entity.other.inherited-class",
                    "support.type",
                    "support.class",
                ],
                "#6d4c96",
                None,
            ),
            rule(&["entity.name.tag", "support.type.property-name"], "#4d7a2a", None),
            rule(
                &[
                    "entity.other.attribute-name",
                    "variable.parameter",
                    "variable.other.property",
                    "variable.other.member",
                    "meta.attribute",
                ],
                "#7f5b3b",
                None,
            ),
            rule(
                &["variable.language", "storage.modifier.lifetime", "entity.name.lifetime"],
                "#94531f",
                Some("italic"),
            ),
            rule(&["markup.heading"], "#1c1917", Some("bold")),
            rule(&["markup.bold"], "#1c1917", Some("bold")),
            rule(&["markup.italic"], "#1c1917", Some("italic")),
            rule(&["markup.inline.raw", "markup.fenced_code"], "#4d7a2a", None),
            rule(&["markup.inserted", "diff.plus"], "#3b6125", None),
            rule(&["markup.deleted", "diff.minus"], "#a83a2c", None),
            rule(&["markup.changed", "meta.diff.range"], "#2c6aa3", None),
            rule(&["invalid"], "#a83a2c", Some("underline")),
        ]),
        ..RawTheme::default()
    }
}

/// VibeValley warm dark TextMate theme matching `apps/mac/ui/design/theme.json`.
pub fn vv_shiki_dark_theme() -> RawTheme {
    let mut colors = BTreeMap::new();
    colors.insert("editor.foreground".to_owned(), "#ecebe8".to_owned());
    colors.insert("editor.background".to_owned(), "#1d1c1a".to_owned());
    RawTheme {
        name: Some(SHIKI_DARK_THEME.to_owned()),
        display_name: Some("VibeValley Warm Dark".to_owned()),
        theme_type: Some(ThemeType::Dark),
        colors,
        token_colors: Some(vec![
            rule(&["comment", "punctuation.definition.comment"], "#8b867f", Some("italic")),
            rule(
                &[
                    "keyword",
                    "storage",
                    "storage.type",
                    "storage.modifier",
                    "keyword.control",
                    "keyword.operator.word",
                ],
                "#e47d6d",
                None,
            ),
            rule(&["keyword.operator", "punctuation.accessor"], "#a9a49e", None),
            rule(&["string", "punctuation.definition.string"], "#b0d488", None),
            rule(&["constant.character.escape", "string.regexp"], "#f3b07a", None),
            rule(
                &["constant.numeric", "constant.language", "constant.other", "support.constant"],
                "#e5a93c",
                None,
            ),
            rule(
                &["entity.name.function", "support.function", "meta.function-call", "variable.function"],
                "#6aa6dc",
                None,
            ),
            rule(
                &[
                    "entity.name.type",
                    "entity.name.class",
                    "entity.name.struct",
                    "entity.name.enum",
                    "entity.name.trait",
                    "entity.other.inherited-class",
                    "support.type",
                    "support.class",
                ],
                "#cbb2f0",
                None,
            ),
            rule(&["entity.name.tag", "support.type.property-name"], "#8dbb5c", None),
            rule(
                &[
                    "entity.other.attribute-name",
                    "variable.parameter",
                    "variable.other.property",
                    "variable.other.member",
                    "meta.attribute",
                ],
                "#d4b483",
                None,
            ),
            rule(
                &["variable.language", "storage.modifier.lifetime", "entity.name.lifetime"],
                "#e0a062",
                Some("italic"),
            ),
            rule(&["markup.heading"], "#ecebe8", Some("bold")),
            rule(&["markup.bold"], "#ecebe8", Some("bold")),
            rule(&["markup.italic"], "#ecebe8", Some("italic")),
            rule(&["markup.inline.raw", "markup.fenced_code"], "#8dbb5c", None),
            rule(&["markup.inserted", "diff.plus"], "#b0d488", None),
            rule(&["markup.deleted", "diff.minus"], "#e47d6d", None),
            rule(&["markup.changed", "meta.diff.range"], "#6aa6dc", None),
            rule(&["invalid"], "#e47d6d", Some("underline")),
        ]),
        ..RawTheme::default()
    }
}
