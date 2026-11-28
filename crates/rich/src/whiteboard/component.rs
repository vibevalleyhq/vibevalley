use nsh_core::prelude::*;

use super::dock::build_bottom_hud;
use super::hud::{build_follow_banner, build_style_bar, build_top_left_hud, build_top_right_hud};
use super::inline_editor::build_inline_editor_overlay;
use super::inspector::build_inspector_drawer;
use super::overlays::{
    build_context_menu_overlay, build_export_popover, build_starter_overlay, build_sticker_popover, build_template_popover, build_timer_popover,
};
use super::props::{VvWhiteboardEvent, VvWhiteboardProps};
use super::stage::build_stage;
use super::state::{WbState, map_mods};

/// Interactive native whiteboard canvas with single-pass rendering, dock tools, minimap, and inspector.
#[component]
pub fn VvWhiteboard(props: VvWhiteboardProps, cx: Scope<VvWhiteboardEvent>) -> impl IntoElement {
    let st = WbState::new(props, cx);
    st.attach_remote_sync_effect();

    let stage = build_stage(&st);
    let top_left_hud = build_top_left_hud(&st);
    let top_right_hud = build_top_right_hud(&st);
    let follow_banner = build_follow_banner(&st);
    let template_popover = build_template_popover(&st);
    let style_bar = build_style_bar(&st);
    let bottom_hud = build_bottom_hud(&st);
    let sticker_popover = build_sticker_popover(&st);
    let inline_editor_overlay = build_inline_editor_overlay(&st);
    let context_menu_overlay = build_context_menu_overlay(&st);
    let starter_overlay = build_starter_overlay(&st);
    let timer_popover = build_timer_popover(&st);
    let export_popover = build_export_popover(&st);
    let inspector_drawer = build_inspector_drawer(&st);

    let board_stage_wrapper = view()
        .relative()
        .flex_1()
        .min_w(px(0.0))
        .min_h(px(0.0))
        .overflow_hidden()
        .child(stage)
        .child(top_left_hud)
        .child(follow_banner)
        .child(top_right_hud)
        .child(timer_popover)
        .child(export_popover)
        .child(template_popover)
        .child(bottom_hud)
        .child(style_bar)
        .child(sticker_popover)
        .child(inline_editor_overlay)
        .child(context_menu_overlay)
        .child(
            view()
                .absolute()
                .inset(px(0.0))
                .items_center()
                .justify_center()
                .pointer_events(PointerEvents::BoxNone)
                .child(starter_overlay),
        );

    let st_down = st.clone();
    let space_held = st.space_held;

    view()
        .test_id("whiteboard-native-root")
        .flex_row()
        .w_full()
        .h_full()
        .min_h(px(0.0))
        .min_w(px(0.0))
        .focusable(true)
        .on_key_down(move |e: &KeyEvent| {
            if e.key == " " || e.code == "Space" {
                st_down.space_held.set(true);
            }
            if st_down.inline_edit.get_untracked().is_some() {
                if e.key == "Escape" {
                    st_down.cancel_inline();
                } else if (e.modifiers.cmd || e.modifiers.ctrl) && e.key == "Enter" {
                    st_down.commit_inline();
                }
                return;
            }
            if st_down.inspector_focused.get_untracked() || e.default_prevented {
                return;
            }
            if st_down.props.read_only.get_untracked() && !matches!(e.key.as_str(), "Escape" | "0" | "1" | "2" | "v" | "h") {
                return;
            }
            let effs = st_down
                .controller
                .borrow_mut()
                .handle_key_down(e.key.as_str(), map_mods(&e.modifiers, st_down.space_held.get_untracked()));
            st_down.dispatch_effects(effs, true, false);
        })
        .on_key_up(move |e: &KeyEvent| {
            if e.key == " " || e.code == "Space" {
                space_held.set(false);
            }
        })
        .child(board_stage_wrapper)
        .child(inspector_drawer)
}
