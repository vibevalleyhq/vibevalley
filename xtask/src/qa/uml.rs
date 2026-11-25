//! Clean Architecture topology IR, dependency rule checker, and UML viewer (`cargo xtask uml`).

#[path = "viewer.rs"]
mod viewer;

use std::path::Path;

pub fn run(root: &Path, args: &[String]) -> Result<i32, String> {
    if let Some((first, rest)) = args.split_first()
        && first == "viewer"
    {
        return viewer::run(root, rest);
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("Usage: cargo xtask uml [viewer [--port <N>] [--open] | --svg <out>] [<path>...]");
        return Ok(0);
    }
    Err("cargo xtask uml: implementation pending Stage 2".to_owned())
}
