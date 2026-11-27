use std::path::PathBuf;
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use vibevalley_i18n::t;
use vibevalley_protocol::{BoardSlice, IssueStageKind};

#[derive(Debug, Serialize, PartialEq)]
pub struct Row {
    issue: String,
    number: i64,
    title: String,
    doing: String,
    tone: &'static str,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Glance {
    working: usize,
    waiting: usize,
    strip: Strip,
    rows: Vec<Row>,
}

#[derive(Debug, Serialize, PartialEq)]
struct Strip {
    working: String,
    waiting: String,
}

pub fn glance(board: &BoardSlice) -> Glance {
    let mut rows: Vec<Row> = board
        .issues
        .iter()
        .filter_map(|issue| {
            let tone = match issue.stage.state {
                IssueStageKind::Working => "working",
                IssueStageKind::Asking | IssueStageKind::Reviewing => "waiting",
                IssueStageKind::Stuck => "stuck",
                IssueStageKind::Draft | IssueStageKind::Queued | IssueStageKind::Done | IssueStageKind::Canceled => return None,
            };
            Some(Row {
                issue: issue.id.clone(),
                number: issue.number,
                title: issue.title.clone(),
                doing: t(&format!("shared.stage.{}", issue.stage.state.as_str()), &[]),
                tone,
            })
        })
        .collect();
    let working = rows.iter().filter(|r| r.tone == "working").count();
    let waiting = rows.len() - working;
    rows.sort_by_key(|r| (r.tone == "working", r.number));
    rows.truncate(12);
    Glance {
        working,
        waiting,
        strip: Strip {
            working: t("desktop.working", &[("n", working.into())]),
            waiting: t("desktop.waiting", &[("n", waiting.into())]),
        },
        rows,
    }
}

async fn write_frames(mut stdin: impl AsyncWrite + Unpin, mut rx: watch::Receiver<Option<String>>, cancel: CancellationToken) {
    loop {
        let changed = tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            res = rx.changed() => res,
        };
        if changed.is_err() {
            break;
        }
        let Some(frame) = rx.borrow_and_update().clone() else {
            continue;
        };
        if stdin.write_all(frame.as_bytes()).await.is_err() || stdin.write_all(b"\n").await.is_err() || stdin.flush().await.is_err() {
            break;
        }
    }
}

async fn read_clicks(stdout: impl AsyncRead + Unpin, clicks: tokio::sync::mpsc::Sender<String>, cancel: CancellationToken) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        let line = tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            res = lines.next_line() => match res {
                Ok(Some(line)) => line,
                Ok(None) | Err(_) => break,
            },
        };
        if let Some(issue) = opened_issue(&line) {
            let _ = clicks.try_send(issue);
        }
    }
}

pub struct Island {
    child: Option<Child>,
    frames: watch::Sender<Option<String>>,
    cancel: CancellationToken,
}

impl Island {
    pub fn start() -> Result<Option<(Self, tokio::sync::mpsc::Receiver<String>)>, String> {
        if std::env::var_os("VIBEVALLEY_NO_ISLAND").is_some() {
            return Ok(None);
        }
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let candidates = [
            std::env::var_os("VIBEVALLEY_ISLAND").map(PathBuf::from),
            exe.parent().map(|p| p.join("VibeValleyIsland")),
            Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../island/.build/release/VibeValleyIsland")),
        ];
        let Some(binary) = candidates.into_iter().flatten().find(|p| p.is_file()) else {
            return Ok(None);
        };
        let handle = vibevalley_rt::current_or_global_handle();
        let mut child = {
            let _guard = handle.enter();
            Command::new(binary)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .map_err(|e| e.to_string())?
        };
        let stdin = child.stdin.take().ok_or("island stdin was not piped")?;
        let stdout = child.stdout.take().ok_or("island stdout was not piped")?;
        let (frames, incoming) = watch::channel(None::<String>);
        let cancel = CancellationToken::new();
        handle.spawn(write_frames(stdin, incoming, cancel.clone()));
        let (clicks, opened) = tokio::sync::mpsc::channel(8);
        handle.spawn(read_clicks(stdout, clicks, cancel.clone()));
        Ok(Some((
            Self {
                child: Some(child),
                frames,
                cancel,
            },
            opened,
        )))
    }

