use nsh_core::element::ImageSrc;
use nsh_core::prelude::*;
use vibevalley_i18n::t_in;

use crate::engine::whiteboard::{
    AlignOp, ArrowCurve, BoardAction, DistributeAxis, ExportFormat, GridStyle, Presence, StrokeStyle, WbFill, paint::parse_hex_hsla,
};
use crate::theme::AdaptiveUi;

use super::chrome::{ICON_REDO, ICON_TIMER, ICON_UNDO, floating_pill, pill_divider, pill_icon_btn, pill_text_btn, presence_adaptive_color_for};
use super::state::WbState;

pub(super) fn build_top_left_hud(st: &WbState) -> impl IntoElement {
    let st = st.clone();
    dynamic(move || {
        let snap = st.ui_snap.get();
        let ro = st.props.read_only.get();
        let l = st.loc_str();
        let is_en = l.starts_with("en");
        let count_txt = t_in(l.as_str(), "web.note.whiteboard.elements", &[("n", snap.count.into())]);

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
            .test_id("wb-top-left-hud")
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
                &t_in(l.as_str(), "web.note.whiteboard.undo", &[]),
                ICON_UNDO,
                false,
                !snap.can_undo || ro,
                {
                    let st = st.clone();
                    move || st.run_action(BoardAction::Undo)
                },
            ))
            .child(pill_icon_btn(
                "wb-redo",
                &t_in(l.as_str(), "web.note.whiteboard.redo", &[]),
                ICON_REDO,
                false,
                !snap.can_redo || ro,
                {
                    let st = st.clone();
                    move || st.run_action(BoardAction::Redo)
                },
            ))
            .child(pill_divider())
            .child(pill_text_btn("wb-grid-toggle", grid_lbl, false, false, {
                let st = st.clone();
                move || st.run_action(BoardAction::SetGrid(next_grid))
            }));

        if !ro {
            row = row.child(pill_divider()).child(pill_text_btn(
                "wb-template-trigger",
                if is_en { "Templates" } else { "模板" },
                st.template_picker_open.get(),
                false,
                {
                    let st = st.clone();
                    move || {
                        st.sticker_picker_open.set(false);
                        st.export_menu_open.set(false);
                        st.timer_open.set(false);
                        st.template_picker_open.set(!st.template_picker_open.get_untracked());
                    }
                },
            ));
        }
        view().absolute().top(px(12.0)).left(px(12.0)).child(row).into_element()
    })
}

