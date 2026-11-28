use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;

use crate::diagram::RenderContext;
use crate::measure::TextStyle;
use crate::text::label::Label;

use super::super::actors::{ActorKind, ActorSize, actor_size};
use super::super::db::SeqDb;
use super::super::types::{LineType, Placement, SeqActor, SeqBox};
use super::style::{ACT_W, CENTRAL_R, FRAME_TEXT, Metrics, NOTE_GAP, Numbering, SELF_W, frame_kind, is_frame_divider, is_frame_end, is_line_message};

pub(super) struct Column<'a> {
    pub(super) id: &'a str,
    pub(super) actor: &'a SeqActor,
    pub(super) kind: ActorKind,
    pub(super) label: Label,
    pub(super) size: ActorSize,
    pub(super) x: f64,
    pub(super) create_at: i32,
    pub(super) destroy_at: i32,
    pub(super) top: f64,
    pub(super) life_start: f64,
    pub(super) life_end: f64,
    pub(super) activations: Vec<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ViewKind {
    Line,
    SelfLoop,
    Note,
}

pub(super) struct View {
    pub(super) kind: ViewKind,
    pub(super) a: usize,
    pub(super) b: usize,
    pub(super) label: Label,
    pub(super) x: f64,
    pub(super) w: f64,
}

pub(super) struct SeqFrame {
    pub(super) kind: &'static str,
    pub(super) x0: f64,
    pub(super) x1: f64,
    pub(super) top: f64,
    pub(super) title: Label,
    pub(super) tab_w: f64,
    pub(super) fill: String,
    pub(super) dividers: Vec<usize>,
    pub(super) divider_y: Vec<f64>,
    pub(super) divider_labels: Vec<Label>,
}

pub(super) struct BoxRun<'a> {
    pub(super) box_ref: &'a SeqBox,
    pub(super) first: usize,
    pub(super) last: usize,
    pub(super) title: Label,
    pub(super) grow: f64,
}

pub(super) struct HorizontalLayout<'a> {
    pub(super) cols: Vec<Column<'a>>,
    pub(super) col_of: HashMap<&'a str, usize>,
    pub(super) runs: Vec<BoxRun<'a>>,
    pub(super) views: Vec<Option<View>>,
    pub(super) frames_pool: Vec<SeqFrame>,
    pub(super) frame_at: Vec<Option<usize>>,
    pub(super) min_x: f64,
    pub(super) max_x: f64,
    pub(super) grown: bool,
    pub(super) uneven: bool,
    pub(super) hold: f64,
}

