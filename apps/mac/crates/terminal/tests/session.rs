//! End-to-end tests: real programs run through a real PTY, assertions are on
//! published snapshots and events.

#![allow(clippy::disallowed_methods, reason = "synchronous PTY integration test harness without Tokio runtime")]

use std::path::PathBuf;
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use vibevalley_terminal::{
    Key, KeyInput, Mods, MouseButton, MouseInput, MouseKind, Point, Rgb, SelectionMode, Snapshot, SpawnOptions, TermEvent, TermSession, TermSize, Theme,
};

const TIMEOUT: Duration = Duration::from_secs(20);

fn theme() -> Theme {
    Theme {
        foreground: Rgb(200, 200, 200),
        background: Rgb(10, 10, 10),
        cursor: Rgb(255, 255, 255),
        selection: Rgb(50, 80, 120),
        ansi: std::array::from_fn(|i| Rgb(i as u8 + 1, 100, 100)),
    }
}

fn size(cols: u16, rows: u16) -> TermSize {
    TermSize {
        cols,
        rows,
        cell_width_px: 8,
        cell_height_px: 16,
    }
}

struct Harness {
    session: TermSession,
    events: mpsc::Receiver<TermEvent>,
}

fn options(program: &str, args: &[&str], size: TermSize) -> SpawnOptions {
    SpawnOptions {
        cwd: std::env::temp_dir(),
        program: Some(program.to_string()),
        args: args.iter().map(|s| s.to_string()).collect(),
        env: vec![("PS1".into(), "$ ".into()), ("ENV".into(), String::new())],
        size,
        scrollback_lines: 5000,
        theme: theme(),
    }
}

fn spawn(opts: SpawnOptions) -> Harness {
    let (tx, events) = mpsc::channel();
    let session = TermSession::spawn(opts, move |event| {
        let _ = tx.send(event);
    })
    .expect("spawn session");
    Harness { session, events }
}

/// Runs `script` with `/bin/sh -c` in a 40x10 terminal.
fn sh(script: &str) -> Harness {
    spawn(options("/bin/sh", &["-c", script], size(40, 10)))
}

fn row_text(snapshot: &Snapshot, row: usize) -> String {
    let mut line = String::new();
    let mut col = 0;
    for run in &snapshot.rows[row].runs {
        while col < run.start_col {
            line.push(' ');
            col += 1;
        }
        line.push_str(&run.text);
        col += run.cols;
    }
    line
}

fn screen_text(snapshot: &Snapshot) -> String {
    (0..snapshot.rows.len()).map(|row| row_text(snapshot, row)).collect::<Vec<_>>().join("\n")
}

impl Harness {
    fn wait_for(&self, what: &str, pred: impl Fn(&Snapshot) -> bool) -> Arc<Snapshot> {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let snapshot = self.session.snapshot();
            if pred(&snapshot) {
                return snapshot;
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}; screen:\n{}", screen_text(&snapshot));
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn wait_text(&self, needle: &str) -> Arc<Snapshot> {
        self.wait_for(needle, |s| screen_text(s).contains(needle))
    }

    fn wait_event<T>(&self, what: &str, mut pick: impl FnMut(TermEvent) -> Option<T>) -> T {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.events.recv_timeout(left) {
                Ok(event) => {
                    if let Some(found) = pick(event) {
                        return found;
                    }
                }
                Err(_) => panic!("timed out waiting for event: {what}"),
            }
        }
    }

    fn wait_exit(&self) -> Option<i32> {
        self.wait_event("exit", |event| match event {
            TermEvent::Exited { code } => Some(code),
            _ => None,
        })
    }

    fn key(&self, key: Key, mods: Mods) {
        self.session.send_key(KeyInput { key, mods, text: None });
    }
}

fn ctrl() -> Mods {
    Mods { ctrl: true, ..Mods::default() }
}

#[test]
fn plain_text_and_cursor() {
    let h = sh("printf 'hello\\nab'");
    assert_eq!(h.wait_exit(), Some(0));
    let s = h.session.snapshot();
    assert_eq!(s.rows.len(), 10);
    assert_eq!(row_text(&s, 0), "hello");
    assert_eq!(row_text(&s, 1), "ab");
    assert_eq!(row_text(&s, 2), "");
    assert_eq!((s.cursor.row, s.cursor.col), (1, 2));
    assert!(s.cursor.visible);
    assert!(!s.alt_screen);
    assert!(!s.mouse_reporting);
    assert_eq!(s.size, size(40, 10));
    assert!(s.seq > 0);
    assert!(!h.session.is_alive());
}

