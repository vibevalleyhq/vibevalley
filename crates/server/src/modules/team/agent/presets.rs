//! What the farm knows of each runtime before probing it, and the rules
//! that read a runtime's facts: money stops, session options, a profile's
//! problems, choosing a profile, the quota in words.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;
use vibevalley_i18n::{list, t};
use vibevalley_protocol::{
    AccountUsage, Agent, AgentProblem, AgentProblemLevel, Installation, ModelEntry, PersonaMode, RuntimeInfo, RuntimePreset, RuntimeQuota, RuntimeSettings,
    RuntimeSupport,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Presets {
    default_settings: RuntimeSettings,
    fallback_preset: RuntimePreset,
    runtime_presets: Vec<RuntimePreset>,
    runtime_support: BTreeMap<String, RuntimeSupport>,
    runtime_ids: Vec<String>,
}

fn presets() -> &'static Presets {
    static ZH: OnceLock<Presets> = OnceLock::new();
    static EN: OnceLock<Presets> = OnceLock::new();
    if vibevalley_i18n::locale() == "en" {
        EN.get_or_init(|| serde_json::from_str(include_str!("../../../../assets/agent/presets.en.json")).expect("presets.en.json"))
    } else {
        ZH.get_or_init(|| serde_json::from_str(include_str!("../../../../assets/agent/presets.json")).expect("presets.json"))
    }
}

pub fn default_settings() -> RuntimeSettings {
    RuntimeSettings {
        env: BTreeMap::new(),
        ..presets().default_settings.clone()
    }
}

/// Every runtime the farm knows, in the order the page shows them.
pub fn runtime_ids() -> Vec<String> {
    presets().runtime_ids.clone()
}

/// A runtime's name, look and blurb; one with no look gets the fallback,
/// named by its id.
pub fn preset_of(runtime: &str) -> RuntimePreset {
    let p = presets();
    p.runtime_presets.iter().find(|x| x.id == runtime).cloned().unwrap_or_else(|| RuntimePreset {
        id: runtime.into(),
        label: runtime.into(),
        ..p.fallback_preset.clone()
    })
}

pub fn runtime_label(runtime: &str) -> String {
    preset_of(runtime).label
}

/// What a runtime takes before probing it: for one the farm has no word
/// on, nothing beyond a prompt.
pub fn support_of(runtime: &str) -> RuntimeSupport {
    presets().runtime_support.get(runtime).cloned().unwrap_or_default()
}

fn when_text(at: i64) -> String {
    let local = jiff::Timestamp::from_millisecond(at)
        .map(|ts| ts.to_zoned_datetime(jiff::tz::TimeZone::system()))
        .unwrap_or_else(|_| jiff::ZonedDateTime::now());
    t(
        "server.runtime.date",
        &[
            ("month", (local.month() as i64).into()),
            ("day", (local.day() as i64).into()),
            ("time", format!("{:02}:{:02}", local.hour(), local.minute()).into()),
        ],
    )
}

/// CNY in words; anything positive under a cent says so.
pub fn yuan(cny: f64) -> String {
    if cny > 0.0 && cny < 0.01 {
        t("server.runtime.lessThanCent", &[])
    } else {
        format!("¥{cny:.2}")
    }
}

/// Why a runtime takes no work now because of money; "" when it does.
pub fn money_stop(info: Option<&RuntimeInfo>) -> String {
    let Some(info) = info else { return String::new() };
    match &info.usage {
        Some(AccountUsage::Ok(u)) => {
            for w in &u.windows {
                if w.used_percent.get() < 100.0 {
                    continue;
                }
                let resets = match w.resets_at {
                    Some(at) if at != 0 => t("server.runtime.resets", &[("when", when_text(at).into())]),
                    _ => String::new(),
                };
                return t(
                    "server.runtime.quotaGone",
                    &[
                        ("runtime", runtime_label(&info.id).into()),
                        ("window", w.label.clone().into()),
                        ("resets", resets.into()),
                    ],
                );
            }
        }
        Some(AccountUsage::Balance(u)) if !u.balances.is_empty() && (!u.available || u.balances.iter().all(|b| b.amount.get() <= 0.0)) => {
            return t("server.runtime.balanceGone", &[("provider", u.provider.clone().into())]);
        }
        _ => {}
    }
    let budget = info.settings.daily_budget.map(|b| b.get()).unwrap_or(0.0);
    let spent = info.spent_today.map(|s| s.get()).unwrap_or(0.0);
    if budget > 0.0 && spent >= budget {
        return t("server.runtime.budget", &[("spent", yuan(spent).into()), ("budget", yuan(budget).into())]);
    }
    String::new()
}

