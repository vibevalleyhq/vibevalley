//! One theme for the terminal and the rest of the UI, plus the persisted
//! settings that select and size it.

use gpui::{App, Global, Hsla, Rgba, SharedString};
use serde::{Deserialize, Serialize};
use vibevalley_files::HighlightKind;
use vibevalley_terminal::Rgb;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThemeChoice {
    #[default]
    Dark,
    Light,
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
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: ThemeChoice::Dark,
            mono_font: "Maple Mono NF CN".into(),
            terminal_font_size: 13.0,
            ui_font_size: 13.0,
            option_as_meta: true,
            scrollback_lines: 10_000,
            cursor_blink: true,
            sidebar_width: 280.0,
            sidebar_visible: true,
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
            foreground: hex(0xd4d7dd),
            background: hex(0x16181d),
            cursor: hex(0xe6e8ec),
            selection: hex(0x33415e),
            ansi: [
                hex(0x2a2e37),
                hex(0xf07178),
                hex(0x9ccc65),
                hex(0xffcb6b),
                hex(0x82aaff),
                hex(0xc792ea),
                hex(0x89ddff),
                hex(0xc8ccd4),
                hex(0x5c6370),
                hex(0xff8b92),
                hex(0xb9e986),
                hex(0xffd98e),
                hex(0xa3c1ff),
                hex(0xd9aef5),
                hex(0xa6e7ff),
                hex(0xffffff),
            ],
        };
        Palette {
            dark: true,
            bg: hsla(term.background),
            surface: h(0x1c1f26),
            elevated: h(0x242833),
            border: h(0x2c313c),
            text: hsla(term.foreground),
            muted: h(0x8b92a0),
            faint: h(0x5c6370),
            accent: h(0x6ea8fe),
            on_accent: h(0x0b1220),
            hover: alpha(h(0xffffff), 0.06),
            selected: alpha(h(0x6ea8fe), 0.18),
            danger: h(0xf07178),
            warning: h(0xffcb6b),
            success: h(0x9ccc65),
            info: h(0x89ddff),
            added_bg: alpha(h(0x9ccc65), 0.12),
            removed_bg: alpha(h(0xf07178), 0.12),
            added_emphasis: alpha(h(0x9ccc65), 0.32),
            removed_emphasis: alpha(h(0xf07178), 0.32),
            match_bg: alpha(h(0xffcb6b), 0.30),
            syntax: [
                h(0xc792ea),
                h(0x82aaff),
                h(0xffcb6b),
                h(0xd4d7dd),
                h(0x9cdcfe),
                h(0xf78c6c),
                h(0xc3e88d),
                h(0xf78c6c),
                h(0x6b7280),
                h(0x89ddff),
                h(0x8b92a0),
                h(0xffcb6b),
                h(0xf07178),
                h(0x82aaff),
                h(0xc792ea),
                h(0x89ddff),
            ],
            term,
        }
    }

    pub fn light() -> Self {
        let term = vibevalley_terminal::Theme {
            foreground: hex(0x24292f),
            background: hex(0xffffff),
            cursor: hex(0x24292f),
            selection: hex(0xc8dcff),
            ansi: [
                hex(0x24292f),
                hex(0xcf222e),
                hex(0x1a7f37),
                hex(0x9a6700),
                hex(0x0969da),
                hex(0x8250df),
                hex(0x1b7c83),
                hex(0x6e7781),
                hex(0x57606a),
                hex(0xa40e26),
                hex(0x2da44e),
                hex(0xbf8700),
                hex(0x218bff),
                hex(0xa475f9),
                hex(0x3192aa),
                hex(0x8c959f),
            ],
        };
        Palette {
            dark: false,
            bg: hsla(term.background),
            surface: h(0xf6f8fa),
            elevated: h(0xffffff),
            border: h(0xd8dee4),
            text: hsla(term.foreground),
            muted: h(0x57606a),
            faint: h(0x8c959f),
            accent: h(0x0969da),
            on_accent: h(0xffffff),
            hover: alpha(h(0x000000), 0.05),
            selected: alpha(h(0x0969da), 0.14),
            danger: h(0xcf222e),
            warning: h(0x9a6700),
            success: h(0x1a7f37),
            info: h(0x1b7c83),
            added_bg: alpha(h(0x2da44e), 0.14),
            removed_bg: alpha(h(0xcf222e), 0.10),
            added_emphasis: alpha(h(0x2da44e), 0.35),
            removed_emphasis: alpha(h(0xcf222e), 0.28),
            match_bg: alpha(h(0xbf8700), 0.30),
            syntax: [
                h(0xcf222e),
                h(0x8250df),
                h(0x953800),
                h(0x24292f),
                h(0x0550ae),
                h(0x0550ae),
                h(0x0a3069),
                h(0x0550ae),
                h(0x6e7781),
                h(0x24292f),
                h(0x57606a),
                h(0x953800),
                h(0x116329),
                h(0x0550ae),
                h(0x8250df),
                h(0x0969da),
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
            ThemeChoice::Dark => Some(gpui::WindowAppearance::Dark),
            ThemeChoice::Light => Some(gpui::WindowAppearance::Light),
            ThemeChoice::System => None,
        };
        cx.set_window_appearance(appearance_override);
        let system_dark = matches!(cx.window_appearance(), gpui::WindowAppearance::Dark | gpui::WindowAppearance::VibrantDark);
        let epoch = cx.try_global::<Ui>().map_or(0, |ui| ui.epoch + 1);
        let mut ui = Ui::new(settings, system_dark);
        ui.epoch = epoch;
        cx.set_global(ui);
        cx.refresh_windows();
    }
}
