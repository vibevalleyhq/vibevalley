//! Bootstrap wiring helpers invoked by [`crate::app::create_app`]: runtime
//! registry assembly, lazy cron orchestrator binding, outbox registration, and
//! cross-domain event bridges (chat→note and runtime/chat→farm skin).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use tokio::sync::broadcast;
use vibevalley_protocol::{ChatMessage, Phase};
use vibevalley_runtime::agent::ModelClient;
use vibevalley_runtime::agent::harness::SharedExecution;
use vibevalley_runtime::agent::runtime::VibeValleyRuntime;
use vibevalley_runtime::oar::Registry;

use crate::agent::{Agent, Profile};
use crate::channel::{ChannelMessageEvent, Chat};
use crate::config::{Config, StartError, StartErrorKind, failed};
use crate::connector::{Connector, Options as ConnectorOptions};
use crate::context::api::BoxFuture;
use crate::context::port::CronOrchestratorPort;
use crate::context::{Context, Fetch, Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup};
use crate::cron::Scheduler as CronScheduler;
use crate::game::Game;
use crate::issue::{Board, IssueChat, Publisher, SessionChat};
use crate::runtime::{OUTBOX_SESSION_REPORTED, OutboxSessionReported, Runtime, SessionLifecycleEvent};
use crate::service::{DbError, Service};
use crate::setting::Setting;
use crate::voice::moss::{Realtime, Transcriber};

/// Domain-level test and embedding overrides supplied at server composition time.
#[derive(Clone, Default)]
pub struct Overrides {
    /// Optional hosted-branch publisher override (offline tests).
    pub publisher: Option<Arc<Publisher>>,
    /// External chat app connector configuration override.
    pub connector: Option<ConnectorOptions>,
    /// Optional MOSS realtime probe override for offline voice tests.
    pub voice_realtime: Option<Arc<dyn Realtime>>,
    /// Optional MOSS transcription override for offline voice tests.
    pub voice_transcriber: Option<Arc<dyn Transcriber>>,
}

pub(crate) fn apply_env_overrides(config: &mut Config) {
    if config.registry.is_none() && config.model_client.is_none() && std::env::var("VIBEVALLEY_TEST_RUNTIMES").ok().as_deref() == Some("1") {
        let port = std::env::var("VIBEVALLEY_TEST_MODEL_PORT").ok().filter(|v| !v.is_empty());
        crate::fake::runtime::configure(config, port.as_deref());
    }
}

fn start_error_from_db(err: DbError, fallback_path: Option<PathBuf>) -> StartError {
    let (kind, message, detail, db_path) = match err.schema_mismatch() {
        Some(r) => (
            StartErrorKind::DatabaseSchema,
            format!("the database: {r}"),
            Some(r.format_detail()),
            r.db_path.clone().or(fallback_path),
        ),
        None => (StartErrorKind::Database, format!("the database: {err}"), None, fallback_path),
    };
    StartError {
        kind,
        message,
        detail,
        db_path,
    }
}

pub(crate) async fn open_service(config: &Config) -> Result<Arc<Service>, StartError> {
    tokio::fs::create_dir_all(&config.home).await.map_err(|e| failed("the home")(&e))?;
    for dir in [config.work_root.clone(), config.work_root.join("repos"), config.work_root.join("worktrees")] {
        tokio::fs::create_dir_all(&dir).await.map_err(|e| failed("the work root")(&e))?;
    }
    match config.database_url.as_deref() {
        Some(url) => Box::pin(Service::open_url(url)).await.map_err(|e| start_error_from_db(e, None)),
        None => Box::pin(Service::open(&config.home))
            .await
            .map_err(|e| start_error_from_db(e, Some(config.home.join("server.db")))),
    }
}

