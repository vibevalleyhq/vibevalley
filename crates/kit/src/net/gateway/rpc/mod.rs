//! Generic pure-async RPC dispatcher trait, typed envelope/error primitives,
//! and span-propagating traced dispatch wrapper with lock-free observer hooks.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tracing::Instrument as _;

use crate::trace::{Observer, ObserverSlot};

/// Heap-allocated `Send` future returned by [`RpcDispatcher`].
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Domain-agnostic structured RPC error carrying a numeric code and message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

impl RpcError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: None,
        }
    }

    pub fn retryable(mut self, retryable: bool) -> Self {
        self.retryable = Some(retryable);
        self
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(400, message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(401, message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(403, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(404, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(500, message)
    }
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for RpcError {}

/// Generic RPC response envelope carrying either `data` or `error` plus optional `trace_id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcEnvelope<T> {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<u64>,
}

impl<T> RpcEnvelope<T> {
    pub fn ok(data: T) -> Self {
        Self {
            ok: true,
            data: Some(data),
            error: None,
            trace_id: None,
        }
    }

    pub fn err(error: RpcError) -> Self {
        Self {
            ok: false,
            data: None,
            error: Some(error),
            trace_id: None,
        }
    }

    pub fn from_result(result: Result<T, RpcError>) -> Self {
        match result {
            Ok(data) => Self::ok(data),
            Err(error) => Self::err(error),
        }
    }

    pub fn with_trace_id(mut self, trace_id: u64) -> Self {
        self.trace_id = Some(trace_id);
        self
    }
}

/// Pure-async domain-agnostic RPC dispatch contract.
pub trait RpcDispatcher<Ctx = ()>: Send + Sync + 'static {
    type Output: Send + 'static;
    type Error: Send + 'static;

    fn dispatch_async(self: Arc<Self>, ctx: Ctx, method: String, payload: serde_json::Value) -> BoxFuture<'static, Result<Self::Output, Self::Error>>;
}

/// Telemetry record emitted after each traced RPC invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcInvocation {
    pub method: String,
    pub trace_id: u64,
    pub elapsed_ms: u64,
    pub ok: bool,
}

/// Wraps an [`RpcDispatcher`] with instance-scoped monotonic trace IDs,
/// `tracing` span instrumentation, and a lock-free [`ObserverSlot`].
pub struct TracedRpcDispatcher<D> {
    inner: Arc<D>,
    next_trace: AtomicU64,
    observer: ObserverSlot<dyn Observer<RpcInvocation>>,
}

impl<D> TracedRpcDispatcher<D> {
    pub fn new(inner: Arc<D>) -> Self {
        Self {
            inner,
            next_trace: AtomicU64::new(1),
            observer: ObserverSlot::const_empty(),
        }
    }

    pub fn inner(&self) -> &Arc<D> {
        &self.inner
    }

    pub fn next_trace_id(&self) -> u64 {
        self.next_trace.fetch_add(1, Ordering::Relaxed)
    }

    pub fn set_observer(&self, observer: Option<Arc<dyn Observer<RpcInvocation>>>) {
        self.observer.set(observer);
    }

    pub async fn call_async<Ctx>(&self, ctx: Ctx, method: impl Into<String>, payload: serde_json::Value) -> (u64, Result<D::Output, D::Error>)
    where
        D: RpcDispatcher<Ctx>,
    {
        let method = method.into();
        let trace_id = self.next_trace_id();
        let span = tracing::info_span!("kit.rpc", method = %method, trace_id);
        let started = Instant::now();
        let outcome = Arc::clone(&self.inner).dispatch_async(ctx, method.clone(), payload).instrument(span).await;
        let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.observer.notify(|obs| {
            obs.observe(&RpcInvocation {
                method: method.clone(),
                trace_id,
                elapsed_ms,
                ok: outcome.is_ok(),
            });
        });
        (trace_id, outcome)
    }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroUsize;

    use serde_json::json;

    use crate::trace::MemorySink;

    use super::*;

    struct EchoDispatcher;

    impl RpcDispatcher<&'static str> for EchoDispatcher {
        type Output = serde_json::Value;
        type Error = RpcError;

        fn dispatch_async(
            self: Arc<Self>,
            ctx: &'static str,
            method: String,
            payload: serde_json::Value,
        ) -> BoxFuture<'static, Result<Self::Output, Self::Error>> {
            Box::pin(async move {
                if method == "fail" {
                    return Err(RpcError::invalid_input("bad payload"));
                }
                Ok(json!({ "ctx": ctx, "method": method, "payload": payload }))
            })
        }
    }

    #[tokio::test]
    async fn traced_rpc_dispatcher_assigns_trace_ids_and_notifies_observer() {
        let dispatcher = TracedRpcDispatcher::new(Arc::new(EchoDispatcher));
        let sink = Arc::new(MemorySink::<RpcInvocation>::new(NonZeroUsize::new(8).unwrap()));
        dispatcher.set_observer(Some(sink.clone()));

        let (t1, ok) = dispatcher.call_async("local", "ping", json!({ "n": 1 })).await;
        assert_eq!(t1, 1);
        let env = RpcEnvelope::from_result(ok).with_trace_id(t1);
        assert!(env.ok);
        assert_eq!(env.trace_id, Some(1));
        assert_eq!(env.data.unwrap()["method"], "ping");

        let (t2, err) = dispatcher.call_async("local", "fail", json!({})).await;
        assert_eq!(t2, 2);
        let env = RpcEnvelope::from_result(err).with_trace_id(t2);
        assert!(!env.ok);
        assert_eq!(env.error.unwrap().code, 400);

        let recorded = sink.snapshot();
        assert_eq!(recorded.len(), 2);
        assert_eq!(recorded[0].trace_id, 1);
        assert!(recorded[0].ok);
        assert_eq!(recorded[1].trace_id, 2);
        assert!(!recorded[1].ok);
    }
}
