//! Writes (or verifies with `--check`) multi-density scenario `state.json` files from `vibevalley_core::scenario`.
//!
//! Run: `cargo run -p vibevalley-core --features scenarios --example export_scenarios -- apps/mac/ui/fixtures/scenarios`

use std::path::PathBuf;

use vibevalley_core::scenario::{Density, preset};

fn main() {
    let mut check = false;
    let mut out_root: Option<PathBuf> = None;

    for arg in std::env::args().skip(1) {
        if arg == "--check" {
            check = true;
        } else if out_root.is_none() {
            out_root = Some(PathBuf::from(arg));
        } else {
            eprintln!("unexpected argument: {arg}");
            std::process::exit(2);
        }
    }

    let out_root = out_root.unwrap_or_else(|| PathBuf::from("apps/mac/ui/fixtures/scenarios"));
    let mut stale: Vec<String> = Vec::new();

    for density in Density::ALL {
        let dir = out_root.join(density.slug());
        let target = dir.join("state.json");
        let frame = preset(density);

        if check {
            let expected = serde_json::to_value(&frame).expect("serialize preset value");
            match std::fs::read_to_string(&target) {
                Ok(existing) => match serde_json::from_str::<serde_json::Value>(&existing) {
                    Ok(actual) if actual == expected => {}
                    Ok(_) => stale.push(format!("{} (out of date)", target.display())),
                    Err(err) => stale.push(format!("{} (invalid JSON: {err})", target.display())),
                },
                Err(err) => stale.push(format!("{} ({err})", target.display())),
            }
            continue;
        }

        let json = serde_json::to_string_pretty(&frame).expect("serialize scenario frame");
        std::fs::create_dir_all(&dir).expect("create scenario directory");
        std::fs::write(&target, format!("{json}\n")).expect("write scenario state.json");
        eprintln!(
            "wrote {} (seq={}, issues={}, sessions={})",
            target.display(),
            frame.seq,
            frame.state.issues.len(),
            frame.state.sessions.len()
        );
    }

    if check && !stale.is_empty() {
        eprintln!(
            "scenario fixtures drifted:\n- {}\nRun: cargo run -p vibevalley-core --features scenarios --example export_scenarios -- {}",
            stale.join("\n- "),
            out_root.display()
        );
        std::process::exit(1);
    }
}
