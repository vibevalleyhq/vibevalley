use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Process-unique, time-ordered id (hex). Not a UUID: nothing outside this
/// machine ever sees it.
pub fn new_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:x}{:04x}{:03x}", now_ms(), std::process::id() & 0xffff, n & 0xfff)
}

/// `~/Library/Application Support/VibeValley`.
pub fn app_support_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"));
    home.join("Library/Application Support/VibeValley")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique() {
        let ids: std::collections::HashSet<String> = (0..500).map(|_| new_id()).collect();
        assert_eq!(ids.len(), 500);
    }
}
