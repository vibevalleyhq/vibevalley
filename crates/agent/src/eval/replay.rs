//! L2 JSONL prefix-slice replay: branch a recorded conversation at `at_seq` into an
//! isolated JSONL store and workspace without mutating the source fixture.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::ai::ModelClient;
use crate::core::engine::Request;
use crate::core::inbox::WhenBusy;
use crate::durable::{Error, ExportOptions, JsonlTelemetrySink, Result, Store, TaskStatus, read_telemetry_jsonl};
use crate::harness::Harness;

use super::grader::{GradeContext, GraderResult, GraderSpec, evaluate_graders};
use super::profile::{EvalBrainProvider, EvalProfile, configure_profile_budget, mount_profile_extensions};
use super::suite::copy_dir_all;
use super::trace::{TraceMetrics, analyze_store, export_html, resolve_root_conversation};

fn default_replay_timeout() -> u64 {
    120
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaySpec {
    pub source_path: PathBuf,
    #[serde(default)]
    pub conversation_id: Option<String>,
    pub at_seq: i64,
    pub prompt: String,
    #[serde(default)]
    pub workspace: Option<PathBuf>,
    #[serde(default)]
    pub profile: EvalProfile,
    #[serde(default)]
    pub graders: Vec<GraderSpec>,
    #[serde(default = "default_replay_timeout")]
    pub timeout_secs: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayOutcome {
    pub conversation_id: String,
    pub at_seq: i64,
    pub output_dir: PathBuf,
    pub final_output: String,
    pub metrics: TraceMetrics,
    pub grader_results: Vec<GraderResult>,
    pub passed: bool,
}

/// Exports `[1..=at_seq]` from SQLite or JSONL into `<out_dir>/store`, provisions `<out_dir>/workspace`,
/// executes one durable generation turn, and runs any configured graders.
pub async fn run_replay(spec: &ReplaySpec, out_dir: &Path, client: Arc<dyn ModelClient>) -> Result<ReplayOutcome> {
    fs::create_dir_all(out_dir).map_err(|e| Error::Invalid(format!("create replay dir {}: {e}", out_dir.display())))?;
    let source = Store::open_any_read_only(&spec.source_path).await?;
    let conv_id = resolve_root_conversation(&source, spec.conversation_id.as_deref()).await?;

    let store_dir = out_dir.join("store");
    let workspace_dir = out_dir.join("workspace");
    if store_dir.exists() {
        fs::remove_dir_all(&store_dir).map_err(|e| Error::Invalid(format!("clean replay store {}: {e}", store_dir.display())))?;
    }
    if workspace_dir.exists() {
        fs::remove_dir_all(&workspace_dir).map_err(|e| Error::Invalid(format!("clean replay workspace {}: {e}", workspace_dir.display())))?;
    }
    fs::create_dir_all(&workspace_dir).map_err(|e| Error::Invalid(format!("create workspace {}: {e}", workspace_dir.display())))?;
    if let Some(ws) = &spec.workspace {
        copy_dir_all(ws, &workspace_dir)?;
    }

    source
        .export_conversation_jsonl(
            &conv_id,
            &store_dir,
            ExportOptions {
                at_seq: Some(spec.at_seq),
                include_children: false,
                fsync: true,
            },
        )
        .await?;
    let _ = source.close().await;

    let provider = Arc::new(EvalBrainProvider::new(spec.profile.clone(), &workspace_dir, client.clone()));
    let telemetry_path = store_dir.join("telemetry.jsonl");
    let telemetry_sink = Arc::new(JsonlTelemetrySink::open(&telemetry_path)?);
    let harness = Harness::open_jsonl(&store_dir, provider)?.with_telemetry(telemetry_sink);
    mount_profile_extensions(&harness, &spec.profile, &workspace_dir, client.clone());
    configure_profile_budget(harness.store(), &conv_id, &spec.profile).await?;
    harness.recover().await?;

    let req_id = format!("eval-replay-{}", uuid::Uuid::now_v7());
    let (_, task, _) = harness
        .submit(Request {
            conversation: &conv_id,
            provider: &spec.profile.model,
            request_id: &req_id,
            prompt: &spec.prompt,
            source: "eval_replay",
            system: &spec.profile.system_prompt,
            when_busy: WhenBusy::Reject,
            ..Default::default()
        })
        .await?;

    let timeout = Duration::from_secs(spec.timeout_secs.max(1));
    let mut run_error: Option<String> = None;
    let final_output = match harness.scheduler().wait(&task.id, timeout).await {
        Ok(done) => {
            if done.status == TaskStatus::Terminal && done.terminal_reason != "completed" {
                run_error = Some(if done.error_text.is_empty() {
                    format!("task ended with {}", done.terminal_reason)
                } else {
                    done.error_text
                });
            }
            done.result["output"].as_str().unwrap_or_default().to_owned()
        }
        Err(Error::Timeout) => {
            let _ = harness.scheduler().abort(&task.id).await;
            run_error = Some(format!("replay timed out after {}s", timeout.as_secs()));
            String::new()
        }
        Err(err) => {
            run_error = Some(err.to_string());
            String::new()
        }
    };

    harness.close().await;
    let telemetry = read_telemetry_jsonl(&telemetry_path)?;
    let metrics = analyze_store(harness.store(), &conv_id, &telemetry).await?;
    let html = export_html(harness.store(), &conv_id, &telemetry).await?;
    let _ = fs::write(out_dir.join("transcript.html"), html);
    let _ = harness.store().close().await;

    let grader_results = evaluate_graders(
        &spec.graders,
        &GradeContext {
            workspace: &workspace_dir,
            task_prompt: &spec.prompt,
            final_output: &final_output,
            metrics: &metrics,
            judge_client: Some(client),
            default_model: &spec.profile.model,
        },
    )
    .await;
    let passed = run_error.is_none() && grader_results.iter().all(|g| g.passed);
    let outcome = ReplayOutcome {
        conversation_id: conv_id,
        at_seq: spec.at_seq,
        output_dir: out_dir.to_path_buf(),
        final_output,
        metrics,
        grader_results,
        passed,
    };
    let result_json = serde_json::to_string_pretty(&outcome)?;
    fs::write(out_dir.join("replay_result.json"), result_json).map_err(|e| Error::Invalid(format!("write replay_result.json: {e}")))?;
    Ok(outcome)
}
