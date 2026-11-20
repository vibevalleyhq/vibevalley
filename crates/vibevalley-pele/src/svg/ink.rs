use std::collections::HashSet;
use std::f64::consts::PI;
use std::sync::OnceLock;

use crate::svg::theme::SvgTheme;

const DARK_NAMES: &str = "black blue blueviolet brown crimson darkblue darkcyan darkgreen darkmagenta darkolivegreen darkorchid darkred darkslateblue darkslategray darkviolet dimgray firebrick forestgreen green indigo maroon mediumblue mediumslateblue mediumvioletred midnightblue navy olive purple rebeccapurple royalblue saddlebrown seagreen sienna slateblue steelblue teal";
const LIGHT_NAMES: &str = "aliceblue antiquewhite aqua aquamarine azure beige bisque blanchedalmond burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk cyan darkgoldenrod darkgray darkkhaki darkorange darksalmon darkseagreen darkturquoise deeppink deepskyblue dodgerblue floralwhite fuchsia gainsboro ghostwhite gold goldenrod gray greenyellow honeydew hotpink indianred ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightpink lightsalmon lightseagreen lightskyblue lightslategray lightsteelblue lightyellow lime limegreen linen magenta mediumaquamarine mediumorchid mediumpurple mediumseagreen mediumspringgreen mediumturquoise mintcream mistyrose moccasin navajowhite oldlace olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue red rosybrown salmon sandybrown seashell silver skyblue slategray snow springgreen tan thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen";

static DARK: OnceLock<HashSet<&'static str>> = OnceLock::new();
static LIGHT: OnceLock<HashSet<&'static str>> = OnceLock::new();

fn dark_set() -> &'static HashSet<&'static str> {
    DARK.get_or_init(|| DARK_NAMES.split(' ').collect())
}

fn light_set() -> &'static HashSet<&'static str> {
    LIGHT.get_or_init(|| LIGHT_NAMES.split(' ').collect())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InkTone {
    OnLight,
    OnDark,
}

impl InkTone {
    pub fn paint(self, theme: &SvgTheme) -> &str {
        match self {
            Self::OnLight => theme.on_light(),
            Self::OnDark => theme.on_dark(),
        }
    }
}

fn linear(c: f64) -> f64 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

fn luminance(r: f64, g: f64, b: f64) -> f64 {
    0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

fn even_luminance() -> f64 {
    let fg = 31.0 / 255.0;
    (1.05 * (luminance(fg, fg, fg) + 0.05)).sqrt() - 0.05
}

fn clamp01(n: f64) -> f64 {
    n.clamp(0.0, 1.0)
}

fn parse_css_number(raw: &str) -> Option<(f64, &str)> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    let bytes = s.as_bytes();
    let mut i = 0;
    if matches!(bytes[0], b'+' | b'-') {
        i += 1;
    }
    let mut has_int = false;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        has_int = true;
        i += 1;
    }
    let mut has_frac = false;
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        let frac_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            has_frac = true;
            i += 1;
        }
        // Reject trailing dot without fractional digits (`0.`) matching pele's RE_NUMBER.
        if i == frac_start {
            return None;
        }
    }
    if !has_int && !has_frac {
        return None;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && matches!(bytes[i], b'+' | b'-') {
            i += 1;
        }
        let exp_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == exp_start {
            return None;
        }
    }
    let num: f64 = s[..i].parse().ok()?;
    let unit = &s[i..];
    let valid_unit = unit.is_empty()
        || unit == "%"
        || unit.eq_ignore_ascii_case("deg")
        || unit.eq_ignore_ascii_case("grad")
        || unit.eq_ignore_ascii_case("rad")
        || unit.eq_ignore_ascii_case("turn");
    if !valid_unit {
        return None;
    }
    Some((num, unit))
}

fn amount(raw: &str, full: f64) -> f64 {
    let Some((n, unit)) = parse_css_number(raw) else {
        return f64::NAN;
    };
    if !unit.is_empty() && unit != "%" {
        return f64::NAN;
    }
    clamp01(n / if unit == "%" { 100.0 } else { full })
}