/// The least left of any window; none when the usage has no windows.
pub fn quota_left(usage: Option<&AccountUsage>) -> Option<f64> {
    match usage {
        Some(AccountUsage::Ok(u)) if !u.windows.is_empty() => {
            let least = u.windows.iter().map(|w| 100.0 - w.used_percent.get()).fold(f64::INFINITY, f64::min);
            Some(least.max(0.0))
        }
        _ => None,
    }
}

fn balance_text(currency: &str, amount: f64) -> String {
    let sign = match currency {
        "CNY" => "¥".to_string(),
        "USD" => "$".to_string(),
        other => format!("{other} "),
    };
    format!("{sign}{amount:.2}")
}

pub fn quota_text(usage: Option<&AccountUsage>) -> String {
    let Some(usage) = usage else { return t("server.runtime.quota.none", &[]) };
    match usage {
        AccountUsage::LoginRequired(_) => t("server.runtime.quota.signedOut", &[]),
        AccountUsage::Unavailable(u) => t("server.runtime.quota.unread", &[("why", u.reason.clone().into())]),
        AccountUsage::Balance(u) => {
            if u.balances.is_empty() {
                return t("server.runtime.quota.noBalance", &[("provider", u.provider.clone().into())]);
            }
            let balances: Vec<String> = u.balances.iter().map(|b| balance_text(&b.currency, b.amount.get())).collect();
            let key = if u.available {
                "server.runtime.quota.balance"
            } else {
                "server.runtime.quota.balanceLow"
            };
            t(key, &[("provider", u.provider.clone().into()), ("balances", list(&balances).into())])
        }
        AccountUsage::Ok(u) => {
            if u.windows.is_empty() {
                return u.subscription.clone().unwrap_or_else(|| t("server.runtime.quota.some", &[]));
            }
            u.windows
                .iter()
                .map(|w| {
                    t(
                        "server.runtime.quota.window",
                        &[("label", w.label.clone().into()), ("left", (100.0 - w.used_percent.get()).into())],
                    )
                })
                .collect::<Vec<_>>()
                .join(&t("server.runtime.quota.windowSeparator", &[]))
        }
    }
}

pub fn quota_of(usage: Option<&AccountUsage>) -> RuntimeQuota {
    RuntimeQuota {
        left: quota_left(usage).map(Into::into),
        text: quota_text(usage),
    }
}

fn blank(s: &str) -> bool {
    s.trim().is_empty()
}

/// What a session on `agent` is opened with, and what is wrong with it.
pub struct Options {
    pub model: String,
    pub effort: String,
    pub env: BTreeMap<String, String>,
    pub missing_model: String,
    pub problems: Vec<AgentProblem>,
}

fn problem(field: &str, level: AgentProblemLevel, text: String) -> AgentProblem {
    AgentProblem {
        field: field.into(),
        level,
        text,
    }
}

/// True when at least one model on the runtime advertises effort levels,
/// distinguishing models that reject `effort` (`effort_levels: []`) from
/// runtimes whose model list never reports effort levels at all.
pub(crate) fn runtime_reports_model_efforts(models: &[ModelEntry]) -> bool {
    models.iter().any(|m| !m.effort_levels.is_empty())
}

