use std::collections::{BTreeSet, VecDeque};

use crate::engine::genui::error::GenUiError;
use crate::engine::genui::spec::{GenUiNode, NodeKind, PatchOp, PropsPatch};

use super::state::{GenUiRuntime, PatchOutcome};
use super::validate::{validate_node, validate_state_value};

impl GenUiRuntime {
    pub fn apply_patch(&mut self, op: PatchOp) -> Result<PatchOutcome, GenUiError> {
        match op {
            PatchOp::Title { title, subtitle } => {
                self.doc.title = Some(title);
                if subtitle.is_some() {
                    self.doc.subtitle = subtitle;
                }
                self.doc.generation += 1;
                Ok(PatchOutcome {
                    generation: self.doc.generation,
                    dirty_nodes: Vec::new(),
                })
            }
            PatchOp::StateInit { state, overwrite } => {
                for value in state.values() {
                    validate_state_value(value)?;
                }
                let mut dirty = BTreeSet::new();
                let mut any_changed = false;
                for (key, value) in state {
                    if !overwrite && self.user_modified_keys.contains(&key) {
                        continue;
                    }
                    if self.state.set(key.clone(), value) {
                        any_changed = true;
                        if let Some(deps) = self.key_dependents.get(&key) {
                            dirty.extend(deps.iter().cloned());
                        }
                    }
                }
                if any_changed {
                    self.state_revision += 1;
                }
                self.doc.generation += 1;
                Ok(PatchOutcome {
                    generation: self.doc.generation,
                    dirty_nodes: dirty.into_iter().collect(),
                })
            }
            PatchOp::SetNode { node, root } => {
                let mut node = *node;
                validate_node(&node)?;
                if !self.doc.nodes.contains_key(&node.id) && self.doc.nodes.len() >= self.limits.max_nodes {
                    return Err(GenUiError::NodeLimitExceeded { limit: self.limits.max_nodes });
                }
                let child_ids: Vec<String> = node.kind.child_ids().into_iter().map(str::to_owned).collect();
                self.ensure_acyclic(&node.id, &child_ids)?;

                self.doc.generation += 1;
                node.generation = self.doc.generation;
                let id = node.id.clone();
                if root || self.doc.root_id.is_none() {
                    self.doc.root_id = Some(id.clone());
                }
                self.reindex_node_deps(&node);
                self.doc.nodes.insert(id.clone(), node);

                Ok(PatchOutcome {
                    generation: self.doc.generation,
                    dirty_nodes: vec![id],
                })
            }
            PatchOp::AppendChild {
                parent_id,
                child_id,
                tab_id,
                node,
            } => {
                if !self.doc.nodes.contains_key(&parent_id) {
                    return Err(GenUiError::NodeNotFound { id: parent_id });
                }
                if let Some(inline) = &node {
                    if inline.id != child_id {
                        return Err(GenUiError::ChildIdMismatch {
                            child_id,
                            node_id: inline.id.clone(),
                        });
                    }
                    validate_node(inline)?;
                    if !self.doc.nodes.contains_key(&inline.id) && self.doc.nodes.len() >= self.limits.max_nodes {
                        return Err(GenUiError::NodeLimitExceeded { limit: self.limits.max_nodes });
                    }
                }

                // Validate container kind & tab target before mutating anything.
                let mut parent_clone = self
                    .doc
                    .nodes
                    .get(&parent_id)
                    .cloned()
                    .ok_or_else(|| GenUiError::NodeNotFound { id: parent_id.clone() })?;
                append_child_to_kind(&mut parent_clone, &child_id, tab_id.as_deref())?;

                if let Some(inline) = &node {
                    let inline_children: Vec<String> = inline.kind.child_ids().into_iter().map(str::to_owned).collect();
                    self.ensure_acyclic(&inline.id, &inline_children)?;
                }
                let new_parent_children: Vec<String> = parent_clone.kind.child_ids().into_iter().map(str::to_owned).collect();
                self.ensure_acyclic_with_override(&parent_id, &new_parent_children, node.as_deref())?;

                self.doc.generation += 1;
                let generation = self.doc.generation;
                let mut dirty = Vec::new();

                if let Some(inline) = node {
                    let mut inline = *inline;
                    inline.generation = generation;
                    self.reindex_node_deps(&inline);
                    dirty.push(inline.id.clone());
                    self.doc.nodes.insert(inline.id.clone(), inline);
                }

                parent_clone.generation = generation;
                self.reindex_node_deps(&parent_clone);
                self.doc.nodes.insert(parent_id.clone(), parent_clone);
                dirty.push(parent_id);

                Ok(PatchOutcome {
                    generation,
                    dirty_nodes: dirty,
                })
            }
            PatchOp::UpdateProps { id, visible, props } => {
                let mut updated = self.doc.nodes.get(&id).cloned().ok_or_else(|| GenUiError::NodeNotFound { id: id.clone() })?;

                visible.apply(&mut updated.visible);
                apply_props_patch(&mut updated, *props)?;
                validate_node(&updated)?;

                let child_ids: Vec<String> = updated.kind.child_ids().into_iter().map(str::to_owned).collect();
                self.ensure_acyclic(&updated.id, &child_ids)?;

                self.doc.generation += 1;
                updated.generation = self.doc.generation;
                self.reindex_node_deps(&updated);
                self.doc.nodes.insert(id.clone(), updated);

                Ok(PatchOutcome {
                    generation: self.doc.generation,
                    dirty_nodes: vec![id],
                })
            }
            PatchOp::RemoveNode { id, recursive } => {
                if !self.doc.nodes.contains_key(&id) {
                    return Err(GenUiError::NodeNotFound { id });
                }

                let mut to_remove = BTreeSet::new();
                if recursive {
                    let mut queue = VecDeque::new();
                    queue.push_back(id.clone());
                    while let Some(cur) = queue.pop_front() {
                        if !to_remove.insert(cur.clone()) {
                            continue;
                        }
                        if let Some(node) = self.doc.nodes.get(&cur) {
                            for child in node.kind.child_ids() {
                                if !to_remove.contains(child) {
                                    queue.push_back(child.to_owned());
                                }
                            }
                        }
                    }
                } else {
                    to_remove.insert(id.clone());
                }

                self.doc.generation += 1;
                let generation = self.doc.generation;

                for dead_id in &to_remove {
                    self.doc.nodes.remove(dead_id);
                    self.remove_node_deps(dead_id);
                }

                if let Some(root) = &self.doc.root_id
                    && to_remove.contains(root)
                {
                    self.doc.root_id = None;
                }

                let mut dirty = Vec::new();
                for node in self.doc.nodes.values_mut() {
                    if detach_children(&mut node.kind, &to_remove) {
                        node.generation = generation;
                        dirty.push(node.id.clone());
                    }
                }

                Ok(PatchOutcome {
                    generation,
                    dirty_nodes: dirty,
                })
            }
            PatchOp::Done => {
                self.doc.complete = true;
                self.doc.generation += 1;
                Ok(PatchOutcome {
                    generation: self.doc.generation,
                    dirty_nodes: Vec::new(),
                })
            }
        }
    }
}

