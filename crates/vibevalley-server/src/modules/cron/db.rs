//! SQLite storage for `cron` rows in `server.db`.

use pollster::block_on;
use sqlx::SqliteConnection;
use vibevalley_protocol::{ActorKind, Cron, CronWhen};

use crate::modules::column::{json, read_json, read_word, word};

#[rustfmt::skip]
#[path = "generated/queries.rs"]
mod queries;

pub const SCHEMA: &str = include_str!("sql/schema.sql");

pub struct StoredCron {
    pub cron: Cron,
    pub issue_id: Option<String>,
}

fn read(r: queries::ListCronsRow) -> sqlx::Result<StoredCron> {
    let when: CronWhen = read_json(r.spec)?;
    let by: ActorKind = read_word(r.set_by)?;
    Ok(StoredCron {
        cron: Cron {
            id: r.id,
            name: r.name,
            text: r.body,
            channel: r.channel_id,
            agent: r.agent,
            repo: r.repo,
            when,
            tz: r.tz,
            enabled: r.enabled != 0,
            created: r.created_at,
            last_run: r.last_run,
            by,
            pending: r.pending != 0,
        },
        issue_id: r.issue_id,
    })
}

pub fn list(db: &mut SqliteConnection) -> sqlx::Result<Vec<StoredCron>> {
    block_on(queries::list_crons(db))?.into_iter().map(read).collect()
}

pub fn upsert(db: &mut SqliteConnection, cron: &Cron, issue_id: Option<&str>) -> sqlx::Result<()> {
    let params = queries::UpsertCronParams {
        id: cron.id.clone(),
        name: cron.name.clone(),
        body: cron.text.clone(),
        channel_id: cron.channel.clone(),
        agent: cron.agent.clone(),
        repo: cron.repo.clone(),
        issue_id: issue_id.map(str::to_owned),
        spec: json(&cron.when)?,
        tz: cron.tz.clone(),
        enabled: i64::from(cron.enabled),
        created_at: cron.created,
        last_run: cron.last_run,
        set_by: word(&cron.by)?,
        pending: i64::from(cron.pending),
    };
    block_on(queries::upsert_cron(db, params))
}

pub fn set_issue(db: &mut SqliteConnection, id: &str, issue_id: Option<&str>) -> sqlx::Result<()> {
    block_on(queries::set_cron_issue(
        db,
        queries::SetCronIssueParams {
            id: id.into(),
            issue_id: issue_id.map(str::to_owned),
        },
    ))
}

pub fn remove(db: &mut SqliteConnection, id: &str) -> sqlx::Result<()> {
    block_on(queries::remove_cron(db, queries::RemoveCronParams { id: id.into() }))
}