#[test]
fn colors_and_attributes() {
    let h = sh(concat!(
        "printf '\\033[1;31mR\\033[0m\\033[4;38;2;1;2;3mT\\033[0m\\033[7mI\\033[0m",
        "\\033[44m \\033[0m\\033[2;3;9mD\\033[0m\\033[38;5;196mP\\033[0mn'"
    ));
    h.wait_exit();
    let s = h.session.snapshot();
    let t = theme();
    let runs = &s.rows[0].runs;
    assert_eq!(row_text(&s, 0), "RTI DPn");
    assert_eq!(runs.len(), 7);

    assert_eq!(runs[0].text, "R");
    assert_eq!(runs[0].style.fg, t.ansi[1]);
    assert!(runs[0].style.bold);
    assert_eq!(runs[0].style.bg, None);

    assert_eq!(runs[1].style.fg, Rgb(1, 2, 3));
    assert!(runs[1].style.underline && !runs[1].style.bold);

    assert_eq!(runs[2].style.fg, t.background);
    assert_eq!(runs[2].style.bg, Some(t.foreground));

    assert_eq!(runs[3].text, " ");
    assert_eq!(runs[3].style.bg, Some(t.ansi[4]));

    assert!(runs[4].style.dim && runs[4].style.italic && runs[4].style.strikethrough);

    // Index 196 of the standard 256-color cube is pure red.
    assert_eq!(runs[5].style.fg, Rgb(255, 0, 0));

    assert_eq!(runs[6].style.fg, t.foreground);
    assert_eq!(runs[6].style.bg, None);
    assert_eq!((runs[6].start_col, runs[6].cols), (6, 1));
}

#[test]
fn wide_characters_take_two_columns() {
    let h = sh("printf '中文😀a\\n\\033[31me\\314\\201x'");
    h.wait_exit();
    let s = h.session.snapshot();
    let run = &s.rows[0].runs[0];
    assert_eq!(run.text, "中文😀a");
    assert_eq!((run.start_col, run.cols), (0, 7));
    // A combining accent stays in its base character's cell.
    let run = &s.rows[1].runs[0];
    assert_eq!(run.text, "e\u{301}x");
    assert_eq!(run.cols, 2);
    assert_eq!((s.cursor.row, s.cursor.col), (1, 2));
}

#[test]
fn alternate_screen() {
    let h = sh("printf 'main\\033[?1049h\\033[Halt'; read x; printf '\\033[?1049l'; read y");
    let s = h.wait_for("alt screen", |s| s.alt_screen && row_text(s, 0) == "alt");
    assert_eq!(s.scrollback_len, 0);
    h.session.send_text("\n");
    let s = h.wait_for("primary screen", |s| !s.alt_screen);
    assert_eq!(row_text(&s, 0), "main");
    h.session.send_text("\n");
    assert_eq!(h.wait_exit(), Some(0));
}

#[test]
fn resize_reflows_and_reaches_the_program() {
    let h = sh("printf 'abcdefghijklmnopqrstuvwxyz0123'; read x; stty size");
    let s = h.wait_text("0123");
    assert_eq!(row_text(&s, 0), "abcdefghijklmnopqrstuvwxyz0123");
    assert!(!s.rows[0].wrapped);

    h.session.resize(size(20, 8));
    let s = h.wait_for("reflow", |s| s.size.cols == 20 && s.rows.len() == 8);
    assert_eq!(row_text(&s, 0), "abcdefghijklmnopqrst");
    assert!(s.rows[0].wrapped);
    assert_eq!(row_text(&s, 1), "uvwxyz0123");
    assert!(!s.rows[1].wrapped);

    h.session.send_text("\n");
    h.wait_text("8 20");
    h.wait_exit();
}

