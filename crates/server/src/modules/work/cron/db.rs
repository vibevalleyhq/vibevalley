//! Dual-backend SeaORM storage for `cron` rows in `server.db`.

use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{ActiveValue::Set, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, Update};
use vibevalley_protocol::{ActorKind, Cron, CronWhen};

use crate::db::entities::work_cron::cron;
use crate::modules::work::{json, read_json, read_word, word};

pub struct StoredCron {
    pub cron: Cron,
    pub issue_id: Option<String>,
}

fn read(r: cron::Model) -> Result<StoredCron, DbErr> {
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
            enabled: r.enabled,
            created: r.created_at,
            last_run: r.last_run,
            by,
            pending: r.pending,
        },
        issue_id: r.issue_id,
    })
}

pub async fn list<C: ConnectionTrait>(db: &C) -> Result<Vec<StoredCron>, DbErr> {
    cron::Entity::find()
        .order_by_asc(cron::Column::Id)
        .all(db)
        .await?
        .into_iter()
        .map(read)
        .collect()
}

pub async fn upsert<C: ConnectionTrait>(db: &C, c: &Cron, issue_id: Option<&str>) -> Result<(), DbErr> {
    let model = cron::ActiveModel {
        id: Set(c.id.clone()),
        name: Set(c.name.clone()),
        body: Set(c.text.clone()),
        channel_id: Set(c.channel.clone()),
        agent: Set(c.agent.clone()),
        repo: Set(c.repo.clone()),
        issue_id: Set(issue_id.map(str::to_owned)),
        spec: Set(json(&c.when)?),
        tz: Set(c.tz.clone()),
        enabled: Set(c.enabled),
        created_at: Set(c.created),
        last_run: Set(c.last_run),
        set_by: Set(word(&c.by)?),
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

pub async fn set_issue<C: ConnectionTrait>(db: &C, id: &str, issue_id: Option<&str>) -> Result<(), DbErr> {
    Update::many(cron::Entity)
        .col_expr(cron::Column::IssueId, Expr::value(issue_id.map(str::to_owned)))
        .filter(cron::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

pub async fn remove<C: ConnectionTrait>(db: &C, id: &str) -> Result<(), DbErr> {
    cron::Entity::delete_by_id(id.to_owned()).exec(db).await?;
    Ok(())
}
