use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use portable_pty::CommandBuilder;

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

    cfg.set_workspace_hook_enabled(repo_trailing, "idegraph", true);
    assert!(cfg.is_workspace_hook_enabled(Some(repo), "idegraph"));

    let inherited = cfg.resolve_for_tab(Some(repo), &TabHookOverrides::default());
    assert_eq!(inherited.active_ids(), vec!["idegraph"]);
    assert_eq!(inherited.active[0].source, HookSource::Workspace);

    let mut tab_off = TabHookOverrides::default();
    tab_off.set_enabled("idegraph", true, false);
    assert!(!tab_off.is_empty());
    let resolved_off = cfg.resolve_for_tab(Some(repo), &tab_off);
    assert!(resolved_off.is_empty());

    tab_off.set_enabled("idegraph", true, true);
    assert!(tab_off.is_empty());

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

    s_enabled.send_text("echo history_with_hook_ok\n");
    wait_for_text(&s_enabled, &rx1, "history_with_hook_ok");

    let (tx2, rx2) = std::sync::mpsc::channel();
    let s_disabled = TermSession::spawn_with_hooks(make_opts(&tab_disabled_hist, &disabled_hooks), disabled_hooks, move |ev| {
        let _ = tx2.send(ev);
    })
    .unwrap();
    wait_for_text(&s_disabled, &rx2, "HOOKTEST>");
    s_disabled.send_text("echo DISABLED:$USER_RC_LOADED:${VV_HOOK_IDEGRAPH:-none}:${IDEGRAPH_SCOPED:-none}:${VV_TERM_HOOK_ZSH:-none}\n");
    wait_for_text(&s_disabled, &rx2, "DISABLED:yes:none:none:none");

    assert_eq!(std::fs::read_to_string(user_zdotdir.join(".zshrc")).unwrap(), orig_zshrc);

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
