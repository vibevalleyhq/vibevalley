use gpui::{AnyElement, App, Context, Hsla, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _, Styled as _, Window, div, px};
use serde_json::json;
use vibevalley_i18n::t;

use super::super::scene::DioramaAction;
use super::{DioramaEvent, DioramaView, SceneState};

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct HudPalette {
    pub dark: bool,
    pub surface: Hsla,
    pub border: Hsla,
    pub divider: Hsla,
    pub ink: Hsla,
    pub muted: Hsla,
    pub hover: Hsla,
    pub active_bg: Hsla,
    pub active_fg: Hsla,
    pub badge_dot: Hsla,
    pub badge_halo: Hsla,
    pub dot_vermilion: Hsla,
    pub dot_ochre: Hsla,
    pub dot_water: Hsla,
}

impl HudPalette {
    /// Selects a Papertrails warm-paper HUD surface for daytime light mode, and a
    /// deep translucent warm-charcoal surface whenever dark theme or night lighting is active.
    pub(super) fn for_scene(ui_dark: bool, tod: vibevalley_diorama::TimeOfDay) -> Self {
        if ui_dark || matches!(tod, vibevalley_diorama::TimeOfDay::Night) {
            Self::dark(&crate::theme::Palette::dark())
        } else {
            Self::light(&crate::theme::Palette::light())
        }
    }

    fn light(theme: &crate::theme::Palette) -> Self {
        Self {
            dark: false,
            surface: gpui::rgba(0xfbf7eeeb).into(),
            border: gpui::rgb(0xdfd4be).into(),
            divider: gpui::rgba(0x7c64473d).into(),
            ink: gpui::rgb(0x2f2318).into(),
            muted: gpui::rgb(0x6e5f4f).into(),
            hover: theme.hover,
            active_bg: theme.accent,
            active_fg: theme.on_accent,
            badge_dot: theme.danger,
            badge_halo: Hsla { a: 0.24, ..theme.danger },
            dot_vermilion: theme.danger,
            dot_ochre: theme.warning,
            dot_water: theme.info,
        }
    }

    fn dark(theme: &crate::theme::Palette) -> Self {
        Self {
            dark: true,
            surface: Hsla { a: 0.88, ..theme.elevated },
            border: Hsla { a: 0.16, ..theme.text },
            divider: Hsla { a: 0.16, ..theme.text },
            ink: theme.text,
            muted: theme.muted,
            hover: theme.hover,
            active_bg: theme.accent,
            active_fg: theme.on_accent,
            badge_dot: theme.danger,
            badge_halo: Hsla { a: 0.28, ..theme.danger },
            dot_vermilion: theme.danger,
            dot_ochre: theme.warning,
            dot_water: theme.info,
        }
    }

    pub(super) fn anchor_dot(&self, tone: &str) -> Hsla {
        match tone {
            "vermilion" => self.dot_vermilion,
            "ochre" => self.dot_ochre,
            _ => self.dot_water,
        }
    }
}

pub(super) const fn hud_tod_label_key(tod: vibevalley_diorama::TimeOfDay) -> &'static str {
    match tod {
        vibevalley_diorama::TimeOfDay::Dawn => "web.farm.hud.dawn",
        vibevalley_diorama::TimeOfDay::Noon => "web.farm.hud.noon",
        vibevalley_diorama::TimeOfDay::Dusk => "web.farm.hud.dusk",
        vibevalley_diorama::TimeOfDay::Night => "web.farm.hud.night",
    }
}

pub(super) const fn hud_cutaway_label_key(cutaway: bool) -> &'static str {
    if cutaway { "web.farm.hud.closeRoof" } else { "web.farm.hud.liftRoof" }
}

fn hud_divider(palette: &HudPalette) -> gpui::Div {
    div().w(px(1.0)).h(px(12.0)).mx(px(2.0)).bg(palette.divider)
}

