use std::collections::HashMap;

use crate::MonospacePart;
use crate::config::MessageAlign;
use crate::diagram::RenderContext;
use crate::measure::{MonoMeasurer, TextMeasurer, TextStyle};
use crate::svg::builder::{esc, num};
use crate::svg::edges::{ARROW, marker};
use crate::svg::ink::ink;
use crate::svg::theme::{SvgTheme, resolve_style};
use crate::text::label::{Label, layout_label};
use crate::text::literal::break_label;

use super::super::db::SeqDb;
use super::super::types::{LineType, SeqMessage, SeqMessageBody};

pub(super) const MSG_PAD: f64 = 12.0;
pub(super) const SELF_W: f64 = 28.0;
pub(super) const SELF_H: f64 = 22.0;
pub(super) const ACT_W: f64 = 10.0;
pub(super) const ACT_STEP: f64 = 4.0;
pub(super) const ACT_MIN: f64 = 14.0;
pub(super) const NOTE_GAP: f64 = 10.0;
pub(super) const NOTE_OVER: f64 = 16.0;
pub(super) const FRAME_PAD: f64 = 20.0;
pub(super) const FRAME_NEST: f64 = 10.0;
pub(super) const TAB_H: f64 = 20.0;
pub(super) const FRAME_TEXT: f64 = 240.0;
pub(super) const BADGE_H: f64 = 16.0;
pub(super) const CENTRAL_R: f64 = 4.0;
pub(super) const DASH: &str = r#" stroke-dasharray="4 4""#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Head {
    None,
    Arrow,
    Cross,
    Open,
    HalfSolid,
    HalfStick,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct LineStyle {
    pub(super) dotted: bool,
    pub(super) head: Head,
    pub(super) at_start: bool,
    pub(super) at_end: bool,
    pub(super) bottom: bool,
}

pub(super) fn line_style(t: LineType) -> Option<LineStyle> {
    let mk = |dotted: bool, head: Head, ends: u8, bottom: bool| -> LineStyle {
        LineStyle {
            dotted,
            head,
            at_start: ends != 1,
            at_end: ends != 0,
            bottom,
        }
    };
    match t {
        LineType::Solid => Some(mk(false, Head::Arrow, 1, false)),
        LineType::Dotted => Some(mk(true, Head::Arrow, 1, false)),
        LineType::SolidCross => Some(mk(false, Head::Cross, 1, false)),
        LineType::DottedCross => Some(mk(true, Head::Cross, 1, false)),
        LineType::SolidOpen => Some(mk(false, Head::None, 1, false)),
        LineType::DottedOpen => Some(mk(true, Head::None, 1, false)),
        LineType::SolidPoint => Some(mk(false, Head::Open, 1, false)),
        LineType::DottedPoint => Some(mk(true, Head::Open, 1, false)),
        LineType::BidirectionalSolid => Some(mk(false, Head::Arrow, 2, false)),
        LineType::BidirectionalDotted => Some(mk(true, Head::Arrow, 2, false)),
        LineType::SolidTop => Some(mk(false, Head::HalfSolid, 1, false)),
        LineType::SolidBottom => Some(mk(false, Head::HalfSolid, 1, true)),
        LineType::StickTop => Some(mk(false, Head::HalfStick, 1, false)),
        LineType::StickBottom => Some(mk(false, Head::HalfStick, 1, true)),
        LineType::SolidArrowTopReverse => Some(mk(false, Head::HalfSolid, 0, false)),
        LineType::SolidArrowBottomReverse => Some(mk(false, Head::HalfSolid, 0, true)),
        LineType::StickArrowTopReverse => Some(mk(false, Head::HalfStick, 0, false)),
        LineType::StickArrowBottomReverse => Some(mk(false, Head::HalfStick, 0, true)),
        LineType::SolidTopDotted => Some(mk(true, Head::HalfSolid, 1, false)),
        LineType::SolidBottomDotted => Some(mk(true, Head::HalfSolid, 1, true)),
        LineType::StickTopDotted => Some(mk(true, Head::HalfStick, 1, false)),
        LineType::StickBottomDotted => Some(mk(true, Head::HalfStick, 1, true)),
        LineType::SolidArrowTopReverseDotted => Some(mk(true, Head::HalfSolid, 0, false)),
        LineType::SolidArrowBottomReverseDotted => Some(mk(true, Head::HalfSolid, 0, true)),
        LineType::StickArrowTopReverseDotted => Some(mk(true, Head::HalfStick, 0, false)),
        LineType::StickArrowBottomReverseDotted => Some(mk(true, Head::HalfStick, 0, true)),
        LineType::Note
        | LineType::LoopStart
        | LineType::LoopEnd
        | LineType::AltStart
        | LineType::AltElse
        | LineType::AltEnd
        | LineType::OptStart
        | LineType::OptEnd
        | LineType::ActiveStart
        | LineType::ActiveEnd
        | LineType::ParStart
        | LineType::ParAnd
        | LineType::ParEnd
        | LineType::RectStart
        | LineType::RectEnd
        | LineType::Autonumber
        | LineType::CriticalStart
        | LineType::CriticalOption
        | LineType::CriticalEnd
        | LineType::BreakStart
        | LineType::BreakEnd
        | LineType::ParOverStart
        | LineType::CentralConnection
        | LineType::CentralConnectionReverse
        | LineType::CentralConnectionDual => None,
    }
}

