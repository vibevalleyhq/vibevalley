//! `doctor`: this machine's farm, checked: found, reachable, its runtimes, its model key.

use clap::Command;
use serde_json::{Value, json};
use vibevalley_i18n::t;
use vibevalley_protocol::{Next, ops};

use crate::farm::{Ctx, Done, Failure, exit};
use crate::tree::cmd;

pub fn command() -> Command {
    cmd("doctor", "cli.command.doctor", &[("vibevalley doctor", "cli.example.doctor.about")])
}

fn failed(check: &str, why: String, next: Vec<Next>) -> Value {
    json!({ "check": check, "ok": false, "why": why, "next": next })
}

pub fn run(ctx: &Ctx) -> Done {
    let home = vibevalley_home::home();
    let from = if vibevalley_home::announced(&home).as_deref() == Some(ctx.server.as_str()) {
        "server.json"
    } else {
        "default"
    };
    let mut checks = vec![json!({ "check": "farm", "ok": true, "home": home, "server": ctx.server, "from": from })];
    match ctx.ask::<ops::ServerHealthGet>(&()) {
        Ok(h) => checks.push(json!({ "check": "server", "ok": h.ok, "version": h.version })),
        Err(f) => {
            checks.push(failed(
                "server",
                f.text,
                vec![Next {
                    say: t("cli.next.startServer", &[]),
                    run: None,
                }],
            ));
            println!("{}", Value::Array(checks));
            return Err(Failure::new(
                exit::UNREACHABLE,
                "Doctor",
                t("cli.doctor.unreachable", &[("base", ctx.server.clone().into())]),
            ));
        }
    }
    let runtimes = ctx.ask::<ops::RuntimeList>(&())?;
    let installed: Vec<&str> = runtimes
        .iter()
        .filter(|r| matches!(r.installation, vibevalley_protocol::Installation::Available(_)))
        .map(|r| r.id.as_str())
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
        json!({ "check": "runtimes", "ok": true, "installed": installed })
    });
    let settings = ctx.ask::<ops::SettingGet>(&())?;
    checks.push(match settings.deepseek_api_key.source {
        Some(source) => json!({ "check": "model", "ok": true, "from": source }),
        None => failed(
            "model",
            t("cli.doctor.noModelKey", &[]),
            vec![Next {
                say: t("cli.doctor.setModelKey", &[]),
                run: None,
            }],
        ),
    });
    let wrong: Vec<String> = checks
        .iter()
        .filter(|c| c["ok"] != true)
        .filter_map(|c| c["check"].as_str().map(String::from))
        .collect();
    println!("{}", Value::Array(checks));
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
