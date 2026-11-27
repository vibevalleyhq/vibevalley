//! Desktop tracing initialization, in-memory startup/runtime log ring buffer,
//! persistent `<home>/logs/desktop.log`, and diagnostic report formatting.

use std::collections::VecDeque;
use std::fmt::Write as _;
use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use parking_lot::Mutex;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::layer::SubscriberExt as _;
use tracing_subscriber::util::SubscriberInitExt as _;

use crate::env::StartupFailure;

const MAX_LOG_LINES: usize = 400;
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

struct LogRing {
    lines: VecDeque<String>,
    file: Option<File>,
    file_path: PathBuf,
}

impl LogRing {
    #[cfg(test)]
    fn new_in_memory(file_path: PathBuf) -> Self {
        Self {
            lines: VecDeque::with_capacity(MAX_LOG_LINES),
            file: None,
            file_path,
        }
    }

    fn open_with_file(log_path: PathBuf) -> Self {
        let file = open_rotating_log_file(&log_path);
        Self {
            lines: VecDeque::with_capacity(MAX_LOG_LINES),
            file,
            file_path: log_path,
        }
    }

    fn push_line(&mut self, line: String) {
        if let Some(file) = self.file.as_mut() {
            let _ = writeln!(file, "{line}");
            let _ = file.flush();
        }
        if self.lines.len() >= MAX_LOG_LINES {
            self.lines.pop_front();
        }
        self.lines.push_back(line);
    }
}

fn open_rotating_log_file(path: &Path) -> Option<File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok()?;
    }
    if let Ok(meta) = std::fs::metadata(path)
        && meta.len() > MAX_LOG_BYTES
    {
        let prev = path.with_file_name("desktop.prev.log");
        let _ = std::fs::rename(path, prev);
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
}

fn log_ring() -> &'static Mutex<LogRing> {
    static RING: OnceLock<Mutex<LogRing>> = OnceLock::new();
    RING.get_or_init(|| Mutex::new(LogRing::open_with_file(default_log_file_path())))
}

fn default_log_file_path() -> PathBuf {
    crate::env::server_home().join("logs").join("desktop.log")
}

pub fn log_file_path() -> PathBuf {
    log_ring().lock().file_path.clone()
}

pub fn recent_lines() -> Vec<String> {
    log_ring().lock().lines.iter().cloned().collect()
}

struct LineVisitor {
    message: String,
    fields: String,
}

impl LineVisitor {
    fn new() -> Self {
        Self {
            message: String::new(),
            fields: String::new(),
        }
    }

    fn format_line(self, level: &tracing::Level, target: &str) -> String {
        let now = jiff::ZonedDateTime::now();
        let ts = format!("{:02}:{:02}:{:02}.{:03}", now.hour(), now.minute(), now.second(), now.millisecond());
        let mut out = format!("[{ts}] {level:<5} {target}");
        if !self.message.is_empty() {
            out.push_str(": ");
            out.push_str(&self.message);
        }
        if !self.fields.is_empty() {
            out.push(' ');
            out.push_str(&self.fields);
        }
        out
    }
}

impl tracing::field::Visit for LineVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.message, "{value:?}");
        } else {
            if !self.fields.is_empty() {
                self.fields.push(' ');
            }
            let _ = write!(self.fields, "{}={value:?}", field.name());
        }
    }

    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            self.message.push_str(value);
        } else {
            if !self.fields.is_empty() {
                self.fields.push(' ');
            }
            let _ = write!(self.fields, "{}={value}", field.name());
        }
    }
}

struct LogBufferLayer;

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for LogBufferLayer {
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: tracing_subscriber::layer::Context<'_, S>) {
        let meta = event.metadata();
        let mut visitor = LineVisitor::new();
        event.record(&mut visitor);
        if crate::vdp_bus::is_vdp_log_active() {
            let level = match *meta.level() {
                tracing::Level::TRACE => vibevalley_protocol::VdpLogLevel::Trace,
                tracing::Level::DEBUG => vibevalley_protocol::VdpLogLevel::Debug,
                tracing::Level::INFO => vibevalley_protocol::VdpLogLevel::Info,
                tracing::Level::WARN => vibevalley_protocol::VdpLogLevel::Warn,
                tracing::Level::ERROR => vibevalley_protocol::VdpLogLevel::Error,
            };
            let fields = (!visitor.fields.is_empty()).then(|| serde_json::json!({ "raw": visitor.fields }));
            crate::vdp_bus::emit_log_entry(level, meta.target(), visitor.message.clone(), fields);
        }
        let line = visitor.format_line(meta.level(), meta.target());
        log_ring().lock().push_line(line);
    }
}

