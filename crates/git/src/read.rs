//! Zero-subprocess pure-Rust readers for git metadata, refs, config, and worktrees.
//!
//! Every function reads `.git` files directly without spawning `git`.
//! Callers fall back to `Repo`'s async `tokio::process::Command` methods for
//! complex revspecs (`~`, `^`, `:`, `@{}`) or mutations.

use std::collections::{BTreeMap, HashMap};
use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::{Branch, GitError, Result, Worktree};

const ZERO_OID_SHA1: &str = "0000000000000000000000000000000000000000";

/// Lexically normalizes `.` and `..` segments without touching the filesystem.
fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push(comp.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !matches!(out.components().next_back(), Some(Component::RootDir | Component::Prefix(_)) | None) {
                    if matches!(out.components().next_back(), Some(Component::ParentDir)) {
                        out.push(comp.as_os_str());
                    } else {
                        out.pop();
                    }
                }
            }
            Component::Normal(s) => out.push(s),
        }
    }
    out
}

fn canonical_or_lexical(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| normalize_lexical(path))
}

fn read_gitdir_file(dot_git_file: &Path, base_dir: &Path) -> Option<PathBuf> {
    let raw = fs::read_to_string(dot_git_file).ok()?;
    let line = raw.lines().next()?.trim_end_matches('\r');
    let target = line.strip_prefix("gitdir:")?.trim();
    if target.is_empty() {
        return None;
    }
    let p = Path::new(target);
    let resolved = if p.is_absolute() { p.to_path_buf() } else { base_dir.join(p) };
    Some(canonical_or_lexical(&resolved))
}

fn looks_like_git_dir(dir: &Path) -> bool {
    dir.is_dir() && (dir.join("HEAD").is_file() || dir.join("commondir").is_file() || dir.join("objects").is_dir())
}

fn is_bare_config(config_path: &Path) -> bool {
    let Ok(entries) = parse_config_file(config_path) else {
        return false;
    };
    entries
        .iter()
        .rfind(|e| e.section == "core" && e.subsection.is_none() && e.key == "bare")
        .is_some_and(|e| e.value.eq_ignore_ascii_case("true"))
}

/// Finds the working-tree root containing `path`, or `Ok(None)` when outside any repository,
/// inside `.git/`, or inside a bare repository.
pub fn discover_root(path: &Path) -> Result<Option<PathBuf>> {
    let start = if path.is_dir() {
        path
    } else {
        match path.parent() {
            Some(parent) if parent.is_dir() => parent,
            _ => return Ok(None),
        }
    };
    let Ok(canon_start) = fs::canonicalize(start) else {
        return Ok(None);
    };

    for cur in canon_start.ancestors() {
        if cur.join("HEAD").is_file() && cur.join("objects").is_dir() && cur.join("refs").is_dir() && is_bare_config(&cur.join("config")) {
            return Ok(None);
        }
        let dot_git = cur.join(".git");
        let Ok(meta) = fs::symlink_metadata(&dot_git) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            // Follow symlink to see if it points to a directory or file.
            let Ok(target_meta) = fs::metadata(&dot_git) else {
                return Ok(None);
            };
            if target_meta.is_dir() {
                let canon_dot_git = canonical_or_lexical(&dot_git);
                if canon_start.starts_with(&canon_dot_git) || is_bare_config(&canon_dot_git.join("config")) {
                    return Ok(None);
                }
                if looks_like_git_dir(&canon_dot_git) {
                    return Ok(Some(cur.to_path_buf()));
                }
                return Ok(None);
            }
            if target_meta.is_file() {
                if let Some(gd) = read_gitdir_file(&dot_git, cur)
                    && looks_like_git_dir(&gd)
                {
                    return Ok(Some(cur.to_path_buf()));
                }
                return Ok(None);
            }
            return Ok(None);
        }
        if meta.is_dir() {
            let canon_dot_git = canonical_or_lexical(&dot_git);
            if canon_start.starts_with(&canon_dot_git) || is_bare_config(&canon_dot_git.join("config")) {
                return Ok(None);
            }
            if looks_like_git_dir(&canon_dot_git) {
                return Ok(Some(cur.to_path_buf()));
            }
            return Ok(None);
        }
        if meta.is_file() {
            if let Some(gd) = read_gitdir_file(&dot_git, cur)
                && looks_like_git_dir(&gd)
            {
                return Ok(Some(cur.to_path_buf()));
            }
            return Ok(None);
        }
    }
    Ok(None)
}

/// Resolves the repository's `.git` directory (handling both normal `.git` directories and
/// linked worktree `.git` files).
pub fn git_dir(root: &Path) -> Result<PathBuf> {
    let effective_root = if fs::symlink_metadata(root.join(".git")).is_ok() {
        canonical_or_lexical(root)
    } else if let Some(found) = discover_root(root)? {
        found
    } else {
        return Err(GitError::NotARepo(root.to_path_buf()));
    };

    let dot_git = effective_root.join(".git");
    let meta = fs::metadata(&dot_git).map_err(|_| GitError::NotARepo(root.to_path_buf()))?;
    let gd = if meta.is_dir() {
        canonical_or_lexical(&dot_git)
    } else if meta.is_file() {
        read_gitdir_file(&dot_git, &effective_root).ok_or_else(|| GitError::NotARepo(root.to_path_buf()))?
    } else {
        return Err(GitError::NotARepo(root.to_path_buf()));
    };
    if !looks_like_git_dir(&gd) {
        return Err(GitError::NotARepo(root.to_path_buf()));
    }
    Ok(gd)
}

fn git_common_dir_from(gd: &Path) -> Result<PathBuf> {
    let commondir_file = gd.join("commondir");
    match fs::read_to_string(&commondir_file) {
        Ok(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err(GitError::Parse(format!("empty commondir: {}", commondir_file.display())));
            }
            let p = Path::new(trimmed);
            let resolved = if p.is_absolute() { p.to_path_buf() } else { gd.join(p) };
            Ok(canonical_or_lexical(&resolved))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(gd.to_path_buf()),
        Err(e) => Err(GitError::Io(format!("{}: {e}", commondir_file.display()))),
    }
}

