//! Non-invasive per-tab zsh command history persistence via an isolated `ZDOTDIR` shim.
//!
//! Instead of mutating `~/.zshrc`, each terminal tab sets `ZDOTDIR` to a shared
//! shim directory and passes its own `VV_TERM_HISTORY_FILE`. The shim restores the
//! user's original `ZDOTDIR` before sourcing `~/.zshenv`, `~/.zprofile`, `~/.zshrc`,
//! and `~/.zlogin`, enables `INC_APPEND_HISTORY`, appends commands to the tab's
//! history file via `zshaddhistory`, and loads that file with `fc -R` on the first
//! `precmd` after zsh finishes loading the user's global `HISTFILE`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use portable_pty::CommandBuilder;

pub const ENV_TERM_HISTORY_FILE: &str = "VV_TERM_HISTORY_FILE";
pub const ENV_ORIG_ZDOTDIR: &str = "VV_ORIG_ZDOTDIR";
pub const ENV_SHIM_ZDOTDIR: &str = "VV_SHIM_ZDOTDIR";

const ZSHENV_SHIM: &str = r#"# Managed by VibeValley; transparently forwards to the user's real .zshenv.
typeset -g _vv_prev_zdotdir="${VV_ORIG_ZDOTDIR:-}"
if [[ -n "$_vv_prev_zdotdir" ]]; then
  export ZDOTDIR="$_vv_prev_zdotdir"
else
  unset ZDOTDIR
fi
unset _vv_prev_zdotdir
if [[ -r "${ZDOTDIR:-$HOME}/.zshenv" ]]; then
  builtin source "${ZDOTDIR:-$HOME}/.zshenv"
fi
if [[ -n "${ZDOTDIR:-}" && "$ZDOTDIR" != "${VV_SHIM_ZDOTDIR:-}" ]]; then
  export VV_ORIG_ZDOTDIR="$ZDOTDIR"
fi
if [[ -n "${VV_SHIM_ZDOTDIR:-}" ]]; then
  export ZDOTDIR="$VV_SHIM_ZDOTDIR"
fi
"#;

const ZPROFILE_SHIM: &str = r#"# Managed by VibeValley; transparently forwards to the user's real .zprofile.
if [[ -n "${VV_ORIG_ZDOTDIR:-}" ]]; then
  export ZDOTDIR="$VV_ORIG_ZDOTDIR"
else
  unset ZDOTDIR
fi
if [[ -r "${ZDOTDIR:-$HOME}/.zprofile" ]]; then
  builtin source "${ZDOTDIR:-$HOME}/.zprofile"
fi
if [[ -n "${ZDOTDIR:-}" && "$ZDOTDIR" != "${VV_SHIM_ZDOTDIR:-}" ]]; then
  export VV_ORIG_ZDOTDIR="$ZDOTDIR"
fi
if [[ -n "${VV_SHIM_ZDOTDIR:-}" ]]; then
  export ZDOTDIR="$VV_SHIM_ZDOTDIR"
fi
"#;

const ZSHRC_SHIM: &str = r#"# Managed by VibeValley; forwards to user .zshrc and persists per-tab history.
if [[ -n "${VV_ORIG_ZDOTDIR:-}" ]]; then
  export ZDOTDIR="$VV_ORIG_ZDOTDIR"
else
  unset ZDOTDIR
fi
# /etc/zshrc on macOS defaults HISTFILE to ${ZDOTDIR:-$HOME}/.zsh_history before .zshrc runs.
if [[ -n "${VV_SHIM_ZDOTDIR:-}" && "${HISTFILE:-}" == "$VV_SHIM_ZDOTDIR/.zsh_history" ]]; then
  HISTFILE="${ZDOTDIR:-$HOME}/.zsh_history"
fi
if [[ -r "${ZDOTDIR:-$HOME}/.zshrc" ]]; then
  builtin source "${ZDOTDIR:-$HOME}/.zshrc"
