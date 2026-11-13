//! The farm's tools as the orchestrator holds them (VibeValley
//! `gateway/tool`): each is an endpoint as the model sees it, its words
//! from `tools.json`, its answer worded as `gateway/tool/prompts.ts` does.

use std::sync::{Arc, Mutex, Weak};

use serde_json::{Value, json};
use vibevalley_agent::{Tool, ToolOutput, ToolSpec};
use vibevalley_issues::Board;
use vibevalley_protocol::{ActorKind, Caller, Changes, CronRequest, CronWhen, Issue, IssueStatus, IssueTimeline, Session};

use super::words::{self, ToolWords, wire};
use crate::Hub;
use crate::modules::agent::Agents;
use crate::modules::channel::{Chat, ReadOptions};
use crate::modules::cron::Crons;
use crate::modules::repo::Repos;
use crate::now;

/// Where the orchestrator is answering now (`HostContext`).
#[derive(Debug, Clone, Default)]
pub struct Route {
    pub agent: String,
    pub channel: String,
    pub envelope: String,
    /// The helper the user picked in the composer.
    pub picked: String,
    /// User-authored words are in the batch.
    pub user: bool,
}

/// What the tools reach.
pub struct Farm {
    pub media: Arc<crate::modules::media::machine::Machine>,
    pub memories: Arc<crate::modules::memory::Memories>,
    pub hub: Weak<Hub>,
    pub board: Board,
    pub chat: Arc<Chat>,
    pub agents: Arc<Agents>,
    pub repos: Arc<Repos>,
    pub crons: Arc<Crons>,
}

impl Farm {
    fn call(&self, op: &str, payload: Value) -> Result<Value, String> {
        let Some(hub) = self.hub.upgrade() else {
            return Err("the farm is closing".into());
        };
        let e = hub.call_as(Caller::Orchestrator, op, payload);
        if e.biz_code == 0 { Ok(e.data.unwrap_or(Value::Null)) } else { Err(e.message) }
    }

    fn issue(&self, key: &str) -> Result<Issue, String> {
        let key = key.trim();
        let k = key.trim_start_matches('#');
        let found = self.board.read(|s| {
            s.issues.iter().find(|i| i.id == key || i.number.to_string() == k).cloned().or_else(|| {
                // A helper working it, by its id or name.
                let on = s.sessions.iter().filter(|h| h.id == k || h.name == k).max_by_key(|h| h.hired_at)?;
                s.issues.iter().find(|i| Some(&i.id) == on.issue.as_ref()).cloned()
            })
        });
        found.ok_or_else(|| words::no_issue(key))
    }

    fn worker_of(&self, issue: &Issue) -> Option<Session> {
        let last = issue.latest_session_id()?;
        self.board.read(|s| s.sessions.iter().find(|h| &h.id == last).cloned())
    }

    fn who_of(&self, issue: &Issue) -> String {
        if let Some(w) = self.worker_of(issue) {
            return w.name;
        }
        match issue.assigned_agent() {
            Some(vibevalley_protocol::DEFAULT_ORCHESTRATOR) => "助手".into(),
            Some(a) => self.agents.profiles.agent(a).map(|p| p.name).unwrap_or_default(),
            None => String::new(),
        }
    }

    fn number_of(&self, session: &Session) -> Option<i64> {
        let issue = session.issue.as_ref()?;
        self.board.read(|s| s.issues.iter().find(|i| &i.id == issue).map(|i| i.number))
    }

    /// `sessionLine` for every helper on the farm.
    pub fn roster(&self) -> Vec<Session> {
        self.board.read(|s| {
            s.sessions
                .iter()
                .filter(|h| h.role == vibevalley_protocol::AgentRole::Worker)
                .cloned()
                .collect()
        })
    }

    pub fn session_line(&self, h: &Session) -> String {
        words::session_line(h, now(), self.number_of(h))
    }

    fn channel_named(&self, name: &str) -> Option<crate::modules::channel::Info> {
        self.chat
            .channel_by_name(name)
            .or_else(|| self.chat.channels().into_iter().find(|c| c.id == name))
    }
}

/// One tool: an endpoint the orchestrator calls.
pub struct FarmTool {
    words: ToolWords,
    farm: Arc<Farm>,
    route: Arc<Mutex<Route>>,
}

