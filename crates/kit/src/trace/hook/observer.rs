use std::collections::VecDeque;
use std::io::Write;
use std::num::NonZeroUsize;
use std::sync::Arc;

use arc_swap::ArcSwapOption;
use parking_lot::Mutex;
use serde::Serialize;

/// Generic synchronous telemetry observer interface.
pub trait Observer<E: ?Sized>: Send + Sync {
    fn observe(&self, event: &E);
}

struct Holder<T: ?Sized>(Arc<T>);

/// Zero-overhead lock-free observer slot backed by [`ArcSwapOption`].
///
/// Works with both sized observers and trait objects (`dyn MyObserver`),
/// and can be placed in a `static` via [`ObserverSlot::const_empty`].
pub struct ObserverSlot<T: Send + Sync + ?Sized + 'static> {
    slot: ArcSwapOption<Holder<T>>,
}

impl<T: Send + Sync + ?Sized + 'static> Default for ObserverSlot<T> {
    fn default() -> Self {
        Self::const_empty()
    }
}

impl<T: Send + Sync + ?Sized + 'static> ObserverSlot<T> {
    pub const fn const_empty() -> Self {
        Self {
            slot: ArcSwapOption::const_empty(),
        }
    }

    pub fn set(&self, observer: Option<Arc<T>>) {
        self.slot.store(observer.map(|obs| Arc::new(Holder(obs))));
    }

    pub fn get(&self) -> Option<Arc<T>> {
        self.slot.load_full().map(|holder| Arc::clone(&holder.0))
    }

    pub fn is_set(&self) -> bool {
        self.slot.load().is_some()
    }

    pub fn notify(&self, f: impl FnOnce(&T)) {
        if let Some(holder) = self.slot.load_full() {
            f(&holder.0);
        }
    }
}

/// Bounded in-memory ring sink for tests and local telemetry inspection.
pub struct MemorySink<E> {
    capacity: usize,
    events: Mutex<VecDeque<E>>,
}

impl<E> MemorySink<E> {
    pub fn new(capacity: NonZeroUsize) -> Self {
        Self {
            capacity: capacity.get(),
            events: Mutex::new(VecDeque::with_capacity(capacity.get().min(256))),
        }
    }

    pub fn push(&self, event: E) {
        let mut events = self.events.lock();
        if events.len() >= self.capacity {
            events.pop_front();
        }
        events.push_back(event);
    }

    pub fn len(&self) -> usize {
        self.events.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn clear(&self) {
        self.events.lock().clear();
    }
}

impl<E: Clone> MemorySink<E> {
    pub fn snapshot(&self) -> Vec<E> {
        self.events.lock().iter().cloned().collect()
    }
}

impl<E: Clone + Send + Sync> Observer<E> for MemorySink<E> {
    fn observe(&self, event: &E) {
        self.push(event.clone());
    }
}

/// Thread-safe JSONL event sink writing one serialized JSON line per observed event.
pub struct JsonlSink<W: Write + Send> {
    writer: Mutex<W>,
}

impl<W: Write + Send> JsonlSink<W> {
    pub fn new(writer: W) -> Self {
        Self { writer: Mutex::new(writer) }
    }

    pub fn write_event<E: Serialize>(&self, event: &E) -> std::io::Result<()> {
        let line = serde_json::to_string(event).map_err(std::io::Error::other)?;
        let mut guard = self.writer.lock();
        guard.write_all(line.as_bytes())?;
        guard.write_all(b"\n")?;
        guard.flush()
    }

    pub fn into_inner(self) -> W {
        self.writer.into_inner()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observer_slot_and_sinks_work_cleanly() {
        let slot: ObserverSlot<dyn Observer<u32>> = ObserverSlot::const_empty();
        assert!(!slot.is_set());

        let sink = Arc::new(MemorySink::<u32>::new(NonZeroUsize::new(2).unwrap()));
        slot.set(Some(sink.clone()));
        assert!(slot.is_set());

        for n in 1..=3 {
            slot.notify(|obs| obs.observe(&n));
        }
        assert_eq!(sink.snapshot(), vec![2, 3]);

        slot.set(None);
        assert!(!slot.is_set());

        let jsonl = JsonlSink::new(Vec::<u8>::new());
        jsonl.write_event(&serde_json::json!({"ok": true})).unwrap();
        let text = String::from_utf8(jsonl.into_inner()).unwrap();
        assert_eq!(text, "{\"ok\":true}\n");
    }
}
