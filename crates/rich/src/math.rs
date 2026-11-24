//! Theme-reactive `ratex` LaTeX math renderer for [`crate::VvMarkdown`].
//!
//! `nsh-core 0.6.0`'s `mark_view_painted` stops traversing at `Kind::Text`, so `nsh-base`'s
//! built-in math canvases nested inside `Kind::Text` never repaint `SvgPaint::CurrentColor`
//! on live Light↔Dark toggles. Rendering through `text_view().render_math(...)` lets us bind
//! `.text_color(AdaptiveUi::INK)` directly on the `Kind::Canvas` node itself so `nsh-core`
//! dirties and repaints every inline and block formula in-place on appearance changes with
//! exact intrinsic dimensions and zero remounting of sibling components.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use nsh_core::element::Painter;
use nsh_core::prelude::*;
use nsh_core::{Point, Points, SvgPaint};
use ratex_font::FontId;
use ratex_layout::{LayoutOptions, layout, to_display_list, validate_layout};
use ratex_types::{Color as TexColor, DisplayItem, DisplayList, MathStyle, PathCommand};

use crate::cache::{LruCache, hash_str};
use crate::theme::{AdaptiveUi, CODE_FONT_MONO};

/// Math axis height above baseline in ems (KaTeX's 0.25), used to center inline formulas on x-height.
const AXIS_EM: f64 = 0.25;
/// Padding above and below glyph boxes in ems so round glyph overshoots are never clipped.
const OVERSHOOT_EM: f64 = 0.05;
const FORMULA_CACHE_CAPACITY: usize = 256;

/// KaTeX font order matching `nsh_base::MATH_FONTS` (`fonts/katex.pack.zst`).
const KATEX_FONTS: [FontId; 19] = [
    FontId::AmsRegular,
    FontId::CaligraphicRegular,
    FontId::FrakturRegular,
    FontId::FrakturBold,
    FontId::MainBold,
    FontId::MainBoldItalic,
    FontId::MainItalic,
    FontId::MainRegular,
    FontId::MathBoldItalic,
    FontId::MathItalic,
    FontId::SansSerifBold,
    FontId::SansSerifItalic,
    FontId::SansSerifRegular,
    FontId::ScriptRegular,
    FontId::Size1Regular,
    FontId::Size2Regular,
    FontId::Size3Regular,
    FontId::Size4Regular,
    FontId::TypewriterRegular,
];

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct FormulaKey {
    tex: String,
    display: bool,
}

fn formula_cache() -> &'static Mutex<LruCache<FormulaKey, Option<Arc<DisplayList>>>> {
    static CACHE: OnceLock<Mutex<LruCache<FormulaKey, Option<Arc<DisplayList>>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(LruCache::new(FORMULA_CACHE_CAPACITY)))
}

fn formula_hash(tex: &str, display: bool) -> u64 {
    hash_str(tex) ^ u64::from(display)
}

fn typeset_cached(tex: &str, display: bool) -> Option<Arc<DisplayList>> {
    let hash = formula_hash(tex, display);
    if let Some(cached) = formula_cache()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_by(hash, |k| k.display == display && k.tex == tex)
    {
        return cached;
    }
    let computed = typeset_display_list(tex, display).map(Arc::new);
    let key = FormulaKey { tex: tex.to_owned(), display };
    formula_cache()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert_by(hash, key, computed.clone(), |k| k.display == display && k.tex == tex);
    computed
}

fn typeset_display_list(tex: &str, display: bool) -> Option<DisplayList> {
    let nodes = ratex_parser::parse(tex).ok()?;
    let options = LayoutOptions {
        style: if display { MathStyle::Display } else { MathStyle::Text },
        color: TexColor::BLACK,
        ..LayoutOptions::default()
    };
    let root = layout(&nodes, &options);
    validate_layout(&root).ok()?;
    let list = to_display_list(&root);
    (list.width.is_finite() && list.height.is_finite() && list.depth.is_finite()).then_some(list)
}