#[test]
fn scrollback_scrolling_and_text() {
    let h = sh("i=1; while [ $i -le 100 ]; do echo line$i; i=$((i+1)); done; read x");
    let s = h.wait_text("line100");
    assert_eq!(s.scroll_offset, 0);
    assert_eq!(s.scrollback_len, 91);
    assert_eq!(row_text(&s, 8), "line100");

    h.session.scroll_lines(10);
    let s = h.wait_for("scrolled up", |s| s.scroll_offset == 10);
    assert_eq!(row_text(&s, 0), "line82");
    assert_eq!(row_text(&s, 9), "line91");

    h.session.scroll_lines(-4);
    let s = h.wait_for("scrolled down", |s| s.scroll_offset == 6);
    assert_eq!(row_text(&s, 0), "line86");

    h.session.scroll_lines(1000);
    let s = h.wait_for("top", |s| s.scroll_offset == 91);
    assert_eq!(row_text(&s, 0), "line1");

    h.session.scroll_to_bottom();
    let s = h.wait_for("bottom", |s| s.scroll_offset == 0);
    assert_eq!(row_text(&s, 8), "line100");

    let tail = h.session.scrollback_text(4);
    assert_eq!(tail.trim_end(), "line98\nline99\nline100");
    let all = h.session.scrollback_text(usize::MAX);
    assert!(all.starts_with("line1\nline2\n"));

    // Typing while scrolled back returns to the live output.
    h.session.scroll_lines(5);
    h.wait_for("scrolled", |s| s.scroll_offset == 5);
    h.session.send_text("\n");
    h.wait_exit();
    assert_eq!(h.session.snapshot().scroll_offset, 0);
}

#[test]
fn selection_modes_and_text() {
    let h = sh("printf 'hello world foo\\nsecond line'; read x");
    h.wait_text("second line");
    let at = |row, col| Point { row, col };

    h.session.selection_start(at(0, 0), SelectionMode::Cell);
    h.session.selection_extend(at(0, 4));
    assert_eq!(h.session.selection_text().as_deref(), Some("hello"));
    let s = h.wait_for("selection", |s| s.selection.is_some());
    assert_eq!(s.selection, Some((at(0, 0), at(0, 4))));

    // Dragging backwards across lines still yields a normalized range.
    h.session.selection_start(at(1, 5), SelectionMode::Cell);
    h.session.selection_extend(at(0, 12));
    assert_eq!(h.session.selection_text().as_deref(), Some("foo\nsecond"));
    let s = h.wait_for("selection", |s| s.selection == Some((at(0, 12), at(1, 5))));
    assert!(s.selection.is_some());

    h.session.selection_start(at(0, 7), SelectionMode::Word);
    assert_eq!(h.session.selection_text().as_deref(), Some("world"));
    h.session.selection_extend(at(0, 13));
    assert_eq!(h.session.selection_text().as_deref(), Some("world foo"));
    h.session.selection_extend(at(0, 1));
    assert_eq!(h.session.selection_text().as_deref(), Some("hello world"));

    h.session.selection_start(at(0, 3), SelectionMode::Line);
    assert_eq!(h.session.selection_text().as_deref(), Some("hello world foo"));
    h.session.selection_extend(at(1, 0));
    assert_eq!(h.session.selection_text().as_deref(), Some("hello world foo\nsecond line"));

    h.session.selection_clear();
    assert_eq!(h.session.selection_text(), None);
    h.wait_for("no selection", |s| s.selection.is_none());
}

#[test]
fn exit_code_is_reported() {
    let h = sh("exit 7");
    assert_eq!(h.wait_exit(), Some(7));
    assert!(!h.session.is_alive());
    assert!(!h.session.has_foreground_process());
    // A dead session still answers queries and ignores input.
    h.session.send_text("ignored");
    assert_eq!(h.session.selection_text(), None);
}

#[test]
fn bracketed_paste() {
    let h = sh("stty raw -echo; printf '\\033[?2004hREADY'; cat -v");
    h.wait_text("READY");
    h.session.paste("one\ntwo");
    h.wait_text("^[[200~one");
    let s = h.wait_text("two^[[201~");
    assert!(!screen_text(&s).contains("^M"));
    h.session.kill();
    h.wait_exit();
}

#[test]
fn plain_paste_turns_newlines_into_returns() {
    let h = sh("stty raw -echo; printf READY; cat -v");
    h.wait_text("READY");
    h.session.paste("one\ntwo");
    let s = h.wait_text("one^Mtwo");
    assert!(!screen_text(&s).contains("200~"));
    h.session.kill();
    h.wait_exit();
}

