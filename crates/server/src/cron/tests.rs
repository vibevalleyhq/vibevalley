use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use vibevalley_core::{Clock, ManualClock};
use vibevalley_protocol::{ActorKind, BizCode, CronRequest, CronWhen, CronWhenOnce};
use vibevalley_runtime::oar::Registry;

use super::Scheduler;
use crate::context::port::{CronAgentPort, CronOrchestratorPort};
use crate::context::{Context, Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup};
use crate::issue::Board;
use crate::runtime::{Runtime, RuntimeConfig, RuntimeDriver};
use crate::service::Service;

struct CountingOrchestrator {
    heard: AtomicUsize,
}

impl CronOrchestratorPort for CountingOrchestrator {
    fn hear_cron<'a>(&'a self, _agent: &'a str, _channel: &'a str, _words: &'a str) -> crate::BoxFuture<'a, bool> {
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
