//! Turns `alacritty_terminal::Term` state into immutable [`Row`]s.

use std::collections::HashMap;
use std::sync::Arc;

use alacritty_terminal::event::EventListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::color::Colors;
use alacritty_terminal::term::{Term, TermDamage, TermMode, point_to_viewport};
use alacritty_terminal::vte::ansi::{Color, CursorShape as AnsiCursorShape, NamedColor, Rgb as AnsiRgb};

use crate::{CellStyle, Cursor, CursorShape, Point, Rgb, Row, Run, Theme};

pub(crate) struct Frame {
    pub rows: Vec<Arc<Row>>,
    pub cursor: Cursor,
    pub selection: Option<(Point, Point)>,
}

pub(crate) struct Builder {
    prev: Vec<Arc<Row>>,
    force_full: bool,
    links: HashMap<String, Arc<str>>,
    text: String,
    damaged: Vec<bool>,
}

fn from_ansi_rgb(c: AnsiRgb) -> Rgb {
    Rgb(c.r, c.g, c.b)
}

/// Resolves a standard xterm 256-color index (0..=255) against `theme` and overrides.
pub(crate) fn resolve_color_index(idx: usize, colors: &Colors, theme: &Theme) -> Rgb {
    if let Some(rgb) = colors[idx] {
        return from_ansi_rgb(rgb);
    }
    match idx {
        0..=15 => theme.ansi[idx],
        16..=231 => {
            const CUBE: [u8; 6] = [0, 95, 135, 175, 215, 255];
            let n = idx - 16;
            Rgb(CUBE[n / 36], CUBE[(n / 6) % 6], CUBE[n % 6])
        }
        232..=255 => {
            let v = (8 + (idx - 232) * 10) as u8;
            Rgb(v, v, v)
        }
        i if i == NamedColor::Foreground as usize || i == NamedColor::BrightForeground as usize || i == NamedColor::DimForeground as usize => theme.foreground,
        i if i == NamedColor::Background as usize => theme.background,
        i if i == NamedColor::Cursor as usize => theme.cursor,
        i if i >= NamedColor::DimBlack as usize && i <= NamedColor::DimWhite as usize => theme.ansi[i - NamedColor::DimBlack as usize],
        _ => theme.foreground,
    }
}

fn resolve_named(named: NamedColor, colors: &Colors, theme: &Theme) -> Rgb {
    if let Some(rgb) = colors[named] {
        return from_ansi_rgb(rgb);
    }
    match named {
        NamedColor::Black => theme.ansi[0],
        NamedColor::Red => theme.ansi[1],
        NamedColor::Green => theme.ansi[2],
        NamedColor::Yellow => theme.ansi[3],
        NamedColor::Blue => theme.ansi[4],
        NamedColor::Magenta => theme.ansi[5],
        NamedColor::Cyan => theme.ansi[6],
        NamedColor::White => theme.ansi[7],
        NamedColor::BrightBlack => theme.ansi[8],
        NamedColor::BrightRed => theme.ansi[9],
        NamedColor::BrightGreen => theme.ansi[10],
        NamedColor::BrightYellow => theme.ansi[11],
        NamedColor::BrightBlue => theme.ansi[12],
        NamedColor::BrightMagenta => theme.ansi[13],
        NamedColor::BrightCyan => theme.ansi[14],
        NamedColor::BrightWhite => theme.ansi[15],
        NamedColor::Foreground | NamedColor::BrightForeground | NamedColor::DimForeground => theme.foreground,
        NamedColor::Background => theme.background,
        NamedColor::Cursor => theme.cursor,
        NamedColor::DimBlack => theme.ansi[0],
        NamedColor::DimRed => theme.ansi[1],
        NamedColor::DimGreen => theme.ansi[2],
        NamedColor::DimYellow => theme.ansi[3],
        NamedColor::DimBlue => theme.ansi[4],
        NamedColor::DimMagenta => theme.ansi[5],
        NamedColor::DimCyan => theme.ansi[6],
        NamedColor::DimWhite => theme.ansi[7],
    }
}

fn resolve_fg(color: Color, colors: &Colors, theme: &Theme) -> Rgb {
    match color {
        Color::Spec(rgb) => from_ansi_rgb(rgb),
        Color::Indexed(idx) => resolve_color_index(usize::from(idx), colors, theme),
        Color::Named(named) => resolve_named(named, colors, theme),
    }
}

