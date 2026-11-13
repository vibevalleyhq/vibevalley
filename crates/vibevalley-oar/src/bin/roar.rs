//! `roar`: the oar-style command line over `vibevalley-oar`.

use std::collections::BTreeSet;
use std::io::{BufRead, IsTerminal, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use vibevalley_oar::{
    AgentError, ContentBlock, Event, EventKind, Installation, PermissionDecision, PermissionMode, SessionOptions, StopReason, default_runtimes, derive_status,
    read_record_with_header,
};

const USAGE: &str = "\
roar - drive local coding agents through one interface

USAGE:
  roar list
  roar models <runtime>
  roar run <runtime> \"<prompt>\" [--cwd DIR] [--model M] [--record FILE]
           [--permission ask|accept-edits|bypass|plan] [--resume SESSION_ID]
  roar replay <record.jsonl>

`run` streams the turn's events and asks on stdin when the agent requests a
permission (y = allow once, a = allow always, anything else = deny).";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("list") => list(),
        Some("models") => models(&args[1..]),
        Some("run") => run(&args[1..]),
        Some("replay") => replay(&args[1..]),
        Some("-h" | "--help" | "help") | None => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Some(other) => Err(Failure::Usage(format!("unknown command `{other}`"))),
    };
    match result {
        Ok(code) => code,
        Err(Failure::Usage(message)) => {
            eprintln!("roar: {message}\n\n{USAGE}");
            ExitCode::from(2)
        }
        Err(Failure::Agent(error)) => {
            eprintln!("roar: {error}");
            ExitCode::from(1)
        }
    }
}

enum Failure {
    Usage(String),
    Agent(AgentError),
}

impl From<AgentError> for Failure {
    fn from(error: AgentError) -> Self {
        Failure::Agent(error)
    }
}

fn list() -> Result<ExitCode, Failure> {
    let registry = default_runtimes();
    // Probes run a binary each; do them side by side.
    let rows: Vec<(String, String, Installation)> = std::thread::scope(|scope| {
        let probes: Vec<_> = registry
            .list()
            .iter()
            .map(|runtime| scope.spawn(move || (runtime.id().to_string(), runtime.display_name().to_string(), runtime.installation())))
            .collect();
        probes.into_iter().filter_map(|probe| probe.join().ok()).collect()
    });
    for (id, name, installation) in rows {
        let state = match installation {
            Installation::Available { version, path } => {
                format!("available  {}  {}", version.unwrap_or_else(|| "?".into()), path.display())
            }
            Installation::NotInstalled => "not installed".to_string(),
            Installation::Unusable { reason } => format!("unusable  {reason}"),
        };
        let capabilities = registry.get(&id).map(|r| r.capabilities()).unwrap_or_default();
        let flags = [
            ("resume", capabilities.resume),
            ("steer", capabilities.steer),
            ("queue", capabilities.queue),
            ("permissions", capabilities.permission_requests),
            ("models", capabilities.model_selection),
            ("subagents", capabilities.subagents),
            ("usage", capabilities.usage),
        ]
        .iter()
        .filter(|(_, on)| *on)
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join(",");
        println!("{id:<14} {name:<20} {state}\n{:<14} can: {flags}", "");
    }
    Ok(ExitCode::SUCCESS)
}

fn models(args: &[String]) -> Result<ExitCode, Failure> {
    let id = args.first().ok_or_else(|| Failure::Usage("models needs a runtime".into()))?;
    for model in default_runtimes().require(id)?.list_models()? {
        println!("{:<32} {}", model.id, model.display_name);
    }
    Ok(ExitCode::SUCCESS)
}

struct RunArgs {
    runtime: String,
    prompt: String,
    options: SessionOptions,
}

