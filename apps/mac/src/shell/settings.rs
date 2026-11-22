use std::time::Duration;

use gpui::{Context, MouseButton, MouseMoveEvent, Window};

use crate::panes::PaneEntity;
use crate::theme::{MotionChoice, ThemeChoice, Ui};

use super::{SETTINGS_KEY, SIDEBAR_MAX, SIDEBAR_MIN, Shell};

impl Shell {
    pub(super) fn schedule_save(&mut self, cx: &mut Context<Self>) {
        if self.save_pending || self.store.is_none() {
            return;
        }
        self.save_pending = true;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(800)).await;
            let _ = this.update(cx, |s, cx| {
                s.save_pending = false;
                s.save_now(cx);
            });
        })
        .detach();
    }

    pub fn save_now(&mut self, cx: &mut Context<Self>) {
        let Some(store) = self.store.clone() else { return };
        let jobs = self.ws.save_jobs();
        Self::bg(
            cx,
            move || {
                for job in jobs {
                    if let Err(e) = job.run(&*store) {
                        eprintln!("save: {e}");
                    }
                }
            },
            |_, _, _| {},
        );
    }

    pub(super) fn save_settings(&mut self, cx: &mut Context<Self>) {
        let Some(store) = self.store.clone() else { return };
        let mut settings = Ui::get(cx).settings.clone();
        settings.sidebar_width = self.sidebar_width;
        settings.sidebar_visible = self.sidebar_visible;
        settings.inspector_open = self.inspector_open;
        settings.inspector_width = self.inspector_width;
        settings.last_route = self.last_route.clone();
        Self::bg(
            cx,
            move || vibevalley_workspace::persist::save_setting(&*store, SETTINGS_KEY, &settings),
            |_, r, _| {
                if let Err(e) = r {
                    eprintln!("save settings: {e}");
                }
            },
        );
    }

    pub fn toggle_sidebar(&mut self, cx: &mut Context<Self>) {
        self.sidebar_visible = !self.sidebar_visible;
        self.save_settings(cx);
        cx.notify();
    }

    pub fn toggle_inspector(&mut self, cx: &mut Context<Self>) {
        self.inspector_open = !self.inspector_open;
        self.save_settings(cx);
        self.push_sidebar(cx);
        cx.notify();
    }

    pub fn adjust_font_size(&mut self, delta: f32, cx: &mut Context<Self>) {
        let mut settings = Ui::get(cx).settings.clone();
        if self.native_workspace {
            settings.terminal_font_size = (settings.terminal_font_size + delta).clamp(9.0, 32.0);
            Ui::apply(settings, cx);
        } else {
            settings.ui_font_size = (settings.ui_font_size + delta).clamp(10.0, 24.0);
            Ui::apply(settings, cx);
            self.apply_ui_font_size(cx);
        }
        self.save_settings(cx);
        cx.notify();
    }

    pub fn reset_font_size(&mut self, cx: &mut Context<Self>) {
        let mut settings = Ui::get(cx).settings.clone();
        if self.native_workspace {
            settings.terminal_font_size = 13.0;
            Ui::apply(settings, cx);
        } else {
            settings.ui_font_size = 13.0;
            Ui::apply(settings, cx);
            self.apply_ui_font_size(cx);
        }
        self.save_settings(cx);
        cx.notify();
    }

    pub fn set_theme(&mut self, choice: ThemeChoice, cx: &mut Context<Self>) {
        let was_dark = Ui::get(cx).colors.dark;
        let mut settings = Ui::get(cx).settings.clone();
        settings.theme = choice;
        Ui::apply(settings, cx);
        if Ui::get(cx).colors.dark != was_dark {
            self.theme_changed(cx);
        }
        self.save_settings(cx);
    }

    pub fn toggle_theme(&mut self, cx: &mut Context<Self>) {
        let choice = if Ui::get(cx).colors.dark { ThemeChoice::Light } else { ThemeChoice::Dark };
        self.set_theme(choice, cx);
    }

    pub fn set_motion(&mut self, choice: MotionChoice, cx: &mut Context<Self>) {
        let mut settings = Ui::get(cx).settings.clone();
        settings.motion = choice;
        let effective = settings.effective_motion();
        Ui::apply(settings, cx);
        if effective == MotionChoice::Off {
            self.launch = None;
            for t in self.terminals.values() {
                t.view.update(cx, |t, cx| {
                    if !t.blink_on {
                        t.blink_on = true;
                        cx.notify();
                    }
                });
            }
        }
        self.notify_motion(effective, cx);
        self.save_settings(cx);
        cx.notify();
    }

    pub(super) fn notify_motion(&mut self, motion: MotionChoice, cx: &mut Context<Self>) {
        self.sidebar.update(cx, |v, cx| v.set_motion(motion, cx));
        self.inspector.update(cx, |v, cx| v.set_motion(motion, cx));
        self.workbench.update(cx, |v, cx| v.set_motion(motion, cx));
        if let Some(p) = &self.palette {
            p.view.update(cx, |v, cx| v.set_motion(motion, cx));
        }
        for pane in self.panes.values() {
            if let PaneEntity::Hosted(view) = &pane.entity {
                view.update(cx, |v, cx| v.set_motion(motion, cx));
            }
        }
    }

    pub(super) fn apply_ui_font_size(&mut self, cx: &mut Context<Self>) {
        let size = Ui::get(cx).settings.ui_font_size;
        self.sidebar.update(cx, |v, cx| v.set_ui_font_size(size, cx));
        self.inspector.update(cx, |v, cx| v.set_ui_font_size(size, cx));
        self.workbench.update(cx, |v, cx| v.set_ui_font_size(size, cx));
        if let Some(p) = &self.palette {
            p.view.update(cx, |v, cx| v.set_ui_font_size(size, cx));
        }
        for pane in self.panes.values() {
            if let PaneEntity::Hosted(view) = &pane.entity {
                view.update(cx, |v, cx| v.set_ui_font_size(size, cx));
            }
        }
    }

    pub(super) fn notify_locale(&mut self, locale: &str, cx: &mut Context<Self>) {
        self.sidebar.update(cx, |v, cx| v.set_locale(locale, cx));
        self.inspector.update(cx, |v, cx| v.set_locale(locale, cx));
        self.workbench.update(cx, |v, cx| v.set_locale(locale, cx));
        if let Some(p) = &self.palette {
            p.view.update(cx, |v, cx| v.set_locale(locale, cx));
        }
        for pane in self.panes.values() {
            if let PaneEntity::Hosted(view) = &pane.entity {
                view.update(cx, |v, cx| v.set_locale(locale, cx));
            }
        }
    }

    /// Tells every open terminal and hosted view about the new theme.
    pub(super) fn theme_changed(&mut self, cx: &mut Context<Self>) {
        let dark = Ui::get(cx).colors.dark;
        for t in self.terminals.values() {
            t.view.update(cx, |t, cx| t.apply_theme(cx));
        }
        self.sidebar.update(cx, |v, cx| v.set_dark(dark, cx));
        self.inspector.update(cx, |v, cx| v.set_dark(dark, cx));
        self.workbench.update(cx, |v, cx| v.set_dark(dark, cx));
        if let Some(p) = &self.palette {
            p.view.update(cx, |v, cx| v.set_dark(dark, cx));
        }
        for pane in self.panes.values() {
            if let PaneEntity::Hosted(view) = &pane.entity {
                view.update(cx, |v, cx| v.set_dark(dark, cx));
            }
        }
        cx.notify();
    }

    pub(super) fn on_mouse_move(&mut self, e: &MouseMoveEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.resizing_sidebar {
            self.sidebar_width = (f32::from(e.position.x) - self.global_rail_width).clamp(SIDEBAR_MIN, SIDEBAR_MAX);
            cx.notify();
        } else if self.resizing_inspector {
            let win_w = f32::from(window.viewport_size().width);
            self.inspector_width = (win_w - f32::from(e.position.x)).clamp(SIDEBAR_MIN, SIDEBAR_MAX);
            cx.notify();
        } else if let Some((split, index)) = self.dragging_split
            && let Some(project) = self.ws.active_mut()
            && let Some(fraction) = self.split_bounds.fraction(&project.layout, split, index, e.position)
        {
            project.layout.resize(split, index, fraction);
            cx.notify();
        } else if let Some(origin) = self.window_drag_origin {
            if e.pressed_button != Some(MouseButton::Left) {
                self.window_drag_origin = None;
            } else if crate::panes::exceeded_window_drag_slop(origin, (f32::from(e.position.x), f32::from(e.position.y))) {
                self.window_drag_origin = None;
                if !window.is_fullscreen() {
                    window.start_window_move();
                }
            }
        }
    }

    pub(super) fn on_mouse_up(&mut self, cx: &mut Context<Self>) {
        self.window_drag_origin = None;
        if self.resizing_sidebar {
            self.resizing_sidebar = false;
            self.save_settings(cx);
        }
        if self.resizing_inspector {
            self.resizing_inspector = false;
            self.save_settings(cx);
        }
        if self.dragging_split.take().is_some() {
            self.schedule_save(cx);
        }
    }
}
