//! Module and crate dependency graph and cycle inspector (`cargo xtask deps`).

use std::path::Path;

const USAGE: &str = "\
Usage: cargo xtask deps [target] [--cycles] [--dot] [--json]

Build the directed dependency graph for workspace crates or server modules,
report fan-in/fan-out, and detect strongly connected components / cycles.";

pub fn run(_root: &Path, args: &[String]) -> Result<i32, String> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{USAGE}");
        return Ok(0);
    }
    eprintln!("xtask deps: scaffolding only (implementation pending)\n\n{USAGE}");
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
