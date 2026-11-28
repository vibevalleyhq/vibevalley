use nsh_core::prelude::{Hsla, rgb, rgba};

use crate::engine::whiteboard::model::{Presence, PresenceColor, ShapeKind, WbFill};
use crate::theme::UiPalette;

#[derive(Debug, Clone, Copy)]
pub struct FillTone {
    pub fill: Hsla,
    pub border: Hsla,
    pub ink: Hsla,
}

#[derive(Debug, Clone, Copy)]
pub struct WhiteboardPalette {
    pub page: Hsla,
    pub side: Hsla,
    pub ink: Hsla,
    pub muted: Hsla,
    pub faint: Hsla,
    pub line: Hsla,
    pub accent: Hsla,
    pub grid_minor: Hsla,
    pub grid_major: Hsla,
    pub grid_dot: Hsla,
    pub timeline_start: Hsla,
    pub timeline_mid: Hsla,
    pub timeline_end: Hsla,
    pub timeline_halo: Hsla,
    pub pill_bg: Hsla,
    pub pill_ink: Hsla,
    pub minor_node_bg: Hsla,
    pub minor_node_border: Hsla,
    pub highlight_bg: Hsla,
    pub highlight_ink: Hsla,
    pub arrow_default: Hsla,
    pub arrow_label_bg: Hsla,
    pub container_bg: Hsla,
    pub container_border: Hsla,
    pub container_header_bg: Hsla,
    pub table_header_bg: Hsla,
    pub selection: Hsla,
    pub selection_soft: Hsla,
    pub snap_guide: Hsla,
    pub card_shadow: Hsla,
    pub tone_default: FillTone,
    pub tone_sun: FillTone,
    pub tone_peach: FillTone,
    pub tone_leaf: FillTone,
    pub tone_water: FillTone,
    pub tone_lavender: FillTone,
    pub tone_berry: FillTone,
    pub tone_side: FillTone,
    pub sticky_sun: FillTone,
    pub sticky_peach: FillTone,
    pub sticky_leaf: FillTone,
    pub sticky_water: FillTone,
    pub sticky_lavender: FillTone,
    pub sticky_berry: FillTone,
    pub sticky_side: FillTone,
    pub pill_side: FillTone,
    pub pill_lavender: FillTone,
    pub presence_coral: Hsla,
    pub presence_teal: Hsla,
    pub presence_blue: Hsla,
    pub presence_leaf: Hsla,
    pub presence_wheat: Hsla,
    pub presence_lavender: Hsla,
}

impl WhiteboardPalette {
    pub fn for_mode(dark: bool) -> Self {
        if dark { Self::dark() } else { Self::light() }
    }