fn katex_face(font: &str) -> Option<&'static ttf_parser::Face<'static>> {
    static FACES: OnceLock<HashMap<FontId, ttf_parser::Face<'static>>> = OnceLock::new();
    let faces = FACES.get_or_init(|| {
        let Ok(pack) = zstd::decode_all(nsh_base::MATH_FONTS) else {
            return HashMap::new();
        };
        // Unpacked font pack lives for the process lifetime so Face<'static> borrows directly without copies.
        let mut rest: &'static [u8] = Vec::leak(pack);
        let mut out = HashMap::with_capacity(KATEX_FONTS.len());
        for id in KATEX_FONTS {
            let Some((len_bytes, tail)) = rest.split_first_chunk::<4>() else {
                break;
            };
            let len = u32::from_le_bytes(*len_bytes) as usize;
            let Some((bytes, tail)) = (len <= tail.len()).then(|| tail.split_at(len)) else {
                break;
            };
            rest = tail;
            if let Ok(face) = ttf_parser::Face::parse(bytes, 0) {
                out.insert(id, face);
            }
        }
        out
    });
    faces.get(&FontId::parse(font)?)
}

fn apply_paint(p: Painter, color: &TexColor) -> Painter {
    if *color == TexColor::BLACK {
        p.fill_style_from_view(SvgPaint::CurrentColor)
    } else {
        p.fill_style(Hsla::from(Rgba {
            r: color.r,
            g: color.g,
            b: color.b,
            a: color.a,
        }))
    }
}

struct GlyphOutline {
    painter: Option<Painter>,
    x: f32,
    y: f32,
    scale: f32,
}

impl GlyphOutline {
    fn at(&self, x: f32, y: f32) -> Point<Points> {
        point(px(self.x + x * self.scale), px(self.y - y * self.scale))
    }

    fn update(&mut self, f: impl FnOnce(Painter) -> Painter) {
        let p = self.painter.take().expect("glyph outline painter");
        self.painter = Some(f(p));
    }
}

impl ttf_parser::OutlineBuilder for GlyphOutline {
    fn move_to(&mut self, x: f32, y: f32) {
        let to = self.at(x, y);
        self.update(|p| p.move_to(to.x.0, to.y.0));
    }

    fn line_to(&mut self, x: f32, y: f32) {
        let to = self.at(x, y);
        self.update(|p| p.line_to(to.x.0, to.y.0));
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let (c, to) = (self.at(x1, y1), self.at(x, y));
        self.update(|p| p.quadratic_curve_to(c, to));
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let (c1, c2, to) = (self.at(x1, y1), self.at(x2, y2), self.at(x, y));
        self.update(|p| p.bezier_curve_to(c1, c2, to));
    }

    fn close(&mut self) {
        self.update(Painter::close_path);
    }
}

fn draw_display_list(list: &DisplayList, size_pt: f32, top_pt: f32) -> Painter {
    let mut p = Painter::new();
    let pt = |v: f64| v as f32 * size_pt;
    for item in &list.items {
        p = match item {
            DisplayItem::GlyphPath {
                x,
                y,
                scale,
                font,
                char_code,
                color,
            } => {
                let Some(face) = katex_face(font) else {
                    continue;
                };
                let id = FontId::parse(font).unwrap_or(FontId::MainRegular);
                let ch = ratex_font::katex_ttf_glyph_char(id, *char_code);
                let Some(glyph) = face.glyph_index(ch) else {
                    continue;
                };
                let units = f32::from(face.units_per_em());
                let mut outline = GlyphOutline {
                    painter: Some(apply_paint(p, color).begin_path()),
                    x: pt(*x),
                    y: top_pt + pt(*y),
                    scale: size_pt * (*scale as f32) / units,
                };
                face.outline_glyph(glyph, &mut outline);
                outline.painter.take().expect("glyph outline painter").fill()
            }
            DisplayItem::Line {
                x, y, width, thickness, color, ..
            } => {
                let t = pt(*thickness).max(1.0);
                apply_paint(p, color).fill_rect(pt(*x), top_pt + pt(*y) - t / 2.0, pt(*width), t)
            }
            DisplayItem::Rect { x, y, width, height, color } => apply_paint(p, color).fill_rect(pt(*x), top_pt + pt(*y), pt(*width), pt(*height)),
            DisplayItem::Path { x, y, commands, fill, color } => {
                let (ox, oy) = (pt(*x), top_pt + pt(*y));
                let at = |cx: f64, cy: f64| point(px(ox + pt(cx)), px(oy + pt(cy)));
                let mut q = apply_paint(p, color).begin_path();
                for cmd in commands {
                    q = match *cmd {
                        PathCommand::MoveTo { x, y } => {
                            let to = at(x, y);
                            q.move_to(to.x.0, to.y.0)
                        }
                        PathCommand::LineTo { x, y } => {
                            let to = at(x, y);
                            q.line_to(to.x.0, to.y.0)
                        }
                        PathCommand::QuadTo { x1, y1, x, y } => q.quadratic_curve_to(at(x1, y1), at(x, y)),
                        PathCommand::CubicTo { x1, y1, x2, y2, x, y } => q.bezier_curve_to(at(x1, y1), at(x2, y2), at(x, y)),
                        PathCommand::Close => q.close_path(),
                    };
                }
                if *fill {
                    q.fill()
                } else {
                    q.stroke_style_from_view(SvgPaint::CurrentColor).line_width((size_pt * 0.04).max(1.0)).stroke()
                }
            }
        };
    }
    p
}

