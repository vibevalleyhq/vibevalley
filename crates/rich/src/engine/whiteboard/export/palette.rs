use crate::engine::whiteboard::model::{PresenceColor, ShapeKind, WbFill};

pub(super) const FONT_SERIF: &str = "Georgia, Songti SC, STSong, Times New Roman, serif";

pub(super) struct SvgColors {
    pub(super) page: &'static str,
    pub(super) side: &'static str,
    pub(super) ink: &'static str,
    pub(super) muted: &'static str,
    pub(super) faint: &'static str,
    pub(super) line: &'static str,
    pub(super) grid_minor: &'static str,
    pub(super) grid_major: &'static str,
    pub(super) grid_dot: &'static str,
    pub(super) tl_start: &'static str,
    pub(super) tl_mid: &'static str,
    pub(super) tl_end: &'static str,
    pub(super) pill_bg: &'static str,
    pub(super) pill_ink: &'static str,
    pub(super) minor_bg: &'static str,
    pub(super) minor_border: &'static str,
    pub(super) highlight_bg: &'static str,
    pub(super) highlight_ink: &'static str,
    pub(super) arrow_default: &'static str,
    pub(super) arrow_label_bg: &'static str,
    pub(super) container_bg: &'static str,
    pub(super) container_border: &'static str,
    pub(super) container_header_bg: &'static str,
    pub(super) table_header_bg: &'static str,
    pub(super) shadow_color: &'static str,
    pub(super) shadow_opacity: &'static str,
}

impl SvgColors {
    const LIGHT: Self = Self {
        page: "#fcfcfb",
        side: "#f6f5f3",
        ink: "#1c1917",
        muted: "#5e5852",
        faint: "#716a64",
        line: "#ded8ce",
        grid_minor: "#f2efe9",
        grid_major: "#e6e2da",
        grid_dot: "#d6cfc5",
        tl_start: "#dd6f57",
        tl_mid: "#ec9658",
        tl_end: "#e5864c",
        pill_bg: "#d86c51",
        pill_ink: "#fefefe",
        minor_bg: "#fcfcfb",
        minor_border: "#d4cdc3",
        highlight_bg: "#e0ebf9",
        highlight_ink: "#2c5ea8",
        arrow_default: "#8a8178",
        arrow_label_bg: "#fcfcfb",
        container_bg: "#ffffff",
        container_border: "#e5e1db",
        container_header_bg: "#ebe6de",
        table_header_bg: "#f3f0eb",
        shadow_color: "#1c1917",
        shadow_opacity: "0.09",
    };

    const DARK: Self = Self {
        page: "#151413",
        side: "#1b1a18",
        ink: "#ecebe8",
        muted: "#a9a49e",
        faint: "#8b867f",
        line: "#3a3732",
        grid_minor: "#201e1b",
        grid_major: "#2b2824",
        grid_dot: "#3b3732",
        tl_start: "#e48369",
        tl_mid: "#ef9f64",
        tl_end: "#e8925c",
        pill_bg: "#d87158",
        pill_ink: "#fcfcfb",
        minor_bg: "#262421",
        minor_border: "#524d47",
        highlight_bg: "#263952",
        highlight_ink: "#8ec1f2",
        arrow_default: "#9e978f",
        arrow_label_bg: "#1b1a18",
        container_bg: "#1d1c19",
        container_border: "#3a3732",
        container_header_bg: "#262420",
        table_header_bg: "#23211e",
        shadow_color: "#000000",
        shadow_opacity: "0.34",
    };

    pub(super) fn for_mode(dark: bool) -> &'static Self {
        if dark { &Self::DARK } else { &Self::LIGHT }
    }
}