    pub fn light() -> Self {
        let ui = UiPalette::LIGHT;
        Self {
            page: ui.page,
            side: ui.side,
            ink: ui.ink,
            muted: ui.muted,
            faint: ui.faint,
            line: ui.line,
            accent: ui.accent,
            grid_minor: rgba(0x1c19_170b).to_hsla(),
            grid_major: rgba(0x1c19_1716).to_hsla(),
            grid_dot: rgba(0x1c19_1726).to_hsla(),
            timeline_start: rgb(0xdd6f57).to_hsla(),
            timeline_mid: rgb(0xec9658).to_hsla(),
            timeline_end: rgb(0xe5864c).to_hsla(),
            timeline_halo: rgba(0xfcfc_fbcc).to_hsla(),
            pill_bg: rgb(0xd86c51).to_hsla(),
            pill_ink: rgb(0xfefefe).to_hsla(),
            minor_node_bg: rgb(0xfcfcfb).to_hsla(),
            minor_node_border: rgb(0xd4cdc3).to_hsla(),
            highlight_bg: rgb(0xe0ebf9).to_hsla(),
            highlight_ink: rgb(0x2c5ea8).to_hsla(),
            arrow_default: rgb(0x8a8178).to_hsla(),
            arrow_label_bg: rgba(0xfcfc_fbe8).to_hsla(),
            container_bg: rgba(0xffff_ffb8).to_hsla(),
            container_border: rgb(0xe5e1db).to_hsla(),
            container_header_bg: rgb(0xebe6de).to_hsla(),
            table_header_bg: rgb(0xf3f0eb).to_hsla(),
            selection: rgb(0x2c6aa3).to_hsla(),
            selection_soft: rgba(0x2c6a_a320).to_hsla(),
            snap_guide: rgb(0xdd6f57).to_hsla(),
            card_shadow: rgba(0x1c19_171a).to_hsla(),
            tone_default: FillTone {
                fill: rgb(0xfffdf9).to_hsla(),
                border: rgb(0xded8ce).to_hsla(),
                ink: ui.ink,
            },
            tone_sun: FillTone {
                fill: rgb(0xffe57f).to_hsla(),
                border: rgb(0xe8c456).to_hsla(),
                ink: rgb(0x1c1917).to_hsla(),
            },
            tone_peach: FillTone {
                fill: rgb(0xf9ba7b).to_hsla(),
                border: rgb(0xe29a57).to_hsla(),
                ink: rgb(0x1c1917).to_hsla(),
            },
            tone_leaf: FillTone {
                fill: rgb(0xcce6b6).to_hsla(),
                border: rgb(0x9ac17a).to_hsla(),
                ink: rgb(0x1c1917).to_hsla(),
            },
            tone_water: FillTone {
                fill: rgb(0xcde2f8).to_hsla(),
                border: rgb(0x94bae2).to_hsla(),
                ink: rgb(0x1c1917).to_hsla(),
            },
            tone_lavender: FillTone {
                fill: rgb(0xdfd4f8).to_hsla(),
                border: rgb(0xb39de4).to_hsla(),
                ink: rgb(0x1c1917).to_hsla(),
            },
            tone_berry: FillTone {
                fill: rgb(0xf8d0ca).to_hsla(),
                border: rgb(0xde9a90).to_hsla(),
                ink: rgb(0x1c1917).to_hsla(),
            },
            tone_side: FillTone {
                fill: rgb(0xf6f5f3).to_hsla(),
                border: rgb(0xd8d2c7).to_hsla(),
                ink: ui.ink,
            },
            sticky_sun: FillTone {
                fill: rgb(0xf7d02c).to_hsla(),
                border: rgb(0xe0b918).to_hsla(),
                ink: rgb(0x1c1917).to_hsla(),
            },
            sticky_peach: FillTone {
                fill: rgb(0xf8b16e).to_hsla(),
                border: rgb(0xde9450).to_hsla(),
                ink: rgb(0x241911).to_hsla(),
            },
            sticky_leaf: FillTone {
                fill: rgb(0x6ed16f).to_hsla(),
                border: rgb(0x55b856).to_hsla(),
                ink: rgb(0x152015).to_hsla(),
            },
            sticky_water: FillTone {
                fill: rgb(0x69aef4).to_hsla(),
                border: rgb(0x4f95dc).to_hsla(),
                ink: rgb(0x141d26).to_hsla(),
            },
            sticky_lavender: FillTone {
                fill: rgb(0xb39bf2).to_hsla(),
                border: rgb(0x957bd9).to_hsla(),
                ink: rgb(0x1d172c).to_hsla(),
            },
            sticky_berry: FillTone {
                fill: rgb(0xf080ae).to_hsla(),
                border: rgb(0xd76594).to_hsla(),
                ink: rgb(0x23141c).to_hsla(),
            },
            sticky_side: FillTone {
                fill: rgb(0xd8d6d2).to_hsla(),
                border: rgb(0xc5c2bc).to_hsla(),
                ink: rgb(0x1c1917).to_hsla(),
            },
            pill_side: FillTone {
                fill: rgb(0xd6d5d2).to_hsla(),
                border: rgb(0xc4c2be).to_hsla(),
                ink: rgb(0x1c1917).to_hsla(),
            },
            pill_lavender: FillTone {
                fill: rgb(0xb5a2f2).to_hsla(),
                border: rgb(0x947de0).to_hsla(),
                ink: rgb(0x1c1917).to_hsla(),
            },
            presence_coral: rgb(0xc8561f).to_hsla(),
            presence_teal: rgb(0x1a7f74).to_hsla(),
            presence_blue: rgb(0x2c6aa3).to_hsla(),
            presence_leaf: rgb(0x4d7a2a).to_hsla(),
            presence_wheat: rgb(0xc48b20).to_hsla(),
            presence_lavender: rgb(0x7c52a8).to_hsla(),
        }
    }

