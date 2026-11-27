use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "note_version")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub note_id: String,
    #[sea_orm(primary_key, auto_increment = false)]
    pub version: i64,
    pub storage_id: String,
    pub size: i64,
    #[sea_orm(column_type = "Text", nullable)]
    pub note: Option<String>,
    pub by_id: String,
    pub by_name: String,
    pub message_id: Option<String>,
    pub created_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