#[test]
fn key_encodings() {
    // Wide enough that the echoed sequences never wrap mid-match; the C
    // locale makes `cat -v` escape every non-ASCII byte.
    let h = spawn(options(
        "/bin/sh",
        &["-c", "export LC_ALL=C; stty raw -echo; printf READY; cat -v"],
        size(200, 10),
    ));
    h.wait_text("READY");
    let none = Mods::default();

    h.key(Key::Up, none);
    h.wait_text("READY^[[A");
    h.key(Key::Char("a".into()), none);
    h.key(Key::Char("a".into()), Mods { shift: true, ..none });
    h.wait_text("^[[AaA");
    h.key(Key::Char("c".into()), ctrl());
    h.wait_text("aA^C");
    h.key(Key::Char("b".into()), Mods { alt: true, ..none });
    h.wait_text("^C^[b");
    h.key(Key::Enter, none);
    h.key(Key::Backspace, none);
    h.key(Key::Escape, none);
    h.wait_text("^[b^M^?^[");
    // `cat -v` passes a tab through, which moves the cursor to column 24.
    h.key(Key::Tab, none);
    h.key(Key::Char("z".into()), none);
    let s = h.wait_text("z");
    assert_eq!(s.rows[0].runs.last().unwrap().text.chars().last(), Some('z'));
    assert_eq!(s.cursor.col, 25);
    h.key(Key::F(5), none);
    h.wait_text("^[[15~");
    h.key(Key::Right, ctrl());
    h.wait_text("^[[1;5C");
    h.key(Key::Delete, none);
    h.wait_text("^[[3~");
    h.session.send_key(KeyInput {
        key: Key::Char("é".into()),
        mods: none,
        text: Some("é".into()),
    });
    h.session.send_text("中");
    h.wait_text("M-CM-)M-dM-8M--");

    h.session.kill();
    h.wait_exit();
}

#[test]
fn application_cursor_keys() {
    let h = sh("stty raw -echo; printf '\\033[?1hREADY'; cat -v");
    h.wait_text("READY");
    h.key(Key::Up, Mods::default());
    h.key(Key::Home, Mods::default());
    h.wait_text("READY^[OA^[OH");
    h.session.kill();
    h.wait_exit();
}

#[test]
fn kitty_keyboard_protocol() {
    let h = sh("stty raw -echo; printf '\\033[>1uREADY'; cat -v");
    h.wait_text("READY");
    h.key(Key::Escape, Mods::default());
    h.key(Key::Char("c".into()), ctrl());
    h.wait_text("READY^[[27u^[[99;5u");
    h.session.kill();
    h.wait_exit();
}

#[test]
fn mouse_reporting() {
    let h = sh("stty raw -echo; printf '\\033[?1000h\\033[?1006hREADY'; cat -v");
    let _s = h.wait_for("mouse mode and READY", |s| s.mouse_reporting && screen_text(s).contains("READY"));
    let at = Point { row: 2, col: 3 };
    let mods = Mods::default();
    h.session.send_mouse(MouseInput {
        kind: MouseKind::Press(MouseButton::Left),
        at,
        mods,
    });
    h.session.send_mouse(MouseInput {
        kind: MouseKind::Release(MouseButton::Left),
        at,
        mods,
    });
    h.session.send_mouse(MouseInput {
        kind: MouseKind::Wheel { lines: 1 },
        at,
        mods,
    });
    h.wait_text("^[[<0;4;3M^[[<0;4;3m^[[<64;4;3M");
    h.session.kill();
    h.wait_exit();
}

#[test]
fn mouse_is_not_forwarded_without_reporting() {
    let h = sh("stty raw -echo; printf READY; cat -v");
    h.wait_text("READY");
    h.session.send_mouse(MouseInput {
        kind: MouseKind::Press(MouseButton::Left),
        at: Point { row: 1, col: 1 },
        mods: Mods::default(),
    });
    h.session.send_text("x");
    let s = h.wait_text("READYx");
    assert!(!screen_text(&s).contains("^["));
    h.session.kill();
    h.wait_exit();
}

#[test]
fn scrolling_the_alternate_screen_sends_cursor_keys() {
    let h = sh("stty raw -echo; printf '\\033[?1049hREADY'; cat -v");
    h.wait_text("READY");
    h.session.scroll_lines(2);
    h.session.scroll_lines(-1);
    h.wait_text("READY^[[A^[[A^[[B");
    h.session.kill();
    h.wait_exit();
}

