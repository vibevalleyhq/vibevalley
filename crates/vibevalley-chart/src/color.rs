use crate::error::ChartError;

/// Concrete sRGB color with 8-bit channels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    pub const fn new(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b }
    }

    pub fn to_hex(self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.r, self.g, self.b)
    }

    /// WCAG 2.1 relative luminance in `[0.0, 1.0]`.
    pub fn relative_luminance(self) -> f64 {
        fn channel(c: u8) -> f64 {
            let s = f64::from(c) / 255.0;
            if s <= 0.03928 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) }
        }
        0.2126 * channel(self.r) + 0.7152 * channel(self.g) + 0.0722 * channel(self.b)
    }

    /// WCAG 2.1 contrast ratio against another color (`1.0` to `21.0`).
    pub fn contrast_ratio(self, other: Rgb) -> f64 {
        let l1 = self.relative_luminance();
        let l2 = other.relative_luminance();
        let (hi, lo) = if l1 >= l2 { (l1, l2) } else { (l2, l1) };
        (hi + 0.05) / (lo + 0.05)
    }

    /// Picks whichever of `dark_ink` or `light_ink` yields higher WCAG contrast on `self`.
    pub fn contrast_ink(self, dark_ink: &str, light_ink: &str) -> String {
        let dark = parse_rgb(dark_ink).unwrap_or(Rgb::new(0x1c, 0x19, 0x17));
        let light = parse_rgb(light_ink).unwrap_or(Rgb::new(0xfc, 0xfc, 0xfb));
        if self.contrast_ratio(dark) >= self.contrast_ratio(light) {
            dark_ink.to_string()
        } else {
            light_ink.to_string()
        }
    }

    pub fn lerp(self, other: Rgb, t: f64) -> Rgb {
        let t = t.clamp(0.0, 1.0);
        let mix = |a: u8, b: u8| -> u8 { (f64::from(a) + (f64::from(b) - f64::from(a)) * t).round().clamp(0.0, 255.0) as u8 };
        Rgb::new(mix(self.r, other.r), mix(self.g, other.g), mix(self.b, other.b))
    }
}

/// Interpolates across an ordered multi-stop palette for `t` in `[0.0, 1.0]`.
pub fn interpolate_ramp(stops: &[Rgb], t: f64) -> Rgb {
    if stops.is_empty() {
        return Rgb::new(0x74, 0xa0, 0x46);
    }
    if stops.len() == 1 {
        return stops[0];
    }
    let clamped = t.clamp(0.0, 1.0);
    let scaled = clamped * (stops.len() - 1) as f64;
    let idx = (scaled.floor() as usize).min(stops.len() - 2);
    let local_t = scaled - idx as f64;
    stops[idx].lerp(stops[idx + 1], local_t)
}

/// Parses `#rgb`, `#rrggbb`, `rgb(r, g, b)`, or common SVG named colors into `Rgb`.
pub fn parse_rgb(input: &str) -> Option<Rgb> {
    let s = input.trim();
    if let Some(hex) = s.strip_prefix('#') {
        return match hex.len() {
            3 => {
                let r = parse_hex_nibble(hex.as_bytes()[0])?;
                let g = parse_hex_nibble(hex.as_bytes()[1])?;
                let b = parse_hex_nibble(hex.as_bytes()[2])?;
                Some(Rgb::new(r * 17, g * 17, b * 17))
            }
            6 => {
                let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
                let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
                let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
                Some(Rgb::new(r, g, b))
            }
            _ => None,
        };
    }

    let lower = s.to_ascii_lowercase();
    if let Some(inner) = lower.strip_prefix("rgb(").and_then(|v| v.strip_suffix(')')) {
        let parts: Vec<&str> = inner.split(',').map(str::trim).collect();
        if parts.len() == 3 {
            let r: u8 = parts[0].parse().ok()?;
            let g: u8 = parts[1].parse().ok()?;
            let b: u8 = parts[2].parse().ok()?;
            return Some(Rgb::new(r, g, b));
        }
    }

    if let Some(inner) = lower.strip_prefix("rgba(").and_then(|v| v.strip_suffix(')')) {
        let parts: Vec<&str> = inner.split(',').map(str::trim).collect();
        if parts.len() == 4 {
            let r: u8 = parts[0].parse().ok()?;
            let g: u8 = parts[1].parse().ok()?;
            let b: u8 = parts[2].parse().ok()?;
            let a: f64 = parts[3].parse().ok()?;
            if a.is_finite() && (0.0..=1.0).contains(&a) {
                return Some(Rgb::new(r, g, b));
            }
        }
    }

    named_color_rgb(&lower)
}