pub(super) fn frame_kind(t: LineType) -> Option<&'static str> {
    match t {
        LineType::LoopStart => Some("loop"),
        LineType::AltStart => Some("alt"),
        LineType::OptStart => Some("opt"),
        LineType::ParStart | LineType::ParOverStart => Some("par"),
        LineType::CriticalStart => Some("critical"),
        LineType::BreakStart => Some("break"),
        LineType::RectStart => Some("rect"),
        LineType::Solid
        | LineType::Dotted
        | LineType::Note
        | LineType::SolidCross
        | LineType::DottedCross
        | LineType::SolidOpen
        | LineType::DottedOpen
        | LineType::LoopEnd
        | LineType::AltElse
        | LineType::AltEnd
        | LineType::OptEnd
        | LineType::ActiveStart
        | LineType::ActiveEnd
        | LineType::ParAnd
        | LineType::ParEnd
        | LineType::RectEnd
        | LineType::SolidPoint
        | LineType::DottedPoint
        | LineType::Autonumber
        | LineType::CriticalOption
        | LineType::CriticalEnd
        | LineType::BreakEnd
        | LineType::BidirectionalSolid
        | LineType::BidirectionalDotted
        | LineType::SolidTop
        | LineType::SolidBottom
        | LineType::StickTop
        | LineType::StickBottom
        | LineType::SolidArrowTopReverse
        | LineType::SolidArrowBottomReverse
        | LineType::StickArrowTopReverse
        | LineType::StickArrowBottomReverse
        | LineType::SolidTopDotted
        | LineType::SolidBottomDotted
        | LineType::StickTopDotted
        | LineType::StickBottomDotted
        | LineType::SolidArrowTopReverseDotted
        | LineType::SolidArrowBottomReverseDotted
        | LineType::StickArrowTopReverseDotted
        | LineType::StickArrowBottomReverseDotted
        | LineType::CentralConnection
        | LineType::CentralConnectionReverse
        | LineType::CentralConnectionDual => None,
    }
}

pub(super) fn is_frame_end(t: LineType) -> bool {
    matches!(
        t,
        LineType::LoopEnd | LineType::AltEnd | LineType::OptEnd | LineType::ParEnd | LineType::CriticalEnd | LineType::BreakEnd | LineType::RectEnd
    )
}

pub(super) fn is_frame_divider(t: LineType) -> bool {
    matches!(t, LineType::AltElse | LineType::ParAnd | LineType::CriticalOption)
}

pub fn is_line_message(t: Option<LineType>) -> bool {
    t.is_some_and(|lt| line_style(lt).is_some())
}

pub struct Numbering {
    pub index: Vec<f64>,
    pub shown: Vec<bool>,
    pub visible: bool,
}

