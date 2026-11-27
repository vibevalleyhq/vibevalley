use std::fmt::Write as _;

/// Pure-SVG builder that escapes all attribute values and text content, strips XML 1.0
/// illegal control characters, formats numbers cleanly, and emits zero `<foreignObject>`.
#[derive(Debug, Clone)]
pub(crate) struct SvgBuilder {
    buf: String,
    depth: usize,
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct Paint<'a> {
    pub fill: Option<&'a str>,
    pub fill_opacity: Option<f64>,
    pub stroke: Option<&'a str>,
    pub stroke_width: Option<f64>,
    pub stroke_opacity: Option<f64>,
    pub dash_array: Option<&'a str>,
    pub round_caps: bool,
}

impl<'a> Paint<'a> {
    pub(crate) const fn fill(color: &'a str) -> Self {
        Self {
            fill: Some(color),
            fill_opacity: None,
            stroke: None,
            stroke_width: None,
            stroke_opacity: None,
            dash_array: None,
            round_caps: false,
        }
    }

    pub(crate) const fn stroke(color: &'a str, width: f64) -> Self {
        Self {
            fill: None,
            fill_opacity: None,
            stroke: Some(color),
            stroke_width: Some(width),
            stroke_opacity: None,
            dash_array: None,
            round_caps: false,
        }
    }

    pub(crate) const fn fill_opacity(mut self, opacity: f64) -> Self {
        self.fill_opacity = Some(opacity);
        self
    }

    pub(crate) const fn with_stroke(mut self, color: &'a str, width: f64) -> Self {
        self.stroke = Some(color);
        self.stroke_width = Some(width);
        self
    }

    pub(crate) const fn stroke_opacity(mut self, opacity: f64) -> Self {
        self.stroke_opacity = Some(opacity);
        self
    }

    pub(crate) const fn dash(mut self, dash: Option<&'a str>) -> Self {
        self.dash_array = dash;
        self
    }