impl HorizontalLayout<'_> {
    fn run_layout(
        &mut self,
        db: &SeqDb,
        ctx: &RenderContext<'_>,
        m: &Metrics,
        numbering: &Numbering,
        gaps: &[f64],
        sized_cache: &mut [Option<HashMap<u64, Label>>],
    ) {
        let messages = &db.messages;
        for i in 1..self.cols.len() {
            self.cols[i].x = self.cols[i - 1].x + gaps[i - 1];
        }
        let mut min_x = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut extend = |x0: f64, x1: f64| {
            if x0 < min_x {
                min_x = x0;
            }
            if x1 > max_x {
                max_x = x1;
            }
        };
        for col in &self.cols {
            extend(col.x - col.size.w / 2.0, col.x + col.size.w / 2.0);
        }
        for run in &self.runs {
            let x0 = self.cols[run.first].x - self.cols[run.first].size.w / 2.0 - m.box_pad - run.grow;
            let x1 = self.cols[run.last].x + self.cols[run.last].size.w / 2.0 + m.box_pad + run.grow;
            extend(x0, x1);
        }

        self.frames_pool.clear();
        self.frame_at.fill(None);
        let mut open: Vec<usize> = Vec::new();
        let span_all = |cols: &[Column<'_>]| -> (f64, f64) {
            if cols.is_empty() {
                (0.0, 120.0)
            } else {
                (cols[0].x - m.frame_pad, cols[cols.len() - 1].x + m.frame_pad)
            }
        };

        for (i, msg) in messages.iter().enumerate() {
            let lt = msg.line_type;
            if let Some(fk) = lt.and_then(frame_kind) {
                let fidx = self.frames_pool.len();
                self.frames_pool.push(SeqFrame {
                    kind: fk,
                    x0: f64::INFINITY,
                    x1: f64::NEG_INFINITY,
                    top: 0.0,
                    title: Label::empty(),
                    tab_w: 0.0,
                    fill: if fk == "rect" {
                        msg.message.as_text().unwrap_or("").to_string()
                    } else {
                        String::new()
                    },
                    dividers: vec![i],
                    divider_y: Vec::new(),
                    divider_labels: Vec::new(),
                });
                self.frame_at[i] = Some(fidx);
                open.push(fidx);
            } else if lt.is_some_and(is_frame_divider) {
                if let Some(&fidx) = open.last() {
                    self.frames_pool[fidx].dividers.push(i);
                }
            } else if lt.is_some_and(is_frame_end) {
                let Some(fidx) = open.pop() else {
                    continue;
                };
                self.frame_at[i] = Some(fidx);
                if self.frames_pool[fidx].x0 > self.frames_pool[fidx].x1 {
                    let (a, b) = span_all(&self.cols);
                    self.frames_pool[fidx].x0 = a;
                    self.frames_pool[fidx].x1 = b;
                }
                if self.frames_pool[fidx].kind != "rect" {
                    let fk = self.frames_pool[fidx].kind;
                    let tab_w = ctx.measurer.width(fk, m.tiny, TextStyle::BOLD) + 14.0;
                    self.frames_pool[fidx].tab_w = tab_w;
                    let dividers = self.frames_pool[fidx].dividers.clone();
                    for (k, &div_idx) in dividers.iter().enumerate() {
                        let raw = messages[div_idx].message.as_text().unwrap_or("");
                        let tab = if k == 0 { tab_w + 8.0 } else { 0.0 };
                        let room = self.frames_pool[fidx].x1 - self.frames_pool[fidx].x0 - 16.0 - tab;
                        let label = if !raw.is_empty() {
                            let bracketed = format!("[{raw}]");
                            let max_r = room.max(if m.tight { FRAME_TEXT.min(m.wrap_w) } else { FRAME_TEXT });
                            m.text_label(ctx, Some(&bracketed), m.small, true, max_r, ctx.measurer)
                        } else {
                            Label::empty()
                        };
                        if label.width > room {
                            self.frames_pool[fidx].x1 += label.width - room;
                        }
                        if k == 0 {
                            self.frames_pool[fidx].title = label;
                        } else {
                            self.frames_pool[fidx].divider_labels.push(label);
                        }
                    }
                }
                let fx0 = self.frames_pool[fidx].x0;
                let fx1 = self.frames_pool[fidx].x1;
                extend(fx0, fx1);
                if let Some(&pidx) = open.last() {
                    self.frames_pool[pidx].x0 = self.frames_pool[pidx].x0.min(fx0 - m.frame_nest);
                    self.frames_pool[pidx].x1 = self.frames_pool[pidx].x1.max(fx1 + m.frame_nest);
                }
            } else if let Some(ref mut view) = self.views[i] {
                let ax = self.cols[view.a].x;
                let bx = self.cols[view.b].x;
                let (mut x0, mut x1);
                match view.kind {
                    ViewKind::Note => {
                        match msg.placement {
                            Some(Placement::LeftOf) => view.x = ax - NOTE_GAP - view.w,
                            Some(Placement::RightOf) => view.x = ax + NOTE_GAP,
                            _ if view.a == view.b => view.x = ax - view.w / 2.0,
                            _ => {
                                let lo = ax.min(bx) - m.note_over;
                                let hi = ax.max(bx) + m.note_over;
                                if m.tight || msg.wrap {
                                    let raw = msg.message.as_text().unwrap_or("");
                                    view.label = m.text_label(ctx, Some(raw), m.small, true, m.wrap_w.max(hi - lo - 2.0 * m.note_pad), ctx.measurer);
                                }
                                view.w = (hi - lo).max(view.label.width + 2.0 * m.note_pad);
                                view.x = (lo + hi - view.w) / 2.0;
                            }
                        }
                        x0 = view.x;
                        x1 = view.x + view.w;
                    }
                    ViewKind::SelfLoop => {
                        x0 = ax;
                        x1 = ax + ACT_W + SELF_W + 8.0 + view.label.width + m.badge_width(ctx, numbering, i);
                    }
                    ViewKind::Line => {
                        x0 = ax.min(bx);
                        x1 = ax.max(bx);
                        if m.tight || msg.wrap {
                            let room = m.wrap_w.max(x1 - x0 - 2.0 * m.msg_pad - ACT_W);
                            if room != m.wrap_w || sized_cache[i].is_some() {
                                let map = sized_cache[i].get_or_insert_with(|| {
                                    let mut hm = HashMap::new();
                                    hm.insert(m.wrap_w.to_bits(), view.label.clone());
                                    hm
                                });
                                let lbl = map
                                    .entry(room.to_bits())
                                    .or_insert_with(|| m.message_label(ctx, msg.message.as_text().unwrap_or(""), true, room));
                                view.label = lbl.clone();
                            }
                        }
                        if self.cols[view.b].create_at == i as i32 {
                            if bx > ax {
                                x1 += self.cols[view.b].size.w / 2.0;
                            } else {
                                x0 -= self.cols[view.b].size.w / 2.0;
                            }
                        }
                    }
                }
                extend(x0, x1);
                if let Some(&fidx) = open.last() {
                    self.frames_pool[fidx].x0 = self.frames_pool[fidx].x0.min(x0 - m.frame_pad);
                    self.frames_pool[fidx].x1 = self.frames_pool[fidx].x1.max(x1 + m.frame_pad);
                }
            }
        }
        self.min_x = min_x;
        self.max_x = max_x;
    }
}

