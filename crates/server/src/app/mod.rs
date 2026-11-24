//! Single-owner server composition root (`App`) and typed spine primitives.
//!
//! Dependencies are strictly DAG-ordered (`L0 -> L1 -> L2 -> L3`) with singular
//! domain fields, direct `async fn` calls between domains, `ServerDb` +
//! `Outbox` + `LiveOverlay` + `SliceProjector` state projection, and
//! [`door::ServerDoor`] as the sole external/transport boundary.

pub mod bootstrap;
pub mod door;
pub mod fake;
pub(crate) mod live;
pub(crate) mod loom_sync;
pub(crate) mod outbox;
pub(crate) mod port;
pub(crate) mod projection;
pub(crate) mod refusal;
pub(crate) mod runtime;
pub(crate) mod runtime_inbox;
pub mod slice;
pub(crate) mod ticker;

use std::future::Future;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tracing::Instrument as _;
use tracing::instrument::WithSubscriber as _;
use vibevalley_core::SharedClock;
use vibevalley_protocol::Millis;
use vibevalley_runtime::oar::Registry;

use crate::collab;
use crate::content;
use crate::db::ServerDb;
use crate::infra;
use crate::skin;
use crate::team;
use crate::work;

/// Installs the process-wide `ring` TLS provider once (`reqwest` and `tokio-tungstenite`).
pub fn install_tls() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// Spawns a blocking closure on the ambient Tokio runtime (falling back to
/// `vibevalley-io` outside Tokio) while preserving [`tracing::Span::current`].
pub fn spawn_blocking_traced<F, R>(f: F) -> tokio::task::JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    let dispatch = tracing::dispatcher::get_default(|d| d.clone());
    let span = tracing::Span::current();
    vibevalley_runtime::rt::current_or_global_handle().spawn_blocking(move || tracing::dispatcher::with_default(&dispatch, || span.in_scope(f)))
}

/// Spawns an async future on the ambient Tokio runtime preserving tracing context.
pub(crate) fn spawn_traced<F>(f: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    vibevalley_runtime::rt::current_or_global_handle().spawn(f.in_current_span().with_current_subscriber())
}

/// Unix milliseconds now.
pub fn now() -> Millis {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as Millis)
        .unwrap_or(0)
}

/// Where a subscription's events go; ends when the subscriber stops (`stopped`)
/// or the opener drops it.
pub struct Sink {
    pub events: flume::Sender<Value>,
    /// Disconnected once the subscriber has stopped.
    pub stop: flume::Receiver<()>,
}

impl Sink {
    pub fn stopped(&self) -> bool {
        matches!(self.stop.try_recv(), Err(flume::TryRecvError::Disconnected))
    }

    /// Sends one serialized event; returns `false` once nobody listens.
    pub fn send<T: Serialize>(&self, event: &T) -> bool {
        !self.stopped() && serde_json::to_value(event).is_ok_and(|v| self.events.send(v).is_ok())
    }
}

/// Immutable, bottom-up (`L0 -> L1 -> L2 -> L3`) server composition root.
///
/// Every domain field is strictly singular. Domain stores never hold a
/// back-reference to [`App`] or [`door::ServerDoor`].
pub struct App {
    // L0 spine primitives & process configuration
    pub(crate) db: Arc<ServerDb>,
    pub(crate) runtime: Arc<runtime::Runtime>,
    pub(crate) live: Arc<live::LiveOverlay>,
    pub(crate) projector: Arc<slice::SliceProjector>,
    pub(crate) outbox: Arc<outbox::Outbox>,
    pub(crate) registry: Arc<Registry>,
    pub(crate) version: String,
    pub(crate) clock: SharedClock,

    // L1 infrastructure & team agents
    pub(crate) setting: Arc<infra::setting::Setting>,
    pub(crate) provider: Arc<infra::provider::Provider>,
    pub(crate) attachment: Arc<content::attachment::AttachmentStore>,
    pub(crate) machine: Arc<infra::machine::MachineStore>,
    pub(crate) agent: Arc<team::agent::AgentStore>,
    pub(crate) remote: Arc<infra::remote::Remote>,
    pub(crate) debug: Arc<infra::debug::DebugKit>,

    // L2 domain stores
    pub(crate) memory: Arc<team::memory::MemoryStore>,
    pub(crate) channel: Arc<collab::channel::Chat>,
    pub(crate) artifact: Arc<content::artifact::ArtifactStore>,
    pub(crate) library: Arc<content::library::LibraryStore>,
    pub(crate) media_input: Arc<content::media::inputs::MediaInputStore>,
    pub(crate) media: Arc<content::media::jobs::MediaStore>,
    pub(crate) repo: Arc<work::repo::RepoStore>,
    pub(crate) trajectory: Arc<work::session::TrajectoryStore>,
    pub(crate) issue: Arc<work::issue::IssueStore>,
    pub(crate) session: Arc<work::session::SessionStore>,
    pub(crate) pull: Arc<work::pull::PullStore>,

    // L3 cross-domain orchestrators, chat sync, crons, comms & skin
    pub(crate) issue_chat: Arc<work::chat::IssueChat>,
    pub(crate) session_chat: Arc<work::chat::SessionChat>,
    pub(crate) resource: Arc<team::mcp::ResourceStore>,
    pub(crate) tool: Arc<team::tool::ToolBox>,
    pub(crate) orchestrator: Arc<team::orchestrator::Orchestrator>,
    pub(crate) cron: Arc<work::cron::CronStore>,
    pub(crate) voice: Arc<collab::voice::Voice>,
    pub(crate) connector: Arc<collab::connector::Connector>,
    pub(crate) game: Arc<skin::game::Game>,
}
