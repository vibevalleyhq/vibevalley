//! What the farm knows of each runtime before probing it, and the rules
//! that read a runtime's facts: money stops, session options, a profile's
//! problems, choosing a profile, the quota in words.

use std::collections::BTreeMap;

use vibevalley_i18n::{list, t};
use vibevalley_protocol::{
    AccountUsage, Agent, AgentProblem, AgentProblemLevel, Installation, ModelEntry, PersonaMode, RuntimeInfo, RuntimePreset, RuntimeQuota, RuntimeSettings,
    RuntimeSupport,
};
use vibevalley_runtime::oar::{BUILTIN_RUNTIME_SPECS, RefusableOption, runtime_refused_options, runtime_spec};

use super::text::runtime_presets;
pub use super::text::{runtime_label, yuan};

/// Profile-visible session options that `session_options` checks against `RuntimeSupport.refused`.
const PROFILE_REFUSABLE: [RefusableOption; 4] = [
    RefusableOption::SystemPrompt,
    RefusableOption::AppendSystemPrompt,
    RefusableOption::Effort,
    RefusableOption::DisallowedTools,
];

pub fn default_settings() -> RuntimeSettings {
    RuntimeSettings {
        env: BTreeMap::new(),
        ..runtime_presets().default_settings.clone()
    }
}

/// Every runtime the farm knows, in the order the page shows them.
pub fn runtime_ids() -> Vec<String> {
    let mut ids = runtime_presets().runtime_ids.clone();
    for spec in BUILTIN_RUNTIME_SPECS {
        if !ids.iter().any(|id| id == spec.id) {
            ids.push(spec.id.to_string());
        }
    }
    ids
}

/// A runtime's name, look and blurb; one with no look gets the fallback,
/// named by its id.
pub fn preset_of(runtime: &str) -> RuntimePreset {
    let p = runtime_presets();
    p.runtime_presets.iter().find(|x| x.id == runtime).cloned().unwrap_or_else(|| RuntimePreset {
        id: runtime.into(),
        label: runtime.into(),
        ..p.fallback_preset.clone()
    })
}

/// What a runtime takes before probing it: built-in OAR runtimes read their
/// capabilities and refused options from `vibevalley_runtime::oar::BUILTIN_RUNTIME_SPECS`,
/// enriched with localized prose from `presets*.json`; unknown runtimes accept a prompt only.
pub fn support_of(runtime: &str) -> RuntimeSupport {
    let preset = runtime_presets().runtime_support.get(runtime);
    if let Some(spec) = runtime_spec(runtime) {
        let mut refused = BTreeMap::new();
        for opt in runtime_refused_options(runtime) {
            if !PROFILE_REFUSABLE.contains(opt) {
                continue;
            }
            let key = opt.camel_name();
            let reason = preset
                .and_then(|p| p.refused.get(key))
                .cloned()
                .unwrap_or_else(|| format!("{} does not support {key}", spec.display_name));
            refused.insert(key.to_string(), reason);
        }
        return RuntimeSupport {
            steer: spec.capabilities.steer,
            refused,
            capabilities: preset.map(|p| p.capabilities.clone()).unwrap_or_default(),
            in_process: spec.in_process,
            in_session_config: spec.capabilities.config_options,
        };
    }
    preset
        .map(|p| RuntimeSupport {
            steer: p.steer,
            refused: p.refused.clone(),
            capabilities: p.capabilities.clone(),
            in_process: p.in_process,
            in_session_config: p.in_session_config,
        })
        .unwrap_or_default()
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

struct WindowGroup<'a> {
    name: &'a str,
    windows: Vec<&'a vibevalley_protocol::UsageWindow>,
}

/// Groups usage windows by the `" · "` group prefix (ungrouped windows share `""`),
/// preserving first-seen group order.
fn group_windows(windows: &[vibevalley_protocol::UsageWindow]) -> Vec<WindowGroup<'_>> {
    let mut groups: Vec<WindowGroup<'_>> = Vec::new();
    for w in windows {
        let name = w.label.split_once(" · ").map_or("", |(g, _)| g.trim());
        if let Some(group) = groups.iter_mut().find(|g| g.name == name) {
            group.windows.push(w);
        } else {
            groups.push(WindowGroup { name, windows: vec![w] });
        }
    }
    groups
}

