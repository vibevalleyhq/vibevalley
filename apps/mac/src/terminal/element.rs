//! Paints an `vibevalley_terminal::Snapshot` as a grid.
//!
//! Column alignment: every run starts at `start_col * cell_width`. Narrow
//! graphemes are shaped in batches with a forced per-glyph advance of one
//! cell; each wide grapheme (CJK, emoji) is shaped alone and placed at its
//! own column, so a fallback font's advance can never shift what follows.

use std::rc::Rc;
use std::sync::Arc;

use gpui_kit::{
    App, Bounds, Element, ElementId, Entity, FocusHandle, Font, FontFallbacks, FontStyle, FontWeight, GlobalElementId, Hsla, InputHandler, InspectorElementId,
    LayoutId, Pixels, Point, ShapedLine, SharedString, StrikethroughStyle, Style, TextAlign, TextRun, UTF16Selection, UnderlineStyle, Window, fill, font,
    outline, point, px, relative, size,
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;
use vibevalley_terminal::{CursorShape, Row, Snapshot, TermSize};

use super::TerminalView;
use crate::theme::{Palette, Ui, hsla};

pub const PADDING: f32 = 6.0;

/// Where the grid is on screen; written at prepaint, read by mouse handlers.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Geometry {
    pub origin: Point<Pixels>,
    pub cell_width: Pixels,
    pub line_height: Pixels,
    pub size: TermSize,
}

impl Geometry {
    pub fn cell_at(&self, position: Point<Pixels>) -> vibevalley_terminal::Point {
        let col = ((position.x - self.origin.x) / self.cell_width).floor();
        let row = ((position.y - self.origin.y) / self.line_height).floor();
        vibevalley_terminal::Point {
            row: (row.max(0.0) as u16).min(self.size.rows.saturating_sub(1)),
            col: (col.max(0.0) as u16).min(self.size.cols.saturating_sub(1)),
        }
    }

    fn cell_origin(&self, row: u16, col: u16) -> Point<Pixels> {
        point(self.origin.x + self.cell_width * col as f32, self.origin.y + self.line_height * row as f32)
    }
}

pub fn grapheme_cols(g: &str) -> u16 {
    (g.width() as u16).clamp(1, 2)
}

struct ShapedRow {
    backgrounds: Vec<(u16, u16, Hsla)>,
    texts: Vec<(u16, ShapedLine)>,
}

#[derive(PartialEq, Clone)]
struct CacheKey {
    epoch: u64,
    font_size: Pixels,
    cell_width: Pixels,
}

/// Shaped rows keyed by row identity. Snapshots share unchanged rows by
/// `Arc`, so a typical frame reshapes only the lines that actually changed.
#[derive(Default)]
pub struct RowCache {
    key: Option<CacheKey>,
    rows: Vec<Option<(Arc<Row>, Rc<ShapedRow>)>>,
}

struct Fonts {
    regular: Font,
    bold: Font,
    italic: Font,
    bold_italic: Font,
}

/// The configured family when it is installed, else the first installed of a
/// few that every Mac or most developers have. A family that is not there
/// resolves to a proportional font, whose `m` is not the width of the cells
/// the glyphs are drawn in.
fn installed_mono(family: SharedString, text_system: &gpui_kit::gpui::WindowTextSystem) -> SharedString {
    static INSTALLED: std::sync::OnceLock<std::collections::HashSet<String>> = std::sync::OnceLock::new();
    let installed = INSTALLED.get_or_init(|| text_system.all_font_names().into_iter().collect());
    if installed.contains(family.as_ref()) {
        return family;
    }
    ["SF Mono", "JetBrains Maple Mono", "JetBrainsMono Nerd Font", "Menlo", "Monaco"]
        .into_iter()
        .find(|f| installed.contains(*f))
        .map(SharedString::from)
        .unwrap_or(family)
}

