use std::collections::{BTreeMap, BTreeSet};

use crate::engine::genui::error::GenUiError;
use crate::engine::genui::expr::EvalLimits;
use crate::engine::genui::spec::{GenUiNode, GenUiSpec, PatchOp};
use crate::engine::genui::stream::{GenUiStream, StreamEvent, StreamLimits};
use crate::engine::genui::value::{StateStore, StateValue};

use super::validate::validate_state_value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeLimits {
    pub eval: EvalLimits,
    pub stream: StreamLimits,
    pub max_nodes: usize,
    pub max_tree_depth: usize,
}

impl Default for RuntimeLimits {
    fn default() -> Self {
        Self {
            eval: EvalLimits::default(),
            stream: StreamLimits::default(),
            max_nodes: 2_048,
            max_tree_depth: 64,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct GenUiDoc {
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub root_id: Option<String>,
    pub nodes: BTreeMap<String, GenUiNode>,
    pub generation: u64,
    pub complete: bool,
}

impl GenUiDoc {
    pub fn node(&self, id: &str) -> Option<&GenUiNode> {
        self.nodes.get(id)
    }

    pub fn node_generation(&self, id: &str) -> Option<u64> {
        self.nodes.get(id).map(|n| n.generation)
    }

    pub fn is_complete(&self) -> bool {
        self.complete
    }

    pub fn to_spec(&self, state: &StateStore) -> GenUiSpec {
        GenUiSpec {
            title: self.title.clone(),
            subtitle: self.subtitle.clone(),
            root_id: self.root_id.clone(),
            state: state.entries().clone(),
            nodes: self.nodes.values().cloned().collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatchOutcome {
    pub generation: u64,
    pub dirty_nodes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RuntimeEvent {
    PatchApplied { line: usize, generation: u64, dirty_nodes: Vec<String> },
    Complete { line: usize, generation: u64 },
    Error { line: usize, error: GenUiError },
}

#[derive(Debug, Clone)]
pub struct GenUiRuntime {
    pub(super) doc: GenUiDoc,
    pub(super) state: StateStore,
    pub(super) state_revision: u64,
    pub(super) user_modified_keys: BTreeSet<String>,
    pub(super) node_deps: BTreeMap<String, BTreeSet<String>>,
    pub(super) key_dependents: BTreeMap<String, BTreeSet<String>>,
    pub(super) stream: GenUiStream,
    pub(super) limits: RuntimeLimits,
}

impl Default for GenUiRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl GenUiRuntime {
    pub fn new() -> Self {
        Self::with_limits(RuntimeLimits::default())
    }

    pub fn with_limits(limits: RuntimeLimits) -> Self {
        Self {
            doc: GenUiDoc::default(),
            state: StateStore::new(),
            state_revision: 0,
            user_modified_keys: BTreeSet::new(),
            node_deps: BTreeMap::new(),
            key_dependents: BTreeMap::new(),
            stream: GenUiStream::with_limits(limits.stream),
            limits,
        }
    }

    pub fn from_spec(spec: GenUiSpec) -> Result<Self, GenUiError> {
        Self::from_spec_with_limits(spec, RuntimeLimits::default())
    }

    pub fn from_spec_with_limits(spec: GenUiSpec, limits: RuntimeLimits) -> Result<Self, GenUiError> {
        let mut runtime = Self::with_limits(limits);
        if let Some(title) = spec.title {
            runtime.apply_patch(PatchOp::Title {
                title,
                subtitle: spec.subtitle,
            })?;
        } else {
            runtime.doc.subtitle = spec.subtitle;
        }
        if !spec.state.is_empty() {
            runtime.apply_patch(PatchOp::StateInit {
                state: spec.state,
                overwrite: true,
            })?;
        }
        let explicit_root = spec.root_id;
        for node in spec.nodes {
            let is_root = explicit_root.as_deref() == Some(node.id.as_str());
            runtime.apply_patch(PatchOp::SetNode {
                node: Box::new(node),
                root: is_root,
            })?;
        }
        runtime.apply_patch(PatchOp::Done)?;
        Ok(runtime)
    }

    pub fn doc(&self) -> &GenUiDoc {
        &self.doc
    }

    pub fn state(&self) -> &StateStore {
        &self.state
    }

    pub fn is_complete(&self) -> bool {
        self.doc.complete
    }

    pub fn state_revision(&self) -> u64 {
        self.state_revision
    }

    pub fn node_dependencies(&self, node_id: &str) -> Option<&BTreeSet<String>> {
        self.node_deps.get(node_id)
    }

    pub fn dependent_nodes(&self, key: &str) -> Vec<String> {
        self.key_dependents.get(key).map(|set| set.iter().cloned().collect()).unwrap_or_default()
    }

    pub fn push_chunk(&mut self, delta: &str) -> Vec<RuntimeEvent> {
        let events = self.stream.push_chunk(delta);
        self.ingest_stream_events(events)
    }

    pub fn push_bytes(&mut self, bytes: &[u8]) -> Vec<RuntimeEvent> {
        let events = self.stream.push_bytes(bytes);
        self.ingest_stream_events(events)
    }

    pub fn finish_stream(&mut self) -> Vec<RuntimeEvent> {
        let events = self.stream.finish();
        self.ingest_stream_events(events)
    }

    fn ingest_stream_events(&mut self, events: Vec<StreamEvent>) -> Vec<RuntimeEvent> {
        let mut out = Vec::with_capacity(events.len());
        for event in events {
            match event {
                StreamEvent::Patch { line, op, .. } => match self.apply_patch(op) {
                    Ok(outcome) => out.push(RuntimeEvent::PatchApplied {
                        line,
                        generation: outcome.generation,
                        dirty_nodes: outcome.dirty_nodes,
                    }),
                    Err(error) => out.push(RuntimeEvent::Error { line, error }),
                },
                StreamEvent::Complete { line, .. } => out.push(RuntimeEvent::Complete {
                    line,
                    generation: self.doc.generation,
                }),
                StreamEvent::Error { line, error } => out.push(RuntimeEvent::Error { line, error }),
            }
        }
        out
    }

    pub fn set_state(&mut self, key: impl Into<String>, value: StateValue) -> Result<Vec<String>, GenUiError> {
        validate_state_value(&value)?;
        let key = key.into();
        let changed = self.state.set(key.clone(), value);
        self.user_modified_keys.insert(key.clone());
        if !changed {
            return Ok(Vec::new());
        }
        self.state_revision += 1;
        Ok(self.dependent_nodes(&key))
    }
}
