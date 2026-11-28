//! Unified ordered delivery router (`orchestration::delivery`):
//!
//! Consumes committed [`ChannelDispatched`] batches (plus boot/lag replay of
//! pending `channel_delivery` rows) and dispatches every [`QueuedDelivery`]
//! through a single bounded per-[`ParticipantId`] FIFO [`KeyedLane`],
//! cleanly splitting [`HumanAdapter`] (Inbox + external IM Outbox) and
//! [`AgentAdapter`] (daemon built-in sessions, direct-talk helper profiles,
//! and issue/worker sessions).

use std::num::NonZeroUsize;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::broadcast;
use tokio::task::JoinHandle as TaskHandle;
use tokio_util::sync::CancellationToken;
use vibevalley_core::SliceMask;
use vibevalley_kit::queue::{KeyedLane, LaneConfig};
use vibevalley_protocol::{ParticipantId, SubjectKind};

use super::issue_chat::IssueChat;
use super::session_chat::SessionChat;
use crate::agent::Orchestrator;
use crate::channel::{ChannelDispatched, Chat, Committed, QueuedDelivery, Reason};
use crate::context::Context;

const DELIVERY_LANE_CAPACITY: NonZeroUsize = NonZeroUsize::new(256).expect("non-zero capacity");
const CLOSE_GRACE: Duration = Duration::from_secs(5);

#[derive(Clone)]
struct DeliveryWork {
    delivery: QueuedDelivery,
    committed: Option<Arc<Committed>>,
}

/// Delivers channel notifications addressed to human participants (`user:<id>`):
/// dirties Inbox/Collab slices for immediate UI projection and settles durable rows.
struct HumanAdapter {
    ctx: Arc<Context>,
    channel: Arc<Chat>,
}

impl HumanAdapter {
    async fn deliver_async(&self, _user_id: &str, delivery: QueuedDelivery, _committed: Arc<Committed>) {
        self.ctx.mark_dirty(SliceMask::INBOX | SliceMask::COLLAB);
        if let Err(err) = self.channel.settle_delivery_async(delivery.id, true).await {
            tracing::warn!(delivery_id = delivery.id, message_id = %delivery.message_id, error = %err.message, "human adapter failed to settle delivery");
        }
    }
}

/// Delivers channel messages addressed to agent profiles (`agent:<profile>`)
/// and live sessions (`session:<id>`):
/// - Daemon built-in orchestrator profiles -> `Orchestrator::deliver_channel_async`
///   (`wakes: true` triggers turn; `wakes: false` appends durable `PassiveContext` mailbox).
/// - Helper profile DMs -> `SessionChat::deliver_direct_async`.
/// - Issue threads & worker sessions -> `IssueChat::deliver_issue_async` / `deliver_session_async`.
struct AgentAdapter {
    channel: Arc<Chat>,
    issue_chat: Arc<IssueChat>,
    session_chat: Arc<SessionChat>,
    orchestrator: Arc<Orchestrator>,
    orchestrator_listens: bool,
}

