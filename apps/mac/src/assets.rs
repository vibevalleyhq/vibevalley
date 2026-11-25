//! Process-wide asset directory resolution for Papertrails branding, avatars,
//! runtime emblems, and the compiled 3D diorama bundle.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

fn canonicalize_or_raw(path: PathBuf) -> PathBuf {
    std::fs::canonicalize(&path).unwrap_or(path)
}

fn resolve_assets_dir(override_path: Option<&OsStr>, manifest_dir: &Path) -> PathBuf {
    let raw = override_path
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest_dir.join("../../assets"));
    canonicalize_or_raw(raw)
}

/// Root directory of processed assets: `VIBEVALLEY_ASSETS`, else the repo's `assets/`.
/// Canonicalized so `nsh`'s `file://` media loader accepts paths under `fs.read` without `..`.
pub fn assets_dir() -> PathBuf {
    resolve_assets_dir(std::env::var_os("VIBEVALLEY_ASSETS").as_deref(), Path::new(env!("CARGO_MANIFEST_DIR")))
}

/// Compiled papercraft diorama bundle directory (`manifest.json`, `meshes.bin`, `print/`, `stock/`).
pub fn diorama_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("VIBEVALLEY_DIORAMA_DIST").filter(|v| !v.is_empty()).map(PathBuf::from)
        && dir.join("manifest.json").is_file()
    {
        return canonicalize_or_raw(dir);
    }
    let bundled = assets_dir().join("diorama");
    if bundled.join("manifest.json").is_file() {
        return bundled;
    }
    canonicalize_or_raw(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../vibevalley-assets/dist/diorama"))
}

#[cfg(test)]
mod tests {
    use std::path::{Component, Path};

    use super::{assets_dir, resolve_assets_dir};

    #[test]
    fn assets_dir_is_canonical_without_parent_dir_components() {
        let dir = assets_dir();
        assert!(dir.is_dir(), "expected assets directory to exist at {}", dir.display());
        assert!(dir.is_absolute(), "expected absolute assets dir, got {}", dir.display());
        assert!(
            !dir.components().any(|c| matches!(c, Component::ParentDir)),
            "assets_dir must not contain `..` components (rejected by nsh file:// loader): {}",
            dir.display()
        );
        assert_eq!(dir, std::fs::canonicalize(&dir).expect("canonicalize assets dir"));
    }

    #[test]
    fn resolve_assets_dir_strips_parent_dir_for_default_and_override() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let expected = std::fs::canonicalize(manifest.join("../../assets")).expect("repo assets dir");

        let from_default = resolve_assets_dir(None, manifest);
        assert_eq!(from_default, expected);
        assert!(!from_default.components().any(|c| matches!(c, Component::ParentDir)));

        let from_empty = resolve_assets_dir(Some(std::ffi::OsStr::new("")), manifest);
        assert_eq!(from_empty, expected);

        let with_dotdot = manifest.join("../mac/../../assets");
        let from_override = resolve_assets_dir(Some(with_dotdot.as_os_str()), manifest);
        assert_eq!(from_override, expected);
        assert!(!from_override.components().any(|c| matches!(c, Component::ParentDir)));
    }
}