pub(super) fn fill_tone_hex(fill: &WbFill, dark: bool) -> (&str, &str, &str) {
    if dark {
        match fill {
            WbFill::Default => ("#23211e", "#3e3a35", "#ecebe8"),
            WbFill::Sun => ("#4a3d1f", "#8a6f2e", "#f9ecc2"),
            WbFill::Peach => ("#4d3121", "#9e633f", "#fadbc4"),
            WbFill::Leaf => ("#253b25", "#4d7a44", "#d7eec7"),
            WbFill::Water => ("#1f344b", "#4a7bad", "#d2e7fc"),
            WbFill::Lavender => ("#322848", "#7861aa", "#e7defc"),
            WbFill::Berry => ("#492825", "#a85b52", "#fad8d2"),
            WbFill::Side => ("#1b1a18", "#383530", "#ecebe8"),
            WbFill::Custom(c) => (c.as_str(), "#4a4640", "#ecebe8"),
        }
    } else {
        match fill {
            WbFill::Default => ("#fffdf9", "#ded8ce", "#1c1917"),
            WbFill::Sun => ("#ffe57f", "#e8c456", "#1c1917"),
            WbFill::Peach => ("#f9ba7b", "#e29a57", "#1c1917"),
            WbFill::Leaf => ("#cce6b6", "#9ac17a", "#1c1917"),
            WbFill::Water => ("#cde2f8", "#94bae2", "#1c1917"),
            WbFill::Lavender => ("#dfd4f8", "#b39de4", "#1c1917"),
            WbFill::Berry => ("#f8d0ca", "#de9a90", "#1c1917"),
            WbFill::Side => ("#f6f5f3", "#d8d2c7", "#1c1917"),
            WbFill::Custom(c) => (c.as_str(), "#cfc9bf", "#1c1917"),
        }
    }
}

pub(super) fn shape_tone_hex(shape: ShapeKind, fill: &WbFill, dark: bool) -> (&str, &str, &str) {
    if shape == ShapeKind::Sticky {
        if dark {
            return match fill {
                WbFill::Sun => ("#5b4814", "#9d7b22", "#fceeae"),
                WbFill::Peach => ("#59351a", "#ab6b39", "#ffe2c7"),
                WbFill::Leaf => ("#1f4a24", "#458c4d", "#d7f6d9"),
                WbFill::Water => ("#1b3b5c", "#4482bf", "#d8ecff"),
                WbFill::Lavender => ("#382b59", "#7c63bd", "#e9e0ff"),
                WbFill::Berry => ("#542239", "#a64d75", "#ffdce9"),
                WbFill::Side => ("#2d2c28", "#47453f", "#ecebe8"),
                WbFill::Default | WbFill::Custom(_) => fill_tone_hex(fill, dark),
            };
        }
        return match fill {
            WbFill::Sun => ("#f7d02c", "#e0b918", "#1c1917"),
            WbFill::Peach => ("#f8b16e", "#de9450", "#241911"),
            WbFill::Leaf => ("#6ed16f", "#55b856", "#152015"),
            WbFill::Water => ("#69aef4", "#4f95dc", "#141d26"),
            WbFill::Lavender => ("#b39bf2", "#957bd9", "#1d172c"),
            WbFill::Berry => ("#f080ae", "#d76594", "#23141c"),
            WbFill::Side => ("#d8d6d2", "#c5c2bc", "#1c1917"),
            WbFill::Default | WbFill::Custom(_) => fill_tone_hex(fill, dark),
        };
    }
    if matches!(shape, ShapeKind::Pill | ShapeKind::Rounded) {
        if dark {
            return match fill {
                WbFill::Side => ("#2c2b28", "#45423d", "#ecebe8"),
                WbFill::Lavender => ("#3d2e66", "#7d64c2", "#efeaff"),
                _ => fill_tone_hex(fill, dark),
            };
        }
        return match fill {
            WbFill::Side => ("#d6d5d2", "#c4c2be", "#1c1917"),
            WbFill::Lavender => ("#b5a2f2", "#947de0", "#1c1917"),
            _ => fill_tone_hex(fill, dark),
        };
    }
    fill_tone_hex(fill, dark)
}

pub(super) fn presence_hex(color: PresenceColor, dark: bool) -> &'static str {
    if dark {
        match color {
            PresenceColor::Coral => "#d96d3d",
            PresenceColor::Teal => "#3ab2a4",
            PresenceColor::Blue => "#6aa6dc",
            PresenceColor::Leaf => "#8dbb5c",
            PresenceColor::Wheat => "#e5a93c",
            PresenceColor::Lavender => "#b48ef5",
        }
    } else {
        match color {
            PresenceColor::Coral => "#c8561f",
            PresenceColor::Teal => "#1a7f74",
            PresenceColor::Blue => "#2c6aa3",
            PresenceColor::Leaf => "#4d7a2a",
            PresenceColor::Wheat => "#c48b20",
            PresenceColor::Lavender => "#7c52a8",
        }
    }
}
