use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex, Weak};

use crate::transport::chord::delta::{Draft, Error, Op, PendingOps, Snapshot};

#[derive(Clone, Debug)]
pub struct Event {
    pub rev: i64,
    pub snapshot: Snapshot,
    pub ops: Vec<Op>,
    pub retired: bool,
    pub overflow: bool,
}

struct Delivery {
    rev: i64,
    snapshot: Snapshot,
    pending: PendingOps,
    retired: bool,
    ready: flume::Sender<()>,
}

impl Delivery {
    fn update(&mut self, rev: i64, snapshot: &Snapshot, ops: &[Op], retired: bool) {
        self.rev = rev;
        self.snapshot = snapshot.clone();
        if retired {
            self.pending.clear();
        } else {
            self.pending.push(ops);
        }
        self.retired = retired;
        let _ = self.ready.try_send(());
    }

    fn take(&mut self) -> Event {
        let (ops, overflow) = self.pending.drain(&self.snapshot);
        Event {
            rev: self.rev,
            snapshot: self.snapshot.clone(),
            ops,
            retired: self.retired,
            overflow,
        }
    }
}

struct State {
    rev: i64,
    snapshot: Snapshot,
    retired: bool,
    history: VecDeque<(i64, Vec<Op>)>,
    history_size: usize,
    limit: usize,
    watchers: BTreeMap<u64, Delivery>,
    next_id: u64,
}

impl State {
    fn commit(&mut self, next: Snapshot, ops: Vec<Op>) -> i64 {
        self.rev += 1;
        self.retired = false;
        self.snapshot = next;
        for watcher in self.watchers.values_mut() {
            watcher.update(self.rev, &self.snapshot, &ops, false);
        }
        if self.history_size > 0 {
            if self.history.len() == self.history_size {
                self.history.pop_front();
            }
            self.history.push_back((self.rev, ops));
        }
        self.rev
    }
}

#[derive(Clone)]
pub struct Document(Arc<Mutex<State>>);

impl Document {
    pub fn new(snapshot: Snapshot) -> Self {
        Self::with_limits(snapshot, 1024, 10_000)
    }

    pub fn with_limits(snapshot: Snapshot, history_size: usize, limit: usize) -> Self {
        Self(Arc::new(Mutex::new(State {
            rev: 1,
            snapshot,
            retired: false,
            history: VecDeque::new(),
            history_size,
            limit,
            watchers: BTreeMap::new(),
            next_id: 0,
        })))
    }

    pub fn state(&self) -> (i64, Snapshot, bool) {
        let state = self.0.lock().unwrap();
        (state.rev, state.snapshot.clone(), state.retired)
    }

    pub fn mutate(&self, edit: impl FnOnce(&mut Draft) -> Result<(), Error>) -> Result<i64, Error> {
        let mut state = self.0.lock().unwrap();
        let mut draft = state.snapshot.draft();
        edit(&mut draft)?;
        let (snapshot, ops) = draft.commit();
        if ops.is_empty() && !state.retired {
            return Ok(state.rev);
        }
        Ok(state.commit(snapshot, ops))
    }

    pub fn commit(&self, snapshot: Snapshot, mut ops: Vec<Op>) -> i64 {
        if ops.is_empty() {
            ops.push(Op::Replace(vec![], serde_json::json!(snapshot)));
        }
        self.0.lock().unwrap().commit(snapshot, ops)
    }

    pub fn rebuild(&self, snapshot: Snapshot) -> i64 {
        let ops = vec![Op::Replace(vec![], serde_json::json!(snapshot))];
        let mut state = self.0.lock().unwrap();
        for watcher in state.watchers.values_mut() {
            watcher.pending.clear();
        }
        state.commit(snapshot, ops)
    }

    pub fn retire(&self) -> i64 {
        let mut state = self.0.lock().unwrap();
        if !state.retired {
            state.retired = true;
            let rev = state.rev;
            let snapshot = state.snapshot.clone();
            for watcher in state.watchers.values_mut() {
                watcher.update(rev, &snapshot, &[], true);
            }
        }
        state.rev
    }

    pub fn watch(&self, from_rev: i64) -> Subscription {
        let (ready, rx) = flume::bounded(1);
        let mut state = self.0.lock().unwrap();
        let mut watcher = Delivery {
            rev: state.rev,
            snapshot: state.snapshot.clone(),
            pending: PendingOps::new(state.limit),
            retired: state.retired,
            ready,
        };
        if state.retired {
            watcher.update(state.rev, &state.snapshot, &[], true);
        } else if from_rev != state.rev {
            let replay = from_rev < state.rev && state.history.front().is_some_and(|(first, _)| from_rev >= first - 1);
            let ops = if replay {
                for (_, ops) in state.history.iter().filter(|(rev, _)| *rev > from_rev) {
                    watcher.pending.push(ops);
                }
                watcher.pending.drain(&state.snapshot).0
            } else {
                Vec::new()
            };
            let initial = if ops.is_empty() {
                vec![Op::Replace(vec![], serde_json::json!(state.snapshot))]
            } else {
                ops
            };
            watcher.update(state.rev, &state.snapshot, &initial, false);
        }
        let id = state.next_id;
        state.next_id += 1;
        state.watchers.insert(id, watcher);
        Subscription {
            id,
            state: Arc::downgrade(&self.0),
            ready: rx,
        }
    }
}

pub struct Subscription {
    id: u64,
    state: Weak<Mutex<State>>,
    ready: flume::Receiver<()>,
}

impl Subscription {
    pub fn recv(&mut self) -> Option<Event> {
        self.ready.recv().ok()?;
        self.take()
    }

    pub async fn recv_async(&mut self) -> Option<Event> {
        self.ready.recv_async().await.ok()?;
        self.take()
    }

    fn take(&self) -> Option<Event> {
        let state = self.state.upgrade()?;
        let mut state = state.lock().unwrap();
        // A concurrent commit can signal again between receiving and taking the mailbox.
        let _ = self.ready.try_recv();
        Some(state.watchers.get_mut(&self.id)?.take())
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(state) = self.state.upgrade() {
            state.lock().unwrap().watchers.remove(&self.id);
        }
    }
}
