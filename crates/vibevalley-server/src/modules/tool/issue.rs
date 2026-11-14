//! Issues and the helpers on them.

use serde::Deserialize;
use serde_json::{Value, json};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    Caller, Changes, CriterionCheck, Deliverable, Issue, IssueAnswer, IssueFilter, IssueReportMemory, IssueReviewInput, IssueStatus, IssueTimeline,
    MandateStrength, SubmitBranch,
};

use super::{Farm, Who, given};
use crate::modules::issue::ChildDraft;
use crate::modules::orchestrator::words::{self, wire};
use crate::modules::session::{Report, ReportQuestion, ReportStatus};
use crate::now;

const PRIORITIES: &str = "Expected one of: 紧急, 高, 普通, 中, 低, urgent, high, medium, low";

#[derive(Deserialize)]
pub struct ListArgs {
    text: Option<String>,
    repo: Option<String>,
    status: Option<String>,
    closed: Option<bool>,
    #[serde(rename = "wantsUser")]
    wants_user: Option<bool>,
    limit: Option<i64>,
}

pub fn list(f: &Farm, _: &Who, a: ListArgs) -> Result<String, String> {
    let status = match given(&a.status) {
        Some(st) => Some(words::status_named(st).ok_or_else(|| format!("Expected one of: {}", words::STATUS_WORDS))?),
        None => None,
    };
    let filter = IssueFilter {
        status,
        text: given(&a.text).map(String::from),
        repo: given(&a.repo).map(String::from),
        limit: None,
        closed: a.closed,
        wants_user: a.wants_user,
    };
    let found: Vec<Issue> = f.board.read(|s| vibevalley_core::pick_issues(&s.issues, &filter, now()));
    if found.is_empty() {
        return Ok(if a.wants_user == Some(true) {
            "没有在等用户的工单。"
        } else {
            "没有这样的工单。"
        }
        .into());
    }
    let limit = a.limit.filter(|l| *l > 0).map(|l| l as usize).unwrap_or(20);
    let at = now();
    let mut text = found
        .iter()
        .take(limit)
        .map(|i| words::issue_line(i, &f.who_of(i), at))
        .collect::<Vec<_>>()
        .join("\n");
    if found.len() > limit {
        text += &format!("\n（还有 {} 张没列）", found.len() - limit);
    }
    Ok(text)
}

#[derive(Deserialize)]
pub struct IdArgs {
    #[serde(default)]
    id: String,
}

pub fn get(f: &Farm, _: &Who, a: IdArgs) -> Result<String, String> {
    let item = match f.issue(&a.id) {
        Ok(i) => i,
        Err(why) => return Ok(why),
    };
    let timeline: Option<IssueTimeline> = f
        .board
        .runs(&item.id)
        .ok()
        .map(|runs| vibevalley_core::brief::milestones_of(&item, &runs, |s| f.board.session(s).map(|s| s.name)));
    let at = now();
    let mut lines = vec![words::issue_detail(&item, &f.who_of(&item), timeline.as_ref(), at)];
    if let Some(w) = f.worker_of(&item) {
        lines.push(words::session_line(&w, at, Some(item.number)));
        lines.push(format!("目录：{}", w.worktree.clone().unwrap_or_default()));
        let last = w.last_run.as_ref().map(|r| r.summary.clone()).filter(|t| !t.is_empty());
        lines.push(format!(
            "上一轮完整汇报（结尾部分）：\n{}",
            last.map(|t| words::tail(&t, 2000)).unwrap_or_else(|| "还没有".into())
        ));
    }
    Ok(lines.join("\n"))
}

pub fn diff(f: &Farm, _: &Who, a: IdArgs) -> Result<String, String> {
    let item = match f.issue(&a.id) {
        Ok(i) => i,
        Err(why) => return Ok(why),
    };
    Ok(match f.call(Caller::Orchestrator, "issue.diff.get", json!({ "id": item.id })) {
        Ok(v) => match serde_json::from_value::<Changes>(v) {
            Ok(c) => words::changes_text(&c),
            Err(e) => format!("看不了改动：{e}"),
        },
        Err(why) => format!("看不了改动：{why}"),
    })
}

#[derive(Deserialize)]
pub struct ReviewArgs {
    #[serde(default)]
    id: String,
    #[serde(default)]
    pass: bool,
    findings: Option<Value>,
    text: Option<String>,
}