/// Opens the database service and assembles [`Context`].
pub(crate) async fn open_context(config: &Config) -> Result<Arc<Context>, StartError> {
    let service = open_service(config).await?;
    let (http, download): (Arc<dyn Fetch>, Arc<dyn Fetch>) = match &config.media_network {
        Some(network) => network.clone(),
        None if config.offline_media => crate::fake::moss::network(),
        None => (Arc::new(Http), Arc::new(PublicDownload)),
    };
    let outbox = Arc::new(Outbox::new(service.clone()).with_clock(config.clock.clone()));
    Ok(Arc::new(Context::new(
        service,
        TaskGroup::new(),
        Arc::new(LiveState::new()),
        outbox,
        Arc::new(StateFeed::new()),
        config.clock.clone(),
        http,
        download,
    )))
}

/// Seeds the 3 starter guide issues once on a fresh real-server database.
/// Skipped for test and scripted boots (`probe_runtimes == false` or injected fakes).
pub(crate) async fn seed_starter_issues_on_boot(config: &Config, setting: &Setting, board: &Board) {
    if !config.probe_runtimes || config.registry.is_some() || config.model_client.is_some() || config.media_network.is_some() || config.offline_media {
        return;
    }
    let locale = setting.status().locale;
    if let Err(e) = board.seed_starter_issues_if_fresh_async(locale).await {
        eprintln!("vibevalley-server: issue: seeding starter issues: {e}");
    }
}

pub(crate) fn build_runtimes(setting: &Arc<Setting>, home: &std::path::Path, execution: SharedExecution, model: Option<Arc<dyn ModelClient>>) -> Registry {
    let mut registry = Registry::new();
    for r in vibevalley_runtime::oar::default_runtimes().list() {
        if r.id() != vibevalley_runtime::agent::runtime::ID && r.id() != "scripted" {
            registry.register(r.clone());
        }
    }
    let s = setting.clone();
    let builtin =
        VibeValleyRuntime::new(Arc::new(move || s.deepseek_api_key()), home.join("conversations")).with_execution(Arc::new(OnceLock::from(execution)));
    registry.register(Arc::new(match model {
        Some(model) => builtin.with_client(model),
        None => builtin,
    }));
    registry
}

pub(crate) struct LazyCronOrchestrator(pub Arc<OnceLock<Arc<dyn CronOrchestratorPort>>>);

impl CronOrchestratorPort for LazyCronOrchestrator {
    fn hear_cron<'a>(&'a self, agent: &'a str, channel: &'a str, cron_id: &'a str, line: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            match self.0.get() {
                Some(o) => o.hear_cron(agent, channel, cron_id, line).await,
                None => false,
            }
        })
    }
}

pub(crate) async fn seat_orchestrators_and_watch(ctx: &Context, profile: &Arc<Profile>, channel: &Arc<Chat>) {
    for orch in profile.orchestrators() {
        if let Err(e) = channel.seat_orchestrator_async(&orch).await {
            eprintln!("vibevalley-server: chat: seating {}: {}", orch.id, e.message);
        }
    }
    let (c_w, p_w, ctx_seat) = (Arc::downgrade(channel), Arc::downgrade(profile), ctx.clone());
    profile.store.when_kept(Arc::new(move |agent| {
        if let (Some(c), Some(p)) = (c_w.upgrade(), p_w.upgrade())
            && p.is_orchestrator(&agent.id)
        {
            let agent = agent.clone();
            ctx_seat.spawn("channel.seat_orchestrator", async move {
                if let Err(e) = c.seat_orchestrator_async(&agent).await {
                    eprintln!("vibevalley-server: chat: seating {}: {}", agent.id, e.message);
                }
            });
        }
        Ok(())
    }));
}

