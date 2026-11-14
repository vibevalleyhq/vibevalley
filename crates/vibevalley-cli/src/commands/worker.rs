//! `worker report|pr-submit|context|read|doctor`: a helper's own tools, as
//! the session whose credential file (`--worker-access-file`) names it.

use clap::{ArgMatches, Command};
use serde::Deserialize;
use serde_json::{Value, json};
use vibevalley_i18n::t;

use crate::farm::{Ctx, Done, Failure, exit};
use crate::tree::{arg, group, pos_or};

const OPERATIONS: [(&str, &str, &str); 5] = [
    ("report", "issue_report", "cli.worker.report"),
    ("pr-submit", "issue_pr_submit", "cli.worker.pr"),
    ("context", "channel_message_list", "cli.worker.context"),
    ("read", "resource_read", "cli.worker.read"),
    ("doctor", "session_list", "cli.worker.doctor"),
];

pub fn command() -> Command {
    group(
        "worker",
        "cli.worker.about",
        OPERATIONS
            .iter()
            .map(|(name, _, about)| Command::new(*name).about(t(about, &[])).arg(pos_or("json", "{}", "cli.worker.json")))
            .collect(),
    )
    .hide(true)
}

#[derive(Deserialize)]
struct Credentials {
    endpoint: String,
    token: String,
}

/// One refusal for every way the credential or the door fails: their details are never echoed.
fn refused() -> Failure {
    Failure::new(exit::REFUSED, "WorkerAccess", t("cli.worker.failed", &[]))
}

pub fn run(ctx: &Ctx, m: &ArgMatches) -> Done {
    let Some((name, m)) = m.subcommand() else { return Ok(()) };
    let Some((_, tool, _)) = OPERATIONS.iter().find(|(n, ..)| *n == name) else {
        return Ok(());
    };
    if ctx.worker_access_file.is_empty() || ctx.dry_run {
        return Err(refused());
    }
    let text = std::fs::read_to_string(&ctx.worker_access_file).map_err(|_| refused())?;
    let Credentials { endpoint, token } = serde_json::from_str(&text).map_err(|_| refused())?;
    let local = endpoint
        .strip_prefix("http://127.0.0.1:")
        .and_then(|r| r.strip_suffix("/mcp"))
        .is_some_and(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    if token.is_empty() || !local {
        return Err(refused());
    }
    let args: serde_json::Map<String, Value> = serde_json::from_str(&arg(m, "json")).map_err(|_| refused())?;
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": tool, "arguments": args } });
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
    let mut reply = agent
        .post(&endpoint)
        .header("authorization", &format!("Bearer {token}"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .send(body.to_string())
        .map_err(|_| refused())?;
    if reply.status() != 200 {
        return Err(refused());
    }
    let answer: Value = serde_json::from_str(&reply.body_mut().read_to_string().map_err(|_| refused())?).map_err(|_| refused())?;
    let result = answer.get("result").filter(|_| answer.get("error").is_none()).ok_or_else(refused)?;
    let said: String = result["content"]
        .as_array()
        .ok_or_else(refused)?
        .iter()
        .filter_map(|c| c["text"].as_str())
        .collect();
    if result["isError"] == true {
        let text: String = said.replace(&token, "[redacted]").chars().take(8000).collect();
        return Err(Failure::new(
            exit::REFUSED,
            "WorkerTool",
            if text.is_empty() { t("cli.worker.failed", &[]) } else { text },
        ));
    }
    ctx.show(result, |_| said.clone());
    Ok(())
}
