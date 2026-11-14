//! Bundles the hosted views (`ui/`) with the `nsh` CLI into `$OUT_DIR/ui`,
//! which the binary embeds. The CLI is found through `NSH_BIN`, the repo's
//! `.tools/bin/nsh` (`cargo install nsh-cli --root .tools`), or `PATH`.
//! Without it the build still succeeds, with a bundle that reports the
//! missing UI at run time.

use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    build_audio();
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let repo = manifest.join("../..").canonicalize().unwrap();
    let ui = manifest.join("ui");
    let ui_build = ui.join("build");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("ui");
    std::fs::create_dir_all(&out).unwrap();
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=NSH_BIN");
    println!("cargo:rerun-if-env-changed=VIBEVALLEY_EMBED_UI");

    let release = std::env::var("PROFILE").as_deref() == Ok("release") || std::env::var_os("VIBEVALLEY_EMBED_UI").is_some();
    if release {
        watch(&ui);
    }

    // In debug builds, `hosted::bundle()` loads `ui/build/` straight from disk so
    // editing TSX files never recompiles or relinks `vibevalley-mac`.
    if !release && ui_build.join("bundle.js").is_file() && ui_build.join("capabilities.json").is_file() {
        let _ = std::fs::copy(ui_build.join("bundle.js"), out.join("bundle.js"));
        let _ = std::fs::copy(ui_build.join("capabilities.json"), out.join("capabilities.json"));
        return;
    }

    let target_dir = if release { &out } else { &ui_build };
    let _ = std::fs::create_dir_all(target_dir);
    let built = find_nsh(&repo).and_then(|nsh| {
        let result = Command::new(&nsh).arg("build").arg(ui.join("App.tsx")).arg("-o").arg(target_dir).output();
        match result {
            Ok(o) if o.status.success() => {
                if !release {
                    let _ = std::fs::copy(target_dir.join("bundle.js"), out.join("bundle.js"));
                    let _ = std::fs::copy(target_dir.join("capabilities.json"), out.join("capabilities.json"));
                }
                Some(())
            }
            Ok(o) => {
                for line in String::from_utf8_lossy(&o.stderr).lines().chain(String::from_utf8_lossy(&o.stdout).lines()) {
                    println!("cargo:warning=nsh build: {line}");
                }
                None
            }
            Err(e) => {
                println!("cargo:warning=could not run {}: {e}", nsh.display());
                None
            }
        }
    });
    if built.is_none() {
        println!("cargo:warning=hosted views not bundled; install the nsh CLI (see build.rs)");
        std::fs::write(
            out.join("bundle.js"),
            "throw new Error('VibeValley was built without its UI bundle: install the nsh CLI and rebuild.');\n",
        )
        .unwrap();
        std::fs::write(out.join("capabilities.json"), "{\"host\":[\"action\"]}").unwrap();
    }
}

fn find_nsh(repo: &Path) -> Option<PathBuf> {
    let candidates = std::env::var_os("NSH_BIN")
        .map(PathBuf::from)
        .into_iter()
        .chain(std::iter::once(repo.join(".tools/bin/nsh")))
        .chain(
            std::env::var_os("PATH")
                .into_iter()
                .flat_map(|p| std::env::split_paths(&p).map(|d| d.join("nsh")).collect::<Vec<_>>()),
        );
    for c in candidates {
        if !c.is_file() {
            continue;
        }
        // Another program named `nsh` (a shell) may be on PATH.
        let is_native_shell = Command::new(&c)
            .arg("--version")
            .output()
            .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).starts_with("nsh 0."));
        if is_native_shell {
            return Some(c);
        }
    }
    None
}

fn watch(dir: &Path) {
    println!("cargo:rerun-if-changed={}", dir.display());
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || name == "build" || name == "node_modules" {
            continue;
        }
        if path.is_dir() {
            watch(&path);
        } else {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}

fn build_audio() {
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let object = out.join("audio.o");
    let archive = out.join("libvibevalley_audio.a");
    println!("cargo:rerun-if-changed=src/audio.m");
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        other => panic!("unsupported macOS architecture: {other:?}"),
    };
    let status = Command::new("/usr/bin/clang")
        .args(["-arch", arch])
        .args([
            "-fobjc-arc",
            "-fblocks",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-Wno-unused-parameter",
            "-c",
            "src/audio.m",
            "-o",
        ])
        .arg(&object)
        .status()
        .expect("compile the AVFoundation audio adapter");
    assert!(status.success(), "the AVFoundation audio adapter did not compile");
    let status = Command::new("/usr/bin/ar")
        .arg("rcs")
        .arg(&archive)
        .arg(&object)
        .status()
        .expect("archive the audio adapter");
    assert!(status.success(), "the audio adapter was not archived");
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=vibevalley_audio");
    println!("cargo:rustc-link-lib=framework=AVFoundation");
    println!("cargo:rustc-link-lib=framework=Foundation");
}
