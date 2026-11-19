//! Native `VvChart` component backed by the pluggable [`crate::hooks::ChartRenderer`] trait.
//!
//! Renders resvg-safe SVGs via `image(ImageSrc::svg_markup(&svg).size(...))` once
//! `vibevalley-chart` registers its [`crate::hooks::ChartRenderer`], and presents a clean,
//! readable fallback showing the raw chart specification otherwise or on decode errors.

use nsh_core::element::ImageSrc;
use nsh_core::prelude::*;

use crate::code_block::vv_code_block;
use crate::hooks::active_chart_renderer;
use crate::theme::AdaptiveUi;

/// Props of [`VvChart`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub struct VvChartProps {
    /// Chart specification text (JSON / YAML chart spec consumed by `vibevalley-chart`).
    pub spec: Prop<SharedString>,
    /// Optional caption or fallback title for accessibility and placeholder display.
    pub title: Prop<Option<SharedString>>,
}

/// Native chart view delegating to the registered [`crate::hooks::ChartRenderer`].
///
/// Renders via `ImageSrc::svg_markup` with intrinsic sizing so labels rasterize crisply,
/// falling back cleanly to a labeled code block when no chart renderer is installed yet
/// or when the chart specification fails validation.
#[component]
pub fn VvChart(props: VvChartProps) -> impl IntoElement {
    view().test_id("chart").flex_col().my(px(8.0)).max_w(relative(1.0)).child(dynamic(move || {
        let spec = props.spec.get();
        let title = props.title.get();
        let is_dark = dark();
        let fallback_label = title.clone().unwrap_or_else(|| SharedString::from("Chart"));

        match active_chart_renderer() {
            Some(renderer) => match renderer.render_svg(spec.as_str(), is_dark) {
                Ok(rendered) => {
                    let width = rendered.width.max(1.0);
                    let height = rendered.height.max(1.0);
                    let label = rendered.label.map(SharedString::from).unwrap_or(fallback_label);
                    let src = ImageSrc::svg_markup(&rendered.svg).size(Size::new(px(width), px(height)));
                    image(src)
                        .test_id("chart-image")
                        .role(AccessibilityRole::Image)
                        .accessible(true)
                        .label(label)
                        .w(px(width))
                        .max_w(relative(1.0))
                        .aspect_ratio(width / height)
                        .into_element()
                }
                Err(err) => view()
                    .flex_col()
                    .gap(px(4.0))
                    .child(vv_code_block().code(spec).language(Some(SharedString::from("json"))))
                    .child(text(err).test_id("chart-error").text_size(px(12.0)).text_color(AdaptiveUi::BERRY))
                    .into_element(),
            },
            None => view()
                .test_id("chart-placeholder")
                .flex_col()
                .gap(px(4.0))
                .child(
                    text(fallback_label)
                        .text_size(px(12.0))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(AdaptiveUi::MUTED),
                )
                .child(vv_code_block().code(spec).language(Some(SharedString::from("json"))))
                .into_element(),
        }
    }))
}
