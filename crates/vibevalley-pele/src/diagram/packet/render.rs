use std::collections::HashMap;

use crate::Rendered;
use crate::diagram::RenderContext;
use crate::diagram::common::{Fitted, fit_text, title_room, turn_to_fit};
use crate::measure::TextStyle;
use crate::svg::builder::{esc, label_svg, num};
use crate::svg::root::{Accessible, svg_document};
use crate::text::entities::decode_entities;
use crate::text::label::{Label, layout_label};
use crate::text::literal::literal_label;
use crate::util::yaml::YamlValue;

use super::model::{PacketBlock, PacketModel, packet_option};

pub fn render_packet(model: &PacketModel, ctx: &RenderContext<'_>) -> Rendered {
    turn_to_fit(ctx.options, |down| draw(model, ctx, down))
}

fn draw(model: &PacketModel, ctx: &RenderContext<'_>, down: bool) -> Rendered {
    let size = ctx.options.font_size.unwrap_or(16.0);
    let label_size = (size * 0.875).round();
    let bit_size = (size * 0.625).round();
    let pad = ctx.options.padding.unwrap_or(8.0);

    let packet = ctx.config.section("packet");
    let row_height = packet_option(ctx.config, "rowHeight", 32.0, 1.0, 400.0);
    let mut bit_width = packet_option(ctx.config, "bitWidth", 32.0, 1.0, 400.0);
    let padding_x = packet_option(ctx.config, "paddingX", 5.0, 0.0, 400.0);
    let padding_y = packet_option(ctx.config, "paddingY", 5.0, 0.0, 400.0);
    let show_bits = packet.and_then(|s| s.get("showBits")).and_then(YamlValue::as_bool) != Some(false);
    let descending = packet.and_then(|s| s.get("bitOrder")).and_then(YamlValue::as_str) == Some("descending");

    let mut bits_per_row = model.bits_per_row;
    let rewrapped_rows: Vec<Vec<PacketBlock>>;
    let rows: &[Vec<PacketBlock>] = if down {
        let count = (((ctx.options.max_width.unwrap_or(320.0) - 2.0 * pad) / bit_width.min(18.0)).floor() as i64).max(1) as f64;
        let pow2 = 2u64.pow(count.log2().floor() as u32);
        bits_per_row = bits_per_row.min(8u64.max(pow2));
        let last = model.rows.last().and_then(|r| r.last()).map_or(0, |b| b.end);
        if (last + 1).div_ceil(bits_per_row) > 10_000 {
            bits_per_row = model.bits_per_row;
        }
        bit_width = bit_width.min(18.0f64.max((ctx.options.max_width.unwrap_or(320.0) - 2.0 * pad) / (bits_per_row as f64)));

        let is_piece = |b: &PacketBlock| b.bits == b.end - b.start;
        let mut whole: Vec<PacketBlock> = Vec::new();
        for row in &model.rows {
            for block in row {
                let merge = whole.last().is_some_and(|prev| {
                    is_piece(prev)
                        && is_piece(block)
                        && prev.label == block.label
                        && block.start == prev.end + 1
                        && block.start.is_multiple_of(model.bits_per_row)
                });
                if merge {
                    let prev = whole.last_mut().unwrap();
                    prev.end = block.end;
                    prev.bits = prev.end - prev.start;
                } else {
                    whole.push(block.clone());
                }
            }
        }
        let mut built: Vec<Vec<PacketBlock>> = Vec::new();
        for block in &whole {
            let mut start = block.start;
            while start <= block.end {
                let end = block.end.min(((start / bits_per_row) + 1) * bits_per_row - 1);
                let index = (start / bits_per_row) as usize;
                if built.len() <= index {
                    built.resize_with(index + 1, Vec::new);
                }
                built[index].push(PacketBlock {
                    start,
                    end,
                    bits: block.bits,
                    label: block.label.clone(),
                });
                start = end + 1;
            }
        }
        rewrapped_rows = built;
        &rewrapped_rows
    } else {
        &model.rows
    };

    let mut down_labels: Vec<Vec<Label>> = Vec::new();
    if down {
        for row in rows {
            let mut row_labels = Vec::with_capacity(row.len());
            for block in row {
                let room = 1.0f64.max((block.end - block.start + 1) as f64 * bit_width - padding_x.min(bit_width - 1.0) - 6.0);
                let decoded = decode_entities(&block.label);
                row_labels.push(literal_label(decoded.trim(), ctx.measurer, label_size, room, TextStyle::NONE));
            }
            down_labels.push(row_labels);
        }
    }

    let numbers = if show_bits { bit_size + 4.0 } else { 0.0 };
    let row_heights: Vec<f64> = rows
        .iter()
        .enumerate()
        .map(|(r_idx, _)| {
            let mut h = row_height;
            if down {
                for lbl in &down_labels[r_idx] {
                    h = h.max(lbl.height + 10.0);
                }
            }
            h
        })
        .collect();
    let mut tops: Vec<f64> = Vec::with_capacity(row_heights.len());
    let mut rows_height = 0.0f64;
    for &h in &row_heights {
        tops.push(rows_height);
        rows_height += numbers + h + padding_y;
    }
    if !rows.is_empty() {
        rows_height -= padding_y;
    }

    let gap = padding_x.min(bit_width - 1.0);
    let width = if !rows.is_empty() { (bits_per_row as f64) * bit_width - gap } else { 0.0 };
    let title = layout_label(
        model.title.as_deref(),
        false,
        ctx.measurer,
        size,
        if down { title_room(ctx.options) } else { 4000.0 },
        TextStyle::BOLD,
        ctx.icons,
        None,
    );
    let title_height = if title.height > 0.0 {
        title.height + if rows_height > 0.0 { 12.0 } else { 0.0 }
    } else {
        0.0
    };

    let min_font = (size * 0.5).round();
    let mut fits_cache: HashMap<(&str, u64), Option<Fitted>> = HashMap::new();

    let left = pad + ((title.width - width) / 2.0).max(0.0);
    let mut fields = String::new();
    let mut bits_svg = String::new();
    let rounded = ctx.theme.rounded_standalone();

    for (index, row) in rows.iter().enumerate() {
        let y = pad + tops[index] + numbers;
        let rh = row_heights[index];
        for (b_idx, block) in row.iter().enumerate() {
            let count = block.end - block.start + 1;
            let first = block.start % bits_per_row;
            let col = if descending { bits_per_row - first - count } else { first };
            let x = left + (col as f64) * bit_width;
            let w = (count as f64) * bit_width - gap;

            fields.push_str(&format!(
                r#"<g class="pele-node" data-id="{}-{}"><rect x="{}" y="{}" width="{}" height="{}" fill="{}" stroke="{}"{rounded}/>"#,
                block.start,
                block.end,
                num(x),
                num(y),
                num(w),
                num(rh),
                ctx.theme.surface(),
                ctx.theme.border(),
            ));
            if down {
                fields.push_str(&label_svg(&down_labels[index][b_idx], x + w / 2.0, y + rh / 2.0, "", ctx.theme, ctx.icons));
            } else {
                let max_w = w - 6.0;
                let key = (block.label.as_str(), max_w.to_bits());
                let fitted = fits_cache.entry(key).or_insert_with(|| {
                    let decoded = decode_entities(&block.label);
                    fit_text(decoded.trim(), max_w, label_size, min_font, ctx.measurer, TextStyle::NONE)
                });
                if let Some(text) = fitted
                    && text.size <= rh
                {
                    let fs_attr = if (text.size - label_size).abs() < f64::EPSILON {
                        String::new()
                    } else {
                        format!(r#" font-size="{}""#, num(text.size))
                    };
                    fields.push_str(&format!(
                        r#"<text x="{}" y="{}"{fs_attr}>{}</text>"#,
                        num(x + w / 2.0),
                        num(y + rh / 2.0 + text.size * 0.35),
                        esc(&text.text),
                    ));
                }
            }
            fields.push_str("</g>");

            if !show_bits {
                continue;
            }
            let leading = if descending { block.end } else { block.start };
            let trailing = if descending { block.start } else { block.end };
            if count == 1 {
                bits_svg.push_str(&format!(
                    r#"<text x="{}" y="{}" text-anchor="middle">{leading}</text>"#,
                    num(x + w / 2.0),
                    num(y - 4.0),
                ));
            } else {
                bits_svg.push_str(&format!(
                    r#"<text x="{}" y="{}">{leading}</text><text x="{}" y="{}" text-anchor="end">{trailing}</text>"#,
                    num(x),
                    num(y - 4.0),
                    num(x + w),
                    num(y - 4.0),
                ));
            }
        }
    }

    let total_width = (width.max(title.width) + 2.0 * pad).ceil();
    let total_height = (rows_height + title_height + 2.0 * pad).ceil();
    let mut content = String::new();
    if !fields.is_empty() {
        content.push_str(&format!(
            r#"<g class="pele-packet-fields" font-size="{}" text-anchor="middle">{fields}</g>"#,
            num(label_size),
        ));
    }
    if !bits_svg.is_empty() {
        content.push_str(&format!(
            r#"<g class="pele-packet-bits" font-size="{}" fill="{}">{bits_svg}</g>"#,
            num(bit_size),
            ctx.theme.muted(),
        ));
    }
    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    content.push_str(&label_svg(
        &title,
        total_width / 2.0,
        total_height - pad - title.height / 2.0,
        &title_attrs,
        ctx.theme,
        ctx.icons,
    ));

    let svg = svg_document(
        "packet",
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
