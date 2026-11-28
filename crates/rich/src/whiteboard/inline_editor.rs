use nsh_core::element::input;
use nsh_core::prelude::*;

use crate::engine::whiteboard::{
    ElementKind, MilestoneKind, Point2, Rect2, TextAlign, TextVariant, WhiteboardPalette, layout_card, measure_text_span, paint::parse_hex_hsla,
    resolve_sticker_svg, route_arrow, sample_polyline,
};

use super::state::WbState;

// Borderless in-place inline text editor projected directly over the edited element.
pub(super) fn build_inline_editor_overlay(st: &WbState) -> impl IntoElement {
    let st = st.clone();
    dynamic(move || {
        let Some(edit_st) = st.inline_edit.get() else {
            return view().into_element();
        };
        let _ = st.camera_tick.get();
        let _ = st.viewport_size.get();
        let is_dark = dark();
        let pal = WhiteboardPalette::for_mode(is_dark);
        let is_en = st.loc_str().starts_with("en");

        let (el_snap, camera, lookup) = {
            let ctrl = st.controller.borrow();
            let Some(el) = ctrl.doc.element(&edit_st.id).cloned() else {
                return view().into_element();
            };
            (el, ctrl.camera, ctrl.lookup.clone())
        };
        let zoom = camera.zoom as f32;

        let apply_align = |inp: Input, align: TextAlign| match align {
            TextAlign::Left => inp.text_left(),
            TextAlign::Center => inp.text_center(),
            TextAlign::Right => inp.text_right(),
        };
        let solid_color = |c: Hsla| AdaptiveColor { light: c, dark: c };
        let inline_title = st.inline_title;
        let inline_body = st.inline_body;

        match &el_snap.kind {
            ElementKind::Shape {
                x,
                y,
                w,
                h,
                shape,
                fill,
                sticker,
                sticker_svg,
                align,
                ..
            } => {
                let rect = Rect2::new(*x, *y, *w, *h);
                let tone = pal.shape_tone(*shape, fill);
                let has_sticker = resolve_sticker_svg(sticker.as_deref(), sticker_svg.as_deref()).is_some();
                let is_compact = *h <= 44.0;
                let pad_x = if is_compact || *w < 130.0 { 7.0 } else { 12.0 };
                let top_pad = if has_sticker { 36.0 } else { 4.0 };
                let bottom_pad = if has_sticker { 10.0 } else { 4.0 };
                let cur_title = inline_title.get_untracked();
                let cur_body = inline_body.get_untracked();
                let layout = layout_card(rect, if cur_title.is_empty() { "A" } else { &cur_title }, &cur_body, has_sticker);
                let _ = layout.title_y;
                let show_body = !is_compact && (*h >= 60.0 || !cur_body.is_empty());

                let tl = camera.world_to_screen(Point2::new(rect.x + pad_x, rect.y + top_pad));
                let inner_w = ((rect.w - pad_x * 2.0).max(32.0) as f32 * zoom).max(40.0);
                let inner_h = ((rect.h - top_pad - bottom_pad).max(18.0) as f32 * zoom).max(20.0);
                let title_fs = ((if is_compact { 12.5 } else { 13.0 }) * zoom).clamp(9.0, 48.0);
                let title_weight = if is_compact {
                    FontWeight::NORMAL
                } else if !show_body {
                    FontWeight::MEDIUM
                } else {
                    FontWeight::SEMIBOLD
                };

                let title_input = apply_align(
                    input()
                        .test_id("wb-inline-title")
                        .value(move || inline_title.get())
                        .auto_focus(true)
                        .w_full()
                        .border(px(0.0))
                        .bg(transparent_black())
                        .p(px(0.0))
                        .text_size(px(title_fs))
                        .font_weight(title_weight)
                        .text_color(solid_color(tone.ink))
                        .caret_color(tone.ink)
                        .on_change(move |v: &str| inline_title.set(v.to_owned()))
                        .on_submit({
                            let st = st.clone();
                            move |_: &str| st.commit_inline()
                        }),
                    *align,
                );

                let mut box_view = view()
                    .test_id("wb-inline-editor")
                    .absolute()
                    .left(px(tl.x as f32))
                    .top(px(tl.y as f32))
                    .w(px(inner_w))
                    .h(px(inner_h))
                    .flex_col()
                    .justify_center()
                    .gap(px((2.0 * zoom).clamp(1.0, 8.0)))
                    .child(title_input);

                if show_body {
                    let body_fs = (11.5 * zoom).clamp(8.5, 40.0);
                    let body_ink = Hsla { a: 0.84, ..tone.ink };
                    let body_input = apply_align(
                        input()
                            .test_id("wb-inline-body")
                            .value(move || inline_body.get())
                            .multiline(true)
                            .placeholder(if is_en { "Details…" } else { "补充说明…" })
                            .placeholder_color(Hsla { a: 0.45, ..tone.ink })
                            .w_full()
                            .border(px(0.0))
                            .bg(transparent_black())
                            .p(px(0.0))
                            .text_size(px(body_fs))
                            .text_color(solid_color(body_ink))
                            .caret_color(body_ink)
                            .on_change(move |v: &str| inline_body.set(v.to_owned())),
                        *align,
                    );
                    box_view = box_view.child(body_input);
                }
                box_view.into_element()
            }
            ElementKind::Text {
                x,
                y,
                w,
                h,
                variant,
                align,
                font_size,
                color,
                ..
            } => {
                let ink = color.as_deref().and_then(parse_hex_hsla).unwrap_or(match variant {
                    TextVariant::Subtitle => pal.muted,
                    _ => pal.ink,
                });
                let (ox, oy, ow, fs, weight, multiline, serif) = match variant {
                    TextVariant::Title => (0.0, 4.0, *w, font_size.unwrap_or(30.0), FontWeight::NORMAL, false, true),
                    TextVariant::Subtitle => (0.0, 3.0, *w, font_size.unwrap_or(13.5), FontWeight::NORMAL, false, false),
                    TextVariant::Callout => (28.0, 6.0, (*w - 34.0).max(60.0), font_size.unwrap_or(12.0), FontWeight::MEDIUM, true, false),
                    TextVariant::Body => (8.0, 6.0, (*w - 16.0).max(48.0), font_size.unwrap_or(13.0), FontWeight::NORMAL, true, false),
                };
                let tl = camera.world_to_screen(Point2::new(*x + ox, *y + oy));
                let sw = (ow as f32 * zoom).max(64.0);
                let sh = ((*h - oy).max(f64::from(fs) + 8.0) as f32 * zoom).max(20.0);
                let mut field = apply_align(
                    input()
                        .test_id("wb-inline-title")
                        .value(move || inline_title.get())
                        .auto_focus(true)
                        .multiline(multiline)
                        .w_full()
                        .border(px(0.0))
                        .bg(transparent_black())
                        .p(px(0.0))
                        .text_size(px((fs * zoom).clamp(9.0, 96.0)))
                        .font_weight(weight)
                        .text_color(solid_color(ink))
                        .caret_color(ink)
                        .on_change(move |v: &str| inline_title.set(v.to_owned()))
                        .on_submit({
                            let st = st.clone();
                            move |_: &str| st.commit_inline()
                        }),
                    *align,
                );
                if serif {
                    field = field.font_family("Georgia");
                }
                view()
                    .test_id("wb-inline-editor")
                    .absolute()
                    .left(px(tl.x as f32))
                    .top(px(tl.y as f32))
                    .w(px(sw))
                    .min_h(px(sh))
                    .child(field)
                    .into_element()
            }
            ElementKind::Container { x, y, w, .. } => {
                let tl = camera.world_to_screen(Point2::new(*x + 2.0, *y - 28.0));
                let sw = ((*w - 4.0).clamp(120.0, 360.0) as f32 * zoom).max(96.0);
                let fs = (12.5 * zoom).clamp(9.0, 36.0);
                let field = input()
                    .test_id("wb-inline-title")
                    .value(move || inline_title.get())
                    .auto_focus(true)
                    .w_full()
                    .border(px(0.0))
                    .bg(transparent_black())
                    .p(px(0.0))
                    .text_size(px(fs))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(solid_color(pal.muted))
                    .caret_color(pal.muted)
                    .on_change(move |v: &str| inline_title.set(v.to_owned()))
                    .on_submit({
                        let st = st.clone();
                        move |_: &str| st.commit_inline()
                    });
                view()
                    .test_id("wb-inline-editor")
                    .absolute()
                    .left(px(tl.x as f32))
                    .top(px(tl.y as f32))
                    .w(px(sw))
                    .child(field)
                    .into_element()
            }
            ElementKind::Arrow { from, to, bends, curve, .. } => {
                let Some(geom) = route_arrow(from, to, bends, *curve, &lookup) else {
                    return view().into_element();
                };
                let center = camera.world_to_screen(geom.label_pos);
                let cur_text = inline_title.get_untracked();
                let pw = (((measure_text_span(&cur_text, 11.5, true) + 28.0).max(80.0)) as f32 * zoom).clamp(72.0, 260.0);
                let ph = (24.0 * zoom).max(22.0);
                let fs = (11.0 * zoom).clamp(9.0, 28.0);
                let field = input()
                    .test_id("wb-inline-title")
                    .value(move || inline_title.get())
                    .auto_focus(true)
                    .w_full()
                    .border(px(0.0))
                    .bg(transparent_black())
                    .px(px(6.0))
                    .py(px(2.0))
                    .text_center()
                    .text_size(px(fs))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(solid_color(pal.ink))
                    .caret_color(pal.ink)
                    .on_change(move |v: &str| inline_title.set(v.to_owned()))
                    .on_submit({
                        let st = st.clone();
                        move |_: &str| st.commit_inline()
                    });
                view()
                    .test_id("wb-inline-editor")
                    .absolute()
                    .left(px(center.x as f32 - pw * 0.5))
                    .top(px(center.y as f32 - ph * 0.5))
                    .w(px(pw))
                    .min_h(px(ph))
                    .items_center()
                    .justify_center()
                    .rounded(px(6.0))
                    .bg(solid_color(pal.arrow_label_bg))
                    .border(px(1.0))
                    .border_color(solid_color(pal.selection))
                    .child(field)
                    .into_element()
            }
            ElementKind::Timeline {
                x,
                y,
                w,
                h,
                points,
                milestones,
                ..
            } => {
                let Some(idx) = edit_st.milestone_index else {
                    return view().into_element();
                };
                let Some(m) = milestones.get(idx) else {
                    return view().into_element();
                };
                let rect = Rect2::new(*x, *y, *w, *h);
                let ribbon_pts: Vec<Point2> = if points.len() >= 2 {
                    points.clone()
                } else {
                    vec![
                        Point2::new(rect.x, rect.center().y + 10.0),
                        Point2::new(rect.center().x, rect.center().y - 4.0),
                        Point2::new(rect.right(), rect.center().y - 16.0),
                    ]
                };
                let total = milestones.len().max(1);
                let pt = m
                    .pos
                    .unwrap_or_else(|| sample_polyline(&ribbon_pts, m.t.unwrap_or((idx + 1) as f64 / (total + 1) as f64)));
                let center = camera.world_to_screen(pt);
                let cur_text = inline_title.get_untracked();
                let (pw, ph, fs, fg) = match m.kind {
                    MilestoneKind::Minor => ((44.0 * zoom).max(36.0), (22.0 * zoom).max(20.0), (10.5 * zoom).clamp(9.0, 28.0), pal.muted),
                    MilestoneKind::Major => {
                        let w_world = (measure_text_span(&cur_text, 12.0, true) + 26.0).max(56.0) as f32;
                        (
                            (w_world * zoom).max(56.0),
                            (26.0 * zoom).max(22.0),
                            (12.0 * zoom).clamp(9.0, 32.0),
                            pal.pill_ink,
                        )
                    }
                };
                let field = input()
                    .test_id("wb-inline-title")
                    .value(move || inline_title.get())
                    .auto_focus(true)
                    .w_full()
                    .border(px(0.0))
                    .bg(transparent_black())
                    .p(px(0.0))
                    .text_center()
                    .text_size(px(fs))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(solid_color(fg))
                    .caret_color(fg)
                    .on_change(move |v: &str| inline_title.set(v.to_owned()))
                    .on_submit({
                        let st = st.clone();
                        move |_: &str| st.commit_inline()
                    });
                view()
                    .test_id("wb-inline-editor")
                    .absolute()
                    .left(px(center.x as f32 - pw * 0.5))
                    .top(px(center.y as f32 - ph * 0.5))
                    .w(px(pw))
                    .h(px(ph))
                    .items_center()
                    .justify_center()
                    .child(field)
                    .into_element()
            }
            _ => view().into_element(),
        }
    })
}
