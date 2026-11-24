use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "durable_document")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub scope_kind: String,
    #[sea_orm(primary_key, auto_increment = false)]
    pub scope_id: String,
    #[sea_orm(primary_key, auto_increment = false)]
    pub doc_kind: String,
    pub rev: i64,
    #[sea_orm(column_type = "Text")]
    pub state_json: String,
    pub updated_at_ms: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
