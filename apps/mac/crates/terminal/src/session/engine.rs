//! `alacritty_terminal::Term` wrapper tracking Mode 2026 synchronized output,
//! primary-screen scroll epochs, OSC 133 command blocks, and paste encoding.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::ops::Range;
use std::rc::Rc;
use std::time::{Duration, Instant};

use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::grid::{Dimensions, GridCell, Scroll};
use alacritty_terminal::index::{Column, Line, Point as GridPoint};
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{
    self, Attr, CharsetIndex, ClearMode, CursorShape, CursorStyle, Handler, Hyperlink, KeyboardModes, KeyboardModesApplyBehavior, LineClearMode, Mode,
    ModifyOtherKeys, NamedPrivateMode, PrivateMode, Processor, Rgb as AnsiRgb, ScpCharPath, ScpUpdateMode, StandardCharset, TabulationClearMode, Timeout,
};
use unicode_width::UnicodeWidthChar;

use crate::screen::resolve_color_index;
use crate::{CommandBlock, TermSize, Theme};

const MAX_BLOCKS: usize = 64;

/// No-op timeout for `vte::ansi::Processor` so bytes always hit `Term`
/// immediately while Mode 2026 (`CSI ? 2026 h / l`) holds *snapshot publishing*
/// via `TermEngine::hold_since`.
#[derive(Default)]
pub(crate) struct NoopTimeout;

impl Timeout for NoopTimeout {
    fn set_timeout(&mut self, _duration: Duration) {}
    fn clear_timeout(&mut self) {}
    fn pending_timeout(&self) -> bool {
        false
    }
}

#[derive(Clone, Default)]
pub(crate) struct EventProxy {
    events: Rc<RefCell<Vec<Event>>>,
}

impl EventProxy {
    pub(crate) fn drain(&self) -> Vec<Event> {
        std::mem::take(&mut *self.events.borrow_mut())
    }
}

impl EventListener for EventProxy {
    fn send_event(&self, event: Event) {
        self.events.borrow_mut().push(event);
    }
}

#[derive(Clone, Copy)]
pub(crate) struct GridDims {
    pub cols: usize,
    pub rows: usize,
}

impl From<TermSize> for GridDims {
    fn from(size: TermSize) -> Self {
        Self {
            cols: usize::from(size.cols.max(2)),
            rows: usize::from(size.rows.max(1)),
        }
    }
}

impl Dimensions for GridDims {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

/// Position pinned to a primary-screen line via monotonic `scroll_epoch`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TrackedPoint {
    pub abs_line: i64,
    pub col: usize,
}

pub(crate) struct Block {
    pub info: CommandBlock,
    pub started: Instant,
    pub output_start: Option<TrackedPoint>,
    pub output_end: Option<TrackedPoint>,
}

pub(crate) struct TermEngine {
    pub term: Term<EventProxy>,
    pub events: EventProxy,
    pub hold_since: Option<Instant>,
    max_scrollback: usize,
    scroll_region: Range<Line>,
    scroll_epoch: i64,
    blocks: VecDeque<Block>,
    next_block_id: u64,
    input_start: Option<TrackedPoint>,
}

impl TermEngine {
    pub(crate) fn new(size: TermSize, scrollback_lines: usize) -> Self {
        let dims = GridDims::from(size);
        let events = EventProxy::default();
        let config = Config {
            scrolling_history: scrollback_lines,
            default_cursor_style: CursorStyle {
                shape: CursorShape::Block,
                blinking: true,
            },
            kitty_keyboard: true,
            ..Config::default()
        };
        let term = Term::new(config, &dims, events.clone());
        Self {
            term,
            events,
            hold_since: None,
            max_scrollback: scrollback_lines,
            scroll_region: Line(0)..Line(dims.rows as i32),
            scroll_epoch: 0,
            blocks: VecDeque::new(),
            next_block_id: 1,
            input_start: None,
        }
    }

    pub(crate) fn feed_bytes(&mut self, processor: &mut Processor<NoopTimeout>, bytes: &[u8]) {
        if !bytes.is_empty() {
            processor.advance(self, bytes);
        }
    }

