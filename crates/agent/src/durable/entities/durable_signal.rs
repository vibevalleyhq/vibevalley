use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "durable_signal")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub insert_seq: i64,
    pub task_id: String,
    pub signal_name: String,
    pub signal_key: String,
    #[sea_orm(column_type = "Text")]
    pub payload_json: String,
    pub consumed: bool,
    pub consumed_at_ms: i64,
    pub created_at_ms: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