    pub fn dark() -> Self {
        let ui = UiPalette::DARK;
        Self {
            page: ui.page,
            side: ui.side,
            ink: ui.ink,
            muted: ui.muted,
            faint: ui.faint,
            line: ui.line,
            accent: ui.accent,
            grid_minor: rgba(0xeceb_e80a).to_hsla(),
            grid_major: rgba(0xeceb_e814).to_hsla(),
            grid_dot: rgba(0xeceb_e824).to_hsla(),
            timeline_start: rgb(0xe48369).to_hsla(),
            timeline_mid: rgb(0xef9f64).to_hsla(),
            timeline_end: rgb(0xe8925c).to_hsla(),
            timeline_halo: rgba(0x1514_13aa).to_hsla(),
            pill_bg: rgb(0xd87158).to_hsla(),
            pill_ink: rgb(0xfcfcfb).to_hsla(),
            minor_node_bg: rgb(0x262421).to_hsla(),
            minor_node_border: rgb(0x524d47).to_hsla(),
            highlight_bg: rgb(0x263952).to_hsla(),
            highlight_ink: rgb(0x8ec1f2).to_hsla(),
            arrow_default: rgb(0x9e978f).to_hsla(),
            arrow_label_bg: rgba(0x1b1a_18e8).to_hsla(),
            container_bg: rgba(0x1d1c_19cc).to_hsla(),
            container_border: rgb(0x3a3732).to_hsla(),
            container_header_bg: rgb(0x262420).to_hsla(),
            table_header_bg: rgb(0x23211e).to_hsla(),
            selection: rgb(0x6aa6dc).to_hsla(),
            selection_soft: rgba(0x6aa6_dc28).to_hsla(),
            snap_guide: rgb(0xe48369).to_hsla(),
            card_shadow: rgba(0x0000_0048).to_hsla(),
            tone_default: FillTone {
                fill: rgb(0x23211e).to_hsla(),
                border: rgb(0x3e3a35).to_hsla(),
                ink: ui.ink,
            },
            tone_sun: FillTone {
                fill: rgb(0x4a3d1f).to_hsla(),
                border: rgb(0x8a6f2e).to_hsla(),
                ink: rgb(0xf9ecc2).to_hsla(),
            },
            tone_peach: FillTone {
                fill: rgb(0x4d3121).to_hsla(),
                border: rgb(0x9e633f).to_hsla(),
                ink: rgb(0xfadbc4).to_hsla(),
            },
            tone_leaf: FillTone {
                fill: rgb(0x253b25).to_hsla(),
                border: rgb(0x4d7a44).to_hsla(),
                ink: rgb(0xd7eec7).to_hsla(),
            },
            tone_water: FillTone {
                fill: rgb(0x1f344b).to_hsla(),
                border: rgb(0x4a7bad).to_hsla(),
                ink: rgb(0xd2e7fc).to_hsla(),
            },
            tone_lavender: FillTone {
                fill: rgb(0x322848).to_hsla(),
                border: rgb(0x7861aa).to_hsla(),
                ink: rgb(0xe7defc).to_hsla(),
            },
            tone_berry: FillTone {
                fill: rgb(0x492825).to_hsla(),
                border: rgb(0xa85b52).to_hsla(),
                ink: rgb(0xfad8d2).to_hsla(),
            },
            tone_side: FillTone {
                fill: rgb(0x1b1a18).to_hsla(),
                border: rgb(0x383530).to_hsla(),
                ink: ui.ink,
            },
            sticky_sun: FillTone {
                fill: rgb(0x5b4814).to_hsla(),
                border: rgb(0x9d7b22).to_hsla(),
                ink: rgb(0xfceeae).to_hsla(),
            },
            sticky_peach: FillTone {
                fill: rgb(0x59351a).to_hsla(),
                border: rgb(0xab6b39).to_hsla(),
                ink: rgb(0xffe2c7).to_hsla(),
            },
            sticky_leaf: FillTone {
                fill: rgb(0x1f4a24).to_hsla(),
                border: rgb(0x458c4d).to_hsla(),
                ink: rgb(0xd7f6d9).to_hsla(),
            },
            sticky_water: FillTone {
                fill: rgb(0x1b3b5c).to_hsla(),
                border: rgb(0x4482bf).to_hsla(),
                ink: rgb(0xd8ecff).to_hsla(),
            },
            sticky_lavender: FillTone {
                fill: rgb(0x382b59).to_hsla(),
                border: rgb(0x7c63bd).to_hsla(),
                ink: rgb(0xe9e0ff).to_hsla(),
            },
            sticky_berry: FillTone {
                fill: rgb(0x542239).to_hsla(),
                border: rgb(0xa64d75).to_hsla(),
                ink: rgb(0xffdce9).to_hsla(),
            },
            sticky_side: FillTone {
                fill: rgb(0x2d2c28).to_hsla(),
                border: rgb(0x47453f).to_hsla(),
                ink: ui.ink,
            },
            pill_side: FillTone {
                fill: rgb(0x2c2b28).to_hsla(),
                border: rgb(0x45423d).to_hsla(),
                ink: ui.ink,
            },
            pill_lavender: FillTone {
                fill: rgb(0x3d2e66).to_hsla(),
                border: rgb(0x7d64c2).to_hsla(),
                ink: rgb(0xefeaff).to_hsla(),
            },
            presence_coral: rgb(0xd96d3d).to_hsla(),
            presence_teal: rgb(0x3ab2a4).to_hsla(),
            presence_blue: rgb(0x6aa6dc).to_hsla(),
            presence_leaf: rgb(0x8dbb5c).to_hsla(),
            presence_wheat: rgb(0xe5a93c).to_hsla(),
            presence_lavender: rgb(0xb48ef5).to_hsla(),
        }
    }

