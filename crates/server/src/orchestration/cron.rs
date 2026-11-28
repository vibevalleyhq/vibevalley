//! Scheduled cron execution workflow (`orchestration::cron`):
//! orchestrates pure [`CronScheduler`] due triggers across [`Board`], [`Profile`],
//! [`Chat`], [`Orchestrator`], and [`ConnectorWorkflow`].

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use vibevalley_core::SliceMask;
use vibevalley_i18n::t;
use vibevalley_protocol::{ActorKind, ApiError, BizCode, Caller, Cron, CronRequest, CronWhen, IssueMandate, IssueStatus, Millis, NoticeLevel};

use super::connector::ConnectorWorkflow;
use super::cron_digest::{DigestSpec, DigestTargets, format_digest_directive, format_progress_digest, parse_digest_directive, progress_digest_from_morning};
use crate::agent::{Orchestrator, Profile};
use crate::channel::{Chat, Noticing};
use crate::context::{Context, Ticker};
use crate::cron::{DueCron, Scheduler as CronScheduler};
use crate::issue::{Board, NewIssue};

/// How often the server checks whether any schedule is due.
const TICK: Duration = Duration::from_secs(20);
/// Default lookback window for a digest cron on its very first firing (24h).
const DEFAULT_DIGEST_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

/// Request to create a scheduled progress digest cron pushed to connectors.
#[derive(Debug, Clone)]
pub struct DigestCronRequest {
    pub name: String,
    pub note: String,
    pub channel: Option<String>,
    pub when: CronWhen,
    pub tz: Option<String>,
    pub spec: DigestSpec,
}

/// Callback used to deliver a formatted progress digest (production uses
/// [`ConnectorWorkflow::deliver_digest_async`]; unit tests may pass a recorder).
pub type DigestSender = Arc<dyn Fn(String, Millis, DigestTargets, String) -> crate::BoxFuture<'static, Result<usize, ApiError>> + Send + Sync>;

/// Callback used to notify an orchestrator on a non-issue, non-digest cron firing.
pub type OrchestratorTrigger = Arc<dyn Fn(String, String, String, String) -> crate::BoxFuture<'static, bool> + Send + Sync>;

/// Application-layer cron orchestration owning the ticker and cross-domain dispatch.
pub struct CronWorkflow {
    ctx: Arc<Context>,
    scheduler: Arc<CronScheduler>,
    board: Arc<Board>,
    profile: Option<Arc<Profile>>,
    chat: Option<Arc<Chat>>,
    orchestrator_trigger: Option<OrchestratorTrigger>,
    digest_sender: Option<DigestSender>,
    ticker: Mutex<Option<Ticker>>,
}

impl CronWorkflow {
    pub fn new(
        ctx: Arc<Context>,
        scheduler: Arc<CronScheduler>,
        board: Arc<Board>,
        profile: Arc<Profile>,
        chat: Arc<Chat>,
        orchestrator: Option<Arc<Orchestrator>>,
        connector: Arc<ConnectorWorkflow>,
    ) -> Arc<Self> {
        let orchestrator_trigger: Option<OrchestratorTrigger> = orchestrator.map(|orch| {
            Arc::new(move |agent: String, channel: String, cron_id: String, line: String| {
                let orch = orch.clone();
                Box::pin(async move { orch.hear_cron_async(&agent, &channel, &cron_id, &line).await }) as crate::BoxFuture<'static, bool>
            }) as OrchestratorTrigger
        });
        let digest_sender: DigestSender = Arc::new(move |cron_id: String, at: Millis, targets: DigestTargets, text: String| {
            let connector = connector.clone();
            Box::pin(async move { connector.deliver_digest_async(&cron_id, at, targets, &text).await })
        });
        Arc::new(Self {
            ctx,
            scheduler,
            board,
            profile: Some(profile),
            chat: Some(chat),
            orchestrator_trigger,
            digest_sender: Some(digest_sender),
            ticker: Mutex::new(None),
        })
    }

