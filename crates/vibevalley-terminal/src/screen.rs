//! Turns the libghostty-vt render state into immutable [`Row`]s.

use std::collections::HashMap;
use std::sync::Arc;

use libghostty_vt::{
    Error, RenderState, Terminal,
    point::{Coordinate, Point as GridPoint},
    render::{CellIterator, CursorVisualStyle, Dirty, RowIterator},
    screen::CellWide,
    style::Underline,
};

use crate::{CellStyle, Cursor, CursorShape, Point, Rgb, Row, Run};

pub(crate) struct Frame {
    pub rows: Vec<Arc<Row>>,
    pub cursor: Cursor,
    pub selection: Option<(Point, Point)>,
}

pub(crate) struct Builder {
    render: RenderState<'static>,
    row_it: RowIterator<'static>,
    cell_it: CellIterator<'static>,
    prev: Vec<Arc<Row>>,
    force_full: bool,
    links: HashMap<Vec<u8>, Arc<str>>,
    text: String,
}

fn rgb(c: libghostty_vt::color::Rgb) -> Rgb {
    Rgb(c.r, c.g, c.b)
}

/// A blank cell that paints nothing, so it can be dropped from a row's tail.
fn paints_nothing(style: &CellStyle) -> bool {
    style.bg.is_none() && !style.underline && !style.strikethrough
}

impl Builder {
    pub(crate) fn new() -> Result<Self, Error> {
        Ok(Self {
            render: RenderState::new()?,
            row_it: RowIterator::new()?,
            cell_it: CellIterator::new()?,
            prev: Vec::new(),
            force_full: true,
            links: HashMap::new(),
            text: String::new(),
        })
    }

    /// Rebuild every row on the next frame (theme change).
    pub(crate) fn invalidate(&mut self) {
        self.force_full = true;
    }

