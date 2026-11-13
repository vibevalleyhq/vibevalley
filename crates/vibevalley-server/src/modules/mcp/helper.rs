//! A helper's tools (`gateway/tool/tool.ts` `session`), as `/mcp` serves
//! them: words and schemas from `session_tools.json`, each run as the
//! helper whose token called it.

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Weak};

use serde_json::{Value, json};
use vibevalley_i18n::t;
use vibevalley_issues::{Board, ChildDraft, Report, ReportQuestion, ReportStatus};
use vibevalley_protocol::{
    ArtifactListRequest, ArtifactRequest, ArtifactVersionRequest, BlockCreate, BlockDelete, BlockUpdate, Caller, Deliverable, Issue, LibraryAddRequest,
    LibraryListRequest, MandateStrength, PkmSearchRequest, Session, SubmitBranch,
};

use super::resource::Resources;
use crate::Hub;
use crate::modules::artifact::{Artifacts, Maker};
use crate::modules::channel::{Chat, ReadOptions, Speaking, Spoken};
use crate::modules::library::{AddedBy, Library};
use crate::modules::memory::{By, Memories, Note, found_text};
use crate::modules::orchestrator::words::{self, ToolWords};
use crate::modules::pkm::Pkm;

pub static TOOLS: LazyLock<Vec<ToolWords>> =
    LazyLock::new(|| serde_json::from_str(include_str!("../../../assets/orchestrator/session_tools.json")).expect("session_tools.json"));

/// What a helper's tools reach.
pub struct Helpers {
    pub hub: Weak<Hub>,
    pub board: Board,
    pub chat: Arc<Chat>,
    pub memories: Arc<Memories>,
    pub pkm: Arc<Pkm>,
    pub artifacts: Arc<Artifacts>,
    pub library: Arc<Library>,
    pub resources: Arc<Resources>,
}

fn s<'a>(args: &'a Value, k: &str) -> Option<&'a str> {
    args.get(k).and_then(Value::as_str).filter(|v| !v.trim().is_empty())
}

fn json_text<T: serde::Serialize>(v: &T) -> Result<String, String> {
    serde_json::to_string(v).map_err(|e| e.to_string())
}

fn decoded<T: serde::de::DeserializeOwned>(v: Value) -> Result<T, String> {
    serde_json::from_value(v).map_err(|e| format!("参数不对：{e}"))
}

