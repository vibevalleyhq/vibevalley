use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "channel_read_cursor")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub participant_id: String,
    #[sea_orm(primary_key, auto_increment = false)]
    pub channel_id: String,
    pub read_number: i64,
    pub updated_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
