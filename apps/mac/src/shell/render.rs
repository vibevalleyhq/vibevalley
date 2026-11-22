use gpui::{Context, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _, Pixels, Render, Styled as _, Window, div, px};
use vibevalley_workspace::Axis;

use crate::hosted::frames::PaletteMode;
use crate::theme::Ui;

use super::Shell;
use super::menus::*;

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.ensure_panes(window, cx);
        let colors = Ui::get(cx).colors.clone();
        let sidebar_w: Pixels = px(self.sidebar_width);
        let main = crate::panes::render_main(self, window, cx);
        let palette = self.palette.as_ref().filter(|p| p.open).map(|p| {
            div()
                .absolute()
                .inset_0()
                .flex()
                .flex_col()
                .items_center()
                .pt(px(72.0))
                .bg(gpui::hsla(0.0, 0.0, 0.0, 0.25))
                .key_context("Palette")
                .on_action(cx.listener(|this, _: &ClosePalette, window, cx| this.close_palette(window, cx)))
                .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, cx| this.close_palette(window, cx)))
                .child(
                    div()
                        .w(px(620.0))
                        .h(px(420.0))
                        .rounded(px(12.0))
                        .overflow_hidden()
                        .shadow_lg()
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .child(p.view.clone()),
                )
        });
        let launch = self.launch.clone().map(|o| div().absolute().inset_0().child(o));
        div()
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
                if s.chat_menu_group.is_some() && e.keystroke.key == "escape" && !e.keystroke.modifiers.modified() {
                    s.chat_menu_group = None;
                    cx.stop_propagation();
                    cx.notify();
                }
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|s, e: &gpui::MouseDownEvent, window, cx| {
                    if s.chat_menu_group.take().is_some() {
                        cx.notify();
                    }
                    if s.palette.as_ref().is_none_or(|p| !p.open)
                        && s.launch.is_none()
                        && !e.modifiers.control
                        && !e.modifiers.platform
                        && crate::panes::is_titlebar_hit(f32::from(e.position.y))
                    {
                        if e.click_count >= 2 {
                            s.window_drag_origin = None;
                            if !window.is_fullscreen() {
                                window.titlebar_double_click();
                            }
                        } else {
                            s.window_drag_origin = Some((f32::from(e.position.x), f32::from(e.position.y)));
                        }
                    }
                }),
            )
            .on_action(cx.listener(|s, _: &OpenAbout, _, cx| {
                s.native_workspace = false;
                s.native_pixel = None;
                s.workbench.update(cx, |v, cx| v.navigate("/settings/about", cx));
                cx.notify();
            }))
            .on_action(cx.listener(|s, _: &OpenSettings, _, cx| {
                s.native_workspace = false;
                s.native_pixel = None;
                s.workbench.update(cx, |v, cx| v.navigate("/settings", cx));
                cx.notify();
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
                if let Some(p) = s.ws.active_mut() {
                    p.layout.tab_cycle(1);
                }
                s.layout_changed(w, cx);
            }))
            .on_action(cx.listener(|s, _: &PrevTab, w, cx| {
                if let Some(p) = s.ws.active_mut() {
                    p.layout.tab_cycle(-1);
                }
                s.layout_changed(w, cx);
            }))
            .on_action(cx.listener(|s, _: &FocusNextGroup, w, cx| {
                if let Some(p) = s.ws.active_mut() {
                    p.layout.focus_cycle(1);
                }
                s.layout_changed(w, cx);
            }))
            .on_action(cx.listener(|s, _: &ZoomIn, _, cx| s.adjust_font_size(1.0, cx)))
            .on_action(cx.listener(|s, _: &ZoomOut, _, cx| s.adjust_font_size(-1.0, cx)))
            .on_action(cx.listener(|s, _: &ZoomReset, _, cx| s.reset_font_size(cx)))
            .on_action(cx.listener(|s, _: &ToggleSidebar, _, cx| s.toggle_sidebar(cx)))
            .on_action(cx.listener(|s, _: &ToggleTheme, _, cx| s.toggle_theme(cx)))
            .on_action(cx.listener(|_, _: &Quit, _, cx| cx.quit()))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(|s, _, _, cx| s.on_mouse_up(cx)))
            .child(div().size_full().child(self.workbench.clone()))
            .children(self.native_workspace.then(|| {
                let inspector_w: Pixels = px(self.inspector_width);
                div()
                    .id("workspace")
                    .key_context("Workspace")
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .right_0()
                    .left(px(self.global_rail_width))
                    .flex()
                    .flex_row()
                    .bg(colors.bg)
                    .children(
                        self.sidebar_visible
                            .then(|| div().w(sidebar_w).h_full().flex_none().child(self.sidebar.clone())),
                    )
                    .children(self.sidebar_visible.then(|| {
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
                                    s.window_drag_origin = None;
                                    s.resizing_sidebar = true;
                                }),
                            )
                    }))
                    .child(div().flex_1().h_full().min_w_0().child(main))
                    .children((self.inspector_open && f32::from(window.viewport_size().width) >= 1040.0).then(|| {
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
                                    s.window_drag_origin = None;
                                    s.resizing_inspector = true;
                                }),
                            )
                    }))
                    .children(
                        (self.inspector_open && f32::from(window.viewport_size().width) >= 1040.0)
                            .then(|| div().w(inspector_w).h_full().flex_none().child(self.inspector.clone())),
                    )
            }))
            .children(self.native_pixel.as_ref().map(|slot| {
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .right_0()
                    .left(px(self.global_rail_width))
                    .child(slot.view.clone())
            }))
            .children(palette)
            .children(self.terminal_notice.as_ref().map(|message| {
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
                                    s.terminal_notice = None;
                                    cx.stop_propagation();
                                    cx.notify();
                                }),
                            )
                            .child(vibevalley_i18n::t("desktop.terminal.dismiss", &[])),
                    )
            }))
            .children(launch)
    }
}
