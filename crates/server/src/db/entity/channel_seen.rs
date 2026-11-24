use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "channel_seen")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub participant_id: String,
    #[sea_orm(primary_key, auto_increment = false)]
    pub message_id: String,
    pub seen_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
