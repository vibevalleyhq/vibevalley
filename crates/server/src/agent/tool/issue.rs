//! Issues and the helpers on them.

use serde::Deserialize;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ActorKind, ActorRef, BacklogTriageSuggestInput, Caller, CriterionCheck, Deliverable, DeliveryReceipt, HumanPauseSource, Issue, IssueAnswer,
    IssueDigestGetInput, IssueFilter, IssueMandate, IssueRefineInput, IssueRelation, IssueReportMemory, IssueRequest, IssueReviewInput, IssueStatus,
    IssueStatusUpdateInput, IssueTimeline, IssueUpdateInput, MandateStrength, Priority, RepoHealthStatus, SubmitBranch, TriagePatch,
};

use super::registry::{Route, RouteSource, ToolRegistry, Who, given};
use crate::agent::profile::text;
use crate::issue::ChildDraft;
use crate::runtime::{Report, ReportQuestion, ReportStatus, RunMode};

const PRIORITIES: &str = "Expected one of: 紧急, 高, 普通, 中, 低, urgent, high, medium, low";

/// The 4 hard authorization tiers enforced on issue mutations in Rust.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthTier {
    /// Tier 1: create and immediately dispatch/draft (`issue_create(start=true|draft=true)`).
    CreateAndStart,
    /// Tier 2: split into child issues (`issue_split`).
    Split,
    /// Tier 3: modify issue metadata, review, or non-done status (`issue_update`, `issue_review`, `issue_status_update(!done)`).
    Update,
    /// Tier 4: complete/deliver/merge an issue (`issue_status_update(done)`).
    Done,
}

fn is_approved_cron(f: &ToolRegistry, route: &Route) -> bool {
    if route.source != Some(RouteSource::Cron) {
        return false;
    }
    let Some(cron_id) = route.cron_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) else {
        return false;
    };
    f.cron.list().into_iter().any(|c| {
        c.id == cron_id
            && !c.pending
            && (c.enabled || (matches!(c.when, vibevalley_protocol::CronWhen::Once(_)) && c.last_run.is_some()))
            && (c.by == ActorKind::User || !matches!(c.when, vibevalley_protocol::CronWhen::Once(_)) || c.agent.is_some())
    })
}

fn authorize_orchestrator(f: &ToolRegistry, route: &Route, tier: AuthTier) -> Result<(), String> {
    if route.user {
        return Ok(());
    }
    match tier {
        AuthTier::Done => Err("没成：没有用户当轮明确确认，不能把工单标记为已完成或合并（后台、巡查与定时回合一律拦截）。".into()),
        AuthTier::CreateAndStart | AuthTier::Split | AuthTier::Update => {
            if is_approved_cron(f, route) {
                Ok(())
            } else {
                Err("没成：当前属于无用户原话的后台或巡查回合（或未批准的定时触发），缺少授权；请先在频道询问用户确认。".into())
            }
        }
    }
}

fn authorize_who(f: &ToolRegistry, who: &Who, tier: AuthTier) -> Result<(), String> {
    match who {
        Who::Orchestrator(route) => authorize_orchestrator(f, route, tier),
        Who::Helper(_) => Err("没成：执行会话不能直接执行该工单管理操作。".into()),
    }
}

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

