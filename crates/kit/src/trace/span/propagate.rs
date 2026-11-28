use std::future::Future;

use tokio::task::JoinHandle;
use tracing::Instrument as _;
use tracing::instrument::WithSubscriber as _;

/// Spawns an async future on the ambient Tokio runtime (or shared `vibevalley-io` fallback),
/// preserving the active [`tracing::Span`] and subscriber.
pub fn spawn_traced<F>(f: F) -> JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    crate::rt::current_or_global_handle().spawn(f.in_current_span().with_current_subscriber())
}

/// Spawns a blocking closure on the ambient Tokio runtime (or shared `vibevalley-io` fallback),
/// preserving the active [`tracing::Span`] and subscriber.
pub fn spawn_blocking_traced<F, R>(f: F) -> JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    let dispatch = tracing::dispatcher::get_default(|d| d.clone());
    let span = tracing::Span::current();
    crate::rt::current_or_global_handle().spawn_blocking(move || tracing::dispatcher::with_default(&dispatch, || span.in_scope(f)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn traced_spawns_complete_and_return_values() {
        let a = spawn_traced(async { 21usize }).await.unwrap();
        let b = spawn_blocking_traced(|| 21usize).await.unwrap();
        assert_eq!(a + b, 42);
    }
}
