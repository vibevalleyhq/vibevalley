use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "channel_delivery")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i64,
    pub message_id: String,
    pub channel_id: String,
    pub recipient_kind: String,
    pub recipient_id: String,
    pub reason: String,
    pub wakes: bool,
    pub held_by: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub settled_at: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