/// Validates a user-supplied color string against a strict safe SVG color subset.
/// Rejects CSS variables, `url(...)`, `color-mix(...)`, quotes, semicolons, and script payloads.
pub fn validate_color(field: &str, value: &str) -> Result<(), ChartError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(ChartError::InvalidColor {
            field: field.to_string(),
            value: value.to_string(),
            message: "color cannot be empty".to_string(),
        });
    }
    if trimmed.len() > 64 {
        return Err(ChartError::InvalidColor {
            field: field.to_string(),
            value: value.to_string(),
            message: "color exceeds maximum length of 64 characters".to_string(),
        });
    }
    if parse_rgb(trimmed).is_some() {
        return Ok(());
    }
    Err(ChartError::InvalidColor {
        field: field.to_string(),
        value: value.to_string(),
        message: "expected #rgb, #rrggbb, rgb(r,g,b), rgba(r,g,b,a), or a standard SVG color name".to_string(),
    })
}

/// Canonicalizes a validated color into `#rrggbb` so `usvg`/`resvg` always receives concrete hex.
pub fn canonical_hex(value: &str) -> Option<String> {
    parse_rgb(value).map(Rgb::to_hex)
}

fn parse_hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn named_color_rgb(name: &str) -> Option<Rgb> {
    let rgb = match name {
        "black" => Rgb::new(0x00, 0x00, 0x00),
        "white" => Rgb::new(0xff, 0xff, 0xff),
        "red" => Rgb::new(0xff, 0x00, 0x00),
        "green" => Rgb::new(0x00, 0x80, 0x00),
        "blue" => Rgb::new(0x00, 0x00, 0xff),
        "yellow" => Rgb::new(0xff, 0xff, 0x00),
        "orange" => Rgb::new(0xff, 0xa5, 0x00),
        "purple" => Rgb::new(0x80, 0x00, 0x80),
        "pink" => Rgb::new(0xff, 0xc0, 0xcb),
        "cyan" | "aqua" => Rgb::new(0x00, 0xff, 0xff),
        "magenta" | "fuchsia" => Rgb::new(0xff, 0x00, 0xff),
        "gray" | "grey" => Rgb::new(0x80, 0x80, 0x80),
        "darkgray" | "darkgrey" => Rgb::new(0xa9, 0xa9, 0xa9),
        "lightgray" | "lightgrey" => Rgb::new(0xd3, 0xd3, 0xd3),
        "silver" => Rgb::new(0xc0, 0xc0, 0xc0),
        "maroon" => Rgb::new(0x80, 0x00, 0x00),
        "olive" => Rgb::new(0x80, 0x80, 0x00),
        "lime" => Rgb::new(0x00, 0xff, 0x00),
        "teal" => Rgb::new(0x00, 0x80, 0x80),
        "navy" => Rgb::new(0x00, 0x00, 0x80),
        "indigo" => Rgb::new(0x4b, 0x00, 0x82),
        "violet" => Rgb::new(0xee, 0x82, 0xee),
        "gold" => Rgb::new(0xff, 0xd7, 0x00),
        "coral" => Rgb::new(0xff, 0x7f, 0x50),
        "crimson" => Rgb::new(0xdc, 0x14, 0x3c),
        "tomato" => Rgb::new(0xff, 0x63, 0x47),
        "salmon" => Rgb::new(0xfa, 0x80, 0x72),
        "brown" => Rgb::new(0xa5, 0x2a, 0x2a),
        "chocolate" => Rgb::new(0xd2, 0x69, 0x1e),
        "sienna" => Rgb::new(0xa0, 0x52, 0x2d),
        "tan" => Rgb::new(0xd2, 0xb4, 0x8c),
        "wheat" => Rgb::new(0xf5, 0xde, 0xb3),
        "beige" => Rgb::new(0xf5, 0xf5, 0xdc),
        "ivory" => Rgb::new(0xff, 0xff, 0xf0),
        "khaki" => Rgb::new(0xf0, 0xe6, 0x8c),
        "steelblue" => Rgb::new(0x46, 0x82, 0xb4),
        "royalblue" => Rgb::new(0x41, 0x69, 0xe1),
        "dodgerblue" => Rgb::new(0x1e, 0x90, 0xff),
        "skyblue" => Rgb::new(0x87, 0xce, 0xeb),
        "slateblue" => Rgb::new(0x6a, 0x5a, 0xcd),
        "slategray" | "slategrey" => Rgb::new(0x70, 0x80, 0x90),
        "forestgreen" => Rgb::new(0x22, 0x8b, 0x22),
        "seagreen" => Rgb::new(0x2e, 0x8b, 0x57),
        "mediumseagreen" => Rgb::new(0x3c, 0xb3, 0x71),
        "darkgreen" => Rgb::new(0x00, 0x64, 0x00),
        "darkblue" => Rgb::new(0x00, 0x00, 0x8b),
        "darkred" => Rgb::new(0x8b, 0x00, 0x00),
        "darkorange" => Rgb::new(0xff, 0x8c, 0x00),
        "turquoise" => Rgb::new(0x40, 0xe0, 0xd0),
        "plum" => Rgb::new(0xdd, 0xa0, 0xdd),
        "orchid" => Rgb::new(0xda, 0x70, 0xd6),
        "amber" => Rgb::new(0xff, 0xbf, 0x00),
        _ => return None,
    };
    Some(rgb)
}

