//! `eval`: extract durable trajectories to JSONL, inspect traces/HTML, replay slices,
//! and run balanced isolated evaluation suites.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use clap::{ArgMatches, Command};
use serde_json::json;
use vibevalley_i18n::t;
use vibevalley_runtime::agent::OpenAiClient;
use vibevalley_runtime::agent::ai::types::ModelClient;
use vibevalley_runtime::agent::durable::{ExportOptions, Store, read_telemetry_jsonl};
use vibevalley_runtime::agent::eval::{EvalRunner, EvalSuite, ReplaySpec, analyze_store, export_html, render_timeline, resolve_root_conversation, run_replay};

use crate::farm::{Ctx, Done, Failure, Format, exit, no_dry_run};
use crate::tree::{all, arg, cmd, flag, get, group, int, many, number, on, pos, text};

pub fn command() -> Command {
    group(
        "eval",
        "cli.eval.about",
        vec![
            cmd(
                "export",
                "cli.eval.export",
                &[("vibevalley eval export conv-1 --out /tmp/trace", "cli.eval.export")],
            )
            .args([
                pos("conversation", "cli.eval.arg.conversation"),
                text("out", "cli.eval.flag.out").required(true),
                text("source", "cli.eval.flag.source"),
                int("at-seq", "cli.eval.flag.atSeq"),
                flag("no-children", "cli.eval.flag.noChildren"),
            ]),
            cmd(
                "inspect",
                "cli.eval.inspect",
                &[("vibevalley eval inspect /tmp/trace --timeline --html /tmp/trace.html", "cli.eval.inspect")],
            )
            .args([
                pos("path", "cli.eval.arg.path"),
                text("conversation", "cli.eval.flag.conversation"),
                flag("timeline", "cli.eval.flag.timeline"),
                text("html", "cli.eval.flag.html"),
            ]),
            cmd(
                "replay",
                "cli.eval.replay",
                &[("vibevalley eval replay ./replay.json --out /tmp/replay", "cli.eval.replay")],
            )
            .args([pos("spec", "cli.eval.arg.spec"), text("out", "cli.eval.flag.out").required(true)]),
            cmd(
                "run",
                "cli.eval.run",
                &[("vibevalley eval run ./suite.json --out /tmp/eval-out --trials 3", "cli.eval.run")],
            )
            .args([
                pos("suite", "cli.eval.arg.suite"),
                text("out", "cli.eval.flag.out").required(true),
                int("trials", "cli.eval.flag.trials"),
                many("profile", "cli.eval.flag.profile"),
            ]),
        ],
    )
}

pub fn run(ctx: &Ctx, m: &ArgMatches) -> Done {
    match m.subcommand() {
        Some(("export", sub)) => run_export(ctx, sub),
        Some(("inspect", sub)) => run_inspect(ctx, sub),
        Some(("replay", sub)) => run_replay_cmd(ctx, sub),
        Some(("run", sub)) => run_suite_cmd(ctx, sub),
        _ => Ok(()),
    }
}

fn eval_err(e: impl std::fmt::Display) -> Failure {
    Failure::new(exit::OTHER, "Eval", e.to_string())
}

fn resolve_deepseek_client() -> Result<Arc<dyn ModelClient>, Failure> {
    let key = std::env::var("DEEPSEEK_API_KEY")
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .or_else(|| vibevalley_protocol::home::saved_deepseek_key(&vibevalley_protocol::home::home()));
    let Some(key) = key else {
        return Err(Failure::new(exit::REFUSED, "NoKey", t("cli.eval.missingKey", &[])));
    };
    Ok(Arc::new(OpenAiClient::deepseek(move || Some(key.clone()))))
}

fn run_export(ctx: &Ctx, sub: &ArgMatches) -> Done {
    if ctx.dry_run {
        return Err(no_dry_run("eval export"));
    }
    let conv = arg(sub, "conversation");
    let out = arg(sub, "out");
    let source_path = get(sub, "source")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| vibevalley_protocol::home::home().join("server.db"));
    let at_seq = number(sub, "at-seq");
    if let Some(seq) = at_seq
        && seq < 0
    {
        return Err(Failure::usage("InvalidValue", "--at-seq must be >= 0"));
    }
    let include_children = !on(sub, "no-children");
    let source = Store::open_any_read_only(&source_path).map_err(eval_err)?;
    let manifest = source
        .export_conversation_jsonl(
            &conv,
            Path::new(&out),
            ExportOptions {
                at_seq,
                include_children,
                fsync: true,
            },
        )
        .map_err(eval_err)?;
    let _ = source.close();

    ctx.show(&manifest, |m| {
        format!(
            "exported {} ({} conversations, {} entries, {} tasks, {} docs) -> {}",
            m.root_conversation_id, m.conversations_exported, m.entries_exported, m.tasks_exported, m.documents_exported, out
        )
    });
    Ok(())
}

