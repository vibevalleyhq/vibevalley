use nsh_core::element::ImageSrc;
use nsh_core::prelude::*;
use vibevalley_i18n::t_in;

use crate::engine::whiteboard::{BoardAction, ExportFormat, STICKERS, StickerCategory, TemplateKind, Tool, ZOrderDir};
use crate::theme::AdaptiveUi;

use super::chrome::{ctx_item, floating_card, pill_text_btn};
use super::state::WbState;

// Template dropdown popover (top-left).
pub(super) fn build_template_popover(st: &WbState) -> impl IntoElement {
    let st = st.clone();
    dynamic(move || {
        if !st.template_picker_open.get() {
            return view().into_element();
        }
        let l = st.loc_str();
        let is_en = l.starts_with("en");
        let items = [
            (
                TemplateKind::Timeline,
                t_in(l.as_str(), "web.note.whiteboard.templateTimeline", &[]),
                "wb-tpl-timeline",
            ),
            (
                TemplateKind::Workshop,
                if is_en { "Launch Workshop" } else { "启动工作坊" }.to_owned(),
                "wb-tpl-workshop",
            ),
            (
                TemplateKind::Architecture,
                t_in(l.as_str(), "web.note.whiteboard.templateArchitecture", &[]),
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
                        let st = st.clone();
                        move |_: &PressEvent| st.run_action(BoardAction::ApplyTemplate(kind, is_en))
                    })
                    .child(text(name).text_size(px(12.0)).text_color(AdaptiveUi::INK)),
            );
        }
        view().absolute().top(px(56.0)).left(px(12.0)).child(panel).into_element()
    })
}

// 25 built-in pure-vector sticker picker popover.
pub(super) fn build_sticker_popover(st: &WbState) -> impl IntoElement {
    let st = st.clone();
    dynamic(move || {
        if !st.sticker_picker_open.get() {
            return view().into_element();
        }
        let l = st.loc_str();
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
                            let st = st.clone();
                            move |_: &PressEvent| st.set_tool(Tool::Sticker(sid.to_owned()))
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
}

// Right-click floating context menu.
pub(super) fn build_context_menu_overlay(st: &WbState) -> impl IntoElement {
    let st = st.clone();
    dynamic(move || {
        let Some(cm) = st.context_menu.get() else {
            return view().into_element();
        };
        let l = st.loc_str();
        let is_en = l.starts_with("en");
        let mut menu = floating_card().test_id("wb-context-menu").w(px(196.0)).p(px(5.0)).flex_col().gap(px(2.0));

        if cm.has_selection {
            menu = menu
                .child(ctx_item(if is_en { "Duplicate" } else { "复制所选" }, {
                    let st = st.clone();
                    move || st.run_action(BoardAction::DuplicateSelection)
                }))
                .child(ctx_item(if is_en { "Bring to Front" } else { "置于顶层" }, {
                    let st = st.clone();
                    move || st.run_action(BoardAction::Reorder(ZOrderDir::Front))
                }))
                .child(ctx_item(if is_en { "Send to Back" } else { "置于底层" }, {
                    let st = st.clone();
                    move || st.run_action(BoardAction::Reorder(ZOrderDir::Back))
                }))
                .child(ctx_item(if is_en { "Group" } else { "编组" }, {
                    let st = st.clone();
                    move || st.run_action(BoardAction::GroupSelection)
                }))
                .child(ctx_item(if is_en { "Ungroup" } else { "取消编组" }, {
                    let st = st.clone();
                    move || st.run_action(BoardAction::UngroupSelection)
                }))
                .child(ctx_item(if is_en { "Wrap in Section" } else { "包进分区容器" }, {
                    let st = st.clone();
                    move || st.run_action(BoardAction::WrapInContainer(if is_en { "Section" } else { "分区" }.to_owned()))
                }))
                .child(ctx_item(if is_en { "Delete" } else { "删除" }, {
                    let st = st.clone();
                    move || st.run_action(BoardAction::DeleteSelection)
                }));
        } else {
            menu = menu
                .child(ctx_item(if is_en { "Fit to Content" } else { "适应画布" }, {
                    let st = st.clone();
                    move || st.run_action(BoardAction::FitToContent)
                }))
                .child(ctx_item(if is_en { "Select All" } else { "全选元素" }, {
                    let st = st.clone();
                    move || st.run_action(BoardAction::SelectAll)
                }))
                .child(ctx_item(t_in(l.as_str(), "web.note.whiteboard.chatWithOrchestrator", &[]), {
                    let st = st.clone();
                    move || st.run_action(BoardAction::AskOrchestrator)
                }));
        }
        view().absolute().top(px(cm.y)).left(px(cm.x)).child(menu).into_element()
    })
}

// Empty-board starter card (when board has 0 elements).
pub(super) fn build_starter_overlay(st: &WbState) -> impl IntoElement {
    let st = st.clone();
    dynamic(move || {
        let snap = st.ui_snap.get();
        if snap.count > 0 || st.props.read_only.get() {
            return view().into_element();
        }
        let l = st.loc_str();
        let is_en = l.starts_with("en");
        floating_card()
            .test_id("wb-starter-card")
            .p(px(16.0))
            .w(px(360.0))
            .flex_col()
            .gap(px(10.0))
            .child(
                text(t_in(l.as_str(), "web.note.whiteboard.emptyHint", &[]))
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
                        &t_in(l.as_str(), "web.note.whiteboard.templateTimeline", &[]),
                        false,
                        false,
                        {
                            let st = st.clone();
                            move || st.run_action(BoardAction::ApplyTemplate(TemplateKind::Timeline, is_en))
                        },
                    ))
                    .child(pill_text_btn(
                        "wb-empty-workshop",
                        if is_en { "Workshop" } else { "启动工作坊" },
                        false,
                        false,
                        {
                            let st = st.clone();
                            move || st.run_action(BoardAction::ApplyTemplate(TemplateKind::Workshop, is_en))
                        },
                    ))
                    .child(pill_text_btn(
                        "wb-empty-arch",
                        &t_in(l.as_str(), "web.note.whiteboard.templateArchitecture", &[]),
                        false,
                        false,
                        {
                            let st = st.clone();
                            move || st.run_action(BoardAction::ApplyTemplate(TemplateKind::Architecture, is_en))
                        },
                    ))
                    .child(pill_text_btn(
                        "wb-empty-journey",
                        if is_en { "User Journey" } else { "用户旅程" },
                        false,
                        false,
                        {
                            let st = st.clone();
                            move || st.run_action(BoardAction::ApplyTemplate(TemplateKind::UserJourney, is_en))
                        },
                    ))
                    .child(pill_text_btn("wb-empty-quadrant", if is_en { "Quadrant" } else { "四象限" }, false, false, {
                        let st = st.clone();
                        move || st.run_action(BoardAction::ApplyTemplate(TemplateKind::Quadrant, is_en))
                    })),
            )
            .self_center()
            .into_element()
    })
}

