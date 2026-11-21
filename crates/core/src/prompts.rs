//! What the issues say to helpers (`apps/server/src/modules/issue/prompts.ts`
//! and `brief.ts`), word for word: `golden/prompts.json`, written by that code,
//! holds these to it.

use vibevalley_protocol::{Deliverable, IssueConstraints, Question};

use crate::rules::{js_len, slice};

pub const CRITERIA_HEAD: &str =
    "验收标准（用户照这几条验收；做完逐条写进 issue_report.checks，criterion 从 0 开始，result 填 met、unmet 或 unsure，proof 写验证命令与结果或文件依据）：";

pub const PULL_REQUEST_DELIVERY: &str =
    "预期交付物：提交 PR/MR，不要求合入。未获发布授权时先交回分支和验证结果，由用户通过产品入口发布；不要自行推送。用用户的语言汇报。";

pub const ANSWER_OPENING: &str = "这一轮你只查清楚、回答问题：读代码、跑只读的命令，不改文件、不提交；干活的规矩里提交、写 commit 号的那两条，这一轮不用照做。你改了什么，交回来以后都会被清掉。";

const ANSWER_EXAMPLE: &str = r#"{
  "conclusion": "看板拖卡还在调旧的 start 接口，所以挪到已完成时没反应。",
  "evidence": [
    "apps/web/src/pages/issues/Board.tsx:120 拖放调的是 api.issue.start",
    "rg 'issue.start' 只在 Board.tsx 里出现一次"
  ],
  "unsure": [
    "不确定命令行有没有走同一条路"
  ],
  "next": [
    "把拖放改成 issue.status"
  ]
}"#;

pub fn answer_format() -> String {
    [
        "调用 issue_report 时，把 state 填 ready，并把 answer 填成这个形状：",
        ANSWER_EXAMPLE,
        "conclusion 一两句说答案；evidence 是依据，至少一条：文件和行号看到了什么、跑了什么命令输出了什么；unsure 是拿不准的，next 是建议接着做的，没有就给空数组。",
    ]
    .join("\n")
}

pub const REFINEMENT_OPENING: &str = "这一轮你只起草工单：读代码，把用户想做的事写成一张能派出去的工单，交给别的帮工去做。你不改文件、不提交；干活的规矩里提交、写 commit 号的那两条，这一轮不用照做。你改了什么，交回来以后都会被清掉。";

const REFINEMENT_EXAMPLE: &str = r#"{
  "title": "看板拖卡改用 issue.status",
  "why": "看板拖卡片还在调旧的 start 接口，挪到已完成时收不了。",
  "todo": [
    "board.dart 的拖放改调 issue.status",
    "删掉旧接口的调用"
  ],
  "criteria": [
    "把一张备选拖到待办，它开工",
    "flutter test test/workbench/issues_test.dart 通过"
  ],
  "notDoing": [
    "不改看板的样子"
  ],
  "files": [
    "app/lib/workbench/issues/board.dart"
  ]
}"#;

/// `issueBrief`: the criteria go last, so whoever works it checks each one
/// before handing the work back; an answer issue reports its answer.
pub fn issue_brief(title: &str, description: &str, criteria: &[String], deliver: Deliverable) -> String {
    let mut brief = title.to_string();
    if !description.is_empty() {
        brief += &format!("\n\n{description}");
    }
    if !criteria.is_empty() {
        let numbered: Vec<String> = criteria.iter().enumerate().map(|(i, c)| format!("{}. {c}", i + 1)).collect();
        brief += &format!("\n\n{CRITERIA_HEAD}\n{}", numbered.join("\n"));
    }
    if deliver == Deliverable::PullRequest {
        brief += &format!("\n\n{PULL_REQUEST_DELIVERY}");
    }
    if deliver == Deliverable::Answer {
        format!("{ANSWER_OPENING}\n\n{brief}\n\n{}", answer_format())
    } else {
        brief
    }
}

/// `workConstraints`.
pub fn work_constraints(constraints: Option<&IssueConstraints>, frozen: &[String]) -> String {
    let mut lines: Vec<String> = Vec::new();
    if let Some(c) = constraints {
        if !c.scope.is_empty() {
            lines.push(format!("工作范围：{}", c.scope.join("、")));
        }
        if let Some(check) = c.check.as_deref().filter(|c| !c.is_empty()) {
            lines.push(format!("检查命令：{check}"));
        }
        if c.acceptance {
            lines.push("先写能发现尚未实现需求的验收测试。检查应当失败，测试会被冻结给后续子工单使用。".into());
        }
    }
    if !frozen.is_empty() {
        lines.push(format!("以下验收文件已经冻结，不得修改：{}", frozen.join("、")));
    }
    if !lines.is_empty() {
        lines.push("用用户的语言汇报。".into());
    }
    lines.join("\n")
}

