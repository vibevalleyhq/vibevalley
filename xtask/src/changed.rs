//! Changed Rust crate resolver: computes changed workspace packages and transitive reverse dependents.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;
use std::process::{Command, Stdio};

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct CargoDependency {
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CargoPackage {
    pub id: String,
    pub name: String,
    pub manifest_path: String,
    pub dependencies: Vec<CargoDependency>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CargoMetadata {
    pub packages: Vec<CargoPackage>,
    pub workspace_members: Vec<String>,
    pub workspace_root: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangedPackagesResult {
    pub all: bool,
    pub packages: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RustChangedOptions {
    pub base: String,
    pub fast: bool,
    pub dry_run: bool,
    pub help: bool,
}

const ROOT_TRIGGER_FILES: &[&str] = &["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".config/nextest.toml"];

// Nested non-Rust subtrees inside a crate directory: `apps/mac/ui/` is built and checked by `mac:check`,
// and debug builds load it from disk (`apps/mac/build.rs`), so TSX edits do not affect Rust crates.
const NON_RUST_SUBTREES: &[&str] = &["apps/mac/ui/"];

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_owned()
}

fn normalize_relative_file(path: &str) -> String {
    let cleaned = normalize_path(path.trim());
    cleaned.strip_prefix("./").unwrap_or(&cleaned).to_owned()
}

fn manifest_dir_relative(manifest_path: &str, base_root: &str) -> Option<String> {
    let root = normalize_path(base_root);
    let normalized_manifest = normalize_path(manifest_path);
    let dir = normalized_manifest.strip_suffix("/Cargo.toml").unwrap_or(&normalized_manifest);
    if dir == root {
        return Some(String::new());
    }
    let prefix = format!("{root}/");
    dir.strip_prefix(&prefix).map(str::to_owned)
}

fn is_under_non_rust_subtree(file: &str) -> bool {
    NON_RUST_SUBTREES.iter().any(|prefix| {
        let dir = &prefix[..prefix.len() - 1];
        file == dir || file.starts_with(prefix)
    })
}

/// A changed crate also affects every crate that depends on it, transitively.
pub fn parse_changed_packages(metadata: &CargoMetadata, changed_files: &[String], base_root: &str) -> ChangedPackagesResult {
    let member_ids: BTreeSet<&str> = metadata.workspace_members.iter().map(String::as_str).collect();
    let members: Vec<&CargoPackage> = if member_ids.is_empty() {
        metadata.packages.iter().collect()
    } else {
        metadata.packages.iter().filter(|pkg| member_ids.contains(pkg.id.as_str())).collect()
    };

    let mut all_packages: Vec<String> = members.iter().map(|pkg| pkg.name.clone()).collect();
    all_packages.sort();

    let mut normalized_files = Vec::new();
    for raw in changed_files {
        let file = normalize_relative_file(raw);
        if file.is_empty() {
            continue;
        }
        if ROOT_TRIGGER_FILES.contains(&file.as_str()) {
            return ChangedPackagesResult {
                all: true,
                packages: all_packages,
            };
        }
        if !is_under_non_rust_subtree(&file) {
            normalized_files.push(file);
        }
    }

    // Sort longest relative directory first so nested crates (e.g. `apps/mac/crates/diorama`)
    // win over enclosing crates (e.g. `apps/mac`).
    let mut dirs: Vec<(&str, String)> = members
        .iter()
        .filter_map(|pkg| manifest_dir_relative(&pkg.manifest_path, base_root).map(|dir| (pkg.name.as_str(), dir)))
        .collect();
    dirs.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| a.0.cmp(b.0)));

    let mut direct = BTreeSet::new();
    for file in &normalized_files {
        for (name, dir) in &dirs {
            if dir.is_empty() {
                if file.starts_with("src/") || file.starts_with("tests/") || file.starts_with("benches/") || file.starts_with("examples/") || file == "build.rs"
                {
                    direct.insert((*name).to_owned());
                    break;
                }
                continue;
            }
            if file == dir || (file.starts_with(dir.as_str()) && file.as_bytes().get(dir.len()) == Some(&b'/')) {
                direct.insert((*name).to_owned());
                break;
            }
        }
    }

    if direct.is_empty() {
        return ChangedPackagesResult {
            all: false,
            packages: Vec::new(),
        };
    }

    let workspace_names: BTreeSet<&str> = all_packages.iter().map(String::as_str).collect();
    let mut dependents: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for pkg in &members {
        for dep in &pkg.dependencies {
            if !workspace_names.contains(dep.name.as_str()) || dep.name == pkg.name {
                continue;
            }
            dependents.entry(dep.name.as_str()).or_default().insert(pkg.name.as_str());
        }
    }

    let mut affected = direct.clone();
    let mut queue: VecDeque<String> = direct.into_iter().collect();
    while let Some(current) = queue.pop_front() {
        if let Some(rev) = dependents.get(current.as_str()) {
            for &next in rev {
                if affected.insert(next.to_owned()) {
                    queue.push_back(next.to_owned());
                }
            }
        }
    }

    ChangedPackagesResult {
        all: false,
        packages: affected.into_iter().collect(),
    }
}

pub fn parse_changed_args(argv: &[String]) -> Result<RustChangedOptions, String> {
    let mut base = "origin/main".to_owned();
    let mut fast = false;
    let mut dry_run = false;
    let mut help = false;

    let mut i = 0usize;
    while i < argv.len() {
        let arg = &argv[i];
        if arg == "--fast" {
            fast = true;
        } else if arg == "--dry-run" {
            dry_run = true;
        } else if arg == "--help" || arg == "-h" {
            help = true;
        } else if arg == "--base" {
            i += 1;
            let Some(val) = argv.get(i).filter(|v| !v.is_empty()) else {
                return Err("rust:changed: --base requires a git ref".to_owned());
            };
            base = val.clone();
        } else if let Some(val) = arg.strip_prefix("--base=") {
            if val.is_empty() {
                return Err("rust:changed: --base requires a git ref".to_owned());
            }
            base = val.to_owned();
        } else {
            return Err(format!("rust:changed: unknown option {arg}"));
        }
        i += 1;
    }

    Ok(RustChangedOptions { base, fast, dry_run, help })
}

fn run_capture(cmd: &str, args: &[&str], cwd: &Path) -> Result<String, String> {
    let out = Command::new(cmd)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|err| format!("failed to run {cmd} {}: {err}", args.join(" ")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        let code = out.status.code().map_or_else(|| "signal".to_owned(), |c| c.to_string());
        return Err(if detail.is_empty() {
            format!("{cmd} {} failed (exit {code})", args.join(" "))
        } else {
            format!("{cmd} {} failed (exit {code}): {detail}", args.join(" "))
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn collect_changed_files(root: &Path, base: &str) -> Result<Vec<String>, String> {
    let mut files = BTreeSet::new();
    let add_lines = |out: String, set: &mut BTreeSet<String>| {
        for line in out.lines() {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                set.insert(trimmed.to_owned());
            }
        }
    };
    let range = format!("{base}...HEAD");
    add_lines(run_capture("git", &["diff", "--name-only", &range], root)?, &mut files);
    add_lines(run_capture("git", &["diff", "--name-only"], root)?, &mut files);
    add_lines(run_capture("git", &["diff", "--name-only", "--cached"], root)?, &mut files);
    add_lines(run_capture("git", &["ls-files", "--others", "--exclude-standard"], root)?, &mut files);
    Ok(files.into_iter().collect())
}

fn run_step(cmd: &str, args: &[String], cwd: &Path) -> Result<i32, String> {
    let status = Command::new(cmd)
        .args(args)
        .current_dir(cwd)
        .status()
        .map_err(|err| format!("failed to run {cmd} {}: {err}", args.join(" ")))?;
    Ok(status.code().unwrap_or(1))
}

pub fn has_nextest() -> bool {
    Command::new("cargo")
        .args(["nextest", "--version"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

pub fn run(root: &Path, argv: &[String]) -> Result<i32, String> {
    let options = parse_changed_args(argv)?;
    if options.help {
        println!("usage: cargo xtask changed [--base <ref>] [--fast] [--dry-run]");
        return Ok(0);
    }

    let changed_files = collect_changed_files(root, &options.base)?;
    let raw_metadata = run_capture("cargo", &["metadata", "--no-deps", "--format-version", "1"], root)?;
    let metadata: CargoMetadata = serde_json::from_str(&raw_metadata).map_err(|err| format!("failed to parse cargo metadata: {err}"))?;
    let base_root = metadata.workspace_root.clone().unwrap_or_else(|| root.to_string_lossy().into_owned());
    let result = parse_changed_packages(&metadata, &changed_files, &base_root);

    if result.packages.is_empty() {
        println!("rust:changed: no affected Rust crates");
        return Ok(0);
    }

    let mut pkg_args = Vec::with_capacity(result.packages.len() * 2);
    for name in &result.packages {
        pkg_args.push("-p".to_owned());
        pkg_args.push(name.clone());
    }

    if options.dry_run {
        let scope = if result.all {
            "all".to_owned()
        } else {
            format!("{} crates", result.packages.len())
        };
        println!("rust:changed ({scope}): {}", pkg_args.join(" "));
        return Ok(0);
    }

    let scope_desc = if result.all {
        "all workspace crates".to_owned()
    } else {
        format!("{} crates", result.packages.len())
    };
    println!("rust:changed: checking {scope_desc} ({})", result.packages.join(", "));

    let fmt_args = vec!["fmt".to_owned(), "--all".to_owned(), "--check".to_owned()];
    let fmt_code = run_step("cargo", &fmt_args, root)?;
    if fmt_code != 0 {
        return Ok(fmt_code);
    }

    let mut clippy_args = vec!["clippy".to_owned()];
    clippy_args.extend(pkg_args.iter().cloned());
    clippy_args.extend(["--all-targets".to_owned(), "--".to_owned(), "-D".to_owned(), "warnings".to_owned()]);
    let clippy_code = run_step("cargo", &clippy_args, root)?;
    if clippy_code != 0 {
        return Ok(clippy_code);
    }

    if has_nextest() {
        let mut nextest_args = vec!["nextest".to_owned(), "run".to_owned()];
        if options.fast {
            nextest_args.push("--profile".to_owned());
            nextest_args.push("fast".to_owned());
        }
        nextest_args.extend(pkg_args);
        nextest_args.push("--no-fail-fast".to_owned());
        run_step("cargo", &nextest_args, root)
    } else {
        let mut test_args = vec!["test".to_owned()];
        test_args.extend(pkg_args);
        run_step("cargo", &test_args, root)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = "/repo";

    fn sample_metadata() -> CargoMetadata {
        let pkg = |name: &str, path: &str, deps: &[&str]| CargoPackage {
            id: format!("{name} 0.1.0"),
            name: name.to_owned(),
            manifest_path: format!("{ROOT}/{path}/Cargo.toml"),
            dependencies: deps.iter().map(|d| CargoDependency { name: (*d).to_owned() }).collect(),
        };
        CargoMetadata {
            workspace_root: Some(ROOT.to_owned()),
            workspace_members: vec![
                "vibevalley-protocol 0.1.0".to_owned(),
                "vibevalley-core 0.1.0".to_owned(),
                "vibevalley-server 0.1.0".to_owned(),
                "vibevalley-cli 0.1.0".to_owned(),
                "vibevalley-diorama 0.1.0".to_owned(),
                "vibevalley-terminal 0.1.0".to_owned(),
                "vibevalley-mac 0.1.0".to_owned(),
            ],
            packages: vec![
                pkg("vibevalley-protocol", "crates/protocol", &["serde"]),
                pkg("vibevalley-core", "crates/core", &["vibevalley-protocol"]),
                pkg("vibevalley-server", "crates/server", &["vibevalley-core", "vibevalley-protocol"]),
                pkg("vibevalley-cli", "crates/cli", &["vibevalley-protocol"]),
                pkg("vibevalley-diorama", "apps/mac/crates/diorama", &[]),
                pkg("vibevalley-terminal", "apps/mac/crates/terminal", &[]),
                pkg(
                    "vibevalley-mac",
                    "apps/mac",
                    &["vibevalley-server", "vibevalley-diorama", "vibevalley-terminal"],
                ),
            ],
        }
    }

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|x| (*x).to_owned()).collect()
    }

    #[test]
    fn returns_empty_when_no_rust_crates_are_touched() {
        let meta = sample_metadata();
        assert_eq!(
            parse_changed_packages(&meta, &s(&["docs/README.md", "packages/protocol/src/api.ts", "apps/mac/ui/App.tsx", ""]), ROOT),
            ChangedPackagesResult { all: false, packages: vec![] }
        );
    }

    #[test]
    fn selects_all_workspace_crates_on_root_trigger_files() {
        let meta = sample_metadata();
        for trigger in ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".config/nextest.toml"] {
            assert_eq!(
                parse_changed_packages(&meta, &s(&[trigger]), ROOT),
                ChangedPackagesResult {
                    all: true,
                    packages: s(&[
                        "vibevalley-cli",
                        "vibevalley-core",
                        "vibevalley-diorama",
                        "vibevalley-mac",
                        "vibevalley-protocol",
                        "vibevalley-server",
                        "vibevalley-terminal",
                    ]),
                }
            );
        }
    }

    #[test]
    fn keeps_leaf_crate_scoped_to_itself() {
        let meta = sample_metadata();
        assert_eq!(
            parse_changed_packages(&meta, &s(&["crates/cli/src/main.rs"]), ROOT),
            ChangedPackagesResult {
                all: false,
                packages: s(&["vibevalley-cli"]),
            }
        );
    }

    #[test]
    fn walks_transitive_reverse_dependencies() {
        let meta = sample_metadata();
        assert_eq!(
            parse_changed_packages(&meta, &s(&["crates/core/src/reduce.rs"]), ROOT),
            ChangedPackagesResult {
                all: false,
                packages: s(&["vibevalley-core", "vibevalley-mac", "vibevalley-server"]),
            }
        );
        assert_eq!(
            parse_changed_packages(&meta, &s(&["crates/protocol/src/contract/slice.rs"]), ROOT),
            ChangedPackagesResult {
                all: false,
                packages: s(&[
                    "vibevalley-cli",
                    "vibevalley-core",
                    "vibevalley-mac",
                    "vibevalley-protocol",
                    "vibevalley-server",
                ]),
            }
        );
    }

    #[test]
    fn matches_nested_crate_dirs_first_and_includes_non_rs_assets() {
        let meta = sample_metadata();
        assert_eq!(
            parse_changed_packages(&meta, &s(&["apps/mac/crates/diorama/src/lib.rs"]), ROOT),
            ChangedPackagesResult {
                all: false,
                packages: s(&["vibevalley-diorama", "vibevalley-mac"]),
            }
        );
        assert_eq!(
            parse_changed_packages(&meta, &s(&["crates/server/assets/tools/helper.json"]), ROOT),
            ChangedPackagesResult {
                all: false,
                packages: s(&["vibevalley-mac", "vibevalley-server"]),
            }
        );
        assert_eq!(
            parse_changed_packages(&meta, &s(&["apps/mac/src/shell/mod.rs"]), ROOT),
            ChangedPackagesResult {
                all: false,
                packages: s(&["vibevalley-mac"]),
            }
        );
    }

    #[test]
    fn parses_changed_args_and_rejects_invalid() {
        assert_eq!(
            parse_changed_args(&[]).unwrap(),
            RustChangedOptions {
                base: "origin/main".to_owned(),
                fast: false,
                dry_run: false,
                help: false,
            }
        );
        assert_eq!(
            parse_changed_args(&s(&["--base", "main", "--fast", "--dry-run"])).unwrap(),
            RustChangedOptions {
                base: "main".to_owned(),
                fast: true,
                dry_run: true,
                help: false,
            }
        );
        assert_eq!(
            parse_changed_args(&s(&["--base=HEAD~2"])).unwrap(),
            RustChangedOptions {
                base: "HEAD~2".to_owned(),
                fast: false,
                dry_run: false,
                help: false,
            }
        );
        assert_eq!(
            parse_changed_args(&s(&["--help"])).unwrap(),
            RustChangedOptions {
                base: "origin/main".to_owned(),
                fast: false,
                dry_run: false,
                help: true,
            }
        );
        assert!(parse_changed_args(&s(&["--unknown"])).unwrap_err().contains("unknown option"));
        assert!(parse_changed_args(&s(&["--base"])).unwrap_err().contains("requires a git ref"));
        assert!(parse_changed_args(&s(&["--base="])).unwrap_err().contains("requires a git ref"));
    }
}
