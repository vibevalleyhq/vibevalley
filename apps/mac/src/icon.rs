//! Native GPUI bridge painting workbench reicon vectors from `vibevalley-rich`
//! plus shared GPUI chrome primitives (tooltips, icon buttons, editor popover).

use std::rc::Rc;
use std::time::Duration;

use gpui::{
    AnyElement, AnyView, App, AppContext as _, Bounds, Context, Div, ElementId, FillOptions, FillRule, FontWeight, Hsla, InteractiveElement as _, IntoElement,
    MouseButton, ParentElement as _, Path, PathBuilder, PathStyle, Pixels, Render, SharedString, Stateful, StatefulInteractiveElement as _, Styled as _,
    Window, canvas, div, hsla, point, px,
};
use vibevalley_rich::icon::{IconShape, Num, PathOp, icon_paths, icon_shapes};

use crate::host::{EditorOption, EditorTarget};
use crate::theme::Palette;

const ICON_VIEWBOX: f32 = 24.0;

/// Hover delay before native GPUI tooltips appear (matches TSX `Bubble`).
pub const TOOLTIP_SHOW_DELAY: Duration = Duration::from_millis(300);

fn transparent() -> Hsla {
    hsla(0.0, 0.0, 0.0, 0.0)
}

fn num(v: Num) -> f32 {
    match v {
        Num::Const(n) => n,
        Num::Slot(_) => 0.0,
    }
}

fn feed_ops(pb: &mut PathBuilder, ops: &[PathOp], x0: f32, y0: f32, scale: f32) {
    let pt = |x: f32, y: f32| point(px(x0 + x * scale), px(y0 + y * scale));
    for op in ops {
        match op {
            PathOp::MoveTo(x, y) => pb.move_to(pt(num(*x), num(*y))),
            PathOp::LineTo(x, y) => pb.line_to(pt(num(*x), num(*y))),
            PathOp::QuadTo([cx, cy, x, y]) => pb.curve_to(pt(num(*x), num(*y)), pt(num(*cx), num(*cy))),
            PathOp::CubicTo([x1, y1, x2, y2, x, y]) => pb.cubic_bezier_to(pt(num(*x), num(*y)), pt(num(*x1), num(*y1)), pt(num(*x2), num(*y2))),
            PathOp::Rect([x, y, w, h]) => {
                let (rx, ry, rw, rh) = (num(*x), num(*y), num(*w), num(*h));
                pb.move_to(pt(rx, ry));
                pb.line_to(pt(rx + rw, ry));
                pb.line_to(pt(rx + rw, ry + rh));
                pb.line_to(pt(rx, ry + rh));
                pb.close();
            }
            PathOp::Close => pb.close(),
            PathOp::Arc { .. } | PathOp::ArcTo(_) | PathOp::Ellipse { .. } | PathOp::RoundRect(_, _) => {}
        }
    }
}

fn build_shape_paths(shapes: &[IconShape], paths: &[vibevalley_rich::icon::Path], bounds: Bounds<Pixels>, color: Hsla) -> Vec<(Path, Hsla)> {
    let w = f32::from(bounds.size.width);
    let h = f32::from(bounds.size.height);
    let side = w.min(h);
    if !side.is_finite() || side <= 0.0 {
        return Vec::new();
    }
    let x0 = f32::from(bounds.origin.x) + (w - side) * 0.5;
    let y0 = f32::from(bounds.origin.y) + (h - side) * 0.5;
    let scale = side / ICON_VIEWBOX;
    let mut out = Vec::with_capacity(shapes.len());

    for (shape, ops) in shapes.iter().zip(paths.iter()) {
        let paint_color = match shape.opacity {
            Some(alpha) => Hsla {
                a: color.a * alpha.clamp(0.0, 1.0),
                ..color
            },
            None => color,
        };
        if shape.fill {
            let rule = if shape.evenodd { FillRule::EvenOdd } else { FillRule::NonZero };
            let mut pb = PathBuilder::fill().with_style(PathStyle::Fill(FillOptions { fill_rule: rule }));
            feed_ops(&mut pb, ops, x0, y0, scale);
            if let Ok(built) = pb.build() {
                out.push((built, paint_color));
            }
        }
        if let Some(width) = shape.stroke
            && width > 0.0
        {
            let stroke_width = width * scale;
            let mut pb = PathBuilder::stroke(px(stroke_width));
            feed_ops(&mut pb, ops, x0, y0, scale);
            if let Ok(built) = pb.build() {
                out.push((built, paint_color));
            }
        }
    }
    out
}

