use crate::Rendered;
use crate::diagram::RenderContext;
use crate::measure::TextStyle;
use crate::svg::builder::label_svg;
use crate::svg::root::{Accessible, svg_document};
use crate::text::label::layout_label;

use super::model::InfoModel;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn render_info(model: &InfoModel, ctx: &RenderContext<'_>) -> Rendered {
    let size = ctx.options.font_size.unwrap_or(16.0);
    let pad = ctx.options.padding.unwrap_or(8.0);

    let title = layout_label(model.title.as_deref(), false, ctx.measurer, size, 4000.0, TextStyle::BOLD, ctx.icons, None);
    let title_height = if title.height > 0.0 { title.height + 8.0 } else { 0.0 };
    let version_text = format!("Pele v{VERSION}");
    let text = layout_label(Some(&version_text), false, ctx.measurer, size, 4000.0, TextStyle::NONE, ctx.icons, None);

    let width = (title.width.max(text.width) + 2.0 * pad).ceil();
    let height = (title_height + text.height + 2.0 * pad).ceil();
    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let ver_attrs = format!(r#" class="pele-version" fill="{}""#, ctx.theme.muted());
    let content = format!(
        "{}{}",
        label_svg(&title, width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, ctx.icons),
        label_svg(&text, width / 2.0, pad + title_height + text.height / 2.0, &ver_attrs, ctx.theme, ctx.icons),
    );

    let svg = svg_document(
        "info",
        width,
        height,
        size,
        ctx.options,
        ctx.responsive,
        ctx.theme,
        ctx.palette,
        Accessible {
            acc_title: model.acc_title.as_deref(),
            acc_descr: model.acc_descr.as_deref(),
        },
        &content,
    );
    Rendered {
        svg,
        width,
        height,
        links: Vec::new(),
    }
}
