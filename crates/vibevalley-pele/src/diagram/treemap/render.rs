use crate::Rendered;
use crate::config::DiagramConfig;
use crate::diagram::RenderContext;
use crate::diagram::common::{cap_width, fit_text, title_room};
use crate::measure::TextStyle;
use crate::svg::builder::{esc, esc_text, label_svg, num};
use crate::svg::ink::ink_fill;
use crate::svg::root::{Accessible, svg_document};
use crate::svg::theme::{SvgTheme, class_names, resolve_style, sets_fill};
use crate::text::entities::decode_entities;
use crate::text::label::layout_label;
use crate::util::yaml::YamlValue;

use super::format::ValueFormatter;
use super::layout::{BoxNode, Insets, layout_treemap};
use super::model::{TreemapModel, TreemapNode};

const HEADER: f64 = 28.0;
const SHORT_HEADER: f64 = 18.0;
const SIDE: f64 = 6.0;
const LINE: f64 = 1.25;

fn title_part(raw: &str) -> String {
    esc(decode_entities(raw).trim()).trim().to_string()
}

fn leaf_count(roots: &[TreemapNode]) -> usize {
    let mut count = 0usize;
    let mut stack: Vec<&TreemapNode> = roots.iter().collect();
    while let Some(node) = stack.pop() {
        if let Some(children) = &node.children {
            stack.extend(children.iter());
        } else if node.value.is_some_and(|v| v.is_finite() && v > 0.0) {
            count += 1;
        }
    }
    count
}

