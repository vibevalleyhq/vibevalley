//! `chat`: talk directly with the server's orchestrator over HTTP.

use std::io::{BufRead, IsTerminal, Write};
use std::time::Duration;

use clap::Args;
use serde::Serialize;
use vibevalley_protocol::{Actor, AgentRole, ChannelMessageListInput, ChatMessage, PhaseView, SayRequest, SessionsSlice, ops};

use crate::client::{Client, Done, Failure, decode_failure, exit, no_dry_run};

#[derive(Debug, Args)]
#[command(after_help = "Examples:\n  vibevalley chat 'Summarize open issues'\n  vibevalley chat --channel general --json")]
pub struct ChatCmd {
    /// Prompt text (omit to enter an interactive stdin loop)
    #[arg(num_args = 0..)]
    pub prompt: Vec<String>,
    /// Target channel id
    #[arg(long, default_value = "general")]
    pub channel: String,
    /// Timeout in seconds per turn
    #[arg(long, default_value_t = 120)]
    pub timeout: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OrchestratorReply {
    channel: String,
    messages: Vec<ChatMessage>,
}

pub async fn run(client: &Client, cmd: ChatCmd) -> Done {
    if client.dry_run {
        return Err(no_dry_run("chat"));
    }
    let timeout = cmd.timeout.max(1) as u64;
    let prompt = cmd.prompt.join(" ");
    if !prompt.is_empty() {
        return orchestrator_turn(client, &cmd.channel, &prompt, timeout).await;
    }
    interactive_loop(async |line| orchestrator_turn(client, &cmd.channel, line, timeout).await).await
}

async fn orchestrator_turn(client: &Client, channel: &str, prompt: &str, timeout_secs: u64) -> Done {
    let before = client
        .ask::<ops::ChannelMessageList>(&ChannelMessageListInput {
            id: channel.to_string(),
            limit: Some(1),
            before: None,
        })
        .await?
        .last()
        .map(|m| m.number)
        .unwrap_or(0);
    client
        .ask::<ops::ChannelMessageSend>(&SayRequest {
            id: channel.to_string(),
            text: prompt.to_string(),
            ..Default::default()
        })
        .await?;
    let mut saw_working = false;
    let mut replies: Vec<ChatMessage> = vec![];
    client
        .sse("/api/v1/slice/sessions", Some(Duration::from_secs(timeout_secs)), async |data| {
            let slice: SessionsSlice = serde_json::from_str(data).map_err(decode_failure)?;
            let working = slice
                .sessions
                .iter()
                .any(|s| s.role == Some(AgentRole::Orchestrator) && matches!(s.phase, PhaseView::Working(_)));
            if working {
                saw_working = true;
                return Ok(true);
            }
            let recent = client
                .ask::<ops::ChannelMessageList>(&ChannelMessageListInput {
                    id: channel.to_string(),
                    limit: Some(20),
                    before: None,
                })
                .await?;
            replies = recent
                .into_iter()
                .filter(|m| m.number > before && !matches!(m.actor, Actor::User { .. }))
                .collect();
            Ok(replies.is_empty() && !saw_working)
        })
        .await?;
    let reply = OrchestratorReply {
        channel: channel.to_string(),
        messages: replies,
    };
    client.output.show(&reply, |r| {
        r.messages.iter().map(|m| m.text.trim_end_matches('\n')).collect::<Vec<_>>().join("\n\n")
    });
    Ok(())
}

async fn interactive_loop(mut on_line: impl AsyncFnMut(&str) -> Done) -> Done {
    let tty = std::io::stdin().is_terminal();
    loop {
        let Some(buf) = tokio::task::spawn_blocking(move || {
            if tty {
                eprint!("> ");
                let _ = std::io::stderr().flush();
            }
            let stdin = std::io::stdin();
            let mut reader = stdin.lock();
            let mut buf = String::new();
            let bytes = reader.read_line(&mut buf).map_err(|e| Failure::new(exit::OTHER, "File", e.to_string()))?;
            Ok::<_, Failure>((bytes > 0).then_some(buf))
        })
        .await
        .map_err(|e| Failure::new(exit::OTHER, "File", e.to_string()))??
        else {
            return Ok(());
        };
        let trimmed = buf.trim();
        if trimmed.is_empty() {
            continue;
        }
        if matches!(trimmed, "/exit" | "/quit") {
            return Ok(());
        }
        on_line(trimmed).await?;
    }
}
