//! Cyclomatic complexity & coverage CRAP score gate (`cargo xtask crap`).

use std::path::Path;

pub fn run(_root: &Path, args: &[String]) -> Result<i32, String> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("Usage: cargo xtask crap [--threshold <N>] [--no-coverage] [--use-existing-coverage] [--changed] [<path>...]");
        return Ok(0);
    }
    Err("cargo xtask crap: implementation pending Stage 2".to_owned())
}
