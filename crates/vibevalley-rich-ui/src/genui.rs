//! Native `VvGenUi` component backed by the pluggable [`crate::hooks::GenUiRenderer`] trait.
//!
//! Allows `vibevalley-genui` to mount rich interactive `nsh_core` surfaces directly inside
//! Markdown (` ```genui `) or standalone views while emitting typed string actions.

use nsh_core::prelude::*;

use crate::code_block::vv_code_block;
use crate::hooks::{GenUiActionSink, active_genui_renderer};
use crate::theme::AdaptiveUi;

/// Props of [`VvGenUi`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub struct VvGenUiProps {
    /// Generative UI specification string consumed by `vibevalley-genui`.
    pub spec: Prop<SharedString>,
}

/// Payload emitted when an interactive control inside [`VvGenUi`] triggers an action.
#[derive(Debug, Clone, Default, PartialEq, Eq, JsObject)]
pub struct VvGenUiActionEvent {
    /// Logical action identifier declared in the GenUI specification.
    pub action: SharedString,
    /// Serialized string payload associated with the action.
    pub payload: SharedString,
}

/// Events emitted by [`VvGenUi`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum VvGenUiEvent {
    /// Fired when a rendered GenUI element dispatches a typed user action.
    #[args(event)]
    Action(VvGenUiActionEvent),
}

/// Native generative UI surface delegating to the registered [`crate::hooks::GenUiRenderer`].
///
/// Falls back cleanly to a readable JSON code block when no renderer is installed yet or when
/// the specification fails decoding.
#[component]
pub fn VvGenUi(props: VvGenUiProps, cx: Scope<VvGenUiEvent>) -> impl IntoElement {
    view().test_id("genui").flex_col().my(px(8.0)).max_w(relative(1.0)).child(dynamic(move || {
        let spec = props.spec.get();
        let is_dark = dark();

        match active_genui_renderer() {
            Some(renderer) => {
                let sink = GenUiActionSink::new(move |act| {
                    cx.emit(VvGenUiEvent::Action(VvGenUiActionEvent {
                        action: act.action,
                        payload: act.payload,
                    }));
                });
                match renderer.render_element(spec.as_str(), is_dark, sink) {
                    Ok(el) => view().test_id("genui-surface").flex_col().max_w(relative(1.0)).child(el).into_element(),
                    Err(err) => view()
                        .flex_col()
                        .gap(px(4.0))
                        .child(vv_code_block().code(spec).language(Some(SharedString::from("json"))))
                        .child(text(err).test_id("genui-error").text_size(px(12.0)).text_color(AdaptiveUi::BERRY))
                        .into_element(),
                }
            }
            None => view()
                .test_id("genui-placeholder")
                .flex_col()
                .gap(px(4.0))
                .child(text("GenUI").text_size(px(12.0)).font_weight(FontWeight::MEDIUM).text_color(AdaptiveUi::MUTED))
                .child(vv_code_block().code(spec).language(Some(SharedString::from("json"))))
                .into_element(),
        }
    }))
}
