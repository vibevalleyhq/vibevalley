use std::collections::{BTreeMap, BTreeSet, VecDeque};

use vibevalley_protocol::{ArtifactEntry, ArtifactEntryWriteInput};

use crate::engine::whiteboard::codec::{
    decode_element, decode_meta, decode_presence, encode_element_delete, encode_element_patch, encode_element_write, encode_meta_write,
};
use crate::engine::whiteboard::hit::{container_at_point, expand_with_children};
use crate::engine::whiteboard::model::{
    ArrowEndpoint, BoardDoc, BoardMeta, ElementId, ElementKind, ElementRecord, Rect2, ShapeKind, StrokeStyle, Vec2, WbFill,
};

pub const DEFAULT_HISTORY_LIMIT: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZOrderDir {
    Front,
    Back,
    Forward,
    Backward,
}

#[derive(Debug, Clone, PartialEq)]
pub enum BoardCommand {
    CreateElements(Vec<ElementRecord>),
    DeleteElements(Vec<ElementId>),
    MoveElements {
        deltas: Vec<(ElementId, Vec2)>,
        include_container_children: bool,
    },
    SetBounds {
        id: ElementId,
        rect: Rect2,
    },
    SetRotation {
        changes: Vec<(ElementId, f64)>,
    },
    UpdateElement(Box<ElementRecord>),
    ReorderZOrder {
        ids: Vec<ElementId>,
        dir: ZOrderDir,
    },
    GroupSelection(Vec<ElementId>),
    UngroupSelection(Vec<ElementId>),
    SetLocked {
        ids: Vec<ElementId>,
        locked: bool,
    },
    WrapInContainer {
        ids: Vec<ElementId>,
        title: String,
    },
    DuplicateSelection(Vec<ElementId>),
    ApplyDoc(BoardDoc),
    UpdateMeta(BoardMeta),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ElementDelta {
    pub id: ElementId,
    pub before: Option<ElementRecord>,
    pub after: Option<ElementRecord>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HistoryEntry {
    pub label: String,
    pub coalesce_key: Option<String>,
    pub element_deltas: Vec<ElementDelta>,
    pub meta_change: Option<(BoardMeta, BoardMeta)>,
}

#[derive(Debug, Clone)]
pub struct UndoHistory {
    limit: usize,
    undo: VecDeque<HistoryEntry>,
    redo: Vec<HistoryEntry>,
}

impl Default for UndoHistory {
    fn default() -> Self {
        Self::new(DEFAULT_HISTORY_LIMIT)
    }
}

impl UndoHistory {
    pub fn new(limit: usize) -> Self {
        let cap = limit.max(1);
        Self {
            limit: cap,
            undo: VecDeque::with_capacity(cap),
            redo: Vec::new(),
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub fn push(&mut self, entry: HistoryEntry) {
        if entry.element_deltas.is_empty() && entry.meta_change.is_none() {
            return;
        }
        self.redo.clear();
        if let Some(key) = &entry.coalesce_key
            && let Some(back) = self.undo.back_mut()
            && back.coalesce_key.as_ref() == Some(key)
            && same_ids(&back.element_deltas, &entry.element_deltas)
        {
            for d_new in &entry.element_deltas {
                if let Some(d_old) = back.element_deltas.iter_mut().find(|d| d.id == d_new.id) {
                    d_old.after = d_new.after.clone();
                }
            }
            return;
        }
        if self.undo.len() >= self.limit {
            self.undo.pop_front();
        }
        self.undo.push_back(entry);
    }

    pub fn pop_undo(&mut self) -> Option<HistoryEntry> {
        let entry = self.undo.pop_back()?;
        self.redo.push(entry.clone());
        Some(entry)
    }

    pub fn pop_redo(&mut self) -> Option<HistoryEntry> {
        let entry = self.redo.pop()?;
        self.undo.push_back(entry.clone());
        Some(entry)
    }
}

fn same_ids(a: &[ElementDelta], b: &[ElementDelta]) -> bool {
    a.len() == b.len() && a.iter().all(|da| b.iter().any(|db| db.id == da.id))
}

#[derive(Debug, Clone, Default)]
pub struct ApplyResult {
    pub writes: Vec<ArtifactEntryWriteInput>,
    pub selected_ids: Option<Vec<ElementId>>,
}

pub fn apply_command(
    doc: &mut BoardDoc,
    history: Option<&mut UndoHistory>,
    cmd: BoardCommand,
    coalesce_key: Option<String>,
    include_if_rev: bool,
) -> ApplyResult {
    let mut deltas: Vec<ElementDelta> = Vec::new();
    let mut writes: Vec<ArtifactEntryWriteInput> = Vec::new();
    let mut meta_change: Option<(BoardMeta, BoardMeta)> = None;
    let mut selected_ids: Option<Vec<ElementId>> = None;
    let label: String;

    match cmd {
        BoardCommand::CreateElements(items) => {
            label = "Create".to_owned();
            let mut created_ids = Vec::with_capacity(items.len());
            let mut next_z = doc.next_z();
            let lookup = doc.rect_lookup();
            for mut el in items {
                if el.z == 0 {
                    el.z = next_z;
                    next_z += 1;
                }
                if el.parent_id.is_none() && !el.is_container() && !el.is_arrow() {
                    let center = el.bbox(&lookup).center();
                    el.parent_id = container_at_point(doc, &lookup, center, &BTreeSet::new());
                }
                created_ids.push(el.id.clone());
                writes.push(encode_element_write(&el, false));
                deltas.push(ElementDelta {
                    id: el.id.clone(),
                    before: None,
                    after: Some(el.clone()),
                });
                doc.elements.retain(|existing| existing.id != el.id);
                doc.elements.push(el);
            }
            doc.sort_by_z();
            selected_ids = Some(created_ids);
        }
        BoardCommand::DeleteElements(ids) => {
            label = "Delete".to_owned();
            let target_set: BTreeSet<ElementId> = ids.into_iter().collect();
            for el in &doc.elements {
                if target_set.contains(&el.id) && !el.locked {
                    deltas.push(ElementDelta {
                        id: el.id.clone(),
                        before: Some(el.clone()),
                        after: None,
                    });
                    writes.push(encode_element_delete(&el.id, el.rev, include_if_rev));
                }
            }
            let deleted: BTreeSet<ElementId> = deltas.iter().map(|d| d.id.clone()).collect();
            doc.elements.retain(|el| !deleted.contains(&el.id));
            selected_ids = Some(Vec::new());
        }
        BoardCommand::MoveElements {
            deltas: move_deltas,
            include_container_children,
        } => {
            label = "Move".to_owned();
            let mut per_id: BTreeMap<ElementId, Vec2> = BTreeMap::new();
            for (id, delta) in &move_deltas {
                per_id.insert(id.clone(), *delta);
            }
            if include_container_children {
                let roots: Vec<ElementId> = per_id.keys().cloned().collect();
                let expanded = expand_with_children(doc, &roots);
                for cid in expanded {
                    if !per_id.contains_key(&cid)
                        && let Some(parent_id) = doc.element(&cid).and_then(|e| e.parent_id.as_ref())
                        && let Some(&delta) = per_id.get(parent_id)
                    {
                        per_id.insert(cid, delta);
                    }
                }
            }
            let moving_set: BTreeSet<ElementId> = per_id.keys().cloned().collect();
            let base_lookup = doc.rect_lookup();
            let static_containers: Vec<(ElementId, Rect2)> = doc
                .elements
                .iter()
                .filter(|c| c.is_container() && !moving_set.contains(&c.id))
                .filter_map(|c| base_lookup.get(&c.id).map(|cr| (c.id.clone(), *cr)))
                .collect();
            for el in &mut doc.elements {
                if el.locked {
                    continue;
                }
                if let Some(&delta) = per_id.get(&el.id) {
                    let before = el.clone();
                    el.translate(delta.x, delta.y);
                    // Update auto-parenting when moving non-container elements cleanly out/in without moving their container.
                    if !el.is_container() && !el.is_arrow() && !el.parent_id.as_ref().is_some_and(|p| moving_set.contains(p)) {
                        let r = el.bbox(&base_lookup);
                        let new_center = Point2_center_with(r, delta);
                        el.parent_id = static_containers
                            .iter()
                            .rfind(|(_, cr)| cr.contains_point(new_center))
                            .map(|(cid, _)| cid.clone());
                    }
                    writes.push(encode_element_patch(&before, el, include_if_rev));
                    deltas.push(ElementDelta {
                        id: el.id.clone(),
                        before: Some(before),
                        after: Some(el.clone()),
                    });
                }
            }
        }
        BoardCommand::SetBounds { id, rect } => {
            label = "Resize".to_owned();
            if let Some(el) = doc.element_mut(&id)
                && !el.locked
            {
                let before = el.clone();
                if el.set_bounds(rect) {
                    writes.push(encode_element_patch(&before, el, include_if_rev));
                    deltas.push(ElementDelta {
                        id,
                        before: Some(before),
                        after: Some(el.clone()),
                    });
                }
            }
        }
        BoardCommand::SetRotation { changes } => {
            label = "Rotate".to_owned();
            for (id, deg) in changes {
                if let Some(el) = doc.element_mut(&id)
                    && !el.locked
                {
                    let before = el.clone();
                    el.rotation_deg = deg.rem_euclid(360.0);
                    writes.push(encode_element_patch(&before, el, include_if_rev));
                    deltas.push(ElementDelta {
                        id,
                        before: Some(before),
                        after: Some(el.clone()),
                    });
                }
            }
        }
        BoardCommand::UpdateElement(next) => {
            label = "Update".to_owned();
            if let Some(el) = doc.element_mut(&next.id) {
                let before = el.clone();
                let mut updated = *next;
                updated.rev = before.rev;
                writes.push(encode_element_patch(&before, &updated, include_if_rev));
                *el = updated.clone();
                deltas.push(ElementDelta {
                    id: updated.id.clone(),
                    before: Some(before),
                    after: Some(updated),
                });
            }
        }
        BoardCommand::ReorderZOrder { ids, dir } => {
            label = "Reorder".to_owned();
            let set: BTreeSet<ElementId> = ids.into_iter().collect();
            let min_z = doc.elements.iter().map(|e| e.z).min().unwrap_or(1);
            let max_z = doc.elements.iter().map(|e| e.z).max().unwrap_or(1);
            for el in &mut doc.elements {
                if !set.contains(&el.id) {
                    continue;
                }
                let before = el.clone();
                el.z = match dir {
                    ZOrderDir::Front => max_z + 1,
                    ZOrderDir::Back => min_z - 1,
                    ZOrderDir::Forward => el.z + 2,
                    ZOrderDir::Backward => el.z - 2,
                };
                writes.push(encode_element_patch(&before, el, include_if_rev));
                deltas.push(ElementDelta {
                    id: el.id.clone(),
                    before: Some(before),
                    after: Some(el.clone()),
                });
            }
            doc.sort_by_z();
        }
        BoardCommand::GroupSelection(ids) => {
            label = "Group".to_owned();
            if ids.len() >= 2 {
                let gid = format!("grp-{}", doc.next_z());
                let set: BTreeSet<ElementId> = ids.into_iter().collect();
                for el in &mut doc.elements {
                    if set.contains(&el.id) {
                        let before = el.clone();
                        el.group_id = Some(gid.clone());
                        writes.push(encode_element_patch(&before, el, include_if_rev));
                        deltas.push(ElementDelta {
                            id: el.id.clone(),
                            before: Some(before),
                            after: Some(el.clone()),
                        });
                    }
                }
            }
        }
        BoardCommand::UngroupSelection(ids) => {
            label = "Ungroup".to_owned();
            let set: BTreeSet<ElementId> = ids.into_iter().collect();
            for el in &mut doc.elements {
                if set.contains(&el.id) && el.group_id.is_some() {
                    let before = el.clone();
                    el.group_id = None;
                    writes.push(encode_element_patch(&before, el, include_if_rev));
                    deltas.push(ElementDelta {
                        id: el.id.clone(),
                        before: Some(before),
                        after: Some(el.clone()),
                    });
                }
            }
        }
        BoardCommand::SetLocked { ids, locked } => {
            label = if locked { "Lock" } else { "Unlock" }.to_owned();
            let set: BTreeSet<ElementId> = ids.into_iter().collect();
            for el in &mut doc.elements {
                if set.contains(&el.id) && el.locked != locked {
                    let before = el.clone();
                    el.locked = locked;
                    writes.push(encode_element_patch(&before, el, include_if_rev));
                    deltas.push(ElementDelta {
                        id: el.id.clone(),
                        before: Some(before),
                        after: Some(el.clone()),
                    });
                }
            }
        }
        BoardCommand::WrapInContainer { ids, title } => {
            label = "Wrap container".to_owned();
            let lookup = doc.rect_lookup();
            let selected: Vec<Rect2> = ids.iter().filter_map(|id| lookup.get(id).copied()).collect();
            if let Some(first) = selected.first().copied() {
                let union = selected.into_iter().skip(1).fold(first, Rect2::union).expand(36.0);
                let cid = ElementId::new(format!("zone-{}", doc.next_z()));
                let mut container = ElementRecord::new(
                    cid.clone(),
                    ElementKind::Container {
                        x: union.x,
                        y: union.y - 16.0,
                        w: union.w.max(240.0),
                        h: union.h + 16.0,
                        title,
                        fill: WbFill::Side,
                        stroke: None,
                        collapsed: false,
                    },
                );
                let min_z = doc.elements.iter().map(|e| e.z).min().unwrap_or(1);
                container.z = min_z - 1;
                writes.push(encode_element_write(&container, false));
                deltas.push(ElementDelta {
                    id: cid.clone(),
                    before: None,
                    after: Some(container.clone()),
                });
                doc.elements.push(container);
                let id_set: BTreeSet<ElementId> = ids.iter().cloned().collect();
                for el in &mut doc.elements {
                    if id_set.contains(&el.id) && !el.is_container() {
                        let before = el.clone();
                        el.parent_id = Some(cid.clone());
                        writes.push(encode_element_patch(&before, el, include_if_rev));
                        deltas.push(ElementDelta {
                            id: el.id.clone(),
                            before: Some(before),
                            after: Some(el.clone()),
                        });
                    }
                }
                doc.sort_by_z();
                selected_ids = Some(vec![cid]);
            }
        }
        BoardCommand::DuplicateSelection(ids) => {
            label = "Duplicate".to_owned();
            let set: BTreeSet<ElementId> = ids.iter().cloned().collect();
            let mut id_map: BTreeMap<ElementId, ElementId> = BTreeMap::new();
            let mut next_z = doc.next_z();
            for (idx, old_id) in ids.iter().enumerate() {
                id_map.insert(old_id.clone(), ElementId::new(format!("{}-copy-{}", old_id, next_z + idx as i32)));
            }
            let mut copies = Vec::new();
            for el in &doc.elements {
                if !set.contains(&el.id) {
                    continue;
                }
                let mut cloned = el.clone();
                if let Some(new_id) = id_map.get(&el.id) {
                    cloned.id = new_id.clone();
                }
                cloned.rev = 0;
                cloned.z = next_z;
                next_z += 1;
                if let Some(parent) = &cloned.parent_id
                    && let Some(new_parent) = id_map.get(parent)
                {
                    cloned.parent_id = Some(new_parent.clone());
                }
                cloned.translate(28.0, 28.0);
                if let ElementKind::Arrow { from, to, .. } = &mut cloned.kind {
                    if let ArrowEndpoint::Bound { id, .. } = from
                        && let Some(mapped) = id_map.get(id)
                    {
                        *id = mapped.clone();
                    }
                    if let ArrowEndpoint::Bound { id, .. } = to
                        && let Some(mapped) = id_map.get(id)
                    {
                        *id = mapped.clone();
                    }
                }
                copies.push(cloned);
            }
            let mut new_selection = Vec::with_capacity(copies.len());
            for c in copies {
                new_selection.push(c.id.clone());
                writes.push(encode_element_write(&c, false));
                deltas.push(ElementDelta {
                    id: c.id.clone(),
                    before: None,
                    after: Some(c.clone()),
                });
                doc.elements.push(c);
            }
            doc.sort_by_z();
            selected_ids = Some(new_selection);
        }
        BoardCommand::ApplyDoc(next_doc) => {
            label = "Template".to_owned();
            for prev in &doc.elements {
                if !next_doc.elements.iter().any(|n| n.id == prev.id) {
                    writes.push(encode_element_delete(&prev.id, prev.rev, include_if_rev));
                    deltas.push(ElementDelta {
                        id: prev.id.clone(),
                        before: Some(prev.clone()),
                        after: None,
                    });
                }
            }
            for next_el in &next_doc.elements {
                let before = doc.element(&next_el.id).cloned();
                writes.push(encode_element_write(next_el, false));
                deltas.push(ElementDelta {
                    id: next_el.id.clone(),
                    before,
                    after: Some(next_el.clone()),
                });
            }
            if doc.meta != next_doc.meta {
                meta_change = Some((doc.meta.clone(), next_doc.meta.clone()));
                writes.push(encode_meta_write(&next_doc.meta));
            }
            doc.meta = next_doc.meta;
            doc.elements = next_doc.elements;
            doc.sort_by_z();
            selected_ids = Some(Vec::new());
        }
        BoardCommand::UpdateMeta(meta) => {
            label = "Board meta".to_owned();
            if doc.meta != meta {
                meta_change = Some((doc.meta.clone(), meta.clone()));
                doc.meta = meta.clone();
                writes.push(encode_meta_write(&meta));
            }
        }
    }

    if let Some(hist) = history {
        hist.push(HistoryEntry {
            label,
            coalesce_key,
            element_deltas: deltas,
            meta_change,
        });
    }

    ApplyResult { writes, selected_ids }
}

pub fn apply_history_step(doc: &mut BoardDoc, entry: &HistoryEntry, is_undo: bool, include_if_rev: bool) -> Vec<ArtifactEntryWriteInput> {
    let mut writes = Vec::new();
    for d in &entry.element_deltas {
        let target = if is_undo { &d.before } else { &d.after };
        let current_rev = doc.element(&d.id).map_or(0, |e| e.rev);
        match target {
            Some(state) => {
                let mut restored = state.clone();
                restored.rev = current_rev;
                writes.push(encode_element_write(&restored, include_if_rev));
                doc.elements.retain(|e| e.id != d.id);
                doc.elements.push(restored);
            }
            None => {
                doc.elements.retain(|e| e.id != d.id);
                writes.push(encode_element_delete(&d.id, current_rev, include_if_rev));
            }
        }
    }
    if let Some((before_m, after_m)) = &entry.meta_change {
        let m = if is_undo { before_m } else { after_m };
        doc.meta = m.clone();
        writes.push(encode_meta_write(m));
    }
    doc.sort_by_z();
    writes
}

pub fn apply_remote_entries(doc: &mut BoardDoc, updated: &[ArtifactEntry], deleted_paths: &[String], next_seq: i64) -> Vec<ElementId> {
    if next_seq > doc.seq {
        doc.seq = next_seq;
    }
    let mut removed_ids = Vec::new();
    for path in deleted_paths {
        if let Some(id) = path.strip_prefix("elements/") {
            let eid = ElementId::new(id);
            doc.elements.retain(|e| e.id != eid);
            removed_ids.push(eid);
        } else if let Some(pid) = path.strip_prefix("presence/") {
            doc.presences.retain(|p| p.id != pid);
        }
    }
    for entry in updated {
        let Some(raw) = entry.value.as_deref() else {
            continue;
        };
        if entry.path == "board/meta" {
            if let Ok(m) = decode_meta(raw) {
                doc.meta = m;
            }
        } else if let Some(id) = entry.path.strip_prefix("elements/") {
            if let Ok(mut el) = decode_element(id, entry.rev, raw) {
                if el.z == 0 {
                    el.z = doc.element(&el.id).map_or_else(|| doc.next_z(), |old| old.z);
                }
                doc.elements.retain(|e| e.id != el.id);
                doc.elements.push(el);
            }
        } else if let Some(pid) = entry.path.strip_prefix("presence/")
            && let Ok(p) = decode_presence(pid, entry.rev, raw)
        {
            doc.presences.retain(|existing| existing.id != p.id);
            doc.presences.push(p);
        }
    }
    doc.sort_by_z();
    removed_ids
}

pub fn make_sticky_or_shape(id: &str, x: f64, y: f64, shape: ShapeKind, title: &str, body: &str, fill: WbFill) -> ElementRecord {
    ElementRecord::new(
        id,
        ElementKind::Shape {
            x,
            y,
            w: 184.0,
            h: if matches!(shape, ShapeKind::Sticky | ShapeKind::Card) { 112.0 } else { 88.0 },
            shape,
            title: title.to_owned(),
            body: body.to_owned(),
            fill,
            stroke: None,
            stroke_style: StrokeStyle::Solid,
            corner_radius: None,
            sticker: None,
            sticker_svg: None,
            badge: None,
            align: crate::engine::whiteboard::model::TextAlign::Center,
        },
    )
}

#[allow(non_snake_case)]
fn Point2_center_with(rect: Rect2, delta: Vec2) -> crate::engine::whiteboard::model::Point2 {
    let c = rect.center();
    crate::engine::whiteboard::model::Point2::new(c.x + delta.x, c.y + delta.y)
}