pub(super) fn format_seq_num(v: f64) -> String {
    if v == 0.0 {
        "0".to_string()
    } else if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

pub fn number_messages(messages: &[SeqMessage], always: bool) -> Numbering {
    let mut index = vec![f64::NAN; messages.len()];
    let mut shown = vec![false; messages.len()];
    let mut current = 1.0f64;
    let mut step = 1.0f64;
    let mut visible = false;
    for (i, m) in messages.iter().enumerate() {
        if m.line_type == Some(LineType::Autonumber) {
            if let SeqMessageBody::Numbering(spec) = m.message {
                if let Some(s) = spec.start
                    && s != 0.0
                {
                    current = s;
                }
                if let Some(st) = spec.step
                    && st != 0.0
                {
                    step = st;
                }
                visible = spec.visible;
            }
        } else if is_line_message(m.line_type) {
            index[i] = current;
            shown[i] = visible || always;
            current = ((current + step) * 100.0).round() / 100.0;
        }
    }
    Numbering { index, shown, visible }
}

fn clamp_opt(value: Option<f64>, fallback: f64) -> f64 {
    match value {
        Some(v) if (0.0..=2000.0).contains(&v) => v,
        _ => fallback,
    }
}

fn draw_half(x: f64, y: f64, dir: f64, up: f64, stick: bool, color: &str) -> String {
    let bx = num(x - dir * ARROW);
    if stick {
        format!(r#"<path class="pele-marker" d="M{},{}L{bx},{}"/>"#, num(x), num(y), num(y + up * 5.0),)
    } else {
        format!(
            r#"<path class="pele-marker" d="M{},{}L{bx},{}V{}Z" fill="{color}" stroke="none"/>"#,
            num(x),
            num(y),
            num(y + up * 4.5),
            num(y),
        )
    }
}

pub(super) fn draw_head(head: Head, x: f64, y: f64, dir: f64, up: f64, color: &str, bg: &str) -> String {
    match head {
        Head::Arrow => marker("arrow_point", x, y, dir, 0.0, color, bg),
        Head::Cross => marker("arrow_cross", x, y, dir, 0.0, color, bg),
        Head::Open => format!(
            r#"<path class="pele-marker" d="M{},{}L{},{}L{},{}" stroke-linejoin="round"/>"#,
            num(x - dir * ARROW),
            num(y - 4.5),
            num(x),
            num(y),
            num(x - dir * ARROW),
            num(y + 4.5),
        ),
        Head::HalfSolid => draw_half(x, y, dir, up, false, color),
        Head::HalfStick => draw_half(x, y, dir, up, true, color),
        Head::None => String::new(),
    }
}

pub(super) fn head_trim(head: Head) -> f64 {
    match head {
        Head::Arrow => ARROW - 1.0,
        Head::Cross => 4.0,
        Head::None | Head::Open | Head::HalfSolid | Head::HalfStick => 0.0,
    }
}

pub(super) struct InkCache(HashMap<String, Option<String>>);

impl InkCache {
    pub(super) fn new() -> Self {
        Self(HashMap::new())
    }

    pub(super) fn get(&mut self, fill: Option<&str>, theme: &SvgTheme) -> Option<String> {
        let f = fill?;
        if f.is_empty() {
            return None;
        }
        if let Some(cached) = self.0.get(f) {
            return cached.clone();
        }
        let resolved = resolve_style(&[format!("fill:{f}")]);
        let computed = ink(&resolved.shape, "", theme).map(str::to_string);
        self.0.insert(f.to_string(), computed.clone());
        computed
    }
}

pub(super) struct Metrics {
    pub(super) tight: bool,
    pub(super) size: f64,
    pub(super) small: f64,
    pub(super) tiny: f64,
    pub(super) monospaced: bool,
    pub(super) pad: f64,
    pub(super) mirror: bool,
    pub(super) right_angles: bool,
    pub(super) actor_margin: f64,
    pub(super) min_w: f64,
    pub(super) min_h: f64,
    pub(super) wrap_w: f64,
    pub(super) msg_gap: f64,
    pub(super) note_pad: f64,
    pub(super) box_pad: f64,
    pub(super) align: i32,
    pub(super) msg_pad: f64,
    pub(super) note_over: f64,
    pub(super) frame_pad: f64,
    pub(super) frame_nest: f64,
}

impl Metrics {
    pub(super) fn from_context(db: &SeqDb, ctx: &RenderContext<'_>, tight: bool) -> Self {
        let conf = &ctx.config.sequence;
        let size = ctx.options.font_size.unwrap_or(16.0);
        let small = (size * 0.875).round();
        let tiny = (size * 0.75).round();
        let monospaced = ctx.options.monospace.contains(&MonospacePart::Messages);
        let pad = ctx.options.padding.unwrap_or(8.0);
        let mirror = conf.mirror_actors != Some(false);
        let right_angles = conf.right_angles;
        let actor_margin = clamp_opt(conf.actor_margin, 40.0).min(if tight { 8.0 } else { f64::INFINITY });
        let min_w = clamp_opt(conf.width, 64.0).min(if tight { 48.0 } else { f64::INFINITY });
        let min_h = clamp_opt(conf.height, (size * 1.5).round() + 20.0);
        let wrap_w = clamp_opt(conf.width, 160.0).min(if tight {
            32.0f64.max((ctx.options.max_width.unwrap_or(320.0) - 2.0 * pad) / (db.actors.len().max(1) as f64) - actor_margin - 24.0)
        } else {
            f64::INFINITY
        });
        let msg_gap = 4.0f64.max(14.0 + clamp_opt(conf.message_margin, 35.0) - 35.0);
        let note_pad = clamp_opt(conf.note_margin, 10.0).min(if tight { 6.0 } else { f64::INFINITY });
        let box_pad = clamp_opt(conf.box_margin, 10.0).min(if tight { 6.0 } else { f64::INFINITY });
        let align = match conf.message_align {
            Some(MessageAlign::Left) => -1,
            Some(MessageAlign::Right) => 1,
            Some(MessageAlign::Center) | None => 0,
        };
        Self {
            tight,
            size,
            small,
            tiny,
            monospaced,
            pad,
            mirror,
            right_angles,
            actor_margin,
            min_w,
            min_h,
            wrap_w,
            msg_gap,
            note_pad,
            box_pad,
            align,
            msg_pad: if tight { 6.0 } else { MSG_PAD },
            note_over: if tight { 8.0 } else { NOTE_OVER },
            frame_pad: if tight { 12.0 } else { FRAME_PAD },
            frame_nest: if tight { 6.0 } else { FRAME_NEST },
        }
    }

    pub(super) fn text_label(&self, ctx: &RenderContext<'_>, raw: Option<&str>, font_size: f64, wrap: bool, width: f64, by: &dyn TextMeasurer) -> Label {
        let label = layout_label(
            raw,
            false,
            by,
            font_size,
            if self.tight || wrap { width } else { f64::INFINITY },
            TextStyle::NONE,
            ctx.icons,
            ctx.math,
        );
        if self.tight { break_label(label, by, 120.0f64.max(width)) } else { label }
    }

    pub(super) fn message_label(&self, ctx: &RenderContext<'_>, raw: &str, wrap: bool, width: f64) -> Label {
        if self.monospaced {
            let mono = MonoMeasurer(ctx.measurer);
            self.text_label(ctx, Some(raw), self.small, wrap, width, &mono)
        } else {
            self.text_label(ctx, Some(raw), self.small, wrap, width, ctx.measurer)
        }
    }

    pub(super) fn badge_width(&self, ctx: &RenderContext<'_>, numbering: &Numbering, i: usize) -> f64 {
        if numbering.shown[i] {
            let s = format_seq_num(numbering.index[i]);
            BADGE_H.max(ctx.measurer.width(&s, self.tiny, TextStyle::NONE) + 8.0)
        } else {
            0.0
        }
    }

    pub(super) fn badge_svg(&self, ctx: &RenderContext<'_>, index_val: f64, cx: f64, cy: f64, w: f64) -> String {
        let idx_str = format_seq_num(index_val);
        format!(
            r#"<g class="pele-sequence-number"><rect x="{}" y="{}" width="{}" height="{}" rx="{}" fill="{}" stroke="none"/><text x="{}" y="{}" text-anchor="middle" font-size="{}" fill="{}" stroke="none">{}</text></g>"#,
            num(cx - w / 2.0),
            num(cy - BADGE_H / 2.0),
            num(w),
            num(BADGE_H),
            num(BADGE_H / 2.0),
            ctx.theme.line(),
            num(cx),
            num(cy + self.tiny * 0.35),
            num(self.tiny),
            ctx.theme.bg(),
            esc(&idx_str),
        )
    }
}
