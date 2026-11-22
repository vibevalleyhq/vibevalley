//! Frames: backend state turned into the JSON the TSX views render. Pure
//! functions, tested here; the shell calls them and pushes the results.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use vibevalley_files::{Entry, EntryKind, FuzzyMatch, SearchHit};
use vibevalley_git::{Branch, Change, Commit, Status, Worktree};

pub struct RailProject<'a> {
    pub id: i64,
    pub name: &'a str,
    pub path: &'a Path,
    pub active: bool,
    pub attention: bool,
    pub terminals: usize,
}

pub fn rail(projects: &[RailProject<'_>], panel: &str) -> Value {
    let items: Vec<Value> = projects
        .iter()
        .enumerate()
        .map(|(i, p)| {
            json!({
                "id": p.id,
                "name": p.name,
                "path": p.path.to_string_lossy(),
                "initials": initials(p.name),
                "active": p.active,
                "attention": p.attention,
                "terminals": p.terminals,
                "shortcut": (i < 9).then(|| format!("⌘{}", i + 1)),
            })
        })
        .collect();
    json!({ "projects": items, "panel": panel })
}

/// Up to two letters for a project tile: word starts, else the first two.
pub fn initials(name: &str) -> String {
    let words: Vec<&str> = name.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect();
    let letters: String = if words.len() >= 2 {
        words.iter().take(2).filter_map(|w| w.chars().next()).collect()
    } else {
        name.chars().filter(|c| c.is_alphanumeric()).take(2).collect()
    };
    let up = letters.to_uppercase();
    if up.is_empty() { "·".into() } else { up }
}

/// How a path shows in the tree and lists: one word the views map to a color.
pub fn tone(index: Change, worktree: Change) -> &'static str {
    use Change::*;
    match (index, worktree) {
        (Conflicted, _) | (_, Conflicted) => "conflicted",
        (_, Untracked) => "untracked",
        (_, Ignored) => "ignored",
        (Added, _) => "added",
        (Deleted, _) | (_, Deleted) => "deleted",
        (Unmodified, Unmodified) => "clean",
        _ => "modified",
    }
}

pub fn code(change: Change) -> &'static str {
    use Change::*;
    match change {
        Unmodified => " ",
        Added => "A",
        Modified => "M",
        Deleted => "D",
        Renamed => "R",
        Copied => "C",
        TypeChanged => "T",
        Untracked => "?",
        Ignored => "!",
        Conflicted => "U",
    }
}

/// Status tones by absolute path, plus `dirty` for every directory above a
/// changed file, so collapsed folders still show that something changed.
pub fn path_tones(repo_root: &Path, status: &Status) -> HashMap<PathBuf, &'static str> {
    let mut tones = HashMap::new();
    for e in &status.entries {
        let t = tone(e.index, e.worktree);
        if t == "clean" || t == "ignored" {
            continue;
        }
        let abs = repo_root.join(&e.path);
        let mut dir = abs.parent();
        while let Some(d) = dir {
            if !d.starts_with(repo_root) || d == repo_root {
                break;
            }
            tones.entry(d.to_path_buf()).or_insert("dirty");
            dir = d.parent();
        }
        tones.insert(abs, t);
    }
    tones
}

/// The file tree's state on the Rust side: loaded directories and what the
/// user expanded. Children of a directory are read when it first expands.
#[derive(Debug, Default, Clone)]
pub struct TreeState {
    pub root: PathBuf,
    pub children: HashMap<PathBuf, Vec<Entry>>,
    pub expanded: BTreeSet<PathBuf>,
    pub selected: Option<PathBuf>,
}

impl TreeState {
    pub fn new(root: PathBuf) -> Self {
        TreeState { root, ..Default::default() }
    }

    /// Directories whose children must be (re)read to draw the tree.
    pub fn wanted(&self) -> Vec<PathBuf> {
        std::iter::once(self.root.clone())
            .chain(self.expanded.iter().cloned())
            .filter(|d| !self.children.contains_key(d))
            .collect()
    }

    /// A change under `path`: its directory's listing is stale.
    pub fn invalidate(&mut self, path: &Path) {
        if let Some(parent) = path.parent() {
            self.children.remove(parent);
        }
        self.children.remove(path);
    }
}