    pub(crate) fn resize(&mut self, size: TermSize) {
        let initial_hist = self.term.history_size();
        let old_cols = self.term.columns();
        let old_rows = self.term.screen_lines();
        let dims = GridDims::from(size);

        if dims.rows != old_rows {
            self.term.resize(GridDims {
                cols: old_cols,
                rows: dims.rows,
            });
        }
        let hist_before_width = self.term.history_size();
        if dims.cols != old_cols {
            self.term.resize(dims);
        }

        // When narrowing columns on the primary screen causes rows to wrap,
        // `alacritty_terminal` pushes lines off the top into scrollback even
        // when empty rows exist below the cursor. Pull them back into the
        // unused bottom rows so top-of-screen content stays visible.
        if !self.is_alt_screen() && dims.cols < old_cols {
            let pushed_by_wrap = self.term.history_size().saturating_sub(hist_before_width);
            let empty_below = self.empty_rows_below_cursor();
            let pull = pushed_by_wrap.min(empty_below).min(dims.rows.saturating_sub(1));
            if pull > 0 {
                self.term.resize(GridDims {
                    cols: dims.cols,
                    rows: dims.rows - pull,
                });
                self.term.resize(dims);
            }
        }

        let new_hist = self.term.history_size();
        self.scroll_epoch += new_hist as i64 - initial_hist as i64;
        self.scroll_region = Line(0)..Line(dims.rows as i32);
    }

    fn empty_rows_below_cursor(&self) -> usize {
        let grid = self.term.grid();
        let rows = self.term.screen_lines();
        let cols = self.term.columns();
        let cursor_row = grid.cursor.point.line.0.max(0) as usize;
        let mut count = 0;
        for y in (cursor_row + 1..rows).rev() {
            let row = &grid[Line(y as i32)];
            if (0..cols).all(|x| row[Column(x)].is_empty()) {
                count += 1;
            } else {
                break;
            }
        }
        count
    }

    pub(crate) fn is_alt_screen(&self) -> bool {
        self.term.mode().contains(TermMode::ALT_SCREEN)
    }

    pub(crate) fn is_mouse_tracking(&self) -> bool {
        self.term.mode().intersects(TermMode::MOUSE_MODE)
    }

    pub(crate) fn scroll_to_bottom(&mut self) -> bool {
        if self.term.grid().display_offset() != 0 {
            self.term.scroll_display(Scroll::Bottom);
            true
        } else {
            false
        }
    }

    pub(crate) fn color_response(&self, index: usize, theme: &Theme) -> AnsiRgb {
        let rgb = resolve_color_index(index, self.term.colors(), theme);
        AnsiRgb { r: rgb.0, g: rgb.1, b: rgb.2 }
    }

    pub(crate) fn window_size(size: TermSize) -> WindowSize {
        WindowSize {
            num_lines: size.rows,
            num_cols: size.cols,
            cell_width: size.cell_width_px,
            cell_height: size.cell_height_px,
        }
    }

    pub(crate) fn track_cursor(&self) -> Option<TrackedPoint> {
        if self.is_alt_screen() {
            return None;
        }
        let pt = self.term.grid().cursor.point;
        Some(TrackedPoint {
            abs_line: self.scroll_epoch + i64::from(pt.line.0),
            col: pt.column.0,
        })
    }

    fn resolve_point(&self, pt: TrackedPoint) -> Option<GridPoint> {
        let line = Line((pt.abs_line - self.scroll_epoch) as i32);
        if line < self.term.topmost_line() || line > self.term.bottommost_line() {
            return None;
        }
        let col = Column(pt.col.min(self.term.columns().saturating_sub(1)));
        Some(GridPoint::new(line, col))
    }

    fn previous_cell(&self, pt: GridPoint) -> Option<GridPoint> {
        if pt.column.0 > 0 {
            Some(GridPoint::new(pt.line, Column(pt.column.0 - 1)))
        } else if pt.line > self.term.topmost_line() {
            Some(GridPoint::new(pt.line - 1, self.term.last_column()))
        } else {
            None
        }
    }