/// Paints a registered `vibevalley-rich` reicon vector directly onto a GPUI `canvas`.
pub fn gpui_icon(name: &str, size: f32, color: Hsla) -> AnyElement {
    let sz = if size.is_finite() && size > 0.0 { size } else { 0.0 };
    let (Some(shapes), Some(paths)) = (icon_shapes(name), icon_paths(name)) else {
        return div().size(px(sz)).flex_none().into_any_element();
    };
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            for (path, paint_color) in build_shape_paths(shapes, paths, bounds, color) {
                window.paint_path(path, paint_color);
            }
        },
    )
    .size(px(sz))
    .flex_none()
    .into_any_element()
}

/// Lightweight GPUI tooltip view styled like TSX `Bubble` (compact ink pill, inverse text).
#[derive(Clone)]
pub struct TooltipView {
    text: SharedString,
    bg: Hsla,
    border: Hsla,
    text_color: Hsla,
}

impl TooltipView {
    pub fn new(text: impl Into<SharedString>, colors: &Palette) -> Self {
        Self {
            text: text.into(),
            bg: colors.text,
            border: Hsla { a: 0.14, ..colors.bg },
            text_color: colors.bg,
        }
    }
}

impl Render for TooltipView {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .px(px(8.0))
            .py(px(4.0))
            .rounded(px(6.0))
            .border_1()
            .border_color(self.border)
            .bg(self.bg)
            .shadow_md()
            .text_size(px(11.5))
            .font_weight(FontWeight::MEDIUM)
            .whitespace_nowrap()
            .text_color(self.text_color)
            .child(self.text.clone())
    }
}

/// Builds a GPUI `.tooltip(...)` closure rendering a `Bubble`-styled pill.
pub fn gpui_tooltip(text: impl Into<SharedString>, colors: &Palette) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let view = TooltipView::new(text, colors);
    move |_, cx| {
        let view = view.clone();
        cx.new(move |_| view).into()
    }
}

/// Fixed 24x24 zero-layout-shift toolbar icon button with a 300ms hover tooltip.
pub fn icon_button(id: impl Into<ElementId>, icon_name: &'static str, tooltip: impl Into<SharedString>, active: bool, colors: &Palette) -> Stateful<Div> {
    let hover = colors.hover;
    let base = div()
        .id(id)
        .size(px(24.0))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(5.0))
        .border_1()
        .cursor_pointer()
        .tooltip(gpui_tooltip(tooltip, colors))
        .tooltip_show_delay(TOOLTIP_SHOW_DELAY);
    if active {
        base.bg(colors.selected)
            .border_color(colors.border)
            .hover(move |s| s.bg(hover))
            .child(gpui_icon(icon_name, 13.5, colors.accent))
    } else {
        base.bg(transparent())
            .border_color(transparent())
            .hover(move |s| s.bg(hover))
            .child(gpui_icon(icon_name, 13.5, colors.muted))
    }
}

/// Fixed 24x24 zero-layout-shift destructive icon button with danger hover tint.
#[allow(dead_code, reason = "shared toolbar primitive for standard-size destructive icon actions")]
pub fn icon_button_danger(id: impl Into<ElementId>, icon_name: &'static str, tooltip: impl Into<SharedString>, colors: &Palette) -> Stateful<Div> {
    let hover_bg = colors.removed_bg;
    let hover_border = Hsla { a: 0.35, ..colors.danger };
    div()
        .id(id)
        .size(px(24.0))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(5.0))
        .border_1()
        .bg(transparent())
        .border_color(transparent())
        .cursor_pointer()
        .hover(move |s| s.bg(hover_bg).border_color(hover_border))
        .tooltip(gpui_tooltip(tooltip, colors))
        .tooltip_show_delay(TOOLTIP_SHOW_DELAY)
        .child(gpui_icon(icon_name, 13.5, colors.danger))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactIconTone {
    Default,
    Accent,
    Danger,
    Disabled,
}