pub fn review(f: &Farm, _: &Who, a: ReviewArgs) -> Result<String, String> {
    let item = match f.issue(&a.id) {
        Ok(i) => i,
        Err(why) => return Ok(why),
    };
    let findings = match a.findings {
        None | Some(Value::Null) => None,
        Some(Value::String(one)) => Some(vec![one]),
        Some(v) => Some(serde_json::from_value::<Vec<String>>(v).map_err(|e| format!("findings: {e}"))?),
    };
    let input = IssueReviewInput {
        id: item.id,
        pass: a.pass,
        findings,
        text: a.text,
    };
    Ok(match crate::modules::issue::review(&f.board, input).map_err(|e| e.message) {
        Ok(done) if a.pass => format!("#{} 验收过了，等用户点完成", done.number),
        Ok(done) => format!(
            "#{} 没过验收，{} 处要修，已经交回给帮工",
            done.number,
            done.findings.iter().filter(|x| !x.resolved).count()
        ),
        Err(why) => why,
    })
}

#[derive(Deserialize)]
pub struct CommentArgs {
    #[serde(default)]
    id: String,
    #[serde(default)]
    text: String,
}

pub fn comment(f: &Farm, _: &Who, a: CommentArgs) -> Result<String, String> {
    let item = match f.issue(&a.id) {
        Ok(i) => i,
        Err(why) => return Ok(why),
    };
    Ok(match crate::modules::issue::comment(&f.board, &item.id, &a.text) {
        Ok(_) => match f.worker_of(&item) {
            Some(w) => format!("已经在 #{} 的工单串里跟 {} 说了", item.number, w.name),
            None => words::nobody_on(item.number),
        },
        Err(why) => format!("没带到：{}", why.message),
    })
}

pub fn stop(f: &Farm, _: &Who, a: IdArgs) -> Result<String, String> {
    let item = match f.issue(&a.id) {
        Ok(i) => i,
        Err(why) => return Ok(why),
    };
    let Some(w) = f.worker_of(&item) else {
        return Ok(words::nobody_on(item.number));
    };
    Ok(match crate::modules::session::stop(&f.board, &w.id) {
        Ok(()) => format!("#{} 这一轮叫停了", item.number),
        Err(why) => why.message,
    })
}

#[derive(Deserialize)]
pub struct Nothing {}

pub fn sessions(f: &Farm, _: &Who, _: Nothing) -> Result<String, String> {
    let all = f.roster();
    Ok(if all.is_empty() {
        "现在没有在场的帮工。".into()
    } else {
        all.iter().map(|h| f.session_line(h)).collect::<Vec<_>>().join("\n")
    })
}

/// Who the orchestrator's issue goes to: the one it names, else for a start or a draft the best fit.
fn chosen(f: &Farm, who: &Who, named: Option<&str>, brief: &str, needed: bool) -> Result<Option<String>, String> {
    let named = named.unwrap_or("");
    if named.is_empty() && !needed {
        return Ok(None);
    }
    let picked = match who {
        Who::Orchestrator(r) if named.is_empty() => r.picked.as_str(),
        _ => "",
    };
    match f.agents.fleet.choose(brief, named, picked) {
        Some(a) => Ok(Some(a.id)),
        None if named.is_empty() => Err(words::NO_AGENT_TO_DISPATCH.into()),
        None => Err(format!("没有叫 {named} 的帮工档案或 runtime")),
    }
}

#[derive(Deserialize)]
pub struct UpdateArgs {
    #[serde(default)]
    id: String,
    title: Option<String>,
    description: Option<String>,
    repo: Option<String>,
    criteria: Option<Vec<String>>,
    deliver: Option<Deliverable>,
    priority: Option<String>,
    agent: Option<String>,
}

