//! Cross-layer tracer (`cargo xtask trace`) across the 6 protocol-to-UI layers.

use std::path::Path;

const USAGE: &str = "\
Usage: cargo xtask trace <query> [--layer <name>] [--json]

Trace a contract type, endpoint, slice field, or symbol across:
  1. crates/protocol/src/contract/
  2. packages/protocol/src/
  3. crates/server/src/router.rs & domain modules
  4. crates/server/src/gateway/
  5. crates/cli/src/
  6. apps/mac/ui/ & apps/mobile/src/";

pub fn run(_root: &Path, args: &[String]) -> Result<i32, String> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{USAGE}");
        return Ok(0);
    }
    eprintln!("xtask trace: scaffolding only (implementation pending)\n\n{USAGE}");
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