/// `sessionOptions`: both the dispatch check and session opening check
/// these; availability and spending only gate new work.
pub fn session_options(agent: &Agent, settings: Option<&RuntimeSettings>, runtime: Option<&RuntimeInfo>) -> Options {
    let models = runtime.and_then(|r| r.models.as_ref());
    let wanted = if !agent.model.is_empty() {
        agent.model.clone()
    } else {
        settings.map(|s| s.default_model.clone()).unwrap_or_default()
    };
    let missing_model = match models {
        Some(models) if !wanted.is_empty() && !models.iter().any(|m| m.id == wanted) => wanted.clone(),
        _ => String::new(),
    };
    let inherited_default_effort = agent.effort.is_empty();
    let mut effort = if !inherited_default_effort {
        agent.effort.clone()
    } else {
        settings.map(|s| s.default_effort.clone()).unwrap_or_default()
    };
    let mut env = settings.map(|s| s.env.clone()).unwrap_or_default();
    env.extend(agent.env.clone());
    let model = if missing_model.is_empty() { wanted } else { String::new() };
    let mut problems = Vec::new();
    let support = runtime.map(|r| r.support.clone()).unwrap_or_else(|| support_of(&agent.runtime));
    let refused = &support.refused;
    let prompt_option = match agent.persona_mode {
        PersonaMode::Append => "appendSystemPrompt",
        PersonaMode::Replace => "systemPrompt",
        _ => "",
    };
    use AgentProblemLevel::{Error, Warn};
    if !blank(&agent.persona)
        && !prompt_option.is_empty()
        && let Some(why) = refused.get(prompt_option)
    {
        problems.push(problem("persona", Error, t("server.runtime.persona", &[("refused", why.clone().into())])));
    }
    if !effort.is_empty()
        && let Some(why) = refused.get("effort")
    {
        problems.push(problem("effort", Error, why.clone()));
    }
    if !env.is_empty()
        && let Some(why) = refused.get("env")
    {
        problems.push(problem("env", Error, why.clone()));
    }
    if !agent.mcp_servers.is_empty()
        && let Some(why) = refused.get("mcpServers")
    {
        problems.push(problem("mcpServers", Error, why.clone()));
    }
    if !agent.disallowed_tools.is_empty()
        && let Some(why) = refused.get("disallowedTools")
    {
        problems.push(problem("disallowedTools", Error, why.clone()));
    }
    if let Some(r) = runtime
        && !missing_model.is_empty()
    {
        problems.push(problem(
            "model",
            Warn,
            t(
                "server.runtime.noModel",
                &[("runtime", r.id.clone().into()), ("model", missing_model.clone().into())],
            ),
        ));
    }
    if let (Some(r), Some(models)) = (runtime, models)
        && !effort.is_empty()
        && runtime_reports_model_efforts(models)
    {
        let found = models.iter().find(|m| if model.is_empty() { m.is_default } else { m.id == model });
        if let Some(m) = found
            && !m.effort_levels.contains(&effort)
        {
            if inherited_default_effort || m.effort_levels.is_empty() {
                effort.clear();
            } else {
                let name = if !agent.model.is_empty() && !model.is_empty() {
                    m.name.clone()
                } else {
                    t(
                        "server.runtime.runtimeDefault",
                        &[("runtime", r.id.clone().into()), ("model", m.name.clone().into())],
                    )
                };
                problems.push(problem(
                    "effort",
                    Error,
                    t(
                        "server.runtime.effort",
                        &[
                            ("model", name.into()),
                            ("effort", effort.clone().into()),
                            ("levels", list(&m.effort_levels).into()),
                        ],
                    ),
                ));
            }
        }
    }
    Options {
        model,
        effort,
        env,
        missing_model,
        problems,
    }
}