pub fn update(f: &Farm, _: &Who, a: UpdateArgs) -> Result<String, String> {
    let item = match f.issue(&a.id) {
        Ok(i) => i,
        Err(why) => return Ok(why),
    };
    let mut req = json!({ "id": item.id });
    for (k, v) in [("title", &a.title), ("description", &a.description), ("repo", &a.repo)] {
        if let Some(v) = v {
            req[k] = json!(v);
        }
    }
    if let Some(c) = &a.criteria {
        req["criteria"] = json!(c);
    }
    if let Some(d) = a.deliver {
        req["deliver"] = json!(d);
    }
    if let Some(pr) = given(&a.priority) {
        let pr = words::priority_named(pr).ok_or(PRIORITIES)?;
        req["priority"] = json!(wire(&pr));
    }
    if let Some(name) = given(&a.agent) {
        let Some(profile) = f.agents.profiles.named(name) else {
            return Ok(words::no_profile_named(name));
        };
        req["agent"] = json!(profile.id);
    }
    Ok(match f.call(Caller::Orchestrator, "issue.update", req).and_then(|_| f.issue(&item.id)) {
        Ok(done) => format!("改好了：{}", words::slice_from(&words::issue_line(&done, &f.who_of(&done), now()), 2)),
        Err(why) => format!("没改：{why}"),
    })
}

#[derive(Deserialize)]
pub struct StatusArgs {
    #[serde(default)]
    id: String,
    #[serde(default)]
    status: String,
    text: Option<String>,
    agent: Option<String>,
}

pub fn status(f: &Farm, who: &Who, a: StatusArgs) -> Result<String, String> {
    let item = match f.issue(&a.id) {
        Ok(i) => i,
        Err(why) => return Ok(why),
    };
    let to = words::status_named(&a.status).ok_or_else(|| format!("Expected one of: {}", words::STATUS_WORDS))?;
    let mut req = json!({ "id": item.id, "status": wire(&to) });
    if let Some(text) = given(&a.text) {
        req["text"] = json!(text);
    }
    let needed = to == IssueStatus::Todo && item.status == IssueStatus::Backlog && item.assigned_agent().is_none();
    match chosen(f, who, given(&a.agent), &format!("{}\n{}", item.title, item.description), needed) {
        Ok(Some(agent)) => req["agent"] = json!(agent),
        Ok(None) => {}
        Err(why) => return Ok(format!("没挪：{why}")),
    }
    Ok(match f.call(Caller::Orchestrator, "issue.status.update", req).and_then(|_| f.issue(&item.id)) {
        Ok(done) if to == IssueStatus::Done && done.status == IssueStatus::Done => format!("#{} {}", done.number, words::closed(&done)),
        Ok(done) => format!("挪好了：{}", words::slice_from(&words::issue_line(&done, &f.who_of(&done), now()), 2)),
        Err(why) => format!("没挪：{why}"),
    })
}

#[derive(Deserialize)]
pub struct CreateArgs {
    #[serde(default)]
    title: String,
    description: Option<String>,
    deliver: Option<Deliverable>,
    parent: Option<String>,
    #[serde(rename = "blockedBy")]
    blocked_by: Option<Vec<String>>,
    repo: Option<String>,
    priority: Option<String>,
    agent: Option<String>,
    channel: Option<String>,
    #[serde(default)]
    start: bool,
    #[serde(default)]
    draft: bool,
    #[serde(rename = "autoSubmitPr")]
    auto_submit_pr: Option<bool>,
}