fn append_child_to_kind(parent: &mut GenUiNode, child_id: &str, tab_id: Option<&str>) -> Result<(), GenUiError> {
    let parent_id = parent.id.clone();
    match &mut parent.kind {
        NodeKind::Stack { children, .. } | NodeKind::Grid { children, .. } | NodeKind::Card { children, .. } => {
            if !children.iter().any(|c| c == child_id) {
                children.push(child_id.to_owned());
            }
            Ok(())
        }
        NodeKind::Tabs { tabs, .. } => {
            let target = match tab_id {
                Some(tid) => tabs.iter_mut().find(|t| t.id == tid).ok_or_else(|| GenUiError::TabNotFound {
                    node_id: parent_id,
                    tab_id: tid.to_owned(),
                })?,
                None => tabs.first_mut().ok_or_else(|| GenUiError::TabNotFound {
                    node_id: parent_id,
                    tab_id: String::new(),
                })?,
            };
            if !target.children.iter().any(|c| c == child_id) {
                target.children.push(child_id.to_owned());
            }
            Ok(())
        }
        NodeKind::Divider { .. }
        | NodeKind::Text { .. }
        | NodeKind::Markdown { .. }
        | NodeKind::Metric { .. }
        | NodeKind::Badge { .. }
        | NodeKind::Progress { .. }
        | NodeKind::Callout { .. }
        | NodeKind::Table { .. }
        | NodeKind::Slider { .. }
        | NodeKind::Switch { .. }
        | NodeKind::Select { .. }
        | NodeKind::Chart { .. }
        | NodeKind::Diagram { .. }
        | NodeKind::Canvas { .. }
        | NodeKind::CodeBlock { .. } => Err(GenUiError::NotAContainer {
            id: parent_id,
            kind: parent.kind.kind_name().to_owned(),
        }),
    }
}

