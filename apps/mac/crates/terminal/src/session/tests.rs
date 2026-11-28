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

#[test]
fn mode_2026_synchronized_output_holds_snapshot_until_esu_or_timeout() {
    let (tx, rx) = mpsc::channel();
    let session = TermSession::spawn(
        spawn_opts(
            "/bin/sh",
            &[
                "-c",
                "printf 'BEFORE\\n'; sleep 0.05; printf '\\033[?2026hMID'; sleep 0.25; printf 'DONE\\033[?2026l\\n'; read x",
            ],
        ),
        move |ev| {
            let _ = tx.send(ev);
        },
    )
    .unwrap();

    wait_for_screen(&session, &rx, "BEFORE");
    // Wait for the final synchronized frame; the intermediate partial "MID" without "DONE" must not appear.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let text = screen_text(&session);
        if text.contains("MIDDONE") {
            break;
        }
        assert!(!text.contains("MID"), "Mode 2026 published partial frame before ESU: {text:?}");
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() || rx.recv_timeout(remaining).is_err() {
            panic!("timed out waiting for MIDDONE; screen:\n{text}");
        }
    }
    session.shutdown_and_wait(Duration::from_secs(2));
}
