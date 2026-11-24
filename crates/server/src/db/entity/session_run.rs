use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "session_run")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub session: String,
    pub issue: Option<String>,
    pub triggered_by: String,
    #[sea_orm(column_type = "Text")]
    pub heard: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub outcome: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub summary: String,
    #[sea_orm(column_type = "Text", nullable)]
    pub spent: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub subagent_summary: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
