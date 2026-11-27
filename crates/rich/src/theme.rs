//! VibeValley warm light/dark palettes synchronized with `apps/mac/ui/design/theme.json`.
//!
//! Supplies concrete colors for:
//! - `nsh_core` native UI elements (`UiPalette` & `AdaptivePalette`)
//! - `vibevalley-shiki` warm light/dark TextMate themes
//! - `vibevalley-pele` resolved SVG palettes (no CSS `var()` so `resvg` renders accurately)

use std::collections::BTreeMap;

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
    let (bg, fg, muted, surface, surface_alt, border, accent, critical, fg_on_dark, series) = if dark {
        (
            "#151413",
            "#ecebe8",
            "#a9a49e",
            "#1b1a18",
            "#262421",
            "#5c5750",
            "#7fae4f",
            "#e47d6d",
            "#ecebe8",
            ["#6aa6dc", "#e5a93c", "#8dbb5c", "#e47d6d", "#72b7b2", "#c8a46e", "#b48ef5", "#f3b07a"],
        )
    } else {
        (
            "#fcfcfb",
            "#1c1917",
            "#5e5852",
            "#f6f5f3",
            "#efeeeb",
            "#8a837b",
            "#4d7a2a",
            "#a83a2c",
            "#fffaf0",
            ["#2c6aa3", "#b8682a", "#4d7a2a", "#a83a2c", "#3b8a82", "#9b7550", "#7c52a8", "#74a046"],
        )
    };
    PeleThemePalette {
        bg: bg.to_owned(),
        fg: fg.to_owned(),
        muted: muted.to_owned(),
        line: muted.to_owned(),
        surface: surface.to_owned(),
        surface_alt: surface_alt.to_owned(),
        border: border.to_owned(),
        accent: accent.to_owned(),
        critical: critical.to_owned(),
        fg_on_light: "#1c1917".to_owned(),
        fg_on_dark: fg_on_dark.to_owned(),
        series: series.map(str::to_owned),
        radius: 6.0,
        font_family: DIAGRAM_FONT_SANS.to_owned(),
        font_family_mono: CODE_FONT_MONO.to_owned(),
        title_weight: "600".to_owned(),
        heading_weight: "600".to_owned(),
        bold_weight: "600".to_owned(),
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

struct ShikiThemeColors {
    name: &'static str,
    display_name: &'static str,
    theme_type: ThemeType,
    editor_fg: &'static str,
    editor_bg: &'static str,
    comment: &'static str,
    keyword: &'static str,
    operator: &'static str,
    string: &'static str,
    escape: &'static str,
    constant: &'static str,
    function: &'static str,
    ty: &'static str,
    tag: &'static str,
    attribute: &'static str,
    language_var: &'static str,
    markup_text: &'static str,
    markup_code: &'static str,
    markup_inserted: &'static str,
    markup_deleted: &'static str,
    markup_changed: &'static str,
    invalid: &'static str,
}

fn build_shiki_theme(c: &ShikiThemeColors) -> RawTheme {
    let mut colors = BTreeMap::new();
    colors.insert("editor.foreground".to_owned(), c.editor_fg.to_owned());
    colors.insert("editor.background".to_owned(), c.editor_bg.to_owned());
    RawTheme {
        name: Some(c.name.to_owned()),
        display_name: Some(c.display_name.to_owned()),
        theme_type: Some(c.theme_type),
        colors,
        token_colors: Some(vec![
            rule(&["comment", "punctuation.definition.comment"], c.comment, Some("italic")),
            rule(
                &[
                    "keyword",
                    "storage",
                    "storage.type",
                    "storage.modifier",
                    "keyword.control",
                    "keyword.operator.word",
                ],
                c.keyword,
                None,
            ),
            rule(&["keyword.operator", "punctuation.accessor"], c.operator, None),
            rule(&["string", "punctuation.definition.string"], c.string, None),
            rule(&["constant.character.escape", "string.regexp"], c.escape, None),
            rule(
                &["constant.numeric", "constant.language", "constant.other", "support.constant"],
                c.constant,
                None,
            ),
            rule(
                &["entity.name.function", "support.function", "meta.function-call", "variable.function"],
                c.function,
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
                c.ty,
                None,
            ),
            rule(&["entity.name.tag", "support.type.property-name"], c.tag, None),
            rule(
                &[
                    "entity.other.attribute-name",
                    "variable.parameter",
                    "variable.other.property",
                    "variable.other.member",
                    "meta.attribute",
                ],
                c.attribute,
                None,
            ),
            rule(
                &["variable.language", "storage.modifier.lifetime", "entity.name.lifetime"],
                c.language_var,
                Some("italic"),
            ),
            rule(&["markup.heading"], c.markup_text, Some("bold")),
            rule(&["markup.bold"], c.markup_text, Some("bold")),
            rule(&["markup.italic"], c.markup_text, Some("italic")),
            rule(&["markup.inline.raw", "markup.fenced_code"], c.markup_code, None),
            rule(&["markup.inserted", "diff.plus"], c.markup_inserted, None),
            rule(&["markup.deleted", "diff.minus"], c.markup_deleted, None),
            rule(&["markup.changed", "meta.diff.range"], c.markup_changed, None),
            rule(&["invalid"], c.invalid, Some("underline")),
        ]),
        ..RawTheme::default()
    }
}

/// VibeValley warm light TextMate theme matching `apps/mac/ui/design/theme.json`.
pub fn vv_shiki_light_theme() -> RawTheme {
    build_shiki_theme(&ShikiThemeColors {
        name: SHIKI_LIGHT_THEME,
        display_name: "VibeValley Warm Light",
        theme_type: ThemeType::Light,
        editor_fg: "#1c1917",
        editor_bg: "#f3f1ee",
        comment: "#716a64",
        keyword: "#a83a2c",
        operator: "#5e5852",
        string: "#3b6125",
        escape: "#94531f",
        constant: "#b8682a",
        function: "#2c6aa3",
        ty: "#6d4c96",
        tag: "#4d7a2a",
        attribute: "#7f5b3b",
        language_var: "#94531f",
        markup_text: "#1c1917",
        markup_code: "#4d7a2a",
        markup_inserted: "#3b6125",
        markup_deleted: "#a83a2c",
        markup_changed: "#2c6aa3",
        invalid: "#a83a2c",
    })
}

/// VibeValley warm dark TextMate theme matching `apps/mac/ui/design/theme.json`.
pub fn vv_shiki_dark_theme() -> RawTheme {
    build_shiki_theme(&ShikiThemeColors {
        name: SHIKI_DARK_THEME,
        display_name: "VibeValley Warm Dark",
        theme_type: ThemeType::Dark,
        editor_fg: "#ecebe8",
        editor_bg: "#1d1c1a",
        comment: "#8b867f",
        keyword: "#e47d6d",
        operator: "#a9a49e",
        string: "#b0d488",
        escape: "#f3b07a",
        constant: "#e5a93c",
        function: "#6aa6dc",
        ty: "#cbb2f0",
        tag: "#8dbb5c",
        attribute: "#d4b483",
        language_var: "#e0a062",
        markup_text: "#ecebe8",
        markup_code: "#8dbb5c",
        markup_inserted: "#b0d488",
        markup_deleted: "#e47d6d",
        markup_changed: "#6aa6dc",
        invalid: "#e47d6d",
    })
}
