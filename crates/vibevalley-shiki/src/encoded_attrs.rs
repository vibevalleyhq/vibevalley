use std::ops::{BitAnd, BitOr, BitOrAssign};

use crate::theme::StyleAttributes;

/// Standard token category bit-packed into `EncodedTokenAttributes`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
#[repr(u8)]
pub enum StandardTokenType {
    #[default]
    Other = 0,
    Comment = 1,
    String = 2,
    RegEx = 3,
}

impl StandardTokenType {
    pub const fn from_u8(val: u8) -> Self {
        match val & 0b11 {
            0 => Self::Other,
            1 => Self::Comment,
            2 => Self::String,
            _ => Self::RegEx,
        }
    }
}

/// Optional standard token type used during attribute merging (`NotSet` preserves existing).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OptionalStandardTokenType {
    Other,
    Comment,
    String,
    RegEx,
    NotSet,
}

impl From<StandardTokenType> for OptionalStandardTokenType {
    fn from(value: StandardTokenType) -> Self {
        match value {
            StandardTokenType::Other => Self::Other,
            StandardTokenType::Comment => Self::Comment,
            StandardTokenType::String => Self::String,
            StandardTokenType::RegEx => Self::RegEx,
        }
    }
}

/// Font style bitmask matching `vscode-textmate`'s `FontStyle`.
///
/// `FontStyle::NOT_SET` (`-1`) indicates inheritance from parent scope; `FontStyle::NONE` (`0`)
/// explicitly clears italic/bold/underline/strikethrough.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct FontStyle(i8);

impl FontStyle {
    pub const NOT_SET: Self = Self(-1);
    pub const NONE: Self = Self(0);
    pub const ITALIC: Self = Self(1);
    pub const BOLD: Self = Self(2);
    pub const UNDERLINE: Self = Self(4);
    pub const STRIKETHROUGH: Self = Self(8);

    pub const fn from_bits(bits: i8) -> Self {
        Self(bits)
    }

    pub const fn bits(self) -> i8 {
        self.0
    }

    pub const fn is_not_set(self) -> bool {
        self.0 < 0
    }

    pub const fn contains(self, other: Self) -> bool {
        self.0 >= 0 && other.0 >= 0 && (self.0 & other.0) == other.0
    }

    pub const fn is_italic(self) -> bool {
        self.contains(Self::ITALIC)
    }

    pub const fn is_bold(self) -> bool {
        self.contains(Self::BOLD)
    }

    pub const fn is_underline(self) -> bool {
        self.contains(Self::UNDERLINE)
    }

    pub const fn is_strikethrough(self) -> bool {
        self.contains(Self::STRIKETHROUGH)
    }

    pub fn to_display_string(self) -> String {
        if self.is_not_set() {
            return "not set".to_string();
        }
        let mut out = String::new();
        if self.is_italic() {
            out.push_str("italic ");
        }
        if self.is_bold() {
            out.push_str("bold ");
        }
        if self.is_underline() {
            out.push_str("underline ");
        }
        if self.is_strikethrough() {
            out.push_str("strikethrough ");
        }
        let trimmed = out.trim();
        if trimmed.is_empty() { "none".to_string() } else { trimmed.to_string() }
    }
}

impl BitOr for FontStyle {
    type Output = Self;

    fn bitor(self, rhs: Self) -> Self::Output {
        Self(self.0 | rhs.0)
    }
}

impl BitOrAssign for FontStyle {
    fn bitor_assign(&mut self, rhs: Self) {
        self.0 |= rhs.0;
    }
}

impl BitAnd for FontStyle {
    type Output = Self;

    fn bitand(self, rhs: Self) -> Self::Output {
        Self(self.0 & rhs.0)
    }
}

/// Variable font attributes attached to a scope stack.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FontAttribute {
    pub font_family: Option<String>,
    pub font_size: Option<f64>,
    pub line_height: Option<f64>,
}

