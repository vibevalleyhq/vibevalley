//! Tracing-preserving Tokio spawn helpers and per-request RPC span/call logging.

use std::future::Future;

use tokio::task::JoinHandle;
use tracing::Instrument as _;
use tracing::instrument::WithSubscriber as _;

/// Spawns an async future on the ambient Tokio runtime (or global fallback),
/// preserving the active [`tracing::Span`] and subscriber.
pub fn spawn_traced<F>(f: F) -> JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    vibevalley_runtime::rt::current_or_global_handle().spawn(f.in_current_span().with_current_subscriber())
}

/// Spawns a blocking closure on the ambient Tokio runtime (or global fallback),
/// preserving the active [`tracing::Span`] and subscriber.
pub fn spawn_blocking_traced<F, R>(f: F) -> JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    let dispatch = tracing::dispatcher::get_default(|d| d.clone());
    let span = tracing::Span::current();
    vibevalley_runtime::rt::current_or_global_handle().spawn_blocking(move || tracing::dispatcher::with_default(&dispatch, || span.in_scope(f)))
}

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