#[cfg(test)]
mod tests {
    use super::{Rgb, interpolate_ramp, parse_rgb, validate_color};

    #[test]
    fn parses_hex_rgb_rgba_and_named_colors() {
        assert_eq!(parse_rgb("#abc"), Some(Rgb::new(0xaa, 0xbb, 0xcc)));
        assert_eq!(parse_rgb("#4d7a2a"), Some(Rgb::new(0x4d, 0x7a, 0x2a)));
        assert_eq!(parse_rgb("rgb(12, 34, 56)"), Some(Rgb::new(12, 34, 56)));
        assert_eq!(parse_rgb("rgba(12, 34, 56, 0.5)"), Some(Rgb::new(12, 34, 56)));
        assert_eq!(parse_rgb("steelblue"), Some(Rgb::new(0x46, 0x82, 0xb4)));
        assert_eq!(parse_rgb("rgba(12, 34, 56, 1.5)"), None);
    }

    #[test]
    fn contrast_and_ramp_interpolation_behave_accurately() {
        let dark = Rgb::new(0x1c, 0x19, 0x17);
        let light = Rgb::new(0xfc, 0xfc, 0xfb);
        assert!(dark.contrast_ratio(light) > 15.0);
        assert_eq!(dark.contrast_ink("#1c1917", "#fcfcfb"), "#fcfcfb");
        assert_eq!(light.contrast_ink("#1c1917", "#fcfcfb"), "#1c1917");

        let stops = [Rgb::new(0, 0, 0), Rgb::new(100, 200, 50), Rgb::new(255, 255, 255)];
        assert_eq!(interpolate_ramp(&stops, 0.0), stops[0]);
        assert_eq!(interpolate_ramp(&stops, 0.5), stops[1]);
        assert_eq!(interpolate_ramp(&stops, 1.0), stops[2]);
        assert!(validate_color("c", "#4d7a2a").is_ok());
        assert!(validate_color("c", "var(--x)").is_err());
    }
}