pub(super) fn build_timer_popover(st: &WbState) -> impl IntoElement {
    let st = st.clone();
    dynamic(move || {
        if !st.timer_open.get() {
            return view().into_element();
        }
        let l = st.loc_str();
        let is_en = l.starts_with("en");
        let running = st.timer_running.get();
        let rem = st.timer_secs.get();
        let presets = [(3u32, "3m"), (5, "5m"), (10, "10m"), (15, "15m")];
        let mut preset_row = view().flex_row().gap(px(4.0));
        for (mins, lbl) in presets {
            let target_s = mins * 60;
            let timer_running = st.timer_running;
            let timer_secs = st.timer_secs;
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
        let timer_running = st.timer_running;
        let timer_secs = st.timer_secs;
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
        view().absolute().top(px(54.0)).right(px(12.0)).child(panel).into_element()
    })
}

pub(super) fn build_export_popover(st: &WbState) -> impl IntoElement {
    let st = st.clone();
    dynamic(move || {
        if !st.export_menu_open.get() {
            return view().into_element();
        }
        let l = st.loc_str();
        let is_en = l.starts_with("en");
        let mut panel = floating_card().test_id("wb-export-popover").w(px(164.0)).p(px(5.0)).flex_col().gap(px(2.0));
        let items = [
            ("wb-export-png", if is_en { "PNG (2x)" } else { "PNG 2x" }, ExportFormat::Png),
            ("wb-export-json", "JSON", ExportFormat::Json),
            ("wb-export-canvas", ".canvas", ExportFormat::JsonCanvas),
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
                        let st = st.clone();
                        move |_: &PressEvent| st.run_action(BoardAction::Export(fmt))
                    })
                    .child(text(label).text_size(px(12.0)).text_color(AdaptiveUi::INK)),
            );
        }
        view().absolute().top(px(54.0)).right(px(12.0)).child(panel).into_element()
    })
}