fn hue(raw: &str) -> f64 {
    let Some((n, unit)) = parse_css_number(raw) else {
        return f64::NAN;
    };
    if unit == "%" {
        return f64::NAN;
    }
    if unit.eq_ignore_ascii_case("turn") {
        n * 360.0
    } else if unit.eq_ignore_ascii_case("rad") {
        (n * 180.0) / PI
    } else if unit.eq_ignore_ascii_case("grad") {
        n * 0.9
    } else {
        n
    }
}

fn parse_func_args(body: &str, hsl: bool) -> Option<Vec<String>> {
    let legacy = body.contains(',');
    let (main, alpha) = if legacy {
        (body, None)
    } else {
        let mut parts = body.split('/');
        let m = parts.next()?;
        let a = parts.next();
        if parts.next().is_some() {
            return None;
        }
        (m, a)
    };
    let mut list: Vec<String> = if legacy {
        main.trim().split(',').map(|p| p.trim().to_string()).collect()
    } else {
        main.split_whitespace().map(str::to_string).collect()
    };
    if legacy {
        if list.len() < 3 || list.len() > 4 {
            return None;
        }
    } else if list.len() != 3 {
        return None;
    }
    if let Some(a) = alpha {
        list.push(a.trim().to_string());
    }
    if !legacy {
        for item in &mut list {
            if item == "none" {
                *item = "0".to_string();
            }
        }
        return Some(list);
    }
    let start = if hsl { 1 } else { 0 };
    let percent = list[start..3].iter().filter(|c| c.ends_with('%')).count();
    let expected = if hsl { 2 } else { 3 };
    if percent == expected || (!hsl && percent == 0) { Some(list) } else { None }
}

pub fn is_hex_color(value: &str) -> bool {
    let Some(digits) = value.strip_prefix('#') else {
        return false;
    };
    matches!(digits.len(), 3 | 4 | 6 | 8) && digits.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Parses `#rgb` / `#rrggbb` into `(r, g, b)` bytes for sRGB mixing in resolved mode.
pub fn parse_hex_rgb(raw: &str) -> Option<(u8, u8, u8)> {
    let value = raw.trim();
    let digits = value.strip_prefix('#')?;
    if !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    match digits.len() {
        3 | 4 => {
            let r = u8::from_str_radix(&digits[0..1], 16).ok()? * 17;
            let g = u8::from_str_radix(&digits[1..2], 16).ok()? * 17;
            let b = u8::from_str_radix(&digits[2..3], 16).ok()? * 17;
            Some((r, g, b))
        }
        6 | 8 => {
            let r = u8::from_str_radix(&digits[0..2], 16).ok()?;
            let g = u8::from_str_radix(&digits[2..4], 16).ok()?;
            let b = u8::from_str_radix(&digits[4..6], 16).ok()?;
            Some((r, g, b))
        }
        _ => None,
    }
}

pub fn plain_color(raw: &str) -> bool {
    let value = raw.trim().to_ascii_lowercase();
    let name = value.replace("grey", "gray");
    is_hex_color(&value) || dark_set().contains(name.as_str()) || light_set().contains(name.as_str()) || value == "transparent" || value == "currentcolor"
}

fn color_lum_alpha(raw: &str) -> Option<(f64, f64)> {
    let value = raw.trim().to_ascii_lowercase();
    let name = value.replace("grey", "gray");
    if dark_set().contains(name.as_str()) {
        return Some((0.0, 1.0));
    }
    if light_set().contains(name.as_str()) {
        return Some((1.0, 1.0));
    }
    if is_hex_color(&value) {
        let hex = &value[1..];
        let digits: String = if hex.len() < 6 {
            hex.chars().flat_map(|c| [c, c]).collect()
        } else {
            hex.to_string()
        };
        let channel = |i: usize| -> f64 { u8::from_str_radix(&digits[2 * i..2 * i + 2], 16).unwrap_or(0) as f64 / 255.0 };
        let alpha = if digits.len() == 8 { channel(3) } else { 1.0 };
        return Some((luminance(channel(0), channel(1), channel(2)), alpha));
    }
    let open = value.find('(')?;
    if !value.ends_with(')') {
        return None;
    }
    let fn_name = &value[..open];
    let body = &value[open + 1..value.len() - 1];
    if body.contains(['(', ')']) {
        return None;
    }
    let hsl = match fn_name {
        "rgb" | "rgba" => false,
        "hsl" | "hsla" => true,
        _ => return None,
    };
    let list = parse_func_args(body, hsl)?;
    let alpha = if list.len() == 4 { amount(&list[3], 1.0) } else { 1.0 };
    if alpha.is_nan() {
        return None;
    }
    let rgb = if !hsl {
        let r = amount(&list[0], 255.0);
        let g = amount(&list[1], 255.0);
        let b = amount(&list[2], 255.0);
        if r.is_nan() || g.is_nan() || b.is_nan() {
            return None;
        }
        [r, g, b]
    } else {
        let h_deg = hue(&list[0]);
        let s = amount(&list[1], 100.0);
        let l = amount(&list[2], 100.0);
        if h_deg.is_nan() || s.is_nan() || l.is_nan() {
            return None;
        }
        let h = ((h_deg % 360.0) + 360.0) % 360.0 / 30.0;
        let a = s * l.min(1.0 - l);
        let ch = |k: f64| -> f64 {
            let t = (k + h) % 12.0;
            l - a * (t - 3.0).min(9.0 - t).clamp(-1.0, 1.0)
        };
        [ch(0.0), ch(8.0), ch(4.0)]
    };
    let lum = luminance(rgb[0], rgb[1], rgb[2]);
    if (lum + alpha).is_nan() { None } else { Some((lum, alpha)) }
}

pub fn extract_css_prop<'a>(style: &'a str, prop: &str) -> Option<&'a str> {
    let needle = format!("{prop}:");
    let mut search = 0;
    while let Some(rel) = style[search..].find(&needle) {
        let pos = search + rel;
        let boundary = pos == 0 || matches!(style.as_bytes()[pos - 1], b'"' | b';' | b' ');
        if boundary {
            let val_start = pos + needle.len();
            let val_end = style[val_start..].find([';', '"']).map_or(style.len(), |r| val_start + r);
            return Some(&style[val_start..val_end]);
        }
        search = pos + 1;
    }
    None
}

