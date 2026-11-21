use std::path::{Path, PathBuf};
use std::time::Duration;

/// Where coding tools work and what their shell sees.
#[derive(Debug, Clone)]
pub struct Workspace {
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub bash_timeout: Duration,
}

impl Workspace {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self {
            cwd: cwd.into(),
            env: Vec::new(),
            bash_timeout: Duration::from_secs(120),
        }
    }

    pub fn resolve(&self, path: &str) -> PathBuf {
        let p = Path::new(path);
        if p.is_absolute() { p.to_path_buf() } else { self.cwd.join(p) }
    }
}
