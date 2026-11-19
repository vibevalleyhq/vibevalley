use crate::Rendered;
use crate::diagram::RenderContext;
use crate::diagram::common::{title_room, turn_to_fit};
use crate::measure::{TextMeasurer, TextStyle};
use crate::svg::builder::{esc_text, label_svg, num};
use crate::svg::edges::{ARROW, marker};
use crate::svg::root::{Accessible, svg_document};
use crate::text::label::{Label, layout_label};
use crate::text::literal::break_label;

use super::types::{IshikawaModel, IshikawaNode};

const SLANT: f64 = 0.5;
const FIRST_ROW: f64 = 14.0;
const ROW_GAP: f64 = 6.0;
const BONE_END: f64 = 8.0;
const TWIG_STEP: f64 = 22.0;
const STUB: f64 = 18.0;
const TEXT_GAP: f64 = 5.0;
const PAIR_GAP: f64 = 26.0;
const HEAD_GAP: f64 = 34.0;
const TAIL: f64 = 28.0;
const BOX_PAD_X: f64 = 10.0;
const BOX_PAD_Y: f64 = 5.0;

struct Bone {
    label: Label,
    depth: usize,
    parent: Option<usize>,
    slot: usize,
    kids: usize,
    rise: f64,
    at: f64,
    text_end: f64,
}

struct Category<'a> {
    node: &'a IshikawaNode,
    label: Label,
    box_w: f64,
    box_h: f64,
    bones: Vec<Bone>,
    rise: f64,
    reach: f64,
}

struct Frame<'a> {
    node: &'a IshikawaNode,
    depth: usize,
    parent: Option<usize>,
    slot: usize,
    bone: Option<usize>,
}

fn arrange<'a>(node: &'a IshikawaNode, up: bool, measurer: &dyn TextMeasurer, size: f64, small: f64, ctx: &RenderContext<'_>) -> Category<'a> {
    let label = layout_label(Some(&node.text), false, measurer, size, 180.0, TextStyle::NONE, ctx.icons, None);
    let line_height = (small * 1.5).round();
    let mut bones: Vec<Bone> = Vec::new();
    let mut rows: Vec<usize> = Vec::new();
    let mut stack: Vec<Frame<'a>> = Vec::new();

    let push = |stack: &mut Vec<Frame<'a>>, children: &'a [IshikawaNode], depth: usize, parent: Option<usize>| {
        let n = children.len();
        for slot in (0..n).rev() {
            let child = &children[if up { n - 1 - slot } else { slot }];
            stack.push(Frame {
                node: child,
                depth,
                parent,
                slot,
                bone: None,
            });
        }
    };
    push(&mut stack, &node.children, 2, None);

    while let Some(mut frame) = stack.pop() {
        if let Some(b) = frame.bone {
            rows.push(b);
            continue;
        }
        let index = bones.len();
        bones.push(Bone {
            label: layout_label(Some(&frame.node.text), false, measurer, small, 200.0, TextStyle::NONE, ctx.icons, None),
            depth: frame.depth,
            parent: frame.parent,
            slot: frame.slot,
            kids: frame.node.children.len(),
            rise: 0.0,
            at: 0.0,
            text_end: 0.0,
        });
        let children = &frame.node.children;
        let depth = frame.depth;
        if depth.is_multiple_of(2) {
            rows.push(index);
        } else {
            frame.bone = Some(index);
            stack.push(frame);
        }
        push(&mut stack, children, depth + 1, Some(index));
    }

    let mut rise = FIRST_ROW;
    for index in rows {
        let h = bones[index].label.height.max(line_height) + ROW_GAP;
        bones[index].rise = rise + h / 2.0;
        rise += h;
    }

    let box_w = label.width + 2.0 * BOX_PAD_X;
    let mut reach = box_w / 2.0;
    for idx in 0..bones.len() {
        let depth = bones[idx].depth;
        let parent_idx = bones[idx].parent;
        let slot = bones[idx].slot;
        let kids = bones[idx].kids;
        let (at, text_end) = if depth.is_multiple_of(2) {
            let at = parent_idx.map_or(0.0, |p| bones[p].at);
            let span = if kids > 0 { (kids + 1) as f64 * TWIG_STEP } else { STUB };
            (at, at - span - TEXT_GAP)
        } else {
            let p = &bones[parent_idx.unwrap()];
            let at = p.at - ((p.kids - slot) as f64) * TWIG_STEP;
            (at, at - TEXT_GAP)
        };
        bones[idx].at = at;
        bones[idx].text_end = text_end;
        reach = reach.max(bones[idx].label.width - text_end);
    }

    Category {
        node,
        box_w,
        box_h: label.height + 2.0 * BOX_PAD_Y,
        label,
        bones,
        rise: rise + BONE_END,
        reach,
    }
}

