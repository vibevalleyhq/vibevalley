use super::super::ChatTabStatus;
use super::policy::{
    TabCloseAction, TerminalFileAction, classify_terminal_file_action, closed_chat_session_id, non_terminal_tab_busy_label, resolve_project_directory,
    tab_close_action, terminal_history_path_in,
};

#[test]
fn file_urls_decode() {
    assert_eq!(crate::host::percent_decode("/tmp/%E6%88%AA%E5%9B%BE%201.png"), "/tmp/截图 1.png");
    assert_eq!(crate::host::percent_decode("/a%zzb%"), "/a%zzb%");
}

#[test]
fn terminal_file_action_routes_project_text_to_viewer_and_binaries_or_external_media_to_system() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("proj");
    let outside = dir.path().join("outside");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(&outside).unwrap();

    let proj_rs = project.join("main.rs");
    let proj_png = project.join("icon.png");
    let proj_bin = project.join("app.bin");
    let ext_rs = outside.join("lib.rs");
    let ext_unknown_text = outside.join("scratch");
    let ext_png = outside.join("photo.png");
    let ext_pdf = outside.join("doc.pdf");

    std::fs::write(&proj_rs, "fn main() {}\n").unwrap();
    std::fs::write(&proj_png, b"\x89PNG\r\n\x1a\n").unwrap();
    std::fs::write(&proj_bin, b"\x7fELF\0\x01\x02").unwrap();
    std::fs::write(&ext_rs, "pub fn x() {}\n").unwrap();
    std::fs::write(&ext_unknown_text, "plain text\n").unwrap();
    std::fs::write(&ext_png, b"\x89PNG\r\n\x1a\n").unwrap();
    std::fs::write(&ext_pdf, b"%PDF-1.7\0binary").unwrap();

    assert_eq!(
        classify_terminal_file_action(proj_rs.clone(), Some(12), Some(&project)),
        TerminalFileAction::Viewer {
            path: proj_rs.clone(),
            line: Some(12),
        }
    );
    assert_eq!(
        classify_terminal_file_action(proj_png.clone(), None, Some(&project)),
        TerminalFileAction::Viewer { path: proj_png, line: None }
    );
    assert_eq!(
        classify_terminal_file_action(proj_bin.clone(), None, Some(&project)),
        TerminalFileAction::SystemOpen(proj_bin)
    );
    assert_eq!(
        classify_terminal_file_action(ext_rs.clone(), Some(5), Some(&project)),
        TerminalFileAction::Viewer { path: ext_rs, line: Some(5) }
    );
    assert_eq!(
        classify_terminal_file_action(ext_unknown_text.clone(), None, Some(&project)),
        TerminalFileAction::SystemOpen(ext_unknown_text.clone())
    );
    assert_eq!(
        classify_terminal_file_action(ext_unknown_text.clone(), Some(3), Some(&project)),
        TerminalFileAction::Viewer {
            path: ext_unknown_text,
            line: Some(3),
        }
    );
    assert_eq!(
        classify_terminal_file_action(ext_png.clone(), None, Some(&project)),
        TerminalFileAction::SystemOpen(ext_png)
    );
    assert_eq!(
        classify_terminal_file_action(ext_pdf.clone(), None, Some(&project)),
        TerminalFileAction::SystemOpen(ext_pdf)
    );
    assert_eq!(
        classify_terminal_file_action(project.clone(), None, Some(&project)),
        TerminalFileAction::SystemOpen(project)
    );
    assert_eq!(
        classify_terminal_file_action(proj_rs.clone(), Some(1), None),
        TerminalFileAction::SystemOpen(proj_rs)
    );
}

#[test]
fn closed_chat_session_id_only_matches_non_empty_chat_tabs() {
    use std::path::PathBuf;
    use vibevalley_workspace::PaneKind;

    assert_eq!(
        closed_chat_session_id(Some(&PaneKind::Chat {
            session_id: " w42 ".into(),
            runtime: "antigravity".into(),
            cwd: PathBuf::from("/tmp"),
            title: None,
        })),
        Some("w42".into())
    );
    assert_eq!(
        closed_chat_session_id(Some(&PaneKind::Chat {
            session_id: "   ".into(),
            runtime: "antigravity".into(),
            cwd: PathBuf::from("/tmp"),
            title: None,
        })),
        None
    );
    assert_eq!(
        closed_chat_session_id(Some(&PaneKind::Terminal {
            terminal_id: "t1".into(),
            link: None,
            hooks: Default::default(),
        })),
        None
    );
    assert_eq!(closed_chat_session_id(None), None);
}

