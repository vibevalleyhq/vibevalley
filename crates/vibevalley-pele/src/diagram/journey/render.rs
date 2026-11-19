use std::collections::HashMap;

use crate::Rendered;
use crate::diagram::RenderContext;
use crate::diagram::common::{fit_label, plain_label, turn_to_fit};
use crate::measure::TextStyle;
use crate::svg::builder::{esc_text, label_svg, num};
use crate::svg::root::{Accessible, svg_document};
use crate::svg::theme::SvgTheme;
use crate::text::label::Label;

use super::db::{JourneyModel, journey_actors};

const PAD_X: f64 = 10.0;
const PAD_Y: f64 = 8.0;
const MIN_TEXT: f64 = 124.0;
const MAX_TEXT: f64 = 200.0;
const GAP: f64 = 12.0;
const BAND_PAD: f64 = 6.0;
const GUTTER: f64 = 24.0;
const LEVEL: f64 = 26.0;
const FACE: f64 = 11.0;
const DOT: f64 = 5.0;
const DOT_STEP: f64 = 13.0;
const LEGEND_GAP: f64 = 20.0;

const EYES: &str = r#"<circle cx="-3.6" cy="-2.8" r="1.3"/><circle cx="3.6" cy="-2.8" r="1.3"/>"#;

#[derive(Clone, Copy)]
enum Mood {
    Happy,
    Neutral,
    Sad,
}

impl Mood {
    fn from_score(score: f64) -> Self {
        if score > 3.0 {
            Self::Happy
        } else if score < 3.0 {
            Self::Sad
        } else {
            Self::Neutral
        }
    }

    const fn class_name(self) -> &'static str {
        match self {
            Self::Happy => "happy",
            Self::Neutral => "neutral",
            Self::Sad => "sad",
        }
    }

    const fn mouth_path(self) -> &'static str {
        match self {
            Self::Happy => "M-5,2A6,6 0 0 0 5,2",
            Self::Neutral => "M-4.5,4.5H4.5",
            Self::Sad => "M-5,6.5A6,6 0 0 1 5,6.5",
        }
    }
}

fn face_svg(x: f64, y: f64, mood: Mood, theme: &SvgTheme) -> String {
    format!(
        r#"<g class="pele-face pele-face-{}" transform="translate({},{})"><circle r="{}" fill="{}" stroke="{}"/><g fill="{}">{EYES}</g><path d="{}" fill="none" stroke="{}" stroke-linecap="round"/></g>"#,
        mood.class_name(),
        num(x),
        num(y),
        num(FACE),
        theme.bg(),
        theme.line(),
        theme.line(),
        mood.mouth_path(),
        theme.line(),
    )
}

pub fn render_journey(model: &JourneyModel, ctx: &RenderContext<'_>) -> Rendered {
    turn_to_fit(ctx.options, |down| draw(model, ctx, down))
}

struct LegendItem {
    name: String,
    label: Label,
    x: f64,
    y: f64,
    h: f64,
}

struct SectionRun {
    start: usize,
    count: usize,
    label: Option<Label>,
}

