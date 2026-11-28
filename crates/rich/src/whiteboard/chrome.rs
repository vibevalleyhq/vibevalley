use nsh_core::element::ImageSrc;
use nsh_core::prelude::*;

use crate::engine::whiteboard::{Presence, PresenceColor, paint::parse_hex_hsla};
use crate::theme::AdaptiveUi;

pub(super) fn sanitize_filename(raw: &str) -> String {
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

pub(super) fn presence_adaptive_color_for(p: &Presence) -> AdaptiveColor {
    if let Some(hex) = p.custom_color.as_deref()
        && let Some(hsla) = parse_hex_hsla(hex)
    {
        return AdaptiveColor { light: hsla, dark: hsla };
    }
    let hex_l = match p.color {
        PresenceColor::Coral => "#dd6f57",
        PresenceColor::Teal => "#1a7f74",
        PresenceColor::Blue => "#2c6aa3",
        PresenceColor::Leaf => "#4d7a2a",
        PresenceColor::Wheat => "#c48b20",
        PresenceColor::Lavender => "#7c52a8",
    };
    let hsla = parse_hex_hsla(hex_l).unwrap_or(black());
    AdaptiveColor { light: hsla, dark: hsla }
}

pub(super) fn floating_pill() -> View {
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

pub(super) fn floating_card() -> View {
    view()
        .rounded(px(12.0))
        .border(px(1.0))
        .border_color(AdaptiveUi::LINE)
        .bg(AdaptiveUi::PAGE)
        .shadow_lg()
}

pub(super) fn pill_divider() -> View {
    view().w(px(1.0)).h(px(16.0)).mx(px(2.0)).bg(AdaptiveUi::LINE)
}

pub(super) fn pill_text_btn(tid: &str, label: &str, active: bool, danger: bool, on_press: impl Fn() + 'static) -> View {
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

pub(super) fn pill_icon_btn(tid: &str, label: &str, icon_svg: &'static str, active: bool, disabled: bool, on_press: impl Fn() + 'static) -> View {
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

pub(super) fn ctx_item(label: impl Into<String>, on_press: impl Fn() + 'static) -> AnyElement {
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

pub(super) const ICON_CURSOR: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4l13 7-6 2-3 6z"/></svg>"#;
pub(super) const ICON_HAND: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v7M10 10V5a2 2 0 0 0-4 0v9l-1.5-1.5a2 2 0 0 0-2.8 2.8L6.5 20a4 4 0 0 0 2.8 1.2H15a4 4 0 0 0 4-4v-6a2 2 0 0 0-1-1.7z"/></svg>"#;
pub(super) const ICON_TEXT: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6h14M12 6v13M9 19h6"/></svg>"#;
pub(super) const ICON_FRAME: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h16M4 15h16M9 4v16M15 4v16"/></svg>"#;
pub(super) const ICON_CARD: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M14 20v-5h5"/></svg>"#;
pub(super) const ICON_STICKY: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 10h8M8 14h5"/></svg>"#;
pub(super) const ICON_TIMER: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.5M9.5 3h5M12 3v2"/></svg>"#;
pub(super) const ICON_RECT: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"/></svg>"#;
pub(super) const ICON_ARROW: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19L19 5M11 5h8v8"/></svg>"#;
pub(super) const ICON_TIMELINE: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16c4-6 14 2 18-8"/><circle cx="6" cy="14" r="2"/><circle cx="18" cy="10" r="2"/></svg>"#;
pub(super) const ICON_TABLE: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M9 5v14M15 5v14"/></svg>"#;
pub(super) const ICON_PEN: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4l6 6-10 10H4v-6z"/></svg>"#;
pub(super) const ICON_HIGHLIGHTER: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l-5 5v4h4l5-5M15 5l4 4-6 6-4-4z"/></svg>"#;
pub(super) const ICON_ERASER: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 21h10M5.5 14.5l8-8a2.1 2.1 0 0 1 3 0l3 3a2.1 2.1 0 0 1 0 3l-6 6H7z"/></svg>"#;
pub(super) const ICON_STICKER: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M8.5 14.5c1 1.8 6 1.8 7 0"/></svg>"#;
pub(super) const ICON_UNDO: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14l-5-5 5-5M4 9h10a6 6 0 0 1 0 12h-3"/></svg>"#;
pub(super) const ICON_REDO: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3"/></svg>"#;