fn resolve_bg(color: Color, colors: &Colors, theme: &Theme) -> Option<Rgb> {
    match color {
        Color::Named(NamedColor::Background) if colors[NamedColor::Background].is_none() => None,
        other => Some(resolve_fg(other, colors, theme)),
    }
}

/// A blank cell that paints nothing, so it can be dropped from a row's tail.
fn paints_nothing(style: &CellStyle) -> bool {
    style.bg.is_none() && !style.underline && !style.strikethrough
}

fn viewport_selection<T>(term: &Term<T>) -> Option<(Point, Point)> {
    let range = term.selection.as_ref()?.to_range(term)?;
    let display_offset = term.grid().display_offset() as i32;
    let screen_lines = term.screen_lines() as i32;
    let last_col = term.columns().saturating_sub(1) as u16;
    let top_line = Line(-display_offset);
    let bottom_line = Line(screen_lines - 1 - display_offset);

    if range.end.line < top_line || range.start.line > bottom_line {
        return None;
    }

    let start = if range.start.line < top_line {
        Point { row: 0, col: 0 }
    } else {
        Point {
            row: (range.start.line.0 + display_offset) as u16,
            col: (range.start.column.0 as u16).min(last_col),
        }
    };
    let end = if range.end.line > bottom_line {
        Point {
            row: (screen_lines - 1) as u16,
            col: last_col,
        }
    } else {
        Point {
            row: (range.end.line.0 + display_offset) as u16,
            col: (range.end.column.0 as u16).min(last_col),
        }
    };

    Some((start, end))
}

impl Builder {
    pub(crate) fn new() -> Self {
        Self {
            prev: Vec::new(),
            force_full: true,
            links: HashMap::new(),
            text: String::new(),
            damaged: Vec::new(),
        }
    }

    /// Rebuild every row on the next frame (theme change).
    pub(crate) fn invalidate(&mut self) {
        self.force_full = true;
    }

    pub(crate) fn build<T: EventListener>(&mut self, term: &mut Term<T>, theme: &Theme) -> Frame {
        let row_count = term.screen_lines();
        let cols = term.columns();
        let display_offset = term.grid().display_offset();
        let default_fg = resolve_named(NamedColor::Foreground, term.colors(), theme);
        let default_bg = resolve_named(NamedColor::Background, term.colors(), theme);

        let full = match term.damage() {
            TermDamage::Full => true,
            TermDamage::Partial(iter) => {
                if self.force_full || self.prev.len() != row_count {
                    true
                } else {
                    self.damaged.clear();
                    self.damaged.resize(row_count, false);
                    for bounds in iter {
                        if bounds.line < row_count {
                            self.damaged[bounds.line] = true;
                        }
                    }
                    false
                }
            }
        };

        let colors = *term.colors();
        let grid = term.grid();
        let mut out: Vec<Arc<Row>> = Vec::with_capacity(row_count);

        for y in 0..row_count {
            let old = self.prev.get(y);
            if !full
                && !self.damaged[y]
                && let Some(old) = old
            {
                out.push(old.clone());
                continue;
            }

            let grid_line = Line(y as i32 - display_offset as i32);
            let grid_row = &grid[grid_line];
            let wrapped = cols > 0 && grid_row[Column(cols - 1)].flags.contains(Flags::WRAPLINE);
            let mut runs: Vec<Run> = Vec::new();

            for x in 0..cols {
                let cell = &grid_row[Column(x)];
                if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    continue;
                }
                let col = x as u16;
                let width: u16 = if cell.flags.contains(Flags::WIDE_CHAR) { 2 } else { 1 };

                let zw = cell.zerowidth();
                let blank = (cell.c == ' ' || cell.c == '\t') && zw.is_none_or(<[char]>::is_empty);

                let mut fg = resolve_fg(cell.fg, &colors, theme);
                let mut bg = resolve_bg(cell.bg, &colors, theme);
                if cell.flags.contains(Flags::INVERSE) {
                    let old_fg = fg;
                    fg = bg.unwrap_or(default_bg);
                    bg = Some(old_fg);
                }
                if cell.flags.contains(Flags::HIDDEN) {
                    fg = bg.unwrap_or(default_bg);
                }

                let mut style = CellStyle {
                    fg,
                    bg,
                    bold: cell.flags.contains(Flags::BOLD),
                    italic: cell.flags.contains(Flags::ITALIC),
                    dim: cell.flags.contains(Flags::DIM),
                    underline: cell.flags.intersects(Flags::ALL_UNDERLINES),
                    strikethrough: cell.flags.contains(Flags::STRIKEOUT),
                };
                if blank {
                    // Blank cells carry no glyph, so their foreground is
                    // irrelevant; normalizing it lets them merge into runs.
                    style.fg = default_fg;
                }

                let hyperlink = cell.hyperlink().map(|h| intern_link(&mut self.links, h.uri()));

                let text = if blank {
                    " "
                } else {
                    self.text.clear();
                    self.text.push(cell.c);
                    if let Some(extra) = zw {
                        for &ch in extra {
                            self.text.push(ch);
                        }
                    }
                    self.text.as_str()
                };

                match runs.last_mut() {
                    Some(last) if last.start_col + last.cols == col && last.style == style && last.hyperlink == hyperlink => {
                        last.text.push_str(text);
                        last.cols += width;
                    }
                    _ => runs.push(Run {
                        start_col: col,
                        cols: width,
                        text: text.to_string(),
                        style,
                        hyperlink,
                    }),
                }
            }

            while let Some(last) = runs.last_mut() {
                if !paints_nothing(&last.style) || last.hyperlink.is_some() {
                    break;
                }
                let kept = last.text.trim_end_matches(' ').len();
                let dropped = (last.text.len() - kept) as u16;
                last.text.truncate(kept);
                last.cols -= dropped;
                if last.cols > 0 {
                    break;
                }
                runs.pop();
            }

            let built = Row { runs, wrapped };
            match old {
                Some(old) if **old == built => out.push(old.clone()),
                _ => out.push(Arc::new(built)),
            }
        }

