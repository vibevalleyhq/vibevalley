//! Writes `ui/components/fixtures/frame-*.json` from real `vibevalley_core`
//! state, so the derived fields (status, stage, acts, moves, inbox) are the
//! engine's own and not hand-written guesses.
//!
//! Run: `cargo run` in this
//! directory. Times are relative to `NOW`; the gallery shifts them to the
//! wall clock.

use std::path::Path;

mod events;

use vibevalley_core::*;

const NOW: Millis = 1_794_499_600_000;
const MIN: Millis = 60_000;
const HOUR: Millis = 60 * MIN;

const LONG_EN: &str = "Make the terminal pane keep its scrollback when the window is resized, and keep the cursor row stable while the agent streams long tool output into it, without dropping frames on a 120 Hz display okay";
const LONG_ZH: &str = "把终端面板在窗口缩放时的回滚内容保留下来，并且在助手往里面持续输出很长的工具结果时保持光标所在行稳定，在一百二十赫兹的显示器上也不要掉帧；同时检查中文输入法在终端里候选框的位置是否跟着光标走，切换项目以后焦点要回到上一次的终端，关闭再打开窗口时布局要恢复成用户离开时的样子，分屏比例也要记住，字体大小改了以后要重新排版但不能丢掉选区。另外标签页标题要显示当前目录和正在跑的命令，太长就从中间省略掉一段";

fn sent(t: &mut Issue, session: &str, at: Millis) {
    t.assignments = vec![Assignment {
        id: format!("as-{}", t.id),
        agent: "claude".into(),
        assigned_at: at,
        ended_at: None,
        executions: vec![Execution { session: session.into(), started_at: at, in_process: false }],
    }];
    t.queued_at = Some(at);
}

fn worker(id: &str, name: &str, issue: &str, hired: Millis) -> Session {
    let mut s = Session::worker(id, name, hired);
    s.agent = "claude".into();
    s.runtime = "claude".into();
    s.repo = Some("~/vibevalley".into());
    s.branch = Some(format!("vibevalley/{issue}"));
    s.worktree = Some(format!("~/.vibevalley/worktrees/{issue}"));
    s.issue = Some(issue.into());
    s.runs = 1;
    s
}

fn ran(s: &mut Session, outcome: Outcome, summary: &str, at: Millis) {
    s.phase = match outcome {
        Outcome::Completed => Phase::Done,
        Outcome::Interrupted => Phase::Resting,
        Outcome::Failed => Phase::Failed,
    };
    s.last_run = Some(LastRun { outcome, summary: summary.into(), at, answer: None });
}