fn apply_props_patch(node: &mut GenUiNode, patch: PropsPatch) -> Result<(), GenUiError> {
    let id = node.id.clone();
    let expected = node.kind.kind_name();
    let actual = patch.kind_name();
    let mismatch = || GenUiError::NodeKindMismatch {
        id: id.clone(),
        expected: expected.to_owned(),
        actual: actual.to_owned(),
    };

    match patch {
        PropsPatch::Stack {
            direction,
            gap,
            align,
            children,
        } => {
            let NodeKind::Stack {
                direction: d,
                gap: g,
                align: a,
                children: c,
            } = &mut node.kind
            else {
                return Err(mismatch());
            };
            if let Some(v) = direction {
                *d = v;
            }
            gap.apply(g);
            align.apply(a);
            if let Some(v) = children {
                *c = v;
            }
        }
        PropsPatch::Grid { columns, gap, children } => {
            let NodeKind::Grid {
                columns: cols,
                gap: g,
                children: c,
            } = &mut node.kind
            else {
                return Err(mismatch());
            };
            if let Some(v) = columns {
                *cols = v;
            }
            gap.apply(g);
            if let Some(v) = children {
                *c = v;
            }
        }
        PropsPatch::Card { title, subtitle, children } => {
            let NodeKind::Card {
                title: t,
                subtitle: sub,
                children: c,
            } = &mut node.kind
            else {
                return Err(mismatch());
            };
            title.apply(t);
            subtitle.apply(sub);
            if let Some(v) = children {
                *c = v;
            }
        }
        PropsPatch::Tabs { bind, tabs } => {
            let NodeKind::Tabs { bind: b, tabs: t } = &mut node.kind else {
                return Err(mismatch());
            };
            if let Some(v) = bind {
                *b = v;
            }
            if let Some(v) = tabs {
                *t = v;
            }
        }
        PropsPatch::Divider { label } => {
            let NodeKind::Divider { label: l } = &mut node.kind else {
                return Err(mismatch());
            };
            label.apply(l);
        }
        PropsPatch::Text { value, tone, size } => {
            let NodeKind::Text { value: v, tone: t, size: s } = &mut node.kind else {
                return Err(mismatch());
            };
            if let Some(nv) = value {
                *v = nv;
            }
            if let Some(nt) = tone {
                *t = nt;
            }
            if let Some(ns) = size {
                *s = ns;
            }
        }
        PropsPatch::Markdown { text } => {
            let NodeKind::Markdown { text: t } = &mut node.kind else {
                return Err(mismatch());
            };
            if let Some(v) = text {
                *t = v;
            }
        }
        PropsPatch::Metric { label, value, delta, format } => {
            let NodeKind::Metric {
                label: l,
                value: v,
                delta: d,
                format: f,
            } = &mut node.kind
            else {
                return Err(mismatch());
            };
            if let Some(nl) = label {
                *l = nl;
            }
            if let Some(nv) = value {
                *v = nv;
            }
            delta.apply(d);
            format.apply(f);
        }
        PropsPatch::Badge { label, tone } => {
            let NodeKind::Badge { label: l, tone: t } = &mut node.kind else {
                return Err(mismatch());
            };
            if let Some(nl) = label {
                *l = nl;
            }
            if let Some(nt) = tone {
                *t = nt;
            }
        }
        PropsPatch::Progress { value, max, label } => {
            let NodeKind::Progress { value: v, max: m, label: l } = &mut node.kind else {
                return Err(mismatch());
            };
            if let Some(nv) = value {
                *v = nv;
            }
            if let Some(nm) = max {
                *m = nm;
            }
            label.apply(l);
        }
        PropsPatch::Callout { callout_kind, title, body } => {
            let NodeKind::Callout {
                callout_kind: k,
                title: t,
                body: b,
            } = &mut node.kind
            else {
                return Err(mismatch());
            };
            if let Some(nk) = callout_kind {
                *k = nk;
            }
            title.apply(t);
            if let Some(nb) = body {
                *b = nb;
            }
        }
        PropsPatch::Table { columns, rows } => {
            let NodeKind::Table { columns: c, rows: r } = &mut node.kind else {
                return Err(mismatch());
            };
            if let Some(nc) = columns {
                *c = nc;
            }
            if let Some(nr) = rows {
                *r = nr;
            }
        }
        PropsPatch::Slider {
            bind,
            label,
            min,
            max,
            step,
            unit,
        } => {
            let NodeKind::Slider {
                bind: b,
                label: l,
                min: lo,
                max: hi,
                step: st,
                unit: u,
            } = &mut node.kind
            else {
                return Err(mismatch());
            };
            if let Some(nb) = bind {
                *b = nb;
            }
            if let Some(nl) = label {
                *l = nl;
            }
            if let Some(nlo) = min {
                *lo = nlo;
            }
            if let Some(nhi) = max {
                *hi = nhi;
            }
            if let Some(nst) = step {
                *st = nst;
            }
            unit.apply(u);
        }
        PropsPatch::Switch { bind, label } => {
            let NodeKind::Switch { bind: b, label: l } = &mut node.kind else {
                return Err(mismatch());
            };
            if let Some(nb) = bind {
                *b = nb;
            }
            if let Some(nl) = label {
                *l = nl;
            }
        }
        PropsPatch::Select { bind, label, options } => {
            let NodeKind::Select {
                bind: b,
                label: l,
                options: opts,
            } = &mut node.kind
            else {
                return Err(mismatch());
            };
            if let Some(nb) = bind {
                *b = nb;
            }
            if let Some(nl) = label {
                *l = nl;
            }
            if let Some(nopts) = options {
                *opts = nopts;
            }
        }
        PropsPatch::Chart {
            title,
            subtitle,
            width,
            height,
            source,
        } => {
            let NodeKind::Chart {
                title: t,
                subtitle: sub,
                width: w,
                height: h,
                source: src,
            } = &mut node.kind
            else {
                return Err(mismatch());
            };
            title.apply(t);
            subtitle.apply(sub);
            width.apply(w);
            height.apply(h);
            if let Some(nsrc) = source {
                *src = nsrc;
            }
        }
        PropsPatch::Diagram { source } => {
            let NodeKind::Diagram { source: s } = &mut node.kind else {
                return Err(mismatch());
            };
            if let Some(ns) = source {
                *s = ns;
            }
        }
        PropsPatch::Canvas { data } => {
            let NodeKind::Canvas { data: d } = &mut node.kind else {
                return Err(mismatch());
            };
            if let Some(nd) = data {
                *d = nd;
            }
        }
        PropsPatch::CodeBlock { code, language } => {
            let NodeKind::CodeBlock { code: c, language: lang } = &mut node.kind else {
                return Err(mismatch());
            };
            if let Some(nc) = code {
                *c = nc;
            }
            language.apply(lang);
        }
    }
    Ok(())
}

fn detach_children(kind: &mut NodeKind, removed: &BTreeSet<String>) -> bool {
    match kind {
        NodeKind::Stack { children, .. } | NodeKind::Grid { children, .. } | NodeKind::Card { children, .. } => {
            let before = children.len();
            children.retain(|c| !removed.contains(c));
            children.len() != before
        }
        NodeKind::Tabs { tabs, .. } => {
            let mut changed = false;
            for tab in tabs {
                let before = tab.children.len();
                tab.children.retain(|c| !removed.contains(c));
                if tab.children.len() != before {
                    changed = true;
                }
            }
            changed
        }
        NodeKind::Divider { .. }
        | NodeKind::Text { .. }
        | NodeKind::Markdown { .. }
        | NodeKind::Metric { .. }
        | NodeKind::Badge { .. }
        | NodeKind::Progress { .. }
        | NodeKind::Callout { .. }
        | NodeKind::Table { .. }
        | NodeKind::Slider { .. }
        | NodeKind::Switch { .. }
        | NodeKind::Select { .. }
        | NodeKind::Chart { .. }
        | NodeKind::Diagram { .. }
        | NodeKind::Canvas { .. }
        | NodeKind::CodeBlock { .. } => false,
    }
}
