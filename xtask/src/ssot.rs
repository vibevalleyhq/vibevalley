//! Rust <-> TS SSOT drift and structural clone checker (`cargo xtask ssot-check`).

use std::path::Path;

const USAGE: &str = "\
Usage: cargo xtask ssot-check [--dupes] [--rule <id>] [--json]

Check Rust <-> TypeScript SSOT invariants:
  - ts-enum-mirror      TS unions/lists duplicating Rust contract enums
  - host-dto-bypass     UI/bridge bypassing @vibevalley/protocol Zod codecs
  - env-registry-drift  VIBEVALLEY_* env vars or defaults drifting across layers
  - --dupes             Normalized token-window structural clone detection";

pub fn run(_root: &Path, args: &[String]) -> Result<i32, String> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{USAGE}");
        return Ok(0);
    }
    eprintln!("xtask ssot-check: scaffolding only (implementation pending)\n\n{USAGE}");
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
