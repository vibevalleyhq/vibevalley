//! Native `VvGenUi` component backed directly by `vibevalley-genui`.
//!
//! Streams JSONL patches (or parses a standalone [`vibevalley_genui::GenUiSpec`] JSON document)
//! into [`vibevalley_genui::GenUiRuntime`] and renders all 19 [`ResolvedNodeKind`] variants
//! natively with `nsh_core` and `nsh_base` elements (zero `WKWebView`). Interactive controls
//! (`Slider`, `Switch`, `Select`, `Tabs`) update `GenUiRuntime` state and bump a reactive
//! `nsh_core` `Signal`, re-resolving dependent KPIs, tables, callouts, and embedded `VvChart`
//! SVGs in-place on the engine thread.

use std::cell::RefCell;
use std::rc::Rc;

use nsh_base::{SliderValue, slider, switch};
use nsh_core::prelude::*;
use vibevalley_genui::{
    Align, CalloutKind, GenUiRuntime, GenUiSpec, ResolvedDoc, ResolvedNode, ResolvedNodeKind, RuntimeEvent, StackDirection, StateValue, TextAlign, TextSize,
    Tone,
};

use crate::canvas::vv_canvas;
use crate::chart::vv_chart;
use crate::code_block::vv_code_block;
use crate::diagram::vv_diagram;
use crate::hooks::{GenUiActionSink, active_genui_renderer};
use crate::markdown::{VvMarkdownSize, vv_markdown};
use crate::theme::AdaptiveUi;

/// Props of [`VvGenUi`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub struct VvGenUiProps {
    /// Generative UI specification string (JSONL patch stream or standalone `GenUiSpec` JSON).
    pub spec: Prop<SharedString>,
    /// When true, streams incremental JSONL prefixes without finalizing an incomplete trailing line.
    #[prop(default)]
    pub streaming: Prop<bool>,
}

/// Payload emitted when an interactive control inside [`VvGenUi`] triggers an action or state update.
#[derive(Debug, Clone, Default, PartialEq, Eq, JsObject)]
pub struct VvGenUiActionEvent {
    /// Logical action identifier (e.g. `"state_change"` or custom renderer action name).
    pub action: SharedString,
    /// Serialized string payload associated with the action.
    pub payload: SharedString,
}

/// Events emitted by [`VvGenUi`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum VvGenUiEvent {
    /// Fired when a rendered GenUI control dispatches an action or mutates reactive state.
    #[args(event)]
    Action(VvGenUiActionEvent),
}

struct GenUiSession {
    last_spec: SharedString,
    last_streaming: bool,
    is_single_doc: bool,
    runtime: GenUiRuntime,
    errors: Vec<String>,
}

impl GenUiSession {
    fn new() -> Self {
        Self {
            last_spec: SharedString::default(),
            last_streaming: false,
            is_single_doc: false,
            runtime: GenUiRuntime::new(),
            errors: Vec::new(),
        }
    }

    fn sync(&mut self, spec: &SharedString, streaming: bool) {
        if *spec == self.last_spec && streaming == self.last_streaming {
            return;
        }

        // Preserve user state edits and incremental node generations while streaming JSONL prefixes.
        if !self.is_single_doc && !self.last_spec.is_empty() && spec.starts_with(self.last_spec.as_str()) {
            let delta = &spec[self.last_spec.len()..];
            if !delta.is_empty() {
                let events = self.runtime.push_chunk(delta);
                collect_runtime_errors(events, &mut self.errors);
            }
            if !streaming && self.last_streaming {
                let events = self.runtime.finish_stream();
                collect_runtime_errors(events, &mut self.errors);
            }
            self.last_spec = spec.clone();
            self.last_streaming = streaming;
            return;
        }

        self.runtime = GenUiRuntime::new();
        self.errors.clear();
        self.is_single_doc = false;

        let trimmed = spec.trim();
        if !trimmed.is_empty() {
            let events = self.runtime.push_chunk(spec.as_str());
            collect_runtime_errors(events, &mut self.errors);
            if !streaming {
                let tail = self.runtime.finish_stream();
                collect_runtime_errors(tail, &mut self.errors);
            }

            // Fall back to standalone GenUiSpec JSON when the input is a complete snapshot rather than JSONL.
            if !streaming
                && self.runtime.doc().nodes.is_empty()
                && !self.errors.is_empty()
                && trimmed.starts_with('{')
                && let Ok(parsed) = serde_json::from_str::<GenUiSpec>(trimmed)
                && let Ok(rt) = GenUiRuntime::from_spec(parsed)
            {
                self.runtime = rt;
                self.errors.clear();
                self.is_single_doc = true;
            }
        }

        self.last_spec = spec.clone();
        self.last_streaming = streaming;
    }
}