pub fn agent_problems(agent: &Agent, runtime: Option<&RuntimeInfo>) -> Vec<AgentProblem> {
    let mut problems = Vec::new();
    let mut add = |text: String| problems.push(problem("runtime", AgentProblemLevel::Error, text));
    match runtime {
        None => add(t("server.runtime.unknownRuntime", &[("runtime", agent.runtime.clone().into())])),
        Some(r) => match &r.installation {
            Installation::Available(_) if !r.settings.enabled => add(t("server.runtime.disabled", &[])),
            Installation::Available(_) => {}
            Installation::Checking(_) => add(t("server.runtime.stillChecking", &[])),
            Installation::NotFound(_) => add(t("server.runtime.notInstalled", &[])),
            Installation::Unsupported(why) => add(why.reason.clone()),
        },
    }
    let broke = money_stop(runtime);
    if !broke.is_empty() {
        add(broke);
    }
    problems.extend(session_options(agent, runtime.map(|r| &r.settings), runtime).problems);
    problems
}

pub struct Candidate {
    pub agent: Agent,
    pub usable: bool,
}

/// The profile named (by id or name, else a usable one on the runtime
/// named), else the one picked, else the usable one whose tags the brief
/// names most.
pub fn choose_agent(candidates: &[Candidate], brief: &str, named: &str, picked: &str) -> Option<Agent> {
    if !named.is_empty() {
        let by_name = candidates
            .iter()
            .find(|c| c.agent.id == named || c.agent.name == named)
            .or_else(|| candidates.iter().find(|c| c.agent.runtime == named && c.usable));
        if let Some(c) = by_name {
            return Some(c.agent.clone());
        }
    }
    if !picked.is_empty()
        && let Some(c) = candidates.iter().find(|c| c.agent.id == picked)
    {
        return Some(c.agent.clone());
    }
    let text = brief.to_lowercase();
    let mut best: Option<&Agent> = None;
    let mut best_score: i64 = -1;
    for c in candidates.iter().filter(|c| c.usable) {
        let score = c.agent.tags.iter().filter(|tag| text.contains(&tag.to_lowercase())).count() as i64;
        if score > best_score {
            best = Some(&c.agent);
            best_score = score;
        }
    }
    best.cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibevalley_protocol::{AccountUsageOk, UsageWindow};

    #[test]
    fn quota_in_words() {
        vibevalley_i18n::set_locale("zh");
        assert!(quota_left(None).is_none());
        let usage = AccountUsage::Ok(AccountUsageOk {
            subscription: None,
            windows: vec![
                UsageWindow {
                    label: "5h".into(),
                    used_percent: 30.0.into(),
                    resets_at: None,
                },
                UsageWindow {
                    label: "week".into(),
                    used_percent: 80.0.into(),
                    resets_at: None,
                },
            ],
        });
        assert_eq!(quota_left(Some(&usage)), Some(20.0));
        assert!(!quota_text(Some(&usage)).is_empty());
        assert_eq!(yuan(0.001), t("server.runtime.lessThanCent", &[]));
        assert_eq!(yuan(1.5), "¥1.50");
    }

    #[test]
    fn presets_know_every_runtime() {
        let ids = runtime_ids();
        assert_eq!(ids.first().map(String::as_str), Some("claude"));
        assert!(ids.iter().all(|id| preset_of(id).id == *id));
        assert_eq!(preset_of("nope").label, "nope");
        assert!(support_of("vibevalley").in_process);
    }

    #[test]
    fn session_options_filters_unsupported_effort_against_model_levels() {
        use vibevalley_protocol::{AgentRole, Build, Head, InstallationAvailable, Look, Via};

        let models = vec![
            ModelEntry {
                id: "gemini-4-neon".into(),
                name: "Gemini 4 Neon".into(),
                effort_levels: vec!["low".into(), "medium".into(), "high".into()],
                default_effort: Some("high".into()),
                is_default: true,
            },
            ModelEntry {
                id: "gemini-pro-orchestrator-neon".into(),
                name: "Orchestrator (Neon)".into(),
                effort_levels: vec![],
                default_effort: None,
                is_default: false,
            },
            ModelEntry {
                id: "gemini-fast".into(),
                name: "Gemini Fast".into(),
                effort_levels: vec!["low".into(), "high".into()],
                default_effort: Some("low".into()),
                is_default: false,
            },
        ];
        assert!(runtime_reports_model_efforts(&models));
        assert!(!runtime_reports_model_efforts(&models[1..2]));

        let settings = RuntimeSettings {
            default_effort: "medium".into(),
            ..default_settings()
        };
        let runtime = RuntimeInfo {
            id: "antigravity".into(),
            preset: preset_of("antigravity"),
            support: support_of("antigravity"),
            installation: Installation::Available(InstallationAvailable {
                via: Via::Executable,
                command: "agy".into(),
                version: Some("1.5.14".into()),
            }),
            models: Some(models),
            usage: None,
            skills: None,
            mcp_servers: None,
            tools: None,
            settings: settings.clone(),
            spent_today: None,
            quota: None,
            stop: String::new(),
            checked_at: 0,
        };
        let base_agent = Agent {
            id: "a1".into(),
            name: "Worker".into(),
            role: AgentRole::Worker,
            duty: String::new(),
            enabled: true,
            runtime: "antigravity".into(),
            model: String::new(),
            effort: String::new(),
            persona: String::new(),
            persona_mode: PersonaMode::Prompt,
            skills: vec![],
            mcp_servers: vec![],
            disallowed_tools: vec![],
            env: BTreeMap::new(),
            workdir: String::new(),
            worktree: false,
            tags: vec![],
            look: Look {
                species: None,
                outfit: None,
                orchestrator: None,
                build: Build::Biped,
                head: Head::Rounded,
                body: String::new(),
                trim: String::new(),
                hat: String::new(),
                eye: String::new(),
                avatar: None,
            },
            from: None,
        };

        // Inherited runtime default effort is cleared for models with no effort levels.
        let orch = Agent {
            model: "gemini-pro-orchestrator-neon".into(),
            ..base_agent.clone()
        };
        let opts = session_options(&orch, Some(&settings), Some(&runtime));
        assert!(opts.effort.is_empty());
        assert!(opts.problems.is_empty(), "{:?}", opts.problems);

        // Stale explicit profile effort on a model with no effort levels is cleared cleanly.
        let orch_explicit = Agent {
            model: "gemini-pro-orchestrator-neon".into(),
            effort: "high".into(),
            ..base_agent.clone()
        };
        let opts = session_options(&orch_explicit, Some(&settings), Some(&runtime));
        assert!(opts.effort.is_empty());
        assert!(opts.problems.is_empty(), "{:?}", opts.problems);

        // Inherited runtime default effort is cleared when a model offers different levels.
        let fast_inherited = Agent {
            model: "gemini-fast".into(),
            ..base_agent.clone()
        };
        let opts = session_options(&fast_inherited, Some(&settings), Some(&runtime));
        assert!(opts.effort.is_empty());
        assert!(opts.problems.is_empty(), "{:?}", opts.problems);

        // Explicit profile effort incompatible with a model's advertised levels still reports an error.
        let fast_explicit = Agent {
            model: "gemini-fast".into(),
            effort: "medium".into(),
            ..base_agent.clone()
        };
        let opts = session_options(&fast_explicit, Some(&settings), Some(&runtime));
        assert_eq!(opts.problems.len(), 1);
        assert_eq!(opts.problems[0].field, "effort");
        assert_eq!(opts.problems[0].level, AgentProblemLevel::Error);

        // Supported inherited default effort is preserved.
        let neon = Agent {
            model: "gemini-4-neon".into(),
            ..base_agent.clone()
        };
        let opts = session_options(&neon, Some(&settings), Some(&runtime));
        assert_eq!(opts.effort, "medium");
        assert!(opts.problems.is_empty());

        // When no model on the runtime reports effort levels, inherited effort is kept untouched.
        let unadvertised = RuntimeInfo {
            models: Some(vec![ModelEntry {
                id: "custom-model".into(),
                name: "Custom".into(),
                effort_levels: vec![],
                default_effort: None,
                is_default: true,
            }]),
            ..runtime
        };
        let opts = session_options(&base_agent, Some(&settings), Some(&unadvertised));
        assert_eq!(opts.effort, "medium");
        assert!(opts.problems.is_empty());
    }
}