fn board() -> SpaceState {
    let mut issues = Vec::new();
    let mut sessions = Vec::new();
    let issue = |id: &str, n: u64, title: &str, ago: Millis| {
        let mut t = Issue::new(id, n, title, NOW - ago);
        t.repo = Some("~/vibevalley".into());
        t
    };

    // todo lane
    let mut t = issue("i-1", 1, "Add a dark-mode toggle to the settings pane", 3 * HOUR);
    t.description = "Settings gets a three-way switch: Light, Dark, System. System follows macOS.".into();
    t.criteria = vec!["The switch has three states".into(), "System follows the OS appearance live".into()];
    t.rank = Some(1);
    issues.push(t);

    let mut t = issue("i-2", 2, "文件树支持按 git 状态过滤", 2 * HOUR);
    t.description = "只看改过的、只看未跟踪的，两个开关。".into();
    t.rank = Some(2);
    issues.push(t);
    let mut s = Session::worker("w-2", "起草员", NOW - 10 * MIN);
    s.issue = Some("i-2".into());
    s.refining = true;
    s.phase = Phase::Working { since: NOW - 10 * MIN, doing: "读代码".into(), quiet_since: None };
    sessions.push(s);

    let mut t = issue("i-3", 3, LONG_EN, 90 * MIN);
    t.description = LONG_ZH.into();
    t.priority = Priority::High;
    t.queued_at = Some(NOW - 5 * MIN);
    issues.push(t);

    let mut t = issue("i-13", 13, LONG_ZH, 80 * MIN);
    t.description = LONG_EN.into();
    t.priority = Priority::Urgent;
    t.rank = Some(3);
    issues.push(t);

    // in progress
    let mut t = issue("i-4", 4, "Port the diff view to the GPUI painter", 5 * HOUR);
    t.description = "Side-by-side and unified, syntax colors from the theme tokens.".into();
    t.criteria = vec!["Unified view renders".into(), "Side-by-side view renders".into(), "Theme tokens drive colors".into()];
    sent(&mut t, "w-4", NOW - 25 * MIN);
    issues.push(t);
    let mut s = worker("w-4", "Painter", "i-4", NOW - 25 * MIN);
    s.phase = Phase::Working { since: NOW - 4 * MIN, doing: "Running cargo test -p vibevalley-mac".into(), quiet_since: None };
    s.brief = "Port the diff view".into();
    sessions.push(s);

    let mut t = issue("i-5", 5, "给 roar CLI 加上 --json 输出", 6 * HOUR);
    sent(&mut t, "w-5", NOW - 70 * MIN);
    issues.push(t);
    let mut s = worker("w-5", "小码", "i-5", NOW - 70 * MIN);
    s.phase = Phase::Working { since: NOW - 60 * MIN, doing: "cargo build --release".into(), quiet_since: Some(NOW - 22 * MIN) };
    s.brief = "roar 输出 JSON".into();
    sessions.push(s);

    // asks the user (stage asking; status stays in progress)
    let mut t = issue("i-7", 7, "Pick the default shell for new terminals", 8 * HOUR);
    t.questions = vec![Question {
        question: "Should new terminals start the login shell or the user's configured shell?".into(),
        options: vec!["Login shell".into(), "Configured shell".into()],
    }];
    sent(&mut t, "w-7", NOW - 40 * MIN);
    issues.push(t);
    let mut s = worker("w-7", "Shellby", "i-7", NOW - 40 * MIN);
    ran(&mut s, Outcome::Completed, "Two options found; asked which one to use.", NOW - 3 * MIN);
    sessions.push(s);

    // in review: reviewing
    let mut t = issue("i-6", 6, "Keep the terminal font in sync with settings", 9 * HOUR);
    t.description = "Changing the font size in settings re-lays out every open terminal.".into();
    t.criteria = vec!["Font size applies to open terminals".into(), "Selection survives the relayout".into()];
    sent(&mut t, "w-6", NOW - 2 * HOUR);
    issues.push(t);
    let mut s = worker("w-6", "Fontaine", "i-6", NOW - 2 * HOUR);
    ran(&mut s, Outcome::Completed, "Font size now applies live; added a relayout test.", NOW - 12 * MIN);
    sessions.push(s);

    // in review: failed
    let mut t = issue("i-8", 8, "修好 vibevalley-terminal 在 zsh 下的 resize 抖动", 10 * HOUR);
    sent(&mut t, "w-8", NOW - 3 * HOUR);
    issues.push(t);
    let mut s = worker("w-8", "小修", "i-8", NOW - 3 * HOUR);
    ran(&mut s, Outcome::Failed, "cargo test 失败：resize_keeps_cursor 断言不通过，SIGWINCH 到得比快照晚。", NOW - 30 * MIN);
    sessions.push(s);

    // in review: conflict
    let mut t = issue("i-9", 9, "Move the agent session index into vibevalley-store", 11 * HOUR);
    t.conflict = Some(Conflict { base: "main".into(), files: vec!["crates/vibevalley-store/src/lib.rs".into(), "Cargo.lock".into()] });
    sent(&mut t, "w-9", NOW - 4 * HOUR);
    issues.push(t);
    let mut s = worker("w-9", "Storey", "i-9", NOW - 4 * HOUR);
    ran(&mut s, Outcome::Completed, "Index moved; tests pass on the branch.", NOW - 50 * MIN);
    sessions.push(s);

    // in review: interrupted
    let mut t = issue("i-10", 10, "Fuzzy file finder ranks exact basename first", 12 * HOUR);
    sent(&mut t, "w-10", NOW - 5 * HOUR);
    issues.push(t);
    let mut s = worker("w-10", "Finder", "i-10", NOW - 5 * HOUR);
    ran(&mut s, Outcome::Interrupted, "Stopped after the ranking change; tests not run yet.", NOW - 70 * MIN);
    sessions.push(s);

    // answer issue in review, with its answer
    let mut t = issue("i-14", 14, "Why does the app use 400 MB at idle?", 13 * HOUR);
    t.deliver = Deliverable::Answer;
    t.repo = None;
    sent(&mut t, "w-14", NOW - 6 * HOUR);
    issues.push(t);
    let mut s = worker("w-14", "Probe", "i-14", NOW - 6 * HOUR);
    ran(&mut s, Outcome::Completed, "Glyph atlas is never trimmed.", NOW - 2 * HOUR);
    s.last_run.as_mut().unwrap().answer = Some(IssueAnswer {
        conclusion: "The glyph atlas grows with every font size used and is never trimmed.".into(),
        evidence: vec!["Atlas is 310 MB after 20 size changes".into(), "Trimming on idle drops it to 40 MB".into()],
    });
    sessions.push(s);

    // closed
    let mut t = issue("i-11", 11, "Show git branch in the status bar", 30 * HOUR);
    sent(&mut t, "w-11", NOW - 28 * HOUR);
    t.delivered = Some(Landing::Merged);
    t.closed_at = Some(NOW - 20 * HOUR);
    t.reviewed_at = Some(NOW - 20 * HOUR);
    issues.push(t);

    let mut t = issue("i-12", 12, "试试把文件预览换成 WebView", 40 * HOUR);
    t.canceled = Some(IssueCanceled::Dismissed);
    t.closed_at = Some(NOW - 30 * HOUR);
    issues.push(t);

    let mut state = SpaceState::default();
    let mut core = Core::new();
    let mut facts: Vec<Fact> = sessions.into_iter().map(|s| Fact::SessionChanged { at: NOW, session: s }).collect();
    facts.extend(issues.into_iter().map(|t| Fact::IssueChanged { at: NOW, issue: t }));
    core.apply(facts);
    state.issues = core.state().issues.clone();
    state.sessions = core.state().sessions.clone();
    state
}

fn write(dir: &Path, name: &str, value: &impl serde::Serialize) {
    let text = serde_json::to_string_pretty(value).expect("fixture serializes");
    std::fs::write(dir.join(name), text + "\n").expect("fixture written");
}

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let state = board();
    write(&dir, "frame-board.json", &frame_of(42, &state));
    write(&dir, "frame-empty.json", &frame_of(1, &SpaceState::default()));
    let t0 = (NOW - 3 * MIN) as u64;
    write(&dir, "events-claude.json", &events::claude_run(t0));
    write(&dir, "events-codex.json", &events::codex_run(t0));
    write(&dir, "events-error.json", &events::error_run(t0));
    write(&dir, "events-long.json", &events::long_run(t0, LONG_EN, LONG_ZH));
    for t in &state.issues {
        eprintln!("#{:<3} {:<12} {:<10} lead={:?} acts={:?}", t.number, format!("{:?}", t.status), format!("{:?}", t.stage.state), t.stage.lead, t.stage.acts.iter().map(|a| a.act()).collect::<Vec<_>>());
    }
    eprintln!("inbox: {}", frame_of(42, &state).inbox.len());
}
