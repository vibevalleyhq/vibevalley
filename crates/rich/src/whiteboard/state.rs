use std::cell::{Cell, RefCell};
use std::collections::BTreeSet;
use std::rc::Rc;
use std::time::{Duration, Instant};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use nsh_core::canvas::render::{ImageFormat, RenderOptions};
use nsh_core::keymap::Modifiers;
use nsh_core::prelude::*;

use crate::engine::whiteboard::{
    ArrowCurve, BoardAction, BoardDoc, ControllerEffect, ElementId, ElementKind, ExportFormat, GridStyle, Modifiers as WbModifiers, Point2,
    PointerButton as WbPointerButton, Presence, Rect2, ShapeKind, StrokeStyle, Tool, WhiteboardController, WhiteboardEntry, build_export_painter,
    decode_board_entries, decode_presences_json, encode_element_json, export_json, export_json_canvas, export_svg, merge_live_presences,
};

use super::chrome::sanitize_filename;
use super::props::{
    VvWhiteboardBatchEvent, VvWhiteboardChatEvent, VvWhiteboardCursorEvent, VvWhiteboardEvent, VvWhiteboardExportEvent, VvWhiteboardProps,
    VvWhiteboardSelectionEvent, VvWhiteboardViewportEvent,
};
use super::replica::WhiteboardLoroReplica;

#[derive(Default)]
pub(super) struct PresenceEmitThrottle {
    pub(super) last_cursor_at: Option<Instant>,
    pub(super) last_cursor_world: Option<Point2>,
    pub(super) last_viewport_at: Option<Instant>,
    pub(super) last_viewport: Option<(Rect2, f64)>,
}

const PRESENCE_EMIT_MIN_INTERVAL: Duration = Duration::from_millis(80);
const ANIM_FRAME_INTERVAL: Duration = Duration::from_millis(16);
const NAV_SETTLE_DELAY: Duration = Duration::from_millis(120);

