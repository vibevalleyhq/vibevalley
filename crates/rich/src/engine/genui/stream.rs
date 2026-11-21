use std::collections::BTreeMap;

use crate::engine::genui::error::GenUiError;
use crate::engine::genui::spec::PatchOp;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamLimits {
    pub max_line_bytes: usize,
    pub max_patches: usize,
}

impl Default for StreamLimits {
    fn default() -> Self {
        Self {
            max_line_bytes: 256 * 1024,
            max_patches: 10_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    Patch { line: usize, generation: u64, op: PatchOp },
    Complete { line: usize, generation: u64 },
    Error { line: usize, error: GenUiError },
}

#[derive(Debug, Clone)]
pub struct GenUiStream {
    limits: StreamLimits,
    line_buf: String,
    utf8_pending: Vec<u8>,
    discarding_oversized: bool,
    line_number: usize,
    generation: u64,
    patch_count: usize,
    complete: bool,
    node_generations: BTreeMap<String, u64>,
}

impl Default for GenUiStream {
    fn default() -> Self {
        Self::new()
    }
}

impl GenUiStream {
    pub fn new() -> Self {
        Self::with_limits(StreamLimits::default())
    }

    pub fn with_limits(limits: StreamLimits) -> Self {
        Self {
            limits,
            line_buf: String::new(),
            utf8_pending: Vec::new(),
            discarding_oversized: false,
            line_number: 1,
            generation: 0,
            patch_count: 0,
            complete: false,
            node_generations: BTreeMap::new(),
        }
    }

    pub fn is_complete(&self) -> bool {
        self.complete
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn node_generation(&self, id: &str) -> Option<u64> {
        self.node_generations.get(id).copied()
    }

    pub fn node_generations(&self) -> &BTreeMap<String, u64> {
        &self.node_generations
    }

    pub fn pending_bytes(&self) -> usize {
        self.line_buf.len() + self.utf8_pending.len()
    }

    pub fn push_bytes(&mut self, bytes: &[u8]) -> Vec<StreamEvent> {
        let mut events = Vec::new();
        self.utf8_pending.extend_from_slice(bytes);

        loop {
            match std::str::from_utf8(&self.utf8_pending) {
                Ok(valid) => {
                    let owned = valid.to_owned();
                    self.utf8_pending.clear();
                    if !owned.is_empty() {
                        events.extend(self.push_chunk(&owned));
                    }
                    break;
                }
                Err(err) => {
                    let valid_up_to = err.valid_up_to();
                    if valid_up_to > 0 {
                        let valid_chunk = String::from_utf8(self.utf8_pending.drain(..valid_up_to).collect()).unwrap_or_default();
                        events.extend(self.push_chunk(&valid_chunk));
                    }
                    match err.error_len() {
                        Some(bad_len) => {
                            self.utf8_pending.drain(..bad_len.min(self.utf8_pending.len()));
                            events.push(StreamEvent::Error {
                                line: self.line_number,
                                error: GenUiError::InvalidUtf8,
                            });
                        }
                        None => break,
                    }
                }
            }
        }

        events
    }

    pub fn push_chunk(&mut self, delta: &str) -> Vec<StreamEvent> {
        let mut events = Vec::new();
        let mut rest = delta;

        while !rest.is_empty() {
            if self.discarding_oversized {
                if let Some(nl) = rest.find('\n') {
                    self.discarding_oversized = false;
                    self.line_number += 1;
                    rest = &rest[nl + 1..];
                } else {
                    break;
                }
                continue;
            }

            if let Some(nl) = rest.find('\n') {
                let piece = &rest[..nl];
                let line_len = self.line_buf.len().saturating_add(piece.len());
                if line_len > self.limits.max_line_bytes {
                    let line = self.line_number;
                    self.line_buf.clear();
                    self.line_number += 1;
                    events.push(StreamEvent::Error {
                        line,
                        error: GenUiError::LineTooLong {
                            limit: self.limits.max_line_bytes,
                        },
                    });
                } else {
                    self.line_buf.push_str(piece);
                    let raw = std::mem::take(&mut self.line_buf);
                    let line = self.line_number;
                    self.line_number += 1;
                    self.process_line(&raw, line, &mut events);
                }
                rest = &rest[nl + 1..];
            } else {
                let new_len = self.line_buf.len().saturating_add(rest.len());
                if new_len > self.limits.max_line_bytes {
                    let line = self.line_number;
                    self.line_buf.clear();
                    self.discarding_oversized = true;
                    events.push(StreamEvent::Error {
                        line,
                        error: GenUiError::LineTooLong {
                            limit: self.limits.max_line_bytes,
                        },
                    });
                } else {
                    self.line_buf.push_str(rest);
                }
                break;
            }
        }

        events
    }

    pub fn finish(&mut self) -> Vec<StreamEvent> {
        let mut events = Vec::new();
        if !self.utf8_pending.is_empty() {
            self.utf8_pending.clear();
            events.push(StreamEvent::Error {
                line: self.line_number,
                error: GenUiError::InvalidUtf8,
            });
        }
        if self.discarding_oversized {
            self.discarding_oversized = false;
            self.line_number += 1;
            return events;
        }
        if !self.line_buf.is_empty() {
            let raw = std::mem::take(&mut self.line_buf);
            let line = self.line_number;
            self.line_number += 1;
            self.process_line(&raw, line, &mut events);
        }
        events
    }

    fn process_line(&mut self, raw: &str, line: usize, events: &mut Vec<StreamEvent>) {
        let trimmed = raw.trim().strip_prefix('\u{feff}').unwrap_or(raw.trim());
        if trimmed.is_empty() {
            return;
        }
        if self.complete {
            events.push(StreamEvent::Error {
                line,
                error: GenUiError::StreamAlreadyComplete,
            });
            return;
        }
        if self.patch_count >= self.limits.max_patches {
            events.push(StreamEvent::Error {
                line,
                error: GenUiError::PatchLimitExceeded {
                    limit: self.limits.max_patches,
                },
            });
            return;
        }

        let op: PatchOp = match serde_json::from_str(trimmed) {
            Ok(op) => op,
            Err(err) => {
                events.push(StreamEvent::Error {
                    line,
                    error: GenUiError::InvalidPatchJson { message: err.to_string() },
                });
                return;
            }
        };

        self.patch_count += 1;
        self.generation += 1;
        let generation = self.generation;

        match &op {
            PatchOp::Title { .. } | PatchOp::StateInit { .. } => {}
            PatchOp::SetNode { node, .. } => {
                self.node_generations.insert(node.id.clone(), generation);
            }
            PatchOp::AppendChild { parent_id, child_id, node, .. } => {
                self.node_generations.insert(parent_id.clone(), generation);
                if node.is_some() {
                    self.node_generations.insert(child_id.clone(), generation);
                }
            }
            PatchOp::UpdateProps { id, .. } => {
                self.node_generations.insert(id.clone(), generation);
            }
            PatchOp::RemoveNode { id, .. } => {
                self.node_generations.remove(id);
            }
            PatchOp::Done => {
                self.complete = true;
            }
        }

        let is_done = matches!(op, PatchOp::Done);
        events.push(StreamEvent::Patch { line, generation, op });
        if is_done {
            events.push(StreamEvent::Complete { line, generation });
        }
    }
}
