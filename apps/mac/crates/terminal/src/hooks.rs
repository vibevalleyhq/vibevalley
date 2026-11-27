//! Declarative, opt-in scoped terminal hooks (all OFF by default).
//!
//! Hooks inject environment variables, scoped `PATH` shims, and/or isolated
//! `ZDOTDIR` zsh snippets strictly into the spawned PTY for tabs/workspaces
//! that opt in. Global dotfiles (`~/.zshrc`, `~/.bashrc`), global `PATH`, and
//! external system terminals are never mutated.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};

pub const ENV_ACTIVE_HOOKS: &str = "VV_ACTIVE_HOOKS";
pub const ENV_TERM_HOOK_ZSH: &str = "VV_TERM_HOOK_ZSH";
pub const ENV_IDEGRAPH_HOOK: &str = "IDEGRAPH_HOOK";
pub const ENV_IDEGRAPH_SCOPED: &str = "IDEGRAPH_SCOPED";
pub const ENV_IDEGRAPH_WORKSPACE: &str = "IDEGRAPH_WORKSPACE";
pub const ENV_HOOK_IDEGRAPH: &str = "VV_HOOK_IDEGRAPH";
pub const ENV_HOOK_IDEGRAPH_ZSH: &str = "VV_HOOK_IDEGRAPH_ZSH";

static HOOK_TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

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

/// RAII guard for per-tab isolated temp shims and `ZDOTDIR` hook scripts.
/// Removed automatically when the PTY shuts down or the tab session drops.
pub(crate) struct HookRuntime {
    dir: PathBuf,
}

impl Drop for HookRuntime {
    fn drop(&mut self) {
        if let Err(err) = std::fs::remove_dir_all(&self.dir)
            && err.kind() != std::io::ErrorKind::NotFound
        {
            eprintln!("remove terminal hook runtime {}: {err}", self.dir.display());
        }
    }
}

