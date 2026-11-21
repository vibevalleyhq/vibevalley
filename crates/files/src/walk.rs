use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use ignore::WalkBuilder;

use crate::{Entry, EntryKind, FilesError, Result};

pub(crate) fn io_error(path: &Path, error: impl std::fmt::Display) -> FilesError {
    FilesError::Io(format!("{}: {error}", path.display()))
}

/// The one definition of "not ignored" shared by the tree, the file index
/// and content search: git's rules only (no `.ignore` files), hidden files
/// included, `.git` itself never.
pub(crate) fn walker(root: &Path) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .ignore(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        // A folder that is not (yet) a repository still means its .gitignore.
        .require_git(false)
        .follow_links(false)
        .filter_entry(|entry| entry.file_name() != ".git");
    builder
}

pub(crate) fn list_dir(root: &Path, dir: &Path, show_ignored: bool) -> Result<Vec<Entry>> {
    let dir: PathBuf = if dir.is_absolute() { dir.to_path_buf() } else { root.join(dir) };
    let reader = std::fs::read_dir(&dir).map_err(|e| io_error(&dir, e))?;

    // The walker never judges its own starting directory, so a directory
    // that is itself ignored (or sits inside one) would list as clean.
    let inherited = inside_ignored(root, &dir);
    let mut kept: HashSet<OsString> = HashSet::new();
    if !inherited {
        for entry in walker(&dir).max_depth(Some(1)).build().flatten() {
            if entry.depth() == 1 {
                kept.insert(entry.file_name().to_os_string());
            }
        }
    }

    let mut entries = Vec::new();
    for item in reader {
        let item = item.map_err(|e| io_error(&dir, e))?;
        let file_name = item.file_name();
        if file_name == ".git" {
            continue;
        }
        let ignored = !kept.contains(&file_name);
        if ignored && !show_ignored {
            continue;
        }
        let kind = match item.file_type() {
            Ok(t) if t.is_dir() => EntryKind::Dir,
            Ok(t) if t.is_symlink() => EntryKind::Symlink,
            Ok(_) => EntryKind::File,
            // Raced with a delete.
            Err(_) => continue,
        };
        let name = file_name.to_string_lossy().into_owned();
        entries.push(Entry {
            path: dir.join(&file_name),
            hidden: name.starts_with('.'),
            name,
            kind,
            ignored,
        });
    }
    entries.sort_by_cached_key(|e| (e.kind != EntryKind::Dir, e.name.to_lowercase(), e.name.clone()));
    Ok(entries)
}

/// True when `dir`, or a directory between `root` and `dir`, is ignored.
fn inside_ignored(root: &Path, dir: &Path) -> bool {
    let Ok(relative) = dir.strip_prefix(root) else {
        return false;
    };
    let mut parent = root.to_path_buf();
    for part in relative.components() {
        let name = part.as_os_str();
        let listed = walker(&parent)
            .max_depth(Some(1))
            .build()
            .flatten()
            .any(|entry| entry.depth() == 1 && entry.file_name() == name);
        if !listed {
            return true;
        }
        parent.push(name);
    }
    false
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn names(entries: &[Entry]) -> Vec<&str> {
        entries.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn lists_one_directory_sorted_and_honors_gitignore() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join(".git/objects")).unwrap();
        fs::create_dir_all(root.join("src/deep")).unwrap();
        fs::create_dir_all(root.join("Zeta")).unwrap();
        fs::create_dir_all(root.join("target/debug")).unwrap();
        fs::create_dir_all(root.join("文档")).unwrap();
        fs::write(root.join(".gitignore"), "target/\n*.log\n/src/generated.rs\n").unwrap();
        fs::write(root.join("b.txt"), "").unwrap();
        fs::write(root.join("A.txt"), "").unwrap();
        fs::write(root.join("debug.log"), "").unwrap();
        fs::write(root.join(".env"), "").unwrap();
        fs::write(root.join("读我 说明.md"), "").unwrap();
        fs::write(root.join("src/main.rs"), "").unwrap();
        fs::write(root.join("src/generated.rs"), "").unwrap();
        fs::write(root.join("src/trace.log"), "").unwrap();
        fs::write(root.join("src/.gitignore"), "deep/\n").unwrap();
        std::os::unix::fs::symlink(root.join("b.txt"), root.join("link")).unwrap();

        let top = list_dir(root, root, false).unwrap();
        assert_eq!(
            names(&top),
            vec!["src", "Zeta", "文档", ".env", ".gitignore", "A.txt", "b.txt", "link", "读我 说明.md"]
        );
        assert!(top.iter().all(|e| !e.ignored));
        assert_eq!(top[0].kind, EntryKind::Dir);
        assert_eq!(top[0].path, root.join("src"));
        let env = top.iter().find(|e| e.name == ".env").unwrap();
        assert!(env.hidden && env.kind == EntryKind::File);
        assert_eq!(top.iter().find(|e| e.name == "link").unwrap().kind, EntryKind::Symlink);

        let all = list_dir(root, Path::new(""), true).unwrap();
        assert_eq!(
            names(&all),
            vec![
                "src",
                "target",
                "Zeta",
                "文档",
                ".env",
                ".gitignore",
                "A.txt",
                "b.txt",
                "debug.log",
                "link",
                "读我 说明.md"
            ]
        );
        let ignored: Vec<_> = all.iter().filter(|e| e.ignored).map(|e| e.name.as_str()).collect();
        assert_eq!(ignored, vec!["target", "debug.log"]);

        // A subdirectory is listed on its own, with rules from the parent
        // .gitignore and from its own.
        let src = list_dir(root, Path::new("src"), false).unwrap();
        assert_eq!(names(&src), vec![".gitignore", "main.rs"]);
        assert_eq!(src[1].path, root.join("src/main.rs"));
        let src_all = list_dir(root, &root.join("src"), true).unwrap();
        assert_eq!(names(&src_all), vec!["deep", ".gitignore", "generated.rs", "main.rs", "trace.log"]);
        assert_eq!(src_all.iter().filter(|e| e.ignored).count(), 3);

        // Inside an ignored directory everything is ignored.
        assert!(list_dir(root, Path::new("target"), false).unwrap().is_empty());
        let target = list_dir(root, Path::new("target"), true).unwrap();
        assert_eq!(names(&target), vec!["debug"]);
        assert!(target[0].ignored);

        assert!(matches!(list_dir(root, Path::new("missing"), false), Err(FilesError::Io(_))));
        assert!(matches!(list_dir(root, Path::new("b.txt"), false), Err(FilesError::Io(_))));
    }
}
