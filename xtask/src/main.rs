//! Native Rust workspace governance & verification task runner (`cargo xtask`).

pub mod arch_audit;
pub mod arch_metrics;
mod boundaries;
mod changed;
mod deps;
mod map;
mod qa;
mod ratchets;
mod rust_scan;
mod ssot;
mod trace;

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask lives directly under workspace root")
        .to_path_buf()
}

fn run_cargo(root: &Path, args: &[&str], extra_env: &[(&str, &str)]) -> Result<i32, String> {
    let mut cmd = Command::new("cargo");
    cmd.args(args).current_dir(root);
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let status = cmd.status().map_err(|err| format!("failed to run cargo {}: {err}", args.join(" ")))?;
    Ok(status.code().unwrap_or(1))
}

fn print_usage() {
    println!(
        "\
Usage: cargo xtask <command> [options]

Commands:
  check                                Run fmt --check, clippy -D warnings, and nextest/test
  changed [--base <ref>] [--dry-run]   Check affected Rust crates and transitive reverse dependents
  loom                                 Run loom concurrency tests (runtime & server)
  goldens [--check]                    Run vibevalley-core artifact golden tests
  protocol [--write]                   Check (or with --write, regenerate) TS contract & goldens
  audit [--boundaries] [--ratchets] [--arch]
                                       Run module-boundary, ratchet, and strict arch audits
  arch-audit [--report-locks] [--json] Run flat server architecture audit (14 rules) & lock report
  diagnose [--json] [--top <N>]        Compute architectural metrics, hotspots & prescriptive diagnostics
  trace <op|slice|orphans|query> [--layer <name>] [--json]
                                       Trace a contract symbol, op, or slice across all 6 layers
  map [filter] [--surface] [--json] [--top <N>]
                                       Map module facades, pub/pub(crate) surface, and fn complexity
  deps [crate|ui] [--cycles] [--dot] [--ui] [--json]
                                       Inspect module/crate dependency graph, cycles, and UI layering
  ssot-check [--dupes] [--strict] [--min-lines N] [--rule <id>] [--json]
                                       Audit Rust <-> TS SSOT drift and structural clones
  crap [options] [<path>...]           Compute cyclomatic complexity & coverage CRAP scores
  dry [options] [<path>...]            Detect normalized structural clones within each language
  mutate [options] [<path>...]         Run incremental hash-cached, coverage-gated mutation tests
  uml [viewer | arch | --svg <out>] [<path>...]
                                       Verify dependency rule, run arch lenses, export UML, or launch viewer"
    );
}

fn handle_no_extra_args(args: &[String], usage: &str, allow_check_flag: bool) -> Option<i32> {
    match args {
        [] => None,
        [flag] if flag == "--help" || flag == "-h" => {
            println!("{usage}");
            Some(0)
        }
        [flag] if allow_check_flag && flag == "--check" => None,
        _ => {
            eprintln!("{usage}");
            Some(2)
        }
    }
}

fn cmd_check(root: &Path, args: &[String]) -> Result<i32, String> {
    if let Some(code) = handle_no_extra_args(args, "Usage: cargo xtask check", false) {
        return Ok(code);
    }

    println!("xtask check: cargo fmt --all --check");
    let fmt = run_cargo(root, &["fmt", "--all", "--check"], &[])?;
    if fmt != 0 {
        return Ok(fmt);
    }

    println!("xtask check: cargo clippy --workspace --all-targets -- -D warnings");
    let clippy = run_cargo(root, &["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"], &[])?;
    if clippy != 0 {
        return Ok(clippy);
    }

    if changed::has_nextest() {
        println!("xtask check: cargo nextest run --workspace --no-fail-fast");
        let nextest = run_cargo(root, &["nextest", "run", "--workspace", "--no-fail-fast"], &[])?;
        if nextest != 0 {
            return Ok(nextest);
        }
        println!("xtask check: cargo test --workspace --doc");
        run_cargo(root, &["test", "--workspace", "--doc"], &[])
    } else {
        println!("xtask check: cargo test --workspace");
        run_cargo(root, &["test", "--workspace"], &[])
    }
}