#[test]
fn title_bell_and_cwd_events() {
    let h = sh("printf '\\033]2;my title\\007\\a\\033]7;file://localhost/tmp/a%%20b\\007'");
    let mut title = None;
    let mut bell = false;
    let mut cwd = None;
    h.wait_event("exit", |event| {
        match event {
            TermEvent::TitleChanged(t) => title = Some(t),
            TermEvent::Bell => bell = true,
            TermEvent::CwdChanged(p) => cwd = Some(p),
            TermEvent::Exited { .. } => return Some(()),
            _ => {}
        }
        None
    });
    assert_eq!(title.as_deref(), Some("my title"));
    assert!(bell);
    assert_eq!(cwd, Some(PathBuf::from("/tmp/a b")));
    assert_eq!(h.session.cwd(), Some(PathBuf::from("/tmp/a b")));
    assert_eq!(h.session.snapshot().title.as_deref(), Some("my title"));
}

#[test]
fn command_blocks_from_osc_133() {
    let h = sh(concat!(
        "printf '\\033]133;A\\007$ \\033]133;B\\007echo hi\\n\\033]133;C\\007hi\\nthere\\n",
        "\\033]133;D;3\\007\\033]133;A\\007$ \\033]133;B\\007true\\n",
        "\\033]133;C;cmdline_url=true%%20--now\\007\\033]133;D;0\\007\\033]133;A\\007$ '; read x"
    ));
    let mut started = Vec::new();
    let mut finished = Vec::new();
    while finished.len() < 2 {
        h.wait_event("command events", |event| match event {
            TermEvent::CommandStarted(block) => {
                started.push(block);
                Some(())
            }
            TermEvent::CommandFinished(block) => {
                finished.push(block);
                Some(())
            }
            _ => None,
        });
    }
    assert_eq!(started.len(), 2);
    assert_eq!(started[0].command, "echo hi");
    assert_eq!(started[0].exit_code, None);
    assert_eq!(finished[0].id, started[0].id);
    assert_eq!(finished[0].command, "echo hi");
    assert_eq!(finished[0].exit_code, Some(3));
    assert!(finished[0].duration_ms.is_some());
    assert_eq!(h.session.command_output(started[0].id).as_deref(), Some("hi\nthere"));

    assert_ne!(started[1].id, started[0].id);
    assert_eq!(started[1].command, "true --now");
    assert_eq!(finished[1].exit_code, Some(0));
    assert_eq!(h.session.command_output(started[1].id).as_deref(), Some(""));
    assert_eq!(h.session.command_output(9999), None);

    h.session.send_text("\n");
    h.wait_exit();
}

#[test]
fn hyperlinks() {
    let h = sh("printf '\\033]8;;https://example.com\\033\\\\link\\033]8;;\\033\\\\ plain'");
    h.wait_exit();
    let s = h.session.snapshot();
    let runs = &s.rows[0].runs;
    assert_eq!(runs[0].text, "link");
    assert_eq!(runs[0].hyperlink.as_deref(), Some("https://example.com"));
    assert_eq!(runs[1].text, " plain");
    assert_eq!(runs[1].hyperlink, None);
}

#[test]
fn theme_change_recolors_existing_text() {
    let h = sh("printf '\\033[31mred\\033[0m plain'; read x");
    let s = h.wait_text("plain");
    assert_eq!(s.rows[0].runs[0].style.fg, theme().ansi[1]);

    let mut next = theme();
    next.ansi[1] = Rgb(250, 1, 2);
    next.foreground = Rgb(9, 9, 9);
    h.session.set_theme(next);
    let s = h.wait_for("recolor", |s| s.rows[0].runs[0].style.fg == Rgb(250, 1, 2));
    assert_eq!(s.rows[0].runs[1].style.fg, Rgb(9, 9, 9));
    h.session.send_text("\n");
    h.wait_exit();
}

#[test]
fn unchanged_rows_are_shared_between_snapshots() {
    let h = sh("printf 'top\\n'; read x; printf 'bottom'; read y");
    let first = h.wait_text("top");
    h.session.send_text("\n");
    let second = h.wait_text("bottom");
    assert!(second.seq > first.seq);
    assert!(Arc::ptr_eq(&first.rows[0], &second.rows[0]));
    assert!(Arc::ptr_eq(&first.rows[9], &second.rows[9]));
    h.session.send_text("\n");
    h.wait_exit();
}