fn parse_run(args: &[String]) -> Result<RunArgs, Failure> {
    let mut positional = Vec::new();
    let mut options = SessionOptions {
        cwd: std::env::current_dir().unwrap_or_default(),
        ..Default::default()
    };
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let mut value = |flag: &str| iter.next().cloned().ok_or_else(|| Failure::Usage(format!("{flag} needs a value")));
        match arg.as_str() {
            "--cwd" => options.cwd = PathBuf::from(value("--cwd")?),
            "--model" => options.model = Some(value("--model")?),
            "--record" => options.record_to = Some(PathBuf::from(value("--record")?)),
            "--resume" => options.resume = Some(value("--resume")?),
            "--permission" => {
                options.permission_mode = match value("--permission")?.as_str() {
                    "ask" => PermissionMode::Ask,
                    "accept-edits" => PermissionMode::AcceptEdits,
                    "bypass" => PermissionMode::Bypass,
                    "plan" => PermissionMode::Plan,
                    other => return Err(Failure::Usage(format!("unknown permission mode `{other}`"))),
                }
            }
            flag if flag.starts_with("--") => return Err(Failure::Usage(format!("unknown flag `{flag}`"))),
            _ => positional.push(arg.clone()),
        }
    }
    let [runtime, prompt] = positional
        .try_into()
        .map_err(|_| Failure::Usage("run needs <runtime> and \"<prompt>\"".into()))?;
    Ok(RunArgs { runtime, prompt, options })
}

fn short(text: &str, limit: usize) -> String {
    let flat = text.replace('\n', "\\n");
    if flat.chars().count() <= limit {
        flat
    } else {
        format!("{}...", flat.chars().take(limit).collect::<String>())
    }
}

fn kind_name(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::SessionStarted { .. } => "session_started",
        EventKind::TurnStarted { .. } => "turn_started",
        EventKind::TextDelta { .. } => "text_delta",
        EventKind::ThinkingDelta { .. } => "thinking_delta",
        EventKind::ToolCallStarted { .. } => "tool_call_started",
        EventKind::ToolCallFinished { .. } => "tool_call_finished",
        EventKind::FileChanged { .. } => "file_changed",
        EventKind::PermissionRequested { .. } => "permission_requested",
        EventKind::PermissionResolved { .. } => "permission_resolved",
        EventKind::Question { .. } => "question",
        EventKind::TurnFinished { .. } => "turn_finished",
        EventKind::Error { .. } => "error",
        EventKind::SessionEnded => "session_ended",
    }
}

/// Streams deltas inline and everything else on its own bracketed line.
#[derive(Default)]
struct Printer {
    streaming: Option<&'static str>,
    kinds: BTreeSet<&'static str>,
}

impl Printer {
    fn line(&mut self, text: String) {
        if self.streaming.take().is_some() {
            println!();
        }
        println!("{text}");
    }

    fn delta(&mut self, label: &'static str, prefix: &str, text: &str) {
        if self.streaming != Some(label) {
            if self.streaming.is_some() {
                println!();
            }
            print!("{prefix}");
            self.streaming = Some(label);
        }
        print!("{text}");
        let _ = std::io::stdout().flush();
    }

    fn event(&mut self, event: &Event) {
        self.kinds.insert(kind_name(&event.kind));
        let who = if event.agent_path.is_empty() {
            String::new()
        } else {
            format!("<{}> ", event.agent_path.join("/"))
        };
        match &event.kind {
            EventKind::SessionStarted { session_id, model } => {
                self.line(format!("[session {session_id}  model {}]", model.as_deref().unwrap_or("default")));
            }
            EventKind::TurnStarted { prompt } => self.line(format!("{who}[turn] {}", short(prompt, 200))),
            EventKind::TextDelta { text } => {
                if who.is_empty() {
                    self.delta("text", "", text);
                } else {
                    self.line(format!("{who}{}", short(text, 400)));
                }
            }
            EventKind::ThinkingDelta { text } => {
                if who.is_empty() {
                    self.delta("thinking", "[thinking] ", text);
                } else {
                    self.line(format!("{who}[thinking] {}", short(text, 400)));
                }
            }
            EventKind::ToolCallStarted { id, name, input } => {
                self.line(format!("{who}[tool {name} {id}] {}", short(&input.to_string(), 300)));
            }
            EventKind::ToolCallFinished { id, ok, output } => {
                self.line(format!("{who}[tool {} {id}] {}", if *ok { "ok" } else { "failed" }, short(output, 300)));
            }
            EventKind::FileChanged { path, change } => {
                self.line(format!("{who}[file {}] {}", format!("{change:?}").to_lowercase(), path.display()));
            }
            EventKind::PermissionRequested { request_id, summary, .. } => {
                self.line(format!("{who}[permission {request_id}] {summary}"));
            }
            EventKind::PermissionResolved { request_id, decision } => {
                self.line(format!("{who}[permission {request_id}] -> {decision:?}"));
            }
            EventKind::Question { text } => self.line(format!("{who}[question] {text}")),
            EventKind::TurnFinished { reason, usage } => {
                let number = |value: Option<u64>| value.map(|v| v.to_string()).unwrap_or_else(|| "?".into());
                let cost = usage.cost_usd.map(|c| format!("  cost ${c:.4}")).unwrap_or_default();
                self.line(format!(
                    "{who}[turn {}]  in {}  out {}{cost}",
                    format!("{reason:?}").to_lowercase(),
                    number(usage.input_tokens),
                    number(usage.output_tokens)
                ));
            }
            EventKind::Error { message } => self.line(format!("{who}[error] {message}")),
            EventKind::SessionEnded => self.line("[session ended]".into()),
        }
    }
}

