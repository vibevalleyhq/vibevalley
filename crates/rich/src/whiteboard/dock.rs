use nsh_core::prelude::*;
use vibevalley_i18n::t_in;

use crate::engine::whiteboard::{BoardAction, ControllerEffect, ShapeKind, Tool, paint_minimap_painter};
use crate::theme::AdaptiveUi;

use super::chrome::{
    ICON_ARROW, ICON_CARD, ICON_CURSOR, ICON_ERASER, ICON_FRAME, ICON_HAND, ICON_HIGHLIGHTER, ICON_PEN, ICON_RECT, ICON_STICKER, ICON_STICKY, ICON_TABLE,
    ICON_TEXT, ICON_TIMELINE, floating_card, floating_pill, pill_divider, pill_icon_btn, pill_text_btn,
};
use super::state::{ToolKindTag, WbState};

fn build_bottom_dock(st: &WbState) -> impl IntoElement {
    let st = st.clone();
    dynamic(move || {
        let snap = st.ui_snap.get();
        let ro = st.props.read_only.get();
        let l = st.loc_str();
        let is_en = l.starts_with("en");

        let mut dock = floating_pill()
            .test_id("wb-bottom-dock")
            .max_w(relative(1.0))
            .min_w(px(0.0))
            .gap(px(2.0))
            .px(px(6.0))
            .py(px(4.0))
            .flex_wrap()
            .child(pill_icon_btn(
                "wb-tool-select",
                &t_in(l.as_str(), "web.note.whiteboard.select", &[]),
                ICON_CURSOR,
                snap.tool == ToolKindTag::Select,
                false,
                {
                    let st = st.clone();
                    move || st.set_tool(Tool::Select)
                },
            ))
            .child(pill_icon_btn(
                "wb-tool-pan",
                &t_in(l.as_str(), "web.note.whiteboard.pan", &[]),
                ICON_HAND,
                snap.tool == ToolKindTag::Hand,
                false,
                {
                    let st = st.clone();
                    move || st.set_tool(Tool::Hand)
                },
            ));

        if !ro {
            dock = dock
                .child(pill_divider())
                .child(pill_icon_btn(
                    "wb-tool-text",
                    &t_in(l.as_str(), "web.note.whiteboard.text", &[]),
                    ICON_TEXT,
                    snap.tool == ToolKindTag::Text,
                    false,
                    {
                        let st = st.clone();
                        move || st.set_tool(Tool::Text)
                    },
                ))
                .child(pill_icon_btn(
                    "wb-add-frame",
                    &t_in(l.as_str(), "web.note.whiteboard.container", &[]),
                    ICON_FRAME,
                    snap.tool == ToolKindTag::Container,
                    false,
                    {
                        let st = st.clone();
                        move || st.set_tool(Tool::Container)
                    },
                ))
                .child(pill_icon_btn(
                    "wb-add-node",
                    &t_in(l.as_str(), "web.note.whiteboard.card", &[]),
                    ICON_CARD,
                    snap.tool == ToolKindTag::Card,
                    false,
                    {
                        let st = st.clone();
                        move || st.set_tool(Tool::Card)
                    },
                ))
                .child(pill_icon_btn(
                    "wb-tool-sticky",
                    &t_in(l.as_str(), "web.note.whiteboard.sticky", &[]),
                    ICON_STICKY,
                    snap.tool == ToolKindTag::Sticky,
                    false,
                    {
                        let st = st.clone();
                        move || st.set_tool(Tool::Sticky)
                    },
                ))
                .child(pill_icon_btn(
                    "wb-tool-rect",
                    &t_in(l.as_str(), "web.note.whiteboard.rect", &[]),
                    ICON_RECT,
                    snap.tool == ToolKindTag::Rect,
                    false,
                    {
                        let st = st.clone();
                        move || st.set_tool(Tool::Shape(ShapeKind::Rect))
                    },
                ))
                .child(pill_icon_btn(
                    "wb-tool-arrow",
                    &t_in(l.as_str(), "web.note.whiteboard.arrow", &[]),
                    ICON_ARROW,
                    snap.tool == ToolKindTag::Arrow,
                    false,
                    {
                        let st = st.clone();
                        move || st.set_tool(Tool::Arrow)
                    },
                ))
                .child(pill_icon_btn(
                    "wb-tool-timeline",
                    &t_in(l.as_str(), "web.note.whiteboard.timeline", &[]),
                    ICON_TIMELINE,
                    snap.tool == ToolKindTag::Timeline,
                    false,
                    {
                        let st = st.clone();
                        move || st.set_tool(Tool::Timeline)
                    },
                ))
                .child(pill_icon_btn(
                    "wb-tool-table",
                    if is_en { "Table" } else { "表格" },
                    ICON_TABLE,
                    snap.tool == ToolKindTag::Table,
                    false,
                    {
                        let st = st.clone();
                        move || st.set_tool(Tool::Table)
                    },
                ))
                .child(pill_divider())
                .child(pill_icon_btn(
                    "wb-tool-pen",
                    &t_in(l.as_str(), "web.note.whiteboard.pen", &[]),
                    ICON_PEN,
                    snap.tool == ToolKindTag::Pen,
                    false,
                    {
                        let st = st.clone();
                        move || st.set_tool(Tool::Pen)
                    },
                ))
                .child(pill_icon_btn(
                    "wb-tool-highlighter",
                    if is_en { "Highlighter" } else { "荧光笔" },
                    ICON_HIGHLIGHTER,
                    snap.tool == ToolKindTag::Highlighter,
                    false,
                    {
                        let st = st.clone();
                        move || st.set_tool(Tool::Highlighter)
                    },
                ))
                .child(pill_icon_btn(
                    "wb-tool-eraser",
                    if is_en { "Eraser" } else { "橡皮擦" },
                    ICON_ERASER,
                    snap.tool == ToolKindTag::Eraser,
                    false,
                    {
                        let st = st.clone();
                        move || st.set_tool(Tool::Eraser)
                    },
                ))
                .child(pill_icon_btn(
                    "wb-tool-sticker",
                    &t_in(l.as_str(), "web.note.whiteboard.sticker", &[]),
                    ICON_STICKER,
                    st.sticker_picker_open.get() || snap.tool == ToolKindTag::Sticker,
                    false,
                    {
                        let st = st.clone();
                        move || {
                            st.template_picker_open.set(false);
                            st.sticker_picker_open.set(!st.sticker_picker_open.get_untracked());
                        }
                    },
                ));
        }

        dock = dock.child(pill_divider()).child(
            view()
                .test_id("wb-chat")
                .role(AccessibilityRole::Button)
                .flex_row()
                .items_center()
                .gap(px(4.0))
                .rounded(px(999.0))
                .bg(AdaptiveUi::ACCENT)
                .px(px(10.0))
                .py(px(4.0))
                .cursor_pointer()
                .on_press({
                    let st = st.clone();
                    move |_: &PressEvent| st.run_action(BoardAction::AskOrchestrator)
                })
                .child(
                    text(t_in(l.as_str(), "web.note.whiteboard.chatWithOrchestrator", &[]))
                        .text_size(px(11.5))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(AdaptiveColor {
                            light: rgb(0xfefefe).to_hsla(),
                            dark: rgb(0x151413).to_hsla(),
                        }),
                ),
        );

        dock.into_element()
    })
}

