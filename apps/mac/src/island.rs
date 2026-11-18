use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

use serde::{Deserialize, Serialize};
use vibevalley_i18n::t;
use vibevalley_protocol::{IssueStageKind, StateFrame};

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

pub fn glance(frame: &StateFrame) -> Glance {
    let mut rows: Vec<Row> = frame
        .state
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

struct LatestFrame {
    pending: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    wake: flume::Sender<()>,
}

impl LatestFrame {
    fn channel() -> (Self, flume::Receiver<()>) {
        let (wake, receiver) = flume::bounded(1);
        (
            Self {
                pending: Default::default(),
                wake,
            },
            receiver,
        )
    }
    fn send(&self, frame: String) {
        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(frame);
        let _ = self.wake.try_send(());
    }
}

pub struct Island {
    child: Child,
    frames: LatestFrame,
}

impl Island {
    pub fn start() -> Result<Option<(Self, flume::Receiver<String>)>, String> {
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
        let mut child = Command::new(binary)
            .arg("--font")
            .arg(crate::pixel::assets_dir().join("fonts/fusion-pixel-12px-proportional-zh_hans.otf"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let mut stdin = child.stdin.take().ok_or("island stdin was not piped")?;
        let stdout = child.stdout.take().ok_or("island stdout was not piped")?;
        let (frames, incoming) = LatestFrame::channel();
        let pending = frames.pending.clone();
        std::thread::spawn(move || {
            for () in incoming {
                let Some(frame) = pending.lock().unwrap_or_else(|e| e.into_inner()).take() else {
                    continue;
                };
                if writeln!(stdin, "{frame}").and_then(|_| stdin.flush()).is_err() {
                    break;
                }
            }
        });
        let (clicks, opened) = flume::bounded(8);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Some(issue) = opened_issue(&line) {
                    let _ = clicks.try_send(issue);
                }
            }
        });
        Ok(Some((Self { child, frames }, opened)))
    }

    pub fn show(&self, glance: &Glance) {
        let frame = serde_json::json!({ "glance": glance }).to_string();
        self.frames.send(frame);
    }
}

impl Drop for Island {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
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
        let (frames, wake) = LatestFrame::channel();
        frames.send("working".into());
        frames.send("waiting".into());
        frames.send("done".into());
        wake.recv().unwrap();
        assert_eq!(frames.pending.lock().unwrap().take().as_deref(), Some("done"));
        assert!(wake.try_recv().is_err());
    }

    #[test]
    fn regression_island_clicks_are_issue_ids_not_routes() {
        assert_eq!(opened_issue(r#"{"open":"issue-123"}"#), Some("issue-123".into()));
        assert_eq!(opened_issue(r#"{"open":"../../settings"}"#), None);
        assert_eq!(opened_issue(r#"{"open":""}"#), None);
        assert_eq!(opened_issue("broken"), None);
    }
}
