use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::Mutex;
use tokio::sync::mpsc;
use vibevalley_protocol::MachineWireFrame;

/// Active outbound WebSocket channel slot shared across event pumps and local `/mcp` proxies.
pub struct TransportSlot {
    active: Mutex<Option<(u64, mpsc::UnboundedSender<MachineWireFrame>)>>,
    generation: AtomicU64,
}

impl Default for TransportSlot {
    fn default() -> Self {
        Self::new()
    }
}

impl TransportSlot {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(None),
            generation: AtomicU64::new(0),
        }
    }

    pub fn install(&self, tx: mpsc::UnboundedSender<MachineWireFrame>) -> u64 {
        let id = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        *self.active.lock() = Some((id, tx));
        id
    }

    pub fn clear_if(&self, id: u64) {
        let mut guard = self.active.lock();
        if guard.as_ref().is_some_and(|(cur, _)| *cur == id) {
            *guard = None;
        }
    }

    pub fn send(&self, frame: MachineWireFrame) -> bool {
        let guard = self.active.lock();
        guard.as_ref().is_some_and(|(_, tx)| tx.send(frame).is_ok())
    }
}
