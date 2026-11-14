//! The command line run as a program against a whole farm on a home of its own.

use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

use serde_json::Value;

/// A farm listening on a free port, with the pages' stand-in helper (`pi`) and the built-in profiles.
struct Farm {
    url: String,
    dir: tempfile::TempDir,
    started: Option<vibevalley_server::Started>,
    _listener: vibevalley_http::Listener,
}

impl Drop for Farm {
    fn drop(&mut self) {
        if let Some(s) = self.started.take() {
            s.close();
        }
    }
}

fn farm() -> Farm {
    let dir = tempfile::tempdir().unwrap();
    let mut registry = vibevalley_oar::Registry::new();
    registry.register(vibevalley_server::testing::helper());
    let starters = [
        "backend",
        "tester",
        "frontend",
        "docs",
        "scout",
        "night",
        "claude",
        "codex",
        "lab",
        "slides",
        "collector",
        "pages",
        "reviewer",
    ];
    let work = dir.path().join("work");
    for d in ["repos", "worktrees", "pkm"] {
        std::fs::create_dir_all(work.join(d)).unwrap();
    }
    let started = vibevalley_server::start(vibevalley_server::ServerConfig {
        registry: Some(Arc::new(registry)),
        starters: starters.iter().map(|s| s.to_string()).collect(),
        work_root: work,
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        orchestrator_listens: false,
        watch_pkm: false,
        offline_media: true,
        ..vibevalley_server::ServerConfig::under(dir.path().join("home"))
    })
    .unwrap();
    let listener = vibevalley_http::serve_with(started.hub.clone(), "127.0.0.1:0".parse().unwrap(), None).unwrap();
    let url = listener.url();
    started.board.set_mcp_url(format!("{url}/mcp"));
    Farm {
        url,
        dir,
        started: Some(started),
        _listener: listener,
    }
}

struct Ran {
    code: i32,
    out: String,
    failure: Option<Value>,
}

impl Ran {
    fn tag(&self) -> &str {
        self.failure.as_ref().and_then(|f| f["error"]["tag"].as_str()).unwrap_or("")
    }
}

/// `vibevalley <args>` on a home of its own (so this machine's server and language do not leak in).
fn cli(home: &std::path::Path, args: &[&str], env: &[(&str, &str)]) -> Ran {
    let out = Command::new(env!("CARGO_BIN_EXE_vibevalley"))
        .args(args)
        .env("VIBEVALLEY_HOME", home)
        .env_remove("VIBEVALLEY_SERVER")
        .envs(env.iter().copied())
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    Ran {
        code: out.status.code().unwrap_or(-1),
        out: String::from_utf8_lossy(&out.stdout).trim_end().to_string(),
        failure: stderr.lines().last().and_then(|l| serde_json::from_str(l).ok()),
    }
}

impl Farm {
    fn home(&self) -> PathBuf {
        self.dir.path().join("cli")
    }

    fn run(&self, args: &[&str]) -> Ran {
        let mut all = args.to_vec();
        all.extend(["--server", &self.url]);
        cli(&self.home(), &all, &[])
    }
}

const COMMANDS: &[&str] = &[
    "agent create",
    "agent delete",
    "agent list",
    "artifact list",
    "artifact read",
    "artifact show",
    "channel list",
    "channel message list",
    "channel message search",
    "channel message send",
    "cron create",
    "cron delete",
    "cron edit",
    "cron list",
    "doctor",
    "issue comment",
    "issue create",
    "issue delete",
    "issue diff",
    "issue edit",
    "issue list",
    "issue review",
    "issue show",
    "issue status",
    "issue timeline",
    "issue watch",
    "memory create",
    "memory delete",
    "memory list",
    "memory search",
    "pkm capture",
    "pkm journal show",
    "pkm page edit",
    "pkm page export",
    "pkm page list",
    "pkm page save",
    "pkm page show",
    "pkm radar",
    "pkm search",
    "repo create",
    "repo list",
    "repo pr submit",
    "runtime list",
    "runtime refresh",
    "session list",
    "session show",
    "session stop",
];