/// Resolves the shared git common directory (equal to `git_dir` in the main checkout,
/// or the main `.git` directory when inside a linked worktree).
pub fn git_common_dir(root: &Path) -> Result<PathBuf> {
    let gd = git_dir(root)?;
    git_common_dir_from(&gd)
}

fn is_common_git_subpath(clean_rel: &Path) -> bool {
    let mut comps = clean_rel.components().filter_map(|c| match c {
        Component::Normal(s) => s.to_str(),
        _ => None,
    });
    let Some(first) = comps.next() else {
        return false;
    };
    let second = comps.next();
    match first {
        "branches" | "config" | "hooks" | "lost-found" | "objects" | "packed-refs" | "remotes" | "rr-cache" | "shallow" | "svn" | "worktrees" => {
            // `config` is exact; `config.worktree` is a different file name and stays per-worktree.
            first != "config" || second.is_none()
        }
        "info" => second != Some("sparse-checkout"),
        "logs" => second != Some("HEAD"),
        "refs" => !matches!(second, Some("bisect" | "worktree" | "rewritten")),
        _ => false,
    }
}

fn git_path_from(gd: &Path, common: &Path, rel: &Path) -> PathBuf {
    let clean_rel = if rel.is_absolute() {
        return rel.to_path_buf();
    } else {
        normalize_lexical(rel)
    };
    if clean_rel.as_os_str().is_empty() {
        return gd.to_path_buf();
    }
    let base = if gd != common && is_common_git_subpath(&clean_rel) { common } else { gd };
    base.join(clean_rel)
}

/// Resolves a path inside the repository's git directory, respecting `git_common_dir`
/// vs per-worktree `git_dir` rules (`git rev-parse --path-format=absolute --git-path <rel>`).
pub fn git_path(root: &Path, rel: &Path) -> Result<PathBuf> {
    let gd = git_dir(root)?;
    let common = git_common_dir_from(&gd)?;
    Ok(git_path_from(&gd, &common, rel))
}

fn is_valid_oid(s: &str) -> bool {
    matches!(s.len(), 40 | 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn read_packed_refs(common: &Path) -> Result<HashMap<String, String>> {
    let path = common.join("packed-refs");
    let raw = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(e) => return Err(GitError::Io(format!("{}: {e}", path.display()))),
    };
    let mut map = HashMap::new();
    for line in raw.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || line.starts_with('#') || line.starts_with('^') {
            continue;
        }
        if let Some((oid, refname)) = line.split_once(' ') {
            let oid = oid.trim();
            let refname = refname.trim();
            if is_valid_oid(oid) && !refname.is_empty() {
                map.insert(refname.to_string(), oid.to_ascii_lowercase());
            }
        }
    }
    Ok(map)
}

#[derive(Clone, Debug)]
enum RefTarget {
    Oid(String),
    Symref(String),
}

fn read_loose_ref(gd: &Path, common: &Path, refname: &str) -> Result<Option<RefTarget>> {
    let path = git_path_from(gd, common, Path::new(refname));
    let Ok(meta) = fs::metadata(&path) else {
        return Ok(None);
    };
    if !meta.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| GitError::Io(format!("{}: {e}", path.display())))?;
    let trimmed = raw.trim();
    if let Some(target) = trimmed.strip_prefix("ref:") {
        let target = target.trim();
        if target.is_empty() {
            return Err(GitError::Parse(format!("empty symref in {refname}")));
        }
        Ok(Some(RefTarget::Symref(target.to_string())))
    } else if is_valid_oid(trimmed) {
        Ok(Some(RefTarget::Oid(trimmed.to_ascii_lowercase())))
    } else {
        Err(GitError::Parse(format!("invalid ref {refname}: {trimmed}")))
    }
}

fn resolve_ref(gd: &Path, common: &Path, refname: &str, packed: Option<&HashMap<String, String>>) -> Result<Option<String>> {
    let mut current = refname.to_string();
    for _ in 0..8 {
        if let Some(target) = read_loose_ref(gd, common, &current)? {
            match target {
                RefTarget::Oid(oid) => return Ok(Some(oid)),
                RefTarget::Symref(next) => {
                    current = next;
                    continue;
                }
            }
        }
        if let Some(packed_map) = packed {
            return Ok(packed_map.get(&current).cloned());
        }
        let loaded = read_packed_refs(common)?;
        return Ok(loaded.get(&current).cloned());
    }
    Err(GitError::Parse(format!("symref depth exceeded for {current}")))
}

fn read_head_file(head_file: &Path) -> Result<RefTarget> {
    let raw = fs::read_to_string(head_file).map_err(|e| GitError::Io(format!("{}: {e}", head_file.display())))?;
    let trimmed = raw.trim();
    if let Some(target) = trimmed.strip_prefix("ref:") {
        let target = target.trim();
        if target.is_empty() {
            return Err(GitError::Parse(format!("empty symref in {}", head_file.display())));
        }
        Ok(RefTarget::Symref(target.to_string()))
    } else if is_valid_oid(trimmed) {
        Ok(RefTarget::Oid(trimmed.to_ascii_lowercase()))
    } else {
        Err(GitError::Parse(format!("invalid HEAD in {}: {trimmed}", head_file.display())))
    }
}

/// Reads the current branch name if `HEAD` is attached to `refs/heads/*`, or `None` when detached.
pub fn head_branch(root: &Path) -> Result<Option<String>> {
    let gd = git_dir(root)?;
    match read_head_file(&gd.join("HEAD"))? {
        RefTarget::Symref(target) => Ok(target.strip_prefix("refs/heads/").map(str::to_string)),
        RefTarget::Oid(_) => Ok(None),
    }
}

/// Reads the commit OID that `HEAD` points at, or `Ok(None)` for an unborn branch.
pub fn head(root: &Path) -> Result<Option<String>> {
    let gd = git_dir(root)?;
    let common = git_common_dir_from(&gd)?;
    match read_head_file(&gd.join("HEAD"))? {
        RefTarget::Oid(oid) => Ok(Some(oid)),
        RefTarget::Symref(target) => resolve_ref(&gd, &common, &target, None),
    }
}

