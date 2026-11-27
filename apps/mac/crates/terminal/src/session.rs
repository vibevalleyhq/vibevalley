//! The session thread: owns the libghostty-vt terminal (which is `!Send`) and
//! the PTY, applies messages from handles, and publishes snapshots.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::os::fd::OwnedFd;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use libghostty_vt::{
    Error, Terminal,
    effect::{ConformanceLevel, DeviceAttributeFeature, DeviceAttributes, DeviceType, PrimaryDeviceAttributes, SecondaryDeviceAttributes, SemanticPromptKind},
    fmt::{Format, Formatter},
    grid_ref::TrackedGridRef,
    mode::Mode,
    paste,
    point::{Coordinate, Point as GridPoint, Space},
    report::SizeReportSize,
    screen::Screen,
    selection::{Order, SelectLineOptions, SelectWordOptions, Selection},
    terminal::{Boundary, ScrollViewport},
};

use crate::input::Input;
use crate::pty::{self, Pty};
use crate::screen::Builder;
use crate::{CommandBlock, Cursor, CursorShape, Key, KeyInput, Mods, MouseInput, Point, SelectionMode, Snapshot, TermError, TermEvent, TermSize, Theme};

/// Minimum spacing between published snapshots while output keeps arriving.
const FRAME: Duration = Duration::from_millis(8);
/// Longest a program may hold rendering with synchronized output.
const MAX_HOLD: Duration = Duration::from_secs(1);
/// Quiet time after the child exits before giving up on a PTY EOF (a
/// background job can keep the slave side open indefinitely).
const EXIT_DRAIN: Duration = Duration::from_millis(300);
const EXIT_DRAIN_MAX: Duration = Duration::from_secs(3);
const SIGINT_GRACE: Duration = Duration::from_millis(1500);
const SIGHUP_GRACE: Duration = Duration::from_millis(1000);
const FG_POLL_INTERVAL: Duration = Duration::from_millis(20);
const REAP_GRACE: Duration = Duration::from_millis(200);
const MAX_BLOCKS: usize = 64;

pub(crate) enum Msg {
    Pty(Vec<u8>),
    PtyEof,
    ChildExited(Option<i32>),
    Key(KeyInput),
    Text(String),
    Paste(String),
    Mouse(MouseInput),
    Resize(TermSize),
    ScrollLines(i32),
    ScrollToBottom,
    SelectionStart(Point, SelectionMode),
    SelectionExtend(Point),
    SelectionClear,
    SelectionText(mpsc::SyncSender<Option<String>>),
    SetTheme(Theme),
    ScrollbackText(usize, mpsc::SyncSender<String>),
    CommandOutput(u64, mpsc::SyncSender<Option<String>>),
    OptionAsAlt(bool),
    Kill,
    Shutdown,
}

/// State shared between the session thread and its handles.
pub(crate) struct Shared {
    pub snapshot: Mutex<Arc<Snapshot>>,
    /// A `Dirty` event was delivered and `snapshot()` has not been called since.
    pub dirty_pending: AtomicBool,
    pub alive: AtomicBool,
    /// Working directory reported by the shell (OSC 7).
    pub cwd: Mutex<Option<PathBuf>>,
    /// Duplicate of the PTY master, for foreground-process queries.
    pub master_fd: Mutex<Option<OwnedFd>>,
    pub shell_pid: Option<i32>,
}

impl Shared {
    pub(crate) fn new(size: TermSize, master_fd: OwnedFd, shell_pid: Option<i32>) -> Self {
        Self {
            snapshot: Mutex::new(Arc::new(Snapshot {
                seq: 0,
                size,
                rows: Vec::new(),
                cursor: Cursor {
                    col: 0,
                    row: 0,
                    visible: false,
                    shape: CursorShape::Block,
                    blinking: false,
                },
                title: None,
                scroll_offset: 0,
                scrollback_len: 0,
                selection: None,
                alt_screen: false,
                mouse_reporting: false,
                alternate_scroll: false,
            })),
            dirty_pending: AtomicBool::new(false),
            alive: AtomicBool::new(true),
            cwd: Mutex::new(None),
            master_fd: Mutex::new(Some(master_fd)),
            shell_pid,
        }
    }
}

/// What terminal callbacks observed. Callbacks run inside `vt_write` with
/// only a shared terminal view, so they just record; the session thread acts
/// on the records once it has the terminal back.
enum Effect {
    Bell,
    Title,
    Pwd,
    Hold(bool),
    Prompt {
        kind: SemanticPromptKind,
        exit_code: Option<i32>,
        command: String,
    },
}

struct Block {
    info: CommandBlock,
    started: Instant,
    output_start: Option<TrackedGridRef>,
    output_end: Option<TrackedGridRef>,
}