pub(super) fn layout_horizontal<'a>(
    db: &'a SeqDb,
    ctx: &RenderContext<'_>,
    m: &Metrics,
    numbering: &Numbering,
    hold: f64,
    by_need: bool,
) -> HorizontalLayout<'a> {
    let conf = &ctx.config.sequence;
    let messages = &db.messages;
    let count = messages.len();

    let used: Option<HashSet<&str>> = if conf.hide_unused_participants {
        let mut set = HashSet::new();
        for msg in messages {
            if let Some(ref f) = msg.from {
                set.insert(f.as_str());
            }
            if let Some(ref t) = msg.to {
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

    let mut cols: Vec<Column<'a>> = Vec::new();
    let mut col_of: HashMap<&'a str, usize> = HashMap::new();
    for (id, actor) in &db.actors {
        if let Some(ref u) = used
            && !u.contains(id.as_str())
        {
            continue;
        }
        let kind = ActorKind::from_str_or_default(&actor.actor_type);
        let label = m.text_label(ctx, Some(&actor.description), m.size, actor.wrap, m.wrap_w, ctx.measurer);
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
        let actor_sz = actor_size(kind, &label, m.min_w, m.min_h, if m.tight { Some(8.0) } else { None });
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

    let mut views: Vec<Option<View>> = (0..count).map(|_| None).collect();
    let mut sized_cache: Vec<Option<HashMap<u64, Label>>> = (0..count).map(|_| None).collect();

    for (i, msg) in messages.iter().enumerate() {
        let Some(a) = msg.from.as_deref().and_then(|s| col_of.get(s).copied()) else {
            continue;
        };
        let Some(b) = msg.to.as_deref().and_then(|s| col_of.get(s).copied()) else {
            continue;
        };
        let Some(msg_text) = msg.message.as_text() else {
            continue;
        };
        if msg.line_type == Some(LineType::Note) {
            let label = m.text_label(ctx, Some(msg_text), m.small, msg.wrap, m.wrap_w, ctx.measurer);
            let w = label.width + 2.0 * m.note_pad;
            match msg.placement {
                Some(Placement::LeftOf) => need(a as isize - 1, a as isize, w + 2.0 * NOTE_GAP + ACT_W),
                Some(Placement::RightOf) => need(a as isize, a as isize + 1, w + 2.0 * NOTE_GAP + ACT_W),
                _ if a == b => {
                    need(a as isize - 1, a as isize, w / 2.0 + NOTE_GAP);
                    need(a as isize, a as isize + 1, w / 2.0 + NOTE_GAP);
                }
                _ => need(a.min(b) as isize, a.max(b) as isize, w - 2.0 * m.note_over),
            }
            views[i] = Some(View {
                kind: ViewKind::Note,
                a,
                b,
                label,
                x: 0.0,
                w,
            });
        } else if is_line_message(msg.line_type) {
            let label = m.message_label(ctx, msg_text, msg.wrap, m.wrap_w);
            let badge = m.badge_width(ctx, numbering, i);
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
                let central = if msg.central_connection.is_some() { 4.0 * CENTRAL_R } else { 0.0 };
                let lw = if m.tight {
                    label.width.min(16.0f64.max(m.wrap_w - 16.0))
                } else {
                    label.width
                };
                need(a.min(b) as isize, a.max(b) as isize, lw + 2.0 * m.msg_pad + ACT_W + badge + created + central);
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

    let mut runs: Vec<BoxRun<'a>> = Vec::new();
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
                title: m.text_label(ctx, box_ref.name.as_deref(), m.small, box_ref.wrap, m.wrap_w, ctx.measurer),
                grow: 0.0,
            });
        }
    }

    let mut gaps = vec![0.0f64; col_count.saturating_sub(1)];
    for i in 0..gaps.len() {
        let left = &cols[i];
        let right = &cols[i + 1];
        let boxed = if left.actor.box_idx != right.actor.box_idx {
            (if left.actor.box_idx.is_some() { m.box_pad } else { 0.0 }) + (if right.actor.box_idx.is_some() { m.box_pad } else { 0.0 })
        } else {
            0.0
        };
        let min_gap = left.size.w / 2.0 + right.size.w / 2.0 + m.actor_margin + boxed;
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

    let mut layout = HorizontalLayout {
        cols,
        col_of,
        runs,
        views,
        frames_pool: Vec::new(),
        frame_at: vec![None; count],
        min_x: f64::INFINITY,
        max_x: f64::NEG_INFINITY,
        grown: false,
        uneven: false,
        hold,
    };

    layout.run_layout(db, ctx, m, numbering, &gaps, &mut sized_cache);

    if m.tight
        && let Some(max_width) = ctx.options.max_width
    {
        let spare = max_width.floor() - (layout.max_x - layout.min_x + 2.0 * m.pad).ceil() - hold;
        if spare > 0.0 && !gaps.is_empty() {
            let mut stretch = vec![0i32; col_count];
            let mut want = vec![0.0f64; gaps.len()];
            let mut wrapped: Vec<usize> = Vec::new();
            let mut lines = 0usize;
            for (i, view_opt) in layout.views.iter().enumerate() {
                let Some(view) = view_opt else {
                    continue;
                };
                if view.kind != ViewKind::Line {
                    continue;
                }
                let natural = m.message_label(ctx, messages[i].message.as_text().unwrap_or(""), false, f64::INFINITY);
                if view.label.lines.len() <= natural.lines.len() {
                    continue;
                }
                wrapped.push(i);
                lines += view.label.lines.len();
                let lo = view.a.min(view.b);
                let hi = view.a.max(view.b);
                stretch[lo] += 1;
                stretch[hi] -= 1;
                let short = (natural.width - (layout.cols[hi].x - layout.cols[lo].x - 2.0 * m.msg_pad - ACT_W)) / ((hi - lo) as f64);
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
                let mut spread = |layout: &mut HorizontalLayout<'a>, share: &dyn Fn(usize) -> f64| -> Vec<usize> {
                    for g in 0..gaps.len() {
                        gaps[g] = before[g] + share(g);
                    }
                    layout.run_layout(db, ctx, m, numbering, &gaps, &mut sized_cache);
                    wrapped.iter().map(|&i| layout.views[i].as_ref().unwrap().label.lines.len()).collect()
                };
                let even = |g: usize| -> f64 { (stretch[g] as f64) * spare / (crossed as f64) };
                let mut counts = spread(&mut layout, &even);
                let missing: f64 = want.iter().sum();
                let needs_fn = |g: usize| -> f64 { (want[g] * (spare - 0.01)) / missing };
                if by_need && crossed > 1 && missing > 0.0 && (0..before.len()).any(|g| needs_fn(g) > even(g)) {
                    let first = counts;
                    counts = spread(&mut layout, &needs_fn);
                    let sum_c: usize = counts.iter().sum();
                    let sum_f: usize = first.iter().sum();
                    layout.uneven = sum_c < sum_f && counts.iter().zip(first.iter()).all(|(&n, &f)| n <= f);
                    if !layout.uneven {
                        counts = spread(&mut layout, &even);
                    }
                }
                let sum_c: usize = counts.iter().sum();
                layout.grown = sum_c < lines;
                if !layout.grown {
                    gaps.copy_from_slice(&before);
                    layout.run_layout(db, ctx, m, numbering, &gaps, &mut sized_cache);
                }
            }
        }
    }

    layout
}
