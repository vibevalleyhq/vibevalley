//! Unbiased `pass@k`, `pass^k`, per-profile aggregates, and paired A/B comparison stats
//! aligned with `pi-coding-agent-eval`.

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;

use serde::{Deserialize, Serialize};

use super::suite::TrialRecord;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStats {
    pub profile: String,
    pub trials: usize,
    pub passed: usize,
    pub pass_rate: f64,
    pub pass_at_k: f64,
    pub pass_pow_k: f64,
    pub avg_turns: f64,
    pub avg_tool_calls: f64,
    pub avg_tool_errors: f64,
    pub total_cost_usd: f64,
    pub avg_cost_usd: f64,
    pub avg_duration_ms: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPairDelta {
    pub task_id: String,
    pub pass_rate_a: f64,
    pub pass_rate_b: f64,
    pub pass_rate_delta: f64,
    pub avg_turns_delta: f64,
    pub avg_cost_delta_usd: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairwiseComparison {
    pub profile_a: String,
    pub profile_b: String,
    pub tasks_compared: usize,
    pub wins_a: usize,
    pub wins_b: usize,
    pub ties: usize,
    pub mean_pass_rate_delta: f64,
    pub mean_turns_delta: f64,
    pub mean_cost_delta_usd: f64,
    pub by_task: Vec<TaskPairDelta>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalReport {
    pub suite_name: String,
    pub trials_per_task: usize,
    pub profiles: Vec<ProfileStats>,
    pub pairwise: Vec<PairwiseComparison>,
    pub trials: Vec<TrialRecord>,
}

/// Unbiased estimator of `1 - C(n - c, k) / C(n, k)` (Chen et al., Codex).
pub fn pass_at_k(n: usize, c: usize, k: usize) -> f64 {
    if n == 0 || k == 0 || c == 0 {
        return 0.0;
    }
    let k = k.min(n);
    if n - c < k {
        return 1.0;
    }
    let mut fail_prob = 1.0;
    for i in 0..k {
        fail_prob *= (n - c - i) as f64 / (n - i) as f64;
    }
    (1.0 - fail_prob).clamp(0.0, 1.0)
}

/// Reliability estimator `(c / n)^k`: probability that all `k` trials succeed.
pub fn pass_pow_k(n: usize, c: usize, k: usize) -> f64 {
    if n == 0 || k == 0 || c == 0 {
        return 0.0;
    }
    let k = k.min(n);
    (c as f64 / n as f64).powi(k as i32).clamp(0.0, 1.0)
}

pub fn compute_report(suite_name: &str, trials_per_task: usize, profile_order: &[String], trials: Vec<TrialRecord>) -> EvalReport {
    let mut by_profile: HashMap<&str, Vec<&TrialRecord>> = HashMap::new();
    for tr in &trials {
        by_profile.entry(tr.profile.as_str()).or_default().push(tr);
    }

    let mut profiles = Vec::with_capacity(profile_order.len());
    for name in profile_order {
        let rows = by_profile.get(name.as_str()).map(Vec::as_slice).unwrap_or(&[]);
        let n_total = rows.len();
        let passed_total = rows.iter().filter(|r| r.passed).count();
        let pass_rate = if n_total > 0 { passed_total as f64 / n_total as f64 } else { 0.0 };

        let mut by_task: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
        let mut sum_turns = 0.0;
        let mut sum_tools = 0.0;
        let mut sum_tool_errs = 0.0;
        let mut total_cost = 0.0;
        let mut sum_dur = 0.0;
        for r in rows {
            let entry = by_task.entry(r.task_id.as_str()).or_default();
            entry.0 += 1;
            if r.passed {
                entry.1 += 1;
            }
            sum_turns += r.metrics.turns as f64;
            sum_tools += r.metrics.tool_calls_total as f64;
            sum_tool_errs += r.metrics.tool_errors_total as f64;
            total_cost += r.metrics.cost_usd;
            sum_dur += r.metrics.duration_ms as f64;
        }

        let task_count = by_task.len().max(1) as f64;
        let mean_pass_at_k = if by_task.is_empty() {
            0.0
        } else {
            by_task.values().map(|&(tn, tc)| pass_at_k(tn, tc, trials_per_task)).sum::<f64>() / task_count
        };
        let mean_pass_pow_k = if by_task.is_empty() {
            0.0
        } else {
            by_task.values().map(|&(tn, tc)| pass_pow_k(tn, tc, trials_per_task)).sum::<f64>() / task_count
        };

        let denom = n_total.max(1) as f64;
        profiles.push(ProfileStats {
            profile: name.clone(),
            trials: n_total,
            passed: passed_total,
            pass_rate,
            pass_at_k: mean_pass_at_k,
            pass_pow_k: mean_pass_pow_k,
            avg_turns: sum_turns / denom,
            avg_tool_calls: sum_tools / denom,
            avg_tool_errors: sum_tool_errs / denom,
            total_cost_usd: total_cost,
            avg_cost_usd: total_cost / denom,
            avg_duration_ms: sum_dur / denom,
        });
    }

    let mut task_ids: Vec<String> = trials.iter().map(|t| t.task_id.clone()).collect();
    task_ids.sort();
    task_ids.dedup();

    let mut pairwise = Vec::new();
    for i in 0..profile_order.len() {
        for j in (i + 1)..profile_order.len() {
            let a = &profile_order[i];
            let b = &profile_order[j];
            let mut by_task = Vec::new();
            let mut wins_a = 0usize;
            let mut wins_b = 0usize;
            let mut ties = 0usize;
            for task_id in &task_ids {
                let rows_a: Vec<_> = trials.iter().filter(|t| t.task_id == *task_id && t.profile == *a).collect();
                let rows_b: Vec<_> = trials.iter().filter(|t| t.task_id == *task_id && t.profile == *b).collect();
                if rows_a.is_empty() || rows_b.is_empty() {
                    continue;
                }
                let (pa, ta, ca) = aggregate_task_slice(&rows_a);
                let (pb, tb, cb) = aggregate_task_slice(&rows_b);
                if (pa - pb).abs() <= 1e-9 {
                    ties += 1;
                } else if pa > pb {
                    wins_a += 1;
                } else {
                    wins_b += 1;
                }
                by_task.push(TaskPairDelta {
                    task_id: task_id.clone(),
                    pass_rate_a: pa,
                    pass_rate_b: pb,
                    pass_rate_delta: pb - pa,
                    avg_turns_delta: tb - ta,
                    avg_cost_delta_usd: cb - ca,
                });
            }
            let count = by_task.len().max(1) as f64;
            let mean_pass_rate_delta = by_task.iter().map(|d| d.pass_rate_delta).sum::<f64>() / count;
            let mean_turns_delta = by_task.iter().map(|d| d.avg_turns_delta).sum::<f64>() / count;
            let mean_cost_delta_usd = by_task.iter().map(|d| d.avg_cost_delta_usd).sum::<f64>() / count;
            pairwise.push(PairwiseComparison {
                profile_a: a.clone(),
                profile_b: b.clone(),
                tasks_compared: by_task.len(),
                wins_a,
                wins_b,
                ties,
                mean_pass_rate_delta,
                mean_turns_delta,
                mean_cost_delta_usd,
                by_task,
            });
        }
    }

    EvalReport {
        suite_name: suite_name.to_owned(),
        trials_per_task,
        profiles,
        pairwise,
        trials,
    }
}

fn aggregate_task_slice(rows: &[&TrialRecord]) -> (f64, f64, f64) {
    let n = rows.len().max(1) as f64;
    let passed = rows.iter().filter(|r| r.passed).count() as f64 / n;
    let turns = rows.iter().map(|r| r.metrics.turns as f64).sum::<f64>() / n;
    let cost = rows.iter().map(|r| r.metrics.cost_usd).sum::<f64>() / n;
    (passed, turns, cost)
}

impl EvalReport {
    pub fn render_markdown(&self) -> String {
        let mut md = String::new();
        let _ = writeln!(md, "# Eval Report: {} (`k = {}`)\n", self.suite_name, self.trials_per_task);
        md.push_str("## Profile Summary\n\n");
        md.push_str("| Profile | Passed | Pass Rate | pass@k | pass^k | Avg Turns | Avg Tools | Tool Errors | Total Cost |\n");
        md.push_str("|---|---|---|---|---|---|---|---|---|\n");
        for p in &self.profiles {
            let _ = writeln!(
                md,
                "| {} | {}/{} | {:.1}% | {:.1}% | {:.1}% | {:.2} | {:.2} | {:.2} | ${:.6} |",
                p.profile,
                p.passed,
                p.trials,
                p.pass_rate * 100.0,
                p.pass_at_k * 100.0,
                p.pass_pow_k * 100.0,
                p.avg_turns,
                p.avg_tool_calls,
                p.avg_tool_errors,
                p.total_cost_usd
            );
        }
        if !self.pairwise.is_empty() {
            md.push_str("\n## Pairwise Comparison\n\n");
            md.push_str("| A vs B | Tasks | Wins (A / B / Tie) | Pass Delta (B-A) | Turns Delta | Cost Delta |\n");
            md.push_str("|---|---|---|---|---|---|\n");
            for cmp in &self.pairwise {
                let _ = writeln!(
                    md,
                    "| {} vs {} | {} | {} / {} / {} | {:+.1}% | {:+.2} | ${:+.6} |",
                    cmp.profile_a,
                    cmp.profile_b,
                    cmp.tasks_compared,
                    cmp.wins_a,
                    cmp.wins_b,
                    cmp.ties,
                    cmp.mean_pass_rate_delta * 100.0,
                    cmp.mean_turns_delta,
                    cmp.mean_cost_delta_usd
                );
            }
        }
        md
    }
}