    pub(crate) fn build(&mut self, term: &Terminal<'static, 'static>) -> Result<Frame, Error> {
        let snap = self.render.update(term)?;
        let colors = snap.colors()?;
        let default_fg = rgb(colors.foreground);
        let default_bg = rgb(colors.background);
        let row_count = usize::from(snap.rows()?);
        let full = self.force_full || snap.dirty()? == Dirty::Full || self.prev.len() != row_count;

        let mut out: Vec<Arc<Row>> = Vec::with_capacity(row_count);
        let mut sel_start = None;
        let mut sel_end = None;

        let mut rows = self.row_it.update(&snap)?;
        let mut y: u16 = 0;
        while let Some(row) = rows.next() {
            if let Some(sel) = row.selection()? {
                if sel_start.is_none() {
                    sel_start = Some(Point { row: y, col: sel.start_x });
                }
                sel_end = Some(Point { row: y, col: sel.end_x });
            }

            let old = self.prev.get(usize::from(y));
            if !full
                && !row.dirty()?
                && let Some(old) = old
            {
                out.push(old.clone());
                y += 1;
                continue;
            }

            let raw_row = row.raw_row()?;
            let has_links = raw_row.has_hyperlink()?;
            let mut runs: Vec<Run> = Vec::new();
            let mut cells = self.cell_it.update(row)?;
            let mut x: u16 = 0;
            while let Some(cell) = cells.next() {
                let col = x;
                x += 1;
                let raw = cell.raw_cell()?;
                let wide = raw.wide()?;
                if wide == CellWide::SpacerTail {
                    continue;
                }
                let width: u16 = if wide == CellWide::Wide { 2 } else { 1 };

                cell.graphemes_utf8(&mut self.text)?;
                let blank = self.text.is_empty();

                let mut fg = cell.fg_color()?.map_or(default_fg, rgb);
                let mut bg = cell.bg_color()?.map(rgb);
                let mut style = CellStyle {
                    fg,
                    bg,
                    bold: false,
                    italic: false,
                    dim: false,
                    underline: false,
                    strikethrough: false,
                };
                if cell.has_styling()? {
                    let s = cell.style()?;
                    if s.inverse {
                        let old_fg = fg;
                        fg = bg.unwrap_or(default_bg);
                        bg = Some(old_fg);
                    }
                    if s.invisible {
                        fg = bg.unwrap_or(default_bg);
                    }
                    style = CellStyle {
                        fg,
                        bg,
                        bold: s.bold,
                        italic: s.italic,
                        dim: s.faint,
                        underline: s.underline != Underline::None,
                        strikethrough: s.strikethrough,
                    };
                }
                if blank {
                    // Blank cells carry no glyph, so their foreground is
                    // irrelevant; normalizing it lets them merge into runs.
                    style.fg = default_fg;
                }

                let hyperlink = if has_links && raw.has_hyperlink()? {
                    hyperlink_at(term, &mut self.links, col, y)
                } else {
                    None
                };

                let text = if blank { " " } else { self.text.as_str() };
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

            let built = Row {
                runs,
                wrapped: raw_row.is_wrapped()?,
            };
            match old {
                Some(old) if **old == built => out.push(old.clone()),
                _ => out.push(Arc::new(built)),
            }
            y += 1;
        }

        let c = snap.cursor()?;
        let cursor = Cursor {
            col: c.viewport.map_or(0, |v| v.x),
            row: c.viewport.map_or(0, |v| v.y),
            visible: c.visible && c.viewport.is_some(),
            shape: match c.visual_style {
                CursorVisualStyle::Bar => CursorShape::Bar,
                CursorVisualStyle::Underline => CursorShape::Underline,
                _ => CursorShape::Block,
            },
            blinking: c.blinking,
        };

        snap.clean()?;
        self.force_full = false;
        self.prev.clone_from(&out);
        if self.links.len() > 4096 {
            self.links.clear();
        }

        Ok(Frame {
            rows: out,
            cursor,
            selection: sel_start.zip(sel_end),
        })
    }
}

fn hyperlink_at(term: &Terminal<'static, 'static>, links: &mut HashMap<Vec<u8>, Arc<str>>, col: u16, row: u16) -> Option<Arc<str>> {
    let grid_ref = term.grid_ref(GridPoint::Viewport(Coordinate { x: col, y: u32::from(row) })).ok()?;
    let mut buf = vec![0u8; 256];
    let len = match grid_ref.hyperlink_uri(&mut buf) {
        Ok(len) => len,
        Err(Error::OutOfSpace { required }) => {
            buf.resize(required, 0);
            grid_ref.hyperlink_uri(&mut buf).ok()?
        }
        Err(_) => return None,
    };
    if len == 0 {
        return None;
    }
    buf.truncate(len);
    if let Some(link) = links.get(&buf) {
        return Some(link.clone());
    }
    let link: Arc<str> = Arc::from(String::from_utf8_lossy(&buf).as_ref());
    links.insert(buf, link.clone());
    Some(link)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(frame: &Frame) -> Vec<String> {
        frame.rows.iter().map(|row| row.runs.iter().map(|run| run.text.as_str()).collect()).collect()
    }

    #[test]
    fn bytes_in_cells_out() {
        let mut term = Terminal::new(20, 4).unwrap();
        let mut builder = Builder::new().unwrap();
        let first = builder.build(&term).unwrap();
        assert_eq!(text(&first), ["", "", "", ""]);

        term.vt_write(b"hello\r\n");
        let second = builder.build(&term).unwrap();
        eprintln!("{:?}", text(&second));
        assert_eq!(text(&second)[0], "hello");
        assert!(Arc::ptr_eq(&first.rows[3], &second.rows[3]));
        assert_eq!((second.cursor.row, second.cursor.col), (1, 0));
    }
}

#[cfg(test)]
mod bench {
    use super::*;
    use libghostty_vt::terminal::Boundary;

    #[test]
    #[ignore = "timing probe"]
    fn parse_speed() {
        eprintln!("optimize: {:?}", libghostty_vt::build_info::optimize_mode());
        let line = b"the quick brown fox jumps over the lazy dog 0123456789 abcdefghij\r\n";
        let data: Vec<u8> = line.iter().copied().cycle().take(2_000_000).collect();
        for until in [false, true] {
            let mut term = Terminal::new(100, 30).unwrap();
            term.set_scrollback_max_lines(Some(10_000)).unwrap();
            let t = std::time::Instant::now();
            for chunk in data.chunks(65536) {
                if until {
                    let mut rest = chunk;
                    while let Ok(Some(stop)) = term.vt_write_until(rest, Boundary::OSC_END) {
                        rest = &rest[stop.consumed..];
                    }
                } else {
                    term.vt_write(chunk);
                }
            }
            eprintln!("until={until}: {:?} scrollback={:?}", t.elapsed(), term.scrollback_rows());
            let mut builder = Builder::new().unwrap();
            let t = std::time::Instant::now();
            for _ in 0..100 {
                builder.invalidate();
                builder.build(&term).unwrap();
            }
            eprintln!("100 full builds: {:?}", t.elapsed());
        }
    }
}