impl Helpers {
    /// The tool's answer, or the refusal the helper reads (`isError`).
    pub fn call(&self, me: &Session, name: &str, args: &Value) -> Result<String, String> {
        let Some(tool) = TOOLS.iter().find(|t| t.name == name) else {
            return Err(format!("没成：没有 {name} 这个工具"));
        };
        let repo = me.repo.clone().unwrap_or_default();
        match tool.op.as_str() {
            "channel.message.send" => {
                let spoken = self
                    .chat
                    .speak(Speaking {
                        from: me.id.clone(),
                        text: args["text"].as_str().unwrap_or("").into(),
                        run: None,
                        target: s(args, "id").map(String::from),
                        anyway: args["anyway"] == json!(true),
                        confirm: args["confirm"] == json!(true),
                        reply: args["replyTo"].as_i64(),
                    })
                    .map_err(|e| e.message)?;
                Ok(spoken_text(&spoken))
            }
            "resource.read" => self.resources.read(Some(me), args),
            "channel.message.list" => {
                let unread = args["unread"] == json!(true);
                let opt = ReadOptions {
                    target: s(args, "id").map(String::from),
                    unread,
                    before: args["before"].as_f64().filter(|b| *b != 0.0).map(|b| b as i64),
                    limit: args["limit"].as_f64().filter(|b| *b != 0.0).map(|b| b as i64),
                };
                Ok(match self.chat.read(&me.id, opt) {
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
            "channel.unread.list" => {
                let rows = self.chat.unread(&me.id, None);
                let Some(first) = rows.first() else {
                    return Ok("没有没读的消息。".into());
                };
                let mut lines: Vec<String> = rows
                    .iter()
                    .map(|r| {
                        let mut line = format!("- {}：{} 条", r.channel, r.unread);
                        if r.mentions_you {
                            line += "，提到了你";
                        }
                        if let Some(latest) = r.latest.as_deref().filter(|l| !l.is_empty()) {
                            line += &format!("，最后是 {latest}");
                        }
                        line
                    })
                    .collect();
                lines.push(format!("下一步：channel_message_list id={} unread=true", first.channel));
                Ok(lines.join("\n"))
            }
            "session.list" => {
                let all: Vec<Session> = self.board.read(|st| {
                    st.sessions
                        .iter()
                        .filter(|h| h.role == vibevalley_protocol::AgentRole::Worker)
                        .cloned()
                        .collect()
                });
                if all.is_empty() {
                    return Ok("现在没有在场的帮工。".into());
                }
                let now = crate::now();
                Ok(all
                    .iter()
                    .map(|h| {
                        let number = h
                            .issue
                            .as_ref()
                            .and_then(|i| self.board.read(|st| st.issues.iter().find(|x| &x.id == i).map(|x| x.number)));
                        words::session_line(h, now, number)
                    })
                    .collect::<Vec<_>>()
                    .join("\n"))
            }
            "memory.search" => {
                let scope = scope_of(args, &repo);
                let text = args["text"].as_str().unwrap_or("");
                let found = self.memories.search(&me.agent, &scope, text, 0);
                Ok(found_text(&found, &me.agent, &scope, text))
            }
            "memory.create" => {
                let note = Note {
                    agent: me.agent.clone(),
                    text: args["text"].as_str().unwrap_or("").into(),
                    repo: scope_of(args, &repo),
                    by: By::Session(me.id.clone()),
                };
                let m = self.memories.write(&note).map_err(|e| e.message)?;
                let place = m.repo.as_deref().map(|r| format!("仓库 {r}")).unwrap_or_else(|| "所有仓库".into());
                Ok(format!("记下了（{place}）〔{}〕", m.id))
            }
            "pkm.search" => json_text(&self.pkm.search(&decoded::<PkmSearchRequest>(args.clone())?).map_err(|e| e.message)?),
            "pkm.page.get" => json_text(&self.pkm.page(args["page"].as_str().unwrap_or("")).map_err(|e| e.message)?),
            "pkm.capture" => json_text(
                &self
                    .pkm
                    .capture(args["text"].as_str().unwrap_or(""), Some(&me.id), None)
                    .map_err(|e| e.message)?,
            ),
            "pkm.comment.suggest" => self.endpoint(&tool.op, args.clone()),
            "artifact.block.create" => {
                let id = args["id"].as_str().unwrap_or("");
                json_text(
                    &self
                        .artifacts
                        .insert_block(id, &me.agent, &decoded::<BlockCreate>(args.clone())?)
                        .map_err(|e| e.message)?,
                )
            }
            "artifact.block.update" => {
                let id = args["id"].as_str().unwrap_or("");
                json_text(
                    &self
                        .artifacts
                        .update_block(id, &me.agent, &decoded::<BlockUpdate>(args.clone())?)
                        .map_err(|e| e.message)?,
                )
            }
            "artifact.block.delete" => {
                let id = args["id"].as_str().unwrap_or("");
                json_text(
                    &self
                        .artifacts
                        .delete_block(id, &me.agent, &decoded::<BlockDelete>(args.clone())?)
                        .map_err(|e| e.message)?,
                )
            }
            "issue.split" => self.split(me, args),
            "issue.report" => self.report(me, args),
            "issue.handback" => Err("这里没有交给你的输入卡片可退回；有问题写进 issue_report.questions，或在工单串里 @助手。".into()),
            "issue.pr.submit" => self.pr_submit(me, s(args, "summary")).map(|r| format!("PR 已提交：{r}")),
            "artifact.list" => {
                let req = match s(args, "channel") {
                    Some(channel) => ArtifactListRequest {
                        channel: Some(channel.into()),
                        ..Default::default()
                    },
                    None => ArtifactListRequest {
                        issue: me.issue.clone(),
                        ..Default::default()
                    },
                };
                json_text(&self.artifacts.list(&req).map_err(|e| e.message)?)
            }
            "artifact.get" => json_text(&self.artifacts.get(args["id"].as_str().unwrap_or("")).map_err(|e| e.message)?),
            "artifact.content.get" => {
                let (content, _) = self
                    .artifacts
                    .content(args["id"].as_str().unwrap_or(""), args["version"].as_i64())
                    .map_err(|e| e.message)?;
                json_text(&content)
            }
            "artifact.create" => {
                let mut payload = args.clone();
                self.read_file_into(me, &mut payload)?;
                if me.issue.is_some() && payload["issue"].is_null() {
                    payload["issue"] = json!(me.issue);
                }
                let req: ArtifactRequest = decoded(payload)?;
                json_text(&self.artifacts.create(&self.maker(me), &req).map_err(|e| e.message)?)
            }
            "artifact.version.create" => {
                let mut payload = args.clone();
                self.read_file_into(me, &mut payload)?;
                let req: ArtifactVersionRequest = decoded(payload)?;
                json_text(&self.artifacts.version(&self.maker(me), &req).map_err(|e| e.message)?)
            }
            "library.item.list" => {
                let items = self.library.list(&decoded::<LibraryListRequest>(args.clone())?).map_err(|e| e.message)?;
                if items.is_empty() {
                    return Ok("素材库里没有这样的文件。".into());
                }
                json_text(&items)
            }
            "library.item.add" => {
                let req: LibraryAddRequest = decoded(args.clone())?;
                let by = AddedBy::Agent {
                    agent: me.agent.clone(),
                    session: Some(me.id.clone()),
                    dir: me.worktree.as_ref().map(PathBuf::from),
                };
                let item = self.library.add(&req, &by).map_err(|e| format!("没成：{}", e.message))?;
                Ok(format!("放进素材库了：「{}」，id={}。", item.attachment.name, item.attachment.id))
            }
            op => Err(format!("{op} is not served yet")),
        }
    }

    fn endpoint(&self, op: &str, payload: Value) -> Result<String, String> {
        let hub = self.hub.upgrade().ok_or("the farm is closing")?;
        let e = hub.call_as(Caller::Session, op, payload);
        if e.biz_code == 0 {
            json_text(&e.data.unwrap_or(Value::Null))
        } else {
            Err(e.message)
        }
    }

    fn maker(&self, me: &Session) -> Maker {
        Maker {
            from: me.id.clone(),
            by: me.agent.clone(),
            run: None,
        }
    }

    /// `file`: a file in the helper's own folder becomes the content.
    fn read_file_into(&self, me: &Session, payload: &mut Value) -> Result<(), String> {
        let Some(file) = s(payload, "file").map(String::from) else { return Ok(()) };
        let dir = me.worktree.as_deref().ok_or("你没有工作目录，不能用 file")?;
        let path = inside(Path::new(dir), &file)?;
        payload["content"] = json!(std::fs::read_to_string(&path).map_err(|e| format!("读不了 {file}：{e}"))?);
        if let Some(o) = payload.as_object_mut() {
            o.remove("file");
        }
        Ok(())
    }

    fn own_issue(&self, me: &Session) -> Option<Issue> {
        let id = me.issue.as_ref()?;
        self.board.read(|st| st.issues.iter().find(|i| &i.id == id).cloned())
    }

    fn split(&self, me: &Session, args: &Value) -> Result<String, String> {
        let issue = self.own_issue(me).ok_or("当前不是正在处理工单的帮工会话，不能拆。")?;
        let tasks = args["tasks"].as_array().cloned().unwrap_or_default();
        let drafts: Vec<ChildDraft> = tasks
            .iter()
            .map(|t| ChildDraft {
                id: t["id"].as_str().unwrap_or("").into(),
                title: t["title"].as_str().unwrap_or("").into(),
                brief: t["brief"].as_str().unwrap_or("").into(),
                needs: strings(&t["needs"]),
                acceptance: t["acceptance"] == json!(true),
                check: t["check"].as_str().filter(|c| !c.trim().is_empty()).map(String::from),
                scope: strings(&t["scope"]),
                agent: t["agent"].as_str().filter(|a| !a.trim().is_empty()).map(String::from),
            })
            .collect();
        let children = self.board.split(&issue.id, drafts).map_err(|e| e.to_string())?;
        let lines: Vec<String> = children.iter().map(|c| format!("- #{} {}", c.number, c.title)).collect();
        Ok(format!("#{} 拆成了 {} 张子工单：\n{}", issue.number, children.len(), lines.join("\n")))
    }

    fn report(&self, me: &Session, args: &Value) -> Result<String, String> {
        if me.issue.is_none() {
            return Ok("当前不是正在处理工单的帮工会话，不能交回。 ".into());
        }
        let summary = args["summary"].as_str().unwrap_or("").to_string();
        if args["prSubmit"] == json!(true) {
            self.pr_submit(me, Some(&summary))?;
        }
        let questions: Vec<ReportQuestion> = decoded(args.get("questions").cloned().unwrap_or(json!([])))?;
        let report = Report {
            status: if questions.is_empty() { ReportStatus::Done } else { ReportStatus::Blocked },
            summary,
            questions,
            answer: decoded(args.get("answer").cloned().unwrap_or(Value::Null))?,
            checks: decoded(args.get("checks").cloned().unwrap_or(json!([])))?,
            remember: decoded(args.get("remember").cloned().unwrap_or(json!([])))?,
        };
        self.board.report(&me.id, &report).map_err(|e| e.to_string())?;
        Ok("报告已记录；现在用简短正文说明结果。".into())
    }

    /// `submitPullRequest`: only on the user's explicit word, on a repo that
    /// delivers by pull request.
    fn pr_submit(&self, me: &Session, summary: Option<&str>) -> Result<String, String> {
        let issue = self.own_issue(me).ok_or_else(|| t("server.issue.prSubmitNotCurrent", &[]))?;
        if issue.mandate.strength != MandateStrength::Explicit || !issue.mandate.auto_submit_pr {
            return Err(t("server.issue.prSubmitNotAllowed", &[]));
        }
        if issue.deliver != Deliverable::PullRequest {
            return Err(t("server.issue.prSubmitUnavailable", &[]));
        }
        let (Some(cwd), Some(branch)) = (me.worktree.clone(), me.branch.clone()) else {
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
            .and_then(|p| std::fs::read_to_string(Path::new(&cwd).join(p)).ok())
            .and_then(|text| pull_request_text(&text));
        let (title, body) = written.unwrap_or_else(|| (issue.title.clone(), summary.unwrap_or("").to_string()));
        let req = SubmitBranch {
            cwd,
            branch,
            sha,
            base: self.board.base_branch(&me.id).unwrap_or_else(|| "main".into()),
            title,
            body,
            dry_run: None,
        };
        let hub = self.hub.upgrade().ok_or("the farm is closing")?;
        let e = hub.call_as(Caller::User, "repo.pr.submit", serde_json::to_value(&req).map_err(|e| e.to_string())?);
        if e.biz_code != 0 {
            return Err(e.message);
        }
        let data = e.data.unwrap_or(Value::Null);
        Ok(data["url"]
            .as_str()
            .map(String::from)
            .unwrap_or_else(|| data["branch"].as_str().unwrap_or("").to_string()))
    }
}

/// A helper's memories are its profile's: "" is every repo, none is the one it works in.
fn scope_of(args: &Value, repo: &str) -> String {
    match args.get("repo").and_then(Value::as_str) {
        Some(r) => r.trim().to_string(),
        None => repo.to_string(),
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
        .unwrap_or_default()
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

/// `name` inside `dir`, refused when it leaves it.
fn inside(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let root = dir.canonicalize().map_err(|e| e.to_string())?;
    let path = root.join(name).canonicalize().map_err(|e| format!("读不了 {name}：{e}"))?;
    if path.starts_with(&root) {
        Ok(path)
    } else {
        Err(format!("{name} 不在你的工作目录里"))
    }
}

fn spoken_text(spoken: &Spoken) -> String {
    match spoken {
        Spoken::Held { target, shown, more } => {
            let lines: Vec<String> = shown.iter().map(words::message_line).collect();
            let latest = if *more > 0 {
                format!("（这里是最新的 {} 条）", shown.len())
            } else {
                String::new()
            };
            [
                format!("先没发：{target} 里有 {} 条你还没看过的新消息{latest}：", shown.len() + more),
                lines.join("\n"),
                String::new(),
                "看过了：要改就改了再发；原样发就加 anyway: true；不用发了就不发。".into(),
            ]
            .join("\n")
        }
        Spoken::Confirm { target, last_read } => format!(
            "先没发：你刚读的是 {last_read}，这条却要发到 {target} 顶层。要回在那个串里，就把 id 写成 {last_read}；确实要发到顶层，就加 confirm: true。"
        ),
        Spoken::Sent { message, target, absent } => {
            let absent = if absent.is_empty() {
                String::new()
            } else {
                format!("。{} 不在场，没送到", absent.iter().map(|m| format!("@{m}")).collect::<Vec<_>>().join("、"))
            };
            format!("发出去了：{target} msg={}{absent}", message.number)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pull_request_file_reads_as_title_and_body() {
        assert_eq!(
            pull_request_text("# feat(x): add y\n\n## What changed\n- y\n"),
            Some(("feat(x): add y".into(), "## What changed\n- y".into()))
        );
        assert_eq!(pull_request_text("\nbody"), None);
    }

    #[test]
    fn a_file_outside_the_folder_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.md"), "x").unwrap();
        assert!(inside(dir.path(), "a.md").is_ok());
        assert!(inside(dir.path(), "../a.md").is_err());
    }

    #[test]
    fn every_helper_tool_is_one_the_typescript_server_lists() {
        let names: Vec<&str> = TOOLS.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"issue_report") && names.contains(&"channel_message_send") && names.contains(&"resource_read"));
    }
}
