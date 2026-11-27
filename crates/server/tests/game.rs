//! The ledger and its fold (VibeValley `progress.test.ts`, `game.test.ts`).

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use vibevalley_core::game::daily::local_day;
use vibevalley_core::game::progress::harvest_coins;
use vibevalley_protocol::{Caller, LedgerEntry, LedgerEntryHarvested, Repo as ProtocolRepo, SliceKind};
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

#[test]
fn farm_shop_persists_decorations_and_templates_without_forbidden_boosts() {
    vibevalley_i18n::set_locale("zh");
    let dir = tempfile::tempdir().unwrap();
    let app = create_app_blocking(Config {
        probe_runtimes: false,
        orchestrator_listens: false,
        link_previews: false,
        tick_crons: false,
        ..Config::under(dir.path())
    })
    .unwrap();
    let router = app.router().clone();
    let call = |op: &str, p| router.call_as(Caller::User, op, p);

    assert!(call("repo.create", json!({ "name": "demo" })).data.is_some());

    let listed = call("game.shop.list", json!(null)).data.expect("game.shop.list");
    assert_eq!(listed["coins"], 0);
    let items = listed["items"].as_array().unwrap();
    assert!(!items.is_empty());
    assert!(
        items.iter().all(|item| matches!(item["kind"].as_str(), Some("decoration" | "template"))),
        "shop must only sell yard decorations and issue templates: {listed}"
    );

    let poor = call("game.shop.buy", json!({ "id": "deco_stone_lantern" }));
    assert_eq!(poor.biz_code, vibevalley_protocol::BizCode::Refused.code(), "{poor:?}");

    let missing = call("game.shop.buy", json!({ "id": "nonexistent_boost" }));
    assert_eq!(missing.biz_code, vibevalley_protocol::BizCode::NotFound.code(), "{missing:?}");

    let game = app.test_internals().game;
    game.record(LedgerEntry::Harvested(LedgerEntryHarvested {
        at: 0,
        session: "h1".into(),
        agent: Some("lab".into()),
        repo: "demo".into(),
        runtime: "scripted".into(),
        commits: 10,
        cny: None,
        runs: 1,
    }));
    game.record(LedgerEntry::Harvested(LedgerEntryHarvested {
        at: 0,
        session: "h2".into(),
        agent: Some("lab".into()),
        repo: "demo".into(),
        runtime: "scripted".into(),
        commits: 10,
        cny: None,
        runs: 1,
    }));
    let before_coins = game.progress().coins;
    assert!(before_coins >= 85, "expected enough coins to buy lantern and template, got {before_coins}");

    let bought_deco = call("game.shop.buy", json!({ "id": "deco_stone_lantern" })).data.expect("buy lantern");
    assert_eq!(bought_deco["coins"], before_coins - 40);
    assert!(
        bought_deco["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["id"] == "deco_stone_lantern" && i["owned"] == true)
    );

    let dup = call("game.shop.buy", json!({ "id": "deco_stone_lantern" }));
    assert_eq!(dup.biz_code, vibevalley_protocol::BizCode::Refused.code(), "{dup:?}");

    let bought_tmpl = call("game.shop.buy", json!({ "id": "tmpl_regression_guard" })).data.expect("buy template");
    assert_eq!(bought_tmpl["coins"], before_coins - 85);

    let templates = call("repo.template.list", json!({ "id": "demo" })).data.expect("repo.template.list");
    let purchased_kind = templates["kinds"]
        .as_array()
        .unwrap()
        .iter()
        .find(|k| k["id"] == "purchased")
        .expect("purchased template kind missing");
    assert!(
        purchased_kind["templates"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == "tmpl_regression_guard"),
        "{purchased_kind}"
    );

    let farm_json = crate::support::wait_until_transition(app.ctx(), Duration::from_secs(3), "farm slice updated with decoration", || {
        let val: serde_json::Value = serde_json::from_str(&app.ctx().feed.snapshot_json(SliceKind::Farm)).ok()?;
        val["view"]["decorations"]
            .as_array()?
            .iter()
            .any(|d| d["id"] == "deco_stone_lantern" && d["asset"] == "p_lantern")
            .then_some(val)
    });
    assert!(
        farm_json["view"]["decorations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["id"] == "deco_stone_lantern" && d["asset"] == "p_lantern"),
        "unlocked decoration must appear in FarmView.decorations: {farm_json}"
    );

    let expected_progress = game.progress();
    app.close_blocking();

    let restarted = create_app_blocking(Config {
        probe_runtimes: false,
        orchestrator_listens: false,
        link_previews: false,
        tick_crons: false,
        ..Config::under(dir.path())
    })
    .unwrap();
    let replayed = restarted.test_internals().game.progress();
    assert_eq!(replayed.coins, expected_progress.coins);
    assert_eq!(replayed.purchased, expected_progress.purchased);
    let after_templates = restarted
        .router()
        .call_as(Caller::User, "repo.template.list", json!({ "id": "demo" }))
        .data
        .unwrap();
    assert!(after_templates["kinds"].as_array().unwrap().iter().any(|k| k["id"] == "purchased"));
    restarted.close_blocking();
}

#[test]
fn daily_tasks_track_quality_metrics_dedup_churn_and_auto_settle_into_ledger() {
    vibevalley_i18n::set_locale("en");
    let dir = tempfile::tempdir().unwrap();
    let app = create_app_blocking(Config {
        probe_runtimes: false,
        orchestrator_listens: false,
        link_previews: false,
        tick_crons: false,
        ..Config::under(dir.path())
    })
    .unwrap();
    let router = app.router().clone();
    let call = |op: &str, p| router.call_as(Caller::User, op, p);

    assert!(call("repo.create", json!({ "name": "demo" })).data.is_some());
    let issue = call("issue.create", json!({ "title": "Harden edge case", "repo": "demo", "deliver": "answer" }))
        .data
        .expect("issue.create");
    let issue_id = issue["id"].as_str().unwrap().to_string();

    let today = local_day(app.ctx().now());
    let initial = call("game.daily.list", json!(null)).data.expect("game.daily.list");
    assert_eq!(initial["day"], today);
    assert_eq!(initial["tasks"].as_array().unwrap().len(), 3);
    assert_eq!(initial["settledCoinsToday"], 0);
    assert_eq!(app.test_internals().game.progress().coins, 0);

    // Trigger normal quality/delivery events; repeat calls for the same issue must deduplicate.
    let game = app.test_internals().game;
    game.on_issue_check_passed("check:1");
    game.on_issue_check_passed("check:1");
    assert!(call("issue.status.update", json!({ "id": issue_id, "status": "in_review" })).data.is_some());
    let first_rev = call("issue.review", json!({ "id": issue_id, "pass": true, "text": "looks clean" }));
    let reviewed: vibevalley_protocol::Issue = serde_json::from_value(first_rev.data.unwrap_or_else(|| panic!("first review failed"))).unwrap();
    if reviewed.status != vibevalley_protocol::IssueStatus::Done {
        let done = call("issue.status.update", json!({ "id": issue_id, "status": "done" }));
        assert!(done.data.is_some(), "status done failed: {done:?}");
    }
    // Repeating review/delivery events on the same issue/day must deduplicate and never double-settle.
    game.on_issue_reviewed(&reviewed, true);
    game.on_issue_delivered(&reviewed, std::slice::from_ref(&reviewed));

    let after = call("game.daily.list", json!(null)).data.expect("game.daily.list after work");
    let tasks = after["tasks"].as_array().unwrap();
    let expected_reward: i64 = tasks.iter().map(|t| t["rewardCoins"].as_i64().unwrap()).sum();
    assert!(expected_reward > 0);
    assert!(
        tasks.iter().all(|t| t["completed"] == true && t["settled"] == true),
        "all 3 daily tasks should complete and auto-settle: {after}"
    );
    assert_eq!(after["settledCoinsToday"], expected_reward);
    let coins_after = game.progress().coins;
    assert_eq!(coins_after, expected_reward, "churn must not settle any task twice");

    app.close_blocking();

    let ledger_body = std::fs::read_to_string(dir.path().join("ledger.jsonl")).unwrap();
    let settled_lines = ledger_body.lines().filter(|l| l.contains("\"dailySettled\"")).count();
    assert_eq!(settled_lines, 3, "expected exactly 3 dailySettled ledger entries: {ledger_body}");

    // Restart replays exact settled coins and daily board without double-settling.
    let restarted = create_app_blocking(Config {
        probe_runtimes: false,
        orchestrator_listens: false,
        link_previews: false,
        tick_crons: false,
        ..Config::under(dir.path())
    })
    .unwrap();
    let replayed_coins = restarted.test_internals().game.progress().coins;
    assert_eq!(replayed_coins, coins_after);
    restarted.close_blocking();
}
