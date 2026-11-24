//! Module facade and public API surface mapper (`cargo xtask map`).

use std::path::Path;

const USAGE: &str = "\
Usage: cargo xtask map [target] [--surface] [--json]

Inspect module facades (`mod.rs` re-exports), `pub` vs `pub(crate)` visibility counts,
and file/LOC summaries for a crate or module path.";

pub fn run(_root: &Path, args: &[String]) -> Result<i32, String> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{USAGE}");
        return Ok(0);
    }
    eprintln!("xtask map: scaffolding only (implementation pending)\n\n{USAGE}");
    Ok(2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn help_returns_zero() {
        assert_eq!(run(Path::new("."), &["--help".to_owned()]), Ok(0));
        assert_eq!(run(Path::new("."), &["-h".to_owned()]), Ok(0));
    }
}
