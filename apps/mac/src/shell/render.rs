use gpui::{Context, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _, Pixels, Render, Styled as _, Window, div, px};
use vibevalley_workspace::Axis;

use crate::hosted::frames::PaletteMode;
use crate::theme::Ui;

use super::menus::*;
use super::{Shell, should_mount_inspector};

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let frame_start = self.overlays.devtools.state.enabled.then(std::time::Instant::now);
        self.ensure_panes(window, cx);
        self.sync_inspector(window, cx);
        self.ensure_devtools_overlay(window, cx);
        let colors = Ui::get(cx).colors.clone();
        let sidebar_w: Pixels = px(self.chrome.sidebar_width);
        let main = crate::panes::render_main(self, window, cx);
        let palette = self.overlays.palette.as_ref().filter(|p| p.open).map(|p| {
            let vp = window.viewport_size();
            let palette_w = (f32::from(vp.width) - 32.0).clamp(280.0, 620.0);
            let palette_top = if f32::from(vp.height) < 520.0 { 24.0 } else { 72.0 };
            let palette_h = (f32::from(vp.height) - palette_top - 24.0).clamp(220.0, 420.0);
            div()
                .absolute()
                .inset_0()
                .flex()
                .flex_col()
                .items_center()
                .pt(px(palette_top))
                .bg(gpui::hsla(0.0, 0.0, 0.0, 0.25))
                .key_context("Palette")
                .on_action(cx.listener(|this, _: &ClosePalette, window, cx| this.close_palette(window, cx)))
                .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, cx| this.close_palette(window, cx)))
                .child(
                    div()
                        .w(px(palette_w))
                        .h(px(palette_h))
                        .rounded(px(12.0))
                        .overflow_hidden()
                        .shadow_lg()
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .child(p.view.clone()),
                )
        });
        let launch = self.overlays.launch.clone().map(|o| div().absolute().inset_0().child(o));
        let startup_pill = self.render_slow_startup_pill(cx);
        let startup_diagnostics = self.render_startup_diagnostics(cx);
        let devtools_overlay = self.render_devtools_overlay(cx);
        let devtools_capsule = self.render_devtools_capsule(cx);
        let show_inspector = should_mount_inspector(
            self.chrome.native_workspace,
            self.chrome.inspector_open,
            f32::from(window.viewport_size().width),
        );
        let inspector_view = show_inspector.then(|| self.chrome.inspector.as_ref().map(|slot| slot.view.clone())).flatten();
        let root = div()
            .id("shell")
            .size_full()
            .relative()
            .flex()
            .flex_row()
            .bg(colors.bg)
            .text_color(colors.text)
            .key_context("Shell")
            .track_focus(&self.focus)
            .capture_any_mouse_down(|_, _, _| crate::host::restore_window_first_responder())
            .capture_key_down(cx.listener(|s, e: &gpui::KeyDownEvent, _, cx| {
                if s.workspace.chat_menu_group.is_some() && e.keystroke.key == "escape" && !e.keystroke.modifiers.modified() {
                    s.workspace.chat_menu_group = None;
                    cx.stop_propagation();
                    cx.notify();
                }
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|s, e: &gpui::MouseDownEvent, window, cx| {
                    if s.workspace.chat_menu_group.take().is_some() {
                        cx.notify();
                    }
                    if s.overlays.palette.as_ref().is_none_or(|p| !p.open)
                        && s.overlays.launch.is_none()
                        && !e.modifiers.control
                        && !e.modifiers.platform
                        && crate::panes::is_titlebar_hit(f32::from(e.position.y))
                    {
                        if e.click_count >= 2 {
                            s.chrome.window_drag_origin = None;
                            if !window.is_fullscreen() {
                                window.titlebar_double_click();
                            }
                        } else {
                            s.chrome.window_drag_origin = Some((f32::from(e.position.x), f32::from(e.position.y)));
                        }
                    }
                }),
            )
            .on_action(cx.listener(|s, _: &OpenAbout, _, cx| {
                s.navigate_workbench("/settings/about", cx);
            }))
            .on_action(cx.listener(|s, _: &OpenSettings, _, cx| {
                s.navigate_workbench("/settings", cx);
            }))
            .on_action(cx.listener(|_, _: &Hide, _, cx| cx.hide()))
            .on_action(cx.listener(|_, _: &HideOthers, _, cx| cx.hide_other_apps()))
            .on_action(cx.listener(|_, _: &ShowAll, _, cx| cx.unhide_other_apps()))
            .on_action(cx.listener(|_, _: &EditUndo, w, cx| {
                w.dispatch_keystroke(gpui::Keystroke::parse("cmd-z").expect("keystroke"), cx);
            }))
            .on_action(cx.listener(|_, _: &EditRedo, w, cx| {
                w.dispatch_keystroke(gpui::Keystroke::parse("cmd-shift-z").expect("keystroke"), cx);
            }))
            .on_action(cx.listener(|_, _: &EditCut, w, cx| {
                w.dispatch_keystroke(gpui::Keystroke::parse("cmd-x").expect("keystroke"), cx);
            }))
            .on_action(cx.listener(|_, _: &EditCopy, w, cx| {
                w.dispatch_keystroke(gpui::Keystroke::parse("cmd-c").expect("keystroke"), cx);
            }))
            .on_action(cx.listener(|_, _: &EditPaste, w, cx| {
                w.dispatch_keystroke(gpui::Keystroke::parse("cmd-v").expect("keystroke"), cx);
            }))
            .on_action(cx.listener(|_, _: &EditSelectAll, w, cx| {
                w.dispatch_keystroke(gpui::Keystroke::parse("cmd-a").expect("keystroke"), cx);
            }))
            .on_action(cx.listener(|_, _: &ToggleFullScreen, w, _| w.toggle_fullscreen()))
            .on_action(cx.listener(|_, _: &CloseWindow, w, _| w.remove_window()))
            .on_action(cx.listener(|s, _: &ActivateProject1, w, cx| s.activate_index(0, w, cx)))
            .on_action(cx.listener(|s, _: &ActivateProject2, w, cx| s.activate_index(1, w, cx)))
            .on_action(cx.listener(|s, _: &ActivateProject3, w, cx| s.activate_index(2, w, cx)))
            .on_action(cx.listener(|s, _: &ActivateProject4, w, cx| s.activate_index(3, w, cx)))
            .on_action(cx.listener(|s, _: &ActivateProject5, w, cx| s.activate_index(4, w, cx)))
            .on_action(cx.listener(|s, _: &ActivateProject6, w, cx| s.activate_index(5, w, cx)))
            .on_action(cx.listener(|s, _: &ActivateProject7, w, cx| s.activate_index(6, w, cx)))
            .on_action(cx.listener(|s, _: &ActivateProject8, w, cx| s.activate_index(7, w, cx)))
            .on_action(cx.listener(|s, _: &ActivateProject9, w, cx| s.activate_index(8, w, cx)))
            .on_action(cx.listener(|s, _: &GoToFile, w, cx| s.open_palette(PaletteMode::Files, w, cx)))
            .on_action(cx.listener(|s, _: &CommandPalette, w, cx| s.open_palette(PaletteMode::Commands, w, cx)))
            .on_action(cx.listener(|s, _: &SearchProject, w, cx| s.open_palette(PaletteMode::Search, w, cx)))
            .on_action(cx.listener(|s, _: &NewTerminal, w, cx| s.new_terminal(None, w, cx)))
            .on_action(cx.listener(|s, _: &NewChat, w, cx| s.new_chat(None, w, cx)))
            .on_action(cx.listener(|s, _: &CloseTab, w, cx| s.close_active_tab(w, cx)))
            .on_action(cx.listener(|s, _: &SplitRight, w, cx| s.split(Axis::Horizontal, w, cx)))
            .on_action(cx.listener(|s, _: &SplitDown, w, cx| s.split(Axis::Vertical, w, cx)))
            .on_action(cx.listener(|s, _: &NextTab, w, cx| {
                if let Some(p) = s.workspace.ws.active_mut() {
                    p.layout.tab_cycle(1);
                }
                s.layout_changed(w, cx);
            }))
            .on_action(cx.listener(|s, _: &PrevTab, w, cx| {
                if let Some(p) = s.workspace.ws.active_mut() {
                    p.layout.tab_cycle(-1);
                }
                s.layout_changed(w, cx);
            }))
            .on_action(cx.listener(|s, _: &FocusNextGroup, w, cx| {
                if let Some(p) = s.workspace.ws.active_mut() {
                    p.layout.focus_cycle(1);
                }
                s.layout_changed(w, cx);
            }))
            .on_action(cx.listener(|s, _: &ZoomIn, _, cx| s.adjust_font_size(1.0, cx)))
            .on_action(cx.listener(|s, _: &ZoomOut, _, cx| s.adjust_font_size(-1.0, cx)))
            .on_action(cx.listener(|s, _: &ZoomReset, _, cx| s.reset_font_size(cx)))
            .on_action(cx.listener(|s, _: &ToggleSidebar, _, cx| s.toggle_sidebar(cx)))
            .on_action(cx.listener(|s, _: &ToggleTheme, _, cx| s.toggle_theme(cx)))
            .on_action(cx.listener(|s, _: &ToggleDevtools, w, cx| s.toggle_devtools(w, cx)))
            .on_action(cx.listener(|_, _: &Quit, _, cx| cx.quit()))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(|s, _, _, cx| s.on_mouse_up(cx)))
            .child(div().size_full().child(self.chrome.workbench.clone()))
            .children(self.chrome.native_workspace.then(|| {
                let inspector_w: Pixels = px(self.chrome.inspector_width);
                div()
                    .id("workspace")
                    .key_context("Workspace")
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .right_0()
                    .left(px(self.chrome.global_rail_width))
                    .flex()
                    .flex_row()
                    .bg(colors.bg)
                    .children(
                        self.chrome
                            .sidebar_visible
                            .then(|| div().w(sidebar_w).h_full().flex_none().child(self.chrome.sidebar.clone())),
                    )
                    .children(self.chrome.sidebar_visible.then(|| {
                        div()
                            .id("sidebar-divider")
                            .w(px(1.0))
                            .h_full()
                            .flex_none()
                            .bg(colors.border)
                            .cursor_col_resize()
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(|s, _, _, cx| {
                                    cx.stop_propagation();
                                    s.chrome.window_drag_origin = None;
                                    s.chrome.resizing_sidebar = true;
                                }),
                            )
                    }))
                    .child(div().flex_1().h_full().min_w_0().child(main))
                    .children(inspector_view.is_some().then(|| {
                        div()
                            .id("inspector-divider")
                            .w(px(1.0))
                            .h_full()
                            .flex_none()
                            .bg(colors.border)
                            .cursor_col_resize()
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(|s, _, _, cx| {
                                    cx.stop_propagation();
                                    s.chrome.window_drag_origin = None;
                                    s.chrome.resizing_inspector = true;
                                }),
                            )
                    }))
                    .children(inspector_view.map(|view| div().w(inspector_w).h_full().flex_none().child(view)))
            }))
            .children(self.chrome.native_diorama.as_ref().map(|slot| {
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .right_0()
                    .left(px(self.chrome.global_rail_width))
                    .child(slot.view.clone())
            }))
            .children(palette)
            .children(self.workspace.terminal_notice.as_ref().map(|message| {
                div()
                    .id("terminal-folder-notice")
                    .absolute()
                    .left(px(20.))
                    .right(px(20.))
                    .bottom(px(16.))
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .px(px(14.))
                    .py(px(10.))
                    .rounded(px(8.))
                    .bg(colors.elevated)
                    .border_1()
                    .border_color(colors.danger)
                    .child(div().flex_1().min_w_0().text_sm().child(message.clone()))
                    .child(
                        div()
                            .id("terminal-notice-dismiss")
                            .cursor_pointer()
                            .text_sm()
                            .text_color(colors.accent)
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(|s, _, _, cx| {
                                    s.workspace.terminal_notice = None;
                                    cx.stop_propagation();
                                    cx.notify();
                                }),
                            )
                            .child(vibevalley_i18n::t("desktop.terminal.dismiss", &[])),
                    )
            }))
            .children(devtools_overlay)
            .children(devtools_capsule)
            .children(launch)
            .children(startup_pill)
            .children(startup_diagnostics);
        if let Some(started) = frame_start {
            let duration_us = started.elapsed().as_micros() as u64;
            let ms = duration_us as f64 / 1000.0;
            self.overlays.devtools.state.record_frame_ms(ms);
            if self.overlays.devtools.state.should_record_frame(duration_us)
                && let Some(handle) = cx.try_global::<crate::hosted::ShellDebugHandle>()
            {
                handle.record_frame(duration_us, "Shell::render");
            }
        }
        root
    }
}