impl AgentAdapter {
    async fn deliver_async(&self, delivery: QueuedDelivery, committed: Arc<Committed>) {
        match delivery.recipient.clone() {
            ParticipantId::Agent(profile) => {
                if self.orchestrator.is_daemon_profile(&profile) {
                    if !self.orchestrator_listens {
                        return;
                    }
                    match self.orchestrator.deliver_channel_async(&profile, &delivery, &committed).await {
                        Ok(delivered) => {
                            if let Err(err) = self.channel.settle_delivery_async(delivery.id, delivered).await {
                                tracing::warn!(delivery_id = delivery.id, profile = %profile, error = %err.message, "agent adapter failed to settle daemon delivery");
                            }
                        }
                        Err(err) => {
                            tracing::warn!(delivery_id = delivery.id, profile = %profile, error = %err.message, "agent adapter daemon delivery error");
                            let _ = self.channel.settle_delivery_async(delivery.id, false).await;
                        }
                    }
                } else {
                    self.session_chat.deliver_direct_async(&profile, delivery, Some(committed)).await;
                }
            }
            ParticipantId::Session(sid) => {
                if let Some(issue_id) = sid.strip_prefix("issue:") {
                    self.issue_chat.deliver_issue_async(issue_id, delivery, Some(committed)).await;
                    return;
                }
                if delivery.reason == Reason::OwnThread
                    && let Some((SubjectKind::Issue, issue_id)) = &committed.topic
                {
                    let issue_id = issue_id.clone();
                    self.issue_chat.deliver_issue_async(&issue_id, delivery, Some(committed)).await;
                    return;
                }
                if !delivery.wakes {
                    // Passive ambient deliveries for worker sessions remain pending in `channel_delivery`
                    // so `IssueChat::deliver_session_async` drains them together on the session's next wake.
                    return;
                }
                if let Some(issue_id) = self.issue_chat.session_issue_async(&sid).await {
                    self.issue_chat.deliver_session_async(&sid, &issue_id, delivery, Some(committed)).await;
                    return;
                }
                if let Err(err) = self.channel.settle_delivery_async(delivery.id, true).await {
                    tracing::warn!(delivery_id = delivery.id, session_id = %sid, error = %err.message, "agent adapter failed to settle orphaned session delivery");
                }
            }
            ParticipantId::User(_) => {}
        }
    }
}

struct RouterCore {
    ctx: Arc<Context>,
    channel: Arc<Chat>,
    human: HumanAdapter,
    agent: AgentAdapter,
}

impl RouterCore {
    async fn handle_work(&self, _key: ParticipantId, work: DeliveryWork) {
        let delivery = work.delivery;
        if !self.channel.delivery_is_pending_async(delivery.id).await.unwrap_or(false) {
            let _ = self.ctx.service.session.withdraw_mailbox_by_message(&delivery.message_id, self.ctx.now()).await;
            return;
        }
        let committed = match work.committed {
            Some(c) => Some(c),
            None => match self.channel.committed_of_async(&delivery.message_id).await {
                Ok(found) => found.map(Arc::new),
                Err(err) => {
                    tracing::warn!(delivery_id = delivery.id, message_id = %delivery.message_id, error = %err.message, "delivery router failed to load committed message");
                    None
                }
            },
        };
        let Some(committed) = committed else {
            let _ = self.ctx.service.session.withdraw_mailbox_by_message(&delivery.message_id, self.ctx.now()).await;
            let _ = self.channel.withdraw_delivery_async(delivery.id).await;
            return;
        };
        if committed.row.deleted_at.is_some() {
            let _ = self.ctx.service.session.withdraw_mailbox_by_message(&delivery.message_id, self.ctx.now()).await;
            let _ = self.channel.withdraw_delivery_async(delivery.id).await;
            return;
        }
        match &delivery.recipient {
            ParticipantId::User(uid) => {
                let uid = uid.clone();
                self.human.deliver_async(&uid, delivery, committed).await;
            }
            ParticipantId::Agent(_) | ParticipantId::Session(_) => {
                self.agent.deliver_async(delivery, committed).await;
            }
        }
    }
}

type DeliveryHandler = Box<dyn Fn(ParticipantId, DeliveryWork) -> crate::BoxFuture<'static, ()> + Send + Sync>;

/// Unified channel delivery router backed by [`vibevalley_kit::queue::KeyedLane`].
pub struct DeliveryRouter {
    channel: Arc<Chat>,
    core: Arc<RouterCore>,
    cancel: CancellationToken,
    lane: KeyedLane<ParticipantId, DeliveryWork, DeliveryHandler>,
    coordinator: Mutex<Option<TaskHandle<()>>>,
}