fn ask(summary: &str, input: &serde_json::Value) -> PermissionDecision {
    let stdin = std::io::stdin();
    if !stdin.is_terminal() {
        // Piped input may still carry answers; an empty pipe denies.
        eprint!("allow? [y]es / [a]lways / [N]o: ");
    } else {
        eprintln!("  {}", short(&input.to_string(), 600));
        eprint!("allow `{summary}`? [y]es / [a]lways / [N]o: ");
    }
    let mut answer = String::new();
    if stdin.lock().read_line(&mut answer).unwrap_or(0) == 0 {
        eprintln!("(no input: denied)");
        return PermissionDecision::Deny {
            message: Some("no one was there to approve".into()),
        };
    }
    match answer.trim().to_ascii_lowercase().as_str() {
        "y" | "yes" => PermissionDecision::AllowOnce,
        "a" | "always" => PermissionDecision::AllowAlways,
        _ => PermissionDecision::Deny { message: None },
    }
}

fn run(args: &[String]) -> Result<ExitCode, Failure> {
    let RunArgs { runtime, prompt, options } = parse_run(args)?;
    let runtime = default_runtimes().require(&runtime)?;
    let session = runtime.open(options)?;
    let events = session.events_with_history();
    session.prompt(vec![ContentBlock::Text(prompt)])?;
    let mut printer = Printer::default();
    let mut outcome = None;
    for event in events.iter() {
        printer.event(&event);
        match &event.kind {
            EventKind::PermissionRequested {
                request_id, summary, input, ..
            } => {
                let decision = ask(summary, input);
                if let Err(error) = session.respond_permission(request_id, decision) {
                    eprintln!("roar: {error}");
                }
            }
            EventKind::TurnFinished { reason, .. } if event.agent_path.is_empty() => {
                outcome = Some(reason.clone());
                session.dispose();
            }
            EventKind::SessionEnded => break,
            _ => {}
        }
    }
    eprintln!("event kinds: {}", printer.kinds.into_iter().collect::<Vec<_>>().join(" "));
    eprintln!("resume with: --resume {}", session.id());
    Ok(match outcome {
        Some(StopReason::Completed) => ExitCode::SUCCESS,
        _ => ExitCode::from(1),
    })
}

fn replay(args: &[String]) -> Result<ExitCode, Failure> {
    let path = args.first().ok_or_else(|| Failure::Usage("replay needs a record file".into()))?;
    let (header, events) = read_record_with_header(std::path::Path::new(path))?;
    if let Some(header) = header {
        println!(
            "[record {}  runtime {}  session {}  cwd {}  by {}]",
            header.format,
            header.runtime,
            header.session_id,
            header.cwd.display(),
            header.recorder
        );
    }
    let mut printer = Printer::default();
    for event in &events {
        printer.event(event);
    }
    printer.line(format!("[{} events  final status {:?}]", events.len(), derive_status(&events)));
    Ok(ExitCode::SUCCESS)
}
