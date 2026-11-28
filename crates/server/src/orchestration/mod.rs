//! L4 Application Orchestration Layer (`orchestration/`):
//!
//! Coordinates cross-domain workflows over pure deep capability modules
//! (`runtime`, `channel`, `note`, `cron`, `voice`, `connector`, `issue`, `agent`).
//! Deep domains never import `orchestration/` or each other cyclically.

pub mod connector;
pub mod connector_digest;
pub mod cron;
pub mod cron_digest;
pub mod delivery;
pub mod issue;
pub mod issue_chat;
pub mod note;
pub mod notify;
pub mod session_chat;
pub mod voice;

use std::sync::Arc;

use vibevalley_protocol::ApiError;

use crate::agent::{Orchestrator, Profile};
use crate::channel::Chat;
use crate::connector::{Connector, Options as ConnectorOptions};
use crate::context::Context;
use crate::cron::Scheduler as CronScheduler;
use crate::issue::{Board, Pull};
use crate::note::Manager as NoteManager;
use crate::runtime::Runtime;
use crate::setting::Setting;
use crate::voice::Voice;

pub use connector::ConnectorWorkflow;
pub use connector_digest::{
    DigestEntry, IssueReplyAction, PermissionReplyAction, PersonalEvent, PersonalEventKind, PushTarget, ReplyParseError, digest, format_personal_event,
    format_personal_event_in, is_pairing, parse_digest_entry, parse_issue_reply, parse_permission_reply, parse_push_issue_message_id, parse_push_message_id,
    parse_push_perm_message_id, personal_event_for_issue, personal_event_for_run, short_id, split_text, user_line,
};
pub use cron::{CronWorkflow, DigestCronRequest};
pub use cron_digest::{
    DigestIssueItem, DigestRunStats, DigestSpec, DigestTargets, ProgressDigest, build_progress_digest, format_digest_directive, format_progress_digest,
    format_progress_digest_in, parse_digest_directive, progress_digest_from_morning,
};
pub use delivery::DeliveryRouter;
pub use issue::IssueWorkflow;
pub use issue_chat::IssueChat;
pub use note::NoteWorkflow;
pub use notify::{NotifyDecision, NotifyGate, NotifyOptions, NotifyRouter, QuietHours, SuppressReason};
pub use session_chat::SessionChat;
pub use voice::VoiceWorkflow;

/// Inputs needed to assemble and start the L4 [`Orchestration`] workflow layer.
pub struct OrchestrationParts {
    pub ctx: Arc<Context>,
    pub setting: Arc<Setting>,
    pub channel: Arc<Chat>,
    pub board: Arc<Board>,
    pub runtime: Arc<Runtime>,
    pub cron: Arc<CronScheduler>,
    pub pull: Arc<Pull>,
    pub note: Arc<NoteManager>,
    pub voice: Arc<Voice>,
    pub profile: Arc<Profile>,
    pub orchestrator: Arc<Orchestrator>,
    pub orchestrator_listens: bool,
    pub tick_crons: bool,
    pub connector_options: ConnectorOptions,
    pub connector_notify: NotifyOptions,
}

/// Bundle of all cross-domain application workflows owned by [`crate::router::AppCore`].
pub struct Orchestration {
    pub delivery: Arc<DeliveryRouter>,
    pub issue_chat: Arc<IssueChat>,
    pub session_chat: Arc<SessionChat>,
    pub issue: Arc<IssueWorkflow>,
    pub cron: Arc<CronWorkflow>,
    pub connector: Arc<ConnectorWorkflow>,
    pub note: Arc<NoteWorkflow>,
    pub voice: Arc<VoiceWorkflow>,
}

impl Orchestration {
    /// Starts all L4 cross-domain workflows and returns `(orchestration, connector)`.
    pub async fn start_async(parts: OrchestrationParts) -> Result<(Arc<Self>, Arc<Connector>), ApiError> {
        let issue_chat = IssueChat::start(parts.ctx.clone(), parts.board.clone(), parts.channel.clone());
        let session_chat = SessionChat::start(parts.ctx.clone(), parts.board.clone(), parts.channel.clone(), Some(issue_chat.clone()));
        let delivery = DeliveryRouter::start(
            parts.ctx.clone(),
            parts.channel.clone(),
            issue_chat.clone(),
            session_chat.clone(),
            parts.orchestrator.clone(),
            parts.orchestrator_listens,
        );
        let issue = IssueWorkflow::new(
            parts.ctx.clone(),
            parts.board.clone(),
            parts.runtime.clone(),
            parts.channel.clone(),
            parts.cron.clone(),
            parts.pull,
            parts.orchestrator.clone(),
        );
        let note = NoteWorkflow::start(parts.ctx.clone(), parts.note, parts.channel.clone(), parts.board.clone());
        let voice = VoiceWorkflow::new(parts.ctx.clone(), parts.voice, parts.channel.clone(), parts.orchestrator.clone());
        let connector_wf = Box::pin(ConnectorWorkflow::open_async(
            parts.ctx.clone(),
            parts.setting,
            parts.channel.clone(),
            parts.board.clone(),
            parts.runtime,
            parts.connector_options,
            parts.connector_notify,
        ))
        .await?;
        let connector = connector_wf.connector().clone();
        let cron = CronWorkflow::new(
            parts.ctx,
            parts.cron,
            parts.board,
            parts.profile,
            parts.channel,
            parts.orchestrator_listens.then_some(parts.orchestrator),
            connector_wf.clone(),
        );
        cron.start_ticker(parts.tick_crons);
        Ok((
            Arc::new(Self {
                delivery,
                issue_chat,
                session_chat,
                issue,
                cron,
                connector: connector_wf,
                note,
                voice,
            }),
            connector,
        ))
    }

    /// Cooperatively shuts down every orchestration workflow concurrently.
    pub async fn close_async(&self) {
        let mut set = tokio::task::JoinSet::new();
        {
            let delivery = self.delivery.clone();
            set.spawn(async move { delivery.close_async().await });
            let issue_chat = self.issue_chat.clone();
            set.spawn(async move { issue_chat.close_async().await });
            let session_chat = self.session_chat.clone();
            set.spawn(async move { session_chat.close_async().await });
            let cron = self.cron.clone();
            set.spawn(async move { cron.close_async().await });
            let connector = self.connector.clone();
            set.spawn(async move { connector.close_async().await });
        }
        while set.join_next().await.is_some() {}
    }
}