/// The orchestrator's tools, in VibeValley's order.
pub fn farm_tools(farm: &Arc<Farm>, route: &Arc<Mutex<Route>>) -> Vec<Box<dyn Tool>> {
    words::TOOLS
        .iter()
        .map(|w| {
            Box::new(FarmTool {
                words: w.clone(),
                farm: farm.clone(),
                route: route.clone(),
            }) as Box<dyn Tool>
        })
        .collect()
}

fn s<'a>(args: &'a Value, k: &str) -> Option<&'a str> {
    args.get(k).and_then(Value::as_str).filter(|v| !v.trim().is_empty())
}

impl Tool for FarmTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: self.words.name.clone(),
            description: self.words.description.clone(),
            parameters: self.words.parameters.clone(),
        }
    }

    fn replay_safe(&self) -> bool {
        matches!(
            self.words.op.as_str(),
            "issue.list"
                | "issue.get"
                | "issue.diff.get"
                | "session.list"
                | "channel.message.list"
                | "channel.list"
                | "repo.list"
                | "cron.list"
                | "memory.search"
                | "media.job.get"
                | "media.job.list"
                | "pkm.search"
                | "pkm.page.get"
                | "library.item.list"
                | "artifact.list"
                | "artifact.get"
                | "artifact.content.get"
        )
    }

    fn execute(&self, args: &Value) -> ToolOutput {
        let route = self.route.lock().unwrap_or_else(|e| e.into_inner()).clone();
        match self.run(args, &route) {
            Ok(text) => ToolOutput::ok(text),
            Err(why) => ToolOutput::error(why),
        }
    }
}