/// Renders an inline or display LaTeX formula into a theme-reactive `nsh_core` element.
///
/// Binds `.text_color(AdaptiveUi::INK)` directly onto the `canvas` node so `nsh-core` marks
/// `dirty::CANVAS` and repaints `CurrentColor` in-place whenever Light↔Dark appearance flips.
pub(crate) fn render_math_element(tex: &SharedString, display: bool, body_pt: f32, selectable: bool) -> AnyElement {
    let size_pt = if display { body_pt * 1.15 } else { body_pt };
    let Some(list) = typeset_cached(tex.as_str(), display) else {
        return render_math_fallback(tex, display, selectable);
    };

    let (above, below) = if display {
        (list.height + OVERSHOOT_EM, list.depth + OVERSHOOT_EM)
    } else {
        let half = (list.height - AXIS_EM).max(list.depth + AXIS_EM) + OVERSHOOT_EM;
        (half + AXIS_EM, half - AXIS_EM)
    };
    let top_pt = ((above - list.height) as f32) * size_pt;
    let width = (list.width as f32 * size_pt).max(1.0);
    let height = ((above + below) as f32 * size_pt).max(1.0);
    let painter = draw_display_list(&list, size_pt, top_pt);

    let formula_canvas = canvas(painter).w(px(width)).h(px(height)).flex_none().text_color(AdaptiveUi::INK);

    if display {
        scroll()
            .horizontal()
            .scrollbar(false)
            .test_id("math-block")
            .child(
                view()
                    .flex_row()
                    .justify_center()
                    .min_w(relative(1.0))
                    .py(px(body_pt * 0.3))
                    .child(view().flex_row().align_middle().label(tex.clone()).child(formula_canvas)),
            )
            .into_element()
    } else {
        view()
            .test_id("math-inline")
            .flex_row()
            .align_middle()
            .label(tex.clone())
            .child(formula_canvas)
            .into_element()
    }
}

fn render_math_fallback(tex: &SharedString, display: bool, selectable: bool) -> AnyElement {
    if display {
        view()
            .test_id("math-block")
            .py(px(10.0))
            .px(px(14.0))
            .rounded(px(6.0))
            .border(px(1.0))
            .border_color(AdaptiveUi::LINE)
            .bg(AdaptiveUi::CODE_SURFACE)
            .child(
                text(tex.clone())
                    .font_family(CODE_FONT_MONO)
                    .text_size(px(12.0))
                    .text_color(AdaptiveUi::INK)
                    .when(selectable, |t| t.select_text()),
            )
            .into_element()
    } else {
        text(tex.clone())
            .test_id("math-inline")
            .font_family(CODE_FONT_MONO)
            .text_size(px(12.0))
            .bg(AdaptiveUi::INLINE_CODE_BG)
            .text_color(AdaptiveUi::INK)
            .px(px(4.0))
            .rounded(px(4.0))
            .into_element()
    }
}
