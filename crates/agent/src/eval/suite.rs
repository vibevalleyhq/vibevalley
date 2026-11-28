//! L3 isolated benchmark suite and balanced pairwise A/B runner (`EvalRunner`)
//! storing each trial in its own native `JsonlStorage` directory.

use std::collections::{BTreeMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::ai::ModelClient;
use crate::core::engine::Request;
use crate::core::inbox::WhenBusy;
use crate::durable::{Error, JsonlTelemetrySink, Result, TaskStatus, read_telemetry_jsonl};
use crate::harness::Harness;

use super::grader::{GradeContext, GraderResult, GraderSpec, evaluate_graders};
use super::profile::{EvalBrainProvider, EvalProfile, configure_profile_budget, mount_profile_extensions};
use super::stats::{EvalReport, compute_report};
use super::trace::{TraceMetrics, analyze_store, export_html};

fn default_true() -> bool {
    true
}

fn default_trials() -> usize {
    1
}

fn default_task_timeout() -> u64 {
    180
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorkspaceFixture {
    Empty {
        #[serde(default)]
        init_git: bool,
    },
    InlineFiles {
        files: BTreeMap<String, String>,
        #[serde(default = "default_true")]
        init_git: bool,
    },
    CopyDir {
        path: PathBuf,
        #[serde(default)]
        init_git: bool,
    },
    GitCheckout {
        repo: PathBuf,
        rev: String,
    },
}

impl Default for WorkspaceFixture {
    fn default() -> Self {
        Self::Empty { init_git: false }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalTask {
    pub id: String,
    pub prompt: String,
    #[serde(default)]
    pub workspace: WorkspaceFixture,
    #[serde(default)]
    pub graders: Vec<GraderSpec>,
    #[serde(default = "default_task_timeout")]
    pub timeout_secs: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalSuite {
    pub name: String,
    #[serde(default = "default_trials")]
    pub trials: usize,
    #[serde(default = "default_true")]
    pub balanced_order: bool,
    pub profiles: Vec<EvalProfile>,
    pub tasks: Vec<EvalTask>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialRecord {
    pub task_id: String,
    pub profile: String,
    pub trial: usize,
    pub passed: bool,
    pub error: Option<String>,
    pub final_output: String,
    pub metrics: TraceMetrics,
    pub grader_results: Vec<GraderResult>,
    pub store_dir: PathBuf,
    pub workspace_dir: PathBuf,
}

#[derive(Clone, Copy, Default)]
pub struct EvalRunner;

impl EvalRunner {
    /// Executes every `(task, trial)` across profiles in balanced rotated order, streaming each
    /// finished trial to `<out_dir>/results.jsonl` and writing `<out_dir>/report.{json,md}`.
    pub async fn run<F>(&self, suite: &EvalSuite, out_dir: &Path, client_factory: F) -> Result<EvalReport>
    where
        F: Fn(&EvalProfile, &EvalTask, usize) -> Arc<dyn ModelClient>,
    {
        if suite.profiles.is_empty() {
            return Err(Error::Invalid("eval suite has no profiles".into()));
        }
        if suite.tasks.is_empty() {
            return Err(Error::Invalid("eval suite has no tasks".into()));
        }
        if suite.trials == 0 {
            return Err(Error::Invalid("eval suite trials must be >= 1".into()));
        }
        let mut seen_profiles = HashSet::new();
        for p in &suite.profiles {
            if p.name.trim().is_empty() || !seen_profiles.insert(p.name.clone()) {
                return Err(Error::Invalid(format!("duplicate or empty profile name: {:?}", p.name)));
            }
        }
        let mut seen_tasks = HashSet::new();
        for t in &suite.tasks {
            if t.id.trim().is_empty() || !seen_tasks.insert(t.id.clone()) {
                return Err(Error::Invalid(format!("duplicate or empty task id: {:?}", t.id)));
            }
        }

        fs::create_dir_all(out_dir).map_err(|e| Error::Invalid(format!("create eval output {}: {e}", out_dir.display())))?;
        let results_path = out_dir.join("results.jsonl");
        let mut results_file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&results_path)
            .map_err(|e| Error::Invalid(format!("open {}: {e}", results_path.display())))?;

        let n_profiles = suite.profiles.len();
        let mut trials_out = Vec::with_capacity(suite.tasks.len() * suite.trials * n_profiles);

        for (task_idx, task) in suite.tasks.iter().enumerate() {
            for trial in 0..suite.trials {
                let order: Vec<usize> = if suite.balanced_order {
                    (0..n_profiles).map(|i| (i + trial + task_idx) % n_profiles).collect()
                } else {
                    (0..n_profiles).collect()
                };
                for p_idx in order {
                    let profile = &suite.profiles[p_idx];
                    let client = client_factory(profile, task, trial);
                    let record = run_single_trial(out_dir, task, profile, trial, client).await?;
                    let line = serde_json::to_string(&record)?;
                    results_file
                        .write_all(line.as_bytes())
                        .and_then(|_| results_file.write_all(b"\n"))
                        .and_then(|_| results_file.flush())
                        .map_err(|e| Error::Invalid(format!("write results.jsonl: {e}")))?;
                    trials_out.push(record);
                }
            }
        }

        let profile_order: Vec<String> = suite.profiles.iter().map(|p| p.name.clone()).collect();
        let report = compute_report(&suite.name, suite.trials, &profile_order, trials_out);
        let report_json = serde_json::to_string_pretty(&report)?;
        fs::write(out_dir.join("report.json"), report_json).map_err(|e| Error::Invalid(format!("write report.json: {e}")))?;
        fs::write(out_dir.join("report.md"), report.render_markdown()).map_err(|e| Error::Invalid(format!("write report.md: {e}")))?;
        Ok(report)
    }
}

async fn run_single_trial(out_dir: &Path, task: &EvalTask, profile: &EvalProfile, trial: usize, client: Arc<dyn ModelClient>) -> Result<TrialRecord> {
    let trial_dir = out_dir.join("trials").join(&task.id).join(&profile.name).join(format!("trial-{trial}"));
    if trial_dir.exists() {
        fs::remove_dir_all(&trial_dir).map_err(|e| Error::Invalid(format!("clean {}: {e}", trial_dir.display())))?;
    }
    let workspace_dir = trial_dir.join("workspace");
    let store_dir = trial_dir.join("store");
    provision_workspace(&task.workspace, &workspace_dir).await?;

    let conv_id = format!("eval:{}:{}:{}", task.id, profile.name, trial);
    let provider = Arc::new(EvalBrainProvider::new(profile.clone(), &workspace_dir, client.clone()));
    let telemetry_path = store_dir.join("telemetry.jsonl");
    let sink = Arc::new(JsonlTelemetrySink::open(&telemetry_path)?);
    let harness = Harness::open_jsonl(&store_dir, provider)?.with_telemetry(sink);
    mount_profile_extensions(&harness, profile, &workspace_dir, client.clone());
    configure_profile_budget(harness.store(), &conv_id, profile).await?;
    harness.recover().await?;

    let req_id = format!("trial-{}-{}-{}", task.id, profile.name, trial);
    let submit_res = harness
        .submit(Request {
            conversation: &conv_id,
            provider: &profile.model,
            request_id: &req_id,
            prompt: &task.prompt,
            source: "eval_suite",
            system: &profile.system_prompt,
            when_busy: WhenBusy::Reject,
            ..Default::default()
        })
        .await;

    let mut run_error: Option<String> = None;
    let final_output = match submit_res {
        Ok((_, task_rec, _)) => {
            let timeout = Duration::from_secs(task.timeout_secs.max(1));
            match harness.scheduler().wait(&task_rec.id, timeout).await {
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
                    let _ = harness.scheduler().abort(&task_rec.id).await;
                    run_error = Some(format!("trial timed out after {}s", timeout.as_secs()));
                    String::new()
                }
                Err(err) => {
                    run_error = Some(err.to_string());
                    String::new()
                }
            }
        }
        Err(err) => {
            run_error = Some(err.to_string());
            String::new()
        }
    };

    harness.close().await;
    let telemetry = read_telemetry_jsonl(&telemetry_path)?;
    let conv_read = conv_id.clone();
    let metrics = if harness
        .store()
        .read_async(move |r| Box::pin(async move { r.conversation_async(&conv_read).await }))
        .await
        .is_ok()
    {
        analyze_store(harness.store(), &conv_id, &telemetry).await?
    } else {
        TraceMetrics {
            conversation_id: conv_id.clone(),
            ..Default::default()
        }
    };
    if let Ok(html) = export_html(harness.store(), &conv_id, &telemetry).await {
        let _ = fs::write(trial_dir.join("transcript.html"), html);
    }
    let _ = harness.store().close().await;

    let grader_results = evaluate_graders(
        &task.graders,
        &GradeContext {
            workspace: &workspace_dir,
            task_prompt: &task.prompt,
            final_output: &final_output,
            metrics: &metrics,
            judge_client: Some(client),
            default_model: &profile.model,
        },
    )
    .await;
    let passed = run_error.is_none() && grader_results.iter().all(|g| g.passed);

    Ok(TrialRecord {
        task_id: task.id.clone(),
        profile: profile.name.clone(),
        trial,
        passed,
        error: run_error,
        final_output,
        metrics,
        grader_results,
        store_dir,
        workspace_dir,
    })
}

async fn provision_workspace(fixture: &WorkspaceFixture, dst: &Path) -> Result<()> {
    match fixture {
        WorkspaceFixture::Empty { init_git } => {
            fs::create_dir_all(dst).map_err(|e| Error::Invalid(format!("create workspace {}: {e}", dst.display())))?;
            if *init_git {
                init_git_repo(dst).await?;
            }
        }
        WorkspaceFixture::InlineFiles { files, init_git } => {
            fs::create_dir_all(dst).map_err(|e| Error::Invalid(format!("create workspace {}: {e}", dst.display())))?;
            for (rel, content) in files {
                let target = safe_join(dst, rel)?;
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|e| Error::Invalid(format!("create {}: {e}", parent.display())))?;
                }
                fs::write(&target, content).map_err(|e| Error::Invalid(format!("write {}: {e}", target.display())))?;
            }
            if *init_git {
                init_git_repo(dst).await?;
            }
        }
        WorkspaceFixture::CopyDir { path, init_git } => {
            copy_dir_all(path, dst)?;
            if *init_git && !dst.join(".git").exists() {
                init_git_repo(dst).await?;
            }
        }
        WorkspaceFixture::GitCheckout { repo, rev } => {
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent).map_err(|e| Error::Invalid(format!("create {}: {e}", parent.display())))?;
            }
            let cloned = vibevalley_git::clone_async(&repo.to_string_lossy(), dst)
                .await
                .map_err(|e| Error::Invalid(format!("git clone {} failed: {e}", repo.display())))?;
            let checkout = cloned
                .run_async(&["-c", "advice.detachedHead=false", "checkout", rev])
                .await
                .map_err(|e| Error::Invalid(format!("git checkout: {e}")))?;
            if !checkout.ok() {
                return Err(Error::Invalid(format!("git checkout {rev} failed: {}", checkout.stderr)));
            }
            run_git(&cloned, &["config", "user.name", "Eval"]).await?;
            run_git(&cloned, &["config", "user.email", "eval@local"]).await?;
        }
    }
    Ok(())
}

