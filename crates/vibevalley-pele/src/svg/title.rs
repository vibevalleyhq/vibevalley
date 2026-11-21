use crate::measure::{TextMeasurer, TextStyle};
use crate::svg::builder::{label_svg, num};
use crate::svg::theme::SvgTheme;
use crate::text::label::{Label, layout_label};

/// Mermaid renders diagram titles as plain text without math typesetting.
pub fn title_label(title: Option<&str>, measurer: &dyn TextMeasurer, size: f64, max_width: f64) -> Label {
    layout_label(title, false, measurer, size, max_width, TextStyle::BOLD, None, None)
}

pub struct Titled {
    pub width: f64,
    pub height: f64,
    pub content: String,
}

#[allow(clippy::too_many_arguments)]
pub fn with_title(title: Option<&str>, measurer: &dyn TextMeasurer, size: f64, pad: f64, width: f64, height: f64, content: String, theme: &SvgTheme) -> Titled {
    let label = title_label(title, measurer, size, 4000.0);
    if label.height == 0.0 {
        return Titled { width, height, content };
    }
    let shift = label.height + 12.0;
    let full = width.max((label.width + 2.0 * pad).ceil());
    let attrs = format!(r#" class="pele-title" font-weight="{}""#, theme.title_weight());
    Titled {
        width: full,
        height: (height + shift).ceil(),
        content: format!(
            r#"{}<g transform="translate({},{})">{content}</g>"#,
            label_svg(&label, full / 2.0, pad + label.height / 2.0, &attrs, theme, None),
            num((full - width) / 2.0),
            num(shift)
        ),
    }
}
