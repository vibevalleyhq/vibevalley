//! VibeValley's media services. Inputs share the attachment store; deleting
//! an input never deletes bytes that a message or library item still uses.
pub mod inputs;
pub mod validate;

pub mod png;

mod audio;
pub mod jobs;
mod remote;
mod understanding;
pub mod vendor;

use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

/// Tells blocking or async vendor work to give up (a cancel, the farm closing).
#[derive(Clone, Default)]
pub struct Stop(Arc<CancellationToken>);

impl Stop {
    pub fn abort(&self) {
        self.0.cancel();
    }

    pub fn aborted(&self) -> bool {
        self.0.is_cancelled()
    }

    pub(super) fn same_as(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    pub(super) fn token(&self) -> CancellationToken {
        (*self.0).clone()
    }

    /// Waits for `duration`, returning `true` early if aborted.
    pub(super) async fn wait_timeout_async(&self, duration: Duration) -> bool {
        if self.aborted() {
            return true;
        }
        tokio::select! {
            biased;
            _ = self.0.cancelled() => true,
            _ = tokio::time::sleep(duration) => false,
        }
    }
}