/// Checks whether local branch `branch` exists (loose or `packed-refs`).
pub fn branch_exists(root: &Path, branch: &str) -> Result<bool> {
    if branch.is_empty() || branch.starts_with('-') || branch.contains('\0') {
        return Ok(false);
    }
    let gd = git_dir(root)?;
    let common = git_common_dir_from(&gd)?;
    let refname = format!("refs/heads/{branch}");
    if read_loose_ref(&gd, &common, &refname)?.is_some() {
        return Ok(true);
    }
    let packed = read_packed_refs(&common)?;
    Ok(packed.contains_key(&refname))
}

fn collect_loose_refs_dir(base: &Path, prefix: &str, out: &mut BTreeMap<String, RefTarget>) -> Result<()> {
    let Ok(entries) = fs::read_dir(base) else {
        return Ok(());
    };
    for entry in entries {
        let entry = entry.map_err(|e| GitError::Io(format!("{}: {e}", base.display())))?;
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        let child = entry.path();
        let full_ref = format!("{prefix}/{name_str}");
        let meta = fs::metadata(&child).map_err(|e| GitError::Io(format!("{}: {e}", child.display())))?;
        if meta.is_dir() {
            collect_loose_refs_dir(&child, &full_ref, out)?;
        } else if meta.is_file() {
            let raw = fs::read_to_string(&child).map_err(|e| GitError::Io(format!("{}: {e}", child.display())))?;
            let trimmed = raw.trim();
            if let Some(target) = trimmed.strip_prefix("ref:") {
                out.insert(full_ref, RefTarget::Symref(target.trim().to_string()));
            } else if is_valid_oid(trimmed) {
                out.insert(full_ref, RefTarget::Oid(trimmed.to_ascii_lowercase()));
            }
        }
    }
    Ok(())
}

/// Lists all local and remote-tracking branches (loose + `packed-refs`, with loose overriding
/// packed, local branches sorted by name followed by remote branches sorted by name).
pub fn branches(root: &Path) -> Result<Vec<Branch>> {
    let gd = git_dir(root)?;
    let common = git_common_dir_from(&gd)?;
    let head_ref = match read_head_file(&gd.join("HEAD"))? {
        RefTarget::Symref(target) => Some(target),
        RefTarget::Oid(_) => None,
    };

    let packed = read_packed_refs(&common)?;
    let mut merged: BTreeMap<String, RefTarget> = BTreeMap::new();
    for (refname, oid) in &packed {
        if refname.starts_with("refs/heads/") || refname.starts_with("refs/remotes/") {
            merged.insert(refname.clone(), RefTarget::Oid(oid.clone()));
        }
    }
    collect_loose_refs_dir(&common.join("refs/heads"), "refs/heads", &mut merged)?;
    collect_loose_refs_dir(&common.join("refs/remotes"), "refs/remotes", &mut merged)?;

    let config_entries = parse_config_file(&common.join("config")).unwrap_or_default();
    let mut branch_remotes: HashMap<String, String> = HashMap::new();
    let mut branch_merges: HashMap<String, String> = HashMap::new();
    for entry in &config_entries {
        if entry.section == "branch"
            && let Some(branch_name) = &entry.subsection
        {
            if entry.key == "remote" {
                branch_remotes.insert(branch_name.clone(), entry.value.clone());
            } else if entry.key == "merge" {
                branch_merges.insert(branch_name.clone(), entry.value.clone());
            }
        }
    }

    let mut local = Vec::new();
    let mut remote = Vec::new();
    for (refname, target) in &merged {
        let RefTarget::Oid(tip) = target else {
            // Symrefs such as `refs/remotes/origin/HEAD` are aliases, not branches.
            continue;
        };
        if let Some(name) = refname.strip_prefix("refs/heads/") {
            let upstream = match (branch_remotes.get(name), branch_merges.get(name)) {
                (Some(r), Some(m)) => {
                    let short_merge = m.strip_prefix("refs/heads/").unwrap_or(m);
                    if r == "." {
                        merged.contains_key(&format!("refs/heads/{short_merge}")).then(|| short_merge.to_string())
                    } else {
                        let candidate = format!("{r}/{short_merge}");
                        merged.contains_key(&format!("refs/remotes/{candidate}")).then_some(candidate)
                    }
                }
                _ => None,
            };
            local.push(Branch {
                name: name.to_string(),
                is_head: head_ref.as_deref() == Some(refname.as_str()),
                is_remote: false,
                upstream,
                tip: tip.clone(),
            });
        } else if let Some(name) = refname.strip_prefix("refs/remotes/") {
            remote.push(Branch {
                name: name.to_string(),
                is_head: false,
                is_remote: true,
                upstream: None,
                tip: tip.clone(),
            });
        }
    }
    local.extend(remote);
    Ok(local)
}

fn hex_to_bytes<const N: usize>(hex: &str) -> Option<[u8; N]> {
    if hex.len() != N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

fn pack_idx_contains(idx_path: &Path, oid: &[u8; 20]) -> bool {
    let Ok(bytes) = fs::read(idx_path) else {
        return false;
    };
    const HEADER_SIZE: usize = 8;
    const FANOUT_SIZE: usize = 256 * 4;
    if bytes.len() < HEADER_SIZE + FANOUT_SIZE {
        return false;
    }
    if bytes[0..4] != [0xff, 0x74, 0x4f, 0x63] || u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) != 2 {
        return false;
    }
    let fanout = &bytes[HEADER_SIZE..HEADER_SIZE + FANOUT_SIZE];
    let total = u32::from_be_bytes([fanout[255 * 4], fanout[255 * 4 + 1], fanout[255 * 4 + 2], fanout[255 * 4 + 3]]) as usize;
    let table_start = HEADER_SIZE + FANOUT_SIZE;
    let Some(table_end) = table_start.checked_add(total * 20) else {
        return false;
    };
    if bytes.len() < table_end {
        return false;
    }
    let bucket = oid[0] as usize;
    let lo = if bucket == 0 {
        0
    } else {
        let off = (bucket - 1) * 4;
        u32::from_be_bytes([fanout[off], fanout[off + 1], fanout[off + 2], fanout[off + 3]]) as usize
    };
    let hi = {
        let off = bucket * 4;
        u32::from_be_bytes([fanout[off], fanout[off + 1], fanout[off + 2], fanout[off + 3]]) as usize
    };
    if hi > total || lo >= hi {
        return false;
    }
    let table = &bytes[table_start..table_end];
    let mut left = lo;
    let mut right = hi;
    while left < right {
        let mid = left + (right - left) / 2;
        let entry = &table[mid * 20..(mid + 1) * 20];
        match entry.cmp(&oid[..]) {
            std::cmp::Ordering::Less => left = mid + 1,
            std::cmp::Ordering::Greater => right = mid,
            std::cmp::Ordering::Equal => return true,
        }
    }
    false
}