fn style_opacity(shape: &str) -> f64 {
    let mut product = 1.0;
    for prop in ["fill-opacity", "opacity"] {
        let needle = format!("{prop}:");
        let mut search = 0;
        while let Some(rel) = shape[search..].find(&needle) {
            let pos = search + rel;
            let boundary = pos == 0 || matches!(shape.as_bytes()[pos - 1], b'"' | b';');
            if boundary {
                let val_start = pos + needle.len();
                let val_end = shape[val_start..].find([';', '"']).map_or(shape.len(), |r| val_start + r);
                product *= amount(shape[val_start..val_end].trim(), 1.0);
            }
            search = pos + 1;
        }
    }
    product
}

pub fn ink_tone(shape: &str, text: &str) -> Option<InkTone> {
    let fill = extract_css_prop(shape, "fill")?;
    if extract_css_prop(text, "fill").is_some() {
        return None;
    }
    let (lum, alpha) = color_lum_alpha(fill)?;
    let eff = alpha * style_opacity(shape);
    if eff.is_nan() || eff < 0.5 {
        return None;
    }
    Some(if lum > even_luminance() { InkTone::OnLight } else { InkTone::OnDark })
}

pub fn ink<'a>(shape: &str, text: &str, theme: &'a SvgTheme) -> Option<&'a str> {
    ink_tone(shape, text).map(|tone| tone.paint(theme))
}

pub fn paints(shape: &str) -> bool {
    let Some(fill) = extract_css_prop(shape, "fill") else {
        return false;
    };
    let lower = fill.trim().to_ascii_lowercase();
    if lower.is_empty() || lower == "none" || lower == "transparent" {
        return false;
    }
    let scale = style_opacity(shape);
    let alpha = color_lum_alpha(&lower).map_or(1.0, |(_, a)| a);
    let eff = alpha * if scale.is_nan() { 1.0 } else { scale };
    eff > 0.0
}

pub fn ink_fill(shape: &str, text: &str, theme: &SvgTheme, fallback: Option<&str>) -> String {
    match ink(shape, text, theme).or(fallback) {
        Some(color) => format!(r#" fill="{color}""#),
        None => String::new(),
    }
}
