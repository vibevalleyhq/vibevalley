use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{ENV_ACTIVE_HOOKS, ENV_HOOK_IDEGRAPH, ENV_IDEGRAPH_HOOK, ENV_IDEGRAPH_SCOPED, ENV_IDEGRAPH_WORKSPACE, ENV_TERM_HOOK_ZSH};

const IDEGRAPH_SHIM_SCRIPT: &str = r#"#!/bin/sh
# Scoped idegraph wrapper managed by VibeValley (tab-local; global PATH untouched).
_vv_self_dir="${0%/*}"
_vv_rest_path=""
_vv_old_ifs="$IFS"
IFS=":"
for _vv_entry in $PATH; do
  [ "$_vv_entry" = "$_vv_self_dir" ] && continue
  if [ -n "$_vv_rest_path" ]; then
    _vv_rest_path="${_vv_rest_path}:${_vv_entry}"
  else
    _vv_rest_path="$_vv_entry"
  fi
done
IFS="$_vv_old_ifs"
PATH="$_vv_rest_path"
export PATH
_vv_real="$(command -v idegraph 2>/dev/null || true)"
if [ -n "$_vv_real" ]; then
  exec "$_vv_real" "$@"
fi
printf '%s\n' "idegraph: binary not found in PATH (VibeValley scoped hook is active)" >&2
exit 127
"#;

const IDEGRAPH_ZSH_SCRIPT: &str = r#"# Scoped idegraph zsh integration (isolated ZDOTDIR; ~/.zshrc untouched).
export VV_HOOK_IDEGRAPH=1
export VV_HOOK_IDEGRAPH_ZSH=1
"#;

/// Built-in terminal hook presets. All presets are OFF by default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuiltinHookPreset {
    Idegraph,
}

impl BuiltinHookPreset {
    pub const ALL: &[Self] = &[Self::Idegraph];

    pub const fn id(self) -> &'static str {
        match self {
            Self::Idegraph => "idegraph",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Idegraph => "idegraph",
        }
    }

    pub const fn description(self) -> &'static str {
        match self {
            Self::Idegraph => "Scoped idegraph environment, PATH shim, and isolated zsh hook",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        match id.trim() {
            "idegraph" => Some(Self::Idegraph),
            _ => None,
        }
    }

    pub fn template(self) -> TerminalHookTemplate {
        match self {
            Self::Idegraph => {
                let mut env = BTreeMap::new();
                env.insert(ENV_HOOK_IDEGRAPH.into(), "1".into());
                env.insert(ENV_IDEGRAPH_HOOK.into(), "1".into());
                env.insert(ENV_IDEGRAPH_SCOPED.into(), "1".into());
                TerminalHookTemplate {
                    id: self.id().into(),
                    label: self.label().into(),
                    description: Some(self.description().into()),
                    env,
                    prepend_path_dirs: Vec::new(),
                    shims: vec![PathShimSpec {
                        name: "idegraph".into(),
                        script: IDEGRAPH_SHIM_SCRIPT.into(),
                    }],
                    zsh_script: Some(IDEGRAPH_ZSH_SCRIPT.into()),
                }
            }
        }
    }
}

/// Executable wrapper script materialized inside a tab's isolated temp `bin/` directory.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PathShimSpec {
    pub name: String,
    pub script: String,
}

/// Declarative template for a scoped terminal hook (built-in preset or custom hook).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TerminalHookTemplate {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Scoped environment variables injected only when this hook is active.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// Directories prepended to `PATH` only inside PTYs where this hook is active.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub prepend_path_dirs: Vec<PathBuf>,
    /// Executable shims placed in the tab's isolated `bin/` directory.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shims: Vec<PathShimSpec>,
    /// Lightweight zsh snippet sourced by the isolated `ZDOTDIR` wrapper.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zsh_script: Option<String>,
}

/// Per-workspace/repo hook opt-in list (empty = all OFF by default).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct WorkspaceHookConfig {
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub enabled_hooks: BTreeSet<String>,
}

/// Persisted hook registry and per-workspace opt-in toggles.
/// All hooks are OFF by default unless explicitly opted in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TerminalHooksConfig {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_hooks: Vec<TerminalHookTemplate>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub workspaces: BTreeMap<String, WorkspaceHookConfig>,
}

/// Per-tab enable/disable overrides relative to the owning workspace's defaults.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TabHookOverrides {
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub enable: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub disable: BTreeSet<String>,
}