fn object_exists(common: &Path, hex_oid: &str) -> bool {
    let lower = hex_oid.to_ascii_lowercase();
    if lower.len() >= 3 && common.join("objects").join(&lower[..2]).join(&lower[2..]).is_file() {
        return true;
    }
    if let Some(oid_bytes) = hex_to_bytes::<20>(&lower)
        && let Ok(entries) = fs::read_dir(common.join("objects/pack"))
    {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("idx") && pack_idx_contains(&path, &oid_bytes) {
                return true;
            }
        }
    }
    false
}

/// Fast-path pure-Rust revision resolution for `HEAD`, `refs/...` (excluding `refs/tags/`),
/// short branch names, and full 40-hex commit SHAs.
///
/// Returns `Ok(None)` when `rev` uses complex revspec syntax (`~`, `^`, `:`, `@{`, `..`),
/// is an abbreviated SHA, or cannot be resolved without spawning `git`.
pub fn commit_id_fast(root: &Path, rev: &str) -> Result<Option<String>> {
    if rev.is_empty()
        || rev.starts_with('-')
        || rev.contains('\0')
        || rev.contains('~')
        || rev.contains('^')
        || rev.contains(':')
        || rev.contains("@{")
        || rev.contains("..")
        || rev.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Ok(None);
    }
    let gd = git_dir(root)?;
    let common = git_common_dir_from(&gd)?;

    if rev == "HEAD" {
        return match read_head_file(&gd.join("HEAD"))? {
            RefTarget::Oid(oid) => Ok(Some(oid)),
            RefTarget::Symref(target) => resolve_ref(&gd, &common, &target, None),
        };
    }

    if rev.starts_with("refs/") {
        if rev.starts_with("refs/tags/") {
            // Annotated tags need object peeling to `^{commit}`, so let `git rev-parse` handle them.
            return Ok(None);
        }
        return resolve_ref(&gd, &common, rev, None);
    }

    if rev.len() == 40 && rev.bytes().all(|b| b.is_ascii_hexdigit()) {
        if object_exists(&common, rev) {
            return Ok(Some(rev.to_ascii_lowercase()));
        }
        return Ok(None);
    }

    let packed = read_packed_refs(&common)?;
    for candidate in [format!("refs/heads/{rev}"), format!("refs/remotes/{rev}")] {
        if let Some(oid) = resolve_ref(&gd, &common, &candidate, Some(&packed))? {
            return Ok(Some(oid));
        }
    }
    Ok(None)
}

#[derive(Debug, Clone)]
struct ConfigEntry {
    section: String,
    subsection: Option<String>,
    key: String,
    value: String,
}

fn unescape_config_header_quoted(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(next) = chars.next() {
                out.push(next);
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn parse_section_header(line: &str) -> Option<(String, Option<String>)> {
    let inner = line.strip_prefix('[')?.strip_suffix(']')?.trim();
    if inner.is_empty() {
        return None;
    }
    if let Some(q_start) = inner.find('"') {
        let section = inner[..q_start].trim().to_ascii_lowercase();
        let rest = &inner[q_start + 1..];
        let mut escaped = false;
        let mut q_end = None;
        for (idx, ch) in rest.char_indices() {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                q_end = Some(idx);
                break;
            }
        }
        let end = q_end?;
        if !rest[end + 1..].trim().is_empty() {
            return None;
        }
        let sub = unescape_config_header_quoted(&rest[..end]);
        return Some((section, Some(sub)));
    }
    if let Some((section, sub)) = inner.split_once('.') {
        return Some((section.trim().to_ascii_lowercase(), Some(sub.trim().to_string())));
    }
    Some((inner.to_ascii_lowercase(), None))
}

fn parse_config_value(raw: &str) -> String {
    let mut out = String::new();
    let mut in_quotes = false;
    let mut chars = raw.trim_start().chars().peekable();
    while let Some(c) = chars.next() {
        if !in_quotes && (c == '#' || c == ';') {
            break;
        }
        match c {
            '"' => in_quotes = !in_quotes,
            '\\' => match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('b') => out.push('\x08'),
                Some('\\') => out.push('\\'),
                Some('"') => out.push('"'),
                Some(other) => out.push(other),
                None => {}
            },
            other => out.push(other),
        }
    }
    if in_quotes { out } else { out.trim_end().to_string() }
}

fn join_continued_lines(raw: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut buf = String::new();
    let mut continuing = false;
    for raw_line in raw.lines() {
        let line = raw_line.trim_end_matches('\r');
        if continuing {
            buf.push_str(line);
        } else {
            buf = line.to_string();
        }
        let trailing_backslashes = buf.chars().rev().take_while(|&c| c == '\\').count();
        if trailing_backslashes % 2 == 1 {
            buf.pop();
            continuing = true;
        } else {
            continuing = false;
            lines.push(std::mem::take(&mut buf));
        }
    }
    if continuing {
        lines.push(buf);
    }
    lines
}

