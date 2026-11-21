use crate::IconResolver;
use crate::svg::builder::{label_svg, num};
use crate::svg::theme::SvgTheme;
use crate::text::label::Label;

const PAD_X: f64 = 16.0;
const PAD_Y: f64 = 10.0;
const GLYPH: f64 = 34.0;
const GLYPH_GAP: f64 = 4.0;
const STACK: f64 = 5.0;
const CAP: f64 = 6.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActorKind {
    Participant,
    Actor,
    Boundary,
    Control,
    Entity,
    Database,
    Collections,
    Queue,
}

impl ActorKind {
    pub fn from_str_or_default(raw: &str) -> Self {
        match raw {
            "actor" => Self::Actor,
            "boundary" => Self::Boundary,
            "control" => Self::Control,
            "entity" => Self::Entity,
            "database" => Self::Database,
            "collections" => Self::Collections,
            "queue" => Self::Queue,
            _ => Self::Participant,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Participant => "participant",
            Self::Actor => "actor",
            Self::Boundary => "boundary",
            Self::Control => "control",
            Self::Entity => "entity",
            Self::Database => "database",
            Self::Collections => "collections",
            Self::Queue => "queue",
        }
    }

    pub const fn is_figure(self) -> bool {
        match self {
            Self::Actor | Self::Boundary | Self::Control | Self::Entity | Self::Database => true,
            Self::Participant | Self::Collections | Self::Queue => false,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ActorSize {
    pub w: f64,
    pub h: f64,
}

pub fn actor_size(kind: ActorKind, label: &Label, min_w: f64, min_h: f64, padding_x: Option<f64>) -> ActorSize {
    let pad_x = padding_x.unwrap_or(PAD_X);
    if kind.is_figure() {
        return ActorSize {
            w: 40.0f64.max(label.width + 8.0),
            h: GLYPH + if label.height > 0.0 { GLYPH_GAP + label.height } else { 0.0 },
        };
    }
    let extra = match kind {
        ActorKind::Collections => STACK,
        ActorKind::Queue => 2.0 * CAP,
        ActorKind::Participant | ActorKind::Actor | ActorKind::Boundary | ActorKind::Control | ActorKind::Entity | ActorKind::Database => 0.0,
    };
    ActorSize {
        w: min_w.max(label.width + 2.0 * pad_x) + extra,
        h: min_h.max(label.height + 2.0 * PAD_Y) + if kind == ActorKind::Collections { STACK } else { 0.0 },
    }
}

fn draw_figure(kind: ActorKind, cx: f64, top: f64, theme: &SvgTheme) -> String {
    let shape = theme.shape_attrs();
    let line = format!(r#" fill="none" stroke="{}""#, theme.border());
    let x = num(cx);
    let y = |dy: f64| -> String { num(top + dy) };
    match kind {
        ActorKind::Actor => format!(
            r#"<circle cx="{x}" cy="{}" r="6"{shape}/><path d="M{x},{}V{}M{},{}H{}M{},{}L{x},{}L{},{}"{line}/>"#,
            y(7.0),
            y(13.0),
            y(24.0),
            num(cx - 10.0),
            y(17.0),
            num(cx + 10.0),
            num(cx - 8.0),
            y(34.0),
            y(24.0),
            num(cx + 8.0),
            y(34.0),
        ),
        ActorKind::Boundary => format!(
            r#"<path d="M{},{}V{}M{},{}H{}"{line}/><circle cx="{}" cy="{}" r="11"{shape}/>"#,
            num(cx - 19.0),
            y(6.0),
            y(28.0),
            num(cx - 19.0),
            y(17.0),
            num(cx - 8.0),
            num(cx + 3.0),
            y(17.0),
        ),
        ActorKind::Control => format!(
            r#"<circle cx="{x}" cy="{}" r="11"{shape}/><path d="M{},{}L{},{}L{},{}"{line}/>"#,
            y(21.0),
            num(cx + 5.0),
            y(5.0),
            num(cx - 1.0),
            y(10.0),
            num(cx + 5.0),
            y(15.0),
        ),
        ActorKind::Entity => format!(
            r#"<circle cx="{x}" cy="{}" r="11"{shape}/><path d="M{},{}H{}"{line}/>"#,
            y(15.0),
            num(cx - 11.0),
            y(30.0),
            num(cx + 11.0),
        ),
        ActorKind::Database | ActorKind::Participant | ActorKind::Collections | ActorKind::Queue => {
            let l = num(cx - 14.0);
            let r = num(cx + 14.0);
            format!(
                r#"<path d="M{l},{}V{}A14,5 0 0 0 {r},{}V{}A14,5 0 0 0 {l},{}Z"{shape}/><path d="M{l},{}A14,5 0 0 0 {r},{}"{line}/>"#,
                y(7.0),
                y(27.0),
                y(27.0),
                y(7.0),
                y(7.0),
                y(7.0),
                y(7.0),
            )
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn draw_actor(kind: ActorKind, cx: f64, top: f64, size: ActorSize, label: &Label, theme: &SvgTheme, icons: Option<&IconResolver<'_>>, ink: &str) -> String {
    let shape = theme.shape_attrs();
    let line = format!(r#" fill="none" stroke="{}""#, theme.border());
    let rounded = theme.rounded_standalone();
    let text_cls = r#" class="pele-label""#;
    if kind.is_figure() {
        return format!(
            "{}{}",
            draw_figure(kind, cx, top, theme),
            label_svg(
                label,
                cx,
                top + GLYPH + GLYPH_GAP + label.height / 2.0,
                &format!("{text_cls}{ink}"),
                theme,
                icons,
            )
        );
    }
    let left = cx - size.w / 2.0;
    match kind {
        ActorKind::Collections => {
            let bw = size.w - STACK;
            let bh = size.h - STACK;
            format!(
                r#"<rect x="{}" y="{}" width="{}" height="{}"{shape}{rounded}/><rect x="{}" y="{}" width="{}" height="{}"{shape}{rounded}/>{}"#,
                num(left + STACK),
                num(top),
                num(bw),
                num(bh),
                num(left),
                num(top + STACK),
                num(bw),
                num(bh),
                label_svg(label, left + bw / 2.0, top + STACK + bh / 2.0, text_cls, theme, icons,),
            )
        }
        ActorKind::Queue => {
            let l = num(left + CAP);
            let r = num(left + size.w - CAP);
            let b = num(top + size.h);
            let ry = num(size.h / 2.0);
            let cap = num(CAP);
            format!(
                r#"<path d="M{l},{}H{r}A{cap},{ry} 0 0 1 {r},{b}H{l}A{cap},{ry} 0 0 1 {l},{}Z"{shape}/><path d="M{r},{}A{cap},{ry} 0 0 0 {r},{b}"{line}/>{}"#,
                num(top),
                num(top),
                num(top),
                label_svg(label, cx - CAP / 2.0, top + size.h / 2.0, text_cls, theme, icons,),
            )
        }
        ActorKind::Participant | ActorKind::Actor | ActorKind::Boundary | ActorKind::Control | ActorKind::Entity | ActorKind::Database => format!(
            r#"<rect x="{}" y="{}" width="{}" height="{}"{shape}{rounded}/>{}"#,
            num(left),
            num(top),
            num(size.w),
            num(size.h),
            label_svg(label, cx, top + size.h / 2.0, text_cls, theme, icons),
        ),
    }
}