impl FontAttribute {
    pub fn from_parts(font_family: Option<String>, font_size: Option<f64>, line_height: Option<f64>) -> Self {
        Self {
            font_family: font_family.filter(|s| !s.is_empty()),
            font_size: font_size.filter(|&v| v != 0.0),
            line_height: line_height.filter(|&v| v != 0.0),
        }
    }

    pub fn with(&self, style: Option<&StyleAttributes>) -> Self {
        let Some(style) = style else {
            return self.clone();
        };
        Self {
            font_family: if !style.font_family.is_empty() {
                Some(style.font_family.clone())
            } else {
                self.font_family.clone()
            },
            font_size: if style.font_size != 0.0 { Some(style.font_size) } else { self.font_size },
            line_height: if style.line_height != 0.0 {
                Some(style.line_height)
            } else {
                self.line_height
            },
        }
    }
}

/// Bit-packed 32-bit token metadata identical to `vscode-textmate`'s `EncodedTokenAttributes`:
/// - bits 0..=7: `language_id` (8 bits)
/// - bits 8..=9: `token_type` (2 bits)
/// - bit 10: `contains_balanced_brackets` (1 bit)
/// - bits 11..=14: `font_style` (4 bits)
/// - bits 15..=23: `foreground` color id (9 bits)
/// - bits 24..=31: `background` color id (8 bits)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct EncodedTokenAttributes(pub u32);

impl EncodedTokenAttributes {
    pub const LANGUAGEID_MASK: u32 = 0b0000_0000_0000_0000_0000_0000_1111_1111;
    pub const TOKEN_TYPE_MASK: u32 = 0b0000_0000_0000_0000_0000_0011_0000_0000;
    pub const BALANCED_BRACKETS_MASK: u32 = 0b0000_0000_0000_0000_0000_0100_0000_0000;
    pub const FONT_STYLE_MASK: u32 = 0b0000_0000_0000_0000_0111_1000_0000_0000;
    pub const FOREGROUND_MASK: u32 = 0b0000_0000_1111_1111_1000_0000_0000_0000;
    pub const BACKGROUND_MASK: u32 = 0b1111_1111_0000_0000_0000_0000_0000_0000;

    pub const LANGUAGEID_OFFSET: u32 = 0;
    pub const TOKEN_TYPE_OFFSET: u32 = 8;
    pub const BALANCED_BRACKETS_OFFSET: u32 = 10;
    pub const FONT_STYLE_OFFSET: u32 = 11;
    pub const FOREGROUND_OFFSET: u32 = 15;
    pub const BACKGROUND_OFFSET: u32 = 24;

    pub const fn to_raw(self) -> u32 {
        self.0
    }

    pub const fn language_id(self) -> u8 {
        ((self.0 & Self::LANGUAGEID_MASK) >> Self::LANGUAGEID_OFFSET) as u8
    }

    pub const fn token_type(self) -> StandardTokenType {
        StandardTokenType::from_u8(((self.0 & Self::TOKEN_TYPE_MASK) >> Self::TOKEN_TYPE_OFFSET) as u8)
    }

    pub const fn contains_balanced_brackets(self) -> bool {
        (self.0 & Self::BALANCED_BRACKETS_MASK) != 0
    }

    pub const fn font_style(self) -> FontStyle {
        FontStyle(((self.0 & Self::FONT_STYLE_MASK) >> Self::FONT_STYLE_OFFSET) as i8)
    }

    pub const fn foreground(self) -> u16 {
        ((self.0 & Self::FOREGROUND_MASK) >> Self::FOREGROUND_OFFSET) as u16
    }

    pub const fn background(self) -> u16 {
        ((self.0 & Self::BACKGROUND_MASK) >> Self::BACKGROUND_OFFSET) as u16
    }

    pub fn to_binary_str(self) -> String {
        format!("{:032b}", self.0)
    }

