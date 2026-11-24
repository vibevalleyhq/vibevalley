//! `vibevalley-eval`: optional developer binary for durable trace export, inspection, replay, and eval suites.
//!
//! Built only with `--features eval` so the default `vibevalley` HTTP CLI does not link `vibevalley-runtime`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use clap::{Parser, Subcommand};
use serde_json::json;
use vibevalley_cli::{Done, Failure, Output, exit, no_dry_run, run_cli};
use vibevalley_runtime::agent::OpenAiClient;
use vibevalley_runtime::agent::ai::types::ModelClient;
use vibevalley_runtime::agent::durable::{ExportOptions, Store, read_telemetry_jsonl};
use vibevalley_runtime::agent::eval::{EvalRunner, EvalSuite, ReplaySpec, analyze_store, export_html, render_timeline, resolve_root_conversation, run_replay};

/// Durable trajectory export, inspection, replay, and evaluation runner.
#[derive(Debug, Parser)]
#[command(
    name = "vibevalley-eval",
    version,
    arg_required_else_help = true,
    subcommand_required = true,
    disable_help_subcommand = true
)]
struct EvalCli {
    /// Print raw JSON instead of human-readable text
    #[arg(long, global = true)]
    json: bool,

    /// Reject mutating eval commands
    #[arg(long, global = true)]
    dry_run: bool,

    #[command(subcommand)]
    command: EvalCommand,
}

#[derive(Debug, Subcommand)]
enum EvalCommand {
    /// Export a durable conversation from SQLite into a portable JSONL bundle
    #[command(after_help = "Examples:\n  vibevalley-eval export conv-1 --out /tmp/trace")]
    Export {
        /// Root conversation id
        conversation: String,
        /// Output directory for JSONL bundle
        #[arg(long)]
        out: PathBuf,
        /// Source SQLite database path (defaults to <home>/server.db)
        #[arg(long)]
        source: Option<PathBuf>,
        /// Stop exporting at this sequence number
        #[arg(long)]
        at_seq: Option<i64>,
        /// Exclude child subagent conversations
        #[arg(long)]
        no_children: bool,
    },
    /// Analyze metrics, render timeline, or export HTML for a trace store
    #[command(after_help = "Examples:\n  vibevalley-eval inspect /tmp/trace --timeline --html /tmp/trace.html")]
    Inspect {
        /// SQLite database file or JSONL trace directory
        path: PathBuf,
        /// Optional conversation id (auto-resolved when omitted)
        #[arg(long)]
        conversation: Option<String>,
        /// Include an ASCII turn timeline
        #[arg(long)]
        timeline: bool,
        /// Write an interactive HTML trace report to this file
        #[arg(long)]
        html: Option<PathBuf>,
    },
    /// Replay a saved conversation slice against a live DeepSeek model
    #[command(after_help = "Examples:\n  vibevalley-eval replay ./replay.json --out /tmp/replay")]
    Replay {
        /// Path to ReplaySpec JSON file
        spec: PathBuf,
        /// Output directory for replay results
        #[arg(long)]
        out: PathBuf,
    },
    /// Run a multi-profile evaluation suite
    #[command(after_help = "Examples:\n  vibevalley-eval run ./suite.json --out /tmp/eval-out --trials 3")]
    Run {
        /// Path to EvalSuite JSON file
        suite: PathBuf,
        /// Output directory for suite results
        #[arg(long)]
        out: PathBuf,
        /// Override trial count per profile
        #[arg(long)]
        trials: Option<i64>,
        /// Run only named profiles (repeatable)
        #[arg(long)]
        profile: Vec<String>,
    },
}

fn eval_err(err: impl std::fmt::Display) -> Failure {
    Failure::new(exit::OTHER, "Eval", err.to_string())
}

fn resolve_deepseek_client() -> Result<Arc<dyn ModelClient>, Failure> {
    let key = std::env::var("DEEPSEEK_API_KEY")
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .or_else(|| vibevalley_protocol::home::saved_deepseek_key(&vibevalley_protocol::home::home()));
    let Some(key) = key else {
        return Err(Failure::new(
            exit::REFUSED,
            "NoKey",
            "no DeepSeek API key found (set DEEPSEEK_API_KEY or configure it in settings.json)",
        ));
    };
    Ok(Arc::new(OpenAiClient::deepseek(move || Some(key.clone()))))
}

fn run(cli: EvalCli) -> Done {
    vibevalley_runtime::rt::block_on(run_async(cli))
}

