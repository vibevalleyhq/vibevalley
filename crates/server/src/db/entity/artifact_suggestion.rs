use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "artifact_suggestion")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub artifact_id: String,
    pub path: String,
    pub author: String,
    pub origin: Option<String>,
    pub at_rev: i64,
    pub base_hash: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub change: String,
    pub cursor_start: Option<String>,
    pub cursor_end: Option<String>,
    pub start_offset: Option<i64>,
    pub end_offset: Option<i64>,
    pub status: String,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
    pub resolved_by: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
