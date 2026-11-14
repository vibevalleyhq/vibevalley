//! `setting get|update|validate`.

use clap::{Arg, ArgMatches, Command};
use vibevalley_i18n::t;
use vibevalley_protocol::{KeyStatus, Locale, Readiness, SettingsStatus, SettingsUpdate, ops};

use crate::farm::{Ctx, Done, Failure, exit, line, no_dry_run};
use crate::tree::{choice, cmd, get, group, text};

fn update_args() -> [Arg; 8] {
    [
        choice("locale", Locale::ALL.iter().map(|l| l.as_str()), "cli.flag.locale"),
        text("deepseek-key", "cli.flag.deepseekKey"),
        text("agora-app-id", "cli.flag.agoraAppId"),
        text("agora-certificate", "cli.flag.agoraCertificate"),
        text("asr-key", "cli.flag.asrKey"),
        text("llm-key", "cli.flag.llmKey"),
        text("tts-key", "cli.flag.ttsKey"),
        text("dictation-key", "cli.flag.dictationKey"),
    ]
}

fn update_of(m: &ArgMatches) -> (SettingsUpdate, bool) {
    let locale = get(m, "locale").and_then(|s| Locale::ALL.iter().copied().find(|l| l.as_str() == s));
    let u = SettingsUpdate {
        locale,
        deepseek_api_key: get(m, "deepseek-key"),
        agora_app_id: get(m, "agora-app-id"),
        agora_app_certificate: get(m, "agora-certificate"),
        asr_key: get(m, "asr-key"),
        llm_key: get(m, "llm-key"),
        tts_key: get(m, "tts-key"),
        dictation_key: get(m, "dictation-key"),
        ..Default::default()
    };
    let any = u.locale.is_some()
        || u.deepseek_api_key.is_some()
        || u.agora_app_id.is_some()
        || u.agora_app_certificate.is_some()
        || u.asr_key.is_some()
        || u.llm_key.is_some()
        || u.tts_key.is_some()
        || u.dictation_key.is_some();
    (u, any)
}

fn key_line(name: &str, k: &KeyStatus) -> String {
    match (&k.source, &k.hint) {
        (Some(src), Some(hint)) => line(&[name, src.as_str(), hint]),
        (Some(src), None) => line(&[name, src.as_str()]),
        (None, _) => line(&[name, "unset"]),
    }
}

fn status_text(s: &SettingsStatus) -> String {
    let mut lines = vec![
        line(&["locale", s.locale.as_str()]),
        line(&["home", &s.home]),
        line(&["repos", &s.paths.repos]),
        line(&["worktrees", &s.paths.worktrees]),
        line(&["pkm", &s.paths.pkm]),
        key_line("deepseek", &s.deepseek_api_key),
    ];
    let ready: Vec<&str> = s
        .readiness
        .iter()
        .filter_map(|(f, r)| matches!(r, Readiness::True { .. }).then_some(f.as_str()))
        .collect();
    if !ready.is_empty() {
        lines.push(line(&["ready", &ready.join(", ")]));
    }
    lines.join("\n")
}

pub fn command() -> Command {
    group(
        "setting",
        "cli.group.setting.about",
        vec![
            cmd("get", "cli.op.setting.get", &[("vibevalley setting get", "cli.example.settingGet.about")]),
            cmd(
                "update",
                "cli.op.setting.update",
                &[("vibevalley setting update --locale en", "cli.example.settingUpdate.about")],
            )
            .args(update_args()),
            cmd(
                "validate",
                "cli.op.setting.validate",
                &[("vibevalley setting validate --locale zh", "cli.example.settingValidate.about")],
            )
            .args(update_args()),
        ],
    )
}

pub fn run(ctx: &Ctx, m: &ArgMatches) -> Done {
    match m.subcommand() {
        Some(("get", _)) => {
            let status = ctx.ask::<ops::SettingGet>(&())?;
            ctx.show(&status, status_text);
            Ok(())
        }
        Some(("update", m)) => {
            if ctx.dry_run {
                return Err(no_dry_run("setting update"));
            }
            let (update, any) = update_of(m);
            if !any {
                return Err(Failure::usage("MissingArgument", t("cli.setting.nothingGiven", &[])));
            }
            ctx.change::<ops::SettingUpdate>("setting update", None, &update, status_text)
        }
        Some(("validate", m)) => {
            let (update, _) = update_of(m);
            let checked = ctx.ask::<ops::SettingValidate>(&update)?;
            if !checked.problem.is_empty() {
                return Err(Failure::new(exit::REFUSED, "Refused", checked.problem));
            }
            ctx.show(&checked, |_| t("cli.setting.valid", &[]));
            Ok(())
        }
        _ => Ok(()),
    }
}