impl DeliveryRouter {
    pub fn start(
        ctx: Arc<Context>,
        channel: Arc<Chat>,
        issue_chat: Arc<IssueChat>,
        session_chat: Arc<SessionChat>,
        orchestrator: Arc<Orchestrator>,
        orchestrator_listens: bool,
    ) -> Arc<Self> {
        let mut dispatches = channel.subscribe_dispatches();
        let cancel = ctx.task.child_token();
        let core = Arc::new(RouterCore {
            ctx: ctx.clone(),
            channel: channel.clone(),
            human: HumanAdapter {
                ctx: ctx.clone(),
                channel: channel.clone(),
            },
            agent: AgentAdapter {
                channel: channel.clone(),
                issue_chat,
                session_chat,
                orchestrator,
                orchestrator_listens,
            },
        });
        let core_handler = core.clone();
        let handler: DeliveryHandler = Box::new(move |key, work| {
            let core = core_handler.clone();
            Box::pin(async move {
                core.handle_work(key, work).await;
            })
        });
        let lane = KeyedLane::new(
            ctx.task.clone(),
            LaneConfig {
                capacity: DELIVERY_LANE_CAPACITY,
            },
            handler,
        );
        let router = Arc::new(Self {
            channel,
            core,
            cancel: cancel.clone(),
            lane,
            coordinator: Mutex::new(None),
        });

        let weak = Arc::downgrade(&router);
        let task_cancel = cancel;
        let coordinator = ctx.spawn("delivery.router", async move {
            let Some(boot) = weak.upgrade() else { return };
            boot.replay_pending_async().await;
            loop {
                let next = tokio::select! {
                    biased;
                    _ = task_cancel.cancelled() => return,
                    res = dispatches.recv() => res,
                };
                let Some(router) = weak.upgrade() else { return };
                if router.cancel.is_cancelled() {
                    return;
                }
                match next {
                    Ok(dispatched) => router.enqueue_batch_async(dispatched).await,
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(skipped, "delivery router broadcast lagged; replaying pending deliveries");
                        router.replay_pending_async().await;
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        });
        *router.coordinator.lock() = Some(coordinator);
        router
    }

    async fn should_enqueue_and_prepare(&self, delivery: &QueuedDelivery, committed: Option<&Committed>) -> bool {
        match &delivery.recipient {
            ParticipantId::Agent(profile) if self.core.agent.orchestrator.is_daemon_profile(profile) => self.core.agent.orchestrator_listens,
            ParticipantId::Agent(profile) => {
                self.core
                    .agent
                    .session_chat
                    .pre_enqueue_direct_mailbox_async(profile, delivery, committed)
                    .await;
                true
            }
            ParticipantId::Session(sid) if !sid.starts_with("issue:") && delivery.reason != Reason::OwnThread && !delivery.wakes => false,
            _ => true,
        }
    }

    async fn replay_pending_async(&self) {
        match self.channel.pending_deliveries_all_async().await {
            Ok(pending) => {
                for delivery in pending {
                    if self.cancel.is_cancelled() {
                        return;
                    }
                    if !self.should_enqueue_and_prepare(&delivery, None).await {
                        continue;
                    }
                    let key = delivery.recipient.clone();
                    let _ = self.lane.send(key, DeliveryWork { delivery, committed: None }).await;
                }
            }
            Err(err) => {
                tracing::warn!(error = %err.message, "delivery router failed to load pending deliveries on replay");
            }
        }
    }

    async fn enqueue_batch_async(&self, dispatched: ChannelDispatched) {
        for delivery in dispatched.deliveries {
            if self.cancel.is_cancelled() {
                return;
            }
            if !self.should_enqueue_and_prepare(&delivery, Some(&dispatched.committed)).await {
                continue;
            }
            let key = delivery.recipient.clone();
            let _ = self
                .lane
                .send(
                    key,
                    DeliveryWork {
                        delivery,
                        committed: Some(dispatched.committed.clone()),
                    },
                )
                .await;
        }
    }

    pub async fn close_async(&self) {
        self.cancel.cancel();
        self.lane.close();
        let coordinator = self.coordinator.lock().take();
        if let Some(handle) = coordinator {
            let _ = tokio::time::timeout(CLOSE_GRACE, handle).await;
        }
    }
}