impl Fonts {
    fn new(family: SharedString) -> Self {
        let mut regular = font(family);
        regular.fallbacks = Some(FontFallbacks::from_fonts(vec![
            "Maple Mono NF CN".into(),
            "JetBrainsMono Nerd Font".into(),
            "JetBrainsMonoNL Nerd Font".into(),
            "Symbols Nerd Font Mono".into(),
            "Symbols Nerd Font".into(),
            "MesloLGS NF".into(),
            "Hack Nerd Font".into(),
            "FiraCode Nerd Font".into(),
            "Menlo".into(),
            "PingFang SC".into(),
            "Apple Color Emoji".into(),
        ]));
        let bold = Font {
            weight: FontWeight::BOLD,
            ..regular.clone()
        };
        let italic = Font {
            style: FontStyle::Italic,
            ..regular.clone()
        };
        let bold_italic = Font {
            weight: FontWeight::BOLD,
            style: FontStyle::Italic,
            ..regular.clone()
        };
        Fonts {
            regular,
            bold,
            italic,
            bold_italic,
        }
    }

    fn pick(&self, bold: bool, italic: bool) -> &Font {
        match (bold, italic) {
            (false, false) => &self.regular,
            (true, false) => &self.bold,
            (false, true) => &self.italic,
            (true, true) => &self.bold_italic,
        }
    }
}

#[derive(Default)]
struct Batch {
    start_col: u16,
    cols: u16,
    text: String,
    runs: Vec<TextRun>,
}

impl Batch {
    fn push(&mut self, col: u16, g: &str, run: &TextRun) {
        if self.text.is_empty() {
            self.start_col = col;
            self.cols = 0;
        }
        // Keep one glyph per column inside a batch: pad any gap with spaces.
        let gap = col.saturating_sub(self.start_col + self.cols) as usize;
        if gap > 0 {
            self.text.extend(std::iter::repeat_n(' ', gap));
            self.runs.push(TextRun {
                len: gap,
                underline: None,
                strikethrough: None,
                ..run.clone()
            });
            self.cols += gap as u16;
        }
        self.text.push_str(g);
        match self.runs.last_mut() {
            Some(last) if last.font == run.font && last.color == run.color && last.underline == run.underline && last.strikethrough == run.strikethrough => {
                last.len += g.len()
            }
            _ => self.runs.push(TextRun { len: g.len(), ..run.clone() }),
        }
        self.cols += 1;
    }

    fn flush(&mut self, out: &mut Vec<(u16, ShapedLine)>, font_size: Pixels, cell_width: Pixels, window: &Window) {
        if self.text.trim_end().is_empty() {
            self.text.clear();
            self.runs.clear();
            return;
        }
        let text = SharedString::from(std::mem::take(&mut self.text));
        let line = window.text_system().shape_line(text, font_size, &self.runs, Some(cell_width));
        self.runs.clear();
        out.push((self.start_col, line));
    }
}

fn shape_row(row: &Row, fonts: &Fonts, font_size: Pixels, cell_width: Pixels, window: &Window) -> ShapedRow {
    let mut backgrounds: Vec<(u16, u16, Hsla)> = Vec::new();
    let mut texts = Vec::new();
    let mut batch = Batch::default();

    for run in &row.runs {
        let style = &run.style;
        if let Some(bg) = style.bg {
            let color = hsla(bg);
            match backgrounds.last_mut() {
                Some((start, cols, c)) if *c == color && *start + *cols == run.start_col => *cols += run.cols,
                _ => backgrounds.push((run.start_col, run.cols, color)),
            }
        }
        let mut color = hsla(style.fg);
        if style.dim {
            color.a *= 0.6;
        }
        let decorated = style.underline || run.hyperlink.is_some();
        let text_run = TextRun {
            len: 0,
            font: fonts.pick(style.bold, style.italic).clone(),
            color,
            background_color: None,
            underline: decorated.then_some(UnderlineStyle {
                color: Some(color),
                thickness: px(1.0),
                wavy: false,
            }),
            strikethrough: style.strikethrough.then_some(StrikethroughStyle {
                color: Some(color),
                thickness: px(1.0),
            }),
        };
        let plain_blank = !decorated && !style.strikethrough;
        let mut col = run.start_col;
        for g in run.text.graphemes(true) {
            let cols = grapheme_cols(g);
            if cols == 1 {
                if !(g == " " && plain_blank && batch.text.is_empty()) {
                    batch.push(col, g, &text_run);
                }
            } else {
                batch.flush(&mut texts, font_size, cell_width, window);
                let line = window.text_system().shape_line(
                    SharedString::from(g.to_string()),
                    font_size,
                    &[TextRun {
                        len: g.len(),
                        ..text_run.clone()
                    }],
                    None,
                );
                texts.push((col, line));
            }
            col += cols;
        }
    }
    batch.flush(&mut texts, font_size, cell_width, window);
    ShapedRow { backgrounds, texts }
}