        let cursor_point = term.grid().cursor.point;
        let cursor_in_view = point_to_viewport(display_offset, cursor_point).filter(|p| p.line < row_count);
        let cursor_style = term.cursor_style();
        let cursor = Cursor {
            col: cursor_in_view.map_or(0, |p| p.column.0 as u16),
            row: cursor_in_view.map_or(0, |p| p.line as u16),
            visible: term.mode().contains(TermMode::SHOW_CURSOR) && cursor_in_view.is_some(),
            shape: match cursor_style.shape {
                AnsiCursorShape::Beam => CursorShape::Bar,
                AnsiCursorShape::Underline => CursorShape::Underline,
                AnsiCursorShape::Block | AnsiCursorShape::HollowBlock | AnsiCursorShape::Hidden => CursorShape::Block,
            },
            blinking: cursor_style.blinking,
        };

        let selection = viewport_selection(term);
        term.reset_damage();
        self.force_full = false;
        self.prev.clone_from(&out);
        if self.links.len() > 4096 {
            self.links.clear();
        }

        Frame { rows: out, cursor, selection }
    }
}

fn intern_link(links: &mut HashMap<String, Arc<str>>, uri: &str) -> Arc<str> {
    if let Some(existing) = links.get(uri) {
        return existing.clone();
    }
    let arc: Arc<str> = Arc::from(uri);
    links.insert(uri.to_string(), arc.clone());
    arc
}

#[cfg(test)]
mod tests {
    use super::*;
    use alacritty_terminal::event::VoidListener;
    use alacritty_terminal::term::Config;
    use alacritty_terminal::vte::ansi::Processor;

    struct TestSize(usize, usize);
    impl Dimensions for TestSize {
        fn total_lines(&self) -> usize {
            self.1
        }
        fn screen_lines(&self) -> usize {
            self.1
        }
        fn columns(&self) -> usize {
            self.0
        }
    }

    fn test_theme() -> Theme {
        Theme {
            foreground: Rgb(220, 220, 220),
            background: Rgb(20, 20, 20),
            cursor: Rgb(255, 255, 255),
            selection: Rgb(60, 80, 120),
            ansi: [Rgb(0, 0, 0); 16],
        }
    }

    fn text(frame: &Frame) -> Vec<String> {
        frame.rows.iter().map(|row| row.runs.iter().map(|run| run.text.as_str()).collect()).collect()
    }

    #[test]
    fn bytes_in_cells_out() {
        let mut term = Term::new(Config::default(), &TestSize(20, 4), VoidListener);
        let mut processor: Processor = Processor::new();
        let mut builder = Builder::new();
        let theme = test_theme();

        let first = builder.build(&mut term, &theme);
        assert_eq!(text(&first), ["", "", "", ""]);

        processor.advance(&mut term, b"hello\r\n");
        let second = builder.build(&mut term, &theme);
        assert_eq!(text(&second)[0], "hello");
        assert!(Arc::ptr_eq(&first.rows[3], &second.rows[3]));
        assert_eq!((second.cursor.row, second.cursor.col), (1, 0));
    }
}
