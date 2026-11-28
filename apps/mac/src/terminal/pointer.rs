use std::path::PathBuf;
use std::sync::Arc;

use gpui::{
    AppContext as _, Context, Modifiers, ModifiersChangedEvent, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ScrollEvent, Window, point, px,
};
use vibevalley_terminal::{
    LinkMatch, LinkResolveContext, LinkSpan, LinkTarget, Mods, MouseButton as TermButton, MouseInput, MouseKind, SelectionMode, Snapshot, link_at_with,
};

use super::element;
use super::preview;
use super::status::{HoveredLink, TerminalEvent};
use super::view::TerminalView;

fn mods(m: Modifiers) -> Mods {
    Mods {
        shift: m.shift,
        ctrl: m.control,
        alt: m.alt,
        cmd: m.platform,
    }
}

impl TerminalView {
    pub(super) fn reports_mouse(&self, modifiers: Modifiers) -> bool {
        // Shift bypasses the program's mouse mode, as in every terminal.
        !modifiers.shift && self.snapshot().is_some_and(|s| s.mouse_reporting)
    }

    pub(crate) fn hovered_link_spans(&self) -> Vec<LinkSpan> {
        self.hovered_link.as_ref().map(|h| h.link.spans.clone()).unwrap_or_default()
    }

    fn link_resolve_context(&self) -> LinkResolveContext {
        LinkResolveContext::new(Some(self.directory()), self.spec.project_root.clone())
    }

    fn match_link_in(&self, snapshot: &Snapshot, at: vibevalley_terminal::Point) -> Option<LinkMatch> {
        link_at_with(snapshot, at, || self.link_resolve_context())
    }

    fn resolve_link_at(&self, at: vibevalley_terminal::Point) -> Option<LinkMatch> {
        let snapshot = self.snapshot()?;
        if let Some(hovered) = &self.hovered_link
            && hovered.snapshot_seq == snapshot.seq
            && hovered.link.contains(at)
        {
            return Some(hovered.link.clone());
        }
        self.match_link_in(&snapshot, at)
    }

    fn hovered_image_path(&self) -> Option<&std::path::Path> {
        match &self.hovered_link.as_ref()?.link.target {
            LinkTarget::File { path, .. } if preview::is_previewable_image(path) => Some(path.as_path()),
            _ => None,
        }
    }

    pub(super) fn dismiss_image_preview(&mut self) -> bool {
        self.preview_gen = self.preview_gen.wrapping_add(1);
        self.image_preview.take().is_some()
    }

