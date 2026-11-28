//! Tracing-preserving Tokio spawn helpers and per-request RPC span/call logging.

pub use vibevalley_kit::trace::{spawn_blocking_traced, spawn_traced};

/// Opens the per-invocation debug span for an incoming server endpoint call.
pub fn request_span(op: &str, trace_id: u64) -> tracing::Span {
    tracing::debug_span!("server.op", op, trace_id)
}

/// Emits a structured debug trace record after an endpoint call completes.
pub fn record_call(op: &str, trace_id: u64, biz_code: u32, duration_us: u64) {
    if tracing::enabled!(tracing::Level::DEBUG) {
        tracing::debug!(op, biz_code, trace_id, duration_us, "server.call");
    }
}
