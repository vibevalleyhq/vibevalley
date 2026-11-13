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

/// Lowercase ASCII words joined by `-`, safe as a directory and branch name.
pub fn slug(text: &str, max_len: usize) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= max_len {
            break;
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "task".into() } else { out }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique() {
        let ids: std::collections::HashSet<String> = (0..500).map(|_| new_id()).collect();
        assert_eq!(ids.len(), 500);
    }

    #[test]
    fn slug_is_branch_safe() {
        assert_eq!(slug("Fix the  login/redirect bug!", 40), "fix-the-login-redirect-bug");
        assert_eq!(slug("修复登录", 40), "task");
        assert_eq!(slug("a very long title that keeps going", 10), "a-very-lon");
        assert_eq!(slug("--x--", 40), "x");
    }
}
