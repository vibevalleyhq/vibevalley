//! Runs a command in a terminal session and prints the final viewport as
//! plain text.
//!
//! `cargo run -p vibevalley-terminal --example dump -- ls -la`

use std::path::PathBuf;
use std::time::Duration;

use vibevalley_terminal::{Rgb, SpawnOptions, TermEvent, TermSession, TermSize, Theme};

fn main() {
    let mut args = std::env::args().skip(1);
    let program = args.next().unwrap_or_else(|| "/bin/sh".to_string());
    let mut args: Vec<String> = args.collect();
    if program == "/bin/sh" && args.is_empty() {
        args = vec!["-c".into(), "echo hello from vibevalley-terminal".into()];
    }

    let gray = |v: u8| Rgb(v, v, v);
    let (tx, rx) = flume::unbounded();
    let session = TermSession::spawn(
        SpawnOptions {
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")),
            program: Some(program),
            args,
            env: Vec::new(),
            size: TermSize {
                cols: 100,
                rows: 30,
                cell_width_px: 8,
                cell_height_px: 16,
            },
            scrollback_lines: 10_000,
            theme: Theme {
                foreground: gray(0xdd),
                background: gray(0x11),
                cursor: gray(0xff),
                selection: Rgb(0x33, 0x55, 0x88),
                ansi: std::array::from_fn(|i| gray(i as u8 * 16)),
            },
        },
        move |event| {
            let _ = tx.send(event);
        },
    )
    .expect("spawn session");

    let mut code = None;
    while let Ok(event) = rx.recv_timeout(Duration::from_secs(30)) {
        match event {
            TermEvent::Exited { code: c } => {
                code = c;
                break;
            }
            TermEvent::Dirty => {}
            other => eprintln!("[event] {other:?}"),
        }
    }

    let snapshot = session.snapshot();
    for row in &snapshot.rows {
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
        println!("{}", line.trim_end());
    }
    eprintln!(
        "[exit code {code:?}; seq {}; {} scrollback lines; cursor {},{}]",
        snapshot.seq, snapshot.scrollback_len, snapshot.cursor.row, snapshot.cursor.col
    );
}