fn draw(model: &JourneyModel, ctx: &RenderContext<'_>, down: bool) -> Rendered {
    if down {
        return vertical_journey(model, ctx);
    }
    let size = ctx.options.font_size.unwrap_or(16.0);
    let small = (size * 0.875).round();
    let tiny = (size * 0.75).round();
    let pad = ctx.options.padding.unwrap_or(8.0);
    let tasks = &model.tasks;
    let n = tasks.len();

    let names: Vec<String> = journey_actors(tasks).into_iter().filter(|name| !name.is_empty()).collect();
    let actor: HashMap<&str, usize> = names.iter().enumerate().map(|(i, name)| (name.as_str(), i)).collect();

    let mut text_w = MIN_TEXT;
    let mut labels: Vec<Label> = tasks
        .iter()
        .map(|task| plain_label(Some(&task.task), ctx.measurer, small, text_w, TextStyle::NONE))
        .collect();
    let mut widest = 0.0f64;
    for label in &labels {
        widest = widest.max(label.width);
    }
    if widest > text_w {
        text_w = widest.ceil().min(MAX_TEXT);
        labels = tasks
            .iter()
            .map(|task| fit_label(Some(&task.task), ctx.measurer, small, text_w, TextStyle::NONE))
            .collect();
    }

    let card_w = text_w + 2.0 * PAD_X;
    let pitch = card_w + GAP;
    let plot_w = if n > 0 { n as f64 * pitch - GAP } else { 0.0 };

    let line_h = (small * 1.5).round();
    let limit = plot_w.max(240.0);
    let mut legend: Vec<LegendItem> = Vec::new();
    let mut legend_w = 0.0f64;
    let mut legend_h = 0.0f64;
    let mut lx = 0.0f64;
    for name in &names {
        let label = fit_label(Some(name), ctx.measurer, small, limit - 2.0 * DOT - 6.0, TextStyle::NONE);
        let w = 2.0 * DOT + 6.0 + label.width;
        if lx > 0.0 && lx + w > limit {
            lx = 0.0;
            legend_h += 4.0;
        }
        let y = if lx > 0.0 { legend.last().map_or(legend_h, |l| l.y) } else { legend_h };
        let h = label.height.max(line_h);
        legend.push(LegendItem {
            name: name.clone(),
            label,
            x: lx,
            y,
            h,
        });
        lx += w;
        legend_w = legend_w.max(lx);
        legend_h = legend_h.max(y + h);
        lx += LEGEND_GAP;
    }

    let body_w = if n > 0 { GUTTER + plot_w } else { 0.0 };
    let title = fit_label(model.title.as_deref(), ctx.measurer, size, body_w.max(320.0), TextStyle::BOLD);
    let title_h = if title.height > 0.0 { title.height + 16.0 } else { 0.0 };
    let width = body_w.max(title.width).max(if n > 0 { GUTTER + legend_w } else { 0.0 });
    let left = pad + (width - body_w) / 2.0 + GUTTER;
    let top = pad + title_h;

    let mut runs: Vec<SectionRun> = Vec::new();
    let mut band_h = 0.0f64;
    let mut i = 0usize;
    while i < n {
        let mut end = i + 1;
        while end < n && tasks[end].section == tasks[i].section {
            end += 1;
        }
        let label = if !tasks[i].section.is_empty() {
            let l = fit_label(
                Some(&tasks[i].section),
                ctx.measurer,
                small,
                (end - i) as f64 * pitch - GAP - 2.0 * PAD_X,
                TextStyle::BOLD,
            );
            band_h = band_h.max(l.height.max(line_h) + 2.0 * BAND_PAD);
            Some(l)
        } else {
            None
        };
        runs.push(SectionRun {
            start: i,
            count: end - i,
            label,
        });
        i = end;
    }

    let mut text_h = line_h;
    for label in &labels {
        text_h = text_h.max(label.height);
    }
    let dots_h = if !names.is_empty() { 2.0 * DOT + 6.0 } else { 0.0 };
    let card_h = text_h + dots_h + 2.0 * PAD_Y;
    let cards_y = top + if band_h > 0.0 { band_h + BAND_PAD } else { 0.0 };
    let chart_top = cards_y + card_h + FACE + 16.0;
    let chart_bottom = chart_top + 4.0 * LEVEL;
    let right = left + plot_w;
    let rounded = ctx.theme.rounded_standalone();

    let mut body = String::new();
    let mut bottom = top;
    if n > 0 {
        let mut grid = String::new();
        let mut scale = String::new();
        for score in (1..=5).rev() {
            let y = chart_top + (5 - score) as f64 * LEVEL;
            grid.push_str(&format!("M{},{}H{}", num(left - 6.0), num(y), num(right)));
            scale.push_str(&format!(r#"<text x="{}" y="{}">{score}</text>"#, num(left - 12.0), num(y + tiny * 0.35)));
        }
        body.push_str(&format!(
            r#"<path class="pele-grid" d="{grid}" fill="none" stroke="{}"/><g class="pele-scale" font-size="{}" text-anchor="end" fill="{}">{scale}</g>"#,
            ctx.theme.surface_alt(),
            num(tiny),
            ctx.theme.muted(),
        ));

        let mut line = String::new();
        let mut stems = String::new();
        let mut faces = String::new();
        let mut cards: Vec<String> = Vec::with_capacity(n);
        let small_attr = format!(r#" font-size="{}""#, num(small));

        for (idx, task) in tasks.iter().enumerate() {
            let x = left + idx as f64 * pitch;
            let cx = x + card_w / 2.0;
            let score = task.score;
            let level = if score.is_nan() { 3.0 } else { score.clamp(1.0, 5.0) };
            let y = chart_top + (5.0 - level) * LEVEL;
            line.push_str(&format!("{}{},{}", if idx == 0 { "M" } else { "L" }, num(cx), num(y)));
            stems.push_str(&format!("M{},{}V{}", num(cx), num(cards_y + card_h), num(y - FACE)));
            faces.push_str(&face_svg(cx, y, Mood::from_score(score), ctx.theme));

            let mut dots = String::new();
            let people: Vec<&str> = task.people.iter().map(String::as_str).filter(|s| !s.is_empty()).collect();
            let step = DOT_STEP.min((card_w - 2.0 * PAD_X - 2.0 * DOT) / (people.len().saturating_sub(1).max(1) as f64));
            for (k, name) in people.iter().enumerate() {
                let offset = (k as f64 - (people.len() as f64 - 1.0) / 2.0) * step;
                let series = actor.get(name).copied().unwrap_or(0);
                dots.push_str(&format!(
                    r#"<circle class="pele-actor" cx="{}" cy="{}" r="{}" fill="{}" stroke="{}"><title>{}</title></circle>"#,
                    num(cx + offset),
                    num(cards_y + card_h - PAD_Y - DOT),
                    num(DOT),
                    ctx.theme.series_color(series, ctx.palette),
                    ctx.theme.surface(),
                    esc_text(name),
                ));
            }
            cards.push(format!(
                r#"<g class="pele-node pele-task" data-id="{}"><rect x="{}" y="{}" width="{}" height="{}" fill="{}" stroke="{}"{rounded}/>{}{dots}</g>"#,
                esc_text(task.task.trim()),
                num(x),
                num(cards_y),
                num(card_w),
                num(card_h),
                ctx.theme.surface(),
                ctx.theme.border(),
                label_svg(&labels[idx], cx, cards_y + PAD_Y + text_h / 2.0, &small_attr, ctx.theme, None),
            ));
        }

        body.push_str(&format!(
            r#"<path class="pele-stems" d="{stems}" fill="none" stroke="{}" stroke-dasharray="2 3"/>"#,
            ctx.theme.border(),
        ));
        if n > 1 {
            body.push_str(&format!(
                r#"<path class="pele-edge" d="{line}" fill="none" stroke="{}" stroke-linejoin="round"/>"#,
                ctx.theme.line(),
            ));
        }
        body.push_str(&faces);

        let sec_label_attrs = format!(r#" font-size="{}" font-weight="{}""#, num(small), ctx.theme.heading_weight());
        for run in &runs {
            let members: String = cards[run.start..run.start + run.count].concat();
            let Some(label) = &run.label else {
                body.push_str(&members);
                continue;
            };
            let x = left + run.start as f64 * pitch;
            let w = run.count as f64 * pitch - GAP;
            body.push_str(&format!(
                r#"<g class="pele-cluster pele-section" data-id="{}"><rect x="{}" y="{}" width="{}" height="{}" fill="{}"{rounded}/>{}{members}</g>"#,
                esc_text(tasks[run.start].section.trim()),
                num(x),
                num(top),
                num(w),
                num(band_h),
                ctx.theme.surface_alt(),
                label_svg(label, x + w / 2.0, top + band_h / 2.0, &sec_label_attrs, ctx.theme, None),
            ));
        }
        bottom = chart_bottom + FACE;

        if !legend.is_empty() {
            let x0 = left + (plot_w - legend_w) / 2.0;
            let y0 = bottom + 16.0;
            let mut items = String::new();
            for item in &legend {
                let cy = y0 + item.y + item.h / 2.0;
                let series = actor.get(item.name.as_str()).copied().unwrap_or(0);
                items.push_str(&format!(
                    r#"<g class="pele-legend-item" data-id="{}"><circle cx="{}" cy="{}" r="{}" fill="{}"/>{}</g>"#,
                    esc_text(&item.name),
                    num(x0 + item.x + DOT),
                    num(cy),
                    num(DOT),
                    ctx.theme.series_color(series, ctx.palette),
                    label_svg(&item.label, x0 + item.x + 2.0 * DOT + 6.0 + item.label.width / 2.0, cy, "", ctx.theme, None),
                ));
            }
            body.push_str(&format!(r#"<g class="pele-legend" font-size="{}">{items}</g>"#, num(small)));
            bottom = y0 + legend_h;
        }
    }

    let total_width = (width + 2.0 * pad).ceil();
    let total_height = (bottom.max(pad) + pad).ceil();
    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let content = format!(
        "{}{body}",
        label_svg(&title, pad + width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, None),
    );
    let svg = svg_document(
        "journey",
        total_width,
        total_height,
        size,
        ctx.options,
        ctx.responsive,
        ctx.theme,
        ctx.palette,
        Accessible {
            acc_title: model.acc_title.as_deref(),
            acc_descr: model.acc_descr.as_deref(),
        },
        &content,
    );
    Rendered {
        svg,
        width: total_width,
        height: total_height,
        links: Vec::new(),
    }
}

fn vertical_journey(model: &JourneyModel, ctx: &RenderContext<'_>) -> Rendered {
    let size = ctx.options.font_size.unwrap_or(16.0);
    let small = (size * 0.875).round();
    let pad = ctx.options.padding.unwrap_or(8.0);
    let room = 140.0f64.max(ctx.options.max_width.unwrap_or(320.0) - 2.0 * pad);
    let title = fit_label(model.title.as_deref(), ctx.measurer, size, room, TextStyle::BOLD);
    let names: Vec<String> = journey_actors(&model.tasks).into_iter().filter(|name| !name.is_empty()).collect();
    let actors: HashMap<&str, usize> = names.iter().enumerate().map(|(i, name)| (name.as_str(), i)).collect();
    let rounded = ctx.theme.rounded_standalone();

    let mut y = pad + if title.height > 0.0 { title.height + 16.0 } else { 0.0 };
    let mut section: Option<&str> = None;
    let mut body = String::new();
    let mut width = title.width;
    let head_attrs = format!(r#" class="pele-cluster-label" font-weight="{}""#, ctx.theme.heading_weight());
    let actor_attrs = format!(r#" class="pele-journey-actor" font-size="{}""#, num(small));

    for (index, task) in model.tasks.iter().enumerate() {
        if section != Some(task.section.as_str()) {
            section = Some(task.section.as_str());
            let head = fit_label(Some(&task.section), ctx.measurer, size, room - 16.0, TextStyle::BOLD);
            if head.height > 0.0 {
                body.push_str(&label_svg(
                    &head,
                    pad + 8.0 + head.width / 2.0,
                    y + head.height / 2.0,
                    &head_attrs,
                    ctx.theme,
                    None,
                ));
                width = width.max(head.width + 16.0);
                y += head.height + 8.0;
            }
        }
        let label = fit_label(Some(&task.task), ctx.measurer, small, room - 72.0, TextStyle::NONE);
        let people: Vec<(&str, Label)> = task
            .people
            .iter()
            .map(String::as_str)
            .filter(|name| !name.is_empty())
            .map(|name| (name, fit_label(Some(name), ctx.measurer, small, room - 44.0, TextStyle::NONE)))
            .collect();
        let text_h = label.height.max(42.0);
        let mut h = 2.0 * PAD_Y + text_h;
        for (_, person_label) in &people {
            h += 16.0f64.max(person_label.height) + 4.0;
        }
        let w = room.max(label.width + 72.0);
        body.push_str(&format!(
            r#"<g class="pele-node pele-journey-step" data-id="{index}"><rect x="{}" y="{}" width="{}" height="{}" fill="{}" stroke="{}"{rounded}/>"#,
            num(pad),
            num(y),
            num(w),
            num(h),
            ctx.theme.surface(),
            ctx.theme.border(),
        ));
        body.push_str(&label_svg(
            &label,
            pad + PAD_X + label.width / 2.0,
            y + PAD_Y + label.height / 2.0,
            r#" class="pele-label""#,
            ctx.theme,
            None,
        ));
        let cx = pad + w - 28.0;
        body.push_str(&face_svg(cx, y + PAD_Y + FACE, Mood::from_score(task.score), ctx.theme));
        if !task.score.is_nan() {
            body.push_str(&format!(
                r#"<text class="pele-journey-score" x="{}" y="{}" font-size="{}" text-anchor="middle">{}</text>"#,
                num(cx),
                num(y + PAD_Y + 2.0 * FACE + small),
                num(small),
                num(task.score.clamp(1.0, 5.0)),
            ));
        }
        let mut py = y + PAD_Y + text_h + 4.0;
        for (name, person_label) in &people {
            let ph = 16.0f64.max(person_label.height);
            let series = actors.get(name).copied().unwrap_or(0);
            body.push_str(&format!(
                r#"<circle class="pele-actor" cx="{}" cy="{}" r="{}" fill="{}"/>{}"#,
                num(pad + 16.0),
                num(py + ph / 2.0),
                num(DOT),
                ctx.theme.series_color(series, ctx.palette),
                label_svg(
                    person_label,
                    pad + 28.0 + person_label.width / 2.0,
                    py + ph / 2.0,
                    &actor_attrs,
                    ctx.theme,
                    None
                ),
            ));
            py += ph + 4.0;
        }
        body.push_str("</g>");
        y += h;
        if index + 1 < model.tasks.len() {
            body.push_str(&format!(
                r#"<path class="pele-edge" d="M{},{}v16" fill="none" stroke="{}"/>"#,
                num(pad + w / 2.0),
                num(y),
                ctx.theme.line(),
            ));
        }
        y += 16.0;
        width = width.max(w);
    }

    let total_width = (width + 2.0 * pad).ceil();
    let tail_trim = if model.tasks.is_empty() { 0.0 } else { 16.0 };
    let height = ((pad + title.height).max(y - tail_trim) + pad).ceil();
    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let content = format!(
        "{}{body}",
        label_svg(&title, total_width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, None),
    );
    let svg = svg_document(
        "journey",
        total_width,
        height,
        size,
        ctx.options,
        ctx.responsive,
        ctx.theme,
        ctx.palette,
        Accessible {
            acc_title: model.acc_title.as_deref(),
            acc_descr: model.acc_descr.as_deref(),
        },
        &content,
    );
    Rendered {
        svg,
        width: total_width,
        height,
        links: Vec::new(),
    }
}