enum Anchor {
    None,
    Cell(TrackedGridRef),
    Span {
        mode: SelectionMode,
        start: TrackedGridRef,
        end: TrackedGridRef,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShutdownStage {
    None,
    /// Stage 1: `SIGINT` sent to foreground process group; waiting for it to exit or return to shell.
    Sigint {
        fg_pgid: i32,
        deadline: Instant,
    },
    /// Stage 2: `SIGHUP` sent to shell/group for history flush; waiting before `SIGKILL`.
    Sighup {
        deadline: Instant,
    },
}

struct Session {
    term: Terminal<'static, 'static>,
    builder: Builder,
    input: Input,
    pty: Pty,
    shared: Arc<Shared>,
    on_event: Box<dyn Fn(TermEvent)>,
    effects: Rc<RefCell<Vec<Effect>>>,
    size: Rc<Cell<TermSize>>,
    title: Option<String>,

    dirty: bool,
    last_publish: Instant,
    hold_since: Option<Instant>,

    anchor: Anchor,
    anchor_screen: Screen,

    blocks: VecDeque<Block>,
    next_block_id: u64,
    input_start: Option<TrackedGridRef>,

    eof: bool,
    /// `Some` once the child was reaped; the inner value is its exit code.
    child_exit: Option<Option<i32>>,
    exited_at: Option<Instant>,
    exit_deadline: Option<Instant>,
    shutdown_stage: ShutdownStage,
    finished: bool,
}

fn backend(e: Error) -> TermError {
    TermError::Backend(e.to_string())
}

fn ghostty_rgb(c: crate::Rgb) -> libghostty_vt::color::Rgb {
    libghostty_vt::color::Rgb { r: c.0, g: c.1, b: c.2 }
}

fn apply_theme(term: &mut Terminal<'static, 'static>, theme: &Theme) -> Result<(), Error> {
    let mut palette = term.default_color_palette()?;
    for (i, color) in theme.ansi.iter().enumerate() {
        palette.0[i] = ghostty_rgb(*color);
    }
    term.set_default_fg_color(Some(ghostty_rgb(theme.foreground)))?
        .set_default_bg_color(Some(ghostty_rgb(theme.background)))?
        .set_default_cursor_color(Some(ghostty_rgb(theme.cursor)))?
        .set_default_color_palette(Some(palette))?;
    Ok(())
}

/// Accepts what shells put in OSC 7: a `file://host/path` URL (percent
/// encoded), kitty's unencoded `kitty-shell-cwd://host/path`, or a bare path.
pub(crate) fn parse_pwd(raw: &[u8]) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStringExt;

    let (rest, encoded) = if let Some(rest) = raw.strip_prefix(b"file://") {
        (rest, true)
    } else if let Some(rest) = raw.strip_prefix(b"kitty-shell-cwd://") {
        (rest, false)
    } else {
        (raw, false)
    };
    let start = rest.iter().position(|b| *b == b'/')?;
    let path = &rest[start..];
    let bytes: Vec<u8> = if encoded {
        percent_encoding::percent_decode(path).collect()
    } else {
        path.to_vec()
    };
    Some(PathBuf::from(std::ffi::OsString::from_vec(bytes)))
}

/// Plain text of the inclusive screen-coordinate range `start..=end`.
fn text_between(term: &Terminal<'static, 'static>, start: Coordinate, end: Coordinate) -> Option<String> {
    if (end.y, end.x) < (start.y, start.x) {
        return Some(String::new());
    }
    let start = term.grid_ref(GridPoint::Screen(start)).ok()?;
    let end = term.grid_ref(GridPoint::Screen(end)).ok()?;
    let selection = Selection::new(start, end, false);
    let mut formatter = Formatter::new(term).ok()?;
    formatter.set_format(Format::Plain).ok()?;
    formatter.set_unwrap(true).ok()?;
    formatter.set_trim(true).ok()?;
    // SAFETY: both endpoints were just resolved from this terminal's active
    // screen and nothing has mutated it since.
    unsafe { formatter.set_selection(Some(&selection)).ok()? };
    let bytes = formatter.format_alloc(None).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// The cell just before `at` in reading order, if any.
fn previous_cell(at: Coordinate, cols: u16) -> Option<Coordinate> {
    if at.x > 0 {
        Some(Coordinate { x: at.x - 1, y: at.y })
    } else if at.y > 0 {
        Some(Coordinate {
            x: cols.saturating_sub(1),
            y: at.y - 1,
        })
    } else {
        None
    }
}

impl Session {
    fn new(opts: &crate::SpawnOptions, pty: Pty, shared: Arc<Shared>, on_event: Box<dyn Fn(TermEvent)>) -> Result<Self, Error> {
        let size = TermSize {
            cols: opts.size.cols.max(1),
            rows: opts.size.rows.max(1),
            ..opts.size
        };
        let mut term = Terminal::new(size.cols, size.rows)?;
        // The byte limit defaults to a single page and would win over the
        // line limit, so lift it and let the line count govern.
        let max_bytes = if opts.scrollback_lines == 0 { 0 } else { usize::MAX };
        term.set_scrollback_max_bytes(Some(max_bytes))?
            .set_scrollback_max_lines(Some(opts.scrollback_lines))?
            .set_terminfo_name("xterm-256color")?;
        term.resize(size.cols, size.rows, u32::from(size.cell_width_px), u32::from(size.cell_height_px))?;
        apply_theme(&mut term, &opts.theme)?;

        let effects: Rc<RefCell<Vec<Effect>>> = Rc::default();
        let size_cell = Rc::new(Cell::new(size));
        let push = |effects: &Rc<RefCell<Vec<Effect>>>| {
            let effects = effects.clone();
            move |effect: Effect| effects.borrow_mut().push(effect)
        };

        let writer = pty.writer.clone();
        term.on_pty_write(move |_, data| {
            let _ = writer.send(data.to_vec());
        })?;
        let record = push(&effects);
        term.on_bell(move |_| record(Effect::Bell))?;
        let record = push(&effects);
        term.on_title_changed(move |_| record(Effect::Title))?;
        let record = push(&effects);
        term.on_pwd_changed(move |_| record(Effect::Pwd))?;
        let record = push(&effects);
        term.on_render_hold(move |_, held| record(Effect::Hold(held)))?;
        let record = push(&effects);
        term.on_semantic_prompt(move |_, event| {
            if let Ok(kind) = event.kind() {
                record(Effect::Prompt {
                    kind,
                    exit_code: event.exit_code(),
                    command: String::from_utf8_lossy(event.command()).into_owned(),
                });
            }
        })?;
        let report_size = size_cell.clone();
        term.on_size(move |_| {
            let size = report_size.get();
            Some(SizeReportSize {
                rows: size.rows,
                columns: size.cols,
                cell_width: u32::from(size.cell_width_px),
                cell_height: u32::from(size.cell_height_px),
            })
        })?;
        term.on_device_attributes(|_| {
            Some(DeviceAttributes {
                primary: PrimaryDeviceAttributes::new(
                    ConformanceLevel::VT220,
                    &[
                        DeviceAttributeFeature::COLUMNS_132,
                        DeviceAttributeFeature::SELECTIVE_ERASE,
                        DeviceAttributeFeature::ANSI_COLOR,
                    ],
                ),
                secondary: SecondaryDeviceAttributes {
                    device_type: DeviceType::VT220,
                    firmware_version: 1,
                    rom_cartridge: 0,
                },
                tertiary: Default::default(),
            })
        })?;
        term.on_xtversion(|_| Some("vibevalley"))?;

        Ok(Self {
            term,
            builder: Builder::new()?,
            input: Input::new()?,
            pty,
            shared,
            on_event,
            effects,
            size: size_cell,
            title: None,
            dirty: true,
            last_publish: Instant::now() - FRAME,
            hold_since: None,
            anchor: Anchor::None,
            anchor_screen: Screen::Primary,
            blocks: VecDeque::new(),
            next_block_id: 1,
            input_start: None,
            eof: false,
            child_exit: None,
            exited_at: None,
            exit_deadline: None,
            shutdown_stage: ShutdownStage::None,
            finished: false,
        })
    }

    fn emit(&self, event: TermEvent) {
        (self.on_event)(event);
    }

    fn feed(&mut self, data: &[u8]) {
        // Stopping at every OSC end hands control back right after a shell
        // integration mark, while the cursor is still where the mark was.
        let mut rest = data;
        while !rest.is_empty() {
            match self.term.vt_write_until(rest, Boundary::OSC_END) {
                Ok(Some(stop)) if stop.consumed > 0 => {
                    rest = &rest[stop.consumed.min(rest.len())..];
                    self.drain_effects();
                }
                Ok(None) => break,
                _ => {
                    self.term.vt_write(rest);
                    break;
                }
            }
        }
        self.drain_effects();
        self.dirty = true;
    }

    fn drain_effects(&mut self) {
        if self.effects.borrow().is_empty() {
            return;
        }
        let effects = std::mem::take(&mut *self.effects.borrow_mut());
        for effect in effects {
            match effect {
                Effect::Bell => self.emit(TermEvent::Bell),
                Effect::Title => {
                    let title = self.term.title().map(|t| String::from_utf8_lossy(t).into_owned()).unwrap_or_default();
                    self.title = (!title.is_empty()).then(|| title.clone());
                    self.emit(TermEvent::TitleChanged(title));
                }
                Effect::Pwd => {
                    let pwd = self.term.pwd().ok().and_then(parse_pwd);
                    if let Some(pwd) = pwd {
                        *self.shared.cwd.lock().unwrap() = Some(pwd.clone());
                        self.emit(TermEvent::CwdChanged(pwd));
                    }
                }
                Effect::Hold(held) => {
                    self.hold_since = held.then(Instant::now);
                }
                Effect::Prompt { kind, exit_code, command } => self.on_prompt(kind, exit_code, command),
            }
        }
    }

    fn track_cursor(&self) -> Option<TrackedGridRef> {
        let at = Coordinate {
            x: self.term.cursor_x().ok()?,
            y: u32::from(self.term.cursor_y().ok()?),
        };
        self.term.track_grid_ref(GridPoint::Active(at)).ok()
    }

    fn on_prompt(&mut self, kind: SemanticPromptKind, exit_code: Option<i32>, command: String) {
        match kind {
            SemanticPromptKind::PromptStart => self.input_start = None,
            SemanticPromptKind::InputStart => self.input_start = self.track_cursor(),
            SemanticPromptKind::OutputStart => {
                let output_start = self.track_cursor();
                let command = if command.trim().is_empty() {
                    self.typed_command(output_start.as_ref())
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
                self.emit(TermEvent::CommandStarted(info));
            }
            SemanticPromptKind::CommandEnd => {
                let output_end = self.track_cursor();
                let Some(block) = self.blocks.back_mut() else {
                    return;
                };
                if block.output_end.is_some() || block.info.duration_ms.is_some() {
                    return;
                }
                block.output_end = output_end;
                block.info.exit_code = exit_code;
                block.info.duration_ms = Some(block.started.elapsed().as_millis() as u64);
                let info = block.info.clone();
                self.emit(TermEvent::CommandFinished(info));
            }
            _ => {}
        }
    }

    /// The command line as it appears on screen between the end of the
    /// prompt and where output starts, for shells that do not send it.
    fn typed_command(&self, output_start: Option<&TrackedGridRef>) -> String {
        let text = (|| {
            let start = self.input_start.as_ref()?.point(Space::Screen).ok()??;
            let end = output_start?.point(Space::Screen).ok()??;
            let end = previous_cell(end, self.size.get().cols)?;
            text_between(&self.term, start, end)
        })();
        text.unwrap_or_default()
    }

    fn command_output(&self, id: u64) -> Option<String> {
        let block = self.blocks.iter().find(|b| b.info.id == id)?;
        // Marks live on the primary screen; the formatter reads the active one.
        if self.term.active_screen().ok()? != Screen::Primary {
            return None;
        }
        let start = block.output_start.as_ref()?.point(Space::Screen).ok()??;
        let end = block.output_end.as_ref()?.point(Space::Screen).ok()??;
        let Some(end) = previous_cell(end, self.size.get().cols) else {
            return Some(String::new());
        };
        let text = text_between(&self.term, start, end)?;
        Some(text.trim_end_matches(['\n', '\r']).to_string())
    }

    fn scrollback_text(&self, max_lines: usize) -> String {
        let (Ok(total), Ok(cols)) = (self.term.total_rows(), self.term.cols()) else {
            return String::new();
        };
        if total == 0 || max_lines == 0 {
            return String::new();
        }
        let first = total.saturating_sub(max_lines);
        text_between(
            &self.term,
            Coordinate { x: 0, y: first as u32 },
            Coordinate {
                x: cols.saturating_sub(1),
                y: (total - 1) as u32,
            },
        )
        .unwrap_or_default()
    }

    fn held(&self, now: Instant) -> bool {
        self.hold_since.is_some_and(|since| now.duration_since(since) < MAX_HOLD)
    }

    fn publish(&mut self) {
        self.dirty = false;
        self.last_publish = Instant::now();
        let Ok(frame) = self.builder.build(&self.term) else {
            return;
        };
        let scrollbar = self.term.scrollbar().unwrap_or_default();
        let prev = self.shared.snapshot.lock().unwrap().clone();
        let next = Snapshot {
            seq: prev.seq + 1,
            size: self.size.get(),
            rows: frame.rows,
            cursor: frame.cursor,
            title: self.title.clone(),
            scroll_offset: scrollbar.total.saturating_sub(scrollbar.offset + scrollbar.len) as usize,
            scrollback_len: scrollbar.total.saturating_sub(scrollbar.len) as usize,
            selection: frame.selection,
            alt_screen: self.term.active_screen().ok() == Some(Screen::Alternate),
            mouse_reporting: self.term.is_mouse_tracking().unwrap_or(false),
            alternate_scroll: false,
        };
        let next = Snapshot {
            alternate_scroll: next.alt_screen && !next.mouse_reporting && self.term.mode(Mode::ALT_SCROLL).unwrap_or(true),
            ..next
        };
        let unchanged = prev.seq > 0
            && prev.size == next.size
            && prev.cursor == next.cursor
            && prev.title == next.title
            && prev.scroll_offset == next.scroll_offset
            && prev.scrollback_len == next.scrollback_len
            && prev.selection == next.selection
            && prev.alt_screen == next.alt_screen
            && prev.mouse_reporting == next.mouse_reporting
            && prev.alternate_scroll == next.alternate_scroll
            && prev.rows.len() == next.rows.len()
            && prev.rows.iter().zip(&next.rows).all(|(a, b)| Arc::ptr_eq(a, b));
        if unchanged {
            return;
        }
        *self.shared.snapshot.lock().unwrap() = Arc::new(next);
        if !self.shared.dirty_pending.swap(true, Ordering::AcqRel) {
            self.emit(TermEvent::Dirty);
        }
    }

    fn writable(&self) -> bool {
        self.child_exit.is_none() && !self.finished
    }

    fn follow_output(&mut self) {
        if !self.term.viewport_active().unwrap_or(true) {
            self.term.scroll_viewport(ScrollViewport::Bottom);
            self.dirty = true;
        }
    }

    fn send_key(&mut self, key: &KeyInput) {
        if !self.writable() {
            return;
        }
        let bytes = self.input.encode_key(&self.term, key);
        if !bytes.is_empty() {
            self.follow_output();
            self.pty.write(bytes);
        }
    }

    fn paste(&mut self, text: String) {
        if !self.writable() || text.is_empty() {
            return;
        }
        let bracketed = self.term.mode(Mode::BRACKETED_PASTE).unwrap_or(false);
        let mut data = text.into_bytes();
        let mut out = vec![0u8; data.len() + 16];
        let len = match paste::encode(&mut data, bracketed, &mut out) {
            Ok(len) => len,
            Err(Error::OutOfSpace { required }) => {
                out.resize(required, 0);
                match paste::encode(&mut data, bracketed, &mut out) {
                    Ok(len) => len,
                    Err(_) => return,
                }
            }
            Err(_) => return,
        };
        out.truncate(len);
        self.follow_output();
        self.pty.write(out);
    }

    fn resize(&mut self, size: TermSize) {
        let size = TermSize {
            cols: size.cols.max(1),
            rows: size.rows.max(1),
            ..size
        };
        if size == self.size.get() {
            return;
        }
        self.size.set(size);
        let _ = self
            .term
            .resize(size.cols, size.rows, u32::from(size.cell_width_px), u32::from(size.cell_height_px));
        self.drain_effects();
        if self.writable() {
            self.pty.resize(size);
        }
        self.dirty = true;
    }

    fn scroll_lines(&mut self, delta: i32) {
        if delta == 0 {
            return;
        }
        let alt = self.term.active_screen().ok() == Some(Screen::Alternate);
        if alt {
            // The alternate screen has no scrollback: like xterm's
            // alternateScroll, turn the scroll into cursor keys unless the
            // program reads the mouse itself.
            let tracking = self.term.is_mouse_tracking().unwrap_or(false);
            let alt_scroll = self.term.mode(Mode::ALT_SCROLL).unwrap_or(false);
            if !tracking && alt_scroll && self.writable() {
                let key = KeyInput {
                    key: if delta > 0 { Key::Up } else { Key::Down },
                    mods: Mods::default(),
                    text: None,
                };
                let one = self.input.encode_key(&self.term, &key);
                let count = delta.unsigned_abs().min(256) as usize;
                self.pty.write(one.repeat(count));
            }
            return;
        }
        self.term.scroll_viewport(ScrollViewport::Delta(-(delta as isize)));
        self.dirty = true;
    }

    fn viewport_point(&self, at: Point) -> GridPoint {
        let size = self.size.get();
        GridPoint::Viewport(Coordinate {
            x: at.col.min(size.cols - 1),
            y: u32::from(at.row.min(size.rows - 1)),
        })
    }

    /// Word or line selection around `at`, as ordered screen coordinates.
    fn span_at(&self, at: GridPoint, mode: SelectionMode) -> Option<(Coordinate, Coordinate)> {
        let grid_ref = self.term.grid_ref(at).ok()?;
        let selection = match mode {
            SelectionMode::Word => self.term.select_word(SelectWordOptions::new(grid_ref)).ok()??,
            SelectionMode::Line => self.term.select_line(SelectLineOptions::new(grid_ref)).ok()??,
            SelectionMode::Cell => return None,
        };
        let ordered = selection.to_ordered(&self.term, Order::Forward).ok()?;
        let start = self.term.point_from_grid_ref(&ordered.start(), Space::Screen).ok()??;
        let end = self.term.point_from_grid_ref(&ordered.end(), Space::Screen).ok()??;
        Some((start, end))
    }

    fn select_screen_range(&self, start: Coordinate, end: Coordinate) {
        let (Ok(start), Ok(end)) = (self.term.grid_ref(GridPoint::Screen(start)), self.term.grid_ref(GridPoint::Screen(end))) else {
            return;
        };
        let _ = self.term.set_selection(Some(&Selection::new(start, end, false)));
    }

    fn selection_start(&mut self, at: Point, mode: SelectionMode) {
        let at = self.viewport_point(at);
        self.anchor = Anchor::None;
        self.anchor_screen = self.term.active_screen().unwrap_or(Screen::Primary);
        let _ = self.term.set_selection(None);
        self.dirty = true;

        if let Some((start, end)) = self.span_at(at, mode) {
            self.select_screen_range(start, end);
            if let (Ok(start), Ok(end)) = (
                self.term.track_grid_ref(GridPoint::Screen(start)),
                self.term.track_grid_ref(GridPoint::Screen(end)),
            ) {
                self.anchor = Anchor::Span { mode, start, end };
            }
        } else if let Ok(anchor) = self.term.track_grid_ref(at) {
            self.anchor = Anchor::Cell(anchor);
        }
    }

    fn selection_extend(&mut self, at: Point) {
        if self.term.active_screen().ok() != Some(self.anchor_screen) {
            self.anchor = Anchor::None;
            return;
        }
        let at = self.viewport_point(at);
        match &self.anchor {
            Anchor::None => {}
            Anchor::Cell(anchor) => {
                let (Ok(Some(start)), Ok(end)) = (anchor.snapshot(&self.term), self.term.grid_ref(at)) else {
                    return;
                };
                let _ = self.term.set_selection(Some(&Selection::new(start, end, false)));
                self.dirty = true;
            }
            Anchor::Span { mode, start, end } => {
                let (Ok(Some(anchor_start)), Ok(Some(anchor_end))) = (start.point(Space::Screen), end.point(Space::Screen)) else {
                    return;
                };
                let target = self.span_at(at, *mode).or_else(|| {
                    let grid_ref = self.term.grid_ref(at).ok()?;
                    let cell = self.term.point_from_grid_ref(&grid_ref, Space::Screen).ok()??;
                    Some((cell, cell))
                });
                let Some((target_start, target_end)) = target else {
                    return;
                };
                let key = |c: &Coordinate| (c.y, c.x);
                let start = if key(&target_start) < key(&anchor_start) {
                    target_start
                } else {
                    anchor_start
                };
                let end = if key(&target_end) > key(&anchor_end) { target_end } else { anchor_end };
                self.select_screen_range(start, end);
                self.dirty = true;
            }
        }
    }

    fn selection_text(&self) -> Option<String> {
        let mut formatter = Formatter::new_selection(&self.term).ok()??;
        formatter.set_format(Format::Plain).ok()?;
        formatter.set_unwrap(true).ok()?;
        formatter.set_trim(true).ok()?;
        let bytes = formatter.format_alloc(None).ok()?;
        let text = String::from_utf8_lossy(&bytes).into_owned();
        (!text.is_empty()).then_some(text)
    }

    fn hangup(&self) {
        let Some(pid) = self.pty.pid else {
            return;
        };
        if let Some(pgid) = self.pty.foreground_pgid()
            && pgid != pid
        {
            pty::signal(-pgid, libc::SIGHUP);
        }
        pty::signal(pid, libc::SIGHUP);
    }

    fn force_kill(&self) {
        if self.child_exit.is_none()
            && let Some(pid) = self.pty.pid
        {
            // The child is a session leader, so its pid names its group too.
            pty::signal(-pid, libc::SIGKILL);
            pty::signal(pid, libc::SIGKILL);
        }
    }

    fn start_graceful_kill(&mut self, now: Instant) {
        if self.child_exit.is_some() || self.shutdown_stage != ShutdownStage::None {
            return;
        }
        let Some(pid) = self.pty.pid else {
            return;
        };
        if let Some(pgid) = self.pty.foreground_pgid()
            && pgid != pid
        {
            pty::signal(-pgid, libc::SIGINT);
            self.shutdown_stage = ShutdownStage::Sigint {
                fg_pgid: pgid,
                deadline: now + SIGINT_GRACE,
            };
        } else {
            self.hangup();
            self.shutdown_stage = ShutdownStage::Sighup { deadline: now + SIGHUP_GRACE };
        }
    }

    fn advance_shutdown(&mut self, now: Instant) {
        if self.child_exit.is_some() {
            self.shutdown_stage = ShutdownStage::None;
            return;
        }
        match self.shutdown_stage {
            ShutdownStage::None => {}
            ShutdownStage::Sigint { fg_pgid, deadline } => {
                if self.pty.foreground_pgid() != Some(fg_pgid) || now >= deadline {
                    self.hangup();
                    self.shutdown_stage = ShutdownStage::Sighup { deadline: now + SIGHUP_GRACE };
                }
            }
            ShutdownStage::Sighup { deadline } => {
                if now >= deadline {
                    self.force_kill();
                    self.shutdown_stage = ShutdownStage::None;
                }
            }
        }
    }

    fn shutdown_step_deadline(&self, now: Instant) -> Option<Instant> {
        match self.shutdown_stage {
            ShutdownStage::None => None,
            ShutdownStage::Sigint { deadline, .. } => Some((now + FG_POLL_INTERVAL).min(deadline)),
            ShutdownStage::Sighup { deadline } => Some(deadline),
        }
    }

    fn finish(&mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        self.exit_deadline = None;
        self.shutdown_stage = ShutdownStage::None;
        self.shared.alive.store(false, Ordering::Release);
        *self.shared.master_fd.lock().unwrap() = None;
        self.pty.shutdown();
        self.publish();
        self.emit(TermEvent::Exited {
            code: self.child_exit.flatten(),
        });
    }

    fn on_timers(&mut self, now: Instant) {
        self.advance_shutdown(now);
        if self.exit_deadline.is_some_and(|at| now >= at) && self.child_exit.is_some() {
            self.finish();
        }
    }

    fn next_deadline(&self, now: Instant) -> Option<Instant> {
        let frame = self.dirty.then(|| {
            let at = self.last_publish + FRAME;
            match self.hold_since {
                Some(since) if self.held(now) => at.max(since + MAX_HOLD),
                _ => at,
            }
        });
        [frame, self.exit_deadline, self.shutdown_step_deadline(now)].into_iter().flatten().min()
    }

    /// Returns false when the session thread should stop.
    fn handle(&mut self, msg: Msg) -> bool {
        match msg {
            Msg::Pty(data) => {
                if !self.finished {
                    self.feed(&data);
                    if let Some(exited_at) = self.exited_at {
                        let now = Instant::now();
                        self.exit_deadline = Some((now + EXIT_DRAIN).min(exited_at + EXIT_DRAIN_MAX));
                    }
                }
                self.pty.budget.release(data.len());
            }
            Msg::PtyEof => {
                self.eof = true;
                if self.child_exit.is_some() {
                    self.finish();
                }
            }
            Msg::ChildExited(code) => {
                self.child_exit = Some(code);
                self.pty.release_slave();
                if self.eof {
                    self.finish();
                } else {
                    let now = Instant::now();
                    self.exited_at = Some(now);
                    self.exit_deadline = Some(now + EXIT_DRAIN);
                }
            }
            Msg::Key(key) => self.send_key(&key),
            Msg::Text(text) => {
                if self.writable() && !text.is_empty() {
                    self.follow_output();
                    self.pty.write(text.into_bytes());
                }
            }
            Msg::Paste(text) => self.paste(text),
            Msg::Mouse(mouse) => {
                let bytes = self.input.encode_mouse(&self.term, self.size.get(), mouse);
                if self.writable() {
                    self.pty.write(bytes);
                }
            }
            Msg::Resize(size) => self.resize(size),
            Msg::ScrollLines(delta) => self.scroll_lines(delta),
            Msg::ScrollToBottom => {
                self.term.scroll_viewport(ScrollViewport::Bottom);
                self.dirty = true;
            }
            Msg::SelectionStart(at, mode) => self.selection_start(at, mode),
            Msg::SelectionExtend(at) => self.selection_extend(at),
            Msg::SelectionClear => {
                self.anchor = Anchor::None;
                let _ = self.term.set_selection(None);
                self.dirty = true;
            }
            Msg::SelectionText(reply) => {
                let _ = reply.send(self.selection_text());
            }
            Msg::SetTheme(theme) => {
                let _ = apply_theme(&mut self.term, &theme);
                self.builder.invalidate();
                self.dirty = true;
            }
            Msg::ScrollbackText(max_lines, reply) => {
                let _ = reply.send(self.scrollback_text(max_lines));
            }
            Msg::CommandOutput(id, reply) => {
                let _ = reply.send(self.command_output(id));
            }
            Msg::OptionAsAlt(value) => self.input.option_as_alt = value,
            Msg::Kill => self.start_graceful_kill(Instant::now()),
            Msg::Shutdown => return false,
        }
        true
    }

    fn run(&mut self, rx: &mpsc::Receiver<Msg>) {
        loop {
            let now = Instant::now();
            self.on_timers(now);
            if self.dirty && !self.held(now) && now >= self.last_publish + FRAME {
                self.publish();
            }
            let msg = match rx.try_recv() {
                Ok(msg) => msg,
                Err(mpsc::TryRecvError::Disconnected) => return,
                Err(mpsc::TryRecvError::Empty) => {
                    let received = match self.next_deadline(now) {
                        Some(deadline) => rx.recv_timeout(deadline.saturating_duration_since(Instant::now())),
                        None => rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected),
                    };
                    match received {
                        Ok(msg) => msg,
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
            };
            if !self.handle(msg) {
                return;
            }
        }
    }

    /// Last handle dropped: run two-stage graceful shutdown (`SIGINT` to
    /// foreground job -> `SIGHUP` to shell -> `SIGKILL` fallback) so jobs and
    /// shells can flush state/history before teardown.
    fn shutdown(&mut self, rx: &mpsc::Receiver<Msg>) {
        if self.child_exit.is_none() {
            self.start_graceful_kill(Instant::now());
            while self.child_exit.is_none() && self.shutdown_stage != ShutdownStage::None {
                let now = Instant::now();
                self.advance_shutdown(now);
                let Some(deadline) = self.shutdown_step_deadline(now) else {
                    break;
                };
                match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(Msg::ChildExited(code)) => {
                        self.child_exit = Some(code);
                        break;
                    }
                    Ok(Msg::Pty(data)) => self.pty.budget.release(data.len()),
                    Ok(_) => {}
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            if self.child_exit.is_none() {
                self.force_kill();
                let reap_deadline = Instant::now() + REAP_GRACE;
                loop {
                    match rx.recv_timeout(reap_deadline.saturating_duration_since(Instant::now())) {
                        Ok(Msg::ChildExited(code)) => {
                            self.child_exit = Some(code);
                            break;
                        }
                        Ok(Msg::Pty(data)) => self.pty.budget.release(data.len()),
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
            }
        }
        self.shared.alive.store(false, Ordering::Release);
        *self.shared.master_fd.lock().unwrap() = None;
        self.pty.shutdown();
    }
}

pub(crate) fn run_with_history(
    opts: crate::SpawnOptions,
    history: &str,
    pty: Pty,
    shared: Arc<Shared>,
    rx: mpsc::Receiver<Msg>,
    on_event: Box<dyn Fn(TermEvent)>,
    ready: mpsc::SyncSender<Result<(), TermError>>,
) {
    let mut session = match Session::new(&opts, pty, shared, on_event) {
        Ok(session) => session,
        Err(e) => {
            let _ = ready.send(Err(backend(e)));
            return;
        }
    };
    if !history.is_empty() {
        let mut text = history.replace("\r\n", "\n").replace('\n', "\r\n");
        if !text.ends_with("\r\n") {
            text.push_str("\r\n");
        }
        session.feed(text.as_bytes());
    }
    let _ = ready.send(Ok(()));
    session.run(&rx);
    session.shutdown(&rx);
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use crate::{Rgb, SpawnOptions, TermEvent, TermSession, TermSize, Theme};

    fn test_theme() -> Theme {
        Theme {
            foreground: Rgb(220, 220, 220),
            background: Rgb(20, 20, 20),
            cursor: Rgb(255, 255, 255),
            selection: Rgb(60, 80, 120),
            ansi: [Rgb(0, 0, 0); 16],
        }
    }

    fn spawn_opts(program: &str, args: &[&str]) -> SpawnOptions {
        SpawnOptions {
            cwd: std::env::temp_dir(),
            program: Some(program.into()),
            args: args.iter().map(|s| (*s).into()).collect(),
            env: Vec::new(),
            size: TermSize {
                cols: 100,
                rows: 24,
                cell_width_px: 8,
                cell_height_px: 16,
            },
            scrollback_lines: 200,
            theme: test_theme(),
        }
    }

    fn screen_text(session: &TermSession) -> String {
        let snap = session.snapshot();
        snap.rows
            .iter()
            .map(|row| {
                let mut line = String::new();
                let mut col = 0;
                for run in &row.runs {
                    while col < run.start_col {
                        line.push(' ');
                        col += 1;
                    }
                    line.push_str(&run.text);
                    col += run.cols;
                }
                line
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn wait_for_screen(session: &TermSession, events: &mpsc::Receiver<TermEvent>, needle: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let text = screen_text(session);
            if text.contains(needle) {
                return;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() || events.recv_timeout(remaining).is_err() {
                panic!("timed out waiting for {needle:?}; screen:\n{}", screen_text(session));
            }
        }
    }

    #[test]
    fn graceful_shutdown_sends_sigint_to_foreground_job_then_sighup_to_shell() {
        let dir = tempfile::tempdir().unwrap();
        let fg_marker = dir.path().join("fg_sigint");
        let shell_marker = dir.path().join("shell_sighup");
        let (tx, rx) = mpsc::channel();
        let session = TermSession::spawn(spawn_opts("/bin/zsh", &["-f", "-i"]), move |ev| {
            let _ = tx.send(ev);
        })
        .unwrap();

        wait_for_screen(&session, &rx, "%");
        session.send_text(&format!(
            "trap 'touch {}; exit 0' HUP; /bin/sh -c 'trap \"touch {}; exit 0\" INT; printf \"FG_%s\\n\" READY; sleep 30'\n",
            shell_marker.display(),
            fg_marker.display()
        ));
        wait_for_screen(&session, &rx, "FG_READY");
        assert!(session.has_foreground_process(), "foreground child must own tty pgid");

        let start = Instant::now();
        session.shutdown_and_wait(Duration::from_secs(3));
        let elapsed = start.elapsed();

        assert!(!session.is_alive());
        assert!(fg_marker.exists(), "foreground job did not receive SIGINT");
        assert!(shell_marker.exists(), "shell did not receive SIGHUP");
        assert!(
            elapsed < Duration::from_millis(1200),
            "expected fast two-stage exit once fg returned, took {elapsed:?}"
        );
    }

    #[test]
    fn graceful_shutdown_falls_back_to_sigkill_when_foreground_ignores_sigint_and_sighup() {
        let (tx, rx) = mpsc::channel();
        let session = TermSession::spawn(spawn_opts("/bin/sh", &["-c", "trap '' INT HUP; echo STUCK_READY; sleep 30"]), move |ev| {
            let _ = tx.send(ev);
        })
        .unwrap();
        wait_for_screen(&session, &rx, "STUCK_READY");

        let start = Instant::now();
        session.shutdown_and_wait(Duration::from_secs(4));
        let elapsed = start.elapsed();

        assert!(!session.is_alive());
        assert!(
            elapsed >= Duration::from_millis(900),
            "should wait for SIGHUP grace before SIGKILL: {elapsed:?}"
        );
        assert!(elapsed < Duration::from_secs(3), "SIGKILL fallback took too long: {elapsed:?}");
    }

    #[test]
    fn graceful_shutdown_waits_sigint_grace_then_sighups_stubborn_foreground_job() {
        let dir = tempfile::tempdir().unwrap();
        let shell_marker = dir.path().join("shell_sighup");
        let (tx, rx) = mpsc::channel();
        let session = TermSession::spawn(spawn_opts("/bin/zsh", &["-f", "-i"]), move |ev| {
            let _ = tx.send(ev);
        })
        .unwrap();
        wait_for_screen(&session, &rx, "%");

        session.send_text(&format!(
            "trap 'touch {}; exit 0' HUP; /bin/sh -c 'trap \"\" INT; printf \"FG_%s\\n\" NOINT; sleep 30'\n",
            shell_marker.display()
        ));
        wait_for_screen(&session, &rx, "FG_NOINT");
        assert!(session.has_foreground_process(), "foreground child must own tty pgid");

        let start = Instant::now();
        session.shutdown_and_wait(Duration::from_secs(4));
        let elapsed = start.elapsed();

        assert!(!session.is_alive());
        assert!(shell_marker.exists(), "shell did not receive SIGHUP after SIGINT grace");
        assert!(
            elapsed >= Duration::from_millis(1400),
            "expected SIGINT grace before SIGHUP when fg ignores SIGINT: {elapsed:?}"
        );
        assert!(elapsed < Duration::from_secs(3), "expected SIGHUP exit well under 3s: {elapsed:?}");
    }
}
