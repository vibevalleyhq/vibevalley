use std::path::{Path, PathBuf};
use std::time::Duration;

use super::releases;

pub fn bundle_version() -> String {
    let exe = std::env::current_exe().ok();
    exe.as_deref()
        .and_then(Path::to_str)
        .and_then(releases::bundle_of)
        .and_then(|b| std::fs::read_to_string(Path::new(b).join("Contents/Info.plist")).ok())
        .and_then(|xml| releases::plist_version(&xml).map(str::to_string))
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

pub(super) fn extract_login_path(output: &str) -> Option<&str> {
    let (_, rest) = output.split_once("__VV_PATH__")?;
    let (path, _) = rest.split_once("__VV_END__")?;
    (!path.is_empty()).then_some(path)
}

pub(super) fn merge_path_entries(existing: Option<&std::ffi::OsStr>, login: &std::ffi::OsStr) -> std::ffi::OsString {
    let login_paths: Vec<PathBuf> = std::env::split_paths(login).filter(|p| !p.as_os_str().is_empty()).collect();
    let existing_paths: Vec<PathBuf> = existing
        .into_iter()
        .flat_map(std::env::split_paths)
        .filter(|p| !p.as_os_str().is_empty())
        .collect();
    let mut merged = Vec::with_capacity(existing_paths.len() + login_paths.len());
    for entry in &existing_paths {
        if !login_paths.contains(entry) && !merged.contains(entry) {
            merged.push(entry.clone());
        }
    }
    for entry in login_paths {
        if !merged.contains(&entry) {
            merged.push(entry);
        }
    }
    for entry in existing_paths {
        if !merged.contains(&entry) {
            merged.push(entry);
        }
    }
    std::env::join_paths(merged).unwrap_or_else(|_| login.to_os_string())
}

fn resolve_login_shell_path(timeout: Duration) -> Option<String> {
    use tokio::io::AsyncReadExt as _;

    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| Path::new(s).is_file())
        .unwrap_or_else(|| "/bin/zsh".into());
    vibevalley_runtime::rt::block_on(async move {
        let mut child = tokio::process::Command::new(&shell)
            .args(["-ilc", "printf '__VV_PATH__%s__VV_END__' \"$PATH\""])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .ok()?;
        let mut stdout = child.stdout.take()?;
        let reader = tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = stdout.read_to_end(&mut buf).await;
            buf
        });
        if tokio::time::timeout(timeout, child.wait()).await.is_err() {
            let _ = child.kill().await;
            let _ = child.wait().await;
            reader.abort();
            return None;
        }
        let bytes = tokio::time::timeout(Duration::from_millis(200), reader).await.ok()?.ok()?;
        let text = String::from_utf8_lossy(&bytes);
        extract_login_path(&text).map(str::to_string)
    })
}

pub fn enter_bundle() {
    let exe = std::env::current_exe().ok();
    let bundle = exe.as_deref().and_then(Path::to_str).and_then(releases::bundle_of);
    if (bundle.is_some() || std::env::var_os("SHLVL").is_none())
        && std::env::var_os("VIBEVALLEY_SKIP_LOGIN_PATH").is_none()
        && let Some(login_path) = resolve_login_shell_path(Duration::from_secs(2))
    {
        let merged = merge_path_entries(std::env::var_os("PATH").as_deref(), std::ffi::OsStr::new(&login_path));
        // SAFETY: called at the top of main, before GPUI or background threads start.
        unsafe { std::env::set_var("PATH", merged) };
    }
    let Some(bundle) = bundle else {
        return;
    };
    for (key, folder) in [("VIBEVALLEY_ASSETS", "assets"), ("VIBEVALLEY_UI_BUNDLE", "ui")] {
        let path = Path::new(bundle).join("Contents/Resources").join(folder);
        if std::env::var_os(key).is_none() && path.is_dir() {
            // SAFETY: called at the top of main, before any other thread exists.
            unsafe { std::env::set_var(key, path) };
        }
    }
}