    pub(crate) const fn round_caps(mut self) -> Self {
        self.round_caps = true;
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TextAnchor {
    Start,
    Middle,
    End,
}

impl TextAnchor {
    fn as_str(self) -> &'static str {
        match self {
            TextAnchor::Start => "start",
            TextAnchor::Middle => "middle",
            TextAnchor::End => "end",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DominantBaseline {
    Auto,
    Central,
    Hanging,
}

impl DominantBaseline {
    fn as_str(self) -> &'static str {
        match self {
            DominantBaseline::Auto => "auto",
            DominantBaseline::Central => "central",
            DominantBaseline::Hanging => "hanging",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct TextStyle<'a> {
    pub fill: &'a str,
    pub font_size: f64,
    pub bold: bool,
    pub anchor: TextAnchor,
    pub baseline: DominantBaseline,
    pub rotate_deg: Option<f64>,
}

impl<'a> TextStyle<'a> {
    pub(crate) const fn new(fill: &'a str, font_size: f64) -> Self {
        Self {
            fill,
            font_size,
            bold: false,
            anchor: TextAnchor::Start,
            baseline: DominantBaseline::Auto,
            rotate_deg: None,
        }
    }

    pub(crate) const fn bold(mut self, bold: bool) -> Self {
        self.bold = bold;
        self
    }

    pub(crate) const fn anchor(mut self, anchor: TextAnchor) -> Self {
        self.anchor = anchor;
        self
    }

    pub(crate) const fn baseline(mut self, baseline: DominantBaseline) -> Self {
        self.baseline = baseline;
        self
    }

    pub(crate) const fn rotate(mut self, deg: Option<f64>) -> Self {
        self.rotate_deg = deg;
        self
    }
}

/// Outer end to round on a bar rectangle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BarRoundEnd {
    None,
    Top,
    Bottom,
    Right,
    Left,
}

impl SvgBuilder {
    pub(crate) fn new(width: f64, height: f64, aria_label: Option<&str>, font_family: &str) -> Self {
        let mut buf = String::with_capacity(4096);
        let w = fmt_num(width);
        let h = fmt_num(height);
        let _ = write!(
            buf,
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {w} {h}\" width=\"{w}\" height=\"{h}\" role=\"img\""
        );
        if let Some(label) = aria_label
            && !label.trim().is_empty()
        {
            buf.push_str(" aria-label=\"");
            push_escaped(&mut buf, label);
            buf.push('"');
        }
        buf.push_str(" font-family=\"");
        push_escaped(&mut buf, font_family);
        buf.push_str("\">\n");
        Self { buf, depth: 1 }
    }

    pub(crate) fn open_group(&mut self, role: &str) {
        self.indent();
        self.buf.push_str("<g data-role=\"");
        push_escaped(&mut self.buf, role);
        self.buf.push_str("\">\n");
        self.depth += 1;
    }

    pub(crate) fn open_group_with_name(&mut self, role: &str, name: &str) {
        self.indent();
        self.buf.push_str("<g data-role=\"");
        push_escaped(&mut self.buf, role);
        self.buf.push_str("\" data-series=\"");
        push_escaped(&mut self.buf, name);
        self.buf.push_str("\">\n");
        self.depth += 1;
    }

    pub(crate) fn close_group(&mut self) {
        self.depth = self.depth.saturating_sub(1);
        self.indent();
        self.buf.push_str("</g>\n");
    }

    pub(crate) fn title_element(&mut self, title: &str) {
        self.indent();
        self.buf.push_str("<title>");
        push_escaped(&mut self.buf, title);
        self.buf.push_str("</title>\n");
    }

    pub(crate) fn rect(&mut self, x: f64, y: f64, width: f64, height: f64, rx: Option<f64>, paint: Paint<'_>) {
        if width < 0.0 || height < 0.0 {
            return;
        }
        self.indent();
        let _ = write!(
            self.buf,
            "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\"",
            fmt_num(x),
            fmt_num(y),
            fmt_num(width),
            fmt_num(height)
        );
        if let Some(r) = rx
            && r > 0.0
        {
            let _ = write!(self.buf, " rx=\"{}\"", fmt_num(r));
        }
        self.write_paint(paint);
        self.buf.push_str("/>\n");
    }

    pub(crate) fn line(&mut self, x1: f64, y1: f64, x2: f64, y2: f64, paint: Paint<'_>) {
        self.indent();
        let _ = write!(
            self.buf,
            "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\"",
            fmt_num(x1),
            fmt_num(y1),
            fmt_num(x2),
            fmt_num(y2)
        );
        self.write_paint(paint);
        self.buf.push_str("/>\n");
    }

    pub(crate) fn circle(&mut self, cx: f64, cy: f64, r: f64, paint: Paint<'_>) {
        if r <= 0.0 {
            return;
        }
        self.indent();
        let _ = write!(self.buf, "<circle cx=\"{}\" cy=\"{}\" r=\"{}\"", fmt_num(cx), fmt_num(cy), fmt_num(r));
        self.write_paint(paint);
        self.buf.push_str("/>\n");
    }

    pub(crate) fn path(&mut self, d: &str, paint: Paint<'_>) {
        if d.is_empty() {
            return;
        }
        self.indent();
        self.buf.push_str("<path d=\"");
        push_escaped(&mut self.buf, d);
        self.buf.push('"');
        self.write_paint(paint);
        if paint.round_caps {
            self.buf.push_str(" stroke-linecap=\"round\" stroke-linejoin=\"round\"");
        }
        self.buf.push_str("/>\n");
    }

    pub(crate) fn polygon(&mut self, points: &[(f64, f64)], paint: Paint<'_>) {
        if points.len() < 3 {
            return;
        }
        self.indent();
        self.buf.push_str("<polygon points=\"");
        for (i, (x, y)) in points.iter().enumerate() {
            if i > 0 {
                self.buf.push(' ');
            }
            let _ = write!(self.buf, "{},{}", fmt_num(*x), fmt_num(*y));
        }
        self.buf.push('"');
        self.write_paint(paint);
        self.buf.push_str("/>\n");
    }

    pub(crate) fn text(&mut self, x: f64, y: f64, content: &str, style: TextStyle<'_>) {
        if content.is_empty() {
            return;
        }
        self.indent();
        let _ = write!(self.buf, "<text x=\"{}\" y=\"{}\" fill=\"", fmt_num(x), fmt_num(y));
        push_escaped(&mut self.buf, style.fill);
        let _ = write!(
            self.buf,
            "\" font-size=\"{}\" text-anchor=\"{}\"",
            fmt_num(style.font_size),
            style.anchor.as_str()
        );
        if style.bold {
            self.buf.push_str(" font-weight=\"600\"");
        }
        if style.baseline != DominantBaseline::Auto {
            let _ = write!(self.buf, " dominant-baseline=\"{}\"", style.baseline.as_str());
        }
        if let Some(deg) = style.rotate_deg
            && deg.abs() > 0.01
        {
            let _ = write!(self.buf, " transform=\"rotate({} {} {})\"", fmt_num(deg), fmt_num(x), fmt_num(y));
        }
        self.buf.push('>');
        push_escaped(&mut self.buf, content);
        self.buf.push_str("</text>\n");
    }

    pub(crate) fn finish(mut self) -> String {
        self.buf.push_str("</svg>\n");
        self.buf
    }

    fn indent(&mut self) {
        for _ in 0..self.depth {
            self.buf.push_str("  ");
        }
    }

    fn write_paint(&mut self, paint: Paint<'_>) {
        match paint.fill {
            Some(f) => {
                self.buf.push_str(" fill=\"");
                push_escaped(&mut self.buf, f);
                self.buf.push('"');
            }
            None => self.buf.push_str(" fill=\"none\""),
        }
        if let Some(op) = paint.fill_opacity
            && (op - 1.0).abs() > 1e-4
        {
            let _ = write!(self.buf, " fill-opacity=\"{}\"", fmt_num(op.clamp(0.0, 1.0)));
        }
        if let Some(s) = paint.stroke {
            self.buf.push_str(" stroke=\"");
            push_escaped(&mut self.buf, s);
            self.buf.push('"');
            if let Some(sw) = paint.stroke_width {
                let _ = write!(self.buf, " stroke-width=\"{}\"", fmt_num(sw));
            }
            if let Some(op) = paint.stroke_opacity
                && (op - 1.0).abs() > 1e-4
            {
                let _ = write!(self.buf, " stroke-opacity=\"{}\"", fmt_num(op.clamp(0.0, 1.0)));
            }
            if let Some(dash) = paint.dash_array {
                self.buf.push_str(" stroke-dasharray=\"");
                push_escaped(&mut self.buf, dash);
                self.buf.push('"');
            }
        }
    }
}

/// Builds a rectangle SVG path with rounded corners only on `end`.
pub(crate) fn rounded_bar_path(x: f64, y: f64, w: f64, h: f64, radius: f64, end: BarRoundEnd) -> String {
    if w <= 0.0 || h <= 0.0 {
        return String::new();
    }
    let r = match end {
        BarRoundEnd::None => 0.0,
        BarRoundEnd::Top | BarRoundEnd::Bottom => radius.max(0.0).min(w / 2.0).min(h),
        BarRoundEnd::Left | BarRoundEnd::Right => radius.max(0.0).min(h / 2.0).min(w),
    };
    let (x0, y0, x1, y1) = (x, y, x + w, y + h);
    if r <= 0.05 {
        return format!("M{} {}H{}V{}H{}Z", fmt_num(x0), fmt_num(y0), fmt_num(x1), fmt_num(y1), fmt_num(x0));
    }

    match end {
        BarRoundEnd::None => format!("M{} {}H{}V{}H{}Z", fmt_num(x0), fmt_num(y0), fmt_num(x1), fmt_num(y1), fmt_num(x0)),
        BarRoundEnd::Top => format!(
            "M{} {}L{} {}Q{} {} {} {}L{} {}Q{} {} {} {}L{} {}Z",
            fmt_num(x0),
            fmt_num(y1),
            fmt_num(x0),
            fmt_num(y0 + r),
            fmt_num(x0),
            fmt_num(y0),
            fmt_num(x0 + r),
            fmt_num(y0),
            fmt_num(x1 - r),
            fmt_num(y0),
            fmt_num(x1),
            fmt_num(y0),
            fmt_num(x1),
            fmt_num(y0 + r),
            fmt_num(x1),
            fmt_num(y1),
        ),
        BarRoundEnd::Bottom => format!(
            "M{} {}L{} {}L{} {}Q{} {} {} {}L{} {}Q{} {} {} {}Z",
            fmt_num(x0),
            fmt_num(y0),
            fmt_num(x1),
            fmt_num(y0),
            fmt_num(x1),
            fmt_num(y1 - r),
            fmt_num(x1),
            fmt_num(y1),
            fmt_num(x1 - r),
            fmt_num(y1),
            fmt_num(x0 + r),
            fmt_num(y1),
            fmt_num(x0),
            fmt_num(y1),
            fmt_num(x0),
            fmt_num(y1 - r),
        ),
        BarRoundEnd::Right => format!(
            "M{} {}L{} {}Q{} {} {} {}L{} {}Q{} {} {} {}L{} {}Z",
            fmt_num(x0),
            fmt_num(y0),
            fmt_num(x1 - r),
            fmt_num(y0),
            fmt_num(x1),
            fmt_num(y0),
            fmt_num(x1),
            fmt_num(y0 + r),
            fmt_num(x1),
            fmt_num(y1 - r),
            fmt_num(x1),
            fmt_num(y1),
            fmt_num(x1 - r),
            fmt_num(y1),
            fmt_num(x0),
            fmt_num(y1),
        ),
        BarRoundEnd::Left => format!(
            "M{} {}L{} {}Q{} {} {} {}L{} {}Q{} {} {} {}L{} {}Z",
            fmt_num(x1),
            fmt_num(y0),
            fmt_num(x0 + r),
            fmt_num(y0),
            fmt_num(x0),
            fmt_num(y0),
            fmt_num(x0),
            fmt_num(y0 + r),
            fmt_num(x0),
            fmt_num(y1 - r),
            fmt_num(x0),
            fmt_num(y1),
            fmt_num(x0 + r),
            fmt_num(y1),
            fmt_num(x1),
            fmt_num(y1),
        ),
    }
}

/// Formats SVG coordinates compactly (up to 2 decimal places, never `-0`, `NaN`, or `inf`).
pub(crate) fn fmt_num(v: f64) -> String {
    if !v.is_finite() {
        return "0".to_string();
    }
    let rounded = (v * 100.0).round() / 100.0;
    if rounded.abs() < 1e-9 {
        return "0".to_string();
    }
    let s = format!("{rounded:.2}");
    let trimmed = s.trim_end_matches('0').trim_end_matches('.');
    if trimmed == "-0" || trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Escapes XML metacharacters via `quick_xml::escape` and strips XML 1.0 illegal control characters.
pub(crate) fn push_escaped(out: &mut String, input: &str) {
    let cleaned: String = input
        .chars()
        .filter(|&c| matches!(c, '\t' | '\n' | '\r') || ((c as u32) >= 0x20 && c != '\u{7F}'))
        .collect();
    out.push_str(&quick_xml::escape::escape(&cleaned));
}
