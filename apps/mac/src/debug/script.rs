//! Thin adapter for `VIBEVALLEY_DEBUG_DUMP` and `VIBEVALLEY_DEBUG_SCRIPT`.
//!
//! Preserves 100% backwards compatibility with existing `vv-acceptance` scripts
//! while delegating all window/shell actions to [`super::executor`].

use std::path::PathBuf;
use std::time::Duration;

use gpui::{App, AppContext as _, Entity, WindowHandle};
use serde_json::Value;

use crate::hosted::bridge;
use crate::shell::Shell;

use super::executor;

/// Parsed step from a single non-empty, non-comment line of `VIBEVALLEY_DEBUG_SCRIPT`.
#[derive(Debug, PartialEq)]
pub(crate) enum ScriptStep {
    WaitMs(u64),
    WaitUpdate,
    ShellCommand(String),
    ActionJson(Value),
}

pub(crate) fn parse_script_lines(contents: &str) -> Vec<String> {
    contents
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(str::to_string)
        .collect()
}

pub(crate) fn parse_script_step(line: &str) -> ScriptStep {
    let value: Value = serde_json::from_str(line).unwrap_or(Value::Null);
    if let Some(cmd) = value.get("shell").and_then(Value::as_str) {
        if let Some(ms) = cmd.strip_prefix("wait:") {
            return ScriptStep::WaitMs(ms.parse().unwrap_or(500));
        }
        if cmd == "wait_update" {
            return ScriptStep::WaitUpdate;
        }
        return ScriptStep::ShellCommand(cmd.to_string());
    }
    ScriptStep::ActionJson(value)
}

pub(crate) fn start(shell: Entity<Shell>, window: WindowHandle<Shell>, cx: &mut App) {
    if let Some(path) = std::env::var_os("VIBEVALLEY_DEBUG_DUMP").map(PathBuf::from) {
        let shell = shell.clone();
        cx.spawn(async move |cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(1000)).await;
                let value = cx.update(|cx| {
                    shell.update(cx, |s, cx| executor::step_unpainted_dioramas(s, cx));
                    executor::dump(shell.read(cx), cx)
                });
                let text = serde_json::to_string_pretty(&value).unwrap_or_default();
                let tmp = path.with_extension("tmp");
                if std::fs::write(&tmp, text).is_ok() {
                    let _ = std::fs::rename(&tmp, &path);
                }
            }
        })
        .detach();
    }

    if let Some(path) = std::env::var_os("VIBEVALLEY_DEBUG_SCRIPT").map(PathBuf::from) {
        let steps = parse_script_lines(&std::fs::read_to_string(&path).unwrap_or_default());
        cx.spawn(async move |cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(200)).await;
                if cx.update(|cx| shell.read(cx).workspace.loaded) {
                    break;
                }
            }
            for raw in steps {
                cx.background_executor().timer(Duration::from_millis(400)).await;
                eprintln!("debug script: {raw}");
                match parse_script_step(&raw) {
                    ScriptStep::WaitMs(ms) => {
                        cx.background_executor().timer(Duration::from_millis(ms)).await;
                    }
                    ScriptStep::WaitUpdate => {
                        let deadline = std::time::Instant::now() + Duration::from_secs(120);
                        while !crate::update::ready() && std::time::Instant::now() < deadline {
                            cx.background_executor().timer(Duration::from_millis(100)).await;
                        }
                        eprintln!("debug script: update ready={}", crate::update::ready());
                    }
                    ScriptStep::ShellCommand(cmd) => {
                        // Through the untyped handle: the typed one leases the root view, which `draw` renders.
                        let _ = cx.update_window(window.into(), |_, window, cx| match executor::run_window_command(&cmd, window, cx) {
                            Ok(true) => {}
                            Ok(false) => {
                                if let Err(err) = shell.update(cx, |s, cx| executor::run_shell_command(s, &cmd, window, cx)) {
                                    eprintln!("debug script: {err}");
                                }
                            }
                            Err(err) => eprintln!("debug script: {err}"),
                        });
                    }
                    ScriptStep::ActionJson(value) => match bridge::parse_action(&value) {
                        Ok(action) => {
                            let _ = window.update(cx, |s, window, cx| s.on_action(action, window, cx));
                        }
                        Err(e) => eprintln!("debug script: {e}"),
                    },
                }
            }
        })
        .detach();
    }
}
