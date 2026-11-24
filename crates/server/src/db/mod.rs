use vibevalley_runtime::agent::durable::Sqlite;

use crate::modules::infra::column::optional;

#[allow(dead_code)] // Consumed by Wave 3 domain callers.
pub(crate) mod entities;
pub(crate) mod error;
pub(crate) mod generated;
pub(crate) mod migration;

#[allow(dead_code)] // Retained during Wave 2-3 transition; Wave 4 removes db/schema.
pub mod schema {
    pub const SHARED: &str = include_str!("schema/shared.sql");
    pub const COLLAB_CHANNEL: &str = include_str!("schema/collab_channel.sql");
    pub const COLLAB_CONNECTOR: &str = include_str!("schema/collab_connector.sql");
    pub const CONTENT_ARTIFACT: &str = include_str!("schema/content_artifact.sql");
    pub const CONTENT_ATTACHMENT: &str = include_str!("schema/content_attachment.sql");
    pub const CONTENT_LIBRARY: &str = include_str!("schema/content_library.sql");
    pub const CONTENT_MEDIA: &str = include_str!("schema/content_media.sql");
    pub const INFRA_REMOTE: &str = include_str!("schema/infra_remote.sql");
    pub const TEAM_MEMORY: &str = include_str!("schema/team_memory.sql");
    pub const WORK_CRON: &str = include_str!("schema/work_cron.sql");
    pub const WORK_ISSUE: &str = include_str!("schema/work_issue.sql");
    pub const WORK_PULL: &str = include_str!("schema/work_pull.sql");
    pub const WORK_SESSION: &str = include_str!("schema/work_session.sql");
}

pub(crate) fn next_seq(db: &Sqlite<'_>, name: &str, at_least: i64) -> sqlx::Result<i64> {
    use generated::shared as queries;
    db.query(async |c| {
        let last = optional(queries::read_seq_counter(&mut *c, queries::ReadSeqCounterParams { name: name.into() }).await)?.map_or(0, |r| r.last_number);
        let next = last.max(at_least) + 1;
        queries::write_seq_counter(
            c,
            queries::WriteSeqCounterParams {
                name: name.into(),
                last_number: next,
            },
        )
        .await?;
        Ok(next)
    })
}

#[allow(dead_code)] // Consumed by Wave 3 domain callers.
pub(crate) async fn next_seq_async(db: &impl sea_orm::ConnectionTrait, name: &str, at_least: i64) -> Result<i64, sea_orm::DbErr> {
    use sea_orm::sea_query::{Expr, OnConflict};
    use sea_orm::{ActiveValue::Set, EntityTrait, ExprTrait};

    let model = entities::shared::seq_counter::ActiveModel {
        name: Set(name.to_owned()),
        last_number: Set(at_least + 1),
    };
    let current = Expr::col((entities::shared::seq_counter::Entity, entities::shared::seq_counter::Column::LastNumber));
    let next_expr = Expr::expr(Expr::case(current.clone().gt(at_least), current).finally(at_least)).add(1);
    let on_conflict = OnConflict::column(entities::shared::seq_counter::Column::Name)
        .value(entities::shared::seq_counter::Column::LastNumber, next_expr)
        .to_owned();
    let saved = entities::shared::seq_counter::Entity::insert(model)
        .on_conflict(on_conflict)
        .exec_with_returning(db)
        .await?;
    Ok(saved.last_number)
}
