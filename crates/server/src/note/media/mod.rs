//! Media generation, transcription, and understanding jobs under `note/`.

mod audio;
pub mod job;
pub mod png;
mod remote;
mod understanding;
pub mod validate;
pub mod vendor;

pub use job::Media;

use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

/// Cooperative cancellation token for blocking or async vendor work (job cancel or shutdown).
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