fn phone_notification_dot(palette: &HudPalette) -> gpui::Div {
    div()
        .w(px(8.0))
        .h(px(8.0))
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .bg(palette.badge_halo)
        .child(div().w(px(5.0)).h(px(5.0)).rounded_full().bg(palette.badge_dot))
}

pub(super) fn resolve_dark(ui: Option<&crate::theme::Ui>, appearance: gpui::WindowAppearance) -> bool {
    ui.map_or_else(
        || matches!(appearance, gpui::WindowAppearance::Dark | gpui::WindowAppearance::VibrantDark),
        |ui| ui.colors.dark,
    )
}

pub(super) fn app_dark(window: &Window, cx: &App) -> bool {
    resolve_dark(cx.try_global::<crate::theme::Ui>(), window.appearance())
}

pub(super) fn motion_enabled(cx: &App) -> bool {
    cx.try_global::<crate::theme::Ui>()
        .is_none_or(|ui| ui.settings.effective_motion() != crate::theme::MotionChoice::Off)
}

/// Subtle Papertrails sprout emblem + slim progress track shown only when cold
/// diorama asset loading exceeds 150ms.
pub(super) fn diorama_loading_overlay() -> AnyElement {
    let leaf_hi = gpui::rgb(0x9ec867);
    let leaf_lo = gpui::rgb(0x6e9c3c);
    let stem = gpui::rgb(0x527a2d);
    let soil = gpui::rgb(0x5c4430);
    let sprout = div()
        .w(px(28.0))
        .h(px(24.0))
        .relative()
        .child(div().absolute().left(px(4.0)).top(px(4.0)).w(px(8.0)).h(px(5.0)).rounded(px(2.0)).bg(leaf_hi))
        .child(div().absolute().left(px(16.0)).top(px(2.0)).w(px(8.0)).h(px(5.0)).rounded(px(2.0)).bg(leaf_lo))
        .child(div().absolute().left(px(12.0)).top(px(7.0)).w(px(4.0)).h(px(11.0)).rounded(px(1.5)).bg(stem))
        .child(div().absolute().left(px(6.0)).top(px(18.0)).w(px(16.0)).h(px(4.0)).rounded(px(2.0)).bg(soil));
    div()
        .size_full()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(10.0))
        .child(sprout)
        .child(
            div()
                .w(px(120.0))
                .h(px(4.0))
                .rounded_full()
                .bg(gpui::rgba(0xfdf6e31f))
                .overflow_hidden()
                .child(div().w(px(52.0)).h_full().rounded_full().bg(leaf_hi)),
        )
        .child(
            div()
                .text_size(px(11.5))
                .text_color(gpui::rgba(0xfdf6e399))
                .child(t("web.farm.native.loading", &[])),
        )
        .into_any_element()
}

pub(super) fn phone_overlay_size(view_size: (f32, f32), phone: &super::super::phone::Phone) -> (f32, f32) {
    let (vw, vh) = view_size;
    let max_w = (vw - 28.0).max(220.0);
    let max_h = (vh - 76.0).max(220.0);
    let narrow = vw - 16.0 < 640.0;
    let chat_only = narrow && phone.unfolded;
    let game = phone.game && !chat_only;
    let chrome_h: f32 = if game { 90.0 } else { 34.0 };
    let preferred_screen_h: f32 = if phone.unfolded && phone.large {
        680.0
    } else if game || phone.unfolded || phone.ringing.is_some() {
        440.0
    } else {
        296.0
    };
    let h = (preferred_screen_h + chrome_h).min(max_h);
    let apps_w: f32 = if game {
        332.0
    } else if phone.unfolded {
        296.0
    } else {
        240.0
    };
    let preferred_w = if chat_only {
        max_w
    } else if phone.unfolded {
        24.0 + apps_w + 2.0 + if phone.large { (vw - 396.0).clamp(320.0, 560.0) } else { 320.0 }
    } else {
        24.0 + apps_w + 32.0
    };
    (preferred_w.min(max_w), h)
}