pub fn init() {
    let _ = log_ring();
    let default_spec = if crate::env::devtools_enabled() {
        "info"
    } else {
        "warn,vibevalley_mac=info,vibevalley_server=info,vibevalley_runtime=info,sea_orm_migration=info"
    };
    let filter = std::env::var("VIBEVALLEY_LOG")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("RUST_LOG").ok().filter(|s| !s.trim().is_empty()))
        .and_then(|raw| EnvFilter::try_new(raw).ok())
        .unwrap_or_else(|| EnvFilter::new(default_spec));

    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().with_target(true))
        .with(crate::host::OsLogLayer::new())
        .with(LogBufferLayer)
        .try_init();
}

pub fn format_diagnostic_report(failure: Option<&StartupFailure>, lines: &[String], log_path: &Path, extra_note: Option<&str>) -> String {
    let channel = vibevalley_protocol::home::current_channel();
    let version = crate::env::bundle_version();
    let home_dir = failure.map(|f| f.home_dir.clone()).unwrap_or_else(crate::env::server_home);
    let store_path = crate::host::Storage::configured().database;

    let mut out = String::new();
    let _ = writeln!(out, "VibeValley Startup Diagnostics");
    let _ = writeln!(out, "==============================");
    let _ = writeln!(out, "Channel: {}", channel.as_str());
    let _ = writeln!(out, "Version: {version}");
    let _ = writeln!(out, "OS / Arch: {} / {}", std::env::consts::OS, std::env::consts::ARCH);
    let _ = writeln!(out, "Home dir: {}", home_dir.display());
    if let Some(db_path) = failure.and_then(|f| f.db_path.as_ref()) {
        let _ = writeln!(out, "Server DB: {}", db_path.display());
    } else {
        let _ = writeln!(out, "Server DB: {}", home_dir.join("server.db").display());
    }
    let _ = writeln!(out, "Workspace store: {}", store_path.display());
    let _ = writeln!(out, "Desktop log file: {}", log_path.display());

    if let Some(fail) = failure {
        let _ = writeln!(out);
        let _ = writeln!(out, "Failure kind: {}", fail.kind.as_str());
        let _ = writeln!(out, "Summary: {}", fail.summary);
        if let Some(detail) = &fail.detail {
            let _ = writeln!(out);
            let _ = writeln!(out, "Details:");
            let _ = writeln!(out, "{detail}");
        }
    }

    if let Some(note) = extra_note
        && !note.trim().is_empty()
    {
        let _ = writeln!(out);
        let _ = writeln!(out, "Note: {note}");
    }

    let _ = writeln!(out);
    let _ = writeln!(out, "Recent Logs ({} lines):", lines.len());
    if lines.is_empty() {
        let _ = writeln!(out, "(none)");
    } else {
        for line in lines {
            let _ = writeln!(out, "{line}");
        }
    }
    out
}

pub fn build_diagnostic_report(failure: Option<&StartupFailure>, extra_note: Option<&str>) -> String {
    let lines = recent_lines();
    let path = log_file_path();
    format_diagnostic_report(failure, &lines, &path, extra_note)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::StartupFailureKind;

    #[test]
    fn ring_buffer_caps_at_max_lines() {
        let mut ring = LogRing::new_in_memory(PathBuf::from("/tmp/desktop.log"));
        for i in 0..(MAX_LOG_LINES + 25) {
            ring.push_line(format!("line-{i}"));
        }
        assert_eq!(ring.lines.len(), MAX_LOG_LINES);
        assert_eq!(ring.lines.front().map(String::as_str), Some("line-25"));
        assert_eq!(ring.lines.back().map(String::as_str), Some("line-424"));
    }

    #[test]
    fn rotating_log_file_preserves_oversized_log() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs/desktop.log");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, vec![b'x'; (MAX_LOG_BYTES as usize) + 128]).unwrap();

        let mut ring = LogRing::open_with_file(path.clone());
        ring.push_line("fresh-entry".into());
        drop(ring);

        assert!(path.with_file_name("desktop.prev.log").is_file());
        let current = std::fs::read_to_string(&path).unwrap();
        assert_eq!(current, "fresh-entry\n");
    }

    #[test]
    fn diagnostic_report_includes_failure_detail_and_logs() {
        let failure = StartupFailure {
            kind: StartupFailureKind::DatabaseSchema,
            summary: "legacy database without migration tracking".into(),
            detail: Some("Detected schema drift (2 table(s)):\n  - session: missing columns: controller".into()),
            db_path: Some(PathBuf::from("/tmp/alpha/server.db")),
            home_dir: PathBuf::from("/tmp/alpha"),
        };
        let report = format_diagnostic_report(
            Some(&failure),
            &["[15:20:00.001] ERROR vibevalley_server::db: schema check failed".into()],
            Path::new("/tmp/alpha/logs/desktop.log"),
            None,
        );
        assert!(report.contains("Failure kind: database_schema"));
        assert!(report.contains("Server DB: /tmp/alpha/server.db"));
        assert!(report.contains("Desktop log file: /tmp/alpha/logs/desktop.log"));
        assert!(report.contains("missing columns: controller"));
        assert!(report.contains("[15:20:00.001] ERROR"));
    }
}