/// Compact 20x20 zero-layout-shift icon button for dense rows (e.g. diff hunk headers).
pub fn compact_icon_button(
    id: impl Into<ElementId>,
    icon_name: &'static str,
    tooltip: impl Into<SharedString>,
    tone: CompactIconTone,
    colors: &Palette,
) -> Stateful<Div> {
    let base = div()
        .id(id)
        .size(px(20.0))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(4.0))
        .border_1()
        .bg(transparent())
        .border_color(transparent())
        .tooltip(gpui_tooltip(tooltip, colors))
        .tooltip_show_delay(TOOLTIP_SHOW_DELAY);
    match tone {
        CompactIconTone::Default => {
            let hover = colors.hover;
            base.cursor_pointer()
                .hover(move |s| s.bg(hover))
                .child(gpui_icon(icon_name, 12.0, colors.muted))
        }
        CompactIconTone::Accent => {
            let hover_bg = colors.added_bg;
            let hover_border = Hsla { a: 0.35, ..colors.accent };
            base.cursor_pointer()
                .hover(move |s| s.bg(hover_bg).border_color(hover_border))
                .child(gpui_icon(icon_name, 12.0, colors.accent))
        }
        CompactIconTone::Danger => {
            let hover_bg = colors.removed_bg;
            let hover_border = Hsla { a: 0.35, ..colors.danger };
            base.cursor_pointer()
                .hover(move |s| s.bg(hover_bg).border_color(hover_border))
                .child(gpui_icon(icon_name, 12.0, colors.danger))
        }
        CompactIconTone::Disabled => base.child(gpui_icon(icon_name, 12.0, colors.faint)),
    }
}

/// Compact icon + downward caret trigger for toolbar popover menus (e.g. "Open in editor…").
pub fn icon_caret_button(id: impl Into<ElementId>, icon_name: &'static str, tooltip: impl Into<SharedString>, open: bool, colors: &Palette) -> Stateful<Div> {
    let hover = colors.hover;
    let base = div()
        .id(id)
        .h(px(24.0))
        .px(px(5.0))
        .flex_none()
        .flex()
        .flex_row()
        .items_center()
        .justify_center()
        .gap(px(2.0))
        .rounded(px(5.0))
        .border_1()
        .cursor_pointer()
        .tooltip(gpui_tooltip(tooltip, colors))
        .tooltip_show_delay(TOOLTIP_SHOW_DELAY);
    if open {
        base.bg(colors.selected)
            .border_color(colors.border)
            .hover(move |s| s.bg(hover))
            .child(gpui_icon(icon_name, 13.5, colors.accent))
            .child(gpui_icon("choose", 9.0, colors.accent))
    } else {
        base.bg(transparent())
            .border_color(transparent())
            .hover(move |s| s.bg(hover))
            .child(gpui_icon(icon_name, 13.5, colors.muted))
            .child(gpui_icon("choose", 9.0, colors.faint))
    }
}

type EditorSelectCallback = Rc<dyn Fn(EditorTarget, &mut Window, &mut App)>;

