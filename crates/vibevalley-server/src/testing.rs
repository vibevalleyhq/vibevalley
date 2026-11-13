//! The page's tests' stand-in agent (`apps/server/src/testing/worker.ts`
//! `helper`): runtime `pi`, whose every turn does what the words of its brief
//! say. Served only when `VIBEVALLEY_TEST_RUNTIMES=1`; never asks a model.

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use serde_json::json;
use vibevalley_oar::scripted::{Script, ScriptedRuntime, Step, TurnAsk};
use vibevalley_oar::{EventKind, Runtime};

/// `briefBreak`: a persona before the brief is set apart by it.
const BRIEF_BREAK: &str = "\n\n---\n\n";
/// `answerOpening`: the words that make a round an answer round.
const ANSWER_OPENING: &str = "这一轮你只查清楚、回答问题";
/// `criteriaHead`.
const CRITERIA_HEAD: &str = "验收标准（";
/// How long an idle or slow turn holds before it goes on by itself.
const HOLD_MS: u64 = 1_500;

fn git(cwd: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .args(["-c", "user.name=session", "-c", "user.email=session@vibevalley.test"])
        .args(args)
        .current_dir(cwd)
        .output()
        .is_ok_and(|o| o.status.success())
}

fn write(cwd: &Path, file: &str, text: &str) {
    let _ = std::fs::write(cwd.join(file), text);
}

/// A tool call as the agent reports it: `work` runs, then the call ends.
fn tool(n: usize, command: &str, steps: &mut Vec<Step>, work: impl FnOnce() -> String) {
    let id = format!("pi-tool-{n}");
    steps.push(Step::Emit(EventKind::ToolCallStarted {
        id: id.clone(),
        name: "bash".into(),
        input: json!({ "command": command }),
    }));
    let output = work();
    steps.push(Step::Emit(EventKind::ToolCallFinished { id, ok: true, output }));
}

fn say(steps: &mut Vec<Step>, text: impl Into<String>) {
    steps.push(Step::text(text));
}

