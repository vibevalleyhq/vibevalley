//! Systematic evaluation suite aligned with `pi-durable` (JSONL extraction,
//! telemetry, slice replay) and `pi-coding-agent-eval` (profiles, isolated workspaces,
//! balanced pairwise statistics).

pub mod grader;
pub mod profile;
pub mod replay;
pub mod stats;
pub mod suite;
pub mod trace;

pub use grader::{GradeContext, GraderResult, GraderSpec, evaluate_graders};
pub use profile::{DEFAULT_EVAL_SYSTEM, EvalProfile, build_profile_tools, mount_profile_extensions};
pub use replay::{ReplayOutcome, ReplaySpec, run_replay};
pub use stats::{EvalReport, PairwiseComparison, ProfileStats, TaskPairDelta, compute_report, pass_at_k, pass_pow_k};
pub use suite::{EvalRunner, EvalSuite, EvalTask, TrialRecord, WorkspaceFixture};
pub use trace::{TraceMetrics, analyze_path, analyze_store, export_html, render_timeline, resolve_root_conversation};