async fn init_git_repo(dir: &Path) -> Result<()> {
    let repo = vibevalley_git::init_async(dir, None)
        .await
        .map_err(|e| Error::Invalid(format!("git init: {e}")))?;
    run_git(&repo, &["config", "user.name", "Eval"]).await?;
    run_git(&repo, &["config", "user.email", "eval@local"]).await?;
    run_git(&repo, &["add", "-A"]).await?;
    run_git(
        &repo,
        &[
            "-c",
            "user.name=Eval",
            "-c",
            "user.email=eval@local",
            "commit",
            "--allow-empty",
            "-m",
            "fixture",
        ],
    )
    .await?;
    Ok(())
}

async fn run_git(repo: &vibevalley_git::Repo, args: &[&str]) -> Result<()> {
    let out = repo.run_async(args).await.map_err(|e| Error::Invalid(format!("git {}: {e}", args.join(" "))))?;
    if !out.ok() {
        return Err(Error::Invalid(format!("git {} failed: {}", args.join(" "), out.stderr)));
    }
    Ok(())
}

pub(crate) fn copy_dir_all(src: &Path, dst: &Path) -> Result<()> {
    if !src.is_dir() {
        return Err(Error::Invalid(format!("source directory does not exist: {}", src.display())));
    }
    fs::create_dir_all(dst).map_err(|e| Error::Invalid(format!("create {}: {e}", dst.display())))?;
    for entry in fs::read_dir(src).map_err(|e| Error::Invalid(format!("read {}: {e}", src.display())))? {
        let entry = entry.map_err(|e| Error::Invalid(format!("read_dir entry: {e}")))?;
        let ty = entry.file_type().map_err(|e| Error::Invalid(format!("file_type: {e}")))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&from, &to)?;
        } else if ty.is_file() {
            fs::copy(&from, &to).map_err(|e| Error::Invalid(format!("copy {} -> {}: {e}", from.display(), to.display())))?;
        }
    }
    Ok(())
}

fn safe_join(root: &Path, rel: &str) -> Result<PathBuf> {
    let p = Path::new(rel);
    if p.is_absolute() {
        return Err(Error::Invalid(format!("absolute path not allowed in fixture: {rel}")));
    }
    for comp in p.components() {
        if matches!(comp, Component::ParentDir | Component::Prefix(_) | Component::RootDir) {
            return Err(Error::Invalid(format!("path escapes fixture workspace: {rel}")));
        }
    }
    Ok(root.join(p))
}
