use nsh_core::element::{ImageSrc, input};
use nsh_core::prelude::*;
use vibevalley_i18n::t_in;

use crate::engine::whiteboard::{BoardAction, BoardCommand, ControllerEffect, ElementId, STICKERS, ShapeKind, apply_command, decode_element};
use crate::theme::AdaptiveUi;

use super::chrome::pill_text_btn;
use super::state::WbState;

// Collapsible right inspector drawer (flex sibling next to stage).
pub(super) fn build_inspector_drawer(st: &WbState) -> impl IntoElement {
    let st = st.clone();
    dynamic(move || {
        if !st.inspector_open.get() {
            return view().into_element();
        }
        let snap = st.ui_snap.get();
        let l = st.loc_str();
        let is_en = l.starts_with("en");
        let first_sel = snap.selection.first().cloned();
        let label_draft = st.label_draft;
        let body_draft = st.body_draft;
        let json_draft = st.json_draft;
        let inspector_focused = st.inspector_focused;

        let mut body = scroll().flex_1().min_h(px(0.0)).p(px(10.0)).flex_col().gap(px(10.0));
        if let Some(el_id) = first_sel {
            body = body
                .child(
                    view()
                        .flex_row()
                        .items_center()
                        .justify_between()
                        .child(
                            text(el_id.to_string())
                                .text_size(px(12.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(AdaptiveUi::INK),
                        )
                        .child(
                            text(format!("{} · rev {}", snap.selection_kind.kind_name, snap.selection_kind.rev))
                                .text_size(px(11.0))
                                .text_color(AdaptiveUi::FAINT),
                        ),
                )
                .child(
                    view()
                        .flex_col()
                        .gap(px(4.0))
                        .child(
                            text(t_in(l.as_str(), "web.note.whiteboard.label", &[]))
                                .text_size(px(11.5))
                                .text_color(AdaptiveUi::MUTED),
                        )
                        .child(
                            input()
                                .test_id("wb-inspector-label")
                                .value(move || label_draft.get())
                                .rounded(px(6.0))
                                .border(px(1.0))
                                .border_color(AdaptiveUi::LINE)
                                .bg(AdaptiveUi::SIDE)
                                .px(px(8.0))
                                .py(px(5.0))
                                .text_size(px(12.0))
                                .text_color(AdaptiveUi::INK)
                                .on_focus(move || inspector_focused.set(true))
                                .on_blur(move || inspector_focused.set(false))
                                .on_change(move |v: &str| label_draft.set(v.to_owned())),
                        ),
                );

            if snap.selection_kind.is_shape {
                body = body.child(
                    view()
                        .flex_col()
                        .gap(px(4.0))
                        .child(
                            text(t_in(l.as_str(), "web.note.whiteboard.body", &[]))
                                .text_size(px(11.5))
                                .text_color(AdaptiveUi::MUTED),
                        )
                        .child(
                            input()
                                .test_id("wb-inspector-body")
                                .value(move || body_draft.get())
                                .multiline(true)
                                .rounded(px(6.0))
                                .border(px(1.0))
                                .border_color(AdaptiveUi::LINE)
                                .bg(AdaptiveUi::SIDE)
                                .px(px(8.0))
                                .py(px(5.0))
                                .text_size(px(12.0))
                                .text_color(AdaptiveUi::INK)
                                .on_focus(move || inspector_focused.set(true))
                                .on_blur(move || inspector_focused.set(false))
                                .on_change(move |v: &str| body_draft.set(v.to_owned())),
                        ),
                );

                // Quick shape & top sticker toggles inside inspector.
                let mut shape_row = view().flex_row().flex_wrap().gap(px(4.0));
                for (sk, sname) in [
                    (ShapeKind::Card, t_in(l.as_str(), "web.note.whiteboard.card", &[])),
                    (ShapeKind::Sticky, t_in(l.as_str(), "web.note.whiteboard.sticky", &[])),
                    (ShapeKind::Rect, t_in(l.as_str(), "web.note.whiteboard.rect", &[])),
                    (ShapeKind::Diamond, t_in(l.as_str(), "web.note.whiteboard.diamond", &[])),
                    (ShapeKind::Ellipse, if is_en { "Ellipse".to_owned() } else { "椭圆".to_owned() }),
                    (ShapeKind::Cylinder, if is_en { "Cylinder".to_owned() } else { "圆柱".to_owned() }),
                ] {
                    shape_row = shape_row.child(pill_text_btn(
                        &format!("wb-insp-shape-{sname}"),
                        &sname,
                        snap.selection_kind.shape == Some(sk),
                        false,
                        {
                            let st = st.clone();
                            move || st.run_action(BoardAction::SetShapeSelection(sk))
                        },
                    ));
                }
                body = body.child(shape_row);

                let mut st_row = view().flex_row().flex_wrap().gap(px(4.0)).child(pill_text_btn(
                    "wb-insp-sticker-none",
                    &t_in(l.as_str(), "web.note.whiteboard.noSticker", &[]),
                    snap.selection_kind.sticker.is_none(),
                    false,
                    {
                        let st = st.clone();
                        move || st.run_action(BoardAction::SetStickerSelection(None))
                    },
                ));
                for spec in STICKERS.iter().take(10) {
                    let sid = spec.id;
                    st_row = st_row.child(
                        view()
                            .test_id(&format!("wb-insp-sticker-{sid}"))
                            .role(AccessibilityRole::Button)
                            .size(px(28.0))
                            .items_center()
                            .justify_center()
                            .rounded(px(6.0))
                            .border(px(1.0))
                            .border_color(if snap.selection_kind.sticker.as_deref() == Some(sid) {
                                AdaptiveUi::ACCENT
                            } else {
                                AdaptiveUi::LINE
                            })
                            .bg(AdaptiveUi::SIDE)
                            .cursor_pointer()
                            .on_press({
                                let st = st.clone();
                                move |_: &PressEvent| st.run_action(BoardAction::SetStickerSelection(Some(sid.to_owned())))
                            })
                            .child(image(ImageSrc::svg_markup(spec.svg).size(Size::new(px(20.0), px(20.0)))).size(px(20.0))),
                    );
                }
                body = body.child(st_row);
            }

            body = body
                .child(view().flex_row().justify_end().child(pill_text_btn(
                    "wb-inspector-save",
                    &t_in(l.as_str(), "web.note.whiteboard.save", &[]),
                    true,
                    false,
                    {
                        let st = st.clone();
                        let el_id = el_id.clone();
                        move || {
                            let effs = st
                                .controller
                                .borrow_mut()
                                .commit_inline_edit(&el_id, label_draft.get_untracked(), body_draft.get_untracked(), None);
                            st.dispatch_effects(effs, true, false);
                        }
                    },
                )))
                .child(
                    view()
                        .flex_col()
                        .gap(px(4.0))
                        .child(
                            text(t_in(l.as_str(), "web.note.whiteboard.entryJson", &[]))
                                .text_size(px(11.5))
                                .text_color(AdaptiveUi::MUTED),
                        )
                        .child(
                            input()
                                .test_id("wb-inspector-json")
                                .value(move || json_draft.get())
                                .multiline(true)
                                .rounded(px(6.0))
                                .border(px(1.0))
                                .border_color(AdaptiveUi::LINE)
                                .bg(AdaptiveUi::SIDE)
                                .px(px(8.0))
                                .py(px(6.0))
                                .text_size(px(11.0))
                                .text_color(AdaptiveUi::INK)
                                .on_focus(move || inspector_focused.set(true))
                                .on_blur(move || inspector_focused.set(false))
                                .on_change(move |v: &str| json_draft.set(v.to_owned())),
                        )
                        .child(view().flex_row().justify_end().child(pill_text_btn(
                            "wb-inspector-save-json",
                            &t_in(l.as_str(), "web.note.whiteboard.saveJson", &[]),
                            true,
                            false,
                            {
                                let st = st.clone();
                                let el_id = el_id.clone();
                                move || {
                                    let raw = json_draft.get_untracked();
                                    let rev = st.controller.borrow().doc.element(&el_id).map_or(0, |e| e.rev);
                                    if let Ok(decoded) = decode_element(el_id.as_str(), rev, &raw) {
                                        let res = apply_command(
                                            &mut st.controller.borrow_mut().doc,
                                            None,
                                            BoardCommand::UpdateElement(Box::new(decoded)),
                                            None,
                                            true,
                                        );
                                        st.controller.borrow_mut().rebuild_index();
                                        st.dispatch_effects(vec![ControllerEffect::FlushBatch(res.writes)], true, false);
                                    }
                                }
                            },
                        ))),
                );
        } else {
            for (eid, lbl, kind_tag) in &snap.all_element_rows {
                let row_id = ElementId::new(eid.clone());
                body = body.child(
                    view()
                        .test_id(&format!("wb-inspector-item-{eid}"))
                        .role(AccessibilityRole::Button)
                        .flex_row()
                        .items_center()
                        .justify_between()
                        .gap(px(6.0))
                        .rounded(px(6.0))
                        .border(px(1.0))
                        .border_color(AdaptiveUi::LINE)
                        .bg(AdaptiveUi::SIDE)
                        .px(px(8.0))
                        .py(px(5.0))
                        .cursor_pointer()
                        .hover(|s| s.bg(AdaptiveUi::HOVER))
                        .on_press({
                            let st = st.clone();
                            move |_: &PressEvent| {
                                st.controller.borrow_mut().selection = vec![row_id.clone()];
                                st.dispatch_effects(vec![ControllerEffect::SelectionChanged(vec![row_id.clone()])], false, false);
                            }
                        })
                        .child(
                            text(if lbl.is_empty() { eid.clone() } else { lbl.clone() })
                                .text_size(px(11.5))
                                .text_color(AdaptiveUi::INK)
                                .truncate(),
                        )
                        .child(text(kind_tag.clone()).text_size(px(10.5)).text_color(AdaptiveUi::FAINT)),
                );
            }
        }

        let inspector_open = st.inspector_open;
        view()
            .test_id("wb-inspector")
            .w(px(284.0))
            .h_full()
            .flex_col()
            .border_l(px(1.0))
            .border_color(AdaptiveUi::LINE)
            .bg(AdaptiveUi::PAGE)
            .child(
                view()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .px(px(10.0))
                    .py(px(8.0))
                    .border_b(px(1.0))
                    .border_color(AdaptiveUi::LINE)
                    .bg(AdaptiveUi::SIDE)
                    .child(
                        text(snap.selection.first().map_or_else(
                            || t_in(l.as_str(), "web.note.whiteboard.elements", &[("n", snap.count.into())]),
                            |i| i.0.clone(),
                        ))
                        .text_size(px(12.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(AdaptiveUi::MUTED),
                    )
                    .child(pill_text_btn("wb-inspector-close", "×", false, false, move || {
                        inspector_open.set(false);
                    })),
            )
            .child(body)
            .into_element()
    })
}
