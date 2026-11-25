//! Dual-backend persistence for scheduled cron rows (`cron`).

use std::sync::Arc;

use sea_orm::sea_query::OnConflict;
use sea_orm::{ActiveValue::Set, ConnectionTrait, EntityTrait, QueryOrder};
use vibevalley_protocol::{ActorKind, Cron, CronWhen};

use crate::db::column::{db_json, db_word, read_db_json, read_db_word};
use crate::db::entity::cron;
use crate::db::{Database, DbResult};

#[derive(Debug, Clone)]
pub(crate) struct StoredCron {
    pub(crate) cron: Cron,
    pub(crate) issue_id: Option<String>,
}

fn read(r: cron::Model) -> DbResult<StoredCron> {
    let when: CronWhen = read_db_json(r.spec)?;
    let by: ActorKind = read_db_word(r.set_by)?;
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
            enabled: r.enabled,
            created: r.created_at,
            last_run: r.last_run,
            by,
            pending: r.pending,
        },
        issue_id: r.issue_id,
    })
}

async fn list_impl<C: ConnectionTrait>(db: &C) -> DbResult<Vec<StoredCron>> {
    cron::Entity::find()
        .order_by_asc(cron::Column::Id)
        .all(db)
        .await?
        .into_iter()
        .map(read)
        .collect()
}

async fn upsert_impl<C: ConnectionTrait>(db: &C, c: &Cron, issue_id: Option<&str>) -> DbResult<()> {
    let model = cron::ActiveModel {
        id: Set(c.id.clone()),
        name: Set(c.name.clone()),
        body: Set(c.text.clone()),
        channel_id: Set(c.channel.clone()),
        agent: Set(c.agent.clone()),
        repo: Set(c.repo.clone()),
        issue_id: Set(issue_id.map(str::to_owned)),
        spec: Set(db_json(&c.when)?),
        tz: Set(c.tz.clone()),
        enabled: Set(c.enabled),
        created_at: Set(c.created),
        last_run: Set(c.last_run),
        set_by: Set(db_word(&c.by)?),
        pending: Set(c.pending),
    };
    let on_conflict = OnConflict::column(cron::Column::Id)
        .update_columns([
            cron::Column::Name,
            cron::Column::Body,
            cron::Column::ChannelId,
            cron::Column::Agent,
            cron::Column::Repo,
            cron::Column::IssueId,
            cron::Column::Spec,
            cron::Column::Tz,
            cron::Column::Enabled,
            cron::Column::LastRun,
            cron::Column::SetBy,
            cron::Column::Pending,
        ])
        .to_owned();
    cron::Entity::insert(model).on_conflict(on_conflict).exec(db).await?;
    Ok(())
}

async fn set_issue_impl<C: ConnectionTrait>(db: &C, id: &str, issue_id: Option<&str>) -> DbResult<()> {
    super::update_col_by_id::<cron::Entity, _, _>(db, cron::Column::Id, id, cron::Column::IssueId, issue_id.map(str::to_owned)).await
}

#[derive(Clone)]
pub(crate) struct CronService {
    db: Arc<Database>,
}

impl CronService {
    pub(super) fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    pub(crate) async fn list(&self) -> DbResult<Vec<StoredCron>> {
        list_impl(self.db.read_conn()).await
    }

    pub(crate) async fn upsert(&self, cron: &Cron, issue_id: Option<&str>) -> DbResult<()> {
        upsert_impl(self.db.write_conn(), cron, issue_id).await
    }

    pub(crate) async fn set_issue(&self, id: &str, issue_id: Option<&str>) -> DbResult<()> {
        set_issue_impl(self.db.write_conn(), id, issue_id).await
    }

    pub(crate) async fn remove(&self, id: &str) -> DbResult<()> {
        super::delete_by_id::<cron::Entity, _>(self.db.write_conn(), id).await
    }
}
