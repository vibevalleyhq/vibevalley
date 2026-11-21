use crate::IconResolver;
use crate::measure::TextStyle;
use crate::svg::ink::extract_css_prop;
use crate::svg::theme::SvgTheme;
use crate::text::entities::decode_entities;
use crate::text::label::Label;

#[inline]
pub fn is_invalid_xml_char(c: char) -> bool {
    let code = c as u32;
    (code <= 0x08) || code == 0x0b || code == 0x0c || (0x0e..=0x1f).contains(&code) || code == 0x7f || code == 0xfffe || code == 0xffff
}

pub fn has_invalid_xml_char(text: &str) -> bool {
    text.chars().any(is_invalid_xml_char)
}

/// Escapes text for XML and strips invalid XML control characters.
pub fn esc(text: &str) -> String {
    if !text.chars().any(|c| matches!(c, '&' | '<' | '>' | '"') || is_invalid_xml_char(c)) {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len() + 8);
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c if is_invalid_xml_char(c) => {}
            c => out.push(c),
        }
    }
    out
}

/// Decodes Mermaid/HTML entities first, then XML-escapes for display text, tooltips, and `data-id`.
pub fn esc_text(text: &str) -> String {
    esc(&decode_entities(text))
}

/// Formats coordinates rounded to two decimals matching Pele's `num()`.
pub fn num(value: f64) -> String {
    let n = (value * 100.0).round();
    if n == 0.0 || !n.is_finite() {
        return "0".to_string();
    }
    if n.abs() < 1e11 {
        let neg = n < 0.0;
        let m = n.abs() as u64;
        let q = m / 100;
        let frac = m % 100;
        let sign = if neg { "-" } else { "" };
        if frac == 0 {
            format!("{sign}{q}")
        } else if frac.is_multiple_of(10) {
            format!("{sign}{q}.{}", frac / 10)
        } else {
            format!("{sign}{q}.{frac:02}")
        }
    } else {
        format!("{}", n / 100.0)
    }
}

