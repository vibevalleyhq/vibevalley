use crate::measure::{TextMeasurer, TextStyle};
use crate::svg::builder::{esc, label_svg, num, shared_style, span_style, text_style};
use crate::svg::theme::SvgTheme;
use crate::text::label::{Label, Span, with_heights};

/// Wraps literal text while preserving every non-breaking character.
pub fn literal_label(text: &str, measurer: &dyn TextMeasurer, size: f64, room: f64, style: TextStyle) -> Label {
    if text.is_empty() {
        return Label {
            lines: Vec::new(),
            widths: Vec::new(),
            width: 0.0,
            height: 0.0,
            size,
            line_height: (size * 1.5).round(),
            heights: None,
        };
    }
    let mut lines_text: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let chars: Vec<char> = raw.chars().collect();
        if chars.is_empty() {
            lines_text.push(String::new());
        }
        let mut from = 0usize;
        while from < chars.len() {
            let fits = |len: usize| -> bool {
                let s: String = chars[from..from + len].iter().collect();
                measurer.width(&s, size, style) <= room
            };
            let mut hi = 1usize;
            while hi < chars.len() - from && fits(hi) {
                hi = (chars.len() - from).min(hi * 2);
            }
            let mut lo = 1usize;
            while lo < hi {
                let mid = (lo + hi).div_ceil(2);
                if fits(mid) {
                    lo = mid;
                } else {
                    hi = mid - 1;
                }
            }
            let mut take = lo;
            let wraps = from + take < chars.len();
            if wraps && !chars[from + take].is_whitespace() {
                for i in (1..take).rev() {
                    if chars[from + i].is_whitespace() {
                        take = i + 1;
                        break;
                    }
                }
            }
            let line: String = chars[from..from + take].iter().collect();
            if wraps {
                let trimmed = line.trim_end();
                lines_text.push(if trimmed.is_empty() { line } else { trimmed.to_string() });
            } else {
                lines_text.push(line);
            }
            from += take;
            while wraps && from < chars.len() && chars[from].is_whitespace() {
                from += 1;
            }
        }
    }
    let widths: Vec<f64> = lines_text.iter().map(|l| measurer.width(l, size, style)).collect();
    let width = widths.iter().copied().fold(0.0f64, f64::max);
    let line_height = (size * 1.5).round();
    let lines = lines_text
        .into_iter()
        .zip(widths.iter().copied())
        .map(|(l, w)| vec![Span::plain(l, style, w)])
        .collect::<Vec<_>>();
    Label {
        height: lines.len() as f64 * line_height,
        lines,
        widths,
        width,
        size,
        line_height,
        heights: None,
    }
}

/// Hard-breaks any line in `label` that still exceeds `room` between code points.
pub fn break_label(label: Label, measurer: &dyn TextMeasurer, room: f64) -> Label {
    if label.width <= room {
        return label;
    }
    let has_heights = label.heights.is_some();
    let mut lines: Vec<Vec<Span>> = Vec::new();
    let mut widths: Vec<f64> = Vec::new();
    for (i, line) in label.lines.iter().enumerate() {
        if label.widths[i] <= room {
            lines.push(line.clone());
            widths.push(label.widths[i]);
            continue;
        }
        let mut current: Vec<Span> = Vec::new();
        let mut width = 0.0;
        let commit = |current: &mut Vec<Span>, width: &mut f64, lines: &mut Vec<Vec<Span>>, widths: &mut Vec<f64>| {
            lines.push(std::mem::take(current));
            widths.push(*width);
            *width = 0.0;
        };
        for span in line {
            if span.icon.is_some() || span.math.is_some() {
                if !current.is_empty() && width + span.width > room {
                    commit(&mut current, &mut width, &mut lines, &mut widths);
                }
                width += span.width;
                current.push(span.clone());
                continue;
            }
            for ch in span.text.chars() {
                let joined = current.last().is_some_and(|l| l.is_plain() && l.style == span.style);
                let next_width = if joined {
                    let last = current.last().unwrap();
                    let mut buf = String::with_capacity(last.text.len() + ch.len_utf8());
                    buf.push_str(&last.text);
                    buf.push(ch);
                    measurer.width(&buf, label.size, span.style)
                } else {
                    let mut buf = [0u8; 4];
                    measurer.width(ch.encode_utf8(&mut buf), label.size, span.style)
                };
                let mut added = next_width - if joined { current.last().unwrap().width } else { 0.0 };
                if !current.is_empty() && width + added > room {
                    commit(&mut current, &mut width, &mut lines, &mut widths);
                    let mut buf = [0u8; 4];
                    added = measurer.width(ch.encode_utf8(&mut buf), label.size, span.style);
                }
                if let Some(last) = current.last_mut()
                    && last.is_plain()
                    && last.style == span.style
                {
                    last.text.push(ch);
                    last.width += added;
                } else {
                    current.push(Span::plain(ch.to_string(), span.style, added));
                }
                width += added;
            }
        }
        if !current.is_empty() || line.is_empty() {
            commit(&mut current, &mut width, &mut lines, &mut widths);
        }
    }
    let width = widths.iter().copied().fold(0.0f64, f64::max);
    let broken = Label {
        height: lines.len() as f64 * label.line_height,
        lines,
        widths,
        width,
        size: label.size,
        line_height: label.line_height,
        heights: None,
    };
    if has_heights { with_heights(broken) } else { broken }
}

pub fn left_label_svg(label: &Label, x: f64, top: f64, attrs: &str, theme: &SvgTheme) -> String {
    let shared = shared_style(label);
    let open = format!("<text{}", text_style(attrs, shared, theme));
    let mut body = String::new();
    for (i, spans) in label.lines.iter().enumerate() {
        let cy = top + (i as f64 + 0.5) * label.line_height;
        if spans.iter().any(|s| s.icon.is_some()) {
            let single = label.single_line(i);
            body.push_str(&label_svg(&single, x + single.width / 2.0, cy, attrs, theme, None));
            continue;
        }
        let mut text = String::new();
        for span in spans {
            let own = span_style(span.style & !shared, theme);
            if own.is_empty() {
                text.push_str(&esc(&span.text));
            } else {
                text.push_str(&format!("<tspan{own}>{}</tspan>", esc(&span.text)));
            }
        }
        if !text.is_empty() {
            body.push_str(&format!(
                r#"{open} x="{}" y="{}" text-anchor="start" xml:space="preserve">{text}</text>"#,
                num(x),
                num(cy + label.size * 0.35),
            ));
        }
    }
    body
}