/// The grapheme occupying `col`, with its width in columns.
fn grapheme_at(row: &Row, col: u16) -> Option<(&str, u16)> {
    for run in &row.runs {
        if col < run.start_col || col >= run.start_col + run.cols {
            continue;
        }
        let mut at = run.start_col;
        for g in run.text.graphemes(true) {
            let cols = grapheme_cols(g);
            if col < at + cols {
                return Some((g, cols));
            }
            at += cols;
        }
    }
    None
}

pub struct TerminalElement {
    view: Entity<TerminalView>,
    focus: FocusHandle,
}

impl TerminalElement {
    pub fn new(view: Entity<TerminalView>, focus: FocusHandle) -> Self {
        TerminalElement { view, focus }
    }
}

pub struct Prepaint {
    geometry: Geometry,
    snapshot: Option<Arc<Snapshot>>,
    rows: Vec<Rc<ShapedRow>>,
    cursor_text: Option<ShapedLine>,
    marked: Option<ShapedLine>,
    colors: Palette,
    font_size: Pixels,
    blink_on: bool,
}

impl Element for TerminalElement {
    type RequestLayoutState = ();
    type PrepaintState = Prepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = relative(1.).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Prepaint {
        let ui = Ui::get(cx);
        let colors = ui.colors.clone();
        let epoch = ui.epoch;
        let font_size = px(ui.settings.terminal_font_size);
        let text_system = window.text_system().clone();
        let fonts = Fonts::new(installed_mono(ui.mono(), &text_system));

        let font_id = text_system.resolve_font(&fonts.regular);
        let cell_width = text_system.advance(font_id, font_size, 'm').map(|s| s.width).unwrap_or(font_size * 0.6);
        let line_height = px((ui.settings.terminal_font_size * 1.35).round());

        let inner = size(bounds.size.width - px(PADDING * 2.0), bounds.size.height - px(PADDING * 2.0));
        let cols = ((inner.width / cell_width).floor() as i64).clamp(2, 1000) as u16;
        let rows = ((inner.height / line_height).floor() as i64).clamp(1, 1000) as u16;
        let term_size = TermSize {
            cols,
            rows,
            cell_width_px: f32::from(cell_width).round() as u16,
            cell_height_px: f32::from(line_height).round() as u16,
        };
        let geometry = Geometry {
            origin: point(bounds.origin.x + px(PADDING), bounds.origin.y + px(PADDING)),
            cell_width,
            line_height,
            size: term_size,
        };

        let (snapshot, cache, marked, blink_on) = self.view.update(cx, |view, cx| {
            view.set_geometry(geometry, cx);
            (view.snapshot(), view.row_cache.clone(), view.marked.clone(), view.blink_on)
        });

        let mut rows_out = Vec::new();
        let mut cursor_text = None;
        if let Some(snapshot) = &snapshot {
            let mut cache = cache.borrow_mut();
            let key = CacheKey { epoch, font_size, cell_width };
            if cache.key.as_ref() != Some(&key) {
                cache.key = Some(key);
                cache.rows.clear();
            }
            cache.rows.resize_with(snapshot.rows.len(), || None);
            for (i, row) in snapshot.rows.iter().enumerate() {
                let shaped = match &cache.rows[i] {
                    Some((cached, shaped)) if Arc::ptr_eq(cached, row) => shaped.clone(),
                    _ => {
                        let shaped = Rc::new(shape_row(row, &fonts, font_size, cell_width, window));
                        cache.rows[i] = Some((row.clone(), shaped.clone()));
                        shaped
                    }
                };
                rows_out.push(shaped);
            }

            let cursor = snapshot.cursor;
            if cursor.visible
                && cursor.shape == CursorShape::Block
                && self.focus.is_focused(window)
                && let Some(row) = snapshot.rows.get(cursor.row as usize)
                && let Some((g, _)) = grapheme_at(row, cursor.col)
                && !g.trim().is_empty()
            {
                let run = TextRun {
                    len: g.len(),
                    font: fonts.regular.clone(),
                    color: colors.bg,
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                };
                cursor_text = Some(text_system.shape_line(SharedString::from(g.to_string()), font_size, &[run], None));
            }
        }

        let marked = marked.filter(|m| !m.is_empty()).map(|text| {
            let run = TextRun {
                len: text.len(),
                font: fonts.regular.clone(),
                color: colors.text,
                background_color: None,
                underline: Some(UnderlineStyle {
                    color: Some(colors.text),
                    thickness: px(1.0),
                    wavy: false,
                }),
                strikethrough: None,
            };
            text_system.shape_line(SharedString::from(text), font_size, &[run], None)
        });

        Prepaint {
            geometry,
            snapshot,
            rows: rows_out,
            cursor_text,
            marked,
            colors,
            font_size,
            blink_on,
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        state: &mut Prepaint,
        window: &mut Window,
        cx: &mut App,
    ) {
        let g = state.geometry;
        let colors = &state.colors;
        let focused = self.focus.is_focused(window);
        let _ = state.font_size;

        let Some(snapshot) = state.snapshot.clone() else {
            window.handle_input(
                &self.focus,
                TerminalInput {
                    view: self.view.clone(),
                    cursor: None,
                },
                cx,
            );
            return;
        };
        let cursor = snapshot.cursor;
        let cursor_origin = g.cell_origin(cursor.row.min(g.size.rows.saturating_sub(1)), cursor.col);
        let cursor_bounds = Bounds::new(cursor_origin, size(g.cell_width, g.line_height));
        window.handle_input(
            &self.focus,
            TerminalInput {
                view: self.view.clone(),
                cursor: Some(cursor_bounds),
            },
            cx,
        );

        window.with_content_mask(Some(gpui_kit::ContentMask { bounds }), |window| {
            for (i, row) in state.rows.iter().enumerate() {
                for (col, cols, color) in &row.backgrounds {
                    let origin = g.cell_origin(i as u16, *col);
                    // Whole pixels, or neighbouring cells show hairline seams.
                    let x0 = origin.x.floor();
                    let x1 = (origin.x + g.cell_width * *cols as f32).ceil();
                    window.paint_quad(fill(Bounds::new(point(x0, origin.y), size(x1 - x0, g.line_height)), *color));
                }
            }

            if let Some((start, end)) = snapshot.selection {
                let selection = hsla(colors.term.selection);
                for row in start.row..=end.row.min(g.size.rows.saturating_sub(1)) {
                    let from = if row == start.row { start.col } else { 0 };
                    let to = if row == end.row { end.col + 1 } else { g.size.cols };
                    if to > from {
                        let origin = g.cell_origin(row, from);
                        window.paint_quad(fill(Bounds::new(origin, size(g.cell_width * (to - from) as f32, g.line_height)), selection));
                    }
                }
            }

            for (i, row) in state.rows.iter().enumerate() {
                for (col, line) in &row.texts {
                    let _ = line.paint(g.cell_origin(i as u16, *col), g.line_height, TextAlign::Left, None, window, cx);
                }
            }

            let composing = state.marked.is_some();
            if let Some(marked) = &state.marked {
                let width = marked.width().max(g.cell_width);
                window.paint_quad(fill(Bounds::new(cursor_origin, size(width, g.line_height)), colors.bg));
                let _ = marked.paint(cursor_origin, g.line_height, TextAlign::Left, None, window, cx);
                let caret = point(cursor_origin.x + marked.width(), cursor_origin.y);
                window.paint_quad(fill(Bounds::new(caret, size(px(2.0), g.line_height)), hsla(colors.term.cursor)));
            }

            if cursor.visible && !composing && cursor.row < g.size.rows {
                let color = hsla(colors.term.cursor);
                let wide = snapshot
                    .rows
                    .get(cursor.row as usize)
                    .and_then(|row| grapheme_at(row, cursor.col))
                    .map_or(1, |(_, cols)| cols);
                let cell = Bounds::new(cursor_origin, size(g.cell_width * wide as f32, g.line_height));
                if !focused {
                    window.paint_quad(outline(cell, color, gpui_kit::BorderStyle::Solid));
                } else if state.blink_on || !cursor.blinking {
                    match cursor.shape {
                        CursorShape::Block => {
                            window.paint_quad(fill(cell, color));
                            if let Some(text) = &state.cursor_text {
                                let _ = text.paint(cursor_origin, g.line_height, TextAlign::Left, None, window, cx);
                            }
                        }
                        CursorShape::Bar => {
                            window.paint_quad(fill(Bounds::new(cursor_origin, size(px(2.0), g.line_height)), color));
                        }
                        CursorShape::Underline => {
                            let origin = point(cursor_origin.x, cursor_origin.y + g.line_height - px(2.0));
                            window.paint_quad(fill(Bounds::new(origin, size(cell.size.width, px(2.0))), color));
                        }
                    }
                }
            }
        });
    }
}

/// Platform text input for the terminal: composition is shown at the cursor
/// and committed text goes to the PTY. There is no document to query.
struct TerminalInput {
    view: Entity<TerminalView>,
    cursor: Option<Bounds<Pixels>>,
}

impl InputHandler for TerminalInput {
    fn selected_text_range(&mut self, _ignore_disabled: bool, _: &mut Window, _: &mut App) -> Option<UTF16Selection> {
        Some(UTF16Selection { range: 0..0, reversed: false })
    }

