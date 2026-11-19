use crate::diagram::RenderContext;
use crate::diagram::common::{icon_svg, title_room};
use crate::measure::TextStyle;
use crate::svg::builder::{esc, esc_text, label_svg, num, text_style};
use crate::svg::root::{Accessible, svg_document};
use crate::svg::theme::{SvgTheme, class_names};
use crate::svg::title::title_label;
use crate::text::label::{Label, Span, layout_label, with_heights};
use crate::util::url::{link_url, rel_attr, safe_url};
use crate::util::yaml::YamlValue;
use crate::{LinkInfo, Rendered};

use super::db::{KanbanModel, KanbanNode};

const COLUMN_GAP: f64 = 12.0;
const COLUMN_PAD: f64 = 8.0;
const CARD_PAD: f64 = 10.0;
const CARD_GAP: f64 = 8.0;
const META_GAP: f64 = 4.0;
const ICON_GAP: f64 = 6.0;

fn priority_stroke(priority: &str, theme: &SvgTheme) -> Option<String> {
    match priority {
        "very high" => Some(format!(r#"stroke="{}""#, theme.critical())),
        "high" => Some(format!(r#"stroke="{}" opacity="0.5""#, theme.critical())),
        "low" => Some(format!(r#"stroke="{}" opacity="0.5""#, theme.muted())),
        "very low" => Some(format!(r#"stroke="{}""#, theme.muted())),
        _ => None,
    }
}

fn fit_label(raw: Option<&str>, markdown: bool, size: f64, max: f64, base: TextStyle, ctx: &RenderContext<'_>) -> Label {
    let label = layout_label(raw, markdown, ctx.measurer, size, max, base, ctx.icons, ctx.math);
    if label.width <= max {
        return label;
    }
    let has_heights = label.heights.is_some();
    let mut lines: Vec<Vec<Span>> = Vec::new();
    let mut widths: Vec<f64> = Vec::new();
    let mut widest = 0.0f64;

    let mut line: Vec<Span> = Vec::new();
    let mut width = 0.0f64;
    let commit = |line: &mut Vec<Span>, width: &mut f64, lines: &mut Vec<Vec<Span>>, widths: &mut Vec<f64>, widest: &mut f64| {
        lines.push(std::mem::take(line));
        widths.push(*width);
        *widest = widest.max(*width);
        *width = 0.0;
    };

    for (i, src_line) in label.lines.iter().enumerate() {
        if label.widths[i] <= max {
            line = src_line.clone();
            width = label.widths[i];
            commit(&mut line, &mut width, &mut lines, &mut widths, &mut widest);
            continue;
        }
        for span in src_line {
            if span.icon.is_some() || span.math.is_some() {
                if width > 0.0 && width + span.width > max {
                    commit(&mut line, &mut width, &mut lines, &mut widths, &mut widest);
                }
                line.push(span.clone());
                width += span.width;
                continue;
            }
            let mut text = String::new();
            let mut from = width;
            for ch in span.text.chars() {
                let mut buf = [0u8; 4];
                let w = ctx.measurer.width(ch.encode_utf8(&mut buf), size, span.style);
                if width > 0.0 && width + w > max {
                    if !text.is_empty() {
                        line.push(Span::plain(std::mem::take(&mut text), span.style, width - from));
                    }
                    commit(&mut line, &mut width, &mut lines, &mut widths, &mut widest);
                    from = 0.0;
                }
                text.push(ch);
                width += w;
            }
            if !text.is_empty() {
                line.push(Span::plain(text, span.style, width - from));
            }
        }
        commit(&mut line, &mut width, &mut lines, &mut widths, &mut widest);
    }

    let fitted = Label {
        height: (lines.len() as f64) * label.line_height,
        lines,
        widths,
        width: widest,
        size: label.size,
        line_height: label.line_height,
        heights: None,
    };
    if has_heights { with_heights(fitted) } else { fitted }
}

fn text_block(label: &Label, x: f64, y: f64, attrs: &str, ctx: &RenderContext<'_>, end: bool) -> String {
    let mut out = String::new();
    for (i, line) in label.lines.iter().enumerate() {
        let cy = y + label.line_middle(i);
        if line.len() == 1
            && line[0].icon.is_none()
            && line[0].math.is_none()
            && !(line[0].style.contains(TextStyle::SUB) || line[0].style.contains(TextStyle::SUP) || line[0].style.contains(TextStyle::UNDERLINE))
        {
            let anchor = if end { r#" text-anchor="end""# } else { "" };
            out.push_str(&format!(
                r#"<text{} x="{}" y="{}"{anchor}>{}</text>"#,
                text_style(attrs, line[0].style, ctx.theme),
                num(x),
                num(cy + label.size * 0.35),
                esc(&line[0].text),
            ));
        } else {
            let width = label.widths[i];
            let cx = x + if end { -width } else { width } / 2.0;
            let single = label.single_line(i);
            out.push_str(&label_svg(&single, cx, cy, attrs, ctx.theme, ctx.icons));
        }
    }
    out
}

struct Card<'a> {
    item: &'a KanbanNode,
    label: Label,
    ticket: Label,
    assigned: Label,
    meta: f64,
    height: f64,
}

pub fn render_kanban(model: &KanbanModel, ctx: &RenderContext<'_>) -> Rendered {
    let size = ctx.options.font_size.unwrap_or(16.0);
    let small = (size * 0.875).round();
    let line = (size * 1.5).round();
    let small_line = (small * 1.5).round();
    let pad = ctx.options.padding.unwrap_or(8.0);
    let conf = ctx.config.section("kanban");
    let section_width = conf.and_then(|s| s.get("sectionWidth")).and_then(YamlValue::as_f64);
    let glyph = small * 1.25;

    let has = |name: Option<&str>| -> bool { name.is_some_and(|n| !n.is_empty() && ctx.icons.and_then(|f| f(n)).is_some_and(|m| !m.is_empty())) };

    let mut math_width = 0.0f64;
    let mut holds = |raw: Option<&str>, font_size: f64, reserved: f64| {
        let Some(text) = raw else {
            return;
        };
        if !text.contains("$$") {
            return;
        }
        let lbl = layout_label(Some(text), true, ctx.measurer, font_size, f64::INFINITY, TextStyle::NONE, ctx.icons, ctx.math);
        for spans in &lbl.lines {
            for span in spans {
                if let Some(m) = &span.math {
                    math_width = math_width.max(m.width + reserved);
                }
            }
        }
    };

    for section in &model.sections {
        let count_str = section.items.len().to_string();
        let count_w = ctx.measurer.width(&count_str, small, TextStyle::NONE);
        let icon_w = if has(section.node.icon.as_deref()) { glyph + ICON_GAP } else { 0.0 };
        holds(Some(&section.node.label), size, 2.0 * COLUMN_PAD + 8.0 + count_w + 12.0 + icon_w);
        for item in &section.items {
            let reserved = 2.0 * (COLUMN_PAD + CARD_PAD);
            let item_icon_w = if has(item.icon.as_deref()) { glyph + ICON_GAP } else { 0.0 };
            holds(Some(&item.label), small, reserved + item_icon_w);
            holds(item.ticket.as_deref(), small, reserved);
            holds(item.assigned.as_deref(), small, reserved);
        }
    }

    let base_col = match section_width {
        Some(sw) if sw.is_finite() && sw > 0.0 => sw.clamp(80.0, 2000.0),
        _ => 200.0,
    };
    let own_width = base_col.max(math_width.ceil());

    let room = match ctx.options.max_width {
        Some(mw) if mw > 0.0 => mw - 2.0 * pad,
        _ => f64::INFINITY,
    };
    let count = model.sections.len();
    let fits = (count as f64) * (own_width + COLUMN_GAP) - COLUMN_GAP <= room;
    let per_row = if fits {
        count.max(1)
    } else {
        (((room + COLUMN_GAP) / (own_width + COLUMN_GAP)).floor() as isize).max(1) as usize
    };
    let column_width = if fits {
        own_width
    } else {
        let divided = (((room + COLUMN_GAP) / (per_row as f64)).floor() - COLUMN_GAP).min(own_width * 2.0);
        own_width.min(room).max(divided).max(math_width.ceil())
    };
    let base_url = conf.and_then(|s| s.get("ticketBaseUrl")).and_then(YamlValue::as_str).unwrap_or("");
    let card_width = column_width - 2.0 * COLUMN_PAD;
    let text_width = card_width - 2.0 * CARD_PAD;
    let mut links: Vec<LinkInfo> = Vec::new();

    let sections = &model.sections;
    let mut titles: Vec<Label> = Vec::with_capacity(sections.len());
    let mut count_widths: Vec<f64> = Vec::with_capacity(sections.len());
    let mut cards: Vec<Vec<Card<'_>>> = Vec::with_capacity(sections.len());
    let mut head_height = line;
    let mut body_heights: Vec<f64> = Vec::with_capacity(sections.len());

    for section in sections {
        let count_str = section.items.len().to_string();
        let count_w = ctx.measurer.width(&count_str, small, TextStyle::NONE);
        let reserved = count_w + 12.0 + if has(section.node.icon.as_deref()) { glyph + ICON_GAP } else { 0.0 };
        let title_lbl = fit_label(Some(&section.node.label), true, size, card_width - 8.0 - reserved, TextStyle::BOLD, ctx);
        head_height = head_height.max(title_lbl.height);
        count_widths.push(count_w);
        titles.push(title_lbl);

        let mut list = Vec::with_capacity(section.items.len());
        let mut height = 0.0f64;
        for item in &section.items {
            let item_icon_w = if has(item.icon.as_deref()) { glyph + ICON_GAP } else { 0.0 };
            let label = fit_label(Some(&item.label), true, small, text_width - item_icon_w, TextStyle::NONE, ctx);
            let ticket = fit_label(item.ticket.as_deref(), false, small, text_width, TextStyle::NONE, ctx);
            let assigned = fit_label(item.assigned.as_deref(), false, small, text_width, TextStyle::NONE, ctx);
            let meta = if ticket.width + assigned.width + 8.0 > text_width {
                ticket.height + assigned.height
            } else {
                ticket.height.max(assigned.height)
            };
            let card_height = 2.0 * CARD_PAD + label.height.max(small_line) + if meta > 0.0 { META_GAP + meta } else { 0.0 };
            list.push(Card {
                item,
                label,
                ticket,
                assigned,
                meta,
                height: card_height,
            });
            height += card_height + CARD_GAP;
        }
        cards.push(list);
        body_heights.push(height);
    }
    head_height += 2.0 * COLUMN_PAD;

    let mut row_heights: Vec<f64> = Vec::new();
    let mut row_tops: Vec<f64> = Vec::new();
    let mut first = 0usize;
    let mut y_acc = 0.0f64;
    while first < sections.len() {
        let mut tallest = CARD_GAP;
        for &bh in &body_heights[first..sections.len().min(first + per_row)] {
            tallest = tallest.max(bh);
        }
        row_tops.push(y_acc);
        row_heights.push(head_height + tallest);
        y_acc += head_height + tallest + COLUMN_GAP;
        first += per_row;
    }
    let board_height = if row_heights.is_empty() {
        0.0
    } else {
        row_tops.last().unwrap() + row_heights.last().unwrap()
    };

    let title = title_label(model.title.as_deref(), ctx.measurer, size, title_room(ctx.options));
    let title_height = if title.height > 0.0 { title.height + 16.0 } else { 0.0 };
    let board_width = ((sections.len().min(per_row) as f64) * (column_width + COLUMN_GAP) - COLUMN_GAP).max(0.0);
    let width = board_width.max(title.width);
    let left = pad + (width - board_width) / 2.0;
    let edge = column_width - COLUMN_PAD - 4.0;

    let rounded = ctx.theme.rounded_standalone();
    let col_label_attrs = format!(r#" class="pele-cluster-label" font-weight="{}""#, ctx.theme.heading_weight());
    let ticket_muted = format!(r#" class="pele-ticket" fill="{}""#, ctx.theme.muted());
    let ticket_link = format!(r#" class="pele-ticket" fill="{}""#, ctx.theme.accent());
    let assigned_attrs = format!(r#" class="pele-assigned" fill="{}""#, ctx.theme.muted());

    let mut out = String::new();
    for (index, section) in sections.iter().enumerate() {
        let row = index / per_row;
        let mut body = format!(
            r#"<rect width="{}" height="{}" fill="{}"{rounded}/>{}<text class="pele-count" x="{}" y="{}" text-anchor="end" font-size="{}" fill="{}">{}</text>"#,
            num(column_width),
            num(row_heights[row]),
            ctx.theme.surface(),
            text_block(&titles[index], COLUMN_PAD + 4.0, COLUMN_PAD, &col_label_attrs, ctx, false),
            num(edge),
            num(COLUMN_PAD + line / 2.0 + small * 0.35),
            num(small),
            ctx.theme.muted(),
            section.items.len(),
        );
        if has(section.node.icon.as_deref()) {
            body.push_str(&icon_svg(
                section.node.icon.as_deref().unwrap(),
                edge - count_widths[index] - ICON_GAP - glyph,
                COLUMN_PAD + (line - glyph) / 2.0,
                glyph,
                ctx.icons,
            ));
        }

        let mut y = head_height;
        for card in &cards[index] {
            let item = card.item;
            let priority = item.priority.as_deref().unwrap_or("").trim().to_ascii_lowercase();
            let color = priority_stroke(&priority, ctx.theme);
            let mut inner = format!(
                r#"<rect width="{}" height="{}" fill="{}" stroke="{}"{rounded}/>"#,
                num(card_width),
                num(card.height),
                ctx.theme.bg(),
                ctx.theme.border(),
            );
            if let Some(ref stroke) = color {
                inner.push_str(&format!(
                    r#"<path class="pele-priority" d="M2.5,5V{}" fill="none" {stroke} stroke-width="3" stroke-linecap="round"/>"#,
                    num(card.height - 5.0),
                ));
            }
            inner.push_str(&text_block(&card.label, CARD_PAD, CARD_PAD, r#" class="pele-label""#, ctx, false));
            if has(item.icon.as_deref()) {
                inner.push_str(&icon_svg(
                    item.icon.as_deref().unwrap(),
                    card_width - CARD_PAD - glyph,
                    CARD_PAD + (small_line - glyph) / 2.0,
                    glyph,
                    ctx.icons,
                ));
            }
            let bottom = card.height - CARD_PAD;
            if let Some(ref ticket_str) = item.ticket {
                let top = bottom - card.meta;
                let resolved_url = if !base_url.is_empty() {
                    let replaced = base_url.replacen("#TICKET#", ticket_str, 1);
                    let sanitized = safe_url(&replaced);
                    link_url(&sanitized, ctx.options).map(str::to_string)
                } else {
                    None
                };
                if let Some(href) = resolved_url {
                    inner.push_str(&format!(
                        r#"<a href="{}" target="_blank"{}>{}</a>"#,
                        esc(&href),
                        rel_attr(ctx.options),
                        text_block(&card.ticket, CARD_PAD, top, &ticket_link, ctx, false),
                    ));
                    links.push(LinkInfo {
                        id: item.id.clone(),
                        href,
                        internal: false,
                    });
                } else {
                    inner.push_str(&text_block(&card.ticket, CARD_PAD, top, &ticket_muted, ctx, false));
                }
            }
            if item.assigned.is_some() {
                inner.push_str(&text_block(
                    &card.assigned,
                    card_width - CARD_PAD,
                    bottom - card.assigned.height,
                    &assigned_attrs,
                    ctx,
                    true,
                ));
            }
            let prio_cls = if color.is_some() {
                format!(" pele-priority-{}", priority.replace(' ', "-"))
            } else {
                String::new()
            };
            let extra_cls = class_names(item.css_classes.as_deref().unwrap_or(""));
            body.push_str(&format!(
                r#"<g class="pele-node pele-card{prio_cls}{extra_cls}" data-id="{}" transform="translate({},{})" font-size="{}">{inner}</g>"#,
                esc_text(&item.id),
                num(COLUMN_PAD),
                num(y),
                num(small),
            ));
            y += card.height + CARD_GAP;
        }

        let sec_cls = class_names(section.node.css_classes.as_deref().unwrap_or(""));
        out.push_str(&format!(
            r#"<g class="pele-cluster pele-column{sec_cls}" data-id="{}" transform="translate({},{})">{body}</g>"#,
            esc_text(&section.node.id),
            num(left + ((index % per_row) as f64) * (column_width + COLUMN_GAP)),
            num(pad + title_height + row_tops[row]),
        ));
    }

    let total_width = (width + 2.0 * pad).ceil();
    let total_height = (board_height + title_height + 2.0 * pad).ceil();
    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let content = format!(
        "{}{out}",
        label_svg(&title, total_width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, ctx.icons),
    );

    let svg = svg_document(
        "kanban",
        total_width,
        total_height,
        size,
        ctx.options,
        ctx.responsive,
        ctx.theme,
        ctx.palette,
        Accessible::default(),
        &content,
    );
    Rendered {
        svg,
        width: total_width,
        height: total_height,
        links,
    }
}
