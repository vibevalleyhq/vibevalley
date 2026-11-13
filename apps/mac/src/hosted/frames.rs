//! Frames: backend state turned into the JSON the TSX views render. Pure
//! functions, tested here; the shell calls them and pushes the results.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use vibevalley_files::{Entry, EntryKind, FuzzyMatch, SearchHit};
use vibevalley_git::{Branch, Change, Commit, Status, Worktree};
use vibevalley_workspace::transcript::{Entry as TranscriptEntry, Item};
use vibevalley_workspace::{PendingPermission, TaskInfo, TaskPhase};

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

pub struct GitView<'a> {
    pub status: Option<&'a Status>,
    pub branches: &'a [Branch],
    pub worktrees: &'a [Worktree],
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
        "worktrees": v.worktrees.iter().map(|w| json!({
            "path": w.path.to_string_lossy(), "branch": w.branch, "main": w.is_main, "locked": w.locked,
        })).collect::<Vec<_>>(),
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
    ("terminal.new", "New Terminal", "Terminal", Some("mod+t")),
    ("pane.split_right", "Split Right", "Layout", Some("mod+d")),
    ("pane.split_down", "Split Down", "Layout", Some("mod+shift+d")),
    ("pane.close", "Close Tab", "Layout", Some("mod+w")),
    ("palette.files", "Go to File…", "Navigate", Some("mod+p")),
    ("palette.search", "Search in Project…", "Navigate", Some("mod+shift+f")),
    ("panel.files", "Show Files", "View", None),
    ("panel.git", "Show Source Control", "View", None),
    ("panel.agents", "Show Agents", "View", None),
    ("git.diff", "Open Changes", "Source Control", None),
    ("git.diff_staged", "Open Staged Changes", "Source Control", None),
    ("project.add", "Add Project…", "Projects", None),
    ("project.close", "Close Project", "Projects", None),
    ("sidebar.toggle", "Toggle Sidebar", "View", Some("mod+b")),
    ("font.increase", "Increase Font Size", "View", Some("mod+=")),
    ("font.decrease", "Decrease Font Size", "View", Some("mod+-")),
    ("font.reset", "Reset Font Size", "View", Some("mod+0")),
    ("theme.toggle", "Toggle Light/Dark Theme", "View", None),
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

/// A task phase as the views' three status forms plus "needs you".
pub fn phase_tone(phase: TaskPhase) -> (&'static str, &'static str) {
    match phase {
        TaskPhase::Preparing => ("running", "Preparing"),
        TaskPhase::Running => ("running", "Running"),
        TaskPhase::WaitingPermission => ("alert", "Needs permission"),
        TaskPhase::WaitingReply => ("alert", "Waiting for you"),
        TaskPhase::Idle => ("idle", "Idle"),
        TaskPhase::Review => ("alert", "Review"),
        TaskPhase::Merged => ("done", "Merged"),
        TaskPhase::Ended => ("done", "Ended"),
        TaskPhase::Failed => ("failed", "Failed"),
    }
}

pub fn tasks(list: &[TaskInfo], selected: Option<&str>) -> Value {
    let items: Vec<Value> = list
        .iter()
        .map(|t| {
            let (tone, label) = phase_tone(t.phase);
            json!({
                "id": t.id, "title": t.title, "runtime": t.runtime_id, "tone": tone, "label": label,
                "branch": t.branch, "error": t.error, "updatedMs": t.updated_ms, "createdMs": t.created_ms,
                "live": t.phase.is_live(),
            })
        })
        .collect();
    json!({ "tasks": items, "selected": selected })
}

/// Decisions for `DecisionInbox`: permission requests and tasks in review.
pub fn inbox(pending: &[PendingPermission], list: &[TaskInfo]) -> Value {
    let mut entries: Vec<Value> = pending
        .iter()
        .map(|p| {
            json!({
                "id": format!("perm:{}:{}", p.task_id, p.request_id),
                "kind": "permission",
                "source": p.task_title,
                "title": format!("{} wants to run {}", p.task_title, p.tool),
                "detail": if p.summary.is_empty() { p.input.to_string() } else { p.summary.clone() },
                "primary": "Allow",
                "secondary": "Deny",
                "atMs": p.at_ms,
            })
        })
        .collect();
    entries.extend(list.iter().filter(|t| t.phase == TaskPhase::Review).map(|t| {
        json!({
            "id": format!("review:{}", t.id),
            "kind": "review",
            "source": t.title,
            "title": format!("{} is ready for review", t.title),
            "detail": t.branch.as_ref().map(|b| format!("branch {b}")),
            "primary": "Complete",
            "secondary": "Send back",
            "atMs": t.updated_ms,
        })
    }));
    json!({ "entries": entries })
}

