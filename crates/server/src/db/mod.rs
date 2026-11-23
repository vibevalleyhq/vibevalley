use vibevalley_runtime::agent::durable::Sqlite;

use crate::modules::infra::column::optional;

pub(crate) mod generated;

pub mod schema {
    pub const SHARED: &str = include_str!("schema/shared.sql");
    pub const COLLAB_CHANNEL: &str = include_str!("schema/collab_channel.sql");
    pub const COLLAB_CONNECTOR: &str = include_str!("schema/collab_connector.sql");
    pub const CONTENT_ARTIFACT: &str = include_str!("schema/content_artifact.sql");
    pub const CONTENT_ATTACHMENT: &str = include_str!("schema/content_attachment.sql");
    pub const CONTENT_LIBRARY: &str = include_str!("schema/content_library.sql");
    pub const CONTENT_MEDIA: &str = include_str!("schema/content_media.sql");
    pub const CONTENT_PKM: &str = include_str!("schema/content_pkm.sql");
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
