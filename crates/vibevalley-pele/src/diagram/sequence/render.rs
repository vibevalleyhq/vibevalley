use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;

use crate::config::MessageAlign;
use crate::diagram::RenderContext;
use crate::diagram::common::{tighten, title_room};
use crate::measure::{MonoMeasurer, TextMeasurer, TextStyle};
use crate::svg::builder::{esc, esc_text, label_svg, num};
use crate::svg::edges::{ARROW, marker};
use crate::svg::ink::ink;
use crate::svg::root::{Accessible, svg_document};
use crate::svg::theme::{class_names, resolve_style};
use crate::svg::title::title_label;
use crate::text::label::{Label, layout_label};
use crate::text::literal::break_label;
use crate::{MonospacePart, Rendered};

use super::actors::{ActorKind, ActorSize, actor_size, draw_actor};
use super::db::SeqDb;
use super::types::{LineType, Placement, SeqActor, SeqBox, SeqMessage, SeqMessageBody};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Head {
    None,
    Arrow,
    Cross,
    Open,
    HalfSolid,
    HalfStick,
}

#[derive(Debug, Clone, Copy)]
struct LineStyle {
    dotted: bool,
    head: Head,
    at_start: bool,
    at_end: bool,
    bottom: bool,
}

fn line_style(t: LineType) -> Option<LineStyle> {
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

fn frame_kind(t: LineType) -> Option<&'static str> {
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

fn is_frame_end(t: LineType) -> bool {
    matches!(
        t,
        LineType::LoopEnd | LineType::AltEnd | LineType::OptEnd | LineType::ParEnd | LineType::CriticalEnd | LineType::BreakEnd | LineType::RectEnd
    )
}

fn is_frame_divider(t: LineType) -> bool {
    matches!(t, LineType::AltElse | LineType::ParAnd | LineType::CriticalOption)
}

pub fn is_line_message(t: Option<LineType>) -> bool {
    t.is_some_and(|lt| line_style(lt).is_some())
}

const MSG_PAD: f64 = 12.0;
const SELF_W: f64 = 28.0;
const SELF_H: f64 = 22.0;
const ACT_W: f64 = 10.0;
const ACT_STEP: f64 = 4.0;
const ACT_MIN: f64 = 14.0;
const NOTE_GAP: f64 = 10.0;
const NOTE_OVER: f64 = 16.0;
const FRAME_PAD: f64 = 20.0;
const FRAME_NEST: f64 = 10.0;
const TAB_H: f64 = 20.0;
const FRAME_TEXT: f64 = 240.0;
const BADGE_H: f64 = 16.0;
const CENTRAL_R: f64 = 4.0;
const DASH: &str = r#" stroke-dasharray="4 4""#;

pub struct Numbering {
    pub index: Vec<f64>,
    pub shown: Vec<bool>,
    pub visible: bool,
}

fn format_seq_num(v: f64) -> String {
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

struct Column<'a> {
    id: &'a str,
    actor: &'a SeqActor,
    kind: ActorKind,
    label: Label,
    size: ActorSize,
    x: f64,
    create_at: i32,
    destroy_at: i32,
    top: f64,
    life_start: f64,
    life_end: f64,
    activations: Vec<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ViewKind {
    Line,
    SelfLoop,
    Note,
}

struct View {
    kind: ViewKind,
    a: usize,
    b: usize,
    label: Label,
    x: f64,
    w: f64,
}

struct SeqFrame {
    kind: &'static str,
    x0: f64,
    x1: f64,
    top: f64,
    title: Label,
    tab_w: f64,
    fill: String,
    dividers: Vec<usize>,
    divider_y: Vec<f64>,
    divider_labels: Vec<Label>,
}

struct BoxRun<'a> {
    box_ref: &'a SeqBox,
    first: usize,
    last: usize,
    title: Label,
    grow: f64,
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

fn draw_head(head: Head, x: f64, y: f64, dir: f64, up: f64, color: &str, bg: &str) -> String {
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

fn head_trim(head: Head) -> f64 {
    match head {
        Head::Arrow => ARROW - 1.0,
        Head::Cross => 4.0,
        Head::None | Head::Open | Head::HalfSolid | Head::HalfStick => 0.0,
    }
}

pub fn render_sequence(db: &SeqDb, ctx: &RenderContext<'_>) -> Rendered {
    tighten(ctx.options, |tight| draw(db, ctx, tight, 0.0, true))
}

fn draw(db: &SeqDb, ctx: &RenderContext<'_>, tight: bool, hold: f64, by_need: bool) -> Rendered {
    let conf = &ctx.config.sequence;
    let size = ctx.options.font_size.unwrap_or(16.0);
    let small = (size * 0.875).round();
    let tiny = (size * 0.75).round();
    let monospaced = ctx.options.monospace.contains(&MonospacePart::Messages);
    let mono_measurer = MonoMeasurer(ctx.measurer);
    let message_measurer: &dyn TextMeasurer = if monospaced { &mono_measurer } else { ctx.measurer };
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
    let align: i32 = match conf.message_align {
        Some(MessageAlign::Left) => -1,
        Some(MessageAlign::Right) => 1,
        Some(MessageAlign::Center) | None => 0,
    };

    let msg_pad = if tight { 6.0 } else { MSG_PAD };
    let note_over = if tight { 8.0 } else { NOTE_OVER };
    let frame_pad = if tight { 12.0 } else { FRAME_PAD };
    let frame_nest = if tight { 6.0 } else { FRAME_NEST };
    let messages = &db.messages;
    let count = messages.len();
    let numbering = number_messages(messages, conf.show_sequence_numbers);

    let text_fn = |raw: Option<&str>, font_size: f64, wrap: bool, width: f64, by: &dyn TextMeasurer| -> Label {
        let label = layout_label(
            raw,
            false,
            by,
            font_size,
            if tight || wrap { width } else { f64::INFINITY },
            TextStyle::NONE,
            ctx.icons,
            ctx.math,
        );
        if tight { break_label(label, by, 120.0f64.max(width)) } else { label }
    };
    let message_text = |raw: &str, wrap: bool, width: f64| -> Label { text_fn(Some(raw), small, wrap, width, message_measurer) };

    let used: Option<HashSet<&str>> = if conf.hide_unused_participants {
        let mut set = HashSet::new();
        for m in messages {
            if let Some(ref f) = m.from {
                set.insert(f.as_str());
            }
            if let Some(ref t) = m.to {
                set.insert(t.as_str());
            }
        }
        Some(set)
    } else {
        None
    };

    let mut next_line = vec![-1i32; count + 1];
    for i in (0..count).rev() {
        next_line[i] = if is_line_message(messages[i].line_type) { i as i32 } else { next_line[i + 1] };
    }

    let mut cols: Vec<Column<'_>> = Vec::new();
    let mut col_of: HashMap<&str, usize> = HashMap::new();
    for (id, actor) in &db.actors {
        if let Some(ref u) = used
            && !u.contains(id.as_str())
        {
            continue;
        }
        let kind = ActorKind::from_str_or_default(&actor.actor_type);
        let label = text_fn(Some(&actor.description), size, actor.wrap, wrap_w, ctx.measurer);
        let mut create_at = db.created_actors.get(id).map_or(-1, |&idx| next_line[idx.min(count)]);
        if create_at >= 0 && messages[create_at as usize].to.as_deref() != Some(id.as_str()) {
            create_at = -1;
        }
        let mut destroy_at = db.destroyed_actors.get(id).map_or(-1, |&idx| next_line[idx.min(count)]);
        if destroy_at >= 0 {
            let dm = &messages[destroy_at as usize];
            if dm.to.as_deref() != Some(id.as_str()) && dm.from.as_deref() != Some(id.as_str()) {
                destroy_at = -1;
            }
        }
        col_of.insert(id.as_str(), cols.len());
        let actor_sz = actor_size(kind, &label, min_w, min_h, if tight { Some(8.0) } else { None });
        cols.push(Column {
            id: id.as_str(),
            actor,
            kind,
            label,
            size: actor_sz,
            x: 0.0,
            create_at,
            destroy_at,
            top: 0.0,
            life_start: 0.0,
            life_end: -1.0,
            activations: Vec::new(),
        });
    }
    let col_count = cols.len();
    let last_col = col_count as isize - 1;

    let mut needs: IndexMap<(usize, usize), f64> = IndexMap::new();
    let mut need = |lo: isize, hi: isize, width: f64| {
        if lo < 0 || hi > last_col {
            return;
        }
        let entry = needs.entry((lo as usize, hi as usize)).or_insert(0.0);
        if *entry < width {
            *entry = width;
        }
    };
    let badge_width = |i: usize| -> f64 {
        if numbering.shown[i] {
            let s = format_seq_num(numbering.index[i]);
            BADGE_H.max(ctx.measurer.width(&s, tiny, TextStyle::NONE) + 8.0)
        } else {
            0.0
        }
    };

    let mut views: Vec<Option<View>> = (0..count).map(|_| None).collect();
    let mut sized_cache: Vec<Option<HashMap<u64, Label>>> = (0..count).map(|_| None).collect();

    for (i, m) in messages.iter().enumerate() {
        let Some(a) = m.from.as_deref().and_then(|s| col_of.get(s).copied()) else {
            continue;
        };
        let Some(b) = m.to.as_deref().and_then(|s| col_of.get(s).copied()) else {
            continue;
        };
        let Some(msg_text) = m.message.as_text() else {
            continue;
        };
        if m.line_type == Some(LineType::Note) {
            let label = text_fn(Some(msg_text), small, m.wrap, wrap_w, ctx.measurer);
            let w = label.width + 2.0 * note_pad;
            match m.placement {
                Some(Placement::LeftOf) => need(a as isize - 1, a as isize, w + 2.0 * NOTE_GAP + ACT_W),
                Some(Placement::RightOf) => need(a as isize, a as isize + 1, w + 2.0 * NOTE_GAP + ACT_W),
                _ if a == b => {
                    need(a as isize - 1, a as isize, w / 2.0 + NOTE_GAP);
                    need(a as isize, a as isize + 1, w / 2.0 + NOTE_GAP);
                }
                _ => need(a.min(b) as isize, a.max(b) as isize, w - 2.0 * note_over),
            }
            views[i] = Some(View {
                kind: ViewKind::Note,
                a,
                b,
                label,
                x: 0.0,
                w,
            });
        } else if is_line_message(m.line_type) {
            let label = message_text(msg_text, m.wrap, wrap_w);
            let badge = badge_width(i);
            if a == b {
                need(a as isize, a as isize + 1, SELF_W + 8.0 + label.width + 16.0 + ACT_W + badge);
                views[i] = Some(View {
                    kind: ViewKind::SelfLoop,
                    a,
                    b,
                    label,
                    x: 0.0,
                    w: 0.0,
                });
            } else {
                let created = if cols[b].create_at == i as i32 { cols[b].size.w / 2.0 } else { 0.0 };
                let central = if m.central_connection.is_some() { 4.0 * CENTRAL_R } else { 0.0 };
                let lw = if tight { label.width.min(16.0f64.max(wrap_w - 16.0)) } else { label.width };
                need(a.min(b) as isize, a.max(b) as isize, lw + 2.0 * msg_pad + ACT_W + badge + created + central);
                views[i] = Some(View {
                    kind: ViewKind::Line,
                    a,
                    b,
                    label,
                    x: 0.0,
                    w: 0.0,
                });
            }
        }
    }

    let mut runs: Vec<BoxRun<'_>> = Vec::new();
    for (i, col) in cols.iter().enumerate() {
        let Some(bidx) = col.actor.box_idx else {
            continue;
        };
        let box_ref = &db.boxes[bidx];
        if let Some(last_run) = runs.last_mut()
            && std::ptr::eq(last_run.box_ref, box_ref)
            && last_run.last + 1 == i
        {
            last_run.last = i;
        } else {
            runs.push(BoxRun {
                box_ref,
                first: i,
                last: i,
                title: text_fn(box_ref.name.as_deref(), small, box_ref.wrap, wrap_w, ctx.measurer),
                grow: 0.0,
            });
        }
    }

    let mut gaps = vec![0.0f64; col_count.saturating_sub(1)];
    for i in 0..gaps.len() {
        let left = &cols[i];
        let right = &cols[i + 1];
        let boxed = if left.actor.box_idx != right.actor.box_idx {
            (if left.actor.box_idx.is_some() { box_pad } else { 0.0 }) + (if right.actor.box_idx.is_some() { box_pad } else { 0.0 })
        } else {
            0.0
        };
        let min_gap = left.size.w / 2.0 + right.size.w / 2.0 + actor_margin + boxed;
        gaps[i] = min_gap.max(needs.get(&(i, i + 1)).copied().unwrap_or(0.0));
    }

    let mut spans: Vec<(usize, usize, f64)> = needs.iter().filter(|&(&(lo, hi), _)| hi - lo > 1).map(|(&(lo, hi), &w)| (lo, hi, w)).collect();
    spans.sort_by(|p, q| (p.1 - p.0).cmp(&(q.1 - q.0)).then_with(|| p.0.cmp(&q.0)));
    for (lo, hi, width) in spans {
        let total: f64 = gaps[lo..hi].iter().sum();
        if total >= width {
            continue;
        }
        let share = (width - total) / ((hi - lo) as f64);
        for g in &mut gaps[lo..hi] {
            *g += share;
        }
    }

    for i in 1..col_count {
        cols[i].x = cols[i - 1].x + gaps[i - 1];
    }
    for run in &mut runs {
        let inner = (cols[run.last].x + cols[run.last].size.w / 2.0) - (cols[run.first].x - cols[run.first].size.w / 2.0);
        run.grow = ((run.title.width - inner) / 2.0).max(0.0);
        if run.grow == 0.0 {
            continue;
        }
        if run.first > 0 {
            gaps[run.first - 1] += run.grow;
        }
        if run.last + 1 < col_count {
            gaps[run.last] += run.grow;
        }
    }

    let mut frames_pool: Vec<SeqFrame> = Vec::new();
    let mut frame_at: Vec<Option<usize>> = vec![None; count];
    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;

    let run_layout = |cols: &mut [Column<'_>],
                      gaps: &[f64],
                      runs: &[BoxRun<'_>],
                      views: &mut [Option<View>],
                      sized_cache: &mut [Option<HashMap<u64, Label>>],
                      frames_pool: &mut Vec<SeqFrame>,
                      frame_at: &mut [Option<usize>],
                      min_x: &mut f64,
                      max_x: &mut f64| {
        for i in 1..cols.len() {
            cols[i].x = cols[i - 1].x + gaps[i - 1];
        }
        *min_x = f64::INFINITY;
        *max_x = f64::NEG_INFINITY;
        let mut extend = |x0: f64, x1: f64| {
            if x0 < *min_x {
                *min_x = x0;
            }
            if x1 > *max_x {
                *max_x = x1;
            }
        };
        for col in cols.iter() {
            extend(col.x - col.size.w / 2.0, col.x + col.size.w / 2.0);
        }
        for run in runs {
            let x0 = cols[run.first].x - cols[run.first].size.w / 2.0 - box_pad - run.grow;
            let x1 = cols[run.last].x + cols[run.last].size.w / 2.0 + box_pad + run.grow;
            extend(x0, x1);
        }

        frames_pool.clear();
        frame_at.fill(None);
        let mut open: Vec<usize> = Vec::new();
        let span_all = |cols: &[Column<'_>]| -> (f64, f64) {
            if cols.is_empty() {
                (0.0, 120.0)
            } else {
                (cols[0].x - frame_pad, cols[cols.len() - 1].x + frame_pad)
            }
        };

        for (i, m) in messages.iter().enumerate() {
            let lt = m.line_type;
            if let Some(fk) = lt.and_then(frame_kind) {
                let fidx = frames_pool.len();
                frames_pool.push(SeqFrame {
                    kind: fk,
                    x0: f64::INFINITY,
                    x1: f64::NEG_INFINITY,
                    top: 0.0,
                    title: Label::empty(),
                    tab_w: 0.0,
                    fill: if fk == "rect" {
                        m.message.as_text().unwrap_or("").to_string()
                    } else {
                        String::new()
                    },
                    dividers: vec![i],
                    divider_y: Vec::new(),
                    divider_labels: Vec::new(),
                });
                frame_at[i] = Some(fidx);
                open.push(fidx);
            } else if lt.is_some_and(is_frame_divider) {
                if let Some(&fidx) = open.last() {
                    frames_pool[fidx].dividers.push(i);
                }
            } else if lt.is_some_and(is_frame_end) {
                let Some(fidx) = open.pop() else {
                    continue;
                };
                frame_at[i] = Some(fidx);
                if frames_pool[fidx].x0 > frames_pool[fidx].x1 {
                    let (a, b) = span_all(cols);
                    frames_pool[fidx].x0 = a;
                    frames_pool[fidx].x1 = b;
                }
                if frames_pool[fidx].kind != "rect" {
                    let fk = frames_pool[fidx].kind;
                    let tab_w = ctx.measurer.width(fk, tiny, TextStyle::BOLD) + 14.0;
                    frames_pool[fidx].tab_w = tab_w;
                    let dividers = frames_pool[fidx].dividers.clone();
                    for (k, &div_idx) in dividers.iter().enumerate() {
                        let raw = messages[div_idx].message.as_text().unwrap_or("");
                        let tab = if k == 0 { tab_w + 8.0 } else { 0.0 };
                        let room = frames_pool[fidx].x1 - frames_pool[fidx].x0 - 16.0 - tab;
                        let label = if !raw.is_empty() {
                            let bracketed = format!("[{raw}]");
                            let max_r = room.max(if tight { FRAME_TEXT.min(wrap_w) } else { FRAME_TEXT });
                            text_fn(Some(&bracketed), small, true, max_r, ctx.measurer)
                        } else {
                            Label::empty()
                        };
                        if label.width > room {
                            frames_pool[fidx].x1 += label.width - room;
                        }
                        if k == 0 {
                            frames_pool[fidx].title = label;
                        } else {
                            frames_pool[fidx].divider_labels.push(label);
                        }
                    }
                }
                let fx0 = frames_pool[fidx].x0;
                let fx1 = frames_pool[fidx].x1;
                extend(fx0, fx1);
                if let Some(&pidx) = open.last() {
                    frames_pool[pidx].x0 = frames_pool[pidx].x0.min(fx0 - frame_nest);
                    frames_pool[pidx].x1 = frames_pool[pidx].x1.max(fx1 + frame_nest);
                }
            } else if let Some(ref mut view) = views[i] {
                let ax = cols[view.a].x;
                let bx = cols[view.b].x;
                let (mut x0, mut x1);
                match view.kind {
                    ViewKind::Note => {
                        match m.placement {
                            Some(Placement::LeftOf) => view.x = ax - NOTE_GAP - view.w,
                            Some(Placement::RightOf) => view.x = ax + NOTE_GAP,
                            _ if view.a == view.b => view.x = ax - view.w / 2.0,
                            _ => {
                                let lo = ax.min(bx) - note_over;
                                let hi = ax.max(bx) + note_over;
                                if tight || m.wrap {
                                    let raw = m.message.as_text().unwrap_or("");
                                    view.label = text_fn(Some(raw), small, true, wrap_w.max(hi - lo - 2.0 * note_pad), ctx.measurer);
                                }
                                view.w = (hi - lo).max(view.label.width + 2.0 * note_pad);
                                view.x = (lo + hi - view.w) / 2.0;
                            }
                        }
                        x0 = view.x;
                        x1 = view.x + view.w;
                    }
                    ViewKind::SelfLoop => {
                        x0 = ax;
                        x1 = ax + ACT_W + SELF_W + 8.0 + view.label.width + badge_width(i);
                    }
                    ViewKind::Line => {
                        x0 = ax.min(bx);
                        x1 = ax.max(bx);
                        if tight || m.wrap {
                            let room = wrap_w.max(x1 - x0 - 2.0 * msg_pad - ACT_W);
                            if room != wrap_w || sized_cache[i].is_some() {
                                let map = sized_cache[i].get_or_insert_with(|| {
                                    let mut hm = HashMap::new();
                                    hm.insert(wrap_w.to_bits(), view.label.clone());
                                    hm
                                });
                                let lbl = map
                                    .entry(room.to_bits())
                                    .or_insert_with(|| message_text(m.message.as_text().unwrap_or(""), true, room));
                                view.label = lbl.clone();
                            }
                        }
                        if cols[view.b].create_at == i as i32 {
                            if bx > ax {
                                x1 += cols[view.b].size.w / 2.0;
                            } else {
                                x0 -= cols[view.b].size.w / 2.0;
                            }
                        }
                    }
                }
                extend(x0, x1);
                if let Some(&fidx) = open.last() {
                    frames_pool[fidx].x0 = frames_pool[fidx].x0.min(x0 - frame_pad);
                    frames_pool[fidx].x1 = frames_pool[fidx].x1.max(x1 + frame_pad);
                }
            }
        }
    };

    run_layout(
        &mut cols,
        &gaps,
        &runs,
        &mut views,
        &mut sized_cache,
        &mut frames_pool,
        &mut frame_at,
        &mut min_x,
        &mut max_x,
    );

    let mut grown = false;
    let mut uneven = false;
    if tight && let Some(max_width) = ctx.options.max_width {
        let spare = max_width.floor() - (max_x - min_x + 2.0 * pad).ceil() - hold;
        if spare > 0.0 && !gaps.is_empty() {
            let mut stretch = vec![0i32; col_count];
            let mut want = vec![0.0f64; gaps.len()];
            let mut wrapped: Vec<usize> = Vec::new();
            let mut lines = 0usize;
            for (i, view_opt) in views.iter().enumerate() {
                let Some(view) = view_opt else {
                    continue;
                };
                if view.kind != ViewKind::Line {
                    continue;
                }
                let natural = message_text(messages[i].message.as_text().unwrap_or(""), false, f64::INFINITY);
                if view.label.lines.len() <= natural.lines.len() {
                    continue;
                }
                wrapped.push(i);
                lines += view.label.lines.len();
                let lo = view.a.min(view.b);
                let hi = view.a.max(view.b);
                stretch[lo] += 1;
                stretch[hi] -= 1;
                let short = (natural.width - (cols[hi].x - cols[lo].x - 2.0 * msg_pad - ACT_W)) / ((hi - lo) as f64);
                for w_slot in &mut want[lo..hi] {
                    *w_slot = w_slot.max(short);
                }
            }
            let mut active = 0i32;
            let mut crossed = 0i32;
            for s in &mut stretch[..gaps.len()] {
                active += *s;
                *s = i32::from(active > 0);
                crossed += *s;
            }
            if crossed > 0 {
                let before = gaps.clone();
                let mut spread = |share: &dyn Fn(usize) -> f64| -> Vec<usize> {
                    for g in 0..gaps.len() {
                        gaps[g] = before[g] + share(g);
                    }
                    run_layout(
                        &mut cols,
                        &gaps,
                        &runs,
                        &mut views,
                        &mut sized_cache,
                        &mut frames_pool,
                        &mut frame_at,
                        &mut min_x,
                        &mut max_x,
                    );
                    wrapped.iter().map(|&i| views[i].as_ref().unwrap().label.lines.len()).collect()
                };
                let even = |g: usize| -> f64 { (stretch[g] as f64) * spare / (crossed as f64) };
                let mut counts = spread(&even);
                let missing: f64 = want.iter().sum();
                let needs_fn = |g: usize| -> f64 { (want[g] * (spare - 0.01)) / missing };
                if by_need && crossed > 1 && missing > 0.0 && (0..before.len()).any(|g| needs_fn(g) > even(g)) {
                    let first = counts;
                    counts = spread(&needs_fn);
                    let sum_c: usize = counts.iter().sum();
                    let sum_f: usize = first.iter().sum();
                    uneven = sum_c < sum_f && counts.iter().zip(first.iter()).all(|(&n, &f)| n <= f);
                    if !uneven {
                        counts = spread(&even);
                    }
                }
                let sum_c: usize = counts.iter().sum();
                grown = sum_c < lines;
                if !grown {
                    gaps.copy_from_slice(&before);
                    run_layout(
                        &mut cols,
                        &gaps,
                        &runs,
                        &mut views,
                        &mut sized_cache,
                        &mut frames_pool,
                        &mut frame_at,
                        &mut min_x,
                        &mut max_x,
                    );
                }
            }
        }
    }

    // Vertical placement, top to bottom.
    let mut box_title_h = 0.0f64;
    for run in &runs {
        box_title_h = box_title_h.max(run.title.height);
    }
    let box_top = if runs.is_empty() {
        0.0
    } else {
        box_pad + if box_title_h > 0.0 { box_title_h + 4.0 } else { 0.0 }
    };
    let mut row_h = 0.0f64;
    for col in &cols {
        if col.create_at < 0 {
            row_h = row_h.max(col.size.h);
        }
    }
    let head_bottom = box_top + row_h;
    for col in &mut cols {
        col.top = head_bottom - col.size.h;
        col.life_start = head_bottom;
    }

    let xs: Vec<f64> = cols.iter().map(|c| c.x).collect();
    let box_ranges: Vec<(f64, f64, &str)> = runs
        .iter()
        .map(|run| {
            let x0 = cols[run.first].x - cols[run.first].size.w / 2.0 - box_pad - run.grow;
            let x1 = cols[run.last].x + cols[run.last].size.w / 2.0 + box_pad + run.grow;
            (x0, x1, run.box_ref.fill.as_str())
        })
        .collect();

    let crosses = |x0: f64, x1: f64| -> bool {
        let mut lo = 0usize;
        let mut hi = xs.len();
        while lo < hi {
            let mid = (lo + hi) >> 1;
            if xs[mid] <= x0 {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        lo < xs.len() && xs[lo] < x1
    };

    let mut stack: Vec<usize> = Vec::new();
    let mut inks: HashMap<String, Option<String>> = HashMap::new();
    let ink_of = |inks: &mut HashMap<String, Option<String>>, fill: Option<&str>| -> Option<String> {
        let f = fill?;
        if f.is_empty() {
            return None;
        }
        if let Some(cached) = inks.get(f) {
            return cached.clone();
        }
        let resolved = resolve_style(&[format!("fill:{f}")]);
        let computed = ink(&resolved.shape, "", ctx.theme).map(str::to_string);
        inks.insert(f.to_string(), computed.clone());
        computed
    };

    let fill_under = |frames_pool: &[SeqFrame], stack: &[usize], l: f64, r: f64| -> Option<String> {
        for &fidx in stack.iter().rev() {
            if frames_pool[fidx].kind == "rect" {
                return Some(frames_pool[fidx].fill.clone());
            }
        }
        for &(x0, x1, fill) in &box_ranges {
            if l >= x0 && r <= x1 {
                return Some(fill.to_string());
            }
        }
        None
    };

    let mut rects_out: Vec<String> = Vec::new();
    let mut activations_out: Vec<String> = Vec::new();
    let mut frames_out = String::new();
    let mut edges_out = String::new();
    let mut labels_out = String::new();
    let mut notes_out = String::new();
    let mut actors_out = String::new();
    let mut crosses_out = String::new();

    let left_edge = |col: &Column<'_>, extra: usize| -> f64 { if col.activations.len() + extra > 0 { col.x - ACT_W / 2.0 } else { col.x } };
    let right_edge = |col: &Column<'_>, extra: usize| -> f64 {
        let depth = col.activations.len() + extra;
        if depth > 0 {
            col.x + ACT_W / 2.0 + ((depth - 1) as f64) * ACT_STEP
        } else {
            col.x
        }
    };

    let end_activation = |col: &mut Column<'_>, end: f64, min_x: &mut f64, max_x: &mut f64, activations_out: &mut Vec<String>| -> f64 {
        let start = col.activations.pop().unwrap();
        let bottom = end.max(start + ACT_MIN);
        let x = col.x - ACT_W / 2.0 + (col.activations.len() as f64) * ACT_STEP;
        if x < *min_x {
            *min_x = x;
        }
        if x + ACT_W > *max_x {
            *max_x = x + ACT_W;
        }
        activations_out.push(format!(
            r#"<rect class="pele-activation" data-id="{}" x="{}" y="{}" width="{}" height="{}" rx="2"/>"#,
            esc_text(col.id),
            num(x),
            num(start),
            num(ACT_W),
            num(bottom - start),
        ));
        bottom
    };

    let destroy_actor = |col: &mut Column<'_>, line_y: f64, crosses_out: &mut String| -> f64 {
        let cx = col.x;
        let cy = line_y + 16.0;
        col.life_end = cy;
        crosses_out.push_str(&format!(
            r#"<path class="pele-destroy" data-id="{}" d="M{},{}L{},{}M{},{}L{},{}"/>"#,
            esc_text(col.id),
            num(cx - 6.0),
            num(cy - 6.0),
            num(cx + 6.0),
            num(cy + 6.0),
            num(cx + 6.0),
            num(cy - 6.0),
            num(cx - 6.0),
            num(cy + 6.0),
        ));
        cy + 6.0
    };

    let badge_svg = |i: usize, cx: f64, cy: f64, w: f64| -> String {
        let idx_str = format_seq_num(numbering.index[i]);
        format!(
            r#"<g class="pele-sequence-number"><rect x="{}" y="{}" width="{}" height="{}" rx="{}" fill="{}" stroke="none"/><text x="{}" y="{}" text-anchor="middle" font-size="{}" fill="{}" stroke="none">{}</text></g>"#,
            num(cx - w / 2.0),
            num(cy - BADGE_H / 2.0),
            num(w),
            num(BADGE_H),
            num(BADGE_H / 2.0),
            ctx.theme.line(),
            num(cx),
            num(cy + tiny * 0.35),
            num(tiny),
            ctx.theme.bg(),
            esc(&idx_str),
        )
    };

    let rounded_standalone = ctx.theme.rounded_standalone();
    let mut y = head_bottom + 6.0;

    for (i, m) in messages.iter().enumerate() {
        let lt = m.line_type;
        if lt == Some(LineType::ActiveStart) {
            if let Some(col_idx) = m.from.as_deref().and_then(|s| col_of.get(s).copied()) {
                cols[col_idx].activations.push(y);
            }
        } else if lt == Some(LineType::ActiveEnd) {
            if let Some(col_idx) = m.from.as_deref().and_then(|s| col_of.get(s).copied())
                && !cols[col_idx].activations.is_empty()
            {
                let bot = end_activation(&mut cols[col_idx], y, &mut min_x, &mut max_x, &mut activations_out);
                y = y.max(bot);
            }
        } else if let Some(fidx) = frame_at[i]
            && frames_pool[fidx].dividers[0] == i
        {
            stack.push(fidx);
            if frames_pool[fidx].kind == "rect" {
                frames_pool[fidx].top = y + 8.0;
                y = frames_pool[fidx].top;
            } else {
                frames_pool[fidx].top = y + 12.0;
                y = frames_pool[fidx].top + TAB_H.max(frames_pool[fidx].title.height + 2.0);
            }
        } else if let Some(fidx) = frame_at[i] {
            stack.pop();
            let bottom = y + 12.0;
            let frame_x0 = frames_pool[fidx].x0;
            let frame_x1 = frames_pool[fidx].x1;
            let frame_top = frames_pool[fidx].top;
            let frame_kind_s = frames_pool[fidx].kind;
            let x = num(frame_x0);
            let w = num(frame_x1 - frame_x0);
            if frame_kind_s == "rect" {
                let fill = if frames_pool[fidx].fill.is_empty() {
                    String::new()
                } else {
                    resolve_style(&[format!("fill:{}", frames_pool[fidx].fill)]).shape
                };
                let base_attrs = if fill.is_empty() { r#" fill-opacity="0.5""#.to_string() } else { fill };
                rects_out.push(format!(
                    r#"<rect class="pele-rect" x="{x}" y="{}" width="{w}" height="{}"{}/>"#,
                    num(frame_top),
                    num(bottom - frame_top),
                    ctx.theme.rounded(&base_attrs),
                ));
            } else {
                let mut inner = format!(
                    r#"<rect x="{x}" y="{}" width="{w}" height="{}" fill="none"{rounded_standalone}/>"#,
                    num(frame_top),
                    num(bottom - frame_top),
                );
                let div_len = frames_pool[fidx].divider_y.len();
                for k in 0..div_len {
                    let dy = frames_pool[fidx].divider_y[k];
                    let label = &frames_pool[fidx].divider_labels[k];
                    let cx = frame_x0 + 8.0 + label.width / 2.0;
                    let cy = dy + 2.0 + label.height / 2.0;
                    inner.push_str(&format!(r#"<path d="M{x},{}H{}"{DASH}/>"#, num(dy), num(frame_x1)));
                    if label.width > 0.0 {
                        let l = cx - label.width / 2.0;
                        let plate = crosses(l, l + label.width);
                        if plate {
                            inner.push_str(&format!(
                                r#"<rect x="{}" y="{}" width="{}" height="{}" rx="3" fill="{}" stroke="none"/>"#,
                                num(l - 3.0),
                                num(cy - label.height / 2.0 + 2.0),
                                num(label.width + 6.0),
                                num(label.height - 4.0),
                                ctx.theme.bg(),
                            ));
                        }
                        let fill_color = if plate {
                            None
                        } else {
                            let under_f = fill_under(&frames_pool, &stack, l, l + label.width);
                            ink_of(&mut inks, under_f.as_deref())
                        };
                        let attrs = format!(
                            r#" class="pele-frame-label" fill="{}" stroke="none""#,
                            fill_color.as_deref().unwrap_or(ctx.theme.muted()),
                        );
                        inner.push_str(&label_svg(label, cx, cy, &attrs, ctx.theme, ctx.icons));
                    }
                }
                let tab_w = frames_pool[fidx].tab_w;
                inner.push_str(&format!(
                    r#"<rect x="{x}" y="{}" width="{}" height="{}" fill="{}"{rounded_standalone}/><text class="pele-frame-kind" x="{}" y="{}" text-anchor="middle" font-size="{}" font-weight="{}" fill="{}" stroke="none">{frame_kind_s}</text>"#,
                    num(frame_top),
                    num(tab_w),
                    num(TAB_H),
                    ctx.theme.surface(),
                    num(frame_x0 + tab_w / 2.0),
                    num(frame_top + TAB_H / 2.0 + tiny * 0.35),
                    num(tiny),
                    ctx.theme.heading_weight(),
                    ctx.theme.muted(),
                ));
                let title_lbl = &frames_pool[fidx].title;
                if title_lbl.width > 0.0 {
                    let cx = frame_x0 + tab_w + 8.0 + title_lbl.width / 2.0;
                    let cy = frame_top + TAB_H.max(title_lbl.height) / 2.0;
                    let l = cx - title_lbl.width / 2.0;
                    let plate = crosses(l, l + title_lbl.width);
                    if plate {
                        inner.push_str(&format!(
                            r#"<rect x="{}" y="{}" width="{}" height="{}" rx="3" fill="{}" stroke="none"/>"#,
                            num(l - 3.0),
                            num(cy - title_lbl.height / 2.0 + 2.0),
                            num(title_lbl.width + 6.0),
                            num(title_lbl.height - 4.0),
                            ctx.theme.bg(),
                        ));
                    }
                    let fill_color = if plate {
                        None
                    } else {
                        let under_f = fill_under(&frames_pool, &stack, l, l + title_lbl.width);
                        ink_of(&mut inks, under_f.as_deref())
                    };
                    let attrs = format!(
                        r#" class="pele-frame-label" fill="{}" stroke="none""#,
                        fill_color.as_deref().unwrap_or(ctx.theme.muted()),
                    );
                    inner.push_str(&label_svg(title_lbl, cx, cy, &attrs, ctx.theme, ctx.icons));
                }
                frames_out.push_str(&format!(r#"<g class="pele-frame pele-frame-{frame_kind_s}">{inner}</g>"#));
            }
            y = bottom;
        } else if lt.is_some_and(is_frame_divider) {
            if let Some(&fidx) = stack.last() {
                let div_idx = frames_pool[fidx].divider_y.len();
                let lh = frames_pool[fidx].divider_labels.get(div_idx).map_or(0.0, |l| l.height);
                frames_pool[fidx].divider_y.push(y + 12.0);
                y += 12.0 + if lh > 0.0 { lh } else { 0.0 };
            }
        } else if let Some(ref view) = views[i] {
            if view.kind == ViewKind::Note {
                let a = &cols[view.a];
                let h = view.label.height + 2.0 * 4.0f64.max(note_pad - 4.0);
                let top = y + 10.0;
                let mut x = view.x;
                if m.placement == Some(Placement::RightOf) {
                    x += right_edge(a, 0) - a.x;
                } else if m.placement == Some(Placement::LeftOf) {
                    x += left_edge(a, 0) - a.x;
                }
                if x < min_x {
                    min_x = x;
                }
                if x + view.w > max_x {
                    max_x = x + view.w;
                }
                let lbl_attrs = format!(r#" class="pele-label" stroke="none" fill="{}""#, ctx.theme.fg());
                notes_out.push_str(&format!(
                    r#"<g class="pele-note" data-id="i{}"><rect x="{}" y="{}" width="{}" height="{}"{rounded_standalone}/>{}</g>"#,
                    esc_text(&m.id),
                    num(x),
                    num(top),
                    num(view.w),
                    num(h),
                    label_svg(&view.label, x + view.w / 2.0, top + h / 2.0, &lbl_attrs, ctx.theme, ctx.icons,),
                ));
                y = top + h;
            } else {
                let st = line_style(lt.unwrap()).unwrap();
                let label = &view.label;
                let bw = badge_width(i);
                let mut starting = 0usize;
                for mk in &messages[(i + 1)..count] {
                    match mk.line_type {
                        Some(LineType::ActiveStart) => {
                            if mk.from == m.to {
                                starting += 1;
                            }
                        }
                        Some(LineType::ActiveEnd | LineType::CentralConnection | LineType::CentralConnectionReverse) => {}
                        _ => break,
                    }
                }
                let up = if st.bottom { 1.0 } else { -1.0 };
                let attrs = if st.dotted { DASH } else { "" };
                let circle_to = matches!(m.central_connection, Some(LineType::CentralConnection | LineType::CentralConnectionDual));
                let circle_from = matches!(m.central_connection, Some(LineType::CentralConnectionReverse | LineType::CentralConnectionDual));
                let tail_at_end = st.at_start && !st.at_end;
                let trim_len = head_trim(st.head);
                let bg = ctx.theme.bg();
                let mut inner = String::new();
                let line_y: f64;
                let line_override: Option<String>;

                if view.kind == ViewKind::SelfLoop {
                    let ax = cols[view.a].x;
                    let top = y + msg_gap + ((label.height - SELF_H) / 2.0).max(0.0);
                    let bottom = top + SELF_H;
                    let mut x0 = if circle_from { ax + CENTRAL_R } else { right_edge(&cols[view.a], 0) };
                    let mut x1 = if circle_to { ax + CENTRAL_R } else { right_edge(&cols[view.a], starting) };
                    let out = x0.max(x1) + SELF_W + bw / 2.0;
                    let uf = fill_under(&frames_pool, &stack, ax, out);
                    line_override = ink_of(&mut inks, uf.as_deref());
                    let color = line_override.as_deref().unwrap_or(ctx.theme.line());
                    if circle_from {
                        inner.push_str(&format!(
                            r#"<circle class="pele-central" cx="{}" cy="{}" r="{}" fill="{color}" stroke="none"/>"#,
                            num(ax),
                            num(top),
                            num(CENTRAL_R),
                        ));
                    }
                    if circle_to {
                        inner.push_str(&format!(
                            r#"<circle class="pele-central" cx="{}" cy="{}" r="{}" fill="{color}" stroke="none"/>"#,
                            num(ax),
                            num(bottom),
                            num(CENTRAL_R),
                        ));
                    }
                    if bw > 0.0 {
                        let (bx, by) = if tail_at_end { (x1, bottom) } else { (x0, top) };
                        inner.push_str(&badge_svg(i, bx, by, bw));
                        if tail_at_end {
                            x1 += bw / 2.0;
                        } else {
                            x0 += bw / 2.0;
                        }
                    }
                    let mut heads = String::new();
                    if st.at_start {
                        heads.push_str(&draw_head(st.head, x0, top, -1.0, up, color, bg));
                    }
                    if st.at_end {
                        heads.push_str(&draw_head(st.head, x1, bottom, -1.0, -up, color, bg));
                    }
                    let from_s = num(x0 + if st.at_start { trim_len } else { 0.0 });
                    let to_s = num(x1 + if st.at_end { trim_len } else { 0.0 });
                    let d = if right_angles {
                        format!("M{from_s},{}H{}V{}H{to_s}", num(top), num(out), num(bottom))
                    } else {
                        format!(
                            "M{from_s},{}H{}A6,6 0 0 1 {},{}V{}A6,6 0 0 1 {},{}H{to_s}",
                            num(top),
                            num(out - 6.0),
                            num(out),
                            num(top + 6.0),
                            num(bottom - 6.0),
                            num(out - 6.0),
                            num(bottom),
                        )
                    };
                    inner = format!(r#"<path d="{d}"{attrs}/>{heads}{inner}"#);
                    if ax < min_x {
                        min_x = ax;
                    }
                    if out + 8.0 + label.width > max_x {
                        max_x = out + 8.0 + label.width;
                    }
                    if label.width > 0.0 {
                        let uf_l = fill_under(&frames_pool, &stack, out + 8.0, out + 8.0 + label.width);
                        let lbl_fill = ink_of(&mut inks, uf_l.as_deref()).map_or_else(String::new, |c| format!(r#" fill="{c}""#));
                        labels_out.push_str(&format!(
                            r#"<g class="pele-edge-label" data-id="i{}">{}</g>"#,
                            esc_text(&m.id),
                            label_svg(label, out + 8.0 + label.width / 2.0, (top + bottom) / 2.0, &lbl_fill, ctx.theme, ctx.icons,),
                        ));
                    }
                    line_y = bottom.max((top + bottom) / 2.0 + label.height / 2.0);
                } else {
                    let ax = cols[view.a].x;
                    let bx = cols[view.b].x;
                    let dir = if bx > ax { 1.0 } else { -1.0 };
                    let creating = cols[view.b].create_at == i as i32;
                    let uf = fill_under(&frames_pool, &stack, ax.min(bx), ax.max(bx));
                    line_override = ink_of(&mut inks, uf.as_deref());
                    let color = line_override.as_deref().unwrap_or(ctx.theme.line());
                    let extra_h = if label.height > 0.0 { label.height + 2.0 } else { 6.0 };
                    let create_h = if creating { cols[view.b].size.h / 2.0 - msg_gap + 6.0 } else { 0.0 };
                    line_y = y + msg_gap + extra_h.max(create_h);
                    let mut x0 = if dir > 0.0 {
                        right_edge(&cols[view.a], 0)
                    } else {
                        left_edge(&cols[view.a], 0)
                    };
                    let mut x1 = if dir > 0.0 {
                        left_edge(&cols[view.b], starting)
                    } else {
                        right_edge(&cols[view.b], starting)
                    };
                    if creating {
                        let bh = cols[view.b].size.h;
                        let bw_col = cols[view.b].size.w;
                        let bkind = cols[view.b].kind;
                        cols[view.b].top = line_y - bh / 2.0;
                        cols[view.b].life_start = cols[view.b].top + bh;
                        x1 = bx - dir * if bkind.is_figure() { 18.0 } else { bw_col / 2.0 + 1.0 };
                    }
                    if circle_from {
                        inner.push_str(&format!(
                            r#"<circle class="pele-central" cx="{}" cy="{}" r="{}" fill="{color}" stroke="none"/>"#,
                            num(ax),
                            num(line_y),
                            num(CENTRAL_R),
                        ));
                        x0 = ax + dir * CENTRAL_R;
                    }
                    if circle_to {
                        inner.push_str(&format!(
                            r#"<circle class="pele-central" cx="{}" cy="{}" r="{}" fill="{color}" stroke="none"/>"#,
                            num(bx),
                            num(line_y),
                            num(CENTRAL_R),
                        ));
                        x1 = bx - dir * CENTRAL_R;
                    }
                    if bw > 0.0 {
                        if tail_at_end {
                            let cx = if circle_to { x1 - dir * (bw / 2.0 + 2.0) } else { x1 };
                            inner.push_str(&badge_svg(i, cx, line_y, bw));
                            x1 = cx - (dir * bw) / 2.0;
                        } else {
                            let cx = if circle_from { x0 + dir * (bw / 2.0 + 2.0) } else { x0 };
                            inner.push_str(&badge_svg(i, cx, line_y, bw));
                            x0 = cx + (dir * bw) / 2.0;
                        }
                    }
                    let mut heads = String::new();
                    if st.at_start {
                        heads.push_str(&draw_head(st.head, x0, line_y, -dir, up * dir, color, bg));
                    }
                    if st.at_end {
                        heads.push_str(&draw_head(st.head, x1, line_y, dir, up * dir, color, bg));
                    }
                    let from_x = x0 + if st.at_start { dir * trim_len } else { 0.0 };
                    let to_x = x1 - if st.at_end { dir * trim_len } else { 0.0 };
                    inner = format!(r#"<path d="M{},{}H{}"{attrs}/>{heads}{inner}"#, num(from_x), num(line_y), num(to_x),);
                    if label.width > 0.0 {
                        let l = x0.min(x1);
                        let r = x0.max(x1);
                        let cx = if align < 0 {
                            l + msg_pad + label.width / 2.0
                        } else if align > 0 {
                            r - msg_pad - label.width / 2.0
                        } else {
                            (l + r) / 2.0
                        };
                        let cy = line_y - 4.0 - label.height / 2.0;
                        if cx - label.width / 2.0 < min_x {
                            min_x = cx - label.width / 2.0;
                        }
                        if cx + label.width / 2.0 > max_x {
                            max_x = cx + label.width / 2.0;
                        }
                        let ll = cx - label.width / 2.0;
                        let plate = crosses(ll, ll + label.width);
                        let back = if plate {
                            format!(
                                r#"<rect x="{}" y="{}" width="{}" height="{}" rx="3" fill="{}" stroke="none"/>"#,
                                num(ll - 3.0),
                                num(cy - label.height / 2.0 + 2.0),
                                num(label.width + 6.0),
                                num(label.height - 4.0),
                                ctx.theme.bg(),
                            )
                        } else {
                            String::new()
                        };
                        let lbl_fill = if plate {
                            String::new()
                        } else {
                            let uf_l = fill_under(&frames_pool, &stack, ll, ll + label.width);
                            ink_of(&mut inks, uf_l.as_deref()).map_or_else(String::new, |c| format!(r#" fill="{c}""#))
                        };
                        labels_out.push_str(&format!(
                            r#"<g class="pele-edge-label" data-id="i{}">{back}{}</g>"#,
                            esc_text(&m.id),
                            label_svg(label, cx, cy, &lbl_fill, ctx.theme, ctx.icons),
                        ));
                    }
                    if creating {
                        y = line_y + cols[view.b].size.h / 2.0 - 6.0;
                    }
                }

                let stroke_attr = line_override.as_deref().map_or_else(String::new, |c| format!(r#" stroke="{c}""#));
                edges_out.push_str(&format!(
                    r#"<g class="pele-edge pele-message" data-id="i{}"{stroke_attr}>{inner}</g>"#,
                    esc_text(&m.id),
                ));
                y = y.max(line_y);
                if cols[view.a].destroy_at == i as i32 {
                    let dy = destroy_actor(&mut cols[view.a], line_y, &mut crosses_out);
                    y = y.max(dy);
                }
                if view.b != view.a && cols[view.b].destroy_at == i as i32 {
                    let dy = destroy_actor(&mut cols[view.b], line_y, &mut crosses_out);
                    y = y.max(dy);
                }
            }
        }
    }

    y += 20.0;
    for col in &mut cols {
        while !col.activations.is_empty() {
            end_activation(col, y, &mut min_x, &mut max_x, &mut activations_out);
        }
    }

    let mut actor_svg = |col: &Column<'_>, top: f64, footer: bool| -> String {
        let cls = col.actor.properties.get("class").and_then(|v| v.as_str()).map(class_names).unwrap_or_default();
        let fig_ink = if col.kind.is_figure() {
            let bf = col.actor.box_idx.map(|bi| db.boxes[bi].fill.as_str());
            ink_of(&mut inks, bf).map_or_else(String::new, |c| format!(r#" fill="{c}""#))
        } else {
            String::new()
        };
        format!(
            r#"<g class="pele-node pele-actor pele-actor-{}{}{cls}" data-id="{}">{}</g>"#,
            col.kind.as_str(),
            if footer { " pele-actor-footer" } else { "" },
            esc_text(col.id),
            draw_actor(col.kind, col.x, top, col.size, &col.label, ctx.theme, ctx.icons, &fig_ink,),
        )
    };

    let mut bottom = y;
    if mirror {
        let mut foot_h = 0.0f64;
        for col in &cols {
            if col.life_end >= 0.0 {
                continue;
            }
            foot_h = foot_h.max(col.size.h);
            actors_out.push_str(&actor_svg(col, y, true));
        }
        bottom = y + foot_h;
    }

    let mut lifelines = String::new();
    for col in &cols {
        actors_out.push_str(&actor_svg(col, col.top, false));
        let end = if col.life_end >= 0.0 { col.life_end } else { y };
        if end > col.life_start {
            lifelines.push_str(&format!(
                r#"<path class="pele-lifeline" data-id="{}" d="M{},{}V{}"/>"#,
                esc_text(col.id),
                num(col.x),
                num(col.life_start),
                num(end),
            ));
        }
    }

    let mut boxes_out = String::new();
    for (idx, run) in runs.iter().enumerate() {
        let (x0, x1, fill_str) = box_ranges[idx];
        let fill = if fill_str == "transparent" {
            String::new()
        } else {
            resolve_style(&[format!("fill:{fill_str}")]).shape
        };
        let box_style = if fill.is_empty() { r#" fill-opacity="0.5""#.to_string() } else { fill };
        let title_fill = ink_of(&mut inks, Some(fill_str))
            .map(|c| format!(r#" fill="{c}""#))
            .unwrap_or_else(|| format!(r#" fill="{}""#, ctx.theme.muted()));
        let data_id = run
            .box_ref
            .name
            .as_deref()
            .filter(|s| !s.is_empty())
            .map_or_else(String::new, |n| format!(r#" data-id="{}""#, esc_text(n)));
        boxes_out.push_str(&format!(
            r#"<g class="pele-cluster pele-box"{data_id}><rect x="{}" y="0" width="{}" height="{}" fill="{}" stroke="{}"{}/>{}</g>"#,
            num(x0),
            num(x1 - x0),
            num(bottom + box_pad),
            ctx.theme.surface_alt(),
            ctx.theme.border(),
            ctx.theme.rounded(&box_style),
            label_svg(
                &run.title,
                (x0 + x1) / 2.0,
                box_pad / 2.0 + 2.0 + run.title.height / 2.0,
                &format!(r#" class="pele-cluster-label"{title_fill}"#),
                ctx.theme,
                ctx.icons,
            ),
        ));
    }
    if !runs.is_empty() {
        bottom += box_pad;
    }

    let mut min_y = 0.0f64;
    let mut title_out = String::new();
    let room = title_room(ctx.options);
    let plain_title = title_label(db.title.as_deref(), ctx.measurer, size, if tight { room } else { f64::INFINITY });
    let title = if tight {
        break_label(plain_title, ctx.measurer, 120.0f64.max(room))
    } else {
        plain_title
    };
    if min_x > max_x {
        min_x = 0.0;
        max_x = title.width.max(40.0);
    }
    if title.width > 0.0 {
        let cx = (min_x + max_x) / 2.0;
        if cx - title.width / 2.0 < min_x {
            min_x = cx - title.width / 2.0;
        }
        if cx + title.width / 2.0 > max_x {
            max_x = cx + title.width / 2.0;
        }
        min_y = -title.height - 12.0;
        let t_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
        title_out = label_svg(&title, cx, min_y + title.height / 2.0, &t_attrs, ctx.theme, ctx.icons);
    }

    let width = (max_x - min_x + 2.0 * pad).ceil();
    if grown
        && let Some(max_width) = ctx.options.max_width
        && width > max_width
    {
        let next_hold = if uneven {
            hold
        } else if hold > 0.0 {
            f64::INFINITY
        } else {
            width - max_width.floor()
        };
        return draw(db, ctx, tight, next_hold, false);
    }

    let height = (bottom - min_y + 2.0 * pad).ceil();
    rects_out.reverse();
    activations_out.reverse();

    let mut body = format!(r#"<g transform="translate({},{})">{title_out}"#, num(pad - min_x), num(pad - min_y),);
    if !boxes_out.is_empty() {
        body.push_str(&format!(r#"<g class="pele-boxes" font-size="{}">{boxes_out}</g>"#, num(small)));
    }
    if !rects_out.is_empty() {
        body.push_str(&format!(
            r#"<g class="pele-rects" fill="{}">{}</g>"#,
            ctx.theme.surface_alt(),
            rects_out.concat(),
        ));
    }
    if !lifelines.is_empty() {
        body.push_str(&format!(
            r#"<g class="pele-lifelines" fill="none" stroke="{}">{lifelines}</g>"#,
            ctx.theme.border(),
        ));
    }
    if !activations_out.is_empty() {
        body.push_str(&format!(
            r#"<g class="pele-activations" fill="{}" stroke="{}">{}</g>"#,
            ctx.theme.surface(),
            ctx.theme.border(),
            activations_out.concat(),
        ));
    }
    if !frames_out.is_empty() {
        body.push_str(&format!(
            r#"<g class="pele-frames" font-size="{}" stroke="{}">{frames_out}</g>"#,
            num(small),
            ctx.theme.border(),
        ));
    }
    if !edges_out.is_empty() {
        body.push_str(&format!(
            r#"<g class="pele-edges" fill="none" stroke="{}" stroke-linecap="round">{edges_out}</g>"#,
            ctx.theme.line(),
        ));
    }
    if !crosses_out.is_empty() {
        body.push_str(&format!(
            r#"<g class="pele-destroys" fill="none" stroke="{}" stroke-width="1.5" stroke-linecap="round">{crosses_out}</g>"#,
            ctx.theme.line(),
        ));
    }
    if !labels_out.is_empty() {
        let mono_attr = if monospaced {
            format!(r#" font-family="{}""#, ctx.theme.font_mono())
        } else {
            String::new()
        };
        body.push_str(&format!(
            r#"<g class="pele-edge-labels" font-size="{}"{mono_attr}>{labels_out}</g>"#,
            num(small),
        ));
    }
    if !notes_out.is_empty() {
        body.push_str(&format!(
            r#"<g class="pele-notes" font-size="{}" fill="{}" stroke="{}">{notes_out}</g>"#,
            num(small),
            ctx.theme.surface_alt(),
            ctx.theme.border(),
        ));
    }
    if !actors_out.is_empty() {
        body.push_str(&format!(r#"<g class="pele-nodes">{actors_out}</g>"#));
    }
    body.push_str("</g>");

    let svg = svg_document(
        "sequence",
        width,
        height,
        size,
        ctx.options,
        ctx.responsive,
        ctx.theme,
        ctx.palette,
        Accessible {
            acc_title: db.acc_title.as_deref(),
            acc_descr: db.acc_descr.as_deref(),
        },
        &body,
    );

    Rendered {
        svg,
        width,
        height,
        links: Vec::new(),
    }
}
