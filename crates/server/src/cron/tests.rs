use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use vibevalley_core::{Clock, ManualClock};
use vibevalley_protocol::{ActorKind, BizCode, ConnectorID, CronRequest, CronWhen, CronWhenEvery, CronWhenOnce, IssueStatus};
use vibevalley_runtime::oar::Registry;

use super::digest::DigestSpec;
use super::{DigestCronRequest, DigestDeliveryPort, Scheduler};
use crate::context::port::{CronAgentPort, CronOrchestratorPort, DigestTargets};
use crate::context::{Context, Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup};
use crate::issue::{Board, NewIssue};
use crate::runtime::{Runtime, RuntimeConfig, RuntimeDriver};
use crate::service::Service;

struct CountingOrchestrator {
    heard: AtomicUsize,
}

impl CronOrchestratorPort for CountingOrchestrator {
    fn hear_cron<'a>(&'a self, _agent: &'a str, _channel: &'a str, _cron_id: &'a str, _words: &'a str) -> crate::BoxFuture<'a, bool> {
        self.heard.fetch_add(1, Ordering::SeqCst);
        Box::pin(std::future::ready(true))
    }
}

struct EmptyAgents;

impl CronAgentPort for EmptyAgents {
    fn resolve_agent_id(&self, _named: &str) -> Option<String> {
        None
    }
}

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
    let board = Board::open_async(ctx.clone(), runtime.clone(), opened, None, None).await.unwrap();

    let orchestrator = Arc::new(CountingOrchestrator { heard: AtomicUsize::new(0) });
    let crons = Scheduler::open_async(ctx.clone(), board.clone(), Arc::new(EmptyAgents), None, Some(orchestrator.clone()))
        .await
        .unwrap();

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

    // Before the deadline, tick does not fire.
    clock.advance(Duration::from_millis(59_999));
    crons.tick_async().await;
    assert_eq!(orchestrator.heard.load(Ordering::SeqCst), 0);

    // At the deadline, tick fires exactly once and disables the one-shot cron.
    clock.advance(Duration::from_millis(1));
    crons.tick_async().await;
    assert_eq!(orchestrator.heard.load(Ordering::SeqCst), 1);
    let after = crons.find(&once.id).unwrap();
    assert!(!after.enabled);
    assert_eq!(after.last_run, Some(due_at));

    // Subsequent ticks do not re-fire.
    clock.advance(Duration::from_secs(60));
    crons.tick_async().await;
    assert_eq!(orchestrator.heard.load(Ordering::SeqCst), 1);

    crons.close_async().await;
    board.close_async().await;
    let _ = ctx.shutdown(Duration::from_secs(1)).await;
    service.close().await;
}

#[derive(Default)]
struct RecordingDigestDelivery {
    calls: Mutex<Vec<(String, i64, DigestTargets, String)>>,
}

impl DigestDeliveryPort for RecordingDigestDelivery {
    fn deliver_digest_async<'a>(
        &'a self,
        cron_id: &'a str,
        at: i64,
        targets: DigestTargets,
        text: &'a str,
    ) -> crate::BoxFuture<'a, Result<usize, vibevalley_protocol::ApiError>> {
        self.calls.lock().push((cron_id.to_owned(), at, targets, text.to_owned()));
        Box::pin(std::future::ready(Ok(1)))
    }
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
    let board = Board::open_async(ctx.clone(), runtime, opened, None, None).await.unwrap();

    // No orchestrator bound: digest crons still run offline and deliver to DigestDeliveryPort!
    let crons = Scheduler::open_async(ctx.clone(), board.clone(), Arc::new(EmptyAgents), None, None)
        .await
        .unwrap();
    let delivery = Arc::new(RecordingDigestDelivery::default());
    crons.set_digest_delivery(delivery.clone());

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
    // Only the non-skip-empty digest delivers when nothing happened.
    let first_body = delivery.calls.lock()[0].3.clone();
    assert_eq!(delivery.calls.lock().len(), 1);
    assert_eq!(delivery.calls.lock()[0].0, regular.id);
    assert!(
        first_body.contains("近期暂无新增进度") || first_body.contains("No new progress recently"),
        "{first_body}"
    );

    // Create & close an issue in the next 10-minute window -> both digests fire!
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
    let calls = delivery.calls.lock().clone();
    assert_eq!(calls.len(), 3);
    let ids: Vec<&str> = calls.iter().skip(1).map(|c| c.0.as_str()).collect();
    assert!(ids.contains(&skip_empty.id.as_str()));
    assert!(ids.contains(&regular.id.as_str()));
    assert!(calls[1].3.contains("接入微信个人推送"), "{}", calls[1].3);
    assert!(calls[1].3.contains("近期完成 1") || calls[1].3.contains("completed 1"), "{}", calls[1].3);

    crons.close_async().await;
    board.close_async().await;
    let _ = ctx.shutdown(Duration::from_secs(1)).await;
    service.close().await;
}