    pub fn scheduler(&self) -> &Arc<CronScheduler> {
        &self.scheduler
    }

    pub async fn add_async(&self, req: CronRequest, by: ActorKind) -> Result<Cron, ApiError> {
        let (channel_id, channel_name, channel_repo) = if let Some(chat) = &self.chat {
            let cid = match req.channel.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                None => chat.default_channel(),
                Some(c) => chat.place_of_async(&crate::channel::local_user_id(), c).await?,
            };
            let found = chat.channels().into_iter().find(|c| c.id == cid).ok_or_else(|| {
                ApiError::new(BizCode::CronRefused, t("server.cron.noChannel", &[("name", cid.as_str().into())]))
                    .with_next(vec![crate::context::error::LookIn::Channel.next()])
            })?;
            (found.id, found.name, found.repo)
        } else {
            (req.channel.clone().unwrap_or_default(), String::new(), String::new())
        };
        let resolved_agent = match req.agent.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            None => None,
            Some(name) => {
                if let Some(profile) = &self.profile {
                    let found = profile.named(name).ok_or_else(|| {
                        ApiError::new(BizCode::CronRefused, t("server.cron.noProfile", &[("name", name.into())]))
                            .with_next(vec![crate::context::error::LookIn::Agent.next()])
                    })?;
                    Some(found.id)
                } else {
                    Some(name.to_string())
                }
            }
        };
        self.scheduler
            .add_resolved_async(req, by, channel_id, channel_name, channel_repo, resolved_agent)
            .await
    }

    pub async fn add_digest_async(&self, req: DigestCronRequest, by: ActorKind) -> Result<Cron, ApiError> {
        let text = format_digest_directive(&req.spec, &req.note);
        self.add_async(
            CronRequest {
                name: req.name,
                text,
                channel: req.channel,
                agent: None,
                repo: None,
                when: req.when,
                tz: req.tz,
            },
            by,
        )
        .await
    }

    pub async fn create_endpoint_async(&self, caller: Caller, req: CronRequest) -> Result<Cron, ApiError> {
        let by = match caller {
            Caller::User | Caller::Remote => ActorKind::User,
            Caller::Orchestrator | Caller::Session => ActorKind::Agent,
        };
        self.add_async(req, by).await
    }

    /// Starts the 20 s cron ticker on `ctx.task`.
    pub fn start_ticker(self: &Arc<Self>, tick: bool) {
        if !tick {
            return;
        }
        let weak = Arc::downgrade(self);
        let ticker = self.ctx.task.every_immediate("cron.tick", TICK, move || {
            let weak = weak.clone();
            async move {
                let Some(wf) = weak.upgrade() else { return false };
                if wf.ctx.task.is_cancelled() || wf.scheduler.is_closed() {
                    return false;
                }
                wf.tick_async().await;
                true
            }
        });
        *self.ticker.lock() = Some(ticker);
    }

    pub async fn close_async(&self) {
        self.scheduler.close_async().await;
        let ticker = self.ticker.lock().take();
        if let Some(ticker) = ticker {
            ticker.stop().await;
        }
    }

    pub async fn tick_async(&self) {
        let due_list = self.scheduler.take_due_async().await;
        for due in due_list {
            if let Err(err) = self.dispatch_due_async(&due).await {
                self.ctx
                    .live
                    .publish_notice(self.ctx.now(), NoticeLevel::Warn, format!("{}: {}", due.cron.name, err.message));
            }
        }
    }

    async fn dispatch_due_async(&self, due: &DueCron) -> Result<(), ApiError> {
        let cron = &due.cron;
        let words = format!("{}\n\n{}", cron.name, cron.text);
        let Some(agent) = &cron.agent else {
            if let Some(spec) = parse_digest_directive(&cron.text) {
                return self.deliver_digest_async(cron, &spec, due.prev_last_run, due.at).await;
            }
            return self.to_orchestrator_async(cron, &words).await;
        };
        let found = match self.scheduler.issue_of_async(&cron.id).await {
            Some(id) => self.board.issue_async(&id).await.map_err(ApiError::from)?,
            None => None,
        };
        let Some(issue) = found else {
            let made = self
                .board
                .create_async(NewIssue {
                    title: cron.name.clone(),
                    description: cron.text.clone(),
                    repo: cron.repo.clone().map(PathBuf::from),
                    agent: agent.clone(),
                    mandate: Some(IssueMandate::explicit(&format!("cron:{}", cron.id), false)),
                    ..Default::default()
                })
                .await
                .map_err(ApiError::from)?;
            self.scheduler.link_issue_async(&cron.id, Some(&made.id)).await?;
            self.ctx.mark_dirty(SliceMask::BOARD | SliceMask::INBOX);
            self.board.move_to_async(&made.id, IssueStatus::Todo, None).await.map_err(ApiError::from)?;
            return Ok(());
        };
        match issue.status {
            IssueStatus::Backlog => {
                self.board.move_to_async(&issue.id, IssueStatus::Todo, None).await.map_err(ApiError::from)?;
            }
            IssueStatus::Todo => {}
            s if s.is_closed() => {
                self.board
                    .move_to_async(&issue.id, IssueStatus::Todo, Some(&words))
                    .await
                    .map_err(ApiError::from)?;
            }
            _ => {
                self.board.tell_async(&issue.id, &words).await.map_err(ApiError::from)?;
            }
        }
        Ok(())
    }

    async fn deliver_digest_async(&self, cron: &Cron, spec: &DigestSpec, prev_last_run: Option<i64>, at: i64) -> Result<(), ApiError> {
        let window_start = prev_last_run.unwrap_or_else(|| at.saturating_sub(DEFAULT_DIGEST_WINDOW_MS));
        let morning = self.board.morning_digest_async(window_start, at).await?;
        let digest = progress_digest_from_morning(&cron.name, &morning);
        if spec.skip_if_empty && digest.is_empty() {
            return Ok(());
        }
        let text = format_progress_digest(&digest);
        if let Some(chat) = self.chat.as_ref() {
            let channel = if chat.place(&cron.channel).is_some() {
                cron.channel.clone()
            } else {
                chat.default_channel()
            };
            chat.notice_async(Noticing {
                channel,
                text: text.clone(),
                code: "cron.digest".into(),
                ..Default::default()
            })
            .await;
        }
        if let Some(sender) = &self.digest_sender {
            sender(cron.id.clone(), at, spec.targets.clone(), text).await?;
        }
        Ok(())
    }

    async fn to_orchestrator_async(&self, cron: &Cron, words: &str) -> Result<(), ApiError> {
        let unserved = || ApiError::new(BizCode::ServiceUnavailable, "no orchestrator takes scheduled tasks".to_string());
        let trigger = self.orchestrator_trigger.as_ref().ok_or_else(unserved)?;
        let channel = if let Some(chat) = self.chat.as_ref() {
            if chat.place(&cron.channel).is_some() {
                cron.channel.clone()
            } else {
                chat.default_channel()
            }
        } else {
            cron.channel.clone()
        };
        if let Some(chat) = self.chat.as_ref() {
            chat.notice_async(Noticing {
                channel: channel.clone(),
                text: words.to_string(),
                code: "cron".into(),
                ..Default::default()
            })
            .await;
        }
        let agent = self.chat.as_ref().map(|chat| chat.orchestrator_in(&channel)).unwrap_or_default();
        if trigger(agent, channel, cron.id.clone(), words.to_string()).await {
            Ok(())
        } else {
            Err(unserved())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use vibevalley_core::{Clock, ManualClock};
    use vibevalley_protocol::{ConnectorID, CronWhenEvery, CronWhenOnce};
    use vibevalley_runtime::oar::Registry;

    use super::*;
    use crate::context::{Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup};
    use crate::runtime::{Runtime, RuntimeConfig, RuntimeDriver};
    use crate::service::Service;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn manual_clock_drives_once_due_execution_and_reenable_timestamps_without_sleep() {
        vibevalley_i18n::set_locale("en");
        let dir = tempfile::tempdir().unwrap();
        let service = Service::open(dir.path()).await.unwrap();
        let clock = Arc::new(ManualClock::new(1_700_000_000_000));
        let outbox = Arc::new(Outbox::new(service.clone()));
        let ctx = Arc::new(Context::new(
            service.clone(),
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            outbox,
            Arc::new(StateFeed::new()),
            clock.clone(),
            Arc::new(Http),
            Arc::new(PublicDownload),
        ));
        let registry = Arc::new(Registry::new());
        let driver = Arc::new(RuntimeDriver {
            registry: registry.clone(),
            model: None,
        });
        let (runtime, opened) = Runtime::open_async(ctx.clone(), driver, RuntimeConfig::under(dir.path())).await.unwrap();
        let board = Board::open_async(ctx.clone(), runtime.clone(), opened, None).await.unwrap();
        let scheduler = CronScheduler::open_async(ctx.clone()).await.unwrap();

        let heard = Arc::new(AtomicUsize::new(0));
        let heard_cb = heard.clone();
        let crons = Arc::new(CronWorkflow {
            ctx: ctx.clone(),
            scheduler: scheduler.clone(),
            board: board.clone(),
            profile: None,
            chat: None,
            orchestrator_trigger: Some(Arc::new(move |_, _, _, _| {
                heard_cb.fetch_add(1, Ordering::SeqCst);
                Box::pin(std::future::ready(true))
            })),
            digest_sender: None,
            ticker: Mutex::new(None),
        });

        let past = crons
            .add_async(
                CronRequest {
                    name: "too late".into(),
                    text: "expired".into(),
                    channel: None,
                    agent: None,
                    repo: None,
                    when: CronWhen::Once(CronWhenOnce { at: clock.now_ms() - 1 }),
                    tz: None,
                },
                ActorKind::User,
            )
            .await;
        assert_eq!(past.unwrap_err().biz_code, BizCode::CronRefused);

        let due_at = clock.now_ms() + 60_000;
        let once = crons
            .add_async(
                CronRequest {
                    name: "standup".into(),
                    text: "post standup notes".into(),
                    channel: None,
                    agent: None,
                    repo: None,
                    when: CronWhen::Once(CronWhenOnce { at: due_at }),
                    tz: None,
                },
                ActorKind::User,
            )
            .await
            .unwrap();
        assert_eq!(once.created, 1_700_000_000_000);
        assert!(once.enabled);

        clock.advance(Duration::from_millis(59_999));
        crons.tick_async().await;
        assert_eq!(heard.load(Ordering::SeqCst), 0);

        clock.advance(Duration::from_millis(1));
        crons.tick_async().await;
        assert_eq!(heard.load(Ordering::SeqCst), 1);
        let after = scheduler.find(&once.id).unwrap();
        assert!(!after.enabled);
        assert_eq!(after.last_run, Some(due_at));

        clock.advance(Duration::from_secs(60));
        crons.tick_async().await;
        assert_eq!(heard.load(Ordering::SeqCst), 1);

        crons.close_async().await;
        board.close_async().await;
        let _ = ctx.shutdown(Duration::from_secs(1)).await;
        service.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn scheduled_digest_cron_summarizes_issues_and_delivers_offline_without_orchestrator() {
        let dir = tempfile::tempdir().unwrap();
        let service = Service::open(dir.path()).await.unwrap();
        let clock = Arc::new(ManualClock::new(vibevalley_core::Clock::now_ms(&vibevalley_core::SystemClock) - 15 * 60 * 1000));
        let outbox = Arc::new(Outbox::new(service.clone()).with_clock(clock.clone()));
        let ctx = Arc::new(Context::new(
            service.clone(),
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            outbox,
            Arc::new(StateFeed::new()),
            clock.clone(),
            Arc::new(Http),
            Arc::new(PublicDownload),
        ));
        let registry = Arc::new(Registry::new());
        let driver = Arc::new(RuntimeDriver { registry, model: None });
        let (runtime, opened) = Runtime::open_async(ctx.clone(), driver, RuntimeConfig::under(dir.path())).await.unwrap();
        let board = Board::open_async(ctx.clone(), runtime, opened, None).await.unwrap();
        let scheduler = CronScheduler::open_async(ctx.clone()).await.unwrap();

        type DigestCall = (String, i64, DigestTargets, String);
        let calls: Arc<Mutex<Vec<DigestCall>>> = Arc::new(Mutex::new(Vec::new()));
        let calls_cb = calls.clone();
        let crons = Arc::new(CronWorkflow {
            ctx: ctx.clone(),
            scheduler: scheduler.clone(),
            board: board.clone(),
            profile: None,
            chat: None,
            orchestrator_trigger: None,
            digest_sender: Some(Arc::new(move |cron_id, at, targets, text| {
                calls_cb.lock().push((cron_id, at, targets, text));
                Box::pin(std::future::ready(Ok(1)))
            })),
            ticker: Mutex::new(None),
        });

        let skip_empty = crons
            .add_digest_async(
                DigestCronRequest {
                    name: "静默简报".into(),
                    note: "有更新再发".into(),
                    channel: None,
                    when: CronWhen::Every(CronWhenEvery { minutes: 10 }),
                    tz: Some("UTC".into()),
                    spec: DigestSpec {
                        targets: DigestTargets::Connectors(vec![ConnectorID::Weixin]),
                        skip_if_empty: true,
                    },
                },
                ActorKind::User,
            )
            .await
            .unwrap();

        let regular = crons
            .add_digest_async(
                DigestCronRequest {
                    name: "每日进展".into(),
                    note: "发到微信".into(),
                    channel: None,
                    when: CronWhen::Every(CronWhenEvery { minutes: 10 }),
                    tz: Some("UTC".into()),
                    spec: DigestSpec {
                        targets: DigestTargets::Connectors(vec![ConnectorID::Weixin]),
                        skip_if_empty: false,
                    },
                },
                ActorKind::User,
            )
            .await
            .unwrap();

        clock.advance(Duration::from_secs(10 * 60));
        crons.tick_async().await;
        let first_body = calls.lock()[0].3.clone();
        assert_eq!(calls.lock().len(), 1);
        assert_eq!(calls.lock()[0].0, regular.id);
        assert!(
            first_body.contains("近期暂无新增进度") || first_body.contains("No new progress recently"),
            "{first_body}"
        );

        let created = board
            .create_async(NewIssue {
                title: "接入微信个人推送".into(),
                description: "完成 iLink 推送".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        board.move_to_async(&created.id, IssueStatus::Done, None).await.unwrap();

        clock.advance(Duration::from_secs(10 * 60));
        crons.tick_async().await;
        let recorded = calls.lock().clone();
        assert_eq!(recorded.len(), 3);
        let ids: Vec<&str> = recorded.iter().skip(1).map(|c| c.0.as_str()).collect();
        assert!(ids.contains(&skip_empty.id.as_str()));
        assert!(ids.contains(&regular.id.as_str()));
        assert!(recorded[1].3.contains("接入微信个人推送"), "{}", recorded[1].3);
        assert!(
            recorded[1].3.contains("近期完成 1") || recorded[1].3.contains("completed 1"),
            "{}",
            recorded[1].3
        );

        crons.close_async().await;
        board.close_async().await;
        let _ = ctx.shutdown(Duration::from_secs(1)).await;
        service.close().await;
    }
}
