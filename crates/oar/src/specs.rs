use super::types::{AgentError, Capabilities, RefusableOption, Result, SessionOptions};

/// Static single-source capability metadata for a built-in OAR runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeSpec {
    pub id: &'static str,
    pub display_name: &'static str,
    pub binary: Option<&'static str>,
    pub in_process: bool,
    pub capabilities: Capabilities,
    pub refused_options: &'static [RefusableOption],
}

const GENERIC_ACP_REFUSED: &[RefusableOption] = &[
    RefusableOption::DisallowedTools,
    RefusableOption::AllowedTools,
    RefusableOption::AdditionalDirectories,
    RefusableOption::OutputSchema,
    RefusableOption::Name,
    RefusableOption::ServiceTier,
    RefusableOption::LaunchArgs,
];

const KIMI_CODEBUDDY_REFUSED: &[RefusableOption] = &[
    RefusableOption::SystemPrompt,
    RefusableOption::AppendSystemPrompt,
    RefusableOption::DisallowedTools,
    RefusableOption::AllowedTools,
    RefusableOption::AdditionalDirectories,
    RefusableOption::OutputSchema,
    RefusableOption::Name,
    RefusableOption::ServiceTier,
    RefusableOption::LaunchArgs,
];

pub const BUILTIN_RUNTIME_SPECS: &[RuntimeSpec] = &[
    RuntimeSpec {
        id: "claude",
        display_name: "Claude Code",
        binary: Some("claude"),
        in_process: false,
        capabilities: Capabilities {
            resume: true,
            steer: true,
            queue: true,
            permission_requests: true,
            model_selection: true,
            subagents: true,
            usage: true,
            config_options: false,
        },
        refused_options: &[RefusableOption::Name, RefusableOption::ServiceTier, RefusableOption::LaunchArgs],
    },
    RuntimeSpec {
        id: "codex",
        display_name: "Codex",
        binary: Some("codex"),
        in_process: false,
        capabilities: Capabilities {
            resume: true,
            steer: true,
            queue: true,
            permission_requests: true,
            model_selection: true,
            subagents: true,
            usage: true,
            config_options: false,
        },
        refused_options: &[
            RefusableOption::AllowedTools,
            RefusableOption::AdditionalDirectories,
            RefusableOption::Name,
            RefusableOption::ServiceTier,
            RefusableOption::LaunchArgs,
        ],
    },
    RuntimeSpec {
        id: "opencode",
        display_name: "OpenCode (ACP)",
        binary: Some("opencode"),
        in_process: false,
        capabilities: Capabilities {
            resume: true,
            steer: true,
            queue: true,
            permission_requests: true,
            model_selection: true,
            subagents: false,
            usage: true,
            config_options: false,
        },
        refused_options: GENERIC_ACP_REFUSED,
    },
    RuntimeSpec {
        id: "qwen",
        display_name: "Qwen Code",
        binary: Some("qwen"),
        in_process: false,
        capabilities: Capabilities {
            resume: true,
            steer: false,
            queue: true,
            permission_requests: true,
            model_selection: true,
            subagents: true,
            usage: true,
            config_options: false,
        },
        refused_options: &[
            RefusableOption::Effort,
            RefusableOption::Name,
            RefusableOption::ServiceTier,
            RefusableOption::OutputSchema,
            RefusableOption::LaunchArgs,
        ],
    },
    RuntimeSpec {
        id: "qoder",
        display_name: "Qoder CLI",
        binary: Some("qoder"),
        in_process: false,
        capabilities: Capabilities {
            resume: true,
            steer: false,
            queue: true,
            permission_requests: true,
            model_selection: true,
            subagents: true,
            usage: true,
            config_options: false,
        },
        refused_options: &[
            RefusableOption::Effort,
            RefusableOption::Name,
            RefusableOption::ServiceTier,
            RefusableOption::AdditionalDirectories,
            RefusableOption::OutputSchema,
            RefusableOption::LaunchArgs,
        ],
    },
    RuntimeSpec {
        id: "codebuddy",
        display_name: "CodeBuddy CLI",
        binary: Some("codebuddy"),
        in_process: false,
        capabilities: Capabilities {
            resume: true,
            steer: false,
            queue: true,
            permission_requests: true,
            model_selection: true,
            subagents: false,
            usage: true,
            config_options: false,
        },
        refused_options: KIMI_CODEBUDDY_REFUSED,
    },
    RuntimeSpec {
        id: "vibevalley",
        display_name: "VibeValley",
        binary: None,
        in_process: true,
        capabilities: Capabilities {
            resume: true,
            steer: true,
            queue: true,
            permission_requests: true,
            model_selection: true,
            subagents: true,
            usage: true,
            config_options: false,
        },
        refused_options: &[],
    },
    RuntimeSpec {
        id: "grok",
        display_name: "Grok CLI",
        binary: Some("grok"),
        in_process: false,
        capabilities: Capabilities {
            resume: true,
            steer: true,
            queue: true,
            permission_requests: true,
            model_selection: true,
            subagents: false,
            usage: true,
            config_options: false,
        },
        refused_options: GENERIC_ACP_REFUSED,
    },
    RuntimeSpec {
        id: "kimi",
        display_name: "Kimi CLI",
        binary: Some("kimi"),
        in_process: false,
        capabilities: Capabilities {
            resume: true,
            steer: false,
            queue: true,
            permission_requests: true,
            model_selection: true,
            subagents: false,
            usage: true,
            config_options: false,
        },
        refused_options: KIMI_CODEBUDDY_REFUSED,
    },
    RuntimeSpec {
        id: "antigravity",
        display_name: "Antigravity CLI",
        binary: Some("agy"),
        in_process: false,
        capabilities: Capabilities {
            resume: true,
            steer: true,
            queue: true,
            permission_requests: true,
            model_selection: true,
            subagents: true,
            usage: true,
            config_options: true,
        },
        refused_options: &[
            RefusableOption::SystemPrompt,
            RefusableOption::DisallowedTools,
            RefusableOption::AllowedTools,
            RefusableOption::OutputSchema,
            RefusableOption::Name,
            RefusableOption::ServiceTier,
            RefusableOption::LaunchArgs,
        ],
    },
];

pub fn runtime_spec(id: &str) -> Option<&'static RuntimeSpec> {
    let bare = id.strip_prefix("acp:").unwrap_or(id);
    BUILTIN_RUNTIME_SPECS.iter().find(|spec| spec.id == bare)
}

pub fn runtime_refused_options(runtime: &str) -> &'static [RefusableOption] {
    if let Some(spec) = runtime_spec(runtime) {
        spec.refused_options
    } else if runtime.starts_with("acp:") {
        GENERIC_ACP_REFUSED
    } else {
        &[]
    }
}

impl SessionOptions {
    pub fn validate_for(&self, runtime: &str) -> Result<()> {
        if let Some(option) = runtime_refused_options(runtime).iter().find(|o| o.supplied(self)) {
            let name = option.snake_name();
            return Err(AgentError::Unsupported {
                option: name.into(),
                reason: format!("{runtime} does not support {name}"),
            });
        }
        Ok(())
    }
}
