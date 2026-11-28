use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "durable_conversation")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub owner_task_id: String,
    pub parent_id: String,
    pub fork_entry_seq: i64,
    pub head_seq: i64,
    pub next_seq: i64,
    pub provider_affinity: String,
    #[sea_orm(column_type = "Text")]
    pub metadata_json: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