async fn run_async(cli: EvalCli) -> Done {
    let output = Output { json: cli.json };
    match cli.command {
        EvalCommand::Export {
            conversation,
            out,
            source,
            at_seq,
            no_children,
        } => {
            if cli.dry_run {
                return Err(no_dry_run("eval export"));
            }
            if let Some(seq) = at_seq
                && seq < 0
            {
                return Err(Failure::usage("InvalidValue", "--at-seq must be >= 0"));
            }
            let source_path = source.unwrap_or_else(|| vibevalley_protocol::home::home().join("server.db"));
            let store = Store::open_any_read_only(&source_path).await.map_err(eval_err)?;
            let manifest = store
                .export_conversation_jsonl(
                    &conversation,
                    &out,
                    ExportOptions {
                        at_seq,
                        include_children: !no_children,
                        fsync: true,
                    },
                )
                .await
                .map_err(eval_err)?;
            let _ = store.close().await;
            output.show(&manifest, |m| {
                format!(
                    "exported {} ({} conversations, {} entries, {} tasks, {} docs) -> {}",
                    m.root_conversation_id,
                    m.conversations_exported,
                    m.entries_exported,
                    m.tasks_exported,
                    m.documents_exported,
                    out.display()
                )
            });
            Ok(())
        }
        EvalCommand::Inspect {
            path,
            conversation,
            timeline,
            html,
        } => {
            let store = Store::open_any_read_only(&path).await.map_err(eval_err)?;
            let conv = resolve_root_conversation(&store, conversation.as_deref()).await.map_err(eval_err)?;
            let telemetry = if path.is_dir() {
                read_telemetry_jsonl(&path.join("telemetry.jsonl")).map_err(eval_err)?
            } else {
                Vec::new()
            };
            let metrics = analyze_store(&store, &conv, &telemetry).await.map_err(eval_err)?;
            if let Some(html_path) = html {
                let rendered = export_html(&store, &conv, &telemetry).await.map_err(eval_err)?;
                if let Some(parent) = Path::new(&html_path).parent()
                    && !parent.as_os_str().is_empty()
                {
                    fs::create_dir_all(parent).map_err(eval_err)?;
                }
                fs::write(&html_path, rendered).map_err(eval_err)?;
            }
            let rendered_timeline = if timeline {
                Some(render_timeline(&store, &conv).await.map_err(eval_err)?)
            } else {
                None
            };
            let _ = store.close().await;

            if output.json {
                if let Some(tl) = rendered_timeline {
                    output.show(&json!({ "metrics": metrics, "timeline": tl }), |_| String::new());
                } else {
                    output.show(&metrics, |_| String::new());
                }
                return Ok(());
            }
            output.show(&metrics, |m| {
                let summary = format!(
                    "conversation={} turns={} entries={} tools={} (errors={}, loops={}) compactions={} cost=${:.6} duration={}ms",
                    m.conversation_id,
                    m.turns,
                    m.entry_count,
                    m.tool_calls_total,
                    m.tool_errors_total,
                    m.repeated_tool_loops,
                    m.compactions,
                    m.cost_usd,
                    m.duration_ms
                );
                match &rendered_timeline {
                    Some(tl) => format!("{tl}\n{summary}"),
                    None => summary,
                }
            });
            Ok(())
        }
        EvalCommand::Replay { spec, out } => {
            if cli.dry_run {
                return Err(no_dry_run("eval replay"));
            }
            let raw = fs::read_to_string(&spec).map_err(eval_err)?;
            let parsed: ReplaySpec = serde_json::from_str(&raw).map_err(|e| Failure::usage("InvalidValue", e.to_string()))?;
            let client = resolve_deepseek_client()?;
            let outcome = run_replay(&parsed, &out, client).await.map_err(eval_err)?;
            output.show(&outcome, |o| {
                format!(
                    "replay {}@seq{} passed={} turns={} cost=${:.6} -> {}",
                    o.conversation_id,
                    o.at_seq,
                    o.passed,
                    o.metrics.turns,
                    o.metrics.cost_usd,
                    o.output_dir.display()
                )
            });
            Ok(())
        }
        EvalCommand::Run { suite, out, trials, profile } => {
            if cli.dry_run {
                return Err(no_dry_run("eval run"));
            }
            let raw = fs::read_to_string(&suite).map_err(eval_err)?;
            let mut parsed: EvalSuite = serde_json::from_str(&raw).map_err(|e| Failure::usage("InvalidValue", e.to_string()))?;
            if let Some(n) = trials {
                if n < 1 {
                    return Err(Failure::usage("InvalidValue", "--trials must be >= 1"));
                }
                parsed.trials = n as usize;
            }
            if !profile.is_empty() {
                parsed.profiles.retain(|p| profile.iter().any(|name| name == &p.name));
                if parsed.profiles.is_empty() {
                    return Err(Failure::usage("InvalidValue", "no matching profiles in suite"));
                }
            }
            let client = resolve_deepseek_client()?;
            let report = EvalRunner.run(&parsed, &out, move |_, _, _| client.clone()).await.map_err(eval_err)?;
            output.show(&report, |r| r.render_markdown());
            Ok(())
        }
    }
}

fn main() {
    std::process::exit(run_cli(std::env::args_os(), run));
}