pub(super) fn build_top_right_hud(st: &WbState) -> impl IntoElement {
    let st = st.clone();
    dynamic(move || {
        let snap = st.ui_snap.get();
        let l = st.loc_str();
        let is_en = l.starts_with("en");
        let mut row = floating_pill().test_id("wb-top-right-hud");

        // Live collaborator presence pills (deduplicated, capped at 3 for narrow viewports).
        if !snap.presences.is_empty() {
            let mut unique: Vec<&Presence> = Vec::with_capacity(snap.presences.len());
            for p in &snap.presences {
                if !unique.iter().any(|u| u.id == p.id) {
                    unique.push(p);
                }
            }
            let shown_limit = 3usize;
            for p in unique.iter().take(shown_limit) {
                let following = snap.follow_actor.as_deref() == Some(p.id.as_str());
                let pid = p.id.clone();
                let label = if following { format!("✓ {}", p.name) } else { p.name.clone() };
                let dot_color = presence_adaptive_color_for(p);
                let a11y_label = if following {
                    if is_en {
                        format!("Stop following {}", p.name)
                    } else {
                        format!("停止跟随 {}", p.name)
                    }
                } else if is_en {
                    format!("Follow {}", p.name)
                } else {
                    format!("跟随 {}", p.name)
                };
                row = row.child(
                    view()
                        .test_id(&format!("wb-presence-{}", p.id))
                        .role(AccessibilityRole::Button)
                        .label(SharedString::from(a11y_label))
                        .accessibility_state(AccessibilityState {
                            selected: following,
                            ..AccessibilityState::default()
                        })
                        .flex_row()
                        .items_center()
                        .gap(px(4.0))
                        .rounded(px(999.0))
                        .px(px(7.0))
                        .py(px(3.0))
                        .bg(if following { AdaptiveUi::SELECTED } else { AdaptiveUi::SIDE })
                        .border(px(1.0))
                        .border_color(if following { dot_color } else { AdaptiveUi::LINE })
                        .cursor_pointer()
                        .hover(|s| s.bg(AdaptiveUi::HOVER))
                        .on_press({
                            let st = st.clone();
                            move |_: &PressEvent| {
                                let next = if following { None } else { Some(pid.clone()) };
                                st.run_action(BoardAction::FollowActor(next));
                            }
                        })
                        .child(view().size(px(6.5)).rounded(px(999.0)).bg(dot_color))
                        .child(
                            text(label)
                                .text_size(px(11.0))
                                .font_weight(if following { FontWeight::SEMIBOLD } else { FontWeight::MEDIUM })
                                .text_color(AdaptiveUi::INK),
                        ),
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

        let rem = st.timer_secs.get();
        let t_active = st.timer_running.get() || st.timer_open.get();
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
                    .on_press({
                        let st = st.clone();
                        move |_: &PressEvent| {
                            st.sticker_picker_open.set(false);
                            st.template_picker_open.set(false);
                            st.export_menu_open.set(false);
                            st.timer_open.set(!st.timer_open.get_untracked());
                        }
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
                let st = st.clone();
                move || st.run_action(BoardAction::Export(ExportFormat::Svg))
            }))
            .child(
                pill_text_btn("wb-export-more", "⋯", st.export_menu_open.get(), false, {
                    let st = st.clone();
                    move || {
                        st.sticker_picker_open.set(false);
                        st.template_picker_open.set(false);
                        st.timer_open.set(false);
                        st.export_menu_open.set(!st.export_menu_open.get_untracked());
                    }
                })
                .label(SharedString::from(if is_en { "More exports" } else { "更多导出格式" })),
            )
            .child(pill_divider())
            .child(pill_text_btn(
                "wb-inspector-toggle",
                &t_in(l.as_str(), "web.note.whiteboard.inspector", &[]),
                st.inspector_open.get(),
                false,
                {
                    let inspector_open = st.inspector_open;
                    move || inspector_open.set(!inspector_open.get_untracked())
                },
            ));

        view().absolute().top(px(12.0)).right(px(12.0)).child(row).into_element()
    })
}

// Active Follow mode indicator banner (top-center, click anywhere on banner to exit Follow).
pub(super) fn build_follow_banner(st: &WbState) -> impl IntoElement {
    let st = st.clone();
    dynamic(move || {
        let snap = st.ui_snap.get();
        let Some(actor_id) = snap.follow_actor.as_deref() else {
            return view().into_element();
        };
        let followed = snap.presences.iter().find(|p| p.id == actor_id || p.name == actor_id);
        let display_name = followed.map_or(actor_id, |p| p.name.as_str());
        let dot_color = followed.map_or(AdaptiveUi::ACCENT, presence_adaptive_color_for);
        let is_en = st.loc_str().starts_with("en");
        let banner_text = if is_en {
            format!("Following {display_name} · Click to exit")
        } else {
            format!("正在跟随 {display_name} · 点击退出")
        };
        let pill = view()
            .test_id("wb-follow-banner")
            .role(AccessibilityRole::Button)
            .label(SharedString::from(banner_text.clone()))
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .rounded(px(999.0))
            .border(px(1.5))
            .border_color(dot_color)
            .bg(AdaptiveUi::PAGE)
            .px(px(12.0))
            .py(px(5.0))
            .shadow_md()
            .cursor_pointer()
            .hover(|s| s.bg(AdaptiveUi::HOVER))
            .on_press({
                let st = st.clone();
                move |_: &PressEvent| st.run_action(BoardAction::FollowActor(None))
            })
            .child(view().size(px(7.0)).rounded(px(999.0)).bg(dot_color))
            .child(
                text(banner_text)
                    .text_size(px(11.5))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(AdaptiveUi::INK),
            );
        view()
            .absolute()
            .top(px(12.0))
            .left(px(12.0))
            .right(px(12.0))
            .items_center()
            .pointer_events(PointerEvents::BoxNone)
            .child(pill)
            .into_element()
    })
}

// Contextual floating style bar when >=1 element is selected.
pub(super) fn build_style_bar(st: &WbState) -> impl IntoElement {
    let st = st.clone();
    dynamic(move || {
        let snap = st.ui_snap.get();
        if snap.selection.is_empty() || st.props.read_only.get() {
            return view().into_element();
        }
        let l = st.loc_str();
        let is_en = l.starts_with("en");
        let mut row = floating_pill().test_id("wb-style-bar").flex_wrap();

        // 8 warm editorial fills.
        for (fill, hex_light, tid, label_key) in [
            (WbFill::Default, "#fffdf9", "wb-fill-default", "web.note.whiteboard.fillDefault"),
            (WbFill::Sun, "#ffe57f", "wb-fill-sun", "web.note.whiteboard.fillSun"),
            (WbFill::Peach, "#f9ba7b", "wb-fill-peach", "web.note.whiteboard.fillPeach"),
            (WbFill::Leaf, "#cce6b6", "wb-fill-leaf", "web.note.whiteboard.fillLeaf"),
            (WbFill::Water, "#cde2f8", "wb-fill-water", "web.note.whiteboard.fillWater"),
            (WbFill::Lavender, "#dfd4f8", "wb-fill-lavender", "web.note.whiteboard.fillLavender"),
            (WbFill::Berry, "#f8d0ca", "wb-fill-berry", "web.note.whiteboard.fillBerry"),
            (WbFill::Side, "#f6f5f3", "wb-fill-side", "web.note.whiteboard.fillSide"),
        ] {
            let active = snap.selection_kind.fill.as_deref() == Some(fill.as_str());
            let swatch_color = parse_hex_hsla(hex_light).unwrap_or(white());
            row = row.child(
                view()
                    .test_id(tid)
                    .role(AccessibilityRole::Button)
                    .label(SharedString::from(t_in(l.as_str(), label_key, &[])))
                    .size(px(18.0))
                    .rounded(px(999.0))
                    .bg(AdaptiveColor {
                        light: swatch_color,
                        dark: swatch_color,
                    })
                    .border(px(if active { 2.0 } else { 1.0 }))
                    .border_color(if active { AdaptiveUi::ACCENT } else { AdaptiveUi::LINE })
                    .cursor_pointer()
                    .on_press({
                        let st = st.clone();
                        let f = fill.clone();
                        move |_: &PressEvent| st.run_action(BoardAction::SetFillSelection(f.clone()))
                    }),
            );
        }

        if snap.selection_kind.is_arrow {
            row = row.child(pill_divider());
            for (c, lbl, slug) in [
                (ArrowCurve::Smooth, t_in(l.as_str(), "web.note.whiteboard.curveSmooth", &[]), "smooth"),
                (ArrowCurve::Orthogonal, t_in(l.as_str(), "web.note.whiteboard.curveOrthogonal", &[]), "ortho"),
                (ArrowCurve::Straight, t_in(l.as_str(), "web.note.whiteboard.curveStraight", &[]), "straight"),
            ] {
                row = row.child(pill_text_btn(&format!("wb-curve-{slug}"), &lbl, snap.selection_kind.curve == Some(c), false, {
                    let st = st.clone();
                    move || st.run_action(BoardAction::SetArrowCurveSelection(c))
                }));
            }
            row = row.child(pill_divider());
            for (style, lbl, slug) in [
                (StrokeStyle::Solid, t_in(l.as_str(), "web.note.whiteboard.styleSolid", &[]), "solid"),
                (StrokeStyle::Dashed, t_in(l.as_str(), "web.note.whiteboard.styleDashed", &[]), "dashed"),
            ] {
                row = row.child(pill_text_btn(
                    &format!("wb-style-{slug}"),
                    &lbl,
                    snap.selection_kind.style == Some(style),
                    false,
                    {
                        let st = st.clone();
                        move || st.run_action(BoardAction::SetStrokeStyleSelection(style))
                    },
                ));
            }
        }

        if snap.selection.len() >= 2 {
            row = row
                .child(pill_divider())
                .child(pill_text_btn("wb-align-left", if is_en { "Align L" } else { "左对齐" }, false, false, {
                    let st = st.clone();
                    move || st.run_action(BoardAction::Align(AlignOp::Left))
                }))
                .child(pill_text_btn("wb-align-center", if is_en { "Center" } else { "居中" }, false, false, {
                    let st = st.clone();
                    move || st.run_action(BoardAction::Align(AlignOp::CenterH))
                }))
                .child(pill_text_btn("wb-dist-h", if is_en { "Dist" } else { "等距" }, false, false, {
                    let st = st.clone();
                    move || st.run_action(BoardAction::Distribute(DistributeAxis::Horizontal))
                }))
                .child(pill_text_btn("wb-tidy-grid", if is_en { "Tidy" } else { "整理" }, false, false, {
                    let st = st.clone();
                    move || st.run_action(BoardAction::TidyGrid)
                }));
        }

        row = row
            .child(pill_divider())
            .child(pill_text_btn(
                "wb-duplicate",
                &t_in(l.as_str(), "web.note.whiteboard.duplicate", &[]),
                false,
                false,
                {
                    let st = st.clone();
                    move || st.run_action(BoardAction::DuplicateSelection)
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
                    let st = st.clone();
                    move || st.run_action(BoardAction::ToggleLockSelection)
                },
            ))
            .child(pill_text_btn(
                "wb-delete",
                &t_in(l.as_str(), "web.note.whiteboard.deleteSelected", &[]),
                false,
                true,
                {
                    let st = st.clone();
                    move || st.run_action(BoardAction::DeleteSelection)
                },
            ));

        let minimap_reserve = if st.minimap_open.get() { 172.0 } else { 0.0 };
        view()
            .absolute()
            .bottom(px(56.0))
            .left(px(12.0))
            .right(px(12.0))
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .pointer_events(PointerEvents::BoxNone)
            .child(view().flex_1().min_w(px(0.0)).pointer_events(PointerEvents::BoxNone))
            .child(
                view()
                    .flex_shrink(1.0)
                    .min_w(px(0.0))
                    .flex_row()
                    .justify_center()
                    .pointer_events(PointerEvents::BoxNone)
                    .child(row),
            )
            .child(view().flex_1().min_w(px(minimap_reserve)).pointer_events(PointerEvents::BoxNone))
            .into_element()
    })
}