pub(crate) fn spawn_chat_note_bridge(ctx: &Context, channel: &Chat) -> broadcast::Receiver<ChatMessage> {
    let (chat_msg_tx, chat_msg_rx) = broadcast::channel(256);
    let mut msg_events = channel.subscribe_message_events();
    let cancel = ctx.task.child_token();
    ctx.spawn("note.chat_messages", async move {
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return,
                res = msg_events.recv() => match res {
                    Ok(ChannelMessageEvent::Posted { message, .. } | ChannelMessageEvent::Edited(message)) => {
                        let _ = chat_msg_tx.send(message);
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        }
    });
    chat_msg_rx
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn register_session_reported_outbox(
    ctx: &Context,
    issue_chat: &Arc<IssueChat>,
    session_chat: &Arc<SessionChat>,
    agent: &Arc<Agent>,
    game: &Arc<Game>,
    runtime: &Arc<Runtime>,
    connector: &Arc<Connector>,
    cron: &Arc<CronScheduler>,
) {
    cron.set_digest_delivery(connector.clone());
    let (ic, sc, ag, g, rt, conn) = (
        Arc::downgrade(issue_chat),
        Arc::downgrade(session_chat),
        Arc::downgrade(agent),
        Arc::downgrade(game),
        Arc::downgrade(runtime),
        Arc::downgrade(connector),
    );
    ctx.outbox.register(OUTBOX_SESSION_REPORTED, move |delivery| {
        let (ic, sc, ag, g, rt, conn) = (ic.clone(), sc.clone(), ag.clone(), g.clone(), rt.clone(), conn.clone());
        async move {
            let report: OutboxSessionReported = delivery.decode().map_err(|e| format!("invalid {OUTBOX_SESSION_REPORTED} payload: {e}"))?;
            if let Some(ic) = ic.upgrade() {
                ic.handle_report_async(&report).await.map_err(|e| e.message)?;
            }
            if let Some(sc) = sc.upgrade() {
                sc.handle_report_async(&report).await;
            }
            if let Some(rt) = rt.upgrade()
                && let Some(reported) = rt.session_async(&report.id).await
            {
                if let Some(ag) = ag.upgrade() {
                    ag.memory.keep_session_reported_async(&reported).await;
                    ag.profile
                        .fleet
                        .on_session_reported(&reported.runtime, report.spent.as_ref().and_then(|s| s.cny).map(|n| n.0));
                }
                if let Some(g) = g.upgrade() {
                    g.record_session_report_async(&reported, report.outcome).await;
                }
            }
            if let Some(conn) = conn.upgrade() {
                conn.on_session_reported_async(&report).await;
            }
            Ok::<(), String>(())
        }
    });
}

fn index_sessions(sessions: Vec<vibevalley_protocol::Session>, known: &mut HashMap<String, vibevalley_protocol::Session>, working: &mut HashSet<String>) {
    known.clear();
    working.clear();
    for s in sessions {
        if s.phase.is_working() {
            working.insert(s.id.clone());
        }
        known.insert(s.id.clone(), s);
    }
}

pub(crate) async fn spawn_skin_event_bridge(ctx: &Context, game: &Arc<Game>, runtime: &Arc<Runtime>, channel: &Arc<Chat>) {
    let (mut session_rx, mut doing_rx, mut message_rx) = (runtime.subscribe_events(), runtime.subscribe_doing(), channel.subscribe_message_events());
    let initial_sessions = runtime.list_async().await;
    game.seed_sessions(&initial_sessions);
    let (game, runtime_ref, cancel) = (Arc::downgrade(game), Arc::downgrade(runtime), ctx.task.child_token());

    ctx.spawn("game.event_bridge", async move {
        let (mut known_sessions, mut was_working) = (HashMap::new(), HashSet::new());
        index_sessions(initial_sessions, &mut known_sessions, &mut was_working);
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return,
                ev = session_rx.recv() => match ev {
                    Ok(SessionLifecycleEvent::Changed(session)) => {
                        let Some(g) = game.upgrade() else { return };
                        let others: Vec<&vibevalley_protocol::Session> = known_sessions.values().filter(|s| s.id != session.id).collect();
                        if known_sessions.contains_key(&session.id) { g.on_session_changed(&session, &others); } else { g.on_session_hired(&session, &others); }
                        match &session.phase {
                            Phase::Working(w) => {
                                g.on_session_working(&session, was_working.contains(&session.id), &w.doing);
                                was_working.insert(session.id.clone());
                            }
                            Phase::Done(_) | Phase::Failed(_) | Phase::Resting(_) | Phase::Closed(_) => { was_working.remove(&session.id); }
                        }
                        known_sessions.insert(session.id.clone(), *session);
                    }
                    Ok(SessionLifecycleEvent::Left { id, closed, merged_commits, .. }) => {
                        was_working.remove(&id);
                        if let Some(g) = game.upgrade() {
                            if let Some(removed) = known_sessions.remove(&id) { g.on_session_left(&removed, closed, merged_commits); } else { g.remove_play(&id); }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => if let Some(rt) = runtime_ref.upgrade() {
                        let current = rt.list_async().await;
                        if let Some(g) = game.upgrade() { g.seed_sessions(&current); }
                        index_sessions(current, &mut known_sessions, &mut was_working);
                    },
                    Err(broadcast::error::RecvError::Closed) => return,
                },
                ev = doing_rx.recv() => match ev {
                    Ok((id, at, doing)) => if let (Some(g), Some(s)) = (game.upgrade(), known_sessions.get(&id)) { g.on_session_doing(s, at, &doing); },
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return,
                },
                ev = message_rx.recv() => match ev {
                    Ok(ChannelMessageEvent::Posted { message, thread_issue_id, answers }) => {
                        let Some(g) = game.upgrade() else { return };
                        let thread_worker = thread_issue_id.as_deref().and_then(|iid| known_sessions.values().find(|s| s.is_board_worker() && s.issue_id() == Some(iid)).map(|s| s.id.as_str()));
                        let mentioned: Vec<String> = message.mentions.iter().filter(|m| known_sessions.contains_key(m.as_str())).cloned().collect();
                        g.on_message_posted(&message.actor, thread_worker, &mentioned, answers.is_some());
                    }
                    Ok(ChannelMessageEvent::Edited(_)) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use vibevalley_protocol::{
        ContextRef, DeliveryEvidence, ExecutionPolicy, Issue, ProjectCheckReceipt, ProjectCheckStatus, Session, SessionClose, SessionController,
    };

    use super::*;
    use crate::context::{Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup};
    use crate::repo::Repo;
    use crate::runtime::{Leave, RuntimeConfig};
    use crate::service::Service;
    use crate::storage::Storage;

    #[tokio::test]
    async fn skin_event_bridge_records_harvested_when_integrated_session_leaves_game() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let work_root = dir.path().join("work");
        let repos_dir = work_root.join("repos");
        let worktrees_dir = work_root.join("worktrees");
        tokio::fs::create_dir_all(&home).await.unwrap();
        tokio::fs::create_dir_all(&repos_dir).await.unwrap();
        tokio::fs::create_dir_all(&worktrees_dir).await.unwrap();

        // Build a real git repository with two commits on the issue branch merged into `main`.
        let main_dir = repos_dir.join("demo");
        let main_repo = vibevalley_git::init_async(&main_dir, Some("main")).await.unwrap();
        main_repo
            .run_async(&[
                "-c",
                "user.name=tester",
                "-c",
                "user.email=tester@example.com",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "initial",
            ])
            .await
            .unwrap();
        let target_commit = main_repo.commit_id_async("HEAD").await.unwrap();

        let branch = "vibevalley/issue-1";
        let wt_dir = worktrees_dir.join("demo.1");
        let wt = main_repo.worktree_add_async(&wt_dir, branch, Some("main")).await.unwrap();
        for n in 1..=2 {
            tokio::fs::write(wt_dir.join(format!("f{n}.txt")), format!("content {n}\n")).await.unwrap();
            wt.run_async(&["add", "."]).await.unwrap();
            wt.run_async(&[
                "-c",
                "user.name=tester",
                "-c",
                "user.email=tester@example.com",
                "commit",
                "-q",
                "-m",
                &format!("commit {n}"),
            ])
            .await
            .unwrap();
        }
        let source_tree = main_repo.tree_id_async(branch).await.unwrap();
        let candidate_commit = main_repo.merge_async(branch, Some("Merge issue #1")).await.unwrap();
        let candidate_tree = main_repo.tree_id_async(&candidate_commit).await.unwrap();

        let service = Service::open(&home).await.unwrap();
        let outbox = Arc::new(Outbox::new(service.clone()));
        let ctx = Arc::new(Context::new(
            service.clone(),
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            outbox,
            Arc::new(StateFeed::new()),
            vibevalley_core::system_clock(),
            Arc::new(Http),
            Arc::new(PublicDownload),
        ));
        let storage = Storage::open_async(&home, ctx.clone()).await.unwrap();
        let channel = Chat::open_async(ctx.clone(), storage, false).await.unwrap();
        let repo = Repo::open_async(&work_root, 2).await.unwrap();
        let cfg = RuntimeConfig {
            worktrees_dir: worktrees_dir.clone(),
            data_dir: home.join("issues"),
            repos_dir: Some(repos_dir.clone()),
            ..RuntimeConfig::under(&home)
        };
        let (runtime, _) = Runtime::open_with_registry_async(ctx.clone(), Arc::new(Registry::new()), cfg).await.unwrap();
        let game = Game::open_async(&home, ctx.clone(), repo).await;

        // Seed issue with its persisted delivery receipt and a hired worker session.
        let mut issue = Issue::new("i1", 1, "Ship harvest", 10);
        issue.repo = Some("demo".into());
        issue.delivery_evidence = Some(DeliveryEvidence {
            check: Some(ProjectCheckReceipt {
                target_branch: "main".into(),
                target_commit,
                source_tree,
                candidate_commit,
                candidate_tree,
                status: ProjectCheckStatus::NotConfigured,
                command: None,
                output: None,
            }),
            ..Default::default()
        });
        ctx.service.issue.put(&issue).await.unwrap();

        let mut worker = Session::new(
            "w1",
            SessionController::IssueBoard,
            "worker-w1",
            "scripted",
            ExecutionPolicy::ManagedWorktree {
                repo: "demo".into(),
                branch: Some(branch.into()),
            },
            10,
        );
        worker.profile = Some("backend".into());
        worker.cwd = Some(wt_dir.to_string_lossy().into_owned());
        worker.attach_binding(ContextRef::Issue {
            id: "i1".into(),
            refining: None,
        });
        ctx.service.session.put(&worker, false).await.unwrap();

        // Start the real skin event bridge, subscribe to verify the lifecycle event, and dismiss with `Leave::Integrated`.
        spawn_skin_event_bridge(&ctx, &game, &runtime, &channel).await;
        let mut events = runtime.subscribe_events();
        assert!(game.plays_snapshot().contains_key("w1"));

        runtime.session_engine().dismiss_async("w1", Leave::Integrated).await.unwrap();

        let left = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .expect("timed out waiting for SessionLifecycleEvent::Left")
            .unwrap();
        assert!(
            matches!(
                left,
                SessionLifecycleEvent::Left {
                    ref id,
                    closed: Some(SessionClose::Merged),
                    merged_commits: Some(2),
                    ..
                } if id == "w1"
            ),
            "expected Merged with 2 commits, got {left:?}"
        );

        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while game.progress().counts.get("harvests") != Some(&1) && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let progress = game.progress();
        assert_eq!(progress.counts.get("harvests"), Some(&1));
        assert_eq!(progress.streak, 1);
        assert!(progress.coins >= vibevalley_core::game::progress::harvest_coins(2, 1));
        assert!(!game.plays_snapshot().contains_key("w1"));

        game.close_async().await;
        runtime.close_async().await;
        let _ = ctx.shutdown(Duration::from_secs(2)).await;
        ctx.service.close().await;
    }
}
