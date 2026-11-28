use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "durable_task")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub conversation_id: String,
    pub owner_task_id: String,
    pub dedup_key: String,
    pub kind: String,
    pub is_model_task: bool,
    pub status: String,
    pub terminal_reason: String,
    pub restart_count: i32,
    pub restart_limit: i32,
    pub phase_name: String,
    #[sea_orm(column_type = "Text")]
    pub checkpoint_json: String,
    pub wake_until_ms: i64,
    pub wait_mode: String,
    #[sea_orm(column_type = "Text")]
    pub wait_task_ids_json: String,
    pub wait_signal_name: String,
    #[sea_orm(column_type = "Text")]
    pub memo_json: String,
    #[sea_orm(column_type = "Text")]
    pub result_json: String,
    #[sea_orm(column_type = "Text")]
    pub error_text: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
