use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use portable_pty::CommandBuilder;

use super::{ENV_TERM_HOOK_ZSH, PathShimSpec, ResolvedTerminalHooks, is_valid_shim_name};

static HOOK_TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

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