fn cmd_loom(root: &Path, args: &[String]) -> Result<i32, String> {
    if let Some(code) = handle_no_extra_args(args, "Usage: cargo xtask loom", false) {
        return Ok(code);
    }

    let runtime_code = run_cargo(
        root,
        &[
            "test",
            "--profile",
            "loom",
            "-p",
            "vibevalley-runtime",
            "--features",
            "loom",
            "--lib",
            "loom_models",
        ],
        &[],
    )?;
    if runtime_code != 0 {
        return Ok(runtime_code);
    }
    run_cargo(
        root,
        &[
            "test",
            "--profile",
            "loom",
            "-p",
            "vibevalley-server",
            "--features",
            "loom",
            "--lib",
            "loom_models",
        ],
        &[],
    )
}

fn cmd_goldens(root: &Path, args: &[String]) -> Result<i32, String> {
    if let Some(code) = handle_no_extra_args(args, "Usage: cargo xtask goldens [--check]", true) {
        return Ok(code);
    }
    run_cargo(root, &["test", "-p", "vibevalley-core", "--test", "artifact_golden"], &[])
}

fn cmd_protocol(root: &Path, args: &[String]) -> Result<i32, String> {
    let mut write = false;
    for arg in args {
        match arg.as_str() {
            "--write" => write = true,
            "--check" => write = false,
            "--help" | "-h" => {
                println!("Usage: cargo xtask protocol [--write]");
                return Ok(0);
            }
            other => {
                eprintln!("Usage: cargo xtask protocol [--write] (unknown option {other})");
                return Ok(2);
            }
        }
    }

    if write {
        return run_cargo(
            root,
            &["test", "-p", "vibevalley-protocol", "--features", "ts-gen", "--test", "typescript"],
            &[("VIBEVALLEY_WRITE_TS", "1")],
        );
    }

    let proto = run_cargo(
        root,
        &["test", "-p", "vibevalley-protocol", "--features", "ts-gen", "--test", "typescript"],
        &[],
    )?;
    if proto != 0 {
        return Ok(proto);
    }
    cmd_goldens(root, &["--check".to_owned()])
}

fn cmd_audit(root: &Path, args: &[String]) -> Result<i32, String> {
    let mut want_boundaries = false;
    let mut want_ratchets = false;
    let mut want_arch = false;
    for arg in args {
        match arg.as_str() {
            "--boundaries" => want_boundaries = true,
            "--ratchets" => want_ratchets = true,
            "--arch" => want_arch = true,
            "--help" | "-h" => {
                println!("Usage: cargo xtask audit [--boundaries] [--ratchets] [--arch]");
                return Ok(0);
            }
            other => {
                eprintln!("Usage: cargo xtask audit [--boundaries] [--ratchets] [--arch] (unknown option {other})");
                return Ok(2);
            }
        }
    }

    let run_all = !want_boundaries && !want_ratchets && !want_arch;
    let mut exit_code = 0;

    if run_all || want_boundaries {
        let code = boundaries::run(root)?;
        if code != 0 {
            exit_code = code;
        }
    }
    if run_all || want_ratchets {
        let code = ratchets::run(root)?;
        if code != 0 {
            exit_code = code;
        }
    }
    if run_all || want_arch {
        let code = arch_audit::run(root, &[])?;
        if code != 0 {
            exit_code = code;
        }
    }
    Ok(exit_code)
}

fn dispatch(root: &Path, args: &[String]) -> Result<i32, String> {
    let Some((sub, rest)) = args.split_first() else {
        print_usage();
        return Ok(2);
    };

    match sub.as_str() {
        "--help" | "-h" | "help" => {
            print_usage();
            Ok(0)
        }
        "check" => cmd_check(root, rest),
        "changed" => changed::run(root, rest),
        "loom" => cmd_loom(root, rest),
        "goldens" => cmd_goldens(root, rest),
        "protocol" => cmd_protocol(root, rest),
        "audit" => cmd_audit(root, rest),
        "arch-audit" => arch_audit::run(root, rest),
        "diagnose" => arch_metrics::run(root, rest),
        "trace" => trace::run(root, rest),
        "map" => map::run(root, rest),
        "deps" => deps::run(root, rest),
        "ssot-check" => ssot::run(root, rest),
        "crap" => qa::crap::run(root, rest),
        "dry" => qa::dry::run(root, rest),
        "mutate" => qa::mutate::run(root, rest),
        "uml" => qa::uml::run(root, rest),
        other => {
            eprintln!("xtask: unknown subcommand `{other}`\n");
            print_usage();
            Ok(2)
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let root = workspace_root();
    match dispatch(&root, &args) {
        Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
        Err(err) => {
            eprintln!("{err}");
            ExitCode::from(1)
        }
    }
}
