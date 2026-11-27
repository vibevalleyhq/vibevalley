//! Zero-dependency desktop host environment, paths, bundle version, devtools flags,
//! and startup failure descriptors shared across `log`, `serving`, `hosted`, `update`,
//! `applet`, `shell`, and `debug`.

use std::path::{Path, PathBuf};

/// The farm's home: `VIBEVALLEY_HOME`, else `$HOME/<current_channel().home_dir_name()>`.
pub fn server_home() -> PathBuf {
    vibevalley_server::home::home()
}

/// Resolves `VIBEVALLEY_WORK_ROOT`, defaulting to `~/vibevalley-dev`.
pub fn work_root() -> PathBuf {
    vibevalley_server::Config::default_work_root()
}

/// Extracts the enclosing `.app` bundle path from an executable path.
pub fn bundle_of(exe: &str) -> Option<&str> {
    let at = exe.rfind(".app/Contents/MacOS/")?;
    Some(&exe[..at + ".app".len()])
}

pub(crate) fn plist_string<'a>(xml: &'a str, key: &str) -> Option<&'a str> {
    let tag = format!("<key>{key}</key>");
    let rest = &xml[xml.find(&tag)? + tag.len()..];
    let rest = rest.trim_start().strip_prefix("<string>")?;
    Some(rest[..rest.find('<')?].trim())
}

pub fn plist_version(xml: &str) -> Option<&str> {
    plist_string(xml, "VibeValleyVersion").or_else(|| plist_string(xml, "CFBundleShortVersionString"))
}

pub fn bundle_version() -> String {
    let exe = std::env::current_exe().ok();
    exe.as_deref()
        .and_then(Path::to_str)
        .and_then(bundle_of)
        .and_then(|b| std::fs::read_to_string(Path::new(b).join("Contents/Info.plist")).ok())
        .and_then(|xml| plist_version(&xml).map(str::to_string))
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

pub fn devtools_enabled_from(raw: Option<&str>) -> bool {
    raw.is_some_and(|v| v.trim() == "1")
}

pub fn devtools_enabled() -> bool {
    devtools_enabled_from(std::env::var("VIBEVALLEY_DEBUG").ok().as_deref())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupFailureKind {
    DatabaseSchema,
    Database,
    ServerBoot,
    HttpBind,
    RemoteConnection,
    WorkspaceStore,
}

impl StartupFailureKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DatabaseSchema => "database_schema",
            Self::Database => "database",
            Self::ServerBoot => "server_boot",
            Self::HttpBind => "http_bind",
            Self::RemoteConnection => "remote_connection",
            Self::WorkspaceStore => "workspace_store",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartupFailure {
    pub kind: StartupFailureKind,
    pub summary: String,
    pub detail: Option<String>,
    pub db_path: Option<PathBuf>,
    pub home_dir: PathBuf,
}

impl StartupFailure {
    pub fn simple(kind: StartupFailureKind, summary: impl Into<String>, home_dir: PathBuf) -> Self {
        Self {
            kind,
            summary: summary.into(),
            detail: None,
            db_path: None,
            home_dir,
        }
    }

    pub fn from_start_error(err: &vibevalley_server::StartError, home_dir: PathBuf) -> Self {
        let kind = match err.kind {
            vibevalley_server::StartErrorKind::DatabaseSchema => StartupFailureKind::DatabaseSchema,
            vibevalley_server::StartErrorKind::Database => StartupFailureKind::Database,
            vibevalley_server::StartErrorKind::Storage | vibevalley_server::StartErrorKind::Boot => StartupFailureKind::ServerBoot,
        };
        Self {
            kind,
            summary: err.to_string(),
            detail: err.detail.clone(),
            db_path: err.db_path.clone(),
            home_dir,
        }
    }
}
