//! Incremental hash-cached, coverage-gated mutation tester (`cargo xtask mutate`).

use std::path::Path;

pub fn run(_root: &Path, args: &[String]) -> Result<i32, String> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "Usage: cargo xtask mutate [--scan] [--changed] [--mutate-all] [--since-last-run] [--no-coverage] [--use-existing-coverage] [--max-workers <N>] [<path>...]"
        );
        return Ok(0);
    }
    Err("cargo xtask mutate: implementation pending Stage 2".to_owned())
}
