use super::{Op, Snapshot};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug)]
pub struct PendingOps {
    limit: usize,
    ops: Vec<Op>,
    prefixes: HashMap<Vec<String>, usize>,
    overflow: bool,
}

impl PendingOps {
    pub fn new(limit: usize) -> Self {
        Self {
            limit: if limit == 0 { 10_000 } else { limit },
            ops: Vec::new(),
            prefixes: HashMap::new(),
            overflow: false,
        }
    }

    pub fn clear(&mut self) {
        self.ops.clear();
        self.prefixes.clear();
        self.overflow = false;
    }

    pub fn push(&mut self, ops: &[Op]) {
        if self.overflow {
            return;
        }
        for op in ops {
            self.coalesce(op);
            if self.ops.len() > self.limit {
                self.ops.clear();
                self.prefixes.clear();
                self.overflow = true;
                break;
            }
        }
    }

    fn coalesce(&mut self, op: &Op) {
        let path = op.path();
        if matches!(op, Op::AppendText(_, s) if s.is_empty()) {
            return;
        }
        if self.prefixes.contains_key(path) {
            match op {
                Op::AppendText(_, suffix) => {
                    if let Some(previous) = self.ops.iter_mut().rev().find(|p| p.path().starts_with(path) || path.starts_with(p.path()))
                        && previous.path() == path
                        && let Op::AppendText(_, text) | Op::Replace(_, Value::String(text)) = previous
                    {
                        text.push_str(suffix);
                        return;
                    }
                }
                Op::Replace(..) | Op::Delete(_) => {
                    let start = self
                        .ops
                        .iter()
                        .rposition(|p| matches!(p, Op::Splice(a, ..) if a.len() < path.len() && path.starts_with(a)))
                        .map_or(0, |i| i + 1);
                    let prefixes = &mut self.prefixes;
                    let mut i = 0;
                    self.ops.retain(|p| {
                        let prune = i >= start && p.path().starts_with(path);
                        i += 1;
                        if prune {
                            for n in 0..=p.path().len() {
                                let prefix = &p.path()[..n];
                                let count = prefixes.get_mut(prefix).expect("queued path is indexed");
                                *count -= 1;
                                if *count == 0 {
                                    prefixes.remove(prefix);
                                }
                            }
                        }
                        !prune
                    });
                }
                Op::Splice(..) => {}
            }
        }
        for n in 0..=path.len() {
            *self.prefixes.entry(path[..n].to_vec()).or_default() += 1;
        }
        self.ops.push(op.clone());
    }

    pub fn drain(&mut self, latest: &Snapshot) -> (Vec<Op>, bool) {
        self.prefixes.clear();
        if std::mem::take(&mut self.overflow) {
            (vec![Op::Replace(vec![], serde_json::json!(latest))], true)
        } else {
            (std::mem::take(&mut self.ops), false)
        }
    }
}
