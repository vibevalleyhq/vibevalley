use std::ops::{BitAnd, BitOr, BitOrAssign, Not};
use std::sync::OnceLock;

/// Advance widths of printable ASCII in thousandths of an em, two base-36 digits each (Arial).
const REGULAR_PACKED: &str = "7q7q9vfgfgopij5b9999atg87q997q7qfgfgfgfgfgfgfgfgfgfg7q7qg8g8g8fgs7ijijk2k2ijgzlmk27qdwijfgn5k2lmijlmk2ijgzk2ijq8ijijgz7q7q7qd1fg99fgfgdwfgfg7qfgfg6666dw66n5fgfgfgfg99dw7qfgdwk2dwdwdw9a789ag8";
const BOLD_PACKED: &str = "7q99d6fgfgopk26m9999atg87q997q7qfgfgfgfgfgfgfgfgfgfg9999g8g8g8gzr3k2k2k2k2ijgzlmk27qfgk2gzn5k2lmijlmk2ijgzk2ijq8ijijgz997q99g8fg99fggzfggzfg99gzgz7q7qfg7qopgzgzgzgzatfg99gzfglmfgfgdwat7satg8";

/// Approximate divisor for SVG `font-size="smaller"`.
const SMALLER: f64 = 1.2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
pub struct TextStyle(u8);

impl TextStyle {
    pub const NONE: Self = Self(0);
    pub const BOLD: Self = Self(1);
    pub const ITALIC: Self = Self(2);
    pub const MONO: Self = Self(4);
    pub const SUB: Self = Self(8);
    pub const SUP: Self = Self(16);
    pub const UNDERLINE: Self = Self(32);

    #[inline]
    pub const fn contains(self, other: Self) -> bool {
        (self.0 & other.0) == other.0
    }

    #[inline]
    pub const fn intersects(self, other: Self) -> bool {
        (self.0 & other.0) != 0
    }

    #[inline]
    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }

    #[inline]
    pub const fn bits(self) -> u8 {
        self.0
    }
}

impl BitOr for TextStyle {
    type Output = Self;
    #[inline]
    fn bitor(self, rhs: Self) -> Self {
        Self(self.0 | rhs.0)
    }
}

impl BitOrAssign for TextStyle {
    #[inline]
    fn bitor_assign(&mut self, rhs: Self) {
        self.0 |= rhs.0;
    }
}

impl BitAnd for TextStyle {
    type Output = Self;
    #[inline]
    fn bitand(self, rhs: Self) -> Self {
        Self(self.0 & rhs.0)
    }
}

impl Not for TextStyle {
    type Output = Self;
    #[inline]
    fn not(self) -> Self {
        Self(!self.0)
    }
}

/// Pluggable text width measurement interface.
///
/// The default [`MetricsMeasurer`] uses Pele's deterministic ASCII + CJK advance tables so layout
/// and tests are reproducible without a browser or OS font stack. Native hosts (e.g. macOS CoreText
/// or GPUI) can supply a custom implementation via `RenderOptions::measurer`.
pub trait TextMeasurer: Send + Sync {
    fn width(&self, text: &str, size: f64, style: TextStyle) -> f64;
}

/// Wrapper forcing monospace measurement for diagram elements configured as monospace.
pub struct MonoMeasurer<'a>(pub &'a dyn TextMeasurer);

impl TextMeasurer for MonoMeasurer<'_> {
    fn width(&self, text: &str, size: f64, style: TextStyle) -> f64 {
        self.0.width(text, size, style | TextStyle::MONO)
    }
}

fn unpack(packed: &str) -> [u16; 95] {
    let mut out = [0u16; 95];
    let bytes = packed.as_bytes();
    for (i, slot) in out.iter_mut().enumerate() {
        let pair = std::str::from_utf8(&bytes[i * 2..i * 2 + 2]).unwrap_or("00");
        *slot = u16::from_str_radix(pair, 36).unwrap_or(0);
    }
    out
}

static REGULAR_TABLE: OnceLock<[u16; 95]> = OnceLock::new();
static BOLD_TABLE: OnceLock<[u16; 95]> = OnceLock::new();

#[inline]
fn is_wide(c: u32) -> bool {
    (0x1100..=0x115f).contains(&c)
        || (0x2e80..=0xa4cf).contains(&c)
        || (0xac00..=0xd7a3).contains(&c)
        || (0xf900..=0xfaff).contains(&c)
        || (0xfe30..=0xfe4f).contains(&c)
        || (0xff00..=0xff60).contains(&c)
        || (0xffe0..=0xffe6).contains(&c)
        // UTF-16 surrogate pair in JS pele scores high surrogate as wide and low surrogate as 0.
        || c >= 0x10000
}

#[inline]
fn is_zero_width(c: u32) -> bool {
    c == 0xad || (0x300..=0x36f).contains(&c) || (0x200b..=0x200f).contains(&c) || (0xfe00..=0xfe0f).contains(&c) || c == 0xfeff
}

#[derive(Debug, Default, Clone, Copy)]
pub struct MetricsMeasurer;

pub static METRICS_MEASURER: MetricsMeasurer = MetricsMeasurer;

impl TextMeasurer for MetricsMeasurer {
    fn width(&self, text: &str, size: f64, style: TextStyle) -> f64 {
        let mono = style.contains(TextStyle::MONO);
        let eff = if style.intersects(TextStyle::SUB | TextStyle::SUP) {
            size / SMALLER
        } else {
            size
        };
        let table = if style.contains(TextStyle::BOLD) {
            BOLD_TABLE.get_or_init(|| unpack(BOLD_PACKED))
        } else {
            REGULAR_TABLE.get_or_init(|| unpack(REGULAR_PACKED))
        };
        let mut units: f64 = 0.0;
        for ch in text.chars() {
            let c = ch as u32;
            if c < 32 {
                continue;
            }
            if c < 127 {
                units += if mono { 600.0 } else { table[(c - 32) as usize] as f64 };
            } else if is_zero_width(c) {
                continue;
            } else if is_wide(c) {
                units += if mono { 1200.0 } else { 1000.0 };
            } else {
                units += if mono { 600.0 } else { 580.0 };
            }
        }
        (units * eff) / 1000.0
    }
}
