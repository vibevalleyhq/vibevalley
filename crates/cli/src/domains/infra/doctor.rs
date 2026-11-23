//! `doctor`: verify home/channel, server health, SSE `/api/v1/slice/board`, runtimes, and model key.

use std::path::PathBuf;
use std::time::Duration;

use clap::Args;
use serde::Serialize;
use vibevalley_protocol::{BoardSlice, Installation, KeySource, Next, ops};

use crate::client::{Client, Done, Failure, ServerSource, decode_failure, exit};
use crate::output::line;

#[derive(Debug, Args)]
#[command(after_help = "Examples:\n  vibevalley doctor\n  vibevalley doctor --json")]
pub struct DoctorCmd {
    /// Timeout in seconds for the /api/v1/slice/board SSE check
    #[arg(long, default_value_t = 5)]
    pub timeout: i64,
}

#[derive(Serialize)]
#[serde(untagged)]
enum DoctorCheck {
    Home {
        check: &'static str,
        ok: bool,
        channel: &'static str,
        home: PathBuf,
        server: String,
        from: &'static str,
    },
    Server {
        check: &'static str,
        ok: bool,
        version: String,
    },
    State {
        check: &'static str,
        ok: bool,
        seq: i64,
    },
    Runtimes {
        check: &'static str,
        ok: bool,
        installed: Vec<String>,
    },
    Model {
        check: &'static str,
        ok: bool,
        from: KeySource,
    },
    Failed {
        check: &'static str,
        ok: bool,
        why: String,
        next: Vec<Next>,
    },
}

impl DoctorCheck {
    fn failed_name(&self) -> Option<&'static str> {
        match self {
            DoctorCheck::Home { ok, check, .. }
            | DoctorCheck::Server { ok, check, .. }
            | DoctorCheck::State { ok, check, .. }
            | DoctorCheck::Runtimes { ok, check, .. }
            | DoctorCheck::Model { ok, check, .. }
            | DoctorCheck::Failed { ok, check, .. } => (!*ok).then_some(*check),
        }
    }

    fn text_line(&self) -> String {
        match self {
            DoctorCheck::Home {
                channel, home, server, from, ..
            } => line(&["home", "ok", channel, server, from, &home.display().to_string()]),
            DoctorCheck::Server { ok, version, .. } => line(&["server", if *ok { "ok" } else { "fail" }, version]),
            DoctorCheck::State { seq, .. } => line(&["state", "ok", &format!("seq {seq}")]),
            DoctorCheck::Runtimes { installed, .. } => line(&["runtimes", "ok", &installed.join(", ")]),
            DoctorCheck::Model { from, .. } => line(&["model", "ok", from.as_str()]),
            DoctorCheck::Failed { check, why, .. } => line(&[check, "fail", why]),
        }
    }
}

fn render(checks: &[DoctorCheck]) -> String {
    checks.iter().map(DoctorCheck::text_line).collect::<Vec<_>>().join("\n")
}

fn failed(check: &'static str, why: String, next: Vec<Next>) -> DoctorCheck {
    DoctorCheck::Failed { check, ok: false, why, next }
}

pub fn run(client: &Client, cmd: DoctorCmd) -> Done {
    let channel = vibevalley_protocol::home::current_channel().as_str();
    let home = client.home.clone();
    let from = match client.server_source {
        ServerSource::ServerJson => "server.json",
        ServerSource::AuthFile => "auth.json",
        ServerSource::DefaultPort => "default",
        ServerSource::Flag | ServerSource::Env => "override",
    };
    let mut checks = vec![DoctorCheck::Home {
        check: "home",
        ok: true,
        channel,
        home,
        server: client.server.clone(),
        from,
    }];

    match client.ask::<ops::ServerHealthGet>(&()) {
        Ok(health) => checks.push(DoctorCheck::Server {
            check: "server",
            ok: health.ok,
            version: health.version,
        }),
        Err(failure) => {
            checks.push(failed(
                "server",
                failure.text,
                vec![Next {
                    say: "Start VibeValley (desktop app or `cargo run -p vibevalley-server`)".into(),
                    run: None,
                }],
            ));
            client.output.show(&checks, |cs| render(cs));
            return Err(Failure::new(exit::UNREACHABLE, "Doctor", format!("server unreachable at {}", client.server)));
        }
    }

    let mut state_seq: Option<i64> = None;
    let state_timeout = Duration::from_secs(cmd.timeout.max(1) as u64);
    match client.sse("/api/v1/slice/board", Some(state_timeout), |data| {
        let slice: BoardSlice = serde_json::from_str(data).map_err(decode_failure)?;
        state_seq = Some(slice.seq);
        Ok(false)
    }) {
        Ok(()) => checks.push(DoctorCheck::State {
            check: "state",
            ok: true,
            seq: state_seq.unwrap_or(0),
        }),
        Err(failure) => checks.push(failed(
            "state",
            failure.text,
            vec![Next {
                say: "Inspect /api/v1/slice/board directly".into(),
                run: Some(vec!["state".into(), "--slice".into(), "board".into(), "--json".into()]),
            }],
        )),
    }

    let runtimes = client.ask::<ops::RuntimeList>(&())?;
    let installed: Vec<String> = runtimes
        .iter()
        .filter(|r| matches!(r.installation, Installation::Available(_)))
        .map(|r| r.id.clone())
        .collect();
    checks.push(if installed.is_empty() {
        failed(
            "runtimes",
            "no coding runtimes available".into(),
            vec![Next {
                say: "Inspect runtime installation status".into(),
                run: Some(vec!["runtime".into(), "list".into()]),
            }],
        )
    } else {
        DoctorCheck::Runtimes {
            check: "runtimes",
            ok: true,
            installed,
        }
    });

    let settings = client.ask::<ops::SettingGet>(&())?;
    checks.push(match settings.deepseek_api_key.source {
        Some(source) => DoctorCheck::Model {
            check: "model",
            ok: true,
            from: source,
        },
        None => failed(
            "model",
            "no DeepSeek API key configured".into(),
            vec![Next {
                say: "Set DEEPSEEK_API_KEY or run `vibevalley setting update --deepseek-key <key>`".into(),
                run: None,
            }],
        ),
    });

    let wrong: Vec<&str> = checks.iter().filter_map(DoctorCheck::failed_name).collect();
    client.output.show(&checks, |cs| render(cs));
    if wrong.is_empty() {
        Ok(())
    } else {
        Err(Failure::new(exit::OTHER, "Doctor", format!("checks failed: {}", wrong.join(", "))))
    }
}