    fn sync_image_preview(&mut self, cx: &mut Context<Self>) {
        let Some(path) = (!self.dragging && self.context_menu.is_none())
            .then(|| self.hovered_image_path().map(PathBuf::from))
            .flatten()
        else {
            if self.dismiss_image_preview() {
                cx.notify();
            }
            return;
        };
        if self.image_preview.as_ref().is_some_and(|meta| meta.path == path) {
            return;
        }
        self.preview_gen = self.preview_gen.wrapping_add(1);
        let generation = self.preview_gen;
        if self.image_preview.take().is_some() {
            cx.notify();
        }
        let probe_path = path.clone();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(preview::HOVER_DEBOUNCE).await;
            let still_current = this
                .update(cx, |view, _| {
                    view.preview_gen == generation && view.context_menu.is_none() && !view.dragging && view.hovered_image_path() == Some(probe_path.as_path())
                })
                .unwrap_or(false);
            if !still_current {
                return;
            }
            let path_for_probe = probe_path.clone();
            let meta = cx.background_spawn(async move { preview::probe_image_meta(&path_for_probe) }).await;
            let Some(meta) = meta else {
                return;
            };
            let _ = this.update(cx, |view, cx| {
                if view.preview_gen == generation && view.context_menu.is_none() && !view.dragging && view.hovered_image_path() == Some(probe_path.as_path()) {
                    view.image_preview = Some(meta);
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub(super) fn clear_hover(&mut self, cx: &mut Context<Self>) {
        self.hovered_cell = None;
        self.hover_eval_key = None;
        let link_cleared = self.hovered_link.take().is_some();
        let preview_cleared = self.dismiss_image_preview();
        if link_cleared || preview_cleared {
            cx.notify();
        }
    }

    pub(super) fn invalidate_stale_hover(&mut self) {
        let Some(snapshot) = self.snapshot() else {
            self.hovered_link = None;
            self.hover_eval_key = None;
            self.dismiss_image_preview();
            return;
        };
        if let Some(hovered) = &self.hovered_link {
            let allow_hover = !snapshot.mouse_reporting || self.cmd_held;
            let rows_unchanged = hovered
                .row_refs
                .iter()
                .all(|(row_idx, old_row)| snapshot.rows.get(usize::from(*row_idx)).is_some_and(|cur| Arc::ptr_eq(cur, old_row)));
            if !allow_hover || !rows_unchanged {
                self.hovered_link = None;
                self.hover_eval_key = None;
                self.dismiss_image_preview();
            }
        } else {
            self.hover_eval_key = None;
        }
    }

    fn update_hover(&mut self, cell: Option<vibevalley_terminal::Point>, cmd_held: bool, cx: &mut Context<Self>) {
        self.hovered_cell = cell;
        self.cmd_held = cmd_held;
        if self.context_menu.is_some() || self.dragging {
            self.hover_eval_key = None;
            let link_cleared = self.hovered_link.take().is_some();
            let preview_cleared = self.dismiss_image_preview();
            if link_cleared || preview_cleared {
                cx.notify();
            }
            return;
        }
        let (Some(cell), Some(snapshot)) = (cell, self.snapshot()) else {
            self.hover_eval_key = None;
            let link_cleared = self.hovered_link.take().is_some();
            let preview_cleared = self.dismiss_image_preview();
            if link_cleared || preview_cleared {
                cx.notify();
            }
            return;
        };
        let allow_hover = !snapshot.mouse_reporting || cmd_held;
        let eval_key = (snapshot.seq, cell, cmd_held);
        if !allow_hover {
            self.hover_eval_key = Some(eval_key);
            let link_cleared = self.hovered_link.take().is_some();
            let preview_cleared = self.dismiss_image_preview();
            if link_cleared || preview_cleared {
                cx.notify();
            }
            return;
        }
        if self.hover_eval_key == Some(eval_key) {
            return;
        }
        if let Some(existing) = &self.hovered_link
            && existing.snapshot_seq == snapshot.seq
            && existing.link.contains(cell)
        {
            self.hover_eval_key = Some(eval_key);
            return;
        }

        let next = self.match_link_in(&snapshot, cell);
        self.hover_eval_key = Some(eval_key);
        let unchanged = self.hovered_link.as_ref().map(|h| &h.link) == next.as_ref();
        self.hovered_link = next.map(|link| {
            let row_refs = link
                .spans
                .iter()
                .filter_map(|span| snapshot.rows.get(usize::from(span.row)).map(|row| (span.row, row.clone())))
                .collect();
            HoveredLink {
                link,
                snapshot_seq: snapshot.seq,
                row_refs,
            }
        });
        if !unchanged {
            self.sync_image_preview(cx);
            cx.notify();
        }
    }

    pub(super) fn on_modifiers_changed(&mut self, event: &ModifiersChangedEvent, _: &mut Window, cx: &mut Context<Self>) {
        if event.modifiers.platform != self.cmd_held {
            self.update_hover(self.hovered_cell, event.modifiers.platform, cx);
        }
    }

    pub(super) fn on_mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        self.cmd_held = event.modifiers.platform;
        self.plain_click_cell = None;
        if self.dismiss_image_preview() {
            cx.notify();
        }
        let (Some(session), Some(g)) = (self.session().cloned(), self.geometry) else {
            return;
        };
        let at = g.cell_at(event.position);
        let exact = g.cell_at_exact(event.position);
        let button = match event.button {
            MouseButton::Left => TermButton::Left,
            MouseButton::Middle => TermButton::Middle,
            MouseButton::Right => TermButton::Right,
            _ => return,
        };
        // Cmd+Click overrides embedded TUI mouse reporting when over a matched link.
        if button == TermButton::Left
            && event.modifiers.platform
            && self.context_menu.is_none()
            && let Some(cell) = exact
            && let Some(hit) = self.resolve_link_at(cell)
        {
            cx.emit(TerminalEvent::OpenLink(hit.target));
            return;
        }
        if self.reports_mouse(event.modifiers) {
            if self.context_menu.take().is_some() {
                cx.notify();
            }
            session.send_mouse(MouseInput {
                kind: MouseKind::Press(button),
                at,
                mods: mods(event.modifiers),
            });
            self.dragging = button == TermButton::Left;
            self.drag_anchor = None;
            return;
        }
        if button == TermButton::Right {
            self.clear_hover(cx);
            let local_x = (event.position.x - g.origin.x + px(element::PADDING)).max(px(4.0));
            let local_y = (event.position.y - g.origin.y + px(element::PADDING)).max(px(4.0));
            let max_x = (g.cell_width * g.size.cols as f32 + px(element::PADDING * 2.0) - px(164.0)).max(px(4.0));
            let max_y = (g.line_height * g.size.rows as f32 + px(element::PADDING * 2.0) - px(124.0)).max(px(4.0));
            self.context_menu = Some(point(local_x.min(max_x), local_y.min(max_y)));
            cx.notify();
            return;
        }
        if button != TermButton::Left {
            return;
        }
        if self.context_menu.take().is_some() {
            cx.notify();
            return;
        }
        let had_selection = self.snapshot().is_some_and(|s| s.selection.is_some());
        if event.modifiers.shift {
            session.selection_extend(at);
        } else {
            let mode = match event.click_count {
                0 | 1 => SelectionMode::Cell,
                2 => SelectionMode::Word,
                _ => SelectionMode::Line,
            };
            session.selection_clear();
            if event.click_count > 1 {
                session.selection_start(at, mode);
            } else if !had_selection && !event.modifiers.platform {
                self.plain_click_cell = exact;
            }
        }
        self.dragging = true;
        self.drag_anchor = Some((at, event.click_count <= 1));
    }

    pub(super) fn on_mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        let (Some(session), Some(g)) = (self.session().cloned(), self.geometry) else {
            return;
        };
        let at = g.cell_at(event.position);
        let exact = g.cell_at_exact(event.position);
        if self.reports_mouse(event.modifiers) {
            session.send_mouse(MouseInput {
                kind: MouseKind::Move,
                at,
                mods: mods(event.modifiers),
            });
            self.update_hover(exact, event.modifiers.platform, cx);
            return;
        }
        if self.dragging && event.pressed_button == Some(MouseButton::Left) {
            if let Some((anchor, true)) = self.drag_anchor {
                if anchor == at {
                    return;
                }
                self.plain_click_cell = None;
                self.clear_hover(cx);
                session.selection_start(anchor, SelectionMode::Cell);
                self.drag_anchor = Some((anchor, false));
            }
            session.selection_extend(at);
            return;
        }
        self.update_hover(exact, event.modifiers.platform, cx);
    }

    pub(super) fn on_mouse_up(&mut self, event: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        self.cmd_held = event.modifiers.platform;
        let was_dragging = std::mem::take(&mut self.dragging);
        self.drag_anchor = None;
        let plain_click = self.plain_click_cell.take();
        let (Some(session), Some(g)) = (self.session(), self.geometry) else { return };
        let button = match event.button {
            MouseButton::Left => TermButton::Left,
            MouseButton::Middle => TermButton::Middle,
            MouseButton::Right => TermButton::Right,
            _ => return,
        };
        if self.reports_mouse(event.modifiers) && (was_dragging || button != TermButton::Left) {
            session.send_mouse(MouseInput {
                kind: MouseKind::Release(button),
                at: g.cell_at(event.position),
                mods: mods(event.modifiers),
            });
            return;
        }
        if button == TermButton::Left
            && !self.reports_mouse(event.modifiers)
            && !event.modifiers.shift
            && !event.modifiers.platform
            && let Some(down_cell) = plain_click
            && g.cell_at_exact(event.position) == Some(down_cell)
            && let Some(hit) = self.resolve_link_at(down_cell)
        {
            cx.emit(TerminalEvent::OpenLink(hit.target));
        }
    }

    pub(super) fn on_mouse_up_out(&mut self, event: &MouseUpEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.plain_click_cell = None;
        self.clear_hover(cx);
        self.on_mouse_up(event, window, cx);
    }

    pub(super) fn on_scroll(&mut self, event: &ScrollEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.dismiss_image_preview() {
            cx.notify();
        }
        let (Some(session), Some(g)) = (self.session().cloned(), self.geometry) else {
            return;
        };
        let total = self.scroll_remainder + event.delta.pixel_delta(g.line_height).y;
        let lines = (total / g.line_height).trunc() as i32;
        self.scroll_remainder = total - g.line_height * lines as f32;
        if lines == 0 {
            return;
        }
        let Some(snapshot) = self.snapshot() else { return };
        if self.reports_mouse(event.modifiers) {
            session.send_mouse(MouseInput {
                kind: MouseKind::Wheel { lines },
                at: g.cell_at(event.position),
                mods: mods(event.modifiers),
            });
        } else if snapshot.alternate_scroll {
            let key = if lines > 0 {
                vibevalley_terminal::Key::Up
            } else {
                vibevalley_terminal::Key::Down
            };
            for _ in 0..lines.unsigned_abs().min(50) {
                session.send_key(vibevalley_terminal::KeyInput {
                    key: key.clone(),
                    mods: Mods::default(),
                    text: None,
                });
            }
        } else {
            session.scroll_lines(lines);
        }
    }
}
