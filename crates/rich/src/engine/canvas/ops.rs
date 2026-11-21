use std::collections::{HashSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::engine::canvas::geometry::{AlignKind, DistributeAxis, Viewport, compute_alignment, compute_distribution};
use crate::engine::canvas::hit::{MarqueeSelection, expand_with_group_contents};
use crate::engine::canvas::model::{BackgroundStyle, Canvas, CanvasColor, CanvasError, Edge, EdgeId, End, Node, NodeBounds, NodeId, NodeKind, Side};
use crate::engine::canvas::validate::{ValidationIssue, is_valid_subpath, is_valid_url, validate_node};

pub const DEFAULT_HISTORY_LIMIT: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "op", content = "value", rename_all = "camelCase")]
pub enum FieldPatch<T> {
    #[default]
    Keep,
    Set(T),
    Clear,
}

impl<T> FieldPatch<T> {
    fn apply(self, target: &mut Option<T>) {
        match self {
            FieldPatch::Keep => {}
            FieldPatch::Set(v) => *target = Some(v),
            FieldPatch::Clear => *target = None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum NodeContentPatch {
    Text {
        text: Option<String>,
    },
    File {
        file: Option<String>,
        #[serde(default)]
        subpath: FieldPatch<String>,
    },
    Link {
        url: Option<String>,
    },
    Group {
        #[serde(default)]
        label: FieldPatch<String>,
        #[serde(default)]
        background: FieldPatch<String>,
        #[serde(default)]
        background_style: FieldPatch<BackgroundStyle>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodePatch {
    pub bounds: Option<NodeBounds>,
    #[serde(default)]
    pub color: FieldPatch<CanvasColor>,
    pub content: Option<NodeContentPatch>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgePatch {
    pub from_node: Option<NodeId>,
    #[serde(default)]
    pub from_side: FieldPatch<Side>,
    #[serde(default)]
    pub from_end: FieldPatch<End>,
    pub to_node: Option<NodeId>,
    #[serde(default)]
    pub to_side: FieldPatch<Side>,
    #[serde(default)]
    pub to_end: FieldPatch<End>,
    #[serde(default)]
    pub color: FieldPatch<CanvasColor>,
    #[serde(default)]
    pub label: FieldPatch<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "mode", content = "index", rename_all = "camelCase")]
pub enum ZOrderTarget {
    Front,
    Back,
    Forward,
    Backward,
    Index(usize),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum CanvasOp {
    AddNode {
        node: Node,
        index: Option<usize>,
    },
    RemoveNode {
        id: NodeId,
    },
    UpdateNode {
        id: NodeId,
        patch: NodePatch,
    },
    MoveNodes {
        ids: Vec<NodeId>,
        dx: i64,
        dy: i64,
        include_group_contents: bool,
    },
    ResizeNode {
        id: NodeId,
        bounds: NodeBounds,
    },
    ReorderNode {
        id: NodeId,
        target: ZOrderTarget,
    },
    AddEdge {
        edge: Edge,
        index: Option<usize>,
    },
    RemoveEdge {
        id: EdgeId,
    },
    UpdateEdge {
        id: EdgeId,
        patch: EdgePatch,
    },
    Batch {
        ops: Vec<CanvasOp>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OpError {
    #[error("node {0:?} not found")]
    NodeNotFound(NodeId),
    #[error("duplicate node id {0:?}")]
    DuplicateNodeId(NodeId),
    #[error("edge {0:?} not found")]
    EdgeNotFound(EdgeId),
    #[error("duplicate edge id {0:?}")]
    DuplicateEdgeId(EdgeId),
    #[error("edge {edge_id:?} references missing node {missing_node:?}")]
    DanglingEdgeNode { edge_id: EdgeId, missing_node: NodeId },
    #[error("node {id:?} has kind {actual:?}, cannot apply patch for {expected:?}")]
    NodeKindMismatch { id: NodeId, actual: NodeKind, expected: NodeKind },
    #[error("index {index} out of bounds for length {len}")]
    IndexOutOfBounds { index: usize, len: usize },
    #[error("invalid node: {0}")]
    InvalidNode(ValidationIssue),
    #[error("invalid edge id: cannot be empty")]
    EmptyEdgeId,
    #[error("invalid color {0:?}")]
    InvalidColor(String),
    #[error("invalid file subpath {0:?}: must start with '#'")]
    InvalidSubpath(String),
    #[error("invalid link url {0:?}")]
    InvalidUrl(String),
    #[error("non-positive dimensions ({width}x{height})")]
    NonPositiveDimensions { width: i64, height: i64 },
    #[error("a transaction is already active")]
    TransactionAlreadyOpen,
    #[error("no active transaction")]
    NoActiveTransaction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AtomicStep {
    InsertNode {
        index: usize,
        node: Node,
    },
    RemoveNode {
        index: usize,
        node: Node,
        /// Removed incident edges stored in ascending index order so re-insertion
        /// in forward order restores exact original indices.
        removed_edges: Vec<(usize, Edge)>,
    },
    ReplaceNode {
        index: usize,
        before: Node,
        after: Node,
    },
    SetPositions {
        before: Vec<(NodeId, i64, i64)>,
        after: Vec<(NodeId, i64, i64)>,
    },
    MoveNodeIndex {
        from: usize,
        to: usize,
    },
    InsertEdge {
        index: usize,
        edge: Edge,
    },
    RemoveEdge {
        index: usize,
        edge: Edge,
    },
    ReplaceEdge {
        index: usize,
        before: Edge,
        after: Edge,
    },
}

impl AtomicStep {
    fn apply_forward(&self, canvas: &mut Canvas) {
        match self {
            AtomicStep::InsertNode { index, node } => {
                canvas.nodes.insert(*index, node.clone());
            }
            AtomicStep::RemoveNode { index, removed_edges, .. } => {
                for (edge_idx, _) in removed_edges.iter().rev() {
                    canvas.edges.remove(*edge_idx);
                }
                canvas.nodes.remove(*index);
            }
            AtomicStep::ReplaceNode { index, after, .. } => {
                canvas.nodes[*index] = after.clone();
            }
            AtomicStep::SetPositions { after, .. } => {
                for (id, x, y) in after {
                    if let Some(node) = canvas.node_mut(id) {
                        let mut b = node.bounds();
                        b.x = *x;
                        b.y = *y;
                        node.set_bounds(b);
                    }
                }
            }
            AtomicStep::MoveNodeIndex { from, to } => {
                let node = canvas.nodes.remove(*from);
                canvas.nodes.insert(*to, node);
            }
            AtomicStep::InsertEdge { index, edge } => {
                canvas.edges.insert(*index, edge.clone());
            }
            AtomicStep::RemoveEdge { index, .. } => {
                canvas.edges.remove(*index);
            }
            AtomicStep::ReplaceEdge { index, after, .. } => {
                canvas.edges[*index] = after.clone();
            }
        }
    }

    fn apply_inverse(&self, canvas: &mut Canvas) {
        match self {
            AtomicStep::InsertNode { index, .. } => {
                canvas.nodes.remove(*index);
            }
            AtomicStep::RemoveNode { index, node, removed_edges } => {
                canvas.nodes.insert(*index, node.clone());
                for (edge_idx, edge) in removed_edges {
                    canvas.edges.insert(*edge_idx, edge.clone());
                }
            }
            AtomicStep::ReplaceNode { index, before, .. } => {
                canvas.nodes[*index] = before.clone();
            }
            AtomicStep::SetPositions { before, .. } => {
                for (id, x, y) in before {
                    if let Some(node) = canvas.node_mut(id) {
                        let mut b = node.bounds();
                        b.x = *x;
                        b.y = *y;
                        node.set_bounds(b);
                    }
                }
            }
            AtomicStep::MoveNodeIndex { from, to } => {
                let node = canvas.nodes.remove(*to);
                canvas.nodes.insert(*from, node);
            }
            AtomicStep::InsertEdge { index, .. } => {
                canvas.edges.remove(*index);
            }
            AtomicStep::RemoveEdge { index, edge } => {
                canvas.edges.insert(*index, edge.clone());
            }
            AtomicStep::ReplaceEdge { index, before, .. } => {
                canvas.edges[*index] = before.clone();
            }
        }
    }
}

fn execute_op(canvas: &mut Canvas, op: CanvasOp, recorded: &mut Vec<AtomicStep>) -> Result<(), OpError> {
    match op {
        CanvasOp::AddNode { node, index } => {
            let mut issues = Vec::new();
            validate_node(&node, index.unwrap_or(canvas.nodes.len()), &mut issues);
            if let Some(first) = issues.into_iter().next() {
                return Err(OpError::InvalidNode(first));
            }
            if canvas.node(node.id()).is_some() {
                return Err(OpError::DuplicateNodeId(node.id().clone()));
            }
            let pos = match index {
                Some(i) if i <= canvas.nodes.len() => i,
                Some(i) => {
                    return Err(OpError::IndexOutOfBounds {
                        index: i,
                        len: canvas.nodes.len(),
                    });
                }
                None => canvas.nodes.len(),
            };
            let step = AtomicStep::InsertNode { index: pos, node };
            step.apply_forward(canvas);
            recorded.push(step);
            Ok(())
        }
        CanvasOp::RemoveNode { id } => {
            let Some(pos) = canvas.node_index(&id) else {
                return Err(OpError::NodeNotFound(id));
            };
            let node = canvas.nodes[pos].clone();
            let removed_edges: Vec<(usize, Edge)> = canvas
                .edges
                .iter()
                .enumerate()
                .filter(|(_, e)| e.from_node == id || e.to_node == id)
                .map(|(i, e)| (i, e.clone()))
                .collect();
            let step = AtomicStep::RemoveNode {
                index: pos,
                node,
                removed_edges,
            };
            step.apply_forward(canvas);
            recorded.push(step);
            Ok(())
        }
        CanvasOp::UpdateNode { id, patch } => {
            let Some(pos) = canvas.node_index(&id) else {
                return Err(OpError::NodeNotFound(id));
            };
            let before = canvas.nodes[pos].clone();
            let mut after = before.clone();

            if let Some(bounds) = patch.bounds {
                if !bounds.is_positive() {
                    return Err(OpError::NonPositiveDimensions {
                        width: bounds.width,
                        height: bounds.height,
                    });
                }
                after.set_bounds(bounds);
            }

            match patch.color {
                FieldPatch::Keep => {}
                FieldPatch::Set(c) => {
                    if !c.is_valid() {
                        return Err(OpError::InvalidColor(c.as_str().to_owned()));
                    }
                    after.set_color(Some(c));
                }
                FieldPatch::Clear => after.set_color(None),
            }

            if let Some(content_patch) = patch.content {
                apply_content_patch(&mut after, content_patch)?;
            }

            if after == before {
                return Ok(());
            }
            let step = AtomicStep::ReplaceNode { index: pos, before, after };
            step.apply_forward(canvas);
            recorded.push(step);
            Ok(())
        }
        CanvasOp::MoveNodes {
            ids,
            dx,
            dy,
            include_group_contents,
        } => {
            for id in &ids {
                if canvas.node(id).is_none() {
                    return Err(OpError::NodeNotFound(id.clone()));
                }
            }
            if ids.is_empty() || (dx == 0 && dy == 0) {
                return Ok(());
            }
            let target_ids = if include_group_contents {
                expand_with_group_contents(canvas, &ids)
            } else {
                let mut seen = HashSet::new();
                ids.into_iter().filter(|id| seen.insert(id.clone())).collect()
            };
            let mut before = Vec::with_capacity(target_ids.len());
            let mut after = Vec::with_capacity(target_ids.len());
            for id in target_ids {
                if let Some(node) = canvas.node(&id) {
                    let old_x = node.x();
                    let old_y = node.y();
                    let new_x = old_x.saturating_add(dx);
                    let new_y = old_y.saturating_add(dy);
                    before.push((id.clone(), old_x, old_y));
                    after.push((id, new_x, new_y));
                }
            }
            if before == after {
                return Ok(());
            }
            let step = AtomicStep::SetPositions { before, after };
            step.apply_forward(canvas);
            recorded.push(step);
            Ok(())
        }
        CanvasOp::ResizeNode { id, bounds } => {
            let Some(pos) = canvas.node_index(&id) else {
                return Err(OpError::NodeNotFound(id));
            };
            if !bounds.is_positive() {
                return Err(OpError::NonPositiveDimensions {
                    width: bounds.width,
                    height: bounds.height,
                });
            }
            let before = canvas.nodes[pos].clone();
            if before.bounds() == bounds {
                return Ok(());
            }
            let mut after = before.clone();
            after.set_bounds(bounds);
            let step = AtomicStep::ReplaceNode { index: pos, before, after };
            step.apply_forward(canvas);
            recorded.push(step);
            Ok(())
        }
        CanvasOp::ReorderNode { id, target } => {
            let Some(from) = canvas.node_index(&id) else {
                return Err(OpError::NodeNotFound(id));
            };
            let len = canvas.nodes.len();
            let to = match target {
                ZOrderTarget::Front => len - 1,
                ZOrderTarget::Back => 0,
                ZOrderTarget::Forward => (from + 1).min(len - 1),
                ZOrderTarget::Backward => from.saturating_sub(1),
                ZOrderTarget::Index(idx) => {
                    if idx >= len {
                        return Err(OpError::IndexOutOfBounds { index: idx, len });
                    }
                    idx
                }
            };
            if from == to {
                return Ok(());
            }
            let step = AtomicStep::MoveNodeIndex { from, to };
            step.apply_forward(canvas);
            recorded.push(step);
            Ok(())
        }
        CanvasOp::AddEdge { edge, index } => {
            if edge.id.is_empty() {
                return Err(OpError::EmptyEdgeId);
            }
            if canvas.edge(&edge.id).is_some() {
                return Err(OpError::DuplicateEdgeId(edge.id));
            }
            if canvas.node(&edge.from_node).is_none() {
                return Err(OpError::DanglingEdgeNode {
                    edge_id: edge.id,
                    missing_node: edge.from_node,
                });
            }
            if canvas.node(&edge.to_node).is_none() {
                return Err(OpError::DanglingEdgeNode {
                    edge_id: edge.id,
                    missing_node: edge.to_node,
                });
            }
            if let Some(color) = &edge.color
                && !color.is_valid()
            {
                return Err(OpError::InvalidColor(color.as_str().to_owned()));
            }
            let pos = match index {
                Some(i) if i <= canvas.edges.len() => i,
                Some(i) => {
                    return Err(OpError::IndexOutOfBounds {
                        index: i,
                        len: canvas.edges.len(),
                    });
                }
                None => canvas.edges.len(),
            };
            let step = AtomicStep::InsertEdge { index: pos, edge };
            step.apply_forward(canvas);
            recorded.push(step);
            Ok(())
        }
        CanvasOp::RemoveEdge { id } => {
            let Some(pos) = canvas.edge_index(&id) else {
                return Err(OpError::EdgeNotFound(id));
            };
            let edge = canvas.edges[pos].clone();
            let step = AtomicStep::RemoveEdge { index: pos, edge };
            step.apply_forward(canvas);
            recorded.push(step);
            Ok(())
        }
        CanvasOp::UpdateEdge { id, patch } => {
            let Some(pos) = canvas.edge_index(&id) else {
                return Err(OpError::EdgeNotFound(id));
            };
            let before = canvas.edges[pos].clone();
            let mut after = before.clone();

            if let Some(from_node) = patch.from_node {
                if canvas.node(&from_node).is_none() {
                    return Err(OpError::DanglingEdgeNode {
                        edge_id: id,
                        missing_node: from_node,
                    });
                }
                after.from_node = from_node;
            }
            if let Some(to_node) = patch.to_node {
                if canvas.node(&to_node).is_none() {
                    return Err(OpError::DanglingEdgeNode {
                        edge_id: id,
                        missing_node: to_node,
                    });
                }
                after.to_node = to_node;
            }
            patch.from_side.apply(&mut after.from_side);
            patch.from_end.apply(&mut after.from_end);
            patch.to_side.apply(&mut after.to_side);
            patch.to_end.apply(&mut after.to_end);
            if let FieldPatch::Set(ref c) = patch.color
                && !c.is_valid()
            {
                return Err(OpError::InvalidColor(c.as_str().to_owned()));
            }
            patch.color.apply(&mut after.color);
            patch.label.apply(&mut after.label);

            if after == before {
                return Ok(());
            }
            let step = AtomicStep::ReplaceEdge { index: pos, before, after };
            step.apply_forward(canvas);
            recorded.push(step);
            Ok(())
        }
        CanvasOp::Batch { ops } => {
            let checkpoint = recorded.len();
            for sub in ops {
                if let Err(err) = execute_op(canvas, sub, recorded) {
                    while recorded.len() > checkpoint {
                        if let Some(step) = recorded.pop() {
                            step.apply_inverse(canvas);
                        }
                    }
                    return Err(err);
                }
            }
            Ok(())
        }
    }
}

fn apply_content_patch(node: &mut Node, patch: NodeContentPatch) -> Result<(), OpError> {
    let actual = node.kind();
    let id = node.id().clone();
    match (node, patch) {
        (Node::Text(n), NodeContentPatch::Text { text }) => {
            if let Some(text) = text {
                n.text = text;
            }
            Ok(())
        }
        (Node::File(n), NodeContentPatch::File { file, subpath }) => {
            if let Some(file) = file {
                if file.is_empty() {
                    return Err(OpError::InvalidNode(ValidationIssue::EmptyFilePath { id }));
                }
                n.file = file;
            }
            if let FieldPatch::Set(ref s) = subpath
                && !is_valid_subpath(s)
            {
                return Err(OpError::InvalidSubpath(s.clone()));
            }
            subpath.apply(&mut n.subpath);
            Ok(())
        }
        (Node::Link(n), NodeContentPatch::Link { url }) => {
            if let Some(url) = url {
                if !is_valid_url(&url) {
                    return Err(OpError::InvalidUrl(url));
                }
                n.url = url;
            }
            Ok(())
        }
        (
            Node::Group(n),
            NodeContentPatch::Group {
                label,
                background,
                background_style,
            },
        ) => {
            if let FieldPatch::Set(ref bg) = background
                && bg.is_empty()
            {
                return Err(OpError::InvalidNode(ValidationIssue::EmptyGroupBackground { id }));
            }
            label.apply(&mut n.label);
            background.apply(&mut n.background);
            background_style.apply(&mut n.background_style);
            Ok(())
        }
        (_, NodeContentPatch::Text { .. }) => Err(OpError::NodeKindMismatch {
            id,
            actual,
            expected: NodeKind::Text,
        }),
        (_, NodeContentPatch::File { .. }) => Err(OpError::NodeKindMismatch {
            id,
            actual,
            expected: NodeKind::File,
        }),
        (_, NodeContentPatch::Link { .. }) => Err(OpError::NodeKindMismatch {
            id,
            actual,
            expected: NodeKind::Link,
        }),
        (_, NodeContentPatch::Group { .. }) => Err(OpError::NodeKindMismatch {
            id,
            actual,
            expected: NodeKind::Group,
        }),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SelectionState {
    pub nodes: HashSet<NodeId>,
    pub edges: HashSet<EdgeId>,
}

impl SelectionState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty() && self.edges.is_empty()
    }

    pub fn clear(&mut self) {
        self.nodes.clear();
        self.edges.clear();
    }

    pub fn select_only_node(&mut self, id: NodeId) {
        self.clear();
        self.nodes.insert(id);
    }

    pub fn toggle_node(&mut self, id: NodeId) {
        if !self.nodes.remove(&id) {
            self.nodes.insert(id);
        }
    }

    pub fn select_only_edge(&mut self, id: EdgeId) {
        self.clear();
        self.edges.insert(id);
    }

    pub fn toggle_edge(&mut self, id: EdgeId) {
        if !self.edges.remove(&id) {
            self.edges.insert(id);
        }
    }

    pub fn apply_marquee(&mut self, marquee: MarqueeSelection, additive: bool) {
        if !additive {
            self.clear();
        }
        self.nodes.extend(marquee.nodes);
        self.edges.extend(marquee.edges);
    }

    pub fn prune(&mut self, canvas: &Canvas) {
        self.nodes.retain(|id| canvas.node(id).is_some());
        self.edges.retain(|id| canvas.edge(id).is_some());
    }
}

#[derive(Debug, Clone)]
struct HistoryEntry {
    steps: Vec<AtomicStep>,
}

/// Interactive canvas state combining the JSON Canvas document, viewport camera,
/// selection, transactional drag grouping, and bounded undo/redo history.
#[derive(Debug, Clone)]
pub struct CanvasDocument {
    canvas: Canvas,
    pub viewport: Viewport,
    pub selection: SelectionState,
    undo_stack: VecDeque<HistoryEntry>,
    redo_stack: Vec<HistoryEntry>,
    active_transaction: Option<Vec<AtomicStep>>,
    history_limit: usize,
    revision: u64,
}

impl Default for CanvasDocument {
    fn default() -> Self {
        Self::new(Canvas::new())
    }
}

impl CanvasDocument {
    pub fn new(canvas: Canvas) -> Self {
        Self {
            canvas,
            viewport: Viewport::default(),
            selection: SelectionState::new(),
            undo_stack: VecDeque::new(),
            redo_stack: Vec::new(),
            active_transaction: None,
            history_limit: DEFAULT_HISTORY_LIMIT,
            revision: 0,
        }
    }

    pub fn from_json_str(input: &str) -> Result<Self, CanvasError> {
        Ok(Self::new(Canvas::from_json_str(input)?))
    }

    pub fn canvas(&self) -> &Canvas {
        &self.canvas
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn to_json_string(&self) -> Result<String, CanvasError> {
        self.canvas.to_json_string()
    }

    pub fn to_json_string_pretty(&self) -> Result<String, CanvasError> {
        self.canvas.to_json_string_pretty()
    }

    pub fn set_history_limit(&mut self, limit: usize) {
        self.history_limit = limit;
        while self.undo_stack.len() > self.history_limit {
            self.undo_stack.pop_front();
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty() && self.active_transaction.is_none()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty() && self.active_transaction.is_none()
    }

    pub fn undo_len(&self) -> usize {
        self.undo_stack.len()
    }

    pub fn redo_len(&self) -> usize {
        self.redo_stack.len()
    }

    pub fn clear_history(&mut self) {
        self.undo_stack.clear();
        self.redo_stack.clear();
    }

    pub fn has_active_transaction(&self) -> bool {
        self.active_transaction.is_some()
    }

    /// Starts grouping subsequent [`CanvasDocument::apply`] calls into a single
    /// undo entry (for example during an interactive node drag or resize).
    pub fn begin_transaction(&mut self) -> Result<(), OpError> {
        if self.active_transaction.is_some() {
            return Err(OpError::TransactionAlreadyOpen);
        }
        self.active_transaction = Some(Vec::new());
        Ok(())
    }

    /// Commits the open transaction into one undo entry. Returns `true` if any change was recorded.
    pub fn commit_transaction(&mut self) -> Result<bool, OpError> {
        let Some(steps) = self.active_transaction.take() else {
            return Err(OpError::NoActiveTransaction);
        };
        if steps.is_empty() {
            return Ok(false);
        }
        self.push_history(HistoryEntry { steps });
        Ok(true)
    }

    /// Reverts all mutations made since [`CanvasDocument::begin_transaction`].
    pub fn cancel_transaction(&mut self) -> Result<(), OpError> {
        let Some(steps) = self.active_transaction.take() else {
            return Err(OpError::NoActiveTransaction);
        };
        if !steps.is_empty() {
            for step in steps.iter().rev() {
                step.apply_inverse(&mut self.canvas);
            }
            self.selection.prune(&self.canvas);
            self.revision = self.revision.saturating_add(1);
        }
        Ok(())
    }

    /// Applies an operation atomically. Returns `Ok(true)` when canvas state changed
    /// and `Ok(false)` for a valid no-op.
    pub fn apply(&mut self, op: CanvasOp) -> Result<bool, OpError> {
        let mut steps = Vec::new();
        execute_op(&mut self.canvas, op, &mut steps)?;
        if steps.is_empty() {
            return Ok(false);
        }

        self.selection.prune(&self.canvas);
        self.revision = self.revision.saturating_add(1);

        if let Some(tx) = &mut self.active_transaction {
            tx.extend(steps);
        } else {
            self.push_history(HistoryEntry { steps });
        }
        Ok(true)
    }

    fn push_history(&mut self, entry: HistoryEntry) {
        self.redo_stack.clear();
        if self.history_limit == 0 {
            return;
        }
        if self.undo_stack.len() >= self.history_limit {
            self.undo_stack.pop_front();
        }
        self.undo_stack.push_back(entry);
    }

    pub fn undo(&mut self) -> bool {
        if self.active_transaction.is_some() {
            return false;
        }
        let Some(entry) = self.undo_stack.pop_back() else {
            return false;
        };
        for step in entry.steps.iter().rev() {
            step.apply_inverse(&mut self.canvas);
        }
        self.selection.prune(&self.canvas);
        self.redo_stack.push(entry);
        self.revision = self.revision.saturating_add(1);
        true
    }

    pub fn redo(&mut self) -> bool {
        if self.active_transaction.is_some() {
            return false;
        }
        let Some(entry) = self.redo_stack.pop() else {
            return false;
        };
        for step in &entry.steps {
            step.apply_forward(&mut self.canvas);
        }
        self.selection.prune(&self.canvas);
        self.undo_stack.push_back(entry);
        self.revision = self.revision.saturating_add(1);
        true
    }

    pub fn align_selected(&mut self, align: AlignKind) -> Result<bool, OpError> {
        let ids: Vec<NodeId> = self
            .canvas
            .nodes
            .iter()
            .filter(|n| self.selection.nodes.contains(n.id()))
            .map(|n| n.id().clone())
            .collect();
        let moves = compute_alignment(&self.canvas, &ids, align);
        self.apply_position_targets(moves)
    }

    pub fn distribute_selected(&mut self, axis: DistributeAxis) -> Result<bool, OpError> {
        let ids: Vec<NodeId> = self
            .canvas
            .nodes
            .iter()
            .filter(|n| self.selection.nodes.contains(n.id()))
            .map(|n| n.id().clone())
            .collect();
        let moves = compute_distribution(&self.canvas, &ids, axis);
        self.apply_position_targets(moves)
    }

    fn apply_position_targets(&mut self, targets: Vec<(NodeId, i64, i64)>) -> Result<bool, OpError> {
        if targets.is_empty() {
            return Ok(false);
        }
        let ops: Vec<CanvasOp> = targets
            .into_iter()
            .filter_map(|(id, x, y)| {
                let node = self.canvas.node(&id)?;
                Some(CanvasOp::MoveNodes {
                    ids: vec![id],
                    dx: x - node.x(),
                    dy: y - node.y(),
                    include_group_contents: false,
                })
            })
            .collect();
        self.apply(CanvasOp::Batch { ops })
    }

    pub fn delete_selection(&mut self) -> Result<bool, OpError> {
        if self.selection.is_empty() {
            return Ok(false);
        }
        let mut ops = Vec::new();
        // Remove standalone selected edges first so removing nodes does not fail on already-deleted edges.
        let selected_nodes = &self.selection.nodes;
        for edge in &self.canvas.edges {
            if self.selection.edges.contains(&edge.id) && !selected_nodes.contains(&edge.from_node) && !selected_nodes.contains(&edge.to_node) {
                ops.push(CanvasOp::RemoveEdge { id: edge.id.clone() });
            }
        }
        for node in &self.canvas.nodes {
            if selected_nodes.contains(node.id()) {
                ops.push(CanvasOp::RemoveNode { id: node.id().clone() });
            }
        }
        let changed = self.apply(CanvasOp::Batch { ops })?;
        self.selection.clear();
        Ok(changed)
    }
}
