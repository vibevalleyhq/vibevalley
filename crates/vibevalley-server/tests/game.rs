//! The ledger and its fold (VibeValley `progress.test.ts`, `game.test.ts`).

use serde_json::json;
use vibevalley_core::empty_space_state;
use vibevalley_core::progress::harvest_coins;
use vibevalley_protocol::{Caller, CommitCount, Fact, FactProgressChanged};
use vibevalley_server::Hub;
use vibevalley_server::modules::game::Game;

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
        let hub = Hub::new(empty_space_state());
        let game = Game::open(home.path(), &hub);
        vibevalley_server::modules::game::install(&hub, game.clone());
        game.record(json!({ "kind": "harvested", "session": "w1", "agent": "lab", "repo": "demo", "runtime": "pi", "commits": 1, "runs": 1 }));
        let p = hub.read(|s| s.progress.clone()).unwrap();
        assert!(p.coins >= 35);
        assert_eq!(p.counts.get("harvests"), Some(&1));
        hub.apply(vec![Fact::ProgressChanged(FactProgressChanged {
            at: 1,
            progress: None,
            news: None,
            commits: Some(CommitCount { total: 1000, repos: vec![] }),
            station: None,
        })]);
        let p = hub.read(|s| s.progress.clone()).unwrap();
        assert!(p.counts.get("farm_level").copied().unwrap_or(0) > 1, "{:?}", p.counts);
        let titled = hub.call_as(Caller::User, "game.title.set", json!({ "achievement": "harvests", "tier": 1 }));
        assert!(titled.error.is_none(), "{}", titled.message);
        let list = hub.call_as(Caller::User, "game.achievement.list", json!(null)).data.unwrap();
        assert!(!list.as_array().unwrap().is_empty());
        hub.read(|s| s.progress.clone()).unwrap()
    };
    let ledger = home.path().join("ledger.jsonl");
    let mut body = std::fs::read_to_string(&ledger).unwrap();
    body.push_str("{\"kind\":\"level\",\"at\":2,\"level\":\"high\"}\nnot json\n");
    std::fs::write(&ledger, body).unwrap();
    let hub = Hub::new(empty_space_state());
    let _game = Game::open(home.path(), &hub);
    assert_eq!(hub.read(|s| s.progress.clone()).unwrap(), before);
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
    let counted = vibevalley_server::modules::repo::contributions_of(dir.path(), &[]);
    assert_eq!(counted.len(), 1, "{counted:?}");
    assert_eq!(counted[0].commits, 2);
    assert!(counted[0].path.ends_with("farm"), "{}", counted[0].path);
    let with_other = vibevalley_server::modules::repo::contributions_of(dir.path(), &["Other@farm.test".into()]);
    assert_eq!(with_other[0].commits, 3);

    let hub = Hub::new(empty_space_state());
    let game = Game::open(dir.path(), &hub);
    game.set_commits(&counted);
    assert_eq!(hub.read(|s| s.commits.clone()).map(|c| c.total), Some(2));
}