    fn text_between(&self, start: GridPoint, end: GridPoint) -> String {
        if end < start {
            return String::new();
        }
        self.term.bounds_to_string(start, end)
    }

    pub(crate) fn on_prompt_start(&mut self) {
        self.input_start = None;
    }

    pub(crate) fn on_input_start(&mut self) {
        self.input_start = self.track_cursor();
    }

    pub(crate) fn on_output_start(&mut self, command: String) -> CommandBlock {
        let output_start = self.track_cursor();
        let command = if command.trim().is_empty() {
            self.typed_command(output_start)
        } else {
            command
        };
        self.input_start = None;
        let info = CommandBlock {
            id: self.next_block_id,
            command: command.trim().to_string(),
            exit_code: None,
            duration_ms: None,
        };
        self.next_block_id += 1;
        if self.blocks.len() >= MAX_BLOCKS {
            self.blocks.pop_front();
        }
        self.blocks.push_back(Block {
            info: info.clone(),
            started: Instant::now(),
            output_start,
            output_end: None,
        });
        info
    }

    pub(crate) fn on_command_end(&mut self, exit_code: Option<i32>) -> Option<CommandBlock> {
        let output_end = self.track_cursor();
        let block = self.blocks.back_mut()?;
        if block.output_end.is_some() || block.info.duration_ms.is_some() {
            return None;
        }
        block.output_end = output_end;
        block.info.exit_code = exit_code;
        block.info.duration_ms = Some(block.started.elapsed().as_millis() as u64);
        Some(block.info.clone())
    }

    fn typed_command(&self, output_start: Option<TrackedPoint>) -> String {
        let text = (|| {
            let start = self.resolve_point(self.input_start?)?;
            let end = self.resolve_point(output_start?)?;
            let end = self.previous_cell(end)?;
            Some(self.text_between(start, end))
        })();
        text.unwrap_or_default()
    }

    pub(crate) fn command_output(&self, id: u64) -> Option<String> {
        let block = self.blocks.iter().find(|b| b.info.id == id)?;
        if self.is_alt_screen() {
            return None;
        }
        let start = self.resolve_point(block.output_start?)?;
        let end = self.resolve_point(block.output_end?)?;
        let Some(end) = self.previous_cell(end) else {
            return Some(String::new());
        };
        let text = self.text_between(start, end);
        Some(text.trim_end_matches(['\n', '\r']).to_string())
    }

    pub(crate) fn scrollback_text(&self, max_lines: usize) -> String {
        let total = self.term.total_lines();
        if total == 0 || max_lines == 0 {
            return String::new();
        }
        let kept = max_lines.min(total);
        let bottom = self.term.bottommost_line();
        let first = Line(bottom.0 + 1 - kept as i32);
        self.term
            .bounds_to_string(GridPoint::new(first, Column(0)), GridPoint::new(bottom, self.term.last_column()))
    }

    fn primary_scroll_tracked<F: FnOnce(&mut Term<EventProxy>)>(&mut self, fallback_delta: usize, f: F) {
        let primary = !self.is_alt_screen() && self.scroll_region.start == Line(0);
        let before_hist = self.term.history_size();
        f(&mut self.term);
        if primary {
            let after_hist = self.term.history_size();
            let delta = if before_hist < self.max_scrollback {
                after_hist.saturating_sub(before_hist)
            } else {
                fallback_delta
            };
            self.scroll_epoch += delta as i64;
        }
    }

    fn viewport_clear_scroll_lines(&self) -> usize {
        let grid = self.term.grid();
        let lines = self.term.screen_lines();
        let cols = self.term.columns();
        for y in (0..lines).rev() {
            let row = &grid[Line(y as i32)];
            if (0..cols).any(|x| !row[Column(x)].is_empty()) {
                return y + 1;
            }
        }
        0
    }
}

