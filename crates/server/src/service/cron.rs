//! Dual-backend persistence for scheduled cron rows (`cron`).

use std::sync::Arc;

use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{ActiveValue::Set, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Update};
use vibevalley_protocol::{ActorKind, Cron, CronWhen};

use super::with_write_tx;
use crate::db::column::{db_json, db_word, read_db_json, read_db_word};
use crate::db::entity::cron;
use crate::db::{Database, DbResult};

fn read(r: cron::Model) -> DbResult<Cron> {
    let when: CronWhen = read_db_json(r.spec)?;
    let by: ActorKind = read_db_word(r.set_by)?;
    Ok(Cron {
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
    })
}

async fn list_impl<C: ConnectionTrait>(db: &C) -> DbResult<Vec<Cron>> {
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
    if let Some(iid) = issue_id {
        Update::many(cron::Entity)
            .col_expr(cron::Column::IssueId, Expr::value(Option::<String>::None))
            .filter(cron::Column::IssueId.eq(iid))
            .filter(cron::Column::Id.ne(id))
            .exec(db)
            .await?;
    }
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

    pub(crate) async fn list(&self) -> DbResult<Vec<Cron>> {
        list_impl(self.db.read_conn()).await
    }

    pub(crate) async fn issue_of_cron(&self, cron_id: &str) -> DbResult<Option<String>> {
        let row = cron::Entity::find_by_id(cron_id.to_owned())
            .select_only()
            .column(cron::Column::IssueId)
            .into_tuple::<Option<String>>()
            .one(self.db.read_conn())
            .await?;
        Ok(row.flatten())
    }

    pub(crate) async fn cron_of_issue(&self, issue_id: &str) -> DbResult<Option<String>> {
        Ok(cron::Entity::find()
            .select_only()
            .column(cron::Column::Id)
            .filter(cron::Column::IssueId.eq(issue_id))
            .into_tuple::<String>()
            .one(self.db.read_conn())
            .await?)
    }

    pub(crate) async fn cron_by_issue_map(&self) -> DbResult<std::collections::HashMap<String, String>> {
        let rows: Vec<(String, Option<String>)> = cron::Entity::find()
            .select_only()
            .columns([cron::Column::Id, cron::Column::IssueId])
            .filter(cron::Column::IssueId.is_not_null())
            .into_tuple()
            .all(self.db.read_conn())
            .await?;
        Ok(rows.into_iter().filter_map(|(cron_id, issue_id)| issue_id.map(|iid| (iid, cron_id))).collect())
    }

    pub(crate) async fn upsert(&self, cron: &Cron, issue_id: Option<&str>) -> DbResult<()> {
        upsert_impl(self.db.write_conn(), cron, issue_id).await
    }

    pub(crate) async fn set_issue(&self, id: &str, issue_id: Option<&str>) -> DbResult<()> {
        with_write_tx(&self.db, async |tx| set_issue_impl(tx, id, issue_id).await).await
    }

    pub(crate) async fn remove(&self, id: &str) -> DbResult<()> {
        super::delete_by_id::<cron::Entity, _>(self.db.write_conn(), id).await
    }
}