fn exhausted_window<'a>(group: &WindowGroup<'a>) -> Option<&'a vibevalley_protocol::UsageWindow> {
    group.windows.iter().copied().find(|w| w.used_percent.get() >= 100.0)
}

fn quota_gone_text(runtime_id: &str, window: &vibevalley_protocol::UsageWindow) -> String {
    let resets = match window.resets_at {
        Some(at) if at != 0 => t("server.runtime.resets", &[("when", when_text(at).into())]),
        _ => String::new(),
    };
    t(
        "server.runtime.quotaGone",
        &[
            ("runtime", runtime_label(runtime_id).into()),
            ("window", window.label.clone().into()),
            ("resets", resets.into()),
        ],
    )
}

fn antigravity_model_group(runtime_id: &str, model_id: &str) -> Option<&'static str> {
    let bare = runtime_id.strip_prefix("acp:").unwrap_or(runtime_id);
    if bare != "antigravity" {
        return None;
    }
    let lower = model_id.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return None;
    }
    if lower.contains("gemini") || lower.contains("orchestrator") {
        Some("Gemini")
    } else if lower.contains("claude") || lower.contains("gpt") {
        Some("Claude/GPT")
    } else {
        None
    }
}

fn model_quota_stop<'a>(runtime: &'a RuntimeInfo, model_id: &str) -> Option<&'a vibevalley_protocol::UsageWindow> {
    let target_group = antigravity_model_group(&runtime.id, model_id)?;
    let Some(AccountUsage::Ok(u)) = &runtime.usage else {
        return None;
    };
    let groups = group_windows(&u.windows);
    let group = groups.iter().find(|g| g.name.eq_ignore_ascii_case(target_group))?;
    exhausted_window(group)
}