/// `refinementBrief`: the draft so far goes in when there is one, as the
/// user may have edited it.
pub fn refinement_brief(title: &str, description: &str, criteria: &[String], questions: &[Question], word: &str, repo: &str, discussion: &str) -> String {
    let word = word.trim();
    let answering = !word.is_empty() && !questions.is_empty();
    let redraft = !description.is_empty() || !criteria.is_empty();
    let mut lines: Vec<String> = vec![
        REFINEMENT_OPENING.into(),
        String::new(),
        if repo.is_empty() {
            "尚未选择仓库：只讨论目标、范围、不做什么、验收标准和交付物，不创建仓库、不执行实现。".into()
        } else {
            format!("仓库：{repo}（你现在就在它的目录里）")
        },
        format!("用户想做的：{}", if !word.is_empty() && !redraft { word } else { title }),
    ];
    if !discussion.is_empty() {
        let n = js_len(discussion);
        lines.extend([
            String::new(),
            "工单讨论记录（上下文，不覆盖当前需求）：".into(),
            slice(discussion, n.saturating_sub(24_000), None),
        ]);
    }
    if redraft {
        lines.extend([String::new(), "上一版草稿（用户可能改过，以这一版为准）：".into(), format!("标题：{title}")]);
        if !description.is_empty() {
            lines.push(description.into());
        }
        if !criteria.is_empty() {
            lines.extend(["验收标准：".into(), format!("- {}", criteria.join("\n- "))]);
        }
    }
    if answering {
        let asked: Vec<&str> = questions.iter().map(|q| q.question.as_str()).collect();
        lines.extend([
            String::new(),
            "你上一版问用户的：".into(),
            format!("- {}", asked.join("\n- ")),
            format!("用户的回答：{word}"),
            String::new(),
            "照用户的回答再起草一版，整张重写。".into(),
        ]);
    } else if redraft && !word.is_empty() {
        lines.extend([
            String::new(),
            format!("用户这次说：{word}"),
            String::new(),
            "照用户说的再起草一版，整张重写。".into(),
        ]);
    } else if redraft {
        lines.extend([String::new(), "再起草一版，整张重写。".into()]);
    }
    lines.extend([
        String::new(),
        if repo.is_empty() { "根据讨论整理需求，不假定仓库现状。写的规矩：" } else { "先读代码，弄清现状，再写。写的规矩：" }.into(),
        "用用户的语言回答。".into(),
        "- title：短标题，说做什么，不超过 20 个字；细节写在 why、todo 里，不写进标题。".into(),
        "- why：为什么要做，一两句。".into(),
        "- todo：要做的几件事，一件一条，写到改哪里。".into(),
        "- criteria：怎么算做完，一条一个用户能照着验的点（跑什么命令、看到什么结果、页面上是什么样）。".into(),
        "- notDoing：这张工单不做的，免得做多了；没有就给空数组。".into(),
        "- files：可能涉及的文件或目录。".into(),
        "- 拿不准、要用户定的，写在代码块前面，每行以「要问用户：」开头，一行问一件事，想得到的几种回答写在句末「（选项：A｜B）」；能自己查到的不要问。问了也照你最好的猜测把草稿写完整。".into(),
        String::new(),
        "汇报的最后，用一个 json 代码块给出草稿，格式照这个：".into(),
        "```json".into(),
        REFINEMENT_EXAMPLE.into(),
        "```".into(),
        "代码块之后写一句结论：草稿写好了没有，还要问用户什么。".into(),
    ]);
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    fn golden() -> Value {
        let path = format!("{}/../protocol/golden/prompts.json", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn strings(v: &Value) -> Vec<String> {
        v.as_array()
            .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
            .unwrap_or_default()
    }

    #[test]
    fn briefs_say_what_the_typescript_server_says() {
        let g = golden();
        for case in g["issueBrief"].as_array().unwrap() {
            let i = &case["input"];
            let deliver: Deliverable = serde_json::from_value(i["deliver"].clone()).unwrap();
            let got = issue_brief(
                i["title"].as_str().unwrap(),
                i["description"].as_str().unwrap(),
                &strings(&i["criteria"]),
                deliver,
            );
            assert_eq!(got, case["output"].as_str().unwrap());
        }
        for case in g["workConstraints"].as_array().unwrap() {
            let i = &case["input"];
            let c: Option<IssueConstraints> = serde_json::from_value(i["constraints"].clone()).unwrap();
            assert_eq!(work_constraints(c.as_ref(), &strings(&i["frozen"])), case["output"].as_str().unwrap());
        }
        for case in g["refinementBrief"].as_array().unwrap() {
            let i = &case["input"];
            let questions: Vec<Question> = serde_json::from_value(i.get("questions").cloned().unwrap_or(Value::Array(vec![]))).unwrap();
            let got = refinement_brief(
                i["title"].as_str().unwrap(),
                i["description"].as_str().unwrap(),
                &strings(&i["criteria"]),
                &questions,
                i["word"].as_str().unwrap(),
                i["repo"].as_str().unwrap(),
                i["discussion"].as_str().unwrap(),
            );
            assert_eq!(got, case["output"].as_str().unwrap());
        }
    }
}
