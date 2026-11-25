//! Standalone local HTTP server for interactive UML exploration (`cargo xtask uml viewer`).

use std::path::Path;

const VIEWER_HTML: &str = include_str!("viewer.html");

pub fn run(_root: &Path, args: &[String]) -> Result<i32, String> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("Usage: cargo xtask uml viewer [--port <N>] [--open]");
        return Ok(0);
    }
    let _ = VIEWER_HTML.len();
    Err("cargo xtask uml viewer: implementation pending Stage 2".to_owned())
}
