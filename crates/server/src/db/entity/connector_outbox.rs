use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "connector_outbox")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub seq: i64,
    pub connector: String,
    pub message_id: String,
    #[sea_orm(column_type = "Text")]
    pub body: String,
    pub state: String,
    pub ext_id: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub error: Option<String>,
    pub created_at: i64,
    pub sent_at: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
