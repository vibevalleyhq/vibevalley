//! Normalized structural clone detector (`cargo xtask dry`).

use std::path::Path;

pub fn run(_root: &Path, args: &[String]) -> Result<i32, String> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("Usage: cargo xtask dry [--threshold <F>] [--min-lines <N>] [--min-nodes <N>] [--changed] [<path>...]");
        return Ok(0);
    }
    Err("cargo xtask dry: implementation pending Stage 2".to_owned())
}
