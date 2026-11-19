//! `chat`: talk with a local coding runtime via `vibevalley-oar` or with the
//! assistant in a channel (`--orchestrator`).

use std::io::{BufRead, IsTerminal, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use clap::{ArgMatches, Command};
use serde::{Deserialize, Serialize};
use vibevalley_i18n::t;
use vibevalley_oar::{
    AgentError, ContentBlock, Event, EventKind, Installation, PermissionDecision, PermissionMode, Session as OarSession, SessionOptions, StopReason, Usage,
};
use vibevalley_protocol::{Actor, AgentRole, ChannelMessageListInput, ChatMessage, PhaseView, SayRequest, ops};

use crate::farm::{Ctx, Done, Failure, Format, decode_failure, exit, no_dry_run};
use crate::tree::{arg, cmd, flag, get, int, joined, maybe_words, number, on, text};

pub fn command() -> Command {
    cmd(
        "chat",
        "cli.command.chat",
        &[
            ("cli.example.chatLocal.run", "cli.example.chatLocal.about"),
            ("cli.example.chatOrchestrator.run", "cli.example.chatOrchestrator.about"),
        ],
    )
    .args([
        maybe_words("words", "cli.arg.message"),
        text("runtime", "cli.flag.runtime").default_value("vibevalley"),
        text("cwd", "cli.flag.cwd"),
        text("model", "cli.flag.model"),
        text("effort", "cli.flag.effort"),
        text("resume", "cli.flag.resume"),
        flag("plan", "cli.flag.plan"),
        flag("orchestrator", "cli.flag.orchestrator"),
        text("channel", "cli.flag.channel").default_value("general"),
        int("timeout", "cli.flag.timeout").default_value("120"),
    ])
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalReply {
    session: String,
    runtime: String,
    text: String,
    reason: StopReason,
    usage: Usage,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OrchestratorReply {
    channel: String,
    messages: Vec<ChatMessage>,
}

pub fn run(ctx: &Ctx, m: &ArgMatches) -> Done {
    if ctx.dry_run {
        return Err(no_dry_run("chat"));
    }
    let prompt = joined(m, "words");
    if on(m, "orchestrator") {
        let channel = arg(m, "channel");
        let timeout = number(m, "timeout").unwrap_or(120).max(1) as u64;
        if !prompt.is_empty() {
            return orchestrator_turn(ctx, &channel, &prompt, timeout);
        }
        return interactive_loop(|line| orchestrator_turn(ctx, &channel, line, timeout));
    }
    run_local(ctx, m, prompt)
}

fn map_oar_error(e: AgentError) -> Failure {
    match e {
        AgentError::UnknownRuntime(_) | AgentError::Unsupported { .. } => Failure::usage("InvalidValue", e.to_string()),
        AgentError::NotAvailable(_) | AgentError::Rejected(_) => Failure::new(exit::REFUSED, "Refused", e.to_string()),
        AgentError::Io(_) | AgentError::Protocol(_) => Failure::new(exit::OTHER, "Runtime", e.to_string()),
    }
}

fn run_local(ctx: &Ctx, m: &ArgMatches, initial: String) -> Done {
    let runtime_id = arg(m, "runtime");
    let registry = vibevalley_oar::default_runtimes();
    let runtime = registry.require(&runtime_id).map_err(map_oar_error)?;
    match runtime.installation() {
        Installation::Available { .. } => {}
        Installation::LoginRequired { .. } => return Err(map_oar_error(AgentError::NotAvailable(format!("{runtime_id} requires a local sign-in")))),
        Installation::NotInstalled => return Err(map_oar_error(AgentError::NotAvailable(runtime_id))),
        Installation::Unusable { reason } => return Err(map_oar_error(AgentError::NotAvailable(reason))),
    }
    let cwd = match get(m, "cwd") {
        Some(p) => PathBuf::from(p),
        None => std::env::current_dir().map_err(|e| Failure::new(exit::OTHER, "File", e.to_string()))?,
    };
    let plan = on(m, "plan");
    let opts = SessionOptions {
        cwd,
        model: get(m, "model"),
        resume: get(m, "resume"),
        permission_mode: if plan { PermissionMode::Plan } else { PermissionMode::Bypass },
        effort: get(m, "effort"),
        ..Default::default()
    };
    let session = runtime.open(opts).map_err(map_oar_error)?;
    let mut events = session.events_with_history().into_iter();
    let res = if !initial.is_empty() {
        local_turn(ctx, &session, &mut events, &initial, plan, false)
    } else {
        let id = session.id();
        if ctx.format == Format::Text {
            eprintln!("{}", t("cli.chat.session", &[("session", id.into())]));
        }
        interactive_loop(|line| local_turn(ctx, &session, &mut events, line, plan, ctx.format == Format::Text))
    };
    session.dispose();
    res
}

fn local_turn(ctx: &Ctx, session: &Arc<dyn OarSession>, events: &mut dyn Iterator<Item = Event>, prompt: &str, plan: bool, stream: bool) -> Done {
    session.prompt(vec![ContentBlock::Text(prompt.to_string())]).map_err(map_oar_error)?;
    let mut text = String::new();
    let mut last_error: Option<String> = None;
    loop {
        let Some(ev) = events.next() else {
            return Err(Failure::new(exit::OTHER, "Runtime", "session stream ended"));
        };
        if !ev.agent_path.is_empty() {
            continue;
        }
        match ev.kind {
            EventKind::TextDelta { text: delta } => {
                if stream {
                    print!("{delta}");
                    let _ = std::io::stdout().flush();
                }
                text.push_str(&delta);
            }
            EventKind::PermissionRequested { request_id, .. } => {
                let decision = if plan {
                    PermissionDecision::Deny { message: None }
                } else {
                    PermissionDecision::AllowOnce
                };
                let _ = session.respond_permission(&request_id, decision);
            }
            EventKind::Error { message } => {
                last_error = Some(message);
            }
            EventKind::TurnFinished { reason, usage } => {
                if stream && !text.ends_with('\n') && !text.is_empty() {
                    println!();
                }
                if reason == StopReason::Error {
                    return Err(Failure::new(exit::OTHER, "Runtime", last_error.unwrap_or_else(|| "round failed".into())));
                }
                if !stream {
                    let reply = LocalReply {
                        session: session.id(),
                        runtime: session.runtime_id().to_string(),
                        text,
                        reason,
                        usage,
                    };
                    ctx.show(&reply, |r| r.text.trim_end_matches('\n').to_string());
                }
                return Ok(());
            }
            EventKind::SessionEnded => {
                return Err(Failure::new(exit::OTHER, "Runtime", last_error.unwrap_or_else(|| "session ended".into())));
            }
            EventKind::SessionStarted { .. }
            | EventKind::TurnStarted { .. }
            | EventKind::ThinkingDelta { .. }
            | EventKind::ToolCallStarted { .. }
            | EventKind::ToolCallFinished { .. }
            | EventKind::FileChanged { .. }
            | EventKind::PermissionResolved { .. }
            | EventKind::SubagentSpawned { .. }
            | EventKind::SubagentMessage { .. }
            | EventKind::SubagentPlanUpdated { .. }
            | EventKind::SubagentWait { .. }
            | EventKind::SubagentStatusChanged { .. }
            | EventKind::Question { .. } => {}
        }
    }
}

#[derive(Deserialize)]
struct OrchestratorFrame {
    state: OrchestratorState,
}

#[derive(Deserialize)]
struct OrchestratorState {
    sessions: Vec<OrchestratorSession>,
}

#[derive(Deserialize)]
struct OrchestratorSession {
    role: AgentRole,
    phase: PhaseView,
}

fn orchestrator_turn(ctx: &Ctx, channel: &str, prompt: &str, timeout_secs: u64) -> Done {
    ctx.ask::<ops::OrchestratorOpen>(&())?;
    let before = ctx
        .ask::<ops::ChannelMessageList>(&ChannelMessageListInput {
            id: channel.to_string(),
            limit: Some(1),
            before: None,
        })?
        .last()
        .map(|m| m.number)
        .unwrap_or(0);
    ctx.ask::<ops::ChannelMessageSend>(&SayRequest {
        id: channel.to_string(),
        text: prompt.to_string(),
        ..Default::default()
    })?;
    let mut saw_working = false;
    let mut replies: Vec<ChatMessage> = vec![];
    ctx.events("/api/v1/state", Some(Duration::from_secs(timeout_secs)), |data| {
        let frame: OrchestratorFrame = serde_json::from_str(data).map_err(decode_failure)?;
        let working = frame
            .state
            .sessions
            .iter()
            .any(|s| s.role == AgentRole::Orchestrator && matches!(s.phase, PhaseView::Working(_)));
        if working {
            saw_working = true;
            return Ok(true);
        }
        let recent = ctx.ask::<ops::ChannelMessageList>(&ChannelMessageListInput {
            id: channel.to_string(),
            limit: Some(20),
            before: None,
        })?;
        replies = recent
            .into_iter()
            .filter(|m| m.number > before && !matches!(m.actor, Actor::User { .. }))
            .collect();
        Ok(replies.is_empty() && !saw_working)
    })?;
    let out = OrchestratorReply {
        channel: channel.to_string(),
        messages: replies,
    };
    ctx.show(&out, |r| {
        r.messages.iter().map(|m| m.text.trim_end_matches('\n')).collect::<Vec<_>>().join("\n\n")
    });
    Ok(())
}

fn interactive_loop(mut on_line: impl FnMut(&str) -> Done) -> Done {
    let stdin = std::io::stdin();
    let tty = stdin.is_terminal();
    let mut reader = stdin.lock();
    let mut buf = String::new();
    loop {
        if tty {
            eprint!("> ");
            let _ = std::io::stderr().flush();
        }
        buf.clear();
        let n = reader.read_line(&mut buf).map_err(|e| Failure::new(exit::OTHER, "File", e.to_string()))?;
        if n == 0 {
            return Ok(());
        }
        let trimmed = buf.trim();
        if trimmed.is_empty() {
            continue;
        }
        if matches!(trimmed, "/exit" | "/quit") {
            return Ok(());
        }
        on_line(trimmed)?;
    }
}