fn draft(ask: &TurnAsk, input: &str) -> Vec<Step> {
    let mut steps = vec![];
    if input.contains("慢慢") {
        steps.push(Step::sleep_ms(HOLD_MS));
    }
    if input.contains("乱写") {
        say(&mut steps, "看了一圈，不知道写什么。\n\n结论：没写出来");
        return steps;
    }
    let cwd = ask.cwd.as_path();
    if input.contains("顺手提交") {
        tool(0, "git commit", &mut steps, || {
            write(cwd, "board.ts", "export const drag = 1\n");
            git(cwd, &["add", "board.ts"]);
            git(cwd, &["commit", "-q", "-m", "起草时不该有的提交"]);
            write(cwd, "board.ts", "export const drag = 2\n");
            write(cwd, "scratch.md", "草稿\n");
            String::new()
        });
    }
    let (title, criteria, questions) = if input.contains("用户的回答：用 8797") {
        ("看板拖卡改用 8797 端口", r#"["拖到待办就开工", "端口是 8797"]"#, "")
    } else {
        ("看板拖卡改用 issue.status", r#"["拖到待办就开工"]"#, "要问用户：用 8787 还是 8797？\n\n")
    };
    say(
        &mut steps,
        format!(
            "看过代码了。\n\n{questions}```json\n{{\"title\": \"{title}\", \"why\": \"看板还在调旧接口\", \"todo\": [\"改 board.dart\"], \"criteria\": {criteria}, \"notDoing\": [], \"files\": [\"board.dart\"]}}\n```\n\n结论：草稿写好了"
        ),
    );
    steps
}

fn answer(ask: &TurnAsk, input: &str) -> Vec<Step> {
    let mut steps = vec![];
    let cwd = ask.cwd.as_path();
    if input.contains("顺手提交") {
        tool(0, "git commit", &mut steps, || {
            write(cwd, "probe.ts", "export const probe = 1\n");
            git(cwd, &["add", "probe.ts"]);
            git(cwd, &["commit", "-q", "-m", "查的时候不该有的提交"]);
            String::new()
        });
    }
    if input.contains("乱写") {
        say(&mut steps, "看了一圈，说不清。\n\n结论：没查出来");
        return steps;
    }
    let found =
        json!({ "conclusion": "打卡慢是因为每次都重读配置", "evidence": ["clock.ts:1 每次调用都读一遍配置"], "unsure": [], "next": ["把配置读一次缓存起来"] });
    say(&mut steps, format!("查过了。\n\n```json\n{found}\n```\n\n结论：查清楚了"));
    steps
}

fn turn(ask: &TurnAsk) -> Result<Vec<Step>, String> {
    let input = ask.prompt.rsplit(BRIEF_BREAK).next().unwrap_or("").to_string();
    let persona = ask.append_system_prompt.clone().unwrap_or_default();
    if input.contains("只起草工单") {
        return Ok(draft(ask, &input));
    }
    if input.contains(ANSWER_OPENING) || input.contains("结论读不出来") || persona.contains(vibevalley_issues::ANSWER_ONLY) {
        return Ok(answer(ask, &input));
    }
    if input.contains("必败") {
        return Err("provider said no".into());
    }
    let mut steps = vec![];
    if input.contains("发呆") {
        steps.push(Step::sleep_ms(HOLD_MS));
    }
    let cwd = ask.cwd.as_path();
    let mut n = 0;
    if let Some(v) = input
        .split("写版本")
        .nth(1)
        .and_then(|r| r.chars().next())
        .filter(|c| c.is_alphanumeric() || *c == '_')
    {
        tool(n, "git commit", &mut steps, || {
            write(cwd, "same.ts", &format!("export const v = '{v}'\n"));
            git(cwd, &["add", "same.ts"]);
            git(cwd, &["commit", "-q", "-m", &format!("版本 {v}")]);
            String::new()
        });
        n += 1;
    }
    if input.contains("有冲突") {
        tool(n, "git merge main", &mut steps, || {
            // The conflict is the point: same.ts is settled next.
            git(cwd, &["merge", "main"]);
            write(cwd, "same.ts", "export const v = 'A+B'\n");
            git(cwd, &["add", "same.ts"]);
            git(cwd, &["commit", "-q", "--no-edit"]);
            String::new()
        });
        n += 1;
    }
    tool(n, "echo hi", &mut steps, || "hi".into());
    n += 1;
    if input.contains("提交") {
        tool(n, "git commit", &mut steps, || {
            write(cwd, "clock.ts", "export const clockIn = () => \"ok\"\n");
            git(cwd, &["add", "clock.ts"]);
            // Asked again on a branch that has it, it has nothing new to commit, as an agent would.
            let dirty = Command::new("git")
                .args(["status", "--porcelain"])
                .current_dir(cwd)
                .output()
                .is_ok_and(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty());
            if dirty {
                git(cwd, &["commit", "-q", "-m", "加上打卡"]);
            }
            String::new()
        });
    }
    let mut notes = String::new();
    if input.contains("先问清楚") && !input.contains("用 8797") {
        notes += "\n\n要问用户：用 8787 还是 8797？";
        if input.contains("给选项") {
            notes += "（选项：用 8787｜用 8797）";
        }
    }
    if let Some(at) = ask.prompt.find(CRITERIA_HEAD) {
        let criteria = ask.prompt[at..]
            .lines()
            .filter(|l| l.split_once(". ").is_some_and(|(n, _)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit())))
            .count();
        if criteria > 0 {
            let lines: Vec<String> = (1..=criteria).map(|i| format!("标准 {i}：做到了 —— 跑了 echo hi")).collect();
            notes += &format!("\n\n{}", lines.join("\n"));
        }
    }
    let persona = if persona.is_empty() { "无".to_string() } else { persona };
    say(&mut steps, format!("做完了：{input}｜人设：{persona}{notes}"));
    Ok(steps)
}

/// Runtime `pi`.
pub fn helper() -> Arc<dyn Runtime> {
    Arc::new(ScriptedRuntime::new("pi", Script::computed(Arc::new(turn))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(prompt: &str, cwd: &Path) -> TurnAsk {
        TurnAsk {
            prompt: prompt.into(),
            turn: 0,
            cwd: cwd.to_path_buf(),
            append_system_prompt: None,
        }
    }

    fn said(steps: &[Step]) -> String {
        steps
            .iter()
            .filter_map(|s| match s {
                Step::Emit(EventKind::TextDelta { text }) => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_turn_says_what_it_was_asked_after_the_persona() {
        let dir = tempfile::tempdir().unwrap();
        let steps = turn(&ask("persona\n\n---\n\n打个招呼", dir.path())).unwrap();
        assert_eq!(said(&steps), "做完了：打个招呼｜人设：无");
        assert!(turn(&ask("必败", dir.path())).is_err());
        let questions = said(&turn(&ask("先问清楚，给选项", dir.path())).unwrap());
        assert!(questions.ends_with("要问用户：用 8787 还是 8797？（选项：用 8787｜用 8797）"), "{questions}");
        let drafted = said(&turn(&ask("只起草工单", dir.path())).unwrap());
        assert!(drafted.contains("```json") && drafted.contains("看板拖卡改用 issue.status"), "{drafted}");
    }

    #[test]
    fn a_version_is_committed_on_the_branch() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path();
        assert!(git(cwd, &["init", "-q"]));
        let _ = turn(&ask("写版本A", cwd)).unwrap();
        let log = Command::new("git").args(["log", "--oneline"]).current_dir(cwd).output().unwrap();
        assert!(String::from_utf8_lossy(&log.stdout).contains("版本 A"));
    }
}