impl DioramaView {
    pub(super) fn render_hud(&mut self, window: &Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let SceneState::Ready(d) = &mut self.scene else {
            return None;
        };
        let active_tod = d.world.time_of_day;
        let cutaway = d.world.roof_cutaway_open();
        let focused_building = d
            .world
            .focused_building
            .as_ref()
            .and_then(|fid| d.world.buildings.iter().find(|b| &b.id == fid).map(|b| (b.label.clone(), b.opens.clone())));
        let anchors = d.anchors.clone();
        let (vw, vh) = self
            .bounds
            .get()
            .map(|b| (f32::from(b.size.width), f32::from(b.size.height)))
            .unwrap_or(d.view_size);
        let hovered_text = d.hovered.as_ref().map(|h| match h {
            vibevalley_diorama::DioramaHit::Plot { title, .. } => title.clone(),
            vibevalley_diorama::DioramaHit::Building { label, .. } => label.clone(),
            vibevalley_diorama::DioramaHit::Helper { name, .. } => name.clone(),
            vibevalley_diorama::DioramaHit::Prop { label, .. } => label.clone(),
            vibevalley_diorama::DioramaHit::Ground => String::new(),
        });
        let toast_text = d.active_toast().map(str::to_string);
        let has_missed = d.phone.ringing.is_some() || d.phone.missed(&d.frame.inbox).next().is_some();
        let shop_coins = d.frame.progress.as_ref().map_or(0, |p| p.coins);
        let daily_summary = d.frame.progress.as_ref().and_then(|p| p.daily.as_ref()).map(|board| {
            let done = board.tasks.iter().filter(|task| task.completed).count() as i64;
            (done, board.tasks.len() as i64)
        });

        let ui_dark = app_dark(window, cx);
        let palette = HudPalette::for_scene(ui_dark, active_tod);
        let hover_bg = palette.hover;

        let tod_buttons = [
            vibevalley_diorama::TimeOfDay::Dawn,
            vibevalley_diorama::TimeOfDay::Noon,
            vibevalley_diorama::TimeOfDay::Dusk,
            vibevalley_diorama::TimeOfDay::Night,
        ]
        .into_iter()
        .map(|tod| {
            let selected = active_tod == tod;
            let button = div()
                .px(px(7.0))
                .py(px(3.0))
                .rounded(px(6.0))
                .cursor_pointer()
                .text_size(px(11.5))
                .bg(if selected { palette.active_bg } else { gpui::rgba(0x00000000).into() })
                .text_color(if selected { palette.active_fg } else { palette.ink })
                .on_mouse_up(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |v, _, _, cx| {
                        cx.stop_propagation();
                        if let SceneState::Ready(d) = &mut v.scene {
                            d.set_time_of_day(tod, false);
                            cx.notify();
                        }
                    }),
                )
                .child(t(hud_tod_label_key(tod), &[]));
            if selected { button } else { button.hover(move |s| s.bg(hover_bg)) }
        });

