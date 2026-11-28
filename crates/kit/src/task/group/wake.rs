use tokio::sync::watch;

/// Monotonic host wake-signal broadcaster backed by `tokio::sync::watch<u64>`.
pub struct WakeSignal {
    tx: watch::Sender<u64>,
}

impl Default for WakeSignal {
    fn default() -> Self {
        Self::new()
    }
}

impl WakeSignal {
    pub fn new() -> Self {
        let (tx, _) = watch::channel(0u64);
        Self { tx }
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.tx.subscribe()
    }

    pub fn notify(&self) -> u64 {
        let mut next = 0u64;
        self.tx.send_modify(|count| {
            *count += 1;
            next = *count;
        });
        tracing::info!(wake_seq = next, "task.system_wake");
        next
    }

    pub fn count(&self) -> u64 {
        *self.tx.borrow()
    }
}
