//! Native interactive `VvWhiteboard` `#[component]` backed by pure-Rust `engine::whiteboard`.
//!
//! Renders infinite pan/zoom boards using dual-layer [`nsh_core::prelude::canvas`] views (an
//! LRU-cached static layer and an interactive overlay layer for selection handles, snap guides,
//! live ink/box previews, and collaborator cursors) with GPUI-native floating docks, inline
//! editors, minimap, context menu, and collapsible inspector (zero `WKWebView`).

use std::cell::RefCell;
use std::collections::BTreeSet;
use std::rc::Rc;

use nsh_core::canvas::render::{ImageFormat, RenderOptions};
use nsh_core::element::{ImageSrc, input};
use nsh_core::keymap::Modifiers;
use nsh_core::prelude::*;
use serde::Deserialize;
use vibevalley_i18n::t_in;
use vibevalley_protocol::ArtifactEntry;

use crate::engine::whiteboard::{
    AlignOp, ArrowCurve, BoardAction, BoardCommand, BoardDoc, DistributeAxis, ElementId, ElementKind, GridStyle, LayerPaintInput, Modifiers as WbModifiers,
    Point2, PointerButton as WbPointerButton, PointerInput, Presence, PresenceColor, STICKERS, ShapeKind, StickerCategory, StrokeStyle, TemplateKind,
    WhiteboardController, ZOrderDir, apply_command, build_export_painter, decode_board_entries, encode_element_json, export_json, export_json_canvas,
    export_svg, measure_text_span, paint_minimap_painter, paint_overlay_layer_painter_filtered, paint_static_layer_painter,
};
use crate::theme::AdaptiveUi;

/// Props of [`VvWhiteboard`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub struct VvWhiteboardProps {
    /// Serialized JSON array of [`ArtifactEntry`] records stored on the artifact.
    pub entries_json: Prop<SharedString>,
    /// Optional serialized JSON array of extra live [`Presence`] objects (e.g. working agents).
    #[prop(default)]
    pub presences_json: Prop<SharedString>,
    /// Monotonic artifact store sequence number reported by the server.
    #[prop(default)]
    pub seq: Prop<i64>,
    /// Board title used in default export filenames and accessibility labels.
    #[prop(default)]
    pub title: Prop<SharedString>,
    /// Disables local element mutations when `true` while preserving navigation, inspect, and export.
    #[prop(default)]
    pub read_only: Prop<bool>,
    /// UI locale code (`"zh"` or `"en"`) driving labels and template starter copy.
    #[prop(default)]
    pub locale: Prop<SharedString>,
}

/// Payload emitted when local whiteboard edits need persistence via `artifact.entry.batch`.
#[derive(Debug, Clone, Default, PartialEq, Eq, JsObject)]
pub struct VvWhiteboardBatchEvent {
    /// Serialized JSON array of `ArtifactEntryWriteInput` operations (preserving `ifRev` guards).
    pub writes_json: SharedString,
}

/// Payload emitted when the whiteboard selection changes.
#[derive(Debug, Clone, Default, PartialEq, Eq, JsObject)]
pub struct VvWhiteboardSelectionEvent {
    /// Serialized JSON array of selected element ID strings.
    pub ids_json: SharedString,
    /// Number of currently selected elements.
    pub count: u32,
}

/// Payload emitted when the user asks the orchestrator about the current selection.
#[derive(Debug, Clone, Default, PartialEq, Eq, JsObject)]
pub struct VvWhiteboardChatEvent {
    /// Serialized JSON array of selected element IDs passed as view context.
    pub selected_ids_json: SharedString,
}

/// Payload emitted when the user exports the whiteboard (`svg`, `png`, `json`, or `json-canvas`).
#[derive(Debug, Clone, Default, PartialEq, Eq, JsObject)]
pub struct VvWhiteboardExportEvent {
    /// Export format identifier (`"svg"`, `"png"`, `"json"`, or `"json-canvas"`).
    pub format: SharedString,
    /// Suggested file name including extension.
    pub filename: SharedString,
    /// MIME type of `content` (`"image/svg+xml"`, `"image/png"`, `"application/json"`).
    pub mime: SharedString,
    /// Exported payload text (UTF-8 for SVG/JSON, base64-encoded binary for PNG).
    pub content: SharedString,
}