    pub fn show(&self, glance: &Glance) {
        let frame = serde_json::json!({ "glance": glance }).to_string();
        let _ = self.frames.send(Some(frame));
    }
}

impl Drop for Island {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
            vibevalley_rt::current_or_global_handle().spawn(async move {
                let _ = child.wait().await;
            });
        }
    }
}

fn opened_issue(line: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Open {
        open: String,
    }
    let open = serde_json::from_str::<Open>(line).ok()?.open;
    (!open.is_empty() && open.len() <= 256 && open.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).then_some(open)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn regression_a_busy_island_receives_the_final_frame() {
        let (tx, mut rx) = watch::channel(None::<String>);
        let _ = tx.send(Some("working".into()));
        let _ = tx.send(Some("waiting".into()));
        let _ = tx.send(Some("done".into()));
        assert!(rx.has_changed().unwrap());
        assert_eq!(rx.borrow_and_update().as_deref(), Some("done"));
        assert!(!rx.has_changed().unwrap());
    }

    #[test]
    fn async_pipes_write_latest_frame_and_read_clicks() {
        vibevalley_rt::block_on(async {
            let (stdin_tx, mut stdin_rx) = tokio::io::duplex(256);
            let (frames_tx, frames_rx) = watch::channel(None::<String>);
            let cancel = CancellationToken::new();
            let writer = tokio::spawn(write_frames(stdin_tx, frames_rx, cancel.clone()));
            let _ = frames_tx.send(Some("first".into()));
            let _ = frames_tx.send(Some("final".into()));
            let mut line = String::new();
            let mut reader = BufReader::new(&mut stdin_rx);
            reader.read_line(&mut line).await.unwrap();
            assert!(line == "final\n" || line == "first\n");
            cancel.cancel();
            writer.await.unwrap();

            let (mut stdout_tx, stdout_rx) = tokio::io::duplex(256);
            let (clicks_tx, mut clicks_rx) = tokio::sync::mpsc::channel(8);
            let cancel = CancellationToken::new();
            let reader_task = tokio::spawn(read_clicks(stdout_rx, clicks_tx, cancel.clone()));
            stdout_tx.write_all(b"{\"open\":\"issue-42\"}\n").await.unwrap();
            stdout_tx.flush().await.unwrap();
            assert_eq!(clicks_rx.recv().await.unwrap(), "issue-42");
            cancel.cancel();
            reader_task.await.unwrap();
        });
    }

    #[test]
    fn regression_island_clicks_are_issue_ids_not_routes() {
        assert_eq!(opened_issue(r#"{"open":"issue-123"}"#), Some("issue-123".into()));
        assert_eq!(opened_issue(r#"{"open":"../../settings"}"#), None);
        assert_eq!(opened_issue(r#"{"open":""}"#), None);
        assert_eq!(opened_issue("broken"), None);
    }

    #[test]
    fn glance_reads_board_slice_stages_and_sorts_waiting_first() {
        let mut working = vibevalley_protocol::Issue::new("i-1", 1, "Build", 1);
        working.stage.state = IssueStageKind::Working;
        let mut asking = vibevalley_protocol::Issue::new("i-2", 2, "Clarify", 2);
        asking.stage.state = IssueStageKind::Asking;
        let mut stuck = vibevalley_protocol::Issue::new("i-3", 3, "Fix", 3);
        stuck.stage.state = IssueStageKind::Stuck;
        let mut done = vibevalley_protocol::Issue::new("i-4", 4, "Done", 4);
        done.stage.state = IssueStageKind::Done;

        let board = BoardSlice {
            seq: 5,
            issues: vec![working, asking, stuck, done],
            board_summary: None,
            commits: None,
            repo_health: Vec::new(),
        };
        let out = glance(&board);
        assert_eq!(out.working, 1);
        assert_eq!(out.waiting, 2);
        assert_eq!(out.rows.len(), 3);
        assert_eq!(out.rows[0].issue, "i-2");
        assert_eq!(out.rows[0].tone, "waiting");
        assert_eq!(out.rows[1].issue, "i-3");
        assert_eq!(out.rows[1].tone, "stuck");
        assert_eq!(out.rows[2].issue, "i-1");
        assert_eq!(out.rows[2].tone, "working");
    }
}