fn parse_config_str(raw: &str) -> Vec<ConfigEntry> {
    let mut entries = Vec::new();
    let mut current: Option<(String, Option<String>)> = None;
    for line in join_continued_lines(raw) {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            current = parse_section_header(trimmed);
            continue;
        }
        let Some((section, subsection)) = &current else {
            continue;
        };
        let (key, value) = match trimmed.split_once('=') {
            Some((k, v)) => (k.trim().to_ascii_lowercase(), parse_config_value(v)),
            None => {
                let key = trimmed.split(['#', ';']).next().unwrap_or("").trim().to_ascii_lowercase();
                (key, "true".to_string())
            }
        };
        if !key.is_empty() {
            entries.push(ConfigEntry {
                section: section.clone(),
                subsection: subsection.clone(),
                key,
                value,
            });
        }
    }
    entries
}

fn parse_config_file(path: &Path) -> Result<Vec<ConfigEntry>> {
    let raw = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(GitError::Io(format!("{}: {e}", path.display()))),
    };
    Ok(parse_config_str(&raw))
}

/// Reads `[remote "<name>"] url` from the repository's `.git/config` without spawning `git`.
pub fn remote_url(root: &Path, name: &str) -> Result<Option<String>> {
    let common = git_common_dir(root)?;
    let entries = parse_config_file(&common.join("config"))?;
    Ok(entries
        .into_iter()
        .find(|e| e.section == "remote" && e.subsection.as_deref() == Some(name) && e.key == "url")
        .map(|e| e.value)
        .filter(|u| !u.is_empty()))
}

pub(crate) fn global_config_value_with_env(
    section: &str,
    key: &str,
    git_config_global: Option<&OsStr>,
    xdg_config_home: Option<&OsStr>,
    home: Option<&OsStr>,
) -> Result<Option<String>> {
    let file = if let Some(explicit) = git_config_global.filter(|p| !p.is_empty()) {
        Some(PathBuf::from(explicit))
    } else {
        let home_cfg = home.filter(|p| !p.is_empty()).map(|h| PathBuf::from(h).join(".gitconfig"));
        let xdg_cfg = xdg_config_home
            .filter(|p| !p.is_empty())
            .map(|x| PathBuf::from(x).join("git/config"))
            .or_else(|| home.filter(|p| !p.is_empty()).map(|h| PathBuf::from(h).join(".config/git/config")));
        match home_cfg {
            Some(p) if p.exists() => Some(p),
            _ => xdg_cfg.filter(|p| p.exists()),
        }
    };

    let Some(file) = file else {
        return Ok(None);
    };

    let (sec, sub) = match section.split_once('.') {
        Some((s, sub)) => (s.to_ascii_lowercase(), Some(sub.to_string())),
        None => (section.to_ascii_lowercase(), None),
    };
    let key_lower = key.to_ascii_lowercase();

    let Ok(entries) = parse_config_file(&file) else {
        return Ok(None);
    };
    let mut result = None;
    for entry in entries {
        if entry.section == sec && entry.subsection == sub && entry.key == key_lower {
            result = Some(entry.value);
        }
    }
    Ok(result)
}

/// Reads a value from global git config (`$GIT_CONFIG_GLOBAL`, else `$XDG_CONFIG_HOME/git/config`
/// and `~/.gitconfig`) without spawning `git`.
pub fn global_config_value(section: &str, key: &str) -> Result<Option<String>> {
    let git_config_global = std::env::var_os("GIT_CONFIG_GLOBAL");
    let xdg_config_home = std::env::var_os("XDG_CONFIG_HOME");
    let home = std::env::var_os("HOME");
    global_config_value_with_env(section, key, git_config_global.as_deref(), xdg_config_home.as_deref(), home.as_deref())
}

fn worktree_head_state(head_file: &Path, gd: &Path, common: &Path, packed: &HashMap<String, String>) -> Result<(Option<String>, String)> {
    match read_head_file(head_file)? {
        RefTarget::Oid(oid) => Ok((None, oid)),
        RefTarget::Symref(target) => {
            let branch = target.strip_prefix("refs/heads/").map(str::to_string);
            let oid = resolve_ref(gd, common, &target, Some(packed))?.unwrap_or_else(|| ZERO_OID_SHA1.to_string());
            Ok((branch, oid))
        }
    }
}

