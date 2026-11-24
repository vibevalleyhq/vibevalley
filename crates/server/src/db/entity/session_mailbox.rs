use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "session_mailbox")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i64,
    pub session_id: String,
    #[sea_orm(unique)]
    pub idempotency_key: String,
    pub source: String,
    pub source_message_id: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub payload: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[sea_orm(column_type = "Text", nullable)]
    pub result: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