#[test]
fn resolve_project_directory_matches_known_root_and_rejects_missing_folder() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("project");
    let nested = project.join("src");
    std::fs::create_dir_all(&nested).unwrap();

    let (resolved_dir, target) = resolve_project_directory(nested.clone(), vec![project.clone()]).expect("existing directory resolves");
    assert_eq!(resolved_dir, nested.canonicalize().unwrap());
    assert_eq!(target, project);

    let missing = dir.path().join("does-not-exist");
    assert!(resolve_project_directory(missing, vec![]).is_err());
}

#[test]
fn tab_close_decision_guards_busy_tabs_and_honors_force_bypass() {
    assert_eq!(tab_close_action(None, false), TabCloseAction::CloseNow);
    assert_eq!(
        tab_close_action(Some("cargo test".into()), false),
        TabCloseAction::ConfirmBusy { label: "cargo test".into() }
    );
    assert_eq!(tab_close_action(Some("cargo test".into()), true), TabCloseAction::CloseNow);
    assert_eq!(tab_close_action(None, true), TabCloseAction::CloseNow);
}

#[test]
fn non_terminal_tab_busy_label_guards_working_chats_and_never_flags_viewers() {
    use std::path::PathBuf;
    use vibevalley_workspace::{DiffSpec, PaneKind};

    let chat = PaneKind::Chat {
        session_id: "s1".into(),
        runtime: "antigravity".into(),
        cwd: PathBuf::from("/tmp"),
        title: None,
    };
    let working = ChatTabStatus {
        status: "working".into(),
        attention: false,
    };
    let ready = ChatTabStatus {
        status: "ready".into(),
        attention: true,
    };
    assert_eq!(non_terminal_tab_busy_label(&chat, Some(&working)), Some("Antigravity".into()));
    assert_eq!(non_terminal_tab_busy_label(&chat, Some(&ready)), None);
    assert_eq!(non_terminal_tab_busy_label(&chat, None), None);

    let titled_chat = PaneKind::Chat {
        session_id: "s2".into(),
        runtime: "claude".into(),
        cwd: PathBuf::from("/tmp"),
        title: Some("  Refactor panes  ".into()),
    };
    assert_eq!(non_terminal_tab_busy_label(&titled_chat, Some(&working)), Some("Refactor panes".into()));

    let file = PaneKind::File {
        path: PathBuf::from("/tmp/main.rs"),
    };
    let diff = PaneKind::Diff {
        spec: DiffSpec::Unstaged,
        path: None,
        repo: None,
    };
    assert_eq!(non_terminal_tab_busy_label(&file, Some(&working)), None);
    assert_eq!(non_terminal_tab_busy_label(&diff, Some(&working)), None);
}

#[test]
fn terminal_history_path_in_uses_per_tab_file_and_cleanup_removes_only_target_tab() {
    let dir = tempfile::tempdir().unwrap();
    let hist_dir = vibevalley_terminal::history::history_dir_for(dir.path());
    std::fs::create_dir_all(&hist_dir).unwrap();

    let tab_a = terminal_history_path_in(&hist_dir, "tab-a");
    let tab_b = terminal_history_path_in(&hist_dir, "tab-b");
    std::fs::write(&tab_a, ": 1:0;ls\n").unwrap();
    std::fs::write(&tab_b, ": 2:0;pwd\n").unwrap();

    vibevalley_terminal::history::remove_history_file(&tab_a);
    assert!(!tab_a.exists());
    assert!(tab_b.exists());
}

#[test]
fn terminal_hooks_resolution_stays_empty_by_default_and_respects_workspace_and_tab_toggles() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();

    let mut cfg = vibevalley_terminal::TerminalHooksConfig::default();
    let default_resolved = cfg.resolve_for_tab(Some(&repo), &Default::default());
    assert!(default_resolved.is_empty());

    let mut tab_overrides = vibevalley_terminal::TabHookOverrides::default();
    tab_overrides.set_enabled("idegraph", false, true);
    let tab_enabled = cfg.resolve_for_tab(Some(&repo), &tab_overrides);
    assert_eq!(tab_enabled.active_ids(), vec!["idegraph"]);

    cfg.set_workspace_hook_enabled(&repo, "idegraph", true);
    let mut tab_disabled = vibevalley_terminal::TabHookOverrides::default();
    tab_disabled.set_enabled("idegraph", true, false);
    assert!(cfg.resolve_for_tab(Some(&repo), &tab_disabled).is_empty());
    assert_eq!(cfg.resolve_for_tab(Some(&repo), &Default::default()).active_ids(), vec!["idegraph"]);
}
