use nsh_core::prelude::*;

use crate::engine::whiteboard::{
    FramePaintInput, InteractionMode, Point2, PointerButton as WbPointerButton, PointerInput, Tool, measure_text_span, paint_board_frame_painter,
};

use super::state::{WbState, animations_disabled, map_mods, map_mouse_btn};

pub(super) fn build_stage(st: &WbState) -> View {
    // Single atomic canvas painting background, grid, world elements, selection chrome, and presences in one pass.
    let board_canvas: CanvasView = {
        let st_paint = st.clone();
        let st_layout = st.clone();
        canvas(move || {
            let _ = st_paint.canvas_tick.get();
            let active_edit = st_paint.inline_edit.get();
            let dismissed = st_paint.dismissed_notes.get();
            let is_dark = dark();
            let vw_vh = st_paint.viewport_size.get();
            let fast_shadows = !animations_disabled() && st_paint.navigating.get();
            let ctrl = st_paint.controller.borrow();
            paint_board_frame_painter(&FramePaintInput {
                controller: &ctrl,
                viewport_size: vw_vh,
                editing_id: active_edit.as_ref().map(|e| &e.id),
                editing_milestone: active_edit.as_ref().and_then(|e| e.milestone_index),
                dark: is_dark,
                anim_hidden_ids: &st_paint.hidden_ids,
                dismissed_notes: &dismissed,
                fast_shadows,
            })
        })
        .test_id("wb-canvas")
        .absolute()
        .inset(px(0.0))
        .on_layout(move |b: &Bounds<Points>| {
            let w = b.size.width.0.max(120.0);
            let h = b.size.height.0.max(120.0);
            let prev = st_layout.viewport_size.get_untracked();
            if (prev.0 - w).abs() > 0.5 || (prev.1 - h).abs() > 0.5 {
                st_layout.viewport_size.set((w, h));
                let zoom = {
                    let mut ctrl = st_layout.controller.borrow_mut();
                    ctrl.set_viewport_size(f64::from(w), f64::from(h));
                    ctrl.camera.zoom
                };
                st_layout.update_zoom_pct(zoom);
                st_layout.camera_tick.set(st_layout.camera_tick.get_untracked().wrapping_add(1));
                st_layout.canvas_tick.set(st_layout.canvas_tick.get_untracked().wrapping_add(1));
                st_layout.sync_ui_snapshot();
                st_layout.maybe_emit_viewport(true);
            }
        })
    };

    let st_down = st.clone();
    let st_move = st.clone();
    let st_up = st.clone();
    let st_wheel = st.clone();
    let st_pinch = st.clone();
    let st_ctx = st.clone();

    view()
        .test_id("wb-stage")
        .relative()
        .flex_1()
        .h_full()
        .overflow_hidden()
        .child(board_canvas)
        .on_press_down(move |e: &PressEvent| {
            st_down.context_menu.set(None);
            st_down.sticker_picker_open.set(false);
            st_down.template_picker_open.set(false);
            st_down.export_menu_open.set(false);
            st_down.timer_open.set(false);
            if st_down.inline_edit.get_untracked().is_some() {
                st_down.commit_inline();
            }
            let sx = f64::from(e.position.x.0);
            let sy = f64::from(e.position.y.0);
            let dismissed_hit = {
                let ctrl = st_down.controller.borrow();
                let cur_dismissed = st_down.dismissed_notes.get_untracked();
                ctrl.doc.presences.iter().find_map(|p| {
                    if cur_dismissed.contains(&p.id) {
                        return None;
                    }
                    let msg = p.status.as_deref().map(str::trim).filter(|t| t.chars().count() > 14)?;
                    let pose = ctrl.displayed_pose(p);
                    let tip = ctrl.camera.world_to_screen(Point2::new(pose.x, pose.y));
                    let pill_w = (measure_text_span(msg, 12.5, false) + 52.0).clamp(160.0, 580.0);
                    let close_cx = tip.x + 10.0 + pill_w - 17.0;
                    let close_cy = tip.y + 26.0;
                    ((sx - close_cx).abs() <= 14.0 && (sy - close_cy).abs() <= 14.0).then(|| p.id.clone())
                })
            };
            if let Some(pid) = dismissed_hit {
                let mut next = st_down.dismissed_notes.get_untracked();
                next.insert(pid);
                st_down.dismissed_notes.set(next);
                st_down.canvas_tick.set(st_down.canvas_tick.get_untracked().wrapping_add(1));
                return;
            }
            let input = PointerInput {
                screen_pos: Point2::new(f64::from(e.position.x.0), f64::from(e.position.y.0)),
                clicks: e.clicks.max(1),
                button: WbPointerButton::Primary,
                modifiers: map_mods(&e.modifiers, st_down.space_held.get_untracked()),
                pressure: 0.6,
            };
            if st_down.props.read_only.get_untracked() && !matches!(st_down.controller.borrow().tool, Tool::Hand | Tool::Select) {
                return;
            }
            let effs = st_down.controller.borrow_mut().handle_pointer_down(input);
            st_down.dispatch_effects(effs, false, false);
        })
        .on_mouse_move(move |e: &MouseEvent| {
            let mut pressure = e.pressure;
            if pressure <= 0.01 {
                pressure = 0.55;
            }
            let screen_pos = Point2::new(f64::from(e.position.x.0), f64::from(e.position.y.0));
            let input = PointerInput {
                screen_pos,
                clicks: 1,
                button: map_mouse_btn(e.pressed_button),
                modifiers: map_mods(&e.modifiers, st_move.space_held.get_untracked()),
                pressure,
            };
            let was_mutating = !matches!(st_move.controller.borrow().mode, InteractionMode::Idle | InteractionMode::Marquee { .. });
            let effs = st_move.controller.borrow_mut().handle_pointer_move(input);
            let is_panning = matches!(st_move.controller.borrow().mode, InteractionMode::Panning { .. });
            if is_panning {
                st_move.camera_tick.set(st_move.camera_tick.get_untracked().wrapping_add(1));
            }
            if (was_mutating || is_panning) && !animations_disabled() {
                st_move.mark_navigating();
            }
            st_move.dispatch_effects(effs, false, true);
            if is_panning {
                st_move.maybe_emit_viewport(false);
            }
            st_move.maybe_emit_cursor(screen_pos);
        })
        .on_mouse_up(move |e: &MouseEvent| {
            let was_active = !matches!(st_up.controller.borrow().mode, InteractionMode::Idle);
            if !was_active {
                return;
            }
            let input = PointerInput {
                screen_pos: Point2::new(f64::from(e.position.x.0), f64::from(e.position.y.0)),
                clicks: 1,
                button: map_mouse_btn(e.button),
                modifiers: map_mods(&e.modifiers, st_up.space_held.get_untracked()),
                pressure: e.pressure.max(0.5),
            };
            let effs = st_up.controller.borrow_mut().handle_pointer_up(input);
            st_up.dispatch_effects(effs, true, false);
        })
        .on_wheel(move |e: &WheelEvent| {
            let (dx, dy, precise) = match e.delta {
                WheelDelta::Points(pt) => (-f64::from(pt.x.0), -f64::from(pt.y.0), true),
                WheelDelta::Lines(pt) => (-f64::from(pt.x), -f64::from(pt.y), false),
            };
            let effs = st_wheel.controller.borrow_mut().handle_wheel(
                Point2::new(f64::from(e.position.x.0), f64::from(e.position.y.0)),
                dx,
                dy,
                precise,
                map_mods(&e.modifiers, st_wheel.space_held.get_untracked()),
            );
            if !effs.is_empty() {
                st_wheel.dispatch_effects(effs, false, true);
            }
        })
        .on_pinch(move |e: &PinchEvent| {
            let effs = st_pinch
                .controller
                .borrow_mut()
                .handle_pinch(Point2::new(f64::from(e.position.x.0), f64::from(e.position.y.0)), f64::from(e.delta.0));
            if !effs.is_empty() {
                st_pinch.dispatch_effects(effs, false, true);
            }
        })
        .on_context_menu(move |e: &ContextMenuEvent| {
            let input = PointerInput {
                screen_pos: Point2::new(f64::from(e.position.x.0), f64::from(e.position.y.0)),
                clicks: 1,
                button: WbPointerButton::Secondary,
                modifiers: map_mods(&e.modifiers, false),
                pressure: 0.5,
            };
            let effs = st_ctx.controller.borrow_mut().handle_pointer_down(input);
            st_ctx.dispatch_effects(effs, false, false);
        })
}