pub(super) fn animations_disabled() -> bool {
    if reduce_motion() {
        return true;
    }
    std::env::var("VIBEVALLEY_NO_ANIMATION")
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct InlineEditState {
    pub(super) id: ElementId,
    pub(super) milestone_index: Option<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct ContextMenuState {
    pub(super) x: f32,
    pub(super) y: f32,
    pub(super) has_selection: bool,
}

#[derive(Clone, Default, PartialEq)]
pub(super) struct WhiteboardUiSnapshot {
    pub(super) tool: ToolKindTag,
    pub(super) count: usize,
    pub(super) can_undo: bool,
    pub(super) can_redo: bool,
    pub(super) grid: GridStyle,
    pub(super) selection: Vec<ElementId>,
    pub(super) selection_kind: SelectionSummary,
    pub(super) presences: Vec<Presence>,
    pub(super) follow_actor: Option<String>,
    pub(super) all_element_rows: Vec<(String, String, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(super) enum ToolKindTag {
    #[default]
    Select,
    Hand,
    Text,
    Callout,
    Container,
    Card,
    Sticky,
    Rect,
    Diamond,
    Ellipse,
    Cylinder,
    Pen,
    Highlighter,
    Eraser,
    Sticker,
    Arrow,
    Timeline,
    Table,
}

impl ToolKindTag {
    fn from_tool(tool: &Tool) -> Self {
        match tool {
            Tool::Select => Self::Select,
            Tool::Hand => Self::Hand,
            Tool::Text => Self::Text,
            Tool::Callout => Self::Callout,
            Tool::Container => Self::Container,
            Tool::Card => Self::Card,
            Tool::Sticky => Self::Sticky,
            Tool::Shape(ShapeKind::Diamond) => Self::Diamond,
            Tool::Shape(ShapeKind::Ellipse) => Self::Ellipse,
            Tool::Shape(ShapeKind::Cylinder) => Self::Cylinder,
            Tool::Shape(_) => Self::Rect,
            Tool::Pen => Self::Pen,
            Tool::Highlighter => Self::Highlighter,
            Tool::Eraser => Self::Eraser,
            Tool::Sticker(_) => Self::Sticker,
            Tool::Arrow => Self::Arrow,
            Tool::Timeline => Self::Timeline,
            Tool::Table => Self::Table,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(super) struct SelectionSummary {
    pub(super) id: Option<String>,
    pub(super) kind_name: String,
    pub(super) rev: i64,
    pub(super) is_shape: bool,
    pub(super) is_arrow: bool,
    pub(super) is_text: bool,
    pub(super) is_path: bool,
    pub(super) is_locked: bool,
    pub(super) has_group: bool,
    pub(super) fill: Option<String>,
    pub(super) shape: Option<ShapeKind>,
    pub(super) curve: Option<ArrowCurve>,
    pub(super) style: Option<StrokeStyle>,
    pub(super) sticker: Option<String>,
}

#[derive(Clone)]
pub(super) struct WbState {
    pub(super) props: VvWhiteboardProps,
    pub(super) cx: Scope<VvWhiteboardEvent>,
    pub(super) controller: Rc<RefCell<WhiteboardController>>,
    pub(super) replica: Rc<RefCell<WhiteboardLoroReplica>>,
    pub(super) last_sync: Rc<RefCell<(SharedString, SharedString, SharedString, i64)>>,
    pub(super) store_presences: Rc<RefCell<Vec<Presence>>>,
    pub(super) emit_throttle: Rc<RefCell<PresenceEmitThrottle>>,
    pub(super) anim_timer: Rc<RefCell<Option<Spawned<()>>>>,
    pub(super) anim_last_tick: Rc<RefCell<Option<Instant>>>,
    pub(super) navigating: Rc<Cell<bool>>,
    pub(super) nav_settle_timer: Rc<RefCell<Option<Spawned<()>>>>,
    pub(super) hidden_ids: Rc<BTreeSet<ElementId>>,

    pub(super) canvas_tick: Signal<u64>,
    pub(super) camera_tick: Signal<u64>,
    pub(super) zoom_pct: Signal<u32>,
    pub(super) ui_tick: Signal<u64>,
    pub(super) viewport_size: Signal<(f32, f32)>,
    pub(super) space_held: Signal<bool>,

    pub(super) inline_edit: Signal<Option<InlineEditState>>,
    pub(super) inline_title: Signal<String>,
    pub(super) inline_body: Signal<String>,

    pub(super) context_menu: Signal<Option<ContextMenuState>>,
    pub(super) sticker_picker_open: Signal<bool>,
    pub(super) template_picker_open: Signal<bool>,
    pub(super) timer_open: Signal<bool>,
    pub(super) export_menu_open: Signal<bool>,
    pub(super) minimap_open: Signal<bool>,
    pub(super) timer_running: Signal<bool>,
    pub(super) timer_secs: Signal<u32>,
    pub(super) dismissed_notes: Signal<BTreeSet<String>>,
    pub(super) inspector_open: Signal<bool>,
    pub(super) inspector_focused: Signal<bool>,

    pub(super) label_draft: Signal<String>,
    pub(super) body_draft: Signal<String>,
    pub(super) json_draft: Signal<String>,
    pub(super) ui_snap: Signal<WhiteboardUiSnapshot>,
}

impl WbState {
    pub(super) fn new(props: VvWhiteboardProps, cx: Scope<VvWhiteboardEvent>) -> Self {
        let timer_running = signal(false);
        let timer_secs = signal(300u32);
        let timer_handle = set_interval(Duration::from_secs(1), move || {
            if timer_running.get_untracked() {
                let rem = timer_secs.get_untracked();
                if rem > 1 {
                    timer_secs.set(rem - 1);
                } else {
                    timer_secs.set(0);
                    timer_running.set(false);
                }
            }
        });
        cleanup(move || timer_handle.cancel());

        let anim_timer: Rc<RefCell<Option<Spawned<()>>>> = Rc::new(RefCell::new(None));
        let nav_settle_timer: Rc<RefCell<Option<Spawned<()>>>> = Rc::new(RefCell::new(None));
        {
            let anim_timer = Rc::clone(&anim_timer);
            let nav_settle_timer = Rc::clone(&nav_settle_timer);
            cleanup(move || {
                if let Some(handle) = anim_timer.borrow_mut().take() {
                    handle.cancel();
                }
                if let Some(handle) = nav_settle_timer.borrow_mut().take() {
                    handle.cancel();
                }
            });
        }

        Self {
            props,
            cx,
            controller: Rc::new(RefCell::new(WhiteboardController::default())),
            replica: Rc::new(RefCell::new(WhiteboardLoroReplica::new())),
            last_sync: Rc::new(RefCell::new((
                SharedString::default(),
                SharedString::default(),
                SharedString::default(),
                i64::MIN,
            ))),
            store_presences: Rc::new(RefCell::new(Vec::new())),
            emit_throttle: Rc::new(RefCell::new(PresenceEmitThrottle::default())),
            anim_timer,
            anim_last_tick: Rc::new(RefCell::new(None)),
            navigating: Rc::new(Cell::new(false)),
            nav_settle_timer,
            hidden_ids: Rc::new(BTreeSet::new()),
            canvas_tick: signal(0u64),
            camera_tick: signal(0u64),
            zoom_pct: signal(100u32),
            ui_tick: signal(0u64),
            viewport_size: signal((1100.0_f32, 720.0_f32)),
            space_held: signal(false),
            inline_edit: signal(None),
            inline_title: signal(String::new()),
            inline_body: signal(String::new()),
            context_menu: signal(None),
            sticker_picker_open: signal(false),
            template_picker_open: signal(false),
            timer_open: signal(false),
            export_menu_open: signal(false),
            minimap_open: signal(false),
            timer_running,
            timer_secs,
            dismissed_notes: signal(BTreeSet::new()),
            inspector_open: signal(false),
            inspector_focused: signal(false),
            label_draft: signal(String::new()),
            body_draft: signal(String::new()),
            json_draft: signal(String::new()),
            ui_snap: signal(WhiteboardUiSnapshot::default()),
        }
    }

    pub(super) fn loc_str(&self) -> SharedString {
        let l = self.props.locale.get();
        if l.is_empty() { SharedString::from("zh") } else { l }
    }

    pub(super) fn update_zoom_pct(&self, zoom: f64) {
        let pct = (zoom * 100.0).round().max(10.0) as u32;
        if self.zoom_pct.get_untracked() != pct {
            self.zoom_pct.set(pct);
        }
    }

    pub(super) fn maybe_emit_viewport(&self, force: bool) {
        let (vp, zoom) = {
            let ctrl = self.controller.borrow();
            let vw_vh = self.viewport_size.get_untracked();
            (ctrl.camera.visible_world_rect(f64::from(vw_vh.0), f64::from(vw_vh.1)), ctrl.camera.zoom)
        };
        let should_emit = {
            let mut st = self.emit_throttle.borrow_mut();
            let changed = st.last_viewport.is_none_or(|(prev, prev_z)| {
                (prev.x - vp.x).abs() >= 1.0
                    || (prev.y - vp.y).abs() >= 1.0
                    || (prev.w - vp.w).abs() >= 1.0
                    || (prev.h - vp.h).abs() >= 1.0
                    || (prev_z - zoom).abs() >= 0.005
            });
            let now = Instant::now();
            let due = force || st.last_viewport_at.is_none_or(|t| now.duration_since(t) >= PRESENCE_EMIT_MIN_INTERVAL);
            if changed && due {
                st.last_viewport_at = Some(now);
                st.last_viewport = Some((vp, zoom));
                true
            } else {
                false
            }
        };
        if should_emit {
            self.cx.emit(VvWhiteboardEvent::ViewportChange(VvWhiteboardViewportEvent {
                x: vp.x,
                y: vp.y,
                w: vp.w,
                h: vp.h,
                zoom,
            }));
        }
    }

    pub(super) fn mark_navigating(&self) {
        if animations_disabled() {
            return;
        }
        self.navigating.set(true);
        if let Some(prev) = self.nav_settle_timer.borrow_mut().take() {
            prev.cancel();
        }
        let st = self.clone();
        let handle = set_timeout(NAV_SETTLE_DELAY, move || {
            st.nav_settle_timer.borrow_mut().take();
            st.navigating.set(false);
            st.canvas_tick.set(st.canvas_tick.get_untracked().wrapping_add(1));
            st.maybe_emit_viewport(true);
        });
        *self.nav_settle_timer.borrow_mut() = Some(handle);
    }

    pub(super) fn maybe_emit_cursor(&self, screen_pos: Point2) {
        let (world_pt, vp, zoom) = {
            let ctrl = self.controller.borrow();
            let vw_vh = self.viewport_size.get_untracked();
            (
                ctrl.camera.screen_to_world(screen_pos),
                ctrl.camera.visible_world_rect(f64::from(vw_vh.0), f64::from(vw_vh.1)),
                ctrl.camera.zoom,
            )
        };
        if !world_pt.x.is_finite() || !world_pt.y.is_finite() {
            return;
        }
        let should_emit = {
            let mut st = self.emit_throttle.borrow_mut();
            let moved = st.last_cursor_world.is_none_or(|prev| prev.distance_sq(world_pt) >= 4.0);
            let now = Instant::now();
            let due = st.last_cursor_at.is_none_or(|t| now.duration_since(t) >= PRESENCE_EMIT_MIN_INTERVAL);
            if moved && due {
                st.last_cursor_at = Some(now);
                st.last_cursor_world = Some(world_pt);
                true
            } else {
                false
            }
        };
        if should_emit {
            self.cx.emit(VvWhiteboardEvent::CursorMove(VvWhiteboardCursorEvent {
                x: world_pt.x,
                y: world_pt.y,
                viewport_x: vp.x,
                viewport_y: vp.y,
                viewport_w: vp.w,
                viewport_h: vp.h,
                zoom,
            }));
        }
    }

    pub(super) fn sync_ui_snapshot(&self) {
        let (snap, cur_zoom) = {
            let ctrl = self.controller.borrow();
            (build_ui_snapshot(&ctrl), ctrl.camera.zoom)
        };
        self.update_zoom_pct(cur_zoom);
        if let Some(first_id) = snap.selection.first().cloned() {
            let (lbl, bd, js) = {
                let ctrl = self.controller.borrow();
                if let Some(el) = ctrl.doc.element(&first_id) {
                    let lbl = el.primary_label().to_owned();
                    let bd = match &el.kind {
                        ElementKind::Shape { body, .. } => body.clone(),
                        _ => String::new(),
                    };
                    (lbl, bd, encode_element_json(el))
                } else {
                    (String::new(), String::new(), String::new())
                }
            };
            self.label_draft.set(lbl);
            self.body_draft.set(bd);
            self.json_draft.set(js);
        } else {
            self.label_draft.set(String::new());
            self.body_draft.set(String::new());
            self.json_draft.set(String::new());
        }
        self.ui_snap.set(snap);
        self.ui_tick.set(self.ui_tick.get_untracked().wrapping_add(1));
    }

    pub(super) fn schedule_anim_frame(&self) {
        let instant = animations_disabled();
        if instant {
            let (step, zoom) = {
                let mut ctrl = self.controller.borrow_mut();
                (ctrl.step_animations(0.016, true), ctrl.camera.zoom)
            };
            if step.camera_moved {
                self.update_zoom_pct(zoom);
                self.camera_tick.set(self.camera_tick.get_untracked().wrapping_add(1));
                self.canvas_tick.set(self.canvas_tick.get_untracked().wrapping_add(1));
                self.maybe_emit_viewport(true);
            } else if step.presence_moved {
                self.canvas_tick.set(self.canvas_tick.get_untracked().wrapping_add(1));
            }
            self.anim_last_tick.borrow_mut().take();
            return;
        }
        if !self.controller.borrow().needs_animation() || self.anim_timer.borrow().is_some() {
            return;
        }
        let now = Instant::now();
        if self.anim_last_tick.borrow().is_none() {
            *self.anim_last_tick.borrow_mut() = Some(now);
        }
        let st = self.clone();
        let handle = set_timeout(ANIM_FRAME_INTERVAL, move || {
            st.anim_timer.borrow_mut().take();
            let now = Instant::now();
            let dt = st
                .anim_last_tick
                .borrow_mut()
                .replace(now)
                .map_or(0.016, |prev| now.duration_since(prev).as_secs_f64().clamp(0.004, 0.05));
            let (step, zoom) = {
                let mut ctrl = st.controller.borrow_mut();
                (ctrl.step_animations(dt, animations_disabled()), ctrl.camera.zoom)
            };
            if step.camera_moved {
                st.update_zoom_pct(zoom);
                st.camera_tick.set(st.camera_tick.get_untracked().wrapping_add(1));
                if step.still_animating && !animations_disabled() {
                    st.mark_navigating();
                    st.canvas_tick.set(st.canvas_tick.get_untracked().wrapping_add(1));
                    st.maybe_emit_viewport(false);
                } else {
                    if let Some(prev) = st.nav_settle_timer.borrow_mut().take() {
                        prev.cancel();
                    }
                    st.navigating.set(false);
                    st.canvas_tick.set(st.canvas_tick.get_untracked().wrapping_add(1));
                    st.maybe_emit_viewport(true);
                }
            } else if step.presence_moved {
                st.canvas_tick.set(st.canvas_tick.get_untracked().wrapping_add(1));
            }
            if step.still_animating {
                st.schedule_anim_frame();
            } else {
                st.anim_last_tick.borrow_mut().take();
            }
        });
        *self.anim_timer.borrow_mut() = Some(handle);
    }

    pub(super) fn dispatch_effects(&self, effects: Vec<ControllerEffect>, doc_mutated: bool, continuous_nav: bool) {
        let mut flush_writes = None;
        let mut sel_changed = None;
        let mut open_chat_ids = None;
        let mut export_req = None;
        let mut viewport_bumped = false;
        let mut rebuild_ui = doc_mutated;

        for eff in effects {
            match eff {
                ControllerEffect::FlushBatch(w) => {
                    if !w.is_empty() {
                        flush_writes = Some(w);
                    }
                    rebuild_ui = true;
                }
                ControllerEffect::SelectionChanged(ids) => {
                    sel_changed = Some(ids);
                    rebuild_ui = true;
                }
                ControllerEffect::ToolChanged(_)
                | ControllerEffect::GridChanged(_)
                | ControllerEffect::HistoryChanged { .. }
                | ControllerEffect::FollowChanged(_) => {
                    rebuild_ui = true;
                }
                ControllerEffect::ViewportChanged { zoom } => {
                    viewport_bumped = true;
                    self.update_zoom_pct(zoom);
                    self.camera_tick.set(self.camera_tick.get_untracked().wrapping_add(1));
                }
                ControllerEffect::OpenInlineEditor(target) => {
                    self.context_menu.set(None);
                    self.sticker_picker_open.set(false);
                    self.template_picker_open.set(false);
                    self.inline_title.set(target.title);
                    self.inline_body.set(target.body);
                    self.inline_edit.set(Some(InlineEditState {
                        id: target.id,
                        milestone_index: target.milestone_index,
                    }));
                }
                ControllerEffect::OpenContextMenu { screen_pos, .. } => {
                    let has_selection = !self.controller.borrow().selection.is_empty();
                    self.sticker_picker_open.set(false);
                    self.template_picker_open.set(false);
                    self.context_menu.set(Some(ContextMenuState {
                        x: screen_pos.x.max(12.0) as f32,
                        y: screen_pos.y.max(48.0) as f32,
                        has_selection,
                    }));
                }
                ControllerEffect::OpenChatWithSelection(ids) => {
                    open_chat_ids = Some(ids);
                }
                ControllerEffect::RequestExport(fmt) => {
                    export_req = Some(fmt);
                }
            }
        }

        if viewport_bumped && continuous_nav && !animations_disabled() {
            self.mark_navigating();
        }
        self.canvas_tick.set(self.canvas_tick.get_untracked().wrapping_add(1));

        if rebuild_ui {
            self.sync_ui_snapshot();
        }

        // Emit external events strictly after all controller borrows are released.
        if viewport_bumped {
            self.maybe_emit_viewport(!continuous_nav || animations_disabled());
        }
        if let Some(ids) = sel_changed {
            let count = ids.len() as u32;
            let id_strs: Vec<&str> = ids.iter().map(|i| i.as_str()).collect();
            let ids_json = serde_json::to_string(&id_strs).unwrap_or_else(|_| "[]".to_owned());
            self.cx.emit(VvWhiteboardEvent::SelectionChange(VvWhiteboardSelectionEvent {
                ids_json: SharedString::from(ids_json),
                count,
            }));
        }
        if let Some(writes) = flush_writes {
            let writes_json = serde_json::to_string(&writes).unwrap_or_else(|_| "[]".to_owned());
            let (collab_update_b64, version_vector_b64) = self.replica.borrow_mut().apply_local_writes(&writes);
            self.cx.emit(VvWhiteboardEvent::Batch(VvWhiteboardBatchEvent {
                writes_json: SharedString::from(writes_json),
                collab_update_b64: SharedString::from(collab_update_b64),
                version_vector_b64: SharedString::from(version_vector_b64),
            }));
        }
        if let Some(ids) = open_chat_ids {
            let id_strs: Vec<&str> = ids.iter().map(|i| i.as_str()).collect();
            let selected_ids_json = serde_json::to_string(&id_strs).unwrap_or_else(|_| "[]".to_owned());
            self.cx.emit(VvWhiteboardEvent::OpenChat(VvWhiteboardChatEvent {
                selected_ids_json: SharedString::from(selected_ids_json),
            }));
        }
        if let Some(fmt) = export_req {
            let doc_snap = self.controller.borrow().doc.clone();
            let base = sanitize_filename(self.props.title.get_untracked().as_str());
            let is_dark = dark();
            emit_export_request(self.cx, fmt, doc_snap, base, is_dark);
        }
        self.schedule_anim_frame();
    }

    pub(super) fn attach_remote_sync_effect(&self) {
        let st = self.clone();
        effect(move || {
            let entries_raw = st.props.entries_json.get();
            let presences_raw = st.props.presences_json.get();
            let collab_raw = st.props.collab_update_b64.get();
            let seq = st.props.seq.get();
            let smooth = !animations_disabled();

            let (entries_changed, presences_changed, collab_changed) = {
                let mut prev = st.last_sync.borrow_mut();
                let ec = prev.0 != entries_raw || prev.3 != seq;
                let pc = prev.1 != presences_raw;
                let cc = prev.2 != collab_raw;
                if !ec && !pc && !cc {
                    return;
                }
                *prev = (entries_raw.clone(), presences_raw.clone(), collab_raw.clone(), seq);
                (ec, pc, cc)
            };

            let live_presences = decode_presences_json(presences_raw.as_str());
            if !entries_changed && !collab_changed && presences_changed {
                let effs = {
                    let mut ctrl = st.controller.borrow_mut();
                    ctrl.smooth_animations = smooth;
                    ctrl.apply_live_presences(&st.store_presences.borrow(), live_presences)
                };
                if effs.is_empty() {
                    st.canvas_tick.set(st.canvas_tick.get_untracked().wrapping_add(1));
                    st.sync_ui_snapshot();
                    st.schedule_anim_frame();
                } else {
                    st.dispatch_effects(effs, false, false);
                }
                return;
            }

            let (use_snapshot, next_snapshot_doc, delta_entries, deleted_paths, has_board_changes) = if collab_changed
                && !collab_raw.as_str().trim().is_empty()
                && let Ok(bytes) = BASE64.decode(collab_raw.as_str().trim())
                && let Some((updated, deleted, is_initial)) = st.replica.borrow_mut().import_remote_bytes(&bytes, seq)
            {
                let has_changes = !updated.is_empty() || !deleted.is_empty();
                if is_initial {
                    (true, Some(decode_board_entries(&updated, seq)), Vec::new(), Vec::new(), has_changes)
                } else {
                    (false, None, updated, deleted, has_changes)
                }
            } else {
                let parsed_entries: Vec<WhiteboardEntry> = serde_json::from_str(entries_raw.as_str()).unwrap_or_default();
                let (updated, deleted, is_initial) = st.replica.borrow_mut().sync_remote_entries(&parsed_entries, seq);
                let has_changes = !updated.is_empty() || !deleted.is_empty();
                if is_initial {
                    (true, Some(decode_board_entries(&parsed_entries, seq)), Vec::new(), Vec::new(), has_changes)
                } else {
                    (false, None, updated, deleted, has_changes)
                }
            };

            let effs = if use_snapshot {
                let mut next_doc = next_snapshot_doc.unwrap_or_else(|| decode_board_entries(&[], seq));
                *st.store_presences.borrow_mut() = next_doc.presences.clone();
                merge_live_presences(&mut next_doc, live_presences);
                let mut ctrl = st.controller.borrow_mut();
                ctrl.smooth_animations = smooth;
                ctrl.apply_remote_snapshot(next_doc)
            } else if has_board_changes {
                let mut ctrl = st.controller.borrow_mut();
                ctrl.smooth_animations = smooth;
                let mut effs = ctrl.apply_remote_delta(&delta_entries, &deleted_paths, seq);
                if presences_changed {
                    effs.extend(ctrl.apply_live_presences(&st.store_presences.borrow(), live_presences));
                }
                effs
            } else {
                let mut ctrl = st.controller.borrow_mut();
                ctrl.smooth_animations = smooth;
                if seq > ctrl.doc.seq {
                    ctrl.doc.seq = seq;
                }
                if presences_changed {
                    ctrl.apply_live_presences(&st.store_presences.borrow(), live_presences)
                } else {
                    Vec::new()
                }
            };

            if effs.is_empty() {
                if use_snapshot {
                    st.camera_tick.set(st.camera_tick.get_untracked().wrapping_add(1));
                }
                st.canvas_tick.set(st.canvas_tick.get_untracked().wrapping_add(1));
                st.sync_ui_snapshot();
                st.schedule_anim_frame();
            } else {
                st.dispatch_effects(effs, has_board_changes || use_snapshot, false);
            }
        });
    }

    pub(super) fn run_action(&self, action: BoardAction) {
        self.context_menu.set(None);
        self.sticker_picker_open.set(false);
        self.template_picker_open.set(false);
        self.export_menu_open.set(false);
        self.timer_open.set(false);
        if self.props.read_only.get_untracked() && is_mutating_action(&action) {
            return;
        }
        let doc_mutated = is_mutating_action(&action);
        let effs = {
            let mut ctrl = self.controller.borrow_mut();
            ctrl.smooth_animations = !animations_disabled();
            ctrl.run_action(action)
        };
        self.dispatch_effects(effs, doc_mutated, false);
    }

    pub(super) fn set_tool(&self, next_tool: Tool) {
        self.context_menu.set(None);
        self.sticker_picker_open.set(false);
        self.template_picker_open.set(false);
        self.export_menu_open.set(false);
        self.timer_open.set(false);
        let effs = self.controller.borrow_mut().set_tool(next_tool);
        self.dispatch_effects(effs, false, false);
    }

    pub(super) fn commit_inline(&self) {
        let Some(st) = self.inline_edit.get_untracked() else {
            return;
        };
        self.inline_edit.set(None);
        let title = self.inline_title.get_untracked();
        let body = self.inline_body.get_untracked();
        let effs = self.controller.borrow_mut().commit_inline_edit(&st.id, title, body, st.milestone_index);
        self.dispatch_effects(effs, true, false);
    }

    pub(super) fn cancel_inline(&self) {
        if self.inline_edit.get_untracked().is_some() {
            self.inline_edit.set(None);
            self.canvas_tick.set(self.canvas_tick.get_untracked().wrapping_add(1));
        }
    }
}

fn build_ui_snapshot(ctrl: &WhiteboardController) -> WhiteboardUiSnapshot {
    let first_sel = ctrl.selection.first().and_then(|id| ctrl.doc.element(id));
    let selection_kind = match first_sel {
        Some(el) => {
            let (kind_name, is_shape, is_arrow, is_text, is_path, fill, shape, curve, style, sticker) = match &el.kind {
                ElementKind::Shape { shape, fill, sticker, .. } => (
                    "shape",
                    true,
                    false,
                    false,
                    false,
                    Some(fill.as_str().to_owned()),
                    Some(*shape),
                    None,
                    None,
                    sticker.clone(),
                ),
                ElementKind::Arrow { curve, style, .. } => ("arrow", false, true, false, false, None, None, Some(*curve), Some(*style), None),
                ElementKind::Text { fill, .. } => (
                    "text",
                    false,
                    false,
                    true,
                    false,
                    fill.as_ref().map(|f| f.as_str().to_owned()),
                    None,
                    None,
                    None,
                    None,
                ),
                ElementKind::Path { .. } => ("path", false, false, false, true, None, None, None, None, None),
                ElementKind::Container { fill, .. } => ("container", false, false, false, false, Some(fill.as_str().to_owned()), None, None, None, None),
                ElementKind::Timeline { fill, .. } => ("timeline", false, false, false, false, Some(fill.as_str().to_owned()), None, None, None, None),
                ElementKind::Sticker { sticker, .. } => ("sticker", false, false, false, false, None, None, None, None, Some(sticker.clone())),
                ElementKind::Svg { .. } => ("svg", false, false, false, false, None, None, None, None, None),
                ElementKind::Image { .. } => ("image", false, false, false, false, None, None, None, None, None),
                ElementKind::Table { fill, .. } => ("table", false, false, false, false, Some(fill.as_str().to_owned()), None, None, None, None),
                ElementKind::Claim { .. } => ("claim", false, false, false, false, None, None, None, None, None),
                ElementKind::HtmlEmbed { .. } => ("html", false, false, false, false, None, None, None, None, None),
            };
            SelectionSummary {
                id: Some(el.id.0.clone()),
                kind_name: kind_name.to_owned(),
                rev: el.rev,
                is_shape,
                is_arrow,
                is_text,
                is_path,
                is_locked: el.locked,
                has_group: el.group_id.is_some(),
                fill,
                shape,
                curve,
                style,
                sticker,
            }
        }
        None => SelectionSummary::default(),
    };

    let rows = ctrl
        .doc
        .elements
        .iter()
        .map(|el| {
            let tag = match &el.kind {
                ElementKind::Shape { .. } => "shape",
                ElementKind::Arrow { .. } => "arrow",
                ElementKind::Text { .. } => "text",
                ElementKind::Path { .. } => "path",
                ElementKind::Container { .. } => "container",
                ElementKind::Timeline { .. } => "timeline",
                ElementKind::Sticker { .. } => "sticker",
                ElementKind::Svg { .. } => "svg",
                ElementKind::Image { .. } => "image",
                ElementKind::Table { .. } => "table",
                ElementKind::Claim { .. } => "claim",
                ElementKind::HtmlEmbed { .. } => "html",
            };
            (el.id.0.clone(), el.primary_label().to_owned(), tag.to_owned())
        })
        .collect();

    WhiteboardUiSnapshot {
        tool: ToolKindTag::from_tool(&ctrl.tool),
        count: ctrl.doc.elements.len(),
        can_undo: ctrl.history.can_undo(),
        can_redo: ctrl.history.can_redo(),
        grid: ctrl.doc.meta.grid,
        selection: ctrl.selection.clone(),
        selection_kind,
        presences: ctrl.doc.presences.clone(),
        follow_actor: ctrl.follow_actor.clone(),
        all_element_rows: rows,
    }
}

fn emit_export_request(cx: Scope<VvWhiteboardEvent>, fmt: ExportFormat, doc: BoardDoc, base: String, is_dark: bool) {
    match fmt {
        ExportFormat::Svg => {
            let content = export_svg(&doc, is_dark);
            cx.emit(VvWhiteboardEvent::Export(VvWhiteboardExportEvent {
                format: SharedString::from("svg"),
                filename: SharedString::from(format!("{base}.svg")),
                mime: SharedString::from("image/svg+xml"),
                content: SharedString::from(content),
            }));
        }
        ExportFormat::Json => {
            if let Ok(content) = export_json(&doc) {
                cx.emit(VvWhiteboardEvent::Export(VvWhiteboardExportEvent {
                    format: SharedString::from("json"),
                    filename: SharedString::from(format!("{base}.json")),
                    mime: SharedString::from("application/json"),
                    content: SharedString::from(content),
                }));
            }
        }
        ExportFormat::JsonCanvas => {
            if let Ok(content) = export_json_canvas(&doc) {
                cx.emit(VvWhiteboardEvent::Export(VvWhiteboardExportEvent {
                    format: SharedString::from("json-canvas"),
                    filename: SharedString::from(format!("{base}.canvas")),
                    mime: SharedString::from("application/json"),
                    content: SharedString::from(content),
                }));
            }
        }
        ExportFormat::Png => {
            let (painter, w, h) = build_export_painter(&doc, is_dark);
            let mut opts = RenderOptions::default();
            opts.scale = Some(2.0);
            opts.format = ImageFormat::Png;
            let answer = painter.render(size(px(w), px(h)), opts);
            drop(spawn(async move {
                match answer.await {
                    Ok(bytes) => {
                        let b64 = BASE64.encode(&bytes);
                        cx.emit(VvWhiteboardEvent::Export(VvWhiteboardExportEvent {
                            format: SharedString::from("png"),
                            filename: SharedString::from(format!("{base}.png")),
                            mime: SharedString::from("image/png"),
                            content: SharedString::from(b64),
                        }));
                    }
                    Err(_) => {
                        let svg_fallback = export_svg(&doc, is_dark);
                        cx.emit(VvWhiteboardEvent::Export(VvWhiteboardExportEvent {
                            format: SharedString::from("svg"),
                            filename: SharedString::from(format!("{base}.svg")),
                            mime: SharedString::from("image/svg+xml"),
                            content: SharedString::from(svg_fallback),
                        }));
                    }
                }
            }));
        }
    }
}

fn is_mutating_action(action: &BoardAction) -> bool {
    !matches!(
        action,
        BoardAction::FitToContent
            | BoardAction::ZoomToSelection
            | BoardAction::ResetZoom
            | BoardAction::ZoomBy(_)
            | BoardAction::SelectAll
            | BoardAction::FollowActor(_)
            | BoardAction::AskOrchestrator
            | BoardAction::Export(_)
            | BoardAction::CopySelection
    )
}

pub(super) fn map_mods(m: &Modifiers, space: bool) -> WbModifiers {
    WbModifiers {
        shift: m.shift,
        alt: m.alt,
        accel: m.cmd || m.ctrl,
        space,
    }
}

pub(super) fn map_mouse_btn(btn: Option<MouseButton>) -> WbPointerButton {
    match btn {
        Some(MouseButton::Right) => WbPointerButton::Secondary,
        Some(MouseButton::Middle) => WbPointerButton::Middle,
        _ => WbPointerButton::Primary,
    }
}