pub fn render_ishikawa(model: &IshikawaModel, ctx: &RenderContext<'_>) -> Rendered {
    turn_to_fit(ctx.options, |down| draw(model, ctx, down))
}

fn draw(model: &IshikawaModel, ctx: &RenderContext<'_>, down: bool) -> Rendered {
    if down {
        return vertical_causes(model, ctx);
    }
    let size = ctx.options.font_size.unwrap_or(16.0);
    let small = (size * 0.875).round();
    let pad = ctx.options.padding.unwrap_or(8.0);
    let length = SLANT.hypot(1.0);

    let title = layout_label(model.title.as_deref(), false, ctx.measurer, size, 4000.0, TextStyle::BOLD, ctx.icons, None);
    let title_height = if title.height > 0.0 { title.height + 12.0 } else { 0.0 };

    let mut body = String::new();
    let mut min_x = 0.0f64;
    let mut max_x = 0.0f64;
    let mut min_y = 0.0f64;
    let mut max_y = 0.0f64;

    if let Some(root) = &model.root {
        let head = layout_label(Some(&root.text), false, ctx.measurer, size, 200.0, TextStyle::BOLD, ctx.icons, None);
        let head_h = (head.height + 24.0).max(48.0);
        let head_w = head.width + 24.0 + head_h / 2.0;

        let mut categories: Vec<Category<'_>> = root
            .children
            .iter()
            .enumerate()
            .map(|(i, node)| arrange(node, i.is_multiple_of(2), ctx.measurer, size, small, ctx))
            .collect();
        for cat in &mut categories {
            cat.rise = cat.rise.max(head_h / 2.0 + 14.0);
        }

        let mut xs: Vec<f64> = Vec::with_capacity(categories.len() + 1);
        let mut x = -HEAD_GAP;
        let mut i = 0usize;
        while i < categories.len() {
            if i > 0 {
                let mut room = 0.0f64;
                for side in 0..2 {
                    if let Some(before) = categories.get(i - 2 + side) {
                        let next_half = categories.get(i + side).map_or(0.0, |n| n.box_w / 2.0);
                        room = room.max(before.reach + next_half);
                    }
                }
                x -= room + PAIR_GAP;
            }
            xs.push(x);
            xs.push(x);
            i += 2;
        }
        let tail = if !categories.is_empty() { x - TAIL } else { -HEAD_GAP };

        max_x = head_w;
        min_x = tail;
        min_y = -head_h / 2.0;
        max_y = head_h / 2.0;

        let rounded = ctx.theme.rounded_standalone();
        let line_color = ctx.theme.line();
        let muted_attr = format!(r#" fill="{}""#, ctx.theme.muted());

        let mut groups = String::new();
        for (idx, cat) in categories.iter().enumerate() {
            let sign: f64 = if idx.is_multiple_of(2) { -1.0 } else { 1.0 };
            let ax = xs[idx];
            let px = |at: f64, rise: f64| ax + at - rise * SLANT;
            let end_x = px(0.0, cat.rise);
            let end_y = sign * cat.rise;
            let trim = ARROW - 1.0;
            let mut d = format!(
                "M{},{}L{},{}",
                num(ax - (SLANT / length) * trim),
                num((sign * trim) / length),
                num(end_x),
                num(end_y),
            );
            let mut texts = String::new();
            for bone in &cat.bones {
                let y = sign * bone.rise;
                if bone.depth.is_multiple_of(2) {
                    d.push_str(&format!(
                        "M{},{}H{}",
                        num(px(bone.at, bone.rise)),
                        num(y),
                        num(px(bone.text_end + TEXT_GAP, bone.rise)),
                    ));
                } else {
                    let from = cat.bones[bone.parent.unwrap()].rise;
                    d.push_str(&format!(
                        "M{},{}L{},{}",
                        num(px(bone.at, from)),
                        num(sign * from),
                        num(px(bone.at, bone.rise)),
                        num(y),
                    ));
                }
                let right = px(bone.text_end, bone.rise);
                let attr = if bone.depth > 2 { muted_attr.as_str() } else { "" };
                texts.push_str(&label_svg(&bone.label, right - bone.label.width / 2.0, y, attr, ctx.theme, ctx.icons));
                min_x = min_x.min(right - bone.label.width);
            }
            let box_y = end_y + sign * (cat.box_h / 2.0);
            min_x = min_x.min(end_x - cat.box_w / 2.0);
            max_x = max_x.max(end_x + cat.box_w / 2.0);
            min_y = min_y.min(box_y - cat.box_h / 2.0);
            max_y = max_y.max(box_y + cat.box_h / 2.0);

            groups.push_str(&format!(
                r#"<g class="pele-ishikawa-category" data-id="{}"><path class="pele-ishikawa-bones" d="{d}" fill="none" stroke="{line_color}"/>{}<rect x="{}" y="{}" width="{}" height="{}" fill="{}" stroke="{}"{rounded}/>{}"#,
                esc_text(&cat.node.text),
                marker("arrow_point", ax, 0.0, SLANT / length, -sign / length, line_color, ""),
                num(end_x - cat.box_w / 2.0),
                num(box_y - cat.box_h / 2.0),
                num(cat.box_w),
                num(cat.box_h),
                ctx.theme.surface(),
                ctx.theme.border(),
                label_svg(&cat.label, end_x, box_y, r#" class="pele-label""#, ctx.theme, ctx.icons),
            ));
            if !texts.is_empty() {
                groups.push_str(&format!(r#"<g class="pele-ishikawa-causes" font-size="{}">{texts}</g>"#, num(small)));
            }
            groups.push_str("</g>");
        }

        let r = head_h / 2.0;
        let head_attrs = format!(r#" class="pele-label" font-weight="{}""#, ctx.theme.heading_weight());
        body = format!(
            r#"<path class="pele-ishikawa-spine" d="M{},0H{}" fill="none" stroke="{line_color}"/>{}{groups}<g class="pele-ishikawa-head" data-id="{}"><path d="M0,{}H{}A{},{} 0 0 1 {},{}H0Z" fill="{}" stroke="{}" stroke-linejoin="round"/>{}</g>"#,
            num(tail),
            num(-(ARROW - 1.0)),
            marker("arrow_point", 0.0, 0.0, 1.0, 0.0, line_color, ""),
            esc_text(&root.text),
            num(-r),
            num(head_w - r),
            num(r),
            num(r),
            num(head_w - r),
            num(r),
            ctx.theme.surface(),
            ctx.theme.border(),
            label_svg(&head, 12.0 + head.width / 2.0, 0.0, &head_attrs, ctx.theme, ctx.icons),
        );
    }

    let inner = (max_x - min_x).max(title.width);
    let width = (inner + 2.0 * pad).ceil();
    let height = (max_y - min_y + title_height + 2.0 * pad).ceil();
    let ox = pad + (inner - (max_x - min_x)) / 2.0 - min_x;
    let oy = pad + title_height - min_y;

    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let mut content = label_svg(&title, width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, ctx.icons);
    if !body.is_empty() {
        content.push_str(&format!(r#"<g transform="translate({},{})">{body}</g>"#, num(ox), num(oy)));
    }
    let svg = svg_document(
        "ishikawa",
        width,
        height,
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
        width,
        height,
        links: Vec::new(),
    }
}

fn vertical_causes(model: &IshikawaModel, ctx: &RenderContext<'_>) -> Rendered {
    let size = ctx.options.font_size.unwrap_or(16.0);
    let small = (size * 0.875).round();
    let pad = ctx.options.padding.unwrap_or(8.0);
    let room = 140.0f64.max(ctx.options.max_width.unwrap_or(320.0) - 2.0 * pad);
    let title = layout_label(
        model.title.as_deref(),
        false,
        ctx.measurer,
        size,
        title_room(ctx.options),
        TextStyle::BOLD,
        ctx.icons,
        None,
    );

    struct Entry<'a> {
        node: &'a IshikawaNode,
        depth: usize,
        parent: Option<usize>,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    }

    let mut order: Vec<Entry<'_>> = Vec::new();
    let mut pending: Vec<(&IshikawaNode, usize, Option<usize>)> = Vec::new();
    if let Some(root) = &model.root {
        pending.push((root, 0, None));
    }
    let mut max_depth = 0usize;
    while let Some((node, depth, parent)) = pending.pop() {
        let index = order.len();
        order.push(Entry {
            node,
            depth,
            parent,
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 0.0,
        });
        max_depth = max_depth.max(depth);
        for child in node.children.iter().rev() {
            pending.push((child, depth + 1, Some(index)));
        }
    }

    let indent = 20.0f64.min(2.0f64.max((room - 120.0) / (max_depth.max(1) as f64)));
    let mut y = pad + if title.height > 0.0 { title.height + 12.0 } else { 0.0 };
    let mut width = title.width;
    let mut nodes_svg = String::new();
    let mut edges_svg = String::new();

    for idx in 0..order.len() {
        let depth = order[idx].depth;
        let x = pad + (depth as f64) * indent;
        let label_room = 60.0f64.max(room - (depth as f64) * indent - 20.0);
        let raw_lbl = layout_label(
            Some(&order[idx].node.text),
            false,
            ctx.measurer,
            if depth < 2 { size } else { small },
            label_room,
            if depth < 2 { TextStyle::BOLD } else { TextStyle::NONE },
            ctx.icons,
            None,
        );
        let lbl = break_label(raw_lbl, ctx.measurer, label_room);
        let w = lbl.width + 20.0;
        let h = lbl.height + 12.0;
        order[idx].x = x;
        order[idx].y = y;
        order[idx].w = w;
        order[idx].h = h;
        let cur_y = y;
        y += h + 12.0;
        width = width.max(x - pad + w);

        let cls = match depth {
            0 => "pele-ishikawa-head",
            1 => "pele-ishikawa-category",
            _ => "pele-ishikawa-cause",
        };
        nodes_svg.push_str(&format!(r#"<g class="pele-node {cls}" data-id="{}">"#, esc_text(&order[idx].node.text)));
        if depth < 2 {
            let rx = if depth == 0 { 12 } else { 4 };
            nodes_svg.push_str(&format!(
                r#"<rect x="{}" y="{}" width="{}" height="{}" rx="{rx}" fill="{}" stroke="{}"/>"#,
                num(x),
                num(cur_y),
                num(w),
                num(h),
                ctx.theme.surface(),
                ctx.theme.border(),
            ));
        }
        let mut lbl_attrs = String::from(r#" class="pele-label""#);
        if depth < 2 {
            lbl_attrs.push_str(&format!(r#" font-weight="{}""#, ctx.theme.heading_weight()));
        }
        if depth > 1 {
            lbl_attrs.push_str(&format!(r#" font-size="{}""#, num(small)));
        }
        nodes_svg.push_str(&label_svg(&lbl, x + w / 2.0, cur_y + h / 2.0, &lbl_attrs, ctx.theme, ctx.icons));
        nodes_svg.push_str("</g>");

        if let Some(p_idx) = order[idx].parent {
            let p = &order[p_idx];
            let gx = p.x + indent / 2.0;
            edges_svg.push_str(&format!(
                r#"<path class="pele-edge" d="M{},{}V{}H{}" fill="none" stroke="{}"/>"#,
                num(gx),
                num(p.y + p.h),
                num(cur_y + h / 2.0),
                num(x),
                ctx.theme.border(),
            ));
        }
    }

    let total_width = (width + 2.0 * pad).ceil();
    let total_height = ((pad + title.height).max(y - 12.0) + pad).ceil();
    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let content = format!(
        "{}{edges_svg}{nodes_svg}",
        label_svg(&title, total_width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, ctx.icons),
    );
    let svg = svg_document(
        "ishikawa",
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
        links: Vec::new(),
    }
}