/// A transcript as display blocks: messages, tool calls paired with their
/// results (`ToolCall` objects for `ToolCallCard`), and runs of consecutive
/// calls folded into groups.
pub fn transcript(entries: &[TranscriptEntry], running: bool) -> Value {
    let mut blocks: Vec<Value> = Vec::new();
    let mut results: HashMap<&str, (&TranscriptEntry, bool, &str)> = HashMap::new();
    for e in entries {
        if let Item::ToolResult { id, ok, output } = &e.item {
            results.insert(id.as_str(), (e, *ok, output.as_str()));
        }
    }
    for e in entries {
        let block = match &e.item {
            Item::User(text) => json!({ "kind": "user", "text": text }),
            Item::Assistant(text) => json!({ "kind": "assistant", "text": text }),
            Item::Thinking(text) => json!({ "kind": "thinking", "text": text }),
            Item::ToolCall { id, name, input } => {
                let result = results.get(id.as_str());
                let status = match result {
                    Some((_, true, _)) => "done",
                    Some((_, false, _)) => "failed",
                    None if running => "running",
                    None => "done",
                };
                let call = json!({
                    "id": id, "name": name,
                    "summary": input.lines().next().unwrap_or(""),
                    "status": status,
                    "startedMs": e.at_ms,
                    "endedMs": result.map(|r| r.0.at_ms),
                    "input": input,
                    "output": result.filter(|r| r.1).map(|r| r.2),
                    "error": result.filter(|r| !r.1).map(|r| r.2),
                    "retryable": false,
                });
                if let Some(last) = blocks.last_mut()
                    && last["kind"] == "tools"
                {
                    last["calls"].as_array_mut().expect("calls").push(call);
                    continue;
                }
                json!({ "kind": "tools", "calls": [call] })
            }
            Item::ToolResult { .. } => continue,
            Item::FileChanged { path, .. } => json!({ "kind": "note", "text": format!("changed {}", path.display()) }),
            Item::PermissionAsked { tool, summary, .. } => {
                json!({ "kind": "note", "text": format!("asked to run {tool}: {summary}") })
            }
            Item::PermissionAnswered { decision, .. } => json!({ "kind": "note", "text": format!("answered {decision:?}") }),
            Item::Question(text) => json!({ "kind": "question", "text": text }),
            Item::TurnEnd { .. } => json!({ "kind": "turn_end" }),
            Item::Error(text) => json!({ "kind": "error", "text": text }),
            Item::Ended => json!({ "kind": "note", "text": "session ended" }),
        };
        blocks.push(block);
    }
    let waiting_first_call = running && !matches!(blocks.last().map(|b| &b["kind"]), Some(k) if k == "tools");
    json!({ "blocks": blocks, "running": running, "thinking": waiting_first_call })
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
        assert!(items[2].get("children").is_none());
        assert_eq!(v["expanded"][0], "/r/src");
        s.expanded.insert(root.join("lib"));
        assert_eq!(s.wanted(), vec![root.join("lib")]);
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
        let v = git_panel(&GitView {
            status: Some(&status),
            branches: &[],
            worktrees: &[],
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

    #[test]
    fn transcript_pairs_calls_and_groups_runs() {
        let e = |at, item| TranscriptEntry {
            agent_path: vec![],
            at_ms: at,
            item,
        };
        let entries = vec![
            e(1, Item::User("do it".into())),
            e(
                2,
                Item::ToolCall {
                    id: "t1".into(),
                    name: "Bash".into(),
                    input: "ls".into(),
                },
            ),
            e(
                3,
                Item::ToolResult {
                    id: "t1".into(),
                    ok: true,
                    output: "a\nb".into(),
                },
            ),
            e(
                4,
                Item::ToolCall {
                    id: "t2".into(),
                    name: "Read".into(),
                    input: "x.rs".into(),
                },
            ),
            e(
                5,
                Item::ToolResult {
                    id: "t2".into(),
                    ok: false,
                    output: "no such file".into(),
                },
            ),
            e(6, Item::Assistant("done".into())),
            e(
                7,
                Item::ToolCall {
                    id: "t3".into(),
                    name: "Bash".into(),
                    input: "make".into(),
                },
            ),
        ];
        let v = transcript(&entries, true);
        let blocks = v["blocks"].as_array().unwrap();
        assert_eq!(blocks.len(), 4);
        assert_eq!(blocks[1]["calls"].as_array().unwrap().len(), 2);
        assert_eq!(blocks[1]["calls"][0]["status"], "done");
        assert_eq!(blocks[1]["calls"][0]["endedMs"], 3);
        assert_eq!(blocks[1]["calls"][1]["status"], "failed");
        assert_eq!(blocks[1]["calls"][1]["error"], "no such file");
        assert_eq!(blocks[3]["calls"][0]["status"], "running");
        assert_eq!(v["thinking"], false);
        let v = transcript(&entries[..1], true);
        assert_eq!(v["thinking"], true);
    }
}