impl TabHookOverrides {
    pub fn is_empty(&self) -> bool {
        self.enable.is_empty() && self.disable.is_empty()
    }

    /// Updates the per-tab override for `hook_id` against `workspace_default`.
    /// When the requested state matches `workspace_default`, the override is cleared.
    pub fn set_enabled(&mut self, hook_id: &str, workspace_default: bool, enabled: bool) {
        let Some(id) = normalize_hook_id(hook_id) else {
            return;
        };
        self.enable.remove(&id);
        self.disable.remove(&id);
        if enabled != workspace_default {
            if enabled {
                self.enable.insert(id);
            } else {
                self.disable.insert(id);
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookSource {
    Workspace,
    Tab,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveHookInfo {
    pub id: String,
    pub label: String,
    pub source: HookSource,
}

/// Fully resolved hooks for a single terminal tab spawn.
/// When empty, PTY spawn injects zero env vars, zero PATH shims, and zero ZDOTDIR hooks.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ResolvedTerminalHooks {
    pub active: Vec<ActiveHookInfo>,
    pub templates: Vec<TerminalHookTemplate>,
    pub workspace_root: Option<PathBuf>,
}

impl ResolvedTerminalHooks {
    pub fn is_empty(&self) -> bool {
        self.templates.is_empty()
    }

    pub fn active_ids(&self) -> Vec<&str> {
        self.active.iter().map(|h| h.id.as_str()).collect()
    }

    /// Scoped environment variables for this resolved hook set.
    /// Returns an empty vector when no hooks are enabled.
    pub fn scoped_env_vars(&self) -> Vec<(String, String)> {
        if self.is_empty() {
            return Vec::new();
        }
        let mut vars = BTreeMap::<String, String>::new();
        for template in &self.templates {
            for (k, v) in &template.env {
                if !is_reserved_env_key(k) {
                    vars.insert(k.clone(), v.clone());
                }
            }
        }
        if self.templates.iter().any(|t| t.id == BuiltinHookPreset::Idegraph.id())
            && let Some(root) = &self.workspace_root
            && !vars.contains_key(ENV_IDEGRAPH_WORKSPACE)
        {
            vars.insert(ENV_IDEGRAPH_WORKSPACE.into(), root.to_string_lossy().into_owned());
        }
        let joined = self.active.iter().map(|h| h.id.as_str()).collect::<Vec<_>>().join(",");
        if !joined.is_empty() {
            vars.insert(ENV_ACTIVE_HOOKS.into(), joined);
        }
        vars.into_iter().collect()
    }

    /// Appends scoped hook environment variables to `env` only when at least one hook is active.
    pub fn apply_to_spawn_env(&self, env: &mut Vec<(String, String)>) {
        let scoped = self.scoped_env_vars();
        if scoped.is_empty() {
            return;
        }
        for (k, v) in scoped {
            env.retain(|(existing, _)| existing != &k);
            env.push((k, v));
        }
    }
}

pub fn normalize_hook_id(raw: &str) -> Option<String> {
    let sanitized: String = raw
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let trimmed = sanitized.trim_matches('-').to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

pub fn normalize_workspace_key(path: &Path) -> String {
    let cleaned: PathBuf = path.components().collect();
    if cleaned.as_os_str().is_empty() {
        path.to_string_lossy().into_owned()
    } else {
        cleaned.to_string_lossy().into_owned()
    }
}

pub fn is_valid_shim_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains('/') && !name.contains('\\') && !name.contains('\0')
}

pub fn is_reserved_env_key(key: &str) -> bool {
    matches!(
        key,
        "PATH"
            | "ZDOTDIR"
            | "HOME"
            | "TERM"
            | "TERM_PROGRAM"
            | "COLORTERM"
            | crate::history::ENV_SHIM_ZDOTDIR
            | crate::history::ENV_ORIG_ZDOTDIR
            | crate::history::ENV_TERM_HISTORY_FILE
            | ENV_TERM_HOOK_ZSH
            | ENV_ACTIVE_HOOKS
    )
}

impl TerminalHooksConfig {
    /// Returns all available hook templates (built-in presets + user-defined custom hooks).
    pub fn catalog(&self) -> Vec<TerminalHookTemplate> {
        let mut out: Vec<TerminalHookTemplate> = BuiltinHookPreset::ALL.iter().map(|p| p.template()).collect();
        for custom in &self.custom_hooks {
            let Some(id) = normalize_hook_id(&custom.id) else {
                continue;
            };
            let mut normalized = custom.clone();
            normalized.id = id.clone();
            if normalized.label.trim().is_empty() {
                normalized.label = id.clone();
            }
            if let Some(existing) = out.iter_mut().find(|t| t.id == id) {
                *existing = normalized;
            } else {
                out.push(normalized);
            }
        }
        out
    }

    pub fn find_template(&self, id: &str) -> Option<TerminalHookTemplate> {
        let id = normalize_hook_id(id)?;
        self.catalog().into_iter().find(|t| t.id == id)
    }

    pub fn workspace_enabled_hooks(&self, workspace_root: Option<&Path>) -> BTreeSet<String> {
        let Some(root) = workspace_root else {
            return BTreeSet::new();
        };
        let key = normalize_workspace_key(root);
        self.workspaces.get(&key).map(|w| w.enabled_hooks.clone()).unwrap_or_default()
    }

    pub fn is_workspace_hook_enabled(&self, workspace_root: Option<&Path>, hook_id: &str) -> bool {
        let Some(id) = normalize_hook_id(hook_id) else {
            return false;
        };
        self.workspace_enabled_hooks(workspace_root).contains(&id)
    }

    pub fn set_workspace_hook_enabled(&mut self, workspace_root: &Path, hook_id: &str, enabled: bool) {
        let Some(id) = normalize_hook_id(hook_id) else {
            return;
        };
        let key = normalize_workspace_key(workspace_root);
        if enabled {
            let entry = self.workspaces.entry(key).or_default();
            entry.enabled_hooks.insert(id);
        } else if let Some(entry) = self.workspaces.get_mut(&key) {
            entry.enabled_hooks.remove(&id);
            if entry.enabled_hooks.is_empty() {
                self.workspaces.remove(&key);
            }
        }
    }

    pub fn upsert_custom_hook(&mut self, mut template: TerminalHookTemplate) -> Option<String> {
        let id = normalize_hook_id(&template.id)?;
        template.id = id.clone();
        if template.label.trim().is_empty() {
            template.label = id.clone();
        }
        if let Some(existing) = self.custom_hooks.iter_mut().find(|t| normalize_hook_id(&t.id).as_deref() == Some(id.as_str())) {
            *existing = template;
        } else {
            self.custom_hooks.push(template);
        }
        Some(id)
    }

    pub fn remove_custom_hook(&mut self, hook_id: &str) -> bool {
        let Some(id) = normalize_hook_id(hook_id) else {
            return false;
        };
        let before = self.custom_hooks.len();
        self.custom_hooks.retain(|t| normalize_hook_id(&t.id).as_deref() != Some(id.as_str()));
        for ws in self.workspaces.values_mut() {
            ws.enabled_hooks.remove(&id);
        }
        self.workspaces.retain(|_, ws| !ws.enabled_hooks.is_empty());
        self.custom_hooks.len() != before
    }

    /// Resolves the effective hooks for a terminal tab by combining workspace defaults
    /// (all OFF unless explicitly enabled) with per-tab overrides.
    pub fn resolve_for_tab(&self, workspace_root: Option<&Path>, tab_overrides: &TabHookOverrides) -> ResolvedTerminalHooks {
        let ws_enabled = self.workspace_enabled_hooks(workspace_root);
        let mut effective: BTreeMap<String, HookSource> = BTreeMap::new();
        for id in &ws_enabled {
            if let Some(norm) = normalize_hook_id(id) {
                effective.insert(norm, HookSource::Workspace);
            }
        }
        for id in &tab_overrides.disable {
            if let Some(norm) = normalize_hook_id(id) {
                effective.remove(&norm);
            }
        }
        for id in &tab_overrides.enable {
            if let Some(norm) = normalize_hook_id(id) {
                let source = if ws_enabled.contains(&norm) { HookSource::Workspace } else { HookSource::Tab };
                effective.insert(norm, source);
            }
        }
        if effective.is_empty() {
            return ResolvedTerminalHooks {
                active: Vec::new(),
                templates: Vec::new(),
                workspace_root: workspace_root.map(Path::to_path_buf),
            };
        }

        let catalog = self.catalog();
        let mut active = Vec::new();
        let mut templates = Vec::new();
        for (id, source) in effective {
            if let Some(template) = catalog.iter().find(|t| t.id == id) {
                active.push(ActiveHookInfo {
                    id: template.id.clone(),
                    label: template.label.clone(),
                    source,
                });
                templates.push(template.clone());
            }
        }
        ResolvedTerminalHooks {
            active,
            templates,
            workspace_root: workspace_root.map(Path::to_path_buf),
        }
    }
}
