//! The structured report an agent hands back at the end of a round through
//! the `issue_report` tool (`SessionEngine::report`). A round with no report is
//! read from what the agent said.

use std::path::Path;

use serde::{Deserialize, Serialize};
use vibevalley_protocol::{CriterionCheck, Deliverable, DeliveryReceipt, IssueAnswer, IssueReportMemory, Question};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportStatus {
    /// The work is done and committed.
    #[default]
    Done,
    /// The agent cannot go on without an answer.
    Blocked,
    /// The agent tried and could not do it.
    Failed,
}

/// A question as a string, or with options.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ReportQuestion {
    Text(String),
    Full {
        question: String,
        #[serde(default)]
        options: Vec<String>,
    },
}

impl ReportQuestion {
    pub fn to_question(&self) -> Question {
        match self {
            ReportQuestion::Text(q) => Question {
                question: q.clone(),
                options: vec![],
            },
            ReportQuestion::Full { question, options } => Question {
                question: question.clone(),
                options: options.clone(),
            },
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Report {
    pub status: ReportStatus,
    pub summary: String,
    pub questions: Vec<ReportQuestion>,
    #[serde(deserialize_with = "lenient_answer")]
    pub answer: Option<IssueAnswer>,
    pub checks: Vec<CriterionCheck>,
    pub remember: Vec<IssueReportMemory>,
    #[serde(rename = "deliveryReceipt", alias = "delivery_receipt", default, skip_serializing_if = "Option::is_none")]
    pub delivery_receipt: Option<DeliveryReceipt>,
}

/// An answer as the agent writes it: only `conclusion` is required, the
/// lists of `IssueAnswer` default to empty.
fn lenient_answer<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<IssueAnswer>, D::Error> {
    #[derive(Deserialize)]
    struct Said {
        conclusion: String,
        #[serde(default)]
        evidence: Vec<String>,
        #[serde(default)]
        unsure: Vec<String>,
        #[serde(default)]
        next: Vec<String>,
    }
    Ok(Option::<Said>::deserialize(d)?.map(|a| IssueAnswer {
        conclusion: a.conclusion,
        evidence: a.evidence,
        unsure: a.unsure,
        next: a.next,
    }))
}

impl Report {
    /// `None` when the file is missing or unreadable.
    pub async fn read_async(path: &Path) -> Option<Report> {
        let text = tokio::fs::read_to_string(path).await.ok()?;
        serde_json::from_str(&text).ok()
    }
}

/// Appended to the agent's system prompt when the drivers have no rules of
/// their own (standalone boards).
pub fn instructions(deliver: Deliverable) -> String {
    let work = match deliver {
        Deliverable::Change | Deliverable::Branch | Deliverable::PullRequest => {
            "你自主管理分支、本地 `git worktree add`（如需要隔离并发改动）、测试验证与提交/PR。完成交付后在 `issue_report` 的 `deliveryReceipt` 中附带结构化交付凭据（`pull_request` / `commit` / `note` / `answer`）。"
        }
        Deliverable::Answer => ANSWER_ONLY,
    };
    format!(
        "你正在处理 VibeValley 工单板上的任务。{work}\n\n\
         完成本轮后，调用 vibevalley MCP 服务的 issue_report 工具交回一两句结果摘要、交付凭据（deliveryReceipt）或待用户回答的问题，并在只读问答任务中填写 answer。"
    )
}

/// What an answer issue's helper is told beside its rules.
pub const ANSWER_ONLY: &str = "这项任务只要结论，不改代码：只读调研（读代码、跑只读命令），严禁修改或提交文件；任何改动交回来都会被丢弃。";