/// Encodes pasted text for bracketed or plain paste modes.
pub(crate) fn encode_paste(text: &str, bracketed: bool) -> Vec<u8> {
    if bracketed {
        let sanitized = text.replace("\x1b[201~", "");
        let mut out = Vec::with_capacity(sanitized.len() + 12);
        out.extend_from_slice(b"\x1b[200~");
        out.extend_from_slice(sanitized.as_bytes());
        out.extend_from_slice(b"\x1b[201~");
        out
    } else {
        text.replace("\r\n", "\r").replace('\n', "\r").into_bytes()
    }
}

impl Handler for TermEngine {
    fn set_title(&mut self, title: Option<String>) {
        Handler::set_title(&mut self.term, title);
    }
    fn set_cursor_style(&mut self, style: Option<CursorStyle>) {
        Handler::set_cursor_style(&mut self.term, style);
    }
    fn set_cursor_shape(&mut self, shape: CursorShape) {
        Handler::set_cursor_shape(&mut self.term, shape);
    }
    fn input(&mut self, c: char) {
        let width = c.width().unwrap_or(0);
        let cursor = &self.term.grid().cursor;
        let will_wrap = width > 0
            && (cursor.input_needs_wrap || (width == 2 && cursor.point.column.0 + 1 >= self.term.columns() && self.term.mode().contains(TermMode::LINE_WRAP)));
        let fallback = usize::from(will_wrap && cursor.point.line + 1 == self.scroll_region.end);
        self.primary_scroll_tracked(fallback, |term| Handler::input(term, c));
    }
    fn goto(&mut self, line: i32, col: usize) {
        Handler::goto(&mut self.term, line, col);
    }
    fn goto_line(&mut self, line: i32) {
        Handler::goto_line(&mut self.term, line);
    }
    fn goto_col(&mut self, col: usize) {
        Handler::goto_col(&mut self.term, col);
    }
    fn insert_blank(&mut self, count: usize) {
        Handler::insert_blank(&mut self.term, count);
    }
    fn move_up(&mut self, rows: usize) {
        Handler::move_up(&mut self.term, rows);
    }
    fn move_down(&mut self, rows: usize) {
        Handler::move_down(&mut self.term, rows);
    }
    fn identify_terminal(&mut self, intermediate: Option<char>) {
        Handler::identify_terminal(&mut self.term, intermediate);
    }
    fn device_status(&mut self, arg: usize) {
        Handler::device_status(&mut self.term, arg);
    }
    fn move_forward(&mut self, cols: usize) {
        Handler::move_forward(&mut self.term, cols);
    }
    fn move_backward(&mut self, cols: usize) {
        Handler::move_backward(&mut self.term, cols);
    }
    fn move_down_and_cr(&mut self, rows: usize) {
        Handler::move_down_and_cr(&mut self.term, rows);
    }
    fn move_up_and_cr(&mut self, rows: usize) {
        Handler::move_up_and_cr(&mut self.term, rows);
    }
    fn put_tab(&mut self, count: u16) {
        let cursor = &self.term.grid().cursor;
        let fallback = usize::from(cursor.input_needs_wrap && cursor.point.line + 1 == self.scroll_region.end);
        self.primary_scroll_tracked(fallback, |term| Handler::put_tab(term, count));
    }
    fn backspace(&mut self) {
        Handler::backspace(&mut self.term);
    }
    fn carriage_return(&mut self) {
        Handler::carriage_return(&mut self.term);
    }
    fn linefeed(&mut self) {
        let fallback = usize::from(self.term.grid().cursor.point.line + 1 == self.scroll_region.end);
        self.primary_scroll_tracked(fallback, Handler::linefeed);
    }
    fn bell(&mut self) {
        Handler::bell(&mut self.term);
    }
    fn substitute(&mut self) {
        Handler::substitute(&mut self.term);
    }
    fn newline(&mut self) {
        let fallback = usize::from(self.term.grid().cursor.point.line + 1 == self.scroll_region.end);
        self.primary_scroll_tracked(fallback, Handler::newline);
    }
    fn set_horizontal_tabstop(&mut self) {
        Handler::set_horizontal_tabstop(&mut self.term);
    }
    fn scroll_up(&mut self, lines: usize) {
        let region_len = (self.scroll_region.end.0 - self.scroll_region.start.0).max(0) as usize;
        let fallback = lines.min(region_len);
        self.primary_scroll_tracked(fallback, |term| Handler::scroll_up(term, lines));
    }
    fn scroll_down(&mut self, lines: usize) {
        Handler::scroll_down(&mut self.term, lines);
    }
    fn insert_blank_lines(&mut self, count: usize) {
        Handler::insert_blank_lines(&mut self.term, count);
    }
    fn delete_lines(&mut self, count: usize) {
        let cursor_line = self.term.grid().cursor.point.line;
        let fallback = if cursor_line == Line(0) { count.min(self.term.screen_lines()) } else { 0 };
        self.primary_scroll_tracked(fallback, |term| Handler::delete_lines(term, count));
    }
    fn erase_chars(&mut self, count: usize) {
        Handler::erase_chars(&mut self.term, count);
    }
    fn delete_chars(&mut self, count: usize) {
        Handler::delete_chars(&mut self.term, count);
    }
    fn move_backward_tabs(&mut self, count: u16) {
        Handler::move_backward_tabs(&mut self.term, count);
    }
    fn move_forward_tabs(&mut self, count: u16) {
        Handler::move_forward_tabs(&mut self.term, count);
    }
    fn save_cursor_position(&mut self) {
        Handler::save_cursor_position(&mut self.term);
    }
    fn restore_cursor_position(&mut self) {
        Handler::restore_cursor_position(&mut self.term);
    }
    fn clear_line(&mut self, mode: LineClearMode) {
        Handler::clear_line(&mut self.term, mode);
    }
    fn clear_screen(&mut self, mode: ClearMode) {
        let fallback = if matches!(mode, ClearMode::All) && !self.is_alt_screen() {
            self.viewport_clear_scroll_lines()
        } else {
            0
        };
        self.primary_scroll_tracked(fallback, |term| Handler::clear_screen(term, mode));
    }
    fn clear_tabs(&mut self, mode: TabulationClearMode) {
        Handler::clear_tabs(&mut self.term, mode);
    }
    fn set_tabs(&mut self, interval: u16) {
        Handler::set_tabs(&mut self.term, interval);
    }
    fn reset_state(&mut self) {
        self.hold_since = None;
        self.input_start = None;
        self.scroll_region = Line(0)..Line(self.term.screen_lines() as i32);
        Handler::reset_state(&mut self.term);
    }
    fn reverse_index(&mut self) {
        Handler::reverse_index(&mut self.term);
    }
    fn terminal_attribute(&mut self, attr: Attr) {
        Handler::terminal_attribute(&mut self.term, attr);
    }
    fn set_mode(&mut self, mode: Mode) {
        Handler::set_mode(&mut self.term, mode);
    }
    fn unset_mode(&mut self, mode: Mode) {
        Handler::unset_mode(&mut self.term, mode);
    }
    fn report_mode(&mut self, mode: Mode) {
        Handler::report_mode(&mut self.term, mode);
    }
    fn set_private_mode(&mut self, mode: PrivateMode) {
        if mode == PrivateMode::Named(NamedPrivateMode::SyncUpdate) {
            self.hold_since = Some(Instant::now());
            return;
        }
        if mode == PrivateMode::Named(NamedPrivateMode::ColumnMode) {
            self.scroll_region = Line(0)..Line(self.term.screen_lines() as i32);
        }
        Handler::set_private_mode(&mut self.term, mode);
    }
    fn unset_private_mode(&mut self, mode: PrivateMode) {
        if mode == PrivateMode::Named(NamedPrivateMode::SyncUpdate) {
            self.hold_since = None;
            return;
        }
        if mode == PrivateMode::Named(NamedPrivateMode::ColumnMode) {
            self.scroll_region = Line(0)..Line(self.term.screen_lines() as i32);
        }
        Handler::unset_private_mode(&mut self.term, mode);
    }
    fn report_private_mode(&mut self, mode: PrivateMode) {
        if mode == PrivateMode::Named(NamedPrivateMode::SyncUpdate) {
            let state = if self.hold_since.is_some() { 1 } else { 2 };
            self.events.send_event(Event::PtyWrite(format!("\x1b[?2026;{state}$y")));
            return;
        }
        Handler::report_private_mode(&mut self.term, mode);
    }
    fn set_scrolling_region(&mut self, top: usize, bottom: Option<usize>) {
        let screen_lines = self.term.screen_lines();
        let bottom_resolved = bottom.unwrap_or(screen_lines);
        if top < bottom_resolved {
            let limit = Line(screen_lines as i32);
            let start = Line(top as i32 - 1).min(limit);
            let end = Line(bottom_resolved as i32).min(limit);
            self.scroll_region = start..end;
        }
        Handler::set_scrolling_region(&mut self.term, top, bottom);
    }
    fn set_keypad_application_mode(&mut self) {
        Handler::set_keypad_application_mode(&mut self.term);
    }
    fn unset_keypad_application_mode(&mut self) {
        Handler::unset_keypad_application_mode(&mut self.term);
    }
    fn set_active_charset(&mut self, index: CharsetIndex) {
        Handler::set_active_charset(&mut self.term, index);
    }
    fn configure_charset(&mut self, index: CharsetIndex, charset: StandardCharset) {
        Handler::configure_charset(&mut self.term, index, charset);
    }
    fn set_color(&mut self, index: usize, color: AnsiRgb) {
        Handler::set_color(&mut self.term, index, color);
    }
    fn dynamic_color_sequence(&mut self, prefix: String, index: usize, terminator: &str) {
        Handler::dynamic_color_sequence(&mut self.term, prefix, index, terminator);
    }
    fn reset_color(&mut self, index: usize) {
        Handler::reset_color(&mut self.term, index);
    }
    fn clipboard_store(&mut self, clipboard: u8, base64: &[u8]) {
        Handler::clipboard_store(&mut self.term, clipboard, base64);
    }
    fn clipboard_load(&mut self, clipboard: u8, terminator: &str) {
        Handler::clipboard_load(&mut self.term, clipboard, terminator);
    }
    fn decaln(&mut self) {
        Handler::decaln(&mut self.term);
    }
    fn push_title(&mut self) {
        Handler::push_title(&mut self.term);
    }
    fn pop_title(&mut self) {
        Handler::pop_title(&mut self.term);
    }
    fn text_area_size_pixels(&mut self) {
        Handler::text_area_size_pixels(&mut self.term);
    }
    fn text_area_size_chars(&mut self) {
        Handler::text_area_size_chars(&mut self.term);
    }
    fn set_hyperlink(&mut self, hyperlink: Option<Hyperlink>) {
        Handler::set_hyperlink(&mut self.term, hyperlink);
    }
    fn set_mouse_cursor_icon(&mut self, icon: ansi::cursor_icon::CursorIcon) {
        Handler::set_mouse_cursor_icon(&mut self.term, icon);
    }
    fn report_keyboard_mode(&mut self) {
        Handler::report_keyboard_mode(&mut self.term);
    }
    fn push_keyboard_mode(&mut self, mode: KeyboardModes) {
        Handler::push_keyboard_mode(&mut self.term, mode);
    }
    fn pop_keyboard_modes(&mut self, to_pop: u16) {
        Handler::pop_keyboard_modes(&mut self.term, to_pop);
    }
    fn set_keyboard_mode(&mut self, mode: KeyboardModes, behavior: KeyboardModesApplyBehavior) {
        Handler::set_keyboard_mode(&mut self.term, mode, behavior);
    }
    fn set_modify_other_keys(&mut self, mode: ModifyOtherKeys) {
        Handler::set_modify_other_keys(&mut self.term, mode);
    }
    fn report_modify_other_keys(&mut self) {
        Handler::report_modify_other_keys(&mut self.term);
    }
    fn set_scp(&mut self, char_path: ScpCharPath, update_mode: ScpUpdateMode) {
        Handler::set_scp(&mut self.term, char_path, update_mode);
    }
}