#[test]
fn flood_stays_responsive_and_coalesces_dirty() {
    // ~21 MB of output.
    let h = sh(concat!(
        "yes 'the quick brown fox jumps over the lazy dog 0123456789 abcdefghij' ",
        "| head -n 300000; echo FLOOD-DONE"
    ));
    let started = Instant::now();
    let mut slowest = Duration::ZERO;
    let mut round_trips = 0;
    let code = loop {
        // A blocking round trip measures how long input waits behind output.
        let t = Instant::now();
        let _ = h.session.selection_text();
        slowest = slowest.max(t.elapsed());
        round_trips += 1;
        let mut exit = None;
        let mut dirty = 0;
        for event in h.events.try_iter() {
            match event {
                TermEvent::Dirty => dirty += 1,
                TermEvent::Exited { code } => exit = Some(code),
                _ => {}
            }
        }
        // `snapshot()` is never called during the flood, so at most one
        // `Dirty` may ever be outstanding.
        assert!(dirty <= 1, "{dirty} Dirty events queued");
        if let Some(code) = exit {
            break code;
        }
        assert!(started.elapsed() < Duration::from_secs(60), "flood stalled");
        std::thread::sleep(Duration::from_millis(2));
    };
    assert_eq!(code, Some(0));
    assert!(round_trips > 3);
    assert!(slowest < Duration::from_millis(250), "round trip took {slowest:?}");
    let s = h.session.snapshot();
    assert!(screen_text(&s).contains("FLOOD-DONE"));
    // Retained scrollback count sits near the 5000-line limit.
    assert!((4000..6000).contains(&s.scrollback_len), "{}", s.scrollback_len);
    eprintln!(
        "flood: {:?}, {round_trips} round trips, slowest {slowest:?}, final seq {}",
        started.elapsed(),
        s.seq
    );
}

#[test]
fn foreground_process_cwd_fallback_and_kill() {
    let dir = std::env::temp_dir().canonicalize().unwrap();
    let mut opts = options("/bin/sh", &[], size(60, 10));
    opts.cwd = dir.clone();
    let h = spawn(opts);
    h.wait_text("$");
    assert!(h.session.is_alive());
    assert!(!h.session.has_foreground_process());
    assert_eq!(h.session.cwd(), Some(dir));

    h.session.send_text("sleep 600\n");
    let deadline = Instant::now() + TIMEOUT;
    while !h.session.has_foreground_process() {
        assert!(Instant::now() < deadline, "sleep never took the foreground");
        std::thread::sleep(Duration::from_millis(5));
    }

    h.session.kill();
    h.wait_exit();
    assert!(!h.session.is_alive());
    assert!(!h.session.has_foreground_process());
}

#[test]
fn default_program_is_the_login_shell() {
    let mut opts = options("", &[], size(80, 24));
    opts.program = None;
    opts.env.clear();
    let h = spawn(opts);
    assert!(h.session.is_alive());
    h.session.send_text(" exit 4\n");
    assert_eq!(h.wait_exit(), Some(4));
}

#[test]
fn spawn_failure_is_an_error() {
    let (tx, _rx) = mpsc::channel();
    let result = TermSession::spawn(options("/nonexistent/program", &[], size(80, 24)), move |event| {
        let _ = tx.send(event);
    });
    assert!(matches!(result, Err(vibevalley_terminal::TermError::Spawn(_))));
}