fn corners(attrs: &str, b: &BoxNode<'_>, theme: &SvgTheme) -> String {
    let cap = b.w.min(b.h) / 4.0;
    if theme.is_resolved() {
        if attrs.contains(" rx=") || attrs.contains("rx:") {
            return attrs.to_string();
        }
        let base_r = theme
            .rounded_standalone()
            .trim()
            .strip_prefix(r#"rx=""#)
            .and_then(|s| s.strip_suffix('"'))
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(4.0);
        let r = base_r.min(cap).max(0.0);
        format!(r#"{attrs} rx="{}""#, num(r))
    } else if cap < 4.0 {
        theme.rounded(attrs).replace("rx:var(--_r)", &format!("rx:min(var(--_r),{}px)", num(cap)))
    } else {
        theme.rounded(attrs)
    }
}

fn option(config: &DiagramConfig, key: &str, fallback: f64, min: f64, max: f64) -> f64 {
    let val = config.section("treemap").and_then(|s| s.get(key)).and_then(YamlValue::as_f64);
    match val {
        Some(v) if v.is_finite() && v >= min => v.min(max),
        _ => fallback,
    }
}

pub fn render_treemap(model: &TreemapModel, ctx: &RenderContext<'_>) -> Rendered {
    let size = ctx.options.font_size.unwrap_or(16.0);
    let small = (size * 0.875).round();
    let tiny = (size * 0.75).round();
    let least = (size * 0.5625).round();
    let treemap = ctx.config.section("treemap");
    let pad = ctx.options.padding.unwrap_or_else(|| option(ctx.config, "diagramPadding", 8.0, 0.0, 2000.0));

    let width = cap_width(ctx.options, option(ctx.config, "nodeWidth", 64.0, 1.0, 400.0) * 10.0, 200.0, 2.0 * pad).round();
    let height = (option(ctx.config, "nodeHeight", 40.0, 1.0, 400.0) * 10.0).round();
    let show_values = treemap.and_then(|s| s.get("showValues")).and_then(YamlValue::as_bool) != Some(false);
    let fmt = ValueFormatter::from_spec(treemap.and_then(|s| s.get("valueFormat")).and_then(YamlValue::as_str).unwrap_or(","));
    let leaves_n = leaf_count(&model.roots).max(1) as f64;
    let crowd = ((width * height) / leaves_n / 800.0).log10().clamp(0.0, 1.0);
    let layout = layout_treemap(
        &model.roots,
        width,
        height,
        Insets {
            gap: option(ctx.config, "padding", (2.0 + 2.0 * crowd).round(), 0.0, 200.0),
            header: HEADER,
            short: SHORT_HEADER,
            side: (3.0 + 3.0 * crowd).round(),
        },
    );

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
    let title_height = if title.height > 0.0 { title.height + 8.0 } else { 0.0 };
    let left = pad + ((title.width - width) / 2.0).max(0.0);
    let top = pad + title_height;

    let mut sections_svg = String::new();
    let mut leaves_svg = String::new();

    for &box_id in &layout.placed {
        let b = &layout.boxes[box_id];
        let node = b.node;
        let style = resolve_style(node.css_compiled_styles.as_deref().unwrap_or(&[]));
        let color = ctx.theme.series_color(b.series, ctx.palette);
        let x = left + b.x;
        let y = top + b.y;
        let decoded_name = decode_entities(&node.name);
        let name = decoded_name.trim();
        let value = if show_values { fmt.format(b.value) } else { String::new() };
        let group_id = format!(r#"data-id="{}">"#, esc_text(&node.name));

        let own = title_part(&node.name);
        let mut path_parts: Vec<String> = if own.is_empty() { Vec::new() } else { vec![own.clone()] };
        let mut p_opt = b.parent;
        while let Some(pid) = p_opt {
            let p = &layout.boxes[pid];
            if p.headed {
                break;
            }
            let sec = title_part(&p.node.name);
            if !sec.is_empty() {
                path_parts.insert(0, sec);
            }
            p_opt = p.parent;
        }
        let full = path_parts.join(" › ");
        let tooltip = |drawn: Option<&str>| -> String {
            if full.is_empty() || (drawn == Some(name) && full == own) {
                String::new()
            } else {
                format!("<title>{full}</title>")
            }
        };

        let rect_prefix = format!(
            r#"<rect x="{}" y="{}" width="{}" height="{}" fill="{color}""#,
            num(x),
            num(y),
            num(b.w),
            num(b.h),
        );
        let fixed = style.font_size;
        let mut text_style = TextStyle::NONE;
        if style.bold {
            text_style |= TextStyle::BOLD;
        }
        if style.italic {
            text_style |= TextStyle::ITALIC;
        }
        let ink = if sets_fill(&style.shape) {
            ink_fill(&style.shape, &style.text, ctx.theme, None)
        } else {
            ctx.palette.series_ink_fill(b.series, ctx.theme)
        };
        let extra_cls = class_names(node.class_selector.as_deref().unwrap_or(""));

        if node.children.is_some() {
            let mut text = String::new();
            let mut drawn: Option<String> = None;
            if b.headed {
                let is_short = b.header < HEADER;
                let label_size = fixed.unwrap_or(if is_short { tiny } else { small });
                let value_size = fixed.unwrap_or(tiny);
                let room = b.w - 2.0 * SIDE - 4.0;
                let value_width = if !value.is_empty() {
                    ctx.measurer.width(&value, value_size, text_style)
                } else {
                    0.0
                };
                let with_value = !is_short && value_width > 0.0 && room - value_width - 12.0 >= 3.0 * label_size;
                let fitted = if label_size * LINE < b.header {
                    let avail = if with_value { room - value_width - 12.0 } else { room };
                    fit_text(name, avail, label_size, label_size, ctx.measurer, text_style | TextStyle::BOLD)
                } else {
                    None
                };
                let baseline = y + b.header / 2.0 + 1.0;
                if let Some(lbl) = fitted {
                    let fs_attr = if is_short {
                        format!(r#" font-size="{}""#, num(label_size))
                    } else {
                        String::new()
                    };
                    text.push_str(&format!(
                        r#"<text x="{}" y="{}" font-weight="{}"{fs_attr}{ink}{}>{}</text>"#,
                        num(x + SIDE + 2.0),
                        num(baseline + label_size * 0.35),
                        ctx.theme.heading_weight(),
                        style.text,
                        esc(&lbl.text),
                    ));
                    drawn = Some(lbl.text);
                }
                if with_value && value_size * LINE <= HEADER {
                    let val_fill = if ink.is_empty() {
                        format!(r#" fill="{}""#, ctx.theme.muted())
                    } else {
                        ink.clone()
                    };
                    text.push_str(&format!(
                        r#"<text class="pele-value" x="{}" y="{}" font-size="{}" text-anchor="end"{val_fill}{}>{}</text>"#,
                        num(x + b.w - SIDE - 2.0),
                        num(baseline + value_size * 0.35),
                        num(tiny),
                        style.text,
                        esc(&value),
                    ));
                }
            }
            let tint = if sets_fill(&style.shape) { "" } else { r#" fill-opacity="0.12""# };
            let shape = if b.headed {
                let raw_attrs = format!(r#"{tint} stroke="{color}"{}"#, style.shape);
                format!("{rect_prefix}{}/>", corners(&raw_attrs, b, ctx.theme))
            } else {
                format!(
                    r#"<rect x="{}" y="{}" width="{}" height="{}" fill="none"/>"#,
                    num(x),
                    num(y),
                    num(b.w),
                    num(b.h),
                )
            };
            sections_svg.push_str(&format!(
                r#"<g class="pele-node pele-section{extra_cls}" {group_id}{}{shape}{text}</g>"#,
                tooltip(drawn.as_deref()),
            ));
            continue;
        }

        let mut text = String::new();
        let room = b.w - 8.0;
        let smallest = fixed.unwrap_or(least);
        let tallest = match fixed {
            None => size.min(((b.h - 4.0) / LINE).floor()),
            Some(f) if f * LINE <= b.h - 4.0 => f,
            Some(_) => 0.0,
        };
        let label = if tallest >= smallest {
            fit_text(name, room, tallest, smallest, ctx.measurer, text_style)
        } else {
            None
        };
        let drawn_text = label.as_ref().map(|l| l.text.as_str());
        if let Some(lbl) = &label {
            let cx_str = num(x + b.w / 2.0);
            let cy = y + b.h / 2.0;
            let value_size = fixed.unwrap_or_else(|| least.max((lbl.size * 0.8).round()));
            let lines_h = (lbl.size + value_size) * LINE;
            if !value.is_empty() && lines_h <= b.h - 4.0 && ctx.measurer.width(&value, value_size, text_style) <= room {
                let first = cy - lines_h / 2.0 + (lbl.size * LINE) / 2.0;
                let second = cy + lines_h / 2.0 - (value_size * LINE) / 2.0;
                text = format!(
                    r#"<text x="{cx_str}" y="{}" font-size="{}"{ink}{}>{}</text><text class="pele-value" x="{cx_str}" y="{}" font-size="{}"{ink}{}>{}</text>"#,
                    num(first + lbl.size * 0.35),
                    num(lbl.size),
                    style.text,
                    esc(&lbl.text),
                    num(second + value_size * 0.35),
                    num(value_size),
                    style.text,
                    esc(&value),
                );
            } else {
                text = format!(
                    r#"<text x="{cx_str}" y="{}" font-size="{}"{ink}{}>{}</text>"#,
                    num(cy + lbl.size * 0.35),
                    num(lbl.size),
                    style.text,
                    esc(&lbl.text),
                );
            }
        }
        leaves_svg.push_str(&format!(
            r#"<g class="pele-node pele-leaf{extra_cls}" {group_id}{}{rect_prefix}{}/>{text}</g>"#,
            tooltip(drawn_text),
            corners(&style.shape, b, ctx.theme),
        ));
    }

    let total_width = (width.max(title.width) + 2.0 * pad).ceil();
    let total_height = (height + title_height + 2.0 * pad).ceil();
    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let mut content = label_svg(&title, total_width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, ctx.icons);
    if !sections_svg.is_empty() {
        content.push_str(&format!(r#"<g class="pele-sections" font-size="{}">{sections_svg}</g>"#, num(small)));
    }
    if !leaves_svg.is_empty() {
        content.push_str(&format!(
            r#"<g class="pele-leaves" text-anchor="middle" fill="{}">{leaves_svg}</g>"#,
            ctx.theme.bg(),
        ));
    }

    let svg = svg_document(
        "treemap",
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