fn tree_items(state: &TreeState, dir: &Path, tones: &HashMap<PathBuf, &'static str>, depth: usize) -> Vec<Value> {
    let Some(entries) = state.children.get(dir) else { return Vec::new() };
    entries
        .iter()
        .map(|e| {
            let id = e.path.to_string_lossy().into_owned();
            let tone = if e.ignored {
                "ignored"
            } else {
                tones.get(&e.path).copied().unwrap_or("clean")
            };
            let mut item = json!({ "id": id, "label": e.name, "tone": tone, "hidden": e.hidden });
            if e.kind == EntryKind::Dir {
                let children = if state.children.contains_key(&e.path) && depth < 64 {
                    tree_items(state, &e.path, tones, depth + 1)
                } else {
                    Vec::new()
                };
                // nsh's Tree treats an item as a folder only when it has children.
                let children = if children.is_empty() {
                    let loaded = state.children.contains_key(&e.path);
                    vec![json!({
                        "id": format!("{id}/\u{0}placeholder"),
                        "label": if loaded { "Empty" } else { "Loading…" },
                        "tone": "placeholder",
                        "loading": !loaded,
                        "disabled": true,
                    })]
                } else {
                    children
                };
                item["children"] = Value::Array(children);
            }
            item
        })
        .collect()
}

pub fn file_tree(state: &TreeState, tones: &HashMap<PathBuf, &'static str>) -> Value {
    json!({
        "root": state.root.to_string_lossy(),
        "name": state.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        "items": tree_items(state, &state.root, tones, 0),
        "expanded": state.expanded.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
        "selected": state.selected.as_ref().map(|p| p.to_string_lossy()),
    })
}

#[derive(Debug, Clone, Default)]
pub struct WorktreeActivity {
    pub changed: usize,
    pub conflicts: usize,
    pub ahead: u32,
    pub behind: u32,
    pub summary: Option<String>,
}

pub struct GitView<'a> {
    pub status: Option<&'a Status>,
    pub branches: &'a [Branch],
    pub worktrees: &'a [Worktree],
    pub worktree_activity: &'a HashMap<PathBuf, WorktreeActivity>,
    pub current_root: Option<&'a Path>,
    pub log: &'a [Commit],
    pub error: Option<&'a str>,
    pub busy: bool,
}

