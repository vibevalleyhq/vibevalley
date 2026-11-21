//! Writes multi-density scenario `state.json` files from `vibevalley_core::scenario`.
//!
//! Run: `cargo run -p vibevalley-core --features scenarios --example export_scenarios -- apps/mac/ui/fixtures/scenarios`

use std::path::PathBuf;

use vibevalley_core::scenario::{Density, preset};

fn main() {
    let out_root = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("apps/mac/ui/fixtures/scenarios"));

    for density in Density::ALL {
        let dir = out_root.join(density.slug());
        std::fs::create_dir_all(&dir).expect("create scenario directory");
        let frame = preset(density);
        let json = serde_json::to_string_pretty(&frame).expect("serialize scenario frame");
        let target = dir.join("state.json");
        std::fs::write(&target, format!("{json}\n")).expect("write scenario state.json");
        eprintln!(
            "wrote {} (seq={}, issues={}, sessions={})",
            target.display(),
            frame.seq,
            frame.state.issues.len(),
            frame.state.sessions.len()
        );
    }
}