pub fn span_style(style: TextStyle, theme: &SvgTheme) -> String {
    let mut out = String::new();
    if style.contains(TextStyle::BOLD) {
        out.push_str(&format!(r#" font-weight="{}""#, theme.bold_weight()));
    }
    if style.contains(TextStyle::ITALIC) {
        out.push_str(r#" font-style="italic""#);
    }
    if style.contains(TextStyle::MONO) {
        out.push_str(&format!(r#" font-family="{}""#, theme.font_mono()));
    }
    if style.contains(TextStyle::UNDERLINE) {
        out.push_str(r#" text-decoration="underline""#);
    }
    if style.contains(TextStyle::SUB) {
        out.push_str(r#" baseline-shift="sub" font-size="smaller""#);
    } else if style.contains(TextStyle::SUP) {
        out.push_str(r#" baseline-shift="super" font-size="smaller""#);
    }
    out
}

pub fn shared_style(label: &Label) -> TextStyle {
    let mut shared = TextStyle::BOLD | TextStyle::ITALIC | TextStyle::MONO;
    let mut any = false;
    for line in &label.lines {
        for span in line {
            if span.icon.is_some() || span.text.is_empty() {
                continue;
            }
            shared = shared & span.style;
            any = true;
        }
    }
    if any { shared } else { TextStyle::NONE }
}

pub fn text_style(attrs: &str, shared: TextStyle, theme: &SvgTheme) -> String {
    let mut out = attrs.to_string();
    if shared.contains(TextStyle::BOLD) && !attrs.contains(r#" font-weight=""#) {
        out.push_str(&format!(r#" font-weight="{}""#, theme.bold_weight()));
    }
    if shared.contains(TextStyle::ITALIC) && !attrs.contains(r#" font-style=""#) {
        out.push_str(r#" font-style="italic""#);
    }
    if shared.contains(TextStyle::MONO) && !attrs.contains(r#" font-family=""#) {
        out.push_str(&format!(r#" font-family="{}""#, theme.font_mono()));
    }
    out
}

fn extract_attr<'a>(attrs: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!(r#" {name}=""#);
    let start = attrs.find(&needle)? + needle.len();
    let end = attrs[start..].find('"')? + start;
    Some(&attrs[start..end])
}

struct MathLook {
    attrs: String,
    halo: Option<String>,
}

fn math_look(attrs: &str) -> MathLook {
    let style = extract_attr(attrs, "style").unwrap_or("");
    let fill = extract_css_prop(style, "fill").or_else(|| extract_attr(attrs, "fill")).unwrap_or("").trim();
    if fill == "none" {
        let stroke = extract_attr(attrs, "stroke").unwrap_or("none").to_string();
        return MathLook {
            attrs: String::new(),
            halo: Some(stroke),
        };
    }
    let opacity = extract_css_prop(style, "opacity").map(str::trim);
    let mut out = String::new();
    if !fill.is_empty() {
        out.push_str(&format!(r#" color="{fill}""#));
    }
    if let Some(op) = opacity
        && !op.is_empty()
    {
        out.push_str(&format!(r#" opacity="{op}""#));
    }
    MathLook { attrs: out, halo: None }
}

/// Writes a measured label as pure SVG `<text>` / `<tspan>` centered on `(cx, cy)`.
/// Never emits `<foreignObject>`.
pub fn label_svg(label: &Label, cx: f64, cy: f64, attrs: &str, theme: &SvgTheme, icons: Option<&IconResolver<'_>>) -> String {
    if label.lines.is_empty() {
        return String::new();
    }
    let lh = label.line_height;
    let shift = label.size * 0.35;
    let mut top = cy - label.height / 2.0;

    if label.lines.len() == 1 && label.lines[0].len() == 1 {
        let only = &label.lines[0][0];
        if only.icon.is_none() && only.math.is_none() && only.style.is_empty() {
            return format!(
                r#"<text{attrs} x="{}" y="{}" text-anchor="middle">{}</text>"#,
                num(cx),
                num(top + lh / 2.0 + shift),
                esc(&only.text)
            );
        }
    }

    let shared = shared_style(label);
    let given = attrs;
    let mut math_info: Option<MathLook> = None;
    let resolved_attrs = text_style(attrs, shared, theme);
    let mut body = String::new();
    let mut extra = String::new();

    for (i, line) in label.lines.iter().enumerate() {
        let h = label.heights.as_ref().map_or(lh, |hs| hs[i]);
        let mid = top + h / 2.0;
        let y = mid + shift;
        let placed = line.iter().any(|s| s.icon.is_some() || s.math.is_some());
        if placed {
            let mut x = cx - label.widths[i] / 2.0;
            for span in line {
                if let Some(math) = &span.math {
                    let box_attrs = format!(
                        r#"x="{}" y="{}" width="{}" height="{}""#,
                        num(x),
                        num(mid - math.height / 2.0),
                        num(math.width),
                        num(math.height)
                    );
                    let look = math_info.get_or_insert_with(|| math_look(given));
                    if let Some(halo) = &look.halo {
                        extra.push_str(&format!(r#"<rect {box_attrs} rx="2" fill="{halo}"/>"#));
                    } else {
                        extra.push_str(&format!(
                            r#"<svg class="pele-math" {box_attrs} overflow="visible"{}>{}</svg>"#,
                            look.attrs, math.svg
                        ));
                    }
                } else if let Some(icon) = &span.icon {
                    let side = label.size * 1.1;
                    let inner = icons.and_then(|f| f(icon)).unwrap_or_default();
                    extra.push_str(&format!(
                        r#"<svg class="pele-icon" data-icon="{}" x="{}" y="{}" width="{}" height="{}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{inner}</svg>"#,
                        esc_text(icon),
                        num(x),
                        num(mid - side / 2.0),
                        num(side),
                        num(side)
                    ));
                } else if !span.text.is_empty() {
                    body.push_str(&format!(
                        r#"<tspan x="{}" y="{}" text-anchor="start"{}>{}</tspan>"#,
                        num(x),
                        num(y),
                        span_style(span.style & !shared, theme),
                        esc(&span.text)
                    ));
                }
                x += span.width;
            }
        } else {
            for (j, span) in line.iter().enumerate() {
                let pos = if j == 0 {
                    format!(r#" x="{}" y="{}""#, num(cx), num(y))
                } else {
                    String::new()
                };
                body.push_str(&format!("<tspan{pos}{}>{}</tspan>", span_style(span.style & !shared, theme), esc(&span.text)));
            }
            if line.is_empty() {
                body.push_str(&format!(r#"<tspan x="{}" y="{}"> </tspan>"#, num(cx), num(y)));
            }
        }
        top += h;
    }

    format!(r#"<text{resolved_attrs} text-anchor="middle" xml:space="preserve">{body}</text>{extra}"#)
}