fn collect_runtime_errors(events: Vec<RuntimeEvent>, out: &mut Vec<String>) {
    for event in events {
        match event {
            RuntimeEvent::PatchApplied { .. } | RuntimeEvent::Complete { .. } => {}
            RuntimeEvent::Error { line, error } => {
                out.push(format!("line {line}: {error}"));
            }
        }
    }
}

type StateUpdater = Rc<dyn Fn(&str, StateValue)>;

/// Native generative UI surface backed by `vibevalley-genui` (or a registered
/// [`crate::hooks::GenUiRenderer`] override).
///
/// Renders all 19 `ResolvedNodeKind` variants natively using `nsh_core` / `nsh_base` elements
/// with reactive signals and embedded `VvChart` / `VvDiagram` / `VvCanvas` / `VvCodeBlock`,
/// falling back cleanly to a JSON code block + error readout when the spec cannot be decoded.
#[component]
pub fn VvGenUi(props: VvGenUiProps, cx: Scope<VvGenUiEvent>) -> impl IntoElement {
    let session = Rc::new(RefCell::new(GenUiSession::new()));
    let revision = signal(0u64);

    view().test_id("genui").flex_col().my(px(8.0)).max_w(relative(1.0)).child(dynamic(move || {
        let spec = props.spec.get();
        let streaming = props.streaming.get();
        let is_dark = dark();
        let _rev = revision.get();

        if let Some(renderer) = active_genui_renderer() {
            let sink = GenUiActionSink::new(move |act| {
                cx.emit(VvGenUiEvent::Action(VvGenUiActionEvent {
                    action: act.action,
                    payload: act.payload,
                }));
            });
            return match renderer.render_element(spec.as_str(), is_dark, sink) {
                Ok(el) => view().test_id("genui-surface").flex_col().max_w(relative(1.0)).child(el).into_element(),
                Err(err) => render_genui_fallback(spec, err),
            };
        }

        let (resolved, first_error) = {
            let mut guard = session.borrow_mut();
            guard.sync(&spec, streaming);
            let doc = guard.runtime.resolve_tree();
            let err = guard.errors.first().cloned();
            (doc, err)
        };

        if resolved.root.is_none() {
            if let Some(err) = first_error {
                return render_genui_fallback(spec, err);
            }
            if streaming {
                return view()
                    .test_id("genui-loading")
                    .flex_col()
                    .rounded(px(8.0))
                    .border(px(1.0))
                    .border_color(AdaptiveUi::LINE)
                    .bg(AdaptiveUi::SIDE)
                    .p(px(12.0))
                    .child(text("…").text_size(px(12.0)).text_color(AdaptiveUi::MUTED))
                    .into_element();
            }
            return render_genui_fallback(spec, "GenUI specification contains no root node".to_owned());
        }

        let session_for_update = Rc::clone(&session);
        let updater: StateUpdater = Rc::new(move |key: &str, value: StateValue| {
            let summary = format_state_value_summary(&value);
            let changed = session_for_update.borrow_mut().runtime.set_state(key.to_owned(), value).is_ok();
            if changed {
                revision.update(|n| *n = n.saturating_add(1));
                cx.emit(VvGenUiEvent::Action(VvGenUiActionEvent {
                    action: SharedString::from("state_change"),
                    payload: SharedString::from(format!("{key}={summary}")),
                }));
            }
        });

        render_resolved_doc(&resolved, first_error.as_deref(), &updater)
    }))
}

