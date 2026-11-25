//! The ledger and its fold (VibeValley `progress.test.ts`, `game.test.ts`).

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use vibevalley_core::game::progress::harvest_coins;
use vibevalley_protocol::{Caller, LedgerEntry, LedgerEntryHarvested, Repo as ProtocolRepo};
use vibevalley_server::context::{Context, Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup};
use vibevalley_server::game::Game;
use vibevalley_server::repo::Repo;
use vibevalley_server::service::Service;
use vibevalley_server::{Config, create_app_blocking};

#[test]
fn a_harvest_pays_by_its_commits_and_the_streak() {
    assert_eq!(harvest_coins(1, 1), 35);
    assert_eq!(harvest_coins(10, 1), 60);
    assert_eq!(harvest_coins(0, 8), 51);
    assert_eq!(harvest_coins(0, 30), 60);
}

#[test]
fn the_ledger_folds_back_through_a_restart_and_skips_what_it_cannot_read() {
    vibevalley_i18n::set_locale("zh");
    let home = tempfile::tempdir().unwrap();
    let before = {
        let app = create_app_blocking(Config {
            probe_runtimes: false,
            orchestrator_listens: false,
            link_previews: false,
            tick_crons: false,
            ..Config::under(home.path())
        })
        .unwrap();
        let game = app.test_internals().game;
        game.record(LedgerEntry::Harvested(LedgerEntryHarvested {
            at: 0,
            session: "w1".into(),
            agent: Some("lab".into()),
            repo: "demo".into(),
            runtime: "pi".into(),
            commits: 1,
            cny: None,
            runs: 1,
        }));
        let p = game.progress();
        assert!(p.coins >= 35);
        assert_eq!(p.counts.get("harvests"), Some(&1));
        game.set_commits(&[ProtocolRepo {
            path: "demo".into(),
            commits: 1000,
        }]);
        let p = crate::support::wait_until_transition(app.ctx(), Duration::from_secs(3), "farm_level updated", || {
            let progress = game.progress();
            (progress.counts.get("farm_level").copied().unwrap_or(0) > 1).then_some(progress)
        });
        assert!(p.counts.get("farm_level").copied().unwrap_or(0) > 1, "{:?}", p.counts);
        let titled = app
            .router()
            .call_as(Caller::User, "game.title.set", json!({ "achievement": "harvests", "tier": 1 }));
        assert!(titled.error.is_none(), "{}", titled.message);
        let list = app.router().call_as(Caller::User, "game.achievement.list", json!(null)).data.unwrap();
        let parsed: vibevalley_protocol::AchievementList = serde_json::from_value(list).unwrap();
        assert!(!parsed.items.is_empty());
        assert!(!parsed.standings.is_empty());
        let saved = game.progress();
        app.close_blocking();
        saved
    };
    let ledger = home.path().join("ledger.jsonl");
    let mut body = std::fs::read_to_string(&ledger).unwrap();
    body.push_str("{\"kind\":\"level\",\"at\":2,\"level\":\"high\"}\nnot json\n");
    std::fs::write(&ledger, body).unwrap();
    let app = create_app_blocking(Config {
        probe_runtimes: false,
        orchestrator_listens: false,
        link_previews: false,
        tick_crons: false,
        ..Config::under(home.path())
    })
    .unwrap();
    assert_eq!(app.test_internals().game.progress(), before);
    app.close_blocking();
}

#[test]
fn the_users_commits_are_counted_once_per_repository() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("a/farm");
    std::fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| {
        let ok = std::process::Command::new("git")
            .current_dir(&repo)
            .args(args)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["config", "user.email", "me@farm.test"]);
    git(&["config", "user.name", "me"]);
    git(&["commit", "-q", "--allow-empty", "-m", "one"]);
    git(&["commit", "-q", "--allow-empty", "-m", "two"]);
    git(&["-c", "user.email=other@farm.test", "commit", "-q", "--allow-empty", "-m", "theirs"]);
    git(&["worktree", "add", "-q", "../farm.1", "-b", "issue-1"]);
    std::fs::create_dir_all(dir.path().join("a/node_modules/x/.git")).unwrap();
    let counted = vibevalley_runtime::rt::block_on(vibevalley_server::repo::contributions_of_async(dir.path().to_path_buf(), vec![]));
    assert_eq!(counted.len(), 1, "{counted:?}");
    assert_eq!(counted[0].commits, 2);
    assert!(counted[0].path.ends_with("farm"), "{}", counted[0].path);
    let with_other = vibevalley_runtime::rt::block_on(vibevalley_server::repo::contributions_of_async(
        dir.path().to_path_buf(),
        vec!["Other@farm.test".into()],
    ));
    assert_eq!(with_other[0].commits, 3);

    vibevalley_runtime::rt::block_on(async {
        let service = Service::open(dir.path()).await.unwrap();
        let ctx = Arc::new(Context::new(
            service.clone(),
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            Arc::new(Outbox::new(service.clone())),
            Arc::new(StateFeed::new()),
            vibevalley_core::system_clock(),
            Arc::new(Http),
            Arc::new(PublicDownload),
        ));
        let repo = Repo::open_async(dir.path(), 2).await.unwrap();
        let game = Game::open_async(dir.path(), ctx.clone(), repo).await;
        game.set_commits(&counted);
        assert_eq!(ctx.live.commits_snapshot().map(|c| c.total), Some(2));
        let _ = ctx.shutdown(Duration::from_secs(1)).await;
        service.close().await;
    });
}