#[test]
fn dropping_the_last_handle_stops_the_session() {
    let alive = Arc::new(());
    let witness = alive.clone();
    let session = TermSession::spawn(options("/bin/sh", &["-c", "trap '' HUP; sleep 600"], size(80, 24)), move |_event| {
        let _ = &witness;
    })
    .unwrap();
    let clone = session.clone();
    drop(session);
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(Arc::strong_count(&alive), 2, "a handle is still alive");
    assert!(clone.is_alive());
    drop(clone);

    // The session thread owns the callback; it is dropped when the thread ends.
    let deadline = Instant::now() + TIMEOUT;
    while Arc::strong_count(&alive) > 1 {
        assert!(Instant::now() < deadline, "session thread did not stop");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn kill_takes_the_shells_children_with_it() {
    // A background child in the shell's own process group, which is what a
    // job started from an interactive shell looks like.
    // It ignores SIGHUP, so only a signal to the whole group can stop it.
    let h = sh("trap '' HUP; sleep 600 & echo CHILD=$! END; wait");
    let s = h.wait_text("END");
    let text = screen_text(&s);
    let pid: i32 = text
        .split("CHILD=")
        .nth(1)
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|n| n.parse().ok())
        .expect("child pid on screen");
    h.session.kill();
    h.wait_exit();
    let deadline = Instant::now() + TIMEOUT;
    while unsafe { libc::kill(pid, 0) } == 0 {
        assert!(Instant::now() < deadline, "child {pid} survived kill()");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn history_shows_above_the_new_prompt() {
    let (tx, events) = mpsc::channel();
    let session = TermSession::spawn_with_history(
        options("/bin/sh", &["-c", "printf NEW-OUTPUT; sleep 5"], size(40, 10)),
        "old line one\nold line two",
        move |e| {
            let _ = tx.send(e);
        },
    )
    .unwrap();
    let h = Harness { session, events };
    let s = h.wait_text("NEW-OUTPUT");
    let text = screen_text(&s);
    let old = text.find("old line two").expect("history on screen");
    assert!(text.find("NEW-OUTPUT").unwrap() > old, "{text}");
    assert_eq!(row_text(&s, 0).trim_end(), "old line one");
    h.session.kill();
    h.wait_exit();
}

#[test]
fn alternate_scroll_is_reported_on_the_alternate_screen_only() {
    let h = sh("printf 'MAIN'; read x; printf '\\033[?1049hALT'; read y");
    let s = h.wait_text("MAIN");
    assert!(!s.alternate_scroll);
    h.session.send_text("\n");
    let s = h.wait_for("alt screen", |s| s.alt_screen);
    assert!(s.alternate_scroll, "alt screen without mouse reporting scrolls with arrow keys");
    h.session.send_text("\n");
    assert_eq!(h.wait_exit(), Some(0));
}

#[test]
fn regression_local_cwd_tracks_cd_after_an_old_osc_directory() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let nested = root.join("nested");
    std::fs::create_dir(&nested).unwrap();
    let mut opts = options("/bin/sh", &[], size(80, 10));
    opts.cwd = root.clone();
    let h = spawn(opts);
    h.session.send_text(&format!(
        "printf '\\033]7;file://localhost{}\\007'; cd nested; printf '\\033]0;cwd-observed\\007'\n",
        root.display()
    ));
    h.wait_event("shell changed directory", |event| {
        matches!(event,TermEvent::TitleChanged(ref title) if title=="cwd-observed").then_some(())
    });
    assert_eq!(h.session.cwd(), Some(root));
    assert_eq!(h.session.local_cwd(), Some(nested));
}

#[test]
fn link_hit_testing_works_on_live_pty_snapshots() {
    use vibevalley_terminal::{LinkResolveContext, LinkTarget, link_at};

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let src = root.join("src");
    std::fs::create_dir(&src).unwrap();
    let file = src.join("demo.rs");
    std::fs::write(&file, "fn main() {}\n").unwrap();

    let mut opts = options(
        "/bin/sh",
        &[
            "-c",
            "printf '\\033]8;;https://example.com/osc\\033\\\\docs\\033]8;;\\033\\\\ src/demo.rs:9:2\\nsrc/missing.rs\\nhttps://vibevalley.dev/very/long/wrapped/path'",
        ],
        size(30, 6),
    );
    opts.cwd = root.clone();
    let h = spawn(opts);
    assert_eq!(h.wait_exit(), Some(0));
    let snap = h.session.snapshot();
    let ctx = LinkResolveContext::new(Some(root), None);

    let osc = link_at(&snap, Point { row: 0, col: 1 }, &ctx).expect("osc8 link");
    assert_eq!(osc.target, LinkTarget::Url("https://example.com/osc".into()));

    let local = link_at(&snap, Point { row: 0, col: 8 }, &ctx).expect("existing relative file");
    assert_eq!(
        local.target,
        LinkTarget::File {
            path: file,
            line: Some(9),
            col: Some(2),
        }
    );

    // Non-existent relative file on row 1 is rejected.
    assert_eq!(row_text(&snap, 1), "src/missing.rs");
    assert_eq!(link_at(&snap, Point { row: 1, col: 4 }, &ctx), None);

    // Wrapped URL spans row 2 and row 3 in the 30-column viewport.
    let wrapped = link_at(&snap, Point { row: 3, col: 2 }, &ctx).expect("wrapped url hit");
    assert_eq!(wrapped.target, LinkTarget::Url("https://vibevalley.dev/very/long/wrapped/path".into()));
    assert_eq!(wrapped.spans.len(), 2);
}