    fn marked_text_range(&mut self, _: &mut Window, cx: &mut App) -> Option<std::ops::Range<usize>> {
        let marked = self.view.read(cx).marked.as_ref()?;
        Some(0..marked.encode_utf16().count())
    }

    fn text_for_range(&mut self, _: std::ops::Range<usize>, _: &mut Option<std::ops::Range<usize>>, _: &mut Window, _: &mut App) -> Option<String> {
        None
    }

    fn replace_text_in_range(&mut self, _: Option<std::ops::Range<usize>>, text: &str, _: &mut Window, cx: &mut App) {
        self.view.update(cx, |view, cx| view.commit_text(text, cx));
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        _: Option<std::ops::Range<usize>>,
        new_text: &str,
        _: Option<std::ops::Range<usize>>,
        _: &mut Window,
        cx: &mut App,
    ) {
        self.view.update(cx, |view, cx| view.set_marked(Some(new_text.to_string()), cx));
    }

    fn unmark_text(&mut self, _: &mut Window, cx: &mut App) {
        self.view.update(cx, |view, cx| view.set_marked(None, cx));
    }

    fn bounds_for_range(&mut self, range: std::ops::Range<usize>, _: &mut Window, cx: &mut App) -> Option<Bounds<Pixels>> {
        // Anchors the candidate window: the cursor cell, advanced past the
        // composition so far.
        let mut bounds = self.cursor?;
        let width = self.view.read(cx).geometry.map_or(px(8.0), |g| g.cell_width);
        bounds.origin.x += width * range.start as f32;
        Some(bounds)
    }

    fn character_index_for_point(&mut self, _: Point<Pixels>, _: &mut Window, _: &mut App) -> Option<usize> {
        None
    }

    fn apple_press_and_hold_enabled(&mut self) -> bool {
        // Holding a key must repeat it, not open the accent picker.
        false
    }
}