fi
if [[ -n "${VV_TERM_HISTORY_FILE:-}" ]]; then
  (( ${HISTSIZE:-0} < 1000 )) && HISTSIZE=10000
  (( ${SAVEHIST:-0} < 1000 )) && SAVEHIST=10000
  builtin setopt INC_APPEND_HISTORY
  builtin zmodload -F zsh/datetime p:EPOCHSECONDS 2>/dev/null || true

  _vv_load_tab_history() {
    builtin emulate -L zsh
    # Runs in the first precmd so fc -R appends after zsh loads global $HISTFILE.
    if [[ -n "${VV_TERM_HISTORY_FILE:-}" && -r "$VV_TERM_HISTORY_FILE" ]]; then
      builtin fc -R "$VV_TERM_HISTORY_FILE"
    fi
    precmd_functions=( ${precmd_functions:#_vv_load_tab_history} )
    builtin unfunction _vv_load_tab_history 2>/dev/null || true
  }

  _vv_append_tab_history() {
    builtin emulate -L zsh
    [[ -n "${VV_TERM_HISTORY_FILE:-}" ]] || return 0
    local line="${1%$'\n'}"
    [[ -z "${line//[[:space:]]/}" ]] && return 0
    [[ -o HIST_IGNORE_SPACE && "$line" == [[:space:]]* ]] && return 0
    local escaped="${line//$'\n'/\\$'\n'}"
    local ts="${EPOCHSECONDS:-$(command date +%s 2>/dev/null || printf 0)}"
    local dir="${VV_TERM_HISTORY_FILE:h}"
    [[ -d "$dir" ]] || command mkdir -p -- "$dir" 2>/dev/null || return 0
    builtin print -r -- ": ${ts}:0;${escaped}" >>| "$VV_TERM_HISTORY_FILE" 2>/dev/null || true
    return 0
  }

  builtin typeset -ga precmd_functions zshaddhistory_functions
  precmd_functions+=(_vv_load_tab_history)
  zshaddhistory_functions+=(_vv_append_tab_history)
fi
if [[ -n "${VV_TERM_HOOK_ZSH:-}" && -r "$VV_TERM_HOOK_ZSH" ]]; then
  builtin source "$VV_TERM_HOOK_ZSH"
fi
"#;

const ZLOGIN_SHIM: &str = r#"# Managed by VibeValley; forwards to user .zlogin (for non-interactive login shells).
if [[ -n "${VV_ORIG_ZDOTDIR:-}" ]]; then
  export ZDOTDIR="$VV_ORIG_ZDOTDIR"
else
  unset ZDOTDIR
fi
if [[ -r "${ZDOTDIR:-$HOME}/.zlogin" ]]; then
  builtin source "${ZDOTDIR:-$HOME}/.zlogin"
fi
if [[ ! -o interactive && -n "${VV_SHIM_ZDOTDIR:-}" ]]; then
  export ZDOTDIR="$VV_SHIM_ZDOTDIR"
fi
"#;

const ZLOGOUT_SHIM: &str = r#"# Managed by VibeValley; forwards to user .zlogout.
if [[ -r "${VV_ORIG_ZDOTDIR:-$HOME}/.zlogout" ]]; then
  builtin source "${VV_ORIG_ZDOTDIR:-$HOME}/.zlogout"
fi
"#;

const SHIM_FILES: &[(&str, &str)] = &[
    (".zshenv", ZSHENV_SHIM),
    (".zprofile", ZPROFILE_SHIM),
    (".zshrc", ZSHRC_SHIM),
    (".zlogin", ZLOGIN_SHIM),
    (".zlogout", ZLOGOUT_SHIM),
];

static SHIM_WRITE_LOCK: Mutex<()> = Mutex::new(());
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Directory holding per-tab history files and the shared `zdotdir` shim.
pub fn history_dir_for(data_dir: &Path) -> PathBuf {
    data_dir.join("terminal-history")
}

/// Shared `ZDOTDIR` shim directory under `data_dir`.
pub fn shim_dir_for(data_dir: &Path) -> PathBuf {
    history_dir_for(data_dir).join("zdotdir")
}

/// Per-tab zsh history file path inside `history_dir`.
pub fn history_file_for(history_dir: &Path, terminal_id: &str) -> PathBuf {
    let sanitized: String = terminal_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let name = if sanitized.is_empty() { "default" } else { &sanitized };
    history_dir.join(format!("{name}.zsh_history"))
}

/// Appends the `ZDOTDIR` shim parameters to a terminal spawn environment list.
pub fn configure_env(env: &mut Vec<(String, String)>, shim_dir: &Path, history_file: &Path) {
    env.retain(|(k, _)| k != ENV_SHIM_ZDOTDIR && k != ENV_TERM_HISTORY_FILE);
    env.push((ENV_SHIM_ZDOTDIR.into(), shim_dir.to_string_lossy().into_owned()));
    env.push((ENV_TERM_HISTORY_FILE.into(), history_file.to_string_lossy().into_owned()));
}

/// Ensures the isolated `ZDOTDIR` shim files exist and match the current script versions.
pub fn ensure_zdotdir(shim_dir: &Path) -> std::io::Result<()> {
    let _guard = SHIM_WRITE_LOCK.lock().unwrap();
    std::fs::create_dir_all(shim_dir)?;
    for &(name, contents) in SHIM_FILES {
        write_if_changed(&shim_dir.join(name), contents)?;
    }
    Ok(())
}

/// Deletes a closed tab's history file, ignoring missing files.
pub fn remove_history_file(path: &Path) {
    if let Err(err) = std::fs::remove_file(path)
        && err.kind() != std::io::ErrorKind::NotFound
    {
        eprintln!("remove terminal history {}: {err}", path.display());
    }
}

fn write_if_changed(path: &Path, contents: &str) -> std::io::Result<()> {
    if std::fs::read_to_string(path).ok().as_deref() == Some(contents) {
        return Ok(());
    }
    let seq = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_file_name(format!(
        ".{}.tmp.{}.{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("shim"),
        std::process::id(),
        seq
    ));
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)
}

pub(crate) fn apply_pty_env(cmd: &mut CommandBuilder, env: &[(String, String)]) -> bool {
    let mut shim_dir: Option<&str> = None;

    for (key, value) in env {
        cmd.env(key, value);
        if key == ENV_SHIM_ZDOTDIR {
            shim_dir = Some(value.as_str());
        }
    }

    let Some(shim) = shim_dir.filter(|s| !s.is_empty()) else {
        return false;
    };
    let shim_path = Path::new(shim);
    if let Err(err) = ensure_zdotdir(shim_path) {
        eprintln!("terminal zdotdir shim {}: {err}", shim_path.display());
        return false;
    }

    apply_zdotdir_forwarding(cmd, env, shim_path);
    true
}

pub(crate) fn apply_zdotdir_forwarding(cmd: &mut CommandBuilder, env: &[(String, String)], shim_path: &Path) {
    let shim = shim_path.to_string_lossy();
    let explicit_orig_zdotdir = env.iter().rfind(|(k, _)| k == ENV_ORIG_ZDOTDIR).map(|(_, v)| v.as_str());
    let explicit_zdotdir = env.iter().rfind(|(k, _)| k == "ZDOTDIR").map(|(_, v)| v.as_str());

    let orig = explicit_orig_zdotdir
        .filter(|s| !s.is_empty() && *s != shim.as_ref())
        .map(std::ffi::OsString::from)
        .or_else(|| explicit_zdotdir.filter(|s| !s.is_empty() && *s != shim.as_ref()).map(std::ffi::OsString::from))
        .or_else(|| std::env::var_os("ZDOTDIR").filter(|s| !s.is_empty() && s.to_string_lossy() != shim.as_ref()));

    match orig {
        Some(orig) => cmd.env(ENV_ORIG_ZDOTDIR, orig),
        None => cmd.env_remove(ENV_ORIG_ZDOTDIR),
    }
    cmd.env(ENV_SHIM_ZDOTDIR, shim_path);
    cmd.env("ZDOTDIR", shim_path);
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
    fn ensure_zdotdir_writes_all_shim_files_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let shim = shim_dir_for(dir.path());
        ensure_zdotdir(&shim).unwrap();

        for &(name, expected) in SHIM_FILES {
            let path = shim.join(name);
            assert_eq!(std::fs::read_to_string(&path).unwrap(), expected);
        }

        // Second call is a no-op when contents already match.
        let mtime_before = std::fs::metadata(shim.join(".zshrc")).unwrap().modified().unwrap();
        ensure_zdotdir(&shim).unwrap();
        let mtime_after = std::fs::metadata(shim.join(".zshrc")).unwrap().modified().unwrap();
        assert_eq!(mtime_before, mtime_after);
    }

    #[test]
    fn history_file_for_sanitizes_terminal_id_and_removes_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let hdir = history_dir_for(dir.path());
        assert_eq!(history_file_for(&hdir, "abc123"), hdir.join("abc123.zsh_history"));
        assert_eq!(history_file_for(&hdir, "../weird/id"), hdir.join("___weird_id.zsh_history"));
        assert_eq!(history_file_for(&hdir, ""), hdir.join("default.zsh_history"));

        std::fs::create_dir_all(&hdir).unwrap();
        let file = history_file_for(&hdir, "tab1");
        std::fs::write(&file, ": 1:0;echo hi\n").unwrap();
        assert!(file.exists());
        remove_history_file(&file);
        assert!(!file.exists());
        // Missing file removal is a silent no-op.
        remove_history_file(&file);
    }

    #[test]
    fn zsh_shim_forwards_user_rcs_persists_per_tab_history_and_reloads_on_restart() {
        let dir = tempfile::tempdir().unwrap();
        let user_home = dir.path().join("home");
        let user_zdotdir = dir.path().join("user_zdot");
        let data_dir = dir.path().join("data");
        std::fs::create_dir_all(&user_home).unwrap();
        std::fs::create_dir_all(&user_zdotdir).unwrap();

        let global_hist = user_home.join(".zsh_history");
        std::fs::write(&global_hist, ": 1000:0;echo global_hist_entry\n").unwrap();

        std::fs::write(user_zdotdir.join(".zshenv"), "export USER_ZSHENV=yes\n").unwrap();
        std::fs::write(user_zdotdir.join(".zprofile"), "export USER_ZPROFILE=yes\n").unwrap();
        let orig_zshrc = format!(
            "setopt NO_UNSET\nexport USER_ZSHRC_ZDOTDIR=\"$ZDOTDIR\"\nHISTFILE=\"{}\"\nHISTSIZE=5000\nSAVEHIST=5000\nPS1=\"VVTEST> \"\n",
            global_hist.display()
        );
        std::fs::write(user_zdotdir.join(".zshrc"), &orig_zshrc).unwrap();

        let shim_dir = shim_dir_for(&data_dir);
        let hist_dir = history_dir_for(&data_dir);
        let tab1_hist = history_file_for(&hist_dir, "tab1");
        let tab2_hist = history_file_for(&hist_dir, "tab2");

        let make_opts = |hist_file: &Path| {
            let mut env = vec![
                ("HOME".into(), user_home.to_string_lossy().into_owned()),
                ("ZDOTDIR".into(), user_zdotdir.to_string_lossy().into_owned()),
            ];
            configure_env(&mut env, &shim_dir, hist_file);
            SpawnOptions {
                cwd: dir.path().to_path_buf(),
                program: Some("/bin/zsh".into()),
                args: vec!["-l".into()],
                env,
                size: TermSize {
                    cols: 120,
                    rows: 24,
                    cell_width_px: 8,
                    cell_height_px: 16,
                },
                scrollback_lines: 500,
                theme: test_theme(),
            }
        };

        // Tab 1 runs a command, then quits via graceful shutdown.
        let (tx1, rx1) = std::sync::mpsc::channel();
        let s1 = TermSession::spawn(make_opts(&tab1_hist), move |ev| {
            let _ = tx1.send(ev);
        })
        .unwrap();
        wait_for_text(&s1, &rx1, "VVTEST>");
        s1.send_text("echo CHECK:$USER_ZSHENV:$USER_ZPROFILE:$USER_ZSHRC_ZDOTDIR\n");
        wait_for_text(&s1, &rx1, &format!("CHECK:yes:yes:{}", user_zdotdir.display()));
        s1.send_text("echo tab1_unique_command\n");
        wait_for_text(&s1, &rx1, "tab1_unique_command");
        s1.shutdown_and_wait(Duration::from_secs(3));
        assert!(!s1.is_alive());

        // Tab 2 runs a different command after Tab 1 so global HISTFILE ends with Tab 2's command.
        let (tx2, rx2) = std::sync::mpsc::channel();
        let s2 = TermSession::spawn(make_opts(&tab2_hist), move |ev| {
            let _ = tx2.send(ev);
        })
        .unwrap();
        wait_for_text(&s2, &rx2, "VVTEST>");
        s2.send_text("echo tab2_later_command\n");
        wait_for_text(&s2, &rx2, "tab2_later_command");
        s2.shutdown_and_wait(Duration::from_secs(3));
        assert!(!s2.is_alive());

        // User's original .zshrc was never modified.
        assert_eq!(std::fs::read_to_string(user_zdotdir.join(".zshrc")).unwrap(), orig_zshrc);
        assert!(tab1_hist.exists());
        assert!(tab2_hist.exists());

        // Reopen Tab 1: pressing Up arrow must recall Tab 1's own last command, not Tab 2's,
        // and global_hist_entry must still be present in fc -l.
        let (tx, rx) = std::sync::mpsc::channel();
        let s1_restored = TermSession::spawn(make_opts(&tab1_hist), move |ev| {
            let _ = tx.send(ev);
        })
        .unwrap();
        wait_for_text(&s1_restored, &rx, "VVTEST>");
        s1_restored.send_key(crate::KeyInput {
            key: crate::Key::Up,
            mods: crate::Mods::default(),
            text: None,
        });
        wait_for_text(&s1_restored, &rx, "VVTEST> echo tab1_unique_command");
        s1_restored.send_text("\n");
        wait_for_text(&s1_restored, &rx, "tab1_unique_command");
        s1_restored.send_text("fc -l 1 | grep -q global_hist_entry && echo GLOBAL_OK\n");
        wait_for_text(&s1_restored, &rx, "GLOBAL_OK");
        s1_restored.send_text("exit\n");
        let deadline = Instant::now() + Duration::from_secs(5);
        while let Ok(ev) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            if matches!(ev, TermEvent::Exited { .. }) {
                break;
            }
        }
        assert!(!s1_restored.is_alive());
    }
}
