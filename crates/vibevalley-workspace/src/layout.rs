//! Serializable layout tree: nested splits whose leaves are tab groups.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub type GroupId = u64;
pub type TabId = u64;
pub type SplitId = u64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DiffSpec {
    Unstaged,
    Staged,
    Uncommitted,
    Commit { id: String },
    Range { from: String, to: String },
}

impl DiffSpec {
    pub fn to_target(&self) -> vibevalley_git::DiffTarget {
        use vibevalley_git::DiffTarget as T;
        match self {
            DiffSpec::Unstaged => T::Unstaged,
            DiffSpec::Staged => T::Staged,
            DiffSpec::Uncommitted => T::Uncommitted,
            DiffSpec::Commit { id } => T::Commit(id.clone()),
            DiffSpec::Range { from, to } => T::Range {
                from: from.clone(),
                to: to.clone(),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PaneKind {
    Terminal {
        terminal_id: String,
    },
    File {
        path: PathBuf,
    },
    Diff {
        spec: DiffSpec,
        /// Limits the diff to one file, relative to the repository root.
        path: Option<PathBuf>,
        /// Repository root when it is not the project's own (a task worktree).
        repo: Option<PathBuf>,
    },
    /// A view supplied by an embedded view runtime rather than drawn by the
    /// app itself. `module` names it; `props` is passed through untouched.
    Hosted {
        module: String,
        #[serde(default)]
        props: serde_json::Value,
    },
    /// A GPU-painted pixel scene drawn by the app (`farm`, `map`, `tree`,
    /// `opening`, `catalog`); `props` is passed through untouched.
    Pixel {
        scene: String,
        #[serde(default)]
        props: serde_json::Value,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tab {
    pub id: TabId,
    #[serde(flatten)]
    pub kind: PaneKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Axis {
    /// Children sit side by side.
    Horizontal,
    /// Children are stacked top to bottom.
    Vertical,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Group {
    pub id: GroupId,
    pub tabs: Vec<Tab>,
    pub active: usize,
}

impl Group {
    pub fn active_tab(&self) -> Option<&Tab> {
        self.tabs.get(self.active)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Split {
    pub id: SplitId,
    pub axis: Axis,
    pub children: Vec<Node>,
    /// One fraction per child; they sum to 1.
    pub ratios: Vec<f32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "node", rename_all = "snake_case")]
pub enum Node {
    Group(Group),
    Split(Split),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Layout {
    pub root: Node,
    pub focused: GroupId,
    next_id: u64,
}

impl Default for Layout {
    fn default() -> Self {
        Self::new()
    }
}

const MIN_RATIO: f32 = 0.05;

impl Layout {
    pub fn new() -> Self {
        Layout {
            root: Node::Group(Group {
                id: 1,
                tabs: Vec::new(),
                active: 0,
            }),
            focused: 1,
            next_id: 2,
        }
    }

    /// Parses stored JSON and repairs anything inconsistent, so a layout
    /// written by an older build can never make the app unusable.
    pub fn from_json(value: &serde_json::Value) -> Option<Layout> {
        let mut layout: Layout = serde_json::from_value(value.clone()).ok()?;
        layout.normalize();
        Some(layout)
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("layout serializes")
    }

    fn fresh_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    pub fn groups(&self) -> Vec<&Group> {
        fn walk<'a>(node: &'a Node, out: &mut Vec<&'a Group>) {
            match node {
                Node::Group(g) => out.push(g),
                Node::Split(s) => s.children.iter().for_each(|c| walk(c, out)),
            }
        }
        let mut out = Vec::new();
        walk(&self.root, &mut out);
        out
    }

    pub fn tabs(&self) -> impl Iterator<Item = &Tab> {
        self.groups().into_iter().flat_map(|g| g.tabs.iter())
    }

    pub fn group(&self, id: GroupId) -> Option<&Group> {
        self.groups().into_iter().find(|g| g.id == id)
    }

    fn group_mut(&mut self, id: GroupId) -> Option<&mut Group> {
        fn walk(node: &mut Node, id: GroupId) -> Option<&mut Group> {
            match node {
                Node::Group(g) => (g.id == id).then_some(g),
                Node::Split(s) => s.children.iter_mut().find_map(|c| walk(c, id)),
            }
        }
        walk(&mut self.root, id)
    }

    pub fn focused_group(&self) -> &Group {
        self.group(self.focused).unwrap_or_else(|| self.groups()[0])
    }

    pub fn active_tab(&self) -> Option<&Tab> {
        self.focused_group().active_tab()
    }

    /// The group holding `tab` and the tab's index in it.
    pub fn locate(&self, tab: TabId) -> Option<(GroupId, usize)> {
        self.groups()
            .into_iter()
            .find_map(|g| g.tabs.iter().position(|t| t.id == tab).map(|i| (g.id, i)))
    }

    pub fn tab(&self, tab: TabId) -> Option<&Tab> {
        self.tabs().find(|t| t.id == tab)
    }

    pub fn find(&self, kind: &PaneKind) -> Option<TabId> {
        self.tabs().find(|t| &t.kind == kind).map(|t| t.id)
    }

    pub fn terminal_ids(&self) -> Vec<String> {
        self.tabs()
            .filter_map(|t| match &t.kind {
                PaneKind::Terminal { terminal_id } => Some(terminal_id.clone()),
                _ => None,
            })
            .collect()
    }

    /// Appends a tab to `group` (default: the focused group) and activates it.
    pub fn add_tab(&mut self, group: Option<GroupId>, kind: PaneKind) -> TabId {
        let id = self.fresh_id();
        let target = group.filter(|g| self.group(*g).is_some()).unwrap_or(self.focused_group().id);
        let g = self.group_mut(target).expect("target group exists");
        g.tabs.push(Tab { id, kind });
        g.active = g.tabs.len() - 1;
        self.focused = target;
        id
    }

    /// Activates the existing tab showing `kind`, or adds one. Terminals are
    /// identified by their id, so this never duplicates a session.
    pub fn open(&mut self, kind: PaneKind) -> TabId {
        match self.find(&kind) {
            Some(tab) => {
                self.activate(tab);
                tab
            }
            None => self.add_tab(None, kind),
        }
    }

    pub fn activate(&mut self, tab: TabId) -> bool {
        let Some((group, index)) = self.locate(tab) else { return false };
        self.group_mut(group).expect("located group").active = index;
        self.focused = group;
        true
    }

    pub fn focus_group(&mut self, group: GroupId) -> bool {
        let found = self.group(group).is_some();
        if found {
            self.focused = group;
        }
        found
    }

    /// Moves focus to the next (`+1`) or previous (`-1`) group in reading order.
    pub fn focus_cycle(&mut self, step: isize) {
        let ids: Vec<GroupId> = self.groups().iter().map(|g| g.id).collect();
        let at = ids.iter().position(|id| *id == self.focused).unwrap_or(0) as isize;
        self.focused = ids[(at + step).rem_euclid(ids.len() as isize) as usize];
    }

    /// Cycles the active tab inside the focused group.
    pub fn tab_cycle(&mut self, step: isize) {
        let focused = self.focused_group().id;
        let g = self.group_mut(focused).expect("focused group");
        if !g.tabs.is_empty() {
            g.active = (g.active as isize + step).rem_euclid(g.tabs.len() as isize) as usize;
        }
    }

    /// Removes a tab. A group left empty is removed too, unless it is the last one.
    pub fn close_tab(&mut self, tab: TabId) -> Option<PaneKind> {
        let (group, index) = self.locate(tab)?;
        let g = self.group_mut(group).expect("located group");
        let removed = g.tabs.remove(index);
        if g.active > index || g.active >= g.tabs.len() {
            g.active = g.active.saturating_sub(1);
        }
        if g.tabs.is_empty() {
            self.remove_group(group);
        }
        Some(removed.kind)
    }

    fn remove_group(&mut self, group: GroupId) {
        if matches!(&self.root, Node::Group(_)) {
            return;
        }
        let order: Vec<GroupId> = self.groups().iter().map(|g| g.id).collect();
        let at = order.iter().position(|g| *g == group).unwrap_or(0);
        fn prune(node: &mut Node, group: GroupId) {
            if let Node::Split(s) = node {
                if let Some(i) = s.children.iter().position(|c| matches!(c, Node::Group(g) if g.id == group)) {
                    s.children.remove(i);
                    s.ratios.remove(i);
                } else {
                    s.children.iter_mut().for_each(|c| prune(c, group));
                }
            }
        }
        prune(&mut self.root, group);
        collapse(&mut self.root);
        if self.focused == group {
            let remaining: Vec<GroupId> = self.groups().iter().map(|g| g.id).collect();
            self.focused = remaining[at.saturating_sub(1).min(remaining.len() - 1)];
        }
    }

    /// Splits `group` along `axis`, placing a new group with one tab after it.
    pub fn split(&mut self, group: GroupId, axis: Axis, kind: PaneKind) -> Option<(GroupId, TabId)> {
        self.group(group)?;
        let (new_group, tab, split_id) = (self.fresh_id(), self.fresh_id(), self.fresh_id());
        let new_node = Node::Group(Group {
            id: new_group,
            tabs: vec![Tab { id: tab, kind }],
            active: 0,
        });

        fn insert(node: &mut Node, group: GroupId, axis: Axis, split_id: SplitId, new_node: &mut Option<Node>) -> bool {
            match node {
                Node::Group(g) if g.id == group => {
                    let old = std::mem::replace(
                        node,
                        Node::Group(Group {
                            id: 0,
                            tabs: Vec::new(),
                            active: 0,
                        }),
                    );
                    *node = Node::Split(Split {
                        id: split_id,
                        axis,
                        children: vec![old, new_node.take().expect("inserted once")],
                        ratios: vec![0.5, 0.5],
                    });
                    true
                }
                Node::Group(_) => false,
                Node::Split(s) => {
                    let direct = s.children.iter().position(|c| matches!(c, Node::Group(g) if g.id == group));
                    match direct {
                        Some(i) if s.axis == axis => {
                            let half = s.ratios[i] / 2.0;
                            s.ratios[i] = half;
                            s.ratios.insert(i + 1, half);
                            s.children.insert(i + 1, new_node.take().expect("inserted once"));
                            true
                        }
                        _ => s.children.iter_mut().any(|c| insert(c, group, axis, split_id, new_node)),
                    }
                }
            }
        }
        let mut slot = Some(new_node);
        insert(&mut self.root, group, axis, split_id, &mut slot);
        self.focused = new_group;
        Some((new_group, tab))
    }

    /// Moves a tab to another group at `index` (clamped) and activates it.
    pub fn move_tab(&mut self, tab: TabId, to: GroupId, index: usize) -> bool {
        let Some((from, at)) = self.locate(tab) else { return false };
        if self.group(to).is_none() {
            return false;
        }
        let source = self.group_mut(from).expect("source group");
        let moved = source.tabs.remove(at);
        if source.active > at || source.active >= source.tabs.len() {
            source.active = source.active.saturating_sub(1);
        }
        let source_empty = source.tabs.is_empty();
        let target = self.group_mut(to).expect("target group");
        let index = index.min(target.tabs.len());
        target.tabs.insert(index, moved);
        target.active = index;
        self.focused = to;
        if source_empty && from != to {
            self.remove_group(from);
        }
        true
    }

    /// Moves the divider after child `index` of a split so that child takes
    /// `fraction` of the space it shares with the next child.
    pub fn resize(&mut self, split: SplitId, index: usize, fraction: f32) -> bool {
        fn walk(node: &mut Node, split: SplitId) -> Option<&mut Split> {
            let Node::Split(s) = node else { return None };
            if s.id == split {
                return Some(s);
            }
            s.children.iter_mut().find_map(|c| walk(c, split))
        }
        let Some(s) = walk(&mut self.root, split) else { return false };
        if index + 1 >= s.ratios.len() {
            return false;
        }
        let pair = s.ratios[index] + s.ratios[index + 1];
        let first = (pair * fraction).clamp(MIN_RATIO.min(pair / 2.0), pair - MIN_RATIO.min(pair / 2.0));
        s.ratios[index] = first;
        s.ratios[index + 1] = pair - first;
        true
    }

    fn normalize(&mut self) {
        fn fix(node: &mut Node, max_id: &mut u64) {
            match node {
                Node::Group(g) => {
                    *max_id = (*max_id).max(g.id).max(g.tabs.iter().map(|t| t.id).max().unwrap_or(0));
                    g.active = g.active.min(g.tabs.len().saturating_sub(1));
                }
                Node::Split(s) => {
                    *max_id = (*max_id).max(s.id);
                    s.children.iter_mut().for_each(|c| fix(c, max_id));
                    let n = s.children.len();
                    let sum: f32 = s.ratios.iter().sum();
                    if s.ratios.len() != n || s.ratios.iter().any(|r| !r.is_finite() || *r <= 0.0) || sum <= 0.0 {
                        s.ratios = vec![1.0 / n.max(1) as f32; n];
                    } else {
                        s.ratios.iter_mut().for_each(|r| *r /= sum);
                    }
                }
            }
        }
        let mut max_id = 0;
        fix(&mut self.root, &mut max_id);
        collapse(&mut self.root);
        if let Node::Split(s) = &self.root
            && s.children.is_empty()
        {
            self.root = Node::Group(Group {
                id: max_id + 1,
                tabs: Vec::new(),
                active: 0,
            });
            max_id += 1;
        }
        self.next_id = self.next_id.max(max_id + 1);
        if self.group(self.focused).is_none() {
            self.focused = self.groups()[0].id;
        }
    }
}

/// Replaces single-child splits by their child and inlines nested splits of
/// the same axis.
fn collapse(node: &mut Node) {
    let Node::Split(s) = node else { return };
    s.children.iter_mut().for_each(collapse);
    let mut i = 0;
    while i < s.children.len() {
        match &mut s.children[i] {
            Node::Split(inner) if inner.children.is_empty() => {
                s.children.remove(i);
                s.ratios.remove(i);
                continue;
            }
            Node::Split(inner) if inner.axis == s.axis => {
                let share = s.ratios[i];
                let children = std::mem::take(&mut inner.children);
                let ratios: Vec<f32> = inner.ratios.iter().map(|r| r * share).collect();
                let n = children.len();
                s.children.splice(i..=i, children);
                s.ratios.splice(i..=i, ratios);
                i += n;
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    let sum: f32 = s.ratios.iter().sum();
    if sum > 0.0 {
        s.ratios.iter_mut().for_each(|r| *r /= sum);
    }
    if s.children.len() == 1 {
        *node = s.children.remove(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn term(id: &str) -> PaneKind {
        PaneKind::Terminal { terminal_id: id.into() }
    }

    fn file(p: &str) -> PaneKind {
        PaneKind::File { path: p.into() }
    }

    #[test]
    fn add_open_and_activate() {
        let mut l = Layout::new();
        let a = l.add_tab(None, term("a"));
        let b = l.add_tab(None, file("src/main.rs"));
        assert_eq!(l.active_tab().unwrap().id, b);
        assert_eq!(l.open(file("src/main.rs")), b, "open reuses an existing tab");
        assert_eq!(l.open(term("a")), a);
        assert_eq!(l.active_tab().unwrap().id, a);
        assert_eq!(l.tabs().count(), 2);
        assert_eq!(l.terminal_ids(), vec!["a".to_string()]);
    }

    #[test]
    fn split_same_axis_stays_flat_and_ratios_sum_to_one() {
        let mut l = Layout::new();
        l.add_tab(None, term("a"));
        let g1 = l.focused;
        let (g2, _) = l.split(g1, Axis::Horizontal, term("b")).unwrap();
        let (g3, _) = l.split(g2, Axis::Horizontal, term("c")).unwrap();
        let Node::Split(s) = &l.root else { panic!("root is a split") };
        assert_eq!(s.children.len(), 3);
        assert!((s.ratios.iter().sum::<f32>() - 1.0).abs() < 1e-5);
        assert_eq!(l.focused, g3);
        assert_eq!(l.groups().iter().map(|g| g.id).collect::<Vec<_>>(), vec![g1, g2, g3]);
    }

    #[test]
    fn split_other_axis_nests() {
        let mut l = Layout::new();
        l.add_tab(None, term("a"));
        let g1 = l.focused;
        let (g2, _) = l.split(g1, Axis::Horizontal, term("b")).unwrap();
        l.split(g2, Axis::Vertical, term("c")).unwrap();
        let Node::Split(s) = &l.root else { panic!() };
        assert_eq!(s.axis, Axis::Horizontal);
        assert!(matches!(&s.children[1], Node::Split(inner) if inner.axis == Axis::Vertical && inner.children.len() == 2));
    }

    #[test]
    fn closing_last_tab_of_a_group_collapses_the_split() {
        let mut l = Layout::new();
        l.add_tab(None, term("a"));
        let g1 = l.focused;
        let (g2, t2) = l.split(g1, Axis::Horizontal, term("b")).unwrap();
        let (_, t3) = l.split(g2, Axis::Vertical, term("c")).unwrap();
        assert_eq!(l.close_tab(t3), Some(term("c")));
        assert_eq!(l.focused, g2);
        assert_eq!(l.close_tab(t2), Some(term("b")));
        assert!(matches!(&l.root, Node::Group(g) if g.id == g1));
        assert_eq!(l.focused, g1);
    }

    #[test]
    fn closing_the_only_tab_keeps_an_empty_root_group() {
        let mut l = Layout::new();
        let t = l.add_tab(None, term("a"));
        l.close_tab(t);
        assert_eq!(l.groups().len(), 1);
        assert!(l.active_tab().is_none());
        assert!(l.close_tab(t).is_none());
    }

    #[test]
    fn close_adjusts_active_index() {
        let mut l = Layout::new();
        let a = l.add_tab(None, term("a"));
        let b = l.add_tab(None, term("b"));
        let c = l.add_tab(None, term("c"));
        l.activate(b);
        l.close_tab(a);
        assert_eq!(l.active_tab().unwrap().id, b);
        l.activate(c);
        l.close_tab(c);
        assert_eq!(l.active_tab().unwrap().id, b);
    }

    #[test]
    fn move_tab_between_groups_removes_emptied_group() {
        let mut l = Layout::new();
        let a = l.add_tab(None, term("a"));
        let g1 = l.focused;
        let (g2, b) = l.split(g1, Axis::Horizontal, term("b")).unwrap();
        assert!(l.move_tab(b, g1, 0));
        assert_eq!(l.groups().len(), 1);
        assert!(l.group(g2).is_none());
        assert_eq!(l.group(g1).unwrap().tabs.iter().map(|t| t.id).collect::<Vec<_>>(), vec![b, a]);
        assert_eq!(l.active_tab().unwrap().id, b);
    }

    #[test]
    fn resize_clamps_and_preserves_sum() {
        let mut l = Layout::new();
        l.add_tab(None, term("a"));
        let g1 = l.focused;
        l.split(g1, Axis::Horizontal, term("b")).unwrap();
        let Node::Split(s) = &l.root else { panic!() };
        let id = s.id;
        assert!(l.resize(id, 0, 0.999));
        let Node::Split(s) = &l.root else { panic!() };
        assert!((s.ratios[0] - 0.95).abs() < 1e-5);
        assert!((s.ratios.iter().sum::<f32>() - 1.0).abs() < 1e-5);
        assert!(!l.resize(id, 1, 0.5));
        assert!(!l.resize(9999, 0, 0.5));
    }

    #[test]
    fn focus_and_tab_cycling_wrap() {
        let mut l = Layout::new();
        l.add_tab(None, term("a"));
        let g1 = l.focused;
        let (g2, _) = l.split(g1, Axis::Horizontal, term("b")).unwrap();
        l.focus_cycle(1);
        assert_eq!(l.focused, g1);
        l.focus_cycle(-1);
        assert_eq!(l.focused, g2);
        let c = l.add_tab(None, term("c"));
        l.tab_cycle(1);
        assert_ne!(l.active_tab().unwrap().id, c);
        l.tab_cycle(-1);
        assert_eq!(l.active_tab().unwrap().id, c);
    }

    #[test]
    fn json_round_trip() {
        let mut l = Layout::new();
        l.add_tab(None, term("a"));
        let g1 = l.focused;
        let (g2, _) = l.split(g1, Axis::Horizontal, file("README.md")).unwrap();
        l.split(
            g2,
            Axis::Vertical,
            PaneKind::Pixel {
                scene: "farm".into(),
                props: serde_json::json!({}),
            },
        )
        .unwrap();
        l.add_tab(
            None,
            PaneKind::Diff {
                spec: DiffSpec::Range {
                    from: "a".into(),
                    to: "b".into(),
                },
                path: None,
                repo: Some("/w".into()),
            },
        );
        l.add_tab(
            None,
            PaneKind::Hosted {
                module: "agents/board".into(),
                props: serde_json::json!({"project": 3}),
            },
        );
        let restored = Layout::from_json(&l.to_json()).unwrap();
        assert_eq!(restored, l);
        let mut restored = restored;
        let fresh = restored.add_tab(None, term("z"));
        assert!(l.tab(fresh).is_none(), "ids continue after the restored ones");
    }

    #[test]
    fn from_json_repairs_broken_state() {
        let json = serde_json::json!({
            "root": {"node": "split", "id": 7, "axis": "horizontal", "ratios": [3.0],
                "children": [
                    {"node": "group", "id": 3, "active": 9, "tabs": [{"id": 4, "kind": "terminal", "terminal_id": "a"}]},
                    {"node": "split", "id": 8, "axis": "vertical", "ratios": [], "children": []}
                ]},
            "focused": 99,
            "next_id": 1
        });
        let mut l = Layout::from_json(&json).unwrap();
        assert!(matches!(&l.root, Node::Group(g) if g.id == 3 && g.active == 0));
        assert_eq!(l.focused, 3);
        assert!(l.add_tab(None, term("b")) > 8);
        assert!(Layout::from_json(&serde_json::json!({"nope": 1})).is_none());
    }
}