        let cutaway_button = {
            let button = div()
                .px(px(7.0))
                .py(px(3.0))
                .rounded(px(6.0))
                .cursor_pointer()
                .text_size(px(11.5))
                .bg(if cutaway { palette.active_bg } else { gpui::rgba(0x00000000).into() })
                .text_color(if cutaway { palette.active_fg } else { palette.ink })
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|v, _, _, cx| {
                        cx.stop_propagation();
                        if let SceneState::Ready(d) = &mut v.scene {
                            d.toggle_cutaway();
                            cx.notify();
                        }
                    }),
                )
                .child(t(hud_cutaway_label_key(cutaway), &[]));
            if cutaway { button } else { button.hover(move |s| s.bg(hover_bg)) }
        };

        let toolbar = div()
            .flex()
            .items_center()
            .gap(px(4.0))
            .px(px(8.0))
            .py(px(4.0))
            .rounded(px(10.0))
            .bg(palette.surface)
            .border_1()
            .border_color(palette.border)
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_up(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .children(tod_buttons)
            .child(hud_divider(&palette))
            .child(cutaway_button)
            .child(hud_divider(&palette))
            .child(
                div()
                    .px(px(7.0))
                    .py(px(3.0))
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .text_size(px(11.5))
                    .text_color(palette.ink)
                    .hover(move |s| s.bg(hover_bg))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|v, _, _, cx| {
                            cx.stop_propagation();
                            if let SceneState::Ready(d) = &mut v.scene {
                                d.reset_camera();
                                cx.notify();
                            }
                        }),
                    )
                    .child(t("web.farm.hud.resetCamera", &[])),
            )
            .child(hud_divider(&palette))
            .child(
                div()
                    .px(px(7.0))
                    .py(px(3.0))
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .text_size(px(11.5))
                    .text_color(palette.ink)
                    .hover(move |s| s.bg(hover_bg))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|_, _, _, cx| {
                            cx.stop_propagation();
                            cx.emit(DioramaEvent::Route("/repos".into()));
                        }),
                    )
                    .child(t("web.farm.menu.repos", &[])),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(5.0))
                    .px(px(7.0))
                    .py(px(3.0))
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .text_size(px(11.5))
                    .text_color(palette.ink)
                    .hover(move |s| s.bg(hover_bg))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|v, _, _, cx| {
                            cx.stop_propagation();
                            if let SceneState::Ready(d) = &mut v.scene {
                                if d.phone.open {
                                    d.phone.close();
                                } else {
                                    d.phone.open = true;
                                }
                                cx.notify();
                            }
                        }),
                    )
                    .children(has_missed.then(|| phone_notification_dot(&palette)))
                    .child(t("web.farm.hud.phone", &[])),
            );

        let anchor_pills = anchors.into_iter().map(|anchor| {
            let dot = palette.anchor_dot(&anchor.tone);
            let left_px = (anchor.x * vw - 56.0).clamp(10.0, (vw - 140.0).max(10.0));
            let top_px = (anchor.y * vh - 14.0).clamp(48.0, (vh - 64.0).max(48.0));
            let clicked = anchor.clone();
            div()
                .absolute()
                .left(px(left_px))
                .top(px(top_px))
                .flex()
                .items_center()
                .gap(px(5.0))
                .px(px(8.0))
                .py(px(3.0))
                .rounded(px(8.0))
                .bg(palette.surface)
                .border_1()
                .border_color(palette.border)
                .cursor_pointer()
                .on_mouse_up(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |v, _, _, cx| {
                        cx.stop_propagation();
                        if let SceneState::Ready(d) = &mut v.scene {
                            let action = d.activate_anchor(&clicked);
                            v.taps.push(format!("{action:?}"));
                            v.dispatch_action(action, cx);
                        }
                    }),
                )
                .child(div().w(px(6.0)).h(px(6.0)).rounded_full().bg(dot))
                .child(div().text_size(px(11.0)).text_color(palette.ink).child(anchor.badge))
                .child(
                    div()
                        .text_size(px(11.0))
                        .text_color(palette.muted)
                        .max_w(px(110.0))
                        .overflow_hidden()
                        .child(anchor.label),
                )
        });

        let shop_pill = {
            let mut pill = div()
                .absolute()
                .top(px(12.0))
                .left(px(14.0))
                .flex()
                .items_center()
                .gap(px(8.0))
                .px(px(9.0))
                .py(px(4.0))
                .rounded(px(9.0))
                .bg(palette.surface)
                .border_1()
                .border_color(palette.border)
                .cursor_pointer()
                .hover(move |s| s.bg(hover_bg))
                .on_mouse_up(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|v, _, _, cx| {
                        cx.stop_propagation();
                        let req = match &v.scene {
                            SceneState::Ready(d) => json!({ "kind": "shop", "repo": d.repo }),
                            _ => return,
                        };
                        v.dispatch_action(DioramaAction::OpenForm(req), cx);
                    }),
                )
                .child(
                    div()
                        .text_size(px(11.5))
                        .text_color(palette.ink)
                        .child(t("web.farm.hud.coins", &[("n", shop_coins.into())])),
                );
            if let Some((done, total)) = daily_summary {
                pill = pill.child(hud_divider(&palette)).child(
                    div()
                        .text_size(px(11.5))
                        .text_color(palette.muted)
                        .child(t("web.farm.hud.daily", &[("done", done.into()), ("total", total.into())])),
                );
            }
            pill.child(hud_divider(&palette))
                .child(div().text_size(px(11.5)).text_color(palette.ink).child(t("web.farm.hud.shop", &[])))
        };

        let mut overlay = div()
            .absolute()
            .inset_0()
            .children(anchor_pills)
            .child(shop_pill)
            .child(div().absolute().top(px(12.0)).right(px(12.0)).child(toolbar));

        if let Some(msg) = toast_text.filter(|m| !m.is_empty()) {
            overlay = overlay.child(
                div()
                    .absolute()
                    .top(px(48.0))
                    .left(px(14.0))
                    .px(px(10.0))
                    .py(px(5.0))
                    .rounded(px(8.0))
                    .bg(palette.surface)
                    .border_1()
                    .border_color(palette.border)
                    .text_size(px(12.0))
                    .text_color(palette.ink)
                    .child(msg),
            );
        }

        if let Some(label) = hovered_text.filter(|s| !s.is_empty()) {
            overlay = overlay.child(
                div()
                    .absolute()
                    .bottom(px(14.0))
                    .left(px(14.0))
                    .px(px(9.0))
                    .py(px(4.0))
                    .rounded(px(8.0))
                    .bg(palette.surface)
                    .border_1()
                    .border_color(palette.border)
                    .text_size(px(11.5))
                    .text_color(palette.ink)
                    .child(label),
            );
        }

        if let Some((label, opens)) = focused_building {
            overlay = overlay.child(
                div()
                    .absolute()
                    .bottom(px(14.0))
                    .left(px((vw * 0.5 - 120.0).max(16.0)))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .px(px(10.0))
                    .py(px(5.0))
                    .rounded(px(10.0))
                    .bg(palette.surface)
                    .border_1()
                    .border_color(palette.border)
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_mouse_up(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(div().text_size(px(12.0)).text_color(palette.ink).child(label))
                    .child(
                        div()
                            .px(px(8.0))
                            .py(px(3.0))
                            .rounded(px(6.0))
                            .cursor_pointer()
                            .bg(palette.active_bg)
                            .text_color(palette.active_fg)
                            .text_size(px(11.5))
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(move |v, _, _, cx| {
                                    cx.stop_propagation();
                                    if let SceneState::Ready(d) = &mut v.scene {
                                        let action = d.dispatch_building_opens(&opens);
                                        v.dispatch_action(action, cx);
                                    }
                                }),
                            )
                            .child(t("web.farm.hud.enter", &[])),
                    )
                    .child(
                        div()
                            .px(px(8.0))
                            .py(px(3.0))
                            .rounded(px(6.0))
                            .cursor_pointer()
                            .text_color(palette.muted)
                            .hover(move |s| s.bg(hover_bg))
                            .text_size(px(11.5))
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(|v, _, _, cx| {
                                    cx.stop_propagation();
                                    if let SceneState::Ready(d) = &mut v.scene {
                                        d.exit_focus();
                                        cx.notify();
                                    }
                                }),
                            )
                            .child(t("web.farm.hud.backToYard", &[])),
                    ),
            );
        }

        Some(overlay.into_any_element())
    }
}
