use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "durable_entry")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub conversation_id: String,
    #[sea_orm(primary_key, auto_increment = false)]
    pub seq: i64,
    pub kind: String,
    #[sea_orm(column_type = "Text")]
    pub payload_json: String,
    pub created_at_ms: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