#[test]
fn every_command_has_a_description_and_an_example() {
    let home = tempfile::tempdir().unwrap();
    for command in COMMANDS {
        let mut args: Vec<&str> = command.split(' ').collect();
        args.push("--help");
        let help = cli(home.path(), &args, &[]);
        assert_eq!((command, help.code, help.out.contains("EXAMPLES")), (command, 0, true), "{}", help.out);
    }
}

#[test]
fn answers_in_short_lines_with_the_name_to_use_next_first_and_in_the_protocols_shape_with_format_json() {
    let f = farm();
    let made = f.run(&["issue", "create", "试一下", "--criterion", "能打开"]);
    assert_eq!(made.out, "#1  backlog  试一下", "{:?}", made.failure);
    let shown = f.run(&["issue", "show", "#1"]).out;
    assert!(shown.contains("能打开"));
    assert!(shown.lines().last().unwrap().starts_with("  vibevalley issue status 1 "), "{shown}");
    assert_eq!(f.run(&["issue", "edit", "1", "--title", "改一下"]).out, "#1  backlog  改一下");
    let as_json: Value = serde_json::from_str(&f.run(&["issue", "show", "1", "--format", "json"]).out).unwrap();
    assert_eq!(
        (as_json["number"].clone(), as_json["criteria"].clone()),
        (1.into(), serde_json::json!(["能打开"]))
    );
    for title in ["二", "三", "四"] {
        f.run(&["issue", "create", title]);
    }
    let list = f.run(&["issue", "list"]).out;
    let list_json = f.run(&["issue", "list", "--format", "json"]).out;
    assert_eq!(list.lines().count(), 4);
    assert!(list.len() * 3 < list_json.len());
    assert!(f.run(&["issue", "list", "--limit", "2"]).out.lines().last().unwrap().contains("--limit 4"));
    assert_eq!(cli(&f.home(), &["issue", "show", "1"], &[("VIBEVALLEY_SERVER", &f.url)]).code, 0);
}

#[test]
fn fails_with_nothing_on_stdout_a_json_failure_on_stderr_an_exit_code_by_kind_and_what_to_run_next() {
    let f = farm();
    let missing_argument = f.run(&["issue", "show"]);
    assert_eq!(
        (missing_argument.code, missing_argument.out.as_str(), missing_argument.tag()),
        (2, "", "MissingArgument")
    );
    assert_eq!(f.run(&["issue", "list", "--bogus", "1"]).tag(), "UnrecognizedOption");
    let missing = f.run(&["issue", "show", "nope"]);
    assert_eq!((missing.code, missing.tag()), (4, "Missing"));
    assert_eq!(
        missing.failure.as_ref().unwrap()["error"]["next"][0]["run"],
        serde_json::json!(["issue", "list"])
    );
    f.run(&["issue", "create", "还是草稿"]);
    let refused = f.run(&["issue", "status", "1", "done"]);
    assert_eq!((refused.code, refused.tag()), (3, "Refused"));
    let next = refused.failure.as_ref().unwrap()["error"]["next"].as_array().cloned().unwrap_or_default();
    let cancel = next
        .iter()
        .find(|n| n["run"] == serde_json::json!(["issue", "status", "1", "canceled"]))
        .expect("a way to cancel");
    let run: Vec<&str> = cancel["run"].as_array().unwrap().iter().map(|w| w.as_str().unwrap()).collect();
    assert!(f.run(&run).out.starts_with("#1  canceled"));
    let no_words = f.run(&["issue", "comment", "1"]);
    assert_eq!((no_words.code, no_words.tag()), (2, "MissingArgument"));
    let nowhere = f.run(&["channel", "message", "list", "nowhere"]);
    assert_eq!((nowhere.code, nowhere.tag()), (4, "Missing"));
    let gone = cli(&f.home(), &["issue", "list", "--server", "http://127.0.0.1:9"], &[]);
    assert_eq!((gone.code, gone.tag()), (5, "Unreachable"));
    let wrong = cli(&f.home(), &["issue", "nope"], &[]);
    assert_eq!((wrong.code, wrong.out.as_str(), wrong.tag()), (2, "", "UnknownSubcommand"));
}