fn run_inspect(ctx: &Ctx, sub: &ArgMatches) -> Done {
    let path_str = arg(sub, "path");
    let path = Path::new(&path_str);
    let conv_opt = get(sub, "conversation");
    let show_timeline = on(sub, "timeline");
    let html_out = get(sub, "html");

    let store = Store::open_any_read_only(path).map_err(eval_err)?;
    let conv = resolve_root_conversation(&store, conv_opt.as_deref()).map_err(eval_err)?;
    let telemetry = if path.is_dir() {
        read_telemetry_jsonl(&path.join("telemetry.jsonl")).map_err(eval_err)?
    } else {
        Vec::new()
    };
    let metrics = analyze_store(&store, &conv, &telemetry).map_err(eval_err)?;

    if let Some(html_path) = html_out {
        let html = export_html(&store, &conv, &telemetry).map_err(eval_err)?;
        if let Some(parent) = Path::new(&html_path).parent()
            && !parent.as_os_str().is_empty()
        {
            fs::create_dir_all(parent).map_err(eval_err)?;
        }
        fs::write(&html_path, html).map_err(eval_err)?;
    }

    let timeline = if show_timeline {
        Some(render_timeline(&store, &conv).map_err(eval_err)?)
    } else {
        None
    };
    let _ = store.close();

    if ctx.format == Format::Json {
        if let Some(tl) = timeline {
            let payload = json!({ "metrics": metrics, "timeline": tl });
            ctx.show(&payload, |_| String::new());
        } else {
            ctx.show(&metrics, |_| String::new());
        }
        return Ok(());
    }

    ctx.show(&metrics, |m| {
        let summary = format!(
            "conversation={} turns={} entries={} tools={} (errors={}, loops={}) compactions={} cost=${:.6} duration={}ms",
            m.conversation_id, m.turns, m.entry_count, m.tool_calls_total, m.tool_errors_total, m.repeated_tool_loops, m.compactions, m.cost_usd, m.duration_ms
        );
        match &timeline {
            Some(tl) => format!("{tl}\n{summary}"),
            None => summary,
        }
    });
    Ok(())
}

fn run_replay_cmd(ctx: &Ctx, sub: &ArgMatches) -> Done {
    if ctx.dry_run {
        return Err(no_dry_run("eval replay"));
    }
    let spec_path = arg(sub, "spec");
    let out = arg(sub, "out");
    let raw = fs::read_to_string(&spec_path).map_err(eval_err)?;
    let spec: ReplaySpec = serde_json::from_str(&raw).map_err(|e| Failure::usage("InvalidValue", e.to_string()))?;
    let client = resolve_deepseek_client()?;
    let outcome = run_replay(&spec, Path::new(&out), client).map_err(eval_err)?;
    ctx.show(&outcome, |o| {
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

fn run_suite_cmd(ctx: &Ctx, sub: &ArgMatches) -> Done {
    if ctx.dry_run {
        return Err(no_dry_run("eval run"));
    }
    let suite_path = arg(sub, "suite");
    let out = arg(sub, "out");
    let raw = fs::read_to_string(&suite_path).map_err(eval_err)?;
    let mut suite: EvalSuite = serde_json::from_str(&raw).map_err(|e| Failure::usage("InvalidValue", e.to_string()))?;

    if let Some(n) = number(sub, "trials") {
        if n < 1 {
            return Err(Failure::usage("InvalidValue", "--trials must be >= 1"));
        }
        suite.trials = n as usize;
    }
    let selected = all(sub, "profile");
    if !selected.is_empty() {
        suite.profiles.retain(|p| selected.iter().any(|name| name == &p.name));
        if suite.profiles.is_empty() {
            return Err(Failure::usage("InvalidValue", "no matching profiles in suite"));
        }
    }

    let client = resolve_deepseek_client()?;
    let report = EvalRunner.run(&suite, Path::new(&out), move |_, _, _| client.clone()).map_err(eval_err)?;
    ctx.show(&report, |r| r.render_markdown());
    Ok(())
}
