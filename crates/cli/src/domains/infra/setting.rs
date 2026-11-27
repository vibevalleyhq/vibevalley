//! `setting get|update|validate`.

use clap::{Args, Subcommand, ValueEnum};
use vibevalley_protocol::{KeyStatus, Locale, Readiness, SettingsStatus, SettingsUpdate, ops};

use crate::client::{Client, Done, Failure, exit, no_dry_run};
use crate::output::line;

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum LocaleArg {
    Zh,
    En,
}

impl From<LocaleArg> for Locale {
    fn from(value: LocaleArg) -> Self {
        match value {
            LocaleArg::Zh => Locale::Zh,
            LocaleArg::En => Locale::En,
        }
    }
}

#[derive(Debug, Args)]
pub struct SettingFields {
    /// Interface language
    #[arg(long, value_enum)]
    pub locale: Option<LocaleArg>,
    /// DeepSeek API key
    #[arg(long)]
    pub deepseek_key: Option<String>,
    /// GitHub personal access token
    #[arg(long)]
    pub github_token: Option<String>,
}

impl SettingFields {
    fn into_update(self) -> (SettingsUpdate, bool) {
        let update = SettingsUpdate {
            locale: self.locale.map(Into::into),
            deepseek_api_key: self.deepseek_key,
            github_token: self.github_token,
            ..Default::default()
        };
        let any = update.locale.is_some() || update.deepseek_api_key.is_some() || update.github_token.is_some();
        (update, any)
    }
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct SettingCmd {
    #[command(subcommand)]
    pub action: SettingAction,
}

#[derive(Debug, Subcommand)]
pub enum SettingAction {
    /// Show current settings, paths, key sources, and feature readiness
    #[command(after_help = "Examples:\n  vibevalley setting get\n  vibevalley setting get --json")]
    Get,
    /// Update one or more server settings
    #[command(after_help = "Examples:\n  vibevalley setting update --locale en")]
    Update(SettingFields),
    /// Validate candidate settings without saving
    #[command(after_help = "Examples:\n  vibevalley setting validate --locale zh --deepseek-key sk-test12345")]
    Validate(SettingFields),
}

fn key_line(name: &str, key: &KeyStatus) -> String {
    match (&key.source, &key.hint) {
        (Some(src), Some(hint)) => line(&[name, src.as_str(), hint]),
        (Some(src), None) => line(&[name, src.as_str()]),
        (None, _) => line(&[name, "unset"]),
    }
}

fn status_text(status: &SettingsStatus) -> String {
    let mut lines = vec![
        line(&["locale", status.locale.as_str()]),
        line(&["home", &status.home]),
        line(&["repos", &status.paths.repos]),
        line(&["worktrees", &status.paths.worktrees]),
        key_line("deepseek", &status.deepseek_api_key),
        key_line("github", &status.github_token),
    ];
    let ready: Vec<&str> = status
        .readiness
        .iter()
        .filter_map(|(feature, state)| matches!(state, Readiness::True { .. }).then_some(feature.as_str()))
        .collect();
    if !ready.is_empty() {
        lines.push(line(&["ready", &ready.join(", ")]));
    }
    lines.join("\n")
}

pub async fn run(client: &Client, cmd: SettingCmd) -> Done {
    match cmd.action {
        SettingAction::Get => {
            let status = client.ask::<ops::SettingGet>(&()).await?;
            client.output.show(&status, status_text);
            Ok(())
        }
        SettingAction::Update(fields) => {
            if client.dry_run {
                return Err(no_dry_run("setting update"));
            }
            let (update, any) = fields.into_update();
            if !any {
                return Err(Failure::usage("MissingArgument", "provide at least one setting flag to update"));
            }
            client.mutate::<ops::SettingUpdate>("setting update", &update, status_text).await
        }
        SettingAction::Validate(fields) => {
            let (update, _) = fields.into_update();
            let checked = client.ask::<ops::SettingValidate>(&update).await?;
            if !checked.problem.is_empty() {
                return Err(Failure::new(exit::REFUSED, "Refused", checked.problem));
            }
            client.output.show(&checked, |_| "valid".into());
            Ok(())
        }
    }
}