/// `issue_create`: written down, and sent when asked (`start`).
pub fn create(f: &Farm, who: &Who, a: CreateArgs) -> Result<String, String> {
    if a.start && a.draft {
        return Ok("没记：起草交回来以前开不了工。要马上做就不起草；要起草就先不开工。".into());
    }
    let here = match who {
        Who::Orchestrator(r) => r.channel.clone(),
        Who::Helper(h) => h.channel.clone().unwrap_or_default(),
    };
    let mut channel = f.chat.top_of(&here);
    if let Some(name) = given(&a.channel) {
        match f.chat.channel_by_name(name) {
            Some(c) => channel = c,
            None => return Ok(format!("没有 {name} 这个频道：先用 channel_list 看看有哪些，或者用 channel_create 开一个。")),
        }
    }
    let mut req = json!({ "title": a.title });
    if let Some(v) = &a.description {
        req["description"] = json!(v);
    }
    if let Some(v) = a.deliver {
        req["deliver"] = json!(v);
    }
    if let Some(v) = &a.parent {
        req["parent"] = json!(v);
    }
    if let Some(v) = &a.blocked_by {
        req["blockedBy"] = json!(v);
    }
    if let Some(v) = a.auto_submit_pr {
        req["autoSubmitPr"] = json!(v);
    }
    match given(&a.repo) {
        Some(r) => req["repo"] = json!(r),
        None if !channel.repo.is_empty() => req["repo"] = json!(channel.repo),
        None if a.start => return Ok(format!("没记：#{} 没有默认仓库：填上 repo。", channel.name)),
        None => {}
    }
    if let Some(pr) = given(&a.priority) {
        match words::priority_named(pr) {
            Some(pr) => req["priority"] = json!(wire(&pr)),
            None => return Ok(PRIORITIES.into()),
        }
    }
    let brief = format!("{}\n{}", a.title, a.description.clone().unwrap_or_default());
    match chosen(f, who, given(&a.agent), &brief, a.start) {
        Ok(Some(agent)) => req["agent"] = json!(agent),
        Ok(None) => {}
        Err(why) => return Ok(format!("没记：{why}")),
    }
    let item = match f.call(Caller::Orchestrator, "issue.create", req).and_then(|v| {
        let id = v["issue"]["id"].as_str().or_else(|| v["id"].as_str()).unwrap_or("").to_string();
        f.issue(&id)
    }) {
        Ok(i) => i,
        Err(why) => return Ok(format!("没记下：{why}")),
    };
    let answer = if item.deliver == Deliverable::Answer {
        "（只查、交结论，不改代码）"
    } else {
        ""
    };
    let noted = format!("记下了：#{}「{}」{answer}", item.number, vibevalley_core::rules::short_title(&item.title));
    if a.draft {
        return Ok(match f.call(Caller::Orchestrator, "issue.refine", json!({ "id": item.id })) {
            Ok(_) => format!("{noted}，在备选里，帮工在起草"),
            Err(why) => format!("{noted}，在备选里；起草没开始：{why}"),
        });
    }
    if !a.start {
        return Ok(format!("{noted}，在备选里，没开工"));
    }
    if let Err(why) = f.call(Caller::Orchestrator, "issue.status.update", json!({ "id": item.id, "status": "todo" })) {
        return Ok(format!(
            "{noted}，在备选里；没开工：{why}。要再开工用 issue_status_update 挪到待办，不要再建一张"
        ));
    }
    let now_item = f.issue(&item.id).unwrap_or(item);
    Ok(match f.worker_of(&now_item) {
        Some(h) => format!(
            "{noted}，已在 #{} 派 {}（{}）去 {}{}",
            channel.name,
            h.name,
            h.id,
            now_item.repo.clone().unwrap_or_default(),
            h.branch.as_deref().map(|b| format!("，分支 {b}")).unwrap_or_default()
        ),
        None => format!("{noted}，在 #{} 排进待办：有空位就开工", channel.name),
    })
}

/// The helper calling, and the issue it works on.
fn helper_issue(f: &Farm, who: &Who) -> Result<(vibevalley_protocol::Session, Issue), String> {
    let Who::Helper(me) = who else {
        return Err("这个工具只给帮工用".into());
    };
    let id = me.issue.as_ref().ok_or("当前不是正在处理工单的帮工会话")?;
    let issue = f
        .board
        .read(|s| s.issues.iter().find(|i| &i.id == id).cloned())
        .ok_or("当前不是正在处理工单的帮工会话")?;
    Ok(((**me).clone(), issue))
}

#[derive(Deserialize)]
pub struct Task {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    brief: String,
    #[serde(default)]
    needs: Vec<String>,
    #[serde(default)]
    acceptance: bool,
    check: Option<String>,
    #[serde(default)]
    scope: Vec<String>,
    agent: Option<String>,
}

#[derive(Deserialize)]
pub struct SplitArgs {
    #[serde(default)]
    tasks: Vec<Task>,
}

pub fn split(f: &Farm, who: &Who, a: SplitArgs) -> Result<String, String> {
    let (_, issue) = helper_issue(f, who)?;
    let drafts = a
        .tasks
        .into_iter()
        .map(|t| ChildDraft {
            id: t.id,
            title: t.title,
            brief: t.brief,
            needs: t.needs,
            acceptance: t.acceptance,
            check: given(&t.check).map(String::from),
            scope: t.scope,
            agent: given(&t.agent).map(String::from),
        })
        .collect();
    let children = f.board.split(&issue.id, drafts).map_err(|e| e.to_string())?;
    let lines: Vec<String> = children.iter().map(|c| format!("- #{} {}", c.number, c.title)).collect();
    Ok(format!("#{} 拆成了 {} 张子工单：\n{}", issue.number, children.len(), lines.join("\n")))
}

