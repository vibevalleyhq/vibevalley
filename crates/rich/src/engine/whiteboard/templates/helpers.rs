use crate::engine::whiteboard::model::{
    AnchorSide, ArrowCurve, ArrowEndpoint, ArrowHead, ElementId, ElementKind, ElementRecord, Point2, Rect2, ShapeKind, StrokeStyle, TextAlign, TextVariant,
    WbFill,
};

pub(super) fn card(id: &str, rect: Rect2, title: &str, body: &str, fill: WbFill, sticker: Option<&str>) -> ElementRecord {
    ElementRecord::new(
        id,
        ElementKind::Shape {
            x: rect.x,
            y: rect.y,
            w: rect.w,
            h: rect.h,
            shape: ShapeKind::Card,
            title: title.to_owned(),
            body: body.to_owned(),
            fill,
            stroke: None,
            stroke_style: StrokeStyle::Solid,
            corner_radius: None,
            sticker: sticker.map(str::to_owned),
            sticker_svg: None,
            badge: None,
            align: TextAlign::Center,
        },
    )
}

pub(super) fn title_el(id: &str, x: f64, y: f64, text: &str) -> ElementRecord {
    ElementRecord::new(
        id,
        ElementKind::Text {
            x,
            y,
            w: 680.0,
            h: 48.0,
            variant: TextVariant::Title,
            label: text.to_owned(),
            highlight: None,
            icon: None,
            align: TextAlign::Left,
            font_size: None,
            fill: None,
            color: None,
        },
    )
}

pub(super) fn subtitle_el(id: &str, x: f64, y: f64, text: &str, highlight: &str) -> ElementRecord {
    ElementRecord::new(
        id,
        ElementKind::Text {
            x,
            y,
            w: 700.0,
            h: 28.0,
            variant: TextVariant::Subtitle,
            label: text.to_owned(),
            highlight: Some(highlight.to_owned()),
            icon: None,
            align: TextAlign::Left,
            font_size: None,
            fill: None,
            color: None,
        },
    )
}

pub(super) fn stem_arrow(id: &str, from_id: &str, side: AnchorSide, to: Point2) -> ElementRecord {
    ElementRecord::new(
        id,
        ElementKind::Arrow {
            from: ArrowEndpoint::Bound {
                id: ElementId::new(from_id),
                side: Some(side),
            },
            to: ArrowEndpoint::Free(to),
            bends: Vec::new(),
            curve: ArrowCurve::Straight,
            style: StrokeStyle::Solid,
            start_head: ArrowHead::None,
            end_head: ArrowHead::None,
            stroke: Some("#c96e52".to_owned()),
            stroke_width: 1.6,
            label: None,
        },
    )
}

pub(super) fn sticky_el(id: &str, rect: Rect2, title: &str, fill: WbFill) -> ElementRecord {
    ElementRecord::new(
        id,
        ElementKind::Shape {
            x: rect.x,
            y: rect.y,
            w: rect.w,
            h: rect.h,
            shape: ShapeKind::Sticky,
            title: title.to_owned(),
            body: String::new(),
            fill,
            stroke: None,
            stroke_style: StrokeStyle::Solid,
            corner_radius: None,
            sticker: None,
            sticker_svg: None,
            badge: None,
            align: TextAlign::Center,
        },
    )
}

pub(super) fn pill_el(id: &str, rect: Rect2, title: &str, fill: WbFill, rounded_bar: bool) -> ElementRecord {
    ElementRecord::new(
        id,
        ElementKind::Shape {
            x: rect.x,
            y: rect.y,
            w: rect.w,
            h: rect.h,
            shape: if rounded_bar { ShapeKind::Rounded } else { ShapeKind::Pill },
            title: title.to_owned(),
            body: String::new(),
            fill,
            stroke: None,
            stroke_style: StrokeStyle::Solid,
            corner_radius: None,
            sticker: None,
            sticker_svg: None,
            badge: None,
            align: TextAlign::Center,
        },
    )
}

pub(super) fn connector_arrow(id: &str, from_id: &str, from_side: AnchorSide, to_id: &str, to_side: AnchorSide, head: ArrowHead) -> ElementRecord {
    ElementRecord::new(
        id,
        ElementKind::Arrow {
            from: ArrowEndpoint::Bound {
                id: ElementId::new(from_id),
                side: Some(from_side),
            },
            to: ArrowEndpoint::Bound {
                id: ElementId::new(to_id),
                side: Some(to_side),
            },
            bends: Vec::new(),
            curve: ArrowCurve::Straight,
            style: StrokeStyle::Solid,
            start_head: ArrowHead::None,
            end_head: head,
            stroke: Some("#4a4540".to_owned()),
            stroke_width: 1.5,
            label: None,
        },
    )
}