    /// Updates non-sentinel fields on `self` and returns the new bit-packed attributes.
    pub const fn set(
        self,
        language_id: u8,
        token_type: OptionalStandardTokenType,
        contains_balanced_brackets: Option<bool>,
        font_style: FontStyle,
        foreground: u16,
        background: u16,
    ) -> Self {
        let next_lang = if language_id != 0 { language_id as u32 } else { self.language_id() as u32 };

        let next_token_type = match token_type {
            OptionalStandardTokenType::Other => StandardTokenType::Other as u32,
            OptionalStandardTokenType::Comment => StandardTokenType::Comment as u32,
            OptionalStandardTokenType::String => StandardTokenType::String as u32,
            OptionalStandardTokenType::RegEx => StandardTokenType::RegEx as u32,
            OptionalStandardTokenType::NotSet => self.token_type() as u32,
        };

        let next_brackets: u32 = match contains_balanced_brackets {
            Some(true) => 1,
            Some(false) => 0,
            None => self.contains_balanced_brackets() as u32,
        };

        let next_font_style: u32 = if !font_style.is_not_set() {
            (font_style.bits() as u32) & 0b1111
        } else {
            (self.font_style().bits() as u32) & 0b1111
        };

        let next_fg: u32 = if foreground != 0 {
            (foreground as u32) & 0x1ff
        } else {
            self.foreground() as u32
        };

        let next_bg: u32 = if background != 0 {
            (background as u32) & 0xff
        } else {
            self.background() as u32
        };

        Self(
            (next_lang << Self::LANGUAGEID_OFFSET)
                | (next_token_type << Self::TOKEN_TYPE_OFFSET)
                | (next_brackets << Self::BALANCED_BRACKETS_OFFSET)
                | (next_font_style << Self::FONT_STYLE_OFFSET)
                | (next_fg << Self::FOREGROUND_OFFSET)
                | (next_bg << Self::BACKGROUND_OFFSET),
        )
    }
}

/// Returns true if `s` contains any Unicode character with bidirectional class R or AL,
/// matching `vscode-textmate`'s `containsRTL` so binary token merging is disabled on RTL lines.
pub(crate) fn contains_rtl(s: &str) -> bool {
    s.chars().any(is_rtl_char)
}

fn is_rtl_char(ch: char) -> bool {
    let cp = ch as u32;
    matches!(
        cp,
        0x05BE
            | 0x05C0
            | 0x05C3
            | 0x05C6
            | 0x05D0..=0x05F4
            | 0x0608
            | 0x060B
            | 0x060D
            | 0x061B..=0x064A
            | 0x066D..=0x066F
            | 0x0671..=0x06D5
            | 0x06E5..=0x06E6
            | 0x06EE..=0x06EF
            | 0x06FA..=0x0710
            | 0x0712..=0x072F
            | 0x074D..=0x07A5
            | 0x07B1..=0x07EA
            | 0x07F4..=0x07F5
            | 0x07FA
            | 0x07FE..=0x0815
            | 0x081A
            | 0x0824
            | 0x0828
            | 0x0830..=0x0858
            | 0x085E..=0x088E
            | 0x08A0..=0x08C9
            | 0x200F
            | 0xFB1D
            | 0xFB1F..=0xFB28
            | 0xFB2A..=0xFD3D
            | 0xFD50..=0xFDC7
            | 0xFDF0..=0xFDFC
            | 0xFE70..=0xFEFC
            | 0x10800..=0x1091B
            | 0x10920..=0x10A00
            | 0x10A10..=0x10A35
            | 0x10A40..=0x10AE4
            | 0x10AEB..=0x10B35
            | 0x10B40..=0x10BFF
            | 0x10C00..=0x10D23
            | 0x10E80..=0x10EA9
            | 0x10EAD..=0x10F45
            | 0x10F51..=0x10F81
            | 0x10F86..=0x10FF6
            | 0x1E800..=0x1E8CF
            | 0x1E900..=0x1E943
            | 0x1E94B..=0x1E9FF
            | 0x1EC00..=0x1EEBB
    )
}