/// Events emitted by [`VvWhiteboard`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum VvWhiteboardEvent {
    /// Local edits produced optimistic store writes for `artifact.entry.batch`.
    #[args(event)]
    Batch(VvWhiteboardBatchEvent),
    /// Active selection changed on the board.
    #[args(event)]
    SelectionChange(VvWhiteboardSelectionEvent),
    /// User clicked the native chat CTA to discuss or co-edit the board with the orchestrator.
    #[args(event)]
    OpenChat(VvWhiteboardChatEvent),
    /// User triggered SVG, 2x retina PNG, structured JSON, or JSON Canvas export.
    #[args(event)]
    Export(VvWhiteboardExportEvent),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtraPresenceWire {
    id: String,
    name: String,
    color: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    status: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct InlineEditState {
    id: ElementId,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    is_shape: bool,
    milestone_index: Option<usize>,
}

#[derive(Debug, Clone, PartialEq)]
struct ContextMenuState {
    x: f32,
    y: f32,
    has_selection: bool,
}

#[derive(Clone, Default, PartialEq)]
struct WhiteboardUiSnapshot {
    tool: ToolKindTag,
    count: usize,
    zoom_pct: u32,
    can_undo: bool,
    can_redo: bool,
    grid: GridStyle,
    selection: Vec<ElementId>,
    selection_kind: SelectionSummary,
    presences: Vec<Presence>,
    follow_actor: Option<String>,
    all_element_rows: Vec<(String, String, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum ToolKindTag {
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
    fn from_tool(tool: &crate::engine::whiteboard::Tool) -> Self {
        use crate::engine::whiteboard::Tool as T;
        match tool {
            T::Select => Self::Select,
            T::Hand => Self::Hand,
            T::Text => Self::Text,
            T::Callout => Self::Callout,
            T::Container => Self::Container,
            T::Card => Self::Card,
            T::Sticky => Self::Sticky,
            T::Shape(ShapeKind::Diamond) => Self::Diamond,
            T::Shape(ShapeKind::Ellipse) => Self::Ellipse,
            T::Shape(ShapeKind::Cylinder) => Self::Cylinder,
            T::Shape(_) => Self::Rect,
            T::Pen => Self::Pen,
            T::Highlighter => Self::Highlighter,
            T::Eraser => Self::Eraser,
            T::Sticker(_) => Self::Sticker,
            T::Arrow => Self::Arrow,
            T::Timeline => Self::Timeline,
            T::Table => Self::Table,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct SelectionSummary {
    id: Option<String>,
    kind_name: String,
    rev: i64,
    is_shape: bool,
    is_arrow: bool,
    is_text: bool,
    is_path: bool,
    is_locked: bool,
    has_group: bool,
    fill: Option<String>,
    shape: Option<ShapeKind>,
    curve: Option<ArrowCurve>,
    style: Option<StrokeStyle>,
    sticker: Option<String>,
}

/// Interactive native whiteboard canvas with dual-layer rendering, dock tools, minimap, and inspector.
#[component]
pub fn VvWhiteboard(props: VvWhiteboardProps, cx: Scope<VvWhiteboardEvent>) -> impl IntoElement {
    let controller = Rc::new(RefCell::new(WhiteboardController::default()));
    let static_tick = signal(0u64);
    let overlay_tick = signal(0u64);
    let ui_tick = signal(0u64);
    let viewport_size = signal((1100.0_f32, 720.0_f32));
    let space_held = signal(false);

    let inline_edit: Signal<Option<InlineEditState>> = signal(None);
    let inline_title = signal(String::new());
    let inline_body = signal(String::new());

    let context_menu: Signal<Option<ContextMenuState>> = signal(None);
    let sticker_picker_open = signal(false);
    let template_picker_open = signal(false);
    let timer_open = signal(false);
    let export_menu_open = signal(false);
    let minimap_open = signal(false);
    let timer_running = signal(false);
    let timer_secs = signal(300u32);
    let dismissed_notes: Signal<BTreeSet<String>> = signal(BTreeSet::new());
    let inspector_open = signal(false);
    let inspector_focused = signal(false);

    let timer_handle = set_interval(std::time::Duration::from_secs(1), move || {
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

    let label_draft = signal(String::new());
    let body_draft = signal(String::new());
    let json_draft = signal(String::new());

    let ui_snap = signal(WhiteboardUiSnapshot::default());
    let last_sync = Rc::new(RefCell::new((SharedString::default(), SharedString::default(), i64::MIN)));
    let hidden_ids = Rc::new(BTreeSet::<ElementId>::new());

    let loc_str = move || {
        let l = props.locale.get();
        if l.is_empty() { SharedString::from("zh") } else { l }
    };
    let tr = move |key: &str| {
        let l = loc_str();
        t_in(l.as_str(), key, &[])
    };

    let sync_ui_snapshot = {
        let controller = Rc::clone(&controller);
        move || {
            let snap = {
                let ctrl = controller.borrow();
                build_ui_snapshot(&ctrl)
            };
            if let Some(first_id) = snap.selection.first().cloned() {
                let (lbl, bd, js) = {
                    let ctrl = controller.borrow();
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
                label_draft.set(lbl);
                body_draft.set(bd);
                json_draft.set(js);
            } else {
                label_draft.set(String::new());
                body_draft.set(String::new());
                json_draft.set(String::new());
            }
            ui_snap.set(snap);
            ui_tick.set(ui_tick.get_untracked().wrapping_add(1));
        }
    };

    let dispatch_effects = {
        let controller = Rc::clone(&controller);
        let sync_ui_snapshot = sync_ui_snapshot.clone();
        move |effects: Vec<crate::engine::whiteboard::ControllerEffect>, doc_mutated: bool| {
            let mut flush_writes = None;
            let mut sel_changed = None;
            let mut open_chat_ids = None;
            let mut export_req = None;
            let mut viewport_bumped = false;
            let mut rebuild_ui = doc_mutated;

            for eff in effects {
                use crate::engine::whiteboard::ControllerEffect as E;
                match eff {
                    E::FlushBatch(w) => {
                        if !w.is_empty() {
                            flush_writes = Some(w);
                        }
                        rebuild_ui = true;
                    }
                    E::SelectionChanged(ids) => {
                        sel_changed = Some(ids);
                        rebuild_ui = true;
                    }
                    E::ToolChanged(_) | E::GridChanged(_) | E::HistoryChanged { .. } => {
                        rebuild_ui = true;
                    }
                    E::ViewportChanged { .. } => {
                        viewport_bumped = true;
                        rebuild_ui = true;
                    }
                    E::OpenInlineEditor(target) => {
                        context_menu.set(None);
                        sticker_picker_open.set(false);
                        template_picker_open.set(false);
                        inline_title.set(target.title);
                        inline_body.set(target.body);
                        let is_shape = matches!(controller.borrow().doc.element(&target.id).map(|e| &e.kind), Some(ElementKind::Shape { .. }));
                        inline_edit.set(Some(InlineEditState {
                            id: target.id,
                            x: target.screen_rect.x.max(12.0) as f32,
                            y: target.screen_rect.y.max(48.0) as f32,
                            w: target.screen_rect.w.max(200.0) as f32,
                            h: target.screen_rect.h.max(64.0) as f32,
                            is_shape,
                            milestone_index: target.milestone_index,
                        }));
                    }
                    E::OpenContextMenu { screen_pos, .. } => {
                        let has_selection = !controller.borrow().selection.is_empty();
                        sticker_picker_open.set(false);
                        template_picker_open.set(false);
                        context_menu.set(Some(ContextMenuState {
                            x: screen_pos.x.max(12.0) as f32,
                            y: screen_pos.y.max(48.0) as f32,
                            has_selection,
                        }));
                    }
                    E::OpenChatWithSelection(ids) => {
                        open_chat_ids = Some(ids);
                    }
                    E::RequestExport(fmt) => {
                        export_req = Some(fmt);
                    }
                }
            }

            if doc_mutated || viewport_bumped || flush_writes.is_some() {
                static_tick.set(static_tick.get_untracked().wrapping_add(1));
            }
            overlay_tick.set(overlay_tick.get_untracked().wrapping_add(1));

            if rebuild_ui {
                sync_ui_snapshot();
            }

            // Emit external events strictly after all controller borrows are released.
            if let Some(ids) = sel_changed {
                let count = ids.len() as u32;
                let id_strs: Vec<&str> = ids.iter().map(|i| i.as_str()).collect();
                let ids_json = serde_json::to_string(&id_strs).unwrap_or_else(|_| "[]".to_owned());
                cx.emit(VvWhiteboardEvent::SelectionChange(VvWhiteboardSelectionEvent {
                    ids_json: SharedString::from(ids_json),
                    count,
                }));
            }
            if let Some(writes) = flush_writes {
                let writes_json = serde_json::to_string(&writes).unwrap_or_else(|_| "[]".to_owned());
                cx.emit(VvWhiteboardEvent::Batch(VvWhiteboardBatchEvent {
                    writes_json: SharedString::from(writes_json),
                }));
            }
            if let Some(ids) = open_chat_ids {
                let id_strs: Vec<&str> = ids.iter().map(|i| i.as_str()).collect();
                let selected_ids_json = serde_json::to_string(&id_strs).unwrap_or_else(|_| "[]".to_owned());
                cx.emit(VvWhiteboardEvent::OpenChat(VvWhiteboardChatEvent {
                    selected_ids_json: SharedString::from(selected_ids_json),
                }));
            }
            if let Some(fmt) = export_req {
                let doc_snap = controller.borrow().doc.clone();
                let base = sanitize_filename(props.title.get_untracked().as_str());
                let is_dark = dark();
                emit_export_request(cx, fmt, doc_snap, base, is_dark);
            }
        }
    };

    // Sync incoming entries JSON & live session presences without resetting camera or tool state.
    {
        let controller = Rc::clone(&controller);
        let dispatch_effects = dispatch_effects.clone();
        let sync_ui_snapshot = sync_ui_snapshot.clone();
        effect(move || {
            let entries_raw = props.entries_json.get();
            let presences_raw = props.presences_json.get();
            let seq = props.seq.get();

            {
                let mut prev = last_sync.borrow_mut();
                if prev.0 == entries_raw && prev.1 == presences_raw && prev.2 == seq {
                    return;
                }
                *prev = (entries_raw.clone(), presences_raw.clone(), seq);
            }

            let parsed_entries: Vec<ArtifactEntry> = serde_json::from_str(entries_raw.as_str()).unwrap_or_default();
            let mut next_doc = decode_board_entries(&parsed_entries, seq);
            if !presences_raw.is_empty()
                && let Ok(extra_list) = serde_json::from_str::<Vec<ExtraPresenceWire>>(presences_raw.as_str())
            {
                for ep in extra_list {
                    if !next_doc.presences.iter().any(|p| p.id == ep.id) {
                        next_doc.presences.push(Presence {
                            id: ep.id,
                            name: ep.name,
                            color: PresenceColor::from_wire(ep.color.as_deref().unwrap_or("coral")),
                            x: ep.x.unwrap_or(120.0),
                            y: ep.y.unwrap_or(120.0),
                            status: ep.status,
                            selected_ids: Vec::new(),
                            rev: 0,
                        });
                    }
                }
            }

            let effs = controller.borrow_mut().apply_remote_snapshot(next_doc);
            if effs.is_empty() {
                static_tick.set(static_tick.get_untracked().wrapping_add(1));
                overlay_tick.set(overlay_tick.get_untracked().wrapping_add(1));
                sync_ui_snapshot();
            } else {
                dispatch_effects(effs, true);
            }
        });
    }

    let run_action = {
        let controller = Rc::clone(&controller);
        let dispatch_effects = dispatch_effects.clone();
        move |action: BoardAction| {
            context_menu.set(None);
            sticker_picker_open.set(false);
            template_picker_open.set(false);
            export_menu_open.set(false);
            timer_open.set(false);
            if props.read_only.get_untracked() && is_mutating_action(&action) {
                return;
            }
            let effs = controller.borrow_mut().run_action(action);
            dispatch_effects(effs, true);
        }
    };

    let set_tool = {
        let controller = Rc::clone(&controller);
        let dispatch_effects = dispatch_effects.clone();
        move |next_tool: crate::engine::whiteboard::Tool| {
            context_menu.set(None);
            sticker_picker_open.set(false);
            template_picker_open.set(false);
            export_menu_open.set(false);
            timer_open.set(false);
            let effs = controller.borrow_mut().set_tool(next_tool);
            dispatch_effects(effs, false);
        }
    };

    let commit_inline = {
        let controller = Rc::clone(&controller);
        let dispatch_effects = dispatch_effects.clone();
        move || {
            let Some(st) = inline_edit.get_untracked() else {
                return;
            };
            inline_edit.set(None);
            let title = inline_title.get_untracked();
            let body = inline_body.get_untracked();
            let effs = controller.borrow_mut().commit_inline_edit(&st.id, title, body, st.milestone_index);
            dispatch_effects(effs, true);
        }
    };

    // Static layer canvas.
    let static_canvas: CanvasView = {
        let paint_ctrl = Rc::clone(&controller);
        let hidden_ids = Rc::clone(&hidden_ids);
        let sync_ui_snapshot = sync_ui_snapshot.clone();
        canvas(move || {
            let _ = static_tick.get();
            let is_dark = dark();
            let vw_vh = viewport_size.get();
            let ctrl = paint_ctrl.borrow();
            paint_static_layer_painter(&LayerPaintInput {
                doc: &ctrl.doc,
                index: &ctrl.spatial,
                lookup: &ctrl.lookup,
                camera: ctrl.camera,
                viewport_size: vw_vh,
                selection: &ctrl.selection,
                editing_id: None,
                dark: is_dark,
                anim_hidden_ids: &hidden_ids,
            })
        })
        .test_id("wb-canvas")
        .absolute()
        .inset(px(0.0))
        .on_layout({
            let controller = Rc::clone(&controller);
            move |b: &nsh_core::prelude::Bounds<nsh_core::prelude::Points>| {
                let w = b.size.width.0.max(120.0);
                let h = b.size.height.0.max(120.0);
                let prev = viewport_size.get_untracked();
                if (prev.0 - w).abs() > 0.5 || (prev.1 - h).abs() > 0.5 {
                    viewport_size.set((w, h));
                    controller.borrow_mut().set_viewport_size(f64::from(w), f64::from(h));
                    static_tick.set(static_tick.get_untracked().wrapping_add(1));
                    overlay_tick.set(overlay_tick.get_untracked().wrapping_add(1));
                    sync_ui_snapshot();
                }
            }
        })
    };

    // Overlay layer canvas (handles, snap guides, previews, marquee, cursors).
    let overlay_canvas: CanvasView = {
        let controller = Rc::clone(&controller);
        canvas(move || {
            let _ = overlay_tick.get();
            let dismissed = dismissed_notes.get();
            let is_dark = dark();
            let vw_vh = viewport_size.get();
            let ctrl = controller.borrow();
            paint_overlay_layer_painter_filtered(&ctrl, vw_vh, is_dark, &dismissed)
        })
        .absolute()
        .inset(px(0.0))
        .pointer_events(PointerEvents::None)
    };

    // Interactive stage wrapping the two canvases.
    let stage = view()
        .relative()
        .flex_1()
        .h_full()
        .overflow_hidden()
        .child(static_canvas)
        .child(overlay_canvas)
        .on_press_down({
            let controller = Rc::clone(&controller);
            let dispatch_effects = dispatch_effects.clone();
            move |e: &PressEvent| {
                context_menu.set(None);
                sticker_picker_open.set(false);
                template_picker_open.set(false);
                export_menu_open.set(false);
                timer_open.set(false);
                if inline_edit.get_untracked().is_some() {
                    return;
                }
                let sx = f64::from(e.position.x.0);
                let sy = f64::from(e.position.y.0);
                let dismissed_hit = {
                    let ctrl = controller.borrow();
                    let cur_dismissed = dismissed_notes.get_untracked();
                    ctrl.doc.presences.iter().find_map(|p| {
                        if cur_dismissed.contains(&p.id) {
                            return None;
                        }
                        let msg = p.status.as_deref().map(str::trim).filter(|t| t.chars().count() > 14)?;
                        let tip = ctrl.camera.world_to_screen(Point2::new(p.x, p.y));
                        let pill_w = (measure_text_span(msg, 12.5, false) + 52.0).clamp(160.0, 580.0);
                        let close_cx = tip.x + 10.0 + pill_w - 17.0;
                        let close_cy = tip.y + 26.0;
                        ((sx - close_cx).abs() <= 14.0 && (sy - close_cy).abs() <= 14.0).then(|| p.id.clone())
                    })
                };
                if let Some(pid) = dismissed_hit {
                    let mut next = dismissed_notes.get_untracked();
                    next.insert(pid);
                    dismissed_notes.set(next);
                    overlay_tick.set(overlay_tick.get_untracked().wrapping_add(1));
                    return;
                }
                let input = PointerInput {
                    screen_pos: Point2::new(f64::from(e.position.x.0), f64::from(e.position.y.0)),
                    clicks: e.clicks.max(1),
                    button: WbPointerButton::Primary,
                    modifiers: map_mods(&e.modifiers, space_held.get_untracked()),
                    pressure: 0.6,
                };
                if props.read_only.get_untracked()
                    && !matches!(
                        controller.borrow().tool,
                        crate::engine::whiteboard::Tool::Hand | crate::engine::whiteboard::Tool::Select
                    )
                {
                    return;
                }
                let effs = controller.borrow_mut().handle_pointer_down(input);
                dispatch_effects(effs, false);
            }
        })
        .on_mouse_move({
            let controller = Rc::clone(&controller);
            let dispatch_effects = dispatch_effects.clone();
            move |e: &MouseEvent| {
                let mut pressure = e.pressure;
                if pressure <= 0.01 {
                    pressure = 0.55;
                }
                let input = PointerInput {
                    screen_pos: Point2::new(f64::from(e.position.x.0), f64::from(e.position.y.0)),
                    clicks: 1,
                    button: map_mouse_btn(e.pressed_button),
                    modifiers: map_mods(&e.modifiers, space_held.get_untracked()),
                    pressure,
                };
                let was_mutating = !matches!(
                    controller.borrow().mode,
                    crate::engine::whiteboard::InteractionMode::Idle | crate::engine::whiteboard::InteractionMode::Marquee { .. }
                );
                let effs = controller.borrow_mut().handle_pointer_move(input);
                let is_panning = matches!(controller.borrow().mode, crate::engine::whiteboard::InteractionMode::Panning { .. });
                dispatch_effects(effs, was_mutating || is_panning);
            }
        })
        .on_mouse_up({
            let controller = Rc::clone(&controller);
            let dispatch_effects = dispatch_effects.clone();
            move |e: &MouseEvent| {
                let was_active = !matches!(controller.borrow().mode, crate::engine::whiteboard::InteractionMode::Idle);
                if !was_active {
                    return;
                }
                let input = PointerInput {
                    screen_pos: Point2::new(f64::from(e.position.x.0), f64::from(e.position.y.0)),
                    clicks: 1,
                    button: map_mouse_btn(e.button),
                    modifiers: map_mods(&e.modifiers, space_held.get_untracked()),
                    pressure: e.pressure.max(0.5),
                };
                let effs = controller.borrow_mut().handle_pointer_up(input);
                dispatch_effects(effs, true);
            }
        })
        .on_wheel({
            let controller = Rc::clone(&controller);
            let dispatch_effects = dispatch_effects.clone();
            move |e: &WheelEvent| {
                let (dx, dy, precise) = match e.delta {
                    WheelDelta::Points(pt) => (-f64::from(pt.x.0), -f64::from(pt.y.0), true),
                    WheelDelta::Lines(pt) => (-f64::from(pt.x), -f64::from(pt.y), false),
                };
                let effs = controller.borrow_mut().handle_wheel(
                    Point2::new(f64::from(e.position.x.0), f64::from(e.position.y.0)),
                    dx,
                    dy,
                    precise,
                    map_mods(&e.modifiers, space_held.get_untracked()),
                );
                dispatch_effects(effs, false);
            }
        })
        .on_pinch({
            let controller = Rc::clone(&controller);
            let dispatch_effects = dispatch_effects.clone();
            move |e: &PinchEvent| {
                let effs = controller
                    .borrow_mut()
                    .handle_pinch(Point2::new(f64::from(e.position.x.0), f64::from(e.position.y.0)), f64::from(e.delta.0));
                dispatch_effects(effs, false);
            }
        })
        .on_context_menu({
            let controller = Rc::clone(&controller);
            let dispatch_effects = dispatch_effects.clone();
            move |e: &ContextMenuEvent| {
                let input = PointerInput {
                    screen_pos: Point2::new(f64::from(e.position.x.0), f64::from(e.position.y.0)),
                    clicks: 1,
                    button: WbPointerButton::Secondary,
                    modifiers: map_mods(&e.modifiers, false),
                    pressure: 0.5,
                };
                let effs = controller.borrow_mut().handle_pointer_down(input);
                dispatch_effects(effs, false);
            }
        });

    // Build modular floating chrome pills & drawers as siblings of `stage` so dock clicks never leak into canvas drags.
    let top_left_hud = {
        let run_action = run_action.clone();
        let controller = Rc::clone(&controller);
        let dispatch_effects = dispatch_effects.clone();
        dynamic(move || {
            let snap = ui_snap.get();
            let ro = props.read_only.get();
            let l = loc_str();
            let is_en = l.starts_with("en");
            let count_txt = t_in(l.as_str(), "web.artifact.whiteboard.elements", &[("n", snap.count.into())]);

            let next_grid = match snap.grid {
                GridStyle::Architectural => GridStyle::Dots,
                GridStyle::Dots => GridStyle::None,
                GridStyle::None => GridStyle::Architectural,
            };
            let grid_lbl = match snap.grid {
                GridStyle::Architectural => {
                    if is_en {
                        "Grid"
                    } else {
                        "方格"
                    }
                }
                GridStyle::Dots => {
                    if is_en {
                        "Dots"
                    } else {
                        "点阵"
                    }
                }
                GridStyle::None => {
                    if is_en {
                        "Plain"
                    } else {
                        "纯白"
                    }
                }
            };

            let mut row = floating_pill()
                .child(
                    text(count_txt)
                        .test_id("wb-count")
                        .text_size(px(11.5))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(AdaptiveUi::MUTED)
                        .px(px(6.0)),
                )
                .child(pill_divider())
                .child(pill_icon_btn(
                    "wb-undo",
                    &t_in(l.as_str(), "web.artifact.whiteboard.undo", &[]),
                    ICON_UNDO,
                    false,
                    !snap.can_undo || ro,
                    {
                        let run = run_action.clone();
                        move || run(BoardAction::Undo)
                    },
                ))
                .child(pill_icon_btn(
                    "wb-redo",
                    &t_in(l.as_str(), "web.artifact.whiteboard.redo", &[]),
                    ICON_REDO,
                    false,
                    !snap.can_redo || ro,
                    {
                        let run = run_action.clone();
                        move || run(BoardAction::Redo)
                    },
                ))
                .child(pill_divider())
                .child(pill_text_btn("wb-grid-toggle", grid_lbl, false, false, {
                    let run = run_action.clone();
                    move || run(BoardAction::SetGrid(next_grid))
                }));

            if !ro {
                row = row.child(pill_divider()).child(pill_text_btn(
                    "wb-template-trigger",
                    if is_en { "Templates" } else { "模板" },
                    template_picker_open.get(),
                    false,
                    move || {
                        sticker_picker_open.set(false);
                        export_menu_open.set(false);
                        timer_open.set(false);
                        template_picker_open.set(!template_picker_open.get_untracked());
                    },
                ));
            }
            let _ = (is_en, &controller, &dispatch_effects);
            view().absolute().top(px(12.0)).left(px(12.0)).child(row).into_element()
        })
    };

    let top_right_hud = {
        let run_action = run_action.clone();
        dynamic(move || {
            let snap = ui_snap.get();
            let l = loc_str();
            let is_en = l.starts_with("en");
            let mut row = floating_pill();

            // Live collaborator presence pills (deduplicated, capped at 2 for narrow viewports).
            if !snap.presences.is_empty() {
                let mut unique: Vec<&Presence> = Vec::with_capacity(snap.presences.len());
                for p in &snap.presences {
                    if !unique.iter().any(|u| u.id == p.id && u.name == p.name) {
                        unique.push(p);
                    }
                }
                let shown_limit = 2usize;
                for p in unique.iter().take(shown_limit) {
                    let following = snap.follow_actor.as_deref() == Some(p.id.as_str());
                    let pid = p.id.clone();
                    let label = if following { format!("✓ {}", p.name) } else { p.name.clone() };
                    let dot_color = presence_adaptive_color(p.color);
                    row = row.child(
                        view()
                            .test_id(&format!("wb-presence-{}", p.id))
                            .role(AccessibilityRole::Button)
                            .flex_row()
                            .items_center()
                            .gap(px(4.0))
                            .rounded(px(999.0))
                            .px(px(6.0))
                            .py(px(3.0))
                            .bg(if following { AdaptiveUi::SELECTED } else { AdaptiveUi::SIDE })
                            .border(px(1.0))
                            .border_color(if following { AdaptiveUi::ACCENT } else { AdaptiveUi::LINE })
                            .cursor_pointer()
                            .on_press({
                                let run = run_action.clone();
                                move |_: &PressEvent| {
                                    let next = if following { None } else { Some(pid.clone()) };
                                    run(BoardAction::FollowActor(next));
                                }
                            })
                            .child(view().size(px(6.0)).rounded(px(999.0)).bg(dot_color))
                            .child(text(label).text_size(px(11.0)).font_weight(FontWeight::MEDIUM).text_color(AdaptiveUi::INK)),
                    );
                }
                if unique.len() > shown_limit {
                    let extra = unique.len() - shown_limit;
                    row = row.child(
                        text(format!("+{extra}"))
                            .test_id("wb-presence-more")
                            .text_size(px(10.5))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(AdaptiveUi::MUTED)
                            .px(px(4.0)),
                    );
                }
                row = row.child(pill_divider());
            }

            let rem = timer_secs.get();
            let t_active = timer_running.get() || timer_open.get();
            let timer_text = format!("{:02}:{:02}", rem / 60, rem % 60);
            row = row
                .child(
                    view()
                        .test_id("wb-timer-toggle")
                        .role(AccessibilityRole::Button)
                        .label(SharedString::from(if is_en { "Workshop timer" } else { "工作坊计时器" }))
                        .flex_row()
                        .items_center()
                        .gap(px(5.0))
                        .rounded(px(7.0))
                        .px(px(7.0))
                        .py(px(4.0))
                        .bg(if t_active { AdaptiveUi::SELECTED } else { AdaptiveUi::PAGE })
                        .cursor_pointer()
                        .hover(|s| s.bg(AdaptiveUi::HOVER))
                        .on_press(move |_: &PressEvent| {
                            sticker_picker_open.set(false);
                            template_picker_open.set(false);
                            export_menu_open.set(false);
                            timer_open.set(!timer_open.get_untracked());
                        })
                        .child(
                            svg(ImageSrc::svg_markup(ICON_TIMER))
                                .size(px(14.0))
                                .text_color(if t_active { AdaptiveUi::ACCENT } else { AdaptiveUi::MUTED }),
                        )
                        .child(
                            text(timer_text)
                                .text_size(px(11.5))
                                .font_weight(if t_active { FontWeight::SEMIBOLD } else { FontWeight::MEDIUM })
                                .text_color(if t_active { AdaptiveUi::INK } else { AdaptiveUi::MUTED }),
                        ),
                )
                .child(pill_divider())
                .child(pill_text_btn("wb-export-svg", "SVG", false, false, {
                    let run = run_action.clone();
                    move || run(BoardAction::Export(crate::engine::whiteboard::ExportFormat::Svg))
                }))
                .child(
                    pill_text_btn("wb-export-more", "⋯", export_menu_open.get(), false, move || {
                        sticker_picker_open.set(false);
                        template_picker_open.set(false);
                        timer_open.set(false);
                        export_menu_open.set(!export_menu_open.get_untracked());
                    })
                    .label(SharedString::from(if is_en { "More exports" } else { "更多导出格式" })),
                )
                .child(pill_divider())
                .child(pill_text_btn(
                    "wb-inspector-toggle",
                    &t_in(l.as_str(), "web.artifact.whiteboard.inspector", &[]),
                    inspector_open.get(),
                    false,
                    move || inspector_open.set(!inspector_open.get_untracked()),
                ));

            let _ = is_en;
            view().absolute().top(px(12.0)).right(px(12.0)).child(row).into_element()
        })
    };

    // Template dropdown popover (top-left).
    let template_popover = {
        let run_action = run_action.clone();
        dynamic(move || {
            if !template_picker_open.get() {
                return view().into_element();
            }
            let l = loc_str();
            let is_en = l.starts_with("en");
            let items = [
                (
                    TemplateKind::Timeline,
                    t_in(l.as_str(), "web.artifact.whiteboard.templateTimeline", &[]),
                    "wb-tpl-timeline",
                ),
                (
                    TemplateKind::Workshop,
                    if is_en { "Launch Workshop" } else { "启动工作坊" }.to_owned(),
                    "wb-tpl-workshop",
                ),
                (
                    TemplateKind::Architecture,
                    t_in(l.as_str(), "web.artifact.whiteboard.templateArchitecture", &[]),
                    "wb-tpl-arch",
                ),
                (
                    TemplateKind::UserJourney,
                    if is_en { "User Journey" } else { "用户旅程图" }.to_owned(),
                    "wb-tpl-journey",
                ),
                (
                    TemplateKind::Quadrant,
                    if is_en { "2x2 Quadrant" } else { "四象限矩阵" }.to_owned(),
                    "wb-tpl-quadrant",
                ),
                (
                    TemplateKind::Comparison,
                    if is_en { "Comparison Table" } else { "方案对比表" }.to_owned(),
                    "wb-tpl-compare",
                ),
            ];
            let mut panel = floating_card().w(px(210.0)).p(px(6.0)).flex_col().gap(px(3.0));
            for (kind, name, tid) in items {
                panel = panel.child(
                    view()
                        .test_id(tid)
                        .role(AccessibilityRole::Button)
                        .rounded(px(6.0))
                        .px(px(10.0))
                        .py(px(6.0))
                        .cursor_pointer()
                        .hover(|s| s.bg(AdaptiveUi::HOVER))
                        .on_press({
                            let run = run_action.clone();
                            move |_: &PressEvent| run(BoardAction::ApplyTemplate(kind, is_en))
                        })
                        .child(text(name).text_size(px(12.0)).text_color(AdaptiveUi::INK)),
                );
            }
            view().absolute().top(px(56.0)).left(px(12.0)).child(panel).into_element()
        })
    };

    // Contextual floating style bar when >=1 element is selected.
    let style_bar = {
        let run_action = run_action.clone();
        dynamic(move || {
            let snap = ui_snap.get();
            if snap.selection.is_empty() || props.read_only.get() {
                return view().into_element();
            }
            let l = loc_str();
            let is_en = l.starts_with("en");
            let mut row = floating_pill().flex_wrap();

            // 8 warm editorial fills.
            for (fill, hex_light, tid, label_key) in [
                (
                    crate::engine::whiteboard::WbFill::Default,
                    "#fffdf9",
                    "wb-fill-default",
                    "web.artifact.whiteboard.fillDefault",
                ),
                (
                    crate::engine::whiteboard::WbFill::Sun,
                    "#ffe57f",
                    "wb-fill-sun",
                    "web.artifact.whiteboard.fillSun",
                ),
                (
                    crate::engine::whiteboard::WbFill::Peach,
                    "#f9ba7b",
                    "wb-fill-peach",
                    "web.artifact.whiteboard.fillPeach",
                ),
                (
                    crate::engine::whiteboard::WbFill::Leaf,
                    "#cce6b6",
                    "wb-fill-leaf",
                    "web.artifact.whiteboard.fillLeaf",
                ),
                (
                    crate::engine::whiteboard::WbFill::Water,
                    "#cde2f8",
                    "wb-fill-water",
                    "web.artifact.whiteboard.fillWater",
                ),
                (
                    crate::engine::whiteboard::WbFill::Lavender,
                    "#dfd4f8",
                    "wb-fill-lavender",
                    "web.artifact.whiteboard.fillLavender",
                ),
                (
                    crate::engine::whiteboard::WbFill::Berry,
                    "#f8d0ca",
                    "wb-fill-berry",
                    "web.artifact.whiteboard.fillBerry",
                ),
                (
                    crate::engine::whiteboard::WbFill::Side,
                    "#f6f5f3",
                    "wb-fill-side",
                    "web.artifact.whiteboard.fillSide",
                ),
            ] {
                let active = snap.selection_kind.fill.as_deref() == Some(fill.as_str());
                let swatch_color = crate::engine::whiteboard::paint::parse_hex_hsla(hex_light).unwrap_or(nsh_core::prelude::white());
                row = row.child(
                    view()
                        .test_id(tid)
                        .role(AccessibilityRole::Button)
                        .label(SharedString::from(t_in(l.as_str(), label_key, &[])))
                        .size(px(18.0))
                        .rounded(px(999.0))
                        .bg(nsh_core::prelude::AdaptiveColor {
                            light: swatch_color,
                            dark: swatch_color,
                        })
                        .border(px(if active { 2.0 } else { 1.0 }))
                        .border_color(if active { AdaptiveUi::ACCENT } else { AdaptiveUi::LINE })
                        .cursor_pointer()
                        .on_press({
                            let run = run_action.clone();
                            let f = fill.clone();
                            move |_: &PressEvent| run(BoardAction::SetFillSelection(f.clone()))
                        }),
                );
            }

            if snap.selection_kind.is_arrow {
                row = row.child(pill_divider());
                for (c, lbl, slug) in [
                    (ArrowCurve::Smooth, t_in(l.as_str(), "web.artifact.whiteboard.curveSmooth", &[]), "smooth"),
                    (
                        ArrowCurve::Orthogonal,
                        t_in(l.as_str(), "web.artifact.whiteboard.curveOrthogonal", &[]),
                        "ortho",
                    ),
                    (ArrowCurve::Straight, t_in(l.as_str(), "web.artifact.whiteboard.curveStraight", &[]), "straight"),
                ] {
                    row = row.child(pill_text_btn(&format!("wb-curve-{slug}"), &lbl, snap.selection_kind.curve == Some(c), false, {
                        let run = run_action.clone();
                        move || run(BoardAction::SetArrowCurveSelection(c))
                    }));
                }
                row = row.child(pill_divider());
                for (st, lbl, slug) in [
                    (StrokeStyle::Solid, t_in(l.as_str(), "web.artifact.whiteboard.styleSolid", &[]), "solid"),
                    (StrokeStyle::Dashed, t_in(l.as_str(), "web.artifact.whiteboard.styleDashed", &[]), "dashed"),
                ] {
                    row = row.child(pill_text_btn(
                        &format!("wb-style-{slug}"),
                        &lbl,
                        snap.selection_kind.style == Some(st),
                        false,
                        {
                            let run = run_action.clone();
                            move || run(BoardAction::SetStrokeStyleSelection(st))
                        },
                    ));
                }
            }

            if snap.selection.len() >= 2 {
                row = row
                    .child(pill_divider())
                    .child(pill_text_btn("wb-align-left", if is_en { "Align L" } else { "左对齐" }, false, false, {
                        let run = run_action.clone();
                        move || run(BoardAction::Align(AlignOp::Left))
                    }))
                    .child(pill_text_btn("wb-align-center", if is_en { "Center" } else { "居中" }, false, false, {
                        let run = run_action.clone();
                        move || run(BoardAction::Align(AlignOp::CenterH))
                    }))
                    .child(pill_text_btn("wb-dist-h", if is_en { "Dist" } else { "等距" }, false, false, {
                        let run = run_action.clone();
                        move || run(BoardAction::Distribute(DistributeAxis::Horizontal))
                    }))
                    .child(pill_text_btn("wb-tidy-grid", if is_en { "Tidy" } else { "整理" }, false, false, {
                        let run = run_action.clone();
                        move || run(BoardAction::TidyGrid)
                    }));
            }

            row = row
                .child(pill_divider())
                .child(pill_text_btn(
                    "wb-duplicate",
                    &t_in(l.as_str(), "web.artifact.whiteboard.duplicate", &[]),
                    false,
                    false,
                    {
                        let run = run_action.clone();
                        move || run(BoardAction::DuplicateSelection)
                    },
                ))
                .child(pill_text_btn(
                    "wb-lock",
                    if snap.selection_kind.is_locked {
                        if is_en { "Unlock" } else { "解锁" }
                    } else if is_en {
                        "Lock"
                    } else {
                        "锁定"
                    },
                    snap.selection_kind.is_locked,
                    false,
                    {
                        let run = run_action.clone();
                        move || run(BoardAction::ToggleLockSelection)
                    },
                ))
                .child(pill_text_btn(
                    "wb-delete",
                    &t_in(l.as_str(), "web.artifact.whiteboard.deleteSelected", &[]),
                    false,
                    true,
                    {
                        let run = run_action.clone();
                        move || run(BoardAction::DeleteSelection)
                    },
                ));

            view()
                .absolute()
                .bottom(px(56.0))
                .left(px(12.0))
                .right(px(12.0))
                .items_center()
                .pointer_events(PointerEvents::BoxNone)
                .child(row)
                .into_element()
        })
    };

    // Bottom-center editorial floating toolbar dock (matching reference aesthetic).
    let bottom_dock = {
        let set_tool = set_tool.clone();
        let run_action = run_action.clone();
        dynamic(move || {
            let snap = ui_snap.get();
            let ro = props.read_only.get();
            let l = loc_str();
            let is_en = l.starts_with("en");

            let mut dock = floating_pill()
                .gap(px(2.0))
                .px(px(6.0))
                .py(px(4.0))
                .flex_wrap()
                .child(pill_icon_btn(
                    "wb-tool-select",
                    &t_in(l.as_str(), "web.artifact.whiteboard.select", &[]),
                    ICON_CURSOR,
                    snap.tool == ToolKindTag::Select,
                    false,
                    {
                        let st = set_tool.clone();
                        move || st(crate::engine::whiteboard::Tool::Select)
                    },
                ))
                .child(pill_icon_btn(
                    "wb-tool-pan",
                    &t_in(l.as_str(), "web.artifact.whiteboard.pan", &[]),
                    ICON_HAND,
                    snap.tool == ToolKindTag::Hand,
                    false,
                    {
                        let st = set_tool.clone();
                        move || st(crate::engine::whiteboard::Tool::Hand)
                    },
                ));

            if !ro {
                dock = dock
                    .child(pill_divider())
                    .child(pill_icon_btn(
                        "wb-tool-text",
                        &t_in(l.as_str(), "web.artifact.whiteboard.text", &[]),
                        ICON_TEXT,
                        snap.tool == ToolKindTag::Text,
                        false,
                        {
                            let st = set_tool.clone();
                            move || st(crate::engine::whiteboard::Tool::Text)
                        },
                    ))
                    .child(pill_icon_btn(
                        "wb-add-frame",
                        &t_in(l.as_str(), "web.artifact.whiteboard.container", &[]),
                        ICON_FRAME,
                        snap.tool == ToolKindTag::Container,
                        false,
                        {
                            let st = set_tool.clone();
                            move || st(crate::engine::whiteboard::Tool::Container)
                        },
                    ))
                    .child(pill_icon_btn(
                        "wb-add-node",
                        &t_in(l.as_str(), "web.artifact.whiteboard.card", &[]),
                        ICON_CARD,
                        snap.tool == ToolKindTag::Card,
                        false,
                        {
                            let st = set_tool.clone();
                            move || st(crate::engine::whiteboard::Tool::Card)
                        },
                    ))
                    .child(pill_icon_btn(
                        "wb-tool-sticky",
                        &t_in(l.as_str(), "web.artifact.whiteboard.sticky", &[]),
                        ICON_STICKY,
                        snap.tool == ToolKindTag::Sticky,
                        false,
                        {
                            let st = set_tool.clone();
                            move || st(crate::engine::whiteboard::Tool::Sticky)
                        },
                    ))
                    .child(pill_icon_btn(
                        "wb-tool-rect",
                        &t_in(l.as_str(), "web.artifact.whiteboard.rect", &[]),
                        ICON_RECT,
                        snap.tool == ToolKindTag::Rect,
                        false,
                        {
                            let st = set_tool.clone();
                            move || st(crate::engine::whiteboard::Tool::Shape(ShapeKind::Rect))
                        },
                    ))
                    .child(pill_icon_btn(
                        "wb-tool-arrow",
                        &t_in(l.as_str(), "web.artifact.whiteboard.arrow", &[]),
                        ICON_ARROW,
                        snap.tool == ToolKindTag::Arrow,
                        false,
                        {
                            let st = set_tool.clone();
                            move || st(crate::engine::whiteboard::Tool::Arrow)
                        },
                    ))
                    .child(pill_icon_btn(
                        "wb-tool-timeline",
                        &t_in(l.as_str(), "web.artifact.whiteboard.timeline", &[]),
                        ICON_TIMELINE,
                        snap.tool == ToolKindTag::Timeline,
                        false,
                        {
                            let st = set_tool.clone();
                            move || st(crate::engine::whiteboard::Tool::Timeline)
                        },
                    ))
                    .child(pill_icon_btn(
                        "wb-tool-table",
                        if is_en { "Table" } else { "表格" },
                        ICON_TABLE,
                        snap.tool == ToolKindTag::Table,
                        false,
                        {
                            let st = set_tool.clone();
                            move || st(crate::engine::whiteboard::Tool::Table)
                        },
                    ))
                    .child(pill_divider())
                    .child(pill_icon_btn(
                        "wb-tool-pen",
                        &t_in(l.as_str(), "web.artifact.whiteboard.pen", &[]),
                        ICON_PEN,
                        snap.tool == ToolKindTag::Pen,
                        false,
                        {
                            let st = set_tool.clone();
                            move || st(crate::engine::whiteboard::Tool::Pen)
                        },
                    ))
                    .child(pill_icon_btn(
                        "wb-tool-highlighter",
                        if is_en { "Highlighter" } else { "荧光笔" },
                        ICON_HIGHLIGHTER,
                        snap.tool == ToolKindTag::Highlighter,
                        false,
                        {
                            let st = set_tool.clone();
                            move || st(crate::engine::whiteboard::Tool::Highlighter)
                        },
                    ))
                    .child(pill_icon_btn(
                        "wb-tool-eraser",
                        if is_en { "Eraser" } else { "橡皮擦" },
                        ICON_ERASER,
                        snap.tool == ToolKindTag::Eraser,
                        false,
                        {
                            let st = set_tool.clone();
                            move || st(crate::engine::whiteboard::Tool::Eraser)
                        },
                    ))
                    .child(pill_icon_btn(
                        "wb-tool-sticker",
                        &t_in(l.as_str(), "web.artifact.whiteboard.sticker", &[]),
                        ICON_STICKER,
                        sticker_picker_open.get() || snap.tool == ToolKindTag::Sticker,
                        false,
                        move || {
                            template_picker_open.set(false);
                            sticker_picker_open.set(!sticker_picker_open.get_untracked());
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
                        let run = run_action.clone();
                        move |_: &PressEvent| run(BoardAction::AskOrchestrator)
                    })
                    .child(
                        text(t_in(l.as_str(), "web.artifact.whiteboard.chatWithOrchestrator", &[]))
                            .text_size(px(11.5))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(nsh_core::prelude::AdaptiveColor {
                                light: nsh_core::prelude::rgb(0xfefefe).to_hsla(),
                                dark: nsh_core::prelude::rgb(0x151413).to_hsla(),
                            }),
                    ),
            );

            view()
                .absolute()
                .bottom(px(12.0))
                .left(px(12.0))
                .right(px(12.0))
                .items_center()
                .pointer_events(PointerEvents::BoxNone)
                .child(dock)
                .into_element()
        })
    };

    // 25 built-in pure-vector sticker picker popover.
    let sticker_popover = {
        let set_tool = set_tool.clone();
        dynamic(move || {
            if !sticker_picker_open.get() {
                return view().into_element();
            }
            let l = loc_str();
            let is_en = l.starts_with("en");
            let mut panel = floating_card().w(px(332.0)).max_h(px(280.0)).p(px(10.0)).flex_col().gap(px(8.0));
            let mut sc = scroll().flex_col().gap(px(8.0)).h(px(248.0));
            for cat in StickerCategory::ALL {
                let cat_title = match (cat, is_en) {
                    (StickerCategory::Launch, true) => "Launch & Milestones",
                    (StickerCategory::Launch, false) => "发布与里程碑",
                    (StickerCategory::Business, true) => "Business & Plan",
                    (StickerCategory::Business, false) => "商业与计划",
                    (StickerCategory::Engineering, true) => "Engineering",
                    (StickerCategory::Engineering, false) => "工程与代码",
                    (StickerCategory::Status, true) => "Status",
                    (StickerCategory::Status, false) => "状态与标记",
                    (StickerCategory::People, true) => "Team",
                    (StickerCategory::People, false) => "团队与协作",
                    (StickerCategory::Transport, true) => "Transport",
                    (StickerCategory::Transport, false) => "交付与运输",
                };
                let mut grid = view().flex_row().flex_wrap().gap(px(6.0));
                for spec in STICKERS.iter().filter(|s| s.category == cat) {
                    let sid = spec.id;
                    grid = grid.child(
                        view()
                            .test_id(&format!("wb-sticker-pick-{sid}"))
                            .role(AccessibilityRole::Button)
                            .label(SharedString::from(sid))
                            .size(px(38.0))
                            .items_center()
                            .justify_center()
                            .rounded(px(8.0))
                            .border(px(1.0))
                            .border_color(AdaptiveUi::LINE)
                            .bg(AdaptiveUi::SIDE)
                            .cursor_pointer()
                            .hover(|s| s.bg(AdaptiveUi::HOVER))
                            .on_press({
                                let st = set_tool.clone();
                                move |_: &PressEvent| st(crate::engine::whiteboard::Tool::Sticker(sid.to_owned()))
                            })
                            .child(image(ImageSrc::svg_markup(spec.svg).size(Size::new(px(26.0), px(26.0)))).size(px(26.0))),
                    );
                }
                sc = sc.child(
                    view()
                        .flex_col()
                        .gap(px(4.0))
                        .child(
                            text(cat_title)
                                .text_size(px(11.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(AdaptiveUi::MUTED),
                        )
                        .child(grid),
                );
            }
            panel = panel.child(sc);
            view()
                .absolute()
                .bottom(px(56.0))
                .left(px(12.0))
                .right(px(12.0))
                .items_center()
                .pointer_events(PointerEvents::BoxNone)
                .child(panel)
                .into_element()
        })
    };

    // Top-right Zoom pill + toggleable Minimap (stacked cleanly below top_right_hud so bottom_dock never collides).
    let minimap_and_zoom = {
        let controller = Rc::clone(&controller);
        let run_action = run_action.clone();
        let dispatch_effects = dispatch_effects.clone();
        let mw = 152.0_f32;
        let mh = 96.0_f32;
        let minimap_panel = dynamic(move || {
            if !minimap_open.get() {
                return view().into_element();
            }
            let minimap_view = canvas({
                let controller = Rc::clone(&controller);
                move || {
                    let _ = static_tick.get();
                    let is_dark = dark();
                    let vw_vh = viewport_size.get();
                    let ctrl = controller.borrow();
                    paint_minimap_painter(&ctrl.doc, &ctrl.lookup, ctrl.camera, vw_vh, (mw, mh), is_dark)
                }
            })
            .test_id("wb-minimap")
            .w(px(mw))
            .h(px(mh))
            .cursor_pointer()
            .on_press_down({
                let controller = Rc::clone(&controller);
                let dispatch_effects = dispatch_effects.clone();
                move |e: &PressEvent| {
                    let effs = {
                        let mut ctrl = controller.borrow_mut();
                        ctrl.mark_user_moved_camera();
                        let vw_vh = viewport_size.get_untracked();
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
                        vec![crate::engine::whiteboard::ControllerEffect::ViewportChanged { zoom: ctrl.camera.zoom }]
                    };
                    dispatch_effects(effs, false);
                }
            });
            floating_card().p(px(2.0)).rounded(px(8.0)).child(minimap_view).into_element()
        });

        let zoom_bar = dynamic(move || {
            let snap = ui_snap.get();
            let l = loc_str();
            let is_en = l.starts_with("en");
            floating_pill()
                .child(
                    pill_text_btn("wb-zoom-out", "-", false, false, {
                        let run = run_action.clone();
                        move || run(BoardAction::ZoomBy(-0.15))
                    })
                    .label(SharedString::from(t_in(l.as_str(), "web.artifact.whiteboard.zoomOut", &[]))),
                )
                .child(pill_text_btn("wb-zoom-reset", &format!("{}%", snap.zoom_pct), false, false, {
                    let run = run_action.clone();
                    move || run(BoardAction::ResetZoom)
                }))
                .child(
                    pill_text_btn("wb-zoom-in", "+", false, false, {
                        let run = run_action.clone();
                        move || run(BoardAction::ZoomBy(0.15))
                    })
                    .label(SharedString::from(t_in(l.as_str(), "web.artifact.whiteboard.zoomIn", &[]))),
                )
                .child(pill_divider())
                .child(pill_text_btn(
                    "wb-fit",
                    &t_in(l.as_str(), "web.artifact.whiteboard.fitView", &[]),
                    false,
                    false,
                    {
                        let run = run_action.clone();
                        move || run(BoardAction::FitToContent)
                    },
                ))
                .child(pill_divider())
                .child(pill_text_btn(
                    "wb-minimap-toggle",
                    if is_en { "Map" } else { "缩略图" },
                    minimap_open.get(),
                    false,
                    move || minimap_open.set(!minimap_open.get_untracked()),
                ))
                .into_element()
        });

        view()
            .absolute()
            .top(px(54.0))
            .right(px(12.0))
            .flex_col()
            .items_end()
            .gap(px(6.0))
            .pointer_events(PointerEvents::BoxNone)
            .child(zoom_bar)
            .child(minimap_panel)
    };

    // Floating inline text editor on double-click / quick-create.
    let inline_editor_overlay = {
        let commit_inline = commit_inline.clone();
        dynamic(move || {
            let Some(st) = inline_edit.get() else {
                return view().into_element();
            };
            let l = loc_str();
            let is_en = l.starts_with("en");
            let mut card = floating_card()
                .test_id("wb-inline-editor")
                .p(px(8.0))
                .w(px(st.w.clamp(220.0, 340.0)))
                .flex_col()
                .gap(px(6.0))
                .child(
                    input()
                        .test_id("wb-inline-title")
                        .value(move || inline_title.get())
                        .auto_focus(true)
                        .rounded(px(6.0))
                        .border(px(1.0))
                        .border_color(AdaptiveUi::ACCENT)
                        .bg(AdaptiveUi::SIDE)
                        .px(px(8.0))
                        .py(px(5.0))
                        .text_size(px(13.0))
                        .text_color(AdaptiveUi::INK)
                        .on_change(move |v: &str| inline_title.set(v.to_owned()))
                        .on_submit({
                            let commit = commit_inline.clone();
                            move |_: &str| commit()
                        }),
                );

            if st.is_shape {
                card = card.child(
                    input()
                        .test_id("wb-inline-body")
                        .value(move || inline_body.get())
                        .multiline(true)
                        .placeholder(if is_en { "Details…" } else { "补充说明…" })
                        .rounded(px(6.0))
                        .border(px(1.0))
                        .border_color(AdaptiveUi::LINE)
                        .bg(AdaptiveUi::SIDE)
                        .px(px(8.0))
                        .py(px(5.0))
                        .text_size(px(12.0))
                        .text_color(AdaptiveUi::INK)
                        .on_change(move |v: &str| inline_body.set(v.to_owned())),
                );
            }

            card = card.child(
                view()
                    .flex_row()
                    .justify_end()
                    .gap(px(6.0))
                    .child(pill_text_btn(
                        "wb-inline-cancel",
                        if is_en { "Cancel" } else { "取消" },
                        false,
                        false,
                        move || {
                            inline_edit.set(None);
                        },
                    ))
                    .child(pill_text_btn(
                        "wb-inline-save",
                        &t_in(l.as_str(), "web.artifact.whiteboard.save", &[]),
                        true,
                        false,
                        {
                            let commit = commit_inline.clone();
                            move || commit()
                        },
                    )),
            );

            view().absolute().top(px(st.y)).left(px(st.x)).child(card).into_element()
        })
    };

    // Right-click floating context menu.
    let context_menu_overlay = {
        let run_action = run_action.clone();
        dynamic(move || {
            let Some(cm) = context_menu.get() else {
                return view().into_element();
            };
            let l = loc_str();
            let is_en = l.starts_with("en");
            let mut menu = floating_card().test_id("wb-context-menu").w(px(196.0)).p(px(5.0)).flex_col().gap(px(2.0));

            if cm.has_selection {
                menu = menu
                    .child(ctx_item(if is_en { "Duplicate" } else { "复制所选" }, {
                        let r = run_action.clone();
                        move || r(BoardAction::DuplicateSelection)
                    }))
                    .child(ctx_item(if is_en { "Bring to Front" } else { "置于顶层" }, {
                        let r = run_action.clone();
                        move || r(BoardAction::Reorder(ZOrderDir::Front))
                    }))
                    .child(ctx_item(if is_en { "Send to Back" } else { "置于底层" }, {
                        let r = run_action.clone();
                        move || r(BoardAction::Reorder(ZOrderDir::Back))
                    }))
                    .child(ctx_item(if is_en { "Group" } else { "编组" }, {
                        let r = run_action.clone();
                        move || r(BoardAction::GroupSelection)
                    }))
                    .child(ctx_item(if is_en { "Ungroup" } else { "取消编组" }, {
                        let r = run_action.clone();
                        move || r(BoardAction::UngroupSelection)
                    }))
                    .child(ctx_item(if is_en { "Wrap in Section" } else { "包进分区容器" }, {
                        let r = run_action.clone();
                        move || r(BoardAction::WrapInContainer(if is_en { "Section" } else { "分区" }.to_owned()))
                    }))
                    .child(ctx_item(if is_en { "Delete" } else { "删除" }, {
                        let r = run_action.clone();
                        move || r(BoardAction::DeleteSelection)
                    }));
            } else {
                menu = menu
                    .child(ctx_item(if is_en { "Fit to Content" } else { "适应画布" }, {
                        let r = run_action.clone();
                        move || r(BoardAction::FitToContent)
                    }))
                    .child(ctx_item(if is_en { "Select All" } else { "全选元素" }, {
                        let r = run_action.clone();
                        move || r(BoardAction::SelectAll)
                    }))
                    .child(ctx_item(t_in(l.as_str(), "web.artifact.whiteboard.chatWithOrchestrator", &[]), {
                        let r = run_action.clone();
                        move || r(BoardAction::AskOrchestrator)
                    }));
            }
            view().absolute().top(px(cm.y)).left(px(cm.x)).child(menu).into_element()
        })
    };

    // Empty-board starter card (when board has 0 elements).
    let starter_overlay = {
        let run_action = run_action.clone();
        dynamic(move || {
            let snap = ui_snap.get();
            if snap.count > 0 || props.read_only.get() {
                return view().into_element();
            }
            let l = loc_str();
            let is_en = l.starts_with("en");
            floating_card()
                .test_id("wb-starter-card")
                .p(px(16.0))
                .w(px(360.0))
                .flex_col()
                .gap(px(10.0))
                .child(
                    text(t_in(l.as_str(), "web.artifact.whiteboard.emptyHint", &[]))
                        .text_size(px(12.5))
                        .text_color(AdaptiveUi::MUTED),
                )
                .child(
                    view()
                        .flex_row()
                        .flex_wrap()
                        .gap(px(6.0))
                        .child(pill_text_btn(
                            "wb-empty-timeline",
                            &t_in(l.as_str(), "web.artifact.whiteboard.templateTimeline", &[]),
                            false,
                            false,
                            {
                                let r = run_action.clone();
                                move || r(BoardAction::ApplyTemplate(TemplateKind::Timeline, is_en))
                            },
                        ))
                        .child(pill_text_btn(
                            "wb-empty-workshop",
                            if is_en { "Workshop" } else { "启动工作坊" },
                            false,
                            false,
                            {
                                let r = run_action.clone();
                                move || r(BoardAction::ApplyTemplate(TemplateKind::Workshop, is_en))
                            },
                        ))
                        .child(pill_text_btn(
                            "wb-empty-arch",
                            &t_in(l.as_str(), "web.artifact.whiteboard.templateArchitecture", &[]),
                            false,
                            false,
                            {
                                let r = run_action.clone();
                                move || r(BoardAction::ApplyTemplate(TemplateKind::Architecture, is_en))
                            },
                        ))
                        .child(pill_text_btn(
                            "wb-empty-journey",
                            if is_en { "User Journey" } else { "用户旅程" },
                            false,
                            false,
                            {
                                let r = run_action.clone();
                                move || r(BoardAction::ApplyTemplate(TemplateKind::UserJourney, is_en))
                            },
                        ))
                        .child(pill_text_btn("wb-empty-quadrant", if is_en { "Quadrant" } else { "四象限" }, false, false, {
                            let r = run_action.clone();
                            move || r(BoardAction::ApplyTemplate(TemplateKind::Quadrant, is_en))
                        })),
                )
                .self_center()
                .into_element()
        })
    };

    let timer_popover = dynamic(move || {
        if !timer_open.get() {
            return view().into_element();
        }
        let l = loc_str();
        let is_en = l.starts_with("en");
        let running = timer_running.get();
        let rem = timer_secs.get();
        let presets = [(3u32, "3m"), (5, "5m"), (10, "10m"), (15, "15m")];
        let mut preset_row = view().flex_row().gap(px(4.0));
        for (mins, lbl) in presets {
            let target_s = mins * 60;
            preset_row = preset_row.child(pill_text_btn(
                &format!("wb-timer-preset-{mins}"),
                lbl,
                rem == target_s && !running,
                false,
                move || {
                    timer_running.set(false);
                    timer_secs.set(target_s);
                },
            ));
        }
        let panel = floating_card()
            .test_id("wb-timer-popover")
            .w(px(210.0))
            .p(px(10.0))
            .flex_col()
            .gap(px(8.0))
            .child(
                text(format!("{:02}:{:02}", rem / 60, rem % 60))
                    .text_size(px(22.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(AdaptiveUi::INK),
            )
            .child(preset_row)
            .child(
                view()
                    .flex_row()
                    .gap(px(6.0))
                    .child(pill_text_btn(
                        "wb-timer-start-pause",
                        if running {
                            if is_en { "Pause" } else { "暂停" }
                        } else if is_en {
                            "Start"
                        } else {
                            "开始"
                        },
                        running,
                        false,
                        move || {
                            if !timer_running.get_untracked() && timer_secs.get_untracked() == 0 {
                                timer_secs.set(300);
                            }
                            timer_running.set(!timer_running.get_untracked());
                        },
                    ))
                    .child(pill_text_btn(
                        "wb-timer-reset",
                        if is_en { "Reset" } else { "重置" },
                        false,
                        false,
                        move || {
                            timer_running.set(false);
                            timer_secs.set(300);
                        },
                    )),
            );
        view().absolute().top(px(50.0)).right(px(12.0)).child(panel).into_element()
    });

    let export_popover = {
        let run_action = run_action.clone();
        dynamic(move || {
            if !export_menu_open.get() {
                return view().into_element();
            }
            let l = loc_str();
            let is_en = l.starts_with("en");
            let mut panel = floating_card().test_id("wb-export-popover").w(px(164.0)).p(px(5.0)).flex_col().gap(px(2.0));
            let items = [
                (
                    "wb-export-png",
                    if is_en { "PNG (2x)" } else { "PNG 2x" },
                    crate::engine::whiteboard::ExportFormat::Png,
                ),
                ("wb-export-json", "JSON", crate::engine::whiteboard::ExportFormat::Json),
                ("wb-export-canvas", ".canvas", crate::engine::whiteboard::ExportFormat::JsonCanvas),
            ];
            for (tid, label, fmt) in items {
                panel = panel.child(
                    view()
                        .test_id(tid)
                        .role(AccessibilityRole::Button)
                        .rounded(px(6.0))
                        .px(px(10.0))
                        .py(px(6.0))
                        .cursor_pointer()
                        .hover(|s| s.bg(AdaptiveUi::HOVER))
                        .on_press({
                            let run = run_action.clone();
                            move |_: &PressEvent| run(BoardAction::Export(fmt))
                        })
                        .child(text(label).text_size(px(12.0)).text_color(AdaptiveUi::INK)),
                );
            }
            view().absolute().top(px(50.0)).right(px(12.0)).child(panel).into_element()
        })
    };

    let board_stage_wrapper = view()
        .relative()
        .flex_1()
        .min_w(px(0.0))
        .min_h(px(0.0))
        .overflow_hidden()
        .child(stage)
        .child(top_left_hud)
        .child(top_right_hud)
        .child(minimap_and_zoom)
        .child(timer_popover)
        .child(export_popover)
        .child(template_popover)
        .child(style_bar)
        .child(sticker_popover)
        .child(bottom_dock)
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

    // Collapsible right inspector drawer (flex sibling next to stage).
    let inspector_drawer = {
        let controller = Rc::clone(&controller);
        let dispatch_effects = dispatch_effects.clone();
        let run_action = run_action.clone();
        dynamic(move || {
            if !inspector_open.get() {
                return view().into_element();
            }
            let snap = ui_snap.get();
            let l = loc_str();
            let is_en = l.starts_with("en");
            let first_sel = snap.selection.first().cloned();

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
                                text(t_in(l.as_str(), "web.artifact.whiteboard.label", &[]))
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
                                text(t_in(l.as_str(), "web.artifact.whiteboard.body", &[]))
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
                        (ShapeKind::Card, t_in(l.as_str(), "web.artifact.whiteboard.card", &[])),
                        (ShapeKind::Sticky, t_in(l.as_str(), "web.artifact.whiteboard.sticky", &[])),
                        (ShapeKind::Rect, t_in(l.as_str(), "web.artifact.whiteboard.rect", &[])),
                        (ShapeKind::Diamond, t_in(l.as_str(), "web.artifact.whiteboard.diamond", &[])),
                        (ShapeKind::Ellipse, if is_en { "Ellipse".to_owned() } else { "椭圆".to_owned() }),
                        (ShapeKind::Cylinder, if is_en { "Cylinder".to_owned() } else { "圆柱".to_owned() }),
                    ] {
                        shape_row = shape_row.child(pill_text_btn(
                            &format!("wb-insp-shape-{sname}"),
                            &sname,
                            snap.selection_kind.shape == Some(sk),
                            false,
                            {
                                let r = run_action.clone();
                                move || r(BoardAction::SetShapeSelection(sk))
                            },
                        ));
                    }
                    body = body.child(shape_row);

                    let mut st_row = view().flex_row().flex_wrap().gap(px(4.0)).child(pill_text_btn(
                        "wb-insp-sticker-none",
                        &t_in(l.as_str(), "web.artifact.whiteboard.noSticker", &[]),
                        snap.selection_kind.sticker.is_none(),
                        false,
                        {
                            let r = run_action.clone();
                            move || r(BoardAction::SetStickerSelection(None))
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
                                    let r = run_action.clone();
                                    move |_: &PressEvent| r(BoardAction::SetStickerSelection(Some(sid.to_owned())))
                                })
                                .child(image(ImageSrc::svg_markup(spec.svg).size(Size::new(px(20.0), px(20.0)))).size(px(20.0))),
                        );
                    }
                    body = body.child(st_row);
                }

                body = body
                    .child(view().flex_row().justify_end().child(pill_text_btn(
                        "wb-inspector-save",
                        &t_in(l.as_str(), "web.artifact.whiteboard.save", &[]),
                        true,
                        false,
                        {
                            let controller = Rc::clone(&controller);
                            let dispatch_effects = dispatch_effects.clone();
                            let el_id = el_id.clone();
                            move || {
                                let effs = controller
                                    .borrow_mut()
                                    .commit_inline_edit(&el_id, label_draft.get_untracked(), body_draft.get_untracked(), None);
                                dispatch_effects(effs, true);
                            }
                        },
                    )))
                    .child(
                        view()
                            .flex_col()
                            .gap(px(4.0))
                            .child(
                                text(t_in(l.as_str(), "web.artifact.whiteboard.entryJson", &[]))
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
                                &t_in(l.as_str(), "web.artifact.whiteboard.saveJson", &[]),
                                true,
                                false,
                                {
                                    let controller = Rc::clone(&controller);
                                    let dispatch_effects = dispatch_effects.clone();
                                    let el_id = el_id.clone();
                                    move || {
                                        let raw = json_draft.get_untracked();
                                        let rev = controller.borrow().doc.element(&el_id).map_or(0, |e| e.rev);
                                        if let Ok(decoded) = crate::engine::whiteboard::decode_element(el_id.as_str(), rev, &raw) {
                                            let res = apply_command(
                                                &mut controller.borrow_mut().doc,
                                                None,
                                                BoardCommand::UpdateElement(Box::new(decoded)),
                                                None,
                                                true,
                                            );
                                            controller.borrow_mut().rebuild_index();
                                            dispatch_effects(vec![crate::engine::whiteboard::ControllerEffect::FlushBatch(res.writes)], true);
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
                                let controller = Rc::clone(&controller);
                                let dispatch_effects = dispatch_effects.clone();
                                move |_: &PressEvent| {
                                    controller.borrow_mut().selection = vec![row_id.clone()];
                                    dispatch_effects(vec![crate::engine::whiteboard::ControllerEffect::SelectionChanged(vec![row_id.clone()])], false);
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
                                || t_in(l.as_str(), "web.artifact.whiteboard.elements", &[("n", snap.count.into())]),
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
    };

    view()
        .test_id("whiteboard-native-root")
        .flex_row()
        .w_full()
        .h_full()
        .min_h(px(0.0))
        .min_w(px(0.0))
        .focusable(true)
        .on_key_down({
            let controller = Rc::clone(&controller);
            let dispatch_effects = dispatch_effects.clone();
            move |e: &KeyEvent| {
                if e.key == " " || e.code == "Space" {
                    space_held.set(true);
                }
                if inline_edit.get_untracked().is_some() {
                    if e.key == "Escape" {
                        inline_edit.set(None);
                    }
                    return;
                }
                if inspector_focused.get_untracked() || e.default_prevented {
                    return;
                }
                if props.read_only.get_untracked() && !matches!(e.key.as_str(), "Escape" | "0" | "1" | "2" | "v" | "h") {
                    return;
                }
                let effs = controller
                    .borrow_mut()
                    .handle_key_down(e.key.as_str(), map_mods(&e.modifiers, space_held.get_untracked()));
                dispatch_effects(effs, true);
            }
        })
        .on_key_up(move |e: &KeyEvent| {
            if e.key == " " || e.code == "Space" {
                space_held.set(false);
            }
        })
        .child(board_stage_wrapper)
        .child(inspector_drawer)
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
        zoom_pct: (ctrl.camera.zoom * 100.0).round().max(10.0) as u32,
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

fn emit_export_request(cx: Scope<VvWhiteboardEvent>, fmt: crate::engine::whiteboard::ExportFormat, doc: BoardDoc, base: String, is_dark: bool) {
    use crate::engine::whiteboard::ExportFormat as F;
    match fmt {
        F::Svg => {
            let content = export_svg(&doc, is_dark);
            cx.emit(VvWhiteboardEvent::Export(VvWhiteboardExportEvent {
                format: SharedString::from("svg"),
                filename: SharedString::from(format!("{base}.svg")),
                mime: SharedString::from("image/svg+xml"),
                content: SharedString::from(content),
            }));
        }
        F::Json => {
            if let Ok(content) = export_json(&doc) {
                cx.emit(VvWhiteboardEvent::Export(VvWhiteboardExportEvent {
                    format: SharedString::from("json"),
                    filename: SharedString::from(format!("{base}.json")),
                    mime: SharedString::from("application/json"),
                    content: SharedString::from(content),
                }));
            }
        }
        F::JsonCanvas => {
            if let Ok(content) = export_json_canvas(&doc) {
                cx.emit(VvWhiteboardEvent::Export(VvWhiteboardExportEvent {
                    format: SharedString::from("json-canvas"),
                    filename: SharedString::from(format!("{base}.canvas")),
                    mime: SharedString::from("application/json"),
                    content: SharedString::from(content),
                }));
            }
        }
        F::Png => {
            let (painter, w, h) = build_export_painter(&doc, is_dark);
            let mut opts = RenderOptions::default();
            opts.scale = Some(2.0);
            opts.format = ImageFormat::Png;
            let answer = painter.render(size(px(w), px(h)), opts);
            drop(spawn(async move {
                match answer.await {
                    Ok(bytes) => {
                        let b64 = encode_base64(&bytes);
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

fn map_mods(m: &Modifiers, space: bool) -> WbModifiers {
    WbModifiers {
        shift: m.shift,
        alt: m.alt,
        accel: m.cmd || m.ctrl,
        space,
    }
}

fn map_mouse_btn(btn: Option<MouseButton>) -> WbPointerButton {
    match btn {
        Some(MouseButton::Right) => WbPointerButton::Secondary,
        Some(MouseButton::Middle) => WbPointerButton::Middle,
        _ => WbPointerButton::Primary,
    }
}

fn sanitize_filename(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|ch| {
            if matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '-'
            } else {
                ch
            }
        })
        .collect();
    if cleaned.is_empty() { "whiteboard".to_owned() } else { cleaned }
}

fn presence_adaptive_color(c: PresenceColor) -> nsh_core::prelude::AdaptiveColor {
    let hex_l = match c {
        PresenceColor::Coral => "#dd6f57",
        PresenceColor::Teal => "#1a7f74",
        PresenceColor::Blue => "#2c6aa3",
        PresenceColor::Leaf => "#4d7a2a",
        PresenceColor::Wheat => "#c48b20",
        PresenceColor::Lavender => "#7c52a8",
    };
    let hsla = crate::engine::whiteboard::paint::parse_hex_hsla(hex_l).unwrap_or(nsh_core::prelude::black());
    nsh_core::prelude::AdaptiveColor { light: hsla, dark: hsla }
}

fn floating_pill() -> nsh_core::prelude::View {
    view()
        .flex_row()
        .items_center()
        .gap(px(3.0))
        .rounded(px(12.0))
        .border(px(1.0))
        .border_color(AdaptiveUi::LINE)
        .bg(AdaptiveUi::PAGE)
        .px(px(6.0))
        .py(px(4.0))
        .shadow_md()
}

fn floating_card() -> nsh_core::prelude::View {
    view()
        .rounded(px(12.0))
        .border(px(1.0))
        .border_color(AdaptiveUi::LINE)
        .bg(AdaptiveUi::PAGE)
        .shadow_lg()
}

fn pill_divider() -> nsh_core::prelude::View {
    view().w(px(1.0)).h(px(16.0)).mx(px(2.0)).bg(AdaptiveUi::LINE)
}

fn pill_text_btn(tid: &str, label: &str, active: bool, danger: bool, on_press: impl Fn() + 'static) -> nsh_core::prelude::View {
    let fg = if danger {
        AdaptiveUi::BERRY
    } else if active {
        AdaptiveUi::INK
    } else {
        AdaptiveUi::MUTED
    };
    view()
        .test_id(tid)
        .role(AccessibilityRole::Button)
        .accessibility_state(AccessibilityState {
            selected: active,
            ..AccessibilityState::default()
        })
        .rounded(px(7.0))
        .px(px(8.0))
        .py(px(4.0))
        .bg(if active { AdaptiveUi::SELECTED } else { AdaptiveUi::PAGE })
        .cursor_pointer()
        .hover(|s| s.bg(AdaptiveUi::HOVER))
        .on_press(move |_: &PressEvent| on_press())
        .child(
            text(label.to_owned())
                .text_size(px(11.5))
                .font_weight(if active { FontWeight::SEMIBOLD } else { FontWeight::MEDIUM })
                .text_color(fg),
        )
}

fn pill_icon_btn(tid: &str, label: &str, icon_svg: &'static str, active: bool, disabled: bool, on_press: impl Fn() + 'static) -> nsh_core::prelude::View {
    let fg = if disabled {
        AdaptiveUi::FAINT
    } else if active {
        AdaptiveUi::INK
    } else {
        AdaptiveUi::MUTED
    };
    let mut el = view()
        .test_id(tid)
        .role(AccessibilityRole::Button)
        .label(SharedString::from(label.to_owned()))
        .disabled(disabled)
        .accessibility_state(AccessibilityState {
            selected: active,
            ..AccessibilityState::default()
        })
        .size(px(26.0))
        .items_center()
        .justify_center()
        .rounded(px(7.0))
        .bg(if active { AdaptiveUi::SELECTED } else { AdaptiveUi::PAGE })
        .child(svg(ImageSrc::svg_markup(icon_svg)).size(px(14.0)).text_color(fg));

    if !disabled {
        el = el
            .cursor_pointer()
            .hover(|s| s.bg(AdaptiveUi::HOVER))
            .on_press(move |_: &PressEvent| on_press());
    }
    el
}

fn ctx_item(label: impl Into<String>, on_press: impl Fn() + 'static) -> AnyElement {
    view()
        .role(AccessibilityRole::Button)
        .rounded(px(6.0))
        .px(px(9.0))
        .py(px(5.0))
        .cursor_pointer()
        .hover(|s| s.bg(AdaptiveUi::HOVER))
        .on_press(move |_: &PressEvent| on_press())
        .child(text(label.into()).text_size(px(12.0)).text_color(AdaptiveUi::INK))
        .into_element()
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = if chunk.len() > 1 { u32::from(chunk[1]) } else { 0 };
        let b2 = if chunk.len() > 2 { u32::from(chunk[2]) } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((triple >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 { TABLE[(triple & 0x3f) as usize] as char } else { '=' });
    }
    out
}

const ICON_CURSOR: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4l13 7-6 2-3 6z"/></svg>"#;
const ICON_HAND: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v7M10 10V5a2 2 0 0 0-4 0v9l-1.5-1.5a2 2 0 0 0-2.8 2.8L6.5 20a4 4 0 0 0 2.8 1.2H15a4 4 0 0 0 4-4v-6a2 2 0 0 0-1-1.7z"/></svg>"#;
const ICON_TEXT: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6h14M12 6v13M9 19h6"/></svg>"#;
const ICON_FRAME: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h16M4 15h16M9 4v16M15 4v16"/></svg>"#;
const ICON_CARD: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M14 20v-5h5"/></svg>"#;
const ICON_STICKY: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 10h8M8 14h5"/></svg>"#;
const ICON_TIMER: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.5M9.5 3h5M12 3v2"/></svg>"#;
const ICON_RECT: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"/></svg>"#;
const ICON_ARROW: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19L19 5M11 5h8v8"/></svg>"#;
const ICON_TIMELINE: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16c4-6 14 2 18-8"/><circle cx="6" cy="14" r="2"/><circle cx="18" cy="10" r="2"/></svg>"#;
const ICON_TABLE: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M9 5v14M15 5v14"/></svg>"#;
const ICON_PEN: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4l6 6-10 10H4v-6z"/></svg>"#;
const ICON_HIGHLIGHTER: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l-5 5v4h4l5-5M15 5l4 4-6 6-4-4z"/></svg>"#;
const ICON_ERASER: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 21h10M5.5 14.5l8-8a2.1 2.1 0 0 1 3 0l3 3a2.1 2.1 0 0 1 0 3l-6 6H7z"/></svg>"#;
const ICON_STICKER: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M8.5 14.5c1 1.8 6 1.8 7 0"/></svg>"#;
const ICON_UNDO: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14l-5-5 5-5M4 9h10a6 6 0 0 1 0 12h-3"/></svg>"#;
const ICON_REDO: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3"/></svg>"#;