    pub fn tone(&self, fill: &WbFill) -> FillTone {
        match fill {
            WbFill::Default => self.tone_default,
            WbFill::Sun => self.tone_sun,
            WbFill::Peach => self.tone_peach,
            WbFill::Leaf => self.tone_leaf,
            WbFill::Water => self.tone_water,
            WbFill::Lavender => self.tone_lavender,
            WbFill::Berry => self.tone_berry,
            WbFill::Side => self.tone_side,
            WbFill::Custom(hex) => {
                if let Some(c) = parse_hex_hsla(hex) {
                    FillTone {
                        fill: c,
                        border: self.tone_default.border,
                        ink: self.ink,
                    }
                } else {
                    self.tone_default
                }
            }
        }
    }

    pub fn shape_tone(&self, shape: ShapeKind, fill: &WbFill) -> FillTone {
        if shape == ShapeKind::Sticky {
            match fill {
                WbFill::Sun => self.sticky_sun,
                WbFill::Peach => self.sticky_peach,
                WbFill::Leaf => self.sticky_leaf,
                WbFill::Water => self.sticky_water,
                WbFill::Lavender => self.sticky_lavender,
                WbFill::Berry => self.sticky_berry,
                WbFill::Side => self.sticky_side,
                WbFill::Default | WbFill::Custom(_) => self.tone(fill),
            }
        } else if matches!(shape, ShapeKind::Pill | ShapeKind::Rounded) {
            match fill {
                WbFill::Side => self.pill_side,
                WbFill::Lavender => self.pill_lavender,
                _ => self.tone(fill),
            }
        } else {
            self.tone(fill)
        }
    }

    pub fn presence_color(&self, color: PresenceColor) -> Hsla {
        match color {
            PresenceColor::Coral => self.presence_coral,
            PresenceColor::Teal => self.presence_teal,
            PresenceColor::Blue => self.presence_blue,
            PresenceColor::Leaf => self.presence_leaf,
            PresenceColor::Wheat => self.presence_wheat,
            PresenceColor::Lavender => self.presence_lavender,
        }
    }

    pub fn resolve_presence_color(&self, p: &Presence) -> Hsla {
        p.custom_color
            .as_deref()
            .and_then(parse_hex_hsla)
            .unwrap_or_else(|| self.presence_color(p.color))
    }
}

pub fn parse_hex_hsla(raw: &str) -> Option<Hsla> {
    let hex = raw.trim().strip_prefix('#')?;
    match hex.len() {
        6 => {
            let v = u32::from_str_radix(hex, 16).ok()?;
            Some(rgb(v).to_hsla())
        }
        8 => {
            let v = u32::from_str_radix(hex, 16).ok()?;
            Some(rgba(v).to_hsla())
        }
        3 => {
            let mut chars = hex.chars();
            let r = chars.next()?.to_digit(16)?;
            let g = chars.next()?.to_digit(16)?;
            let b = chars.next()?.to_digit(16)?;
            let v = ((r * 17) << 16) | ((g * 17) << 8) | (b * 17);
            Some(rgb(v).to_hsla())
        }
        _ => None,
    }
}