/// Shared native GPUI popover listing detected GUI editors, divider, Terminal (`$EDITOR`), and Default App.
pub fn editor_popover(
    id: &'static str,
    options: &[EditorOption],
    colors: &Palette,
    on_select: impl Fn(EditorTarget, &mut Window, &mut App) + 'static,
    on_dismiss: impl Fn(&mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let hover_bg = colors.hover;
    let on_select: EditorSelectCallback = Rc::new(on_select);
    let gui_options: Vec<(usize, &EditorOption)> = options.iter().enumerate().filter(|(_, opt)| opt.target.is_gui()).collect();
    let fallback_options: Vec<(usize, &EditorOption)> = options.iter().enumerate().filter(|(_, opt)| !opt.target.is_gui()).collect();

    let build_row = |idx: usize, opt: &EditorOption, icon_name: &'static str, icon_color: Hsla| {
        let on_select = on_select.clone();
        let target = opt.target.clone();
        let label = opt.label.clone();
        let subtitle = opt.subtitle.clone();
        div()
            .id((id, idx))
            .h(px(28.0))
            .px(px(8.0))
            .rounded(px(6.0))
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(8.0))
            .text_size(px(12.5))
            .text_color(colors.text)
            .cursor_pointer()
            .hover(move |s| s.bg(hover_bg))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .child(gpui_icon(icon_name, 13.0, icon_color))
                    .child(label),
            )
            .children(subtitle.map(|sub| div().text_size(px(11.0)).text_color(colors.faint).child(sub)))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(move |_, window, cx| on_select(target.clone(), window, cx))
    };

    let mut panel = div()
        .id(id)
        .absolute()
        .top(px(36.0))
        .right(px(10.0))
        .w(px(224.0))
        .p(px(4.0))
        .rounded(px(8.0))
        .border_1()
        .border_color(colors.border)
        .bg(colors.elevated)
        .shadow_lg()
        .flex()
        .flex_col()
        .gap(px(2.0))
        .occlude()
        .on_mouse_down_out(move |_, window, cx| on_dismiss(window, cx))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation());

    if !gui_options.is_empty() {
        for (idx, opt) in gui_options {
            panel = panel.child(build_row(idx, opt, "open", colors.accent));
        }
        panel = panel.child(div().my(px(2.0)).mx(px(4.0)).h(px(1.0)).bg(colors.border));
    }

    for (idx, opt) in fallback_options {
        let icon_name = match opt.target {
            EditorTarget::TerminalEditor => "terminal",
            EditorTarget::DefaultApp | EditorTarget::Cursor { .. } | EditorTarget::VsCode { .. } | EditorTarget::Zed { .. } => "open",
        };
        panel = panel.child(build_row(idx, opt, icon_name, colors.muted));
    }

    panel
}

#[cfg(test)]
mod tests {
    use gpui::{Bounds, Hsla, point, px, size};
    use vibevalley_rich::icon::{ICON_NAMES, icon_paths, icon_shapes};

    use crate::theme::Palette;

    use super::{TOOLTIP_SHOW_DELAY, TooltipView, build_shape_paths};

    #[test]
    fn all_registered_icons_tessellate_into_gpui_paths() {
        let bounds = Bounds::new(point(px(0.0), px(0.0)), size(px(14.0), px(14.0)));
        let color = Hsla::white();
        for &name in ICON_NAMES {
            let shapes = icon_shapes(name).expect("shape");
            let paths = icon_paths(name).expect("path");
            let built = build_shape_paths(shapes, paths, bounds, color);
            assert!(!built.is_empty(), "icon `{name}` produced zero GPUI paths");
        }
    }

    #[test]
    fn tooltip_uses_inverse_palette_and_300ms_delay() {
        let dark = Palette::dark();
        let tip = TooltipView::new("Preview Markdown", &dark);
        assert_eq!(tip.text.as_ref(), "Preview Markdown");
        assert_eq!(tip.bg, dark.text);
        assert_eq!(tip.text_color, dark.bg);
        assert!((tip.border.a - 0.14).abs() < 1e-6);

        let light = Palette::light();
        let light_tip = TooltipView::new("View source", &light);
        assert_eq!(light_tip.bg, light.text);
        assert_eq!(light_tip.text_color, light.bg);
        assert_eq!(TOOLTIP_SHOW_DELAY.as_millis(), 300);
    }

    #[test]
    fn toolbar_icon_names_are_all_registered() {
        for name in [
            "show",
            "copy",
            "check",
            "refresh",
            "folder",
            "open",
            "choose",
            "terminal",
            "plug",
            "ticked",
            "file",
            "collapseAll",
            "expandAll",
            "add",
            "minus",
            "undo",
            "close",
            "sidebar",
            "sidebarRight",
        ] {
            assert!(icon_shapes(name).is_some(), "missing icon shape for `{name}`");
            assert!(icon_paths(name).is_some(), "missing icon paths for `{name}`");
        }
    }
}