impl FarmTool {
    fn run(&self, p: &Value, here: &Route) -> Result<String, String> {
        let f = &self.farm;
        let id = s(p, "id").unwrap_or("");
        match self.words.op.as_str() {
            "media.image.create" => {
                if !here.user {
                    return Err(vibevalley_i18n::t("server.media.userRequired", &[]));
                }
                let request = serde_json::from_value(p.clone()).map_err(|e| format!("invalid image request: {e}"))?;
                let job = f
                    .media
                    .create(
                        request,
                        vibevalley_protocol::MediaSource::Orchestrator {
                            agent: here.agent.clone(),
                            channel: here.channel.clone(),
                        },
                    )
                    .map_err(|e| e.message)?;
                serde_json::to_string(&job).map_err(|e| e.to_string())
            }
            "media.job.get" | "media.job.list" | "media.job.cancel" | "media.job.download" => {
                serde_json::to_string(&f.call(&self.words.op, p.clone())?).map_err(|e| e.to_string())
            }
            "pkm.search"
            | "pkm.page.get"
            | "pkm.capture"
            | "pkm.comment.suggest"
            | "library.item.list"
            | "library.item.add"
            | "artifact.list"
            | "artifact.get"
            | "artifact.content.get"
            | "artifact.create"
            | "artifact.version.create"
            | "artifact.block.create"
            | "artifact.block.update"
            | "artifact.block.delete" => {
                let mut payload = p.clone();
                if self.words.op == "artifact.create" && payload["channel"].is_null() && !here.channel.is_empty() {
                    payload["channel"] = json!(here.channel);
                }
                serde_json::to_string(&f.call(&self.words.op, payload)?).map_err(|e| e.to_string())
            }
            "issue.list" => {
                let mut filter = json!({});
                for k in ["text", "repo", "closed", "wantsUser"] {
                    if let Some(v) = p.get(k).filter(|v| !v.is_null()) {
                        filter[k] = v.clone();
                    }
                }
                if let Some(st) = s(p, "status") {
                    let st = words::status_named(st).ok_or_else(|| format!("Expected one of: {}", words::STATUS_WORDS))?;
                    filter["status"] = json!(wire(&st));
                }
                let found: Vec<Issue> = serde_json::from_value(f.call("issue.list", filter)?).map_err(|e| e.to_string())?;
                if found.is_empty() {
                    return Ok(if p["wantsUser"] == json!(true) {
                        "没有在等用户的工单。"
                    } else {
                        "没有这样的工单。"
                    }
                    .into());
                }
                let limit = p["limit"].as_f64().filter(|l| *l > 0.0).map(|l| l as usize).unwrap_or(20);
                let at = now();
                let mut out: Vec<String> = found.iter().take(limit).map(|i| words::issue_line(i, &f.who_of(i), at)).collect();
                let mut text = out.join("\n");
                if found.len() > limit {
                    text += &format!("\n（还有 {} 张没列）", found.len() - limit);
                }
                out.clear();
                Ok(text)
            }
            "issue.get" => {
                let item = match f.issue(id) {
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
            "issue.diff.get" => {
                let item = match f.issue(id) {
                    Ok(i) => i,
                    Err(why) => return Ok(why),
                };
                Ok(match f.call("issue.diff.get", json!({ "id": item.id })) {
                    Ok(v) => match serde_json::from_value::<Changes>(v) {
                        Ok(c) => words::changes_text(&c),
                        Err(e) => format!("看不了改动：{e}"),
                    },
                    Err(why) => format!("看不了改动：{why}"),
                })
            }
            "issue.review" => {
                let item = match f.issue(id) {
                    Ok(i) => i,
                    Err(why) => return Ok(why),
                };
                let pass = p["pass"].as_bool().unwrap_or(false);
                let mut req = json!({ "id": item.id, "pass": pass });
                for k in ["findings", "text"] {
                    if !p[k].is_null() {
                        req[k] = p[k].clone();
                    }
                }
                match f
                    .call("issue.review", req)
                    .and_then(|v| serde_json::from_value::<Issue>(v).map_err(|e| e.to_string()))
                {
                    Ok(done) if pass => Ok(format!("#{} 验收过了，等用户点完成", done.number)),
                    Ok(done) => Ok(format!(
                        "#{} 没过验收，{} 处要修，已经交回给帮工",
                        done.number,
                        done.findings.iter().filter(|x| !x.resolved).count()
                    )),
                    Err(why) => Ok(why),
                }
            }
            "issue.comment.create" => {
                let item = match f.issue(id) {
                    Ok(i) => i,
                    Err(why) => return Ok(why),
                };
                let text = s(p, "text").unwrap_or("");
                match f.call("issue.comment.create", json!({ "id": item.id, "text": text })) {
                    Ok(_) => Ok(match f.worker_of(&item) {
                        Some(w) => format!("已经在 #{} 的工单串里跟 {} 说了", item.number, w.name),
                        None => words::nobody_on(item.number),
                    }),
                    Err(why) => Ok(format!("没带到：{why}")),
                }
            }
            "session.stop" => {
                let item = match f.issue(id) {
                    Ok(i) => i,
                    Err(why) => return Ok(why),
                };
                let Some(w) = f.worker_of(&item) else {
                    return Ok(words::nobody_on(item.number));
                };
                match f.call("session.stop", json!({ "id": w.id })) {
                    Ok(_) => Ok(format!("#{} 这一轮叫停了", item.number)),
                    Err(why) => Ok(why),
                }
            }
            "session.list" => {
                let all = f.roster();
                Ok(if all.is_empty() {
                    "现在没有在场的帮工。".into()
                } else {
                    all.iter().map(|h| f.session_line(h)).collect::<Vec<_>>().join("\n")
                })
            }
            "issue.create" => Ok(self.create(p, here)),
            "issue.update" => {
                let item = match f.issue(id) {
                    Ok(i) => i,
                    Err(why) => return Ok(why),
                };
                let mut req = json!({ "id": item.id });
                for k in ["title", "description", "repo", "criteria", "deliver"] {
                    if !p[k].is_null() {
                        req[k] = p[k].clone();
                    }
                }
                if let Some(pr) = s(p, "priority") {
                    let pr = words::priority_named(pr).ok_or("Expected one of: 紧急, 高, 普通, 中, 低, urgent, high, medium, low")?;
                    req["priority"] = json!(wire(&pr));
                }
                if let Some(a) = s(p, "agent") {
                    let Some(profile) = f.agents.profiles.named(a) else {
                        return Ok(words::no_profile_named(a));
                    };
                    req["agent"] = json!(profile.id);
                }
                Ok(match f.call("issue.update", req).and_then(|_| f.issue(&item.id)) {
                    Ok(done) => format!("改好了：{}", words::slice_from(&words::issue_line(&done, &f.who_of(&done), now()), 2)),
                    Err(why) => format!("没改：{why}"),
                })
            }
            "issue.status.update" => {
                let item = match f.issue(id) {
                    Ok(i) => i,
                    Err(why) => return Ok(why),
                };
                let to = words::status_named(s(p, "status").unwrap_or("")).ok_or_else(|| format!("Expected one of: {}", words::STATUS_WORDS))?;
                let mut req = json!({ "id": item.id, "status": wire(&to) });
                if let Some(text) = s(p, "text") {
                    req["text"] = json!(text);
                }
                let named = s(p, "agent").unwrap_or("");
                if !named.is_empty() || (to == IssueStatus::Todo && item.status == IssueStatus::Backlog && item.assigned_agent().is_none()) {
                    let brief = format!("{}\n{}", item.title, item.description.clone());
                    match f.agents.fleet.choose(&brief, named, if named.is_empty() { &here.picked } else { "" }) {
                        Some(a) => req["agent"] = json!(a.id),
                        None if named.is_empty() => return Ok(format!("没挪：{}", words::NO_AGENT_TO_DISPATCH)),
                        None => return Ok(format!("没挪：没有叫 {named} 的帮工档案或 runtime")),
                    }
                }
                Ok(match f.call("issue.status.update", req).and_then(|_| f.issue(&item.id)) {
                    Ok(done) if to == IssueStatus::Done && done.status == IssueStatus::Done => {
                        format!("#{} {}", done.number, words::closed(&done))
                    }
                    Ok(done) => format!("挪好了：{}", words::slice_from(&words::issue_line(&done, &f.who_of(&done), now()), 2)),
                    Err(why) => format!("没挪：{why}"),
                })
            }
            "channel.message.list" => {
                let mut target = id.to_string();
                if target.is_empty() {
                    target = f.chat.address_of(&here.channel).1;
                }
                let me = f.chat.orchestrator_in(&here.channel);
                let opt = ReadOptions {
                    target: Some(target),
                    unread: p["unread"] == json!(true),
                    before: p["before"].as_f64().filter(|b| *b != 0.0).map(|b| b as i64),
                    limit: p["limit"].as_f64().filter(|b| *b != 0.0).map(|b| b as i64),
                };
                let unread = opt.unread;
                Ok(match f.chat.read(&me, opt) {
                    Ok(r) => match r.messages.first() {
                        None if unread => format!("{} 里没有你没读的消息", r.target),
                        None => format!("{} 里还没有话", r.target),
                        Some(first) => {
                            let older = if r.older {
                                format!("（更早的还有：before:{} 往前翻）", first.number)
                            } else {
                                String::new()
                            };
                            let lines: Vec<String> = r.messages.iter().map(words::message_line).collect();
                            format!("{}{older}：\n{}", r.target, lines.join("\n"))
                        }
                    },
                    Err(e) => format!("读不了：{}", e.message),
                })
            }
            "channel.list" => Ok(f
                .chat
                .channels()
                .iter()
                .map(|c| format!("- {}", words::channel_line(&c.name, c.default, &c.description, &c.repo)))
                .collect::<Vec<_>>()
                .join("\n")),
            "channel.create" => {
                let c = f
                    .chat
                    .open_channel(s(p, "name").unwrap_or(""), s(p, "description").unwrap_or(""), s(p, "repo").unwrap_or(""))
                    .map_err(|e| e.message)?;
                Ok(format!(
                    "开好了 #{}{}。",
                    c.name,
                    if c.repo.is_empty() {
                        String::new()
                    } else {
                        format!("，默认仓库 {}", c.repo)
                    }
                ))
            }
            "channel.update" => {
                let Some(c) = f.channel_named(id) else {
                    return Err(format!("没有 {id} 这个频道"));
                };
                let mut req = json!({ "id": c.id });
                for k in ["description", "repo"] {
                    if let Some(v) = p.get(k).and_then(Value::as_str) {
                        req[k] = json!(v);
                    }
                }
                f.call("channel.update", req)?;
                Ok(format!("改好了 #{}。", c.name))
            }
            "repo.list" => {
                let all = f.repos.list();
                if all.is_empty() {
                    return Ok(format!("工作目录（{}）下还没有仓库。", f.repos.root().display()));
                }
                Ok(all
                    .iter()
                    .map(|r| format!("- {}{}", r.name, if r.git { "" } else { "（还不是 git 仓库，第一次派活时会建）" }))
                    .collect::<Vec<_>>()
                    .join("\n"))
            }
            "cron.create" => self.cron_create(p, here).or_else(|why| Ok(words::failed(&why))),
            "cron.list" => {
                let all = f.crons.list();
                if all.is_empty() {
                    return Ok("没有定时。".into());
                }
                let names: std::collections::HashMap<String, String> = f.chat.channels().into_iter().map(|c| (c.id, c.name)).collect();
                Ok(all
                    .iter()
                    .map(|c| words::cron_line(c, names.get(&c.channel).map(String::as_str).unwrap_or("?")))
                    .collect::<Vec<_>>()
                    .join("\n"))
            }
            "cron.delete" => Ok(match f.crons.remove(id) {
                Ok(c) => format!("删掉了「{}」。", c.name),
                Err(e) => words::failed(&e.message),
            }),
            "memory.search" => {
                let agent = match s(p, "agent") {
                    Some(k) => match self.profile(k) {
                        Ok(a) => a,
                        Err(why) => return Ok(words::failed(&why)),
                    },
                    None => String::new(),
                };
                let repo = p["repo"].as_str().unwrap_or("").trim();
                let text = p["text"].as_str().unwrap_or("");
                let found = f.memories.search(&agent, repo, text, 0);
                Ok(crate::modules::memory::found_text(&found, &agent, repo, text))
            }
            "memory.create" => {
                let agent = match self.profile(s(p, "agent").unwrap_or("")) {
                    Ok(a) => a,
                    Err(why) => return Ok(words::failed(&why)),
                };
                let note = crate::modules::memory::Note {
                    agent: agent.clone(),
                    text: p["text"].as_str().unwrap_or("").into(),
                    repo: p["repo"].as_str().unwrap_or("").into(),
                    by: crate::modules::memory::By::Orchestrator,
                };
                Ok(match f.memories.write(&note) {
                    Ok(m) => {
                        let place = m.repo.as_deref().map(|r| format!("仓库 {r}")).unwrap_or_else(|| "所有仓库".into());
                        format!("替 {agent} 记下了（{place}）〔{}〕", m.id)
                    }
                    Err(e) => words::failed(&e.message),
                })
            }
            op => Err(format!("{op} is not served by VibeValley yet")),
        }
    }

    /// A helper profile the orchestrator names; its own notes are `remember`'s.
    fn profile(&self, key: &str) -> Result<String, String> {
        const OWN: &str = "你自己的记性在系统提示里：要记用 remember";
        let k = key.trim();
        if k == "助手" {
            return Err(OWN.into());
        }
        let profiles = &self.farm.agents.profiles;
        let a = profiles
            .named(k)
            .or_else(|| profiles.agent(k))
            .or_else(|| profiles.orchestrators().into_iter().find(|o| o.name == k));
        match a {
            Some(a) if profiles.is_orchestrator(&a.id) => Err(OWN.into()),
            Some(a) => Ok(a.id),
            None => Err(words::no_profile_named(k)),
        }
    }

    fn cron_create(&self, p: &Value, here: &Route) -> Result<String, String> {
        let f = &self.farm;
        let mut channel = f.chat.top_of(&here.channel);
        if let Some(name) = s(p, "channel") {
            channel = f
                .chat
                .channel_by_name(name)
                .ok_or_else(|| format!("没有 {name} 这个频道：先用 channel_list 看看"))?;
        }
        let w = &p["when"];
        let when = match w["kind"].as_str().unwrap_or("") {
            "once" => {
                let at = w["at"].as_str().unwrap_or("");
                let ms = parse_time(at).ok_or_else(|| format!("at 不是一个时间：{}", if at.is_empty() { "（没填）" } else { at }))?;
                json!({ "kind": "once", "at": ms })
            }
            "every" => json!({ "kind": "every", "minutes": w["minutes"].as_f64().unwrap_or(0.0) }),
            "daily" => json!({ "kind": "daily", "time": w["time"].as_str().unwrap_or("") }),
            "cron" => json!({ "kind": "cron", "expr": w["expr"].as_str().unwrap_or("") }),
            "weekly" => json!({
                "kind": "weekly",
                "days": w["days"].as_array().map(|d| d.iter().filter_map(Value::as_f64).map(|x| x.trunc() as i64).collect::<Vec<_>>()).unwrap_or_default(),
                "time": w["time"].as_str().unwrap_or(""),
            }),
            k => return Err(format!("Expected one of: once, every, daily, weekly, cron; got {k:?}")),
        };
        let when: CronWhen = serde_json::from_value(when).map_err(|e| e.to_string())?;
        let req = CronRequest {
            name: s(p, "name").unwrap_or("").into(),
            text: s(p, "text").unwrap_or("").into(),
            channel: Some(channel.id.clone()),
            agent: s(p, "agent").map(Into::into),
            repo: s(p, "repo").map(Into::into),
            when,
            tz: s(p, "tz").map(Into::into),
        };
        let by = if here.user { ActorKind::User } else { ActorKind::Agent };
        let made = f.crons.add(req, by).map_err(|e| e.message)?;
        let line = words::cron_line(&made, &channel.name);
        Ok(if made.pending {
            format!(
                "定好了，等用户同意才生效：\n{line}\n这一轮不是用户叫你定的，而它会反复来或直接派帮工：用户在定时任务列表里点「同意」才开始。跟用户说一声它是做什么的。"
            )
        } else {
            format!("定好了：\n{line}")
        })
    }

    /// `issue_create`: written down, and sent when asked (`start`).
    fn create(&self, p: &Value, here: &Route) -> String {
        let f = &self.farm;
        let start = p["start"] == json!(true);
        if start && p["draft"] == json!(true) {
            return "没记：起草交回来以前开不了工。要马上做就不起草；要起草就先不开工。".into();
        }
        let mut channel = f.chat.top_of(&here.channel);
        if let Some(name) = s(p, "channel") {
            match f.chat.channel_by_name(name) {
                Some(c) => channel = c,
                None => {
                    return format!("没有 {name} 这个频道：先用 channel_list 看看有哪些，或者用 channel_create 开一个。");
                }
            }
        }
        let title = s(p, "title").unwrap_or("").to_string();
        let mut req = json!({ "title": title });
        for k in ["description", "deliver", "parent", "blockedBy"] {
            if !p[k].is_null() {
                req[k] = p[k].clone();
            }
        }
        match s(p, "repo") {
            Some(r) => req["repo"] = json!(r),
            None if !channel.repo.is_empty() => req["repo"] = json!(channel.repo),
            None if start => return format!("没记：#{} 没有默认仓库：填上 repo。", channel.name),
            None => {}
        }
        if let Some(pr) = s(p, "priority") {
            match words::priority_named(pr) {
                Some(pr) => req["priority"] = json!(wire(&pr)),
                None => return "Expected one of: 紧急, 高, 普通, 中, 低, urgent, high, medium, low".into(),
            }
        }
        let named = s(p, "agent").unwrap_or("");
        if !named.is_empty() || start {
            let brief = format!("{title}\n{}", s(p, "description").unwrap_or(""));
            match f.agents.fleet.choose(&brief, named, if named.is_empty() { &here.picked } else { "" }) {
                Some(a) => req["agent"] = json!(a.id),
                None if named.is_empty() => return format!("没记：{}", words::NO_AGENT_TO_DISPATCH),
                None => return format!("没记：没有叫 {named} 的帮工档案或 runtime"),
            }
        }
        let item = match f.call("issue.create", req).and_then(|v| {
            let id = v["issue"]["id"].as_str().or_else(|| v["id"].as_str()).unwrap_or("").to_string();
            f.issue(&id)
        }) {
            Ok(i) => i,
            Err(why) => return format!("没记下：{why}"),
        };
        let noted = format!(
            "记下了：#{}「{}」{}",
            item.number,
            vibevalley_core::rules::short_title(&item.title),
            if item.deliver == vibevalley_protocol::Deliverable::Answer {
                "（只查、交结论，不改代码）"
            } else {
                ""
            }
        );
        if p["draft"] == json!(true) {
            return match f.call("issue.refine", json!({ "id": item.id })) {
                Ok(_) => format!("{noted}，在备选里，帮工在起草"),
                Err(why) => format!("{noted}，在备选里；起草没开始：{why}"),
            };
        }
        if !start {
            return format!("{noted}，在备选里，没开工");
        }
        if let Err(why) = f.call("issue.status.update", json!({ "id": item.id, "status": "todo" })) {
            return format!("{noted}，在备选里；没开工：{why}。要再开工用 issue_status_update 挪到待办，不要再建一张");
        }
        let now_item = f.issue(&item.id).unwrap_or(item);
        match f.worker_of(&now_item) {
            Some(h) => format!(
                "{noted}，已在 #{} 派 {}（{}）去 {}{}",
                channel.name,
                h.name,
                h.id,
                now_item.repo.clone().unwrap_or_default(),
                h.branch.as_deref().map(|b| format!("，分支 {b}")).unwrap_or_default()
            ),
            None => format!("{noted}，在 #{} 排进待办：有空位就开工", channel.name),
        }
    }
}

/// `parseTime`: the forms a model writes, as an ISO time with its offset.
fn parse_time(s: &str) -> Option<i64> {
    let text = s.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(t) = text.parse::<jiff::Timestamp>() {
        return Some(t.as_millisecond());
    }
    let local = text.parse::<jiff::civil::DateTime>().ok()?;
    local.to_zoned(jiff::tz::TimeZone::system()).ok().map(|z| z.timestamp().as_millisecond())
}
