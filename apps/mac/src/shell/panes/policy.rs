use std::path::{Path, PathBuf};

use vibevalley_git::Repo;
use vibevalley_workspace::PaneKind;

use super::super::ChatTabStatus;

pub(super) fn resolve_project_directory(cwd: PathBuf, known_roots: Vec<PathBuf>) -> Result<(PathBuf, PathBuf), String> {
    let Some(directory) = cwd.canonicalize().ok().filter(|p| p.is_dir()) else {
        return Err(format!("{} {}", vibevalley_i18n::t("desktop.terminal.missingFolder", &[]), cwd.display()));
    };
    let repo = Repo::discover(&directory).ok().flatten();
    let root = repo.as_ref().map(|r| r.root()).unwrap_or(&directory);
    let target = known_roots
        .into_iter()
        .filter_map(|known| {
            let path = known.canonicalize().ok()?;
            (path == root || (repo.is_none() && directory.starts_with(&path))).then(|| (path.components().count(), known))
        })
        .max_by_key(|(depth, _)| *depth)
        .map(|(_, path)| path)
        .unwrap_or_else(|| root.to_owned());
    Ok((directory, target))
}

pub(super) fn closed_chat_session_id(closed: Option<&PaneKind>) -> Option<String> {
    let PaneKind::Chat { session_id, .. } = closed? else { return None };
    let trimmed = session_id.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum TerminalFileAction {
    Viewer { path: PathBuf, line: Option<u32> },
    SystemOpen(PathBuf),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FilePreviewKind {
    Text,
    Image,
    SystemOnly,
}

fn sniff_file_preview_kind(path: &Path) -> FilePreviewKind {
    use std::io::Read as _;

    const MAX_VIEWER_BYTES: u64 = 8 * 1024 * 1024;
    const SNIFF_BYTES: usize = 8192;
    const IMAGE_EXTS: &[&str] = &[
        "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "tif", "tiff", "heic", "heif", "avif", "svg",
    ];

    let Ok(meta) = std::fs::metadata(path) else {
        return FilePreviewKind::SystemOnly;
    };
    if !meta.is_file() {
        return FilePreviewKind::SystemOnly;
    }
    if path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
    {
        return FilePreviewKind::Image;
    }
    if meta.len() > MAX_VIEWER_BYTES {
        return FilePreviewKind::SystemOnly;
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return FilePreviewKind::SystemOnly;
    };
    let mut head = [0u8; SNIFF_BYTES];
    let n = file.read(&mut head).unwrap_or(0);
    let head = &head[..n];
    let utf16_bom = matches!(head, [0xFF, 0xFE, ..] | [0xFE, 0xFF, ..]);
    if !utf16_bom && head.contains(&0) {
        return FilePreviewKind::SystemOnly;
    }
    FilePreviewKind::Text
}

fn is_plain_text_name(path: &Path) -> bool {
    const TEXT_EXTS: &[&str] = &[
        "txt", "log", "env", "ini", "cfg", "conf", "csv", "tsv", "xml", "sql", "graphql", "gql", "proto", "diff", "patch", "lock", "nix", "rb", "java", "kt",
        "scala", "php", "lua", "vim", "fish", "tf", "hcl",
    ];
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| TEXT_EXTS.iter().any(|t| ext.eq_ignore_ascii_case(t)))
}

fn path_is_inside(path: &Path, root: &Path) -> bool {
    let canon_path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let canon_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    canon_path.starts_with(canon_root)
}

pub(super) fn classify_terminal_file_action(path: PathBuf, line: Option<u32>, project_root: Option<&Path>) -> TerminalFileAction {
    let Some(root) = project_root else {
        return TerminalFileAction::SystemOpen(path);
    };
    let in_project = path_is_inside(&path, root);
    match sniff_file_preview_kind(&path) {
        FilePreviewKind::SystemOnly => TerminalFileAction::SystemOpen(path),
        FilePreviewKind::Image => {
            if in_project {
                TerminalFileAction::Viewer { path, line: None }
            } else {
                TerminalFileAction::SystemOpen(path)
            }
        }
        FilePreviewKind::Text => {
            if in_project || line.is_some() || vibevalley_files::Language::from_path(&path).is_some() || is_plain_text_name(&path) {
                TerminalFileAction::Viewer { path, line }
            } else {
                TerminalFileAction::SystemOpen(path)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TabCloseAction {
    CloseNow,
    ConfirmBusy { label: String },
}

pub(crate) fn tab_close_action(busy_label: Option<String>, force: bool) -> TabCloseAction {
    if force {
        return TabCloseAction::CloseNow;
    }
    match busy_label {
        Some(label) => TabCloseAction::ConfirmBusy { label },
        None => TabCloseAction::CloseNow,
    }
}

pub(crate) fn non_terminal_tab_busy_label(kind: &PaneKind, chat_status: Option<&ChatTabStatus>) -> Option<String> {
    match kind {
        PaneKind::Chat { runtime, title, .. } => {
            if !chat_status.is_some_and(|s| s.status == "working") {
                return None;
            }
            let label = title
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| crate::host_types::chat_runtime_label(runtime));
            Some(label.to_string())
        }
        PaneKind::Terminal { .. } | PaneKind::File { .. } | PaneKind::Diff { .. } | PaneKind::Hosted { .. } | PaneKind::Diorama { .. } => None,
    }
}

pub(super) fn terminal_history_dir() -> PathBuf {
    let db = crate::host::Storage::configured().database;
    let data_dir = db.parent().unwrap_or_else(|| Path::new("."));
    vibevalley_terminal::history::history_dir_for(data_dir)
}

pub(super) fn terminal_history_path_in(history_dir: &Path, id: &str) -> PathBuf {
    vibevalley_terminal::history::history_file_for(history_dir, id)
}

pub(crate) fn terminal_history_path(id: &str) -> PathBuf {
    terminal_history_path_in(&terminal_history_dir(), id)
}
