//! `channel`, `repo`, `agent`, `session`, `runtime`, `memory`, `cron` and `artifact`.

use clap::{ArgMatches, Command};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    Agent, AgentDeleteInput, AgentRole, Artifact, ArtifactGetInput, ArtifactListRequest, ArtifactReadRequest, Build, Channel, ChannelMessageListInput,
    ChatMessage, Cron, CronDeleteInput, CronRequest, CronUpdateInput, CronWhen, CronWhenDaily, CronWhenEvery, CronWhenExpr, CronWhenOnce, Head, Look, Memory,
    MemoryCreateInput, MemoryDeleteInput, MemoryListInput, MemorySearchInput, MessageSearch, NewRepo, OrchestratorLook, Outfit, PersonaMode, Phase,
    RepoSummary, RuntimeInfo, RuntimeRefreshInput, SayRequest, Session, SessionEvent, SessionEventListInput, SessionGetInput, SessionListInput,
    SessionStopInput, Species, SubmitBranch, ops,
};

use crate::farm::{Ctx, Done, Failure, issue_ref, line, one_line};
use crate::tree::{arg, choice, cmd, get, group, int, joined, number, pos, text, words};

fn more(flag: String) -> String {
    t("cli.more", &[("flag", flag.into())])
}

// channel

fn channel_line(c: &Channel) -> String {
    let unread = c.unread.filter(|n| *n > 0).map(|n| format!("unread {n}")).unwrap_or_default();
    let name = c.name.clone().unwrap_or_else(|| c.title.clone());
    line(&[&format!("#{name}"), c.r#type.as_str(), if c.default { "default" } else { "" }, &unread])
}

fn message_line(m: &ChatMessage) -> String {
    format!("#{}  {}: {}", m.number, m.name, one_line(&m.text))
}

pub fn channel() -> Command {
    group(
        "channel",
        "cli.group.channel.about",
        vec![
            cmd(
                "list",
                "cli.command.channel.list",
                &[("vibevalley channel list", "cli.example.channelList.about")],
            ),
            group(
                "message",
                "cli.group.channel.message.about",
                vec![
                    cmd(
                        "list",
                        "cli.command.channel.messageList",
                        &[("vibevalley channel message list general --limit 10", "cli.example.channelMessageList.about")],
                    )
                    .args([
                        pos("channel", "cli.arg.channel"),
                        int("limit", "cli.flag.limit").default_value("20"),
                        int("before", "cli.flag.before"),
                    ]),
                    cmd(
                        "send",
                        "cli.command.channel.messageSend",
                        &[("cli.example.channelMessageSend.run", "cli.example.channelMessageSend.about")],
                    )
                    .args([
                        pos("channel", "cli.arg.channel"),
                        words("words", "cli.arg.message"),
                        int("reply", "cli.flag.reply"),
                    ]),
                    cmd(
                        "search",
                        "cli.command.channel.messageSearch",
                        &[("cli.example.channelMessageSearch.run", "cli.example.channelMessageSearch.about")],
                    )
                    .arg(words("words", "cli.arg.search")),
                ],
            ),
        ],
    )
}

pub fn run_channel(ctx: &Ctx, m: &ArgMatches) -> Done {
    match m.subcommand() {
        Some(("list", _)) => {
            let all = ctx.ask::<ops::ChannelList>(&())?;
            ctx.show(&all, |cs| cs.iter().map(channel_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }
        Some(("message", m)) => match m.subcommand() {
            Some(("list", m)) => {
                let request = ChannelMessageListInput {
                    id: arg(m, "channel"),
                    limit: number(m, "limit"),
                    before: number(m, "before"),
                };
                let messages = ctx.ask::<ops::ChannelMessageList>(&request)?;
                ctx.show(&messages, |ms| {
                    let mut lines: Vec<String> = ms.iter().map(message_line).collect();
                    if let Some(first) = ms.first().filter(|f| f.number > 1) {
                        lines.push(more(format!("--before {}", first.number)));
                    }
                    lines.join("\n")
                });
                Ok(())
            }
            Some(("send", m)) => {
                let channel = arg(m, "channel");
                let request = SayRequest {
                    id: channel.clone(),
                    text: joined(m, "words"),
                    reply_to: number(m, "reply"),
                    ..Default::default()
                };
                ctx.change::<ops::ChannelMessageSend>("channel message send", None, &request, |_| {
                    t("cli.channel.sent", &[("channel", channel.into())])
                })
            }
            Some(("search", m)) => {
                let hits = ctx.ask::<ops::ChannelMessageSearch>(&MessageSearch {
                    text: joined(m, "words"),
                    ..Default::default()
                })?;
                ctx.show(&hits, |hs| {
                    hs.iter()
                        .map(|h| format!("{}  {}", h.channel, message_line(&h.message)))
                        .collect::<Vec<_>>()
                        .join("\n")
                });
                Ok(())
            }
            _ => Ok(()),
        },
        _ => Ok(()),
    }
}

// repo

fn repo_line(p: &RepoSummary) -> String {
    line(&[
        &p.name,
        &p.path,
        if p.git { "git" } else { "" },
        if p.pull_request.available { "pr" } else { "" },
    ])
}

pub fn repo() -> Command {
    let required = |name: &'static str| text(name, "").required(true);
    group(
        "repo",
        "cli.group.repo.about",
        vec![
            group(
                "pr",
                "cli.repo.publish",
                vec![
                    cmd("submit", "cli.repo.publish", &[(
                        "vibevalley repo pr submit --cwd /path/to/repo --branch feat/topic --sha <full-sha> --base main --title <title> --body <body> --dry-run",
                        "cli.repo.publish",
                    )])
                    .args([required("cwd"), required("branch"), required("sha"), required("base"), required("title"), required("body")]),
                ],
            ),
            cmd("list", "cli.command.repo.list", &[("vibevalley repo list", "cli.example.repoList.about")]),
            cmd("create", "cli.command.repo.create", &[("vibevalley repo create web --repo https://github.com/me/web", "cli.example.repoCreate.about")])
                .args([pos("name", "cli.arg.repoName"), text("repo", "cli.flag.repo")]),
        ],
    )
}

pub fn run_repo(ctx: &Ctx, m: &ArgMatches) -> Done {
    match m.subcommand() {
        Some(("pr", m)) => {
            let Some(("submit", m)) = m.subcommand() else { return Ok(()) };
            let request = SubmitBranch {
                cwd: arg(m, "cwd"),
                branch: arg(m, "branch"),
                sha: arg(m, "sha"),
                base: arg(m, "base"),
                title: arg(m, "title"),
                body: arg(m, "body"),
                dry_run: Some(ctx.dry_run),
            };
            let r = ctx.ask::<ops::RepoPrSubmit>(&request)?;
            ctx.show(&r, |r| match &r.url {
                Some(url) => format!("{url}\n{}", t("cli.repo.check", &[("check", r.check.as_str().into())])),
                None => t(
                    "cli.repo.preview",
                    &[
                        ("branch", r.branch.clone().into()),
                        ("sha", r.sha.clone().into()),
                        ("base", r.base.clone().into()),
                    ],
                ),
            });
            Ok(())
        }
        Some(("list", _)) => {
            let all = ctx.ask::<ops::RepoList>(&())?;
            ctx.show(&all, |ps| ps.iter().map(repo_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }
        Some(("create", m)) => {
            let request = NewRepo {
                name: arg(m, "name"),
                github: get(m, "repo"),
            };
            ctx.change::<ops::RepoCreate>("repo create", None, &request, repo_line)
        }
        _ => Ok(()),
    }
}

// agent

fn agent_line(a: &Agent) -> String {
    line(&[&a.id, &a.name, a.role.as_str(), &a.runtime, if a.enabled { "" } else { "off" }])
}

pub fn agent() -> Command {
    group(
        "agent",
        "cli.group.agent.about",
        vec![
            cmd("list", "cli.command.agent.list", &[("vibevalley agent list", "cli.example.agentList.about")]),
            cmd(
                "create",
                "cli.command.agent.create",
                &[("vibevalley agent create fox --runtime claude", "cli.example.agentCreate.about")],
            )
            .args([
                pos("name", "cli.arg.agentName"),
                text("runtime", "cli.flag.runtime").default_value("vibevalley"),
                choice("role", AgentRole::ALL.iter().map(|r| r.as_str()), "cli.flag.role").default_value("worker"),
                text("duty", "cli.flag.duty").default_value(""),
                text("model", "cli.flag.model").default_value(""),
                text("effort", "cli.flag.effort").default_value(""),
            ]),
            cmd(
                "delete",
                "cli.command.agent.delete",
                &[("vibevalley agent delete docs --dry-run", "cli.example.agentDelete.about")],
            )
            .arg(pos("agent", "cli.arg.agent")),
        ],
    )
}

pub fn run_agent(ctx: &Ctx, m: &ArgMatches) -> Done {
    match m.subcommand() {
        Some(("list", _)) => {
            let all = ctx.ask::<ops::AgentList>(&())?;
            ctx.show(&all, |a| a.iter().map(agent_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }
        Some(("create", m)) => {
            let role = AgentRole::ALL
                .iter()
                .copied()
                .find(|r| r.as_str() == arg(m, "role"))
                .unwrap_or(AgentRole::Worker);
            let profile = Agent {
                id: String::new(),
                name: arg(m, "name"),
                role,
                duty: arg(m, "duty"),
                enabled: true,
                runtime: arg(m, "runtime"),
                model: arg(m, "model"),
                effort: arg(m, "effort"),
                persona: String::new(),
                persona_mode: PersonaMode::Append,
                skills: vec![],
                mcp_servers: vec![],
                disallowed_tools: vec![],
                env: Default::default(),
                workdir: String::new(),
                worktree: true,
                tags: vec![],
                look: Look {
                    orchestrator: (role == AgentRole::Orchestrator).then_some(OrchestratorLook::Farmer),
                    species: (role == AgentRole::Worker).then_some(Species::Fox),
                    outfit: (role == AgentRole::Worker).then_some(Outfit::Farmer),
                    build: Build::Biped,
                    head: Head::Rounded,
                    body: String::new(),
                    trim: String::new(),
                    hat: String::new(),
                    eye: String::new(),
                },
                from: None,
            };
            ctx.change::<ops::AgentCreate>("agent create", None, &profile, agent_line)
        }
        Some(("delete", m)) => {
            let id = arg(m, "agent");
            ctx.change::<ops::AgentDelete>("agent delete", Some("agent.previewDelete"), &AgentDeleteInput { id: id.clone() }, |_| {
                t("cli.agent.deleted", &[("agent", id.into())])
            })
        }
        _ => Ok(()),
    }
}

// session

fn phase_tag(p: &Phase) -> &'static str {
    match p {
        Phase::Working(_) => "working",
        Phase::Done(_) => "done",
        Phase::Failed(_) => "failed",
        Phase::Resting(_) => "resting",
        Phase::Closed(_) => "closed",
    }
}

fn session_line(s: &Session) -> String {
    let issue = s.issue.as_ref().map(|i| format!("issue {i}")).unwrap_or_default();
    let repo = s.repo.as_ref().map(|r| format!("[{r}]")).unwrap_or_default();
    line(&[&s.id, &s.name, &format!("@{}", s.agent), phase_tag(&s.phase), &issue, &repo])
}

fn session_event_line(e: &SessionEvent) -> String {
    let tool = e.tool.as_deref().or_else(|| e.action.map(|a| a.as_str())).unwrap_or("");
    let detail = [&e.text, e.input.as_deref().unwrap_or(""), e.output.as_deref().unwrap_or("")]
        .into_iter()
        .map(one_line)
        .find(|s| !s.is_empty())
        .unwrap_or_default();
    let ok = match e.ok {
        Some(true) => "ok",
        Some(false) => "fail",
        None => "",
    };
    line(&[&e.seq.to_string(), e.r#type.as_str(), tool, &detail, ok])
}

pub fn session() -> Command {
    group(
        "session",
        "cli.group.session.about",
        vec![
            cmd(
                "list",
                "cli.command.session.list",
                &[("vibevalley session list", "cli.example.sessionList.about")],
            )
            .arg(text("agent", "cli.flag.agent")),
            cmd(
                "show",
                "cli.command.session.show",
                &[("vibevalley session show w3", "cli.example.sessionShow.about")],
            )
            .arg(pos("session", "cli.arg.session")),
            cmd(
                "events",
                "cli.command.session.events",
                &[("vibevalley session events w3", "cli.example.sessionEvents.about")],
            )
            .args([pos("session", "cli.arg.session"), text("run", "cli.flag.run"), int("limit", "cli.flag.limit")]),
            cmd(
                "stop",
                "cli.command.session.stop",
                &[("vibevalley session stop w3", "cli.example.sessionStop.about")],
            )
            .arg(pos("session", "cli.arg.session")),
        ],
    )
}

pub fn run_session(ctx: &Ctx, m: &ArgMatches) -> Done {
    match m.subcommand() {
        Some(("list", m)) => {
            let all = ctx.ask::<ops::SessionList>(&SessionListInput { agent: get(m, "agent") })?;
            ctx.show(&all, |ss| ss.iter().map(session_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }
        Some(("show", m)) => {
            let s = ctx.ask::<ops::SessionGet>(&SessionGetInput { id: arg(m, "session") })?;
            ctx.show(&s, |x| {
                [
                    session_line(x),
                    x.brief.lines().next().unwrap_or("").to_string(),
                    x.worktree.clone().unwrap_or_default(),
                ]
                .into_iter()
                .filter(|l| !l.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
            });
            Ok(())
        }
        Some(("events", m)) => {
            let mut events = ctx.ask::<ops::SessionEventList>(&SessionEventListInput {
                id: arg(m, "session"),
                run: get(m, "run"),
            })?;
            if let Some(limit) = number(m, "limit").map(|n| n.max(0) as usize)
                && events.len() > limit
            {
                let start = events.len() - limit;
                events.drain(..start);
            }
            ctx.show(&events, |es| es.iter().map(session_event_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }
        Some(("stop", m)) => {
            let id = arg(m, "session");
            ctx.change::<ops::SessionStop>("session stop", None, &SessionStopInput { id: id.clone() }, |_| {
                t("cli.session.stopped", &[("session", id.into())])
            })
        }
        _ => Ok(()),
    }
}

// runtime

fn runtime_line(r: &RuntimeInfo) -> String {
    use vibevalley_protocol::Installation;
    let state = match &r.installation {
        Installation::Available(a) => format!("{} {}", a.version.clone().unwrap_or_default(), a.command).trim().to_string(),
        Installation::Unsupported(failure) if failure.sign_in_command.is_some() => "login_required".into(),
        Installation::NotFound(_) => "not_found".into(),
        Installation::Checking(_) => "checking".into(),
        Installation::Unsupported(_) => "unsupported".into(),
    };
    format!("{}  {state}", r.id)
}

pub fn runtime() -> Command {
    group(
        "runtime",
        "cli.group.runtime.about",
        vec![
            cmd(
                "list",
                "cli.command.runtime.list",
                &[("vibevalley runtime list", "cli.example.runtimeList.about")],
            ),
            cmd(
                "refresh",
                "cli.command.runtime.refresh",
                &[("vibevalley runtime refresh claude", "cli.example.runtimeRefresh.about")],
            )
            .arg(pos("runtime", "cli.arg.runtime")),
        ],
    )
}

pub fn run_runtime(ctx: &Ctx, m: &ArgMatches) -> Done {
    match m.subcommand() {
        Some(("list", _)) => {
            let all = ctx.ask::<ops::RuntimeList>(&())?;
            ctx.show(&all, |rs| rs.iter().map(runtime_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }
        Some(("refresh", m)) => ctx.change::<ops::RuntimeRefresh>("runtime refresh", None, &RuntimeRefreshInput { id: arg(m, "runtime") }, runtime_line),
        _ => Ok(()),
    }
}

// memory

fn memory_line(m: &Memory) -> String {
    let repo = m.repo.as_ref().map(|r| format!("[{r}]")).unwrap_or_default();
    line(&[&m.id, &format!("@{}", m.agent), m.kind.as_str(), &repo, &one_line(&m.text)])
}

pub fn memory() -> Command {
    group(
        "memory",
        "cli.group.memory.about",
        vec![
            cmd(
                "list",
                "cli.command.memory.list",
                &[("vibevalley memory list docs", "cli.example.memoryList.about")],
            )
            .arg(pos("agent", "cli.arg.agent")),
            cmd(
                "search",
                "cli.command.memory.search",
                &[("cli.example.memorySearch.run", "cli.example.memorySearch.about")],
            )
            .args([words("words", "cli.arg.search"), text("agent", "cli.flag.agent"), text("repo", "cli.flag.repo")]),
            cmd(
                "create",
                "cli.command.memory.create",
                &[("cli.example.memoryCreate.run", "cli.example.memoryCreate.about")],
            )
            .args([
                pos("agent", "cli.arg.agent"),
                words("words", "cli.arg.memory"),
                text("repo", "cli.flag.repo"),
                text("key", "cli.flag.key"),
            ]),
            cmd(
                "delete",
                "cli.command.memory.delete",
                &[("vibevalley memory delete docs m1 --dry-run", "cli.example.memoryDelete.about")],
            )
            .args([pos("agent", "cli.arg.agent"), pos("memory", "cli.arg.memoryId")]),
        ],
    )
}

pub fn run_memory(ctx: &Ctx, m: &ArgMatches) -> Done {
    match m.subcommand() {
        Some(("list", m)) => {
            let found = ctx.ask::<ops::MemoryList>(&MemoryListInput { agent: arg(m, "agent") })?;
            ctx.show(&found, |x| x.memories.iter().map(memory_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }
        Some(("search", m)) => {
            let request = MemorySearchInput {
                text: Some(joined(m, "words")),
                agent: get(m, "agent"),
                repo: get(m, "repo"),
            };
            let found = ctx.ask::<ops::MemorySearch>(&request)?;
            ctx.show(&found, |f| {
                f.found
                    .iter()
                    .map(|m| {
                        let repo = m.repo.as_ref().map(|r| format!("[{r}]")).unwrap_or_default();
                        line(&[&m.id, &format!("@{}", m.agent), m.kind.as_str(), &repo, &one_line(&m.text)])
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            });
            Ok(())
        }
        Some(("create", m)) => {
            let request = MemoryCreateInput {
                agent: arg(m, "agent"),
                text: joined(m, "words"),
                repo: get(m, "repo"),
                request_key: get(m, "key"),
            };
            ctx.change::<ops::MemoryCreate>("memory create", None, &request, memory_line)
        }
        Some(("delete", m)) => {
            let request = MemoryDeleteInput {
                agent: arg(m, "agent"),
                memory: arg(m, "memory"),
            };
            let id = request.memory.clone();
            ctx.change::<ops::MemoryDelete>("memory delete", Some("memory.previewDelete"), &request, |_| {
                t("cli.memory.deleted", &[("memory", id.into())])
            })
        }
        _ => Ok(()),
    }
}

// cron

fn when_text(w: &CronWhen) -> String {
    match w {
        CronWhen::Once(o) => format!("once {}", jiff::Timestamp::from_millisecond(o.at).map(|t| t.to_string()).unwrap_or_default()),
        CronWhen::Every(e) => format!("every {}m", e.minutes),
        CronWhen::Daily(d) => format!("daily {}", d.time),
        CronWhen::Weekly(w) => format!("weekly {} {}", w.days.iter().map(i64::to_string).collect::<Vec<_>>().join(","), w.time),
        CronWhen::Cron(c) => format!("cron {}", c.expr),
    }
}

fn cron_line(c: &Cron) -> String {
    line(&[&c.id, &c.name, &when_text(&c.when), if c.enabled { "" } else { "off" }, &one_line(&c.text)])
}

pub fn cron() -> Command {
    group(
        "cron",
        "cli.group.cron.about",
        vec![
            cmd("list", "cli.command.cron.list", &[("vibevalley cron list", "cli.example.cronList.about")]),
            cmd(
                "create",
                "cli.command.cron.create",
                &[("cli.example.cronCreate.run", "cli.example.cronCreate.about")],
            )
            .args([
                pos("name", "cli.arg.cronName"),
                words("words", "cli.arg.cronText"),
                int("every", "cli.flag.every"),
                text("daily", "cli.flag.daily"),
                text("cron", "cli.flag.cronExpr"),
                text("at", "cli.flag.at"),
                text("channel", "cli.flag.channel"),
                text("agent", "cli.flag.agent"),
                text("repo", "cli.flag.repo"),
            ]),
            cmd(
                "edit",
                "cli.command.cron.edit",
                &[("vibevalley cron edit c1 --enabled false", "cli.example.cronEdit.about")],
            )
            .args([
                pos("cron", "cli.arg.cron"),
                choice("enabled", ["true", "false"], "cli.flag.enabled").required(true),
            ]),
            cmd(
                "delete",
                "cli.command.cron.delete",
                &[("vibevalley cron delete c1 --dry-run", "cli.example.cronDelete.about")],
            )
            .arg(pos("cron", "cli.arg.cron")),
        ],
    )
}

fn parse_at(raw: &str) -> Result<i64, Failure> {
    if let Ok(ts) = raw.parse::<jiff::Timestamp>() {
        return Ok(ts.as_millisecond());
    }
    if let Ok(zoned) = raw.parse::<jiff::ZonedDateTime>() {
        return Ok(zoned.timestamp().as_millisecond());
    }
    if let Ok(dt) = raw.parse::<jiff::civil::DateTime>()
        && let Ok(zoned) = dt.to_zoned_datetime(jiff::tz::TimeZone::system())
    {
        return Ok(zoned.timestamp().as_millisecond());
    }
    Err(Failure::usage("InvalidValue", t("cli.cron.invalidAt", &[("at", raw.to_string().into())])))
}

/// When, from the one flag given of `--every`, `--daily`, `--cron`, `--at`.
fn when_of(m: &ArgMatches) -> Result<CronWhen, Failure> {
    let every = number(m, "every");
    let daily = get(m, "daily");
    let expr = get(m, "cron");
    let at = get(m, "at");
    let count = usize::from(every.is_some()) + usize::from(daily.is_some()) + usize::from(expr.is_some()) + usize::from(at.is_some());
    if count != 1 {
        let mut f = Failure::usage("InvalidValue", t("cli.cron.when", &[]));
        f.next = vec![vibevalley_protocol::Next {
            say: t("cli.next.help", &[]),
            run: Some(vec!["cron".into(), "create".into(), "--help".into()]),
        }];
        return Err(f);
    }
    if let Some(minutes) = every {
        return Ok(CronWhen::Every(CronWhenEvery { minutes }));
    }
    if let Some(time) = daily {
        return Ok(CronWhen::Daily(CronWhenDaily { time }));
    }
    if let Some(expr) = expr {
        return Ok(CronWhen::Cron(CronWhenExpr { expr }));
    }
    Ok(CronWhen::Once(CronWhenOnce {
        at: parse_at(&at.unwrap_or_default())?,
    }))
}

pub fn run_cron(ctx: &Ctx, m: &ArgMatches) -> Done {
    match m.subcommand() {
        Some(("list", _)) => {
            let all = ctx.ask::<ops::CronList>(&())?;
            ctx.show(&all, |cs| cs.iter().map(cron_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }
        Some(("create", m)) => {
            let request = CronRequest {
                name: arg(m, "name"),
                text: joined(m, "words"),
                when: when_of(m)?,
                channel: get(m, "channel"),
                agent: get(m, "agent"),
                repo: get(m, "repo"),
                tz: None,
            };
            ctx.change::<ops::CronCreate>("cron create", None, &request, cron_line)
        }
        Some(("edit", m)) => {
            let id = arg(m, "cron");
            let request = CronUpdateInput {
                id: id.clone(),
                enabled: Some(arg(m, "enabled") == "true"),
            };
            ctx.change::<ops::CronUpdate>("cron edit", None, &request, |_| t("cli.cron.edited", &[("cron", id.into())]))
        }
        Some(("delete", m)) => {
            let id = arg(m, "cron");
            ctx.change::<ops::CronDelete>("cron delete", Some("cron.previewDelete"), &CronDeleteInput { id: id.clone() }, |_| {
                t("cli.cron.deleted", &[("cron", id.into())])
            })
        }
        _ => Ok(()),
    }
}

// artifact

fn artifact_line(a: &Artifact) -> String {
    let issue = a.issue.as_ref().map(|i| format!("issue {i}")).unwrap_or_default();
    line(&[&a.id, &a.title, a.body.as_str(), &format!("@{}", a.by_name), &issue])
}

pub fn artifact() -> Command {
    group(
        "artifact",
        "cli.group.artifact.about",
        vec![
            cmd(
                "list",
                "cli.command.artifact.list",
                &[("vibevalley artifact list --issue 12", "cli.example.artifactList.about")],
            )
            .arg(text("issue", "cli.flag.issue")),
            cmd(
                "show",
                "cli.command.artifact.show",
                &[("vibevalley artifact show a1", "cli.example.artifactShow.about")],
            )
            .arg(pos("artifact", "cli.arg.artifact")),
            cmd(
                "read",
                "cli.command.artifact.read",
                &[("vibevalley artifact read a1", "cli.example.artifactRead.about")],
            )
            .arg(pos("artifact", "cli.arg.artifact")),
        ],
    )
}

pub fn run_artifact(ctx: &Ctx, m: &ArgMatches) -> Done {
    match m.subcommand() {
        Some(("list", m)) => {
            let all = ctx.ask::<ops::ArtifactList>(&ArtifactListRequest {
                issue: get(m, "issue").map(|i| issue_ref(&i)),
                channel: None,
            })?;
            ctx.show(&all, |a| a.iter().map(artifact_line).collect::<Vec<_>>().join("\n"));
            Ok(())
        }
        Some(("show", m)) => {
            let a = ctx.ask::<ops::ArtifactGet>(&ArtifactGetInput { id: arg(m, "artifact") })?;
            ctx.show(&a, artifact_line);
            Ok(())
        }
        Some(("read", m)) => {
            let c = ctx.ask::<ops::ArtifactContentGet>(&ArtifactReadRequest {
                id: arg(m, "artifact"),
                version: None,
            })?;
            ctx.show(&c, |x| x.content.clone());
            Ok(())
        }
        _ => Ok(()),
    }
}