#[derive(Deserialize)]
pub struct ReportArgs {
    #[serde(default)]
    summary: String,
    #[serde(default)]
    questions: Vec<ReportQuestion>,
    #[serde(default)]
    checks: Vec<CriterionCheck>,
    #[serde(default)]
    remember: Vec<IssueReportMemory>,
    #[serde(default, rename = "prSubmit")]
    pr_submit: bool,
    answer: Option<IssueAnswer>,
}

pub fn report(f: &Farm, who: &Who, a: ReportArgs) -> Result<String, String> {
    let Ok((me, _)) = helper_issue(f, who) else {
        return Ok("当前不是正在处理工单的帮工会话，不能交回。 ".into());
    };
    if a.pr_submit {
        submit(f, who, Some(&a.summary))?;
    }
    let report = Report {
        status: if a.questions.is_empty() { ReportStatus::Done } else { ReportStatus::Blocked },
        summary: a.summary,
        questions: a.questions,
        answer: a.answer,
        checks: a.checks,
        remember: a.remember,
    };
    f.board.sessions().report(&me.id, &report).map_err(|e| e.to_string())?;
    Ok("报告已记录；现在用简短正文说明结果。".into())
}

pub fn handback(_: &Farm, _: &Who, _: Nothing) -> Result<String, String> {
    Err("这里没有交给你的输入卡片可退回；有问题写进 issue_report.questions，或在工单串里 @助手。".into())
}

#[derive(Deserialize)]
pub struct PrArgs {
    summary: Option<String>,
}

pub fn pr_submit(f: &Farm, who: &Who, a: PrArgs) -> Result<String, String> {
    submit(f, who, a.summary.as_deref()).map(|r| format!("PR 已提交：{r}"))
}

/// `submitPullRequest`: only on the user's explicit word, on an issue that delivers by pull request.
fn submit(f: &Farm, who: &Who, summary: Option<&str>) -> Result<String, String> {
    let (me, issue) = helper_issue(f, who).map_err(|_| t("server.issue.prSubmitNotCurrent", &[]))?;
    if issue.mandate.strength != MandateStrength::Explicit || !issue.mandate.auto_submit_pr {
        return Err(t("server.issue.prSubmitNotAllowed", &[]));
    }
    let (Deliverable::PullRequest, Some(cwd), Some(branch)) = (issue.deliver, me.worktree.clone(), me.branch.clone()) else {
        return Err(t("server.issue.prSubmitUnavailable", &[]));
    };
    let git = |args: &[&str]| -> Result<String, String> {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(&cwd)
            .args(args)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    let sha = git(&["rev-parse", "HEAD"])?;
    let written = git(&["rev-parse", "--git-path", "vibevalley-pr.md"])
        .ok()
        .and_then(|p| std::fs::read_to_string(std::path::Path::new(&cwd).join(p)).ok())
        .and_then(|text| pull_request_text(&text));
    let (title, body) = written.unwrap_or_else(|| (issue.title.clone(), summary.unwrap_or("").to_string()));
    let req = SubmitBranch {
        cwd,
        branch,
        sha,
        base: f.board.sessions().base_branch(&me.id).unwrap_or_else(|| "main".into()),
        title,
        body,
        dry_run: None,
    };
    let data = f.call(Caller::User, "repo.pr.submit", serde_json::to_value(&req).map_err(|e| e.to_string())?)?;
    Ok(data["url"].as_str().or(data["branch"].as_str()).unwrap_or("").to_string())
}

/// The PR title (first line, a leading `#` dropped) and body a helper wrote.
fn pull_request_text(text: &str) -> Option<(String, String)> {
    let mut lines = text.lines();
    let title = lines.next()?.trim_start_matches('#').trim().to_string();
    if title.is_empty() {
        return None;
    }
    Some((title, lines.collect::<Vec<_>>().join("\n").trim().to_string()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_pull_request_file_reads_as_title_and_body() {
        assert_eq!(
            super::pull_request_text("# feat(x): add y\n\n## What changed\n- y\n"),
            Some(("feat(x): add y".into(), "## What changed\n- y".into()))
        );
        assert_eq!(super::pull_request_text("\nbody"), None);
    }
}
