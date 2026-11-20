//! One theme for the terminal and the rest of the UI, plus the persisted
//! settings that select and size it.

use gpui_kit::{App, Global, Hsla, Rgba, SharedString};
use serde::{Deserialize, Serialize};
use vibevalley_files::HighlightKind;
use vibevalley_terminal::Rgb;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThemeChoice {
    Dark,
    Light,
    #[default]
    System,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub theme: ThemeChoice,
    pub mono_font: String,
    pub terminal_font_size: f32,
    pub ui_font_size: f32,
    /// Option sends ESC-prefixed keys instead of composing characters.
    pub option_as_meta: bool,
    pub scrollback_lines: usize,
    pub cursor_blink: bool,
    pub sidebar_width: f32,
    pub sidebar_visible: bool,
    pub inspector_open: bool,
    pub inspector_width: f32,
    pub last_route: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: ThemeChoice::System,
            mono_font: "Maple Mono NF CN".into(),
            terminal_font_size: 13.0,
            ui_font_size: 13.0,
            option_as_meta: true,
            scrollback_lines: 10_000,
            cursor_blink: true,
            sidebar_width: 280.0,
            sidebar_visible: true,
            inspector_open: true,
            inspector_width: 280.0,
            last_route: None,
        }
    }
}

pub const SETTINGS_KEY: &str = "app.settings";

pub fn hsla(c: Rgb) -> Hsla {
    Rgba {
        r: c.0 as f32 / 255.0,
        g: c.1 as f32 / 255.0,
        b: c.2 as f32 / 255.0,
        a: 1.0,
    }
    .into()
}

const fn hex(v: u32) -> Rgb {
    Rgb((v >> 16) as u8, (v >> 8) as u8, v as u8)
}

fn h(v: u32) -> Hsla {
    hsla(hex(v))
}

fn alpha(c: Hsla, a: f32) -> Hsla {
    Hsla { a, ..c }
}

#[derive(Debug, Clone)]
#[allow(dead_code, reason = "the full token set; not every surface uses every token yet")]
pub struct Palette {
    pub dark: bool,
    /// Pane background; equals the terminal background.
    pub bg: Hsla,
    /// Sidebars, tab bars, the rail.
    pub surface: Hsla,
    /// Popovers and modals.
    pub elevated: Hsla,
    pub border: Hsla,
    pub text: Hsla,
    pub muted: Hsla,
    pub faint: Hsla,
    pub accent: Hsla,
    pub on_accent: Hsla,
    pub hover: Hsla,
    pub selected: Hsla,
    pub danger: Hsla,
    pub warning: Hsla,
    pub success: Hsla,
    pub info: Hsla,
    pub added_bg: Hsla,
    pub removed_bg: Hsla,
    pub added_emphasis: Hsla,
    pub removed_emphasis: Hsla,
    pub match_bg: Hsla,
    syntax: [Hsla; 16],
    pub term: vibevalley_terminal::Theme,
}

impl Palette {
    pub fn dark() -> Self {
        let term = vibevalley_terminal::Theme {
            foreground: hex(0xecebe8),
            background: hex(0x151413),
            cursor: hex(0xecebe8),
            selection: hex(0x2d3746),
            ansi: [
                hex(0x282623),
                hex(0xe47d6d),
                hex(0x7fae4f),
                hex(0xe5a93c),
                hex(0x6aa6dc),
                hex(0xc9a7eb),
                hex(0x5bbfb2),
                hex(0xd6d3ce),
                hex(0x7d7871),
                hex(0xf09a8c),
                hex(0x9ac56d),
                hex(0xf0be63),
                hex(0x8bc0ed),
                hex(0xdcc2f5),
                hex(0x7fd4c9),
                hex(0xf6f5f3),
            ],
        };
        Palette {
            dark: true,
            bg: hsla(term.background),
            surface: h(0x1b1a18),
            elevated: h(0x21201d),
            border: h(0x2d2b27),
            text: hsla(term.foreground),
            muted: h(0xa9a49e),
            faint: h(0x8b867f),
            accent: h(0x7fae4f),
            on_accent: h(0x151413),
            hover: alpha(h(0xecebe8), 0.07),
            selected: alpha(h(0x7fae4f), 0.20),
            danger: h(0xe47d6d),
            warning: h(0xe5a93c),
            success: h(0x7fae4f),
            info: h(0x6aa6dc),
            added_bg: alpha(h(0x7fae4f), 0.14),
            removed_bg: alpha(h(0xe47d6d), 0.14),
            added_emphasis: alpha(h(0x7fae4f), 0.34),
            removed_emphasis: alpha(h(0xe47d6d), 0.34),
            match_bg: alpha(h(0xe5a93c), 0.30),
            syntax: [
                h(0xc9a7eb),
                h(0x6aa6dc),
                h(0xf0be63),
                h(0xecebe8),
                h(0x8bc0ed),
                h(0xe5a93c),
                h(0x7fae4f),
                h(0xf0be63),
                h(0x8b867f),
                h(0x5bbfb2),
                h(0xa9a49e),
                h(0xf0be63),
                h(0xe47d6d),
                h(0x6aa6dc),
                h(0xc9a7eb),
                h(0x5bbfb2),
            ],
            term,
        }
    }