/// Lists the main checkout and all linked worktrees (`<common>/worktrees/*`) without spawning `git`.
pub fn worktrees(root: &Path) -> Result<Vec<Worktree>> {
    let gd = git_dir(root)?;
    let common = git_common_dir_from(&gd)?;
    let packed = read_packed_refs(&common)?;
    let bare = is_bare_config(&common.join("config"));

    let mut out = Vec::new();
    let main_path = if bare {
        common.clone()
    } else {
        canonical_or_lexical(common.parent().unwrap_or(&common))
    };
    let (main_branch, main_head) = if bare {
        (None, String::new())
    } else {
        worktree_head_state(&common.join("HEAD"), &common, &common, &packed)?
    };
    out.push(Worktree {
        path: main_path,
        branch: main_branch,
        head: main_head,
        is_main: true,
        locked: false,
    });

    let worktrees_dir = common.join("worktrees");
    let Ok(entries) = fs::read_dir(&worktrees_dir) else {
        return Ok(out);
    };
    let mut dirs: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir()
            && let Some(name) = entry.file_name().to_str()
        {
            dirs.push((name.to_string(), path));
        }
    }
    dirs.sort_by(|a, b| a.0.cmp(&b.0));

    for (_, wt_admin) in dirs {
        let gitdir_file = wt_admin.join("gitdir");
        let head_file = wt_admin.join("HEAD");
        if !gitdir_file.is_file() || !head_file.is_file() {
            continue;
        }
        let Ok(raw_gitdir) = fs::read_to_string(&gitdir_file) else {
            continue;
        };
        let raw_gitdir = raw_gitdir.trim();
        if raw_gitdir.is_empty() {
            continue;
        }
        let gitdir_path = Path::new(raw_gitdir);
        let wt_path = if gitdir_path.file_name() == Some(OsStr::new(".git")) {
            gitdir_path.parent().unwrap_or(gitdir_path)
        } else {
            gitdir_path
        };
        let wt_path = if wt_path.exists() {
            canonical_or_lexical(wt_path)
        } else {
            normalize_lexical(wt_path)
        };
        let Ok((branch, head)) = worktree_head_state(&head_file, &wt_admin, &common, &packed) else {
            continue;
        };
        out.push(Worktree {
            path: wt_path,
            branch,
            head,
            is_main: false,
            locked: wt_admin.join("locked").exists(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use super::*;
    use crate::Repo;
    use crate::tests::ISOLATED_ENV;

    fn git_raw(dir: &Path, args: &[&str], extra_env: &[(&str, &str)]) -> std::process::Output {
        Command::new("git")
            .current_dir(dir)
            .args(["-c", "core.quotepath=off"])
            .args(args)
            .envs(ISOLATED_ENV.iter().copied())
            .envs(extra_env.iter().copied())
            .output()
            .unwrap()
    }

    fn git_ok(dir: &Path, args: &[&str]) -> String {
        let out = git_raw(dir, args, &[]);
        assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim_end_matches(['\n', '\r']).to_string()
    }

    #[test]
    fn parity_normal_unborn_detached_packed_and_remotes() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        assert_eq!(discover_root(&outside).unwrap(), None);
        assert!(matches!(git_dir(&outside), Err(GitError::NotARepo(_))));

        // Bare repository: discover_root -> None
        let bare = tmp.path().join("bare.git");
        git_ok(tmp.path(), &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()]);
        assert_eq!(discover_root(&bare).unwrap(), None);

        // Unborn repository
        let repo_dir = tmp.path().join("repo");
        fs::create_dir_all(&repo_dir).unwrap();
        git_ok(&repo_dir, &["init", "-q", "-b", "trunk"]);
        let canon_repo = fs::canonicalize(&repo_dir).unwrap();
        let cli_top = git_ok(&repo_dir, &["rev-parse", "--show-toplevel"]);
        assert_eq!(discover_root(&repo_dir).unwrap().unwrap(), PathBuf::from(&cli_top));
        assert_eq!(discover_root(&repo_dir).unwrap().unwrap(), canon_repo);
        assert_eq!(discover_root(&repo_dir.join(".git")).unwrap(), None);

        assert_eq!(
            git_dir(&repo_dir).unwrap(),
            PathBuf::from(git_ok(&repo_dir, &["rev-parse", "--absolute-git-dir"]))
        );
        assert_eq!(
            git_common_dir(&repo_dir).unwrap(),
            PathBuf::from(git_ok(&repo_dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"]))
        );
        assert_eq!(head(&repo_dir).unwrap(), None);
        assert_eq!(head_branch(&repo_dir).unwrap().as_deref(), Some("trunk"));
        assert!(!branch_exists(&repo_dir, "trunk").unwrap());
        assert!(branches(&repo_dir).unwrap().is_empty());

        // Compare worktrees on unborn repo
        let unborn_wts = worktrees(&repo_dir).unwrap();
        assert_eq!(unborn_wts.len(), 1);
        assert_eq!(unborn_wts[0].path, canon_repo);
        assert_eq!(unborn_wts[0].branch.as_deref(), Some("trunk"));
        assert_eq!(unborn_wts[0].head, ZERO_OID_SHA1);
        assert!(unborn_wts[0].is_main);

        // Normal commits + branches + remotes
        fs::write(repo_dir.join("file.txt"), "v1\n").unwrap();
        git_ok(&repo_dir, &["add", "."]);
        git_ok(&repo_dir, &["commit", "-q", "-m", "c1"]);
        let c1 = git_ok(&repo_dir, &["rev-parse", "HEAD"]);

        fs::create_dir_all(repo_dir.join("sub")).unwrap();
        fs::write(repo_dir.join("sub/a.txt"), "v2\n").unwrap();
        git_ok(&repo_dir, &["add", "."]);
        git_ok(&repo_dir, &["commit", "-q", "-m", "c2"]);
        let c2 = git_ok(&repo_dir, &["rev-parse", "HEAD"]);

        assert_eq!(discover_root(&repo_dir.join("sub")).unwrap().unwrap(), canon_repo);
        assert_eq!(discover_root(&repo_dir.join("sub/missing.rs")).unwrap().unwrap(), canon_repo);
        assert_eq!(head(&repo_dir).unwrap().as_deref(), Some(c2.as_str()));
        assert_eq!(head_branch(&repo_dir).unwrap().as_deref(), Some("trunk"));

        // Branches & packed-refs + loose override
        git_ok(&repo_dir, &["branch", "feat/packed", &c1]);
        git_ok(&repo_dir, &["branch", "feat/override", &c1]);
        git_ok(&repo_dir, &["tag", "-a", "v1.0", "-m", "release", &c1]);
        git_ok(&repo_dir, &["pack-refs", "--all"]);
        // Override feat/override with loose ref pointing to c2
        git_ok(&repo_dir, &["branch", "-f", "feat/override", &c2]);

        assert!(branch_exists(&repo_dir, "trunk").unwrap());
        assert!(branch_exists(&repo_dir, "feat/packed").unwrap());
        assert!(branch_exists(&repo_dir, "feat/override").unwrap());
        assert!(!branch_exists(&repo_dir, "does-not-exist").unwrap());

        // Multiple remotes
        git_ok(&repo_dir, &["remote", "add", "origin", "https://github.com/acme/one.git"]);
        git_ok(&repo_dir, &["remote", "add", "upstream", "git@github.com:org/two.git"]);
        assert_eq!(
            remote_url(&repo_dir, "origin").unwrap().as_deref(),
            Some(git_ok(&repo_dir, &["remote", "get-url", "origin"]).as_str())
        );
        assert_eq!(
            remote_url(&repo_dir, "upstream").unwrap().as_deref(),
            Some(git_ok(&repo_dir, &["remote", "get-url", "upstream"]).as_str())
        );
        assert_eq!(remote_url(&repo_dir, "missing").unwrap(), None);

        // Remote-tracking ref + upstream tracking + origin/HEAD symref
        git_ok(&repo_dir, &["update-ref", "refs/remotes/origin/trunk", &c1]);
        git_ok(&repo_dir, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
        git_ok(&repo_dir, &["branch", "--set-upstream-to=origin/trunk", "trunk"]);

        // Parity of branches() against git for-each-ref
        let cli_refs = git_ok(
            &repo_dir,
            &[
                "for-each-ref",
                "--format=%(refname)|%(HEAD)|%(upstream:short)|%(objectname)|%(symref)",
                "refs/heads",
                "refs/remotes",
            ],
        );
        let expected_branches: Vec<(String, bool, bool, Option<String>, String)> = cli_refs
            .lines()
            .filter(|l| !l.is_empty())
            .filter_map(|line| {
                let parts: Vec<&str> = line.split('|').collect();
                if !parts[4].is_empty() {
                    return None;
                }
                let (name, is_remote) = match parts[0].strip_prefix("refs/heads/") {
                    Some(n) => (n.to_string(), false),
                    None => (parts[0].strip_prefix("refs/remotes/").unwrap().to_string(), true),
                };
                Some((
                    name,
                    parts[1] == "*",
                    is_remote,
                    (!parts[2].is_empty()).then(|| parts[2].to_string()),
                    parts[3].to_string(),
                ))
            })
            .collect();
        let actual_branches: Vec<(String, bool, bool, Option<String>, String)> = branches(&repo_dir)
            .unwrap()
            .into_iter()
            .map(|b| (b.name, b.is_head, b.is_remote, b.upstream, b.tip))
            .collect();
        assert_eq!(actual_branches, expected_branches);

        // commit_id_fast parity (after `git gc` packs objects into packfiles too)
        git_ok(&repo_dir, &["gc", "-q"]);
        for rev in ["HEAD", "refs/heads/trunk", "refs/heads/feat/packed", "trunk", "feat/override", &c1, &c2] {
            let cli_sha = git_ok(&repo_dir, &["rev-parse", "--verify", &format!("{rev}^{{commit}}")]);
            assert_eq!(commit_id_fast(&repo_dir, rev).unwrap().as_deref(), Some(cli_sha.as_str()), "rev={rev}");
        }
        // Annotated tag & complex revspecs return None so Repo falls back to git rev-parse
        for complex in [
            "HEAD~1",
            "HEAD^",
            "HEAD:file.txt",
            "trunk@{0}",
            "HEAD..trunk",
            "v1.0",
            &c1[..8],
            &"0".repeat(40),
        ] {
            assert_eq!(commit_id_fast(&repo_dir, complex).unwrap(), None, "complex={complex}");
        }
        let repo = Repo::discover(&repo_dir).unwrap().unwrap();
        assert_eq!(repo.commit_id("HEAD~1").unwrap(), c1);
        assert_eq!(repo.commit_id("v1.0").unwrap(), c1);

        // Detached HEAD
        git_ok(&repo_dir, &["checkout", "-q", "--detach", &c1]);
        assert_eq!(head(&repo_dir).unwrap().as_deref(), Some(c1.as_str()));
        assert_eq!(head_branch(&repo_dir).unwrap(), None);
        assert_eq!(commit_id_fast(&repo_dir, "HEAD").unwrap().as_deref(), Some(c1.as_str()));
    }

    #[test]
    fn parity_linked_worktrees_and_git_path() {
        let tmp = tempfile::tempdir().unwrap();
        let main_dir = tmp.path().join("main");
        fs::create_dir_all(&main_dir).unwrap();
        git_ok(&main_dir, &["init", "-q", "-b", "main"]);
        fs::write(main_dir.join("a.txt"), "hello\n").unwrap();
        git_ok(&main_dir, &["add", "."]);
        git_ok(&main_dir, &["commit", "-q", "-m", "init"]);

        let wt1_dir = tmp.path().join("wt_alpha");
        let wt2_dir = tmp.path().join("wt_beta");
        git_ok(&main_dir, &["worktree", "add", "-q", "-b", "branch-alpha", wt1_dir.to_str().unwrap()]);
        git_ok(&main_dir, &["worktree", "add", "-q", "--detach", wt2_dir.to_str().unwrap()]);
        git_ok(&main_dir, &["worktree", "lock", wt2_dir.to_str().unwrap()]);

        let canon_wt1 = fs::canonicalize(&wt1_dir).unwrap();
        assert_eq!(discover_root(&wt1_dir).unwrap().unwrap(), canon_wt1);
        assert_eq!(
            git_dir(&wt1_dir).unwrap(),
            PathBuf::from(git_ok(&wt1_dir, &["rev-parse", "--absolute-git-dir"]))
        );
        assert_eq!(
            git_common_dir(&wt1_dir).unwrap(),
            PathBuf::from(git_ok(&wt1_dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"]))
        );
        assert_eq!(head_branch(&wt1_dir).unwrap().as_deref(), Some("branch-alpha"));
        assert_eq!(head_branch(&wt2_dir).unwrap(), None);
        assert_eq!(head(&wt1_dir).unwrap(), head(&main_dir).unwrap());
        assert_eq!(remote_url(&wt1_dir, "origin").unwrap(), None);
        git_ok(&main_dir, &["remote", "add", "origin", "https://github.com/acme/demo.git"]);
        assert_eq!(
            remote_url(&wt1_dir, "origin").unwrap().as_deref(),
            Some(git_ok(&wt1_dir, &["remote", "get-url", "origin"]).as_str())
        );

        for rel in [
            "HEAD",
            "index",
            "index.lock",
            "refs/heads/main",
            "refs/worktree/tmp",
            "refs/bisect/bad",
            "refs/rewritten/a",
            "vibevalley-pr.md",
            "config",
            "config.worktree",
            "info/exclude",
            "info/sparse-checkout",
            "logs/HEAD",
            "logs/refs/heads/main",
            "objects",
            "packed-refs",
            "worktrees",
            "modules/sub",
        ] {
            let cli_path = PathBuf::from(git_ok(&wt1_dir, &["rev-parse", "--path-format=absolute", "--git-path", rel]));
            assert_eq!(git_path(&wt1_dir, Path::new(rel)).unwrap(), cli_path, "rel={rel}");
        }

        // Parity of worktrees() from both main and linked worktree
        let cli_wt_raw = git_ok(&main_dir, &["worktree", "list", "--porcelain"]);
        let mut expected = Vec::new();
        for block in cli_wt_raw.split("\n\n").filter(|b| !b.trim().is_empty()) {
            let mut path = PathBuf::new();
            let mut branch = None;
            let mut head = String::new();
            let mut locked = false;
            for line in block.lines() {
                if let Some(p) = line.strip_prefix("worktree ") {
                    path = PathBuf::from(p);
                } else if let Some(h) = line.strip_prefix("HEAD ") {
                    head = h.to_string();
                } else if let Some(b) = line.strip_prefix("branch ") {
                    branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
                } else if line == "locked" || line.starts_with("locked ") {
                    locked = true;
                }
            }
            expected.push(Worktree {
                path,
                branch,
                head,
                is_main: expected.is_empty(),
                locked,
            });
        }
        assert_eq!(worktrees(&main_dir).unwrap(), expected);
        assert_eq!(worktrees(&wt1_dir).unwrap(), expected);
    }

    #[test]
    fn parity_global_config_value() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let xdg = tmp.path().join("xdg");
        fs::create_dir_all(home.join(".config/git")).unwrap();
        fs::create_dir_all(xdg.join("git")).unwrap();

        fs::write(xdg.join("git/config"), "[user]\n\temail = \"xdg@example.com\" # comment\n\tname = XDG User\n").unwrap();
        fs::write(
            home.join(".gitconfig"),
            "[user]\n\temail = home@example.com ; override\n[core]\n\tautocrlf = false\n",
        )
        .unwrap();

        let explicit = tmp.path().join("explicit.gitconfig");
        fs::write(&explicit, "[user]\n\temail = \"explicit@example.com\"\n").unwrap();

        // Compare against real `git config --global --get` using explicit env (no process env mutation).
        let check = |sec: &str, key: &str, g_env: Option<&Path>, x_env: Option<&Path>, h_env: Option<&Path>| {
            let mut cmd = Command::new("git");
            cmd.current_dir(tmp.path())
                .args(["config", "--global", "--get", &format!("{sec}.{key}")])
                .env("GIT_CONFIG_NOSYSTEM", "1");
            if let Some(g) = g_env {
                cmd.env("GIT_CONFIG_GLOBAL", g);
            } else {
                cmd.env_remove("GIT_CONFIG_GLOBAL");
            }
            if let Some(x) = x_env {
                cmd.env("XDG_CONFIG_HOME", x);
            } else {
                cmd.env_remove("XDG_CONFIG_HOME");
            }
            if let Some(h) = h_env {
                cmd.env("HOME", h);
            } else {
                cmd.env_remove("HOME");
            }
            let out = cmd.output().unwrap();
            let cli = if out.status.success() {
                Some(String::from_utf8_lossy(&out.stdout).trim_end_matches(['\n', '\r']).to_string())
            } else {
                None
            };
            let actual = global_config_value_with_env(sec, key, g_env.map(Path::as_os_str), x_env.map(Path::as_os_str), h_env.map(Path::as_os_str)).unwrap();
            assert_eq!(actual, cli, "section={sec} key={key}");
        };

        check("user", "email", Some(&explicit), Some(&xdg), Some(&home));
        check("user", "email", None, Some(&xdg), Some(&home));
        check("user", "name", None, Some(&xdg), Some(&home));
        check("core", "autocrlf", None, Some(&xdg), Some(&home));
        check("user", "missing", None, Some(&xdg), Some(&home));
        check("user", "email", Some(Path::new("/dev/null")), None, Some(&home));

        // When ~/.gitconfig is absent, `git config --global` reads $XDG_CONFIG_HOME/git/config.
        let home_no_rc = tmp.path().join("home_no_rc");
        fs::create_dir_all(&home_no_rc).unwrap();
        check("user", "email", None, Some(&xdg), Some(&home_no_rc));
        check("user", "name", None, Some(&xdg), Some(&home_no_rc));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn async_repo_operations_work_inside_tokio_runtime() {
        let tmp = tempfile::tempdir().unwrap();
        let repo_dir = tmp.path().join("async_repo");
        let repo = crate::init_async(&repo_dir, Some("main")).await.unwrap();
        assert_eq!(repo.current_branch_async().await.unwrap().as_deref(), Some("main"));
        assert!(!repo.branch_exists_async("main").await.unwrap());

        fs::write(repo.root().join("a.txt"), "one\n").unwrap();
        let c1 = repo.commit_all_async("first").await.unwrap().unwrap();
        assert_eq!(repo.head_async().await.unwrap().as_deref(), Some(c1.as_str()));
        assert!(repo.branch_exists_async("main").await.unwrap());

        repo.create_branch_async("feature", None).await.unwrap();
        let wt_dir = tmp.path().join("wt_feature");
        let wt = repo.worktree_add_on_async(&wt_dir, "feature").await.unwrap();
        fs::write(wt.root().join("b.txt"), "two\n").unwrap();
        let c2 = wt.commit_all_async("feature work").await.unwrap().unwrap();

        assert_eq!(wt.changed_files_async("main").await.unwrap(), vec!["b.txt".to_string()]);
        assert_eq!(repo.commits_between_async("main", "feature").await.unwrap(), 1);
        assert!(repo.has_unmerged_async("feature", "main").await.unwrap());
        assert!(!repo.delete_branch_if_merged_async("feature", "main").await.unwrap());

        repo.worktree_remove_async(wt.root(), true).await.unwrap();
        repo.worktree_prune_async().await.unwrap();
        assert_eq!(repo.merge_async("feature", None).await.unwrap(), c2);
        assert!(repo.delete_branch_if_merged_async("feature", "main").await.unwrap());
        assert!(!repo.branch_exists_async("feature").await.unwrap());
    }
}
