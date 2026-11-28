//! Shared runtime context (`Context`) and L0 infrastructure primitives passed
//! into every flat server domain module.

pub mod api;
pub mod error;
pub mod feed;
pub mod http;
pub mod live;
pub mod outbox;
pub mod task;
pub mod text;

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use vibevalley_core::{Clock as CoreClock, SharedClock, SliceMask};
use vibevalley_kit::Kit;
use vibevalley_protocol::Millis;

pub use api::{
    BoxFuture, CallerContext, CallerPrincipal, ClientIdentity, ClientKind, FaultGate, GatewayPorts, HostDebugBridge, LiveVoiceLine, LiveVoicePort, MachineBus,
    MachineConnection, Mcp, RemoteAuth, RemoteDeviceIdentity, SharedFaultGate, SharedHostDebug, SharedLiveVoice, SharedMachineBus, SharedMcp, SharedRemoteAuth,
    dispatch_mcp_message_async, dispatch_mcp_tunnel_async, refusal,
};
pub use error::{AsyncRequestKeys, LookIn, internal, missing, refused};
pub use feed::{SliceFeed, SliceFrame, SliceSubscription, StateFeed, encode_slice};
pub use http::{
    Fetch, FetchError, Http, PublicBytes, PublicDownload, PublicDownloadError, ReadError, Request, Response, install_tls, read_max, read_max_until,
};
pub use live::{FarmEffect, LiveSessionSnapshot, LiveState, Sink, bridge_live_receiver};
pub use outbox::{
    OUTBOX_CONNECTOR_NOTIFY, OUTBOX_SESSION_REPORTED, Outbox, OutboxConnectorNotify, OutboxDeadLetter, OutboxDelivery, OutboxEvent, OutboxSessionReported,
};
pub use task::{TaskGroup, Ticker};

use crate::service::Service;

/// Current Unix wall-clock timestamp in milliseconds.
pub fn now() -> Millis {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().min(Millis::MAX as u128) as Millis)
        .unwrap_or(0)
}

struct CoreClockAdapter(SharedClock);

impl vibevalley_kit::core::time::Clock for CoreClockAdapter {
    fn now_ms(&self) -> i64 {
        self.0.now_ms()
    }
}

struct KitClockAdapter(vibevalley_kit::core::time::SharedClock);

impl CoreClock for KitClockAdapter {
    fn now_ms(&self) -> Millis {
        self.0.now_ms()
    }
}

/// Shared L0 execution context passed to server domain services, replacing
/// multi-argument infrastructure plumbing.
#[derive(Clone)]
pub struct Context {
    pub kit: Arc<Kit>,
    pub service: Arc<Service>,
    pub task: TaskGroup,
    pub live: Arc<LiveState>,
    pub outbox: Arc<Outbox>,
    pub feed: Arc<StateFeed>,
    pub clock: SharedClock,
    pub http: Arc<dyn Fetch>,
    pub download: Arc<dyn Fetch>,
}

impl Context {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        service: Arc<Service>,
        task: TaskGroup,
        live: Arc<LiveState>,
        outbox: Arc<Outbox>,
        feed: Arc<StateFeed>,
        clock: SharedClock,
        http: Arc<dyn Fetch>,
        download: Arc<dyn Fetch>,
    ) -> Self {
        let kit = Arc::new(Kit::from_parts(Arc::new(CoreClockAdapter(clock.clone())), task.clone()));
        Self {
            kit,
            service,
            task,
            live,
            outbox,
            feed,
            clock,
            http,
            download,
        }
    }

    /// Constructs a [`Context`] backed by an explicit Ring-0 [`Kit`] handle.
    #[allow(clippy::too_many_arguments)]
    pub fn from_kit(
        kit: Arc<Kit>,
        service: Arc<Service>,
        live: Arc<LiveState>,
        outbox: Arc<Outbox>,
        feed: Arc<StateFeed>,
        http: Arc<dyn Fetch>,
        download: Arc<dyn Fetch>,
    ) -> Self {
        let task = kit.task.clone();
        let clock: SharedClock = Arc::new(KitClockAdapter(kit.clock.clone()));
        Self {
            kit,
            service,
            task,
            live,
            outbox,
            feed,
            clock,
            http,
            download,
        }
    }

    /// Current timestamp in Unix milliseconds from the configured [`SharedClock`].
    pub fn now(&self) -> Millis {
        self.clock.now_ms()
    }

    /// Spawns a named, tracked async task on [`Self::task`].
    pub fn spawn<F>(&self, name: &'static str, fut: F) -> JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        self.task.spawn_named(name, fut)
    }

    /// Spawns a named, tracked periodic ticker on [`Self::task`].
    pub fn every<F, Fut>(&self, name: &'static str, interval: Duration, f: F) -> Ticker
    where
        F: FnMut() -> Fut + Send + 'static,
        Fut: Future<Output = bool> + Send + 'static,
    {
        self.task.every(name, interval, f)
    }

    /// Marks the slices in `mask` dirty on [`Self::feed`] and returns the new sequence.
    pub fn mark_dirty(&self, mask: SliceMask) -> i64 {
        self.feed.mark_dirty(mask)
    }

    /// Root cancellation token for this server context.
    pub fn token(&self) -> CancellationToken {
        self.task.token()
    }

    /// Cancels tracked tasks and awaits graceful drain up to `grace`.
    pub async fn shutdown(&self, grace: Duration) -> bool {
        self.task.shutdown(grace).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn context_embeds_kit_and_from_kit_shares_clock_and_task_group() {
        let dir = tempfile::tempdir().unwrap();
        let service = Service::open(dir.path()).await.unwrap();
        let outbox = Arc::new(Outbox::new(service.clone()));

        let core_clock = Arc::new(vibevalley_core::ManualClock::new(1_700_000_000_000));
        let ctx = Context::new(
            service.clone(),
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            outbox.clone(),
            Arc::new(StateFeed::new()),
            core_clock.clone(),
            Arc::new(Http),
            Arc::new(PublicDownload),
        );
        assert_eq!(ctx.now(), 1_700_000_000_000);
        assert_eq!(ctx.kit.clock.now_ms(), 1_700_000_000_000);
        core_clock.advance(Duration::from_secs(5));
        assert_eq!(ctx.kit.clock.now_ms(), 1_700_000_005_000);

        let kit_clock = Arc::new(vibevalley_kit::core::time::ManualClock::new(1_800_000_000_000));
        let kit = Arc::new(Kit::with_clock(kit_clock.clone()));
        let ctx_from_kit = Context::from_kit(
            kit.clone(),
            service.clone(),
            Arc::new(LiveState::new()),
            outbox,
            Arc::new(StateFeed::new()),
            Arc::new(Http),
            Arc::new(PublicDownload),
        );
        assert_eq!(ctx_from_kit.now(), 1_800_000_000_000);
        kit_clock.advance(Duration::from_millis(250));
        assert_eq!(ctx_from_kit.now(), 1_800_000_000_250);
        assert!(ctx_from_kit.kit.close_async(Duration::from_secs(1)).await);
        assert!(ctx_from_kit.token().is_cancelled());

        assert!(ctx.shutdown(Duration::from_secs(1)).await);
        service.close().await;
    }
}