fn render_genui_fallback(spec: SharedString, err: String) -> AnyElement {
    view()
        .flex_col()
        .gap(px(4.0))
        .child(vv_code_block().code(spec).language(Some(SharedString::from("json"))))
        .child(text(err).test_id("genui-error").text_size(px(12.0)).text_color(AdaptiveUi::BERRY))
        .into_element()
}

fn render_resolved_doc(doc: &ResolvedDoc, stream_error: Option<&str>, updater: &StateUpdater) -> AnyElement {
    let mut root_box = view()
        .test_id("genui-surface")
        .flex_col()
        .gap(px(12.0))
        .rounded(px(8.0))
        .border(px(1.0))
        .border_color(AdaptiveUi::LINE)
        .bg(AdaptiveUi::PAGE)
        .p(px(14.0))
        .max_w(relative(1.0));

    if doc.title.is_some() || doc.subtitle.is_some() {
        let mut header = view().test_id("genui-header").flex_col().gap(px(2.0));
        if let Some(title) = &doc.title {
            header = header.child(
                text(title.clone())
                    .test_id("genui-title")
                    .text_size(px(15.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(AdaptiveUi::INK),
            );
        }
        if let Some(subtitle) = &doc.subtitle {
            header = header.child(
                text(subtitle.clone())
                    .test_id("genui-subtitle")
                    .text_size(px(12.0))
                    .text_color(AdaptiveUi::MUTED),
            );
        }
        root_box = root_box.child(header);
    }

    if let Some(node) = &doc.root {
        root_box = root_box.child(render_node(node, updater));
    }

    if let Some(err) = stream_error {
        root_box = root_box.child(
            text(err.to_owned())
                .test_id("genui-stream-error")
                .text_size(px(11.0))
                .text_color(AdaptiveUi::BERRY),
        );
    }

    if !doc.diagnostics.is_empty() {
        let summary = doc
            .diagnostics
            .iter()
            .take(3)
            .map(|d| format!("{}.{}: {}", d.node_id, d.field, d.error))
            .collect::<Vec<_>>()
            .join("; ");
        root_box = root_box.child(text(summary).test_id("genui-diagnostics").text_size(px(11.0)).text_color(AdaptiveUi::WARN_INK));
    }

    root_box.into_element()
}

fn render_node(node: &ResolvedNode, updater: &StateUpdater) -> AnyElement {
    let id = &node.id;
    let node_tid = format!("genui-node-{id}");
    match &node.kind {
        ResolvedNodeKind::Stack {
            direction,
            gap,
            align,
            children,
        } => {
            let mut container = view().test_id(&node_tid).gap(px((*gap).max(0.0))).min_w(px(0.0));
            container = match direction {
                StackDirection::Vertical => container.flex_col(),
                StackDirection::Horizontal => container.flex_row().flex_wrap(),
            };
            container = apply_align(container, *align);
            for child in children {
                container = container.child(render_node(child, updater));
            }
            container.into_element()
        }
        ResolvedNodeKind::Grid { columns, gap, children } => {
            let cols = usize::from((*columns).max(1));
            let gap_px = px((*gap).max(0.0));
            let mut grid = view().test_id(&node_tid).flex_col().gap(gap_px).min_w(px(0.0));
            for chunk in children.chunks(cols) {
                let mut row = view().flex_row().gap(gap_px).min_w(px(0.0));
                for child in chunk {
                    row = row.child(view().flex_1().min_w(px(0.0)).child(render_node(child, updater)));
                }
                for _ in chunk.len()..cols {
                    row = row.child(view().flex_1().min_w(px(0.0)));
                }
                grid = grid.child(row);
            }
            grid.into_element()
        }
        ResolvedNodeKind::Card { title, subtitle, children } => {
            let mut card = view()
                .test_id(&node_tid)
                .flex_col()
                .gap(px(10.0))
                .rounded(px(8.0))
                .border(px(1.0))
                .border_color(AdaptiveUi::LINE)
                .bg(AdaptiveUi::SIDE)
                .p(px(12.0))
                .min_w(px(0.0));
            if title.is_some() || subtitle.is_some() {
                let mut head = view().flex_col().gap(px(2.0));
                if let Some(t) = title {
                    head = head.child(
                        text(t.clone())
                            .text_size(px(13.5))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(AdaptiveUi::INK),
                    );
                }
                if let Some(sub) = subtitle {
                    head = head.child(text(sub.clone()).text_size(px(12.0)).text_color(AdaptiveUi::MUTED));
                }
                card = card.child(head);
            }
            for child in children {
                card = card.child(render_node(child, updater));
            }
            card.into_element()
        }
        ResolvedNodeKind::Tabs { bind, active_tab, tabs } => {
            let mut bar = view()
                .flex_row()
                .flex_wrap()
                .gap(px(4.0))
                .border_b(px(1.0))
                .border_color(AdaptiveUi::LINE)
                .pb(px(6.0));
            for tab in tabs {
                let is_active = tab.active || tab.id == *active_tab;
                let bind_key = bind.clone();
                let tab_id = tab.id.clone();
                let tab_tid = format!("genui-tab-{id}-{}", tab.id);
                let set_state = Rc::clone(updater);
                let btn = view()
                    .test_id(&tab_tid)
                    .role(AccessibilityRole::Tab)
                    .rounded(px(5.0))
                    .px(px(10.0))
                    .py(px(4.0))
                    .bg(if is_active { AdaptiveUi::SELECTED } else { AdaptiveUi::PAGE })
                    .border(px(1.0))
                    .border_color(if is_active { AdaptiveUi::ACCENT } else { AdaptiveUi::LINE })
                    .cursor_pointer()
                    .on_press(move |_: &PressEvent| {
                        set_state(&bind_key, StateValue::Text(tab_id.clone()));
                    })
                    .child(
                        text(tab.label.clone())
                            .text_size(px(12.5))
                            .font_weight(if is_active { FontWeight::SEMIBOLD } else { FontWeight::MEDIUM })
                            .text_color(if is_active { AdaptiveUi::INK } else { AdaptiveUi::MUTED }),
                    );
                bar = bar.child(btn);
            }
            let mut panel = view().flex_col().gap(px(8.0)).min_w(px(0.0));
            if let Some(active) = tabs.iter().find(|t| t.active || t.id == *active_tab).or_else(|| tabs.first()) {
                for child in &active.children {
                    panel = panel.child(render_node(child, updater));
                }
            }
            view()
                .test_id(&node_tid)
                .flex_col()
                .gap(px(8.0))
                .min_w(px(0.0))
                .child(bar)
                .child(panel)
                .into_element()
        }
        ResolvedNodeKind::Divider { label } => {
            let mut row = view().test_id(&node_tid).flex_row().items_center().gap(px(8.0)).my(px(4.0));
            row = row.child(view().flex_1().h(px(1.0)).bg(AdaptiveUi::LINE));
            if let Some(lbl) = label.as_deref().filter(|s| !s.is_empty()) {
                row = row
                    .child(text(lbl.to_owned()).text_size(px(11.0)).text_color(AdaptiveUi::FAINT))
                    .child(view().flex_1().h(px(1.0)).bg(AdaptiveUi::LINE));
            }
            row.into_element()
        }
        ResolvedNodeKind::Text { value, tone, size } => text(value.clone())
            .test_id(&node_tid)
            .text_size(px(text_size_pt(*size)))
            .text_color(tone_color(*tone))
            .into_element(),
        ResolvedNodeKind::Markdown { text: md } => view()
            .test_id(&node_tid)
            .min_w(px(0.0))
            .child(vv_markdown().text(md.clone()).size(VvMarkdownSize::Sm))
            .into_element(),
        ResolvedNodeKind::Metric { label, value, delta, .. } => {
            let metric_tid = format!("genui-metric-{id}");
            let value_tid = format!("genui-metric-value-{id}");
            let mut tile = view()
                .test_id(&metric_tid)
                .flex_col()
                .gap(px(4.0))
                .rounded(px(6.0))
                .border(px(1.0))
                .border_color(AdaptiveUi::LINE)
                .bg(AdaptiveUi::SIDE)
                .p(px(10.0))
                .min_w(px(0.0))
                .child(text(label.clone()).text_size(px(11.5)).text_color(AdaptiveUi::MUTED))
                .child(
                    text(value.clone())
                        .test_id(&value_tid)
                        .text_size(px(18.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(AdaptiveUi::INK),
                );
            if let Some(delta_text) = delta.as_deref().filter(|s| !s.is_empty()) {
                let delta_tid = format!("genui-metric-delta-{id}");
                tile = tile.child(
                    text(delta_text.to_owned())
                        .test_id(&delta_tid)
                        .text_size(px(11.0))
                        .text_color(AdaptiveUi::ACCENT),
                );
            }
            tile.into_element()
        }
        ResolvedNodeKind::Badge { label, tone } => {
            let (bg, fg) = badge_colors(*tone);
            view()
                .test_id(&node_tid)
                .flex_row()
                .items_center()
                .rounded(px(999.0))
                .bg(bg)
                .px(px(8.0))
                .py(px(2.0))
                .child(text(label.clone()).text_size(px(11.5)).font_weight(FontWeight::MEDIUM).text_color(fg))
                .into_element()
        }
        ResolvedNodeKind::Progress { ratio, label, .. } => {
            let clamped = ratio.clamp(0.0, 1.0) as f32;
            let pct = format!("{}%", (clamped * 100.0).round() as u32);
            let mut wrap = view()
                .test_id(&node_tid)
                .flex_col()
                .gap(px(6.0))
                .rounded(px(6.0))
                .border(px(1.0))
                .border_color(AdaptiveUi::LINE)
                .bg(AdaptiveUi::SIDE)
                .p(px(10.0))
                .min_w(px(0.0));
            let header = view()
                .flex_row()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .child(text(label.clone().unwrap_or_default()).text_size(px(11.5)).text_color(AdaptiveUi::MUTED))
                .child(text(pct).text_size(px(11.5)).font_weight(FontWeight::MEDIUM).text_color(AdaptiveUi::INK));
            let track = view()
                .h(px(6.0))
                .w_full()
                .rounded(px(999.0))
                .bg(AdaptiveUi::LINE)
                .overflow_hidden()
                .child(view().h_full().w(relative(clamped)).rounded(px(999.0)).bg(AdaptiveUi::ACCENT));
            wrap = wrap.child(header).child(track);
            wrap.into_element()
        }
        ResolvedNodeKind::Callout { callout_kind, title, body } => {
            let (border, bg, title_fg) = callout_colors(*callout_kind);
            let mut box_el = view()
                .test_id(&node_tid)
                .flex_col()
                .gap(px(4.0))
                .rounded(px(6.0))
                .border_l(px(3.0))
                .border_color(border)
                .bg(bg)
                .px(px(12.0))
                .py(px(8.0))
                .min_w(px(0.0));
            if let Some(t) = title.as_deref().filter(|s| !s.is_empty()) {
                box_el = box_el.child(text(t.to_owned()).text_size(px(12.5)).font_weight(FontWeight::SEMIBOLD).text_color(title_fg));
            }
            box_el = box_el.child(text(body.clone()).text_size(px(13.0)).text_color(AdaptiveUi::INK));
            box_el.into_element()
        }
        ResolvedNodeKind::Table { columns, rows } => {
            let table_tid = format!("genui-table-{id}");
            let mut table = view()
                .test_id(&table_tid)
                .flex_col()
                .rounded(px(6.0))
                .border(px(1.0))
                .border_color(AdaptiveUi::LINE)
                .overflow_hidden()
                .min_w(px(0.0));
            let mut head_row = view().flex_row().bg(AdaptiveUi::SIDE).border_b(px(1.0)).border_color(AdaptiveUi::LINE);
            for col in columns {
                head_row = head_row.child(
                    apply_text_align(view().flex_1().min_w(px(0.0)).flex_row().px(px(8.0)).py(px(6.0)), col.align).child(
                        text(col.label.clone())
                            .text_size(px(12.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(AdaptiveUi::INK),
                    ),
                );
            }
            table = table.child(head_row);
            for (row_idx, row) in rows.iter().enumerate() {
                let row_tid = format!("genui-table-{id}-row-{row_idx}");
                let mut data_row = view()
                    .test_id(&row_tid)
                    .flex_row()
                    .bg(if row_idx % 2 == 1 { AdaptiveUi::HOVER } else { AdaptiveUi::PAGE });
                if row_idx + 1 < rows.len() {
                    data_row = data_row.border_b(px(1.0)).border_color(AdaptiveUi::LINE);
                }
                for (col_idx, cell) in row.cells.iter().enumerate() {
                    let align = columns.get(col_idx).map(|c| c.align).unwrap_or_default();
                    data_row = data_row.child(
                        apply_text_align(view().flex_1().min_w(px(0.0)).flex_row().px(px(8.0)).py(px(5.0)), align)
                            .child(text(cell.clone()).text_size(px(12.5)).text_color(AdaptiveUi::INK)),
                    );
                }
                table = table.child(data_row);
            }
            table.into_element()
        }
        ResolvedNodeKind::Slider {
            bind,
            label,
            value,
            min,
            max,
            step,
            unit,
        } => {
            let step_size = if *step > 0.0 && step.is_finite() { *step } else { 1.0 };
            let cur = *value;
            let lo = *min;
            let hi = *max;
            let display_val = match unit.as_deref().filter(|u| !u.is_empty()) {
                Some(u) => format!("{} {u}", format_clean_number(cur)),
                None => format_clean_number(cur),
            };

            let dec_bind = bind.clone();
            let dec_updater = Rc::clone(updater);
            let dec_val = snap_clamped(cur - step_size, lo, hi, step_size);

            let inc_bind = bind.clone();
            let inc_updater = Rc::clone(updater);
            let inc_val = snap_clamped(cur + step_size, lo, hi, step_size);

            let drag_bind = bind.clone();
            let drag_updater = Rc::clone(updater);

            let dec_tid = format!("genui-slider-dec-{id}");
            let val_tid = format!("genui-slider-value-{id}");
            let inc_tid = format!("genui-slider-inc-{id}");
            let slider_tid = format!("genui-slider-{id}");

            let header = view()
                .flex_row()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .child(text(label.clone()).text_size(px(12.5)).text_color(AdaptiveUi::INK))
                .child(
                    view()
                        .flex_row()
                        .items_center()
                        .gap(px(4.0))
                        .child(
                            view()
                                .test_id(&dec_tid)
                                .role(AccessibilityRole::Button)
                                .rounded(px(4.0))
                                .border(px(1.0))
                                .border_color(AdaptiveUi::LINE)
                                .bg(AdaptiveUi::PAGE)
                                .px(px(6.0))
                                .py(px(1.0))
                                .cursor_pointer()
                                .on_press(move |_: &PressEvent| {
                                    dec_updater(&dec_bind, StateValue::Number(dec_val));
                                })
                                .child(text("-").text_size(px(12.0)).text_color(AdaptiveUi::MUTED)),
                        )
                        .child(
                            text(display_val)
                                .test_id(&val_tid)
                                .text_size(px(12.0))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(AdaptiveUi::MUTED),
                        )
                        .child(
                            view()
                                .test_id(&inc_tid)
                                .role(AccessibilityRole::Button)
                                .rounded(px(4.0))
                                .border(px(1.0))
                                .border_color(AdaptiveUi::LINE)
                                .bg(AdaptiveUi::PAGE)
                                .px(px(6.0))
                                .py(px(1.0))
                                .cursor_pointer()
                                .on_press(move |_: &PressEvent| {
                                    inc_updater(&inc_bind, StateValue::Number(inc_val));
                                })
                                .child(text("+").text_size(px(12.0)).text_color(AdaptiveUi::MUTED)),
                        ),
                );

            let control = slider()
                .test_id(&slider_tid)
                .value(SliderValue::Single(cur))
                .min(lo)
                .max(hi)
                .step(step_size)
                .accessibility_label(Some(SharedString::from(label.clone())))
                .track_style(|s| s.h(px(20.0)).w_full().flex_row().items_center())
                .indicator_style(|s| s.h(px(5.0)).w_full().rounded(px(999.0)).bg(AdaptiveUi::LINE))
                .range_style(|s| s.h_full().rounded(px(999.0)).bg(AdaptiveUi::ACCENT))
                .thumb_style(|s| {
                    s.w(px(14.0))
                        .h(px(14.0))
                        .rounded(px(999.0))
                        .bg(AdaptiveUi::PAGE)
                        .border(px(2.0))
                        .border_color(AdaptiveUi::ACCENT)
                })
                .on_change(move |next: &SliderValue| {
                    drag_updater(&drag_bind, StateValue::Number(next.start()));
                });

            view().test_id(&node_tid).flex_col().gap(px(4.0)).child(header).child(control).into_element()
        }
        ResolvedNodeKind::Switch { bind, label, checked } => {
            let is_checked = *checked;
            let bind_key = bind.clone();
            let set_state = Rc::clone(updater);
            let switch_tid = format!("genui-switch-{id}");

            switch()
                .test_id(&switch_tid)
                .checked(is_checked)
                .accessibility_label(Some(SharedString::from(label.clone())))
                .track_style(move |s| {
                    s.w(px(32.0))
                        .h(px(18.0))
                        .rounded(px(999.0))
                        .p(px(2.0))
                        .flex_row()
                        .items_center()
                        .bg(if is_checked { AdaptiveUi::ACCENT } else { AdaptiveUi::LINE })
                })
                .thumb_style(move |s| {
                    let base = s.w(px(14.0)).h(px(14.0)).rounded(px(999.0)).bg(AdaptiveUi::PAGE);
                    if is_checked { base.ml(px(14.0)) } else { base }
                })
                .on_change(move |next: &bool| {
                    set_state(&bind_key, StateValue::Bool(*next));
                })
                .flex_row()
                .items_center()
                .gap(px(8.0))
                .cursor_pointer()
                .child(text(label.clone()).text_size(px(12.5)).text_color(AdaptiveUi::INK))
                .into_element()
        }
        ResolvedNodeKind::Select {
            bind,
            label,
            selected,
            options,
        } => {
            let mut pills = view().flex_row().flex_wrap().gap(px(6.0));
            for opt in options {
                let is_selected = opt.value == *selected;
                let bind_key = bind.clone();
                let value = opt.value.clone();
                let opt_tid = format!("genui-select-{id}-{}", opt.value);
                let set_state = Rc::clone(updater);
                pills = pills.child(
                    view()
                        .test_id(&opt_tid)
                        .role(AccessibilityRole::Button)
                        .rounded(px(5.0))
                        .border(px(1.0))
                        .border_color(if is_selected { AdaptiveUi::ACCENT } else { AdaptiveUi::LINE })
                        .bg(if is_selected { AdaptiveUi::SELECTED } else { AdaptiveUi::PAGE })
                        .px(px(10.0))
                        .py(px(4.0))
                        .cursor_pointer()
                        .on_press(move |_: &PressEvent| {
                            set_state(&bind_key, StateValue::Text(value.clone()));
                        })
                        .child(
                            text(opt.label.clone())
                                .text_size(px(12.0))
                                .font_weight(if is_selected { FontWeight::SEMIBOLD } else { FontWeight::NORMAL })
                                .text_color(if is_selected { AdaptiveUi::INK } else { AdaptiveUi::MUTED }),
                        ),
                );
            }
            view()
                .test_id(&node_tid)
                .flex_col()
                .gap(px(6.0))
                .child(text(label.clone()).text_size(px(12.5)).text_color(AdaptiveUi::MUTED))
                .child(pills)
                .into_element()
        }
        ResolvedNodeKind::Chart(chart) => match chart.to_chart_spec_json() {
            Ok(spec_json) => view()
                .test_id(&node_tid)
                .min_w(px(0.0))
                .child(vv_chart().spec(spec_json).title(chart.title.clone().map(SharedString::from)))
                .into_element(),
            Err(err) => text(err.to_string())
                .test_id("chart-error")
                .text_size(px(12.0))
                .text_color(AdaptiveUi::BERRY)
                .into_element(),
        },
        ResolvedNodeKind::Diagram { source } => view()
            .test_id(&node_tid)
            .min_w(px(0.0))
            .child(vv_diagram().source(source.clone()))
            .into_element(),
        ResolvedNodeKind::Canvas { data } => view().test_id(&node_tid).min_w(px(0.0)).child(vv_canvas().data(data.clone())).into_element(),
        ResolvedNodeKind::CodeBlock { code, language } => view()
            .test_id(&node_tid)
            .min_w(px(0.0))
            .child(vv_code_block().code(code.clone()).language(language.clone().map(SharedString::from)))
            .into_element(),
    }
}

fn apply_align<E: Styled>(el: E, align: Align) -> E {
    match align {
        Align::Start => el.items_start(),
        Align::Center => el.items_center(),
        Align::End => el.items_end(),
        Align::Stretch => el.items_stretch(),
    }
}

fn apply_text_align<E: Styled>(el: E, align: TextAlign) -> E {
    match align {
        TextAlign::Left => el.justify_start(),
        TextAlign::Center => el.justify_center(),
        TextAlign::Right => el.justify_end(),
    }
}

const fn text_size_pt(size: TextSize) -> f32 {
    match size {
        TextSize::Xs => 11.0,
        TextSize::Sm => 12.5,
        TextSize::Md => 14.0,
        TextSize::Lg => 16.0,
        TextSize::Xl => 20.0,
    }
}

const fn tone_color(tone: Tone) -> AdaptiveColor {
    match tone {
        Tone::Default => AdaptiveUi::INK,
        Tone::Muted => AdaptiveUi::MUTED,
        Tone::Accent => AdaptiveUi::ACCENT,
        Tone::Positive => AdaptiveUi::OK_INK,
        Tone::Warning => AdaptiveUi::WARN_INK,
        Tone::Danger => AdaptiveUi::BERRY,
    }
}

const fn badge_colors(tone: Tone) -> (AdaptiveColor, AdaptiveColor) {
    match tone {
        Tone::Default => (AdaptiveUi::SELECTED, AdaptiveUi::INK),
        Tone::Muted => (AdaptiveUi::HOVER, AdaptiveUi::MUTED),
        Tone::Accent => (AdaptiveUi::OK_SOFT, AdaptiveUi::ACCENT),
        Tone::Positive => (AdaptiveUi::OK_SOFT, AdaptiveUi::OK_INK),
        Tone::Warning => (AdaptiveUi::SIDE, AdaptiveUi::WARN_INK),
        Tone::Danger => (AdaptiveUi::BAD_SOFT, AdaptiveUi::BERRY),
    }
}

const fn callout_colors(kind: CalloutKind) -> (AdaptiveColor, AdaptiveColor, AdaptiveColor) {
    match kind {
        CalloutKind::Info => (AdaptiveUi::WATER, AdaptiveUi::SIDE, AdaptiveUi::WATER),
        CalloutKind::Tip => (AdaptiveUi::ACCENT, AdaptiveUi::OK_SOFT, AdaptiveUi::OK_INK),
        CalloutKind::Warning => (AdaptiveUi::WHEAT, AdaptiveUi::SIDE, AdaptiveUi::WARN_INK),
        CalloutKind::Danger => (AdaptiveUi::BERRY, AdaptiveUi::BAD_SOFT, AdaptiveUi::BERRY),
        CalloutKind::Success => (AdaptiveUi::LEAF, AdaptiveUi::OK_SOFT, AdaptiveUi::OK_INK),
    }
}

fn snap_clamped(candidate: f64, min: f64, max: f64, step: f64) -> f64 {
    let clamped = candidate.clamp(min, max);
    if step <= 0.0 || !step.is_finite() {
        return clamped;
    }
    let steps = ((clamped - min) / step).round();
    let snapped = (min + steps * step).clamp(min, max);
    // Clean floating-point noise such as 0.30000000000000004.
    (snapped * 1e6).round() / 1e6
}

fn format_clean_number(n: f64) -> String {
    if (n - n.round()).abs() < 1e-6 {
        format!("{}", n.round() as i64)
    } else {
        let s = format!("{n:.2}");
        s.trim_end_matches('0').trim_end_matches('.').to_owned()
    }
}

fn format_state_value_summary(value: &StateValue) -> String {
    match value {
        StateValue::Null => "null".to_owned(),
        StateValue::Bool(b) => b.to_string(),
        StateValue::Number(n) => format_clean_number(*n),
        StateValue::Text(s) => s.clone(),
        StateValue::List(items) => format!("[{} items]", items.len()),
        StateValue::Record(map) => format!("{{{} keys}}", map.len()),
    }
}
