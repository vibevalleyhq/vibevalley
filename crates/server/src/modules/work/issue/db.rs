//! Derived status and stage are rebuilt from issues and sessions, never persisted.
use crate::modules::infra::column::{json, optional, read_json, read_word, word};
use vibevalley_protocol::Issue;
use vibevalley_runtime::agent::durable::Sqlite;

use crate::db::generated::work_issue as queries;

pub const SCHEMA: &str = crate::db::schema::WORK_ISSUE;

fn read(r: queries::ListIssuesRow) -> sqlx::Result<Issue> {
    let mut issue = Issue::new(r.id, r.number, r.title, r.created_at);
    issue.description = r.description;
    issue.repo = r.repo;
    issue.parent = r.parent;
    issue.rank = r.rank;
    issue.queued_at = r.queued_at;
    issue.closed_at = r.closed_at;
    issue.reviewed_at = r.reviewed_at;
    issue.priority = read_word(r.priority)?;
    issue.deliver = read_word(r.deliver)?;
    issue.canceled = r.canceled.map(read_word).transpose()?;
    issue.delivered = r.delivered.map(read_word).transpose()?;
    issue.mandate = read_json(r.mandate)?;
    issue.blocked_by = read_json(r.blocked_by)?;
    issue.criteria = read_json(r.criteria)?;
    issue.checks = read_json(r.checks)?;
    issue.findings = read_json(r.findings)?;
    issue.questions = read_json(r.questions)?;
    issue.assignments = read_json(r.assignments)?;
    issue.constraints = r.constraints.map(read_json).transpose()?;
    issue.conflict = r.conflict.map(read_json).transpose()?;
    issue.last_run = r.last_run.map(read_json).transpose()?;
    issue.answer = r.answer.map(read_json).transpose()?;
    issue.delivery_evidence = r.delivery_evidence.map(read_json).transpose()?;
    Ok(issue)
}

pub fn all(db: &Sqlite<'_>) -> sqlx::Result<Vec<Issue>> {
    db.query(async |c| queries::list_issues(c).await)?.into_iter().map(read).collect()
}

pub fn put(db: &Sqlite<'_>, t: &Issue) -> sqlx::Result<()> {
    let params = queries::PutIssueParams {
        id: t.id.clone(),
        title: t.title.clone(),
        description: t.description.clone(),
        repo: t.repo.clone(),
        parent: t.parent.clone(),
        number: t.number,
        rank: t.rank,
        created_at: t.created_at,
        queued_at: t.queued_at,
        closed_at: t.closed_at,
        reviewed_at: t.reviewed_at,
        priority: word(&t.priority)?,
        deliver: word(&t.deliver)?,
        canceled: t.canceled.as_ref().map(word).transpose()?,
        delivered: t.delivered.as_ref().map(word).transpose()?,
        mandate: json(&t.mandate)?,
        blocked_by: json(&t.blocked_by)?,
        criteria: json(&t.criteria)?,
        checks: json(&t.checks)?,
        findings: json(&t.findings)?,
        questions: json(&t.questions)?,
        assignments: json(&t.assignments)?,
        constraints: t.constraints.as_ref().map(json).transpose()?,
        conflict: t.conflict.as_ref().map(json).transpose()?,
        last_run: t.last_run.as_ref().map(json).transpose()?,
        answer: t.answer.as_ref().map(json).transpose()?,
        delivery_evidence: t.delivery_evidence.as_ref().map(json).transpose()?,
    };
    db.query(async |c| queries::put_issue(c, params).await)
}

pub fn remove(db: &Sqlite<'_>, id: &str) -> sqlx::Result<()> {
    db.query(async |c| queries::delete_issue(c, queries::DeleteIssueParams { id: id.into() }).await)
}

pub fn keep_words(db: &Sqlite<'_>, issue: &str, words: &str) -> sqlx::Result<()> {
    db.query(async |c| {
        let Some(row) = optional(queries::get_issue_queued_words(&mut *c, queries::GetIssueQueuedWordsParams { id: issue.into() }).await)? else {
            return Ok(());
        };
        let mut kept: Vec<String> = read_json(row.queued_words)?;
        kept.push(words.to_string());
        queries::set_issue_queued_words(
            c,
            queries::SetIssueQueuedWordsParams {
                id: issue.into(),
                queued_words: json(&kept)?,
            },
        )
        .await
    })
}

pub fn take_words(db: &Sqlite<'_>, issue: &str) -> sqlx::Result<Vec<String>> {
    db.query(async |c| {
        let Some(row) = optional(queries::get_issue_queued_words(&mut *c, queries::GetIssueQueuedWordsParams { id: issue.into() }).await)? else {
            return Ok(Vec::new());
        };
        let kept: Vec<String> = read_json(row.queued_words)?;
        if !kept.is_empty() {
            queries::set_issue_queued_words(
                c,
                queries::SetIssueQueuedWordsParams {
                    id: issue.into(),
                    queued_words: "[]".into(),
                },
            )
            .await?;
        }
        Ok(kept)
    })
}