    pub fn light() -> Self {
        let term = vibevalley_terminal::Theme {
            foreground: hex(0x1c1917),
            background: hex(0xfcfcfb),
            cursor: hex(0x1c1917),
            selection: hex(0xd6e4f2),
            ansi: [
                hex(0x1c1917),
                hex(0xa83a2c),
                hex(0x3f7329),
                hex(0xb45d0e),
                hex(0x2c6aa3),
                hex(0x7e42b8),
                hex(0x1f7a72),
                hex(0x5e5852),
                hex(0x716a64),
                hex(0xc74d3d),
                hex(0x538c38),
                hex(0xcf741c),
                hex(0x3b80bf),
                hex(0x9658d1),
                hex(0x28948a),
                hex(0xa9a49e),
            ],
        };
        Palette {
            dark: false,
            bg: hsla(term.background),
            surface: h(0xf6f5f3),
            elevated: h(0xfcfcfb),
            border: h(0xe6e4e0),
            text: hsla(term.foreground),
            muted: h(0x5e5852),
            faint: h(0x716a64),
            accent: h(0x4d7a2a),
            on_accent: h(0xfcfcfb),
            hover: alpha(h(0x1c1917), 0.055),
            selected: alpha(h(0x4d7a2a), 0.14),
            danger: h(0xa83a2c),
            warning: h(0xb45d0e),
            success: h(0x3f7329),
            info: h(0x2c6aa3),
            added_bg: alpha(h(0x4d7a2a), 0.13),
            removed_bg: alpha(h(0xa83a2c), 0.10),
            added_emphasis: alpha(h(0x4d7a2a), 0.32),
            removed_emphasis: alpha(h(0xa83a2c), 0.26),
            match_bg: alpha(h(0xe5a93c), 0.34),
            syntax: [
                h(0xa83a2c),
                h(0x7e42b8),
                h(0x94531f),
                h(0x1c1917),
                h(0x2c6aa3),
                h(0x2c6aa3),
                h(0x3f7329),
                h(0x2c6aa3),
                h(0x716a64),
                h(0x1c1917),
                h(0x5e5852),
                h(0x94531f),
                h(0x3f7329),
                h(0x2c6aa3),
                h(0x7e42b8),
                h(0x1f7a72),
            ],
            term,
        }
    }

    pub fn syntax(&self, kind: HighlightKind) -> Hsla {
        use HighlightKind::*;
        let index = match kind {
            Keyword => 0,
            Function => 1,
            Type => 2,
            Variable => 3,
            Property => 4,
            Constant => 5,
            String => 6,
            Number => 7,
            Comment => 8,
            Operator => 9,
            Punctuation => 10,
            Attribute => 11,
            Tag => 12,
            Heading => 13,
            Emphasis => 14,
            Link => 15,
        };
        self.syntax[index]
    }
}

/// App-wide look, readable from any render through `Ui::get(cx)`.
pub struct Ui {
    pub settings: Settings,
    pub colors: Palette,
    /// Bumped on every change so cached shaped text knows to rebuild.
    pub epoch: u64,
}

impl Global for Ui {}

impl Ui {
    pub fn new(settings: Settings, system_dark: bool) -> Self {
        let dark = match settings.theme {
            ThemeChoice::Dark => true,
            ThemeChoice::Light => false,
            ThemeChoice::System => system_dark,
        };
        let colors = if dark { Palette::dark() } else { Palette::light() };
        Ui { settings, colors, epoch: 0 }
    }

    pub fn get(cx: &App) -> &Ui {
        cx.global::<Ui>()
    }

    pub fn mono(&self) -> SharedString {
        self.settings.mono_font.clone().into()
    }

    /// Applies new settings everywhere.
    pub fn apply(settings: Settings, cx: &mut App) {
        let appearance_override = match settings.theme {
            ThemeChoice::Dark => Some(gpui_kit::WindowAppearance::Dark),
            ThemeChoice::Light => Some(gpui_kit::WindowAppearance::Light),
            ThemeChoice::System => None,
        };
        cx.set_window_appearance(appearance_override);
        let system_dark = matches!(
            cx.window_appearance(),
            gpui_kit::WindowAppearance::Dark | gpui_kit::WindowAppearance::VibrantDark
        );
        let epoch = cx.try_global::<Ui>().map_or(0, |ui| ui.epoch + 1);
        let mut ui = Ui::new(settings, system_dark);
        ui.epoch = epoch;
        cx.set_global(ui);
        cx.refresh_windows();
    }
}
