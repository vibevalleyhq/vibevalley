//! Derived status and stage are rebuilt from issues and sessions, never persisted.
use crate::modules::infra::column::{json, optional, read_json, read_word, word};
use vibevalley_protocol::{Issue, Millis};
use vibevalley_runtime::agent::durable::Sqlite;

#[rustfmt::skip]
#[path = "generated/queries.rs"]
mod queries;

pub const SCHEMA: &str = include_str!("sql/schema.sql");

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
    issue.delivery_evidence = r.evidence.map(read_json).transpose()?;
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
    };
    db.query(async |c| queries::put_issue(c, params).await)?;
    if let Some(evidence) = &t.delivery_evidence {
        let params = queries::PutIssueEvidenceParams {
            issue_id: t.id.clone(),
            evidence: json(evidence)?,
        };
        db.query(async |c| queries::put_issue_evidence(c, params).await)?;
    }
    Ok(())
}

pub fn remove(db: &Sqlite<'_>, id: &str) -> sqlx::Result<()> {
    db.query(async |c| {
        queries::delete_issue_evidence(&mut *c, queries::DeleteIssueEvidenceParams { issue_id: id.into() }).await?;
        queries::delete_issue_words(&mut *c, queries::DeleteIssueWordsParams { issue: id.into() }).await?;
        queries::delete_issue(c, queries::DeleteIssueParams { id: id.into() }).await
    })
}

pub fn next_number(db: &Sqlite<'_>, at_least: i64) -> sqlx::Result<i64> {
    db.query(async |c| {
        let prev = optional(queries::read_issue_number(&mut *c).await)?.map_or(0, |r| r.last_number);
        let next = prev.max(at_least) + 1;
        queries::write_issue_number(c, queries::WriteIssueNumberParams { last_number: next }).await?;
        Ok(next)
    })
}

pub fn keep_words(db: &Sqlite<'_>, issue: &str, words: &str, at: Millis) -> sqlx::Result<()> {
    db.query(async |c| {
        queries::keep_issue_words(
            c,
            queries::KeepIssueWordsParams {
                issue: issue.into(),
                text: words.into(),
                created_at: at,
            },
        )
        .await
    })
}

pub fn take_words(db: &Sqlite<'_>, issue: &str) -> sqlx::Result<Vec<String>> {
    db.query(async |c| {
        let kept = queries::list_issue_words(&mut *c, queries::ListIssueWordsParams { issue: issue.into() }).await?;
        queries::delete_issue_words(c, queries::DeleteIssueWordsParams { issue: issue.into() }).await?;
        Ok(kept.into_iter().map(|r| r.text).collect())
    })
}