pub fn git_panel(v: &GitView<'_>) -> Value {
    let Some(status) = v.status else {
        return json!({ "repo": false, "error": v.error, "busy": v.busy });
    };
    let row = |path: &Path, c: Change, t: &str| json!({ "path": path.to_string_lossy(), "code": code(c), "tone": t });
    let mut staged = Vec::new();
    let mut changes = Vec::new();
    let mut conflicts = Vec::new();
    for e in &status.entries {
        let t = tone(e.index, e.worktree);
        if t == "conflicted" {
            conflicts.push(row(&e.path, Change::Conflicted, t));
            continue;
        }
        if !matches!(e.index, Change::Unmodified | Change::Untracked | Change::Ignored) {
            let it = if e.index == Change::Added {
                "added"
            } else if e.index == Change::Deleted {
                "deleted"
            } else {
                "modified"
            };
            staged.push(row(&e.path, e.index, it));
        }
        if !matches!(e.worktree, Change::Unmodified | Change::Ignored) {
            changes.push(row(&e.path, e.worktree, tone(Change::Unmodified, e.worktree)));
        }
    }
    json!({
        "repo": true,
        "branch": status.branch,
        "head": status.head.as_deref().map(|h| &h[..h.len().min(8)]),
        "upstream": status.upstream,
        "ahead": status.ahead,
        "behind": status.behind,
        "staged": staged,
        "changes": changes,
        "conflicts": conflicts,
        "branches": v.branches.iter().filter(|b| !b.is_remote).map(|b| json!({
            "name": b.name, "head": b.is_head, "upstream": b.upstream,
        })).collect::<Vec<_>>(),
        "worktrees": v.worktrees.iter().map(|w| {
            let act = v.worktree_activity.get(&w.path);
            let current = v.current_root.is_some_and(|cur| cur == w.path);
            json!({
                "path": w.path.to_string_lossy(),
                "branch": w.branch,
                "main": w.is_main,
                "locked": w.locked,
                "current": current,
                "changed": act.map_or(0, |a| a.changed),
                "conflicts": act.map_or(0, |a| a.conflicts),
                "ahead": act.map_or(0, |a| a.ahead),
                "behind": act.map_or(0, |a| a.behind),
                "summary": act.and_then(|a| a.summary.as_deref()),
            })
        }).collect::<Vec<_>>(),
        "log": v.log.iter().map(|c| json!({
            "id": c.id, "short": c.short_id, "summary": c.summary, "author": c.author_name, "time": c.time,
        })).collect::<Vec<_>>(),
        "error": v.error,
        "busy": v.busy,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaletteMode {
    Commands,
    Files,
    Search,
}

impl PaletteMode {
    pub fn name(self) -> &'static str {
        match self {
            PaletteMode::Commands => "commands",
            PaletteMode::Files => "files",
            PaletteMode::Search => "search",
        }
    }
}

/// Commands the palette offers: (id, label, group, shortcut as `keymap` writes it).
pub const COMMANDS: &[(&str, &str, &str, Option<&str>)] = &[
    ("terminal.new", "新建终端", "终端", Some("mod+t")),
    ("pane.split_right", "向右分栏", "布局", Some("mod+d")),
    ("pane.split_down", "向下分栏", "布局", Some("mod+shift+d")),
    ("pane.close", "关闭标签页", "布局", Some("mod+w")),
    ("palette.files", "跳转到文件…", "导航", Some("mod+p")),
    ("palette.search", "在项目中搜索…", "导航", Some("mod+shift+f")),
    ("panel.files", "显示文件树", "视图", None),
    ("panel.git", "显示变更与分支", "视图", None),
    ("git.diff", "查看未暂存变更", "版本控制", None),
    ("git.diff_staged", "查看已暂存变更", "版本控制", None),
    ("project.add", "添加项目…", "项目", None),
    ("project.close", "关闭项目", "项目", None),
    ("sidebar.toggle", "切换左侧栏", "视图", Some("mod+b")),
    ("font.increase", "增大字号", "视图", Some("mod+=")),
    ("font.decrease", "减小字号", "视图", Some("mod+-")),
    ("font.reset", "重置字号", "视图", Some("mod+0")),
    ("theme.toggle", "切换深浅色主题", "外观", None),
];

pub fn palette_commands() -> Vec<Value> {
    COMMANDS
        .iter()
        .map(|(id, label, group, shortcut)| json!({ "id": id, "label": label, "group": group, "shortcut": shortcut }))
        .collect()
}

pub fn palette(mode: PaletteMode, query: &str, items: Vec<Value>, loading: bool, note: Option<&str>) -> Value {
    json!({ "mode": mode.name(), "query": query, "items": items, "loading": loading, "note": note })
}

pub fn file_matches(matches: &[FuzzyMatch]) -> Vec<Value> {
    matches
        .iter()
        .map(|m| {
            let path = m.path.to_string_lossy();
            let (dir, name) = match path.rfind('/') {
                Some(i) => (&path[..i], &path[i + 1..]),
                None => ("", &path[..]),
            };
            json!({ "id": format!("file:{path}"), "label": name, "detail": dir, "indices": m.indices })
        })
        .collect()
}

pub fn search_hits(root: &Path, hits: &[SearchHit]) -> Vec<Value> {
    hits.iter()
        .map(|h| {
            let rel = h.path.strip_prefix(root).unwrap_or(&h.path).to_string_lossy();
            json!({
                "id": format!("hit:{}:{}", h.path.to_string_lossy(), h.line_no),
                "label": h.line.trim(),
                "detail": format!("{rel}:{}", h.line_no),
                "ranges": h.ranges.iter().map(|r| [r.start, r.end]).collect::<Vec<_>>(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibevalley_git::StatusEntry;

    fn entry(root: &Path, rel: &str, dir: bool) -> Entry {
        Entry {
            path: root.join(rel),
            name: rel.rsplit('/').next().unwrap().into(),
            kind: if dir { EntryKind::Dir } else { EntryKind::File },
            ignored: false,
            hidden: false,
        }
    }

    #[test]
    fn initials_pick_word_starts() {
        assert_eq!(initials("valley"), "VA");
        assert_eq!(initials("vibe-valley"), "VV");
        assert_eq!(initials("my cool app"), "MC");
        assert_eq!(initials("--"), "·");
        assert_eq!(initials("中文项目"), "中文");
    }

    #[test]
    fn rail_marks_shortcuts_for_first_nine() {
        let path = PathBuf::from("/p");
        let ps: Vec<RailProject> = (0..10)
            .map(|i| RailProject {
                id: i,
                name: "x",
                path: &path,
                active: i == 2,
                attention: false,
                terminals: 0,
            })
            .collect();
        let v = rail(&ps, "files");
        assert_eq!(v["projects"][0]["shortcut"], "⌘1");
        assert_eq!(v["projects"][8]["shortcut"], "⌘9");
        assert!(v["projects"][9]["shortcut"].is_null());
        assert_eq!(v["projects"][2]["active"], true);
        assert_eq!(v["panel"], "files");
    }

    #[test]
    fn tones_cover_status_pairs() {
        use Change::*;
        assert_eq!(tone(Unmodified, Modified), "modified");
        assert_eq!(tone(Added, Unmodified), "added");
        assert_eq!(tone(Unmodified, Untracked), "untracked");
        assert_eq!(tone(Conflicted, Conflicted), "conflicted");
        assert_eq!(tone(Unmodified, Deleted), "deleted");
        assert_eq!(tone(Unmodified, Unmodified), "clean");
    }

    #[test]
    fn dirty_propagates_to_parent_dirs() {
        let root = PathBuf::from("/r");
        let status = Status {
            entries: vec![StatusEntry {
                path: "a/b/c.rs".into(),
                orig_path: None,
                index: Change::Unmodified,
                worktree: Change::Modified,
            }],
            ..Default::default()
        };
        let t = path_tones(&root, &status);
        assert_eq!(t[&root.join("a/b/c.rs")], "modified");
        assert_eq!(t[&root.join("a/b")], "dirty");
        assert_eq!(t[&root.join("a")], "dirty");
        assert!(!t.contains_key(&root));
    }

    #[test]
    fn tree_nests_loaded_dirs_and_marks_unloaded_ones() {
        let root = PathBuf::from("/r");
        let mut s = TreeState::new(root.clone());
        assert_eq!(s.wanted(), vec![root.clone()]);
        s.children.insert(
            root.clone(),
            vec![entry(&root, "src", true), entry(&root, "lib", true), entry(&root, "README.md", false)],
        );
        s.children.insert(root.join("src"), vec![entry(&root, "src/main.rs", false)]);
        s.expanded.insert(root.join("src"));
        let mut tones = HashMap::new();
        tones.insert(root.join("src/main.rs"), "modified");
        let v = file_tree(&s, &tones);
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["children"][0]["label"], "main.rs");
        assert_eq!(items[0]["children"][0]["tone"], "modified");
        assert_eq!(items[1]["children"][0]["label"], "Loading…");
        assert_eq!(items[1]["children"][0]["loading"], true);
        assert!(items[2].get("children").is_none());
        assert_eq!(v["expanded"][0], "/r/src");
        s.expanded.insert(root.join("lib"));
        assert_eq!(s.wanted(), vec![root.join("lib")]);
        s.children.insert(root.join("lib"), Vec::new());
        let v_empty = file_tree(&s, &tones);
        assert_eq!(v_empty["items"][1]["children"][0]["label"], "Empty");
        assert_eq!(v_empty["items"][1]["children"][0]["loading"], false);
        s.invalidate(&root.join("src/main.rs"));
        assert!(s.wanted().contains(&root.join("src")));
    }

    #[test]
    fn git_panel_splits_staged_and_unstaged() {
        let status = Status {
            branch: Some("main".into()),
            head: Some("0123456789abcdef".into()),
            entries: vec![
                StatusEntry {
                    path: "a".into(),
                    orig_path: None,
                    index: Change::Modified,
                    worktree: Change::Modified,
                },
                StatusEntry {
                    path: "b".into(),
                    orig_path: None,
                    index: Change::Unmodified,
                    worktree: Change::Untracked,
                },
                StatusEntry {
                    path: "c".into(),
                    orig_path: None,
                    index: Change::Conflicted,
                    worktree: Change::Conflicted,
                },
            ],
            ..Default::default()
        };
        let empty_activity = HashMap::new();
        let v = git_panel(&GitView {
            status: Some(&status),
            branches: &[],
            worktrees: &[],
            worktree_activity: &empty_activity,
            current_root: None,
            log: &[],
            error: None,
            busy: false,
        });
        assert_eq!(v["head"], "01234567");
        assert_eq!(v["staged"].as_array().unwrap().len(), 1);
        assert_eq!(v["changes"].as_array().unwrap().len(), 2);
        assert_eq!(v["changes"][1]["code"], "?");
        assert_eq!(v["conflicts"][0]["path"], "c");
        let none = git_panel(&GitView {
            status: None,
            branches: &[],
            worktrees: &[],
            worktree_activity: &empty_activity,
            current_root: None,
            log: &[],
            error: Some("not a repo"),
            busy: false,
        });
        assert_eq!(none["repo"], false);
    }

    #[test]
    fn file_matches_split_dir_and_name() {
        let m = vec![FuzzyMatch {
            path: "src/ui/tree.rs".into(),
            score: 1,
            indices: vec![0],
        }];
        let v = file_matches(&m);
        assert_eq!(v[0]["label"], "tree.rs");
        assert_eq!(v[0]["detail"], "src/ui");
        assert_eq!(v[0]["id"], "file:src/ui/tree.rs");
    }
}