fn build_minimap_and_zoom(st: &WbState) -> View {
    let mw = 152.0_f32;
    let mh = 96.0_f32;

    let minimap_panel = {
        let st = st.clone();
        dynamic(move || {
            if !st.minimap_open.get() {
                return view().into_element();
            }
            let st_paint = st.clone();
            let st_press = st.clone();
            let minimap_view = canvas(move || {
                let _ = st_paint.canvas_tick.get();
                let is_dark = dark();
                let vw_vh = st_paint.viewport_size.get();
                let ctrl = st_paint.controller.borrow();
                paint_minimap_painter(&ctrl.doc, &ctrl.lookup, ctrl.camera, vw_vh, (mw, mh), is_dark)
            })
            .test_id("wb-minimap")
            .w(px(mw))
            .h(px(mh))
            .cursor_pointer()
            .on_press_down(move |e: &PressEvent| {
                let effs = {
                    let mut ctrl = st_press.controller.borrow_mut();
                    let mut out = Vec::new();
                    ctrl.mark_user_moved_camera();
                    ctrl.cancel_follow(&mut out);
                    let vw_vh = st_press.viewport_size.get_untracked();
                    let world_view = ctrl.camera.visible_world_rect(f64::from(vw_vh.0), f64::from(vw_vh.1));
                    let bounds = ctrl.doc.content_bounds().map_or(world_view, |c| c.union(world_view)).expand(60.0);
                    let sx = f64::from(mw - 12.0) / bounds.w.max(1.0);
                    let sy = f64::from(mh - 12.0) / bounds.h.max(1.0);
                    let s = sx.min(sy);
                    let ox = 6.0 + (f64::from(mw - 12.0) - bounds.w * s) * 0.5 - bounds.x * s;
                    let oy = 6.0 + (f64::from(mh - 12.0) - bounds.h * s) * 0.5 - bounds.y * s;
                    let wx = (f64::from(e.position.x.0) - ox) / s;
                    let wy = (f64::from(e.position.y.0) - oy) / s;
                    ctrl.camera.pan_x = f64::from(vw_vh.0) * 0.5 - wx * ctrl.camera.zoom;
                    ctrl.camera.pan_y = f64::from(vw_vh.1) * 0.5 - wy * ctrl.camera.zoom;
                    out.push(ControllerEffect::ViewportChanged { zoom: ctrl.camera.zoom });
                    out
                };
                st_press.dispatch_effects(effs, false, false);
            });
            floating_card()
                .test_id("wb-minimap-card")
                .mb(px(6.0))
                .p(px(2.0))
                .rounded(px(8.0))
                .child(minimap_view)
                .into_element()
        })
    };

    let zoom_bar = {
        let st = st.clone();
        dynamic(move || {
            let cur_zoom_pct = st.zoom_pct.get();
            let l = st.loc_str();
            let is_en = l.starts_with("en");
            floating_pill()
                .test_id("wb-zoom-bar")
                .flex_shrink_0()
                .child(
                    pill_text_btn("wb-zoom-out", "-", false, false, {
                        let st = st.clone();
                        move || st.run_action(BoardAction::ZoomBy(-0.15))
                    })
                    .label(SharedString::from(t_in(l.as_str(), "web.note.whiteboard.zoomOut", &[]))),
                )
                .child(pill_text_btn("wb-zoom-reset", &format!("{cur_zoom_pct}%"), false, false, {
                    let st = st.clone();
                    move || st.run_action(BoardAction::ResetZoom)
                }))
                .child(
                    pill_text_btn("wb-zoom-in", "+", false, false, {
                        let st = st.clone();
                        move || st.run_action(BoardAction::ZoomBy(0.15))
                    })
                    .label(SharedString::from(t_in(l.as_str(), "web.note.whiteboard.zoomIn", &[]))),
                )
                .child(pill_divider())
                .child(pill_text_btn("wb-fit", &t_in(l.as_str(), "web.note.whiteboard.fitView", &[]), false, false, {
                    let st = st.clone();
                    move || st.run_action(BoardAction::FitToContent)
                }))
                .child(pill_divider())
                .child(pill_text_btn(
                    "wb-minimap-toggle",
                    if is_en { "Map" } else { "缩略图" },
                    st.minimap_open.get(),
                    false,
                    {
                        let minimap_open = st.minimap_open;
                        move || minimap_open.set(!minimap_open.get_untracked())
                    },
                ))
                .into_element()
        })
    };

    view()
        .test_id("wb-zoom-hud")
        .flex_col()
        .items_end()
        .flex_shrink_0()
        .pointer_events(PointerEvents::BoxNone)
        .child(minimap_panel)
        .child(zoom_bar)
}

// Unified bottom HUD row: centers the drawing dock when space allows while keeping the
// zoom + minimap cluster pinned to bottom-right without ever colliding with the dock.
pub(super) fn build_bottom_hud(st: &WbState) -> View {
    let bottom_dock = build_bottom_dock(st);
    let minimap_and_zoom = build_minimap_and_zoom(st);
    view()
        .test_id("wb-bottom-hud")
        .absolute()
        .bottom(px(12.0))
        .left(px(12.0))
        .right(px(12.0))
        .flex_row()
        .items_end()
        .gap(px(8.0))
        .pointer_events(PointerEvents::BoxNone)
        .child(view().flex_1().min_w(px(0.0)).pointer_events(PointerEvents::BoxNone))
        .child(
            view()
                .flex_shrink(1.0)
                .min_w(px(0.0))
                .flex_row()
                .justify_center()
                .pointer_events(PointerEvents::BoxNone)
                .child(bottom_dock),
        )
        .child(
            view()
                .flex_1()
                .min_w(px(236.0))
                .flex_row()
                .justify_end()
                .items_end()
                .pointer_events(PointerEvents::BoxNone)
                .child(minimap_and_zoom),
        )
}