fn create_isolated_temp_dir() -> std::io::Result<PathBuf> {
    let seq = HOOK_TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("vibevalley-term-hooks-{}-{seq}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

fn prepend_path_value(base_path: Option<&OsStr>, prefix_dirs: &[PathBuf]) -> Option<OsString> {
    if prefix_dirs.is_empty() {
        return None;
    }
    let mut entries: Vec<PathBuf> = prefix_dirs.iter().filter(|p| !p.as_os_str().is_empty()).cloned().collect();
    if let Some(base) = base_path {
        for p in std::env::split_paths(base) {
            if !p.as_os_str().is_empty() && !entries.contains(&p) {
                entries.push(p);
            }
        }
    }
    std::env::join_paths(entries).ok()
}

/// Applies scoped hooks to `cmd` for a single PTY spawn.
///
/// When `hooks.is_empty()` (default), this is a zero-overhead no-op: zero env
/// vars added, zero `PATH` modifications, zero temp directories created, and
/// zero `ZDOTDIR` hook files written.
pub(crate) fn apply_pty_hooks(
    cmd: &mut CommandBuilder,
    env: &[(String, String)],
    hooks: &ResolvedTerminalHooks,
    history_zdotdir_active: bool,
) -> std::io::Result<Option<HookRuntime>> {
    if hooks.is_empty() {
        return Ok(None);
    }

    for (k, v) in hooks.scoped_env_vars() {
        cmd.env(k, v);
    }

    let mut shims: Vec<&PathShimSpec> = Vec::new();
    let mut prepend_dirs: Vec<PathBuf> = Vec::new();
    let mut zsh_chunks: Vec<String> = Vec::new();

    for template in &hooks.templates {
        for shim in &template.shims {
            if is_valid_shim_name(&shim.name) && !shim.script.is_empty() {
                shims.push(shim);
            }
        }
        for dir in &template.prepend_path_dirs {
            if !dir.as_os_str().is_empty() && !prepend_dirs.contains(dir) {
                prepend_dirs.push(dir.clone());
            }
        }
        if let Some(script) = template.zsh_script.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            zsh_chunks.push(format!("# hook: {}\n{script}\n", template.id));
        }
    }

    let needs_runtime_dir = !shims.is_empty() || !zsh_chunks.is_empty();
    let runtime = if needs_runtime_dir {
        Some(HookRuntime {
            dir: create_isolated_temp_dir()?,
        })
    } else {
        None
    };

    if let Some(rt) = &runtime {
        if !shims.is_empty() {
            let bin_dir = rt.dir.join("bin");
            std::fs::create_dir_all(&bin_dir)?;
            for shim in shims {
                let path = bin_dir.join(&shim.name);
                std::fs::write(&path, &shim.script)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
                }
            }
            prepend_dirs.insert(0, bin_dir);
        }

        if !zsh_chunks.is_empty() {
            let hook_zsh = rt.dir.join("hook.zsh");
            std::fs::write(&hook_zsh, zsh_chunks.join("\n"))?;
            cmd.env(ENV_TERM_HOOK_ZSH, &hook_zsh);

            if !history_zdotdir_active {
                let zdotdir = rt.dir.join("zdotdir");
                crate::history::ensure_zdotdir(&zdotdir)?;
                crate::history::apply_zdotdir_forwarding(cmd, env, &zdotdir);
            }
        }
    }

    if !prepend_dirs.is_empty() {
        let explicit_path = env.iter().rfind(|(k, _)| k == "PATH").map(|(_, v)| OsString::from(v));
        let process_path = std::env::var_os("PATH");
        let base = explicit_path.as_deref().or(process_path.as_deref());
        if let Some(joined) = prepend_path_value(base, &prepend_dirs) {
            cmd.env("PATH", joined);
        }
    }

    Ok(runtime)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;
    use crate::{Rgb, SpawnOptions, TermEvent, TermSession, TermSize, Theme};

    fn test_theme() -> Theme {
        Theme {
            foreground: Rgb(220, 220, 220),
            background: Rgb(20, 20, 20),
            cursor: Rgb(255, 255, 255),
            selection: Rgb(60, 80, 120),
            ansi: [Rgb(0, 0, 0); 16],
        }
    }

    fn screen_text(session: &TermSession) -> String {
        let snap = session.snapshot();
        snap.rows
            .iter()
            .map(|row| {
                let mut line = String::new();
                let mut col = 0;
                for run in &row.runs {
                    while col < run.start_col {
                        line.push(' ');
                        col += 1;
                    }
                    line.push_str(&run.text);
                    col += run.cols;
                }
                line
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn wait_for_text(session: &TermSession, events: &std::sync::mpsc::Receiver<TermEvent>, needle: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let text = screen_text(session);
            if text.contains(needle) {
                return;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() || events.recv_timeout(remaining).is_err() {
                panic!("timed out waiting for {needle:?}; screen:\n{}", screen_text(session));
            }
        }
    }

    #[test]
    fn default_config_has_all_hooks_off_by_default() {
        let cfg = TerminalHooksConfig::default();
        assert!(!cfg.is_workspace_hook_enabled(Some(Path::new("/work/repo")), "idegraph"));
        let resolved = cfg.resolve_for_tab(Some(Path::new("/work/repo")), &TabHookOverrides::default());
        assert!(resolved.is_empty());
        assert!(resolved.scoped_env_vars().is_empty());
    }

    #[test]
    fn workspace_and_tab_toggles_compose_and_normalize_paths() {
        let mut cfg = TerminalHooksConfig::default();
        let repo = Path::new("/work/alpha");
        let repo_trailing = Path::new("/work/alpha/");

        // Enable at workspace level.
        cfg.set_workspace_hook_enabled(repo_trailing, "idegraph", true);
        assert!(cfg.is_workspace_hook_enabled(Some(repo), "idegraph"));

        let inherited = cfg.resolve_for_tab(Some(repo), &TabHookOverrides::default());
        assert_eq!(inherited.active_ids(), vec!["idegraph"]);
        assert_eq!(inherited.active[0].source, HookSource::Workspace);

        // Per-tab disable overrides workspace default.
        let mut tab_off = TabHookOverrides::default();
        tab_off.set_enabled("idegraph", true, false);
        assert!(!tab_off.is_empty());
        let resolved_off = cfg.resolve_for_tab(Some(repo), &tab_off);
        assert!(resolved_off.is_empty());

        // Resetting tab back to workspace default clears the override.
        tab_off.set_enabled("idegraph", true, true);
        assert!(tab_off.is_empty());

        // Workspace off + per-tab enable injects only for that tab.
        cfg.set_workspace_hook_enabled(repo, "idegraph", false);
        let mut tab_on = TabHookOverrides::default();
        tab_on.set_enabled("idegraph", false, true);
        let resolved_on = cfg.resolve_for_tab(Some(repo), &tab_on);
        assert_eq!(resolved_on.active_ids(), vec!["idegraph"]);
        assert_eq!(resolved_on.active[0].source, HookSource::Tab);

        let vars = resolved_on.scoped_env_vars();
        assert!(vars.contains(&(ENV_HOOK_IDEGRAPH.into(), "1".into())));
        assert!(vars.contains(&(ENV_IDEGRAPH_SCOPED.into(), "1".into())));
        assert!(vars.contains(&(ENV_IDEGRAPH_WORKSPACE.into(), "/work/alpha".into())));
        assert!(vars.contains(&(ENV_ACTIVE_HOOKS.into(), "idegraph".into())));
    }

    #[test]
    fn custom_hook_template_round_trips_and_rejects_reserved_keys_and_bad_shim_names() {
        let mut cfg = TerminalHooksConfig::default();
        let mut env = BTreeMap::new();
        env.insert("MY_TOOL_MODE".into(), "scoped".into());
        env.insert("PATH".into(), "/evil".into());
        env.insert("ZDOTDIR".into(), "/evil".into());
        let id = cfg
            .upsert_custom_hook(TerminalHookTemplate {
                id: "My Tool!".into(),
                label: "My Tool".into(),
                description: Some("Custom dev hook".into()),
                env,
                prepend_path_dirs: vec![PathBuf::from("/opt/my-tool/bin")],
                shims: vec![
                    PathShimSpec {
                        name: "../escape".into(),
                        script: "#!/bin/sh\necho bad\n".into(),
                    },
                    PathShimSpec {
                        name: "my-tool".into(),
                        script: "#!/bin/sh\necho CUSTOM_SHIM_OK\n".into(),
                    },
                ],
                zsh_script: Some("export MY_ZSH_HOOK=active\n".into()),
            })
            .unwrap();
        assert_eq!(id, "my-tool");

        let json = serde_json::to_string(&cfg).unwrap();
        let decoded: TerminalHooksConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, cfg);

        let mut tab = TabHookOverrides::default();
        tab.set_enabled("my-tool", false, true);
        let resolved = decoded.resolve_for_tab(None, &tab);
        let vars = resolved.scoped_env_vars();
        assert!(vars.contains(&("MY_TOOL_MODE".into(), "scoped".into())));
        assert!(!vars.iter().any(|(k, _)| k == "PATH" || k == "ZDOTDIR"));
        assert!(!is_valid_shim_name("../escape"));
        assert!(is_valid_shim_name("my-tool"));
    }

    #[test]
    fn apply_pty_hooks_is_zero_overhead_when_disabled() {
        let resolved = ResolvedTerminalHooks::default();
        let mut cmd = CommandBuilder::new("/bin/zsh");
        let rt = apply_pty_hooks(&mut cmd, &[], &resolved, true).unwrap();
        assert!(rt.is_none());
        assert!(cmd.get_env(ENV_ACTIVE_HOOKS).is_none());
        assert!(cmd.get_env(ENV_TERM_HOOK_ZSH).is_none());
        assert!(cmd.get_env(ENV_HOOK_IDEGRAPH).is_none());
    }

    #[test]
    fn pty_scoped_idegraph_hook_composes_with_history_shim_isolates_siblings_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let user_home = dir.path().join("home");
        let user_zdotdir = dir.path().join("user_zdot");
        let data_dir = dir.path().join("data");
        let workspace_dir = dir.path().join("repo");
        std::fs::create_dir_all(&user_home).unwrap();
        std::fs::create_dir_all(&user_zdotdir).unwrap();
        std::fs::create_dir_all(&workspace_dir).unwrap();

        let orig_zshrc = "PS1=\"HOOKTEST> \"\nexport USER_RC_LOADED=yes\n";
        std::fs::write(user_zdotdir.join(".zshrc"), orig_zshrc).unwrap();

        let shim_dir = crate::history::shim_dir_for(&data_dir);
        let hist_dir = crate::history::history_dir_for(&data_dir);
        let tab_enabled_hist = crate::history::history_file_for(&hist_dir, "enabled");
        let tab_disabled_hist = crate::history::history_file_for(&hist_dir, "disabled");

        let cfg = TerminalHooksConfig::default();
        let mut tab_on = TabHookOverrides::default();
        tab_on.set_enabled("idegraph", false, true);
        let enabled_hooks = cfg.resolve_for_tab(Some(&workspace_dir), &tab_on);
        let disabled_hooks = cfg.resolve_for_tab(Some(&workspace_dir), &TabHookOverrides::default());
        assert!(disabled_hooks.is_empty());

        let make_opts = |hist_file: &Path, hooks: &ResolvedTerminalHooks| {
            let mut env = vec![
                ("HOME".into(), user_home.to_string_lossy().into_owned()),
                ("ZDOTDIR".into(), user_zdotdir.to_string_lossy().into_owned()),
            ];
            crate::history::configure_env(&mut env, &shim_dir, hist_file);
            hooks.apply_to_spawn_env(&mut env);
            SpawnOptions {
                cwd: workspace_dir.clone(),
                program: Some("/bin/zsh".into()),
                args: vec!["-i".into()],
                env,
                size: TermSize {
                    cols: 120,
                    rows: 24,
                    cell_width_px: 8,
                    cell_height_px: 16,
                },
                scrollback_lines: 200,
                theme: test_theme(),
            }
        };

        // 1. Spawn tab WITH idegraph hook enabled.
        let (tx1, rx1) = std::sync::mpsc::channel();
        let s_enabled = TermSession::spawn_with_hooks(make_opts(&tab_enabled_hist, &enabled_hooks), enabled_hooks, move |ev| {
            let _ = tx1.send(ev);
        })
        .unwrap();
        wait_for_text(&s_enabled, &rx1, "HOOKTEST>");
        s_enabled.send_text("echo HOOKS:$USER_RC_LOADED:$VV_HOOK_IDEGRAPH:$VV_HOOK_IDEGRAPH_ZSH:$IDEGRAPH_SCOPED\n");
        wait_for_text(&s_enabled, &rx1, "HOOKS:yes:1:1:1");
        s_enabled.send_text("printf 'SHIM_OUT:%s\\n' \"$(command -v idegraph)\"\n");
        wait_for_text(&s_enabled, &rx1, "SHIM_OUT:/");

        // Extract the isolated shim path printed on screen so we can verify cleanup after close.
        let screen = screen_text(&s_enabled);
        let shim_bin_path = screen
            .lines()
            .filter_map(|line| line.split("SHIM_OUT:").nth(1))
            .map(str::trim)
            .find(|s| s.starts_with('/'))
            .expect("SHIM_OUT line present");
        let shim_runtime_dir = Path::new(shim_bin_path)
            .parent()
            .and_then(|p| p.parent())
            .expect("shim dir has parent")
            .to_path_buf();
        assert!(shim_runtime_dir.exists(), "isolated temp shim dir must exist while tab is alive");

        // History shim (#83) still records commands cleanly alongside the hook.
        s_enabled.send_text("echo history_with_hook_ok\n");
        wait_for_text(&s_enabled, &rx1, "history_with_hook_ok");

        // 2. Spawn sibling tab WITH hooks disabled (default) and verify ZERO leakage.
        let (tx2, rx2) = std::sync::mpsc::channel();
        let s_disabled = TermSession::spawn_with_hooks(make_opts(&tab_disabled_hist, &disabled_hooks), disabled_hooks, move |ev| {
            let _ = tx2.send(ev);
        })
        .unwrap();
        wait_for_text(&s_disabled, &rx2, "HOOKTEST>");
        s_disabled.send_text("echo DISABLED:$USER_RC_LOADED:${VV_HOOK_IDEGRAPH:-none}:${IDEGRAPH_SCOPED:-none}:${VV_TERM_HOOK_ZSH:-none}\n");
        wait_for_text(&s_disabled, &rx2, "DISABLED:yes:none:none:none");

        // User's original .zshrc was never mutated.
        assert_eq!(std::fs::read_to_string(user_zdotdir.join(".zshrc")).unwrap(), orig_zshrc);

        // Shut down enabled tab and verify isolated temp shim directory is cleaned up.
        s_enabled.shutdown_and_wait(Duration::from_secs(3));
        assert!(!s_enabled.is_alive());
        assert!(
            !shim_runtime_dir.exists(),
            "isolated hook temp dir {} must be cleaned up when tab closes",
            shim_runtime_dir.display()
        );

        s_disabled.shutdown_and_wait(Duration::from_secs(3));
        assert!(!s_disabled.is_alive());
        assert!(tab_enabled_hist.exists());
    }

    #[test]
    fn pty_standalone_hook_works_without_history_shim_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let user_home = dir.path().join("home");
        let user_zdotdir = dir.path().join("user_zdot");
        let custom_bin = dir.path().join("custom_bin");
        std::fs::create_dir_all(&user_home).unwrap();
        std::fs::create_dir_all(&user_zdotdir).unwrap();
        std::fs::create_dir_all(&custom_bin).unwrap();
        std::fs::write(user_zdotdir.join(".zshrc"), "PS1=\"SOLO> \"\n").unwrap();

        let mut cfg = TerminalHooksConfig::default();
        cfg.upsert_custom_hook(TerminalHookTemplate {
            id: "devtool".into(),
            label: "devtool".into(),
            description: None,
            env: BTreeMap::from([("DEVTOOL_ACTIVE".into(), "yes".into())]),
            prepend_path_dirs: vec![custom_bin.clone()],
            shims: vec![PathShimSpec {
                name: "devtool-hello".into(),
                script: "#!/bin/sh\necho DEVTOOL_SHIM_RAN\n".into(),
            }],
            zsh_script: Some("export DEVTOOL_ZSH=loaded\n".into()),
        });
        let mut tab = TabHookOverrides::default();
        tab.set_enabled("devtool", false, true);
        let hooks = cfg.resolve_for_tab(None, &tab);

        let (tx, rx) = std::sync::mpsc::channel();
        let session = TermSession::spawn_with_hooks(
            SpawnOptions {
                cwd: dir.path().to_path_buf(),
                program: Some("/bin/zsh".into()),
                args: vec!["-i".into()],
                env: vec![
                    ("HOME".into(), user_home.to_string_lossy().into_owned()),
                    ("ZDOTDIR".into(), user_zdotdir.to_string_lossy().into_owned()),
                ],
                size: TermSize {
                    cols: 120,
                    rows: 24,
                    cell_width_px: 8,
                    cell_height_px: 16,
                },
                scrollback_lines: 100,
                theme: test_theme(),
            },
            hooks,
            move |ev| {
                let _ = tx.send(ev);
            },
        )
        .unwrap();

        wait_for_text(&session, &rx, "SOLO>");
        session.send_text("echo CHECK:$DEVTOOL_ACTIVE:$DEVTOOL_ZSH\n");
        wait_for_text(&session, &rx, "CHECK:yes:loaded");
        session.send_text("devtool-hello\n");
        wait_for_text(&session, &rx, "DEVTOOL_SHIM_RAN");
        session.send_text("printf 'ZDOT_OUT:%s\\n' \"$VV_SHIM_ZDOTDIR\"\n");
        wait_for_text(&session, &rx, "ZDOT_OUT:/");

        let screen = screen_text(&session);
        let zdot = screen
            .lines()
            .filter_map(|line| line.split("ZDOT_OUT:").nth(1))
            .map(str::trim)
            .find(|s| s.starts_with('/'))
            .expect("ZDOT_OUT line present");
        let runtime_dir = Path::new(zdot).parent().expect("zdotdir parent").to_path_buf();
        assert!(runtime_dir.exists());

        session.shutdown_and_wait(Duration::from_secs(3));
        assert!(!runtime_dir.exists(), "standalone hook runtime dir must be cleaned up on shutdown");
    }
}
