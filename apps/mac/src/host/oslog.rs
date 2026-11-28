use std::ffi::CString;
use std::fmt::Write as _;
use std::sync::OnceLock;

use crate::platform::oslog_ffi::{OS_LOG_TYPE_DEBUG, OS_LOG_TYPE_DEFAULT, OS_LOG_TYPE_ERROR, OS_LOG_TYPE_INFO, OsLogHandle};

const OSLOG_CATEGORIES: [&std::ffi::CStr; 8] = [c"mac", c"server", c"runtime", c"core", c"git", c"files", c"rich", c"app"];

pub(super) fn oslog_category_index(target: &str) -> usize {
    if target.starts_with("vibevalley_mac") || target.starts_with("vibevalley::host") {
        0
    } else if target.starts_with("vibevalley_server") {
        1
    } else if target.starts_with("vibevalley_runtime") {
        2
    } else if target.starts_with("vibevalley_core") {
        3
    } else if target.starts_with("vibevalley_git") {
        4
    } else if target.starts_with("vibevalley_files") {
        5
    } else if target.starts_with("vibevalley_rich") {
        6
    } else {
        7
    }
}

fn oslog_handles() -> &'static [OsLogHandle; 8] {
    static HANDLES: OnceLock<[OsLogHandle; 8]> = OnceLock::new();
    HANDLES.get_or_init(|| OSLOG_CATEGORIES.map(|cat| OsLogHandle::create(c"dev.vibevalley.app", cat)))
}

pub(super) fn oslog_type_for(level: &tracing::Level) -> u8 {
    match *level {
        tracing::Level::ERROR => OS_LOG_TYPE_ERROR,
        tracing::Level::WARN => OS_LOG_TYPE_DEFAULT,
        tracing::Level::INFO => OS_LOG_TYPE_INFO,
        tracing::Level::DEBUG | tracing::Level::TRACE => OS_LOG_TYPE_DEBUG,
    }
}

struct OsLogVisitor {
    message: String,
    fields: String,
}

impl OsLogVisitor {
    fn new() -> Self {
        Self {
            message: String::new(),
            fields: String::new(),
        }
    }

    fn finish(self, target: &str) -> String {
        let mut out = String::with_capacity(target.len() + self.message.len() + self.fields.len() + 4);
        out.push_str(target);
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

impl tracing::field::Visit for OsLogVisitor {
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

/// Lightweight `tracing_subscriber::Layer` routing events to macOS Unified Logging
/// (`Console.app` / `log stream --predicate 'subsystem == "dev.vibevalley.app"'`).
pub struct OsLogLayer;

impl OsLogLayer {
    pub fn new() -> Self {
        let _ = oslog_handles();
        Self
    }
}

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for OsLogLayer {
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: tracing_subscriber::layer::Context<'_, S>) {
        let meta = event.metadata();
        let log_type = oslog_type_for(meta.level());
        let handle = oslog_handles()[oslog_category_index(meta.target())];
        if !handle.is_enabled(log_type) {
            return;
        }
        let mut visitor = OsLogVisitor::new();
        event.record(&mut visitor);
        let formatted = visitor.finish(meta.target()).replace('\0', " ");
        let Ok(c_msg) = CString::new(formatted) else {
            return;
        };
        handle.emit_public(log_type, &c_msg);
    }
}