#[test]
fn dry_run_says_what_would_happen_and_changes_nothing_and_a_change_without_one_is_refused() {
    let f = farm();
    f.run(&["issue", "create", "先试跑"]);
    let cancel = f.run(&["issue", "status", "1", "canceled", "--dry-run"]);
    assert_eq!((cancel.code, cancel.out.as_str()), (0, "#1 关成已取消：还没派过"));
    assert!(f.run(&["issue", "show", "1"]).out.lines().nth(1).unwrap().starts_with("backlog"));
    let create = f.run(&["issue", "create", "不该建", "--dry-run"]);
    assert_eq!((create.code, create.tag()), (2, "NoDryRun"));
    let added = f.run(&["cron", "create", "早上看看", "看看昨天的改动", "--daily", "09:00"]);
    let id = added.out.split("  ").next().unwrap().to_string();
    assert!(f.run(&["cron", "delete", &id, "--dry-run"]).out.contains("删掉定时任务「早上看看」"));
    assert!(f.run(&["cron", "list"]).out.contains(&id));
    assert!(f.run(&["agent", "delete", "docs", "--dry-run"]).out.contains("删掉档案"));
}

#[test]
fn with_no_command_it_shows_the_help() {
    let home = tempfile::tempdir().unwrap();
    let bare = cli(home.path(), &[], &[]);
    assert_eq!((bare.code, bare.out.contains("SUBCOMMANDS")), (0, true), "{}", bare.out);
}

#[test]
fn the_other_resources_answer_in_lines() {
    let f = farm();
    assert!(f.run(&["agent", "list"]).out.contains("docs"));
    assert!(f.run(&["channel", "list"]).out.starts_with('#'));
    assert_eq!(f.run(&["channel", "message", "send", "general", "你好"]).code, 0);
    assert!(f.run(&["channel", "message", "list", "general"]).out.contains("你好"));
    assert_eq!(f.run(&["repo", "create", "clock"]).code, 0);
    assert!(f.run(&["repo", "list"]).out.starts_with("clock"));
    assert!(f.run(&["runtime", "list"]).out.contains("pi"));
    let captured = f.run(&["pkm", "capture", "记一笔"]);
    assert_eq!(captured.code, 0, "{:?}", captured.failure);
    assert!(f.run(&["pkm", "search", "记一笔"]).out.contains("记一笔"));
    let remembered = f.run(&["memory", "create", "docs", "用中文写"]);
    assert_eq!(remembered.code, 0, "{:?}", remembered.failure);
    assert!(f.run(&["memory", "list", "docs"]).out.contains("用中文写"));
}

#[test]
fn watch_returns_for_questions_while_the_issue_remains_in_progress() {
    let f = farm();
    let profile = f
        .run(&["agent", "create", "fox", "--runtime", "pi"])
        .out
        .split("  ")
        .next()
        .unwrap()
        .to_string();
    assert_eq!(f.run(&["repo", "create", "clock"]).code, 0);
    let made = f.run(&[
        "issue",
        "create",
        "打卡页先问清楚，给选项，提交",
        "--repo",
        "clock",
        "--agent",
        &profile,
        "--criterion",
        "clock-in works",
    ]);
    let n = made.out.trim_start_matches('#').split("  ").next().unwrap().to_string();
    assert_eq!(f.run(&["issue", "status", &n, "todo"]).code, 0);
    let watched = f.run(&["issue", "show", &n, "--watch", "--timeout", "30"]);
    assert_eq!(watched.code, 0, "{:?}", watched.failure);
    let asking = f.run(&["issue", "show", &n]).out;
    assert!(asking.lines().nth(1).unwrap().starts_with("in_progress"), "{asking}");
    assert!(asking.contains("用 8797"), "{asking}");
    assert!(asking.contains(&format!("vibevalley issue comment {n} …")), "{asking}");
    assert_eq!(f.run(&["issue", "comment", &n, "用 8797"]).code, 0);
    assert_eq!(f.run(&["issue", "show", &n, "--watch", "--timeout", "30"]).code, 0);
    let handed_back = f.run(&["issue", "show", &n]).out;
    assert!(handed_back.lines().nth(1).unwrap().starts_with("in_review"), "{handed_back}");
    assert!(f.run(&["issue", "diff", &n]).out.contains("clock.ts"));
    assert_eq!(f.run(&["issue", "review", &n, "--pass"]).code, 0);
    assert!(f.run(&["issue", "status", &n, "done"]).out.starts_with(&format!("#{n}  done")));
}
