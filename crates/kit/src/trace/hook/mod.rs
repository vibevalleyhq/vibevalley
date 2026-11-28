//! Lock-free `arc-swap` observer slots and bounded in-memory / JSONL event sinks.

mod observer;

pub use observer::{JsonlSink, MemorySink, Observer, ObserverSlot};
