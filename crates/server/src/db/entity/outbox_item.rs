use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "outbox_item")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i64,
    pub topic: String,
    #[sea_orm(column_type = "Text")]
    pub payload_json: String,
    pub status: String,
    pub attempts: i64,
    pub available_at: i64,
    pub created_at: i64,
    #[sea_orm(column_type = "Text", nullable)]
    pub last_error: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