pub async fn list(f: &ToolRegistry, _who: &Who, a: ListArgs) -> Result<String, String> {
    let status = match given(&a.status) {
        Some(st) => Some(text::status_named(st).ok_or_else(|| format!("Expected one of: {}", text::STATUS_WORDS))?),
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
    let found = f.issue.list_async(&filter).await.map_err(|e| e.message)?;
    if found.is_empty() {
        return Ok(if a.wants_user == Some(true) {
            "没有在等用户的工单。"
        } else {
            "没有这样的工单。"
        }
        .into());
    }
    let limit = a.limit.filter(|l| *l > 0).map(|l| l as usize).unwrap_or(20);
    let at = f.ctx.now();
    let mut lines = Vec::with_capacity(found.len().min(limit));
    for i in found.iter().take(limit) {
        lines.push(text::issue_line(i, &f.who_of_async(i).await, at));
    }
    let mut out = lines.join("\n");
    if found.len() > limit {
        out += &format!("\n（还有 {} 张没列）", found.len() - limit);
    }
    Ok(out)
}

#[derive(Deserialize)]
pub struct IdArgs {
    #[serde(default)]
    id: String,
}

pub async fn get(f: &ToolRegistry, _: &Who, a: IdArgs) -> Result<String, String> {
    let item = match f.issue_async(&a.id).await {
        Ok(i) => i,
        Err(why) => return Ok(why),
    };
    let sessions = f.ctx.service.session.all().await.unwrap_or_default();
    let session_names: std::collections::HashMap<&str, &str> = sessions.iter().map(|s| (s.id.as_str(), s.name.as_str())).collect();
    let timeline: Option<IssueTimeline> = f
        .ctx
        .service
        .session
        .runs(&item.id)
        .await
        .ok()
        .map(|runs| vibevalley_core::brief::milestones_of(&item, &runs, |s| session_names.get(s).map(|n| (*n).to_string())));
    let at = f.ctx.now();
    let mut lines = vec![text::issue_detail(&item, &f.who_of_async(&item).await, timeline.as_ref(), at)];
    if !item.attachments.is_empty() {
        lines.push("附件本地路径：".into());
        for att in &item.attachments {
            lines.push(format!(
                "  - {}（{}，{} bytes）：{}",
                att.name,
                att.r#type,
                att.size,
                f.storage.path_of(&att.id).display()
            ));
        }
    }
    if let Some(w) = f.worker_of_async(&item).await {
        lines.push(text::session_line(&w, at, Some(item.number)));
        lines.push(format!("目录：{}", w.cwd.clone().unwrap_or_default()));
        let last = w.last_run.as_ref().map(|r| r.summary.clone()).filter(|t| !t.is_empty());
        lines.push(format!(
            "上一轮完整汇报（结尾部分）：\n{}",
            last.map(|t| text::tail(&t, 2000)).unwrap_or_else(|| "还没有".into())
        ));
    }
    Ok(lines.join("\n"))
}

pub async fn diff(f: &ToolRegistry, _who: &Who, a: IdArgs) -> Result<String, String> {
    let item = match f.issue_async(&a.id).await {
        Ok(i) => i,
        Err(why) => return Ok(why),
    };
    Ok(match f.issue.diff_async(&item.id, None).await {
        Ok(changes) => text::changes_text(&changes),
        Err(why) => format!("看不了改动：{}", why.message),
    })
}

#[derive(Deserialize)]
#[serde(untagged)]
enum OneOrMany {
    One(String),
    Many(Vec<String>),
}

#[derive(Deserialize)]
pub struct ReviewArgs {
    #[serde(default)]
    id: String,
    #[serde(default)]
    pass: bool,
    findings: Option<OneOrMany>,
    text: Option<String>,
}

pub async fn review(f: &ToolRegistry, who: &Who, a: ReviewArgs) -> Result<String, String> {
    let item = match f.issue_async(&a.id).await {
        Ok(i) => i,
        Err(why) => return Ok(why),
    };
    match who {
        Who::Orchestrator(_) => authorize_who(f, who, AuthTier::Update)?,
        Who::Helper(h) => {
            if f.session_mode_async(h).await != crate::agent::mcp::HelperRunMode::ReadOnlyReview || h.issue_id() != Some(item.id.as_str()) {
                return Err("没成：只有正在审查这个工单的只读审查会话能调用 issue_review。".into());
            }
        }
    }
    let findings = a.findings.map(|f| match f {
        OneOrMany::One(one) => vec![one],
        OneOrMany::Many(many) => many,
    });
    let input = IssueReviewInput {
        revision: None,
        id: item.id,
        pass: a.pass,
        findings,
        text: a.text,
    };
    Ok(match f.issue.review_from_input_async(input).await.map_err(|e| e.message) {
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

pub async fn comment(f: &ToolRegistry, _: &Who, a: CommentArgs) -> Result<String, String> {
    let item = match f.issue_async(&a.id).await {
        Ok(i) => i,
        Err(why) => return Ok(why),
    };
    Ok(match f.issue.comment_async(&item.id, &a.text).await {
        Ok(_) => match f.worker_of_async(&item).await {
            Some(w) => format!("已经在 #{} 的工单串里跟 {} 说了", item.number, w.name),
            None => text::nobody_on(item.number),
        },
        Err(why) => format!("没带到：{}", why.message),
    })
}

pub async fn stop(f: &ToolRegistry, who: &Who, a: IdArgs) -> Result<String, String> {
    let Who::Orchestrator(route) = who else {
        return Err("没成：执行会话不能叫停工单。".into());
    };
    let item = match f.issue_async(&a.id).await {
        Ok(i) => i,
        Err(why) => return Ok(why),
    };
    let Some(w) = f.worker_of_async(&item).await else {
        if route.user {
            return Ok(match f.issue.stop_with_pause_async(&item.id, HumanPauseSource::UserChat).await {
                Ok(()) => format!("#{} 已记录人工暂停，等待用户明确恢复", item.number),
                Err(why) => why.to_string(),
            });
        }
        return Ok(text::nobody_on(item.number));
    };
    let res = if route.user {
        f.issue
            .stop_with_pause_async(&item.id, HumanPauseSource::UserChat)
            .await
            .map_err(|e| e.to_string())
    } else {
        f.runtime.stop_async(&w.id).await.map(|_| ()).map_err(|e| e.message)
    };
    Ok(match res {
        Ok(()) => format!("#{} 这一轮叫停了", item.number),
        Err(why) => why,
    })
}

#[derive(Deserialize)]
pub struct Nothing {}

pub async fn sessions(f: &ToolRegistry, _: &Who, _: Nothing) -> Result<String, String> {
    let all = f.roster_async().await;
    if all.is_empty() {
        return Ok("现在没有在场的帮工。".into());
    }
    let mut lines = Vec::with_capacity(all.len());
    for h in &all {
        lines.push(f.session_line_async(h).await);
    }
    Ok(lines.join("\n"))
}

/// Who the orchestrator's issue goes to: the one it names, else for a start or a draft the best fit.
async fn chosen_async(f: &ToolRegistry, who: &Who, named: Option<&str>, brief: &str, needed: bool) -> Result<Option<String>, String> {
    let named = named.unwrap_or("");
    if named.is_empty() && !needed {
        return Ok(None);
    }
    let picked = match who {
        Who::Orchestrator(r) if named.is_empty() => r.picked.as_str(),
        _ => "",
    };
    match f.profile.fleet.choose_async(brief, named, picked).await {
        Some(a) => Ok(Some(a.id)),
        None if named.is_empty() => Err(text::NO_AGENT_TO_DISPATCH.into()),
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
    #[serde(rename = "deliveryReceipt")]
    delivery_receipt: Option<DeliveryReceipt>,
    priority: Option<String>,
    agent: Option<String>,
    owner: Option<ActorRef>,
    #[serde(rename = "blockedBy")]
    blocked_by: Option<Vec<String>>,
    relations: Option<Vec<IssueRelation>>,
    attachments: Option<Vec<String>>,
}

pub async fn update(f: &ToolRegistry, who: &Who, a: UpdateArgs) -> Result<String, String> {
    let item = match f.issue_async(&a.id).await {
        Ok(i) => i,
        Err(why) => return Ok(why),
    };
    let helper_receipt_only = matches!(who, Who::Helper(h) if h.issue_id() == Some(item.id.as_str()))
        && a.delivery_receipt.is_some()
        && a.title.is_none()
        && a.description.is_none()
        && a.repo.is_none()
        && a.criteria.is_none()
        && a.deliver.is_none()
        && a.priority.is_none()
        && a.agent.is_none()
        && a.owner.is_none()
        && a.blocked_by.is_none()
        && a.relations.is_none()
        && a.attachments.is_none();
    if !helper_receipt_only {
        authorize_who(f, who, AuthTier::Update)?;
    }
    let mut req = IssueUpdateInput {
        id: item.id.clone(),
        title: a.title,
        description: a.description,
        repo: a.repo,
        criteria: a.criteria,
        deliver: a.deliver,
        delivery_receipt: a.delivery_receipt,
        attachments: a.attachments,
        owner: a.owner,
        blocked_by: a.blocked_by,
        relations: a.relations,
        ..Default::default()
    };
    if let Some(pr) = given(&a.priority) {
        let pr = text::priority_named(pr).ok_or(PRIORITIES)?;
        req.priority = Some(pr);
    }
    if let Some(name) = given(&a.agent) {
        let Some(profile) = f.profile.named(name) else {
            return Ok(text::no_profile_named(name));
        };
        req.agent = Some(profile.id);
    }
    Ok(match f.issue.update_from_input_async(req).await.map_err(|e| e.message) {
        Ok(done) => format!(
            "改好了：{}",
            text::slice_from(&text::issue_line(&done, &f.who_of_async(&done).await, f.ctx.now()), 2)
        ),
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
    #[serde(rename = "deliveryReceipt")]
    delivery_receipt: Option<DeliveryReceipt>,
}

pub async fn status(f: &ToolRegistry, who: &Who, a: StatusArgs) -> Result<String, String> {
    let to = text::status_named(&a.status).ok_or_else(|| format!("Expected one of: {}", text::STATUS_WORDS))?;
    let tier = if to == IssueStatus::Done { AuthTier::Done } else { AuthTier::Update };
    authorize_who(f, who, tier)?;
    let item = match f.issue_async(&a.id).await {
        Ok(i) => i,
        Err(why) => return Ok(why),
    };
    let mut req = IssueStatusUpdateInput {
        revision: None,
        id: item.id.clone(),
        status: to,
        text: given(&a.text).map(String::from),
        agent: None,
        edit: None,
        delivery_receipt: a.delivery_receipt,
        request_key: None,
    };
    let needed = to == IssueStatus::Todo && item.status == IssueStatus::Backlog && item.assigned_agent().is_none();
    match chosen_async(f, who, given(&a.agent), &format!("{}\n{}", item.title, item.description), needed).await {
        Ok(Some(agent)) => req.agent = Some(agent),
        Ok(None) => {}
        Err(why) => return Ok(format!("没挪：{why}")),
    }
    if let Who::Orchestrator(route) = who
        && route.user
        && to == IssueStatus::Todo
        && item.mandate.strength == MandateStrength::Inferred
    {
        let mut upgraded = IssueMandate::explicit(&route.envelope, item.mandate.auto_submit_pr);
        upgraded.max_bot_review_rounds = item.mandate.max_bot_review_rounds;
        let _ = f.issue.set_mandate_async(&item.id, upgraded).await;
    }
    Ok(match f.issue.status_from_input_async(&req).await.map_err(|e| e.message) {
        Ok(done) => {
            if to == IssueStatus::Done && done.status == IssueStatus::Done {
                format!("#{} {}", done.number, text::closed(&done))
            } else {
                format!(
                    "挪好了：{}",
                    text::slice_from(&text::issue_line(&done, &f.who_of_async(&done).await, f.ctx.now()), 2)
                )
            }
        }
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
    relations: Option<Vec<IssueRelation>>,
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
    owner: Option<ActorRef>,
    attachments: Option<Vec<String>>,
}

/// `issue_create`: written down, and sent when asked (`start`).
pub async fn create(f: &ToolRegistry, who: &Who, a: CreateArgs) -> Result<String, String> {
    let Who::Orchestrator(route) = who else {
        return Err("没成：执行会话不能通过 issue_create 建单，请使用 issue_split 拆分子工单。".into());
    };
    if a.start && a.draft {
        return Ok("没记：起草交回来以前开不了工。要马上做就不起草；要起草就先不开工。".into());
    }
    if a.start || a.draft {
        authorize_orchestrator(f, route, AuthTier::CreateAndStart)?;
    }
    if a.auto_submit_pr == Some(true) && !route.user {
        return Err("没记：仅在用户当轮明确授权时才允许开启自动提交 PR。".into());
    }
    let mandate = if route.user {
        IssueMandate::explicit(&route.envelope, a.auto_submit_pr == Some(true))
    } else if is_approved_cron(f, route) {
        IssueMandate::explicit(&format!("cron:{}", route.cron_id.as_deref().unwrap_or("")), false)
    } else {
        IssueMandate::inferred(&route.envelope)
    };
    let here = route.channel.clone();
    let mut channel = f.chat.top_of(&here);
    if let Some(name) = given(&a.channel) {
        match f.chat.channel_by_name(name) {
            Some(c) => channel = c,
            None => return Ok(format!("没有 {name} 这个频道：先用 channel_list 看看有哪些，或者用 channel_create 开一个。")),
        }
    }
    let mut req = IssueRequest {
        title: a.title.clone(),
        description: a.description.clone(),
        deliver: a.deliver,
        parent: a.parent,
        blocked_by: a.blocked_by,
        relations: a.relations,
        auto_submit_pr: a.auto_submit_pr,
        owner: a.owner,
        attachments: a.attachments,
        ..Default::default()
    };
    match given(&a.repo) {
        Some(r) => req.repo = Some(r.into()),
        None if !channel.repo.is_empty() => req.repo = Some(channel.repo.clone()),
        None if a.start => return Ok(format!("没记：#{} 没有默认仓库：填上 repo。", channel.name)),
        None => {}
    }
    if let Some(pr) = given(&a.priority) {
        match text::priority_named(pr) {
            Some(pr) => req.priority = Some(pr),
            None => return Ok(PRIORITIES.into()),
        }
    }
    let brief = format!("{}\n{}", a.title, a.description.clone().unwrap_or_default());
    match chosen_async(f, who, given(&a.agent), &brief, a.start).await {
        Ok(Some(agent)) => req.agent = Some(agent),
        Ok(None) => {}
        Err(why) => return Ok(format!("没记：{why}")),
    }
    let applied = match f.issue.create_from_request_with_mandate_async(&req, Some(mandate)).await.map_err(|e| e.message) {
        Ok(i) => i,
        Err(why) => return Ok(format!("没记下：{why}")),
    };
    let answer = if applied.deliver == Deliverable::Answer {
        "（只查、交结论，不改代码）"
    } else {
        ""
    };
    let noted = format!("记下了：#{}「{}」{answer}", applied.number, vibevalley_core::rules::short_title(&applied.title));
    if a.draft {
        return Ok(
            match f
                .issue
                .refine_async(&IssueRefineInput {
                    id: applied.id.clone(),
                    ..Default::default()
                })
                .await
                .map_err(|e| e.message)
            {
                Ok(_) => format!("{noted}，在备选里，帮工在起草"),
                Err(why) => format!("{noted}，在备选里；起草没开始：{why}"),
            },
        );
    }
    if !a.start {
        return Ok(format!("{noted}，在备选里，没开工"));
    }
    if let Err(why) = f
        .issue
        .status_from_input_async(&IssueStatusUpdateInput {
            revision: None,
            id: applied.id.clone(),
            status: IssueStatus::Todo,
            text: None,
            agent: None,
            edit: None,
            delivery_receipt: None,
            request_key: None,
        })
        .await
        .map_err(|e| e.message)
    {
        return Ok(format!(
            "{noted}，在备选里；没开工：{why}。要再开工用 issue_status_update 挪到待办，不要再建一张"
        ));
    }
    let Ok(now_item) = f.issue_async(&applied.id).await else {
        return Ok(format!("{noted}，在 #{} 排进待办：有空位就开工", channel.name));
    };
    Ok(match f.worker_of_async(&now_item).await {
        Some(h) => {
            let where_at = now_item
                .repo
                .as_deref()
                .filter(|r| !r.is_empty())
                .map(|r| format!("去 {r}"))
                .unwrap_or_else(|| "开工".to_string());
            format!("{noted}，已在 #{} 派 {}（{}）{where_at}", channel.name, h.name, h.id)
        }
        None => format!("{noted}，在 #{} 排进待办：有空位就开工", channel.name),
    })
}

/// The helper calling, and the issue it works on.
async fn helper_issue_async(f: &ToolRegistry, who: &Who) -> Result<(vibevalley_protocol::Session, Issue), String> {
    let Who::Helper(me) = who else {
        return Err("这个工具只给帮工用".into());
    };
    let id = me.issue_id().ok_or("当前不是正在处理工单的帮工会话")?;
    let issue = f.ctx.service.issue.get(id).await.ok().flatten().ok_or("当前不是正在处理工单的帮工会话")?;
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
    title: Option<String>,
    #[serde(default)]
    tasks: Vec<Task>,
}

pub async fn split(f: &ToolRegistry, who: &Who, a: SplitArgs) -> Result<String, String> {
    if let Who::Orchestrator(route) = who {
        authorize_orchestrator(f, route, AuthTier::Split)?;
    }
    let (me, mut issue) = helper_issue_async(f, who).await?;
    let mode = RunMode::from_session_issue(&me, Some(&issue));
    if mode != RunMode::Execution {
        return Err(format!("没成：当前{}模式只读，不能调用 issue_split。", mode.label_zh()));
    }
    if issue.mandate.strength != MandateStrength::Explicit {
        return Err("没成：当前工单缺少用户或已批准定时的明确授权（Inferred Mandate），不能拆分子工单。".into());
    }
    if issue.mandate.is_paused() {
        return Err("没成：工单已由人工暂停，不能拆分子工单。".into());
    }
    if let Some(title) = given(&a.title) {
        issue = f
            .issue
            .edit_async(
                &issue.id,
                &vibevalley_protocol::IssueUpdate {
                    title: Some(title.into()),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| e.to_string())?;
    }
    let drafts: Vec<ChildDraft> = a
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
    let children = f.issue.split_async(&issue.id, drafts).await.map_err(|e| e.to_string())?;
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
    #[serde(rename = "deliveryReceipt")]
    delivery_receipt: Option<DeliveryReceipt>,
}

pub async fn report(f: &ToolRegistry, who: &Who, a: ReportArgs) -> Result<String, String> {
    let Ok((me, issue)) = helper_issue_async(f, who).await else {
        return Ok("当前不是正在处理工单的帮工会话，不能交回。 ".into());
    };
    let mode = RunMode::from_session_issue(&me, Some(&issue));
    if mode == RunMode::Drafting {
        return Err("没成：当前起草模式只读，不能调用 issue_report。".into());
    }
    let mut delivery_receipt = a.delivery_receipt;
    if a.pr_submit {
        if mode == RunMode::ReadOnlyAnswer {
            return Err("没成：当前只读问答模式不能提交 PR。".into());
        }
        let submitted_receipt = submit(f, who, Some(&a.summary)).await?;
        if delivery_receipt.is_none() {
            delivery_receipt = submitted_receipt;
        }
    }
    let report = Report {
        status: if a.questions.is_empty() { ReportStatus::Done } else { ReportStatus::Blocked },
        summary: a.summary,
        questions: a.questions,
        answer: a.answer,
        checks: a.checks,
        remember: a.remember,
        delivery_receipt,
    };
    f.runtime.report_async(&me.id, &report).await.map_err(|e| e.to_string())?;
    Ok("报告已记录；现在用简短正文说明结果。".into())
}

#[derive(Deserialize)]
pub struct PrArgs {
    summary: Option<String>,
}

pub async fn pr_submit(f: &ToolRegistry, who: &Who, a: PrArgs) -> Result<String, String> {
    let receipt = submit(f, who, a.summary.as_deref()).await?;
    let label = match receipt.as_ref() {
        Some(DeliveryReceipt::PullRequest { url, .. }) => url.clone(),
        _ => String::new(),
    };
    Ok(format!("PR 已提交：{label}"))
}

/// `submitPullRequest`: only on the user's explicit word, on an issue that delivers by pull request.
async fn submit(f: &ToolRegistry, who: &Who, summary: Option<&str>) -> Result<Option<DeliveryReceipt>, String> {
    let (me, issue) = helper_issue_async(f, who).await.map_err(|_| t("server.issue.prSubmitNotCurrent", &[]))?;
    if issue.mandate.strength != MandateStrength::Explicit || !issue.mandate.auto_submit_pr {
        return Err(t("server.issue.prSubmitNotAllowed", &[]));
    }
    let (Deliverable::PullRequest, Some(cwd)) = (issue.deliver, me.cwd.clone()) else {
        return Err(t("server.issue.prSubmitUnavailable", &[]));
    };
    let repo = vibevalley_git::Repo::discover_async(std::path::Path::new(&cwd))
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "not a git repository".to_string())?;
    let branch = repo
        .head_async()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| t("server.issue.prSubmitUnavailable", &[]))?;
    let sha = repo.commit_id_async("HEAD").await.map_err(|e| e.to_string())?;
    let written = match vibevalley_git::read::git_path(repo.root(), std::path::Path::new("vibevalley-pr.md")) {
        Ok(p) => tokio::fs::read_to_string(&p).await.ok().and_then(|text| pull_request_text(&text)),
        Err(_) => None,
    };
    let (title, body) = written.unwrap_or_else(|| (issue.title.clone(), summary.unwrap_or("").to_string()));
    let req = SubmitBranch {
        cwd,
        branch,
        sha,
        base: f.runtime.base_branch(&me.id).unwrap_or_else(|| "main".into()),
        title,
        body,
        dry_run: None,
    };
    let data = f.pull.publish_async(&req, Some(&issue.id)).await.map_err(|e| e.message)?;
    let url = data.url.clone().unwrap_or_else(|| data.branch.clone());
    let receipt = DeliveryReceipt::PullRequest {
        url,
        number: data.number,
        branch: Some(data.branch),
        summary: summary.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
    };
    let _ = f
        .issue
        .update_from_input_async(IssueUpdateInput {
            id: issue.id.clone(),
            delivery_receipt: Some(receipt.clone()),
            ..Default::default()
        })
        .await;
    Ok(Some(receipt))
}

#[derive(Deserialize)]
pub struct DigestArgs {
    #[serde(rename = "windowHours")]
    window_hours: Option<i64>,
}

pub async fn digest_get(f: &ToolRegistry, _who: &Who, a: DigestArgs) -> Result<String, String> {
    let digest = f
        .issue
        .issue_digest_get_endpoint_async(&IssueDigestGetInput { window_hours: a.window_hours }, f.ctx.clock.as_ref())
        .await
        .map_err(|e| e.message)?;
    let mut parts = Vec::new();
    let p = &digest.progress;
    parts.push(format!(
        "## 一、近期进展与待处理\n- 待回复：{} · 待验收：{} · 卡住：{} · 进行中：{} · 近期完成：{}（运行 {} 次：完成 {} / 失败 {} / 中断 {}）",
        p.asking.len(),
        p.reviewing.len(),
        p.stuck.len(),
        p.working.len(),
        p.completed_recent.len(),
        p.runs_total,
        p.runs_completed,
        p.runs_failed,
        p.runs_interrupted,
    ));
    for item in p.asking.iter().chain(p.stuck.iter()).chain(p.reviewing.iter()).take(8) {
        parts.push(format!(
            "  - #{} {}{}",
            item.number,
            item.title,
            if item.detail.is_empty() {
                String::new()
            } else {
                format!(" — {}", item.detail)
            }
        ));
    }

    let mut health_lines = vec!["## 二、仓库健康度".to_string()];
    if digest.repo_health.is_empty() {
        health_lines.push("- 暂无已挂载仓库".into());
    } else {
        for h in &digest.repo_health {
            let status = match h.status {
                RepoHealthStatus::OnTrack => "on_track",
                RepoHealthStatus::AtRisk => "at_risk",
                RepoHealthStatus::OffTrack => "off_track",
            };
            health_lines.push(format!(
                "- {} [{}]（进行中 {}，待验收 {}，阻塞 {}，卡住 {}，逾期 {}）",
                h.repo, status, h.in_progress_issues, h.in_review_issues, h.blocked_issues, h.stuck_issues, h.overdue_issues
            ));
        }
    }
    parts.push(health_lines.join("\n"));

    let mut triage_lines = vec!["## 三、备选池梳理建议（需用户在界面或明确点击确认，绝不自动覆盖）".to_string()];
    if digest.triage.is_empty() {
        triage_lines.push("- 暂无待确认的备选池建议".into());
    } else {
        for s in &digest.triage {
            triage_lines.push(format!(
                "- [{}] #{} {}：{}（原因：{}）",
                s.id, s.issue_number, s.issue_title, s.summary, s.reason
            ));
        }
    }
    parts.push(triage_lines.join("\n"));
    Ok(parts.join("\n\n"))
}

#[derive(Deserialize)]
pub struct TriageSuggestArgs {
    #[serde(rename = "issueId")]
    issue_id: String,
    reason: String,
    summary: Option<String>,
    priority: Option<String>,
    repo: Option<String>,
    agent: Option<String>,
    tags: Option<Vec<String>>,
    status: Option<String>,
    relations: Option<Vec<IssueRelation>>,
}

pub async fn triage_suggest(f: &ToolRegistry, who: &Who, a: TriageSuggestArgs) -> Result<String, String> {
    let Who::Orchestrator(_) = who else {
        return Err("没成：只有主助手能提交备选池梳理建议。".into());
    };
    let priority: Option<Priority> = match given(&a.priority) {
        Some(p) => Some(text::priority_named(p).ok_or(PRIORITIES)?),
        None => None,
    };
    let status = match given(&a.status) {
        Some(s) => Some(text::status_named(s).ok_or_else(|| format!("Expected one of: {}", text::STATUS_WORDS))?),
        None => None,
    };
    let created = f
        .issue
        .issue_triage_suggest_endpoint_async(
            Caller::Orchestrator,
            BacklogTriageSuggestInput {
                issue_id: a.issue_id,
                reason: a.reason,
                summary: a.summary,
                patch: TriagePatch {
                    priority,
                    repo: a.repo,
                    agent: a.agent,
                    tags: a.tags,
                    status,
                    relations: a.relations,
                    due_at: None,
                },
            },
            f.ctx.clock.as_ref(),
        )
        .await
        .map_err(|e| e.message)?;
    Ok(format!(
        "已记下备选池建议（尚未改动工单，等待用户点击确认）：[{}] #{} {} -> {}",
        created.id, created.issue_number, created.issue_title, created.summary
    ))
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