/// Why a runtime takes no work now because of money; "" when it does.
pub fn money_stop(info: Option<&RuntimeInfo>) -> String {
    let Some(info) = info else { return String::new() };
    match &info.usage {
        Some(AccountUsage::Ok(u)) if !u.windows.is_empty() => {
            let groups = group_windows(&u.windows);
            let exhausted: Vec<&vibevalley_protocol::UsageWindow> = groups.iter().filter_map(exhausted_window).collect();
            if !groups.is_empty() && exhausted.len() == groups.len() {
                let earliest = exhausted
                    .iter()
                    .copied()
                    .min_by_key(|w| w.resets_at.filter(|&at| at != 0).unwrap_or(i64::MAX))
                    .expect("exhausted is non-empty");
                return quota_gone_text(&info.id, earliest);
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

/// The best remaining quota across independent window groups (each group's
/// remaining quota is the least left among its windows); none when the usage
/// has no windows.
pub fn quota_left(usage: Option<&AccountUsage>) -> Option<f64> {
    match usage {
        Some(AccountUsage::Ok(u)) if !u.windows.is_empty() => {
            let groups = group_windows(&u.windows);
            groups
                .iter()
                .map(|g| g.windows.iter().map(|w| 100.0 - w.used_percent.get()).fold(f64::INFINITY, f64::min).max(0.0))
                .reduce(f64::max)
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
        add(broke.clone());
    }
    let opts = session_options(agent, runtime.map(|r| &r.settings), runtime);
    if broke.is_empty()
        && let Some(r) = runtime
        && let Some(window) = model_quota_stop(r, &opts.model)
    {
        problems.push(problem("model", AgentProblemLevel::Error, quota_gone_text(&r.id, window)));
    }
    problems.extend(opts.problems);
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
    use vibevalley_protocol::{AccountUsageOk, RuntimeCapability, UsageWindow};

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
        for locale in ["zh", "en"] {
            vibevalley_i18n::set_locale(locale);
            let ids = runtime_ids();
            assert_eq!(ids.first().map(String::as_str), Some("claude"));
            assert!(!ids.iter().any(|id| id == "dsh"), "obsolete dsh must be dropped ({locale})");
            assert!(ids.iter().all(|id| preset_of(id).id == *id));
            assert_eq!(preset_of("nope").label, "nope");
            assert!(support_of("vibevalley").in_process);
            assert!(
                support_of("antigravity").capabilities.contains(&RuntimeCapability::AccountUsage),
                "antigravity must advertise accountUsage capability ({locale})"
            );
            for spec in BUILTIN_RUNTIME_SPECS {
                assert!(ids.iter().any(|id| id == spec.id), "missing {} in {locale}", spec.id);
                let s = support_of(spec.id);
                assert_eq!(s.steer, spec.capabilities.steer, "{} steer ({locale})", spec.id);
                assert_eq!(s.in_process, spec.in_process, "{} in_process ({locale})", spec.id);
                assert_eq!(
                    s.in_session_config, spec.capabilities.config_options,
                    "{} in_session_config ({locale})",
                    spec.id
                );
                let expected_refused: Vec<&str> = runtime_refused_options(spec.id)
                    .iter()
                    .filter(|o| PROFILE_REFUSABLE.contains(o))
                    .map(|o| o.camel_name())
                    .collect();
                let mut actual_refused: Vec<&str> = s.refused.keys().map(String::as_str).collect();
                let mut expected_sorted = expected_refused;
                actual_refused.sort_unstable();
                expected_sorted.sort_unstable();
                assert_eq!(actual_refused, expected_sorted, "{} refused keys ({locale})", spec.id);
            }
        }
        vibevalley_i18n::set_locale("zh");
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
            machine_id: None,
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
            machine_id: None,
            model: String::new(),
            effort: String::new(),
            persona: String::new(),
            persona_mode: PersonaMode::Prompt,
            skills: vec![],
            toolsets: vibevalley_protocol::Toolset::defaults_for(AgentRole::Worker),
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

    #[test]
    fn multi_group_quota_rules_preserve_single_group_and_gate_per_pool() {
        use vibevalley_protocol::{AccountUsageOk, AgentRole, Build, Head, InstallationAvailable, Look, UsageWindow, Via};

        let mk_runtime = |id: &str, windows: Vec<UsageWindow>| RuntimeInfo {
            id: id.into(),
            machine_id: None,
            preset: preset_of(id),
            support: support_of(id),
            installation: Installation::Available(InstallationAvailable {
                via: Via::Executable,
                command: id.into(),
                version: Some("1.5.14".into()),
            }),
            models: None,
            usage: Some(AccountUsage::Ok(AccountUsageOk { subscription: None, windows })),
            skills: None,
            mcp_servers: None,
            tools: None,
            settings: default_settings(),
            spent_today: None,
            quota: None,
            stop: String::new(),
            checked_at: 0,
        };

        let mk_agent = |runtime: &str, model: &str| Agent {
            id: format!("agent-{model}"),
            name: "Worker".into(),
            role: AgentRole::Worker,
            duty: String::new(),
            enabled: true,
            runtime: runtime.into(),
            machine_id: None,
            model: model.into(),
            effort: String::new(),
            persona: String::new(),
            persona_mode: PersonaMode::Prompt,
            skills: vec![],
            toolsets: vibevalley_protocol::Toolset::defaults_for(AgentRole::Worker),
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

        // 1. Regression: single-group runtime exhaustion still triggers money_stop.
        let claude_exhausted = mk_runtime(
            "claude",
            vec![
                UsageWindow {
                    label: "Current session".into(),
                    used_percent: 100.0.into(),
                    resets_at: None,
                },
                UsageWindow {
                    label: "Current week (all models)".into(),
                    used_percent: 25.0.into(),
                    resets_at: None,
                },
            ],
        );
        let stop = money_stop(Some(&claude_exhausted));
        assert!(stop.contains("Current session"), "expected single-group stop: {stop}");
        assert_eq!(quota_left(claude_exhausted.usage.as_ref()), Some(0.0));

        // 2. Multi-group partial exhaustion: Gemini 100%, Claude/GPT 0% -> runtime stays open,
        // remaining quota reflects usable pool, and only Gemini-targeted agents are flagged.
        let agy_partial = mk_runtime(
            "antigravity",
            vec![
                UsageWindow {
                    label: "Gemini · 5h".into(),
                    used_percent: 100.0.into(),
                    resets_at: Some(1_795_452_914_000),
                },
                UsageWindow {
                    label: "Gemini · 7d".into(),
                    used_percent: 40.0.into(),
                    resets_at: Some(1_795_855_698_000),
                },
                UsageWindow {
                    label: "Claude/GPT · 5h".into(),
                    used_percent: 0.0.into(),
                    resets_at: Some(1_795_464_070_000),
                },
                UsageWindow {
                    label: "Claude/GPT · 7d".into(),
                    used_percent: 15.0.into(),
                    resets_at: Some(1_796_050_870_000),
                },
            ],
        );
        assert!(money_stop(Some(&agy_partial)).is_empty(), "partial exhaustion must not stop the whole runtime");
        assert_eq!(quota_left(agy_partial.usage.as_ref()), Some(85.0));
        let text = quota_text(agy_partial.usage.as_ref());
        assert!(text.contains("Gemini · 5h") && text.contains("Claude/GPT · 7d"), "{text}");

        let gemini_problems = agent_problems(&mk_agent("antigravity", "gemini-4-neon"), Some(&agy_partial));
        assert_eq!(gemini_problems.len(), 1, "{gemini_problems:?}");
        assert_eq!(gemini_problems[0].field, "model");
        assert_eq!(gemini_problems[0].level, AgentProblemLevel::Error);
        assert!(gemini_problems[0].text.contains("Gemini · 5h"), "{:?}", gemini_problems[0]);

        let claude_problems = agent_problems(&mk_agent("antigravity", "claude-sonnet-5-5"), Some(&agy_partial));
        assert!(claude_problems.is_empty(), "{claude_problems:?}");
        let gpt_problems = agent_problems(&mk_agent("antigravity", "gpt-oss-120b"), Some(&agy_partial));
        assert!(gpt_problems.is_empty(), "{gpt_problems:?}");

        // Reverse partial exhaustion: Claude/GPT at 100%, Gemini open.
        let agy_claude_gone = mk_runtime(
            "antigravity",
            vec![
                UsageWindow {
                    label: "Gemini · 5h".into(),
                    used_percent: 20.0.into(),
                    resets_at: None,
                },
                UsageWindow {
                    label: "Claude/GPT · 7d".into(),
                    used_percent: 100.0.into(),
                    resets_at: None,
                },
            ],
        );
        assert!(money_stop(Some(&agy_claude_gone)).is_empty());
        assert_eq!(quota_left(agy_claude_gone.usage.as_ref()), Some(80.0));
        assert!(agent_problems(&mk_agent("antigravity", "gemini-4-neon"), Some(&agy_claude_gone)).is_empty());
        let gpt_blocked = agent_problems(&mk_agent("antigravity", "gpt-oss-120b"), Some(&agy_claude_gone));
        assert_eq!(gpt_blocked.len(), 1, "{gpt_blocked:?}");
        assert_eq!(gpt_blocked[0].field, "model");
        assert!(gpt_blocked[0].text.contains("Claude/GPT · 7d"), "{:?}", gpt_blocked[0]);

        // 3. Multi-group total exhaustion: both groups at 100% -> triggers runtime-wide money_stop,
        // choosing the earliest reset window and avoiding duplicate agent_problems entries.
        let agy_total = mk_runtime(
            "antigravity",
            vec![
                UsageWindow {
                    label: "Gemini · 5h".into(),
                    used_percent: 100.0.into(),
                    resets_at: Some(1_795_460_000_000),
                },
                UsageWindow {
                    label: "Claude/GPT · 5h".into(),
                    used_percent: 100.0.into(),
                    resets_at: Some(1_795_450_000_000),
                },
            ],
        );
        let total_stop = money_stop(Some(&agy_total));
        assert!(total_stop.contains("Claude/GPT · 5h"), "expected earliest reset window: {total_stop}");
        assert_eq!(quota_left(agy_total.usage.as_ref()), Some(0.0));
        let total_problems = agent_problems(&mk_agent("antigravity", "gemini-4-neon"), Some(&agy_total));
        assert_eq!(total_problems.len(), 1, "must not duplicate runtime and model quota errors: {total_problems:?}");
        assert_eq!(total_problems[0].field, "runtime");
    }
}
