//! `doctor`: this machine's VibeValley setup, checked: home, server, runtimes, model key.

use std::path::PathBuf;

use clap::Command;
use serde::Serialize;
use vibevalley_i18n::t;
use vibevalley_protocol::{KeySource, Next, ops};

use crate::farm::{Ctx, Done, Failure, exit, line};
use crate::tree::cmd;

pub fn command() -> Command {
    cmd("doctor", "cli.command.doctor", &[("vibevalley doctor", "cli.example.doctor.about")])
}

#[derive(Serialize)]
#[serde(untagged)]
enum DoctorCheck {
    Farm {
        check: &'static str,
        ok: bool,
        home: PathBuf,
        server: String,
        from: &'static str,
    },
    Server {
        check: &'static str,
        ok: bool,
        version: String,
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
            DoctorCheck::Farm { ok, check, .. }
            | DoctorCheck::Server { ok, check, .. }
            | DoctorCheck::Runtimes { ok, check, .. }
            | DoctorCheck::Model { ok, check, .. }
            | DoctorCheck::Failed { ok, check, .. } => (!*ok).then_some(*check),
        }
    }

    fn text_line(&self) -> String {
        match self {
            DoctorCheck::Farm { home, server, from, .. } => line(&["farm", "ok", server, from, &home.display().to_string()]),
            DoctorCheck::Server { ok, version, .. } => line(&["server", if *ok { "ok" } else { "fail" }, version]),
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

pub fn run(ctx: &Ctx) -> Done {
    let home = vibevalley_protocol::home::home();
    let from = if vibevalley_protocol::home::announced(&home).as_deref() == Some(ctx.server.as_str()) {
        "server.json"
    } else {
        "default"
    };
    let mut checks = vec![DoctorCheck::Farm {
        check: "farm",
        ok: true,
        home,
        server: ctx.server.clone(),
        from,
    }];
    match ctx.ask::<ops::ServerHealthGet>(&()) {
        Ok(h) => checks.push(DoctorCheck::Server {
            check: "server",
            ok: h.ok,
            version: h.version,
        }),
        Err(f) => {
            checks.push(failed(
                "server",
                f.text,
                vec![Next {
                    say: t("cli.next.startServer", &[]),
                    run: None,
                }],
            ));
            ctx.show(&checks, |cs| render(cs));
            return Err(Failure::new(
                exit::UNREACHABLE,
                "Doctor",
                t("cli.doctor.unreachable", &[("base", ctx.server.clone().into())]),
            ));
        }
    }
    let runtimes = ctx.ask::<ops::RuntimeList>(&())?;
    let installed: Vec<String> = runtimes
        .iter()
        .filter(|r| matches!(r.installation, vibevalley_protocol::Installation::Available(_)))
        .map(|r| r.id.clone())
        .collect();
    checks.push(if installed.is_empty() {
        failed(
            "runtimes",
            t("cli.doctor.noRuntime", &[]),
            vec![Next {
                say: t("cli.doctor.installRuntime", &[]),
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
    let settings = ctx.ask::<ops::SettingGet>(&())?;
    checks.push(match settings.deepseek_api_key.source {
        Some(source) => DoctorCheck::Model {
            check: "model",
            ok: true,
            from: source,
        },
        None => failed(
            "model",
            t("cli.doctor.noModelKey", &[]),
            vec![Next {
                say: t("cli.doctor.setModelKey", &[]),
                run: None,
            }],
        ),
    });
    let wrong: Vec<&str> = checks.iter().filter_map(DoctorCheck::failed_name).collect();
    ctx.show(&checks, |cs| render(cs));
    if wrong.is_empty() {
        Ok(())
    } else {
        Err(Failure::new(
            exit::OTHER,
            "Doctor",
            t("cli.doctor.wrong", &[("checks", wrong.join(", ").into())]),
        ))
    }
}
