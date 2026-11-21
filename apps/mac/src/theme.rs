//! One theme for the terminal and the rest of the UI, plus the persisted
//! settings that select and size it.

use gpui_kit::{App, Global, Hsla, Rgba, SharedString};
use serde::{Deserialize, Serialize};
use vibevalley_files::HighlightKind;
use vibevalley_terminal::Rgb;

include!("theme_tokens.rs");

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
            mono_font: DEFAULT_MONO_FONT.into(),
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
            foreground: hex(TERM_DARK_FOREGROUND),
            background: hex(TERM_DARK_BACKGROUND),
            cursor: hex(TERM_DARK_CURSOR),
            selection: hex(TERM_DARK_SELECTION),
            ansi: TERM_DARK_ANSI.map(hex),
        };
        Palette {
            dark: true,
            bg: hsla(term.background),
            surface: h(DARK_SURFACE),
            elevated: h(DARK_ELEVATED),
            border: h(DARK_BORDER),
            text: hsla(term.foreground),
            muted: h(DARK_MUTED),
            faint: h(DARK_FAINT),
            accent: h(DARK_ACCENT),
            on_accent: h(DARK_ON_ACCENT),
            hover: alpha(h(DARK_HOVER_BASE), 0.07),
            selected: alpha(h(DARK_ACCENT), 0.20),
            danger: h(DARK_DANGER),
            warning: h(DARK_WARNING),
            success: h(DARK_SUCCESS),
            info: h(DARK_INFO),
            added_bg: alpha(h(DARK_ACCENT), 0.14),
            removed_bg: alpha(h(DARK_DANGER), 0.14),
            added_emphasis: alpha(h(DARK_ACCENT), 0.34),
            removed_emphasis: alpha(h(DARK_DANGER), 0.34),
            match_bg: alpha(h(DARK_MATCH_BASE), 0.30),
            syntax: SYNTAX_DARK.map(h),
            term,
        }
    }

    pub fn light() -> Self {
        let term = vibevalley_terminal::Theme {
            foreground: hex(TERM_LIGHT_FOREGROUND),
            background: hex(TERM_LIGHT_BACKGROUND),
            cursor: hex(TERM_LIGHT_CURSOR),
            selection: hex(TERM_LIGHT_SELECTION),
            ansi: TERM_LIGHT_ANSI.map(hex),
        };
        Palette {
            dark: false,
            bg: hsla(term.background),
            surface: h(LIGHT_SURFACE),
            elevated: h(LIGHT_ELEVATED),
            border: h(LIGHT_BORDER),
            text: hsla(term.foreground),
            muted: h(LIGHT_MUTED),
            faint: h(LIGHT_FAINT),
            accent: h(LIGHT_ACCENT),
            on_accent: h(LIGHT_ON_ACCENT),
            hover: alpha(h(LIGHT_HOVER_BASE), 0.055),
            selected: alpha(h(LIGHT_ACCENT), 0.14),
            danger: h(LIGHT_DANGER),
            warning: h(LIGHT_WARNING),
            success: h(LIGHT_SUCCESS),
            info: h(LIGHT_INFO),
            added_bg: alpha(h(LIGHT_ACCENT), 0.13),
            removed_bg: alpha(h(LIGHT_DANGER), 0.10),
            added_emphasis: alpha(h(LIGHT_ACCENT), 0.32),
            removed_emphasis: alpha(h(LIGHT_DANGER), 0.26),
            match_bg: alpha(h(LIGHT_MATCH_BASE), 0.34),
            syntax: SYNTAX_LIGHT.map(h),
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
