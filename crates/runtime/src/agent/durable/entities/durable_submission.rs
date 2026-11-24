use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "durable_submission")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub conversation_id: String,
    pub request_id: String,
    pub kind: String,
    pub status: String,
    #[sea_orm(column_type = "Text")]
    pub payload_json: String,
    pub notify_task_id: String,
    #[sea_orm(column_type = "Text")]
    pub result_json: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
