use std::path::{Path, PathBuf};
use std::time::Duration;

use vibevalley_protocol::{ApiError, Outcome};
use vibevalley_runtime::oar::PermissionMode;

use crate::service::DbError;

/// Errors returned by [`super::Runtime`].
#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error("durable: {0}")]
    Durable(#[from] vibevalley_runtime::agent::durable::Error),
    #[error("agent: {0}")]
    Agent(#[from] vibevalley_runtime::oar::AgentError),
    #[error("store: {0}")]
    Store(#[from] DbError),
    #[error("{0}")]
    Other(String),
    /// A refusal already worded for the endpoint (from a [`super::SessionDriver`]).
    #[error("{}", .0.message)]
    Api(ApiError),
}

pub type Result<T> = std::result::Result<T, RuntimeError>;

/// Configuration for the execution runtime and concurrency limits.
#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    /// Sessions working at once in the whole workspace.
    pub space_limit: usize,
    /// Sessions working at once per repository (0: no limit of its own).
    pub per_repo: usize,
    /// Where agent records, reports and runtime scratch data go.
    pub data_dir: PathBuf,
    /// What agents may do without asking. The workflow runs unattended, so
    /// the default does not ask.
    pub permission: PermissionMode,
    pub model: Option<String>,
    /// A working session with no event for this long is quiet.
    pub quiet_after: Duration,
    /// Where repos live by name (`<work root>/repos`).
    pub repos_dir: Option<PathBuf>,
    /// Shared repository manager for resolving mounted external repos and symlinks.
    pub repo: Option<std::sync::Arc<crate::repo::Repo>>,
}

impl RuntimeConfig {
    pub fn under(dir: &Path) -> RuntimeConfig {
        RuntimeConfig {
            space_limit: 6,
            per_repo: 3,
            data_dir: dir.join("issues"),
            permission: PermissionMode::Bypass,
            model: None,
            quiet_after: Duration::from_secs(240),
            repos_dir: None,
            repo: None,
        }
    }

    /// Next to the store.
    pub fn beside(store_path: &Path) -> RuntimeConfig {
        RuntimeConfig::under(store_path.parent().unwrap_or(Path::new(".")))
    }
}

pub(crate) fn io(e: std::io::Error) -> RuntimeError {
    RuntimeError::Other(e.to_string())
}

/// What a session's work log is told.
#[derive(Debug, Clone)]
pub enum Step {
    /// A round starts (`runStarted`).
    RunStarted { run: String },
    /// The round ends with `outcome` (`runEnded`).
    RunEnded { run: String, outcome: Outcome },
    /// Words sent to the agent (`asked`).
    Asked { text: String },
    /// What the agent did.
    Agent(vibevalley_runtime::oar::Event),
}

/// What opening found that callers (e.g. `issue::Board`) must still settle.
#[derive(Default)]
pub struct Opened {
    /// Sessions and their interrupted runs for the work log.
    pub interrupted: Vec<(String, String)>,
    pub recoverable: Vec<String>,
    /// Drafting sessions cut short.
    pub drafts: Vec<String>,
}
